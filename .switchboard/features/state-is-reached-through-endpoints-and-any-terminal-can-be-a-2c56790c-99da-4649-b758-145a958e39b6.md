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
- [ ] [Teams reach state through endpoints, never through host files](../plans/teams-reach-state-through-endpoints-not-host-files.md) — **CREATED** — ID: 71f78982-cf02-46cf-9308-d8926addd993
- [ ] [Generate channel-declaration text in the Connections tab for the user to paste into a cloud agent](../plans/user-declared-state-channels-as-a-skill.md) — **CREATED** — ID: b62b2e5d-45ed-4290-a6c8-1f13681d5e6d
- [ ] [Register an Agent Running in Any Local Terminal, by Letting It Pull Instead of Being Pushed](../plans/register-an-agent-in-any-local-terminal.md) — **CREATED** — ID: 6df5200a-3e42-46b3-b64b-17c770c47670
<!-- END SUBTASKS -->

## Dependencies & sequencing

The contract lands first — it defines the routes the other two subtasks extend and describe. Pull-registration and the channel-declaration generator are independent of each other.

**Soft prerequisite:** **Reaching the API Server From a Sandbox**. The contract is only usable where the port file is actually present, so a broken discovery path undercuts everything here.

