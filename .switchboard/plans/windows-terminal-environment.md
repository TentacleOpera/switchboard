# Windows terminals get an unusable environment — the wrong shell from Git Bash, no PATH from Task Scheduler

## Goal

Make a dispatched terminal on Windows actually spawn an agent CLI. Two independent defects produce the same symptom from two different launch contexts, and a third item documents a resolver limitation that currently surprises Windows users.

### Problem Analysis

**The PTY backend prefers an environment variable over its own platform default.** `src/standalone/ptyBackend.ts:84`:

```js
const shell = options.shell || process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : 'bash');
```

Git Bash on Windows sets `SHELL=/usr/bin/bash` — an MSYS path with no meaning to ConPTY. A developer launching from the terminal they are most likely to be sitting in gets that path handed to `pty.spawn()` ahead of the PowerShell default, and terminals fail to spawn. The `win32` branch is present and correct; it is simply unreachable whenever `SHELL` is set. ConPTY itself is not in question — the shell *selection* is the defect.

**The Windows autostart template cannot satisfy the requirement its own comment states.** `docs/autostart/README.md:19` and `:25` instruct the reader to set `PATH` "explicitly in the unit", naming Task Scheduler alongside launchd and systemd. Task Scheduler XML has no environment-variable mechanism at all — the `<Exec>` action supports only `<Command>`, `<Arguments>`, and `<WorkingDirectory>`. `switchboard-windows.xml:23-28` acknowledges this and can only advise adding Node to the system PATH or hardcoding the full node path — which addresses documented requirement 1 and leaves requirement 2, the agent CLIs, unmeetable. The failure mode is exactly the one the README warns about: the board starts, and every dispatched terminal fails to spawn.

**`switchboard.localhost` does not resolve on Windows, and that is undocumented.** The Windows resolver does not implement the reserved `.localhost` TLD; browsers do it internally. `resolveDisplayHostname` already probes `/health` and falls back to `127.0.0.1` with a warning, which is correct behaviour and not a bug. But nothing tells a Windows reader to expect a different URL from the one in every doc and screenshot.

### Root Cause

`process.env.SHELL` reads as "the user's shell" and is in fact "the user's POSIX shell, if any." And the autostart README generalised a Unix service-manager concept — a declarative `Environment=` directive — across a manager that has no such thing.

### Non-goals

- Not making `.localhost` resolve on Windows. It cannot without a hosts-file edit, and the existing probe-and-fall-back is the right behaviour.
- No change to ConPTY usage or to the `node-pty` version.
- Not introducing `ComSpec` into the shell chain. `COMSPEC` points at `cmd.exe` (the command interpreter), not the preferred interactive shell. Replacing the PowerShell default with `ComSpec` would regress every Windows user to cmd.exe.

## Metadata

**Complexity:** 3
**Tags:** windows, pty, devops, documentation

## User Review Required

None. Both code paths are broken on Windows today and unchanged on other platforms.

## Complexity Audit

### Routine
- The `ptyBackend.ts:84` condition — a one-line change adding a path-format guard on `SHELL` for `win32`.
- The `.localhost` documentation note in `docs/REMOTE_ACCESS.md` (confirmed to exist) and the autostart README.
- Correcting the two README lines that imply a uniform PATH mechanism.
- Shipping `docs/autostart/switchboard-autostart.cmd` and pointing the XML's `<Command>` at it.

### Complex / Risky
- **The wrapper `.cmd` is the only place PATH can be set for Task Scheduler**, so it becomes a required install step rather than an optional convenience. It must be discoverable enough that a reader does not skip it and hit the exact failure the README warns about. The wrapper must end with `exit /b %errorlevel%` so Task Scheduler's `<RestartOnFailure>` sees the real exit code. The exit-code chain must be verified: `npx switchboard start` propagates via `process.exit()` in `cli.ts` on the happy path, and an uncaught exception in `bootstrap.ts` exits with code 1, which `npx` does propagate — but the wrapper must not mask it.

## Edge-Case & Dependency Audit

- **`SHELL` on `win32` should be honoured only if it is an absolute Windows path** (e.g., `C:\Program Files\PowerShell\7\pwsh.exe`). An MSYS path (`/usr/bin/bash`) or a Unix path must be skipped, falling through to `powershell.exe`. Use `path.isAbsolute()` combined with a `process.platform === 'win32'` check — `path.isAbsolute('/usr/bin/bash')` returns `false` on Windows (the Windows `path.isAbsolute` requires a drive letter), so a single `path.isAbsolute(process.env.SHELL)` guard on `win32` naturally rejects MSYS paths and accepts `C:\...` paths.
- `ComSpec` is NOT the correct environment variable to honour for PTY shell selection. It points at `cmd.exe`, the command interpreter, not an interactive shell. Introducing it would regress the default from PowerShell to cmd.exe.
- An explicit `options.shell` passed by a caller must keep winning on every platform — this change affects only the fallback chain.
- The wrapper must not swallow the exit code, or Task Scheduler's `<RestartOnFailure>` sees a success it should not. Use `exit /b %errorlevel%`.
- The `--detach` defect logged on `standalone-daemon-lifecycle.md` also touches `switchboard-windows.xml`. Both edits land in the same file and the same README, so they must be sequenced by one reviewer.

## Dependencies

- Independent of the shutdown-verb plan; no shared files.
- **Overlaps `standalone-daemon-lifecycle.md` in `docs/autostart/README.md` and `switchboard-windows.xml`.** Same reviewer, or conflicting edits.

## Adversarial Synthesis

Key risks: (1) the `ComSpec` substitution would regress the Windows default shell from PowerShell to cmd.exe — the fix is a path-format guard on `SHELL`, not a variable swap. (2) The wrapper `.cmd` must propagate the exit code via `exit /b %errorlevel%` or Task Scheduler's restart-on-failure is silently disabled. (3) `path.isAbsolute()` on Windows naturally rejects MSYS paths (no drive letter), making the guard a one-liner. Mitigations: use `path.isAbsolute(process.env.SHELL)` on `win32` to accept real Windows paths and reject MSYS paths; end the wrapper with `exit /b %errorlevel%`; verify the exit-code chain from `bootstrap.ts` through `npx` through the wrapper.

## Proposed Changes

1. **Fix `ptyBackend.ts:84`** so `process.env.SHELL` is consulted on `win32` only when it is an absolute Windows path (`path.isAbsolute(process.env.SHELL)` — on Windows this requires a drive letter, naturally rejecting MSYS paths like `/usr/bin/bash`). Keep `powershell.exe` as the `win32` default. Do NOT introduce `ComSpec`. The corrected line:
   ```js
   const shell = options.shell
     || (process.platform === 'win32'
         ? (process.env.SHELL && path.isAbsolute(process.env.SHELL) ? process.env.SHELL : 'powershell.exe')
         : (process.env.SHELL || 'bash'));
   ```
   This preserves user intent (a Windows-path `SHELL` is honoured) while rejecting the MSYS path that breaks ConPTY.

2. **Ship `docs/autostart/switchboard-autostart.cmd`** — a wrapper that sets `PATH` (Node + agent CLI directories) then calls `npx switchboard start`, ending with `exit /b %errorlevel%` so the exit code propagates to Task Scheduler's `<RestartOnFailure>`. Point the XML's `<Command>` at it instead of `npx.cmd` directly.

3. **Correct `README.md:19` and `:25`** so they stop implying a uniform `PATH` mechanism across all three service managers. Name the wrapper `.cmd` as the Windows path. Keep the launchd `EnvironmentVariables` and systemd `Environment=` guidance for macOS and Linux.

4. **Document the `.localhost` fallback** in `docs/REMOTE_ACCESS.md` (confirmed to exist) and the autostart README: on Windows the OS resolver does not implement the TLD, the probe fails, and the URL falls back to `127.0.0.1` by design. This is a documentation note, not a code change.

### Migration

None. New file plus a template edit; no persisted state.

## Verification Plan

1. **Git Bash on Windows spawns a working terminal.** Launch with `SHELL=/usr/bin/bash` set; confirm a dispatched terminal starts PowerShell rather than failing.
2. **An absolute Windows `SHELL` is honoured.** Set `SHELL=C:\Program Files\PowerShell\7\pwsh.exe`; confirm the dispatched terminal uses PowerShell 7, not the default `powershell.exe`.
3. **An explicit shell still wins.** Pass `options.shell` on Windows and on Linux; confirm both honour it.
4. **Windows autostart end-to-end.** Install the task via the wrapper, reboot, confirm the board comes up *and* a dispatched terminal actually spawns an agent CLI. The PATH failure only appears at that second step.
5. **The wrapper propagates failure.** Make the launch fail (e.g., remove Node from the wrapper's PATH); confirm Task Scheduler records a non-zero result and triggers `<RestartOnFailure>`.
6. **Linux and macOS regression fence.** Confirm the shell fallback chain is unchanged on both — `SHELL` still honoured, `-l` still passed.

## Outstanding Questions

None.
