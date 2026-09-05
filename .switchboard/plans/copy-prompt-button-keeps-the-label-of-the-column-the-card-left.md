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

`kanban.html:9464-9506` derives `copyLabel` from `card.column` while building the card's
markup — `getNextColumn(sourceColumn)`, then a switch on the next column's `role` picks
between *Copy planning prompt*, *Copy coder prompt*, *Copy review prompt* and the rest. The
string is written into the button's HTML and is never touched again.

`moveCardsOptimistically` (`:7936`) updates two of the three things that carry the card's
position and misses this one:

- the model — `cardData.column = targetColumn` (`:7948`) — updated;
- the button's `data-column` attribute, patched inside `moveCardElements` (`:7881`) with a
  comment explaining precisely why a stale attribute is dangerous — updated;
- the button's **visible text** — never updated.

A full `renderBoard` would rebuild the label, but the move path calls it only when
`unresolvedNeedsRender(unresolved)` is true, i.e. when a card could not be placed in the DOM.
On a move that succeeds — the normal case — **there is no re-render**, and the label keeps
the text baked for the column the card has just left.

**2. Model and label can then disagree, so the button says one thing and does another.**

`runCopyPrompt` (`:10057`) resolves the column model-first:

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

Which of the two the operator actually got depends on whether anything overwrote
`currentCards` between the move and the press. That is the part still to establish — see
change 3.

**3. A failed copy still advances the card.**

`runCopyPrompt` moves the card the moment it is clicked — its own comment: *"Optimistic UI:
highlight target column and move card immediately"* — and the copy result arrives later, on a
separate message. Nothing reconciles the two. A copy that fails leaves the card sitting one
column further on with the operator holding nothing, which is exactly what was reported.

One clipboard call site makes that failure silent. `window.sbCopyToClipboard`
(`clipboardFallback.js:25`) returns a **Promise** — the async Clipboard API when the context
is secure, otherwise an `execCommand` fallback. `kanban.html:11686` calls it inside a plain
`try/catch` with no `.then()`, so a rejection escapes the catch and the *"copied to
clipboard"* toast fires regardless. The three sibling call sites at `:11206`, `:11237` and
`:11276` all handle the promise correctly; this one was missed.

## Metadata

- **Complexity:** 4
- **Tags:** kanban, webview, standalone, bugfix, both-hosts

## User Review Required

None.

## Proposed Changes

### 1. Recompute the label wherever the column changes

Extract the label derivation at `:9464-9506` into a function taking a column id and returning
the label, and call it from both the render path and the move path. In
`moveCardElements` (`:7881`), where `copyBtn.dataset.column` is already being corrected, set
`copyBtn.textContent` from the same source in the same place — the two must not be able to
drift again.

The extraction has a constraint recorded in the code: the comment at `:9478-9481` says the
`copyLabel` block "must stay inline up to the button assignment" to satisfy a regression
test's regex extraction. Read that test before moving the block and update it deliberately;
do not work around it by duplicating the switch, which is what produced this bug's shape in
the first place.

Suppression must move with it. The button is emitted only when
`nextColId && nextDef && nextDef.kind !== 'completed'`, so a card moved *into* a position
whose next column is terminal needs the button removed, not relabelled.

### 2. Advance the card only when the prompt has been copied

Make the move conditional on the copy result rather than firing at click time. On failure,
leave the card where it is and report the failure — a card that advanced without producing a
prompt is worse than one that did not move, because the operator then has to guess whether
the dispatch happened.

Fix the promise handling at `:11686` to match its three siblings so a rejected copy reports
failure instead of success.

### 3. Establish which value the operator's press actually used

Before changing the reconciliation, reproduce on the standalone board and record whether the
press after a move-back used the model column or the stale attribute. The answer decides
whether anything beyond change 1 is needed.

The specific thing to check is the recovery path. `armOptimisticGuard` (`:6342`) suppresses
incoming renders for `OPTIMISTIC_MOVE_WINDOW_MS` and, on expiry, posts `{ type: 'refresh' }`
if `suppressedRenderPending` is set. Standalone handles that verb —
`bootstrap.ts:1546` calls `pushFullState()` — so the recovery exists on paper. Verify that
`suppressedRenderPending` is actually set when a *standalone* push is suppressed, rather than
only on the message shape the extension sends. If it is not, the suppressed render is dropped
with nothing to replace it, and the board stays stale until something else forces a render.

State the finding either way. If the recovery does fire, change 1 alone fixes the report and
the reconciliation is untouched.

## Edge-Case & Dependency Audit

1. **Both hosts.** The three defects are in `kanban.html`, which the extension and the
   standalone browser board both serve — the extension shows the same stale label after a
   move. Verify on both; do not fix the browser path alone.
2. **The coded-lane collapse.** Both the render path (`:9467-9471`) and `runCopyPrompt`
   (`:10071-10076`) resolve `CODED_AUTO` and the `CODED_IDS` group to the last *visible*
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
5. **Completed cards.** They render a Recover button instead (`:9461`), so a move into or out
   of COMPLETED changes which button exists, not just its text.
6. **Not a confirmation gate.** Change 2 makes the move conditional on a result the code
   already receives. It must not introduce a prompt, a dialog, or a second click.

## Verification Plan

1. On the standalone board, a card in New reads *Copy planning prompt*; drag it to Planned and
   it reads *Copy coder prompt*; drag it back and it reads *Copy planning prompt* again — with
   no page reload and no other interaction.
2. Pressing it in each of those three states copies the prompt the label names.
3. The same three checks pass in the extension's kanban panel.
4. A card whose copy fails stays in its column, and the message reports the failure.
5. A copy failure at `:11686` reports failure rather than *"copied to clipboard"*.
6. A card dragged into a column whose next column is COMPLETED loses the button rather than
   showing a stale label.
7. A card in the collapsed coded bucket, and a card moved into a custom column, both relabel
   correctly.
8. The regression test guarding the inline `copyLabel` block is updated to the extracted
   shape and passes; it is run by hand, since that suite does not gate CI.
