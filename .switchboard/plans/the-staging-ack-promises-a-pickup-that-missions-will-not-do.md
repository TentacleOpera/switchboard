# The staging ack tells the operator a coding lead will pick the card up, which mission dispatch will make false

## Goal

Keep the remote staging acknowledgement truthful as STAGING moves from a self-draining queue to a
mission container that waits for a manual launch. The ack is the only thing an operator away from
the desk sees after moving a card, and it currently promises an automatic pickup that the mission
design does not provide.

### Problem Analysis

**The ack exists specifically to be truthful, and says so.** `RemoteControlService.ts:790-810`
handles a remote move into a queueable column. On success it posts back to the card:

> "Switchboard received this status change and staged it as position N in the session queue. **A
> coding lead will pick it up in order.**"

with a comment above it explaining the wording was chosen with care: "Truthful ack: a staged card is
NOT a dispatched card. The current wording ('dispatched the local agent') would be a lie the user
acts on. Name the position so the remote user can see the queue depth."

**That promise is true today — but only for the self-draining queue.** `QUEUEABLE_TARGET_COLUMNS`
(`:112`) includes `STAGING`; `onStageForQueue` (`KanbanProvider.ts:2682`) calls `stageForQueue`,
which appends a `queue_position` (V60, `KanbanDatabase.ts:572-573`) and adds the card to a mission
via `resolveOrCreateOpenMission` (`KanbanDatabase.ts:11648`). The queue is drained by
`launchMission` (`KanbanProvider.ts:14943`), which calls `apiServer.dispatchNextFromQueue` to pop
and dispatch members. A card staged from a phone sits in STAGING until someone launches the mission
— and if no one does, nothing happens.

**Mission launch is a manual act, not an automatic drain.** `launchMission` is fully implemented
(`:14943`) and is triggered by the `mcLaunchMission` webview verb (`:10219`) — a button in the
Mission Control panel. There is no remote path to it. So the sentence "a coding lead will pick it
up in order" is false the moment a card is staged into an unlaunched mission: the card will sit
until the operator returns to the desk and clicks Launch.

**The failure is silent and specifically remote.** At the desk, an un-launched mission is visible
on the board. From a phone the operator has only the ack: they move the card, read a confirmation
that something will happen, and put the phone away. Nothing happens. There is no error, no second
comment, and nothing that distinguishes "queued and progressing" from "parked pending your launch".

**And a dependency gate makes it worse.** Pop-time gating means a card can be in a launched
mission, the mission in-flight, and the card still not running because a predecessor has not
completed. "Position N" does not describe that at all, so the ack is wrong in a second way: it
implies a linear queue where there is a dependency graph.

### Root Cause

The ack was written against the queue model, where membership and eligibility are the same thing: a
card in the queue at position N will run when the queue reaches N. Missions separate them —
membership is joining a container, eligibility depends on a launch and on dependency edges — and no
single position number can express the difference. The remote surface was not revisited when the
local model gained the distinction, because the local model still falls back to Run queue.

### Non-goals

- **Not changing what staging does.** This plan does not alter the queue, the mission containers,
  the dependency gating, or the launch design. It changes what the operator is told.
- **Not implementing mission launch.** `launchMission` is fully implemented (`:14943`). This plan
  is about the ack, not the trigger.
- **Not adding a notification mechanism.** If the queue-notification bridge lands, this reuses it;
  if not, the ack comment path already exists and is sufficient.
- **No new remote mode.** Queue mode's anti-stampede purpose is unchanged.

## Metadata

**Complexity:** 3
**Tags:** bugfix, backend, ux, reliability, docs

## User Review Required

Yes — one decision.

**What should the ack say once staging means mission membership?** Recommendation: **say what the
card is waiting on, and never imply automatic progress it cannot promise.** Three states the ack
must be able to express:

1. **Queued and self-draining** — today's behaviour. Position N, will be picked up. Current wording
   is correct and should be kept for this case. This applies when the card is in a mission whose
   `runState` is `in-flight` (the mission has been launched and the queue is draining).
2. **In a mission, not launched** — say so plainly and say it needs a launch. This is the state that
   silently strands a remote operator. The mission's `runState` is `not-started`.
3. **In a launched mission, gated** — waiting on a predecessor. Name the blocker rather than a
   position, because a position is meaningless under a dependency graph. The mission's `runState`
   is `in-flight` but the card has incomplete dependency edges.

The alternative — a generic "staged" with no promise — is safer than lying but throws away the queue
depth the original ack deliberately included.

## Complexity Audit

### Routine

- Branching the ack text on the card's actual post-stage state.
- Keeping the existing wording for the self-draining / in-flight case.

### Complex / Risky

- **`onStageForQueue` must be extended to return mission state.** Today it returns only
  `{ staged, position }` (`KanbanProvider.ts:2694`). `stageForQueue` returns
  `{ success, staged, refused, error?, missionId? }` (`:8667`) — it HAS the missionId but
  `onStageForQueue` discards it. To branch the ack, the callback must also return the mission's
  `runState` and the card's gating status. This means extending the `onStageForQueue` return type
  in the `RemoteControlDeps` interface (`RemoteControlService.ts:127`) and the implementation
  (`KanbanProvider.ts:2682-2703`).
- **Gating state requires a dependency-edge read-back at stage time.** `stageForQueue` does not
  check dependencies — the gate is at pop time in `launchMission`'s stream resolution. To know
  whether a staged card is gated, `onStageForQueue` must query `getPlanDependencies` for the staged
  card and check whether any predecessor is incomplete. This is a new read path, not a reuse of an
  existing one.
- **The state must be read after staging, not assumed.** `onStageForQueue` already reads the
  position back from the DB rather than trusting the caller — the comment at
  `KanbanProvider.ts:2687` notes `stageForQueue` "appends the next position but does not return it".
  The mission `runState` and gating state need the same read-back discipline, not an inference from
  what was requested.
- **Truthfulness under a race.** A mission can be launched moments after the ack is composed, so an
  ack saying "needs a launch" can be stale on arrival. That is acceptable — understating progress is
  safe, overstating it is the bug — but the wording should not be so absolute that a subsequent
  launch reads as a contradiction.
- **A second comment is tempting and mostly wrong.** Posting again when the mission launches would
  fix staleness and reintroduce the noise problem the notification plan is careful about. If the
  notification bridge exists, a launch is one of its events and belongs there, not as a special case
  here.
- **Do not let "safer" become "useless".** Stripping the ack to "staged" removes the queue depth
  that made it actionable. The original comment's insistence on naming the position is the standard
  to hold.

## Edge-Case & Dependency Audit

**Race conditions**
- Launch between staging and ack composition — see above; understate rather than overstate.
- Two cards staged in one poll cycle, one gated and one not: each ack must reflect its own card, not
  the cycle's aggregate.

**Security**
- None. Existing comment path, existing token, no new surface. The ack already posts through the
  provider's comment path.

**Side effects**
- Operators used to "position N" on every stage will see varied wording. That is the point, and it
  should be noted in the remote skill so an agent reading acks does not treat a mission ack as a
  failure.
- `switchboard-remote/SKILL.md` section 10 already covers mission visibility on Linear; the ack
  wording change is consistent with what it says. No additional skill update is required for the ack
  itself, though the skill's dispatch instructions (which treat moving a card to a trigger state as
  dispatching work) may need a conditional note under missions.

**Migration**
- Interface change: `onStageForQueue` return type extended in `RemoteControlDeps` and its
  implementation. New read path: dependency-edge query at stage time. No schema migration, no stored
  state change, no config change. The queue path (mission `in-flight`, no gating) keeps its current
  wording exactly, so nothing regresses for installs where mission launch is not in use or where
  cards are not gated.

## Dependencies

- **Must land with, or before, the remote mission launch trigger.**
  `launching-a-mission-should-be-the-gesture-that-already-exists.md` adds the remote launch path;
  this plan makes the staging ack truthful about whether a launch has happened. After the launch
  trigger lands, the ack is false without this plan. This plan is cheap and its timing is its whole
  value — it is not worth doing late.
- **Reuses** the queue-notification bridge if that lands, for the launch event specifically. Neither
  plan blocks the other.
- **Related:** `staging-column-replaces-dispatch-view.md` and `launchMission`
  (`KanbanProvider.ts:14943`).

## Adversarial Synthesis

Key risks: (1) shipping the remote mission launch trigger without touching the ack, leaving a remote
operator with a confirmation that work is progressing when it is parked — the exact failure the
ack's own comment was written to prevent; (2) over-correcting to a generic "staged" and discarding
the queue depth that made the ack actionable; (3) adding a second comment per state change and
recreating the noise the notification plan avoids; (4) inferring the post-stage state instead of
reading it back, so the ack describes what was asked for rather than what happened; (5) missing the
`onStageForQueue` return-type extension and the dependency-edge read-back, which are the concrete
implementation path, not "text and branching only." Mitigations: extend `onStageForQueue` to return
`{ staged, position, missionId?, missionRunState?, gatedBy? }`; branch on a read-back state with
three explicit cases; keep the queue wording verbatim for the in-flight/ungated case; route any
launch event to the notification bridge rather than a bespoke second comment; and follow the
existing read-back discipline `onStageForQueue` already uses for position.

## Proposed Changes

1. **Extend `onStageForQueue`** (`KanbanProvider.ts:2682-2703`) to return
   `{ staged, position, missionId?, missionRunState?, gatedBy? }`:
   - `missionId` — from `stageForQueue`'s return value (`:8667`), currently discarded.
   - `missionRunState` — read back from the mission via `getMissionById` (`KanbanDatabase.ts:11469`),
     which hydrates `runState` via `_deriveMissionRunState` (`:11420`).
   - `gatedBy` — query `getPlanDependencies` for the staged card; if any predecessor is not
     complete, return the predecessor's name/id; otherwise null.
2. **Extend the `RemoteControlDeps` interface** (`RemoteControlService.ts:127`) to match the new
   return type.
3. **Branch the ack text** (`RemoteControlService.ts:797-804`) across three cases:
   - `missionRunState === 'in-flight'` and `gatedBy === null` → today's wording verbatim, position
     included. The queue is draining.
   - `missionRunState === 'not-started'` → say the card is in a mission that has not been launched,
     and a launch is required. Do not promise a pickup.
   - `missionRunState === 'in-flight'` and `gatedBy !== null` → name the blocker rather than a
     position. The card is gated behind a predecessor.
4. **Say plainly when a launch is required**, since that is the state that silently strands a remote
   operator.
5. **Route the launch event to the notification bridge** if it exists; do not add a bespoke second
   comment here.
6. **Update `switchboard-remote/SKILL.md`** dispatch instructions if they treat moving a card to a
   trigger state as unconditionally dispatching work — under missions that becomes conditional. (The
   skill's section 10 already covers mission visibility and needs no change for the ack itself.)

### Migration

Interface change to `onStageForQueue` return type and `RemoteControlDeps`; new dependency-edge
read-back at stage time. No schema, config, or stored-state changes. The in-flight/ungated queue
path is byte-identical to today's wording.

## Verification Plan

1. **Queue case unchanged.** With a card in an `in-flight` mission and no gating, move a card to a
   staging status remotely and assert the ack is byte-identical to today's, position included.
2. **Unlaunched mission.** Stage a card into a mission whose `runState` is `not-started`; assert the
   ack says a launch is required and does not promise a pickup.
3. **Gated card.** Stage a card whose predecessor is incomplete into an `in-flight` mission; assert
   the ack names the blocker rather than a position.
4. **State is read, not assumed.** Force a divergence between requested and actual outcome; assert
   the ack describes what happened.
5. **One comment per stage.** Assert no second comment is posted on launch from this path.
6. **Per-card accuracy.** Stage two cards in one poll cycle with different outcomes; assert each ack
   matches its own card.
7. **Understated, never overstated.** Launch a mission immediately after staging; assert the ack was
   conservative and reads as consistent rather than contradictory.
8. **All three providers** post the branched text through the existing comment path, or the skill
   states plainly where mission state is unavailable (Notion/ClickUp have no milestone primitive).

### Goal Invariants

- **Positive:** `onStageForQueue` (`KanbanProvider.ts:2682`) returns `missionRunState` in its result
  object after this plan.
- **Negative:** the ack string at `RemoteControlService.ts:803` no longer unconditionally contains
  "A coding lead will pick it up in order" — that phrase appears only when `missionRunState` is
  `in-flight` and `gatedBy` is null.
- **Positive:** a card staged into a `not-started` mission receives an ack that names the mission
  and says a launch is required.
- **Negative:** no second comment is posted from `RemoteControlService` on mission launch; the
  launch event goes through the notification bridge, not this path.
