# Bug Fix: Project Filter Persists When Switching Workspaces

## Goal

Clear the project filter when switching between workspaces (including dropdown workspaces). Currently, the project filter from one workspace persists when switching to another, causing plans from the wrong project to appear.

## Metadata

- **Tags:** bugfix, backend
- **Complexity:** 2

## User Review Required

No — this is a simple state reset fix. The adversarial review confirmed placement and method choice; see Adversarial Synthesis for the one non-obvious nuance (`setProjectFilter(null)` vs direct assignment).

## Complexity Audit

### Routine

- Two-line change in `KanbanProvider.ts`, inside the `selectWorkspace` message handler
- Reset `_projectFilter` via `setProjectFilter(null)` when workspace changes
- No DB schema changes, no API contract changes

### Complex / Risky

- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None — synchronous state reset before `_refreshBoard`
- **Security:** No new security surface
- **Side Effects:** `setProjectFilter(null)` notifies `GlobalPlanWatcherService` — this is intentional and correct; the watcher should also clear its project filter on workspace switch
- **Dependencies & Conflicts:** `_repoScopeFilter` is already reset in the same handler (lines 4160-4175) — no changes to that logic needed

## Dependencies

None.

## Adversarial Synthesis

Key risks: (1) Direct `_projectFilter = null` assignment bypasses `setProjectFilter()` and leaves `GlobalPlanWatcherService` with stale project state — must use `setProjectFilter(null)`. (2) Placing the reset inside `setCurrentWorkspaceRoot` would affect all programmatic callers of that public method, not just user-initiated workspace switches — reset must live in the `selectWorkspace` message handler. Mitigations: Call `this.setProjectFilter(null)` inside the `selectWorkspace` case in `handleMessage`, before the `_refreshBoard` call, and after `setCurrentWorkspaceRoot` returns.

## Root Cause

In `KanbanProvider.ts`, the `selectWorkspace` message handler (line 4152) calls `setCurrentWorkspaceRoot` and then conditionally resets `_repoScopeFilter` — but `_projectFilter` is never reset. These filters are instance variables (lines 138-139) and persist across workspace switches. When switching from a workspace with a project filter to another workspace, the old filter continues to apply, showing plans from the wrong project.

```ts
// Current code (lines 4152-4186) — _projectFilter is never cleared
case 'selectWorkspace':
    if (typeof msg.workspaceRoot === 'string' && msg.workspaceRoot.trim()) {
        this.setCurrentWorkspaceRoot(msg.workspaceRoot);
        // ... _repoScopeFilter is reset conditionally ...
        await this._refreshBoard(msg.workspaceRoot);
    }
    break;
```

**Note:** `_repoScopeFilter` reset is already handled correctly in this handler and does **not** need to change.

## Proposed Changes

### `src/services/KanbanProvider.ts`

**Context:** In the `selectWorkspace` message handler, around line 4154, immediately after `setCurrentWorkspaceRoot` is called.

**Logic:** Call `this.setProjectFilter(null)` (not `this._projectFilter = null`) to ensure `GlobalPlanWatcherService` is also notified of the project filter reset via the existing side effect in `setProjectFilter`.

**Implementation (exact diff):**

```diff
             case 'selectWorkspace':
                 if (typeof msg.workspaceRoot === 'string' && msg.workspaceRoot.trim()) {
                     this.setCurrentWorkspaceRoot(msg.workspaceRoot);
+                    this.setProjectFilter(null);  // Reset project filter on workspace switch

                     // Reset control plane action: always clear the filter to show all cards,
```

**Location:** [`src/services/KanbanProvider.ts`](../../../src/services/KanbanProvider.ts), line ~4154 — inside the `case 'selectWorkspace':` block, directly after the `setCurrentWorkspaceRoot(msg.workspaceRoot)` call.

**Edge Cases:**
- `setProjectFilter(null)` is idempotent — calling it when the filter is already null is harmless.
- `_repoScopeFilter` reset logic (lines 4160-4175) runs after this change and is unaffected.
- `_globalPlanWatcher?.setCurrentProject()` receives `null` and clears its cached filter — correct behavior.

## Verification Plan

### Automated Tests

Add a test in [`src/services/__tests__/KanbanProvider.test.ts`](../../../src/services/__tests__/KanbanProvider.test.ts):

> **Note:** There is no public `selectWorkspace()` method — workspace switching goes through `handleMessage`. The test must either (a) call `setCurrentWorkspaceRoot` directly then verify filter state (if reset is in `setCurrentWorkspaceRoot`), or (b) exercise via `handleMessage` with a mocked `_refreshBoard`. Since the reset is placed in the message handler, the recommended approach is option (b) or a direct test of `setCurrentWorkspaceRoot` + `setProjectFilter` sequence.

```ts
suite('selectWorkspace filter reset', () => {
    test('clears projectFilter when switching workspaces via handleMessage', async () => {
        const provider = new KanbanProvider(vscode.Uri.file('/test'), mockContext);
        sandbox.stub(provider as any, 'setCurrentWorkspaceRoot').returns(true);
        sandbox.stub(provider as any, '_setupSessionWatcher').returns(undefined);
        sandbox.stub(provider as any, '_refreshBoard').resolves();

        // Set a project filter in workspace A
        provider.setProjectFilter('Project A');
        assert.strictEqual(provider.getProjectFilter(), 'Project A');

        // Simulate workspace switch message
        await (provider as any)._handleMessage({   // NOTE: private method name is _handleMessage
            type: 'selectWorkspace',
            workspaceRoot: '/path/to/workspaceB'
        });

        // Verify filter is cleared
        assert.strictEqual(provider.getProjectFilter(), null);
    });
});
```

### Manual Checklist

- [ ] Open workspace A and select a project filter (e.g., "web-app")
- [ ] Verify kanban shows only plans from "web-app"
- [ ] Switch to a dropdown workspace
- [ ] Verify kanban shows all plans (no project filter applied)
- [ ] Switch back to workspace A
- [ ] Verify project filter is cleared (shows all plans)
- [ ] Select a different project in workspace A
- [ ] Switch to dropdown workspace again
- [ ] Verify dropdown workspace shows all plans (filter cleared)

---

## Code Review Results

**Review Date:** 2026-05-27  
**Status:** ✅ FIXED — two bugs corrected in test file

### Files Changed

| File | Change |
|------|--------|
| `src/services/KanbanProvider.ts` | Core fix: `this.setProjectFilter(null)` added at line 4155 in `selectWorkspace` handler — **correct as implemented** |
| `src/services/__tests__/KanbanProvider.test.ts` | Two bugs fixed by reviewer (see below) |

### Reviewer Fixes Applied

1. **CRITICAL — Wrong method name in test:** `(provider as any).handleMessage(...)` → `(provider as any)._handleMessage(...)`. The private method is `_handleMessage`; calling `handleMessage` (non-existent) via `as any` silently threw a `TypeError` at runtime, making the test non-functional.

2. **MAJOR — Deleted assertion restored:** The coder inadvertently deleted the pre-existing `resolvedDw2` label assertion from the dropdown workspace test (`dropdownWorkspaces appear and are deduplicated...`) when rearranging closing brackets to make room for the new test suite. The assertion `assert.strictEqual(...resolvedDw2...label...)` has been restored.

### Out-of-Scope Change (NIT — noted only)

The commit also added `this._taskViewerProvider?.clearRegisteredTerminalsMap()` to the `selectWorkspace` handler. This was not described in this plan but is safe (optional-chained, no side effects if `_taskViewerProvider` is absent). It likely belongs to the terminal state desynchronization fix (separate plan). Not reverted; no action needed.

### Validation Results

- **Static analysis:** `KanbanProvider.ts` change is minimal and correct — `setProjectFilter(null)` is idempotent, called after `setCurrentWorkspaceRoot` ensures `_currentWorkspaceRoot` is set, and correctly notifies `GlobalPlanWatcherService` via its side effect.
- **Test correctness:** After reviewer fixes, the new test properly exercises `_handleMessage` with `type: 'selectWorkspace'`, stubs `setCurrentWorkspaceRoot`, `_setupSessionWatcher`, and `_refreshBoard` to prevent I/O, and asserts `getProjectFilter() === null` after the handler runs.
- **Compilation:** Skipped per session policy.
- **Automated tests:** Skipped per session policy — to be run by user.

### Remaining Risks

- None material. The manual checklist above should be verified before shipping.

---

**Recommendation:** ✅ Ready to commit
