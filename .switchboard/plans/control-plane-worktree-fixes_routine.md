# Control-Plane-Only Worktree Feature & Bug Fixes — Routine

> **Split Plan**: This file contains **Routine** items only.
> Complex / Risky items are in [`control-plane-worktree-fixes.md`](./control-plane-worktree-fixes.md).
> Assume Complex / Risky items are implemented by the Lead Coder agent before or alongside these items.

## Goal

Reform worktree feature to be control-plane-only with manual merge controls, eliminating CLI/terminal dependencies and fixing critical merge bugs.

## Metadata

- **Tags:** workflow, devops, reliability, bugfix
- **Complexity:** 4

## User Review Required

- Confirm control plane availability check mechanism (see parent plan — `getControlPlaneSelectionStatus()` / `kanban.controlPlaneRoot` workspaceState is the queryable signal)
- Confirm autoban forward-move behavior for worktree plans (see parent plan — behavior may already be partially correct; verify before coding)

## Complexity Audit

### Routine

- Remove terminal spawning logic from `_assignWorktreeToCard`
- Remove `worktree_auto_merge` from Worktrees tab UI (checkbox, DB storage, toggle logic)
- Add `worktreePath` to `BatchPromptPlan` interface
- Populate `worktreePath` in `_cardsToPromptPlans`
- Remove `_appendWorktreeContextToPlan` calls and method
- Add worktree path to reviewer prompt context
- Change squash commit from `--no-edit` to `-m` with message (verify first — may already be fixed)
- Add idempotency check with `git branch --merged` (verify first — DB nullification may already cover this)

### Complex / Risky

- None — all complex/risky items are in the companion plan file

## Edge-Case & Dependency Audit

### Race Conditions
- `_assignWorktreeToCard` already guards `plan.worktreeId` at line 6668 — idempotent worktree creation is preserved when terminal-spawning block is removed.
- Removal of `_appendWorktreeContextToPlan` is safe: idempotency check (line 6873) means existing plans with `## Worktree Context` already appended won't be double-written; removal of the call means no new sections are appended (existing sections remain harmless).

### Security
- All `git` invocations use `execFile` with args array — no shell injection risk from these changes.

### Side Effects
- Removing the auto-merge checkbox from Worktrees tab means existing `worktree_auto_merge` DB key is orphaned but not harmful — it is simply no longer read.
- `_cleanupWorktreeAfterMerge` calls `killTerminal` — once terminal spawning is removed, no terminal is associated with worktree plans; `killTerminal` will find no terminal to kill (safe no-op, guarded by null check at line 6836).

### Dependencies & Conflicts
- `BatchPromptPlan` interface (`agentPromptBuilder.ts` line 12) is imported by both `TaskViewerProvider.ts` and `KanbanProvider.ts` — adding `worktreePath?: string` is backward-compatible (optional field, no callers need to change).
- `_cardsToPromptPlans` must call `_resolveWorktreePaths()` and pass the resolved path — confirm the method is available in scope.

## Dependencies

- None

## Adversarial Synthesis

Key risks are low for these routine items: removing the terminal-spawning block is a pure deletion (low regression risk), and `BatchPromptPlan` extension is backward-compatible. The main caveat is that Bug 1 (squash commit) and Bug 3 (idempotency) should be verified before implementing — both may already be resolved in the current codebase. Mitigations: verify line 6795 and post-merge DB state before writing any code for those two items.

## Phase 1: Remove Terminal Spawning from `_assignWorktreeToCard`

**File**: `src/services/KanbanProvider.ts`

**Change**: Delete the terminal-spawning block from `_assignWorktreeToCard` (lines 6686–6699 approximately):

```typescript
// REMOVE THIS BLOCK:
const branchToPath = await this._resolveWorktreePaths(workspaceRoot);
const worktreePath = branchToPath.get(worktreeResult.branch);
if (worktreePath) {
    try {
        const role = this._columnToRole(targetColumn || '') || 'coder';
        await this._taskViewerProvider?.addAutobanTerminalFromKanban(
            role,
            undefined,
            worktreePath
        );
    } catch (termErr: any) {
        console.warn(`[KanbanProvider] Terminal creation failed for worktree ${worktreeResult.branch}: ${termErr.message}`);
        vscode.window.showWarningMessage(`Worktree created but terminal failed: ${termErr.message}`);
    }
}
```

**After removal**, `_assignWorktreeToCard` simply creates the worktree and assigns it to the plan — no terminal side effect.

**Note**: `_findTerminalForWorktree` and `_cleanupWorktreeAfterMerge`'s `killTerminal` call remain unchanged (they handle the case where a terminal may exist from a prior session or manual creation).

## Phase 2: Remove `_appendWorktreeContextToPlan`

**File**: `src/services/KanbanProvider.ts`

**Step 1 — Remove calls from `moveCardToColumn`** (find by pattern, not line number):
```typescript
// REMOVE this call (in moveCardToColumn, CODE REVIEWED block):
if (targetColumn === 'CODE REVIEWED') {
    await this._appendWorktreeContextToPlan(workspaceRoot, sessionId);
}
```

**Step 2 — Remove calls from `moveCardToColumnByPlanFile`** (same pattern in the sessionId block):
```typescript
// REMOVE:
if (targetColumn === 'CODE REVIEWED') {
    await this._appendWorktreeContextToPlan(workspaceRoot, sessionId);
}
```

**Step 3 — Delete the method entirely** (lines 6858–6894 approximately — the full `_appendWorktreeContextToPlan` private async method).

## Phase 2b: Add `worktreePath` to Reviewer Prompt Context

**File**: `src/services/agentPromptBuilder.ts`

**Step 1 — Extend `BatchPromptPlan` interface** (line 18, after `sessionId?: string`):
```typescript
export interface BatchPromptPlan {
    topic: string;
    absolutePath: string;
    complexity?: string;
    dependencies?: string;
    workingDir?: string;
    sessionId?: string;
    worktreePath?: string;  // ADD THIS
}
```

**File**: `src/services/KanbanProvider.ts` (or wherever `_cardsToPromptPlans` lives — search for the method)

**Step 2 — Populate `worktreePath` in `_cardsToPromptPlans`** (or equivalent plan-to-prompt mapping):
```typescript
// When building a BatchPromptPlan for a card with worktreeId:
const branchToPath = await this._resolveWorktreePaths(workspaceRoot);
const worktree = plan.worktreeId ? await db.getWorktreeById(plan.worktreeId) : null;
const worktreePath = worktree ? branchToPath.get(worktree.branch) : undefined;

return {
    topic: plan.topic,
    absolutePath: resolvedPlanPath,
    // ... other fields ...
    worktreePath,
};
```

**File**: `src/services/agentPromptBuilder.ts` — `buildKanbanBatchPrompt`

**Step 3 — Inject worktree path in reviewer prompt** (in the `reviewer` role branch):
```typescript
// In the reviewer section of buildKanbanBatchPrompt:
if (plan.worktreePath) {
    planContext += `\nWorktree path: ${plan.worktreePath}\n` +
        `IMPORTANT: This work was done in a git worktree at ${plan.worktreePath}. ` +
        `Read the plan file from that location (not the main directory). ` +
        `Make your review changes to the worktree plan file. ` +
        `The merge will bring both code and plan changes to the main branch.\n`;
}
```

## Phase 3: Remove Auto-Merge Toggle from Worktrees Tab UI

**File**: `src/webview/kanban.html`

**Step 1 — Remove `lastWorktreeAutoMerge` state variable** (line 5170):
```javascript
// REMOVE:
lastWorktreeAutoMerge = msg.worktreeAutoMerge || false;
```

**Step 2 — Remove `autoMergeWrapper` DOM construction block** (lines 7165–7185 approximately):
```javascript
// REMOVE the entire block:
const autoMergeWrapper = document.createElement('div');
// ... through ...
configRow.appendChild(autoMergeWrapper);
```

**Step 3 — Remove `autoMerge: autoMergeInput.checked` from `setWorktreeRules` postMessage** (line 7192):
```javascript
// CHANGE FROM:
vscode.postMessage({ type: 'setWorktreeRules', maxCap: ..., defaultMergeStrategy: ..., autoMerge: autoMergeInput.checked });
// TO:
vscode.postMessage({ type: 'setWorktreeRules', maxCap: ..., defaultMergeStrategy: ... });
```

**File**: `src/services/KanbanProvider.ts`

**Step 4 — Remove `worktree_auto_merge` DB write from `setWorktreeRules` handler** (line 6363):
```typescript
// REMOVE:
await db.setMeta('worktree_auto_merge', msg.autoMerge ? 'true' : 'false');
```

**Step 5 — Remove `worktreeAutoMerge` from all `worktrees` response payloads** (lines 6263, 6324, 6351, 6376):
```typescript
// REMOVE worktreeAutoMerge field from each postMessage:
this._panel?.webview.postMessage({
    type: 'worktrees',
    worktrees: enriched,
    worktreeModeEnabled,
    worktreeMaxCap: maxCap,
    worktreeDefaultMergeStrategy: defaultMergeStrategy,
    // REMOVE: worktreeAutoMerge: autoMerge
});
```

**Step 6 — Remove `autoMerge` DB reads** (lines 6253, 6316, 6343 — `const autoMerge = (await db.getMeta('worktree_auto_merge')) === 'true';`):
```typescript
// REMOVE these lines from getWorktrees, deleteWorktree, and setWorktreeMode handlers
```

## Phase 5a: Verify and Fix Bug 1 — Squash Commit Message

**File**: `src/services/KanbanProvider.ts`, `_executeMergeRule` (line 6793–6802)

**Pre-check**: Read line 6795. If it already reads:
```typescript
await execFileAsync('git', ['commit', '-m', `Merge ${worktree.branch} (squash)`], { cwd: workspaceRoot });
```
→ **Bug 1 is already fixed. No code change needed.**

If it reads `['commit', '--no-edit']` or similar → change to:
```typescript
await execFileAsync('git', ['commit', '-m', `Merge ${worktree.branch} (squash)`], { cwd: workspaceRoot });
```

## Phase 5c: Verify and Fix Bug 3 — Idempotency Guard

**File**: `src/services/KanbanProvider.ts`, `_executeMergeRule` (line 6769–6820)

**Pre-check**: Confirm that after `_cleanupWorktreeAfterMerge` (line 6806), `db.updatePlanWorktree(plan.sessionId, null)` is called (line 6854). If so, a subsequent call to `_executeMergeRule` will fail at line 6774 (`if (!plan || !plan.worktreeId)`) before reaching git.

→ If confirmed: **Bug 3 is already implicitly handled. No code change needed.**

If explicit protection is still desired (e.g., button can be pressed while cleanup is in flight), add before the `git merge` call:

```typescript
const { stdout: mergedBranches } = await execFileAsync(
    'git', ['branch', '--merged', 'HEAD'], { cwd: workspaceRoot }
);
const alreadyMerged = mergedBranches.split('\n').map(b => b.trim().replace(/^\*\s*/, ''));
if (alreadyMerged.includes(worktree.branch)) {
    // Already merged — just cleanup if needed
    await this._cleanupWorktreeAfterMerge(workspaceRoot, plan, worktree);
    return;
}
```

## Phase 6: Documentation Updates

**File**: `src/webview/kanban.html` — Worktrees tab tooltip (line 7073–7074)

Update description to:
- Remove reference to auto-merge toggle behavior
- Add note that worktree mode requires control plane configuration
- Add note that manual merge controls appear in the MERGE column header

**File**: `src/webview/kanban.html` — MERGE column tooltip (search for "Merge column role:")
```
// UPDATE FROM:
'With auto-merge on, merge executes automatically. With auto-merge off, you can trigger merge manually...'
// TO:
'Use the Merge All / Merge Selected buttons in the MERGE column header to execute merges manually. Plans with worktrees stop here for review before merging.'
```

**Files**: Any `.switchboard/plans/*.md` files that reference worktree auto-merge behavior — update to reflect manual merge model.

## Success Criteria

- No per-worktree terminals created when plan moves to coder columns
- No auto-merge toggle in Worktrees tab UI
- `BatchPromptPlan` includes `worktreePath` field populated for worktree plans
- Reviewer prompt includes worktree path and explicit instruction to read worktree plan file
- `_appendWorktreeContextToPlan` deleted from codebase with no remaining call sites
- Squash commit uses explicit `-m` message (verified or fixed)
- Idempotency guard present (verified or added)

## Verification Plan

### Automated Tests

> Per session directive: automated tests will be run separately by the user. No test execution during implementation.

### Manual Smoke Tests (implementer)

1. **No terminal spawned**: Move plan to LEAD CODED with worktree mode on → confirm no new terminal appears
2. **Worktrees tab**: Open Worktrees tab → confirm no AUTO-MERGE checkbox appears
3. **Reviewer prompt**: Dispatch reviewer for a worktree plan → confirm prompt includes worktree path text
4. **No `_appendWorktreeContextToPlan` calls**: Search codebase for `_appendWorktreeContextToPlan` → confirm zero results
5. **Bug 1**: Check line 6795 for `-m` flag (or trigger a squash merge and confirm commit succeeds)
6. **Bug 3**: Complete a merge, wait for cleanup, re-click Merge → confirm no error or double-commit

## Recommendation

**Complexity: 4 → Send to Coder**

These are targeted deletions, interface extensions, and UI removals. The largest risk is accidentally removing too much of `setWorktreeRules` — verify each field independently before deleting. All changes are backward-compatible (optional interface field, orphaned DB key).
