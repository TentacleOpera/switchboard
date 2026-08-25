# Two Endpoint Corrections - Buffer Reads and Adopt Scoping

**Complexity:** 5

## Goal

Two corrections to the endpoint surface agents use to observe and register. An external lead has no way to see what its coders are actually doing, so add a terminal buffer snapshot endpoint that returns current scrollback by terminal name. And the adopt call omits the workspace root entirely, so the server falls back to a default and scopes the adopting agent to the wrong workspace.

## How the Subtasks Achieve This

- **Terminal buffer snapshot API** — a GET endpoint returning a named terminal's current scrollback, so an external lead can observe what its coders are doing through the endpoint surface rather than guessing.
- **Orchestrator adopt call drops workspaceRoot** — passes the workspace root explicitly in the adopt body and adds a server-side diagnostic, so an adopting agent stops being scoped to whichever workspace the server defaulted to.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Terminal Buffer Snapshot API — `GET /terminals/:name/buffer`](../plans/feature_plan_20260818180000_terminal-buffer-snapshot-api.md) — **PLAN REVIEWED**
- [ ] [Orchestrator adopt call drops workspaceRoot — orchestrator scopes to the wrong workspace](../plans/fix-orchestrator-adopt-workspace-root.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

No ordering constraints; two independent corrections to the same endpoint surface. Both are consistent with the contract established by **State Is Reached Through Endpoints, and Any Terminal Can Be a Seat**, but neither depends on it.

