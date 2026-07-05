// ---------------------------------------------------------------------------
// Phase 1 — Real RAG: local embeddings (Transformers.js) + BM25, fused with
// Reciprocal Rank Fusion. Index is built once per contract text (at upload /
// version / role-change time) and queried per role-analysis and chat question.
//
// Design constraints honored here:
//  - Fully local & $0: Xenova/all-MiniLM-L6-v2 (384 dims), cached on disk in
//    backend/.models so it survives node_modules wipes. First run downloads
//    ~25MB; afterwards it works offline.
//  - Never breaks the app: every exported function degrades instead of
//    throwing — embedder failure ⇒ BM25-only; index failure ⇒ callers keep
//    the Phase 0 keyword-scoring path.
//  - No circular require: the clause-aware chunker lives in server.js and is
//    passed INTO buildContractIndex as an argument.
// ---------------------------------------------------------------------------

const path = require('path');
const crypto = require('crypto');
const { pipeline, env } = require('@xenova/transformers');

// Cache model weights next to the code, not inside node_modules.
env.cacheDir = path.join(__dirname, '.models');
env.allowRemoteModels = true; // first run downloads, then fully offline

const EMBED_MODEL = 'Xenova/all-MiniLM-L6-v2';

// ---------------------------------------------------------------------------
// Embedding provider — lazy singleton stored as a PROMISE so concurrent
// callers await the same in-flight load (no double-init race).
// ---------------------------------------------------------------------------

let embedderPromise = null;
let embedderReady = false;
let embedderFailed = false;

function getEmbedder() {
  if (!embedderPromise) {
    embedderPromise = pipeline('feature-extraction', EMBED_MODEL).then((p) => {
      embedderReady = true;
      return p;
    }).catch((err) => {
      embedderFailed = true;
      throw err;
    });
  }
  return embedderPromise;
}

function isEmbedderReady() {
  return embedderReady && !embedderFailed;
}

// Fire-and-forget warm-up at server startup so the first upload doesn't pay
// the model-load latency. Failure is logged, never fatal.
function warmupEmbedder() {
  getEmbedder().then(() => {
    console.log(`[retrieval] Embedding model ready (${EMBED_MODEL}, dims=384, cache=${env.cacheDir})`);
  }).catch((err) => {
    console.warn(`[retrieval] Embedding model failed to load — retrieval degrades to BM25/keyword fallback. Reason: ${err.message}`);
  });
}

// Embeds texts with mean pooling + L2 normalization, so cosine similarity
// reduces to a plain dot product. Returns array of Float32Array(384), or
// null if the embedder is unavailable (callers treat null as "no semantics").
async function embedTexts(texts) {
  if (embedderFailed) return null;
  if (!Array.isArray(texts) || texts.length === 0) return [];
  try {
    const embed = await getEmbedder();
    const vectors = [];
    for (const text of texts) {
      const output = await embed(text, { pooling: 'mean', normalize: true });
      vectors.push(Float32Array.from(output.data));
    }
    return vectors;
  } catch (err) {
    console.warn('[retrieval] embedTexts failed:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// BM25 (self-contained)
// ---------------------------------------------------------------------------

// Consistent with Phase 0's 2-char keyword floor; keeps `net-30`, `12.3`,
// section numbers. Trailing sentence punctuation is stripped so "notice."
// matches a query for "notice".
function tokenize(text) {
  const raw = String(text || '').toLowerCase().match(/[a-z0-9][a-z0-9.-]{1,}/g) || [];
  const tokens = [];
  for (const t of raw) {
    const cleaned = t.replace(/[.-]+$/, '');
    if (cleaned.length >= 2) tokens.push(cleaned);
  }
  return tokens;
}

function buildBM25Index(chunks) {
  const N = chunks.length;
  const tf = [];        // per-chunk Map(token -> count)
  const df = new Map(); // token -> number of chunks containing it
  const docLens = [];

  for (const chunk of chunks) {
    const tokens = tokenize(chunk.text);
    docLens.push(tokens.length);
    const counts = new Map();
    for (const token of tokens) {
      counts.set(token, (counts.get(token) || 0) + 1);
    }
    for (const token of counts.keys()) {
      df.set(token, (df.get(token) || 0) + 1);
    }
    tf.push(counts);
  }

  const avgDocLen = N > 0 ? docLens.reduce((a, b) => a + b, 0) / N : 0;
  return { df, tf, docLens, avgDocLen, N };
}

// Standard BM25; IDF uses the ln(1 + ...) form so common terms can never
// produce negative scores.
function scoreBM25(index, queryTokens, k1 = 1.5, b = 0.75) {
  const scores = new Array(index.N).fill(0);
  if (index.N === 0 || index.avgDocLen === 0) return scores;

  const uniqueTokens = Array.from(new Set(queryTokens));
  for (const token of uniqueTokens) {
    const df = index.df.get(token);
    if (!df) continue;
    const idf = Math.log(1 + (index.N - df + 0.5) / (df + 0.5));
    for (let i = 0; i < index.N; i++) {
      const termFreq = index.tf[i].get(token);
      if (!termFreq) continue;
      const norm = k1 * (1 - b + b * (index.docLens[i] / index.avgDocLen));
      scores[i] += idf * (termFreq * (k1 + 1)) / (termFreq + norm);
    }
  }
  return scores;
}

// ---------------------------------------------------------------------------
// Contract index — built once per extracted text
// ---------------------------------------------------------------------------

function sha256(text) {
  return crypto.createHash('sha256').update(text || '', 'utf8').digest('hex');
}

// `chunkFn` is server.js's clause-aware chunkText, passed in to avoid a
// circular require. targetSize 1000 (not the Phase 0 default 1500) because
// MiniLM's ~256-token input cap ≈ 1000 chars — larger chunks would be
// silently truncated at embedding time.
async function buildContractIndex(text, chunkFn) {
  try {
    const chunks = chunkFn(text, { targetSize: 1000, overlap: 150 });
    if (!Array.isArray(chunks) || chunks.length === 0) return null;

    const bm25 = buildBM25Index(chunks);
    const embeddings = await embedTexts(chunks.map((c) => c.text)); // null on failure
    return { chunks, embeddings, bm25, textHash: sha256(text) };
  } catch (err) {
    console.warn('[retrieval] buildContractIndex failed:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Hybrid retrieval: BM25 leg + semantic leg fused with Reciprocal Rank Fusion
// ---------------------------------------------------------------------------

function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

// Builds a ranked list [{ chunkIdx, score }] from raw scores, keeping only
// positive scores; ties broken deterministically by chunk index.
function rankPositive(scores) {
  const ranked = [];
  for (let i = 0; i < scores.length; i++) {
    if (scores[i] > 0) ranked.push({ chunkIdx: i, score: scores[i] });
  }
  ranked.sort((a, b) => b.score - a.score || a.chunkIdx - b.chunkIdx);
  return ranked;
}

const RRF_K = 60;

// Returns top-k chunks as [{ id, text, start, score, ranks: { bm25, semantic } }].
// Chunks absent from BOTH legs (zero lexical score, non-positive similarity)
// are dropped as irrelevant padding. `queryEmbedding` may be null — the
// semantic leg is skipped and results are BM25-only.
function hybridRetrieve(index, queryText, queryEmbedding, k = 6) {
  if (!index || !Array.isArray(index.chunks) || index.chunks.length === 0) return [];

  const legs = [];

  const bm25Scores = scoreBM25(index.bm25, tokenize(queryText));
  legs.push({ name: 'bm25', ranked: rankPositive(bm25Scores) });

  if (index.embeddings && queryEmbedding) {
    const semanticScores = index.embeddings.map((vec) => dot(vec, queryEmbedding));
    legs.push({ name: 'semantic', ranked: rankPositive(semanticScores) });
  }

  const fused = new Map(); // chunkIdx -> { score, ranks }
  for (const leg of legs) {
    leg.ranked.forEach((entry, position) => {
      const rank = position + 1;
      let record = fused.get(entry.chunkIdx);
      if (!record) {
        record = { score: 0, ranks: { bm25: null, semantic: null } };
        fused.set(entry.chunkIdx, record);
      }
      record.score += 1 / (RRF_K + rank);
      record.ranks[leg.name] = rank;
    });
  }

  return Array.from(fused.entries())
    .sort((a, b) => b[1].score - a[1].score || a[0] - b[0])
    .slice(0, k)
    .map(([chunkIdx, record]) => ({
      id: index.chunks[chunkIdx].id,
      text: index.chunks[chunkIdx].text,
      start: index.chunks[chunkIdx].start,
      score: record.score,
      ranks: record.ranks
    }));
}

module.exports = {
  warmupEmbedder,
  isEmbedderReady,
  embedTexts,
  buildContractIndex,
  hybridRetrieve,
  sha256,
  // exported for unit testing
  tokenize,
  buildBM25Index,
  scoreBM25
};
