# `npx switchboard` has no lifecycle — add detached start/stop/status/logs and per-OS autostart

## Goal

Turn the standalone launch from a foreground script into something that can be managed: `switchboard start` detached, `switchboard stop`, `switchboard status`, `switchboard logs`, plus documented autostart units for macOS, Linux and Windows. This is the single largest contributor to Switchboard reading as a hobby tool rather than infrastructure, and none of it requires touching the server.

### Problem Analysis

`src/standalone/cli.ts` ends its server path with:

```ts
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
await new Promise(() => { /* never resolves */ });
```

The process is structurally foreground-only. The consequences compound:

- **Closing the terminal kills the board**, and with it every PTY in the fleet — so an unattended orchestration run dies with the shell that happened to start it. This is directly at odds with Switchboard's own pitch of fleets grinding through a feature.
- **There is no way to ask whether it is running.** The capability exists but is private: `findRunningInstance` (`cli.ts:202`) reads `.switchboard/api-server-port.txt` and probes `/health`, and is called *only* to refuse a second instance. No user-facing command surfaces it.
- **There is no way to stop it except Ctrl+C or hunting the PID.** No PID file is written — only the port file (`bootstrap.ts:2586`).
- **Output is wherever the shell went.** The startup banner, the `[switchboard]` logs, `autoban restore failed`, `team autostart failed` — all `console.log` to an inherited stdout with no file sink. Detached, they go nowhere.
- **`openBrowser` fires on a headless box.** `cli.ts` calls `xdg-open`/`open`/`start` unconditionally unless `--no-open` is passed. On a server that is noise at best; the operator must know to pass a flag that exists for a different reason.

### Root Cause

The CLI was built as an alternative *entry point* to the extension, not as a service manager. Every ingredient for lifecycle management is already present — a health endpoint reporting `{status, port, roots, pid, terminals}`, a port discovery file, a clean async `stop()` that disposes the WS gateway, PTY fleet, ingestion engine, all panel providers, and the server in order (`bootstrap.ts:2646-2656`) — but nothing is wired to a verb a user can type.

### Non-goals

- No process supervision or auto-restart of our own. Delegate that to launchd/systemd/Task Scheduler, which do it better; ship the units, not a supervisor.
- No change to single-writer-per-workspace. `findRunningInstance`'s refusal is correct and stays.
- No change to auth, bind address, or the loopback guards.

## Metadata

**Complexity:** 5
**Tags:** cli, devops, reliability, infrastructure
**Feature:** 6fb8574c-be7e-44be-9ad2-2272cf449d3c

## User Review Required

No user review required. The changes are additive CLI verbs and documentation — no existing behaviour changes unless the user explicitly passes `--detach`. The foreground path is a regression fence in the verification plan.

## Complexity Audit

### Routine
- `switchboard status` — promotes the existing `findRunningInstance` + `/health` probe to a user-facing command. The `/health` endpoint already returns `pid`, `port`, `roots`, `terminals`, `terminalCount`, and `selectedWorkspaceRoot` (`LocalApiServer.ts:4477-4495`).
- PID file write/unlink alongside the existing port file — strictly additive.
- `switchboard logs [-f]` — file tail with rotation.
- Autostart unit templates — documentation files, not code.

### Complex / Risky
- **`start --detach` re-spawn.** Detaching correctly (`{detached: true, stdio: ['ignore', logFd, logFd]}`, `unref()`) and waiting for health before reporting success — a detached launch that returns 0 for a server that failed to boot is a silent failure.
- **Stale PID safety.** A PID file is advisory, not authoritative — a recycled PID could point at an unrelated process. `stop` must confirm identity via `/health` on the recorded port *before* signalling. Never signal a PID on the strength of the file alone.
- **Grace period for `stop`.** A hard kill (`SIGKILL`) can abandon the debounced `kanban.db` persist (300 ms trailing debounce plus export/rename). The grace period must cover this, and the operator must be told when escalation happens.
- **Double signal handlers.** Both `cli.ts` (lines 597-601, `process.on`) and `bootstrap.ts` (lines 2666-2669, `process.once`) register SIGINT/SIGTERM handlers. Both call `instance.stop()`. The `stop` command sends SIGTERM, which triggers both — harmless because both wrap in try/catch, but the `stop` command must not assume its own handler is the only one.
- **Log rotation without losing the active handle.** An orchestration run producing PTY chatter for days must not fill the disk, but rotating a file the process is writing to requires care (reopen the handle, not just rename).

## Edge-Case & Dependency Audit

**Race Conditions:**
- `start --detach` re-spawns itself and then polls `waitForHealth`. If the child process fails to boot (port occupied, missing workspace), the parent must detect this within the health-check timeout and exit non-zero. The existing `waitForHealth` (10-second timeout) is the right primitive.
- `stop` sends SIGTERM and polls `/health` until it stops answering. If the server is in the middle of a debounced DB persist, the grace period must be long enough for the 300 ms debounce plus the export/rename. A grace period of 5 seconds is conservative.
- Double-start: `findRunningInstance` is called before `startHeadlessSwitchboard` in the foreground path. A detached `start` must also check, or the second instance's `bootstrap.ts` signal handlers will conflict with the first's.

**Security:**
- The PID file is advisory — never signal a PID from the file alone. Always confirm via `/health` on the recorded port first. Verification step 4 covers the stale-PID case.
- Log files may contain sensitive output (terminal chatter, token URLs). The log directory must be in `.switchboard/logs/` (workspace-scoped, not world-readable) and added to `.gitignore`.

**Side Effects:**
- `.switchboard/logs/` is a new directory. Confirm it lands in `.gitignore` handling for scaffolded workspaces so a user's repo does not start tracking server logs.
- `--detach` implies `--no-open` unless `--open` is passed explicitly — a detached launch on a headless host has no browser to open.

**Dependencies & Conflicts:**
- `switchboard status` and autostart units are of limited use while the session secret is regenerated per launch — the URL `status` prints leads to a 401 after any restart. The durable-session-token plan should land first.
- No conflict with the remote-access plan — that plan touches `TicketsPanelProvider` and docs, neither of which this plan opens.
- The default port change from the durable-session-token plan (7777) is compatible with this plan's autostart units, which pin `--port <fixed>` explicitly.

## Dependencies

- `sess_6f42af40` — Standalone durable session token: should land first. `switchboard status` prints a board URL that 401s after any restart without a durable token, and an autostarted server is precisely the case where nobody is watching stdout for the replacement token.

## Adversarial Synthesis

Key risks: (1) stale PID signalling — a recycled PID could point at an innocent process; mitigation: confirm identity via `/health` before signalling, never from the file alone. (2) Graceless stop abandoning the debounced DB persist — the `SIGKILL` escalation path can lose kanban state; mitigation: a grace period covering the 300 ms debounce plus export/rename, with the escalation logged. (3) Detached launch reporting success for a failed boot — mitigation: `waitForHealth` before exiting 0. (4) Double signal handlers in cli.ts and bootstrap.ts — harmless but must be understood when implementing `stop`.

## Proposed Changes

**1. `switchboard start [--detach]` (`src/standalone/cli.ts`).**

Keep the current foreground behaviour as the default so nothing breaks for existing users. `--detach` re-spawns itself with `{detached: true, stdio: ['ignore', logFd, logFd]}` and `unref()`s, prints the board URL and PID, and exits 0. Reuse the existing `waitForHealth(instance.port)` before reporting success, so `--detach` never returns 0 for a server that failed to boot.

When detaching, imply `--no-open` unless `--open` is passed explicitly — a detached launch on a headless host has no browser to open.

**2. PID file alongside the existing port file.**

Write `.switchboard/api-server.pid` next to `api-server-port.txt` (`bootstrap.ts:2586`), and unlink it in the same `stop()` cleanup that unlinks the port file (`bootstrap.ts:2655`).

Treat the PID as advisory, not authoritative: a stale PID after an unclean kill can be recycled by an unrelated process, so `stop` must confirm identity via `/health` on the recorded port **before** signalling. Never signal a PID on the strength of the file alone.

**3. `switchboard status`.**

Promote `findRunningInstance` to a user-facing command. Report: running/not, PID, port, board URL, workspace root, and the terminal count and `selectedWorkspaceRoot` that `/health` already returns (`LocalApiServer.ts:4477-4495`). The `/health` endpoint already includes `pid: process.pid` at line 4491. Exit 0 running, 1 not — so it composes in scripts. Add `--json` for the same reason `control-plane preview` has machine-readable output, reusing that block's `routeLogsToStderr` + `emitJson` discipline so DB chatter cannot corrupt the payload.

**4. `switchboard stop`.**

Resolve the instance via `/health`, `SIGTERM` the PID, poll `/health` until it stops answering, and report. Escalate to `SIGKILL` only after a stated grace period, and say so when it happens — a hard kill can abandon the debounced `kanban.db` persist, which is exactly the data-loss shape `flushWorkspaceDb` exists to prevent, so the grace period must be long enough for the 300 ms trailing debounce plus the export/rename. **No confirmation prompt** — per `CLAUDE.md`, stop immediately.

Note: both `cli.ts` (lines 597-601) and `bootstrap.ts` (lines 2666-2669) register SIGINT/SIGTERM handlers. Sending SIGTERM triggers both — both call `instance.stop()` and both wrap in try/catch, so the double-fire is harmless. The `stop` command does not need to handle this specially.

**5. Log file + `switchboard logs [-f]`.**

Write to `.switchboard/logs/server.log` with size-capped rotation (one rotation, `server.log.1`) — an orchestration run producing PTY chatter for days must not fill the disk. `logs -f` tails. Foreground mode keeps writing to stdout as today *and* to the file, so the two modes report identically.

**6. Autostart units, shipped as files, not prose.**

`docs/` gains ready-to-edit templates: a launchd `.plist`, a systemd **user** unit (not system — the agent CLIs need the user's own credentials and login session), and a Task Scheduler XML or `schtasks` line. Each pinned to `--detach --port <fixed> --workspace <path>`.

The unit templates must carry the two non-obvious requirements as comments: **Node ≥ 22** on `PATH` (`package.json` `engines`), and a `PATH` that includes the agent CLIs (`claude`, `codex`) — a login-shell `PATH` is not what launchd or systemd hand a service, and the symptom of getting this wrong is a board that starts fine and every dispatched terminal failing to spawn.

### Migration

- `api-server-port.txt` is read by shipped external skills and by `findRunningInstance`. Its name, location and plain-integer contents must not change. The PID file is strictly additive.
- Foreground `npx switchboard` must behave exactly as it does today when no new flag is passed. This is the compatibility fence for ~4,000 installs, many on older versions.
- `.switchboard/logs/` is new. Confirm it lands in `.gitignore` handling for scaffolded workspaces so a user's repo does not start tracking server logs.

## Verification Plan

1. **Detach survives the shell.** `switchboard start --detach`, close the terminal, confirm the board still answers `/health` and terminals still stream.
2. **Detach reports honestly.** Force a boot failure (occupy the port with a non-Switchboard listener) and confirm `--detach` exits non-zero with a real error rather than 0 and a URL.
3. **Round trip.** `start --detach` → `status` (exit 0, correct PID/port/URL) → `stop` → `status` (exit 1). Confirm both PID and port files are gone after stop.
4. **Stale PID is not signalled.** Kill -9 the server, hand-write an unrelated live PID into the pid file, run `stop`, and confirm it refuses on the failed `/health` identity check instead of signalling an innocent process. This is the dangerous case in the plan.
5. **Graceful stop preserves the DB.** Move a card, `stop` immediately, restart, confirm the move persisted — proving the grace period covers the debounced persist.
6. **Foreground unchanged.** Plain `npx switchboard` prints the same banner, opens a browser, and Ctrl+C shuts down cleanly. Regression fence.
7. **Detach does not open a browser**, and `--detach --open` does.
8. **Logs.** Confirm the file is written in both modes, `logs -f` tails live, and rotation triggers at the cap without losing the active handle.
9. **`--json`** parses under `| jq` with a DB-chatty startup — the failure this guards is service log lines prefixing the payload.
10. **One unit end-to-end.** Install the systemd user unit, reboot, confirm the board is up and a dispatched terminal actually spawns an agent CLI — the `PATH` failure only shows up here, not in a shell-launched test.
11. **Double-start still refused.** With a detached instance running, a second `start` on the same workspace exits 1 with the existing single-writer message.

## Outstanding Questions

- **[user]** Should `switchboard stop` also work when the PID file is missing (falling back to `findRunningInstance` + `ps` lookup by port), or is the PID file the sole resolution path? — proceeding on the assumption that `findRunningInstance` + `/health` is the primary resolution path and the PID file is a convenience, since `/health` already returns `pid`.

## Completion Report

Implemented all six proposed changes: `start --detach` (re-spawn with `SWITCHBOARD_DETACHED=1` env, poll `findRunningInstance` for honest success), `stop` (resolve via `/health`, SIGTERM with 5s grace, SIGKILL escalation with identity re-verification), `status` (exit 0/1, `--json` via `routeLogsToStderr`+`emitJson`), `logs [-f]` (polling tail with rotation awareness), PID file in `bootstrap.ts` (advisory, unlinked in `stop()` and sync cleanup), and autostart unit templates (launchd plist, systemd user service, Windows Task Scheduler XML). File logging via `setupFileLogging` wraps all stdout-bound console channels (log/info/debug) plus warn/error, with 10 MiB rotation to `server.log.1` using `appendFileSync` (no long-lived fd to lose). Files changed: `src/standalone/cli.ts`, `src/standalone/bootstrap.ts`, `src/services/ControlPlaneMigrationService.ts` (`.switchboard/logs/` gitignore exclusion + merge-logic fix for `.`-prefixed lines), and four new files in `docs/autostart/`. No issues encountered — the durable-session-token subtask's `resolvedToken` and default port 7777 were already in place and compatible.
