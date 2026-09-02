---
description: 'Agent skills reach the API through the CLI'
---

# Agent skills reach the API through the CLI

**Complexity:** 6

## Goal

Move every agent-facing protocol, skill and workflow off `curl` / `sb_api_call.sh` and onto the
`switchboard` CLI, so there is one transport, one auth path and one offline message.

The layer is currently broken in a way no gate can see. `sb_api_call.sh` never sends an
`Authorization` header, so the moment a user runs `switchboard token set` every skill 401s while the
CLI keeps working — and two protocols instruct the agent to *"pass `Authorization: Bearer <token>`"*
with no mechanism behind the instruction. Thirty-eight files carry the HTTP transport; zero
reference a CLI subcommand.

## How the Subtasks Achieve This

- **`switchboard api` — one escape hatch so agent skills can leave curl behind**: adds
  `switchboard api <METHOD> <path> [json]`, the missing primitive. The CLI's `verb` only reaches
  `/terminals/verb/*` and `/kanban/verb/*`, while the skills call eleven plain REST paths across
  ClickUp, Linear, diagrams and worktrees. One general command lands in a day and unblocks every
  file, where thirteen named subcommands would all have to land before a single skill could move.
- **Retire `sb_api_call.sh`**: rewrites the thirty-eight files, migrates the eight
  `kanban_operations/*.js` scripts that open their own sockets, deletes the shim, and removes the
  four-line port-discovery preamble each file pastes at the top of every snippet — which is
  `findRunningInstance()` reimplemented in markdown, thirty-eight times.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Retire `sb_api_call.sh` — move every agent protocol, skill and workflow onto the CLI](../plans/migrate-agent-protocols-from-curl-to-the-cli.md) — **PLAN REVIEWED** — ID: 59e48bde-7139-4e01-bebd-bd158030b493
- [ ] [`switchboard api` — one escape hatch so agent skills can leave curl behind](../plans/switchboard-api-escape-hatch-in-the-cli.md) — **PLAN REVIEWED** — ID: 8aa2e928-19cc-46c6-8bce-3c68e7f67e35
<!-- END SUBTASKS -->

## Dependencies & sequencing

**Strictly ordered.** The escape hatch must land first: eleven of the routes these files call are
unreachable from `verb`, so migrating first would strand them on curl and leave two transports
documented — the state the feature exists to end.

The migration's own risk is a contract gate.
`src/test/mission-control-tick-and-reports-contract.test.js` greps the Mission Control persona and
runsheets by path and asserts on their content, because *"a persona is executable specification with
no compiler."* Rewriting them turns it red; adjusting it carelessly deletes the coherence checks it
exists to enforce. It is edited deliberately, in the same commit.

## Team Dispatch Instructions

### `switchboard api` — one escape hatch so agent skills can leave curl behind

- **Seat:** Intern (complexity 3 — single-file change reusing existing helpers)
- **Acceptance:**
  - `switchboard api` is in `KNOWN_SUBCOMMANDS` and excluded from `subcommandTargetsCwd` (reachability gate)
  - Against a stub server with a token file, the received request carries `Authorization: Bearer <token>`
  - `PUT`, `DELETE`, and `PATCH` reach the stub with the correct method; `workspaceRoot` is in the body for `PUT` and in the query string for `DELETE`
  - `--data @<file>` reads the file and sends its contents as the body
  - Path rejection: `http://evil.example/x` and `//evil.example/x` both exit 5 with no request issued
- **Must not touch:** `apiGet`/`apiPost` behaviour for their existing five callers (extraction is behaviour-preserving); `cmdVerb`'s verb-rail fallback logic

### Retire `sb_api_call.sh` — move every agent protocol, skill and workflow onto the CLI

- **Seat:** Coder (complexity 6 — multi-file migration with one delicate contract-gate edit)
- **Acceptance:**
  - No file under `.agents/` or `.claude/skills/` contains `sb_api_call`, `curl `, or `api-server-port.txt` (transport sweep gate)
  - `mission-control-tick-and-reports-contract.test.js` stays green with meaning-level assertions intact (Port Discovery section flips; protocol invariants stay)
  - Every migrated `switchboard …` invocation names a subcommand in `KNOWN_SUBCOMMANDS`
  - `move-card.js` and `create-feature.js` end-to-end against a stub server, asserting `Authorization` header is present
  - Bundle manifest: every path in `.switchboard-bundled.json` exists; `sb_api_call.sh` is absent
- **Must not touch:** Any endpoint, verb, or payload shape (transport rewrite only — method, path, and payload stay identical); protocol prose, personas, and decision rules (except where they describe the transport); the eight `kanban_operations/*.js` scripts' invocation contract (named by personas — internals only)
