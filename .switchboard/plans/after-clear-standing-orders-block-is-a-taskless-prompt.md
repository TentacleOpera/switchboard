# The after-clear standing-orders block is a task-less prompt, so the lead wakes, inspects, and stops

## Goal

Make the one-shot standing-orders delivery that follows a terminal clear read as a reference
update rather than as work, so a cleared lead does not spend a turn verifying its roster and
then stop. The orders must still arrive — a cleared terminal really has lost them — but
arriving must not consume the turn that should have gone to the next dispatch.

### The problem

After the system clears a team lead's terminal, the lead receives a prompt, performs a
verification pass over its terminals, and stops. No work is dispatched. The operator sees a
lead that woke up, looked around, and went idle.

### Root cause — a rulebook delivered as a prompt is read as a task

Three mechanisms combine.

**1. The lead gets cleared in the first place.** The roster-clear barrier
(`TaskViewerProvider.ts:755-905`) fires whenever a new work context — `featureId ?? planId` —
enters the team, and `computeRosterClearTargets` excludes only two seats: `destination` (the
delivery path owns its own clear) and `origin` (the caller must not clear itself). A board or
Mission Control dispatch is neither, so **the head is in the clear set on every new feature**.
The existing plan `a-deferred-seat-is-curtained-for-a-clear-that-never-runs-and-the-head-is-never-excluded.md`
already names the head-exclusion half of this; it reduces how often this fires but does not
fix what follows.

**2. Every clear is followed by a bare orders block.**
`_deliverStandingOrdersAfterClear` (`TaskViewerProvider.ts:2290`) delegates to
`_deliverStandingOrdersOnEstablish` (`:2182`), which sends the output of
`renderStandaloneOrdersBlock` as the **entire prompt** via `_dispatchExecuteMessage` with
`promptComposed=true`. The method's own comment states the trap plainly:

> "No role argument and no Mission Control skip… **Nothing follows a clear** — for either
> `clearTerminalContext` caller the next dispatch usually goes to a DIFFERENT seat — so this
> one-shot is the cleared terminal's only orders delivery."

So the block is not a preamble to a task. It **is** the prompt, and nothing comes after it.

**3. The block contains no task, and its most actionable sentence is a verification
instruction.** `renderStandaloneOrdersBlock` (`standingOrders.ts:440-465`) emits the marker,
the applicable orders, and closes with "These apply to everything you do in this terminal
until told otherwise." — a durability clause, not an instruction. For a lead, the rendered
orders include the `team-head`-scoped order whose text is the head prompt itself, and its
first actionable sentence is:

> "Your team's seats are the `ptyListTerminals` rows whose `parentInstanceId` matches your
> `SWITCHBOARD_AGENT_INSTANCE_ID` — role alone is not a membership test…"

That sentence is written to constrain *dispatch*. Delivered with no card and no task, it is
the only thing in the prompt an agent can act on — so the lead lists terminals, confirms
membership, finds nothing to dispatch, and ends its turn. **That is the answer to "why is it
verifying?"**: it is not verifying by choice, it is executing the only imperative in a prompt
that contains no work.

This is the same class as the already-planned prefix waste in
`feature_plan_20260821090653_team-lead-redundant-port-and-terminal-name-checks.md` ("Habit —
verify-before-trust instinct fired"), but the mechanism is different and that plan does not
reach it: there the lead had a task and wasted a round-trip; here the lead has no task at all,
so the verification *is* the whole turn.

**Coders are hit too, less visibly.** A cleared coder receives the same task-less block. It
has no roster to inspect, so it usually stops quietly — but it has also been prompted, which
consumes a turn and can start it reasoning about work it no longer holds context for.

### Why "just don't deliver it" is wrong

The delivery exists because a cleared terminal has genuinely lost its orders — that is the
whole point of `standing-orders-deliver-after-clear.md`, which introduced this path. Removing
it re-opens the window where a seat runs with no callback route, no role rules, and no
constraints. The block must still arrive. What must change is how it is framed.

## Implementation

### 1. Frame the one-shot as a reference update, not a task

In `_deliverStandingOrdersOnEstablish` (`TaskViewerProvider.ts:2182-2276`), wrap the rendered
block in an explicit non-action envelope before sending — a lead-in line before the block and
a closing line after it, stating that this delivery carries no work: it is a context refresh
after a clear, nothing is being asked, no reply or report is expected, no inspection is
required, and the terminal should wait for its next dispatch.

Compose the envelope where the block is sent, not inside `renderStandaloneOrdersBlock`. That
function is shared with `applyStandingOrders`, where the block *is* appended to a real task
and the envelope would be actively wrong. Keep the marker and the block body byte-identical to
what `applyStandingOrders` appends — `standing-orders-marker-contract.test.js:828` asserts
that "the block it returns is what applyStandingOrders appends", and the envelope must sit
outside that equality, not inside it.

### 2. Suppress the roster-verification reading for heads specifically

The envelope in step 1 handles the general case. For a `team-head` recipient the pull toward
roster inspection is strongest, because its order text is a dispatch rulebook. Add one line to
the envelope, conditional on the recipient holding a `team-head`-scoped order: state that the
roster and membership rules below apply to the *next* dispatch and are not a request to check
the roster now.

Resolve the condition from the orders already loaded in the method — `scopeOf(o) === 'team-head'`
— not by re-reading the DB or re-listing terminals.

### 3. Do not deliver a block that is only the head's own dispatch rulebook

If, after selection, the only order applying to a head is its own `team-head` order — the text
the lead already received verbatim in its spawn prompt and every dispatch — the delivery adds
nothing a dispatch would not carry moments later. Skip it and log the skip, the same way the
method already returns silently when `renderStandaloneOrdersBlock` yields `null`.

Keep this narrow: skip only when the head's own order is the *sole* applicable order. A head
carrying pair or global orders still needs them back.

### 4. Complementary, already planned — do not duplicate here

Excluding the head from `computeRosterClearTargets` belongs to
`a-deferred-seat-is-curtained-for-a-clear-that-never-runs-and-the-head-is-never-excluded.md`.
It reduces the frequency of this bug; it does not fix it, because any cleared seat still gets
a task-less prompt. Ship them independently; neither blocks the other.

## Verification Plan

1. `node --require ./src/test/bootstrap/sandboxStateHome.js src/test/standing-orders-marker-contract.test.js`
   — passes unchanged, in particular `:828` (the rendered block equals what `applyStandingOrders`
   appends). If that assertion fails, the envelope leaked into the shared renderer.
2. `src/test/standing-orders-definitions-contract.test.js` — passes unchanged.
3. New assertions: the after-clear delivery payload contains the non-action envelope and the
   unmodified marker block; a head whose only applicable order is its own `team-head` order
   receives no delivery; a head with an additional pair order still receives one.
4. Manual, extension host: run a feature into a coding team so the roster barrier clears the
   lead. Confirm the lead's terminal shows the orders block framed as a reference update and
   that the lead does **not** call `ptyListTerminals` or end its turn on a verification pass.
   Then confirm the next dispatch still lands and is worked normally.
5. Manual: clear a coder mid-run and confirm the same — orders restored, no turn consumed, next
   dispatch worked.
6. Regression check on the reason the path exists: after a clear with no follow-up dispatch,
   confirm the seat still holds its callback route by having it complete an ad-hoc task and
   verifying the report reaches the lead.
7. Both hosts. `_deliverStandingOrdersOnEstablish` lives in the shared `TaskViewerProvider`, so
   no composition-root wiring changes — but run the manual pass under the standalone host too,
   since standalone reaches this method through its own bootstrap path.

## Metadata

**Complexity:** 3
**Tags:** backend, reliability, ux
