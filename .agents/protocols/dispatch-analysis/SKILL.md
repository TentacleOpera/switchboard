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

### 3. Build a file-overlap graph

For each pair of plans, check whether their file sets intersect:
- If two plans modify the **same file**, they are **conflicting** (cannot run in parallel safely)
- If two plans have **no file overlap**, they are **compatible** (can run in parallel)

Also check for logical dependencies:
- If plan A declares a dependency on plan B, A cannot start until B completes
- Dependent plans are **conflicting** even with zero file overlap

### 4. Select the largest non-conflicting subset

This is a maximum independent set problem on the conflict graph. Use a greedy approach:
1. Sort plans by fewest conflicts (most isolated plans first)
2. Add plans one by one, skipping any that conflict with an already-selected plan
3. Continue until no more plans can be added

The result is the **dispatch set** — the largest parallelizable subset.

### 5. Announce the set, then move it — reporting as you go

Card moves write to the board database. A silent run that only reports once every write has
landed gives the user no chance to see what is happening and no way to tell a correct run
from a wrong one until it is already done.

**5a. Print the intended set before the first move.** One line per plan: plan ID, topic, and
the file set that made it safe. Print the held-back plans and their conflict reasons in the
same breath, so the whole decision is visible before anything is written.

**5b. Move one card at a time, and print the outcome of each move as it returns.** Never
batch the moves into a single loop that reports only at the end.

```
POST http://localhost:{API_PORT}/kanban/move
{
  "workspaceRoot": "{WORKSPACE_ROOT}",
  "sessionId": "{planId}",
  "targetColumn": "STAGING"
}
```

After each call, print `moved <planId> — <topic> → STAGING` on success, or the error on
failure. **A failed move does not abort the run** — carry on with the rest and list the
failures in the report.

Use the `switchboard-linear` skill's API call pattern if available, or call the endpoint
directly via `curl` / the API proxy.

### 6. Report

Output a summary:
- Scope analysed: the project (or `PLANS TO PROCESS` list) the candidates came from
- Total Planned plans analyzed: N
- Plans moved to Staging (parallel-safe): list with plan IDs and brief descriptions
- Plans remaining in Planned (conflicts): list with plan IDs and the conflict reason
- Moves that failed, if any, with the error
- Recommended next step: "Send Staging plans to coder" or "Resolve conflicts and re-analyze"

## Rules

- **Never modify plan files.** This is a read-only analysis pass — the only writes are
  card moves via the API.
- **Stay inside the board's scope.** The `/kanban/board` endpoint returns every project;
  the column the user pressed Analyze on does not. Scope per step 1 before analysing
  anything, and name the scope in the report.
- **Re-query the board, but only within scope.** The plan list in the prompt is a snapshot;
  late additions must be included — late additions *to the same project*, not to the
  workspace at large.
- **A feature is one unit.** Analyse it as the union of its subtasks, move the feature card
  and let the cascade carry them, and never promote a subtask on its own. See step 1a.
- **Report before you write, and after every write.** Card moves hit the database; the user
  must be able to watch them land, not just read about them afterwards. See step 5.
- **Prefer larger sets.** The goal is maximum parallelism — if removing one plan would
  allow two others to join, and the two are larger in scope, prefer the swap.
- **Conservative on conflicts.** When uncertain about file overlap (e.g. a plan says
  "various files" without listing them), treat it as conflicting with everything. A false
  positive (plan left in Planned) is recoverable; a false negative (two plans clobbering
  the same file in parallel) is not.
- **Resolve `planFile`, never synthesize it.** See step 2 — a made-up `<planId>.md` path
  turns every plan into an "unreadable" one and empties the dispatch set.
- **Unprovable stays in Planned.** A missing or unreadable plan file is never promoted.
- **One shot.** Report and exit. Do not stay running, do not poll the board, and do not
  edit any plan file.
