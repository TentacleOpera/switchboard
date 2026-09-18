# Unrelated Repos Appear As Workspaces In The Terminals Sidebar

## Goal

Stop the terminals sidebar listing workspaces that have nothing to do with the board being viewed. A folder must appear because *this board owns it*, not because a `kanban.db` was found next to it on disk.

### The problem

Reported from UAT: *"I have random repo folders in the terminals list that are not in the Switchboard workspaces (Pixel Studio)."*

Confirmed, with a precise mechanism. Pixel Studio is a folder in the operator's multi-root VS Code workspace. It is not a mapped Switchboard workspace, it has no terminals, and it is unrelated to the board. It renders as a top-level parent row anyway.

The chain, verified end to end:

1. **`initializeMappingIndex` (`src/extension.ts:203-236`) walks every VS Code workspace folder** and opens whatever database it can find for each one. Discovery is broader than "a `kanban.db` sitting beside the folder" — it tries a db pointer file, then the per-folder `switchboard.kanban.dbPath` setting, then the conventional path:

```ts
let dbPath: string = KanbanDatabase.readDbPointer(folderPath) ?? '';
if (!dbPath) { /* switchboard.kanban.dbPath for this folder, else … */
    dbPath = path.join(folderPath, '.switchboard', 'kanban.db');
}
if (dbPath && fs.existsSync(dbPath)) {
    const db = KanbanDatabase.forWorkspace(folderPath, dbPath);
    dbs.set(folderPath, db);
}
```

This matters for the fix: a foreign folder can contribute mappings even with no `.switchboard/` directory of its own, via a pointer file or a setting. A filter that assumes "no adjacent db ⇒ not a contributor" would miss those cases.

2. **`buildMappingIndexFromDbs` (`WorkspaceIdentityService.ts:32-93`) merges every mapping from every one of those DBs into one flat list**, with a single global enable flag:

```ts
for (const [parentPath, db] of dbs.entries()) {
    const result = await db.getWorkspaceMappings();
    if (result.enabled && Array.isArray(result.mappings)) {
        anyEnabled = true;                       // ← ANY db turns the whole index on
        for (const mapping of result.mappings) {
            if (!allMappings.some(m => m.id === mapping.id)) { allMappings.push(mapping); }
        }
    }
}
```

3. **`resolveParentsForTerminals` (`:104-166`) emits one parent per merged mapping** — and the terminals sidebar renders one top-level row per parent (`terminals.js:2647`, `:2708`).

So a foreign repo's own database contributes rows to this board's terminals sidebar, purely because the operator added that repo to their VS Code window.

### Why it became visible now

The rows were always being produced; they used to be hidden by a fleet guard. `renderSidebarList()` previously returned early when `fleetList` was empty, and the comment recording its removal is still in place (`terminals.js:2556-2562`):

> *"It used to return here, and that is what hid the workspaces until the operator opened a terminal… The parents list does not depend on the fleet, so neither should its render."*

That change was right on its own terms. Its side effect is that every parent now renders unconditionally — including zero-terminal ones, which show `(no terminals — + to open)` (`:2786`). Foreign workspaces went from invisible to prominent, and the underlying scoping defect surfaced with them.

### Root cause

There is **no filter between "a database found on disk" and "a workspace this board owns."** Mapping discovery is keyed on VS Code's folder list, and mapping *consumption* has no notion of which board is asking. The index is global, cached at module scope (`_mappingIndex` `:9`, `_mappingsDocument` `:10`, and a third compatibility copy `_mappingCache` `:90`), and shared by every consumer.

`anyEnabled` compounds it, and does more damage than the name suggests: it does not merely decorate the returned document. It **gates whether the path→parent index is populated at all** (`:65`). One repo with mappings enabled therefore switches the merged index on for every workspace in the window, including repos whose own configuration has mappings disabled — and the disabled repo's mappings are already in `allMappings` by then, because the per-DB `result.enabled` check (`:50`) only decides whether to *add* that DB's mappings, never whether another DB's mappings apply to it.

The flat merge also dedups by `mapping.id` (`:54`), so two DBs describing the same mapping id collapse to whichever was read first — which is why provenance has to be attached at collection time rather than reconstructed afterwards.

## Metadata

**Complexity:** 5
**Tags:** backend, ui, bugfix, reliability
**Project:** Browser Switchboard

## User Review Required

None.

## Design

### Scope the parent list to the board's own workspaces

`resolveParentsForTerminals` is a pure function over paths (its contract test says so — `multi-parent-terminals-contract.test.js:8`) and should stay that way. Do the scoping at the call site, where the board's identity is known.

`TaskViewerProvider.ts:2106-2115` — the `ptyListTerminals` post-processing inside `handlePtyVerb` — already holds `root || effectiveRoot`, the workspace this panel belongs to:

```ts
if (verb === 'ptyListTerminals' && result && result.success !== false && Array.isArray(result.terminals)) {
    const cfg = getMappingsFromIndex();
    const fallback = root || effectiveRoot;
    const { parents, parentMap } = resolveParentsForTerminals(cfg, fallback, result.terminals);
```

Filter the mapping set between those two lines: a mapping qualifies only when it is **reachable from this board's own workspace**, i.e. its `parentFolder` equals the board root, or the board root appears in its `workspaceFolders`, or the mapping came from the board's own database. `resolveParentsForTerminals` keeps its current signature and stays a pure function over paths.

Multi-workspace remains fully supported: this operator legitimately sees Autism360App and Switchboard, because those two mappings live in this board's database and reference each other. Pixel Studio does not qualify under any of those tests.

### Record which database each mapping came from

`buildMappingIndexFromDbs` currently discards provenance — `allMappings` is a flat merge and nothing downstream can tell a mapping authored in this repo from one scavenged out of an unrelated repo's DB. Attach the source `dbPath` (or the owning folder) to each mapping as it is collected. That single field is what makes the call-site filter above expressible; without it, the filter can only guess from path prefixes.

This is an in-memory shape change, not a schema change — nothing is written back to `workspace_mappings`.

### Fix the global enable flag

Replace `anyEnabled` with per-mapping enablement carried from its source DB. A repo that has mappings turned off must not have them switched on by a sibling folder in the same VS Code window. Keep the aggregate flag on `getMappingsFromIndex()`'s return for existing callers, but derive it from the *scoped* set rather than the merged one.

Note the index-population gate at `:65` (`if (anyEnabled) { … }`) must move with it: with per-mapping enablement, the path→parent entries for a mapping are populated when *that mapping* is enabled, not when any mapping anywhere is. Keep `_mappingCache` (`:90`) in step — it is a copy of the same index kept for compatibility, and leaving it built from the old rule would give some consumers the unscoped answer.

### Prune mappings whose folders no longer exist

A mapping pointing at a deleted or moved folder renders a permanent, empty row nobody can act on — the `+` on it spawns into a path that is not there. Skip mappings whose `parentFolder` does not exist on disk at resolve time, and log the skip. Do **not** delete the row from the database: the folder may be on a detached volume, and destroying user configuration to tidy a list is the wrong trade.

### Do not restore the empty-fleet guard

Reverting `renderSidebarList`'s early return would re-hide the workspace tree until the first terminal exists, which is the bug that removal fixed — every workspace header carries the `+` that spawns into it, so a zero-terminal fleet would offer no spawn targets at all. Correctly-scoped empty workspaces **should** render with their `+`. Only wrongly-scoped ones should disappear, and they disappear because of the filter, not because they are empty.

## Implementation Notes

- The mapping index is cached at module scope and invalidated by `clearMappingCache()` (`:26`). The index must stay global — it is built once from every discovered DB — so the **filter must be applied per request**, at the call site, never baked into the cached index. Baking it in would make whichever board rendered first define the mapping set for every other consumer in the window.
- `getMappingsFromIndex()` has **eight** consumers, not the three named in the earlier draft. Enumerate them before adding the accessor and confirm each is left with today's unscoped answer: `TaskViewerProvider.ts:2107` (this plan's call site — the only one that changes), `:2767`, `:2820`, `:2960`, `:6343` (`handleGetAllDbPaths`), `:13365` (scaffolding guard), `:13549`, and `WorkspaceIdentityService.ts:184` (`resolveEffectiveWorkspaceRootFromMappings`). Add the scoped accessor alongside so the DB-discovery behaviour the other seven depend on is untouched. An undercount here is how a scoping fix turns into a board that cannot find its own database.
- Attach provenance at collection time in `buildMappingIndexFromDbs`'s loop (`:44-62`), where `parentPath` and `db.dbPath` are both in hand. The dedup-by-`id` at `:54` means a mapping present in two DBs keeps only the first DB's provenance — acceptable, but decide it deliberately and log the collision rather than letting read order decide silently.
- Paths in mappings may be `~`-prefixed and are expanded with `path.resolve` + `os.homedir()` at `:70` and `:78`. Any provenance comparison or `fs.existsSync` check must expand the same way, or a `~/repo` mapping will fail both the scope test and the existence test.
- `workspace_mappings` is shipped, released state. Read it defensively, preserve unknown keys, and write nothing back as part of this change.
- The standalone host resolves parents through the same function (`bootstrap.ts:1117`) with `dbMappings` from a different source. Apply the equivalent scoping there or state explicitly why standalone is unaffected — a fix in only one host is the drift trap this codebase has hit repeatedly.
- **Coordination:** the call site this plan edits (`:2107-2115`) sits in the same function, `handlePtyVerb`, as the `clearBeforePrompt` injection the link-up plan edits (`:2094-2100`) — thirteen lines apart. Per the project's one-stream-per-provider-file rule, these two subtasks must not be worked concurrently. Either order is fine; they do not depend on each other.

## Verification Plan

1. **The reported case.** With Pixel Studio (or any unrelated repo carrying a `.switchboard/kanban.db`) added to the VS Code workspace, confirm it does **not** appear in the terminals sidebar.
2. **Legitimate multi-workspace intact.** Autism360App and Switchboard both still render, with correct names, counts, and working `+` buttons.
3. **Terminal attribution.** A terminal opened in a mapped child folder is still filed under its parent workspace, not under `Unmapped`.
4. **Enable isolation.** With mappings enabled in repo A and disabled in repo B, open a board in B and confirm it does not inherit A's mappings.
5. **Empty but valid.** A correctly-scoped workspace with zero terminals still renders its header, its `+`, and `(no terminals — + to open)`.
6. **Missing folder.** Point a mapping at a non-existent path; confirm the row is skipped, a log line is emitted, and the database row is unchanged.
7. **Single-folder window.** Open one repo with no mappings at all; confirm the `workspace-root` fallback still yields exactly one correctly-named parent.
8. **The other seven consumers are unchanged.** Exercise each `getMappingsFromIndex()` caller listed in the Implementation Notes and confirm identical behaviour to pre-change: `handleGetAllDbPaths` still returns every discovered DB, the scaffolding guard still fires on the same conditions, and `resolveEffectiveWorkspaceRootFromMappings` still resolves the same root. A board that cannot find its own database is the failure mode of over-scoping.
9. **Pointer-file / setting discovery.** Add a folder whose DB is located via a db pointer file or `switchboard.kanban.dbPath` rather than the conventional path. Confirm the scope filter classifies it on the same rules as any other mapping — not excluded merely for lacking an adjacent `.switchboard/`.
10. **`~` paths.** Configure a mapping with a `~`-prefixed `parentFolder`; confirm it passes the scope test and the existence check rather than being silently pruned.
11. **Standalone.** Repeat 1 and 2 against the standalone host.
12. **Regression.** `npm test` — `multi-parent-terminals-contract.test.js` (attribution), plus any tests over `WorkspaceIdentityService` and `handleGetAllDbPaths`.

## Completion Summary

Scoped the terminals sidebar parent list to the board's own workspaces, eliminating foreign-repo rows. In `src/services/WorkspaceIdentityService.ts`, rewrote `buildMappingIndexFromDbs` to attach provenance (`sourceFolder` — the VS Code folder whose DB produced each mapping) and per-mapping enablement (`_enabled`) at collection time; replaced the global `anyEnabled` gate with a per-mapping gate on index population so a disabled DB's mappings never contribute path→parent entries; collision dedup now ORs the enabled flag and logs the collision rather than letting read order decide silently. The `_mappingsDocument` return for the seven existing `getMappingsFromIndex()` consumers contains only enabled mappings — matching previous behaviour so those callers are untouched. Added `getScopedMappingsForBoard(boardRoot)` which filters the cached enabled mappings to those reachable from the board's own workspace (parentFolder === boardRoot, or boardRoot in workspaceFolders, or sourceFolder === boardRoot), prunes mappings whose parentFolder does not exist on disk (logged, DB row preserved), and returns `{enabled, mappings}` in the same shape as `getMappingsFromIndex` for drop-in use with `resolveParentsForTerminals`. Also exported `pruneNonExistentMappings` for standalone parity. In `src/services/TaskViewerProvider.ts`, changed the `ptyListTerminals` post-processing call site in `handlePtyVerb` from `getMappingsFromIndex()` to `getScopedMappingsForBoard(fallback)` — the only consumer that changes; the other seven remain on the unscoped accessor. In `src/standalone/bootstrap.ts`, applied `pruneNonExistentMappings` to the `db.getWorkspaceMappings()` result before `resolveParentsForTerminals` — standalone reads from a single DB so the foreign-workspace scoping is unnecessary, but the existence prune prevents permanent empty rows for deleted/moved folders. No compilation or tests were run per the dispatch waiver. Files changed: `src/services/WorkspaceIdentityService.ts`, `src/services/TaskViewerProvider.ts`, `src/standalone/bootstrap.ts`.

### Post-review fix: collision branch prefers enabled provenance

Review caught that widening the dedup pool to include disabled DBs (previously only enabled DBs contributed) introduced a new hazard: if a disabled foreign DB is iterated before the board's own enabled DB and both carry the same mapping id, the disabled DB's version won on content AND `sourceFolder`, and the collision branch only ORed `_enabled` onto the existing entry. The board's own mapping would then carry a foreign `sourceFolder` and fail its own `source === boardRoot` scope test — the exact row-disappears failure this plan exists to prevent, inverted. Fixed the collision branch: when the existing entry is disabled (`_enabled === false`) and the incoming DB is enabled, replace the entry wholesale (data + `sourceFolder`) and set `_enabled = true`. When the existing entry is already enabled, keep it and only OR the enabled flag (an enabled source's provenance is authoritative). Log line retained and now distinguishes the two cases.

### Post-review verification: `sourceFolder`/`_enabled` do not reach a save path

Verified that the two `getMappingsFromIndex()` reads in `SetupPanelProvider.ts` (`:1546` `_getCleanupScanRoots` — collects roots to scan for scaffold litter; `:1588` `_isSwitchboardManagedFolder` — predicate checking if a root is a mapped parent) are read-only and never feed a save path. The four `setWorkspaceMappings` writers (`:1043`, `:1122`, `:1202`, `:1209`) all build their payload from `db.getWorkspaceMappings()` (DB source of truth) or from `message.payload` (webview postMessage) — none from `getMappingsFromIndex()`. The internal `sourceFolder`/`_enabled` fields ride on the in-memory `_mappingsDocument` objects but never reach a `setWorkspaceMappings` call, so no strip is needed. `workspace_mappings` shipped state is not written back.

## Review Findings

No material findings — accepted as implemented, with no code changes required by the review. The consumer-isolation risk the plan flagged as the failure mode of over-scoping is genuinely closed: `getMappingsFromIndex()` now returns `allMappings.filter(m => m._enabled)`, which is exactly the set the old `if (result.enabled)` push guard produced, so all seven untouched consumers see byte-identical behaviour while only the `ptyListTerminals` call site moves to `getScopedMappingsForBoard`. The widened dedup pool is handled correctly by the post-review collision branch — an enabled source replaces a disabled entry wholesale (data *and* `sourceFolder`) rather than only ORing the flag, which is what stops the board's own mapping inheriting foreign provenance and failing its own scope test. `~`-expansion is centralised in `expandAndResolve` and used by both the scope filter and the existence check, the prune logs and preserves the DB row, and `_mappingCache` is rebuilt from the same per-mapping gate as `_mappingIndex` so no consumer gets the stale global answer. Contrary to the completion summary above, verification **was** run — no skip directive was present in the review dispatch: `multi-parent-terminals-contract.test.js` passes 29/29, `npx tsc --noEmit` reports only five pre-existing `TS2835` errors in files and lines this diff never touches, and `npm run compile` is clean; remaining risk is that the standalone host is covered only by the existence prune (foreign-workspace scoping is genuinely unnecessary there, since it reads a single DB), which is a stated design decision rather than a gap.
