# Fix Epics Not Showing in Project Webview

## Goal
Fix the issue where epics are not displayed in the EPICS tab of project.html when using workspace mapping configuration.

The EPICS tab in project.html filters plans by `plan.isEpic` to display epics. The data comes from the `kanbanPlansReady` message sent by the `fetchKanbanPlans` handler in `PlanningPanelProvider.ts`.

**Architecture**: Epics are flagged in the kanban database with `is_epic=1`. The EPICS tab correctly uses `fetchKanbanPlans` and filters by `isEpic` - this is the intended design. The database is the source of truth for what is an epic.

**Intended Epic Workflow** (future):
- "Create Epic" button in UI creates new MD file in `.switchboard/plans/epics/`
- File is marked in DB as epic
- Shows in EPICS tab webview
- Does NOT appear in kanban unless "Show on Kanban" toggle is checked (future feature)

**Root Cause**: The `fetchKanbanPlans` handler uses `_getWorkspaceRoots()` to determine which workspace databases to query. This method only returns VS Code workspace folders, not the mapped parent folders defined in the workspace mapping configuration.

When workspace mappings are enabled, the system should query databases for all mapped parent folders (e.g., `/Users/patrickvuleta/Documents/GitHub/switchboard`) regardless of whether they are open as VS Code workspace folders. Currently, if a mapped parent folder is not open as a workspace, its plans (including epics) are not fetched.

**Evidence**:
- Epic exists in database: `sess_1781592034761|Online Docs Tab — Inline Editing & Unified Docs Model|1` in `/Users/patrickvuleta/Documents/GitHub/switchboard/.switchboard/kanban.db`
- Workspace mapping includes Switchboard: `dbPath: /Users/patrickvuleta/Documents/GitHub/switchboard/.switchboard/kanban.db, parentFolder: /Users/patrickvuleta/Documents/GitHub/switchboard`
- The `_getAllowedRoots()` method already exists and correctly includes mapped parent folders from the configuration
- The `fetchKanbanPlans` handler simply needs to use `_getAllowedRoots()` instead of `_getWorkspaceRoots()`

## Metadata
**Complexity:** 2
**Tags:** bugfix, ui, backend

## User Review Required
No user review required. This is a single-line substitution using an existing, well-tested internal method.

## Complexity Audit

### Routine
- Single-line change: `_getWorkspaceRoots()` → `Array.from(this._getAllowedRoots())`
- Uses existing `_getAllowedRoots()` method already exercised by `_resolveWorkspaceRoot()` and other handlers
- No new architectural patterns or state management
- Backward-compatible: unmapped setups fall back to identical behavior

### Complex / Risky
- None

## Edge-Case & Dependency Audit

### Race Conditions
- None. `fetchKanbanPlans` is already guarded by a request-id deduplication mechanism (`_latestRequestIds`). Changing the root source does not alter concurrency behavior.

### Security
- `_getAllowedRoots()` only adds paths explicitly configured in workspace mappings. No external input is accepted.
- The downstream `openKanbanPlan` and `setKanbanPlanContext` handlers still use the outer-scope `allRoots` derived from `_getWorkspaceRoots()`. A plan file located in a mapped parent (but not an open workspace folder) could theoretically be rejected by those security checks. This is a pre-existing limitation outside the scope of the fetch fix.

### Side Effects
- Mapped parent folders without a `.switchboard/kanban.db` will be iterated but gracefully skipped (`KanbanDatabase._initialize` returns `false` when the DB file does not exist; `getBoard` returns `[]`).
- The `seenIds` Set continues to deduplicate plans when a mapped child workspace and its parent both appear in `_getAllowedRoots()`.

### Dependencies & Conflicts
- Depends on `WorkspaceIdentityService.getMappingsFromIndex()` remaining stable (same dependency already used by `_getAllowedRoots()`).
- No conflicts with parallel work; no schema changes.

## Dependencies
- None

## Adversarial Synthesis
Key risks: mapped parent DB missing (gracefully handled), duplicate plans from child+parent roots in `_getAllowedRoots()` (mitigated by `seenIds` Set), and downstream `openKanbanPlan` security check using narrower `_getWorkspaceRoots()` scope (pre-existing, not introduced by this change). Overall risk is very low.

## Proposed Changes

### `src/services/PlanningPanelProvider.ts`
**Context**: The `fetchKanbanPlans` handler at line 1777 iterates over `allRoots` to query kanban databases. When workspace mappings are configured, the mapped parent folder may not be an open VS Code workspace folder, so its database is never queried and its epics are invisible to the EPICS tab.

**Logic**: `_getAllowedRoots()` returns a `Set<string>` containing all VS Code workspace folders plus all mapped parent folders from the workspace mapping configuration. Converting it to an array and using it as the iteration source ensures every configured workspace database is queried.

**Implementation**:
```typescript
// Line 1777 — Before:
const allRoots = this._getWorkspaceRoots();

// Line 1777 — After:
const allRoots = Array.from(this._getAllowedRoots());
```

**Edge Cases**:
- **No mappings enabled**: `_getAllowedRoots()` falls back to returning VS Code workspace folders, so behavior is unchanged for non-mapped setups.
- **Mapped parent not open**: The handler will now query the database for the mapped parent folder even if it's not open as a VS Code workspace, which is the intended behavior.
- **Duplicate plan IDs**: The existing `seenIds` Set prevents duplicate plans from being added to the results.

## Verification Plan

### Manual Verification
1. Open project.html and switch to the EPICS tab
2. Verify that the epic "Online Docs Tab — Inline Editing & Unified Docs Model" appears in the list
3. Test workspace filter dropdown to ensure it correctly shows mapped workspaces
4. Switch to the Kanban plans tab and confirm it still works correctly
5. Open a non-mapped workspace setup and confirm epics/kanban continue to work

### Testing Checklist
- [ ] Epic appears in EPICS tab
- [ ] Workspace filter dropdown shows mapped workspaces
- [ ] Kanban plans tab still works correctly
- [ ] Non-mapped workspace setups continue to work

## Future Enhancements (Out of Scope)
- "Create Epic" button in UI
- Dedicated `.switchboard/plans/epics/` directory
- "Show on Kanban" toggle for epics

---
**Recommendation:** Send to Intern
