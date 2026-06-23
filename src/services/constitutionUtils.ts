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
export type GovernanceFileKey = 'constitution' | 'claude' | 'agents';

const GOVERNANCE_BASENAMES: Record<Exclude<GovernanceFileKey, 'constitution'>, string> = {
    claude: 'CLAUDE.md',
    agents: 'AGENTS.md',
};

export function getGovernanceFilePath(
    context: vscode.ExtensionContext,
    workspaceRoot: string,
    key: GovernanceFileKey = 'constitution'
): string {
    if (key === 'constitution') {
        return getConstitutionPath(context, workspaceRoot); // preserves custom paths
    }
    return path.join(workspaceRoot, GOVERNANCE_BASENAMES[key]);
}
