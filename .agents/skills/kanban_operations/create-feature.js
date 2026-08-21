#!/usr/bin/env node
//
// Create a feature from a set of subtask plans and link those plans to it.
//
// Routes through the running Switchboard extension's local API server
// (POST /kanban/feature). The extension performs the create via KanbanProvider, so it
// inherits the DB upsert, subtask linking, feature-file write, and board refresh.
//
// NOTE on sync: feature creation DOES fan out to Linear/ClickUp. createFeatureFromPlanIds
// ends in _syncFeatureOutbound (KanbanProvider.ts), which pushes the feature as a parent
// issue/task and links each subtask as a child. It is gated per tracker on BOTH
// `setupComplete` and `realTimeSyncEnabled` being true — with either off, that tracker is
// skipped silently. A subtask is only linked if its own issue/task already exists; ones
// that don't are skipped and get linked on a later feature-sync trigger. Sync is
// best-effort and never blocks creation. This script inherits all of that via the API.
//
// NOTE on fallback: when the extension is reachable, it is authoritative (handling
// project inheritance, column resolution, Linear/ClickUp sync, and immediate board refresh).
// When unreachable or on stale/alien port collision, create-feature.js falls back to
// writing the feature markdown file directly with <!-- BEGIN SUBTASKS --> subtask links.
// This fallback is safe because PlanIngestionEngine parses declarative subtask links and
// synchronizes kanban.db automatically upon file ingestion.
//
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const featureName = process.argv[2];
const planIdsJson = process.argv[3];
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
    `  node create-feature.js <name> <planIdsJson> /absolute/path/to/workspace [description]`
  );
  process.exit(1);
}
const description = process.argv[5] || undefined;

if (!featureName || !planIdsJson) {
  console.error("Usage: node create-feature.js <feature_name> <plan_ids_json> [workspace_root] [description]");
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
function findApiPortInfo(startDir) {
  let cur = path.resolve(startDir);
  while (true) {
    const portFile = path.join(cur, '.switchboard', 'api-server-port.txt');
    try {
      if (fs.existsSync(portFile)) {
        const port = fs.readFileSync(portFile, 'utf8').trim();
        if (port) return { port, portFile };
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

// ── Route through the running extension. When reachable it is authoritative: a
// logical failure is reported as-is, NOT retried via some other path. ──
async function tryViaExtension() {
  const portInfo = findApiPortInfo(workspaceRoot) || findApiPortInfo(process.cwd());
  if (!portInfo) return { reachable: false };

  try {
    const health = await httpJson('GET', portInfo.port, '/health', null, 2000);
    if (!health || health.status !== 200) {
      return { reachable: false };
    }
    let healthJson = {};
    try { healthJson = JSON.parse(health.body); } catch { /* non-json body */ }
    if (healthJson.status !== 'ok' || healthJson.service !== 'switchboard') {
      // Alien process detected binding to stale port file. Evict dead port file.
      try { if (fs.existsSync(portInfo.portFile)) fs.unlinkSync(portInfo.portFile); } catch { }
      return { reachable: false };
    }
  } catch {
    return { reachable: false };
  }

  try {
    const resp = await httpJson('POST', portInfo.port, '/kanban/feature', {
      workspaceRoot,
      name: featureName,
      planIds,
      description
    }, 15000);
    let parsed = {};
    try { parsed = JSON.parse(resp.body); } catch { /* non-JSON body */ }
    if (resp.status >= 200 && resp.status < 300 && parsed.success) {
      // A 200 does NOT mean every planId was linked. createFeatureFromPlanIds skips
      // planIds that resolve to no plan row and still returns success — historically
      // with no trace in the response at all, so a stale planId produced a blank
      // feature card and an `ok: true`. Treat any skip as a failure, matching the
      // offline fallback below: the same bad input must not succeed just because the
      // extension happens to be running.
      const skipped = Array.isArray(parsed.skipped) ? parsed.skipped : [];
      if (skipped.length > 0) {
        return {
          reachable: true,
          success: false,
          error: `Feature created but ${skipped.length} planId(s) did not resolve to a plan and were not linked: ${skipped.join(', ')}. `
            + `Feature planId ${parsed.featurePlanId} now exists with ${Array.isArray(parsed.linked) ? parsed.linked.length : 0} subtask(s) — `
            + `delete it or link the intended plans, then retry with planId UUIDs from the kanban DB.`,
          featurePlanId: parsed.featurePlanId,
          skipped,
        };
      }
      return { reachable: true, success: true, featurePlanId: parsed.featurePlanId, featureSessionId: parsed.featureSessionId };
    }
    return { reachable: true, success: false, error: parsed.error || `HTTP ${resp.status}` };
  } catch (err) {
    return { reachable: true, success: false, error: err.message };
  }
}

// ── Offline fallback: direct feature file creation with subtask links ──
async function viaDirectFile() {
  const featurePlanId = crypto.randomUUID();
  const slug = featureName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'feature';
  const featuresDir = path.join(workspaceRoot, '.switchboard', 'features');
  if (!fs.existsSync(featuresDir)) {
    fs.mkdirSync(featuresDir, { recursive: true });
  }
  const featureFile = path.join(featuresDir, `${slug}-${featurePlanId}.md`);

  // Resolve every planId to its real plan_file via kanban.db. This is REQUIRED, not
  // best-effort: the fallback's whole safety argument is that PlanIngestionEngine links
  // the subtasks it finds in the SUBTASKS block, and it links them by matching
  // `plan_file`. A guessed path (`../plans/<planId>.md` — plan files are never named
  // after their planId) matches no row, so ingestion links nothing and we would emit a
  // feature with zero subtasks while reporting success. That is precisely the
  // orphaned-feature failure mode the superseded safety note warned about, so an
  // unresolvable planId is a hard error instead.
  const subtaskLines = [];
  const unresolved = [];
  let db;
  try {
    const { KanbanDatabase } = require('../../../out/services/KanbanDatabase');
    db = KanbanDatabase.forWorkspace(workspaceRoot);
    await db.ensureReady();
  } catch (err) {
    throw new Error(
      `Offline fallback needs kanban.db to resolve plan file paths, but the database module ` +
      `could not be loaded (${err.message}). Build the extension (npm run compile-tests) or ` +
      `start Switchboard so the API path can be used instead.`
    );
  }
  try {
    for (const pid of planIds) {
      const plan = await db.getPlanByPlanId(pid);
      if (plan && plan.planFile) {
        const basename = path.basename(plan.planFile);
        const topic = plan.topic || basename;
        subtaskLines.push(`- [ ] [${topic}](../plans/${basename})`);
      } else {
        unresolved.push(pid);
      }
    }
  } finally {
    if (db && typeof db.close === 'function') db.close();
  }
  if (unresolved.length > 0) {
    throw new Error(
      `Cannot resolve ${unresolved.length} planId(s) to a plan file in kanban.db: ` +
      `${unresolved.join(', ')}. Pass planId UUIDs from the kanban DB (not filenames); ` +
      `writing the feature file with unresolvable links would create a feature with no subtasks.`
    );
  }

  const descText = description || `Implementation plan for ${featureName}.`;
  const subtasksBlock = subtaskLines.join('\n');

  const content = `---
description: '${featureName.replace(/'/g, "''")}'
---

# ${featureName}

## Goal

${descText}

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
${subtasksBlock}
<!-- END SUBTASKS -->
`;

  fs.writeFileSync(featureFile, content, 'utf8');
  return { ok: true, featurePlanId, featureFile };
}

(async () => {
  const viaExt = await tryViaExtension();
  if (viaExt.reachable) {
    if (viaExt.success) {
      console.log(JSON.stringify({ ok: true, featurePlanId: viaExt.featurePlanId, featureSessionId: viaExt.featureSessionId }));
      process.exit(0);
    }
    console.log(JSON.stringify({
      ok: false,
      error: viaExt.error || 'unknown error',
      ...(viaExt.featurePlanId ? { featurePlanId: viaExt.featurePlanId } : {}),
      ...(viaExt.skipped ? { skipped: viaExt.skipped } : {}),
    }));
    process.exit(1);
  }

  // Extension not reachable — fallback to direct markdown feature file creation
  const fallbackResult = await viaDirectFile();
  console.log(JSON.stringify({
    ok: true,
    featurePlanId: fallbackResult.featurePlanId,
    featureFile: fallbackResult.featureFile,
    fallback: true
  }));
  process.exit(0);
})().catch(err => {
  console.log(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
});
