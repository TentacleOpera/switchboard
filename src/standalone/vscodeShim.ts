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

import * as fs from 'fs';
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
        return this._secrets.keys();
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
    readonly query: string;
    private constructor(scheme: string, fsPath: string, query: string = '') {
        this.scheme = scheme;
        this.fsPath = fsPath;
        this.path = fsPath;
        this.query = query;
    }
    static file(path: string): Uri { return new Uri('file', path); }
    static parse(value: string): Uri {
        try {
            const u = new URL(value);
            return new Uri(u.protocol.replace(':', ''), u.pathname, u.search.replace(/^\?/, ''));
        } catch {
            return new Uri('file', String(value || ''), '');
        }
    }
    with(component: Partial<Uri>): Uri {
        return new Uri(
            component.scheme ?? this.scheme,
            component.fsPath ?? this.fsPath,
            component.query ?? this.query
        );
    }
}

// ─── RelativePattern ────────────────────────────────────────────────────────
// VscodeHostFileWatcher constructs `new vscode.RelativePattern(folder, glob)`
// before calling workspace.createFileSystemWatcher. The shim must export this
// class so that constructor resolves (otherwise it is `undefined` and throws
// TypeError, breaking every folder/pattern/file watcher in the standalone host).

export class RelativePattern {
    readonly base: string;
    readonly pattern: string;
    constructor(base: string | Uri | WorkspaceFolder | { fsPath: string }, pattern: string) {
        // Real VS Code accepts a string, a Uri, or a WorkspaceFolder as `base` and
        // exposes it as a STRING path — and callers use every one of those forms
        // (TaskViewerProvider passes `vscode.Uri.file(...)` for the brain and
        // configured-plan watchers). Normalising here keeps `base` a real path for
        // every reader; leaving a Uri through makes fs.watch throw and the watcher
        // degrade to a silent no-op.
        this.base = resolveBasePath(base) ?? String(base);
        this.pattern = pattern;
    }
}

/**
 * Coerce a RelativePattern `base` (string | Uri | WorkspaceFolder) to a filesystem
 * path. Returns undefined when the shape is unrecognised so callers can bail loudly
 * instead of handing `fs.watch` an object.
 */
function resolveBasePath(base: any): string | undefined {
    if (typeof base === 'string') { return base; }
    if (base && typeof base.fsPath === 'string') { return base.fsPath; }          // Uri
    if (base && base.uri && typeof base.uri.fsPath === 'string') { return base.uri.fsPath; } // WorkspaceFolder
    return undefined;
}

/**
 * Glob → anchored RegExp for the subset of glob syntax the standalone host uses:
 * `**` (any depth), `**\/` (ZERO or more path segments — the semantics VS Code
 * gives it, so `plans/**\/*.md` must match the flat `plans/foo.md` too), `*`
 * (within one segment) and `?`. Everything else is escaped: an unescaped `.`
 * matched any character, so `HEAD` matched `ORIG_HEAD` and `constitution.md`
 * matched `my-constitution.md`. The result is anchored at both ends.
 */
export function globToRegExp(glob: string): RegExp {
    if (glob === '**/*' || glob === '**') { return /.*/; }
    let re = '';
    for (let i = 0; i < glob.length; i++) {
        if (glob.startsWith('**/', i)) { re += '(?:[^/]+/)*'; i += 2; continue; }
        if (glob.startsWith('**', i)) { re += '.*'; i += 1; continue; }
        const c = glob[i];
        if (c === '*') { re += '[^/]*'; continue; }
        if (c === '?') { re += '[^/]'; continue; }
        re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp('^' + re + '$');
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
    export function registerUriHandler(_handler: any): Disposable { return new Disposable(() => {}); }
}

// ─── workspace ──────────────────────────────────────────────────────────────

export interface Configuration {
    get<T>(section: string, defaultValue?: T): T;
    get<T>(section: string, defaultValue?: T, _scope?: any): T;
    has(section: string): boolean;
    update(section: string, value: any, _target?: any): Promise<void>;
    inspect<T>(section: string): { key: string; defaultValue?: T; globalValue?: T; workspaceValue?: T; workspaceFolderValue?: T } | undefined;
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
    inspect<T>(section: string): { key: string; defaultValue?: T; globalValue?: T; workspaceValue?: T; workspaceFolderValue?: T } | undefined {
        // Headless: config.json is the store; there is no VS Code global/workspace
        // settings layer. Return all-undefined layers so migrations that read
        // inspect().globalValue/workspaceValue treat every setting as "not
        // explicitly set" (→ no-op) instead of crashing on a missing method.
        return { key: section, defaultValue: undefined, globalValue: undefined, workspaceValue: undefined, workspaceFolderValue: undefined };
    }
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
                if (prop === 'inspect') {
                    return (key: string) => (target as any).inspect(`${section}.${key}`);
                }
                return (target as any)[prop];
            },
        });
    }
    export function createFileSystemWatcher(pattern: any, _ignoreCreate?: boolean, _ignoreChange?: boolean, _ignoreDelete?: boolean): { onDidCreate: Event<Uri>; onDidChange: Event<Uri>; onDidDelete: Event<Uri>; dispose(): void } {
        const noop = (): any => ({ dispose() {} });

        // Resolve folder + glob from a RelativePattern ({ base, pattern }) or a
        // bare glob string. VscodeHostFileWatcher always passes RelativePattern,
        // but `base` may be a Uri or WorkspaceFolder rather than a path string
        // (TaskViewerProvider's brain / configured-plan watchers pass a Uri), so
        // normalise it — handing fs.watch an object throws and the watcher would
        // degrade to the very silent no-op this implementation replaced.
        let folderPath: string;
        let globPattern: string;
        if (pattern && typeof pattern === 'object' && 'base' in pattern) {
            const resolved = resolveBasePath((pattern as any).base);
            if (!resolved) {
                console.warn('[vscodeShim watcher] unrecognised RelativePattern base — watcher disabled:', (pattern as any).base);
                return { onDidCreate: noop, onDidChange: noop, onDidDelete: noop, dispose() {} };
            }
            folderPath = resolved;
            globPattern = (pattern as any).pattern || '**/*';
        } else if (typeof pattern === 'string') {
            folderPath = process.cwd();
            globPattern = pattern;
        } else {
            return { onDidCreate: noop, onDidChange: noop, onDidDelete: noop, dispose() {} };
        }

        const createHandlers: ((uri: Uri) => void)[] = [];
        const changeHandlers: ((uri: Uri) => void)[] = [];
        const deleteHandlers: ((uri: Uri) => void)[] = [];

        // Anchored glob matcher (see globToRegExp). Only the shapes the standalone
        // host actually uses are supported — no full glob library needed.
        const matcher = globToRegExp(globPattern);

        // fs.watch reports 'rename' for create AND delete — and macOS's recursive
        // (FSEvents) backend reports 'rename' for a plain write to an EXISTING file
        // too. Existence alone therefore cannot separate create from change, and
        // reporting every write as a create silently starved the one consumer that
        // keys on 'change' (PlanningPanelProvider's planning-HTML save listener).
        // Seed the known set from the watched folder's own entries — SHALLOW on
        // purpose. That is exact for the flat `watchFile` shape (the only consumer
        // that discriminates), and best-effort for a recursive `**/*` watch, whose
        // consumers all treat create and change identically. A full recursive walk
        // at arm time would scan arbitrary user doc trees on every re-arm to buy
        // nothing.
        const seen = new Set<string>();
        try {
            for (const name of fs.readdirSync(folderPath)) { seen.add(path.resolve(folderPath, name)); }
        } catch { /* folder unreadable — fall back to first-event-is-create */ }

        const emit = (eventType: string, filename: string | Buffer | null) => {
            if (!filename) return;
            const fullPath = path.resolve(folderPath, filename.toString());
            // Globs are always '/'-separated; path.relative yields '\\' on Windows.
            const relativePath = path.relative(folderPath, fullPath).split(path.sep).join('/');
            if (!matcher.test(relativePath) && !matcher.test(path.basename(fullPath))) return;

            const uri = { fsPath: fullPath } as Uri;
            if (!fs.existsSync(fullPath)) {
                seen.delete(fullPath);
                deleteHandlers.forEach(h => h(uri));
            } else if (eventType === 'rename' && !seen.has(fullPath)) {
                seen.add(fullPath);
                createHandlers.forEach(h => h(uri));
            } else {
                seen.add(fullPath);
                changeHandlers.forEach(h => h(uri));
            }
        };

        // Only recurse when the glob actually spans directories. `watchFile` arrives
        // as a bare filename against its parent folder — recursing there would walk
        // the whole subtree (all of `.switchboard/` to observe one `memo.md`) and
        // funnel every unrelated event through the matcher for nothing.
        const recursive = globPattern.includes('**') || globPattern.includes('/');

        let watcher: fs.FSWatcher;
        try {
            watcher = fs.watch(folderPath, { persistent: false, recursive }, emit);
        } catch {
            // recursive fs.watch needs macOS/Windows or Node >= 20 on Linux; fall
            // back to a flat watch (covers the flat plan/ticket folders).
            try {
                watcher = fs.watch(folderPath, { persistent: false }, emit);
            } catch (e) {
                console.warn(`[vscodeShim watcher] cannot watch ${folderPath}:`, e);
                return { onDidCreate: noop, onDidChange: noop, onDidDelete: noop, dispose() {} };
            }
        }
        watcher.on('error', err => console.warn(`[vscodeShim watcher] ${folderPath}:`, err));

        return {
            onDidCreate: (handler: (uri: Uri) => void) => { createHandlers.push(handler); return { dispose: () => {} }; },
            onDidChange: (handler: (uri: Uri) => void) => { changeHandlers.push(handler); return { dispose: () => {} }; },
            onDidDelete: (handler: (uri: Uri) => void) => { deleteHandlers.push(handler); return { dispose: () => {} }; },
            dispose: () => { try { watcher.close(); } catch {} }
        };
    }
    export function findFiles(_include: any, _exclude?: any, _maxResults?: number): Thenable<Uri[]> { return Promise.resolve([]); }
    export function getWorkspaceFolder(_uri: Uri): WorkspaceFolder | undefined { return undefined; }
    export function asRelativePath(p: string): string { return path.isAbsolute(p) ? path.relative(process.cwd(), p) : p; }
}

// ─── commands ───────────────────────────────────────────────────────────────

export namespace commands {
    // NOT the command bridge — do not build a registry here. Provider arms reach the
    // host through the `commands` SEAM (hostSeams.ts HostCommands), and standalone
    // injects `createVscodeHostSeams`, whose VscodeHostCommands is registry-first
    // (hostSeams.ts:327-336): a command registered into `switchboardCommandRegistry`
    // by bootstrap.ts executes there and never arrives here. The bridge point is
    // bootstrap's registration block; see also hostServices.ts's
    // `createHeadlessHostSeams`, which implements the same contract but is not the
    // bundle standalone currently injects.
    //
    // This stub is therefore the terminal dead end for *unbridged* commands only —
    // which is exactly why it warns. VscodeHostCommands swallows exceptions and
    // returns undefined, so without this line an arm whose whole payoff is a command
    // succeeds silently and the missing side effect is invisible. Warn-once per id,
    // per process: enough to diagnose, not enough to spam a long-running server.
    const _warnedUnbridged = new Set<string>();
    export async function executeCommand(command: string, ..._args: any[]): Promise<any> {
        if (!_warnedUnbridged.has(command)) {
            _warnedUnbridged.add(command);
            console.warn(`[headless] command '${command}' is not bridged — the calling arm's side effect did not happen`);
        }
        return undefined;
    }
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
    RelativePattern,
    window,
    workspace,
    commands,
    Disposable,
    ConfigurationTarget,
    extensions,
    env,
    SecretStorage: SecretStorage as any,
};
