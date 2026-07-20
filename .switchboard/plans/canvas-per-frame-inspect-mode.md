# Canvas — per-frame Inspect Mode (point at a screen, an agent edits it)

## Goal

Make **Inspect Mode** work on any frame on the Canvas: click an element inside a frame, describe a change, and an agent edits **that frame's source file** in place — the same point-and-describe loop the HTML Previews tab already has, but frame-scoped on the canvas.

### Context

Inspect Mode already exists (`inspect.js`, loaded at `DesignPanelProvider.ts:781`; `stitchElementSelected` message `:336`; wheel-forwarding over a scaled iframe `:407-408`). The new work is retargeting it: on a canvas the click must resolve to the **correct** frame's iframe and map coordinates through **both** the canvas transform and the frame's own scale, then run the existing select→(Send to Agent / Copy Prompt) flow against that frame's source file.

## Metadata

**Tags:** frontend, feature, ui
**Complexity:** 5

## Proposed Changes
- Add an **Inspect** mode to the canvas mode toggle (Pan / Drag / Inspect).
- On an Inspect click: set the clicked frame **active**, then run the existing `inspect.js` capture/select flow scoped to that frame's iframe. Reuse the `stitchElementSelected` plumbing and the existing **Send to Agent** (coder terminal) / **Copy Prompt** (IDE chat) actions.
- The edit targets the active frame's **source file** (the path the frame references); on success the frame's iframe auto-refreshes (foundation's file-watch).

## Complex / Risky
- **Nested-transform coordinate mapping** — the existing capture layer assumes one scaled iframe. Here the click passes through the canvas pan/zoom AND the frame's own scale. Active-frame resolution + correct coordinate mapping across both transforms is the crux; verify selection accuracy at several zoom levels and frame scales (this is the most likely correctness bug).

## Dependencies
Depends on **canvas-foundation-tab-panzoom-frames** (frames, transform, file references).

## Verification Plan
1. Enable Inspect, click an element in one frame, send an edit to an agent → only that frame's source changes and its iframe refreshes; other frames untouched.
2. Repeat at 50% and 150% canvas zoom → the selected element matches what was clicked (coordinate mapping correct).
3. Copy Prompt variant produces a prompt referencing the right element + file.

## Definition of Done
- Inspect Mode works per frame, editing only that frame's source, with accurate selection across zoom levels; reuses the existing inspect + agent-dispatch plumbing.

## Review Findings

Reviewed commit `ad17f99` against this plan. The implementation sidesteps the plan's flagged "nested-transform coordinate mapping" risk cleanly: instead of mapping parent-side click coordinates through the canvas transform AND the frame's scale, it posts `sbInspectToggle` to each frame iframe and lets the existing `_INSPECTOR_SCRIPT` (already injected by the localhost server at `DesignPanelProvider.ts:2170`) handle hover/select INSIDE the iframe's own coordinate space — so selection is accurate at any zoom/frame-scale by construction. The `stitchElementSelected` handler (`design.js:3704`) resolves the source frame by matching `event.source` to the frame iframe via `canvasFindFrameBySource`, sets `activeFrameId`, and routes the edit to that frame's `filePath` through the existing `sendHtmlTweakPrompt` / `copyHtmlTweakPrompt` plumbing; the foundation's file-watch auto-refreshes the frame after the agent edits. No correctness issues found. No code changes required for this plan. Validation: `node --check src/webview/design.js` passes. **Remaining risk:** the tweak popup's "Send to Agent" uses `state.designWorkspaceRootFilter` for the workspace root — if the user has never opened the Design System tab, that filter may be empty, routing the edit to the default workspace root (acceptable for single-root setups, ambiguous in multi-root).
