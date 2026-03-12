# Kanban Complexity UI and Auto-Move Routing

## Goal
Prefix the complexity label on Kanban cards with "Complexity: " for better UI clarity. Additionally, dynamically route auto-move operations heading into the "CODED" column based on the plan's specific complexity (Low -> coder, High/Unknown -> lead coder).

## User Review Required
> [!NOTE]
> Manual drag-and-drop operations into the "CODED" column will continue to respect the UI dropdown target. The dynamic complexity-based routing will specifically apply to the timed Auto-Move pipeline.

## Complexity Audit
### Band A — Routine
- Modify the string template in `src/webview/kanban.html` to inject the "Complexity: " prefix.

### Band B — Complex / Risky
- Refactor `_autoMoveOneCard` in `src/services/KanbanProvider.ts` to asynchronously evaluate the target card's complexity before determining the dispatch role and enforcing role readiness.

## Edge-Case Audit
- **Race Conditions:** `_autoMoveOneCard` currently resolves roles and checks agent readiness *before* evaluating the queue. Shifting this check after determining the specific card could theoretically race with another file change, but using the existing `_getComplexityFromPlan` helper ensures we safely parse the latest file state on disk before dispatch.
- **Security:** No new attack vectors. File paths are already validated by the existing `_getComplexityFromPlan` and `triggerAgentFromKanban` pipelines.
- **Side Effects:** If the user has explicitly set the "CODED" column dropdown to "Coder" but the top card is "High" complexity, the auto-move will safely override the UI dropdown and dispatch to "Lead Coder", respecting the architecture rule.

## Adversarial Synthesis
### Grumpy Critique
You're only updating `_autoMoveOneCard` to check complexity? You realize `_autoMoveOneCard` currently does a fake synchronous `_sheetToCard` mapping without awaiting complexity! If you just use `topCard.complexity`, it will ALWAYS be 'Unknown'! Plus, if you change the `targetRole` halfway through the function, the initial `_canAssignRole` check at the very top of the function will check the wrong role and block the auto-move entirely! 

### Balanced Response
Grumpy is completely correct regarding the order of operations and the synchronous nature of the temporary card map in `_autoMoveOneCard`. We cannot rely on the `topCard.complexity` property derived from the synchronous map. Instead, we must pause, identify the top card, explicitly `await this._getComplexityFromPlan(workspaceRoot, topCard.planFile)`, derive the true `targetRole`, and *only then* execute `_canAssignRole()`. The plan has been structured to handle this exact execution order.

## Enhancement Notes (Added by Reviewer)
- **Bug Fix in Diff:** The original diff had `const workspaceRoot = workspaceFolders.uri.fsPath;` which is invalid because `workspaceFolders` is an array. It must be `workspaceFolders[0].uri.fsPath;`.
- **Bug Fix in Diff:** The original diff assigned `const topCard = columnCards;` which incorrectly assigns an array instead of the first element. It has been corrected to `const topCard = columnCards[0];`.
- **Diff Logic Refinement:** Ensured that `let targetRole = role;` is set initially to maintain backward compatibility, overriding it ONLY if `nextCol === 'CODED'`.

## Proposed Changes

### Kanban Webview Frontend
#### [MODIFY] `src/webview/kanban.html`
- **Context:** The current complexity tags ("High", "Low", "Unknown") lack context, making them difficult to decipher at a glance.
- **Logic:** Update the `createCardHtml` template string to prepend "Complexity: " to the `${complexity}` injection.
- **Implementation:** Modify the `.card-meta` div inside the `createCardHtml` function.
- **Edge Cases Handled:** The CSS class `${complexityClass}` handles the coloring independently of the displayed text, meaning adding the prefix won't break the color-coding.

### Kanban Provider Backend
#### [MODIFY] `src/services/KanbanProvider.ts`
- **Context:** The auto-move timer rigidly sends cards to whatever role is currently selected in the "CODED" column dropdown, ignoring the structural complexity of the plan.
- **Logic:** Defer the `_columnToRole` and `_canAssignRole` checks until after the oldest `topCard` in the source column is identified. If moving into the `CODED` column, read the plan's complexity from the file system. Route 'Low' to `coder` and 'High' / 'Unknown' to `lead`.
- **Implementation:** Reorder the validation steps in `_autoMoveOneCard`. Use the `_getComplexityFromPlan` helper on the `topCard.planFile`.
- **Edge Cases Handled:** By computing complexity only for the single `topCard` on the fly, we prevent expensive disk I/O loops that would occur if we tried to compute complexity for every card in the column simultaneously.

## Verification Plan
### Automated Tests
- Run `npm run compile` to verify TypeScript signatures and compilation.
### Manual Testing
1. Open the Switchboard sidebar and navigate to the CLI-BAN.
2. Verify all cards display `Complexity: Unknown`, `Complexity: Low`, or `Complexity: High`.
3. Create a **Low** complexity plan and a **High** complexity plan, and place both in the "PLAN REVIEWED" column.
4. Set the auto-move timer to 1 minute for the "PLAN REVIEWED" column and click START.
5. Verify that when the Low complexity card moves to "CODED", the `coder` terminal is dispatched.
6. Verify that when the High complexity card moves to "CODED", the `lead coder` terminal is dispatched.

---

## Appendix: Implementation Patch

```diff
--- src/webview/kanban.html
+++ src/webview/kanban.html
@@ -1381,7 +1381,7 @@
     else if (card.column === 'CODED') copyLabel = 'Copy Prompt';
     return `
     <div class="kanban-card" draggable="true" data-session="${card.sessionId}">
         <div class="card-topic" title="${escapeHtml(card.topic)}">${escapeHtml(shortTopic)}</div>
-        <div class="card-meta"><span class="complexity-indicator ${complexityClass}">${complexity}</span> · ${timeAgo}</div>
+        <div class="card-meta"><span class="complexity-indicator ${complexityClass}">Complexity: ${complexity}</span> · ${timeAgo}</div>
         <div class="card-actions">
             <button class="card-btn copy" data-session="${card.sessionId}">${copyLabel}</button>
--- src/services/KanbanProvider.ts
+++ src/services/KanbanProvider.ts
@@ -604,14 +604,9 @@
         const role = this._columnToRole(nextCol);
         if (!role) return false;
 
         // Get current cards
         const workspaceFolders = vscode.workspace.workspaceFolders;
         if (!workspaceFolders) return false;
-        const workspaceRoot = workspaceFolders[0].uri.fsPath;
-        if (!(await this._canAssignRole(workspaceRoot, role))) {
-            return false;
-        }
+        const workspaceRoot = workspaceFolders[0].uri.fsPath;
 
         const log = this._getSessionLog(workspaceRoot);
         const sheets = await log.getRunSheets();
@@ -624,9 +619,19 @@
 
         if (columnCards.length === 0) return false;
 
         const topCard = columnCards[0];
-        const instruction = role === 'planner' ? 'enhance' : undefined;
-        await vscode.commands.executeCommand('switchboard.triggerAgentFromKanban', role, topCard.sessionId, instruction);
+
+        let targetRole = role;
+        if (nextCol === 'CODED') {
+            const topCardComplexity = await this._getComplexityFromPlan(workspaceRoot, topCard.planFile);
+            targetRole = topCardComplexity === 'Low' ? 'coder' : 'lead';
+        }
+
+        if (!(await this._canAssignRole(workspaceRoot, targetRole))) {
+            return false;
+        }
+
+        const instruction = targetRole === 'planner' ? 'enhance' : undefined;
+        await vscode.commands.executeCommand('switchboard.triggerAgentFromKanban', targetRole, topCard.sessionId, instruction);
         return true;
     }
```
