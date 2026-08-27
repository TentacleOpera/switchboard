# Milestones — long-term goals that cards belong to, and that a controller agent can read

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
`KanbanDatabase.ts:10392-10412`: *"the number is per-column, so it must not
travel"*). A hand-arranged order is destroyed by the card progressing — the one
thing a long-term goal must survive.

**A milestone must not be a mission, and the schema is already inviting the
mistake.** `missions.type` is free text defaulting to `'mission'`
(`KanbanDatabase.ts:273-284`, `createMission` at `:11469`), so `type =
'milestone'` would "work" today with no migration. Refuse it:

- A mission is an **execution vehicle**: it carries `team`, `ready`, and
  `max_extra_worktrees`, and it is launched (`launchMission`,
  `KanbanProvider.ts:14577`). A milestone is **inert** — adding a card to one runs
  nothing.
- Sharing the table means every existing mission query grows a `type` filter
  forever, three columns are meaningless on half the rows, and the first bug is a
  milestone appearing in Mission Control's launch list as something someone can
  dispatch by accident.
- A mission is hours to days. A milestone outlives every mission run inside it.

**Missions need nothing from this plan, and nothing from Linear.** They remain
what they are: cards that trigger a launch when moved. That already works
remotely — `RemoteControlService` treats `STAGING` as a queueable target
(`:113-119`) and stages a remotely-moved card via `onStageForQueue` (`:135-140`),
so moving a card in Linear stages it here. Composing a mission from Linear is
therefore a matter of naming cards in the mission card's text, or asking the
Linear agent to do it over the endpoints that already exist. **No Linear
milestone mechanism is built, mapped, or reserved by this plan** — for missions or
for milestones.

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

## Dependencies

None. Independent of `agents-set-a-columns-card-order.md`,
`agents-set-a-cards-priority-level.md`, and
`priority-as-a-native-field-and-a-board-wide-order-by.md`.

## Proposed Changes

### 1. `src/services/KanbanDatabase.ts` — two tables (V66)

Mirror `missions` / `mission_members`, which already proves the two-table
membership shape in this schema, including a `member_kind` distinguishing plans
from features (`:285-290`, used at `LocalApiServer.ts:2694`).

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
`MIGRATION_V66_SQL` block for existing installs, following the V63/V64 pattern
(`:626-642`). No change to `plans` — membership lives in the join table, so no
existing row is rewritten. This is new state that has never shipped, so it takes a
clean break; the migration block is still required so ~4,000 installs converge on
the same shape a fresh DB gets.

**Methods:** `getMilestones`, `getMilestoneById`, `createMilestone`,
`updateMilestone`, `deleteMilestone`, `setMilestoneCompleted`,
`addMilestoneMember`, `removeMilestoneMember`, `getMilestoneMembers`,
`setMilestoneOrders` (reusing `setColumnOrders`' 1..N single-transaction shape at
`:10421-10456` rather than inventing a second ordering idiom).

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

- **Columns come from the board, not a hardcoded list.** Columns are
  user-configurable (`saveKanbanColumn`, `deleteKanbanColumn`), so `byColumn` is
  keyed by whatever columns the board currently has. Any count keyed to a literal
  `'DONE'` or `'COMPLETED'` string breaks for a user who renamed it.
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
  ladder (`LocalApiServer.ts:6505-6528`) — a coerced `"false"` here silently
  reopens or closes a goal.

### 4. `src/services/LocalApiServer.ts` — routes mirroring `/kanban/mission/*`

Same shapes, same style, same auth as the mission block at `:2655-2722`, so there
is one idiom for "a named grouping with members":

| Route | Body | Notes |
|---|---|---|
| `GET /kanban/milestones` | — | List with derived status. `?includeMembers=1` for member rows |
| `GET /kanban/milestone?id=` | — | One milestone, members, status |
| `POST /kanban/milestone/create` | `{ name, description?, targetDate?, projectId? }` | Appends at `MAX(sort_order)+1` |
| `POST /kanban/milestone/update` | `{ milestoneId, …fields }` | |
| `POST /kanban/milestone/complete` | `{ milestoneId, complete }` | §3 |
| `POST /kanban/milestone/delete` | `{ milestoneId }` | Members unlinked, cards untouched |
| `POST /kanban/milestone/member/add` | `{ milestoneId, memberId, kind }` | `kind` defaults to `'plan'`, as `:2691` does |
| `POST /kanban/milestone/member/remove` | `{ milestoneId, memberId }` | |
| `PUT /kanban/milestones/order` | `{ orderedMilestoneIds }` | |

Validation the mission routes do **not** do and should have: reject an unknown
`memberId` with 404 rather than writing an orphan join row, and reject a
non-ISO `targetDate` with 400. An orphan member is invisible until the status
reports a total nobody can account for.

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
DB-direct family, wired in both roots already (`TaskViewerProvider.ts:3714`,
`bootstrap.ts:2769`). No new composition-root seam. The webview verbs the tab
needs belong to plan B and must be wired in both roots there.

### Migration

New tables only; `plans` untouched. An install that never opens the tab is
behaviourally identical. `SCHEMA_TABLES_SQL` and the V66 block must produce the
same shape, verified by the schema-reconciliation path (`:1028`) rather than by
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
