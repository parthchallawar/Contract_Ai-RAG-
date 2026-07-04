# Phase 1 — Real RAG: Local Embeddings + Hybrid Retrieval (ContractAI)

## Context

Phase 0 stabilized the pipeline (clause-aware `chunkText()`, word-boundary `scoreChunkByKeywords()`, `callOpenRouter()` with retry/timeout, graceful degradation — all committed as `f94d738`). Retrieval is still purely lexical: keyword hits rank chunks, so paraphrases score zero ("cancel with one month notice" never matches a "termination" query). Phase 1 replaces this with a real RAG pipeline: **index once per contract** (embeddings + BM25 built at upload time), **hybrid retrieval** per query (cosine + BM25 fused with RRF), running fully locally at $0 via `@xenova/transformers` (already installed; smoke-tested at 16ms/3 sentences, dims=384). Keyword scoring stays as an automatic fallback so the app never breaks if the model can't load. The analysis JSON shape is unchanged (one additive field), so the frontend needs zero changes.

**Files:** NEW `backend/retrieval.js` (all Phase 1 logic); MODIFIED `backend/server.js` (wire-in, ~6 touch points); MODIFIED `.gitignore` (+`backend/.models/`). Frontend untouched.

---

## Part 1 — New module `backend/retrieval.js`

Single new file exporting: `warmupEmbedder`, `buildContractIndex`, `hybridRetrieve`, `isEmbedderReady`.

### 1a. Embedding provider (local, singleton, warm at startup)

```js
const { pipeline, env } = require('@xenova/transformers');
env.cacheDir = path.join(__dirname, '.models');   // survive node_modules wipes
env.allowRemoteModels = true;                      // first run downloads ~25MB, then offline
```

- `getEmbedder()` — lazy singleton `pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')`. Stored as a **promise** (not the instance) so concurrent callers await the same load, no double-init race.
- `embedTexts(texts)` — batches through the pipeline with `{ pooling: 'mean', normalize: true }`, returns array of `Float32Array(384)`. **Because vectors are normalized, cosine similarity = plain dot product** (no per-query norm computation).
- `warmupEmbedder()` — fire-and-forget at server startup so the first upload doesn't eat the model-load latency; failure logs a warning and sets `embedderFailed = true`, it does NOT crash the server.
- `isEmbedderReady()` — true only after successful load; drives the fallback decision.

### 1b. BM25 index (self-contained, ~40 lines)

- `tokenize(text)` — `text.toLowerCase().match(/[a-z0-9][a-z0-9.-]{1,}/g) || []` (keeps `net-30`, `12.3`, section numbers; consistent with Phase 0's 2-char floor).
- `buildBM25Index(chunks)` → `{ df: Map, tf: Array<Map>, docLens, avgDocLen, N }` computed once.
- `scoreBM25(index, queryTokens)` → per-chunk scores; standard formula, `k1 = 1.5`, `b = 0.75`, IDF = `ln(1 + (N - df + 0.5)/(df + 0.5))` (the +1 form — never negative, so common terms can't produce negative scores).

### 1c. Contract index (built once per text)

```js
async function buildContractIndex(text)  // → { chunks, embeddings|null, bm25, textHash }
```

- Chunks via the **existing `chunkText`** from server.js — passed in as an argument (or re-required); use `targetSize: 1000, overlap: 150`. Rationale: MiniLM's 256-token input cap ≈ ~1000 chars; the Phase 0 default of 1500 would silently truncate ~1/3 of every chunk at embedding time.
- `textHash` = sha256 of text (`crypto` builtin) — lets role-switch **skip re-indexing** when extracted text is unchanged.
- Embeddings: `await embedTexts(chunks.map(c => c.text))`. If embedder unavailable/fails → `embeddings: null` (BM25 + keyword paths still work). Wrap in try/catch; never throw out of `buildContractIndex`.
- Memory: 384 floats × 4 bytes ≈ 1.5KB/chunk → ~400KB for a 250K-char contract. Fine for the in-memory Map store; index lives on the contract object and dies with `DELETE`.

### 1d. Hybrid retrieval

```js
function hybridRetrieve(index, queryText, queryEmbedding, k = 6)  // → [{ id, text, start, score, ranks }]
```

- **Lexical leg:** BM25 over `tokenize(queryText)` → ranked list.
- **Semantic leg:** dot product of `queryEmbedding` against each chunk embedding → ranked list. Skipped when `embeddings === null` or no query embedding (degrades to BM25-only — still better than Phase 0).
- **Fusion:** Reciprocal Rank Fusion, `score = Σ 1/(60 + rank)` across the legs present. Deterministic tie-break by chunk id.
- Drop chunks with zero score in **both** legs (irrelevant padding); return top-k.

## Part 2 — Wire into `server.js`

### 2a. Startup + plumbing
- `const retrieval = require('./retrieval');` and `retrieval.warmupEmbedder()` right after `app.listen` (non-blocking, logs "Embedding model ready (Xenova/all-MiniLM-L6-v2)" or a fallback warning).

### 2b. Build the index in the processing pipeline (3 call sites)
In the async processing blocks of **upload**, **version upload**, and **role PATCH** — right after `contract.text = text`:
```js
if (!contract.index || contract.index.textHash !== sha256(text)) {
  contract.index = await retrieval.buildContractIndex(text);
}
```
Role PATCH re-extracts the same file, so the hash check makes re-analysis skip embedding entirely (index reuse). Log chunk count + whether embeddings are present.

### 2c. Replace retrieval in the two RAG functions
`generatePMInsightsWithRAG(text)` / `generateLegalInsightsWithRAG(text)` change signature to `(text, contract)`:
- Role query strings (constants): PM → `"deliverables schedule milestones intellectual property ownership license timeline due dates action items responsibilities"`, Legal → `"liability cap termination indemnification governing law jurisdiction data protection GDPR compliance warranty breach"`.
- If `contract.index` exists: `topContext = hybridRetrieve(index, roleQuery, await embedTexts([roleQuery]) ... , 6).map(c => c.text).join('\n---\n')`.
- **Fallback:** if no index or retrieval returns empty → existing Phase 0 keyword-scoring path (kept intact, moved behind an `else`). Prompts, `callOpenRouter` usage, and JSON schemas unchanged.

### 2d. Replace chat retrieval
`buildRelevantContext(text, question)` → becomes a thin wrapper: if `contract.index` exists, `hybridRetrieve(index, question, queryEmbedding, 4)`; else the Phase 0 keyword path. `generateChatResponse` passes `contract` through. Return shape stays `{ chunks: [{id, chunk, score}], keywords }` so the prompt-building code doesn't change.

### 2e. Additive analysis field
`baseAnalysis.retrieval = { mode: 'hybrid' | 'bm25-only' | 'keyword-fallback', chunkCount }` — additive, ignored by existing renderers, and gives Phase 4's eval harness (and your resume/demo) something to point at. If mode is a fallback, also push a note into `analysisWarnings`.

### 2f. Housekeeping
- `.gitignore`: add `backend/.models/`.
- Update `backend/test-embeddings.js` → keep as-is (still a valid smoke test); add NEW `backend/test-retrieval.js` (below).

## Explicit non-goals (later phases)
- No vector DB, no SQLite persistence (Phase 4), no chat memory/streaming (Phase 3), no LLM-call consolidation, no citation post-hoc verification (Phase 2), no reranker/query-rewriting.
- No change to chunking defaults used elsewhere; only the index uses 1000/150.

## Verification

1. **Unit — `node backend/test-retrieval.js`** (new script, no server needed):
   - *Semantic win:* index a synthetic contract where clause A says "Contractor may cancel with one month advance notification"; query "termination notice period" → A must be in top-3 (keyword scoring alone scores it 0 — assert BM25-only would miss it but hybrid finds it).
   - *Lexical win:* query "Section 12.3" and "Net 30" → exact-term chunks rank #1 (BM25 leg).
   - *RRF sanity:* a chunk ranked top in both legs beats a chunk top in one; zero-both chunks excluded.
   - *Fallback:* call `hybridRetrieve` with `embeddings: null` → BM25-only results, no throw.
   - *Determinism:* same inputs twice → identical output order.
2. **Startup:** `npm start` → log shows embedder warming, then ready; first-ever run downloads to `backend/.models/` (verify dir created, and that it's git-ignored via `git status`).
3. **End-to-end happy path:** upload the Sample-Construction-Contract PDF → log shows "index built: N chunks, embeddings: yes"; analysis completes; response contains `retrieval: { mode: 'hybrid', ... }`; Legal/PM sections populated at least as well as Phase 0 run.
4. **Chat quality spot-check:** ask "what are the IP rights?" and a paraphrase question that shares no keywords with the contract wording — answer should cite the right clause (compare against Phase 0 behavior).
5. **Role switch reuse:** PATCH role → log shows "index reused (text unchanged)" and no re-embedding delay.
6. **Degradation:** temporarily rename `backend/.models` + set `env.allowRemoteModels = false` (or simulate load failure) → server starts, upload completes with `retrieval.mode: 'keyword-fallback'` and a warning in `analysisWarnings`; restore afterwards.
7. **Regression:** delete, version upload, health, and the Phase 0 error paths (bad model name) all behave as before.
