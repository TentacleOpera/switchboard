# Two Project Filter Paths Read Different Columns, and Nothing Stops Them Disagreeing

## Goal

A plan's project is stored twice — as a denormalised `plans.project` string and as a `plans.project_id`
foreign key — and the board's two read paths filter on **different ones**. When the two disagree, the
card becomes unreachable from every project selection except "All Projects". Make one of them
authoritative, or make disagreement impossible and detectable.

### Problem analysis

**Observed 2026-09-15.** Two cards — *Interchange pipeline animation for the landing page*
(`d1129be8`) and *Act 5 remote animation (WOTW radio tower)* (`5287f392`) — were visible under
"All Projects" in the Autocode aggregate and under no project selection at all. Their rows read:

```
project = 'switchboard site'      project_id = 10
```

Project 10 is **`Website`**. No project named `switchboard site` exists in the `projects` table. The
two columns describe different projects, and both are consulted — by different callers.

**The two read paths.**

- `getBoardFilteredByProject` joins the projects table and filters `AND pr.name = ?`
  (`KanbanDatabase.ts:4866`) — it resolves through **`project_id`**. Under this path the cards belong
  to `Website`.
- `getPlansByColumn` filters the denormalised string, `AND project = ?` (`:5458`) — under this path
  they belong to `switchboard site`, a name no dropdown can offer because it is not a project.

So every selection misses them:

| Selection | Result |
|---|---|
| All Projects | no filter applied — visible |
| `Website` | string path wants `project = 'Website'`; row says `switchboard site` — hidden |
| Unassigned | wants `project_id IS NULL`; row says `10` — hidden |
| any other | no match on either column — hidden |

**The hazard is documented, and it happened anyway.** `_resolveProjectForInsert` carries the warning
verbatim (`:2769-2774`): an unknown pin must drop to *fully* unassigned (`project=''`,
`projectId=null`) — *"NOT the orphan denormalized string, which would split the board's two filter
paths (getBoardFilteredByProject filters Unassigned on project_id IS NULL; getPlansByColumn filters
on project='')."* The insert path was hardened against producing this state. Nothing prevents the
state arising afterwards, and nothing detects it once it exists.

**There is no rename path.** `grep` for `UPDATE projects` or `renameProject` across `src/` returns
**nothing**: projects can be created (`addProject`, `:4921`) and deleted (`deleteProject`, `:4935`)
and never renamed. So renaming a project requires editing the table out of band — and doing so
silently orphans every denormalised copy, because no code is watching.

The V35 backfill is not the culprit: it matches names exactly
(`projects.name = plans.project`, `:1554-1556`), so an unmatched string yields `NULL`, not a wrong id.

**A second consequence, unobserved but latent.** `deleteProject` clears plans by matching the
**string** (`UPDATE plans SET project = '', project_id = NULL WHERE ... AND project = ?`, `:4943`).
A row whose string has drifted therefore survives the deletion of the project it actually belongs to,
keeping a `project_id` that now points at nothing.

**Scope of the damage today: two rows.** A full sweep —
`plans LEFT JOIN projects ON project_id = id WHERE project <> '' AND projects.name <> plans.project`
— returns **0** after those two were reassigned through `assignSelectedToProject`. So this is a rare
event with a wide blast radius, not an ongoing corruption.

### Root cause

The same fact is stored twice with no invariant binding the copies, and the two readers disagree
about which copy is authoritative. A denormalised column is a cache; this one has no writer that owns
it and no check that it matches its source.

## Metadata

**Complexity:** 4
**Tags:** bugfix, database, reliability

## User Review Required

No. That the two must agree is not in question. Which becomes authoritative is an implementation
choice with a clear default — see Settled Design.

## Settled Design

- **`project_id` is authoritative.** It is the foreign key, it survives a rename by construction, and
  it is what the joined read path already uses. `plans.project` becomes a cache of
  `projects.name`, never an independent value.
- **Both read paths resolve through the same column.** This is the actual fix — one source, one
  filter. Leaving two paths that read different columns means the next divergence produces the same
  invisible cards.
- **Disagreement becomes detectable, not merely unlikely.** A startup or maintenance check reports
  rows where the denormalised string does not match its `project_id`'s name. Silent is what made
  these two cards invisible for weeks.
- **A rename path is added, or renaming is explicitly refused.** Today it is neither supported nor
  prevented, which is the worst of both: the operation is possible only by going around the code,
  and doing so corrupts state. Either is acceptable; the current silence is not.
- **`deleteProject` matches on `project_id`, not the string** — so a drifted row cannot outlive the
  project it belongs to.
- **Not in scope:** `03ed0e7a` *Replace agent-authored project pinning with a sticky-project UI
  setting* owns `_resolveProjectForInsert` and the pin mechanism. This plan does not touch insert-time
  precedence; it governs what happens to rows that already exist.

## Complexity Audit

### Routine
- The detection query, and pointing `deleteProject` at `project_id`.

### Complex / Risky
- **Changing which column a read path filters on touches every board read.** `getPlansByColumn` is on
  the hot path; converting its string filter to a join must not regress the read that already loads
  hundreds of cards.
- **Dropping or demoting `plans.project` has unaudited consumers.** It is denormalised precisely
  because something wanted it without a join — including, per its own comment, the Unassigned
  filter's `project=''` test. Every reader must be found before the column's meaning changes.
- **A reconciliation that rewrites rows can do damage if the authority choice is wrong.** Report
  first; repair only on an explicit, reviewed pass.

## Edge-Case & Dependency Audit

- **Race conditions.** None new.
- **Security.** None.
- **Side effects.** Cards currently invisible under a project selection will start appearing there.
  That is the fix, and it may look like cards "arriving from nowhere".
- **Dependencies & conflicts.**
  - `03ed0e7a` — owns insert-time project resolution. Must not both edit
    `_resolveProjectForInsert`.
  - `4b69fe8b` *Board Hygiene — Cards That Leave, and Cards That Should Not Arrive* — a detection
    sweep for mismatched rows is that feature's shape, and this plan may belong inside it.
  - `febaab3b` — the project list's delivery to the dropdown. Unrelated mechanism, adjacent symptom:
    both make a project look like it does not exist.

## Adversarial Synthesis

**Risk summary.** The detection half is safe and immediately useful; the repair half is where damage
lives, because a reconciliation that picks the wrong authority rewrites real assignments at scale.
The second risk is scope: "make one column authoritative" invites deleting the denormalised column,
which has unaudited readers on the hot path — the safe order is detect, then unify the readers, then
consider removing the cache. The third is that the observed instance is already fixed and the sweep
is clean, so there is no failing symptom to verify against; the test must construct the divergence
deliberately rather than wait for one.

## Proposed Changes

### Change A — detect the divergence

- **Logic:** a check that reports rows where `plans.project` does not equal the `name` of
  `plans.project_id`. Report only — no repair.
- **Edge case:** `project = ''` with `project_id IS NULL` is the valid unassigned state and must not
  be reported.
- **Edge case:** a row whose `project_id` points at a deleted project is a second, distinct fault —
  report it separately rather than folding both into one count.

### Change B — one column answers both read paths

#### `KanbanDatabase.getPlansByColumn` (`:5458`) and `getBoardFilteredByProject` (`:4866`)
- **Logic:** resolve both through `project_id`. The string filter becomes a join, or the string is
  refreshed from the join at read time.
- **Edge case:** measure the read cost before and after — `getPlansByColumn` serves the board's hot
  path on a 2,658-card store.
- **Edge case:** the Unassigned selection must keep working on both paths and must agree — today one
  tests `project_id IS NULL` and the other `project = ''`.

### Change C — `deleteProject` keys on the id

#### `KanbanDatabase.deleteProject` (`:4943`)
- **Logic:** clear plans by `project_id`, not by the name string, so a drifted row is still cleared.
- **Edge case:** rows whose string matches but whose id does not must also be caught during the
  transition — clear on either until Change A reports zero.

### Change D — renaming is supported or refused

- **Logic:** add a rename that updates `projects.name` **and** every denormalised copy in one
  transaction; or state in the code that renaming is unsupported and have the UI offer no path to it.
- **Edge case:** if rename is added, it is the one place allowed to write `plans.project` in bulk.

## Verification Plan

### Automated Tests
1. **Divergence is detected.** Construct a row whose `project` string and `project_id` name disagree;
   assert the check reports it. It must be constructed — the board is currently clean.
2. **A diverged card is still reachable.** With such a row present, selecting the project named by
   its `project_id` returns it. Fails today: the string path hides it.
3. **Both paths agree on Unassigned.** `getPlansByColumn` and `getBoardFilteredByProject` return the
   same set for the Unassigned selection.
4. **`deleteProject` clears a drifted row.** A row whose string has drifted is cleared when its real
   project is deleted. Fails today.
5. **Hot-path read cost does not regress.** `getPlansByColumn` timing before and after Change B, on a
   store of realistic size.

### Goal Invariants
1. No active plan has a non-empty `project` that differs from the `name` of its `project_id`
   *(paired positive: `project = ''` with `project_id IS NULL` remains valid and is not reported)*.
2. `getPlansByColumn` and `getBoardFilteredByProject` resolve a project selection through the same
   column.
3. `deleteProject` clears plans by `project_id`.
4. Either a rename path exists that updates both stores in one transaction, or the code states that
   renaming is unsupported.
5. A check exists that reports divergence, and it distinguishes "string disagrees with id" from
   "id points at a deleted project".
