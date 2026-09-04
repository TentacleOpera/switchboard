# The /switchboard front door

**Complexity:** 6

## Goal

Typing /switchboard must reach the right board, prove it is alive, and present one coherent menu. Eight cards across four features rewrote the same workflow file and the same CLI entry. Landing order is stated in Dependencies and is not optional: identity before liveness, liveness before the front-door repair, and the run sheet after both.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Make standalone the first-class entry point: `/switchboard` launches or attaches instead of demanding an IDE](../plans/standalone-first-launch-instead-of-demanding-an-ide.md) — **CREATED** — ID: 0c2eb71d-9f39-4f6e-8841-c4a241874ef0
- [ ] [Sandbox-Surviving Board Liveness via a Unix Domain Socket](../plans/sandbox-surviving-board-liveness-via-unix-socket.md) — **CREATED** — ID: 0da8db54-0ac8-4d83-9090-640ec099ed37
- [ ] [`/switchboard` accepts any board on the shared port and adopts the wrong workspace — verify identity on both sides of the adopt call](../plans/switchboard-launcher-adopts-the-wrong-workspace.md) — **CREATED** — ID: 928f142e-89b8-4a6d-8d5b-abbe3800258f
- [ ] [Replace the Mission Control persona with a run sheet that asks what you want and loads only that protocol](../plans/replace-the-mission-control-persona-with-a-run-sheet.md) — **CREATED** — ID: 254f724e-df9c-45e4-b4fc-e9c400eadc99
- [ ] [The /switchboard front door arms against an endpoint that does not exist, delivers the persona twice, and hardcodes the wrong posture](../plans/the-mission-control-front-door-delivers-twice-and-lies-about-the-posture.md) — **CREATED** — ID: 135f2c7b-a953-4a03-ba70-5e20928b97e3
- [ ] [Split the CLI Front-Door Menu into GUI and CLI Branches](../plans/split-cli-front-door-menu-into-gui-and-cli-branches.md) — **CREATED** — ID: 759c05b5-1092-45c6-869a-fc6726e4cb5e
<!-- END SUBTASKS -->

## Dependencies & sequencing (2026-09-04, Board Collapse 08)

Eight cards across four features rewrote the same `/switchboard` workflow file and the same CLI
entry point. Land in this order; it is not optional, because each step is what makes the next one's
check meaningful.

1. **`/switchboard` accepts any board on the shared port and adopts the wrong workspace** — identity
   first: require `$ROOT ∈ health.roots` before using a board, and validate `workspaceRoot` on both
   sides of the adopt call. *Orchestrator adopt call drops workspaceRoot* has been merged into this
   plan and deleted; it fixed the same call from another feature.
2. **Liveness** — *Sandbox-Surviving Board Liveness via a Unix Domain Socket*, now **one card**.
   The two plans that split this question were merged on 2026-09-04: the socket answers "is it
   dead" (a socket dies with the process, so a sandbox that cannot reach loopback TCP can still
   tell a live board from a stale port file), and the heartbeat file answers "is it alive but not
   serving" (written on the main loop so it starves when the loop does, with a wedge threshold and
   a `stop` path that no longer gates on `/health`, which is false by definition when wedged).
3. **The front door arms against an endpoint that does not exist** — repair the dead
   `POST /orchestration/confirm`, the legacy paths, and the doubled persona delivery.
4. **Replace the Mission Control persona with a run sheet** — carries the single recovery rung from
   decision 9 in its resume branch. Lands on step 3's edits to the same file.
5. **Make standalone the first-class entry point** — `/switchboard` launches or attaches instead of
   demanding an IDE. Rescoped by Board Collapse 02: it edits both control-plane trees directly and
   cites the drift test, since the mirror generator is being deleted.
6. **Split the CLI Front-Door Menu into GUI and CLI branches** — one menu. The navigable-console
   half of this work already shipped and its card is in Completed; verify before authoring.

*Mission Control* keeps the ready-flag and supervision subtasks. *Standalone Distribution* keeps npm
publish and attach. *Two Endpoint Corrections* is dissolved; its buffer-snapshot subtask is loose.
