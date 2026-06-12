# Workspace Scoping 3: Stitch Tab — Workspace Dropdown + Root Threading

## Metadata
- **Tags:** frontend, backend, feature
- **Complexity:** 4
- **Part of:** `per-tab-workspace-scoping-and-persistence.md` (sub-plan 3)
- **Depends on:** `workspace-scoping-1-shared-infrastructure.md`

## Goal
The Stitch tab (Design panel) gets a workspace dropdown; all Stitch operations (project list, generate, sync, manifest, asset downloads) target the selected root instead of the hardcoded `this._getWorkspaceRoot()`, so Stitch output lands in the chosen repo's `.stitch/` directory. Selection and per-root project choice persist via the Phase-1 store.

## Background
Stitch has no workspace concept today: design.js sends no root with stitch messages (generate/sync buttons at `design.js:1500-1552` pass only `stitchProjectSelect.value`), and `DesignPanelProvider` resolves everything through `this._getWorkspaceRoot()` — `stitchOpenManifest` (`DesignPanelProvider.ts:1008`), `stitchSyncProject` (`:1073`), `stitchDownloadAsset` (`:1155`), with output dir from `_getStitchOutputDir(workspaceRoot)` (`:432-436`). In a multi-root window the user cannot run Stitch against the second repo at all. The sibling tabs (HTML Previews `design.html:3395`, Design System `design.html:3346`) already follow the per-tab dropdown pattern — copy them.

Note: the Stitch title bar was recently relocated (see `stitch-preview-controls-relocation.md`) — place the dropdown in the current title-bar control group, matching its styling.

## Proposed Changes

### 1. Dropdown (design.html)
Add `<select id="stitch-workspace-filter">` to the Stitch title-bar controls. No "All Workspaces" option — Stitch targets exactly one root.

### 2. Tab-local root (design.js)
- New `let stitchWorkspaceRoot = '';` near stitch state (~`design.js:35`).
- Populate from Phase-1 `workspaceItemsUpdated`; default = persisted value if root still open, else `allRoots[0]` (first item).
- Include `workspaceRoot: stitchWorkspaceRoot` in EVERY stitch message. Enumerate by grepping `design.js` for `type: 'stitch` — known: project list/fetch, generate, `stitchSyncProject`, `stitchOpenManifest`, `stitchDownloadAsset`, plus any reload/preview messages added by the recent stitch-tab fixes. Treat the grep as authoritative, not this list.
- On dropdown change: persist via `persistTab('stitch.root', stitchWorkspaceRoot)`; reset in-memory stitch state (`selectedStitchProjectId`, loaded designs/previews); re-request the project list for the new root; restore that root's persisted `selectedStitchProjectId` if the project still exists.

### 3. Root threading (DesignPanelProvider.ts)
- Every `stitch*` message handler: `const root = msg.workspaceRoot || this._getWorkspaceRoot();` and pass `root` down — in particular through to `_getStitchOutputDir(root)` (`:432`) and the handlers at `:1008`, `:1073`, `:1155`.
- Audit ALL call paths reaching `_getStitchOutputDir` (grep) — a missed path writes designs into the wrong repo. List found paths in the PR description.
- Echo `workspaceRoot` on every stitch response; webview drops responses whose root ≠ `stitchWorkspaceRoot` (cross-cutting rule 2).

### 4. Persistence
- Panel-level: `stitchWorkspaceRoot`.
- Per-root: `selectedStitchProjectId` (currently session-only, `design.js:35`).
- Move `stitchModelId` / `stitchCreativeRange` / `stitchAspects` (currently `vscode.setState`, `design.js:993-995`) to panel-level globalState — they're user prefs, not repo state, but should survive panel reopen. Remove their setState writes.

## Edge Cases
- Selected root has no `.stitch/` yet → existing first-run behavior (provider creates it on demand) must work for non-primary roots too.
- Persisted project id missing in the new root's manifest → clear selection, show project picker default.
- Persisted root not open → fall back to `allRoots[0]`, keep globalState entry.
- NO confirmation dialogs (project rule).

## Verification
- `npm run compile`.
- Multi-root window: point Stitch at the second repo; generate + sync a design → files appear under that repo's `.stitch/`, not the first root's. Download an asset → same. Flip roots → project lists swap correctly; flip rapidly → no cross-root render (race guard).
- Close/reopen panel and reload VS Code → dropdown, project selection, and model/creative-range/aspect prefs all restored.
