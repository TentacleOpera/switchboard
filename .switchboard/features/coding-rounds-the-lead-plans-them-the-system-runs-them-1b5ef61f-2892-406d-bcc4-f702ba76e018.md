# Coding Rounds — the lead plans them, the system runs them

**Complexity:** 5

## Goal

A lead handed a feature decides how to split it into rounds and registers that plan. The system holds the rounds as database state, dispatches each batch, clears the seats, and advances when the lead marks a round done. The lead's judgment stays; the mechanics that produced every defect reported on 2026-09-04 move into the system.

## How the Subtasks Achieve This

- **Coding Rounds 01 — The Round Record**: Adds the `coding_rounds` table (migration V73) so a round is durable database state — feature, team, ordinal, per-subtask seat map, state, timestamps — not a fact living only in the lead's context. Every other subtask reads and writes this row.
- **Coding Rounds 02 — The Lead Registers Its Rounds**: Adds `POST /kanban/round/register` so a lead posts its round plan once. The system validates identity only (never judgment), writes the rows, and reports unrouted subtasks. Re-registration replaces pending rounds and reports the diff.
- **Coding Rounds 03 — The System Dispatches the Round**: Makes dispatching a round one system operation — assign subtasks to seats, clear those seats (scoped to this round, not the roster), deliver prompts, record per-subtask delivery outcome. Re-delivery is safe and does not clear. Partial dispatch records a `partial` state.
- **Coding Rounds 04 — The Lead Marks the Round End, the System Advances**: Extends the existing `POST /kanban/round/complete` with round-record awareness — closes the round row, auto-dispatches the next registered round, and delegates last-round-close to the existing `POST /kanban/feature/complete` to clear the lead and release the team. The lead's only remaining verb is "this round is done."
- **Coding Rounds 05 — The Lead Is Told Its New Contract, and the Board Shows the Rounds**: Adds the `round/register` instruction to the standing orders, removes the hand-dispatch instructions for teams with registered rounds (gated on `hasRegisteredRounds`), reconciles `buildHeadNextFragment` so it does not race `round/complete`, and adds board UI that reads `coding_rounds` to show which round a team is on.

## Dependencies & sequencing

- **Ship 01 first.** The `coding_rounds` table is the foundation — 02, 03, 04, and 05's board UI all read/write it. Nothing else can land before the table exists.
- **Ship 02 and 03 together (or 02 before 03).** 03's dispatch operation reads the rounds 02 registers. 02 without 03 is a registered plan nothing dispatches; 03 without 02 has no rounds to dispatch.
- **Ship 04 after 01, 02, and 03.** The round-complete extension closes a round row (01), needs to know which round is current and next (02), and auto-dispatches the next round via 03's dispatch operation. It also delegates last-round-close to the already-shipped `feature/complete` handler.
- **Ship 05 last (or alongside 02).** The standing-order register instruction must land with 02's route (a route the orders don't name is dead code; orders naming a route that 404s is a broken lead). The dispatch-instruction removal and `headNext` gating depend on 03 and 04 being live (removing hand-dispatch before the system dispatch exists leaves the lead with no way to seat work). The board UI depends on 01's table and 03's dispatch state.
- **Satisfied external prerequisite:** `711fa15e` (*A Lead's Completion Post Must Clear the Seat — `completed_at` Is a Latch That Is Never Reset*) — the `completed_at` latch fix is already in the dispatch and completion paths (`clearCompletedAt` at `LocalApiServer.ts:2875`, `isStaleCompletedAt` at `:3925`). 03 and 04 build on it; no re-fix needed.
- **Already-shipped endpoints:** `POST /kanban/round/complete` (`LocalApiServer.ts:4190`) and `POST /kanban/feature/complete` (`:4311`) exist and are already referenced in the standing orders. 04 extends `round/complete`; it does not create it. 05's problem analysis reflects this.

## Team Dispatch Instructions

### Coding Rounds 01 — The Round Record
- **Seat:** Intern
- **Acceptance:**
  - `coding_rounds` table exists in `SCHEMA_TABLES_SQL` and `MIGRATION_V73_SQL` with identical column sets; V70–V72 bodies are untouched.
  - A fresh database runs the full migration chain through V73 and has the table.
  - A round row survives a process restart and reads back identically in both hosts.
  - Deleting a feature deletes its `coding_rounds` rows (no orphans).
- **Must not touch:** Any shipped `MIGRATION_Vnn_SQL` body (V2–V72). Do not stamp a baseline to skip the chain.

### Coding Rounds 02 — The Lead Registers Its Rounds
- **Seat:** Intern
- **Acceptance:**
  - `POST /kanban/round/register` (singular) is routed in `LocalApiServer`; no plural `rounds/register` variant exists.
  - A lead registers three rounds and reads back three in order; a cross-round or within-round duplicate is rejected with the duplicate named.
  - A subtask omitted from all rounds is reported as unrouted, not rejected.
  - Re-registration replaces pending rounds, leaves dispatched ones, and reports a `diff` field.
  - A null-roster post returns HTTP 400 (not a 200 no-op).
  - Both hosts accept the same payload with the same result.
- **Must not touch:** The existing `POST /kanban/round/complete` handler. Do not copy its null-roster 200-no-op pattern.

### Coding Rounds 03 — The System Dispatches the Round
- **Seat:** Coder
- **Acceptance:**
  - Dispatching a three-subtask round clears the round's seats only (not the full roster) and delivers three prompts, recorded per subtask in `coding_rounds.subtask_seats`.
  - A round with a dropped delivery records `delivered: false` for that subtask and has state `partial`, not `dispatched`.
  - Re-delivery of a missing subtask does not clear its seat and does not compound on repeat.
  - A team with two features in flight: dispatching a round for feature A does not clear seats working feature B.
  - Both hosts produce the same records for the same round.
- **Must not touch:** Do not fork the dispatch logic into a separate primitive — extend `performKanbanDispatch` with a `skipClear` option (option A). Do not clear by roster membership — scope the clear to this round's subtask seats.

### Coding Rounds 04 — The Lead Marks the Round End, the System Advances
- **Seat:** Coder
- **Acceptance:**
  - `POST /kanban/round/complete` (singular) is the only round-completion route; no plural variant exists.
  - A lead posts round-complete once: subtasks completed, seats cleared, round row closed, next round auto-dispatched.
  - Closing the last round delegates to `feature/complete`: every seat including the lead cleared, team released, `onTeamReleased` fires exactly once.
  - A team with no registered rounds receives the same stateless response as before (fallback preserved).
  - The response names what was completed, cleared, the round closed, and the next round dispatched (or `featureComplete: true`).
  - Both hosts produce the same outcome.
- **Must not touch:** Do not create a second round-completion endpoint. Do not reimplement `feature/complete`'s seat-clear-all + team-release — delegate to it. Do not re-fix the `711fa15e` latch (it is satisfied). Do not double-fire `onTeamReleased` — skip the round handler's release check on the delegation path.

### Coding Rounds 05 — The Lead Is Told Its New Contract, and the Board Shows the Rounds
- **Seat:** Coder
- **Acceptance:**
  - `buildHeadCompletionFragment()` names `POST /kanban/round/register` (singular) in its body text.
  - For a team with registered rounds: `CODING_HEAD_WORK` dispatch instructions are absent and `buildHeadNextFragment` is gated out. For a team without: both are present (stateless path preserved).
  - The board round indicator reads from `coding_rounds` (not inferred from card counts); a team with zero rows shows no indicator.
  - A round with `partial` state is visibly distinct from a healthy one.
  - The gate `ctx.inTeam && ctx.isHead && ctx.headRole === 'lead'` is unchanged.
  - Both hosts show the same round state.
- **Must not touch:** Do not widen the standing-order gate for planner/reviewer heads. Do not remove dispatch instructions unconditionally — gate on `hasRegisteredRounds`. Do not infer rounds from dispatched-card counts on the board.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Coding Rounds 01 — The Round Record](../plans/coding-rounds-01-the-round-record.md) — **CODE REVIEWED** — ID: 48aac1fd-3bdf-48bc-ade1-1d4efe03efaf
- [ ] [Coding Rounds 03 — The System Dispatches the Round](../plans/coding-rounds-03-the-system-dispatches-the-round.md) — **CODE REVIEWED** — ID: 15c9c011-2012-43eb-acae-9108298df232
- [ ] [Coding Rounds 02 — The Lead Registers Its Rounds](../plans/coding-rounds-02-the-lead-registers-its-rounds.md) — **CODE REVIEWED** — ID: 247c3815-e7ae-449e-acb1-21c8b1ab6469
- [ ] [Coding Rounds 05 — The Lead Is Told Its New Contract, and the Board Shows the Rounds](../plans/coding-rounds-05-the-lead-is-told-its-new-contract.md) — **CODE REVIEWED** — ID: 23b9f903-977c-499d-abcb-c4b4cd63b105
- [ ] [Coding Rounds 04 — The Lead Marks the Round End, the System Advances](../plans/coding-rounds-04-the-lead-marks-the-round-end.md) — **CODE REVIEWED** — ID: afbf80f6-f311-486d-84b3-449b0baac057
<!-- END SUBTASKS -->

## Implementation Summary

All 5 subtasks shipped across 4 commits. Subtask 01 (intern) added the `coding_rounds` table (migration V73) with orphan prevention on feature delete. Subtask 02 (intern) added `POST /kanban/round/register` with identity-only validation, re-registration diff, and null-roster 400. Subtask 03 (coder-1) added `POST /kanban/round/dispatch` and `round/redeliver` extending `performKanbanDispatch` with `skipClear` to scope the clear to the round's seats, not the roster. Subtask 04 (coder-2) extended `round/complete` with round-record awareness — closes the round row, auto-dispatches the next round, and delegates last-round-close to `_completeFeatureCore` with `clearLead: true` (one fix round: lead was not being cleared on the delegation path). Subtask 05 (coder-1) added the register instruction to standing orders, gated hand-dispatch removal and `buildHeadNextFragment` on `hasRegisteredRounds`, added the board round indicator reading directly from `coding_rounds`, and wired both composition roots via a new `standingOrdersDelivery` seam.


## Review Findings

Reviewed all five subtasks across `f63c9681`, `bb868d8e`, `8af41779`, `8dd191da` and `a8da4102`; four fixes applied to `LocalApiServer.ts`, `TaskViewerProvider.ts`, `standingOrderFragments.ts` and `standalone/bootstrap.ts`. The feature did not achieve its goal as shipped: registering rounds left the team inert, because `round/register` only wrote rows, `round/complete` advances only a round already in flight, and `POST /kanban/round/dispatch` is named in no prompt, CLI or automation while subtask 05's orders explicitly forbid the lead from dispatching — registration now starts round 1 and the goal holds. The other three fixes were a CI-red `compile-tests` gate (nine implicit-`any` errors in the new round handlers; the pre-feature baseline `67cf7216` was clean), a `skipClear` path that skipped the roster barrier's work-context bookkeeping as well as its clear in both hosts, and an unguarded `seats[cursor % 0]` in `_dispatchRoundCore` reachable from the `round/complete` auto-advance. Verification: `tsc -p tsconfig.test.json` clean, `npm run compile` clean, all ten static gates pass (`standalone-parity`, `standalone-fork`, `host-seam-parity`, `kanban-dispatch-callers`, `push-routing`, `verb-returns`, `mirror`, `parity`, `banner`, `icons`), and no contract-suite regression against a baseline worktree — `seat-safeguards` improved 6 red to 4. The core round lifecycle has no automated check that could discriminate on its correctness, so passing these suites is not evidence that a round actually dispatches, drops, or closes correctly on a live board; that verdict is provisional.

## Deferred Findings

- MAJOR — the three new round routes are absent from `protocol-catalog.json`'s `apiEndpoints`, so `npm run catalog:check` (a CI step) reports drift; not regenerated here because that file is mid-edit by another agent. `protocol-catalog.json:1`
- MAJOR — `round/complete` completes and clears roster-wide rather than round-scoped, so a team with two features in flight loses the other feature's cards and seats. Carried forward from the pre-existing stateless handler. `src/services/LocalApiServer.ts:4271`
- MAJOR — the auto-advance path clears every coder seat twice per round boundary (the handler's clear loop, then `_dispatchRoundCore`'s per-destination `clearBeforePrompt`). `src/services/LocalApiServer.ts:4497`
- MAJOR — no automated check discriminates on the feature's core mechanism: nothing registers rounds, dispatches one, drops a delivery and asserts `partial`, or closes the last round and asserts `onTeamReleased` fired once. `src/services/LocalApiServer.ts:4906`
- MAJOR — subtask 05's commit carries unplanned changes to the standing-orders application rule, `bareDelivery`, `sendRobustText`'s default, and the icon picker. `src/services/TaskViewerProvider.ts:1137`
- NIT — `coding_rounds.team_id` is derived from the lead's terminal name; a lead rename orphans its rounds and silently reverts the lead to the hand-dispatch orders. `src/services/LocalApiServer.ts:4666`
- NIT — `POST /kanban/round/redeliver` has no agent-facing trigger, so recovery from a `partial` round is operator-only. `src/services/LocalApiServer.ts:5062`
