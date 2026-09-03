#!/usr/bin/env node
//
// Remove a single subtask from its parent feature.
//
// Routes through the running Switchboard extension's local API server
// (POST /kanban/feature/remove). The extension performs the removal via
// KanbanProvider._removeSubtaskFromFeature, so it inherits the subtask detach,
// worktree abandon, feature-file regeneration, board refresh, and external
// tracker unlinking.
//
// Usage: node remove-from-feature.js <subtask_plan_id> [workspace_root]
//
const fs = require('fs');
const path = require('path');
const http = require('http');

const subtaskPlanId = process.argv[2];
let resolveWorkspaceRoot;
try {
  ({ resolveWorkspaceRoot } = require('../_lib/workspace-root'));
} catch {
  resolveWorkspaceRoot = (explicit) =>
    path.resolve(explicit && explicit !== '.' ? explicit : process.cwd());
}
const workspaceRoot = resolveWorkspaceRoot(process.argv[3]);
if (!workspaceRoot) {
  console.error(
    `No Switchboard workspace found from ${process.cwd()} — no .switchboard/kanban.db ` +
    `in this directory or any parent below your home directory.\n` +
    `Pass the workspace root explicitly:\n` +
    `  node remove-from-feature.js <subtaskPlanId> /absolute/path/to/workspace`
  );
  process.exit(1);
}

if (!subtaskPlanId) {
  console.error("Usage: node remove-from-feature.js <subtask_plan_id> [workspace_root]");
  process.exit(1);
}

const { cliApiCall } = require('../_lib/cli-call');

async function tryViaExtension() {
  const resp = await cliApiCall('POST', '/kanban/feature/remove', {
    workspaceRoot,
    subtaskPlanId
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
    error: 'Switchboard extension not reachable. Subtask removal requires the running extension (no direct-DB fallback). Open the workspace in VS Code with Switchboard active and retry.'
  }));
  process.exit(1);
})().catch(err => {
  console.log(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
});
