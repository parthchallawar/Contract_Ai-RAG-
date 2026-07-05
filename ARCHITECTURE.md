# ContractAI — Architecture Deep Dive

This is the companion to [README.md](README.md) for anyone modifying the retrieval, persistence, or chat internals. README is the pitch; this is the how.

## Process & data model

Single Express process (`backend/server.js`), no framework on the frontend (`frontend/js/app.js`, one `state` object, full re-render on every change — no virtual DOM, no diffing). All reads happen against in-memory `Map`s (`contracts`, `analyses`); every mutation write-throughs to SQLite (`backend/db.js`) so a restart rehydrates rather than starting empty. See [Persistence](#persistence) below.

```
contracts: Map<id, {
  id, name, fileName, originalName, filePath, fileSize, uploadDate,
  status: 'analyzing' | 'completed' | 'error',
  role, text,
  index: { chunks, embeddings, bm25, textHash } | undefined,
  analysis, versions: [...]
}>
analyses: Map<id, AnalysisObject>   // duplicated onto contract.analysis too
```

## Upload → analysis pipeline

```
POST /api/contracts/upload
   │  (multer saves file, contract created with status:'analyzing', response returns immediately)
   ▼
extractTextFromFile()          pdf-parse (custom pagerender) | mammoth | raw read
   │
normalizeNumericSpacing()      collapses "$1 000" → "$1000" (PDF extraction artifact)
   │
ensureContractIndex()          skips rebuild if sha256(text) unchanged (role-switch reuse)
   │  chunkText(text, {targetSize:1000, overlap:150})
   │  ├─ buildBM25Index(chunks)                     (in-process, rebuilt from text on hydrate)
   │  └─ embedTexts(chunks) → Float32Array[]         (MiniLM, null on embedder failure)
   ▼
analyzeDocumentText()
   ├─ extractMonetaryCandidates() → selectMonetaryExposureWithLLM() → verifyMonetaryItems()
   ├─ generateLegalInsightsWithRAG()   ─┐  hybridRetrieve(index, ROLE_QUERY, k=6)
   ├─ generatePMInsightsWithRAG()      ─┘  (falls back to BM25-only, then Phase-0 keyword scoring)
   └─ extractRiskSignals()             regex-derived boolean flags (termination-for-convenience, etc.)
   ▼
baseAnalysis (flat object, all roles' fields) → analyses.set() + db.saveAnalysis()
```

Role switch and new-version upload run the identical pipeline from `ensureContractIndex()` down; the `textHash` check is what makes a role switch (same file, re-extracted) skip re-embedding.

## Retrieval: hybrid RRF

`backend/retrieval.js`. Two independent rankings over the same chunk set, fused:

- **BM25** (`k1=1.5, b=0.75`, IDF as `ln(1 + (N-df+0.5)/(df+0.5))` — the +1 form so common terms never score negative). Tokenizer keeps `net-30`, `12.3`, section numbers (`[a-z0-9][a-z0-9.-]{1,}`).
- **Semantic**: query embedded with the same MiniLM model; since all vectors are L2-normalized at embed time, cosine similarity reduces to a plain dot product — no per-query norm computation.
- **Fusion**: Reciprocal Rank Fusion, `score(chunk) = Σ_leg 1/(60 + rank_leg(chunk))`, summed over whichever legs the chunk appears in. A chunk absent from both legs (zero relevance signal) is dropped rather than returned as padding.
- **Degradation ladder**: hybrid → BM25-only (embedder unavailable) → Phase-0 keyword scoring (index itself missing, e.g. a build failure). Every layer is designed to degrade rather than throw.

`backend/eval/run-eval.js` measures all three rungs of that ladder against the same shared per-fixture index so the comparison isolates the scoring mechanism, not chunking differences.

## Numeric grounding (Phase 2)

```
extractMonetaryCandidates(text)
   │  regex scan + filter: currency symbol OR nearby money-keyword;
   │  rejects bare years, section/clause refs, TOC dot-leaders, ALL-CAPS
   │  numbered headings, hyphen-chained document codes (FMA-9, DGS-30-084)
   ▼
selectMonetaryExposureWithLLM(candidates)
   │  LLM classifies each candidate as risk | obligation (never computes sums itself)
   ▼
verifyMonetaryItems(parsed, candidates)
   │  exact-raw match, then amount-equality (handles "$50,000" → "50000 USD" reformatting)
   │  each candidate occurrence consumes at most one item per category (dedup)
   │  equal-amount + >60% context-token-overlap → possibleDuplicate flag (soft, never drops)
   ▼
totals = reduce(grounded items only)   // hallucinated/unmatched items excluded, logged
```

`calculations.grounding.rate` (grounded / total classified) is surfaced in the analysis JSON and is one of the eval harness's `--llm` metrics.

## Chat (Phase 3)

- **Memory**: client sends up to the last 8 turns (`{role, content}`, 2000-char cap per turn); server re-validates independently (`sanitizeChatHistory`) rather than trusting the client. Retrieval query for a turn is `lastUserTurn + currentMessage` — a bare follow-up ("is that normal?") has no retrievable content on its own.
- **Protocol**: the model is asked for plain text in a fixed layout (`answer / SOURCES: / IMPLICATIONS:`), not JSON — free models are unreliable at wrapping conversational text in valid JSON. `parseChatAnswer()` tolerantly splits the three sections; malformed sections just yield empty arrays, never throw.
- **Citation verification**: `verifyQuote(quote, text)` normalizes both sides (lowercase, curly→straight quotes, whitespace collapsed to single spaces) and builds an offset map so a match in normalized space still resolves to the correct offset in the *original* text. A ≥8-word quote that fails whole gets one retry against its first 8 words (models pad quote tails with plausible-sounding fabrication).
- **Streaming**: `POST /api/chat/stream` over SSE. `parseSseChunk()` buffers partial lines across fetch chunks (an upstream provider can split a `data: {...}` line mid-JSON). Retry semantics: only retry before the first token has been emitted to the client; once a token has flowed, the client is committed and any further failure surfaces as an `error` event instead.

## LLM provider fallback

`LLM_PROVIDERS` (`server.js`) is an ordered, filtered array — OpenRouter first, then NVIDIA NIM if both `NIM_API_KEY` and `NIM_MODEL` are set (otherwise NIM is simply absent from the array, and behavior is identical to OpenRouter-only). Both `callOpenRouter` (JSON-mode calls: analysis, monetary classification) and `callOpenRouterStream` (SSE chat) iterate this array identically: a 429/5xx response is treated as "this provider is unavailable right now" and moves on to the next provider immediately rather than backing off and retrying the same one; any other failure still gets the existing backoff-and-retry treatment on the current provider first. For streaming specifically, fallback is only attempted *before* the first token — once content has started flowing to the client, switching providers mid-stream would produce mixed, confusing output, so a post-first-token failure surfaces as an `error` event instead. JSON-mode-unsupported detection (`jsonModeUnsupportedByProvider`) is tracked per provider, since one model rejecting `response_format` says nothing about another. NIM is OpenAI-API-compatible for both plain and streaming completions, so no format-specific code was needed beyond parameterizing the URL/key/model — verified live against a real NIM endpoint (`meta/llama-3.1-8b-instruct`), including forcing OpenRouter's real 429 and confirming a clean fallback for both the analysis pipeline and streaming chat.

## Persistence (Phase 4)

`backend/db.js`, `better-sqlite3`, WAL mode. Hydrate-on-boot / write-through: reads still go through the in-memory Maps (zero change to read-path code); every mutation additionally writes to SQLite. If `better-sqlite3` fails to load (e.g. no prebuilt binary for the platform), every `db.js` function becomes a no-op and `/api/health` reports `persistence: 'disabled'` — the app must never fail to start, or behave differently in its core features, because of the database.

```sql
contracts(id PK, name, fileName, originalName, filePath, fileSize,
          uploadDate, status, role, text, textHash)
analyses(contractId PK REFERENCES contracts ON DELETE CASCADE, json, generatedAt)
chunks(contractId, chunkId, start, text, embedding BLOB, PRIMARY KEY(contractId, chunkId))
chat_messages(id PK AUTOINCREMENT, contractId, role, content, extras JSON, timestamp)
versions(contractId, version, json, PRIMARY KEY(contractId, version))
```

Embeddings round-trip as raw bytes (`Buffer.from(f32.buffer, ...)` in, `new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength/4)` out — zero-copy view, not a re-parse). BM25 is **not** persisted — it's cheap enough to rebuild from chunk text at hydrate time, which avoids serializing its internal `Map`s. At boot, a contract still `status:'analyzing'` means its in-flight promise died with the previous process; it's flipped to `'error'` (the frontend's existing error toast already handles that state — no new UI needed).

## Frontend render model

One `state` object; `render()` string-concatenates the current view's HTML and assigns it to `#app.innerHTML`, then re-attaches drag/drop and input handlers. No diffing. The one deliberate exception is chat token streaming: `handleSendChatMessage()` writes each token directly into a DOM node by id (`streaming-msg-content`) rather than calling `render()` per token, then does one full `render()` at completion — otherwise a multi-hundred-token answer would trigger a full innerHTML rebuild per token.

## Known sharp edges for future work

- BM25 is rebuilt (not persisted) on every hydrate — fine at current chunk counts, would need reconsideration at very large contract volumes.
- No token-budget management beyond per-turn truncation; a very long conversation isn't summarized, just truncated to the last 8 turns.
- `schema_version` table exists but no migration runner is wired up yet — schema changes today mean a manual `ALTER TABLE` or a fresh `data.sqlite`.
