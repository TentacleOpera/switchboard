# Control-Plane-Only Worktree Feature & Bug Fixes

## Goal

Reform worktree feature to be control-plane-only with manual merge controls, eliminating CLI/terminal dependencies and fixing critical merge bugs.

## Metadata

- **Tags:** workflow, devops, reliability, bugfix
- **Complexity:** 7

## User Review Required

- Confirm control plane availability check mechanism (see Phase 1 note — existing `getControlPlaneSelectionStatus()` / `kanban.controlPlaneRoot` workspaceState is the queryable signal)
- Confirm autoban forward-move behavior for worktree plans (see Phase 4 note — behavior may already be partially correct; verify before coding)
- Confirm whether plan-file-conflict-in-progress state (mid-merge, unresolved) is an acceptable UX for Bug 2 fix

## Complexity Audit

### Routine

> Routine items are implemented by the Coder agent. See `control-plane-worktree-fixes_routine.md` for full detail.

- Remove terminal spawning logic from `_assignWorktreeToCard`
- Remove `worktree_auto_merge` from Worktrees tab UI (checkbox, DB storage, toggle logic)
- Add `worktreePath` to `BatchPromptPlan` interface
- Populate `worktreePath` in `_cardsToPromptPlans`
- Remove `_appendWorktreeContextToPlan` calls and method
- Add worktree path to reviewer prompt context
- Change squash commit from `--no-edit` to `-m` with message (**verify first** — line 6795 may already use `-m`)
- Add idempotency check with `git branch --merged` (**verify first** — DB nullification of `worktreeId` post-merge may already prevent re-entry)

### Complex / Risky

- **Manual merge controls in MERGE column header** — requires new column header UI architecture in `kanban.html`: multi-button header (Merge All, Merge Selected, Send to Agent, Copy Prompt) with count badges; requires new message types and backend handlers
- **Auto-merge removal from `moveCardToColumn`** — currently `moveCardToColumn` always calls `_executeMergeRule` when entering MERGE (no on/off gate exists in `moveCardToColumn`); removing this requires coordinating the MERGE column to be purely a holding column, not a trigger; must update both `moveCardToColumn` and `moveCardToColumnByPlanFile`
- **Autoban forward-move logic modification** — `_getNextColumnId` (line 2855) already returns `null` for `CODE REVIEWED → COMPLETED` path; must verify whether this stops autoban correctly for worktree plans before making changes; risk of regression if the existing guard is misread
- **Merge conflict handling (Bug 2)** — file-type-aware conflict detection: call `git diff --name-only --diff-filter=U` after merge failure to identify conflicted files; only abort if non-plan files are conflicted; leave main in mid-merge state for plan-file-only conflicts so user can resolve manually — this is an intentional but risky UX decision
- **Control plane availability guard** — `getControlPlaneSelectionStatus()` returns `mode: 'explicit' | 'auto'`; `_isWorktreeModeEnabled` must additionally verify control plane is configured (`mode === 'explicit'` OR effective root has a `.switchboard/kanban.db`) before allowing worktree mode; error message must surface in Worktrees tab UI when control plane is missing

## Edge-Case & Dependency Audit

### Race Conditions
- **Merge in progress + duplicate button press**: After merge starts, the card enters MERGE column and `plan.worktreeId` is non-null until `_cleanupWorktreeAfterMerge` completes. A second button press before cleanup could fire a second `_executeMergeRule`. The idempotency guard (`git branch --merged`) prevents double-commit but the UI must also disable the Merge button while an in-flight merge is running.
- **Card moved back from MERGE**: If a user drags a card back from MERGE to CODE REVIEWED mid-merge, the worktree is still in use. Must not re-trigger `_assignWorktreeToCard` (already guarded by `plan.worktreeId` check at line 6668), but the merge cleanup state may be inconsistent.

### Security
- All `git` invocations already use `execFile` with args array (confirmed at lines 6752, 6795, 6814, 6843, 6845) — no shell injection risk introduced by this plan.

### Side Effects
- Removing `_appendWorktreeContextToPlan` leaves existing plan files that already contain `## Worktree Context` sections intact (no cleanup needed; the section is harmless).
- Removing auto-merge from `moveCardToColumn` means existing workflows that drag cards to MERGE expecting an automatic merge will silently stop auto-merging. Must communicate this in release notes / Worktrees tab UI.
- `_cleanupWorktreeAfterMerge` calls `killTerminal` — after Phase 1 removes terminal spawning, worktree plans will no longer have an associated terminal, so `killTerminal` will find no terminal to kill (safe no-op, already guarded by `terminalName` null check at line 6836).

### Dependencies & Conflicts
- `kanban.html` Worktrees tab has `lastWorktreeAutoMerge` state variable (line 5170) and `autoMergeInput` checkbox (lines 7172–7185) — both must be removed in Phase 3 along with the backend `setWorktreeRules` handler sending `worktreeAutoMerge`.
- `BatchPromptPlan` interface (`agentPromptBuilder.ts` line 12) is imported by `TaskViewerProvider.ts` and `KanbanProvider.ts` — adding `worktreePath?: string` is backward-compatible (optional field).
- The `setWorktreeRules` message handler (line 6363) saves `worktree_auto_merge` to DB — this DB key becomes orphaned after removal; existing DBs will still have the key but it will no longer be read (safe).

## Dependencies

- None

## Adversarial Synthesis

Key risks: (1) Auto-merge removal is deeper than described — `moveCardToColumn` has no on/off gate and always fires `_executeMergeRule` on MERGE entry; removing this requires architectural change, not just a flag deletion. (2) Autoban forward-move may already be partially correct (`_getNextColumnId` line 2855 returns null for CODE REVIEWED → COMPLETED path when worktree is present) — implementer must verify before adding duplicate guards. (3) File-type-aware conflict handling intentionally leaves main branch in mid-merge state for plan-file conflicts, which is a deliberate but risky UX decision requiring explicit user-facing messaging. Mitigations: Verify Bug 1 and Bug 3 fixes first (may be no-ops), audit `_getNextColumnId` behavior before Phase 4, add in-flight merge UI lock for Phase 3 buttons.

## Phase 1: Control-Plane Architecture

**Problem**: Current implementation depends on CLI triggers and per-worktree terminals, causing:
- Silent failures when CLI triggers disabled
- Race conditions between worktree creation and CLI readiness
- Terminal lifecycle complexity

**Solution**: Make worktrees control-plane-only
- Remove per-worktree terminal spawning from `addAutobanTerminalFromKanban`
- Worktree creation still happens on card move to coder columns
- Control plane agents receive worktree path in prompt context
- Agents can `cd` to worktree as needed (single terminal, filesystem access)
- Remove CLI trigger dependency entirely

**Changes**:
- `KanbanProvider._assignWorktreeToCard` (lines 6688–6699): Remove terminal spawning block entirely — the `try { await this._taskViewerProvider?.addAutobanTerminalFromKanban(...) }` block and its catch handler
- `TaskViewerProvider.addAutobanTerminalFromKanban`: No longer called for worktrees
- Worktrees tab UI: Update description to specify control-plane requirement
- `_isWorktreeModeEnabled`: Add guard — check `getControlPlaneSelectionStatus()` returns `mode === 'explicit'` or `.switchboard/kanban.db` exists at effective root before enabling worktree mode; show error in Worktrees tab when control plane not configured

**Control plane detection** (Clarification):
- `getControlPlaneSelectionStatus()` at `KanbanProvider.ts` line 3632 already provides `controlPlaneRoot` and `mode`
- Guard: `if (mode === 'auto' && !fs.existsSync(path.join(effectiveRoot, '.switchboard', 'kanban.db'))) { return false; }` — or simpler, require `mode === 'explicit'` (explicit control plane root is set)
- Surface as warning in Worktrees tab: `vscode.window.showWarningMessage('Worktree mode requires an explicit control plane. Configure one in the workspace selector.')`

## Phase 2: Reviewer Context Fix

**Problem**: `_appendWorktreeContextToPlan` modifies plan file in worktree, causing divergence from main directory plan file. Reviewer receives main directory plan path but code is in worktree.

**Solution**: Inject worktree path into reviewer prompt with explicit instruction to read worktree plan file

**Changes**:
- Add `worktreePath?: string` to `BatchPromptPlan` interface in `agentPromptBuilder.ts` (after line 18)
- `KanbanProvider._cardsToPromptPlans`: Populate `worktreePath` from DB when card has worktree — resolve via `_resolveWorktreePaths()` using `worktree.branch` as key
- Remove `_appendWorktreeContextToPlan` calls from `moveCardToColumn` (line 3833) and `moveCardToColumnByPlanFile` (line 3895)
- Delete `_appendWorktreeContextToPlan` method entirely (lines 6858–6894)
- `agentPromptBuilder.buildKanbanBatchPrompt`: Include worktree path in reviewer context with instruction:
  > "This work was done in a git worktree at {worktreePath}. Read the plan file from that location (not the main directory). Make your review changes to the worktree plan file. The merge will bring both code and plan changes to the main branch."

## Phase 3: Manual Merge Controls

**Problem**: Auto-merge toggle is unreliable and confusing. `moveCardToColumn` currently always fires `_executeMergeRule` when a card enters MERGE — there is no on/off gate in the code path; the `worktree_auto_merge` DB key exists but is NOT checked in `moveCardToColumn`. Merge should be purely manual with explicit controls.

**Solution**: Remove auto-merge entirely, add manual merge controls in MERGE column header

**Changes**:
- `kanban.html`: Remove `lastWorktreeAutoMerge` state variable (line 5170), `autoMergeWrapper`/`autoMergeDiv`/`autoMergeInput`/`autoMergeDesc` DOM construction (lines 7165–7185), and `autoMerge: autoMergeInput.checked` from `setWorktreeRules` postMessage (line 7192)
- `KanbanProvider` `setWorktreeRules` handler (line 6363): Remove `worktree_auto_merge` DB write; remove `worktreeAutoMerge` from all `worktrees` response payloads (lines 6263, 6324, 6351, 6376)
- `moveCardToColumn` (lines 3809–3825): Remove `_executeMergeRule` call entirely from MERGE entry — card is moved to MERGE column visually but no merge is triggered; remove the `.then(() => kanbanForwardMove COMPLETED)` chain
  - Same for `moveCardToColumnByPlanFile` (lines 3870–3886)
- `kanban.html` MERGE column header: Add action buttons:
  - **Merge All** (`mergeAll` message): Merge all cards currently in MERGE column — posts `{ type: 'mergeAll', workspaceRoot }` — backend iterates `getPlansByColumn('MERGE')` and calls `_executeMergeRule` for each
  - **Merge Selected** (`mergeSelected` message): Posts `{ type: 'mergeSelected', sessionIds, workspaceRoot }` — backend calls `_executeMergeRule` for each selected card
  - **Send to Agent** (`sendToAgentFromMerge` message): Dispatches reviewer with worktree context and merge instruction for selected cards
  - **Copy Prompt** (`copyMergePrompt` message): Copies merge instruction text with worktree paths to clipboard
  - Each button renders a count badge (e.g., "Merge All (3)") using `_lastCards.filter(c => c.column === 'MERGE').length`
  - Buttons must disable/show spinner while merge is in flight (track in-flight state with a `Set<string>` of sessionIds being merged)
- `KanbanProvider` message handlers: Add cases for `mergeAll`, `mergeSelected`, `sendToAgentFromMerge`, `copyMergePrompt`

## Phase 4: Autoban Automation Integration

**Problem**: Autoban automation auto-advances plans through columns. Worktree plans should stop at CODE REVIEWED for manual merge, not auto-advance to MERGE.

**⚠️ Pre-implementation verification required**: `_getNextColumnId` (line 2826) already has `shouldSkip` at line 2834 (`if (col.id === 'MERGE' && !planWorktreeId) { return true; }`). And line 2855 returns `null` for `CODE REVIEWED → COMPLETED` path when `!acceptanceTesterActive`. Trace the actual behavior for a worktree plan at CODE REVIEWED to confirm whether autoban already stops correctly. If the existing guard already handles this, Phase 4 may be a no-op for the forward-move logic.

**Solution**: Modify autoban forward-move logic to check for worktree presence (if not already handled)

**Changes** (only if verification shows gaps):
- Autoban forward-move handlers check if plan has `worktreeId`
- If plan has worktree: stop at CODE REVIEWED (do not auto-move to MERGE)
- If plan has no worktree: continue to auto-advance to COMPLETED (existing behavior)
- User manually drags worktree plans to MERGE column when ready
- User uses manual merge controls to execute merge

## Phase 5: Merge Bug Fixes

**Bug 1: Squash commit --no-edit fails**
- `git merge --squash` doesn't set MERGE_MSG, so `git commit --no-edit` fails with empty commit message
- **⚠️ Pre-implementation verification**: Line 6795 already reads `await execFileAsync('git', ['commit', '-m', \`Merge ${worktree.branch} (squash)\`], ...)`. Confirm whether this bug is already fixed before coding.
- If not fixed: Use `git commit -m "Merge worktree <branch>"` instead of `--no-edit`

**Bug 2: Abort on any conflict**
- Line 6808–6815: `git merge --abort` runs if ANY file conflicts, even if code files merged cleanly
- Fix: After catching a conflict error, call `git diff --name-only --diff-filter=U` to get list of unmerged files
- If ALL unmerged files are plan files (match `*.switchboard/plans/**` or `.md` extension in `.switchboard/` dir): do NOT abort; show message asking user to resolve plan file conflict manually in the main branch
- If any non-plan files are conflicted: abort with `git merge --abort` (existing behavior) and show error
- Implementation location: `_executeMergeRule` catch block (lines 6807–6820)
- New logic:

```typescript
// After catching conflict error:
const { stdout: unmergedFiles } = await execFileAsync(
    'git', ['diff', '--name-only', '--diff-filter=U'], { cwd: workspaceRoot }
);
const conflicted = unmergedFiles.trim().split('\n').filter(Boolean);
const allPlanFiles = conflicted.every(f => f.includes('.switchboard/plans/'));
if (allPlanFiles && conflicted.length > 0) {
    vscode.window.showWarningMessage(
        `Plan file conflict for "${plan.topic}". Resolve manually in the main branch, then re-press Merge.`
    );
    // Leave merge in progress — do NOT abort
} else {
    // Code file conflict — abort
    try { await execFileAsync('git', ['merge', '--abort'], { cwd: workspaceRoot }); } catch { /* ignore */ }
    vscode.window.showWarningMessage(
        `Code file conflict for "${plan.topic}". Manual resolution required.`
    );
}
```

**Bug 3: No idempotency guard**
- Re-pressing merge button re-attempts merge on already-merged branch
- **⚠️ Pre-implementation verification**: After `_cleanupWorktreeAfterMerge`, `plan.worktreeId` is nulled in DB (line 6854). `_executeMergeRule` guards on `!plan.worktreeId` (line 6774). So re-pressing merge after successful merge will fail at the guard. Confirm this is sufficient before adding `git branch --merged` check.
- If explicit git check still needed: Insert before the `git merge` call:

```typescript
const { stdout: mergedBranches } = await execFileAsync(
    'git', ['branch', '--merged', 'HEAD'], { cwd: workspaceRoot }
);
const alreadyMerged = mergedBranches.split('\n').map(b => b.trim().replace(/^\*\s*/, ''));
if (alreadyMerged.includes(worktree.branch)) {
    // Branch already merged — skip merge, just cleanup
    await this._cleanupWorktreeAfterMerge(workspaceRoot, plan, worktree);
    return;
}
```

## Phase 6: Documentation Updates

- Update Worktrees tab description to specify control-plane requirement
- Remove auto-merge documentation from Worktrees tab tooltip (line 7074)
- Add documentation for manual merge controls in MERGE column header
- Document autoban behavior (stops at CODE REVIEWED for worktree plans)
- Update worktree plan files to reflect control-plane-only architecture
- Add error message when worktree mode enabled but control plane not configured

## Success Criteria

- Worktree mode only available when control plane configured
- No per-worktree terminals created
- No auto-merge toggle or logic
- Manual merge controls in MERGE column header (merge all, merge selected, send to agent, copy prompt)
- Autoban stops at CODE REVIEWED for worktree plans, auto-advances non-worktree plans to COMPLETED
- Reviewer reads worktree plan file, makes changes there, merge brings both code and plan to main
- Squash merge succeeds with proper commit message
- Partial merges (code OK, plan conflict) don't abort — user resolves plan conflict manually
- Merge button idempotent — re-pressing after success is safe

## Verification Plan

### Automated Tests

> Per session directive: automated tests will be run separately by the user. No test execution during implementation.

### Manual Smoke Tests (implementer)

1. **Control plane guard**: Enable worktree mode without explicit control plane configured → expect warning, mode stays disabled
2. **Terminal not spawned**: Move plan to LEAD CODED with worktree mode on → confirm no new terminal appears in VS Code terminal panel
3. **Auto-merge removed**: Move plan to MERGE column → confirm no merge fires automatically; confirm Merge All / Merge Selected buttons appear in column header
4. **Merge All button**: With cards in MERGE column → click Merge All → confirm squash merge fires with commit message `Merge <branch> (squash)`, card advances to COMPLETED, worktree branch is deleted
5. **Bug 2 — plan-file conflict**: Manually create a conflicting plan file change on main branch → trigger merge → confirm merge is not aborted, warning shown, code files remain clean
6. **Bug 2 — code conflict**: Manually create conflicting code change on main branch → trigger merge → confirm `git merge --abort` fires, warning shown
7. **Bug 3 — idempotency**: Complete a merge → confirm card is no longer in MERGE column and re-pressing merge is safe (no error or double-commit)
8. **Reviewer prompt**: Dispatch reviewer for a worktree plan → confirm prompt includes `worktreePath` and instruction to read worktree plan file

## Recommendation

**Complexity: 7 → Send to Lead Coder**

This plan involves cross-cutting changes across control plane integration, UI, autoban automation, and merge logic. Phase 3 (manual merge controls) requires new frontend architecture in `kanban.html`. Phase 5 Bug 2 (file-type-aware conflict detection) has deliberate UX risk. Lead Coder should verify Bug 1 and Bug 3 first (may be pre-fixed), audit Phase 4 autoban behavior before making changes, and implement Phase 3 with in-flight merge state management.
