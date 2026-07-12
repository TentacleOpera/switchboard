# Stitch Design Panel Improvements

**Complexity:** 6

## Goal

Make the Stitch integration in the Design panel feel like a finished product surface. The asset cache gets organised into per-project folders and a dedicated Stitch HTML tab browses the cached renders per project, replacing the hidden include-toggle in the HTML Previews modal. The remaining rough edges are polished: New Project opens a real in-panel modal instead of the native input box, Send to Stitch from a brief auto-names the project and actually starts generation, and every brief card gets the per-item Link button the other tabs already have.

## How the Subtasks Achieve This

- **Organise the Stitch Cache into Per-Project Folders**: Restructures `.switchboard/stitch` from one flat UUID soup into `<project-folder>/` subdirectories (sanitized name + id suffix), threading `projectId` through every cache read/write path and migrating existing files by DB lookup. This is the storage foundation the browser tab needs.
- **Add a "Stitch HTML" Browser Tab to the Design Panel**: New tab beside Stitch that browses the cached HTML per project via a dropdown, reusing the HTML Previews preview machinery — minus Manage Folders and the Upload-to-Claude-Artifacts actions — and removes the now-redundant "include stitch folder" toggle from the HTML Previews manage-folders modal (with a released-state cleanup of persisted stitch paths).
- **Replace the Stitch "New Project" Native Input Box with a Real In-Webview Modal**: Moves title collection from `vscode.window.showInputBox` into a proper in-panel modal following the folder-modal pattern; the webview now sends the title with `stitchCreateProject`.
- **Briefs "Send to Stitch" — Auto-Name the Project and Actually Generate**: Drops the redundant title dialog (project auto-named from the brief title) and completes the flow by firing the standard generate path with the brief as the prompt, instead of stopping at a pre-filled input box.
- **Add a Per-Brief "Link" Button to the Briefs Sidebar**: Wires the existing `'Link Doc'` action of the shared card renderer into brief cards so each brief gets a copy-validated-path button like HTML/Images cards, closing a per-item affordance gap.

## Reconciliation & End-State (improve-feature pass)

The improve-feature pass improved all five subtasks against the live code and audited their shared surfaces. **No merges, deletions, or splits** — all five remain distinct, valid units. Two plans were rewritten and three refined to resolve real cross-subtask problems the original set had papered over:

- **`stitchBriefInjected` is a shared, multi-producer message.** Both `stitchCreateProject` (`DesignPanelProvider.ts:2561`) and `stitchSendBrief` (`:3088`) post it; only one webview handler consumes it (`design.js:3123`). Send-to-Stitch makes that handler auto-generate — which would leak into the New Project path. **End-state:** New Project stops producing it (drops brief-attach, below); Send-to-Stitch gates auto-generate on an explicit `autoGenerate: true` flag so the two flows are decoupled and order-independent.
- **New Project had a hidden second native dialog.** `stitchCreateProject` runs a native `showInputBox` *and* a native `showQuickPick` brief-attach flow (`:2511-2540`). The original plan only removed the input box. **End-state:** the modal collects the title only; the brief-attach quick-pick is removed (superseded by Send-to-Stitch, which does brief→project→generate). This drops a redundant capability — flagged as a User Review item in that plan.
- **Briefs "Link" carried a phantom risk.** The original plan feared a `linkToDocument` folder allow-list rejecting briefs. That handler (`:1931-1944`) does **no** validation — pure resolve-and-copy. **End-state:** the change is a single `actions: ['Link Doc']` addition; complexity corrected 3→2. (The real allow-list guard lives in `_buildAndSendPreview` and governs the HTML-tab preview reads, not links.)
- **Cache reorg has one screen-less caller.** `stitchDownloadAsset` holds a `screenId`, not a screen object, so it resolves `projectId` via `_activeScreens` with a flat-root fallback. All other callers already carry `screen.projectId`.

**Corrected sequencing:** *Per-Project Folders* → *Stitch HTML Browser Tab* is a hard order (the tab consumes `_getImageCacheDir(root, projectId)`). *New Project modal* and *Send to Stitch* are **not** an independent pair as the section below implies — they share the `stitchBriefInjected` contract; the `autoGenerate` flag makes either landing order safe, but land them aware of each other. *Briefs Link* is fully independent.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [x] [Organise the Stitch Cache into Per-Project Folders](../plans/stitch-cache-per-project-folders.md) — **CODER CODED**
- [x] [Add a "Stitch HTML" Browser Tab to the Design Panel](../plans/stitch-html-browser-tab.md) — **CODER CODED**
- [ ] [Replace the Stitch "New Project" Native Input Box with a Real In-Webview Modal](../plans/stitch-new-project-real-modal.md) — **CODER CODED**
- [ ] [Briefs "Send to Stitch" — Auto-Name the Project and Actually Generate](../plans/briefs-send-to-stitch-actually-sends.md) — **CODER CODED**
- [ ] [Add a Per-Brief "Link" Button to the Briefs Sidebar](../plans/briefs-per-item-link-button.md) — **CODER CODED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

- **Binding order:** *Per-Project Folders* must land **before** *Stitch HTML Browser Tab* — the tab's project dropdown maps directly onto the per-project cache folders and its `fetchPreview` guard resolves folders from project ids.
- The other three subtasks (New Project modal, Send-to-Stitch auto-generate, per-brief Link button) have no ordering constraints and can be executed in parallel with each other and with the cache/tab pair. The modal and auto-send subtasks touch neighbouring `DesignPanelProvider.ts` message handlers (`stitchCreateProject` vs `stitchSendBrief`) but different cases — trivial merge surface.
- No cross-feature dependencies; the eager HTML caching this feature builds on is already landed.

## Completion Report

Implemented the three remaining subtasks (New Project modal, Send-to-Stitch auto-generate, per-brief Link button). **Files changed:** `src/webview/design.html` (new `stitch-new-project-modal` markup reusing `stitch-prompt-modal` styles), `src/webview/design.js` (modal open/close/submit wiring with scoped Escape `stopPropagation`; `runStitchGenerate` helper extracted from `btnGenerateStitch` and called from both the button and the `stitchBriefInjected` auto-generate path; `actions: ['Link Doc']` added to `createBriefDocCard`), `src/services/DesignPanelProvider.ts` (`stitchCreateProject` now accepts `message.title` and drops both the `showInputBox` and `showQuickPick` brief-attach blocks plus the dependent `stitchBriefInjected` post; `stitchSendBrief` drops its `showInputBox`, auto-names from `briefTitle` with filename-stem fallback, and posts `stitchBriefInjected` with `autoGenerate: true`). The `stitchBriefInjected` contract is now decoupled: only `stitchSendBrief` produces it, and auto-generate fires only when `autoGenerate` is truthy. No issues encountered; all changes are self-consistent with the existing modal/busy-lock patterns.
