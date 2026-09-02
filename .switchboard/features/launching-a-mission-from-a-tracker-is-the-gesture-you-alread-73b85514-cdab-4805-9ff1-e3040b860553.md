# Launching a Mission From a Tracker Is the Gesture You Already Know

**Complexity:** 6

## Goal

Make launching a mission from a tracker identical to dispatching a feature - move one card, the group goes - and keep the acknowledgement the operator sees truthful once STAGING stops draining itself.

These two are one gesture and its receipt. The launch plan supplies the trigger; the ack plan is the only thing an operator away from the desk sees after moving a card, and it currently promises an automatic pickup that mission dispatch does not provide.

## How the Subtasks Achieve This

- **Launching a mission from a tracker should be the gesture that already exists, not a second one to learn**: Wires `RemoteControlService` to call the already-built `launchMission` when a member card of an unlaunched mission is moved to a coding column remotely. The fan-out is implemented; the gap is the remote trigger. Solves the "move one card, the group goes" half by making the tracker gesture reach the launch engine.
- **The staging ack tells the operator a coding lead will pick the card up, which mission dispatch will make false**: Extends `onStageForQueue` to return mission `runState` and gating info, then branches the ack text across three cases (in-flight/ungated = today's wording, not-started = "launch required", gated = name the blocker). Solves the receipt half by making the ack truthful about whether the card will actually run.

## Dependencies & sequencing

- **The staging ack (subtask 2) must land with or before the launch trigger (subtask 1).** The launch trigger makes the ack's "not launched" case reachable — without the ack fix, a card staged into an unlaunched mission would still say "a coding lead will pick it up in order," which is the exact lie the ack plan exists to prevent. Landing the trigger first would regress truthfulness.
- **Both subtasks extend `RemoteControlDeps`** (`RemoteControlService.ts:127`) — subtask 1 adds an `onLaunchMission` callback, subtask 2 extends the `onStageForQueue` return type. These are different members of the same interface and do not conflict, but a coder landing both should coordinate the single interface edit.
- **Both subtasks update `switchboard-remote/SKILL.md`** dispatch instructions — subtask 1 adds launch-from-tracker gesture docs, subtask 2 adds conditional dispatch language. Coordinate the skill edits.
- **Prerequisite:** the mission fan-out (`launchMission`, `KanbanProvider.ts:14943`) and the milestone sync (`syncMissionsAndDependencies`, `LinearSyncService.ts:3724`) are already implemented. Neither subtask rebuilds them.
- **External prerequisite:** the queue-notification bridge, if it lands, is reused by both subtasks for launch events. Neither blocks on it; both fall back to the existing comment path.

## Team Dispatch Instructions

### Launching a mission from a tracker should be the gesture that already exists, not a second one to learn

- **Seat:** Coder (complexity 6 — multi-file coordination, trigger ambiguity, remote service extension)
- **Acceptance:**
  - Moving a member card of a `not-started` mission to a coding column remotely calls `launchMission` and posts a launch ack
  - Moving a card NOT in a mission, or in an `in-flight` mission, produces byte-identical staging/dispatch behaviour to today
  - Double-launch from poll retry is refused with a truthful "already in flight" ack (no second team seated)
  - No new `columnToStateId` mapping is required — the launch uses only columns already mapped
  - `RemoteControlService.ts` gains at least one call path to `launchMission` or an `onLaunchMission` dep callback
- **Must not touch:** `launchMission` implementation (`KanbanProvider.ts:14943`), the `runState` derivation model (`_deriveMissionRunState`, `KanbanDatabase.ts:11420`), the milestone sync (`syncMissionsAndDependencies`, `LinearSyncService.ts:3724`), or the `switchboard-remote/SKILL.md` section 10 (already updated by the companion plan)

### The staging ack tells the operator a coding lead will pick the card up, which mission dispatch will make false

- **Seat:** Intern (complexity 3 — interface extension + text branching, well-scoped)
- **Acceptance:**
  - `onStageForQueue` returns `missionRunState` and `gatedBy` in its result object
  - A card staged into a `not-started` mission receives an ack that says a launch is required (no "pick it up" promise)
  - A card staged into an `in-flight` mission with no gating receives byte-identical ack to today's (position included)
  - A gated card's ack names the blocker, not a position
  - No second comment is posted from `RemoteControlService` on mission launch
- **Must not touch:** `stageForQueue` implementation (`KanbanProvider.ts:8663`), `launchMission` (`:14943`), the queue drain logic, or any schema/migration

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Launching a mission from a tracker should be the gesture that already exists, not a second one to learn](../plans/launching-a-mission-should-be-the-gesture-that-already-exists.md) — **CREATED** — ID: abe30e74-a262-4b89-b726-a1d7a730a541
- [ ] [The staging ack tells the operator a coding lead will pick the card up, which mission dispatch will make false](../plans/the-staging-ack-promises-a-pickup-that-missions-will-not-do.md) — **CREATED** — ID: 1b9acd59-a047-4187-a91b-3961ad3b2a23
<!-- END SUBTASKS -->

