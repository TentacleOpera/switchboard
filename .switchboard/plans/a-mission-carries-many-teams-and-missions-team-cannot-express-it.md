# A Mission Carries Many Teams, and `missions.team` Cannot Express It

## Goal

The mission data model can express what the UI specification already promises and what the stream map
already assumes: a mission carries **many** teams, and a team is assigned **per stream**, not once for
the whole mission.

### Problem analysis

**Three artefacts describe three different arities, and only the narrowest one is in the schema.**

| Artefact | What it says a mission's team-ness is |
| :--- | :--- |
| `missions` table | `team TEXT` — **exactly one**, for the whole mission |
| `mission-control-panel-ui-specification.md` (detail form) | **"Team — assign one or more teams"** |
| `staging-streams-parallel-dispatch-and-worktrees.md` | **per-stream** — *"which team takes which stream"*, *"per-stream team assignment"* |

The panel has already been built against the middle row. Its Implementation Summary records
`mission-control.html` + `mission-control.js` created, registered in `headlessPanelHtml.ts`, routed in
`LocalApiServer.ts`. So a form offering "one or more teams" exists over a column that holds one.

**Operator statement of intent, 2026-09-14, verbatim:** *"a mission can involve multiple teams, as
well as multiple kanban steps, e.g. a coding and a review team"*, and separately *"you might also have
different teams per step, e.g. a mission may have both a feature team, as well as a coder for batch
low complexity jobs."*

So the requirement is not merely plural — it is **plural, per stream, and heterogeneous**: one stream
may be served by a lead-headed feature team while another is served by a bare tier for batch
low-complexity work (which `kanban.dynamicComplexityRoutingEnabled` already routes by tier, and which
is currently `false`).

**Why it has not bitten yet.** `missions` and `mission_members` are both **empty** on the reference
install — no mission has ever been created. The mismatch is latent, and the cost of fixing it now is
zero migration. Once missions exist the same change needs a migration and a backfill.

**The carrier already exists.** `mission_members` is `(mission_id, member_id, member_kind)` —
`member_kind` is a discriminator, currently carrying plan and feature members. A team is another kind
of member. What it lacks is the stream association, because **no stream entity is persisted at all**:
this plan's sibling establishes that streams are *derived at pop time from dependency edges*, not
stored, so "which stream" has no id to point at yet.

### Root cause

`missions.team` was added when a mission was one queue with one consumer. The stream map made a
mission an N-consumer structure and the UI specification followed it to "one or more teams", but the
column was never revisited. Nothing failed, because no mission has been created — the schema and the
two documents describing it have simply never been executed against each other.

### Non-goals

- **Persisting streams as stored rows.** The sibling plan is explicit that stages are derived at pop
  time from dependency edges, not precomputed. This plan must not reintroduce static stream columns.
- **Building the stream-map editor.** Owned by the UI specification; this is the data model beneath it.
- **Implementing complexity routing.** `kanban.dynamicComplexityRoutingEnabled` and its tier
  degradation are existing, separate work.
- **Migrating existing missions.** There are none.

## Metadata

**Tags:** database, backend, schema, refactor
**Feature:** c442719f-0e1c-40da-95f3-ce48627a89ac
**Complexity:** 7

## User Review Required

1. **How is a team bound to a stream, given streams are derived and have no stable id?** Asserted
   default: bind the team to the **dependency-edge partition key the Analyze pass already produces**,
   so the binding survives re-derivation; a stream that no longer exists drops its binding rather than
   silently reassigning it. If the operator would rather streams became first-class stored rows, that
   contradicts the sibling plan's central premise and should be settled there, not here.
2. **Does `missions.team` survive as the nominated default?** Asserted default: **yes**, retained and
   read as rung 4 of the routing ladder in
   `two-teams-can-share-a-head-role-and-routing-decides-between-them.md` — the fallback when no
   per-stream binding applies. The alternative is retiring it outright and requiring an explicit
   binding for every stream.

> **Clarification (added during improve pass):** The "dependency-edge partition key the Analyze pass
> already produces" does not, as of this writing, exist as a persisted value. The sibling plan
> (`staging-streams-parallel-dispatch-and-worktrees.md`) persists only `plan_dependencies` (directed
> edges) and `plans.map_fingerprint` (a global validity hash). It **explicitly rejected**
> `stream_id`/`stream_seq` encoding columns (Superseded callout at that plan's line 160-162), on the
> grounds that with asserted completion, stages are derived at pop time rather than precomputed.
> Connected components are computed at analysis time and discarded. So "which stream" has no stable
> id to bind to today, and the partition key this plan depends on is a **new emission** the sibling
> plan must be extended to produce — not a free read of existing data. This is the load-bearing
> dependency between the two plans, and it is named explicitly in `## Dependencies` below. The
> asserted default (bind to the partition key) is still the right design; the gap is that the key must
> be emitted and persisted before this plan can bind to it.

## Complexity Audit

### Routine

- Extending `member_kind` with `'team'` is a one-line type widening on the write path
  (`addMissionMember`, `KanbanDatabase.ts:15817`).
- Adding a nullable `stream_key` column to `mission_members` is an additive `ALTER TABLE` under a new
  migration version gate — the table is empty on the reference install, so no backfill is needed.
- Keeping `missions.team` as the nominated default requires no schema change; the column already
  exists (`KanbanDatabase.ts:525`, `team TEXT DEFAULT ''`).
- The Mission Control panel's Team dropdown (`mission-control.js:159-160`) already reads `m.teams`
  and renders one `<option>` per entry — populating that array is a read-path change, not new UI.

### Complex / Risky

- **The read path coerces `member_kind` to `'plan' | 'feature'`.** `getMissionMembers`
  (`KanbanDatabase.ts:15893`) is `kind: (String(r.member_kind) === 'feature' ? 'feature' : 'plan')`,
  so a `'team'` row silently reads back as `'plan'` and gets pushed into `m.plans`
  (`KanbanDatabase.ts:15587-15588`) instead of `m.teams`. The read path must be widened to a
  three-arm discriminator, or the plan's central claim ("a team is another kind of member") is
  silently false. This is the single most likely implementation defect: the write lands, the read
  collapses it, and every test that round-trips a team sees a plan.
- **`UNIQUE(member_id)` on `mission_members`** (`KanbanDatabase.ts:713`, V65 migration at `:1002`)
  means a given `member_id` belongs to exactly one mission. A team id reused across missions is
  rejected by the index. The plan must either accept that a team is a member of one mission at a
  time (and document it) or widen the key to `(mission_id, member_id, member_kind)` so a team can
  appear in multiple missions. The current `PRIMARY KEY (mission_id, member_id)` already permits
  the same id under different missions *only if the id differs* — a team id is stable, so the
  `UNIQUE(member_id)` index is the real constraint, not the PK.
- **The stream binding key does not exist yet.** See the Clarification under User Review Required and
  the Dependencies section. The sibling plan must be extended to emit and persist a partition key
  per connected component; this plan binds to it. Without that emission, `stream_key` is a nullable
  column nothing can populate, and per-stream binding is unreachable.
- **The never-analysed invariant.** Adding a binding column and a `'team'` kind must leave a mission
  with no bindings and no analysis dispatching exactly as the present queue does, in `queue_position`
  order via `queue/next`. Parallelism is something the operator opts into by analysing; it is never a
  side effect of the schema gaining the ability to express it. This is the regression that matters,
  and it is easy to break by making the new column non-nullable or by defaulting `member_kind` to
  `'team'`.
- **`m.teams` is never populated today.** `getMissions` (`KanbanDatabase.ts:15575`) inits
  `teams: []` and the member loop (`:15587-15588`) only pushes to `plans`/`features`. The panel
  dropdown (`mission-control.js:160`) renders `m.teams` — so today it is always empty. Wiring the
  read path is what makes the built form stop being inert.
- **Host-scope claim needs verification.** The plan asserts the change lands once because
  `KanbanDatabase` is shared by both composition roots. That is true for the schema and the DB read
  methods. But `command.js:1511/1982` reads `activeMission?.team` in the webview, and the routing
  ladder in `two-teams-can-share-a-head-role-and-routing-decides-between-them.md` is wired at
  `resolveCodingHeadFromGroups` (`KanbanProvider.ts:5554`) — a shared service, but one whose
  signature widening touches `runQueue`, `_scheduleQueuePop`, autoban, `stageForQueue`, and the
  `setQueueHeadResolver` seam in *both* `extension.ts` and `bootstrap.ts`. The schema lands once; the
  routing consumption of the new binding does not. See `## Proposed Changes` §5.

## Edge-Case & Dependency Audit

**Race Conditions**

- Two concurrent `addMissionMember` calls for the same `(mission_id, team_id, 'team')` are guarded
  by `INSERT OR IGNORE` and the PK. Safe.
- A team bound to a stream that disappears on re-analysis: the binding row must be **dropped**, not
  silently reassigned. The plan states this; the implementation must enforce it on the re-analysis
  path, not rely on the operator noticing. The sibling plan's `map_fingerprint` staleness detection
  is the trigger point — when the fingerprint changes, stale `stream_key` bindings are reconciled
  against the new component set and orphaned ones are deleted.

**Security**

- No new endpoint. Team ids and stream keys are operator-authored values flowing through existing
  `mcAddMissionMember` / `mcUpdateMission` verbs, already on the verb allowlist. No new trust
  boundary.

**Side Effects**

- `getMissionsForMember` (`KanbanDatabase.ts:15859`) returns mission ids for a given `member_id`. If
  a team id is used as a `member_id`, this query returns the missions that team is assigned to —
  useful, but only if the read path no longer coerces `'team'` to `'plan'`. Today it would return
  the right rows (the query is on `member_id` only), but any caller that then calls
  `getMissionMembers` and switches on `kind` would misclassify the team.
- `isMissionMember` (`KanbanDatabase.ts:15882`) is the containment predicate. A team is **not**
  contained the way a plan/feature member is — a team does not stop being a board-level entity. The
  containment predicate must exclude `member_kind='team'`, or a team row makes
  `isMissionMember(teamId)` true and the team is treated as a mission-internal card. This is a
  subtle, high-impact gap: the predicate is used to decide whether a card renders as a loose board
  card, and a team is not a card.

**Dependencies & Conflicts**

- **Hard dependency on the sibling plan emitting a partition key.** Today it does not. See
  `## Dependencies`.
- **`two-teams-can-share-a-head-role-and-routing-decides-between-them.md`** consumes the per-stream
  binding as rung 1 of its routing ladder (its Outstanding Questions, answered 2026-09-14). This
  plan owns the carrier; that plan owns the routing. The two must agree on the binding's shape —
  `(mission_id, team_id, stream_key)` — or the ladder's rung 1 reads a structure this plan does not
  produce.
- **`mission-control-panel-ui-specification.md`** specifies the Team field as "assign one or more
  teams" and notes the schema mismatch (its line 127-129). This plan is the data model that satisfies
  that note; the panel's stream-map editor (its "Added requirement 2026-09-14") is out of scope here.
- **`UNIQUE(member_id)` index** (V65) conflicts with team reuse across missions. See Complex / Risky.

## Dependencies

- **Requires** `staging-streams-parallel-dispatch-and-worktrees.md` to **emit and persist a
  partition key per connected component** of the dependency graph. As of this writing the sibling
  plan persists `plan_dependencies` (directed edges) and `plans.map_fingerprint` (a global validity
  hash) only; it explicitly rejected `stream_id`/`stream_seq` encoding columns. The partition key
  this plan binds to is a **new emission** that must be added to the sibling plan's Analyze output
  and persisted (e.g. as a `stream_key` column on `plan_dependencies`, or a
  `mission_streams(mission_id, stream_key)` table). Without it, `mission_members.stream_key` is a
  nullable column nothing can populate. This is the load-bearing dependency and the one most likely
  to be missed, because the sibling plan's Superseded callout reads as "streams are never stored" —
  which is true for *stream rows*, but the *partition key* is a derived identifier, not a stored
  stream entity, and persisting it does not reintroduce static stream columns.
- **Consumed by** `two-teams-can-share-a-head-role-and-routing-decides-between-them.md` as rung 1 of
  its routing ladder. The binding shape this plan defines is the shape that plan reads.
- **Panel UI owned by** `mission-control-panel-ui-specification.md`. This plan defines the data
  model; that plan defines the form (including the stream-map editor, which is out of scope here).

## Adversarial Synthesis

Key risks: (1) the read path coerces `member_kind` to `'plan' | 'feature'`, so a `'team'` row
silently reads back as a plan and the plan's central claim is silently false — the single most
likely implementation defect; (2) `UNIQUE(member_id)` on `mission_members` blocks a team id from
appearing in two missions, which the plan does not acknowledge; (3) the stream binding key does
not exist yet — the sibling plan persists directed edges and a fingerprint, not a partition key, so
`stream_key` is a nullable column nothing can populate until the sibling plan is extended; (4)
`isMissionMember` must exclude `member_kind='team'` or a team row makes the containment predicate
true for a team, which is the wrong semantics. Mitigations: widen the read path to a three-arm
discriminator; decide and document whether a team is a member of one mission or many (and adjust
the index accordingly); name the partition-key emission as an explicit dependency on the sibling
plan; exclude `'team'` from the containment predicate.

## Proposed Changes

### 1. Teams become mission members — and the read path must learn the third kind

Extend `member_kind` with `'team'`. A mission's teams are `mission_members` rows, so a mission
carries N teams with no new table.

- **Write path** (`KanbanDatabase.ts:15817`): widen `addMissionMember`'s `kind` parameter from
  `'plan' | 'feature'` to `'plan' | 'feature' | 'team'`. One-line type change; the SQL is already
  generic (`INSERT OR IGNORE INTO mission_members (mission_id, member_id, member_kind) VALUES (?, ?, ?)`).
- **Read path** (`KanbanDatabase.ts:15886-15898`): widen `getMissionMembers`' return type to
  `'plan' | 'feature' | 'team'` and replace the coercing ternary
  (`kind: (String(r.member_kind) === 'feature' ? 'feature' : 'plan')`) with a three-arm
  discriminator that preserves `'team'`. **This is the load-bearing edit.** Without it, a `'team'`
  row reads back as `'plan'` and is pushed into `m.plans` instead of `m.teams`.
- **Hydration** (`KanbanDatabase.ts:15584-15590` and the parallel block at `:15700-15703`): add a
  third arm — `if (member.kind === 'team') m.teams.push(member.memberId);` — so `m.teams` is
  populated. Today `m.teams` is inited to `[]` (`:15575`) and never written, so the panel dropdown
  (`mission-control.js:160`) is always empty. The same edit applies to `getMissionById`'s
  hydration block (`:15700`).
- **Derived-field helpers** (`_hydrateDerivedMissionFields`, `_deriveMissionRunState`,
  `_deriveMissionSequencing`, `:15605-15666`): widen their `members` parameter type to include
  `'team'`. A team member has no plan row, so `_deriveMissionRunState`'s `getPlanByPlanId` returns
  null and the existing `if (!plan) continue;` (`:15631`) already skips it correctly — a team does
  not count toward mission completion. `_deriveMissionSequencing` renders a team as a step with no
  prerequisites, which is harmless but probably not what the operator wants to see; consider
  skipping `member_kind === 'team'` in the sequencing render, or labelling it as a team assignment
  rather than a work step. **Clarification, not a new requirement:** the sequencing view is owned by
  the panel spec; this plan only ensures the data is correct.

### 1b. The unanalysed case is a flat sequence, and it is the default

Operator, 2026-09-14: a never-analysed mission *"simply goes sequentially. so feature 1 - feature 2 -
plan 3 - feature 4 etc."*

So the baseline is a **single ordered list over mixed member kinds** — features and plans interleaved
in member order, with no grouping by kind and no implicit parallelism. This is the sibling plan's
*"one implicit stream"* stated concretely, and it is what a mission does until the Analyze pass runs.

It is also the invariant most at risk from this change: adding a binding column and a `'team'`
member kind must leave a mission with **no bindings and no analysis** dispatching exactly as the
present queue does, in `queue_position` order via `queue/next`. Parallelism is something the operator
opts into by analysing; it is never a side effect of the schema gaining the ability to express it.

### 2. Carry the stream binding on the membership row — and emit the key it binds to

Add a nullable `stream_key` column to `mission_members`. A row with no binding is a mission-wide
team; a row with one serves that stream. Nullable is what keeps a fresh, never-analysed mission
working exactly as today — the sibling plan's *"one implicit stream"* case.

- **Migration:** new version gate (next free migration number after the current head). Additive
  `ALTER TABLE mission_members ADD COLUMN stream_key TEXT DEFAULT NULL`. The table is empty on the
  reference install, so no backfill. Idempotent under the version gate; fresh DBs get the column
  via `SCHEMA_TABLES_SQL` (the `mission_members` CREATE at `:531` must be updated to include
  `stream_key TEXT DEFAULT NULL` so fresh DBs match).
- **The key it binds to does not exist yet.** The sibling plan persists `plan_dependencies`
  (directed edges) and `plans.map_fingerprint` (a global validity hash). It does **not** persist a
  partition key per connected component — connected components are computed at analysis time and
  discarded. So `stream_key` is a nullable column nothing can populate until the sibling plan is
  extended to emit and persist the partition key (e.g. as a `stream_key` column on
  `plan_dependencies`, or a `mission_streams(mission_id, stream_key)` table). This is the
  load-bearing dependency; see `## Dependencies`. The asserted default (bind to the partition key)
  is still the right design; the gap is that the key must be emitted first.
- **Stale-binding reconciliation:** when the sibling plan's `map_fingerprint` changes (the map is
  stale), `mission_members.stream_key` values must be reconciled against the new component set. A
  `stream_key` that no longer corresponds to a live component is **dropped** (the row's `stream_key`
  is set to NULL), not silently reassigned. This plan owns the reconciliation on the membership side;
  the sibling plan owns the fingerprint-change signal. The two meet at the re-analysis path.

### 3. `missions.team` becomes the nominated default, not the assignment

Keep the column, stop treating it as the assignment. It is read only when no `mission_members` team
row applies. Every read site must say which source answered — per the repo's fallback rule, "which
store answered?" has to be answerable after the fact, and a silent default here routes work to the
wrong team invisibly.

- **Read sites for `missions.team` today:** `getMissions` (`:15568`, `team: String(r.team || '')`),
  `getMissionById` (`:15684`), `upsertMission` (`:15764`), `updateMission` (`:15800`), and the
  webview's `resolveLaunchOriginSeat` (`command.js:1982`, `activeMission?.team`). The first four
  are DB read/write paths; the last is the dispatch-side consumer that the routing ladder's rung 1
  will replace. All of them continue to work — the column is retained.
- **Tagging the source:** the resolution function (owned by the routing plan, but this plan defines
  the data it reads) must return `{ teamId, source: 'stream-binding' | 'nominated-default' | 'none' }`,
  not a bare `teamId`. A bare id makes "the panel picked the bound team" and "the panel fell back to
  the nominated default" indistinguishable — the exact failure mode the repo's fallback rule calls
  out. The contract test in `## Verification Plan` asserts the source is logged.

### 4. Teach the panel the plural it already offers

`mission-control.html` / `mission-control.js` already render a Team field specified as "one or more".
Wire it to the membership rows rather than the single column, so the built form stops writing through
a one-team carrier.

- **Dropdown population** (`mission-control.js:159-160`): the dropdown already maps `m.teams` to
  `<option>` elements. Once the read path populates `m.teams` (Change 1), the dropdown renders the
  mission's teams. No UI change — the data behind it starts being real.
- **Write path:** `mcUpdateMission` and `mcAddMissionMember` already exist as verbs
  (`mission-control.js` posts them; `LocalApiServer` handles them). Adding a team is
  `mcAddMissionMember` with `kind: 'team'`. The verb allowlist must include any new kind value —
  run `npm run catalog:generate` after the kind is added, or `handleServiceVerb` throws on the new
  value over `/kanban/verb/*` while working fine in the VS Code webview (the same trap the sibling
  plan calls out at its item 8a).
- **Per-stream binding UI:** the stream-map editor is owned by
  `mission-control-panel-ui-specification.md` (its "Added requirement 2026-09-14"). This plan
  provides the `stream_key` column the editor writes; it does not build the editor.

### 5. Host scope — schema lands once, routing consumption does not

The schema and the DB read/write paths live in `KanbanDatabase`, shared by both composition roots, so
the data-model change lands once. Per `CLAUDE.md` (2026-09-14) the extension host is being removed in
a hard cutover — add no extension-specific wiring for the schema; it inherits the shared change.

> **Superseded:** "The schema and read paths live in `KanbanDatabase`, shared by both composition
> roots, so the change lands once. Per `CLAUDE.md` (2026-09-14) the extension host is being removed in
> a hard cutover — add no extension-specific wiring; it inherits the shared change for free."
> **Reason:** The schema and DB methods do land once. But the *consumption* of the per-stream
> binding — the routing ladder's rung 1 — is wired at `resolveCodingHeadFromGroups`
> (`KanbanProvider.ts:5554`), a shared service whose signature widening touches `runQueue`
> (`:13216`), `_scheduleQueuePop` (`TaskViewerProvider.ts:28877/29002`), the autoban/queue-watch arm
> (`KanbanProvider.ts:2744/8964`), `stageForQueue`, and the `setQueueHeadResolver` seam in **both**
> `extension.ts:1055` and `bootstrap.ts:2040/3922`. The original wording implied the whole change is
> single-root; only the schema is. The routing consumption is multi-site and, per the repo's
> standalone/extension parity rule, must land in both roots where both still wire it. (Per the
> 2026-09-14 cutover note in `CLAUDE.md`, new seams land in standalone only; the extension inherits
> the schema but the routing seam is standalone-only if added after the cutover. State which root
> the routing consumption lands in when that work is planned — it is not this plan's scope, but this
> plan must not imply it is free.)
> **Replaced with:** The schema and DB read/write paths land once in `KanbanDatabase`. The
> *consumption* of the per-stream binding — the routing ladder's rung 1 — is owned by
> `two-teams-can-share-a-head-role-and-routing-decides-between-them.md` and wired at
> `resolveCodingHeadFromGroups` and its callers. That wiring is multi-site and out of scope here,
> but this plan must not claim the whole change is single-root. The schema is; the routing is not.

### 6. Containment predicate excludes teams

`isMissionMember` (`KanbanDatabase.ts:15882`) is the containment predicate: a member is contained by
its mission and must not also render as a loose board card. A team is **not** contained that way — a
team is a board-level entity (a roster entry, a set of seats), not a card. If
`member_kind='team'` is added without excluding it from `isMissionMember`, a team id becomes
"contained" by a mission and the predicate returns true for the team, which is the wrong semantics.

- **Edit:** `getMissionsForMember` (`:15859`) is the query behind `isMissionMember`. Either filter
  `WHERE member_kind != 'team'` in `getMissionsForMember` (if no caller ever wants a team's
  missions via this path — unlikely; the routing ladder will), or filter in `isMissionMember`
  specifically. Prefer filtering in `isMissionMember` so `getMissionsForMember` remains the general
  "which missions does this member belong to" query the routing ladder needs.
- **Edge case:** a team id that collides with a plan id would be ambiguous. Team ids are
  `team_<headName>` (per `wireSpawnedTeam` / `terminals.js:1406`), plan ids are UUIDs — no collision
  in practice. Document the assumption, do not guard it.

## Verification Plan

### Automated Tests

- **Contract** — a mission with three teams round-trips: two bound to different streams, one unbound.
  Impossible to express today. Asserts `getMissionMembers` returns `kind: 'team'` for all three
  (the read-path coercion is the defect this catches).
- **Contract** — a mission with no team rows and a populated `missions.team` resolves to that team,
  and the resolution **logs its source** as the nominated default rather than a binding. Asserts the
  resolution returns `{ teamId, source }` and `source === 'nominated-default'`.
- **Contract** — a never-analysed mission (no bindings at all) dispatches identically to the present
  queue. This is the regression that matters: the elaboration must stay optional. Assert
  `queue/next` returns the same card in the same order as before the column existed.
- **Contract** — re-running the Analyze pass such that a stream disappears drops that binding and does
  **not** reassign its team to a surviving stream. Assert `mission_members.stream_key` is NULL for
  the orphaned row, not rewritten to a surviving key.
- **Contract** — `isMissionMember(teamId)` returns **false** for a team that is a mission member.
  Asserts the containment predicate excludes `member_kind='team'`.
- **Contract** — `getMissions` populates `m.teams` from `member_kind='team'` rows. Asserts the
  hydration loop's third arm fires and the panel dropdown is non-empty.
- **Parity** — both composition roots resolve the same team for the same mission and stream. (Schema
  lands once; the routing consumption is out of scope here but the contract is named so the routing
  plan inherits it.)

Run `npm run compile-tests` before any `test:contract:*` script.

### Goal Invariants

1. A mission can carry many teams — assert `getMissionMembers` returns >1 row with
   `kind: 'team'` for a mission with multiple team members.
2. A team can be bound to one stream, or to the mission as a whole — assert a `mission_members` row
   with `member_kind='team'` and `stream_key` non-null is distinct from one with `stream_key` null.
3. A mission that was never analysed behaves exactly as it does today — assert `queue/next` on a
   mission with no `stream_key` bindings returns cards in `queue_position` order, identical to a
   mission with no team members at all.
4. Every team resolution records which source supplied it — assert the resolution function returns a
   `source` field and that field is one of `'stream-binding' | 'nominated-default' | 'none'`.
5. A team is not contained by a mission — assert `isMissionMember(teamId)` is false for a team that
   is a `mission_members` row with `kind: 'team'` (negative invariant; paired with the positive
   `getMissionsForMember(teamId)` returning the mission).

## Uncertain Assumptions

No external (web-research) uncertainties. All assumptions in this plan are answerable from the
codebase and were verified during this improve pass by reading `KanbanDatabase.ts`,
`mission-control.js`, `command.js`, the sibling plan, and the routing plan. The two User Review
Required items remain operator decisions, not research questions.

## Outstanding Questions

- **[RESOLVED 2026-09-14 — from the operator's stated model, not asked again.]** These three were
  written by an agent while drafting this plan from the operator's answers, then put back to the
  operator as new questions. That is a loop. All three follow from what was already stated on
  2026-09-14 and are settled here.

  **1. Binding to a stream → the dependency-edge partition key.** Streams are derived at pop time and
  are not stored; the sibling plan (`staging-streams-parallel-dispatch-and-worktrees.md`) is explicit
  that *"stages are not stored, but derived at pop time"*. A dependent plan does not get to contradict
  its parent's central premise. So the team binds to the partition key the Analyze pass produces, and
  a stream that disappears on re-analysis **drops** its binding rather than silently reassigning the
  team. Making streams first-class stored rows remains possible, but it is a change to the sibling
  plan and must be argued there.

  **2. `missions.team` survives as the nominated default.** Already decided, in
  `two-teams-can-share-a-head-role-and-routing-decides-between-them.md`: it is read as **rung 4** of
  the routing ladder, the fallback when no per-stream binding applies, and every resolution records
  which source answered. Keeping the two plans consistent is not a new decision.

  **3. A team may belong to many missions.** The operator's model states it directly — a feature team
  and a batch tier serving work across missions over time, with mission assignment being a per-run
  parameter rather than a standing property. One-mission-at-a-time would contradict that.
  **Schema consequence:** `mission_members`'s `UNIQUE(member_id)` index (V65) must widen to
  `UNIQUE(mission_id, member_id)`, or be dropped in favour of the primary key. Both tables are empty,
  so there is no migration cost.
