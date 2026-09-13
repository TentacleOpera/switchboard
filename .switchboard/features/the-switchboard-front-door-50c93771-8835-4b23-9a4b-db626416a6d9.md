# The /switchboard front door

**Complexity:** 7

## Goal

Typing /switchboard must reach the right board, prove it is alive, and present one coherent menu. Nine subtasks across two surfaces — the agent-facing `/switchboard` workflow file and the human-facing CLI menu. Landing order is stated in Dependencies and is not optional: identity before liveness, liveness before the front-door repair, and the run sheet after both.

## How the Subtasks Achieve This

- **adopt-wrong-workspace**: Verifies board identity on both sides of the adopt call — requires `$ROOT` in `health.roots` before using a board, validates `workspaceRoot` server-side against `_allRoots`, and fixes the dead `/orchestration/` endpoints and legacy `.switchboard/orchestrator/` paths that prevent arming entirely. This is the identity foundation: every later subtask assumes the board answering on the port belongs to this workspace.
- **sandbox-liveness**: Adds an AF_UNIX socket at `.switchboard/daemon.sock` serving `GET /health`, giving the launcher a liveness signal that survives sandbox network isolation and distinguishes a dead board (stale inode, refused connect) from a stale port file. Without this, the launcher either hijacks a live board or refuses to launch forever after a crash.
- **front-door-delivers-twice**: Fixes the launcher's redundant read instruction (the persona is already inline in the adopt response — telling the agent to read it again doubles the context) and derives `UNATTENDED`/`ATTENDED` from the session mode instead of hardcoding `UNATTENDED=true` on every door. The posture fix is required by the run-sheet plan, which assumes `ATTENDED=true` on interview.
- **run-sheet**: Decomposes the 619-line Mission Control persona into a menu that asks the operator which job they want and loads only that protocol, deleting the tick apparatus from the interview path. Each branch becomes a protocol loaded on demand; the armed branch keeps the tick, the interview branch gets the menu.
- **standalone-first-launch**: Makes `/switchboard` launch or attach a standalone server instead of demanding an IDE, via a resolution script (`.agents/scripts/switchboard-up.js`) that finds the newest available CLI by semver and fails actionably when nothing qualifies. This is what makes `/switchboard` work in Antigravity or any host without the extension.
- **fleet-command**: Restructures the CLI menu into Fleet Command, Sync, Launch, Setup, Help, Diagnostics with stable mnemonic keys, Enter-does-the-likely-thing ergonomics, remembered serve mode, and every-branch-loops return-to-menu behavior. Absorbs the shipped GUI/CLI split (deleted — already in `cmdMainMenu`) and the deleted keystroke-ergonomics plan. This is the human-facing front door.
- **memo-CLI-fixes**: Six independent CLI fixes: `cmdSetup` fails loudly when reached out of order, `switchboard ready` excludes `CREATED`-column cards, one `emitOfflineGuidance` helper replaces six terse duplicates, port-file-first discovery, `SWITCHBOARD_CLI_PATH` exported from both PTY spawn environments, and a PTY-driven smoke test that actually executes the CLI.
- **column-view**: Excludes subtasks from the column listing (176 of 263 entries on this board), adds a starred filter across columns, and pages long listings so the console is usable over ssh from a phone. Subtasks remain reachable through their feature.
- **project-filter**: Adds `switchboard projects` to list projects with card counts, a project filter in the interactive console, and makes the unassigned set (the largest bucket) selectable. Makes the existing `--project` flag discoverable and fully expressible.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Make standalone the first-class entry point: `/switchboard` launches or attaches instead of demanding an IDE](../plans/standalone-first-launch-instead-of-demanding-an-ide.md) — **PLAN REVIEWED** — ID: 0c2eb71d-9f39-4f6e-8841-c4a241874ef0
- [ ] [Sandbox-Surviving Board Liveness via a Unix Domain Socket](../plans/sandbox-surviving-board-liveness-via-unix-socket.md) — **PLAN REVIEWED** — ID: 0da8db54-0ac8-4d83-9090-640ec099ed37
- [ ] [`/switchboard` accepts any board on the shared port and adopts the wrong workspace — verify identity on both sides of the adopt call](../plans/switchboard-launcher-adopts-the-wrong-workspace.md) — **PLAN REVIEWED** — ID: 928f142e-89b8-4a6d-8d5b-abbe3800258f
- [ ] [Replace the Mission Control persona with a run sheet that asks what you want and loads only that protocol](../plans/replace-the-mission-control-persona-with-a-run-sheet.md) — **PLAN REVIEWED** — ID: 254f724e-df9c-45e4-b4fc-e9c400eadc99
- [ ] [The /switchboard front door arms against an endpoint that does not exist, delivers the persona twice, and hardcodes the wrong posture](../plans/the-mission-control-front-door-delivers-twice-and-lies-about-the-posture.md) — **PLAN REVIEWED** — ID: 135f2c7b-a953-4a03-ba70-5e20928b97e3
- [ ] [The CLI Front Door Exits Non-Zero, Its Setup Handler Silently Does Nothing, and Its Only Gate Cannot Run It](../plans/memo-the-cli-front-door-exits-non-zero-and-its-setup-handler-silently-does-nothing.md) — **PLAN REVIEWED** — ID: 5cc038b6-a729-433c-9a3f-ac53b79cbdae
- [ ] [The Console Column View Lists Subtasks as Plans, and Cannot Filter to What You Care About](../plans/the-console-column-view-lists-subtasks-as-plans-and-cannot-filter-to-what-you-care-about.md) — **PLAN REVIEWED** — ID: 9572d35f-4868-4e7c-85d0-b5fa4e61ac04
- [ ] [The CLI Can Filter by Project, but Cannot List Them or Select Unassigned](../plans/the-cli-can-filter-by-project-but-cannot-list-them-or-select-unassigned.md) — **PLAN REVIEWED** — ID: 07922522-e407-4347-8bcd-345eaaf00f61
- [ ] [The CLI Menu Becomes Fleet Command, Sync, Launch, Setup, Help, Diagnostics](../plans/the-cli-menu-becomes-fleet-command-launch-setup-help-diagnostics.md) — **PLAN REVIEWED** — ID: 5f72cba2-ee4b-46d4-aa1a-2e737ac444f3
<!-- END SUBTASKS -->

## Dependencies & sequencing (2026-09-14, restructured)

Nine subtasks across two surfaces — the agent-facing `/switchboard` workflow file and the human-facing CLI menu. Land in this order; it is not optional, because each step is what makes the next one's check meaningful.

### Agent protocol (`.agents/workflows/switchboard.md` + `src/services/`)

1. **adopt-wrong-workspace** — identity first: require `$ROOT ∈ health.roots` before using a board, validate `workspaceRoot` on both sides of the adopt call, and fix the dead `/orchestration/` endpoints + legacy `.switchboard/orchestrator/` paths. This plan now owns the endpoint + path + start-warning fix (previously duplicated by the front-door plan; reconciled 2026-09-14).
2. **sandbox-liveness** — the Unix socket. The socket answers "is it dead" (a socket dies with the process, so a sandbox that cannot reach loopback TCP can still tell a live board from a stale port file), and the heartbeat file answers "is it alive but not serving". `switchboard stop` is ungated from `/health`.
3. **front-door-delivers-twice** — the read-instruction fix and the posture fix. The endpoint + path fix is deferred to step 1 (reconciled); what remains here is fixing the doubled persona delivery and deriving `UNATTENDED`/`ATTENDED` from the session mode.
4. **run-sheet** — decompose the 619-line persona into a menu. Carries the single recovery rung from decision 9 in its resume branch. Lands on step 3's edits to the same file.
5. **standalone-first-launch** — `/switchboard` launches or attaches instead of demanding an IDE. Depends on B4 (`b4-npx-distribution-publish.md`) and `standalone-cli-attach-and-lifecycle.md` (both external to this feature).

### CLI menu (`src/standalone/cli.ts`)

6. **memo-CLI-fixes** — six independent fixes (cmdSetup, ready columns, no-server helper, port discovery, SWITCHBOARD_CLI_PATH, PTY smoke test). Fix 4 (front-door return-to-menu) has been moved to the fleet-command card. Independent of the menu restructure; can land first.
7. **column-view** — exclude subtasks from the column listing, add starred filter, add paging. Independent of the menu restructure.
8. **project-filter** — `switchboard projects`, project filter in console, unassigned selectable. Independent of the menu restructure.
9. **fleet-command** — the master menu restructure. Absorbs the shipped GUI/CLI split (deleted — already in `cmdMainMenu` at `cli.ts:2697`) and the deleted keystroke-ergonomics plan (Enter, remember mode, return-to-menu). Lands last in the CLI group because it restructures the function the others touch.

### Deleted (restructured 2026-09-14)

- **split-cli-front-door-menu-gui-cli** (`759c05b5`) — **already shipped.** The GUI/CLI bifurcation, state-aware sub-menu, `__board-console` re-spawn, and `cmdBoardConsole` trim are all in `cmdMainMenu` at `cli.ts:2697-2860`. `git rm`'d; no content lost (it's in the code).
- **cli-front-door-costs-keystroke** (`5fb04de7`) — **merged into fleet-command.** Enter-does-the-likely-thing, stable keys, remember serve mode, and don't-add-depth are now proposed changes 7-8 in the fleet-command plan. `git rm`'d; all intent carried forward.

## Team Dispatch Instructions

### adopt-wrong-workspace
- **Seat:** Coder
- **Acceptance:**
  - Running `/switchboard` in workspace B while workspace A's board is live on 7777 stops, names A, and adopts nothing.
  - `curl -X POST /mission-control/adopt -d '{"workspaceRoot":"/nonexistent"}'` returns 400 naming the served roots.
  - No `/orchestration/` string remains in `.agents/workflows/switchboard.md` or `.claude/skills/switchboard/SKILL.md`.
  - Path-normalisation matrix passes: symlinked root, trailing slash, case-insensitive FS, mapped child workspace.
- **Must not touch:** The port-pinning strategy (7777 is deliberate). The `SWITCHBOARD_TERMINAL` empty-rather-than-guess behavior. The single-writer constraint (owned by the storage-layer feature).

### sandbox-liveness
- **Seat:** Coder
- **Acceptance:**
  - `curl --unix-socket .switchboard/daemon.sock http://localhost/health` returns 200 on a live board.
  - After `kill -9`, the socket probe answers refused → `BOARD=dead` → launches a new board (the false positive is gone).
  - With loopback TCP blocked but socket reachable, `BOARD=alive` → no second server, port file untouched.
  - Stale-inode takeover: `EADDRINUSE` → failed probe → unlink → listen succeeds; successful probe → does NOT unlink.
  - `chmod 600` on the created socket inode; `win32` is a no-op.
- **Must not touch:** The peer guard at `LocalApiServer.ts:5965` (the socket gets its own handler). The plan watcher, autoban polling, or DB write serialization.

### front-door-delivers-twice
- **Seat:** Intern
- **Acceptance:**
  - `.agents/workflows/switchboard.md` contains no instruction to read `switchboard-mission-control/SKILL.md`.
  - `interview` and `stale-session` prompts contain `ATTENDED=true` and not `UNATTENDED=true`; `resume` contains `UNATTENDED=true` and not `ATTENDED=true`.
  - The `resume` prompt's `UNATTENDED=true` cannot satisfy a naive `ATTENDED=true` substring test.
  - `manage-features` with `ATTENDED=true` applies the confirm gate; with `UNATTENDED=true` skips it.
- **Must not touch:** The `no-persona` branch (correct as-is). The standalone `deliveryMode` question (out of scope, recorded as a question).

### run-sheet
- **Seat:** Coder
- **Acceptance:**
  - The `interview` prompt contains the menu heading and not `## The Tick`, `## Merge-Back`, or `stallCount`.
  - Every protocol path the menu names resolves on disk.
  - The `resume` prompt contains `## The Tick`, `## Signals`, and the `progress.json` stall-counter contract.
  - No `-o /dev/null` appears in the run sheet, branch protocols, or `.agents/workflows/switchboard.md`.
  - The run sheet is under 80 lines.
- **Must not touch:** The dock project-management buttons (design rationale, not deliverable here). The `no-persona` branch. The standalone `deliveryMode` question.

### standalone-first-launch
- **Seat:** Coder
- **Acceptance:**
  - `node .agents/scripts/switchboard-up.js --workspace "$ROOT"` with nothing running → `SWITCHBOARD_MODE=launched`, a port, `/health` answers with `$ROOT` in `roots`, server survives the shell exiting.
  - With a live extension, same command → `SWITCHBOARD_MODE=attached`, port equals the extension's, no second process.
  - Resolution skips bundle-less roots (Windsurf 1.7.3 shape) and sorts by parsed semver, not string.
  - Failure message names what was tried and says neither "open VS Code" nor "install the extension in this IDE".
  - In a directory with no `.switchboard/`, refuses rather than creating one.
- **Must not touch:** Publishing to npm or renaming the package (B4's deliverable). Attach semantics, session minting, pid file, `switchboard stop` (all in `standalone-cli-attach-and-lifecycle.md`). The single-writer constraint.

### memo-CLI-fixes
- **Seat:** Coder
- **Acceptance:**
  - `cmdSetup` from below the routing point fails visibly; no wizard choice is silently discarded.
  - `switchboard ready` does not offer `CREATED`-column cards or dispatch them with `auto`.
  - `grep` finds one `emitOfflineGuidance` helper and no terse duplicates across all six no-server sites.
  - With no server running, a command returns in well under two seconds.
  - `SWITCHBOARD_CLI_PATH` is set in both PTY spawn environments.
  - The PTY smoke test runs in CI and covers the `ready` picker's EOF/SIGINT exits.
- **Must not touch:** The `cmdMainMenu` loop (owned by the fleet-command card). The `SWITCHBOARD_TERMINAL` behavior.

### column-view
- **Seat:** Intern
- **Acceptance:**
  - The Planned column lists features and top-level plans, not 263 entries.
  - No card with a `featureId` appears in a column's PLANS section.
  - Selecting a feature lists its subtasks; one can be dispatched from there.
  - A starred filter shows only starred cards and says so in the header.
  - Selecting card N on page 2 dispatches the card shown as N on page 2.
- **Must not touch:** The ready/dispatch view (already correct). The `featureId === ''` filter logic (reuse, don't rewrite).

### project-filter
- **Seat:** Intern
- **Acceptance:**
  - `switchboard projects` lists both projects with their counts and the unassigned count.
  - The interactive console can pick a project from the list and shows it in the header.
  - Unassigned can be selected and returns the unassigned set, not everything.
  - Omitting the flag still means no filter.
  - A project filter and a starred filter apply together.
- **Must not touch:** Project creation (only the operator creates projects, on the board). The existing `--project` flag matching logic (reuse, don't rewrite).

### fleet-command
- **Seat:** Lead Coder
- **Acceptance:**
  - The menu is Fleet Command, Sync, Launch, Setup, Help, Diagnostics with stable keys.
  - Enter does the likely thing (Fleet command when online, Launch when offline); the prompt states what Enter will do.
  - Every branch loops back to the menu after child exit — no `exitFlushed(code)` inside the `for(;;)` loop body.
  - The remembered serve mode is displayed before it is taken and records its source.
  - Monitor redraws on an interval until a key exits; with the server stopped, it reports that and stops.
  - Starred shows only starred cards across all columns with no column step.
- **Must not touch:** The `__board-console` re-spawn pattern (already shipped). The `banner(version)` function (reuse, don't duplicate). The non-TTY guard. Direct subcommand bypass.
