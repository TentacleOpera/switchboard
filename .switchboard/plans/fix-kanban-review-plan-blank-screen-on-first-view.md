# Fix Kanban Review Plan Blank Screen on First View

## Goal

When a user clicks the "Review Plan" button on a kanban card for the first time, the artifacts viewer must reliably display the plan content in the preview pane. Currently, it shows a blank screen with "Loading preview..." that never resolves unless the user navigates away and back.

### Problem Analysis

#### Root Cause
The bug is a **race condition in request ID matching** between the programmatic click handler and the preview response.

**Flow when bug occurs:**
1. User clicks "Review Plan" on a kanban card
2. `activateKanbanTabAndSelectPlan` handler (line 2615) sets `_pendingKanbanSelection` and calls `switchToTab('kanban')`
3. `switchToTab('kanban')` (line 430) sends `fetchKanbanPlans` request
4. Response arrives → `handleKanbanPlansReady` (line 4407) → `renderKanbanPlans` (line 3935) rebuilds DOM
5. Pending selection is resolved (line 4447-4459) → `itemDiv.click()` is called programmatically
6. **Critical bug**: The click handler at line 4039 increments `_kanbanPreviewRequestId` at line 4059, then sends `fetchKanbanPlanPreview` with that ID
7. BUT `handleKanbanPlanPreviewReady` at line 4482 has this guard:
   ```javascript
   if (msg.requestId !== undefined && msg.requestId !== -1 && msg.requestId !== _kanbanPreviewRequestId) return;
   ```

**Why it fails on first view:**
- On first view, `_kanbanPlansCache` is empty, so the immediate match in `activateKanbanTabAndSelectPlan` (line 2619) fails
- The pending selection must wait for `handleKanbanPlansReady` to resolve
- When `itemDiv.click()` is called after DOM rebuild, the request ID is incremented
- If the response timing is off (e.g., the fetch completes before the ID is fully propagated), the guard rejects the response
- The preview pane remains stuck on "Loading preview..." (set at line 4057)

**Why it works on subsequent views:**
- On subsequent views, `_kanbanPlansCache` is already populated
- The immediate match in `activateKanbanTabAndSelectPlan` succeeds before `switchToTab` fires the fetch
- The click happens with different timing, avoiding the race condition

#### Secondary Issue
The programmatic `itemDiv.click()` approach is fragile because it:
- Depends on DOM being fully rebuilt before the click executes
- Triggers the full click handler which does unnecessary work (exit edit/review modes, render meta bar, etc.)
- Introduces timing dependencies that are hard to control

## Metadata
- **Tags:** frontend, bugfix, ui
- **Complexity:** 3

## User Review Required

No — routine single-file refactor with well-understood scope and manual verification steps.

## Complexity Audit

### Routine
- Extract the preview fetch logic from the click handler into a reusable function
- Call the preview fetch directly instead of simulating a click
- Remove the request ID guard for programmatic fetches or use a bypass flag

### Complex / Risky
- Ensuring the extracted function handles all edge cases (edit mode, review mode, dirty flags)
- Verifying that the direct fetch approach doesn't break other code paths that depend on the click handler

## Edge-Case & Dependency Audit

- **Race Conditions**: The fix eliminates the race condition by removing the dependency on programmatic clicks and request ID timing.
- **Security**: No security implications — all data is local, no user input is interpolated into DOM without escaping.
- **Side Effects**: The extracted preview fetch function will update `_kanbanSelectedPlan`, render the meta bar, and send the `planShown` message — these are intentional and match the existing click handler behavior.
- **Dependencies & Conflicts**: The fix only modifies `planning.js`. No backend changes required. No conflicts with other pending changes.

## Dependencies

- None

## Adversarial Synthesis

Key risks: the programmatic `itemDiv.click()` is fragile indirection that couples selection, preview loading, and side effects; extracting the helper without also removing the `selected`-class toggle from it would break visual selection. Mitigations: keep cleanup (exit edit/review modes) in the click handler only, let each call site manage the `selected` class explicitly, and preserve the request-ID guard in `handleKanbanPlanPreviewReady` as a defense against stale async responses.

## Proposed Changes

### `src/webview/planning.js`

#### Step 1: Extract `loadKanbanPlanPreview()` helper function (insert after line 4070, before the copy link button handler)

Extract the preview fetch logic from the click handler into a standalone function:

```javascript
function loadKanbanPlanPreview(plan) {
    // Update selection state
    _kanbanSelectedPlan = plan;
    renderKanbanMetaBar(plan);
    if (plan.sessionId) {
        vscode.postMessage({ type: 'planShown', sessionId: plan.sessionId });
    }

    // Fetch preview content
    if (plan.planFile) {
        if (kanbanPreviewContent) {
            kanbanPreviewContent.innerHTML = '<div class="kanban-empty-state">Loading preview...</div>';
        }
        _kanbanPreviewRequestId++;
        vscode.postMessage({
            type: 'fetchKanbanPlanPreview',
            filePath: plan.planFile,
            requestId: _kanbanPreviewRequestId
        });
    } else {
        if (kanbanPreviewContent) {
            kanbanPreviewContent.innerHTML = '<div class="kanban-empty-state">No plan file linked</div>';
        }
    }
}
```

**Clarification**: This function extracts the core preview logic (lines 4050-4069) without the click-specific cleanup (exit edit/review modes) and without the DOM selection-class toggle. The cleanup and selected-class management remain in the click handler and the direct-call sites. Leaving `classList.remove('selected')` inside the helper would strip the highlight that callers just applied.

#### Step 2: Refactor the click handler to call the helper (replace lines 4039-4070)

Replace the click handler body with cleanup + helper call:

```javascript
itemDiv.addEventListener('click', (e) => {
    if (state.dirtyFlags.kanban) {
        exitEditMode('kanban', true);
    }
    if (state.reviewMode.kanban) {
        exitReviewMode('kanban', true);
    }

    // Update selected class
    document.querySelectorAll('.kanban-plan-item').forEach(el => el.classList.remove('selected'));
    itemDiv.classList.add('selected');

    // Load preview
    loadKanbanPlanPreview(plan);
});
```

**Key changes**: The click handler now only does cleanup and class updates, then delegates to `loadKanbanPlanPreview()` for the actual preview fetch.

#### Step 3: Update pending selection resolution to call the helper directly (replace lines 4447-4459)

Replace the programmatic click with a direct helper call:

```javascript
// Resolve pending selection (e.g. from kanban board Review button)
if (_pendingKanbanSelection) {
    const match = findPendingKanbanMatch(_kanbanPlansCache);
    if (match) {
        const itemDiv = kanbanListPane && kanbanListPane.querySelector(`.kanban-plan-item[data-plan-id="${match.planId}"]`);
        if (itemDiv) {
            itemDiv.scrollIntoView({ behavior: 'smooth', block: 'center' });
            // Update selected class
            document.querySelectorAll('.kanban-plan-item').forEach(el => el.classList.remove('selected'));
            itemDiv.classList.add('selected');
            // Load preview directly (no click simulation, no race condition)
            loadKanbanPlanPreview(match);
        }
        _pendingKanbanSelection = null;
    }
    // If no match, _pendingKanbanSelection persists for next fetch cycle
}
```

**Key changes**: 
- Removed `itemDiv.click()` 
- Added explicit class update (selected state)
- Called `loadKanbanPlanPreview(match)` directly
- This eliminates the timing dependency and request ID race condition

#### Step 4: Update immediate match path in `activateKanbanTabAndSelectPlan` (replace lines 2618-2626)

Apply the same pattern to the immediate match path:

```javascript
// Check already-loaded cache for immediate selection
const immediateMatch = findPendingKanbanMatch(_kanbanPlansCache);
if (immediateMatch) {
    const itemDiv = kanbanListPane && kanbanListPane.querySelector(`.kanban-plan-item[data-plan-id="${immediateMatch.planId}"]`);
    if (itemDiv) {
        itemDiv.scrollIntoView({ behavior: 'smooth', block: 'center' });
        // Update selected class
        document.querySelectorAll('.kanban-plan-item').forEach(el => el.classList.remove('selected'));
        itemDiv.classList.add('selected');
        // Load preview directly
        loadKanbanPlanPreview(immediateMatch);
        _pendingKanbanSelection = null;
    }
}
```

**Key changes**: Same as Step 3 — remove `itemDiv.click()`, use direct helper call.

## Verification Plan

### Automated Tests
- N/A — this is a webview UI fix with no automated test infrastructure for webview message handlers. Verification is manual.

### Manual Verification
1. **Primary flow (first view)**: Open Planning Panel → switch to Local tab → click Review Plan on a kanban card that has never been viewed.
   - Expected: Planning Panel reveals, switches to Kanban tab, plan list loads, target plan is scrolled into view, selected, and **preview content displays immediately** (no blank screen).
2. **Subsequent flow**: Repeat with the same plan.
   - Expected: Same behavior — preview loads immediately.
3. **Idempotent flow**: Click Review Plan on a plan that's already selected in the Kanban tab.
   - Expected: Plan is re-selected and preview refreshes.
4. **Dirty state**: Enter edit mode in Kanban tab (dirty flag set) → click Review Plan on a different card.
   - Expected: Edit mode is exited cleanly, new plan is selected and preview loads.
5. **Review mode**: Enter kanban review mode → click Review Plan on a different card.
   - Expected: Review mode exits, new plan is selected and preview loads.
6. **No plan file**: Click Review Plan on a plan with no `planFile` linked.
   - Expected: Plan is selected, preview pane shows "No plan file linked".

## Files Changed

- `src/webview/planning.js`

## Risks

- **Low**. The fix is a straightforward extraction and refactoring. No backend or API changes. The main risk is missing a side effect from the click handler, but the audit shows the only side effects are cleanup (exit edit/review modes) which remain in the click handler for user-initiated clicks. The request-ID guard is intentionally kept in `handleKanbanPlanPreviewReady` to protect against stale async responses.

## Estimated Effort

- ~20 minutes to implement and test.

## Recommendation

- Complexity 3 → **Send to Intern**
