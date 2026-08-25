# Relocating kanban.db repoints the board at an empty database and leaves the plans behind

## Goal

Make moving the database somewhere else actually move the data. Today every relocation path — custom path,
the three cloud presets, and switching back to local — can repoint the board at an empty file while the
plans stay in the old one, with no error shown. This is a prerequisite for offering the user a DB location
choice at all: a choice that silently discards the board is worse than no choice.

### Problem analysis (verified against HEAD 58c0030)

**1. `migrateIfNeeded` refuses every target outside the source workspace, by construction.**

`KanbanDatabase.migrateIfNeeded(sourcePath, targetPath)` guards the copy with the shared location guard,
and derives the arguments by path arithmetic that assumes the target is always `<root>/.switchboard/x.db`:

```ts
const targetDir = path.dirname(targetPath);            // .../Switchboard
const switchboardParent = path.dirname(targetDir);     // .../  ← treated as "the workspace root"
const sourceDir = path.dirname(sourcePath);
const sourceWorkspaceRoot = path.dirname(sourceDir);
if (!isAllowedSwitchboardLocation(switchboardParent, sourceWorkspaceRoot)) { return { skipped: 'invalid_target_location' }; }
```

`isAllowedSwitchboardLocation` (`src/utils/switchboardLocationGuard.ts`) ends in
`return resolvedCandidate === resolvedWorkspaceRoot`. Tier 1 (the mapping index) is empty unless the
extension built it; tier 2 needs the candidate to own a control plane — `hasOwnControlPlane` tests for
`<dir>/.switchboard/kanban.db` or `<dir>/.switchboard/db-pointer`, which a Dropbox or iCloud folder does
not have. So for a target outside the source workspace the fallback compares two different directories,
returns false, and the migration is skipped as `invalid_target_location`.

Worked example, the Dropbox preset: target `~/Dropbox/Switchboard/kanban.db` → `switchboardParent` is
`~/Dropbox`, `sourceWorkspaceRoot` is the repo. `~/Dropbox !== <repo>` → blocked. The guard is doing its
job (it exists to stop stray `.switchboard/` directories); the caller is feeding it a "workspace root"
that was never a workspace root.

**2. Every caller swallows that skip reason and repoints anyway.**

`handleSetCustomDbPath` (`TaskViewerProvider.ts:13612`) and `handleSetPresetDbPath` (`:13656`) branch on
exactly two outcomes — `skipped === 'target_has_data'` (prompt, offer reconciliation) and
`migrated === true` (success toast) — then fall through unconditionally to
`config.update('kanban.dbPath', newPath, …)` (`:13649`, `:13798`) and `invalidateWorkspace`. Every other
skip value (`invalid_target_location`, `source_not_found`, `migration_in_progress`) takes the same silent
success path. `handleSetLocalDb` (`:13573`) has the same shape moving the other way.

Net effect for a user who picks a cloud preset: a success notification, a board that now reads an empty
database, and their plans still sitting in `<repo>/.switchboard/kanban.db`. The old file is not deleted, so
the data is recoverable — but nothing tells them that, and the board they are looking at is empty.

**3. On the standalone host the relocation cannot persist at all.**

All three handlers persist the choice with `vscode.workspace.getConfiguration('switchboard').update(...)`.
The standalone shim's `Configuration.update` is a deliberate no-op (`vscodeShim.ts:218` onward). So over
`npx`, the relocation runs, possibly copies the file, and then forgets where it put it — next boot resolves
the default path again. (This is the failure already filed as
`feature_plan_20260811150200_cloud_db_preset_silently_aborts_on_standalone_host.md`; it is restated here
because the fix below removes its cause rather than patching the symptom.)

**4. The backup suffix does not match the project's own doctrine.**

On a successful migration the source is renamed to `<source>.backup.<epoch-ms>`. The house rule for
superseded state is `*.migrated.bak`. Minor, but this is the file a user goes looking for when a move goes
wrong, so it should be named the way every other legacy artifact in the project is named.

**What is *not* wrong.** The primitives are sound and worth building on: `dbFileHasPlans` (`:1574`) and
`countPlansInFile` (`:1599`) for the collision check, `reconcileDatabases` (`:1625`) for the
both-have-data case, `validatePath` (`:1452`), `writeDbPointer` / `readDbPointer` (`:1195`, `:1210`), and
`invalidateWorkspace` for the re-open. The bug is the guard call and the callers' handling of its result,
not the design.

## Proposed changes

1. **Stop inferring a workspace root from the target path.** Give `migrateIfNeeded` the real workspace root
   as an explicit argument, and apply the location guard to the *source* workspace (where a stray
   `.switchboard/` would actually be a problem) rather than to the target's grandparent. A deliberate
   relocation to an arbitrary absolute path is the feature, not the threat — `validatePath` already covers
   the target being writable and sane.
2. **Make every non-success outcome visible.** Return a discriminated result and have all three callers
   handle it exhaustively: migrate → repoint; `target_has_data` → existing reconciliation prompt (keep);
   `source_empty` / `source_not_found` → repoint silently, there is nothing to lose; anything else → do
   **not** repoint, and say what failed. A relocation that cannot move the data must not change where the
   board reads from.
3. **Persist through a host-neutral carrier.** Write the location as `.switchboard/db-pointer` (a plain
   file write, already first in the resolution order at `:1210`) instead of, or in addition to, the
   `kanban.dbPath` workspace setting. This is what makes relocation work on the standalone host at all,
   and it removes the shim-`update`-is-a-no-op failure rather than special-casing it.
   - Must fix alongside: `readDbPointer` returns null when the pointed-at file does not yet exist
     (`:1218`). That is right for a stale pointer and wrong for a freshly chosen location. Distinguish the
     two — create the target, then point at it — or the pointer silently falls back to the default.
4. **Align the backup suffix** to `*.migrated.bak`, and log the absolute path of the backup at the point of
   the rename so it appears in `logs/server.log` for a standalone user.

## Verification plan

1. **The reported failure, as a test.** Source DB with N plans in a repo, target an absolute path outside
   it. Assert today: `skipped === 'invalid_target_location'` and the setting updated anyway. Assert after:
   the target holds N plans, the source is renamed to `*.migrated.bak`, and the board reads the new file.
2. **Refusal is honest.** Point at an unwritable target. Assert the board still reads the old database and
   the failure is surfaced — no success toast.
3. **Both-have-data.** Plans in both files. Assert the reconciliation prompt still appears and that
   declining leaves both files untouched.
4. **Standalone round-trip.** Over `npx`, relocate via the setup verb, restart the server, and assert the
   board still reads the relocated file. Today the setting write is a no-op and the restart reverts.
5. **Pointer freshness.** Write a `db-pointer` at a path that does not exist yet; assert the chosen
   location is honoured rather than silently falling back to `<root>/.switchboard/kanban.db`.
6. **Guard not weakened.** Assert `.switchboard/` creation is still refused in `$HOME` and in a mapped
   child workspace — the cases the guard exists for — with the new call shape.

## Out of scope

- Changing the default location or asking the user where the DB should live — that is
  `db-location-chosen-at-install.md`, which depends on this plan landing first.
- The cloud-preset folder-creation UX (the Google Drive / iCloud "create this folder first" dance). Left
  as-is.

## Metadata
- **Tags:** database, bugfix, reliability, ux
- **Complexity:** 5
