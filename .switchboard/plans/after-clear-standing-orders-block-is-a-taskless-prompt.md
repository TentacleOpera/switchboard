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
(`TaskViewerProvider.ts:880-981`) fires whenever a new work context — `featureId ?? planId` —
enters the team, and `computeRosterClearTargets` excludes only two seats: `destination` (the
delivery path owns its own clear) and `origin` (the caller must not clear itself). A board or
Mission Control dispatch is neither, so **the head is in the clear set on every new feature**.
The existing plan `a-deferred-seat-is-curtained-for-a-clear-that-never-runs-and-the-head-is-never-excluded.md`
already names the head-exclusion half of this; it reduces how often this fires but does not
fix what follows.

**2. Every clear is followed by a bare orders block.**
`_deliverStandingOrdersAfterClear` (`TaskViewerProvider.ts:2465`) delegates to
`_deliverStandingOrdersOnEstablish` (`:2355`), which sends the output of
`renderStandaloneOrdersBlock` as the **entire prompt** via `_dispatchExecuteMessage` with
`promptComposed=true`. The method's own comment states the trap plainly:

> "No role argument and no Mission Control skip… **Nothing follows a clear** — for either
> `clearTerminalContext` caller the next dispatch usually goes to a DIFFERENT seat — so this
> one-shot is the cleared terminal's only orders delivery."

So the block is not a preamble to a task. It **is** the prompt, and nothing comes after it.

**3. The block contains no task, and its most actionable sentence is a verification
instruction.** `renderStandaloneOrdersBlock` (`standingOrders.ts:497-536`) emits the marker,
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

**Contrast — the verify instruction that works.** On a coder's completion relay the lead is sent
`TURN_END_VERIFY_INSTRUCTION` (`PlanIngestionEngine.ts:2566`): *"Verify the diff (git diff) before
you trust the report, **then advance the card or register the next subtask… and dispatch it**."*
That one produces verify-then-act, because it carries an action tail. The after-clear block is the
same verification impulse with no tail — which is why it ends in a stop. The fix in step 1 is
therefore not "tell the lead not to verify"; it is to say plainly that this delivery asks for
nothing at all.

**Coders are hit too, less visibly.** A cleared coder receives the same task-less block. It
has no roster to inspect, so it usually stops quietly — but it has also been prompted, which
consumes a turn and can start it reasoning about work it no longer holds context for.

### Why "just don't deliver it" is wrong

The delivery exists because a cleared terminal has genuinely lost its orders — that is the
whole point of `standing-orders-deliver-after-clear.md`, which introduced this path. Removing
it re-opens the window where a seat runs with no callback route, no role rules, and no
constraints. The block must still arrive. What must change is how it is framed.

## Metadata

**Complexity:** 3
**Tags:** backend, reliability, ux
**Project:** Browser Switchboard

## User Review Required

None — the approach is fully specified.

## Complexity Audit

### Routine
- Wrapping the rendered block in an envelope at the send site (`_deliverStandingOrdersOnEstablish`).
- Adding a conditional head-specific line based on the recipient's role.
- The marker block body stays byte-identical — the envelope sits outside `renderStandaloneOrdersBlock`.

### Complex / Risky
- The envelope text must be specific enough that an LLM agent reads it as "do nothing, wait for next dispatch" rather than a suggestion. Vague framing ("Note: …") may not suppress the verification impulse.
- The head-specific condition must be derived from the roleMap (`roleMap.get(terminalName) === 'lead'`), not by re-running `selectOrders` inside the envelope composition — the orders are already loaded inside the shared renderer, and re-deriving outside it duplicates the selection logic.

## Edge-Case & Dependency Audit

**Race Conditions:** The delivery is fire-and-forget (`_deliverStandingOrdersAfterClear` → `.catch()`). The envelope must not change the timing — it is prepended/appended to the block string before the `_dispatchExecuteMessage` call, so no new async surface.

**Security:** No new surface — the envelope is static text composed from the recipient's role, not from caller-supplied data.

**Side Effects:** The envelope changes the prompt content for every after-clear delivery. The `standing-orders-marker-contract.test.js:854` test asserts the rendered block equals what `applyStandingOrders` appends — the envelope must sit OUTSIDE that equality, which it does (it wraps the block at the send site, not inside the renderer).

**Dependencies & Conflicts:**
- Sibling plan `memo-the-roster-clear-barrier-defers-forever-and-clears-the-head-anyway.md` finding 7 owns the standalone wiring gap (see Superseded callout below). This plan's fix applies to the shared `_deliverStandingOrdersOnEstablish` method; the standalone host must be wired to call it before this fix takes effect there.
- The external plan `a-deferred-seat-is-curtained-for-a-clear-that-never-runs-and-the-head-is-never-excluded.md` owns excluding the head from `computeRosterClearTargets`. It reduces the frequency of this bug; it does not fix it. Ship independently.

## Dependencies

- `memo-the-roster-clear-barrier-defers-forever-and-clears-the-head-anyway.md` — finding 7 wires standalone's `clearTerminalContext` to call `_deliverStandingOrdersAfterClear`. Without that wiring, this plan's fix is extension-only.

## Adversarial Synthesis

Key risks: (1) the envelope text is underspecified — a vague framing may not suppress the verification impulse, so the key imperative ("wait for your next dispatch, no action required") must be stated explicitly; (2) the standalone host does not call `_deliverStandingOrdersAfterClear` at all, so this fix is extension-only until the sibling plan's finding 7 wires it; (3) the original step 3 (skip delivery when the head's sole order is its own) contradicts the regression check — a clear with no follow-up dispatch would leave the head with no callback route. Mitigations: specify the envelope text concretely, defer to the sibling plan for standalone wiring, and drop the skip-when-sole-order step (the envelope handles the framing).

## Proposed Changes

### 1. Frame the one-shot as a reference update, not a task

In `_deliverStandingOrdersOnEstablish` (`TaskViewerProvider.ts:2355-2452`), wrap the rendered
block in an explicit non-action envelope before sending — a lead-in line before the block and
a closing line after it, stating that this delivery carries no work: it is a context refresh
after a clear, nothing is being asked, no reply or report is expected, no inspection is
required, and the terminal should wait for its next dispatch.

The envelope must contain an explicit imperative: **"No action is required. Wait for your next
dispatch."** — not a vague note. An LLM agent reads a directive differently from a suggestion.

Compose the envelope where the block is sent (line 2445, the `_dispatchExecuteMessage` call),
not inside `renderStandaloneOrdersBlock`. That function is shared with `applyStandingOrders`,
where the block *is* appended to a real task and the envelope would be actively wrong. Keep
the marker and the block body byte-identical to what `applyStandingOrders` appends —
`standing-orders-marker-contract.test.js:854` asserts that "the block it returns is what
applyStandingOrders appends", and the envelope must sit outside that equality, not inside it.

### 2. Suppress the roster-verification reading for heads specifically

The envelope in step 1 handles the general case. For a `team-head` recipient the pull toward
roster inspection is strongest, because its order text is a dispatch rulebook. Add one line to
the envelope, conditional on the recipient's role being `lead`: state that the roster and
membership rules below apply to the *next* dispatch and are not a request to check the roster
now.

Resolve the condition from the roleMap already built in the method —
`roleMap.get(terminalName) === 'lead'` — not by re-reading the DB, re-listing terminals, or
re-deriving `scopeOf(o)` outside the renderer. The roleMap is built at lines 2413-2419 and is
in scope at the send site.

### 3. Complementary, already planned — do not duplicate here

Excluding the head from `computeRosterClearTargets` belongs to
`a-deferred-seat-is-curtained-for-a-clear-that-never-runs-and-the-head-is-never-excluded.md`.
It reduces the frequency of this bug; it does not fix it, because any cleared seat still gets
a task-less prompt. Ship them independently; neither blocks the other.

> **Superseded:** Step 3 of the original plan — "Do not deliver a block that is only the head's own dispatch rulebook" — which proposed skipping delivery when the head's own `team-head` order is the sole applicable order.
> **Reason:** The skip contradicts the plan's own regression check (verification step 6: "after a clear with no follow-up dispatch, confirm the seat still holds its callback route"). If the head's sole order IS the callback route, skipping it means the head has no callback route after a clear with no follow-up dispatch — exactly the scenario in root cause #1 (a roster barrier clears the head, the dispatch goes to a coder, the head gets no follow-up). The envelope in step 1 already handles the "no task" framing; the skip adds a risky behavioural change for a marginal saving.
> **Replaced with:** Drop the skip. Keep the delivery for all recipients. The envelope handles the framing — the head receives its orders back but is told explicitly not to act on them until the next dispatch.

## Verification Plan

### Automated Tests

1. `node --require ./src/test/bootstrap/sandboxStateHome.js src/test/standing-orders-marker-contract.test.js`
   — passes unchanged, in particular `:854` (the rendered block equals what `applyStandingOrders`
   appends). If that assertion fails, the envelope leaked into the shared renderer.
2. `src/test/standing-orders-definitions-contract.test.js` — passes unchanged.
3. New assertions: the after-clear delivery payload contains the non-action envelope (with the
   explicit "No action is required. Wait for your next dispatch." imperative) and the
   unmodified marker block; a head recipient (`roleMap.get(name) === 'lead'`) receives the
   roster-deferral line; a non-head recipient does not.

### Goal Invariants

- `renderStandaloneOrdersBlock` in `src/services/standingOrders.ts` is unchanged — the envelope is composed at the `_dispatchExecuteMessage` call site in `_deliverStandingOrdersOnEstablish`, not inside the renderer.
- The string returned by `renderStandaloneOrdersBlock` is byte-identical before and after this change (asserted by `standing-orders-marker-contract.test.js:854`).
- The after-clear delivery payload contains the literal phrase "No action is required" — a vague note without an explicit imperative does not satisfy the goal.
- A head recipient whose only applicable order is its own `team-head` order still receives a delivery (the skip was dropped).

### Manual Verification

4. Manual, extension host: run a feature into a coding team so the roster barrier clears the
   lead. Confirm the lead's terminal shows the orders block framed as a reference update and
   that the lead does **not** call `ptyListTerminals` or end its turn on a verification pass.
   Then confirm the next dispatch still lands and is worked normally.
5. Manual: clear a coder mid-run and confirm the same — orders restored, no turn consumed, next
   dispatch worked.
6. Regression check on the reason the path exists: after a clear with no follow-up dispatch,
   confirm the seat still holds its callback route by having it complete an ad-hoc task and
   verifying the report reaches the lead.

### Both Hosts

> **Superseded:** The original verification step 7 stated: "`_deliverStandingOrdersOnEstablish` lives in the shared `TaskViewerProvider`, so no composition-root wiring changes — but run the manual pass under the standalone host too, since standalone 'reaches this method through its own bootstrap path.'"
> **Reason:** This is false. Standalone's `clearTerminalContext` (`bootstrap.ts:3320-3357`) ends with `relayStartupOrientation([terminalName])` at line 3344 — it does NOT call `_deliverStandingOrdersAfterClear`. The method is extension-only. The standalone host has no after-clear standing-orders delivery at all.
> **Replaced with:** This plan's fix applies to the shared `_deliverStandingOrdersOnEstablish` method in `TaskViewerProvider.ts`. The standalone host must be wired to call `_deliverStandingOrdersAfterClear` from its `clearTerminalContext` before this fix takes effect there. That wiring is owned by the sibling plan `memo-the-roster-clear-barrier-defers-forever-and-clears-the-head-anyway.md` finding 7. Until that wiring lands, the manual standalone pass (step 5) cannot be run — there is no delivery to frame.

**Recommendation:** Complexity 3 → Send to Intern.

## Review Findings

Reviewed 2026-09-04. Goal achieved on the extension host as specified: the envelope is composed at the `_dispatchExecuteMessage` call site in `_deliverStandingOrdersOnEstablish`, gated on a new `isAfterClear` opt, carries the literal imperative "No action is required. Wait for your next dispatch.", adds the roster-deferral line only when `roleMap.get(terminalName) === 'lead'`, and `renderStandaloneOrdersBlock` in `standingOrders.ts` is byte-identical. On the standalone host the fix was inert-and-worse: `bootstrap.ts:3378` called `relayStartupOrientation` **and** `deliverStandingOrdersAfterClear`, so a cleared seat received two prompts and one of them was the bare, un-enveloped block this plan exists to reframe — fixed by replacing the relay. Files changed: `src/standalone/bootstrap.ts`, `src/test/host-auto-clear-on-plan-change.test.js` (new envelope + no-leak assertions). Verification: `test:contract:standing-orders-marker` and `test:contract:standing-orders-definitions` are red at HEAD independently of this work (A/B-verified against the pre-feature `standingOrderFragments.ts`; the failures are `wireSpawnedTeam` order counts and missing `definitionId`, unrelated to the envelope), so the plan's step 1 and 2 assertions are covered by the new `host-auto-clear` assertions instead. Manual steps 4-6 were not run — the framing's effect on a live agent has no automated discriminator, so that half of the verdict is provisional.

## Deferred Findings

- MAJOR `src/test/standing-orders-marker-contract.test.js` — CI-wired via `test:contract:standing-orders-marker` and red at HEAD from `8258ce4b`, so this plan's requirement that it "passes unchanged" cannot currently be demonstrated. Not caused by this work.
