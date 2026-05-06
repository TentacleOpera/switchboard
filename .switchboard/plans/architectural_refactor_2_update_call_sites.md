# Architectural Refactor 2/4: Update All Call Sites

## Goal

Phase 2 of Workspace Single Source of Truth refactor.
Update all usages of the distributed state (`_activeWorkspaceRoot`, `_resolveWorkspaceRoot`) to use the new `KanbanProvider` event system and getters.

## Metadata

**Tags:** backend, infrastructure, reliability, workflow
**Complexity:** 7

## Dependencies

- .switchboard/plans/architectural_refactor_1_event_system.md

## Proposed Changes

### Phase 2: Update All Call Sites

#### [MODIFY] `src/services/TaskViewerProvider.ts` — Migrate all `_activeWorkspaceRoot` field usages

**Context:** The audit in Phase 1 identified 143+ usages of the `_activeWorkspaceRoot` field.

**Logic:** Migrate all usages based on their context category. Create a helper method for synchronous contexts where a null workspace cannot be handled.

**Implementation:**
```typescript
// NEW HELPER: Add to TaskViewerProvider
private _getCurrentWorkspaceOrThrow(): string {
    const ws = this._kanbanProvider?.getCurrentWorkspaceRoot();
    if (!ws) {
        throw new Error('Workspace required but no workspace is currently selected in kanban.');
    }
    return ws;
}
```

**Migration strategy by category:**
- **SYNC_READ sites**: Replace with `this._getCurrentWorkspaceOrThrow()` helper that throws if null (preserves sync contract for critical paths)
- **ASYNC sites**: Replace with `this._kanbanProvider?.getCurrentWorkspaceRoot()` with null propagation
- **Write sites**: Replace with `this._kanbanProvider?.setCurrentWorkspaceRoot()` or remove if kanban already handles it

#### [MODIFY] `src/extension.ts:2769-2776` — Update createAgentGrid

**Context:** Terminal spawning function that currently uses activation-time workspace.

**Logic:** Remove fallback to activation-time workspace. Kanban MUST have selection, or show error.

**Implementation:**
```typescript
async function createAgentGrid() {
    const currentWorkspaceRoot = kanbanProvider.getCurrentWorkspaceRoot();
    
    if (!currentWorkspaceRoot) {
        vscode.window.showWarningMessage('Please select a workspace in the kanban before opening terminals.');
        return;
    }

    // No fallback to workspaceRoot — kanban is source of truth
    const effectiveWorkspaceRoot = kanbanProvider.resolveEffectiveWorkspaceRoot(currentWorkspaceRoot);
    // ... rest unchanged
}
```

#### [MODIFY] `src/services/TaskViewerProvider.ts` — Update all _resolveWorkspaceRoot call sites

**Context:** 20+ direct calls to `this._resolveWorkspaceRoot()` plus 143+ field usages.

**Logic:** Replace with `this._kanbanProvider?.getCurrentWorkspaceRoot()` with null propagation.

**Example transformations:**
```typescript
// BEFORE:
const resolvedRoot = this._resolveWorkspaceRoot(workspaceRoot);

// AFTER:
const resolvedRoot = workspaceRoot 
    ?? this._kanbanProvider?.getCurrentWorkspaceRoot() 
    ?? null;
```

#### [MODIFY] `src/services/TaskViewerProvider.ts` — Update file watchers for dynamic re-registration

**Context:** File watcher setup currently happens once at initialization with cached workspace. Find `_setupPlanWatchers` method.

**Logic:** Watchers must re-register when workspace changes. Subscribe to kanban's `onWorkspaceChange` event.

**Implementation:**
```typescript
// In constructor or initialization:
this._kanbanProvider?.onWorkspaceChange((newWorkspace) => {
    this._reRegisterFileWatchers(newWorkspace);
    this._refreshSidebarData(newWorkspace);
});

// NEW: Method to handle workspace transitions
private _reRegisterFileWatchers(workspaceRoot: string | null): void {
    // Dispose existing watchers
    for (const watcher of this._planContentWatchers) {
        watcher.dispose();
    }
    this._planContentWatchers = [];
    
    if (!workspaceRoot) { return; }
    
    // Re-register for new workspace
    this._setupPlanWatchers(workspaceRoot);
}
```

#### [MODIFY] `src/services/TaskViewerProvider.ts` — Update sidebar initialization for null workspace

**Context:** Sidebar currently assumes workspace exists at initialization. Find `getChildren()` method.

**Logic:** Handle case where kanban has no workspace selected yet.

**Implementation:**
```typescript
// In sidebar tree provider:
public getChildren(element?: vscode.TreeItem): vscode.ProviderResult<vscode.TreeItem[]> {
    const workspaceRoot = this._kanbanProvider?.getCurrentWorkspaceRoot();
    
    if (!workspaceRoot) {
        // Return placeholder item instructing user to select workspace
        return [new vscode.TreeItem('Select a workspace in kanban...')];
    }
    
    // ... existing logic
}
```

#### [DELETE] `src/services/InboxWatcher.ts` — Remove dead cross-IDE messaging system

**Context:** The InboxWatcher implements a file-based cross-IDE messaging protocol for dispatching commands to terminals across VS Code windows. However:
- No UI element exists for manual inbox message creation
- MCP tools (the agent-side writers) were discontinued
- Single-workspace-per-window model makes cross-window dispatch unnecessary
- Entire system is effectively dead code

**Logic:** Remove InboxWatcher and all related infrastructure. Simplifies the workspace refactor by eliminating a component that tracked workspace state.

**Files to delete:**
- `src/services/InboxWatcher.ts` (1,089 lines)
- `src/services/SessionActionLog.ts` (only consumer of InboxWatcher)

**Files to modify:**
- `src/extension.ts`: Remove all `inboxWatcher` references (~15 locations), cleanup timers, and inbox initialization
- `src/services/TaskViewerProvider.ts`: Remove `_executeRemote()` method and inbox fallback logic in `_dispatchExecuteMessage()`
- `src/lifecycle/cleanWorkspace.ts`: Keep inbox/outbox cleanup for existing installs, but remove from TRANSIENT_DIRS after migration period
- `src/services/terminalUtils.ts`: Remove comment referencing InboxWatcher

**Implementation:**
```typescript
// In TaskViewerProvider.ts - simplify dispatch to direct-only:
private async _dispatchExecuteMessage(...): Promise<void> {
    // REMOVED: inbox fallback path - all terminals must be local now
    const pushed = await this._attemptDirectTerminalPush(targetAgent, payload, messageId, meta);
    if (!pushed) {
        throw new Error(`Terminal '${targetAgent}' not found. Inbox fallback removed.`);
    }
}
```

## Verification Plan

### Unit Tests

**Test: Sidebar reacts to workspace change**
```typescript
it('should refresh sidebar when kanban workspace changes', async () => {
    const refreshSpy = sinon.spy(taskViewerProvider, '_refreshSidebarData');
    
    kanbanProvider.setCurrentWorkspaceRoot('/newWorkspace');
    await new Promise(r => setTimeout(r, 50)); // Allow async propagation
    
    expect(refreshSpy.calledWith('/newWorkspace')).toBe(true);
});
```

**Test: Terminals refuse without workspace selection**
```typescript
it('should show error when opening terminals with no workspace selected', async () => {
    kanbanProvider.setCurrentWorkspaceRoot(null);
    
    await createAgentGrid();
    
    expect(vscode.window.showWarningMessage.calledWith(
        'Please select a workspace in the kanban before opening terminals.'
    )).toBe(true);
});
```

## Success Criteria
1. All components react to workspace change events.
2. Terminals always open in kanban-selected workspace.
3. File watchers correctly re-register on workspace switch.
4. Sidebar shows placeholder when no workspace selected.
5. InboxWatcher and SessionActionLog removed (~1,150 lines deleted).
6. No inbox/outbox directory references remain in active code paths.
7. Terminal dispatch is direct-only (no cross-window fallback).
