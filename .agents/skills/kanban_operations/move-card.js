#!/usr/bin/env node
//
// Move a kanban card to a target column. Feature-aware: when the card is an feature,
// all of its subtasks cascade to the same column.
//
// Two paths, tried in order:
//   1. Preferred — route through the running Switchboard extension's local API
//      server. The extension performs the move via KanbanProvider, so it inherits
//      the feature cascade, the Linear/ClickUp integration-sync fan-out, and the board
//      refresh. This is the ONLY way external trackers stay in exact sync, because
//      the integration token lives in VS Code secret storage and is unreachable
//      from a standalone Node process.
//   2. Fallback — when the extension isn't running (no reachable API server), write
//      the kanban DB directly. This still cascades subtasks, but does NOT sync to
//      Linear/ClickUp (no token), and if real-time sync is enabled the change may be
//      reconciled away on the next inbound poll. Recovery use only.
//
const fs = require('fs');
const path = require('path');
const http = require('http');

const effectiveKey = process.argv[2];
const targetColumn = process.argv[3];
const optionalPlanFile = process.argv[4];
const workspaceRoot = process.argv[5] || '.';

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

// ── Path 2: direct DB write (no integration sync). ──
async function viaDirectDb() {
  // Lazy require so Path 1 works even where the compiled output isn't present.
  const { KanbanDatabase, VALID_KANBAN_COLUMNS } = require('../../../out/services/KanbanDatabase');

  if (!VALID_KANBAN_COLUMNS.has(targetColumn)) {
    console.error(`Invalid column: ${targetColumn}`);
    console.error(`Valid columns: ${Array.from(VALID_KANBAN_COLUMNS).join(', ')}`);
    process.exit(1);
  }

  const db = KanbanDatabase.forWorkspace(workspaceRoot);
  await db.ensureReady();

  let plan;
  if (resolvedPlanFile) {
    // getPlanByPlanFile requires the DB workspace_id (a UUID), NOT the workspace root path.
    // Resolve it from the DB config / dominant workspace before querying.
    const wsId = await db.getWorkspaceId() || await db.getDominantWorkspaceId() || '';
    plan = await db.getPlanByPlanFile(resolvedPlanFile, wsId);
  } else {
    plan = await db.getPlanBySessionId(effectiveKey);
  }

  let columnSuccess;
  if (plan && plan.isFeature) {
    // Prefer the atomic, race-free cascadeFeatureByPlanId (Plan 2). Fall back to
    // updateColumnWithFeatureCascadeByPlanId only if it's missing — note the signatures
    // differ (the latter requires an explicit subtaskPlanIds[] array).
    if (typeof db.cascadeFeatureByPlanId === 'function') {
      columnSuccess = await db.cascadeFeatureByPlanId(plan.planId, targetColumn);
    } else {
      const subtasks = await db.getSubtasksByFeatureId(plan.planId);
      const subtaskPlanIds = subtasks.map(st => st.planId).filter(Boolean);
      columnSuccess = await db.updateColumnWithFeatureCascadeByPlanId(plan.planId, subtaskPlanIds, targetColumn);
    }
  } else if (plan) {
    columnSuccess = await db.updateColumnByPlanFile(plan.planFile, plan.workspaceId, targetColumn);
  } else {
    columnSuccess = await db.updateColumn(effectiveKey, targetColumn);
  }

  let planFileSuccess = true;
  if (resolvedPlanFile) {
    planFileSuccess = await db.updatePlanFile(plan ? plan.sessionId : effectiveKey, resolvedPlanFile);
  }

  if (typeof db.close === 'function') db.close();
  return columnSuccess && planFileSuccess;
}

(async () => {
  const viaExt = await tryViaExtension();
  if (viaExt.reachable) {
    if (viaExt.success) {
      console.log('OK');
      process.exit(0);
    }
    console.error(`Move via extension failed: ${viaExt.error || 'unknown error'}`);
    console.log('FAILED');
    process.exit(1);
  }

  // Extension not reachable — direct DB fallback (no Linear/ClickUp sync).
  const ok = await viaDirectDb();
  console.log(ok ? 'OK' : 'FAILED');
  process.exit(ok ? 0 : 1);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
