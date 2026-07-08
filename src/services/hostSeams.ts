import * as vscode from 'vscode';
import * as path from 'path';

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
}

export class VscodeHostPathConfigProvider implements HostPathConfigProvider {
    readonly workspaceRoot: string;

    constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;
    }

    private _config(): vscode.WorkspaceConfiguration {
        return vscode.workspace.getConfiguration('switchboard', vscode.Uri.file(this.workspaceRoot));
    }

    getConfigString(key: string): string {
        try {
            return String(this._config().get(key) || '').trim();
        } catch {
            return '';
        }
    }

    getConfigStringWithDefault(key: string, defaultValue: string): string {
        try {
            const v = this._config().get<string>(key);
            return v !== undefined ? v : defaultValue;
        } catch {
            return defaultValue;
        }
    }

    getConfigBoolean(key: string, defaultValue: boolean): boolean {
        try {
            const v = this._config().get<boolean>(key);
            return v !== undefined ? v : defaultValue;
        } catch {
            return defaultValue;
        }
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

export interface HostCommands {
    executeCommand<T = unknown>(command: string, ...args: any[]): Promise<T | undefined>;
}

export class VscodeHostCommands implements HostCommands {
    async executeCommand<T = unknown>(command: string, ...args: any[]): Promise<T | undefined> {
        try {
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
}

// ─── HostEditor ──────────────────────────────────────────────────────────
// Abstracts `vscode.workspace.openTextDocument` / `vscode.window.showTextDocument`
// (e.g. KanbanProvider.ts:6400).

export interface HostEditor {
    openTextDocument(filePath: string): Promise<void>;
    showTextDocument(filePath: string, options?: { preview?: boolean }): Promise<void>;
}

export class VscodeHostEditor implements HostEditor {
    async openTextDocument(filePath: string): Promise<void> {
        const doc = await vscode.workspace.openTextDocument(filePath);
        await vscode.window.showTextDocument(doc);
    }

    async showTextDocument(filePath: string, options?: { preview?: boolean }): Promise<void> {
        const doc = await vscode.workspace.openTextDocument(filePath);
        await vscode.window.showTextDocument(doc, { preview: options?.preview ?? false });
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
}

export function createVscodeHostSeams(workspaceRoot: string): HostSeams {
    return {
        pathConfig: new VscodeHostPathConfigProvider(workspaceRoot),
        terminal: new VscodeTerminalBackend(),
        commands: new VscodeHostCommands(),
        ui: new VscodeHostUI(),
        editor: new VscodeHostEditor(),
    };
}
