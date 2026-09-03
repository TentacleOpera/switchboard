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

The console (`src/webview/command.js:1614-1621`) posts to `/kanban/dispatch` with
`{ plan, workspaceRoot, ack }` and **no column at all** — neither source nor destination. With
`targetColumn` absent, the handler delegates to `resolveAutoDispatchColumn`
(`src/services/LocalApiServer.ts:2030-2035` → `src/services/KanbanProvider.ts:9437-9478`),
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
   (`:702`). The board holds `selectedCards` as a **Map** and a plain click on the card body
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
  in either today — `_getNextColumnId` (`KanbanProvider.ts:7428`) skips columns whose agent is
  disabled. Were one enabled, the card would advance there (same as the board), and
  `promptSelected` would generate prompt text and call `this._seams().clipboard.writeText` —
  a desktop gesture with no meaning on this surface. **The route strips `prompt` from its
  response and the console does not render it.** The card still advances; the operator just
  does not see prompt text they cannot use. Per `mobile-command-surface-is-taps-only`, a
  control ships here only if taps and selects can drive it end to end; a payload the operator
  must hand-carry elsewhere is cut, not accommodated.
  **Standalone-host risk:** `promptSelected` calls `this._seams().clipboard.writeText(prompt)`
  at `KanbanProvider.ts:11903`. If the clipboard seam is a no-op on standalone (likely), this
  is harmless. If it throws, the verb fails and the card does not advance. Verify the clipboard
  seam's behaviour on the standalone host before relying on advance there.
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
  workspace dropdown changes (`src/webview/command.js:303-304`); the Set must be cleared at the
  same point. The board's cross-workspace guard exists for the same reason
  (`kanban.html:9805-9819`) — a selection spanning two parent workspaces breaks batch verbs.
- **Empty selection is a no-op.** `promptSelected` refuses an empty array, so the buttons stay
  disabled while the Set is empty — the existing `!selectedDispatchCardId` gate becomes a size
  check (`:642`).
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
    const records = await this._lookupPlansByIds(ids, workspaceRoot);
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
        if (!result?.success) {
            // The verb refused (no matching plans, no next column, no coding agent
            // enabled). Report it per-column-group; other groups still advance.
            moved.push({ from: column, count: 0, error: result?.error });
            continue;
        }
        // promptSelected ALWAYS returns { success, prompt, targetColumn } — the
        // prompt field is present on every successful call, not just prompt-mode
        // columns. The console does not render prompt text (it has no clipboard
        // to paste into), so we strip it from the response and use targetColumn
        // to report where the card landed.
        //
        // _getNextColumnId (KanbanProvider.ts:7428) already skips columns whose
        // agent is disabled (visibleAgents[role] === false), so RESEARCHER and
        // TICKET UPDATER are never reached on this board. If one were enabled,
        // the card would advance there — same as the board — and the console
        // would simply report the destination without rendering the prompt.
        moved.push({ from: column, column: result?.targetColumn, count: sessionIds.length });
    }
    res.end(JSON.stringify({ success: true, moved, count: ids.length }));
}
```

> **Superseded:** `if (result?.prompt) { res.writeHead(409, ...); return; }` — refuse
> prompt-mode columns by checking `result?.prompt`.
> **Reason:** `promptSelected` (`KanbanProvider.ts:11902-12001`) ALWAYS generates a prompt and
> returns it on every successful call — L11912, L11946, L12001 all include `prompt` in the
> return. The `prompt` field is present for ALL columns, not just prompt-mode ones. The 409
> check would fire on EVERY advance, blocking the feature entirely. Additionally,
> `_getNextColumnId` (L7428) already skips columns whose agent is disabled
> (`visibleAgents[role] === false`), so RESEARCHER and TICKET UPDATER are never reached on
> this board — the prompt-mode refusal was solving a problem the backend already prevents.
> **Replaced with:** Strip `prompt` from the response; use `result.targetColumn` to report the
> destination. Do not refuse prompt-mode columns — if one is enabled, the card advances there
> (parity with the board), and the console simply does not render the prompt text.

`_lookupPlansByIds` is a new helper on `LocalApiServer` — one DB read for N ids, returning
`{ sessionId, planId, planFile, kanbanColumn }` per card. It is shared with the batch move
route (subtask 1, `kanban-move-is-unwired-in-the-standalone-host.md`), which uses the same
helper to resolve `planFile` per card in a batch move. It is what lets the route report
every missing id at once instead of failing on the first, and what provides each card's
source column for the `promptSelected` call.

Register it beside `/kanban/move` and `/kanban/dispatch` in the route table (`~:8549-8574`) and add
it to `/catalog`.

### 2. `src/webview/command.js:28-30, 642, 702, 794` — selection becomes a Set

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

function selectMoveCard(cardId) {
    // Same toggle semantics for the Move view.
    if (selectedMoveCardIds.has(cardId)) { selectedMoveCardIds.delete(cardId); }
    else { selectedMoveCardIds.add(cardId); }
    renderMoveView();
}
// :642 — gate on size, not on a single id
btnDispatch.disabled = locked || selectedDispatchCardIds.size === 0;
btnMove.disabled     = locked || selectedMoveCardIds.size === 0;
```

**All 17 references to `selectedMoveCardId`** (L30, 304, 355, 357-358, 643, 794-795, 819,
823, 828-829, 848-849, 859, 1664-1665) must be updated to use the Set: size checks replace
scalar truthiness, `.has(id)` replaces `=== id`, iteration replaces single-id reads, and
`executeMove` (L1664) iterates `[...selectedMoveCardIds]` instead of reading one id.

Clear both Sets where the workspace switch already nulls the scalars (`:303-304`).

### 3. `src/webview/command.js:1614-1621` — post the advance, drop the private routing

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

### 4. `src/webview/command.html:884, 898-900` — one button, honest source label

```html
<!-- was aria-label="Dispatch Column": it filters the LIST, it is not a target -->
<select class="cmd-select" id="dispatch-source-column-select" style="max-width:200px;"
        aria-label="Show cards from column"></select>
…
<button class="primary-action-btn" id="btn-dispatch" disabled>ADVANCE</button>
```

### 5. `src/webview/command.js:1690-1698` — Move must not blame the card for an unwired host

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

**Prompt text is stripped, not rendered:**
5. With Researcher disabled (this board's state), advance skips it entirely — a card in New
   still lands in Planned (`_getNextColumnId` skips disabled columns).
6. With Researcher enabled in Setup so that it becomes a card's next stage, console ADVANCE
   advances the card there and the chip reports the destination — the `prompt` field is
   stripped from the route response. `grep` the served console HTML and JS for
   prompt-rendering: there must be no element or handler that displays prompt text.
7. Verify the clipboard seam on the standalone host: `promptSelected` calls
   `this._seams().clipboard.writeText(prompt)` at `KanbanProvider.ts:11903`. If it is a
   no-op, advance works. If it throws, advance fails — document the seam's behaviour.

**Multi-card, matching the board:**
8. Tap three cards in New — all three show selected; tap one again — it deselects and the other
   two stay. No modifier key involved.
9. ADVANCE with three selected → all three land in Planned, the chip reads
   `Advanced 3 cards — 3 from CREATED → PLAN REVIEWED`, and the selection clears. One prompt on
   one terminal, exactly as the board's batch does.
10. Select cards spanning New and Planned, ADVANCE → each advances from its own column and the
    chip names both legs; nothing is silently dropped for being outside the filtered column.
11. Switch the workspace dropdown with cards selected → the selection clears and both buttons
    disable.
12. With nothing selected, both buttons are disabled and no request is sent.

**Guards:**
13. `grep` the console for coding-column identifiers and complexity-band logic — there must be
   none left; the console names no column and no role.
14. `POST /kanban/dispatch` with an explicit `targetColumn` still works unchanged for its
   existing callers (CLI `dispatch` verb, board drag-drop), on both hosts.
15. With `kanbanVerb` deliberately unset, `/kanban/advance` returns the 503 naming the seam.

**Both hosts:**
16. Steps 1–12 pass on the standalone host and on the installed VSIX.
17. Confirm `kanbanVerb` is set in both `bootstrap.ts` (L3242) and `TaskViewerProvider.ts`
    (L4170-4178) options objects.

### Goal Invariants

- **Negative:** `grep` the served console JS for `resolveAutoDispatchColumn` and
  `INTERN CODED|CODER CODED|LEAD CODED` returns zero matches — the console no longer names a
  coding column or calls the coding-seat router.
- **Positive:** `POST /kanban/advance` with `{ planIds: [id], workspaceRoot }` for a card in
  `CREATED` returns `{ success: true, moved: [{ from: 'CREATED', column: 'PLAN REVIEWED',
  count: 1 }] }` — the card lands in Planned, not a coding column.
- **Negative:** `grep` the served console HTML/JS for `prompt` text rendering returns zero
  matches — no element or handler displays prompt text.
- **Positive:** `POST /kanban/advance` response body does not contain a `prompt` field — the
  route strips it even though `promptSelected` always returns one.

## User Review Required

None.

## Dependencies

- None for advance itself. The Move view remains blocked on
  `kanban-move-is-unwired-in-the-standalone-host.md` (this feature), and its dropdowns are
  only correct once `column-reads-publish-the-catalogue-not-the-board.md` (this feature) lands.

## Adversarial Synthesis

Key risks: `result?.prompt` check was fatal (fixed — `prompt` is always returned, now stripped
not checked), Move view selection had 17 unaddressed references (fixed — all enumerated and
covered), `_lookupPlans` was undefined (fixed — defined as new DB helper), clipboard seam on
standalone unverified (added as verification step 7), line numbers were 200+ lines stale
(corrected). Mitigations: Superseded callout on prompt check, explicit Move view enumeration,
`_lookupPlans` definition, clipboard seam verification, line ref corrections throughout.

## Implementation Summary

Implemented `POST /kanban/advance` endpoint in `LocalApiServer` to route advance requests via the backend's `promptSelected` verb without private routing rules. Updated `protocol-catalog.json` with the new `/kanban/advance` route definition. In `command.html` and `command.js`, replaced scalar selection with Sets to allow multi-card toggling and updated the primary button to ADVANCE. Advance requests now send card IDs to `/kanban/advance` which groups cards by source column, resolves next stages on the server, strips prompts, and returns honest leg counts. Move error reporting was also updated to accurately reflect host seam availability.

