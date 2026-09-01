---
description: 'Shell Cockpit Restructure'
---

# Shell Cockpit Restructure

**Complexity:** 6

## Goal

Rebuild the browser shell's chrome around what the operator actually does, instead of
around the order features happened to be added. The left rail becomes a fixed-height
navigation surface with a declared hierarchy: five primary panels, three fixed team slots,
four cold panels at the foot. Everything that is not navigation leaves the rail for a
floating top-right cluster. One colour carries one meaning. The right-hand dock becomes the
Mission Control surface it was always intended to be, and grows a second tab for the
terminals kanban pane. Linear gets the dedicated panel its expansion needs.

Today the rail is roughly sixteen buttons in a 48px column with no hierarchy, growing with
process count, painted in five competing hues, and hosting three controls that navigate
nowhere. The dock and the Mission Control controller already share one seat identity but
reach it by two different code paths, only one of which knows what a controller is.

## How the Subtasks Achieve This

- **Shell Rail Restructure: A Primary Group, A Cold Group, And No Process List**: Replaces
  the single optional `placement` marker with a required group key, reorders the manifest
  into primary and cold groups, and deletes the theme toggle, the UFO Mission Control
  button and the per-terminal buttons. This is the structural foundation — every other rail
  subtask assumes its groups exist.
- **A Top-Right Control Cluster For The Shell's Non-Navigational Controls**: Adds the
  shell's first chrome region outside the rail, hosting the dock toggle, Setup, Memo and
  Connections. Gives the four controls the rail could not express an affordance for a home,
  and puts the dock toggle on the same side as the dock.
- **One Colour In The Rail: Theme-Accent Team Icons, No Status Palette**: Collapses six
  treatments and five hues into one. Selection becomes a shape so the theme accent belongs
  to team icons alone, and the completion ring, queue badge and exited grayscale are
  deleted — which also removes the rail's last claim on completion state.
- **Three Fixed Team Slots In The Rail, Present Whether Or Not The Team Is Running**: Binds
  three slots to team definitions by id rather than to whatever is spawned, so the rail's
  height stops being a function of fleet state and a team can be started from the rail
  instead of only from a panel.
- **The Team In-Flight Predicate Already Exists — Expose It To The Rail**: Extracts the
  server's existing dispatch-to-completion predicate into one helper shared by the
  dispatch gate and the rail, so a team slot can show whether it is holding work without
  inventing a second definition of "in flight".
- **Opening The Dock Starts Mission Control: One Seat, One Path**: Routes the dock's
  controller start through the endpoint that seats Mission Control and delivers the
  pre-flight interview, retires role selection, and fixes the exit-code-0 dead end on the
  dock's default role. This is what makes deleting the UFO a pure deletion.
- **The Agent Dock Grows Tabs, And The Terminals Kanban Pane Becomes One Of Them**:
  Generalises the dock from one hardcoded occupant to a tabbed host, adding the existing
  kanban pane as a second tab so a card list can sit beside any panel without spending a
  terminal slot.
- **A Linear Panel: Setup, Agent Wiring, And The Instructions To Drive Switchboard From
  Linear**: Gives the Linear integration a first-class panel for setup, agent wiring and
  the operator instructions that currently exist nowhere, and takes the primary rail slot
  the restructure reserves for it.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Opening The Dock Starts Mission Control: One Seat, One Path](../plans/opening-the-dock-starts-mission-control.md) — **PLAN REVIEWED** — ID: cd083484-32c5-40f5-a771-434ce1c0fcf8
- [ ] [The Agent Dock Grows Tabs, And The Terminals Kanban Pane Becomes One Of Them](../plans/agent-dock-tabs-and-kanban-in-the-dock.md) — **PLAN REVIEWED** — ID: 46caa8cd-d582-4dfc-91f6-455fafd0e055
- [ ] [Shell Rail Restructure: A Primary Group, A Cold Group, And No Process List](../plans/shell-rail-restructure-primary-and-cold-groups.md) — **PLAN REVIEWED** — ID: 6fe61451-db59-48ba-b56d-e75844dcff9a
- [ ] [One Colour In The Rail: Theme-Accent Team Icons, No Status Palette](../plans/shell-rail-single-colour-state-system.md) — **PLAN REVIEWED** — ID: b1ba3477-ed3d-44cb-aebc-ab4bce0c588a
- [ ] [The Team In-Flight Predicate Already Exists — Expose It To The Rail](../plans/team-dispatched-state-reaches-the-rail.md) — **PLAN REVIEWED** — ID: 44b85cfd-b57a-48aa-a1c5-0750fefd81bf
- [ ] [A Top-Right Control Cluster For The Shell's Non-Navigational Controls](../plans/shell-top-right-control-cluster.md) — **PLAN REVIEWED** — ID: b566e0d0-d066-4c74-a2fa-4e45658a3b70
- [ ] [Three Fixed Team Slots In The Rail, Present Whether Or Not The Team Is Running](../plans/shell-rail-fixed-team-slots.md) — **PLAN REVIEWED** — ID: fe50ab48-b936-4099-8396-5be08f7e3e9f
- [ ] [A Linear Panel: Setup, Agent Wiring, And The Instructions To Drive Switchboard From Linear](../plans/linear-gets-its-own-panel.md) — **PLAN REVIEWED** — ID: 63ba35d9-2713-4561-8417-166813ee1965
<!-- END SUBTASKS -->

## Dependencies & sequencing

Not parallel — there are four real ordering constraints, and three of them are shared-code
collisions rather than logical dependencies.

1. **Rail restructure lands first.** It declares the group key every other rail subtask
   renders into, and it deletes the UFO. Nothing else in the rail should be attempted
   against the old flat manifest.
2. **Promote the dim treatment before deleting the UFO.**
   `#strip-mission-control.mission-control-dimmed` is the shell's only "inactive, click to
   start" styling, and the team slots adopt it as `.strip-icon.is-dormant`. If the UFO's
   rules are deleted first, the team slots lose their dim state. This is named in the rail
   restructure, colour and team-slot subtasks — all three must agree.
3. **`showStripToast` survives the UFO.** It exists only for the UFO's start feedback, but
   the team slots' start-failure path uses it. Whichever of those two subtasks lands second
   must not delete it.
4. **Team slots before dispatched state.** Slots render from `running` and are shell-only;
   the dispatched state needs a server-side helper extracted from the dispatch gate. Slots
   can ship first wearing no work-state indicator at all.
5. **Dock-starts-Mission-Control before dock tabs.** It retires the role picker, and the
   tabs subtask must not carry `#dock-role-btn` / `#dock-role-menu` into the new tabbed
   header. Landing tabs first means building a picker into the header and then removing it.

Independent of the rest: the **Linear panel** shares only its manifest entry with the rail
restructure, so it can proceed in parallel once the group key exists. The **top-right
cluster** depends on the rail restructure only for the dock toggle's removal from the left.

## Team Dispatch Instructions

### Shell Rail Restructure: A Primary Group, A Cold Group, And No Process List
- **Seat:** Coder
- **Acceptance:**
  - Rail reads Kanban / Mission Control / Agent Control / Terminals / Linear, then team slots, then Project / Artifacts / Tickets / Design at the foot — in both hosts.
  - No theme button, no dock button, no per-terminal buttons, no UFO Mission Control button in the rail.
  - `POST /mission-control/start` still answers and the `/switchboard-manage` skill path still works after the button is gone.
  - Deep-link each of `/#setup`, `/#memo`, `/#connections` and confirm the panel opens with no rail icon present.
  - `.strip-icon.is-dormant` class exists in `shell.html` (promoted from UFO's dimmed treatment).
- **Must not touch:** `POST /mission-control/start` endpoint and its `missionControlStart` option — the endpoint outlives its UI caller. The Mission Control panel icon in the primary group is unaffected (static manifest entry, not state-driven).

### A Top-Right Control Cluster For The Shell's Non-Navigational Controls
- **Seat:** Coder
- **Acceptance:**
  - `#top-right-cluster` contains four buttons: Agent Dock, Setup, Memo, Connections — at `position: fixed; top: 6px; right: 6px`.
  - No panel control sits under the cluster at 1280px or 1920px width (verified per panel).
  - Opening the dock shifts the cluster left; dragging the splitter tracks continuously.
  - Resize below 980px gates off the dock button; the other three stay live.
  - `buildDockToggle` is absent from `shell.js` (moved to cluster, not duplicated).
- **Must not touch:** `.dock-toggle-btn` class name (queried by `setDockOpen` and `updateDockViableGating`). `sb.agentDock` localStorage persistence (toggle moves, persistence does not).

### One Colour In The Rail: Theme-Accent Team Icons, No Status Palette
- **Seat:** Coder
- **Acceptance:**
  - Rail shows exactly two hues: accent (team icons) and text/dim monochrome ramp — in both themes.
  - Selection is a left-edge bar, not accent text or accent-dim border.
  - No completion ring, no queue badge, no exited grayscale on any rail icon.
  - Terminals panel sidebar DONE chip and pane badge still appear (durable completion record survives).
  - `pulsedDoneStamps`, `DONE_PULSE_MS`, `clearTeamBadges` relay — zero live references in either host.
- **Must not touch:** `refreshTeamQueueDepths` and the `queueDepth` field (consumed by the dispatched-state plan). `terminalBadges` map in `terminals.js` (panel-side, 7 delete sites, unaffected). `--accent-dim` must not be reintroduced anywhere.

### Three Fixed Team Slots In The Rail, Present Whether Or Not The Team Is Running
- **Seat:** Coder
- **Acceptance:**
  - Fresh workspace with zero teams started: rail shows exactly three dim team slots in declared order.
  - Click each dim slot: team's head starts, slot lights, no second terminal from a rapid double-click.
  - Stop a team: slot returns to dim and no icon below it moves.
  - Rail is still 12 buttons with nine terminals across three teams.
  - `showStripToast` is still present in `shell.js` (kept alive by this plan's start-failure path).
- **Must not touch:** `OFFERED_REVIEW_TEAM_GROUP` / `OFFERED_TEAM_DEFINITIONS` — already deleted from `teamWiring.ts:707`; `DEFAULT_TEAM_DEFINITIONS` fills the gap, nothing to retire. Team names are the operator's — key every binding on definition id, never on display name.

### The Team In-Flight Predicate Already Exists — Expose It To The Rail
- **Seat:** Coder
- **Acceptance:**
  - Dispatch a card to a team: slot shows dispatched within one poll interval.
  - Post `/kanban/task/complete`: slot returns to free.
  - Move the card between columns without completing it: slot stays dispatched.
  - Attempt a second dispatch to a dispatched team: 409 still fires and names the held card.
  - Kill network to queue endpoint: last known state is held rather than flickering to free.
- **Must not touch:** The 409 gate is the only authority — nothing in the UI may use the `inFlight` flag to decide whether a dispatch is allowed. The dispatch handler's scan-all-candidates behaviour must be preserved (the helper's short-circuit mode is for the rail path only).

### Opening The Dock Starts Mission Control: One Seat, One Path
- **Seat:** Coder
- **Acceptance:**
  - Fresh workspace with agent configured: open dock, controller seat created, pre-flight interview appears in the dock terminal, answering leads to arming via `/mission-control/confirm`.
  - Fresh workspace with no agent configured: open dock, launcher text renders in empty state with copy action, no dead shell, no `[Process Exited with code 0]`.
  - Start Mission Control from `/switchboard-manage` skill, then open dock: adoption, no re-delivered interview.
  - No role picker in the dock header; Terminals panel's new-terminal and fill-grid pickers still start every other role.
  - Persisted non-controller seat is discarded and empty state appears.
- **Must not touch:** `POST /mission-control/start` endpoint (shared with `/switchboard-manage` skill). `missionControlStart` wiring in both composition roots. The dock must NOT call `/mission-control/confirm` — arming is the agent's move. `mcp_monitor` exclusion in `terminals.js` spawn pickers — not this plan's business.

### The Agent Dock Grows Tabs, And The Terminals Kanban Pane Becomes One Of Them
- **Seat:** Coder
- **Acceptance:**
  - Both tabs present in the dock, agent tab active on a fresh profile.
  - Switch tabs repeatedly: neither iframe reloads (terminal scrollback and live WebSocket survive, card-list scroll position survives).
  - No role picker in the dock header on either tab.
  - Toggle theme with each tab active, then switch: both frames repainted.
  - `btn-kanban-toolbar` in the Terminals panel still works (in-grid kanban pane not retired).
- **Must not touch:** `btn-kanban-toolbar` and the in-grid kanban pane (stays, not retired). The Kanban panel (keeps its own rail icon and panel). `DOCK_MIN` 648px floor (do not lower). `DOCK_VIABLE_MIN` 980px gate (applies to the whole dock, do not special-case the kanban tab).

### A Linear Panel: Setup, Agent Wiring, And The Instructions To Drive Switchboard From Linear
- **Seat:** Coder
- **Acceptance:**
  - Rail shows Linear in the primary group in both hosts.
  - `/linear` serves directly; `/#linear` selects from the shell.
  - Tickets panel is byte-for-byte unaffected: TICKETS, CLICKUP, LINEAR tabs all present and functional.
  - Connections is unaffected except for Linear's rows: ClickUp, Hand-offs, Jobs, Web Agents, Docs Health all intact.
  - Unauthorised install: panel renders its connect empty state, is not omitted, and authorising from it succeeds.
  - Toggle remote control in kanban toolbar: Linear panel reflects it, and the reverse.
- **Must not touch:** Tickets panel's LINEAR tab (ticket-browsing belongs there). ClickUp connectivity (stays in Connections). Token storage and the OAuth actor path. `btn-remote-control` in the kanban toolbar (stays — one state, two controls).

## No migration across this feature

Every subtask takes a clean break. No migrations, no compat shims, no legacy-key
preservation, no `*.migrated.bak` archives — CLAUDE.md's migration rule is deliberately
waived for this release. Implementing agents must not add compat paths on their own
initiative; each subtask states this in its own body so the exemption travels with the
work.

## Implementation Summary

All 8 subtasks implemented and committed across 3 team seats. The rail now declares primary and cold groups with three fixed team slots keyed on definition id, a single theme-accent colour for team icons, and a left-edge bar selection shape. Non-navigational controls (dock, setup, memo, connections) moved to a fixed top-right cluster that tracks dock width. The dock starts Mission Control via POST /mission-control/start with no role picker, and grew a second tab hosting the kanban pane. The server's in-flight predicate was extracted into resolveTeamInFlight, shared by the 409 gate and the rail's dispatched indicator. Linear received its own panel with /linear routing, agent wiring, and operator instructions, taking the primary rail slot reserved by the restructure.


## Review Findings

Reviewed all eight subtasks against commit 8a77aa1f in one pass. Two CRITICAL defects (the three fixed team slots could never report `running`, because a member-less team registers no `terminals.groups` row; and the Linear panel read `msg.payload` from a flat `remoteConfig` message, emptying its board list and pinning its remote-control button) and seven MAJOR defects were fixed, including a Connections provider clobber that silently retargeted a Linear remote-control config at Notion, a cold-group divider selector that could never match, a dead-control fallback in the top-right cluster, a dock title wired to a channel the shell cannot hear, and three CI-wired gates left red by the commit. Files changed: `src/webview/shell.html`, `src/webview/shell.js`, `src/webview/terminals.js`, `src/webview/linear.js`, `src/webview/connections.js`, `src/services/KanbanProvider.ts`, `src/services/teamWiring.ts`, `src/test/shell-terminal-strip.test.js`, `src/test/shell-agent-dock.test.js`, `src/test/connections-routing-contract.test.js`, `protocol-catalog.json`. Validation: `tsc -p tsconfig.test.json --noEmit` clean; `npm test` green (standalone-parity, catalog:check, icons:parity); `parity:check`, `push-routing:check`, `standalone-fork:check`, `host-seam-parity:check`, `kanban-dispatch-callers:check`, `verb-returns:check` all green; contract suites shell-terminal-strip 66/66, shell-agent-dock 29/29, connections-routing 15/15, terminal-replay-gap 17/17, team-release-control, browser-panel-verb-routing 16/16, panel-scrollbars 55/55, terminal-groups-key 24/24, verb-engine-kanban, verb-engine-tickets, panel-runtime-surface, pty-route-surface all green.

## Deferred Findings

- MAJOR `protocol-catalog.json` — `npm run catalog:check` is invoked by CI (`.github/workflows/integration-tests.yml:26`) and was RED at 8a77aa1f: the commit changed indexed webview and service files without regenerating the catalog. Fixed by regenerating and committing it, but the class recurs on every commit that touches a push site.
- MAJOR `src/services/TaskViewerProvider.ts:2594` — `npm run test:contract:verb-engine` (CI-wired, `integration-tests.yml:546`) fails with the headless `vscode.workspace` trap inside `_migratePlannerWorkflowPathDbTiers`. PRE-EXISTING and unrelated: that migration was last touched in 2026-07 (a49f125d) and is untouched by this feature. Not fixed here.
- MAJOR `.claude/skills/switchboard-remote/SKILL.md` — `npm run mirror:check` reports content drift against `.agents/skills/`. PRE-EXISTING and unrelated (last touched by 5cd79357, "Restore control plane to its pre-sync state"); no working-tree change from this feature touches either tree. Not fixed here.
- MAJOR — the core mechanisms of five subtasks (rail composition and its divider, the tabbed dock, the top-right cluster placement, the dormant/running slot rendering, and the Linear panel's Connect flow) have only static assertions behind them; no automated check exercises a rendered rail, a mounted dock frame, or a live Linear round-trip. Manual verification was NOT executed in this pass, so the visual and end-to-end halves of every plan's verification section remain unperformed and this verdict is provisional for them. Passing the contract suites is not evidence the rendered cockpit is correct.
- NIT — `npm test` does not invoke any of the `test:contract:*` suites; they are gated only by `.github/workflows/integration-tests.yml`. Both shell suites and connections-routing ARE invoked there (lines 885, 903, and the connections job), so the gate wiring for this feature's own checks is sound.
