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
