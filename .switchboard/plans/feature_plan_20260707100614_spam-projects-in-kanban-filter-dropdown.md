# Fix: Spam projects appearing in kanban project filter dropdown

## Goal

Stop unauthorized/phantom project entries from appearing in the kanban project filter dropdown in `kanban.html`. Users are seeing multiple "switchboard - switchboard" entries and other projects they never created. Eliminate the auto-create vectors that pollute the `projects` table with entries derived from plan file metadata pins and stale active-filter values.

### Problem / background / root cause

The `projects` table in `kanban.db` (`KanbanDatabase.ts:168-174`) stores project names per workspace. The kanban project filter dropdown (`kanban.html:4287-4295`) populates from `db.getProjects(workspaceId)` (`KanbanDatabase.ts:2778-2790`), which returns ALL rows in the table. The user is seeing entries they never created — including multiple "switchboard - switchboard" variants — because **three separate code paths auto-create `projects` rows without user confirmation**:

**Vector 1: Plan ingestion auto-creates projects from `**Project:**` metadata pins.**

`_resolveProjectForInsert` (`KanbanDatabase.ts:1482-1505`) is called on every plan INSERT/UPSERT. When a plan file contains `**Project:** <name>` in its metadata (parsed by `planMetadataUtils.ts:109-112`), the function calls `_resolveOrCreateProjectId` (`KanbanDatabase.ts:1441-1459`) which does `INSERT OR IGNORE INTO projects`. This means **every plan file that an agent writes with a `**Project:**` pin creates a projects row**, even if the user never created that project via the UI.

The agent prompt builder (`agentPromptBuilder.ts:794`) instructs agents to write `**Project:** <name>` into plan metadata. Agents sometimes write composite or malformed names like "switchboard - switchboard" (e.g. combining the workspace name with the project name, or echoing the workspace name twice). Each variant creates a separate `projects` row because `_resolveOrCreateProjectId` only trims whitespace (`KanbanDatabase.ts:1444`) — it does NOT normalize case, collapse duplicates, or validate against existing project names.

**Vector 2: Active project filter auto-creates a projects row on every board refresh.**

`_refreshBoardImpl` (`KanbanProvider.ts:3040-3067`) validates the restored `_projectFilter` against `getProjects()`. If the filter names a project not in the table, it calls `db.ensureProjectExists(workspaceId, this._projectFilter)` (`KanbanProvider.ts:3061`), which auto-creates the row. This means if `_projectFilter` ever gets set to a bogus value (e.g. from a plan pin that was parsed and stamped on a plan, then read back as the active filter), every board refresh creates a phantom project.

**Vector 3: Integration import auto-creates a project.**

`TaskViewerProvider.ts:5238` calls `db.addProject(workspaceId, projectName)` during ClickUp/Linear integration setup. This is intentional (the user is creating a project board for imported tickets), but it uses the raw `projectName` without validation, and if the same integration setup runs multiple times with slightly different names, duplicate rows accumulate.

**Why "switchboard - switchboard" specifically:** The agent prompt builder (`agentPromptBuilder.ts:794`) writes `**Project:** ${project}` where `${project}` is the active project name. If the active project was set to "switchboard" (the workspace name, not a real project), agents write `**Project:** switchboard` into plan files. On re-ingestion, `_resolveOrCreateProjectId` creates a "switchboard" project row. If agents also write `**Project:** switchboard - switchboard` (e.g. by concatenating workspace + project), that creates a separate row. The `UNIQUE(name, workspace_id)` constraint prevents exact duplicates but not case/separator variants.

## Metadata

**Tags:** backend, database, bugfix, ui, kanban
**Complexity:** 5
**Project:** v5 funnel

## Complexity Audit

### Routine
- Adding a normalization step to `_resolveOrCreateProjectId` (trim + collapse whitespace + case-fold for comparison) — straightforward string processing.
- Adding a guard in `_refreshBoardImpl` to NOT auto-create a project from `_projectFilter` — change `ensureProjectExists` to a read-only `getProjectIdByName` that returns null without inserting.
- Adding a UI confirmation or validation step for plan-pinned project names — but this conflicts with the headless ingestion flow (no UI during watcher events).

### Complex / Risky
- **Removing auto-create from plan ingestion (Vector 1) is a behavioral change.** Currently, when an agent writes `**Project:** Foo` into a plan, the project "Foo" appears in the dropdown automatically. Removing this means the plan's `project` field is set to "Foo" but "Foo" doesn't appear in the dropdown — the plan shows under "(No Project)" or under "All Projects" but can't be filtered to "Foo" unless the user manually creates it. This is the correct behavior (users should create projects deliberately), but it changes the UX for users who rely on auto-creation.
- **The `projects` table is per-workspace (`UNIQUE(name, workspace_id)`).** Cleaning up spam entries requires a migration that deletes rows not referenced by any plan's `project` field AND not created by the user. This is destructive and must be gated behind user confirmation — but per project rules, NO confirmation dialogs. So the cleanup must be automatic (delete unreferenced projects on next refresh) or manual (user deletes them one by one via the existing delete-project button).
- **Published extension with ~4,000 installs.** Existing users may have spam projects in their DBs. A migration is needed to clean them up without deleting legitimate projects.

## Edge-Case & Dependency Audit

**Data Loss:**
- Deleting unreferenced projects from the `projects` table is safe — the table is a lookup/enumeration table. Plans store the project name as a TEXT field (`plans.project`), not a FK. Deleting a `projects` row does NOT delete plans that reference that name; it just removes the name from the dropdown. Plans with that project name still show under "All Projects" but can't be filtered to that specific name until the user recreates it.
- However, if a user deliberately created a project but hasn't assigned any plans to it yet, the cleanup would delete it. Mitigation: only delete projects that were auto-created (not user-created). But there's no `created_by` column on the `projects` table — we can't distinguish auto-created from user-created. Mitigation: add a `source` column (`'user'` vs `'auto'`) via migration, then only delete `'auto'` projects that are unreferenced.

**Race Conditions:**
- The plan watcher ingests plans asynchronously. If a plan with `**Project:** Foo` is ingested while the user is manually creating project "Foo" via the UI, both paths try to create the row. The `UNIQUE` constraint + `INSERT OR IGNORE` handles this correctly — only one row is created.

**Dependencies & Conflicts:**
- The `ensureProjectExists` call in `_refreshBoardImpl` (`KanbanProvider.ts:3061`) was added intentionally (Phase 3) to prevent a restored filter from being silently reset. Removing the auto-create changes this behavior: a restored filter naming a non-existent project will be reset to UNASSIGNED. This is the correct behavior — a filter naming a phantom project should not persist.
- The integration import path (`TaskViewerProvider.ts:5238`) is a legitimate project creation path and should not be changed.

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
        return { project: active, projectId };
    }
}
```

**Change 2: Add a `source` column to the `projects` table to distinguish user-created from auto-created**

Add a migration to add `source TEXT DEFAULT 'user'` to the `projects` table. Existing rows default to `'user'` (preserving them). New rows from `addProject` (the UI handler) get `'user'`; rows from `_resolveOrCreateProjectId` get `'auto'`.

```js
// In the migration SQL section, add:
`ALTER TABLE projects ADD COLUMN source TEXT DEFAULT 'user'`,
```

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

Update `_resolveOrCreateProjectId` (`KanbanDatabase.ts:1441-1459`) to set `source = 'auto'`:

```js
this._db.run(
    'INSERT OR IGNORE INTO projects (name, workspace_id, source) VALUES (?, ?, ?)',
    [trimmedName, workspaceId, 'auto']
);
```

**Change 3: Add a cleanup method to delete unreferenced auto-created projects**

```js
/**
 * Delete projects rows that were auto-created (source='auto') and are not
 * referenced by any plan's project field. Safe to call on every board refresh.
 * User-created projects (source='user') are never deleted by this method.
 */
public async cleanupAutoProjects(workspaceId: string): Promise<number> {
    if (!(await this.ensureReady()) || !this._db) return 0;
    try {
        // Find auto-created projects not referenced by any plan.
        const stmt = this._db.prepare(
            `DELETE FROM projects
             WHERE workspace_id = ? AND source = 'auto'
             AND name NOT IN (SELECT DISTINCT project FROM plans
                              WHERE workspace_id = ? AND project IS NOT NULL AND project != '')`,
            [workspaceId, workspaceId]
        );
        stmt.step();
        stmt.free();
        const changes = this._db.getRowsModified();
        if (changes > 0) {
            await this._persist();
            console.debug(`[KanbanDatabase] cleanupAutoProjects: removed ${changes} unreferenced auto-created projects`);
        }
        return changes;
    } catch (e) {
        console.error('[KanbanDatabase] cleanupAutoProjects failed:', e);
        return 0;
    }
}
```

### src/services/KanbanProvider.ts

**Change 4: Stop auto-creating projects from the restored filter (Vector 2)**

In `_refreshBoardImpl` (`KanbanProvider.ts:3056-3065`), change `ensureProjectExists` to a read-only check:

```js
// BEFORE (line 3056-3065):
} else if (!projects.includes(this._projectFilter)) {
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

**Change 5: Call cleanupAutoProjects on board refresh**

In `_refreshBoardImpl`, after fetching projects (line 3180), call the cleanup:

```js
// After line 3180:
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

1. **Repro the bug (pre-fix):** Open a workspace with plan files containing `**Project:** switchboard` or `**Project:** switchboard - switchboard` pins. Observe: the kanban project filter dropdown shows these as project entries.
2. **Apply fixes.** Run `npm run compile`.
3. **Test plan ingestion:** Create a new plan file with `**Project:** TestProject` in metadata. Save it. Verify: the plan is ingested, its `project` field is set to "TestProject", but "TestProject" does NOT appear in the project filter dropdown.
4. **Test user-created project:** Click "Add Project" in the kanban UI, create "MyProject". Verify: "MyProject" appears in the dropdown with `source = 'user'`.
5. **Test cleanup:** With auto-created projects in the DB (from before the fix), trigger a board refresh. Verify: unreferenced auto-created projects are deleted from the dropdown. Referenced ones (plans still point to them) remain.
6. **Test restored filter:** Set the project filter to a non-existent project name (e.g. by editing `kanban.activeProjectFilter` in the DB config). Refresh the board. Verify: the filter is reset to UNASSIGNED, not auto-created.
7. **Test integration import:** Run a ClickUp/Linear import. Verify: the project is created with `source = 'user'` and appears in the dropdown.
8. **Run existing tests:** `npm test` — verify no regressions in KanbanDatabase or KanbanProvider tests.
9. **Migration test:** Open an existing workspace with an older DB (no `source` column). Verify: the migration adds the column with default `'user'`, preserving all existing projects.
