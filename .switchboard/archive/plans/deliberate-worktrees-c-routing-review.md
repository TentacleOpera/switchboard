# Worktrees C: Card Routing + Review Integration

## Goal

Add round-robin card routing to worktrees during bulk moves, append worktree context to plan files when moving to CODE REVIEWED, and add optional worktree cleanup after successful review. Depends on Plans A and B being complete.

## Metadata

- **Tags:** [workflow, git]
- **Complexity:** 4

## User Review Required

- Confirm whether worktrees should be auto-cleaned after successful review or persist

## Complexity Audit

### Routine
- Round-robin routing logic (simple min-count algorithm)
- Appending worktree context to plan file (single async append)
- Optional cleanup prompt (follows existing VS Code dialog pattern)

### Complex / Risky
- Plan file modification could conflict with user edits (mitigated by append-only with clear section markers)
- Concurrent card moves could race on worktree assignment (mitigated by single-user context)

## Edge-Case & Dependency Audit

- **Race Conditions**: Multiple cards moving simultaneously could race on worktree assignment. Mitigation: single-user kanban board makes this unlikely; wrap in transaction if needed later.
- **Security**: None beyond what Plan B handles.
- **Side Effects**: Plan file append could conflict with concurrent edits. Mitigation: append to end of file with clear `## Worktree Context` section marker.
- **Dependencies & Conflicts**: Depends on Plans A (DB methods) and B (worktree management) being complete.

## Dependencies

- `deliberate-worktrees-a-cleanup-schema.md` — DB schema and CRUD methods
- `deliberate-worktrees-b-tab-backend.md` — Worktree management backend

## Adversarial Synthesis

Key risks: (1) `db.getAllCards()` does not exist — must use `db.getBoard(workspaceId)`. (2) Plan file append could corrupt files if not done carefully — use async `fs.promises.appendFile` with clear section markers. (3) Round-robin assignment could fail if no worktrees available — must handle gracefully (leave `worktree_id` null, coder works in main workspace). Mitigations: Correct DB API, async file I/O, null fallback.

## Proposed Changes

### File: `src/services/KanbanProvider.ts`

1. **Add round-robin routing method**:
   ```typescript
   private async _assignWorktreeToCard(workspaceRoot: string, sessionId: string): Promise<void> {
       const db = this._getKanbanDb(workspaceRoot);
       if (!db || !await db.ensureReady()) return;

       const worktrees = await db.getWorktrees();
       const availableWorktrees = worktrees.filter(wt => wt.coderAgentId !== null);

       if (availableWorktrees.length === 0) {
           return; // No worktrees available, leave worktree_id null
       }

       const workspaceId = await db.getWorkspaceId();
       if (!workspaceId) return;
       const cards = await db.getBoard(workspaceId);
       const assignmentCounts = new Map<number, number>();
       availableWorktrees.forEach(wt => assignmentCounts.set(wt.id, 0));

       cards.forEach(card => {
           if (card.worktreeId && assignmentCounts.has(card.worktreeId)) {
               assignmentCounts.set(card.worktreeId, (assignmentCounts.get(card.worktreeId) || 0) + 1);
           }
       });

       // Find worktree with minimum assignments
       let minCount = Infinity;
       let selectedWorktreeId: number | null = null;
       for (const [wtId, count] of assignmentCounts) {
           if (count < minCount) {
               minCount = count;
               selectedWorktreeId = wtId;
           }
       }

       if (selectedWorktreeId !== null) {
           await db.updatePlanWorktree(sessionId, selectedWorktreeId);
       }
   }
   ```

2. **Call routing in `moveCardToColumn()`** when moving to coder columns:
   ```typescript
   const coderColumns = ['LEAD CODED', 'CODER CODED', 'INTERN CODED'];
   if (coderColumns.includes(targetColumn)) {
       await this._assignWorktreeToCard(workspaceRoot, sessionId);
   }
   ```

3. **Call routing in `moveCardToColumnByPlanFile()`** similarly.

4. **Add worktree context appender**:
   ```typescript
   private async _appendWorktreeContextToPlan(workspaceRoot: string, sessionId: string): Promise<void> {
       const db = this._getKanbanDb(workspaceRoot);
       if (!db || !await db.ensureReady()) return;

       const plan = await db.getPlanBySessionId(sessionId);
       if (!plan || !plan.worktreeId) return;

       const worktree = await db.getWorktreeById(plan.worktreeId);
       if (!worktree) return;

       const planPath = this._resolvePlanFilePath(workspaceRoot, plan.planFile);
       if (!planPath) return;

       const worktreeContext = `

## Worktree Context
This work was done in a git worktree.
- Worktree path: ${worktree.path}
- Branch: ${worktree.branch}
- To merge: cd ${worktree.path} && git checkout main && git merge ${worktree.branch}
`;

       try {
           await fs.promises.appendFile(planPath, worktreeContext, 'utf8');
       } catch (e: any) {
           console.error(`Failed to append worktree context to plan: ${e.message}`);
       }
   }
   ```

   Uses `fs.promises.appendFile` (async) — `fs` is already imported at the top of KanbanProvider.ts.

5. **Call appender in `moveCardToColumn()`** when moving to CODE REVIEWED:
   ```typescript
   if (targetColumn === 'CODE REVIEWED') {
       await this._appendWorktreeContextToPlan(workspaceRoot, sessionId);
   }
   ```

6. **Call appender in `moveCardToColumnByPlanFile()`** similarly.

7. **Add optional cleanup after successful review**:
   ```typescript
   private async _cleanupWorktreeAfterReview(workspaceRoot: string, sessionId: string): Promise<void> {
       const db = this._getKanbanDb(workspaceRoot);
       if (!db || !await db.ensureReady()) return;

       const plan = await db.getPlanBySessionId(sessionId);
       if (!plan || !plan.worktreeId) return;

       const choice = await vscode.window.showWarningMessage(
           'Worktree used for this plan. Clean it up?',
           'Clean Up', 'Keep'
       );
       if (choice === 'Clean Up') {
           const worktree = await db.getWorktreeById(plan.worktreeId);
           if (worktree) {
               const execAsync = promisify(cp.exec);
               try {
                   await execAsync(`git worktree remove --force "${worktree.path}"`, { cwd: workspaceRoot });
                   await execAsync(`git branch -D "${worktree.branch}"`, { cwd: workspaceRoot });
                   await db.deleteWorktree(worktree.id);
               } catch (e: any) {
                   console.warn(`Failed to cleanup worktree: ${e.message}`);
               }
           }
       }

       await db.updatePlanWorktree(sessionId, null);
   }
   ```

8. **Call cleanup when plan moves to COMPLETED** (optional, based on user preference).

## Verification Plan

### Automated Tests
- TypeScript compilation must pass
- Existing unit tests must pass

### Manual Verification
- Create 3 worktrees with agents, bulk move 5 cards to CODER CODED — verify round-robin assignment (2-2-1 distribution)
- Move card with worktree to CODE REVIEWED — verify worktree context appended to plan file
- Move card to coder column with no worktrees — verify card assigned null worktree_id, coder works in main workspace
- Move plan to COMPLETED — verify cleanup prompt appears, worktree removed on cleanup
- Dispatch reviewer for plan with worktree context — verify reviewer can see worktree path in plan file

## Recommendation

**Complexity: 4 → Send to Coder**

Three focused additions to KanbanProvider: routing method, plan file appender, cleanup handler. Each is self-contained and follows existing patterns. The main gotcha is using `db.getBoard(workspaceId)` not the non-existent `db.getAllCards()`.

---

## Review Pass (2026-05-28)

### Stage 1: Grumpy Principal Engineer Findings

| # | Severity | Finding |
|---|----------|---------|
| 1 | **MAJOR** | `_appendWorktreeContextToPlan` uses `appendFile` with zero deduplication. If a card is moved to CODE REVIEWED more than once (back-and-forth on kanban), the plan file gets duplicate `## Worktree Context` sections. Kanban boards are designed for back-and-forth movement. |
| 2 | **MAJOR** | `_cleanupWorktreeAfterReview` calls `db.updatePlanWorktree(sessionId, null)` unconditionally — even when user clicks "Keep" or dismisses the dialog. This silently destroys the worktree association that `_appendWorktreeContextToPlan` just wrote into the plan file. Data integrity violation. |
| 3 | NIT | Plan spec used `cp.exec` with shell strings (shell injection risk). Implementation correctly uses `cp.execFile` with args array. Good deviation from plan — security improvement. |
| 4 | NIT | `_appendWorktreeContextToPlan` resolves worktree paths via `path.dirname(workspaceRoot)`, consistent with `createWorktree` (line 6145-6146). Fragile but consistent. |
| 5 | NIT | `moveCardToColumnByPlanFile` has inconsistent `_autoCommitIfCodeReviewTransition` guard vs `moveCardToColumn`. Pre-existing, not Plan C scope. |
| 6 | NIT | `_assignWorktreeToCard` early-returns when plan already has `worktreeId` — correct, prevents reassignment. |
| 7 | NIT | `getBoard` returns only `status = 'active'` plans — round-robin balance is based on active cards only, which is the desired behavior. |

### Stage 2: Balanced Synthesis — Fixes Applied

| Finding | Action | Status |
|---------|--------|--------|
| #1 (MAJOR): Duplicate append | Added idempotency check: read file first, skip if `## Worktree Context` section already exists | **Fixed** |
| #2 (MAJOR): Unconditional worktree_id null | Moved `updatePlanWorktree(sessionId, null)` inside the `if (choice === 'Clean Up')` block | **Fixed** |
| #3 (NIT): execFile vs exec | Keep as-is (implementation is better than plan) | No change needed |
| #4-7 (NIT) | Keep as-is | No change needed |

### Stage 3: Code Fixes Applied

**File: `src/services/KanbanProvider.ts`**

1. **`_appendWorktreeContextToPlan`** (line ~6502): Added idempotency guard before `appendFile`:
   ```typescript
   // Idempotency: skip if section already exists (card may be moved back and forth)
   try {
       const existing = await fs.promises.readFile(planPath, 'utf8');
       if (existing.includes('## Worktree Context')) return;
   } catch { /* file may not exist yet, proceed to append */ }
   ```

2. **`_cleanupWorktreeAfterReview`** (line ~6552): Moved `updatePlanWorktree(sessionId, null)` inside the `if (choice === 'Clean Up')` block. Added comment: "Only clear worktree association when user chose to clean up". Added trailing comment: "If user chose 'Keep' or dismissed the dialog, preserve the worktree association".

### Stage 4: Verification Results

- **TypeScript compilation**: 4 pre-existing errors (none in Plan C code). No new errors introduced by fixes.
  - `ClickUpSyncService.ts:2309` — import path (pre-existing)
  - `KanbanDatabase.ts:1363` — `lastInsertRowid` type (Plan B, pre-existing)
  - `KanbanProvider.ts:3706` — `autoCommitForCodeReview` missing (pre-existing)
  - `KanbanProvider.ts:4554` — import path (pre-existing)
- **Automated tests**: Skipped per session instructions (run separately).
- **Manual verification items**: All remain valid from original plan.

### Remaining Risks

1. **Race condition on worktree assignment**: Multiple simultaneous card moves could assign the same worktree. Mitigated by single-user context. Could add DB-level locking later if needed.
2. **`deleteWorktree` cascading clear**: `db.deleteWorktree(id)` also clears `worktree_id` on all referencing plans (line 1395). After the "Clean Up" path, `updatePlanWorktree(sessionId, null)` is technically redundant for the current plan but harmless — it ensures the specific plan is cleared even if the `deleteWorktree` cascade misses it (e.g., if the plan's worktree_id was already changed by another operation).
3. **Idempotency check is string-based**: `existing.includes('## Worktree Context')` could false-positive if a user manually writes that heading. Acceptable tradeoff — unlikely in practice.
