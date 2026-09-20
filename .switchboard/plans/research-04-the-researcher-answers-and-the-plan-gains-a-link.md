# Research 04 — The Researcher Answers and the Plan Gains a Link

Subtask of the feature **A Research Request Is Queued Inside the Team, and Answered Back to the Planner That Asked** (`cf5537c5`). The feature file carries the full argument and the constraints binding every subtask. This plan is self-sufficient on its own scope and, where the two disagree, **this plan wins** — it is the source of truth for the seat implementing it.

## Goal

The researcher writes its findings to a file, marks the request answered with one
CLI verb, and the plan gains a link to the findings.

This subtask owns `_handleResearchComplete` — the handler every later sibling
extends: Research-05 adds the notify-the-requester step inside it, Research-06
adds the drain call inside it. It also owns the `write_to_file` cleanup across
every seat-facing prompt that names it.

## Metadata

- **Tags:** backend, api, cli, feature
- **Complexity:** 4
- **Project:** Orchestration

## User Review Required

- None.

## Complexity Audit

### Routine
- New `research-complete` subcommand — the `cmdDone` template again
  (`cli.ts:2642`), plus the two subcommand-set registrations.
- New route + handler beside `_handleResearchRequest`.

### Complex / Risky
- The handler edits a plan file on disk — must resolve `plans.plan_file` from
  `plan_id`, append without clobbering, and create the `## Research Findings`
  section idempotently (multiple requests per plan append, not rewrite).
- "Releases the researcher" is *derived*, not a field flip: the request reads
  `answered`, which is what makes the seat free under Research-03's freeness
  rule. Do NOT clear `assigned_to` — it is the audit trail of who answered.

## Edge-Case & Dependency Audit

- **Race Conditions:** Two `research-complete` calls for the same request →
  second gets 409 (`state !== 'assigned'`). A complete racing a requeue
  (Research-06) resolves to whichever conditional UPDATE commits first.
- **Security:** `from` must equal the row's `assigned_to` — a seat cannot
  complete another seat's request. `docPath` must resolve under the workspace
  (reject absolute paths outside root and `..` — same traversal discipline as
  `isSafeQueueId`).
- **Side Effects:** DB state flip + plan-file append + `.switchboard/docs/`
  creation. The plan file may be under the watcher — the append is a normal
  edit, no special-casing.
- **Dependencies & Conflicts:** Research-01 accessors. Lands BEFORE Research-03
  in ship order so no dispatch prompt ever names a dead verb.

## Dependencies

- Research-01 (`completeResearchRequest`, `getResearchRequest`), Research-02
  (route-table neighbour and CLI pattern). Research-05/06 extend this handler.

## Adversarial Synthesis

Key risks: a request marked answered by the wrong seat (identity check on
`assigned_to`), and the plan link landing in a file that has since moved or
been deleted (resolve at call time; on a missing file, warn + still mark
answered — the doc exists, the link is the lossy part).

## Proposed Changes

### src/standalone/cli.ts

- **Context:** same registration points as Research-02.
- **Logic:** `switchboard research-complete --request <requestId> --doc
  <path> [--json]`; identity from `SWITCHBOARD_TERMINAL` (same loud failure);
  POSTs `/research/complete` with `{ from, requestId, docPath }`.
- **Edge Cases:** missing `--request`/`--doc` → usage error, no round trip.

### src/services/LocalApiServer.ts

- **Context:** `POST /research/complete` → `_handleResearchComplete`, beside
  Research-02's handler. `plans.plan_file` schema at `KanbanDatabase.ts:395`.
- **Logic:**
  1. Auth, parse `{from, requestId, docPath}` — all required.
  2. Load the row; `404` unknown id; `409` if `state !== 'assigned'`; `403`
     if `from !== assigned_to` — loud, named reason each time.
  3. Ensure `<workspaceRoot>/.switchboard/docs/` exists (`mkdir -p` semantics)
     — the host owns the directory; on the live board it did not exist and
     the researcher had to create it.
  4. `completeResearchRequest(requestId, docPath)`.
  5. Resolve `plan_file` from `plans` by `plan_id`; append to that file:
     under an existing `## Research Findings` heading if present, else a new
     trailing section — line: `- **Q:** <question> → [findings](<docPath>)
     (request <requestId>)`. Append-only; never truncate.
  6. Respond `200 { answered: true, requestId, planFile, linked: bool }`.
     `linked:false` with a reason when the plan file could not be written —
     the answer is still recorded; the link is the degradable half.
  7. Seam comments at the tail for Research-05 (`// notify requestedBy`) and
     Research-06 (`// await this._pumpResearchQueue`) — the handler compiles
     and works standalone.
- **Edge Cases:** `docPath` pointing at a file that does not exist → still
  mark answered, return `docExists:false` so the gap is visible.

### write_to_file cleanup (src/standalone/bootstrap.ts, src/services/TaskViewerProvider.ts, src/services/agentPromptBuilder.ts)

- **Context:** `bootstrap.ts:5341`, `TaskViewerProvider.ts:7488`, and
  `agentPromptBuilder.ts:~2862` name `write_to_file`, which does not exist in
  a Claude Code seat — the live researcher had to substitute a Bash heredoc.
- **Logic:** Each site names the deliverable path and stops naming a tool:
  "save the results to `<savePath>`" full stop. (Research-03's dispatch
  prompt already follows this; these are the legacy `onDispatchResearch` /
  builder strings.)
- **Edge Cases:** Grep the whole `src/` tree for `write_to_file` after the
  edit — zero hits in seat-facing strings is the gate (comments/tests
  documenting the rule may keep the name). Two extra sites found this pass:
  `src/test/agent-prompt-builder-subagents.test.js:271` asserts the OLD
  instruction verbatim — update the assertion, do not keep it; and
  `src/webview/agent-control.html:3595` is a tooltip describing the prompt to
  the operator — update it to match (presentation, but it documents a tool
  that does not exist).

## Verification Plan

### Automated Tests
- `.switchboard/docs/` exists before the researcher is dispatched (handler or
  dispatch path creates it; assert after `research-complete` on a fresh
  workspace).
- After `research-complete`, the plan file contains the findings path, once,
  under `## Research Findings`; a second request appends a second line.
- The request reads `answered`, `doc_path` set, and the researcher reads free
  under the Research-03 predicate (no `assigned` row for that seat).
- 403 when `from` ≠ `assigned_to`; 409 on double-complete.
- No prompt names `write_to_file` — a grep gate; the live researcher had to
  substitute a Bash heredoc because that tool does not exist in its session.

### Goal Invariants
- Assert `research-complete` in `KNOWN_SUBCOMMANDS` and
  `HEAP_REEXEC_EXEMPT_SUBCOMMANDS`.
- Assert zero `write_to_file` occurrences in seat-facing prompt strings under
  `src/` (negative), paired with: the findings path still appears in the
  dispatch/complete instructions (positive).

## Constraints

**Every seat-facing call is a CLI verb, never raw HTTP.** A documented raw POST
403s — `_isAllowedCrossSiteRequest` refuses a request with no
`X-Switchboard-Client` marker, and `cli.ts` is what sets it. The 2026-09-10
correction at `LocalApiServer.ts:1161` forbids raw-HTTP forms "in the team
prompts".

**Do not name `write_to_file`.** It does not exist in a Claude Code seat. Name
the deliverable and its path; let the seat choose its tool.

**No sessionId.** Identifiers are `planId`, `requestId` or a seat name.

**Tag every resolved value.** "No researcher is free" and "this team has no
researcher" are different answers and must not render the same.

**Complexity:** 4
**Routing:** Send to Coder
