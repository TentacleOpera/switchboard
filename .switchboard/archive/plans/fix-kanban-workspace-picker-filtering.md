# Fix Kanban Workspace Picker Filtering

## Goal
Fix the kanban workspace picker dropdown so that selecting a dropdown workspace filters the board to show only plans matching that workspace's repo scope, while selecting the parent workspace shows all plans unfiltered.

## Problem
The kanban.html workspace picker dropdown does not work correctly. When you choose a dropdown database, it simply shows the parent database board instead of a filtered view of all plan cards that match the dropdown workspace.

## Expected Behavior
- Selecting a dropdown workspace from the dropdown should show a filtered view of all plan cards that match the selected workspace (repo scope).
- Selecting the parent workspace should show ALL cards (filter cleared).
- The "FILTER: [workspace]" badge should appear when a dropdown workspace is active.

## Root Cause
The `selectWorkspace` message handler in KanbanProvider.ts does not set the `_repoScopeFilter` when a workspace is selected. The handler only changes the workspace root and refreshes the board, but doesn't apply the repo scope filter that would limit cards to the selected workspace.

The existing infrastructure for filtering is already in place:
- KanbanProvider has a `_repoScopeFilter` field (line 137)
- There's a `getRepoScopeFilter()` method (line 3306)
- TaskViewerProvider's `refreshRunSheets()` uses this filter when calling `db.getBoardFiltered()` vs `db.getBoard()` (lines 13329-13332)
- `_refreshBoard()` delegates to `switchboard.refreshUI` → `refreshRunSheets()`, so the filter IS consumed during refresh
- The frontend has an `activeWorkspaceFilter` variable that gets set from `msg.activeFilter` (line 4551)
- The frontend has a `getWorkspaceItemRepoScope()` function to extract repo scope from workspace items (line 3010)
- The frontend has `updateWorkspaceFilterBadge()` to show "FILTER: X" badge (line 3067)

The missing piece is connecting the workspace selection to the repo scope filter — and critically, clearing the filter when the parent workspace is selected.

## Metadata
- **Tags:** [frontend, backend, bugfix, UI]
- **Complexity:** 4

## User Review Required
- Confirm that selecting the parent workspace should clear the filter (show all cards) vs. setting a filter for the parent's folder name.
- Confirm that the `path.basename()` derivation of repo scope is acceptable (it matches how `getWorkspaceItemRepoScope()` works in the frontend and how `**Repo:**` metadata is typically populated).

## Complexity Audit

### Routine
- Adding `activeFilter` field to three existing `updateWorkspaceSelection` message sends (lines 1042, 1766, 1889)
- Frontend already handles `msg.activeFilter` — no frontend changes needed
- The `getBoardFiltered()` and `getCompletedPlansFiltered()` DB methods already exist and work correctly
- `path` module is already imported in KanbanProvider.ts (line 2)

### Complex / Risky
- Correctly distinguishing parent vs dropdown workspace selection to avoid accidentally filtering the parent view
- Handling the "reset control plane" action which sends `selectWorkspace` with `controlPlaneAction: 'reset-auto-detect'` — filter must be cleared on reset

## Edge-Case & Dependency Audit

- **Race Conditions:** None. The filter is set synchronously before the async `_refreshBoard()` call, so the filter value is guaranteed to be correct when `refreshRunSheets()` reads it via `getRepoScopeFilter()`.
- **Security:** `path.basename()` cannot produce path-traversal values (it returns a single path segment). The DB's `getBoardFiltered()` uses parameterized queries, so SQL injection is not a concern.
- **Side Effects:** Setting `_repoScopeFilter` affects ALL subsequent board refreshes until it is changed or cleared. This is the desired behavior — the filter persists across refreshes until the user selects a different workspace.
- **Dependencies & Conflicts:** The `resolveEffectiveWorkspaceRoot()` method (line 3160) already resolves the parent workspace root for a given root by checking `workspaceDatabaseMappings` config. This is the correct utility to distinguish parent from dropdown workspaces.

## Dependencies
None

## Adversarial Synthesis
Key risks: (1) Setting the filter for parent workspace selections would hide dropdown workspace plans from the parent view — must clear filter for parent. (2) The "reset control plane" action reuses the `selectWorkspace` message type and must also clear the filter. Mitigations: Use `resolveEffectiveWorkspaceRoot()` to detect dropdown vs parent; check `controlPlaneAction` for reset-type actions.

## Solution

### 1. Update KanbanProvider.ts `selectWorkspace` handler

File: `/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts`

Location: Line 3774-3783 (the `selectWorkspace` case in `_handleMessage`)

Current code:
```typescript
case 'selectWorkspace':
    if (typeof msg.workspaceRoot === 'string' && msg.workspaceRoot.trim()) {
        this.setCurrentWorkspaceRoot(msg.workspaceRoot);

        this._setupSessionWatcher();
        // Sync TaskViewerProvider's plan watcher to the new workspace
        this._taskViewerProvider?.reinitializePlanWatcher(msg.workspaceRoot);
        await this._refreshBoard(msg.workspaceRoot);
    }
    break;
```

Updated code:
```typescript
case 'selectWorkspace':
    if (typeof msg.workspaceRoot === 'string' && msg.workspaceRoot.trim()) {
        this.setCurrentWorkspaceRoot(msg.workspaceRoot);

        // Reset control plane action: always clear the filter to show all cards,
        // regardless of which workspace root is currently active.
        // The frontend sends controlPlaneAction: 'reset-auto-detect' when the
        // reset button is clicked — the filter must not persist after reset.
        if (msg.controlPlaneAction === 'reset-auto-detect') {
            this._repoScopeFilter = null;
        } else {
            // Determine if the selected workspace is a dropdown (sub-workspace)
            // or the parent workspace. Only dropdown workspaces should trigger filtering.
            const effectiveRoot = this.resolveEffectiveWorkspaceRoot(msg.workspaceRoot);
            const isDropdown = path.resolve(msg.workspaceRoot) !== effectiveRoot;

            if (isDropdown) {
                // Dropdown workspace: set repo scope filter to the folder name
                const repoScope = path.basename(path.resolve(msg.workspaceRoot));
                this._repoScopeFilter = repoScope;
            } else {
                // Parent workspace: clear the filter to show all cards
                this._repoScopeFilter = null;
            }
        }

        this._setupSessionWatcher();
        // Sync TaskViewerProvider's plan watcher to the new workspace
        this._taskViewerProvider?.reinitializePlanWatcher(msg.workspaceRoot);
        await this._refreshBoard(msg.workspaceRoot);
    }
    break;
```

**Why `resolveEffectiveWorkspaceRoot()`**: This method (line 3160) checks the `workspaceDatabaseMappings` config to find the parent workspace root for a given root. If the selected root is a dropdown workspace (listed in `dropdownWorkspaces`), it returns the parent root — which differs from the selected root. If the selected root IS the parent, it returns the same root. This cleanly distinguishes the two cases without adding new flags or config.

**Why clear on parent selection**: The `getBoardFiltered()` SQL uses `repo_scope IN (?, '')`, which includes unscoped plans. If we set the filter to the parent's folder name (e.g., `'switchboard'`), plans from dropdown workspaces with non-empty `repo_scope` would be excluded from the parent view. Clearing the filter (`null`) causes `refreshRunSheets()` to call `getBoard()` instead, returning all plans.

### 2. Update KanbanProvider.ts to send activeFilter in updateWorkspaceSelection message

File: `/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts`

Locations: Lines 1042-1046, 1766-1770, 1889-1893 (where `updateWorkspaceSelection` messages are sent)

Current code (all three locations):
```typescript
this._panel.webview.postMessage({
    type: 'updateWorkspaceSelection',
    workspaceRoot: resolvedWorkspaceRoot,
    workspaces: workspaceItems
});
```

Updated code (all three locations):
```typescript
this._panel.webview.postMessage({
    type: 'updateWorkspaceSelection',
    workspaceRoot: resolvedWorkspaceRoot,
    workspaces: workspaceItems,
    activeFilter: this._repoScopeFilter || null
});
```

**Frontend already handles this**: The `updateWorkspaceSelection` handler at line 4548 already reads `msg.activeFilter` and sets `activeWorkspaceFilter`. The `updateWorkspaceFilterBadge()` function (line 3067) shows/hides the "FILTER: X" badge. No frontend changes are needed.

### 3. Add a setter method for repoScopeFilter (optional)

File: `/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts`

Location: After line 3308 (after `getRepoScopeFilter()` method)

Add:
```typescript
public setRepoScopeFilter(filter: string | null): void {
    this._repoScopeFilter = filter;
}
```

This is purely optional — it provides encapsulation for external callers that may need to set the filter in the future, but no current caller requires it.

## Files to Modify
- `/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts`

## Verification Plan

### Automated Tests
- Existing test at `src/test/control-plane-repo-scope.test.js` line 120-125 verifies that `_repoScopeFilter` field exists in KanbanProvider. This test should continue to pass.
- No new automated tests are required for this change (the filtering logic is already tested via `getBoardFiltered`).

### Manual Testing
1. Open kanban.html in a multi-root workspace with dropdown workspaces configured
2. Select a dropdown workspace from the dropdown
3. Verify that only cards matching that workspace are displayed
4. Verify that the "FILTER: [workspace]" badge appears in the UI
5. Select the parent workspace from the dropdown
6. Verify that ALL cards are displayed (no filtering)
7. Verify that the filter badge is hidden when the parent is selected
8. Click the "reset control plane" button
9. Verify that the filter is cleared and all cards are shown

## Risks
- Low risk: The change is minimal and leverages existing filtering infrastructure
- The repo scope is derived from the workspace root path basename, which matches the frontend's `getWorkspaceItemRepoScope()` logic and the typical `**Repo:**` plan metadata
- If the workspace root path structure changes, the filtering may not work correctly
- The `resolveEffectiveWorkspaceRoot()` method depends on `workspaceDatabaseMappings` config being correctly set up — if mappings are misconfigured, the parent/dropdown distinction may fail (falls back to treating the root as parent, which safely clears the filter)

## Recommendation
Complexity 4 → **Send to Coder**

---

## Review Pass (2026-05-21)

### Stage 1: Grumpy Principal Engineer Findings

| # | Severity | Finding |
|---|----------|---------|
| 1 | **CRITICAL** | `controlPlaneAction: 'reset-auto-detect'` completely ignored in `selectWorkspace` handler. The plan's own Adversarial Synthesis identified this risk, but the implementation didn't handle it. When user clicks "reset control plane" while viewing a dropdown workspace, `isDropdown` evaluates to `true`, so the filter gets SET instead of CLEARED — the exact opposite of intended behavior. |
| 2 | NIT | `setRepoScopeFilter()` method is dead code — no caller uses it. Harmless but unnecessary. |
| 3 | NIT | `path.basename(path.resolve(msg.workspaceRoot))` — the `path.resolve()` is redundant; `path.basename()` works fine on the raw string. Harmless. |

### Stage 2: Balanced Synthesis

- **Keep**: Core `resolveEffectiveWorkspaceRoot()` parent/dropdown logic, `activeFilter` additions to all three `updateWorkspaceSelection` sends, filter clearing on parent selection, `setRepoScopeFilter()` (harmless, future-proofing).
- **Fix now**: Add `controlPlaneAction === 'reset-auto-detect'` check before the `isDropdown` logic — unconditionally clear filter on reset.
- **Defer**: NITs 2 and 3 — cosmetic, no functional impact.

### Stage 3: Code Fixes Applied

**File changed**: `src/services/KanbanProvider.ts` (line ~4015)

Added `controlPlaneAction` check to `selectWorkspace` handler:
- When `msg.controlPlaneAction === 'reset-auto-detect'`, unconditionally set `this._repoScopeFilter = null`
- Only then fall through to the `isDropdown` logic for normal workspace selections
- This ensures the "reset control plane" button always clears the filter, regardless of which workspace root is active

### Stage 4: Verification Results

- **TypeScript check**: `npx tsc --noEmit` — only pre-existing TS2835 errors (unrelated import extension issues). No new errors introduced by the fix.
- **Existing test**: `node src/test/control-plane-repo-scope.test.js` — **PASSED**. The test verifies `_repoScopeFilter` field exists and `refreshRunSheets` uses filtered queries correctly.
- **Manual testing**: Not performed (requires VS Code extension host with multi-root workspace). Steps 1-9 from the Verification Plan remain applicable.

### Remaining Risks

- The `controlPlaneAction` values from dropdown selection (`'explicit'`, `'auto'`) are not explicitly handled — they fall through to the `isDropdown` logic, which is correct behavior (filtering by dropdown, clearing for parent). No issue.
- If future `controlPlaneAction` values are added that should also clear the filter, the `if` check should be extended (e.g., using a Set of reset-like actions).
