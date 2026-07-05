# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An AI-powered contract analysis web app with a real hybrid-retrieval RAG pipeline (local
embeddings + BM25, fused with Reciprocal Rank Fusion), verified numeric grounding, streaming
chat with conversation memory and verified citations, and SQLite persistence. A user uploads a
contract (PDF/DOCX/DOC/TXT), the backend extracts and indexes the text and runs it through an
LLM (via OpenRouter) to produce **role-specific** analysis, and a single-page vanilla-JS frontend
renders that analysis in five perspectives: Upload, Investor, Legal, PM, Partner, plus a
role-aware, citation-verified AI Chat.

`README.md` and `ARCHITECTURE.md` are current as of the last phase (persistence + eval harness).
`QUICKSTART.md` and `IMPLEMENTATION_SUMMARY.md` are superseded stubs pointing at `README.md` —
don't add new content to them.

## Commands

All backend commands run from the `backend/` directory:

```bash
cd backend
npm install             # installs deps incl. @xenova/transformers, better-sqlite3
cp .env.example .env    # then edit .env and add OPENROUTER_API_KEY
npm start                # node server.js  -> http://localhost:8080
npm run dev              # nodemon server.js (auto-reload)
npm test                 # test-retrieval.js + test-calculations.js + test-chat-parse.js (deterministic, no network)
npm run eval              # backend/eval/run-eval.js — retrieval hit-rate/MRR, offline, ~1s
npm run eval:llm          # + numeric grounding + chat citation checks (uses OpenRouter, non-deterministic)
```

- **Config**: `backend/.env` (loaded via `dotenv`, copy from `backend/.env.example`). Keys:
  `OPENROUTER_API_KEY` (required for any AI output — chat/analysis degrade to error messages
  without it, they don't crash), `OPENROUTER_MODEL` (default `nemotron-3-nano-30b-a3b:free` —
  free-tier, 50 req/day, noticeably flakier structured output than a paid model), optionally
  `NIM_API_KEY`+`NIM_MODEL` (NVIDIA NIM as an automatic fallback provider — see `LLM_PROVIDERS`
  in `server.js`; OpenRouter is always tried first, NIM only kicks in if OpenRouter fails before
  producing any content, e.g. its daily quota is exhausted), `PORT` (default 8080).
- **Health check**: `curl http://localhost:8080/api/health` → includes `persistence: 'enabled'|'disabled'`.
- **Root `package.json`** is now just a repo-root placeholder (no deps) — all real deps live in `backend/`.

## Architecture

See `ARCHITECTURE.md` for the deep dive (data flow, RRF/BM25 math, DB schema). Summary:

### Backend — `backend/server.js` (single file, chat/analysis/persistence routes) + `backend/retrieval.js` + `backend/db.js`

Express server that also serves the frontend statically and falls back to `index.html` for SPA
routing. **In-memory `Map`s (`contracts`, `analyses`) are still the runtime read path**; every
mutation also write-throughs to SQLite (`backend/db.js`, `better-sqlite3`, WAL mode) so state
survives a restart. If `better-sqlite3` fails to load, `db.js`'s functions become no-ops and the
app runs memory-only — it must never fail to start because of the database.

On upload (and on role change / new version), processing runs **asynchronously after the HTTP
response returns** — the contract is created with `status: 'analyzing'`, and the frontend polls
`/api/contracts/:id/analysis` (returns HTTP 202 while pending) until `status: 'completed'` (or
`'error'`). Flow:

1. `extractTextFromFile()` — `pdf-parse` (custom `pagerender`), `mammoth`, or raw read, all
   through `normalizeNumericSpacing()` (PDF extraction mangles `$1,000` into `$1 000`; numeric
   code re-collapses `(\d)\s+(?=\d)` in several places).
2. `ensureContractIndex()` — clause-aware `chunkText()` (headings/paragraphs first, sentence
   fallback, never mid-sentence), then `retrieval.buildContractIndex()`: BM25 posting +
   local MiniLM embeddings (`Xenova/all-MiniLM-L6-v2`, null on embedder failure). Skipped if
   `sha256(text)` is unchanged from last time (role switches re-extract the same file).
3. `analyzeDocumentText(text, contract)` orchestrates three LLM calls into ONE flat
   `baseAnalysis` object (investor/legal/PM fields all together — the frontend picks what it
   needs per view):
   - `selectMonetaryExposureWithLLM()` — LLM classifies `extractMonetaryCandidates()` output
     into risks/obligations; **JS sums locally**, and `verifyMonetaryItems()` grounds every
     classified amount against the source text before it counts (hallucinated/duplicate items
     dropped, logged into `analysisWarnings`, never silently skew a total).
   - `generateLegalInsightsWithRAG()` / `generatePMInsightsWithRAG()` — hybrid-retrieved context
     (`retrieval.hybridRetrieve`, falls back to BM25-only, then Phase-0 keyword scoring) sent to
     the LLM with a strict JSON schema. Legal insights include verbatim `quote` substrings.
   - `extractRiskSignals()` — regex-derived boolean flags feeding the static `riskFactors` array.
   - RAG/monetary failures degrade to safe fallback defaults + an `analysisWarnings` entry —
     they no longer throw the whole analysis into `status: 'error'`.

LLM plumbing: `parseJsonResponse`/`cleanJsonResponse` (strip ```` ```json ```` fences), `callOpenRouter`
(JSON-mode retry/fallback) and `callOpenRouterStream` (SSE, retries only before the first token),
`parseNumericAmount`, `clampScore`, `normalizeRiskLevel`.

**Chat** (`generateChatResponse` / `generateChatResponseStream`) is history-aware (last 8 turns,
server re-validates independently via `sanitizeChatHistory` — never trusts the client) and uses a
plain-text protocol (`answer / SOURCES: / IMPLICATIONS:`) instead of JSON — `parseChatAnswer()`
tolerantly splits it. Every cited quote runs through `verifyQuote()` (whitespace/quote-normalized
substring match with offset mapping back to the original text, 8-word-prefix retry for padded
quotes); unverifiable quotes are dropped, never shown. `/api/chat/stream` streams over SSE
(`parseSseChunk` buffers partial upstream lines); `/api/chat` is the non-streaming regression path
— both share the same prompt-building/finalization code.

### Frontend — `frontend/index.html` + `frontend/js/app.js`

No build, no framework. Single `state` object; `render()` string-concatenates the current view's
HTML and assigns to `#app.innerHTML` — no diffing, every state change re-renders. Functions
invoked from markup use inline `onclick="..."`, so renderer/handler functions must stay global.
The one exception to "always full render()": chat token streaming writes directly into a DOM
node by id (`streaming-msg-content`) per token, then does one full render() at completion.

- **View renderers**: `renderUploadView`, `renderInvestorView`, `renderLegalView`, `renderPMView`,
  `renderPartnerView`, `renderChatView` (+ `renderLoadingView`, `renderExtractedTextPanel`).
- **Citation highlight**: clicking a chat citation chip opens the extracted-text panel and wraps
  the matched quote in `<mark id="citation-highlight">` using a client-side mirror of the
  server's `verifyQuote` normalizer (`normalizeForQuoteMatch`/`findQuoteOffsetWithFallback`) —
  keep these two implementations behaviorally identical if either changes.
- **API client**: `fetchContracts`, `uploadContract`, `uploadNewVersionAPI`, `getAnalysis`,
  `getContractText`, `getChatHistory` (loads persisted messages on `openContract()`),
  `updateContractRole`, `sendChatMessageAPI`, `streamChatMessageAPI` (SSE client with transparent
  fallback to `sendChatMessageAPI` if no token ever arrives), and `pollAnalysis`.

## API surface (all under `/api`)

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | `{status, timestamp, persistence}` |
| GET | `/contracts` | list (summary fields only) |
| GET | `/contracts/:id` | full contract record |
| GET | `/contracts/:id/file` | streams the stored upload |
| POST | `/contracts/upload` | multipart `file` + `role`; analysis runs async |
| POST | `/contracts/:id/version` | new version; prior version snapshotted, re-analyzes |
| GET | `/contracts/:id/analysis` | **202 while analyzing**, 200 with analysis when done |
| GET | `/contracts/:id/text` | extracted text + `numericFigures` |
| PATCH | `/contracts/:id/role` | change role, re-runs full analysis async |
| DELETE | `/contracts/:id` | removes record, file, and all persisted DB rows |
| GET | `/contracts/:id/chat` | last 50 persisted chat messages |
| POST | `/chat` | `{contractId, message, role, history}` → answer with verified citations |
| POST | `/chat/stream` | same, over SSE (`token`/`done`/`error` events) |

## Gotchas & conventions

- **Upload allow-list**: `.pdf, .docx, .doc, .txt`, 50 MB max (multer `fileFilter`/`limits`).
- **The analysis object is intentionally flat and shared across roles** — when adding a field for
  one view, add it in `analyzeDocumentText`'s `baseAnalysis` and read it in the relevant renderer.
- **Roles**: Investor, Legal, PM, Partner, HR appear in code paths. `selectedRole` defaults to
  `Legal`; `currentView` defaults to `upload`. `renderPartnerView` has no dedicated backend
  branch — Partner reuses the shared analysis fields.
- **PDF number corruption** recurs — anytime you touch numeric extraction, run text through the
  `(\d)\s+(?=\d)` collapse (see `normalizeNumericSpacing`, `extractNumericFigures`).
- **Persistence is write-through, not the source of truth at runtime** — the in-memory Maps are
  still what every route reads; `db.js` mirrors writes and rehydrates at boot. Don't add a new
  mutation site without also adding its `db.save*`/`db.delete*` call, or it'll silently not survive a restart.
- **Both `verifyQuote` (server) and `normalizeForQuoteMatch`/`findQuoteOffsetWithFallback`
  (client) implement the same normalization** — they're deliberately duplicated (no shared module
  between frontend/backend in this vanilla setup), so changes to one's normalization logic need
  the mirror updated too.
- **The `*_1` / `*_2` top-level directories** (e.g. `legal_counsel_analysis_view_1/`) are the
  original static "stitch" design mockups (`code.html` + `screen.png`) the real views were built
  from — reference-only, not part of the running app.
- **`backend/eval/fixtures/*.txt` are synthetic and PII-free by design** — never point the eval
  harness at `backend/uploads/` (real, git-ignored personal documents).
