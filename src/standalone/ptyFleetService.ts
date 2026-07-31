import { EventEmitter } from 'events';
import type { TerminalHandle } from '../services/hostSeams';
import { PtyTerminalBackend } from './ptyBackend';
import { GlobalIntegrationConfigService } from '../services/GlobalIntegrationConfigService';
import type { KanbanDatabase } from '../services/KanbanDatabase';

export const SHELL_READINESS_DELAY_MS = 750;
export const SIGTERM_GRACE_MS = 3000;

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
    | { type: 'closed'; name: string }
    | { type: 'renamed'; oldName: string; newName: string };

export class PtyFleetService {
    private backend = new PtyTerminalBackend();
    private terminals = new Map<string, ExtendedTerminalHandle>();
    private emitter = new EventEmitter();
    private db?: KanbanDatabase;
    private workspaceRoot: string;

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
            this.updateRegistryState();
            this.emitter.emit('change', { type: 'closed', name: handle.name });
        });

        this.updateRegistryState();
        this.emitter.emit('change', { type: 'created', terminal: handle });

        // Resolve startup command and inject after readiness delay
        this.injectStartupCommand(handle, role, effectiveCwd);

        return handle;
    }

    private async injectStartupCommand(handle: ExtendedTerminalHandle, role: string, workspaceRoot: string): Promise<void> {
        try {
            const commands = await GlobalIntegrationConfigService.getAgentStartupCommands() || {};
            const cmd = commands[role];
            if (cmd) {
                setTimeout(() => {
                    if (handle.status === 'active') {
                        handle.sendText(cmd, true);
                    }
                }, SHELL_READINESS_DELAY_MS);
            }
        } catch (err) {
            console.warn(`[PtyFleetService] Failed to inject startup command for role ${role}:`, err);
        }
    }

    public list(): ExtendedTerminalHandle[] {
        return Array.from(this.terminals.values());
    }

    public get(name: string): ExtendedTerminalHandle | undefined {
        return this.terminals.get(name);
    }

    public kill(name: string): boolean {
        const handle = this.terminals.get(name);
        if (!handle) return false;
        try {
            handle.kill();
        } catch { /* ignore */ }
        this.terminals.delete(name);
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

    private updateRegistryState(): void {
        if (!this.db) return;
        try {
            const terminalMap: Record<string, FleetTerminalInfo> = {};
            for (const [name, t] of this.terminals.entries()) {
                terminalMap[name] = {
                    friendlyName: t.friendlyName,
                    role: t.role,
                    status: t.status,
                    pid: t.pty.pid,
                    startTime: t.startTime,
                    worktreePath: t.worktreePath,
                    ideName: 'standalone-pty',
                    purpose: 'pty',
                };
            }
            this.db.setConfigValue('runtime.terminals', JSON.stringify(terminalMap));
        } catch (err) {
            console.warn('[PtyFleetService] Failed to update terminal registry state:', err);
        }
    }

    public disposeAll(): void {
        for (const [name, handle] of Array.from(this.terminals.entries())) {
            try {
                handle.kill();
            } catch { /* ignore */ }
        }
        this.terminals.clear();
        this.updateRegistryState();
    }

    private setupShutdownHandlers(): void {
        const cleanup = () => {
            this.disposeAll();
        };
        process.once('SIGINT', cleanup);
        process.once('SIGTERM', cleanup);
        process.once('exit', cleanup);
    }

    public static syncPurgePtyTerminals(db: KanbanDatabase): void {
        try {
            const raw = db.getConfigValue('runtime.terminals');
            if (!raw) return;
            const parsed = JSON.parse(raw);
            let modified = false;
            if (typeof parsed === 'object' && parsed !== null) {
                for (const key of Object.keys(parsed)) {
                    const item = parsed[key];
                    if (item && (item.purpose === 'pty' || item.ideName === 'standalone-pty')) {
                        delete parsed[key];
                        modified = true;
                    }
                }
            }
            if (modified) {
                db.setConfigValue('runtime.terminals', JSON.stringify(parsed));
            }
        } catch (err) {
            console.warn('[PtyFleetService] Failed to purge PTY terminals on boot:', err);
        }
    }
}
