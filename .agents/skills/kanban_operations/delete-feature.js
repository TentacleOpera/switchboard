#!/usr/bin/env node
//
// Delete a feature and optionally its subtasks.
//
// Routes through the running Switchboard extension's local API server
// (POST /kanban/feature/delete). The extension performs the deletion via
// KanbanProvider._deleteFeature, so it inherits the worktree cleanup, subtask
// detach/tombstone, feature tombstone, board refresh, and external tracker
// unlinking.
//
// Usage: node delete-feature.js <feature_plan_id> [delete_subtasks] [workspace_root]
//   delete_subtasks: 'true' or 'false' (default: false — subtasks are detached, not deleted)
//
const fs = require('fs');
const path = require('path');
const http = require('http');

const featurePlanId = process.argv[2];
const deleteSubtasksArg = process.argv[3] || 'false';
let resolveWorkspaceRoot;
try {
  ({ resolveWorkspaceRoot } = require('../_lib/workspace-root'));
} catch {
  resolveWorkspaceRoot = (explicit) =>
    path.resolve(explicit && explicit !== '.' ? explicit : process.cwd());
}
const workspaceRoot = resolveWorkspaceRoot(process.argv[4]);
if (!workspaceRoot) {
  console.error(
    `No Switchboard workspace found from ${process.cwd()} — no .switchboard/kanban.db ` +
    `in this directory or any parent below your home directory.\n` +
    `Pass the workspace root explicitly:\n` +
    `  node delete-feature.js <featurePlanId> [deleteSubtasks] /absolute/path/to/workspace`
  );
  process.exit(1);
}

if (!featurePlanId) {
  console.error("Usage: node delete-feature.js <feature_plan_id> [delete_subtasks] [workspace_root]");
  console.error("  delete_subtasks: 'true' or 'false' (default: false — subtasks are detached, not deleted)");
  process.exit(1);
}

const deleteSubtasks = deleteSubtasksArg === 'true';

const { cliApiCall } = require('../_lib/cli-call');

async function tryViaExtension() {
  const resp = await cliApiCall('POST', '/kanban/feature/delete', {
    workspaceRoot,
    featurePlanId,
    deleteSubtasks
  }, workspaceRoot);
  if (!resp.reachable) return { reachable: false };
  const res = resp.result || {};
  if (resp.success && res.success !== false) {
    return { reachable: true, success: true };
  }
  return { reachable: true, success: false, error: resp.error || res.error || (resp.status ? `HTTP ${resp.status}` : undefined) };
}

(async () => {
  const viaExt = await tryViaExtension();
  if (viaExt.reachable) {
    if (viaExt.success) {
      console.log(JSON.stringify({ ok: true }));
      process.exit(0);
    }
    console.log(JSON.stringify({ ok: false, error: viaExt.error || 'unknown error' }));
    process.exit(1);
  }

  console.log(JSON.stringify({
    ok: false,
    error: 'Switchboard extension not reachable. Feature deletion requires the running extension (no direct-DB fallback). Open the workspace in VS Code with Switchboard active and retry.'
  }));
  process.exit(1);
})().catch(err => {
  console.log(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
});
