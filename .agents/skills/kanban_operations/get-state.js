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
  // `ensureReady()` resolving is not the same as the store being readable, and every
  // reader below answers an unreadable store with `[]`. Without this probe a downed
  // store prints a complete, well-formed board with every column empty — which a
  // caller acts on. Store-unavailable is a distinct outcome from an empty board and
  // it exits non-zero with nothing on stdout, so it can never be parsed as state.
  const probe = typeof db.probeStore === 'function'
    ? await db.probeStore()
    : { reachable: true, tier: 'board' };
  if (!probe.reachable) {
    console.error(
      `STORE_UNAVAILABLE (${probe.tier || 'board'}): ${probe.reason || 'the board store did not answer'}\n` +
      `This is NOT an empty board — no board state was read. Start the Switchboard host ` +
      `(or check the board database path) and re-run.`
    );
    if (typeof db.close === 'function') db.close();
    process.exit(2);
  }

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
