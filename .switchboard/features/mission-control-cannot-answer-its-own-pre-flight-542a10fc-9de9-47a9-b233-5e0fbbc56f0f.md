# Mission Control Cannot Answer Its Own Pre-Flight

**Complexity:** 4

## Goal

Give the Mission Control persona the endpoints and output contract its own protocol already assumes.

The pre-flight asks whether a coding team is seated rather than a lone agent, and names no command - because none can exist. GET /health returns terminals as a flat array of names with no roles, no group membership, no head and no pacing, and the only reader of the roster is private with no route. The same gap breaks dispatch routing: where a card lands depends on the team pacing mode, which the protocol says the agent reads and does not set, and which it cannot read at all. So the agent either infers from terminal names or reaches for SQL, both of which the protocol forbids.

The persona is also told to check the terminal with no mechanism given, so it reconstructs terminal state by running commands while a markdown transcript of that terminal sits unread on disk with two endpoints no agent document mentions. And its report ends with a ready-card summary whose template is space-aligned columns that markdown collapses into one line, addressing cards by raw plan id with no token the operator can reply with.


## How the Subtasks Achieve This

- **Mission Control Cannot See Teams Over HTTP**: exposes the configured roster — groups, roles, head and `pacing` — over the local API. Today `GET /health` returns a flat array of terminal names and the only roster reader is private with no route, so pre-flight checks 1 and 2 cannot be instrumented and dispatch routing cannot be explained.
- **Terminal Logs Are Undocumented**: makes the on-disk markdown transcripts discoverable to the agents built to read them, and fixes the two log endpoints so they honour the workspace they are asked about. The persona is told to check the terminal with no mechanism given, so it runs commands instead.
- **The Ready-List Format Collapses When Rendered**: replaces whitespace-aligned columns — which markdown collapses to one line, because the spec shows them inside a code fence but never says to emit one — with a template that survives rendering and gives each card a reply token instead of a raw plan id.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [The ready-list format is space-aligned columns rendered as chat prose, so markdown collapses it into one line](../plans/the-ready-list-format-collapses-when-it-is-rendered.md) — **PLAN REVIEWED** — ID: 5d7dbf3c-8b12-47f9-b120-7f9f27cb1d30
- [ ] [Mission Control cannot see teams over HTTP, so it cannot answer its own pre-flight or read the pacing that routes work](../plans/mission-control-cannot-see-teams-over-http.md) — **PLAN REVIEWED** — ID: a01bf437-46d1-40b2-add1-eb5fc5c8b281
- [ ] [Terminal logs are markdown on disk with two read endpoints, and no agent document mentions either](../plans/the-terminal-logs-are-undocumented-so-agents-run-commands-instead.md) — **PLAN REVIEWED** — ID: 206aa17c-f801-4b42-9b1c-70eab29b9e42
<!-- END SUBTASKS -->

## Dependencies & sequencing

No hard ordering constraints; subtasks can be executed in parallel.

Two coordination points. The roster subtask unblocks pre-flight checks 1 and 2 and serves the dispatch-routing explanation, so it is the highest-value one to land first if any order is chosen. The ready-list subtask owns the tail of the same pre-flight report, so its output contract and the pre-flight text must agree — but it depends on nothing else.

Both the roster and terminal-log subtasks add endpoint documentation to `switchboard-mission-control-http/SKILL.md`. Expect a touch in the same file and sequence the edits rather than parallelising them. The terminal-log plan names a related file (`the-pre-flight-names-six-checks-and-supplies-one-command.md`) that its own review pass could not find in `.switchboard/plans/`; verify before treating that as a conflict.

Two constraints are absolute and stated in the plans: the agent must not infer pacing from plan complexity (it is a backend decision returned in the dispatch response), and it must not read the database. Removing the guesswork is the whole point of exposing the field.
