const path = require('path');
const { KanbanDatabase, VALID_KANBAN_COLUMNS } = require('../../../out/services/KanbanDatabase');
const { discoverWorkspaceRoots } = require('./lib/workspaceDiscovery');

const sessionId = process.argv[2];
const targetColumn = process.argv[3];
const optionalPlanFile = process.argv[4];
const explicitRoot = process.argv[5];

if (!sessionId || !targetColumn) {
  console.error('Usage: node move-card.js <session_id> <target_column> [plan_file] [workspace_root]');
  process.exit(1);
}

if (!VALID_KANBAN_COLUMNS.has(targetColumn)) {
  console.error(\`Invalid column: \${targetColumn}\`);
  process.exit(1);
}

let workspaceRoot;
if (explicitRoot) {
    workspaceRoot = path.resolve(explicitRoot);
} else {
    const roots = discoverWorkspaceRoots();
    workspaceRoot = roots[0];
}

const db = KanbanDatabase.forWorkspace(workspaceRoot);
db.ensureReady().then(async () => {
    // Atomic SQL transaction
    const now = new Date().toISOString();
    let sql = 'UPDATE plans SET kanban_column = ?, updated_at = ?';
    const params = [targetColumn, now];
    
    if (optionalPlanFile) {
        sql += ', plan_file = ?';
        params.push(optionalPlanFile); // KanbanDatabase.updatePlanFile normalizes this, but here we're direct. 
                                      // Actually, KanbanDatabase._normalizePath is private.
                                      // To be safe, let's use the DB's internal methods if we want normalization,
                                      // BUT the goal is atomicity.
    }
    
    sql += ' WHERE session_id = ?';
    params.push(sessionId);

    // We use _persistedUpdate which handles the transaction + persistence
    // But _persistedUpdate is private. 
    // We can use db.updateColumn and db.updatePlanFile but they aren't atomic together.
    // However, for this task, I should probably use the existing public methods 
    // OR if I want real atomicity, I'd need a new method in KanbanDatabase.ts.
    
    // The plan says "Implement .agents/skills/kanban_operations/move-card.js using SQL for atomicity".
    // If I can't touch KanbanDatabase.ts yet (or if I should), I might have to use a hack or just
    // use the public methods and accept the 2-step process for now, OR add the method.
    
    // Wait, the instructions say "EXECUTION mode". I can modify KanbanDatabase.ts.
    // Let's first check if I can just use a raw update if I have access to _db.
    // _db is private.
    
    // OK, I will add an atomic method to KanbanDatabase.ts first.
    
    // For now, let's write the script to use a (soon to be created) atomic method.
    const success = await db.movePlan(sessionId, targetColumn, optionalPlanFile);

    console.log(success ? 'OK' : 'FAILED');
    if (typeof db.close === 'function') db.close();
    process.exit(success ? 0 : 1);
}).catch(err => {
    console.error(err);
    if (typeof db.close === 'function') db.close();
    process.exit(1);
});
