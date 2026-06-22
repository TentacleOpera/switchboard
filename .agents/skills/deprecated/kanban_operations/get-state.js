const path = require('path');
const { KanbanDatabase, VALID_KANBAN_COLUMNS } = require('../../../out/services/KanbanDatabase');
const { discoverWorkspaceRoots } = require('./lib/workspaceDiscovery');

// Backward compatibility: if argument provided, use single workspace mode
const explicitRoot = process.argv[2];
const workspaceRoots = explicitRoot ? [path.resolve(explicitRoot)] : discoverWorkspaceRoots();

const results = {};

Promise.all(workspaceRoots.map(async (workspaceRoot) => {
    try {
        const db = KanbanDatabase.forWorkspace(workspaceRoot);
        await db.ensureReady();
        const workspaceId = await db.getWorkspaceId() || workspaceRoot;
        const columns = {};
        const columnNames = Array.from(VALID_KANBAN_COLUMNS);

        for (const col of columnNames) {
            columns[col] = await db.getPlansByColumn(workspaceId, col);
        }

        results[workspaceRoot] = {
            workspaceId,
            timestamp: new Date().toISOString(),
            columns
        };

        if (typeof db.close === 'function') db.close();
    } catch (err) {
        console.error(`[get-state] Failed for workspace ${workspaceRoot}:`, err.message);
        // Do not include error entries in output — only log to stderr
    }
})).then(() => {
    // Single-workspace mode: output the old format for backward compatibility
    if (explicitRoot) {
        const resolvedExplicitRoot = path.resolve(explicitRoot);
        const singleResult = results[resolvedExplicitRoot];
        if (singleResult) {
            console.log(JSON.stringify(singleResult, null, 2));
        } else {
            // If it failed, we already logged to stderr
            process.exit(1);
        }
    } else {
        // Multi-workspace mode: output all results (Option A format)
        console.log(JSON.stringify({
            timestamp: new Date().toISOString(),
            workspaces: results
        }, null, 2));
    }
    process.exit(0);
}).catch(err => {
    console.error(err);
    process.exit(1);
});
