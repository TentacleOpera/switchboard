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
- **There is no way to ask whether it is running.** The capability exists but is private: `findRunningInstance` (`cli.ts`) reads `.switchboard/api-server-port.txt` and probes `/health`, and is called *only* to refuse a second instance. No user-facing command surfaces it.
- **There is no way to stop it except Ctrl+C or hunting the PID.** No PID file is written — only the port file (`bootstrap.ts:2492`).
- **Output is wherever the shell went.** The startup banner, the `[switchboard]` logs, `autoban restore failed`, `team autostart failed` — all `console.log` to an inherited stdout with no file sink. Detached, they go nowhere.
- **`openBrowser` fires on a headless box.** `cli.ts` calls `xdg-open`/`open`/`start` unconditionally unless `--no-open` is passed. On a server that is noise at best; the operator must know to pass a flag that exists for a different reason.

### Root Cause

The CLI was built as an alternative *entry point* to the extension, not as a service manager. Every ingredient for lifecycle management is already present — a health endpoint reporting `{status, port, roots}`, a port discovery file, a clean async `stop()` that disposes the WS gateway, PTY fleet, ingestion engine and server in order (`bootstrap.ts:2553-2562`) — but nothing is wired to a verb a user can type.

### Non-goals

- No process supervision or auto-restart of our own. Delegate that to launchd/systemd/Task Scheduler, which do it better; ship the units, not a supervisor.
- No change to single-writer-per-workspace. `findRunningInstance`'s refusal is correct and stays.
- No change to auth, bind address, or the loopback guards.

## Metadata

**Complexity:** 5
**Tags:** cli, devops, reliability, infrastructure

## Proposed Changes

**1. `switchboard start [--detach]` (`src/standalone/cli.ts`).**

Keep the current foreground behaviour as the default so nothing breaks for existing users. `--detach` re-spawns itself with `{detached: true, stdio: ['ignore', logFd, logFd]}` and `unref()`s, prints the board URL and PID, and exits 0. Reuse the existing `waitForHealth(instance.port)` before reporting success, so `--detach` never returns 0 for a server that failed to boot.

When detaching, imply `--no-open` unless `--open` is passed explicitly — a detached launch on a headless host has no browser to open.

**2. PID file alongside the existing port file.**

Write `.switchboard/api-server.pid` next to `api-server-port.txt` (`bootstrap.ts:2492`), and unlink it in the same `stop()` cleanup that unlinks the port file (`bootstrap.ts:2561`).

Treat the PID as advisory, not authoritative: a stale PID after an unclean kill can be recycled by an unrelated process, so `stop` must confirm identity via `/health` on the recorded port **before** signalling. Never signal a PID on the strength of the file alone.

**3. `switchboard status`.**

Promote `findRunningInstance` to a user-facing command. Report: running/not, PID, port, board URL, workspace root, and the terminal count and `selectedWorkspaceRoot` that `/health` already returns (`LocalApiServer.ts:770-783`). Exit 0 running, 1 not — so it composes in scripts. Add `--json` for the same reason `control-plane preview` has machine-readable output, reusing that block's `routeLogsToStderr` + `emitJson` discipline so DB chatter cannot corrupt the payload.

**4. `switchboard stop`.**

Resolve the instance via `/health`, `SIGTERM` the PID, poll `/health` until it stops answering, and report. Escalate to `SIGKILL` only after a stated grace period, and say so when it happens — a hard kill can abandon the debounced `kanban.db` persist, which is exactly the data-loss shape `flushWorkspaceDb` exists to prevent, so the grace period must be long enough for the 300 ms trailing debounce plus the export/rename. **No confirmation prompt** — per `CLAUDE.md`, stop immediately.

**5. Log file + `switchboard logs [-f]`.**

Write to `.switchboard/logs/server.log` with size-capped rotation (one rotation, `server.log.1`) — an orchestration run producing PTY chatter for days must not fill the disk. `logs -f` tails. Foreground mode keeps writing to stdout as today *and* to the file, so the two modes report identically.

**6. Autostart units, shipped as files, not prose.**

`docs/` gains ready-to-edit templates: a launchd `.plist`, a systemd **user** unit (not system — the agent CLIs need the user's own credentials and login session), and a Task Scheduler XML or `schtasks` line. Each pinned to `--detach --port <fixed> --workspace <path>`.

The unit templates must carry the two non-obvious requirements as comments: **Node ≥ 22** on `PATH` (`package.json` `engines`), and a `PATH` that includes the agent CLIs (`claude`, `codex`) — a login-shell `PATH` is not what launchd or systemd hand a service, and the symptom of getting this wrong is a board that starts fine and every dispatched terminal failing to spawn.

### Migration

- `api-server-port.txt` is read by shipped external skills and by `findRunningInstance`. Its name, location and plain-integer contents must not change. The PID file is strictly additive.
- Foreground `npx switchboard` must behave exactly as it does today when no new flag is passed. This is the compatibility fence for ~4,000 installs, many on older versions.
- `.switchboard/logs/` is new. Confirm it lands in `.gitignore` handling for scaffolded workspaces so a user's repo does not start tracking server logs.

### Dependency

`switchboard status` and any autostart unit are of limited use while the session secret is regenerated per launch — the URL `status` prints leads to a 401 after any restart, and an autostarted server is precisely the case where nobody is watching stdout for the new token. This plan is shippable and useful on its own (start/stop/logs/units all stand alone), but the durable-session-token plan should land first for the pair to feel finished.

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
