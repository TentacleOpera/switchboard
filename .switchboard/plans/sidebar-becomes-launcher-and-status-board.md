# The Sidebar Becomes a Launcher and a Status Board, Not a Cramped Column of Everything

> **RESCOPED 2026-09-12.** *VS Code Becomes a Sidebar, and Stops Being a Second Host* (feature, PLAN REVIEWED) is authoritative here: **the extension keeps its sidebar and loses everything else — no editor panels, no board of its own.** Two consequences. (1) **Stage 1 — The Panels Leave the Editor** deletes the 7 `createWebviewPanel` sites that have browser equivalents and redirects their commands to open the browser, so "reach every VS Code editor-tab panel" is a launcher pointed at surfaces that are being removed — the launcher's targets are **the browser**. (2) **Stage 3 — The Sidebar Becomes a Host Client** (`sidebar-becomes-a-host-client.md`) is the successor to this plan's restructure and defines the end state: host status, fleet liveness, open-in-browser, **read-only — it must not become a second board.** Before coding this, reconcile it against Stage 3; the sidebar-as-launcher-and-status-board premise survives, the editor-tab half does not.

> **SUPERSEDED 2026-09-14 (improve-feature reconciliation).** The four-section restructure of the legacy sidebar (`Launch` / `Terminals` / `Status` / `Memo` in `src/webview/implementation.html`, with editor-tab launch buttons) is **not to be implemented as a standalone plan.** It is throwaway legacy-host work under the cutover rule (CLAUDE.md: *"Do not write new code in the legacy host to keep it compatible — that is throwaway work protecting a host that is going away"*):
> - **Stage 1** deletes the 7 `createWebviewPanel` providers (`SetupPanelProvider`, `TicketsPanelProvider`, `DesignPanelProvider`, `DiagramRenderer`, `KanbanProvider`, `PlanningPanelProvider`, `ConnectionsPanelProvider` — verified present in `src/`) that the Launch section's buttons post to (`openTicketsPanel`, `openConnectionsPanel`, `openAgentControlPanel`). The launcher would point at surfaces being removed.
> - **Stage 3** (`sidebar-becomes-a-host-client.md`) replaces the sidebar's board-imitation UI with a read-only status panel over HTTP (host status, fleet liveness, open-in-browser). It does not build on four sections; it replaces them.
>
> **Reason:** Building a four-section sidebar that Stage 1 partially deletes and Stage 3 wholly replaces is work with no surviving artifact. The cutover is a hard cutover with no interop version, so there is no transitional release that needs this restructure.
>
> **Replaced with:** Do not implement this plan. The surviving intent — "every full-width surface is reachable from the sidebar, **in the browser**" — collapses to the **open-in-browser** button that Stage 3 already specifies. The richer **Status** row spec belongs to this feature's sibling plan `sidebar-read-only-status-section.md`, which feeds Stage 3. The analysis below is preserved as context for whoever implements Stage 3's sidebar replacement (it documents the legacy mess being cleaned up). **Routing: do not dispatch this subtask as standalone coding work.**

## Goal

> **Superseded:** Restructure the Switchboard sidebar (`src/webview/implementation.html`) into four named sections — **Launch**, **Terminals**, **Status**, **Memo** — so that the narrow column does two things well (launch full-width surfaces, report live state) instead of trying to be a workspace. Complete the launcher so every full-width surface is reachable from it — **in the browser**, not as a VS Code editor tab (Stage 1 of *VS Code Becomes a Sidebar* deletes those panels).
>
> **Reason:** The four-section restructure of the legacy sidebar is throwaway under the cutover rule — Stage 1 deletes the editor-tab panels the Launch section targets, and Stage 3 replaces the sidebar UI with a read-only status panel. There is no surviving artifact for this plan's implementation.
>
> **Replaced with:** No standalone implementation. The surviving intent (reach every surface **in the browser**) is the open-in-browser button owned by Stage 3 (`sidebar-becomes-a-host-client.md`). This plan is retained as a supersession redirect: it preserves the legacy-sidebar analysis as context for Stage 3's implementer and routes the richer Status rows to the sibling `sidebar-read-only-status-section.md`.

### Problem Analysis

> Preserved as historical context — documents the legacy sidebar UI that Stage 3 replaces. Not an implementation spec.

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

> **Post-cutover note (2026-09-14):** Every "Editor-tab provider" row above is a `createWebviewPanel` site Stage 1 deletes. The launcher gap is therefore not "add three buttons" — it is "the targets are leaving the editor." The browser is the board after the cutover; the sidebar's launcher job is open-in-browser, which Stage 3 owns.

**The self-relabelling button.** `createAgentGrid` (`:1577`) is relabelled between `OPEN AGENT TERMINALS` and `CLEAR TERMINALS` by `updateTerminalButtonState()`. One control with two meanings in a section whose whole purpose is telling the user what will happen when they click. It becomes two always-labelled buttons.

> **Post-cutover note (2026-09-14):** Stage 3 replaces the terminal buttons entirely; the "two always-labelled buttons" concern becomes a terminal-access design question Stage 3 flags as unresolved. Not standalone work here.

## Metadata

**Complexity:** 4
**Tags:** ui, ux, frontend, refactor
**Status:** SUPERSEDED — do not implement as standalone. Surviving intent owned by Stage 3 (`sidebar-becomes-a-host-client.md`); richer Status rows owned by sibling `sidebar-read-only-status-section.md`.

## User Review Required

> **Superseded:** The section-order and Live-feed questions below were for the four-section restructure, which is not being built.
>
> **Replaced with:** One open decision for the user — **whether to retire this subtask (and reconsider the feature's scope) now that 2 of 3 subtasks are superseded by the *VS Code Becomes a Sidebar* feature.** See the feature file's reconciliation note.

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

> **Post-cutover note (2026-09-14):** All Routine and Complex items above describe work on the legacy sidebar UI that Stage 3 replaces. They are preserved as context for Stage 3's implementer, not as a work list.

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
- **Superseded sequencing:** ~~Sequenced after `orchestrator-entry-points-cleanup-and-naming.md` (vocabulary).~~ ~~Sequenced with or after `sidebar-read-only-status-section.md`.~~ Both were sequencing for the four-section restructure, which is not being built. The surviving relationship is: this plan is superseded by Stage 1 + Stage 3 of *VS Code Becomes a Sidebar*; the sibling Status plan feeds Stage 3.

## Adversarial Synthesis

Key risks: (1) the plan as originally written is throwaway legacy-host work — Stage 1 deletes its targets, Stage 3 replaces its container — so implementing it burns effort with no surviving artifact; (2) a source-scan "three buttons + three message arms" contract would pass green on code that points at removed panels, a goal-vs-appearance gap. Mitigation: mark superseded, route surviving intent to Stage 3, and gate any future sidebar work on Stage 3's container spec.

## Verification Plan

> **Superseded:** The automated and manual checks below were for the four-section restructure, which is not being built.
>
> **Replaced with:** supersession invariants (below). A reviewer's job against this plan is to confirm it is *not* implemented as standalone sidebar work, and that its surviving intent is carried by the cutover feature.

### Automated
- Source-scan contract, in the shape of `src/test/terminal-grid-entry-point.test.js`: assert `implementation.html` contains exactly one element posting each of `openTicketsPanel`, `openConnectionsPanel`, `openAgentControlPanel`, and that each has a matching `case` arm in `TaskViewerProvider._handleMessage`.
- Assert `createAgentGrid` no longer appears in any `updateTerminalButtonState()` label assignment, and that the two replacement ids each appear exactly once in the markup.
- Assert the string `sub-tab-btn` is absent from `implementation.html`.

### Manual
1. Sidebar renders four labelled sections with no horizontal scrollbar at the default sidebar width and at the narrowest draggable width.
2. Each Launch button opens its panel in an editor tab, not in the sidebar.
3. With terminals live and with none live, both terminal buttons keep their own labels and the correct enabled state.
4. The Agents list is reachable via the Agents button and is no longer rendered inline.

### Goal Invariants

> **Superseded:** The original goal was a relocation/restructure ("restructure into four named sections"). The paired negative/positive assertions below are inverted to reflect the superseded state — the thing that must *not* happen is standalone implementation of the four-section restructure.

- **Negative:** No new editor-tab launch buttons (posting `openTicketsPanel` / `openConnectionsPanel` / `openAgentControlPanel`) are added to `src/webview/implementation.html` as part of this plan — those panels are deleted by Stage 1.
- **Negative:** The `sub-tab-bar` / `sub-tab-btn` markup is not removed by this plan in isolation — it is removed with the rest of the legacy sidebar UI by Stage 3.
- **Positive:** The surviving "reach every surface in the browser" intent is resolvable in Stage 3 (`sidebar-becomes-a-host-client.md`) via its open-in-browser button — assert that plan's Proposed Changes name an open-in-browser affordance.
- **Positive:** The richer Status row spec is carried by the sibling `sidebar-read-only-status-section.md` — assert that plan's row table (teams, queue depth, controller, transport, three-state empty) is preserved.

## Outstanding Questions

- **[user]** Whether to retire this subtask now that it is superseded by Stage 1 + Stage 3 of *VS Code Becomes a Sidebar*, and whether the parent feature's scope should be reconsidered (2 of 3 subtasks are superseded by the cutover feature). — proceeding on the assumption that the subtask is retained as a supersession redirect for now; the user decides retirement.
