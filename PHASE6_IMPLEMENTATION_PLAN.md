# PHASE 6 — UI Redesign "Chambers" (formal light) — Implementation Plan

> Status: PLANNED — do not execute until explicit go.

## Context

The app works end-to-end (upload → RAG analysis → 5 role views + verified chat) but the UI is the stitch-mockup default: generic blue `#137fec`, Inter everywhere, hardcoded hex values scattered through ~1,960 lines of template strings, and inconsistent card/spacing treatment between views. Goal: make every page **more formal and attractive**. Chosen direction (user-confirmed): **formal light theme**, law-firm register, **single theme only** — the never-activated `dark:` variants get stripped from each view as it's restyled.

Entire restyle surface is two files: `frontend/index.html` (Tailwind config + inline `<style>`) and `frontend/js/app.js` (all views as template literals). Backend untouched.

## Design direction

**Palette** (replaces `#137fec` + stray hexes `#0d141b #4c739a #e7edf3 #cfdbe7 #1a242f #1a2530 #151e28`):

| Token | Hex | Use |
|---|---|---|
| `ink` | `#16232E` | Headings, primary text |
| `primary` (oxford) | `#1E3A5F` | Buttons, links, active nav, chat bubbles, fills |
| `brass` | `#B08D3E` | Verification seals, active markers, focus ring — sparingly |
| `paper` | `#F6F7F9` | Page background |
| `surface` | `#FFFFFF` | Cards, header, panels |
| `muted` | `#5B6B7C` | Labels, secondary text |
| `line` | `#DFE5EC` | Borders, dividers |

Semantic risk colors keep their meaning but deepen for formality: high `#B3362B`, medium `#B45309`, low `#1E7F5C` (update `riskLevelClasses()` at app.js:132 and `complianceDisplay()` at :143).

**Typography**: `Source Serif 4` (weights 400/600/700) for page titles, section headers, and the wordmark; Inter stays as body/UI face (already vendored). All monetary figures and scores get `font-variant-numeric: tabular-nums` via a `.figures` utility class (Inter supports `tnum` — no third font). Labels above data: 11px uppercase, letterspaced, `muted`.

**Signature element — the grounding seal**: a small brass hairline-ring badge (`◉ Verified` — thin `border-brass` circle + check, quiet) applied **only where the backend actually verified something**: monetary totals passed through `verifyMonetaryItems`, chat citation chips passed through `verifyQuote`, and passing compliance checks. It encodes the app's real differentiator (grounded, source-verified output) rather than decorating. Everything else stays disciplined so the seal reads.

**Layout**: keep every view's existing structure (iframe doc viewer + analysis sidebar, tab strips, chat rail) — this is a restyle, not an IA change. Unify: one page-header band (breadcrumb → serif title → context), one card recipe (`bg-surface border border-line rounded-lg shadow-sm`), consistent sidebar padding/scroll treatment.

## Implementation steps

### 1. Fonts — self-host Source Serif 4 (matches existing `/vendor` pattern)
- Download woff2 for weights 400/600/700 (latin) from Google Fonts/gstatic into `frontend/vendor/fonts/`.
- Create `frontend/vendor/source-serif.css` with the `@font-face` rules (mirror `inter.css` format); link it in `index.html`.
- Fallback stack everywhere: `"Source Serif 4", Georgia, serif` — page still looks right if the file fails.

### 2. `frontend/index.html` — theme foundation
- Rewrite the inline `tailwind.config`: `colors: { ink, primary, brass, paper, surface, muted, line }` (keep `background-light` temporarily aliased to `paper` until all templates are migrated, then delete), `fontFamily: { display: ["Source Serif 4", Georgia, serif], sans: [Inter...] }`.
- Update the inline `<style>` block: spinner color → `primary`; scrollbar colors → `line`/`muted`; drop dark-mode scrollbar rules; add `.figures { font-variant-numeric: tabular-nums }`, `.seal` (brass ring badge), and a `@media (prefers-reduced-motion: reduce)` guard for `fadeInUp`/pulse animations.
- Update `<body>` classes to `bg-paper text-ink`; add a simple inline-SVG data-URI favicon (brass seal mark).

### 3. `frontend/js/app.js` — restyle every renderer (the bulk)
Add three tiny global helpers near the existing `riskLevelClasses()` to enforce consistency, then use them in all views:
- `card(inner, extra)` → the one card recipe
- `sectionLabel(text)` → 11px uppercase muted label
- `sealBadge(text)` → the brass grounding seal (used by `renderGroundingBadge()` at app.js:93, citation chips, compliance passes)

Then per renderer (strip `dark:` classes as each is touched):
- **`renderHeader()`** (:543) — white `surface` bar, serif wordmark, nav links with a 2px brass underline on the active item (replaces `text-primary`-only state), refined contract-name pill.
- **`renderUploadView()`** (:587) + `renderRecentFileCard()` (:637) — serif hero headline, quieter dropzone (solid `line` border, primary on hover), oxford primary button + ghost secondary, recent-document cards on the shared card recipe.
- **`renderInvestorView()`** (:655) — stat cards become "ledger" cards: `sectionLabel` + tabular figure + seal on the verified exposure total; LGD progress track in `line`/fill `primary`; financial breakdown rows get hairline `line` dividers and `.figures`; keep `switchInvestorTab`/`toggleSourceRow` hooks intact.
- **`renderPartnerView()`** (:902) — same ledger-card treatment for the 4 stats; compliance pass-ratio bar → `low`-green fill on `line` track; clause-flag cards on the card recipe.
- **`renderLegalView()`** (:1051) — metric grid + compliance checks list restyled (pass items get the seal, warnings keep amber/red); versioning timeline keeps numbered badges but in `ink`/`brass`.
- **`renderPMView()`** (:1218) — remove the `dark:bg-background-dark` wrapper; section headers become serif with `primary` icons; timeline rail → `line` with `primary` dots; action-item checklist on card recipe.
- **`renderChatView()`** (:1366) + `renderChatMessage()` (:1460) — icon rail and chat panel on `surface`/`line`; user bubbles `bg-primary text-white`, assistant bubbles `surface` + `line` border; citation chips become seal chips (brass ring, `policy` icon retained); quick-question chips ghost-styled. **Keep `id="streaming-msg-content"` on the same `<p>` and the blinking caret span — the token-streaming path at ~:1760 writes into it by id.**
- **`renderExtractedTextPanel()`** (:264) — card recipe; keep `<mark id="citation-highlight">` (retint to a soft brass/amber that meets contrast).
- **`renderLoadingView()`** (:1534) — spinner + serif "Analyzing contract…" line, list the actual steps (extracting, indexing, analyzing) as quiet muted text.
- Update `riskLevelClasses()` / `complianceDisplay()` hexes per palette table.

**Do not touch:** function names/globals (inline `onclick` needs them), element ids (`chatInput`, `chatMessages`, `streaming-msg-content`, `citation-highlight`), the iframe file viewers, `normalizeForQuoteMatch`/`findQuoteOffsetWithFallback` logic, or anything in `backend/`.

### 4. Cleanup
- Remove the dead `input[name="role-selector"]` listener (app.js:1903) — no template emits it.
- After all views are migrated, delete the old `background-light`/`background-dark` tokens and grep `frontend/` for leftover `dark:` / stray old hexes (`#137fec`, `#4c739a`, `#cfdbe7`, `#e7edf3`).

## Verification

1. `cd backend && npm start`, open `http://localhost:8080`.
2. Upload a synthetic fixture from `backend/eval/fixtures/` (never `backend/uploads/`), wait for analysis, and walk all six screens: Upload, Investor (both sidebar tabs + source-row toggles), Legal (Analysis + Versioning tabs), PM (all three tabs), Partner, Chat.
3. In Chat: send a question, confirm token streaming renders into the styled bubble, then click a citation chip → extracted-text panel opens with the brass highlight.
4. Responsive pass: narrow the window to ~380px on each view — no horizontal body scroll; check keyboard focus visibility on nav, buttons, chat input.
5. `npm test` still passes (frontend-only change; this is a regression tripwire).
6. Grep check from cleanup returns nothing.
