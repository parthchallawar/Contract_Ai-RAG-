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
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
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
    console.log(`[${new Date().toISOString()}] Contract ${contractId} (${contract.name}) uploaded. Starting processing...`);

    // Run real analysis asynchronously
    extractTextFromFile(contract.filePath).then(async (text) => {
      console.log(`[${new Date().toISOString()}] Text extraction complete for ${contract.name}. Characters: ${text.length}`);
      contract.text = text;
      await ensureContractIndex(contract, text);

      console.log(`[${new Date().toISOString()}] Starting AI analysis for ${contract.name}...`);
      const analysis = await analyzeDocumentText(text, contract);
      
      contract.status = 'completed';
      contract.analysis = analysis;
      analyses.set(contractId, analysis);
      console.log(`[${new Date().toISOString()}] Analysis completed successfully for ${contract.name}.`);
    }).catch(err => {
      console.error(`[${new Date().toISOString()}] Processing failed for ${contract.name}:`, err);
      contract.status = 'error';
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
    contract.versions.push({
      version: contract.versions.length + 1,
      name: contract.name,
      fileName: contract.fileName,
      originalName: contract.originalName,
      filePath: contract.filePath,
      fileSize: contract.fileSize,
      uploadDate: contract.uploadDate,
      analysis: contract.analysis
    });

    // Update with new file data
    contract.fileName = req.file.filename;
    contract.originalName = req.file.originalname;
    contract.filePath = req.file.path;
    contract.fileSize = req.file.size;
    contract.uploadDate = new Date().toISOString();
    contract.status = 'analyzing';

    const currentRole = req.body.role || contract.role;
    console.log(`[${new Date().toISOString()}] New version uploaded for ${contract.name}. Processing...`);

    // Run real analysis asynchronously
    extractTextFromFile(contract.filePath).then(async (text) => {
      console.log(`[${new Date().toISOString()}] Version update: Text extracted for ${contract.name}.`);
      contract.text = text;
      await ensureContractIndex(contract, text);
      // Re-run analysis logic over new text
      const analysis = await analyzeDocumentText(text, contract);
      contract.status = 'completed';
      contract.analysis = analysis;
      analyses.set(contract.id, analysis);
      console.log(`[${new Date().toISOString()}] Version update completed for ${contract.name}.`);
    }).catch(err => {
      console.error(`[${new Date().toISOString()}] Version update failed for ${contract.name}:`, err);
      contract.status = 'error';
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
  console.log(`[${new Date().toISOString()}] Role updated to ${role} for ${contract.name}. Re-triggering analysis...`);

  // Run real analysis asynchronously
  extractTextFromFile(contract.filePath).then(async (text) => {
    console.log(`[${new Date().toISOString()}] Re-analysis: Text extracted for ${contract.name}.`);
    contract.text = text;
    await ensureContractIndex(contract, text);
    const analysis = await analyzeDocumentText(text, contract);
    contract.status = 'completed';
    contract.analysis = analysis;
    analyses.set(req.params.id, analysis);
    console.log(`[${new Date().toISOString()}] Re-analysis completed for ${contract.name}.`);
  }).catch(err => {
    console.error(`[${new Date().toISOString()}] Re-analysis failed for ${contract.name}:`, err);
    contract.status = 'error';
  });

  res.json({ id: contract.id, role: contract.role, status: contract.status });
});

// Delete a contract
app.delete('/api/contracts/:id', (req, res) => {
  const contract = contracts.get(req.params.id);
  if (!contract) {
    return res.status(404).json({ error: 'Contract not found' });
  }

  // Delete file from filesystem
  if (fs.existsSync(contract.filePath)) {
    fs.unlinkSync(contract.filePath);
  }

  contracts.delete(req.params.id);
  analyses.delete(req.params.id);

  res.json({ message: 'Contract deleted successfully' });
});

// Chat endpoint for AI assistant
app.post('/api/chat', async (req, res) => {
  const { contractId, message, role } = req.body;

  const contract = contracts.get(contractId);
  if (!contract) {
    return res.status(404).json({ error: 'Contract not found' });
  }

  const response = await generateChatResponse(message, contract, role);
  res.json(response);
});

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'nemotron-3-nano-30b-a3b:free';

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
    hasTerminationForConvenience: /termination for convenience/i.test(text),
    hasUncappedLiability: /(uncapped|unlimited)\s+liability|liability\s+(without|no)\s+cap/i.test(text),
    hasLiabilityCap: /liability cap|limitation of liability|cap on liability/i.test(text),
    hasIndemnification: /indemnif/i.test(text),
    hasDataProtection: /gdpr|ccpa|data protection|data processing|privacy/i.test(text),
    hasPaymentTerms: /payment terms|net\s?\d+|late fee|interest on late/i.test(text),
    hasIpOwnership: /intellectual property|ip ownership|ownership of ip|license|licensing/i.test(text)
  };
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

function computeLossGivenDefaultScore({ totalPotentialLoss, totalAmountOwed }) {
  if (!totalAmountOwed || totalAmountOwed <= 0) return 0;
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
    const start = Math.max(0, match.index - 70);
    const end = Math.min(normalizedText.length, match.index + raw.length + 70);
    const context = normalizedText.slice(start, end).replace(/\s+/g, ' ').trim();

    if (!hasCurrencySymbol) {
      if (isNonMonetaryArtifact(raw, match.index, normalizedText)) continue;
      if (!hasMoneyKeywordNearby(context)) continue;
    }

    candidates.push({ raw, context, index: match.index });
    if (candidates.length >= limit) break;
  }

  return {
    candidates,
    stats: { scanned, emitted: candidates.length, filtered: scanned - candidates.length }
  };
}

// ---------------------------------------------------------------------------
// Single OpenRouter call helper: timeout, retry-with-backoff, and JSON mode
// with automatic fallback for models that reject `response_format`.
// ---------------------------------------------------------------------------

// Once we learn the configured model rejects response_format:json_object,
// stop trying it on subsequent calls (avoids wasting a request per call).
let jsonModeUnsupported = false;

async function callOpenRouter(messages, { expectJson = true, retries = 1, timeoutMs = 90000 } = {}) {
  if (!OPENROUTER_API_KEY) return null;

  const attemptOnce = async (useJsonMode) => {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const body = { model: OPENROUTER_MODEL, messages };
      if (useJsonMode) {
        body.response_format = { type: 'json_object' };
      }

      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        // JSON mode itself might be rejected (4xx) by a model that doesn't
        // support it — signal the caller to immediately retry without it,
        // rather than burning a retry attempt on a doomed request shape.
        if (useJsonMode && response.status >= 400 && response.status < 500) {
          return { unsupported: true };
        }
        console.error(`OpenRouter error: ${response.status} ${response.statusText}`, errorText);
        return { failed: true };
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content || '';
      if (!content) return { failed: true };
      return { content };
    } catch (error) {
      if (error.name === 'AbortError') {
        console.error(`OpenRouter call timed out after ${timeoutMs}ms`);
      } else {
        console.error('OpenRouter call error:', error);
      }
      return { failed: true };
    } finally {
      clearTimeout(timeoutHandle);
    }
  };

  const maxAttempts = retries + 1;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let result = await attemptOnce(expectJson && !jsonModeUnsupported);

    if (result.unsupported) {
      jsonModeUnsupported = true;
      result = await attemptOnce(false);
    }

    if (result.content) {
      if (!expectJson) return result.content;
      const parsed = parseJsonResponse(result.content, null);
      if (parsed) return parsed;
      // Malformed JSON from the model — fall through to retry below.
    }

    if (attempt < maxAttempts - 1) {
      await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
    }
  }

  return null;
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
    grounded.push({ ...item, sourceContext: candidate.context, sourceOffset: candidate.index });
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

// → { risks, obligations, droppedRisks, droppedObligations, grounding }
// Risks and obligations are verified against `candidates` independently —
// a candidate consumed by a risk item can still ground an obligation item.
function verifyMonetaryItems(parsed, candidates) {
  const risksResult = verifyMonetaryItemCategory(Array.isArray(parsed?.risks) ? parsed.risks : [], candidates);
  const obligationsResult = verifyMonetaryItemCategory(Array.isArray(parsed?.obligations) ? parsed.obligations : [], candidates);

  const total = risksResult.grounded.length + risksResult.dropped.length
    + obligationsResult.grounded.length + obligationsResult.dropped.length;
  const grounded = risksResult.grounded.length + obligationsResult.grounded.length;
  const dropped = risksResult.dropped.length + obligationsResult.dropped.length;

  return {
    risks: risksResult.grounded,
    obligations: obligationsResult.grounded,
    droppedRisks: risksResult.dropped,
    droppedObligations: obligationsResult.dropped,
    grounding: { total, grounded, dropped, rate: total === 0 ? 1 : grounded / total }
  };
}

async function selectMonetaryExposureWithLLM(candidates) {
  if (!OPENROUTER_API_KEY) return null;
  if (!Array.isArray(candidates) || candidates.length === 0) return null;

  const systemPrompt = `You are a contract analyst specialized in financial risk. 
From the provided list of numeric candidates with context, identify EVERY individual monetary amount mentioned.

Categorize them into:
1. "risks": Liability caps, penalties, indemnification limits, or potential damages.
2. "obligations": Contract price, principal fees, recurring payments, or total consideration.

Exclude dates, IDs, and non-monetary figures.
Return strictly valid JSON:
{
  "risks": [ { "raw": "...", "amount": <number>, "reason": "...", "riskLevel": "Low|Medium|High" } ],
  "obligations": [ { "raw": "...", "amount": <number>, "reason": "..." } ],
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
    const droppedDetail = [...verified.droppedRisks, ...verified.droppedObligations]
      .map((d) => `${d.raw} (${d.reason})`).join(', ');
    console.warn(`[monetary] Dropped ${verified.grounding.dropped} ungrounded item(s): ${droppedDetail}`);
  }

  const totalPotentialLoss = verified.risks.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
  const totalAmountOwed = verified.obligations.reduce((sum, o) => sum + (Number(o.amount) || 0), 0);

  return {
    totalPotentialLoss,
    totalAmountOwed,
    risks: verified.risks,
    obligations: verified.obligations,
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
    if (!OPENROUTER_API_KEY) {
      console.error("CRITICAL: No OPENROUTER_API_KEY found. PM analysis cannot proceed.");
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
  "deliverables": [ { "name": "...", "status": "PENDING|IN PROGRESS|COMPLETED", "due": "...", "progress": 0 } ],
  "ipRights": { "customerData": "...", "saasSoftware": "...", "usageRestrictions": "..." },
  "timelines": [ { "event": "...", "date": "..." } ],
  "actionItems": [ { "task": "...", "assigned": "..." } ]
}
If no information is found for a field, make an educated guess or leave strings as "Not specified". Only output the raw JSON object. Do NOT use markdown code blocks (\`\`\`).`;

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
    if (!OPENROUTER_API_KEY) {
      console.error("CRITICAL: No OPENROUTER_API_KEY found. Legal analysis cannot proceed.");
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
For "quote", you MUST extract an EXACT, verbatim, short substring from the text that proves your analysis. If you make it up, you fail.
If no information is found for a field, make an educated guess. Only output the raw JSON object. Do NOT use markdown code blocks (\`\`\`).`;

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
  const financialExposure = totalExposureValue > 0 ? formatNumber(totalExposureValue) : 'Not specified';
  const exposureSource = llmExposure ? 'llm-monetary-sum' : 'none';
  console.log(`${logPrefix} Monetary analysis complete. Exposure: ${financialExposure}`);

  const riskSignals = extractRiskSignals(text);
  const terminationMatch = riskSignals.hasTerminationForConvenience ? 'High' : 'Low';
  const liabilityMatch = riskSignals.hasLiabilityCap ? 'High' : 'Medium';
  const gdprMatch = riskSignals.hasDataProtection ? 'pass' : 'warning';

  const snippets = text.split('\n').filter(l => l.length > 20).slice(0, 10);

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
  const pmInsights = pmInsightsRaw || getFallbackPMInsights();
  if (!pmInsightsRaw) analysisWarnings.push('PM insights unavailable (AI call failed).');
  console.log(`${logPrefix} PM insights ${pmInsightsRaw ? 'received' : 'unavailable — using fallback'}.`);

  // Generate dynamic Legal insights via OpenRouter RAG
  console.log(`${logPrefix} Requesting Legal insights...`);
  const legalInsightsRaw = await generateLegalInsightsWithRAG(text, contract);
  const legalInsights = legalInsightsRaw || getFallbackLegalInsights();
  if (!legalInsightsRaw) analysisWarnings.push('Legal insights unavailable (AI call failed).');
  console.log(`${logPrefix} Legal insights ${legalInsightsRaw ? 'received' : 'unavailable — using fallback'}.`);

  console.log(`${logPrefix} Finalizing scoring and report assembly...`);
  const parsedComplianceScore = Number(legalInsights.complianceScore);
  const complianceScore = Number.isFinite(parsedComplianceScore)
    ? parsedComplianceScore
    : (gdprMatch === 'pass' ? 84 : 64);
  const normalizedOverallRisk = normalizeRiskLevel(legalInsights.overallRisk);
  
  const lgdScore = computeLossGivenDefaultScore({
    totalPotentialLoss: llmExposure?.totalPotentialLoss || 0,
    totalAmountOwed: llmExposure?.totalAmountOwed || 0
  });

  const overallRisk = normalizedOverallRisk || deriveRiskLevelFromScore(lgdScore);

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
        formula: 'sum(grounded risk amounts)',
        items: (llmExposure?.risks || []).map((r) => ({
          raw: r.raw,
          amount: r.amount,
          sourceOffset: r.sourceOffset,
          possibleDuplicate: !!r.possibleDuplicate
        })),
        total: totalExposureValue
      },
      lgd: {
        formula: 'totalPotentialLoss / totalAmountOwed × 100, clamped 0–100',
        totalPotentialLoss: llmExposure?.totalPotentialLoss || 0,
        totalAmountOwed: llmExposure?.totalAmountOwed || 0,
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
    riskExplanation: llmExposure?.riskExplanation || 'Analysis based on contract context and detected risks.',
    llmComments: llmExposure?.comments || '',
    ltvImpact: '-4.2%',
    investorCompliance: '88%',
    numericFigures: {
      ...numericFigures,
      totalExposureValue,
      totalPotentialLoss: llmExposure?.totalPotentialLoss || 0,
      totalAmountOwed: llmExposure?.totalAmountOwed || 0,
      exposureSource,
      risks: llmExposure?.risks || [],
      obligations: llmExposure?.obligations || []
    },
    riskFactors: [
      {
        id: 1,
        section: 'Termination',
        title: 'Termination for Convenience',
        risk: terminationMatch,
        description: terminationMatch === 'High'
          ? 'Found explicit mention of termination for convenience in the contract.'
          : 'No explicit termination for convenience language surfaced in the text.',
        financialImpact: 'Varies'
      },
      {
        id: 2,
        section: 'Liability',
        title: riskSignals.hasUncappedLiability ? 'Uncapped Liability Exposure' : 'Liability Cap Clarity',
        risk: riskSignals.hasUncappedLiability ? 'High' : (riskSignals.hasLiabilityCap ? 'Low' : 'Medium'),
        description: riskSignals.hasUncappedLiability
          ? 'Language suggests liability may be uncapped or unlimited.'
          : (riskSignals.hasLiabilityCap
            ? 'Liability cap language appears in the contract.'
            : 'No clear liability cap language found; exposure may be ambiguous.'),
        financialImpact: financialExposure
      },
      {
        id: 3,
        section: 'Data Protection',
        title: 'Data Protection Commitments',
        risk: riskSignals.hasDataProtection ? 'Low' : 'Medium',
        description: riskSignals.hasDataProtection
          ? 'Data protection or privacy obligations appear in the contract.'
          : 'Data protection language is not clearly stated; verify compliance obligations.',
        financialImpact: 'Regulatory exposure'
      },
      {
        id: 4,
        section: 'Commercial Terms',
        title: 'Payment Terms Specificity',
        risk: riskSignals.hasPaymentTerms ? 'Low' : 'Medium',
        description: riskSignals.hasPaymentTerms
          ? 'Payment terms are referenced in the contract.'
          : 'Payment terms are not clearly specified; confirm invoicing and timing.',
        financialImpact: 'Cash flow risk'
      }
    ],
    marketBenchmark: {
      matchPercentage: 62,
      note: 'Analysis generated dynamically by parsing ' + text.length + ' chars of text.'
    },
    clauses: 12,
    totalClauses: snippets.length > 5 ? snippets.length : 14,
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

// Generate chat response dynamically based on text
async function generateChatResponse(message, contract, role) {
  const text = contract.text || 'No text found in contract.';
  const question = String(message || '').trim();
  const { chunks: contextChunks } = await buildRelevantContext(text, question, 4, contract);

  if (!OPENROUTER_API_KEY) {
    return {
      role: 'assistant',
      content: 'ERROR: OpenRouter API key is not configured. AI chat is unavailable.',
      perspective: role || contract.role || 'All',
      citations: [],
      implications: [],
      timestamp: new Date().toISOString()
    };
  }

  const contextBlock = contextChunks
    .map((chunk, idx) => `Excerpt ${idx + 1}:\n${chunk.chunk}`)
    .join('\n\n');
  const systemPrompt = `You are a contract analysis assistant.
Use ONLY the provided excerpts to answer the user's question. If the excerpts do not contain an answer, say so explicitly.
Return strictly valid JSON with this schema:
{
  "content": "...",
  "citations": ["Excerpt 1: <short exact quote>", "Excerpt 2: <short exact quote>"],
  "implications": ["...", "..."]
}
Make sure citations contain verbatim quotes from the excerpts. Do NOT use markdown fences.`;

  const parsed = await callOpenRouter([
    { role: "system", content: systemPrompt },
    { role: "user", content: `Role perspective: ${role || contract.role || 'All'}\nQuestion: ${question}\n\nContract Excerpts:\n${contextBlock}` }
  ], { expectJson: true, retries: 1 });

  if (!parsed || typeof parsed.content !== 'string') {
    return {
      role: 'assistant',
      content: 'ERROR: The AI service failed to produce a usable response. Please check your API key/quota and try again.',
      perspective: role || contract.role || 'All',
      citations: [],
      implications: [],
      timestamp: new Date().toISOString()
    };
  }

  return {
    role: 'assistant',
    content: parsed.content,
    perspective: role || contract.role || 'All',
    citations: Array.isArray(parsed.citations) ? parsed.citations : [],
    implications: Array.isArray(parsed.implications) ? parsed.implications : [],
    timestamp: new Date().toISOString()
  };
}

// Serve the main HTML file for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// Start server (skipped when required as a module, e.g. by test-calculations.js)
if (require.main === module) {
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
  normalizeRiskLevel
};
