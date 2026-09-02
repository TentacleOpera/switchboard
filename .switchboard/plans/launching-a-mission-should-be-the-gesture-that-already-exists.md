# Launching a mission from a tracker should be the gesture that already exists, not a second one to learn

## Goal

Make launching a mission from Linear identical to dispatching a feature: **move one card, the group
goes.** No launch button, no bespoke state machine, no second object to hunt for — the mission's
tracker representation is a card-equivalent, and moving it is the launch.

### Problem Analysis

**Group dispatch by moving one card is already the product's gesture.** `cascadeFeatureByPlanId`
(`KanbanProvider.ts:8514`) moves a feature's subtasks with it, and the remote skill documents the
tracker half: set the status on the **feature** card, not the subtasks, and "the local cascade moves
all subtasks to the same column and dispatches each subtask's column agent." An operator who has
used Switchboard from a tracker already knows this gesture and already trusts it.

**A mission is the same shape and would arrive with a different gesture.** A mission is a container
with members, dispatched deliberately. Every alternative launch mechanism considered — a dedicated
"Launch" workflow state, a `mission:launch` label, a control issue with its own status vocabulary —
introduces a second way to start grouped work, distinguishable from the first only by which kind of
container you happen to be looking at. That is the clunkiness: not the number of taps, but having to
remember which object takes which action.

**And the failure modes are worse than the friction.** A bespoke launch state has to be mapped, per
team, in the same manual QuickPick that already maps every column (`_mapColumnsToStates`,
`LinearSyncService.ts:2535`) — one more state to create, one more mapping to get right, and a silent
no-op when it is missed, because an unmapped column falls through the bare `} // column not mapped`
at `:2687`. A label-based trigger has no status to reflect back, so nothing on the card ever shows
that the launch was received.

**The fan-out is already built.** `launchMission` (`KanbanProvider.ts:14943`) is fully implemented:
it seats teams (resolves coding roles from terminal groups, falls back to alive terminals), resolves
stream count from dependency edges (roots = concurrent chains), creates a run worktree (capped at 1
for missions), dispatches from the queue via `apiServer.dispatchNextFromQueue`, and reports
shortfalls. It is idempotent: a mission with `runState !== 'not-started'` is refused outright
(`:14957-14962`). The `mcLaunchMission` webview verb (`:10219`) calls it from the Mission Control
panel. **What is missing is not the fan-out but the remote trigger** — `RemoteControlService.ts`
has zero mission awareness (no references to `mission`, `launch`, or `milestone` anywhere in the
file). There is no path from a remote status change to `launchMission`.

**Missions now have tracker identity — as Linear milestones, not issues.** The companion plan
`missions-are-invisible-in-the-tracker-and-two-linear-primitives-are-free.md` has been implemented.
`syncMissionsAndDependencies` (`LinearSyncService.ts:3724`) syncs missions as Linear project
milestones, with a `mission_milestones` mapping table (V66, `KanbanDatabase.ts:636`). Member issues
are assigned to the milestone; dependency edges are synced as `blocks` relations. The
`switchboard-remote/SKILL.md` has been updated (section 10): "On Linear, missions and their
dependency edges ARE mirrored natively (missions as project milestones, dependency edges as `blocks`
relations), though runtime launch/stop controls remain host-managed."

**But milestones have no status to move.** Linear project milestones are grouping primitives — they
have a name, description, target date, and sort order, but no workflow state or column. You cannot
"move" a milestone to a coding status. So the gesture-you-know (move one card) cannot be performed
on the mission's actual tracker representation. This is the crux: the mission has identity in the
tracker, but not a movable one.

### Root Cause

The cascade was built for features, which are plan rows with files and therefore already had issue
cards. Missions were built as runtime containers with no file, so they inherited none of the cascade.
The companion plan later gave missions tracker identity as milestones — but milestones are not
movable objects, so the question "what does the operator move?" was never answered. The fan-out was
built and wired to a webview button (`mcLaunchMission`), but no remote path was added. The gap is
the wire from a remote tracker action to `launchMission`, and the choice of what tracker action
that is.

### Non-goals

- **No new workflow state.** Launch reuses the columns that already exist and are already mapped.
  If a mission is launched by moving a card to a coding column, that is the same column a feature goes
  to.
- **No launch button, no label trigger, no bespoke status vocabulary.** Explicitly rejected above.
- **Not rebuilding the fan-out.** `launchMission` is fully implemented. This plan supplies the
  remote trigger, not the dispatch engine.
- **Not membership or milestone sync.** `missions-are-invisible-in-the-tracker-and-two-linear-primitives-are-free.md`
  is implemented — missions sync as milestones, members as milestone assignments, dependencies as
  `blocks` relations. This plan is only the remote launch trigger.
- **Not making missions plans.** The mission needs a launch trigger, not a plan file with a plan's
  semantics.
- **Not updating `switchboard-remote/SKILL.md` section 10.** Already updated by the companion plan.
  This plan may need to add launch-from-tracker instructions to other sections of the skill.

## Metadata

**Complexity:** 6
**Tags:** backend, feature, ux, api, devops

## User Review Required

Yes — one decision, and it is the plan's central question.

**What tracker action triggers the launch, given that milestones have no status to move?** Three
candidates:

1. **(a) Move the first member card to a coding column.** The operator moves any member issue from
   STAGING to a coding status; `RemoteControlService` detects that the card belongs to an unlaunched
   mission and calls `launchMission` instead of (or before) staging/dispatching the single card.
   - Pro: no new tracker object; the gesture is "move a card you already see."
  - Con: it is not "move the group's card" — it is "move a member and the group goes," which is a
    different mental model from the feature cascade (where you move the parent, not a child).
  - Con: ambiguity — what if the card is not in a mission? What if the mission is already in-flight?
    The remote service must query mission membership before deciding what the move means.

2. **(b) A dedicated mission control issue** with its own Linear identity, excluded from plan
   ingestion by explicit link, moved to a coding column to launch.
  - Pro: the gesture is exactly "move the group's card," identical to the feature cascade.
  - Con: a second non-plan identity in the sync (the plan explicitly rejected this, but milestones
    already are one — this would be a third).
  - Con: the operator must find and move a card that is not any of the work cards.

3. **(c) A comment trigger on any member card** — operator writes `@switchboard launch` on a member;
   the comment poll picks it up and calls `launchMission`.
  - Pro: no new object; works on any card in the mission; no status-mapping needed.
  - Con: it is a second gesture (typing a command), not the gesture-you-know. The plan exists to
    avoid second gestures.

Recommendation: **(a) is the closest to the gesture-you-know** and requires no new tracker object.
The mental model shift — "move a member, the group goes" vs "move the parent, the group goes" — is
smaller than introducing a new object or a comment command. But the operator must understand that
moving any member of an unlaunched mission launches the whole mission, not just that card.

## Complexity Audit

### Routine

- A mission-awareness check in `RemoteControlService._applyStateMirror` (or the staging/dispatch
  branch at `:790`) — before staging or dispatching a single card, query whether it belongs to a
  mission and what the mission's `runState` is.
- Reusing the existing `columnToStateId` mapping — no new states, no new setup step.
- Calling the existing `launchMission` — no new dispatch logic.

### Complex / Risky

- **The trigger ambiguity.** Moving a member card to a coding column currently means "dispatch this
  one card." Under option (a), it would mean "launch the whole mission" if the card is in an
  unlaunched mission. The remote service must distinguish: is this card in a mission? Is the mission
  `not-started`? If yes, launch the mission (which dispatches the first eligible member via the
  queue). If the mission is already `in-flight`, the card move is a normal dispatch/stage. Getting
  this wrong either swallows a single-card dispatch into a mission launch, or launches a mission
  when the operator only meant to move one card.
- **Idempotence under poll retry.** `launchMission` already refuses if `runState !== 'not-started'`
  (`:14957`), so a poll retry that re-delivers the same status change hits the idempotency guard.
  But the ack must be truthful: the retry should produce "already in flight" not "launched."
- **Partial launch legibility.** `launchMission` dispatches up to `streams` heads; a shortfall is
  reported in the return value but not to the tracker. An operator on a phone who sees a launch ack
  but no movement cannot tell a stalled launch from a slow one. The launch ack (if any) should
  include the shortfall.
- **Dependency gating means launch does not mean run.** Pop-time gating holds members behind
  predecessors, so a launched mission can look identical to an unlaunched one from the tracker. The
  companion plan's synced `blocks` relations are what make that legible; without them, this gesture
  produces a confusing silence.
- **The ack must change with it.** `the-staging-ack-promises-a-pickup-that-missions-will-not-do.md`
  covers the staging ack; the launch needs its own truthful acknowledgement, and it should ride the
  notification bridge rather than growing a second comment path.
- **A mission control issue in plan ingestion would be a disaster** (option (b) only). It would
  become a plan file, then a board card, then possibly get dispatched as work. Exclusion must be by
  explicit link, never a name match.

## Edge-Case & Dependency Audit

**Race conditions**
- Poll retry re-delivering the same status change — `launchMission`'s `runState` guard handles this;
  the ack must say "already in flight" not "launched again."
- Mission launched at the desk (`mcLaunchMission`) while a remote move is in flight: the remote
  `launchMission` call hits the `runState === 'in-flight'` refusal. The ack must be truthful.
- A member added to the mission between the move and the fan-out: `stageForQueue` already handles
  this — a launched mission is sealed, so a card arriving after launch starts the next mission
  (`KanbanProvider.ts:8704`). The ack should say which mission the card joined.

**Security**
- No new exposure. Existing inbound poll, existing token, existing mapped columns.
- Launch is a privileged action reachable from a tracker: anyone with project access who can change
  an issue's status can start real work on the operator's machine. That is already true of the
  existing dispatch-by-status path, so it is not a new class of risk — but it is worth stating once
  in the docs rather than discovering.

**Side effects**
- Under option (a), moving any member card to a coding column launches the mission. Operators used
  to single-card dispatch must learn that a member of an unlaunched mission moves the whole group.
  This is the gesture change and should be documented in `switchboard-remote/SKILL.md`.
- Under option (b), the board gains a mission control card per mission in its column flow.

**Migration**
- Additive. No existing mapping changes, no new state to map, no stored shape altered. Installs
  without missions or without Linear are unaffected. The `RemoteControlService` mission-awareness
  check is a read-only query before the existing dispatch/stage branch.

## Dependencies

- **The mission fan-out is built.** `launchMission` (`KanbanProvider.ts:14943`) is fully
  implemented and idempotent. This plan wires a remote trigger to it; it does not build the engine.
- **Pairs with** `missions-are-invisible-in-the-tracker-and-two-linear-primitives-are-free.md`
  (implemented). Membership and blocking relations are what make a launched mission legible from a
  phone; without them this gesture works and shows nothing.
- **Pairs with** `the-staging-ack-promises-a-pickup-that-missions-will-not-do.md`. The staging ack
  must reflect mission state; the launch trigger must produce its own truthful ack. Both touch
  `RemoteControlService.ts` but on different paths (staging vs. launch).
- **Should reuse** the queue-notification bridge for the launch acknowledgement rather than adding a
  comment path.

## Adversarial Synthesis

Key risks: (1) the milestone-has-no-status problem — the gesture-you-know may not be achievable on
the mission's actual tracker representation, forcing a choice between a member-card trigger (a
different mental model), a control issue (a second object), or a comment command (a second gesture);
(2) trigger ambiguity — moving a member card to a coding column currently means "dispatch this
card," and overloading it to mean "launch the mission" when the card is in an unlaunched mission
could swallow single-card dispatches; (3) double-launch from poll retry — handled by `launchMission`'s
`runState` guard, but the ack must say "already in flight"; (4) partial launch that looks identical
to no launch from a phone — the shortfall is in the return value but not the tracker; (5) a mission
control issue entering plan ingestion and being dispatched as work (option (b) only). Mitigations:
prefer option (a) for closest gesture match; query mission membership and `runState` before deciding
what a card move means; rely on the existing idempotency guard; include shortfall in the launch ack;
exclude any control issue from ingestion by explicit link.

## Proposed Changes

1. **Settle the trigger mechanism** — decide between (a) member-card trigger, (b) control issue, or
   (c) comment trigger. Recommendation: (a).
2. **Add mission awareness to `RemoteControlService`** — before the staging/dispatch branch
   (`:790`), query whether the moved card is a mission member and what the mission's `runState` is.
   This requires either extending `RemoteControlDeps` with a mission-query callback or adding a
   `db` reference to the service.
3. **Branch on mission state:**
   - Card is in a `not-started` mission → call `launchMission` (via a new `onLaunchMission` dep
     callback), post a launch ack.
   - Card is in an `in-flight` mission → proceed with normal staging/dispatch (the mission is
     already running; this card joins the queue).
   - Card is not in a mission → proceed with today's behaviour unchanged.
4. **Launch on the existing coding columns** — no new state, no new mapping step. The same
   `columnToStateId` entries that cover feature dispatch cover mission launch.
5. **Rely on the existing three-state `runState` model** — `not-started` / `in-flight` / `completed`
   (`_deriveMissionRunState`, `KanbanDatabase.ts:11420`). Do not invent a parallel four-state model.
   `runState` is derived from member state, never stored, so a failed dispatch releases the holder
   and the mission reads `not-started` again — "failed" is not a persistent state.
6. **A truthful launch acknowledgement** — post a comment on the moved card (or the milestone's
   first member) saying the mission was launched, how many streams were seated, and any shortfall.
   Route through the notification bridge if it exists; otherwise the existing comment path.
7. **Update `switchboard-remote/SKILL.md`** — add launch-from-tracker instructions (section 10
  already covers mission visibility; the launch gesture itself is new documentation). Note that
  moving a member of an unlaunched mission to a coding status launches the whole mission, and that
  a tracker status change can start real work.

### Migration

Additive; no mapping, state, or stored-shape changes. The `RemoteControlService` mission-awareness
check is a read-only query before the existing branch.

## Verification Plan

1. **One gesture.** From Linear on a phone, move a member card of an unlaunched mission from a
   staging status to a coding status and assert the mission launches — the same action, on the same
   kind of object, as dispatching a feature.
2. **No new mapping.** Assert the flow works with an existing `columnToStateId` and no additional
   state created or mapped. If a setup step is required, the design has failed its own goal.
3. **Feature cascade unregressed.** Dispatch a feature the same way; assert byte-identical
   behaviour.
4. **Double-launch refused.** Deliver the same status change twice; assert one launch, one ack, and
   no second team seated. The second ack says "already in flight."
5. **Desk and remote race.** Launch at the desk (`mcLaunchMission`) while a remote move is in
   flight; assert the remote call is refused with a truthful ack.
6. **Partial launch is legible.** Fail the fan-out halfway (no live terminals); assert the launch
   ack reports the shortfall and the tracker distinguishes it from "not launched."
7. **Gated members read correctly.** With the companion plan's relations synced, assert a launched
   mission whose members are blocked shows the blocks rather than an unexplained silence.
8. **Non-member card unchanged.** Move a card that is NOT in a mission to a coding status; assert
   today's staging/dispatch behaviour is byte-identical.
9. **In-flight member card.** Move a card that is in an `in-flight` mission to a coding status;
   assert it stages/dispatches normally (the mission is already running).
10. **Never ingested** (option (b) only). Assert a mission control issue produces no plan file, no
    board work card, and is never dispatched as a plan.
11. **Providers.** Assert the same gesture on ClickUp and Notion, or that the skill states plainly
    where it is unavailable (missions are Linear-only per `RemoteProviderCapabilities`).

### Goal Invariants

- **Positive:** `launchMission` (`KanbanProvider.ts:14943`) is called from `RemoteControlService`
  when a member card of a `not-started` mission is moved to a coding column remotely.
- **Negative:** `RemoteControlService.ts` contains zero references to `launchMission` or
  `onLaunchMission` today; after this plan, it contains at least one call path.
- **Positive:** a mission moved to `in-flight` via remote trigger has the same `runState` as one
  moved via `mcLaunchMission` (both go through `launchMission`).
- **Negative:** no new `**Project:**`-style state column is added to `columnToStateId` mapping; the
  launch uses only columns already mapped.
