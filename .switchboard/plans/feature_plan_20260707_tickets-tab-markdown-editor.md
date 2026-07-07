# Wire the Enhanced Markdown Editor into the Tickets Tab

**Plan ID:** b4f7c218-9e3a-4c66-8a1f-2d6e9c754b02

## Goal

Attach the same toolbar + live split-pane markdown editor (`window.SwitchboardMarkdownEditor.attach`) that Docs, Kanban, Dev Docs, Project, and Design panels already use to the Tickets tab's ticket-description textarea, so editing a ticket gets a toolbar, keyboard shortcuts, a table inserter, and a live preview instead of a bare monospace textarea.

### The problem (root-cause analysis)

`feature_plan_20260701_rich-markdown-editor.md` (CODE REVIEWED, shipped) rolled out the Enhanced Markdown Editor across every static `.markdown-editor` textarea it found by reading the three panel HTML files: `kanban-editor`, `projects-editor`, `features-editor`, `constitution-editor`, `system-editor`, `tuning-editor` (`project.html`), `markdown-editor` for docs and `devdocs-editor` (`planning.html`), and `markdown-editor-briefs` / `markdown-editor-design` (`design.html`). The Tickets tab's editor was never in that inventory — not because it was deliberately excluded, but because it doesn't exist as a static element. It's created dynamically: `enterTicketsEditMode()` builds a raw HTML string and assigns it with `detailContent.innerHTML = html` (textarea string at `src/webview/planning.js:8861`, `innerHTML` assignment at `:8880`), which includes `<textarea id="ticket-edit-description" class="markdown-editor" ...>`. A static-HTML audit has no way to see a textarea that only exists after a JS function runs. The class name makes the gap easy to miss — it visually inherits base `.markdown-editor` styling (dark background, monospace font) — but nothing ever calls `.attach()` on it, so today it's a plain textarea: no toolbar, no shortcuts, no table inserter, no live preview. Tickets are the most frequently edited document type in the tool, so this is the highest-traffic surface still missing the feature.

## Metadata

**Tags:** frontend, ui, ux

**Complexity:** 3/10

## User Review Required

Yes, on one point: **making the editor visible at all requires adding an `.edit-mode` class to an ancestor of the shell** (see Complex/Risky below) — this plan proposes adding it directly to `#tickets-detail-content` in `enterTicketsEditMode()` / removing it in `exitTicketsEditMode()`. No existing code does this for the Tickets tab (confirmed: zero `.edit-mode` references in the ticket-specific code path), so this is new wiring, not a preserved constraint. Confirm this is the right anchor element before coding — it's a one-line, low-risk addition, but silently render-testing the alternative (forgetting it) produces a shell that is present in the DOM but permanently `display:none`, which looks like "it didn't work" with no console error.

## Complexity Audit

### Routine
- Calling `window.SwitchboardMarkdownEditor.attach(textarea, { renderPreview })` on `ticket-edit-description` inside `enterTicketsEditMode()` (`src/webview/planning.js:8835-8882`), mirroring the exact `renderPreview` callback already used at `planning.js:6875-6898` (same `renderMarkdownLive` / `markdownLiveRendered` message round-trip, same `requestId` pattern).
- No idempotency guard needed: unlike the docs/kanban/devdocs textareas (static elements reused across repeated edit-mode toggles, hence `markdownEditor.js`'s `textarea.dataset.mdEditorAttached` no-op-and-refresh guard), `ticket-edit-description` is a **freshly created element** every time `enterTicketsEditMode()` runs (`detailContent.innerHTML = html` discards and rebuilds the whole subtree). Each call gets a brand-new, never-attached textarea — the guard exists but is simply never triggered here, which is correct and requires no special handling.
- No provider-side (`PlanningPanelProvider.ts`) change needed: the existing `renderMarkdownLive` handler (`PlanningPanelProvider.ts:2311-2329`) is fully generic — it takes `msg.content`, runs `markdown.api.render`, and replies on `isProject ? this._projectPanel : this._panel`. The Tickets tab lives in `planning.html`, served by the same non-project `this._panel` as the Docs tab, so this handler already answers Tickets-tab requests with zero changes. Verified by reading the handler body — it does not branch on any tab identifier.
- No CSS load-bearing constraint to preserve (unlike `planning.html`/`design.html`'s `.edit-mode .markdown-editor { display:block !important }`, which exists because those textareas sit hidden (`style="display:none"`) next to a persistent preview pane). The Tickets tab's textarea has no such sibling trick — it simply doesn't exist until edit mode creates it — so there is nothing to accidentally delete here. Verified: `#tickets-detail-content .markdown-editor` (`planning.html:2476`) only sets `background: transparent`, no `display` property.
- Teardown is already simpler than the other panels: `exitTicketsEditMode()` (`planning.js:8884-8896`) calls `renderTicketsTab()`, which fully rebuilds `detailContent.innerHTML` from scratch (read-mode markup), discarding the entire wrapped `.md-editor-shell` subtree. No `detach()` API exists in `markdownEditor.js` and none is needed for this call site.

### Complex / Risky
- **The `.md-editor-shell` the attach() call creates is `display:none` by default** (`markdownEditor.js:7-17`) and only becomes visible via the rule `.edit-mode .md-editor-shell { display: flex }` (`markdownEditor.js:18-20`). Every existing call site sets `.edit-mode` on an ancestor before/at attach time (e.g. `previewPane.classList.add('edit-mode')` in `enterEditMode()`, `planning.js:6872`). The Tickets tab flow has **no equivalent** — confirmed zero matches for `.edit-mode` in any ticket-specific code or markup. Attaching without also adding this class produces a shell that renders in the DOM but stays invisible, with no error — the single most likely way this feature "silently doesn't work." This plan's fix: add `detailContent.classList.add('edit-mode')` in `enterTicketsEditMode()` (right where the HTML is assigned) and `detailContent.classList.remove('edit-mode')` in `exitTicketsEditMode()`. `detailContent` (`#tickets-detail-content`) is the right anchor because it's the shared parent of the textarea in every ticket-edit render.
- **`#tickets-detail-content` is reused for read-mode content too** (comments, attachments, the rendered description, subtask nav). Adding `.edit-mode` to it must not accidentally affect read-mode CSS — checked: no existing selector in `planning.html`/`markdownEditor.js` combines `.edit-mode` with any `#tickets-*` selector, so this is additive and scoped to the new `.md-editor-shell` rule only. Must re-verify after implementation that no other `.edit-mode …` rule in `planning.html` unintentionally matches a `#tickets-detail-content` descendant (e.g. the existing `.edit-mode #markdown-preview, .edit-mode #markdown-preview-online, .edit-mode #kanban-preview-content` block, `planning.html:2493-2497` — these target IDs that don't exist under `#tickets-detail-content`, so no collision, but worth a visual smoke-test).
- **The rule immediately after that block is NOT harmless-by-omission and must be documented.** `planning.html:2498-2500` declares `.edit-mode .markdown-editor { display: block !important }` — a *class* (not ID) selector that WILL match the ticket textarea once `.edit-mode` is on `#tickets-detail-content`. It is harmless in practice only because `markdownEditor.js:88-101` already sets `display: block !important` on `.md-body > textarea.markdown-editor`. The original audit said "no collision" without examining the one rule that actually matches the ticket textarea — a false sense of safety. Document it so a future refactor that removes either rule doesn't silently regress visibility.
- **The editor only renders at all because of an inline `min-height:480px` floor on the textarea (`planning.js:8861`).** `#tickets-detail-content` is a height-`auto` block inside `#markdown-preview-tickets` (`flex:1; overflow-y:auto; padding:16px`, `planning.html:1036-1051`), and `.md-editor-shell { height:100% }` (`markdownEditor.js:15`) resolves to `auto` against an indefinite parent. The textarea's `.md-body > textarea.markdown-editor { height:100% !important }` (`markdownEditor.js:99`) would collapse toward ~0 were it not for the inline `min-height:480px` surviving as a separate property floor. Net: the ticket editor renders at a ~480px fixed floor, NOT a true fill-height like the Docs editor (which sits in a definite-height `#preview-pane`). This is acceptable UX for a ticket editor, but the inline `min-height` is load-bearing — a future "cleanup" that strips the textarea's inline style would reproduce the invisible-editor trap via a different path. Preserve the inline `min-height`, or replace it with an explicit `#tickets-detail-content.edit-mode .md-editor-shell { min-height: 480px }` rule.
- **Save must keep reading raw markdown from the same element.** `btn-save-ticket-edit`'s handler (`planning.js:8062-8090`) reads `editDiv.value` directly via `document.getElementById('ticket-edit-description')`. After `attach()` wraps the textarea inside `.md-editor-shell > .md-body`, the element keeps its `id` and remains a real `<textarea>` (per `markdownEditor.js`'s "moved, not replaced/cloned" behavior, already verified safe for the shipped panels) — `getElementById('ticket-edit-description').value` continues to work unchanged. No code change needed here, but it's the one spot a careless re-implementation (e.g. cloning instead of reusing the plan's `attach()` contract) could silently break the save path.

## Edge-Case & Dependency Audit

**Race Conditions**
- Same `requestId` last-write-wins protection already built into the `renderPreview` callback pattern (`planning.js:6875-6890`) applies unchanged when reused for tickets — no new race surface introduced.

**Security**
- No new message type, no new CSP surface. Reuses the existing nonce'd `markdownEditor.js` script (already loaded in `planning.html:4175`) and the existing `renderMarkdownLive` / `markdownLiveRendered` message pair. No `eval`, no external content, no modal dialogs (repo hard rule) introduced.

**Side Effects**
- Adding `.edit-mode` to `#tickets-detail-content` is a net-new class toggle on an element that previously never carried it — audited above for CSS collisions; no JS code currently checks `#tickets-detail-content.classList.contains(...)` or similar, so no behavioral side effect beyond the intended shell visibility.
- `ticketsEditMode` (the boolean guard at `planning.js:209`, checked at lines 1331, 5385, 5533, 9435, 9979 to avoid clobbering an active edit with a re-render) is untouched by this change — it already correctly gates all paths that could call `renderTicketsTab()`/`innerHTML` while editing.
- **Latent cosmetic divergence (not a bug):** the ticket textarea carries inline `resize:vertical` (`planning.js:8861`), which overrides `markdownEditor.js`'s `resize:none` on `.md-body > textarea.markdown-editor` (`markdownEditor.js:91`) because inline style beats stylesheet rules. The Docs/Kanban editors are non-resizable; the ticket editor will be vertically resizable. Harmless (the shell is `overflow:hidden`), but do not claim byte-identical parity with the other panels on this point. Optional cleanup: drop `resize:vertical` from the inline style when wiring `attach()`.

**Dependencies & Conflicts**
- Depends on `markdownEditor.js`'s `attach()` contract (wrap-don't-clone, preserve `id`/listeners) remaining as-is — already the case, verified in the shipped implementation.
- Depends on `renderMarkdownLive` staying generic (no tab-specific branching) — verified current state; if a future change makes it project/panel-specific, this call site would need revisiting, but nothing in scope here requires that.
- No new npm dependency, no webpack config change, no migration (Tickets tab editing is unreleased-shape UI behavior, not a persisted data format — the on-disk/remote ticket markdown format is unchanged).

## Dependencies

None. Self-contained — no prerequisite plan sessions. Builds on the already-shipped `feature_plan_20260701_rich-markdown-editor.md` infrastructure (`markdownEditor.js`, `renderMarkdownLive`) without modifying it.

## Adversarial Synthesis

Key risks: (1) the invisible-editor trap — `.md-editor-shell` defaults `display:none` and only the `.edit-mode` ancestor makes it visible, so the `attach()` call alone ships a silently-blank editor; (2) two load-bearing subtleties the original audit missed — `planning.html:2498-2500`'s `.edit-mode .markdown-editor { display:block !important }` rule DOES match the ticket textarea (harmless only because `markdownEditor.js` already forces `display:block`), and the editor only renders at all because of the textarea's inline `min-height:480px` floor against an indefinite-height parent. Mitigations: toggle `.edit-mode` on `#tickets-detail-content` in `enterTicketsEditMode()`/`exitTicketsEditMode()` (two-line, scoped, no CSS collision verified), preserve the inline `min-height` (or replace with an explicit `.edit-mode .md-editor-shell { min-height:480px }` rule), and inline-duplicate the `renderPreview` closure rather than refactoring shipped call sites. Complexity stays 3/10: one new call site, one new class toggle, zero backend changes.

## Proposed Changes

### `src/webview/planning.js`

**Context:** `enterTicketsEditMode()` (`planning.js:8835-8882`) builds and injects the ticket-edit markup; `exitTicketsEditMode()` (`planning.js:8884-8896`) tears it down; the save/cancel button handlers (`planning.js:8062-8096`) read/discard the textarea's value.

**Logic:**
1. In `enterTicketsEditMode()`, immediately after `detailContent.innerHTML = html;` and the existing `document.getElementById('ticket-edit-description')?.focus();` line, add:
   - `detailContent.classList.add('edit-mode');`
   - Look up the fresh textarea (`document.getElementById('ticket-edit-description')`) and call `window.SwitchboardMarkdownEditor.attach(textarea, { renderPreview })`, guarded by `if (window.SwitchboardMarkdownEditor)` exactly as done at `planning.js:6874`.
2. Define the `renderPreview` callback identically to the one at `planning.js:6876-6897` (same `requestId`-tagged `renderMarkdownLive` postMessage / `markdownLiveRendered` listener pair). **Decision: inline-duplicate the ~15-line closure at the ticket call site** (exactly as the Implementation block below shows) — zero blast radius, ships in one function. Do NOT refactor the shipped docs/kanban/devdocs call site (`planning.js:6875-6898`) to share a helper as part of this plan: that would touch unrelated shipped code and expand scope. A shared `createMarkdownLiveRenderer()` helper is a valid **follow-up** refactor (file it separately) but is explicitly out of scope here.
3. In `exitTicketsEditMode()`, add `detailContent.classList.remove('edit-mode');` (harmless if `renderTicketsTab()`'s subsequent `innerHTML` rebuild would discard the class anyway — belt-and-suspenders, and correct if any future code path exits edit mode without a full rebuild).

**Implementation:**
```js
// inside enterTicketsEditMode(), after detailContent.innerHTML = html;
detailContent.classList.add('edit-mode');
const descTextarea = document.getElementById('ticket-edit-description');
if (descTextarea && window.SwitchboardMarkdownEditor) {
    window.SwitchboardMarkdownEditor.attach(descTextarea, {
        renderPreview: (markdown) => new Promise((resolve, reject) => {
            const requestId = Date.now() + Math.random();
            const handler = (event) => {
                const msg = event.data;
                if (msg.type === 'markdownLiveRendered' && msg.requestId === requestId) {
                    window.removeEventListener('message', handler);
                    if (msg.error) reject(msg.error);
                    else resolve(msg.html || msg.htmlContent || '');
                }
            };
            window.addEventListener('message', handler);
            vscode.postMessage({ type: 'renderMarkdownLive', requestId, content: markdown });
        })
    });
}
```
```js
// inside exitTicketsEditMode()
detailContent.classList.remove('edit-mode');
```

**Edge Cases:**
- Switching providers (Linear ↔ ClickUp) while not in edit mode is unaffected — `enterTicketsEditMode()` reads whichever `selectedLinearIssue`/`selectedClickUpIssue` is active at click time, same as today.
- A ticket with an empty description still gets a working (empty) editor — `attach()` handles an empty-value textarea already (used for new/blank docs in other panels).
- Very long ticket descriptions: the original plan's 30,000-char live-preview auto-disable guard lives inside `markdownEditor.js` itself (not per-call-site), so it applies to tickets automatically with no extra work.

### `src/services/PlanningPanelProvider.ts`

**Context:** `renderMarkdownLive` handler (`PlanningPanelProvider.ts:2311-2329`).

**Logic / Implementation:** No change. Confirmed generic — replies on `this._panel` (the panel Tickets tab lives in) with no tab-specific branching.

**Edge Cases:** None new.

## Verification Plan

> Verification is via the installed VSIX (`src/` is the source of truth; `dist/` is not audited).
>
> **Session directives:** project compilation (`npm run compile`) and automated tests are intentionally SKIPPED as part of this verification plan — all verification is manual via the installed VSIX, consistent with the original markdown-editor plan.

### Automated Tests
- None prescribed — no existing webview-layer test harness (consistent with the original markdown-editor plan's verification approach).

### Manual verification (via installed VSIX)
1. Open the Tickets tab, select a ticket (Linear and ClickUp, both providers), click Edit → toolbar + split-pane editor appears (not a bare textarea), live preview matches the read-mode rendering of the same content.
2. Toolbar actions (bold/italic/headings/lists/checkbox/quote/code/link) and Cmd/Ctrl+B/I/K shortcuts work identically to the Docs tab.
3. Table inserter produces a valid GFM table, renders correctly live and after save.
4. Save writes exactly the textarea's markdown (title line + body) — reopen the ticket and confirm byte-identical content; confirm the remote push (`btn-push-ticket`) still sends the same content afterward.
5. Cancel discards edits and restores the prior read-mode view without leaving a stray `.edit-mode` class on `#tickets-detail-content` (inspect via devtools or by confirming no visual leakage into read mode).
6. Switch tickets while NOT editing, and confirm the existing `ticketsEditMode` guard still prevents any in-progress edit from being clobbered by a background refresh (regression check — this plan doesn't touch that guard, but confirm it still holds).
7. Resize the panel narrow — split view collapses per the existing responsive rule (same as other panels, unchanged code).
8. Theme check (default + cyber) — toolbar and live preview render correctly.
9. Visibility/height smoke-test (covers the two audit gaps): confirm the editor renders at a visible height (the inline `min-height:480px` floor) — NOT a collapsed ~0px shell — on first Edit; confirm a ticket with a very short/empty description still shows a full-height editor; confirm no read-mode visual leakage from `.edit-mode` after Cancel (devtools: `#tickets-detail-content` has no `edit-mode` class in read mode).

## Recommendation

**Send to Intern** — complexity 3/10: a single new `attach()` call site plus one `.edit-mode` class toggle, reusing a shipped pattern with zero backend change. The two audit gaps (the `.edit-mode .markdown-editor` rule at `planning.html:2498-2500` and the load-bearing inline `min-height:480px`) are documented above as "do not accidentally remove" notes, not new work. Implementation is the inline `renderPreview` closure shown in the Implementation block; the shared-helper refactor is an out-of-scope follow-up.

**Stage Complete:** PLAN REVIEWED
**Stage Complete:** PLAN CODED

