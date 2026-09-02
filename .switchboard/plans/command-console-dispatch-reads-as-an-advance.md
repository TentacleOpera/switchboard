# The command console never implemented advance — it calls the coding-seat router directly, so every card jumps to a coding column

## Goal

Make the console's primary card action **the same advance the board already performs**: send the
selected cards and their column to the backend and let the backend resolve the next stage.
Remove the console's private routing behaviour entirely, and let the console select multiple
cards the way the board does.

### Problem analysis

On the board, pressing advance on a card in **New** sends it to **Planned** — the next stage.
On the command console, the equivalent button sent a card in New straight to **Coder** and
started a coding agent on it.

The two surfaces are not two implementations of one rule. **The board implements advance; the
console implements one stage's routing rule and applies it from every column.**

Board advance (`src/webview/kanban.html:9973-9978`) posts:

```js
postKanbanMessage({ type: 'promptSelected', column: backendColumn, sessionIds: [sessionId], workspaceRoot })
```

`column` is the card's **source** column. The destination is never sent — the backend derives
it (`KanbanProvider._advanceCards`, `handleServiceVerb('promptSelected')` at
`src/services/KanbanProvider.ts:11878`). The webview's own `getNextColumn` is used *only* to
predict the move optimistically, and it walks forward from the current column, skipping
role-less non-terminal columns. From `CREATED`, the next role-bearing column is
`PLAN REVIEWED` — Planned. Exactly what the operator expected.

Complexity banding is not part of advance. It applies to **one transition**: leaving
`PLAN REVIEWED` or `STAGING` for the coding stage, and only when dynamic complexity routing is
on (`src/webview/kanban.html:9928-9935`). That is where "which coding seat" is a real question.

The console (`src/webview/command.js:1408-1417`) posts to `/kanban/dispatch` with
`{ plan, workspaceRoot, ack }` and **no column at all** — neither source nor destination. With
`targetColumn` absent, the handler delegates to `resolveAutoDispatchColumn`
(`src/services/LocalApiServer.ts:2029-2036` → `src/services/KanbanProvider.ts:9437-9478`),
whose every return is `INTERN CODED`, `CODER CODED` or `LEAD CODED` — including the
routing-disabled branch and the unknown-complexity branch. So the console took the
Planned→coding rule and made it the meaning of its only button, for cards in any column.

The card that prompted this (`fbae8502-…`, complexity `6`) shows the result: `routed_to =
CODER CODED`, `dispatched_agent = coder`, `last_action` empty, **no `plan_events` row**. Two
stages skipped and an agent started, from a surface where no other action worked — the Move
view was already dead on that host (`kanban-move-is-unwired-in-the-standalone-host.md`).

### Root cause

The console reimplemented the card action instead of calling the existing one. Three
consequences follow from that single decision:

1. **Advance semantics were never ported.** The backend already owns next-stage resolution and
   already exposes it as the `promptSelected` verb (`KanbanProvider.ts:11878`), reachable
   through the `kanbanVerb` seam that `LocalApiServerOptions` already declares
   (`src/services/LocalApiServer.ts:363`) and that `/kanban/dispatch` already uses
   (`:1940`). Nothing needed to be invented; it needed to be called.
2. **The one routing rule it did wire is stage-specific.** `resolveAutoDispatchColumn` answers
   "which coding seat for this complexity?" — a question that is only meaningful for a card
   leaving Planned. Asked about a card in New, it still answers, because it has no notion of
   where the card is.
3. **Neither the source nor the destination is in the request**, so no layer can detect the
   mismatch. The server cannot tell that a card in New was never meant to reach a coding
   column, because the console never told it where the card was.
4. **Selection is a scalar, so only one card can ever act.** The console holds
   `selectedDispatchCardId` / `selectedMoveCardId` as single ids
   (`src/webview/command.js:28-30`), and `selectDispatchCard` overwrites rather than toggles
   (`:697`). The board holds `selectedCards` as a **Map** and a plain click on the card body
   toggles membership — add if absent, remove if present, no modifier key, no clearing of the
   other selections (`src/webview/kanban.html:9794-9798`; shift/meta/ctrl only govern whether
   the sidebar dropdown syncs at `:9831`). The board then picks `triggerAction` for one card and
   `triggerBatchAction` for several, both landing in `_advanceCards`. The backend verb has
   always taken an **array** — `promptSelected` requires `sessionIds` to be a non-empty array
   (`src/services/KanbanProvider.ts:11880`). So batch is not a new capability to build; the
   console just never held more than one id. This needs **no new controls**: the card rows are
   already tappable, and the change is the state behind them.

> **Superseded (twice):**
> *Draft 1 proposed relabelling the button "DISPATCH TO CODING" and showing the resolved column
> in the chip.* **Reason:** cosmetic — it makes a wrong destination legible instead of correct,
> and still leaves Planned unreachable.
> *Draft 2 proposed a destination dropdown listing every role-bearing column, with "Auto" as
> the default.* **Reason:** it invents a third way to choose a column when the board already
> has one, and puts stage routing in the operator's hands on every single dispatch. The board
> does not ask; it advances. A dropdown is a fourth reimplementation waiting to drift from
> `_advanceCards`.
> **Replaced with:** call the board's verb with the card's current column.

## Metadata

- **Complexity:** 3
- **Tags:** ui, ux, frontend, bugfix

## Complexity Audit (Routine vs Complex/Risky)

**Routine.** The verb, the next-stage resolution, the complexity banding, the CLI-triggers gate
and the direction classification all already exist and are already used by the board. This plan
adds a thin HTTP route over the existing `kanbanVerb` seam and changes what one button posts.

Decisions already made:

- **No destination selector, no client-side next-column math.** The console sends the card's
  current column and nothing else. `getNextColumn` stays a board-local optimistic predictor;
  the console does not get a copy.
- **Multi-select is a state change, not a UI addition.** Tap toggles a card in or out of a Set,
  mirroring the board's Map semantics exactly. No checkboxes, no selection mode, no long-press,
  no modifier keys — the rows already respond to taps, and a `.selected` class already has to be
  styled for the single-card case.
- **The button is named ADVANCE**, matching the board. "Dispatch" as a distinct console concept
  is dropped — advancing a card out of Planned dispatches it to a coding seat as a consequence,
  which is what the board already does.
- **Complexity routing is not removed or reconfigured.** It keeps applying exactly where the
  board applies it: leaving Planned/Staging.

## Edge-Case & Dependency Audit

- **The console never produces a prompt.** The two `dragDropMode: 'prompt'` columns are
  `RESEARCHER` and `TICKET UPDATER`, both **disabled** on this board
  (`agents.visibleAgents`: `researcher:false`, `ticket_updater:false`), so advance cannot land
  in either today. Were one enabled, the board's path copies prompt text to the clipboard
  (`src/webview/kanban.html:10498`) — a desktop gesture with no meaning on this surface, which
  has no clipboard to copy into and nothing to paste it against. **The route must not return
  prompt text and the console must not render it.** If the next stage is a prompt-mode column,
  advance refuses and says to advance that card from the board. Per
  `mobile-command-surface-is-taps-only`, a control ships here only if taps and selects can
  drive it end to end; a payload the operator must hand-carry elsewhere is cut, not
  accommodated.
- **Stage counts come from the board, not the catalogue.** Of the 8 role-bearing built-in
  columns this board runs **5** — planner, lead, coder, intern, reviewer. Researcher, Ticket
  Updater and Completion Tested are off. `GET /kanban/columns` reports all 8 regardless, which
  is its own defect (`column-reads-publish-the-catalogue-not-the-board.md`); advance is immune
  because it never sends a destination, but the Move view's dropdowns are fed by it.
- **A card in the last stage has no next column.** `getNextColumn` returns `null` at the end of
  the list; the route must report "already in the final stage" rather than moving nothing and
  claiming success.
- **The CLI-triggers gate stays where it is.** `_advanceCards` applies it internally (moves
  always, dispatches only when enabled) — the console inherits that instead of re-deciding it.
- **A batch is M plans to ONE prompt on ONE terminal**, not M agents — that is what
  `_advanceCards` does for the board, so the console inherits it by calling the same verb. This
  is correct parity, not a defect to work around, but the chip must say how many cards moved so
  a batch never looks like a single-card advance.
- **Mixed source columns in one selection.** The board trusts explicit `sessionIds` without
  column filtering (`KanbanProvider.ts:11884-11887`), so a selection spanning two columns
  advances each card from wherever it is. The console must not silently restrict to the
  filtered column; if the results differ per card, the chip reports the count, not one column.
- **Selection must clear on workspace switch.** The console already nulls both ids when the
  workspace dropdown changes (`src/webview/command.js:299-300`); the Set must be cleared at the
  same point. The board's cross-workspace guard exists for the same reason
  (`kanban.html:9805-9819`) — a selection spanning two parent workspaces breaks batch verbs.
- **Empty selection is a no-op.** `promptSelected` refuses an empty array, so the buttons stay
  disabled while the Set is empty — the existing `!selectedDispatchCardId` gate becomes a size
  check (`:638-639`).
- **Optimistic move must predict or abstain.** The console's `pendingMoves` cannot know the
  backend's choice for a Planned→coding advance. Follow the board's rule: predict only when
  confident, otherwise show pending and let the authoritative push settle it — never a
  prediction that bounces.
- **Both hosts.** The new route needs `kanbanVerb` wired in both composition roots; confirm it
  is set in `bootstrap.ts` as well as `TaskViewerProvider.ts` before relying on it, since the
  sibling `moveCard` seam on the same options object is wired in only one
  (`kanban-move-is-unwired-in-the-standalone-host.md`).
- **Depends on:** nothing for advance itself. The Move view (silent column change, no agent)
  remains blocked on `kanban-move-is-unwired-in-the-standalone-host.md`, and its dropdowns are
  only correct once `column-reads-publish-the-catalogue-not-the-board.md` lands.
- **Audit gap, out of scope:** that the dispatch write path recorded no `plan_events` row is a
  real defect and wants its own plan; this plan changes no write path.

## Proposed Changes

### 1. `src/services/LocalApiServer.ts` — a thin `POST /kanban/advance` over the existing seam

```ts
// Advance = the board's own gesture: send the card and the column it is IN.
// The backend resolves the next stage (_advanceCards), applies complexity
// banding where it belongs (leaving PLAN REVIEWED / STAGING), and honours the
// CLI-triggers gate. This route adds no routing logic of its own — by design.
private async _handleKanbanAdvance(req, res): Promise<void> {
    const kanbanVerb = this._options.kanbanVerb;
    if (!kanbanVerb) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Advance not available: the kanbanVerb seam is not '
            + 'wired in this host\'s composition root.', seam: 'kanbanVerb' }));
        return;
    }
    const body = await this._parseJsonBody(req);
    // One card or many — the verb underneath has always taken an array, and the
    // board sends N through the same path. `planId` stays accepted so existing
    // single-card callers keep working.
    const ids = Array.isArray(body?.planIds) && body.planIds.length
        ? body.planIds.map((v: unknown) => String(v).trim()).filter(Boolean)
        : [String(body?.planId || body?.plan || '').trim()].filter(Boolean);
    const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim();
    if (ids.length === 0) { /* 400: planIds required */ }

    // Columns are resolved server-side per card so the client cannot send a stale
    // one, and a selection spanning two columns advances each card from where it is.
    const records = await this._lookupPlans(ids, workspaceRoot);
    const missing = ids.filter(id => !records.some(r => (r.planId === id || r.sessionId === id)));
    if (missing.length) { /* 404 naming the missing ids */ }

    // Group by source column: promptSelected takes one column per call, and the
    // board's own path is likewise per-column.
    const byColumn = new Map<string, string[]>();
    for (const r of records) {
        const key = r.kanbanColumn;
        (byColumn.get(key) ?? byColumn.set(key, []).get(key)!).push(r.sessionId || r.planId);
    }

    const moved: Array<{ from: string; column?: string; count: number }> = [];
    for (const [column, sessionIds] of byColumn) {
        const result = await kanbanVerb('promptSelected', { column, sessionIds, workspaceRoot }, workspaceRoot);
        // A prompt-mode next stage produces clipboard text, which this surface
        // cannot use. Refuse it rather than returning a payload nobody can act on.
        if (result?.prompt) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `The next stage for cards in ${column} is a `
                + `prompt-mode column (${result.column || 'unknown'}). Advance them from the board.` }));
            return;
        }
        moved.push({ from: column, column: result?.column, count: sessionIds.length });
    }
    res.end(JSON.stringify({ success: true, moved, count: ids.length }));
}
```

`_lookupPlans` is the batch form of the single lookup — one DB read for N ids rather than N
reads, and it is what lets the route report every missing id at once instead of failing on the
first.

Register it beside `/kanban/move` and `/kanban/dispatch` in the route table (`~:8556`) and add
it to `/catalog`.

### 2. `src/webview/command.js:28-30, 638-639, 697` — selection becomes a Set

Replace the two scalars with Sets and make selection toggle, exactly as the board does. Both
views share the change; `renderDispatchView` / `renderMoveView` stamp `.selected` per row
instead of comparing against one id.

```js
let selectedDispatchCardIds = new Set();
let selectedMoveCardIds = new Set();

function selectDispatchCard(cardId) {
    // Plain tap toggles, like the board's card body click — no modifier, and
    // selecting one card never clears the others.
    if (selectedDispatchCardIds.has(cardId)) { selectedDispatchCardIds.delete(cardId); }
    else { selectedDispatchCardIds.add(cardId); }
    cancelDispatchPoll();
    renderDispatchView();
}
// :638-639 — gate on size, not on a single id
btnDispatch.disabled = locked || selectedDispatchCardIds.size === 0;
btnMove.disabled     = locked || selectedMoveCardIds.size === 0;
```

Clear both Sets where the workspace switch already nulls the scalars (`:299-300`).

### 3. `src/webview/command.js:1403-1445` — post the advance, drop the private routing

```js
const planIds = [...selectedDispatchCardIds];
const res = await fetch('/kanban/advance', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ planIds, workspaceRoot: currentWorkspaceRoot })
});
const result = await res.json().catch(() => null);
if (res.ok && result?.success) {
    // Always say how many, so a batch never reads like a single-card advance.
    const legs = result.moved || [];
    dispatchStatusChip.textContent = legs.length === 1 && legs[0].count === 1
        ? `Advanced ${legs[0].from} → ${legs[0].column || 'next stage'}`
        : `Advanced ${result.count} cards — ` +
          legs.map(l => `${l.count} from ${l.from} → ${l.column || 'next stage'}`).join(', ');
    selectedDispatchCardIds.clear();
    renderDispatchView();
} else {
    dispatchStatusChip.textContent = result?.error || `Advance failed (HTTP ${res.status})`;
}
```

### 4. `src/webview/command.html:868-890` — one button, honest source label

```html
<!-- was aria-label="Dispatch Column": it filters the LIST, it is not a target -->
<select class="cmd-select" id="dispatch-source-column-select" style="max-width:200px;"
        aria-label="Show cards from column"></select>
…
<button class="primary-action-btn" id="btn-dispatch" disabled>ADVANCE</button>
```

### 5. `src/webview/command.js:1475-1480` — Move must not blame the card for an unwired host

```js
const body = await res.json().catch(() => null);
moveStatusChip.textContent = body?.seam === 'moveCard'
    ? 'Move unavailable on this host (not a card problem)'
    : (body?.error || 'Move failed on server');
```

## Verification Plan

**Parity with the board — the whole point:**
1. Card in **New**, console ADVANCE → lands in **Planned**, planner receives the prompt. Same
   card, same starting column, board advance button → same destination. Compare directly.
2. Card in **Planned**, complexity 6, console ADVANCE → lands in **Coder** (the banding still
   applies where it should). Board advance on an identical card → same column.
3. Card in **Planned** with dynamic complexity routing **off** → both surfaces send it to the
   same column.
4. Card in the final stage → console reports "already in the final stage"; no move, no agent.

**Prompt-mode columns are refused, not rendered:**
5. With Researcher disabled (this board's state), advance skips it entirely — a card in New
   still lands in Planned.
6. With Researcher enabled in Setup so that it becomes a card's next stage, console ADVANCE
   returns 409 and the chip says to advance that card from the board. `grep` the served console
   HTML and JS for prompt-rendering: there must be no element or handler that displays prompt
   text.

**Multi-card, matching the board:**
7. Tap three cards in New — all three show selected; tap one again — it deselects and the other
   two stay. No modifier key involved.
8. ADVANCE with three selected → all three land in Planned, the chip reads
   `Advanced 3 cards — 3 from CREATED → PLAN REVIEWED`, and the selection clears. One prompt on
   one terminal, exactly as the board's batch does.
9. Select cards spanning New and Planned, ADVANCE → each advances from its own column and the
   chip names both legs; nothing is silently dropped for being outside the filtered column.
10. Switch the workspace dropdown with cards selected → the selection clears and both buttons
    disable.
11. With nothing selected, both buttons are disabled and no request is sent.

**Guards:**
12. `grep` the console for coding-column identifiers and complexity-band logic — there must be
   none left; the console names no column and no role.
13. `POST /kanban/dispatch` with an explicit `targetColumn` still works unchanged for its
   existing callers (CLI `dispatch` verb, board drag-drop), on both hosts.
14. With `kanbanVerb` deliberately unset, `/kanban/advance` returns the 503 naming the seam.

**Both hosts:**
15. Steps 1–11 pass on the standalone host and on the installed VSIX.
16. Confirm `kanbanVerb` is set in both `bootstrap.ts` and `TaskViewerProvider.ts` options
    objects.

**User Review Required:** None.
