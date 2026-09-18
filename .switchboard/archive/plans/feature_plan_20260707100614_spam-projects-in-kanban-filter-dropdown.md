# Fix: Spam projects appearing in kanban project filter dropdown

**Plan ID:** 128b5081-b525-4aa6-829c-dcef2fb5c23c

## Goal

Stop unauthorized/phantom project entries from appearing in the kanban project filter dropdown in `kanban.html`. Users are seeing multiple "switchboard - switchboard" entries and other projects they never created. Eliminate the auto-create vectors that pollute the `projects` table with entries derived from plan file metadata pins and stale active-filter values.

### Problem / background / root cause

The `projects` table in `kanban.db` (`KanbanDatabase.ts:168-174`) stores project names per workspace. The kanban project filter dropdown (`kanban.html:4287-4295`) populates from `db.getProjects(workspaceId)` (`KanbanDatabase.ts:2778-2790`), which returns all rows for the workspace (`WHERE workspace_id = ?`, ordered by name). The user is seeing entries they never created — including multiple "switchboard - switchboard" variants — because **three separate code paths auto-create `projects` rows without user confirmation**:

**Vector 1: Plan ingestion auto-creates projects from `**Project:**` metadata pins.**

`_resolveProjectForInsert` (`KanbanDatabase.ts:1482-1505`) is called on every plan INSERT/UPSERT (pre-pass of `upsertPlans` at `:1520`, and `insertFileDerivedPlan` at `:1599` — the watcher/Notion-restore/manifest-ingest paths). When a plan file contains `**Project:** <name>` in its metadata (parsed by `planMetadataUtils.ts:109-112`), the function calls `_resolveOrCreateProjectId` (`KanbanDatabase.ts:1441-1459`) which does `INSERT OR IGNORE INTO projects`. This means **every plan file that an agent writes with a `**Project:**` pin creates a projects row**, even if the user never created that project via the UI.

The agent prompt builder (`agentPromptBuilder.ts:794`, `PROJECT_LINE_DIRECTIVE`) instructs agents to write `**Project:** ${project}` into plan metadata — a single substitution of the active project name, no concatenation. Agents sometimes echo malformed names like "switchboard - switchboard" (see **Clarification** below). Each variant creates a separate `projects` row because `_resolveOrCreateProjectId` only trims whitespace (`KanbanDatabase.ts:1444`) — it does NOT normalize case, collapse duplicates, or validate against existing project names. SQLite's `UNIQUE(name, workspace_id)` uses default BINARY collation (case-sensitive), so "Switchboard" and "switchboard" are distinct rows.

> **Clarification (narrative accuracy, non-blocking):** The dropdown renders each entry as `workspaceLabel > projectName` (`kanban.html:4291`), so the "switchboard - switchboard" the user sees is a **literal project name**, not a rendered composite. Because `PROJECT_LINE_DIRECTIVE` performs a single `${project}` substitution, the composite name can only originate from the **active project filter itself being set to that composite string** (e.g. a prior bad pin stamped onto a plan, then read back as the active filter) — not from agents concatenating workspace + project. The fix is name-agnostic (resolve-only stops auto-create regardless of how the bad name arose), so this does not change the approach; it only corrects the root-cause narrative.

**Vector 2: Active project filter auto-creates a projects row on every board refresh.**

`_refreshBoardImpl` (`KanbanProvider.ts:3040-3067`) validates the restored `_projectFilter` against `getProjects()`. If the filter names a project not in the table, it calls `db.ensureProjectExists(workspaceId, this._projectFilter)` (`KanbanProvider.ts:3063`), which auto-creates the row. This means if `_projectFilter` ever gets set to a bogus value (e.g. from a plan pin that was parsed and stamped on a plan, then read back as the active filter), every board refresh creates a phantom project. (Note: `ensureProjectExists` at `:3063` is NOT the user's "Add Project" button — that path is the webview `case 'addProject'` handler at `KanbanProvider.ts:6572` → `db.addProject()` at `:6585`, which never touches `ensureProjectExists`.)

**Vector 3: Integration import auto-creates a project.**

`TaskViewerProvider.ts:5238` calls `db.addProject(workspaceId, projectName)` during ClickUp/Linear integration setup. This is intentional (the user is creating a project board for imported tickets), but it uses the raw `projectName` without validation, and if the same integration setup runs multiple times with slightly different names, duplicate rows accumulate.

**Non-recurring note (V50 backfill):** A fourth `INSERT OR IGNORE INTO projects` exists at `KanbanDatabase.ts:6140`, inside the **V50** one-time, version-gated backfill migration (`_runMigrations`, `:6118-6160`). It already ran on installs that upgraded past v50 and runs once on old installs upgrading now (before V54). It is NOT a recurring spam source. Do not edit the shipped V50 body. Noted only for completeness.

**Why "switchboard - switchboard" specifically:** See the Clarification above — the composite is a literal project name originating from a bad active-filter value, not agent concatenation. The `UNIQUE(name, workspace_id)` constraint prevents exact duplicates but not case/separator variants.

## Metadata

**Tags:** backend, database, bugfix, ui
**Complexity:** 5

## User Review Required

Yes — one behavioral UX change needs explicit sign-off before coding:
- **Removing auto-create from plan ingestion (Vector 1) changes observable UX.** Currently, when an agent writes `**Project:** Foo` into a plan, "Foo" appears in the dropdown automatically. After the fix, the plan is still tagged (its `project` text field is set), but "Foo" does NOT appear in the dropdown until the user creates it via the board's "Add Project" button. Plans with an unresolved pin land under **All Projects** and under the **Unassigned** filter (via `getBoardFilteredByProject`'s `project_id IS NULL` predicate, `KanbanDatabase.ts:3030-3031`). Confirm this is the desired behavior (users create projects deliberately) versus keeping auto-create with a validation/allowlist gate.

No other review gates. No confirmation dialogs are introduced (per project rule: delete/add buttons act immediately).

## Complexity Audit

### Routine
- Switching Vector 1's explicit-pin path from `_resolveOrCreateProjectId` to the existing read-only `getProjectIdByName` (`KanbanDatabase.ts:2798-2812`) — a one-call change reusing an existing public method. (See **Clarification** in Proposed Changes: on a miss, return `project=''`, `projectId=null` rather than retaining the orphan string.)
- Switching Vector 2 from `ensureProjectExists` to a reset-to-UNASSIGNED — removes one call, no new helper.
- Adding a `source` column via an additive `ALTER TABLE` migration (V54) — straightforward, idempotent under the version gate.
- Wiring `cleanupAutoProjects` into `_refreshBoardImpl` after the `getProjects` fetch (`KanbanProvider.ts:3182`).
- Integration import path (`TaskViewerProvider.ts:5238`) needs no code change — it already routes through `addProject`, which Change 2 updates to set `source='user'`.

### Complex / Risky
- **Behavioral change (Vector 1)** — auto-create removal changes the UX for users who rely on pins manifesting as dropdown entries. See **User Review Required**. The plan's `project` text field is preserved on a miss (or cleared per the Clarification), so no plan data is lost; only the dropdown enumeration changes.
- **The `projects` table is per-workspace (`UNIQUE(name, workspace_id)`, BINARY collation).** Cleaning up spam entries requires a migration that deletes rows not referenced by any plan's `project` field AND not created by the user. Per project rules, NO confirmation dialogs — so cleanup is automatic (`cleanupAutoProjects` on refresh), gated to `source='auto'` rows only. **Limitation:** `cleanupAutoProjects` deletes only **unreferenced** auto rows. Referenced auto-created duplicates (e.g. both "switchboard" and "Switchboard" each with plans pointing at them) **survive** — the dropdown keeps them. Resolution: user manually deletes via the existing delete-project button (`deleteProject`, `KanbanDatabase.ts:2828`, which unassigns plans and clears the active filter). The **normalization** bullet (case-fold + whitespace-collapse) that would merge such duplicates is **deferred** — it is NOT implemented in Proposed Changes; do not assume it is. (Optional follow-up: normalize in `addProject` + `_resolveOrCreateProjectId` and merge existing duplicates in a later migration.)
- **Published extension with ~4,000 installs.** Existing users may have spam projects in their DBs. The V54 migration adds `source` with `DEFAULT 'user'`, so every pre-existing row (including V50-backfill-recreated ones) is treated as user-created and **never** auto-deleted — safe, no data loss. Auto-cleanup only ever removes `source='auto'` rows created *after* the fix that end up unreferenced.
- **Sibling-plan conflict** (see **Dependencies**) — another plan edits the same `_resolveProjectForInsert` Precedence #1 and holds a flawed premise about `ensureProjectExists`. Must be sequenced/merged before coding to avoid a last-merge-wins collision in the same function.

## Edge-Case & Dependency Audit

**Data Loss:**
- Deleting unreferenced `source='auto'` projects is safe — `projects` is a lookup/enumeration table. Plans store the project name as a TEXT field (`plans.project`), not a FK. Deleting a `projects` row does NOT delete plans that reference that name; it just removes the name from the dropdown. Plans with that project name still show under "All Projects" but can't be filtered to that specific name until the user recreates it.
- A user who deliberately created a project but hasn't assigned plans to it yet is safe — `addProject` (the only user-creation path) sets `source='user'`, and `cleanupAutoProjects` never touches `source='user'` rows.
- Pre-existing rows (pre-V54) default to `source='user'` via the `ALTER … DEFAULT 'user'` backfill — preserved, never auto-deleted.

**Filter-path inconsistency (text vs id):**
- `getBoardFilteredByProject` (`KanbanDatabase.ts:3001-3040`) filters the **Unassigned** view on `plans.project_id IS NULL` (`:3030-3031`) and a specific project on a `projects` JOIN by `pr.name` (`:3019`, `:3033`). This is the live board path called from `_refreshBoardImpl` (`KanbanProvider.ts:3088`).
- `getPlansByColumn` (`KanbanDatabase.ts:3042-3067`) filters on the **text** column `project = ?` (`:3060`), not `project_id`.
- These two paths **disagree** for a plan that carries `project='Foo'` (string) but `project_id=NULL`: it appears under Unassigned via `getBoardFilteredByProject` but is hidden from a `getPlansByColumn` Unassigned pass. **Mitigation (adopted):** on a resolve miss, set `project=''` AND `projectId=null` (see Proposed Changes Change 1 Clarification) so both paths agree the plan is unassigned. This also matches the sibling plan's stricter semantics.

**Race Conditions:**
- The plan watcher ingests plans asynchronously. If a plan with `**Project:** Foo` is ingested while the user is manually creating project "Foo" via the UI, both paths try to create the row. The `UNIQUE` constraint + `INSERT OR IGNORE` handles this correctly — only one row is created. After the fix, the ingest path no longer creates a row at all (resolve-only), so the only creator is the user — no race.
- `cleanupAutoProjects` runs on board refresh. If the user is mid-assign (a plan's `project` text is set but not yet persisted) when cleanup runs, the row could be transiently unreferenced and deleted. Mitigation: cleanup only deletes `source='auto'` rows; user-created rows are immune. Acceptable.

**Dead code:**
- After Changes 1 and 4, `ensureProjectExists` (`KanbanDatabase.ts:1465`) and `_resolveOrCreateProjectId` (`KanbanDatabase.ts:1441`) have **zero callers** (verified: the only src caller of `ensureProjectExists` was `KanbanProvider.ts:3063`, removed by Change 4; `_resolveOrCreateProjectId` is called only by `ensureProjectExists` and the two insert-path sites changed by Change 1). **Recommendation:** keep both methods but annotate `[deprecated]` with a comment "Import paths must not auto-create projects; use getProjectIdByName. Retained for the board's explicit-create path if re-wired." Do **not** delete — the sibling plan still references `ensureProjectExists` and deletion would complicate reconciliation.

**Dependencies & Conflicts:**
- The `ensureProjectExists` call in `_refreshBoardImpl` (`KanbanProvider.ts:3063`) was added intentionally (Phase 3) to prevent a restored filter from being silently reset. Change 4 reverts this: a restored filter naming a non-existent project resets to UNASSIGNED. This is the correct behavior — a filter naming a phantom project should not persist.
- The integration import path (`TaskViewerProvider.ts:5238`) is a legitimate project creation path and is unchanged (it routes through `addProject`, which Change 2 updates to set `source='user'`).
- See **Dependencies** section for the sibling-plan conflict.

## Dependencies

- **`fix-project-pin-workspace-conflation-and-import-guard.md`** — CONFLICT / overlap. Edits the same `_resolveProjectForInsert` Precedence #1 (`KanbanDatabase.ts:1487-1494`) to resolve-only, AND adds a workspace-name guard + placeholder (`<project>`) guard + protocol edits in `AGENTS.md`/`.agents/workflows/*`. Its premise that `ensureProjectExists@3061` is "the user's explicit create path that must keep working" is **factually wrong** (3063 is Vector 2; the real user path is `addProject`@6585). **Recommendation:** sequence so this plan's resolve-only (Change 1) + the sibling's guards/protocol land together, OR merge into one PR. If merged, adopt the sibling's stricter on-miss semantics (`project=''`+`null`) — already aligned with this plan's Change 1 Clarification. Avoid two coders editing `_resolveProjectForInsert` concurrently.
- Complements the watcher-hardening plans (`guard-watcher-against-git-churn-board-clobber.md`, `fix-feature-md-subtask-block-accretion.md`) — same root theme (files must not be authoritative over DB), different table. No code overlap.
- `sess_20260707_phantom-projects` — root-cause investigation session (2026-07-07): a `git pull` brought in teammate plans pinning `**Project:** Switchboard`/`switchboard`/`<project>`; on import, Switchboard auto-created projects id 3/4/5 and stamped cards onto the phantom `Switchboard` project, dropping two features (`orchestration-automation-mode`, `remote-control-via-api-providers`) from the visible board. This plan closes all three recurring auto-create vectors; the sibling plan closes the agent-protocol hole.

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) a sibling plan edits the same `_resolveProjectForInsert` with a flawed premise about `ensureProjectExists` — must sequence/merge to avoid a last-merge-wins collision; (2) `cleanupAutoProjects` only removes **unreferenced** auto rows, so referenced case-variant duplicates persist as dropdown spam (user must delete manually); (3) keeping an orphan `project` string on a resolve miss splits the board's two filter paths — mitigated by adopting `project=''`+`projectId=null` on miss. Mitigations: V54 migration backfills `source='user'` on all pre-existing rows (no data loss for ~4,000 installs); dead helpers retained + deprecated rather than deleted to ease reconciliation; resolve-only reuses the existing `getProjectIdByName` (no new SQL surface).

## Proposed Changes

### src/services/KanbanDatabase.ts

**Change 1: Stop auto-creating projects from plan metadata pins (Vector 1)**

In `_resolveProjectForInsert` (`KanbanDatabase.ts:1482-1505`), change the explicit-pin path to resolve the project ID WITHOUT auto-creating:

```js
// BEFORE (line 1487-1493):
if (record.project && record.project.trim() !== '') {
    const project = record.project.trim();
    let projectId = record.projectId ?? null;
    if (projectId === null) {
        projectId = await this._resolveOrCreateProjectId(record.workspaceId, project);
    }
    return { project, projectId };
}

// AFTER:
if (record.project && record.project.trim() !== '') {
    const project = record.project.trim();
    let projectId = record.projectId ?? null;
    if (projectId === null) {
        // Resolve WITHOUT auto-creating — plan metadata pins should not
        // create projects table rows. The project name is still stamped on
        // the plan record (plans.project TEXT column), so the plan is
        // correctly tagged and will appear under "All Projects" filtering.
        // The project appears in the dropdown only when the user creates it
        // via the UI (addProject handler).
        projectId = await this.getProjectIdByName(record.workspaceId, project);
    }
    // CLARIFICATION: on a resolve miss (projectId === null), drop the orphan
    // denormalized string too — set project='' — so the board's two filter
    // paths agree (getBoardFilteredByProject filters Unassigned on
    // project_id IS NULL; getPlansByColumn filters on project=''). Retaining
    // the string would split the Unassigned view. This also matches the
    // sibling plan's stricter semantics and makes cleanupAutoProjects
    // deterministic.
    if (projectId === null) {
        return { project: '', projectId: null };
    }
    return { project, projectId };
}
```

Also change the active-filter fallback (lines 1496-1501):

```js
// BEFORE (line 1496-1501):
if (!isExisting) {
    const active = this.getConfigSync('kanban.activeProjectFilter');
    if (active && active !== KanbanDatabase.UNASSIGNED_PROJECT_FILTER) {
        const projectId = await this._resolveOrCreateProjectId(record.workspaceId, active);
        return { project: active, projectId };
    }
}

// AFTER:
if (!isExisting) {
    const active = this.getConfigSync('kanban.activeProjectFilter');
    if (active && active !== KanbanDatabase.UNASSIGNED_PROJECT_FILTER) {
        // Resolve WITHOUT auto-creating — same rationale as above.
        const projectId = await this.getProjectIdByName(record.workspaceId, active);
        // Same on-miss rule: drop the orphan string.
        if (projectId === null) {
            return { project: '', projectId: null };
        }
        return { project: active, projectId };
    }
}
```

> **Note (Precedence #2 intent):** Precedence #2 reads the board's *active* project — a value that only exists because the user selected/created that project on the board — so for a correctly-running install `getProjectIdByName` will hit. A miss here means the active filter names a phantom/deleted project; dropping to unassigned is the correct recovery (consistent with Change 4's reset-to-UNASSIGNED).

**Change 2: Add a `source` column to the `projects` table to distinguish user-created from auto-created**

This requires THREE coordinated edits (the migration system is version-gated; latest is V53):

**(2a) SCHEMA_SQL — fresh-DB definition.** In the `projects` table schema (`KanbanDatabase.ts:168-174`), add the column so brand-new DBs have it from creation:

```js
// BEFORE (line 168-174):
CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(name, workspace_id)
);

// AFTER:
CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    source TEXT NOT NULL DEFAULT 'user',
    UNIQUE(name, workspace_id)
);
```

**(2b) V54 migration const — existing-DB upgrade.** Define the migration alongside the other `MIGRATION_Vnn_SQL` consts (e.g. after `MIGRATION_V53_SQL` at `KanbanDatabase.ts:345-349`):

```js
// V54: distinguish user-created projects from auto-created ones so
// cleanupAutoProjects can safely remove unreferenced auto rows without
// ever touching user-created projects. Existing rows backfill to 'user'
// (SQLite ADD COLUMN with a constant DEFAULT populates existing rows).
// Safe/idempotent under the version gate; never edit a shipped Vnn body.
const MIGRATION_V54_SQL = [
    `ALTER TABLE projects ADD COLUMN source TEXT NOT NULL DEFAULT 'user'`,
];
```

**(2c) V54 version-gate block.** In `_runMigrations()`, immediately after the V53 block (`KanbanDatabase.ts:6206-6214`), before the method's closing brace (`:6215`):

```js
// V54: projects.source column — user vs auto origin (spam-project fix).
const v54 = await this.getMigrationVersion();
if (v54 < 54) {
    for (const sql of MIGRATION_V54_SQL) {
        try { this._db.exec(sql); } catch { /* already exists */ }
    }
    await this.setMigrationVersion(54);
    console.log('[KanbanDatabase] V54 migration completed: added source column to projects table');
}
```

> Do NOT rely on `_ensureSchemaColumns()` (`KanbanDatabase.ts:6340`) for this — it only reconciles `plans` + `worktrees`, not `projects`. The V54 migration is the authoritative path for existing DBs; the SCHEMA_SQL edit is the authoritative path for fresh DBs.

Update `addProject` (`KanbanDatabase.ts:2814-2826`) to explicitly set `source = 'user'`:

```js
public async addProject(workspaceId: string, projectName: string): Promise<boolean> {
    if (!(await this.ensureReady()) || !this._db) return false;
    try {
        this._db.run(
            'INSERT INTO projects (name, workspace_id, source) VALUES (?, ?, ?)',
            [projectName, workspaceId, 'user']
        );
        return await this._persist();
    } catch (e) {
        console.debug('[KanbanDatabase] addProject failed (might already exist):', e);
        return false;
    }
}
```

Update `_resolveOrCreateProjectId` (`KanbanDatabase.ts:1441-1459`) to set `source = 'auto'` (it is retained as deprecated — see **Dead code** in the audit — but if any path still calls it, new rows must be marked auto):

```js
this._db.run(
    'INSERT OR IGNORE INTO projects (name, workspace_id, source) VALUES (?, ?, ?)',
    [trimmedName, workspaceId, 'auto']
);
```

**Change 3: Add a cleanup method to delete unreferenced auto-created projects**

Use the codebase's idiomatic `this._db.run()` pattern for the DELETE (matching `deleteProject` at `KanbanDatabase.ts:2831-2834`), then count affected rows via a separate query (avoids relying on `getRowsModified()` placement after a prepared-statement step):

```js
/**
 * Delete projects rows that were auto-created (source='auto') and are not
 * referenced by any plan's project field. Safe to call on every board refresh.
 * User-created projects (source='user') are never deleted by this method.
 * NOTE: referenced auto-created duplicates (e.g. case variants each with plans)
 * are NOT removed — the user must delete those manually via deleteProject.
 */
public async cleanupAutoProjects(workspaceId: string): Promise<number> {
    if (!(await this.ensureReady()) || !this._db) return 0;
    try {
        // Count victims first (for logging / caller re-fetch decision).
        const countStmt = this._db.prepare(
            `SELECT COUNT(*) AS n FROM projects
             WHERE workspace_id = ? AND source = 'auto'
             AND name NOT IN (SELECT DISTINCT project FROM plans
                              WHERE workspace_id = ? AND project IS NOT NULL AND project != '')`,
            [workspaceId, workspaceId]
        );
        let victimCount = 0;
        if (countStmt.step()) {
            victimCount = Number(countStmt.getAsObject().n ?? 0);
        }
        countStmt.free();
        if (victimCount === 0) return 0;

        this._db.run(
            `DELETE FROM projects
             WHERE workspace_id = ? AND source = 'auto'
             AND name NOT IN (SELECT DISTINCT project FROM plans
                              WHERE workspace_id = ? AND project IS NOT NULL AND project != '')`,
            [workspaceId, workspaceId]
        );
        await this._persist();
        console.debug(`[KanbanDatabase] cleanupAutoProjects: removed ${victimCount} unreferenced auto-created projects`);
        return victimCount;
    } catch (e) {
        console.error('[KanbanDatabase] cleanupAutoProjects failed:', e);
        return 0;
    }
}
```

> **Deprecation annotation (Dead code mitigation):** Add a `@deprecated` JSDoc line to `ensureProjectExists` (`:1465`) and `_resolveOrCreateProjectId` (`:1441`): *"Import paths must not auto-create projects — use getProjectIdByName. Retained for potential re-wiring of the board's explicit-create path; do not call from insert/upsert paths."* Do not delete (sibling-plan reconciliation).

### src/services/KanbanProvider.ts

**Change 4: Stop auto-creating projects from the restored filter (Vector 2)**

In `_refreshBoardImpl` (`KanbanProvider.ts:3058-3067`), change `ensureProjectExists` to a reset-to-UNASSIGNED (the actual call is at `:3063`; the plan's earlier "3061" reference is off by two):

```js
// BEFORE (line 3058-3067):
} else if (!projects.includes(this._projectFilter)) {
    // Project row missing — auto-create it (Phase 3 semantics) and
    // keep the filter. ensureProjectExists returns null only on real
    // failure, in which case fall back to UNASSIGNED to avoid a
    // stuck phantom filter that matches no board.
    const id = await db.ensureProjectExists(workspaceId, this._projectFilter);
    if (id === null) {
        this._projectFilter = KanbanDatabase.UNASSIGNED_PROJECT_FILTER;
    }
}

// AFTER:
} else if (!projects.includes(this._projectFilter)) {
    // The filter names a project that doesn't exist in the projects table.
    // Do NOT auto-create it — this was a source of spam projects. Reset to
    // UNASSIGNED. The plan's project field is preserved (it's a TEXT column,
    // not a FK), so no data is lost.
    this._projectFilter = KanbanDatabase.UNASSIGNED_PROJECT_FILTER;
}
```

> **DB-race guard preserved:** the `projects.length === 0` branch above (`:3055-3057`) leaves the filter intact and retries next refresh. That guard stays — do not collapse it into the reset.

**Change 5: Call cleanupAutoProjects on board refresh**

In `_refreshBoardImpl`, after the `getProjects` fetch (`KanbanProvider.ts:3182`), call the cleanup:

```js
// After line 3182:
const projects = workspaceId && dbReady ? await db.getProjects(workspaceId) : [];
// Clean up unreferenced auto-created projects (from the now-removed auto-create vectors).
if (workspaceId && dbReady) {
    const removed = await db.cleanupAutoProjects(workspaceId);
    if (removed > 0) {
        // Re-fetch if we removed any — the dropdown needs the cleaned list.
        const cleanedProjects = await db.getProjects(workspaceId);
        // Use cleanedProjects instead of projects for the rest of this function.
        projects.length = 0;
        projects.push(...cleanedProjects);
    }
}
```

### src/services/TaskViewerProvider.ts

**Change 6: Set source='user' for integration-import projects (line 5238)**

The `addProject` call at line 5238 already goes through `db.addProject()`, which Change 2 updates to set `source = 'user'`. No additional change needed — the integration import is a user-initiated action.

## Verification Plan

> **Session constraints:** No compilation step and no automated test run this pass (per session directive and `CLAUDE.md`: testing is done via an installed VSIX; `src/` is the source of truth; do not audit `dist/`). All verification below is **manual, against an installed VSIX**.

### Automated Tests
Skipped this pass per session directive. (Suggested future test, when the test suite is run: seed a workspace, insert a plan record with `project:'TestProject'` and no matching `projects` row; assert **no** `projects` row is created and the plan lands `project=''`, `project_id=null`. Then create project "Foo" via `addProject`; insert a record pinning "Foo"; assert it resolves to Foo's id and `source='user'`. Then insert via the auto path and assert `source='auto'`; call `cleanupAutoProjects` after deleting the referencing plan; assert the auto row is removed.)

### Manual Verification (installed VSIX)
1. **Repro the bug (pre-fix baseline):** On the current installed build, open a workspace with plan files containing `**Project:** switchboard` or `**Project:** switchboard - switchboard` pins. Observe the kanban project filter dropdown shows these as entries (`workspace > switchboard`, etc.). Record the spam set.
2. **Apply fixes** (build a VSIX from the updated `src/` and install; do NOT run `npm run compile` as a verification step, and do NOT run `npm test`).
3. **Test plan ingestion (Vector 1):** Create a new plan file with `**Project:** TestProject` in metadata. Save it. Verify: the plan is ingested, its `project` field is `''` and `project_id` is `null` (resolve miss → unassigned), and **"TestProject" does NOT appear** in the project filter dropdown.
4. **Test legitimate pin (Vector 1 positive):** Click "Add Project" in the kanban UI, create "MyProject". Then create a plan file with `**Project:** MyProject`. Save it. Verify: the plan resolves to MyProject's id (`project='MyProject'`, `project_id=<id>`), and "MyProject" already appears in the dropdown (user-created, `source='user'`).
5. **Test user-created project (source):** Click "Add Project", create "UserProj". Verify via DB inspection (`SELECT name, source FROM projects WHERE name='UserProj'`) that `source='user'`.
6. **Test cleanup (existing spam):** With auto-created projects in the DB (from before the fix, or seeded with `source='auto'`), trigger a board refresh. Verify: **unreferenced** auto-created projects are deleted from the dropdown. **Referenced** auto-created projects (plans still point to them) remain — and the user can delete those manually via the delete-project button.
7. **Test restored filter (Vector 2):** Set the project filter to a non-existent project name (e.g. by editing `kanban.activeProjectFilter` in the DB config, or by selecting a project then deleting it so the filter dangles). Refresh the board. Verify: the filter resets to UNASSIGNED, no phantom project is auto-created.
8. **Test integration import (Vector 3):** Run a ClickUp/Linear import. Verify: the project is created with `source='user'` and appears in the dropdown.
9. **Migration test (V54):** Open an existing workspace with an older DB (no `source` column — migration version < 54). Load the new build. Verify: the migration adds `source` with default `'user'`, preserving all existing projects (none deleted); `cleanupAutoProjects` is a no-op on first refresh because all rows are `source='user'`.
10. **Filter-path consistency check:** After step 3 (unresolved pin), confirm the plan appears under **All Projects** and under the **Unassigned** filter via the live board (`getBoardFilteredByProject`, `project_id IS NULL`). If any view uses `getPlansByColumn` with a text filter, confirm the same plan does NOT appear there under a specific-name filter (expected, since no such project exists) and DOES appear under its unassigned/no-filter view.

**Recommendation:** Complexity 5 (multi-file change + additive migration + behavioral UX change, but all changes reuse existing patterns and are well-scoped). **Send to Coder.** Sequence with / merge into `fix-project-pin-workspace-conflation-and-import-guard.md` before coding to avoid a collision in `_resolveProjectForInsert`.

**Stage Complete:** PLAN REVIEWED


**Stage Complete:** LEAD CODED

## Review Findings

Reviewer pass assessed the implementation in commit `85b78fc` (plus follow-up `1a45e22`) against this plan. Two material gaps were found and fixed in `src/services/KanbanDatabase.ts`: (1) **CRITICAL** — the V54 version-gate block in `_runMigrations()` (Change 2c) was never added, only the `MIGRATION_V54_SQL` const was defined, so the `source` column was never created on any DB and `addProject` / `cleanupAutoProjects` / `_resolveOrCreateProjectId` all threw "no such column: source" (silently breaking the user's Add-Project button on ~4,000 installs); (2) **MAJOR** — the SCHEMA_SQL fresh-DB `projects` table (Change 2a) was not updated with `source`, leaving fresh DBs dependent on the migration and matching the known stamped-version/recreated-table failure class. Both are now applied (SCHEMA_SQL:168-175, V54 block at :6368-6382). Changes 1, 3, 4, 5 and the deprecation annotations landed correctly and match the plan. One NIT (deferred): `switchboard-chat.md` / its SKILL.md carry an unrelated "manifest location → per-plan frontmatter" rewrite bundled into the implementation commit (scope creep, not in this plan). Verification: compilation and tests skipped per session directive; edits are grep-verified against the V53 pattern and the plan's code blocks. Remaining risk: the `record.projectId ??` trust residual on the `upsertPlans` path is documented in-code and deliberately deferred (per plan); referenced auto-created duplicate projects still require manual `deleteProject` (per plan limitation).

**Stage Complete:** CODE REVIEWED
