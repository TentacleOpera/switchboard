# A configured kanban.dbPath may not be where the board actually is, and the migrations assume it is

## Goal

Establish, before either storage migration runs, that the database a workspace *resolves to* is not
necessarily the database holding that workspace's plans. Relocation has been failing silently, leaving the
board in the old in-repo file while the configured path points at an empty or absent one. Both the N-to-1
merge and the preset retirement currently assume the configured path is authoritative.

> **Superseded — most of this plan's problem analysis describes a world the consolidation programme has demolished.**
> **Reason:** The storage consolidation (`single-global-database-in-home-store.md`) has shipped: `switchboardLocationGuard.ts` is deleted, `handleSetPresetDbPath` is removed, `migrateIfNeeded` is rewritten (no location guard, no `invalid_target_location` skip reason), and `db-pointer` is retired. The orphan-creation mechanism this plan was built around — "guard refuses relocation, caller repoints anyway, board left behind" — can no longer happen via `invalid_target_location` because that skip reason no longer exists.
> **Replaced with:** The remaining valid work is narrowed to the silent-repoint hazard in the two surviving relocation handlers (`handleSetCustomDbPath`, `handleSetLocalDb`), which still fall through to unconditional `config.update` when migration reports `migration_in_progress` or `error`. The diagnostic audit and source-selection rule (steps 1-2) are likely moot given the consolidation has shipped — verify before discarding.

### Problem analysis (re-verified against HEAD ead33f59)

> **Superseded:** `KanbanDatabase.migrateIfNeeded` guards the copy by deriving a "workspace root" from the target by path arithmetic and passing it to `isAllowedSwitchboardLocation`. For any target outside the source workspace the result is `{ migrated: false, skipped: 'invalid_target_location' }`.
> **Reason:** The location guard (`switchboardLocationGuard.ts`) has been deleted. `migrateIfNeeded` (`KanbanDatabase.ts:2177-2218`) now copies the source to any target without a location check. The `invalid_target_location` skip reason no longer exists.
> **Replaced with:** `migrateIfNeeded` now has these skip reasons: `same_path` (:2182), `migration_in_progress` (:2185), `source_not_found` (:2190), `source_empty` (:2194), `target_has_data` (:2200), and `error: <message>` (:2214). On success it copies source to target and renames source to `.backup.<timestamp>` (:2207-2208).

> **Superseded:** Three handlers (`handleSetCustomDbPath`, `handleSetPresetDbPath`, `handleSetLocalDb`) each branch on `target_has_data` and `migrated` and fall through unconditionally to `config.update`.
> **Reason:** `handleSetPresetDbPath` has been removed (only referenced in `workspace-identity-precedence.test.ts:223` as a historical needle). Two handlers survive: `handleSetCustomDbPath` (`TaskViewerProvider.ts:14721`) and `handleSetLocalDb` (`:14681`).
> **Replaced with:** Both surviving handlers still have the silent-repoint pattern. `handleSetCustomDbPath` falls through to `config.update` at `:14769` regardless of skip reason. `handleSetLocalDb` falls through to config clear at `:14714` regardless of skip reason. The remaining skip reasons that fall through silently are `migration_in_progress` (migration didn't run) and `error: <message>` (migration threw, data may be partial). `source_not_found` and `source_empty` falling through is correct — there is nothing to migrate. `same_path` falling through is harmless.

**Resulting on-disk state (remaining hazard).** For an affected install where migration reports `migration_in_progress` or `error`:

- `switchboard.kanban.dbPath` (or `storage.pathOverride`) points at the target path.
- That file may not exist (error before copy) or may be partial (error during copy).
- The real board is still at the source path, renamed to `.backup.<timestamp>` only on success — so a failed migration leaves the source untouched but the config repointed.
- The user saw a success notification (the `migrated` branch shows one; the fall-through doesn't show an error).

Nothing here is destroyed. The hazard is that the board reads from an empty or absent target while the real data sits at the source.

### Why this blocks the two migrations (partially superseded)

> **Superseded:** `retire-cloud-file-sync-db-path-presets.md` resolves to "adopt the synced database into the global store" and its integrity handling covers a synced file that is partial, locked or corrupt. It does not cover the case where the synced file is valid and empty while the board is somewhere else.
> **Reason:** The consolidation programme has shipped. The preset retirement and the N-to-1 merge appear to have run (the guard is deleted, `db-pointer` is retired, `handleSetPresetDbPath` is removed, a `globalStore` module exists). The specific hazard this section describes — adopting an empty synced file while the real board sits elsewhere — may already be moot if the consolidation migrations used evidence-based source selection.
> **Replaced with:** Verify whether the consolidation migrations have already run with the configured path as authoritative. If they have, this section is historical context. If they haven't (e.g. the migration is lazy, triggered on next boot per workspace), the source-selection rule is still relevant.

## User Review Required

None.

## Complexity Audit

### Routine

- Adding skip-reason checks to two handler functions (`handleSetCustomDbPath`, `handleSetLocalDb`) — refuse `config.update` when `migResult.skipped === 'migration_in_progress'` or `migResult.skipped?.startsWith('error:')`.
- Showing an error notification instead of a success notification when migration failed.

### Complex / Risky

- **Determining whether the consolidation migrations have already run.** If they have, the diagnostic audit and source-selection rule (steps 1-2) are moot. If they haven't (lazy per-workspace migration), the source-selection rule is still needed. This needs verification against the `globalStore` module and the consolidation migration's trigger mechanism.
- **The `source_not_found` and `source_empty` cases.** These fall through to `config.update` today, and that is correct — there is nothing to migrate. The fix must not over-correct by refusing these.

## Edge-Case & Dependency Audit

**Race Conditions:** `migration_in_progress` is itself a race — two concurrent migrations. The fix refuses the config update, which is correct: the caller should retry, not repoint.

**Security:** No security surface — this is config-update gating.

**Side Effects:** Refusing the config update on `error` means the user sees an error and the board stays on the old path. That is the intended behaviour — the old path still has the data.

**Dependencies & Conflicts:** The consolidation programme (`single-global-database-in-home-store.md`, `retire-cloud-file-sync-db-path-presets.md`) has largely shipped. This plan's steps 1-2 (diagnostic audit, source-selection rule) may be moot. Step 3 (stop the silent repoint) is independent and still valid. Step 4 (do not fix the guard) is moot — the guard is deleted.

## Dependencies

- **Was input to** `retire-cloud-file-sync-db-path-presets.md` and `single-global-database-in-home-store.md`. Both appear to have shipped (guard deleted, `db-pointer` retired, `handleSetPresetDbPath` removed, `globalStore` module exists). The source-selection rule may have been adopted during consolidation — verify before discarding steps 1-2.

## Adversarial Synthesis

Key risks: (1) The plan's primary concern (the `invalid_target_location` orphan) is gone — the guard is deleted, `migrateIfNeeded` now copies to any target. (2) The remaining silent-repoint hazard is narrow: `migration_in_progress` and `error` in two surviving handlers. (3) Over-correcting by refusing `source_not_found` or `source_empty` would break legitimate relocations where the old DB doesn't exist or is empty. (4) The diagnostic audit and source-selection rule may be moot if the consolidation has shipped. Mitigations: narrow the fix to `migration_in_progress` and `error` only; verify consolidation state before discarding steps 1-2; the two-handler fix is independently shippable regardless.

## Proposed changes

1. **LIKELY MOOT — Measure it.** A read-only audit that resolves the configured path and probes `<root>/.switchboard/kanban.db`, reporting plan counts on both. **Verify whether the consolidation has already run before investing here** — if the global store is the single source of truth, the configured-vs-in-repo divergence may no longer exist.

2. **LIKELY MOOT — Evidence-based source selection.** State the rule both migrations should adopt: consider every candidate file and choose by content. **Verify whether the consolidation migrations already adopted this** — if they shipped with the configured path as authoritative and no orphan reports came in, the rule may have been unnecessary.

3. **Stop the silent repoint — STILL VALID.** In `handleSetCustomDbPath` (`TaskViewerProvider.ts:14721`) and `handleSetLocalDb` (`:14681`), refuse to update the config when `migResult.skipped === 'migration_in_progress'` or `migResult.skipped?.startsWith('error:')`. Show an error notification instead. Do NOT refuse `source_not_found` or `source_empty` — those are legitimate "nothing to migrate" cases.

4. **MOOT — Do not fix the guard.** The guard is already deleted. No action needed.

## Verification plan

### Automated Tests

1. **Reproduce the remaining hazard.** Trigger a relocation where `migrateIfNeeded` returns `migration_in_progress` (set `_migrationInProgress = true` via a concurrent call). Assert today: config is updated, board reads from the target which has no data. After the fix: config is NOT updated, error notification shown.
2. **Error case.** Trigger a relocation where `migrateIfNeeded` returns `error: <message>` (e.g. unwritable target). Assert the config is NOT updated after the fix.
3. **Legitimate cases still work.** `source_not_found` and `source_empty` still fall through to `config.update` — the relocation succeeds because there is nothing to migrate.
4. **Successful migration.** `migrated: true` still shows the success notification and updates the config.
5. **`target_has_data` still offers reconciliation.** The existing branch is unchanged.

### Goal Invariants

- `handleSetCustomDbPath` does NOT call `config.update` when `migResult.skipped === 'migration_in_progress'`.
- `handleSetCustomDbPath` does NOT call `config.update` when `migResult.skipped` starts with `error:`.
- `handleSetLocalDb` does NOT call `config.update` when `migResult.skipped === 'migration_in_progress'`.
- `handleSetLocalDb` does NOT call `config.update` when `migResult.skipped` starts with `error:`.
- `handleSetCustomDbPath` DOES call `config.update` when `migResult.skipped === 'source_not_found'` (legitimate relocation).
- `handleSetCustomDbPath` DOES call `config.update` when `migResult.migrated === true` (successful migration).

## Out of scope

- Repairing the location guard or the relocation UI — both are deleted by the consolidation programme (which has shipped).
- Any change to the storage engine, topology, or the global store itself.
- The standalone host's inability to persist a relocation at all (the shim's `Configuration.update` is a
  no-op). Already filed and moot once paths stop being the interface — but it means standalone users cannot
  have created this orphan, which bounds the affected population to extension hosts.

## Metadata
- **Tags:** database, bugfix, reliability
- **Complexity:** 3
