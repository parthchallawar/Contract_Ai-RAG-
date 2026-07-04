# Phase 0 — Stabilization & Bug Fixes (ContractAI)

## Context

Before building the real RAG pipeline (Phase 1: local embeddings + hybrid retrieval), the existing pipeline in `backend/server.js` has correctness bugs that would poison any later work: naive chunking that splits clauses mid-sentence, substring keyword matching that retrieves junk, a hard-throw that fails an entire analysis when one LLM sub-call returns malformed JSON, chat keyword extraction that drops critical short terms (`IP`, `fee`, `cap`), a `.env` file that is never loaded, and a frontend spinner that hangs forever when analysis errors or takes >30s. Phase 0 fixes all of these with **no behavior/API-shape changes** — the analysis JSON stays identical so the frontend renderers keep working untouched.

**Files modified:** `backend/server.js` (main), `frontend/js/app.js` (polling/error handling only), `backend/package.json` (+dotenv). No new files except optionally keeping changes self-contained in server.js.

---

## Fix 1 — Load `.env` (dotenv)

**Bug:** `backend/.env` exists but nothing loads it (no dotenv dep, no manual parse). `OPENROUTER_API_KEY` is silently empty unless exported in the shell → every analysis fails.

**Change:**
- `cd backend && npm install dotenv`
- First line of `server.js`: `require('dotenv').config();` (must precede the `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` reads at `server.js:342-343` and the `PORT` read at line 60 — top of file handles all).

## Fix 2 — Shared clause-aware chunker with overlap

**Bug:** Three duplicated naive chunkers slice at fixed char offsets with zero overlap, splitting clauses mid-word:
- `generatePMInsightsWithRAG` (1500 chars, `server.js:645-649`)
- `generateLegalInsightsWithRAG` (1500 chars, `server.js:719-722`)
- `buildRelevantContext` for chat (1200 chars, `server.js:609-613`)

**Change:** One shared function replacing all three:

```js
function chunkText(text, { targetSize = 1500, overlap = 200 } = {})
```

Algorithm (deterministic, no LLM):
1. Split text into "blocks" on paragraph boundaries (`/\n\s*\n/`) **and** contract section headings — regex for lines starting with `Section \d`, `ARTICLE [IVX\d]`, `\d+(\.\d+)*[.)]\s`, or ALL-CAPS heading lines. Headings start a new block.
2. Pack consecutive blocks into chunks until adding the next block would exceed `targetSize`.
3. A single block longer than `targetSize` is split at sentence boundaries (`. ` lookahead), hard-split only as last resort.
4. Each chunk (except the first) is prefixed with the last `overlap` chars of the previous chunk, cut back to the nearest whitespace so no mid-word starts.
5. Returns `[{ id, text, start }]` (start = char offset in original — needed by Phase 1/2 for citation verification, cheap to add now).

Edge cases handled: empty/whitespace-only text → `[]`; text shorter than `targetSize` → single chunk; documents with no headings/newlines (PDF extraction often yields one giant line) → sentence-boundary fallback still applies.

## Fix 3 — Word-boundary keyword scoring (kills the `'ip'` bug)

**Bug:** `lowerChunk.includes(kw)` — `'ip'` in `pmKeywords` (`server.js:652`) matches "equipment", "description", "recipient", "participate" → junk chunks outrank real IP clauses. Also `'liability'` counted once regardless of frequency.

**Change:** Shared scorer used by PM RAG, Legal RAG, and chat context:

```js
function scoreChunkByKeywords(chunkLower, keywords)
```

- Each keyword → cached `new RegExp('\\b' + escapeRegex(kw) + '\\b', 'g')` (multi-word keywords like `'intellectual property'`, `'governing law'` work naturally with `\b` on both ends).
- Score = number of **distinct keywords matched** + `0.25 × extra occurrences` (frequency-aware but presence-dominated, capped per keyword at +1 so one repeated word can't drown the rest).
- Replace all three inline scoring loops. Keyword lists themselves stay as-is (with `'ip'` now safely word-bounded).

## Fix 4 — Chat keyword extraction keeps short terms

**Bug:** `extractChatKeywords` uses `/[a-z]{4,}/g` (`server.js:602`) — questions about `IP`, `fee`, `tax`, `cap`, `pay`, `net` extract zero usable keywords → retrieval falls back to generic keywords, wrong chunks retrieved.

**Change:**
- Regex → `/[a-z][a-z0-9-]{1,}/g` (2+ chars, allows `net-30` style tokens).
- Extend `CHAT_STOPWORDS` (`server.js:345`) with short function words now let through: `of, to, in, is, it, as, at, be, by, do, if, no, on, or, so, we, an, am, us, my, me, he, she, its, was, per, via, etc, get, got, let, say, said, use, one, two`.
- Keep dedupe behavior unchanged.

## Fix 5 — Single `callOpenRouter()` helper: retry, timeout, JSON mode

**Bug:** Four near-identical fetch blocks (monetary `:551`, PM `:677`, legal `:750`, chat `:949`) with no timeout, no retry — one transient 429/5xx or malformed JSON from the free model fails the whole analysis.

**Change:** One helper used by all four call sites:

```js
async function callOpenRouter(messages, { expectJson = true, retries = 1, timeoutMs = 90000 } = {})
```

- `AbortController` timeout (free models can hang; 90s covers slow generations).
- Attempts `response_format: { type: 'json_object' }` when `expectJson`. **If the API returns 4xx** (model doesn't support JSON mode — the default free nemotron may not), immediately retries the same attempt **without** `response_format` rather than counting it as a failure. Remembers the outcome in a module-level flag so subsequent calls skip the doomed attempt.
- Retries once (configurable) with 2s backoff on: network error, 429, 5xx, empty content, or (when `expectJson`) content that fails `parseJsonResponse`.
- Returns parsed object (or raw string when `!expectJson`); returns `null` after all retries fail — callers already handle `null`.
- Reuses existing `parseJsonResponse`/`cleanJsonResponse` (`server.js:488-509`) as the fence-stripping fallback for non-JSON-mode responses.
- The four call sites shrink to: build prompt → `callOpenRouter(...)` → validate shape.

## Fix 6 — Graceful degradation in `analyzeDocumentText` (no more hard-throw)

**Bugs (two, related):**
1. `if (!pmInsights) throw ...` / `if (!legalInsights) throw ...` (`server.js:812, 818`) — one failed sub-call marks the whole contract `status: 'error'` even when the other two calls succeeded.
2. **Latent TypeError:** `getFallbackPMInsights()` and `getFallbackLegalInsights()` return `null` (`server.js:707-709, 780-782`), so `legalInsights.enforceabilityRisks || getFallbackLegalInsights().enforceabilityRisks` (`server.js:906-912`) crashes with `Cannot read properties of null` whenever the LLM returns valid JSON missing one field.

**Change:**
- Rewrite the two fallback functions to return real safe defaults, e.g. legal: `{ overallRisk: null, complianceScore: null, enforceabilityRisks: [], complianceChecks: [], jurisdiction: { location: 'Not determined', governingLaw: 'Not determined', notes: ['AI legal analysis unavailable for this run.'] } }`; PM: `{ deliverables: [], ipRights: { customerData: 'Not determined', saasSoftware: 'Not determined', usageRestrictions: 'Not determined' }, timelines: [], actionItems: [] }`.
- Remove both `throw`s: `const pmInsights = await generatePMInsightsWithRAG(text) || getFallbackPMInsights();` (same for legal).
- Add `analysisWarnings: string[]` to `baseAnalysis` — push `'PM insights unavailable (AI call failed)'` etc. when a fallback was used. Additive field; existing renderers ignore unknown keys (they read specific fields), so no frontend change required to stay working.
- Keep `status: 'error'` only for truly fatal cases (text extraction produced empty string → nothing to analyze).

## Fix 7 — Error/timeout propagation to the frontend (kill the infinite spinner)

**Bugs:**
1. When `contract.status === 'error'`, `GET /api/contracts/:id/analysis` (`server.js:251-263`) still answers 202 `{status:'analyzing'}` forever — the frontend can never learn it failed.
2. `pollAnalysis` (`app.js:249-269`) gives up after 30×1s = **30 seconds**, but three sequential free-model LLM calls routinely take longer → `callback(null)`, and **every caller** (`uploadFile:1229`, `selectRole:1187`, `handleVersionSelected:1266`, `openContract:1303`) does `if (analysis) {...}` with no else → `state.isLoading` stays `true` → spinner forever.

**Change — backend:** in the analysis endpoint, before the 202 branch: `if (contract.status === 'error') return res.status(200).json({ status: 'error', message: 'Analysis failed. Please try re-uploading.' });`

**Change — frontend (`app.js`):**
- `getAnalysis`: also return a sentinel for error → `if (data.status === 'error') return { __failed: true, message: data.message }`.
- `pollAnalysis`: bump to `maxAttempts = 90`, interval 2000ms (3 min budget); when it sees `__failed` or exhausts attempts, call `callback(null)`.
- All four `pollAnalysis` callbacks get an `else` branch: `state.isLoading = false; showToast('Analysis failed or timed out. Please try again.'); render();` (reuses existing `showToast` at `app.js:1387`).

---

## Explicit non-goals (Phase 1+, do NOT do now)

- No embeddings / Transformers.js wiring (already installed + smoke-tested; used in Phase 1).
- No BM25/hybrid retrieval, no call consolidation (3→1), no chat memory/streaming, no SQLite.
- No change to the analysis JSON shape besides the additive `analysisWarnings`.
- `test-embeddings.js` stays as-is (Phase 1 sanity check).

## Verification

1. **Env loading:** put a real key in `backend/.env`, run `cd backend && npm start` with a clean shell (no exported vars) → log shows server on :8080; `node test-openrouter.js` from root (with exported key) still works.
2. **Happy path:** upload `backend/test.txt` and a real PDF from `backend/uploads/` (e.g. the Sample-Construction-Contract) via the UI at `http://localhost:8080` → analysis completes; Legal/PM/Investor views render; verify server log shows chunk counts and no `TT:` warnings regression.
3. **Chunker unit sanity (scratchpad script):** run `chunkText` over an extracted contract text → assert: no empty chunks, every chunk ≤ ~targetSize+overlap, consecutive chunks share overlap text, headings start new chunks, `start` offsets are correct (`text.slice(start).startsWith(nonOverlapPortion)`).
4. **Keyword fix:** score a chunk containing "equipment description recipient" with `['ip']` → 0; chunk containing "IP ownership" → >0. Chat: ask "what are the IP rights?" and "what is the late fee?" → server log shows `ip`/`fee` among retrieval keywords and answers cite the right clauses.
5. **Degradation:** temporarily set `OPENROUTER_MODEL=nonexistent-model` → upload → contract completes with `analysisWarnings` populated and empty-but-valid legal/PM sections (no throw, no `status:'error'`, no TypeError); UI renders without crashing.
6. **Error/timeout UX:** blank out `OPENROUTER_API_KEY` → upload → monetary/PM/legal all fall back with warnings (still completes). Force a fatal path (upload an image renamed `.txt`? → empty text) → contract goes `status:'error'` → frontend shows toast, spinner clears within one poll cycle.
7. **Regression:** role switch (PATCH), new-version upload, delete, and chat all still work; `GET /api/contracts/:id/analysis` returns the same field set as before plus `analysisWarnings`.
