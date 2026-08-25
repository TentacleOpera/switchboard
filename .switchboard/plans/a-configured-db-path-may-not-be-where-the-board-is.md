# A configured kanban.dbPath may not be where the board actually is, and the migrations assume it is

## Goal

Establish, before either storage migration runs, that the database a workspace *resolves to* is not
necessarily the database holding that workspace's plans. Relocation has been failing silently for an
unknown number of installs, leaving the board in the old in-repo file while the configured path points at
an empty or absent one. Both the N-to-1 merge and the preset retirement currently assume the configured
path is authoritative.

### Problem analysis (verified against HEAD 58c0030)

**Relocation to any target outside the source workspace is refused, and the callers repoint anyway.**

`KanbanDatabase.migrateIfNeeded(sourcePath, targetPath)` guards the copy by deriving a "workspace root"
from the target by path arithmetic — `path.dirname(path.dirname(targetPath))` — and passing it to
`isAllowedSwitchboardLocation` alongside a source root derived the same way. That guard's final fallback is
`resolvedCandidate === resolvedWorkspaceRoot` (`src/utils/switchboardLocationGuard.ts`), and its earlier
tiers do not apply: the mapping index is empty unless the extension built it, and `hasOwnControlPlane`
tests for `<dir>/.switchboard/kanban.db` or `<dir>/.switchboard/db-pointer`, which no cloud-sync folder
has. So for any target outside the source workspace the comparison is between two different directories,
and the result is `{ migrated: false, skipped: 'invalid_target_location' }`.

The arithmetic is not an accident — `permanent_fix_child_switchboard_pollution.md` introduced it
deliberately, recording the assumption in its own text: *"`sourcePath` is always of the form
`<workspaceRoot>/.switchboard/kanban.db`"*. True of the source. Never true of a Dropbox or iCloud target,
where `path.dirname(path.dirname(...))` yields `~/Dropbox`, not a workspace root.

Worked example. Preset `dropbox` builds `~/Dropbox/Switchboard/kanban.db`. The guard is asked whether
`~/Dropbox` may own a `.switchboard` directory *on behalf of the repo's workspace root*. It may not.
Migration skipped.

**Then the result is discarded.** `handleSetCustomDbPath` (`TaskViewerProvider.ts:13612`),
`handleSetPresetDbPath` (`:13656`) and `handleSetLocalDb` (`:13573`) each branch on exactly two outcomes —
`skipped === 'target_has_data'` and `migrated === true` — and fall through unconditionally to
`config.update('kanban.dbPath', newPath, …)` (`:13649`, `:13798`) plus `invalidateWorkspace`.
`invalid_target_location`, `source_not_found` and `migration_in_progress` all take the silent-success path,
complete with a confirmation notification.

**Resulting on-disk state, which is what the migrations will meet.** For an affected install:

- `switchboard.kanban.dbPath` points at a synced or custom path.
- That file is empty, or does not exist at all.
- The real board — every plan, column position, priority order, `plan_events` row, worktree row — is still
  at `<repo>/.switchboard/kanban.db`, untouched, because nothing ever deleted it.
- The user saw a success message and, if they looked, an empty board.

Nothing here is destroyed. The hazard is entirely in what a migration concludes about it.

### Why this blocks the two migrations

**`retire-cloud-file-sync-db-path-presets.md`** resolves to *"adopt the synced database into the global
store, archive the original as `kanban.db.migrated.bak` in place"*, and its integrity handling covers a
synced file that is partial, locked or corrupt. It does not cover the case where the synced file is
**valid and empty** while the board is somewhere else. Adopting it succeeds, verifies clean, and lands an
empty board in the global store — with the real one left behind looking like a superseded leftover.

**`single-global-database-in-home-store.md`** lists source discovery candidates as the mapping index,
`_instancesByDbPath`, recent workspaces, and a filesystem scan for `.switchboard/kanban.db`. The scan
would find the orphan, which is good — but discovery is framed per *workspace*, and if a workspace's
source is taken as "the DB this workspace resolves to", the empty configured file is what gets merged. If
both are found, the merge's newest-`updated_at` conflict rule can let the empty file's rows win for any
overlapping id, since a repointed-and-then-touched database can carry newer timestamps than the board it
shadowed.

### Proposed changes

This is deliberately small: establish the facts, then hand them to the plans that own the migrations.

1. **Measure it.** A read-only audit that, for each discoverable workspace, resolves the configured path
   and also probes `<root>/.switchboard/kanban.db`, then reports plan counts on both via the existing
   `countPlansInFile` (`KanbanDatabase.ts:1599`). Ship it as a diagnostic first — the population size is
   currently unknown, and it decides how much the two migrations need to care.
2. **Make source selection evidence-based, not configuration-based.** State the rule both migrations should
   adopt: for each workspace, consider *every* candidate file — configured path, legacy in-repo path, and
   any `db-pointer` target — and choose by content (plan count, then `max(updated_at)`), never by which
   one the setting names. When two candidates both hold plans, that is the existing reconciliation case,
   not a silent pick.
3. **Stop the silent repoint now.** Have the three handlers refuse to update the setting when the
   migration reported anything other than success or a benign empty source. This is worth doing even though
   the consolidation plan later deletes these handlers and the guard: until it lands, every relocation is
   a chance to create another orphan for the migration to trip over.
4. **Do not fix the guard.** `single-global-database-in-home-store.md` deletes
   `switchboardLocationGuard.ts`, `db-pointer` and the DB-resolution half of the mapping subsystem
   outright, and `retire-cloud-file-sync-db-path-presets.md:63` already notes that the sync-folder warning
   must not be built inside it. Repairing the arithmetic would be work thrown away — the correct scope here
   is refusing to act on its refusal, not making it permissive.

### Verification plan

1. **Reproduce the orphan.** Seed an in-repo DB with plans, relocate to an absolute path outside the
   workspace. Assert today: `invalid_target_location`, setting updated, board empty, plans still in the old
   file. This is the fixture every other test below uses.
2. **Audit reports it.** Run the diagnostic against that fixture; assert it names both files with their
   plan counts and flags the configured path as empty-but-configured.
3. **Refusal after the fix.** Same relocation; assert the setting is *not* updated and the board still
   reads the populated file.
4. **Evidence-based selection.** Hand the fixture to the merge-source chooser; assert it selects the
   populated in-repo file, not the configured empty one.
5. **Both populated.** Plans in both files; assert the reconciliation path is taken rather than either being
   silently preferred.
6. **No false positives.** A workspace with a legitimately relocated, populated DB and an absent in-repo
   file: assert the audit reports nothing anomalous and selection picks the configured path.

## Dependencies

- **Input to** `retire-cloud-file-sync-db-path-presets.md` and `single-global-database-in-home-store.md`.
  Neither depends on this shipping first, but both need its source-selection rule, and the preset plan's
  "adopt the synced database" step is unsafe without it. Steps 1 and 3 can ship immediately and
  independently; step 2 belongs to whichever migration lands first.

## Out of scope

- Repairing the location guard or the relocation UI — both are deleted by the consolidation programme.
- Any change to the storage engine, topology, or the global store itself.
- The standalone host's inability to persist a relocation at all (the shim's `Configuration.update` is a
  no-op, `vscodeShim.ts:218` onward). Already filed as
  `feature_plan_20260811150200_cloud_db_preset_silently_aborts_on_standalone_host.md`, and moot once paths
  stop being the interface — but it means standalone users cannot have created this orphan, which usefully
  bounds the affected population to extension hosts.

## Metadata
- **Tags:** database, bugfix, reliability
- **Complexity:** 3
