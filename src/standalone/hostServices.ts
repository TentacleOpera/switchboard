import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type {
    HostSeams, HostPathConfigProvider, HostSecrets, HostWatchEvent, HostWatchHandle
} from '../services/hostSeams';
import { switchboardCommandRegistry } from '../services/commandRegistry';
import { readConfigValueSync, writeConfigValueSync } from '../services/configJsonBridge';

/**
 * Standalone implementations of the host seams A2a defined.
 *
 * These are used by `npx switchboard` (no VS Code) and do not depend on the
 * vscode module.  The extension path is unchanged because it never imports
 * this file.
 */

// ─── File watcher ──────────────────────────────────────────────────────────

/**
 * fs.watch-backed folder watcher for the headless seams.
 *
 * This was a no-op stub, which silently disabled every seam-driven folder watcher in
 * `npx switchboard` — including the Tickets panel's display watcher, so external edits to
 * local ticket `.md` files never reached the browser sidebar even though the identical
 * provider code works in the editor host.
 *
 * fs.watch reports 'rename' | 'change'; the seam contract is 'create' | 'change' |
 * 'delete', so existence at delivery time decides which one this was. Recursive watching
 * is unavailable on some platforms — fall back to a flat watch, which covers the flat
 * ticket folders this seam is used for.
 */
export function createStandaloneFolderWatcher(
    folderPath: string,
    listener: (event: HostWatchEvent, filePath: string) => void
): HostWatchHandle {
    const emit = (eventType: string, filename: string | Buffer | null) => {
        if (!filename) { return; }
        const fullPath = path.resolve(folderPath, filename.toString());
        if (!fs.existsSync(fullPath)) { listener('delete', fullPath); return; }
        listener(eventType === 'rename' ? 'create' : 'change', fullPath);
    };

    let watcher: fs.FSWatcher;
    try {
        watcher = fs.watch(folderPath, { persistent: false, recursive: true }, emit);
    } catch {
        console.warn(`[headless watcher] flat watch for ${folderPath}: recursive fs.watch failed (likely inotify exhaustion or an older Node runtime); asset changes under attachments/ will not refresh`);
        try {
            watcher = fs.watch(folderPath, { persistent: false }, emit);
        } catch (e) {
            console.warn(`[headless watcher] cannot watch ${folderPath}:`, e);
            return { dispose: () => {} };
        }
    }
    watcher.on('error', err => console.warn(`[headless watcher] ${folderPath}:`, err));
    return { dispose: () => { try { watcher.close(); } catch {} } };
}

// ─── Config provider ───────────────────────────────────────────────────────

function envKeyForSetting(settingKey: string): string {
    return 'SWITCHBOARD_' + settingKey.replace(/\./g, '_').toUpperCase();
}

export class StandaloneHostPathConfigProvider implements HostPathConfigProvider {
    readonly workspaceRoot: string;
    private _listeners: Set<(key: string, value: any, originatorId?: string) => void> = new Set();

    constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;
    }

    onConfigChanged(listener: (key: string, value: any, originatorId?: string) => void): { dispose: () => void } {
        this._listeners.add(listener);
        return { dispose: () => this._listeners.delete(listener) };
    }

    private _notifyListeners(key: string, value: any, originatorId?: string): void {
        for (const listener of this._listeners) {
            try { listener(key, value, originatorId); } catch {}
        }
    }

    private _rawValue(key: string): any {
        // 1. Environment override (e.g. SWITCHBOARD_KANBAN_DBPATH)
        const envValue = process.env[envKeyForSetting(key)];
        if (envValue !== undefined) { return envValue; }

        // 2. config.json has been migrated to the kanban.db config table.
        //    Sync read returns undefined if the db is not yet open.
        return readConfigValueSync(this.workspaceRoot, key);
    }

    getConfigString(key: string): string {
        const v = this._rawValue(key);
        return v === undefined || v === null ? '' : String(v);
    }

    getConfigStringWithDefault(key: string, defaultValue: string): string {
        const v = this.getConfigString(key);
        return v === '' ? defaultValue : v;
    }

    getConfigBoolean(key: string, defaultValue: boolean): boolean {
        const v = this._rawValue(key);
        if (v === undefined || v === null) { return defaultValue; }
        if (typeof v === 'boolean') { return v; }
        return String(v).toLowerCase() === 'true';
    }

    getConfigNumber(key: string, defaultValue: number): number {
        const v = this._rawValue(key);
        if (v === undefined || v === null) { return defaultValue; }
        if (typeof v === 'number') { return v; }
        const parsed = Number(v);
        return isNaN(parsed) ? defaultValue : parsed;
    }

    getConfigJson<T>(key: string, defaultValue: T): T {
        const v = this._rawValue(key);
        if (v === undefined || v === null) { return defaultValue; }
        if (typeof v === 'object') { return v as T; }
        try { return JSON.parse(String(v)) as T; } catch { return defaultValue; }
    }

    async updateConfigGlobal(key: string, value: any, originatorId?: string): Promise<void> {
        writeConfigValueSync(this.workspaceRoot, key, value);
        this._notifyListeners(key, value, originatorId);
    }

    async updateConfigWorkspace(key: string, value: any, originatorId?: string): Promise<void> {
        // Standalone has no global/user split; treat workspace scope as the db config table.
        writeConfigValueSync(this.workspaceRoot, key, value);
        this._notifyListeners(key, value, originatorId);
    }
}

// ─── Secrets ───────────────────────────────────────────────────────────────

export { StandaloneHostSecrets, HostSecrets } from '../services/encryptedSecretsStore';
import { StandaloneHostSecrets as SharedStandaloneHostSecrets } from '../services/encryptedSecretsStore';
import { stateFile } from '../utils/stateHome';

const _warnedMissingCommands = new Set<string>();

export function createStandaloneHostSecrets(workspaceRoot?: string): SharedStandaloneHostSecrets {
    const storePath = stateFile('secrets.enc');
    const keyPath = stateFile('.master-key');

    if (workspaceRoot) {
        migrateLegacyWorkspaceSecrets(workspaceRoot, storePath, keyPath);
    }

    return new SharedStandaloneHostSecrets(storePath, keyPath);
}

function migrateLegacyWorkspaceSecrets(workspaceRoot: string, globalStorePath: string, globalKeyPath: string): void {
    try {
        const legacyDir = path.join(workspaceRoot, '.switchboard');
        const legacyStorePath = path.join(legacyDir, 'secrets.enc');
        const legacyKeyPath = path.join(legacyDir, '.master-key');

        if (!fs.existsSync(legacyStorePath)) {
            return;
        }

        if (!fs.existsSync(legacyKeyPath)) {
            console.warn('[StandaloneHostSecrets] Legacy workspace secrets.enc exists but .master-key is missing; skipping migration.');
            return;
        }

        const legacySecrets = new SharedStandaloneHostSecrets(legacyStorePath, legacyKeyPath);

        // The store renames itself away when it cannot be decrypted. If that just
        // happened there is nothing to import and nothing to prove — leave the key
        // file where it is instead of orphaning it beside a .corrupt-*.bak.
        if (!fs.existsSync(legacyStorePath)) {
            console.warn('[StandaloneHostSecrets] Legacy workspace secrets.enc was unreadable; leaving .master-key in place for manual recovery.');
            return;
        }

        const globalSecrets = new SharedStandaloneHostSecrets(globalStorePath, globalKeyPath);

        // Fully synchronous, deliberately. The caller hands the returned store
        // straight to every service, so no read may observe a half-migrated
        // state — and the renames below happen the moment this loop ends. An
        // async loop here would suspend at the first `await`, let the renames
        // run, and then read an already-renamed legacy store: it would import
        // nothing and silently retire the user's only copy of their tokens.
        for (const key of legacySecrets.keysSync()) {
            const legacyVal = legacySecrets.getSync(key);
            if (!legacyVal) { continue; }
            const globalVal = globalSecrets.getSync(key);
            if (!globalVal || globalVal.trim().length === 0) {
                globalSecrets.storeSync(key, legacyVal);
                console.log(`[StandaloneHostSecrets] Migrated legacy key '${key}' to global store.`);
            } else {
                console.log(`[StandaloneHostSecrets] Collision for legacy key '${key}'; global value retained.`);
            }
        }

        // Rename, never unlink — and never clobber a .bak from an earlier migration.
        fs.renameSync(legacyStorePath, uniqueBackupPath(path.join(legacyDir, 'secrets.enc.migrated.bak')));
        if (fs.existsSync(legacyKeyPath)) {
            fs.renameSync(legacyKeyPath, uniqueBackupPath(path.join(legacyDir, '.master-key.migrated.bak')));
        }
        console.log(`[StandaloneHostSecrets] Legacy workspace secret files renamed to .migrated.bak`);
    } catch (err) {
        console.error('[StandaloneHostSecrets] Failed to migrate legacy workspace secrets:', err);
    }
}

/** First free path in the `<base>`, `<base>.1`, `<base>.2`… series. */
function uniqueBackupPath(base: string): string {
    if (!fs.existsSync(base)) { return base; }
    let counter = 1;
    while (fs.existsSync(`${base}.${counter}`)) { counter++; }
    return `${base}.${counter}`;
}


// ─── Plan watcher config + watched-folders surface (Headless Ingestion piece 2) ─

/**
 * Read the `switchboard.planWatcher.*` config from the standalone config file.
 * The `PlanIngestionHost` seam reads these via `getConfig('planWatcher')` on
 * the host; this helper exposes the same values to external callers (e.g. a
 * headless status endpoint) without going through the engine.
 */
export function readPlanWatcherConfig(config: StandaloneHostPathConfigProvider): {
    periodicScanEnabled: boolean;
    scanIntervalMs: number;
} {
    return {
        periodicScanEnabled: config.getConfigBoolean('planWatcher.periodicScanEnabled', true),
        scanIntervalMs: config.getConfigNumber('planWatcher.scanIntervalMs', 10000),
    };
}

/**
 * Resolve the watched-folders list for the standalone host: the workspace root
 * plus any configured planScanner custom-source directories that exist on disk.
 * Mirrors the engine's `listWatchedRoots()` but is safe to call before the
 * engine is constructed (e.g. for a pre-init status report).
 */
export function resolveStandaloneWatchedRoots(
    config: StandaloneHostPathConfigProvider,
    workspaceRoot: string,
    extraRoots: string[] = [],
): string[] {
    const roots = [path.resolve(workspaceRoot)];
    for (const r of extraRoots) {
        const resolved = path.resolve(r);
        if (fs.existsSync(resolved) && !roots.includes(resolved)) {
            roots.push(resolved);
        }
    }
    // Include planScanner custom-source dirs from the config.
    const rawCustom = config.getConfigJson<any[]>('planScanner.customSources', []);
    if (Array.isArray(rawCustom)) {
        for (const src of rawCustom) {
            if (!src || typeof src !== 'object') continue;
            const globs = Array.isArray(src.globs) ? src.globs : [];
            for (const g of globs) {
                if (typeof g !== 'string') continue;
                const candidate = path.isAbsolute(g) ? g : path.resolve(workspaceRoot, g);
                try {
                    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory() && !roots.includes(candidate)) {
                        roots.push(candidate);
                    }
                } catch { /* skip unreadable */ }
            }
        }
    }
    return roots;
}

// ─── Memento/state bridge ────────────────────────────────────────────────────

export interface HostMemento {
    get<T>(key: string, defaultValue?: T): T | undefined;
    update(key: string, value: any): Promise<void>;
    keys(): readonly string[];
}

/**
 * A Memento-like surface backed by the KanbanDatabase config table.
 * Keys are namespaced under `standalone.state.*`.
 */
export class StandaloneHostState implements HostMemento {
    private _namespace = 'standalone.state.';
    private _db: { getConfig(key: string): Promise<string | null>; setConfig(key: string, value: string): Promise<boolean>; } | null = null;
    private _local: Map<string, any> = new Map();

    constructor(db?: { getConfig(key: string): Promise<string | null>; setConfig(key: string, value: string): Promise<boolean>; }) {
        this._db = db || null;
    }

    setDb(db: { getConfig(key: string): Promise<string | null>; setConfig(key: string, value: string): Promise<boolean>; }): void {
        this._db = db;
    }

    get<T>(key: string, defaultValue?: T): T | undefined {
        if (this._local.has(key)) { return this._local.get(key); }
        return defaultValue;
    }

    async update(key: string, value: any): Promise<void> {
        this._local.set(key, value);
        if (this._db) {
            const serialized = JSON.stringify(value);
            await this._db.setConfig(`${this._namespace}${key}`, serialized);
        }
    }

    async loadAll(): Promise<void> {
        if (!this._db) { return; }
        // SQLite wildcard for keys starting with namespace
        const prefix = this._namespace.replace(/\./g, '\\.');
        // Not all callers expose wildcard get; rely on the caller hydrating known keys.
    }

    keys(): readonly string[] {
        return Array.from(this._local.keys());
    }
}

/**
 * Build a headless HostSeams bundle for `npx switchboard` (no VS Code process).
 * Uses file-backed config/secrets and no-op UI/terminal/editor implementations.
 * A real file watcher can be swapped in later; this supplies a safe disposable.
 *
 * ⚠️ NOT CURRENTLY WIRED. `bootstrap.ts` injects `createVscodeHostSeams(...)` into every
 * provider, not this bundle — its VscodeHostCommands is registry-first, so the commands
 * bootstrap registers into `switchboardCommandRegistry` are reached that way. Consequences
 * for anyone reading the `commands` impl below and assuming it runs: it does not. Its
 * warn-once diagnostic is duplicated on the live path in `vscodeShim.commands.executeCommand`,
 * and its deliberate divergence from VscodeHostCommands (handler exceptions PROPAGATE here
 * rather than being swallowed by that class's `catch { return undefined }`) is likewise not
 * in effect. Switching bootstrap over is a real change — this bundle takes no secret storage
 * argument and its ui/terminal/editor seams differ — so do it deliberately, with tests.
 */
export function createHeadlessHostSeams(workspaceRoot: string): HostSeams {
    const pathConfig = new StandaloneHostPathConfigProvider(workspaceRoot);
    // Factory, not `new` — StandaloneHostSecrets moved to encryptedSecretsStore and now
    // takes (storePath, keyPath); createStandaloneHostSecrets owns the global-store path
    // resolution and the legacy workspace-secrets migration.
    const secrets = createStandaloneHostSecrets(workspaceRoot);

    return {
        // Empty on purpose — see the HostSeams.appName docstring. A blank ideName
        // is the fail-open value `isCompatibleIdeName` already relies on; naming
        // standalone here would hide its terminal rows from an editor session
        // reading the same DB. It also matches today's behaviour, where
        // `vscode.env.appName` is simply absent from vscodeShim.
        appName: '',
        pathConfig,
        terminal: {
            // No-op terminal handle. The real standalone terminals live in the PTY
            // fleet (ptyBackend/ptyFleetService); this seam stays inert so any
            // host-agnostic caller that reaches for `terminal.create()` here gets a
            // safe object rather than a crash. New TerminalHandle members must be
            // stubbed here too — the interface is structural, so an omission is a
            // compile error at this literal, not at the call site.
            create: (name: string) => ({
                name,
                sendText: () => {},
                write: () => {},
                onData: () => ({ dispose: () => {} }),
                onExit: () => ({ dispose: () => {} }),
                resize: () => {},
                dispose: () => {},
                kill: () => {},
                show: () => {},
            }),
            findByName: () => null,
            findByNameContains: () => null,
            sendInput: () => false,
            kill: () => false,
            resize: () => false,
            onClose: () => {},
        },
        commands: {
            executeCommand: async (command: string, ...args: any[]) => {
                if (switchboardCommandRegistry.has(command)) {
                    return await switchboardCommandRegistry.execute(command, ...args);
                }
                if (!_warnedMissingCommands.has(command)) {
                    _warnedMissingCommands.add(command);
                    console.warn(`[headless] command '${command}' is not bridged — the calling arm's side effect did not happen`);
                }
                return undefined;
            },
        },
        ui: {
            showWarningMessage: async () => undefined,
            showInformationMessage: async () => undefined,
            showErrorMessage: async (message: string, ..._items: string[]) => { console.warn('[headless UI]', message); return undefined; },
            showModalWarningMessage: async () => undefined,
            showTemporaryNotification: (message: string) => { console.log('[headless notification]', message); },
            showInputBox: async () => undefined,
            showQuickPick: async () => undefined,
            pickFolder: async () => undefined,
            pickFiles: async () => undefined,
            showOpenDialog: async () => undefined,
            openExternal: async (url: string) => { console.log('[headless openExternal]', url); },
        },
        editor: {
            openTextDocument: async () => {},
            showTextDocument: async () => {},
        },
        secrets,
        clipboard: {
            writeText: async (text: string) => { console.log('[headless clipboard] writeText'); },
            readText: async () => '',
        },
        workspace: {
            getWorkspaceRoots: () => [workspaceRoot],
        },
        watcher: {
            watchFolder: createStandaloneFolderWatcher,
            // Still stubs. watchFolder is implemented because the Tickets display watcher
            // (and the browser sidebar's auto-refresh) depends on it; the other two have no
            // standalone consumer today and turning them on would change unrelated
            // subsystems' behaviour without a test to hold the line.
            watchPattern: () => ({ dispose: () => {} }),
            watchFile: () => ({ dispose: () => {} }),
        },
    };
}
