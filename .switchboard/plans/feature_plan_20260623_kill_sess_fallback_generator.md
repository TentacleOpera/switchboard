# Kill the sess_ Fallback ID Generator

## Goal

Remove the `sess_${Date.now()}` fallback ID generator in `TaskViewerProvider.ts` that fabricates garbage primary keys when no Claude session ID is found. This generator is the root cause of orphan-plan bugs, duplicate-row bugs, and phantom-card reintroduction. Replace it with proper UUID generation via `crypto.randomUUID()`, which is already used elsewhere in the codebase.

The existing dedup helpers (`cleanupSpuriousMirrorPlans` and `cleanupDuplicateLocalPlans`) are left in place — they become harmless no-ops since no new `sess_` rows will be created, and they will incrementally clean up any existing `sess_` rows on the next startup/snapshot sync. Helper removal and a one-shot DB migration are tracked separately in the backlog plan `feature_plan_20260623_sess_cleanup_and_migration.md`.

**Root-Cause Analysis:** When a new plan file is detected, the code reads `state.json` to get Claude's process session ID. If none is found, it fabricates `sess_${Date.now()}` and uses that fabricated ID as the `plan_id` primary key in the DB, the runsheet key, and the plan registry. Because `Date.now()` changes every millisecond, the same plan file gets a different `plan_id` on every re-detection (e.g., after IDE restart, file watcher double-fire, or debounce race). This creates duplicate DB rows with garbage primary keys. Two band-aid helpers (`cleanupSpuriousMirrorPlans` and `cleanupDuplicateLocalPlans`) were added to periodically delete `sess_%`-prefixed rows, but they treat the symptom, not the disease. The fix is to always generate a proper UUID for `plan_id` — never use a fabricated timestamp-based ID.

> **Clarification:** The fix also removes the `else` block (lines 13079–13100) that handled the case where a REAL Claude session ID IS found. This means real session IDs are no longer used as `planId` either — every plan gets its own fresh UUID regardless of whether `state.json` has a session ID. This is correct because the Claude session ID changes on every Claude restart, making it an unstable plan identifier. The `activeWorkflow` value from `state.json` is still read and preserved.

---

## Metadata

**Tags:** [backend, bugfix, database]
**Complexity:** 3

---

## User Review Required

No — this is a targeted bugfix that replaces a broken code path with a well-established pattern (`crypto.randomUUID()`, already used in `KanbanProvider.ts:7003` and `PlanningPanelProvider.ts:2889`). No DB schema changes, no migrations, no helper removal.

---

## Complexity Audit

### Routine
- Replacing `sess_${Date.now()}` with `crypto.randomUUID()` — one-line change at the fabrication site
- Removing the collision-check `else` block — UUIDs don't collide, so the check is unnecessary
- Updating 6 downstream usages of the `sessionId` local variable to use `planId`
- Renaming the `_incrementallyRegisterPlan` parameter from `sessionId` to `planId`

### Complex / Risky
- None

---

## Edge-Case & Dependency Audit

### Race Conditions
- **File watcher double-fire**: The current code has a `_planCreationInFlight` guard (line 13161) that prevents concurrent creation for the same file path. This guard remains unchanged and still protects against double-fire. The UUID change doesn't affect this.

### Security
- No security implications — `crypto.randomUUID()` is cryptographically secure (better than `Date.now()`).

### Side Effects
- **Existing `sess_` rows in user DBs**: After this fix, no new `sess_` rows are created. Existing ones remain but will be incrementally cleaned up by the existing dedup helpers on the next startup (line 2318) and snapshot sync (line 2276). No data loss — the canonical plan identified by `(plan_file, workspace_id)` is always preserved by the helpers.
- **Existing dedup helpers become no-ops over time**: Once all `sess_` rows are cleaned up, the helpers will find nothing to remove. They remain in the codebase as harmless defensive code until removed in the follow-up backlog plan.

### Dependencies & Conflicts
- **`crypto.randomUUID()`** requires Node.js 14.17+ (or browser crypto API). VS Code extensions run on Node.js 16+ (VS Code 1.75+), so this is safe. Already imported in `TaskViewerProvider.ts` at line 7 (`import * as crypto from 'crypto';`).
- **No dependency on the full sessionId eradication plan** — this fix is self-contained. The `sessionId` column and old DB methods remain untouched.
- **No DB migration required** — no schema changes.

---

## Dependencies

- None — this plan is self-contained.

---

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) the `sessionId` variable/parameter is used in 6 places across two function scopes (`_handlePlanCreation` and `_incrementallyRegisterPlan`) that must all be updated consistently — mitigated by the fact that all 6 are within 50 lines of each other and the changes are mechanical renames; (2) the `else` block removal means real Claude session IDs are no longer used as `planId` — this is correct because session IDs are unstable (change on restart). The fix is very low-risk: it replaces a broken pattern with an established one and touches no DB schema, no migrations, and no helper methods.

---

## Proposed Changes

### Step 1 — Replace the `sess_` Fabrication with UUID Generation

File: `src/services/TaskViewerProvider.ts`

Search for `sess_${Date.now()}` to find the block (approximately lines 13066–13100).

**Current code** (lines ~13066–13100):

```ts
let sessionId: string | undefined;
let activeWorkflow = 'unknown';
if (fs.existsSync(statePath)) {
    try {
        const stateContent = await fs.promises.readFile(statePath, 'utf8');
        const state = JSON.parse(stateContent);
        sessionId = state.session?.id;
        activeWorkflow = state.session?.activeWorkflow || 'unknown';
    } catch { }
}
// Fall back to anonymous session ID so orphaned plans still get a runsheet
if (!sessionId) {
    sessionId = `sess_${Date.now()}`;
} else {
    // Prevent collision/overwrite: if this session id is already bound to a different plan,
    // allocate a new plan session id.
    const existingSheet = await log.getRunSheet(sessionId);
    const existingSheetPlanFile = typeof existingSheet?.planFile === 'string'
        ? existingSheet.planFile.replace(/\\/g, '/')
        : '';
    const existingDbRow = db ? await db.getPlanBySessionId(sessionId) : null;
    const existingDbPlanFile = typeof existingDbRow?.planFile === 'string'
        ? existingDbRow.planFile.replace(/\\/g, '/')
        : '';
    const runsheetCollision = !!existingSheet && existingSheetPlanFile !== normalizedPlanFileRelative;
    const dbCollision = !!existingDbRow
        && !!existingDbPlanFile
        && existingDbPlanFile !== normalizedPlanFileRelative
        && existingDbPlanFile !== absolutePlanFile;
    if (runsheetCollision || dbCollision) {
        sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    }
}
```

**Replace with:**

```ts
let activeWorkflow = 'unknown';
if (fs.existsSync(statePath)) {
    try {
        const stateContent = await fs.promises.readFile(statePath, 'utf8');
        const state = JSON.parse(stateContent);
        activeWorkflow = state.session?.activeWorkflow || 'unknown';
    } catch { }
}
// Always generate a proper UUID for planId — never fabricate timestamp-based IDs.
// The Claude session ID from state.json is not a stable plan identifier (it changes
// on every Claude restart), so we don't use it as the planId regardless.
const planId = crypto.randomUUID();
```

> **Note:** The `sessionId` local variable is removed entirely. The `activeWorkflow` read from `state.json` is preserved. The collision-check `else` block is removed because UUIDs are unique by construction. This also means real Claude session IDs are no longer used as `planId` — every plan gets its own UUID.

### Step 2 — Update All Downstream Usages of `sessionId` in the Same Function

File: `src/services/TaskViewerProvider.ts`

The `sessionId` variable was used in 6 places after the fabrication site. Update each to use `planId`:

**2a. Runsheet creation** (line ~13117):
```ts
// Before:
const runSheet: any = {
    sessionId,
    planFile: planFileRelative,
    ...
};

// After:
const runSheet: any = {
    sessionId: planId,  // Keep field for backward compat with existing runsheet readers
    planFile: planFileRelative,
    ...
};
```

> **Clarification:** The `sessionId` field in the runsheet object is kept for now (the full eradication plan will remove it later). The value is set to `planId` so the runsheet is keyed by the stable UUID, not a fabricated timestamp.

**2b. `createRunSheet` call** (line ~13134):
```ts
// Before:
await log.createRunSheet(sessionId, runSheet);

// After:
await log.createRunSheet(planId, runSheet);
```

**2c. Console.log** (line ~13135):
```ts
// Before:
console.log(`[TaskViewerProvider] Created Run Sheet for session ${sessionId}: ${topic}`);

// After:
console.log(`[TaskViewerProvider] Created Run Sheet for session ${planId}: ${topic}`);
```

**2d. `_registerPlan` call** (line ~13140):
```ts
// Before:
await this._registerPlan(resolvedWorkspaceRoot, {
    planId: sessionId,
    ...
});

// After:
await this._registerPlan(resolvedWorkspaceRoot, {
    planId,
    ...
});
```

**2e. `_incrementallyRegisterPlan` call** (line ~13156):
```ts
// Before:
await this._incrementallyRegisterPlan(resolvedWorkspaceRoot, sessionId!);

// After:
await this._incrementallyRegisterPlan(resolvedWorkspaceRoot, planId);
```

> **Note:** The `!` non-null assertion is no longer needed because `planId` is always a string (from `crypto.randomUUID()`).

**2f. Rename `_incrementallyRegisterPlan` parameter and update webview messages** (lines ~13177, 13211, 13216):

The `_incrementallyRegisterPlan` function has its own `sessionId` parameter (line 13177). This is a DIFFERENT scope from the `sessionId` local variable in `_handlePlanCreation`. Rename the parameter to `planId` and update both webview message calls:

```ts
// Before (line ~13175-13178):
private async _incrementallyRegisterPlan(
    workspaceRoot: string,
    sessionId: string
): Promise<void> {

// After:
private async _incrementallyRegisterPlan(
    workspaceRoot: string,
    planId: string
): Promise<void> {
```

```ts
// Before (line ~13211):
this._view?.webview.postMessage({ type: 'selectSession', sessionId });

// After:
this._view?.webview.postMessage({ type: 'selectSession', sessionId: planId });
```

```ts
// Before (line ~13216):
this._view?.webview.postMessage({ type: 'selectSession', sessionId });

// After:
this._view?.webview.postMessage({ type: 'selectSession', sessionId: planId });
```

> **Note:** The webview message type `selectSession` and its `sessionId` field are not renamed here — that's part of the full eradication plan. We just pass the UUID as the value.

---

## Verification Plan

### Automated Tests
- Run existing test suite to verify no regressions from the UUID change
- The existing `local-plan-duplicate-regression.test.js` should still pass (it tests `cleanupDuplicateLocalPlans`, which is untouched in this plan)

### Manual Verification
- Create a new plan file when no Claude session is active (no `state.json`)
- Verify the plan appears in the kanban board with a UUID `plan_id` (not `sess_*`)
- Restart VS Code and verify the same plan is still tracked (no duplicate row created)
- Verify `grep -r "sess_\${Date.now()}" src/` returns zero hits

---

## Order of Execution

1. Step 1 (replace fabrication with UUID) — the core fix
2. Step 2 (update all 6 downstream usages + rename `_incrementallyRegisterPlan` parameter) — must be done atomically with Step 1

## Completion Criteria

- `grep -r "sess_\${Date.now()}" src/` returns zero hits
- New plans created without a Claude session get a UUID `plan_id`, not a `sess_` ID
- Restarting VS Code does not create duplicate DB rows for the same plan file
- Extension compiles with `tsc --noEmit` with zero errors
- Existing dedup helpers (`cleanupSpuriousMirrorPlans`, `cleanupDuplicateLocalPlans`) remain untouched and functional

## Recommendation

**Complexity: 3 → Send to Intern.** This is a pure mechanical rename: replace one fabrication block with a `crypto.randomUUID()` call, then update 6 variable references in the same function. No DB changes, no migrations, no helper removal. An intern can handle this with the step-by-step instructions above.
