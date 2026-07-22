/**
 * Headless `vscode` shim (Headless Ingestion piece 3).
 *
 * The standalone bundle (`dist/standalone/cli.js`) imports the real
 * ClickUp/Linear/Notion services, which `import * as vscode from 'vscode'` for
 * `vscode.SecretStorage` (token storage) and `vscode.window.*` (interactive
 * setup UI). In a pure-Node `npx switchboard` run there is no VS Code host, so
 * webpack `resolve.alias` maps the `vscode` import to this shim.
 *
 * What the shim provides:
 *   - `SecretStorage`-shaped adapter over `StandaloneHostSecrets` (encrypted
 *     file-backed). `get/store/delete/keys` all work; `onDidChange` is a
 *     no-op EventEmitter that never fires (config-time token writes via the
 *     file system are visible to the next reader, so no event is needed).
 *   - `window.showInputBox/showQuickPick/...` that reject with a clear
 *     "not available headless" error. The ingestion path never calls these —
 *     they're only reached by interactive setup flows the headless host
 *     doesn't run. Rejecting (vs. silently returning undefined) makes a
 *     misrouted call immediately visible instead of silently no-op'ing.
 *   - `EventEmitter` class with the `event` accessor and `fire/dispose` so
 *     `import { EventEmitter } from 'vscode'` (used by the watcher adapter
 *     bridge and others) type-checks and runs.
 *
 * The shim is intentionally minimal — only the surface the standalone bundle
 * actually touches. New usages should extend it, never reach for the real
 * `vscode` module (which isn't installed in the standalone runtime).
 */

import * as path from 'path';
import { StandaloneHostSecrets } from './hostServices';

// ─── Minimal EventEmitter ───────────────────────────────────────────────────

export class EventEmitter<T> {
    private _listeners = new Set<(e: T) => void>();
    public readonly event: (listener: (e: T) => any, thisArgs?: any, disposables?: { dispose(): void }[]) => { dispose(): void } = (listener) => {
        this._listeners.add(listener);
        const dispose = () => { this._listeners.delete(listener); };
        return { dispose };
    };
    public fire(data: T): void {
        for (const l of this._listeners) { try { l(data); } catch { /* isolated */ } }
    }
    public dispose(): void { this._listeners.clear(); }
}

export type Event<T> = (listener: (e: T) => any, thisArgs?: any, disposables?: { dispose(): void }[]) => { dispose(): void };

// ─── SecretStorage adapter ──────────────────────────────────────────────────

export interface SecretStorageChangeEvent { readonly key: string; }

export class SecretStorage {
    private _secrets: StandaloneHostSecrets;
    private _onDidChange = new EventEmitter<SecretStorageChangeEvent>();
    public readonly onDidChange: Event<SecretStorageChangeEvent> = this._onDidChange.event;

    constructor(secrets: StandaloneHostSecrets) {
        this._secrets = secrets;
    }

    async keys(): Promise<string[]> {
        // StandaloneHostSecrets doesn't expose enumeration; return an empty array.
        // The ingestion path only uses get/store/delete by known key — keys() is
        // only used by setup UIs that aren't reachable headless.
        return [];
    }

    async get(key: string): Promise<string | undefined> {
        return this._secrets.get(key);
    }

    async store(key: string, value: string): Promise<void> {
        await this._secrets.store(key, value);
        this._onDidChange.fire({ key });
    }

    async delete(key: string): Promise<void> {
        await this._secrets.delete(key);
        this._onDidChange.fire({ key });
    }
}

// ─── Uri ────────────────────────────────────────────────────────────────────

export class Uri {
    readonly fsPath: string;
    readonly scheme: string;
    readonly path: string;
    private constructor(scheme: string, fsPath: string) {
        this.scheme = scheme;
        this.fsPath = fsPath;
        this.path = fsPath;
    }
    static file(path: string): Uri { return new Uri('file', path); }
    static parse(_value: string): Uri { return new Uri('file', ''); }
    with(_component: Partial<Uri>): Uri { return this; }
}

// ─── WorkspaceFolder ────────────────────────────────────────────────────────

export interface WorkspaceFolder { readonly uri: Uri; readonly name: string; readonly index: number; }

// ─── window (interactive UI — all reject headless) ──────────────────────────

const headlessReject = (name: string) => Promise.reject(new Error(
    `vscode.window.${name} is not available in the headless standalone host. ` +
    `Run the equivalent flow from the VS Code extension, or set the token directly ` +
    `via the StandaloneHostSecrets file store.`
));

// ─── Terminal (headless: createTerminal rejects; type-only otherwise) ────────
export interface Terminal {
    readonly name: string;
    sendText(text: string, addNewLine?: boolean): void;
    show(preserveFocus?: boolean): void;
    hide(): void;
    dispose(): void;
    readonly exitStatus?: { code: number | undefined };
}

export namespace window {
    export const onDidChangeActiveTextEditor: Event<any> = () => ({ dispose() {} });
    export const onDidChangeVisibleTextEditors: Event<any[]> = () => ({ dispose() {} });
    export const onDidOpenTerminal: Event<Terminal> = () => ({ dispose() {} });
    export const onDidCloseTerminal: Event<Terminal> = () => ({ dispose() {} });
    // No active terminal headless; dispatch verbs that reach createTerminal fail
    // with a clear error instead of `undefined is not a function`.
    export const activeTerminal: Terminal | undefined = undefined;
    export const terminals: readonly Terminal[] = [];
    export function createTerminal(_options?: any): Terminal {
        throw new Error('vscode.window.createTerminal is not available in the headless standalone host; dispatch verbs are not supported over npx (B3).');
    }
    export async function showInputBox(_options?: any): Promise<string | undefined> { return headlessReject('showInputBox'); }
    export async function showQuickPick(_items: any, _options?: any): Promise<any> { return headlessReject('showQuickPick'); }
    export async function showInformationMessage(_message: string, ..._items: any[]): Promise<any> { return undefined; }
    export async function showWarningMessage(_message: string, ..._items: any[]): Promise<any> { return undefined; }
    export async function showErrorMessage(_message: string, ..._items: any[]): Promise<any> { console.error('[headless]', _message); return undefined; }
    export async function showOpenDialog(_options?: any): Promise<Uri[] | undefined> { return headlessReject('showOpenDialog'); }
    export async function showSaveDialog(_options?: any): Promise<Uri | undefined> { return headlessReject('showSaveDialog'); }
    export function createOutputChannel(_name: string): { appendLine(line: string): void; dispose(): void; show(): void; } {
        return {
            appendLine: (line: string) => console.log(`[headless-output] ${line}`),
            dispose: () => {},
            show: () => {},
        };
    }
    export function createWebviewPanel(): never { throw new Error('vscode.window.createWebviewPanel is not available headless'); }
    export function withProgress<R>(_options: any, task: (progress: any, token: any) => Thenable<R>): Thenable<R> {
        return task({ report: () => {} }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });
    }
    export function showTextDocument(_doc: any): Promise<any> { return Promise.resolve(undefined); }
}

// ─── workspace ──────────────────────────────────────────────────────────────

export interface Configuration {
    get<T>(section: string, defaultValue?: T): T;
    get<T>(section: string, defaultValue?: T, _scope?: any): T;
    has(section: string): boolean;
    update(section: string, value: any, _target?: any): Promise<void>;
}

class StandaloneConfiguration implements Configuration {
    constructor(private _workspaceRoot: string) {}
    get<T>(section: string, defaultValue?: T): T {
        // Read from the StandaloneHostPathConfigProvider's config.json. We import lazily
        // to avoid a cycle at module load time.
        try {
            const { StandaloneHostPathConfigProvider } = require('./hostServices');
            const provider = new StandaloneHostPathConfigProvider(this._workspaceRoot);
            const raw = (provider as any)._rawValue?.(section);
            if (raw === undefined) { return defaultValue as T; }
            return raw as T;
        } catch {
            return defaultValue as T;
        }
    }
    has(_section: string): boolean { return false; }
    async update(_section: string, _value: any, _target?: any): Promise<void> { /* no-op */ }
}

export namespace workspace {
    export const workspaceFolders: readonly WorkspaceFolder[] = [];
    export const onDidChangeWorkspaceFolders: Event<{ added: WorkspaceFolder[]; removed: WorkspaceFolder[] }> = () => ({ dispose() {} });
    export const onDidChangeConfiguration: Event<{ affectsConfiguration(section: string): boolean }> = () => ({ dispose() {} });
    export function getConfiguration(section?: string, _scope?: any): Configuration {
        const root = (globalThis as any).__SWITCHBOARD_STANDALONE_WORKSPACE_ROOT || process.cwd();
        const cfg = new StandaloneConfiguration(root);
        if (!section) { return cfg; }
        // Return a proxy that prefixes the section to each get() call — matches the
        // VS Code shape where getConfiguration('switchboard.planWatcher').get('periodicScanEnabled')
        // reads 'switchboard.planWatcher.periodicScanEnabled'.
        return new Proxy(cfg, {
            get(target, prop) {
                if (prop === 'get') {
                    return (key: string, defaultValue?: any) => target.get(`${section}.${key}`, defaultValue);
                }
                if (prop === 'has') {
                    return (key: string) => target.has(`${section}.${key}`);
                }
                if (prop === 'update') {
                    return (key: string, value: any, target2?: any) => target.update(`${section}.${key}`, value, target2);
                }
                return (target as any)[prop];
            },
        });
    }
    export function createFileSystemWatcher(_pattern: any, _ignoreCreate?: boolean, _ignoreChange?: boolean, _ignoreDelete?: boolean): { onDidCreate: Event<Uri>; onDidChange: Event<Uri>; onDidDelete: Event<Uri>; dispose(): void } {
        const noop = (): any => ({ dispose() {} });
        return { onDidCreate: noop, onDidChange: noop, onDidDelete: noop, dispose() {} };
    }
    export function findFiles(_include: any, _exclude?: any, _maxResults?: number): Thenable<Uri[]> { return Promise.resolve([]); }
    export function getWorkspaceFolder(_uri: Uri): WorkspaceFolder | undefined { return undefined; }
    export function asRelativePath(p: string): string { return path.isAbsolute(p) ? path.relative(process.cwd(), p) : p; }
}

// ─── commands ───────────────────────────────────────────────────────────────

export namespace commands {
    export async function executeCommand(_command: string, ..._args: any[]): Promise<any> { return undefined; }
    export function registerCommand(_command: string, _callback: (...args: any[]) => any): { dispose(): void } { return { dispose() {} }; }
}

// ─── Disposable ─────────────────────────────────────────────────────────────

export class Disposable {
    constructor(private _callOnDispose: () => void) {}
    public dispose(): void { try { this._callOnDispose(); } catch {} }
    public static from(...disposables: { dispose(): void }[]): Disposable {
        return new Disposable(() => { for (const d of disposables) { try { d.dispose(); } catch {} } });
    }
}

// ─── Other surfaces used by the imported services ───────────────────────────

export enum ConfigurationTarget {
    Global = 1,
    Workspace = 2,
    WorkspaceFolder = 3,
}

export namespace extensions {
    export function getExtension<T>(_id: string): { isActive: boolean; exports: T } | undefined { return undefined; }
}

export namespace env {
    export const machineId: string = 'standalone-machine';
    export const sessionId: string = 'standalone-session';
    // NotionFetchService (and any OAuth flow) calls vscode.env.openExternal. Headless
    // can't open a browser tab — log the URL best-effort (matches the headless HostSeams
    // openExternal) rather than crashing with a raw TypeError on the missing member.
    export async function openExternal(target: Uri | string): Promise<boolean> {
        const url = typeof target === 'string' ? target : target?.fsPath || '';
        console.log('[headless openExternal]', url);
        return true;
    }
    // Headless has no real clipboard. Provider arms that call
    // `vscode.env.clipboard.writeText` (via VscodeHostClipboard) would crash with a
    // TypeError on the missing member. No-op here; the prompt-copy verbs return the
    // prompt in the HTTP body and transport.js copies it client-side (see the memo
    // prompt pattern and the new improvePlan/improveFeature arms).
    export const clipboard = {
        async writeText(_text: string): Promise<void> { /* no-op headless */ },
        async readText(): Promise<string> { return ''; },
    };
}

// ─── Standalone-only: install the workspace root for the SecretStorage/config ─

/**
 * Set the workspace root the shim's `workspace.getConfiguration` reads from.
 * Called by `bootstrap.ts` before constructing any service that touches
 * `vscode.workspace.getConfiguration`.
 */
export function __setStandaloneWorkspaceRoot(workspaceRoot: string): void {
    (globalThis as any).__SWITCHBOARD_STANDALONE_WORKSPACE_ROOT = path.resolve(workspaceRoot);
}

/**
 * Construct a `vscode.SecretStorage`-shaped adapter over the file-backed
 * `StandaloneHostSecrets`. Called by `bootstrap.ts` when wiring the real
 * provider factories (Headless Ingestion piece 3).
 */
export function createStandaloneSecretStorage(secrets: StandaloneHostSecrets): SecretStorage {
    return new SecretStorage(secrets);
}

// Default-export a namespace-shaped object so `import * as vscode from 'vscode'`
// (the form the services use) resolves to this shim's exports.
export default {
    EventEmitter,
    Uri,
    window,
    workspace,
    commands,
    Disposable,
    ConfigurationTarget,
    extensions,
    env,
    SecretStorage: SecretStorage as any,
};
