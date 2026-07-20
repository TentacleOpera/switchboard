# Enforce: a subtask's project always inherits its feature's

## Goal

Close the invariant hole that lets a subtask's project diverge from its feature's. **A feature is one workstream = one project; its subtasks inherit it — never a different one.** Today the API/DB allow the invalid state `subtask.project ≠ feature.project`, which causes an observed symptom: a cross-pinned subtask vanishes from the board (it renders neither under its feature's project grouping nor under its own).

**Invariant to hold everywhere:** `plan.feature_id != '' ⟹ plan.project == feature.project && plan.project_id == feature.project_id`.

### Core Problem & Root Cause

The invariant is violated because **every project-set write path treats plans independently** — none consults the target plan's `feature_id` or `is_feature` membership. There are three distinct project-set sinks in the codebase (verified by grep of `setProjectForPlans|updatePlanProjectByPlanFile|UPDATE plans SET project`):

1. **`KanbanDatabase.setProjectForPlans`** (`src/services/KanbanDatabase.ts:3477`) — keyed by `plan_id`/`session_id`. Called from:
   - `KanbanProvider` webview handler `assignSelectedToProject` (`KanbanProvider.ts:7210`) — user picks a project on selected card(s).
   - `TaskViewerProvider` plan-import-with-project (`TaskViewerProvider.ts:6211`) — bulk-stamps imported plans; targets NEW plans with no `feature_id`, so the subtask-reject guard below is a no-op here (safe).
   - `KanbanDatabase.assignPlansToProject` (`KanbanDatabase.ts:3614`) — a thin wrapper that delegates to `setProjectForPlans`; called from `TaskViewerProvider` plan-create-with-project (`TaskViewerProvider.ts:19055`). Also targets new plans (safe).
2. **`KanbanDatabase.updatePlanProjectByPlanFile`** (`src/services/KanbanDatabase.ts:2650`) — keyed by `plan_file`. Called from the API `PUT /kanban/plans/project` (`LocalApiServer.ts:2224` via `_handleSetPlanProject` at 2187). CAN target an existing subtask — this is the second user-facing project-set path.
3. **Bulk project-delete clear** (`KanbanDatabase.ts:3407`) — `UPDATE plans SET project='', project_id=NULL WHERE project=?`. Bulk by project name; cascade is automatic because subtasks share their feature's project name (post-fix). No guard needed.

Additionally, feature-attach does not propagate the feature's project onto the attached subtask:
- `KanbanProvider.assignPlansToFeature` (`KanbanProvider.ts:11471`) links subtasks via `db.updateFeatureStatus` but never writes `project`/`project_id`.
- `KanbanProvider.createFeatureFromPlanIds` (`KanbanProvider.ts:11256`) does the opposite — it derives the FEATURE's project FROM the subtasks (11309), but never writes the resolved project BACK onto the subtasks. So if subtasks disagree, the feature picks one and the others stay divergent.
- Setting a feature's project (path 1 or 2 above with a feature planId) does not cascade to its subtasks.

**Root cause:** no shared choke point enforces the invariant, and the plan's original "Watch out" claim that `assignPlansToProject` (3614) is the shared choke point for both webview and API is incorrect (see Superseded callout in Watch Out section). The fix must install the guard in BOTH `setProjectForPlans` AND `updatePlanProjectByPlanFile`, plus propagate-on-attach, plus a startup reconcile.

## Metadata
- **Complexity:** 5
- **Tags:** backend, bugfix, database, api, refactor, reliability

_(No project — unassigned. Projects are optional; this is base-workspace extension work.)_

## User Review Required

Yes — review the corrected choke-point analysis (the original plan mis-identified the shared sink) and confirm the reject-vs-redirect product decision for direct subtask project changes (step 3). The plan rejects with 400 to keep the one-project model visible; if silent redirect is preferred, flag before coding.

## Complexity Audit

### Routine
- Adding the propagate-on-attach write in `assignPlansToFeature` and `createFeatureFromPlanIds` (one extra `UPDATE plans SET project=?, project_id=?` per subtask after the link).
- Extracting a shared `_enforceProjectInvariant` helper in `KanbanDatabase` and calling it from both project-set sinks.
- The startup reconcile — one `UPDATE ... FROM (SELECT ...)` with a JOIN, modeled on the existing V38/V50 backfills but run-on-every-startup (idempotent), not version-gated.
- Detach (`_removeSubtaskFromFeature`) — no code change, document only.

### Complex / Risky
- **Two-sink guard installation.** The original plan named one choke point; the real fix touches two separate UPDATE sinks (`setProjectForPlans` keyed by plan_id/session_id, `updatePlanProjectByPlanFile` keyed by plan_file). Missing either leaves the API or the webview as a re-entry vector for the vanishing-subtask state.
- **Guard-vs-propagate ordering.** Step 1's propagate-on-attach writes a subtask's project directly. Step 3's guard rejects direct subtask project writes. The propagate write MUST bypass the guard (or the guard blocks the fix). Requires a shared internal write path that the guard recognizes as feature-attach context.
- **Idempotent startup reconcile vs version-gated migration.** A V-numbered migration runs once; future drift (a bug, a direct DB edit, a stale sql.js snapshot flush) is never repaired. The invariant is a live correctness check, not a column migration — it must run every startup.
- **`splitFeature` inheritance.** `splitFeature` (11531) routes through `createFeatureFromPlanIds`, which inherits project from subtasks (11309). If the source feature had a divergent subtask (pre-fix), the split propagates the divergence into a new feature. The startup reconcile must run before any user action; coders must not assume pre-split state is clean.

## Edge-Case & Dependency Audit

- **Race Conditions:** `assignPlansToFeature` already re-checks `featureId` immediately before writing (11466-11468 comment). The propagate write happens inside the same per-subtask loop, after the link — a concurrent webview edit to the subtask's project between link and propagate is possible but narrow; the startup reconcile repairs any resulting drift on next restart. Acceptable.
- **Security:** The API reject (400) must not leak whether a planId exists to an unauthenticated caller — `_handlePlanFieldUpdate` already auth-checks (`_checkAuth(req, true)`) before the lookup, so the reject rides on the existing 401/404/400 ordering. No new info leak.
- **Side Effects:** Cascading a feature's project change to subtasks updates `updated_at` on every subtask row — this bumps their board sort order (board sorts by `updated_at DESC`). Expected and acceptable (a project change IS a subtask touch). Worktree rows carry a `project` column (`addWorktree` at 3540) but `getWorktrees` (3515) does NOT filter by project — worktree project is provisioning-time metadata, not a filter, so cascade does NOT need to touch worktrees. Flagged for coder awareness; out of scope.
- **Dependencies & Conflicts:** Depends on existing `getSubtasksByFeatureId` (`KanbanDatabase.ts:5758`), `resolveProjectId` (2627), `getPlanByPlanId`. No new helpers required beyond `_enforceProjectInvariant`. No conflict with the V38/V47/V50 migrations (those are column/legacy repairs; this is a live invariant). The reconcile must run AFTER all V-numbered migrations (so column schema is current) but BEFORE the first board read — slot it at the end of `_initialize`/migration chain, near the existing `reconcileHotCold` call site (~7574).

## Dependencies

_(None — this is a self-contained invariant-enforcement plan. No prerequisite sessions.)_

## Adversarial Synthesis

Key risks: (1) the original plan's "choke point" claim was wrong — there are two project-set sinks (`setProjectForPlans` and `updatePlanProjectByPlanFile`), and patching only one leaves the API or webview as a re-entry vector that re-creates the vanishing-subtask state; (2) the step-1 propagate write and the step-3 reject guard both write a subtask's project — the guard must recognize feature-attach context or it blocks the fix; (3) a version-gated migration backfill repairs legacy rows but not future drift — the invariant needs an idempotent startup reconcile. Mitigations: shared `_enforceProjectInvariant` helper called from both sinks; propagate path uses an internal write that bypasses the guard; reconcile runs every startup, not as a V-numbered migration.

## Proposed Changes

### `src/services/KanbanDatabase.ts`

**Context:** Add the invariant guard + cascade to BOTH project-set sinks, extract a shared helper, and add an idempotent startup reconcile.

**Logic — shared helper `_enforceProjectInvariant`:**
- New `private async _enforceProjectInvariant(workspaceId, planIds, projectName, opts?: { bypassSubtaskGuard?: boolean }): Promise<{ ok: boolean; rejectedSubtasks: string[]; cascadedSubtasks: string[] }>` (internal).
- Resolves `projectId` via `resolveProjectId(projectName, workspaceId)` (reuse existing 2627).
- For each target planId, look up the row. Classify:
  - `is_feature === 1` → after writing the feature's project, cascade: `UPDATE plans SET project=?, project_id=?, updated_at=? WHERE feature_id=? AND workspace_id=?` (reuses `getSubtasksByFeatureId` to confirm count, but the UPDATE is the source of truth). Collect cascaded subtask planIds.
  - `feature_id != ''` AND `opts.bypassSubtaskGuard !== true` → reject. Collect in `rejectedSubtasks`. Do NOT write.
  - Otherwise → write the project directly.
- Single `_persist()` at the end.

**Implementation — `setProjectForPlans` (3477):**
- Replace the body with a call to `_enforceProjectInvariant(workspaceId, planIds, projectName)`. Map `ok=false` (any rejected) to the existing boolean return — but preserve the existing return contract: callers (`assignSelectedToProject` webview, import path, plan-create path) currently get a boolean. Add an overload or a new returning variant `setProjectForPlansInvariant` that returns the structured result; keep `setProjectForPlans` returning boolean for back-compat (true if no rejections, false if any rejected OR DB error — matching today's failure semantics).
- The import path (6211) and plan-create path (19055) target NEW plans with no `feature_id` — the guard is a no-op there, so no caller change needed.

**Implementation — `updatePlanProjectByPlanFile` (2650):**
- Before the existing UPDATE, look up the target row by `plan_file`. If `feature_id != ''`, reject: return `false` and surface a structured error so the API can emit 400 (see LocalApiServer change below). If `is_feature === 1`, after the existing UPDATE, run the cascade UPDATE for its subtasks.
- This sink is keyed by `plan_file` (single plan), so the guard is single-row — simpler than `setProjectForPlans`.

**Implementation — startup reconcile (new, idempotent, NOT version-gated):**
- Add `public async reconcileSubtaskProjectInheritance(): Promise<number>` near the other reconcile methods (~3907 area).
- SQL: `UPDATE plans SET project = (SELECT f.project FROM plans f WHERE f.plan_id = plans.feature_id), project_id = (SELECT f.project_id FROM plans f WHERE f.plan_id = plans.feature_id), updated_at = ? WHERE feature_id != '' AND EXISTS (SELECT 1 FROM plans f WHERE f.plan_id = plans.feature_id AND (f.project != plans.project OR f.project_id != plans.project_id))`.
- Returns count of repaired rows; log it.
- Call site: at the end of the migration/init chain, near `reconcileHotCold` (~7574), run on every startup. NOT a V-numbered migration — this is a live invariant, not a column repair.

**Edge Cases:**
- `''`/none is a valid feature project — the cascade UPDATE sets subtasks to `''`/NULL too. The `WHERE feature_id != ''` predicate excludes loose plans.
- `project_id` NULL vs 0 — the existing V38 backfill treats both as "needs repair"; the reconcile uses `!=` which treats NULL as not-equal per SQL NULL semantics. Use `IS NOT` explicitly in the EXISTS clause if sql.js needs it (verify during implementation; sql.js follows SQLite NULL semantics).
- A feature whose own `feature_id` is set (malformed row) — the guard's `is_feature` branch takes precedence (cascade), which is correct.

### `src/services/KanbanProvider.ts`

**Context:** Propagate the feature's project onto subtasks at attach time (step 1), bypassing the subtask-reject guard.

**Logic — `assignPlansToFeature` (11471):**
- After `await db.updateFeatureStatus(subtask.planId, 0, feature.planId)` (11405), add: `await db.setProjectForPlansInternal(workspaceId, [subtask.planId], feature.project, { bypassSubtaskGuard: true })` — where `setProjectForPlansInternal` is the structured-return variant that honors the bypass flag. This writes the feature's project (including `''`) onto the just-attached subtask.
- `feature.project` is already in scope (the row was fetched at 11488 via `resolveFeatureIdentifier`). Reuse it; do not re-fetch.

**Logic — `createFeatureFromPlanIds` (11256):**
- After the subtask link loop (11429-11436), add a propagate pass: for each `st` in `subtasks`, `await db.setProjectForPlansInternal(workspaceId, [st.planId], featureProject, { bypassSubtaskGuard: true })` using the already-resolved `featureProject`/`featureProjectId` (11309-11320). This ensures subtasks adopt the feature's final project, including the `''`/active-filter-fallback case.
- Note: `createFeatureFromPlanIds` currently DERIVES the feature's project FROM subtasks (11309). If subtasks disagree, the feature picks the first non-empty. The propagate pass then forces ALL subtasks to that chosen project — which is the correct post-fix behavior (one feature = one project). Flag this in the code comment so a future reader understands the direction flip.

**Logic — `splitFeature` (11531):**
- No direct change — it routes through `createFeatureFromPlanIds`, which now propagates. Verify (don't double-handle) by adding an assertion in the verify plan below.

**Edge Cases:**
- The propagate write bumps `updated_at` on the subtask — acceptable (attach is a touch).
- If `feature.project` is `''` (no-project feature), the propagate writes `''`/NULL onto the subtask — correct per the invariant.

### `src/services/LocalApiServer.ts`

**Context:** Surface the subtask-reject from `updatePlanProjectByPlanFile` as a 400 (step 3, API path).

**Logic — `_handleSetPlanProject` (2187) / `_handlePlanFieldUpdate` (2196):**
- `updatePlanProjectByPlanFile` currently returns boolean. Change the contract (or add a parallel `updatePlanProjectByPlanFileInvariant` returning `{ ok, reason }`) so the API can distinguish reject from not-found from DB-error.
- When the reject reason is `subtask_project_governed_by_feature`, respond `400` with `{ error: "A subtask's project is governed by its feature; set the feature's project instead." }`.
- Keep the existing 404 (plan not found) and 503 (DB unavailable) ordering.

**Edge Cases:**
- The 400 must not leak whether the planId exists to an unauthenticated caller — auth check (`_checkAuth(req, true)`) already runs first, so the reject is post-auth. Safe.

### `src/services/KanbanProvider.ts` — webview `assignSelectedToProject` (7204)

**Context:** Surface the subtask-reject from `setProjectForPlans` to the webview (step 3, webview path).

**Logic:**
- `setProjectForPlans` returning `false` could mean DB error OR reject. Use the structured-return variant (`setProjectForPlansInvariant`) so the webview handler can distinguish.
- On reject, return `{ success: false, error: 'A subtask\'s project is governed by its feature; set the feature\'s project instead.' }` — the webview already surfaces `error` in a toast (verify the webview JS handles `error` on this handler; if not, add a toast).
- On cascade (feature target), the existing `_refreshBoard` (7211) re-renders with the cascaded subtasks.

### `_removeSubtaskFromFeature` (11070) — detach

**Context:** Step 4 — detach leaves the plan's project as-is.

**Logic:** No code change. Add a code comment at 11083 (`await db.updateFeatureStatus(subtask.planId, 0, '')`) documenting: "On detach, the plan becomes a loose plan in whatever project it was in — no project change. The invariant (subtask.project == feature.project) no longer applies because the plan is no longer a subtask."

## Verification Plan

### Automated Tests

_(Automated tests are out of scope per session directive — skip running the test suite. The following manual verification steps are the acceptance criteria.)_

### Manual Verification

1. **Propagate on assign (webview):** Create a loose plan on project X. Create a feature on project Y. Assign the plan to the feature via the board. → Plan's `project`/`project_id` become Y. Assign a loose plan to a no-project feature → plan becomes `''`/NULL.
2. **Propagate on create-feature-from-plans:** Select loose plans on mixed projects (X, Y, Z). Create a feature (auto-picks first non-empty project, say X). → ALL subtasks become X (the divergent ones are normalized).
3. **Cascade on feature project change (BOTH paths):**
   - **Webview:** Select a feature card, change its project to W via `assignSelectedToProject` → all its subtasks become W in one refresh.
   - **API:** `PUT /kanban/plans/project` with the feature's planId and project W → all subtasks become W.
4. **Reject direct subtask project change (BOTH paths):**
   - **Webview:** Select a subtask card, change its project directly → rejected with the clear message; board shows a toast.
   - **API:** `PUT /kanban/plans/project` with a subtask's planId → 400 with the message.
   - In both cases, the board can never reach `subtask.project ≠ feature.project`.
5. **Startup reconcile repairs drift:** Seed a divergent row directly in the DB (subtask project ≠ its feature's). Restart the extension → the reconcile runs, the row is repaired, the subtask renders under its feature (no vanishing). Verify the reconcile log line reports 1 repaired row.
6. **Split safety:** Create a feature with subtasks on project P. Split it. → Both new features inherit P; their subtasks are all on P. (Verifies `splitFeature` → `createFeatureFromPlanIds` propagate.)
7. **Detach preserves project:** Detach a subtask from a feature on project P. → The now-loose plan keeps project P. Re-assign it to a feature on project Q → it becomes Q.

## Watch out

- **Enforce at BOTH sinks, not one.** The original plan named `KanbanDatabase.assignPlansToProject` (3614) as the shared choke point for both the webview and the API. This is wrong:

  > **Superseded:** "KanbanDatabase.assignPlansToProject (3614) backs BOTH the webview `assignSelectedToProject` and the API `PUT /kanban/plans/project` — put the subtask check there (or just above it) so both paths are covered, not one."
  > **Reason:** Verified by reading the source: the webview `assignSelectedToProject` (`KanbanProvider.ts:7210`) calls `setProjectForPlans` (`KanbanDatabase.ts:3477`) DIRECTLY, never touching the 3614 wrapper. The API `PUT /kanban/plans/project` (`LocalApiServer.ts:2224`) calls a THIRD function, `updatePlanProjectByPlanFile` (`KanbanDatabase.ts:2650`), keyed by `plan_file` — a completely separate UPDATE. `assignPlansToProject` (3614) is only called from `TaskViewerProvider` plan-create-with-project (`19055`), which targets NEW plans with no `feature_id` (the guard is a no-op there). Patching only 3614 leaves BOTH the webview AND the API as re-entry vectors for the vanishing-subtask state.
  > **Replaced with:** Install the subtask-reject + feature-cascade guard in BOTH `setProjectForPlans` (3477) AND `updatePlanProjectByPlanFile` (2650), via a shared `_enforceProjectInvariant` helper. The webview path is covered by `setProjectForPlans`; the API path by `updatePlanProjectByPlanFile`; the plan-create path (3614 → 3477) is covered by `setProjectForPlans` and is a no-op for the guard (new plans have no `feature_id`).

- **`''`/none is a valid feature project** (projects are optional) — propagation and cascade must set subtasks to `''`/NULL too, never skip when the feature has no project.
- **`splitFeature` (11531) routes through `createFeatureFromPlanIds`** — fixing the propagate pass in `createFeatureFromPlanIds` covers it; verify via manual test 6, don't double-handle.
- **`feature_id` vs legacy `epic_id`** — don't confuse them (see the epic_id→feature_id migration at `KanbanDatabase.ts:7325`).
- **Backfill = idempotent startup reconcile, NOT a V-numbered migration.** The V38/V47/V50 migrations at 7057/7325/7480 are version-gated column/legacy repairs (run-once is correct for them). The subtask-project invariant is a LIVE correctness check — a one-shot migration repairs legacy rows but not future drift (a bug, a direct DB edit, a stale sql.js snapshot flush). Run the reconcile every startup, near `reconcileHotCold` (~7574).
- **Propagate bypasses the guard.** Step 1's propagate-on-attach writes a subtask's project directly. Step 3's guard rejects direct subtask project writes. The propagate write MUST use the internal `bypassSubtaskGuard: true` path or the guard blocks the fix.
- **Worktree `project` column is out of scope.** `addWorktree` (3540) stores a `project` column, but `getWorktrees` (3515) does NOT filter by it — it's provisioning-time metadata. Cascade does not need to touch worktrees. Flagged for coder awareness only.

## Uncertain Assumptions

_(None. All claims verified by reading the actual source: the three project-set sinks, the `assignPlansToFeature`/`createFeatureFromPlanIds`/`_removeSubtaskFromFeature`/`splitFeature` bodies, the V38/V47/V50 migration sites, and the `getWorktrees` query. No external library/API behavior or web research is needed — this plan is entirely about internal codebase behavior.)_

---

**Recommendation:** Complexity 5 (mixed — routine propagate/cascade writes plus two moderate, well-scoped risks: the two-sink guard installation and the guard-vs-propagate ordering). **Send to Coder.**

---

## Completion Summary

Implemented the subtask-project inheritance invariant across both project-set sinks, the feature-attach paths, and an idempotent startup reconcile. Files changed: `src/services/KanbanDatabase.ts` (added `_enforceProjectInvariantOnRows` helper, `setProjectForPlansInvariant`, `updatePlanProjectByPlanFileInvariant`, `reconcileSubtaskProjectInheritance`; rewrote `setProjectForPlans` and `updatePlanProjectByPlanFile` as back-compat boolean wrappers; wired the reconcile into `_initialize` after migrations), `src/services/KanbanProvider.ts` (propagate-on-attach in `assignPlansToFeature` and `createFeatureFromPlanIds` via `bypassSubtaskGuard:true`; webview `assignSelectedToProject` now uses the invariant variant and surfaces a toast on reject; detach comment in `_removeSubtaskFromFeature`), and `src/services/LocalApiServer.ts` (`_handlePlanFieldUpdate` project branch uses the invariant variant and emits 400 on subtask-reject). The cascade UPDATE has no status filter (invariant holds for all subtasks); the reconcile uses `IS NOT` for NULL-safe comparison and runs every startup, not version-gated. No issues encountered; verification was read-back only per session directives (SKIP COMPILATION, SKIP TESTS).
