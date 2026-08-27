# Milestones — long-term targets that cards are arranged to meet

## Goal

Add a **milestone**: a named target, optionally dated, that groups features and
plans and reports how close it is. A sequence of milestones is a roadmap, so this
is the state a human or an agent needs in order to answer *"what are we actually
working toward, and how far along is it"* — a question the board currently cannot
be asked.

This plan is **state, API, and agent access**. The Milestones tab is
`milestones-tab-in-the-kanban-panel.md` and depends on this.

### Problem Analysis

**The board has four grouping concepts and none of them is a target.**

| Concept | Storage | What it means |
|---|---|---|
| Project | `projects` table, `kanban.activeProjectFilter` | A board filter — *which cards am I looking at* |
| Feature | `plans.is_feature` + `plans.feature_id` | One deliverable's subtasks |
| Mission | `missions` + `mission_members`, Mission Control panel | An execution queue — *what runs next, in what order, by which team* |
| Worktree | `worktrees` table | Git isolation for in-flight work |

A feature is the closest, and it is the wrong grain: it is *one deliverable
decomposed*, authored top-down and complete in itself. A target like "self-serve
onboarding shipped" spans several unrelated features plus loose plans, has a
date, and is measured by progress rather than by decomposition. Nothing in the
table above holds a date, and nothing spans columns — which is what a target
must do, because its members are simultaneously in CREATED, CODED, and DONE.

**Ordering is not a roadmap, and the distinction is structural rather than
semantic.** `column_order` is deliberately cleared the moment a card changes
column (`clearColumnOrder`, `KanbanDatabase.ts:10392-10412`: *"the number is
per-column, so it must not travel"*). So a hand-arranged order is destroyed by
the card progressing, which is the one thing a roadmap must survive. Sorting a
column answers "what next"; a roadmap answers "toward what".

**A milestone must not be a mission, and the schema is already inviting the
mistake.** `missions.type` is free text defaulting to `'mission'`
(`KanbanDatabase.ts:273-284`, `createMission` at `:11469`), so `type =
'milestone'` would "work" today with no migration. Refuse it:

- A mission is an **execution vehicle**. It carries `team`, `ready`, and
  `max_extra_worktrees`; it is launched; its queue order is committed to, which
  is precisely why board priority is forbidden from reaching inside one
  (`kanbanOrdering.ts:74-84`). A milestone is **inert** — it describes intent and
  measures progress, and adding a card to one runs nothing.
- Sharing the table means every existing mission query grows a `type` filter
  forever, three columns are meaningless on half the rows, and the first bug is a
  milestone appearing in Mission Control's launch list — a target someone can
  accidentally dispatch.
- Their lifetimes differ by an order of magnitude. A mission is hours to days; a
  milestone is weeks to quarters and outlives every mission run inside it.

**Corollary, stated because a future tracker-sync plan will be tempted:** when
Linear milestones are eventually synced, they map to **Switchboard milestones,
never to missions**. Linear's `ProjectMilestone` is a dated target with issues
attached — the same concept as this plan's — while a mission has no Linear
counterpart at all. There is no milestone code in the tree today (a `grep -ri
milestone src/` returns nothing), so the mapping is being decided here before
anything can drift.

### Root Cause

Every grouping in the board was built to answer *what to work on next*. Nothing
was built to answer *what this adds up to*, so long-term intent lives in the
user's head and in plan prose, where neither the board nor an agent can read it.

### Non-goals

- **Linear / ClickUp milestone sync.** Deliberately deferred, and deliberately
  **without** a placeholder `linear_milestone_id` column: an unwritten column
  invites a half-implementation, and adding one later is a single additive
  `ALTER`. The mapping rule above is recorded now; the code is not.
- **Milestones driving execution.** No dispatch, no queueing, no column moves.
  Inertness is the property that keeps this from becoming a second Mission
  Control, and it is a design commitment rather than a v1 shortcut.
- **Nesting.** No milestones inside milestones. Features already provide one
  level of decomposition, and a target that contains targets is a project.
- **Replacing features or projects.** A milestone sits above both and references
  them.
- **Confirm gates.** Per project rule, none — deleting a milestone deletes it
  immediately.

## Metadata

**Complexity:** 6
**Tags:** feature, backend, database, api

## Dependencies

None. Independent of `agents-set-a-columns-card-order.md`,
`agents-set-a-cards-priority-level.md`, and
`priority-as-a-native-field-and-a-board-wide-order-by.md` — different state,
different consumers, any order.

## Proposed Changes

### 1. `src/services/KanbanDatabase.ts` — two tables (V66)

Mirror the `missions` / `mission_members` pair, which already proves the
two-table membership shape in this schema, including a `member_kind` that
distinguishes plans from features (`:285-290`, `addMissionMember` used at
`LocalApiServer.ts:2694`).

```sql
CREATE TABLE IF NOT EXISTS milestones (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    description  TEXT DEFAULT '',
    target_date  TEXT DEFAULT NULL,   -- ISO date, NULL = undated
    project_id   INTEGER DEFAULT NULL,-- NULL = board-wide
    sort_order   INTEGER DEFAULT NULL,-- roadmap sequence
    achieved_at  TEXT DEFAULT NULL,
    workspace_id TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS milestone_members (
    milestone_id TEXT NOT NULL,
    member_id    TEXT NOT NULL,
    member_kind  TEXT NOT NULL,       -- 'plan' | 'feature'
    PRIMARY KEY (milestone_id, member_id)
);
CREATE INDEX IF NOT EXISTS idx_milestone_members_member ON milestone_members(member_id);
```

Added to `SCHEMA_TABLES_SQL` for fresh DBs **and** as an idempotent
`MIGRATION_V66_SQL` block for existing installs, following the V63/V64/V65
pattern (`:626-642`). No change to `plans` — membership lives in the join table,
so a card carries no milestone column and nothing about existing rows is
rewritten. Per project rules this is new state that has never shipped, so it
takes a clean break; but the `CREATE TABLE IF NOT EXISTS` + migration-block
pattern is still followed, because ~4,000 installs will run it and a fresh DB and
an upgraded DB must end up identical.

**`sort_order` is what makes a set of targets a roadmap.** Reuse the
`setColumnOrders` transaction shape (`:10421-10456`) — 1..N in one transaction —
rather than inventing a second ordering idiom.

**Methods:** `getMilestones(workspaceId)`, `getMilestoneById`,
`createMilestone`, `updateMilestone`, `deleteMilestone` (cascades its
`milestone_members` rows and nothing else), `addMilestoneMember`,
`removeMilestoneMember`, `getMilestoneMembers`, `setMilestoneOrders`.

`deleteMilestone` deletes the target, **never the cards**. Say it in the
docstring: the one destructive misreading available here is "delete the
milestone" meaning "delete the work", and there is no confirm gate to catch it.

### 2. Progress is derived, never stored

No `progress` column. A cached count is a count that goes stale the moment a card
moves, and the board moves cards constantly.

`getMilestoneProgress(milestoneId)` resolves members against the live board and
returns `{ total, done, byColumn: { CREATED: 3, CODED: 2, DONE: 1 }, blocked }`.

Two rules that decide whether the number is trustworthy:

- **Completion uses the board's own signal**, `plans.completed_at` (`:264`,
  written by the complete path and cleared by `uncompleteCard`) — not a column
  name. Columns are user-configurable (`saveKanbanColumn`,
  `deleteKanbanColumn`), so a progress metric keyed to the string `'DONE'`
  breaks on any board whose owner renamed it.
- **A feature member counts once, through the feature.** If a milestone holds
  feature F and F's subtask S is also a member, S is counted once and only via F;
  a feature is complete when all its subtasks are. Without this rule the same
  work inflates both `total` and `done`, and a milestone's headline number — the
  entire point of the feature — silently lies. Dedupe by resolving features to
  their subtask sets first, then subtracting any directly-added subtask already
  covered.

### 3. `src/services/LocalApiServer.ts` — routes mirroring `/kanban/mission/*`

Same shapes, same style, same auth as the mission block at `:2655-2722`, so
there is one idiom for "a named grouping with members" rather than two:

| Route | Body | Notes |
|---|---|---|
| `GET /kanban/milestones` | — | List with derived progress. `?includeMembers=1` for member rows |
| `GET /kanban/milestone?id=` | — | One milestone, members, progress |
| `POST /kanban/milestone/create` | `{ name, description?, targetDate?, projectId? }` | Appends at `MAX(sort_order)+1` |
| `POST /kanban/milestone/update` | `{ milestoneId, …fields }` | Includes `achievedAt` |
| `POST /kanban/milestone/delete` | `{ milestoneId }` | Members unlinked, cards untouched |
| `POST /kanban/milestone/member/add` | `{ milestoneId, memberId, kind }` | `kind` defaults to `'plan'`, exactly as `:2691` does |
| `POST /kanban/milestone/member/remove` | `{ milestoneId, memberId }` | |
| `PUT /kanban/milestones/order` | `{ orderedMilestoneIds }` | The roadmap sequence |

Validation the mission routes do **not** do, and should have: reject an unknown
`memberId` with 404 rather than writing an orphan join row, and reject a
`targetDate` that is not an ISO date with 400. An orphan member is invisible
until progress reports a total nobody can account for.

`member/add` is idempotent (`PRIMARY KEY` conflict → success), so an agent
re-running a roadmap script does not error halfway.

### 4. Agent access — `.agents/skills/switchboard-orchestration/SKILL.md`

Add a Milestones section beside the existing kanban rows (`:104`), with `curl`
examples in the style at `:119`. This is the answer to the original request —
*"agents able to organise cards into a roadmap"* — so it must be explicit about:

- a milestone is a **target**, not a queue: adding cards runs nothing;
- add **features** rather than their subtasks where a feature exists, and why
  (the double-count rule above);
- progress is read, never written;
- a milestone with no `targetDate` is a legitimate "someday" target, not an
  error;
- `PUT /kanban/milestones/order` sequences the roadmap; `column_order` does not.

### Host parity (extension + standalone)

All eight routes live in `LocalApiServer` and use `_resolveDbForRoot`, the
DB-direct family — wired in both roots already (`TaskViewerProvider.ts:3714`,
`bootstrap.ts:2769`), so no new composition-root seam is introduced and both
hosts answer identically. The webview verbs the tab needs are plan B's problem
and must be wired in both roots there.

### Migration

New tables only; `plans` is untouched. An install that never opens the Milestones
tab is byte-identical in behaviour. Both `SCHEMA_TABLES_SQL` and the V66
migration block must create the same shape — verified by the existing
schema-reconciliation path (`:1028`) rather than by inspection.

## Verification Plan

- **CRUD round-trip** over HTTP: create, update, add plan and feature members,
  reorder, delete. Assert delete removes join rows and **leaves every card**.
- **Progress is honest:**
  - a milestone holding one feature of 4 subtasks, 2 complete → `total` counts
    the feature once, not four times;
  - the same feature **plus** one of its own subtasks added directly → identical
    numbers, proving the dedupe;
  - complete a card → progress changes with no write to any milestone row;
  - rename the DONE column → progress unchanged (keyed to `completed_at`, not the
    column name). This is the assertion that catches the tempting shortcut.
- **Milestones are not missions:** assert `getMissions` never returns a milestone
  and Mission Control's launch list cannot select one; assert no milestone row is
  written to `missions`; assert no milestone route dispatches, queues, or moves a
  card (spy on the dispatch and move paths and require zero calls).
- **Orphan rejection:** `member/add` with an unknown id → 404, zero rows written.
- **Idempotence:** `member/add` twice → success both times, one row.
- **Fresh vs upgraded DB:** create a DB from `SCHEMA_TABLES_SQL` and migrate a
  V65 DB; assert identical `PRAGMA table_info` for both tables.
- **Both hosts:** run the CRUD round-trip against the extension host and the
  standalone host.

### Goal Invariants

- A milestone can hold members that sit in different columns at the same time,
  and progressing a card never damages the milestone.
- Progress is derived at read time and cannot be stale or written.
- No work is counted twice, whichever grain it was added at.
- No milestone operation causes anything to execute.
- Nothing in `missions` or Mission Control is aware milestones exist.
