# Fix Kanban Toast Notification Persistence

## Goal
Replace persistent VS Code `showInformationMessage()` toast calls that fire after Kanban card advancement with auto-dismissing `withProgress` notifications, so users no longer need to manually close confirmation toasts.

## Metadata
- **Tags:** frontend, UX, bugfix, reliability
- **Complexity:** 3

## User Review Required
None. This is a pure UX-behavior fix with no logic changes.

## Complexity Audit

### Routine
- Adding a single private helper method to an existing class
- All call sites follow the same replacement pattern (same helper, same arguments)
- No state changes, no DB operations, no logic changes
- All affected code paths are isolated to the `_handleWebviewMessage` switch block

### Complex / Risky
- Scope is broader than original plan indicated: ~14 call sites across 6 message-handler cases need updating (not just 4)
- `void`-prefixed fire-and-forget call pattern must be used consistently to avoid adding 2s latency to each action
- Line numbers in original plan were stale; corrected below

## Edge-Case & Dependency Audit

### Race Conditions
- Fire-and-forget (`void`) calls mean the notification may outlive the code path that called it. This is intentional and harmless — notifications have no side effects.

### Security
- None. Notification text is internal, not user-controlled in any injectable sense.

### Side Effects
- Replacing `await showInformationMessage()` (which was synchronous fire-and-forget at the call site anyway, since VS Code does not require awaiting it) with `void _showTemporaryNotification()` is semantically equivalent.
- `withProgress` shows a progress spinner icon in the notification. Cosmetically different from the plain info icon, but acceptable.

### Dependencies & Conflicts
- No dependency on external libraries. Uses `vscode.window.withProgress` and `vscode.ProgressLocation`, both stable VS Code API surface.
- No conflict with the DB-first optimistic update pattern (those operations complete synchronously before the notification is fired).

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) The original plan's scope only covered 4 of ~14 affected call sites, leaving most advance paths unaddressed. (2) Awaiting the notification helper would add a 2-second blocking delay to every advance action. Mitigations: Expand scope to all advance-related `showInformationMessage` calls (see Proposed Changes), and use `void` (fire-and-forget) on every notification call to prevent latency injection.

## Problem
When advancing Kanban cards to the next stage, VS Code toast messages like "copied prompt and advanced to next stage" persist until manually closed. This creates a poor user experience as notifications accumulate and require manual dismissal.

## Root Cause
The code uses `vscode.window.showInformationMessage()` which creates persistent notifications that stay visible until explicitly dismissed by the user. VS Code's API does not provide an auto-dismiss option for this method.

## Solution
Replace `showInformationMessage()` calls with `vscode.window.withProgress()` using `ProgressLocation.Notification` to create temporary notifications that auto-dismiss after a short duration (2 seconds). The notification calls must be fire-and-forget (`void`, not `await`) to avoid blocking the execution path.

## Proposed Changes

### `src/services/KanbanProvider.ts`

#### Context
The file is ~6519 lines. All changes are within the `_handleWebviewMessage` switch block.

#### Logic: Add Helper Method
Add a private helper method near the other private helpers in the class body (before `_handleWebviewMessage` or after the last private helper):

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

Replace all `showInformationMessage` calls that fire **after a successful card advancement** with `this._showTemporaryNotification(...)`. Do NOT replace calls that are used for **error/warning states**, **user confirmation dialogs** (calls that return a choice), or **non-advance notifications** (e.g., clipboard-only copies without movement).

**Calls to replace (actual current line numbers):**

**`case 'promptOnDropResult'`** (drag-and-drop advance):
- **L4831**: `vscode.window.showInformationMessage(\`Copied prompt for ${sourceCards.length} plan(s) to clipboard.\`)`
  - Replace with: `this._showTemporaryNotification(\`Copied prompt for ${sourceCards.length} plan(s) to clipboard.\`)`
- **L4870**: `vscode.window.showInformationMessage(\`Copied prompt for ${sourceCards.length} plan(s) to clipboard.\`)`
  - Replace with: `this._showTemporaryNotification(\`Copied prompt for ${sourceCards.length} plan(s) to clipboard.\`)`

**`case 'batchPlannerPrompt'`** (batch planner advance):
- **L4888**: `vscode.window.showInformationMessage(\`Copied batch planner prompt (${sourceCards.length} plans). Advanced ${advanced.length} plans to PLAN REVIEWED.\`)`
  - Replace with: `this._showTemporaryNotification(\`Copied batch planner prompt (${sourceCards.length} plans). Advanced ${advanced.length} plans to PLAN REVIEWED.\`)`

**`case 'batchLowComplexity'`** (batch low complexity advance):
- **L4915**: `vscode.window.showInformationMessage(\`Copied batch low-complexity prompt (${sourceCards.length} plans). Advanced ${advanced.length} plans to CODER CODED.\`)`
  - Replace with: `this._showTemporaryNotification(\`Copied batch low-complexity prompt (${sourceCards.length} plans). Advanced ${advanced.length} plans to CODER CODED.\`)`

**`case 'moveAll'`** (move all cards in a column):
- **L5094**: `vscode.window.showInformationMessage(\`Moved ${knownIds.length} plans from ${column}: ${movedParts.join(', ')}.${skippedSuffix}\`)`
  - Replace with: `this._showTemporaryNotification(\`Moved ${knownIds.length} plans from ${column}: ${movedParts.join(', ')}.${skippedSuffix}\`)`
- **L5144**: `vscode.window.showInformationMessage(\`Moved ${sourceCards.length} plans from ${column} to ${nextCol}.\`)`
  - Replace with: `this._showTemporaryNotification(\`Moved ${sourceCards.length} plans from ${column} to ${nextCol}.\`)`

**`case 'promptSelected'`** (prompt selected cards with advance):
- **L5222**: `vscode.window.showInformationMessage(\`Copied prompt for ${sourceCards.length} plans and advanced to ${nextCol}.\`)`
  - Replace with: `this._showTemporaryNotification(\`Copied prompt for ${sourceCards.length} plans and advanced to ${nextCol}.\`)`
- **L5248**: `vscode.window.showInformationMessage(\`Copied prompt for ${sourceCards.length} plans. Advanced ${knownIds.length}.${skippedSuffix}\`)`
  - Replace with: `this._showTemporaryNotification(\`Copied prompt for ${sourceCards.length} plans. Advanced ${knownIds.length}.${skippedSuffix}\`)`
- **L5250**: `vscode.window.showInformationMessage(\`Copied prompt for ${sourceCards.length} plans. No plans advanced (${skippedCount} skipped — unknown complexity).\`)`
  - Replace with: `this._showTemporaryNotification(\`Copied prompt for ${sourceCards.length} plans. No plans advanced (${skippedCount} skipped — unknown complexity).\`)`
- **L5264**: `vscode.window.showInformationMessage(\`Copied prompt for ${sourceCards.length} plans and advanced to next stage.\`)`
  - Replace with: `this._showTemporaryNotification(\`Copied prompt for ${sourceCards.length} plans and advanced to next stage.\`)`

**`case 'promptAll'`** (prompt all cards in column with advance):
- **L5311**: `vscode.window.showInformationMessage(\`Copied prompt for ${sourceCards.length} plans and advanced to ${nextCol}.\`)`
  - Replace with: `this._showTemporaryNotification(\`Copied prompt for ${sourceCards.length} plans and advanced to ${nextCol}.\`)`
- **L5338**: `vscode.window.showInformationMessage(\`Copied prompt for ${sourceCards.length} plans. Advanced ${knownIds.length}: ${movedParts.join(', ')}.\`)`
  - Replace with: `this._showTemporaryNotification(\`Copied prompt for ${sourceCards.length} plans. Advanced ${knownIds.length}: ${movedParts.join(', ')}.\`)`
- **L5340**: `vscode.window.showInformationMessage(\`Copied prompt for ${sourceCards.length} plans. No plans advanced.\`)`
  - Replace with: `this._showTemporaryNotification(\`Copied prompt for ${sourceCards.length} plans. No plans advanced.\`)`
- **L5355**: `vscode.window.showInformationMessage(\`Copied prompt for ${sourceCards.length} plans and advanced to ${nextCol}.\`)`
  - Replace with: `this._showTemporaryNotification(\`Copied prompt for ${sourceCards.length} plans and advanced to ${nextCol}.\`)`

#### Edge Cases
- **Do NOT replace** modal confirmation calls (e.g., L2680, L5650 where `showInformationMessage` is `await`-ed for a user choice with buttons — these are dialogs, not toasts).
- **Do NOT replace** error/warning calls or non-advance clipboard-only confirmation calls.
- **Do NOT replace** calls in `moveSelected` case (L4986) — this case already lacks a notification after the advance in the else-branch; the notification at L4986 is inside a condition that only fires when `movedParts.length > 0`. These are lower-risk "move" operations that are less user-visible. *(Optional stretch goal: can be replaced if desired.)*

## Verification Plan

### Automated Tests
*(Skipped per session directives.)*

### Manual Verification
1. Open the Kanban panel.
2. Use **"Prompt Selected"** on a card in any column — confirm the notification auto-dismisses after ~2 seconds without manual action.
3. Use **"Prompt All"** on a column — confirm same behavior.
4. Use **"Move All"** — confirm same behavior.
5. Use drag-and-drop advance — confirm same behavior.
6. Trigger a **modal dialog** (e.g., a confirmation prompt) — confirm it still works as a blocking dialog (not broken by this change).
7. Verify no 2-second latency is added to any advance action (notifications appear instantly; they dismiss after 2s but the action completes immediately).

## Files Changed
- `src/services/KanbanProvider.ts` (add 1 helper method, replace ~13 notification calls)

## Risk Assessment
**Low Risk**: Pure UI-only change affecting notification display behavior. Underlying logic for card advancement, DB updates, and prompt copying remains unchanged. All replacements follow identical patterns.

---

**Recommendation: Send to Intern**
