// ---------------------------------------------------------------------------
// Phase 4 — SQLite persistence, hydrate-on-boot / write-through design.
//
// The in-memory Maps in server.js remain the runtime read path (zero change
// to read code); every mutation ALSO writes through to SQLite here. This is
// the lowest-risk way to add durability to an app that was built entirely
// around synchronous in-memory reads.
//
// Graceful absence: if better-sqlite3 fails to load (e.g. no prebuilt binary
// for this platform/Node version), every function below becomes a no-op
// returning an empty/falsy default. The app must never fail to start, or
// behave differently in its core (non-persisted) features, because of the
// database — persistence is a bonus, not a dependency.
// ---------------------------------------------------------------------------

const path = require('path');

let Database = null;
try {
  Database = require('better-sqlite3');
} catch (err) {
  console.warn(`[db] better-sqlite3 not available (${err.message}) — running memory-only. Data will not survive a restart.`);
}

const DB_PATH = path.join(__dirname, 'data.sqlite');

let db = null;

function isEnabled() {
  return db !== null;
}

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS contracts (
    id TEXT PRIMARY KEY,
    name TEXT,
    fileName TEXT,
    originalName TEXT,
    filePath TEXT,
    fileSize INTEGER,
    uploadDate TEXT,
    status TEXT,
    role TEXT,
    text TEXT,
    textHash TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS analyses (
    contractId TEXT PRIMARY KEY REFERENCES contracts(id) ON DELETE CASCADE,
    json TEXT,
    generatedAt TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS chunks (
    contractId TEXT,
    chunkId INTEGER,
    start INTEGER,
    text TEXT,
    embedding BLOB,
    PRIMARY KEY (contractId, chunkId)
  )`,
  `CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contractId TEXT,
    role TEXT,
    content TEXT,
    extras TEXT,
    timestamp TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS versions (
    contractId TEXT,
    version INTEGER,
    json TEXT,
    PRIMARY KEY (contractId, version)
  )`
];

const SCHEMA_VERSION = 1;

// Idempotent: safe to call on every boot. CREATE TABLE IF NOT EXISTS means
// re-running this against an existing DB is a no-op for the schema itself;
// schema_version exists for future migrations, not enforced yet at v1.
function init() {
  if (!Database) return false;
  try {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    for (const statement of SCHEMA_STATEMENTS) {
      db.exec(statement);
    }
    const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get();
    if (!row) {
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
    }
    console.log(`[db] SQLite persistence enabled at ${DB_PATH}`);
    return true;
  } catch (err) {
    console.warn(`[db] Failed to initialize SQLite (${err.message}) — running memory-only.`);
    db = null;
    return false;
  }
}

// Wraps a write in try/catch so a DB failure logs and continues — the
// in-memory Maps stay authoritative for the running session regardless.
function safeWrite(label, fn) {
  if (!db) return;
  try {
    fn();
  } catch (err) {
    console.warn(`[db] Write failed (${label}): ${err.message}`);
  }
}

function saveContract(contract) {
  safeWrite('saveContract', () => {
    db.prepare(`
      INSERT INTO contracts (id, name, fileName, originalName, filePath, fileSize, uploadDate, status, role, text, textHash)
      VALUES (@id, @name, @fileName, @originalName, @filePath, @fileSize, @uploadDate, @status, @role, @text, @textHash)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        fileName = excluded.fileName,
        originalName = excluded.originalName,
        filePath = excluded.filePath,
        fileSize = excluded.fileSize,
        uploadDate = excluded.uploadDate,
        status = excluded.status,
        role = excluded.role,
        text = excluded.text,
        textHash = excluded.textHash
    `).run({
      id: contract.id,
      name: contract.name || null,
      fileName: contract.fileName || null,
      originalName: contract.originalName || null,
      filePath: contract.filePath || null,
      fileSize: contract.fileSize || null,
      uploadDate: contract.uploadDate || null,
      status: contract.status || null,
      role: contract.role || null,
      text: contract.text || null,
      textHash: contract.index?.textHash || null
    });
  });
}

function saveAnalysis(contractId, analysis) {
  safeWrite('saveAnalysis', () => {
    db.prepare(`
      INSERT INTO analyses (contractId, json, generatedAt)
      VALUES (?, ?, ?)
      ON CONFLICT(contractId) DO UPDATE SET json = excluded.json, generatedAt = excluded.generatedAt
    `).run(contractId, JSON.stringify(analysis), analysis?.generatedAt || new Date().toISOString());
  });
}

// Embeddings round-trip as raw bytes: Float32Array -> Buffer on the way in,
// Buffer -> Float32Array (zero-copy view) on the way out. BM25 is cheap
// enough to just rebuild from chunk text at hydrate time instead of
// serializing its Maps.
function saveChunks(contractId, chunks, embeddings) {
  safeWrite('saveChunks', () => {
    const deleteExisting = db.prepare('DELETE FROM chunks WHERE contractId = ?');
    const insert = db.prepare(`
      INSERT INTO chunks (contractId, chunkId, start, text, embedding)
      VALUES (?, ?, ?, ?, ?)
    `);
    const tx = db.transaction(() => {
      deleteExisting.run(contractId);
      chunks.forEach((chunk, i) => {
        const vec = embeddings ? embeddings[i] : null;
        const embeddingBlob = vec ? Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength) : null;
        insert.run(contractId, chunk.id, chunk.start, chunk.text, embeddingBlob);
      });
    });
    tx();
  });
}

function addChatMessage(contractId, role, content, extras) {
  safeWrite('addChatMessage', () => {
    db.prepare(`
      INSERT INTO chat_messages (contractId, role, content, extras, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `).run(contractId, role, content, extras ? JSON.stringify(extras) : null, new Date().toISOString());
  });
}

function saveVersion(contractId, version, versionData) {
  safeWrite('saveVersion', () => {
    db.prepare(`
      INSERT INTO versions (contractId, version, json)
      VALUES (?, ?, ?)
      ON CONFLICT(contractId, version) DO UPDATE SET json = excluded.json
    `).run(contractId, version, JSON.stringify(versionData));
  });
}

function deleteContract(contractId) {
  safeWrite('deleteContract', () => {
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM contracts WHERE id = ?').run(contractId);
      db.prepare('DELETE FROM analyses WHERE contractId = ?').run(contractId);
      db.prepare('DELETE FROM chunks WHERE contractId = ?').run(contractId);
      db.prepare('DELETE FROM chat_messages WHERE contractId = ?').run(contractId);
      db.prepare('DELETE FROM versions WHERE contractId = ?').run(contractId);
    });
    tx();
  });
}

function getChatMessages(contractId, limit = 50) {
  if (!db) return [];
  try {
    const rows = db.prepare(`
      SELECT role, content, extras, timestamp FROM chat_messages
      WHERE contractId = ?
      ORDER BY id DESC
      LIMIT ?
    `).all(contractId, limit);
    return rows.reverse().map((row) => ({
      role: row.role,
      content: row.content,
      timestamp: row.timestamp,
      ...(row.extras ? JSON.parse(row.extras) : {})
    }));
  } catch (err) {
    console.warn(`[db] getChatMessages failed: ${err.message}`);
    return [];
  }
}

function getVersions(contractId) {
  if (!db) return [];
  try {
    const rows = db.prepare('SELECT json FROM versions WHERE contractId = ? ORDER BY version ASC').all(contractId);
    return rows.map((row) => JSON.parse(row.json));
  } catch (err) {
    console.warn(`[db] getVersions failed: ${err.message}`);
    return [];
  }
}

function getContractChunks(contractId) {
  if (!db) return [];
  try {
    const rows = db.prepare('SELECT chunkId, start, text, embedding FROM chunks WHERE contractId = ? ORDER BY chunkId ASC').all(contractId);
    return rows.map((row) => ({
      id: row.chunkId,
      start: row.start,
      text: row.text,
      embedding: row.embedding ? new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4) : null
    }));
  } catch (err) {
    console.warn(`[db] getContractChunks failed: ${err.message}`);
    return [];
  }
}

// Loads every persisted contract + analysis at boot. Chunks/embeddings are
// intentionally NOT included here — server.js rebuilds each contract's
// index lazily via getContractChunks + retrieval's BM25 rebuild, keeping
// this call cheap even with many contracts.
function hydrateAll() {
  if (!db) return { contracts: [], analyses: new Map() };
  try {
    const contracts = db.prepare('SELECT * FROM contracts').all();
    const analysisRows = db.prepare('SELECT contractId, json FROM analyses').all();
    const analyses = new Map(analysisRows.map((row) => [row.contractId, JSON.parse(row.json)]));
    return { contracts, analyses };
  } catch (err) {
    console.warn(`[db] hydrateAll failed: ${err.message}`);
    return { contracts: [], analyses: new Map() };
  }
}

module.exports = {
  init,
  isEnabled,
  saveContract,
  saveAnalysis,
  saveChunks,
  addChatMessage,
  saveVersion,
  deleteContract,
  getChatMessages,
  getVersions,
  getContractChunks,
  hydrateAll
};
