# Demo Script (~3 minutes)

A scripted walkthrough for showing ContractAI live — upload → analysis → chat → persistence →
eval, in that order, each step proving one specific claim.

## Setup (before you start the clock)

```bash
cd backend
npm install
cp .env.example .env   # add your OPENROUTER_API_KEY
npm start               # -> http://localhost:8080
```

Have `backend/eval/fixtures/construction-subcontract.txt` handy to upload (it's already in the
repo — no need to find a real contract).

## The walkthrough

1. **Upload** `construction-subcontract.txt` on the Upload view, role = Legal.
   - Say: *"This is one of the synthetic contracts in the committed eval set — no real client
     data touches this demo."*

2. **Analysis appears** (Legal or Investor view). Point at:
   - The **grounding badge** on the Financial Breakdown panel ("All N verified in source" or
     "K of N verified · M rejected"). Say: *"Every dollar figure here was checked against the
     actual contract text before it counted toward this total — the LLM classifies, but it
     doesn't get to just assert a number."*
   - The **LGD breakdown line** under the LGD stat ("$loss ÷ $owed = X%"). Say: *"The ratio math
     itself is plain JS, not the model — the model's only job was classifying which figures are
     risks vs. obligations."*

3. **Financial tab → click a source-reveal icon** next to a risk/obligation line. The verbatim
   source snippet expands inline. Say: *"That's the actual grounding check, visible — not just
   claimed."*

4. **Chat → paraphrase question** (semantic retrieval win). Ask:
   > "Can the contractor just walk away from the deal without a reason?"

   The contract's actual clause says *"terminate this Subcontract for its own convenience"* —
   no shared vocabulary with the question. Say: *"A keyword search would score this near zero;
   the hybrid retriever's semantic leg is what finds it."*

5. **Follow-up pronoun question** (conversation memory). Ask:
   > "How much notice do they have to give?"

   Watch it resolve "they" to the contractor's convenience-termination clause from the prior
   turn, not ask you to repeat context. Say: *"The server blends the last user turn into the
   retrieval query specifically so a bare follow-up like this still retrieves the right chunk."*

6. **Click a citation chip** on the chat answer. The extracted-text panel opens and the cited
   quote is highlighted and scrolled into view. Say: *"That citation was verified as a real
   substring of the contract before it was ever shown — if it weren't, the chip wouldn't exist."*

7. **Kill the server** (`Ctrl+C` or `taskkill`), then **restart** (`npm start`). Reload the page —
   the contract, its analysis, and the chat history are all still there. Say: *"Everything
   write-throughs to SQLite; a crash five minutes before a demo doesn't wipe it."*

8. **Run the eval live**:
   ```bash
   npm run eval
   ```
   Completes in about a second. Point at the printed table. Say: *"This is the same dataset
   committed to the repo, written before any retrieval tuning — hybrid retrieval measurably
   beats both baselines on this contract's paraphrase-trap questions."*

## Resume bullets (wired to `backend/eval/results/BASELINE.json`)

> Built a hybrid RAG retrieval pipeline (local MiniLM embeddings + BM25, fused via Reciprocal
> Rank Fusion) that improved retrieval hit-rate@4 from 87.5% (keyword baseline) to 95.8%
> (MRR 0.728 → 0.852), measured on a committed 30-item evaluation harness with deliberate
> paraphrase-trap test cases.

> Implemented a numeric-grounding verification layer that checks every LLM-classified monetary
> figure against the source contract text before it contributes to a financial total, dropping
> hallucinated or duplicate-restated amounts rather than silently including them.

> Built a streaming (SSE) chat interface with multi-turn conversation memory and a citation
> verification system — every cited quote is checked as a real, normalized substring of the
> source document before being shown, with click-to-highlight navigation back to the source.

> Added SQLite persistence (write-through from an existing in-memory-Map architecture) so the
> app survives a restart with zero changes to the read path, with graceful degradation to
> memory-only if the native module is unavailable.

(Numbers are pulled from `BASELINE.json` — regenerate and re-check before quoting them if you've
touched retrieval code since.)

## Five hard interview questions, answered honestly

**"Why not a real vector database?"**
Chunk counts per contract run from single digits to a few hundred; a dot product over a few
hundred pre-normalized 384-dim vectors is sub-millisecond. There's no query-latency problem a
vector DB would solve at this scale — it would matter at many-thousands-of-chunks-per-query or
cross-contract search, which this app doesn't do (yet).

**"Why local embeddings instead of an embeddings API?"**
Zero marginal cost, no network round-trip per chunk, no rate limit on indexing a big contract.
The trade-off is real: 384 dimensions and a ~256-token window is weaker than a large hosted
model on genuinely ambiguous semantic queries. It's been sufficient for this app's actual query
patterns — that's an empirical claim the eval harness backs up, not an assumption.

**"Isn't your eval set biased since you wrote it?"**
Yes, and it's small (30 items, 3 synthetic contracts) — flagged explicitly in the README. It's
enough to validate the *direction* of a claim (hybrid beats both baselines, including on
paraphrase traps by construction) but not enough to claim statistical significance. It was also
committed before any retrieval tuning, specifically so tuning-to-the-test-set isn't silently
baked into the numbers.

**"What about mixed-currency contracts?"**
Not handled — amounts sum as face-value numbers regardless of currency symbol, with no FX
conversion. Documented as a known limitation rather than silently wrong; a real fix would need a
currency-aware extraction step and a conversion-rate source.

**"Why a free-tier model if it's this unreliable?"**
Cost, for a personal project. It's a real trade-off, not a hidden one: the free model has a
50-request/day cap and visibly flakier structured-output quality than a paid model — visible in
this repo's own `--llm` eval runs, where it sometimes classifies zero monetary items on a
contract that clearly has them. `.env.example` documents swapping in a small paid model
(Haiku/GPT-4o-mini/Flash-tier), and the architecture doesn't change at all if you do — it's a
one-line env var.
