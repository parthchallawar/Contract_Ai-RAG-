# ContractAI

An AI-powered contract analysis tool: upload a PDF/DOCX/TXT contract, get role-specific analysis (Investor, Legal, PM, Partner) backed by a real hybrid-retrieval RAG pipeline, and chat with the document using verified, click-to-highlight citations.

This is a from-scratch build, not a wrapper around a single LLM call — it has its own local embedding + BM25 retrieval layer, a numeric grounding/verification pass on every monetary figure, streaming chat with conversation memory, SQLite persistence, and a committed evaluation harness with measured retrieval numbers (see [Evaluation](#evaluation) below).

## Architecture

```
                                Browser (vanilla JS SPA)
                                        |
                                  HTTP / SSE
                                        |
                              Express server (server.js)
                                        |
        +-------------------+----------+----------+-------------------+
        |                   |                     |                   |
  extract & normalize   clause-aware        role-scoped LLM      chat (streaming,
  (pdf-parse / mammoth)  chunking           analysis (OpenRouter)  memory, verified
        |                   |                     |                citations)
        |             +-----+------+               |                   |
        |             |            |               |                   |
        |        MiniLM embeds   BM25 index         |                   |
        |        (local, ONNX)  (in-process)         |                  |
        |             |            |                                    |
        |             +-----+------+                                    |
        |                   |                                           |
        |         Reciprocal Rank Fusion (hybrid retrieval)  <----------+
        |                   |
        +-------------------+----------------------------------+
                                                                 |
                                                          SQLite (data.sqlite)
                                                    contracts / analyses / chunks+
                                                    embeddings / chat history / versions
```

- **Extraction & normalization** — `pdf-parse`/`mammoth`, with a numeric-spacing fixup pass (PDF extraction mangles `$1,000` into `$1 000` constantly).
- **Clause-aware chunking** — splits on headings/paragraphs first, falls back to sentence boundaries, never mid-sentence; overlap between chunks so retrieval doesn't lose context at boundaries.
- **Hybrid retrieval** — every chunk gets a local MiniLM embedding (`Xenova/all-MiniLM-L6-v2`, ONNX runtime, no API calls) and a BM25 posting; a query fuses both rankings with Reciprocal Rank Fusion (`score = Σ 1/(60 + rank)` across legs). Falls back to BM25-only if the embedder fails to load, and to Phase-0 keyword scoring if the index itself is missing — the app never hard-fails because of retrieval.
- **Analysis pipeline** — three LLM calls (monetary exposure, legal insights, PM insights) each fed hybrid-retrieved context; the LLM *classifies* monetary candidates, but **JS sums them locally** for arithmetic accuracy, and every classified amount is verified against the source text before it counts toward a total (see [Grounding](#numeric-grounding) below).
- **Chat** — multi-turn history-aware prompting, SSE token streaming, and a plain-text answer protocol (`answer / SOURCES: / IMPLICATIONS:`) instead of forcing the model into JSON for a conversational reply. Every cited quote is verified as a real substring of the source text (whitespace/quote-normalized) before it's shown; unverifiable quotes are silently dropped.
- **Persistence** — `better-sqlite3`, write-through from the in-memory Maps that still serve every read. If the native module isn't available on a given platform, the app degrades to memory-only rather than failing to start.

## Design decisions & trade-offs

**Local embeddings over an embedding API.** `@xenova/transformers` runs MiniLM in-process via ONNX — $0 marginal cost, no network round-trip per chunk, no rate limits on indexing. Trade-off: 384 dimensions and a ~256-token input window (hence `targetSize: 1000` chars for the embedding index) is meaningfully weaker than a large hosted embedding model on genuinely ambiguous semantic queries. For this app's actual query patterns (role-scoped analysis prompts, contract Q&A) it's been sufficient — see the measured hit-rates below.

**Brute-force cosine over a vector DB.** Chunk counts per contract run from single digits to a few hundred; embeddings are pre-normalized so cosine similarity is a plain dot product. A dot product over a few hundred 384-dim vectors is sub-millisecond — there is no query-latency problem a vector database would be solving here. It would be the right call at a very different scale (many thousands of chunks per query, or search across contracts rather than within one).

**Hybrid (BM25 + embeddings) over pure semantic search.** Contracts are full of exact-match-critical strings — section numbers, defined terms, dollar figures — that a purely semantic retriever routinely under-ranks. BM25 catches those; embeddings catch paraphrases a keyword scorer would miss entirely (see the eval's paraphrase-trap items). RRF fusion means neither leg has to be "right" alone.

**LLM classifies, JS sums.** Free-tier and small models are unreliable at exact arithmetic over long lists. The LLM's only job is to label each monetary candidate as a risk or an obligation; every sum, and every "does this classified amount actually appear in the source text" check, is deterministic JS. Nothing invented by the model reaches a total without surviving verification.

**Verified citations or nothing.** Both the Legal-analysis clause quotes and the chat citations are checked against the source text with a normalized substring match (case/whitespace/quote-style insensitive, with an 8-word-prefix retry for quotes the model pads with a plausible-sounding but fabricated tail). A citation that doesn't verify is dropped, not shown with a caveat — the alternative erodes trust in the ones that *are* real.

## Evaluation

A committed, synthetic (PII-free), paraphrase-trap-containing dataset (`backend/eval/dataset.json`, 30 items across 3 fixture contracts) drives `backend/eval/run-eval.js`. Default mode is fully deterministic and offline — no LLM calls, no network beyond loading the local embedding model once:

```bash
cd backend
npm run eval          # deterministic: retrieval mode comparison, ~1s
npm run eval:llm       # + numeric grounding and chat citation checks (uses OpenRouter, non-deterministic, costs API calls)
```

Committed baseline (`backend/eval/results/BASELINE.json`), retrieval hit-rate/MRR across three retrieval modes on the same 24 retrieval items:

| Mode | hit@4 | hit@6 | MRR |
|---|---|---|---|
| keyword (Phase 0) | 87.5% | 95.8% | 0.728 |
| BM25 only | 87.5% | 91.7% | 0.747 |
| **hybrid (BM25 + embeddings, RRF)** | **95.8%** | 95.8% | **0.852** |

Hybrid wins outright on hit@4 and MRR — including on the deliberate paraphrase-trap items where keyword/BM25 share no vocabulary with the question by design. One honest wrinkle, kept rather than hidden: keyword mode edges out BM25 specifically at hit@6 (95.8% vs 91.7%), a real result from this dataset's specific phrasing, not a bug.

**Honesty notes:**
- This dataset was written and committed *before* any retrieval tuning against it. If retrieval code is ever tuned to chase these specific numbers afterward, that's optimism bias on a 30-item hand-written set, not a generalizable claim — flagging it here is the whole point of writing this down.
- The `--llm` run (numeric grounding rate, chat citation verification rate) depends on the configured model's daily quota and quality; those numbers are non-deterministic and not part of the committed baseline. See [Known limitations](#known-limitations).

### Numeric grounding

Every monetary figure the LLM reports is checked against the actual source text (exact match, then amount-equality for reformatting like `"$50,000"` → `"50000 USD"`) before it's summed into a total; unverifiable or duplicate-restated figures are dropped and surfaced in `analysisWarnings` rather than silently skewing the number. `backend/test-calculations.js` covers the grounding/dedup logic directly (hallucinated amount, reformatted amount, restated duplicate, two genuinely separate same-amount fees, soft-flagged possible-duplicates) — 25 assertions, deterministic, no LLM required.

## Setup

Requires Node 20+.

```bash
cd backend
npm install
cp .env.example .env      # then edit .env and add your OPENROUTER_API_KEY (see openrouter.ai/keys)
npm start                 # -> http://localhost:8080
```

Optional: set `NIM_API_KEY` + `NIM_MODEL` (see `.env.example`) to enable NVIDIA NIM as an automatic fallback provider — every LLM call tries OpenRouter first, and only falls through to NIM if OpenRouter fails *before* producing any content (e.g. its daily rate limit is hit). Leave both unset to run OpenRouter-only.

`npm test` runs the full deterministic unit-test suite (retrieval, monetary grounding, chat parsing — no server, no network). `npm run eval` runs the retrieval evaluation harness.

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | `{ status, timestamp, persistence: 'enabled'\|'disabled' }` |
| GET | `/api/contracts` | List (summary fields only) |
| GET | `/api/contracts/:id` | Full contract record |
| GET | `/api/contracts/:id/file` | Streams the stored upload |
| POST | `/api/contracts/upload` | Multipart `file` + `role`; analysis runs async |
| POST | `/api/contracts/:id/version` | New version; re-analyzes, prior version snapshotted |
| GET | `/api/contracts/:id/analysis` | 202 while analyzing, 200 with the analysis when done |
| GET | `/api/contracts/:id/text` | Extracted text + numeric figures |
| PATCH | `/api/contracts/:id/role` | Change role, re-runs analysis async |
| DELETE | `/api/contracts/:id` | Removes the record, its file, and all persisted rows |
| GET | `/api/contracts/:id/chat` | Last 50 persisted chat messages |
| POST | `/api/chat` | Non-streaming chat turn; `{ contractId, message, role, history }` |
| POST | `/api/chat/stream` | Same, over Server-Sent Events (token/done/error events) |

## Known limitations

- **Single-currency arithmetic.** Mixed-currency contracts sum face values numerically with no FX conversion — a documented, not silent, limitation.
- **256-token embedding window.** MiniLM chunks are capped at ~1000 characters for embedding; very long individual clauses can lose some context in the semantic (not lexical) retrieval leg.
- **Free-model flakiness.** The default configured model (`nemotron-3-nano-30b-a3b:free` on OpenRouter) has a 50-request/day quota and noticeably less reliable structured output than a paid model — visible in this repo's own eval runs, where the free model sometimes classifies zero monetary items on a contract that clearly has them. A small paid model (see `.env.example`) is recommended for anything beyond a quick demo. An optional NVIDIA NIM fallback (`NIM_API_KEY`/`NIM_MODEL`) mitigates the daily-quota problem specifically — verified end-to-end: OpenRouter 429s are detected before any content is produced and the call transparently retries against NIM, for both the streaming and non-streaming chat paths and the analysis pipeline.
- **Small eval set.** 30 hand-written items across 3 synthetic fixtures is enough to validate the retrieval-mode comparison directionally, not enough to claim statistical significance.
- **No auth, no multi-user, no cloud deploy.** Single-process, single SQLite file, meant for local/demo use.

## License

MIT — see [LICENSE](LICENSE).
