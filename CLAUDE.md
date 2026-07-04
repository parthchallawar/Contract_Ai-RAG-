# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An AI-powered legal contract analysis web app. A user uploads a contract (PDF/DOCX/DOC/TXT),
the backend extracts the text and runs it through an LLM (via OpenRouter) to produce
**role-specific** analysis, and a single-page vanilla-JS frontend renders that analysis in
five perspectives: Upload, Investor, Legal, PM, Partner, plus a role-aware AI Chat.

Note: `README.md`, `ARCHITECTURE.md`, `QUICKSTART.md`, and `IMPLEMENTATION_SUMMARY.md` are
**partly stale** — they describe a "mock AI" and port 3000. The real code calls OpenRouter and
defaults to **port 8080**. Trust the source, not those docs, when they conflict.

## Commands

All backend commands run from the `backend/` directory:

```bash
cd backend
npm install            # install deps (express, multer, cors, uuid, pdf-parse, mammoth)
npm start              # node server.js  -> http://localhost:8080
npm run dev            # nodemon server.js (auto-reload)
```

- **Config**: `backend/.env` (loaded manually via `process.env` — there is NO dotenv package,
  so env vars must be exported in the shell or set by the host). Keys: `OPENROUTER_API_KEY`
  (required for any AI output — analysis throws and chat returns an error string without it),
  `OPENROUTER_MODEL` (default `nemotron-3-nano-30b-a3b:free`), `PORT` (default 8080).
  On Windows PowerShell: `$env:OPENROUTER_API_KEY="sk-..."; npm start`.
- **Smoke-test the LLM**: `node test-openrouter.js` from repo root (needs `OPENROUTER_API_KEY` in env).
- **There is no test suite, linter, or build step.** The root `package.json` lists only
  `@playwright/test` as a dev dep but no test files or scripts exist. The frontend is served
  statically — no bundler, no transpile.
- **Health check**: `curl http://localhost:8080/api/health`

## Architecture

Two pieces, no framework on either side:

### Backend — `backend/server.js` (single file, ~1000 lines)

Express server that also serves the frontend statically (`express.static('../frontend')`) and
falls back to `index.html` for all non-API routes (SPA routing). **All state is in-memory** via
two `Map`s (`contracts`, `analyses`) keyed by UUID — data is lost on restart. Uploaded files
land in `backend/uploads/` with a `${uuid}-${originalname}` name.

The analysis pipeline is the heart of the app. On upload (and on role change / new version),
processing runs **asynchronously after the HTTP response returns** — the contract is created
with `status: 'analyzing'`, and the frontend polls `/api/contracts/:id/analysis` (returns
HTTP 202 while pending) until `status: 'completed'` (or `'error'`). Flow:

1. `extractTextFromFile()` — dispatches by extension: `pdf-parse` for PDF (with a custom
   `pagerender` that joins text items with spaces), `mammoth` for DOCX/DOC, raw read for TXT.
   All output passes through `normalizeNumericSpacing()`, which strips the stray spaces PDFs
   insert inside numbers/currency/percentages (critical — PDF extraction mangles `$1,000` into
   `$1 000`, so much of the numeric code re-collapses `(\d)\s+(?=\d)`).
2. `analyzeDocumentText(text, contract)` orchestrates three LLM calls and assembles ONE flat
   `baseAnalysis` object containing fields for every role/view (investor, legal, PM all in one
   object — the frontend picks what it needs per view):
   - `selectMonetaryExposureWithLLM()` — feeds `extractMonetaryCandidates()` (regex-found money
     strings + 70-char surrounding context) to the LLM, which classifies each into `risks` vs
     `obligations`. **Amounts are summed locally in JS, not by the LLM**, for accuracy →
     `totalPotentialLoss` / `totalAmountOwed`, which feed `computeLossGivenDefaultScore()`.
   - `generateLegalInsightsWithRAG()` and `generatePMInsightsWithRAG()` — poor-man's RAG:
     chunk text (1500 chars), score each chunk by keyword hits for that role, take top 4 chunks,
     send to the LLM with a strict JSON schema. Legal insights must include verbatim `quote`
     substrings as evidence.
   - Regex `extractRiskSignals()` derives boolean flags (termination-for-convenience, uncapped
     liability, GDPR mention, etc.) that build the static `riskFactors` array.
   - If either RAG call returns null (e.g. missing API key), `analyzeDocumentText` **throws**,
     setting the contract to `status: 'error'`.

LLM plumbing helpers you'll reuse: `parseJsonResponse` / `cleanJsonResponse` (strip ```` ```json ````
fences and slice to the outer `{...}` — models are unreliable about clean JSON), `parseNumericAmount`
(handles `$`, `USD`, `k`/`m`/`b`, `thousand`/`million`/`billion`), `clampScore`, `normalizeRiskLevel`.

`generateChatResponse()` is separate: it builds context via `buildRelevantContext()`
(keyword-scored chunking of the whole contract, stopwords filtered) and asks the LLM for a JSON
answer with verbatim `citations` and `implications`. Every failure path returns a well-formed
message object with an `ERROR:` `content` string rather than throwing.

### Frontend — `frontend/index.html` + `frontend/js/app.js` (~1500 lines)

No build, no framework. `index.html` loads Tailwind (CDN), Inter + Material Symbols, and one
script. `app.js` is a hand-rolled SPA:

- **Single `state` object** (top of file) holds `currentView`, `selectedRole`, the current
  contract/analysis, chat messages, and per-view tab state (`investorTab`, `legalTab`, `pmTab`).
- **`render()`** is the whole render loop: it string-concatenates `renderHeader()` + one
  `renderXView()` (switch on `state.currentView`) + `renderFooter()` and assigns to
  `#app.innerHTML`. **Every state change calls `render()`**, which re-blows-away and rebuilds the
  DOM — there is no diffing. After render it re-attaches drag/drop and click handlers for the
  upload view. Functions invoked from markup are called via inline `onclick="..."`, so renderer
  functions and their handlers must stay on the global scope.
- **View renderers**: `renderUploadView`, `renderInvestorView`, `renderLegalView`, `renderPMView`,
  `renderPartnerView`, `renderChatView` (plus `renderLoadingView`). Each reads the one flat
  analysis object and shows its slice.
- **API client**: `fetchContracts`, `uploadContract`, `uploadNewVersionAPI`, `getAnalysis`,
  `getContractText`, `updateContractRole`, `sendChatMessageAPI`, and `pollAnalysis` (the loop
  that waits out `status: 'analyzing'`). `API_BASE = '/api'` (same origin — the backend serves
  the frontend, so no CORS/port juggling in normal use).

## API surface (all under `/api`)

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | `{status, timestamp}` |
| GET | `/contracts` | list (summary fields only) |
| GET | `/contracts/:id` | full contract record |
| GET | `/contracts/:id/file` | streams the stored upload |
| POST | `/contracts/upload` | multipart `file` + `role`; returns immediately, analysis runs async |
| POST | `/contracts/:id/version` | new version; pushes prior state onto `contract.versions[]`, re-analyzes |
| GET | `/contracts/:id/analysis` | **202 while analyzing**, 200 with analysis when done |
| GET | `/contracts/:id/text` | extracted text + `numericFigures` (202 while extracting) |
| PATCH | `/contracts/:id/role` | change role, re-runs full analysis async |
| DELETE | `/contracts/:id` | removes record + unlinks file |
| POST | `/chat` | `{contractId, message, role}` → LLM answer with citations |

## Gotchas & conventions

- **Upload allow-list**: `.pdf, .docx, .doc, .txt`, 50 MB max (multer `fileFilter`/`limits`).
- **The analysis object is intentionally flat and shared across roles** — when adding a field for
  one view, add it in `analyzeDocumentText`'s `baseAnalysis` and read it in the relevant renderer.
- **Roles**: code paths mention Investor, Legal, PM, Partner, HR. `selectedRole` defaults to
  `Legal`; `currentView` defaults to `upload`. There is a `renderPartnerView` but no dedicated
  backend Partner analysis branch — Partner reuses the shared analysis fields.
- **PDF number corruption** is a recurring source of bugs — anytime you touch numeric extraction,
  run text through the `(\d)\s+(?=\d)` collapse (see `normalizeNumericSpacing`, `extractNumericFigures`).
- **No persistence / no auth / single process.** Restarting the server clears all contracts;
  `uploads/` files persist on disk but their in-memory records don't.
- **The `*_1` / `*_2` top-level directories** (e.g. `legal_counsel_analysis_view_1/`) are the
  original static "stitch" design mockups (`code.html` + `screen.png`) the real views were built
  from. They are reference-only design artifacts, not part of the running app.
- `2026-02-27_21-07-59-dump.json` at repo root is a data dump, not code.
