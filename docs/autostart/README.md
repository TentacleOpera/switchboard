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

## The two non-obvious requirements

These are the difference between a board that works and one that starts fine but every dispatched terminal fails to spawn:

1. **Node >= 22 on PATH.** `package.json` `engines` requires `node >= 22.0.0`. Service managers (launchd, systemd, Task Scheduler) do NOT inherit your login shell PATH — they run with a minimal default. Set `PATH` explicitly in the unit.

2. **Agent CLIs on PATH.** `claude`, `codex`, and any other agent CLI must be findable. A login-shell PATH is not what a service manager hands a service. If the board starts but dispatched terminals fail to spawn, this is why.

## Verification

After installing and starting the unit:

```bash
npx switchboard status
```

Should report `Running (PID ..., port 7777)`. Then dispatch a terminal from the board and confirm the agent CLI actually spawns — the PATH failure only shows up here, not in a shell-launched test.
