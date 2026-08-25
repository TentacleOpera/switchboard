# A mission is a gap in the tracker, and the two Linear primitives that fit it are both unused

## Goal

Give missions and their dependency edges a tracker representation, so an operator away from the
desk can see what a staged card is grouped with and what is blocking it — using Linear primitives
that are currently unused and that do not collide with the two already spoken for.

### Problem Analysis

**From the tracker, a mission is a gap.** A card moved to a staging status is mirrored into local
STAGING and receives one ack comment. It then sits, apparently inert, until work starts and the
outbound sync pushes its new column's state. Between those two points the mission — the thing that
actually organises the work — has no representation at all. Two cards in the same mission look like
two unrelated cards in staging.

Confirmed by grep: the only `mission`-shaped hits in `LinearSyncService`, `RemoteControlService`,
`ContinuousSyncService`, `mirrorSync` and the `remote/` providers are **Mission Control** — the
orchestrator seat, an unrelated concept sharing the word. The V64 tables (`missions`,
`mission_members`, `plan_dependencies`, `KanbanDatabase.ts:633-645`) have no outbound path.

**Sync identity is keyed on a file, and missions have none.** `getIssueIdForPlan(planFile)`
(`LinearSyncService.ts:1879`) is how everything in the sync acquires a tracker identity. Features
get one for free because a feature *is* a plan row with a file under `.switchboard/features/`.
Missions are DB rows only.

**The obvious representation collides with features.** Modelling a mission as a parent issue with
its members as sub-issues is impossible: a Linear issue has **one** parent, and features already
use it. A subtask in a feature that is also staged into a mission cannot be a child of both. Notion
is the same — `switchboard-remote/SKILL.md` records "a subtask can belong to only **one** feature
(single-select relation / single parent)". Missions and features are orthogonal groupings competing
for one slot.

**But two Linear primitives are entirely unused, and both are orthogonal to parent.** A grep across
`src/services/` for `milestone`, `projectMilestone` and `issueRelation` returns nothing.

- **Project milestones.** An issue's milestone is a separate field from its parent, so a card can
  carry a feature parent *and* a mission milestone simultaneously — exactly the collision above,
  dissolved. Milestones are first-class: named, ordered, with progress rendered natively. And the
  Switchboard board is already mapped to a Linear **project** (`includeProjectNames`,
  `resolveSingleIncludeProjectId`), so a mission is naturally a milestone *within* the board's
  project rather than a new container beside it.
- **Issue relations.** V64 persists `plan_dependencies` with pop-time gating — a blocking graph.
  Linear has native `blocks` / `blocked by` relations, orthogonal to parent, milestone and status,
  and rendered in its UI. The gating graph can round-trip as data rather than prose.

**That second one retires a problem stated elsewhere.**
`the-staging-ack-promises-a-pickup-that-missions-will-not-do.md` argues that "position N" is
meaningless under a dependency graph and proposes naming the blocker in the ack text. With relations
synced, the ack does not have to describe the blocker — Linear draws it.

### Root Cause

Missions were designed as a runtime container: a team, a worktree budget, a ready flag, a member
set. Everything the sync knows how to mirror is a *plan* — a file with an issue id. The two models
never met, because missions did not exist when the sync's identity model was settled, and nothing
since has needed a non-plan entity to appear in a tracker.

### Non-goals

- **Not adding a launch control.** Membership and blocking only. Launching a mission from the
  tracker is `launching-a-mission-should-be-the-gesture-that-already-exists.md`.
- **Not making missions plans.** No mission file, no plan row, no `is_mission` flag on `plans`.
  Missions keep their own tables; this plan gives them a tracker projection, not a new local shape.
- **Not two-way for mission internals.** `team`, `max_extra_worktrees`, `goal` and membership are
  owned by the host. Editing a milestone in Linear must not rewrite mission state.
- **Not Notion or ClickUp parity in this plan.** Milestones are a Linear concept; the other
  providers need their own answer and should degrade cleanly rather than half-work.

## Metadata

**Complexity:** 6
**Tags:** backend, api, feature, devops, ux

## User Review Required

Yes — three decisions.

1. **One milestone per mission, created on demand or mirrored eagerly?** Recommendation: **on
   demand, when a mission first acquires a member with a synced issue.** A mission with nothing in
   the tracker should leave no trace there.
2. **What happens to the milestone when the mission ends?** Missions are session-shaped; milestones
   are durable. Recommendation: **mark complete, never delete** — deleting loses the record of what
   ran together, which is most of the value when looking back. But this needs an explicit rule or
   the project accumulates milestones indefinitely.
3. **Do dependencies sync one-way or two-way?** Recommendation: **outbound only to start.** A
   `blocks` relation drawn by hand in Linear would have to become a `plan_dependencies` row that the
   pop-time gate then honours — that is a person editing an execution graph from a phone, and it
   deserves its own decision rather than arriving as a side effect of mirroring.

## Complexity Audit

### Routine

- Creating and updating a milestone for a mission; assigning member issues to it.
- Creating `blocks` relations from `plan_dependencies` rows.
- Storing the mission→milestone id mapping.

### Complex / Risky

- **A new identity model, not a new field.** Every existing mapping is plan-file→issue. A
  mission→milestone mapping is the sync's first non-plan identity, so it needs its own storage and
  its own reconciliation, and must not be smuggled into the plan tables.
- **Both APIs need verifying before design is fixed.** Milestone assignment mutations and
  `issueRelationCreate` semantics — including what happens on duplicate relations and on assigning
  an issue to a milestone in a project it does not belong to — must be tested against the real API.
  This plan should not ship a shape that assumes them.
- **Membership churn.** Cards enter and leave STAGING; `KanbanDatabase.ts:10226` already clears
  `queue_position` when a card leaves. Milestone assignment must follow membership rather than
  drift, and a card that leaves a mission must be unassigned — a stale milestone is worse than none
  because it reads as current.
- **Relations are graph edges and can conflict.** A relation surviving after its
  `plan_dependencies` row is gone leaves Linear showing a block that the gate no longer enforces —
  an operator would then wait for nothing. Removal must be as reliable as creation.
- **Provider asymmetry.** Notion and ClickUp have no milestone equivalent. The abstraction in
  `RemoteProvider` must let this degrade to nothing rather than force a lowest-common-denominator
  design onto Linear, and the skill must say which providers show missions.
- **Rate and volume.** A mission with many members means many milestone assignments and possibly
  many relations, all in one poll cycle. Batch, and never let this path block the sync it rides on.

## Edge-Case & Dependency Audit

**Race conditions**
- A member card synced after the milestone is created: assignment must be retried or driven from
  membership rather than fired once at creation.
- Mission dissolved mid-cycle: assignments in flight must not resurrect it.
- Two hosts syncing one board — the same `refreshFromDisk` discipline
  `LinearAutomationService.poll()` uses (`:300-303`) applies.

**Security**
- No new exposure, no new credential; existing outbound sync and token.
- Mission names and goals reach the tracker, visible to everyone with project access. Same audience
  consideration as the other outbound plans; worth one line in the docs.

**Side effects**
- The board's Linear project gains milestones, which appear in Linear's own project views and
  progress reporting. That is the feature working, but it changes what teammates see.
- Mission issues (from the companion plan) and milestones must not be picked up by plan ingestion.
  `orchestrator-instructions-column.md` states the same requirement for its column, including that
  exclusion must be an explicit link and "never a name match".

**Migration**
- Additive: a new mapping store, no change to `plans`, `missions` or `mission_members`. Installs
  with no Linear setup, or with mission sync off, behave exactly as today. Existing missions gain
  representation only when they next change.

## Dependencies

- **The mission fan-out** (`KanbanProvider.ts:9923`, "the mission fan-out … is unbuilt") determines
  what mission states exist and therefore what is worth mirroring. Membership and dependencies are
  stable regardless, so this plan can proceed alongside it.
- **Feeds** `the-staging-ack-promises-a-pickup-that-missions-will-not-do.md`: with relations synced,
  its "gated" case can point at the relation rather than describe the blocker in prose.
- **Pairs with** `launching-a-mission-should-be-the-gesture-that-already-exists.md`, which supplies
  the control surface. Neither blocks the other.

## Adversarial Synthesis

Key risks: (1) modelling a mission as a parent issue and colliding with features over the single
parent slot — the failure this plan exists to avoid; (2) assuming milestone and relation API
semantics rather than verifying them; (3) stale milestone assignments and orphaned relations, both
of which read as current and mislead an operator away from the desk; (4) smuggling a non-plan
identity into the plan tables; (5) forcing Notion and ClickUp into a Linear-shaped design instead of
degrading; (6) mission sync blocking or slowing the plan sync it rides on. Mitigations: milestone
for membership and relations for edges, both orthogonal to parent; verify both APIs before fixing
the design; drive assignment and relation state from membership every cycle rather than firing once;
a separate mapping store; explicit provider capability gating; and batched, non-blocking, best-effort
delivery.

## Proposed Changes

1. **Verify the Linear API first** — milestone create/assign mutations and `issueRelationCreate`,
   including duplicate and cross-project behaviour. The design follows the result.
2. **A mission→milestone mapping store**, separate from the plan tables.
3. **Milestone lifecycle**: created on demand when a mission first has a synced member; members
   assigned and unassigned to follow membership; marked complete rather than deleted when the
   mission ends.
4. **Dependency relations**: `plan_dependencies` rows mirrored as `blocks` relations, outbound only,
   with removal as reliable as creation.
5. **Capability gating** in `RemoteProvider` so Notion and ClickUp degrade to no mission
   representation rather than a partial one.
6. **Exclude milestones and mission issues from plan ingestion**, by explicit link rather than name
   match.
7. **Update `switchboard-remote/SKILL.md`**, whose "what the tracker cannot show you" section
   currently lists missions first and will be wrong for Linear.

### Migration

Additive. New mapping store only; `plans`, `missions` and `mission_members` are untouched. No
behaviour change for installs without Linear or with mission sync disabled.

## Verification Plan

1. **The phone test.** With two cards staged into one mission, open Linear on a phone and see both
   under one milestone, with any blocking relation drawn.
2. **No parent collision.** Stage a card that is already a feature subtask; assert its feature
   parent is intact **and** its mission milestone is set. This is the test the whole design exists
   to pass.
3. **Membership follows reality.** Remove a card from a mission; assert it is unassigned from the
   milestone in the same cycle, not left showing stale membership.
4. **Relations follow reality.** Delete a `plan_dependencies` row; assert the Linear relation is
   removed. An enforced-nowhere block that Linear still draws is the worst failure mode here.
5. **Mission end.** End a mission; assert the milestone is marked complete and not deleted, and that
   its members' history is intact.
6. **Not ingested.** Assert no milestone and no mission issue produces a plan file or a board card.
7. **Providers degrade.** Run the same flow on Notion and ClickUp; assert no partial state and no
   errors, and that the skill's stated behaviour matches.
8. **Volume.** Stage a mission with many members; assert batching, and that the plan sync it rides
   on is not delayed or failed by it.
9. **Two hosts.** Sync one board from two hosts; assert one milestone and no duplicate relations.
10. **Existing installs.** With mission sync off or no Linear setup, assert byte-identical
    behaviour to today.
