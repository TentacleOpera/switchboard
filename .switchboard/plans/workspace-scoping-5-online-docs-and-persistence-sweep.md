# Workspace Scoping 5: Online Docs Filter + Persistence Sweep + Delete `currentWorkspaceRoot`

## Metadata
- **Tags:** frontend, refactor, feature
- **Complexity:** 3
- **Part of:** `per-tab-workspace-scoping-and-persistence.md` (sub-plan 5 — final)
- **Depends on:** `workspace-scoping-1-shared-infrastructure.md`; the deletion step (§3) additionally requires `workspace-scoping-2-tickets-tab.md` and `fix-kanban-epic-ops-workspace-root.md` to be complete

## Goal
Three closing items: (1) Online Docs gets a workspace filter; (2) every already-correct tab's workspace selection is persisted so nothing resets to default on panel reopen; (3) the global `currentWorkspaceRoot` variable is deleted from `planning.js`, converting any missed migration into a loud ReferenceError instead of silent wrong-repo traffic.

## Proposed Changes

### 1. Online Docs workspace filter
- **Today:** all roots' online sources render merged — `handleOnlineDocsReady(msg)` (`planning.js:1509`) receives `msg.roots` and `renderOnlineDocs(msg.roots, msg.enabledSources)` (`planning.js:1513`) renders everything; search (`applyOnlineDocsSearchFilter`, `planning.js:1426`) filters by name only.
- Add `<select id="online-workspace-filter">` to the online docs toolbar (`planning.html:2987-2991` region), populated via the Phase-1 helper **with** an "All Workspaces" option (user-approved default: All Workspaces).
- Tab-local `state.onlineWorkspaceRootFilter = ''`; when set, `renderOnlineDocs` renders only the matching root's sections (data is already per-root in `msg.roots` — pure client-side filter, mirroring Local Docs' `metadata.root` filter at `planning.js:1469-1471`).
- Persist panel-level.

### 2. Persistence sweep for already-correct tabs
Persist (panel-level via Phase-1 store) and restore on init, re-applying filters after first data load:
- **Kanban:** `kanbanFilters.workspaceRoot` (`planning.js:3426`) — restore before/with `populateKanbanFilters()` (`planning.js:4000-4011`) and save in the change listener (`planning.js:4254-4263`). Optionally include `kanbanFilters.project` per-root (cheap, same mechanism — include it).
- **Local Docs:** `state.localWorkspaceRootFilter` (`planning.js:35`, listener `planning.js:217-220`).
- **Design panel — HTML Previews:** `state.htmlWorkspaceRootFilter` (`design.js:28`, listener `design.js:1695-1707`).
- **Design panel — Design System:** `state.designWorkspaceRootFilter` (`design.js:29`, listener `design.js:1709-1720`).
- Restore rule everywhere: persisted root not in current `workspaceItems` → fall back to the tab default ("All Workspaces" where it exists), keep the globalState entry.

### 3. Delete `currentWorkspaceRoot` (planning.js)
Precondition: sub-plans 0 and 2 merged. Remaining references and their disposition (Groups 3–4 of the master inventory):
- `932, 987, 989` (remove folder buttons) and `4547, 4549` (add folder buttons): replace `state.localWorkspaceRootFilter || currentWorkspaceRoot` with `state.localWorkspaceRootFilter || workspaceItems[0]?.workspaceRoot || ''` (i.e. first open root when the Local Docs filter is "All Workspaces"). Note `987/4547` are the `addTicketsFolder`/`removeTicketsFolder` variants driven by `folderModalScope === 'tickets'` — same treatment.
- `1885` (`handleLocalFolderPathUpdated` targetRoot), `2623, 2631` (folder-paths bucketing): drop the `|| currentWorkspaceRoot` term — backend always sends `msg.workspaceRoot` on these messages; keep the `|| ''` terminal fallback.
- `3137`: the `integrationProviderPreference` assignment was already removed/reworked by sub-plan 2 — confirm.
- `55`: delete the declaration.
- Final check: `grep -c "currentWorkspaceRoot" src/webview/planning.js` → 0.

### 4. Remove superseded `vscode.setState` writes
Where globalState now covers a value, delete the setState path (dev-only, no migration). Keep setState only for true ephemera (e.g. scroll positions) if any exist. Known already removed by earlier sub-plans: tickets nav (sub-plan 2), `lastResearchFolder` (sub-plan 4), stitch prefs (sub-plan 3).

## Edge Cases
- "All Workspaces" + add-folder: targets `workspaceItems[0]` — acceptable for dev-only; the native folder picker that follows shows the path anyway.
- Online Docs filter with a root whose sources are all disabled → existing per-source empty states render; no new empty state needed.
- NO confirmation dialogs (project rule).

## Verification
- `npm run compile`.
- `grep -c "currentWorkspaceRoot" src/webview/planning.js` returns 0.
- Online Docs: filter to one repo → only that repo's Notion/ClickUp/Linear sections render; "All Workspaces" → merged view as today.
- Set every tab's dropdown (kanban, local docs, online docs, tickets, research, notebook, stitch, html previews, design system) to non-default values; close both panels, reopen; reload VS Code → all selections restored.
- `src/test/kanban-linear-project-tab-regression.test.js` passes.

## Execution Summary

### Status: COMPLETED

### Files Changed
- `src/services/ResearchImportService.ts` — added `workspaceRoot?` to `ResearchSourceAdapter`, added `getAdapters()`, updated `NotionResearchAdapter` constructor to accept/store `workspaceRoot`.
- `src/services/ClickUpDocsAdapter.ts` — changed `_workspaceRoot` to public `readonly workspaceRoot`; updated internal reference.
- `src/services/LinearDocsAdapter.ts` — changed `_workspaceRoot` to public `readonly workspaceRoot`.
- `src/services/PlanningPanelProvider.ts` — passed `workspaceRoot` to `NotionResearchAdapter`; updated `_sendOnlineDocsReady` to build `roots` from adapters with `workspaceRoot`.
- `src/webview/planning.js` — deleted `currentWorkspaceRoot`; replaced all 9 references; added `online-workspace-filter` registration, listener, and `handleOnlineDocsReady` filtering/persistence; added `localDocs.root` persistence; added `kanban.root` and `kanban.project` persistence and restore in `restoredTabState` / `handleKanbanPlansReady`; added validation fallbacks for local/online/kanban filters against current `workspaceItems`.
- `src/webview/design.js` — registered `html-workspace-filter` and `design-workspace-filter`; added `html.root` and `design.root` persistence in listeners; restored both filters in `restoredTabState`.

### Findings & Fixes
- The backend `_sendOnlineDocsReady` did not include per-root `workspaceRoot` on `roots` entries, contradicting the plan assumption. Fixed by exposing `workspaceRoot` on all adapters and mapping it into `roots`.
- `currentWorkspaceRoot` was already partially removed from epic-operation lines (they now use `details.dataset.workspaceRoot || ''`), so only 9 references remained — all replaced.
- No superseded `vscode.setState` writes remain in `planning.js` or `design.js` (the collapsed-state writes are not yet covered by globalState).

### Validation
- `grep -c "currentWorkspaceRoot" src/webview/planning.js` → **0**.
- Skipped compilation and tests per session instructions.

### Remaining Risks
- Online Docs filter relies on adapter `workspaceRoot` being set correctly; if an adapter is missing the property, its section is hidden when any workspace filter is active. All three current adapters now expose it.
- If `workspaceItemsUpdated` arrives before `restoredTabState` for registered dropdowns, the restored value is set on the select element after options exist, which works for HTML/Design but could leave Online Docs in an unfiltered state until the user interacts. This matches existing behavior for other tabs.
