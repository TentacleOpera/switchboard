# Fix: is_feature Clobber via insertFileDerivedPlan Race

**Plan ID:** a1c3f7d2-8e5b-4a91-b6c0-9d2e4f8a1b5c

## Goal

Eliminate the race condition where a newly-created feature's `is_feature=1` flag gets silently overwritten to `0` within ~100-140ms of creation, causing the feature to appear as a regular plan on the kanban board instead of a feature card.

### Problem & background

The diagnostic log (`feature-clobber-diagnostic.txt`) reveals that features created via "Group into Feature" (and other `createFeatureFromPlanIds` callers) lose their `is_feature=1` flag almost immediately after creation. See /Users/patrickvuleta/Documents/GitHub/switchboard/.switchboard/plans/brain_d673e4bc23477effa79f2bbcb022db03fceba2a18cd67efadf3ff3284d4b2bc2.md for the original log analysis.

### Root cause — CORRECTED (evidence-verified 2026-07-05, supersedes the original persist-interleave hypothesis)

This plan was re-derived against live evidence: the 754-line diagnostic log, the current `kanban.db` contents, and the current source. The original hypothesis (persist-interleave / atomic-write delete→re-insert through the file watcher) is **wrong** — the file watcher is exonerated (see Evidence below). The actual mechanism is:

**The plan-registry "stale entry" canonicalization sweep in `TaskViewerProvider` hard-deletes the feature row and re-inserts it through a lossy record shape that has no `isFeature` field.**

The full causal chain:

1. `KanbanProvider.createFeatureFromPlanIds` (KanbanProvider.ts:10136-10137) mints **two different UUIDs**: `planId = crypto.randomUUID()` and `sessionId = crypto.randomUUID()`. The feature row is committed with `session_id ≠ plan_id`.
2. `TaskViewerProvider._loadPlanRegistry` (TaskViewerProvider.ts:11569) runs on **every** `_activateWorkspaceContext` call (TaskViewerProvider.ts:1457 — fired by sidebar plan-creation handling, metadata sync, registry init, and more). At line 11598 it flags any row where `p.sessionId !== canonicalSessionId` as a "stale entry". For `sourceType='local'`, `_getRegistrySessionId(planId, 'local')` returns `planId` itself (TaskViewerProvider.ts:11448-11455) — so **every feature created by `createFeatureFromPlanIds` is flagged stale by construction**, and so is every watcher-imported plan (`session_id=''`).
3. Each stale entry is routed to `_registerPlan` (TaskViewerProvider.ts:11631 → 11750). There:
   - Line 11756-11759: `existing = getPlanByPlanId(entry.planId)` finds the feature row; `existing.sessionId` (random UUID) `!== sessionId` (planId) → **`db.deletePlan(existing.sessionId)` — hard DELETE of the feature row** (KanbanDatabase.ts:2245-2252).
   - Line 11800: `db.insertFileDerivedPlan({...})` re-inserts the row from a `PlanRegistryEntry` — a record shape that **carries no `isFeature`, no `featureId`, no `projectId`**. It is a fresh INSERT (the row was just deleted), so the ON CONFLICT stickiness never applies: `is_feature` lands at `record.isFeature ?? 0` = **0**, and `kanban_column` lands at the hardcoded `'CREATED'` in the VALUES clause (KanbanDatabase.ts:1477).
4. After normalization the row has `session_id = plan_id`, so it is never flagged stale again — the demotion is a **one-shot, permanent** clobber that looks spontaneous.

**Evidence (all three fingerprints match, no counter-evidence):**

- **Log line 660 (12:56:16.695Z):** the `dev-docs…6a7d5edc` feature row is **absent** from the persist snapshot (present with `is_feature:1` at 16.655, present with `is_feature:0` at 16.730). The row was hard-deleted and re-inserted — not flipped in place. The original analysis missed this because `_diagFeatureSnapshot` logs the row list, and the reader compared values without noticing the row's disappearance in the intermediate persist.
- **Current DB row for the clobbered feature:** `plan_id = session_id = 6a7d5edc-…` (only `_registerPlan`-family writers set `session_id = plan_id`; `createFeatureFromPlanIds` mints them independently), `created_at = 12:56:16.547Z` (the original `upsertPlan` time, carried through `entry.createdAt = p.createdAt`), `updated_at = 12:56:16.655Z` (**frozen at the pre-delete row's value**, carried through `entry.updatedAt = p.updatedAt` — proof the writer read the row, deleted it, and re-inserted from the read), `kanban_column = CREATED`, `is_feature = 0`, `project` lost.
- **The healed sibling:** `online-docs-inline-editing.md` (clobbered at 10:23:52, later restored) also shows `session_id = plan_id` — it went through the same normalization.
- **Watcher exonerated:** no `watcher._handlePlanFile` diag line exists for the dev-docs file at 12:56 (that probe fires before any watcher DB write), and the pending-creation guard (GlobalPlanWatcherService.ts:447, 10s TTL, registered at KanbanProvider.ts:10205 *before* the file write) blocks the watcher for this window anyway.
- **`sameInstance=true` DID fire** (log line 652, 12:56:16.545Z) — the original analysis' claim that no `createFeatureFromPlanIds` probe fired is incorrect; candidate ❷ (split instances) is conclusively dead.
- **Scale:** the DB currently holds **99 active rows with `session_id ≠ plan_id`** — each one is a pending one-shot normalization that will hard-delete + lossy-reinsert its row (resetting `kanban_column` to CREATED and, for features, `is_feature` to 0) the next time the sweep reaches it.

**Corrections to claims in the original plan (verified against current source):**

- Original Fix 1 (pending-creation guard in `_handlePlanFile`) **already exists** at GlobalPlanWatcherService.ts:447-450 and fully returns (it is not "logging suppression only"). `registerPendingCreation` is called at KanbanProvider.ts:10205 (creation), 9917 (`_regenerateFeatureFile`), and 8991 (`promoteToFeature`). TTL is 10000ms (GlobalPlanWatcherService.ts:47-49), not 3000ms as stale comments claim.
- Original Fix 3's binding question is resolved: `insertFileDerivedPlan` binds 14 placeholders to 14 params; `record.isFeature ?? 0` is correctly the last bind for `is_feature`. The SQL is correct; the bug is that the re-inserting caller never sets `isFeature`.
- extension.ts:515-523 is **not** a 15-minute self-heal timer — it wires the feature-column recomputer. No automatic `is_feature` self-heal timer exists; currently-clobbered rows stay clobbered until the watcher happens to re-process the file (mtime change). A one-time heal is therefore included below (Change 5).
- The `feature_id` plumbing **works**: subtask row `04a0b320-…` carries `feature_id = 6a7d5edc-…`. Empty `feature_id` on feature rows themselves is by design (original Fix 4 resolved — verified, no change needed).

## Metadata

**Tags:** backend, bugfix, database, reliability
**Complexity:** 6

## User Review Required

- None. (All decisions below are stated, not deferred. The optional `sessionId = planId` change in `createFeatureFromPlanIds` is included as Change 4 with rationale; strike it if you disagree.)

## Complexity Audit

### Routine

- New tiny `KanbanDatabase` method `canonicalizeSessionIdByPlanId` (single UPDATE via existing `_persistedUpdate` pattern).
- Path-derived `is_feature` floor inside `insertFileDerivedPlan` (one expression change + one bind change).
- `createFeatureFromPlanIds` minting `sessionId = planId` (one line).
- V49 heal migration (idempotent UPDATE, follows the existing `MIGRATION_Vnn_SQL` + `_runMigrations` pattern; new block, never edits shipped migration bodies).
- Probe cleanup (mechanical, after UAT).

### Complex / Risky

- Rewriting `_registerPlan`'s delete+reinsert canonicalization to an in-place UPDATE — must not regress the genuine brain-mirror normalization (`antigravity_` prefix rows) that the delete path was built for.
- The stale-entry sweep in `_loadPlanRegistry` currently has 99 pending rows in this DB; the fixed sweep must not cause a persist storm (99 individual `_persist()` flushes) on its first pass.

## Edge-Case & Dependency Audit

**Race Conditions**

- The pending-creation guard (10s TTL) already covers the watcher during creation; this plan does not touch it.
- `_registerPlan` in-place canonicalization is a read-then-update; if the row is deleted between read and update, the UPDATE affects 0 rows — harmless (the old code would have thrown nothing either).
- The sweep and `createFeatureFromPlanIds` can interleave: with Change 4 (`sessionId = planId` at mint), a brand-new feature is never stale, closing the window entirely for new features.

**Security**

- No new inputs, no SQL built from user strings (all parameterized). No change to file-system write scopes.

**Side Effects**

- After Change 1+2, the first `_loadPlanRegistry` pass will canonicalize up to 99 rows' `session_id`. Anything that looks up plans by the OLD random `session_id` would break — audit shows run-sheet lookups key on `plan_id`/plan file for modern rows; legacy `sess_*` rows keep working because their session ids are only canonicalized, and `deletePlan(sessionId)` callers resolve via `getPlanBySessionId` on current values. Batch the canonicalization (single BEGIN…COMMIT + one `_persist()`), not 99 separate persists.
- V49 promotes any `.switchboard/features/` row back to `is_feature=1`. Files under `features/` are features by definition (the watcher already asserts this on every import at GlobalPlanWatcherService.ts:587/660), so no false promotions.

**Dependencies & Conflicts**

- ~4,000-install published extension: the stale sweep and delete+reinsert behavior **shipped**, so rows damaged by it in the field must be healed by migration (Change 5), not assumed absent.
- Do not edit shipped `MIGRATION_Vnn_SQL` bodies (V46/V47 incident); V49 is a new block.
- The `switchboard-vsix-no-node-modules` constraint is unaffected (no new deps).

## Dependencies

- None.

## Adversarial Synthesis

Key risks: (1) regressing the brain-mirror registry normalization that the delete+reinsert path legitimately serves; (2) a persist storm when the fixed sweep first canonicalizes the 99 backlogged rows; (3) missing field-damaged rows already in the install base. Mitigations: restrict destructive normalization to `sourceType='brain'` rows only, batch local canonicalization in one transaction + one persist, and ship the V49 heal migration plus the path-derived `is_feature` floor in `insertFileDerivedPlan` as a structural backstop for any writer.

## Proposed Changes

### 1. `src/services/TaskViewerProvider.ts` — make `_registerPlan` canonicalization non-destructive

- **Context:** `_registerPlan` (lines 11750-11830) hard-deletes the existing row (11757-11759) when its `session_id` differs from the canonical registry session id, then re-inserts via `insertFileDerivedPlan` (11800) from a `PlanRegistryEntry` that has no `isFeature`/`featureId`/`projectId` fields — and a fresh INSERT hardcodes `kanban_column='CREATED'`.
- **Logic:** when `existing` is found and `existing.planId === entry.planId` (same row, wrong session key), canonicalize the session id **in place** and let the subsequent `insertFileDerivedPlan` hit its ON CONFLICT branch (which is sticky for `is_feature` and never touches `kanban_column`/`feature_id`). Only fall back to `deletePlan` when the plan ids genuinely differ (the brain-mirror rename case this code was built for).
- **Implementation:**
  ```typescript
  if (existing && (existing.planId !== entry.planId || existing.sessionId !== sessionId)) {
      if (existing.planId === entry.planId) {
          // Same row, non-canonical session key. Canonicalize IN PLACE.
          // The old delete+reinsert dropped every DB-owned column not present in
          // PlanRegistryEntry (is_feature, feature_id, kanban_column, project_id,
          // worktree_id, provider ids) — this was the feature-demotion bug.
          await db.canonicalizeSessionIdByPlanId(entry.planId, sessionId);
      } else {
          await db.deletePlan(existing.sessionId);
      }
  }
  ```
  Additionally, pass `isFeature: existing?.isFeature` into the `insertFileDerivedPlan` record at line 11800 (belt-and-braces: even if a future path reaches a fresh INSERT, the feature flag survives).
- **Edge cases:** the duplicate-candidate loop at 11760-11766 only fires for brain rows (`_getRegistrySessionIdCandidates` returns one element for local) — leave it unchanged.

### 2. `src/services/TaskViewerProvider.ts` — scope the `_loadPlanRegistry` stale sweep

- **Context:** lines 11595-11634. The sweep's own log line says "Normalized N stale **brain** registry row(s)" — local rows were never its intended target, yet the `p.sessionId !== canonicalSessionId` test catches every local row whose `session_id ≠ plan_id` (99 currently pending in this DB).
- **Logic:** split stale entries by source type. Brain rows keep the existing `_registerPlan` path (their plan_id genuinely changes, delete+reinsert is the designed rename). Local rows whose ONLY defect is a non-canonical `session_id` get batched in-place canonicalization.
- **Implementation:** collect `{planId, canonicalSessionId}` pairs for local stale rows; call one new batched method `db.canonicalizeSessionIds(pairs)` (BEGIN → N UPDATEs → COMMIT → single `_persist()`), then route only brain stale entries through `_registerPlan` as today.
- **Edge cases:** a local stale row whose `planId` also mismatches (`effectivePlanId` fallback `p.planId || p.sessionId` when `plan_id` is empty) is rare legacy data — route those through `_registerPlan` (they need the rebuild), but with the `isFeature: existing?.isFeature` passthrough from Change 1 they can no longer demote features.

### 3. `src/services/KanbanDatabase.ts` — structural guard: path-derived `is_feature` floor in `insertFileDerivedPlan`

- **Context:** lines 1446-1516. The last bind is `record.isFeature ?? 0` (line 1503). Any caller that omits `isFeature` for a `.switchboard/features/` path creates a demoted feature on fresh INSERT (`SessionActionLog._doCreateRunSheet` at SessionActionLog.ts:504 is another such caller today).
- **Implementation:**
  ```typescript
  // is_feature floor: a file under .switchboard/features/ IS a feature, no matter
  // which caller built the record. Prevents any lossy record shape (registry
  // entries, run-sheet records) from demoting a feature on fresh INSERT.
  const effectiveIsFeature = (record.isFeature && record.isFeature > 0)
      ? record.isFeature
      : (relativePlanFile.replace(/\\/g, '/').startsWith('.switchboard/features/') ? 1 : 0);
  ```
  Bind `effectiveIsFeature` instead of `record.isFeature ?? 0`. The ON CONFLICT CASE at line 1485 already handles the update path.
- Also add the new methods next to `deletePlan` (~line 2252):
  ```typescript
  /** Canonicalize a row's session_id without touching any other column. */
  public async canonicalizeSessionIdByPlanId(planId: string, sessionId: string): Promise<boolean> {
      if (!planId || !sessionId) return false;
      return this._persistedUpdate('UPDATE plans SET session_id = ? WHERE plan_id = ?', [sessionId, planId]);
  }
  /** Batched variant: one transaction, one _persist(). */
  public async canonicalizeSessionIds(pairs: Array<{ planId: string; sessionId: string }>): Promise<boolean> { /* BEGIN, loop UPDATE, COMMIT, single _persist() — mirror upsertPlans' shape at :1381 */ }
  ```

### 4. `src/services/KanbanProvider.ts` — stop minting mismatched ids in `createFeatureFromPlanIds`

- **Context:** lines 10136-10137 (`const planId = crypto.randomUUID(); const sessionId = crypto.randomUUID();`).
- **Implementation:** `const sessionId = planId;` — the registry canonical form is `session_id = plan_id`, and the system already converges every row to that form; minting it correct at birth removes the feature from the stale set entirely (defense-in-depth for any sweep path missed by Changes 1-2).
- **Edge cases:** `featureSessionId` is still returned to callers (value now equals `featurePlanId`); `session_id` has not been a unique key since V20, and subtask lookups deliberately use `planId` (comment at 10221-10222). No consumer depends on the two ids differing.

### 5. `src/services/KanbanDatabase.ts` — V49 heal migration for already-clobbered rows

- **Context:** the install base (and this workspace: `dev-docs-tab-in-place-fixes-feature-…` is `is_feature=0` right now) contains feature rows demoted by the shipped sweep. No self-heal timer exists (the extension.ts:515-523 reference in the original plan is the column recomputer, not an `is_feature` healer).
- **Implementation:** new `MIGRATION_V49_SQL` block (after the V48 handler, ~line 5782), following the V45 array + `_runMigrations` pattern:
  ```sql
  UPDATE plans SET is_feature = 1
  WHERE plan_file LIKE '.switchboard/features/%' AND is_feature = 0;
  ```
  Idempotent; safe for every released version because files under `features/` are features by definition. Do NOT touch `kanban_column` here — the tombstone/recompute machinery owns column healing, and features demoted long ago may have been legitimately moved since.

### 6. Remove diagnostic probes after the fix is verified (unchanged from original plan)

After UAT confirms the clobber is gone, clean up all temporary probes per `docs/epic-clobber-log-reading-plan.md` §4:
- `src/services/featureClobberDiag.ts` (entire file)
- instanceId field, `_nextInstanceId`, demotion guard, `_diagFeatureSnapshot` and its calls in `_persist`/`_reloadIfStale` (KanbanDatabase.ts)
- DB-instance-check block in `KanbanProvider.createFeatureFromPlanIds`
- Feature-file-handle log in `GlobalPlanWatcherService._handlePlanFile`
- Generated `.switchboard/feature-clobber-diagnostic.txt` files

## Sequencing

1. **Change 3** (`is_feature` floor + new DB methods) — structural backstop, zero-risk, makes every later step safe.
2. **Change 1** (`_registerPlan` in-place canonicalization) — kills the delete+reinsert demotion vector.
3. **Change 2** (`_loadPlanRegistry` sweep scoping + batching) — stops the 99-row backlog from thrashing.
4. **Change 4** (`sessionId = planId` at mint) — closes the window at the source.
5. **Change 5** (V49 heal) — repairs field damage.
6. **Change 6** (probe cleanup) — only after UAT.

## Verification Plan

Session directives: SKIP COMPILATION and SKIP TESTS — no build step and no automated test run are part of this plan's verification.

### Automated Tests

- Skipped per session directive. (If later desired: a unit test around `insertFileDerivedPlan` asserting the `features/`-path floor, and one around `_registerPlan` asserting no `deletePlan` call when only `session_id` differs.)

### Manual / SQL verification (via installed VSIX, never repo `dist/`)

1. Repro the original flow once: select a plan → **Group into Feature**. Then run:
   ```sql
   SELECT plan_id, session_id, is_feature, kanban_column FROM plans
   WHERE plan_file LIKE '.switchboard/features/%' ORDER BY created_at DESC LIMIT 3;
   ```
   Expect the new feature: `is_feature=1`, `session_id = plan_id`, column derived from subtasks — and it must still read `is_feature=1` after clicking around the sidebar (which fires `_activateWorkspaceContext` → `_loadPlanRegistry`).
2. Confirm the V49 heal: `SELECT COUNT(*) FROM plans WHERE plan_file LIKE '.switchboard/features/%' AND is_feature=0;` → 0.
3. Confirm sweep convergence without storms: after one sidebar activation, `SELECT COUNT(*) FROM plans WHERE session_id != plan_id AND status='active' AND source_type='local';` should drop toward 0, and the diagnostic file (while probes are still in) should show ONE `persist` line for the batch, not ~99.
4. Watch `feature-clobber-diagnostic.txt` during step 1: every persist snapshot must list the new feature at `is_feature:1` continuously — no disappearing row, no `:0` line.

---

## Original Analysis (superseded — preserved for history)

> The sections below are the plan as originally written. The root-cause hypothesis (persist-interleave / atomic-write delete→re-insert via the file watcher) is superseded by the evidence-verified root cause above. Preserved per content-preservation policy; do not implement Fixes 1-4 below.

### Original problem statement

The clobber pattern originally hypothesized:

1. `createFeatureFromPlanIds` calls `db.upsertPlan({...isFeature: 1})` → `_persist()` → writes `is_feature=1` to disk
2. ~100ms later, the file watcher fires `_handlePlanFile` for the newly-written `.md` file in `.switchboard/features/`
3. The watcher's existing-plan branch builds an `updatedRecord` with `isFeature: 1` and calls `insertFileDerivedPlan`
4. `insertFileDerivedPlan`'s ON CONFLICT clause has `is_feature = CASE WHEN excluded.is_feature > 0 THEN excluded.is_feature ELSE plans.is_feature END` — this should preserve `is_feature=1`
5. But the watcher then calls `updateFeatureStatus(planId, 1, '')` with an **empty feature_id** — which overwrites the feature_id column
6. Multiple rapid `_persist()` calls interleave, and between one persist flushing `is_feature=1` and the next, an intermediate state with `is_feature=0` appears

**The critical evidence (as originally read):** No `FEATURE-CLOBBER`, `sameInstance`, or `reload` probe events fired in 664 lines of diagnostic output. The `is_feature` transition from 1→0 happened on the **same instance (#3)**, 107-137ms after the last `is_feature=1` persist, without any explicit demotion call going through `updateFeatureStatus`. This means the clobber is happening through a write path the probes don't cover — most likely a rapid re-import via `insertFileDerivedPlan` where the row is briefly deleted (atomic write: temp+rename triggers `_handlePlanDelete` then `_handlePlanFile`) and re-inserted with `is_feature=0` as the column default.
*(Correction: the `sameInstance` probe DID fire — log line 652. And the delete→re-insert was real but came from the registry sweep, not the watcher/atomic-write path.)*

**Secondary issue (original):** The `feature_id` column is empty (`''`) for every single feature in the diagnostic log. `createFeatureFromPlanIds` at KanbanProvider.ts:10172 explicitly passes `featureId: ''`, and `updateFeatureStatus(effectiveFeaturePlanId, 1, '')` at :10234 re-asserts with an empty featureId. A feature's own `feature_id` is supposed to be empty (it identifies which feature a *subtask* belongs to), but the empty `feature_id` on subtask rows may cause UI filtering issues if the subtask-linking at :10223 calls `updateFeatureStatus(st.planId, 0, effectiveFeaturePlanId)` — note `isFeature=0` for subtasks, which is correct (subtasks are not themselves features), but the `is_feature=0` write on the subtask triggers a `_persist()` that snapshots all rows, and if any intermediate persist captures a half-updated state it becomes the on-disk truth.
*(Resolution: verified working — subtask row `04a0b320-…` carries the correct `feature_id`.)*

### Original root cause hypothesis

The root cause was hypothesized as a **persist-interleave race** in a single sql.js instance. `createFeatureFromPlanIds` does:

1. `upsertPlan` → `_persist()` (feature row: `is_feature=1`)
2. `writeFile` (creates the `.md` file)
3. For each subtask: `updateFeatureStatus` → `_persist()` (subtask row changes, but feature row is snapshotted too)
4. Final `updateFeatureStatus(featurePlanId, 1, '')` → `_persist()` (re-assert)

Between steps 2 and 4, the file watcher can trigger `_handlePlanFile` for the new `.md`, which calls `insertFileDerivedPlan` → `_persist()`. But the watcher's `_handlePlanFile` also handles the `_handlePlanDelete` from the atomic write pattern (temp+rename = delete old + create new), which:
- Deletes the row (setting `is_feature` back to 0 via column default on re-insert)
- Re-inserts via `insertFileDerivedPlan` with `is_feature = record.isFeature ?? 0`

Even though the watcher sets `isFeature = 1` for feature files and calls `updateFeatureStatus`, the rapid succession of `_persist()` calls (412 in this session) means any intermediate in-memory state that has `is_feature=0` can be flushed to disk as the authoritative snapshot.

*(Why this is wrong: sql.js is synchronous — `_persist()` exports a full snapshot of the in-memory DB at call time and serializes writes through `_writeTail`, so an `is_feature=0` snapshot can only exist if the in-memory DB actually held 0 at that instant. `createFeatureFromPlanIds` writes via plain `fs.promises.writeFile` (no temp+rename), so no delete event fires; `_handlePlanDelete` additionally has an `fs.existsSync` guard at GlobalPlanWatcherService.ts:750; and the pending-creation guard blocks `_handlePlanFile` for 10s. The watcher path cannot produce the observed writes.)*

### Original Fixes 1-5 (superseded)

- **Fix 1** — pending-creation guard in `_handlePlanFile`: **already implemented** at GlobalPlanWatcherService.ts:447-450; no work to do.
- **Fix 2** — `insertFeaturePlanAtomic` combined transaction: unnecessary; the watcher paths were not the writer, and persists are already serialized snapshots.
- **Fix 3** — post-insert verify/force-fix block in `insertFileDerivedPlan`: superseded by the simpler path-derived `is_feature` floor (Change 3 above), which prevents rather than repairs.
- **Fix 4** — `feature_id` diagnostic extension: resolved — subtask `feature_id` plumbing verified working against the live DB.
- **Fix 5** — probe cleanup: retained as Change 6 above.

### Original edge cases & risk notes (preserved)

- **Pending-creation TTL**: verified — pruned on a 10000ms timer (GlobalPlanWatcherService.ts:47-49).
- **Atomic-write race window**: sql.js synchronous API inside a single `BEGIN`…`COMMIT` block prevents mid-transaction persists since sql.js is single-threaded within a JS microtask. *(Confirmed, which is precisely why the interleave hypothesis could not hold.)*
- **Existing clobbered features**: the "~15-minute self-heal timer at extension.ts:515-523" does not exist as described (those lines wire the column recomputer); healing is handled by Change 5 (V49).
- **Multi-window**: the diagnostic log shows only `instance=#3`; `sameInstance=true` confirms the single-instance path. The multi-instance candidate (❷) is dead.

## Recommendation

**Send to Coder** (Complexity 6).

## Review Findings

Reviewed commit b259620 (2026-07-06): all five code changes implemented as specified across `KanbanDatabase.ts` (is_feature floor, `canonicalizeSessionIdByPlanId`/`canonicalizeSessionIds`, V49 migration), `TaskViewerProvider.ts` (in-place `_registerPlan` canonicalization with `isFeature` passthrough, batched sweep split), and `KanbanProvider.ts` (`sessionId = planId` at mint); Change 6 (probe cleanup) correctly deferred to post-UAT. No CRITICAL/MAJOR findings; no fixes applied. Two NITs noted: the `else { deletePlan }` branch in `_registerPlan` is unreachable (lookup is by `plan_id`, so `existing.planId !== entry.planId` is impossible), and a theoretical duplicate-row window exists if a same-`plan_id` row under a different `plan_file` carried a stale session key — no current caller can construct that, so no guard was added. Verification was SQL-only per session directives (SKIP COMPILATION/TESTS): a dry run on a copy of the live `kanban.db` (at V48) confirmed V49 heals exactly the one known demoted feature (`6a7d5edc`, idempotently) and the batched sweep has no backlog storm (the sole raw-SQL "stale" active-local row is a brain-mirror file the sweep's source-type conversion already handles). Remaining risks: the theoretical duplicate-row window above, and UAT still needs to confirm a fresh "Group into Feature" survives sidebar activation with `is_feature=1` before probes are removed.
