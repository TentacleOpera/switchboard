# The command console can only ever dispatch to a coding seat, so Planner and Researcher are unreachable from the surface

## Goal

Let the command console dispatch a card to **any column that has a configured role** — Planner
and Researcher included — instead of being pinned to the three coding seats. Keep complexity
auto-routing as one explicitly-labelled option rather than the only reachable behaviour.

### Problem analysis

An operator intended to advance a plan to **Planned** (`PLAN REVIEWED`, role `planner`) and
pressed **DISPATCH**. The card landed in **Coder** (`CODER CODED`) and a coding agent started
on it. This was not a mislabelled button — **the console has no gesture that can reach the
planner column at all.**

The board has 12 columns, 8 of which have a dispatch role and are therefore valid dispatch
destinations:

| Column | Role | Reachable from the console? |
| --- | --- | --- |
| `RESEARCHER` | researcher | **no** |
| `PLAN REVIEWED` (Planned) | planner | **no** |
| `LEAD CODED` | lead | yes — only if complexity ≥ 7 |
| `CODER CODED` | coder | yes — only if complexity 5–6 |
| `INTERN CODED` | intern | yes — only if complexity 1–4 |
| `CODE REVIEWED` (Reviewed) | reviewer | **no** |
| `ACCEPTANCE TESTED` | tester | **no** |
| `TICKET UPDATER` | ticket_updater | **no** |

Three of eight, and never by choice — the operator cannot pick which. Evidence from the card
in question (`fbae8502-7dbf-4089-86ce-bb2f1078d867`, complexity `6`): `routed_to = CODER CODED`,
`dispatched_agent = coder`, `last_action` empty, and **no `plan_events` row at all**, so in the
audit trail the move is indistinguishable from a card nobody touched.

### Root cause

**The console's only reachable routing function is a coding-seat selector, not a next-column
router.**

`executeDispatch` (`src/webview/command.js:1408-1417`) POSTs `{ plan, workspaceRoot, ack }` and
never a `targetColumn`. With that field absent, `POST /kanban/dispatch` delegates to
`resolveAutoDispatchColumn` (`src/services/LocalApiServer.ts:2029-2036` →
`src/services/KanbanProvider.ts:9437-9478`). Every `return` in that function yields one of
three columns:

- `dynamicComplexityRoutingEnabled === false` → **`LEAD CODED`**
- complexity unknown → preferred role `lead` → **`LEAD CODED`**
- score 1–4 / 5–6 / 7+ → **`INTERN CODED`** / **`CODER CODED`** / **`LEAD CODED`**
- degradation only ever swaps one coding role for another live coding role

It is structurally incapable of returning `PLAN REVIEWED` or `RESEARCHER`. Its job is to pick
*which coding seat*, which is the board's Autocode idiom — a legitimate feature that the console
mistakenly adopted as the meaning of "dispatch".

**The server is already fully capable; only the console is not.** `/kanban/dispatch` accepts an
explicit `targetColumn` (`src/services/LocalApiServer.ts:1878`), canonicalises it
(`:2037-2042`), and refuses a role-less column with a clear 400 ("no dispatch role/action
configured"). Dispatching to the planner over HTTP works today — the surface just never asks.

**The data for the fix is already client-side.** `fetchColumns` keeps whole column objects,
including `role`, in `allColumns` (`src/webview/command.js:406-410`), and already builds three
dropdowns from them (`:430-447`). A destination selector needs no new endpoint, no new state,
and no server change.

Two secondary defects compound it:

- **The resolved destination is reported and then discarded.** The ack payload carries
  `column` and `routing: 'auto: <reason>'` (`src/services/LocalApiServer.ts:2166-2181`); the
  console reads only `seat`/`role` (`src/webview/command.js:1424-1425`). An auto-derived
  destination renders identically to a chosen one.
- **The view's one column control is a source filter dressed as a destination.**
  `dispatch-source-column-select` carries `aria-label="Dispatch Column"`
  (`src/webview/command.html:872`) but only filters which cards are listed
  (`src/webview/command.js:722-724`).

> **Superseded:** *this plan's first draft proposed relabelling the button "DISPATCH TO CODING",
> surfacing the chosen column in the chip, and explicitly declined to add a destination
> selector.*
> **Reason:** that is a cosmetic fix to a reachability bug. Naming the destination more honestly
> does not give the operator the planner column, which is the thing they were trying to reach.
> The "no picker" rule is about not building competing peer modes; it was never a reason to
> leave 5 of 8 dispatchable columns unreachable.
> **Replaced with:** a destination selector, with auto-routing demoted to one labelled option.

## Metadata

- **Complexity:** 4
- **Tags:** ui, ux, frontend, bugfix

## Complexity Audit (Routine vs Complex/Risky)

**Routine.** One dropdown in an existing view, populated from data the view already holds, sent
to a server field that already exists and is already validated. No new endpoint, no schema
change, no routing logic.

Decisions already made, so no reader has to re-open them:

- **Auto stays, as an explicit option, and stays the default.** Removing it would break the
  Autocode idiom operators rely on; hiding it is what caused this bug. It appears as
  "Auto — coding seat by complexity" so it can never be mistaken for "next column".
- **Destinations are filtered to columns with a `role`.** A role-less column (New, Staging,
  Backlog, Completed) fires nothing on drop and the server rejects it — offering it would
  manufacture a 400.
- **No confirmation step.** DISPATCH still fires on the first click.
- **Dispatch is not renamed to Advance.** Dispatch = change column *and* fire that column's
  agent; Move = change column silently. The two views keep that split.

## Edge-Case & Dependency Audit

- **Auto can throw, and that error must survive.** `resolveAutoDispatchColumn` raises
  `KanbanDispatchError` ("No eligible coding agent is live and visible") when no coding seat is
  available. That text must reach the chip verbatim; it is the operator's cue to pick an
  explicit destination instead.
- **Auto's answer must stay legible after the fact.** When Auto is chosen, the chip must render
  the returned `column` *and* `routing` reason — the one case where the operator did not pick
  the destination is the case where it must be reported.
- **Custom columns.** The role filter is data-driven, so a custom agent column with a role
  appears automatically; the list must not be hardcoded to the built-in eight.
- **Complexity `Unknown`.** Auto sends such cards to `LEAD CODED`; with an explicit destination
  the score is irrelevant. Neither path may present a defaulted score as a real one.
- **A card already in the destination column.** The server's non-success arm reports "card did
  not land in '<column>'"; dispatching a card to the column it already occupies must still fire
  the agent rather than report a phantom failure.
- **Selection persistence.** The destination must survive a card-selection change and a view
  switch, like the existing dropdowns do (`:449-470`), and must not silently reset to Auto.
- **Depends on:** `kanban-move-is-unwired-in-the-standalone-host.md` for the Move view only.
  The Dispatch changes here are independent and can ship first.
- **Both hosts.** `src/webview/command.{html,js}` is served by the standalone host and the
  extension from the same source, so these edits reach both; verification runs on both.

## Proposed Changes

### 1. `src/webview/command.html:868-890` — a destination control, and an honest source label

```html
<div class="list-header-row">
    <!-- was aria-label="Dispatch Column": it filters the LIST, it is not the target -->
    <select class="cmd-select" id="dispatch-source-column-select" style="max-width:200px;"
            aria-label="Show cards from column"></select>
    …
</div>
…
<div class="cmd-action-box" id="dispatch-action-box">
    <div id="dispatch-status-chip" class="status-chip hidden"></div>
    <div class="action-row">
        <select class="cmd-select" id="dispatch-target-select" aria-label="Dispatch to"></select>
        <button class="secondary-action-btn" id="btn-dispatch-view" disabled>VIEW</button>
        <button class="primary-action-btn" id="btn-dispatch" disabled>DISPATCH</button>
    </div>
</div>
```

### 2. `src/webview/command.js:420-447` — populate destinations from the roles already loaded

```js
const dispatchTargetSelect = document.getElementById('dispatch-target-select');
…
// Dispatch destinations = columns that actually fire an agent on drop. A column
// with no role fires nothing and the server rejects it, so never offer one.
if (dispatchTargetSelect) {
    const prev = dispatchTargetSelect.value;
    dispatchTargetSelect.innerHTML = '';
    const auto = document.createElement('option');
    auto.value = 'auto';
    auto.textContent = 'Auto — coding seat by complexity';
    dispatchTargetSelect.appendChild(auto);
    allColumns.filter(c => c.role).forEach(col => {
        const opt = document.createElement('option');
        opt.value = col.id;
        opt.textContent = col.label || col.id;
        dispatchTargetSelect.appendChild(opt);
    });
    dispatchTargetSelect.value =
        [...dispatchTargetSelect.options].some(o => o.value === prev) ? prev : 'auto';
}
```

### 3. `src/webview/command.js:1408-1417` — send the destination

```js
const target = dispatchTargetSelect ? dispatchTargetSelect.value : 'auto';
const res = await fetch('/kanban/dispatch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        plan: cardId,
        workspaceRoot: currentWorkspaceRoot,
        // 'auto' is passed through as-is: the server treats absent/'auto' as
        // complexity routing, so Auto keeps today's behaviour exactly.
        targetColumn: target,
        ack: true
    })
});
```

### 4. `src/webview/command.js:1424-1440` — report where it went, and why

```js
if (res.ok && result?.success !== false && result?.phase === 'dispatching') {
    const seatName = result?.seat || result?.role || 'agent';
    const dest = result?.column ? ` → ${result.column}` : '';
    // Only Auto needs its reason shown: it is the one case the operator did not choose.
    const why = (target === 'auto' && result?.routing) ? ` (${result.routing})` : '';
    dispatchStatusChip.textContent = `Dispatched${dest} — ${seatName} is receiving the prompt${why}`;
…
} else {
    // 4xx/5xx bodies name the column or the missing seat; don't flatten them.
    const errMsg = result?.error || `Dispatch failed (HTTP ${res.status})`;
```

### 5. `src/webview/command.js:1475-1480` — Move must not blame the card for an unwired host

```js
const body = await res.json().catch(() => null);
moveStatusChip.textContent = body?.seam === 'moveCard'
    ? 'Move unavailable on this host (not a card problem)'
    : (body?.error || 'Move failed on server');
```

## Verification Plan

**The bug, on either host:**
1. Select a card in New, set destination **Planned**, press DISPATCH. The card lands in
   `PLAN REVIEWED` and the **planner** agent receives the prompt — not a coder. This is the
   case that is impossible today.
2. Repeat with **Researcher** — lands in `RESEARCHER`, researcher seat receives the prompt.

**Auto is preserved exactly:**
3. Destination **Auto** on a complexity-6 card → `CODER CODED`, chip reads
   `Dispatched → CODER CODED — <seat> is receiving the prompt (auto: complexity 6 → coder)`.
4. Destination Auto with `dynamicComplexityRouting` off → `LEAD CODED`, chip names the reason.
5. Destination Auto with no coding seat live → the chip shows the server's
   "No eligible coding agent is live and visible" text verbatim.

**Guards:**
6. The destination list contains Auto plus exactly the role-bearing columns; New, Staging,
   Backlog and Completed never appear.
7. A custom agent column with a role appears in the list without a code change.
8. Changing the card selection or switching views and returning preserves the chosen
   destination; it does not silently reset to Auto.
9. The source dropdown's accessible name is "Show cards from column"; changing it re-filters
   the list and changes no destination.

**Advance path (needs plan 1):**
10. Move view → target `PLAN REVIEWED` → MOVE advances the card and starts **no** agent
    (`dispatched_agent` stays empty, no new terminal in `GET /health`) — the silent
    counterpart to step 1.
11. On a host where the seam is unwired, the Move chip reads "Move unavailable on this host".

**Regression fence:**
12. `POST /kanban/dispatch` with an explicit `targetColumn` and with it absent both behave as
    before for existing callers (CLI `dispatch` verb, board drag-drop), on both hosts.

**User Review Required:** None.
