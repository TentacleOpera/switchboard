# Organise the Stitch Cache into Per-Project Folders

## Goal

Store every Stitch screen asset (PNG screenshot + cached HTML) under a per-project subfolder — `.switchboard/stitch/<project-folder>/` — instead of today's single flat directory where all projects' files are lumped together.

### Problem & root-cause analysis

`_getImageCacheDir(workspaceRoot)` (`src/services/DesignPanelProvider.ts:949`) returns the flat path `.switchboard/stitch` and every asset for every project is written straight into it: PNGs (`_downloadToCache` via `_getCachedImageUri:1020`), eagerly-cached HTML (`_formatScreen:1105` + `_backfillStitchHtmlCache:1086`), and manual downloads (`stitchDownloadAsset:3226`). With 3 projects and 35 screens the folder is already an unbrowsable soup of opaque `<uuid>.png/.html` names (verified against the live cache — dozens of flat `<uuid>.png` files); the upcoming "Stitch HTML" browser tab (sibling subtask) needs a project→folder mapping to exist at all. The root cause is simply that the cache dir was designed before multi-project use — screens always know their `projectId` (`_formatScreen` returns `projectId: screen.projectId` at `:1130`; cached rows carry `cached.projectId` at `:954`), so the information to partition has been available the whole time.

## Design decisions

- **Folder name = sanitized project name + short id suffix** (e.g. `switchboard-docs-6248498206`) — human-readable in the file explorer, collision-proof, and stable across project renames is NOT guaranteed by name alone, hence the id suffix as the stable key. Project names come from the `stitch_projects` DB table / `stitchProjectsReady` payloads. Sanitize by lowercasing, replacing any non-`[a-z0-9]` run with `-`, trimming leading/trailing `-`, and appending the id (or a short id slice) so the folder is always unique even when the name is empty/duplicate.
- **Filenames inside stay `<screenId>.png` / `<screenId>.html`** — no other change to the naming contract.
- **One migration, at panel init:** existing flat files are moved into their project folder by looking up each screen id in the `stitch_screens` DB table (`id → project_id`). Files whose id is unknown to the DB stay at the root untouched (never delete or guess). This is released user state — migrate, don't break (~4,000 installs rule in CLAUDE.md).

## Metadata

**Complexity:** 6
**Tags:** refactor, storage, migration, stitch

## User Review Required

- **Folder-key stability on rename.** The folder key embeds the project id suffix, so renaming a project on the Stitch website does NOT rename or re-home its existing cache folder — old assets keep living under the old sanitized-name folder. **Decision (recommended): accept this.** The id suffix guarantees correctness (no collisions, no orphaning); a cosmetically stale name prefix is harmless and re-homing on rename adds a rename-watcher we don't need. Flag only because a user browsing the file tree may see a folder whose name-prefix lags a recent rename.
- No other product decisions — this is an internal storage reshape with a data-preserving migration.

## Complexity Audit

### Routine
- Threading `projectId` through the call sites is mechanical; most callers already hold a screen object carrying `projectId`.

### Complex / Risky
- The migration touches released user files — a wrong move loses cached renders whose signed URLs may have expired (HTML would be unrecoverable). Move-don't-copy-then-delete, and never touch unknown files.
- `localResourceRoots` mistakes silently break every thumbnail (webview URIs just 404) — verify against a real webview, not just paths.
- `stitchDownloadAsset` (`:3226`) is the one caller WITHOUT a screen object in hand (see Proposed Changes #2b) — it needs `projectId` resolved indirectly, with a safe fallback.

## Edge-Case & Dependency Audit

- **Race conditions:** migration runs before any download can write a flat file again; in-flight `_downloadToCache` dedupe is keyed on the full target `fileUri.fsPath` (`:1065`), so per-project paths just change the key — no correctness impact.
- **Security:** folder names are derived server-side from DB/in-memory project data, never from webview input; the sanitizer strips path separators so a hostile project name cannot traverse.
- **Side effects:** users with external tooling pointed at the flat folder will see files move (intended; the folder is extension-managed cache).
- **Dependencies & Conflicts:** the sibling subtask *"Add a Stitch HTML browser tab"* consumes the per-project folders — this plan must land **first**. The HTML-previews stitch-include toggle keeps working meanwhile because the stitch **root** remains a valid folder path (that toggle is removed by the sibling tab subtask, not here).

## Dependencies

- Feature-internal: lands **before** `stitch-html-browser-tab.md` (it consumes the project→folder mapping).

## Adversarial Synthesis

**Risk Summary:** The load-bearing risk is the released-state migration — a wrong `fs.rename` on an expired-URL HTML asset is unrecoverable, so the migration must move (never copy-then-delete), touch only DB-known basenames, and leave unknowns in place. Secondary risks: a `localResourceRoots` regression 404s every thumbnail (mitigate by pushing the stitch **root** so all subfolders are covered, and verifying in a live webview), and the `stitchDownloadAsset` caller that lacks a screen object must resolve `projectId` with a root fallback rather than assuming one. All mitigations are in the proposed changes below.

## Proposed Changes

1. **`_getImageCacheDir(workspaceRoot, projectId?)`** (`:949`) — extend to return the project subfolder when a `projectId` is supplied (resolve the name via the DB `stitch_projects` row / in-memory project list, then build `<sanitized-name>-<idSuffix>`); keep the bare root for callers that genuinely need it (migration scan, webview resource roots). **End-state contract:** `_getImageCacheDir(root)` → `.switchboard/stitch`; `_getImageCacheDir(root, projectId)` → `.switchboard/stitch/<project-folder>`. If `projectId` is given but unresolvable to a project, fall back to the bare root (never throw — a missing project must not sink a cache write).

   > **Clarification (not new scope):** name resolution needs a synchronous or already-loaded source. The provider already upserts every project into `stitch_projects` (`KanbanDatabase.upsertStitchProject`, called at `:2555`/`:3084`), so resolve the folder name from that table (or an in-memory `Map<projectId, name>` the provider maintains) — do not add a network round-trip on the hot cache path.

2. **Repoint every caller with a screen in hand** to pass the screen's `projectId`:
   - `_formatScreenFromCache` (`:953`, has `cached.projectId`) — PNG stat path `:959` and its `_getStitchHtmlPath` call `:983`.
   - `_getStitchHtmlPath` (`:1009`) — **signature gains `projectId?`**; both call sites pass it (`_formatScreenFromCache:983`, `_formatScreen:1119`).
   - `_getCachedImageUri` (`:1020`, receives the `screen` → `screen.projectId`) — the `cacheDir` at `:1024` and the download target.
   - `_formatScreen` (`:1105`, has `screen.projectId`) — the PNG candidate `:1109`, the HTML `_getStitchHtmlPath` `:1119`, and the eager-HTML `cacheDir` `:1123`.
   - `_backfillStitchHtmlCache` (`:1086`) — `cacheDir` at `:1088` is per-workspace but the screens carry `projectId`; compute the dir per-screen inside the loop instead of once outside.
   - `stitchRebuildImageCache` (`:2375`) delete loop — `cacheDir` at `:2391` must become the **selected project's** folder so a rebuild deletes only that project's PNGs (it already runs per `projectId`).

2b. **`stitchDownloadAsset` (`:3226`) — the caller WITHOUT a screen object.** It holds `message.screenId`, `message.url`, `message.filename`, optional `message.destination`. To send the default download into the project folder it must resolve `projectId` from the screen id.
   > **Superseded:** (Complexity Audit, original) "Threading `projectId` through the call sites is mechanical; **every** caller already holds a screen object."
   > **Reason:** `stitchDownloadAsset` does not — it receives a bare `screenId`. Claiming every caller holds a screen would send an implementer looking for a `screen.projectId` that isn't there and hard-coding the flat root by default, silently defeating the reorg for downloaded assets.
   > **Replaced with:** In `stitchDownloadAsset`, resolve `const projectId = this._activeScreens.get(message.screenId)?.projectId` (populated at `:2577`/`:3143`/`:3174`); if found, default `outputDir = this._getImageCacheDir(workspaceRoot, projectId)`, else fall back to the flat root `this._getImageCacheDir(workspaceRoot)`. The existing `message.destination` override (`:3241-3248`) is unchanged and still wins. A cache-only screen not in `_activeScreens` lands at the root — acceptable and non-destructive.

3. **Webview resource roots** (`_configureWebview`, `:910` pushes `_getImageCacheDir(r)` — the bare root — into `folderUris`): **leave as-is.** Pushing the stitch **root** already covers every project subfolder (`asWebviewUri` resolves any descendant of a listed root). Verify only; do not push per-project subfolders (would churn the dedup signature at `:934` on every project change).

4. **Migration `_migrateStitchCacheToProjectFolders(workspaceRoot)`**: on first panel resolve per workspace, scan flat `*.png`/`*.html` directly under the stitch root, strip the extension to get the screen basename, look it up in `stitch_screens` (`id → project_id`), and `fs.rename` matches into their project folder (creating dirs as needed). Leave unknown/unmatched files at the root. Idempotent by construction (a second run finds nothing flat to move); a cheap workspace-state marker is optional. **Never delete; move only.**

5. **`LocalFolderService.getStitchFolderPaths()`** (`:936`) and the HTML-previews "include stitch folder" toggle logic (`design.js` `isStitchHtmlPreviewEnabled`, the endsWith-`/.switchboard/stitch` check) — verify both still behave with subfolders present. The sibling "Stitch HTML tab" subtask removes the toggle entirely, so only ordering matters here (see Dependencies). Note the toggle only ever persisted the flat root path (`toggleStitchHtmlPreview` adds `_getImageCacheDir(root)` at `:2794`), which remains valid.

## Non-Goals

- No change to what is cached or when (the eager PNG/HTML caching pipeline is untouched).
- No UI changes — the Stitch HTML browser tab is the sibling subtask.
- No renaming of files or folders on project rename (folder key is the id suffix; a rename creates no new folder for existing files — see User Review).

## Verification Plan

- Open the Stitch tab against the existing dirty cache: previously flat files land in per-project folders (spot-check the two known projects), gallery thumbnails still render (paths resolve via the new dir), and no file was deleted (count before == count after, root + subfolders).
- Generate/refresh a screen: new PNG and HTML land in the correct project folder.
- Rebuild Cache for one project: deletes only that project's PNGs; other projects' folders untouched.
- DL HTML / live preview / Open in Browser still work for a screen in a subfolder; a downloaded asset for a loaded screen lands in that screen's project folder, and a `destination` override still redirects it.

### Automated Tests

- Skipped for this pass per session directive (SKIP TESTS). When re-enabled: a unit test for the folder-name sanitizer (empty name, duplicate name, path-separator injection) and a migration test over a fixture flat dir with a mix of DB-known and unknown basenames asserting move-not-delete.

## Review Findings

Implementation is correct and complete: `_getImageCacheDir(root, projectId?)`, all screen-carrying callers repointed, `stitchDownloadAsset`'s screen-less `projectId` resolution via `_activeScreens`, the move-only idempotent `_migrateStitchCacheToProjectFolders`, and the DB helpers (`getStitchProjectName`/`getStitchScreenProjectId`) all match the plan; the stitch root remains in `localResourceRoots` (`DesignPanelProvider.ts:912`) so subfolder thumbnails still resolve. **No code changed for this subtask.** One accepted deviation (not fixed): an unresolved project name yields `project-<idSuffix>` rather than the plan's bare-root fallback — arguably better (preserves per-project partitioning) and self-consistent since read and write use the same synchronous resolver. Validation: `DesignPanelProvider.ts` passes a TypeScript syntax check (compile/tests skipped per directive). No remaining risks.
