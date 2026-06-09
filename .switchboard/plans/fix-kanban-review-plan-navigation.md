# Fix Kanban "Review Plan" Button Navigation to Kanban Tab

## Metadata
- **Complexity:** 4
- **Tags:** frontend, bugfix, ui, vscode-extension

## Goal

When a user clicks the **Review Plan** button on a kanban card in `kanban.html`, the Planning Panel (`planning.html`) must open/reveal and **reliably navigate to the Kanban Plans tab**, scroll the target plan into view, and select it — regardless of which tab was previously active in the Planning Panel.

## Problem Analysis

### Root Cause
The message handler for `activateKanbanTabAndSelectPlan` in `src/webview/planning.js` calls `activateKanbanTab()` at line 3212, but **this function is never defined anywhere in the file**.

```js
// @/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.js:3210-3212
case 'activateKanbanTabAndSelectPlan': {
    _pendingKanbanSelection = { sessionId: msg.sessionId, planFile: msg.planFile, workspaceRoot: msg.workspaceRoot };
    activateKanbanTab(); // ❌ ReferenceError: activateKanbanTab is not defined
    // ... rest of handler never executes
}
```

This throws a `ReferenceError` in the webview, which:
1. Halts execution of the message handler before it reaches the `_pendingKanbanSelection` cache check.
2. Never triggers the `fetchKanbanPlans` request needed to populate the list.
3. Never resolves the pending selection in `handleKanbanPlansReady()`.
4. The Planning Panel simply reveals at whatever tab was previously active (local, research, tickets, etc.).

### Secondary Issue
The existing tab-switching logic is duplicated: the click handler for `.research-tab-btn` already contains all the logic for switching tabs, cleaning up edit/review modes, and fetching plans when entering the kanban tab. There is no reusable `switchToTab(tabName)` or `activateKanbanTab()` abstraction, so every navigation path must manually replicate this logic.

## Constraints & Edge Cases

1. **Dirty state handling**: If the user has unsaved edits in another tab (local, kanban edit mode, design), switching tabs must prompt or auto-exit edit mode. The existing click handler already handles this; the new function must preserve identical behavior.
2. **Review mode cleanup**: If the user is in kanban review mode (highlighting text to comment) and the Review button is clicked again, it should exit review mode cleanly.
3. **Idempotency**: If the Planning Panel is already on the Kanban tab, the function should still trigger `fetchKanbanPlans` to ensure fresh data and attempt to select the target plan.
4. **Plan not in cache**: If the plan is not in `_kanbanPlansCache` yet, `_pendingKanbanSelection` must remain set so that `handleKanbanPlansReady()` resolves it after the fetch completes.
5. **Multiple workspaces**: The `workspaceRoot` from the kanban card must be preserved in `_pendingKanbanSelection` so that cross-workspace plan selection works correctly.

## Implementation Plan

### Step 1: Extract a reusable `switchToTab(tabName)` function

In `src/webview/planning.js`, extract the tab-switching logic from the `.research-tab-btn` click handler into a standalone function:

```js
function switchToTab(tabName) {
    // 1. Clean up dirty flags and edit/review modes (same logic as click handler)
    if (state.dirtyFlags.local && tabName !== 'local') { exitEditMode('local', true); }
    if (state.dirtyFlags.kanban && tabName !== 'kanban') { exitEditMode('kanban', true); }
    if (state.dirtyFlags.design && tabName !== 'design') { exitEditMode('design', true); }
    if (state.editMode.local && tabName !== 'local') { exitEditMode('local', true); }
    if (state.editMode.kanban && tabName !== 'kanban') { exitEditMode('kanban', true); }
    if (state.editMode.design && tabName !== 'design') { exitEditMode('design', true); }
    if (state.reviewMode.kanban && tabName !== 'kanban') { exitReviewMode('kanban', true); }

    // 2. Update active classes
    tabButtons.forEach(b => b.classList.remove('active'));
    tabContents.forEach(c => c.classList.remove('active'));
    const targetBtn = document.querySelector(`.research-tab-btn[data-tab="${tabName}"]`);
    if (targetBtn) targetBtn.classList.add('active');
    const targetContent = document.getElementById(`${tabName}-content`);
    if (targetContent) targetContent.classList.add('active');

    // 3. Apply sidebar state
    if (tabName === 'html-preview') { applySidebarState('html-preview', state.htmlPreviewCollapsed); }
    else if (tabName === 'design') { applySidebarState('design', state.designPreviewCollapsed); }
    else if (tabName === 'tickets') { applySidebarState('tickets', state.ticketsPreviewCollapsed); }
    else if (tabName === 'local' || tabName === 'research' || tabName === 'online') {
        applySidebarState(tabName, state.docsListCollapsed);
    }

    // 4. Tab-specific initialization
    if (tabName === 'kanban') {
        vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });
    }
    if (tabName === 'tickets') {
        if (!ticketsInitialized) { initTicketsTab(); ticketsInitialized = true; }
        restoreTicketsState();
        if (lastIntegrationProvider && !ticketsLoadedOnce) {
            if (lastIntegrationProvider === 'clickup') loadClickUpSpaces();
            else loadLinearProject();
        }
    } else {
        if (ticketsInitialized) { saveTicketsState(); }
    }
}
```

**Placement**: Define this function before the `tabButtons.forEach(...)` block (around line 268) so it is in scope for both the click handler and the message handler.

### Step 2: Refactor the click handler to call `switchToTab`

Replace the body of the `.research-tab-btn` click handler with a single call to `switchToTab(tabName)`.

### Step 3: Replace the undefined `activateKanbanTab()` call

In the `activateKanbanTabAndSelectPlan` message handler (around line 3212), replace:

```js
activateKanbanTab();
```

with:

```js
switchToTab('kanban');
```

This ensures the Kanban tab is activated, dirty states are cleaned up, and `fetchKanbanPlans` is requested. The existing `_pendingKanbanSelection` and cache-matching logic immediately below this line will then execute correctly.

### Step 4: Verify `handleKanbanPlansReady` resolves pending selection correctly

The existing `handleKanbanPlansReady` already checks `_pendingKanbanSelection` after rendering the plan list (lines 4597-4611). No changes needed there, but verify that:
- The `match` logic uses the correct plan identifier fields (`sessionId`, `planFile`).
- `_pendingKanbanSelection` is cleared (`null`) after successful selection or after a reasonable timeout to prevent stale selections.

**Note**: The current code clears `_pendingKanbanSelection = null` unconditionally at line 4611. If the plan is not found in the cache, this means the selection is lost. Consider whether to:
- **Option A (recommended)**: Keep the null assignment but ensure `fetchKanbanPlans` is always fired by `switchToTab('kanban')`, so a fresh list arrives and the user can manually select. The pending selection logic already attempts selection against the current cache first; if that fails, the fetch will trigger `handleKanbanPlansReady` again, but by then `_pendingKanbanSelection` is already null.
- **Option B**: Move `_pendingKanbanSelection = null` inside the `if (match)` block so it persists until the plan is actually found. This is safer for slow plan list loads.

**Recommendation**: Adopt **Option B** — move the null assignment inside the `if (match)` block to handle race conditions where the plan list is not yet loaded.

### Step 5: Regression Testing

1. **Manual test**: Open Planning Panel → switch to Local tab → click Review Plan on a kanban card.
   - Expected: Planning Panel reveals, switches to Kanban tab, plan list loads, target plan is scrolled into view and selected.
2. **Manual test**: Repeat with Planning Panel already on Kanban tab but with a different plan selected.
   - Expected: Same plan is re-selected and scrolled into view.
3. **Manual test**: Enter edit mode in Local tab (dirty flag set) → click Review Plan.
   - Expected: Edit mode is exited cleanly, Kanban tab opens.
4. **Manual test**: Enter kanban review mode → click Review Plan on a different card.
   - Expected: Review mode exits, new plan is selected.
5. **Edge case**: Click Review Plan for a plan that was just deleted.
   - Expected: Kanban tab opens, plan list refreshes, no crash. If plan is missing, selection remains empty.

## Files Changed

- `src/webview/planning.js`

## Risks

- **Low**. The fix is a straightforward extraction and call replacement. No backend or API changes. The only risk is a subtle difference in tab-switching behavior if the extraction misses a side effect (e.g., `saveTicketsState()` being called when leaving a non-tickets tab). Careful 1:1 mapping of the click handler body into `switchToTab` mitigates this.

## Estimated Effort

- ~30 minutes to implement and test.
