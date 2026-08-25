# Launching a mission from a tracker should be the gesture that already exists, not a second one to learn

## Goal

Make launching a mission from Linear identical to dispatching a feature: **move one card, the group
goes.** No launch button, no bespoke state machine, no second object to hunt for — the mission card
is a card, and moving it is the launch.

### Problem Analysis

**Group dispatch by moving one card is already the product's gesture.** `cascadeFeatureByPlanId`
(`KanbanProvider.ts:8245`) moves a feature's subtasks with it, and the remote skill documents the
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
`LinearSyncService.ts:2078`) — one more state to create, one more mapping to get right, and a silent
no-op when it is missed, because an unmapped column falls through the bare `} // column not mapped`
at `:2230`. A label-based trigger has no status to reflect back, so nothing on the card ever shows
that the launch was received.

**The cascade path already handles the hard parts.** It moves members, dispatches per member, and
`KanbanProvider.ts:8281` shows it already reasons about cards leaving the Staging column. Whatever
the mission fan-out does at launch — seat teams, stage, dispatch stream heads
(`KanbanProvider.ts:9923`) — a mission-aware cascade is the same shape as the feature one, with a
different body.

**What is missing is only that a mission has no card to move.** Missions are DB rows
(`missions`, `mission_members`, V64), with no file and therefore no tracker identity —
`getIssueIdForPlan(planFile)` (`:1879`) is how anything acquires one. So the gesture cannot be
offered because there is nothing to perform it on.

### Root Cause

The cascade was built for features, which are plan rows and therefore already had a card. Missions
were built as runtime containers with no file, so they inherited none of it. Nothing forced the
question "what does the operator move?" because until missions could be reached from a tracker, the
answer was "the board, at your desk".

### Non-goals

- **No new workflow state.** Launch reuses the columns that already exist and are already mapped.
  If a mission is launched by moving it to a coding column, that is the same column a feature goes
  to.
- **No launch button, no label trigger, no bespoke status vocabulary.** Explicitly rejected above.
- **Not defining what fan-out does.** This plan supplies the trigger and the cascade shape; the
  fan-out owns seating teams and dispatching stream heads.
- **Not membership.** `missions-are-invisible-in-the-tracker-and-two-linear-primitives-are-free.md`
  puts members on a project milestone. This plan is only the control surface.
- **Not making missions plans.** The mission needs a card, not a plan file with a plan's semantics.

## Metadata

**Complexity:** 6
**Tags:** backend, feature, ux, api, devops

## User Review Required

Yes — two decisions, and the first is the plan.

1. **How does a mission acquire a card without becoming a plan?** Two candidates:
   - **(a) A mission issue with its own identity**, mapped in the same store as the milestone, and
     excluded from plan ingestion by explicit link. Keeps missions out of the `plans` table
     entirely, at the cost of a second non-plan identity in the sync.
   - **(b) A mission row that the board already renders as a card** — if the fan-out work gives
     missions a board card locally, the sync may be able to treat that card like any other and the
     question dissolves. **Check this against the fan-out being built before choosing (a).** If
     missions already render as cards, (a) is redundant work.

   Recommendation: **decide after reading the fan-out.** This is the one place where a day's delay
   is worth it, because (a) is real work that (b) may make unnecessary.

2. **Which column launches?** Recommendation: **the same coding columns a feature goes to**, so
   there is nothing new to map and the existing `columnToStateId` entries already cover it. A
   mission sitting in STAGING moved to a coding status launches; the mapping already exists because
   those columns are already mapped.

## Complexity Audit

### Routine

- A mission-aware branch alongside `cascadeFeatureByPlanId` at the column-move seam.
- Reusing the existing `columnToStateId` mapping — no new states, no new setup step.

### Complex / Risky

- **Idempotence is the sharp edge.** A remote status change arrives via a poll, and polls retry.
  Launching a mission twice means seating teams twice and dispatching stream heads twice. The
  feature cascade's protection against this is the model to follow, and if it does not have one,
  this path needs its own — a launched mission must be a state, not an event.
- **Partial launch.** Fan-out seats teams and dispatches heads; a failure halfway leaves some
  members running and some not. The mission's state must distinguish "not launched", "launching",
  "launched" and "launch failed", and the tracker must show the difference — an operator on a phone
  who sees nothing cannot tell a stalled launch from a slow one.
- **Dependency gating means launch does not mean run.** Pop-time gating holds members behind
  predecessors, so a launched mission can look identical to an unlaunched one from the tracker. The
  companion plan's synced `blocks` relations are what make that legible; without them, this gesture
  produces a confusing silence.
- **The ack must change with it.** `the-staging-ack-promises-a-pickup-that-missions-will-not-do.md`
  covers the entry message; the launch needs its own truthful acknowledgement, and it should ride
  the notification bridge rather than growing a second comment path.
- **A mission card in plan ingestion would be a disaster.** It would become a plan file, then a
  board card, then possibly get dispatched as work. Exclusion must be by explicit link, never a name
  match — the requirement `orchestrator-instructions-column.md` already states for its column.

## Edge-Case & Dependency Audit

**Race conditions**
- Poll retry re-delivering the same status change — see idempotence above.
- Mission launched at the desk while a remote move is in flight: the second must be a no-op with a
  truthful ack, not a second launch.
- A member added to the mission between the move and the fan-out: define whether it is included or
  runs next, and say which in the ack.

**Security**
- No new exposure. Existing inbound poll, existing token, existing mapped columns.
- Launch is a privileged action reachable from a tracker: anyone with project access who can change
  an issue's status can start real work on the operator's machine. That is already true of the
  existing dispatch-by-status path, so it is not a new class of risk — but it is worth stating once
  in the docs rather than discovering.

**Side effects**
- The board gains mission cards in its column flow if option (a) is taken.
- `switchboard-remote/SKILL.md` gains a mission section; its current "what the tracker cannot show
  you" list names missions first.

**Migration**
- Additive. No existing mapping changes, no new state to map, no stored shape altered. Installs
  without missions or without Linear are unaffected.

## Dependencies

- **The mission fan-out** — this plan supplies the trigger; the fan-out is what runs. Decision 1
  should be made by reading it, not ahead of it.
- **Pairs with** `missions-are-invisible-in-the-tracker-and-two-linear-primitives-are-free.md`.
  Membership and blocking relations are what make a launched mission legible from a phone; without
  them this gesture works and shows nothing.
- **Should reuse** the queue-notification bridge for the launch acknowledgement rather than adding a
  comment path.

## Adversarial Synthesis

Key risks: (1) inventing a second grouped-dispatch gesture, which is the clunkiness this plan exists
to avoid; (2) a bespoke launch state that must be manually mapped and silently no-ops when it is not
(`:2230`); (3) double-launch from a poll retry, seating teams twice; (4) a partial launch that looks
identical to no launch from a phone; (5) a mission card entering plan ingestion and being dispatched
as work; (6) building a mission-issue identity that the fan-out makes redundant. Mitigations: reuse
the feature cascade and the columns already mapped; make "launched" a state rather than an event;
distinguish and surface the four launch states; exclude from ingestion by explicit link; and settle
decision 1 by reading the fan-out rather than guessing ahead of it.

## Proposed Changes

1. **Read the fan-out first** and settle decision 1 — whether missions already render as cards, or
   need a synced mission identity.
2. **A mission-aware cascade** at the same column-move seam as `cascadeFeatureByPlanId`, delegating
   to the fan-out for what launch actually does.
3. **Launch on the existing coding columns**, with no new state and no new mapping step.
4. **Launch as a state, not an event** — not launched / launching / launched / failed — idempotent
   under poll retry and visible in the tracker.
5. **Exclude mission cards from plan ingestion** by explicit link.
6. **A truthful launch acknowledgement** routed through the notification bridge.
7. **Skill and docs**: the mission gesture is the feature gesture; say so, and note that a tracker
   status change can start real work.

### Migration

Additive; no mapping, state or stored shape changes.

## Verification Plan

1. **One gesture.** From Linear on a phone, move a mission card from a staging status to a coding
   status and assert the mission launches — the same action, on the same kind of object, as
   dispatching a feature.
2. **No new mapping.** Assert the flow works with an existing `columnToStateId` and no additional
   state created or mapped. If a setup step is required, the design has failed its own goal.
3. **Feature cascade unregressed.** Dispatch a feature the same way; assert byte-identical
   behaviour.
4. **Double-launch refused.** Deliver the same status change twice; assert one launch, one ack, and
   no second team seated.
5. **Desk and remote race.** Launch at the desk while a remote move is in flight; assert a no-op
   with a truthful ack.
6. **Partial launch is legible.** Fail the fan-out halfway; assert the tracker distinguishes it from
   "not launched" and from "launched and gated".
7. **Gated members read correctly.** With the companion plan's relations synced, assert a launched
   mission whose members are blocked shows the blocks rather than an unexplained silence.
8. **Never ingested.** Assert a mission card produces no plan file, no board work card, and is never
   dispatched as a plan.
9. **Providers.** Assert the same gesture on ClickUp and Notion, or that the skill states plainly
   where it is unavailable.
