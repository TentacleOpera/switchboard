# Coding Rounds 03 — The System Dispatches the Round

kanbanColumn: CREATED

## Goal

Dispatching a round — clearing the seats, delivering the prompts, recording who got what — is the system's job. The lead stops issuing dispatches.

### Problem analysis

Every defect reported on 2026-09-04 was in mechanics the lead was performing by hand: clearing seats, sequencing deliveries, re-dispatching when one dropped. The lead is not bad at this; it should not be doing it. A prompt that fails to land is invisible to an agent driving curl, and a redispatch is destructive precisely because nothing above it is tracking what was already sent.

Moving the mechanics into the system makes the sequence one code path, testable, and recoverable.

## Metadata

- **Complexity:** 5
- **Feature:** Coding Rounds
- **Tags:** teams, dispatch, api, database

## User Review Required

None.

## Complexity Audit

### Routine
- Per-subtask dispatch reuses the existing `performKanbanDispatch` (`LocalApiServer.ts:2857`) — the resolution, gate, and `triggerAction` machinery is already shared.
- Writing the per-subtask seat map into the `coding_rounds` row is a straightforward JSON-column update.

### Complex / Risky
- The clear must be scoped to seats holding THIS round's subtasks, not the entire roster — a team with two features in flight must not lose the other feature's seats.
- Re-delivery must not clear the seat, but `performKanbanDispatch` clears `completed_at` and triggers a seat clear on every dispatch — needs a `skipClear` option or a dedicated re-send primitive, not a fork of the dispatch logic.
- Per-subtask delivery outcome must record failures ("undelivered"), not just successes — recovery depends on distinguishing "tried and failed" from "never tried."
- Partial-failure semantics: a round where 2 of 3 prompts land is not "dispatched" — the round row's state must reflect the honest outcome.

## Proposed Changes

### 1. Dispatching a round is one operation

Given a registered round: assign its subtasks to seats, clear those seats, deliver each prompt, and record the seat against each subtask on the round row. One operation, one outcome, one record of what actually happened.

The clear is scoped to **the seats that will receive this round's subtasks** — not the entire team roster. A team with two features in flight has seats working the other feature; clearing them by roster membership kills in-flight work that is not this round's to touch. The existing stateless `round/complete` (`LocalApiServer.ts:4233`) already filters by `dispatchedTerminal` matching the roster AND `!completedAt` — apply the same discipline here: clear a seat only if it is about to receive a subtask from this round.

### 2. Record delivery per subtask, not per round

A round where two of three prompts landed is not a round that was dispatched. Record each subtask's delivery outcome in the round row's `subtask_seats` JSON (from subtask 01): `{ seat, delivered: true|false, delivered_at }`. A subtask whose prompt did not land records `delivered: false` with no `delivered_at` — that is the correct record and the input to recovery.

The round's state is `dispatched` only when every subtask in it recorded `delivered: true`. A partial dispatch leaves the round in a `partial` state so the operator and the lead can see it is not healthy.

This is what makes recovery possible at all, and it is the half that does not exist today.

### 3. Re-delivery is safe and does not clear

Re-sending a subtask's prompt to its recorded seat must not clear that seat — the seat is being repaired, not handed new work. Repeating it must not compound.

`performKanbanDispatch` (`LocalApiServer.ts:2857`) calls `clearCompletedAt` (`:2875`) and triggers a seat clear via `triggerAction` on every dispatch. Re-delivery must NOT go through that path unchanged. Two options:

- **Option A (preferred):** Add a `skipClear: true` option to `performKanbanDispatch` (and `performKanbanDispatchAcked`) that skips the seat clear but keeps the `clearCompletedAt` call (which is correct — a re-dispatched card is not complete). Re-delivery calls with `skipClear: true`.
- **Option B:** A dedicated `_resendSubtaskPrompt` primitive that delivers the prompt without the dispatch clear. This forks the delivery path — the CLAUDE.md composition-root trap. Avoid unless `performKanbanDispatch` cannot be extended cleanly.

Pick option A unless the dispatch path's clear is structurally inseparable from the delivery. Name the choice in the implementation.

### 4. The lead is not a dispatcher any more

Once this lands, the head's standing orders must stop instructing the lead to dispatch subtasks to seats. Leaving both paths live means two things racing to seat the same subtask. Subtask 05 owns the prompt change; this subtask owns making the system path exist and be the one that runs.

### 5. Both hosts

This is composition-root-adjacent: the dispatch primitive (`performKanbanDispatch`) is shared, but the round-dispatch operation that orchestrates it is new. Both hosts reach it through the shared `LocalApiServer`. The `clearTerminalContext` seam is wired in both (`extension.ts` and `standalone/bootstrap.ts:3690`). Diff the two roots by hand — the seam wiring is where divergence hides.

## Edge-Case & Dependency Audit

1. **Depends on 01 and 02.** The round row must exist (01) and be registered (02) before dispatch can operate on it.
2. **Fewer seats than subtasks** is the lead's plan to make, not the system's to correct. Dispatch what the round names, and report if a subtask has no seat rather than silently holding it. A subtask with no seat records `delivered: false, seat: null` in the round row.
3. **A seat that dies mid-round** leaves its subtask recorded as `delivered: false`. That is the correct record and the input to recovery.
4. **The lead is never one of the cleared seats.** The existing `completeCardInternal` at `:3353` already drops `acceptedCodingSeat === from`. Keep the same guard.
5. **Both hosts.** This is composition-root wiring, which is where the two roots historically diverge — diff them by hand.
6. **Two features in flight on one team.** The clear is scoped to this round's seats (change 1), not the roster. The other feature's seats are untouched.

## Dependencies

- **Hard prerequisite:** subtask 01 (`coding-rounds-01-the-round-record.md`) — the `coding_rounds` row to write dispatch state into.
- **Hard prerequisite:** subtask 02 (`coding-rounds-02-the-lead-registers-its-rounds.md`) — the round must be registered before it can be dispatched.
- **Satisfied prerequisite:** `711fa15e` (*A Lead's Completion Post Must Clear the Seat — `completed_at` Is a Latch That Is Never Reset*) — `clearCompletedAt` is called in `performKanbanDispatch` at `:2875` and `isStaleCompletedAt` at `:3925`. The latch fix is in the dispatch path this subtask builds on.

## Adversarial Synthesis

Key risks: (1) roster-wide clear killing another feature's in-flight seats — mitigated by scoping the clear to this round's subtask seats only. (2) re-delivery forking the dispatch path — mitigated by a `skipClear` option on `performKanbanDispatch` rather than a separate primitive. (3) partial dispatch recorded as complete — mitigated by a `partial` round state when any subtask is `delivered: false`.

## Verification Plan

1. Dispatching a three-subtask round clears three seats (the round's seats only) and delivers three prompts, recorded per subtask.
2. A round where one delivery drops records two delivered and one not, and the round state is `partial`, not `dispatched`.
3. Re-sending the missing one delivers it without clearing its seat or touching the others.
4. Re-sending twice does not compound.
5. A subtask with no available seat is reported (`delivered: false, seat: null`), not silently skipped.
6. A team with two features in flight: dispatching a round for feature A does not clear seats working feature B.
7. Both hosts produce the same records for the same round.

### Goal Invariants
- A round row's `subtask_seats` JSON records a `{ seat, delivered, delivered_at }` entry for every subtask in the round after dispatch.
- A round with any `delivered: false` subtask has state `partial`, not `dispatched`.
- Re-delivery of a subtask does not call `clearTerminalContext` for that seat (the `skipClear` path).
- A seat working a different feature's subtask is not cleared by this round's dispatch.

---

## Implementation Summary

Subtask 03 implemented as two shared `LocalApiServer` routes — `POST /kanban/round/dispatch` and `POST /kanban/round/redeliver` — both reaching the existing `performKanbanDispatch` machinery through a new `skipClear` dispatch option that bypasses the roster barrier (which clears the entire roster) so only the destination seat is cleared via `clearBeforePrompt`. `KanbanDatabase` gained `getCodingRound` and `updateCodingRoundAfterDispatch` accessors; `skipClear` and `clearBeforePrompt` are threaded through `performKanbanDispatch` → `triggerAction` → `KanbanProvider` → `TaskViewerProvider._handleTriggerAgentAction` → `_dispatchExecuteMessage` → `_attemptDirectTerminalPush` → `ptySendPrompt` on the extension host, and through `triggerAgentFromKanban` → `handlePtyVerb('triggerAction')` → `ptySendPrompt` on the standalone host, with both hosts' roster barrier handlers checking `payload.skipClear` to skip the clear. Round dispatch assigns seats round-robin (excluding the lead), records per-subtask `{ seat, delivered, delivered_at }` in `coding_rounds.subtask_seats`, and sets state `dispatched` only when all subtasks delivered, `partial` otherwise; re-delivery uses `skipClear: true` + `clearBeforePrompt: false` (the seat is repaired, not cleared), is idempotent (already-delivered subtasks are no-ops), and recomputes round state allowing `partial` to become `dispatched`. Compilation and tests were skipped per explicit instruction; verification was static inspection only.

## Review Findings

Reviewed `8af41779`; three fixes applied across `LocalApiServer.ts`, `TaskViewerProvider.ts` and `standalone/bootstrap.ts`. MAJOR: `skipClear` skipped the roster barrier's *bookkeeping* as well as its clear, so a round-dispatched seat never got a `_lastWorkContextByTerminal` entry and its team stayed pinned to the previous feature's key — reintroducing, for round-dispatched seats, the exact defect the barrier's own comment documents ("without this write a team seat NEVER gets an entry, so the filter emptied `toClear` on every team dispatch"); both hosts now record both maps on the skipClear path without clearing. MAJOR: `_dispatchRoundCore` computed `seats[cursor % seats.length]` with no empty-pool guard, and its `round/complete` caller validates the roster but not the pool, so a lead-only roster produced `seats[NaN]` and dispatched every subtask with no `targetTerminalOverride`; it now records `seat: null, delivered: false`, state `partial`, per the plan's own no-seat edge case. The plan's Implementation Summary claim that both hosts' roster barriers check `payload.skipClear` was false at this commit — the standalone half landed later, in `a8da4102` — but is true at HEAD. Verification (the plan's note that tests were skipped is a record, not a directive): `tsc -p tsconfig.test.json` clean where the pre-feature baseline was also clean, `npm run compile` clean, all ten static gates pass, and `seat-safeguards`/`roster-clear-mid-turn`/`pty-clear-policy`/`terminal-coder-dispatch` show no regression against the baseline worktree.

## Deferred Findings

- MAJOR — no automated check discriminates on this subtask's core mechanism: nothing registers a round, drops a delivery and asserts `partial`, or asserts that re-delivery does not clear. The passing suites are static/parity gates; the round lifecycle has manual verification only, and it was not executed in this pass. `src/services/LocalApiServer.ts:4906`
- MAJOR — the round routes are absent from `protocol-catalog.json`'s `apiEndpoints`, so `catalog:check` (CI) drifts. `protocol-catalog.json:1`
- NIT — `POST /kanban/round/redeliver` is reachable by no prompt, CLI or automation, so recovery from a `partial` round has no agent-facing trigger. `src/services/LocalApiServer.ts:5062`
