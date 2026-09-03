#!/usr/bin/env node
//
// Declarative, path/slug-addressed feature reconciliation (Feature A · A3).
//
// Converges the whole feature structure to a desired end state in ONE idempotent
// call. Plans are addressed by file path / slug / topic / planId — never a raw
// UUID the agent must discover. Routes through the running extension's
// POST /kanban/features/reconcile endpoint.
//
// Usage:
//   node reconcile-features.js <workspace_root> '<reconcile_json>'
//
// reconcile_json shape:
//   {
//     "removeUnmentionedFeatures": false,
//     "features": [
//       {
//         "name": "My Feature",
//         "description": "optional",
//         "subtasks": [
//           ".switchboard/plans/my-plan.md",        // path
//           "my-plan-slug",                          // slug / topic
//           "eb75281d-…",                            // planId (also accepted)
//           { "slug": "new-plan", "title": "New Plan", "body": "## Goal\n…" }  // inline new plan
//         ]
//       }
//     ]
//   }
//
// Re-running the same input is a no-op (converges to the same state) — safe to retry.
// Prints JSON: { ok, features?, mutations?, warnings?, error? }
//
const fs = require('fs');
const path = require('path');
const http = require('http');

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
    `  node reconcile-features.js /absolute/path/to/workspace`
  );
  process.exit(1);
}
const reconcileJson = process.argv[3];

if (!reconcileJson) {
  console.error("Usage: node reconcile-features.js <workspace_root> '<reconcile_json>'");
  console.error("  reconcile_json: { features: [{ name, description?, subtasks: [path|slug|planId|{slug,title,body}] }] }");
  process.exit(1);
}

let body;
try {
  body = JSON.parse(reconcileJson);
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: `Invalid reconcile JSON: ${err.message}` }));
  process.exit(1);
}

const { cliApiCall } = require('../_lib/cli-call');

(async () => {
  try {
    const resp = await cliApiCall('POST', '/kanban/features/reconcile', { workspaceRoot, ...body }, workspaceRoot);
    if (!resp.reachable) {
      console.log(JSON.stringify({ ok: false, error: 'Switchboard extension not reachable. Open the workspace in VS Code with Switchboard active and retry.' }));
      process.exit(1);
    }
    const res = resp.result || {};
    if (resp.success && res.success !== false) {
      console.log(JSON.stringify({ ok: true, features: res.features, mutations: res.mutations, warnings: res.warnings }));
      process.exit(0);
    }
    console.log(JSON.stringify({ ok: false, error: resp.error || res.error || (resp.status ? `HTTP ${resp.status}` : undefined), mutations: res.mutations, warnings: res.warnings }));
    process.exit(1);
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: err.message }));
    process.exit(1);
  }
})();
