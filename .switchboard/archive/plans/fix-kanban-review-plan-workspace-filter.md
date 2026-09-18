# Fix: "Review Plan" Button Should Switch Workspace Filter in planning.html

## Goal

When a user clicks the **"review plan"** button on a kanban card in `kanban.html`, the Planning Panel (`planning.html`) must not only switch to the Kanban tab and select the plan, but also **set the workspace filter dropdown to the target plan's workspace** so the plan is visible in the filtered list.

### Problem

The `activateKanbanTabAndSelectPlan` message handler in `src/webview/planning.js` (lines 2622-2641) receives `workspaceRoot` in the message payload and stores it in `_pendingKanbanSelection`, but it does **not** update the `kanbanFilters.workspaceRoot` state or the corresponding dropdown (`kanban-workspace-filter`).

If the target plan belongs to Workspace A, but the workspace filter is currently set to Workspace B (or "All Workspaces" with the plan filtered out by another filter), the plan list renders without the target plan visible. The selection logic (`findPendingKanbanMatch`) may find the plan in the cache, but the DOM element won't exist because `renderKanbanPlans` filtered it out, so the selection fails silently.

### Root Cause

The handler at line 2622 stores the workspace root but never applies it to the filter state:

```javascript
case 'activateKanbanTabAndSelectPlan': {
    _pendingKanbanSelection = { 
        planId: msg.planId || '', 
        sessionId: msg.sessionId || '', 
        planFile: msg.planFile || '', 
        workspaceRoot: msg.workspaceRoot || ''  // ← Stored but never used
    };
    switchToTab('kanban');
    // ... selection logic runs with wrong filter active
}
```

The workspace filter is only updated when the user manually changes the dropdown (line 4610-4619) or on panel restore (line 2525). There's no mechanism to programmatically set it from an external message.

## Metadata

- **Tags:** frontend, bugfix, ui
- **Complexity:** 2

## User Review Required

No — straightforward UI state fix with clear manual verification steps.

## Complexity Audit

### Routine
- Set `kanbanFilters.workspaceRoot` to the message's `workspaceRoot` value
- Update the dropdown element's value to match
- Call `updateKanbanProjectFilter()` to refresh the project dropdown for the new workspace
- Re-render the plan list with the new filter

### Complex / Risky
- None — this is a straightforward state update before existing selection logic

## Edge-Case & Dependency Audit

### Edge Cases
- **Empty workspaceRoot in message:** If `msg.workspaceRoot` is empty or undefined, set filter to empty string (All Workspaces) — matches existing behavior for manual dropdown selection.
- **Workspace not in dropdown:** If the target workspace no longer exists in `_kanbanWorkspaceItems`, the filter reset logic at line 4449-4451 in `handleKanbanPlansReady` will clear it to "All Workspaces" on the next fetch. The plan still won't be found (correct — it's gone).
- **Project filter stale:** When workspace changes, the project filter must be reset to empty to avoid showing projects from the previous workspace. The existing `updateKanbanProjectFilter()` call handles this.

### Security
- No new input surfaces. `workspaceRoot` comes from the extension's own kanban database, not user input.

### Side Effects
- Changing the workspace filter persists to `kanban.root` tab state (line 4612). This is intentional — the user's last-viewed workspace should reflect their navigation.
- The project filter is reset to empty when workspace changes (line 4614). This matches existing manual dropdown behavior.

### Dependencies & Conflicts
- Depends on `kanbanFilters`, `kanbanWorkspaceFilter`, `kanbanProjectFilter`, `updateKanbanProjectFilter`, `renderKanbanPlans`, `persistTab` — all in scope at the handler location.
- No conflicts with other pending changes.

## Dependencies

- None

## Adversarial Synthesis

Key risks: (1) empty `workspaceRoot` in the message must clear the filter to "All Workspaces" so legacy plans remain visible — fixed by unconditionally applying `msg.workspaceRoot || ''`. (2) immediate DOM selection may miss cross-workspace plans because the old filtered list is still rendered; mitigated by pending-selection resolution in `handleKanbanPlansReady` after the fetch returns. (3) invalid `workspaceRoot` values are handled by existing reset logic in `handleKanbanPlansReady`. Overall risk: low.

## Proposed Changes

### `src/webview/planning.js`

In the `activateKanbanTabAndSelectPlan` handler (lines 2622-2641), add filter state updates before the immediate match check:

```javascript
case 'activateKanbanTabAndSelectPlan': {
    _pendingKanbanSelection = { 
        planId: msg.planId || '', 
        sessionId: msg.sessionId || '', 
        planFile: msg.planFile || '', 
        workspaceRoot: msg.workspaceRoot || '' 
    };
    
    // Set workspace filter to target plan's workspace so the plan is visible
    if (kanbanWorkspaceFilter) {
        kanbanFilters.workspaceRoot = msg.workspaceRoot || '';
        kanbanWorkspaceFilter.value = msg.workspaceRoot || '';
        persistTab('kanban.root', kanbanFilters.workspaceRoot);
        // Reset project filter when workspace changes
        kanbanFilters.project = '';
        if (kanbanProjectFilter) kanbanProjectFilter.value = '';
        updateKanbanProjectFilter();
    }
    
    switchToTab('kanban');
    
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
    // No redundant fetch — switchToTab('kanban') already fired fetchKanbanPlans.
    // Pending selection will be resolved in handleKanbanPlansReady if not matched immediately.
    break;
}
```

**Key changes:**
- Added filter state update block before `switchToTab` call
- Applies filter unconditionally when `kanbanWorkspaceFilter` exists; empty `msg.workspaceRoot` clears to "All Workspaces"
- Mirrors the manual dropdown change handler logic (lines 4610-4619): set state, update DOM, persist, reset project filter, update project dropdown
- Filter is set **before** `switchToTab` so that when `fetchKanbanPlans` fires (inside `switchToTab`), the correct filter is already active
- Immediate DOM match may fail if the plan was not in the previously filtered list; pending selection resolves asynchronously in `handleKanbanPlansReady` after the fetch returns

## Files Changed

- `src/webview/planning.js`

## Verification Plan

### Automated Tests

None required — this is a UI state transition bug best covered by manual verification. Per session directive, automated tests are not run as part of this plan's verification.

### Manual Verification

1. **Cross-workspace review:** Open `kanban.html` with Workspace A active. Click "review" on a plan from Workspace B.
   - **Expected:** `planning.html` opens, switches to Kanban tab, workspace dropdown shows Workspace B selected, plan list shows Workspace B plans, target plan is selected and previewed.

2. **Same-workspace review:** Click "review" on a plan from the currently-filtered workspace.
   - **Expected:** Same behavior, workspace dropdown unchanged (already correct), plan selected.

3. **All-workspaces filter:** Set workspace dropdown to "All Workspaces". Click "review" on a plan from Workspace A.
   - **Expected:** Workspace dropdown switches to Workspace A, plan selected.

4. **Empty workspaceRoot:** Simulate a message with empty `workspaceRoot` (legacy plan).
   - **Expected:** Workspace dropdown clears to "All Workspaces", plan is visible and selected via sessionId/planFile fallbacks.

5. **Invalid workspaceRoot:** Simulate a message with a workspaceRoot that no longer exists in `_kanbanWorkspaceItems`.
   - **Expected:** Workspace dropdown is set to the invalid value, but `handleKanbanPlansReady` reset logic (line 4449-4451) clears it to "All Workspaces" on fetch. Plan not found (correct — workspace gone).

## Risks

- **Low.** The change is a straightforward state update that mirrors existing manual dropdown behavior. The only risk is if the workspaceRoot is invalid, but the existing reset logic handles that gracefully.

## Estimated Effort

- ~15 minutes to implement and test.

## Recommendation

- Complexity 2 → **Send to Intern**

## Review Findings

Implementation at `src/webview/planning.js:2621-2653` matches plan exactly. No code changes required.

**Files changed:** None (implementation already correct).

**Validation:** Per session directives, compilation and automated tests skipped. Manual verification plan covers cross-workspace, same-workspace, all-workspaces, empty workspaceRoot, and invalid workspaceRoot cases.

**Remaining risks:** NIT-level only — brief stale DOM between filter set and fetch return (masked by tab switch), and redundant `updateKanbanProjectFilter()` call (harmless). No CRITICAL or MAJOR issues found.
