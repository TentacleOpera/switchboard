# Fix: Review Plan button shows wrong plans after switching workspace in kanban.html

## Goal

Make the **Review Plan** button on kanban board cards (`kanban.html`) reliably open the correct plan in the Project panel (`project.html` / `project.js`) after the user switches workspaces via the kanban workspace dropdown. Despite a prior fix (ready-handshake + force-clear on hidden match), the button still shows plans from the wrong workspace or no plan at all after a workspace switch.

### Problem / background / root cause

The Review Plan button lives on the standalone Kanban board (`kanban.html`, rendered by `KanbanProvider._panel`). Clicking it must navigate a *different* webview — the Project panel (`project.html`, rendered by `PlanningPanelProvider._projectPanel`) — to its Kanban tab and select the plan there. These are two independent webviews with independent JS state, independent plan caches, and independent filter dropdowns.

A prior plan (`feature_plan_20260630120000_review-plan-broken-on-workspace-switch.md`) addressed two root causes: (A) a cold-open message-drop race (fixed with a ready-handshake queue) and (B) a filter-intent `!itemDiv` dead-end (fixed with force-clear on hidden match). Both fixes are implemented and present in the codebase. **The bug persists** because there is a third root cause that the prior plan did not address:

**Root cause C (remaining): `kanbanPlansReady` auto-sets the workspace filter to `kanbanWorkspaceRoot`, which can override the cleared state before the filter intent applies, and can conflict with the target plan's workspace.**

The flow after a workspace switch + Review Plan click:

1. User switches workspace in `kanban.html` → `selectWorkspace` (`KanbanProvider.ts:6532`) → `setProjectFilter(UNASSIGNED)` → `_refreshBoard` → kanban.html gets new cards. **The Project panel is NOT notified.** Its `_kanbanPlansCache` and filter state are stale.

2. User clicks Review Plan on a card from the new workspace → `reviewPlan` (`KanbanProvider.ts:8311`) → resolves `reviewEffectiveRoot` → sends `activateKanbanTabAndSelectPlan` with the new workspace root.

3. `project.js` `case 'activateKanbanTabAndSelectPlan'` (`project.js:652-682`) → sets `_pendingKanbanSelection` + `_pendingKanbanFilterIntent` with the new workspace root, **clears all filters to widest** (`kanbanFilters.workspaceRoot = ''`), clicks the Kanban tab (fires `fetchKanbanPlans`), calls `tryResolvePendingKanbanSelection()` immediately (against stale cache → fails, starts retrying).

4. `PlanningPanelProvider` `case 'fetchKanbanPlans'` (`PlanningPanelProvider.ts:3441`) → fetches ALL roots' plans → posts `kanbanPlansReady` with `kanbanWorkspaceRoot: this._kanbanProvider?.getCurrentWorkspaceRoot()` — this is the **new** workspace root (the one the user switched to in kanban.html).

5. `project.js` `case 'kanbanPlansReady'` (`project.js:450-549`):
   - **Line 484-491:** `if (msg.kanbanWorkspaceRoot && _kanbanWorkspaceItems.some(...)) { if (!kanbanFilters.workspaceRoot) { kanbanFilters.workspaceRoot = msg.kanbanWorkspaceRoot; } }` — since filters were cleared in step 3, `kanbanFilters.workspaceRoot` is `''`, so this sets it to `kanbanWorkspaceRoot` (the new workspace).
   - **Lines 496-516:** The filter intent then tries to narrow `kanbanFilters.workspaceRoot` to `intent.workspaceRoot`. But the intent's workspaceRoot is `reviewEffectiveRoot` (the effective/mapped root), while `kanbanWorkspaceRoot` is `getCurrentWorkspaceRoot()` (the raw selected root). **If these differ** (e.g. the user selected a child workspace that maps to a parent), the intent's `opts.some(o => normalizeRoot(o) === intentNorm)` check may fail if the dropdown doesn't contain the effective root as an option, leaving the filter at `kanbanWorkspaceRoot` (the raw child root).
   - The plans are tagged with `effectiveRoot` (`PlanningPanelProvider.ts:9311`). If the filter is set to the raw child root but the plans are tagged with the parent (effective) root, `getFilteredKanbanPlans` (`project.js:1467`) filters them out: `normalizeRoot(plan.workspaceRoot) !== normalizeRoot(kanbanFilters.workspaceRoot)`.

6. `tryResolvePendingKanbanSelection` (`project.js:1666`) runs. The plan IS in the cache (step 4 fetched all roots), but the filter (set in step 5) hides it → `!itemDiv` branch → force-clears filters → re-renders → finds the plan. **This should work... but there's a timing issue.**

**The actual remaining bug:** The force-clear in `tryResolvePendingKanbanSelection` (lines 1699-1707) clears `_pendingKanbanFilterIntent = null` and calls `renderKanbanPlans()`. But `renderKanbanPlans` uses `getFilteredKanbanPlans()` which checks `kanbanFilters.workspaceRoot`. The force-clear sets `kanbanFilters.workspaceRoot = ''` (line 1699), which should show all plans. **However**, the `kanbanPlansReady` handler at line 484-491 runs BEFORE `tryResolvePendingKanbanSelection` (line 546) in the same message handler. So the sequence is:
   - Line 484: `kanbanFilters.workspaceRoot = kanbanWorkspaceRoot` (set to new workspace)
   - Lines 496-516: filter intent tries to override but may fail (root mismatch)
   - Line 539: `renderKanbanPlans()` — renders with the filter from above
   - Line 546: `tryResolvePendingKanbanSelection()` — plan is in cache but hidden by filter → force-clear → `renderKanbanPlans()` again → should find it

   The force-clear SHOULD work. But if the plan's `workspaceRoot` (tagged with `effectiveRoot`) doesn't match ANY workspace option in the dropdown (because `buildWorkspaceItems` returns different roots than `_resolveEffectiveWorkspaceRoot` tags plans with), then even after clearing the workspace filter to `''` (All Workspaces), the plan IS visible — but the force-clear also clears `_pendingKanbanFilterIntent`, which prevents re-narrowing. So the plan should be found.

   **The real issue is more subtle:** After the force-clear succeeds and the plan is selected, the `kanbanPlansReady` handler at lines 484-491 has ALREADY set `kanbanFilters.workspaceRoot` to `kanbanWorkspaceRoot`. The force-clear resets it to `''`. But then the NEXT `kanbanPlansReady` push (e.g. from a proactive refresh, `PlanningPanelProvider.ts:3958-4066`) re-applies lines 484-491, re-setting the filter to `kanbanWorkspaceRoot`, which may hide the plan again. The user sees the plan briefly then it disappears, or sees plans from the wrong workspace.

**Root cause summary:** The `kanbanPlansReady` handler at `project.js:484-491` unconditionally sets `kanbanFilters.workspaceRoot` to `kanbanWorkspaceRoot` (the KanbanProvider's current workspace) whenever the filter is empty. This is intended to sync the Project panel's workspace filter with the kanban board's active workspace. But it fires on EVERY `kanbanPlansReady` push, including proactive refreshes, and it fights with the Review Plan flow's filter-clearing logic. After a workspace switch, `kanbanWorkspaceRoot` is the new workspace, but the Project panel may have plans from all workspaces in its cache — the filter narrows to just the new workspace, hiding plans the user expects to see.

## Metadata

**Tags:** frontend, ui, bugfix, reliability, webview
**Complexity:** 6
**Project:** v5 funnel

## Complexity Audit

### Routine
- Adding a guard to `project.js:484-491` to skip the auto-set when a pending selection is active — single `if` condition.
- Clearing `kanbanFilters.workspaceRoot` in `activateKanbanTabAndSelectPlan` is already done; ensuring it stays cleared through the `kanbanPlansReady` cycle is a state-flag check.

### Complex / Risky
- The `kanbanPlansReady` auto-set at lines 484-491 serves a legitimate purpose: keeping the Project panel's workspace filter in sync with the kanban board when the user is browsing normally (not via Review Plan). Disabling it entirely would break that sync. The fix must only suppress it during a pending Review Plan navigation.
- Proactive `kanbanPlansReady` pushes (from `PlanningPanelProvider.ts:3958-4066`) can arrive AFTER the Review Plan selection resolves, re-triggering the auto-set and re-hiding the selected plan. The fix must ensure the selection is stable before allowing the auto-set to resume.
- The `kanbanWorkspaceRoot` value comes from `KanbanProvider.getCurrentWorkspaceRoot()` which returns the raw selected root, not the effective root. Plans are tagged with the effective root. This mismatch is the deeper cause but fixing it is a larger change (see Issue 3 plan).

## Edge-Case & Dependency Audit

**Race Conditions:**
- *Proactive refresh during pending selection:* A `kanbanPlansReady` from a proactive refresh (not the Review Plan's `fetchKanbanPlans`) arrives while `_pendingKanbanSelection` is set. The auto-set at lines 484-491 fires, narrowing the filter, potentially hiding the target plan before `tryResolvePendingKanbanSelection` runs. Fixed by suppressing auto-set while `_pendingKanbanSelection` is non-null.
- *Post-selection proactive refresh:* After the selection resolves (`_pendingKanbanSelection = null`), a proactive `kanbanPlansReady` arrives and re-sets the filter to `kanbanWorkspaceRoot`. If the user was viewing "All Workspaces" in the Project panel before the Review Plan click, this narrows their view without consent. Fixed by restoring the user's prior filter after selection, or by not auto-setting if the user manually widened the filter.

**Side Effects:**
- Suppressing the auto-set during pending selection means the Project panel's workspace filter stays at "All Workspaces" during the Review Plan flow. This is correct — the force-clear in `tryResolvePendingKanbanSelection` already sets it to widest, and the filter intent narrows only if the target workspace is in the dropdown.

**Dependencies & Conflicts:**
- Related to Issue 3 (autism360 plans not showing) — the same `kanbanWorkspaceRoot` auto-set mechanism contributes to both bugs. The fix here (suppress during pending selection) is independent of the Issue 3 fix (workspace root mismatch between dropdown and plan tags).
- The prior fix's ready-handshake queue (`_projectPanelReady` / `_pendingProjectMessages`) is working correctly and should not be touched.

## Proposed Changes

### src/webview/project.js

**Change 1: Suppress `kanbanWorkspaceRoot` auto-set during pending Review Plan selection (lines 484-491)**

The auto-set at lines 484-491 sets `kanbanFilters.workspaceRoot` to `kanbanWorkspaceRoot` whenever the filter is empty. This fights with the Review Plan flow's filter-clearing. Suppress it when a pending selection is active:

```js
// BEFORE (line 484-491):
if (msg.kanbanWorkspaceRoot && _kanbanWorkspaceItems.some(ws => ws.workspaceRoot === msg.kanbanWorkspaceRoot)) {
    if (!kanbanFilters.workspaceRoot) {
        kanbanFilters.workspaceRoot = msg.kanbanWorkspaceRoot;
    }
    if (!featuresFilters.workspaceRoot) {
        featuresFilters.workspaceRoot = msg.kanbanWorkspaceRoot;
    }
}

// AFTER:
// Suppress the workspace-filter auto-sync when a Review Plan navigation is
// in flight — the activateKanbanTabAndSelectPlan handler deliberately cleared
// filters to widest, and re-setting them here hides the target plan before
// tryResolvePendingKanbanSelection can find it. The auto-sync resumes once
// the selection resolves (_pendingKanbanSelection is nulled).
if (!_pendingKanbanSelection && msg.kanbanWorkspaceRoot && _kanbanWorkspaceItems.some(ws => ws.workspaceRoot === msg.kanbanWorkspaceRoot)) {
    if (!kanbanFilters.workspaceRoot) {
        kanbanFilters.workspaceRoot = msg.kanbanWorkspaceRoot;
    }
    if (!featuresFilters.workspaceRoot) {
        featuresFilters.workspaceRoot = msg.kanbanWorkspaceRoot;
    }
}
```

**Change 2: Also suppress the filter-intent application's fallback when the intent workspaceRoot doesn't match any dropdown option (lines 496-516)**

Currently, if the filter intent's workspaceRoot doesn't match any dropdown option, the filter stays at whatever was set by lines 484-491 (or `''` if that was suppressed). This is correct behavior — the plan will be found at widest. But the filter intent's project/column narrowing (lines 521-538) can still hide the plan. Add a guard: if the workspace intent couldn't be applied, skip the project/column intent too (since the project dropdown is workspace-dependent):

```js
// AFTER (lines 496-516), add tracking of whether the workspace intent applied:
if (_pendingKanbanFilterIntent) {
    const intent = _pendingKanbanFilterIntent;
    let workspaceIntentApplied = false;
    if (intent.workspaceRoot && kanbanWorkspaceFilter) {
        const opts = Array.from(kanbanWorkspaceFilter.options).map(o => o.value);
        const intentNorm = normalizeRoot(intent.workspaceRoot);
        if (opts.some(o => normalizeRoot(o) === intentNorm)) {
            kanbanFilters.workspaceRoot = intent.workspaceRoot;
            kanbanWorkspaceFilter.value = intent.workspaceRoot;
            workspaceIntentApplied = true;
        }
    }
    // ... feature workspace filter intent (unchanged) ...

    // Store whether the workspace intent applied for the project/column section below.
    intent._workspaceIntentApplied = workspaceIntentApplied;
}
```

```js
// AFTER (lines 521-538), guard project/column intent on workspace intent:
if (_pendingKanbanFilterIntent) {
    const intent = _pendingKanbanFilterIntent;
    // Only apply project/column narrowing if the workspace intent succeeded —
    // otherwise the project dropdown options are from the wrong workspace and
    // the narrowing hides the target plan.
    if (intent._workspaceIntentApplied !== false && intent.project && kanbanProjectFilter) {
        const opts = Array.from(kanbanProjectFilter.options).map(o => o.value);
        if (opts.includes(intent.project)) {
            kanbanFilters.project = intent.project;
            kanbanProjectFilter.value = intent.project;
        }
    }
    if (intent._workspaceIntentApplied !== false && intent.column && kanbanColumnFilter) {
        const opts = Array.from(kanbanColumnFilter.options).map(o => o.value);
        if (opts.includes(intent.column)) {
            kanbanFilters.column = intent.column;
            kanbanColumnFilter.value = intent.column;
        }
    }
    _pendingKanbanFilterIntent = null;
}
```

### src/services/KanbanProvider.ts

**Change 3: Ensure `reviewPlan` sends the effective root that matches plan tags (line 8327-8328)**

The current code already resolves through `resolveEffectiveWorkspaceRoot`. Verify this is correct and add a fallback to the raw root if the effective root is empty:

```js
// BEFORE (line 8327-8328):
const reviewRawRoot = msg.workspaceRoot || this.getCurrentWorkspaceRoot() || '';
const reviewEffectiveRoot = reviewRawRoot ? this.resolveEffectiveWorkspaceRoot(reviewRawRoot) : '';

// AFTER:
const reviewRawRoot = msg.workspaceRoot || this.getCurrentWorkspaceRoot() || '';
let reviewEffectiveRoot = reviewRawRoot ? this.resolveEffectiveWorkspaceRoot(reviewRawRoot) : '';
// Fallback: if resolveEffectiveWorkspaceRoot returns empty or the raw root unchanged,
// use the raw root — _getKanbanPlans tags with effectiveRoot, which for unmapped
// workspaces is just path.resolve(root).
if (!reviewEffectiveRoot && reviewRawRoot) {
    reviewEffectiveRoot = path.resolve(reviewRawRoot);
}
```

## Verification Plan

1. **Repro the bug (pre-fix):** Open VS Code with multiple workspace folders (including one with workspace mappings). Open the kanban board. Switch workspace via the dropdown. Click Review Plan on a card from the new workspace. Observe: wrong plans shown or no plan selected.
2. **Apply fixes.** Run `npm run compile`.
3. **Test cold-open:** Close the Project panel. Switch workspace in kanban.html. Click Review Plan. Verify: Project panel opens, Kanban tab activates, target plan is selected and scrolled into view.
4. **Test warm-open (panel already open):** With Project panel open and Kanban tab active on a different workspace. Switch workspace in kanban.html. Click Review Plan. Verify: target plan is selected.
5. **Test mapped child workspace:** Select a child workspace that maps to a parent. Click Review Plan on a card. Verify: the plan (tagged with the parent/effective root) is found and selected, even though the dropdown might show the parent name.
6. **Test proactive refresh during selection:** Trigger a proactive refresh (e.g. move a card in kanban.html) while a Review Plan selection is pending. Verify: the auto-set at lines 484-491 is suppressed, the selection still resolves.
7. **Test normal browsing (no Review Plan):** Switch workspace in kanban.html. Open Project panel. Verify: the workspace filter auto-syncs to the kanban board's workspace (the auto-set at 484-491 still works when no pending selection).
8. **Run existing tests:** `npm test` — verify no regressions in `kanban-view-plan-removal-regression.test.js` and related.
