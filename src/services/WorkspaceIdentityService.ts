import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { KanbanDatabase } from './KanbanDatabase';

// Module-level cache for mapping lookups
let _mappingCache: Map<string, string> | null = null;

function getCachedMapping(workspaceRoot: string): string | undefined {
    return _mappingCache?.get(workspaceRoot);
}

function setCachedMapping(workspaceRoot: string, effectiveRoot: string): void {
    if (!_mappingCache) {
        _mappingCache = new Map();
    }
    _mappingCache.set(workspaceRoot, effectiveRoot);
}

/**
 * Clears the mapping cache. Should be called when workspaceDatabaseMappings config changes.
 */
export function clearMappingCache(): void {
    _mappingCache = null;
}

/**
 * Resolves the effective workspace root based on workspaceDatabaseMappings configuration.
 * If this workspace is part of a shared database mapping, returns the parent workspace root.
 * Uses memoization to avoid repeated VS Code config API calls.
 */
function resolveEffectiveWorkspaceRootFromMappings(workspaceRoot: string): string {
    // Check cache first
    const cached = getCachedMapping(workspaceRoot);
    if (cached !== undefined) {
        return cached;
    }

    try {
        const vscode = require('vscode');
        const cfg = vscode.workspace.getConfiguration('switchboard')
                         .get('workspaceDatabaseMappings') as
            { enabled?: boolean; mappings?: Array<{ workspaceFolders: string[]; parentFolder?: string }> } | undefined;

        if (!cfg?.enabled || !Array.isArray(cfg.mappings)) {
            setCachedMapping(workspaceRoot, workspaceRoot);
            return workspaceRoot;
        }

        // workspaceRoot is already resolved by caller

        // Check if this workspace root is in any mapping (as child OR as parent)
        for (const mapping of cfg.mappings) {
            if (!Array.isArray(mapping.workspaceFolders)) continue;

            // Check if this root IS the parent folder
            let isParent = false;
            if (mapping.parentFolder) {
                const expandedParent = mapping.parentFolder.startsWith('~')
                    ? path.join(os.homedir(), mapping.parentFolder.slice(1))
                    : mapping.parentFolder;
                isParent = path.resolve(expandedParent) === workspaceRoot;
            }

            // Find if this root is listed as a child in the mapping
            const matchingIndex = mapping.workspaceFolders.findIndex((f: string) => {
                const expanded = f.startsWith('~')
                    ? path.join(os.homedir(), f.slice(1))
                    : f;
                return path.resolve(expanded) === workspaceRoot;
            });

            if (isParent || matchingIndex !== -1) {
                // This root is part of this mapping - return the parent folder
                let parentEntry: string | undefined;
                if (mapping.parentFolder) {
                    parentEntry = mapping.parentFolder;
                } else if (mapping.workspaceFolders.length > 0) {
                    parentEntry = mapping.workspaceFolders[0];
                }

                if (!parentEntry) continue;

                const parentFolder = path.resolve(
                    parentEntry.startsWith('~')
                        ? path.join(os.homedir(), parentEntry.slice(1))
                        : parentEntry
                );

                // Return parent folder (even if it's the same as workspaceRoot, for DB path resolution)
                setCachedMapping(workspaceRoot, parentFolder);
                return parentFolder;
            }
        }
    } catch {
        // Outside extension host - can't read settings
    }

    setCachedMapping(workspaceRoot, workspaceRoot);
    return workspaceRoot;
}

const WORKSPACE_ID_PATTERN = /^[0-9a-f]{8,36}(?:-[0-9a-f]{4,})*$/i;

function isValidWorkspaceId(value: string): boolean {
    return WORKSPACE_ID_PATTERN.test(value) && value.length >= 8;
}

export async function tryWriteCommittedWorkspaceId(workspaceRoot: string, workspaceId: string): Promise<void> {
    const committedPath = path.join(path.resolve(workspaceRoot), '.switchboard', 'workspace-id');
    try {
        await fs.promises.mkdir(path.dirname(committedPath), { recursive: true });
        await fs.promises.writeFile(committedPath, `${workspaceId}\n`, { flag: 'wx' });
    } catch (error: any) {
        if (error?.code !== 'EEXIST') {
            console.warn('[WorkspaceIdentityService] Failed to write workspace-id file:', error);
        }
    }
}

/**
 * Writes the workspace ID to the committed file only if it's different from the current value.
 * Reduces unnecessary filesystem churn when the DB and local file already agree.
 */
async function tryWriteCommittedWorkspaceIdIfDifferent(
    workspaceRoot: string,
    workspaceId: string
): Promise<void> {
    const committedPath = path.join(path.resolve(workspaceRoot), '.switchboard', 'workspace-id');
    try {
        // Check if file already has the correct value
        let currentValue = '';
        try {
            currentValue = (await fs.promises.readFile(committedPath, 'utf8')).split('\n')[0]?.trim() ?? '';
        } catch {
            // File doesn't exist or can't be read - will create it
        }

        // Only write if different (prevents unnecessary writes and fs churn)
        if (currentValue !== workspaceId) {
            await fs.promises.mkdir(path.dirname(committedPath), { recursive: true });
            const dbPath = KanbanDatabase.forWorkspace(path.resolve(workspaceRoot)).dbPath;
            await fs.promises.writeFile(committedPath, `${workspaceId}\n${dbPath}\n`);
        }
    } catch (error: any) {
        if (error?.code !== 'EEXIST') {
            console.warn('[WorkspaceIdentityService] Failed to write workspace-id file:', error);
        }
    }
}

export async function ensureWorkspaceIdentity(workspaceRoot: string): Promise<string> {
    const resolvedRoot = path.resolve(workspaceRoot);
    const committedPath = path.join(resolvedRoot, '.switchboard', 'workspace-id');
    const legacyPath = path.join(resolvedRoot, '.switchboard', 'workspace_identity.json');
    const db = KanbanDatabase.forWorkspace(resolvedRoot);
    const dbReady = await db.ensureReady();

    // PRIORITY 0: Check workspaceDatabaseMappings - use parent identity if mapped
    const effectiveRoot = resolveEffectiveWorkspaceRootFromMappings(resolvedRoot);
    if (effectiveRoot !== resolvedRoot) {
        console.log(`[WorkspaceIdentityService] ${resolvedRoot} maps to parent ${effectiveRoot} - using parent's identity`);
        // Return parent's ID without creating local file in child folder
        return ensureWorkspaceIdentity(effectiveRoot);
    }

    // PRIORITY 1: Use workspace_id from DB config (supports shared databases)
    if (dbReady) {
        const stored = await db.getWorkspaceId();
        if (stored) {
            await tryWriteCommittedWorkspaceIdIfDifferent(resolvedRoot, stored);
            return stored;
        }
    }

    // PRIORITY 2: Check local workspace-id file (backward compatibility, first-time setup)
    try {
        const fileContent = await fs.promises.readFile(committedPath, 'utf8');
        const lines = fileContent.split('\n');
        const trimmed = (lines[0] ?? '').trim();
        if (isValidWorkspaceId(trimmed)) {
            if (dbReady) {
                await db.setWorkspaceId(trimmed);
            }
            return trimmed;
        }
    } catch {
        // File does not exist or is unreadable - continue to fallback
    }

    // PRIORITY 3: Use dominant workspace_id from existing plans (migration support)
    if (dbReady) {
        const dominant = await db.getDominantWorkspaceId();
        if (dominant) {
            await db.setWorkspaceId(dominant);
            await tryWriteCommittedWorkspaceIdIfDifferent(resolvedRoot, dominant);
            return dominant;
        }
    }

    // PRIORITY 4: Legacy workspace_identity.json file
    try {
        if (fs.existsSync(legacyPath)) {
            const data = JSON.parse(await fs.promises.readFile(legacyPath, 'utf8'));
            const legacyWorkspaceId = typeof data?.workspaceId === 'string' ? data.workspaceId.trim() : '';
            if (isValidWorkspaceId(legacyWorkspaceId)) {
                if (dbReady) {
                    await db.setWorkspaceId(legacyWorkspaceId);
                }
                await tryWriteCommittedWorkspaceIdIfDifferent(resolvedRoot, legacyWorkspaceId);
                return legacyWorkspaceId;
            }
        }
    } catch (error) {
        console.error('[WorkspaceIdentityService] Failed to read legacy workspace identity:', error);
    }

    // PRIORITY 5: Generate new ID from workspace root hash
    const hashId = crypto.createHash('sha256').update(resolvedRoot).digest('hex').slice(0, 12);
    if (dbReady) {
        await db.setWorkspaceId(hashId);
    }
    await tryWriteCommittedWorkspaceIdIfDifferent(resolvedRoot, hashId);
    return hashId;
}
