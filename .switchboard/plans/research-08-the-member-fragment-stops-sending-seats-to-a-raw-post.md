# Research 08 — The Member Fragment Stops Sending Seats to a Raw POST

Subtask of the feature **A Research Request Is Queued Inside the Team, and Answered Back to the Planner That Asked** (`cf5537c5`). The feature file carries the full argument and the constraints binding every subtask. This plan is self-sufficient on its own scope and, where the two disagree, **this plan wins** — it is the source of truth for the seat implementing it.

## Goal

The member completion fragment's Route 2 is a CLI verb, and its promise matches
what its payload can carry.

## Problem — three defects that invert on capability

`buildMemberCompletionFragment` (`standingOrderFragments.ts:94`) gives three
EXCLUSIVE routes. A researcher never has a PLAN_ID, so it always lands on Route 2:

1. **Route 2 403s when followed literally.** It is a raw HTTP POST with no
   `X-Switchboard-Client` marker. The live researcher got
   `403 Access denied: cross-site request rejected`, guessed a workaround
   (`Origin: http://127.0.0.1:7777`) and retried.
2. **Route 2 carries no content.** `_handleTeamQueueDone` reads exactly `from`
   and `planId` (`LocalApiServer.ts:9663-9669`); the relay it composes is a bare
   notification (`LocalApiServer.ts:9696`). The orders promise *"the system will
   relay your report"*. There is no report in the payload.
3. **Exclusivity then suppresses Route 3**, the only route carrying
   `"data":"<your report>"`. The live researcher declined it deliberately:
   *"Route 2 succeeded, so sending this too would have been the duplicate-prompt
   failure the orders warn about."*

**These invert on capability:** the 403 would have pushed a weaker seat to Route 3
and its findings would have arrived. **So repairing the 403 alone makes the system
strictly worse** — it closes the accidental escape hatch. Fix the content first.

The same raw POST also appears in `buildHeadNextFragment`
(`standingOrderFragments.ts:181`) — the head's next-item path. Same endpoint,
same defect, same fix.

## Metadata

- **Tags:** backend, api, cli, bugfix
- **Complexity:** 4
- **Project:** Orchestration

## User Review Required

- None.

## Complexity Audit

### Routine
- One optional body field on `_handleTeamQueueDone` and one interpolated string
  in the relay it already composes.
- One new CLI subcommand on the `cmdDone` template (`cli.ts:2642`): flag parse,
  `SWITCHBOARD_TERMINAL` identity with the loud named-variable failure
  (`cli.ts:2670-2689`), `apiPost` (sets `X-Switchboard-Client` at `cli.ts:684`),
  `dispatchExitCode`, `emitJson`; registration in `KNOWN_SUBCOMMANDS`
  (`cli.ts:4238`) and `HEAP_REEXEC_EXEMPT_SUBCOMMANDS` (`cli.ts:4187`) plus
  `usage()` and the `main()` dispatch arm.

### Complex / Risky
- Ordering is a correctness property, not a preference: the `report` field and
  the relay must exist **before or with** the verb, never after — a verb that
  delivers a report the handler drops recreates defect 2 under a compliant
  client.
- Stale `member-orders.md` files on disk keep the old raw-POST text until the
  team's standing orders are next applied. That is today's failure mode, not a
  new one — but the endpoint MUST keep accepting `{from}`-only posts so a
  marked client without a report still completes the route.

## Edge-Case & Dependency Audit

- **Race Conditions:** None new — `_handleTeamQueueDone` already serializes on
  `_teamQueueDoneChains` (`LocalApiServer.ts:9654`).
- **Security:** `report` is seat-supplied free text rendered into a prompt to
  the head — cap it (`MAX_QUEUE_ITEM_BODY`, `TeamQueueService.ts:36`, is the
  in-repo precedent; 256KB) and interpolate verbatim, no shell anywhere.
- **Side Effects:** Relay message gains the report body; everything else in the
  handler is untouched.
- **Dependencies & Conflicts:** None upstream. Research-02 does the analogous
  rewrite for `ADVISE_RESEARCH_DIRECTIVE_HANDOFF` — different constant,
  different file section; no shared lines.

## Dependencies

- None. This subtask is independent of the research queue and can land in any
  position relative to Research-01..07.

## Adversarial Synthesis

Key risks: shipping the verb before the relay carries `report` (ordering is
enforced by doing both in this plan), and forgetting `buildHeadNextFragment`
(the same raw POST one function down — the grep gate catches it). The fix is
deliberately minimal: a field, a verb, two fragment strings, a gate.

## Proposed Changes

### src/services/LocalApiServer.ts — content first

- **Context:** `_handleTeamQueueDone` (`LocalApiServer.ts:9641`), body parse at
  9662-9669, relay composition at 9696-9699.
- **Logic:**
  1. Parse `report`: optional string, trimmed, capped at `MAX_QUEUE_ITEM_BODY`
     (413 over the cap — the request is malformed, not queueable).
  2. When present, the relay becomes
     `[queue/done] ${from} reports: ${report}` + the existing
     `(plan …)` / context-preserved / acceptance suffixes. When absent, the
     relay is exactly today's notification — `report` is optional so every
     existing caller keeps working.
  3. The relay's comment block should note: the report body is why Route 2
     exists — the promise "the system will relay your report" now matches the
     payload.
- **Edge Cases:** Non-string `report` → 400 with a named error; the seat
  retries with a string. A silently dropped supplied report is the defect this
  plan exists to kill — ignoring it would read exactly like success.

### src/standalone/cli.ts — then the verb

- **Logic:** `switchboard queue-done --team <teamId> --report "<one line>"
  [--from <seat>] [--plan <planId>] [--json]`. Identity from
  `SWITCHBOARD_TERMINAL` exactly as `cmdDone`; `--from` override for
  hand-driving; missing identity → the same loud named-variable failure.
  `--team` required (the fragment interpolates it — the seat never types it);
  `--report` required (a reportless Route 2 is defect 2 — a usage error
  locally, never a round trip). POSTs
  `/terminals/teams/<teamId>/queue/done` with `{ from, report, planId? }`.
- **Edge Cases:** Offline board → same "No running Switchboard instance" path
  as `cmdDone`, echoing resolved `from`/`fromSource`.

### src/services/standingOrderFragments.ts — then the text

- **Logic:**
  - `buildMemberCompletionFragment` Route 2 becomes:
    `run node "<cliPath>" queue-done --team <teamId> --report "<your one-line report>"`
    (the fragment already interpolates `ctx.teamId`; the `<cliPath>` placeholder
    convention matches the Route 1/3 text). The promise text is unchanged —
    it is now true.
  - `buildHeadNextFragment`'s `Otherwise POST …` arm becomes the same verb.
  - Grep `src/` for `POST /terminals/` and `queue/done` in seat-facing strings
    after the edit — zero hits outside code is the gate.
- **Edge Cases:** On-disk `.switchboard/teams/<id>/member-orders.md` files are
  regenerated the next time standing orders are applied; stale copies keep the
  old text and keep failing exactly as they do today — no regression, no
  migration needed for an unreleased surface.

## Verification Plan

### Automated Tests
- POST `/terminals/teams/<id>/queue/done` with `{from, report}` → the head's
  relayed prompt contains the report body verbatim.
- Same POST without `report` → today's bare notification (backward compat).
- `report` over `MAX_QUEUE_ITEM_BODY` → 413; non-string `report` → 400.
- `switchboard queue-done` sets the client marker (via `apiPost`) — following
  the fragment literally does not 403. Assert the raw-HTTP equivalent does 403
  so the marker is what is being tested.
- Grep gate: no seat-facing fragment or prompt text under `src/` contains
  `POST /terminals/` or a raw-HTTP `queue/done` instruction.

### Goal Invariants
- Assert `queue-done` is present in `KNOWN_SUBCOMMANDS` and
  `HEAP_REEXEC_EXEMPT_SUBCOMMANDS` (positive), paired with: `POST /terminals/`
  absent from `buildMemberCompletionFragment` and `buildHeadNextFragment`
  output (negative).
- Assert the relay text includes the `report` value when supplied (positive:
  the promise now matches the payload).

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
