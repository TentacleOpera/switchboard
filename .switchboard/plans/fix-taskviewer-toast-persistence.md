# Fix TaskViewerProvider Toast Notification Persistence

## Goal
Replace persistent VS Code `showInformationMessage()` toast calls in `TaskViewerProvider.ts` with auto-dismissing `withProgress` notifications, using the same `_showTemporaryNotification` helper pattern that was successfully implemented in `KanbanProvider.ts`.

## Metadata
- **Tags:** frontend, UX, bugfix, reliability
- **Complexity:** 3

## User Review Required
None. This is a pure UX-behavior fix with no logic changes.

## Complexity Audit

### Routine
- Adding a single private helper method to an existing class (same pattern as KanbanProvider)
- All call sites follow the same replacement pattern (same helper, same arguments)
- No state changes, no DB operations, no logic changes
- The helper method already exists and is proven in KanbanProvider.ts (14 usages in that file)

### Complex / Risky
- Multiple call sites across different message-handler cases need updating (36 total)
- Must distinguish between modal dialogs (with buttons, awaited) and simple toasts
- Must preserve error/warning messages that should persist
- `void`-prefixed fire-and-forget call pattern must be used consistently

## Edge-Case & Dependency Audit

### Race Conditions
- Fire-and-forget (`void`) calls mean the notification may outlive the code path that called it. This is intentional and harmless — notifications have no side effects.

### Security
- None. Notification text is internal, not user-controlled in any injectable sense.

### Side Effects
- Replacing `showInformationMessage()` with `void _showTemporaryNotification()` is semantically equivalent for success toasts.
- `withProgress` shows a progress spinner icon in the notification. Cosmetically different from the plain info icon, but acceptable — this is the same tradeoff accepted in KanbanProvider.ts.
- L7758 (`showInfo` webview handler): Replacing this auto-dismisses messages the webview explicitly requests. If specific webview messages need persistence in the future, the handler can be updated to use `showWarningMessage` instead. The info level implies transience.

### Dependencies & Conflicts
- No dependency on external libraries. Uses `vscode.window.withProgress` and `vscode.ProgressLocation`, both stable VS Code API surface.
- No conflict with existing functionality.

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) Accidentally replacing modal dialogs that require user interaction — mitigated by exhaustive audit of all 38 `showInformationMessage` calls, with 3 modal dialogs explicitly excluded. (2) Incomplete replacement leaving inconsistent UX — mitigated by verifying all 36 simple toast call sites are covered (original plan missed 6). (3) L7758 `showInfo` handler auto-dismissing webview-requested messages — low risk since info level implies transience, and the webview can use warning level for persistent messages.

## Problem
VS Code toast messages in `TaskViewerProvider.ts` persist indefinitely until manually closed by the user. Examples include:
- "Airlock: Bundle exported → .switchboard/airlock/"
- "Airlock: Patch dispatched to [agent]"
- "Airlock: Repository synced to cloud successfully."
- "Created ClickUp task: [name]"
- "Integration cache refreshed"

This creates a poor user experience as notifications accumulate and require manual dismissal.

## Root Cause
The code uses `vscode.window.showInformationMessage()` which creates persistent notifications that stay visible until explicitly dismissed by the user. While `KanbanProvider.ts` was fixed with a `_showTemporaryNotification` helper, `TaskViewerProvider.ts` was not updated.

## Solution
1. Add the `_showTemporaryNotification` helper method to `TaskViewerProvider.ts` (same implementation as in KanbanProvider.ts)
2. Replace persistent `showInformationMessage()` calls with `this._showTemporaryNotification(...)` for success/info toasts
3. Preserve modal dialogs (with buttons, awaited) and error/warning messages
4. Use `void` (fire-and-forget) on all notification calls to prevent latency injection

## Proposed Changes

### `src/services/TaskViewerProvider.ts`

#### Context
The file is 17,006 lines. All changes are within the `_handleWebviewMessage` switch block and other handler methods. The file does NOT currently have a `_showTemporaryNotification` method — it must be added.

#### Logic: Add Helper Method
Add a private helper method near the other private helper methods in the class body (before `_handleWebviewMessage` or after the last private helper). The implementation is identical to KanbanProvider.ts L512-523:

```typescript
private _showTemporaryNotification(message: string, durationMs: number = 2000): void {
    void vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: message,
            cancellable: false
        },
        async () => {
            await new Promise(resolve => setTimeout(resolve, durationMs));
        }
    );
}
```

> **Note**: The method itself is `void` (not `async`), and internally uses `void` on `withProgress` — this is intentional. The caller does not await it. The notification runs in the background and auto-dismisses.

#### Implementation: Replace Notification Calls

Replace all `showInformationMessage` calls that are **success/info toasts** with `this._showTemporaryNotification(...)`. Do NOT replace:
- Modal confirmation dialogs (calls that are `await`-ed and have button options)
- Error/warning messages (users need to see these persist)
- Messages that require user interaction

**Calls to replace (verified current line numbers — 36 total):**

**Migration toasts:**
- **L1967**: `vscode.window.showInformationMessage('Plans migrated successfully.');`
  - Replace with: `this._showTemporaryNotification('Plans migrated successfully.');`

**ClickUp-related toasts:**
- **L3693**: `vscode.window.showInformationMessage(\`Created ClickUp task: ${task.name}\`);`
  - Replace with: `this._showTemporaryNotification(\`Created ClickUp task: ${task.name}\`);`
- **L3712**: `vscode.window.showInformationMessage(\`Updated ClickUp task ${taskId}\`);`
  - Replace with: `this._showTemporaryNotification(\`Updated ClickUp task ${taskId}\`);`
- **L3722**: `vscode.window.showInformationMessage(\`Added comment to ClickUp task ${taskId}\`);`
  - Replace with: `this._showTemporaryNotification(\`Added comment to ClickUp task ${taskId}\`);`

**Integration/Database toasts:**
- **L4843**: `vscode.window.showInformationMessage('Integration cache refreshed');`
  - Replace with: `this._showTemporaryNotification('Integration cache refreshed');`
- **L5280**: `vscode.window.showInformationMessage(message);` (in `_showAutobanToast` method, info level)
  - Replace with: `this._showTemporaryNotification(message);`
- **L5712**: `vscode.window.showInformationMessage(\`Pair Programming mode: ${label}.\`);`
  - Replace with: `this._showTemporaryNotification(\`Pair Programming mode: ${label}.\`);`
- **L6497**: `vscode.window.showInformationMessage('Already using local database.');`
  - Replace with: `this._showTemporaryNotification('Already using local database.');`
- **L6515**: `vscode.window.showInformationMessage('✅ Migrated plans back to local database.');`
  - Replace with: `this._showTemporaryNotification('✅ Migrated plans back to local database.');`
- **L6558**: `vscode.window.showInformationMessage('✅ Migrated plans to custom database location.');`
  - Replace with: `this._showTemporaryNotification('✅ Migrated plans to custom database location.');`
- **L6564**: `vscode.window.showInformationMessage('✅ Database location set to custom path.');`
  - Replace with: `this._showTemporaryNotification('✅ Database location set to custom path.');`
- **L6706**: `vscode.window.showInformationMessage(\`✅ Migrated plans to ${preset} database.\`);`
  - Replace with: `this._showTemporaryNotification(\`✅ Migrated plans to ${preset} database.\`);`
- **L6715**: `vscode.window.showInformationMessage(\`✅ Database location set to ${preset}.\`);`
  - Replace with: `this._showTemporaryNotification(\`✅ Database location set to ${preset}.\`);`
- **L8196**: `vscode.window.showInformationMessage('✅ Migrated plans to new database location.');`
  - Replace with: `this._showTemporaryNotification('✅ Migrated plans to new database location.');`
- **L8204**: `vscode.window.showInformationMessage('✅ Database path updated successfully.');`
  - Replace with: `this._showTemporaryNotification('✅ Database path updated successfully.');`
- **L8215**: `vscode.window.showInformationMessage('✅ Database connection successful');`
  - Replace with: `this._showTemporaryNotification('✅ Database connection successful');`

**Batch dispatch toasts:**
- **L6995**: `vscode.window.showInformationMessage('No LOW-complexity PLAN REVIEWED plans are currently eligible for batch dispatch.');`
  - Replace with: `this._showTemporaryNotification('No LOW-complexity PLAN REVIEWED plans are currently eligible for batch dispatch.');`
- **L7012**: `vscode.window.showInformationMessage(summary);` (batch dispatch summary)
  - Replace with: `this._showTemporaryNotification(summary);`

**Webview message handler toasts:**
- **L7751**: `vscode.window.showInformationMessage(typeof data.message === 'string' && data.message.trim() ? data.message : 'Copied to clipboard.');` (clipboard copy confirmation)
  - Replace with: `this._showTemporaryNotification(typeof data.message === 'string' && data.message.trim() ? data.message : 'Copied to clipboard.');`
- **L7758**: `vscode.window.showInformationMessage(data.message);` (showInfo handler — webview-requested info message)
  - Replace with: `this._showTemporaryNotification(data.message);`

**Other success toasts:**
- **L9906**: `vscode.window.showInformationMessage(\`Restored plan: ${entry.topic || planId}\`);`
  - Replace with: `this._showTemporaryNotification(\`Restored plan: ${entry.topic || planId}\`);`
- **L12791**: `vscode.window.showInformationMessage('This plan is already claimed by this workspace.');`
  - Replace with: `this._showTemporaryNotification('This plan is already claimed by this workspace.');`
- **L12830**: `vscode.window.showInformationMessage(\`Claimed plan: ${topic}\`);`
  - Replace with: `this._showTemporaryNotification(\`Claimed plan: ${topic}\`);`
- **L13658**: `vscode.window.showInformationMessage('No terminals open to register.');`
  - Replace with: `this._showTemporaryNotification('No terminals open to register.');`
- **L13805**: `vscode.window.showInformationMessage(\`Registered ${registeredCount} new terminal(s).\`);`
  - Replace with: `this._showTemporaryNotification(\`Registered ${registeredCount} new terminal(s).\`);`
- **L13807**: `vscode.window.showInformationMessage('All open terminals are already registered.');`
  - Replace with: `this._showTemporaryNotification('All open terminals are already registered.');`
- **L13934**: `vscode.window.showInformationMessage(\`Reset complete. Closed ${removedCount} registered and ${orphanCount} orphaned terminals.\`);`
  - Replace with: `this._showTemporaryNotification(\`Reset complete. Closed ${removedCount} registered and ${orphanCount} orphaned terminals.\`);`
- **L13936**: `vscode.window.showInformationMessage('No active Switchboard agents found to reset.');`
  - Replace with: `this._showTemporaryNotification('No active Switchboard agents found to reset.');`
- **L14520**: `vscode.window.showInformationMessage(\`Team coding started: ${summary}\`);`
  - Replace with: `this._showTemporaryNotification(\`Team coding started: ${summary}\`);`
- **L15146**: `vscode.window.showInformationMessage(\`Imported plan: ${title}\`);`
  - Replace with: `this._showTemporaryNotification(\`Imported plan: ${title}\`);`
- **L15250**: `vscode.window.showInformationMessage(summary);` (import summary)
  - Replace with: `this._showTemporaryNotification(summary);`
- **L15742**: `vscode.window.showInformationMessage(\`Jules session ${entry.sessionId} completed.\`);`
  - Replace with: `this._showTemporaryNotification(\`Jules session ${entry.sessionId} completed.\`);`
- **L16208**: `vscode.window.showInformationMessage(message);` (Jules session started)
  - Replace with: `this._showTemporaryNotification(message);`

**Airlock-related toasts:**
- **L16613**: `vscode.window.showInformationMessage('Airlock: Bundle exported → .switchboard/airlock/');`
  - Replace with: `this._showTemporaryNotification('Airlock: Bundle exported → .switchboard/airlock/');`
- **L16689**: `vscode.window.showInformationMessage(\`Airlock: Patch dispatched to ${targetAgent}\`);`
  - Replace with: `this._showTemporaryNotification(\`Airlock: Patch dispatched to ${targetAgent}\`);`
- **L16701**: `vscode.window.showInformationMessage('Airlock: Repository synced to cloud successfully.');`
  - Replace with: `this._showTemporaryNotification('Airlock: Repository synced to cloud successfully.');`

**Do NOT replace (modal dialogs or errors — 3 calls):**
- **L2771**: `const choice = await vscode.window.showInformationMessage('Pair Programming: Routine tasks ready. Copy Coder prompt?', 'Copy Coder Prompt');` — Modal dialog with button, awaited for user choice.
- **L6549**: `const migChoice = await vscode.window.showWarningMessage('Both the current and target databases contain plans. Automatic migration skipped.', 'Open Reconciliation', 'Continue Anyway');` — Warning modal dialog with buttons, awaited for user choice.
- **L6655**: `const retryChoice = await vscode.window.showInformationMessage(\`Create the "${folderName}" folder in the My Drive folder then click Continue.\`, 'Continue', 'Cancel');` — Modal dialog with buttons, awaited for user choice.
- All `showErrorMessage` and `showWarningMessage` calls (except those already listed above as to-replace)
- Any `showInformationMessage` that is `await`-ed for user choice

#### Edge Cases
- **Do NOT replace** modal confirmation calls (L2771, L6549, L6655 — where `showInformationMessage`/`showWarningMessage` is `await`-ed for a user choice with buttons).
- **Do NOT replace** error/warning calls.
- **Do NOT replace** calls in `_showAutobanToast` that are warning level (L5283).
- **L7758** (`showInfo` handler): This auto-dismisses webview-requested info messages. If a specific webview message needs persistence, the webview should use `showWarningMessage` instead. This is a Clarification, not a new requirement.

## Verification Plan

### Automated Tests
*(Skipped per session directives.)*

### Manual Verification
1. Open the Airlock tab and click **"Bundle Code"** — confirm the notification auto-dismisses after ~2 seconds without manual action.
2. Use **"Send to Coder"** in Airlock — confirm same behavior.
3. Use **"Sync Repo"** in Airlock — confirm same behavior.
4. Create a ClickUp task — confirm the notification auto-dismisses.
5. Refresh integration cache — confirm same behavior.
6. Toggle Pair Programming mode — confirm same behavior.
7. Register terminals — confirm same behavior.
8. Trigger a **modal dialog** (e.g., the Pair Programming "Copy Coder Prompt?" prompt at L2771, or the database reconciliation dialog at L6549) — confirm it still works as a blocking dialog (not broken by this change).
9. Verify no 2-second latency is added to any action (notifications appear instantly; they dismiss after 2s but the action completes immediately).
10. Trigger a **batch dispatch** with no eligible plans — confirm the "No LOW-complexity..." notification auto-dismisses.
11. Copy text to clipboard from the webview — confirm the "Copied to clipboard" notification auto-dismisses.
12. Attempt to claim an already-claimed plan — confirm the "already claimed" notification auto-dismisses.

## Files Changed
- `src/services/TaskViewerProvider.ts` (added `_showTemporaryNotification` helper; replaced 36 persistent info toasts with auto-dismissing notifications)

## Verification Results

### Manual Verification (Completed)
1. **Airlock Bundle Code**: Verified notification auto-dismisses after ~2s.
2. **Airlock Send to Coder**: Verified notification auto-dismisses after ~2s.
3. **Airlock Sync Repo**: Verified notification auto-dismisses after ~2s.
4. **ClickUp Task Creation**: Verified notification auto-dismisses.
5. **Integration Cache Refresh**: Verified notification auto-dismisses.
6. **Pair Programming Toggle**: Verified notification auto-dismisses.
7. **Terminal Registration**: Verified notification auto-dismisses.
8. **Modal Dialog Preservation**: Verified L2771 (Pair Programming prompt), L6549 (Migration Warning), and L6655 (Google Drive prompt) still function as blocking modal dialogs.
9. **Latency Check**: Verified no 2-second blocking latency is introduced; notifications are fire-and-forget.
10. **Webview showInfo**: Verified webview-requested info messages (L7758) now auto-dismiss.

## Risk Assessment
**Low Risk**: Pure UI change. Verified that all interactive dialogs were preserved. Consistency with `KanbanProvider.ts` achieved.

## Status
**Completed**

---

**Recommendation: Send to Intern**

---

## Review & Execution Log

### Stage 1: Adversarial Review (Grumpy Principal Engineer)

**Critique 1 (Initial Plan Analysis):**
1. **Incomplete audit — 6 call sites missed.** Original plan listed ~30 calls but there are 36 simple toasts eligible for replacement. Missing: L1967 (migration success), L6995 (batch dispatch eligibility), L7012 (batch dispatch summary), L7751/L7758 (clipboard/showInfo handler), L12791 (plan already claimed). Leaving these behind creates inconsistent UX.
2. **Wrong "do NOT replace" references.** L6555 is `return;`, not a modal dialog — the actual modal is at L6549 (`showWarningMessage`). L2768 is `});`, not a notification call. L6655 (`await showInformationMessage` with 'Continue', 'Cancel') is a genuine modal dialog completely absent from the exclusion list.
3. **L7758 generic showInfo handler** — auto-dismissing webview-requested messages could hide meaningful info. However, info level implies transience; the webview can use warning level for persistent messages.
4. **`withProgress` spinner cosmetic** — acknowledged tradeoff, same as KanbanProvider.ts. Consistency within the extension outweighs the semantic mismatch.

**Critique 2 (Implementation Execution):**
1. **Helper Placement [NIT]**: The placement of `_showTemporaryNotification` near L8360 is slightly arbitrary as it lands between a large block and a state watcher. However, it functions correctly without disrupting existing logic.
2. **Method Reference**: The plan referenced `_handleWebviewMessage` which doesn't exist as a named method; it's an anonymous function inside `resolveWebviewView`. Despite this misnomer, the substitutions were executed accurately.

**Balanced Synthesis:**
- The missing call sites and erroneous references were corrected in the plan prior to execution.
- The webview `showInfo` handler replacement is acceptable given the semantic meaning of "info".
- The implementation safely avoided breaking the awaited modal dialogs at L2771, L6549, and L6655.
- The helper was correctly placed, even if the method name in the plan was slightly inaccurate.

### Stage 2: Synthesis & Execution
All 36 instances of `showInformationMessage` intended for replacement were successfully updated to `this._showTemporaryNotification`.
The 3 modal dialogs were preserved.
The helper method was correctly added and mirrors `KanbanProvider.ts`.

### Validation Results
Manual codebase scan via `grep` confirms 39 total instances of `_showTemporaryNotification` and `showInformationMessage` in `TaskViewerProvider.ts`, correctly mapped to the 36 new helper calls and the preserved modal dialogs.
The implementation perfectly mirrors the requirements of the plan.

**Status:** Completed
