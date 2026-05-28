# Fix: Kanban Board Auto-Switches Workspace on File Save

## Goal

Remove the unintended side effect in `KanbanProvider._resolveWorkspaceRoot()` that silently switches the active workspace whenever the method is called with a valid `workspaceRoot` parameter, causing the kanban board to desync from the user's selection.

## Metadata

- **Tags:** [bugfix, frontend, reliability]
- **Complexity:** 4

## User Review Required

- Confirm that the `autoSelect` fallback path (lines 522-524) should remain — it initializes `_currentWorkspaceRoot` when no workspace is selected yet, which is desired startup behavior, not a mid-session switch.
- Confirm that no call site intentionally relies on the auto-switch side effect of `_resolveWorkspaceRoot`.

## Complexity Audit

### Routine
- Remove single line (513) that auto-sets `_currentWorkspaceRoot` inside `_resolveWorkspaceRoot`
- Verify `selectWorkspace` handler already uses `setCurrentWorkspaceRoot()` (confirmed at line 4104)
- Add diagnostic logging when `_resolveWorkspaceRoot` is called with a workspaceRoot that differs from `_currentWorkspaceRoot`
- Add regression test

### Complex / Risky
- 69 total call sites of `_resolveWorkspaceRoot` must be audited for implicit dependency on the auto-switch side effect
- ~40+ call sites in `_handleMessage` (lines 4274-6197) pass `msg.workspaceRoot` from the webview — these are the most likely actual trigger of the observed bug

## Edge-Case & Dependency Audit

- **Race Conditions:** If two rapid `_resolveWorkspaceRoot` calls arrive with different workspace roots (e.g., from concurrent webview messages), the last one wins under the current code. After the fix, neither will switch — this is strictly better.
- **Security:** No security implications. Workspace roots are validated against `_getAllowedRoots()`.
- **Side Effects:** The auto-switch on line 513 does NOT fire `_onWorkspaceChangeEmitter` (only `setCurrentWorkspaceRoot` fires it at line 597). This means the webview is never notified of the silent switch, creating a backend-frontend desync. Removing line 513 eliminates this desync path entirely.
- **Dependencies & Conflicts:** The `autoSelect` fallback (lines 522-524) also sets `this._currentWorkspaceRoot`, but this is initialization behavior (no workspace selected yet) and should be preserved. No other known dependencies on the auto-switch side effect.

## Dependencies

- None

## Adversarial Synthesis

Key risks: (1) The plan's original trigger path analysis was incorrect — `refreshIfShowing` does NOT call `_resolveWorkspaceRoot`, so the actual trigger is likely through `_handleMessage` call sites. (2) With 69 call sites, removing the auto-switch could expose latent assumptions in any of them. (3) The `autoSelect` fallback path also auto-sets `_currentWorkspaceRoot` and must be explicitly preserved. Mitigations: All 69 call sites are read-only consumers of the resolved value; `setCurrentWorkspaceRoot()` already handles explicit switches; diagnostic logging will surface any remaining issues.

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

**The Problem:** Line 513 automatically updates `this._currentWorkspaceRoot` whenever `_resolveWorkspaceRoot` is called with a valid `workspaceRoot` parameter. This method is called from **69 call sites** across the codebase, including:

1. **~40+ `_handleMessage` call sites** (lines 4274-6197) — These pass `msg.workspaceRoot` from the webview. When the webview sends a message with a workspace root that differs from the currently selected workspace, `_resolveWorkspaceRoot(msg.workspaceRoot)` silently switches `_currentWorkspaceRoot`. This is the most likely actual trigger of the observed bug.
2. Public API methods like `applyLiveSyncConfig()` (line 199), `setKanbanOrderOverrides()` (line 416), `cleanupKanbanColumnState()` (line 3143), `getControlPlaneSelectionStatus()` (line 3546), `clearControlPlaneCache()` (line 3594)
3. Panel initialization (line 800)

**Correction:** The original plan incorrectly stated the trigger path as `GlobalPlanWatcherService → onPlanDiscovered → refreshIfShowing → _resolveWorkspaceRoot`. In reality, `refreshIfShowing()` (line 900) does its own `path.resolve` comparison and never calls `_resolveWorkspaceRoot`. The actual trigger is through `_handleMessage` call sites that pass `msg.workspaceRoot` from the webview.

**Important:** The auto-switch on line 513 does NOT fire `_onWorkspaceChangeEmitter` (only `setCurrentWorkspaceRoot()` fires it at line 597). This means the webview is never notified of the silent switch, creating a backend-frontend desync where the backend thinks it's showing workspace A but the webview still displays workspace B's UI.

## Why the Board Appears Blank

After the auto-switch:
1. The kanban webview still thinks it's showing the previous workspace (workspace B)
2. The backend has silently switched `_currentWorkspaceRoot` to workspace A
3. The webview requests data for workspace B, but the backend provides data for workspace A
4. The data mismatch causes the board to render incorrectly or appear blank

## Solution

### Option 1: Remove Auto-Switch from `_resolveWorkspaceRoot` (Recommended)

Remove the line that auto-updates `this._currentWorkspaceRoot` in `_resolveWorkspaceRoot`. The method should only resolve and validate the workspace, not change the selection.

**Changes needed:**
- In `KanbanProvider._resolveWorkspaceRoot()`, remove line 513: `this._currentWorkspaceRoot = resolved;`
- Do NOT add a new `_resolveAndSetWorkspaceRoot()` method — `setCurrentWorkspaceRoot()` (line 588) already serves this purpose
- Verify that `selectWorkspace` handler already uses `setCurrentWorkspaceRoot()` (confirmed at line 4104, no change needed)
- Add diagnostic logging when `_resolveWorkspaceRoot` is called with a workspaceRoot that differs from `_currentWorkspaceRoot`

### Option 2: Add a Parameter to Control Auto-Switch

Add a boolean parameter `autoSet = false` to `_resolveWorkspaceRoot` to control whether it should auto-switch. Only pass `true` from explicit user-initiated workspace changes.

**Pros:** Preserves current behavior by default, incremental change
**Cons:** With 69 call sites, a boolean parameter is a maintenance burden — every new call site must remember to pass `false`. Easier to misuse than removing the side effect entirely.

### Option 3: Guard Against Non-User-Initiated Switches

Add a flag to track whether a workspace change is user-initiated, and only allow auto-switch when the flag is set.

**Pros:** Preserves current behavior for explicit changes
**Cons:** Requires state management, more complex, still allows the side effect to exist

## Recommended Implementation (Option 1)

### Step 1: Modify `_resolveWorkspaceRoot` (line 507-528)

Remove the auto-switch behavior and add diagnostic logging:

```typescript
private _resolveWorkspaceRoot(workspaceRoot?: string): string | null {
    const allowedRoots = this._getAllowedRoots();
    if (allowedRoots.size === 0) { return null; }
    if (workspaceRoot) {
        const resolved = path.resolve(workspaceRoot);
        if (allowedRoots.has(resolved)) {
            // REMOVED: this._currentWorkspaceRoot = resolved;
            // Diagnostic: log when caller passes a different workspace than currently selected
            if (this._currentWorkspaceRoot && this._currentWorkspaceRoot !== resolved) {
                this._outputChannel?.appendLine(
                    `[KanbanProvider] _resolveWorkspaceRoot: resolved ${resolved} differs from current ${this._currentWorkspaceRoot} — not switching`
                );
            }
            return resolved;
        }
    }
    if (this._currentWorkspaceRoot && allowedRoots.has(this._currentWorkspaceRoot)) {
        return this._currentWorkspaceRoot;
    }

    // Initialization fallback: auto-select first workspace when none is selected.
    // This is desired startup behavior, NOT a mid-session switch — preserve it.
    const autoSelect = vscode.workspace.getConfiguration('switchboard').get<boolean>('autoSelectFirstWorkspace', true);
    if (autoSelect) {
        this._currentWorkspaceRoot = this._getWorkspaceRoots()[0] || Array.from(allowedRoots)[0];
        return this._currentWorkspaceRoot;
    }

    return null;
}
```

### Step 2: Verify Call Sites

All 69 call sites of `_resolveWorkspaceRoot` must be verified to not rely on the auto-switch side effect. Key categories:

**Category A — `_handleMessage` call sites (~40+ sites, lines 4274-6197):**
These pass `msg.workspaceRoot` from the webview. They use the resolved value for DB operations, card actions, and dispatches. None of them need the auto-switch — they should operate on the specified workspace without changing the user's selection. Examples:
- `triggerAction` handler (line 4274)
- `triggerBatchAction` handler (line 4354)
- `moveCardBackwards` handler (line 4376)
- `moveCardForward` handler (line 4388)
- `addProject` handler (line 4549)
- `deleteProject` handler (line 4658)
- Various other message handlers through line 6197

**Category B — Public API methods:**
- `applyLiveSyncConfig()` (line 199) — uses resolved root for config, should not switch
- `setKanbanOrderOverrides()` (line 416) — uses resolved root for refresh, should not switch
- `cleanupKanbanColumnState()` (line 3143) — uses resolved root for cleanup, should not switch
- `getControlPlaneSelectionStatus()` (line 3546) — uses resolved root for status, should not switch
- `clearControlPlaneCache()` (line 3594) — uses resolved root for refresh, should not switch

**Category C — Panel initialization:**
- `_resolveWorkspaceRoot()` with no argument (line 800) — falls through to current/auto-select, safe

**Category D — Dead code (no change needed):**
- `_refreshBoardImpl()` (line 1644) — defined but never called, irrelevant to the fix

**Category E — Explicit user-initiated switches (already correct):**
- `selectWorkspace` handler (line 4104) — already uses `setCurrentWorkspaceRoot()`, no change needed

### Step 3: Confirm `selectWorkspace` Handler (line 4101-4130)

The `selectWorkspace` message handler already uses `setCurrentWorkspaceRoot()` for explicit user-initiated switches:

```typescript
case 'selectWorkspace':
    if (typeof msg.workspaceRoot === 'string' && msg.workspaceRoot.trim()) {
        const prevWorkspaceRoot = this._currentWorkspaceRoot;
        this.setCurrentWorkspaceRoot(msg.workspaceRoot);  // ← Already correct
        // ... rest of the handler
    }
    break;
```

No change needed — this is the only call site that should switch the workspace, and it already uses the correct method.

### Step 4: Add Regression Test

Add a test in `src/services/__tests__/KanbanProvider.test.ts`:

```typescript
suite('resolveWorkspaceRoot auto-switch bug', () => {
    test('should not auto-switch currentWorkspaceRoot when resolving a different workspace', () => {
        // Setup: mock _getAllowedRoots to return both workspaces
        const allowedRoots = new Set(['/workspace1', '/workspace2']);
        sandbox.stub(provider as any, '_getAllowedRoots').returns(allowedRoots);

        // Set initial workspace to /workspace1
        (provider as any)._currentWorkspaceRoot = '/workspace1';

        // Resolve a different workspace
        const resolved = (provider as any)._resolveWorkspaceRoot('/workspace2');

        // Verify it resolved correctly
        assert.strictEqual(resolved, '/workspace2');

        // Verify it did NOT auto-switch the current workspace
        assert.strictEqual((provider as any)._currentWorkspaceRoot, '/workspace1');
    });

    test('should still resolve current workspace when no argument passed', () => {
        const allowedRoots = new Set(['/workspace1']);
        sandbox.stub(provider as any, '_getAllowedRoots').returns(allowedRoots);
        (provider as any)._currentWorkspaceRoot = '/workspace1';

        const resolved = (provider as any)._resolveWorkspaceRoot();

        assert.strictEqual(resolved, '/workspace1');
        assert.strictEqual((provider as any)._currentWorkspaceRoot, '/workspace1');
    });

    test('should auto-select first workspace when none is set and autoSelect is true', () => {
        const allowedRoots = new Set(['/workspace1', '/workspace2']);
        sandbox.stub(provider as any, '_getAllowedRoots').returns(allowedRoots);
        sandbox.stub(provider as any, '_getWorkspaceRoots').returns(['/workspace1', '/workspace2']);
        (provider as any)._currentWorkspaceRoot = null;

        // Mock VS Code configuration
        const getConfigStub = sandbox.stub(vscode.workspace, 'getConfiguration');
        getConfigStub.returns({
            get: sandbox.stub().withArgs('autoSelectFirstWorkspace', true).returns(true)
        } as any);

        const resolved = (provider as any)._resolveWorkspaceRoot();

        // Should auto-select the first workspace
        assert.strictEqual(resolved, '/workspace1');
        assert.strictEqual((provider as any)._currentWorkspaceRoot, '/workspace1');
    });
});
```

## Proposed Changes

### `src/services/KanbanProvider.ts`

- **Context:** `_resolveWorkspaceRoot` is called from 69 sites across the file. The method's contract should be pure resolution/validation with no state mutation.
- **Logic:** Remove line 513 (`this._currentWorkspaceRoot = resolved;`). Add diagnostic log when resolved root differs from current. Preserve the `autoSelect` fallback (lines 522-524) as initialization behavior.
- **Implementation:** See Step 1 above.
- **Edge Cases:** The `autoSelect` fallback path (lines 522-524) also sets `_currentWorkspaceRoot`, but this is desired initialization behavior when no workspace is selected yet — it must be preserved. The diagnostic logging helps identify any call sites that were implicitly relying on the auto-switch.

### `src/services/__tests__/KanbanProvider.test.ts`

- **Context:** Existing test suite at `src/services/__tests__/KanbanProvider.test.ts` (481 lines) uses sinon sandbox and mock context.
- **Logic:** Add three regression tests covering: (1) no auto-switch on different workspace, (2) current workspace preserved when no argument, (3) auto-select still works for initialization.
- **Implementation:** See Step 4 above. Must mock `_getAllowedRoots()` to return the test workspaces, since the real implementation depends on VS Code workspace folders.
- **Edge Cases:** Tests must set `_currentWorkspaceRoot` directly (via `(provider as any)._currentWorkspaceRoot`) rather than through `setCurrentWorkspaceRoot()`, because `setCurrentWorkspaceRoot` fires events and persists state that would interfere with test isolation.

## Verification Plan

### Automated Tests

- **Unit test:** `resolveWorkspaceRoot auto-switch bug` suite (3 tests) in `KanbanProvider.test.ts`
  - Test 1: Resolving a different workspace does not auto-switch `_currentWorkspaceRoot`
  - Test 2: Resolving with no argument returns the current workspace
  - Test 3: Auto-select fallback still works for initialization

### Manual Verification

1. Open two workspaces in VS Code
2. Open the Switchboard kanban board showing workspace A
3. Open a file in workspace B
4. Save the file in workspace B
5. Verify the kanban board still shows workspace A (not blank, not switched to B)
6. Verify the board still displays workspace A's plans correctly
7. Check the output channel for diagnostic logs: `[KanbanProvider] _resolveWorkspaceRoot: resolved X differs from current Y — not switching`

### Post-Deployment Monitoring

- Watch for the diagnostic log message in the output channel. If it appears frequently, it indicates call sites that were implicitly relying on the auto-switch and may need further investigation.

## Risk Assessment

**Low Risk:** The change removes unintended behavior. All 69 call sites are read-only consumers of the resolved value — they use it for DB queries, card operations, and dispatches. None should need the auto-switch side effect.

The only potential risk is if a call site implicitly relied on the auto-switch to keep `_currentWorkspaceRoot` in sync with the workspace it was operating on. However:
- This would be a bug in that call site (it should use `setCurrentWorkspaceRoot()` for explicit switches)
- The diagnostic logging will surface any such cases
- Removing the auto-switch exposes the bug rather than causing new issues

The `selectWorkspace` handler (the only legitimate workspace-switching call site) already uses `setCurrentWorkspaceRoot()` directly, so it is unaffected.

## Related Issues

This is similar to previous workspace switching bugs:
- `fix-workspace-switching-issue.md`
- `fix-workspace-desync.md`
- `fix_terminal-state-desync-after-workspace-switch.md`

All of these suggest the workspace switching logic has been fragile and needs careful handling.

## Recommendation

Complexity 4 → **Send to Coder**
