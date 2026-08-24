# The Sidebar Becomes a Launcher and a Status Board, Not a Cramped Column of Everything

## Goal

Restructure the Switchboard sidebar (`src/webview/implementation.html`) into four named sections — **Launch**, **Terminals**, **Status**, **Memo** — so that the narrow column does two things well (launch full-width surfaces, report live state) instead of trying to be a workspace. Complete the launcher so every VS Code editor-tab panel that exists is reachable from it.

### Problem Analysis

The sidebar is a ~300px column currently carrying: an onboarding block, a 7-button QUICK ACTIONS grid (`:1516-1534`), plan-selection controls with three icon buttons (`:1541-1557`), a three-way sub-tab bar whose panes render *inline* (`:1563-1567`), five terminal action buttons (`:1577-1581`), a full memo editor with a 240px textarea (`:1586-1607`), and a collapsible live activity feed (`:1613+`). Everything competes for the same narrow rectangle, and the two panes that need room — the memo editor and the agent list — are the ones that get least.

**Root cause: the sidebar accreted panes it should have been launching.** Three separate concerns were added as inline tabs because a tab was the available shape, exactly the pattern `the-automation-model-four-things-not-a-mode-axis.md` identifies one level up ("it is not that there are too many capabilities, it is that they were arranged as one choice"). Meanwhile the launcher it *should* be is incomplete.

**The launcher gap, measured.** Every rail panel already has a registered command (`package.json` `contributes.commands`), and all but three have an editor-tab webview via `createWebviewPanel`:

| Rail panel | Editor-tab provider | Command | Sidebar button |
| :--- | :--- | :--- | :--- |
| board | `KanbanProvider` | `switchboard.openKanban` | yes (`:1522`) |
| project | yes | `switchboard.openProjectPanel` | yes (`:1525`) |
| planning (Artifacts) | `PlanningPanelProvider` | `switchboard.openPlanningPanel` | yes (`:1523`) |
| design | `DesignPanelProvider` | `switchboard.openDesignPanel` | yes (`:1524`) |
| setup | `SetupPanelProvider` | `switchboard.openSetupPanel` | yes (`:1533`) |
| **tickets** | `TicketsPanelProvider` | `switchboard.openTicketsPanel` | **none** |
| **connections** | `ConnectionsPanelProvider` | `switchboard.openConnectionsPanel` | **none** |
| **agent-control** | `KanbanProvider.openAgentControl()` | `switchboard.openAgentControlPanel` | **none** (status bar only) |
| memo | **none** — `switchboard.openMemo` calls `taskViewerProvider.openMemoTab()`, i.e. the sidebar tab | `switchboard.openMemo` | sub-tab |
| terminals | none by design — browser cockpit | `switchboard.openTerminalGrid` | yes (`:1578`) |

So three panels are one button each away from being launchable: the providers, the commands and the message plumbing all exist. Memo is handled by its own plan (`memo-gets-an-editor-tab-panel.md`) because it needs a provider, not a button.

**The self-relabelling button.** `createAgentGrid` (`:1577`) is relabelled between `OPEN AGENT TERMINALS` and `CLEAR TERMINALS` by `updateTerminalButtonState()`. One control with two meanings in a section whose whole purpose is telling the user what will happen when they click. It becomes two always-labelled buttons.

## Metadata

**Complexity:** 4
**Tags:** ui, ux, frontend, refactor

## User Review Required

- **Section order.** Proposed: Launch, Terminals, Status, Memo, Live Feed — Launch first because it is the most-used, Live Feed last because it is already collapsible. Onboarding and plan-selection blocks keep their current position above Launch.
- **Whether the Live Feed stays in the sidebar** or moves into the Status section as its tail. Proposed: stays where it is, collapsed by default, so this plan does not also redesign the feed.

## Complexity Audit

### Routine

- Three new buttons in the Launch section posting `openTicketsPanel`, `openConnectionsPanel`, `openAgentControlPanel`, each with a message arm in `TaskViewerProvider._handleMessage` following the shape of `openDesignPanel` (`TaskViewerProvider.ts:14089`) and `openProjectPanel` (`:14095`) — `this._seams().commands.executeCommand(...)`, never `vscode.commands` directly.
- Wrapping existing blocks in `<section>` elements with `.section-header` / `.section-label`, the markup the QUICK ACTIONS block already uses (`:1518-1520`).
- Deleting the `sub-tab-bar` (`:1564-1568`) and the `is-active` toggling that drives it, once its three panes have somewhere else to be.

### Complex / Risky

- **`updateTerminalButtonState()` has four call sites** (`:1757`, `:2290`, `:2301`, `:2324`) and they relabel by element id. Splitting `createAgentGrid` into two buttons means every one of those sites must be re-pointed at the *disabled/enabled* state of two buttons rather than the *label* of one. Missing one leaves a button that silently reverts its own label.
- **`btn-open-central-setup` (`:1580`) posts `{ type: 'openKanban', tab: 'agents' }`**, not `openAgentControlPanel`. It is a deep-link into a kanban tab with a comment marking it as backwards-compat. Adding a real Agents button next to it creates two controls that look identical and go to different places. Decide explicitly: retire `btn-open-central-setup`, or keep it and do not add the Agents button.
- **Naming, and the order this lands in.** `orchestrator-entry-points-cleanup-and-naming.md` names `Manage` at `:1529` as one of four names for one concept (Operator in `shell.js`, Manage here, `project_manager` the role key, orchestrator the persona) and settles the vocabulary. This plan must land **after** it, or the Launch section's labels are written twice. Do not rename `Manage` here.
- **"Tracker" is not available as a section name.** In this codebase a tracker is ClickUp / Linear / Notion (`trackers-are-for-bulk-queueing-and-the-orchestrator-is-a-pm-...`). The read-only section is **Status**.
- **The sidebar must not become a second Mission Control.** `mission-control-panel-ui-specification.md` places missions and schedules in a browser rail panel and is explicit about not stacking affordances. Launch may deep-link; it may not configure.

## Edge-Case & Dependency Audit

**Race Conditions**
- None new. The three added buttons are fire-and-forget command executions.

**Security**
- No new surface. Every added button routes through an already-registered command via the existing commands seam.

**Side Effects**
- Deleting the sub-tab bar removes the only path to the inline Agents list (`#agent-list-standard`, `:1569`). It must land with, or after, the Agents launch button — otherwise the agent list becomes unreachable rather than relocated.
- Users of ~4,000 installs have muscle memory for a two-column button grid. Section headers change the vertical rhythm; button labels and ids should not change beyond the `createAgentGrid` split.

**Dependencies & Conflicts**
- Touches `src/webview/implementation.html` and one message-arm block in `src/services/TaskViewerProvider.ts`. No change to any panel HTML, to `terminals.js`, or to `headlessPanelHtml.ts`.
- **Sequenced after** `orchestrator-entry-points-cleanup-and-naming.md` (vocabulary).
- **Sequenced with or after** `sidebar-read-only-status-section.md` — that plan supplies the Status section this one lays out a slot for.

## Verification Plan

### Automated
- Source-scan contract, in the shape of `src/test/terminal-grid-entry-point.test.js`: assert `implementation.html` contains exactly one element posting each of `openTicketsPanel`, `openConnectionsPanel`, `openAgentControlPanel`, and that each has a matching `case` arm in `TaskViewerProvider._handleMessage`.
- Assert `createAgentGrid` no longer appears in any `updateTerminalButtonState()` label assignment, and that the two replacement ids each appear exactly once in the markup.
- Assert the string `sub-tab-btn` is absent from `implementation.html`.

### Manual
1. Sidebar renders four labelled sections with no horizontal scrollbar at the default sidebar width and at the narrowest draggable width.
2. Each Launch button opens its panel in an editor tab, not in the sidebar.
3. With terminals live and with none live, both terminal buttons keep their own labels and the correct enabled state.
4. The Agents list is reachable via the Agents button and is no longer rendered inline.
