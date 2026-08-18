# Declarative File-Based Feature Ingestion, API Port Lifecycle, and Dual-Host Fallbacks

## Goal
Feature management and CLI automation in Switchboard must be completely declarative and resilient to offline/remote environments. Currently, two major gaps cause feature creation and script execution to fail when operating via direct file operations or when the local API server is unavailable:

1. **Feature Markdown File Ingestion Gaps**: When a feature file is written or edited directly in `.switchboard/features/` with subtask links (e.g. `- [ ] [Title](../plans/plan.md)` under `## Subtasks` or `<!-- BEGIN SUBTASKS -->`), `PlanIngestionEngine` imports the feature row (`is_feature = 1`) but completely ignores the subtask list inside the markdown file. Subtasks in `kanban.db` remain with `feature_id = ''`, causing the board to display "0 subtasks" unless an active API server endpoint (`assignPlansToFeature`) is called. Feature creation and subtask linking MUST be fully achievable and authoritative via standard file operations.
2. **Stale API Port Collisions & Stalled CLI Tools**: When Switchboard (VS Code extension or `npx switchboard` standalone host) terminates ungracefully, `.switchboard/api-server-port.txt` survives on disk. When alien local processes (such as Electron apps or Chrome) bind to that recycled port, direct IP requests reject with `403 Direct IP access is not allowed`. CLI scripts (`create-feature.js`, `move-card.js`, etc.) fail with fatal errors instead of verifying process signatures, auto-evicting the dead port file, and falling back to direct file operations.

This plan establishes full file-based feature/subtask ingestion parity in `PlanIngestionEngine`, cleans up API port lifecycles across both hosts, and makes all kanban operations resilient.

### Problem & Root Cause Analysis
1. **Unparsed Subtask Blocks in `PlanIngestionEngine.ts`**: In `PlanIngestionEngine.ts` (lines 1550–1760), when a file under `.switchboard/features/` is ingested, it extracts topic and frontmatter, but never parses the subtask list in `<!-- BEGIN SUBTASKS -->`. It relies solely on `metadata.feature` in subtask plan files or explicit API calls. As a result, direct file writes to `.switchboard/features/` create features with 0 linked subtasks in the database.
2. **Missing Process Termination Handlers in Standalone NPX Host**: In `src/standalone/bootstrap.ts` and `src/standalone/cli.ts`, `api-server-port.txt` is written on boot, but no `SIGINT`, `SIGTERM`, `SIGHUP`, or `exit` handlers are installed to remove the file when the process exits or is killed in a terminal.
3. **No Offline Fallback in `create-feature.js`**: Unlike `move-card.js` (which has fallback logic) or the `create-feature` skill, `create-feature.js` hard-exits with code 1 if the API server is unreachable, rather than falling back to writing the standard `.switchboard/features/{slug}-{planId}.md` file directly.

## Metadata
- **Complexity:** 5
- **Tags:** backend, cli, infrastructure, reliability, bugfix
- **Project:** Browser Switchboard

## Complexity Audit
- **Routine (3/5):** Adding subtask markdown link parsing in `PlanIngestionEngine.ts`, adding process signal exit handlers in `bootstrap.ts`/`cli.ts`, adding `service: 'switchboard'` signature to `/health` in `LocalApiServer.ts`.
- **Risky/Complex (2/5):** Ensuring subtask linking in `PlanIngestionEngine` handles bidirectional changes (adding/removing subtasks in feature markdown updates `feature_id` in `kanban.db` without wiping unassigned plans).

## Edge-Case & Dependency Audit
- **Bidirectional Subtask Linking via File Edits**: When a user or agent adds or removes a subtask link (`- [ ] [Title](../plans/plan.md)`) from a feature file, `PlanIngestionEngine` must resolve the target plan (by relative path or plan ID) and update `feature_id` in `kanban.db` accordingly.
- **Alien Service on Same Port**: Probing `/health` must verify that the JSON response contains `status: 'ok'` AND `service: 'switchboard'`. If the endpoint returns HTML, 403, or invalid JSON, it must be recognized as an alien process, and `api-server-port.txt` must be unlinked.
- **Dual-Host Parity**: Standalone NPX distribution (`npx switchboard`) and the VS Code extension must behave identically with respect to port cleanup, database locking, and file ingestion.

## Proposed Changes

### `src/services/PlanIngestionEngine.ts`
- In `_handlePlanFile`:
  - When `relativePath.startsWith('.switchboard/features/')`, parse the `<!-- BEGIN SUBTASKS -->` / `## Subtasks` section from the markdown content.
  - Extract all linked plan paths (e.g. `../plans/feature_plan_...md` or `.switchboard/plans/...md`).
  - Resolve each linked subtask in `kanban.db` and set `feature_id = feature.planId`.
  - For any plan currently assigned to this feature in `kanban.db` that is NO LONGER present in the feature file's subtask list, reset `feature_id = ''`.

```typescript
// Subtask parsing in PlanIngestionEngine:
if (relativePath.startsWith('.switchboard/features/')) {
    const subtaskMatch = content.match(/<!-- BEGIN SUBTASKS[\s\S]*?-->([\s\S]*?)<!-- END SUBTASKS/i)
        || content.match(/## Subtasks\s*\n([\s\S]*?)(?=\n##|\n<!--|$)/i);
    if (subtaskMatch && subtaskMatch[1]) {
        const lines = subtaskMatch[1].split('\n');
        const linkedPaths: string[] = [];
        for (const line of lines) {
            const linkMatch = line.match(/\[([^\]]+)\]\(([^)]+)\)/);
            if (linkMatch && linkMatch[2]) {
                let target = linkMatch[2].trim();
                if (target.startsWith('../plans/')) {
                    target = path.join('.switchboard', 'plans', target.slice(9));
                } else if (target.startsWith('./')) {
                    target = path.join('.switchboard', 'features', target.slice(2));
                }
                linkedPaths.push(target.replace(/\\/g, '/'));
            }
        }
        await db.syncFeatureSubtasksByPaths(newRecord.planId, linkedPaths, workspaceId);
    }
}
```

### `src/services/LocalApiServer.ts`
- In `/health` endpoint handler (around line 4126):
  - Include explicit Switchboard service signature so clients can prove identity:
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

### `src/standalone/bootstrap.ts` & `src/standalone/cli.ts`
- Install process lifecycle cleanup hooks in standalone NPX host to remove `api-server-port.txt` on exit:
```typescript
function registerShutdownHandlers(portFilePath: string, server: LocalApiServer) {
    const cleanup = async () => {
        try {
            if (fs.existsSync(portFilePath)) fs.unlinkSync(portFilePath);
        } catch { /* ignore */ }
        try { await server.stop(); } catch { /* ignore */ }
        process.exit(0);
    };

    process.once('SIGINT', cleanup);
    process.once('SIGTERM', cleanup);
    process.once('SIGHUP', cleanup);
    process.on('exit', () => {
        try {
            if (fs.existsSync(portFilePath)) fs.unlinkSync(portFilePath);
        } catch { /* ignore */ }
    });
}
```

### `src/agents/skills/kanban_operations/create-feature.js`
- Enhance health check to detect stale port files and purge them.
- When the API server is unreachable, fall back to direct feature file generation and subtask linking:
```javascript
// Fallback path in create-feature.js when API server is not running:
const featurePlanId = crypto.randomUUID();
const slug = featureName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const featureFile = path.join(workspaceRoot, '.switchboard', 'features', `${slug}-${featurePlanId}.md`);
// Write feature file with subtask links directly...
```

## Verification Plan

### Automated Tests
- Run health, plan ingestion, and feature management tests:
  - `npm test src/test/headless-feature-management-destructive.test.js`
  - `npm test src/test/loopback-hostname-contract.test.js`
- Add integration test:
  1. Write a feature markdown file directly to `.switchboard/features/test-feature-<uuid>.md` containing 2 subtask plan links.
  2. Trigger plan ingestion and verify that both subtasks in `kanban.db` have `feature_id = '<uuid>'`.
  3. Edit the feature file to remove 1 subtask link, re-trigger ingestion, and verify the removed subtask has `feature_id = ''`.

### Manual Verification
1. Kill any running Switchboard instance.
2. Manually write a feature markdown file with 3 subtask links in `.switchboard/features/`.
3. Open Switchboard (VS Code or `npx switchboard`): verify the feature card renders on the board with all 3 subtasks attached.
4. Verify `create-feature.js` works offline without errors and purges stale `api-server-port.txt` files automatically.
