# Workspace-Root Resolution on the Write Paths

**Complexity:** 6

## Goal

Make every write path resolve a workspace root the same way the read paths already do, and make the failures loud instead of misreported. Plan-card Save resolves a relative plan path against the panel's raw ambient root, misses the file entirely, and reports the miss as a concurrent-edit conflict that surfaces as Unknown error. The import endpoint accepts any string at all: a working directory differing only in case inserted 1537 duplicate rows into a live board and answered success with a count of zero. Both also return success to HTTP callers on every failure branch, in breach of PRD contract 4, so the one signal that would have made either mistake visible within seconds says nothing.

## How the Subtasks Achieve This

- **Fix Plan-Card Save Rejecting Every Plan That Lives Under A Mapped Parent Root**: adds a shared save-target resolver that mirrors the proven preview resolver byte for byte — so Save can never write a different file than Preview just rendered — widens the allow-check from open folders to the allowed-roots set with a path-separator boundary, keys the rename-on-save DB update against the *effective* root, stops reporting a missing file as a conflict, and converts the arm's six exits to returns so HTTP callers stop seeing false success.
- **`POST /kanban/plans/import` Duplicates the Entire Board From One Mis-Cased Root**: adds one shared root guard applied to **both** write doors — the import endpoint and the create-plan endpoint, which reads the root identically and calls the same importer — matching by device and inode on POSIX and by case-folded native realpath on Windows, and replaces the all-or-nothing zero count with honest written and persisted fields, which also un-breaks integration sync, currently skipped entirely for every row a partial import actually wrote.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [`POST /kanban/plans/import` Duplicates the Entire Board From One Mis-Cased Root, and Reports That Nothing Happened](../plans/feature_plan_20260814153000_import-endpoint-root-guard-and-honest-count.md) — **PLAN REVIEWED**
- [ ] [Fix Plan-Card Save Rejecting Every Plan That Lives Under A Mapped Parent Root](../plans/feature_plan_20260814161300_plan-card-save-rejects-mapped-parent-root.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

- No hard ordering constraints. The two touch different providers (`PlanningPanelProvider.ts` versus `LocalApiServer.ts` plus `PlanFileImporter.ts`) and can execute in parallel.
- **Shared trap, both subtasks:** `_resolveWorkspaceRoot` is the wrong validator on either path. It never returns undefined, so used as a gate it silently converts a hostile or stale root into some *other* real root. Both plans require a strict membership test instead.
- **The import guard's valid-root set must be built from the unfiltered roots plus the mapping workspace folders, not from the server's `_allRoots`.** That filter exists to keep mapped children out of a display list, not to define who may import; using it would reject nine legitimate roots on this machine and break plan creation for all of them. Test a mapped child before landing.
- The Save subtask needs its `verb-returns:check` baseline re-derived with `--write` in the same change. Planning sits at exactly 152 of 152, so any added `break` turns CI red, and hand-editing the ceiling is the documented way this has gone red before.
- The import subtask records two follow-ups it deliberately does not fix — the fail-open branch in the path normalizer, and the un-canonicalised instance-cache key in `forWorkspace`. Both are small, both are the durable fix, and neither is in scope here.

