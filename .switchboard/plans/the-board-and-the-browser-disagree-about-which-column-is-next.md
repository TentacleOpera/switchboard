# The Board and the Browser Disagree About Which Column Is Next

## Goal

One rule decides the next column. The webview stops computing an advance target
from a rule the host does not share, so a card advanced in the browser lands
where the host would have put it.

## Problem analysis

### Two implementations, and the comment claims they match

Host — `KanbanProvider._getNextColumnId`, five skip rules:

1. `col.featureOnly`
2. role-less and not `kind: 'completed'`
3. `ACCEPTANCE TESTED` when no acceptance tester is active
4. `dragDropMode === 'disabled'`
5. **`col.role && visibleAgents[col.role] === false`**

Browser — `kanban.html:3788`, one rule:

```js
if (def && !def.role && def.kind !== 'completed') continue; // skip role-less non-terminal columns
```

The host's source comment says it *"Mirrors the webview's getNextColumn skip,
which carries the same carve-out."* It carries one of five.

### Correction: this did NOT cause the 2026-09-20 stall

An earlier draft of this plan claimed the two resolvers read different
visibility stores and that this is what stalled the board. **Checked and false.**
`KanbanProvider._getVisibleAgents` delegates to
`TaskViewerProvider.getVisibleAgents` whenever a provider is set, and
`bootstrap.ts:1825` sets one in standalone. That reads the machine-global file —
the documented home — which said `researcher: true`.

So the host and the browser saw **the same value**. The host did not skip
`RESEARCHER`; it routed to it, correctly, given a role the authoritative store
said was in play. The stall's cause was simpler and is the one the operator named
first: a column existed for a role that never takes delivery of a card, sitting
at order 110 between `PLAN REVIEWED` and the coded lane. Removing it
(`5f519e9c`) was the whole fix.

**What remains true, and why this plan survives:** the two resolvers genuinely do
apply different skip rules — the host has five, the browser has one — and the
host's own comment claims they match. That is a latent divergence, not the cause
of a past incident, and the sections below are written on that basis.

### Where it can still bite

The missing rules matter wherever the browser is handed a column the host would
refuse to advance into. That is not hypothetical — see the self-perpetuating
case below, which is reachable today with `tester: false`.

### Why it does not fire constantly — and why that is the dangerous part

`getNextColumn` reads `columns`, which is replaced wholesale from the host's
`updateColumns`, and that list **is** already filtered by
`_filterDynamicColumns`. So most of the time the browser never sees a column it
should skip, and the missing rules cost nothing.

The exception is deliberate:

```ts
if (visibleAgents[col.role] !== false) return true;
return occupiedColumns.has(col.id);   // hidden, but it holds cards
```

A hidden column that **holds cards is still published** — correctly, because
hiding a column that contains work would strand it. But a published hidden
column is then a legal advance target in the browser and an illegal one in the
host.

**That makes the failure self-perpetuating.** One card in a hidden column makes
the column visible to the browser, which makes it a valid advance target, which
puts more cards in it. It cannot drain, and nothing reports it — the cards are
on a real column, in the right workspace, with no error anywhere.

Live today: `tester` and `ticket_updater` are both `false`, so `ACCEPTANCE
TESTED` and `TICKET UPDATER` are exactly one stray card away from behaving the
way `RESEARCHER` did.

### The host has the same shape in a third place

`_PIPELINE_POSITION` already records what a hand-kept second ranking cost:

> The hand-kept list disagreed with the real order in two places: it ranked
> RESEARCHER before PLAN REVIEWED … and TICKET UPDATER after COMPLETED … a
> backward move read as forward — which dispatches.

It was fixed by deriving from `DEFAULT_KANBAN_COLUMNS` instead of keeping a
second list. Same fix applies here: derive, do not re-implement.

## Metadata

**Complexity:** 4
**Tags:** kanban, dispatch, webview, divergence, standalone
**Related:** `forty-call-sites-still-speak-state-json-and-ten-of-them-bypass-the-bridge`
(the dead-fallback sweep). Not a dependency — the two resolvers read the same
store once delegation is taken into account.
**Scope:** `src/webview/kanban.html`, `src/services/KanbanProvider.ts`,
`src/services/LocalApiServer.ts`. **Standalone only.**

## Constraints

**The browser must not own a routing rule.** This is the same conclusion as
*Every Dispatch Surface Goes Through the CLI Path* — a client that predicts a
rule the host owns is how the two came to disagree. Prefer asking the host over
copying rule 5 into JavaScript.

**Do not fix it by hiding occupied columns.** Stranding cards in an invisible
column is strictly worse than the bug. The occupied carve-out stays.

**A refusal must be visible.** If the host declines to advance a card, the
browser says so. A silent no-op is how "it moved nowhere" becomes "it moved
somewhere wrong" in a user's mind.

## Proposed changes

### 1. The host answers "what is next", and the browser asks

Add the resolved next column to what the host already sends, or expose it as a
single call the advance handler makes. `getNextColumn`'s local computation is
deleted rather than corrected — a corrected copy is still a copy, and the next
rule added to the host diverges again the same day.

### 2. Columns carry `advanceEligible`

Whatever the browser still needs locally (enabling a button, an optimistic
animation) is driven by a boolean the **host** computed, alongside the existing
`enabled`/`enabledSource`, so eligibility and the reason for it travel together
and are auditable.

### 3. A hidden-but-occupied column is a visible dead end

Such a column renders as terminal: it shows its cards, and it is never offered
as an advance target on either side. Optionally it states why — *"holds cards,
agent disabled"* — since the operator's real question is how to drain it.

### 4. A gate that compares the two answers

A contract test that runs both resolvers over the same catalogue and asserts
identical output for every column, including hidden, hidden-occupied,
`featureOnly` and `dragDropMode: 'disabled'`. If change 1 lands fully there is
one resolver and the gate is trivial — which is the point.

## Verification plan

### Automated

- For every column in the catalogue, the browser's advance target equals
  `_getNextColumnId`'s. Asserted per column, not once.
- A role column hidden by `visibleAgents` is skipped by **both** resolvers.
- **The self-perpetuating case:** a hidden column holding one card is published,
  and is still not an advance target in either resolver.
- `ACCEPTANCE TESTED` with no active tester, and `TICKET UPDATER` with
  `ticket_updater: false`, are not advance targets from the browser.
- `kanban.html` contains no list of skip conditions.

### Goal invariants

- One rule decides the next column, on every surface.
- No column can accumulate cards it cannot release.
- A rule added to the host is true in the browser the same day.

### Manual

Set a role to hidden, place one card in its column by hand, and confirm the
card is visible, the column is a dead end, and advancing a card from the column
before it skips past.

## Decided

**The optimistic move STAYS; the local computation goes** (operator, 2026-09-20).

The round trip this appeared to cost is mostly not real. `getNextColumn` serves
three callers, and only one is a prediction:

- `kanban.html:4542` — the advance, which then moves cards optimistically
- `kanban.html:5903` — the **button label**, and whether the button renders
- `kanban.html:6604` — a second advance path

The label must be answered at render time, before any round trip could happen.
So the host has to supply an advance target regardless — and once it does
(change 2), the prediction is free, because the browser animates to a value the
host gave it rather than one it derived. Optimistic UI survives with no local
rule.

The precedent is already in the file, at `kanban.html:6604`, for complexity
routing:

> The optimistic move must either predict that exactly or not move at all —
> otherwise the backend's moveCards delta bounces the card to the real column.

That is the same rule, already applied where the browser knew it could not
predict. This plan extends it to the case nobody noticed it applied to.

**Implementation note.** `kanban.html:5903` carries *"the copyLabel block must
stay inline to preserve the regression-test regex extraction contract"* — a test
greps that block's source. Moving the label to host-supplied data will trip it.
**Retarget that test to the new source of the label; do not delete it.**

## Outstanding questions

- None. Both design questions are settled above.
