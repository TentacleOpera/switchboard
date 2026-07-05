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
const workspaceRoot = process.argv[3] || '.';

if (!subtaskPlanId) {
  console.error("Usage: node remove-from-feature.js <subtask_plan_id> [workspace_root]");
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
    const resp = await httpJson('POST', port, '/kanban/feature/remove', {
      workspaceRoot,
      subtaskPlanId
    }, 15000);
    let parsed = {};
    try { parsed = JSON.parse(resp.body); } catch { /* non-JSON body */ }
    if (resp.status >= 200 && resp.status < 300 && parsed.success) {
      return { reachable: true, success: true };
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
