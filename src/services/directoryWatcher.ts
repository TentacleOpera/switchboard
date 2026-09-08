/**
 * Manual per-directory `fs.watch` tree walker — the shared replacement for
 * `fs.watch({ recursive: true })` on Linux.
 *
 * ## Why this exists
 *
 * `fs.watch({ recursive: true })` on Linux is NOT a libuv feature: libuv's
 * inotify backend ignores the `recursive` flag. Node 22 emulates it in
 * JavaScript (`lib/internal/fs/recursive_watch.js`): it walks the tree
 * synchronously and calls ordinary non-recursive `fs.watch()` once per
 * filesystem entry — every file AND every directory. One recursive call
 * over a workspace root arms thousands of `FSWatcher` objects, each holding
 * its own `inotify_add_watch()` registration, with no exclusion mechanism for
 * `node_modules`/`.git`.
 *
 * On a 4 GB Pi (`max_user_watches` = 30,517) a single board consumed 16,776
 * watches this way — 55% of the machine's budget — measured 2026-09-08.
 *
 * This walker arms one non-recursive `fs.watch` per **directory** only
 * (an inotify watch on a directory already reports create/change/delete of
 * its direct children), applies `EXCLUDED_DIR_NAMES` before arming, and
 * re-scans on a `rename` event to arm newly-created subdirectories. Measured
 * reduction: ~9.4× fewer kernel watches than the recursive emulation.
 *
 * ## Contract
 *
 * `onEvent(eventType, fullPath)` receives the raw `fs.watch` event type
 * (`'rename'` or `'change'`) and the **absolute** path of the affected entry.
 * Callers are responsible for translating to create/change/delete semantics
 * (typically via an existence check) and for any glob/path filtering — this
 * walker reports every event under the watched tree.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getInotifyWatchCount, getInotifyCeiling } from './inotifyWatchCount';

/**
 * Directory names never watched. Mirrors `planIngestionHost.ts`'s original
 * list. Applied during the walk, before arming — the only point at which
 * exclusion saves watches.
 */
export const EXCLUDED_DIR_NAMES = new Set([
    '.git', 'node_modules', 'dist', 'out', 'build', '.next', '.cache', 'logs', 'dbbackup', 'mission-control',
]);

export interface DirectoryWatcherHandle {
    dispose(): void;
    /**
     * Re-walk the watched tree: arm any new subdirectories (with exclusions) and
     * fire `onEvent('change', fullPath)` for every file encountered. Used by
     * callers that need to surface pre-existing files when a subtree appears
     * late (e.g. `.switchboard/plans` created after the watcher armed).
     */
    rescan(): void;
}

export interface AttachDirectoryWatcherOptions {
    /** Optional console-style logger for arm/failure diagnostics. */
    log?: (line: string) => void;
    /**
     * Tag used in ceiling-violation log lines so the offending call site is
     * identifiable (e.g. `'planIngestionHost'`, `'vscodeShim'`).
     */
    logTag?: string;
    /**
     * When true, skip the per-arm inotify ceiling check. Default false — the
     * ceiling is the only process-wide guard against generational growth.
     */
    skipCeilingCheck?: boolean;
}

/**
 * Walk `rootDir` and arm one non-recursive `fs.watch` per directory (excluding
 * `EXCLUDED_DIR_NAMES`). On a `rename` event in a watched directory, re-scan
 * it and arm any new subdirectories. Returns a handle that closes every armed
 * watcher synchronously.
 *
 * If `rootDir` does not exist, returns an already-disposed handle (no watches
 * armed); the caller is expected to arm a parent watch that notices the
 * directory appearing later (see `planIngestionHost.attachFolderWatcher`).
 */
export function attachDirectoryWatcher(
    rootDir: string,
    onEvent: (eventType: string, fullPath: string) => void,
    opts: AttachDirectoryWatcherOptions = {},
): DirectoryWatcherHandle {
    const log = opts.log;
    const tag = opts.logTag ? `[${opts.logTag}] ` : '';
    const subWatchers = new Map<string, fs.FSWatcher>();
    let disposed = false;

    // Process-wide inotify count sampled once at arm time. Reading /proc/<pid>/fdinfo
    // per directory would be prohibitive on a large tree (thousands of readdir+readlink
    // syscalls per arm), so the count is sampled once and a local arm counter tracks
    // how many watches THIS walker has added since. `startCount + armedHere` is an
    // accurate process-wide estimate for a synchronous arm (the common case); a
    // concurrent arm from another site can only add to it, so the check is conservative.
    const startCount = getInotifyWatchCount() ?? 0;
    let armedHere = 0;
    const ceiling = getInotifyCeiling();

    const ceilingHit = (dir: string): boolean => {
        if (opts.skipCeilingCheck) return false;
        if (startCount === 0 && process.platform !== 'linux') return false; // off-Linux — no ceiling enforced
        if (startCount + armedHere < ceiling) return false;
        log?.(`${tag}inotify watch ceiling (${startCount + armedHere}/${ceiling}) reached — NOT arming ${dir}`);
        return true;
    };

    const attachNonRecursive = (dir: string): void => {
        if (disposed) return;
        if (subWatchers.has(dir)) return;
        if (ceilingHit(dir)) return;
        try {
            const w = fs.watch(dir, { persistent: false }, (eventType, filename) => {
                if (disposed) return;
                if (!filename) { void rescanDir(dir); return; }
                const fullPath = path.join(dir, filename.toString());
                try {
                    const stat = fs.statSync(fullPath);
                    if (stat.isDirectory()) {
                        if (!EXCLUDED_DIR_NAMES.has(filename.toString())) {
                            attachNonRecursive(fullPath);
                            void rescanDir(fullPath);
                        }
                        return;
                    }
                } catch { /* file may be transient */ }
                onEvent(eventType, fullPath);
            });
            w.on('error', () => { /* transient — the engine's periodic scan is the backstop */ });
            subWatchers.set(dir, w);
            armedHere++;
        } catch (e) {
            log?.(`${tag}fs.watch failed for ${dir}: ${e}`);
        }
    };

    const rescanDir = async (dir: string): Promise<void> => {
        if (disposed) return;
        try {
            const entries = await fs.promises.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                const entryPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (!EXCLUDED_DIR_NAMES.has(entry.name)) {
                        if (!subWatchers.has(entryPath)) attachNonRecursive(entryPath);
                    }
                    continue;
                }
                if (entry.isFile()) {
                    // 'rename' lets consumers distinguish create (!seen) from change (seen);
                    // a rescan cannot know whether the file is new, so it reports the
                    // ambiguous event and lets the consumer's seen-set decide.
                    onEvent('rename', entryPath);
                }
            }
        } catch { /* dir may be transient */ }
    };

    /** Synchronous recursive re-walk: arm new subdirs and emit change for every file. */
    const rescanSync = (dir: string): void => {
        if (disposed) return;
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const entryPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
                    if (!subWatchers.has(entryPath)) attachNonRecursive(entryPath);
                    rescanSync(entryPath);
                    continue;
                }
                if (entry.isFile()) {
                    onEvent('rename', entryPath);
                }
            }
        } catch { /* dir may be transient */ }
    };

    const walkAndAttach = (dir: string): void => {
        attachNonRecursive(dir);
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
                walkAndAttach(path.join(dir, entry.name));
            }
        } catch (e) {
            log?.(`${tag}walkAndAttach readdir failed for ${dir}: ${e}`);
        }
    };

    if (fs.existsSync(rootDir)) {
        walkAndAttach(rootDir);
    }

    return {
        dispose: () => {
            disposed = true;
            for (const w of subWatchers.values()) { try { w.close(); } catch {} }
            subWatchers.clear();
        },
        rescan: () => {
            if (disposed) return;
            if (fs.existsSync(rootDir)) rescanSync(rootDir);
        },
    };
}
