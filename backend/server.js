require('dotenv').config();

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const retrieval = require('./retrieval');
const db = require('./db');

function normalizeNumericSpacing(text) {
  if (!text) return '';
  const currencyRegex = /(\$|USD|US\$|EUR|GBP|€|£)\s*\d[\d,\s]*(?:\.\d+)?\s*(?:k|m|b|thousand|million|billion)?/gi;
  const percentRegex = /\d[\d,\s]*(?:\.\d+)?\s*%/g;
  let normalized = text.replace(currencyRegex, (match) => match.replace(/\s+/g, ''));
  normalized = normalized.replace(percentRegex, (match) => match.replace(/\s+/g, ''));
  normalized = normalized.replace(/(\d)\s+(?=\d)/g, '$1');
  return normalized;
}

function suppressPdfWarnings(action) {
  const originalWarn = console.warn;
  console.warn = (...args) => {
    const [firstArg] = args;
    if (typeof firstArg === 'string' && firstArg.startsWith('Warning: TT: undefined function')) {
      return;
    }
    originalWarn(...args);
  };
  try {
    return action();
  } finally {
    console.warn = originalWarn;
  }
}

async function extractTextFromFile(filePath) {
  try {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.pdf') {
      const dataBuffer = fs.readFileSync(filePath);
      const data = await suppressPdfWarnings(() => pdfParse(dataBuffer, {
        pagerender: (pageData) => pageData.getTextContent({ normalizeWhitespace: true })
          .then((textContent) => textContent.items.map(item => item.str).join(' '))
      }));
      return normalizeNumericSpacing(data.text);
    } else if (ext === '.docx' || ext === '.doc') {
      const result = await mammoth.extractRawText({ path: filePath });
      return normalizeNumericSpacing(result.value);
    } else if (ext === '.txt') {
      return normalizeNumericSpacing(fs.readFileSync(filePath, 'utf8'));
    }
    return '';
  } catch (err) {
    console.error('Error extracting text:', err);
    return '';
  }
}

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from the frontend
app.use(express.static(path.join(__dirname, '../frontend')));

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${uuidv4()}-${file.originalname}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['.pdf', '.docx', '.doc', '.txt'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedTypes.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only PDF, DOCX, DOC, and TXT files are allowed.'));
    }
  }
});

// In-memory data store (in production, use a database)
const contracts = new Map();
const analyses = new Map();

// Routes

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), persistence: db.isEnabled() ? 'enabled' : 'disabled' });
});

// Get all contracts
app.get('/api/contracts', (req, res) => {
  const contractList = Array.from(contracts.values()).map(c => ({
    id: c.id,
    name: c.name,
    fileName: c.fileName,
    uploadDate: c.uploadDate,
    fileSize: c.fileSize,
    status: c.status
  }));
  res.json(contractList);
});

// Get a specific contract
app.get('/api/contracts/:id', (req, res) => {
  const contract = contracts.get(req.params.id);
  if (!contract) {
    return res.status(404).json({ error: 'Contract not found' });
  }
  res.json(contract);
});

// Get a specific contract file
app.get('/api/contracts/:id/file', (req, res) => {
  const contract = contracts.get(req.params.id);
  if (!contract) {
    return res.status(404).json({ error: 'Contract not found' });
  }
  res.sendFile(contract.filePath);
});

// Upload a new contract
app.post('/api/contracts/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const contractId = uuidv4();

    const contract = {
      id: contractId,
      name: path.parse(req.file.originalname).name,
      fileName: req.file.filename,
      originalName: req.file.originalname,
      filePath: req.file.path,
      fileSize: req.file.size,
      uploadDate: new Date().toISOString(),
      status: 'analyzing',
      role: req.body.role || 'Legal'
    };

    contracts.set(contractId, contract);
    db.saveContract(contract);
    console.log(`[${new Date().toISOString()}] Contract ${contractId} (${contract.name}) uploaded. Starting processing...`);

    // Run real analysis asynchronously
    extractTextFromFile(contract.filePath).then(async (text) => {
      console.log(`[${new Date().toISOString()}] Text extraction complete for ${contract.name}. Characters: ${text.length}`);
      contract.text = text;
      await ensureContractIndex(contract, text);
      db.saveContract(contract);
      if (contract.index) db.saveChunks(contract.id, contract.index.chunks, contract.index.embeddings);

      console.log(`[${new Date().toISOString()}] Starting AI analysis for ${contract.name}...`);
      const analysis = await analyzeDocumentText(text, contract);

      contract.status = 'completed';
      contract.analysis = analysis;
      analyses.set(contractId, analysis);
      db.saveContract(contract);
      db.saveAnalysis(contractId, analysis);
      console.log(`[${new Date().toISOString()}] Analysis completed successfully for ${contract.name}.`);
    }).catch(err => {
      console.error(`[${new Date().toISOString()}] Processing failed for ${contract.name}:`, err);
      contract.status = 'error';
      db.saveContract(contract);
    });

    res.json({
      id: contractId,
      name: contract.name,
      fileName: contract.fileName,
      uploadDate: contract.uploadDate,
      fileSize: contract.fileSize,
      status: contract.status
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Failed to upload contract' });
  }
});

// Upload a new version of a contract
app.post('/api/contracts/:id/version', upload.single('file'), (req, res) => {
  try {
    const contract = contracts.get(req.params.id);
    if (!contract) return res.status(404).json({ error: 'Contract not found' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    if (!contract.versions) contract.versions = [];

    // Save current as previous version
    const previousVersion = {
      version: contract.versions.length + 1,
      name: contract.name,
      fileName: contract.fileName,
      originalName: contract.originalName,
      filePath: contract.filePath,
      fileSize: contract.fileSize,
      uploadDate: contract.uploadDate,
      analysis: contract.analysis
    };
    contract.versions.push(previousVersion);
    db.saveVersion(contract.id, previousVersion.version, previousVersion);

    // Update with new file data
    contract.fileName = req.file.filename;
    contract.originalName = req.file.originalname;
    contract.filePath = req.file.path;
    contract.fileSize = req.file.size;
    contract.uploadDate = new Date().toISOString();
    contract.status = 'analyzing';

    const currentRole = req.body.role || contract.role;
    console.log(`[${new Date().toISOString()}] New version uploaded for ${contract.name}. Processing...`);

    db.saveContract(contract);

    // Run real analysis asynchronously
    extractTextFromFile(contract.filePath).then(async (text) => {
      console.log(`[${new Date().toISOString()}] Version update: Text extracted for ${contract.name}.`);
      contract.text = text;
      await ensureContractIndex(contract, text);
      db.saveContract(contract);
      if (contract.index) db.saveChunks(contract.id, contract.index.chunks, contract.index.embeddings);
      // Re-run analysis logic over new text
      const analysis = await analyzeDocumentText(text, contract);
      contract.status = 'completed';
      contract.analysis = analysis;
      analyses.set(contract.id, analysis);
      db.saveContract(contract);
      db.saveAnalysis(contract.id, analysis);
      console.log(`[${new Date().toISOString()}] Version update completed for ${contract.name}.`);
    }).catch(err => {
      console.error(`[${new Date().toISOString()}] Version update failed for ${contract.name}:`, err);
      contract.status = 'error';
      db.saveContract(contract);
    });

    res.json(contract);
  } catch (error) {
    console.error('Version upload error:', error);
    res.status(500).json({ error: 'Failed to upload contract version' });
  }
});

// Get analysis for a contract
app.get('/api/contracts/:id/analysis', (req, res) => {
  const contract = contracts.get(req.params.id);
  if (!contract) {
    return res.status(404).json({ error: 'Contract not found' });
  }

  if (contract.status === 'error') {
    return res.status(200).json({ status: 'error', message: 'Analysis failed. Please try re-uploading.' });
  }

  const analysis = analyses.get(req.params.id);
  if (!analysis) {
    return res.status(202).json({ status: 'analyzing', message: 'Analysis in progress' });
  }

  res.json(analysis);
});

// Get extracted text for a contract
app.get('/api/contracts/:id/text', (req, res) => {
  const contract = contracts.get(req.params.id);
  if (!contract) {
    return res.status(404).json({ error: 'Contract not found' });
  }

  if (!contract.text) {
    return res.status(202).json({ status: 'analyzing', message: 'Text extraction in progress' });
  }

  const analysis = analyses.get(req.params.id);
  const numericFigures = analysis?.numericFigures || extractNumericFigures(contract.text);
  res.json({ text: contract.text, numericFigures });
});

// Update contract role
app.patch('/api/contracts/:id/role', (req, res) => {
  const { role } = req.body;
  const contract = contracts.get(req.params.id);

  if (!contract) {
    return res.status(404).json({ error: 'Contract not found' });
  }

  contract.role = role;
  contract.status = 'analyzing';
  db.saveContract(contract);
  console.log(`[${new Date().toISOString()}] Role updated to ${role} for ${contract.name}. Re-triggering analysis...`);

  // Run real analysis asynchronously
  extractTextFromFile(contract.filePath).then(async (text) => {
    console.log(`[${new Date().toISOString()}] Re-analysis: Text extracted for ${contract.name}.`);
    contract.text = text;
    await ensureContractIndex(contract, text);
    db.saveContract(contract);
    if (contract.index) db.saveChunks(contract.id, contract.index.chunks, contract.index.embeddings);
    const analysis = await analyzeDocumentText(text, contract);
    contract.status = 'completed';
    contract.analysis = analysis;
    analyses.set(req.params.id, analysis);
    db.saveContract(contract);
    db.saveAnalysis(req.params.id, analysis);
    console.log(`[${new Date().toISOString()}] Re-analysis completed for ${contract.name}.`);
  }).catch(err => {
    console.error(`[${new Date().toISOString()}] Re-analysis failed for ${contract.name}:`, err);
    contract.status = 'error';
    db.saveContract(contract);
  });

  res.json({ id: contract.id, role: contract.role, status: contract.status });
});

// Delete a contract
app.delete('/api/contracts/:id', (req, res) => {
  const contract = contracts.get(req.params.id);
  if (!contract) {
    return res.status(404).json({ error: 'Contract not found' });
  }

  // Delete the current file AND every prior version's file. Version uploads
  // snapshot the old filePath into contract.versions[] and never unlink it, so
  // without this loop each superseded upload is orphaned in uploads/ forever.
  // One bad path must not abort the delete — the DB rows still have to go.
  const uploadsRoot = path.resolve(__dirname, 'uploads');
  const filePaths = new Set(
    [contract.filePath, ...(contract.versions || []).map((v) => v.filePath)].filter(Boolean)
  );
  for (const filePath of filePaths) {
    try {
      // Defensive: only ever unlink inside uploads/. Paths come from multer, not
      // the request, but a corrupted/hand-edited DB row shouldn't delete anything else.
      if (!path.resolve(filePath).startsWith(uploadsRoot)) {
        console.warn(`[delete] Refusing to remove path outside uploads: ${filePath}`);
        continue;
      }
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (error) {
      // Best-effort: on Windows the preview iframe can still hold the file open
      // (EPERM/EBUSY). An unlink failure must NOT abort the request, or the
      // record survives in the Maps/DB while the client sees a 500.
      console.warn(`[delete] Could not remove file ${filePath}:`, error.message);
    }
  }

  contracts.delete(req.params.id);
  analyses.delete(req.params.id);
  db.deleteContract(req.params.id);

  res.json({ message: 'Contract deleted successfully' });
});

// Phase 4: last 50 chat messages for a contract, persisted across restarts.
// Frontend loads this into state.chatMessages when opening an existing
// contract; a fresh upload still starts with an empty conversation.
app.get('/api/contracts/:id/chat', (req, res) => {
  const contract = contracts.get(req.params.id);
  if (!contract) {
    return res.status(404).json({ error: 'Contract not found' });
  }
  res.json(db.getChatMessages(req.params.id, 50));
});

// Phase 4: persists both sides of a chat turn. Skips isLoading/streaming
// placeholders by construction — callers only invoke this with a fully
// resolved assistant message (the /api/chat/stream route only calls it at
// its 'done' event, never mid-stream or on failure).
function persistChatTurn(contractId, userMessage, assistantMessage) {
  db.addChatMessage(contractId, 'user', userMessage, null);
  if (assistantMessage) {
    db.addChatMessage(contractId, 'assistant', assistantMessage.content, {
      citations: assistantMessage.citations,
      implications: assistantMessage.implications,
      perspective: assistantMessage.perspective
    });
  }
}

// Chat endpoint for AI assistant
app.post('/api/chat', async (req, res) => {
  const { contractId, message, role, history } = req.body;

  const contract = contracts.get(contractId);
  if (!contract) {
    return res.status(404).json({ error: 'Contract not found' });
  }

  const response = await generateChatResponse(message, contract, role, history);
  persistChatTurn(contractId, message, response);
  res.json(response);
});

// Phase 3: streaming counterpart of /api/chat over Server-Sent Events.
// EventSource is GET-only, so the frontend drives this with fetch(POST) +
// response.body.getReader() instead. Kept alongside the non-streaming route
// as a regression fallback (both share buildChatMessages/finalizeChatAnswer,
// so their answers are identical modulo delivery).
app.post('/api/chat/stream', async (req, res) => {
  const { contractId, message, role, history } = req.body;

  const contract = contracts.get(contractId);
  if (!contract) {
    return res.status(404).json({ error: 'Contract not found' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  const sendEvent = (evt) => {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify(evt)}\n\n`);
  };

  // Aborts the upstream OpenRouter fetch if the client disconnects mid-stream
  // — no orphaned calls left running against a closed connection. Must use
  // `res` here, not `req`: Express/Node fires `req`'s 'close' as soon as the
  // request body finishes being read (i.e. almost immediately for a small
  // JSON POST), long before the client actually disconnects. `res`'s
  // 'close' correctly reflects the response connection closing; guarding on
  // `!res.writableEnded` distinguishes a genuine mid-stream disconnect from
  // the ordinary close that follows our own res.end() call.
  const abortController = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) abortController.abort();
  });

  try {
    const result = await generateChatResponseStream(message, contract, role, history, {
      onToken: (text) => sendEvent({ type: 'token', text }),
      signal: abortController.signal
    });

    if (result.failed) {
      sendEvent({ type: 'error', message: result.errorMessage });
      return res.end();
    }

    persistChatTurn(contractId, message, result.message);
    sendEvent({ type: 'done', message: result.message });
    res.end();
  } catch (err) {
    console.error('Chat stream error:', err);
    sendEvent({ type: 'error', message: 'An unexpected error occurred.' });
    res.end();
  }
});

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'nemotron-3-nano-30b-a3b:free';

// Optional fallback provider: NVIDIA NIM (build.nvidia.com), OpenAI-API-compatible.
// Used only when OpenRouter fails BEFORE producing any content/token — e.g. the
// free-tier daily rate limit. Both NIM_API_KEY and NIM_MODEL must be set for
// this to activate; if either is missing, the app behaves exactly as before
// (OpenRouter-only), matching the app's everywhere-degrade-don't-crash posture.
const NIM_API_KEY = process.env.NIM_API_KEY || '';
const NIM_MODEL = process.env.NIM_MODEL || '';

const LLM_PROVIDERS = [
  { name: 'openrouter', apiKey: OPENROUTER_API_KEY, model: OPENROUTER_MODEL, url: 'https://openrouter.ai/api/v1/chat/completions' },
  { name: 'nim', apiKey: NIM_API_KEY, model: NIM_MODEL, url: 'https://integrate.api.nvidia.com/v1/chat/completions' }
].filter((p) => p.apiKey && p.model);

// Tracks JSON-mode support per provider independently — a model that rejects
// response_format:json_object on one provider says nothing about another.
const jsonModeUnsupportedByProvider = new Map();

const CHAT_STOPWORDS = new Set([
  'the', 'and', 'but', 'for', 'with', 'that', 'this', 'from', 'into', 'about', 'what', 'why', 'how', 'can',
  'are', 'were', 'will', 'shall', 'may', 'might', 'would', 'could', 'your', 'you', 'our', 'their', 'them',
  'who', 'whom', 'which', 'when', 'where', 'than', 'then', 'there', 'here', 'over', 'under', 'such', 'any',
  'all', 'not', 'only', 'also', 'does', 'did', 'have', 'has', 'had',
  // Short function words let through by the 2-char keyword floor (see extractChatKeywords)
  'of', 'to', 'in', 'is', 'it', 'as', 'at', 'be', 'by', 'do', 'if', 'no', 'on', 'or', 'so', 'we',
  'an', 'am', 'us', 'my', 'me', 'he', 'she', 'its', 'was', 'per', 'via', 'etc', 'get', 'got',
  'let', 'say', 'said', 'use', 'one', 'two'
]);

function clampScore(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function normalizeRiskLevel(value) {
  const normalized = String(value || '').toLowerCase();
  if (normalized.includes('high')) return 'High';
  if (normalized.includes('medium')) return 'Medium';
  if (normalized.includes('low')) return 'Low';
  return null;
}

function deriveRiskLevelFromScore(score) {
  if (score >= 70) return 'High';
  if (score >= 40) return 'Medium';
  return 'Low';
}

function extractRiskSignals(text) {
  return {
    // Matches both the noun phrase ("termination for convenience") and the
    // verb form ("terminate this Agreement for convenience upon 90 days'
    // notice") — contracts overwhelmingly use the verb form, and the
    // noun-only literal was missing it entirely.
    hasTerminationForConvenience: /terminat(?:e|es|ed|ion)[\s\S]{0,80}?for convenience|for convenience[\s\S]{0,40}?terminat/i.test(text),
    hasUncappedLiability: /(uncapped|unlimited)\s+liability|liability\s+(without|no)\s+cap/i.test(text),
    hasLiabilityCap: /liability cap|limitation of liability|cap on liability|aggregate liability[\s\S]{0,80}?(?:not\s+)?exceed|liability[\s\S]{0,40}?shall not exceed/i.test(text),
    hasIndemnification: /indemnif/i.test(text),
    hasDataProtection: /gdpr|ccpa|data protection|data processing|privacy/i.test(text),
    // Broadened beyond the "payment terms"/"Net 30" literal — a fully
    // spelled-out fees section ("Client shall pay...", "...due within 30
    // days of invoice") never says the words "payment terms" but is
    // unambiguously specifying them.
    hasPaymentTerms: /payment terms|net\s?\d+|late fee|interest on late|fees and payment|shall pay|payable|invoice|late payment/i.test(text),
    hasIpOwnership: /intellectual property|ip ownership|ownership of ip|license|licensing/i.test(text)
  };
}

// Real, structural clause count from numbered headings — replaces a prior
// fabrication that used a sample of long text lines (or a hardcoded 14) and
// called it a clause count. Prefers subsection-level numbering ("2.4", "3.1")
// when there's enough of it to be meaningful; falls back to top-level
// sections/articles; returns null (not a guessed number) when neither
// numbering style is present.
function countContractClauses(text) {
  if (!text) return null;
  const subsectionMatches = text.match(/^[ \t]*\d{1,2}\.\d{1,2}\s+\S/gm) || [];
  if (subsectionMatches.length >= 3) {
    return { total: subsectionMatches.length, level: 'subsection' };
  }
  const sectionMatches = text.match(/^[ \t]*(?:\d{1,2}[.)]|section\s+\d+|article\s+[ivxlcdm\d]+)\s+\S/gim) || [];
  if (sectionMatches.length >= 2) {
    return { total: sectionMatches.length, level: 'section' };
  }
  return null;
}

function scoreEnforceabilityRisks(risks) {
  if (!Array.isArray(risks)) return 0;
  const weights = { High: 10, Medium: 6, Low: 3 };
  const total = risks.reduce((sum, risk) => {
    const normalized = normalizeRiskLevel(risk?.risk);
    return sum + (weights[normalized] || 0);
  }, 0);
  return Math.min(30, total);
}

// Returns null (not 0, not a clamped 100) when there's no verified
// obligation to divide by — an LGD of "0% risk" or "100% risk" is itself a
// claim, and neither is true when the denominator is missing/unreliable.
function computeLossGivenDefaultScore({ totalPotentialLoss, totalAmountOwed }) {
  if (!totalAmountOwed || totalAmountOwed <= 0) return null;
  const percentage = (totalPotentialLoss / totalAmountOwed) * 100;
  return clampScore(percentage);
}

function parseNumericAmount(rawValue) {
  if (!rawValue) return null;
  const lowerValue = String(rawValue).toLowerCase();
  let cleaned = String(rawValue)
    .replace(/(USD|US\$|EUR|GBP|€|£)/gi, '')
    .replace(/(thousand|million|billion)/gi, '')
    .replace(/[,$£€]/g, '')
    .trim();
  let multiplier = 1;
  if (lowerValue.includes('thousand')) multiplier = 1_000;
  if (lowerValue.includes('million')) multiplier = 1_000_000;
  if (lowerValue.includes('billion')) multiplier = 1_000_000_000;
  if (/[kmb]$/i.test(cleaned)) {
    const suffix = cleaned.slice(-1).toLowerCase();
    if (suffix === 'k') multiplier = 1_000;
    if (suffix === 'm') multiplier = 1_000_000;
    if (suffix === 'b') multiplier = 1_000_000_000;
    cleaned = cleaned.slice(0, -1);
  }
  const value = Number.parseFloat(cleaned);
  if (!Number.isFinite(value)) return null;
  return value * multiplier;
}

function parsePlainNumber(rawValue) {
  if (!rawValue) return null;
  const cleaned = String(rawValue).replace(/,/g, '').trim();
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? value : null;
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return 'Not specified';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
}

function extractNumericValuesList(text, limit = 500) {
  if (!text) return [];
  const normalizedText = text.replace(/(\d)\s+(?=\d)/g, '$1');
  const numberRegex = /\b\d[\d,]*(?:\.\d+)?\b/g;
  const matches = normalizedText.match(numberRegex) || [];
  return matches.slice(0, limit);
}

function extractNumericFigures(text, limit = 50) {
  if (!text) {
    return { currencies: [], percentages: [], numbers: [] };
  }
  const normalizedText = text.replace(/(\d)\s+(?=\d)/g, '$1');
  const currencyRegex = /(\$|USD|US\$|EUR|GBP|€|£)\s*\d[\d,]*(?:\.\d+)?\s*(?:k|m|b|thousand|million|billion)?/gi;
  const percentRegex = /\b\d[\d,]*(?:\.\d+)?\s*%/g;
  const numberRegex = /\b\d[\d,]*(?:\.\d+)?\b/g;

  const currencies = Array.from(new Set(normalizedText.match(currencyRegex) || []))
    .map((value) => value.replace(/\s+/g, ''))
    .slice(0, limit);
  const percentages = Array.from(new Set(normalizedText.match(percentRegex) || []))
    .map((value) => value.replace(/\s+/g, ''))
    .slice(0, limit);
  const numbers = Array.from(new Set(normalizedText.match(numberRegex) || []))
    .slice(0, limit);

  return { currencies, percentages, numbers };
}

function selectMaxCurrencyValue(currencies) {
  const candidates = (currencies || [])
    .map((raw) => ({ raw, value: parseNumericAmount(raw) }))
    .filter((item) => Number.isFinite(item.value));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.value - a.value);
  return candidates[0];
}

function selectMaxNumericValue(numbers) {
  const candidates = (numbers || [])
    .map((raw) => ({ raw, value: parsePlainNumber(raw) }))
    .filter((item) => Number.isFinite(item.value))
    .filter((item) => item.value >= 1000)
    .filter((item) => !(item.value >= 1900 && item.value <= 2099));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.value - a.value);
  return candidates[0];
}

function sumNumbersLocally(numbers) {
  return numbers.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
}

function cleanJsonResponse(content) {
  if (!content) return '';
  let cleaned = String(content).trim();
  cleaned = cleaned.replace(/^```json\n?/, '').replace(/^```\n?/, '').replace(/\n?```$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    cleaned = cleaned.slice(start, end + 1);
  }
  return cleaned;
}

function parseJsonResponse(content, fallback) {
  const cleaned = cleanJsonResponse(content);
  if (!cleaned) return fallback;
  try {
    return JSON.parse(cleaned);
  } catch (error) {
    console.error('Failed to parse JSON response:', error);
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Phase 2: monetary candidate filtering — kill junk (dates, section numbers,
// phone numbers) before it ever reaches the LLM.
// ---------------------------------------------------------------------------

const CURRENCY_MARKER_REGEX = /\$|USD|US\$|EUR|GBP|€|£/i;

// Keyword list is intentionally broad; "indemnif" is a deliberate stem match
// (indemnify/indemnification/indemnitee) rather than a whole-word entry.
const MONEY_KEYWORDS = [
  'fee', 'fees', 'payment', 'pay', 'price', 'penalty', 'penalties', 'liquidated', 'damages',
  'cap', 'capped', 'indemnif', 'compensation', 'amount', 'sum', 'cost', 'costs', 'value',
  'invoice', 'deposit', 'retainage', 'bond', 'insurance', 'per day', 'per week', 'per month',
  'salary', 'rate', 'budget', 'fine', 'interest'
];

function hasMoneyKeywordNearby(context) {
  const lower = context.toLowerCase();
  return MONEY_KEYWORDS.some((kw) => {
    if (kw.includes(' ')) return lower.includes(kw);
    if (kw === 'indemnif') return /\bindemnif/.test(lower);
    return new RegExp(`\\b${kw}\\b`).test(lower);
  });
}

const MONTH_NAME_REGEX = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i;
const DATE_SLASH_REGEX = /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/;
const SECTION_PRECEDING_REGEX = /(sections?|articles?|clauses?|paragraphs?|subsections?|§|no\.|items?)\s*$/i;

// Table-of-contents dot leaders ("....... 1613.   TAXES, FEES...") — a run of
// 4+ dots anywhere just before the number is a reliable non-monetary signal;
// real currency amounts are never preceded by dot leaders.
const TOC_DOT_LEADER_REGEX = /(\.\s*){4,}$/;

// Numbered heading style used throughout contracts, both TOC-aligned
// ("10.   ALL RISK BUILDER'S RISK INSURANCE") and body-text single-spaced
// ("8. CONTRACTOR SHALL...") — a bare number followed by a period, 1+
// space(s), then an ALL-CAPS run is a clause/section heading, not an amount.
// Requires 2+ consecutive caps specifically so it doesn't fire on ordinary
// sentence starts ("$500. The Contractor..."), which are Title-case, not
// ALL-CAPS ("The" breaks the run after its first letter).
const HEADING_NUMBER_AFTER_REGEX = /^\.\s+[A-Z]{2,}/;

// Numbered subsection labels at the start of a line ("2.4 Upon termination...",
// "3.1 Client shall pay...") — a dotted section/subsection number, not an
// amount. Only checked when the match sits at a line start; a genuine amount
// is never the very first token on its line without preceding prose.
const SUBSECTION_SHAPE_REGEX = /^\d{1,2}(?:\.\d{1,2})+$/;
const LINE_START_REGEX = /(^|\n)[ \t]*$/;

// Document/form reference codes ("FMA - 9", "DGS - 30 - 084", "CO - 10.1")
// chain a bare number after a hyphen. A real amount is never written
// "- 500" without a currency marker, and $-marked amounts already bypass
// this filter entirely, so this is a safe reject.
const HYPHEN_CODE_PRECEDING_REGEX = /-\s*$/;

// Returns true if `raw` should be rejected as non-monetary junk (dates,
// section/clause numbers, TOC entries, numbered headings). Only called when
// there's no currency symbol — an explicit symbol always overrides these.
function isNonMonetaryArtifact(raw, matchIndex, normalizedText) {
  const isBareYear = /^\d{4}$/.test(raw) && Number(raw) >= 1900 && Number(raw) <= 2099;
  if (isBareYear) return true;

  const narrowStart = Math.max(0, matchIndex - 20);
  const narrowEnd = Math.min(normalizedText.length, matchIndex + raw.length + 20);
  const before = normalizedText.slice(narrowStart, matchIndex);
  const narrowWindow = normalizedText.slice(narrowStart, narrowEnd);
  const after = normalizedText.slice(matchIndex + raw.length, matchIndex + raw.length + 20);

  if (MONTH_NAME_REGEX.test(narrowWindow) || DATE_SLASH_REGEX.test(narrowWindow)) return true;
  if (SECTION_PRECEDING_REGEX.test(before)) return true;
  if (TOC_DOT_LEADER_REGEX.test(before)) return true;
  if (HEADING_NUMBER_AFTER_REGEX.test(after)) return true;
  if (HYPHEN_CODE_PRECEDING_REGEX.test(before.trimEnd())) return true;
  if (SUBSECTION_SHAPE_REGEX.test(raw) && LINE_START_REGEX.test(before)) return true;

  return false;
}

// Emits a candidate only if it has money evidence (currency symbol OR a
// monetary keyword in its ±70-char context) and doesn't look like a date,
// section reference, or other non-monetary digit run. Returns candidates
// with their char offset (`index`) plus scan stats for logging/telemetry.
function extractMonetaryCandidates(text, limit = 160) {
  if (!text) return { candidates: [], stats: { scanned: 0, emitted: 0, filtered: 0 } };
  const normalizedText = text.replace(/(\d)\s+(?=\d)/g, '$1');
  // Negative lookahead on the k/m/b/thousand/etc. suffix stops it from
  // grabbing the first letter of an unrelated following word (e.g. "2
  // below" was matching as "2 b" before this — the amount-suffix and the
  // start of "below" are indistinguishable without it).
  const regex = /(\$|USD|US\$|EUR|GBP|€|£)?\s*\d[\d,]*(?:\.\d+)?\s*(?:(?:k|m|b|thousand|million|billion)(?![a-zA-Z]))?/gi;
  const candidates = [];
  let scanned = 0;
  let match;
  while ((match = regex.exec(normalizedText)) !== null) {
    const raw = match[0].trim();
    if (!raw) continue;
    scanned++;

    const hasCurrencySymbol = CURRENCY_MARKER_REGEX.test(match[1] || '');
    const matchEnd = match.index + match[0].length;

    // A percentage ("1.5%") is a rate, never a dollar amount — even with a
    // money keyword nearby ("interest at 1.5% per month"). Reject whenever
    // the digits are immediately followed (after optional whitespace) by %.
    const afterMatchRaw = normalizedText.slice(matchEnd, matchEnd + 5);
    if (/^\s*%/.test(afterMatchRaw)) continue;

    // The regex's optional leading `\s*` can absorb whitespace (including a
    // preceding newline) into match[0] before it reaches the digits — e.g. a
    // match right after "law.\n2.4 Upon..." starts at the newline, not at
    // "2". Use the true start of the trimmed `raw` text for every
    // position-sensitive check below, or "before a newline" checks silently
    // never see the newline (it's inside the match, not before it).
    const leadingWhitespaceLen = match[0].length - match[0].replace(/^\s+/, '').length;
    const rawIndex = match.index + leadingWhitespaceLen;

    const start = Math.max(0, rawIndex - 70);
    const end = Math.min(normalizedText.length, rawIndex + raw.length + 70);
    const context = normalizedText.slice(start, end).replace(/\s+/g, ' ').trim();

    if (!hasCurrencySymbol) {
      if (isNonMonetaryArtifact(raw, rawIndex, normalizedText)) continue;
      if (!hasMoneyKeywordNearby(context)) continue;
    }

    candidates.push({ raw, context, index: rawIndex, hasCurrencyMarker: hasCurrencySymbol });
    if (candidates.length >= limit) break;
  }

  return {
    candidates,
    stats: { scanned, emitted: candidates.length, filtered: scanned - candidates.length }
  };
}

// ---------------------------------------------------------------------------
// LLM call helper: timeout, retry-with-backoff, JSON mode with automatic
// fallback for models that reject `response_format`, and provider fallback
// (OpenRouter -> NIM, if NIM is configured) when a provider is unavailable.
// ---------------------------------------------------------------------------

async function attemptProviderOnce(provider, messages, useJsonMode, timeoutMs) {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = { model: provider.model, messages };
    if (useJsonMode) {
      body.response_format = { type: 'json_object' };
    }

    const response = await fetch(provider.url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${provider.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      // JSON mode itself might be rejected (4xx, excluding 429 rate-limits)
      // by a model that doesn't support it — signal the caller to
      // immediately retry without it, rather than burning a retry attempt
      // on a doomed request shape.
      if (useJsonMode && response.status >= 400 && response.status < 500 && response.status !== 429) {
        return { unsupported: true };
      }
      console.error(`${provider.name} error: ${response.status} ${response.statusText}`, errorText);
      return { failed: true, status: response.status };
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    if (!content) return { failed: true };
    return { content };
  } catch (error) {
    if (error.name === 'AbortError') {
      console.error(`${provider.name} call timed out after ${timeoutMs}ms`);
    } else {
      console.error(`${provider.name} call error:`, error);
    }
    return { failed: true };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

// Iterates configured providers in order (OpenRouter first, then NIM if
// configured). A 429/5xx response moves on to the next provider immediately
// instead of burning retries against a quota that won't refill in seconds;
// other failures still get the existing backoff-and-retry treatment on the
// SAME provider first. Returns null only if every configured provider (and
// all of their retries) failed, or none are configured at all.
async function callOpenRouter(messages, { expectJson = true, retries = 1, timeoutMs = 90000 } = {}) {
  if (LLM_PROVIDERS.length === 0) return null;

  for (const provider of LLM_PROVIDERS) {
    let jsonModeUnsupported = jsonModeUnsupportedByProvider.get(provider.name) || false;
    const maxAttempts = retries + 1;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let result = await attemptProviderOnce(provider, messages, expectJson && !jsonModeUnsupported, timeoutMs);

      if (result.unsupported) {
        jsonModeUnsupported = true;
        jsonModeUnsupportedByProvider.set(provider.name, true);
        result = await attemptProviderOnce(provider, messages, false, timeoutMs);
      }

      if (result.content) {
        if (!expectJson) return result.content;
        const parsed = parseJsonResponse(result.content, null);
        if (parsed) return parsed;
        // Malformed JSON from the model — fall through to retry below.
      }

      if (result.status === 429 || (result.status && result.status >= 500)) {
        console.warn(`[llm] ${provider.name} unavailable (${result.status}) — trying next provider if configured.`);
        break;
      }

      if (attempt < maxAttempts - 1) {
        await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Phase 3: streaming OpenRouter call (SSE) for the chat endpoint.
// ---------------------------------------------------------------------------

// Parses one chunk of raw upstream SSE bytes against a running `buffer`.
// OpenRouter sends `data: {json}\n\n` lines terminated by `data: [DONE]`, and
// a single fetch chunk can split a line mid-JSON — so we only ever parse
// complete lines and carry the trailing partial line forward in `buffer`.
// Pure/standalone so it's directly unit-testable.
function parseSseChunk(buffer, chunkText) {
  const combined = buffer + chunkText;
  const lines = combined.split('\n');
  const remainder = lines.pop() ?? '';
  const events = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      events.push(JSON.parse(payload));
    } catch (err) {
      // Malformed/unexpectedly-split JSON — skip this line rather than throw.
    }
  }
  return { events, buffer: remainder };
}

// Streams a chat completion, invoking `onToken(text)` per delta. Retry
// semantics deliberately differ from callOpenRouter: a failure is only
// retried (same provider, then the next configured provider) if it happens
// BEFORE the first token is emitted — nothing has been shown to the client
// yet, so a silent retry/hand-off is safe. Once a token has flowed, the
// caller is committed to that provider's answer and must surface an error
// instead of switching providers mid-stream (which would produce mixed,
// confusing partial content).
async function attemptProviderStreamOnce(provider, messages, timeoutMs, signal, onToken) {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  let firstTokenReceived = false;
  let fullContent = '';

  try {
    const response = await fetch(provider.url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${provider.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ model: provider.model, messages, stream: true }),
      signal: controller.signal
    });

    if (!response.ok || !response.body) {
      const errorText = await response.text().catch(() => '');
      console.error(`${provider.name} stream error: ${response.status} ${response.statusText}`, errorText);
      return { failed: true, beforeFirstToken: true, status: response.status };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunkText = decoder.decode(value, { stream: true });
      const parsed = parseSseChunk(buffer, chunkText);
      buffer = parsed.buffer;
      for (const evt of parsed.events) {
        const delta = evt.choices?.[0]?.delta?.content;
        if (delta) {
          firstTokenReceived = true;
          fullContent += delta;
          if (onToken) onToken(delta);
        }
      }
    }

    return { content: fullContent };
  } catch (error) {
    const label = error.name === 'AbortError' ? 'aborted' : 'errored';
    console.error(`${provider.name} stream ${label}${firstTokenReceived ? ' (after tokens flowed)' : ' (before first token)'}:`, error.message);
    return { failed: true, beforeFirstToken: !firstTokenReceived, partialContent: fullContent };
  } finally {
    clearTimeout(timeoutHandle);
    if (signal) signal.removeEventListener('abort', onExternalAbort);
  }
}

async function callOpenRouterStream(messages, { onToken, timeoutMs = 90000, retries = 1, signal } = {}) {
  if (LLM_PROVIDERS.length === 0) return { failed: true, beforeFirstToken: true };

  let lastResult;
  for (const provider of LLM_PROVIDERS) {
    const maxAttempts = retries + 1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      lastResult = await attemptProviderStreamOnce(provider, messages, timeoutMs, signal, onToken);
      if (lastResult.content !== undefined) return lastResult;
      if (!lastResult.beforeFirstToken) return lastResult; // tokens already flowed — committed to this provider
      if (attempt < maxAttempts - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
    console.warn(`[llm-stream] ${provider.name} unavailable before any token — trying next provider if configured.`);
  }
  return lastResult;
}

// ---------------------------------------------------------------------------
// Phase 2: grounding verification — reject hallucinated monetary items and
// dedupe items the LLM restated against the same source occurrence.
// ---------------------------------------------------------------------------

function normalizeRawForMatch(raw) {
  return String(raw || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function jaccardSimilarity(textA, textB) {
  const tokensA = new Set(String(textA || '').toLowerCase().match(/[a-z0-9]+/g) || []);
  const tokensB = new Set(String(textB || '').toLowerCase().match(/[a-z0-9]+/g) || []);
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) intersection++;
  }
  const union = new Set([...tokensA, ...tokensB]).size;
  return union === 0 ? 0 : intersection / union;
}

// Locates a candidate for `item` — exact raw match first, then amount
// equality (handles the LLM reformatting "$50,000" as "50000 USD"). Only
// considers candidates not already consumed by an earlier item so the same
// source occurrence can't ground two items. If a match exists but was
// already consumed, the item is a duplicate restatement rather than a
// hallucination — callers use `reason` to tell the two apart.
function findCandidateMatch(item, candidates, consumed) {
  const itemRaw = normalizeRawForMatch(item.raw);
  const itemAmount = Number(item.amount);

  let idx = candidates.findIndex((c, i) => !consumed.has(i) && normalizeRawForMatch(c.raw) === itemRaw);
  if (idx === -1 && Number.isFinite(itemAmount)) {
    idx = candidates.findIndex((c, i) => {
      if (consumed.has(i)) return false;
      const amount = parseNumericAmount(c.raw);
      return Number.isFinite(amount) && Math.abs(amount - itemAmount) < 0.01;
    });
  }
  if (idx !== -1) return { idx, reason: null };

  let anyIdx = candidates.findIndex((c) => normalizeRawForMatch(c.raw) === itemRaw);
  if (anyIdx === -1 && Number.isFinite(itemAmount)) {
    anyIdx = candidates.findIndex((c) => {
      const amount = parseNumericAmount(c.raw);
      return Number.isFinite(amount) && Math.abs(amount - itemAmount) < 0.01;
    });
  }
  return { idx: -1, reason: anyIdx !== -1 ? 'duplicate' : 'hallucinated' };
}

function verifyMonetaryItemCategory(items, candidates) {
  const consumed = new Set();
  const grounded = [];
  const dropped = [];

  for (const item of items) {
    const { idx, reason } = findCandidateMatch(item, candidates, consumed);
    if (idx === -1) {
      dropped.push({ ...item, reason: reason || 'hallucinated' });
      continue;
    }
    consumed.add(idx);
    const candidate = candidates[idx];
    grounded.push({
      ...item,
      sourceContext: candidate.context,
      sourceOffset: candidate.index,
      hasCurrencyMarker: !!candidate.hasCurrencyMarker
    });
  }

  // Soft duplicate flag: equal amounts + >60% shared context tokens. Never
  // drops — avoids false-positive removal of two genuinely separate fees
  // that happen to be described in similar language.
  for (let i = 0; i < grounded.length; i++) {
    for (let j = 0; j < i; j++) {
      if (Math.abs((Number(grounded[i].amount) || 0) - (Number(grounded[j].amount) || 0)) < 0.01) {
        if (jaccardSimilarity(grounded[i].sourceContext, grounded[j].sourceContext) > 0.6) {
          grounded[i].possibleDuplicate = true;
          break;
        }
      }
    }
  }

  return { grounded, dropped };
}

// → { risks, obligations, rates, insuranceRequirements, droppedRisks,
//     droppedObligations, droppedRates, droppedInsuranceRequirements, grounding }
// Each category is verified against `candidates` independently — a candidate
// consumed by an item in one category can still ground an item in another.
function verifyMonetaryItems(parsed, candidates) {
  const risksResult = verifyMonetaryItemCategory(Array.isArray(parsed?.risks) ? parsed.risks : [], candidates);
  const obligationsResult = verifyMonetaryItemCategory(Array.isArray(parsed?.obligations) ? parsed.obligations : [], candidates);
  const ratesResult = verifyMonetaryItemCategory(Array.isArray(parsed?.rates) ? parsed.rates : [], candidates);
  const insuranceResult = verifyMonetaryItemCategory(Array.isArray(parsed?.insuranceRequirements) ? parsed.insuranceRequirements : [], candidates);

  const results = [risksResult, obligationsResult, ratesResult, insuranceResult];
  const total = results.reduce((sum, r) => sum + r.grounded.length + r.dropped.length, 0);
  const grounded = results.reduce((sum, r) => sum + r.grounded.length, 0);
  const dropped = results.reduce((sum, r) => sum + r.dropped.length, 0);

  return {
    risks: risksResult.grounded,
    obligations: obligationsResult.grounded,
    rates: ratesResult.grounded,
    insuranceRequirements: insuranceResult.grounded,
    droppedRisks: risksResult.dropped,
    droppedObligations: obligationsResult.dropped,
    droppedRates: ratesResult.dropped,
    droppedInsuranceRequirements: insuranceResult.dropped,
    grounding: { total, grounded, dropped, rate: total === 0 ? 1 : grounded / total }
  };
}

// Context-based reclassification — the LLM's category choice is never
// trusted on its own. A candidate whose surrounding text names an insurance
// coverage minimum or a per-unit rate is moved into that bucket regardless
// of what the model called it, because neither is money owed or at risk —
// they're requirements/prices, and including them in exposure/LGD sums
// silently inflates both (this is exactly how a $2,000,000 insurance
// minimum and a $275/hour rate ended up inside "total financial exposure").
const INSURANCE_CONTEXT_REGEX = /insur|coverage of not less|certificate of insurance/i;
const RATE_CONTEXT_REGEX = /per\s+(hour|day|week|month|annum|year)|\/\s*(hr|hour|day|month)|hourly|per occurrence/i;

function reclassifyMonetaryItems({ risks = [], obligations = [], rates = [], insuranceRequirements = [] }) {
  const outRisks = [];
  const outObligations = [];
  const outRates = [...rates];
  const outInsurance = [...insuranceRequirements];

  const sort = (item, defaultBucket) => {
    const context = item.sourceContext || '';
    if (INSURANCE_CONTEXT_REGEX.test(context)) {
      outInsurance.push(item);
    } else if (RATE_CONTEXT_REGEX.test(context)) {
      outRates.push(item);
    } else {
      defaultBucket.push(item);
    }
  };

  for (const item of risks) sort(item, outRisks);
  for (const item of obligations) sort(item, outObligations);

  // The LLM sometimes classifies the same source occurrence into two
  // categories at once (e.g. an insurance minimum as both a "risk" and an
  // "insuranceRequirement") — both verify individually since risks/
  // obligations/rates/insurance are each grounded independently, but showing
  // the identical source offset twice in one bucket is a display duplicate,
  // not two distinct facts. Collapse by sourceOffset within each bucket.
  const dedupeBySourceOffset = (items) => {
    const seen = new Set();
    return items.filter((item) => {
      if (item.sourceOffset === undefined || item.sourceOffset === null) return true;
      if (seen.has(item.sourceOffset)) return false;
      seen.add(item.sourceOffset);
      return true;
    });
  };

  return {
    risks: dedupeBySourceOffset(outRisks),
    obligations: dedupeBySourceOffset(outObligations),
    rates: dedupeBySourceOffset(outRates),
    insuranceRequirements: dedupeBySourceOffset(outInsurance)
  };
}

// A grounded item counts toward exposure/obligation SUMS only if it's
// unambiguously a dollar amount: either the source text carried an explicit
// currency marker, or (for bare numbers admitted via a money-keyword match)
// it's large enough and sits next to a strict money noun. This is what keeps
// a bare duration like "twelve (12) months" — which passes the broader
// candidate-extraction keyword gate — out of a financial total, while still
// summing a keyword-gated bare figure like "late fee of 1,500".
const STRICT_MONEY_NOUN_REGEX = /\b(fee|fees|payment|price|penalt|damages|deposit|invoice|compensation|salary|fine)\b/i;

function isSumEligible(item) {
  if (item?.hasCurrencyMarker) return true;
  const amount = Number(item?.amount);
  if (!Number.isFinite(amount) || amount < 100) return false;
  return STRICT_MONEY_NOUN_REGEX.test(item?.sourceContext || '');
}

async function selectMonetaryExposureWithLLM(candidates) {
  if (LLM_PROVIDERS.length === 0) return null;
  if (!Array.isArray(candidates) || candidates.length === 0) return null;

  const systemPrompt = `You are a contract analyst specialized in financial risk.
From the provided list of numeric candidates with context, identify EVERY individual monetary amount mentioned.

Categorize them into:
1. "risks": Liquidated damages, penalties, fixed liability caps, indemnification limits, or other potential losses.
2. "obligations": Contract price, principal fees, installments, deposits, reimbursable-expense caps, or other amounts owed.
3. "rates": Per-hour/per-day/per-week/per-month unit prices (e.g. "$275 per hour").
4. "insuranceRequirements": Insurance coverage minimums a party must maintain (e.g. "$2,000,000 per occurrence").

Only include figures that are present in the provided candidates. Never invent, estimate, or guess a figure.
If a category has no genuine entries, return an empty array for it.
Exclude dates, IDs, and non-monetary figures.
Return strictly valid JSON:
{
  "risks": [ { "raw": "...", "amount": <number>, "reason": "...", "riskLevel": "Low|Medium|High" } ],
  "obligations": [ { "raw": "...", "amount": <number>, "reason": "..." } ],
  "rates": [ { "raw": "...", "amount": <number>, "reason": "..." } ],
  "insuranceRequirements": [ { "raw": "...", "amount": <number>, "reason": "..." } ],
  "riskExplanation": "...",
  "comments": "If no relevant risks or obligations are found, explicitly state why here."
}
Only output the raw JSON object.`;

  const parsed = await callOpenRouter([
    { role: "system", content: systemPrompt },
    { role: "user", content: JSON.stringify(candidates) }
  ], { expectJson: true, retries: 1 });

  if (!parsed) return null;

  // Grounding: reject items that don't correspond to real source text, and
  // dedupe restatements of the same occurrence. Sums are computed over
  // grounded items only, so a hallucinated amount can't skew exposure/LGD.
  const verified = verifyMonetaryItems(parsed, candidates);

  if (verified.grounding.dropped > 0) {
    const droppedDetail = [
      ...verified.droppedRisks, ...verified.droppedObligations,
      ...verified.droppedRates, ...verified.droppedInsuranceRequirements
    ].map((d) => `${d.raw} (${d.reason})`).join(', ');
    console.warn(`[monetary] Dropped ${verified.grounding.dropped} ungrounded item(s): ${droppedDetail}`);
  }

  // Server-side truth: context decides the category, not the LLM's label.
  const reclassified = reclassifyMonetaryItems(verified);

  const eligibleRisks = reclassified.risks.filter(isSumEligible);
  const eligibleObligations = reclassified.obligations.filter(isSumEligible);
  const excludedFromSums = (reclassified.risks.length - eligibleRisks.length)
    + (reclassified.obligations.length - eligibleObligations.length);

  const totalPotentialLoss = eligibleRisks.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);

  // The obligation total is the LARGEST single verified obligation, not a
  // sum — a contract's total price and its component installments are all
  // separately-extracted candidates, so blindly summing them double-counts
  // (e.g. "$480,000 total" + "$80,000/quarter installment" would otherwise
  // add up to $560,000 of obligation that doesn't exist). The largest
  // verified figure is a defensible proxy for total contract value.
  let totalAmountOwed = null;
  let lgdBasis = null;
  for (const o of eligibleObligations) {
    const amount = Number(o.amount) || 0;
    if (totalAmountOwed === null || amount > totalAmountOwed) {
      totalAmountOwed = amount;
      lgdBasis = { raw: o.raw, sourceOffset: o.sourceOffset };
    }
  }

  return {
    totalPotentialLoss,
    totalAmountOwed,
    lgdBasis,
    risks: reclassified.risks,
    obligations: reclassified.obligations,
    rates: reclassified.rates,
    insuranceRequirements: reclassified.insuranceRequirements,
    excludedFromSums,
    grounding: verified.grounding,
    riskExplanation: parsed?.riskExplanation || '',
    comments: parsed?.comments || ''
  };
}

function extractChatKeywords(message) {
  // 2-char floor so short-but-critical contract terms (IP, fee, cap, tax, pay, net)
  // survive extraction instead of being dropped by an overly strict length cutoff.
  const words = String(message || '')
    .toLowerCase()
    .match(/[a-z][a-z0-9-]{1,}/g) || [];
  const keywords = words.filter(word => !CHAT_STOPWORDS.has(word));
  return Array.from(new Set(keywords));
}

// ---------------------------------------------------------------------------
// Shared chunking + keyword scoring (used by chat retrieval and both RAG paths)
// ---------------------------------------------------------------------------

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Lines that plausibly start a new contract clause/section — used to avoid
// packing unrelated clauses into one chunk and to prefer splitting there.
const HEADING_REGEX = /^(section\s+\d|article\s+[ivxlcdm\d]|\d+(?:\.\d+)*[.)]\s|[A-Z][A-Z0-9 ,'&/-]{6,}$)/i;

const keywordRegexCache = new Map();
function getKeywordRegex(keywordLower) {
  let regex = keywordRegexCache.get(keywordLower);
  if (!regex) {
    regex = new RegExp('\\b' + escapeRegex(keywordLower) + '\\b', 'g');
    keywordRegexCache.set(keywordLower, regex);
  }
  regex.lastIndex = 0;
  return regex;
}

// Word-boundary keyword scoring. Fixes the old `chunk.includes('ip')` bug,
// where short keywords like "ip" matched inside "equipment"/"recipient"/etc.
// Score = 1 point per distinct keyword present, plus a small bonus (capped)
// for repeated occurrences, so one repeated word can't drown out the rest.
function scoreChunkByKeywords(chunkLower, keywords) {
  let score = 0;
  for (const kw of keywords) {
    const regex = getKeywordRegex(kw.toLowerCase());
    const matches = chunkLower.match(regex);
    if (!matches || matches.length === 0) continue;
    score += 1 + Math.min(matches.length - 1, 3) * 0.25;
  }
  return score;
}

// Splits text into paragraph/heading-bounded blocks, tracking exact char
// offsets in the original text as we go (single pass, no indexOf lookups —
// avoids offset ambiguity when the same line text repeats in the document).
function splitIntoBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  let offset = 0;
  let currentLines = [];
  let currentStart = 0;

  const flush = () => {
    if (currentLines.length === 0) return;
    const blockText = currentLines.join('\n');
    if (blockText.trim().length > 0) {
      blocks.push({ text: blockText, start: currentStart });
    }
    currentLines = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const isBlank = trimmed.length === 0;
    const isHeading = !isBlank && HEADING_REGEX.test(trimmed);

    if (isBlank) {
      flush();
    } else if (isHeading && currentLines.length > 0) {
      flush();
      currentStart = offset;
      currentLines.push(line);
    } else {
      if (currentLines.length === 0) currentStart = offset;
      currentLines.push(line);
    }

    offset += line.length + 1; // +1 accounts for the '\n' consumed by split('\n')
  }
  flush();

  return blocks;
}

// Splits a single oversized block on sentence boundaries so we never cut a
// clause mid-sentence just because it crossed a fixed character count.
function splitBySentences(blockText, blockStart, targetSize) {
  const sentenceRegex = /[^.!?\n]+[.!?]+(?:\s+|\n+|$)/g;
  const sentences = [];
  let lastIndex = 0;
  let match;
  while ((match = sentenceRegex.exec(blockText)) !== null) {
    sentences.push(match[0]);
    lastIndex = sentenceRegex.lastIndex;
  }
  if (lastIndex < blockText.length) {
    sentences.push(blockText.slice(lastIndex));
  }
  if (sentences.length === 0) {
    sentences.push(blockText);
  }

  const chunks = [];
  let currentText = '';
  let currentStartWithinBlock = 0;
  let cursor = 0;

  for (const sentence of sentences) {
    if (currentText.length === 0) {
      currentStartWithinBlock = cursor;
      currentText = sentence;
    } else if (currentText.length + sentence.length <= targetSize) {
      currentText += sentence;
    } else {
      chunks.push({ text: currentText, start: blockStart + currentStartWithinBlock });
      currentStartWithinBlock = cursor;
      currentText = sentence;
    }
    cursor += sentence.length;
  }
  if (currentText.length > 0) {
    chunks.push({ text: currentText, start: blockStart + currentStartWithinBlock });
  }

  // Last resort: a single run-on "sentence" (no punctuation) still too large.
  const safeChunks = [];
  for (const c of chunks) {
    if (c.text.length <= targetSize * 1.5) {
      safeChunks.push(c);
    } else {
      for (let i = 0; i < c.text.length; i += targetSize) {
        safeChunks.push({ text: c.text.slice(i, i + targetSize), start: c.start + i });
      }
    }
  }
  return safeChunks;
}

function packBlocksIntoChunks(blocks, targetSize) {
  const rawChunks = [];
  let currentText = '';
  let currentStart = null;

  const pushCurrent = () => {
    if (currentText.trim().length > 0) {
      rawChunks.push({ text: currentText, start: currentStart });
    }
    currentText = '';
    currentStart = null;
  };

  for (const block of blocks) {
    if (block.text.length > targetSize) {
      pushCurrent();
      rawChunks.push(...splitBySentences(block.text, block.start, targetSize));
      continue;
    }

    if (currentText.length === 0) {
      currentStart = block.start;
      currentText = block.text;
    } else if (currentText.length + 2 + block.text.length <= targetSize) {
      currentText += '\n\n' + block.text;
    } else {
      pushCurrent();
      currentStart = block.start;
      currentText = block.text;
    }
  }
  pushCurrent();

  return rawChunks;
}

// Prefixes each chunk (after the first) with a trailing slice of the previous
// chunk, trimmed back to a whitespace boundary so it never starts mid-word.
// `start` always stays the offset of the chunk's own (non-overlap) content,
// so `originalText.slice(chunk.start)` still lines up with that content —
// overlap is purely additive context for retrieval, not a shift of identity.
function applyOverlap(rawChunks, overlap) {
  const result = [];
  for (let i = 0; i < rawChunks.length; i++) {
    const { text, start } = rawChunks[i];
    if (i === 0 || overlap <= 0) {
      result.push({ id: i + 1, text, start });
      continue;
    }
    const prev = rawChunks[i - 1];
    const rawOverlapText = prev.text.slice(Math.max(0, prev.text.length - overlap));
    const firstSpace = rawOverlapText.indexOf(' ');
    const trimmedOverlap = firstSpace === -1 ? '' : rawOverlapText.slice(firstSpace + 1);
    const combinedText = trimmedOverlap.length > 0 ? `${trimmedOverlap} ${text}` : text;
    result.push({ id: i + 1, text: combinedText, start });
  }
  return result;
}

// Deterministic, clause-aware chunker shared by chat retrieval and both RAG
// paths. Replaces three previous copies that sliced at fixed char offsets
// with zero overlap (splitting clauses mid-sentence) and duplicated logic.
function chunkText(text, { targetSize = 1500, overlap = 200 } = {}) {
  if (!text || !text.trim()) return [];
  if (text.length <= targetSize) {
    return [{ id: 1, text, start: 0 }];
  }

  const blocks = splitIntoBlocks(text);
  if (blocks.length === 0) return [];

  const rawChunks = packBlocksIntoChunks(blocks, targetSize);
  return applyOverlap(rawChunks, overlap);
}

// ---------------------------------------------------------------------------
// Phase 1: per-contract retrieval index (embeddings + BM25, see retrieval.js).
// Built once per extracted text; the sha256 check makes role switches (which
// re-extract the same file) reuse the index instead of re-embedding.
// ---------------------------------------------------------------------------

async function ensureContractIndex(contract, text) {
  const logPrefix = `[${new Date().toISOString()}] [Index: ${contract.name}]`;
  try {
    const textHash = retrieval.sha256(text);
    if (contract.index && contract.index.textHash === textHash) {
      console.log(`${logPrefix} Index reused (text unchanged).`);
      return;
    }
    contract.index = await retrieval.buildContractIndex(text, chunkText);
    if (contract.index) {
      console.log(`${logPrefix} Index built: ${contract.index.chunks.length} chunks, embeddings: ${contract.index.embeddings ? 'yes' : 'no (BM25-only)'}.`);
    } else {
      console.warn(`${logPrefix} Index build failed — retrieval falls back to keyword scoring.`);
    }
  } catch (err) {
    console.warn(`${logPrefix} Index build error — keyword fallback will be used:`, err.message);
    contract.index = null;
  }
}

async function buildRelevantContext(text, question, maxChunks = 4, contract = null) {
  if (!text) return { chunks: [], keywords: [] };
  const keywords = extractChatKeywords(question);

  // Phase 1: hybrid retrieval over the prebuilt contract index. Return shape
  // stays { chunks: [{id, chunk, score}], keywords } so prompt-building code
  // downstream is unchanged.
  if (contract && contract.index) {
    const queryEmbeddings = await retrieval.embedTexts([question]);
    const queryEmbedding = (queryEmbeddings && queryEmbeddings[0]) || null;
    const hits = retrieval.hybridRetrieve(contract.index, question, queryEmbedding, maxChunks);
    if (hits.length > 0) {
      return {
        keywords,
        chunks: hits.map(h => ({ id: h.id, chunk: h.text, score: h.score }))
      };
    }
  }

  // Phase 0 keyword-scoring fallback (no index, or no relevant hits).
  const chunks = chunkText(text, { targetSize: 1200, overlap: 150 });
  const fallbackKeywords = [
    'termination', 'liability', 'indemnification', 'warranty', 'payment', 'confidential', 'privacy',
    'data', 'license', 'intellectual property', 'governing law', 'jurisdiction', 'breach', 'renewal',
    'assignment', 'limitation'
  ];
  const scoringKeywords = keywords.length > 0 ? keywords : fallbackKeywords;
  const scoredChunks = chunks.map((c) => ({
    id: c.id,
    chunk: c.text,
    score: scoreChunkByKeywords(c.text.toLowerCase(), scoringKeywords)
  }));
  scoredChunks.sort((a, b) => b.score - a.score);
  return {
    keywords: scoringKeywords,
    chunks: scoredChunks.slice(0, maxChunks)
  };
}

// Role query strings for hybrid retrieval (Phase 1). Written as natural
// keyword-dense queries: the BM25 leg matches exact terms, the embedding
// leg catches paraphrases ("cancel with one month notice" ~ "termination").
const PM_ROLE_QUERY = 'deliverables schedule milestones intellectual property ownership license timeline due dates action items responsibilities';
const LEGAL_ROLE_QUERY = 'liability cap termination indemnification governing law jurisdiction data protection GDPR compliance warranty breach';

// Hybrid retrieval against the contract's prebuilt index. Returns the top-k
// hits, or null when the index is missing / retrieval comes back empty —
// callers then use the Phase 0 keyword-scoring path.
async function retrieveTopChunks(contract, queryText, k) {
  if (!contract || !contract.index) return null;
  const queryEmbeddings = await retrieval.embedTexts([queryText]);
  const queryEmbedding = (queryEmbeddings && queryEmbeddings[0]) || null;
  const hits = retrieval.hybridRetrieve(contract.index, queryText, queryEmbedding, k);
  return hits.length > 0 ? hits : null;
}

// PM RAG Logic
async function generatePMInsightsWithRAG(text, contract) {
  try {
    if (LLM_PROVIDERS.length === 0) {
      console.error("CRITICAL: No LLM provider configured (OPENROUTER_API_KEY or NIM_API_KEY+NIM_MODEL). PM analysis cannot proceed.");
      return null;
    }

    // RAG retrieval: hybrid (BM25 + embeddings, RRF-fused) over the contract
    // index; falls back to Phase 0 keyword scoring if the index is missing.
    let topContext;
    const hybridHits = await retrieveTopChunks(contract, PM_ROLE_QUERY, 6);
    if (hybridHits) {
      topContext = hybridHits.map(c => c.text).join('\n---\n');
    } else {
      const chunks = chunkText(text, { targetSize: 1500, overlap: 200 });
      const pmKeywords = ['deliverable', 'schedule', 'intellectual property', 'ip', 'timeline', 'action', 'due', 'project', 'responsibility', 'milestone', 'date', 'rights', 'software'];
      const scoredChunks = chunks.map(c => ({
        chunk: c.text,
        score: scoreChunkByKeywords(c.text.toLowerCase(), pmKeywords)
      }));
      scoredChunks.sort((a, b) => b.score - a.score);
      topContext = scoredChunks.slice(0, 4).map(c => c.chunk).join('\n---\n');
    }

    // Generative Step: OpenRouter Call
    const systemPrompt = `You are an expert legal Project Manager AI assistant.
Analyze the provided contract excerpts and extract PM insights into strictly valid JSON format matching this schema:
{
  "deliverables": [ { "name": "...", "due": "...", "quote": "exact verbatim substring from the excerpts" } ],
  "ipRights": {
    "customerData": "...", "saasSoftware": "...", "usageRestrictions": "...",
    "quotes": { "customerData": "...", "saasSoftware": "...", "usageRestrictions": "..." }
  },
  "timelines": [ { "event": "...", "date": "...", "quote": "..." } ],
  "actionItems": [ { "task": "...", "assigned": "...", "quote": "..." } ]
}
Every array item MUST include "quote": an EXACT, verbatim substring copied from the excerpts that supports it. Items whose quote is not verbatim will be discarded.
A contract does not record execution status or progress — do NOT include a "status" or "progress" field.
If the contract does not contain information for a field, use the string "Not specified" (for string fields) or omit the item entirely (for array entries). NEVER guess, estimate, or invent information. Only output the raw JSON object. Do NOT use markdown code blocks (\`\`\`).`;

    return await callOpenRouter([
      { role: "system", content: systemPrompt },
      { role: "user", content: `Contract Excerpts to Analyze:\n${topContext}` }
    ], { expectJson: true, retries: 1 });
  } catch (err) {
    console.error("RAG Error for PM View:", err);
    return null;
  }
}

function getFallbackPMInsights() {
  return {
    deliverables: [],
    ipRights: {
      customerData: 'Not determined',
      saasSoftware: 'Not determined',
      usageRestrictions: 'Not determined'
    },
    timelines: [],
    actionItems: []
  };
}

// Legal RAG Logic
async function generateLegalInsightsWithRAG(text, contract) {
  try {
    if (LLM_PROVIDERS.length === 0) {
      console.error("CRITICAL: No LLM provider configured (OPENROUTER_API_KEY or NIM_API_KEY+NIM_MODEL). Legal analysis cannot proceed.");
      return null;
    }

    let topContext;
    const hybridHits = await retrieveTopChunks(contract, LEGAL_ROLE_QUERY, 6);
    if (hybridHits) {
      topContext = hybridHits.map(c => c.text).join('\n---\n');
    } else {
      const chunks = chunkText(text, { targetSize: 1500, overlap: 200 });
      const legalKeywords = ['liability', 'termination', 'indemnification', 'governing law', 'jurisdiction', 'data protection', 'gdpr', 'ccpa', 'compliance', 'warranty', 'breach', 'risk', 'cap', 'statute'];
      const scoredChunks = chunks.map(c => ({
        chunk: c.text,
        score: scoreChunkByKeywords(c.text.toLowerCase(), legalKeywords)
      }));
      scoredChunks.sort((a, b) => b.score - a.score);
      topContext = scoredChunks.slice(0, 4).map(c => c.chunk).join('\n---\n');
    }

    const systemPrompt = `You are an expert legal counsel AI.
Analyze the provided contract excerpts and extract legal insights into strictly valid JSON format matching this schema:
{
  "overallRisk": "Low|Medium|High",
  "complianceScore": <number 0-100>,
  "enforceabilityRisks": [ { "id": 1, "section": "...", "title": "...", "risk": "High|Medium|Low", "description": "...", "suggestedAction": "...", "quote": "exact quote substring from text" } ],
  "complianceChecks": [ { "name": "...", "status": "pass|warning|fail", "note": "...", "quote": "..." } ],
  "jurisdiction": { "location": "...", "governingLaw": "...", "notes": ["..."] }
}
For "quote", you MUST extract an EXACT, verbatim, short substring from the text that proves your analysis. Items whose quote is not found verbatim in the contract will be discarded.
If the contract does not contain information for a field, use "Not specified" (for string fields) or omit the item entirely (for array entries). NEVER guess or invent information. Only output the raw JSON object. Do NOT use markdown code blocks (\`\`\`).`;

    return await callOpenRouter([
      { role: "system", content: systemPrompt },
      { role: "user", content: `Contract Excerpts to Analyze:\n${topContext}` }
    ], { expectJson: true, retries: 1 });
  } catch (err) {
    console.error("RAG Error for Legal View:", err);
    return null;
  }
}

function getFallbackLegalInsights() {
  return {
    overallRisk: null,
    complianceScore: null,
    enforceabilityRisks: [],
    complianceChecks: [],
    jurisdiction: {
      location: 'Not determined',
      governingLaw: 'Not determined',
      notes: ['AI legal analysis unavailable for this run.']
    }
  };
}

// Generate real analysis from document text
async function analyzeDocumentText(text, contract) {
  const logPrefix = `[${new Date().toISOString()}] [Analysis: ${contract.name}]`;
  console.log(`${logPrefix} Starting document analysis pipeline...`);

  // basic parsing logic
  // extract numeric figures with explicit normalization for PDFs
  const numericFigures = extractNumericFigures(text);
  const { candidates: monetaryCandidates, stats: monetaryStats } = extractMonetaryCandidates(text, 160);

  console.log(`${logPrefix} Monetary candidates: scanned=${monetaryStats.scanned} emitted=${monetaryStats.emitted} filtered=${monetaryStats.filtered}. Calling LLM for selection...`);
  const llmExposure = await selectMonetaryExposureWithLLM(monetaryCandidates);

  const totalExposureValue = llmExposure?.totalPotentialLoss || 0;
  const financialExposure = totalExposureValue > 0 ? formatNumber(totalExposureValue) : 'Not mentioned in the contract';
  const exposureSource = llmExposure ? 'llm-monetary-sum' : 'none';
  console.log(`${logPrefix} Monetary analysis complete. Exposure: ${financialExposure}`);

  const riskSignals = extractRiskSignals(text);
  const terminationMatch = riskSignals.hasTerminationForConvenience ? 'High' : 'Low';

  const clauseCount = countContractClauses(text);

  // Generate dynamic PM insights via OpenRouter RAG. A failed/malformed AI
  // call no longer fails the whole analysis — it degrades to safe defaults
  // and is surfaced via analysisWarnings so the other sections still render.
  const analysisWarnings = [];

  // Phase 2: surface hallucinated/ungrounded monetary items rejected before
  // they could skew totalPotentialLoss/lgdScore.
  const monetaryGrounding = llmExposure?.grounding || { total: 0, grounded: 0, dropped: 0, rate: 1 };
  if (monetaryGrounding.dropped > 0) {
    analysisWarnings.push(`${monetaryGrounding.dropped} monetary figure(s) from the AI were rejected (not found in source text).`);
  }

  // Phase 1: which retrieval mode fed the RAG calls (additive field — the
  // frontend ignores it; the Phase 4 eval harness will read it).
  const retrievalMode = contract.index
    ? (contract.index.embeddings ? 'hybrid' : 'bm25-only')
    : 'keyword-fallback';
  if (retrievalMode !== 'hybrid') {
    analysisWarnings.push(`Retrieval degraded to ${retrievalMode} mode (embedding index unavailable).`);
  }

  console.log(`${logPrefix} Requesting PM insights...`);
  const pmInsightsRaw = await generatePMInsightsWithRAG(text, contract);
  let pmInsights;
  if (pmInsightsRaw) {
    const pmVerified = verifyPMInsights(pmInsightsRaw, text);
    pmInsights = pmVerified.insights;
    if (pmVerified.droppedCount > 0) {
      analysisWarnings.push(`${pmVerified.droppedCount} PM item(s) removed (quote not found in contract).`);
    }
  } else {
    pmInsights = getFallbackPMInsights();
    analysisWarnings.push('PM insights unavailable (AI call failed).');
  }
  console.log(`${logPrefix} PM insights ${pmInsightsRaw ? 'received' : 'unavailable — using fallback'}.`);

  // Generate dynamic Legal insights via OpenRouter RAG
  console.log(`${logPrefix} Requesting Legal insights...`);
  const legalInsightsRaw = await generateLegalInsightsWithRAG(text, contract);
  let legalInsights;
  if (legalInsightsRaw) {
    const legalVerified = verifyLegalInsights(legalInsightsRaw, text);
    legalInsights = legalVerified.insights;
    if (legalVerified.droppedCount > 0) {
      analysisWarnings.push(`${legalVerified.droppedCount} Legal item(s) removed (quote not found in contract).`);
    }
  } else {
    legalInsights = getFallbackLegalInsights();
    analysisWarnings.push('Legal insights unavailable (AI call failed).');
  }
  console.log(`${logPrefix} Legal insights ${legalInsightsRaw ? 'received' : 'unavailable — using fallback'}.`);

  console.log(`${logPrefix} Finalizing scoring and report assembly...`);
  const parsedComplianceScore = Number(legalInsights.complianceScore);
  // No fabricated fallback score — when the Legal LLM didn't provide one,
  // the honest answer is "not determined", not a guessed 84/64.
  const complianceScore = Number.isFinite(parsedComplianceScore) ? parsedComplianceScore : null;
  const normalizedOverallRisk = normalizeRiskLevel(legalInsights.overallRisk);

  const lgdScore = computeLossGivenDefaultScore({
    totalPotentialLoss: llmExposure?.totalPotentialLoss || 0,
    totalAmountOwed: llmExposure?.totalAmountOwed || 0
  });

  const overallRisk = normalizedOverallRisk || (lgdScore === null ? null : deriveRiskLevelFromScore(lgdScore));

  const baseAnalysis = {
    contractId: contract.id,
    contractName: contract.name,
    generatedAt: new Date().toISOString(),
    analysisWarnings,
    retrieval: {
      mode: retrievalMode,
      chunkCount: contract.index ? contract.index.chunks.length : 0
    },
    calculations: {
      exposure: {
        formula: 'sum(verified currency amounts categorized as risks; rates and insurance minimums excluded)',
        items: (llmExposure?.risks || []).map((r) => ({
          raw: r.raw,
          amount: r.amount,
          sourceOffset: r.sourceOffset,
          possibleDuplicate: !!r.possibleDuplicate,
          hasCurrencyMarker: !!r.hasCurrencyMarker
        })),
        total: totalExposureValue,
        excludedFromSums: llmExposure?.excludedFromSums || 0
      },
      lgd: {
        formula: 'totalPotentialLoss ÷ largest verified obligation (contract-value proxy) × 100',
        totalPotentialLoss: llmExposure?.totalPotentialLoss || 0,
        totalAmountOwed: llmExposure?.totalAmountOwed ?? null,
        basis: llmExposure?.lgdBasis || null,
        rawPct: (llmExposure?.totalAmountOwed)
          ? (llmExposure.totalPotentialLoss / llmExposure.totalAmountOwed) * 100
          : null,
        result: lgdScore
      },
      grounding: monetaryGrounding
    },
    overallRisk,
    lgdScore,
    complianceScore,
    financialExposure,
    riskExplanation: llmExposure?.riskExplanation || '',
    llmComments: llmExposure?.comments || '',
    numericFigures: {
      ...numericFigures,
      totalExposureValue,
      totalPotentialLoss: llmExposure?.totalPotentialLoss || 0,
      totalAmountOwed: llmExposure?.totalAmountOwed ?? null,
      exposureSource,
      risks: llmExposure?.risks || [],
      obligations: llmExposure?.obligations || [],
      rates: llmExposure?.rates || [],
      insuranceRequirements: llmExposure?.insuranceRequirements || []
    },
    riskFactors: [
      {
        id: 1,
        section: 'Termination',
        title: 'Termination for Convenience',
        risk: terminationMatch,
        source: 'keyword-scan',
        description: terminationMatch === 'High'
          ? 'Termination-for-convenience wording was detected by keyword scan.'
          : 'No termination-for-convenience wording detected by keyword scan — verify manually.'
      },
      {
        id: 2,
        section: 'Liability',
        title: riskSignals.hasUncappedLiability ? 'Uncapped Liability Exposure' : 'Liability Cap Clarity',
        risk: riskSignals.hasUncappedLiability ? 'High' : (riskSignals.hasLiabilityCap ? 'Low' : 'Medium'),
        source: 'keyword-scan',
        description: riskSignals.hasUncappedLiability
          ? 'Language suggests liability may be uncapped or unlimited (keyword scan).'
          : (riskSignals.hasLiabilityCap
            ? 'Liability cap language was detected by keyword scan.'
            : 'No liability cap language detected by keyword scan; exposure may be ambiguous.'),
        ...(totalExposureValue > 0 ? { financialImpact: financialExposure } : {})
      },
      {
        id: 3,
        section: 'Data Protection',
        title: 'Data Protection Commitments',
        risk: riskSignals.hasDataProtection ? 'Low' : 'Medium',
        source: 'keyword-scan',
        description: riskSignals.hasDataProtection
          ? 'Data protection or privacy obligations were detected by keyword scan.'
          : 'No data protection language detected by keyword scan; verify compliance obligations manually.'
      },
      {
        id: 4,
        section: 'Commercial Terms',
        title: 'Payment Terms Specificity',
        risk: riskSignals.hasPaymentTerms ? 'Low' : 'Medium',
        source: 'keyword-scan',
        description: riskSignals.hasPaymentTerms
          ? 'Payment terms were detected by keyword scan.'
          : 'No payment terms detected by keyword scan; confirm invoicing and timing manually.'
      }
    ],
    clauses: clauseCount?.total ?? null,
    totalClauses: clauseCount?.total ?? null,
    clauseCountLevel: clauseCount?.level || null,
    enforceabilityRisks: legalInsights.enforceabilityRisks || getFallbackLegalInsights().enforceabilityRisks,
    complianceChecks: legalInsights.complianceChecks || getFallbackLegalInsights().complianceChecks,
    jurisdiction: legalInsights.jurisdiction || getFallbackLegalInsights().jurisdiction,
    deliverables: pmInsights.deliverables || getFallbackPMInsights().deliverables,
    ipRights: pmInsights.ipRights || getFallbackPMInsights().ipRights,
    timelines: pmInsights.timelines || getFallbackPMInsights().timelines,
    actionItems: pmInsights.actionItems || getFallbackPMInsights().actionItems
  };

  return baseAnalysis;
}

// ---------------------------------------------------------------------------
// Phase 3: chat history, plain-text answer protocol, and citation verification
// ---------------------------------------------------------------------------

const CHAT_HISTORY_MAX_TURNS = 8;
const CHAT_HISTORY_MAX_CHARS = 2000;

function isErrorAssistantContent(content) {
  return content.startsWith('ERROR:') || content.startsWith('Sorry, I encountered an error');
}

// Never trusts the client: validates shape, drops malformed/error turns,
// truncates per-turn length, and caps total turns — independent of whatever
// filtering the frontend already does before sending.
function sanitizeChatHistory(history) {
  if (!Array.isArray(history)) return [];
  const cleaned = [];
  for (const turn of history) {
    if (!turn || typeof turn !== 'object') continue;
    const { role, content } = turn;
    if (role !== 'user' && role !== 'assistant') continue;
    if (typeof content !== 'string' || content.length === 0) continue;
    if (role === 'assistant' && isErrorAssistantContent(content)) continue;
    cleaned.push({ role, content: content.slice(0, CHAT_HISTORY_MAX_CHARS) });
  }
  return cleaned.slice(-CHAT_HISTORY_MAX_TURNS);
}

const CHAT_SYSTEM_PROMPT = `You are a contract analysis assistant. Use ONLY the provided contract excerpts to answer the user's question, in natural, conversational plain text — not JSON, not markdown code fences.

If the excerpts do not contain an answer, say so explicitly rather than guessing.

Respond in exactly this layout:

<your plain-text answer>

SOURCES:
- "<short verbatim quote from the excerpts>"
- "<another quote>"

IMPLICATIONS:
- <one-line practical implication>

The SOURCES and IMPLICATIONS sections are optional — omit either one entirely if it doesn't apply. Every quote under SOURCES must be an exact, verbatim substring of the excerpts provided; do not paraphrase or invent quotes.`;

// Shared by both /api/chat and /api/chat/stream so their prompts (and
// therefore their answers) never drift apart. Retrieval query blends the
// last user turn with the current message — a bare follow-up like "is that
// normal?" has no referent on its own, so retrieval on it alone would fail.
async function buildChatMessages(message, contract, role, rawHistory) {
  const text = contract.text || 'No text found in contract.';
  const question = String(message || '').trim();
  const history = sanitizeChatHistory(rawHistory);

  const lastUserTurn = [...history].reverse().find((h) => h.role === 'user');
  const retrievalQuery = lastUserTurn ? `${lastUserTurn.content} ${question}`.trim() : question;
  console.log(`[chat] history: ${history.length} turn(s) | retrieval query: "${retrievalQuery}"`);

  const { chunks: contextChunks } = await buildRelevantContext(text, retrievalQuery, 4, contract);
  const contextBlock = contextChunks.map((c, idx) => `Excerpt ${idx + 1}:\n${c.chunk}`).join('\n\n');

  const messages = [
    { role: 'system', content: CHAT_SYSTEM_PROMPT },
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: `Role perspective: ${role || contract.role || 'All'}\nQuestion: ${question}\n\nContract Excerpts:\n${contextBlock}` }
  ];

  return { messages, text, question };
}

const SOURCES_HEADER_REGEX = /^SOURCES:\s*$/im;
const IMPLICATIONS_HEADER_REGEX = /^IMPLICATIONS:\s*$/im;

function stripBulletPrefix(line) {
  return line.replace(/^[\s]*[-*•]\s*/, '').trim();
}

function stripSurroundingQuotes(str) {
  const trimmed = str.trim();
  const quotePairs = [['"', '"'], ["'", "'"], ['“', '”'], ['‘', '’']];
  for (const [open, close] of quotePairs) {
    if (trimmed.length >= 2 && trimmed.startsWith(open) && trimmed.endsWith(close)) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

function extractBulletLines(blockText) {
  return blockText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[-*•]/.test(l))
    .map(stripBulletPrefix)
    .map(stripSurroundingQuotes)
    .filter((l) => l.length > 0);
}

// Tolerant parser for the plain-text chat protocol — never throws. Sections
// are matched case-insensitively and may appear in either order; malformed
// or missing sections just yield empty arrays rather than an error.
function parseChatAnswer(rawText) {
  const text = String(rawText || '');
  const sourcesMatch = SOURCES_HEADER_REGEX.exec(text);
  const implicationsMatch = IMPLICATIONS_HEADER_REGEX.exec(text);

  const sectionStarts = [sourcesMatch?.index, implicationsMatch?.index].filter((i) => typeof i === 'number');
  const contentEnd = sectionStarts.length > 0 ? Math.min(...sectionStarts) : text.length;
  const content = text.slice(0, contentEnd).trim();

  let quotes = [];
  let implications = [];

  if (sourcesMatch) {
    const start = sourcesMatch.index + sourcesMatch[0].length;
    const end = (implicationsMatch && implicationsMatch.index > sourcesMatch.index) ? implicationsMatch.index : text.length;
    quotes = extractBulletLines(text.slice(start, end));
  }

  if (implicationsMatch) {
    const start = implicationsMatch.index + implicationsMatch[0].length;
    const end = (sourcesMatch && sourcesMatch.index > implicationsMatch.index) ? sourcesMatch.index : text.length;
    implications = extractBulletLines(text.slice(start, end));
  }

  return { content, quotes, implications };
}

// Normalizes for quote matching: lowercase, curly->straight quotes, collapse
// whitespace runs. PDF extraction mangles whitespace constantly, so this is
// the whole point of verification rather than a plain substring check.
function normalizeForQuoteMatch(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// Builds a normalized copy of `text` alongside a map from each normalized
// character's index back to its original index. Normalization here only
// lowercases, swaps quote characters 1:1, and collapses whitespace runs to a
// single space — it never inserts new characters — so this mapping is
// always well-defined.
function buildNormalizedOffsetMap(text) {
  let normalized = '';
  const offsetMap = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      if (normalized.length === 0 || normalized[normalized.length - 1] !== ' ') {
        normalized += ' ';
        offsetMap.push(i);
      }
      while (i < text.length && /\s/.test(text[i])) i++;
      continue;
    }
    let c = ch.toLowerCase();
    if (c === '“' || c === '”') c = '"';
    if (c === '‘' || c === '’') c = "'";
    normalized += c;
    offsetMap.push(i);
    i++;
  }
  return { normalized, offsetMap };
}

function findNormalizedOffset(quote, text) {
  const normalizedQuote = normalizeForQuoteMatch(quote);
  if (!normalizedQuote) return null;
  const { normalized, offsetMap } = buildNormalizedOffsetMap(text);
  const idx = normalized.indexOf(normalizedQuote);
  if (idx === -1) return null;
  return offsetMap[idx];
}

// → { offset } | null. Tries an exact (normalized) match first; models pad
// quote tails with plausible-sounding text, so a long quote (>=8 words) that
// fails whole gets one retry against just its first 8 words before being
// treated as unverifiable and dropped.
function verifyQuote(quote, text) {
  if (!quote || !text) return null;

  let offset = findNormalizedOffset(quote, text);
  if (offset !== null) return { offset };

  const words = String(quote).trim().split(/\s+/).filter(Boolean);
  if (words.length >= 8) {
    const prefix = words.slice(0, 8).join(' ');
    offset = findNormalizedOffset(prefix, text);
    if (offset !== null) return { offset };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Phase 5: Legal/PM RAG output verification — the free-tier LLM is told to
// cite a verbatim quote for every claim, but nothing previously checked that
// it actually did. These functions never trust the model's own "quote":
// every claim is checked against the source text with the same verifyQuote
// used for chat citations, and unverifiable content is dropped/downgraded
// rather than shown as if it were real.
// ---------------------------------------------------------------------------

const NOT_SPECIFIED = 'Not specified';
const NOT_MENTIONED = 'Not mentioned in the contract';

// A string field (jurisdiction.location, ipRights.customerData, etc.) is
// "verified" if it's the honest sentinel, or if it (or its paired quote)
// appears verbatim in the source text. Anything else becomes NOT_MENTIONED
// rather than being shown as fact.
function verifyStringField(value, text, quote) {
  if (!value || value === NOT_SPECIFIED) return NOT_SPECIFIED;
  if (verifyQuote(quote, text)) return value;
  if (verifyQuote(value, text)) return value;
  return NOT_MENTIONED;
}

// enforceabilityRisks make specific factual claims about the contract, so an
// item whose quote can't be verified is dropped outright (the safe failure
// mode is silence, not a fabricated-looking risk card). complianceChecks are
// a checklist widget — dropping items would silently shrink the checklist
// with no signal, so an unverifiable one is instead kept but downgraded to
// status "unverified" so the UI can flag it rather than show a fabricated
// pass/fail as if it were real.
function verifyLegalInsights(rawInsights, text) {
  const insights = rawInsights || {};
  let droppedCount = 0;

  const enforceabilityRisks = (Array.isArray(insights.enforceabilityRisks) ? insights.enforceabilityRisks : [])
    .map((risk) => {
      const verified = verifyQuote(risk?.quote, text);
      return verified ? { ...risk, quoteOffset: verified.offset } : null;
    })
    .filter((risk) => {
      if (risk) return true;
      droppedCount++;
      return false;
    });

  const complianceChecks = (Array.isArray(insights.complianceChecks) ? insights.complianceChecks : [])
    .map((check) => {
      const verified = verifyQuote(check?.quote, text);
      return verified
        ? { ...check, quoteOffset: verified.offset }
        : { ...check, status: 'unverified', note: `${check?.note || ''} (quote could not be verified against the contract text)`.trim() };
    });

  const rawJurisdiction = insights.jurisdiction || {};
  const jurisdiction = {
    location: verifyStringField(rawJurisdiction.location, text),
    governingLaw: verifyStringField(rawJurisdiction.governingLaw, text),
    notes: Array.isArray(rawJurisdiction.notes) ? rawJurisdiction.notes : []
  };

  return {
    insights: { ...insights, enforceabilityRisks, complianceChecks, jurisdiction },
    droppedCount
  };
}

// deliverables/timelines/actionItems make specific factual claims, so items
// with an unverifiable quote are dropped. ipRights strings are checked
// against their paired quote (or, failing that, the string itself) and fall
// back to NOT_MENTIONED rather than displaying an invented right.
function verifyPMInsights(rawInsights, text) {
  const insights = rawInsights || {};
  let droppedCount = 0;

  const verifyArray = (items) => (Array.isArray(items) ? items : [])
    .map((item) => {
      const verified = verifyQuote(item?.quote, text);
      return verified ? { ...item, quoteOffset: verified.offset } : null;
    })
    .filter((item) => {
      if (item) return true;
      droppedCount++;
      return false;
    });

  const deliverables = verifyArray(insights.deliverables);
  const timelines = verifyArray(insights.timelines);
  const actionItems = verifyArray(insights.actionItems);

  const rawIpRights = insights.ipRights || {};
  const rawQuotes = rawIpRights.quotes || {};
  const ipRights = {
    customerData: verifyStringField(rawIpRights.customerData, text, rawQuotes.customerData),
    saasSoftware: verifyStringField(rawIpRights.saasSoftware, text, rawQuotes.saasSoftware),
    usageRestrictions: verifyStringField(rawIpRights.usageRestrictions, text, rawQuotes.usageRestrictions)
  };

  return {
    insights: { ...insights, deliverables, timelines, actionItems, ipRights },
    droppedCount
  };
}

function finalizeChatAnswer(rawText, text, role, contract) {
  const parsed = parseChatAnswer(rawText);
  const citations = [];
  for (const quote of parsed.quotes) {
    const verified = verifyQuote(quote, text);
    if (verified) citations.push({ quote, offset: verified.offset });
  }
  return {
    role: 'assistant',
    content: parsed.content,
    perspective: role || contract.role || 'All',
    citations,
    implications: parsed.implications,
    timestamp: new Date().toISOString()
  };
}

function chatErrorMessage(content, role, contract) {
  return {
    role: 'assistant',
    content,
    perspective: role || contract.role || 'All',
    citations: [],
    implications: [],
    timestamp: new Date().toISOString()
  };
}

// Generate chat response dynamically based on text (non-streaming path).
async function generateChatResponse(message, contract, role, rawHistory) {
  if (LLM_PROVIDERS.length === 0) {
    return chatErrorMessage('ERROR: No LLM provider is configured. AI chat is unavailable.', role, contract);
  }

  const { messages, text } = await buildChatMessages(message, contract, role, rawHistory);
  const raw = await callOpenRouter(messages, { expectJson: false, retries: 1 });

  if (!raw) {
    return chatErrorMessage('ERROR: The AI service failed to produce a usable response. Please check your API key/quota and try again.', role, contract);
  }

  return finalizeChatAnswer(raw, text, role, contract);
}

// Streaming counterpart used by /api/chat/stream. `onToken` fires per delta;
// the returned `message` (on success) is the same final shape as
// generateChatResponse's return value, built once streaming completes.
async function generateChatResponseStream(message, contract, role, rawHistory, { onToken, signal } = {}) {
  if (LLM_PROVIDERS.length === 0) {
    return { failed: true, errorMessage: 'No LLM provider is configured. AI chat is unavailable.' };
  }

  const { messages, text } = await buildChatMessages(message, contract, role, rawHistory);
  const result = await callOpenRouterStream(messages, { onToken, retries: 1, signal });

  if (result.failed) {
    if (!result.beforeFirstToken) {
      console.warn('[chat-stream] Interrupted after tokens had already flowed.');
    }
    return {
      failed: true,
      errorMessage: result.beforeFirstToken
        ? 'The AI service failed to produce a usable response. Please check your API key/quota and try again.'
        : 'Response interrupted before completion.'
    };
  }

  return { message: finalizeChatAnswer(result.content, text, role, contract) };
}

// Serve the main HTML file for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// Phase 4: rehydrates the in-memory contracts/analyses Maps from SQLite at
// boot. Synchronous (better-sqlite3 is sync) so it completes before the
// server starts accepting connections — no race with the first request.
function hydrateFromDb() {
  const persistenceEnabled = db.init();
  if (!persistenceEnabled) {
    console.log('[boot] Persistence disabled (better-sqlite3 unavailable) — running memory-only.');
    return;
  }

  const { contracts: rows, analyses: analysisMap } = db.hydrateAll();
  for (const row of rows) {
    const contract = {
      id: row.id,
      name: row.name,
      fileName: row.fileName,
      originalName: row.originalName,
      filePath: row.filePath,
      fileSize: row.fileSize,
      uploadDate: row.uploadDate,
      status: row.status,
      role: row.role,
      text: row.text
    };

    // A contract stuck 'analyzing' means its in-flight promise died with the
    // previous process — there is no way to resume it, so this is the
    // honest state (the frontend's existing error toast already handles it).
    if (contract.status === 'analyzing') {
      contract.status = 'error';
    }

    if (row.filePath && !fs.existsSync(row.filePath)) {
      console.warn(`[boot] Contract ${contract.id} (${contract.name}) file missing on disk: ${row.filePath}`);
    }

    const chunkRows = db.getContractChunks(contract.id);
    if (chunkRows.length > 0) {
      const chunks = chunkRows.map((c) => ({ id: c.id, start: c.start, text: c.text }));
      const allEmbedded = chunkRows.every((c) => c.embedding !== null);
      contract.index = {
        chunks,
        embeddings: allEmbedded ? chunkRows.map((c) => c.embedding) : null,
        bm25: retrieval.buildBM25Index(chunks),
        textHash: row.textHash
      };
    }

    const versions = db.getVersions(contract.id);
    if (versions.length > 0) contract.versions = versions;

    const analysis = analysisMap.get(contract.id);
    if (analysis) {
      contract.analysis = analysis;
      analyses.set(contract.id, analysis);
    }

    contracts.set(contract.id, contract);
  }

  if (rows.length > 0) {
    console.log(`[boot] Hydrated ${rows.length} contract(s) from SQLite (indexes rebuilt from stored chunks, no re-embedding).`);
  }
}

// Start server (skipped when required as a module, e.g. by test-calculations.js)
if (require.main === module) {
  hydrateFromDb();
  app.listen(PORT, () => {
    console.log(`Legal Counsel Analysis server running on http://localhost:${PORT}`);
    console.log(`Serving frontend from: ${path.join(__dirname, '../frontend')}`);
    // Warm the local embedding model so the first upload doesn't pay the
    // model-load latency. Non-blocking; failure degrades retrieval, never fatal.
    retrieval.warmupEmbedder();
  });
}

module.exports = {
  app,
  parseNumericAmount,
  extractMonetaryCandidates,
  verifyMonetaryItems,
  computeLossGivenDefaultScore,
  clampScore,
  normalizeRiskLevel,
  // Phase 3: chat history, plain-text answer parsing, and citation verification
  sanitizeChatHistory,
  parseChatAnswer,
  verifyQuote,
  parseSseChunk,
  normalizeForQuoteMatch,
  generateChatResponse,
  // Phase 4: eval harness needs the actual Phase 0/2 code paths, not
  // reimplementations, so the mode comparison and grounding checks are real.
  chunkText,
  scoreChunkByKeywords,
  extractChatKeywords,
  selectMonetaryExposureWithLLM,
  // Phase 5: honest-data verification/reclassification, unit-testable in isolation
  reclassifyMonetaryItems,
  isSumEligible,
  countContractClauses,
  verifyLegalInsights,
  verifyPMInsights,
  extractRiskSignals
};
