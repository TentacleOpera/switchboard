# Restore Dynamic Complexity Routing in Autoban Engine

## Goal
Restore the ability for the Autoban engine to dynamically route batched plans from `PLAN REVIEWED` to `CODED` based on their assessed complexity (Low → coder, High/Unknown → lead), fixing an architectural regression introduced during the batching transition.

## User Review Required
> [!NOTE]
> This changes the Autoban routing behavior so that it safely overrides the "CODED" column dropdown target in the UI if a plan's specific complexity dictates otherwise.
> [!WARNING]
> This introduces asynchronous file reading inside the Autoban background polling loop.

## Complexity Audit
### Band A — Routine
- Exposing the `_getComplexityFromPlan` helper in `src/services/KanbanProvider.ts` so it can be called publicly by the `TaskViewerProvider`.
### Band B — Complex / Risky
- Partitioning the batch array in `src/services/TaskViewerProvider.ts` (`_autobanTickColumn`), reading multiple plan files asynchronously without stalling the tick, and triggering sequential batch dispatch payloads safely.

## Edge-Case & Dependency Audit
- **Race Conditions:** If complexity parsing takes longer than the Autoban polling interval, the same card could be picked up twice. The existing `_activeDispatchSessions` set will mitigate this, provided we eagerly add IDs to the set *before* the async dispatch.
- **Security:** Path validation is already safely handled inside `getComplexityFromPlan`.
- **Side Effects:** Dispatching two separate batches (e.g., one to `coder`, one to `lead`) back-to-back might cause file lock contention in `SessionActionLog` or terminal locks. We must `await` the first dispatch completely before firing the second.
- **Dependencies & Conflicts:** This directly relies on `KanbanProvider` being instantiated and attached to `TaskViewerProvider` (via `setKanbanProvider`). If `_kanbanProvider` is missing, it must fall back safely to the static dropdown target.

## Adversarial Synthesis *(Challenge Reviewed: 2026-03-14)*

### Key Findings
- **CRIT-1**: Proposed patch reads each session JSON **twice per card** — once in the new routing block and once inside `handleKanbanBatchTrigger`. Eliminate by pre-resolving `planFile` in the card collection loop in `_autobanTickColumn` (lines 834–847) and passing it forward.
- **CRIT-2**: The patch diff is ambiguous about whether the original static dispatch block (`batch.forEach` / `const sessionIds` / `await handleKanbanBatchTrigger`) is deleted or left in place. The final implementation patch must explicitly delete those three lines.
- **MAJOR**: Splitting into two dispatches doubles the in-flight lock surface. Sessions added to `_activeDispatchSessions` before a failed dispatch are permanently locked until engine restart. Must remove on failure.

### Balanced Response
The plan is architecturally sound. The two CRITs must be resolved before coding begins. The double-read is correctable by threading `planFile` through the existing card struct. The locked-in-flight risk requires a simple return-value check after each `handleKanbanBatchTrigger` call.

### Challenge Review Action Plan
1. **[REQUIRED]** Pre-resolve `planFile` in the `_autobanTickColumn` card-collection loop; use it directly in the complexity routing block to eliminate the double JSON read.
2. **[REQUIRED]** Rewrite the implementation patch to explicitly **delete** the three original static dispatch lines (`batch.forEach`, `const sessionIds = ...`, `await this.handleKanbanBatchTrigger(role, sessionIds, instruction)`) and replace them with the new routing block.
3. **[RECOMMENDED]** Check the boolean return value of each `handleKanbanBatchTrigger` call; if `false`, remove those session IDs from `_activeDispatchSessions` so they can retry on the next tick.
4. **[RECOMMENDED]** Add a `console.log` before dispatches: `[Autoban] Complexity routing: ${lowSessions.length} → coder, ${highSessions.length} → lead`.

## Proposed Changes

### 1. Kanban Provider Backend
#### [MODIFY] `src/services/KanbanProvider.ts`
- **Context:** The `_getComplexityFromPlan` method currently contains exactly the logic we need, but is marked `private`.
- **Logic:** Change the method visibility from `private` to `public`.
- **Implementation:** `public async getComplexityFromPlan(workspaceRoot: string, planPath: string): Promise<'Unknown' | 'Low' | 'High'>`

### 2. Task Viewer Provider Backend
#### [MODIFY] `src/services/TaskViewerProvider.ts`
- **Context:** `_autobanTickColumn` statically resolves the target role for the entire batch upfront.
- **Logic:** Check if `sourceColumn === 'PLAN REVIEWED'`. If so, iterate over the `batch`. For each card, parse the session JSON to find the `planFile`, then call `this._kanbanProvider.getComplexityFromPlan()`. Partition IDs into `lowSessions` and `highSessions`. Sequentially `await this.handleKanbanBatchTrigger()` for both sets. 
- **Edge Cases Handled:** Includes a `try/catch` fallback to `highSessions` if any file read fails. Includes a fallback to static routing if `this._kanbanProvider` is undefined.

## Verification Plan
### Automated Tests
- Run `npm run compile` to verify TypeScript interfaces compile cleanly after visibility changes.

### Manual Testing
1. Create 3 distinct plan files and run them to the `PLAN REVIEWED` column:
   - Plan A: Includes `### Band B — Complex / Risky \n - None.`
   - Plan B: Includes `### Band B — Complex / Risky \n - Database migration.`
   - Plan C: A blank plan with no complexity audit section.
2. In the Autoban sidebar, set the Global Batch Size to `3` and enable the engine.
3. Observe the terminal output and runsheets:
   - Verify Plan A is batched and dispatched to the **Coder** terminal.
   - Verify Plan B and Plan C are batched together and dispatched to the **Lead Coder** terminal.

## Appendix: Implementation Patch
```diff
--- src/services/KanbanProvider.ts
+++ src/services/KanbanProvider.ts
@@ -... +... @@
-    private async _getComplexityFromPlan(workspaceRoot: string, planPath: string): Promise<'Unknown' | 'Low' | 'High'> {
+    public async getComplexityFromPlan(workspaceRoot: string, planPath: string): Promise<'Unknown' | 'Low' | 'High'> {
         try {
             if (!planPath) return 'Unknown';
--- src/services/TaskViewerProvider.ts
+++ src/services/TaskViewerProvider.ts
@@ -... +... @@
         const instruction = this._autobanColumnToInstruction(sourceColumn);
 
+        // Dynamic Complexity Routing for PLAN REVIEWED -> CODED
+        if (sourceColumn === 'PLAN REVIEWED' && this._kanbanProvider) {
+            const lowSessions: string[] = [];
+            const highSessions: string[] = [];
+
+            for (const card of batch) {
+                const sessionPath = path.join(workspaceRoot, '.switchboard', 'sessions', `${card.sessionId}.json`);
+                try {
+                    const sessionContent = await fs.promises.readFile(sessionPath, 'utf8');
+                    const session = JSON.parse(sessionContent);
+                    if (session.planFile) {
+                        const complexity = await this._kanbanProvider.getComplexityFromPlan(workspaceRoot, session.planFile);
+                        if (complexity === 'Low') {
+                            lowSessions.push(card.sessionId);
+                        } else {
+                            highSessions.push(card.sessionId);
+                        }
+                    } else {
+                        highSessions.push(card.sessionId);
+                    }
+                } catch {
+                    highSessions.push(card.sessionId);
+                }
+            }
+
+            // Dispatch sequentially to avoid file and terminal locks
+            if (lowSessions.length > 0) {
+                lowSessions.forEach(id => this._activeDispatchSessions.add(id));
+                await this.handleKanbanBatchTrigger('coder', lowSessions, instruction);
+            }
+            if (highSessions.length > 0) {
+                highSessions.forEach(id => this._activeDispatchSessions.add(id));
+                await this.handleKanbanBatchTrigger('lead', highSessions, instruction);
+            }
+            return;
+        }
+
+        // Default Static Routing
         batch.forEach(c => this._activeDispatchSessions.add(c.sessionId));
         const sessionIds = batch.map(c => c.sessionId);
```