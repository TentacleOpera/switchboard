import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { showTemporaryNotification } from '../utils/showTemporaryNotification';
import { SwitchboardCommandRegistry, switchboardCommandRegistry } from './commandRegistry';

/**
 * Host Seams — Feature A · A2a
 *
 * Interfaces for every vscode-coupled surface the handler extraction (A2b)
 * will encounter. Each interface has a vscode-backed implementation here
 * (the extension host uses these). B1's standalone composition root will
 * provide headless implementations that don't require vscode.
 *
 * A2b's service extraction routes every vscode-coupled call through the
 * appropriate seam. If A2b encounters a NEW coupling surface not covered
 * by these seams, it stops and adds it here (seam-growth protocol).
 */

// ─── HostPathConfigProvider ──────────────────────────────────────────────
// Abstracts the 3 config-read `require('vscode')` sites in KanbanDatabase.ts
// (:914-918, :6897-6901, :6911-6921) + workspace root resolution.

export interface HostPathConfigProvider {
    /** The workspace root this provider is scoped to. */
    readonly workspaceRoot: string;
    /** Read a `switchboard.*` config setting as a string. Returns '' if unset. */
    getConfigString(key: string): string;
    /** Read a `switchboard.*` config setting as a string with a default. */
    getConfigStringWithDefault(key: string, defaultValue: string): string;
    /** Read a `switchboard.*` config setting as a boolean. */
    getConfigBoolean(key: string, defaultValue: boolean): boolean;
    /** Read a `switchboard.*` config setting as a number. */
    getConfigNumber(key: string, defaultValue: number): number;
    /** Read a `switchboard.*` config setting as JSON. */
    getConfigJson<T>(key: string, defaultValue: T): T;
    /** Write a `switchboard.*` config setting at the user (global) scope. */
    updateConfigGlobal(key: string, value: any): Promise<void>;
    /** Write a `switchboard.*` config setting at the workspace scope. */
    updateConfigWorkspace(key: string, value: any): Promise<void>;
}

export class VscodeHostPathConfigProvider implements HostPathConfigProvider {
    readonly workspaceRoot: string;

    constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;
    }

    private _config(): vscode.WorkspaceConfiguration {
        return vscode.workspace.getConfiguration('switchboard', vscode.Uri.file(this.workspaceRoot));
    }

    private _configPath(): string {
        return path.join(this.workspaceRoot, '.switchboard', 'config.json');
    }

    private _readConfigFile(): Record<string, any> {
        try {
            const p = this._configPath();
            if (fs.existsSync(p)) {
                const raw = fs.readFileSync(p, 'utf8');
                return JSON.parse(raw) || {};
            }
        } catch {}
        return {};
    }

    private _readConfigValue(key: string): any {
        const fileConfig = this._readConfigFile();
        if (fileConfig[key] !== undefined) return fileConfig[key];
        const prefixed = `switchboard.${key}`;
        if (fileConfig[prefixed] !== undefined) return fileConfig[prefixed];
        return undefined;
    }

    private _writeConfigFile(key: string, value: any): void {
        try {
            const p = this._configPath();
            const dir = path.dirname(p);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            let cfg: Record<string, any> = {};
            try {
                if (fs.existsSync(p)) {
                    cfg = JSON.parse(fs.readFileSync(p, 'utf8')) || {};
                }
            } catch {}
            cfg[`switchboard.${key}`] = value;
            fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf8');
        } catch (err) {
            console.error('[VscodeHostPathConfigProvider] Failed to write config.json:', err);
        }
    }

    getConfigString(key: string): string {
        try {
            const fileVal = this._readConfigValue(key);
            if (fileVal !== undefined && fileVal !== null) {
                return String(fileVal).trim();
            }
            return String(this._config().get(key) || '').trim();
        } catch {
            return '';
        }
    }

    getConfigStringWithDefault(key: string, defaultValue: string): string {
        try {
            const fileVal = this._readConfigValue(key);
            if (fileVal !== undefined && fileVal !== null && fileVal !== '') {
                return String(fileVal);
            }
            const v = this._config().get<string>(key);
            return v !== undefined ? v : defaultValue;
        } catch {
            return defaultValue;
        }
    }

    getConfigBoolean(key: string, defaultValue: boolean): boolean {
        try {
            const fileVal = this._readConfigValue(key);
            if (fileVal !== undefined && fileVal !== null) {
                if (typeof fileVal === 'boolean') return fileVal;
                return String(fileVal).toLowerCase() === 'true';
            }
            const v = this._config().get<boolean>(key);
            return v !== undefined ? v : defaultValue;
        } catch {
            return defaultValue;
        }
    }

    getConfigNumber(key: string, defaultValue: number): number {
        try {
            const fileVal = this._readConfigValue(key);
            if (fileVal !== undefined && fileVal !== null) {
                if (typeof fileVal === 'number') return fileVal;
                const parsed = Number(fileVal);
                if (!isNaN(parsed)) return parsed;
            }
            const v = this._config().get<number>(key);
            return v !== undefined ? v : defaultValue;
        } catch {
            return defaultValue;
        }
    }

    getConfigJson<T>(key: string, defaultValue: T): T {
        try {
            const fileVal = this._readConfigValue(key);
            if (fileVal !== undefined && fileVal !== null) {
                if (typeof fileVal === 'object') return fileVal as T;
                try { return JSON.parse(String(fileVal)) as T; } catch { return defaultValue; }
            }
            const v = this._config().get<T>(key);
            return v !== undefined ? v : defaultValue;
        } catch {
            return defaultValue;
        }
    }

    async updateConfigGlobal(key: string, value: any): Promise<void> {
        this._writeConfigFile(key, value);
        await vscode.workspace.getConfiguration('switchboard').update(key, value, true);
    }
    async updateConfigWorkspace(key: string, value: any): Promise<void> {
        this._writeConfigFile(key, value);
        await vscode.workspace.getConfiguration('switchboard', vscode.Uri.file(this.workspaceRoot)).update(key, value, false);
    }
}

// ─── TerminalBackend ─────────────────────────────────────────────────────
// Interface + vscode.Terminal-backed adapter. Wraps existing code at
// TaskViewerProvider.ts:2994-3010, extension.ts:354-387.
// The node-pty implementation is B3, not here.

export interface TerminalHandle {
    readonly name: string;
    /** Send text/input to the terminal. */
    sendText(text: string, addNewLine?: boolean): void;
    /** Dispose/kill the terminal. */
    dispose(): void;
    /** Show the terminal in the panel. */
    show(preserveFocus?: boolean): void;
}

export interface TerminalBackend {
    /** Create a new terminal with the given name and optional shell path. */
    create(name: string, shellPath?: string, cwd?: string): TerminalHandle;
    /** Find an existing terminal by name. Returns null if not found. */
    findByName(name: string): TerminalHandle | null;
    /** Find an existing terminal whose name contains the given substring. Returns null if not found. */
    findByNameContains(substring: string): TerminalHandle | null;
    /** Send input to a terminal by name. Returns false if not found. */
    sendInput(name: string, text: string, addNewLine?: boolean): boolean;
    /** Kill a terminal by name. Returns false if not found. */
    kill(name: string): boolean;
    /** Resize a terminal by name. Returns false if not found. */
    resize(name: string, columns: number, rows: number): boolean;
    /** Register a callback for when a terminal is closed. */
    onClose(callback: (name: string) => void): void;
}

export class VscodeTerminalBackend implements TerminalBackend {
    create(name: string, shellPath?: string, cwd?: string): TerminalHandle {
        const opts: vscode.TerminalOptions = { name };
        if (shellPath) opts.shellPath = shellPath;
        if (cwd) opts.cwd = cwd;
        const terminal = vscode.window.createTerminal(opts);
        return this._wrap(terminal);
    }

    findByName(name: string): TerminalHandle | null {
        const terminal = vscode.window.terminals.find(t => t.name === name);
        return terminal ? this._wrap(terminal) : null;
    }

    findByNameContains(substring: string): TerminalHandle | null {
        const terminal = vscode.window.terminals.find(t => t.name.toLowerCase().includes(substring.toLowerCase()));
        return terminal ? this._wrap(terminal) : null;
    }

    sendInput(name: string, text: string, addNewLine?: boolean): boolean {
        const handle = this.findByName(name);
        if (!handle) return false;
        handle.sendText(text, addNewLine);
        return true;
    }

    kill(name: string): boolean {
        const handle = this.findByName(name);
        if (!handle) return false;
        handle.dispose();
        return true;
    }

    resize(name: string, columns: number, rows: number): boolean {
        // vscode.Terminal doesn't expose resize directly in older API versions;
        // the show() path handles visibility. This is a best-effort no-op for now.
        const handle = this.findByName(name);
        if (!handle) return false;
        handle.show(false);
        return true;
    }

    onClose(callback: (name: string) => void): void {
        vscode.window.onDidCloseTerminal(terminal => {
            callback(terminal.name);
        });
    }

    private _wrap(terminal: vscode.Terminal): TerminalHandle {
        return {
            name: terminal.name,
            sendText: (text: string, addNewLine?: boolean) => terminal.sendText(text, addNewLine),
            dispose: () => terminal.dispose(),
            show: (preserveFocus?: boolean) => terminal.show(preserveFocus),
        };
    }
}

// ─── HostCommands ────────────────────────────────────────────────────────
// Abstracts `vscode.commands.executeCommand` (found in arm bodies, e.g.
// KanbanProvider.ts:6424).
//
// A2b (Verb Engine · 1): dispatch is registry-first. `switchboard.*` commands
// whose bodies are registered in the host-agnostic SwitchboardCommandRegistry
// (extension.ts registers them at activation via registerSwitchboardCommand)
// are executed directly — no vscode command infrastructure on the path — so a
// seam-routed arm that invokes them runs headlessly once B1 registers headless
// handlers. Anything not in the registry (editor built-ins like
// `markdown.api.render`, `vscode.open`) falls through to vscode.commands.

export interface HostCommands {
    executeCommand<T = unknown>(command: string, ...args: any[]): Promise<T | undefined>;
}

export class VscodeHostCommands implements HostCommands {
    constructor(private readonly _registry: SwitchboardCommandRegistry = switchboardCommandRegistry) {}

    async executeCommand<T = unknown>(command: string, ...args: any[]): Promise<T | undefined> {
        try {
            if (this._registry.has(command)) {
                return await this._registry.execute<T>(command, ...args);
            }
            return await vscode.commands.executeCommand<T>(command, ...args);
        } catch {
            return undefined;
        }
    }
}

// ─── HostUI ──────────────────────────────────────────────────────────────
// Abstracts `vscode.window.showWarningMessage` / `showInformationMessage`
// (e.g. KanbanProvider.ts:6400).

export interface HostUI {
    showWarningMessage(message: string, ...items: string[]): Promise<string | undefined>;
    showInformationMessage(message: string, ...items: string[]): Promise<string | undefined>;
    showErrorMessage(message: string, ...items: string[]): Promise<string | undefined>;
    /** Modal warning dialog with choice buttons. Resolves to the picked item, or undefined if dismissed. */
    showModalWarningMessage(message: string, ...items: string[]): Promise<string | undefined>;
    /** Auto-dismissing toast (utils/showTemporaryNotification in the vscode host). */
    showTemporaryNotification(message: string, durationMs?: number): void;
    /** Input box dialog. Resolves to the entered string, or undefined if cancelled. */
    showInputBox(options?: { prompt?: string; placeHolder?: string; value?: string; validateInput?: (value: string) => string | undefined | Promise<string | undefined> }): Promise<string | undefined>;
    /** Quick-pick dialog. Resolves to the picked string(s) or item(s), or undefined if cancelled. */
    showQuickPick(items: Array<string | { label: string; description?: string }>, options?: { placeHolder?: string; canPickMany?: boolean }): Promise<string | { label: string; description?: string } | Array<string | { label: string; description?: string }> | undefined>;
    /** Folder-picker dialog. Resolves to the picked folder path, or undefined if cancelled. */
    pickFolder(openLabel: string): Promise<string | undefined>;
    /** File-picker dialog. Resolves to the picked file paths, or undefined if cancelled. */
    pickFiles(options: { openLabel: string; filters?: Record<string, string[]>; canSelectMany?: boolean }): Promise<string[] | undefined>;
    /** Open-file/folder dialog (VS Code shape, for existing call sites). Resolves to fsPaths, or undefined if cancelled. */
    showOpenDialog(options: { openLabel?: string; title?: string; canSelectFiles?: boolean; canSelectFolders?: boolean; canSelectMany?: boolean; filters?: Record<string, string[]> }): Promise<string[] | undefined>;
    /** Open a URL in the system browser. */
    openExternal(url: string): Promise<void>;
}

export class VscodeHostUI implements HostUI {
    async showWarningMessage(message: string, ...items: string[]): Promise<string | undefined> {
        return await vscode.window.showWarningMessage(message, ...items);
    }
    async showInformationMessage(message: string, ...items: string[]): Promise<string | undefined> {
        return await vscode.window.showInformationMessage(message, ...items);
    }
    async showErrorMessage(message: string, ...items: string[]): Promise<string | undefined> {
        return await vscode.window.showErrorMessage(message, ...items);
    }
    async showModalWarningMessage(message: string, ...items: string[]): Promise<string | undefined> {
        return await vscode.window.showWarningMessage(message, { modal: true }, ...items);
    }
    showTemporaryNotification(message: string, durationMs?: number): void {
        showTemporaryNotification(message, durationMs);
    }
    async showInputBox(options?: { prompt?: string; placeHolder?: string; value?: string; validateInput?: (value: string) => string | undefined | Promise<string | undefined> }): Promise<string | undefined> {
        return await vscode.window.showInputBox(options);
    }
    async showQuickPick(items: Array<string | { label: string; description?: string }>, options?: { placeHolder?: string; canPickMany?: boolean }): Promise<string | { label: string; description?: string } | Array<string | { label: string; description?: string }> | undefined> {
        return await vscode.window.showQuickPick(items as any, options) as any;
    }
    async pickFolder(openLabel: string): Promise<string | undefined> {
        const result = await vscode.window.showOpenDialog({
            openLabel,
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false
        });
        return result && result.length > 0 ? result[0].fsPath : undefined;
    }
    async pickFiles(options: { openLabel: string; filters?: Record<string, string[]>; canSelectMany?: boolean }): Promise<string[] | undefined> {
        const result = await vscode.window.showOpenDialog({
            openLabel: options.openLabel,
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: options.canSelectMany ?? true,
            filters: options.filters
        });
        return result && result.length > 0 ? result.map(u => u.fsPath) : undefined;
    }
    async showOpenDialog(options: { openLabel?: string; title?: string; canSelectFiles?: boolean; canSelectFolders?: boolean; canSelectMany?: boolean; filters?: Record<string, string[]> }): Promise<string[] | undefined> {
        const result = await vscode.window.showOpenDialog({
            openLabel: options.openLabel,
            title: options.title,
            canSelectFiles: options.canSelectFiles ?? true,
            canSelectFolders: options.canSelectFolders ?? false,
            canSelectMany: options.canSelectMany ?? true,
            filters: options.filters
        });
        return result && result.length > 0 ? result.map(u => u.fsPath) : undefined;
    }
    async openExternal(url: string): Promise<void> {
        await vscode.env.openExternal(vscode.Uri.parse(url));
    }
}

// ─── HostEditor ──────────────────────────────────────────────────────────
// Abstracts `vscode.workspace.openTextDocument` / `vscode.window.showTextDocument`
// (e.g. KanbanProvider.ts:6400).

export interface HostEditor {
    openTextDocument(filePath: string): Promise<void>;
    showTextDocument(filePath: string, options?: { preview?: boolean; viewColumn?: number }): Promise<void>;
}

export class VscodeHostEditor implements HostEditor {
    async openTextDocument(filePath: string): Promise<void> {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
        await vscode.window.showTextDocument(doc);
    }

    async showTextDocument(filePath: string, options?: { preview?: boolean; viewColumn?: number }): Promise<void> {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
        await vscode.window.showTextDocument(doc, { preview: options?.preview ?? false, viewColumn: options?.viewColumn });
    }
}

// ─── HostSecrets ─────────────────────────────────────────────────────────
// Abstracts `vscode.ExtensionContext.secrets` (SecretStorage) — API keys and
// tokens read/written from _handleMessage arms (e.g. DesignPanelProvider's
// `_setupStitchAuth`, TaskViewerProvider's integration tokens). B1's headless
// composition root supplies a keyring/file-backed implementation.

export interface HostSecrets {
    get(key: string): Promise<string | undefined>;
    store(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
}

export class VscodeHostSecrets implements HostSecrets {
    constructor(private readonly _secrets: vscode.SecretStorage) {}

    async get(key: string): Promise<string | undefined> {
        try {
            return await this._secrets.get(key);
        } catch {
            return undefined;
        }
    }
    async store(key: string, value: string): Promise<void> {
        await this._secrets.store(key, value);
    }
    async delete(key: string): Promise<void> {
        await this._secrets.delete(key);
    }
}

/**
 * Fallback for seam bundles created without a SecretStorage source (a provider
 * that has no ExtensionContext). Reads resolve to undefined; writes throw so a
 * mis-wired secrets-dependent verb fails loudly instead of silently dropping
 * the secret.
 */
export class UnavailableHostSecrets implements HostSecrets {
    async get(): Promise<string | undefined> {
        return undefined;
    }
    async store(): Promise<void> {
        throw new Error('HostSecrets not wired for this provider — pass a SecretStorage to createVscodeHostSeams');
    }
    async delete(): Promise<void> {
        throw new Error('HostSecrets not wired for this provider — pass a SecretStorage to createVscodeHostSeams');
    }
}

// ─── HostClipboard ───────────────────────────────────────────────────────
// Abstracts `vscode.env.clipboard` (copy*Prompt arms).

export interface HostClipboard {
    writeText(text: string): Promise<void>;
    readText(): Promise<string>;
}

export class VscodeHostClipboard implements HostClipboard {
    async writeText(text: string): Promise<void> {
        await vscode.env.clipboard.writeText(text);
    }
    async readText(): Promise<string> {
        return await vscode.env.clipboard.readText();
    }
}

// ─── HostWorkspace ───────────────────────────────────────────────────────
// Abstracts `vscode.workspace.workspaceFolders` (every provider's
// `_getWorkspaceRoots`). A headless host answers from its configured roots.

export interface HostWorkspace {
    getWorkspaceRoots(): string[];
}

export class VscodeHostWorkspace implements HostWorkspace {
    // `fallbackRoot` is the headless (npx) configured root. It is used ONLY when
    // `vscode.workspace.workspaceFolders` is empty — i.e. under the standalone
    // vscode shim, where no folders are registered. In the extension the folder
    // list is always populated, so the fallback never fires and multi-root hosts
    // still report every folder.
    constructor(private readonly fallbackRoot?: string) {}

    getWorkspaceRoots(): string[] {
        const folders = (vscode.workspace?.workspaceFolders || []).map(folder => folder.uri.fsPath);
        if (folders.length > 0) { return folders; }
        return this.fallbackRoot ? [this.fallbackRoot] : [];
    }
}

// ─── HostFileWatcher ─────────────────────────────────────────────────────
// Abstracts `vscode.workspace.createFileSystemWatcher` (the providers' folder
// watchers, re-armed from add/remove-folder arms). The vscode impl watches
// `<folder>/**/*`; a headless impl can use fs.watch/chokidar (B1) or a no-op
// recorder (tests).

export interface HostWatchHandle {
    dispose(): void;
}

export type HostWatchEvent = 'change' | 'create' | 'delete';

export interface HostFileWatcher {
    /** Watch a folder recursively. The listener receives the event kind and the affected file's path. */
    watchFolder(folderPath: string, listener: (event: HostWatchEvent, filePath: string) => void): HostWatchHandle;
    /** Watch a glob pattern under a folder. */
    watchPattern(folderPath: string, pattern: string, listener: (event: HostWatchEvent, filePath: string) => void): HostWatchHandle;
    /** Watch a single file. */
    watchFile(filePath: string, listener: (event: HostWatchEvent, filePath: string) => void): HostWatchHandle;
}

export class VscodeHostFileWatcher implements HostFileWatcher {
    watchFolder(folderPath: string, listener: (event: HostWatchEvent, filePath: string) => void): HostWatchHandle {
        const pattern = new vscode.RelativePattern(folderPath, '**/*');
        const watcher = vscode.workspace.createFileSystemWatcher(pattern);
        watcher.onDidChange(uri => listener('change', uri.fsPath));
        watcher.onDidCreate(uri => listener('create', uri.fsPath));
        watcher.onDidDelete(uri => listener('delete', uri.fsPath));
        return { dispose: () => watcher.dispose() };
    }

    watchPattern(folderPath: string, pattern: string, listener: (event: HostWatchEvent, filePath: string) => void): HostWatchHandle {
        const relativePattern = new vscode.RelativePattern(folderPath, pattern);
        const watcher = vscode.workspace.createFileSystemWatcher(relativePattern);
        watcher.onDidChange(uri => listener('change', uri.fsPath));
        watcher.onDidCreate(uri => listener('create', uri.fsPath));
        watcher.onDidDelete(uri => listener('delete', uri.fsPath));
        return { dispose: () => watcher.dispose() };
    }

    watchFile(filePath: string, listener: (event: HostWatchEvent, filePath: string) => void): HostWatchHandle {
        const folder = path.dirname(filePath);
        const fileName = path.basename(filePath);
        const relativePattern = new vscode.RelativePattern(folder, fileName);
        const watcher = vscode.workspace.createFileSystemWatcher(relativePattern);
        watcher.onDidChange(uri => listener('change', uri.fsPath));
        watcher.onDidCreate(uri => listener('create', uri.fsPath));
        watcher.onDidDelete(uri => listener('delete', uri.fsPath));
        return { dispose: () => watcher.dispose() };
    }
}

// ─── HostSeams bundle ────────────────────────────────────────────────────
// A2b's service extraction injects this bundle into extracted service methods.

export interface HostSeams {
    pathConfig: HostPathConfigProvider;
    terminal: TerminalBackend;
    commands: HostCommands;
    ui: HostUI;
    editor: HostEditor;
    secrets: HostSecrets;
    clipboard: HostClipboard;
    workspace: HostWorkspace;
    watcher: HostFileWatcher;
}

export function createVscodeHostSeams(workspaceRoot: string, secrets?: vscode.SecretStorage): HostSeams {
    return {
        pathConfig: new VscodeHostPathConfigProvider(workspaceRoot),
        terminal: new VscodeTerminalBackend(),
        commands: new VscodeHostCommands(),
        ui: new VscodeHostUI(),
        editor: new VscodeHostEditor(),
        secrets: secrets ? new VscodeHostSecrets(secrets) : new UnavailableHostSecrets(),
        clipboard: new VscodeHostClipboard(),
        workspace: new VscodeHostWorkspace(workspaceRoot),
        watcher: new VscodeHostFileWatcher(),
    };
}
