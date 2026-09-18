# State Is Reached Through Endpoints, and Any Terminal Can Be a Seat

**Complexity:** 7

## Goal

Establish one access contract - agents reach state through the LocalApiServer's endpoints, using the port the host already put in their prompt, never through host files - and then widen who can use it. An agent already running in any local terminal registers itself by pulling rather than being pushed, and the Connections tab can generate a paste-able description of this workspace's routes for an agent that has no filesystem at all.

## How the Subtasks Achieve This

- **Teams reach state through endpoints, never through host files** — the access contract itself, and the removal of every agent instruction that names a host file instead of an endpoint.
- **Register an agent running in any local terminal, by letting it pull instead of being pushed** — makes a plain shell, a tmux pane or an editor chat pane into an addressable seat.
- **Generate channel-declaration text in the Connections tab** — produces a paste-able description of this workspace's routes to state, for a cloud agent that has no filesystem access at all.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Teams reach state through endpoints, never through host files](../plans/teams-reach-state-through-endpoints-not-host-files.md) — **COMPLETED** — ID: 71f78982-cf02-46cf-9308-d8926addd993
- [ ] [Generate channel-declaration text in the Connections tab for the user to paste into a cloud agent](../plans/user-declared-state-channels-as-a-skill.md) — **COMPLETED** — ID: b62b2e5d-45ed-4290-a6c8-1f13681d5e6d
- [ ] [Register an Agent Running in Any Local Terminal, by Letting It Pull Instead of Being Pushed](../plans/register-an-agent-in-any-local-terminal.md) — **COMPLETED** — ID: 6df5200a-3e42-46b3-b64b-17c770c47670
<!-- END SUBTASKS -->

## Dependencies & sequencing

The contract lands first — it defines the routes the other two subtasks extend and describe. Pull-registration and the channel-declaration generator are independent of each other.

**Soft prerequisite:** **Reaching the API Server From a Sandbox**. The contract is only usable where the port file is actually present, so a broken discovery path undercuts everything here.

## Team Dispatch Instructions

### Teams reach state through endpoints, never through host files

- **Seat:** Intern (complexity 2)
- **Acceptance:**
  - Every role that receives a queue order also receives the `SWITCHBOARD LIVENESS_DIRECTIVE` (port line) in its prompt.
  - No active agent-facing instruction names `api-server-port.txt` or `kanban.db`, excluding the explicit allowlist (legacy recogniser constants, `KanbanProvider` degenerate fallback, host-side port-file readers).
  - The access contract is stated in one place: team agents use endpoints; the port comes from the `SWITCHBOARD STATUS` line; the DB is host-owned; `GET /catalog` is the endpoint reference.
  - The grep gate passes with the allowlist.
- **Must not touch:** Legacy recogniser constants (`PRE_REWRITE_CALLBACK_INSTRUCTION`, `LEGACY_CONTEXT_AWARE_COMPLETION_ORDER_BODY`, `LEGACY_CONTEXT_AWARE_COMPLETION_ORDER_BODY_V2`) in `teamWiring.ts` and their mirror in `terminals.js` — these must keep old text for migration matching. Non-team guidance (owned by `skills-declare-preconditions-and-degrade.md`).

### Generate channel-declaration text in the Connections tab for the user to paste into a cloud agent

- **Seat:** Intern (complexity 3)
- **Acceptance:**
  - The generated text contains no credential, token, or API key.
  - Every entry in the output contains a verification step and a fallback; no entry asserts availability.
  - Nothing is written to the repository (`.agents/`, `.claude/`, or committed files) — the only output is the existing `.switchboard/switchboard-spark.md` file, extended with a read-state channels section.
  - The read-state channels section is added to `SparkContextExporter`'s output, not a new surface.
- **Must not touch:** `AgentSkillExporter` and `ClaudeCodeMirrorService` — the plan explicitly rejects using these (silently-ageing artefact in the repo). Per-skill preconditions (owned by `skills-declare-preconditions-and-degrade.md`).

### Register an Agent Running in Any Local Terminal, by Letting It Pull Instead of Being Pushed

- **Seat:** Lead Coder (complexity 7)
- **Acceptance:**
  - Route tests pass: register → heartbeat → inbox → done, with token rejection on missing/wrong per-seat token (not reachable via loopback trust).
  - Registration of a name that already resolves in the VS Code registry or the fleet is refused; the existing row is untouched.
  - `_isFleetTerminalInfo` returns false for a `purpose: 'external'` row; `_pickTerminalCandidate` places it at its stated rank (below live-vscode, above dead-fleet).
  - A state round-trip preserves an unknown `purpose` value rather than dropping it.
  - The dispatch result for an external seat reads `queued`, not `delivered`.
- **Must not touch:** The existing `ptySendPrompt` / `vscode.Terminal.sendText` delivery paths — this plan adds a pull path, not a push path. The `tmux-bridge` plans (complementary, not competing).

