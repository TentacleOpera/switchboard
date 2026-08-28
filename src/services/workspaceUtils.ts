import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { getScopedMappingsForBoard } from './WorkspaceIdentityService';

function expandAndResolve(p: string): string {
    return path.resolve(p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
}

export function buildWorkspaceItems(openRoots: string[]): Array<{ label: string; workspaceRoot: string }> {
    const resolvedOpenRoots = openRoots.map(expandAndResolve);

    let mappings: any[] = [];
    let enabled = false;
    try {
        const cfg = getScopedMappingsForBoard(openRoots);
        if (cfg?.enabled && Array.isArray(cfg.mappings)) {
            mappings = cfg.mappings;
            enabled = true;
        }
    } catch { /* ignore */ }

    // The vscode.workspace lookup is wrapped so headless / HTTP callers (no vscode
    // host) fall back to basename labels instead of throwing.
    let workspaceFolders: Array<{ name: string; uri: { fsPath: string } }> = [];
    try {
        workspaceFolders = (vscode.workspace?.workspaceFolders || []) as any;
    } catch { /* headless: no vscode host */ }

    const findFolderName = (resolvedPath: string): string | null => {
        const folder = workspaceFolders.find(
            f => path.resolve(f.uri.fsPath) === resolvedPath
        );
        return folder ? folder.name : null;
    };

    const items: Array<{ label: string; workspaceRoot: string }> = [];
    const addedRoots = new Set<string>();

    // Visibility rule: A workspace is visible iff it is one of the host's roots,
    // or it is a member of a mapping whose parent is one of the host's roots.
    // Never emit a parent that is not a host root.

    for (const root of resolvedOpenRoots) {
        if (addedRoots.has(root)) continue;

        // Check if this open root is a parent in any scoped mapping
        const parentMapping = enabled ? mappings.find(m => {
            const parent = m.parentFolder || (m as any).parentWorkspaceFolder
                || (Array.isArray(m.workspaceFolders) && m.workspaceFolders.length > 0 ? m.workspaceFolders[0] : undefined);
            return parent && expandAndResolve(parent) === root;
        }) : undefined;

        if (parentMapping) {
            addedRoots.add(root);
            items.push({
                label: parentMapping.name || findFolderName(root) || path.basename(root),
                workspaceRoot: root
            });
            // Also emit member children of this mapping
            if (Array.isArray(parentMapping.workspaceFolders)) {
                for (const child of parentMapping.workspaceFolders) {
                    const resolvedChild = expandAndResolve(child);
                    if (!addedRoots.has(resolvedChild)) {
                        addedRoots.add(resolvedChild);
                        items.push({
                            label: findFolderName(resolvedChild) || path.basename(resolvedChild),
                            workspaceRoot: resolvedChild
                        });
                    }
                }
            }
        } else {
            addedRoots.add(root);
            items.push({
                label: findFolderName(root) || path.basename(root),
                workspaceRoot: root
            });
        }
    }

    return items;
}
