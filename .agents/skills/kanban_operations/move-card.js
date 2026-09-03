#!/usr/bin/env node
//
// Move a kanban card to a target column. Feature-aware: when the card is a feature,
// all of its subtasks cascade to the same column.
//
//
// Route through the running Switchboard host's local API server (POST /kanban/move).
// The host performs the move via KanbanProvider, so it inherits the feature cascade,
// the Linear/ClickUp integration-sync fan-out, and the board refresh.
//

const fs = require('fs');
const path = require('path');
const http = require('http');

const effectiveKey = process.argv[2];
const targetColumn = process.argv[3];
const optionalPlanFile = process.argv[4];
let resolveWorkspaceRoot;
try {
  ({ resolveWorkspaceRoot } = require('../_lib/workspace-root'));
} catch {
  // Partial .agents/ sync — degrade to the old behaviour rather than crash.
  resolveWorkspaceRoot = (explicit) =>
    path.resolve(explicit && explicit !== '.' ? explicit : process.cwd());
}
const workspaceRoot = resolveWorkspaceRoot(process.argv[5]);
if (!workspaceRoot) {
  console.error(
    `No Switchboard workspace found from ${process.cwd()} — no .switchboard/kanban.db ` +
    `in this directory or any parent below your home directory.\n` +
    `Pass the workspace root explicitly:\n` +
    `  node move-card.js <plan> <column> "" /absolute/path/to/workspace`
  );
  process.exit(1);
}

if (!effectiveKey || !targetColumn) {
  console.error('Usage: node move-card.js <session_id|plan_id|plan_file> <target_column> [plan_file] [workspace_root]');
  process.exit(1);
}

let resolvedPlanFile = optionalPlanFile;
if (effectiveKey && (effectiveKey.includes('/') || effectiveKey.endsWith('.md'))) {
  resolvedPlanFile = effectiveKey;
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

// ── Path 1: route through the running extension (exact sync). ──
// Returns { reachable, success?, error? }. When the extension is reachable it is
// authoritative — we do NOT fall back to the raw DB on a logical failure (that
// would bypass guards the extension applied on purpose).
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
    const move = await httpJson('POST', port, '/kanban/move', {
      sessionId: effectiveKey,
      targetColumn,
      workspaceRoot,
      planFile: resolvedPlanFile || undefined
    }, 15000);
    let parsed = {};
    try { parsed = JSON.parse(move.body); } catch { /* non-JSON body */ }
    if (move.status >= 200 && move.status < 300 && parsed.success) {
      return { reachable: true, success: true };
    }
    return { reachable: true, success: false, error: parsed.error || `HTTP ${move.status}` };
  } catch (err) {
    return { reachable: true, success: false, error: err.message };
  }
}

(async () => {
  const viaExt = await tryViaExtension();
  if (viaExt.success) {
    console.log('OK');
    process.exit(0);
  }
  console.error(viaExt.reachable
    ? `Move failed: ${viaExt.error || 'unknown error'}`
    : 'Move failed: no Switchboard host is reachable. Start the board (or the standalone '
      + 'host) and retry — a card move goes through the same code path a human click takes.');
  console.log('FAILED');
  process.exit(1);
})().catch(err => {
  console.error(err);
  process.exit(1);
});

