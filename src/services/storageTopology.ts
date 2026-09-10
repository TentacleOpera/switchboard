/**
 * Storage Topology
 *
 * Defines the fundamental shape of Switchboard storage:
 * Three stores — Runtime, Board, Archive — derived from a single decision,
 * so the operator picks a target and never types a path.
 *
 * Supersedes the hot/cold file split.
 *
 * Invariants:
 * 1. Runtime: machine-local, per-machine, disposable, never leaves machine, zero remote sync.
 *    Holds ephemeral execution state: dispatch, liveness, worktrees.
 * 2. Board: authoritative active + windowed recent cards/features/projects/ticket links.
 *    Lives at chosen target (default ~/.switchboard/boards/<workspace-id>.db).
 * 3. Archive: append-only on-demand past window, separate database derived from target.
 *    Queried on-demand, never on default board read paths.
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import {
    resolveBoardDbPath,
    resolveArchiveDbPath,
    validateGlobalDbPath,
    ensureBoardsDir,
    ensureGlobalStoreDir,
    getGlobalStoreDir,
    validateWorkspaceIdForPath,
    ResolvedBoardDbPath,
} from './globalStore';
import { SHARED_TABLES, LOCAL_TABLES, SHARED_PLAN_COLUMNS, LOCAL_PLAN_COLUMNS } from './storageTiers';

export type StoreTier = 'runtime' | 'board' | 'archive';

export interface StoreTopologyDefinition {
    tier: StoreTier;
    description: string;
    holds: string;
    placement: string;
    replication: string;
    lifecycle: string;
    tables: readonly string[];
}

/**
 * Single source of truth for the 3-store specification.
 */
export const STORAGE_TOPOLOGY: Record<StoreTier, StoreTopologyDefinition> = {
    runtime: {
        tier: 'runtime',
        description: 'Machine-local disposable runtime execution state',
        holds: 'dispatch, liveness, worktrees, plan_runtime_state',
        placement: 'Always local, per-machine, disposable (~/.switchboard/boards/<workspace-id>.runtime.db or memory/local SQLite)',
        replication: 'Never leaves machine — zero remote sync',
        lifecycle: 'Disposable, safe to delete, re-derived on boot from live fleet',
        tables: LOCAL_TABLES,
    },
    board: {
        tier: 'board',
        description: 'Authoritative active and windowed recent board state',
        holds: 'active + windowed recent: cards, features, projects, ticket links, config',
        placement: 'The chosen target (default ~/.switchboard/boards/<workspace-id>.db or libSQL target)',
        replication: 'Replicated across machines or is local file',
        lifecycle: 'Authoritative durable board state',
        tables: SHARED_TABLES,
    },
    archive: {
        tier: 'archive',
        description: 'Cold past-the-window historical plan store',
        holds: 'dormant completed plans and historical metadata past hot window',
        placement: 'Derived from target, separate database (~/.switchboard/boards/<workspace-id>-archive.db)',
        replication: 'Not replicated in replica mode — queried on demand',
        lifecycle: 'Append-only on-demand past window, reversible/promoted on access',
        tables: SHARED_TABLES,
    },
};

export interface ResolvedStorageTopology {
    workspaceId: string;
    board: ResolvedBoardDbPath;
    archive: {
        path: string;
        source: 'explicit' | 'board_default';
    };
    runtime: {
        path: string;
        source: 'local_default';
    };
}

export interface StorageTopologyOptions {
    explicitPathOverride?: string;
    explicitArchivePath?: string;
}

/**
 * Resolve the storage topology for a workspace.
 * Derive Board and Archive paths from the target; Runtime is always local.
 */
export function resolveStorageTopology(
    workspaceId: string,
    options?: StorageTopologyOptions
): ResolvedStorageTopology {
    const safeId = validateWorkspaceIdForPath(workspaceId);

    // Board path resolution
    const board = resolveBoardDbPath(safeId, options?.explicitPathOverride);

    // Archive path resolution (derived from target or explicit override)
    const archivePath = resolveArchiveDbPath(safeId, options?.explicitArchivePath);
    const archiveSource: 'explicit' | 'board_default' = (options?.explicitArchivePath && options.explicitArchivePath.trim() !== '')
        ? 'explicit'
        : 'board_default';

    // Runtime path: always local machine, under boards directory
    ensureBoardsDir();
    const runtimePath = path.join(getGlobalStoreDir(), 'boards', `${safeId}.runtime.db`);
    const checkRuntime = validateGlobalDbPath(runtimePath);
    if (!checkRuntime.ok) {
        throw new Error(`[StorageTopology] Runtime database path failed validation: ${checkRuntime.reason}`);
    }

    return {
        workspaceId: safeId,
        board,
        archive: {
            path: archivePath,
            source: archiveSource,
        },
        runtime: {
            path: runtimePath,
            source: 'local_default',
        },
    };
}

/**
 * Validate an advanced path override if provided.
 * Refuses repository roots, git worktrees, and cloud sync keywords.
 */
export function validatePathOverride(targetPath: string): { ok: boolean; reason?: string } {
    if (!targetPath || !targetPath.trim()) {
        return { ok: false, reason: 'Path override cannot be empty.' };
    }
    const expanded = targetPath.trim().startsWith('~')
        ? path.join(os.homedir(), targetPath.trim().slice(1))
        : targetPath.trim();
    const resolved = path.resolve(expanded);

    // Check if target is inside a git repo/work tree
    let cur = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
        ? resolved
        : path.dirname(resolved);
    while (cur && cur !== path.dirname(cur)) {
        if (fs.existsSync(path.join(cur, '.git'))) {
            return {
                ok: false,
                reason: `Path override cannot be inside a git repository or work tree: ${cur}`,
            };
        }
        cur = path.dirname(cur);
    }

    return validateGlobalDbPath(resolved, { userSuppliedPath: targetPath.trim() });
}
