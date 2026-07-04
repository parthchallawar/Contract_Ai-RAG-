# Phase 3 — Chatbot Upgrade: Memory, Streaming, Verified Citations (ContractAI)

## Context

The chatbot is a stateless one-shot Q&A endpoint wearing a chat UI. Three user-felt defects, confirmed in code:

1. **No memory.** `sendChatMessageAPI` (`frontend/js/app.js:234`) sends only `{contractId, message, role}`; the backend never sees prior turns. A follow-up like *"is that normal?"* has no referent — the single worst UX flaw in the app.
2. **No streaming, fragile JSON.** `generateChatResponse` forces the free model to wrap a conversational answer in strict JSON; a malformed reply surfaces to the user as a literal `ERROR:` string, and the user watches a static spinner for the full generation time.
3. **Unverified citations.** The prompt *demands* verbatim quotes but nothing checks them — the model can (and does) invent citations; they render as dead text (`app.js:1134-1139`), not linked to the document.

Phase 3 fixes all three: history-aware prompting + retrieval, token streaming over SSE, plain-text answers with **post-hoc verified, click-to-highlight citations**. Two latent chat-UI bugs that multi-line streamed content would detonate are fixed as part of this: raw `innerHTML` injection of message content (XSS / broken markup on `<`,`>` in answers) and the copy button's inline `onclick` that breaks on newlines/apostrophes (`app.js:1149`).

**Files:** MODIFIED `backend/server.js` (chat section only), `frontend/js/app.js` (chat view/handlers only); NEW `backend/test-chat-parse.js`. Depends on Phase 0 only (`callOpenRouter`, `buildRelevantContext`); if Phase 1 is implemented, its hybrid retrieval is picked up automatically through `buildRelevantContext` with zero changes here.

---

## Part 1 — Conversation memory

### 1a. Frontend sends history
- `sendChatMessageAPI(contractId, message, role)` gains a `history` field: `state.chatMessages.slice(-8)` mapped to `{ role, content }` only (strip citations/implications/timestamps), **excluding**: the just-pushed current user message, any `isLoading` placeholder, and any assistant message whose content starts with `ERROR:`/`Sorry, I encountered an error`.
- Truncate each turn's content to 2,000 chars (protects the prompt budget against pasted walls of text).

### 1b. Backend uses history twice
- **Validation** (new `sanitizeChatHistory(history)`): must be an array ≤ 8 items, each `{role ∈ {'user','assistant'}, content: string}`; anything else → treated as empty. Truncate to 2,000 chars/turn server-side too (never trust the client).
- **Prompting:** messages array becomes `[system, ...history, user(current question + excerpts)]` — real multi-turn structure, not history stuffed into one string. The excerpts block stays in the final user message so the model treats it as fresh context.
- **Retrieval query blending:** follow-ups pronoun-reference earlier turns, so retrieval on the current message alone fails. Query = `lastUserTurn + ' ' + currentMessage` (last user turn from history, if any). Passed to `buildRelevantContext` — works identically for Phase 0 keyword retrieval and Phase 1 hybrid.

## Part 2 — Streaming (SSE)

### 2a. Backend: `POST /api/chat/stream`
New endpoint **alongside** the existing `/api/chat` (kept as regression fallback). Flow:
- Validate contract/history exactly like the non-streaming path; build the same messages array.
- Call OpenRouter with `stream: true` via new helper `callOpenRouterStream(messages, { onToken, timeoutMs })` — separate from `callOpenRouter` (retry semantics differ: **retry only if the failure occurs before the first token**; after tokens have flowed, emit what we have + an error event).
- **SSE plumbing:** `res.writeHead(200, {'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'})`; events written as `data: ${JSON.stringify(evt)}\n\n` with `evt.type ∈ {'token','done','error'}`.
  - `token`: `{ type:'token', text }` per delta.
  - `done`: `{ type:'done', message }` where `message` is the same final shape the old endpoint returns (`content`, `citations`, `implications`, `perspective`, `timestamp`) — after post-processing (Part 3).
  - `error`: `{ type:'error', message }` then `res.end()`.
- **Upstream SSE parsing (critical known bug source):** OpenRouter sends `data: {json}` lines ending with `data: [DONE]`; chunks can split lines mid-JSON. Buffer incoming bytes, split on `\n`, keep the trailing partial line in the buffer; deltas at `choices[0].delta.content`.
- **Client disconnect:** `req.on('close', …)` aborts the upstream fetch via `AbortController` — no orphaned OpenRouter calls.

### 2b. Frontend: fetch-reader client with graceful fallback
`EventSource` is GET-only, so use `fetch(POST)` + `response.body.getReader()` with the same buffered line-splitting.
- `handleSendChatMessage` (`app.js:1341`) keeps its existing `loadingMessage` Object.assign pattern:
  1. Push placeholder `{ role:'assistant', content:'', streaming:true }`, `render()` once. The chat renderer gives the streaming message's content node a stable id (`id="streaming-msg-content"`).
  2. Per `token` event: append to `loadingMessage.content` (state stays source of truth) **and** update the DOM node directly via `getElementById` — no full `render()` per token. If the node is missing (user navigated views mid-stream), skip the DOM write; state still accumulates.
  3. On `done`: `Object.assign(loadingMessage, finalMessage, { streaming:false })`, full `render()`.
- **Fallback:** if the stream request throws before any token (network error, non-200), transparently retry once via the old non-streaming `sendChatMessageAPI`. If tokens already flowed, keep partial content + show a small "response interrupted" note.

## Part 3 — Plain-text answers + post-hoc verified citations

### 3a. New output protocol (no JSON for chat)
System prompt asks for exactly this layout:
```
<natural-language answer, plain text>

SOURCES:
- "<short verbatim quote from the excerpts>"
- "<another quote>"

IMPLICATIONS:
- <one-line implication>
```
`SOURCES`/`IMPLICATIONS` sections optional. Streaming displays everything live; the sections are stripped from the displayed content at `done`.

### 3b. Parser + verifier (pure functions in `server.js`, exported for tests)
- `parseChatAnswer(rawText)` → `{ content, quotes: string[], implications: string[] }`. Tolerant: sections matched case-insensitively (`/^SOURCES:\s*$/mi`), bullets accept `-`/`*`/`•`, quotes with or without surrounding `"…"`. Absent sections → empty arrays; malformed section lines ignored, never thrown.
- `verifyQuote(quote, text)` → `{ offset } | null`. Normalized matching (the whole point — PDF extraction mangles whitespace): lowercase both, collapse `\s+` to single spaces, strip straight/curly quote chars, then `indexOf` over a same-way-normalized copy of `text` with an offset map back to original coordinates. If no match and the quote has ≥ 8 words, retry with its first-8-word prefix (models pad quote tails). Still no match → **citation dropped** (never shown unverified).
- Final message: `citations = verified.map(v => ({ quote, offset }))` — note the shape change from `string[]` to objects; the renderer is updated in the same phase so nothing else consumes it.
- The old `/api/chat` endpoint switches to the same prompt + parser (shared code path, minus streaming), so both endpoints return identical shapes.

### 3c. Chat rendering fixes (`renderChatMessage`, `app.js:1108`)
- **Escape all model/user content** with existing `escapeHtml` (`app.js:74`) before interpolation; render newlines as `<br>` after escaping. Fixes the latent XSS/markup-break and makes multi-line streamed answers display correctly.
- **Copy button:** replace `onclick="copyToClipboard('${content.replace(...)}')"` with `onclick="copyChatMessage(${index})"` reading from `state.chatMessages[index]` — immune to quotes/newlines. `renderChatView`'s message map passes the index.
- Citations render as clickable chips: `onclick="revealCitation(${msgIndex}, ${citIndex})"`, labeled with a truncated quote (~60 chars, escaped).

## Part 4 — Click-to-highlight citations in the document panel

Reuses the existing extracted-text infrastructure (`loadExtractedText` `app.js:83`, `renderExtractedTextPanel` `app.js:114`, `state.showExtractedText`):
- `revealCitation(msgIndex, citIndex)`: set `state.showExtractedText = true`, `state.highlightQuote = quote`, await `loadExtractedText()` if text not yet loaded, `render()`.
- `renderExtractedTextPanel`: when `state.highlightQuote` is set, find it in the (escaped) panel text using the **same normalization as `verifyQuote`** (duplicate the tiny normalizer client-side) and wrap the first match in `<mark id="citation-highlight" class="bg-amber-200 dark:bg-amber-700/60 rounded px-0.5">`.
- After `render()`, `document.getElementById('citation-highlight')?.scrollIntoView({ block:'center', behavior:'smooth' })`.
- Highlight clears when a new citation is clicked or the panel is toggled closed (`toggleExtractedText` resets `state.highlightQuote`).
- Note: the chat view must include the extracted-text panel — verify `renderChatView` includes/can include `renderExtractedTextPanel()`; if it doesn't, add it (collapsible, same as other views) as part of this phase.

## Part 5 — Tests: NEW `backend/test-chat-parse.js`

Pure unit tests (no server/network), same export pattern as Phase 2 (`module.exports` from server.js guarded by `require.main === module` — if Phase 2 already added the guard, just extend the exports):
- `parseChatAnswer`: full three-section reply; answer-only reply; sections in lowercase; `*` bullets; quotes without `"`; SOURCES with zero bullets; garbage between sections → parsed leniently, never throws.
- `verifyQuote`: exact match; whitespace-mangled match (`"liability  cap of\n$50,000"` vs source `"liability cap of $50,000"`); curly-quote normalization; ≥8-word quote with hallucinated tail → matches via prefix; genuinely absent quote → null; offset maps back to the ORIGINAL text (assert `originalText.slice(offset, …)` normalizes to the quote).
- SSE line-buffer helper (if extracted as a function): chunk split mid-JSON reassembles correctly; `[DONE]` terminates.
- History sanitizer: >8 turns trimmed; bad roles dropped; ERROR turns filtered; non-array → [].

## Explicit non-goals
- No persistence of chat history (in-memory `state.chatMessages` only; SQLite is Phase 4).
- No verification of Legal-analysis `quote` fields (same `verifyQuote` helper is deliberately generic so Phase 4/2 can adopt it, but wiring it there is out of scope).
- No token-budget management beyond the per-turn truncation caps; no summarization of long histories.
- No change to analysis pipeline, retrieval internals, or any non-chat view.

## Verification
1. **Unit:** `node backend/test-chat-parse.js` all green; `node -c server.js`; `npm start` unaffected.
2. **Memory:** upload `test.txt` → ask "What is the liability cap?" then **"Is that amount typical?"** → second answer must resolve "that amount" to $2.00 (server log shows blended retrieval query + 2-turn history in the prompt).
3. **Streaming:** watch tokens appear incrementally in the UI; server log shows stream completion; kill the network mid-stream (dev-tools offline) → partial content kept + "interrupted" note; break the stream endpoint URL temporarily → transparent fallback to non-streaming answer.
4. **Citations:** ask a question with a known verbatim clause → citation chip appears (verified); click → extracted-text panel opens, quote highlighted and scrolled into view. Hard-code a fake quote into a dev test → chip does NOT appear (dropped by verifier).
5. **Safety/regression:** paste `<img src=x onerror=alert(1)>` into chat → renders as literal text (escaping works); copy button works on multi-line answers with apostrophes; navigating views mid-stream doesn't throw; old `/api/chat` still returns the new shape correctly (curl); non-chat views and analysis flows untouched.
