const path = require('path');
const fs = require('fs');

/**
 * Auto-discover workspace roots using a 3-tier strategy:
 * 1. SWITCHBOARD_WORKSPACE_ROOT env var (primary — same as MCP server)
 * 2. .vscode/settings.json → switchboard.workspaceDatabaseMappings (secondary)
 * 3. process.cwd() (tertiary fallback)
 */
function discoverWorkspaceRoots() {
    const roots = new Set();

    // Tier 1: Environment variables (primary)
    const envRoot = process.env.SWITCHBOARD_WORKSPACE_ROOT;
    if (envRoot && envRoot.trim()) {
        roots.add(path.resolve(envRoot.trim()));
    }
    
    const stateRoot = process.env.SWITCHBOARD_STATE_ROOT;
    if (stateRoot && stateRoot.trim()) {
        roots.add(path.resolve(path.dirname(stateRoot.trim())));
    }

    // Tier 2: VS Code settings.json (secondary)
    const settingsPath = path.join(process.cwd(), '.vscode', 'settings.json');
    if (fs.existsSync(settingsPath)) {
        try {
            const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
            const dbMappings = settings['switchboard.workspaceDatabaseMappings'];
            // Actual schema: { enabled: boolean, mappings: [{ id, name, dbPath, workspaceFolders }] }
            if (dbMappings && typeof dbMappings === 'object' && dbMappings.enabled === true) {
                const mappings = dbMappings.mappings;
                if (Array.isArray(mappings)) {
                    for (const mapping of mappings) {
                        if (Array.isArray(mapping.workspaceFolders)) {
                            for (const folder of mapping.workspaceFolders) {
                                if (typeof folder === 'string' && folder.trim()) {
                                    roots.add(path.resolve(folder));
                                }
                            }
                        }
                    }
                }
            }
        } catch (err) {
            console.warn('[workspaceDiscovery] Failed to parse .vscode/settings.json:', err.message);
        }
    }

    // Tier 3: cwd fallback
    if (roots.size === 0) {
        roots.add(process.cwd());
    }

    return Array.from(roots);
}

module.exports = { discoverWorkspaceRoots };
