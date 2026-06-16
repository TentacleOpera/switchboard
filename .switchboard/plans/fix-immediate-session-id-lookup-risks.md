# Fix Immediate session_id Lookup Risks

## Goal

Fix the subset of deprecated `getPlanBySessionId` usages that are actively causing wrong-record returns, divergent UI behavior, or cross-database ghost record risks. These are the highest-severity call sites; fixing them immediately reduces breakage probability while the broader audit-and-migrate plan continues in parallel.

**Problem Analysis:** Four distinct failure modes are already active or imminent:
1. **PlanningPanelProvider.ts epic handlers** still use `getPlanBySessionId` while KanbanProvider.ts epic handlers already use `getPlanByPlanId`. Same epic operation behaves differently depending on which UI triggers it.
2. **`updateEpicStatus` wrapper** (KanbanDatabase.ts:1324) internally calls `getPlanBySessionId`. Even though KanbanProvider.ts epic lookups were migrated, the actual `UPDATE` statement may target the wrong row.
3. **`reassignPlansWorkspace`** (KanbanProvider.ts:4193) calls `getPlanBySessionId` with no `workspace_id` filter. Cross-DB ghost record risk if the same sessionId value exists in multiple workspace databases.
4. **TaskViewerProvider.ts registry loops** probe multiple candidate IDs (`antigravity_${planId}`, `planId`, path hashes) via `getPlanBySessionId`. Since `getPlanBySessionId` queries `session_id` first, it can match the wrong record if any plan's `session_id` collides with a candidate.

## Metadata

**Tags:** backend, refactor, database, bugfix
**Complexity:** 5

> **Plan Verification (2026-06-17, against live code):** This plan is partly stale. Fix 2 is **already applied**; Fix 3's proposed validation block is **incorrect** and must be rejected (only the lookup swap remains); Fix 1 can be reduced to a single upstream wrapper change. Fix 4 remains valid and is the primary work. See per-fix **Revision** notes below.

## User Review Required

No — this is a surgical fix with exact line numbers and minimal scope. (Reviewer applied corrections in-place — see Revision notes.)

## Complexity Audit

### Routine
- Replacing `getPlanBySessionId` with `getPlanByPlanId` in 4 PlanningPanelProvider.ts epic handler lookups
- Adding `updateEpicStatusByPlanId` wrapper and migrating 2 KanbanProvider.ts call sites
- Collapsing registry candidate loops to single `getPlanByPlanId` calls in TaskViewerProvider.ts

### Complex / Risky
- `reassignPlansWorkspace` (KanbanProvider.ts:4193) requires workspace validation after lookup to prevent cross-DB ghost records
- TaskViewerProvider.ts registry duplicate-check loop (line 10267) deletes records; changing the lookup method must not alter which records are identified as duplicates

## Edge-Case & Dependency Audit

### Race Conditions
- None. All changes are lookup-method replacements in sequential code paths.

### Security
- None.

### Side Effects
- Switching from `session_id`-first to `plan_id`-only eliminates collision risk but may miss un-backfilled legacy plans. Verify `plan_id` backfill is complete before deploying.
- `reassignPlansWorkspace` workspace validation adds a new check; if the returned record's `workspaceId` does not match, the reassign is skipped. This is safer than the current behavior but may surface previously hidden mismatches.

### Dependencies & Conflicts
- Depends on `fix-kanban-epic-button-uses-deprecated-session-id.md` being already applied (it is — KanbanProvider.ts epic handlers verified).
- No schema changes.

## Dependencies

- `fix-kanban-epic-button-uses-deprecated-session-id.md` — completed prerequisite

## Adversarial Synthesis

Key risks: (1) **Stale plan** — Fix 2 is already applied and Fix 3's proposed `targetWorkspaceId` guard is wrong (existing code validates against `sourceWorkspaceId` at `KanbanProvider.ts:4198`); blindly executing either causes no-op edits or breaks reassignment entirely. (2) **Fix 4 brain-plan backfill** — collapsing registry candidate loops to `getPlanByPlanId(entry.planId)` is correct because brain rows are keyed `plan_id = <bare hash>` (`TaskViewerProvider.ts:10100-10103`), but any un-backfilled legacy brain row missing `plan_id` will silently disappear from the sidebar. Mitigations: skip Fix 2; reduce Fix 3 to a one-line lookup swap; reduce Fix 1 to a single internal wrapper change (all 7 callers already pass planId); run a one-time DB pre-check for brain rows with empty `plan_id` before deploying Fix 4.

## Proposed Changes

### Fix 1 — `updateEpicStatus` Wrapper & KanbanProvider Call Sites

**File:** `src/services/KanbanDatabase.ts`
- **Line 1324:** Add `updateEpicStatusByPlanId(planId: string, isEpic: number, epicId: string): Promise<boolean>` that queries by `plan_id` directly (no `getPlanBySessionId` fallback), then runs the same `UPDATE plans SET is_epic = ?, epic_id = ? ... WHERE plan_file = ? AND workspace_id = ?` statement. Mark existing `updateEpicStatus` as `@deprecated`.

**File:** `src/services/KanbanProvider.ts`
- **Line 6507:** Change `await db.updateEpicStatus(sessionId, 1, '');` to `await db.updateEpicStatusByPlanId(planId, 1, '');`
- **Line 6521:** Change `await db.updateEpicStatus(st.planId || st.sessionId, 0, planId);` to `await db.updateEpicStatusByPlanId(st.planId || st.sessionId, 0, planId);` (parameter is already verified `planId` from the subtask record)

> **Revision (RECOMMENDED — simpler upstream fix):** Verification shows line 6507 already passes `planId` (not `sessionId` as quoted), and there are **7** callers of `updateEpicStatus`, all passing a planId: `KanbanProvider.ts:6429, 6443, 6507, 6521, 6533` and `PlanningPanelProvider.ts:2036, 2052`. The plan only migrates 2 of them, leaving 5 on the buggy `@deprecated` wrapper. **Preferred minimal fix:** change the wrapper's internal lookup at `KanbanDatabase.ts:1325` from `await this.getPlanBySessionId(sessionId)` to `await this.getPlanByPlanId(sessionId)` — one line, fixes all 7 callers, no new method, no call-site churn. (Keep the `@deprecated` annotation; optionally rename the param to `planId` for clarity.) If the new-method approach is preferred instead, migrate **all 7** callers, not just 2.

### Fix 2 — PlanningPanelProvider.ts Epic Handlers

**File:** `src/services/PlanningPanelProvider.ts`
- **Line 2002** (`getEpicDetails`): `const epic = await db.getPlanBySessionId(sessionId);` → `const epic = await db.getPlanByPlanId(sessionId);`
- **Line 2017** (`addSubtaskToEpic` epic lookup): same replacement
- **Line 2026** (`addSubtaskToEpic` subtask lookup): same replacement
- **Line 2065** (`deleteEpic`): same replacement

> **Revision (ALREADY APPLIED — no action needed):** Verification confirms all four PlanningPanelProvider epic handlers already use `getPlanByPlanId`: `getEpicDetails` at line 2002, `addSubtaskToEpic` epic lookup at 2017, subtask lookup at 2026, and `deleteEpic` at **2067** (not 2065). Skip Fix 2 entirely — re-editing would be a no-op, and an agent must NOT reintroduce `getPlanBySessionId` here.

### Fix 3 — `reassignPlansWorkspace` Cross-DB Validation

**File:** `src/services/KanbanProvider.ts`
- **Line 4193:** Replace `sourceDb.getPlanBySessionId(sessionId)` with `sourceDb.getPlanByPlanId(sessionId)`. After the lookup, add:
  ```typescript
  if (plan && plan.workspaceId !== targetWorkspaceId) {
      console.warn(`[KanbanProvider] reassignPlansWorkspace: plan ${sessionId} found but workspace mismatch (${plan.workspaceId} vs ${targetWorkspaceId})`);
      continue;
  }
  ```
  (If `targetWorkspaceId` is not already in scope, derive it from the target DB or the function's parameters.)

> **Revision (REJECT proposed validation block; lookup swap ONLY):** The proposed `plan.workspaceId !== targetWorkspaceId` guard is **incorrect** — the plan lives in the SOURCE database, so its `workspaceId` will never equal `targetWorkspaceId`, causing the loop to `continue` past every plan and reassign nothing. The live code at `KanbanProvider.ts:4198` **already** validates correctly against `sourceWorkspaceId` (skipping plans not belonging to the source). The only remaining change is the one-line lookup swap at **line 4193**: `sourceDb.getPlanBySessionId(sessionId)` → `sourceDb.getPlanByPlanId(sessionId)`. This is safe: `_cardId` is planId-first (`card.planId || card.sessionId`), so the IDs passed here are planIds. Do NOT add the proposed `if` block.

### Fix 4 — TaskViewerProvider.ts Registry Loop Collapse

**File:** `src/services/TaskViewerProvider.ts`
- **Line 9975** (`_getRegistryDbRecord`): Replace the candidate loop with a single `return db.getPlanByPlanId(planId);`. Remove `_getRegistrySessionIdCandidates` usage here.
- **Line 10267** (registry reconcile duplicate check): Replace candidate loop with `const duplicate = await db.getPlanByPlanId(candidateSessionId);`. If `candidateSessionId === planId` this is equivalent; if `candidateSessionId` is `antigravity_${planId}` it will no longer match, which is correct because the canonical key is `planId`.
- **Lines 10435, 10452, 10479, 10527** (registry hydrate loops): Replace each candidate loop with a single `const plan = await db.getPlanByPlanId(entry.planId);` before the inner logic, then read `plan?.topic`, `plan?.updatedAt`, `plan?.status` from that result.
- **Line 10573** (tombstone revive): `db.getPlanBySessionId(pathHash)` → `db.getPlanByPlanId(pathHash)`
- **Line 11204** (tombstone hash ensure exists): `db.getPlanBySessionId(hash)` → `db.getPlanByPlanId(hash)`

> **Revision (VALID — primary work; line numbers verified):** All cited line numbers confirmed against live code: `_getRegistryDbRecord` at 9975, reconcile duplicate check at 10267, hydrate loops at 10435/10452/10479/10527, tombstone revive at 10573, tombstone migration at 11204. This is the real, un-applied work and the highest-risk fix.
> - **Why it's safe:** Brain plan rows are stored with `plan_id = <bare hash>` and `session_id = antigravity_<hash>` (normalization at `TaskViewerProvider.ts:10100-10103`; registry entries keyed by normalized bare planId at 10256). So `getPlanByPlanId(entry.planId)` resolves brain rows correctly. Tombstone rows store `plan_id = hash` (`11206-11208`), so 10573/11204 swaps are safe.
> - **Residual risk (must pre-check):** Any legacy brain row that was never backfilled (empty `plan_id`, only `session_id = antigravity_<hash>` set) will no longer be found once the `antigravity_`-prefixed candidate is dropped, and will vanish from the sidebar. Before deploying, run a one-time check: `SELECT count(*) FROM plans WHERE (plan_id IS NULL OR plan_id = '') AND session_id LIKE 'antigravity_%';` — must return 0. If non-zero, backfill `plan_id` first.
> - **Note:** At 10267 the variable iterated is `candidateSessionId`; after collapse, pass `entry.planId` (the normalized canonical key) rather than the raw candidate, to match the new plan_id-only semantics.

## Verification Plan

### Automated Tests
Skipped per session directive.

### Manual Verification
1. Open a workspace with brain-imported plans. Verify TaskViewer sidebar loads and shows correct plan topics.
2. Open kanban board. Create an epic, add a subtask, remove a subtask, delete the epic. Verify each operation works.
3. Open planning panel. Repeat epic operations (create, add subtask, delete). Verify behavior matches kanban board exactly.
4. Move a plan between workspaces via `reassignPlansWorkspace`. Verify it appears in the target workspace and does not duplicate.

### Pre-Deploy DB Check (Fix 4 gate)
- Run `SELECT count(*) FROM plans WHERE (plan_id IS NULL OR plan_id = '') AND session_id LIKE 'antigravity_%';` against each affected workspace kanban DB. Result MUST be 0 before applying Fix 4. If non-zero, backfill `plan_id` for those rows first.

### Regression Checks
- Verify no plan lookups return wrong records (wrong card metadata, wrong epic association).
- Verify file-based plans (imported from brain watcher) with empty `session_id` are fully functional.
- After Fix 4: confirm brain-imported plans still appear in the TaskViewer sidebar (no silent disappearance from dropped `antigravity_`-prefixed candidate lookups).

## Recommendation

Complexity 5 → **Send to Coder** (focused multi-file fix, moderate logic, exact line numbers provided).

> **Revised actionable scope (post-verification):**
> - **Fix 1:** one-line wrapper change at `KanbanDatabase.ts:1325` (`getPlanBySessionId`→`getPlanByPlanId`). Skip the new-method/2-caller approach.
> - **Fix 2:** SKIP — already applied.
> - **Fix 3:** one-line lookup swap at `KanbanProvider.ts:4193` only. REJECT the proposed `targetWorkspaceId` guard.
> - **Fix 4:** apply as written (8 sites) AFTER the pre-deploy DB check passes. This is the primary work.
>
> Net remaining: 2 one-line swaps + the Fix 4 registry migration. Complexity remains **5** (Fix 4's brain-plan data-correctness risk keeps it Medium). **Send to Coder.**

## Scope

### In Scope
- Fix 1: `updateEpicStatusByPlanId` wrapper + KanbanProvider.ts call sites
- Fix 2: PlanningPanelProvider.ts epic handler migrations
- Fix 3: `reassignPlansWorkspace` workspace validation
- Fix 4: TaskViewerProvider.ts registry loop collapse (high-risk subset)

### Out of Scope
- All other `getPlanBySessionId` call sites (repoScope batch lookups, column move topic checks, archive, integration sync, ContinuousSyncService, SessionActionLog, tests) — deferred to the parent audit plan
- Removal of deprecated wrapper methods
- Database schema changes (removing `session_id` column)
