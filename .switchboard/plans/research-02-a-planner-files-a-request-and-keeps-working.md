# Research 02 — A Planner Files a Request and Keeps Working

Subtask of the feature **A Research Request Is Queued Inside the Team, and Answered Back to the Planner That Asked** (`cf5537c5`). The feature file carries the full argument and the constraints binding every subtask. This plan is self-sufficient on its own scope and, where the two disagree, **this plan wins** — it is the source of truth for the seat implementing it.

## Goal

A planner that hits an open question records it in its own plan file, files a
request with one CLI verb, and carries on.

This subtask owns three surfaces: the `research-request` CLI subcommand, the
`POST /research/request` endpoint that enqueues into the Research-01 table, and
the planner-facing directive rewrite that makes the verb the only documented
path. Assignment/dispatch is Research-03; this endpoint enqueues and — once
Research-03 has landed — ends by invoking its pump.

## Metadata

- **Tags:** backend, api, cli, feature
- **Complexity:** 4
- **Project:** Orchestration

## User Review Required

- None.

## Complexity Audit

### Routine
- New CLI subcommand following `cmdDone` (`cli.ts:2642-2740`) line-for-line:
  flag parse, `SWITCHBOARD_TERMINAL` env identity with loud failure
  (`cli.ts:2670-2689`), `apiPost` (which already sets `X-Switchboard-Client` at
  `cli.ts:684`), `dispatchExitCode`, `emitJson`.
- New route + handler in `LocalApiServer` beside `_handleResearchDispatch`
  (`LocalApiServer.ts:10174`).

### Complex / Risky
- Team resolution must use `_resolveTeamGroupForSeat(workspaceRoot, from)`
  (already exists — used at `LocalApiServer.ts:6900,7041`) and must TAG the
  source it returns; a seat on no team is a loud 400, not a queued orphan.
- The planner-facing directive lives in prompt-builder constants that ship to
  seats; editing them changes live seat behaviour.

## Edge-Case & Dependency Audit

- **Race Conditions:** Concurrent filings are independent inserts; ordering is
  `created_at`. The enqueue itself never blocks on a researcher.
- **Security:** `question`/`planId` are seat-supplied; the endpoint must
  validate `from` is a rostered member of the resolved team (same roster check
  `_handleTeamQueueDone` performs at `LocalApiServer.ts:9676`) so a seat cannot
  file into another team's queue — and cannot file *as* another seat, since
  `from` comes from the env the host injected, not a flag the seat chooses
  (flag override exists for manual driving, same as `done`).
- **Side Effects:** One DB row, plus one read of the plan file for the
  question-presence warning. The plan-file question is written by the seat
  before it calls the verb — the endpoint reads it to warn on drift, and still
  never edits plan files.
- **Dependencies & Conflicts:** Research-01's `insertResearchRequest`. The old
  `POST /research/dispatch` + `onDispatchResearch` seam stays for external
  callers; this plan does not remove it, but it does remove the seat-facing
  instruction to curl it (below).

## Dependencies

- Research-01 (table + `insertResearchRequest`).
- Research-03 adds the `await this._pumpResearchQueue(...)` call at the end of
  `_handleResearchRequest` — this plan leaves an explicit seam comment there,
  and the handler must compile standalone (no call until Research-03 writes it).

## Adversarial Synthesis

Key risks: a seat filing into the wrong team's queue (mitigated by roster
validation on the resolved group), and the planner continuing to curl
`/research/dispatch` because the *directive text* still tells it to (mitigated
by rewriting `ADVISE_RESEARCH_DIRECTIVE_HANDOFF` and grepping for surviving
raw-POST instructions, including `bundledProtocols.ts` copies).

## Proposed Changes

### src/standalone/cli.ts

- **Context:** `cmdDone` at `cli.ts:2642`; subcommand whitelists at
  `cli.ts:4189` (`HEAP_REEXEC_EXEMPT_SUBCOMMANDS`) and `cli.ts:4241`
  (`KNOWN_SUBCOMMANDS`); `usage()` text near `cli.ts:40`.
- **Logic:** `switchboard research-request --plan <planId> --question "<one
  line>" [--json]`. Identity resolves from `SWITCHBOARD_TERMINAL` exactly as
  `cmdDone` does — env first, `--from` override for hand-driving, and the same
  loud named-variable failure when neither exists. POSTs
  `/research/request` with `{ from, planId, question }`.
- **Implementation:** new `cmdResearchRequest`; register `'research-request'`
  in both subcommand sets and usage; wire in `main()`'s dispatch next to
  `'done'`.
- **Edge Cases:** Empty `--question` → local usage error, never a round trip.
  Offline board → same "No running Switchboard instance" path as `cmdDone`,
  echoing resolved `from`/`fromSource`.

### src/services/LocalApiServer.ts

- **Context:** Route table near `LocalApiServer.ts:14800`
  (`/research/dispatch`); `_resolveTeamGroupForSeat` at ~6900;
  `_handleResearchDispatch` at 10174 is the neighbour and the response-shape
  precedent (`dispatched`/reason fields, no `success` wrapper contradictions).
- **Logic:** `POST /research/request` → `_handleResearchRequest`:
  1. Auth (`_checkAuth`), parse `{from, planId, question}` — all required.
  2. `{ group, source } = await this._resolveTeamGroupForSeat(workspaceRoot,
     from)`. `source === 'read-failed'` → 503 (fail loud). `group === null` →
     400 `{ error: "seat '<from>' is not on a registered team" }` — a request
     nothing will ever serve is rejected, not silently held.
  3. Roster membership check: `from` must be in `group.order`/`group.members`
     (the check `_handleTeamQueueDone` runs at 9671-9680).
  4. `insertResearchRequest({ requestId: crypto.randomUUID(), teamId: group.id
     (or the registered group's id field), workspaceId, planId,
     requestedBy: from, question, state: 'queued', created_at })` via
     `this._options.getKanbanDatabase`.
  5. **Question-presence check (read-only, advisory).** When the plan row
     resolves, read its `plan_file` and look for the `question` string. Absent
     → attach `warning: "question not found in plan file '<path>' — the queue
     row is authoritative; the file is the human trace"` to the response. The
     row is enqueued either way: this is a warning, never a refusal — the seat
     writes the file, and a mid-turn write ordering must not cost the request.
     The handler **reads** the plan file here and still never writes it;
     Research-04 owns the write.
  6. Respond `200 { queued: true, requestId, teamId, position, planKnown,
     ...(warning ? { warning } : {}) }` where `position` is the count of
     `queued` requests ahead of it.
  7. End of handler carries the seam comment: `// Research-03 appends:
     // await this._pumpResearchQueue(workspaceRoot, teamId)` — Research-03
     inserts the actual call.
- **Edge Cases:** `planId` unknown → still queue (the plan row may be imported
  later than the request); include `planKnown: false` in the response so the
  caller can distinguish — and **skip** the question-presence check, which has
  no file to read (`planKnown: false` is its own answer, not a warning).
  Question length cap mirroring `MAX_QUEUE_ITEM_BODY`.

### src/services/agentPromptBuilder.ts

- **Context:** `ADVISE_RESEARCH_DIRECTIVE_HANDOFF` at `agentPromptBuilder.ts:1276-1281`
  instructs the seat to **POST `http://127.0.0.1:<port>/research/dispatch`**
  over raw HTTP — no `X-Switchboard-Client` marker, which
  `_isAllowedCrossSiteRequest` rejects. (Verified this pass: the constant says
  "POST to", not literally `curl`.) Same defect class Research-08 fixes in the
  member fragment.
- **Logic:** Rewrite the hand-off text: the planner writes the question into
  its plan file, then runs `switchboard research-request --plan <planId>
  --question "<one line>"`. The "dispatched:false → paste the prompt in chat"
  fallback is preserved — a 400/503/non-zero exit means the queue is not
  available and the planner falls back to chat-paste, exactly as before.
- **Edge Cases:** Verified this pass: `bundledProtocols.ts` carries NO copy of
  the instruction, and `TaskViewerProvider.ts` has none either — the constant
  is the only seat-facing dispatch text (`agentPromptBuilder.ts:2231` splices
  it into planner prompts; the `TaskViewerProvider.ts:7488` /
  `bootstrap.ts:5341` strings are the researcher-side `write_to_file` suffix —
  Research-04's scope). The gate is still a grep: zero `research/dispatch`
  instructions in seat-facing text after the edit.

## Verification Plan

### Automated Tests
- The verb resolves `requestedBy` from the environment; a seat cannot file as
  another seat (no `--from` path in the seat-facing text).
- `POST /research/request` returns 400 for a seat on no registered team, 400
  for a non-roster `from`, 200 + `requestId` + `position` for a valid filing.
- **The filed question is found in the plan file at filing time.** File a
  request whose `--question` text appears in the plan's `plan_file` → no
  warning. File one whose text does not → the row is still created with
  `state='queued'` and the response carries a `warning` naming the plan file.
  The check never refuses. A filing whose `planId` is unknown returns
  `planKnown: false` and no warning (there is no file to read).
- Filing returns immediately (no dispatch awaited inside the request).
- Grep gate: no seat-facing prompt text contains `POST /research/dispatch`
  or `curl` forms of it; the verb is the only documented path.
- The verb sets the client marker, so it does not 403 — asserted, because the
  raw HTTP equivalent does.

### Goal Invariants
- Assert `research-request` is present in `KNOWN_SUBCOMMANDS` and
  `HEAP_REEXEC_EXEMPT_SUBCOMMANDS`.
- Assert `ADVISE_RESEARCH_DIRECTIVE_HANDOFF` names `switchboard
  research-request` and contains no `curl`/`POST http` instruction (negative),
  paired with the positive: the same constant still carries the chat-paste
  fallback.
- Assert a filed row exists in `research_requests` with `requested_by` equal
  to the env seat, `state='queued'`.
- Assert the question-presence check is advisory, not a gate (paired): a filing
  whose `question` is **absent** from the plan file still creates a `queued`
  row (positive — the request is never lost to a missing line in a file the
  seat owns), while the response names the plan file in a `warning` (negative —
  the drift between the file and the queue row is surfaced, not silent).

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
