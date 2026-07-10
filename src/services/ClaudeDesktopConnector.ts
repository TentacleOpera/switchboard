// "Connect Claude Desktop" — in-extension discovery surface.
//
// The only surface that lets the existing VS Code user base discover the MCP
// bridge. Resolves Claude Desktop's per-OS config path, reads-or-creates the
// JSON, and idempotently merges an mcpServers["switchboard-mcp"] entry —
// overwriting only our own key, never clobbering other servers. Precedent:
// the removed connectMcp command (commits 31c3937 / 76780bd).
//
// Server key is "switchboard-mcp" (never "switchboard") to dodge the
// activation-time config scrubber in extension.ts that deletes any
// switchboard-keyed MCP entry from six host configs. claude_desktop_config.json
// is NOT in the scrub list, but the naming rule is applied for consistency.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

const SERVER_KEY = 'switchboard-mcp';

export interface ConnectResult {
    ok: boolean;
    configPath: string;
    message: string;
    multiRoot?: boolean;
    writtenKeys?: string[];
}

/** Resolve Claude Desktop's per-OS config path, or null on unsupported platforms. */
export function resolveClaudeDesktopConfigPath(): string | null {
    const platform = process.platform;
    if (platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    }
    if (platform === 'win32') {
        const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
        return path.join(appData, 'Claude', 'claude_desktop_config.json');
    }
    // Linux: Claude Desktop is not officially shipped; best-effort XDG path.
    if (platform === 'linux') {
        const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
        return path.join(xdg, 'Claude', 'claude_desktop_config.json');
    }
    return null;
}

function slugify(root: string): string {
    const base = path.basename(root).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return base || 'workspace';
}

function buildEntry(workspaceRoot: string): Record<string, unknown> {
    return {
        command: 'npx',
        args: ['-y', '@switchboard/mcp'],
        env: { SWITCHBOARD_WORKSPACE_ROOT: workspaceRoot }
    };
}

/**
 * Idempotently merge the switchboard-mcp entry into claude_desktop_config.json.
 * Multi-root workspace → one entry per root under distinct keys
 * (switchboard-mcp-<slug>), never a single ambiguous entry. Preserves all
 * other mcpServers and unknown top-level keys. No confirm gate (project rule).
 */
export async function connectClaudeDesktop(workspaceRoots: string[]): Promise<ConnectResult> {
    const configPath = resolveClaudeDesktopConfigPath();
    if (!configPath) {
        return {
            ok: false,
            configPath: '',
            message: `Unsupported platform: ${process.platform}. Use the manual config snippet from src/mcp/claude_desktop_config.example.json.`
        };
    }

    let config: Record<string, unknown> = {};
    let corrupt = false;
    if (fs.existsSync(configPath)) {
        try {
            const raw = fs.readFileSync(configPath, 'utf8');
            config = JSON.parse(raw);
            if (typeof config !== 'object' || config === null || Array.isArray(config)) {
                config = {};
                corrupt = true;
            }
        } catch {
            corrupt = true;
            // Preserve the corrupt file — do not destroy it.
        }
    }

    if (corrupt) {
        return {
            ok: false,
            configPath,
            message: `Claude Desktop config at ${configPath} is corrupt or unparseable. It was left untouched. Fix or remove it, then re-run, or paste the snippet from src/mcp/claude_desktop_config.example.json manually.`
        };
    }

    // Ensure the config dir exists.
    const dir = path.dirname(configPath);
    try {
        fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
        return { ok: false, configPath, message: `Could not create config directory ${dir}: ${(e as Error).message}` };
    }

    const mcpServers = (config['mcpServers'] && typeof config['mcpServers'] === 'object' && !Array.isArray(config['mcpServers']))
        ? (config['mcpServers'] as Record<string, unknown>)
        : {};
    const isMulti = workspaceRoots.length > 1;
    const writtenKeys: string[] = [];

    if (isMulti) {
        for (const root of workspaceRoots) {
            const key = `${SERVER_KEY}-${slugify(root)}`;
            mcpServers[key] = buildEntry(root);
            writtenKeys.push(key);
        }
    } else {
        mcpServers[SERVER_KEY] = buildEntry(workspaceRoots[0]);
        writtenKeys.push(SERVER_KEY);
    }

    config['mcpServers'] = mcpServers;

    try {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
    } catch (e) {
        return { ok: false, configPath, message: `Failed to write ${configPath}: ${(e as Error).message}` };
    }

    const rootSummary = isMulti
        ? `${workspaceRoots.length} workspace entries written (${writtenKeys.join(', ')})`
        : `workspace root pre-filled: ${workspaceRoots[0]}`;

    return {
        ok: true,
        configPath,
        multiRoot: isMulti,
        writtenKeys,
        message: `Wrote ${writtenKeys.length} switchboard-mcp entr${writtenKeys.length === 1 ? 'y' : 'ies'} to ${configPath}. ${rootSummary}. Restart Claude Desktop to load the tools.`
    };
}

/**
 * Command handler. Resolves workspace roots from the kanban provider's
 * multi-root set (falling back to vscode.workspace.workspaceFolders), runs
 * the idempotent merge, and surfaces the result via an info/warning message.
 */
export async function runConnectClaudeDesktop(
    getCurrentWorkspaceRoot: () => string | null,
    getAllWorkspaceRoots?: () => string[]
): Promise<ConnectResult> {
    let roots: string[];
    const all = getAllWorkspaceRoots?.().filter(r => r) ?? [];
    if (all.length > 1) {
        roots = all;
    } else {
        const single = getCurrentWorkspaceRoot();
        if (single) {
            roots = [single];
        } else {
            roots = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
        }
    }
    if (roots.length === 0) {
        vscode.window.showWarningMessage('No workspace folder open — open a workspace in VS Code first, then re-run Connect Claude Desktop.');
        return { ok: false, configPath: '', message: 'No workspace folder open.' };
    }
    const result = await connectClaudeDesktop(roots);
    if (result.ok) {
        vscode.window.showInformationMessage(result.message, 'Reveal Config').then(action => {
            if (action === 'Reveal Config') {
                const uri = vscode.Uri.file(result.configPath);
                vscode.commands.executeCommand('revealFileInOS', uri);
            }
        });
    } else {
        vscode.window.showWarningMessage(result.message);
    }
    return result;
}
