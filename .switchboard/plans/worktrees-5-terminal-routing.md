# Worktrees Part 5: Terminal Target Routing

## Goal

Fix the gap left by Part 4: the actual VS Code terminal that receives dispatched messages is still selected by `_getAgentNameForRole`, which does a plain state.json role lookup with no worktree awareness. Worktree terminals are created and the prompt content correctly references the worktree path, but the message is sent to the default role terminal. This plan fixes the send target.

## Dependencies

**Requires Part 4 complete.** Part 4 established `worktreePath` and `epicId` on `BatchPromptPlan`, and resolves `worktreePath` from the DB before building the dispatch plan. This plan consumes that data at send time.

- `sess_worktrees_part4 — Worktree path resolution on BatchPromptPlan`

## Problem Analysis

### The Gap

`_getAgentNameForRole` (TaskViewerProvider.ts:5353) is the function that determines which terminal name is passed to `_dispatchExecuteMessage` and ultimately to `_attemptDirectTerminalPush` → `terminal.sendText()`. It reads only from state.json role assignments and has no knowledge of worktrees.

The full send chain:
```
_handleTriggerAgentActionInternal (line ~14730)
  → _getAgentNameForRole(role, workspaceRoot)   ← terminal selected here, no worktree logic
  → _dispatchExecuteMessage(workspaceRoot, targetAgent, payload, metadata)
  → _attemptDirectTerminalPush(terminalName, ...)
  → terminal.sendText(...)
```

`worktreePath` is available on the `dispatchPlan` (`BatchPromptPlan`) at the dispatch site (line ~14768), but it is only passed to `generateUnifiedPrompt()` for prompt content — never used to override the terminal selection.

The same gap exists in `handleKanbanBatchTrigger` which also calls `_getAgentNameForRole` directly.

### Fix Strategy

Add a helper `_resolveAgentTerminalForPlan(role, workspaceRoot, worktreePath?)` that:
1. If `worktreePath` is set: call `findTerminalNameByWorktreePath(worktreePath)` — if a matching terminal exists, return it
2. Fall through to `_getAgentNameForRole(role, workspaceRoot)` if no worktree terminal found

Replace every call to `_getAgentNameForRole` in dispatch paths with `_resolveAgentTerminalForPlan`. Non-dispatch call sites (sidebar, readiness UI) keep using `_getAgentNameForRole` directly — do not change those.

## Metadata

**Tags:** backend, bugfix
**Complexity:** 5

## User Review Required

None.

## Complexity Audit

### Routine
- Add `_resolveAgentTerminalForPlan` helper (5-10 lines)
- Replace `_getAgentNameForRole` calls in `_handleTriggerAgentActionInternal`
- Replace in `handleKanbanBatchTrigger` if it also calls `_getAgentNameForRole` on the send path

### Complex / Risky
- **State-lookup source**: `_registeredTerminals` stores live `vscode.Terminal` objects, not state records. The helper must query `state.terminals` (via `updateState`) for `worktreePath` and `role`, matching the pattern used by `findTerminalNameByWorktreePath`.
- **Batch dispatch ordering**: In `handleKanbanBatchTrigger`, `targetAgent` is resolved before `validPlans`. To use worktree routing, terminal selection must move after plan resolution so a common `worktreePath` can be extracted.
- **Dispatch critical path**: `_getAgentNameForRole` is on the hot path for every dispatch. The new helper must fall back cleanly — a throw or undefined from the state lookup must never block a dispatch that would otherwise succeed.
- **Identify all dispatch call sites**: Grep for every call to `_getAgentNameForRole` and classify: dispatch path (must update) vs UI/readiness path (leave alone).

## Edge-Case & Dependency Audit

### Race Conditions
None identified. The helper performs a read-only state lookup; no concurrent mutation of terminal assignments is expected during dispatch.

### Security
- F-04 agent name validation (`_isValidAgentName`) runs after terminal resolution, so a malformed name returned by the new helper is still caught.
- `findTerminalNameByWorktreePath` resolves paths with `path.resolve`; passing attacker-controlled `worktreePath` could probe filesystem layout. Ensure `worktreePath` originates only from DB-backed `linkedWorktree.path` (already validated during Part 4 resolution).

### Side Effects
- `_getAgentNameForRole` may show an error message when no agent is assigned. The new helper preserves that behaviour because it falls through to the existing function.
- `findTerminalNameByWorktreePath` is async and uses `updateState`, which queues a state read. It does not mutate state.

### Dependencies & Conflicts
- **Requires Part 4 complete.** `worktreePath` must be populated on `BatchPromptPlan` before this plan can resolve terminals.
- `findTerminalNameByWorktreePath` (line 6362) searches `state.terminals`, not `_registeredTerminals`. The proposed helper must also query `state.terminals` for role-aware matching, not the in-memory terminal object map.

### No Worktree Terminal Open
`findTerminalNameByWorktreePath` returns null → fall through to `_getAgentNameForRole`. Dispatch proceeds normally. No error, no notification.

### Multiple Roles, One Worktree
A worktree may have multiple terminals (one per role) all sharing the same `worktreePath`. `findTerminalNameByWorktreePath` returns the first match, which may be any role. The helper must match on BOTH `worktreePath` AND `role` — find a terminal whose stored `worktreePath` matches AND whose role matches the requested role. If only one role terminal exists in the worktree, use it regardless of role (best effort).

### Plan Has No worktreePath
`worktreePath` is undefined (or the local variable was never set because the plan has no epic) → `_resolveAgentTerminalForPlan` skips the worktree check, calls `_getAgentNameForRole` directly. Existing behaviour preserved.

### `findTerminalNameByWorktreePath` Signature
Confirm the existing function signature at TaskViewerProvider.ts:6362. It matches on `worktreePath` only (not role) by searching `state.terminals`. A role-aware variant `_findTerminalNameByWorktreePathAndRole(worktreePath, role)` must be added that queries `state.terminals` via `updateState`, checks both `worktreePath` and `role`, and falls back to a path-only match if no role match is found.

## Proposed Changes

### Phase 11: `_resolveAgentTerminalForPlan` Helper and Dispatch Wiring

**Files: `src/services/TaskViewerProvider.ts`**

**Step 1 — audit all `_getAgentNameForRole` call sites**:

```bash
grep -n "_getAgentNameForRole" src/services/TaskViewerProvider.ts
```

Classify each result as:
- **Dispatch path** (feeds terminal name into `_dispatchExecuteMessage` or `_attemptDirectTerminalPush`): must be updated
- **UI/readiness path** (feeds sidebar display, implementation panel): leave unchanged

**Step 2 — add `_resolveAgentTerminalForPlan` helper** (after `_getAgentNameForRole` at line 5378):

```typescript
private async _resolveAgentTerminalForPlan(
    role: string,
    workspaceRoot: string,
    worktreePath?: string
): Promise<string | undefined> {
    if (worktreePath) {
        const wtTerminal = await this._findTerminalNameByWorktreePathAndRole(worktreePath, role);
        if (wtTerminal) { return wtTerminal; }
    }
    return this._getAgentNameForRole(role, workspaceRoot);
}

private async _findTerminalNameByWorktreePathAndRole(
    worktreePath: string,
    role: string
): Promise<string | undefined> {
    const resolvedTarget = path.resolve(worktreePath);
    return new Promise<string | undefined>((resolve) => {
        this.updateState((state) => {
            if (state.terminals) {
                for (const [name, info] of Object.entries(state.terminals) as [string, any][]) {
                    if (info.worktreePath && path.resolve(info.worktreePath) === resolvedTarget && info.role === role) {
                        resolve(name);
                        return;
                    }
                }
                for (const [name, info] of Object.entries(state.terminals) as [string, any][]) {
                    if (info.worktreePath && path.resolve(info.worktreePath) === resolvedTarget) {
                        resolve(name);
                        return;
                    }
                }
            }
            resolve(undefined);
        }).then(() => { /* updateState resolves after persistence */ });
    });
}
```

**Step 3 — replace dispatch-path `_getAgentNameForRole` calls**:

In `_handleTriggerAgentActionInternal` (line 14730), replace:
```typescript
    targetAgent = await this._getAgentNameForRole(role, resolvedWorkspaceRoot);
```
with:
```typescript
    targetAgent = await this._resolveAgentTerminalForPlan(role, resolvedWorkspaceRoot, worktreePath);
```

Use the local `worktreePath` variable resolved at lines 14643-14660, not `dispatchPlan?.worktreePath` (the plan object is not yet constructed at line 14730).

In `handleKanbanBatchTrigger` (line 3056), move terminal selection after `_resolveKanbanDispatchPlans` so a common worktree can be computed. Replace the existing block:
```typescript
        const targetAgent = String(targetTerminalOverride || '').trim() || await this._getAgentNameForRole(role, resolvedWorkspaceRoot);
        if (!targetAgent) {
            vscode.window.showErrorMessage(`No agent assigned to role '${role}'. Cannot dispatch batch.`);
            return false;
        }
        if (!this._isValidAgentName(targetAgent)) {
            console.error(`[TaskViewerProvider] Rejected invalid agent name for batch dispatch: ${targetAgent}`);
            return false;
        }

        const validPlans = await this._resolveKanbanDispatchPlans(sessionIds, resolvedWorkspaceRoot);
```
with:
```typescript
        const validPlans = await this._resolveKanbanDispatchPlans(sessionIds, resolvedWorkspaceRoot);
        if (validPlans.length === 0) {
            console.warn('[TaskViewerProvider] Batch trigger: no valid plans resolved.');
            return false;
        }

        const commonWorktree = validPlans[0].worktreePath;
        const allSameWorktree = validPlans.every(p => p.worktreePath === commonWorktree);
        const worktreeForBatch = allSameWorktree ? commonWorktree : undefined;
        const targetAgent = String(targetTerminalOverride || '').trim()
            || await this._resolveAgentTerminalForPlan(role, resolvedWorkspaceRoot, worktreeForBatch);
        if (!targetAgent) {
            vscode.window.showErrorMessage(`No agent assigned to role '${role}'. Cannot dispatch batch.`);
            return false;
        }
        if (!this._isValidAgentName(targetAgent)) {
            console.error(`[TaskViewerProvider] Rejected invalid agent name for batch dispatch: ${targetAgent}`);
            return false;
        }
```

This preserves the error flow while enabling worktree-aware batch routing when all plans share the same worktree.

**Step 4 — verify `state.terminals` entry shape**:

Confirm that `state.terminals` records include `worktreePath` and `role` fields. `findTerminalNameByWorktreePath` (line 6362) already reads `info.worktreePath` from `state.terminals`, so the field exists. The role field is standard for all terminal records. No changes needed if both fields are present.

## Files Changed

- `src/services/TaskViewerProvider.ts` — Add `_resolveAgentTerminalForPlan` and `_findTerminalNameByWorktreePathAndRole` helpers; replace `_getAgentNameForRole` at dispatch call sites

## Verification Plan

1. **Worktree terminal present**: Plan linked to epic with active worktree; matching terminal open → dispatched message arrives in the worktree terminal, not the default role terminal. Confirm by checking which terminal receives the `/clear` + prompt.
2. **Worktree terminal absent**: Same plan, worktree terminal closed → dispatch falls back to default terminal, no error.
3. **Non-worktree plan**: Plan with no `epicId`/`worktreePath` → `_getAgentNameForRole` called as before, behaviour unchanged.
4. **Multiple role terminals in worktree**: Two terminals open in same worktree (e.g. Coder + Reviewer) → each role's dispatch goes to the matching role terminal in the worktree.
5. **Regression**: Dispatch a plan with no worktrees configured at all → no change in behaviour.

### Automated Tests

- Unit test `_findTerminalNameByWorktreePathAndRole` with mocked `updateState`:
  - Returns terminal name when `worktreePath` and `role` both match.
  - Returns fallback terminal name when only `worktreePath` matches.
  - Returns `undefined` when no terminal matches the worktree.
- Unit test `_resolveAgentTerminalForPlan`:
  - Calls `_getAgentNameForRole` when `worktreePath` is undefined.
  - Calls `_findTerminalNameByWorktreePathAndRole` and returns its result when `worktreePath` is set.
  - Falls back to `_getAgentNameForRole` when the worktree lookup returns `undefined`.
- Integration-style test for `handleKanbanBatchTrigger`:
  - Batch with plans sharing the same worktree routes to the common worktree terminal.
  - Batch with plans spanning multiple worktrees falls back to the default role terminal.

## Adversarial Synthesis

Key risks: (1) The `_registeredTerminals` map stores live `vscode.Terminal` objects, not state records, so iterating it for `worktreePath` will fail — the helper must query `state.terminals` instead. (2) In `_handleTriggerAgentActionInternal`, `targetAgent` is resolved at line 14730 before `dispatchPlan` is built at line 14768; the helper must accept the standalone `worktreePath` variable available earlier. (3) `handleKanbanBatchTrigger` selects a single terminal for a multi-plan batch — if plans span multiple worktrees, the helper must either pick the common worktree or fall back to the default role terminal. Mitigations: use `state.terminals` for lookup, pass `worktreePath` directly, and defer batch worktree selection until after `_resolveKanbanDispatchPlans`.

## Risks

- **State-lookup source**: `findTerminalNameByWorktreePath` reads `state.terminals`, not `_registeredTerminals`. Any role-aware helper must follow the same pattern. Do not assume `_registeredTerminals` entries carry metadata.
- **`worktreePath` scope in `_handleTriggerAgentActionInternal`**: `worktreePath` is a local variable resolved at lines 14643-14660, but `dispatchPlan` is not built until line 14768. Pass the local variable directly, not `dispatchPlan?.worktreePath`.
- **Batch dispatch ordering**: `handleKanbanBatchTrigger` resolves `targetAgent` before `validPlans`. Moving terminal selection after plan resolution changes the error-flow timing; ensure the no-agent error is still surfaced cleanly.

## Recommendation

**Complexity: 5 → Send to Coder**

The helper is small, but the fix requires async state lookup (matching `findTerminalNameByWorktreePath`), careful ordering in the batch dispatch path, and precise scoping of `worktreePath` in `_handleTriggerAgentActionInternal`. All risks are contained to a single file and well-defined.
