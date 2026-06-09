# Kanban Project Grouping and Filtering

## Goal
Add a second navigation bar in kanban.html below the existing workspace dropdown bar, containing a project dropdown, "Add Project" button, and "Assign Selected to Project" button. Selecting a project filters the kanban board to show only plans tagged with that project, helping users focus on specific areas during a session.

## Metadata
- **Tags:** frontend, backend, UI, UX, database
- **Complexity:** 6

## User Review Required
- Confirm project naming convention (e.g., should projects be free-form strings or constrained to specific patterns?)
- **Note:** `window.prompt()` is blocked in VS Code webviews. The "Add Project" button will use `vscode.postMessage` → backend `showInputBox()` round-trip instead of an inline prompt.

## Current State
- `KanbanPlanRecord` already has a `workspaceId: string` field (line 31 in KanbanDatabase.ts)
- `KanbanDatabase` already has `getBoard()` and `getBoardFiltered()` methods
- kanban.html already has multi-select with `selectedCards` Set and `.kanban-card.selected` class (line 2912, 899)
- The kanban header currently has one control strip with workspace dropdown
- Migration system is at **V22** — new migration must be **V23**
- Refresh chain: `_refreshBoard()` → `vscode.commands.executeCommand('switchboard.refreshUI')` → `TaskViewerProvider._refreshRunSheets()`. Project filter must be threaded through `TaskViewerProvider._refreshRunSheets()` like `repoScopeFilter` already is (line 13238–13244).
- kanban.html has a single massive `window.addEventListener('message', ...)` handler — new project-filter cases must be merged into it, not added as a second listener.
- `PLAN_COLUMNS` constant (line 401) and `_readRows()` mapping (line ~3658) control DB→record mapping — both must be updated for the `project` column.

## Problem
Users working on large codebases with multiple projects (e.g., frontend, backend, infrastructure) need a way to group and filter plans by project. Currently, the only filtering option is by workspace/dropdown workspace, which may be too coarse-grained. A project-level filter would allow users to focus on a specific area without creating separate workspaces.

## Solution Overview
1. **Add projects table** to kanban database (workspace-scoped)
2. **Add project field** to `KanbanPlanRecord` and all DB infrastructure (`PLAN_COLUMNS`, `UPSERT_PLAN_SQL`, `_readRows()` mapping, `SCHEMA_SQL`)
3. **Add V23 migration** for `projects` table + `project` column on `plans`
4. **Add project CRUD methods** to `KanbanDatabase` using correct sql.js `prepare(sql, params)` pattern
5. **Add second button bar** in kanban.html below the existing header
6. **Thread `projectFilter`** through `TaskViewerProvider._refreshRunSheets()` alongside `repoScopeFilter`
7. **Add message handlers** in `KanbanProvider.ts` (using `showInputBox()` for project name input — `prompt()` is blocked in webviews)
8. **Merge project-filter cases** into the existing `window.addEventListener('message', ...)` block in kanban.html — do NOT add a second listener

## Complexity Audit

### Routine
- Adding second button bar HTML structure in kanban.html
- Adding project dropdown styling (reusing existing `.workspace-select` styles)
- Adding "Add Project" and "Assign" button styling (reusing `.strip-btn` styles)
- Frontend state management for selected project (reusing existing filter pattern)
- Backend project CRUD operations in KanbanDatabase (standard SQL operations)
- Database migration for new tables/columns

### Complex / Risky
- **Database migration (V23)**: Adding new table and column requires migration script; must be idempotent and version-gated
- **Filter threading**: Project filter must be threaded through `TaskViewerProvider._refreshRunSheets()` alongside the existing `repoScopeFilter` — cannot just hook into `_refreshBoardImpl()` which is bypassed by the primary refresh path
- **`PLAN_COLUMNS` update**: Missing this constant breaks `_readRows()` mapping silently — all DB reads would miss `project` field
- **`UPSERT_PLAN_SQL` / `SCHEMA_SQL` update**: New DBs created from scratch need `project` in schema; upsert must include it

## Edge-Case & Dependency Audit

**Race Conditions**
- Project list refresh on board refresh handles staleness
- Existing `selectedCards` pattern already handles card movement during selection

**Security**
- Project names are user-supplied strings — use parameterized queries (no string interpolation in SQL)

**Side Effects**
- Database migration must handle existing rows gracefully (default empty string for new project column)
- `deleteProject()` must clear `project` field from all plans belonging to that project in a single atomic operation

**Dependencies & Conflicts**
- Existing `selectedCards` Set and `.kanban-card.selected` class — reuse this pattern
- Existing `repoScopeFilter` in `KanbanProvider` (line 136) and `TaskViewerProvider._refreshRunSheets()` (line 13238) — add parallel `projectFilter`
- `getBoardFiltered()` already supports repoScope filtering — extend with a new `getBoardFilteredByProject()` that handles both filters with AND logic
- `window.prompt()` is blocked in VS Code webviews — use `vscode.postMessage({ type: 'addProject' })` → backend `vscode.window.showInputBox()` round-trip
- kanban.html has ONE `window.addEventListener('message', ...)` handler — merge into it; do NOT add a second listener

## Dependencies
- None blocking

## Adversarial Synthesis
Key risks: (1) The refresh chain bypasses `_refreshBoardImpl()` — `projectFilter` must be threaded through `TaskViewerProvider._refreshRunSheets()` to take effect; (2) `window.prompt()` is silently blocked in VS Code webviews, requiring a backend `showInputBox()` round-trip for project name input; (3) Missing `project` in `PLAN_COLUMNS`, `UPSERT_PLAN_SQL`, or `_readRows()` mapping would cause silent data loss — all four DB infrastructure points must be updated atomically. Mitigations: Use the same repoScope threading pattern already proven in `_refreshRunSheets()`, use `showInputBox()` for input, update all four DB constants together.

## Proposed Changes

---

### 1. Database Schema & Infrastructure

#### [MODIFY] [KanbanDatabase.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanDatabase.ts)

**Step 1.1 — Update `KanbanPlanRecord` interface** (line 20–43): Add `project` field after `repoScope`:
```typescript
export interface KanbanPlanRecord {
    planId: string;
    sessionId: string;
    topic: string;
    planFile: string;
    kanbanColumn: string;
    status: KanbanPlanStatus;
    complexity: string;
    tags: string;
    dependencies: string;
    repoScope: string;
    project: string;          // NEW — project grouping field (empty string = unassigned)
    workspaceId: string;
    // ... rest of fields
}
```

**Step 1.2 — Update `SCHEMA_SQL`** (line 87–124): Add `project TEXT DEFAULT ''` column and index after `repo_scope`:
```sql
-- inside SCHEMA_SQL string, after repo_scope line:
project       TEXT DEFAULT '',
-- after the existing indexes:
CREATE INDEX IF NOT EXISTS idx_plans_project ON plans(workspace_id, project);
```

**Step 1.3 — Update `UPSERT_PLAN_SQL`** (line 367–396): Add `project` to INSERT column list and VALUES, and to the ON CONFLICT DO UPDATE SET clause:
```sql
-- Add to INSERT column list (after repo_scope):
project,
-- Add to VALUES (after repo_scope value, as position 12):
?,
-- Add to ON CONFLICT DO UPDATE SET:
project = excluded.project,
```
> Clarification: The parameter positions in the VALUES list shift — `project` is param #12 (0-indexed: after `repo_scope` at position 9, `workspace_id` at 10, then dates). Verify exact position by counting existing params.

**Step 1.4 — Update `PLAN_COLUMNS` constant** (line 401–404): Add `project` after `repo_scope`:
```typescript
const PLAN_COLUMNS = `plan_id, session_id, topic, plan_file, kanban_column, status, complexity, tags, dependencies,
                       repo_scope, project, workspace_id, created_at, updated_at, last_action, source_type,
                       brain_source_path, mirror_path, routed_to, dispatched_agent, dispatched_ide,
                       clickup_task_id, linear_issue_id`;
```

**Step 1.5 — Add V23 migration constants** (after `MIGRATION_V20_SQL`, around line 360):
```typescript
const MIGRATION_V23_SQL = [
    // Add projects table (workspace-scoped)
    `CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(name, workspace_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_projects_workspace ON projects(workspace_id)`,
    // Add project column to plans table
    `ALTER TABLE plans ADD COLUMN project TEXT DEFAULT ''`,
    `CREATE INDEX IF NOT EXISTS idx_plans_project ON plans(workspace_id, project)`,
];
```

**Step 1.6 — Update `_readRows()` mapping** (line ~3658): Add `project` field mapping:
```typescript
// After repoScope mapping line:
project: String(row.project || ''),
```

**Step 1.7 — Update `upsertPlan()` call sites** to pass `project` field. Locate where `upsertPlan()` is called with positional args and add `record.project || ''` at the correct position (after `record.repoScope`).

**Step 1.8 — Add V23 migration runner block** in `_runMigrations()` at the end (after V22 block, around line 3460):
```typescript
// V23: add projects table and project column to plans for project-level grouping/filtering.
const v23 = await this.getMigrationVersion();
if (v23 < 23) {
    for (const sql of MIGRATION_V23_SQL) {
        try { this._db.exec(sql); } catch (e) {
            console.debug('[KanbanDatabase] V23 migration step skipped (already applied):', e);
        }
    }
    await this.setMigrationVersion(23);
    console.log('[KanbanDatabase] V23 migration completed: projects table and plans.project column added');
}
```

**Step 1.9 — Add project CRUD methods** (after `getBoardFiltered()`, around line 1896):

> **Critical**: Use `prepare(sql, params)` pattern — NOT `stmt.run(params)` after `prepare(sql)`. See existing `getBoard()` at line 1873 for the correct pattern.

```typescript
public async getProjects(workspaceId: string): Promise<string[]> {
    if (!(await this.ensureReady()) || !this._db) return [];
    const stmt = this._db.prepare(
        'SELECT name FROM projects WHERE workspace_id = ? ORDER BY name',
        [workspaceId]
    );
    const rows = this._readRows(stmt);
    return rows.map((r: any) => String(r.name || ''));
}

public async addProject(workspaceId: string, projectName: string): Promise<boolean> {
    if (!(await this.ensureReady()) || !this._db) return false;
    return this._write(async () => {
        try {
            this._db!.run(
                'INSERT INTO projects (name, workspace_id) VALUES (?, ?)',
                [projectName, workspaceId]
            );
            this._persist();
            return true;
        } catch (e) {
            // UNIQUE(name, workspace_id) constraint violation — project already exists
            return false;
        }
    });
}

public async deleteProject(workspaceId: string, projectName: string): Promise<boolean> {
    if (!(await this.ensureReady()) || !this._db) return false;
    return this._write(async () => {
        this._db!.run(
            'DELETE FROM projects WHERE workspace_id = ? AND name = ?',
            [workspaceId, projectName]
        );
        // Clear project field from all plans with this project
        this._db!.run(
            "UPDATE plans SET project = '' WHERE workspace_id = ? AND project = ?",
            [workspaceId, projectName]
        );
        this._persist();
        return true;
    });
}

public async assignPlansToProject(
    planIds: string[],
    projectName: string,
    workspaceId: string
): Promise<boolean> {
    if (!(await this.ensureReady()) || !this._db || planIds.length === 0) return false;
    return this._write(async () => {
        for (const planId of planIds) {
            this._db!.run(
                "UPDATE plans SET project = ? WHERE plan_id = ? AND workspace_id = ?",
                [projectName, planId, workspaceId]
            );
        }
        this._persist();
        return true;
    });
}

public async getBoardFilteredByProject(
    workspaceId: string,
    project: string | null,
    repoScope: string | null
): Promise<KanbanPlanRecord[]> {
    if (!(await this.ensureReady()) || !this._db) return [];
    // Build query dynamically — AND logic for both filters
    if (!project && !repoScope) {
        return this.getBoard(workspaceId);
    }
    let sql = `SELECT ${PLAN_COLUMNS} FROM plans WHERE workspace_id = ? AND status = 'active'`;
    const params: unknown[] = [workspaceId];
    if (project) {
        sql += ' AND project = ?';
        params.push(project);
    }
    if (repoScope) {
        sql += ' AND repo_scope IN (?, \'\')';
        params.push(repoScope);
    }
    sql += ' ORDER BY updated_at DESC';
    const stmt = this._db.prepare(sql, params);
    return this._readRows(stmt);
}
```

> Clarification: Check that `_write()` and `_persist()` exist as the internal write-gate pattern used throughout KanbanDatabase. If the pattern uses a different write-queue method, adapt accordingly. Look at existing write methods (e.g., `deletePlan()`) for the exact internal pattern.

---

### 2. Backend — KanbanProvider.ts

#### [MODIFY] [KanbanProvider.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts)

**Step 2.1 — Add `_projectFilter` field** (near line 136, beside `_repoScopeFilter`):
```typescript
private _projectFilter: string | null = null;
```

**Step 2.2 — Add `getProjectFilter()` and `setProjectFilter()` methods** (near `getRepoScopeFilter()` at line ~3619):
```typescript
public getProjectFilter(): string | null {
    return this._projectFilter;
}

public setProjectFilter(filter: string | null): void {
    this._projectFilter = filter;
}
```

**Step 2.3 — Update all three `updateWorkspaceSelection` postMessage calls** (lines 991, 1721, 1842) to include `projectFilter`:
```typescript
this._panel.webview.postMessage({
    type: 'updateWorkspaceSelection',
    workspaceRoot: resolvedWorkspaceRoot,
    workspaces: workspaceItems,
    activeFilter: this._repoScopeFilter || null,
    projectFilter: this._projectFilter || null   // NEW
});
```

**Step 2.4 — Add message handlers** in the `handleMessage` switch-case (add alongside existing repoScope filter handler, around line 4151):
```typescript
case 'addProject': {
    // 'prompt()' is blocked in VS Code webviews — use showInputBox() on the backend
    const projectName = await vscode.window.showInputBox({
        prompt: 'Enter project name',
        placeHolder: 'e.g. frontend, backend, infrastructure',
        validateInput: (v) => v.trim() ? null : 'Project name cannot be empty'
    });
    if (projectName?.trim()) {
        const workspaceId = await this._readWorkspaceId(workspaceRoot);
        if (workspaceId) {
            const db = this._getKanbanDb(workspaceRoot);
            await db.addProject(workspaceId, projectName.trim());
            await this._refreshBoard(workspaceRoot);
        }
    }
    break;
}

case 'deleteProject': {
    if (typeof message.projectName === 'string') {
        // Reset filter if we're deleting the currently active project
        if (this._projectFilter === message.projectName) {
            this._projectFilter = null;
        }
        const workspaceId = await this._readWorkspaceId(workspaceRoot);
        if (workspaceId) {
            const db = this._getKanbanDb(workspaceRoot);
            await db.deleteProject(workspaceId, message.projectName);
            await this._refreshBoard(workspaceRoot);
        }
    }
    break;
}

case 'setProjectFilter': {
    if (message.project === null || typeof message.project === 'string') {
        this.setProjectFilter(message.project || null);
        await this._refreshBoard(workspaceRoot);
    }
    break;
}

case 'assignSelectedToProject': {
    if (typeof message.projectName === 'string' && Array.isArray(message.planIds)) {
        const workspaceId = await this._readWorkspaceId(workspaceRoot);
        if (workspaceId) {
            const db = this._getKanbanDb(workspaceRoot);
            await db.assignPlansToProject(message.planIds, message.projectName, workspaceId);
            await this._refreshBoard(workspaceRoot);
        }
    }
    break;
}
```
> Note: Use `planIds` (DB plan_id) not `sessionIds` — `assignPlansToProject()` queries by `plan_id`. In kanban.html, the `selectedCards` Set contains `planId` values (verify by checking what `selectedCards.add(pid)` uses — confirm it's `planId` not `sessionId`).

---

### 3. Backend — TaskViewerProvider.ts

#### [MODIFY] [TaskViewerProvider.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts)

**Step 3.1 — Thread `projectFilter` through `_refreshRunSheets()`** (lines 13237–13244):

Replace:
```typescript
// ONE DB read — this snapshot feeds both sidebar and kanban
const repoScope = this._kanbanProvider?.getRepoScopeFilter() ?? null;
const activeRows = repoScope
    ? await db.getBoardFiltered(workspaceId, repoScope)
    : await db.getBoard(workspaceId);
const completedRows = repoScope
    ? await db.getCompletedPlansFiltered(workspaceId, repoScope)
    : await db.getCompletedPlans(workspaceId);
```

With:
```typescript
// ONE DB read — this snapshot feeds both sidebar and kanban
const repoScope = this._kanbanProvider?.getRepoScopeFilter() ?? null;
const projectFilter = this._kanbanProvider?.getProjectFilter() ?? null;

const activeRows = (repoScope || projectFilter)
    ? await db.getBoardFilteredByProject(workspaceId, projectFilter, repoScope)
    : await db.getBoard(workspaceId);
const completedRows = repoScope
    ? await db.getCompletedPlansFiltered(workspaceId, repoScope)
    : await db.getCompletedPlans(workspaceId);
// Note: completedRows do not participate in project filtering for now (completed plans are archive)
```

**Step 3.2 — Fetch projects and include in `updateWorkspaceSelection` message**: After the DB read above, also fetch the project list:
```typescript
const projects = await db.getProjects(workspaceId);
```
Then when `_kanbanProvider?.refreshWithData()` is called (line 13254), pass the projects list separately via a postMessage in KanbanProvider's `refreshWithData()` / `_refreshBoardWithData()` pipeline:
```typescript
// In _refreshBoardWithData (or _refreshBoardImpl), after the updateWorkspaceSelection postMessage:
this._panel.webview.postMessage({
    type: 'updateWorkspaceSelection',
    workspaceRoot: resolvedWorkspaceRoot,
    workspaces: workspaceItems,
    activeFilter: this._repoScopeFilter || null,
    projectFilter: this._projectFilter || null,
    projects: []   // populated below
});
```
> Clarification: The cleanest approach is to fetch `projects` in `TaskViewerProvider._refreshRunSheets()` and pass it to `kanbanProvider.refreshWithData(activeRows, completedRows, resolvedWorkspaceRoot, projects)`. Then `_refreshBoardWithData` receives `projects` and includes it in `updateWorkspaceSelection`. This avoids a separate DB call in KanbanProvider. Alternatively, fetch in `_refreshBoardImpl()`/`_refreshBoardWithData()` directly.

---

### 4. Frontend UI — kanban.html

#### [MODIFY] [kanban.html](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html)

**Step 4.1 — Add CSS** (after `.controls-strip` block, around line 140):
```css
.project-strip {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 16px;
    border-bottom: 1px solid var(--border-color);
    background: var(--panel-bg2);
}

.project-select {
    background: #0a0a0a;
    color: var(--text-primary);
    border: 1px solid var(--border-color);
    border-radius: 2px;
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.5px;
    padding: 4px 8px;
    min-width: 150px;
}

.project-select:focus {
    outline: none;
    border-color: var(--accent-teal-dim);
}
```
> **Bug fix**: The original plan had a typo: `color: var--text-primary)` (missing opening paren). Corrected above.

**Step 4.2 — Add project strip HTML** (after `.controls-strip` div, around line 1877):
```html
<div class="project-strip" id="project-strip">
    <select id="project-select" class="project-select" title="Filter by project">
        <option value="">All Projects</option>
    </select>
    <button id="btn-add-project" class="strip-btn" title="Add new project">+ ADD PROJECT</button>
    <button id="btn-assign-project" class="strip-btn" title="Assign selected plans to project" disabled>ASSIGN TO PROJECT</button>
    <button id="btn-delete-project" class="strip-btn" title="Delete selected project" style="display:none;">DELETE PROJECT</button>
    <span id="project-filter-badge" class="workspace-filter-badge" hidden></span>
</div>
```

**Step 4.3 — Add JavaScript event handlers** (in the script section, around `selectedCards` declaration at line 2912). Define helpers:
```javascript
// Project strip elements
const projectSelect = document.getElementById('project-select');
const btnAddProject = document.getElementById('btn-add-project');
const btnAssignProject = document.getElementById('btn-assign-project');
const btnDeleteProject = document.getElementById('btn-delete-project');
const projectFilterBadge = document.getElementById('project-filter-badge');

function updateProjectDropdown(projects, activeProjectFilter) {
    if (!projectSelect) return;
    const currentValue = activeProjectFilter || projectSelect.value;
    projectSelect.innerHTML = '<option value="">All Projects</option>';
    (projects || []).forEach(p => {
        const opt = document.createElement('option');
        opt.value = p;
        opt.textContent = p;
        projectSelect.appendChild(opt);
    });
    // Restore selection
    if (currentValue && [...projectSelect.options].some(o => o.value === currentValue)) {
        projectSelect.value = currentValue;
    } else {
        projectSelect.value = '';
    }
    // Show delete button only when a real project is selected
    if (btnDeleteProject) {
        btnDeleteProject.style.display = projectSelect.value ? '' : 'none';
    }
}

projectSelect?.addEventListener('change', () => {
    const selectedProject = projectSelect.value || null;
    vscode.postMessage({ type: 'setProjectFilter', project: selectedProject });
    if (btnDeleteProject) {
        btnDeleteProject.style.display = selectedProject ? '' : 'none';
    }
});

btnAddProject?.addEventListener('click', () => {
    // Do NOT use prompt() — it is blocked in VS Code webviews.
    // Send message to backend which calls vscode.window.showInputBox()
    vscode.postMessage({ type: 'addProject' });
});

btnAssignProject?.addEventListener('click', () => {
    const selectedProject = projectSelect?.value;
    if (!selectedProject) {
        // Show visual feedback — no vscode.window.alert in webviews
        return;
    }
    if (selectedCards.size === 0) {
        return;
    }
    // selectedCards contains planId values
    vscode.postMessage({
        type: 'assignSelectedToProject',
        projectName: selectedProject,
        planIds: Array.from(selectedCards)
    });
});

btnDeleteProject?.addEventListener('click', () => {
    const selectedProject = projectSelect?.value;
    if (!selectedProject) return;
    vscode.postMessage({ type: 'deleteProject', projectName: selectedProject });
});
```

**Step 4.4 — Enable/disable "Assign" button based on card selection**: In the existing card selection handler (around line 3956–3960), after `selectedCards.add(pid)` / `selectedCards.delete(pid)`, update the assign button:
```javascript
if (btnAssignProject) {
    btnAssignProject.disabled = selectedCards.size === 0;
}
```

**Step 4.5 — Merge `updateWorkspaceSelection` handling** into the existing `window.addEventListener('message', ...)` switch-case (around line 3105). In the **existing** `case 'updateWorkspaceSelection':` block, add project handling:
```javascript
// Inside existing case 'updateWorkspaceSelection':
if (message.projects !== undefined) {
    updateProjectDropdown(message.projects, message.projectFilter || null);
}
if (message.projectFilter) {
    projectFilterBadge.textContent = 'PROJECT: ' + message.projectFilter;
    projectFilterBadge.hidden = false;
} else {
    projectFilterBadge.hidden = true;
}
```

## Verification Plan

### Manual Testing
1. Open kanban.html — verify project strip appears below the controls strip
2. Click "+ ADD PROJECT" → VS Code input box appears → enter "frontend" → project appears in dropdown
3. Click on cards to select them (reusing existing multi-select)
4. Select "frontend" from dropdown and click "ASSIGN TO PROJECT"
5. Verify cards are tagged with project (check DB: `SELECT plan_id, project FROM plans`)
6. Select "frontend" in dropdown → verify board filters to show only frontend plans
7. Filter badge shows "PROJECT: frontend"
8. Select "All Projects" → verify all plans show; badge hides
9. Add "backend" project → verify both appear in dropdown
10. Select "frontend" → click "DELETE PROJECT" → verify removed from dropdown and plans cleared
11. Test with repoScope filter active — verify both filters work together (AND logic)

### Automated Tests
- Unit test `getProjects()`, `addProject()`, `deleteProject()`, `assignPlansToProject()` in KanbanDatabase
- Unit test `getBoardFilteredByProject()` with (a) project only, (b) repoScope only, (c) both filters combined
- Test V23 migration idempotency: run twice, verify no errors
- Verify `PLAN_COLUMNS` includes `project` and `_readRows()` maps it correctly

## Risks
- **`PLAN_COLUMNS` / `_readRows()` omission**: If `project` is missing from either, `getBoardFilteredByProject()` returns rows with `project: ''` even when DB has real values — silent data loss
- **`UPSERT_PLAN_SQL` parameter count**: Adding `project` shifts all subsequent positional `?` parameters — must count carefully and update all callers
- **Primary refresh chain**: If project filter isn't threaded through `TaskViewerProvider._refreshRunSheets()`, filtering will appear to have no effect since `_refreshBoardImpl()` is bypassed
- **`selectedCards` content type**: Confirm whether `selectedCards` stores `planId` or `sessionId` before wiring `assignSelectedToProject` handler

## Recommendation
Complexity 6 → **Send to Coder**
