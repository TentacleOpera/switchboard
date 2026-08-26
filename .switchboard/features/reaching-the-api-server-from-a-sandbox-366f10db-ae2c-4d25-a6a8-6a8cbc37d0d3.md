# Reaching the API Server From a Sandbox

**Complexity:** 6

## Goal

Make the documented discovery path work from where agents actually run. The port file every dispatched agent is told to read goes missing from eligible workspace roots and never comes back, and sandboxed agents cannot reach loopback TCP at all because their sandbox blocks direct IP access. Repair the primary path first, then add a file-based transport for the sandboxes that will never have TCP.

## How the Subtasks Achieve This

- **The API server port file goes missing from eligible workspace roots** — repairs the documented primary discovery path that every dispatched agent is told to read.
- **Add file-based IPC transport to LocalApiServer for sandboxed agents** — a transport for sandboxes that block direct IP access and so can never reach loopback TCP; it cites the port-file plan directly.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [The API server port file goes missing from eligible workspace roots and never comes back](../plans/api-server-port-file-missing-from-eligible-roots.md) — **PLAN REVIEWED** — ID: 5a526a96-1d5f-4914-8e29-aed1a222bbdf
- [ ] [Add file-based IPC transport to LocalApiServer for sandboxed agents](../plans/add-file-based-ipc-transport.md) — **PLAN REVIEWED** — ID: 893d87be-c013-45fb-afcf-4e861a6acf18
<!-- END SUBTASKS -->

## Dependencies & sequencing

The port file lands first. It is the path that is supposed to work, and adding an alternative transport while the primary path is broken makes it impossible to tell which mechanism a given agent is actually using.

**Related plan left standalone.** *Sandbox-surviving board liveness via a Unix domain socket* is in CREATED and so is not a subtask here, but it addresses the same reachability problem from a third angle. Worth reviewing alongside this feature before either transport is built.

