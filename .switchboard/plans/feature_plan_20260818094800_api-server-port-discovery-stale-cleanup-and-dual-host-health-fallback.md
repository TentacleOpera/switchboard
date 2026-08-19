# Declarative File-Based Feature Ingestion, API Port Lifecycle, and Dual-Host Fallbacks

## Goal
Feature management and CLI automation in Switchboard must be completely declarative and resilient to offline/remote environments. Currently, two major gaps cause feature creation and script execution to fail when operating via direct file operations or when the local API server is unavailable:

1. **Feature Markdown File Ingestion Gaps**: When a feature file is written or edited directly in `.switchboard/features/` with subtask links (e.g. `- [ ] [Title](../plans/plan.md)` under `## Subtasks` or `<!-- BEGIN SUBTASKS -->`), `PlanIngestionEngine` imports the feature row (`is_feature = 1`) but completely ignores the subtask list inside the markdown file. Subtasks in `kanban.db` remain with `feature_id = ''`, causing the board to display "0 subtasks" unless an active API server endpoint (`assignPlansToFeature`) is called. Feature creation and subtask linking MUST be fully achievable and authoritative via standard file operations.
2. **Stale API Port Collisions & Stalled CLI Tools**: When Switchboard (VS Code extension or `npx switchboard` standalone host) terminates ungracefully, `.switchboard/api-server-port.txt` survives on disk. When alien local processes (such as Electron apps or Chrome) bind to that recycled port, direct IP requests reject with `403 Direct IP access is not allowed`. CLI scripts (`create-feature.js`, `move-card.js`, etc.) fail with fatal errors instead of verifying process signatures, auto-evicting the dead port file, and falling back to direct file operations.

This plan establishes full file-based feature/subtask ingestion parity in `PlanIngestionEngine`, cleans up API port lifecycles across both hosts, and makes all kanban operations resilient.

### Problem & Root Cause Analysis
1. **Unparsed Subtask Blocks in `PlanIngestionEngine.ts`**: In `PlanIngestionEngine.ts`, when a file under `.switchboard/features/` is ingested (`_handlePlanFile`, ~line 1539), it extracts topic and frontmatter, sets `isFeature = 1`, and calls `updateFeatureStatus(planId, 1, '')` + `_retryPendingFeatureLinks` (~lines 1677-1683, 1725-1731). But it never parses the subtask list in `<!-- BEGIN SUBTASKS -->`. Subtask linking only happens via `metadata.feature` frontmatter on subtask plan files (`_applyFeatureLink` at ~line 1758, which explicitly skips files under `features/` at ~line 974). As a result, direct file writes to `.switchboard/features/` create features with 0 linked subtasks in the database.
2. **Missing Process Termination Handlers in Standalone NPX Host**: In `src/standalone/bootstrap.ts` (~line 2492), `api-server-port.txt` is written on boot, and the returned `stop()` (~line 2552) unlinks it — but `stop()` is only called on graceful shutdown. No `SIGINT`, `SIGTERM`, `SIGHUP`, or `exit` handlers are installed, so a signal-killed process leaves the port file on disk.
3. **No Offline Fallback in `create-feature.js`**: `create-feature.js` (lines 17-21) documents that no direct-DB fallback is deliberate, and hard-exits with code 1 if the API server is unreachable, rather than falling back to writing the standard `.switchboard/features/{slug}-{planId}.md` file directly.

> **Superseded:** `create-feature.js` lines 17-21 — "unlike move-card.js, there is no direct-DB fallback. Feature creation spans project inheritance, column resolution, a YAML-safe file write, and per-subtask linking — replicating that in raw DB calls risks an orphaned feature (DB record with no file, or unlinked subtasks). So when the extension isn't reachable, this fails with a clear instruction to start it rather than writing a half-formed feature."
> **Reason:** The safety concern was valid *before* file-based subtask ingestion was authoritative. Once this plan's `PlanIngestionEngine` change (deliverable 1) lands, a directly-written feature file with `<!-- BEGIN SUBTASKS -->` links is ingested correctly — subtask `feature_id` is set by the watcher, so the "unlinked subtasks" failure mode is closed. The remaining concerns (project inheritance, column resolution, Linear/ClickUp real-time sync) are intentionally out of scope for the offline path — this matches the existing `create-feature` *skill* (remote), which already writes feature files directly when the extension is unreachable. `move-card.js` already has a `viaDirectDb()` fallback precedent (line 194).
> **Replaced with:** A file-write fallback in `create-feature.js` that writes the feature file in the exact format `PlanIngestionEngine` parses (subtask links under `<!-- BEGIN SUBTASKS -->`), lets ingestion link subtasks, and explicitly skips project inheritance / column resolution / remote sync (extension-only). The stale safety comment is updated to reflect that the fallback is safe *because* ingestion is now authoritative.

## Metadata
- **Complexity:** 6
- **Tags:** backend, cli, infrastructure, reliability, bugfix
- **Project:** Browser Switchboard

## User Review Required
- **Confirm the create-feature.js fallback contract**: the offline path will write the feature file + let ingestion link subtasks, but will NOT perform project inheritance, kanban column resolution, or Linear/ClickUp real-time sync (those remain extension-only). This matches the remote `create-feature` skill's contract. Proceeding on the assumption that this is acceptable — it is the same tradeoff already shipped in the remote skill.

## Complexity Audit

### Routine
- Adding `service: 'switchboard'` + `pid` to the `/health` JSON response (`LocalApiServer.ts` ~line 4367).
- Installing `SIGINT`/`SIGTERM`/`SIGHUP` signal handlers + sync `process.on('exit')` unlink backstop in `bootstrap.ts` (reusing the existing `stop()`).
- Parsing `<!-- BEGIN SUBTASKS -->` / `## Subtasks` link lines in `PlanIngestionEngine._handlePlanFile` (regex over markdown content).
- Updating `cli.ts:probeHealth` and `create-feature.js` health check to parse JSON and verify `service === 'switchboard'`, unlinking stale port files on alien detection.

### Complex / Risky
- **New `syncFeatureSubtasksByPaths` DB method** — does not exist today; must be added to `KanbanDatabase` with a bidirectional contract (link new, unlink removed) AND a cross-feature guard (never steal a plan whose `feature_id` is a *different* feature; only unlink plans whose `feature_id === this feature`).
- **Bidirectional subtask sync via file edits** — adding/removing a subtask link in a feature file must update `feature_id` in `kanban.db` without wiping plans assigned to other features.
- **create-feature.js fallback safety supersession** — overriding a documented deliberate safety decision; the fallback is only safe because deliverable 1 lands first. Ordering dependency.

## Edge-Case & Dependency Audit
- **Race Conditions**: `PlanIngestionEngine` debounces file events 300ms (`_handlePlanFile` ~line 945). A feature file and its subtask plans written in quick succession must not race — `_retryPendingFeatureLinks` (~line 1530) already retries up to `MAX_FEATURE_LINK_RETRIES` (5) for subtasks whose feature row isn't yet imported. The new push-path linking must reuse the same retry/defer mechanism when a linked subtask plan isn't imported yet.
- **Security**: `/health` exposing `pid: process.pid` is loopback-only (server binds 127.0.0.1 unconditionally, per `bootstrap.ts` ~line 2502). Acceptable. The `service` signature is a liveness proof, not a secret.
- **Side Effects**: `syncFeatureSubtasksByPaths` MUST NOT reset `feature_id` on plans linked to *other* features. A plan removed from feature A's file must only be unlinked if its current `feature_id === A`. A plan added to feature A's file whose `feature_id` is already feature B must be skipped (or logged) — never silently stolen.
- **Dependencies & Conflicts**:
  - Deliverable 3 (create-feature.js fallback) depends on deliverable 1 (ingestion subtask parsing) for safety. Land 1 before 3.
  - Deliverable 2 (port lifecycle) is independent of 1 and 3.
  - The existing pull path (`_applyFeatureLink` via subtask `**Feature:**` frontmatter) MUST continue to work — the new push path is additive, not a replacement.
  - `is_feature` is sticky via the upsert `ON CONFLICT` clause (`KanbanDatabase.ts` ~line 870) — once 1, only `updateFeatureStatus(planId, 0, '')` clears it. The new sync method must use `updateFeatureStatus`, not raw SQL, to respect this.
- **Alien Service on Same Port**: Probing `/health` must verify JSON `status === 'ok'` AND `service === 'switchboard'`. HTML, 403, or missing `service` ⇒ alien process ⇒ unlink `api-server-port.txt`.
- **Dual-Host Parity**: Standalone NPX (`npx switchboard`) and the VS Code extension must behave identically for port cleanup, database locking, and file ingestion. The extension host's port-file cleanup path must be audited for the same signal-handler gap (this plan touches standalone; if the extension host has the same gap, flag it as a follow-up).

## Dependencies
- None (no upstream plan must land first; this plan is self-contained). Deliverable 3 depends on deliverable 1 *within this plan*.

## Adversarial Synthesis
Key risks: (1) the plan's centerpiece calls `db.syncFeatureSubtasksByPaths` — a method that does not exist in `KanbanDatabase` and must be authored with a bidirectional + cross-feature-guard contract; (2) the `create-feature.js` fallback overrides a documented deliberate safety decision and is only safe because ingestion becomes authoritative (ordering dependency); (3) the `/health` `service` signature is broadcast but `cli.ts:probeHealth` and `create-feature.js`'s health check do not read it — alien detection is vapor unless both probes are updated. Mitigations: specify the DB method contract in this plan, supersede the safety comment explicitly, and add the probe updates to Proposed Changes.

## Proposed Changes

### `src/services/KanbanDatabase.ts` — NEW method `syncFeatureSubtasksByPaths`
- **Context**: No method exists today to reconcile a feature's subtask set from a list of plan-file relative paths. The plan's original code called `db.syncFeatureSubtasksByPaths(...)` against a phantom method.
- **Logic**: Given `featurePlanId`, `linkedPaths: string[]` (relative paths like `.switchboard/plans/foo.md`), and `workspaceId`:
  1. Resolve each `linkedPath` to a plan row via `plan_file` match (relative path, forward-slashed).
  2. For each resolved plan: if its `feature_id` is empty OR equals `featurePlanId`, set `feature_id = featurePlanId` via `updateFeatureStatus(planId, 0, featurePlanId)`. If its `feature_id` is a *different* non-empty feature, skip and log (do not steal).
  3. For plans currently linked to this feature (`getSubtasksByFeatureId(featurePlanId)`) whose `plan_file` is NOT in `linkedPaths`: reset `feature_id = ''` via `updateFeatureStatus(planId, 0, '')`.
- **Edge Cases**: plan not yet imported (path resolves to no row) — defer via the existing `_pendingFeatureLinks` retry mechanism in `PlanIngestionEngine`, or log and skip (ingestion will re-fire on the subtask file's own write). Cross-feature guard prevents stealing. `is_feature` stickiness respected (uses `updateFeatureStatus`, not raw SQL).

### `src/services/PlanIngestionEngine.ts`
- In `_handlePlanFile` (~line 1539), after the feature row is inserted/updated and `updateFeatureStatus(planId, 1, '')` is called (~lines 1681-1682 and 1729-1730):
  - When `relativePath.startsWith('.switchboard/features/')`, parse the `<!-- BEGIN SUBTASKS -->` / `## Subtasks` section from the markdown content.
  - Extract all linked plan paths. Handle three link shapes:
    - `../plans/foo.md` (relative to feature file in `features/`) → `.switchboard/plans/foo.md`
    - `.switchboard/plans/foo.md` (absolute-from-root) → as-is
    - `./foo.md` (relative to feature file) → `.switchboard/features/foo.md` (rare; keep for completeness)
  - Forward-slash-normalize all paths.
  - Call `await db.syncFeatureSubtasksByPaths(newRecord.planId, linkedPaths, workspaceId)`.
  - For plans not yet imported, rely on the existing `_retryPendingFeatureLinks` re-fire (the subtask file's own write triggers `_applyFeatureLink` via its `**Feature:**` frontmatter if present; if absent, the next feature-file re-ingest or a retry tick picks it up).

> **Superseded:** Original code snippet called `db.syncFeatureSubtasksByPaths(newRecord.planId, linkedPaths, workspaceId)` without specifying the method's contract or noting it does not exist.
> **Reason:** A coder cannot implement a method whose contract is unspecified, and the cross-feature guard (never steal a plan linked to another feature) is a correctness requirement, not a nicety.
> **Replaced with:** The `syncFeatureSubtasksByPaths` contract specified in the `KanbanDatabase.ts` section above: bidirectional link/unlink with a cross-feature guard, using `updateFeatureStatus` to respect `is_feature` stickiness.

```typescript
// Subtask parsing in PlanIngestionEngine._handlePlanFile, after feature row upsert:
if (relativePath.startsWith('.switchboard/features/')) {
    const subtaskMatch = content.match(/<!-- BEGIN SUBTASKS[\s\S]*?-->([\s\S]*?)<!-- END SUBTASKS/i)
        || content.match(/## Subtasks\s*\n([\s\S]*?)(?=\n##|\n<!--|$)/i);
    if (subtaskMatch && subtaskMatch[1]) {
        const linkedPaths: string[] = [];
        for (const line of subtaskMatch[1].split('\n')) {
            const linkMatch = line.match(/\[([^\]]+)\]\(([^)]+)\)/);
            if (!linkMatch || !linkMatch[2]) continue;
            let target = linkMatch[2].trim();
            if (target.startsWith('../plans/')) {
                target = path.join('.switchboard', 'plans', target.slice('../plans/'.length));
            } else if (target.startsWith('.switchboard/plans/')) {
                // already root-relative
            } else if (target.startsWith('./')) {
                target = path.join('.switchboard', 'features', target.slice(2));
            } else {
                continue; // plan-ID-only or unsupported shape — skip (pull path covers via frontmatter)
            }
            linkedPaths.push(target.replace(/\\/g, '/'));
        }
        await db.syncFeatureSubtasksByPaths(newRecord.planId, linkedPaths, workspaceId);
    }
}
```

### `src/services/LocalApiServer.ts`
- In `/health` endpoint handler (~line 4367), add explicit Switchboard service signature + pid so clients can prove identity:
```typescript
res.writeHead(200, { 'Content-Type': 'application/json' });
res.end(JSON.stringify({
    service: 'switchboard',
    status: 'ok',
    port: this._port,
    pid: process.pid,
    roots: this._allRoots,
    ...(terminals !== undefined ? { terminals, terminalCount: terminals.length } : {}),
    ...(selectedWorkspaceRoot !== undefined ? { selectedWorkspaceRoot } : {})
}));
```

### `src/standalone/cli.ts` — `probeHealth` (~line 185)
- **Context**: Current `probeHealth` checks `json.status === 'ok' && json.port === port` — does NOT verify `service`. An alien process returning `{status:'ok', port:<port>}` passes. The `/health` `service` field is useless unless this probe reads it.
- **Logic**: Parse JSON; require `json.service === 'switchboard'` AND `json.status === 'ok'` AND `json.port === port`. On failure (alien, HTML, 403, invalid JSON), return false so callers unlink the stale port file.

### `src/standalone/bootstrap.ts` — shutdown handlers (~line 2492, after port file write)
- **Context**: The returned `stop()` (~line 2552) unlinks the port file and disposes all providers/pty fleet — but only runs on graceful shutdown. Signal kills leave the port file.
- **Logic**: Install `SIGINT`/`SIGTERM`/`SIGHUP` handlers (each `process.once`) that call the instance's `stop()` then `process.exit(0)`. Add a sync `process.on('exit')` unlink as the hard-kill backstop (async cleanup may not finish if a second signal arrives). **Reuse `stop()` — do NOT duplicate unlink + server.stop**, which would skip ptyFleet/provider disposal (a regression).

> **Superseded:** Original snippet duplicated `fs.unlinkSync(portFile)` + `await server.stop()` in the signal handler, skipping disposal of `terminalWsGateway`, `ptyFleetService`, `ingestionEngine`, and all providers.
> **Reason:** The existing `stop()` already unlinks the port file AND disposes every provider/pty fleet. Reimplementing a subset leaks PTYs and leaves zombie providers on SIGTERM.
> **Replaced with:** Signal handlers call the instance's `stop()` (which does full disposal + unlink), then `process.exit(0)`. A sync `process.on('exit')` unlink remains as the backstop for a second-signal hard kill.

```typescript
// After `const portFile = ...; fs.writeFileSync(portFile, ...)` (~line 2493):
const instance = { server, port, url, oneTimeToken, stop: async () => { /* existing stop body */ } };
const syncUnlinkPortFile = () => { try { if (fs.existsSync(portFile)) fs.unlinkSync(portFile); } catch { /* ignore */ } };
const signalCleanup = async () => {
    try { await instance.stop(); } catch { /* ignore */ }
    process.exit(0);
};
process.once('SIGINT', signalCleanup);
process.once('SIGTERM', signalCleanup);
process.once('SIGHUP', signalCleanup);
process.on('exit', syncUnlinkPortFile); // sync backstop — async cleanup may not finish on hard kill
```

### `.agents/skills/kanban_operations/create-feature.js`
- **Health check enhancement** (~line 117): parse JSON, require `service === 'switchboard'` AND `status === 'ok'`. On alien detection (HTML / 403 / missing `service` / invalid JSON), unlink the stale `api-server-port.txt` and proceed to fallback.
- **Offline fallback** (when extension unreachable OR alien detected): write the feature file directly to `.switchboard/features/{slug}-{featurePlanId}.md` in the exact format `PlanIngestionEngine` parses — `<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->` / `## Subtasks` / `- [ ] [Title](../plans/{planFile})` / `<!-- END SUBTASKS -->`. Let ingestion link subtasks. Skip project inheritance, column resolution, and Linear/ClickUp sync (extension-only — same contract as the remote `create-feature` skill).
- **Update the safety comment** (lines 17-21): replace the "no safe direct-DB fallback" rationale with the superseded note — the fallback is safe because ingestion is now authoritative.

```javascript
// Fallback path in create-feature.js when API server is not running / alien:
const featurePlanId = crypto.randomUUID();
const slug = featureName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const featureFile = path.join(workspaceRoot, '.switchboard', 'features', `${slug}-${featurePlanId}.md`);
// Resolve each planId to its plan_file relative path via the kanban.db (read-only query)
// OR accept plan-file paths directly as an alternative input shape.
// Write feature file with <!-- BEGIN SUBTASKS --> subtask links, then let ingestion link them.
```

## Verification Plan

### Automated Tests
- Run health, plan ingestion, and feature management tests:
  - `npm test src/test/headless-feature-management-destructive.test.js`
  - `npm test src/test/loopback-hostname-contract.test.js`
- Add integration test:
  1. Write a feature markdown file directly to `.switchboard/features/test-feature-<uuid>.md` containing 2 subtask plan links under `<!-- BEGIN SUBTASKS -->`.
  2. Trigger plan ingestion and verify `db.getSubtasksByFeatureId(featurePlanId)` returns both subtasks (the board's read path — NOT just raw `feature_id` column inspection).
  3. Edit the feature file to remove 1 subtask link, re-trigger ingestion, verify `getSubtasksByFeatureId` returns 1 and the removed subtask's `feature_id === ''`.
  4. Add a subtask link pointing to a plan already linked to a *different* feature; verify the sync skips it (cross-feature guard) and logs.
- Add probe test: start a mock HTTP server returning `{status:'ok', port:<p>}` WITHOUT `service: 'switchboard'`; verify `cli.ts:probeHealth` returns false and the caller unlinks the port file.
- Add shutdown test: spawn the standalone host, send `SIGTERM`, verify `api-server-port.txt` is removed and no PTY processes leak.

> **Note:** Per session directives, compilation and automated tests are NOT executed during this planning run. The checks above remain the verification contract for the implementing coder.

### Manual Verification
1. Kill any running Switchboard instance.
2. Manually write a feature markdown file with 3 subtask links in `.switchboard/features/`.
3. Open Switchboard (VS Code or `npx switchboard`): verify the feature card renders on the board with all 3 subtasks attached (board render, not just DB state).
4. Verify `create-feature.js` works offline without errors, writes the feature file, and purges stale `api-server-port.txt` files automatically.
5. Verify `kill -TERM <pid>` on the standalone host removes `api-server-port.txt`.

## Outstanding Questions
- **[user]** Should the extension host (VS Code) also install signal handlers for `api-server-port.txt` cleanup, or is the extension's deactivation path already sufficient? — proceeding on the assumption that the extension host's `deactivate()` handles cleanup and only the standalone host has the signal-handler gap; if not, a follow-up plan covers the extension host.

## Completion Report
Implemented declarative file-based feature markdown subtask synchronization in `KanbanDatabase` (`syncFeatureSubtasksByPaths`) and integrated it into `PlanIngestionEngine`. Updated `LocalApiServer` to expose `service: 'switchboard'` and process `pid` on `/health`, updated `cli.ts:probeHealth` to validate the service signature, added process signal/exit cleanup handlers in `bootstrap.ts`, and added alien port detection/unlinking plus direct markdown file fallback in `create-feature.js`.
Files changed:
- `src/services/KanbanDatabase.ts`
- `src/services/PlanIngestionEngine.ts`
- `src/services/LocalApiServer.ts`
- `src/standalone/cli.ts`
- `src/standalone/bootstrap.ts`
- `.agents/skills/kanban_operations/create-feature.js`
No issues encountered during implementation.

