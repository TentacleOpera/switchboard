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

**Tags:** schema, missions, data-model, standalone, extension
**Complexity:** 5

## User Review Required

1. **How is a team bound to a stream, given streams are derived and have no stable id?** Asserted
   default: bind the team to the **dependency-edge partition key** the Analyze pass already produces,
   so the binding survives re-derivation; a stream that no longer exists drops its binding rather than
   silently reassigning it. If the operator would rather streams became first-class stored rows, that
   contradicts the sibling plan's central premise and should be settled there, not here.
2. **Does `missions.team` survive as the nominated default?** Asserted default: **yes**, retained and
   read as rung 4 of the routing ladder in
   `two-teams-can-share-a-head-role-and-routing-decides-between-them.md` — the fallback when no
   per-stream binding applies. The alternative is retiring it outright and requiring an explicit
   binding for every stream.

## Proposed Changes

### 1. Teams become mission members

Extend `member_kind` with `'team'`. A mission's teams are `mission_members` rows, so a mission carries
N teams with no schema change and no new table.

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

### 2. Carry the stream binding on the membership row

Add the partition key from change 1's decision to `mission_members` (nullable). A row with no binding
is a mission-wide team; a row with one serves that stream. Nullable is what keeps a fresh,
never-analysed mission working exactly as today — the sibling plan's *"one implicit stream"* case.

### 3. `missions.team` becomes the nominated default, not the assignment

Keep the column, stop treating it as the assignment. It is read only when no `mission_members` team
row applies. Every read site must say which source answered — per the repo's fallback rule, "which
store answered?" has to be answerable after the fact, and a silent default here routes work to the
wrong team invisibly.

### 4. Teach the panel the plural it already offers

`mission-control.html` / `mission-control.js` already render a Team field specified as "one or more".
Wire it to the membership rows rather than the single column, so the built form stops writing through
a one-team carrier.

### 5. Host scope

The schema and read paths live in `KanbanDatabase`, shared by both composition roots, so the change
lands once. Per `CLAUDE.md` (2026-09-14) the extension host is being removed in a hard cutover — add
no extension-specific wiring; it inherits the shared change for free.

## Verification Plan

### Automated Tests

- **Contract** — a mission with three teams round-trips: two bound to different streams, one unbound.
  Impossible to express today.
- **Contract** — a mission with no team rows and a populated `missions.team` resolves to that team,
  and the resolution **logs its source** as the nominated default rather than a binding.
- **Contract** — a never-analysed mission (no bindings at all) dispatches identically to the present
  queue. This is the regression that matters: the elaboration must stay optional.
- **Contract** — re-running the Analyze pass such that a stream disappears drops that binding and does
  **not** reassign its team to a surviving stream.
- **Parity** — both composition roots resolve the same team for the same mission and stream.

Run `npm run compile-tests` before any `test:contract:*` script.

### Goal Invariants

1. A mission can carry many teams.
2. A team can be bound to one stream, or to the mission as a whole.
3. A mission that was never analysed behaves exactly as it does today.
4. Every team resolution records which source supplied it.
