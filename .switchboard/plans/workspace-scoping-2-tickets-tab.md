# Workspace Scoping 2: Tickets Tab — Own Workspace Dropdown + Per-Root Persistent Navigation

## Metadata
- **Tags:** frontend, backend, feature
- **Complexity:** 5
- **Part of:** `per-tab-workspace-scoping-and-persistence.md` (sub-plan 2 — the original bug)
- **Depends on:** `workspace-scoping-1-shared-infrastructure.md`

## Goal
The Tickets tab gets its own workspace dropdown (`tickets-workspace-filter`), independent of every other tab. All tickets traffic uses a tab-local `ticketsWorkspaceRoot`. ClickUp navigation (space → folder → list), Linear project pick, and search/filter values are persisted **per root** via the Phase-1 store, so reopening the panel — or VS Code — lands the user back on e.g. ClickUp Sprint 116 with zero re-navigation, and each repo remembers its own spot.

## Background
Today every tickets fetch sends the global `currentWorkspaceRoot` (`planning.js:55`), which is overwritten by the `integrationProviderPreference` message (`planning.js:3137`). Navigation is saved only to `vscode.setState` (`saveTicketsState`, `planning.js:5891`) and only on internal-tab switch (`planning.js:365`) or view-mode toggle (`planning.js:5070`) — it dies when the panel closes because there is no panel serializer (`PlanningPanelProvider.ts:266`). The existing restore chain (`restoreTicketsState` `planning.js:5910`, `_restoringClickUpHierarchy` flag, chain steps at `planning.js:3040-3110`) is sound — keep it; only the storage and the root-scoping change.

## Authoritative call-site inventory (Group 1 from master plan)
Every tickets read of `currentWorkspaceRoot` in `planning.js`, all of which become `ticketsWorkspaceRoot`. This list was verified 2026-06-12; a plan review found the original plan undercounted it badly — treat this as a checklist:

| Lines | Site |
|---|---|
| 3047, 3072 | ClickUp restore-chain handlers (`clickupSpacesLoaded` → loadFolders, `clickupFoldersLoaded` → loadLists) |
| 4585 | importAllTickets |
| 4602 | editTicket |
| 4649, 4667 | pushTicket (local meta bar / online action bar) |
| 4678 | deleteTicketConfirmed |
| 4690 | changeTicketStatus |
| 4722 | postTicketComment |
| 4786 | downloadAttachment |
| 4904 | clickupCreateTask / linearCreateIssue |
| 5017 | listLocalTickets |
| 5507, 5512 | space select → clickupSaveSpaceSelection + clickupLoadFolders |
| 5530, 5540 | folder select → clickupSaveFolderSelection + clickupLoadLists |
| 5559 | list select → clickupSaveListSelection |
| 5778, 5785 | linearLoadProject, linearLoadTaskDetails |
| 5798, 5810, 5826 | clickupLoadProject, (pagination), clickupLoadTaskDetails |
| 5835 | clickupLoadSpaces |
| 5844, 5854, 5881 | clickupImportTask/linearImportTask, refine, sendTicketToAgent |

Do NOT touch lines 932/987/989/4547/4549 (Local Docs folder management), 1885/2623/2631 (response-handler defaults), or 3826-3860 (kanban epics) — those belong to sub-plans 0 and 5. After this sub-plan, `grep -n "currentWorkspaceRoot" src/webview/planning.js` must return ONLY those lines plus the declaration (55) and the setter (3137).

## Proposed Changes

### 1. Dropdown (planning.html)
Add `<select id="tickets-workspace-filter">` to the tickets toolbar (tickets content starts ~`planning.html:3152`), alongside the existing search/status filter controls. No "All Workspaces" option — tickets always target exactly one root.

### 2. Tab-local root (planning.js)
- New `let ticketsWorkspaceRoot = '';` near the other tickets state (~line 71).
- Replace every Group-1 read of `currentWorkspaceRoot` with `ticketsWorkspaceRoot` (checklist above).
- Populate the dropdown from `workspaceItemsUpdated` (Phase-1 helper, no all-option).
- **Default on first open (user-approved):** restored persisted value if its root is still open; else the first root with a ClickUp/Linear integration configured; else `allRoots[0]`. Provider support: add a lightweight `{ type: 'ticketsDefaultRoot' }` request → provider checks per-root `.switchboard` integration config (same resolution the sync-service factories use) and replies `{ type: 'ticketsDefaultRoot', workspaceRoot, provider }`. This also replaces the global push semantics of `integrationProviderPreference`.

### 3. `integrationProviderPreference` decoupling
- `planning.js:3137`: stop assigning `currentWorkspaceRoot`. The handler should only update `lastIntegrationProvider` **when `msg.workspaceRoot` matches `ticketsWorkspaceRoot`** (the message currently carries the root it applies to, sent from `PlanningPanelProvider.ts:1021`).
- Provider side: when the webview changes `ticketsWorkspaceRoot`, webview sends `{ type: 'ticketsRootChanged', workspaceRoot }`; provider replies with that root's provider preference (reuse the logic behind `PlanningPanelProvider.ts:1021`). Keep the message name or rename — dev-only, prefer whatever is cleanest.
- **Consumer check:** `implementation.html` / `TaskViewerProvider` consume the same per-root config files, not this webview message — verify no shared message contract breaks (the regression test covers the Linear project tab).

### 4. Per-root navigation persistence
Rework `saveTicketsState()` (`planning.js:5891`) / `restoreTicketsState()` (`planning.js:5910`):
- **Storage:** Phase-1 `persistTab('tickets', state, ticketsWorkspaceRoot)` for per-root nav `{ lastIntegrationProvider, ticketsViewMode, linearProjectSearchValue, linearProjectStateFilterValue, linearProjectPickerValue, clickUpSelectedSpaceId, clickUpSelectedFolderId, clickUpSelectedListId, clickUpProjectSearchValue, clickUpProjectStatusFilterValue }`, plus `persistTab('tickets.root', ticketsWorkspaceRoot)` panel-level. **Delete the `vscode.setState` tickets path entirely** (lines 5892-5907 and the `tickets` read at 5911) — no migration.
- **Save triggers (fixes the save-only-on-tab-switch hole):** space/folder/list select change (`planning.js:5507/5530/5559` handlers), Linear project pick, search/status-filter input (debounced via Phase-1 wrapper), view-mode toggle (`planning.js:5070`), and keep the internal-tab-switch save (`planning.js:365`).
- **Restore:** on tickets init, read the restored map for `ticketsWorkspaceRoot` and run the existing restore logic unchanged (`_restoringClickUpHierarchy` chain, `_restoredLinearProjectPickerValue`).

### 5. Workspace-switch behavior (dropdown change)
1. Save outgoing root's nav state (synchronously post `persistTabState`).
2. Reset ALL in-memory ClickUp/Linear state (the variables at `planning.js:57-93`), cancel any restore in progress (`_restoringClickUpHierarchy = false`), clear rendered lists/detail panes.
3. Set `ticketsWorkspaceRoot`, request that root's provider preference (`ticketsRootChanged`).
4. Load the new root's persisted nav from `_restoredPanelState.byRoot.tickets[newRoot]` (no round-trip) and kick the restore chain if it has a saved space/project; else plain `loadClickUpSpaces()`/`loadLinearProject()`.
5. Reset `ticketsLoadedOnce` appropriately so the tab-activation guard (`planning.js:357-360`) doesn't double-fetch — preserve the semantics documented at `planning.js:349-351`.

### 6. Race protection (cross-cutting rule 2)
All tickets requests already carry `workspaceRoot`; ensure the provider echoes it back on every tickets response (`clickupSpacesLoaded`, `clickupFoldersLoaded`, `clickupListsLoaded`, `clickupProjectLoaded`, `clickupTaskDetailsLoaded`, `linearProjectLoaded`, `linearTaskDetailsLoaded`, `localTicketsListed`, etc. — handlers in `PlanningPanelProvider.ts` tickets section ~:2393+). Webview drops any tickets response where `msg.workspaceRoot && msg.workspaceRoot !== ticketsWorkspaceRoot`. This makes rapid dropdown flipping safe.

### 7. Provider fallback audit
For each tickets handler in `PlanningPanelProvider.ts`: when `msg.workspaceRoot` is set, it must be used verbatim (resolved via the per-root sync-service factories); the `_getWorkspaceRoot() || allRoots[0]` fallback may remain only for a missing root.

## Edge Cases
- Selected root has no ClickUp/Linear config → existing "configure in Setup" empty state (`planning.js:1353` analogue for tickets), no error.
- Persisted ClickUp list/space deleted upstream → restore chain already fails soft (`planning.js:3077-3087` clears the flag); verify each level.
- Persisted root not in open folders → fall back per default rule; keep globalState entry.
- NO confirmation dialogs (project rule) — delete buttons stay immediate.

## Verification
- `npm run compile`.
- `grep -c "currentWorkspaceRoot" src/webview/planning.js` → exactly 10 remaining (55, 932, 987, 989, 1885, 2623, 2631, 3137, 4547, 4549) plus the three kanban-epic lines if sub-plan 0 hasn't run yet.
- Manual, multi-root (switchboard + viaapp): navigate to a deep ClickUp list (e.g. Sprint 116) under repo A; flip dropdown to repo B, navigate somewhere else; flip back → repo A restores Sprint 116 without refetching the whole hierarchy manually. Close panel, reopen → same. Reload VS Code → same. Kanban tab pointed at repo B throughout, unaffected.
- Import/edit/push/delete/comment/create on a ticket while the dropdown points at repo B → files and API calls hit repo B.
- `src/test/kanban-linear-project-tab-regression.test.js` passes; entering the tickets tab twice does not double-fetch.

## Review Findings

**Files changed:** `src/services/PlanningPanelProvider.ts` (added missing `workspaceRoot` to `ticketsAskAgentResult` responses at lines ~2967, ~2988, ~2991 for race-protection parity).

**Validation results:** `kanban-linear-project-tab-regression.test.js` passes. `grep -c "ticketsWorkspaceRoot" src/webview/planning.js` returns 47. `grep -c "tickets-workspace-filter" src/webview/planning.html` returns 1.

**Key deviations and remaining risks:** The implementation fully removed `currentWorkspaceRoot` from `planning.js` (0 occurrences) instead of leaving the 10+ references the plan reserved for other sub-plans. The remaining use sites were refactored to use context-appropriate variables (e.g., `node.metadata.root`, `kanbanFilters.workspaceRoot`), so functionality is preserved and the design is cleaner, but this is an architectural deviation from the plan's stated verification criterion. Race protection is complete after the `ticketsAskAgentResult` fix; all other tickets responses already echo `workspaceRoot` back correctly.
