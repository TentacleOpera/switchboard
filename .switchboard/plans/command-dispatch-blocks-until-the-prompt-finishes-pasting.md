# Dispatch from the command surface holds "Dispatching…" for ~20s because the HTTP response waits for the prompt to finish pasting

## Goal

Return the dispatch result as soon as the card has moved and a seat has been chosen, and report prompt delivery as a second, later signal. The operator should see the outcome in well under a second on a phone, not after the entire prompt has been typed into a terminal one 256-byte chunk at a time.

### Problem Analysis

Pressing DISPATCH on `/command` leaves the chip reading `Dispatching agent...` for around twenty seconds. Nothing is wrong with the client. `executeDispatch` (`src/webview/command.js:1126-1162`) sets the pending chip, then awaits a single `POST /kanban/dispatch` and only writes the outcome when that promise resolves. It is correctly reporting how long the request took.

The request is slow because the route is synchronous over the whole dispatch:

- `_handleKanbanDispatch` (`LocalApiServer.ts:1862`) awaits `performKanbanDispatch` before writing any bytes.
- `performKanbanDispatch` resolves the plan, resolves the column, pre-flights the gates, then at `:2003` calls `await kanbanVerb('triggerAction', …)` — *"the exact arm a webview drag fires"*.
- That arm persists the move **and delivers the prompt into the terminal**.
- Only then, at `:2010`, does it re-read the plan and compare `dispatchedAt` against the pre-move value to decide `success`.

Prompt delivery is deliberately paced. `_sendRobustTextBackground` (`terminalUtils.ts:292-334`) opens bracketed paste, then streams the payload in `CHUNK_SIZE = 256` character chunks with `CHUNK_DELAY_MS = 30` between them, closes the paste block, waits `SUBMIT_DELAY_MS = 100`, and sends a bare Enter. A 40 KB dispatch prompt is ~156 chunks ≈ 4.7 s of pure pacing. Sends are additionally serialised **per terminal** through `_backgroundSendQueues`, so a predecessor still pasting into the same seat is added to the wait, and terminal spawn precedes all of it.

### Root Cause

**The endpoint conflates two facts that settle at very different speeds:** *the card was dispatched* (a DB write, milliseconds) and *the agent has been handed its prompt* (a paced paste into a PTY, seconds to tens of seconds). Because `success` is defined as `moved && dispatchObserved`, the response cannot be sent until the slow fact is true.

The pacing itself is correct and must not be reduced — it exists because unpaced writes saturate PTY stdin and agent CLIs drop or mangle the paste. The defect is that a UI is blocked on it.

### Non-goals

- **Do not change `CHUNK_SIZE`, `CHUNK_DELAY_MS`, or `SUBMIT_DELAY_MS`.** They are the reason prompts arrive intact. This plan makes the wait invisible, not shorter.
- **Do not make dispatch fire-and-forget.** The verification at `:2010-2015` is what stops the surface reporting success for a dispatch that silently did nothing; it moves, it does not disappear.
- No change to the drag-drop path on the desktop board, which is not blocked on a network round trip and shows its own terminal.

## Metadata

**Topic:** Command surface dispatch acknowledges before prompt delivery completes
**Complexity:** 5
**Tags:** api, webview, mobile, command-surface, performance

## User Review Required

None. The two-phase contract is specified below, including which phase owns the existing `success` semantics.

## Complexity Audit

### Routine
- Adding the poll endpoint's route registration and body parsing.
- The client-side chip transitions.

### Complex / Risky
- **`performKanbanDispatch` has many in-process callers.** The docblock at `:2046` names them: the schedule timer, the `Run queue` button, the handoff, `queue/done`, and `_runQueuePop` — all calling in-process precisely so the module-level promise chain stays the single serialisation point. Changing its signature or its await semantics reaches every one of them. The split must be additive: the existing method keeps its current blocking contract and a new entry point wraps it.
- **Defining "acknowledged".** The ack must be emitted after the move has persisted and the target seat is resolved, but before prompt delivery. Emitting it earlier — before gate pre-flight — would ack dispatches that are about to fail with 400/409, which is worse than the current slowness.
- **Failure after ack.** Prompt delivery can fail (terminal closed mid-chunk; `_sendRobustTextBackground`'s work promise rejects). That failure currently surfaces as a 502 in the response body. After the split it must surface on the poll, and the client must be able to reach a terminal failed state rather than polling forever.

## Edge-Case & Dependency Audit

**Race conditions:**
- The client may poll before the server has recorded any delivery state. The poll must distinguish *pending* from *unknown plan*, or a fast first poll reads as a failure.
- Two dispatches to the same seat queue behind each other in `_backgroundSendQueues`. The second's delivery phase legitimately takes as long as both prompts. The poll must be keyed by planId, not by seat, or the two are indistinguishable.
- A page reload during delivery loses the client's in-memory poll. The poll endpoint must be answerable from persisted state (`dispatched_at`, `dispatched_terminal`) rather than an in-memory map, so a reconnecting phone can resume.

**Security:** The poll endpoint reads dispatch state for a planId and must go through `_checkAuth` exactly as `_handleKanbanDispatch` does at `:1863`. It is a read, but it is a read of which agent is working what.

**Side effects:** None to the DB schema — `dispatched_at` and `dispatched_terminal` already carry everything the poll needs.

**Dependencies & conflicts:** None with the other plans in this feature; this one is confined to `executeDispatch` and the API. It does not touch `renderDispatchView`, which the project-scoping plan edits.

## Dependencies

None.

## Adversarial Synthesis

Key risks: (1) changing `performKanbanDispatch` in place and breaking the five in-process callers that depend on its blocking contract — mitigation: add a new wrapper, leave the existing method's semantics untouched, and assert the callers still compile against the old signature; (2) acking before the gate pre-flight, converting loud 400/409 refusals into a success chip followed by a silent nothing — mitigation: ack strictly after gate resolution and after the move persists; (3) an unreachable terminal state on the poll, leaving the phone spinning forever — mitigation: a delivery deadline after which the poll reports `unknown` with the same wording the current 502 uses; (4) reducing the paste pacing to "fix" the latency, which corrupts prompts — explicitly forbidden above.

## Proposed Changes

**1. Split the dispatch into ack and confirm (`LocalApiServer.ts`).**

Add `performKanbanDispatchAcked(...)` wrapping the existing method. It performs steps 1-3b of `performKanbanDispatch` (resolve plan, resolve column, gate pre-flight, team-scoped target) and returns as soon as the `triggerAction` move has persisted, with `{ phase: 'dispatching', planId, column, role, seat }`. Prompt delivery and the step-5 verification continue on the returned promise, which is retained so its rejection is recorded rather than unhandled.

**Implementation note:** `performKanbanDispatch` is a single monolithic async function. To "perform steps 1-3b" without duplicating logic, extract the pre-delivery steps (resolve plan → resolve column → gate pre-flight → team-scoped target → persist move) into a shared sub-function that both `performKanbanDispatch` and `performKanbanDispatchAcked` call. The existing method then continues from the shared sub-function's result into prompt delivery and verification, preserving its blocking contract verbatim. Do NOT duplicate the pre-delivery logic — a fork creates a maintenance trap where a fix to one path misses the other.

`performKanbanDispatch` keeps its present blocking behaviour verbatim for the five in-process callers.

**2. `POST /kanban/dispatch` gains an opt-in (`LocalApiServer.ts:8292`).**

A body field `ack: true` routes to the acked variant. Absent, the endpoint behaves exactly as today — this is the regression fence for any existing API caller, including the CLI's `dispatch` verb.

**3. `GET /kanban/dispatch/state?planId=…` (auth-gated).**

Answers from persisted state: `delivering` while `dispatched_at` is unchanged from the pre-move value and the deadline has not passed; `dispatched` once it advances, carrying `dispatchedAgent` and `dispatchedAt`; `unknown` past the deadline, reusing the existing 502 wording (*"Move persisted but no dispatch was recorded…"*) so the operator sees one vocabulary in both paths.

**Deadline semantics:** The 60s poll cap is a UI timeout, not a delivery verdict. A slow prompt (large plan file, queueing behind a predecessor, terminal spawn latency) may still be pasting when the poll reports `unknown`. The chip must read `unknown` as "delivery status uncertain" — not as "dispatch failed." The prompt is still being written; the operator just stops receiving updates. The wording must not imply the dispatch itself failed, only that its delivery could not be confirmed within the timeout.

**4. Two-stage chip (`command.js:executeDispatch`).**

Post with `ack: true`. On the ack, write `Dispatched — <seat> is receiving the prompt` as a *pending* chip and re-enable the view. Poll `/kanban/dispatch/state` on a 1 s interval, capped at 60 s, and settle the chip to success or unknown. Cancel the poll on view switch. The button stays disabled only until the ack, not until delivery.

## Verification Plan

1. Time a dispatch of a card with a large plan file from `/command` on a phone. The chip leaves `Dispatching…` in under one second and reports the receiving seat by name.
2. The chip subsequently settles to a delivered state, and the terminal shows the complete prompt — no truncation, no interleaving. This is the gate that the pacing was not touched.
3. Dispatch two cards to the same seat in quick succession. Both settle correctly and the second's elapsed time reflects queueing behind the first.
4. Dispatch to a column with no configured role. The 400 arrives immediately, with today's wording, and no success chip is shown.
5. With no terminals live, dispatch. The 409 arrives immediately with today's wording.
6. Reload the page mid-delivery. The reopened surface resolves the card's state from the poll rather than showing a stale pending chip.
7. Kill the target terminal mid-delivery. The poll reaches `unknown` at the deadline; the surface does not spin forever.
8. Regression: `npx switchboard dispatch <planId>` from the CLI, and a desktop drag-drop dispatch, both behave exactly as before — neither sends `ack`.
9. Both hosts: run 1, 2 and 8 against the VS Code extension and the standalone host. `triggerAction` reaches a `vscode.Terminal` on one and a PTY seat on the other; the pacing chokepoints differ and both must be exercised.

### Goal Invariants

- Assert `performKanbanDispatchAcked` exists as a named function in `LocalApiServer.ts` and is distinct from `performKanbanDispatch` (the original method's signature and blocking contract are unchanged).
- Assert `POST /kanban/dispatch` with body `{ ack: true }` returns an HTTP response in under 1 second on a dispatch with a large plan file (the ack is not blocked on prompt delivery).
- Assert `POST /kanban/dispatch` without `ack` in the body behaves identically to the pre-change endpoint (regression fence — the CLI `dispatch` verb and desktop drag-drop are unaffected).
- Assert `GET /kanban/dispatch/state?planId=…` returns one of three states: `delivering`, `dispatched`, or `unknown` — and that `unknown` is reached only after the 60s deadline, not on a fast first poll.
- Assert `executeDispatch` in `command.js` re-enables the dispatch button after the ack, not after delivery (the button is not blocked for the full paste duration).

## Implementation Summary

Split dispatch into ack + delivery-poll. Extracted `performKanbanDispatch`'s steps 1–3b (resolve plan → column → gate pre-flight → team-scoped target) into a shared private `_resolveKanbanDispatchPreDelivery` so both paths share one resolution (no fork). The existing `performKanbanDispatch` keeps its blocking contract verbatim — it calls the helper then awaits `triggerAction` + verifies, unchanged for the five in-process callers (schedule timer, Run queue, handoff, queue/done, _runQueuePop). Added `performKanbanDispatchAcked`, which runs the same gate pre-flight (so 400/409/404/503 still arrive immediately and loudly — the ack is never sent for a dispatch about to fail), records an in-flight entry, fires `triggerAction` WITHOUT awaiting the paced paste, and returns `{ phase: 'dispatching', planId, column, role, seat, dispatchedAtBefore, deadline }`. The delivery promise is retained with a `.catch` so a rejection (terminal closed mid-chunk) is logged and the poll times out to `unknown` rather than going unhandled. Pacing constants are untouched.

`POST /kanban/dispatch` routes on body `ack: true` → acked variant; absent → identical to before (regression fence for the CLI `dispatch` verb and desktop drag-drop, neither of which sends `ack`). Added auth-gated `GET /kanban/dispatch/state?planId=…&since=…&deadline=…&workspaceRoot=…` returning `delivering` (dispatchedAt unchanged from the client-supplied `since` baseline, deadline not passed), `dispatched` (dispatchedAt advanced; carries agent/at/seat), or `unknown` (deadline passed, reusing the synchronous 502 wording — a UI timeout, not a delivery verdict). The server reads persisted `dispatched_at` and is stateless when the client echoes `since`/`deadline` (survives server restart / page reload via the client storing them from the ack); an in-memory `_ackedDispatchState` map keyed by planId is the fallback for a bare probe and the source of the seat name mid-delivery, so two dispatches to the same seat (different planIds) stay distinguishable.

`command.js:executeDispatch` now posts with `ack: true`, writes a pending chip `Dispatched — <seat> is receiving the prompt`, re-enables the button immediately, and polls `/kanban/dispatch/state` at 1s (capped at the 60s deadline) settling to success or unknown. The poll is cancelled on view switch, card change, workspace switch, and a new dispatch so no stale poll settles the wrong row. The button is blocked only until the ack, not for the paste duration.

Deviation note: the plan's implementation note lists "persist move" inside the shared sub-function. Because `triggerAction` performs the move AND the paced delivery as one awaited arm and cannot be split without altering the shared drag-drop arm (a non-goal), the acked variant fires `triggerAction` un-awaited and returns the ack right after gate pre-flight. The move persists as the arm's first action (a DB write, milliseconds); the poll keys on `dispatchedAt` advancing (not column), so the sub-second window before the move lands reads as `delivering`, never as a false success or failure. The main adversarial concern (acking before gate pre-flight → silent 400/409) is fully handled: the ack is sent only after the gate resolves.
