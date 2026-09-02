# The command console's DISPATCH button reads as "advance one column" but starts a coding agent, and the destination it picks is never shown

## Goal

Make the command console incapable of confusing "advance this card to the next column" with
"hand this plan to a coding agent now". DISPATCH must state where the card is going and which
seat is taking it, and column advancement must belong to the Move view.

### Problem analysis

An operator on the mobile command console intended to advance a plan to **Planned**
(`PLAN REVIEWED`, the planner column) and pressed **DISPATCH**. The card instead landed in
**Coder** (`CODER CODED`) and a coding agent was started on it.

The board's own record shows what happened, on plan `fbae8502-7dbf-4089-86ce-bb2f1078d867`
(*"The grid's unit should be an agent, not a terminal"*):

| Field | Value |
| --- | --- |
| `complexity` | `6` |
| `routed_to` | `CODER CODED` |
| `dispatched_agent` | `coder` |
| `last_action` | *(empty)* |
| `plan_events` rows | **none** |

Complexity 6 falls in the 5–6 band, which routes to the coder seat. So the destination was
never chosen by the operator — it was derived from the plan's complexity score, server-side,
and never displayed. The card also carries **no `plan_events` row at all**, so from the audit
trail this move is indistinguishable from a card that was never touched; the six sibling plans
imported in the same batch all still sit in `CREATED` with `last_action = ''`, while every
*deliberately* moved card in `CODER CODED` carries `last_action = move-to-coder-coded` plus a
workflow event.

The operator's intent and the system's action differed by three columns and one running agent,
and nothing in the UI disclosed the difference before or after the click.

### Root cause

Four things compose. The first two are the defect; the last two are why it was easy to hit.

**Cause 1 — the console sends no destination, so the server picks one.**
`executeDispatch` (`src/webview/command.js:1408-1417`) POSTs only
`{ plan, workspaceRoot, ack }`. `/kanban/move` aside, `POST /kanban/dispatch` **does** accept a
`targetColumn` (`src/services/LocalApiServer.ts:1878`), and when it is omitted or `"auto"` the
handler delegates to the complexity router
(`src/services/LocalApiServer.ts:2029-2036` → `resolveAutoDispatchColumn`, default bands
1–4 intern / 5–6 coder / 7+ lead). The console always takes the auto path — not as a considered
default, but because it never had a destination to send.

**Cause 2 — the server reports the destination it chose and the console throws it away.**
The acked response payload already carries both `column: targetColumn` and
`routing: 'auto: <reason>'` (`src/services/LocalApiServer.ts:2166-2181`). The console reads
only `result?.seat || result?.role` (`src/webview/command.js:1424-1425`) and renders
"Dispatched — <seat> is receiving the prompt". The column is dropped on the floor. This is the
`CLAUDE.md` fallback rule applied to a **routing** read: an auto-derived destination that
behaves exactly like an operator-chosen one, with no record of which it was. The information
needed to make it visible is already on the wire.

**Cause 3 — the one column control in the Dispatch view is a *source* filter labelled like a
destination.** `dispatch-source-column-select` (`src/webview/command.html:872`) carries
`aria-label="Dispatch Column"`, and the script uses it to *filter which cards are listed*
(`src/webview/command.js:722-724`). A dropdown reading "Dispatch Column" sitting directly above
a button reading "DISPATCH" is a column picker next to a go button; reading that pair as
"move from here to the next column" is the natural interpretation, not a careless one.

**Cause 4 — the actual advance path was dead on this host.** The Move view POSTs
`/kanban/move`, which returns 503 on the standalone host because the `moveCard` seam is unwired
(see `kanban-move-is-unwired-in-the-standalone-host.md`). So the operator's correct affordance
had already failed, leaving DISPATCH as the only action button on the surface that did
anything at all.

## Metadata

- **Complexity:** 4
- **Tags:** ui, ux, frontend, bugfix

## Complexity Audit (Routine vs Complex/Risky)

**Routine, with one design decision already made.** No new endpoint, no new state, no server
change beyond a label: the destination and routing reason are already in the response, and the
Move view already exists as the advance path.

The decision worth naming: **this plan does not add a target-column picker to the Dispatch
view.** Dispatch stays one button with server-side routing — the surface must *tell the truth*
about where the card went, not grow a second column matrix that duplicates the Move view.
Peer "dispatch to column X" modes are explicitly out of scope.

There is also **no confirmation step.** DISPATCH continues to fire on the first click. The fix
is honest labelling before the click and a truthful chip after it, never an "Are you sure?"
gate.

## Edge-Case & Dependency Audit

- **The static label must not lie when routing is customised.** The bands are configurable and
  a custom routing map can send a card somewhere other than a coder seat, so the button must
  name the *kind* of destination ("Dispatch to coding") rather than a specific column, while
  the post-commit chip names the actual resolved column from the response.
- **Complexity may be `Unknown`.** Cards with no complexity score still route somewhere; the
  chip must render the resolved column whatever the routing reason, and must not present a
  defaulted score as a real one.
- **The 502 "card did not land" arm** (`LocalApiServer.ts` non-success payload) already names
  the expected column; the chip must render that error text rather than the generic
  "Dispatch outcome unknown".
- **The Move view is the advance path and is currently broken.** This plan's Move-view half is
  only observable once `kanban-move-is-unwired-in-the-standalone-host.md` lands. The
  console-side changes here are independent and can ship first.
- **Both hosts.** The command surface is served by the standalone host and the extension from
  the same `src/webview/command.{html,js}`, so these edits reach both; verification runs on
  both anyway, because the Move view's behaviour differs between them until plan 1 lands.
- **Audit gap is real but out of scope.** That a dispatch-driven move wrote no `plan_events`
  row is a genuine defect in the dispatch write path, not in the console. It is recorded here
  as evidence and left to its own plan — this plan changes no write path.

## Proposed Changes

### 1. `src/webview/command.html:872-890` — stop the markup implying a destination

```html
<!-- was: aria-label="Dispatch Column" — it filters the LIST, it is not the target -->
<select class="cmd-select" id="dispatch-source-column-select" style="max-width:200px;"
        aria-label="Show cards from column"></select>
…
<button class="primary-action-btn" id="btn-dispatch" disabled>
    DISPATCH TO CODING
</button>
```

Add one line of view copy under the action box making the split explicit:

```html
<p class="cmd-view-hint">Starts a coding agent. To advance a card to another column, use Move.</p>
```

### 2. `src/webview/command.js:1424-1434` — render the destination the server chose

```js
if (res.ok && result?.success !== false && result?.phase === 'dispatching') {
    const seatName = result?.seat || result?.role || 'agent';
    // The server already told us where the card went and why — say so. An
    // auto-routed column must never read like an operator-chosen one.
    const dest = result?.column ? ` → ${result.column}` : '';
    const why  = result?.routing ? ` (${result.routing})` : '';
    dispatchStatusChip.textContent = `Dispatched${dest} — ${seatName} is receiving the prompt${why}`;
```

### 3. `src/webview/command.js:1437-1440` — surface the real refusal text

```js
} else {
    // 4xx/5xx bodies name the column that was expected; don't flatten them.
    const errMsg = result?.error || `Dispatch failed (HTTP ${res.status})`;
```

### 4. `src/webview/command.js` — make Move's failure name the cause

In `executeMove`'s non-OK arm (`:1475-1480`), distinguish "this host cannot move cards" from a
rejected move, so the operator is not pushed toward DISPATCH by a misleading message:

```js
const body = await res.json().catch(() => null);
moveStatusChip.textContent = body?.seam === 'moveCard'
    ? 'Move unavailable on this host (not a card problem) — see logs'
    : (body?.error || 'Move failed on server');
```

## Verification Plan

**Console behaviour (either host):**
1. Select a card with complexity 6, press DISPATCH. The chip reads
   `Dispatched → CODER CODED — <seat> is receiving the prompt (auto: …)` — the column is
   visible without opening the board.
2. The button reads **DISPATCH TO CODING** at rest, and the view hint names Move as the
   advance path.
3. The source dropdown's accessible name is "Show cards from column"; changing it re-filters
   the card list and changes no destination.
4. A card in a column with no configured drop action returns the server's 400 text verbatim
   in the chip, not "Dispatch outcome unknown".

**Advance path:**
5. With `kanban-move-is-unwired-in-the-standalone-host.md` landed, Move view → target
   `PLAN REVIEWED` → MOVE advances the card to Planned and starts **no** agent
   (`dispatched_agent` stays empty; no new terminal appears in `GET /health`).
6. On a host where the seam is unwired, the Move chip reads "Move unavailable on this host",
   not "Move failed on server".

**Regression fence:**
7. `POST /kanban/dispatch` with an explicit `targetColumn` still honours it (the auto path is
   only taken when the field is absent or `"auto"`), on both hosts.

**User Review Required:** None.
