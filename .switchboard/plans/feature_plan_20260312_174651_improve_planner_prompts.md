### Ensure Planner Agent Executes Full Complexity Audit

#### Goal
Thread the `'enhance'` instruction through the Kanban column transition and copy commands to ensure the planner agent always performs a full complexity audit (Band A/Band B breakdown) when a plan is moved to `PLAN REVIEWED` or copied from `CREATED`.

#### User Review Required
> [!NOTE]
> This change aligns the Kanban board's routing behavior with the intended default behavior of the Planner agent in the Orchestrator, but will result in slightly longer processing times when dragging items into `PLAN REVIEWED` due to the more rigorous structural analysis.

#### Complexity Audit
##### Band A — Routine
* Update `src/extension.ts` to accept an optional `instruction` parameter in the `switchboard.triggerAgentFromKanban` command.
* Update `TaskViewerProvider.handleKanbanTrigger` signature to pass the instruction to `_handleTriggerAgentAction`.
* Update `KanbanProvider._handleMessage` (for drag-and-drop) and `KanbanProvider._autoMoveOneCard` (for automated timers) to pass `'enhance'` when the role is `'planner'`.
* Update `TaskViewerProvider._handleCopyPlanLink` to explicitly request the `.agent/workflows/enhance.md` workflow when copying from the `CREATED` column.
##### Band B — Complex / Risky
* None.

#### Edge-Case Audit
* **Race Conditions:** None.
* **Security:** None.
* **Side Effects:** Plans dragged to `PLAN REVIEWED` will now properly trigger the deep structural audit instead of a light review. This matches the behavior of the auto-orchestrator.

#### Adversarial Synthesis
##### Grumpy Critique
Why are we hardcoding `'enhance'` for the planner specifically inside the Kanban provider? What if a user just wants a quick review from the board? Also, tweaking the copy string is just piling on more prompt bloat. If the default `instruction: undefined` payload for the planner is wrong, fix the fallback in `TaskViewerProvider.ts` instead of modifying three different files!

##### Balanced Response
Grumpy has a fair point about the default behavior. However, the system architecture explicitly separates `enhance` (deep structural rewrite) from a light `review`. The Orchestrator and the Sidebar `IMPROVE PLAN` button explicitly pass `instruction: 'enhance'` to get the desired behavior. It is semantically correct for the Kanban board's `PLAN REVIEWED` transition (which serves as the primary plan-improvement gate) to explicitly declare the `'enhance'` intent, just as the other orchestration tools do. Adding the workflow directive to the copy button ensures cross-IDE parity.

#### Proposed Changes
##### `src/extension.ts`
###### [MODIFY] `src/extension.ts`
* Update the `switchboard.triggerAgentFromKanban` command registration to accept an `instruction?: string` parameter and pass it into `taskViewerProvider.handleKanbanTrigger`.

##### `src/services/TaskViewerProvider.ts`
###### [MODIFY] `src/services/TaskViewerProvider.ts`
* Update `handleKanbanTrigger` to accept an `instruction?: string` parameter and thread it into `_handleTriggerAgentAction`.
* In `_handleCopyPlanLink`, modify the `promptToCopy` for `column === 'CREATED'` to explicitly instruct the agent to run the `enhance.md` workflow and break the plan into high/low complexity tasks.

##### `src/services/KanbanProvider.ts`
###### [MODIFY] `src/services/KanbanProvider.ts`
* In `_handleMessage` (under the `triggerAction` case), assign `instruction = 'enhance'` if the `role` evaluates to `'planner'` and append it to the `executeCommand` call.
* In `_autoMoveOneCard`, apply the same `'enhance'` instruction logic before dispatching the `triggerAgentFromKanban` command.

#### Verification Plan
##### Automated Tests
* Run `npm run compile` to verify TypeScript signatures are correctly aligned across the three files.
##### Manual Testing
1. Drag a generic plan from `CREATED` to `PLAN REVIEWED` in the Kanban view.
2. Verify the planner agent starts the `enhance.md` workflow and produces a complexity audit (Band A / Band B).
3. Click `Copy Prompt` on a card in the `CREATED` column, paste it, and verify it explicitly asks the agent to execute the `.agent/workflows/enhance.md` workflow.

#### Appendix: Implementation Patch
```diff
--- src/extension.ts
+++ src/extension.ts
@@ -... +... @@
-const triggerFromKanbanDisposable = vscode.commands.registerCommand('switchboard.triggerAgentFromKanban', async (role: string, sessionId: string) => {
-    taskViewerProvider.handleKanbanTrigger(role, sessionId);
+const triggerFromKanbanDisposable = vscode.commands.registerCommand('switchboard.triggerAgentFromKanban', async (role: string, sessionId: string, instruction?: string) => {
+    taskViewerProvider.handleKanbanTrigger(role, sessionId, instruction);
 });
--- src/services/TaskViewerProvider.ts
+++ src/services/TaskViewerProvider.ts
@@ -... +... @@
-public async handleKanbanTrigger(role: string, sessionId: string) {
-    await this._handleTriggerAgentAction(role, sessionId);
+public async handleKanbanTrigger(role: string, sessionId: string, instruction?: string) {
+    await this._handleTriggerAgentAction(role, sessionId, instruction);
 }
@@ -... +... @@
 if (column === 'CREATED') {
-    promptToCopy = `Please review and enhance the following plan:\n\n${markdownLink}`;
+    promptToCopy = `Please review and enhance the following plan. Execute the .agent/workflows/enhance.md workflow to break it down into distinct steps grouped by high complexity and low complexity:\n\n${markdownLink}`;
 } else if (column === 'PLAN REVIEWED') {
--- src/services/KanbanProvider.ts
+++ src/services/KanbanProvider.ts
@@ -... +... @@
 case 'triggerAction': {
     const { sessionId, targetColumn } = msg;
     const role = this._columnToRole(targetColumn);
     if (role) {
         const workspaceFolders = vscode.workspace.workspaceFolders;
         if (workspaceFolders) {
             const workspaceRoot = workspaceFolders[0].uri.fsPath;
             if (!(await this._canAssignRole(workspaceRoot, role))) {
                 break;
             }
         }
+        const instruction = role === 'planner' ? 'enhance' : undefined;
-        await vscode.commands.executeCommand('switchboard.triggerAgentFromKanban', role, sessionId);
+        await vscode.commands.executeCommand('switchboard.triggerAgentFromKanban', role, sessionId, instruction);
     }
     break;
 }
@@ -... +... @@
 private async _autoMoveOneCard(sourceColumn: string): Promise<boolean> {
 ...
     if (columnCards.length === 0) return false;
     const topCard = columnCards[0];
+    const instruction = role === 'planner' ? 'enhance' : undefined;
-    await vscode.commands.executeCommand('switchboard.triggerAgentFromKanban', role, topCard.sessionId);
+    await vscode.commands.executeCommand('switchboard.triggerAgentFromKanban', role, topCard.sessionId, instruction);
     return true;
 }
```

## Reviewer-Executor Pass (2026-03-12)

### Findings Summary
- CRITICAL: None.
- MAJOR: None.
- NIT: The Kanban command path still relies on the string literal `'enhance'` as an instruction token. That is somewhat brittle, but it is consistent with the existing architecture and explicitly accepted by the plan’s balanced synthesis.

### Plan Requirement Check
- [x] `extension.ts` accepts and forwards an optional `instruction` argument for `switchboard.triggerAgentFromKanban`.
- [x] `TaskViewerProvider.handleKanbanTrigger` accepts the optional instruction and threads it into `_handleTriggerAgentAction`.
- [x] `KanbanProvider.ts` sends `instruction = 'enhance'` for planner dispatches during drag/drop and auto-move.
- [x] The `CREATED` column copy prompt explicitly references `.agent/workflows/enhance.md` and the high/low complexity breakdown.

### Fixes Applied
- No additional code fix was required in this reviewer pass. The implementation already satisfied the approved plan.
- Replaced the corrupted tail of this plan file with a clean reviewer-executor section so the archived source-of-truth artifact is readable again.

### Files Changed in This Reviewer Pass
- `C:\Users\patvu\Documents\GitHub\switchboard\.switchboard\plans\feature_plan_20260312_174651_improve_planner_prompts.md`

### Validation Results
- `npx tsc -p . --noEmit`: PASS (exit code `0`).
- `npm run compile`: PASS (webpack completed successfully).

### Remaining Risks
- Manual end-to-end verification is still required to confirm cards moved into `PLAN REVIEWED` trigger the planner’s `enhance` workflow in the live agent flow.
- The instruction vocabulary remains stringly typed; if the internal contract changes, these call sites must be updated together.
