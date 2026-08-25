# Dispatch Analysis — Parallel-Safety Selection for Planned Plans

> Read-only analysis pass that examines all plans in the **PLAN REVIEWED** (Planned) column,
> identifies the largest subset that can safely run in parallel without file-level conflicts,
> and moves that subset to the **STAGING** column. Plans that cannot be parallelized remain
> in Planned. This skill never modifies plan files — it only moves cards via the API.

## When This Skill Runs

This skill is dispatched by the Kanban board's **Analyze** button on the Planned column.
The board sends a `dispatch-analysis` instruction to the existing planner agent, which
routes to this skill. It is NOT invoked ad hoc by the user.

## Inputs

The prompt provides:
- `WORKSPACE_ROOT` — the workspace root path
- `API_PORT` — the LocalApiServer port
- `PROJECT` — the board's active project filter (optional; see step 1)
- `PLANS TO PROCESS` — a list of candidate plan IDs/files

## Steps

### 1. Fetch the current Planned column — scoped to the board the user is looking at

Query the API for the latest board state (the plan list in the prompt may be stale by the
time analysis runs — always re-query for freshness):

```
GET http://localhost:{API_PORT}/kanban/board?workspaceRoot={WORKSPACE_ROOT}
```

Filter for cards where `kanbanColumn === 'PLAN REVIEWED'`.

**Then scope the result — the board endpoint returns every project, the board the user
pressed Analyze on does not.** Analysing cards from another project stages work the user
cannot see in the column they clicked, which is never what they asked for.

| Prompt carries | Scope the re-queried Planned column to |
| :--- | :--- |
| `PROJECT=<name>` | cards where `project === <name>` |
| `PROJECT=<unassigned>` | cards with an empty `project` |
| `PROJECT=<all>` | every card — the user is viewing the unfiltered board |
| no `PROJECT` line | **exactly the plans listed in `PLANS TO PROCESS`** — do not widen |

The re-query is for *freshness* (a card may have moved, a plan may have been edited) and to
catch late additions **inside that scope**. It is never a licence to analyse a wider set
than the prompt described.

The surviving cards are the candidates. If none exist, report "No Planned plans to analyze"
and stop.

### 1a. Features are one unit — never split them

A feature card and its subtasks are a **single indivisible candidate**. You are not
authorised to promote, hold back, or reorder a feature's subtasks individually.

- **Analyse at the feature level.** A feature's file set is the union of its own file set
  and every subtask's. Its dependencies are the union of theirs. It conflicts with another
  candidate if *any* of those files or dependencies overlap.
- **Move the feature card only.** `POST /kanban/move` on a feature cascades to all its
  subtasks atomically. Moving a subtask directly does the opposite and worse: it triggers a
  re-derivation of the parent feature's column from its subtasks, silently dragging the
  feature somewhere the user did not put it.
- **All in, or none in.** If any part of a feature makes it unsafe to parallelise, the
  whole feature stays in Planned. Never stage "the safe half" of a feature.
- **A subtask is never a standalone candidate.** If a subtask appears in the re-queried
  board with `kanbanColumn === 'PLAN REVIEWED'` but its parent feature is in another
  column, it is not a candidate at all — the user sees it rolled up under the feature, not
  in Planned. Skip it and name it in the report.

### 2. Read each plan file

For each candidate plan, read its plan file to extract:
- **Files to modify** — the implementation section lists files that will be created or changed
- **Dependencies** — other plans this plan depends on (if declared)
- **Complexity score** — if present, for routing reference

**Resolve the path from the API response's `planFile` field. Never synthesize a filename
from the planId.** `planFile` may arrive in any of three forms:

| Form | Example | How to read it |
| :--- | :--- | :--- |
| Absolute | `/Users/me/repo/.switchboard/plans/foo.md` | read as-is |
| Relative | `.switchboard/plans/foo.md` | join against `WORKSPACE_ROOT` |
| `file://` URI | `file:///Users/me/repo/.switchboard/plans/foo.md` | strip the `file://` scheme, URL-decode, then read |

A synthesized `<planId>.md` will almost always miss, and a miss silently drops the plan
out of the analysis. Use the resolved path only.

`GET http://localhost:{API_PORT}/kanban/plan/{planId}?workspaceRoot={WORKSPACE_ROOT}`
also returns the plan record if you need the `planFile` field on its own.

**If a plan file is missing or unreadable, LEAVE THAT PLAN IN PLANNED.** You cannot prove
it parallel-safe, so it does not go to Staging. Name it in the report (step 6) with the
reason. Never guess at its file set, and never promote it on the assumption that an
unreadable plan touches nothing.

### 3. Build a file-overlap and dependency graph

For each candidate plan, analyze concurrency and ordering constraints:
- **File Overlap (undirected):** If two plans modify the **same file**, they are **conflicting** (cannot run in parallel concurrently).
- **Logical Dependencies (directed):** If plan A declares a dependency on plan B, record a directed dependency edge: `A -> dependsOn -> B`. Plan A cannot start until B has asserted completion (`completed_at IS NOT NULL`).

### 4. Validate dependency graph and compute fingerprint

1. **Cycle Detection:** Check directed dependency edges for cycles (e.g. A depends on B and B depends on A).
   - If a cycle exists: **Report all cycle members and declared edges as input errors** in the summary report (step 6).
   - Leave all cycle members in **Planned** (do not stage them, and do not emit a partial order).
2. **Compute Map Fingerprint:** Compute a SHA-256 hash of concatenated `{planId}:{sortedFileSet}` pairs for all candidates. This fingerprint validates map freshness across subsequent runs and detects edits to candidate plan files.

### 5. Persist dependency edges and stage candidates

Persisting dependency edges allows all unblocked and sequential candidates to stage together in one run without losing dependency constraints.

**5a. Persist dependency edges via the API:**
For each plan with dependencies, call:
```
POST http://localhost:{API_PORT}/kanban/dependencies
{
  "workspaceRoot": "{WORKSPACE_ROOT}",
  "planId": "{planId}",
  "dependsOn": ["{dependsOnPlanId1}", "{dependsOnPlanId2}"]
}
```

**5b. Move cards to STAGING, one at a time:**
Stage all valid candidates (both stream heads and dependent successors):
```
POST http://localhost:{API_PORT}/kanban/move
{
  "workspaceRoot": "{WORKSPACE_ROOT}",
  "sessionId": "{planId}",
  "targetColumn": "STAGING"
}
```
After each call, print `moved <planId> — <topic> → STAGING` on success, or the error on failure.

### 6. Report

Output a summary:
- Scope analysed: the project (or `PLANS TO PROCESS` list) the candidates came from
- Total Planned plans analyzed: N
- Dependency edges persisted: list of `{planId} -> depends on -> {predecessorId}`
- Dependency cycles / input errors, if any: list cycle members and declared edges
- Plans moved to Staging: list with plan IDs, roles/streams, and brief descriptions
- Plans remaining in Planned: list with plan IDs and reason
- Moves that failed, if any, with error
- Recommended next step: "Run queue or launch mission from STAGING"

## Rules

- **Never modify plan files.** This is a read-only analysis pass — writes are card moves and dependency edges via the API.
- **Stay inside the board's scope.** Scope per step 1 before analysing anything, and name scope in report.
- **A feature is one unit.** Analyse it as union of subtasks, attach dependencies to feature card only, and never promote subtasks on their own.
- **Report cycles as input errors.** Do not silently break cycles or guess execution order.
- **Persist edges.** Record dependency edges in kanban DB so pop-time evaluation gates dispatch dynamically on asserted completion.
- **One shot.** Report and exit. Do not stay running, do not poll board, do not edit plan files.
