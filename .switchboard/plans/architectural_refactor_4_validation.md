# Architectural Refactor 4/4: Validation & Cleanup

## Goal

Phase 4 of Workspace Single Source of Truth refactor.
Add safety validations to the new setter and conduct comprehensive manual integration tests to verify the entire system.

## Metadata

**Tags:** backend, infrastructure, reliability, workflow
**Complexity:** 4

## Dependencies

- .switchboard/plans/architectural_refactor_3_remove_state.md

## Proposed Changes

### Phase 4: Validation & Cleanup

#### [MODIFY] `package.json` — Add escape hatch settings

**Context:** Add settings to `contributes.configuration` for users who need the legacy behavior or want to disable the single-source refactor entirely if issues arise.

**Logic:** Add `switchboard.singleSourceWorkspace` and `switchboard.autoSelectFirstWorkspace`.

**Implementation:**
```json
"switchboard.singleSourceWorkspace": {
    "type": "boolean",
    "default": true,
    "description": "Use the kanban board as the single source of truth for workspace selection."
},
"switchboard.autoSelectFirstWorkspace": {
    "type": "boolean",
    "default": true,
    "description": "Legacy behavior: automatically select the first workspace on activation if none is selected."
}
```

*Note: Also ensure that the codebase respects these settings if `switchboard.autoSelectFirstWorkspace` is true (e.g., auto-select the first root if KanbanProvider initially has no workspace).*

#### [CREATE] `src/services/KanbanProvider.ts` — Add _getAllowedRoots helper method

**Context:** Extract validation logic from `_resolveWorkspaceRoot` into reusable helper.

**Logic:** Extract multi-root and workspace mapping validation into standalone method.

**Implementation:**
```typescript
// NEW METHOD to add to KanbanProvider class
private _getAllowedRoots(): Set<string> {
    const roots = this._getWorkspaceRoots();
    const allowedRoots = new Set<string>(roots);
    
    // Include mapped workspace folders if mapping enabled
    const state = this._getCurrentState();
    if (state?.workspaceDatabaseMapping) {
        for (const mapping of Object.values(state.workspaceDatabaseMapping)) {
            if (mapping.workspaceRoot) {
                allowedRoots.add(path.resolve(mapping.workspaceRoot));
            }
        }
    }
    
    return allowedRoots;
}
```

#### [MODIFY] `src/services/KanbanProvider.ts` — Add workspace validation to setter

**Context:** `setCurrentWorkspaceRoot` should validate against allowed roots using `_getAllowedRoots()`.

**Logic:** Reject invalid workspaces before setting/emitting.

**Implementation:**
```typescript
public setCurrentWorkspaceRoot(workspaceRoot: string | null): boolean {
    if (!workspaceRoot) {
        const oldRoot = this._currentWorkspaceRoot;
        this._currentWorkspaceRoot = null;
        if (oldRoot !== null) {
            this._onWorkspaceChangeEmitter.fire(null);
        }
        return true;
    }
    
    const allowedRoots = this._getAllowedRoots();
    if (!allowedRoots.has(path.resolve(workspaceRoot))) {
        console.error(`[KanbanProvider] Rejected invalid workspace: ${workspaceRoot}`);
        return false;
    }
    
    const oldRoot = this._currentWorkspaceRoot;
    if (oldRoot === workspaceRoot) { return true; }
    
    this._currentWorkspaceRoot = workspaceRoot;
    this._onWorkspaceChangeEmitter.fire(workspaceRoot);
    return true;
}
```

## Verification Plan

### Manual Integration Tests

**Test: Complete workflow**
1. Open VS Code: with 3 workspace folders
2. **Verify:** Sidebar shows "Select workspace in kanban..." (no auto-selection)
3. Open kanban, select workspace B
4. **Verify:** Sidebar populates with workspace B plans
5. Click "Open Agent Terminals"
6. **Verify:** Terminals open with cwd = workspace B
7. In kanban, switch to workspace C
8. **Verify:** Sidebar refreshes to show workspace C plans
9. **Verify:** Existing terminals remain in workspace B (no disruption)
10. Close all terminals, click "Open Agent Terminals"
11. **Verify:** New terminals open with cwd = workspace C

**Test: Rapid workspace switching**
1. Open kanban
2. Rapidly click workspace dropdown 10 times (different selections)
3. **Verify:** UI stays responsive, no duplicate watchers, final selection is correct
4. Check console for "Workspace changed" logs — should be debounced

**Test: File watcher re-registration**
1. Select workspace A, create a plan file
2. **Verify:** File appears in kanban immediately (watcher working)
3. Switch to workspace B
4. Create plan file in workspace B
5. **Verify:** File appears in kanban (new watcher working)
6. Create plan file in workspace A
7. **Verify:** File does NOT appear (old watcher disposed, no cross-contamination)

**Test: Extension reload**
1. Select workspace B
2. Reload VS Code: window
3. **Verify:** Kanban restores workspace B selection
4. **Verify:** Sidebar populates with workspace B (not empty or workspace A)

### Regression Tests

- Single-workspace setup (should still work, just require explicit selection)
- Workspace mappings enabled (resolveEffectiveWorkspaceRoot still works)
- Brain file mirroring (no cross-workspace contamination)
- Plan creation from sidebar (creates in selected workspace)
- Database operations (all use correct workspace DB)

## Rollback Plan

If critical issues emerge:
1. **Immediate:** Revert the entire set of PRs — partial state is unsafe due to interdependence
2. **Data safety:** User data in `kanban.db` files is safe (no migration or data changes)
3. **User impact:** Users may need to re-select workspace in kanban after rollback
4. **Escape hatch:** Add setting `switchboard.singleSourceWorkspace: false` to disable new behavior without full revert

## Migration Guide (for future developers)

### Before (cached state):
```typescript
// In any provider
const workspace = this._resolveWorkspaceRoot(); // May return cached value
```

### After (single source of truth):
```typescript
// Option 1: Direct kanban access
const workspace = this._kanbanProvider?.getCurrentWorkspaceRoot();

// Option 2: Subscribe to changes
this._kanbanProvider?.onWorkspaceChange((workspace) => {
    this._handleWorkspaceChange(workspace);
});

// Option 3: For UI components that need reactive updates
// Use the event system, don't cache
```

## Success Criteria
1. All existing tests pass plus new event system tests.
2. Manual testing confirms rapid switching, reload, and edge cases work correctly.
