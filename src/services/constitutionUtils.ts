import * as vscode from 'vscode';
import * as path from 'path';

export function getConstitutionPath(context: vscode.ExtensionContext, workspaceRoot: string): string {
    const store = context.globalState;
    const paths = store.get<Record<string, string>>('switchboard.constitutionPaths', {}) || {};
    const relativePath = paths[workspaceRoot];
    if (relativePath) {
        return path.isAbsolute(relativePath) ? relativePath : path.join(workspaceRoot, relativePath);
    }
    return path.join(workspaceRoot, 'CONSTITUTION.md');
}
