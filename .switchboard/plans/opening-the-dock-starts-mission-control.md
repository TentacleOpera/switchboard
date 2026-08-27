# Opening The Dock Starts Mission Control: One Seat, One Path

## Goal

Make the agent dock the Mission Control surface it was always meant to be. Opening the
dock's controller occupant seats Mission Control and delivers the pre-flight interview
*into the dock terminal*, where the operator can answer it. The dock stops being a generic
shell spawner that happens to share the controller's seat identity.

### The problem, and the root cause

The dock and Mission Control already share one seat. `ptyFleetService.ts:36-39` maps both
roles to the same singleton identity:

```
['mission-control', 'controller'],
['project_manager', 'controller'],
```

and the dock defaults to `dockRole = 'project_manager'` (`shell.js:60`). `create()` consults
that identity before spawning, which is why a second controller cannot be minted. So the
dock's default occupant *is* the controller seat.

**What differs is what the two paths do with it.**

- `startDockTerminal()` (`shell.js:828`) POSTs `ptyCreateTerminal {role, name:
  'dock-<role>'}`. `ptyFleetService.create()` spawns a shell, waits
  `SHELL_READINESS_DELAY_MS` (750ms), and injects the role's configured startup command.
  Nothing more.
- `POST /mission-control/start` (`LocalApiServer.ts:5550`) *seats* Mission Control and
  delivers the pre-flight interview prompt, then the agent calls
  `POST /mission-control/confirm` once the operator answers, which is what arms.

So the dock hands you a shell that does not know it is a controller. Worse:
`project_manager` has **no default startup command**, so `injectStartupCommand()` returns
early (`ptyFleetService.ts:507`) and the bare shell exits immediately — the
`[Process Exited with code 0]` read-only dead-end with no restart path, on the dock's
*default* role. And `DOCK_SYSTEM_ROLES` (`shell.js:~757`) excludes `mission-control`
outright, so the controller role cannot even be chosen deliberately; you only ever reach
its identity sideways, through `project_manager`.

One seat identity, two spawn paths, one of which knows what a controller is. The root cause
is that the dock was built as a generic "one agent terminal beside the board" host, and the
controller was slotted into it as a role rather than as the thing the surface is for.

## Metadata
- **Complexity:** 6
- **Tags:** frontend, backend, api, ux, bugfix, feature
- **Feature:** 4c1323fb-a025-467f-b289-88f50b1f8347

## Supersedes and completes an existing plan

`fix-agent-dock-mission-controller-terminal.md` diagnosed this and opens with *"It is
intended to be a persistent terminal for the mission controller agent."* This plan takes
over its items 1, 3 and 4, and revises one:

- **Its item 1** — *"the dock toggle should be associated with the Mission Control UFO
  icon"* — is **void**. The UFO is deleted (rail restructure plan). The dock toggle moves to
  the top-right cluster instead, and the dock itself becomes the start affordance, which is
  what item 1 was reaching for.
- **Its item 4** (code-0 dead-end, no recovery) is fixed here as a consequence of routing
  through `/mission-control/start`: the clipboard branch means "no agent configured"
  produces launcher text instead of a dead shell.
- **Its item 5** (dock seat leaking into the panel sidebar *and* the rail) is half-fixed
  elsewhere: the rail restructure plan deletes per-terminal rail buttons, so only the panel
  sidebar half remains. That half stays in scope of the original plan, not this one.
- **Its item 2** (unstyled dock terminal) is untouched and remains valid there.

## User Review Required

No user review required — plan is in PLAN REVIEWED status and ready for dispatch.

## Complexity Audit

### Routine
- Replacing the `ptyCreateTerminal` call in `startDockTerminal()` with a `POST /mission-control/start` call for the controller occupant.
- Handling `mode: 'terminal'` response (mount terminal via `mountDockFrame`).
- Handling `mode: 'clipboard'` response (render prompt in empty state with copy action).
- Deleting `#dock-role-btn`, `#dock-role-menu`, `buildDockRoleMenu`, `fetchDockRoles`, `dockRolesCache`, `labelForRole`, `DOCK_SYSTEM_ROLES`, `loadDockRole`, and the `.dock-role-item` / `#dock-role-menu` CSS.
- Making `dockRole` a constant (the controller role) instead of mutable state.

### Complex / Risky
- Adopting before starting — if a controller is already seated (from `/switchboard-manage` skill, another shell tab, or a previous session), the dock adopts it and does NOT call start. The persisted `sb.agentDock.seat` may name a reviewer terminal from the picker era; the adopt check must confirm the persisted seat is the controller identity by checking the terminal's ROLE in the fleet data, not merely that it is live.
- The dock's state channel after relay deletion — the colour plan deletes the `missionControlState` relay from the rail. The dock needs to know whether the session is armed (for `#dock-title`). The plan says "read `autobanState.enabled` server-side" but does not specify the channel. The existing `autobanStateSync` WS broadcast is the likely channel; the plan should specify it.
- Dead endpoints after role picker retirement — `/setup/verb/getAgentDockRole` and `/setup/verb/setAgentDockRole` become dead. The plan should state whether they are deleted or left as dead endpoints. A dead endpoint is a maintenance trap.
- `missionControlStart` wiring in both composition roots — verified: wired in both `TaskViewerProvider.ts:4182` and `bootstrap.ts:2907`. The 503 concern is valid but the wiring exists.

## Edge-Case & Dependency Audit

**Race Conditions:**
- Double-click on the start affordance: the pending-request guard disables the button while the request is pending. The real protection is the singleton guard in `ptyFleetService.create()`. Two shell tabs or a reload mid-flight defeat the client flag.
- The interview arrives before the frame mounts: the seat is created server-side and the prompt delivered on its own schedule; the dock frame mounts after the response. The terminal's replay shows the prompt, but do not clear the terminal on mount or the interview is wiped.

**Security:**
- No new attack surface. The dock calls an existing endpoint (`POST /mission-control/start`) that is already used by the `/switchboard-manage` skill.

**Side Effects:**
- `/setup/verb/getAgentDockRole` and `/setup/verb/setAgentDockRole` become dead endpoints — no consumer after the role picker is retired. State explicitly whether these are deleted or left.
- `ptyVisibleRoles` was fetched only to label the picker and the empty-state hint. The fetch is deleted — one less request on first open.
- The `dock-<role>` seat naming convention collapses to a single controller seat name. The name is still whatever the server returns and still opaque.

**Dependencies & Conflicts:**
- **Dock-tabs plan** — its "hide the role picker on the kanban tab" item is moot; there is no picker. Whichever plan lands second must not re-add it.
- **Colour plan** — deletes the `missionControlState` relay. The dock's `#dock-title` state display needs its own channel (likely `autobanStateSync` WS broadcast).
- **Rail restructure** — deletes the UFO. The dock becomes the start affordance, which is what the UFO's item 1 was reaching for.

## Dependencies

- **Rail restructure** — deletes the UFO, making the dock the sole Mission Control start affordance. Can land in either order, but both must ship before the feature is complete.
- **Colour plan** — deletes the `missionControlState` relay. The dock must have its own state channel for `#dock-title` before or alongside the colour plan's relay deletion.
- **Dock-tabs plan** — must not carry `#dock-role-btn` / `#dock-role-menu` into the new tabbed header. This plan retires the picker; the tabs plan must not re-add it.

## Adversarial Synthesis

Key risks: (1) controller identity check for persisted seats — the adopt check must verify the terminal's ROLE (not just liveness) to avoid adopting a reviewer terminal as Mission Control. The fleet data should carry a `role` field; the plan should specify the check mechanism. (2) Dead endpoints after role picker retirement — `/setup/verb/getAgentDockRole` and `/setup/verb/setAgentDockRole` have no consumer; state whether they are deleted. (3) Dock state channel after relay deletion — the plan says "read `autobanState.enabled`" but does not specify the channel; `autobanStateSync` WS broadcast is the likely answer. Mitigations: (1) specify the role-check mechanism, (2) name the endpoints as dead or deleted, (3) specify the state channel.

## No migration

Clean break. `sb.agentDock` (`shell.js:DOCK_STATE_KEY`) keeps `open`, `width` and `seat`;
`seat` remains the server-returned `friendlyName`, treated as opaque — `PtyFleetService`
drops a requested name on collision and falls back to the `<role>-N` series, so nothing may
key on the `dock-` prefix (edge case 4). CLAUDE.md's migration rule is waived for this
release.

## Scope: both composition roots

`missionControlStart` is an **optional** option on `LocalApiServerOptions`
(`LocalApiServer.ts:~550`) and the handler returns 503 when it is absent. That is exactly
the seam class CLAUDE.md warns about — a `Promise`-returning hook where "never wired" and
"working" look identical from the client. Confirm it is wired in **both**
`TaskViewerProvider.ts` and `bootstrap.ts` before making the dock depend on it; if either
host leaves it unwired, opening the dock there yields a 503 and the dock is dead in that
host. Diff the two roots by hand.

## Implementation

1. **The dock's controller start routes through `/mission-control/start`.** Replace the
   `ptyCreateTerminal` call in `startDockTerminal()` for the controller occupant. The
   response has two modes and both must be handled in the dock, not in a toast:
   - `mode: 'terminal'` — a seat was created and the pre-flight interview delivered. Mount
     that terminal in the dock frame via `mountDockFrame(...)` using the `friendlyName` the
     server returned. The operator answers the interview in the dock, and the agent calls
     `/mission-control/confirm` itself. **The dock must not call confirm** — arming is the
     agent's move after the interview, and a UI that arms skips the interview it exists to
     run.
   - `mode: 'clipboard'` — no agent configured, no seat created. Render the returned
     `prompt` in the dock's empty state with a copy action and a one-line explanation, per
     `showDockEmptyState`. This replaces the current toast-and-forget
     (`shell.js:446-455`) and is what fixes the code-0 dead-end: the operator sees what to
     run instead of a dead shell.
   - failure — surface `result.error` in the empty state and leave the dock openable. Never
     leave the start button disabled after a failure.
2. **Adopt before starting.** The dock already adopts an existing live seat rather than
   creating one (`syncDockSeat`, and its comment: adopt, never implicitly create, with
   `lastFleet` as the only liveness oracle). Preserve that ordering exactly: if a
   controller is already seated — started from the `/switchboard-manage` skill, another
   shell tab, or a previous session — the dock adopts it and does **not** call start.
   Calling start on an already-seated controller would re-deliver the pre-flight interview
   to a controller mid-session.
3. **In-flight discipline.** Carry over the pending-request guard the UFO used
   (`shell.js:302-315`): disable the start affordance while the request is pending so a
   double-click cannot fire two starts, while the real protection stays the singleton guard
   in `ptyFleetService.create()`. A client flag was never sufficient there — two shell
   tabs, or a reload mid-flight, defeat it. **No confirmation dialog** (CLAUDE.md).
4. **The dock hosts the controller and nothing else — retire role selection entirely.**
   Delete `#dock-role-btn`, `#dock-role-menu`, `buildDockRoleMenu`, `fetchDockRoles`,
   `dockRolesCache`, `labelForRole`, `DOCK_SYSTEM_ROLES` and the `.dock-role-item` /
   `#dock-role-menu` CSS (`shell.html:539-556`). `dockRole` stops being mutable state and
   becomes the controller role constant; `dockSeatName()` loses its parameter.
   - The workspace-level persisted dock role setting (`loadDockRole`, and the setting it
     reads) goes with it. There is no role to persist.
   - `ptyVisibleRoles` was fetched only to label the picker and the empty-state hint. The
     empty state's hint text is now about Mission Control specifically, so the fetch is
     deleted too — one less request on first open.
   - Keep `mcp_monitor` excluded wherever else it is excluded; that exclusion is about the
     spawn pickers in `terminals.js` (`:951`, `:8068`) and is not this plan's business.
5. **The dock's title reflects the session, not just the seat.** `#dock-title` shows the
   opaque `friendlyName` today. For the controller occupant, show that the session is
   seated and awaiting confirmation versus armed — the state the `missionControlState`
   relay used to carry to the rail. If the rail's relay is deleted (colour plan), this is
   where that information should land instead of being lost.

## The dock is the controller's terminal. There is no choice to make.

This is settled, not offered: the dock shows the controller agent and nothing else.
`fix-agent-dock-mission-controller-terminal.md` item 3 named the problem — the picker
creates *"the impression the dock is a general 'start any agent' launcher"* — and this is
the resolution. A picker that can point the dock at a reviewer is a different feature
wearing the same chrome, and it is the reason the start path was ambiguous: with a picker,
"open the dock" would mean the session path for one role and the bare-spawn path for every
other, which is the split this plan exists to close.

Consequences elsewhere:
- **Dock-tabs plan.** Its "hide the role picker on the kanban tab" item is moot — there is
  no picker. Whichever plan lands second must not re-add it.
- **Starting other agents is unaffected.** The Terminals panel's new-terminal and fill-grid
  pickers (`terminals.js:951`, `:8068`) are untouched. Nothing loses the ability to start a
  reviewer; it just does not happen in the dock.
- **The `dock-<role>` seat naming convention collapses** to a single controller seat name.
  The name is still whatever the server returns and still opaque (see No migration).

## Edge cases

- **A controller seated outside the dock.** The `/switchboard-manage` skill calls
  `/mission-control/start` directly (`LocalApiServer.ts:550`). Opening the dock afterwards
  must adopt that seat, not start a second session.
- **Controller running, dock closed, then reopened.** Adoption path again — the persisted
  `seat` may name a terminal that has since exited; `syncDockSeat` already treats
  `light !== 'exited'` as the liveness test. Keep it.
- **`missionControlStart` unwired (503).** Present it as "Mission Control is not available
  in this host" in the empty state, not as a generic failure. A 503 here means a
  composition-root gap, and a clear message is what makes it findable.
- **Two shell tabs both opening the dock.** Both adopt the same singleton seat and both
  mount the same terminal. That is correct and already supported; confirm neither start
  fires.
- **The interview arrives before the frame mounts.** The seat is created server-side and the
  prompt delivered on its own schedule; the dock frame mounts after the response. The
  terminal's replay is what shows the prompt, so mounting late is fine — but do not clear
  the terminal on mount, or the interview is wiped before it is read.
- **`clearBeforePrompt` / prompt delivery is not this plan's business.** Do not add a
  second delivery path; the server owns it.
- **A persisted seat from a picker-era profile.** `sb.agentDock.seat` may name a reviewer
  or planner terminal chosen before the picker was retired. The adopt check must confirm the
  persisted seat is the controller identity, not merely that it is live — otherwise the dock
  adopts an unrelated agent's terminal and reports it as Mission Control. A non-controller
  persisted seat is discarded and the empty state shown.
- **Arming state is not derived client-side.** Whether the session is armed is
  `autobanState.enabled` server-side. Read it; never infer it from the fact that a seat
  exists.

## Verification plan

1. `npm run compile` clean.
2. Confirm `missionControlStart` is wired in both composition roots before anything else —
   read both files, do not infer from one working host.
3. Fresh workspace with a lead/coder agent configured: open the dock, confirm a controller
   seat is created, the pre-flight interview appears **in the dock terminal**, and answering
   it leads to the agent arming via `/mission-control/confirm`.
4. Fresh workspace with **no** agent configured: open the dock, confirm the launcher text
   renders in the empty state with a working copy action, and confirm **no dead shell and no
   `[Process Exited with code 0]`** — this is the acceptance test for the old dead-end.
5. Start Mission Control from the `/switchboard-manage` skill, then open the dock: confirm
   adoption, and confirm the interview is **not** re-delivered.
6. Double-click the start affordance: exactly one seat, one interview.
7. Open the dock in two shell tabs: one seat, both mounted, no second start.
8. Stop the controller from the Terminals panel (`btn-controller-stop`), then reopen the
   dock: confirm it offers to start again rather than mounting a dead frame.
9. Confirm the dock header has no role picker, and that the Terminals panel's
   new-terminal and fill-grid pickers still start every other role normally.
10. Seed `sb.agentDock.seat` with a live non-controller terminal name, then open the dock:
    confirm it is discarded and the empty state appears, rather than a reviewer's terminal
    being presented as Mission Control.
11. Both hosts.

### Goal Invariants

- Assert `startDockTerminal()` in `src/webview/shell.js` calls `POST /mission-control/start` (not `ptyCreateTerminal`) for the controller occupant.
- Assert `#dock-role-btn` is absent from `src/webview/shell.html`.
- Assert `#dock-role-menu` is absent from `src/webview/shell.html`.
- Assert `buildDockRoleMenu` is absent from `src/webview/shell.js`.
- Assert `fetchDockRoles` is absent from `src/webview/shell.js`.
- Assert `dockRolesCache` is absent from `src/webview/shell.js`.
- Assert `DOCK_SYSTEM_ROLES` is absent from `src/webview/shell.js`.
- Assert `loadDockRole` is absent from `src/webview/shell.js`.
- Assert `dockRole` is a constant (the controller role), not mutable state.
- Assert the dock handles both `mode: 'terminal'` and `mode: 'clipboard'` responses from `/mission-control/start`.
- Assert the dock does NOT call `/mission-control/confirm` — arming is the agent's move.
- Assert a persisted non-controller seat is discarded and the empty state appears (not adopted as Mission Control).
- Assert `POST /mission-control/start` endpoint is still present in `src/services/LocalApiServer.ts` (shared with the `/switchboard-manage` skill).
- Assert `missionControlStart` is wired in both `src/services/TaskViewerProvider.ts` and `src/standalone/bootstrap.ts`.
