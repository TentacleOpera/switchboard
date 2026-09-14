# A Read-Only Status Section in the Sidebar: What Is Running, Never What Should Run

**Feature:** 21449899-ac3e-464a-9d9e-f8c18eee4f1d

<!-- board-collapse-audit -->
> **REDIRECT 2026-09-04 (Board Collapse audit).** This plan names `sql-write-guardrail-prevent-agents-from-writing-to-kanban-db.md`. That plan has been **deleted** (decision 11). Its "never SQL from the webview" principle is unaffected and still correct here; there is simply no separate plan enforcing it. The permission narrowing moved to `skills-posix-only-tooling.md`.

> **RECONCILED 2026-09-14 (improve-feature reconciliation, against the *VS Code Becomes a Sidebar* cutover).** This plan's **row spec survives** and is its reason to exist; its **container** and **data source** are superseded by the cutover and must defer to Stage 3:
> - **Container — SUPERSEDED by Stage 3** (`sidebar-becomes-a-host-client.md`). Stage 3 replaces the whole sidebar UI with a read-only status panel (host status, fleet liveness, open-in-browser). A "Status `<section>` inside a four-section sidebar" is not the shape anymore — Stage 3 owns the sidebar container. This plan now defines **the row set Stage 3's status panel renders**, not a section to slot into the legacy sidebar.
> - **Data source — SUPERSEDED by Stage 2** (`extension-spawns-or-attaches-to-standalone-host.md`). The original data sources are **in-process extension-host services** (`LocalApiServer.isListening()`, `ptyHostReady()`, `listPtyTerminals()`, `db.getConfigJson`). Stage 2 stops the extension constructing `LocalApiServer` in-process and makes it a client of the standalone host. Those in-process services will not exist in the extension after Stage 2. The status view must fetch over **HTTP from the standalone host** instead.
>
> **Net:** the six rows below are the surviving intent and feed Stage 3; the accessor and the in-process source table are inverted to HTTP. Do not build a standalone sidebar section against the in-process extension host — that is throwaway work the cutover deletes.

## Goal

Define the **read-only status row set** the sidebar reports — is the host alive, is the fleet up, what teams exist and who is seated, how deep is each team's queue, is the controller running, and what transport each seat uses — and route it to Stage 3's sidebar status panel over HTTP. Strictly read-only: every affordance that would *change* something is a deep-link to the surface that owns it. The container and the data transport are owned by Stage 2 + Stage 3; this plan owns the **content** (the rows) and the **read-only invariant**.

### Problem Analysis

Teams run where Switchboard can both **address** a seat and **observe** it — today only the pty fleet does both — and missions are heading for a browser rail panel (`mission-control-panel-ui-specification.md`). So VS Code has no answer to "what is happening right now" unless the user already has the cockpit open. That inverts the useful case: the sidebar is the surface that is *always* visible, and it is the one that currently reports the least.

**Note on the rule, so it is not miscited later.** Address-and-observe is a statement about today's backends, not a claim that a team is impossible outside the fleet. Membership, wiring, role routing and queueing are all surface-agnostic — `resolveTeamRoleTerminal` unions the fleet with the VS Code registry and its docblock says *"a team can be either, the two registries are disjoint"*; `wireSpawnedTeam` takes names and a DB. What is fleet-bound is team *creation* (both instantiation paths go through `ptyCreateTerminal` / `spawnDelegates`) and the *notification hop back to the head* (`notifyTurnEnd` returns early without `_ptyHostPort`). Status reports what is running; it does not encode a rule about what may run.

**Why read-only is a design constraint, not a simplification.** `mission-control-panel-ui-specification.md` spends a section arguing down a third start affordance ("With the fighter-jet panel icon plus the dock toggle plus this button, Mission Control would have had three rail entries, one duplicating another's function"), and `one-controller-enforced-at-the-service.md` exists to enforce a single controller at the service layer. A sidebar that could start or stop things would be a fourth entry point next to a plan whose entire job is enforcing one. The value here is *observation* — the thing no other surface provides — and adding control would trade that for a conflict. Stage 3 carries the same constraint ("must not become a second board"); this plan is where the row-level read-only invariant is specified.

**The row set (the surviving intent).** Six rows, each with a defined source. After the cutover the sources are **HTTP endpoints on the standalone host**, not in-process extension services.

| Row | Source (post-cutover: HTTP) | Original in-process source (pre-cutover, now superseded) |
| :--- | :--- | :--- |
| host alive + API port | host health endpoint (e.g. `GET /health` → `health.ptyHost`, `health.hostCapability`) | `LocalApiServer.isListening()` / `getPort()` |
| fleet up / boot failed | fleet/health endpoint distinguishing *fleet unavailable* from *fleet up, nothing seated* | `ptyHostReady()` (`TaskViewerProvider.ts:1100`), `_ptyHostBootFailed` (`:1227`) |
| seats — name, role, worktree, liveness | fleet list endpoint (e.g. `POST /terminals/verb/ptyListTerminals`) | `TaskViewerProvider.listPtyTerminals()` (`:1279`) |
| teams — id, name, members, seat order | teams/config endpoint (the array `mutateTerminalGroups` guards, `teamWiring.ts:525`; team rows carry `teamGroup: true`) | `TERMINALS_GROUPS_KEY` via `db.getConfigJson` |
| queue depth + mode per team | queue endpoint (`listQueue(workspaceRoot, groupId)`, `TeamQueueService.ts:149`) | same (called over HTTP after Stage 2) |
| controller running | controller-state endpoint / broadcast | the `orchestratorState` broadcast relayed to `#strip-orchestrator` (`shell.js:271`) |
| **transport per seat** (`pty` / `vscode`) | carried on the fleet list item (`info.purpose === 'pty' \|\| info.ideName === PTY_IDE_NAME`, `:10247`) | same |

> **Superseded (data source):** The original plan read every input in-process from the extension host. After Stage 2 the extension is a client and holds no host state, so those reads are impossible. **Replaced with:** one HTTP snapshot accessor against the standalone host's endpoints, pushed to the sidebar webview as a single message. The "one accessor, not six" reasoning still holds — separate reads can be observed half-updated across an `await`, so the host should expose one snapshot endpoint (or the sidebar fans out and awaits all before rendering).

**Why transport belongs on the row.** Creation and dispatch are asymmetric: with the fleet up nothing will *create* a `vscode.Terminal` for a dispatch (`:6036`, `:27718` both return early on `_ptyHostPort`), but `_attemptDirectTerminalPush` will still deliver to a VS Code terminal that already exists, because it falls through to `_registeredTerminals` after the fleet misses. A user who had VS Code terminals open before launching the cockpit therefore has a mixed fleet whose dispatches split by whether a matching seat happens to exist — and no surface says so. Showing the transport is the whole fix; the resolver's precedence is deliberate, documented (`_pickTerminalCandidate`, `:10266`) and byte-compat-constrained for the shipped install base, so it should not be touched for this.

> **Post-cutover note (2026-09-14):** The mixed-transport case (`vscode` vs `pty` seats) is a pre-cutover phenomenon — after Stage 2 the extension holds no terminals of its own, so the fleet is uniformly host-backed. The transport row remains useful to display *how* a seat is reached (e.g. `tmux attach` vs browser terminal page), which is the terminal-access design Stage 3 flags as unresolved. Keep the row; expect its values to change meaning post-cutover.

**Missions are not available yet, and this plan must not wait for them.** The four-plan Mission Control feature is reviewed but unbuilt, so there is no mission to report. The Status view ships with the six rows above and a **defined empty slot** for mission rows, filled when Mission Control lands. Blocking this on that feature would leave the sidebar reporting nothing for the entire duration of a complexity-6 build.

## Metadata

**Complexity:** 5
**Tags:** ui, ux, frontend, backend, reliability

## User Review Required

- **Poll cadence.** Proposed: 5s while the sidebar webview is visible, paused entirely when it is not. See the polling note below — this is the one number worth setting deliberately. (Post-cutover: the sidebar polls the host over HTTP; the visibility gate is unchanged.)
- **Whether team rows are collapsible.** Proposed: yes, collapsed by default past three teams, so a nine-seat fleet does not push the rest of the status panel off-screen.

## Complexity Audit

### Routine

- Rows rendered from one state object, in the sidebar's existing `.section-label` idiom (post-cutover: Stage 3's status-panel markup).
- One snapshot read over HTTP returning the whole status, pushed to the webview as a single message. One read, not six — separate reads can be observed half-updated across an `await`.
- Deep-links reuse the commands/routes the host already exposes (open-in-browser for the board; deep-links to owning panels for any action).

### Complex / Risky

- **Polling a host over HTTP from an always-visible view.** The cockpit already polls the fleet; adding a second poller doubles IPC/HTTP for as long as the sidebar is open. Gate on `WebviewView.onDidChangeVisibility` and stop the timer when hidden — an always-on 5s poll is a background cost users cannot see and will not attribute to Switchboard.
- **Empty must distinguish three states.** The fleet list returns `[]` both when the fleet is up with nothing running and when the host never booted. Rendering "no teams" for a failed boot is the same class of silent lie as the cockpit's stale-host case. Read the boot-failed signal distinctly from *fleet up, nothing seated*.
- **Never SQL from the webview.** Teams come through the host's HTTP endpoint, not a query from the webview. `sql-write-guardrail-prevent-agents-from-writing-to-kanban-db.md` is the standing direction here (deleted as a plan, live as a principle); the config read must go through the host, not a parallel webview reader.
- **No start, stop, restart, clear, ack or move.** If a row needs an action, the row links to the panel that owns it. This is the plan's one non-negotiable, and it is shared with Stage 3's "must not become a second board."
- **"Tracker" is not the name.** A tracker in this codebase is ClickUp / Linear / Notion. This is Status.

> **Superseded (in-process specifics):** The original "Complex / Risky" item named `listPtyTerminals()` returning `[]` on no child (`:1289`) and `_ptyHostBootFailed`. Those are in-process extension-host signals that do not exist after Stage 2. **Replaced with:** the HTTP fleet/health endpoint must itself distinguish the three states (host down / fleet boot failed / fleet up empty); the sidebar renders what the endpoint reports.

## Edge-Case & Dependency Audit

**Race Conditions**
- A team row can name a seat that has just exited; the snapshot is a point-in-time read and rows must tolerate a member with no matching live terminal (render it dimmed, not absent — an empty seat is information).
- Workspace switch mid-poll: the snapshot must carry the workspace root it was taken for, and a late reply for the previous root is discarded rather than rendered.

**Security**
- Read-only by construction. No new route that mutates, no new token, no user input reaching a query. (Post-cutover: the sidebar's HTTP client targets loopback only, matching Stage 3's security note.)

**Side Effects**
- The rows add vertical height. Post-cutover they live inside Stage 3's status panel, which owns the layout — this plan does not restructure the sidebar chrome.

**Dependencies & Conflicts**
- **Depends on Stage 2** (`extension-spawns-or-attaches-to-standalone-host.md`) for the HTTP data source — the extension must be a client of the standalone host before the in-process sources disappear.
- **Depends on Stage 3** (`sidebar-becomes-a-host-client.md`) for the container — Stage 3 owns the sidebar status panel these rows render in.
- **Independent of** the Mission Control feature — the mission slot is additive.
- Touches the sidebar webview assets and the host endpoints it calls. No change to `teamWiring.ts` or `TeamQueueService.ts` beyond calling existing exports over HTTP.

## Adversarial Synthesis

Key risks: (1) the original in-process data source is invalidated by Stage 2 — a unit test stubbing the in-process provider would pass green on a source that won't exist post-cutover (goal-vs-appearance gap); (2) the container is invalidated by Stage 3, so a standalone "Status section" build is throwaway. Mitigations: invert the source to HTTP, defer the container to Stage 3, and keep this plan as the row spec + read-only invariant that Stage 3 implements.

## Verification Plan

> **Superseded (data source):** The original automated test stubbed the in-process `getSidebarStatus()` provider. That tests a source Stage 2 removes. **Replaced with:** test against the HTTP snapshot endpoint (stub the host's responses), and assert the read-only invariant holds regardless of source.

### Automated
- Test the HTTP snapshot path against stubbed host responses for four cases: host down; host up + fleet boot failed; fleet up + zero terminals; fleet up + two teams with queue depths.
- Source-scan contract: assert the Status markup contains no element posting any mutating message — enumerate the message types it may post and assert the set is a subset of the known read/navigate list. This is the guard that keeps a control from being added later "just this once".
- Assert the poll timer is created only inside a visibility-true branch.

### Manual
1. With the host running and no cockpit open: teams and seats appear and match what the cockpit shows when opened.
2. Kill the host process: the section reads *host down* / *fleet unavailable*, not *no teams*.
3. Collapse the sidebar to another view and confirm via the diagnostics channel that polling stops.
4. Enqueue three items on a team from the cockpit: the depth reflects it within one poll interval.

### Goal Invariants

- **Negative:** No status row posts a mutating message (start/stop/restart/clear/ack/move) — the message set is a subset of the known read/navigate list.
- **Negative:** No in-process extension-host service (`LocalApiServer.isListening`, `ptyHostReady`, `listPtyTerminals`, `db.getConfigJson`) is read for status after Stage 2 — status comes over HTTP from the standalone host.
- **Positive:** The six rows (host alive, fleet up/boot-failed, seats, teams, queue depth, controller, transport) are each resolvable from the host's HTTP endpoints.
- **Positive:** Three empty states are distinguishable: host down, fleet boot failed, fleet up with nothing seated.
- **Positive:** The row spec is carried into Stage 3's status panel (assert Stage 3's Proposed Changes render these rows, or that this plan is referenced as the row source).

## Outstanding Questions

None. The snapshot-endpoint decision was resolved during review: **one combined `/sidebar-status` snapshot endpoint**, not fan-out. Rationale: (1) point-in-time consistency — a team named in the teams read matches its queue depth from the same instant, not 50ms later; (2) 5x less traffic at 5s cadence (one round trip vs five); (3) the read-only invariant is enforceable in one place — one endpoint, one audit that it exposes no mutating action.
