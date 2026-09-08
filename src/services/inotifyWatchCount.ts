/**
 * Process-wide inotify watch accounting.
 *
 * Extracted from `planIngestionHost.ts` so both the standalone host and the
 * VS Code extension host can share one implementation. Has no vscode/standalone
 * dependencies — only `fs` and `process` — so it is safe to import from either
 * surface.
 *
 * Why this exists: a single board on a 4 GB Pi holds 16,776 inotify watches
 * against a kernel budget of 30,517 (`max_user_watches`). The per-watcher
 * `maxWatches` cap in `vscodeShim` bounds a single watcher instance and cannot
 * see cross-generation accumulation, so 16,776 watches accrued without ever
 * tripping it. A process-wide ceiling checked at arm time is the only guard
 * that catches generational growth.
 */

import * as fs from 'fs';

/**
 * Count the inotify watches held by `targetPid` by scanning `/proc/<pid>/fdinfo`.
 * Returns `undefined` off-Linux or when `/proc` is unavailable.
 */
export function getInotifyWatchCount(targetPid: number = process.pid): number | undefined {
    try {
        if (process.platform !== 'linux') return undefined;
        const fdDir = `/proc/${targetPid}/fd`;
        if (!fs.existsSync(fdDir)) return undefined;
        let count = 0;
        for (const fd of fs.readdirSync(fdDir)) {
            try {
                if (fs.readlinkSync(`/proc/${targetPid}/fd/${fd}`) === 'anon_inode:inotify') {
                    const fdinfo = fs.readFileSync(`/proc/${targetPid}/fdinfo/${fd}`, 'utf8');
                    count += fdinfo.split('\n').filter(l => l.startsWith('inotify ')).length;
                }
            } catch {}
        }
        return count;
    } catch {
        return undefined;
    }
}

let cachedCeiling: number | undefined;

/**
 * The process-wide watch ceiling. Defaults to 10% of `max_user_watches` on
 * Linux (≈3,000 on a 4 GB Pi where the budget is 30,517), or 6,553 off-Linux.
 * Override via `SWITCHBOARD_INOTIFY_WATCH_CEILING` env var. Result is cached.
 */
export function getInotifyCeiling(): number {
    if (cachedCeiling !== undefined) return cachedCeiling;
    const envOverride = process.env.SWITCHBOARD_INOTIFY_WATCH_CEILING;
    if (envOverride) {
        const parsed = parseInt(envOverride, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
            cachedCeiling = parsed;
            return cachedCeiling;
        }
    }
    let budget = 65536;
    try {
        if (process.platform === 'linux') {
            const raw = fs.readFileSync('/proc/sys/fs/inotify/max_user_watches', 'utf8');
            const parsed = parseInt(raw.trim(), 10);
            if (Number.isFinite(parsed) && parsed > 0) budget = parsed;
        }
    } catch { /* off-Linux or unreadable — keep the fallback */ }
    cachedCeiling = Math.max(64, Math.floor(budget * 0.1));
    return cachedCeiling;
}

/**
 * Returns true when the process is at or over the inotify watch ceiling.
 * Off-Linux (where `getInotifyWatchCount` is `undefined`) this is always
 * false — no ceiling is enforced, matching the pre-fix behaviour.
 */
export function isInotifyCeilingExceeded(): boolean {
    const count = getInotifyWatchCount();
    if (count === undefined) return false;
    return count >= getInotifyCeiling();
}
