# Auto-Commit on Code Review Transition

## Summary
Add a configuration option to auto-commit git changes when a plan is moved to the CODE REVIEWED column. This ensures reviewers get clean diffs scoped to the work being reviewed, rather than polluted by changes from other in-progress plans.

## Motivation
Currently, when reviewers run `git diff` on a plan in CODE REVIEWED, the working tree is often dirty with changes from 20+ other plans. This defeats the purpose of code review—the reviewer cannot distinguish which changes belong to the plan under review versus unrelated work.

Auto-committing on the CODE REVIEWED transition creates a clean checkpoint for each plan entering review, giving reviewers an accurate diff of the work they're reviewing.

## Goal
Auto-commit all uncommitted git changes when a plan card is moved to the CODE REVIEWED kanban column, giving reviewers a clean working tree and accurate diff. Controlled by a per-workspace toggle that defaults to enabled.

## Metadata
- **Tags:** [workflow, reliability]
- **Complexity:** 4

## User Review Required
- Confirm that defaulting to **enabled** is acceptable (users who prefer manual commit control may want it off by default)
- Confirm the commit message format is desirable: `"switchboard: auto-commit before code review ({topic}, {timestamp})"`

## Complexity Audit

### Routine
- Adding a boolean flag to `_saveStartupCommands` / `_getStartupCommands` in KanbanProvider (follows existing `gitWorktreesEnabled` pattern)
- Adding a checkbox to `kanban.html` agents tab (follows existing `agents-tab-git-worktrees` pattern at line 2135)
- Hydrating the checkbox state from `state.json` on panel load (follows existing hydration pattern at kanban.html ~line 5356)
- Saving checkbox state on change (follows existing `agentsTabSaveConfig` pattern at kanban.html ~line 2910)
- Calling `_taskViewerProvider.autoCommitForCodeReview(...)` from KanbanProvider (existing reference at line 135)

### Complex / Risky
- Hooking all code paths that can move a card to CODE REVIEWED (not just the two public methods — also `moveCardBackwards` handler at line 4302, and potentially `advanceWorkflow` at line 3046)
- Batch move semantics: `git add -A` stages ALL changes, not just the ones for the target plan. The first auto-commit captures all dirty state; subsequent ones are no-ops. The commit message is informational, not a scope guarantee.

## Edge-Case & Dependency Audit

### Race Conditions
- **Batch drag-drop**: If multiple cards are moved to CODE REVIEWED in rapid succession, the first auto-commit captures all dirty changes. Subsequent moves find a clean tree and skip. This is acceptable — the commit message is informational.
- **Concurrent external edits**: If files are modified externally between the dirty-check and the `git add -A`, those changes get included. This is inherent to `git add -A` and matches the existing `_autoCommitDirtyMain` behavior for worktrees.

### Security
- No secrets are exposed. Commit messages contain only the plan topic and timestamp.
- `git add -A` could stage files the user didn't intend to commit (e.g., `.env` files). Mitigation: users should have `.gitignore` rules for sensitive files. This matches the existing worktree auto-commit behavior.

### Side Effects
- Creates a git commit as a side effect of a kanban card move. Users who don't expect this could be surprised. Mitigation: the config toggle defaults to on but can be disabled; the commit message clearly identifies it as a Switchboard auto-commit.
- The commit includes ALL uncommitted changes, not just files related to the plan being moved. This is a known limitation of `git add -A`.

### Dependencies & Conflicts
- Depends on `_taskViewerProvider` reference being set on `KanbanProvider` (it is — set via `setTaskViewerProvider()` at line 145).
- No conflict with existing `_autoCommitDirtyMain` for worktrees — that fires on dispatch to coder columns, this fires on move to CODE REVIEWED. Different triggers, different commit messages.
- The `state.json` key `autoCommitOnCodeReview` does not conflict with any existing keys.

## Dependencies
- None (standalone feature)

## Adversarial Synthesis
Key risks: (1) `git add -A` commits all dirty changes, not just the plan's — the commit message implies plan-scoping that git cannot guarantee. (2) Multiple code paths can move cards to CODE REVIEWED; missing a hook point means auto-commit silently skips. (3) Users may not expect a git commit as a side effect of a drag-drop. Mitigations: document the all-changes behavior in the UI note; hook all three entry points (`moveCardToColumn`, `moveCardToColumnByPlanFile`, `moveCardBackwards`); config toggle with clear label.

## Requirements
- Add a configuration option in the kanban agents tab (not setup.html)
- Option should default to **enabled** (on)
- When enabled, auto-commit any uncommitted changes when a plan is moved to CODE REVIEWED
- Commit message format: `"switchboard: auto-commit before code review ({topic}, {timestamp})"`
- Only commit if there are actual changes (skip if working tree is clean)
- Handle failures gracefully (log warning, don't block the transition)
- Hook all code paths that can move a card to CODE REVIEWED

## Implementation Plan

### 1. Add Configuration Storage
- **File**: `src/services/KanbanProvider.ts`
- **`_getStartupCommands`** (line ~2204): Add `autoCommitOnCodeReview` to the returned object, defaulting to `true`
  ```typescript
  autoCommitOnCodeReview: state.autoCommitOnCodeReview ?? true
  ```
- **`_saveStartupCommands`** (line ~2221): Persist the new flag
  ```typescript
  if (typeof msg.autoCommitOnCodeReview === 'boolean') state.autoCommitOnCodeReview = msg.autoCommitOnCodeReview;
  ```
- **Add public accessor** (near `getGitWorktreesEnabled` at line 2216):
  ```typescript
  public async getAutoCommitOnCodeReview(workspaceRoot: string): Promise<boolean> {
      const state = await this._getStartupCommands(workspaceRoot);
      return state.autoCommitOnCodeReview ?? true;
  }
  ```

### 2. Expose Auto-Commit Method on TaskViewerProvider
- **File**: `src/services/TaskViewerProvider.ts`
- **Existing private method**: `_autoCommitDirtyMain` (line 16772) — 30 lines of battle-tested git logic
- **Add public wrapper** after `_autoCommitDirtyMain` (after line 16802):
  ```typescript
  public async autoCommitForCodeReview(workspaceRoot: string, planTopic: string): Promise<void> {
      const execAsync = promisify(cp.exec);
      try {
          const { stdout: diffStdout } = await execAsync('git diff --exit-code --stat', { cwd: workspaceRoot });
          const { stdout: cachedStdout } = await execAsync('git diff --cached --exit-code --stat', { cwd: workspaceRoot });
          const hasUnstaged = diffStdout.trim().length > 0;
          const hasStaged = cachedStdout.trim().length > 0;
          if (!hasUnstaged && !hasStaged) {
              console.log(`[TaskViewerProvider] Working tree clean — skipping auto-commit for code review`);
              return;
          }
          if (hasUnstaged) {
              await execAsync('git add -A', { cwd: workspaceRoot });
          }
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
          const safeTopic = planTopic.replace(/"/g, '').substring(0, 80);
          await execAsync(`git commit -m "switchboard: auto-commit before code review (${safeTopic}, ${timestamp})"`, { cwd: workspaceRoot });
          console.log(`[TaskViewerProvider] Auto-committed before code review for: ${safeTopic}`);
      } catch (e: any) {
          console.warn(`[TaskViewerProvider] Auto-commit before code review failed (non-fatal): ${e.message}`);
      }
  }
  ```
- **Clarification**: This is a public wrapper rather than extracting `_autoCommitDirtyMain` to a shared utility, because `KanbanProvider` already holds a `_taskViewerProvider` reference and can call through it. This avoids creating a new module and avoids import complexity.

### 3. Add Auto-Commit Hook in KanbanProvider
- **File**: `src/services/KanbanProvider.ts`
- **Add private helper method** (near `moveCardToColumn` at line 3737):
  ```typescript
  private async _autoCommitIfCodeReviewTransition(
      workspaceRoot: string,
      sessionId: string,
      targetColumn: string
  ): Promise<void> {
      if (targetColumn !== 'CODE REVIEWED') return;
      const autoCommitEnabled = await this.getAutoCommitOnCodeReview(workspaceRoot);
      if (!autoCommitEnabled) return;
      if (!this._taskViewerProvider) return;
      // Look up plan topic from DB for commit message
      let planTopic = 'unknown';
      try {
          const db = this._getKanbanDb(workspaceRoot);
          if (await db.ensureReady()) {
              const record = await db.getPlanBySessionId(sessionId);
              if (record?.topic) planTopic = record.topic;
          }
      } catch { /* use fallback topic */ }
      await this._taskViewerProvider.autoCommitForCodeReview(workspaceRoot, planTopic);
  }
  ```
- **Hook in `moveCardToColumn`** (line 3737): Call `_autoCommitIfCodeReviewTransition` BEFORE `db.updateColumn` so the commit happens while the card is still in its source column (cleaner semantics):
  ```typescript
  public async moveCardToColumn(workspaceRoot: string, sessionId: string, targetColumn: string): Promise<boolean> {
      try {
          await this._autoCommitIfCodeReviewTransition(workspaceRoot, sessionId, targetColumn);
          const db = this._getKanbanDb(workspaceRoot);
          if (!await db.ensureReady()) return false;
          const moved = await db.updateColumn(sessionId, targetColumn);
          // ... rest unchanged
      }
  }
  ```
- **Hook in `moveCardToColumnByPlanFile`** (line 3756): Same pattern — call before `db.updateColumnByPlanFile`. For this method, resolve sessionId from planFile first for the DB lookup:
  ```typescript
  public async moveCardToColumnByPlanFile(workspaceRoot: string, planFile: string, targetColumn: string): Promise<boolean> {
      try {
          // Resolve sessionId for auto-commit lookup
          if (targetColumn === 'CODE REVIEWED') {
              const db = this._getKanbanDb(workspaceRoot);
              if (await db.ensureReady()) {
                  const workspaceId = await db.getWorkspaceId() || await db.getDominantWorkspaceId() || '';
                  const record = await db.getPlanByPlanFile(planFile, workspaceId);
                  if (record?.sessionId) {
                      await this._autoCommitIfCodeReviewTransition(workspaceRoot, record.sessionId, targetColumn);
                  }
              }
          }
          // ... rest unchanged (existing db.updateColumnByPlanFile call)
      }
  }
  ```
- **Hook in `moveCardBackwards` handler** (line ~4302): When `targetColumn === 'CODE REVIEWED'`, call `_autoCommitIfCodeReviewTransition` for each sessionId before the `db.updateColumn` loop.

### 4. Add Checkbox to Kanban Agents Tab UI
- **File**: `src/webview/kanban.html`
- **Position**: After the worktrees checkbox and its note div (after line 2140), add:
  ```html
  <label class="startup-row" style="display:flex;align-items:center;gap:8px;margin-top:6px;">
    <input id="agents-tab-auto-commit-code-review" type="checkbox" style="width:auto;margin:0;">
    <span>Auto-commit when moving to Code Review</span>
  </label>
  <div id="auto-commit-code-review-note" style="display:none;font-size:10px;color:var(--text-muted);margin-left:24px;margin-top:2px;">
    Uncommitted changes are auto-committed before a plan enters Code Review, giving reviewers a clean diff.
  </div>
  ```
- **`agentsTabCollectConfig`** function (line ~2904): Add to returned object:
  ```javascript
  autoCommitOnCodeReview: document.getElementById('agents-tab-auto-commit-code-review')?.checked ?? true,
  ```
- **Hydration on state load** (line ~5356): Set checkbox state from `msg.autoCommitOnCodeReview`:
  ```javascript
  const autoCommitCb = document.getElementById('agents-tab-auto-commit-code-review');
  if (autoCommitCb) autoCommitCb.checked = msg.autoCommitOnCodeReview !== false;
  const autoCommitNote = document.getElementById('auto-commit-code-review-note');
  if (autoCommitNote) autoCommitNote.style.display = msg.autoCommitOnCodeReview !== false ? 'block' : 'none';
  ```
- **Toggle note visibility**: Add event listener near line 2923 (following the worktree pattern):
  ```javascript
  const autoCommitCb = document.getElementById('agents-tab-auto-commit-code-review');
  const autoCommitNote = document.getElementById('auto-commit-code-review-note');
  if (autoCommitCb && autoCommitNote) {
      autoCommitNote.style.display = autoCommitCb.checked ? 'block' : 'none';
      autoCommitCb.addEventListener('change', () => {
          autoCommitNote.style.display = autoCommitCb.checked ? 'block' : 'none';
      });
  }
  ```
- **Message handler for real-time toggle** (near line 5384): Add a case for `autoCommitOnCodeReviewSetting`:
  ```javascript
  case 'autoCommitOnCodeReviewSetting': {
      const el = document.getElementById('agents-tab-auto-commit-code-review');
      if (el) el.checked = msg.enabled !== false;
      const noteEl = document.getElementById('auto-commit-code-review-note');
      if (noteEl) noteEl.style.display = msg.enabled !== false ? 'block' : 'none';
      break;
  }
  ```

### 5. Testing
- Test auto-commit triggers on CODE REVIEWED transition (drag a card to Reviewed column)
- Test no commit when working tree is clean
- Test graceful failure handling (e.g., pre-commit hook rejection)
- Test config toggle (enable/disable) — when disabled, no auto-commit fires
- Test commit message format includes plan topic and timestamp
- Test `moveCardBackwards` to CODE REVIEWED also triggers auto-commit
- Test batch move: first card auto-commits all changes, second card finds clean tree and skips

## Edge Cases
- Workspace is not a git repo → `autoCommitForCodeReview` catches the `git` command failure, logs warning, doesn't block transition
- Pre-commit hook rejects commit → caught by try/catch, logged as warning, doesn't block transition
- Empty commit (no changes) → `git diff` check returns empty stdout, method returns early
- Multiple plans moved simultaneously → first auto-commit captures all dirty state; subsequent ones find clean tree and skip. Commit message is informational only.
- `_taskViewerProvider` not set → `_autoCommitIfCodeReviewTransition` returns early, no error

## Trade-offs
- **Pros**: Clean diffs for reviewers, meaningful commit checkpoints, consistent with existing worktree auto-commit pattern
- **Cons**: More commits in git history (one per plan entering review); `git add -A` commits ALL changes, not just the plan's files
- **Mitigation**: Commits are meaningful checkpoints with descriptive messages; config toggle allows disabling

## Success Criteria
- Reviewers see clean diffs when reviewing plans
- Configuration option exists in kanban agents tab and defaults to on
- Auto-commit only triggers on CODE REVIEWED transition (not other column moves)
- Failures don't block card movement
- All code paths that move cards to CODE REVIEWED are hooked (drag-drop, moveCardToColumn, moveCardToColumnByPlanFile, moveCardBackwards)

## Review Pass — Completed

### Stage 1: Grumpy Principal Engineer Findings

| # | Severity | Finding |
|---|----------|---------|
| 1 | **CRITICAL** | `autoCommitForCodeReview` used `git diff --exit-code --stat` which exits code 1 when differences exist. Node's `promisify(cp.exec)` throws on non-zero exit codes. The outer catch logs a warning and returns — the auto-commit **never fires when there are actual changes**. Only "works" on a clean tree, where it skips anyway. |
| 2 | **MAJOR** | `git diff --stat` only detects changes to **tracked** files. Untracked (new) files — the most common output of a coder's work — are invisible. Auto-commit would skip, leaving the reviewer with a dirty tree. |
| 3 | NIT | `autoCommitOnCodeReviewSetting` message handler in kanban.html is dead code — no TypeScript sender exists. Matches pre-existing `gitWorktreesSetting` pattern. Harmless. |
| 4 | NIT | Inconsistent truthiness: `gitWorktreesSetting` uses `msg.enabled === true` (strict) vs `autoCommitOnCodeReviewSetting` uses `msg.enabled !== false` (loose). Auto-commit version is semantically correct for default-on. |

### Stage 2: Balanced Synthesis

| Finding | Verdict | Action |
|---------|---------|--------|
| CRITICAL: `--exit-code` causes throw-on-changes | **Fix now** | Replace two-command diff with `git status --porcelain` |
| MAJOR: Untracked files invisible to `git diff` | **Fix now** | Same fix — `git status --porcelain` detects all change types |
| NIT: Dead message handler | Defer | Harmless defensive code; matches existing pattern |
| NIT: Inconsistent truthiness | Defer | Auto-commit version is semantically correct |

### Stage 3: Code Fixes Applied

**File changed**: `src/services/TaskViewerProvider.ts` (lines 16807-16826)

Replaced the two-command `git diff --exit-code --stat` + `git diff --cached --exit-code --stat` approach with a single `git status --porcelain` check:

- `git status --porcelain` always exits 0 (never throws via `promisify(exec)`)
- Detects all change types: unstaged, staged, **and untracked** files
- Simpler: one command instead of two; unconditional `git add -A` (always needed since untracked files require staging)
- Clean tree detection: empty stdout → skip

### Stage 4: Validation

- **Typecheck**: `npx tsc --noEmit` — 2 pre-existing errors (unrelated import extensions in ClickUpSyncService.ts:2309 and KanbanProvider.ts:4614). No new errors introduced by the fix.
- **Implementation completeness check** (all plan requirements verified against source):

| Requirement | Status | Location |
|-------------|--------|----------|
| Config option in kanban agents tab | ✅ | kanban.html:2141-2147 |
| Defaults to enabled | ✅ | KanbanProvider.ts:2210 (`?? true`), kanban.html:2915 (`?? true`), kanban.html:5380 (`!== false`) |
| Auto-commit on CODE REVIEWED transition | ✅ | KanbanProvider.ts:3745-3764 |
| Commit message format | ✅ | TaskViewerProvider.ts:16821 |
| Skip if working tree clean | ✅ | TaskViewerProvider.ts:16814-16816 |
| Graceful failure handling | ✅ | TaskViewerProvider.ts:16823-16824 |
| Hook: moveCardToColumn | ✅ | KanbanProvider.ts:3772 |
| Hook: moveCardToColumnByPlanFile | ✅ | KanbanProvider.ts:3795-3799 |
| Hook: moveCardBackwards | ✅ | KanbanProvider.ts:4342-4346 |
| Hook: moveCardForwards (bonus) | ✅ | KanbanProvider.ts:4402-4406 |
| Hook: advanceRunSheet (bonus) | ✅ | KanbanProvider.ts:3052 |
| Config persistence (_getStartupCommands) | ✅ | KanbanProvider.ts:2210 |
| Config persistence (_saveStartupCommands) | ✅ | KanbanProvider.ts:2239 |
| Public accessor (getAutoCommitOnCodeReview) | ✅ | KanbanProvider.ts:2222-2225 |
| Checkbox hydration on state load | ✅ | kanban.html:5379-5382 |
| Note visibility toggle | ✅ | kanban.html:2940-2947 |
| agentsTabCollectConfig | ✅ | kanban.html:2915 |
| Real-time toggle message handler | ✅ | kanban.html:5414-5420 (dead code — no sender, but harmless) |

### Remaining Risks

1. **Pre-existing bug in `_autoCommitDirtyMain`** (TaskViewerProvider.ts:16775-16805): Same `git diff --exit-code` bug exists in the worktree auto-commit method. Not fixed here (outside plan scope) but should be addressed in a follow-up.
2. **`moveCardToColumnByPlanFile` silent skip**: If `db.getPlanByPlanFile()` returns no `sessionId`, the auto-commit silently skips. Acceptable edge case — DB should always have the session ID for a valid plan file.
3. **Dead message handler**: `autoCommitOnCodeReviewSetting` handler in kanban.html has no corresponding sender in TypeScript. Could be activated later if real-time toggle dispatch is needed.

## Recommendation
Complexity 4 → **Send to Coder** (implementation complete, CRITICAL bug fixed in review)
