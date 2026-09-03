# Reaching the API Server From a Sandbox

<!-- board-collapse-01b -->
> **PATH CORRECTION 2026-09-04 (Board Collapse 01).** This file names `.agents/skills/_lib/sb_api_call.sh`, which was **deleted** in commit `96fb16df`. All eight `kanban_operations/*.js` scripts now share `.agents/skills/_lib/cli-call.js`, and `switchboard api` is the shell-side escape hatch. Read every `sb_api_call` reference below as `cli-call.js` / `switchboard api`, and do not restore the shell helper.


**Complexity:** 6

## Goal

Make an agent that Switchboard did not spawn able to actually use the local API — which takes three things, and today all three are broken: it must **find** the server, **reach** it, and **authenticate** to it.

The port file every dispatched agent is told to read goes missing from eligible workspace roots and never comes back. Sandboxed agents cannot reach loopback TCP at all, because their sandbox blocks direct IP access. And once reached, the server refuses them: under `npx switchboard` the token exists only in memory and is injected solely into shells the host itself spawned, so a CLI session the operator started, a cloud session, an MCP server, a git hook or a plain `curl` gets a 401 with no way to do better. Not one shipped in-tree client sends an `Authorization` header at all.

Repair the primary discovery path first, then the credential, then add a file-based transport for the sandboxes that will never have TCP.

> **Note on the title.** This feature is named for its first two subtasks; its scope is now the whole reach-and-authenticate path. The card cannot be renamed durably until *Renaming a card is a supported operation* (PLAN REVIEWED) lands — a DB topic write reverts on the next watcher pass — so the scope is stated here instead.

## How the Subtasks Achieve This

- **The API server port file goes missing from eligible workspace roots** — repairs the documented primary discovery path that every dispatched agent is told to read.
- **Add file-based IPC transport to LocalApiServer for sandboxed agents** — a transport for sandboxes that block direct IP access and so can never reach loopback TCP; it cites the port-file plan directly.
- **Out-of-process agents cannot authenticate to the standalone API** — mints a separate agent token at boot and publishes it to `.switchboard/api-server-token.txt` at `0600`, wired in **both** composition roots. Without it there is no credential for a non-fleet process to present.
- **No shipped Switchboard client sends an Authorization header** — gives `sb_api_call.sh` and the seven `kanban_operations/*.js` scripts one shared discovery routine per language, and makes a 401 report itself as a 401 rather than as "the extension isn't running".
- **Generated agent prompts and skill docs tell agents to call the API with no credential** — corrects the 39 instruction sites across 11 source files that tell an agent to POST to the port in `api-server-port.txt` without naming a credential, so the system's own instructions become true under both hosts.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [The API server port file goes missing from eligible workspace roots and never comes back](../plans/api-server-port-file-missing-from-eligible-roots.md) — **PLAN REVIEWED** — ID: 5a526a96-1d5f-4914-8e29-aed1a222bbdf
- [ ] [Add file-based IPC transport to LocalApiServer for sandboxed agents](../plans/add-file-based-ipc-transport.md) — **PLAN REVIEWED** — ID: 893d87be-c013-45fb-afcf-4e861a6acf18
- [ ] [Generated agent prompts and skill docs tell agents to call the API with no credential — correct the instructions and the 401 diagnostics](../plans/agent-api-auth-instructions-and-diagnostics.md) — **PLAN REVIEWED** — ID: 98c5a2b2-bd64-4571-bd58-9d6a9e8c1bff
- [ ] [Out-of-process agents cannot authenticate to the standalone API — publish a separate agent token as a 0600 discovery file](../plans/publish-agent-api-token-for-out-of-process-agents.md) — **PLAN REVIEWED** — ID: e3180e4e-496f-4e07-af71-c6de6c198bfc
- [ ] [No shipped Switchboard client sends an Authorization header — add shared token discovery to sb_api_call.sh and the kanban_operations scripts](../plans/switchboard-clients-send-api-auth-header.md) — **PLAN REVIEWED** — ID: dd711e9c-33a3-4581-a9a4-05108b29fc7e
<!-- END SUBTASKS -->

## Dependencies & sequencing

The port file lands first. It is the path that is supposed to work, and adding an alternative transport while the primary path is broken makes it impossible to tell which mechanism a given agent is actually using.

Then the credential, in order: **publish the agent token** before **the clients that present it** — without the token file the clients' second precedence tier resolves nothing and the standalone path stays broken. The instructions plan may ship at any point; its fallback branch keeps it correct beforehand, and its verification of the token file is deferred until that file exists.

The file-based transport lands last. It is the only subtask that is not needed on a host with working TCP.

**This feature currently contains its own reproduction.** `assign-to-feature.js` returns `{"ok":false,"error":"Unauthorized"}` when run against the standalone host — the exact defect its own subtask describes. The three plans above had to be attached via `POST /kanban/feature/assign` with a session cookie instead. Treat that as the acceptance test: when the client plan lands, that script must work unaided.

**Related plan left standalone.** *Sandbox-surviving board liveness via a Unix domain socket* is in CREATED and so is not a subtask here, but it addresses the same reachability problem from a third angle. Worth reviewing alongside this feature before either transport is built.

