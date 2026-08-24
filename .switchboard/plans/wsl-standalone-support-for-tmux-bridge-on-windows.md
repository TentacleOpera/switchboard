# WSL Standalone Support for tmux Bridge on Windows

## Goal

Make "run Switchboard standalone inside WSL" a first-class, documented, and friction-free path so Windows users get the tmux bridge (Parts 1 and 2) without any code special-casing the Windows-host-to-WSL boundary. The tmux bridge already works on Linux; WSL is Linux. The gap is three practical friction points: browser opening from inside WSL, user discovery of the WSL path, and a setup guide.

### Problem Analysis

**Core problem.** The tmux bridge (Parts 1 and 2) lets standalone Switchboard dispatch prompts into tmux panes it does not own. tmux does not exist on native Windows, and a Windows-host Node process cannot reach a tmux server inside WSL across the socket boundary. But if Switchboard itself runs inside WSL, the boundary disappears — it is Linux talking to Linux, and the bridge works as designed with no special-casing.

**Root cause of the friction.** Switchboard standalone already works on Linux, and WSL2 is Linux. The server binds `127.0.0.1` (`LocalApiServer.ts:681`), the socket peer check accepts `127.0.0.1` and `::1` (`LocalApiServer.ts:6218-6219`), and the Host-header guard accepts `localhost` (`loopbackHostname.ts:62-66`). WSL2's automatic localhost forwarding maps Windows `localhost:<port>` to WSL's `127.0.0.1:<port>`, so a Windows browser reaches the WSL server and passes every guard. Nothing about the server needs to change.

The friction is in three places:

1. **Browser opening.** `openBrowser()` in `cli.ts:323-336` dispatches on `process.platform`. Inside WSL, `process.platform` is `'linux'`, so it calls `xdg-open` — which does not exist in a minimal WSL install. The user sees a silent failure and has to find the URL in the logs and open it manually. The fix is detecting WSL and calling `cmd.exe /c start` (or `wslview` if installed) instead.

2. **Discovery.** A Windows user who wants tmux dispatch has no way to learn that running inside WSL is the path. The native-Windows CLI starts, tmux is absent, `isTmuxAvailable()` returns `false`, and the tmux feature is inert — with no hint that WSL would unlock it. A one-line log message when tmux is unavailable on `win32` would close that gap.

3. **Documentation.** There is no setup guide for the WSL path. The user needs to know: install WSL, install Node inside WSL, install tmux inside WSL, clone or link the workspace, run `npx switchboard`, enable the tmux setting, adopt panes. This is a doc page, not code.

**Why not bind 0.0.0.0.** The server binds `127.0.0.1` unconditionally, and that is correct for WSL2 — localhost forwarding handles the Windows-to-WSL hop. Binding `0.0.0.0` would expose the board to every interface on the WSL VM's virtual network, which is a wider attack surface than loopback, and it is unnecessary because WSL2's forwarding already makes `localhost` work. The loopback constraint is load-bearing security (`REMOTE_ACCESS.md`); this plan does not touch it.

**Why not a Windows-native tmux port.** There is no native Windows tmux, and the WSL boundary is the only practical path. Cygwin/MSYS2 tmux builds exist but are not reachable from a native Windows Node process for the same socket reasons. This plan does not attempt to bridge that gap — it makes the WSL path work well instead.

## Dependencies

- **tmux-bridge-1-transport-layer** — the transport module this path unlocks.
- **tmux-bridge-2-standalone-dispatch-integration** — the dispatch wiring this path unlocks.

## Metadata

**Tags:** standalone, wsl, windows, terminals, tmux, feature
**Complexity:** 3

## User Review Required

No — the changes are small, additive, and do not alter any security boundary or existing behaviour.

## Complexity Audit

### Routine
- `/proc/version` read for WSL detection — one `fs.readFileSync` at startup, cached.
- `openBrowser()` WSL arm — one `else if` branch calling `cmd.exe /c start`.
- `docs/wsl-setup.md` — a new doc file.

### Complex / Risky
- **`cmd.exe` availability.** `cmd.exe` is on the PATH in WSL2 by default (Microsoft's interop layer), but a user may have disabled interop via `/etc/wsl.conf` (`[interop] enabled = false`). The code must fall back to `wslview` (if installed) and then to printing the URL, never crash.
- **WSL1 vs WSL2.** WSL1 uses a translation layer, not a real Linux kernel. `node-pty` prebuilds may not match, and localhost forwarding works differently (WSL1 shares the Windows network stack, so `localhost` works natively). The detection should distinguish WSL1 from WSL2 via `/proc/version` (`Microsoft` for WSL1, `microsoft-standard` for WSL2) and log the difference, but both should attempt to work — the failure mode is a clear error, not a silent wrong behaviour.

## Edge-Case & Dependency Audit

### Security
- No change to the loopback bind or the socket peer check. WSL2 localhost forwarding arrives at `127.0.0.1`, so the existing guards pass unchanged. This plan does not widen the network surface.
- `cmd.exe /c start <url>` passes the URL as a single argv element to `cmd.exe` via `spawn` (not `exec`), so the URL cannot be shell-interpreted. The URL is constructed internally (`http://localhost:<port>/...`), not user-supplied, so injection is not reachable.

### Race Conditions
- None. WSL detection is a one-shot synchronous read at startup, cached for the process lifetime.

### Side Effects
- The `openBrowser()` change only affects the WSL path. Native Linux (non-WSL) still calls `xdg-open`. Native Windows still calls `cmd /c start`. macOS still calls `open`.
- The discovery hint on native Windows is a log line, not a behaviour change.

### Platform
- **WSL2:** full support — localhost forwarding, real Linux kernel, tmux works, node-pty works.
- **WSL1:** best-effort — tmux works (it is a user-space program), node-pty may need a rebuild, localhost forwarding works via the shared network stack. Log the WSL version so a failure is diagnosable.
- **Native Windows (no WSL):** the discovery hint fires, no behaviour change.
- **Native Linux / macOS:** no change — WSL detection returns `false`, existing paths untouched.

### Dependencies & Conflicts
- No new npm dependency. `cmd.exe` and `wslview` are external binaries probed at runtime, same pattern as `tmux` and `node-pty`.
- Does not touch `LocalApiServer.ts`, `loopbackHostname.ts`, or any security-sensitive file. The server, bind address, and guards are unchanged.

## Proposed Changes

### Phase 1: WSL detection — `src/utils/wslDetect.ts` (new)

A small utility, cached for the process lifetime:

```ts
let _cached: { wsl: boolean; version: 1 | 2 | null } | null = null;

export function detectWsl(): { wsl: boolean; version: 1 | 2 | null } {
    if (_cached) return _cached;
    if (process.platform !== 'linux') {
        _cached = { wsl: false, version: null };
        return _cached;
    }
    try {
        const version = fs.readFileSync('/proc/version', 'utf8');
        // WSL2: "microsoft-standard-WSL2" or "Microsoft"
        // WSL1: "Microsoft" without "standard"
        if (/microsoft/i.test(version)) {
            const isV2 = /microsoft-standard/i.test(version);
            _cached = { wsl: true, version: isV2 ? 2 : 1 };
        } else {
            _cached = { wsl: false, version: null };
        }
    } catch {
        _cached = { wsl: false, version: null };
    }
    return _cached;
}
```

### Phase 2: Browser opening — `src/standalone/cli.ts`

Modify `openBrowser()` to handle WSL:

```ts
async function openBrowser(url: string): Promise<void> {
    const platform = process.platform;
    const wsl = detectWsl();
    let cmd: string;
    const args: string[] = [];
    if (wsl.wsl) {
        // cmd.exe is on PATH via WSL interop; fall back to wslview, then give up.
        cmd = 'cmd.exe'; args.push('/c', 'start', '', url);
    } else if (platform === 'darwin') { cmd = 'open'; args.push(url); }
    else if (platform === 'win32') { cmd = 'cmd'; args.push('/c', 'start', '', url); }
    else { cmd = 'xdg-open'; args.push(url); }
    try {
        const p = spawn(cmd, args, { detached: true, stdio: 'ignore' });
        p.unref();
    } catch {
        // WSL interop may be disabled — try wslview, then just print the URL.
        if (wsl.wsl) {
            try {
                const p = spawn('wslview', [url], { detached: true, stdio: 'ignore' });
                p.unref();
            } catch {
                console.log(`[switchboard] Open this URL in your Windows browser: ${url}`);
            }
        } else {
            console.error(`[switchboard] Failed to open browser: ${url}`);
        }
    }
}
```

### Phase 3: Discovery hint — `src/standalone/cli.ts`

When `process.platform === 'win32'` and tmux is not available (which it never is on native Windows), print a one-line hint after the server starts:

```
[switchboard] tmux dispatch is unavailable on native Windows.
              Run Switchboard inside WSL to enable tmux pane dispatch — see docs/wsl-setup.md
```

This fires only on `win32`, only when the tmux setting is enabled but `isTmuxAvailable()` returns `false`. If the setting is off (the default), the hint is silent — there is nothing to hint at.

### Phase 4: Documentation — `docs/wsl-setup.md` (new)

A setup guide covering:

1. **Prerequisites**: WSL2 installed (`wsl --install`), Node.js inside WSL (`nvm` or system package), tmux inside WSL (`sudo apt install tmux`).
2. **Workspace setup**: either clone the repo inside WSL (`~/projects/switchboard`) or access the Windows filesystem via `/mnt/c/...` (note the 9p performance cost for heavy I/O).
3. **Starting Switchboard**: `npx switchboard` inside WSL. The URL it prints is reachable from a Windows browser via WSL2 localhost forwarding.
4. **Enabling tmux**: set `switchboard.terminal.tmux.enabled: true` in `.switchboard/config.json` or the Setup panel.
5. **Adopting panes**: start tmux, split panes, launch agent CLIs, adopt via `tmuxAdoptPane` verb or the board UI.
6. **VS Code integration**: the VS Code WSL extension runs the extension host inside WSL, so the extension host can also reach the tmux bridge — but this plan's scope is standalone.
7. **Troubleshooting**: `cmd.exe` not found (interop disabled in `/etc/wsl.conf` — use `wslview` or open the URL manually), port not forwarding (`wsl.exe --shutdown` and restart), node-pty build failures (install `build-essential`).

## Files Changed

- `src/utils/wslDetect.ts` — **new.** `detectWsl()`, cached.
- `src/standalone/cli.ts` — `openBrowser()` gains a WSL arm; startup hint on native Windows when tmux is enabled but unavailable.
- `docs/wsl-setup.md` — **new.** Setup guide.
- `src/test/wsl-detection-contract.test.js` — **new.** Contract tests.

## Verification Plan

1. **WSL2, browser opens** — `npx switchboard` inside WSL2 with interop enabled → Windows browser opens automatically to the board URL.
2. **WSL2, interop disabled** — `/etc/wsl.conf` with `[interop] enabled = false` → `cmd.exe` not found, falls back to `wslview` (if installed) or prints the URL. No crash.
3. **WSL2, board reachable** — Windows browser to `http://localhost:<port>` → board loads, health check passes, all guards satisfied (socket peer is `127.0.0.1`, Host is `localhost`).
4. **WSL2, tmux dispatch** — tmux running inside WSL with adopted panes → `POST /kanban/dispatch` succeeds, prompt lands in the pane. This is the end-to-end test of the whole feature chain.
5. **Native Windows, hint** — `npx switchboard` on Windows with `tmux.enabled: true` → hint about WSL prints after startup. With `tmux.enabled: false` (default) → no hint.
6. **Native Linux, no change** — `npx switchboard` on a non-WSL Linux machine → `detectWsl()` returns `false`, `xdg-open` called as today, no hint.
7. **macOS, no change** — `detectWsl()` returns `false`, `open` called as today.
8. **WSL1 detection** — `/proc/version` containing `Microsoft` but not `microsoft-standard` → `detectWsl()` returns `{ wsl: true, version: 1 }`, logged at startup.

### Automated Tests

Contract tests in `src/test/wsl-detection-contract.test.js`:

1. `detectWsl()` returns `{ wsl: false, version: null }` when `process.platform !== 'linux'` (mocked).
2. `detectWsl()` returns `{ wsl: true, version: 2 }` when `/proc/version` contains `microsoft-standard` (mocked `fs.readFileSync`).
3. `detectWsl()` returns `{ wsl: true, version: 1 }` when `/proc/version` contains `Microsoft` but not `microsoft-standard`.
4. `detectWsl()` returns `{ wsl: false, version: null }` when `/proc/version` read throws (mocked).
5. `detectWsl()` is cached — second call does not re-read `/proc/version` (mocked, assert call count).
6. `openBrowser()` calls `cmd.exe` when `detectWsl()` returns `{ wsl: true, version: 2 }` (mocked `spawn`, assert argv).

## Risks

- **WSL2 localhost forwarding is not guaranteed in all configs.** Some corporate network setups or custom WSL2 configurations break the automatic forwarding. The doc page names `wsl.exe --shutdown` as the first troubleshooting step, and the URL is always printed in the log regardless of whether the browser opens — so the user can reach the board manually.
- **`cmd.exe` interop can be disabled.** The fallback chain (cmd.exe → wslview → print URL) handles this, but a user with interop off and no `wslview` installed gets a printed URL instead of an opened browser. That is acceptable — it is the same behaviour as a headless server today.
- **WSL1 node-pty compatibility.** WSL1's translation layer may not match node-pty's Linux prebuilds. This is not a regression — WSL1 users today would have the same issue with any standalone PTY usage. The plan logs the WSL version so the failure is diagnosable, but does not block WSL1 from trying.
