# Replace the Move-Ticket modal with the Source modal + Apply

## Goal

When a user clicks **Move** on a ticket in the planning.html Tickets tab, a
bespoke modal (`move-ticket-modal`) pops up. That modal is "really bad": it is
dynamically injected with inline styles, ignores the workspace theme, and
presents every possible move target as a single flat `<select size=10>` list of
`Space / Folder / List` paths with a free-text search box on top. For workspaces
with many spaces/folders/lists the list is long, un-navigable, and visually
inconsistent with the rest of the panel.

The user's request is explicit: **"why can't this just be the source modal then
you click apply?"** The Tickets tab already has a proper, themed **Source** modal
(`tickets-source-modal`) with a Provider selector and a Hierarchy nav
(`tickets-hierarchy-nav`) that lets users browse the provider hierarchy
(ClickUp spaces → folders → lists, or Linear projects). The fix is to reuse that
same hierarchy-browsing UI for choosing a move target, and add an **Apply**
button that performs the move — instead of the crude flat-dropdown modal.

### Problem analysis & root cause

- **Root cause:** `showMoveTicketModal(provider, ticketId)` (planning.js:998)
  hand-builds a brand-new modal DOM node every click, with hardcoded inline
  styles, a flat `<select>`, and a search input. It does not reuse the existing
  `tickets-source-modal` / `tickets-hierarchy-nav` infrastructure that already
  knows how to render and navigate the provider hierarchy.
- **Backend is fine:** `fetchMoveTargets` (PlanningPanelProvider.ts:6569) and
  `moveTicket` (PlanningPanelProvider.ts:6613) already return the right data and
  perform the move correctly. The problem is purely the front-end picker UX.
- **Symptoms:** (1) visually inconsistent with the rest of the panel (no theme
  classes, inline colors); (2) no hierarchy browsing — a flat list that doesn't
  scale; (3) duplicated target-fetching logic that could just reuse the
  hierarchy nav's existing fetch flow.

## Metadata

- **Tags:** ui, ux, refactor
- **Complexity:** 4

## User Review Required

Yes — the plan assumes the Source modal's hierarchy nav works for both ClickUp and Linear, but code exploration reveals the hierarchy nav (`tickets-hierarchy-nav`) is **ClickUp-only**. Linear uses a separate `tickets-project-picker` `<select>` in the main toolbar, not inside the Source modal. The plan's approach for Linear move-target selection needs a design decision: either (a) add a Linear project picker inside the Source modal for move mode, or (b) reuse the `fetchMoveTargets` flat list inside the Source modal for Linear (themed but not hierarchical). See the Superseded callouts in Proposed Changes and the Uncertain Assumptions section.

## Complexity Audit

**Routine.** This is a front-end UX refactor inside a single webview:

- No backend/API changes — `fetchMoveTargets` and `moveTicket` message handlers
  stay as-is.
- No data model or persistence changes.
- No cross-file architectural change — confined to `planning.js` (and a small
  static HTML addition to `planning.html` if we add an Apply button to the
  existing Source modal).
- The only mild risk is reusing the Source modal for two purposes (browsing the
  current source vs. picking a move target) without the two modes stepping on
  each other's state. Mitigated by an explicit `moveMode` flag (see below).

## Edge-Case & Dependency Audit

- **Two modes of one modal:** The Source modal is currently used to browse/change
  the active ticket source. Reusing it for move-target selection must not mutate
  the active source when the user is only picking a move target. → Introduce a
  `moveMode` flag on open; in move mode the hierarchy nav selects a target but
  does **not** fire the "set source" action; only the **Apply** button commits.
- **Linear "unassign from project":** The current move modal offers a checkbox to
  move a Linear issue out of its project (`targetId: null`). This must be
  preserved in the new flow — e.g. an "Unassign from project" checkbox shown only
  in Linear move mode, or an explicit "No project" option in the hierarchy.
- **ClickUp multi-list membership:** `moveTicketResult` already reports
  `remainsInLists` and `warning`. Keep surfacing these in the status footer.
- **Target cache:** `fetchMoveTargets` has a TTL cache
  (`MOVE_TARGETS_TTL_MS`). The hierarchy nav may use a different fetch path
  (`fetchRoots`/`fetchChildren`/`clickupLoadSpaces` etc.). Prefer reusing the
  hierarchy nav's existing fetch flow so the move picker stays consistent with
  what the user sees in Source mode; fall back to `fetchMoveTargets` only if the
  hierarchy flow can't yield a list/project id.
- **Modal teardown:** The current move modal is removed via
  `document.getElementById('move-ticket-modal')?.remove()` and on
  `moveTicketResult`. The new flow must clear `moveMode` state and any captured
  `moveTicketId`/`moveProvider` on close/cancel/apply to avoid a stale move on
  next open.
- **Refresh:** The existing move modal has a refresh button to bypass the cache.
  Keep a refresh affordance in move mode.

## Dependencies

None — this plan does not depend on any other plan or session. It is self-contained within `planning.js` and `planning.html`. The sibling subtask (status/assignee modals) touches different functions/DOM regions; no hard ordering constraint, though landing this plan first avoids line-number drift for the sibling's placement references near `showMoveTicketModal`.

## Uncertain Assumptions

- **Hierarchy nav is ClickUp-only.** The plan assumes `tickets-hierarchy-nav` renders for both ClickUp and Linear. Code exploration shows `renderTicketsClickUpHierarchyNav()` is ClickUp-only; `renderTicketsLinearPanel()` hides the hierarchy nav (`hierarchyNav.style.display = 'none'`) and Linear uses `tickets-project-picker` in the main toolbar instead. The user was advised to run web research to confirm whether a Linear hierarchy nav is planned or whether `fetchMoveTargets` is the intended Linear path.
- **`resetTicketsHierarchyNav(provider)` does not exist.** The plan proposes calling this function. No such function was found in `planning.js`. The implementer must either create it or reset the ClickUp hierarchy state manually (set `clickUpSelectedSpaceId/FolderId/ListId = ''` and re-render).
- **No "leaf selected" callback exists.** The plan says "wire the hierarchy nav's leaf selected callback." The hierarchy nav uses `<select>` change handlers (`tickets-space-select`, `tickets-folder-select`, `tickets-list-select`), not a callback. The implementer must guard the existing `tickets-list-select` change handler with a `_moveMode` check.

## Adversarial Synthesis

Key risks: (1) the plan's core assumption — that the hierarchy nav serves both providers — is wrong for Linear, leaving Linear move-target selection without a UI path unless a fallback is added; (2) `resetTicketsHierarchyNav` is referenced but does not exist, so the implementer must build the reset logic from scratch; (3) ClickUp move-mode navigation mutates the active hierarchy state (space/folder/list selection, issues array, statuses), which must be snapshotted and restored on exit or the user's active source is destroyed; (4) the `moveTargetsResult` handler is declared dead but is still the only way to populate a Linear target list if the hierarchy nav can't serve Linear. Mitigations: add a Linear target list inside the Source modal using `fetchMoveTargets` (themed flat list), snapshot/restore ClickUp hierarchy state on move-mode enter/exit, and keep `moveTargetsResult` for the Linear path rather than removing it.

## Proposed Changes

### 1. `src/webview/planning.html` — add an Apply button + move-mode slot to the Source modal

In `#tickets-source-modal` (around line 4200), extend the footer so it can host
both a "Close" button (browse mode) and an "Apply"/"Move" button (move mode),
plus the Linear unassign checkbox. Keep the existing Close button; add hidden
move-mode controls that are shown only when the modal opens in move mode.

```html
<!-- inside #tickets-source-modal .modal-body, after the Hierarchy block -->
<div id="tickets-source-move-controls" style="display:none; flex-direction: column; gap: 8px;">
  <div id="tickets-source-move-linear-unassign-wrap" style="display:none; font-size: 12px; color: var(--text-secondary);">
    <label style="display:flex; align-items:center; gap:4px;">
      <input type="checkbox" id="tickets-source-move-unassign"> Unassign from project
    </label>
  </div>
</div>
<!-- in the footer, alongside #btn-close-tickets-source-modal-action -->
<button id="btn-apply-move-ticket" class="strip-btn" style="display:none;">Move</button>
```

### 2. `src/webview/planning.js` — replace `showMoveTicketModal` with a move-mode opener for the Source modal

Replace the body of `showMoveTicketModal(provider, ticketId)` (lines 998–1112)
so that instead of building `#move-ticket-modal`, it opens `#tickets-source-modal`
in **move mode**:

```js
let _moveMode = false;
let _moveTicketId = null;
let _moveProvider = null;
let _moveSelectedTargetId = null;

function showMoveTicketModal(provider, ticketId) {
    _moveMode = true;
    _moveTicketId = ticketId;
    _moveProvider = provider;
    _moveSelectedTargetId = null;

    const modal = document.getElementById('tickets-source-modal');
    if (!modal) return;
    modal.style.display = 'block';

    // Show move-mode controls, hide the plain Close-only affordance styling
    document.getElementById('tickets-source-move-controls').style.display = 'flex';
    document.getElementById('btn-apply-move-ticket').style.display = '';
    document.getElementById('btn-apply-move-ticket').disabled = true;
    const unassignWrap = document.getElementById('tickets-source-move-linear-unassign-wrap');
    if (unassignWrap) unassignWrap.style.display = (provider === 'linear') ? 'block' : 'none';

    // Reset hierarchy nav to the provider's root so the user picks fresh
    // > **Superseded:** `resetTicketsHierarchyNav(provider)`
    // > **Reason:** No such function exists in `planning.js`. A search for `resetTicketsHierarchyNav` returns zero matches.
    // > **Replaced with:** Reset ClickUp hierarchy state manually: set `clickUpSelectedSpaceId = ''`, `clickUpSelectedFolderId = ''`, `clickUpSelectedListId = ''`, clear `clickUpAvailableFolders`/`clickUpAvailableListsInFolder`/`clickUpAvailableDirectLists`, set `_lastTicketsHierarchyHtml = ''` to force re-render, then call `renderTicketsClickUpHierarchyNav()`. For Linear, no hierarchy nav exists — see the Linear target-list note below.
}

function exitMoveMode() {
    _moveMode = false;
    _moveTicketId = null;
    _moveProvider = null;
    _moveSelectedTargetId = null;
    const controls = document.getElementById('tickets-source-move-controls');
    if (controls) controls.style.display = 'none';
    const applyBtn = document.getElementById('btn-apply-move-ticket');
    if (applyBtn) { applyBtn.style.display = 'none'; applyBtn.disabled = true; }
    const unassignWrap = document.getElementById('tickets-source-move-linear-unassign-wrap');
    if (unassignWrap) unassignWrap.style.display = 'none';
    const unassign = document.getElementById('tickets-source-move-unassign');
    if (unassign) unassign.checked = false;
}
```

Wire the hierarchy nav's "leaf selected" callback so that in move mode it sets
`_moveSelectedTargetId` and enables the Apply button (instead of switching the
active source).

> **Superseded:** "The existing hierarchy nav already produces a selected list id (ClickUp) or project id (Linear) — capture that id in move mode."
> **Reason:** The hierarchy nav (`tickets-hierarchy-nav`) is ClickUp-only. `renderTicketsLinearPanel()` hides it (`hierarchyNav.style.display = 'none'`). Linear uses `tickets-project-picker` in the main toolbar, not the Source modal. There is no "leaf selected callback" — the nav uses `<select>` change handlers (`tickets-space-select`, `tickets-folder-select`, `tickets-list-select`) wired in `attachTicketsHierarchyListeners()`.
> **Replaced with:** For ClickUp, guard the existing `tickets-list-select` change handler with a `_moveMode` check: if `_moveMode`, capture `listId` as `_moveSelectedTargetId` and enable Apply, `return` early (skip `loadClickUpProject` / `clickupSaveListSelection`). For Linear, add a themed target `<select>` inside `#tickets-source-move-controls` populated via `fetchMoveTargets` (the existing backend call), since no hierarchy nav exists for Linear. The `moveTargetsResult` handler must be repurposed to populate this new select (not removed as Step 4 originally proposed).

Wire the Apply button:

```js
document.getElementById('btn-apply-move-ticket')?.addEventListener('click', () => {
    if (!_moveMode) return;
    const unassign = document.getElementById('tickets-source-move-unassign');
    const isUnassign = _moveProvider === 'linear' && unassign && unassign.checked;
    const targetId = isUnassign ? null : _moveSelectedTargetId;
    if (!isUnassign && !targetId) return;
    setTicketsLoadingState(true);
    vscode.postMessage({
        type: 'moveTicket',
        provider: _moveProvider,
        ticketId: _moveTicketId,
        targetId,
        workspaceRoot: ticketsWorkspaceRoot
    });
});
```

Update the Source modal's close handlers (`btnCloseTicketsSourceModal`,
`btnCloseTicketsSourceModalAction`, and the backdrop click at lines 8617–8633)
to also call `exitMoveMode()` when closing.

### 3. `src/webview/planning.js` — update `moveTicketResult` handler to close the Source modal in move mode

In the `moveTicketResult` case (lines 5475–5514), replace the
`move-ticket-modal` removal with move-mode teardown:

```js
case 'moveTicketResult': {
    setTicketsLoadingState(false);
    if (_moveMode) {
        document.getElementById('tickets-source-modal').style.display = 'none';
        exitMoveMode();
    }
    // ... existing success/error + refreshTicketsDelta logic unchanged ...
    break;
}
```

### 4. `src/webview/planning.js` — repurpose `moveTargetsResult` for the Linear move path

> **Superseded:** "Remove the dead `moveTargetsResult` flat-list rendering. Once the move picker uses the hierarchy nav, this handler is dead code."
> **Reason:** The hierarchy nav is ClickUp-only. Linear move-target selection has no hierarchy nav to reuse, so `fetchMoveTargets` + `moveTargetsResult` is still needed to populate a Linear target list inside the Source modal.
> **Replaced with:** Keep `moveTargetsResult` but repoint it at the new `#tickets-source-move-target-select` element (instead of the removed `#move-target-select`). The handler populates the select with `msg.targets` and enables/disables the Apply button. The `window._allMoveTargets` search-filter logic from the old `showMoveTicketModal` should be re-wired to the new `#tickets-source-move-search` input. The backend `fetchMoveTargets` handler stays as-is.

## Verification Plan

1. **ClickUp move:** Open Tickets tab → ClickUp provider → click **Move** on a
   task. Confirm the Source modal opens in move mode (Apply button visible,
   hierarchy nav shown). Navigate to a target list, click **Apply**. Confirm the
   task moves (status footer shows "Moved ✓") and the modal closes. Confirm the
   active ticket source did **not** change.
2. **Linear move:** Same flow with Linear → pick a project → Apply. Confirm move
   succeeds.
3. **Linear unassign:** In Linear move mode, tick "Unassign from project" →
   Apply. Confirm the issue is unassigned (targetId null path) and the hierarchy
   select/Apply behavior disables appropriately.
4. **Cancel/close:** Open move mode, then close via X, Close button, or backdrop
   click. Confirm no move occurs and reopening Move on another ticket starts
   fresh (no stale `_moveTicketId`).
5. **Theme consistency:** Confirm the move picker now inherits the workspace
   theme (cyber/claudify) because it uses `tickets-source-modal` classes instead
   of inline styles.
6. **Refresh:** Confirm a refresh of the hierarchy nav in move mode re-fetches
   targets (bypassing cache).
7. **No regression on Source browse mode:** Open the Source modal via the
   Source button (not Move). Confirm Apply button is hidden and the hierarchy
   nav still switches the active source as before.
