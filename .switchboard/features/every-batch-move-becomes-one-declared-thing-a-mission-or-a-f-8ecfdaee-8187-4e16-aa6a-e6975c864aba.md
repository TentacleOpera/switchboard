# Every Batch Move Becomes One Declared Thing — a Mission or a Fan-Out Pipeline

**Complexity:** 5

## Goal

A batch move means the same thing on every team: Feature, Coding and Multi-agent planning batches become a mission on the existing mission card, delivered at the team cadence (5 with drive assistance / 1 / 1); Planning and Review fan out in ceil(plans/seats) rounds with nothing dropped. Missions pause and resume, and own their members' columns while a single plan still routes by complexity.

**One mission is one card.** A mission card represents exactly one mission and
never more. A plan may be a member of two missions when they act at different,
consecutive stages — a coding mission and a review mission — and it then appears
as a member of each, on that mission's own card. It does not put two missions on
one card, and a card never shows a plan twice.

*This feature file is self-contained: the full argument, the constraints that
bind every subtask, and the invariants the whole feature is judged against are
below. Each subtask plan is also self-sufficient on its own scope, and where a
subtask's plan and this summary disagree, **the subtask plan wins** — it is the
source of truth for the seat implementing it.*

## Problem analysis

> **Correction, 2026-09-20.** An earlier draft of this plan proposed building
> impromptu missions and a mission card as new work. **That was wrong and the
> operator caught it.** STAGING is already a mission container with a rendered
> mission card, and the drain already pops one member at a time. The real gap is
> much narrower: a batch move to a team column bypasses all of it, and the drain
> has no per-team cadence. The changes below are written against what exists.

### What already exists — do not rebuild any of it

- **Staging a card creates or joins a mission.** `stageForQueue`
  (`KanbanProvider.ts:3161`) calls `resolveOrCreateOpenMission`
  (`KanbanDatabase.ts:~11700`) and appends a `queue_position`.
- **The mission card is on the board.** `.kanban-card.mission-card` with its
  `.mission-badge` (`kanban.html:2418`), and members are hidden **inside** it:
  `displayCards.filter(card => !card.featureId && !(card.missionId && card.column === 'STAGING'))`
  (`:5021`). The card lives in STAGING.
- **Launch drains it.** `launchMission` (`KanbanProvider.ts`) calls
  `apiServer.dispatchNextFromQueue`, which pops **one member at a time** under a
  serialised chain (`_runQueuePop`) and already takes
  `pacing: 'head' | 'seat'` — *"explicit override; else team field → 'head'"*.
- `missions` carries a `team` column, `mission_members` distinguishes
  `plan` from `feature`, and a team held by a mission already renders **HELD** in
  the command view's roster.

So "a batch becomes a mission with a card, drained one at a time, holding its
team" is **already built**. The Coding team's requested behaviour is close to
what the drain does by default.

### Gap 1 — a batch move to a team column never reaches any of it

Only a move to **STAGING** stages. A batch move to a team's own column
(PLAN REVIEWED / LEAD CODED / CODER CODED / CODE REVIEWED) goes straight down
the dispatch path, creating no mission and no card. Batch behaviour is keyed on
the **target column's role** (`_columnToRole`), not on the team, which is why the
results are arbitrary. Verified 2026-09-20:

| team | head role | column | what a batch does today |
| :--- | :--- | :--- | :--- |
| Planning | `planner` | PLAN REVIEWED | fans out one card per live planner seat — **and drops the rest** |
| Multi-agent planning | `planner` | PLAN REVIEWED | same code path; separated only by `automatedDispatch: 'head-only-when-sole'` |
| Feature | `lead` | LEAD CODED | the only real contract: `driveMode` + `batchMode` + `_buildBatchDrivePrefix`, capped at `TEAM_BATCH_PLAN_CAP = 5` |
| Coding | `coder` | CODER CODED | **nothing fires.** One prompt listing every plan, uncapped |
| Review | `reviewer` | CODE REVIEWED | **nothing fires.** One prompt listing every plan, uncapped |

### What the Feature team's drive prompt actually says

Change 2 keeps `_buildBatchDrivePrefix` for the Feature team, so here is the
contract being kept, verbatim from `KanbanProvider.ts:6650`:

> **STAGING (one call per plan):**
> `node "<cliPath>" verb ptySendPrompt '{"name":"<seat>","data":"Implement the plan at <path>…","dispatch":{"planId":"<id>","role":"coder"}}'`
>
> **REVIEW:** On callback, review git diff — not the coder's self-report…
> **Escalate after two failures on the same plan: intern → coder → lead.**
>
> **CLOSE OUT EVERY PLAN — ALWAYS, no judgement call.** … run
> `node "<cliPath>" accept --plan "<that plan's planId>"` … Nothing downstream
> happens until you accept.

It is lead-driven orchestration by hand, and it is kept **only** for the Feature
team, where a lead allocating across several coder seats is the team's design.
It must not be given to the Coding team, whose head prompt forbids exactly this.

The Feature team's other half — features proper — already has the managed
pipeline this plan generalises: rounds in `coding_rounds`, dispatched by
`_dispatchRoundCore`, with the lead's only verb being `accept --plan` and the
system closing the round, dispatching the next, and releasing the team once.

### Gap 2 — the remainder is silently dropped

`_distributePlannerDispatch`:

```ts
const plans = ordered.slice(0, terminals.length);
```

Move ten cards to Planned with three planner seats and **three are dispatched
and seven are not** — they sit in the column looking dispatched, with nothing
recording that most of the batch went nowhere.

### Gap 3 — the drain has no per-team cadence

`dispatchNextFromQueue` pops one. That is right for Coding and wrong for
Feature, which needs five in flight with its drive prompt, and wrong for
Planning and Review, which need a whole round of seats at once. `pacing`
(`head` | `seat`) is the nearest existing lever and does not express
"five" or "one per seat".

### Gap 4 — the cap protects exactly one team

`applyBatchCap` returns every plan when `isTeamHead` is false, and `isTeamHead`
is only ever true for a `lead` (`isCodingTeamHead` opens with
`if (role !== 'lead') return false;`). Coding and Review take unbounded batches.

### Gap 5 — Coding is handed work it is forbidden to distribute

Its head receives one prompt listing every plan, while its own prompt says
**"you must not use ptySendPrompt to hand it work"** and its purpose says *"two
seats and one plan"*. Review has the opposite defect: its head prompt tells it to
apportion work to reviewer seats, uncapped, with no drive contract.

### Gap 6 — a BATCH is complexity-routed card by card

`_resolveKanbanDispatchPreDelivery` (`LocalApiServer.ts:3491`) auto-routes by
complexity whenever no explicit column is given:

```ts
const auto = await this._options.resolveAutoDispatchColumn(
    workspaceRoot, record.complexity ?? null, Number((record as any).isFeature) === 1);
```

**For a single plan that is correct and stays.** Complexity routing is how a
cx-2 card reaches the Coding team's intern directly and a cx-7 card reaches a
lead. It is the mechanism that makes a cheap seat useful, and nothing here
weakens it.

**For a batch it is wrong**, because a batch now becomes a mission delivered at
the team's cadence. Routing its members individually scatters one mission across
three columns and contradicts the seat the team was going to give each one. The
codebase already records that exact failure, at `LocalApiServer.ts:6016`:

> a cx-2 subtask resolved INTERN CODED while the card sat at LEAD CODED … the
> move was refused, and the whole round reported a delivery error

and states the rule the team path follows:

> Keep the card where it is. A team decides who works what; complexity routing
> is the NON-team path.

That guard was applied to the team-round path only. A batch takes the general
path and is still routed card by card.

**Features ignore complexity already** — `resolveAutoDispatchColumn` takes
`isFeature` and returns the lead column before the band is read. Unchanged.

### Related work already on the board

- `the-staging-ack-promises-a-pickup-that-missions-will-not-do` — the remote ack
  promises an automatic pickup that manual mission launch does not provide.
  **This plan makes more batches into missions, so it makes that ack wrong more
  often.** Read them together.
- `memo-missions-cannot-be-opened-scoped-or-tested` — the mission card cannot be
  opened, its launch is not scoped to it, and nothing tests the mechanism. That
  is the card this plan puts in front of every batch, so its defects become
  load-bearing here.

## Constraints

**Reuse the mission container, the card and the drain.** They exist and work.
This plan routes more work into them and gives the drain a cadence; it does not
introduce a second mission object, a second card, or a second queue.

**No new launch gesture.** Whether a team-column batch launches immediately or
waits for a manual launch like STAGING does is the one behavioural choice here —
see Outstanding questions. Do not invent a third option.

**No hand-dispatch on the Coding team.** `ptySendPrompt`-to-a-seat was
deliberately removed from its head prompt. Nothing here may put it back.

**Nothing may be silently dropped.** Every plan in a batch is delivered or
visibly queued as a mission member, and the count is on the card.

**Derive the head-role gate.** `role === 'lead'` has been found in three places;
`7a78665b` fixed the pair-dispatch sites and `isCodingTeamHead` plus the batch
branch remain. Derive from the team definitions, as `pairDispatchingHeadRoles()`
does.

**Hold and release the team exactly once.** A pause must not read as a release.

**Derive the pipeline order; never hand-keep it.** Change 8 depends on stage
ordering, and a hand-kept copy of it has already shipped wrong once
(`_PIPELINE_POSITION`'s own comment records RESEARCHER and TICKET UPDATER both
ranked incorrectly, with a backward move read as forward — *"which dispatches"*).

**An explicit column still wins.** Disabling complexity routing for teams means
disabling the AUTO route. A dispatch that names its column — a drag, a
`targetColumn` — is the operator deciding, and stays honoured.

**Teams are unreleased dev work** — clean break, no migration.

## Goal invariants for the whole feature

- A batch move produces one declared thing: a mission, or a pipeline.
- Every plan is delivered or visibly queued. None is dropped.
- **One mission object, one mission card, one drain.** A mission card is never a
  view over two missions.
- A plan in two missions (different stages) is a member of each, on each
  mission's own card — never two missions rendered on one card.
- A team is held once and released once.

## Outstanding questions

- ~~Does a team-column batch launch immediately?~~ **Answered: it launches
  immediately.** A move to a team's own column is an instruction to start now.
  A card moved to STAGING still waits for a deliberate `launchMission`, so the
  two paths differ on purpose: STAGING is a parking area, a team column is a
  dispatch. `the-staging-ack-promises-a-pickup-that-missions-will-not-do` covers
  only the STAGING half and is unaffected.
- **Does the mission card need `memo-missions-cannot-be-opened-scoped-or-tested`
  fixed first?** That plan says the card cannot be opened and nothing tests the
  mechanism. This plan puts that card in front of every batch, so its defects
  stop being cosmetic. Likely a prerequisite rather than a parallel.
- ~~Does Multi-agent planning get the pipeline too?~~ **Answered:** it gets the
  mission treatment with a batch size of 1 (change 4), not the fan-out pipeline.
- ~~What happens when the operator stops the team mid-flight?~~ **Answered:** the
  mission pauses and resumes (change 6).

## Correction, 2026-09-20 — one card, one mission

The operator removed the "two missions may hold the same card at consecutive
stages" requirement from Mission 08 outright. It was never expressible anyway:
`mission_members` carries `CREATE UNIQUE INDEX idx_mission_members_member ON
mission_members(member_id)` (`KanbanDatabase.ts:777`, added by V65), so a card is
a member of at most one mission and a second claim is silently swallowed by
`INSERT OR IGNORE`. Mission 08 is rewritten around **one card, one mission**: a
claim transfers the card and records the removal on the mission that lost it, and
"no stage skipping" survives as a **release** gate — a mission may not deliver a
card that is not in the stage immediately before its own. This also removes the
"two coding missions" collision from the design entirely: there is one coding
stage, so there is one coding mission.

## Reconciled shared surfaces

Every symbol touched by more than one subtask, and the single end-state the set
implements. A coder working any one plan implements to this column, not to a
second interpretation.

| Shared surface | Subtasks | Reconciled end-state |
| :--- | :--- | :--- |
| `dispatchNextFromQueue` / `_runQueuePop` (`LocalApiServer.ts:3972`, `:4012`) | 01 scope, 04 waves, 06 release column, 07 pause, 08 no-skip hold | One pop function, extended once: an optional `missionId` scopes candidates to that mission's members; the cadence (team field) decides how many release; a release is one dispatch (N=1) or one batch dispatch (N>1); the release column is the mission's stage column, passed as an explicit column; a paused mission releases nothing; a member not in the stage before the mission's stage is held with a reason. Ordering: **01 → 04 → 06 → 07 → 08**. |
| `launchMission` (`KanbanProvider.ts:16705`) | 01, 03 | Scoped to the launched mission's members (01) **and** resolved to the mission's own team head from `missions.team` (03). The two are one change: a scoped launch that still picks `leads[0]` launches the wrong team's work. |
| `stageForQueue` / `resolveOrCreateOpenMission` / `addMissionMember` (`KanbanProvider.ts:9872`, `KanbanDatabase.ts:16741`, `:16711`) | 03, 08 | Staging keeps `stageForQueue` unchanged. A team-column batch creates a **new** team-bound mission (03) and claims its members through one `claimIntoMission` operation (08) that transfers a card out of any prior mission and records the transfer on both. |
| `mission_members` schema | 08 | `UNIQUE(member_id)` stays; one card, one mission. No schema change for this rule. |
| `missions` schema | 03 `team`, 07 `paused` | `team` exists and is written by `createMission`/`updateMission`. `paused INTEGER DEFAULT 0` is added by 07 — pause cannot be derived (`runState` is derived, `ready` is arm-ness). |
| `isCodingTeamHead` + its call sites (`KanbanProvider.ts:6928`, `:7003`, `:7578`; `TaskViewerProvider.ts:8829`; `bootstrap.ts:3623`) | 02, 03, 05 | One derived head-role set (all team `headRole`s + live group rows), **not** `pairDispatchingHeadRoles()` (which excludes `reviewer` and `planner`). Four literal `'lead'` sites replaced across both composition roots. |
| Batch dispatch decision (move handlers `KanbanProvider.ts:13101`/`:13230`/`:10559`, `_distributePlannerDispatch:8434`, `bootstrap.ts:3623`) | 02, 03, 05 | One resolver, `resolveBatchTeam`, decides `mission` / `fanout` / `plain` from the target column's role, the live team's `automatedDispatch` policy and the plan count. 03 owns the `mission` branch (Feature, Coding, Multi-agent planning), 05 owns the `fanout` branch (Planning `pool`, Review). Both roots call it. |
| Complexity routing (`resolveAutoDispatchColumn` `KanbanProvider.ts:10940`, `_resolveKanbanDispatchPreDelivery` `LocalApiServer.ts:3452`) | 06 | Single-plan dispatch and non-mission pops are unchanged. A mission release passes the mission's stage column as an explicit column — the same precedence an operator drag uses. No new flag. |
| Stage/column derivation (`_PIPELINE_POSITION:10588`, `_isColumnBefore:10603`, `_isParallelCodedLane:8974`, `_columnToRole:16468`) | 06, 08 | One `resolveMissionStage(mission)`: team → `headRole` → column → stage (coded lane collapsed). 08 owns it; 06 consumes it. No second ranking, no second team→column map. |
| Mission card (`kanban.html:2418`, members hidden at `:5021`) | 03, 07, 08 | One card, one render site: 03 puts batches on the existing card, 07 adds a `PAUSED` state distinct from unarmed, 08 adds a held-member reason. Three states, one element, never collapsed into one another. |
| Completion-driven advance (`completeCardInternal` `LocalApiServer.ts:4669`, `queue/done` `:4436`, `_dispatchRoundCore` `:5951`) | 04, 05 | One rule: a wave/round advances when every card it dispatched has asserted completion, enqueued on `_queueNextChain`. The team's `completionAuthority` decides *who* asserts, never *how* the advance is detected. |

## How the Subtasks Achieve This

- **Mission 01 — A Launch Touches Only Its Own Members**: makes the queue pop mission-scoped, so the mission container this feature routes batches into can be launched without reaching another mission's cards — the precondition every later subtask is verified against.
- **Mission 02 — One Derived Gate for "Is This a Team Head"**: replaces the four `role === 'lead'` literals with one derived head-role set, so the Coding, Review and planner-headed teams are recognised as teams at all — without it the batch routing keys on a gate that is false for exactly the teams this feature is about.
- **Mission 03 — A Batch Move to a Team Creates a Mission and Launches It**: turns a batch move to a team column into one declared thing — a new team-bound mission, claimed one member per plan, launched immediately — and fixes `launchMission` to dispatch to that mission's own team's head.
- **Mission 04 — The Drain Delivers at the Team's Cadence**: gives the drain a per-team release rate (Coding 1, Feature 5 with its drive prompt, Multi-agent planning 1) as one batch dispatch per wave, so the mission's remainder is released rather than skipped.
- **Mission 05 — Planning and Review Fan Out in Rounds, and Nothing Is Dropped**: registers a Planning or Review batch as `ceil(plans / seats)` durable rounds and advances them on asserted completion, so the plans the fan-out used to leave behind are delivered.
- **Mission 06 — A Mission Owns Its Members' Columns; a Single Plan Still Routes**: stops per-card complexity routing at mission release and passes the mission's stage column explicitly, while leaving single-plan routing — and the cheap-seat mechanism it enables — exactly as it is.
- **Mission 07 — A Mission Can Be Paused and Resumed**: adds a stored pause that stops the drain without releasing the team or losing the queue order, and resumes from the next undelivered member, so a batch survives an operator stop and a host restart.
- **Mission 08 — One Mission per Stage, and No Card Skips a Column**: states one card / one mission (enforced by the existing unique index), makes a claim transfer the card and record it on both missions, derives the mission's stage once from `_PIPELINE_POSITION`, and holds — visibly — any member that would skip a stage.

## Dependencies & sequencing

- **01 lands first.** It is the smallest change and every other subtask's verification assumes a launch cannot reach another mission's cards. 04 in particular multiplies the leak by its cadence.
- **02 lands before 03 and 05.** Both route on the derived team-head gate; landing them first means routing on a gate that answers `false` for coder- and reviewer-headed teams.
- **03 lands before 04, 06, 07, 08.** It creates the mission, sets `missions.team` (which 06 and 08 derive the stage column from) and launches it. Without it there is no mission for the drain to release from.
- **08's stage derivation lands before or with 06.** 06 consumes `resolveMissionStage`; computing it in two places is the drift this feature explicitly forbids. If they must be split, land 08's derivation first.
- **04 and 05 are independent of each other** (different teams, different machinery) but share one advance rule; whichever lands second adopts the first's rule rather than writing a second.
- **07 is independent of 04/05/06/08 in code** but depends on 01's mission-scoped filter for its pause check to live in the right place.
- **Open prerequisite (not a subtask of this feature):** `memo-missions-cannot-be-opened-scoped-or-tested` — its finding 2 is Mission 01, but its other findings (the mission card cannot be opened, `getMissions` is unbounded on every refresh, and nothing tests the board mechanism) are not covered here. This feature puts that card in front of every batch, so those defects stop being cosmetic. **Decide whether it lands before this feature or alongside it** — the feature file's Outstanding Questions already flags it as likely a prerequisite rather than a parallel.
- **Session scope applied, not transcribed:** teams are unreleased dev work, so every subtask takes a clean break — no migration shims, no compat paths.

## Team Dispatch Instructions

### Mission 01 — A Launch Touches Only Its Own Members

- **Seat:** coder (complexity 4).
- **Acceptance:** two missions queued, launching A dispatches only A's members (asserted with B's card first in workspace order); a mission with no eligible member returns `dispatched: null` naming the mission; an unscoped `queue/next` pop behaves exactly as HEAD; no member is dispatched twice by one launch.
- **Must not touch:** `launchMission`'s head selection (Mission 03 owns it); the unscoped pop's candidate set; `queue-pipeline-contract.test.js` expectations.

### Mission 02 — One Derived Gate for "Is This a Team Head"

- **Seat:** coder (complexity 4).
- **Acceptance:** the gate returns true for the Coding `coder` head and the Review `reviewer` head, false for a role heading no team; no call site passes a literal `'lead'` (grep gate); the Feature team's existing lead assertions still pass; both composition roots call the derived predicate.
- **Must not touch:** `pairDispatchingHeadRoles()` or any pair-dispatch path; the `plans.length > 1` guard on the batch branch.

### Mission 03 — A Batch Move to a Team Creates a Mission and Launches It

- **Seat:** coder (complexity 6).
- **Acceptance:** a batch to Feature or Coding creates exactly one mission with one member per plan, rendered on the existing card; it launches with no further operator gesture; the receiving team reads HELD; the launch head is the mission's team's head; no live team creates no mission; `PLAN REVIEWED` routes to `fanout` when a pool planner team is live.
- **Must not touch:** `stageForQueue` for team columns; `missions.team`'s arity; the mission card element; the `plain` path for single plans.

### Mission 04 — The Drain Delivers at the Team's Cadence

- **Seat:** lead coder (complexity 7).
- **Acceptance:** Feature twelve plans → five in flight then the next five on acceptance; Coding four plans → exactly one in flight with the intern's Band A half automatic; Multi-agent planning one at a time; a wave is one dispatch, not five; a stalled wave does not auto-release; a batch of five or fewer behaves as today.
- **Must not touch:** any timeout that silently releases a stalled wave; cadence constants inside `_runQueuePop`; the unscoped pop path.

### Mission 05 — Planning and Review Fan Out in Rounds, and Nothing Is Dropped

- **Seat:** coder (complexity 6).
- **Acceptance:** ten plans / three seats → four rounds with all ten dispatched (asserted on the count); Review behaves identically; a one-round batch matches HEAD; rounds survive a restart; round N+1 has no dispatch evidence until round N completes.
- **Must not touch:** a second rounds table (generalise `coding_rounds` instead); the rounds path's explicit-`keepColumn` dispatch; the wave advance rule once Mission 04 lands.

### Mission 06 — A Mission Owns Its Members' Columns; a Single Plan Still Routes

- **Seat:** coder (complexity 4).
- **Acceptance:** a lone cx-2 card still reaches the Coding intern (and the Feature band with no Coding team); a mission's members land in one stage column; features still ignore complexity; an explicit column and the escalation override both still win; an unresolvable team stage fails loudly.
- **Must not touch:** a `skipAutoRoute` flag; non-mission pops; the stage derivation (Mission 08 owns it); the rounds path's column handling.

### Mission 07 — A Mission Can Be Paused and Resumed

- **Seat:** coder (complexity 5).
- **Acceptance:** a paused mission delivers nothing and keeps its members and order; resume dispatches the next undelivered member, not the first; pause does not release the team and resume does not re-hold it; paused and unarmed are distinguishable on the card and in the row; pause survives a restart.
- **Must not touch:** `runState` (derived) as a place to express pause; `launchMission` on resume; a second card element.

### Mission 08 — One Mission per Stage, and No Card Skips a Column

- **Seat:** coder (complexity 5).
- **Acceptance:** a card is never in two missions (a second claim transfers and records the removal); a review mission holding a CREATED card delivers nothing and says why, while a coded card delivers; the ordering comes from `_PIPELINE_POSITION` with no second ranking; an unresolvable mission team refuses to release loudly.
- **Must not touch:** a second stage ranking or a second team→column map; the mission card element; the unique index on `mission_members(member_id)`.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Mission 01 — A Launch Touches Only Its Own Members](../plans/mission-01-a-launch-touches-only-its-own-members.md) — **PLAN REVIEWED** — ID: d45d58bb-59e3-48b0-94b2-c3496b33731c
- [ ] [Mission 02 — One Derived Gate for "Is This a Team Head"](../plans/mission-02-one-derived-gate-for-is-this-a-team-head.md) — **PLAN REVIEWED** — ID: 614269ec-a5d2-412d-aa68-6f93e1e1b836
- [ ] [Mission 03 — A Batch Move to a Team Creates a Mission and Launches It](../plans/mission-03-a-batch-move-to-a-team-creates-a-mission-and-launches-it.md) — **PLAN REVIEWED** — ID: eaba9825-3fcd-4623-8452-2232e6dd92f5
- [ ] [Mission 04 — The Drain Delivers at the Team's Cadence](../plans/mission-04-the-drain-delivers-at-the-teams-cadence.md) — **PLAN REVIEWED** — ID: bf7a7c18-e8ff-4e4d-935e-f73eb3df250c
- [ ] [Mission 05 — Planning and Review Fan Out in Rounds, and Nothing Is Dropped](../plans/mission-05-planning-and-review-fan-out-in-rounds-and-nothing-is-dropped.md) — **PLAN REVIEWED** — ID: f6d3e138-828f-442c-8f1f-2c6de58c116d
- [ ] [Mission 06 — A Mission Owns Its Members' Columns; a Single Plan Still Routes](../plans/mission-06-a-mission-owns-its-members-columns.md) — **PLAN REVIEWED** — ID: 2839dbea-8395-456e-b4dc-7d595caeb0af
- [ ] [Mission 07 — A Mission Can Be Paused and Resumed](../plans/mission-07-a-mission-can-be-paused-and-resumed.md) — **PLAN REVIEWED** — ID: 4f6de297-19f4-43a7-aaf4-3839196956c6
- [ ] [Mission 08 — One Mission per Stage, and No Card Skips a Column](../plans/mission-08-one-mission-per-stage-and-no-card-skips-a-column.md) — **PLAN REVIEWED** — ID: 4a2078e4-a21b-49ce-9b6b-06320bb975b7
<!-- END SUBTASKS -->


## Completion Summary

Feature reviewed against HEAD (`src/`, 2026-09-20) and every subtask rewritten in
place: all eight now carry Metadata, User Review Required, Complexity Audit,
Edge-Case & Dependency Audit, Dependencies, Adversarial Synthesis, Proposed
Changes, Verification Plan with Goal Invariants, and their original Constraints.
No plan was merged, split, created or deleted — the set stays eight, because the
units are genuinely distinct (scope, gate, routing, cadence, rounds, column
ownership, pause, stage rule) even where they touch one function.

Reconciliation produced one shared-surface map (recorded above) and five
corrections that a coder would otherwise have got wrong: the head-role set must
be all team headRoles, **not** `pairDispatchingHeadRoles()` (which excludes
`reviewer` and `planner`); a team-column batch must **create** a team-bound
mission rather than reuse `stageForQueue`/`resolveOrCreateOpenMission`; a Feature
wave is **one** batch dispatch, not five pops; `launchMission` must resolve its
head from `missions.team`, not from `leads[0]`; and pause must be **stored**,
because `runState` is derived and `ready` is arm-ness. Mission 08 is rewritten to
the operator's 2026-09-20 decision — **one card, one mission**, which the
existing `UNIQUE(member_id)` index already enforces — with "no stage skipping"
kept as a release gate.

Sequencing: 01 → 02 → 03 → (08's stage derivation with 06) → 04/05/07. The open
prerequisite is `memo-missions-cannot-be-opened-scoped-or-tested`: finding 2 is
Mission 01, the other four findings are not covered by this feature and the
mission card they concern becomes load-bearing here.
