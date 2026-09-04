import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { WorkspaceDatabaseMapping } from './KanbanDatabase';
import { resolveBoardDbPath } from './globalStore';

/**
 * Expand a `~`-prefixed path and resolve it to an absolute path.
 */
export function expandAndResolve(p: string): string {
    return path.resolve(p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
}

/**
 * Host workspace roots openness gating (retired with single global database).
 */
export function setHostWorkspaceRoots(_roots: string[] | null): void {
    // No-op after consolidation
}

export function isHostRoot(_p: string): boolean {
    return true;
}

/**
 * Resolves the database path for a workspace folder.
 * One board per project: `~/.switchboard/boards/<workspace-id>.db`.
 */
export function resolveWorkspaceDbPath(
    folderPath: string,
    getConfigDbPath?: (folderPath: string) => string | undefined
): string {
    const explicit = getConfigDbPath ? getConfigDbPath(folderPath) : undefined;
    const wsId = readCommittedWorkspaceIdSync(folderPath)
        || readLegacyWorkspaceIdSync(folderPath)
        || crypto.createHash('sha256').update(path.resolve(folderPath)).digest('hex').slice(0, 12);
    return resolveBoardDbPath(wsId, explicit).path;
}

export function clearMappingCache(): void {
    // No-op
}

export async function buildMappingIndexFromDbs(_dbs: Map<string, any>, _outputChannel?: any): Promise<void> {
    // Retired with single global database in home store
}

export function getMappingsFromIndex(): { enabled: boolean; mappings: WorkspaceDatabaseMapping[] } {
    return { enabled: false, mappings: [] };
}

export function getScopedMappingsForBoard(_boardRoot?: string | string[]): { enabled: boolean; mappings: WorkspaceDatabaseMapping[] } {
    return { enabled: false, mappings: [] };
}

/**
 * Prune mappings whose `parentFolder` does not exist on disk.
 * Used for terminal parenting resolution.
 */
export function pruneNonExistentMappings(mappings: WorkspaceDatabaseMapping[]): WorkspaceDatabaseMapping[] {
    return mappings.filter(m => {
        if (!m.parentFolder) return true;
        const parent = expandAndResolve(m.parentFolder);
        try {
            if (!fs.existsSync(parent)) {
                return false;
            }
        } catch {
            // Keep on check failure
        }
        return true;
    });
}

/**
 * Resolve parent groups for terminals.
 * Keeps terminal parenting working when folder layout mappings are configured.
 */
export function resolveParentsForTerminals(
    cfg: { enabled: boolean; mappings: WorkspaceDatabaseMapping[] },
    fallbackRoot: string,
    terminals: Array<{ cwd?: string; [key: string]: any }>
): {
    parents: Array<{ id: string; name: string; parentFolder: string; workspaceFolders: string[] }>;
    parentMap: Map<string, string | null>;
} {
    const resolvedFallback = path.resolve(fallbackRoot.startsWith('~') ? path.join(os.homedir(), fallbackRoot.slice(1)) : fallbackRoot);
    const parents: Array<{ id: string; name: string; parentFolder: string; workspaceFolders: string[] }> = [];

    if (cfg.enabled && Array.isArray(cfg.mappings) && cfg.mappings.length > 0) {
        for (const m of cfg.mappings) {
            const parentEntry = m.parentFolder || (Array.isArray(m.workspaceFolders) && m.workspaceFolders.length > 0 ? m.workspaceFolders[0] : undefined);
            if (!parentEntry) continue;
            const resolvedParent = path.resolve(parentEntry.startsWith('~') ? path.join(os.homedir(), parentEntry.slice(1)) : parentEntry);
            const resolvedChildren = (m.workspaceFolders || []).map(f =>
                path.resolve(f.startsWith('~') ? path.join(os.homedir(), f.slice(1)) : f)
            );
            parents.push({
                id: m.id,
                name: m.name || path.basename(resolvedParent),
                parentFolder: resolvedParent,
                workspaceFolders: resolvedChildren,
            });
        }
    }

    if (parents.length === 0) {
        parents.push({
            id: 'workspace-root',
            name: path.basename(resolvedFallback),
            parentFolder: resolvedFallback,
            workspaceFolders: [],
        });
    }

    const parentMap = new Map<string, string | null>();

    for (const t of terminals) {
        if (!t.cwd) {
            parentMap.set(t.cwd || '', null);
            continue;
        }
        const resolvedCwd = path.resolve(t.cwd.startsWith('~') ? path.join(os.homedir(), t.cwd.slice(1)) : t.cwd);
        let bestMatch: { parentFolder: string; matchLength: number } | null = null;

        for (const p of parents) {
            const foldersToTest = [p.parentFolder, ...p.workspaceFolders];
            for (const f of foldersToTest) {
                if (resolvedCwd === f || resolvedCwd.startsWith(f + path.sep)) {
                    if (!bestMatch || f.length > bestMatch.matchLength) {
                        bestMatch = { parentFolder: p.parentFolder, matchLength: f.length };
                    }
                }
            }
        }

        parentMap.set(t.cwd, bestMatch ? bestMatch.parentFolder : null);
    }

    return { parents, parentMap };
}

/**
 * Resolves the effective workspace root.
 * Following consolidation, each workspace root is independent; the global database
 * holds all workspace states discriminated by workspace_id.
 */
export function resolveEffectiveWorkspaceRootFromMappings(workspaceRoot: string): string {
    return workspaceRoot;
}

const WORKSPACE_ID_PATTERN = /^[0-9a-f]{8,36}(?:-[0-9a-f]{4,})*$/i;
// Broader pattern for the canonical resolver: the id is now a filename component,
// so it must satisfy the path-join character class (`[A-Za-z0-9_-]{8,64}`), not
// just hex. A legacy `workspace_identity.json` id may not be a hash.
const CANONICAL_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

function isValidWorkspaceId(value: string): boolean {
    return WORKSPACE_ID_PATTERN.test(value) && value.length >= 8;
}

function isValidCanonicalId(value: string): boolean {
    return CANONICAL_ID_PATTERN.test(value)
        && !value.includes('/') && !value.includes('\\')
        && !value.includes('..') && !value.includes('\0');
}

/**
 * Read the committed `.switchboard/workspace-id` (line 1) synchronously.
 * Returns the trimmed value or '' when absent/invalid.
 */
function readCommittedWorkspaceIdSync(workspaceRoot: string): string {
    try {
        const committedPath = path.join(path.resolve(workspaceRoot), '.switchboard', 'workspace-id');
        const content = fs.readFileSync(committedPath, 'utf8');
        const firstLine = content.split('\n')[0]?.trim() ?? '';
        if (firstLine && isValidCanonicalId(firstLine)) return firstLine;
    } catch { /* absent */ }
    return '';
}

/**
 * Read the legacy `.switchboard/workspace_identity.json` synchronously.
 * Returns the workspaceId or '' when absent/invalid.
 */
function readLegacyWorkspaceIdSync(workspaceRoot: string): string {
    try {
        const legacyPath = path.join(path.resolve(workspaceRoot), '.switchboard', 'workspace_identity.json');
        const migratedPath = legacyPath + '.migrated.bak';
        const effectivePath = fs.existsSync(legacyPath) ? legacyPath
            : (fs.existsSync(migratedPath) ? migratedPath : null);
        if (effectivePath) {
            const data = JSON.parse(fs.readFileSync(effectivePath, 'utf8'));
            const id = typeof data?.workspaceId === 'string' ? data.workspaceId.trim() : '';
            if (id && isValidCanonicalId(id)) return id;
        }
    } catch { /* ignore */ }
    return '';
}

/**
 * The canonical workspace id resolver. This is the ONLY generator.
 *
 * Resolution order:
 * 1. Committed `.switchboard/workspace-id` (line 1) — repository state, PRIORITY 1.
 * 2. Legacy `workspace_identity.json` — written back to the committed file.
 * 3. `sha256(root).slice(0, 12)` — written back to the committed file.
 *
 * Returns `{value, source}` so "which source answered?" is answerable.
 */
export async function resolveCanonicalWorkspaceId(
    workspaceRoot: string
): Promise<{ value: string; source: 'committed_file' | 'legacy_json' | 'hash_fallback' }> {
    const resolvedRoot = path.resolve(workspaceRoot);

    // PRIORITY 1: committed file
    const committed = readCommittedWorkspaceIdSync(resolvedRoot);
    if (committed) {
        return { value: committed, source: 'committed_file' };
    }

    // PRIORITY 2: legacy workspace_identity.json
    const legacy = readLegacyWorkspaceIdSync(resolvedRoot);
    if (legacy) {
        await tryWriteCommittedWorkspaceIdIfDifferent(resolvedRoot, legacy);
        return { value: legacy, source: 'legacy_json' };
    }

    // PRIORITY 3: sha256(root).slice(0, 12)
    const hashId = crypto.createHash('sha256').update(resolvedRoot).digest('hex').slice(0, 12);
    await tryWriteCommittedWorkspaceIdIfDifferent(resolvedRoot, hashId);
    return { value: hashId, source: 'hash_fallback' };
}

/**
 * Synchronous variant for call sites that cannot await (e.g. path resolution
 * inside a constructor). Same resolution order, same generator.
 */
export function resolveCanonicalWorkspaceIdSync(
    workspaceRoot: string
): { value: string; source: 'committed_file' | 'legacy_json' | 'hash_fallback' } {
    const resolvedRoot = path.resolve(workspaceRoot);

    const committed = readCommittedWorkspaceIdSync(resolvedRoot);
    if (committed) return { value: committed, source: 'committed_file' };

    const legacy = readLegacyWorkspaceIdSync(resolvedRoot);
    if (legacy) return { value: legacy, source: 'legacy_json' };

    const hashId = crypto.createHash('sha256').update(resolvedRoot).digest('hex').slice(0, 12);
    return { value: hashId, source: 'hash_fallback' };
}

export async function tryWriteCommittedWorkspaceId(workspaceRoot: string, workspaceId: string): Promise<void> {
    const resolvedRoot = path.resolve(workspaceRoot);
    const switchboardDir = path.join(resolvedRoot, '.switchboard');
    try {
        const stat = await fs.promises.stat(switchboardDir);
        if (!stat.isDirectory()) return;
    } catch {
        return;
    }

    const committedPath = path.join(switchboardDir, 'workspace-id');
    try {
        await fs.promises.writeFile(committedPath, `${workspaceId}\n`, { flag: 'wx' });
    } catch (error: any) {
        if (error?.code !== 'EEXIST') {
            console.warn('[WorkspaceIdentityService] Failed to write workspace-id file:', error);
        }
    }
}

/**
 * Writes the workspace ID to the committed file only if it's different from the current value.
 * Stores only the workspace UUID on one line.
 */
async function tryWriteCommittedWorkspaceIdIfDifferent(
    workspaceRoot: string,
    workspaceId: string
): Promise<void> {
    const resolvedRoot = path.resolve(workspaceRoot);
    const switchboardDir = path.join(resolvedRoot, '.switchboard');
    try {
        const stat = await fs.promises.stat(switchboardDir);
        if (!stat.isDirectory()) return;
    } catch {
        return;
    }

    const committedPath = path.join(switchboardDir, 'workspace-id');
    try {
        let currentValue = '';
        try {
            currentValue = (await fs.promises.readFile(committedPath, 'utf8')).split('\n')[0]?.trim() ?? '';
        } catch {
            // File doesn't exist or can't be read
        }

        if (currentValue !== workspaceId) {
            await fs.promises.writeFile(committedPath, `${workspaceId}\n`);
        }
    } catch (error: any) {
        if (error?.code !== 'EEXIST') {
            console.warn('[WorkspaceIdentityService] Failed to write workspace-id file:', error);
        }
    }
}

/**
 * Ensure workspace identity: the repository holds identity, the home store holds state.
 * Returns the stable workspace identifier, writing .switchboard/workspace-id if absent.
 *
 * Delegates to `resolveCanonicalWorkspaceId` — the single generator.
 */
export async function ensureWorkspaceIdentity(workspaceRoot: string): Promise<string> {
    const { value } = await resolveCanonicalWorkspaceId(workspaceRoot);
    return value;
}
