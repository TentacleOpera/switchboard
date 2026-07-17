import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Expand home directory shorthand (~) to absolute path.
 * Matches the inline pattern used throughout the codebase.
 */
function expandHome(p: string): string {
    const trimmed = p.trim();
    return trimmed.startsWith('~')
        ? path.join(os.homedir(), trimmed.slice(1))
        : trimmed;
}

/**
 * Durable, index-INDEPENDENT test for "this folder owns a Switchboard control plane".
 *
 * A folder that owns a control plane always has its own `.switchboard/kanban.db`
 * (standalone) or `.switchboard/db-pointer` (redirected parent). A *child* folder
 * in a workspace mapping SHARES its parent's DB and therefore has neither marker.
 *
 * Because this reads the filesystem — not the async in-memory mapping index — it
 * holds even during the activation window when `getMappingsFromIndex()` is still
 * empty. That transient-empty window was the root cause of the recurring
 * child-scaffold bug: every mapping-based check failed open while the index built.
 */
function hasOwnControlPlane(dir: string): boolean {
    try {
        const sbDir = path.join(dir, '.switchboard');
        return fs.existsSync(path.join(sbDir, 'kanban.db'))
            || fs.existsSync(path.join(sbDir, 'db-pointer'));
    } catch {
        return false;
    }
}

/**
 * True iff some OTHER open workspace folder owns a control plane. When a parent
 * control plane is present, a candidate folder that has no control plane of its
 * own is presumed to be a shared child of it — so `.switchboard` creation there
 * is blocked. This catches both nested children (e.g. `parent/be`) and external
 * mapped children (e.g. a sibling repo listed in the mapping) BEFORE the mapping
 * index has loaded, closing the race.
 */
function anyOtherFolderOwnsControlPlane(candidate: string): boolean {
    try {
        const vscode = require('vscode') as any;
        const folders = vscode.workspace?.workspaceFolders ?? [];
        for (const f of folders) {
            const root = path.resolve(f.uri.fsPath);
            if (root === candidate) continue;
            if (hasOwnControlPlane(root)) {
                return true;
            }
        }
    } catch {
        // Outside the extension host — no workspace folders to consult.
    }
    return false;
}

/**
 * Determine whether a candidate path is allowed to contain a `.switchboard` directory.
 *
 * CHECK ORDER IS CRITICAL:
 * 1. In-memory mapping index (authoritative WHEN populated):
 *    a. candidate is a mapped child workspaceFolder → BLOCK
 *    b. candidate is a configured parentFolder      → ALLOW
 *    (If the index is populated but the candidate is neither, we do NOT blanket-allow
 *     here — we fall through to the structural checks below.)
 * 2. Structural, index-INDEPENDENT checks (the race fix):
 *    a. candidate owns a control plane (kanban.db / db-pointer) → ALLOW
 *    b. some other open folder owns a control plane → candidate is a shared child → BLOCK
 * 3. Default: no mapping, no control plane present anywhere → genuine standalone /
 *    first-run install → allow only if candidate matches the provided workspaceRoot.
 *
 * Historically step 1 was the ONLY gate and, when the index was empty, control fell
 * straight to step 3 (`candidate === workspaceRoot`). Callers invoke this as
 * `isAllowedSwitchboardLocation(folder, folder)`, making that comparison tautologically
 * true — so an empty index silently permitted `.switchboard` in every folder. Step 2
 * makes the guard fail CLOSED off a durable on-disk signal instead.
 *
 * @param candidatePath - The directory where `.switchboard` would be created
 * @param workspaceRoot - The current workspace root (from getCurrentWorkspaceRoot)
 * @returns true if `.switchboard` creation is allowed at this path
 */
export function isAllowedSwitchboardLocation(candidatePath: string, workspaceRoot: string): boolean {
    const resolvedCandidate = path.resolve(candidatePath);
    const resolvedWorkspaceRoot = path.resolve(workspaceRoot);

    // 1. Mapping index — authoritative when populated.
    try {
        const { getMappingsFromIndex } = require('../services/WorkspaceIdentityService');
        const cfg = getMappingsFromIndex();

        if (cfg?.enabled && Array.isArray(cfg.mappings) && cfg.mappings.length > 0) {
            // 1a. Is candidate a mapped child workspaceFolder? → BLOCK
            for (const mapping of cfg.mappings) {
                if (Array.isArray(mapping.workspaceFolders)) {
                    for (const wf of mapping.workspaceFolders) {
                        if (path.resolve(expandHome(wf)) === resolvedCandidate) {
                            return false; // Child workspace — NOT allowed
                        }
                    }
                }
            }

            // 1b. Is candidate a configured parentFolder? → ALLOW
            for (const mapping of cfg.mappings) {
                if (mapping.parentFolder) {
                    if (path.resolve(expandHome(mapping.parentFolder)) === resolvedCandidate) {
                        return true;
                    }
                }
            }
            // Index populated but candidate is neither a listed child nor parent:
            // fall through to the structural checks (do NOT blanket-allow).
        }
    } catch {
        // Outside extension host — conservative: fall through to structural checks.
    }

    // 2. Structural checks — independent of the async mapping index.
    // 2a. Candidate owns a control plane → it is a real root → ALLOW.
    if (hasOwnControlPlane(resolvedCandidate)) {
        return true;
    }
    // 2b. A parent control plane is present and the candidate has none of its own →
    //     candidate is a shared child → BLOCK. This holds even while the index is
    //     transiently empty during activation.
    if (anyOtherFolderOwnsControlPlane(resolvedCandidate)) {
        return false;
    }

    // 3. Default: genuine standalone / first-run (no mapping, no control plane present).
    // Only allow if candidate matches the workspace root — the safe fallback that lets a
    // brand-new single-root install scaffold before its DB exists.
    return resolvedCandidate === resolvedWorkspaceRoot;
}
