import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { KanbanDatabase, WorkspaceDatabaseMapping } from './KanbanDatabase';

/**
 * A mapping augmented with in-memory provenance and per-mapping enablement.
 * These fields are attached at collection time in `buildMappingIndexFromDbs`
 * and are NEVER written back to `workspace_mappings` — they exist so the
 * call-site scope filter can tell a mapping authored in this repo from one
 * scavenged out of an unrelated repo's DB, and so a disabled DB's mappings are
 * not switched on by a sibling folder in the same VS Code window.
 */
type MappingWithProvenance = WorkspaceDatabaseMapping & {
    sourceFolder?: string;
    _enabled?: boolean;
};

// Module-level cache for mapping lookups
let _mappingCache: Map<string, string> | null = null;
let _mappingIndex: Map<string, string> | null = null;
let _mappingsDocument: { enabled: boolean; mappings: MappingWithProvenance[] } | null = null;

// Module-level host workspace roots (injected by extension / standalone host)
// null: unset (gate disabled, backwards compatibility before index initialization)
// string[]: injected list of currently open host workspace roots (gate enabled)
let _hostRoots: string[] | null = null;

/**
 * Expand a `~`-prefixed path and resolve it to an absolute path, matching the
 * expansion used everywhere else in this module. Centralised here so the scope
 * filter and the existence check expand identically to `resolveParentsForTerminals`.
 */
export function expandAndResolve(p: string): string {
    return path.resolve(p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
}

/**
 * Sets the list of open workspace roots from the host (e.g. VS Code workspace folders).
 *
 * Used by the mapping resolver and index builder to ensure that child folders are only
 * redirected to parents that are actually open in the current host window/session.
 *
 * Passing `null` disables the openness gate (legacy behavior).
 * Passing an array (even empty `[]`) enables the openness gate.
 *
 * NOTE on KanbanDatabase instances:
 * Calling this function clears the mapping cache. Any previous KanbanDatabase instances
 * cached under an old redirected key are orphaned. After cache clearing and a root set change,
 * KanbanDatabase.forWorkspace(childRoot) resolves to childRoot (new key) and creates a fresh
 * instance. The old instance at parentRoot is orphaned and reclaimed by the 60s eviction sweep.
 */
export function setHostWorkspaceRoots(roots: string[] | null): void {
    if (roots === null) {
        _hostRoots = null;
    } else {
        _hostRoots = roots.map(expandAndResolve);
    }
    clearMappingCache();
}

/**
 * Checks whether a given path is an open host workspace root.
 * Returns true if the gate is disabled (_hostRoots === null) or if the path is in _hostRoots.
 */
export function isHostRoot(p: string): boolean {
    if (_hostRoots === null) {
        return true;
    }
    const resolved = expandAndResolve(p);
    return _hostRoots.includes(resolved);
}

/**
 * Resolves the database path for a workspace folder using the three-tier resolution:
 * 1. .switchboard/db-pointer file in the folder
 * 2. kanban.dbPath setting (via optional configReader callback)
 * 3. Default path: <folderPath>/.switchboard/kanban.db
 */
export function resolveWorkspaceDbPath(
    folderPath: string,
    getConfigDbPath?: (folderPath: string) => string | undefined
): string {
    const resolvedFolder = expandAndResolve(folderPath);

    // 1. Check for pointer file
    const pointerPath = KanbanDatabase.readDbPointer(resolvedFolder);
    if (pointerPath) {
        return pointerPath;
    }

    // 2. Check setting value via host config reader callback
    let settingValue = '';
    if (getConfigDbPath) {
        try {
            settingValue = String(getConfigDbPath(resolvedFolder) || '').trim();
        } catch {}
    }
    if (settingValue) {
        const expanded = (KanbanDatabase as any)._expandHome(settingValue);
        return path.isAbsolute(expanded) ? expanded : path.join(resolvedFolder, expanded);
    }

    // 3. Default path
    return path.join(resolvedFolder, '.switchboard', 'kanban.db');
}

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
 * Clears the mapping cache. Should be called when DB mappings change.
 */
export function clearMappingCache(): void {
    _mappingCache = null;
    _mappingIndex = null;
    _mappingsDocument = null;
}

export async function buildMappingIndexFromDbs(dbs: Map<string, KanbanDatabase>, outputChannel?: any): Promise<void> {
    const index = new Map<string, string>();
    const allMappings: MappingWithProvenance[] = [];

    const log = (msg: string) => {
        console.log(`[WorkspaceIdentityService] ${msg}`);
        try { outputChannel?.appendLine(`[WorkspaceIdentityService] ${msg}`); } catch {}
    };

    log(`buildMappingIndexFromDbs called with ${dbs.size} DB(s)`);

    for (const [parentPath, db] of dbs.entries()) {
        try {
            const dbReady = await db.ensureReady();
            log(`DB at ${path.basename(parentPath)}: ready=${dbReady}, dbPath=${db.dbPath}`);
            const result = await db.getWorkspaceMappings();
            log(`DB at ${path.basename(parentPath)}: enabled=${result.enabled}, mappings=${result.mappings?.length ?? 0}`);
            if (Array.isArray(result.mappings)) {
                for (const mapping of result.mappings) {
                    // Avoid duplicates in the combined list. Provenance
                    // (sourceFolder) determines which board a mapping belongs to
                    // under the scope filter, so it must prefer an ENABLED source:
                    // if a disabled foreign DB is iterated before the board's own
                    // enabled DB and both carry the same mapping id, the disabled
                    // DB's version would otherwise win on content AND sourceFolder,
                    // and the board's own mapping would carry a foreign
                    // sourceFolder — failing its own `source === boardRoot` scope
                    // test. So: on collision, when the existing entry is disabled
                    // and the incoming DB is enabled, replace the entry wholesale
                    // (data + sourceFolder) and set _enabled true. When the
                    // existing entry is already enabled, keep it and only OR the
                    // enabled flag onto it (an enabled source's provenance is
                    // authoritative).
                    const existing = allMappings.find(m => m.id === mapping.id);
                    if (existing) {
                        if (result.enabled && !existing._enabled) {
                            const idx = allMappings.indexOf(existing);
                            allMappings[idx] = { ...mapping, sourceFolder: parentPath, _enabled: true };
                            log(`Mapping id collision: '${mapping.id}' — replacing disabled entry (source ${existing.sourceFolder}) with enabled source (${parentPath})`);
                        } else {
                            if (result.enabled) { existing._enabled = true; }
                            log(`Mapping id collision: '${mapping.id}' found in multiple DBs — keeping enabled provenance (${existing.sourceFolder}), ORing enabled flag`);
                        }
                    } else {
                        allMappings.push({ ...mapping, sourceFolder: parentPath, _enabled: result.enabled });
                    }
                }
            }
        } catch (error) {
            log(`Error reading mappings from DB at ${parentPath}: ${error}`);
        }
    }

    // Populate the index per-mapping, gated on THAT mapping's enabled flag —
    // not a single global `anyEnabled`. A disabled DB's mappings must not
    // contribute path→parent entries just because a sibling DB is enabled.
    //
    // Two-pass precedence:
    // Pass A: children → parent, but only when isHostRoot(resolvedParent).
    for (const mapping of allMappings) {
        if (!mapping._enabled) continue;
        const parentEntry = mapping.parentFolder || (Array.isArray(mapping.workspaceFolders) && mapping.workspaceFolders.length > 0 ? mapping.workspaceFolders[0] : undefined);
        if (!parentEntry) continue;

        const resolvedParent = expandAndResolve(parentEntry);
        if (!isHostRoot(resolvedParent)) continue;

        // Children map to parent
        if (Array.isArray(mapping.workspaceFolders)) {
            for (const child of mapping.workspaceFolders) {
                const resolvedChild = expandAndResolve(child);
                index.set(resolvedChild, resolvedParent);
            }
        }
    }

    // Pass B: parents → self, unconditionally.
    // Pass B runs second so a folder that is both a parent and someone's child ends up mapped to itself.
    for (const mapping of allMappings) {
        if (!mapping._enabled) continue;
        const parentEntry = mapping.parentFolder || (Array.isArray(mapping.workspaceFolders) && mapping.workspaceFolders.length > 0 ? mapping.workspaceFolders[0] : undefined);
        if (!parentEntry) continue;

        const resolvedParent = expandAndResolve(parentEntry);
        // Parent maps to itself
        index.set(resolvedParent, resolvedParent);
    }

    // The aggregate enabled flag and the mappings list for existing callers
    // (getMappingsFromIndex) contain only ENABLED mappings — matching the
    // previous behaviour so the seven other consumers are untouched.
    const enabledMappings = allMappings.filter(m => m._enabled);
    const anyEnabled = enabledMappings.length > 0;

    _mappingIndex = index;
    _mappingsDocument = { enabled: anyEnabled, mappings: enabledMappings };

    // Also update _mappingCache for compatibility — a copy of the same index,
    // built from the same per-mapping gate.
    _mappingCache = new Map(index);

    console.log(`[WorkspaceIdentityService] Built mapping index with ${index.size} entries from DBs. Enabled mappings: ${enabledMappings.length}/${allMappings.length}. Enabled: ${anyEnabled}`);
}

export function getMappingsFromIndex(): { enabled: boolean; mappings: WorkspaceDatabaseMapping[] } {
    if (_mappingsDocument) {
        return _mappingsDocument;
    }

    // No index built yet — return empty defaults
    return { enabled: false, mappings: [] };
}

/**
 * Return the subset of the global mapping index that belongs to `boardRoot`'s
 * board — i.e. mappings this board OWNS, not mappings scavenged from an
 * unrelated repo's database that happens to be on disk in the same VS Code
 * window.
 *
 * A mapping qualifies when ANY of:
 *  - its `parentFolder` resolves to `boardRoot` (the board IS the parent);
 *  - `boardRoot` appears in its `workspaceFolders` (the board is a child);
 *  - its `sourceFolder` (provenance — the VS Code folder whose DB produced it)
 *    resolves to `boardRoot` (the mapping came from this board's own database).
 *
 * Mappings whose `parentFolder` does not exist on disk are pruned and logged —
 * a mapping pointing at a deleted/moved folder renders a permanent empty row
 * nobody can act on. The database row is NOT deleted: the folder may be on a
 * detached volume, and destroying user configuration to tidy a list is the
 * wrong trade.
 *
 * Returns `{ enabled, mappings }` in the same shape as `getMappingsFromIndex`
 * so it is a drop-in for `resolveParentsForTerminals` at the call site.
 * `enabled` is derived from the scoped set: `false` when no scoped mappings
 * survive the filter, which makes `resolveParentsForTerminals` fall back to the
 * single `workspace-root` parent — the correct outcome for a board with no
 * mappings of its own.
 */
export function getScopedMappingsForBoard(boardRoot?: string | string[]): { enabled: boolean; mappings: WorkspaceDatabaseMapping[] } {
    const doc = _mappingsDocument;
    if (!doc || !doc.enabled || !Array.isArray(doc.mappings) || doc.mappings.length === 0) {
        return { enabled: false, mappings: [] };
    }

    let rootList: string[] = [];
    if (boardRoot) {
        rootList = (Array.isArray(boardRoot) ? boardRoot : [boardRoot]).filter(Boolean);
    } else if (_hostRoots && _hostRoots.length > 0) {
        rootList = _hostRoots;
    }

    if (rootList.length === 0) {
        return { enabled: false, mappings: [] };
    }

    const resolvedBoardRoots = rootList.map(expandAndResolve);

    // Scope: a mapping qualifies when it is reachable from this board's own
    // workspace (or host roots) — parent, child, or source DB.
    const scoped = doc.mappings.filter(m => {
        const parent = m.parentFolder ? expandAndResolve(m.parentFolder) : null;
        const folders = (m.workspaceFolders || []).map(expandAndResolve);
        const source = (m as MappingWithProvenance).sourceFolder ? expandAndResolve((m as MappingWithProvenance).sourceFolder!) : null;
        if (parent && resolvedBoardRoots.includes(parent)) return true;
        if (folders.some(f => resolvedBoardRoots.includes(f))) return true;
        if (source && resolvedBoardRoots.includes(source)) return true;
        return false;
    });

    // Prune mappings whose parentFolder does not exist on disk. Do NOT delete
    // the row from the database — the folder may be on a detached volume.
    const existing = scoped.filter(m => {
        if (!m.parentFolder) return true; // nothing to check
        const parent = expandAndResolve(m.parentFolder);
        try {
            if (!fs.existsSync(parent)) {
                console.log(`[WorkspaceIdentityService] Pruning mapping '${m.id}' from sidebar — parentFolder does not exist: ${parent}`);
                return false;
            }
        } catch {
            // If the check itself fails, keep the mapping rather than pruning it
            // — a transient FS error should not hide a real workspace.
        }
        return true;
    });

    return { enabled: existing.length > 0, mappings: existing };
}

/**
 * Prune mappings whose `parentFolder` does not exist on disk. Used by the
 * standalone host, which reads mappings from a single DB (no foreign-workspace
 * scoping needed) but still benefits from the existence prune. The database
 * row is NOT deleted — the folder may be on a detached volume.
 */
export function pruneNonExistentMappings(mappings: WorkspaceDatabaseMapping[]): WorkspaceDatabaseMapping[] {
    return mappings.filter(m => {
        if (!m.parentFolder) return true;
        const parent = expandAndResolve(m.parentFolder);
        try {
            if (!fs.existsSync(parent)) {
                console.log(`[WorkspaceIdentityService] Pruning mapping '${m.id}' from sidebar — parentFolder does not exist: ${parent}`);
                return false;
            }
        } catch {
            // If the check itself fails, keep the mapping.
        }
        return true;
    });
}

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
 * Resolves the effective workspace root based on DB-stored mappings configuration.
 * If this workspace is part of a shared database mapping, returns the parent workspace root.
 * Uses memoization to avoid repeated lookups.
 */
export function resolveEffectiveWorkspaceRootFromMappings(workspaceRoot: string): string {
    // Check cache first
    const cached = getCachedMapping(workspaceRoot);
    if (cached !== undefined) {
        return cached;
    }

    try {
        const cfg = getMappingsFromIndex();

        if (!cfg?.enabled || !Array.isArray(cfg.mappings)) {
            setCachedMapping(workspaceRoot, workspaceRoot);
            return workspaceRoot;
        }

        const resolvedWorkspaceRoot = expandAndResolve(workspaceRoot);

        // Step 1: Scan ALL mappings for parentFolder === workspaceRoot.
        // On any hit, cache and return workspaceRoot (self).
        for (const mapping of cfg.mappings) {
            let parentEntry: string | undefined = mapping.parentFolder;
            if (!parentEntry && Array.isArray(mapping.workspaceFolders) && mapping.workspaceFolders.length > 0) {
                parentEntry = mapping.workspaceFolders[0];
            }
            if (!parentEntry) continue;

            const resolvedParent = expandAndResolve(parentEntry);
            if (resolvedParent === resolvedWorkspaceRoot) {
                setCachedMapping(workspaceRoot, workspaceRoot);
                return workspaceRoot;
            }
        }

        // Step 2: Scan ALL mappings for workspaceRoot in workspaceFolders.
        // On a hit, compute parent; return it ONLY IF isHostRoot(parent), otherwise continue scanning.
        for (const mapping of cfg.mappings) {
            if (!Array.isArray(mapping.workspaceFolders)) continue;

            const matchingIndex = mapping.workspaceFolders.findIndex((f: string) => {
                return expandAndResolve(f) === resolvedWorkspaceRoot;
            });

            if (matchingIndex !== -1) {
                let parentEntry: string | undefined = mapping.parentFolder;
                if (!parentEntry && mapping.workspaceFolders.length > 0) {
                    parentEntry = mapping.workspaceFolders[0];
                }
                if (!parentEntry) continue;

                const parentFolder = expandAndResolve(parentEntry);
                if (isHostRoot(parentFolder)) {
                    setCachedMapping(workspaceRoot, parentFolder);
                    return parentFolder;
                }
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
 * Reduces unnecessary filesystem churn when the DB and local file already agree.
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
        // Check if file already has the correct value
        let currentValue = '';
        try {
            currentValue = (await fs.promises.readFile(committedPath, 'utf8')).split('\n')[0]?.trim() ?? '';
        } catch {
            // File doesn't exist or can't be read - will create it
        }

        // Only write if different (prevents unnecessary writes and fs churn)
        if (currentValue !== workspaceId) {
            const dbPath = KanbanDatabase.forWorkspace(resolvedRoot).dbPath;
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
            await tryWriteCommittedWorkspaceIdIfDifferent(resolvedRoot, trimmed);
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
