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
const workspaceRoot = process.argv[6] || '.';

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

function findApiPort(startDir) {
  let cur = path.resolve(startDir);
  while (true) {
    const portFile = path.join(cur, '.switchboard', 'api-server-port.txt');
    try {
      if (fs.existsSync(portFile)) {
        const port = fs.readFileSync(portFile, 'utf8').trim();
        if (port) return port;
      }
    } catch { /* ignore and keep walking */ }
    const next = path.dirname(cur);
    if (next === cur) return null;
    cur = next;
  }
}

function httpJson(method, port, urlPath, bodyObj, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = bodyObj ? JSON.stringify(bodyObj) : '';
    const req = http.request(
      {
        host: '127.0.0.1',
        port: Number(port),
        path: urlPath,
        method,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on('error', reject);
    if (timeoutMs) { req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout'))); }
    if (payload) req.write(payload);
    req.end();
  });
}

async function tryViaExtension() {
  const port = findApiPort(workspaceRoot) || findApiPort(process.cwd());
  if (!port) return { reachable: false };

  try {
    const health = await httpJson('GET', port, '/health', null, 2000);
    if (!health || health.status !== 200) return { reachable: false };
  } catch {
    return { reachable: false };
  }

  try {
    const resp = await httpJson('POST', port, '/kanban/feature/split', {
      workspaceRoot,
      featurePlanId,
      keptPlanIds,
      firstFeatureName,
      secondFeatureName
    }, 30000);
    let parsed = {};
    try { parsed = JSON.parse(resp.body); } catch { /* non-JSON body */ }
    if (resp.status >= 200 && resp.status < 300 && parsed.success) {
      return { reachable: true, success: true, firstFeaturePlanId: parsed.firstFeaturePlanId, secondFeaturePlanId: parsed.secondFeaturePlanId };
    }
    return { reachable: true, success: false, error: parsed.error || `HTTP ${resp.status}` };
  } catch (err) {
    return { reachable: true, success: false, error: err.message };
  }
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
