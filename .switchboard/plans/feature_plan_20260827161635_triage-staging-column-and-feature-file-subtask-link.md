# Triage remaining red contract gates: staging-column and feature-file-subtask-link

## Goal

Two contract gates remain red after the queue-watch gates were fixed in a reviewer pass:

1. **`test:contract:staging-column`** — fails on the assertion "the autoban schedule run sheet pops STAGING and nothing else" (line 222). The test asserts `sourceColumn: 'STAGING'` exists in `kanban.html` (line 223), but no `runSheet` or `sourceColumn` references exist in `kanban.html` at all. The run sheet was removed or moved without updating the test.

2. **`test:contract:feature-file-subtask-link`** — fails on the assertion "an unresolvable planId aborts instead of writing guessed links" (line 270). The offline fallback in `create-feature.js` (`viaDirectFile`, line 153) always returns `{ ok: true }` and exits 0 for unresolvable planIds, writing guessed links (`../plans/${pid}.md`) instead of aborting. The test expects a non-zero exit, a `Cannot resolve` or `ok: false` message, and no feature file written.

**Root cause:**
- Gate 1: The `runSheet` with `sourceColumn: 'STAGING'` was removed from `kanban.html`. The autoban schedule's column targeting likely moved to the backend (`TaskViewerProvider.ts`) or was refactored away. The test is stale.
- Gate 2: `create-feature.js`'s offline fallback does not check whether planIds resolved before writing the feature file. It writes guessed links for unresolvable planIds and exits 0.

## Metadata

**Complexity:** 5
**Tags:** test, bugfix, reliability
**Project:** Browser Switchboard

## Complexity Audit

**Routine:**
- Gate 1: Trace where the autoban schedule's STAGING source column targeting now lives. Update the test to read from the correct file, or remove the assertion if the contract no longer applies.
- Gate 2: Add a resolution check to `viaDirectFile` in `create-feature.js` — abort with non-zero exit if any planId cannot be resolved.

**Complex/Risky:**
- Gate 1: The run sheet may have been intentionally removed as part of a refactoring. Must trace the autoban schedule flow to understand where STAGING targeting is now specified before deciding whether to update or remove the assertion.
- Gate 2: The offline fallback's `viaDirectFile` has a `catch` block (line 179) for when `KanbanDatabase` is unavailable. In that case, ALL planIds are unresolved. The fix must handle this: if the DB is unavailable, should the fallback abort (matching the test's expectation) or write basic links (current behavior)? The test expects abort, so the `catch` block must also abort.

## Edge-Case & Dependency Audit

- **Gate 1 — `staging-column-contract.test.js` (line 222–231):** The test reads `kanbanHtml` (full `kanban.html` source) and asserts:
  1. `sourceColumn: 'STAGING'` exists (line 223–224)
  2. `const runSheet = [` exists (line 227)
  3. No `sourceColumn: 'CREATED'` or `sourceColumn: 'PLAN REVIEWED'` in the run sheet body (line 228–230)
  None of these exist in `kanban.html` anymore. The `runSheet` references are in `implementation.html` (27 matches) and `TaskViewerProvider.ts` (60 matches), but none have `sourceColumn: 'STAGING'`.
- **Gate 1 — autoban schedule flow:** `TaskViewerProvider.ts` line 12268 handles `scheduleEnabled`. The schedule's column targeting may be in `_singleColumnAutobanState` or derived from the column configuration. Must trace where the schedule decides which column to pop cards from.
- **Gate 2 — `create-feature.js` `viaDirectFile` (line 153–205):** The function resolves planIds via `db.getPlanByPlanId(pid)`. When `plan && plan.planFile` is false (line 170), it writes a guessed link. The fix: track unresolved planIds, abort if any are unresolved.
- **Gate 2 — test isolation (line 274–279):** The test sets `cwd: tmpRoot` to prevent `findApiPortInfo` from climbing to a live API server. `tmpRoot` is in `os.tmpdir()` (`/var/folders/...` on macOS), so its ancestors should not contain a `.switchboard/api-server-port.txt`. This isolation appears sound.
- **Gate 2 — API server path vs offline fallback:** When the API server is reachable, `createFeatureFromPlanIds` returns `{ success: true, skipped: [...] }` — it does NOT abort for unresolvable planIds. The test only exercises the offline fallback. The fix should make the offline fallback abort, which is a stricter contract than the API server path. This is intentional: the offline fallback writes files directly, so writing guessed links is more dangerous than the API server's skip-and-report behavior.

## Proposed Changes

### 1. Fix `test:contract:staging-column` — trace and update the stale run-sheet assertion

**Step 1: Trace the autoban schedule's column targeting.**

```bash
# Search for where the schedule decides which column to pop
grep -rn 'STAGING.*schedule\|schedule.*STAGING\|sourceColumn\|runSheet.*STAGING' src/services/ src/webview/
```

**Step 2: Determine the new contract.**

- If the run sheet moved to `implementation.html`: update the test to read from `implementation.html` instead of `kanban.html`.
- If the run sheet was deleted and the schedule now targets STAGING via backend config: update the test to assert the backend config (e.g., `_singleColumnAutobanState` or a constant in `TaskViewerProvider.ts`).
- If the contract no longer applies (the schedule no longer has a STAGING-only source column): remove the assertion and document why.

**Step 3: Update the test.**

```javascript
// Example: if the run sheet moved to implementation.html
const implHtml = fs.readFileSync(path.join(repoRoot, 'src', 'webview', 'implementation.html'), 'utf8');
const idx = implHtml.indexOf('sourceColumn: \'STAGING\'');
assert.notStrictEqual(idx, -1, 'the run sheet must name STAGING as its source column');
```

### 2. Fix `test:contract:feature-file-subtask-link` — abort on unresolvable planIds

In `.agents/skills/kanban_operations/create-feature.js`, modify `viaDirectFile`:

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
    unresolved.push(...planIds);
  }

  if (unresolved.length > 0) {
    return { ok: false, error: `Cannot resolve planId(s): ${unresolved.join(', ')}` };
  }

  const featureFile = path.join(featuresDir, `${slug}-${featurePlanId}.md`);
  // ... rest unchanged ...
  return { ok: true, featurePlanId, featureFile };
}
```

In the main IIFE, handle the `ok: false` return:

```javascript
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
3. Run the full contract suite — assert no regressions from either fix.
4. For Gate 2: manually test `node .agents/skills/kanban_operations/create-feature.js "Test" '["no-such-id"]' /tmp/test-ws` — assert non-zero exit and `ok: false` in output.
5. For Gate 2: manually test with a valid planId — assert exit 0 and feature file created.
