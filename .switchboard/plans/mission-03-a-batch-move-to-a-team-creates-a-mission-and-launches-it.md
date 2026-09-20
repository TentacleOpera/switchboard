# Mission 03 — A Batch Move to a Team Creates a Mission and Launches It

Subtask of the feature **Every Batch Move Becomes One Declared Thing — a Mission or a Fan-Out Pipeline** (`8ecfdaee`). The feature file carries the full argument and the constraints binding every subtask. This plan is self-sufficient on its own scope and, where the two disagree, **this plan wins** — it is the source of truth for the seat implementing it.

## Goal

A batch move to the Feature, Coding or Multi-agent planning team becomes a
mission, rendered on the existing mission card, and launches immediately.

## What already exists — do not rebuild it

- `stageForQueue` (`KanbanProvider.ts:3161`) calls `resolveOrCreateOpenMission`
  and appends a `queue_position`.
- The mission card already renders: `.kanban-card.mission-card` with its
  `.mission-badge` (`kanban.html:2418`), members hidden inside it
  (`:5021`).
- `missions` carries a `team` column; a held team already reads **HELD** in the
  command view.

Only a move to **STAGING** currently stages. A batch move to a team's own column
bypasses all of it.

### Verified against HEAD (2026-09-20)

**Where a batch move to a team column goes today.** The webview's
`moveSelected`/`moveAll` handlers resolve `role = this._columnToRole(nextCol)`
(`KanbanProvider.ts:13101`, `:13230`, and the explicit-target branch at
`:10559`), then:

- `role === 'planner'` → `_distributePlannerDispatch` (`:8434`) — the fan-out
  that drops the remainder (Mission 05).
- any other role → `_advanceCards` → `triggerBatchAgentFromKanban`
  (`:10509`, `:10564`) → the batch prompt builder (`:7578`), uncapped for
  non-`lead` heads (Mission 02).
- the standalone host has its **own** batch arm (`bootstrap.ts:3623-3645`), with
  its own `targetRole === 'lead'` gate and its own cap.

**Why `stageForQueue` cannot be reused verbatim.**

- `_resolveStageablePlanIds` (`:9834-9864`) refuses any card not in
  `CREATED | BACKLOG | PLAN REVIEWED | STAGING`, and refuses subtasks. A batch
  being intercepted *before* its column move is stageable — but the guard is
  load-bearing and must stay: a card already dispatched must not be re-queued.
- `resolveOrCreateOpenMission` (`KanbanDatabase.ts:16741-16750`) returns the
  **most recently created `not-started` mission in the workspace**, whatever its
  team or stage. Joining it would put this batch's cards into a mission that may
  belong to another team — the exact cross-contamination Mission 01 exists to
  prevent, one layer up.

**What is already available for the new path.**

- `createMission` accepts `team` and `ready` (`KanbanDatabase.ts:16643-16676`),
  and `updateMission` can set either later (`:16678-16703`).
- `addMissionMember` / `removeMissionMember` exist (`:16711`, `:16719`).
- `launchMission` exists (`KanbanProvider.ts:16705`).

**The head-resolution gap.** `launchMission` builds its candidate heads from
`resolveCodingRolesFromGroups` — every live lead, then every live coder
(`:16740-16754`) — and pops to `candidateHeads[i]`. It never reads
`missions.team`. So a mission created for the Coding team can launch into the
Feature team's lead. Scoping the *members* (Mission 01) is not enough; the
*head* must come from the mission's team.

## Metadata

- **Tags:** backend, feature
- **Complexity:** 6
- **Feature:** 8ecfdaee-8187-4e16-aa6a-e6975c864aba

## User Review Required

No — the one behavioural choice this plan contained (does a team-column batch
launch immediately, or wait for a manual launch?) was answered by the operator:
**it launches immediately**, and this plan records that decision. A card moved
to STAGING still waits for a deliberate `launchMission`, because STAGING is a
parking area and a team column is a dispatch.

## Complexity Audit

### Routine

- Creating the mission (`createMission({ workspaceId, team, ready: true })`)
  and claiming members (`addMissionMember`), both existing methods.
- Setting `missions.team` to the receiving team's definition id.
- The card and the members-hidden render already exist; nothing new is drawn.

### Complex / Risky

- **Two composition roots.** The batch interception point is duplicated:
  `KanbanProvider._advanceCards`/`_distributePlannerDispatch` (shared, used by
  the extension) **and** `bootstrap.ts:3623-3845` (standalone's own arm, which
  does not go through `_advanceCards`). A change in one root only is a
  divergence with no gate (AGENTS.md).
- **Which team receives a `PLAN REVIEWED` batch.** `planning-team` and
  `multi-agent-planning` both have `headRole: 'planner'`
  (`teamWiring.ts:1018`, `:1167`) and both work `PLAN REVIEWED`; they are
  separated only by `automatedDispatch` (`'pool'` vs `'head-only-when-sole'`,
  `:1051`, `:1210`) and by liveness
  (`resolveAutomatedDispatchExclusions`, `:758-837`). The routing decision must
  read that policy, not the column. **Multi-agent planning ships
  `enabled: false`** (`:1202`) and its own trigger text says it "never takes
  work automatically" — so the mission branch is reachable only when it is
  switched on and is the sole live planner-headed team. Mission 05 owns the
  `'pool'` (rounds) branch; this plan owns the `'head-only-when-sole'` (mission)
  branch. **One shared resolver decides which branch**, and both plans must call
  it.
- **No live team.** A batch moved to `CODER CODED` with no Coding team seated
  must **not** create a mission that nothing can launch; it keeps today's
  behaviour (the plain batch dispatch). Creating a mission for a team that does
  not exist would be the fallback-that-looks-like-a-value failure in a new
  place: an operator sees a mission card and a HELD team that is not there.
- **Immediate launch has no gesture.** `launchMission` currently dispatches to
  `min(streams, candidateHeads.length)` heads. For a mission with N members and
  one team, `streams` must resolve to that team's head, not to "however many
  leads happen to be live".

> **Superseded:** "Route a batch move to a Feature / Coding / Multi-agent team
> through the same path STAGING takes, with `team` set to the receiving team and
> one member per plan."
> **Reason:** "the same path STAGING takes" resolves to `stageForQueue`, and
> `stageForQueue` does two things this plan must not do: it calls
> `resolveOrCreateOpenMission`, which joins *any* open mission in the workspace
> (possibly another team's), and it takes no team argument at all
> (`KanbanProvider.ts:9872-9876`), so "with `team` set to the receiving team" has
> no parameter to travel on.
> **Replaced with:** a dedicated **claim** path for team-column batches —
> create a **new** mission with `team` and `ready: true`
> (`createMission`, `KanbanDatabase.ts:16643`), claim one member per plan
> (Mission 08 owns the claim semantics), then call `launchMission`. Staging
> keeps `stageForQueue`; a team column does not stage, it dispatches.

## Edge-Case & Dependency Audit

**Race Conditions**

- A batch move and a STAGING drag landing together: the batch creates a new
  mission and must not join the one the drag is filling. Creating (never
  resolving) the mission closes this.
- Two batches to the same team in quick succession: two missions, two launches.
  That is the intended shape ("one declared thing" per batch) and is safe only
  once Mission 01 scopes each launch — **M01 lands before M03**.
- `launchMission` is not serialised on `_queueNextChain` itself, but each pop it
  makes is (`LocalApiServer.ts:3991-3999`). The create→claim→launch sequence
  must complete before the pop chain runs, or a pop can see a half-built member
  set.

**Security**

- No new trust boundary. The batch arrives through the existing board-move path
  (webview message or `POST /kanban/move`); the team id is a definition id read
  from config, not from the request.

**Side Effects**

- A new mission row per team-column batch. The board's mission query
  (`getMissions`) is already a known cost (see
  `memo-missions-cannot-be-opened-scoped-or-tested` finding 3) and this plan
  increases the number of missions; that finding is **not** fixed here, and this
  plan should not pretend it is.
- Cards in the batch move to `STAGING` (their mission's home) instead of the
  team's column. A card that was in `PLAN REVIEWED` and is claimed by a Coding
  mission moves to `STAGING`; its column thereafter changes as the mission
  releases it (Mission 06/08).
- The status message the move posts must name the mission and the member count,
  so the operator sees one declared thing rather than N moved cards.

**Dependencies & Conflicts**

- **Mission 01 (blocker).** The launch must be scoped to the new mission.
- **Mission 02 (blocker).** The interception is keyed on the derived team-head
  gate; without it the Coding/Review heads are not recognised as heads.
- **Mission 04.** The cadence of the launch (how many members release per wave)
  is M04's; this plan creates and launches, M04 decides the rate. Landing M03
  with the drain still popping one member at a time is coherent — a Feature
  batch would then deliver one at a time instead of five, which is a behaviour
  M04 fixes, not a break.
- **Mission 05.** The `PLAN REVIEWED` split between mission (this plan) and
  rounds (M05) must be one resolver. Whichever lands second must call the
  first's resolver rather than re-deriving the branch.
- **Mission 06.** A mission member's release column is M06's; without it the
  first release complexity-routes the member out of its team's stage.
- **Mission 08.** Claim semantics (a card belongs to one mission) are M08's; this
  plan calls the claim operation it defines.

## Dependencies

- `two-teams-can-share-a-head-role-and-routing-decides-between-them` — its
  routing ladder's rung 1 is `missions.team`, and it names the same gap this
  plan closes (`launchMission` must resolve the head from the mission). Read
  together; this plan sets `missions.team` and reads it for the launch head,
  that plan generalises the ladder.
- `a-mission-carries-many-teams-and-missions-team-cannot-express-it` — a mission
  carries one team today and a batch-mission has exactly one; no conflict, and
  this plan must not widen `missions.team` itself.
- `memo-missions-cannot-be-opened-scoped-or-tested` — the card this plan puts in
  front of every batch is that plan's subject; its remaining findings are a
  prerequisite the feature file already flags.

## Adversarial Synthesis

Key risks: the interception is duplicated across two composition roots; the
`PLAN REVIEWED` column is claimed by two planner-headed teams that only
`automatedDispatch` and liveness separate; and `launchMission` picks heads
workspace-wide, so a team-bound mission would launch into another team. All
three are silent failures. Mitigations: one shared "which team receives this
batch" resolver called by both roots and both planner plans; create (never
join) the mission so the team is unambiguous; resolve the launch head from
`missions.team`; and create no mission when no team owns the column.

## Proposed Changes

### 1. One resolver: does this batch move belong to a team? (`src/services/KanbanProvider.ts`, beside `_columnToRole`)

- **Logic:** `resolveBatchTeam(workspaceRoot, targetColumn, planCount)` returns
  `{ kind: 'mission' | 'fanout' | 'plain', teamId?, headTerminal? }`:
  - `planCount === 1` → `plain` (a single plan keeps today's routing; Mission 06
    restates this).
  - the target column's role heads a **live** team (Mission 02's derived gate)
    → `mission` for the Feature (`lead`) / Coding (`coder`) / Multi-agent
    planning (`planner`, `head-only-when-sole`) teams.
  - the role heads the **`pool`** planner team → `fanout` (Mission 05).
  - no live team owns the role → `plain`.
- **Implementation:** team eligibility comes from
  `resolveAutomatedDispatchExclusions` (`teamWiring.ts:758`) plus the live group
  rows — the same source the dispatch pool already uses, never a second
  hand-kept list.
- **Edge cases:** a reviewer-headed Review batch is `fanout` (Mission 05), not
  `mission` — Review's seats read plans, they do not write them, and its head
  prompt already apportions work.

### 2. `mission`: create, claim, launch (`src/services/KanbanProvider.ts`, at both batch arms)

- **Context:** the two arms are the shared `_advanceCards`/`_distributePlanner`
  path and `bootstrap.ts:3623-3845`.
- **Logic:**
  1. `db.createMission({ workspaceId, team: teamId, ready: true, goal: '<n> plans from <source column>' })`
     — a **new** mission, never `resolveOrCreateOpenMission`.
  2. Claim each plan (Mission 08's operation): `STAGING` + `column_order` via
     the existing `appendQueuePositions` (`KanbanDatabase.ts:15137`, whose
     global-monotonic floor already keeps one mission's numbering from jumping
     another's), plus a mission-membership row.
  3. `launchMission(workspaceRoot, mission.id)`.
  4. Post one status message naming the mission and the member count.
- **Edge cases:** a claim that fails (a card already dispatched out of a
  stageable column, a subtask) is refused **visibly** and the plan stays put —
  the same refusal shape `stageForQueue` returns (`staged`/`refused` counts,
  `:9872`). Partial success is reported per card, never as a bare count.

### 3. `launchMission` resolves its head from the mission's team (`src/services/KanbanProvider.ts:16740-16754`)

- **Logic:** when `mission.team` is a non-empty definition id, resolve that
  team's head terminal (via the live group rows) and use it as the single
  candidate head; `streams` is then 1 per team head and the wave cadence
  (Mission 04) decides how many members release.
- **Edge cases:** `mission.team` empty (a STAGING-assembled mission) keeps
  today's candidate logic byte-for-byte. A team whose head is not live fails
  loudly ("No coding terminal is live — seat a team before launching", the
  existing error at `:16753`), never silently launching into another team.

### 4. No team → no mission

- **Logic:** the `plain` branch is today's code path, unchanged. Do not create a
  mission for a role no live team owns.

## Verification Plan

### Automated Tests

- **A batch to Feature or Coding creates exactly one mission with one member per
  plan**, and the existing card renders it with members hidden inside —
  asserted against `.kanban-card.mission-card` + the `:5021` containment
  predicate, not a new card.
- **The mission launches without an operator action**; a STAGING move still
  waits for `launchMission` (assert both in one fixture).
- **The receiving team reads HELD** in the command view's roster.
- **The launch head is the mission's team's head**: with a Feature-team lead and
  a Coding-team coder both live, a Coding batch's first dispatch reaches the
  coder, not `leads[0]` (the failure mode `resolveCodingRolesFromGroups`
  produces today).
- **Both roots**: the standalone arm (`bootstrap.ts:3623`) and the extension arm
  create the same mission shape for the same batch — one contract fixture
  driven through each root, or a source-text assertion that both call the shared
  resolver.
- **No live team → no mission**: a batch to `CODER CODED` with no Coding team
  creates no mission row and takes the plain path.
- **`PLAN REVIEWED` disambiguation**: with only the pool planner team live the
  batch takes the `fanout` branch; with only Multi-agent planning live (and
  enabled) it takes the `mission` branch.

### Goal Invariants

- **Positive:** after a batch move to a team column, exactly one mission exists
  whose `team` is that team and whose member count equals the batch size.
- **Positive:** the mission is launched without any further operator gesture
  (member `owner_since`/dispatch evidence exists immediately after the move).
- **Negative:** no mission is created for a batch whose target column's role no
  live team heads.
- **Negative:** a `PLAN REVIEWED` batch never creates a mission while a `pool`
  planner-headed team is live (that is Mission 05's rounds branch).
- **Negative:** a batch does not join an existing open mission — a fresh mission
  id is created per batch.
- **Positive:** a single-plan move to the same column still routes exactly as
  HEAD (no mission).

## Constraints

**No hand-dispatch on the Coding team.** `ptySendPrompt`-to-a-seat was
deliberately removed from its head prompt; nothing here may put it back.

**Derive the pipeline order and the head-role set** — never hand-keep either.
`_PIPELINE_POSITION` shipped wrong once when it was hand-kept.

**Nothing may be silently dropped.** Every plan is delivered or visibly queued.

**Teams are unreleased dev work** — clean break, no migration shims.
