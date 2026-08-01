import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { HostSeams, HostPathConfigProvider, HostSecrets } from '../services/hostSeams';

/**
 * Standalone implementations of the host seams A2a defined.
 *
 * These are used by `npx switchboard` (no VS Code) and do not depend on the
 * vscode module.  The extension path is unchanged because it never imports
 * this file.
 */

// ─── Config provider ───────────────────────────────────────────────────────

function envKeyForSetting(settingKey: string): string {
    return 'SWITCHBOARD_' + settingKey.replace(/\./g, '_').toUpperCase();
}

export class StandaloneHostPathConfigProvider implements HostPathConfigProvider {
    readonly workspaceRoot: string;
    private _config: Record<string, any> = {};
    private _listeners: Set<(key: string, value: any, originatorId?: string) => void> = new Set();

    constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;
        this._load();
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

    private _configPath(): string {
        return path.join(this.workspaceRoot, '.switchboard', 'config.json');
    }

    private _load(): void {
        try {
            const raw = fs.readFileSync(this._configPath(), 'utf8');
            this._config = JSON.parse(raw) || {};
        } catch {
            this._config = {};
        }
    }

    private _save(): void {
        const dir = path.dirname(this._configPath());
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(this._configPath(), JSON.stringify(this._config, null, 2), 'utf8');
    }

    private _rawValue(key: string): any {
        // 1. Environment override (e.g. SWITCHBOARD_KANBAN_DBPATH)
        const envValue = process.env[envKeyForSetting(key)];
        if (envValue !== undefined) { return envValue; }

        // 2. Config file, either as written ("switchboard.x.y") or without prefix ("x.y")
        if (this._config[key] !== undefined) { return this._config[key]; }
        const prefixed = `switchboard.${key}`;
        if (this._config[prefixed] !== undefined) { return this._config[prefixed]; }

        return undefined;
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
        this._config[`switchboard.${key}`] = value;
        this._save();
        this._notifyListeners(key, value, originatorId);
    }

    async updateConfigWorkspace(key: string, value: any, originatorId?: string): Promise<void> {
        // Standalone has no global/user split; treat workspace scope as local file config.
        this._config[`switchboard.${key}`] = value;
        this._save();
        this._notifyListeners(key, value, originatorId);
    }
}

// ─── Secrets ───────────────────────────────────────────────────────────────

export { StandaloneHostSecrets, HostSecrets } from '../services/encryptedSecretsStore';
import { StandaloneHostSecrets as SharedStandaloneHostSecrets } from '../services/encryptedSecretsStore';
import { stateFile } from '../utils/stateHome';

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
 */
export function createHeadlessHostSeams(workspaceRoot: string): HostSeams {
    const pathConfig = new StandaloneHostPathConfigProvider(workspaceRoot);
    // Factory, not `new` — StandaloneHostSecrets moved to encryptedSecretsStore and now
    // takes (storePath, keyPath); createStandaloneHostSecrets owns the global-store path
    // resolution and the legacy workspace-secrets migration.
    const secrets = createStandaloneHostSecrets(workspaceRoot);

    return {
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
            executeCommand: async () => undefined,
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
            watchFolder: () => ({ dispose: () => {} }),
            watchPattern: () => ({ dispose: () => {} }),
            watchFile: () => ({ dispose: () => {} }),
        },
    };
}
