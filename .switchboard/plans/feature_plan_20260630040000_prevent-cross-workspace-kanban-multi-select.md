# Prevent Cross-Workspace Multi-Select on the Kanban Board

## Goal

The Kanban board allows the user to select plans that belong to **two different parent workspaces** at the same time. When they then click **ASSIGN** (reassign workspace/project) or **PROMOTE TO EPIC** / **GROUP INTO EPIC**, the operation fails:

- **ASSIGN** shows the warning `Cannot assign plans from multiple workspaces at once. Select plans from a single workspace and try again.` and aborts (see <ref_snippet file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html" lines="6799-6827" />).
- **PROMOTE / GROUP INTO EPIC** silently drops the cross-workspace subtask IDs, because `createEpicFromPlanIds` resolves subtasks against a **single** workspace DB (`this._getKanbanDb(workspaceRoot)`) — plans from any other workspace are not found by `db.getPlanByPlanId(pid)` and are discarded (see <ref_snippet file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts" lines="8534-8546" />).

The user wants the invalid state to be **impossible to reach in the first place**: you should not be able to have plans from two different workspaces selected simultaneously.

### Required Behavior

1. **Selecting a 2nd plan from a *different* workspace than the currently-selected plans must clear the prior selection** first, then add the newly clicked plan. This caps `selectedCards` at a single source workspace.
2. **Switching the workspace dropdown must NOT clear the selection.** This is critical: the entire cross-workspace **reassign** flow depends on selecting plan(s) in workspace A, then switching the dropdown to workspace B, then clicking ASSIGN. The dropdown switch changes the *target*; it must not wipe the *source* selection.
3. The clearing must happen **only at the moment a second plan from a different workspace is clicked**, never on workspace switch, never on board re-render.

### Root Cause

Card selection lives in the `selectedCards` Map in `kanban.html` (declared as a fresh `new Map()` at line 3802 — in-memory only, never persisted across webview reloads). The click handler at <ref_snippet file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html" lines="5161-5184" /> adds a card to the map unconditionally:

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

This is *intentionally* compounded by the prune logic in `renderBoard` (<ref_snippet file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html" lines="5053-5079" />), which deliberately **retains** cross-workspace selections across re-renders:

```js
// If the card belongs to a different workspace, do NOT prune it — it's
// invisible on the board right now but still tracked for cross-workspace ASSIGN.
if (cardWorkspaceRoot && cardWorkspaceRoot !== currentWorkspaceRoot) {
    continue;
}
```

That retention is correct **for the single-source-workspace reassign case** (select in A, switch to B, ASSIGN). The bug is solely that nothing prevents a *second source workspace* from entering the map via a fresh click. Once two source workspaces are present, the ASSIGN guard at line 6825 fires and the epic flow silently drops plans.

**Entry-point audit:** `selectedCards.set(...)` appears at exactly **one** site in the file — line 5170, inside this click handler. Every other `selectedCards` mutation is `.clear()` or `.delete()` (lines 4882, 5630, 5648, 5911, 6865, 7388, 9553, 9587, plus `.delete()` inside bulk action handlers). The bulk-select helpers `getSelectedInColumn` / `getAllInColumn` (lines 4394, 4414) only **read** IDs from the DOM / `currentCards`; they never `.set()` into the map. Therefore the click handler is the **sole entry point** for adding selections, and guarding it is both necessary and sufficient.

### Why the Fix Belongs in the Click Handler (Not the Action Buttons)

The error message at line 6825 is a **defensive backend-of-the-UI guard**, not the desired UX. By the time the user clicks ASSIGN, they have already built an invalid multi-workspace selection and must now deselect manually. The fix must be at the **selection entry point** so the invalid state is never constructed. The existing line-6825 guard should remain as a defense-in-depth backstop (it is harmless once the entry-point fix is in place).

### `data-workspace-root` is reliably populated

`createCardHtml` (line 5307) emits `data-workspace-root="${escapeAttr(card.workspaceRoot)}"` on every `.kanban-card` div (line 5376). So `el.dataset.workspaceRoot` is always set on rendered cards, and the `|| currentWorkspaceRoot` fallback in the click handler is pure defense-in-depth. The fix can rely on `el.dataset.workspaceRoot`.

## Metadata

- **Tags:** `ui`, `ux`, `bugfix`
- **Complexity:** 4/10
- **Files touched:** `src/webview/kanban.html` (single file, frontend-only)
- **Risk:** Low — isolated click-handler change; no DB, no backend, no migration.
- **Shipped state:** Kanban multi-select and cross-workspace ASSIGN are in a released version (~4,000 installs). This is a pure UX guard; no persisted state shape changes, so **no migration required**.

## User Review Required

Yes — the fix changes a user-visible selection behavior (clicking a card in a different workspace now silently clears the prior selection). The user should confirm this is the desired UX versus, e.g., showing a toast/tooltip explaining why the prior selection was cleared. The plan assumes silent clear is acceptable per the stated requirement ("the invalid state should be impossible to reach in the first place").

## Complexity Audit

### Routine
- Single conditional block added inside one existing event listener in `kanban.html`.
- No new abstractions, no cross-file plumbing, no async, no DB writes.
- Reuses the existing `.selected` CSS class and `selectedCards` Map — both already in scope.
- The `data-workspace-root` attribute the guard reads is already emitted by `createCardHtml` on every card.

### Complex / Risky
- The fix must **not** break the cross-workspace reassign flow (select in A, switch dropdown to B, ASSIGN). The guard must fire only on a fresh click of a different-workspace card, never on a workspace dropdown switch. The `updateWorkspaceSelection` handler (line 6035) does not touch `selectedCards`, so this is safe — but the distinction is critical to preserve.
- The guard must correctly handle both object-shaped and legacy string-shaped `selectedCards` values (the codebase handles both at lines 5062 and 6801).

## Edge-Case & Dependency Audit

| Case | Expected Behavior |
|---|---|
| No prior selection, click plan in workspace A | Select it (unchanged). |
| One plan from A selected, click another plan from A | Add to selection (multi-select within one workspace stays allowed). |
| One plan from A selected, click plan from B | **Clear the A selection, then select only B.** Note: after switching the dropdown to B, A cards are no longer in the DOM (the board re-renders per workspace), so the `.selected` DOM-class removal is a no-op for A cards; `selectedCards.clear()` is what actually removes them from the selection. |
| Plans from A selected, switch dropdown to B (no new click) | Selection **unchanged** — reassign flow preserved. `updateWorkspaceSelection` (line 6035) does not touch `selectedCards`. |
| Plans from A selected, switch to B, click plan from B | Clear A (from the map; A cards already absent from DOM), select B (per rule above). |
| Toggle-off a selected plan (click it again) | Deselect just that one (unchanged). Must not trigger a cross-workspace clear. |
| `selectedCards` contains legacy string values (not objects) | Treat the string as the workspace root, matching existing logic at line 5062/6801. |
| Bulk "select all in column" via header actions | These paths (`getSelectedInColumn` / `getAllInColumn`, lines 4394/4414) only **read** IDs from the DOM / `currentCards`; they never `.set()` into `selectedCards`. They operate within the currently rendered board, which is single-workspace, so they cannot introduce a second workspace. No change needed, but the click-handler guard covers any future cross-workspace bulk path too. |
| Board re-render after the clear | `renderBoard` prune logic (line 5053) is consistent: a single-workspace selection survives correctly. |
| Epic selected + non-epic from same workspace | "ADD TO EPIC" still works (same workspace). |
| Epic from A + non-epic from B | Clear A, select B only — prevents a nonsensical cross-workspace "ADD TO EPIC". |

**Dependencies:** None. The fix uses only `selectedCards`, `el.dataset.workspaceRoot`, and the existing `.selected` CSS class — all already in scope at the click handler.

## Dependencies

None. This is a self-contained frontend-only change with no prerequisite plans or sessions.

## Adversarial Synthesis

Key risks: (1) breaking the cross-workspace reassign flow if the guard accidentally fires on a workspace dropdown switch — mitigated by placing the guard only in the card click handler, never in `updateWorkspaceSelection`; (2) mishandling legacy string-shaped `selectedCards` values — mitigated by reusing the existing `val && typeof val === 'object' ? val.workspaceRoot : val` shape-detection pattern already used at lines 5062 and 6801; (3) the original `size === 1` guard silently no-oping on an already-multi-workspace map — mitigated by strengthening the guard to clear whenever *any* existing entry's workspace differs from the incoming card's workspace. The strengthened guard is simpler, more robust, and costs nothing extra.

## Proposed Changes

### File: `src/webview/kanban.html` — card click handler (lines 5161–5184)

Add a cross-workspace guard at the top of the `else` branch (before `selectedCards.set`). When the incoming card's workspace differs from the workspace of **any** card already selected, clear the existing selection (both the map and the DOM `.selected` classes) before adding the new card.

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
        // When the incoming card belongs to a different workspace than ANY
        // existing selection, clear the prior selection first. This clear
        // happens ONLY on selecting a new plan, never on a workspace dropdown
        // switch, so the cross-workspace reassign flow (select in A, switch
        // dropdown to B, ASSIGN) keeps working.
        if (selectedCards.size > 0) {
            const hasDifferentWorkspace = Array.from(selectedCards.values()).some(val => {
                const existingRoot = val && typeof val === 'object' ? val.workspaceRoot : val;
                return existingRoot !== incomingWorkspaceRoot;
            });
            if (hasDifferentWorkspace) {
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

**Why the strengthened guard (`hasDifferentWorkspace` over `size === 1`):** The original draft only cleared when `existingWorkspaceRoots.size === 1`. That silently no-ops if the map ever already holds 2+ workspaces — the exact invalid state the guard exists to prevent. While that state is currently unreachable (`selectedCards` is a fresh `new Map()` per webview load and this handler is the sole `.set()` site), the strengthened version — clear whenever *any* existing entry's workspace differs from the incoming — handles the theoretical case too, is simpler to reason about, and costs nothing extra. It also correctly clears same-workspace-as-incoming entries when a mixed selection exists, leaving only the newly clicked card selected.

### No other files require changes

- **`renderBoard` prune logic (lines 5053–5079):** Unchanged. It still retains cross-workspace selections across re-renders, which is correct for the single-source reassign flow. With the click-handler guard in place, the map can never contain *two* source workspaces, so the retained entries are always from one workspace.
- **ASSIGN guard (lines 6799–6827):** Unchanged. Remains as defense-in-depth; it will simply never fire under normal click-driven selection once the guard is in place.
- **`createEpicFromPlanIds` (KanbanProvider.ts):** Unchanged. Backend stays robust against bad input.
- **Workspace dropdown switch handler (`updateWorkspaceSelection`, line 6035):** Unchanged. It must NOT touch `selectedCards` — this preserves the reassign flow. Verified: it only updates `currentWorkspaceRoot`, filters, dropdowns, and the worktrees tab; it never reads or writes `selectedCards`.

## Verification Plan

> **Session directives:** Compilation (`npm run compile`) and automated tests (`npm test`) are SKIPPED for this session per user instruction. The test suite will be run separately by the user. Verification below is manual-only.

### Automated Tests

No automated tests are added or run as part of this session. The click handler lives in inline HTML (`kanban.html`) with no existing unit-test harness for DOM selection state. If a future test harness is added, the key assertions would be:
- After clicking a card in workspace B while a workspace-A card is selected, `selectedCards` contains only the B card.
- After switching the workspace dropdown (no card click), `selectedCards` is unchanged.
- After clicking two cards in the same workspace, `selectedCards` has both.

### Manual Verification

1. **Manual — multi-workspace selection prevented:**
   - Open the Kanban board with ≥2 workspaces registered.
   - Click a plan card in workspace A → it becomes `.selected`, ASSIGN count = 1.
   - Switch the workspace dropdown to workspace B → the A card is no longer rendered, but `selectedCards` still holds it (ASSIGN count still 1). *This confirms the dropdown switch does NOT clear selection.*
   - Click a plan card in workspace B → the A selection is cleared, only the B card is `.selected`, ASSIGN count = 1 (not 2).
2. **Manual — cross-workspace reassign still works:**
   - In workspace A, select one plan.
   - Switch dropdown to workspace B (do NOT click any B card).
   - Click ASSIGN → the plan is reassigned from A to B and the board refreshes to show it in B. *Confirms the reassign flow is intact.*
3. **Manual — same-workspace multi-select still works:**
   - In workspace A, click plan 1, then plan 2 (both A) → both stay `.selected`, ASSIGN count = 2, GROUP INTO EPIC available.
4. **Manual — toggle-off unaffected:**
   - With two A plans selected, click one again → it deselects, the other remains. No cross-workspace clear fires.
5. **Manual — promote/group into epic:**
   - Select 2 plans from the same workspace → GROUP INTO EPIC creates an epic with both as subtasks.
   - Attempt the old broken path (select A plan, switch to B, select B plan) → now only B is selected; GROUP INTO EPIC acts on B only, no silent drop.
6. **Manual — legacy string-shaped values (if reachable):**
   - If any code path still writes a bare string into `selectedCards`, confirm the guard's `val && typeof val === 'object' ? val.workspaceRoot : val` shape detection treats it as the workspace root, matching the existing logic at lines 5062 and 6801.

---

**Recommendation:** Complexity 4/10 → **Send to Coder.** The change is a single conditional block in one file (routine), but it guards a UX-critical cross-workspace reassign flow that must not break, elevating it above pure intern-level work.
