# Triage four red contract gates at HEAD (queue-watch, staging-column, feature-file-subtask-link)

## Goal

Four contract gates are red at HEAD for reasons unrelated to any current plan:

1. **`test:contract:completion-asserted-never-inferred`** — fails on the PlanIngestionEngine queue-watch in-flight predicate (`!p.completedAt`).
2. **`test:contract:queue-stall-watch`** — also fails on the same in-flight predicate.
3. **`test:contract:staging-column`** — fails on kanban.html's STAGING run-sheet source column. The test asserts `sourceColumn: 'STAGING'` exists in `kanban.html` (line 223), but no `runSheet` or `sourceColumn` references exist in `kanban.html` at all — the run sheet was removed or moved without updating the test.
4. **`test:contract:feature-file-subtask-link`** — fails because the offline fallback in `create-feature.js` (`viaDirectFile`, line 153) always returns `{ ok: true }` and exits 0 for unresolvable planIds, writing guessed links (`../plans/${pid}.md`) instead of aborting. The test expects a non-zero exit and no feature file written.

**Root cause:** Each gate has a distinct root cause:
- Gates 1 & 2: The in-flight predicate in `PlanIngestionEngine.ts` may have an extra clause or the test's source-pin regex is too narrow. (Note: the memo's Issue 6 says these two were fixed in a reviewer pass — this plan covers the remaining two.)
- Gate 3: The `runSheet` with `sourceColumn: 'STAGING'` was removed from `kanban.html`. The test is stale — the contract it pins no longer exists in the file.
- Gate 4: `create-feature.js`'s offline fallback (`viaDirectFile`) does not abort on unresolvable planIds — it writes guessed links and exits 0.

## Metadata

**Complexity:** 5
**Tags:** test, bugfix, reliability
**Project:** Browser Switchboard

## Complexity Audit

**Routine:**
- Gate 3 (`staging-column`): Determine whether the run sheet moved to another file (e.g., `implementation.html` or `TaskViewerProvider.ts`) or was deleted entirely. If moved, update the test to read from the new location. If deleted, update the test to reflect the new contract (or delete the assertion if the contract no longer applies).
- Gate 4 (`feature-file-subtask-link`): Add a resolution check to `viaDirectFile` in `create-feature.js` — if any planId cannot be resolved against `kanban.db`, abort with a non-zero exit and `{ ok: false }` output instead of writing guessed links.

**Complex/Risky:**
- Gate 3: The run sheet may have been intentionally removed as part of a refactoring. Re-adding it to `kanban.html` to satisfy the test would be wrong if the autoban schedule no longer uses a client-side run sheet. Must trace the autoban schedule flow to understand where the STAGING source column is now specified.
- Gate 4: The offline fallback's `viaDirectFile` uses `KanbanDatabase.forWorkspace(workspaceRoot)` to resolve planIds. When a planId doesn't resolve, it falls through to writing `../plans/${pid}.md` (line 175). The fix must track which planIds failed resolution and abort if any did, while still succeeding when all resolve. Must not break the case where `KanbanDatabase` is unavailable (the `catch` block at line 179).

## Edge-Case & Dependency Audit

- **Gate 3 — `staging-column-contract.test.js` (line 222):** The test reads `kanbanHtml` (the full `kanban.html` source) and asserts `sourceColumn: 'STAGING'` exists. The test also checks that `const runSheet = [` exists and that no `sourceColumn: 'CREATED'` or `sourceColumn: 'PLAN REVIEWED'` entries remain. If the run sheet was moved to `implementation.html`, the test must read from that file instead.
- **Gate 3 — autoban schedule flow:** The autoban schedule is controlled by `TaskViewerProvider.ts` (line 12268: `scheduleEnabled`). The run sheet may have moved to the backend or to `implementation.html`. Must trace where the schedule's column targeting lives now.
- **Gate 4 — `create-feature.js` `viaDirectFile` (line 153):** The function tries `require('../../../out/services/KanbanDatabase')` to resolve planIds. When a planId doesn't resolve (line 174: `plan && plan.planFile` is false), it writes a guessed link. The fix: track unresolved planIds, and if any are unresolved, output `{ ok: false, error: 'Cannot resolve planId(s): ...' }` and `process.exit(1)`.
- **Gate 4 — test isolation:** The test at line 274 notes that `findApiPortInfo(process.cwd())` can climb out of `tmpRoot` and find a live API server. The test sets `cwd: tmpRoot` to prevent this, but the comment says "tmpRoot's ancestors hold no port file." This should be verified — if a developer's repo is an ancestor of the temp directory (unlikely on macOS where tmpdir is `/var/folders/...`), the test could be defeated.
- **Gate 4 — API server path:** When the API server is reachable, `create-feature.js` calls `POST /kanban/feature` which handles unresolvable planIds via `createFeatureFromPlanIds` (returns `{ success: true, skipped: [...] }`). The API server path does NOT abort — it reports skipped planIds. The offline fallback should match this behavior or abort, depending on the contract. The test expects abort (non-zero exit), so the fallback must abort.

## Proposed Changes

### 1. Fix `test:contract:staging-column` — update or remove the stale run-sheet assertion

Trace where the autoban schedule's STAGING source column is now specified:

```bash
# Search for the run sheet in all webview files and backend
grep -rn 'sourceColumn.*STAGING\|runSheet.*STAGING' src/webview/ src/services/
```

**Option A (run sheet moved):** If the run sheet moved to `implementation.html` or another file, update the test to read from that file:
```javascript
// In staging-column-contract.test.js, change the source file:
const implHtml = fs.readFileSync(path.join(repoRoot, 'src', 'webview', 'implementation.html'), 'utf8');
const idx = implHtml.indexOf('sourceColumn: \'STAGING\'');
```

**Option B (run sheet deleted):** If the run sheet was intentionally removed, update the test to assert the new contract (e.g., the autoban schedule targets STAGING via a backend config, not a client-side run sheet). If no equivalent contract exists, remove the assertion.

### 2. Fix `test:contract:feature-file-subtask-link` — abort on unresolvable planIds in offline fallback

In `.agents/skills/kanban_operations/create-feature.js`, modify `viaDirectFile` (line 153):

```javascript
async function viaDirectFile() {
  const featurePlanId = crypto.randomUUID();
  const slug = featureName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'feature';
  const featuresDir = path.join(workspaceRoot, '.switchboard', 'features');
  if (!fs.existsSync(featuresDir)) {
    fs.mkdirSync(featuresDir, { recursive: true });
  }

  let subtaskLines = [];
  const unresolved = [];
  try {
    const { KanbanDatabase } = require('../../../out/services/KanbanDatabase');
    const db = KanbanDatabase.forWorkspace(workspaceRoot);
    await db.ensureReady();
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
    if (typeof db.close === 'function') db.close();
  } catch {
    // If KanbanDatabase module unavailable, all planIds are unresolved
    unresolved.push(...planIds);
  }

  // Abort if any planId could not be resolved — do not write guessed links.
  if (unresolved.length > 0) {
    return { ok: false, error: `Cannot resolve planId(s): ${unresolved.join(', ')}` };
  }

  const featureFile = path.join(featuresDir, `${slug}-${featurePlanId}.md`);
  // ... rest of the function unchanged ...
}
```

And in the main IIFE (line 218–226), handle the `ok: false` return:

```javascript
// Extension not reachable — fallback to direct markdown feature file creation
const fallbackResult = await viaDirectFile();
if (!fallbackResult.ok) {
  console.log(JSON.stringify(fallbackResult));
  process.exit(1);
}
console.log(JSON.stringify({
  ok: true,
  featurePlanId: fallbackResult.featurePlanId,
  featureFile: fallbackResult.featureFile,
  fallback: true
}));
process.exit(0);
```

## Verification Plan

1. Run `node --require ./src/test/bootstrap/sandboxStateHome.js src/test/staging-column-contract.test.js` — assert exit code 0.
2. Run `node --require ./src/test/bootstrap/sandboxStateHome.js src/test/feature-file-subtask-link-contract.test.js` — assert exit code 0.
3. Run the full contract suite — assert no regressions.
4. For Gate 4: manually test `node .agents/skills/kanban_operations/create-feature.js "Test" '["no-such-id"]' /tmp/test-ws` — assert non-zero exit and `ok: false` in output.
5. For Gate 4: manually test with a valid planId — assert exit 0 and feature file created.
