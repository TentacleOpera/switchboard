// Route all diagnostic logging to stderr so stdout is strictly parseable JSON.
console.log = console.info = console.warn = console.debug = (...args) => console.error(...args);

const { KanbanDatabase, VALID_KANBAN_COLUMNS } = require('../../../out/services/KanbanDatabase');
const path = require('path');

let resolveWorkspaceRoot;
try {
  ({ resolveWorkspaceRoot } = require('../_lib/workspace-root'));
} catch {
  resolveWorkspaceRoot = (explicit) =>
    path.resolve(explicit && explicit !== '.' ? explicit : process.cwd());
}
const workspaceRoot = resolveWorkspaceRoot(process.argv[2]);
if (!workspaceRoot) {
  console.error(
    `No Switchboard workspace found from ${process.cwd()} — no .switchboard/kanban.db ` +
    `in this directory or any parent below your home directory.\n` +
    `Pass the workspace root explicitly:\n` +
    `  node get-state.js /absolute/path/to/workspace`
  );
  process.exit(1);
}

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
