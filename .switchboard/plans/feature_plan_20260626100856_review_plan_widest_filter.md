# Bug: Review Plan Button Opens Widest Filter Instead of Narrowest

## Goal

Fix the "Review Plan" button so it opens the project panel's Kanban Plans tab
with the plan's own workspace, project, and column filters set — not the
widest "All Workspaces / All Projects / All Columns" view.

### Problem
Clicking "Review Plan" on a card in `kanban.html` opens the plan in the Project
panel (`project.html`) Kanban Plans tab, but it defaults to the widest possible
filter — "All Workspaces", "All Projects", "All Columns". This is confusing
because the user sees every plan on the board instead of the specific workspace,
project, and column the plan belongs to. It should open to the narrowest filter
— the plan's own workspace, project, and column.

### Background
The "Review Plan" button in `kanban.html` (handler at `src/webview/kanban.html`
lines 5130-5143) posts a `reviewPlan` message to the extension:

```javascript
document.querySelectorAll('.card-btn.review').forEach(btn => {
    btn.addEventListener('click', () => {
        const pid = btn.dataset.planId || btn.dataset.session || '';
        const cardData = currentCards.find(c => (c.planId || c.sessionId) === pid);
        postKanbanMessage({
            type: 'reviewPlan',
            sessionId: btn.dataset.session || '',
            planId: btn.dataset.planId || '',
            planFile: btn.dataset.planFile || '',
            workspaceRoot: btn.dataset.workspaceRoot,
            isEpic: cardData?.isEpic || false
        });
    });
});
```

The backend handler in `KanbanProvider.ts` (lines **6749-6771** — corrected from
the original plan's 6676-6697, which pointed at the `completeAll` case) opens/reveals the
project panel and posts `activateKanbanTabAndSelectPlan`:

```typescript
case 'reviewPlan': {
    const reviewId = this._resolveSessionId(msg.planId, msg.sessionId);
    if (reviewId && this._planningPanelProvider) {
        if (!this._planningPanelProvider.hasProjectPanel()) {
            await this._planningPanelProvider.openProject();
        } else if (this._planningPanelProvider.isProjectInCurrentWindow()) {
            this._planningPanelProvider.revealProject();
        }
        this._planningPanelProvider.postMessageToProjectWebview({
            type: 'activateKanbanTabAndSelectPlan',
            planId: msg.planId || '',
            sessionId: reviewId,
            planFile: msg.planFile || '',
            workspaceRoot: msg.workspaceRoot || '',
            isEpic: msg.isEpic === true
        });
    }
    break;
}
```

The project panel handler in `project.js` (lines 395-434) receives
`activateKanbanTabAndSelectPlan` and **explicitly clears all filters to the
widest choice**:

```javascript
case 'activateKanbanTabAndSelectPlan': {
    // ...
    _pendingKanbanSelection = { planId, sessionId, planFile, workspaceRoot };
    // Clear all filters so the target plan is guaranteed to be in the rendered
    // list regardless of workspace mapping (card.workspaceRoot is the actual
    // child folder but plan.workspaceRoot in the cache is the mapped parent).
    kanbanFilters.workspaceRoot = '';
    if (kanbanWorkspaceFilter) kanbanWorkspaceFilter.value = '';
    kanbanFilters.column = '';
    if (kanbanColumnFilter) kanbanColumnFilter.value = '';
    kanbanFilters.project = '';
    if (kanbanProjectFilter) kanbanProjectFilter.value = '';
    const kanbanTabBtn = document.querySelector('.shared-tab-btn[data-tab="kanban"]');
    if (kanbanTabBtn) kanbanTabBtn.click();
    tryResolvePendingKanbanSelection();
    break;
}
```

### Root Cause
The `activateKanbanTabAndSelectPlan` handler (project.js lines 419-427)
intentionally clears all filters to `''` ("All") with the comment: *"Clear all
filters so the target plan is guaranteed to be in the rendered list regardless of
workspace mapping."* This was a defensive choice to avoid the target plan being
hidden by a filter mismatch (the card's `workspaceRoot` is the child folder, but
the plan cache's `workspaceRoot` is the mapped parent).

The result: the user lands on "All Workspaces / All Projects / All Columns" and
sees the entire board instead of the plan's specific context.

Additionally, the `reviewPlan` message from `kanban.html` does NOT include the
plan's `project` or `column` — only `workspaceRoot`, `sessionId`, `planId`,
`planFile`, `isEpic`. So even if the project panel wanted to set narrow filters,
it doesn't receive the project/column values. The card data (`cardData`) in
kanban.html does have `project` and `column` available (the card object in
`currentCards` has both fields — confirmed at kanban.html line 4253
`cardData.column` and line 1235 `card.project`), but they aren't passed through.

**Workspace mapping detail (verified):** The kanban board cards
(`KanbanProvider.ts` line 1234) set `workspaceRoot: resolvedWorkspaceRoot` where
`resolvedWorkspaceRoot = path.resolve(workspaceRoot)` — the **actual child folder
root**. The project panel's plan cache (`PlanningPanelProvider.ts` line 7848)
sets `workspaceRoot: effectiveRoot` where `effectiveRoot =
this._resolveEffectiveWorkspaceRoot(workspaceRoot)` — the **mapped parent root**.
The project panel's workspace dropdown (`_kanbanWorkspaceItems`, built by
`_buildKanbanWorkspaceItems()`) uses effective roots. So in a multi-root setup
with mapping, the card's `workspaceRoot` (child) may not be in the project
panel's workspace dropdown, while the plan cache's `workspaceRoot` (parent) IS
in the dropdown.

**Bug status: STILL PRESENT** (verified in source).

## Metadata
**Tags:** bugfix, ui, ux
**Complexity:** 5

## User Review Required

This plan modifies the Review Plan navigation flow across three files. The
workspace-mapping fallback behavior (narrow → widest after retries) should be
confirmed as acceptable UX. No destructive operations; no data migration needed.

## Complexity Audit

### Routine
- Pass `project` and `column` from `kanban.html` in the `reviewPlan` message.
- Pass `project` and `column` through the backend `activateKanbanTabAndSelectPlan`
  message.
- Declare two new module-level variables (`_pendingKanbanFilterIntent`,
  `_pendingKanbanSelectionRetries`) near the existing pending-selection
  declarations.
- In `project.js`, set the narrow filters instead of clearing them, with
  option-exists guards.
- Apply the pending filter intent after dropdowns populate in the
  `kanbanPlansReady` handler.
- Add a retry counter to `tryResolvePendingKanbanSelection` with fallback to
  widest after 3 failed resolutions.
- Apply the same narrow-filter pattern to the epic review path.

### Complex / Risky
- **Workspace mapping mismatch.** The card's `workspaceRoot` (child folder) may
  not be in the project panel's workspace dropdown (which uses effective/mapped
  parent roots). The option-exists guard skips setting the workspace filter in
  this case, leaving it at whatever `kanbanPlansReady` lines 321-327 set (the
  effective root or "All"). This is the correct behavior — the plan cache uses
  the effective root, so filtering by it shows the plan. The fallback-to-widest
  handles rare cache divergence.
- **Filter intent ordering.** The workspace filter intent MUST be applied before
  `populateKanbanFilters()` so the project dropdown is built from the correct
  workspace. The project/column intent is applied after `populateKanbanFilters()`.
  See Change 4a/4b below.
- **`kanbanPlansReady` lines 321-327 interaction.** After Change 3 clears the
  workspace filter to '', lines 321-327 set it to `msg.kanbanWorkspaceRoot`
  (the project panel's current workspace, an effective root) if it's in
  `_kanbanWorkspaceItems`. Then Change 4a may override it with the card's
  workspace root. If the card's root isn't in the dropdown, the guard fails and
  the filter stays at `msg.kanbanWorkspaceRoot` — which is the correct value for
  the plan cache. No bug here, but the implementer must understand this flow.

## Edge-Case & Dependency Audit

- **Race Conditions:** The tab click fires `fetchKanbanPlans` (async). The
  filter intent is stashed synchronously in `_pendingKanbanFilterIntent` before
  the fetch response arrives. When `kanbanPlansReady` fires, the intent is
  applied. No race — the intent is consumed exactly once (set to `null` after
  application). If a second `kanbanPlansReady` fires (e.g. from a complexity
  edit), the intent is already null and doesn't reapply.
- **Security:** No security implications. Filter values are workspace paths and
  column/project names from the card data, not user input.
- **Side Effects:** Changing `kanbanFilters` affects the rendered plan list. The
  option-exists guards prevent setting a filter to a value not in the dropdown,
  which would silently fail (browser resets `<select>.value` to '').
- **Dependencies & Conflicts:** No dependency on other plans or sessions.
- **Epic review:** The epic path (lines 396-410) clears the epics workspace
  filter and switches to the epics tab. The same narrow-filter fix applies
  (Change 6 below).
- **Plan not in cache yet:** `tryResolvePendingKanbanSelection` retries on each
  `kanbanPlansReady`. If the narrow filter hides the plan due to a mapping
  mismatch, the retry counter triggers fallback to widest after 3 attempts.
- **Cross-window project panel:** If the project panel is in another window,
  `revealProject()` is skipped and only the message is posted. The filter values
  travel in the message, so this works regardless of window.
- **BACKLOG/CREATED column values:** Both 'BACKLOG' and 'CREATED' are valid
  column IDs in `VALID_KANBAN_COLUMNS` (KanbanDatabase.ts line 618) and both
  appear in the project panel's column dropdown (PlanningPanelProvider.ts lines
  7895-7900 adds BACKLOG). The card's `column` field matches the plan cache's
  `column` field — no mismatch. No special handling needed.

## Dependencies

None.

## Adversarial Synthesis

Key risks: (1) filter intent ordering — workspace intent must precede
`populateKanbanFilters()` so the project dropdown builds from the correct
workspace; (2) missing variable declarations would crash the handler in strict
mode; (3) retry counter must reset on new pending selection and increment only
on failed match. Mitigations: split Change 4 into 4a (workspace, before
`populateKanbanFilters`) and 4b (project/column, after); declare variables near
line 171; specify retry counter lifecycle precisely in Change 5.

## Proposed Changes

### File: `src/webview/project.js`

**Change 0 — Declare new module-level variables (near line 171-173).**

After the existing `let _pendingAutoEdit = false;` declaration (line 173), add:

```javascript
let _pendingKanbanFilterIntent = null;   // { workspaceRoot, project, column } — applied after dropdowns populate
let _pendingKanbanSelectionRetries = 0;  // incremented on failed resolution; fallback to widest at 3
```

**Change 1 — Set narrow filters instead of clearing them (lines 412-433, non-epic path).**

Replace the filter-clearing block in the `activateKanbanTabAndSelectPlan` handler
(non-epic branch, lines 412-433) with:

```javascript
_pendingKanbanSelection = {
    planId: msg.planId || '',
    sessionId: msg.sessionId || '',
    planFile: msg.planFile || '',
    workspaceRoot: msg.workspaceRoot || ''
};
_pendingAutoEdit = msg.autoEdit === true;
_pendingKanbanSelectionRetries = 0;  // reset retry counter for this selection

// Stash the desired narrow filters. They are applied AFTER the dropdowns
// populate in the kanbanPlansReady handler (Change 4a/4b). Each filter is
// only applied if the value is non-empty AND the corresponding dropdown has
// a matching option — otherwise it's left at "All" to avoid hiding the plan.
_pendingKanbanFilterIntent = {
    workspaceRoot: msg.workspaceRoot || '',
    project: msg.project || '',
    column: msg.column || ''
};

// Clear filters to widest NOW — the kanbanPlansReady handler will narrow them
// via the intent. This ensures the plan is visible if the cache already has
// data and tryResolvePendingKanbanSelection runs immediately below.
kanbanFilters.workspaceRoot = '';
if (kanbanWorkspaceFilter) kanbanWorkspaceFilter.value = '';
kanbanFilters.project = '';
if (kanbanProjectFilter) kanbanProjectFilter.value = '';
kanbanFilters.column = '';
if (kanbanColumnFilter) kanbanColumnFilter.value = '';

const kanbanTabBtn = document.querySelector('.shared-tab-btn[data-tab="kanban"]');
if (kanbanTabBtn) kanbanTabBtn.click();
tryResolvePendingKanbanSelection();
```

**Change 4a — Apply workspace filter intent BEFORE `populateKanbanFilters()` (kanbanPlansReady handler, between lines 329 and 330).**

After `populateWorkspaceDropdowns();` (line 329) and before
`populateKanbanFilters();` (line 330), insert:

```javascript
// Apply workspace filter intent from a Review Plan navigation.
// MUST run before populateKanbanFilters() so the project dropdown is
// built from the correct workspace.
if (_pendingKanbanFilterIntent) {
    const intent = _pendingKanbanFilterIntent;
    if (intent.workspaceRoot && kanbanWorkspaceFilter) {
        const opts = Array.from(kanbanWorkspaceFilter.options).map(o => o.value);
        if (opts.includes(intent.workspaceRoot)) {
            kanbanFilters.workspaceRoot = intent.workspaceRoot;
            kanbanWorkspaceFilter.value = intent.workspaceRoot;
        }
        // If the intent workspace isn't in the dropdown (child folder vs
        // mapped parent), leave the filter as-is — kanbanPlansReady lines
        // 321-327 already set it to the effective root, which matches the
        // plan cache. The plan remains visible.
    }
}
```

**Change 4b — Apply project/column filter intent AFTER `populateKanbanFilters()` (between lines 330 and 331).**

After `populateKanbanFilters();` (line 330) and before `renderKanbanPlans();`
(line 331), insert:

```javascript
// Apply project/column filter intent from a Review Plan navigation.
// Runs after populateKanbanFilters() so the project dropdown options are
// built from the (possibly just-changed) workspace filter.
if (_pendingKanbanFilterIntent) {
    const intent = _pendingKanbanFilterIntent;
    if (intent.project && kanbanProjectFilter) {
        const opts = Array.from(kanbanProjectFilter.options).map(o => o.value);
        if (opts.includes(intent.project)) {
            kanbanFilters.project = intent.project;
            kanbanProjectFilter.value = intent.project;
        }
    }
    if (intent.column && kanbanColumnFilter) {
        const opts = Array.from(kanbanColumnFilter.options).map(o => o.value);
        if (opts.includes(intent.column)) {
            kanbanFilters.column = intent.column;
            kanbanColumnFilter.value = intent.column;
        }
    }
    _pendingKanbanFilterIntent = null;  // consume the intent
}
```

**Change 5 — Retry counter with fallback to widest (function `tryResolvePendingKanbanSelection`, lines 1229-1245).**

Replace the function with:

```javascript
function tryResolvePendingKanbanSelection() {
    if (!_pendingKanbanSelection) return;
    const sel = _pendingKanbanSelection;
    const match = _kanbanPlansCache.find(p =>
        (sel.planFile && p.planFile === sel.planFile) ||
        (sel.planId && p.planId === sel.planId) ||
        (sel.sessionId && p.sessionId === sel.sessionId)
    );
    if (!match) {
        // Plan not in the (filtered) cache. After 3 failed attempts, fall back
        // to widest filters — the narrow filter may be hiding the plan due to
        // a workspace mapping mismatch or stale cache.
        if (++_pendingKanbanSelectionRetries >= 3) {
            kanbanFilters.workspaceRoot = '';
            if (kanbanWorkspaceFilter) kanbanWorkspaceFilter.value = '';
            kanbanFilters.project = '';
            if (kanbanProjectFilter) kanbanProjectFilter.value = '';
            kanbanFilters.column = '';
            if (kanbanColumnFilter) kanbanColumnFilter.value = '';
            _pendingKanbanSelection = null;  // stop retrying
            _pendingKanbanFilterIntent = null;  // don't re-narrow
            vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });
        }
        return;
    }
    const itemDiv = kanbanListPane && kanbanListPane.querySelector(`.kanban-plan-item[data-plan-id="${match.planId}"]`);
    if (!itemDiv) return;
    itemDiv.scrollIntoView({ behavior: 'smooth', block: 'center' });
    document.querySelectorAll('.kanban-plan-item').forEach(el => el.classList.remove('selected'));
    itemDiv.classList.add('selected');
    loadKanbanPlanPreview(match);
    _pendingKanbanSelection = null;
}
```

**Change 6 — Epic path: set narrow workspace filter (lines 396-410).**

Replace the epic branch of `activateKanbanTabAndSelectPlan` with:

```javascript
if (msg.isEpic === true) {
    _pendingEpicSelection = {
        planId: msg.planId || '',
        sessionId: msg.sessionId || '',
        planFile: msg.planFile || '',
        workspaceRoot: msg.workspaceRoot || ''
    };
    // Clear epics filters to widest now; the epicsPlansReady / kanbanPlansReady
    // handler will narrow them if the intent workspace is in the dropdown.
    epicsFilters.workspaceRoot = '';
    epicsFilters.column = '';
    if (epicsWorkspaceFilter) epicsWorkspaceFilter.value = '';
    if (epicsColumnFilter) epicsColumnFilter.value = '';
    // Stash intent for epics (reuse the same mechanism — applied in
    // kanbanPlansReady after populateWorkspaceDropdowns for the epics
    // workspace filter).
    _pendingKanbanFilterIntent = _pendingKanbanFilterIntent || {};
    _pendingKanbanFilterIntent.epicWorkspaceRoot = msg.workspaceRoot || '';
    const epicsTabBtn = document.querySelector('.shared-tab-btn[data-tab="epics"]');
    if (epicsTabBtn) epicsTabBtn.click();
    tryResolvePendingEpicSelection();
    break;
}
```

Then in Change 4a, after the kanban workspace filter block, add an epics block:

```javascript
// Apply epics workspace filter intent (from epic Review Plan navigation).
if (_pendingKanbanFilterIntent && _pendingKanbanFilterIntent.epicWorkspaceRoot && epicsWorkspaceFilter) {
    const epicWs = _pendingKanbanFilterIntent.epicWorkspaceRoot;
    const opts = Array.from(epicsWorkspaceFilter.options).map(o => o.value);
    if (opts.includes(epicWs)) {
        epicsFilters.workspaceRoot = epicWs;
        epicsWorkspaceFilter.value = epicWs;
    }
    _pendingKanbanFilterIntent.epicWorkspaceRoot = null;  // consume
}
```

### File: `src/webview/kanban.html`

**Change 7 — Include `project` and `column` in the reviewPlan message (lines 5130-5143).**

```javascript
document.querySelectorAll('.card-btn.review').forEach(btn => {
    btn.addEventListener('click', () => {
        const pid = btn.dataset.planId || btn.dataset.session || '';
        const cardData = currentCards.find(c => (c.planId || c.sessionId) === pid);
        postKanbanMessage({
            type: 'reviewPlan',
            sessionId: btn.dataset.session || '',
            planId: btn.dataset.planId || '',
            planFile: btn.dataset.planFile || '',
            workspaceRoot: btn.dataset.workspaceRoot,
            project: cardData?.project || btn.closest('.kanban-card')?.dataset.project || '',
            column: cardData?.column || '',
            isEpic: cardData?.isEpic || false
        });
    });
});
```

Note: `btn.dataset.project` is NOT used because the review button (line 5342)
does not have a `data-project` attribute — that attribute is on the parent
`.kanban-card` div (line 5332). The fallback uses `btn.closest('.kanban-card')`
to reach it. The primary source is `cardData?.project` from `currentCards`,
which is reliable.

### File: `src/services/KanbanProvider.ts`

**Change 8 — Pass `project` and `column` through to the project panel (lines 6761-6768).**

```typescript
this._planningPanelProvider.postMessageToProjectWebview({
    type: 'activateKanbanTabAndSelectPlan',
    planId: msg.planId || '',
    sessionId: reviewId,
    planFile: msg.planFile || '',
    workspaceRoot: msg.workspaceRoot || '',
    project: msg.project || '',
    column: msg.column || '',
    isEpic: msg.isEpic === true
});
```

## Verification Plan

### Automated Tests

No automated tests are part of this verification plan (skipped per session
directive). The test suite will be run separately by the user.

### Manual Verification

1. **Repro on current build:** Click "Review Plan" on a card in kanban.html.
   Confirm the project panel opens with "All Workspaces / All Projects / All
   Columns" (bug).
2. **Apply the fix** and rebuild.
3. **Narrow filter test:** Click "Review Plan" on a card in a specific workspace,
   project, and column. Confirm the project panel opens with that workspace,
   project, and column selected, and the target plan is visible and selected.
4. **Workspace mapping mismatch test:** Review a plan whose card workspaceRoot
   is a child folder but whose cache workspaceRoot is the mapped parent. Confirm
   the workspace filter stays at the effective root (set by kanbanPlansReady
   lines 321-327) and the plan is visible. If the plan is NOT visible after 3
   retries, confirm the fallback-to-widest kicks in and the plan becomes visible.
5. **Epic review test:** Click "Review Plan" on an epic. Confirm the epics tab
   opens with the epic's workspace filter set (not cleared to "All").
6. **Cross-window test:** With the project panel in a separate window, click
   Review Plan. Confirm the narrow filters apply in the other window.
7. **Dropdown-missing-option test:** Review a plan whose column isn't in the
   project panel's column dropdown. Confirm the column filter stays at "All"
   (guard works) and the plan is visible.
8. **Retry counter test:** Review a plan that's not in the cache yet (e.g., just
   created). Confirm the selection retries on each kanbanPlansReady and either
   resolves when the plan appears or falls back to widest after 3 retries.

---

**Recommendation: Send to Coder** (Complexity 5 — multi-file changes with moderate logic, extending existing patterns with well-scoped risks).

---

## Code Review (Reviewer Pass)

### Stage 1 — Grumpy Principal Engineer

*"Eight changes across three files, and you actually got them all right? Let me look harder..."*

- **PASS** — Change 0 (variable declarations): `_pendingKanbanFilterIntent` and `_pendingKanbanSelectionRetries` declared at `project.js:181-182`. Correct.
- **PASS** — Change 1 (non-epic narrow filters): `project.js:591-621` — stashes filter intent, clears filters to widest, clicks kanban tab, calls `tryResolvePendingKanbanSelection()`. Also clears `complexity` filter (line 614-615) — an addition beyond the plan but correct. Matches plan intent.
- **PASS** — Change 4a (workspace intent before `populateKanbanFilters`): `project.js:441-460` — applies workspace filter intent with option-exists guard, plus epics workspace intent. Correctly positioned before `populateKanbanFilters()` at line 461.
- **PASS** — Change 4b (project/column intent after `populateKanbanFilters`): `project.js:465-481` — applies project and column filter intents with option-exists guards, then consumes the intent (`_pendingKanbanFilterIntent = null`). Correctly positioned after `populateKanbanFilters()` and before `renderKanbanPlans()`.
- **PASS** — Change 5 (retry counter with fallback): `project.js:1542-1574` — increments `_pendingKanbanSelectionRetries` on failed match, falls back to widest after 3 retries, clears pending selection and intent, re-fetches. Retry counter reset at line 598 on new selection. Correct.
- **PASS** — Change 6 (epic path narrow workspace): `project.js:570-589` — clears epics filters, stashes `epicWorkspaceRoot` intent, switches to epics tab, calls `tryResolvePendingEpicSelection()`. Correct.
- **PASS** — Change 7 (kanban.html review button): `kanban.html:5157-5172` — includes `project: cardData?.project || btn.closest('.kanban-card')?.dataset.project || ''` and `column: cardData?.column || ''`. Correct.
- **PASS** — Change 8 (KanbanProvider backend): `KanbanProvider.ts:6786-6795` — passes `project: msg.project || ''` and `column: msg.column || ''` through to `activateKanbanTabAndSelectPlan`. Correct.
- **NIT** — After the fallback-to-widest (3 retries), `_pendingKanbanSelection` is set to `null` (line 1561), so the target plan is NOT auto-selected after the fallback. The user sees all plans but has to manually find the target. The plan's verification step 4 says "the plan becomes visible" (not "selected"), so this is by design. Acceptable tradeoff — auto-selecting after widening would require keeping `_pendingKanbanSelection` alive, risking infinite retry loops.
- **NIT** — The `tryResolvePendingKanbanSelection` call at line 490 is after `renderKanbanPlans()` (line 483), which is correct — the DOM must exist before querying for the plan item. But if `renderKanbanPlans` throws (e.g., malformed cache), the selection resolution would be skipped. This is a theoretical edge case — the existing code has no try/catch around `renderKanbanPlans` either.

### Stage 2 — Balanced Synthesis

**Keep:** Everything as implemented. All 8 changes are correctly implemented and match the plan.

**Fix now:** None required.

**Defer:** None.

### Validation Results

- **Variable declarations:** `project.js:181-182` — `_pendingKanbanFilterIntent` and `_pendingKanbanSelectionRetries` declared. Verified.
- **Non-epic path:** `project.js:591-621` — filter intent stashed, filters cleared, tab clicked, selection resolved. Verified.
- **Epic path:** `project.js:570-589` — epics filters cleared, epic workspace intent stashed, epics tab clicked. Verified.
- **Workspace intent (4a):** `project.js:441-460` — applied before `populateKanbanFilters()` with option-exists guard. Verified.
- **Project/column intent (4b):** `project.js:465-481` — applied after `populateKanbanFilters()` with option-exists guards, intent consumed. Verified.
- **Retry counter (5):** `project.js:1542-1574` — increments on failed match, falls back to widest at 3, re-fetches. Counter reset at line 598. Verified.
- **kanban.html (7):** `kanban.html:5157-5172` — `project` and `column` included in `reviewPlan` message. Verified.
- **KanbanProvider.ts (8):** `KanbanProvider.ts:6786-6795` — `project` and `column` passed through. Verified.
- **Call ordering:** `kanbanPlansReady` handler calls `renderKanbanPlans()` (483) → `tryResolvePendingKanbanSelection()` (490). Correct.
- **Compilation:** Skipped per session directive.
- **Tests:** Skipped per session directive.

### Files Changed

No files changed — implementation is correct as-is.

### Remaining Risks

- **Low:** After fallback-to-widest (3 retries), the target plan is visible but not auto-selected. By design per plan verification step 4.
- **Low:** If `renderKanbanPlans` throws, `tryResolvePendingKanbanSelection` is skipped (no try/catch). Theoretical — existing code has the same exposure.
- **Low:** Proactive "plans changed" pushes (without `allWorkspaceProjects`) could trigger the intent application before the workspace dropdown is populated. The option-exists guard handles this correctly (leaves filter as-is if the option isn't present).

### Summary

| Severity | Finding | Location |
|----------|---------|----------|
| NIT | No auto-select after fallback-to-widest | project.js:1561 |
| NIT | `tryResolvePendingKanbanSelection` skipped if `renderKanbanPlans` throws | project.js:483-490 |

**Fixes applied:** None — implementation is correct as-is.
**Remaining risks:** Fallback-to-widest doesn't auto-select (by design); theoretical `renderKanbanPlans` throw exposure (pre-existing).
