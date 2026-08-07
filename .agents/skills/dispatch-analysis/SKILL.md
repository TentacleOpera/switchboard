# Dispatch Analysis — Parallel-Safety Selection for Planned Plans

> Read-only analysis pass that examines all plans in the **PLAN REVIEWED** (Planned) column,
> identifies the largest subset that can safely run in parallel without file-level conflicts,
> and moves that subset to the **DISPATCH** column. Plans that cannot be parallelized remain
> in Planned. This skill never modifies plan files — it only moves cards via the API.

## When This Skill Runs

This skill is dispatched by the Kanban board's **Analyze** button on the Planned column.
The board sends a `dispatch-analysis` instruction to the existing planner agent, which
routes to this skill. It is NOT invoked ad hoc by the user.

## Inputs

The prompt provides:
- `WORKSPACE_ROOT` — the workspace root path
- `API_PORT` — the LocalApiServer port
- `PLANS TO PROCESS` — a list of candidate plan IDs/files

## Steps

### 1. Fetch the current Planned column

Query the API for the latest board state (the plan list in the prompt may be stale by the
time analysis runs — always re-query for freshness):

```
GET http://localhost:{API_PORT}/kanban/board?workspaceRoot={WORKSPACE_ROOT}
```

Filter for cards where `kanbanColumn === 'PLAN REVIEWED'`. These are the candidates.

If no Planned cards exist, report "No Planned plans to analyze" and stop.

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
it parallel-safe, so it does not go to Dispatch. Name it in the report (step 6) with the
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

### 5. Move the dispatch set to DISPATCH

For each plan in the dispatch set, move its card to DISPATCH:

```
POST http://localhost:{API_PORT}/kanban/move
{
  "workspaceRoot": "{WORKSPACE_ROOT}",
  "sessionId": "{planId}",
  "targetColumn": "DISPATCH"
}
```

Use the `switchboard-linear` skill's API call pattern if available, or call the endpoint
directly via `curl` / the API proxy.

### 6. Report

Output a summary:
- Total Planned plans analyzed: N
- Plans moved to Dispatch (parallel-safe): list with plan IDs and brief descriptions
- Plans remaining in Planned (conflicts): list with plan IDs and the conflict reason
- Recommended next step: "Send Dispatch plans to coder" or "Resolve conflicts and re-analyze"

## Rules

- **Never modify plan files.** This is a read-only analysis pass — the only writes are
  card moves via the API.
- **Always re-query the board.** The plan list in the prompt is a snapshot; late additions
  to Planned must be included.
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
