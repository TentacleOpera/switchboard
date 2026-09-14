# The Sidebar Becomes a Launcher and a Status Board

<!-- board-collapse-membership -->
> **MEMBERSHIP CORRECTED 2026-09-14 (improve-feature reconciliation). Three subtasks, not five.**
>
> Two cards have left this feature since the earlier audit:
> - *Memo Is the One Surface That Exists Only in the Cramped Column* moved to the **Memo** feature (gathers the eight memo cards spread across four features). Memo's feature sequences it **last**, behind the shared `memoFile.ts` module and the dirty guard; follow Memo's ordering for that card.
> - *Spike: find out whether a VS Code editor-area terminal grid is actually usable* moved out (its question is now moot — Stage 1 of *VS Code Becomes a Sidebar* deletes the editor-area panels a grid would live in; the browser cockpit is the only terminal surface).
>
> **Reconciliation against the cutover (2026-09-14).** The *VS Code Becomes a Sidebar* feature (PLAN REVIEWED) is authoritative for the sidebar's end state. Two of this feature's three subtasks are substantially superseded by that cutover:
> - **The sidebar becomes a launcher and a status board** — SUPERSEDED. Its four-section restructure of the legacy sidebar is throwaway under the cutover rule: Stage 1 deletes the editor-tab panels the Launch section targets, Stage 3 replaces the sidebar UI with a read-only status panel. Surviving intent (open-in-browser) is owned by Stage 3. Retained as a supersession redirect; **do not dispatch as standalone coding work.**
> - **A read-only Status section** — PARTIALLY superseded. Its **row spec survives** (teams, queue depth, controller, transport, three-state empty) and feeds Stage 3; its **container** is superseded by Stage 3 and its **in-process data source** is superseded by Stage 2 (must be HTTP). It is now a spec Stage 3 implements, not a standalone section build.
> - **The cockpit polls a dead host forever** — SURVIVES, cutover-aware. The browser cockpit is the board post-cutover; the host can still die and the panel must say so. Stage 2 eliminates the ephemeral-port orphan case; the surviving case is the standalone host died.

**Complexity:** 4

## Goal

Make the sidebar a launcher and an honest status board instead of a cramped column of everything — and make the browser cockpit say when the host it was served from is gone. This feature predates the *VS Code Becomes a Sidebar* cutover decision; reconciled against it, the feature's executable scope narrows to two things: (1) the **read-only status row spec** the sidebar reports (the surviving intent, fed to Stage 3's status panel over HTTP), and (2) the **cockpit host-offline banner** (a browser-only fix that survives the cutover and becomes more relevant once the host is a standalone process that can die). The four-section sidebar restructure is superseded by the cutover and is retained only as a redirect.

## How the Subtasks Achieve This

- **The Sidebar Becomes a Launcher and a Status Board, Not a Cramped Column of Everything** — was the four-section restructure of the legacy sidebar; SUPERSEDED by Stage 1 + Stage 3 of *VS Code Becomes a Sidebar*. Retained as a supersession redirect that preserves the legacy-sidebar analysis as context for Stage 3's implementer and routes the surviving "open in browser" intent to Stage 3. Not dispatched as standalone work.
- **A Read-Only Status Section in the Sidebar: What Is Running, Never What Should Run** — defines the read-only status row set (host alive, fleet up/boot-failed, seats, teams, queue depth, controller, transport) and the read-only invariant. Container and data source defer to Stage 3 (sidebar panel) and Stage 2 (HTTP from the standalone host); this plan owns the content Stage 3 renders.
- **The Cockpit Polls a Dead Host Forever Without Saying So** — gives the browser cockpit a visible host-offline banner and a recovery path instead of stale terminals on `connecting`. Browser-only, survives the cutover; after Stage 2 the surviving case is the standalone host died.

## Dependencies & sequencing

- **The cockpit banner is independent** of the two sidebar subtasks and of the cutover staging — it touches `src/webview/terminals.js` and `terminals.html` only, and the host-can-die case exists before and after the cutover. It can land at any time and should land early (small, low-contention).
- **The status row spec depends on Stage 2 + Stage 3** of *VS Code Becomes a Sidebar*: Stage 2 supplies the HTTP data source (the extension must be a client before the in-process sources disappear); Stage 3 supplies the sidebar container the rows render in. Do not build it against the in-process extension host — that is throwaway work the cutover deletes.
- **The launcher restructure is superseded** — no sequencing, no standalone implementation. Its surviving intent is carried by Stage 3.
- **Subtasks are not mutually blocking.** The cockpit banner and the status row spec touch disjoint files (`terminals.js`/`terminals.html` vs the sidebar webview + host endpoints); they can proceed in parallel once their cutover prerequisites are met.

## Team Dispatch Instructions

### The Sidebar Becomes a Launcher and a Status Board, Not a Cramped Column of Everything

- **Seat:** Coder (complexity 4) — but **do not dispatch as standalone coding work.** This subtask is superseded by Stage 1 + Stage 3 of *VS Code Becomes a Sidebar*. A coder picking it up should instead confirm the supersession and, if anything, carry the legacy-sidebar analysis into Stage 3's implementation.
- **Acceptance:**
  - Confirm the plan is marked SUPERSEDED and is not implemented as a standalone four-section sidebar restructure.
  - Confirm no new editor-tab launch buttons (posting `openTicketsPanel`/`openConnectionsPanel`/`openAgentControlPanel`) are added to `src/webview/implementation.html` — those panels are deleted by Stage 1.
  - Confirm the surviving "open in browser" intent is resolvable in Stage 3 (`sidebar-becomes-a-host-client.md`).
- **Must not touch:** `src/webview/implementation.html` (no standalone restructure), `src/services/TaskViewerProvider.ts` message arms (no new launch buttons). The plan is a redirect, not a diff.

### A Read-Only Status Section in the Sidebar: What Is Running, Never What Should Run

- **Seat:** Coder (complexity 5).
- **Acceptance:**
  - The six status rows (host alive, fleet up/boot-failed, seats, teams, queue depth, controller, transport) are each resolvable from the standalone host's HTTP endpoints — no in-process extension-host service reads.
  - Three empty states are distinguishable: host down, fleet boot failed, fleet up with nothing seated.
  - No status row posts a mutating message (start/stop/restart/clear/ack/move) — the message set is a subset of the known read/navigate list.
  - The poll timer is created only inside a visibility-true branch (stops when the sidebar is hidden).
  - The row spec is carried into Stage 3's status panel (rendered by Stage 3, not as a standalone legacy-sidebar section).
- **Must not touch:** `teamWiring.ts`, `TeamQueueService.ts` (call existing exports over HTTP only — no parallel reader); no SQL from the webview; no mutating endpoints.

### The Cockpit Polls a Dead Host Forever Without Saying So

- **Seat:** Intern (complexity 3).
- **Acceptance:**
  - `fetchTerminalList` increments a consecutive-failure counter on its failure path and resets it on success; the banner is gated on a threshold greater than one.
  - The banner's trigger reads the API-side failure counter and never `PTY_HOST_ORIGIN` state (host-gone is not pty-host-gone).
  - The gate uses the already-fetched `/health` response (or, post-Stage 2, plain consecutive API failures) — no `data-host-capabilities` DOM attribute is introduced.
  - While the banner is up, the per-pane `connecting` chips are suppressed (one explanation, not nine).
  - No `window.confirm()` / modal gate is added (project rule).
- **Must not touch:** `src/webview/implementation.html`, `src/services/TaskViewerProvider.ts`, any panel HTML. The plan is scoped to `src/webview/terminals.js` and `src/webview/terminals.html` only.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [The Sidebar Becomes a Launcher and a Status Board, Not a Cramped Column of Everything](../plans/sidebar-becomes-launcher-and-status-board.md) — **PLAN REVIEWED** — ID: c335a73d-6724-48d3-9d35-cf1813640c3c
<!-- END SUBTASKS -->

