# Workspace-Root Resolution on the Write Paths

**Complexity:** 6

## Goal

Make every write path resolve a workspace root the same way the read paths already do, and make the failures loud instead of misreported. Plan-card Save resolves a relative plan path against the panel's raw ambient root, misses the file entirely, and reports the miss as a concurrent-edit conflict that surfaces as Unknown error. The import endpoint accepts any string at all: a working directory differing only in case inserted 1537 duplicate rows into a live board and answered success with a count of zero. Both also return success to HTTP callers on every failure branch, in breach of PRD contract 4, so the one signal that would have made either mistake visible within seconds says nothing.

## How the Subtasks Achieve This

- **Fix Plan-Card Save Rejecting Every Plan That Lives Under A Mapped Parent Root**: adds a shared save-target resolver that mirrors the proven preview resolver byte for byte — so Save can never write a different file than Preview just rendered — widens the allow-check from open folders to the allowed-roots set with a path-separator boundary, keys the rename-on-save DB update against the *effective* root, stops reporting a missing file as a conflict, and converts the arm's six exits to returns so HTTP callers stop seeing false success.
- **`POST /kanban/plans/import` Duplicates the Entire Board From One Mis-Cased Root**: adds one shared root guard applied to **both** write doors — the import endpoint and the create-plan endpoint, which reads the root identically and calls the same importer — matching by device and inode on POSIX and by case-folded native realpath on Windows, and replaces the all-or-nothing zero count with honest written and persisted fields, which also un-breaks integration sync, currently skipped entirely for every row a partial import actually wrote.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [`POST /kanban/plans/import` Duplicates the Entire Board From One Mis-Cased Root, and Reports That Nothing Happened](../plans/feature_plan_20260814153000_import-endpoint-root-guard-and-honest-count.md) — **CODE REVIEWED** — ID: 4acb5f84-e4e0-41dc-9235-6c025fe5ba81
- [ ] [Fix Plan-Card Save Rejecting Every Plan That Lives Under A Mapped Parent Root](../plans/feature_plan_20260814161300_plan-card-save-rejects-mapped-parent-root.md) — **CODE REVIEWED** — ID: 5abfd8f4-3148-4ece-8616-5eafd10ccf19
<!-- END SUBTASKS -->

## Dependencies & sequencing

- No hard ordering constraints. The two touch different providers (`PlanningPanelProvider.ts` versus `LocalApiServer.ts` plus `PlanFileImporter.ts`) and can execute in parallel.
- **Shared trap, both subtasks:** `_resolveWorkspaceRoot` is the wrong validator on either path. It never returns undefined, so used as a gate it silently converts a hostile or stale root into some *other* real root. Both plans require a strict membership test instead.
- **The import guard's valid-root set must be built from the unfiltered roots plus the mapping workspace folders, not from the server's `_allRoots`.** That filter exists to keep mapped children out of a display list, not to define who may import; using it would reject nine legitimate roots on this machine and break plan creation for all of them. Test a mapped child before landing.
- The Save subtask needs its `verb-returns:check` baseline re-derived with `--write` in the same change. Planning sits at exactly 152 of 152, so any added `break` turns CI red, and hand-editing the ceiling is the documented way this has gone red before.
- The import subtask records two follow-ups it deliberately does not fix — the fail-open branch in the path normalizer, and the un-canonicalised instance-cache key in `forWorkspace`. Both are small, both are the durable fix, and neither is in scope here.


## Review Findings

Reviewed both subtasks against the implementation in `c0140527` plus HEAD. Files changed by this review: `src/services/PlanFileImporter.ts` (the `!ready` branch reported `persisted: true` — the one zero-count branch that is a real failure, now `false`), `src/test/verb-engine-planning-headless.test.js` (+6 `saveFileContent` cases), new `src/test/workspace-root-write-path-contract.test.js` (+11 cases), `package.json` and `.github/workflows/integration-tests.yml` (CI wiring for the new suite — the implementation landed zero tests for a security-relevant write-path guard). Validation: `catalog:check`, `parity:check`, `push-routing:check`, `standalone-parity:check`, `host-seam-parity:check`, `verb-returns:check` (Planning 143/143), `compile-tests`, `test:contract:verb-engine-planning` (32/32), `test:contract:verb-engine-kanban` (19/19), `test:contract:workspace-mappings` (18/18) and the new suite (11/11) all green. Two gates were already red at HEAD and are untouched by this work: `mirror:check` (orphan `.claude/skills/switchboard-remote/SKILL.md` with no `.agents/` source) and `test:contract:verb-engine` (TaskViewerProvider's constructor reaches `vscode.workspace`). The feature goal is met — the save path now mirrors the preview resolver exactly, both API write doors share one identity-based root guard, and every failure branch on both paths returns a typed body instead of a blanket ack.

## Deferred Findings

- MAJOR — Save and Preview can now select different files. `_resolveSaveTarget` tries the caller-supplied root first, but `fetchKanbanPlanPreview` never receives one, so when two allowed roots both hold the same relative plan path the user can be shown one file and write the other. The save side is the more correct of the two (it uses the root `_getKanbanPlans` stamped); the fix is to thread the same root into the read path, which both plans scoped out. `src/services/PlanningPanelProvider.ts:4923`
- NIT — The `LocalFolderService` fallback allow-check still uses a bare `startsWith` with no `path.sep` boundary, so a configured docs folder `…/notes` also authorises `…/notes-private/…`. Explicitly left unchanged by the Save plan, but it is now reached through a wider root set. `src/services/PlanningPanelProvider.ts:4944`
- NIT — `_resolveKnownRoot` re-runs `fs.statSync(given)` once per known root instead of hoisting it out of the loop. `src/services/LocalApiServer.ts:6807`
- NIT — The import response ships the same file list twice (`written` and `planFiles` are the same array). On this board that is ~1857 paths duplicated per response. `src/services/PlanFileImporter.ts:166`
- MAJOR (pre-existing, not this work) — `src/services/__tests__/PlanFileImporter.noStateSection.test.ts` is red on `db.getWorkspaceMappings is not a function`: the stub was never updated after that call was added to the importer in June 2026. It, `duplicate-switchboard-state-regression.test.js` and `custom-lane-roundtrip-regression.test.js` are all result-shape consumers of `importPlanFiles` and none of the three is invoked by CI. `src/services/PlanFileImporter.ts:61`
- NIT (historical) — Commit `c0140527` deleted the `const body = await this._parseJsonBody(req)` binding from `_handleImportPlans` while still dereferencing `body?.workspaceRoot`; the handler could not compile. Repaired three commits later in `80d5f933`. HEAD is correct. `src/services/LocalApiServer.ts:7212`
