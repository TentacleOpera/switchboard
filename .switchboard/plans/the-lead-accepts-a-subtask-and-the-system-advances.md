# The Lead Accepts a Subtask, and the System Advances

kanbanColumn: CREATED

## Goal

The lead has **one** verb: *this subtask is accepted*. The system closes the round when the last
subtask in it is accepted, dispatches the next round, and completes the feature when the last round
closes. `round/complete` and `feature/complete` stop being things a lead is told to post.

### Problem analysis

**The runsheet design is built; the lead's contract did not follow it.** Coding Rounds shipped the
whole mechanism — the `coding_rounds` record (`KanbanDatabase.ts:1086`), `POST /kanban/round/register`
(`LocalApiServer.ts:5055`), the system-dispatch half `_dispatchRoundCore` (`:5453`), and
`CODING_HEAD_WORK_WITH_ROUNDS` (`standingOrderFragments.ts:174`), the lead variant with hand-dispatch
removed. The lead registers rounds and the system seats them. That half is done.

But `buildHeadCompletionFragment` still hands the lead **three** posts:

| Site | Post | Is this a lead decision? |
| :--- | :--- | :--- |
| `standingOrderFragments.ts:113` | `POST /kanban/task/complete` per subtask | **Yes** — accepting the work is the lead's judgment |
| `:121` | `POST /kanban/round/complete` at the round boundary | No — derivable from the accepts |
| `:125` | `POST /kanban/feature/complete` at the end | No — already delegated server-side |

The third is the clearest: `_handleKanbanRoundComplete` already delegates to
`_handleKanbanFeatureComplete` when the closed round was the last (`:5842`). The lead is instructed to
post something the system does for it.

**Why per-subtask accept and not round-close.** Coding Rounds 04's goal sentence is *"The lead's only
remaining verb is 'this round is done'"*, and its problem analysis is the 2026-09-04 run where a lead
posted three completions and one took effect. That argues for fewer posts — but it buys reliability by
having the lead assert **less**, and what it stops asserting is the per-subtask judgment.

Round-close is one blanket claim over N units of work. A round closed with one bad subtask in it
completes that subtask anyway: the lead's mistake is invisible and the card ships. Per-subtask accept
inverts the failure — an unaccepted subtask simply does not advance the round, which surfaces as a
stall the operator can see rather than a completion nobody questions. This is CLAUDE.md's rule about
choosing the failure that is visible or safe, applied to a completion assertion instead of a config
read. It is also the only shape under which the fragment's own rejection story works: *"you reject by
sending a fix round first"* requires acceptance to be per-subtask.

**And the one remaining post still hand-assembles.** `:113` tells the lead to POST
`{"from":"<your terminal name>","planId":"<that SUBTASK's planId>","workspaceRoot":"<your cwd>"}` as
raw JSON. Of those three fields only `planId` is the lead's; `from` is in the lead's own environment
(`ptyFleetService.ts:546` sets `SWITCHBOARD_TERMINAL` for every seat, with no role branch, leads
included) and `workspaceRoot` is the host's. There is no CLI verb for this at all — `grep task/complete
src/standalone/cli.ts` returns nothing — so unlike the seat, the lead cannot be handed a bare command.
This is the same friction *A Seat Reports Done and Nothing Else* removed from the seat, still present
in the role that posts most often.

> **Supersedes Coding Rounds 04's lead contract.** Subtask 04 ("The Lead Marks the Round End, the
> System Advances") is implemented and its server-side machinery is kept in full — this plan reuses
> `_dispatchRoundCore` and the feature-complete delegation rather than rebuilding them. What it
> replaces is 04's *lead-facing* contract: the round boundary stops being a verb the lead posts and
> becomes a consequence of the last accept. `POST /kanban/round/complete` remains as an endpoint for
> teams with no registered rounds (the stateless path) and as a manual override; it is removed from
> the lead's standing orders, not from the server.

### Non-goals

- **Deleting `/kanban/round/complete` or `/kanban/feature/complete`.** Both stay. Teams that never
  registered rounds still complete through the stateless path, and removing either would break them.
  This plan changes which verbs the lead is *told* to use.
- **Re-deriving completion.** The lead's accept is still the only fact the system acts on. Do not
  sample activity, consult mtimes, or infer acceptance from board position.
- **Touching the seat's `done`.** The seat's path is settled. A seat reports finished; the lead accepts.
  Two different assertions by two different roles.
- **New recovery-budget machinery.** Out of scope, as in the rest of this feature.
- **Wiring anything into `extension.ts`.** Per CLAUDE.md, the release is a hard cutover; new seams land
  in the standalone root only.

## Metadata

- **Complexity:** 5
- **Feature:** Coding Rounds
- **Tags:** teams, completion, dispatch, api, cli

## User Review Required

None. The contract fork (per-subtask accept vs per-round close) was decided by the author on
2026-09-14 in favour of per-subtask accept, on the grounds that round-close hides a bad subtask inside
a blanket claim.

## Complexity Audit

### Routine

- Dropping the ROUND BOUNDARY (`:121`) and FEATURE COMPLETE (`:125`) paragraphs from
  `buildHeadCompletionFragment` for the **rounds-registered** lead variant.
- Adding a `cmdAccept` to `src/standalone/cli.ts` that mirrors `cmdDone`'s identity resolution — the
  pattern is already written and tested (`cli.ts:2012-2040`), this is the same shape with a required
  `--plan`.
- Registering the verb in the dispatch list (`cli.ts:3334`) and the entry switch (`:4331`).

### Complex / Risky

- **Detecting "last accept in the round" without inventing a second source of truth.**
  `coding_rounds.subtask_seats` records `{ seat, delivered, delivered_at }` per subtask — it says what
  was *dispatched*, not what was accepted. The accept path must decide round completion from the cards'
  own completion state for the subtasks named in that round, not by counting accepts, or a re-accepted
  or manually-completed subtask miscounts.
- **Idempotence.** Accepting an already-accepted subtask must not advance the round twice. Two accepts
  landing close together must not both see "last one" and both dispatch the next round. The round-state
  transition (`registered`/`dispatched`/`partial` → `closed`) is the natural guard: close the row
  conditionally on its current state and let the loser observe it is already closed.
  **Clarification:** the existing `closeCodingRound` (`KanbanDatabase.ts:8427`) is **unconditional** —
  its own comment states "this method does not re-check state — it stamps unconditionally so a close
  is never silently dropped." It returns `changes > 0` for an already-closed row, so it CANNOT serve
  as the guard. The accept path needs a **conditional close**: add `closeCodingRoundIfOpen(roundId,
  closedAt)` with `UPDATE coding_rounds SET state='closed', closed_at=? WHERE round_id=? AND state IN
  ('dispatched','partial')`, returning `changes > 0` only when THIS caller was the one that closed it.
  The loser observes `changes === 0` (already closed) and returns `roundAlreadyClosed` without
  dispatching. `coding_rounds` is unreleased (clean break), so the new method is additive — no
  migration, no column.
- **Not double-firing the release.** `_handleKanbanRoundComplete` already skips its own
  `onTeamReleased` when it delegates to feature-complete (Coding Rounds 04). The accept path must go
  through the same delegation, not a parallel one — two release paths is how the `completed_at` latch
  came back last time. **Clarification:** the existing `_handleKanbanTaskComplete` handler ALREADY
  fires `onTeamReleased` in a fire-and-forget `void (async () => …)` at `LocalApiServer.ts:4710`
  after every successful completion. When the accept path delegates to `_completeFeatureCore` (which
  also releases), that fire-and-forget wakes, sees `inFlight === false` (feature-complete cleared
  everything), and fires `onTeamReleased` a SECOND time. The accept path must **suppress the existing
  fire-and-forget when it takes the round/feature-complete branch** — gate it on `!roundAdvanced`, or
  skip the `:4710` block entirely when the accept path took over release. This is the second release
  path the plan's "not double-firing" point must cover; it sits in the same handler, three lines above
  the response write.
- **Teams with no registered rounds.** An accept from a lead whose team has no `coding_rounds` rows
  must behave exactly as `task/complete` does today: complete the card, clear the seat, stop. No round
  lookup, no advance.

## Edge-Case & Dependency Audit

- **Race conditions:** two accepts for the last two subtasks of a round arriving concurrently. Guarded
  by the conditional close (`closeCodingRoundIfOpen`, see Complexity Audit above) — the second observes
  `changes === 0` (state already `'closed'`) and returns `roundAlreadyClosed` rather than dispatching
  again. The existing `closeCodingRound` is unconditional and CANNOT serve as this guard.
- **Security:** unchanged. `from` resolves from the lead's own `SWITCHBOARD_TERMINAL`, the same trust
  anchor already used when a lead types it by hand. Defaulting to it does not widen the trust surface.
- **Identity reads (CLAUDE.md):** `cmdAccept` must fail loudly when `SWITCHBOARD_TERMINAL` is absent,
  naming the variable and offering `--from` as the manual override, and must tag the resolved identity
  with its source (`fromSource`) exactly as `cmdDone` does. No placeholder, no `'unknown'` — a subtask
  accepted as the wrong lead clears the wrong seat.
- **Release double-fire (the existing task/complete path):** `_handleKanbanTaskComplete` fires
  `onTeamReleased` in a fire-and-forget at `LocalApiServer.ts:4710` on every successful completion.
  When the accept path delegates to `_completeFeatureCore` (which releases), that fire-and-forget
  fires a SECOND time. The accept path must suppress it on the round/feature-complete branch — see
  Complexity Audit. A test must assert `onTeamReleased` fires exactly once on the last-accept-of-last
  round path, not merely that the team ends released.
- **Migrations:** none. `coding_rounds` shipped in V73; this plan adds no column. The new
  `closeCodingRoundIfOpen` method is a new code path, not a schema change — `coding_rounds` is
  unreleased, so no migration is owed. If the "last accept" detection needs per-subtask acceptance
  state, prefer deriving it from the cards over adding a column to `subtask_seats` — and if a column
  proves unavoidable, it is additive with a default and the install base is unaffected.
- **Dependencies & conflicts:**
  - `standingOrderFragments.ts:113-127` — the fragment under edit. Its lead-facing `task/complete`
    instruction is explicitly protected by `bare-completion-contract.test.js` ("the lead's
    task/complete instruction keeps its fields"). That assertion pins `from`/`planId` in the *fragment
    text*; once the lead moves to a CLI verb the assertion must be updated in the same diff, not
    deleted — it becomes "the lead still names the subtask it accepts."
  - `teamWiring.ts:652` carries a second lead completion instruction using a substituted `{head}`
    token. It must move with the fragment or the two lead instructions disagree, which is the state
    this plan exists to end.
  - `_dispatchRoundCore` (`LocalApiServer.ts:5453`) is already called from round-complete (`:5000`)
    and register (`:5281`). The accept path becomes its third caller. Do not fork it.

## Dependencies

- **Coding Rounds 01–05** — all in CODE REVIEWED. This plan assumes the round record, registration,
  system dispatch and the rounds lead variant are present, and supersedes 04's lead-facing contract.
- **A Seat Reports Done and Nothing Else** — establishes the identity-resolution pattern (`cmdDone`,
  `cli.ts:2012-2040`) that `cmdAccept` mirrors.

## Adversarial Synthesis

Key risks: (1) building a second round-advance path beside `_handleKanbanRoundComplete`'s, producing
two ways a round closes and two ways a team is released — mitigated by routing the accept path through
`_dispatchRoundCore` and the existing feature-complete delegation, and by treating a divergence here as
a defect rather than a shortcut. (2) The existing `_handleKanbanTaskComplete` fire-and-forget
`onTeamReleased` at `:4710` is a SECOND release path in the SAME handler the accept path extends —
mitigated by gating that fire-and-forget on `!roundAdvanced` so the accept path's delegation is the
sole release on the feature-complete branch. (3) The existing `closeCodingRound` is unconditional and
returns `changes > 0` for an already-closed row, so it CANNOT guard against double-dispatch on
concurrent last-subtask accepts — mitigated by a new `closeCodingRoundIfOpen` (conditional on
`state IN ('dispatched','partial')`) whose `changes === 0` return is the loser's signal to stop. (4)
Counting accepts instead of reading card state, which miscounts on re-accept — mitigated by deriving
round completion from the round's subtask cards' `completedAt`. (5) Breaking the stateless (no
registered rounds) path, which is most of the install base's existing teams — mitigated by an explicit
"no rounds → today's behaviour exactly" branch and a test that pins it. (6) Deleting the
`round/complete` endpoint along with the instruction; the plan says in two places that the endpoint
stays. (7) The `bare-completion-contract.test.js` assertion at `:211` matching the stateless variant's
retained string and so guarding nothing about the rounds variant — mitigated by splitting it into two
scoped assertions.

## Proposed Changes

### 1. `src/standalone/cli.ts` — a `accept` verb with the lead's one field

- **Context:** there is no CLI verb for `task/complete`; the lead POSTs raw JSON. `cmdDone`
  (`:1984`) already solves the identity half.
- **Logic:** `switchboard accept --plan <subtaskPlanId>`. Resolve `from` from
  `process.env.SWITCHBOARD_TERMINAL`, `workspaceRoot` from the CLI's own root, and require `--plan`.
  Keep `--from` accepted and winning, for the human-CLI path. Absent env and absent `--from` fails
  loudly naming the variable; tag `fromSource` on every response path.
- **Body:** `{ from, planId, workspaceRoot }` to `POST /kanban/task/complete` — the existing endpoint,
  unchanged in shape.
- **Edge cases:** `--plan` missing is a distinct, named error from the identity error. A lead must be
  able to tell "you are not in a seat" from "you did not say which subtask."

### 2. `POST /kanban/task/complete` — the accept advances the round

- **Context:** `_handleKanbanTaskComplete` (`LocalApiServer.ts:4623`) completes the card and clears the
  seat. It knows nothing about rounds. It also fires `onTeamReleased` in a fire-and-forget at
  `:4710` after every successful completion — that fire-and-forget is the second release path the
  accept path must suppress when it takes over release.
- **Logic:** after the existing completion succeeds, look up the accepting lead's team rounds
  (`getCodingRoundsByTeam`, as `_handleKanbanRoundComplete` does at `:4838`). If the team has none,
  return exactly as today (the existing `:4710` fire-and-forget runs unchanged — no round took over
  release). If it has an open round containing this subtask, and every other subtask in that round is
  now complete (read from the cards' `completedAt`, the same field `round/complete`'s `outstanding`
  filter at `:4821` uses — NOT from `subtask_seats.delivered`, which records dispatch not acceptance),
  close the round row with the **new `closeCodingRoundIfOpen`** method (conditional on
  `state IN ('dispatched','partial')`). If the conditional close returns `changes === 0`, a concurrent
  accept already closed the round — return `roundAlreadyClosed: <ordinal>` and dispatch nothing. If
  the close won, call `_dispatchRoundCore` for the next registered round — or, when the closed round
  was the last, take the **existing** feature-complete delegation (`:5842`), skipping the caller's own
  release check. **On either round-advance branch, suppress the existing `:4710` fire-and-forget** —
  gate it on `!roundAdvanced`, so the accept path's delegation is the sole release on the
  feature-complete path, and the team is not released while a next round is in flight on the
  round-close path.
- **Response:** extend with what happened — `roundClosed` (ordinal or null, set only when THIS
  caller closed the round), `roundAlreadyClosed` (ordinal or null, set when a concurrent accept
  already closed it — distinct from `roundClosed: null` which means this subtask was not the last),
  `nextRound` (ordinal or null), `featureComplete` (boolean). A response that says `success: true` and
  nothing else is how the 2026-09-04 failure hid for an entire feature run; a response where
  `roundClosed: null` is indistinguishable from "lost the race" is the same failure mode one layer
  up.
- **Edge cases:** accepting a subtask that is already complete returns the round state without
  advancing. A subtask that belongs to no registered round completes and stops (the `:4710`
  fire-and-forget runs as today).

### 3. `src/services/standingOrderFragments.ts` — the lead is told one verb

- **Logic:** in the **rounds-registered** lead variant, `:113` becomes
  `run node "<cliPath>" accept --plan "<that SUBTASK's planId>"`, and the ROUND BOUNDARY (`:121`) and
  FEATURE COMPLETE (`:125`) paragraphs are removed — replaced by one sentence stating that the system
  closes the round and dispatches the next when the last subtask in a round is accepted, and completes
  the feature when the last round closes.
- **Keep for the stateless variant:** a lead whose team registered no rounds still needs
  `round/complete` and `feature/complete`. The removal is conditional on registered rounds, exactly as
  Coding Rounds 05 made the hand-dispatch removal conditional.
- **Edge cases:** the `<cliPath>` token substitution is unchanged, and an unsubstituted token still
  hands the lead a command that cannot run — the existing emission-seam test covers it.

### 4. `src/services/teamWiring.ts` — the second lead instruction moves with the first

- **Logic:** `:652`'s `POST /kanban/task/complete with {"from":"{head}","planId":…,"workspaceRoot":…}`
  becomes the `accept --plan` verb. The `{head}` substitution is no longer needed — the CLI resolves it.

## Verification Plan

### Automated Tests

1. **New** `src/test/lead-accept-advances-contract.test.js`, wired as `test:contract:lead-accept`
   **and invoked from `.github/workflows/integration-tests.yml`** — defined-but-not-invoked is not a
   gate. Asserts:
   - accepting the last outstanding subtask of a round closes that round and dispatches the next;
   - accepting a non-last subtask closes nothing and dispatches nothing;
   - accepting the last subtask of the **last** round completes the feature and releases the team
     **once** — assert `onTeamReleased` fired exactly once, not merely that the team ended released;
   - two concurrent accepts of the last two subtasks close the round once and dispatch the next once;
   - a lead whose team has no registered rounds gets today's behaviour exactly;
   - re-accepting an already-accepted subtask advances nothing.
2. **New** CLI checks in the same suite, mirroring `bare-completion-contract.test.js`: `accept --plan`
   with `SWITCHBOARD_TERMINAL` set resolves the lead; unset fails naming the variable and accepts
   nothing; `--plan` missing fails with a *different* message than the identity failure; explicit
   `--from` overrides the env.
3. **Update** `src/test/bare-completion-contract.test.js` — the assertion "the lead's task/complete
   instruction keeps its fields" (`:211`) pins `from`/`planId` in the fragment text via
   `assert.ok(/task\/complete with \{"from"/.test(frag))`. The **stateless** variant KEEPS that exact
   string (this plan keeps `round/complete`+`feature/complete` for stateless teams), so the assertion
   stays green regardless of the rounds variant — it guards nothing about the rounds variant. Split
   it into two scoped assertions: (a) the **rounds-registered** variant's completion instruction names
   `accept --plan` and does NOT name `round/complete` or `feature/complete`; (b) the **stateless**
   variant still names `task/complete with {"from"`. Update, do not delete — it is what stops the
   fields creeping back.
4. Assert **no lead-facing string** in the rounds-registered variant names `round/complete` or
   `feature/complete`, and that the **stateless** variant still does. Scope it to the rounds variant,
   or the assertion either falsely flags the stateless path or is carved out so wide it protects
   nothing.
5. Assert the **conditional close** is the idempotence guard: two concurrent accepts of the last two
   subtasks close the round exactly once (one caller's `closeCodingRoundIfOpen` returns
   `changes > 0`, the other returns `changes === 0` and gets `roundAlreadyClosed`), and `_dispatchRoundCore`
   fires exactly once. This is the test that catches the unconditional-`closeCodingRound` regression.

### Goal Invariants

- A lead with registered rounds accepts subtasks and posts nothing else; no lead-facing instruction in
  that variant names `round/complete` or `feature/complete`.
- The last accept in a round closes exactly that round and dispatches exactly the next one, once —
  guarded by `closeCodingRoundIfOpen` (conditional on `state IN ('dispatched','partial')`), NOT by the
  unconditional `closeCodingRound`.
- The last accept in the last round completes the feature and releases the team exactly once, through
  the existing feature-complete delegation — not a second release path. The existing
  `_handleKanbanTaskComplete` `onTeamReleased` fire-and-forget at `:4710` is suppressed on this branch.
- A lead whose team registered no rounds sees no behaviour change.
- A lead whose `SWITCHBOARD_TERMINAL` is unset accepts nothing, fails loudly naming the variable, and
  falls back to no placeholder identity.
- `POST /kanban/round/complete` and `POST /kanban/feature/complete` still exist and still work.

---

**Recommendation:** Complexity 5 (Mixed) — Send to Coder.

---

## Completion Summary

Implemented the lead's single-verb contract: `switchboard accept --plan <subtaskPlanId>` posts to `/kanban/task/complete`, and the system closes the round when the last subtask in it is accepted, dispatches the next round, and completes the feature when the last round closes. Added `cmdAccept` to `src/standalone/cli.ts` mirroring `cmdDone`'s identity resolution (SWITCHBOARD_TERMINAL, loud failure, distinct missing-`--plan` error). Added `closeCodingRoundIfOpen` (conditional on `state IN ('dispatched','partial')`) to `KanbanDatabase.ts` as the compare-and-swap idempotence guard. Extended `_handleKanbanTaskComplete` to derive round completion from the cards' `completedAt`, close conditionally, dispatch the next round via the existing `_dispatchRoundCore`, delegate to the existing `_completeFeatureCore` on the last round, and suppress the existing `onTeamReleased` fire-and-forget on the round-advance branch so the team is released exactly once. Branched `buildHeadCompletionFragment` on `hasRegisteredRounds` (rounds variant names `accept --plan` and drops `round/complete`/`feature/complete`; stateless variant unchanged). Moved the second lead instruction in `teamWiring.ts` + `kanban.html` (byte-identical) to `accept --plan`. Created `lead-accept-advances-contract.test.js` (wired as `test:contract:lead-accept` and in `integration-tests.yml`) and updated `bare-completion-contract.test.js` plus the downstream `coding-head-prompt`, `stage-marker-commit`, `completion-asserted-never-inferred`, and `standing-orders-marker` contract tests to the new contract.
