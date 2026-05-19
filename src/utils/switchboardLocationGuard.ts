import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';

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
 * Determine whether a candidate path is allowed to contain a `.switchboard` directory.
 *
 * CHECK ORDER IS CRITICAL:
 * 1. First, check if the candidate is a mapped child workspaceFolder → BLOCK
 * 2. Then, check if the candidate is a configured parentFolder → ALLOW
 * 3. Then, check if the candidate is the explicit control plane root → ALLOW
 * 4. Default: only allow if candidate matches the provided workspaceRoot
 *
 * @param candidatePath - The directory where `.switchboard` would be created
 * @param workspaceRoot - The current workspace root (from getCurrentWorkspaceRoot)
 * @returns true if `.switchboard` creation is allowed at this path
 */
export function isAllowedSwitchboardLocation(candidatePath: string, workspaceRoot: string): boolean {
    const resolvedCandidate = path.resolve(candidatePath);
    const resolvedWorkspaceRoot = path.resolve(workspaceRoot);

    // 1. Check workspaceDatabaseMappings — child folders are NEVER allowed
    try {
        const cfg = vscode.workspace.getConfiguration('switchboard')
                         .get('workspaceDatabaseMappings') as
            { enabled?: boolean; mappings?: Array<{ workspaceFolders: string[]; parentFolder?: string }> } | undefined;

        if (cfg?.enabled && Array.isArray(cfg.mappings)) {
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
        }
    } catch {
        // Outside extension host — conservative: fall through to default
    }

    // 2. Check explicit control plane root (legacy mechanism)
    // Note: This requires ExtensionContext which isn't available in a pure utility.
    // The caller (extension.ts) handles this via resolveEffectiveStateRoot before calling us.

    // 3. Default: only allow if candidate matches workspace root
    // This is the safe fallback — prevents creation in arbitrary directories
    return resolvedCandidate === resolvedWorkspaceRoot;
}
