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
import { attachDirectoryWatcher, type DirectoryWatcherHandle } from '../services/directoryWatcher';
import { getInotifyWatchCount } from '../services/inotifyWatchCount';
export { getInotifyWatchCount };

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
 * Attach watchers to `.switchboard/plans` and `.switchboard/features` rooted at `folder`.
 *
 * Uses the shared `attachDirectoryWatcher` — a manual per-directory non-recursive
 * tree-walk that arms one `fs.watch` per directory (excluding `node_modules`/`.git`/…)
 * instead of `fs.watch({ recursive: true })`. On Linux, Node's recursive emulation arms
 * one watch per file AND directory with no exclusion mechanism, which is how a single
 * board consumed 16,776 inotify watches (55% of a 4 GB Pi's budget). The manual walk is
 * a measured ~9.4× reduction and is the shape the fallback already implemented.
 *
 * Emits create/change/delete events for `.md` files under `.switchboard/{plans,features}/`.
 * A missing subtree is covered by a single non-recursive watch on `.switchboard` itself,
 * which arms the real watch when the directory appears.
 */
function attachFolderWatcher(
    folder: string,
    onEvent: (event: PlanIngestionWatchEvent, filePath: string) => void,
    log: (line: string) => void,
): CompositeWatchHandle {
    const composite = new CompositeWatchHandle();
    const subtreeHandles = new Map<string, DirectoryWatcherHandle>();

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

    /** Arm the manual per-directory walk for one of the two subtrees. */
    const armSubtree = (d: string): void => {
        if (subtreeHandles.has(d)) return;
        if (!fs.existsSync(d)) return;
        const handle = attachDirectoryWatcher(d, handleEvent, {
            log,
            logTag: 'standalone-planIngestionHost',
        });
        subtreeHandles.set(d, handle);
        composite.add(handle);
        log(`[standalone-planIngestionHost] Per-directory watch active for: ${d}`);
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
                const target = path.join(switchboardDir, name);
                armSubtree(target);
                // Surface pre-existing files in the freshly-appeared subtree so the
                // engine ingests them without waiting for the periodic scan.
                subtreeHandles.get(target)?.rescan();
            });
            composite.add({ dispose: () => { try { w.close(); } catch {} } });
            w.on('error', () => { /* transient */ });
        } catch { /* .switchboard unwatchable — the engine's periodic scan is the backstop */ }
    }

    const inotifyCount = getInotifyWatchCount();
    if (inotifyCount !== undefined) {
        log(`[standalone-planIngestionHost] Armed inotify watch count: ${inotifyCount}`);
    }

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
