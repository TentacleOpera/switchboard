# Planning Tab UX Improvements

## Goal

Fix three UX issues in the Kanban Plans tab: illogical dropdown order, incomplete status options, and backend IDs shown instead of user-friendly labels.

## Metadata

- **Tags:** [frontend, UX, UI]
- **Complexity:** 5

## User Review Required

- Confirm that keeping the `column` terminology (not renaming to `status`) is acceptable, since the backend uses `column` throughout (`plan.column`, `r.kanbanColumn`, `kanbanColumn` in DB).
- Confirm that kind-based badge colors (grouping columns by their `kind` field) is acceptable vs. per-column unique colors.

## Complexity Audit

### Routine
- Reordering HTML `<select>` elements in the controls strip (lines 1652-1665)
- Replacing hardcoded `<option>` elements with a dynamic dropdown populated from data
- Adding a new JS function (`updateKanbanColumnFilter`) to populate the dropdown
- Updating the badge rendering to use column labels instead of IDs
- Updating the badge CSS to use kind-based classes instead of per-column classes

### Complex / Risky
- PlanningPanelProvider needs column definitions but has no access to TaskViewerProvider; must import `buildKanbanColumns` from `agentConfig.ts` and read `.switchboard/state.json` directly to resolve custom columns — this duplicates the state-file reading pattern from TaskViewerProvider
- Multi-workspace column merging: each workspace root may have different custom columns; must aggregate unique `{id, label}` pairs across all roots, deduplicating by `id`

## Edge-Case & Dependency Audit

- **Race Conditions:** None — the column dropdown is populated synchronously from data already received in `kanbanPlansReady`; no async gap.
- **Security:** Column labels come from the backend (state.json / DEFAULT_KANBAN_COLUMNS), not user input in the webview. Labels are still escaped via `escapeHtml()` before rendering.
- **Side Effects:** None — this is a read-only UI change. No mutations to kanban data or column definitions.
- **Dependencies & Conflicts:** `buildKanbanColumns` from `agentConfig.ts` is already exported and used by TaskViewerProvider. No new dependencies introduced. The `parseCustomKanbanColumns` helper in TaskViewerProvider is private; PlanningPanelProvider will need to inline or duplicate the parsing logic (it's ~10 lines of validation).

## Dependencies

None.

## Adversarial Synthesis

Key risks: PlanningPanelProvider lacks column-definition access (must import `buildKanbanColumns` and read state.json directly, duplicating TaskViewerProvider logic); multi-workspace custom columns must be merged by `id` to avoid duplicates in the dropdown; badge colors must use kind-based grouping to cover all 12+ columns without per-column CSS explosion. Mitigations: the state-file reading is a small, stable pattern; merging by `id` is simple and correct; kind-based colors reduce CSS from N classes to 5.

## Problem Statement

The Kanban Plans tab in planning.html has three UX issues:

1. **Dropdown order is illogical**: The columns picker dropdown comes first, but it's the most specific filter. The order should be: workspace → project → column → search (general to specific).

2. **Column dropdown shows incomplete columns**: The column filter dropdown only shows 4 hardcoded columns (CREATED, CODED, PLAN REVIEWED, COMPLETED), but the actual kanban board has many more columns defined in DEFAULT_KANBAN_COLUMNS (New, Researcher, Planned, Splitter, Context Gatherer, Lead Coder, Coder, Intern, Reviewed, Acceptance Tested, Ticket Updater, Completed) plus any custom columns.

3. **Backend names instead of frontend labels**: The dropdown options and status labels in the tab use backend column IDs (e.g., "CREATED", "PLAN REVIEWED") instead of user-friendly frontend labels (e.g., "New", "Planned").

## Solution

### File: `src/webview/planning.html`

**Change 1: Reorder dropdown elements (lines 1652-1665)**

Current order:
```html
<select id="kanban-column-filter">...</select>
<select id="kanban-workspace-filter">...</select>
<select id="kanban-project-filter">...</select>
<input type="text" id="kanban-search" placeholder="Search plans..." />
```

New order:
```html
<select id="kanban-workspace-filter">...</select>
<select id="kanban-project-filter">...</select>
<select id="kanban-column-filter">...</select>
<input type="text" id="kanban-search" placeholder="Search plans..." />
```

Note: Keep the element ID as `kanban-column-filter` (not `kanban-status-filter`) to maintain consistency with the backend `column` terminology used throughout the codebase (`plan.column`, `r.kanbanColumn`, `kanbanColumn` in DB).

**Change 2: Replace hardcoded column options with dynamic placeholder (lines 1652-1658)**

Remove the hardcoded options from the column dropdown:
```html
<select id="kanban-column-filter">
    <option value="">All Columns</option>
    <!-- Options populated dynamically from kanban columns -->
</select>
```

**Change 3: Replace per-column badge CSS with kind-based badge CSS (lines 1376-1379)**

Replace the 4 per-column CSS classes:
```css
.kanban-col-created  { background: rgba(99,  130, 190, 0.25); color: #8ab4f8; }
.kanban-col-coded    { background: rgba(255, 167,  38, 0.20); color: #ffc661; }
.kanban-col-reviewed { background: rgba(160, 100, 220, 0.25); color: #ce93d8; }
.kanban-col-completed{ background: rgba( 67, 160,  71, 0.25); color: #81c784; }
```

With 5 kind-based CSS classes that cover all 12+ built-in columns plus any custom columns:
```css
.kanban-badge-created   { background: rgba(99,  130, 190, 0.25); color: #8ab4f8; }   /* kind: created, gather */
.kanban-badge-review    { background: rgba(160, 100, 220, 0.25); color: #ce93d8; }   /* kind: review, custom-agent, custom-user */
.kanban-badge-coded     { background: rgba(255, 167,  38, 0.20); color: #ffc661; }   /* kind: coded */
.kanban-badge-reviewed  { background: rgba(200, 120, 120, 0.25); color: #e0a0a0; }   /* kind: reviewed */
.kanban-badge-completed { background: rgba( 67, 160,  71, 0.25); color: #81c784; }   /* kind: completed */
```

Kind-to-badge mapping (used in JS):
| kind | CSS class | Columns covered |
|------|-----------|----------------|
| `created` | `kanban-badge-created` | CREATED ("New") |
| `gather` | `kanban-badge-created` | CONTEXT GATHERER |
| `review` | `kanban-badge-review` | RESEARCHER, PLAN REVIEWED, SPLITTER |
| `coded` | `kanban-badge-coded` | LEAD CODED, CODER CODED, INTERN CODED |
| `reviewed` | `kanban-badge-reviewed` | CODE REVIEWED, ACCEPTANCE TESTED, TICKET UPDATER |
| `completed` | `kanban-badge-completed` | COMPLETED |
| `custom-agent` | `kanban-badge-review` | Custom agent columns |
| `custom-user` | `kanban-badge-review` | Custom user columns |

### File: `src/webview/planning.js`

**Change 1: Add column definition cache (after line 2169)**

Add a new cache variable for column definitions received from the backend:
```javascript
let _kanbanAvailableColumns = [];  // { id, label, kind }[] — merged across workspaces
```

**Change 2: Update badge class mapping to use kind-based classes (lines 2233-2238)**

Replace the hardcoded 4-column badge mapping:
```javascript
const badgeClass = {
    'CREATED': 'kanban-col-created',
    'CODED': 'kanban-col-coded',
    'PLAN REVIEWED': 'kanban-col-reviewed',
    'COMPLETED': 'kanban-col-completed'
}[plan.column] || 'kanban-col-created';
```

With a kind-based lookup:
```javascript
const columnDef = _kanbanAvailableColumns.find(c => c.id === plan.column);
const kind = columnDef?.kind || 'created';
const badgeClass = {
    created: 'kanban-badge-created',
    gather: 'kanban-badge-created',
    review: 'kanban-badge-review',
    coded: 'kanban-badge-coded',
    reviewed: 'kanban-badge-reviewed',
    completed: 'kanban-badge-completed',
    'custom-agent': 'kanban-badge-review',
    'custom-user': 'kanban-badge-review'
}[kind] || 'kanban-badge-created';
```

**Change 3: Use column label instead of ID in badge display (line 2254)**

Replace:
```html
<span class="kanban-column-badge ${badgeClass}">${escapeHtml(plan.column)}</span>
```

With:
```html
<span class="kanban-column-badge ${badgeClass}">${escapeHtml(columnDef ? columnDef.label : plan.column)}</span>
```

This uses the frontend label (e.g., "New", "Planned") when available, falling back to the raw column ID.

**Change 4: Add function to populate column dropdown from kanban columns (after line 2347)**

Add a new function after `updateKanbanProjectFilter()`:
```javascript
function updateKanbanColumnFilter() {
    if (!kanbanColumnFilter) return;

    const currentColumn = kanbanFilters.column;
    kanbanColumnFilter.innerHTML = '<option value="">All Columns</option>';

    _kanbanAvailableColumns.forEach(col => {
        const opt = document.createElement('option');
        opt.value = col.id;       // Use backend ID for filtering
        opt.textContent = col.label;  // Use frontend label for display
        if (col.id === currentColumn) opt.selected = true;
        kanbanColumnFilter.appendChild(opt);
    });
}
```

**Change 5: Update handleKanbanPlansReady to store columns and populate filter (lines 2349-2362)**

Add column data to the state and populate the column filter:
```javascript
function handleKanbanPlansReady(msg) {
    if (msg.error) {
        if (kanbanListPane) {
            kanbanListPane.innerHTML = `<div class="kanban-empty-state" style="color: var(--vscode-errorForeground, #ff6b6b);">Error loading plans: ${escapeHtml(msg.error)}</div>`;
        }
        return;
    }

    _kanbanPlansCache = msg.plans || [];
    _kanbanWorkspaceItems = msg.workspaceItems || [];
    _kanbanAllWorkspaceProjects = msg.allWorkspaceProjects || {};
    _kanbanAvailableColumns = msg.columns || [];  // NEW: store available columns

    populateKanbanFilters();
    updateKanbanColumnFilter();  // NEW: populate column dropdown
    renderKanbanPlans(_kanbanPlansCache, kanbanFilters);
}
```

### File: `src/services/PlanningPanelProvider.ts`

**Change 1: Import column-building utilities (near top of file)**

Add imports:
```typescript
import { buildKanbanColumns, KanbanColumnDefinition, CustomKanbanColumnConfig, CustomAgentConfig } from './agentConfig';
```

**Change 2: Add helper to read custom columns from state file (new private method)**

Add a method that reads `.switchboard/state.json` to get custom kanban columns and custom agents, mirroring the pattern from TaskViewerProvider:
```typescript
private async _getKanbanColumnDefinitions(workspaceRoot: string): Promise<KanbanColumnDefinition[]> {
    const statePath = path.join(workspaceRoot, '.switchboard', 'state.json');
    let customAgents: CustomAgentConfig[] = [];
    let customKanbanColumns: CustomKanbanColumnConfig[] = [];
    try {
        const content = await fs.promises.readFile(statePath, 'utf8');
        const state = JSON.parse(content);
        // Parse custom agents (same shape as TaskViewerProvider)
        if (Array.isArray(state.customAgents)) {
            customAgents = state.customAgents.filter((a: any) => a && a.role && a.name);
        }
        // Parse custom kanban columns (same shape as TaskViewerProvider)
        if (Array.isArray(state.customKanbanColumns)) {
            customKanbanColumns = state.customKanbanColumns.filter((c: any) => c && c.id && c.label);
        }
    } catch {
        // No state file or parse error — use defaults
    }
    return buildKanbanColumns(customAgents, customKanbanColumns);
}
```

**Change 3: Include column definitions in fetchKanbanPlans response (lines 992-1045)**

In the `fetchKanbanPlans` handler, after collecting plans from all roots, also collect column definitions and merge them:

```typescript
case 'fetchKanbanPlans': {
    const requestId = typeof msg.requestId === 'number' ? msg.requestId : 0;
    const guardKey = 'kanban-plans';
    if (requestId <= (this._latestRequestIds.get(guardKey) || 0)) { break; }
    this._latestRequestIds.set(guardKey, requestId);
    try {
        const allRoots = this._getWorkspaceRoots();
        const allPlans: any[] = [];
        const seenIds = new Set<string>();
        const allWorkspaceProjects: Record<string, string[]> = {};
        const mergedColumns: { id: string; label: string; kind: string }[] = [];
        const seenColumnIds = new Set<string>();

        // Build workspaceItems using VSCode folder names (not path.basename)
        const workspaceItems = allRoots.map(root => {
            const resolvedRoot = path.resolve(root);
            const folder = (vscode.workspace.workspaceFolders || []).find(
                f => path.resolve(f.uri.fsPath) === resolvedRoot
            );
            return {
                workspaceRoot: resolvedRoot,
                label: folder ? folder.name : path.basename(root)
            };
        });

        for (const root of allRoots) {
            try {
                const plans = await this._getKanbanPlans(root);
                for (const p of plans) {
                    if (!seenIds.has(p.planId)) {
                        seenIds.add(p.planId);
                        allPlans.push(p);
                    }
                }
                // Fetch projects for this workspace
                const { KanbanDatabase } = require('./KanbanDatabase');
                const db = KanbanDatabase.forWorkspace(root);
                const workspaceId = await this._getWorkspaceId(root);
                allWorkspaceProjects[path.resolve(root)] = await db.getProjects(workspaceId);

                // Fetch column definitions for this workspace and merge
                const colDefs = await this._getKanbanColumnDefinitions(root);
                for (const col of colDefs) {
                    if (!seenColumnIds.has(col.id)) {
                        seenColumnIds.add(col.id);
                        mergedColumns.push({ id: col.id, label: col.label, kind: col.kind });
                    }
                }
            } catch (err) { /* root has no kanban DB, skip */ }
        }
        if (requestId !== this._latestRequestIds.get(guardKey)) { break; }
        allPlans.sort((a, b) => b.mtime - a.mtime);
        mergedColumns.sort((a, b) => a.id.localeCompare(b.id));
        this._panel?.webview.postMessage({
            type: 'kanbanPlansReady',
            plans: allPlans,
            workspaceItems,
            allWorkspaceProjects,
            columns: mergedColumns,  // NEW: include column definitions
            requestId
        });
    } catch (err) {
        if (requestId === this._latestRequestIds.get(guardKey)) {
            this._panel?.webview.postMessage({ type: 'kanbanPlansReady', plans: [], columns: [], requestId, error: String(err) });
        }
    }
    break;
}
```

The `mergedColumns` array aggregates all unique column definitions across workspaces, deduplicating by `id` (first label wins). This ensures the dropdown shows all columns that any plan could be in, including custom columns from any workspace.

## Verification Plan

### Automated Tests

- No automated tests exist for the planning webview. Manual verification required.

### Manual Verification Steps

1. Open the Planning panel and switch to the Kanban Plans tab
2. Verify dropdown order is: workspace → project → column → search
3. Verify column dropdown shows all kanban columns with frontend labels (e.g., "New", "Planned", "Reviewed", "Completed", "Lead Coder", "Coder", "Intern", "Researcher", "Splitter", "Context Gatherer", "Acceptance Tested", "Ticket Updater")
4. Verify column dropdown includes custom columns if they exist in any workspace
5. Verify filtering by column works correctly (select "New" → only CREATED plans shown)
6. Verify column badges in the plan list use frontend labels instead of backend IDs (e.g., "New" instead of "CREATED")
7. Verify badge colors are kind-based: created/gather = blue, review = purple, coded = orange, reviewed = pink, completed = green
8. Verify the "All Columns" option shows all plans regardless of column
9. Verify multi-workspace setup: if workspace A has custom columns and workspace B doesn't, the dropdown shows the union of all columns

## Notes

- The column ID is still used for filtering logic (backend), but the label is used for display (frontend)
- This maintains data integrity while improving UX
- Custom columns will automatically appear in the dropdown because `buildKanbanColumns` includes custom agent and custom user columns
- The `kind` field on `KanbanColumnDefinition` enables kind-based badge coloring without per-column CSS classes
- Keeping `column` terminology (not renaming to `status`) maintains consistency with the backend data model
- The `_getKanbanColumnDefinitions` helper in PlanningPanelProvider duplicates some state-file reading logic from TaskViewerProvider, but this is a small, stable pattern that avoids constructor changes

## Recommendation

Complexity 5 → **Send to Coder**
