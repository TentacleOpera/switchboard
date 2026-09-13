# Liveness the Fleet Surfaces Can Be Trusted On

**Complexity:** 5

## Goal

Three operator-facing surfaces — the `switchboard fleet` CLI, the phone command surface, and the dock Fleet tab — each report liveness they cannot actually know: the CLI shows `active` for every live shell regardless of activity; the command surface re-arms into a blind retry on a dropped connection and claims a delivery it has no evidence of; and the Fleet tab blanks the whole panel when one of two sources is down, hides how stale its data is, and loses all hop history on restart. This feature makes the liveness those surfaces report trustworthy — derived from real heartbeats, honest about what it does not know, and durable across restarts.

## How the Subtasks Achieve This

- **Fleet Status: Derive Activity from Heartbeat Instead of Process Liveness**: Replaces the CLI's binary `active`/`exited` STATUS with a derived `working`/`idle`/`stale`/`exited` state from the `lastDataAt` heartbeat already in the `ptyListTerminals` response. Introduces a `stale` state so a frozen heartbeat (positive and never advancing) is never mistaken for "at rest" — the load-bearing fix that keeps the display from reproducing the defect with the opposite wrong answer.
- **The Command Surface Re-Arms After an Unknown Outcome, Claims a Delivery It Cannot Know, and Is Locked to One Workspace**: Stops the phone surface from blind-re-arming on a dropped connection by closing the double-dispatch race with server-side idempotency-key dedup on `/kanban/advance`, replaces the overclaiming "Dispatched to" chip with honest sent/delivered vocabulary, makes the workspace selector genuinely multi-workspace via a new `/workspaces` read route with per-card `workspaceRoot` in the push projection, and adds the first unit tests for two pure functions the UI cannot fully exercise.
- **The Fleet Tab Blanks on a Half-Dead Host, Hides Its Own Staleness, and Loses Hop History on Restart**: Degrades the dock Fleet tab per source (board up + pty host down reports the pty host down, not "board unreachable"), renders the already-served `evaluatedAt` so the operator sees data age, and persists hop reasons/feed to a new `hop_history` table so they survive restart and are queryable beyond the old 50-entry in-memory cap.

## Dependencies & sequencing

- **Subtasks are independent and can land in any order.** Each touches a disjoint surface: subtask 1 edits `src/standalone/cli.ts` (`cmdFleet`); subtask 2 edits `src/webview/command.js` plus test files; subtask 3 edits `src/webview/dock.js`, `src/webview/dock.html`, `src/services/TaskViewerProvider.ts`, and `src/services/KanbanDatabase.ts`. No file is contended by more than one subtask.
- **Within subtask 3**, Change 3 (the `hop_history` schema) can land independently of Changes 1 and 2 (the render fixes) — it is the largest piece and is self-contained.
- **Prerequisite for subtask 1's manual verification**: the running host must include the `GoPtyFleetProjection` binary-frame fix (goPtyFleetProjection.ts:658-682) so `lastDataAt` actually advances. The fix is in source; the prerequisite is a rebuilt host, not a code change in this feature.
- **Subtask 2 Change 4 (UAT)** is deferred until the board-payload work lands (it changes what the surface fetches); it is a verification pass, not a code deliverable, and does not gate the other changes.
- **Subtask 2 Change 1** lands server-side idempotency-key dedup on `/kanban/advance` / the acked-mission path in scope — the client generates a fresh UUID per gesture and the server dedupes on it, closing the double-dispatch race.
- **Subtask 2 Change 3** adds a `/workspaces` read route and emits `workspaceRoot` per card in the push projection, making the selector genuinely multi-workspace.

## Team Dispatch Instructions

### Fleet Status: Derive Activity from Heartbeat Instead of Process Liveness
- **Seat:** Intern (complexity 3 — single-file CLI presentation change with one design decision).
- **Acceptance:**
  - `cmdFleet`'s STATUS cell is derived from `lastDataAt`, not raw `t.status` — a seat with a recent heartbeat renders `working`, not `active`.
  - A seat with an implausibly-old (frozen) heartbeat renders `stale`, never `idle`.
  - `switchboard fleet --json` includes `activityState` and `secondsSinceLastData` additively, and raw `status` is still present.
  - An older server response lacking `lastDataAt` falls back to raw `status` without errors.
- **Must not touch:** `src/standalone/ptyFleetService.ts`, `src/standalone/bootstrap.ts`, `src/services/goPtyFleetProjection.ts`, `src/standalone/ptyHost.ts`, `LocalApiServer.ts` — the change is CLI presentation only; the `ptyListTerminals` response already carries `lastDataAt`. (Exception: a small additive `/health` exposure of `livenessWindowMs` is acceptable if the coder chooses to read the server's value rather than hardcode a fourth copy.)

### The Command Surface Re-Arms After an Unknown Outcome, Claims a Delivery It Cannot Know, and Is Locked to One Workspace
- **Seat:** Coder (complexity 5 — multi-change single file plus server-side dedup and a new `/workspaces` route).
- **Acceptance:**
  - The three unknown-outcome sites (mission, team, advance) do not blind-re-arm on a dropped connection; a retry carries an idempotency key and the server dedupes on it (no double-dispatch).
  - The dispatch chip renders "sent"/pending vocabulary, not "delivered", from `dispatched_at` alone.
  - The workspace selector lists every workspace from the `/workspaces` route; switching it filters cards by the real per-card `workspaceRoot` (no constant fallback).
  - `src/test` contains assertions over `filterByProject` and `resolveTeamSeats`, including the two-lead roster refusal case the UI cannot reach.
- **Must not touch:** None specified — the plan is scoped to `src/webview/command.js`, the test files, the `/kanban/advance` server dedup, and the new `/workspaces` route + push-projection `workspaceRoot` change. Change 4 (UAT) is deferred and must not be run before the board-payload work lands.

### The Fleet Tab Blanks on a Half-Dead Host, Hides Its Own Staleness, and Loses Hop History on Restart
- **Seat:** Coder (complexity 4 — render fixes plus a schema addition with write/read paths).
- **Acceptance:**
  - With the board running and the pty host stopped, the Fleet tab reports the pty host down and still renders board-derived state — it does not claim the board is unreachable.
  - The hop-reason spans are visible in the degraded state, not written into a hidden container.
  - The Fleet tab renders `evaluatedAt` as a data-age indicator that moves as the 60s poll runs.
  - `hop_history` rows survive a restart and can be read back for a period longer than 50 entries.
- **Must not touch:** None specified. Change 3 (schema) takes the next free migration version at implementation time; do not reserve one. Clean break — no data migration of in-memory-only state.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Fleet Status: Derive Activity from Heartbeat Instead of Process Liveness](../plans/fleet-status-derive-activity-from-heartbeat.md) — **PLAN REVIEWED** — ID: 7fe3401f-a1ca-4d58-a620-6ca5bc12b559
- [ ] [The Command Surface Re-Arms After an Unknown Outcome, Claims a Delivery It Cannot Know, and Is Locked to One Workspace](../plans/memo-the-command-surface-can-fire-twice-and-claims-delivery-it-cannot-know.md) — **PLAN REVIEWED** — ID: f824db44-117d-4b46-b184-264676d4d9f7
- [ ] [The Fleet Tab Blanks on a Half-Dead Host, Hides Its Own Staleness, and Loses Hop History on Restart](../plans/memo-the-fleet-tab-blanks-on-a-half-dead-host-and-hop-history-dies-with-the-process.md) — **PLAN REVIEWED** — ID: 1fdcc41d-1f20-4c05-bcb7-6ff7a3a05fe8
<!-- END SUBTASKS -->
