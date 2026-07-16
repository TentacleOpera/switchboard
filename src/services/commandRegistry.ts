/**
 * Switchboard Command Registry — Verb Engine · 1 (A2b foundations)
 *
 * Host-agnostic dispatch for the `switchboard.*` commands that _handleMessage
 * arms invoke. Historically arms called
 * `vscode.commands.executeCommand('switchboard.X', ...)`, which dead-ends in
 * the vscode command infrastructure — a headless host would have to
 * reimplement every command. The design audit ("deepen the command seam")
 * replaces that with this registry:
 *
 *  - extension.ts registers each arm-invoked command's HANDLER here (the same
 *    closure it hands to `vscode.commands.registerCommand`) via
 *    `registerSwitchboardCommand`. The vscode registration stays as a thin
 *    caller for palette/keybinding/other-extension invocation.
 *  - Seam-routed arms dispatch through `HostCommands` (hostSeams.ts), whose
 *    vscode impl is registry-first: a registered command executes directly,
 *    in-process, with no vscode dependency on the dispatch path. Un-registered
 *    commands (editor built-ins like `markdown.api.render`) fall through to
 *    `vscode.commands.executeCommand`.
 *  - B1's headless composition root registers headless handlers into its own
 *    registry (or this one) — same contract, no vscode.
 *
 * This module must stay free of any `vscode` import.
 */

export type SwitchboardCommandHandler = (...args: any[]) => any;

export class SwitchboardCommandRegistry {
    private _handlers = new Map<string, SwitchboardCommandHandler>();

    /** Register (or replace) a command handler. */
    register(command: string, handler: SwitchboardCommandHandler): void {
        this._handlers.set(command, handler);
    }

    /** Remove a command handler (used on extension deactivation/tests). */
    unregister(command: string): void {
        this._handlers.delete(command);
    }

    has(command: string): boolean {
        return this._handlers.has(command);
    }

    /**
     * Execute a registered command. Mirrors `vscode.commands.executeCommand`
     * semantics: resolves to the handler's return value; rejects if the
     * handler throws; throws if the command is unknown (callers gate on
     * `has()` first when a fallback exists).
     */
    async execute<T = unknown>(command: string, ...args: any[]): Promise<T | undefined> {
        const handler = this._handlers.get(command);
        if (!handler) {
            throw new Error(`Command not registered: '${command}'`);
        }
        return await handler(...args);
    }

    get registeredCommands(): string[] {
        return Array.from(this._handlers.keys()).sort();
    }
}

/**
 * The extension-host registry instance. extension.ts populates it at
 * activation; `VscodeHostCommands` (hostSeams.ts) consults it first on every
 * `executeCommand`.
 */
export const switchboardCommandRegistry = new SwitchboardCommandRegistry();
