# A Read-Only Status Section in the Sidebar: What Is Running, Never What Should Run

## Goal

Add a **Status** section to the Switchboard sidebar that answers, without the browser cockpit being open: is the host alive, is the fleet up, what teams exist and who is seated, how deep is each team's queue, and is the controller running. Strictly read-only — every affordance that would *change* something is a deep-link to the surface that owns it.

### Problem Analysis

Teams run where Switchboard can both **address** a seat and **observe** it — today only the pty fleet does both — and missions are heading for a browser rail panel (`mission-control-panel-ui-specification.md`). So VS Code has no answer to "what is happening right now" unless the user already has the cockpit open. That inverts the useful case: the sidebar is the surface that is *always* visible, and it is the one that currently reports the least.

**Note on the rule, so it is not miscited later.** Address-and-observe is a statement about today's backends, not a claim that a team is impossible outside the fleet. Membership, wiring, role routing and queueing are all surface-agnostic — `resolveTeamRoleTerminal` unions the fleet with the VS Code registry and its docblock says *"a team can be either, the two registries are disjoint"*; `wireSpawnedTeam` takes names and a DB. What is fleet-bound is team *creation* (both instantiation paths go through `ptyCreateTerminal` / `spawnDelegates`) and the *notification hop back to the head* (`notifyTurnEnd` returns early without `_ptyHostPort`). Status reports what is running; it does not encode a rule about what may run.

**Why read-only is a design constraint, not a simplification.** `mission-control-panel-ui-specification.md` spends a section arguing down a third start affordance ("With the fighter-jet panel icon plus the dock toggle plus this button, Mission Control would have had three rail entries, one duplicating another's function"), and `one-controller-enforced-at-the-service.md` exists to enforce a single controller at the service layer. A sidebar that could start or stop things would be a fourth entry point next to a plan whose entire job is enforcing one. The value here is *observation* — the thing no other surface provides — and adding control would trade that for a conflict.

**Every input already exists in-process in the extension host.** No new transport, no HTTP round trip, no SQL from the webview:

| Row | Source |
| :--- | :--- |
| host alive + API port | `LocalApiServer.isListening()` / `getPort()` |
| fleet up / boot failed | `ptyHostReady()` (`TaskViewerProvider.ts:1100`), `_ptyHostBootFailed` (`:1227`) |
| seats — name, role, worktree, liveness | `TaskViewerProvider.listPtyTerminals()` (`:1279`), the public wrapper over `_ptyHostVerb('ptyListTerminals')` |
| teams — id, name, members, seat order | `TERMINALS_GROUPS_KEY` via `db.getConfigJson` (the array `mutateTerminalGroups` guards, `teamWiring.ts:525`); team rows carry `teamGroup: true` (`migrateTeamGroupFlags`, `:500`) |
| queue depth + mode per team | `listQueue(workspaceRoot, groupId)` (`TeamQueueService.ts:149`) |
| controller running | the `orchestratorState` broadcast already relayed to `#strip-orchestrator` (`shell.js:271`) |
| **transport per seat** (`pty` / `vscode`) | `_isFleetTerminalInfo(info)` — `info.purpose === 'pty' \|\| info.ideName === PTY_IDE_NAME` (`:10247`) |

**Why transport belongs on the row.** Creation and dispatch are asymmetric: with the fleet up nothing will *create* a `vscode.Terminal` for a dispatch (`:6036`, `:27718` both return early on `_ptyHostPort`), but `_attemptDirectTerminalPush` will still deliver to a VS Code terminal that already exists, because it falls through to `_registeredTerminals` after the fleet misses. A user who had VS Code terminals open before launching the cockpit therefore has a mixed fleet whose dispatches split by whether a matching seat happens to exist — and no surface says so. Showing the transport is the whole fix; the resolver's precedence is deliberate, documented (`_pickTerminalCandidate`, `:10266`) and byte-compat-constrained for the shipped install base, so it should not be touched for this.

**Missions are not available yet, and this plan must not wait for them.** The four-plan Mission Control feature is reviewed but unbuilt, so there is no mission to report. The Status section ships with the six rows above and a **defined empty slot** for mission rows, filled when Mission Control lands. Blocking this on that feature would leave the sidebar reporting nothing for the entire duration of a complexity-6 build.

## Metadata

**Complexity:** 5
**Tags:** ui, ux, frontend, backend, reliability

## User Review Required

- **Poll cadence.** Proposed: 5s while the sidebar webview is visible, paused entirely when it is not. See the polling note below — this is the one number worth setting deliberately.
- **Whether team rows are collapsible.** Proposed: yes, collapsed by default past three teams, so a nine-seat fleet does not push the Memo section off-screen.

## Complexity Audit

### Routine

- A `<section>` of rows rendered from one state object, in the sidebar's existing `.section-label` idiom.
- One `getSidebarStatus()` accessor on `TaskViewerProvider` returning the whole snapshot, pushed to the webview as a single message. One accessor, not six — the same reasoning the terminals-grid plan gives for its `{ apiPort, ready }` pair: separate reads can be observed half-updated across an `await`.
- Deep-links reuse the commands the Launch section already posts.

### Complex / Risky

- **Polling a child process from an always-visible view.** The cockpit already polls the fleet; adding a second poller doubles `ptyListTerminals` IPC for as long as VS Code is open. Gate on `WebviewView.onDidChangeVisibility` and stop the timer when hidden — an always-on 5s poll against a pty host is a background cost users cannot see and will not attribute to Switchboard.
- **Empty must distinguish three states.** `listPtyTerminals()` returns `[]` both when the fleet is up with nothing running and when the pty host never booted (`:1289` returns `[]` on no child). Rendering "no teams" for a failed `ptyHost` boot is the same class of silent lie as the cockpit's stale-host case. Read `_ptyHostBootFailed` and render *fleet unavailable* distinctly from *fleet up, nothing seated*.
- **Never SQL from the webview.** Teams come through the provider accessor, not a query. `sql-write-guardrail-prevent-agents-from-writing-to-kanban-db.md` is the standing direction here, and the config JSON read must go through the same `_groupsWriteChain`-respecting path rather than a parallel reader.
- **No start, stop, restart, clear, ack or move.** If a row needs an action, the row links to the panel that owns it. This is the plan's one non-negotiable.
- **"Tracker" is not the name.** A tracker in this codebase is ClickUp / Linear / Notion. This is Status.

## Edge-Case & Dependency Audit

**Race Conditions**
- A team row can name a seat that has just exited; the snapshot is a point-in-time read and rows must tolerate a member with no matching live terminal (render it dimmed, not absent — an empty seat is information).
- Workspace switch mid-poll: the snapshot must carry the workspace root it was taken for, and a late reply for the previous root is discarded rather than rendered.

**Security**
- Read-only by construction. No new route, no new token, no user input reaching a query.

**Side Effects**
- The section adds vertical height to a column that is already full. It ships with the IA restructure (`sidebar-becomes-launcher-and-status-board.md`), not before it.

**Dependencies & Conflicts**
- **Sequenced with** `sidebar-becomes-launcher-and-status-board.md` (that plan lays out the slot).
- **Independent of** the Mission Control feature — the mission slot is additive.
- Touches `src/webview/implementation.html` and `src/services/TaskViewerProvider.ts`. No change to `terminals.js`, `teamWiring.ts` or `TeamQueueService.ts` beyond calling existing exports.

## Verification Plan

### Automated
- Unit-test `getSidebarStatus()` against a stubbed provider for four cases: host down; host up + `_ptyHostBootFailed`; fleet up + zero terminals; fleet up + two teams with queue depths.
- Source-scan contract: assert the Status markup contains no element posting any mutating message — enumerate the message types it may post and assert the set is a subset of the known read/navigate list. This is the guard that keeps a control from being added later "just this once".
- Assert the poll timer is created only inside a visibility-true branch.

### Manual
1. With the extension running and no cockpit open: teams and seats appear and match what the cockpit shows when opened.
2. Kill the pty host child: the section reads *fleet unavailable*, not *no teams*.
3. Collapse the sidebar to another view and confirm via the diagnostics channel that polling stops.
4. Enqueue three items on a team from the cockpit: the depth reflects it within one poll interval.
