# Workspace Scoping 4: Research + NotebookLM Tabs — Explicit Roots, Sever Cross-Tab Coupling

## Metadata
- **Tags:** frontend, backend, feature
- **Complexity:** 3
- **Part of:** `per-tab-workspace-scoping-and-persistence.md` (sub-plan 4)
- **Depends on:** `workspace-scoping-1-shared-infrastructure.md`

## Goal
Research and NotebookLM tabs each get their own workspace dropdown and send an explicit `workspaceRoot` with every operation, ending two implicit-global behaviors: (a) Research imports landing in whatever root the backend falls back to, with a destination-folder list silently driven by the **Local Docs** tab's filter; (b) NotebookLM bundle/import always hitting the active/first root.

## Background
- **Research:** `handleResearchImportClick()` (`planning.js:381-403`) posts `importResearchDoc` (`planning.js:398`) with NO `workspaceRoot`; the backend handler `_handleImportResearchDoc(workspaceRoot, ...)` (`PlanningPanelProvider.ts:4552`) gets a fallback root (`_getWorkspaceRoot() || allRoots[0]`, pattern at `PlanningPanelProvider.ts:308`). Worse, the `research-destination-folder` select (`planning.html:3098`) is populated via `getCurrentFolderPaths(state.localFolderPathsByRoot, state.localWorkspaceRootFilter)` (`planning.js:1489`) — i.e. changing the Local Docs tab's dropdown silently changes where research docs land. Cross-tab coupling bug.
- **NotebookLM:** the bundle button (`btn-bundle-code`, `planning.html:3026`, handler ~`planning.js:500`) sends `airlock_openNotebookLM` with no root (backend `PlanningPanelProvider.ts:1406`); `btn-import-notebooklm-plans` (`planning.html:3049`) sends `importNotebookLMPlans` with no root — backend (`PlanningPanelProvider.ts:1392`) delegates to `vscode.commands.executeCommand('switchboard.importNotebookLMPlans')`, which resolves its own active root.

## Proposed Changes

### 1. Research tab
1. **Dropdown:** add `<select id="research-workspace-filter">` to the research tab controls (`planning.html:3053-3108` region), near the destination-folder select. Single-root, no "All" option.
2. **Tab-local root:** `let researchWorkspaceRoot = '';` — populated from Phase-1 `workspaceItemsUpdated`; default = persisted, else `allRoots[0]`.
3. **Sever the coupling:** `populateResearchFolderSelect` calls (e.g. `planning.js:1489` and the call in `handleLocalFolderPathUpdated` `planning.js:1885+`) must use `getCurrentFolderPaths(state.localFolderPathsByRoot, researchWorkspaceRoot)` — never `state.localWorkspaceRootFilter`. On research-dropdown change, repopulate the folder select for the new root (folder paths per root are already in `state.localFolderPathsByRoot`, fed by `localFoldersListed`/`ticketsFoldersListed` handlers `planning.js:2623/2631`; if a root's paths haven't been fetched, request them — `listLocalFolders`-style message with explicit `workspaceRoot`).
4. **Explicit import root:** `importResearchDoc` message (`planning.js:398`) gains `workspaceRoot: researchWorkspaceRoot`; backend `_handleImportResearchDoc` uses it verbatim (keep fallback only for missing field).
5. **Persist:** panel-level `researchWorkspaceRoot`; per-root last-used destination folder (`lastResearchFolder` currently lives in `vscode.setState`, `planning.js:482-483, 1944-1951` — move it into the per-root map and delete the setState writes).

### 2. NotebookLM tab
1. **Dropdown:** add `<select id="notebook-workspace-filter">` to the tab (`planning.html:3015-3051` region). Single-root.
2. **Tab-local root:** `let notebookWorkspaceRoot = '';` — same population/default/persist pattern (panel-level).
3. **Messages:** `airlock_openNotebookLM` and `importNotebookLMPlans` both gain `workspaceRoot: notebookWorkspaceRoot`.
4. **Backend:** handler at `PlanningPanelProvider.ts:1406` uses `msg.workspaceRoot`; handler at `:1392` passes the root as an argument to `vscode.commands.executeCommand('switchboard.importNotebookLMPlans', msg.workspaceRoot)` — update the command registration in `extension.ts` to accept an optional root argument (falling back to its current resolution when absent, since the command may also be invoked from the palette).

## Edge Cases
- Research root with no configured local folders → folder select shows its existing empty/default state; import button behavior unchanged (backend default folder for that root).
- Persisted root not open → fall back to `allRoots[0]`, keep globalState entry.
- Palette invocation of `switchboard.importNotebookLMPlans` (no argument) keeps current behavior.
- NO confirmation dialogs (project rule).

## Verification
- `npm run compile`.
- Multi-root: set Local Docs dropdown to repo A, Research dropdown to repo B → research folder select shows repo B's folders; import a research doc → file lands in repo B. Change Local Docs dropdown → research destination unchanged.
- NotebookLM pointed at repo B: bundle/export reads repo B's code; import-plans writes plans into repo B's `.switchboard/plans`.
- Selections survive panel close/reopen and VS Code reload.

## Review Findings

Implementation solid. No code changes required. All plan requirements satisfied: both tabs have independent workspace dropdowns, cross-tab coupling severed (`populateResearchFolderSelect` now uses `researchWorkspaceRoot`), explicit `workspaceRoot` sent on all relevant messages, backend handlers use passed root with fallback, old `lastResearchFolder` `setState` writes removed in favor of per-root persistence via `persistTab`, and dropdowns survive panel reload via `restoredPanelState`. Remaining risk: `airlock_openNotebookLM` backend handler receives `msg.workspaceRoot` but ignores it (harmless — it only opens a static external URL).
