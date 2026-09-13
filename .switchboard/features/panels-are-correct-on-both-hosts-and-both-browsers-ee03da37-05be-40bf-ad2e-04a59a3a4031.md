# Panels Are Correct on Both Hosts and Both Browsers

**Complexity:** 6

## Goal

Four webview correctness plans that each fail on a host or browser nobody tested: Chrome-only scrollbars, an unsafe-inline CSP, two markdown renderers behind a seam, and an editor that drifts out of level with its preview.

## How the Subtasks Achieve This

- **Every panel styles its scrollbars for Chrome only, and the board has no Firefox rules at all**: adds a Firefox `scrollbar-width`/`scrollbar-color` pair beside each existing `::-webkit-scrollbar` rule across all 12 webview HTML files, plus a per-selector contract test, so the cockpit renders as one themed surface in Firefox instead of dark UI framed by off-theme OS scrollbars. `kanban.html` (the board) is the most-seen zero-coverage surface and goes first.
- **Harden panel CSP — remove `script-src-attr 'unsafe-inline'` from both hosts**: sets `script-src-attr 'none'` in the 8 CSP definitions that currently carry `'unsafe-inline'` (5 standalone header CSPs + 3 shared `<meta>` tags) and converts the 3 inline event-handler attributes to `addEventListener`, closing the one CSP directive that permits the exact XSS vector every `innerHTML` sink is exposed to.
- **One markdown renderer for both hosts — retire the `markdown.api.render` seam**: replaces the 11 `executeCommand('markdown.api.render', …)` call sites with a single shared `renderMarkdownToHtml()` service imported by both composition roots, so both hosts call one function and the untestable VS Code built-in seam is deleted. The standalone host is the durable surface — the extension stops rendering at the standalone-release cutover with no overlap period, so the shared service is what survives.
- **The Editor and the Preview Stay Level**: bounds the markdown-editor shell so both panes scroll internally, then content-anchored piecewise-linear scroll sync re-locks the textarea and preview at every heading/image/code-block anchor, so the content at the top of one pane is the content at the top of the other — across images, keystrokes, re-renders, and image loads.

## Dependencies & sequencing

- The four subtasks touch **disjoint regions** of the files they share; there is no internal hard dependency and no contradiction on any shared surface.
- Three subtasks edit the same four panel HTML files (`planning.html`, `design.html`, `project.html`, `tickets.html`) — scrollbar CSS blocks, the CSP `<meta>` tag, and the editor's container height chain are all different regions of those files. Recommended merge order to minimise conflict surface: **CSP first** (smallest, one-line-per-site mechanical), then **scrollbar** (additive mechanical CSS), then **editor** (largest structural change to the height chain). Any order is conflict-free; this order is the cheapest to review.
- The **renderer** subtask touches none of those four HTML files (it edits provider `.ts` files, `bootstrap.ts`, and adds a new service module), so it is fully parallel with the other three.
- The renderer subtask's external blocker (`fix-kanban-plan-preview-dead-in-standalone`) is already met in HEAD — its `markdown.api.render` registration lives at `src/standalone/bootstrap.ts:1835` and `marked`/`dompurify`/`jsdom` are direct dependencies. No wait.
- The editor subtask carries its own external serialisation notes (tickets edit-mode plans, inline-images plan) recorded in its own Dependencies section; those are the subtask's concern, not a feature-level ordering constraint.

## Team Dispatch Instructions

### Every panel styles its scrollbars for Chrome only, and the board has no Firefox rules at all
- **Seat:** Intern (complexity 3)
- **Acceptance:**
  - The per-selector pairing contract test passes: every `::-webkit-scrollbar` selector in every `src/webview/*.html` also carries `scrollbar-width` and `scrollbar-color`.
  - The contract test **fails before the fix** on the four zero-coverage files (`kanban.html`, `design.html`, `planning.html`, `implementation.html`).
  - No `input-security` declaration is added anywhere in `src/webview/`.
  - In Firefox, the board's column scrollbars are thin and themed, not OS default; nested panes in `terminals.html` did not inherit the outer pane's colours.
- **Must not touch:** the `-webkit-text-security` token-masking fallback in `transport.js` (already correct); `-webkit-font-smoothing` rules (accepted cross-engine difference, nothing to add).

### Harden panel CSP — remove `script-src-attr 'unsafe-inline'` from both hosts
- **Seat:** Intern (complexity 3)
- **Acceptance:**
  - The inline-handler grep (`\son[a-z]+\s*=\s*["']` across `src/webview/*.html` and `*.js`) returns 0 hits after the change (was 3).
  - All 8 CSP definitions that previously carried `'unsafe-inline'` now carry `script-src-attr 'none'` (5 in `headlessPanelHtml.ts`, 3 `<meta>` tags); the contract test pins the count to 8.
  - The PRD project-picker modal still closes from both its `×` and Cancel buttons in both hosts.
  - An `onerror` injected into a panel `innerHTML` sink does not execute in either host (CSP violation logged, probe flag undefined).
- **Must not touch:** DOM property assignments (`el.onclick = …` — not CSP-governed); `'unsafe-eval'` in `script-src` and `frame-src` (out of scope, owned by the iframe-sandbox assessment); the omitting panels (`setup`, `connections`, `memo`, `dock`, `terminals`, `linear`) — already safe by fallback, adding `'none'` to them is out of scope.

### One markdown renderer for both hosts — retire the `markdown.api.render` seam
- **Seat:** Coder (complexity 5)
- **Acceptance:**
  - `renderMarkdownToHtml('# Hello')` returns a string containing `<h1>` in a plain Node process with no VS Code and no standalone host running.
  - `renderMarkdownToHtml()` produces deterministic, snapshot-stable output for a fixed fixture; both composition roots call the same function so parity is structural.
  - Zero references to `markdown.api.render` remain in `src/services/` or `src/standalone/`; the registration is deleted from `bootstrap.ts`.
  - All four test files that asserted the old seam are updated green: `verb-engine-planning-headless.test.js`, `markdown-render-sanitize-contract.test.js`, `tickets-description-markdown-fallback.test.js`, `sharedUtils-renderMarkdown.test.js`.
  - Standalone visual-delta review passes across all consumer surfaces (the durable surface — the extension host stops rendering at the cutover with no overlap period).
- **Must not touch:** `renderMarkdown` in `src/webview/sharedUtils.js` and its 24 client-side call sites (a separate client/server consistency question, not host parity).

### The Editor and the Preview Stay Level
- **Seat:** Coder (complexity 6)
- **Acceptance:**
  - Headline test: in `view-split`, scrolling either pane so heading *n* is at the top places heading *n* at the top of the other pane, for a document with ≥4 inline images — both before and after images load, driving from either pane.
  - The `.md-toolbar` is visible at every scroll position of a long document in all four host panels (planning, tickets, design, project).
  - After a debounced re-render mid-typing, the caret's line is still framed in the preview.
  - Sync is inactive above the 30,000-character cutoff (paused placeholder, nothing throws); a wide image produces no horizontal scroll.
- **Must not touch:** `renderMarkdown` in `src/webview/sharedUtils.js` (no renderer change); no `position: sticky` on `.md-toolbar` (visibility is by structure, not stickiness).

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Every panel styles its scrollbars for Chrome only, and the board has no Firefox rules at all](../plans/firefox-scrollbars-every-panel-styles-for-chrome-only.md) — **PLAN REVIEWED** — ID: bb24db76-7ea1-4b92-b0a3-2a8671fb201f
- [ ] [Harden panel CSP — remove `script-src-attr 'unsafe-inline'` from both hosts](../plans/harden-panel-csp-remove-script-src-attr-unsafe-inline.md) — **PLAN REVIEWED** — ID: 0f7e0260-c98c-4c1c-89de-5dfac68d33be
- [ ] [One markdown renderer for both hosts — retire the `markdown.api.render` seam](../plans/one-markdown-renderer-for-both-hosts.md) — **PLAN REVIEWED** — ID: d10540fd-8290-402b-9a6d-21e446368201
- [ ] [The Editor and the Preview Stay Level](../plans/the-editor-and-the-preview-stay-level.md) — **PLAN REVIEWED** — ID: be4aa5b1-95b9-48f6-b0d5-270ab00b0a13
<!-- END SUBTASKS -->

