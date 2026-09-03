#!/usr/bin/env node
//
// Move a kanban card to a target column. Feature-aware: when the card is a feature,
// all of its subtasks cascade to the same column.
//
//
// Route through the running Switchboard host's local API server (POST /kanban/move).
// The host performs the move via KanbanProvider, so it inherits the feature cascade,
// the Linear/ClickUp integration-sync fan-out, and the board refresh.
//

const path = require('path');
const { cliApiCall } = require('../_lib/cli-call');

const effectiveKey = process.argv[2];
const targetColumn = process.argv[3];
const optionalPlanFile = process.argv[4];
let resolveWorkspaceRoot;
try {
  ({ resolveWorkspaceRoot } = require('../_lib/workspace-root'));
} catch {
  // Partial .agents/ sync — degrade to the old behaviour rather than crash.
  resolveWorkspaceRoot = (explicit) =>
    path.resolve(explicit && explicit !== '.' ? explicit : process.cwd());
}
const workspaceRoot = resolveWorkspaceRoot(process.argv[5]);
if (!workspaceRoot) {
  console.error(
    `No Switchboard workspace found from ${process.cwd()} — no .switchboard/kanban.db ` +
    `in this directory or any parent below your home directory.\n` +
    `Pass the workspace root explicitly:\n` +
    `  node move-card.js <plan> <column> "" /absolute/path/to/workspace`
  );
  process.exit(1);
}

if (!effectiveKey || !targetColumn) {
  console.error('Usage: node move-card.js <session_id|plan_id|plan_file> <target_column> [plan_file] [workspace_root]');
  process.exit(1);
}

let resolvedPlanFile = optionalPlanFile;
if (effectiveKey && (effectiveKey.includes('/') || effectiveKey.endsWith('.md'))) {
  resolvedPlanFile = effectiveKey;
}

async function tryViaExtension() {
  return await cliApiCall('POST', '/kanban/move', {
    sessionId: effectiveKey,
    targetColumn,
    workspaceRoot,
    planFile: resolvedPlanFile || undefined
  }, workspaceRoot);
}

(async () => {
  const viaExt = await tryViaExtension();
  if (viaExt.success) {
    console.log('OK');
    process.exit(0);
  }
  console.error(viaExt.reachable
    ? `Move failed: ${viaExt.error || 'unknown error'}`
    : 'Move failed: no Switchboard host is reachable. Start the board (or the standalone '
      + 'host) and retry — a card move goes through the same code path a human click takes.');
  console.log('FAILED');
  process.exit(1);
})().catch(err => {
  console.error(err);
  process.exit(1);
});

