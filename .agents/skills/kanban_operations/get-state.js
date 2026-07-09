// Route all diagnostic logging to stderr so stdout is strictly parseable JSON.
console.log = console.info = console.warn = console.debug = (...args) => console.error(...args);

const { KanbanDatabase, VALID_KANBAN_COLUMNS } = require('../../../out/services/KanbanDatabase');

const workspaceRoot = process.argv[2] || '.';

const db = KanbanDatabase.forWorkspace(workspaceRoot);
db.ensureReady().then(async () => {
  const workspaceId = await db.getWorkspaceId() || workspaceRoot;
  const columns = {};
  const columnNames = Array.from(VALID_KANBAN_COLUMNS);

  for (const col of columnNames) {
    columns[col] = await db.getPlansByColumn(workspaceId, col);
  }

  const payload = JSON.stringify({
    workspaceId,
    timestamp: new Date().toISOString(),
    columns
  }, null, 2);

  process.stdout.end(payload + '\n', 'utf8', () => {
    if (typeof db.close === 'function') db.close();
    process.exit(0);
  });
}).catch(err => {
  console.error(err);
  if (typeof db.close === 'function') db.close();
  process.exit(1);
});
