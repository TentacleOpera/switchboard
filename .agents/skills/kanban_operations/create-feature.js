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

const { cliApiCall } = require('../_lib/cli-call');

// ── Route through the running extension. When reachable it is authoritative: a
// logical failure is reported as-is, NOT retried via some other path. ──
async function tryViaExtension() {
  const resp = await cliApiCall('POST', '/kanban/feature', {
    workspaceRoot,
    name: featureName,
    planIds,
    description
  }, workspaceRoot);
  if (!resp.reachable) return { reachable: false };
  const res = resp.result || {};
  if (resp.success && res.success !== false) {
    return { reachable: true, success: true, featurePlanId: res.featurePlanId, featureSessionId: res.featureSessionId };
  }
  return { reachable: true, success: false, error: resp.error || res.error || (resp.status ? `HTTP ${resp.status}` : undefined) };
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

  // Resolve every planId to a real plan_file. A planId that resolves to nothing
  // must ABORT — it must never become a guessed `../plans/<planId>.md` link.
  //
  // That guess matches no row, so ingestion links nothing and the caller is handed
  // an orphaned feature card while the script reports ok:true. The abort used to be
  // supplied by accident: before consolidation `forWorkspace(workspaceRoot)` opened
  // `<workspaceRoot>/.switchboard/kanban.db`, which does not exist outside a real
  // workspace, so ensureReady() returned false and the whole thing failed loudly.
  // Every workspace now resolves to the one global store, which always exists and is
  // always ready — so the accident is gone and the guard has to be written down.
  const subtaskLines = [];
  const unresolved = [];
  let resolverError = null;
  try {
    const { KanbanDatabase } = require('../../../out/services/KanbanDatabase');
    const db = KanbanDatabase.forWorkspace(workspaceRoot);
    if (!(await db.ensureReady())) {
      throw new Error(`kanban database not ready: ${db.lastInitError || 'unknown reason'}`);
    }
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
    if (typeof db.dispose === 'function') db.dispose();
    else if (typeof db.close === 'function') db.close();
  } catch (e) {
    // The resolver itself failed, so NOTHING is resolved. Writing basic plan links
    // here was the same silent-orphan bug by another route.
    resolverError = e && e.message ? e.message : String(e);
  }

  if (resolverError) {
    return { ok: false, error: `Cannot resolve planIds — ${resolverError}` };
  }
  if (unresolved.length > 0) {
    return { ok: false, error: `Cannot resolve planId(s): ${unresolved.join(', ')}` };
  }

  const descText = description || `Implementation plan for ${featureName}.`;
  const subtasksBlock = subtaskLines.length > 0 ? subtaskLines.join('\n') : '- [ ] (no subtasks)';

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
    console.log(JSON.stringify({ ok: false, error: viaExt.error || 'unknown error' }));
    process.exit(1);
  }

  // Extension not reachable — fallback to direct markdown feature file creation
  const fallbackResult = await viaDirectFile();
  if (!fallbackResult.ok) {
    console.log(JSON.stringify({ ok: false, error: fallbackResult.error, fallback: true }));
    process.exit(1);
  }
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
