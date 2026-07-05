# ContractAI — Complete Interview Guide

This document explains the whole project in simple English. Read it before an interview and you will be able to explain every part of the project: what it does, how RAG works, how two AI models are connected, what every important function does, and why the design choices were made.

---

## 1. The 30-Second Pitch (say this first)

> "ContractAI is a web app where you upload a legal contract (PDF, Word, or text file), and it gives you an AI analysis made for your role — Investor, Legal, PM, or Partner. You can also chat with the document. The special part: it does not just send the whole contract to an AI model. It has a real RAG pipeline built from scratch — local embeddings plus BM25 keyword search, combined with Reciprocal Rank Fusion. Every money figure the AI reports is verified against the real document text before it is counted, and every quote the chat cites is checked to actually exist in the contract — fake quotes are dropped. I also built an evaluation harness that proves my hybrid retrieval beats plain keyword search with real numbers."

---

## 2. Tech Stack (short list)

| Part | Technology | Why |
|---|---|---|
| Backend | Node.js + Express (one server file + helpers) | Simple, no framework overhead |
| Frontend | Plain vanilla JavaScript, one HTML file | No build step, easy to demo anywhere |
| Embeddings | `@xenova/transformers` — MiniLM model running **locally** (ONNX) | Free, no API cost, no rate limits, private |
| Keyword search | BM25 (written by hand, no library) | Shows I understand the algorithm |
| AI models | OpenRouter (primary) + NVIDIA NIM (automatic fallback) | Free tiers; fallback fixes daily-limit problem |
| Database | SQLite via `better-sqlite3` | Zero setup, survives restarts |
| File reading | `pdf-parse` (PDF), `mammoth` (Word) | Standard extraction libraries |

---

## 3. Big Picture — What Happens When You Upload a Contract

Step by step, in order:

1. **Upload** — The browser sends the file to `POST /api/contracts/upload`. The server saves the file, creates a contract record with status `analyzing`, and **replies immediately**. The heavy work happens in the background (async). The frontend polls `GET /api/contracts/:id/analysis` every few seconds — it gets HTTP `202` ("still working") until the status becomes `completed`.
   - *Why async?* A big PDF + three AI calls can take 30–60 seconds. You never want an HTTP request hanging that long.

2. **Text extraction** — `extractTextFromFile()` picks the right reader: `pdf-parse` for PDF, `mammoth` for Word, plain read for TXT. Then `normalizeNumericSpacing()` fixes a very common PDF problem: PDF extraction breaks `$1,000` into `$1 000` (with a space). The fix collapses spaces between digits.

3. **Indexing** — `ensureContractIndex()` builds the search index (details in the RAG section below). It first computes `sha256(text)`. If the hash is the same as last time (for example, the user only switched roles — same file), the index is **reused**, not rebuilt. This saves re-embedding the whole document.

4. **Analysis** — `analyzeDocumentText()` runs three AI calls and merges everything into **one flat analysis object** shared by all roles:
   - Money analysis (`selectMonetaryExposureWithLLM` + `verifyMonetaryItems`)
   - Legal insights (`generateLegalInsightsWithRAG`)
   - PM insights (`generatePMInsightsWithRAG`)
   - Plus `extractRiskSignals()` — simple regex flags (e.g., "does the contract mention termination for convenience?") that do not need AI at all.

5. **Save** — The result goes into an in-memory `Map` AND into SQLite (write-through). The frontend's next poll returns `200` with the full analysis, and the view renders.

**Important design point:** if any single AI step fails (bad JSON, rate limit), it falls back to safe default values and adds a note to `analysisWarnings` — the whole analysis never crashes because one part failed. This is called **graceful degradation** and it appears everywhere in this project.

---

## 4. How RAG Works Here (the heart of the project)

RAG = Retrieval-Augmented Generation. Simple meaning: **instead of sending the whole document to the AI, you first *find* the few most relevant pieces and send only those.** This is cheaper, fits small context windows, and gives more focused answers.

### 4.1 Step 1 — Chunking (`chunkText` in server.js)

The contract text is cut into pieces (~1000–1500 characters each). But not blindly:

- First try to split on **headings and paragraphs** (`splitIntoBlocks`) — a contract clause should stay together.
- If a block is too big, split on **sentence boundaries** (`splitBySentences`) — never in the middle of a sentence.
- Small blocks are packed together (`packBlocksIntoChunks`) so chunks are not tiny.
- Each chunk gets ~150–200 characters of **overlap** with the previous one (`applyOverlap`) — so information sitting right at a chunk border is not lost.
- Every chunk remembers its **start offset** in the original text — needed later for citation highlighting.

**Interview line:** "I use clause-aware chunking — split on headings first, sentences as fallback, never mid-sentence, with overlap so nothing falls between the cracks."

### 4.2 Step 2 — Two search indexes are built (`buildContractIndex` in retrieval.js)

Every chunk goes into **two** independent indexes:

**A) BM25 (keyword search)** — `buildBM25Index` / `scoreBM25`
- BM25 is the classic search-engine ranking formula (used by Elasticsearch, etc.). I implemented it by hand.
- It scores a chunk higher if it contains the query words, but with two smart adjustments:
  - **Rare words count more** (IDF): the word "indemnification" appearing is a stronger signal than the word "agreement", which is everywhere.
  - **Long chunks don't win unfairly** (length normalization with parameter `b=0.75`), and repeating a word 10 times doesn't give 10× the score (saturation with `k1=1.5`).
- I use the `ln(1 + ...)` form of IDF so very common words never get a *negative* score.
- The tokenizer (`tokenize`) is contract-aware: it keeps things like `net-30`, `12.3`, and section numbers as single tokens instead of destroying them.

**B) Semantic embeddings (meaning search)** — `embedTexts`
- Every chunk is turned into a **vector of 384 numbers** by a small model called MiniLM (`Xenova/all-MiniLM-L6-v2`), running **locally inside the Node process** via ONNX — no API call, no cost, no data leaves the machine.
- Vectors that mean similar things point in similar directions. So "terminate the agreement at its convenience" and "cancel the contract whenever they want" end up close together — even though they share almost no words.
- All vectors are **L2-normalized** (length = 1) at embed time. This is a nice trick: cosine similarity between normalized vectors is just a **dot product** — one multiply-add loop, super fast.

### 4.3 Step 3 — Query time: Hybrid retrieval with RRF (`hybridRetrieve`)

When a question comes in (from chat, or from the analysis prompts):

1. The query is scored against **BM25** → ranking #1.
2. The query is embedded with the same MiniLM model and dot-producted against all chunk vectors → ranking #2.
3. The two rankings are merged with **Reciprocal Rank Fusion (RRF)**:

```
final_score(chunk) = 1/(60 + rank_in_BM25) + 1/(60 + rank_in_semantic)
```

- A chunk that is rank #1 in BM25 gets 1/61, rank #2 gets 1/62, and so on. Same for the semantic list. Add them up.
- **Why RRF and not adding raw scores?** BM25 scores and cosine scores live on totally different scales (BM25 can be 15.2, cosine is 0–1). RRF only uses the *rank position*, so no messy score normalization is needed. The constant 60 is the standard value from the original RRF paper — it stops rank #1 from totally dominating.
- A chunk that appears in **neither** ranking is dropped completely — never returned as padding.

**Why hybrid at all?** Contracts contain two kinds of things:
- **Exact strings** — section numbers, "$50,000", defined terms like "Net-30". Semantic search is *bad* at these; BM25 nails them.
- **Paraphrases** — the user asks "can they cancel anytime?" but the contract says "terminate for convenience". BM25 shares zero words; embeddings catch it.

Hybrid means neither method has to be right alone.

### 4.4 Step 4 — The fallback ladder (graceful degradation)

Retrieval never crashes the app. Three levels:

1. **Hybrid** (BM25 + embeddings + RRF) — normal case.
2. **BM25-only** — if the embedding model failed to load (e.g., first-run model download failed).
3. **Plain keyword scoring** (`scoreChunkByKeywords`) — if the whole index is missing.

**Interview line:** "Every layer of the system degrades instead of throwing — retrieval, database, AI provider, all of it."

---

## 5. How the Two AI Models Are Integrated (OpenRouter + NVIDIA NIM)

### The problem
The project uses a **free** model on OpenRouter (`nemotron-3-nano-30b-a3b:free`) — but free means a limit of ~50 requests per day. During demos or testing, the limit gets hit and every AI feature returns errors.

### The solution: an ordered provider list with automatic fallback

In `server.js` there is a `LLM_PROVIDERS` array:

```js
const LLM_PROVIDERS = [
  { name: 'openrouter', apiKey: OPENROUTER_API_KEY, model: OPENROUTER_MODEL, url: 'https://openrouter.ai/api/v1/chat/completions' },
  { name: 'nim',        apiKey: NIM_API_KEY,        model: NIM_MODEL,        url: 'https://integrate.api.nvidia.com/v1/chat/completions' }
].filter((p) => p.apiKey && p.model);
```

Key points to explain:

- **Order matters**: OpenRouter is always tried first. NVIDIA NIM is only used if OpenRouter fails.
- **The filter**: if the NIM key/model are not set in `.env`, NIM simply is not in the array — the app behaves exactly like the original single-provider version. Fallback is fully optional.
- **Both providers speak the same "OpenAI-compatible" API format** (same request JSON, same streaming format). So I did not need two different code paths — just parameters (URL, key, model name) per provider.
- **When does fallback trigger?** On a `429` (rate limit) or a `5xx` (server error) response, the code moves to the next provider **immediately** — no point waiting and retrying a provider whose daily quota is dead. Other errors (like malformed JSON output) still retry the *same* provider first, because those are usually random.
- **Streaming special rule**: for the chat stream, fallback only happens **before the first token** has been sent to the user. Once tokens are flowing, switching models mid-sentence would produce a mixed, confusing answer — so a mid-stream failure just shows an error instead.
- **JSON-mode tracking is per provider** (`jsonModeUnsupportedByProvider` Map): if OpenRouter's model rejects `response_format: json`, that says nothing about NIM's model, so it is remembered separately for each.

**Proof it works:** I tested it live — OpenRouter's real daily limit was hit (real 429s), and both the full analysis pipeline and the streaming chat fell back to NVIDIA NIM (`meta/llama-3.1-8b-instruct`) and produced correct output with verified citations.

---

## 6. Numeric Grounding — "The AI never invents a dollar amount" (unique feature #1)

The problem: LLMs are bad at math and sometimes invent numbers. In a contract analysis tool, an invented dollar figure is a disaster.

The solution — a three-step pipeline where **the AI never does math and never gets the last word**:

1. **`extractMonetaryCandidates(text)`** — deterministic JS regex scan finds all money-looking numbers in the text. Heavy filtering removes false positives:
   - bare years ("2024"), section references ("Section 5.2"),
   - table-of-contents dot-leader lines ("Payment ......... 12"),
   - numbered headings, document codes like "FMA-9" or "DGS-30-084",
   - a number only passes if it has a currency symbol OR a money word nearby ("fee", "penalty", "payment"...) — `hasMoneyKeywordNearby()` / `isNonMonetaryArtifact()`.

2. **`selectMonetaryExposureWithLLM(candidates)`** — the AI's ONLY job: look at each candidate with its surrounding text and label it a **risk** (money we might lose) or an **obligation** (money we must pay). It classifies. It never adds numbers.

3. **`verifyMonetaryItems(parsed, candidates)`** — every item the AI returned is checked against the real candidate list:
   - **Exact raw match** first ("$50,000" === "$50,000").
   - Then **amount-equality** (handles the AI reformatting "$50,000" as "50000 USD").
   - Each real occurrence in the text can be **consumed only once** per category — if the AI lists the same fee twice, the duplicate is dropped.
   - If two items have the same amount and their surrounding text overlaps more than 60% (Jaccard similarity on words — `jaccardSimilarity()`), the item gets a soft **`possibleDuplicate`** flag — shown to the user, but not dropped, because two genuinely separate $10,000 fees can legally exist.
   - Anything that cannot be matched to real text is **dropped and logged** into `analysisWarnings` — it never touches the totals.

4. **JS sums the survivors.** All totals are plain JavaScript `reduce()`. The UI shows a **grounding badge** ("12/13 amounts verified") and a "show source" button per row that reveals the exact sentence the number came from.

**Interview line:** "LLM classifies, JS verifies and sums. Nothing invented by the model can reach a total."

---

## 7. Chat With Verified Citations (unique feature #2)

### Memory (multi-turn)
- The client sends the last **8 turns** of conversation. The server **re-validates the history itself** (`sanitizeChatHistory`) — length caps (2000 chars/turn), role checks, dropping previous error messages — it never blindly trusts what the client sends.
- **Follow-up trick:** the retrieval query is `last user question + current question` combined. Why? If the user asks "Is that normal?", those three words alone retrieve nothing useful — but combined with the previous question ("What's the late payment penalty?"), retrieval finds the right chunks.

### Answer format — plain text, not JSON
The model is asked to reply in a simple fixed layout:

```
<the answer text>
SOURCES:
- "exact quote from contract"
IMPLICATIONS:
- practical consequence
```

**Why not JSON?** Free/small models frequently break JSON when writing conversational text (unescaped quotes, cut-off strings). A plain-text protocol with headers is much more robust, and `parseChatAnswer()` splits it tolerantly — a missing section just gives an empty list, never a crash.

### Citation verification — `verifyQuote()` (the clever part)
Every quote in SOURCES is checked to actually exist in the contract:

1. **Normalize both sides**: lowercase, curly quotes → straight quotes, all whitespace collapsed to single spaces. (The model often changes these cosmetically.)
2. **Offset mapping**: while normalizing, `buildNormalizedOffsetMap()` remembers where each normalized character came from in the original text — so when a match is found in normalized space, we can point back to the **exact position in the original document**. That position powers the click-to-highlight feature.
3. **8-word-prefix retry**: models often start a quote correctly and then *pad the ending* with invented words. If the full quote fails, we retry with just its first 8 words — if that matches, we keep the real matched portion.
4. **Fails everything? Dropped.** An unverifiable quote is never shown — not even with a warning label. Reason: showing "maybe-fake" quotes destroys trust in the real ones.

The frontend has a **mirror copy** of this same normalization logic (`normalizeForQuoteMatch` / `findQuoteOffsetWithFallback` in app.js) so clicking a citation chip highlights the exact quoted sentence in the extracted-text panel (`<mark id="citation-highlight">`).

### Streaming (SSE)
- `POST /api/chat/stream` sends tokens one by one over **Server-Sent Events** — the answer appears word-by-word like ChatGPT.
- `parseSseChunk()` is a line buffer: the network can split a `data: {...}` line in half between packets, so partial lines are buffered until the newline arrives.
- The frontend writes each token straight into one DOM node by id (`streaming-msg-content`) instead of re-rendering the whole page per token (that would rebuild the full page hundreds of times). One full render happens at the end.
- If streaming produces zero tokens, the frontend silently falls back to the normal non-streaming `POST /api/chat`.

**A real bug worth telling:** initially I used `req.on('close')` to detect the user closing the tab (to abort the AI call). But in Express, `req` 'close' fires as soon as the request body finishes reading — killing every stream instantly. The fix: `res.on('close')` with a check on `res.writableEnded`. This is a great "hard bug I debugged" story.

---

## 8. Persistence — SQLite (`backend/db.js`)

- Uses `better-sqlite3` (synchronous, WAL mode).
- Design: **write-through + hydrate-on-boot.** All reads still come from in-memory `Map`s (fast, zero code change to routes); every write additionally goes to SQLite. On server start, `hydrateFromDb()` loads everything back into the Maps.
- Tables: `contracts`, `analyses` (the JSON blob), `chunks` (chunk text + **embedding stored as raw bytes/BLOB** — a `Float32Array`'s buffer written directly, read back as a zero-copy view), `chat_messages`, `versions`.
- BM25 is **not** stored — it's rebuilt from chunk text at boot, cheaper than serializing its internal maps.
- A contract found at boot still in `analyzing` status means the process died mid-analysis → flipped to `error`.
- **Graceful degradation again:** if `better-sqlite3` fails to load (native module, platform issues), every db function becomes a no-op, `/api/health` says `persistence: 'disabled'`, and the app runs memory-only. The app must never fail to start because of the database.

---

## 9. Evaluation Harness — "I have numbers, not vibes" (unique feature #3)

`backend/eval/` contains:
- **3 synthetic fixture contracts** (written for this purpose, zero personal data) with deliberate **paraphrase traps** — questions worded so they share no vocabulary with the answer text (e.g., question says "walk away", contract says "terminate for convenience").
- **30-item gold dataset** (`dataset.json`): 24 retrieval questions with known-correct source passages + 6 numeric questions.
- **`run-eval.js`** compares three retrieval modes on the exact same production code paths and the same index (so only the scoring method differs, not chunking):

| Mode | hit@4 | hit@6 | MRR |
|---|---|---|---|
| keyword (baseline) | 87.5% | 95.8% | 0.728 |
| BM25 only | 87.5% | 91.7% | 0.747 |
| **hybrid (RRF)** | **95.8%** | 95.8% | **0.852** |

- **hit@4** = "was a correct chunk in the top 4 results?" **MRR** = mean reciprocal rank — rewards putting the right answer *higher* (1st = 1.0, 2nd = 0.5, 3rd = 0.33...).
- Hybrid wins on hit@4 and MRR — especially on the paraphrase traps, which keyword/BM25 miss by design.
- **Honesty points I kept in the repo on purpose:** (1) keyword beats BM25 at hit@6 on this specific dataset — a real result, kept, not hidden; (2) the dataset was written *before* any tuning, and a 30-item set proves direction, not statistical significance.
- Default mode is fully offline and deterministic (~1 second). An optional `--llm` flag also measures numeric-grounding rate and citation-verification rate (needs API, non-deterministic).

**Interview line:** "I committed a baseline JSON with real measured numbers, including the result that doesn't flatter my system. That's the difference between an eval and a marketing slide."

---

## 10. Function Reference (grouped, plain English)

### backend/retrieval.js (the RAG core)
| Function | What it does |
|---|---|
| `getEmbedder` / `warmupEmbedder` / `isEmbedderReady` | Lazily load the local MiniLM model once; warmup starts the download early |
| `embedTexts(texts)` | Text list → list of 384-dim normalized Float32Array vectors |
| `tokenize(text)` | Contract-aware word splitting (keeps `net-30`, `12.3`, section numbers) |
| `buildBM25Index(chunks)` | Builds term frequencies, document frequencies, lengths |
| `scoreBM25(index, queryTokens)` | Scores every chunk for a query with the BM25 formula |
| `sha256(text)` | Hash used to skip re-indexing unchanged text |
| `buildContractIndex(text, chunkFn)` | Full pipeline: chunk → BM25 index → embeddings |
| `dot(a, b)` | Dot product = cosine similarity (vectors are pre-normalized) |
| `rankPositive(scores)` | Turns raw scores into a rank list, keeping only positive-score chunks |
| `hybridRetrieve(index, queryText, queryEmbedding, k)` | The RRF fusion — returns top-k chunks |

### backend/server.js — extraction & chunking
| Function | What it does |
|---|---|
| `extractTextFromFile` | PDF/Word/TXT → plain text |
| `normalizeNumericSpacing` | Fixes `$1 000` → `$1000` (PDF artifact) |
| `chunkText` (+ `splitIntoBlocks`, `splitBySentences`, `packBlocksIntoChunks`, `applyOverlap`) | Clause-aware chunking with overlap |
| `ensureContractIndex` | Build (or reuse via sha256) the retrieval index |

### backend/server.js — money pipeline
| Function | What it does |
|---|---|
| `extractMonetaryCandidates` | Regex scan + false-positive filters → candidate list |
| `hasMoneyKeywordNearby` / `isNonMonetaryArtifact` | The filters (money words nearby; reject TOC lines, headings, doc codes) |
| `selectMonetaryExposureWithLLM` | AI labels each candidate risk/obligation (classification only) |
| `verifyMonetaryItems` (+ `findCandidateMatch`, `verifyMonetaryItemCategory`, `normalizeRawForMatch`, `jaccardSimilarity`) | Grounding: match every AI item to real text, dedup, flag possible duplicates |
| `parseNumericAmount` | "\$1.5M" → 1500000 (handles k/m/b suffixes, commas) |
| `computeLossGivenDefaultScore` | Simple deterministic risk score from the verified totals |
| `extractRiskSignals` | Regex booleans (has termination-for-convenience clause? etc.) |

### backend/server.js — LLM plumbing
| Function | What it does |
|---|---|
| `callOpenRouter` | Non-streaming AI call: loops over `LLM_PROVIDERS`, retries, JSON-mode fallback |
| `attemptProviderOnce` | One single attempt against one provider |
| `callOpenRouterStream` / `attemptProviderStreamOnce` | Same, streaming; provider fallback only before first token |
| `parseSseChunk` | Buffers partial SSE lines from the upstream provider |
| `cleanJsonResponse` / `parseJsonResponse` | Strip ```` ```json ```` fences, parse with a safe fallback value |

### backend/server.js — chat
| Function | What it does |
|---|---|
| `sanitizeChatHistory` (+ `isErrorAssistantContent`) | Server-side validation of client-sent history |
| `buildChatMessages` | System prompt + retrieved chunks + history + question |
| `parseChatAnswer` (+ `extractBulletLines`, `stripBulletPrefix`, `stripSurroundingQuotes`) | Split the answer/SOURCES/IMPLICATIONS text protocol |
| `verifyQuote` (+ `normalizeForQuoteMatch`, `buildNormalizedOffsetMap`, `findNormalizedOffset`) | The citation verifier with offset mapping and 8-word retry |
| `finalizeChatAnswer` | Runs verification on all quotes, assembles final response |
| `generateChatResponse` / `generateChatResponseStream` | The two chat entry points (share all the code above) |
| `persistChatTurn` | Saves user+assistant messages to SQLite |

### backend/server.js — analysis & persistence
| Function | What it does |
|---|---|
| `analyzeDocumentText` | Orchestrates the three AI calls into one flat analysis object |
| `generateLegalInsightsWithRAG` / `generatePMInsightsWithRAG` | Role-specific insights fed with hybrid-retrieved context |
| `getFallbackLegalInsights` / `getFallbackPMInsights` | Safe defaults when the AI call fails |
| `hydrateFromDb` | On boot: reload contracts/analyses/chunks from SQLite into memory |

### backend/db.js
`init`, `isEnabled`, `saveContract`, `saveAnalysis`, `saveChunks`, `addChatMessage`, `saveVersion`, `deleteContract`, `getChatMessages`, `getVersions`, `getContractChunks`, `hydrateAll` — all become no-ops if SQLite is unavailable.

### frontend/js/app.js (the important ones)
| Function | What it does |
|---|---|
| `render()` | Rebuilds the whole page HTML from one `state` object (no framework, no diffing) |
| `renderUploadView` / `renderInvestorView` / `renderLegalView` / `renderPMView` / `renderPartnerView` / `renderChatView` | The five role views + chat |
| `pollAnalysis` | Polls the 202-until-ready analysis endpoint |
| `streamChatMessageAPI` | SSE client; falls back to non-streaming if no token ever arrives |
| `handleSendChatMessage` | Sends a chat turn, writes tokens into `streaming-msg-content` live |
| `normalizeForQuoteMatch` / `findQuoteOffsetWithFallback` | **Client mirror** of the server's verifyQuote normalization |
| `revealCitation` | Click a citation chip → open text panel → highlight the exact quote |
| `escapeHtml` | XSS protection on all AI/user text before it enters innerHTML |
| `getChatHistory` / `openContract` | Reload persisted chat when reopening a contract |

### Tests (all deterministic, no network)
- `test-retrieval.js` — 14 tests: tokenizer, BM25, RRF fusion, fallbacks.
- `test-calculations.js` — 25 assertions: parsing, candidate filtering, grounding/dedup cases (hallucinated amount, reformatted amount, duplicate, two real same-amount fees).
- `test-chat-parse.js` — 41 assertions: answer parsing, quote verification, SSE chunk buffering, history sanitizing.
- `npm run eval` — the retrieval benchmark (~1s, offline).

---

## 11. What Makes This Project Unique (your talking points)

1. **Real RAG, built by hand** — BM25 written from the formula, local ONNX embeddings, RRF fusion. Not a LangChain wrapper. I can explain every line.
2. **Verification everywhere** — money figures grounded against source text; chat quotes verified or dropped. The AI never gets the final word on a fact.
3. **Measured, not claimed** — a committed eval harness with a gold dataset and baseline numbers, including one result that doesn't favor my system (kept for honesty).
4. **Graceful degradation as a philosophy** — embedder fails → BM25-only; index fails → keyword; SQLite fails → memory-only; OpenRouter rate-limited → NVIDIA NIM; one AI step fails → safe defaults + warning. The app never hard-crashes over a dependency.
5. **Two-provider AI integration** — automatic OpenRouter→NIM fallback with correct streaming semantics (never switch models mid-stream).
6. **Local embeddings** — $0 cost, no rate limits on indexing, document content stays on the machine (a privacy story for legal documents).
7. **No vector database — on purpose** — dot product over a few hundred pre-normalized 384-dim vectors is sub-millisecond. A vector DB would solve a scale problem this app does not have. Knowing when NOT to add infrastructure is the point.

---

## 12. Likely Interview Questions & Answers

**Q: Why RAG instead of just sending the whole contract to the model?**
A: Three reasons. Cost — you pay per token, and a 50-page contract is huge. Context limits — small/free models have small windows. Quality — models get distracted by irrelevant text ("lost in the middle" problem); giving them only the 4–6 most relevant chunks gives sharper answers. Also, retrieval gives me the exact source positions I need for verified, clickable citations — you can't do that from a blob answer.

**Q: Why hybrid retrieval? Why not just embeddings?**
A: Contracts are full of exact strings — "$50,000", "Section 12.3", "Net-30" — that semantic search under-ranks because it matches meaning, not characters. BM25 nails exact terms; embeddings catch paraphrases ("cancel anytime" vs "terminate for convenience"). RRF combines their rank lists so neither has to be right alone. My eval proves it: hybrid hit@4 is 95.8% vs 87.5% for either alone.

**Q: Why RRF instead of a weighted score combination?**
A: BM25 and cosine scores are on incompatible scales — you'd need score normalization and a tuned weight. RRF only uses rank *positions*, so it needs no normalization and no tuning, and it's the standard, well-studied approach.

**Q: Why no vector database (Pinecone, etc.)?**
A: Scale. Each contract produces tens to a few hundred chunks. A brute-force dot product over pre-normalized vectors is sub-millisecond. A vector DB solves problems (millions of vectors, ANN search, cross-document search) I don't have. I'd add one if I searched across thousands of contracts at once.

**Q: How do you stop the AI from hallucinating numbers?**
A: The AI never produces numbers on its own. JS regex extracts real candidates from the text; the AI only *labels* them risk/obligation; then every labeled item must match back to real source text (exact match, then amount-equality) or it's dropped and logged. All sums are plain JavaScript. There's also duplicate consumption so a restated fee can't be counted twice.

**Q: How do citations work?**
A: The model returns quotes in a SOURCES section. Each quote is normalized (case, curly quotes, whitespace) and searched in the equally-normalized contract text, with an offset map back to original positions. If the full quote fails, I retry its first 8 words, because models pad quote endings with invented text. If nothing matches, the quote is dropped — never shown. The matched offset powers click-to-highlight in the UI.

**Q: What was the hardest bug?**
A: The streaming abort. I used `req.on('close')` to abort the LLM call when the client disconnects — but in Express that event fires as soon as the request body finishes reading, so every stream got killed before the first token. I found it by logging inside the close handler and switched to `res.on('close')` guarded by `res.writableEnded`.

**Q: How does the second AI provider work?**
A: An ordered `LLM_PROVIDERS` array — OpenRouter first, NVIDIA NIM second (only present if its key+model are configured). Both are OpenAI-API-compatible, so one code path with per-provider URL/key/model. A 429 or 5xx skips straight to the next provider; for streaming, fallback only happens before the first token so the user never gets an answer stitched from two models. Verified live against real OpenRouter 429s.

**Q: What would you improve with more time?**
A: A paid model for reliable structured output; a bigger eval set (30 items shows direction, not significance); conversation summarization instead of hard 8-turn truncation; a schema migration runner for SQLite; multi-currency handling (right now mixed currencies sum face values); and auth/multi-user for real deployment.

**Q: Why plain-text protocol for chat instead of JSON?**
A: Free/small models constantly break JSON when writing conversational prose — unescaped quotes, truncation. A fixed plain-text layout (answer / SOURCES: / IMPLICATIONS:) parsed tolerantly is far more robust. JSON-mode is still used for the analysis calls where the output is short and structured.

**Q: What's the frontend architecture?**
A: Deliberately zero-framework: one `state` object, a `render()` that rebuilds the page HTML on every state change. One exception: streaming tokens write directly to a single DOM node, because re-rendering the whole page per token would be wasteful. All AI/user text passes through `escapeHtml` before touching innerHTML (XSS protection).

---

## 13. Honest Limitations (say these before they ask — it builds trust)

- Free default model = 50 req/day and flaky structured output (NIM fallback mitigates the quota, a paid model fixes the quality).
- MiniLM has a ~256-token input window — very long clauses lose some semantic (not lexical) context.
- Mixed currencies are summed at face value, no FX conversion (documented, not silent).
- 30-item eval = directional evidence, not statistical proof.
- Single-process, no auth, one SQLite file — a local/demo tool, not a deployed product.

---

## 14. Numbers to Memorize

- Embeddings: **MiniLM, 384 dimensions, local ONNX, L2-normalized**
- BM25: **k1 = 1.5, b = 0.75**
- RRF: **score = Σ 1/(60 + rank)**
- Chunks: **~1000–1500 chars, ~150–200 overlap**
- Retrieval: **top k = 6** chunks (4 for some analysis prompts)
- Chat memory: **last 8 turns, 2000 chars/turn cap**
- Eval: **30 items, 3 fixtures — hybrid hit@4 95.8%, MRR 0.852 vs keyword 87.5% / 0.728**
- Tests: **14 + 25 + 41 deterministic assertions**, plus the ~1s offline eval
- Duplicate flag threshold: **>60% Jaccard context overlap**
- Citation retry: **first 8 words of a failed quote**
