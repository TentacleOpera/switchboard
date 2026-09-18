# Tickets sidebar doesn't drill into subtasks when opening a subtask via the inline parent-doc subtask menu

> **Doc status (2026-07-20):** bugfix in the **switchboard** extension webview
> (`switchboard/src/webview/planning.js`). Diagnosed from source; fix specified
> below, not yet implemented.

## Goal

When a user opens a subtask from the **inline subtask list rendered inside the
parent ticket's detail pane** (the `tickets-subtasks-nav` block), the tickets
sidebar should switch into drill-down mode and show that parent's subtask list —
the same behavior as when the user clicks the parent card **in the sidebar**
itself. Today the sidebar stays on the top-level grouped list, which is
especially confusing after adding a subtask to a parent that previously had
none: the parent was opened without a sidebar drill-down, a subtask was added,
and clicking the new subtask inline still leaves the sidebar unchanged.

### Root problem / background

The tickets tab has two distinct ways to open a subtask, and only one of them
updates the sidebar:

1. **Sidebar card click** (`planning.js:9977`–`10027`, the delegated handler on
   `tickets-issues-container`). When a top-level card is clicked and the
   sidebar is not already in drill-down, it sets
   `_pendingDrillDownParentId = <parentId>` and calls
   `_maybeEnterDrillDown(provider, id)`. When the parent's full details
   arrive (`linearTaskDetailsLoaded` @ `planning.js:6672` /
   `clickupTaskDetailsLoaded` @ `planning.js:6834`), `_maybeEnterDrillDown`
   sees the pending id matches, finds `subtasks.length > 0`, and activates
   drill-down (`_sidebarDrillDownParentId`, `_drillDownSubtasks`,
   `_drillDownProvider`, `_drillDownParentTitle`). The sidebar re-renders
   showing the parent's subtask list. ✅

2. **Inline subtask nav click** (`planning.js:9817`–`9841`, the handler on
   `tickets-subtasks-nav`). This handler only:
   - toggles the `.selected` class on the clicked `.subtask-nav-item`,
   - sets `selectedLinearIssue` / `selectedClickUpIssue` from the detail cache
     (or calls `loadLinearTaskDetails` / `loadClickUpTaskDetails` to fetch),
   - re-renders the detail panel.

   It **never** touches `_pendingDrillDownParentId` or calls
   `_maybeEnterDrillDown`, so the sidebar never enters drill-down. ❌

### Root cause

The inline subtask nav handler was written to update only the detail pane; it
predates (or simply missed) the sidebar drill-down coupling that the sidebar
card handler has. There is also a second, related gap:

- **Add-subtask flow** (`planning.js:10184` `btn-add-subtask` →
  `clickupTaskCreated` @ `planning.js:7040` / `linearIssueCreated` @
  `planning.js:7069`). After a subtask is created, the handler calls
  `loadClickUpTaskDetails(parentId)` / `loadLinearTaskDetails(parentId)` to
  refresh the parent. Those `load*` functions (`planning.js:11744`,
  `planning.js:11782`) post `linearLoadTaskDetails` / `clickupLoadTaskDetails`
  but do **not** set `_pendingDrillDownParentId`. So when the parent's details
  come back with the new subtask, `_maybeEnterDrillDown` returns early
  (`_pendingDrillDownParentId !== id`) and the sidebar stays on the top-level
  list. The parent detail pane correctly shows the new subtask in its inline
  nav, but clicking that inline subtask still doesn't drill the sidebar (gap
  #1).

Both gaps share the same fix surface: ensure the sidebar drill-down is
activated whenever the user is viewing a parent's subtask, regardless of
whether they reached it via the sidebar card, the inline subtask nav, or the
add-subtask flow.

## Metadata

- **Complexity:** 4
- **Tags:** frontend, ui, ux, bugfix

## User Review Required

Yes — review the two clarifying notes added to the Edge-Case & Dependency
Audit (the intentional null-parent no-op, and the load-bearing
`subtasks.length > 0 ⇒ detailsFetched === true` invariant) before coding.
No design change from the original plan; the notes document invariants the
fix relies on so they are not broken by future edits.

## Complexity Audit

### Routine

- Reuse of the existing drill-down state machine (`_maybeEnterDrillDown`,
  `_resetSidebarDrillDown`, `_isDrillDownActive`, `_pendingDrillDownParentId`)
  from two additional call sites. No new state, no new render path.
- Single-file change (`src/webview/planning.js`). No backend, no
  extension-host, no `package.json`, no `*.ts`, no API contract changes.
- The sidebar list re-render is already triggered by
  `renderTicketsLinearPanel` → `renderTicketsLinearList` (and the ClickUp
  equivalent), so activating drill-down state before those calls is
  sufficient — no new render wiring.
- The add-subtask fix is a single-line `_pendingDrillDownParentId = parentId`
  insertion in each of the two `*Created` handlers; the existing
  `linearTaskDetailsLoaded` / `clickupTaskDetailsLoaded` →
  `_maybeEnterDrillDown` calls do the rest.

### Complex / Risky

- **Double-activation guard.** Clicking an inline subtask while already in
  drill-down for the same parent must be a no-op, not a reset (reset would
  flicker the sidebar and lose scroll position). Guard:
  `!_isDrillDownActive(provider) || _sidebarDrillDownParentId !== parentId`.
- **Load-bearing `detailsFetched` invariant.** `_maybeEnterDrillDown`
  (`planning.js:10862`) bails when `!detail.detailsFetched`. The inline-nav
  path assumes the parent's details are already fetched because the inline
  nav only renders when `selectedLinearIssue.subtasks.length > 0`. This
  holds *only because* `subtasks` on a detail-cache entry is populated
  exclusively by the `linearTaskDetailsLoaded` / `clickupTaskDetailsLoaded`
  handlers, which also set `detailsFetched = true`. The local-file-read path
  (`readLocalTicketFile`) does **not** populate `subtasks`. If a future change
  populates `subtasks` before `detailsFetched` flips, drill-down will silently
  no-op and leave `_pendingDrillDownParentId` stuck. Documented here so the
  invariant is not broken by a future edit.
- **Reset-then-set ordering.** `_resetSidebarDrillDown()` clears
  `_pendingDrillDownParentId` to null; the plan sets
  `_pendingDrillDownParentId = parentId` *after* the reset. The order is
  load-bearing — swapping the two lines silently breaks drill-down. No
  assertion guards it; the ordering must be preserved on edit.

## Edge-Case & Dependency Audit

### Race Conditions

- **Add-subtask async window.** After `_pendingDrillDownParentId = parentId`
  and `loadClickUpTaskDetails(parentId)` / `loadLinearTaskDetails(parentId)`,
  any concurrent reset (search @ `planning.js:2449`, filter @ `planning.js:9713`,
  provider switch @ `planning.js:11301` / `11366`) will clobber
  `_pendingDrillDownParentId` and the drill-down never activates. The window
  is effectively closed by the UI: `load*TaskDetails` nulls the selected
  issue and re-renders, which hides the inline nav (no subtasks to show on a
  null selection), removing the user's click surface during the fetch. The
  concurrent resets are themselves user-initiated and would reset drill-down
  intentionally. No change needed; recorded as audited.
- **No multi-threading.** The webview is single-threaded JS; the only
  re-entrancy is via the message queue. The `*Created` → `load*` →
  `*DetailsLoaded` chain is strictly ordered per parent.

### Security

- None. No user input is parsed, no HTML is injected, no API credentials are
  touched. The `data-subtask-id` / `data-provider` attributes are read with
  `dataset` (not `innerHTML`) and were already escaped at render time
  (`escapeAttr` @ `planning.js:11117` / `11679`).

### Side Effects

- **`loadLinearTaskDetails` / `loadClickUpTaskDetails` set
  `selectedLinearIssue = null` / `selectedClickUpIssue = null` then
  re-render.** The add-subtask flow calls these, briefly clearing the detail
  pane. Existing behavior, not in scope. The fix must not rely on
  `selectedLinearIssue` / `selectedClickUpIssue` being non-null at the moment
  drill-down activates — `_maybeEnterDrillDown` reads from the detail cache,
  not from the selected vars, so this is safe.
- **Sidebar list re-render.** Activating drill-down changes
  `_sidebarDrillDownParentId` / `_drillDownSubtasks`; the next
  `renderTickets*List` call draws the drill-down header + subtask cards
  instead of the top-level grouped list. This is the intended side effect.

### Dependencies & Conflicts

- **Already in drill-down for the same parent.** Clicking an inline subtask
  must not reset and re-enter drill-down (would flicker the sidebar and lose
  scroll position). Guard: only enter if `!_isDrillDownActive(provider)` or
  the active drill-down parent differs from the current parent.
- **Already in drill-down for a *different* parent.** Switching parents via
  the inline nav of a *different* parent's detail pane is not reachable from
  the inline nav alone (the inline nav only renders the *selected* parent's
  subtasks), so this is a non-issue in practice. If reached, the guard above
  handles it by resetting and re-entering.
- **Parent has no cached details yet / `detailsFetched` is false.**
  `_maybeEnterDrillDown` already handles this by leaving
  `_pendingDrillDownParentId` set and activating when details arrive. The
  inline-nav handler must set `_pendingDrillDownParentId` before calling it,
  mirroring the sidebar card handler. (In practice the inline-nav path always
  has `detailsFetched === true` — see the load-bearing invariant in
  Complexity Audit → Complex / Risky.)
- **Parent genuinely has zero subtasks.** `_maybeEnterDrillDown` already
  no-ops when `subtasks.length === 0`. The inline nav only renders when there
  is at least one subtask, so this branch is unreachable from the inline nav,
  but the add-subtask path must tolerate it (the parent *will* have one after
  creation, so this is fine).
- **Provider mismatch.** Drill-down is provider-scoped (`_drillDownProvider`).
  The inline nav carries `data-provider`; use it, do not infer from
  `lastIntegrationProvider` (the two should agree, but be explicit). The
  render code (`planning.js:11117` / `11679`) only ever emits
  `data-provider="linear"` or `data-provider="clickup"`, so the
  `if/else if` branch in the handler is exhaustive by construction; a
  fall-through `else` is not required, but the invariant is source-guaranteed
  and documented here.
- **Null-parent no-op (intentional).** If `selectedLinearIssue` /
  `selectedClickUpIssue` is null when an inline subtask is clicked, the
  optional chain `parent?.issue?.id` / `parent?.task?.id` yields `undefined`,
  the guard `if (parentId && ...)` short-circuits, and drill-down is not
  entered. This is intentional defense-in-depth: the inline nav only renders
  when the selected issue is non-null (the render @ `planning.js:11112` /
  `11674` reads `selectedLinearIssue.subtasks` and would throw before
  reaching the click handler if null), so the null branch is unreachable in
  practice. The no-op is silent by design — do not add a log, it would fire
  on a path that cannot occur.
- **Search / filter active.** Search (`planning.js:2446`) and filter
  (`planning.js:9713`) already call `_resetSidebarDrillDown()` before
  re-rendering the top-level list. Entering drill-down from the inline nav
  while a search/filter is active would be surprising — but the inline nav is
  only visible inside a parent detail pane, and search/filter operate on the
  sidebar list, so there is no direct conflict. No change needed; existing
  resets cover it.
- **No backend / extension-host dependency.** All changes are in
  `planning.js` (webview). No `package.json`, no `*.ts` host changes, no API
  contract changes.

## Dependencies

- None. Single-file webview change; no cross-plan or cross-session
  dependencies.

## Adversarial Synthesis

Key risks: (1) the `detailsFetched` invariant is load-bearing and
undocumented — a future change that populates `subtasks` before details load
silently breaks drill-down; (2) the reset-then-set ordering in the inline-nav
handler is unprotected against future reordering; (3) the null-parent no-op
fails silently with the same symptom as the bug being fixed. Mitigations:
document both invariants in this plan (done, in Complexity Audit → Complex /
Risky and Edge-Case & Dependency Audit → Dependencies & Conflicts), preserve
the ordering on edit, and treat the null-parent branch as intentional
defense-in-depth rather than a gap to fill.

## Proposed Changes

All changes are in **`src/webview/planning.js`**.

### 1. Inline subtask nav click handler — enter drill-down on the parent

`planning.js:9817`–`9841`. After resolving `subtaskId` / `provider`, before
the existing cache-hit-or-load branch, determine the parent id from the
*currently selected* parent (the inline nav only renders for the selected
parent) and enter drill-down.

The parent id is the ticket currently shown in the detail pane *that owns*
this subtask nav. The cleanest source is the selected issue's own parent
reference if present, but the selected issue at this point is still the
*parent* (the click handler hasn't swapped it yet). So read the parent from
`selectedLinearIssue` / `selectedClickUpIssue` **before** swapping to the
subtask.

```js
// Subtask navigation clicks
document.getElementById('tickets-subtasks-nav')?.addEventListener('click', (e) => {
    const item = e.target.closest('.subtask-nav-item');
    if (!item) return;
    const subtaskId = item.dataset.subtaskId;
    const provider = item.dataset.provider;
    const nav = document.getElementById('tickets-subtasks-nav');
    nav?.querySelectorAll('.subtask-nav-item').forEach(i => i.classList.remove('selected'));
    item.classList.add('selected');

    // Enter sidebar drill-down on the parent so the sidebar reflects the
    // subtask list we just opened a member of. The parent is the ticket
    // currently shown in the detail pane (the inline nav only renders for
    // it). Read it BEFORE swapping selected*Issue to the subtask below.
    if (provider === 'linear') {
        const parent = selectedLinearIssue;
        const parentId = parent?.issue?.id;
        if (parentId && (!_isDrillDownActive('linear') || _sidebarDrillDownParentId !== parentId)) {
            _resetSidebarDrillDown();
            _pendingDrillDownParentId = parentId;
            _maybeEnterDrillDown('linear', parentId);
        }
        if (linearIssueDetailCache.has(subtaskId)) {
            selectedLinearIssue = linearIssueDetailCache.get(subtaskId);
            renderTicketsLinearPanel();
        } else {
            loadLinearTaskDetails(subtaskId);
        }
    } else if (provider === 'clickup') {
        const parent = selectedClickUpIssue;
        const parentId = parent?.task?.id;
        if (parentId && (!_isDrillDownActive('clickup') || _sidebarDrillDownParentId !== parentId)) {
            _resetSidebarDrillDown();
            _pendingDrillDownParentId = parentId;
            _maybeEnterDrillDown('clickup', parentId);
        }
        if (clickUpTaskDetailCache.has(subtaskId)) {
            selectedClickUpIssue = clickUpTaskDetailCache.get(subtaskId);
            renderTicketsClickUpPanel();
        } else {
            loadClickUpTaskDetails(subtaskId);
        }
    }
});
```

Notes:
- `_maybeEnterDrillDown` reads subtasks from the parent's cached detail. If
  the parent's details are already fetched (they are — the inline nav only
  renders when `selectedLinearIssue.subtasks.length > 0`, which requires
  details to have loaded), drill-down activates synchronously and the next
  `renderTickets*Panel()` call (which calls `renderTickets*List`) will draw
  the drill-down list.
- The `_resetSidebarDrillDown()` before re-entering is only triggered when
  switching parents; for the same parent the guard short-circuits and no
  reset happens (no flicker).

### 2. Add-subtask flow — set pending drill-down so the reloaded parent drills in

`planning.js:7040`–`7048` (`clickupTaskCreated`) and `planning.js:7069`–`7077`
(`linearIssueCreated`). After a subtask is created and the parent is reloaded,
set `_pendingDrillDownParentId` so the detail-loaded handler activates
drill-down.

```js
// clickupTaskCreated — inside `if (_subtaskParent) { ... }`
if (_subtaskParent) {
    const parentId = _subtaskParent.id;
    _subtaskParent = null;
    const modalTitle = document.getElementById('create-ticket-modal-title');
    if (modalTitle) modalTitle.textContent = 'Create New Ticket';
    _pendingDrillDownParentId = parentId;   // NEW: drill in when details arrive
    loadClickUpTaskDetails(parentId);
}
```

```js
// linearIssueCreated — inside `if (_subtaskParent) { ... }`
if (_subtaskParent) {
    const parentId = _subtaskParent.id;
    _subtaskParent = null;
    const modalTitle = document.getElementById('create-ticket-modal-title');
    if (modalTitle) modalTitle.textContent = 'Create New Ticket';
    _pendingDrillDownParentId = parentId;   // NEW: drill in when details arrive
    loadLinearTaskDetails(parentId);
}
```

The existing `_maybeEnterDrillDown(provider, id)` calls at `planning.js:6672`
and `planning.js:6834` will now see `_pendingDrillDownParentId === id` and
activate drill-down once the parent's details (now including the new subtask)
arrive. No other change needed there.

### 3. (No-op safety) Ensure `_resetSidebarDrillDown` is not called by the
detail-loaded handlers

Verified: `linearTaskDetailsLoaded` (`planning.js:6660`–`6677`) and
`clickupTaskDetailsLoaded` (`planning.js:6830`–`6839`) do **not** reset
drill-down; they only call `_maybeEnterDrillDown`. So setting
`_pendingDrillDownParentId` in step 2 is safe and will not be clobbered. No
code change required; recorded here as an audited dependency.

## Verification Plan

### Automated Tests

None. The webview (`src/webview/planning.js`) is not unit-tested, and the
session directive skips automated tests. Verification is manual per the
checklist below. No compilation step is run (session directive skips it);
the change is JS-only and exercised by loading the extension webview.

### Manual Verification

1. **Sidebar-card path still works (regression).** Click a parent card in the
   sidebar that has subtasks → sidebar drills into the subtask list (existing
   behavior, must still pass).
2. **Inline-nav path now works.** Click a parent card in the sidebar (drills
   in), click "back to all tickets", then click the parent card again — wait,
   simpler: open a parent *via the sidebar* so its detail pane shows the
   inline subtask list. Click a subtask in the inline list → sidebar must now
   show the parent's subtask list (drill-down), with the clicked subtask
   highlighted in the detail pane.
3. **Inline-nav path without prior sidebar drill-down.** Open a parent that
   has subtasks by any means that leaves the sidebar on the top-level list
   (e.g. switch to the Tickets tab with the parent already selected from a
   previous session, or use search to surface it). Click a subtask in the
   inline nav → sidebar must drill into the parent's subtask list.
4. **Add-subtask path (the reported scenario).** Open a parent with **no**
   subtasks via the sidebar (sidebar does not drill in — correct, there's
   nothing to show). Click "Add Subtask", create a subtask. After the create
   succeeds, the sidebar must drill into the parent's subtask list showing
   the new subtask.
5. **No flicker on repeated inline clicks.** With the sidebar already drilled
   into parent P, click a different subtask in P's inline nav → sidebar must
   not reset/flicker; only the detail pane swaps. (Guard: same-parent
   short-circuit.)
6. **Provider isolation.** Switch from a Linear parent (drilled in) to a
   ClickUp parent and open its inline subtask → sidebar drills into the
   ClickUp parent's subtasks; the Linear drill-down state is gone.
7. **Back header.** After drill-down via inline nav, click the "back to all
   tickets" header in the sidebar → top-level list restored, parent restored
   as selected (existing `planning.js:9902`–`9916` path, must still work).

## Completion Summary

Implemented the sidebar drill-down coupling for both the inline subtask nav and the add-subtask flow in `src/webview/planning.js`. The inline `tickets-subtasks-nav` click handler now reads the currently-selected parent before swapping to the subtask, enters drill-down via `_resetSidebarDrillDown()` → `_pendingDrillDownParentId = parentId` → `_maybeEnterDrillDown(provider, parentId)` with a same-parent short-circuit guard to avoid flicker. The `clickupTaskCreated` and `linearIssueCreated` handlers now set `_pendingDrillDownParentId = parentId` before calling `load*TaskDetails(parentId)` so the existing `*TaskDetailsLoaded` → `_maybeEnterDrillDown` path activates drill-down once the refreshed parent details arrive. No issues encountered; the load-bearing invariants (reset-then-set ordering, `detailsFetched` ⇔ `subtasks.length > 0`, intentional null-parent no-op) were preserved as documented. Single-file change, no backend/host/contract edits.

## Review Findings

Reviewed the committed implementation (present in `6ce3948`; working tree clean) against the plan: inline nav handler at `planning.js:9820`–`9861`, add-subtask pending-id sets at `planning.js:7045` and `planning.js:7075`, and the unchanged `*TaskDetailsLoaded` → `_maybeEnterDrillDown` paths at `planning.js:6672` / `planning.js:6834`. Code matches the plan's specified diffs exactly; reset-then-set ordering, same-parent short-circuit guard, and provider-scoped `_isDrillDownActive` checks all present. Regression audit traced every caller of `_maybeEnterDrillDown` / `_resetSidebarDrillDown` / `_isDrillDownActive`; no double-trigger (render path never calls `_maybeEnterDrillDown`), no orphaned references, no race beyond the documented add-subtask async window (closed by UI hiding the inline nav during fetch). The `subtasks.length > 0 ⇒ detailsFetched === true` invariant was verified at the four `subtasks:` population sites (`planning.js:5940`, `5953`, `6658`, `6820`) — only the `*TaskDetailsLoaded` handlers (which also set `detailsFetched: true`) populate non-empty subtasks; `localTicketFileRead` only carries forward `existing?.subtasks` which themselves required a prior details load. `node --check` on `planning.js` passed (exit 0). No CRITICAL or MAJOR findings; no code fixes applied. Remaining risks: (1) NIT — manual verification step 5 ("click a different subtask in P's inline nav") is only reachable after navigating back to P, since the first subtask click swaps `selectedLinearIssue` to the subtask and the inline nav re-renders with the subtask's own subtasks (or hides); (2) NIT — the add-subtask path sets `_pendingDrillDownParentId` unconditionally even when drill-down is already active for the same parent, causing `_maybeEnterDrillDown` to re-write identical state on details arrival (harmless, render is deduped). Both are cosmetic, neither warrants a fix.
