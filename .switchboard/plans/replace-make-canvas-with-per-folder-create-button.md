# Replace Make Canvas checkboxes with per-folder "Create Canvas" button

## Goal

Remove the batch-selection Make Canvas machinery from the HTML Previews tab and replace it with a per-folder `+` button that copies a prompt instructing the agent to create a new flat, self-contained inline HTML file in that folder and ask the user what to put on it. Keep the single-file `Copy upload prompt` feature untouched.

### Problem

The HTML Previews tab in `design.html` has a "Make Canvas" feature that clutters every HTML doc card in the sidebar with a checkbox. The checkboxes exist solely to pre-collect a file list for a batch-flatten prompt (`composeCanvasFromFilesPrompt`). This is the wrong design — the user's original intent was for the agent to ask which files to include, not for the webview to hand it a pre-resolved list.

The feature also has confusing presentation: two near-identical "Copy … prompt" buttons in the controls strip (one for single-file Artifact upload, one for multi-file canvas flatten), a "0 selected" counter that's meaningless until you discover the hidden checkboxes, and two dead JS handlers (`btn-make-canvas-send`, `btn-send-design-html-artifact-prompt`) for buttons that don't exist in the HTML.

### Root cause

The original plan (`.switchboard/plans/canvas-from-html-preview-multiselect.md`) optimized for one-shot fire-and-forget prompt generation — bake the file list into the prompt so the agent doesn't need to ask. The cost was permanent checkbox clutter in every card, a selection-state machine (`htmlSelectedFiles`, `reconcileHtmlSelection`, `clearHtmlSelection`, `updateHtmlSelectionCount`), and a confusing "0 selected" counter. The "send" button variants were specced and coded but never added to the HTML, leaving dead handlers.

### Solution

Remove the entire checkbox/selection/Make Canvas machinery. Replace it with a per-folder `+` button in the HTML Previews sidebar — the same pattern used in `planning.html`'s docs tab (`folder-create-btn`). The `+` button copies a prompt that instructs the agent to create a new flat, self-contained inline HTML file in that folder, then ask the user what to put on it. No checkboxes, no selection state, no counter, no global button.

The single-file `Copy upload prompt` button is kept untouched — it's a separate, working feature.

## Metadata

**Complexity:** 3
**Tags:** frontend, ui, refactor, feature
**Project:** Browser Switchboard

## User Review Required

No

## Complexity Audit

### Routine

- Remove Make Canvas controls and checkbox CSS from `design.html`.
- Delete selection-state fields, reconciliation functions, and dead event handlers from `design.js`.
- Remove the `selectable` parameter and checkbox block from `renderDocCard`.
- Add one new prompt-composition function and wire it through the existing `folderActionsFn` channel in `renderFolderGroupedDocs`.

### Complex / Risky

- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None. The new per-folder action is stateless; no global selection state is mutated.
- **Security:** The `+` button posts a pre-canned prompt via the existing `copyHtmlTweakPrompt` verb. No user-provided string is interpolated into shell commands or file writes; the folder path comes from the extension-provided folder list.
- **Side Effects:** Deleting `htmlSelectedFiles`, `htmlCanvasInFlight`, and related functions removes state and event listeners. A final grep pass must confirm zero remaining references.
- **Dependencies & Conflicts:** None. `copyHtmlTweakPrompt` is already in `DESIGN_VERBS` (`src/generated/verbAllowlist.ts` line 11) and handled in `DesignPanelProvider.ts` (line 2485). `folderActionsFn` is already supported by `renderFolderGroupedDocs` / `renderSubfolderGroups` in `design.js` (line 738).

## Dependencies

None.

## Adversarial Synthesis

Key risks: (1) orphaned references to removed selection machinery; (2) the new prompt must explicitly ask the user what to include or the conversational-selection goal is missed; (3) `folderActionsFn` is passed through to subfolder groups, so the `+` action should appear on subfolders too. Mitigations: exhaustive grep verification, mandatory "ask the user" wording in `composeCreateCanvasPrompt`, and manual check of subfolder headers.

## Proposed Changes

### `src/webview/design.html`

- **Controls strip** (lines ~3892-3893): delete the `btn-make-canvas-copy` button and the `html-selection-count` span. The strip keeps: workspace filter, Inspect Mode, search, Copy upload prompt.
- **Checkbox CSS** (lines ~1868-1876): delete the `.tree-node .card-checkbox` rule and the `.tree-node:not([data-selectable="html"]) .card-checkbox` rule. No other CSS references `card-checkbox` or `data-selectable`.
  - **Clarification:** The `.folder-create-btn` CSS already exists in `design.html` (lines 749-774), so no new styles need to be added. The `planning.html` and `design.html` sheets share the same button convention.

### `src/webview/design.js`

- **State** (lines ~68-69): remove `htmlSelectedFiles: new Map()` and `htmlCanvasInFlight: false` from the `state` object.
- **Tab-switch guard** (lines ~158-163): remove the `if (tabName !== 'html-preview') { clearHtmlSelection(); }` block and its comment.
- **`renderHtmlDocs` function** (lines ~1027-1045):
  - Remove the `selectableDocNodes` variable (line ~1030) and its comment (lines ~1027-1029).
  - Remove both `reconcileHtmlSelection(selectableDocNodes, sourceId)` calls (lines ~1039, ~1044).
  - Add a `folderActionsFn` parameter to the `renderFolderGroupedDocs` call (line ~1043) — see wiring below.
- **Delete these functions entirely:**
  - `reconcileHtmlSelection` (lines ~1047-1069)
  - `updateHtmlSelectionCount` (lines ~1071-1080)
  - `clearHtmlSelection` (lines ~1082-1085)
  - `composeCanvasFromFilesPrompt` (lines ~5078-5104) and its section comment
- **Delete these dead/orphaned event handlers:**
  - `btn-make-canvas-send` handler (lines ~5106-5123) — button doesn't exist in HTML
  - `btn-make-canvas-copy` handler (lines ~5125-5133) — button being removed
  - `btn-send-design-html-artifact-prompt` handler (lines ~5759-5767) — button doesn't exist in HTML
- **`createHtmlDocCard`** (line ~1096): remove `selectable: true` from the `renderDocCard` call.
- **`renderDocCard`** (lines ~1246-1293): remove the `selectable` parameter from the function signature, the `wrapper.dataset.selectable = selectable ? 'html' : ''` assignment (line ~1257), and the entire `if (selectable) { ... }` checkbox-creation block (lines ~1264-1292). No other caller passes `selectable: true`, so this is safe dead-code removal.
- **New function** `composeCreateCanvasPrompt(folderPath)`: builds a prompt that instructs the agent to:
  1. Create a new self-contained inline HTML file in `folderPath`.
  2. Start with a minimal blank canvas/board structure (full-viewport container, ready for content).
  3. Ask the user what to put on it (screens, content, layout) — this must be a mandatory ask, not optional.
  4. All CSS inlined, no iframes, no external/relative references, all assets as `data:` URIs — publish-ready for Claude Artifacts.
  5. Write the file to `folderPath` with a sensible name (or ask the user for one).
- **Wire the `+` button**: pass `folderActionsFn` as the 8th argument to `renderFolderGroupedDocs` in `renderHtmlDocs` (line ~1043). The function returns the default `Link` action plus a new `+` action:

```js
(fp) => [
    {
        label: 'Link',
        title: 'Copy folder path to clipboard',
        onClick: () => vscode.postMessage({ type: 'linkToFolder', folderPath: fp })
    },
    {
        label: '+',
        title: 'Create canvas',
        className: 'folder-create-btn',
        onClick: () => {
            const prompt = composeCreateCanvasPrompt(fp);
            if (!prompt) return;
            vscode.postMessage({ type: 'copyHtmlTweakPrompt', prompt });
        }
    }
]
```

`renderFolderGroupedDocs` already accepts `folderActionsFn` (line 738) and passes it through `renderSubfolderGroups`, so both top-level folders and nested subfolders will render the `+` action.

## What stays untouched

- `Copy upload prompt` button (`btn-copy-design-html-artifact-prompt`) and its handler — working single-file Artifact feature.
- `copyHtmlTweakPrompt` verb on the extension side — reused by the new `+` button.
- `sendHtmlTweakPrompt` verb — still used by the HTML tweak popup's send path (not part of this change).
- The zoomable canvas viewport (pan/zoom toolbar on the preview pane) — unrelated to "Make Canvas".
- `.switchboard/plans/canvas-from-html-preview-multiselect.md` — historical plan, leave as-is.

## Verification Plan

### Automated Tests

- `node --check src/webview/design.js` — syntax passes after deletions and new function.
- Grep verification: in `src/webview/`, the following terms must return zero hits: `htmlSelectedFiles`, `htmlCanvasInFlight`, `card-checkbox`, `data-selectable`, `btn-make-canvas`, `html-selection-count`, `reconcileHtmlSelection`, `clearHtmlSelection`, `updateHtmlSelectionCount`, `composeCanvasFromFilesPrompt`, `selectableDocNodes`, `selectable: true`, `selectable`.

### Manual

- Open the Design panel, go to HTML Previews tab.
- Confirm: no checkboxes on any HTML doc card.
- Confirm: no "Make Canvas — Copy Prompt" button, no "0 selected" counter in the controls strip.
- Confirm: `Copy upload prompt` button is still present and works (copies a single-file Artifact prompt).
- Confirm: each folder header in the sidebar has a `+` button; nested subfolders also show a `+` button.
- Confirm: clicking `+` copies a prompt to the clipboard that instructs the agent to create a new flat HTML file in that folder and **ask what to put on it**.
- Confirm: switching tabs away from HTML Previews and back works without errors (no reference to removed `clearHtmlSelection`).

## Recommendation

Send to Intern

## Completion Report

Removed the batch selection Make Canvas machinery (checkboxes, selection state Map, counter, and dead handlers) from the HTML Previews tab. Replaced it with a per-folder `+` button in the sidebar folder headers via `folderActionsFn`. Clicking `+` generates a prompt that instructs the agent to create a new inline HTML canvas file in that folder and explicitly ask the user what content to include.
Files changed: [design.html](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/design.html), [design.js](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/design.js), and this plan file.
No issues encountered during refactoring; verification passed cleanly.
