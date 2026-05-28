# Fix: Kanban Board Auto-Switches Workspace on File Save

## Problem Description

When an agent is working on a file in one workspace and saves it, if the user has a different workspace open on the Switchboard kanban board, the act of saving the file automatically switches the workspace on the kanban board without user input. The board then appears blank, showing no data rather than the expected workspace content.

## Root Cause Analysis

The issue is in `KanbanProvider._resolveWorkspaceRoot()` (lines 507-528 in `src/services/KanbanProvider.ts`):

```typescript
private _resolveWorkspaceRoot(workspaceRoot?: string): string | null {
    const allowedRoots = this._getAllowedRoots();
    if (allowedRoots.size === 0) { return null; }
    if (workspaceRoot) {
        const resolved = path.resolve(workspaceRoot);
        if (allowedRoots.has(resolved)) {
            this._currentWorkspaceRoot = resolved;  // ← BUG: Auto-switches workspace
            return resolved;
        }
    }
    // ... fallback logic
}
```

**The Problem:** Line 513 automatically updates `this._currentWorkspaceRoot` whenever `_resolveWorkspaceRoot` is called with a valid `workspaceRoot` parameter. This method is called from many code paths, including:

1. File save handlers (via GlobalPlanWatcherService → onPlanDiscovered → refreshIfShowing)
2. Various UI operations that pass a workspaceRoot parameter
3. Database operations that specify a workspace

When a file is saved in workspace A, but the kanban board is showing workspace B, the file watcher triggers a refresh path that calls `_resolveWorkspaceRoot(workspaceRoot)` with workspace A's path. This silently switches the current workspace to A, causing the board to show workspace A's data (or appear blank if the data loading fails).

## Why the Board Appears Blank

After the auto-switch:
1. The kanban webview still thinks it's showing the previous workspace (workspace B)
2. The backend has switched to workspace A
3. The webview requests data for workspace B, but the backend provides data for workspace A
4. The data mismatch causes the board to render incorrectly or appear blank

## Solution

### Option 1: Remove Auto-Switch from `_resolveWorkspaceRoot` (Recommended)

Remove the line that auto-updates `this._currentWorkspaceRoot` in `_resolveWorkspaceRoot`. The method should only resolve and validate the workspace, not change the selection.

**Changes needed:**
- In `KanbanProvider._resolveWorkspaceRoot()`, remove line 513: `this._currentWorkspaceRoot = resolved;`
- Add a new method `_resolveAndSetWorkspaceRoot()` for cases where we explicitly want to both resolve AND set the workspace
- Update call sites that need to set the workspace to use the new method

**Call sites that need the new method:**
- `setCurrentWorkspaceRoot()` - already exists, should be used for explicit workspace changes
- `selectWorkspace` message handler in `_handleMessage()` - should use `setCurrentWorkspaceRoot()`

### Option 2: Add a Parameter to Control Auto-Switch

Add a boolean parameter `autoSet = false` to `_resolveWorkspaceRoot` to control whether it should auto-switch. Only pass `true` from explicit user-initiated workspace changes.

**Pros:** Less invasive change
**Cons:** More complex API, easier to misuse

### Option 3: Guard Against Non-User-Initiated Switches

Add a flag to track whether a workspace change is user-initiated, and only allow auto-switch when the flag is set.

**Pros:** Preserves current behavior for explicit changes
**Cons:** Requires state management, more complex

## Recommended Implementation (Option 1)

### Step 1: Modify `_resolveWorkspaceRoot`

Remove the auto-switch behavior:

```typescript
private _resolveWorkspaceRoot(workspaceRoot?: string): string | null {
    const allowedRoots = this._getAllowedRoots();
    if (allowedRoots.size === 0) { return null; }
    if (workspaceRoot) {
        const resolved = path.resolve(workspaceRoot);
        if (allowedRoots.has(resolved)) {
            // REMOVED: this._currentWorkspaceRoot = resolved;
            return resolved;
        }
    }
    if (this._currentWorkspaceRoot && allowedRoots.has(this._currentWorkspaceRoot)) {
        return this._currentWorkspaceRoot;
    }

    const autoSelect = vscode.workspace.getConfiguration('switchboard').get<boolean>('autoSelectFirstWorkspace', true);
    if (autoSelect) {
        this._currentWorkspaceRoot = this._getWorkspaceRoots()[0] || Array.from(allowedRoots)[0];
        return this._currentWorkspaceRoot;
    }

    return null;
}
```

### Step 2: Verify Call Sites

Review all call sites of `_resolveWorkspaceRoot` to ensure they don't rely on the auto-switch behavior:

- `_refreshBoardImpl()` - uses resolved root for refresh, should not switch
- `_refreshBoardWithData()` - uses resolved root for refresh, should not switch
- `applyLiveSyncConfig()` - uses resolved root for config, should not switch
- `setKanbanOrderOverrides()` - uses resolved root for refresh, should not switch
- `cleanupKanbanColumnState()` - uses resolved root for cleanup, should not switch
- `sendVisibleAgents()` - uses resolved root for agents, should not switch
- `getControlPlaneSelectionStatus()` - uses resolved root for status, should not switch
- `setControlPlaneRoot()` - uses resolved root for refresh, should not switch
- `clearControlPlaneCache()` - uses resolved root for refresh, should not switch
- `triggerAction` handler - uses resolved root for dispatch, should not switch
- `triggerBatchAction` handler - uses resolved root for dispatch, should not switch
- `moveCardBackwards` handler - uses resolved root for move, should not switch
- `moveCardForward` handler - uses resolved root for move, should not switch

All of these should NOT auto-switch the workspace - they should operate on the specified workspace without changing the user's selection.

### Step 3: Update `selectWorkspace` Handler

Ensure the `selectWorkspace` message handler uses `setCurrentWorkspaceRoot()` for explicit user-initiated switches:

```typescript
case 'selectWorkspace':
    if (typeof msg.workspaceRoot === 'string' && msg.workspaceRoot.trim()) {
        const prevWorkspaceRoot = this._currentWorkspaceRoot;
        // Use setCurrentWorkspaceRoot for explicit user-initiated switch
        if (this.setCurrentWorkspaceRoot(msg.workspaceRoot)) {
            // ... rest of the handler
        }
    }
    break;
```

This is already the case in the current code (line 4104), so no change needed.

### Step 4: Add Regression Test

Add a test in `src/services/__tests__/KanbanProvider.test.ts`:

```typescript
suite('resolveWorkspaceRoot auto-switch bug', () => {
    test('should not auto-switch currentWorkspaceRoot when resolving a different workspace', () => {
        const provider = new KanbanProvider(vscode.Uri.file('/test'), mockContext);
        // Set initial workspace to /workspace1
        provider.setCurrentWorkspaceRoot('/workspace1');
        
        // Resolve a different workspace
        const resolved = (provider as any)._resolveWorkspaceRoot('/workspace2');
        
        // Verify it resolved correctly
        assert.strictEqual(resolved, '/workspace2');
        
        // Verify it did NOT auto-switch the current workspace
        assert.strictEqual(provider.getCurrentWorkspaceRoot(), '/workspace1');
    });
});
```

## Verification Steps

1. Open two workspaces in VS Code
2. Open the Switchboard kanban board showing workspace A
3. Open a file in workspace B
4. Save the file in workspace B
5. Verify the kanban board still shows workspace A (not blank, not switched to B)
6. Verify the board still displays workspace A's plans correctly

## Files to Change

1. `src/services/KanbanProvider.ts` - Remove auto-switch from `_resolveWorkspaceRoot`
2. `src/services/__tests__/KanbanProvider.test.ts` - Add regression test

## Risk Assessment

**Low Risk:** The change removes unintended behavior. All call sites reviewed either:
- Don't need the auto-switch (most cases)
- Already use `setCurrentWorkspaceRoot()` for explicit switches (selectWorkspace handler)

The only potential risk is if there's a call site that implicitly relied on the auto-switch behavior. However, this would be a bug in that call site, and removing the auto-switch exposes it rather than causing new issues.

## Related Issues

This is similar to previous workspace switching bugs:
- `fix-workspace-switching-issue.md`
- `fix-workspace-desync.md`
- `fix_terminal-state-desync-after-workspace-switch.md`

All of these suggest the workspace switching logic has been fragile and needs careful handling.
