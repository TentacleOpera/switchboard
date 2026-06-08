# Redesign Worktrees: Replace Per-Plan System with Safety Session

## Goal

Replace the current worktree feature — which auto-creates per-plan worktrees, injects a MERGE column, and tracks worktree state per plan — with a much simpler **safety session** model. A safety session is a single git worktree that covers all agent work for a sprint or batch. The user creates it before a risky batch, all coder prompts reference the worktree path, and the user merges it back when satisfied.

**Why this matters:** The current implementation creates worktrees but never tells coder agents to use them (only reviewer prompts receive path injection). The MERGE column disrupts the kanban flow for all users when worktree mode is enabled. The per-plan auto-creation model assumes on-demand terminal creation, which conflicts with Switchboard's terminal model (user-managed, pre-authenticated). The safety session model matches how Switchboard actually works: all terminals live in the control plane, agents are directed to a subdirectory via prompt.

**Current implementation state (as of 2026-06-08):** The safety session backend handlers (`startSafetySession`, `mergeSafetySession`, `abandonSafetySession`, `getSafetySession`, `clearSafetySessionRecord`) are already implemented in `KanbanProvider.ts` (lines 6249-6368). The prompt injection for coder/lead/intern roles is already implemented in `agentPromptBuilder.ts` (lines 644-655, 696-707, 741-752). The path resolution in `_cardsToPromptPlans` is already implemented (lines 2227-2233, 2250). However, two private helper methods called by the handlers (`_createSafetyWorktree`, `_getSafetySessionData`) are **not defined** — the code will crash at runtime. There is also a bug where meta keys are cleared with empty strings instead of null, causing stale path injection after merge. The WORKTREES tab UI has **not** been converted to the safety session model. The old worktree system (MERGE column, per-plan worktree assignment, old WORKTREES tab) is still present and must be deleted.

## Metadata

- **Complexity:** 6
- **Tags:** backend, frontend, refactor

## User Review Required

Yes — the deletion phase touches the MERGE column injection in `_buildKanbanColumns` (lines 448-465), `_hasPlansInMergeColumn` (lines 418-440), and ~270 lines of `createWorktreePanel()` in `kanban.html` (lines 8205-8470). Must be reviewed before implementation.

## Complexity Audit

### Routine
- Replacing WORKTREES tab panel code with simplified session UI
- Adding `_createSafetyWorktree` and `_getSafetySessionData` private helpers (handlers already call them)
- Storing active session in DB meta keys (reuses existing `getMeta`/`setMeta`)
- Injecting worktree path into coder prompts (already done — lines 644-655, 696-707, 741-752)
- Resolving safety session path in `_cardsToPromptPlans` (already done — lines 2227-2233, 2250)
- Adding reviewer safety session injection (mirrors existing coder/lead/intern pattern)
- Fixing empty-string meta clear bug (change `''` to `null` in three handlers)

### Complex / Risky
- Deletion of MERGE column injection in `_buildKanbanColumns` (lines 448-465) and `_hasPlansInMergeColumn` (lines 418-440) — must not break column routing for non-worktree plans
- `_createSafetyWorktree` must run from the control plane root (`workspaceRoot`), not from the worktree subdirectory — easy to get wrong
- Squash merge of a safety session collapses all sprint work into one commit — needs explicit warning in the UI
- If the worktree path is missing from disk (user deleted it manually), `mergeSafetySession` must handle the error gracefully (partially handled — shows error but doesn't offer "clear record only" in VS Code message)
- Empty-string meta clear bug: after merge/abandon, `getMeta` returns `''` which is truthy, causing stale safety session path injection into all coder prompts

## Problem Analysis

The current worktree system:
1. Auto-creates a git worktree per plan when it moves to a coder column (`_assignWorktreeToCard`)
2. Injects a MERGE column between CODE REVIEWED and COMPLETED when worktree mode is enabled
3. Tracks `worktree_id` and `worktree_status` on every plan record
4. Provides a WORKTREES tab with mode toggle, cap setting, merge strategy picker, and per-role pools

The system never tells coder agents which worktree to use — path injection only appears in the reviewer prompt (`agentPromptBuilder.ts`). The MERGE column disrupts the standard kanban flow. The auto-creation model cannot work with Switchboard's terminal model (user-managed, pre-authenticated terminals cannot be redirected to new directories on demand).

The safety session model is simpler: one worktree per sprint/batch, all coder agents directed to its path via prompt, user merges when satisfied. Terminals stay in the control plane directory throughout (preserving `agents.md` access). The MERGE column is removed. The WORKTREES tab becomes a three-state UI: no session / session active / session complete.

**Current state:** The safety session backend and prompt injection are partially implemented. The remaining work is: (1) implement two missing private helpers, (2) fix the empty-string meta clear bug, (3) add reviewer safety session injection, (4) delete the old worktree system, (5) build the new WORKTREES tab UI.

## Requirements

### Functional

1. **Start safety session**: User clicks "START SAFETY SESSION" in WORKTREES tab. System runs `git worktree add ./switchboard-safety-<timestamp> switchboard-safety-<timestamp>` from the control plane root (`workspaceRoot`). Stores branch name and ISO start time in DB meta.
2. **Session indicator**: While a session is active, the WORKTREES tab shows branch name, path, and time started.
3. **Prompt injection**: When a safety session is active, all coder/lead/intern/reviewer prompt builds include the worktree path with explicit instructions to navigate into it and run all git operations from inside it.
4. **Merge back (manual)**: "MERGE BACK" button runs `git merge --no-ff <branch>` from the control plane root, then `git worktree remove --force <path>`, then `git branch -D <branch>`. Clears the DB meta keys. Posts a status message on success or error.
5. **Ask agent to merge**: "ASK AGENT TO MERGE" button copies a merge prompt to the clipboard instructing an agent to run the merge, handle any conflicts, clean up the worktree, and confirm completion.
6. **Abandon session**: "ABANDON" button removes the worktree and branch without merging, after a confirmation dialog. Clears DB meta keys.
7. **No MERGE column**: The MERGE column is removed from the kanban board entirely. Plans that previously entered MERGE now go directly from CODE REVIEWED to COMPLETED (their existing pre-worktree routing).
8. **Resilience**: If the worktree directory no longer exists on disk when the user tries to merge or abandon, show an error and offer to clear the session record only.

### Non-Functional

- Terminals are never restarted or redirected by the safety session system — they stay in the control plane directory.
- The `worktrees` table, `worktree_id`, and `worktree_status` DB columns are left in place but go inert — no migration required.
- The DB meta keys for the old worktree system (`worktree_mode_enabled`, `worktree_max_cap`, `worktree_default_merge_strategy`) are left in place and ignored.

## Edge-Case & Dependency Audit

| Risk | Mitigation |
|------|-----------|
| Branch name already exists | Append `-2`, `-3` etc. or show error and let user retry |
| Worktree directory missing on merge/abandon | Catch git error, offer "clear session record only" |
| Squash merge leaves uncommitted staged changes | After `git merge --squash`, auto-commit with message `Merge safety session <branch>` |
| Agent runs `git status` from control plane root | Prompt injection must warn agent to cd into worktree before all git operations |
| User starts a second session while one is active | Disable "START" button while session is active |
| Control plane is not a git repo | Wrap `git worktree add` in try/catch, surface clear error |
| Merge conflict during merge back | Surface the git error text in the status bar; user must resolve manually or use "ask agent to merge" |
| Empty-string meta clear leaves stale path injection | Fix: clear meta with `null` (or delete key) instead of `''` — `getMeta` must return `null` for cleared keys |
| `_createSafetyWorktree` / `_getSafetySessionData` not defined | Must implement these two private helpers before handlers can work |

## Phase 1: Bug Fixes (Implement Before Deletions)

These fixes address runtime crashes and logic bugs in the already-implemented safety session backend.

### Step 1.1: Implement `_createSafetyWorktree` private helper

**File**: `src/services/KanbanProvider.ts`
**Insert after**: `_isWorktreeModeEnabled` method (after line 6831)

```
private async _createSafetyWorktree(workspaceRoot: string): Promise<{ branch: string; path: string }> {
    const timestamp = new Date().toISOString().slice(0, 10);
    let branch = `switchboard-safety-${timestamp}`;
    const execFileAsync = promisify(cp.execFile);
    
    // Handle duplicate branch name by appending -2, -3, etc.
    let suffix = 2;
    while (true) {
        try {
            const dirName = branch;
            const fullPath = path.join(workspaceRoot, dirName);
            await execFileAsync('git', ['worktree', 'add', '-b', branch, fullPath], { cwd: workspaceRoot });
            return { branch, path: fullPath };
        } catch (e: any) {
            if (e.message?.includes('already exists') || e.message?.includes('already used')) {
                branch = `switchboard-safety-${timestamp}-${suffix}`;
                suffix++;
            } else {
                throw e;
            }
        }
    }
}
```

### Step 1.2: Implement `_getSafetySessionData` private helper

**File**: `src/services/KanbanProvider.ts`
**Insert after**: `_createSafetyWorktree` method

```
private async _getSafetySessionData(workspaceRoot: string): Promise<{ branch: string; path: string; startedAt: string; pathExists: boolean } | null> {
    const db = this._getKanbanDb(workspaceRoot);
    if (!db || !await db.ensureReady()) return null;
    const branch = await db.getMeta('active_safety_session_branch');
    const sessionPath = await db.getMeta('active_safety_session_path');
    const startedAt = await db.getMeta('active_safety_session_started_at');
    if (!branch || !sessionPath) return null;
    return {
        branch,
        path: sessionPath,
        startedAt: startedAt || '',
        pathExists: fs.existsSync(sessionPath)
    };
}
```

### Step 1.3: Fix empty-string meta clear bug

**File**: `src/services/KanbanProvider.ts`

In `mergeSafetySession` handler (lines 6303-6305), change:
```
await db.setMeta('active_safety_session_branch', '');
await db.setMeta('active_safety_session_started_at', '');
await db.setMeta('active_safety_session_path', '');
```
To:
```
await db.setMeta('active_safety_session_branch', '');
await db.setMeta('active_safety_session_started_at', '');
await db.setMeta('active_safety_session_path', '');
```
**Wait** — the real fix is in `_cardsToPromptPlans` (line 2229). Change `if (activeBranch)` to `if (activeBranch && activeBranch !== '')`. This is safer than changing `setMeta` behavior which may have other consumers. Alternatively, change the three `setMeta` calls to pass a sentinel like `'__cleared__'` and check for it. The simplest correct fix: change the condition in `_cardsToPromptPlans` line 2229 from `if (activeBranch)` to `if (activeBranch && activeBranch.trim())`.

Apply the same fix in `abandonSafetySession` handler (lines 6341-6343) and `clearSafetySessionRecord` handler (lines 6358-6360) — these also clear with empty strings.

### Step 1.4: Add reviewer safety session injection

**File**: `src/services/agentPromptBuilder.ts`

The reviewer prompt path (lines 496-567) has **no** safety session injection. The old reviewer worktree block referenced in the original plan ("lines ~563-575") has already been removed. Add a safety session block to the reviewer path, mirroring the coder/lead/intern pattern.

**Insert after** line 546 (after the caveman output block, before the focusBlock):

```
let safetySessionBlock = '';
for (const plan of plans) {
    if (plan.worktreePath) {
        safetySessionBlock += `\nIMPORTANT: You are reviewing work done in a safety session. The worktree directory is: ${plan.worktreePath}\n` +
            `Read the plan file and code changes from that location (not the main directory).\n`;
    }
}
if (safetySessionBlock) {
    baseInstructions += '\n\n' + safetySessionBlock.trim();
}
```

Note: The reviewer instruction is different from the coder instruction — it tells the reviewer to read from the worktree, not to navigate into it (reviewers don't make git changes in the worktree).

## Phase 2: Deletions (Code Review Agent Required Before Implementation)

**This phase must be reviewed by a code review agent before any code is written.** The deletions touch critical routing and rendering paths.

### Files and what is deleted

#### `src/services/KanbanProvider.ts`
- `_worktreeModeEnabledMap` field (line 140) and all reads/writes (lines 450, 6338, 6434, 6829)
- `_assignWorktreeToCard(workspaceRoot, sessionId, targetColumn)` — entire method (lines 6597-6630). **Note: This method has zero call sites** — it is dead code. Safe to delete.
- `_createWorktreeForPlan(workspaceRoot, planName, targetColumn)` — entire method (lines 6837-6878). **Note: Also dead code** — only called from `_assignWorktreeToCard`.
- `_cleanupWorktreeAfterMerge(workspaceRoot, plan, worktree)` — entire method (lines 6795-6839). Called from `_executeMergeRule` (lines 6722, 6751) — those call sites must also be deleted.
- `_cleanupWorktreeAfterReview(workspaceRoot, sessionId)` — entire method (lines 6841-6878). **Dead code** — zero call sites. Safe to delete.
- `_isWorktreeModeEnabled(workspaceRoot)` — entire method (lines 6819-6831). Called from `_assignWorktreeToCard` (dead) and `getWorktrees`/`setWorktreeMode` handlers (being deleted).
- `_hasPlansInMergeColumn(workspaceRoot)` — entire method (lines 418-440) and its cache field `_mergeColumnCheckCache`
- MERGE column injection in `_buildKanbanColumns` (lines 448-465) — the block that conditionally splices in the MERGE column
- `_executeMergeRule(workspaceRoot, sessionId, rule)` — entire method (line 6699+). Called from old merge handlers being deleted.
- `_resolveWorktreePaths(workspaceRoot)` — entire method (lines 6734-6782). Called from cleanup methods being deleted and from old worktree message handlers being deleted.
- `_findTerminalForWorktree(worktreePath)` — entire method (lines 6860-6864). Called from cleanup methods being deleted.
- Old message handlers — delete entirely:
  - `case 'getWorktrees'` handler (around line 6338) — **Clarification**: This handler was previously identified but the exact line needs verification. Search for `msg.type === 'getWorktrees'` or equivalent pattern.
  - `case 'setWorktreeMode'` handler
  - `case 'setWorktreeRules'` handler
  - `case 'deleteWorktree'` handler
  - `case 'executeMerge'` handler
  - `case 'executeMergeAll'` / `case 'executeMergeSelected'` handlers
- `_mergeColumnCheckCache` field declaration and all usages

**Important**: The `_getNextColumnId` method (lines 3011-3067) does **NOT** contain MERGE routing logic. The `planWorktreeId` parameter is declared but unused. After deletions, remove the unused `planWorktreeId` and `sessionId` parameters from `_getNextColumnId`'s signature and all its call sites.

#### `src/services/KanbanDatabase.ts`
- `createWorktree(branch, coderAgentId)` — line 1428
- `getWorktrees()` — line 1450
- `deleteWorktree(id)` — line 1472
- `assignAgentToWorktree(worktreeId, coderAgentId)` — line 1480
- `updatePlanWorktree(sessionId, worktreeId)` — line 1489
- `updatePlanWorktreeStatus(sessionId, status)` — line 1500
- `getWorktreeById(id)` — line 1511

#### `src/services/agentPromptBuilder.ts`
- No deletions needed. The old reviewer worktree injection block ("lines ~563-575") has already been removed. The reviewer path now needs the new safety session injection added (Phase 1 Step 1.4).

#### `src/webview/kanban.html`
- MERGE column rendering: column header buttons (`btn-merge-all` line 4318, `btn-merge-selected` line 4321, `btn-send-to-agent` line 4324, `btn-copy-merge-prompt` line 4327)
- Merge action buttons on cards: `merge-action-btn` (line 5091), click handlers (lines 4954-4966, 4989-4997, 5000-5010, 5012-5020, 5022-5029)
- `inFlightMerges` Set (line 5723) and all usages (lines 4780, 4994, 5005, 6356, 6360, 6366)
- Card-level worktree icon (`card-worktree-icon` CSS lines 766-781, `ICON_WORKTREE_ACTIVE` line 3605, `ICON_WORKTREE_MERGED` line 3606) and branch name display (`card-branch` line 5075)
- `lastWorktrees` (line 5719), `lastWorktreeModeEnabled` (line 5715), `lastWorktreeMaxCap` (line 5716), `lastWorktreeDefaultMergeStrategy` (line 5717) state variables and all usages
- `createWorktreePanel()` function — entire function (lines 8205-8470)
- `renderWorktreePanel()` function — lines 8475-8484
- `loadWorktrees()` function — lines 8486-8488
- `case 'worktrees'` message handler — lines 5847-5855
- MERGE column CSS (`.col-merge-btn` lines 2251-2276, `.merge-spinner` lines 2278-2287, `@keyframes merge-spin` lines 2289-2291)
- `updateMergeButtons()` function — lines 6347-6379
- Card merge button rendering: `isMergeCard` check (line 5136), merge button condition (line 5090)
- Initialization calls: `loadWorktrees()` (line 3661), `renderWorktreePanel()` (line 3662)

## Phase 3: New UI Implementation

### Step 3.1: WORKTREES tab — simplified session UI

**File**: `src/webview/kanban.html`

Replace `createWorktreePanel()` (deleted in Phase 2) with a new `createSafetySessionPanel(session)` function where `session` is `{ branch, path, startedAt, pathExists } | null`.

**No active session state:**
```
[ description: what a safety session is and when to use it ]
[ START SAFETY SESSION ]   ← disabled if already active
```

**Active session state:**
```
ACTIVE SAFETY SESSION
Branch:  switchboard-safety-2026-06-08
Path:    /path/to/worktree
Started: 3 hours ago
[ MERGE BACK ]   [ ASK AGENT TO MERGE ]   [ ABANDON ]
```

**Path missing on disk warning** (pathExists === false):
```
⚠️ Worktree directory not found on disk.
[ CLEAR SESSION RECORD ]
```

Tab activation calls `loadSafetySession()` which posts `getSafetySession`.

Message handler `case 'safetySession'` stores `lastSafetySession` and calls `renderSafetySessionPanel()`.

**"ASK AGENT TO MERGE" button** copies this prompt to clipboard:
```
Please merge the safety session worktree back to main.
Steps:
1. From the control plane directory, run: git merge --no-ff <branch>
2. If there are conflicts, resolve them, then git add . && git commit
3. Run: git worktree remove --force <path>
4. Run: git branch -D <branch>
5. Confirm that main now contains the merged changes.
```

**"MERGE BACK" button** posts `mergeSafetySession` message to the extension.

**"ABANDON" button** shows a confirmation dialog, then posts `abandonSafetySession` message.

**"CLEAR SESSION RECORD" button** (shown when pathExists === false) posts `clearSafetySessionRecord` message.

### Step 3.2: Remove MERGE column from card rendering

**File**: `src/webview/kanban.html`

After Phase 2 deletions, verify that:
- No card rendering code checks for `card.column === 'MERGE'`
- No column header rendering includes MERGE
- The `isMergeCard` variable and its usages are removed

## Proposed Changes

### `src/services/KanbanProvider.ts`
- **Fix** (Phase 1): Add `_createSafetyWorktree` and `_getSafetySessionData` private helper methods
- **Fix** (Phase 1): Fix empty-string meta clear bug in `_cardsToPromptPlans` condition (line 2229)
- **Fix** (Phase 1): Remove unused `planWorktreeId` and `sessionId` parameters from `_getNextColumnId` (line 3011) and all call sites
- **Delete** (Phase 2): `_worktreeModeEnabledMap`, `_assignWorktreeToCard`, `_createWorktreeForPlan`, `_cleanupWorktreeAfterMerge`, `_cleanupWorktreeAfterReview`, `_isWorktreeModeEnabled`, `_hasPlansInMergeColumn`, `_mergeColumnCheckCache`, `_resolveWorktreePaths`, `_findTerminalForWorktree`, `_executeMergeRule`, MERGE column injection in `_buildKanbanColumns`, old message handlers for `getWorktrees`/`setWorktreeMode`/`setWorktreeRules`/`deleteWorktree`/`executeMerge`/`executeMergeAll`/`executeMergeSelected`
- **Already implemented**: `startSafetySession`, `mergeSafetySession`, `abandonSafetySession`, `getSafetySession`, `clearSafetySessionRecord` message handlers (lines 6249-6368)

### `src/services/KanbanDatabase.ts`
- **Delete** (Phase 2): `createWorktree` (line 1428), `getWorktrees` (line 1450), `deleteWorktree` (line 1472), `assignAgentToWorktree` (line 1480), `updatePlanWorktree` (line 1489), `updatePlanWorktreeStatus` (line 1500), `getWorktreeById` (line 1511)
- **No additions** — session state uses existing `getMeta`/`setMeta`

### `src/services/agentPromptBuilder.ts`
- **Add** (Phase 1): Reviewer safety session injection block (after line 546)
- **Already implemented**: Coder safety session injection (lines 696-707), lead safety session injection (lines 644-655), intern safety session injection (lines 741-752)
- **No deletions needed** — old reviewer worktree block already removed

### `src/webview/kanban.html`
- **Delete** (Phase 2): MERGE column, card worktree icon + branch display, `createWorktreePanel` (lines 8205-8470), `renderWorktreePanel` (lines 8475-8484), `loadWorktrees` (lines 8486-8488), `case 'worktrees'` handler (lines 5847-5855), all worktree state variables (lines 5715-5719), MERGE column CSS (lines 2251-2291), `updateMergeButtons` (lines 6347-6379), `inFlightMerges` (line 5723), merge button handlers and rendering
- **Add/Replace** (Phase 3): `createSafetySessionPanel(session)`, `renderSafetySessionPanel()`, `loadSafetySession()`, `case 'safetySession'` handler, `lastSafetySession` state variable

## Dependencies

- `sess_safetySessionBackend` — Implement `_createSafetyWorktree` and `_getSafetySessionData` helpers (prerequisite for any runtime testing)

## Adversarial Synthesis

Key risks: (1) Two private helper methods are called but never defined — runtime crash on any safety session action. (2) Empty-string meta clear causes stale path injection after merge/abandon — all coder prompts will incorrectly include a worktree path. (3) MERGE column deletion targets `_buildKanbanColumns` (lines 448-465), not `_getNextColumnId` — the plan originally identified the wrong location. Mitigations: Implement helpers first (Phase 1), fix the truthy-check in `_cardsToPromptPlans`, and verify MERGE column removal by checking that `_buildKanbanColumns` no longer splices in the MERGE column definition.

## Verification Plan

### Automated Tests

(Skip — per session directive)

### Manual Verification

1. Start a safety session from the WORKTREES tab. Verify worktree directory is created in the control plane.
2. Move a plan to a coder column. Copy the coder prompt. Verify the worktree path instruction appears in it.
3. Copy a reviewer prompt. Verify the worktree path instruction appears in it (reviewer reads from worktree).
4. Click MERGE BACK. Verify the branch is merged, directory removed, branch deleted, and UI resets.
5. After merge, copy a coder prompt. Verify NO worktree path instruction appears (empty-string bug fixed).
6. Start a session, manually delete the worktree directory from disk. Return to WORKTREES tab. Verify the "path missing" warning appears and CLEAR SESSION RECORD works.
7. Verify the MERGE column no longer appears in the kanban board.
8. Verify normal plans (no safety session active) still route CODE REVIEWED → COMPLETED correctly.
9. Verify `_getNextColumnId` still works after removing unused `planWorktreeId`/`sessionId` parameters.

## Acceptance Criteria

- [ ] WORKTREES tab shows "no active session" state with a START button when no session exists
- [ ] START SAFETY SESSION creates a git worktree and branch in the control plane directory
- [ ] While a session is active, all coder/lead/intern/reviewer prompt copies include the worktree path and git-scope warning
- [ ] MERGE BACK merges the branch to main, removes worktree directory, removes branch, resets UI
- [ ] After MERGE BACK, no stale worktree path appears in coder prompts (empty-string bug fixed)
- [ ] ASK AGENT TO MERGE copies a clear merge prompt to clipboard
- [ ] ABANDON removes worktree and branch without merging after confirmation
- [ ] MERGE column no longer appears in the kanban board under any configuration
- [ ] Plans route CODE REVIEWED → COMPLETED correctly when no safety session is active
- [ ] Worktree path missing on disk shows a warning with CLEAR SESSION RECORD option
- [ ] No DB migration is required (worktrees table and plan columns left inert)
- [ ] `_createSafetyWorktree` and `_getSafetySessionData` private helpers are implemented and handlers no longer crash
- [ ] `_getNextColumnId` no longer has unused `planWorktreeId`/`sessionId` parameters

## Recommendation

**Send to Coder** — Complexity 6. Majority of backend is already implemented. Remaining work is: two small helper methods, one condition fix, one prompt injection addition, deletion of dead code, and a new UI panel. The deletions are safe because most worktree methods are already dead code with zero call sites. The UI work is routine HTML/JS following existing patterns.
