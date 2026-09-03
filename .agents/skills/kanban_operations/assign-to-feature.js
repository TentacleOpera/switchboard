#!/usr/bin/env node
//
// Assign existing plans to an existing feature (batch). Plans already on another feature
// (or that are themselves features / missing) are reported in `skipped`, not failed.
//
// Routes through the running Switchboard extension's local API server
// (POST /kanban/feature/assign). The extension links each subtask, regenerates the feature
// file, and refreshes the board once.
//
// NOTE on fallback: like create-feature.js, there is no direct-DB fallback. Assignment
// must also regenerate the feature markdown file (KanbanProvider logic, not reachable
// from a standalone Node process), so a raw-DB link would leave the feature file stale.
// When the extension isn't reachable, this fails with a clear instruction to start it.
//
const fs = require('fs');
const path = require('path');
const http = require('http');

const featureRef = process.argv[2];
const planRefOrJson = process.argv[3];
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
    `  node assign-to-feature.js <feature> <plan_or_plan_ids_json> /absolute/path/to/workspace`
  );
  process.exit(1);
}

if (!featureRef || !planRefOrJson) {
  console.error("Usage: node assign-to-feature.js <feature> <plan_or_plan_ids_json> [workspace_root]");
  console.error('  <feature> can be a feature planId, file path, or feature name/slug.');
  console.error('  <plan_or_plan_ids_json> is either a single plan ref (path/slug/id) or a JSON array of refs, e.g. \'["abc-123","def-456"]\'');
  process.exit(1);
}

let body;
if (planRefOrJson.trim().startsWith('[')) {
  let planRefs;
  try {
    planRefs = JSON.parse(planRefOrJson);
  } catch (err) {
    console.error(`Invalid plan_ids_json (not valid JSON): ${err.message}`);
    process.exit(1);
  }
  if (!Array.isArray(planRefs) || planRefs.length === 0 || !planRefs.every(p => typeof p === 'string')) {
    console.error('plan_ids_json must be a non-empty JSON array of plan strings.');
    process.exit(1);
  }
  body = { workspaceRoot, feature: featureRef, plans: planRefs };
} else {
  body = { workspaceRoot, feature: featureRef, plan: planRefOrJson.trim() };
}

const { cliApiCall } = require('../_lib/cli-call');

async function tryViaExtension() {
  const resp = await cliApiCall('POST', '/kanban/features/assign', body, workspaceRoot);
  if (!resp.reachable) return { reachable: false };
  const res = resp.result || {};
  if (resp.success && res.success !== false) {
    return { reachable: true, success: true, assigned: res.assigned || [], skipped: res.skipped || [] };
  }
  return { reachable: true, success: false, error: resp.error || res.error || (resp.status ? `HTTP ${resp.status}` : undefined) };
}

(async () => {
  const viaExt = await tryViaExtension();
  if (viaExt.reachable) {
    if (viaExt.success) {
      console.log(JSON.stringify({ ok: true, assigned: viaExt.assigned, skipped: viaExt.skipped }));
      process.exit(0);
    }
    console.log(JSON.stringify({ ok: false, error: viaExt.error || 'unknown error' }));
    process.exit(1);
  }

  // Extension not reachable — no safe direct-DB fallback for feature assignment.
  console.log(JSON.stringify({
    ok: false,
    error: 'Switchboard extension not reachable. Feature assignment requires the running extension (no direct-DB fallback). Open the workspace in VS Code with Switchboard active and retry.'
  }));
  process.exit(1);
})().catch(err => {
  console.log(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
});
