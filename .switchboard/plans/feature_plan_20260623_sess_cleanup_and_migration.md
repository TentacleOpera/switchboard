# Remove sess_ Dedup Helpers + V38 Migration

## Goal

Remove the now-redundant `cleanupDuplicateLocalPlans` dedup helper and trim the `sess_%`-specific block from `cleanupSpuriousMirrorPlans` in `KanbanDatabase.ts`, remove their callsites and the deferred cleanup timer from `TaskViewerProvider.ts`, and add a one-time V38 DB migration to purge any remaining `sess_` rows from user databases.

**Prerequisite:** This plan depends on `feature_plan_20260623_kill_sess_fallback_generator.md` (the UUID fix) being shipped and in the field for a few weeks. The UUID fix stops new `sess_` rows from being created; this plan removes the band-aid cleanup code and does a final purge of legacy rows.

**Background:** The `sess_${Date.now()}` fallback generator was the root cause of orphan-plan and duplicate-row bugs. Two band-aid helpers were added to periodically delete `sess_%`-prefixed rows. After the UUID fix, no new `sess_` rows are created, so these helpers are dead code. The V38 migration does a final one-shot purge of any remaining `sess_` rows in user databases.

---

## Metadata

**Tags:** [backend, database, refactor]
**Complexity:** 5

---

## User Review Required

Yes — the V38 migration is a destructive `DELETE` that runs on ~4,000 installs. The SQL must be manually tested against a real DB containing `sess_` rows before shipping. Additionally, `cleanupSpuriousMirrorPlans` is multi-purpose and requires surgical partial removal, not wholesale deletion.

---

## Complexity Audit

### Routine
- Removing the `cleanupDuplicateLocalPlans` method from `KanbanDatabase.ts` — mechanical deletion (solely `sess_%`-focused)
- Removing the two `cleanupDuplicateLocalPlans` callsites in `TaskViewerProvider.ts`
- Removing the `_postRegistrationCleanupTimer` field, its usage in `_incrementallyRegisterPlan`, and its cleanup in `dispose()`
- Updating the test file that tests `cleanupDuplicateLocalPlans`

### Complex / Risky
- **`cleanupSpuriousMirrorPlans` is multi-purpose** — This method does FOUR things: (1) remove `sess_%` spurious mirror rows, (2) remove brain plans with empty `plan_file`, (3) remove rows with malformed `plan_file` paths, (4) remove rows with malformed `mirror_path`. Only (1) is `sess_`-related. The plan must preserve (2)–(4) by keeping the method and removing only the `sess_%` block, NOT deleting the entire method.
- **V38 migration SQL must use correct column names** — `plan_events` had its `session_id` column replaced with `plan_id` in V20. The migration must use `plan_id LIKE 'sess_%'` for `plan_events`, not `session_id LIKE 'sess_%'`. The `activity_log` table still has `session_id` (unchanged by any migration).
- **One-time DB migration on ~4,000 installs** — Destructive `DELETE` on user databases. Must be manually tested before shipping.

---

## Edge-Case & Dependency Audit

### Race Conditions
- **Dedup helper removal timing**: The `cleanupDuplicateLocalPlans` callsites are at a 1.5s deferred timer (line 13191–13208) and sync refresh paths (lines 2276, 2318). After removing the calls, the timer and calls become no-ops. No race condition. The `cleanupSpuriousMirrorPlans` callsite at line 2318 remains (for its non-`sess_` cleanup paths).

### Security
- No security implications.

### Side Effects
- **Existing `sess_` rows in user DBs**: The V38 migration purges them. Users with `sess_`-prefixed plans will see those plans disappear from the kanban board (they were orphans/duplicates — the canonical plan identified by `(plan_file, workspace_id)` remains).
- **Runsheet files on disk**: Existing runsheets created with `sess_` keys will become orphaned on disk (the DB row is deleted, so the runsheet won't be looked up). Harmless — small JSON files in `.switchboard/runsheets/`. A future cleanup could delete them, but it's not required.
- **Pre-existing latent bug in `cleanupDuplicateLocalPlans`**: Line 3647 does `DELETE FROM plan_events WHERE session_id = ?` but `plan_events` uses `plan_id` (not `session_id`) after V20. This statement throws on every invocation but is caught by surrounding try/catch, so the event cleanup silently never ran. This justifies removal — the coder should not be surprised that the old code "worked" despite this bug.

### Dependencies & Conflicts
- **Depends on `feature_plan_20260623_kill_sess_fallback_generator.md`** being shipped first. The UUID fix must be in the field long enough for no new `sess_` rows to be appearing.
- **Migration V38 must run after V37** — V37 is the latest verified migration (lines 4805–4808 of `KanbanDatabase.ts`). No V36/V37 migration constants exist as SQL arrays; they use dedicated `_runMigrationV36()` and `_runMigrationV37()` methods. V38 can follow either pattern.

---

## Dependencies

- `feature_plan_20260623_kill_sess_fallback_generator.md` — UUID fix must be shipped first

---

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) `cleanupSpuriousMirrorPlans` does more than `sess_%` cleanup — it also removes brain plans with empty `plan_file`, malformed paths, and malformed `mirror_path`; the plan must keep these paths and remove only the `sess_%` block; (2) the V38 migration SQL must use `plan_id LIKE 'sess_%'` for `plan_events` (not `session_id`, which was removed in V20) while `activity_log` still uses `session_id`; (3) the migration is destructive and runs on ~4,000 installs — must be manually tested. Mitigations: keep `cleanupSpuriousMirrorPlans` with only its `sess_%` block removed; fix the migration SQL column references; test the migration against a real DB with `sess_` rows before shipping.

---

## Proposed Changes

### Step 1 — Remove the `cleanupDuplicateLocalPlans` Callsites from TaskViewerProvider

File: `src/services/TaskViewerProvider.ts`

Remove the `cleanupDuplicateLocalPlans` callsites. **Keep** the `cleanupSpuriousMirrorPlans` callsite at line 2318 (it still performs non-`sess_` cleanup).

**1a.** Line ~2276 — remove:
```ts
const removed = await db.cleanupDuplicateLocalPlans(workspaceId);
```
Also remove the surrounding `if (removed > 0) { ... }` console.log block (lines 2276–2279).

**1b.** Line ~2318 — **KEEP** this callsite. `cleanupSpuriousMirrorPlans` is retained (with only its `sess_%` block removed in Step 3a). Do NOT remove this call.

**1c.** Lines ~13188–13208 — remove the entire deferred cleanup timer block inside `_incrementallyRegisterPlan`:
```ts
// Remove this entire block:
if (this._postRegistrationCleanupTimer) {
    clearTimeout(this._postRegistrationCleanupTimer);
}
this._postRegistrationCleanupTimer = setTimeout(async () => {
    this._postRegistrationCleanupTimer = undefined;
    try {
        const db = await this._getKanbanDb(workspaceRoot);
        const wsId = await this._getWorkspaceIdForRoot(workspaceRoot);
        if (db && wsId) {
            const removed = await db.cleanupDuplicateLocalPlans(wsId);
            if (removed > 0) {
                console.log(`[TaskViewerProvider] Post-registration cleanup removed ${removed} duplicate plan row(s)`);
            }
        }
        await this._refreshRunSheets(workspaceRoot);
    } catch (e) {
        console.error('[TaskViewerProvider] Post-registration cleanup failed:', e);
    }
}, 1500);
```

**1d.** Remove the `_postRegistrationCleanupTimer` field declaration (line 284):
```ts
private _postRegistrationCleanupTimer: NodeJS.Timeout | undefined;      // deferred duplicate-row cleanup after watcher-triggered registrations
```

**1e.** Remove the `_postRegistrationCleanupTimer` cleanup in the `dispose()` method (lines 17894–17897):
```ts
// Remove these lines from dispose():
if (this._postRegistrationCleanupTimer) {
    clearTimeout(this._postRegistrationCleanupTimer);
    this._postRegistrationCleanupTimer = undefined;
}
```

### Step 2 — Delete the `cleanupDuplicateLocalPlans` Method from KanbanDatabase

File: `src/services/KanbanDatabase.ts`

Delete the `cleanupDuplicateLocalPlans` method entirely (lines 3599–3658). It is solely `sess_%`-focused and has a latent V20 bug (line 3647: `DELETE FROM plan_events WHERE session_id = ?` — `plan_events` uses `plan_id` after V20, so this statement throws silently). No longer needed since no new `sess_` rows are created after the UUID fix.

### Step 3 — Trim the `sess_%` Block from `cleanupSpuriousMirrorPlans`

File: `src/services/KanbanDatabase.ts`

This method (lines 3437–3591) does FOUR things. Remove ONLY the first (`sess_%` block, lines 3437–3493). Keep the other three cleanup paths:

- **REMOVE** (lines 3437–3493): The `sess_%`-prefixed spurious mirror plan cleanup (the `dupStmt` query, the `for (const planFile of dupFiles)` loop, and the `countStmt`/`DELETE` block). This is the block that queries for `session_id LIKE 'sess_%'` and deletes spurious mirror rows.
- **KEEP** (lines 3496–3523): Brain-source plans with empty `plan_file` cleanup.
- **KEEP** (lines 3525–3556): Malformed `plan_file` path cleanup.
- **KEEP** (lines 3559–3585): Malformed `mirror_path` cleanup.
- **KEEP** (lines 3587–3591): The `_persist()` call and `return removed` at the end.

> **Important:** After removing the `sess_%` block, the `removed` variable initialization (`let removed = 0;` at line 3462) and the final `if (removed > 0) { await this._persist(); } return removed;` block (lines 3587–3591) must remain. The `dupFiles` array and its population loop (lines 3441–3460) should be removed along with the `sess_%` block since they only serve that block.

### Step 4 — Add One-Time DB Migration (V38) to Purge Existing `sess_` Rows

File: `src/services/KanbanDatabase.ts`

Add a new migration step after the V37 block (line 4808). The version number is **V38** (V37 is the latest verified migration at lines 4805–4808; confirmed no V36/V37 SQL array constants exist — they use dedicated `_runMigrationV36()` and `_runMigrationV37()` methods).

```sql
-- Delete orphaned sess_ rows from plans.
-- These were created by the now-removed sess_${Date.now()} fallback generator.
-- Canonical rows use UUIDs, antigravity_* IDs, or plain hashes — never sess_*.
DELETE FROM plans WHERE session_id LIKE 'sess_%';

-- Clean up orphaned events for deleted sess_ rows.
-- IMPORTANT: plan_events uses plan_id (NOT session_id) after V20 migration.
-- The plan_id was set to the same value as session_id when these rows were created,
-- so we filter on plan_id LIKE 'sess_%'.
DELETE FROM plan_events WHERE plan_id LIKE 'sess_%';

-- Clean up orphaned activity_log entries for deleted sess_ rows.
-- activity_log still has session_id (unchanged by any migration).
DELETE FROM activity_log WHERE session_id LIKE 'sess_%';
```

> **Critical:** `plan_events` had its `session_id` column replaced with `plan_id` in V20 (lines 395–419 of `KanbanDatabase.ts`). The migration must use `plan_id LIKE 'sess_%'` for `plan_events`, not `session_id LIKE 'sess_%'`. The `activity_log` table still has `session_id` (no migration altered it).

> **Implementation note:** Follow the existing migration pattern — either add a `MIGRATION_V38_SQL` constant array and a `v38 < 38` check block (like V35 at lines 4778–4797), or add a dedicated `_runMigrationV38()` method (like V36/V37). Wrap in a transaction with rollback on error. Stamp version 38 on success.

### Step 5 — Update the Test File

File: `src/test/local-plan-duplicate-regression.test.js`

This test file tests `cleanupDuplicateLocalPlans` (line 92) and references the dedup call pattern (line 121). Since the method is being deleted:

- Remove or rewrite the test to verify that duplicate `sess_` rows are no longer created (i.e., test the fix, not the band-aid).
- The test should create a plan file, trigger plan creation twice, and verify that only one DB row exists with a UUID `plan_id` (not two rows with `sess_` IDs).
- Remove the regex assertion at line 121 that checks for `cleanupDuplicateLocalPlans` in the provider source.
- Keep the `_planCreationInFlight` guard assertions (lines 104–118) — those guards remain in the code.

---

## Verification Plan

### Automated Tests
- Update `src/test/local-plan-duplicate-regression.test.js` to test the new behavior (no duplicate rows created)
- Run existing test suite to verify no regressions from the dedup helper removal

### Manual Verification
- Verify `grep -r "cleanupDuplicateLocalPlans" src/` returns zero hits in non-test source code
- Verify `cleanupSpuriousMirrorPlans` still exists and still performs empty-plan_file, malformed-path, and malformed-mirror cleanup
- Verify the V38 migration uses `plan_id LIKE 'sess_%'` for `plan_events` (not `session_id`)
- **Manually test the V38 migration** against a real DB containing `sess_` rows before shipping
- Verify existing plans with real UUIDs are unaffected by the V38 migration
- Extension compiles with `tsc --noEmit` with zero errors

---

## Order of Execution

1. Step 1 (remove `cleanupDuplicateLocalPlans` calls from TaskViewerProvider, remove timer field + dispose block)
2. Step 2 (delete `cleanupDuplicateLocalPlans` method from KanbanDatabase)
3. Step 3 (trim `cleanupSpuriousMirrorPlans` `sess_%` block)
4. Step 4 (add V38 migration)
5. Step 5 (update test)

## Completion Criteria

- `grep -r "cleanupDuplicateLocalPlans" src/` returns zero hits in non-test source code
- `cleanupSpuriousMirrorPlans` still exists with its non-`sess_%` cleanup paths intact
- The V38 migration successfully purges existing `sess_` rows from the database
- The V38 migration uses `plan_id LIKE 'sess_%'` for `plan_events` (not `session_id`)
- Extension compiles with `tsc --noEmit` with zero errors

## Recommendation

**Complexity: 5 → Send to Coder.** The dedup removal is mechanical, but `cleanupSpuriousMirrorPlans` requires surgical partial removal and the V38 migration SQL needs a column-name correction for `plan_events`. Both are well-scoped and documented above. The migration should be manually tested against a real DB before shipping.
