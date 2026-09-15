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
    // Antigravity agent step output (~/.gemini/antigravity-*/brain/<session>/.system_generated/**).
    // Measured on the Pi board 2026-09-15: of 1,766 inotify watches held by the host,
    // 1,763 were in the brain tree and 1,553 of those sat at depth 3-4 under
    // .system_generated/steps — one watch per agent step, growing for the life of the
    // install. The tree holds .txt/.jsonl/.json/.log and not one .md, so nothing the
    // plan scanner ingests lives under here. Only the intended two levels remain: the
    // brain root and its 55 session directories.
    // Ingestion is unaffected — _collectAntigravityPlanCandidates walks the full tree
    // on every Plan Scanner sweep (TaskViewerProvider.ts:17104), so a plan.md appearing
    // under this directory would still be imported, just on the sweep rather than
    // instantly.
    '.system_generated',
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

    let ceilingLogged = false;
    const ceilingHit = (dir: string): boolean => {
        if (opts.skipCeilingCheck) return false;
        if (startCount === 0 && process.platform !== 'linux') return false; // off-Linux — no ceiling enforced
        if (startCount + armedHere < ceiling) return false;
        // Log ONCE per walker. A large tree at the ceiling would otherwise emit one
        // warn per skipped directory — thousands of identical lines, which on the Pi
        // is its own failure mode. The first line names the offending call site and
        // the first directory that was refused; that is what the operator needs.
        if (!ceilingLogged) {
            ceilingLogged = true;
            log?.(`${tag}inotify watch ceiling (${startCount + armedHere}/${ceiling}) reached — NOT arming ${dir} (and any further directories under ${rootDir})`);
        }
        return true;
    };

    /** Close and forget the watcher for a directory that has gone away. */
    const reapWatcher = (dir: string): void => {
        const w = subWatchers.get(dir);
        if (!w) return;
        try { w.close(); } catch {}
        subWatchers.delete(dir);
        if (armedHere > 0) armedHere--;
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
                        // Fall through: `fs.watch({recursive:true})` reported directory
                        // creates too, and `**/*` consumers (hostSeams.watchFolder) key
                        // a refresh off them. Consumers that only want files filter on
                        // the extension, so forwarding is parity, not noise.
                    }
                } catch {
                    // The entry is gone. If it was a directory WE were watching, the
                    // kernel has already dropped the inotify registration but Node's
                    // FSWatcher (and its fd) stays open until closed — the exact
                    // unclosed-handle accumulation this walker exists to prevent.
                    reapWatcher(fullPath);
                }
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
                        // Recurse. A whole subtree moved in atomically (a `mv`, a
                        // worktree checkout) produces ONE rename event on the parent;
                        // stopping at depth 1 would leave every grandchild directory
                        // unwatched forever and its files never reported.
                        await rescanDir(entryPath);
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
