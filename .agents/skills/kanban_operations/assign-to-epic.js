#!/usr/bin/env node
//
// Assign existing plans to an existing epic (batch). Plans already on another epic
// (or that are themselves epics / missing) are reported in `skipped`, not failed.
//
// Routes through the running Switchboard extension's local API server
// (POST /kanban/epic/assign). The extension links each subtask, regenerates the epic
// file, and refreshes the board once.
//
// NOTE on fallback: like create-epic.js, there is no direct-DB fallback. Assignment
// must also regenerate the epic markdown file (KanbanProvider logic, not reachable
// from a standalone Node process), so a raw-DB link would leave the epic file stale.
// When the extension isn't reachable, this fails with a clear instruction to start it.
//
const fs = require('fs');
const path = require('path');
const http = require('http');

const epicPlanId = process.argv[2];
const planIdsJson = process.argv[3];
const workspaceRoot = process.argv[4] || '.';

if (!epicPlanId || !planIdsJson) {
  console.error("Usage: node assign-to-epic.js <epic_plan_id> <plan_ids_json> [workspace_root]");
  console.error('  plan_ids_json is a JSON array of planId values, e.g. \'["abc-123","def-456"]\'');
  process.exit(1);
}

let planIds;
try {
  planIds = JSON.parse(planIdsJson);
} catch (err) {
  console.error(`Invalid plan_ids_json (not valid JSON): ${err.message}`);
  process.exit(1);
}
if (!Array.isArray(planIds) || planIds.length === 0 || !planIds.every(p => typeof p === 'string')) {
  console.error('plan_ids_json must be a non-empty JSON array of planId strings.');
  process.exit(1);
}

// ── Discover the running extension's API server: walk up for the port file. ──
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

// ── Route through the running extension. When reachable it is authoritative. ──
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
    const resp = await httpJson('POST', port, '/kanban/epic/assign', {
      workspaceRoot,
      epicPlanId,
      planIds
    }, 15000);
    let parsed = {};
    try { parsed = JSON.parse(resp.body); } catch { /* non-JSON body */ }
    if (resp.status >= 200 && resp.status < 300 && parsed.success) {
      return { reachable: true, success: true, assigned: parsed.assigned || [], skipped: parsed.skipped || [] };
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
      console.log(JSON.stringify({ ok: true, assigned: viaExt.assigned, skipped: viaExt.skipped }));
      process.exit(0);
    }
    console.log(JSON.stringify({ ok: false, error: viaExt.error || 'unknown error' }));
    process.exit(1);
  }

  // Extension not reachable — no safe direct-DB fallback for epic assignment.
  console.log(JSON.stringify({
    ok: false,
    error: 'Switchboard extension not reachable. Epic assignment requires the running extension (no direct-DB fallback). Open the workspace in VS Code with Switchboard active and retry.'
  }));
  process.exit(1);
})().catch(err => {
  console.log(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
});
