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

const workspaceRoot = process.argv[2] || '.';
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

function findApiPort(startDir) {
  let cur = path.resolve(startDir);
  while (true) {
    const portFile = path.join(cur, '.switchboard', 'api-server-port.txt');
    try {
      if (fs.existsSync(portFile)) {
        const port = fs.readFileSync(portFile, 'utf8').trim();
        if (port) return port;
      }
    } catch { /* keep walking */ }
    const next = path.dirname(cur);
    if (next === cur) return null;
    cur = next;
  }
}

function httpJson(method, port, urlPath, bodyObj, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = bodyObj ? JSON.stringify(bodyObj) : '';
    const req = http.request(
      { host: '127.0.0.1', port: Number(port), path: urlPath, method,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => { let data = ''; res.on('data', (c) => { data += c; }); res.on('end', () => resolve({ status: res.statusCode, body: data })); }
    );
    req.on('error', reject);
    if (timeoutMs) { req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout'))); }
    if (payload) req.write(payload);
    req.end();
  });
}

(async () => {
  const port = findApiPort(workspaceRoot) || findApiPort(process.cwd());
  if (!port) {
    console.log(JSON.stringify({ ok: false, error: 'Switchboard extension not reachable (no .switchboard/api-server-port.txt). Open the workspace in VS Code with Switchboard active and retry.' }));
    process.exit(1);
  }
  try {
    const resp = await httpJson('POST', port, '/kanban/features/reconcile',
      { workspaceRoot, ...body }, 30000);
    let parsed = {};
    try { parsed = JSON.parse(resp.body); } catch { /* non-JSON */ }
    if (resp.status >= 200 && resp.status < 300 && parsed.success) {
      console.log(JSON.stringify({ ok: true, features: parsed.features, mutations: parsed.mutations, warnings: parsed.warnings }));
      process.exit(0);
    }
    console.log(JSON.stringify({ ok: false, error: parsed.error || `HTTP ${resp.status}`, mutations: parsed.mutations, warnings: parsed.warnings }));
    process.exit(1);
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: err.message }));
    process.exit(1);
  }
})();
