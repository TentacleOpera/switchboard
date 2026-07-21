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

const EXCLUDED_DIR_NAMES = new Set(['.git', 'node_modules', 'dist', 'out', 'build', '.next', '.cache']);

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

/**
 * Attach a recursive watcher to `watchPath` rooted at `folder`. Tries
 * `fs.watch({ recursive: true })` first; on
 * `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` (or any construction error) falls back
 * to a per-subdirectory non-recursive tree-walk. Emits create/change/delete
 * events for `.md` files under `.switchboard/{plans,features}/`.
 */
function attachFolderWatcher(
    folder: string,
    watchPath: string,
    onEvent: (event: PlanIngestionWatchEvent, filePath: string) => void,
    log: (line: string) => void,
): CompositeWatchHandle {
    const composite = new CompositeWatchHandle();
    const subWatchers = new Map<string, fs.FSWatcher>();

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

    const attachRecursive = (): boolean => {
        try {
            const w = fs.watch(watchPath, { recursive: true }, (eventType, filename) => {
                if (!filename) {
                    // null filename under load → fall back to rescanning the watched root
                    void rescanRoot();
                    return;
                }
                const fullPath = path.resolve(path.join(watchPath, filename));
                handleEvent(eventType, fullPath);
            });
            subWatchers.set(watchPath, w);
            log(`[standalone-planIngestionHost] Native recursive watch active for: ${watchPath}`);
            return true;
        } catch (e: any) {
            if (e?.code === 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM') {
                log(`[standalone-planIngestionHost] Recursive fs.watch unsupported on this platform for ${watchPath}; falling back to per-subdir tree-walk.`);
                return false;
            }
            log(`[standalone-planIngestionHost] Recursive fs.watch failed for ${watchPath}: ${e}; falling back to per-subdir tree-walk.`);
            return false;
        }
    };

    const attachNonRecursive = (dir: string): void => {
        if (subWatchers.has(dir)) return;
        try {
            const w = fs.watch(dir, (eventType, filename) => {
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
        const plansDir = path.join(folder, '.switchboard', 'plans');
        const featuresDir = path.join(folder, '.switchboard', 'features');
        for (const d of [plansDir, featuresDir]) {
            if (fs.existsSync(d)) { await rescanDir(d); }
        }
    };

    if (!attachRecursive()) {
        // Fallback: per-subdirectory non-recursive tree-walk over .switchboard/plans + features.
        const plansDir = path.join(folder, '.switchboard', 'plans');
        const featuresDir = path.join(folder, '.switchboard', 'features');
        for (const d of [plansDir, featuresDir]) {
            if (fs.existsSync(d)) { walkAndAttach(d); }
        }
        // Also watch the .switchboard dir itself so new plans/features dirs get picked up.
        const switchboardDir = path.join(folder, '.switchboard');
        if (fs.existsSync(switchboardDir)) { attachNonRecursive(switchboardDir); }
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
            const switchboardDir = path.join(folder, '.switchboard');
            const watchPath = fs.existsSync(switchboardDir) ? switchboardDir : folder;
            return attachFolderWatcher(folder, watchPath, onEvent, log);
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
    // Watch the standalone config file so config edits mid-run fire 'config' (matches the
    // VS Code onDidChangeConfiguration bridge). Best-effort — failures are logged, not fatal.
    const configPath = path.join(workspaceRoot, '.switchboard', 'config.json');
    let configWatcher: fs.FSWatcher | undefined;
    try {
        if (fs.existsSync(configPath)) {
            configWatcher = fs.watch(configPath, { persistent: false }, () => {
                // Reload the provider's in-memory cache so subsequent reads see the new values.
                try { (config as any)._load?.(); } catch {}
                for (const h of envHandlers) { try { h('config'); } catch {} }
            });
        }
    } catch (e) {
        log(`[standalone-planIngestionHost] config.json watch failed: ${e}`);
    }

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
                    if (envHandlers.size === 0 && configWatcher) {
                        try { configWatcher.close(); } catch {}
                        configWatcher = undefined;
                    }
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
