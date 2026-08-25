# The staging ack tells the operator a coding lead will pick the card up, which mission dispatch will make false

## Goal

Keep the remote staging acknowledgement truthful as STAGING moves from a self-draining queue to a
mission container that waits for a manual launch. The ack is the only thing an operator away from
the desk sees after moving a card, and it currently promises an automatic pickup that the mission
design does not provide.

### Problem Analysis

**The ack exists specifically to be truthful, and says so.** `RemoteControlService.ts:783-797`
handles a remote move into a queueable column. On success it posts back to the card:

> "Switchboard received this status change and staged it as position N in the session queue. **A
> coding lead will pick it up in order.**"

with a comment above it explaining the wording was chosen with care: "Truthful ack: a staged card is
NOT a dispatched card. The current wording ('dispatched the local agent') would be a lie the user
acts on. Name the position so the remote user can see the queue depth."

**That promise is true today.** `QUEUEABLE_TARGET_COLUMNS` (`:112`) includes `STAGING`;
`onStageForQueue` (`KanbanProvider.ts:2687`) calls `stageForQueue`, which appends a `queue_position`
(V60, `KanbanDatabase.ts:573`); and the queue is drained by Run queue. A card staged from a phone
does get picked up in order, without the operator returning to the desk.

**Mission dispatch changes what staging means.** V64 (`KanbanDatabase.ts:633-645`) added `missions`,
`mission_members` and `plan_dependencies` — described in the migration comment as "mission
containers for STAGING queue" — and dependency edges are gated at pop time. The launch half is not
built: `KanbanProvider.ts:9923` returns "Launch is not implemented yet — the mission fan-out (seat
teams, stage, dispatch stream heads) is unbuilt. **Use Run queue in the STAGING column.**"

So the intended model is that a card moved to STAGING joins a mission that is dispatched
deliberately, rather than drained automatically. When that lands, the sentence "a coding lead will
pick it up in order" stops being true — and it is the sentence a remote operator acts on.

**The failure is silent and specifically remote.** At the desk, an un-launched mission is visible on
the board. From a phone the operator has only the ack: they move the card, read a confirmation that
something will happen, and put the phone away. Nothing happens. There is no error, no second
comment, and nothing that distinguishes "queued and progressing" from "parked pending your launch".

**And a dependency gate makes it worse.** Pop-time gating means a card can be in a mission, the
mission launched, and the card still not running because a predecessor has not completed. "Position
N" does not describe that at all, so the ack is wrong in a second way: it implies a linear queue
where there is a dependency graph.

### Root Cause

The ack was written against the queue model, where membership and eligibility are the same thing: a
card in the queue at position N will run when the queue reaches N. Missions separate them —
membership is joining a container, eligibility depends on a launch and on dependency edges — and no
single position number can express the difference. The remote surface was not revisited when the
local model gained the distinction, because the local model still falls back to Run queue.

### Non-goals

- **Not changing what staging does.** This plan does not alter the queue, the mission containers,
  the dependency gating, or the launch design. It changes what the operator is told.
- **Not implementing mission launch.** That is the mission fan-out work `:9923` names as unbuilt.
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
   is correct and should be kept for this case.
2. **In a mission, not launched** — say so plainly and say it needs a launch. This is the state that
   silently strands a remote operator.
3. **In a launched mission, gated** — waiting on a predecessor. Name the blocker rather than a
   position, because a position is meaningless under a dependency graph.

The alternative — a generic "staged" with no promise — is safer than lying but throws away the queue
depth the original ack deliberately included.

## Complexity Audit

### Routine

- Branching the ack text on the card's actual post-stage state.
- Keeping the existing wording for the queue case.

### Complex / Risky

- **The state must be read after staging, not assumed.** `onStageForQueue` already reads the
  position back from the DB rather than trusting the caller — the comment at
  `KanbanProvider.ts:2691` notes `stageForQueue` "appends the next position but does not return it".
  The mission and gating state need the same read-back discipline, not an inference from what was
  requested.
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
- `switchboard-remote/SKILL.md` describes moving a card to a trigger state as dispatching work.
  Under missions that becomes conditional and the skill needs the same correction.

**Migration**
- Text and branching only. No stored state, schema, or config changes. The queue path keeps its
  current wording exactly, so nothing regresses for installs where mission launch is not in use.

## Dependencies

- **Must land with, or before, mission dispatch.** After it, the ack is false. This plan is cheap
  and its timing is its whole value — it is not worth doing late.
- **Reuses** the queue-notification bridge if that lands, for the launch event specifically. Neither
  plan blocks the other.
- **Related:** `staging-column-replaces-dispatch-view.md` and the mission fan-out work named at
  `KanbanProvider.ts:9923`.

## Adversarial Synthesis

Key risks: (1) shipping mission dispatch without touching the ack, leaving a remote operator with a
confirmation that work is progressing when it is parked — the exact failure the ack's own comment was
written to prevent; (2) over-correcting to a generic "staged" and discarding the queue depth that
made the ack actionable; (3) adding a second comment per state change and recreating the noise the
notification plan avoids; (4) inferring the post-stage state instead of reading it back, so the ack
describes what was asked for rather than what happened. Mitigations: branch on a read-back state with
three explicit cases; keep the queue wording verbatim for the queue case; route any launch event to
the notification bridge rather than a bespoke second comment; and follow the existing read-back
discipline `onStageForQueue` already uses for position.

## Proposed Changes

1. **Read the card's post-stage state back** — queued, in an unlaunched mission, or gated behind a
   predecessor — using the same DB read-back `onStageForQueue` already performs for position.
2. **Branch the ack text** across those three cases, keeping today's wording verbatim for the queue
   case and naming the blocker rather than a position for the gated case.
3. **Say plainly when a launch is required**, since that is the state that silently strands a remote
   operator.
4. **Route the launch event to the notification bridge** if it exists; do not add a bespoke second
   comment here.
5. **Update `switchboard-remote/SKILL.md`**, whose current text treats moving a card to a trigger
   state as dispatching work.

### Migration

Text and branching only. No schema, config or stored-state changes; the queue path is byte-identical.

## Verification Plan

1. **Queue case unchanged.** With mission launch not in use, move a card to a staging status
   remotely and assert the ack is byte-identical to today's, position included.
2. **Unlaunched mission.** Stage a card into a mission that has not been launched; assert the ack
   says a launch is required and does not promise a pickup.
3. **Gated card.** Stage a card whose predecessor is incomplete; assert the ack names the blocker
   rather than a position.
4. **State is read, not assumed.** Force a divergence between requested and actual outcome; assert
   the ack describes what happened.
5. **One comment per stage.** Assert no second comment is posted on launch from this path.
6. **Per-card accuracy.** Stage two cards in one poll cycle with different outcomes; assert each ack
   matches its own card.
7. **Understated, never overstated.** Launch a mission immediately after staging; assert the ack was
   conservative and reads as consistent rather than contradictory.
8. **All three providers** post the branched text through the existing comment path.
