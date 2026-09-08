/**
 * WSL detection — is this Linux process actually running inside the Windows
 * Subsystem for Linux?
 *
 * The tmux bridge (Parts 1 and 2) lets standalone Switchboard dispatch prompts
 * into tmux panes it does not own. tmux does not exist on native Windows, and a
 * Windows-host Node process cannot reach a tmux server inside WSL across the
 * socket boundary. But if Switchboard itself runs inside WSL, the boundary
 * disappears — it is Linux talking to Linux, and the bridge works as designed
 * with no special-casing.
 *
 * The one remaining friction point is browser opening: inside WSL,
 * `process.platform` is `'linux'`, so `openBrowser()` would call `xdg-open`,
 * which does not exist in a minimal WSL install. Detecting WSL lets it call
 * `cmd.exe /c start` (or `wslview`) instead, so the Windows browser opens.
 *
 * Detection reads `/proc/version` once and caches the result for the process
 * lifetime. The kernel version string contains `Microsoft` on both WSL1 and
 * WSL2; WSL2's string additionally contains `microsoft-standard`. WSL1 uses a
 * translation layer (not a real Linux kernel), so node-pty prebuilds may not
 * match — both versions are allowed to try, but the version is logged so a
 * failure is diagnosable rather than silent.
 */
import * as fs from 'fs';

/** WSL detection result. `version` is null when not WSL. */
export interface WslDetection {
    /** True when running inside WSL (either version). */
    wsl: boolean;
    /** 1 for WSL1, 2 for WSL2, null when not WSL. */
    version: 1 | 2 | null;
}

let _cached: WslDetection | null = null;

/**
 * Detect WSL by reading `/proc/version`. Cached for the process lifetime — the
 * kernel does not change underneath a running process.
 *
 * Returns `{ wsl: false, version: null }` on every non-Linux platform and on
 * any read failure (no `/proc/version`, permission denied, etc.). A failure to
 * detect is never a crash: the caller falls back to the existing `xdg-open`
 * path, which is the status quo on real Linux.
 */
export function detectWsl(): WslDetection {
    if (_cached) { return _cached; }
    if (process.platform !== 'linux') {
        _cached = { wsl: false, version: null };
        return _cached;
    }
    try {
        const version = fs.readFileSync('/proc/version', 'utf8');
        // WSL1 and WSL2 both include "Microsoft" in the kernel version string.
        // WSL2's string additionally contains "microsoft-standard".
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

/**
 * Reset the cache. Exposed for tests that need to exercise the detection logic
 * against mocked inputs in a single process. Not for production use.
 */
export function _resetWslCacheForTests(): void {
    _cached = null;
}
