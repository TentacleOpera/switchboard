# Kanban Plans Visibility

## Goal

Add a "KANBAN PLANS" tab to the ARTIFACTS panel (`planning.html`) that displays all active kanban plans with their current column, workspace, project, repo scope, and timestamp, and provides quick actions: open the plan file, set it as the active planning context, and preview its markdown content inline. Supports filtering by column, workspace, project, repo scope, and free-text search across all kanban databases in the open workspace.

## Metadata

**Tags:** frontend, backend, UI, UX
**Complexity:** 7

## User Review Required

> [!IMPORTANT]
> **Active context key**: Setting a kanban plan as "active context" will write its `plan_file` path to `switchboard.planner.designDocLink` (same VS Code config key used by local/online docs). Confirm this is the intended behaviour, or a separate config key should be used.

> [!NOTE]
> **Columns are hardcoded**: The kanban column names (`CREATED`, `CODED`, `PLAN REVIEWED`, `COMPLETED`) are hardcoded in the DB schema — there is no DB query for column list. The webview will use a static constant for column filter options.

## Complexity Audit

### Routine
- Adding a new tab button and content container to `planning.html` (follows existing pattern)
- CSS for plan cards/badges following existing dark-theme patterns
- Message handlers `fetchKanbanPlans` and `openKanbanPlan` in `PlanningPanelProvider.ts` using the existing `KanbanDatabase.forWorkspace()` pattern
- Rendering and filter logic in `planning.js` following existing local-folder patterns
- Active context banner (copy of existing local/online banner structure)
- Project and repo scope filter dropdowns populated dynamically from fetched plan data

### Complex / Risky
- Race condition on rapid workspace switching: `fetchKanbanPlans` must use the existing `_latestRequestIds` Map guard (same pattern as `fetchFilteredDocs`)
- Preview pane reads local plan files directly (`fs.promises.readFile`); must handle the case where `plan_file` is empty/missing or the file no longer exists
- `setKanbanPlanContext` writes to VS Code workspace config — must be workspace-scoped, not global
- Workspace filter must use the **full workspace root path** as the filter key internally, only displaying `path.basename(root)` as the label — otherwise two repos with the same folder name (e.g. both called `my-app`) would collide in the dropdown
- Project filter values come from live plan data, not a static list; empty-string project values must be grouped under a `(No Project)` label rather than shown as blank options

## Edge-Case & Dependency Audit

### Race Conditions
- **`fetchKanbanPlans` rapid re-trigger**: Use `_latestRequestIds` with key `'kanban-plans'` identical to `fetchFilteredDocs` pattern (lines 641–673 of `PlanningPanelProvider.ts`). Drop stale responses by comparing `requestId`.

### Security
- Plan file paths come from the kanban DB (`plan_file` column). Before calling `fs.promises.readFile`, validate that the path exists within a known workspace root to prevent path traversal. Use `path.resolve()` and check it starts with a workspace root.

### Side Effects
- `setKanbanPlanContext` updates `switchboard.planner.designDocLink` and `switchboard.planner.designDocEnabled` workspace config. This will immediately change the active doc for all planner prompts — same side effect as the existing "set active context" feature on other tabs. No new risk.
- Opening the plan file calls `vscode.workspace.openTextDocument` + `vscode.window.showTextDocument`. No side effects beyond focusing editor.

### Dependencies & Conflicts
- `KanbanDatabase.forWorkspace(workspaceRoot)` is a singleton-per-root. No conflict with `KanbanProvider` holding its own instances — they share the same `_instances` Map.
- No new npm dependencies required.

## Dependencies

- No blocking plan dependencies identified.

## Adversarial Synthesis

Key risks: (1) stale `fetchKanbanPlans` responses if the user rapid-switches workspaces — mitigated by the `_latestRequestIds` guard; (2) `plan_file` paths may be empty or point to deleted files — mitigated by explicit existence check before reading; (3) active-context side effect on `planner.designDocLink` — pre-existing risk, already accepted by the system design. The Phase 9 "Workspace Switching" and Phase 10 "Testing" from the original plan have been collapsed into the design (filtering is per-workspace via the workspace field already on `KanbanPlanRecord`; tests moved to Verification).

## Problem

The ARTIFACTS view (planning.html) has no integration with the kanban system. Users cannot view their kanban plans, see their current status, or access plan files directly from the planning panel. This creates a disconnect between planning artifacts and execution tracking.

## Solution

Add a new "KANBAN PLANS" tab to the ARTIFACTS view that displays all kanban plans with their current status, workspace assignment, and provides quick access to plan files.

## Implementation Plan

### Phase 1: Backend — `_getKanbanPlans` helper

- **File**: `src/services/PlanningPanelProvider.ts`
- **No constructor changes needed** — `KanbanDatabase` is accessed via `KanbanDatabase.forWorkspace(workspaceRoot)` directly, identical to the existing `_getWorkspaceId()` pattern (line 1475).
- Add private method `_getKanbanPlans(workspaceRoot: string): Promise<Array<KanbanPlanSummary>>` where `KanbanPlanSummary` is a local interface defined above the class:
  ```typescript
  interface KanbanPlanSummary {
      planId: string;
      topic: string;
      column: string;
      workspaceRoot: string;  // full absolute path — used as filter key
      workspaceLabel: string; // path.basename(workspaceRoot) — displayed in UI
      project: string;        // '' if no project
      repoScope: string;      // '' if no repo scope
      mtime: number;
      planFile: string;
  }
  ```
  ```typescript
  private async _getKanbanPlans(workspaceRoot: string): Promise<KanbanPlanSummary[]> {
      const { KanbanDatabase } = require('./KanbanDatabase');
      const db = KanbanDatabase.forWorkspace(workspaceRoot);
      const workspaceId = await this._getWorkspaceId(workspaceRoot);
      const records = await db.getBoard(workspaceId);
      return records.map((r: any) => ({
          planId: r.planId,
          topic: r.topic || path.basename(r.planFile || '') || 'Untitled',
          column: r.kanbanColumn,
          workspaceRoot: path.resolve(workspaceRoot),
          workspaceLabel: path.basename(workspaceRoot),
          project: r.project || '',
          repoScope: r.repoScope || '',
          mtime: r.updatedAt ? new Date(r.updatedAt).getTime() : 0,
          planFile: r.planFile || ''
      }));
  }
  ```
- **Multi-workspace**: If multiple workspace roots exist, call `_getKanbanPlans` for each root and merge results. De-duplicate by `planId`. Because `KanbanDatabase.forWorkspace()` redirects child workspaces to a parent DB via `workspaceDatabaseMappings`, the same plan may appear for multiple roots — de-duplication by `planId` handles this correctly.

### Phase 2: Backend — Message Handlers

- **File**: `src/services/PlanningPanelProvider.ts`
- **Add to `_handleMessage` switch** (after the existing `sendToAnalyst` case, before closing brace at line 900):

**`fetchKanbanPlans`** (with `_latestRequestIds` race guard):
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
        for (const root of allRoots) {
            try {
                const plans = await this._getKanbanPlans(root);
                for (const p of plans) {
                    if (!seenIds.has(p.planId)) {
                        seenIds.add(p.planId);
                        allPlans.push(p);
                    }
                }
            } catch { /* root has no kanban DB, skip */ }
        }
        if (requestId !== this._latestRequestIds.get(guardKey)) { break; }
        allPlans.sort((a, b) => b.mtime - a.mtime);
        this._panel?.webview.postMessage({ type: 'kanbanPlansReady', plans: allPlans, requestId });
    } catch (err) {
        if (requestId === this._latestRequestIds.get(guardKey)) {
            this._panel?.webview.postMessage({ type: 'kanbanPlansReady', plans: [], requestId, error: String(err) });
        }
    }
    break;
}
```

**`openKanbanPlan`**:
```typescript
case 'openKanbanPlan': {
    const filePath = msg.filePath;
    if (!filePath || !fs.existsSync(filePath)) {
        this._panel?.webview.postMessage({ type: 'kanbanPlanOpenResult', success: false, error: 'File not found' });
        break;
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
    this._panel?.webview.postMessage({ type: 'kanbanPlanOpenResult', success: true });
    break;
}
```

**`fetchKanbanPlanPreview`** (reads local file, path-traversal guarded):
```typescript
case 'fetchKanbanPlanPreview': {
    const filePath: string = msg.filePath || '';
    const requestId = typeof msg.requestId === 'number' ? msg.requestId : 0;
    const allRoots = this._getWorkspaceRoots();
    const resolved = path.resolve(filePath);
    const isAllowed = allRoots.some(r => resolved.startsWith(path.resolve(r)));
    if (!filePath || !isAllowed || !fs.existsSync(resolved)) {
        this._panel?.webview.postMessage({
            type: 'kanbanPlanPreviewReady', requestId,
            content: '', error: 'File not found or not in workspace'
        });
        break;
    }
    try {
        const content = await fs.promises.readFile(resolved, 'utf8');
        this._panel?.webview.postMessage({ type: 'kanbanPlanPreviewReady', requestId, content });
    } catch (err) {
        this._panel?.webview.postMessage({ type: 'kanbanPlanPreviewReady', requestId, content: '', error: String(err) });
    }
    break;
}
```

**`setKanbanPlanContext`** (writes to same config key as existing local/online tabs):
```typescript
case 'setKanbanPlanContext': {
    const filePath: string = msg.filePath || '';
    if (!filePath || !fs.existsSync(filePath)) {
        this._panel?.webview.postMessage({ type: 'kanbanContextSet', success: false, error: 'File not found' });
        break;
    }
    try {
        await vscode.workspace.getConfiguration('switchboard').update(
            'planner.designDocLink', filePath, vscode.ConfigurationTarget.Workspace
        );
        await vscode.workspace.getConfiguration('switchboard').update(
            'planner.designDocEnabled', true, vscode.ConfigurationTarget.Workspace
        );
        this._panel?.webview.postMessage({ type: 'kanbanContextSet', success: true });
    } catch (err) {
        this._panel?.webview.postMessage({ type: 'kanbanContextSet', success: false, error: String(err) });
    }
    break;
}
```

### Phase 3: UI Structure — New Tab (`planning.html`)

- **File**: `src/webview/planning.html`
- Add tab button after line 1178 (the "RESEARCH" tab button):
  ```html
  <button class="research-tab-btn" data-tab="kanban">KANBAN PLANS</button>
  ```
- Add tab content `<div>` after the `research-content` div (line 1293+):
  ```html
  <div id="kanban-content" class="research-tab-content">
      <!-- Active context banner (same structure as local/online tabs) -->
      <div class="active-doc-banner inactive" id="active-doc-banner-kanban">
          <div class="active-doc-info">
              <span class="active-doc-label">Active Plan:</span>
              <span class="active-doc-name" id="active-doc-name-kanban">None</span>
          </div>
          <button class="btn-disable-doc" id="btn-disable-doc-kanban">Turn off</button>
      </div>
      <!-- Controls strip -->
      <div class="kanban-controls-strip">
          <select id="kanban-column-filter">
              <option value="">All Columns</option>
              <option value="CREATED">Created</option>
              <option value="CODED">Coded</option>
              <option value="PLAN REVIEWED">Plan Reviewed</option>
              <option value="COMPLETED">Completed</option>
          </select>
          <!-- Workspace, project, and repo scope filters are populated dynamically by JS -->
          <select id="kanban-workspace-filter">
              <option value="">All Workspaces</option>
          </select>
          <select id="kanban-project-filter">
              <option value="">All Projects</option>
          </select>
          <select id="kanban-repo-filter">
              <option value="">All Repos</option>
          </select>
          <input type="text" id="kanban-search" placeholder="Search plans..." />
          <button id="kanban-refresh-btn">↻</button>
      </div>
      <!-- Split pane: list + preview -->
      <div class="content-row" id="kanban-content-row">
          <div id="kanban-list-pane">
              <!-- Plan rows rendered by JS -->
          </div>
          <div id="kanban-preview-pane" class="kanban-preview-pane">
              <!-- Markdown preview rendered by JS -->
          </div>
      </div>
  </div>
  ```

### Phase 4: UI Styling (`planning.html` `<style>` block)

- **File**: `src/webview/planning.html`
- Add to existing `<style>` block:
  ```css
  /* Kanban Plans Tab */
  .kanban-controls-strip {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px;
      border-bottom: 1px solid var(--border-color, rgba(255,255,255,0.08));
  }
  .kanban-controls-strip select,
  .kanban-controls-strip input {
      background: var(--input-bg, rgba(255,255,255,0.06));
      border: 1px solid var(--border-color, rgba(255,255,255,0.12));
      color: inherit;
      border-radius: 4px;
      padding: 4px 8px;
      font-size: 12px;
  }
  #kanban-search { flex: 1; }
  #kanban-refresh-btn {
      background: transparent;
      border: 1px solid var(--border-color, rgba(255,255,255,0.12));
      color: inherit;
      border-radius: 4px;
      cursor: pointer;
      padding: 4px 8px;
  }
  #kanban-content-row { display: flex; gap: 0; height: 100%; overflow: hidden; }
  #kanban-list-pane { flex: 1; overflow-y: auto; }
  .kanban-preview-pane { flex: 1; overflow-y: auto; padding: 12px; border-left: 1px solid var(--border-color, rgba(255,255,255,0.08)); }
  .kanban-plan-item {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border-color, rgba(255,255,255,0.06));
      cursor: pointer;
      transition: background 0.15s;
  }
  .kanban-plan-item:hover { background: rgba(255,255,255,0.04); }
  .kanban-plan-item.selected { background: rgba(255,255,255,0.07); }
  .kanban-plan-topic { font-size: 13px; font-weight: 500; flex: 1; }
  .kanban-column-badge {
      font-size: 10px;
      padding: 2px 7px;
      border-radius: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
  }
  .kanban-col-created  { background: rgba(99,  130, 190, 0.25); color: #8ab4f8; }
  .kanban-col-coded    { background: rgba(255, 167,  38, 0.20); color: #ffc661; }
  .kanban-col-reviewed { background: rgba(160, 100, 220, 0.25); color: #ce93d8; }
  .kanban-col-completed{ background: rgba( 67, 160,  71, 0.25); color: #81c784; }
  .kanban-plan-meta { font-size: 11px; opacity: 0.55; }
  .kanban-plan-actions { display: flex; gap: 6px; }
  .kanban-plan-actions button {
      font-size: 11px; padding: 2px 8px;
      border-radius: 4px; cursor: pointer;
      background: rgba(255,255,255,0.07);
      border: 1px solid rgba(255,255,255,0.1);
      color: inherit;
      transition: background 0.1s;
  }
  .kanban-plan-actions button:hover { background: rgba(255,255,255,0.14); }
  .kanban-empty-state { padding: 32px; text-align: center; opacity: 0.5; font-size: 13px; }
  ```

### Phase 5: UI Logic — Plans Rendering (`planning.js`)

- **File**: `src/webview/planning.js`
- Declare a module-level cache at the top of the file:
  ```javascript
  let _kanbanPlansCache = []; // all plans from backend
  ```
- Add function `renderKanbanPlans(plans, filters)`:
  - Filter by:
    - `filters.column` — exact match on `plan.column`
    - `filters.workspaceRoot` — exact match on `plan.workspaceRoot` (full path, not label)
    - `filters.project` — exact match on `plan.project`; `''` means "show all"
    - `filters.repoScope` — exact match on `plan.repoScope`; `''` means "show all"
    - `filters.search` — case-insensitive substring on `plan.topic`
  - Sort by `mtime` descending
  - For each plan build a row. Each row displays: topic, column badge, workspace label, project (if set), repo scope (if set), relative timestamp, and action buttons:
    ```javascript
    const badgeClass = {
        'CREATED': 'kanban-col-created',
        'CODED': 'kanban-col-coded',
        'PLAN REVIEWED': 'kanban-col-reviewed',
        'COMPLETED': 'kanban-col-completed'
    }[plan.column] || 'kanban-col-created';

    const metaParts = [plan.workspaceLabel];
    if (plan.project)   metaParts.push(plan.project);
    if (plan.repoScope) metaParts.push(plan.repoScope);
    // render metaParts.join(' · ') as the .kanban-plan-meta line
    ```
  - Append to `#kanban-list-pane`; show `.kanban-empty-state` div if nothing matches.
- Add function `populateKanbanFilters(plans)` called after `_kanbanPlansCache` is updated:
  - **Workspace filter** (`#kanban-workspace-filter`): collect unique `{ workspaceRoot, workspaceLabel }` pairs. Use `workspaceRoot` as `<option value>` and `workspaceLabel` as display text. This prevents collisions when two roots share a basename.
  - **Project filter** (`#kanban-project-filter`): collect unique non-empty `project` values. Add an `(No Project)` sentinel option with value `'__none__'` that, when selected, filters to plans where `project === ''`.
  - **Repo scope filter** (`#kanban-repo-filter`): collect unique non-empty `repoScope` values. Same sentinel pattern (`'__none__'` → `repoScope === ''`).

### Phase 6: UI Logic — Plan Actions (`planning.js`)

- Click on `.kanban-plan-item` row → send `fetchKanbanPlanPreview` message; mark row as `selected`.
- "Open" button → send `openKanbanPlan` with `filePath`.
- "Set Context" button → send `setKanbanPlanContext` with `filePath`; on `kanbanContextSet` success, update `#active-doc-name-kanban` and remove `inactive` class from `#active-doc-banner-kanban`.
- `#btn-disable-doc-kanban` click → send `disableDesignDoc`; reset banner.
- `#kanban-refresh-btn` click → send `fetchKanbanPlans` with incremented `requestId`.
- Filter controls (`#kanban-column-filter`, `#kanban-workspace-filter`, `#kanban-project-filter`, `#kanban-repo-filter`, `#kanban-search`) → call `renderKanbanPlans(_kanbanPlansCache, currentFilters)` on change; debounce search by 200 ms.
- `currentFilters` object shape:
  ```javascript
  {
      column: '',        // '' = all
      workspaceRoot: '', // '' = all; value is full absolute path
      project: '',       // '' = all; '__none__' = plans with no project
      repoScope: '',     // '' = all; '__none__' = plans with no repo scope
      search: ''
  }
  ```

### Phase 7: UI Logic — Preview Pane (`planning.js`)

- On receiving `kanbanPlanPreviewReady`: render the markdown content into `#kanban-preview-pane` using the **existing** markdown rendering utility already used by local/online tabs (reuse the same `renderMarkdown` / `marked` call).
- If `error` is present on the message, show an inline error message in `#kanban-preview-pane`.
- On tab activation (`data-tab="kanban"`): send `fetchKanbanPlans` with `requestId: Date.now()` to trigger initial load.

### Phase 8: Active Context Banner Sync (`planning.js`)

- When the panel receives `activeDesignDocUpdated` (already dispatched on tab open and on disable), check if the linked doc path is inside a known kanban plan file. If so, reflect the active state in `#active-doc-banner-kanban` as well.
- On receiving `kanbanContextSet { success: true }`: call `_sendActiveDesignDocState()` via message to re-sync all banners. *Clarification*: the backend already has `_sendActiveDesignDocState()` — no new backend code required; JS listens to `activeDesignDocUpdated` message.

### Phase 9: `extension.ts` — No changes required

- `KanbanDatabase.forWorkspace()` is used directly in `_getKanbanPlans` (same as `_getWorkspaceId`). No new wiring in `extension.ts` is needed.

## Files to Modify

- `src/services/PlanningPanelProvider.ts` — Add `_getKanbanPlans()` private method + 4 new message handlers (`fetchKanbanPlans`, `openKanbanPlan`, `fetchKanbanPlanPreview`, `setKanbanPlanContext`)
- `src/webview/planning.html` — New tab button, tab content div, CSS styles
- `src/webview/planning.js` — Plans rendering, filtering, actions, preview pane, active-context sync
- `src/extension.ts` — **No changes required**

## Edge Cases

- No kanban database exists (show "Kanban not initialized" empty state)
- Empty kanban board (show "No plans" empty state)
- Plan file deleted but still in database (show error in preview pane, "Open" button shows file-not-found toast)
- Large number of plans (implement pagination or virtual scrolling)
- Multi-workspace setup (show workspace indicator; workspace filter uses full path as key so same-named repos don't collide)
- Plan with no topic (use `path.basename(planFile)` or "Untitled")
- Plan in archived column (excluded by default — `getBoard()` filters `status = 'active'`)
- Database locked or corrupted (show error message in tab, offer refresh)
- Path traversal on `fetchKanbanPlanPreview`: validate resolved path starts within a known workspace root
- Plans with empty `project` or `repoScope` (shown normally in list; selectable via `(No Project)` / `(No Repo)` sentinel options in filters)
- Two workspace roots share the same `path.basename` (e.g. both called `my-app`): both appear as separate entries in the workspace filter because the `value` attribute uses the full `workspaceRoot` path
- `workspaceDatabaseMappings` active: child workspaces redirect to a shared parent DB; de-duplication by `planId` in `fetchKanbanPlans` prevents double-entries

## Verification Plan

### Manual Verification
- Open ARTIFACTS panel, click "KANBAN PLANS" tab — plans load from kanban DB
- Column filter: select "Created" — only Created plans show
- Workspace filter: select a workspace (by full path key) — only that workspace's plans show
- Project filter: select a project — only plans with that project value show
- Project filter: select "(No Project)" — only plans with empty `project` show
- Repo scope filter: select a repo — only plans with that `repoScope` show
- Search: type partial topic — plans filter live
- Click a plan row — preview pane shows rendered markdown
- Click "Open" — plan file opens in editor beside the panel
- Click "Set Context" — active context banner updates; planner prompt writer picks up the file
- Click "Turn off" — banner resets to inactive
- Click Refresh — list reloads
- Multi-root workspace with two repos named `my-app`: both appear as distinct entries in workspace dropdown
- `workspaceDatabaseMappings` active: no duplicate plan entries despite shared DB
- Open with no DB initialized — show "Kanban not initialized" empty state
- Open with deleted plan file — preview shows error; no crash

### Automated Tests
- Unit tests for `_getKanbanPlans`: mock `KanbanDatabase.forWorkspace()`, verify mapping from `KanbanPlanRecord` to `KanbanPlanSummary` shape (including `project`, `repoScope`, `workspaceRoot`, `workspaceLabel`)
- Unit test for path-traversal guard in `fetchKanbanPlanPreview`
- Unit test for `fetchKanbanPlans` de-duplication: two roots sharing the same DB via `workspaceDatabaseMappings` return each `planId` only once

## Future Enhancements

- Drag and drop plans between columns from the list view
- Bulk actions (move multiple plans, delete multiple plans)
- Plan complexity indicator in list
- Plan dependency visualization
- Link plans to associated tickets/tasks
- Export plans list to CSV/JSON
- Plan history/version view
- Quick edit plan metadata from list view

---

## Review Pass Results (2026-05-26)

### Stage 1: Grumpy Principal Engineer Findings

| ID | Severity | Finding |
|----|----------|---------|
| CRITICAL-1 | CRITICAL | `openKanbanPlan` handler missing path-traversal guard. Only checked `!filePath \|\| !fs.existsSync(filePath)` — no `path.resolve()` + `startsWith` workspace root validation. A corrupted DB entry with `planFile: '/etc/passwd'` would open it in the editor. Plan explicitly requires this guard under Security section. |
| MAJOR-1 | MAJOR | `setKanbanPlanContext` also missing path-traversal guard. Same class of issue — sets `planner.designDocLink` to arbitrary path, which the planner subsequently reads. |
| MAJOR-2 | MAJOR | `openKanbanPlan` used raw `filePath` from message without `path.resolve()`, inconsistent with `fetchKanbanPlanPreview` which correctly resolves. Relative paths like `../../etc/passwd` would pass through. |
| NIT-1 | NIT | `handleKanbanContextSet` re-enables ALL `.kanban-action-context` buttons on success/failure, not just the clicked one. Minor UX issue; defer. |

### Stage 2: Balanced Synthesis

- **Fixed**: CRITICAL-1 + MAJOR-2 → Added `path.resolve()` + `startsWith` workspace root guard to `openKanbanPlan`, matching `fetchKanbanPlanPreview` pattern exactly.
- **Fixed**: MAJOR-1 → Added same path-traversal guard to `setKanbanPlanContext`.
- **Deferred**: NIT-1 (context button re-enable scope) — low impact, existing pattern.

### Files Changed

- `src/services/PlanningPanelProvider.ts` — Added path-traversal guard (`path.resolve()` + `allRoots.some(r => resolved.startsWith(path.resolve(r)))`) to `openKanbanPlan` and `setKanbanPlanContext` handlers. Both now use `resolved` path consistently.

### Validation Results

- TypeScript: `npx tsc --noEmit` — 0 new errors in modified file. 2 pre-existing errors in unrelated files (`ClickUpSyncService.ts`, `KanbanProvider.ts`).
- All three kanban file-access handlers (`fetchKanbanPlanPreview`, `openKanbanPlan`, `setKanbanPlanContext`) now have identical path-traversal guards.

### Remaining Risks

- NIT-1: Context button re-enable is broader than necessary. No functional impact.
- No automated tests exist yet for path-traversal guards (noted in plan's Automated Tests section as "Unit test for path-traversal guard in fetchKanbanPlanPreview" — should be expanded to cover `openKanbanPlan` and `setKanbanPlanContext` as well).

---

**Recommendation: Send to Coder** (Complexity 7 — multi-file, moderate logic, reuses existing patterns; slight uplift from multi-dimensional filter state and workspace-mapping edge cases)
