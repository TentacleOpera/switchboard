/**
 * Standalone `PlanIngestionHost` — native `fs.watch` implementation of the
 * host seam (Headless Ingestion piece 2). Consumed by `bootstrap.ts` to drive
 * the shared `PlanIngestionEngine` headless, so `npx switchboard` ingests plans
 * identically to the VS Code extension.
 *
 * Platform behaviour (confirmed via research — see the headless-standalone-
 * ingestion plan):
 *   - Recursive `fs.watch` is available on macOS (FSEvents), Windows
 *     (ReadDirectoryChangesW), and Linux ≥ Node 19.1.0 (libuv nested-inotify).
 *   - On BSD/FreeBSD/Solaris/SmartOS (and Node <19.1.0 on Linux), passing
 *     `{ recursive: true }` throws `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`. This
 *     adapter `try/catches` the recursive construction and falls back to a
 *     per-subdirectory non-recursive tree-walk.
 *   - Correctness never depends on catching every raw FS event: the engine's
 *     debounce + periodic reconcile + idempotent upsert is the backstop, exactly
 *     as in the VS Code host.
 *
 * Directory-exclusion rules (`.git`, `node_modules`, build artifacts) keep
 * recursive watching from hitting inotify watch-exhaustion on large trees.
 */

import * as fs from 'fs';
import * as path from 'path';
import type {
    PlanIngestionHost,
    PlanIngestionHostConfig,
    PlanIngestionWatcher,
    PlanIngestionWatchHandle,
    PlanIngestionWatchEvent,
    PlanIngestionEnvironmentChange,
} from '../services/PlanIngestionEngine';
import type { StandaloneHostPathConfigProvider } from './hostServices';

const EXCLUDED_DIR_NAMES = new Set(['.git', 'node_modules', 'dist', 'out', 'build', '.next', '.cache', 'logs', 'dbbackup', 'mission-control']);

function isPlanOrFeatureFile(folder: string, fullPath: string): boolean {
    const plansDir = path.resolve(path.join(folder, '.switchboard', 'plans'));
    const featuresDir = path.resolve(path.join(folder, '.switchboard', 'features'));
    return fullPath.startsWith(plansDir) || fullPath.startsWith(featuresDir);
}

function shouldEmitForFolder(folder: string, fullPath: string): boolean {
    if (!fullPath.endsWith('.md')) return false;
    return isPlanOrFeatureFile(folder, fullPath);
}

class CompositeWatchHandle implements PlanIngestionWatchHandle {
    private _handles: Array<{ dispose(): void }> = [];
    private _disposed = false;
    add(h: { dispose(): void }): void { this._handles.push(h); }
    dispose(): void {
        if (this._disposed) return;
        this._disposed = true;
        for (const h of this._handles) { try { h.dispose(); } catch {} }
        this._handles = [];
    }
}

export function getInotifyWatchCount(targetPid = process.pid): number | undefined {
    try {
        if (process.platform !== 'linux') return undefined;
        const fdDir = `/proc/${targetPid}/fd`;
        if (!fs.existsSync(fdDir)) return undefined;
        let count = 0;
        for (const fd of fs.readdirSync(fdDir)) {
            try {
                if (fs.readlinkSync(path.join(fdDir, fd)) === 'anon_inode:inotify') {
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

export function getOpenFdCount(targetPid = process.pid): number | undefined {
    try {
        if (process.platform !== 'linux') return undefined;
        const fdDir = `/proc/${targetPid}/fd`;
        if (!fs.existsSync(fdDir)) return undefined;
        return fs.readdirSync(fdDir).length;
    } catch {
        return undefined;
    }
}

/**
 * Attach recursive watchers to `.switchboard/plans` and `.switchboard/features` rooted at `folder`.
 * Tries `fs.watch({ recursive: true })` first; on `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`
 * (or any construction error) falls back to a per-subdirectory non-recursive tree-walk.
 * Emits create/change/delete events for `.md` files under `.switchboard/{plans,features}/`.
 */
function attachFolderWatcher(
    folder: string,
    onEvent: (event: PlanIngestionWatchEvent, filePath: string) => void,
    log: (line: string) => void,
): CompositeWatchHandle {
    const composite = new CompositeWatchHandle();
    const subWatchers = new Map<string, fs.FSWatcher>();

    const switchboardDir = path.join(folder, '.switchboard');
    const plansDir = path.join(folder, '.switchboard', 'plans');
    const featuresDir = path.join(folder, '.switchboard', 'features');
    // NOTE: these directories are watched if they exist and NOT created if they
    // do not. `watchFolder` is called for every root the engine tracks, which
    // includes plan-scanner source folders (`~/.cursor/plans`, ...) and, in the
    // extension, mapped PARENT folders that are not Switchboard workspaces at
    // all. Creating `.switchboard/plans` in each of those is scaffold litter in
    // directories that never wanted it. A missing subtree is instead covered by
    // a single non-recursive watch on `.switchboard` itself (see below), which
    // arms the real watch when the directory appears.

    const handleEvent = (eventType: string, fullPath: string) => {
        if (!shouldEmitForFolder(folder, fullPath)) return;
        // atomic-save guard: a 'rename' for a path that still exists is a change/create,
        // not a delete (matches the VS Code adapter's native-watcher logic).
        if (eventType === 'rename' || !fs.existsSync(fullPath)) {
            if (!fs.existsSync(fullPath)) {
                onEvent('delete', fullPath);
                return;
            }
        }
        onEvent('change', fullPath);
    };

    const attachRecursive = (targetDir: string): boolean => {
        if (!fs.existsSync(targetDir)) return false;
        try {
            const w = fs.watch(targetDir, { recursive: true, persistent: false }, (eventType, filename) => {
                if (!filename) {
                    // null filename under load → fall back to rescanning the watched root
                    void rescanRoot();
                    return;
                }
                const fullPath = path.resolve(path.join(targetDir, filename));
                handleEvent(eventType, fullPath);
            });
            subWatchers.set(targetDir, w);
            log(`[standalone-planIngestionHost] Native recursive watch active for: ${targetDir}`);
            return true;
        } catch (e: any) {
            if (e?.code === 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM') {
                log(`[standalone-planIngestionHost] Recursive fs.watch unsupported on this platform for ${targetDir}; falling back to per-subdir tree-walk.`);
                return false;
            }
            log(`[standalone-planIngestionHost] Recursive fs.watch failed for ${targetDir}: ${e}; falling back to per-subdir tree-walk.`);
            return false;
        }
    };

    const attachNonRecursive = (dir: string): void => {
        if (subWatchers.has(dir)) return;
        try {
            const w = fs.watch(dir, { persistent: false }, (eventType, filename) => {
                if (!filename) { void rescanDir(dir); return; }
                const fullPath = path.join(dir, filename);
                try {
                    const stat = fs.statSync(fullPath);
                    if (stat.isDirectory()) {
                        if (!EXCLUDED_DIR_NAMES.has(filename)) {
                            attachNonRecursive(fullPath);
                            void rescanDir(fullPath);
                        }
                        return;
                    }
                } catch { /* file may be transient */ }
                handleEvent(eventType, fullPath);
            });
            subWatchers.set(dir, w);
        } catch (e) {
            log(`[standalone-planIngestionHost] Non-recursive fs.watch failed for ${dir}: ${e}`);
        }
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
            log(`[standalone-planIngestionHost] walkAndAttach readdir failed for ${dir}: ${e}`);
        }
    };

    const rescanDir = async (dir: string): Promise<void> => {
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
                if (entry.isFile() && shouldEmitForFolder(folder, entryPath)) {
                    onEvent('change', entryPath);
                }
            }
        } catch { /* dir may be transient */ }
    };

    const rescanRoot = async (): Promise<void> => {
        for (const d of [plansDir, featuresDir]) {
            if (fs.existsSync(d)) { await rescanDir(d); }
        }
    };

    /** Arm the watch for one of the two subtrees, recursive first, tree-walk on fallback. */
    const armSubtree = (d: string): void => {
        if (subWatchers.has(d)) return;
        if (!fs.existsSync(d)) return;
        if (!attachRecursive(d)) {
            // Fallback: per-subdirectory non-recursive tree-walk (this is the path
            // EXCLUDED_DIR_NAMES guards, which is why `logs`, `dbbackup` and
            // `mission-control` were added to it).
            walkAndAttach(d);
        }
    };

    for (const d of [plansDir, featuresDir]) { armSubtree(d); }

    // A missing `plans/` or `features/` is not created here (see the note above).
    // One non-recursive watch on `.switchboard` — a single descriptor — notices
    // the directory being created later and arms the real watch then.
    if (fs.existsSync(switchboardDir) && (!fs.existsSync(plansDir) || !fs.existsSync(featuresDir))) {
        try {
            const w = fs.watch(switchboardDir, { persistent: false }, (_eventType, filename) => {
                if (!filename) return;
                const name = filename.toString();
                if (name !== 'plans' && name !== 'features') return;
                armSubtree(path.join(switchboardDir, name));
                void rescanRoot();
            });
            subWatchers.set(switchboardDir, w);
            w.on('error', () => { /* transient */ });
        } catch { /* .switchboard unwatchable — the engine's periodic scan is the backstop */ }
    }

    const inotifyCount = getInotifyWatchCount();
    if (inotifyCount !== undefined) {
        log(`[standalone-planIngestionHost] Armed inotify watch count: ${inotifyCount}`);
    }

    composite.add({
        dispose: () => {
            for (const w of subWatchers.values()) { try { w.close(); } catch {} }
            subWatchers.clear();
        },
    });
    return composite;
}

export interface StandalonePlanIngestionHostOptions {
    workspaceRoot: string;
    config: StandaloneHostPathConfigProvider;
    /** Extra roots to watch (e.g. configured planScanner custom source dirs). */
    extraRoots?: string[];
    /** Optional console-style logger; defaults to console.log. */
    log?: (line: string) => void;
}

export function createStandalonePlanIngestionHost(opts: StandalonePlanIngestionHostOptions): PlanIngestionHost {
    const log = opts.log ?? ((line: string) => console.log(line));
    const config = opts.config;
    const workspaceRoot = path.resolve(opts.workspaceRoot);
    const extraRoots = (opts.extraRoots ?? []).filter(r => fs.existsSync(r));

    const watcher: PlanIngestionWatcher = {
        watchFolder(folder, onEvent) {
            return attachFolderWatcher(folder, onEvent, log);
        },
        watchFile(filePath, onEvent) {
            // fs.watchFile polls cross-platform — the right tool for .git/HEAD on WSL/network mounts too.
            const handle = fs.watchFile(filePath, { interval: 2000 }, (curr, prev) => {
                if (curr.mtimeMs !== prev.mtimeMs || curr.nlink !== prev.nlink) {
                    const event: PlanIngestionWatchEvent = curr.nlink === 0 ? 'delete' : 'change';
                    onEvent(event, filePath);
                }
            });
            return {
                dispose: () => { try { fs.unwatchFile(filePath); } catch {} void handle; },
            };
        },
    };

    const makeConfig = (section: 'planWatcher' | 'activityLight'): PlanIngestionHostConfig => ({
        getBoolean: (key, defaultValue) => config.getConfigBoolean(`${section}.${key}`, defaultValue),
        getNumber: (key, defaultValue) => config.getConfigNumber(`${section}.${key}`, defaultValue),
    });

    const envHandlers = new Set<(kind: PlanIngestionEnvironmentChange) => void>();
    // config.json has been migrated to the kanban.db config table. The standalone
    // provider reads directly from the db on each access (no in-memory cache to
    // reload), so a file watcher is no longer needed — config edits are visible
    // immediately. The VS Code host fires onDidChangeConfiguration through the
    // provider's listener mechanism instead.

    const host: PlanIngestionHost = {
        watcher,
        getConfig: makeConfig,
        logger: { appendLine: (line: string) => log(line) },
        async listWatchedRoots() {
            const roots = [workspaceRoot];
            for (const r of extraRoots) {
                const resolved = path.resolve(r);
                if (!roots.includes(resolved)) { roots.push(resolved); }
            }
            return roots;
        },
        onEnvironmentChanged(handler) {
            envHandlers.add(handler);
            return {
                dispose: () => {
                    envHandlers.delete(handler);
                },
            };
        },
    };
    return host;
}

/**
 * Read the configured planScanner custom-source directories from the standalone
 * config (mirrors the extension's `switchboard.planScanner.customSources`).
 * Returns absolute, existing directory paths. Used by the bootstrap to feed the
 * standalone host's `extraRoots` so the engine's periodic scan + watcher covers
 * external scanner folders too.
 */
export function readPlanScannerCustomSourceDirs(config: StandaloneHostPathConfigProvider, workspaceRoot: string): string[] {
    const raw = config.getConfigJson<any[]>('planScanner.customSources', []);
    if (!Array.isArray(raw)) return [];
    const dirs: string[] = [];
    for (const src of raw) {
        if (!src || typeof src !== 'object') continue;
        const globs = Array.isArray(src.globs) ? src.globs : [];
        for (const g of globs) {
            if (typeof g !== 'string') continue;
            const candidate = path.isAbsolute(g) ? g : path.resolve(workspaceRoot, g);
            try {
                if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
                    if (!dirs.includes(candidate)) { dirs.push(candidate); }
                }
            } catch { /* skip unreadable */ }
        }
    }
    return dirs;
}
