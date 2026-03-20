# Avoid "Notebook Plan" header for sidebar create plan

## Goal
Remove the "Notebook Plan" header when plans are initiated via the standard sidebar or Kanban "Create Plan" modal, as it is contextually inaccurate. The header should be retained only when creating a plan from the "Airlock" tab.

## User Review Required
> [!NOTE]
> This involves adding a new boolean flag to the Inter-Process Communication (IPC) message sent from the Webview UI to the extension host to correctly identify the origin of the plan.

## Complexity Audit
### Band A — Routine
- Adding the `isAirlock` flag to the webview's `submitInitiatePlan` payload.
- Updating the signature of `_createInitiatedPlan` and `_handleInitiatePlan` in `TaskViewerProvider.ts` to accept the new boolean flag.
- Conditionally inserting the `## Notebook Plan` string in the generated markdown template.

### Band B — Complex / Risky
- None.

## Edge-Case Audit
- **Race Conditions:** None. This is a synchronous template generation step during file creation.
- **Security:** None.
- **Side Effects:** If a user pastes a "full plan" containing `## Proposed Changes` or `## Goal`, the markdown template wrapper is bypassed entirely. This logic remains untouched to ensure full plans are still accepted verbatim.

## Adversarial Synthesis
### Grumpy Critique
Are we absolutely sure passing `isAirlock` as a boolean directly into the IPC message is robust enough? Webview message serialization sometimes stringifies everything. If it becomes `"true"` or `"false"` string, `!!data.isAirlock` will always be true! Also, modifying `_createInitiatedPlan` to take `isAirlock` means you have to update every single call site in the provider, otherwise TypeScript will scream at you!

### Balanced Response
Grumpy raises a fair point about IPC serialization, but VS Code's `postMessage` API safely serializes booleans using structured clone algorithm, so the boolean type is preserved. However, the point about updating call sites is critical. We must ensure that any other invocation of `_createInitiatedPlan` and `_handleInitiatePlan` is updated to pass the new boolean argument, possibly defaulting it to `false` to avoid breaking existing internal API usages.

## Proposed Changes

### `src/webview/implementation.html`
#### [MODIFY] `src/webview/implementation.html`
- **Context:** The `submitInitiatePlan` function currently dispatches the `initiatePlan` message with `title`, `idea`, and `mode`. 
- **Logic:** Add the existing local `_planModalFromAirlock` variable to the IPC payload so the backend knows exactly where the request originated.
- **Implementation:** Add `isAirlock: _planModalFromAirlock` to the `vscode.postMessage` object in `submitInitiatePlan`.
- **Edge Cases Handled:** The `_planModalFromAirlock` boolean is already strictly managed by the modal open/close lifecycle, ensuring it perfectly reflects the active tab.

### `src/services/TaskViewerProvider.ts`
#### [MODIFY] `src/services/TaskViewerProvider.ts`
- **Context:** The `_createInitiatedPlan` method hardcodes the `## Notebook Plan` header into the fallback markdown template.
- **Logic:** Extract `isAirlock` from the incoming IPC message, pass it down through `_handleInitiatePlan`, and conditionally inject the header text.
- **Implementation:** 
  1. Update `onDidReceiveMessage` for `initiatePlan` to read `data.isAirlock`.
  2. Update `_handleInitiatePlan` and `_createInitiatedPlan` signatures to accept `isAirlock: boolean`.
  3. Modify the template to `const headerText = isAirlock ? '## Notebook Plan\n\n' : '';` and inject it before `${idea}`.
- **Edge Cases Handled:** Safely handles falsy `data.isAirlock` values by casting to boolean `!!data.isAirlock` in the message router.

## Verification Plan
### Automated Tests
- None required for this string templating change.

### Manual Testing
1. Open the "Create Plan" modal using the `+` button in the Kanban board or the standard Sidebar.
2. Enter a plan title and idea, then click **SAVE PLAN**.
3. Open the newly generated `.md` file and verify it **does not** contain the `## Notebook Plan` header.
4. Navigate to the **Airlock** tab in the sidebar.
5. Paste text into the Airlock text area, fill out the title, and click **SAVE PLAN**.
6. Open the newly generated `.md` file and verify it **still has** the `## Notebook Plan` header.

---

## Appendix: Implementation Patch
```diff
--- src/webview/implementation.html
+++ src/webview/implementation.html
@@ -... +... @@
         let mode = action;
         if (_planModalFromAirlock) {
             mode = action === 'send' ? 'review' : 'local';
         }
         vscode.postMessage({
             type: 'initiatePlan',
             title,
             idea,
-            mode
+            mode,
+            isAirlock: _planModalFromAirlock
         });
         closeInitiatePlanModal();

--- src/services/TaskViewerProvider.ts
+++ src/services/TaskViewerProvider.ts
@@ -... +... @@
         case 'initiatePlan':
-            if (data.title && data.idea && data.mode) {
-                await this._handleInitiatePlan(data.title, data.idea, data.mode);
+            if (data.title && data.idea && data.mode) {
+                await this._handleInitiatePlan(data.title, data.idea, data.mode, !!data.isAirlock);
             }
             break;
@@ -... +... @@
-    private async _createInitiatedPlan(title: string, idea: string): Promise<{ sessionId: string; planFileAbsolute: string; }> {
+    private async _createInitiatedPlan(title: string, idea: string, isAirlock: boolean): Promise<{ sessionId: string; planFileAbsolute: string; }> {
         const workspaceFolders = vscode.workspace.workspaceFolders;
@@ -... +... @@
         try {
             const isFullPlan = idea.includes('## Proposed Changes') || idea.includes('## Goal');
+            const headerText = isAirlock ? '## Notebook Plan\n\n' : '';
             const content = isFullPlan
                 ? idea
-                : `# ${title}\n\n## Notebook Plan\n\n${idea}\n\n## Goal\n- Clarify expected outcome and scope.\n\n## Proposed Changes\n- TODO\n\n## Verification Plan\n- TODO\n\n## Open Questions\n- TODO\n`;
+                : `# ${title}\n\n${headerText}${idea}\n\n## Goal\n- Clarify expected outcome and scope.\n\n## Proposed Changes\n- TODO\n\n## Verification Plan\n- TODO\n\n## Open Questions\n- TODO\n`;
             await fs.promises.writeFile(planFileAbsolute, content, 'utf8');
@@ -... +... @@
-    private async _handleInitiatePlan(title: string, idea: string, mode: 'send' | 'copy' | 'local' | 'review') {
+    private async _handleInitiatePlan(title: string, idea: string, mode: 'send' | 'copy' | 'local' | 'review', isAirlock: boolean) {
         const trimmedTitle = title.trim();
@@ -... +... @@
         try {
-            const { sessionId, planFileAbsolute } = await this._createInitiatedPlan(trimmedTitle, trimmedIdea);
+            const { sessionId, planFileAbsolute } = await this._createInitiatedPlan(trimmedTitle, trimmedIdea, isAirlock);
             if (mode === 'local') {
```