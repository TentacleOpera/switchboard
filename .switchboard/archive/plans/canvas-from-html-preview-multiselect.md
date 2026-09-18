# Canvas from HTML Previews — multi-select files → agent flattens into one inline board

## Goal

In the **HTML Previews** tab, let the user **select multiple files** and hit **"Make Canvas"**, which generates a prompt to an agent to produce **one flat, self-contained HTML board** — each selected file's screen extracted and inlined into a single document (no iframes), laid out with a caption per screen and room for commentary. The result opens in the same HTML Previews tab, where the existing zoom, Inspect Mode (click element → agent edits), and Publish-to-Claude-Artifacts already work.

### Context — why this replaces the iframe canvas

The removed canvas rendered separate files as scaled iframes on a plane. What the owner actually wants is a single inline annotated HTML board — proven by their hand-built `daily-diary-designs.artifact.html` (389 KB, **zero iframes**, screens inline, scope-note/spec-table commentary woven in). The key realization: **the HTML Previews tab already does everything a "canvas" needs for a single doc** — zoom/fit, Inspect-Mode element editing, Serve & Open, Publish to Claude Artifacts. The only missing piece is the *authoring* step: turn N selected files into one flat doc. That's a multi-select + a Copy-Prompt/Send-to-Agent — **not** a new rendering subsystem. This matches the owner's existing manual workflow (they already build these with an agent).

### Root cause / problem analysis

- **Old canvas model was wrong:** separate files as scaled iframes on a plane can't inline into one doc, can't zoom into content, can't run inspect-mode on the combined surface, and have no commentary layer.
- **The real need is authoring, not rendering:** the HTML Previews tab already handles single-doc zoom/inspect/publish. The gap is "produce one flat doc from N files" — an agent task, not a renderer.
- **Owner's manual workflow proves the target shape:** `daily-diary-designs.artifact.html` — zero iframes, screens inline, commentary woven in. The feature automates the prompt the owner already writes by hand.

## Metadata

**Tags:** frontend, feature
**Complexity:** 5

> **Superseded:** Complexity: 4
> **Reason:** Underscored the shared-`renderDocCard` touch (used by 4 tabs), the multi-select state lifecycle (clear-on-re-render, clear-on-tab-switch, clear-on-delete), and output-path edge cases (cross-folder selection, missing `absolutePath`). These are moderate, well-scoped risks extending existing patterns — the definition of Mixed (5-6), not Routine (4).
> **Replaced with:** Complexity: 5

## User Review Required

Yes — confirm the output-path rule (first selected file's folder), the selection-state lifecycle, and the decision NOT to salvage `_inlineLocalAssets`/`_flattenCanvas` from the old canvas (the sibling `remove-html-canvas-feature.md` plan waits on this decision).

## Complexity Audit

### Routine
- Adding two buttons (`Make Canvas — Copy Prompt`, `Make Canvas — Send to Agent`) to the existing `#controls-strip-html` controls strip — mirrors `btn-copy-design-html-artifact-prompt` / `btn-send-design-html-artifact-prompt` already there.
- Reusing the existing `sendHtmlTweakPrompt` / `copyHtmlTweakPrompt` transport — no new verbs, no `protocol-catalog.json` / `verbSchemas.ts` / `catalog:generate` changes.
- Prompt-builder function in `design.js` — mirrors `composeHtmlTweakPrompt` (client-side composition; provider just transports the string).
- Enabling/disabling the buttons based on selection count — trivial conditional.

### Complex / Risky
- **Shared `renderDocCard` extension** (design.js:1196) — used by Design, Briefs, HTML, Images tabs. Adding an optional `checkbox` param (default off, only HTML tab passes it) is additive but a regression here breaks 4 tabs.
- **Selection-state lifecycle** — `state.htmlSelectedFiles` (Set of `{sourceId, nodeId, absolutePath, name}`) must survive re-renders correctly: re-check boxes whose nodeId is still present, drop missing ones, clear on tab switch away from `html-preview`, clear on file delete. Ghost selections (enabled button, invisible selection) are the failure mode.
- **Output-path determinism across cross-folder/cross-workspace selections** — see Edge-Case audit.
- **`nodeMetadata.absolutePath` population** — confirmed always present for HTML Previews doc nodes (traced end-to-end: `_sendHtmlDocsReady` → `LocalFolderService.listHtmlFiles()` → `_mapLocalFilesToTreeNodes`). No fallback needed.

## Edge-Case & Dependency Audit

**Race Conditions**
- Re-render of `renderHtmlDocs` while the user is mid-selection: must re-apply checked state from `state.htmlSelectedFiles` for nodeIds still present, drop missing ones, and update the count indicator — not wipe selection silently.
- Double-click "Make Canvas" before the first dispatch resolves: disable both buttons while a dispatch is in-flight (mirror the existing `state.htmlTweakInFlight` pattern if present; otherwise add a local guard).

**Security**
- The prompt instructs the agent to inline local assets as `data:` URIs and to forbid `<iframe>` and remote `<link rel=stylesheet href="https://…">`. This is CSP-critical for Claude Artifacts uploads — remote refs render locally but break on upload. The prompt must be explicit (see Proposed Changes → Prompt).
- No new code execution surface — reuses existing transport.

**Side Effects**
- Writes a new `*.canvas.html` file to the first selected file's folder via the agent (not the extension). The extension does not write files; it only composes and dispatches the prompt.
- The new file appears in the HTML Previews list on next refresh (existing watcher / manual refresh).

**Dependencies & Conflicts**
- Sibling plan `remove-html-canvas-feature.md` waits on this plan's salvage decision: **DO NOT salvage `_inlineLocalAssets` / `_flattenCanvas`** — re-introducing a deterministic inliner contradicts this plan's thesis ("no bespoke renderer"). The removal plan may delete them. Coordinate ordering: this plan lands first (adds the feature), then the removal plan deletes the dead canvas code.
- No dependency on any session (`sess_…`) — independent.

## Dependencies

Independent. Complements (does not require) `remove-html-canvas-feature.md` — that plan removes the dead canvas tab; this plan adds to the HTML Previews tab. Ordering: this plan first, then removal. The salvage question is resolved here (do NOT salvage) so the removal plan can proceed unblocked.

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) shared `renderDocCard` regression across 4 tabs if the checkbox param is wired wrong; (2) ghost selections from undefined state lifecycle on re-render/tab-switch/delete; (3) the agent produces a file that renders locally but breaks on Claude Artifacts because remote `<link>`/un-inlined local refs remain. Mitigations: additive-only checkbox param with default off; explicit lifecycle (re-apply on re-render, clear on tab-switch/delete); prompt explicitly forbids `<iframe>` and remote stylesheet links, requires `data:` inlining for local assets, and references the `daily-diary-designs.artifact.html` shape; verification `grep`s the output for non-`data:` refs.

## Proposed Changes

### `src/webview/design.html` — controls strip + checkbox styles
- **Context:** `#controls-strip-html` (line 3881) already holds Inspect Mode, Copy upload prompt, Upload to Claude Artifacts. Add two buttons mirroring the artifact-upload pair.
- **Logic:** Insert after `#btn-send-design-html-artifact-prompt` (line 3889):
  - `<button id="btn-make-canvas-copy" class="strip-btn" title="Copy a prompt to flatten the selected HTML files into one inline board" disabled>Make Canvas — Copy Prompt</button>`
  - `<button id="btn-make-canvas-send" class="strip-btn stitch-btn-primary" title="Send the make-canvas prompt to the agent" disabled>⇨ Make Canvas</button>`
  - `<span id="html-selection-count" style="font-size: 12px; color: var(--text-secondary);">0 selected</span>`
- **Implementation:** Add CSS for a small checkbox on `.tree-node` cards (`.card-checkbox`) — only visible when the card carries `data-selectable="html"`.
- **Edge Cases:** Buttons stay `disabled` until ≥2 files are selected. Count indicator updates on every selection change and every re-render.

### `src/webview/design.js` — multi-select state, checkbox wiring, prompt builder, dispatch
- **Context:** `createHtmlDocCard` (line 1038) → `renderDocCard` (line 1196, shared by 4 tabs). `composeHtmlTweakPrompt` (line ~5040) is the client-side prompt-builder pattern to mirror. Dispatch buttons at design.js:5058 (`sendHtmlTweakPrompt`) and :5086 (`copyHtmlTweakPrompt`).
- **Logic:**
  1. **State:** add `state.htmlSelectedFiles = new Map()` keyed by `${sourceId}::${nodeId}` → `{ sourceId, nodeId, absolutePath, name, folder }`.
  2. **Shared card extension:** extend `renderDocCard` (line 1196) with an optional `selectable` param (default `false`). When true, prepend a `<input type="checkbox" class="card-checkbox">` to the card, set `wrapper.dataset.selectable = selectable ? 'html' : ''`, and wire:
     - `checkbox.addEventListener('change', …)` with `e.stopPropagation()` — toggling selection does NOT fire `clickHandler` (no preview load).
     - On render, re-check the box if its key is in `state.htmlSelectedFiles` (re-apply on re-render).
  3. **`createHtmlDocCard` (line 1038):** pass `selectable: true` to `renderDocCard`. Resolve `absolutePath` from `doc.metadata.absolutePath` — confirmed always populated for HTML Previews doc nodes (`_sendHtmlDocsReady` → `LocalFolderService.listHtmlFiles()` → `_mapLocalFilesToTreeNodes`, where `f.sourceFolder && f.relativePath` is always true, so `metadata.absolutePath = path.resolve(f.sourceFolder, f.relativePath)` is always set: DesignPanelProvider.ts:842, LocalFolderService.ts:381-384). Pass `folder` = the file's directory.
  4. **Lifecycle:** clear `state.htmlSelectedFiles` on (a) tab switch away from `html-preview`, (b) file delete (remove the deleted nodeId from the map), (c) re-render — re-apply checked state for nodeIds still present, drop missing ones, then refresh the count indicator. Add `updateHtmlSelectionCount()` helper that also toggles the `disabled` state of the two Make Canvas buttons (enabled when `size >= 2`).
  5. **Prompt builder** `composeCanvasFromFilesPrompt()` — client-side, mirrors `composeHtmlTweakPrompt`. See Prompt section below for content.
  6. **Dispatch:** wire `#btn-make-canvas-send` and `#btn-make-canvas-copy` exactly like `#html-tweak-btn-send` / `#html-tweak-btn-copy` (design.js:5058, 5086) — `vscode.postMessage({ type: 'sendHtmlTweakPrompt'|'copyHtmlTweakPrompt', prompt, workspaceRoot: state.designWorkspaceRootFilter })`. No new verbs.
- **Implementation:** No changes to `DesignPanelProvider.ts` — the existing `copyHtmlTweakPrompt` / `sendHtmlTweakPrompt` handlers (lines 2823-2842) transport any prompt string. Prompt composition is client-side, matching the `composeHtmlTweakPrompt` pattern.

> **Superseded:** "Prompt (`DesignPanelProvider.ts` — a `CANVAS_FROM_FILES_PROMPT builder, or a stripped skill)"
> **Reason:** The plan said to mirror the `sendHtmlTweakPrompt`/`copyHtmlTweakPrompt` plumbing, but that plumbing transports a pre-built prompt string — the provider's handlers (DesignPanelProvider.ts:2823-2842) just read `message.prompt` and write to clipboard / forward to the agent terminal. The mirrored `composeHtmlTweakPrompt` (design.js:~5040) is client-side. Putting the builder in the provider would require new verbs (`sendCanvasFromFilesPrompt`/`copyCanvasFromFilesPrompt`), new `protocol-catalog.json` entries, new `verbSchemas.ts` entries, and a `catalog:generate` regen — for zero functional gain over reusing the existing transport.
> **Replaced with:** Prompt builder `composeCanvasFromFilesPrompt()` in `src/webview/design.js` (client-side), dispatched via the existing `sendHtmlTweakPrompt` / `copyHtmlTweakPrompt` verbs. No `DesignPanelProvider.ts` changes.

### Prompt content (`composeCanvasFromFilesPrompt` in design.js)
- **Inputs:** the selected files' absolute paths + a target output path (default: first selected file's folder + `<first-file-stem>-canvas.html`).
- **Required instructions to the agent:**
  1. Read each selected HTML file; extract its rendered screen (body content + scoped styles).
  2. Compose **one self-contained HTML document**: all CSS inlined, all local assets (`<img>`, fonts, CSS `url()`, `<link rel=stylesheet href="./…">`) embedded as `data:` URIs, **no iframes, no external/relative refs**.
  3. **Remote refs:** any `<link rel=stylesheet href="https://…">` or remote `<script src="https://…">` must be either inlined (fetch the content and embed) or stripped — never left as a remote ref (Claude Artifacts CSP blocks them).
  4. Lay the screens out on a board (grid/sections), a caption per screen, and leave clearly-marked slots for commentary (scope-notes, before/after spec tables) matching the reference artifact's style.
  5. **Reference shape:** point the agent at `daily-diary-designs.artifact.html` — same structure: zero iframes, screens inline, commentary woven in.
  6. Write to the target path so it appears in the HTML Previews list on refresh.
- **The prompt must name the target shape explicitly** (single inline doc, zoomable, annotatable, iframe-free, remote-ref-free) and point at the reference pattern.

### Explicitly NOT in scope
No Canvas tab, no iframe plane, no bespoke renderer, no new persistence format, no new verbs, no salvaging of `_inlineLocalAssets`/`_flattenCanvas`. The output is a plain HTML file the existing tab already handles.

## Verification Plan

> Per session directives: **no compilation, no automated tests.** Verification is manual.

### Automated Tests
- None (skipped per session directive).

### Manual Verification
1. Select 3 HTML files in HTML Previews → **Make Canvas** (Send to Agent) → agent writes one `*.canvas.html` with all 3 screens inlined, **no iframes**, no external refs.
2. `grep -nE '<iframe|<link[^>]+href="https?://|<script[^>]+src="https?://|src="(?!data:)' <output>.canvas.html` returns zero matches (self-contained, CSP-clean).
3. The output opens in HTML Previews and **zooms** (existing toolbar), supports **Inspect Mode** element edits, and **publishes to Claude Artifacts** — all via existing features, no new code.
4. **Copy Prompt** variant produces the same instruction on the clipboard for a GUI/web agent.
5. Multi-select UX: count indicator correct; "Make Canvas" disabled with <2 selected; checkbox toggle does NOT load preview; selecting then re-rendering (e.g. via search filter) preserves selection for still-present files and drops missing ones.
6. Cross-folder selection: output lands in the first selected file's folder as `<first-file-stem>-canvas.html`.
7. Uploaded to Claude Artifacts, the flattened board renders (self-contained, CSP-clean — consistent with the confirmed `data:`/inline artifact behavior).
8. Regression check: Design System, Briefs, Images tabs still render their cards correctly (the shared `renderDocCard` checkbox param defaults off — no checkbox shown, no behavior change).

## Definition of Done
- HTML Previews supports multi-file selection (checkbox per card, count indicator) and a **Make Canvas** action (Copy Prompt + Send to Agent), reusing the existing `sendHtmlTweakPrompt`/`copyHtmlTweakPrompt` transport — no new verbs.
- The agent produces a single self-contained, iframe-free, remote-ref-free HTML board from the selected files, viewable/editable/publishable via the existing HTML Previews features.
- No new tab, renderer, persistence layer, or verb surface introduced.
- Selection-state lifecycle defined and verified (re-render re-applies, tab-switch/delete clears, no ghost selections).
- Salvage decision recorded: do NOT salvage `_inlineLocalAssets`/`_flattenCanvas` — sibling `remove-html-canvas-feature.md` may delete them.

## Uncertain Assumptions

None. All assumptions were confirmed by tracing the source: `nodeMetadata.absolutePath` is always populated for HTML Previews doc nodes (`_sendHtmlDocsReady` → `LocalFolderService.listHtmlFiles()` → `_mapLocalFilesToTreeNodes`, DesignPanelProvider.ts:842 + LocalFolderService.ts:381-384). No research needed.

## Completion Summary

Implemented multi-select → Make Canvas on the HTML Previews tab. `src/webview/design.html`: added `#btn-make-canvas-copy`, `#btn-make-canvas-send`, `#html-selection-count` to `#controls-strip-html`, plus `.card-checkbox` CSS (hidden unless `data-selectable="html"`). `src/webview/design.js`: added `state.htmlSelectedFiles` Map + `htmlCanvasInFlight` guard; extended shared `renderDocCard` with an additive `selectable` param (default off — Design/Briefs/Images/Stitch-HTML tabs unaffected); `createHtmlDocCard` passes `selectable: true`; added `reconcileHtmlSelection` (re-applies on re-render, drops truly-missing nodeIds, preserves search-hidden files), `updateHtmlSelectionCount` (enables buttons at ≥2 selected, disables during in-flight), `clearHtmlSelection` (called on tab switch away from html-preview); added `composeCanvasFromFilesPrompt` (client-side, forbids iframes/remote refs, requires `data:` inlining, references `daily-diary-designs.artifact.html` shape, target = first-selected file's folder + `<stem>-canvas.html`); wired both buttons via existing `sendHtmlTweakPrompt`/`copyHtmlTweakPrompt` verbs — no new verbs, no `DesignPanelProvider.ts` changes. `node --check` passes. Salvage decision per plan: do NOT salvage `_inlineLocalAssets`/`_flattenCanvas`. No issues encountered.

## Review Findings

Direct reviewer pass (in-place). No CRITICAL or MAJOR findings; no code fixes applied. Verified: `renderDocCard` `selectable` param is additive (default `false`) — only `createHtmlDocCard` (`design.js:1096`) passes `true`; the other 4 call sites (Design/Briefs/Images + 1) are structurally unaffected, no shared-card regression. Selection lifecycle matches plan: `reconcileHtmlSelection` (`design.js:1047`) uses pre-search `selectableDocNodes` so search-hidden files stay selected, truly-missing nodeIds dropped; `clearHtmlSelection` wired on tab switch away from `html-preview` (`design.js:162`); file-delete handled implicitly via re-render reconciliation (functionally equivalent to explicit delete-time removal). `composeCanvasFromFilesPrompt` (`design.js:5079`) satisfies all CSP-critical prompt requirements (no `<iframe>`, no remote refs, `data:` inlining, reference shape, target path). Reuses existing `sendHtmlTweakPrompt`/`copyHtmlTweakPrompt` verbs — zero `DesignPanelProvider.ts` changes, no new verbs. `node --check src/webview/design.js` passes. NITs (no fix): `htmlCanvasInFlight` guard releases via `setTimeout(1500)` (`design.js:5120`) — a debounce, not a true in-flight lock (fire-and-forget transport has no completion signal); copy button early-returns on `htmlCanvasInFlight` (`design.js:5126`) — slightly aggressive but harmless. Remaining risks: manual end-to-end click-through (select ≥2 files → Make Canvas → verify output is iframe-free/remote-ref-free) is the only outstanding acceptance gate.
