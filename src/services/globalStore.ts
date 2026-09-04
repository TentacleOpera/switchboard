import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { stateHome } from '../utils/stateHome';

export interface ResolvedDbPath {
    path: string;
    source: 'env' | 'global_default' | 'explicit';
}

export interface ResolvedBoardDbPath {
    path: string;
    source: 'env' | 'explicit' | 'board_default';
}

/**
 * Strict character class for a workspace id used as a filename component.
 * A crafted `.switchboard/workspace-id` containing `../`, a path separator, or
 * a null byte must not escape the boards directory. The id is read from a
 * repository file, so it is untrusted input at the path-join boundary.
 */
const WORKSPACE_ID_FILENAME_RE = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Validate a workspace id before joining it into a path under the boards dir.
 * Returns the trimmed id when valid, throws otherwise.
 */
export function validateWorkspaceIdForPath(workspaceId: string): string {
    const trimmed = (workspaceId || '').trim();
    if (!trimmed) {
        throw new Error('[GlobalStore] Workspace id is empty — cannot resolve a board path.');
    }
    if (!WORKSPACE_ID_FILENAME_RE.test(trimmed)) {
        throw new Error(
            `[GlobalStore] Workspace id '${trimmed}' contains characters outside [A-Za-z0-9_-] or is outside the 8–64 length range — refusing to join into a path.`
        );
    }
    // Reject path separators and null bytes explicitly even if the regex missed them.
    if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('\0') || trimmed.includes('..')) {
        throw new Error(`[GlobalStore] Workspace id '${trimmed}' contains a path separator or traversal — refusing to join into a path.`);
    }
    return trimmed;
}

const CLOUD_SYNC_KEYWORDS = [
    'dropbox',
    'onedrive',
    'icloud',
    'google drive',
    'googledrive',
    'nextcloud',
    'owncloud',
    'box sync',
];

/**
 * Track which resolved paths have already been logged so the {path, source}
 * tagging is emitted once per process, not on every resolution call. The
 * fallback rule requires that "which store answered?" is answerable after the
 * fact — logging once per distinct path satisfies that without flooding the
 * log on repeated lookups.
 */
const _loggedPathResolutions = new Set<string>();

/**
 * Log a resolved {path, source} pair once per distinct path per process.
 * Answers "which store answered?" after the fact — the project's fallback rule.
 */
function _logPathResolution(resolvedPath: string, source: string): void {
    if (_loggedPathResolutions.has(resolvedPath)) return;
    _loggedPathResolutions.add(resolvedPath);
    console.log(`[GlobalStore] Resolved DB path: ${resolvedPath} (source=${source})`);
}

/**
 * Returns the directory path for global machine storage (~/.switchboard).
 *
 * Resolved through `stateHome()`, NOT `os.homedir()` directly. `stateHome()` is the
 * repo's single home-store accessor: it honours `SWITCHBOARD_STATE_HOME` and it
 * deliberately THROWS in a test process rather than touching the developer's real
 * `~/.switchboard`. Reading `os.homedir()` here bypassed both — so every test that
 * opened the global store wrote to the real home, which made the suites mutate the
 * developer's (and CI runner's) actual board and made them order-dependent on each
 * other. The global store is the last place that should be exempt from the
 * home-store accessor, since it IS the home store.
 */
export function getGlobalStoreDir(): string {
    return path.join(stateHome(), '.switchboard');
}

/**
 * Validate that target path is not inside a git work tree or cloud-synced folder.
 * Refuses paths inside git repositories to prevent committing machine state.
 *
 * The cloud-sync check applies to **user-supplied path segments** only, not to
 * every character of the resolved absolute path. A home directory or username
 * containing `dropbox`, `box sync`, `icloud` etc. must not fail the default path
 * (which lives under `~/.switchboard/`), because `resolveGlobalDbPath()` throws
 * on a failed default and the board never opens. Pass `userSuppliedPath` for
 * explicit/env paths so the segments the user chose are checked; omit it for
 * default paths so the check is skipped.
 */
export function validateGlobalDbPath(
    targetPath: string,
    options?: { userSuppliedPath?: string }
): { ok: boolean; reason?: string } {
    const resolved = path.resolve(targetPath);

    // Cloud-sync check: match against individual path segments the user chose,
    // not against the full resolved path as a substring. A username like
    // `dropbox-user` is a segment that does not equal `dropbox`, so it passes;
    // a folder literally named `Dropbox` is a segment that does, so it fails.
    if (options?.userSuppliedPath) {
        const segments = options.userSuppliedPath.split(/[\/\\]/).filter(s => s.length > 0);
        for (const segment of segments) {
            const lowerSeg = segment.toLowerCase();
            for (const kw of CLOUD_SYNC_KEYWORDS) {
                if (lowerSeg === kw) {
                    return {
                        ok: false,
                        reason: `Global database path cannot be inside cloud-synced folder segment '${segment}' (matched '${kw}'): ${resolved}`,
                    };
                }
            }
        }
    }

    // Traverse upwards checking for .git (file or directory), but STOP at the home
    // directory. A dotfiles repo at $HOME is common, and without this boundary the
    // DEFAULT path (~/.switchboard/switchboard.db) fails validation on those
    // machines — and resolveGlobalDbPath() throws on a failed default, so the board
    // never opens at all. The rule this check exists to enforce is "the database is
    // not inside a project checkout"; a repo at or above $HOME is not that.
    // The same home the store itself resolves against, so the boundary below lines up
    // with getGlobalStoreDir() under SWITCHBOARD_STATE_HOME as well as in production.
    const home = path.resolve(stateHome());
    let cur = path.dirname(resolved);
    while (cur && cur !== path.dirname(cur)) {
        if (cur === home || !cur.startsWith(home + path.sep)) {
            break;
        }
        const gitEntry = path.join(cur, '.git');
        if (fs.existsSync(gitEntry)) {
            return {
                ok: false,
                reason: `Global database path cannot be inside a git work tree at '${cur}': ${resolved}`,
            };
        }
        cur = path.dirname(cur);
    }

    // A path outside the home tree still gets the full upward walk — that is where
    // a deliberate relocation into a project checkout would land.
    if (!resolved.startsWith(home + path.sep) && resolved !== home) {
        let outside = path.dirname(resolved);
        while (outside && outside !== path.dirname(outside)) {
            const gitEntry = path.join(outside, '.git');
            if (fs.existsSync(gitEntry)) {
                return {
                    ok: false,
                    reason: `Global database path cannot be inside a git work tree at '${outside}': ${resolved}`,
                };
            }
            outside = path.dirname(outside);
        }
    }

    return { ok: true };
}

/**
 * Ensure ~/.switchboard directory exists with mode 0700.
 */
export function ensureGlobalStoreDir(): string {
    const storeDir = getGlobalStoreDir();
    if (!fs.existsSync(storeDir)) {
        fs.mkdirSync(storeDir, { recursive: true, mode: 0o700 });
    }
    try {
        fs.chmodSync(storeDir, 0o700);
    } catch {
        // Best effort on non-POSIX filesystems
    }
    return storeDir;
}

/**
 * Return the boards directory: `~/.switchboard/boards/`.
 * Created at 0700 if absent.
 */
export function ensureBoardsDir(): string {
    ensureGlobalStoreDir();
    const boardsDir = path.join(getGlobalStoreDir(), 'boards');
    if (!fs.existsSync(boardsDir)) {
        fs.mkdirSync(boardsDir, { recursive: true, mode: 0o700 });
    }
    try {
        fs.chmodSync(boardsDir, 0o700);
    } catch {
        // Best effort on non-POSIX filesystems
    }
    return boardsDir;
}

/**
 * Resolve the per-project board database path: `~/.switchboard/boards/<workspace-id>.db`.
 *
 * This is the Board target the topology plan specifies. Each project gets its
 * own file, so isolation is enforced by topology rather than by remembering a
 * `workspace_id` predicate on every read and insert. A libSQL/Turso target can
 * substitute for this file because it is a real Board target, not a monolith.
 *
 * The workspace id is validated against a strict character class before being
 * joined into a path — it is read from a repository file and is therefore
 * untrusted input at the path-join boundary.
 */
export function resolveBoardDbPath(workspaceId: string, explicitPath?: string): ResolvedBoardDbPath {
    if (explicitPath && explicitPath.trim() !== '') {
        const expanded = explicitPath.trim().startsWith('~')
            ? path.join(os.homedir(), explicitPath.trim().slice(1))
            : explicitPath.trim();
        const resolved = path.resolve(expanded);
        const check = validateGlobalDbPath(resolved, { userSuppliedPath: explicitPath.trim() });
        if (!check.ok) {
            throw new Error(`[GlobalStore] Invalid board database path: ${check.reason}`);
        }
        _logPathResolution(resolved, 'explicit');
        return { path: resolved, source: 'explicit' };
    }

    if (process.env.SWITCHBOARD_GLOBAL_DB_PATH && process.env.SWITCHBOARD_GLOBAL_DB_PATH.trim() !== '') {
        const envPath = path.resolve(process.env.SWITCHBOARD_GLOBAL_DB_PATH.trim());
        const check = validateGlobalDbPath(envPath, { userSuppliedPath: process.env.SWITCHBOARD_GLOBAL_DB_PATH.trim() });
        if (!check.ok) {
            throw new Error(`[GlobalStore] Invalid SWITCHBOARD_GLOBAL_DB_PATH: ${check.reason}`);
        }
        _logPathResolution(envPath, 'env');
        return { path: envPath, source: 'env' };
    }

    const safeId = validateWorkspaceIdForPath(workspaceId);
    ensureBoardsDir();
    const boardPath = path.join(getGlobalStoreDir(), 'boards', `${safeId}.db`);
    const check = validateGlobalDbPath(boardPath);
    if (!check.ok) {
        throw new Error(`[GlobalStore] Board database path failed validation: ${check.reason}`);
    }
    _logPathResolution(boardPath, 'board_default');
    return { path: boardPath, source: 'board_default' };
}

/**
 * Resolve the per-board archive database path, derived from the board target.
 * The archive is a sibling of the board file: `~/.switchboard/boards/<workspace-id>-archive.db`.
 */
export function resolveArchiveDbPath(workspaceId: string, explicitPath?: string): string {
    if (explicitPath && explicitPath.trim() !== '') {
        const expanded = explicitPath.trim().startsWith('~')
            ? path.join(os.homedir(), explicitPath.trim().slice(1))
            : explicitPath.trim();
        const resolved = path.resolve(expanded);
        const check = validateGlobalDbPath(resolved, { userSuppliedPath: explicitPath.trim() });
        if (!check.ok) {
            throw new Error(`[GlobalStore] Invalid archive database path: ${check.reason}`);
        }
        _logPathResolution(resolved, 'explicit');
        return resolved;
    }

    const safeId = validateWorkspaceIdForPath(workspaceId);
    ensureBoardsDir();
    const archivePath = path.join(getGlobalStoreDir(), 'boards', `${safeId}-archive.db`);
    const check = validateGlobalDbPath(archivePath);
    if (!check.ok) {
        throw new Error(`[GlobalStore] Archive database path failed validation: ${check.reason}`);
    }
    _logPathResolution(archivePath, 'board_default');
    return archivePath;
}

/**
 * Resolve the global database path.
 * Sole authority for global database location.
 */
export function resolveGlobalDbPath(explicitPath?: string): ResolvedDbPath {
    if (explicitPath && explicitPath.trim() !== '') {
        const expanded = explicitPath.trim().startsWith('~')
            ? path.join(os.homedir(), explicitPath.trim().slice(1))
            : explicitPath.trim();
        const resolved = path.resolve(expanded);
        const check = validateGlobalDbPath(resolved, { userSuppliedPath: explicitPath.trim() });
        if (!check.ok) {
            throw new Error(`[GlobalStore] Invalid database path: ${check.reason}`);
        }
        _logPathResolution(resolved, 'explicit');
        return { path: resolved, source: 'explicit' };
    }

    if (process.env.SWITCHBOARD_GLOBAL_DB_PATH && process.env.SWITCHBOARD_GLOBAL_DB_PATH.trim() !== '') {
        const envPath = path.resolve(process.env.SWITCHBOARD_GLOBAL_DB_PATH.trim());
        const check = validateGlobalDbPath(envPath, { userSuppliedPath: process.env.SWITCHBOARD_GLOBAL_DB_PATH.trim() });
        if (!check.ok) {
            throw new Error(`[GlobalStore] Invalid SWITCHBOARD_GLOBAL_DB_PATH: ${check.reason}`);
        }
        _logPathResolution(envPath, 'env');
        return { path: envPath, source: 'env' };
    }

    ensureGlobalStoreDir();
    const defaultPath = path.join(getGlobalStoreDir(), 'switchboard.db');
    const check = validateGlobalDbPath(defaultPath);
    if (!check.ok) {
        throw new Error(`[GlobalStore] Default global database path failed validation: ${check.reason}`);
    }
    _logPathResolution(defaultPath, 'global_default');
    return { path: defaultPath, source: 'global_default' };
}

/**
 * Get the legacy consolidated global database path string.
 *
 * @deprecated This returns the pre-per-project path (`~/.switchboard/switchboard.db`).
 *   It is retained ONLY for the split migration (`splitConsolidatedDatabase`) to
 *   detect population (b) — installs that ran `8258ce4b` and have multiple
 *   workspaces' rows in one file. New code MUST use `resolveBoardDbPath(workspaceId)`.
 */
export function getGlobalDbPath(explicitPath?: string): string {
    const resolved = resolveGlobalDbPath(explicitPath);
    return resolved.path;
}

/**
 * Get the legacy cold archive database path string in the global store.
 *
 * @deprecated Retained for backward compatibility. New code MUST use
 *   `resolveArchiveDbPath(workspaceId)` for per-board archive resolution.
 */
export function getGlobalArchiveDbPath(): string {
    ensureGlobalStoreDir();
    const archivePath = path.join(getGlobalStoreDir(), 'kanban-archive.db');
    const check = validateGlobalDbPath(archivePath);
    if (!check.ok) {
        throw new Error(`[GlobalStore] Global archive path failed validation: ${check.reason}`);
    }
    return archivePath;
}

/**
 * Ensure file permissions for database are restricted to 0600.
 */
export function ensureDbPermissions(dbPath: string): void {
    if (fs.existsSync(dbPath)) {
        try {
            fs.chmodSync(dbPath, 0o600);
        } catch {
            // Best effort
        }
    }
}
