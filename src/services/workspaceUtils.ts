import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { getMappingsFromIndex } from './WorkspaceIdentityService';

export function buildWorkspaceItems(openRoots: string[]): Array<{ label: string; workspaceRoot: string }> {
    let mappings: any[] = [];
    let enabled = false;
    try {
        const cfg = getMappingsFromIndex();
        if (cfg?.enabled && Array.isArray(cfg.mappings)) {
            mappings = cfg.mappings;
            enabled = true;
        }
    } catch { /* ignore */ }

    const items: Array<{ label: string; workspaceRoot: string }> = [];

    // Check if ANY of the currently open workspace folders is mapped
    let anyOpenFolderIsMapped = false;
    if (enabled && mappings.length > 0) {
        for (const root of openRoots) {
            const resolvedRoot = path.resolve(root);
            for (const m of mappings) {
                const parent = m.parentFolder || (m as any).parentWorkspaceFolder
                    || (Array.isArray(m.workspaceFolders) && m.workspaceFolders.length > 0 ? m.workspaceFolders[0] : undefined);
                if (parent) {
                    const expandedParent = parent.startsWith('~')
                        ? path.join(os.homedir(), parent.slice(1))
                        : parent;
                    if (path.resolve(expandedParent) === resolvedRoot) {
                        anyOpenFolderIsMapped = true;
                        break;
                    }
                }
                for (const wf of m.workspaceFolders || []) {
                    const expandedWf = wf.startsWith('~')
                        ? path.join(os.homedir(), wf.slice(1))
                        : wf;
                    if (path.resolve(expandedWf) === resolvedRoot) {
                        anyOpenFolderIsMapped = true;
                        break;
                    }
                }
                if (anyOpenFolderIsMapped) break;
            }
            if (anyOpenFolderIsMapped) break;
        }
    }

    if (enabled && mappings.length > 0 && anyOpenFolderIsMapped) {
        // Multi-root/mapped context: display the custom configured parent mapping names
        const addedRoots = new Set<string>();
        for (const m of mappings) {
            const parent = m.parentFolder || (m as any).parentWorkspaceFolder
                || (Array.isArray(m.workspaceFolders) && m.workspaceFolders.length > 0 ? m.workspaceFolders[0] : undefined);
            if (parent) {
                const expanded = parent.startsWith('~')
                    ? path.join(os.homedir(), parent.slice(1))
                    : parent;
                const resolvedParent = path.resolve(expanded);
                if (!addedRoots.has(resolvedParent)) {
                    addedRoots.add(resolvedParent);
                    items.push({
                        label: m.name || path.basename(resolvedParent),
                        workspaceRoot: resolvedParent
                    });
                }
            }
        }
    } else {
        // Independent context or mappings disabled: display standard workspace folders.
        // The vscode.workspace lookup is wrapped so headless / HTTP callers (no vscode
        // host) fall back to basename labels instead of throwing.
        let workspaceFolders: Array<{ name: string; uri: { fsPath: string } }> = [];
        try {
            workspaceFolders = (vscode.workspace?.workspaceFolders || []) as any;
        } catch { /* headless: no vscode host */ }
        for (const root of openRoots) {
            const resolvedRoot = path.resolve(root);
            const folder = workspaceFolders.find(
                f => path.resolve(f.uri.fsPath) === resolvedRoot
            );
            items.push({
                label: folder ? folder.name : path.basename(resolvedRoot),
                workspaceRoot: resolvedRoot
            });
        }
    }

    return items;
}
