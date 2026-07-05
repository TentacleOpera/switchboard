#!/usr/bin/env node
//
// Delete a feature and optionally its subtasks.
//
// Routes through the running Switchboard extension's local API server
// (POST /kanban/feature/delete). The extension performs the deletion via
// KanbanProvider._deleteEpic, so it inherits the worktree cleanup, subtask
// detach/tombstone, feature tombstone, board refresh, and external tracker
// unlinking.
//
// Usage: node delete-feature.js <feature_plan_id> [delete_subtasks] [workspace_root]
//   delete_subtasks: 'true' or 'false' (default: false — subtasks are detached, not deleted)
//
const fs = require('fs');
const path = require('path');
const http = require('http');

const epicPlanId = process.argv[2];
const deleteSubtasksArg = process.argv[3] || 'false';
const workspaceRoot = process.argv[4] || '.';

if (!epicPlanId) {
  console.error("Usage: node delete-feature.js <feature_plan_id> [delete_subtasks] [workspace_root]");
  console.error("  delete_subtasks: 'true' or 'false' (default: false — subtasks are detached, not deleted)");
  process.exit(1);
}

const deleteSubtasks = deleteSubtasksArg === 'true';

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
    const resp = await httpJson('POST', port, '/kanban/feature/delete', {
      workspaceRoot,
      epicPlanId,
      deleteSubtasks
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
    error: 'Switchboard extension not reachable. Feature deletion requires the running extension (no direct-DB fallback). Open the workspace in VS Code with Switchboard active and retry.'
  }));
  process.exit(1);
})().catch(err => {
  console.log(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
});
