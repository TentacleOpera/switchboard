# The Copy-Prompt Button Keeps the Label of the Column the Card Just Left

kanbanColumn: CREATED

## Goal

A card's copy-prompt button always names, and always copies, the prompt for the card's
current position — including after the card is moved backwards. Pressing it never advances
the card unless the prompt actually reached the clipboard.

### Problem analysis

Reported from the standalone browser board: pressing **Copy prompt** on a card in New
advanced it to Planned but copied nothing. Moving the card back to New left the button
reading *Copy coder prompt* from then on, so every further press produced the wrong prompt
and the planning prompt became unreachable for that card.

Three separate defects compose into this. All three are in `src/webview/kanban.html`, which
both hosts serve, so none of them is standalone-only in the code — but the standalone board
is where it was seen, and the standalone path is the one to reproduce on.

**1. The label is baked at render time and no move ever recomputes it.**

`kanban.html:10117-10159` derives `copyLabel` from `card.column` while building the card's
markup — `getNextColumn(sourceColumn)`, then a switch on the next column's `role` picks
between *Copy planning prompt*, *Copy coder prompt*, *Copy review prompt* and the rest. The
string is written into the button's HTML (`textContent`) AND into a `data-copy-label`
attribute (`:10159`), and neither is ever touched again.

`moveCardsOptimistically` (`:8229`) updates two of the three things that carry the card's
position and misses this one:

- the model — `cardData.column = targetColumn` — updated;
- the button's `data-column` attribute, patched inside `moveCardElements` (`:8174`) with a
  comment explaining precisely why a stale attribute is dangerous — updated;
- the button's **visible text** AND its **`data-copy-label` attribute** — never updated.

A full `renderBoard` would rebuild the label, but the move path calls it only when
`unresolvedNeedsRender(unresolved)` is true, i.e. when a card could not be placed in the DOM.
On a move that succeeds — the normal case — **there is no re-render**, and the label keeps
the text baked for the column the card has just left.

> **Superseded:** The original analysis listed only `textContent` as the stale value and
> proposed fixing it alone.
> **Reason:** The button also carries a `data-copy-label` attribute (baked at `:10159`),
> and the "Copied!" reset mechanism at `:12347` and `:12362` restores the label from
> `btn.dataset.copyLabel`. Fixing `textContent` alone leaves `data-copy-label` stale, so
> the next copy flashes "Copied!" and resets to the OLD column's label — reproducing the
> exact bug inside the fix.
> **Replaced with:** Change 1 must update BOTH `copyBtn.textContent` AND
> `copyBtn.dataset.copyLabel` in `moveCardElements`, alongside the existing
> `copyBtn.dataset.column` patch. All three carry the card's position; all three must move
> together.

**2. Model and label can then disagree, so the button says one thing and does another.**

`runCopyPrompt` (`:10806`) resolves the column model-first:

```js
const modelColumn = currentCards.find(c => (c.planId || c.sessionId) === sessionId)?.column;
const column = modelColumn || btn.dataset.column || btn.closest('.kanban-column')?.dataset?.column;
```

Its own comment says `data-column` is "a render-time snapshot" and that trusting it
"dispatches the wrong prompt to the wrong column". That reasoning is right and the fix was
applied to the attribute and the model — the label was left out of it. So after a move-back
the button *behaves* correctly and *reads* incorrectly, which is unfalsifiable from the
operator's side: the only thing on screen says coder, so a planning prompt looks like a bug
and a coder prompt looks like confirmation.

The model wins the resolution: after a successful move, `moveCardsOptimistically` updates
`cardData.column` in `currentCards`, so `modelColumn` is the new column. The stale
`data-column` attribute is the fallback, used only when the model lookup misses. So the
*prompt dispatched* is correct after a move — it is the *label displayed* that is wrong.

**3. A failed copy still advances the card.**

`runCopyPrompt` moves the card the moment it is clicked — its own comment: *"Optimistic UI:
highlight target column and move card immediately"* (`:10815`) — and the copy result arrives
later, on a separate message. Nothing reconciles the two. A copy that fails leaves the card
sitting one column further on with the operator holding nothing, which is exactly what was
reported.

One clipboard call site makes that failure silent. `window.sbCopyToClipboard`
(`clipboardFallback.js:25`) returns a **Promise** — the async Clipboard API when the context
is secure, otherwise an `execCommand` fallback. `kanban.html:12500` calls it inside a plain
`try/catch` with no `.then()`, so a rejection escapes the catch and the *"copied to
clipboard"* toast fires regardless. The three sibling call sites at `:12019`, `:12050` and
`:12089` all handle the promise correctly; this one was missed.

## Metadata

- **Complexity:** 4
- **Tags:** kanban, webview, standalone, bugfix, both-hosts

## User Review Required

None.

## Complexity Audit

### Routine
- Extracting the label derivation into a shared function and calling it from the render and move paths — a mechanical refactor with a known regression-test constraint.
- Fixing the promise handling at `:12500` to match its three siblings — a well-understood pattern already present in the same file.
- Updating the regression test that guards the inline `copyLabel` block.

### Complex / Risky
- Making the card advance conditional on the copy result changes the interaction from optimistic (immediate visual feedback) to reactive (wait for the backend's success/failure message). Two result handlers exist — `copyPromptResult` (`:12335`, has `msg.success`) and `externalAutomationPrompt` (`:12500`, the broken one) — and the deferred move must land in the right one. See Change 2.
- The backend-routed advance path (PLAN REVIEWED / STAGING via `_partitionByComplexityRoute`) predicts the target column optimistically. Deferring the move interacts with that prediction — the backend's `moveCards` delta may bounce the card to the real column, and the deferred move must not fight it.

## Adversarial Synthesis

Key risks: the `data-copy-label` attribute is a second stale value the original analysis
missed — fixing `textContent` alone re-stales the label on the next copy via the reset
mechanism at `:12347`; the conditional move needs a wiring diagram (which result handler
triggers it) that the plan did not specify; Change 3 was an investigation whose answer is
already in the code (the model wins). Mitigations: update all three position-carriers
(`data-column`, `data-copy-label`, `textContent`) in one place; specify the `copyPromptResult`
handler as the deferred-move trigger and fix `externalAutomationPrompt` to handle its
promise; state the model-wins finding from the code rather than asking for reproduction.

## Proposed Changes

### 1. Recompute the label wherever the column changes

Extract the label derivation at `:10117-10153` into a function taking a column id and returning
the label, and call it from both the render path and the move path. In
`moveCardElements` (`:8173-8174`), where `copyBtn.dataset.column` is already being corrected,
set `copyBtn.textContent` AND `copyBtn.dataset.copyLabel` from the same source in the same
place — all three position-carriers must move together and none must be able to drift again.

The extraction has a constraint recorded in the code: the comment at `:10131-10133` says the
`copyLabel` block "must stay inline up to the button assignment" to satisfy a regression
test's regex extraction. Read that test before moving the block and update it deliberately;
do not work around it by duplicating the switch, which is what produced this bug's shape in
the first place.

Suppression must move with it. The button is emitted only when
`nextColId && nextDef && nextDef.kind !== 'completed'` (`:10158`), so a card moved *into* a
position whose next column is terminal needs the button removed, not relabelled. The extracted
function must return a sentinel (or null) for the terminal case so `moveCardElements` can
remove the button rather than relabel it.

### 2. Advance the card only when the prompt has been copied

Make the move conditional on the copy result rather than firing at click time. On failure,
leave the card where it is and report the failure — a card that advanced without producing a
prompt is worse than one that did not move, because the operator then has to guess whether
the dispatch happened.

**Wiring diagram.** Two result handlers exist in `kanban.html`:

- `copyPromptResult` (`:12335`) — receives `msg.success`, resets the button label from
  `data-copy-label`. This is the handler that should trigger the deferred `moveCardsOptimistically`
  call: on `msg.success === true`, perform the move; on `false`, leave the card in place.
- `externalAutomationPrompt` (`:12500`) — the broken handler. It calls
  `sbCopyToClipboard(msg.prompt)` with no `.then()`, has no `msg.success` flag, and has no
  move call. Fix the promise handling here to match its three siblings (`:12019`, `:12050`,
  `:12089`) so a rejected copy reports failure instead of success. If this handler is the
  path the standalone board uses for external-mode copies, the deferred move (or a
  copy-success signal) must also be wired here.

The `runCopyPrompt` function (`:10806`) currently calls `moveCardsOptimistically` at `:10877`
at click time. Remove that call and defer it to the result handler. The column highlight
(`:10874`) can stay at click time for immediate visual feedback, or move with the deferred
move — either is acceptable, but the card element must not relocate until the copy succeeds.

### 3. Findings from the code (replaces the original investigation)

> **Superseded:** The original Change 3 proposed reproducing on the standalone board to
> "record whether the press after a move-back used the model column or the stale attribute."
> **Reason:** The answer is in the code. `runCopyPrompt` at `:10812` resolves `modelColumn`
> first (`currentCards.find(...)?.column`), falling back to `btn.dataset.column`. After a
> successful move, `moveCardsOptimistically` updates `cardData.column` in the model, so the
> model has the new column and wins the resolution. The stale attribute is the fallback,
> used only when the model lookup misses. The prompt dispatched is correct after a move —
> it is the label displayed that is wrong (fixed by Change 1).
> **Replaced with:** The finding is stated above. Change 1 alone fixes the reported label
> defect. The `suppressedRenderPending` recovery path (`armOptimisticGuard` at `:6599`,
> `suppressedRenderPending` set at `:11643`, `:11692`, `:11871`) is host-agnostic — it fires
> on any `updateBoard` that arrives during the optimistic window, whether from the extension
> or standalone. The remaining open question is whether the recovery actually fires in
> standalone in practice, which is a reproduction step in the Verification Plan, not a
> proposed change.

## Edge-Case & Dependency Audit

1. **Both hosts.** The three defects are in `kanban.html`, which the extension and the
   standalone browser board both serve — the extension shows the same stale label after a
   move. Verify on both; do not fix the browser path alone.
2. **The coded-lane collapse.** Both the render path (`:10122-10125`) and `runCopyPrompt`
   (`:10823-10826`) resolve `CODED_AUTO` and the `CODED_IDS` group to the last *visible*
   coded column before calling `getNextColumn`. The extracted function must do the same, or
   cards in the collapsed coded bucket get a label derived from a column that is not on
   screen.
3. **Custom columns.** `custom-user` and `custom-agent` both yield *Copy advance prompt*.
   A board with custom columns must still relabel correctly on a move into one.
4. **Backend-routed advances.** `runCopyPrompt`'s comment states that PLAN REVIEWED and
   STAGING advances are routed by the backend (`_partitionByComplexityRoute`) and that the
   optimistic move "must either predict that exactly or not move at all". Making the move
   conditional on the copy interacts with that prediction — check both, not just the simple
   columns.
5. **Completed cards.** They render a Recover button instead (`:10115`), so a move into or out
   of COMPLETED changes which button exists, not just its text.
6. **Not a confirmation gate.** Change 2 makes the move conditional on a result the code
   already receives. It must not introduce a prompt, a dialog, or a second click.
7. **The `data-copy-label` reset path.** The "Copied!" flash at `:12342` and the failure
   reset at `:12362` both restore from `btn.dataset.copyLabel`. If `data-copy-label` is
   stale, both paths re-stale the label. Change 1 must update `data-copy-label` alongside
   `textContent` to close this loop.

## Dependencies

None — this plan is self-contained within `src/webview/kanban.html` and
`src/webview/clipboardFallback.js`.

## Verification Plan

1. On the standalone board, a card in New reads *Copy planning prompt*; drag it to Planned and
   it reads *Copy coder prompt*; drag it back and it reads *Copy planning prompt* again — with
   no page reload and no other interaction.
2. Pressing it in each of those three states copies the prompt the label names.
3. The same three checks pass in the extension's kanban panel.
4. A card whose copy fails stays in its column, and the message reports the failure.
5. A copy failure at `:12500` reports failure rather than *"copied to clipboard"*.
6. A card dragged into a column whose next column is COMPLETED loses the button rather than
   showing a stale label.
7. A card in the collapsed coded bucket, and a card moved into a custom column, both relabel
   correctly.
8. The regression test guarding the inline `copyLabel` block is updated to the extracted
   shape and passes; it is run by hand, since that suite does not gate CI.
9. After a "Copied!" flash, the label resets to the CURRENT column's label (from the updated
   `data-copy-label`), not the stale one.
10. The deferred move lands in the `copyPromptResult` handler; the `externalAutomationPrompt`
    handler's promise is handled and reports failure on rejection.

### Goal Invariants

- Assert `moveCardElements` in `src/webview/kanban.html` sets `copyBtn.dataset.column`,
  `copyBtn.textContent`, AND `copyBtn.dataset.copyLabel` from the same source column in the
  same block.
- Assert the `copyLabel` label-derivation logic is extracted into a single function called
  from both `createCardHtml` and `moveCardElements` (no duplicated switch).
- Assert `runCopyPrompt` does NOT call `moveCardsOptimistically` at click time (the move is
  deferred to the copy-result handler).
- Assert the `externalAutomationPrompt` handler at `:12500` calls `sbCopyToClipboard` with
  `.then()`/`.catch()` (no bare try/catch over a promise).

## Outstanding Questions

- **[research]** Does the `suppressedRenderPending` recovery path actually fire in
  standalone in practice (not just on paper)? The mechanism is host-agnostic in the code
  (`:11643`, `:11692`, `:11871`), but the standalone push shape may differ from the
  extension's in a way the code does not reveal without reproduction. — proceeding on the
  assumption that it does fire, since the set-sites are in the shared `updateBoard` handler,
  not in host-specific code.
