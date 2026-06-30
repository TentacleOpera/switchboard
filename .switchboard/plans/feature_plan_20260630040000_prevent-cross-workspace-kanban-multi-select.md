# Prevent Cross-Workspace Multi-Select on the Kanban Board

## Goal

The Kanban board allows the user to select plans that belong to **two different parent workspaces** at the same time. When they then click **ASSIGN** (reassign workspace/project) or **PROMOTE TO EPIC** / **GROUP INTO EPIC**, the operation fails:

- **ASSIGN** shows the warning `Cannot assign plans from multiple workspaces at once. Select plans from a single workspace and try again.` and aborts (see <ref_snippet file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html" lines="6803-6810" />).
- **PROMOTE / GROUP INTO EPIC** silently drops the cross-workspace subtask IDs, because `createEpicFromPlanIds` resolves subtasks against a **single** workspace DB (`this._getKanbanDb(workspaceRoot)`) — plans from any other workspace are not found by `db.getPlanByPlanId(pid)` and are discarded (see <ref_snippet file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts" lines="8534-8546" />).

The user wants the invalid state to be **impossible to reach in the first place**: you should not be able to have plans from two different workspaces selected simultaneously.

### Required Behavior

1. **Selecting a 2nd plan from a *different* workspace than the currently-selected plans must clear the prior selection** first, then add the newly clicked plan. This caps `selectedCards` at a single source workspace.
2. **Switching the workspace dropdown must NOT clear the selection.** This is critical: the entire cross-workspace **reassign** flow depends on selecting plan(s) in workspace A, then switching the dropdown to workspace B, then clicking ASSIGN. The dropdown switch changes the *target*; it must not wipe the *source* selection.
3. The clearing must happen **only at the moment a second plan from a different workspace is clicked**, never on workspace switch, never on board re-render.

### Root Cause

Card selection lives in the `selectedCards` Map in `kanban.html`. The click handler at <ref_snippet file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html" lines="5144-5167" /> adds a card to the map unconditionally:

```js
el.addEventListener('click', (e) => {
    if (e.target.closest('.card-btn') || e.target.closest('button')) return;
    const pid = el.dataset.planId || el.dataset.session || '';
    if (!pid) return;
    if (selectedCards.has(pid)) {
        selectedCards.delete(pid);
        el.classList.remove('selected');
    } else {
        const cardData = currentCards.find(c => (c.planId || c.sessionId) === pid);
        selectedCards.set(pid, {
            workspaceRoot: el.dataset.workspaceRoot || currentWorkspaceRoot,
            project: el.dataset.project || '',
            isEpic: cardData?.isEpic || false,
            epicId: cardData?.epicId || ''
        });
        el.classList.add('selected');
        ...
    }
    updateReassignButtonVisibility();
    updateEpicActionButton();
});
```

There is **no check** that the newly selected card's `workspaceRoot` matches the `workspaceRoot` of the cards already in `selectedCards`. So a plan from workspace B can be added while a plan from workspace A is still selected.

This is *intentionally* compounded by the prune logic in `renderBoard` (<ref_snippet file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html" lines="5043-5066" />), which deliberately **retains** cross-workspace selections across re-renders:

```js
// If the card belongs to a different workspace, do NOT prune it — it's
// invisible on the board right now but still tracked for cross-workspace ASSIGN.
if (cardWorkspaceRoot && cardWorkspaceRoot !== currentWorkspaceRoot) {
    continue;
}
```

That retention is correct **for the single-source-workspace reassign case** (select in A, switch to B, ASSIGN). The bug is solely that nothing prevents a *second source workspace* from entering the map via a fresh click. Once two source workspaces are present, the ASSIGN guard at line 6805 fires and the epic flow silently drops plans.

### Why the Fix Belongs in the Click Handler (Not the Action Buttons)

The error message at line 6808 is a **defensive backend-of-the-UI guard**, not the desired UX. By the time the user clicks ASSIGN, they have already built an invalid multi-workspace selection and must now deselect manually. The fix must be at the **selection entry point** so the invalid state is never constructed. The existing line-6808 guard should remain as a defense-in-depth backstop (it is harmless once the entry-point fix is in place).

## Metadata

- **Tags:** `kanban`, `webview`, `selection`, `cross-workspace`, `ux`, `bug`
- **Complexity:** 3/10
- **Files touched:** `src/webview/kanban.html` (single file, frontend-only)
- **Risk:** Low — isolated click-handler change; no DB, no backend, no migration.
- **Shipped state:** Kanban multi-select and cross-workspace ASSIGN are in a released version (~4,000 installs). This is a pure UX guard; no persisted state shape changes, so **no migration required**.

## Complexity Audit

**Routine.** The change is a single conditional block inside one event listener in `kanban.html`. No new abstractions, no cross-file plumbing, no async, no DB writes. The only subtlety is correctly identifying the "existing selection's workspace" when the map contains a mix of object-shaped and legacy string-shaped values (the codebase already handles both shapes at line 6783-6785 and 5045).

## Edge-Case & Dependency Audit

| Case | Expected Behavior |
|---|---|
| No prior selection, click plan in workspace A | Select it (unchanged). |
| One plan from A selected, click another plan from A | Add to selection (multi-select within one workspace stays allowed). |
| One plan from A selected, click plan from B | **Clear the A selection, then select only B.** Visual `.selected` class on A cards must be removed. |
| Plans from A selected, switch dropdown to B (no new click) | Selection **unchanged** — reassign flow preserved. |
| Plans from A selected, switch to B, click plan from B | Clear A, select B (per rule above). |
| Toggle-off a selected plan (click it again) | Deselect just that one (unchanged). Must not trigger a cross-workspace clear. |
| `selectedCards` contains legacy string values (not objects) | Treat the string as the workspace root, matching existing logic at line 5045/6784. |
| Bulk "select all in column" via header actions | These paths (`getSelectedInColumn` / `getAllInColumn`) operate within the currently rendered board, which is single-workspace, so they cannot introduce a second workspace. No change needed, but the click-handler guard covers any future cross-workspace bulk path too. |
| Board re-render after the clear | `renderBoard` prune logic (line 5043) is consistent: a single-workspace selection survives correctly. |
| Epic selected + non-epic from same workspace | "ADD TO EPIC" still works (same workspace). |
| Epic from A + non-epic from B | Clear A, select B only — prevents a nonsensical cross-workspace "ADD TO EPIC". |

**Dependencies:** None. The fix uses only `selectedCards`, `el.dataset.workspaceRoot`, and the existing `.selected` CSS class — all already in scope at the click handler.

## Proposed Changes

### File: `src/webview/kanban.html` — card click handler (lines 5144–5167)

Add a cross-workspace guard at the top of the `else` branch (before `selectedCards.set`). When the incoming card's workspace differs from the workspace of the cards already selected, clear the existing selection (both the map and the DOM `.selected` classes) before adding the new card.

**Before:**
```js
el.addEventListener('click', (e) => {
    if (e.target.closest('.card-btn') || e.target.closest('button')) return;
    const pid = el.dataset.planId || el.dataset.session || '';
    if (!pid) return; // Skip if no valid ID — also prevents empty selectPlan message
    if (selectedCards.has(pid)) {
        selectedCards.delete(pid);
        el.classList.remove('selected');
    } else {
        const cardData = currentCards.find(c => (c.planId || c.sessionId) === pid);
        selectedCards.set(pid, {
            workspaceRoot: el.dataset.workspaceRoot || currentWorkspaceRoot,
            project: el.dataset.project || '',
            isEpic: cardData?.isEpic || false,
            epicId: cardData?.epicId || ''
        });
        el.classList.add('selected');
        // Sync sidebar dropdown on unmodified single clicks
        if (!e.shiftKey && !e.metaKey && !e.ctrlKey) {
            postKanbanMessage({ type: 'selectPlan', sessionId: el.dataset.session || '', planId: pid });
        }
    }
    updateReassignButtonVisibility();
    updateEpicActionButton();
});
```

**After:**
```js
el.addEventListener('click', (e) => {
    if (e.target.closest('.card-btn') || e.target.closest('button')) return;
    const pid = el.dataset.planId || el.dataset.session || '';
    if (!pid) return; // Skip if no valid ID — also prevents empty selectPlan message
    if (selectedCards.has(pid)) {
        selectedCards.delete(pid);
        el.classList.remove('selected');
    } else {
        const incomingWorkspaceRoot = el.dataset.workspaceRoot || currentWorkspaceRoot;

        // Cross-workspace guard: the board must never hold plans from two
        // different parent workspaces at once — doing so breaks ASSIGN
        // ("Cannot assign plans from multiple workspaces at once") and
        // silently drops subtasks during PROMOTE/GROUP INTO EPIC.
        // When the incoming card belongs to a different workspace than the
        // existing selection, clear the prior selection first. This clear
        // happens ONLY on selecting a new plan, never on a workspace dropdown
        // switch, so the cross-workspace reassign flow (select in A, switch
        // dropdown to B, ASSIGN) keeps working.
        if (selectedCards.size > 0) {
            const existingWorkspaceRoots = new Set(
                Array.from(selectedCards.values()).map(val =>
                    val && typeof val === 'object' ? val.workspaceRoot : val
                )
            );
            // If every existing entry is from a single workspace that differs
            // from the incoming card's workspace, wipe the prior selection.
            if (existingWorkspaceRoots.size === 1 &&
                !existingWorkspaceRoots.has(incomingWorkspaceRoot)) {
                selectedCards.clear();
                document.querySelectorAll('.kanban-card.selected')
                    .forEach(sel => sel.classList.remove('selected'));
            }
        }

        const cardData = currentCards.find(c => (c.planId || c.sessionId) === pid);
        selectedCards.set(pid, {
            workspaceRoot: incomingWorkspaceRoot,
            project: el.dataset.project || '',
            isEpic: cardData?.isEpic || false,
            epicId: cardData?.epicId || ''
        });
        el.classList.add('selected');
        // Sync sidebar dropdown on unmodified single clicks
        if (!e.shiftKey && !e.metaKey && !e.ctrlKey) {
            postKanbanMessage({ type: 'selectPlan', sessionId: el.dataset.session || '', planId: pid });
        }
    }
    updateReassignButtonVisibility();
    updateEpicActionButton();
});
```

### No other files require changes

- **`renderBoard` prune logic (lines 5043–5066):** Unchanged. It still retains cross-workspace selections across re-renders, which is correct for the single-source reassign flow. With the click-handler guard in place, the map can never contain *two* source workspaces, so the retained entries are always from one workspace.
- **ASSIGN guard (lines 6803–6810):** Unchanged. Remains as defense-in-depth; it will simply never fire under normal click-driven selection once the guard is in place.
- **`createEpicFromPlanIds` (KanbanProvider.ts):** Unchanged. Backend stays robust against bad input.
- **Workspace dropdown switch handler (`updateWorkspaceSelection`, line 6018):** Unchanged. It must NOT touch `selectedCards` — this preserves the reassign flow.

## Verification Plan

1. **Build:** `npm run compile` (webpack) — confirm no errors. (Note: `dist/` is not used during dev testing; verification is via installed VSIX per project rules.)
2. **Manual — multi-workspace selection prevented:**
   - Open the Kanban board with ≥2 workspaces registered.
   - Click a plan card in workspace A → it becomes `.selected`, ASSIGN count = 1.
   - Switch the workspace dropdown to workspace B → the A card is no longer rendered, but `selectedCards` still holds it (ASSIGN count still 1). *This confirms the dropdown switch does NOT clear selection.*
   - Click a plan card in workspace B → the A selection is cleared, only the B card is `.selected`, ASSIGN count = 1 (not 2).
3. **Manual — cross-workspace reassign still works:**
   - In workspace A, select one plan.
   - Switch dropdown to workspace B (do NOT click any B card).
   - Click ASSIGN → the plan is reassigned from A to B and the board refreshes to show it in B. *Confirms the reassign flow is intact.*
4. **Manual — same-workspace multi-select still works:**
   - In workspace A, click plan 1, then plan 2 (both A) → both stay `.selected`, ASSIGN count = 2, GROUP INTO EPIC available.
5. **Manual — toggle-off unaffected:**
   - With two A plans selected, click one again → it deselects, the other remains. No cross-workspace clear fires.
6. **Manual — promote/group into epic:**
   - Select 2 plans from the same workspace → GROUP INTO EPIC creates an epic with both as subtasks.
   - Attempt the old broken path (select A plan, switch to B, select B plan) → now only B is selected; GROUP INTO EPIC acts on B only, no silent drop.
7. **Regression — existing kanban tests:** run `npm test` for kanban-related suites (e.g. `src/test/kanban-*.test.js`) and confirm no failures.
