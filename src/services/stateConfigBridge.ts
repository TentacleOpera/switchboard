import * as originalFs from 'fs';
import { KanbanDatabase } from './KanbanDatabase';

/**
 * Bridge that redirects legacy `.switchboard/state.json` reads/writes to the
 * kanban.db `config` table. state.json no longer exists on disk; the ~40
 * legacy call sites that still speak "read/write state.json" go through this
 * facade until they are individually converted to direct db calls.
 *
 * Single source of truth for the state-key → config-key mapping. Keys absent
 * from this map are intentionally dropped (they have dedicated db keys or are
 * dead) — add here AND in KanbanDatabase._runConfigMigrations when a new
 * state key appears.
 */
export const STATE_KEY_TO_CONFIG: Record<string, string> = {
    customKanbanColumns: 'kanban.customColumns',
    customAgents: 'agents.customAgents',
    startupCommands: 'agents.startupCommands',
    visibleAgents: 'agents.visibleAgents',
    defaultPromptOverrides: 'agents.promptOverrides',
    liveSyncConfig: 'planning.liveSyncConfig',
    julesAutoSyncEnabled: 'agents.julesAutoSyncEnabled',
    autoCommitOnCodeReview: 'kanban.autoCommitOnCodeReview',
    planIngestionFolder: 'planning.ingestionFolder',
    autoban: 'runtime.autoban',
    terminals: 'runtime.terminals',
    chatAgents: 'runtime.chatAgents',
    session: 'runtime.session',
    tasks: 'runtime.tasks',
    context: 'runtime.context',
    teams: 'runtime.teams',
    julesSessions: 'runtime.jules',
    julesPollingDegraded: 'runtime.julesPollingDegraded',
    julesPollingLastCheckedAt: 'runtime.julesPollingLastCheckedAt',
    julesPollingDegradedAt: 'runtime.julesPollingDegradedAt',
};

/** Keys synthesized with a non-undefined default so consumers can iterate. */
const CONTAINER_DEFAULTS: Record<string, unknown> = {
    terminals: {},
    chatAgents: {},
    session: {},
    context: {},
    teams: {},
    tasks: [],
    julesSessions: [],
};

export function getWorkspaceRootFromStatePath(filePath: unknown): string | null {
    if (typeof filePath !== 'string') return null;
    const normalized = filePath.replace(/\\/g, '/');
    if (normalized.endsWith('/.switchboard/state.json')) {
        return normalized.split('/.switchboard/state.json')[0];
    }
    return null;
}

function synthesizeStateJson(db: KanbanDatabase): string {
    const state: Record<string, unknown> = {};
    for (const [stateKey, configKey] of Object.entries(STATE_KEY_TO_CONFIG)) {
        const value = db.getConfigJsonSync(configKey, CONTAINER_DEFAULTS[stateKey]);
        if (value !== undefined) {
            state[stateKey] = value;
        }
    }
    return JSON.stringify(state, null, 2);
}

async function writeStateToDb(db: KanbanDatabase, content: string): Promise<void> {
    const state = JSON.parse(content);
    for (const [stateKey, configKey] of Object.entries(STATE_KEY_TO_CONFIG)) {
        if (state[stateKey] !== undefined) {
            await db.setConfigJson(configKey, state[stateKey]);
        }
    }
}

/**
 * fs facade: state.json paths hit the db, everything else passes through.
 * Async variants await db readiness; sync reads on a not-yet-opened db return
 * defaults (callers must warm the db first — extension.activate does).
 */
export const stateFs: any = {
    ...originalFs,
    existsSync(filePath: string): boolean {
        if (getWorkspaceRootFromStatePath(filePath)) return true;
        return originalFs.existsSync(filePath);
    },
    promises: {
        ...originalFs.promises,
        async access(filePath: string, mode?: number): Promise<void> {
            if (getWorkspaceRootFromStatePath(filePath)) return;
            return originalFs.promises.access(filePath, mode);
        },
        async readFile(filePath: string, options?: any): Promise<any> {
            const root = getWorkspaceRootFromStatePath(filePath);
            if (root) {
                const db = KanbanDatabase.forWorkspace(root);
                await db.ensureReady();
                return synthesizeStateJson(db);
            }
            return originalFs.promises.readFile(filePath, options);
        },
        async writeFile(filePath: string, content: any, options?: any): Promise<void> {
            const root = getWorkspaceRootFromStatePath(filePath);
            if (root) {
                const db = KanbanDatabase.forWorkspace(root);
                await db.ensureReady();
                return writeStateToDb(db, String(content));
            }
            return originalFs.promises.writeFile(filePath, content, options);
        },
    },
    readFileSync(filePath: any, options?: any): any {
        const root = getWorkspaceRootFromStatePath(filePath);
        if (root) {
            const db = KanbanDatabase.forWorkspace(root);
            if (!db.isOpen()) {
                console.warn('[stateConfigBridge] Sync state read before db ready — returning defaults');
            }
            return synthesizeStateJson(db);
        }
        return originalFs.readFileSync(filePath, options);
    },
    writeFileSync(filePath: any, content: any, options?: any): void {
        const root = getWorkspaceRootFromStatePath(filePath);
        if (root) {
            const db = KanbanDatabase.forWorkspace(root);
            void db.ensureReady()
                .then(() => writeStateToDb(db, String(content)))
                .catch((err: unknown) => console.error('[stateConfigBridge] Sync state write failed:', err));
            return;
        }
        return originalFs.writeFileSync(filePath, content, options);
    },
};

/**
 * No-op replacement for proper-lockfile. Within one extension host, db writes
 * serialize through the single KanbanDatabase instance. Note: the db layer is
 * sql.js (in-memory, whole-file persist), so two VS Code windows on the same
 * workspace are last-writer-wins — the same exposure kanban data has always
 * had; the old lockfile only protected the state.json slice of it.
 */
export const stateLockfile = {
    lock: async (..._args: any[]): Promise<() => Promise<void>> => async () => {},
    unlock: async (..._args: any[]): Promise<void> => {},
};
