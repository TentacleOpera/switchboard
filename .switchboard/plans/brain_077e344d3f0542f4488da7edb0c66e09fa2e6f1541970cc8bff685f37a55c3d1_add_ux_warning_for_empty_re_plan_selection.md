# Add UX Warning for Empty Re-plan Selection

## Goal
The "Re-plan" button in the PLAN REVIEWED column silently fails when no cards are selected. Replace the silent early-return with a VS Code warning message so the user understands why nothing happened.

## Metadata
**Tags:** frontend, UI, bugfix
**Complexity:** Low

## User Review Required

> [!IMPORTANT]
> This change introduces a blocking user-facing warning in VS Code. This is preferred over silent failure to improve transparency for high-reasoning agent dispatches.

## Complexity Audit

**Manual Complexity Override:** Low


### Routine
- Modify one `case` block in `kanban.html` to send an empty-state message instead of silently returning.
- Add an early-return guard in `KanbanProvider.ts` that calls `vscode.window.showWarningMessage()` when `sessionIds` is empty.

### Complex / Risky
- None.



## Edge-Case & Dependency Audit
- **Race Conditions:** None. The warning fires synchronously on click before any async dispatch.
- **Security:** No new inputs or external data. Warning text is a static string.
- **Side Effects:** None. The change only adds feedback — no plan state is mutated on the empty path.
- **Dependencies & Conflicts:** None. No other pending plans modify the `rePlanSelected` handler.

## Adversarial Synthesis

### Grumpy Critique
"Oh, wonderful. A one-line guard clause. Let me guess — you're going to patch `rePlanSelected` and declare victory while every other 'Selected' action (`moveSelected`, `promptSelected`, `julesSelected`, `completeSelected`) continues to silently swallow empty selections. That's not a fix, that's a spot treatment. Also, if you remove the frontend guard and just rely on the backend, you've added an unnecessary round-trip for a condition you can detect in 0 ms on the client side. Pick a lane."

### Balanced Response
Grumpy raises two valid points:
1. **Consistency across actions:** The bug report is scoped only to `rePlanSelected`. Fixing every `*Selected` action is out of scope for this plan, but we acknowledge the pattern. We will add a `// TODO: Apply empty-selection warning to other *Selected actions` comment to track follow-up work.
2. **Frontend vs Backend guard:** We will keep the frontend guard (for instant feedback) AND add a backend guard (as defense-in-depth). The frontend handler will post a `showWarning` message type instead of silently returning. The backend handler already has a `sessionIds.length === 0` check — we will add a `showWarningMessage` call to that path. This means both layers protect against the empty case, with the frontend providing instant UX and the backend preventing execution even if the frontend check is bypassed.

## Proposed Changes

### Kanban Webview (Frontend Guard)

#### [MODIFY] `src/webview/kanban.html`
- **Context:** The `rePlanSelected` case (around line 1423) currently returns silently when `getSelectedInColumn(column)` yields an empty array.
- **Logic:**
  1. Instead of `return` on empty, post a message of type `showWarning` to the backend with the warning text.
  2. This follows the existing `postKanbanMessage` pattern and gives the user immediate feedback via VS Code's native notification.
- **Implementation:**

Current code (~line 1423):
```javascript
case 'rePlanSelected': {
    const ids = getSelectedInColumn(column);
    if (ids.length === 0) return;
    postKanbanMessage({ type: 'rePlanSelected', sessionIds: ids, workspaceRoot: getActiveWorkspaceRoot() });
    break;
}
```

Replace with:
```javascript
case 'rePlanSelected': {
    const ids = getSelectedInColumn(column);
    if (ids.length === 0) {
        postKanbanMessage({ type: 'showWarning', message: 'Please select at least one plan to re-plan.' });
        return;
    }
    postKanbanMessage({ type: 'rePlanSelected', sessionIds: ids, workspaceRoot: getActiveWorkspaceRoot() });
    break;
}
```
- **Edge Cases Handled:** Instant client-side feedback prevents unnecessary backend round-trip.

### Kanban Provider (Backend Defense-in-Depth)

#### [MODIFY] `src/services/KanbanProvider.ts`
- **Context:** The `rePlanSelected` message handler (around line 1984) already checks `msg.sessionIds.length === 0` but silently breaks. We add an explicit warning.
- **Logic:**
  1. Before the existing combined guard (`if (!workspaceRoot || !Array.isArray(msg.sessionIds) || msg.sessionIds.length === 0)`), split the empty-array check into its own branch with a warning message.
  2. Add a `showWarning` message handler for the new generic warning path.
- **Implementation:**

Current code (~line 1984):
```typescript
case 'rePlanSelected': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    if (!workspaceRoot || !Array.isArray(msg.sessionIds) || msg.sessionIds.length === 0) { break; }
```

Replace with:
```typescript
case 'rePlanSelected': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    if (!workspaceRoot) { break; }
    if (!Array.isArray(msg.sessionIds) || msg.sessionIds.length === 0) {
        vscode.window.showWarningMessage('Please select at least one plan to re-plan.');
        break;
    }
```

Also add a generic `showWarning` handler (near other utility message handlers):
```typescript
case 'showWarning': {
    if (typeof msg.message === 'string' && msg.message.length > 0) {
        vscode.window.showWarningMessage(msg.message);
    }
    break;
}
```
- **Edge Cases Handled:** Backend guard fires even if the frontend check is bypassed (e.g., programmatic message posting). The generic `showWarning` handler is reusable for future empty-selection warnings on other actions.

## Open Questions

None. The user has explicitly requested "Option 1" (UX Warning).

## Verification Plan

### Manual Verification
1. Open the Kanban board.
2. Ensure the "Plan Reviewed" column has plans.
3. Deselect all plans (if any are selected).
4. Click the "Re-plan" icon in the "Plan Reviewed" column header.
5. **Expected Result**: A VS Code warning message appears: "Please select at least one plan to re-plan."
6. Select one plan and click the button.
7. **Expected Result**: The plan is dispatched for re-planning as normal.

### Build Verification
- Run `npm run compile` — no TypeScript or webpack errors.
- Verify no regressions in other column-header icon behaviors.

### Agent Recommendation
**Send to Coder** — This is a routine two-file change following well-established patterns.
