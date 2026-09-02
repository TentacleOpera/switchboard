# The command console never implemented advance — it calls the coding-seat router directly, so every card jumps to a coding column

## Goal

Make the console's primary card action **the same advance the board already performs**: send the
card and its current column to the backend and let the backend resolve the next stage. Remove
the console's private routing behaviour entirely.

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
- **The button is named ADVANCE**, matching the board. "Dispatch" as a distinct console concept
  is dropped — advancing a card out of Planned dispatches it to a coding seat as a consequence,
  which is what the board already does.
- **Complexity routing is not removed or reconfigured.** It keeps applying exactly where the
  board applies it: leaving Planned/Staging.

## Edge-Case & Dependency Audit

- **Prompt-mode columns return a payload, not a dispatch.** `RESEARCHER` and `TICKET UPDATER`
  have `dragDropMode: 'prompt'`, where the board's path copies a prompt to the clipboard rather
  than driving a CLI (`src/webview/kanban.html:10498`). On a phone there is no board clipboard,
  so the route must return that prompt text in the response and the console must render it as
  copyable. This is the one genuinely new surface in the plan and must not be silently dropped —
  a prompt-mode advance that reports success while producing nothing is the worst outcome.
- **A card in the last stage has no next column.** `getNextColumn` returns `null` at the end of
  the list; the route must report "already in the final stage" rather than moving nothing and
  claiming success.
- **The CLI-triggers gate stays where it is.** `_advanceCards` applies it internally (moves
  always, dispatches only when enabled) — the console inherits that instead of re-deciding it.
- **Optimistic move must predict or abstain.** The console's `pendingMoves` cannot know the
  backend's choice for a Planned→coding advance. Follow the board's rule: predict only when
  confident, otherwise show pending and let the authoritative push settle it — never a
  prediction that bounces.
- **Both hosts.** The new route needs `kanbanVerb` wired in both composition roots; confirm it
  is set in `bootstrap.ts` as well as `TaskViewerProvider.ts` before relying on it, since the
  sibling `moveCard` seam on the same options object is wired in only one
  (`kanban-move-is-unwired-in-the-standalone-host.md`).
- **Depends on:** nothing for advance itself. The Move view (silent column change, no agent)
  remains blocked on plan 1.
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
    const planId = String(body?.planId || body?.plan || '').trim();
    const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim();
    // The card's CURRENT column, resolved server-side from the record so the
    // client cannot send a stale one.
    const record = await this._lookupPlan(planId, workspaceRoot);
    if (!record) { /* 404 naming the planId */ }
    const result = await kanbanVerb('promptSelected', {
        column: record.kanbanColumn, sessionIds: [record.sessionId || record.planId], workspaceRoot
    }, workspaceRoot);
    // Prompt-mode columns yield prompt text rather than a dispatch — pass it through.
    res.end(JSON.stringify({ success: true, from: record.kanbanColumn, ...result }));
}
```

Register it beside `/kanban/move` and `/kanban/dispatch` in the route table (`~:8556`) and add
it to `/catalog`.

### 2. `src/webview/command.js:1403-1445` — post the advance, drop the private routing

```js
const res = await fetch('/kanban/advance', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ planId: cardId, workspaceRoot: currentWorkspaceRoot })
});
const result = await res.json().catch(() => null);
if (res.ok && result?.success) {
    const to = result.column || result.targetColumn;
    dispatchStatusChip.textContent = to
        ? `Advanced ${result.from} → ${to}`
        : `Advanced from ${result.from}`;
    if (result.prompt) { showCopyablePrompt(result.prompt); }   // prompt-mode columns
} else {
    dispatchStatusChip.textContent = result?.error || `Advance failed (HTTP ${res.status})`;
}
```

### 3. `src/webview/command.html:868-890` — one button, honest source label

```html
<!-- was aria-label="Dispatch Column": it filters the LIST, it is not a target -->
<select class="cmd-select" id="dispatch-source-column-select" style="max-width:200px;"
        aria-label="Show cards from column"></select>
…
<button class="primary-action-btn" id="btn-dispatch" disabled>ADVANCE</button>
```

### 4. `src/webview/command.js:1475-1480` — Move must not blame the card for an unwired host

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

**Prompt-mode columns:**
5. Advance a card into `RESEARCHER` → the response carries prompt text and the console renders
   it copyable; no silent success with nothing produced.

**Guards:**
6. `grep` the console for coding-column identifiers and complexity-band logic — there must be
   none left; the console names no column and no role.
7. `POST /kanban/dispatch` with an explicit `targetColumn` still works unchanged for its
   existing callers (CLI `dispatch` verb, board drag-drop), on both hosts.
8. With `kanbanVerb` deliberately unset, `/kanban/advance` returns the 503 naming the seam.

**Both hosts:**
9. Steps 1–5 pass on the standalone host and on the installed VSIX.
10. Confirm `kanbanVerb` is set in both `bootstrap.ts` and `TaskViewerProvider.ts` options
    objects.

**User Review Required:** None.
