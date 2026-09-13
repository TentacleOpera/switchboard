# Milestones — long-term goals that cards belong to, and that a controller agent can read

<!-- board-collapse-01 -->
> **RESCOPED 2026-09-04 (Board Collapse 01).** **Do not reserve a migration number.** This plan claims V66; V66 is already the `mission_milestones` mapping table and the schema is at **V67**. Use "the next free migration version at implementation time".


## Goal

Add a **milestone**: a long-term goal, defined by the user or an agent, that cards
can be added to — by hand on the board or over HTTP. A milestone reports where its
cards currently sit on the board, can be marked complete by a user or an agent,
and is readable by the controller agent so it can decide which missions to build
next.

This plan is **state, API, and agent access**. The Milestones tab is
`milestones-tab-in-the-kanban-panel.md` and depends on this.

### Problem Analysis

**The board has four grouping concepts and none of them is a goal.**

| Concept | Storage | What it means |
|---|---|---|
| Project | `projects` table, `kanban.activeProjectFilter` | A board filter — *which cards am I looking at* |
| Feature | `plans.is_feature` + `plans.feature_id` | One deliverable's subtasks |
| Mission | `missions` + `mission_members`, Mission Control panel | An execution queue — *what runs next, by which team* |
| Worktree | `worktrees` table | Git isolation for in-flight work |

A feature is the closest and the wrong grain: it is one deliverable decomposed,
authored top-down, complete in itself. A long-term goal spans several unrelated
features plus loose plans, and is measured by *where its cards are* rather than by
decomposition. Nothing above spans columns, which is what a goal must do — its
cards are simultaneously in CREATED, CODED, and COMPLETED.

**Ordering is not a goal, and the difference is structural.** `column_order` is
cleared the moment a card changes column (`clearColumnOrder`,
grep `clearColumnOrder` in `KanbanDatabase.ts`: *"the number is per-column, so it
must not travel"*). A hand-arranged order is destroyed by the card progressing —
the one thing a long-term goal must survive.

**A milestone must not be a mission, and the schema is already inviting the
mistake.** `missions.type` is free text defaulting to `'mission'`
(grep `CREATE TABLE IF NOT EXISTS missions` in `KanbanDatabase.ts`,
`createMission` in the same file), so `type =
'milestone'` would "work" today with no migration. Refuse it:

- A mission is an **execution vehicle**: it carries `team`, `ready`, and
  `max_extra_worktrees`, and it is launched (`launchMission`,
  grep `launchMission` in `KanbanProvider.ts`). A milestone is **inert** — adding a card to one runs
  nothing.
- Sharing the table means every existing mission query grows a `type` filter
  forever, three columns are meaningless on half the rows, and the first bug is a
  milestone appearing in Mission Control's launch list as something someone can
  dispatch by accident.
- A mission is hours to days. A milestone outlives every mission run inside it.

**Missions need nothing from this plan, and nothing from Linear.** They remain
what they are: cards that trigger a launch when moved. That already works
remotely — `RemoteControlService` treats `STAGING` as a queueable target and
stages a remotely-moved card via `onStageForQueue`, so moving a card in Linear
stages it here. Composing a mission from Linear is therefore a matter of naming
cards in the mission card's text, or asking the Linear agent to do it over the
endpoints that already exist. **No Linear milestone mechanism is built, mapped,
or reserved by this plan** — for missions or for milestones.

### Root Cause

Every grouping in the board answers *what to work on next*. Nothing answers *what
this belongs to*, so long-term intent lives in the user's head and in plan prose,
where neither the board nor the controller agent can read it.

### Non-goals

- **Any Linear or ClickUp milestone sync.** Not built, not mapped, and
  deliberately **no** placeholder `linear_milestone_id` column — an unwritten
  column invites a half-implementation, and adding one later is one additive
  `ALTER`.
- **Changing missions in any way.** No new launch mechanism, no mission schema
  change, no mission/milestone link table.
- **Milestones driving execution.** No dispatch, no queueing, no column moves. A
  milestone informs the controller agent; it does not act.
- **Derived completion.** A milestone is complete when someone says so — see §3.
- **Nesting.** No milestones inside milestones. A goal containing goals is a
  project.
- **Date machinery.** `target_date` is stored and displayed if set. No overdue
  logic, no reminders, no date-driven sorting.
- **Confirm gates.** Per project rule, none.

## Metadata

**Complexity:** 5
**Tags:** feature, backend, database, api
**Feature:** debd9d87-d178-4caa-a059-3f7578d7f806

## User Review Required

None — the plan is self-contained and ready for implementation. The migration
version (V78) is determined by the current schema head (V77). The `total` vs
`byColumn` semantics, orphan-rejection location, and `project_id` filtering are
all specified in the Proposed Changes. No external decision is blocked.

## Complexity Audit

### Routine

- Two new tables mirroring the proven `missions` / `mission_members` shape — same
  columns, same join pattern, same `member_kind` discriminator.
- Nine HTTP routes mirroring `/kanban/mission/*` — same auth, same response
  shapes, same `_resolveDbForRoot` path.
- `setMilestoneOrders` reusing `setColumnOrders`' 1..N transaction shape.
- Orchestration skill edit — adding milestone routes to read/write tables and a
  "read milestones first" step in Workflow B.

### Complex / Risky

- **Feature-dedupe in `getMilestoneStatus`.** Resolving features to their subtask
  sets, subtracting directly-added subtasks already covered, and keeping `total`
  (member count) distinct from `byColumn` (card distribution) is the single most
  likely implementation bug. A wrong dedupe silently inflates every number the
  tab and the controller agent read — a fallback indistinguishable from a real
  value.
- **Orphan-rejection at the route layer.** The mission routes don't validate
  `memberId` existence; this plan adds that validation. The lookup must handle
  both plans and features (features are plans with `is_feature = 1`), and must
  run before the DB write.
- **`setMilestoneOrders` workspace validation.** Refusing a list containing ids
  that are not milestones of the given workspace — not writing positions for
  rows that do not exist.

## Edge-Case & Dependency Audit

- **Race Conditions:** A card moving columns while `getMilestoneStatus` is
  computing counts. Mitigated by deriving at read time — the status is a
  snapshot, not a cached value. A card that moves mid-read produces a
  momentarily inconsistent `byColumn`, but the next read is correct. No stored
  count can go stale.
- **Security:** All routes use the same auth as the mission block
  (`_checkAuth`). No new auth surface. The `complete` endpoint uses strict
  boolean validation (rejecting `"false"` strings) to prevent silent
  reopen/close — the same class of bug the star endpoint guards against.
- **Side Effects:** `deleteMilestone` removes join rows but never cards.
  `setMilestoneCompleted` changes no card columns or `completed_at`. No
  milestone operation causes anything to execute (no dispatch, no queue, no
  move). These are enforced by the plan's non-goals and verified by the
  "Milestones are not missions" test (spy on dispatch/queue/move paths, require
  zero calls).
- **Dependencies & Conflicts:** Independent of the three sibling plans on this
  branch (`agents-set-a-columns-card-order`, `agents-set-a-cards-priority-level`,
  `priority-as-a-native-field-and-a-board-wide-order-by`). Different state,
  different consumers, any order. The tab plan
  (`milestones-tab-in-the-kanban-panel.md`) depends on this plan's tables,
  routes, and derived status — it adds no state of its own.

## Dependencies

None. Independent of `agents-set-a-columns-card-order.md`,
`agents-set-a-cards-priority-level.md`, and
`priority-as-a-native-field-and-a-board-wide-order-by.md`.

## Adversarial Synthesis

Key risks: feature-dedupe silently inflating counts (`total` ≠ sum(`byColumn`)
is the trap), orphan join rows from unvalidated `memberId`, and
`setMilestoneOrders` writing positions for non-existent rows. Mitigations:
explicit `total`-vs-`byColumn` semantics in the plan, route-layer 404 lookup
before `addMilestoneMember`, and workspace-id validation in
`setMilestoneOrders` mirroring `setColumnOrders`. The two-table approach is
proven by `missions`/`mission_members`; the derived-status approach avoids the
stale-count trap. The plan's non-goals (no Linear sync, no nesting, no
date machinery, no derived completion) are correctly scoped and prevent scope
creep into Mission Control's execution surface.

## Proposed Changes

### 1. `src/services/KanbanDatabase.ts` — two tables (V78)

> **Superseded:** Two tables (V66)
> **Reason:** V66 is already the `mission_milestones` mapping table (`KanbanDatabase.ts:1006`). The schema head at the time of this revision is **V77**; the next free migration version is **V78**. The Board Collapse 01 note already corrected the prose to "the next free migration version at implementation time" — this fixes the section header and SQL block comment to match.
> **Replaced with:** Two tables (V78) — `MIGRATION_V78_SQL`.

Mirror `missions` / `mission_members`, which already proves the two-table
membership shape in this schema, including a `member_kind` distinguishing plans
from features (`KanbanDatabase.ts:519-536`, used at `LocalApiServer.ts:6342`).

> **Line-reference drift:** All line numbers in this plan were accurate at
> planning time. The codebase has grown since; every cited line is now stale by
> roughly 30-50%. The coder should grep for the named symbols, not navigate by
> number. The symbol names are stable; the numbers are not.

```sql
CREATE TABLE IF NOT EXISTS milestones (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    description  TEXT DEFAULT '',
    target_date  TEXT DEFAULT NULL,    -- ISO date, optional, display only
    project_id   INTEGER DEFAULT NULL, -- NULL = board-wide
    sort_order   INTEGER DEFAULT NULL,
    completed_at TEXT DEFAULT NULL,    -- set by a user or agent, never derived
    workspace_id TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS milestone_members (
    milestone_id TEXT NOT NULL,
    member_id    TEXT NOT NULL,
    member_kind  TEXT NOT NULL,        -- 'plan' | 'feature'
    PRIMARY KEY (milestone_id, member_id)
);
CREATE INDEX IF NOT EXISTS idx_milestone_members_member ON milestone_members(member_id);
```

Added to `SCHEMA_TABLES_SQL` for fresh DBs **and** as an idempotent
`MIGRATION_V78_SQL` block for existing installs, following the V63/V64 pattern
(grep `MIGRATION_V63_SQL` / `MIGRATION_V64_SQL`). No change to `plans` —
membership lives in the join table, so no existing row is rewritten. This is new
state that has never shipped, so it takes a clean break; the migration block is
still required so existing installs converge on the same shape a fresh DB gets.

**Methods:** `getMilestones`, `getMilestoneById`, `createMilestone`,
`updateMilestone`, `deleteMilestone`, `setMilestoneCompleted`,
`addMilestoneMember`, `removeMilestoneMember`, `getMilestoneMembers`,
`setMilestoneOrders` (reusing `setColumnOrders`' 1..N single-transaction shape
— grep `setColumnOrders` in `KanbanDatabase.ts` — rather than inventing a second
ordering idiom). `setMilestoneOrders` **must validate** that every id in the
ordered list is a milestone of the given workspace, and refuse the write if any
id is not — mirroring `setColumnOrders`' own validation that all ids are plans of
the workspace. Writing positions for rows that do not exist is the bug this
prevents.

`deleteMilestone` removes the goal and its join rows and **never a card**. Say it
in the docstring: the one destructive misreading available here is "delete the
milestone" meaning "delete the work", and there is no confirm gate to catch it.

### 2. Column status is derived, never stored

No stored counts. A cached count is stale the moment a card moves, and the board
moves cards constantly.

`getMilestoneStatus(milestoneId)` resolves members against the live board and
returns the shape the tab and the controller agent both read:

```json
{ "total": 6,
  "byColumn": { "CREATED": 3, "CODED": 2, "COMPLETED": 1 },
  "members": [ { "id": "…", "kind": "feature", "name": "…", "column": "CREATED" } ] }
```

Two rules decide whether those numbers are trustworthy:

- **`total` ≠ sum(`byColumn`).** `total` is the count of **distinct members** —
  a feature counts as 1, a standalone plan counts as 1. `byColumn` is the
  distribution of the **underlying cards** a member expands to — a feature
  expands to its subtask set, so a feature of 4 subtasks (3 CREATED, 1 CODED)
  yields `total: 1` but `byColumn: { "CREATED": 3, "CODED": 1 }`. A coder who
  implements `total = Object.values(byColumn).reduce(...)` breaks the dedupe
  invariant on day one: the feature counts as 4, not 1, and adding the feature
  plus its own subtask inflates to 5. `total` is the member count; `byColumn` is
  the card distribution. They measure different things.
- **Columns come from the board, not a hardcoded list.** Columns are
  user-configurable (`saveKanbanColumn`, `deleteKanbanColumn`), so `byColumn` is
  keyed by whatever columns the board currently has. Any count keyed to a
  literal `'DONE'` or `'COMPLETED'` string breaks for a user who renamed it.
- **A feature counts once, through the feature.** If a milestone holds feature F
  and F's subtask S is also a member, S is counted once and only via F. Without
  this the same work inflates every number the tab and the controller agent read.
  Dedupe by resolving features to their subtask sets first, then subtracting any
  directly-added subtask already covered. A feature's own column is the feature
  card's column; its subtasks contribute to `byColumn` through it.

### 3. Completion is declared, not computed

`POST /kanban/milestone/complete` with `{ milestoneId, complete: true|false }`
sets or clears `completed_at`. A user or an agent decides; nothing derives it.

Three consequences, stated because each is a thing someone will otherwise
"fix":

- **A milestone can be completed with cards outstanding.** That is a legitimate
  call — the goal was met, or its scope was cut. The endpoint must not refuse it,
  and must not move or complete the remaining cards.
- **Completing a milestone changes no card.** Not their columns, not their
  `completed_at`.
- **It is reversible.** `complete: false` reopens it, mirroring the board's own
  `uncompleteCard` verb. Strict boolean validation, following the star endpoint's
  ladder (grep `_handleSetPlanPriority` in `LocalApiServer.ts` — the strict boolean
  validation block) — a coerced `"false"` here silently reopens or closes a goal.

### 4. `src/services/LocalApiServer.ts` — routes mirroring `/kanban/mission/*`

Same shapes, same style, same auth as the mission block (grep `/kanban/mission`
in `LocalApiServer.ts` — the routes start at the `GET /kanban/missions` handler),
so there is one idiom for "a named grouping with members":

| Route | Body | Notes |
|---|---|---|
| `GET /kanban/milestones` | — | List with derived status. `?includeMembers=1` for member rows |
| `GET /kanban/milestone?id=` | — | One milestone, members, status |
| `POST /kanban/milestone/create` | `{ name, description?, targetDate?, projectId? }` | Appends at `MAX(sort_order)+1` |
| `POST /kanban/milestone/update` | `{ milestoneId, …fields }` | |
| `POST /kanban/milestone/complete` | `{ milestoneId, complete }` | §3 |
| `POST /kanban/milestone/delete` | `{ milestoneId }` | Members unlinked, cards untouched |
| `POST /kanban/milestone/member/add` | `{ milestoneId, memberId, kind }` | `kind` defaults to `'plan'`, as the mission `member/add` handler does |
| `POST /kanban/milestone/member/remove` | `{ milestoneId, memberId }` | |
| `PUT /kanban/milestones/order` | `{ orderedMilestoneIds }` | |

Validation the mission routes do **not** do and should have: reject an unknown
`memberId` with 404 rather than writing an orphan join row, and reject a
non-ISO `targetDate` with 400. An orphan member is invisible until the status
reports a total nobody can account for.

**Orphan-rejection lookup lives in the route handler.** Before calling
`addMilestoneMember`, the handler must verify the `memberId` resolves to a real
row in `plans` — for `kind: 'plan'`, via `getPlanByPlanId`; for `kind: 'feature'`,
via the same lookup (features are plans with `is_feature = 1`). If the lookup
returns null, respond 404 and write no join row. The DB method
(`addMilestoneMember`) stays thin — it writes the row, mirroring
`addMissionMember`. The validation is a route-layer concern because the DB layer
has no knowledge of plan-vs-feature semantics beyond the `member_kind` string.

**`project_id` filtering.** `getMilestones` returns **all** milestones for the
workspace regardless of `project_id` — a milestone is a board-wide view over
cards, not a project filter. The `project_id` column is stored for future use
(scoping a goal to one project's cards) but is **not filtered on read** in this
plan. The tab shows every milestone; the controller agent reads every milestone.
If project-scoped milestones are added later, that is a new filter parameter, not
a change to the default behaviour.

`member/add` is idempotent (`PRIMARY KEY` conflict → success), so an agent
re-running a script does not fail halfway.

### 5. The controller agent reads milestones to plan missions

This is the point of the feature beyond visibility, and it needs writing down or
it will not happen.

`.agents/skills/switchboard-orchestration/SKILL.md` §8 ("Workflow B — external
Mission Control driving the board") currently starts from `GET /kanban/board` and
groups loose plans into features with no notion of what the work is *for*. Add a
step before that: read `GET /kanban/milestones?includeMembers=1`, take the
incomplete milestones in `sort_order`, and prefer members of the earliest one when
choosing what to group and dispatch.

State the boundary explicitly in the skill, because an agent handed a goal will
otherwise invent authority:

- milestones **inform** which cards to work on next; they do not create, launch,
  or modify missions;
- a mission is still built the way it is built now — cards that trigger a launch
  when moved;
- an agent may add cards to a milestone and may mark one complete; it may not
  delete one;
- a milestone with no members is a goal nobody has broken down yet — surface it to
  the human rather than inventing cards for it.

Also add the milestone routes to the read/write tables in §2 and §3 of that skill,
so an agent that never reaches §8 still finds them.

### Host parity (extension + standalone)

All nine routes live in `LocalApiServer` and use `_resolveDbForRoot` — the
DB-direct family, wired in both roots already (grep `_resolveDbForRoot` in
`TaskViewerProvider.ts` and `bootstrap.ts`). No new composition-root seam. The
webview verbs the tab needs belong to plan B and must be wired in both roots
there.

### Migration

New tables only; `plans` untouched. An install that never opens the tab is
behaviourally identical. `SCHEMA_TABLES_SQL` and the V78 block must produce the
same shape, verified by the schema-reconciliation path (grep
`schema-reconciliation` / `table_info` in `KanbanDatabase.ts`) rather than by
inspection.

## Verification Plan

- **CRUD round-trip** over HTTP: create, update, add plan and feature members,
  reorder, complete, reopen, delete. Assert delete removes join rows and **leaves
  every card**.
- **Completion is a declaration:**
  - complete a milestone with 4 of 6 members unfinished → succeeds, and no card's
    column or `completed_at` changes;
  - reopen it → `completed_at` clears;
  - `complete: "false"` → rejected, not coerced;
  - completing every member card does **not** auto-complete the milestone.
- **Column status is honest:**
  - a milestone holding one feature of 4 subtasks → `total` counts the feature
    once, not four times;
  - the same feature **plus** one of its own subtasks added directly → identical
    numbers, proving the dedupe;
  - move a card → status changes with no write to any milestone row;
  - rename a board column → `byColumn` uses the new name and no count is lost.
    This is the assertion that catches the hardcoded-column shortcut.
- **Milestones are not missions:** `getMissions` never returns a milestone;
  Mission Control's launch list cannot select one; no milestone row is written to
  `missions`; no milestone route dispatches, queues, or moves a card (spy on those
  paths, require zero calls).
- **Orphan rejection:** `member/add` with an unknown id → 404, zero rows written.
- **Idempotence:** `member/add` twice → success both times, one row.
- **Fresh vs upgraded DB:** identical `PRAGMA table_info` for both tables from
  `SCHEMA_TABLES_SQL` and from migrating a V65 DB.
- **Both hosts:** run the CRUD round-trip against the extension host and the
  standalone host.

### Goal Invariants

- A milestone holds cards that sit in different columns at once, and progressing a
  card never damages the milestone.
- Column status is derived at read time and cannot be stale or written.
- No work is counted twice, whichever grain it was added at.
- Completion is set only by a user or an agent, and completing a goal never
  touches the work.
- No milestone operation causes anything to execute.
- Nothing in `missions`, Mission Control, or any tracker integration is aware
  milestones exist.
