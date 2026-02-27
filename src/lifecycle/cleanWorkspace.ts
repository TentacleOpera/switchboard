import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as lockfile from 'proper-lockfile';

/** Transient directories that are safe to wipe on activation. */
const TRANSIENT_DIRS = ['inbox', 'outbox', 'cooldowns'];

/** Transient files that are safe to delete on activation. */
const TRANSIENT_FILES = ['bridge_debug.log'];

/**
 * Canonical initial state matching state-manager.js INITIAL_STATE.
 * Resetting to this guarantees no zombie PIDs survive across sessions.
 */
const INITIAL_STATE = {
    session: {
        id: null,
        activeWorkflow: null,
        suspendedWorkflows: [],
        status: "IDLE",
        startTime: null,
        activePersona: null,
        currentStep: 0,
        activeWorkflowPhase: 0
    },
    context: {},
    tasks: [],
    terminals: {},
    chatAgents: {},
    teams: {}
};

async function removeDirRecursive(dirPath: string): Promise<void> {
    try {
        await fs.promises.rm(dirPath, { recursive: true, force: true });
    } catch {
        // Directory may not exist — ignore
    }
}

async function removeFile(filePath: string): Promise<void> {
    try {
        await fs.promises.unlink(filePath);
    } catch {
        // File may not exist — ignore
    }
}

/**
 * Reads persisted fields from existing state.json that must survive resets.
 */
async function readPersistedFields(statePath: string): Promise<Record<string, unknown>> {
    const persisted: Record<string, unknown> = {};
    try {
        const content = await fs.promises.readFile(statePath, 'utf8');
        const state = JSON.parse(content);
        if (state.startupCommands && typeof state.startupCommands === 'object') {
            persisted.startupCommands = state.startupCommands;
        }
        // NOTE: terminals are intentionally NOT preserved across resets.
        // Stale terminal entries cause orphan persistence and sidebar ghosts.
    } catch {
        // File missing or corrupt — nothing to preserve
    }
    return persisted;
}

/**
 * Resets state.json to INITIAL_STATE using proper-lockfile for concurrency safety.
 * Preserves user-configured fields (e.g. startupCommands) across resets.
 */
export async function resetStateFile(statePath: string): Promise<void> {
    const dir = path.dirname(statePath);
    await fs.promises.mkdir(dir, { recursive: true });

    // Ensure the file exists before locking (proper-lockfile requires it)
    if (!fs.existsSync(statePath)) {
        await fs.promises.writeFile(statePath, JSON.stringify(INITIAL_STATE, null, 2));
        return;
    }

    const persisted = await readPersistedFields(statePath);

    let release: (() => Promise<void>) | undefined;
    try {
        release = await lockfile.lock(statePath, {
            retries: { retries: 3, minTimeout: 200, maxTimeout: 1000 },
            stale: 10000
        });
        const newState = { ...INITIAL_STATE, ...persisted };
        await fs.promises.writeFile(statePath, JSON.stringify(newState, null, 2));
    } finally {
        if (release) {
            await release();
        }
    }
}

function isProcessAlive(pid: number): boolean {
    if (!Number.isFinite(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

/**
 * Prunes terminal entries whose tracked PIDs are no longer alive.
 * Unlike resetStateFile(), this preserves active sessions and all other state.
 */
export async function pruneZombieTerminalEntries(statePath: string): Promise<number> {
    const dir = path.dirname(statePath);
    await fs.promises.mkdir(dir, { recursive: true });
    if (!fs.existsSync(statePath)) return 0;

    let release: (() => Promise<void>) | undefined;
    try {
        release = await lockfile.lock(statePath, {
            retries: { retries: 3, minTimeout: 200, maxTimeout: 1000 },
            stale: 10000
        });

        const content = await fs.promises.readFile(statePath, 'utf8');
        const state = JSON.parse(content);
        const terminals = state.terminals && typeof state.terminals === 'object' ? state.terminals : {};

        let pruned = 0;
        for (const [name, info] of Object.entries(terminals) as [string, any][]) {
            const pid = Number(info?.pid);
            const childPid = Number(info?.childPid);
            const hasPid = Number.isFinite(pid) && pid > 0;
            const hasChildPid = Number.isFinite(childPid) && childPid > 0;

            // If no PID metadata exists, keep the entry (cannot prove it's stale).
            if (!hasPid && !hasChildPid) continue;

            const pidAlive = hasPid ? isProcessAlive(pid) : false;
            const childAlive = hasChildPid ? isProcessAlive(childPid) : false;

            if (!pidAlive && !childAlive) {
                delete terminals[name];
                pruned++;
            }
        }

        if (pruned > 0) {
            state.terminals = terminals;
            await fs.promises.writeFile(statePath, JSON.stringify(state, null, 2));
        }
        return pruned;
    } finally {
        if (release) {
            await release();
        }
    }
}

/**
 * Runs workspace cleanup during extension activation.
 * Deletes transient directories/files and resets state.json to a clean slate.
 * Safe to call on every activation — only touches ephemeral data.
 *
 * @param workspaceRoot Absolute path to the workspace root
 * @param outputChannel Optional output channel for logging
 */
export async function cleanWorkspace(
    workspaceRoot: string,
    outputChannel?: vscode.OutputChannel
): Promise<void> {
    const switchboardDir = path.join(workspaceRoot, '.switchboard');

    // Bail out if .switchboard doesn't exist yet (first-run)
    if (!fs.existsSync(switchboardDir)) {
        return;
    }

    const log = (msg: string) => outputChannel?.appendLine(`[CleanWorkspace] ${msg}`);
    log('Starting workspace cleanup...');

    // 1. Delete transient directories
    const dirDeletions = TRANSIENT_DIRS.map(dir => {
        const dirPath = path.join(switchboardDir, dir);
        log(`Removing ${dir}/`);
        return removeDirRecursive(dirPath);
    });

    // 2. Delete transient files
    const fileDeletions = TRANSIENT_FILES.map(file => {
        const filePath = path.join(switchboardDir, file);
        log(`Removing ${file}`);
        return removeFile(filePath);
    });

    // 3. Reset state.json
    const statePath = path.join(switchboardDir, 'state.json');
    log('Resetting state.json to initial state');
    const stateReset = resetStateFile(statePath);

    // Run all operations concurrently
    await Promise.all([...dirDeletions, ...fileDeletions, stateReset]);

    log('Workspace cleanup complete.');
}
