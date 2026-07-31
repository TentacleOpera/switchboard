import { EventEmitter } from 'events';
import type { TerminalHandle } from '../services/hostSeams';
import { PtyTerminalBackend } from './ptyBackend';
import { GlobalIntegrationConfigService } from '../services/GlobalIntegrationConfigService';
import type { KanbanDatabase } from '../services/KanbanDatabase';

export const SHELL_READINESS_DELAY_MS = 750;
export const SIGTERM_GRACE_MS = 3000;

/**
 * Registry owner tag. The extension's `isCompatibleIdeName` partition (see
 * extension.ts) uses this to leave PTY rows alone instead of adopting them.
 */
export const PTY_IDE_NAME = 'standalone-pty';

export interface FleetTerminalInfo {
    friendlyName: string;
    role: string;
    status: 'active' | 'exited';
    pid: number;
    startTime: string;
    worktreePath?: string;
    ideName: string;
    purpose: string;
}

export interface ExtendedTerminalHandle extends TerminalHandle {
    pty: import('node-pty').IPty;
    role: string;
    friendlyName: string;
    startTime: string;
    status: 'active' | 'exited';
    worktreePath?: string;
    exitCode?: number;
}

export type FleetChangeEvent = 
    | { type: 'created'; terminal: ExtendedTerminalHandle }
    // `code` is the process exit status when the PTY died on its own, and
    // undefined for an operator-initiated kill(). The gateway forwards it to
    // attached clients — without it every terminal reported "exited with code 0".
    | { type: 'closed'; name: string; code?: number }
    | { type: 'renamed'; oldName: string; newName: string };

export class PtyFleetService {
    private backend = new PtyTerminalBackend();
    private terminals = new Map<string, ExtendedTerminalHandle>();
    private emitter = new EventEmitter();
    private db?: KanbanDatabase;
    private workspaceRoot: string;
    /** Serializes async registry read-modify-write cycles. See updateRegistryState. */
    private _registryWrite: Promise<void> = Promise.resolve();

    constructor(workspaceRoot: string, db?: KanbanDatabase) {
        this.workspaceRoot = workspaceRoot;
        this.db = db;
        this.setupShutdownHandlers();
    }

    public setDatabase(db: KanbanDatabase): void {
        this.db = db;
    }

    public onDidChange(listener: (event: FleetChangeEvent) => void): { dispose: () => void } {
        this.emitter.on('change', listener);
        return {
            dispose: () => {
                this.emitter.off('change', listener);
            }
        };
    }

    public async create(role: string, friendlyName?: string, cwd?: string, worktreePath?: string): Promise<ExtendedTerminalHandle> {
        let name = friendlyName || `${role}-1`;
        let counter = 1;
        while (this.terminals.has(name)) {
            counter++;
            name = `${role}-${counter}`;
        }

        const effectiveCwd = cwd || worktreePath || this.workspaceRoot;
        const rawHandle = this.backend.create({
            name,
            cwd: effectiveCwd,
        });

        const startTime = new Date().toISOString();
        const handle: ExtendedTerminalHandle = {
            ...rawHandle,
            name,
            role,
            friendlyName: name,
            startTime,
            status: 'active',
            worktreePath: worktreePath || (cwd !== this.workspaceRoot ? cwd : undefined),
        };

        this.terminals.set(name, handle);

        handle.onExit((code) => {
            handle.status = 'exited';
            handle.exitCode = code;
            const wasPresent = this.terminals.has(handle.name);
            if (wasPresent) {
                this.updateRegistryState();
                this.emitter.emit('change', { type: 'closed', name: handle.name, code });
            }
        });

        this.updateRegistryState();
        this.emitter.emit('change', { type: 'created', terminal: handle });

        await this.injectStartupCommand(handle, role);

        return handle;
    }

    private async injectStartupCommand(handle: ExtendedTerminalHandle, role: string): Promise<void> {
        try {
            const commands = await GlobalIntegrationConfigService.getAgentStartupCommands() || {};
            const cmd = commands[role];
            if (!cmd) { return; }
            await new Promise(resolve => setTimeout(resolve, SHELL_READINESS_DELAY_MS));
            if (handle.status === 'active') {
                handle.sendText(cmd, true);
            }
        } catch (err) {
            console.warn(`[PtyFleetService] Failed to inject startup command for role ${role}:`, err);
        }
    }

    public list(): ExtendedTerminalHandle[] {
        return Array.from(this.terminals.values());
    }

    public listActive(): ExtendedTerminalHandle[] {
        return Array.from(this.terminals.values()).filter(t => t.status === 'active');
    }

    public get(name: string): ExtendedTerminalHandle | undefined {
        return this.terminals.get(name);
    }

    public kill(name: string): boolean {
        const handle = this.terminals.get(name);
        if (!handle) return false;
        this.terminals.delete(name);
        try {
            handle.kill();
        } catch { /* ignore */ }
        this.updateRegistryState();
        this.emitter.emit('change', { type: 'closed', name });
        return true;
    }

    public rename(name: string, newAlias: string): boolean {
        const handle = this.terminals.get(name);
        if (!handle || this.terminals.has(newAlias)) return false;

        this.terminals.delete(name);
        handle.friendlyName = newAlias;
        (handle as any).name = newAlias;
        this.terminals.set(newAlias, handle);

        this.updateRegistryState();
        this.emitter.emit('change', { type: 'renamed', oldName: name, newName: newAlias });
        return true;
    }

    /**
     * Persist the live fleet into the shared `runtime.terminals` registry (the
     * `terminals` state key per stateConfigBridge.ts) so /health, the board and
     * worktree routing all see PTY terminals.
     *
     * Merges rather than clobbers: entries whose `ideName`/`purpose` are NOT ours
     * belong to another writer (a VS Code host that opened this same workspace db)
     * and are preserved verbatim. Only `purpose:'pty'` rows are ours to rewrite.
     *
     * Writes are serialized through `_registryWrite` — setConfigJson is async and
     * concurrent create/exit bursts would otherwise interleave read-modify-write
     * cycles and drop entries.
     */
    private updateRegistryState(): void {
        if (!this.db) return;
        const db = this.db;
        this._registryWrite = this._registryWrite.then(async () => {
            const existing = db.getConfigJsonSync<Record<string, any>>('runtime.terminals', {}) || {};
            const terminalMap: Record<string, any> = {};
            for (const [name, entry] of Object.entries(existing)) {
                if (entry && entry.purpose === 'pty') { continue; }
                if (entry && entry.ideName === PTY_IDE_NAME) { continue; }
                terminalMap[name] = entry;
            }
            for (const [name, t] of this.terminals.entries()) {
                terminalMap[name] = {
                    friendlyName: t.friendlyName,
                    role: t.role,
                    status: t.status,
                    pid: t.pty.pid,
                    startTime: t.startTime,
                    worktreePath: t.worktreePath,
                    ideName: PTY_IDE_NAME,
                    purpose: 'pty',
                } satisfies FleetTerminalInfo;
            }
            await db.setConfigJson('runtime.terminals', terminalMap);
        }).catch(err => {
            console.warn('[PtyFleetService] Failed to update terminal registry state:', err);
        });
    }

    public async disposeAll(): Promise<void> {
        const activeList = this.listActive();
        for (const handle of activeList) {
            try {
                handle.pty.kill('SIGTERM');
            } catch { /* ignore */ }
        }

        if (activeList.length > 0) {
            const start = Date.now();
            while (Date.now() - start < SIGTERM_GRACE_MS) {
                if (this.listActive().length === 0) break;
                await new Promise(r => setTimeout(r, 100));
            }
        }

        for (const handle of Array.from(this.terminals.values())) {
            try {
                handle.pty.kill('SIGKILL');
            } catch { /* ignore */ }
        }
        this.terminals.clear();
        this.updateRegistryState();
    }

    /**
     * Last-resort reaper. The GRACEFUL path is `instance.stop()`, which awaits
     * `disposeAll()` and gets the full SIGTERM → grace → SIGKILL budget; cli.ts
     * awaits that before `process.exit(0)`.
     *
     * This handler exists only for exits that never reach `stop()` (an uncaught
     * throw, a stray `process.exit()`). It is deliberately SYNCHRONOUS: on the
     * `exit` event the event loop is already drained, so an async `disposeAll()`
     * would send SIGTERM and never live to escalate — leaving orphaned shells and
     * risking the node-pty N-API teardown SIGABRT (upstream #904) that this whole
     * dispose-before-exit requirement exists to prevent. One hard kill, no awaits.
     */
    private setupShutdownHandlers(): void {
        const reapNow = () => {
            for (const handle of Array.from(this.terminals.values())) {
                try { handle.pty.kill('SIGKILL'); } catch { /* already gone */ }
            }
            this.terminals.clear();
        };
        process.once('exit', reapNow);
    }

    /**
     * Boot reconcile: drop every `purpose:'pty'` registry entry left over from a
     * previous run. PTYs are children of this process, so a recorded entry after a
     * restart is always a ghost — and a dispatch that resolved to one would route
     * work at a dead pid.
     *
     * MUST be awaited before LocalApiServer.start() accepts requests: the write
     * side is async (setConfigJson), so a fire-and-forget purge leaves a window in
     * which /kanban/dispatch's pre-flight sees ghosts and passes.
     */
    public static async purgePtyTerminals(db: KanbanDatabase): Promise<void> {
        try {
            const parsed = db.getConfigJsonSync<Record<string, any>>('runtime.terminals', {});
            if (!parsed || typeof parsed !== 'object') return;
            let modified = false;
            for (const key of Object.keys(parsed)) {
                const item = parsed[key];
                if (item && (item.purpose === 'pty' || item.ideName === PTY_IDE_NAME)) {
                    delete parsed[key];
                    modified = true;
                }
            }
            if (modified) {
                await db.setConfigJson('runtime.terminals', parsed);
            }
        } catch (err) {
            console.warn('[PtyFleetService] Failed to purge PTY terminals on boot:', err);
        }
    }
}
