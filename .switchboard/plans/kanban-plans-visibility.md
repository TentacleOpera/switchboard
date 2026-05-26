# Kanban Plans Visibility

## Problem
The ARTIFACTS view (planning.html) has no integration with the kanban system. Users cannot view their kanban plans, see their current status, or access plan files directly from the planning panel. This creates a disconnect between planning artifacts and execution tracking.

## Solution
Add a new "KANBAN PLANS" tab to the ARTIFACTS view that displays all kanban plans with their current status, workspace assignment, and provides quick access to plan files.

## Implementation Plan

### Phase 1: Kanban Database Integration
- **File**: `src/services/PlanningPanelProvider.ts`
- Add dependency injection for `KanbanProvider` in constructor
- Add method `_getKanbanPlans(workspaceRoot: string): Promise<Array<{ id: string; topic: string; column: string; workspace: string; mtime: number; filePath: string }>>`:
  - Query kanban database for all plans
  - Extract relevant fields: plan ID, topic, current column, workspace, modified time, file path
  - Sort by modified time (newest first) or column priority
- Add method `_getKanbanColumns(): Promise<string[]>`:
  - Query kanban database for available columns
  - Return list of column names (e.g., "Created", "Coded", "Reviewed", "Done")

### Phase 2: Message Handlers
- **File**: `src/services/PlanningPanelProvider.ts`
- Add message handler `fetchKanbanPlans`:
  - Get current workspace root
  - Call `_getKanbanPlans()`
  - Return plans list to webview
- Add message handler `fetchKanbanColumns`:
  - Call `_getKanbanColumns()`
  - Return columns list to webview
- Add message handler `openKanbanPlan`:
  - Accept plan ID or file path
  - Open plan file in VSCode editor
  - Reveal plan in kanban view (optional)
- Add message handler `setKanbanPlanContext`:
  - Accept plan ID
  - Set plan as active planning context
  - Send confirmation to webview

### Phase 3: UI Structure - New Tab
- **File**: `src/webview/planning.html`
- Add new tab button to tab bar:
  ```html
  <button class="research-tab-btn" data-tab="kanban">KANBAN PLANS</button>
  ```
- Add new tab content section:
  ```html
  <div id="kanban-content" class="research-tab-content">
      <!-- Kanban plans list -->
  </div>
  ```
- Add controls strip with:
  - Column filter dropdown
  - Workspace filter dropdown
  - Search input
  - Refresh button
- Add plans list container with:
  - Table or card layout for plans
  - Columns: Topic, Column, Workspace, Modified, Actions
  - Styling matching existing dark theme

### Phase 4: UI Styling
- **File**: `src/webview/planning.html`
- Add CSS for kanban plans list:
  - `.kanban-plans-list` - container for plan items
  - `.kanban-plan-item` - individual plan row/card
  - `.kanban-plan-topic` - plan name/topic
  - `.kanban-plan-column` - current column badge
  - `.kanban-plan-workspace` - workspace indicator
  - `.kanban-plan-timestamp` - modified time
  - `.kanban-plan-actions` - action buttons
- Add column badge colors:
  - Created: gray/blue
  - Coded: yellow/orange
  - Reviewed: purple
  - Done: green
- Add hover effects and transitions matching existing design

### Phase 5: UI Logic - Plans Rendering
- **File**: `src/webview/planning.js`
- Add function `renderKanbanPlans(plans: any[], filters: any)`:
  - Filter plans by column, workspace, search term
  - Sort plans by selected criteria (time, column, name)
  - Render plan items with badges and actions
  - Show empty state if no plans match filters
- Add function `renderColumnFilter(columns: string[])`:
  - Populate column filter dropdown
  - Include "All Columns" option
- Add function `renderWorkspaceFilter(workspaces: string[])`:
  - Populate workspace filter dropdown
  - Include "All Workspaces" option
- Add event listeners for filter changes:
  - Re-render plans on filter change
  - Debounce search input

### Phase 6: UI Logic - Plan Actions
- **File**: `src/webview/planning.js`
- Add click handler for plan topic:
  - Call `openKanbanPlan` message
  - Open plan file in editor
- Add click handler for "Set as Context" button:
  - Call `setKanbanPlanContext` message
  - Update active context banner
- Add click handler for "View in Kanban" button:
  - Open kanban panel and reveal plan
  - Use VSCode command if available
- Add right-click context menu (optional):
  - Copy plan path
  - Copy plan topic
  - Delete plan (with confirmation)

### Phase 7: Active Context Integration
- **File**: `src/webview/planning.html`
- Add active context banner to kanban tab (similar to local/online tabs):
  ```html
  <div class="active-doc-banner inactive" id="active-doc-banner-kanban">
      <div class="active-doc-info">
          <span class="active-doc-label">Active Plan:</span>
          <span class="active-doc-name" id="active-doc-name-kanban">None</span>
      </div>
      <button class="btn-disable-doc" id="btn-disable-doc-kanban">Turn off</button>
  </div>
  ```
- **File**: `src/webview/planning.js`
- Update context banner when plan is set as active
- Add "Turn off" handler to clear active context
- Sync active context across all tabs (local, online, kanban)

### Phase 8: Preview Pane Integration
- **File**: `src/webview/planning.html`
- Add preview pane to kanban tab (similar structure to local/online):
  ```html
  <div class="content-row">
      <div id="kanban-list-pane"><!-- plans list --></div>
      <div id="kanban-preview-pane"><!-- plan preview --></div>
  </div>
  ```
- **File**: `src/webview/planning.js`
- Add message handler `fetchKanbanPlanPreview`:
  - Accept plan file path
  - Read plan file content
  - Return markdown content to webview
- Render plan preview in markdown pane when plan is selected
- Reuse existing markdown preview styling

### Phase 9: Workspace Switching
- **File**: `src/services/PlanningPanelProvider.ts`
- Update `fetchKanbanPlans` to handle multi-workspace:
  - If no workspace filter, show plans from all workspaces
  - Group plans by workspace in UI
  - Allow switching between workspace databases
- Add message handler `switchKanbanWorkspace`:
  - Switch kanban database context
  - Refresh plans list

### Phase 10: Testing
- Test kanban plans listing with various column states
- Test column filtering (show only "Created" plans)
- Test workspace filtering (show only specific workspace plans)
- Test search functionality (filter by topic)
- Test opening plan file from list
- Test setting plan as active context
- Test preview pane rendering
- Test with no kanban database (show empty state)
- Test with large number of plans (performance)
- Test workspace switching in multi-root setup

## Files to Modify
- `src/services/PlanningPanelProvider.ts` - Kanban integration and message handlers
- `src/webview/planning.html` - New tab, UI structure, styling
- `src/webview/planning.js` - Plans rendering, filtering, actions
- `src/extension.ts` - Wire up KanbanProvider dependency (if needed)

## Edge Cases
- No kanban database exists (show "Kanban not initialized" message with setup link)
- Empty kanban board (show "No plans" empty state)
- Plan file deleted but still in database (show error, offer to clean up)
- Large number of plans (implement pagination or virtual scrolling)
- Multi-workspace setup (show workspace indicator, allow filtering)
- Plan with no topic (use filename or "Untitled")
- Plan in archived column (show with different styling or hide)
- Database locked or corrupted (show error, offer recovery)

## Future Enhancements
- Drag and drop plans between columns from the list view
- Bulk actions (move multiple plans, delete multiple plans)
- Plan complexity indicator in list
- Plan dependency visualization
- Link plans to associated tickets/tasks
- Export plans list to CSV/JSON
- Plan history/version view
- Quick edit plan metadata from list view
