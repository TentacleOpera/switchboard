# A supervised mission has no supervision: `type` is stored, shown and reported, but nothing wakes on a transition

## Goal

Give `type: 'operation'` its behaviour: wake the controller agent at a supervised mission's
**transition points** — `not-started → in-flight → completed` — so it can confirm the automation is
working. Today the distinction is fully modelled and entirely inert.

### Problem Analysis

**The distinction is spec'd, stored, and settable.** `missions.type` defaults to `'mission'`
(`KanbanDatabase.ts:638`); the panel offers a picker — *"mission (unsupervised)"* / *"operation
(supervised)"* (`mission-control.js:155-156`) — with a type badge (`:117`) and a worktree hint
(`:162`); and `GET /kanban/mission/active` returns `supervised: active.type === 'operation'` with a
comment stating the intent outright: *"Stated explicitly so a caller does not infer oversight from a
mission merely existing: only an 'operation' is supervised."* This is
`the-automation-model-four-things-not-a-mode-axis.md`'s two flavours, already in the schema.

**And its entire behavioural footprint is a worktree budget.** Two lines:

```js
const maxExtraWorktrees = Math.min(type === 'mission' ? 1 : 99, …);   // KanbanDatabase.ts:11473
if (type === 'mission' && maxExtraWorktrees > 1) maxExtraWorktrees = 1; // :11510
```

`launchMission` does not branch on `type`. Dispatch does not. Nothing arms oversight for an
`operation` or withholds it from a `mission`. `supervised` is reported on one endpoint and read by
nobody in this repository — a claim about what a caller should expect, which no code makes true. A
user who marks a mission supervised gets a badge and a larger worktree allowance, and no supervision.

**There is no transition edge to wake on.** `runState` is derived on read: `getMissions` calls
`m.runState = await this._deriveMissionRunState(members)` (`:11317`) per request. That design is
correct and deliberate — *"DERIVED from member state, never persisted"* (`:11306`) — but it means the
value changes silently. A mission moves `not-started → in-flight` because a member card was
dispatched, and nothing is notified; the next reader simply sees a different answer.

**The two pieces needed already exist.**

| piece | where | status |
| :--- | :--- | :--- |
| a per-card completion signal | `PlanIngestionEngine._turnEndNotifier` → `notifyTurnEnd` / `handleAutobanTurnEnd` | live |
| card → mission lookup | `KanbanDatabase.getMissionsForMember` (`:11567`) | live |
| mission-level transition edge | — | **missing** |

So this is an edge detector over an existing signal, not new plumbing.

### Root Cause

`runState` is a pull. Supervision is a push. Nothing converts one into the other, so the field that
selects supervision selects nothing.

### Non-goals

- **Not persisting `runState`.** It stays derived. Change 2 stores a *notification watermark* — the
  last state the controller was told about — which is a different thing from a status copy and must
  not be read as one.
- **Not an interval tick.** Supervision is wake-on-transition. A supervised mission with nothing
  happening produces no wakes at all.
- **Not changing what `mission` (unsupervised) does.** It runs exactly as today.

## Metadata

**Complexity:** 5
**Tags:** backend, reliability, feature
**Feature:** 73ebf150-50f9-4e8f-b9db-58af49202c6a

## User Review Required

**No.** The Outstanding Questions are settled (missions need no ticker; the controller is a seated terminal woken on transitions). No open `[user]` decision gates the implementation.

## Complexity Audit

### Routine
- Calling `getMissionsForMember` + `_deriveMissionRunState` on a turn-end — both exist.
- Adding the `last_notified_run_state` column and the `type === 'operation'` gate.
- Delivering through `ptySendPrompt` / reports directory (an existing channel, new message kind).

### Complex / Risky
- **Concurrent turn-ends on a multi-member mission.** Two members dispatched together complete near-simultaneously; both fire `notifyTurnEnd`; both recompute `runState`, both read the watermark as `not-started`, both see the edge, both wake. The watermark compare-and-set is not atomic, so verification 1's "exactly one wake" is false under concurrency unless the detector serializes. The common batch case (multi-member, simultaneous start) is exactly the case that races.
- **Watermark must never become a cached status.** Every reader keeps calling `_deriveMissionRunState`; the watermark exists only to fire-once. A future reader that consults it breaks the derived design silently. Mitigated by naming (`last_notified_run_state`, never `runState`) and verification 3, but enforcement is a durable-codebase negative.

## Edge-Case & Dependency Audit

- **Race Conditions:** Concurrent turn-ends for members of the same mission can double-wake on a single transition (see Complexity Audit). Mitigation: serialize the watermark compare-and-set per mission (a per-mission write lock, or re-check the watermark under a lock before emitting the wake), OR state and verify that turn-ends are single-threaded in both hosts. Verification 7 asserts a shared code path, not shared serialization — a shared path with a different concurrency model is a shared race.
- **Security:** None. No auth or credential surfaces.
- **Side Effects:** Every unsupervised mission currently pays no per-turn-end cost; this plan makes unsupervised missions run `getMissionsForMember` + derivation on every member turn-end to keep their watermark current for a flip that rarely happens. **Recommended refinement:** short-circuit the watermark update for unsupervised missions and seed the watermark from the current derived state on a flip to `operation` — same no-replay guarantee (verification 6), none of the per-card tax on the unsupervised majority.
- **Dependencies & Conflicts:** Informs the run-sheet subtask (wake-on-transition is what lets the run sheet delete the interval tick) — read together, either may land first. No shared file writes with the other subtasks (detector lives beside the turn-end notifier; watermark in `KanbanDatabase`).

## Dependencies

- **No hard upstream dependency.** May be implemented before or after the run-sheet subtask; the two inform each other and should be read together. Wake-on-transition is what allows the run sheet to delete the interval tick; the run sheet establishes that the controller is a seated terminal rather than the `/switchboard` conversation.
- **No file-write overlap** with the front-door, run-sheet, or ready-gate subtasks.

## Adversarial Synthesis

Key risks: concurrent turn-ends on a multi-member mission can double-wake on one transition because the watermark compare-and-set is not atomic (the common batch case is the racing case); the watermark could silently become a cached status if a future reader consults it. Mitigations: serialize the per-mission watermark compare-and-set (or verify single-threaded turn-ends in both hosts) and add a Goal Invariant asserting one wake per transition under concurrent member completion; name the watermark so it cannot be mistaken for `runState` and assert no reader consults it (verification 3).

## Proposed Changes

1. **Detect the edge where the per-card signal already lands.** On a turn-end for a card, call
   `getMissionsForMember(cardId)`, recompute each owning mission's `runState` via the existing
   derivation, and compare against the watermark. No polling loop: the trigger is the signal that
   already fires.

2. **Store a notification watermark, not a status.** Persist `last_notified_run_state` per mission —
   the last value the controller was told. It exists solely so a transition fires once; it is never a
   source of truth for the mission's state, and every reader keeps calling `_deriveMissionRunState`.
   Name it so it cannot be mistaken for a cached `runState`, and never expose it as one.

3. **Wake only for `type === 'operation'`.** An unsupervised mission computes its transition and
   updates its watermark without waking anyone — so flipping a mission to `operation` mid-flight
   starts supervising from the next transition rather than replaying past ones.

4. **Deliver through the channel that already carries turn-end notices.** `ptySendPrompt` where the
   host delivers, the reports directory where it does not. This adds a message *kind*, not a
   transport.

5. **Say what changed, and which mission.** The wake names the mission, the transition
   (`not-started → in-flight`), and the member card that caused it. The controller's job is to confirm
   the automation is working, which it cannot do from a bare "something happened".

6. **`completed` is a transition too.** The last member finishing is the most valuable wake — it is
   where a stalled or half-finished mission becomes visible — and it is the one an interval tick
   would most likely report late.

## Verification Plan

1. **A supervised mission wakes on each transition, once.** Launch an `operation` with two members.
   Assert exactly one wake on `not-started → in-flight`, and exactly one on `→ completed`. Re-running
   the detector without a state change produces none — the watermark test.
2. **An unsupervised mission never wakes.** The same scenario with `type: 'mission'` produces zero
   wakes, and its watermark still advances, so a later flip to `operation` does not replay history.
3. **`runState` is still derived everywhere.** Assert every read path calls `_deriveMissionRunState`
   and that no reader consults the watermark. A fix that quietly turns the watermark into a cached
   status has broken the design it was built inside.
4. **The wake names the cause.** Assert the payload carries mission id, both states, and the member
   card. A wake that cannot be acted on is noise.
5. **No wake without a transition.** Dispatch a second member of an already-in-flight mission and
   assert no wake — `in-flight → in-flight` is not an edge. This is the failure mode that would turn
   supervision into per-card spam.
6. **Flipping type mid-flight.** Change `mission` → `operation` while in-flight; assert no backfilled
   wakes and that the next real transition wakes normally.
7. **Both hosts.** The detector belongs beside the existing turn-end notifier so both hosts inherit
   it. Assert the standalone host reaches the same code path rather than assuming it — per `CLAUDE.md`,
   the seam each host *wires* is the audit, and the queue-seam precedent is that a wiring gap shows up
   as "never armed" rather than as an error.
8. **One wake per transition under concurrent completion.** Launch an `operation` with two members
   dispatched simultaneously and assert **exactly one** wake on `not-started → in-flight` even when
   both member turn-ends fire in the same window. This is the race verification 1 does not cover —
   without serialization the watermark compare-and-set double-fires on the common batch case.

### Goal Invariants

- **A supervised mission wakes exactly once per transition, including when multiple members complete
  concurrently** (positive — the edge detector fires once, not per-card; the concurrency case is the
  load-bearing one).
- **An unsupervised mission never wakes** (negative — `type === 'mission'` selects no supervision,
  regardless of transitions).
- **No reader consults `last_notified_run_state` as a source of truth** — every read path calls
  `_deriveMissionRunState` (negative — the watermark is not a cached `runState`; the derived design
  holds).
- **`last_notified_run_state` is absent from every read/return path that exposes mission state**
  (negative — it is never surfaced as a status field, only used internally to fire-once).

## Outstanding Questions

- **Settled: missions need no ticker.** An attended mission is supervised by a **seated controller
  terminal**, woken on transitions. The controller is not replaceable by a `/switchboard` session and
  does not poll — an earlier revision asked whether transitions plus a stall timeout could replace the
  interval tick; the answer is that the interval tick was never the mission's to own. The stall case
  (a mission that goes `in-flight` and then stops) belongs to whoever dispatched, not to the mission —
  see `replace-the-mission-control-persona-with-a-run-sheet.md`.
