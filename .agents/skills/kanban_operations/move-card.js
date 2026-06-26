const { KanbanDatabase, VALID_KANBAN_COLUMNS } = require('../../../out/services/KanbanDatabase');

const sessionId = process.argv[2];
const targetColumn = process.argv[3];
const optionalPlanFile = process.argv[4];
const workspaceRoot = process.argv[5] || '.';

if (!sessionId || !targetColumn) {
  console.error('Usage: node move-card.js <session_id> <target_column> [plan_file] [workspace_root]');
  process.exit(1);
}

if (!VALID_KANBAN_COLUMNS.has(targetColumn)) {
  console.error(`Invalid column: ${targetColumn}`);
  console.error(`Valid columns: ${Array.from(VALID_KANBAN_COLUMNS).join(', ')}`);
  process.exit(1);
}

const db = KanbanDatabase.forWorkspace(workspaceRoot);
db.ensureReady().then(async () => {
  const plan = await db.getPlanBySessionId(sessionId);
  let columnSuccess;
  if (plan && plan.isEpic) {
    const subtasks = await db.getSubtasksByEpicId(plan.planId);
    const subtaskSessionIds = subtasks.map(st => st.sessionId).filter(Boolean);
    columnSuccess = await db.updateColumnWithEpicCascade(sessionId, subtaskSessionIds, targetColumn);
  } else {
    columnSuccess = await db.updateColumn(sessionId, targetColumn);
  }

  // Update plan_file if provided
  let planFileSuccess = true;
  if (optionalPlanFile) {
    planFileSuccess = await db.updatePlanFile(sessionId, optionalPlanFile);
  }

  const success = columnSuccess && planFileSuccess;
  console.log(success ? 'OK' : 'FAILED');
  if (typeof db.close === 'function') db.close();
  process.exit(success ? 0 : 1);
}).catch(err => {
  console.error(err);
  if (typeof db.close === 'function') db.close();
  process.exit(1);
});
