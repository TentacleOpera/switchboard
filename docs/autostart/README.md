# Switchboard Autostart Units

Ready-to-edit templates for starting the Switchboard standalone server automatically on boot/login.

## Files

| File | Platform | Install location |
|------|----------|-----------------|
| `switchboard.launchd.plist` | macOS | `~/Library/LaunchAgents/com.switchboard.server.plist` |
| `switchboard.systemd.service` | Linux | `~/.config/systemd/user/switchboard.service` |
| `switchboard-windows.xml` | Windows | Import via `schtasks /Create /XML` |

## What to edit

Each template has three values you must replace:

1. **Path to the switchboard CLI** — `which npx` or `which switchboard` (after a global install).
2. **Workspace path** — the `--workspace <path>` value, matching your Switchboard workspace root.
3. **PATH environment variable** — must include Node >= 22 AND the agent CLIs (`claude`, `codex`).

## `--detach` is for a shell prompt, not for a service manager

**None of these templates pass `--detach`, and none of them should.** `--detach`
re-spawns the server as a detached child, waits for it to answer `/health`, prints
the URL and exits 0 — exactly right for a human who wants their prompt back, and
exactly wrong for a supervisor, whose entire job is the backgrounding being done
for it.

Pass it to a service manager and the manager tracks the parent, which exits 0
immediately. The board then runs unsupervised:

- **systemd** — `Restart=on-failure` never fires; the cgroup still makes
  `systemctl --user stop` work, so the unit half-works. That is the worst outcome:
  a crashed board at 3am with `systemctl --user status` reporting healthy.
- **launchd** — `KeepAlive`/`SuccessfulExit: false` means "restart on a non-zero
  exit", and the parent exits 0, so it is inert. macOS has no cgroups, so launchd
  additionally loses the daemon: `launchctl unload` will not stop it.
- **Task Scheduler** — `RestartOnFailure` never observes the daemon die, because
  the task completes the moment the parent exits.

Every template runs the server in the foreground and lets the manager own it.

## The two non-obvious requirements

These are the difference between a board that works and one that starts fine but every dispatched terminal fails to spawn:

1. **Node >= 22 on PATH.** `package.json` `engines` requires `node >= 22.0.0`. Service managers (launchd, systemd, Task Scheduler) do NOT inherit your login shell PATH — they run with a minimal default. Set `PATH` explicitly in the unit.

2. **Agent CLIs on PATH.** `claude`, `codex`, and any other agent CLI must be findable. A login-shell PATH is not what a service manager hands a service. If the board starts but dispatched terminals fail to spawn, this is why.

## Verification

After installing and starting the unit:

```bash
npx switchboard status
```

Should report `Running (PID ..., port 7777)`. Then check both halves:

1. **PATH.** Dispatch a terminal from the board and confirm the agent CLI actually
   spawns — the PATH failure only shows up here, not in a shell-launched test.
2. **Crash restart.** `kill -9` the server PID and confirm the manager brings it
   back (`systemctl --user status switchboard`, or `npx switchboard status` after a
   few seconds). A unit that starts on boot but never restarts on a crash looks
   healthy right up until it isn't.
