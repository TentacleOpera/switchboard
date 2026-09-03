#!/usr/bin/env node
//
// Split a feature into two new features, partitioning its subtasks.
//
// Routes through the running Switchboard extension's local API server
// (POST /kanban/feature/split). The extension performs the split via
// KanbanProvider.splitFeature: the original feature is deleted (subtasks
// detached, not tombstoned), then two new features are created with their
// respective subtask sets.
//
// Usage: node split-feature.js <feature_plan_id> <kept_plan_ids_json> <first_feature_name> <second_feature_name> [workspace_root]
//   kept_plan_ids_json: JSON array of planId values that go to the first new feature
//   All other subtasks go to the second new feature.
//
const fs = require('fs');
const path = require('path');
const http = require('http');

const featurePlanId = process.argv[2];
const keptPlanIdsJson = process.argv[3];
const firstFeatureName = process.argv[4];
const secondFeatureName = process.argv[5];
let resolveWorkspaceRoot;
try {
  ({ resolveWorkspaceRoot } = require('../_lib/workspace-root'));
} catch {
  resolveWorkspaceRoot = (explicit) =>
    path.resolve(explicit && explicit !== '.' ? explicit : process.cwd());
}
const workspaceRoot = resolveWorkspaceRoot(process.argv[6]);
if (!workspaceRoot) {
  console.error(
    `No Switchboard workspace found from ${process.cwd()} — no .switchboard/kanban.db ` +
    `in this directory or any parent below your home directory.\n` +
    `Pass the workspace root explicitly:\n` +
    `  node split-feature.js <featurePlanId> <keptPlanIds> <firstFeatureName> <secondFeatureName> /absolute/path/to/workspace`
  );
  process.exit(1);
}

if (!featurePlanId || !keptPlanIdsJson || !firstFeatureName || !secondFeatureName) {
  console.error("Usage: node split-feature.js <feature_plan_id> <kept_plan_ids_json> <first_feature_name> <second_feature_name> [workspace_root]");
  console.error("  kept_plan_ids_json: JSON array of planId values that go to the first new feature");
  process.exit(1);
}

let keptPlanIds;
try {
  keptPlanIds = JSON.parse(keptPlanIdsJson);
} catch (err) {
  console.error(`Invalid kept_plan_ids_json (not valid JSON): ${err.message}`);
  process.exit(1);
}
if (!Array.isArray(keptPlanIds) || keptPlanIds.length === 0 || !keptPlanIds.every(p => typeof p === 'string')) {
  console.error('kept_plan_ids_json must be a non-empty JSON array of planId strings.');
  process.exit(1);
}

const { cliApiCall } = require('../_lib/cli-call');

async function tryViaExtension() {
  const resp = await cliApiCall('POST', '/kanban/feature/split', {
    workspaceRoot,
    featurePlanId,
    keptPlanIds,
    firstFeatureName,
    secondFeatureName
  }, workspaceRoot);
  if (!resp.reachable) return { reachable: false };
  const res = resp.result || {};
  if (resp.success && res.success !== false) {
    return { reachable: true, success: true, firstFeaturePlanId: res.firstFeaturePlanId, secondFeaturePlanId: res.secondFeaturePlanId };
  }
  return { reachable: true, success: false, error: resp.error || res.error || (resp.status ? `HTTP ${resp.status}` : undefined) };
}

(async () => {
  const viaExt = await tryViaExtension();
  if (viaExt.reachable) {
    if (viaExt.success) {
      console.log(JSON.stringify({ ok: true, firstFeaturePlanId: viaExt.firstFeaturePlanId, secondFeaturePlanId: viaExt.secondFeaturePlanId }));
      process.exit(0);
    }
    console.log(JSON.stringify({ ok: false, error: viaExt.error || 'unknown error' }));
    process.exit(1);
  }

  console.log(JSON.stringify({
    ok: false,
    error: 'Switchboard extension not reachable. Feature split requires the running extension (no direct-DB fallback). Open the workspace in VS Code with Switchboard active and retry.'
  }));
  process.exit(1);
})().catch(err => {
  console.log(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
});
