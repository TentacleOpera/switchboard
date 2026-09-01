---
description: 'Agent skills reach the API through the CLI'
---

# Agent skills reach the API through the CLI

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
- [ ] (no subtasks)
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
