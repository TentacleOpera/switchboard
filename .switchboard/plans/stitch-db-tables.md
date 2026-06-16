# Stitch Projects and Screens DB Tables

## Goal

Replace the `stitch.manifest` JSON blob in the `config` table with two proper first-class tables: `stitch_projects` and `stitch_screens`. Each screen gets its own row, indexed by project ID, so queries are targeted and no full blob read/write is needed.

**Core problem / root cause:** `DesignPanelProvider.ts` currently serialises *all* Stitch project + screen metadata into a single `config.key = 'stitch.manifest'` JSON value (read via `db.getConfigJson` at `DesignPanelProvider.ts:652`, written via `db.setConfigJson` at `:661`). This was temporary scaffolding. Every screen status change rewrites the entire blob, there is no index, and the shape is inconsistent with every other entity in the DB (plans, worktrees) which all use dedicated tables. This plan promotes the blob to relational tables and, while there, fixes a latent image-cache recovery bug and an over-eager projects-API call.

## Metadata
**Tags:** database, refactor, ui
**Complexity:** 6

> **Note on tags:** `stitch` is not in the allowed tag vocabulary and has been dropped. Allowed-list tags used: `database` (new tables + migration), `refactor` (blob → relational), `ui` (two new webview buttons).

## User Review Required
- Confirm that existing `stitch.manifest` blobs in deployed DBs can be silently dropped (no migration of blob data into rows needed — screens will re-populate from the API on next panel open).
- Confirm that a "Refresh Projects" button should be added to the Stitch controls strip so users can explicitly re-fetch the project list from the API (e.g. after creating a project outside of Switchboard). Without this, new projects created externally will never appear.
- Confirm the "Rebuild Image Cache" button placement (controls strip next to Refresh Projects, or a separate settings/overflow menu).
- **NEW — confirm behaviour change:** Today `stitchListProjects` fires the projects API on *every* panel open (cache-then-refresh; see `DesignPanelProvider.ts:1295-1308`). This plan changes it to cache-*or*-refresh: no API call when DB rows exist, API call only on first use or explicit Refresh. Confirm that a stale project list between Refresh clicks is acceptable (it is the whole point of the "Refresh Projects" button).

## Context

Currently `DesignPanelProvider.ts` stores all Stitch project and screen metadata as a single JSON blob under `config.key = 'stitch.manifest'` via `db.getConfigJson` / `setConfigJson`. This was temporary scaffolding and has the following problems:

- Entire blob read/written on every project load, even if only one screen changes
- No indexing — finding screens for a project requires deserialising the whole manifest
- Inconsistent with every other entity in the DB (plans, worktrees, projects) which all have dedicated tables
- Will not scale as more projects and screens accumulate

### Verified codebase facts (as of this review)

- **Migration versions V30 and V31 are already taken.** V30 recreates the `worktrees` table (`KanbanDatabase.ts:4329`), V31 changes `worktrees.epic_id` to TEXT (`KanbanDatabase.ts:4412`). The latest `MIGRATION_V*_SQL` constant is `MIGRATION_V29_SQL` (`KanbanDatabase.ts:465`), but the version *gates* run through 31. **The new migration is therefore V32, not V30.**
- The migration-version API is `await this.getMigrationVersion()` / `await this.setMigrationVersion(n)` — there is **no** `_setMigrationVersion`. See the V26–V31 blocks (`KanbanDatabase.ts:4289`–`4463`).
- **sql.js is in-memory.** A bare `this._db.run(...)` mutates RAM only; durability requires `this._persist()`. The canonical write helper is `private async _persistedUpdate(sql, params)` (`KanbanDatabase.ts:4818`), which does `ensureReady()` → `run` → `_persist()`. Every existing write accessor routes through it or calls `_persist()` directly. The draft accessor snippet (plain `INSERT ... ON CONFLICT`) **would lose all writes on reload** and must be corrected.
- Read accessors use the sql.js cursor idiom: `const stmt = this._db.prepare(sql, params)` → `while (stmt.step()) { stmt.getAsObject() }` → `stmt.free()`, after `await this.ensureReady()`.
- `PRAGMA foreign_keys` is **never** set ON anywhere in `KanbanDatabase.ts`. sql.js defaults FK enforcement OFF, so the `FOREIGN KEY` clause on `stitch_screens` is documentation-only (consistent with `worktrees.epic_id REFERENCES plans(id)`). A screen row can be inserted before its parent project row exists — no runtime error today, but see Edge-Case audit.
- `stitch.manifest` is referenced in exactly two places, both in `DesignPanelProvider.ts` (`:652`, `:661`). No other consumer.
- `_getManifestPath` **does not exist** in the codebase (Phase 4's "remove it if it exists" is already satisfied — nothing to do). `_getStitchOutputDir` and `_getImageCacheDir` are unrelated filesystem helpers and must stay.
- `stitchOpenManifest` (`DesignPanelProvider.ts:1416`) opens a `DESIGN.md` handoff file — it is **not** related to the `stitch.manifest` config blob. Do not touch it.
- `getConfigJson` / `setConfigJson` are generic config helpers. After this change only the manifest used them, but **do not delete the helpers** — remove only the manifest call sites.

## Complexity Audit

### Routine
- Adding a `MIGRATION_V32_SQL` constant alongside the existing V2–V29 constants.
- Two `CREATE TABLE` + one `CREATE INDEX` — same shape as prior migrations.
- Two new webview buttons wired to `postMessage` — identical pattern to the existing `btn-new-stitch-project` / `btn-open-design-md` buttons.
- Read/upsert accessors follow the established `prepare/step/free` + `_persistedUpdate` idioms.

### Complex / Risky
- **Migration version sequencing** — must be V32; getting this wrong silently no-ops the migration (version already ≥ the chosen number) or collides with worktrees logic.
- **Behaviour change to `stitchListProjects`** — moving from always-refresh to cache-gated refresh changes a user-visible network/data-freshness contract and touches 4+ webview call sites.
- **Deleted-PNG recovery redesign** — the draft's mechanism does not fire on cold panel open (timing of `_activeScreens` population vs the cache read) and the Phase-3 re-fetch filter excludes the very rows that need recovery. Requires a corrected filter, not just a signature change.
- **Data-consistency / persistence** — every write must `_persist()`; multi-row screen upserts should batch in one transaction to avoid N disk writes per project load.
- **Irreversible data drop** — the migration deletes the manifest blob; gated on User Review confirmation.

## Edge-Case & Dependency Audit

**Race Conditions**
- `stitchGetProjectScreens` serves cache (Phase 1) then fetches API (Phase 2) and upserts. Two rapid project-switch clicks can interleave upserts for different `projectId`s — safe because rows are keyed by screen `id` and scoped by `project_id`, but the per-screen `Promise.all` upsert loop should run inside a single `BEGIN/COMMIT` so a mid-loop reload doesn't observe a half-written set.
- `_downloadToCache` runs in the background (fire-and-forget at `:734`). If a screen row is upserted but the PNG download is still in flight, a concurrent cache read sees the row with no PNG → must be treated as a cache miss (see PNG-recovery fix), not a permanent "not ready".

**Security**
- No new external input surface. Screen/project IDs come from the Stitch SDK. The Rebuild-Cache handler deletes files under `{workspaceRoot}/.switchboard/stitch/` — **must** restrict deletion to PNG filenames derived from `stitch_screens WHERE project_id = ?` (via `path.basename(id)`), never a glob nuke, to avoid deleting unrelated files if a screen `id` ever contained path separators. Reuse the existing `path.basename(screen.id)` sanitisation already used at `:669` / `:721`.

**Side Effects**
- Migration `DELETE FROM config WHERE key = 'stitch.manifest'` is irreversible. Acceptable per User Review (screens re-populate from API).
- `device_type` / `status` / `status_msg` columns are declared `NOT NULL DEFAULT ''`, but the SDK shape and the old `StitchManifestScreen` interface use `string | null` (`DesignPanelProvider.ts:34-41`). The upsert accessor **must coalesce null → ''** before binding, or the insert binds NULL into a NOT NULL column. Reads then return `''` (not `null`); confirm the webview tolerates `''` for `deviceType`/`status` (it currently renders falsy values fine).

**Dependencies & Conflicts**
- FK `stitch_screens.project_id → stitch_projects.id` is **not enforced** (no `PRAGMA foreign_keys=ON`). Screens may be upserted before the parent project row exists (e.g. when a `defaultProjectId` is selected without a prior `stitchListProjects` API call). This is fine today, but if FK enforcement is ever turned on, screen upserts would fail. Mitigation: either (a) keep the FK as documentation-only and note the dependency, or (b) `upsertStitchProject` a stub row for the active project before the first screen upsert. Recommend (a) for parity with `worktrees`.
- No conflict with in-flight migrations beyond version numbering. Confirm no other open plan is also claiming V32.

## Dependencies
- `sess_XXXXXXXXXXXXX — confirm no concurrent migration claims V32` (verify against any other open DB-schema plan before merging)

## Adversarial Synthesis

**Key risks:** (1) The draft's migration is numbered V30, but V30 and V31 already exist — shipping as-is silently no-ops the migration and the tables are never created. (2) The accessor snippet never calls `_persist()`, so on sql.js every write evaporates on reload. (3) The deleted-PNG recovery cannot fire on a cold panel open because `_activeScreens` is populated *after* the cache read, and the Phase-3 re-fetch filter excludes cached rows entirely. **Mitigations:** renumber to V32 and use `getMigrationVersion`/`setMigrationVersion` with a `BEGIN/COMMIT` wrapper; route all writes through `_persistedUpdate`/`_persist`; fix recovery by changing the Phase-3 filter to re-format any screen whose PNG is missing (`!cachedWithImage.has(id)`) using the now-populated SDK object, rather than relying on a parameter that isn't available yet. Complexity is realistically 6, not 3.

## Proposed Changes

### `src/services/KanbanDatabase.ts`

**Context:** Add the new tables as migration **V32** (V30/V31 are taken — see Context). Add four persisted accessors.

**Logic — migration constant.** Add after `MIGRATION_V29_SQL` (`:470`):

```typescript
// V32: promote stitch.manifest blob to first-class tables
const MIGRATION_V32_SQL = [
    `CREATE TABLE IF NOT EXISTS stitch_projects (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL DEFAULT '',
        update_time TEXT NOT NULL DEFAULT '',
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS stitch_screens (
        id           TEXT PRIMARY KEY,
        project_id   TEXT NOT NULL,
        name         TEXT NOT NULL DEFAULT '',
        device_type  TEXT NOT NULL DEFAULT '',
        status       TEXT NOT NULL DEFAULT '',
        status_msg   TEXT NOT NULL DEFAULT '',
        updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (project_id) REFERENCES stitch_projects(id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_stitch_screens_project ON stitch_screens(project_id)`,
    `DELETE FROM config WHERE key = 'stitch.manifest'`,
];
```

> **⚠️ Correction from draft.** The original draft named this `MIGRATION_V30_SQL`. V30 (worktrees recreate, `:4329`) and V31 (`epic_id` → TEXT, `:4412`) already exist, so the draft's V30 would have silently no-opped (`getMigrationVersion()` already returns ≥31). Renamed to **V32**. The `DELETE FROM config` from the draft's Phase 4 is folded into this migration so the blob drop is atomic with table creation.

**Logic — wire V32 into `_runMigrations()`.** Append after the V31 block (`:4463`), matching the V30/V31 transactional idiom (the draft's `currentVersion < 30` + `this._setMigrationVersion(30)` + `duplicate column` catch is wrong on all three counts — wrong name, wrong number, wrong error-handling style for CREATE TABLE):

```typescript
// V32: promote stitch.manifest blob to stitch_projects / stitch_screens tables
const v32 = await this.getMigrationVersion();
if (v32 < 32) {
    try {
        this._db.exec('BEGIN');
        for (const sql of MIGRATION_V32_SQL) {
            this._db.exec(sql);
        }
        this._db.exec('COMMIT');
        await this.setMigrationVersion(32);
        console.log('[KanbanDatabase] V32 migration completed: stitch_projects / stitch_screens tables created, manifest blob dropped');
    } catch (e) {
        try { this._db.exec('ROLLBACK'); } catch { /* ignore */ }
        console.error('[KanbanDatabase] V32 migration FAILED — rolled back. DB unchanged. Error:', e);
    }
}
```

**Implementation — accessors.** Add four public methods. **All writes go through `_persistedUpdate` or a `BEGIN/COMMIT` + `_persist()`** (the draft omitted persistence — fatal on sql.js):

```typescript
// ── Stitch projects ──
public async upsertStitchProject(id: string, name: string, updateTime: string): Promise<boolean> {
    return this._persistedUpdate(
        `INSERT INTO stitch_projects (id, name, update_time, updated_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            update_time = excluded.update_time,
            updated_at = datetime('now')`,
        [id, name ?? '', updateTime ?? '']
    );
}

public async getStitchProjects(): Promise<Array<{ id: string; name: string; updateTime: string }>> {
    if (!(await this.ensureReady()) || !this._db) return [];
    const out: Array<{ id: string; name: string; updateTime: string }> = [];
    const stmt = this._db.prepare('SELECT id, name, update_time FROM stitch_projects ORDER BY update_time DESC');
    try {
        while (stmt.step()) {
            const r = stmt.getAsObject();
            out.push({ id: String(r.id), name: String(r.name ?? ''), updateTime: String(r.update_time ?? '') });
        }
    } finally {
        stmt.free();
    }
    return out;
}

// ── Stitch screens ──
public async upsertStitchScreen(screen: {
    id: string; projectId: string; name: string;
    deviceType: string | null; status: string | null; statusMessage: string | null;
}): Promise<boolean> {
    // Coalesce null → '' — columns are NOT NULL DEFAULT ''
    return this._persistedUpdate(
        `INSERT INTO stitch_screens (id, project_id, name, device_type, status, status_msg, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
            project_id = excluded.project_id,
            name = excluded.name,
            device_type = excluded.device_type,
            status = excluded.status,
            status_msg = excluded.status_msg,
            updated_at = datetime('now')`,
        [screen.id, screen.projectId, screen.name ?? '', screen.deviceType ?? '', screen.status ?? '', screen.statusMessage ?? '']
    );
}

public async getStitchScreensForProject(projectId: string): Promise<Array<{
    id: string; projectId: string; name: string;
    deviceType: string; status: string; statusMessage: string;
}>> {
    if (!(await this.ensureReady()) || !this._db) return [];
    const out: Array<{ id: string; projectId: string; name: string; deviceType: string; status: string; statusMessage: string }> = [];
    const stmt = this._db.prepare('SELECT id, project_id, name, device_type, status, status_msg FROM stitch_screens WHERE project_id = ?', [projectId]);
    try {
        while (stmt.step()) {
            const r = stmt.getAsObject();
            out.push({
                id: String(r.id),
                projectId: String(r.project_id),
                name: String(r.name ?? ''),
                deviceType: String(r.device_type ?? ''),
                status: String(r.status ?? ''),
                statusMessage: String(r.status_msg ?? ''),
            });
        }
    } finally {
        stmt.free();
    }
    return out;
}
```

> **Clarification (perf, strictly implied by "no full blob read/write"):** When upserting a full screen list for a project in `stitchGetProjectScreens`, prefer a single `BEGIN/COMMIT` around the loop with one trailing `_persist()` over N independent `_persistedUpdate` calls (N disk writes). A `bulkUpsertStitchScreens(screens[])` helper that wraps the loop in one transaction is the clean form. This is an optimisation of the stated goal, not new scope.

**Edge cases:** null device/status coalesced to ''; reads return [] when DB not ready; FK is non-enforced (parent project row not required).

### `src/services/DesignPanelProvider.ts`

**Context:** Replace the manifest blob helpers with direct table accessors; fix the projects-API gating and the deleted-PNG recovery.

**Logic — remove blob helpers and interfaces.**
- Delete `_readManifest` (`:648`) and `_writeManifest` (`:658`).
- Remove the `StitchManifest` (`:43`) and `StitchManifestScreen` (`:34`) interfaces. The DB accessor return types are the canonical shape. **Caveat:** `_formatScreenFromCache` (`:667`) and the upsert loop (`:1348`) currently type against `StitchManifestScreen` — switch them to the `getStitchScreensForProject` element type.

**Logic — `stitchListProjects` (corrected behaviour; replaces `:1275`–`:1312`):**

1. Read `getStitchProjects()`. If rows exist **and** `message.forceRefresh` is not set → `postMessage('stitchProjectsReady', …)` and **return** (no API call).
2. Only call `stitch.projects()` when the DB has no rows (first-ever use) **or** `message.forceRefresh === true` (the new "Refresh Projects" button).
3. After any API call, `upsertStitchProject()` each result, then `postMessage('stitchProjectsReady', …)`.

> **⚠️ Correction from draft.** The draft says "read DB → if rows exist, stop" but the *current* code always fires the API in the background (`:1295`). Distinguishing "panel open" (no API) from "Refresh clicked" (API) requires a `forceRefresh` flag on the inbound message. The existing auto-load call sites (`design.js:163`, `:2474`, `:2523`, `:3209`) must **not** set it; only the new Refresh button sets `forceRefresh: true`.

This means a user who opens the panel 50 times makes exactly 1 projects API call (the first time, when the DB is empty), not 50.

**Logic — `stitchGetProjectScreens` (replaces `:1314`–`:1379`):**

1. Phase 1 — `getStitchScreensForProject(projectId)`; `postMessage('stitchScreensReady', …)` immediately. Track `cachedIds` and `cachedWithImage` (screens served *with* a non-empty `imageUrl`) exactly as today (`:1320-1332`).
2. Phase 2 — `stitch.project(projectId).screens()`; populate `_activeScreens`; bulk-upsert via `upsertStitchScreen` (one transaction).
3. Phase 3 — **corrected re-fetch filter.** Re-format with `_formatScreen` (live SDK object → re-downloads image) every screen that is either genuinely new (`!cachedIds.has(s.id)`) **or** cached-without-image (`!cachedWithImage.has(s.id)`). Send each via `stitchScreenReady`. Screens already served *with* an image are not re-fetched.

> **⚠️ Correction from draft — deleted-PNG recovery.** The draft adds an `sdkScreen?` param to `_formatScreenFromCache` for PNG recovery, but during the Phase-1 cache serve (`:1327`) `_activeScreens` is empty — it is populated in Phase 2 (`:1340`), *after* the read. So `sdkScreen` would be `undefined` on cold open and recovery never fires. Worse, the current Phase-3 filter `!cachedIds.has(s.id)` *excludes* cached rows, so a cached row with a deleted PNG is never re-formatted at all. The fix is in the **Phase-3 filter** (include `!cachedWithImage.has(s.id)`), reusing the already-existing `cachedWithImage` set and the now-populated `_activeScreens` SDK object via the existing `_formatScreen` path. `_formatScreenFromCache` keeps its current 2-arg signature; no `sdkScreen` param is needed.

**Implementation — `stitchRebuildImageCache` handler (new `case`):**

1. Inbound `{ projectId, workspaceRoot }`.
2. `getStitchScreensForProject(projectId)` → build PNG path list as `path.join(_getImageCacheDir(workspaceRoot), path.basename(id) + '.png')` (reuse the `path.basename` sanitisation at `:669`/`:721`). Delete only those files. **Never** glob-delete the directory.
3. For each screen with a live `_activeScreens` entry, `_formatScreen(...)` (re-downloads via background `_downloadToCache`). For screens not in `_activeScreens`, fetch via `stitch.project(projectId).getScreen(id)` first.
4. `postMessage('stitchScreensReady', …)` with the refreshed list. DB rows untouched.

**Edge cases:** screen `id` with separators neutralised by `path.basename`; missing PNG during rebuild is a no-op delete; background download failures are logged (existing `:735`).

**Phase 4 cleanup notes:** `_getManifestPath` **does not exist** — nothing to remove (draft instruction already satisfied). `getConfigJson`/`setConfigJson` stay (generic helpers). `stitchOpenManifest` (`:1416`, opens `DESIGN.md`) is unrelated — do not touch.

### `src/webview/design.html`

**Context:** Two new buttons in the Stitch controls strip (`#controls-strip-stitch`, `:3711`), beside the existing `+ New Project` / `Download Design Tokens` / `Open DESIGN.md` buttons (`:3716`–`:3718`).

**Implementation:** add after `:3716`:

```html
<button id="btn-refresh-stitch-projects" class="strip-btn" title="Re-fetch the project list from the Stitch API (e.g. after creating a project outside Switchboard)">Refresh Projects</button>
<button id="btn-rebuild-stitch-cache" class="strip-btn" disabled title="Delete and re-download all cached preview images for the selected project">Rebuild Cache</button>
```

(`Rebuild Cache` starts `disabled`, enabled when a project is selected — mirror the `btn-download-palette`/`btn-open-design-md` enable logic.)

### `src/webview/design.js`

**Context:** Wire both buttons; mirror the `btnNewStitchProject` listener pattern (`:2061`).

**Implementation:**

```javascript
const btnRefreshStitchProjects = document.getElementById('btn-refresh-stitch-projects');
if (btnRefreshStitchProjects) {
    btnRefreshStitchProjects.addEventListener('click', () => {
        if (state.stitchBusy) return;
        vscode.postMessage({ type: 'stitchListProjects', forceRefresh: true, workspaceRoot: state.stitchWorkspaceRoot });
    });
}

const btnRebuildStitchCache = document.getElementById('btn-rebuild-stitch-cache');
if (btnRebuildStitchCache) {
    btnRebuildStitchCache.addEventListener('click', () => {
        const projectId = stitchProjectSelect ? stitchProjectSelect.value : '';
        if (!projectId || state.stitchBusy) return;
        vscode.postMessage({ type: 'stitchRebuildImageCache', projectId, workspaceRoot: state.stitchWorkspaceRoot });
    });
}
```

**Edge cases:** The existing auto-load `stitchListProjects` posts (`:163`, `:2474`, `:2523`, `:3209`) must remain **without** `forceRefresh` so panel open never hits the API once the DB is seeded.

## Files Changed

- `src/services/KanbanDatabase.ts` — **V32** migration (was mislabelled V30 in draft), 4 new persisted accessor methods (+ optional `bulkUpsertStitchScreens`)
- `src/services/DesignPanelProvider.ts` — replace manifest blob helpers with DB calls, remove `StitchManifest` / `StitchManifestScreen` interfaces, gate `stitchListProjects` on `forceRefresh`, fix Phase-3 re-fetch filter for PNG recovery, add `stitchRebuildImageCache` handler
- `src/webview/design.html` — "Refresh Projects" and "Rebuild Cache" buttons in `#controls-strip-stitch`
- `src/webview/design.js` — wire both buttons; keep auto-load posts free of `forceRefresh`

## Verification Plan

> Per session directives: **skip compilation** and **skip automated test execution** (the user runs the suite separately). The cases below define *what* to assert; the user executes them.

### Automated Tests
- **Migration:** On a DB seeded at version 29/30/31, after init `getMigrationVersion()` returns ≥ 32, `stitch_projects` and `stitch_screens` tables exist, `idx_stitch_screens_project` exists, and `config` has no `stitch.manifest` row. Re-running migrations is idempotent (no error, version unchanged).
- **Persistence:** `upsertStitchProject` / `upsertStitchScreen` followed by a fresh `KanbanDatabase` load (simulating reload) returns the written rows — proves `_persist()` ran.
- **Accessor round-trip:** `upsertStitchScreen` with `deviceType: null` reads back as `''`; `getStitchScreensForProject` returns only rows for the given `project_id`.
- **`stitchListProjects` gating:** with seeded rows and no `forceRefresh`, the Stitch SDK `projects()` is **not** called; with `forceRefresh: true`, it **is** called and results are upserted.
- **PNG recovery:** seed a screen row, delete its `.png`, open the panel → after the API fetch the screen is re-formatted (image re-downloaded) rather than left image-less. Assert the screen appears in the Phase-3 re-fetch set because `!cachedWithImage.has(id)`.
- **Rebuild Cache:** deletes only PNGs whose basenames derive from `stitch_screens WHERE project_id = ?`; unrelated PNGs in the cache dir survive; DB rows unchanged.

### Manual smoke (user)
- Open panel 3× with a seeded DB → exactly 0 projects-API calls. Click "Refresh Projects" → exactly 1 call.
- Click "Rebuild Cache" → previews disappear then re-render; no unrelated files removed.

---

**Recommendation:** Complexity 6 → **Send to Coder.** The migration renumber, persistence routing, and PNG-recovery filter fix are the load-bearing corrections — a Coder must apply them, not an Intern.
