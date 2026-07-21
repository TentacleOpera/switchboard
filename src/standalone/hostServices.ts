import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
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

    constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;
        this._load();
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

    async updateConfigGlobal(key: string, value: any): Promise<void> {
        this._config[`switchboard.${key}`] = value;
        this._save();
    }

    async updateConfigWorkspace(key: string, value: any): Promise<void> {
        // Standalone has no global/user split; treat workspace scope as local file config.
        this._config[`switchboard.${key}`] = value;
        this._save();
    }
}

// ─── Secrets ───────────────────────────────────────────────────────────────

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

export class StandaloneHostSecrets implements HostSecrets {
    private _keyPath: string;
    private _storePath: string;
    private _cache: Map<string, string> = new Map();

    constructor(workspaceRoot: string) {
        const dir = path.join(workspaceRoot, '.switchboard');
        this._keyPath = path.join(dir, '.master-key');
        this._storePath = path.join(dir, 'secrets.enc');
        this._load();
    }

    private _getOrCreateKey(): Buffer {
        try {
            const existing = process.env.SWITCHBOARD_MASTER_KEY || process.env.SWITCHBOARD_MASTER_PASSPHRASE;
            if (existing) {
                return crypto.scryptSync(existing, 'switchboard-standalone', 32);
            }
        } catch { /* fall through to file key */ }

        try {
            if (fs.existsSync(this._keyPath)) {
                return Buffer.from(fs.readFileSync(this._keyPath, 'utf8').trim(), 'hex');
            }
        } catch { /* fall through to create */ }

        const key = crypto.randomBytes(32);
        const dir = path.dirname(this._keyPath);
        if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
        fs.writeFileSync(this._keyPath, key.toString('hex'), { mode: 0o600 });
        try { fs.chmodSync(this._keyPath, 0o600); } catch { /* ignore on Windows */ }
        return key;
    }

    private _load(): void {
        if (!fs.existsSync(this._storePath)) { return; }
        const key = this._getOrCreateKey();
        const blob = fs.readFileSync(this._storePath);
        if (blob.length < IV_LENGTH + TAG_LENGTH) { return; }
        const iv = blob.subarray(0, IV_LENGTH);
        const tag = blob.subarray(blob.length - TAG_LENGTH);
        const ciphertext = blob.subarray(IV_LENGTH, blob.length - TAG_LENGTH);
        try {
            const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
            decipher.setAuthTag(tag);
            const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
            this._cache = new Map(Object.entries(JSON.parse(plaintext.toString('utf8'))));
        } catch (err) {
            console.error('[StandaloneHostSecrets] Failed to decrypt secret store:', err);
        }
    }

    private _save(): void {
        const key = this._getOrCreateKey();
        const iv = crypto.randomBytes(IV_LENGTH);
        const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
        const plaintext = Buffer.from(JSON.stringify(Object.fromEntries(this._cache)), 'utf8');
        const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        const tag = cipher.getAuthTag();
        const dir = path.dirname(this._storePath);
        if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
        fs.writeFileSync(this._storePath, Buffer.concat([iv, ciphertext, tag]), { mode: 0o600 });
    }

    async get(key: string): Promise<string | undefined> {
        return this._cache.get(key);
    }

    async store(key: string, value: string): Promise<void> {
        this._cache.set(key, value);
        this._save();
    }

    async delete(key: string): Promise<void> {
        this._cache.delete(key);
        this._save();
    }
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
    const secrets = new StandaloneHostSecrets(workspaceRoot);

    return {
        pathConfig,
        terminal: {
            create: (name: string) => ({ name, sendText: () => {}, dispose: () => {}, show: () => {} }),
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
