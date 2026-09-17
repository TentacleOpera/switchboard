# `next` Is Dispatch With a Priority Filter

## Goal

`switchboard next` dispatches the highest-priority card an operator could have dispatched by hand.
It chooses the card; everything after that choice is `dispatch`, unchanged. It is an operator
command — no seat, no team, no queue.

### Problem analysis

**What `next` is meant to be.** One sentence: **`next` is `dispatch` with a priority filter.**

- The candidate set is what is ready to dispatch, optionally narrowed by `--project` or
  `--complexity`.
- Selection is the board's own priority order: **starred first, then urgency (the `priority` field),
  then most recent**. That is `compareByPrecedence` in `'priority'` mode, unchanged — `next` adds no
  ordering of its own.
- A star means *in the current sprint*. Starring **is** the queue; there is no second queue concept.
- Once a card is chosen, the behaviour is `dispatch`'s, byte for byte.

**What is built instead.** `cmdNext` (`cli.ts:2358`) and `_runQueuePop`
(`LocalApiServer.ts:3938`) implement something else entirely:

| | intended | built |
| --- | --- | --- |
| candidate set | ready cards (`PLAN REVIEWED`, `CREATED`) | cards in the `STAGING` column |
| selection | starred → priority → most recent | `column_order` / `queue_position`, manual |
| stars | **are** the queue | **explicitly ignored** |
| caller | an operator | a seat, popping its own next work |
| scope | the board | a team, with `pacing` resolution |

**1. It refuses to run without a seat identity.** `cmdNext` requires `SWITCHBOARD_TERMINAL` or
`--from <seat>`, and exits 5 with *"`next` is run from inside a seat"* when neither is present. An
operator at a terminal is not a seat, so the command an operator most wants is the one they cannot
run. The `--from` flag should not exist on this command at all.

The refusal itself is correct for what the command currently does — *"a pop attributed to the wrong
seat hands that seat's card to someone else"* — but that hazard is created by the seat-scoping this
plan removes. A dispatch chooses its own target the way `dispatch` already does; nothing is
attributed to a requester.

**2. It pops from `STAGING`, which is being deprecated.** `_runQueuePop` filters
`p.kanbanColumn !== 'STAGING'`. When the column goes, `next` has no candidates and silently returns
nothing.

**3. Stars are suppressed, by a rule that expires with the column.** `kanbanOrdering.ts` states the
precedence plainly:

```
 * 1. starred first (priority_starred: 1 before 0) — OUTSIDE STAGING ONLY.
 * 2. manual order (column_order …)
 * 3. column_entered_at DESC (most recently moved to column first)
```

```js
if (!isStaging) { /* star comparison */ }
```

The stated reason is that *"letting the star jump a mission's queue would let board-level urgency
reorder a sequence the mission already committed to."* That is an argument about **missions**, and
it is a good one — it is not an argument against stars ordering the board. `next` is not a mission
runner and must not inherit a mission's rule.

**The pieces already exist; nothing assembles them.**

- `compareByPrecedence(a, b, column, mode)` in `kanbanOrdering.ts` **is** the intended ordering:
  starred first, then priority in `'priority'` mode, then `column_entered_at DESC`.
- `READY_COLUMNS = ['PLAN REVIEWED', 'CREATED']` (`cli.ts:690`) with subtasks excluded
  (`featureId === ''`) **is** the intended candidate set — the same set `switchboard ready` lists and
  the Mission Control protocol calls "What Is Ready To Go".
- `cmdDispatch` **is** the intended action.

So this is assembly, not invention: take the `ready` set, sort it with the function that already
encodes the precedence, dispatch the top one. The only genuinely new surface is `--complexity`.

### What already works and must not be disturbed

- **`dispatch`.** `next` selects a card and then behaves exactly as `dispatch` does. No second
  dispatch path, no divergent copy of its column/seat resolution.
- **`ready`'s definition of the candidate set.** One definition of "dispatchable", shared.
- **`compareByPrecedence`.** One ordering implementation. `board-collapse-03` already records two
  hand-rolled copies of ordering rules in `moveCardElements` that know nothing of the shipped
  priority order-by; a third copy inside `next` would be the same defect again.
- **Missions.** Untouched. A mission's committed sequence is not reordered by stars, and this plan
  does not change that — it only stops `next` behaving as though the board were one.

### Non-goals

- **Deprecating `STAGING`.** Tracked elsewhere. This plan stops `next` depending on it; it does not
  remove the column.
- **Changing what `dispatch` does** once it has a card.
- **Changing mission queue ordering.**
- **A queue.** Starring is the queue. No staging concept, no positions, no second ordering.

## Metadata

**Feature:** (unassigned)
- **Complexity:** 5
- **Tags:** cli, backend, kanban

## User Review Required

- **[RESOLVED 2026-09-17] No random tiebreak — most recent wins.** Operator: *"no need for fancy
  tiebreak, just choose the most recent."* That is already step 3 of `compareByPrecedence`
  (`column_entered_at DESC`), so there is **no tiebreak code to write**. `next` is deterministic:
  the same board dispatches the same card.
- **[RESOLVED 2026-09-17] `priority` is the urgency field.** So `compareByPrecedence(..., 'priority')`
  implements the intended order end to end — starred, then priority, then most recent. `next` writes
  no ordering of its own.
- **[RESOLVED 2026-09-17] `--complexity` is a general match** against the complexity bands the
  product already has. Dispatch routes on them today: *"default bands 1–4 intern / 5–6 coder / 7+
  lead; honors custom routing maps"* (`LocalApiServer.ts:3440`). `--complexity` resolves through that
  same map rather than a second, hardcoded band list — a custom routing map must narrow `next` the
  way it routes dispatch.

## Complexity Audit

### Routine

- Filtering the ready set and sorting it with an existing comparator.
- Handing the chosen card to the existing dispatch path.
- Removing `--from` and the `SWITCHBOARD_TERMINAL` requirement from `cmdNext`.

### Complex / Risky

- **`next` currently has callers that are not operators.** `_runQueuePop` is called in-process by the
  schedule timer, the `Run queue` button, the handoff, and the seat-paced `queue/done` handler, all
  through one serialisation point. Those callers want the *existing* seat-and-team behaviour. This
  plan changes the **CLI command**, and must not silently re-point those callers at board-priority
  selection — that would reorder work for every team on the board.

  The honest shape is that `switchboard next` stops calling `queue/next` and calls a new
  priority-selection path instead, leaving `queue/next` to its in-process callers until STAGING's
  deprecation deals with them.

- **`--complexity` must resolve through the board's routing map**, not a copy of the bands. The
  bands are configurable; a hardcoded `1-4 / 5-6 / 7+` in `next` would filter differently from the
  way the same board routes a dispatch, on the same card, in the same command.

## Edge-Case & Dependency Audit

### Race Conditions

- **Two operators run `next` at once.** Both select before either dispatches, and the same card goes
  twice. The board already tolerates this — *"V81: the board never refuses a dispatch… a duplicate
  dispatch is valid; it overwrites the advisory owner"* — so this is not a correctness failure, but
  `next` should report the card it dispatched so the second operator sees what happened.

### Side Effects

- **An empty candidate set must be ordinary.** No ready cards, or none matching the filters, is a
  normal outcome, not an error: say so plainly and exit 0. Treating it as a failure makes an idle
  board look broken.
- **Removing `--from` is a breaking change** for anyone driving `next` by hand today. It is also the
  point of the plan. Say so in the help text rather than accepting it silently.

### Dependencies & Conflicts

- Sequences with the `STAGING` deprecation but does not block on it — `next` stops reading STAGING
  either way.
- Standalone only, per the cutover rule.

## Adversarial Synthesis

The risk is that `next` and `queue/next` share a name and a history but not a purpose, and a coder
collapsing them would re-point the schedule timer, the queue button and the handoff at board-wide
priority selection — reordering work for every team. The mitigation is stated in Complex/Risky: the
CLI command gets its own selection path; the in-process callers keep theirs.

The second risk is a third copy of the ordering rules. There are already two that do not know about
the shipped priority order-by. `next` calls `compareByPrecedence` or it is wrong.

## Proposed Changes

### 1. `next` selects by board priority over the ready set

Candidate set: the `READY_COLUMNS` set (`PLAN REVIEWED`, `CREATED`), subtasks excluded — the same
set `ready` lists. Narrowed by `--project` and `--complexity` when given.

Order with `compareByPrecedence(..., mode: 'priority')` and take the first: starred first, then
priority (the urgency field), then `column_entered_at` descending — most recent wins a tie.

That comparator is the **entire** selection rule. `next` writes no ordering logic, no tiebreak and no
randomisation; it filters, sorts with the existing function, and dispatches `[0]`.

Dispatch the chosen card through the existing dispatch path. Report which card was chosen and why —
star, priority and date — so an operator can see the selection rather than guess it.

### 2. `next` is not seat-scoped

Remove `--from` and the `SWITCHBOARD_TERMINAL` requirement from the CLI command. `next` no longer
refuses without a seat identity, because it no longer attributes a pop to a requester — it
dispatches the way `dispatch` does.

`queue/next` and its in-process callers are untouched by this change.

### 3. A declared dependency excludes a card; an absent one never blocks

Where a card has a dependency recorded in `plan_dependencies` and its predecessor has not completed,
that card is not a candidate — `next` skips it and takes the next in precedence. A card with **no**
declared dependency is always a candidate.

This must be a **filter, not a refusal.** The existing pop makes the same distinction and says why:
refusing on the chosen card would 409 the whole call and never reach the independent work behind it.
`next` has the same obligation — one blocked card must not stop the command returning a different,
dispatchable one.

Dependencies are optional and frequently absent. `isDependencyReady` in `kanbanOrdering` is the
shared readiness rule and is NULL-inert: with no rows in `plan_dependencies` this costs one empty
query and changes nothing. **Missing dependency data is not a blocker and must never be treated as
one** — an undeclared dependency reads as "no dependency", which is the correct and safe default
here, because the operator dispatching by hand had no gate either.

### 4. `--project` and `--complexity` narrow the search

`--project` matches `dispatch`'s existing flag. `--complexity` is new; semantics per User Review.

Both filter the candidate set **before** ordering, so narrowing never changes the precedence among
what survives.

## Verification Plan

### Automated Tests

- **A starred card outranks an unstarred one** with higher priority and a newer date.
- **Among starred cards, higher urgency wins**; among equals, newer wins.
- **Ties go to the most recent**, and `next` is deterministic: repeated runs against an unchanged
  board choose the same card.
- **No seat identity is required.** `next` with no `SWITCHBOARD_TERMINAL` and no `--from` dispatches.
- **`--from` is gone**, and passing it is a usage error rather than a silent no-op.
- **STAGING is not consulted.** A board whose only cards are in STAGING yields "nothing to dispatch".
- **Filters apply before ordering**: `--project` narrowing does not change the relative order of what
  remains.
- **A blocked dependency skips, it does not fail**: a board whose top-precedence card has an
  incomplete predecessor dispatches the next eligible card, not an error.
- **No dependency rows is business as usual**: an empty `plan_dependencies` table changes nothing
  about which card is chosen.
- **Empty is not an error**: no candidates exits 0 with a plain message.
- **One ordering implementation**: the selection path calls `compareByPrecedence` and does not
  re-implement precedence.
- **`queue/next` is unchanged**: its in-process callers still get seat-and-team behaviour.

### Goal Invariants

- `next` dispatches the card an operator applying the board's own priority order would have picked.
- A card whose declared dependency is unmet is skipped; a card with no declared dependency is never
  skipped.
- `next` never requires a seat, a team or a queue.
- Everything after card selection is `dispatch`'s behaviour.
- Stars order the board; missions are unaffected.
- No second ordering implementation exists.
- An empty board is an ordinary outcome.

## Outstanding Questions

- **What happens to `queue/next` when STAGING goes?** Out of scope here, but its in-process callers
  will need a source. This plan deliberately leaves them alone rather than guessing.
(none outstanding)
