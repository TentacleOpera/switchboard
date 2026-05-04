# Add Dependencies Tab to Kanban

## Goal
Add a 'DEPENDENCIES' tab to the kanban board, positioned between the AUTOMATION and SETUP tabs. This tab will display a CSS-based dependency tree of all plans in the 'CREATED' (new) and 'PLAN REVIEWED' (planned) columns, and provide a button to send a prompt to the analyst terminal to rebuild the dependency map.

## Current State
- The kanban has 5 tabs: KANBAN, AGENTS, PROMPTS, AUTOMATION, SETUP
- Tabs are defined in `/src/webview/kanban.html` with tab buttons and content divs
- Tab switching logic uses CSS classes (`active`) to show/hide content
- Plans have a `dependencies` field (comma-separated session IDs) stored in the kanban database
- The `_handleSendAnalystMessage` method in `TaskViewerProvider` dispatches prompts to the analyst terminal
- CSS-based tree visualization (zero external dependencies)

## Proposed Changes

### Phase 1: UI Structure (kanban.html)

1. **Add Tab Button**
   - Location: Line ~1457, between AUTOMATION and SETUP buttons
   - Add: `<button class="kanban-tab-btn" data-tab="dependencies">DEPENDENCIES</button>`

2. **Add Tab Content Container**
   - Location: After `automation-tab-content` div, before `setup-tab-content`
   - Create `#dependencies-tab-content` with:
     - Header section with title "Dependency Tree"
     - "Rebuild Dependencies" button
     - CSS tree container for plan nodes
     - Legend for node colors/status

3. **Add CSS Styles**
   - Dependency tree container styling
   - Plan node styling with color coding (CREATED amber, PLAN REVIEWED green, blocking red)
   - Connector lines between dependent plans
   - Scroll overflow for large trees

### Phase 2: Data Access (KanbanDatabase.ts)

1. **Add Query Method**
   - Add `getPlansWithDependencies(workspaceId: string, columns: string[]): Promise<KanbanPlanRecord[]>`
   - Query for plans in 'CREATED' and 'PLAN REVIEWED' columns with their dependencies
   - Return plan sessionId, topic, column, and dependencies fields

### Phase 3: Visualization Logic (kanban.html JS)

1. **Add Tab Activation Handler**
   - In the tab switching logic (around line 2193), add case for 'dependencies' tab
   - On activation: request dependency data via postMessage

2. **Add Message Handler**
   - Handle `dependencyMapData` message type from extension
   - Parse plans and dependencies
   - Generate CSS tree HTML:
     - Nodes: Each plan rendered as a div with session ID (truncated) and topic
     - Node styling: Different colors for CREATED vs PLAN REVIEWED
     - Connectors: Visual lines/arrows showing dependency relationships
     - Blocking indicator: Red border/label for plans with incomplete dependencies

3. **Tree Rendering**
   - Pure CSS/HTML — no external JS libraries
   - Indented tree layout showing parent → child dependencies
   - Handle empty state (no plans or no dependencies)

### Phase 4: Analyst Integration (TaskViewerProvider.ts)

1. **Add Handler Method**
   - Add `handleRebuildDependencyMap(plans: PlanDependencyInfo[]): Promise<boolean>`
   - Build prompt with plan list including:
     - Session ID
     - Topic/title
     - Current column (CREATED or PLAN REVIEWED)
     - Current dependencies (if any)
   - Send to analyst via `_handleSendAnalystMessage`

2. **Add Message Handler**
   - Handle `rebuildDependencyMap` message from webview
   - Fetch plans from DB using new query method
   - Call handler and return result to webview

### Phase 5: Webview-Extension Communication (KanbanProvider.ts)

1. **Add Message Type Handling**
   - In `KanbanProvider._handleWebviewMessage`, add:
     - `getDependencyMapData`: Query DB and return plans with dependencies
     - `rebuildDependencyMap`: Delegate to TaskViewerProvider

## Implementation Details

### CSS Tree Format
```html
<div class="dep-tree">
  <div class="plan-node created">
    <span class="plan-id">abc123</span>
    <span class="plan-title">Fix auth bug</span>
    <span class="plan-status">CREATED</span>
  </div>
  <div class="dep-connector">└─ depends on ─┐</div>
  <div class="plan-node planned blocking">
    <span class="plan-id">def456</span>
    <span class="plan-title">Add user profile</span>
    <span class="plan-status">PLAN REVIEWED ⚠️ BLOCKED</span>
  </div>
</div>
```

**CSS Classes:**
- `.plan-node.created` — amber background for CREATED column
- `.plan-node.planned` — green background for PLAN REVIEWED column  
- `.plan-node.blocking` — red border for plans with incomplete dependencies
- `.dep-connector` — visual connector line between related plans

### Analyst Prompt Format
```
## Dependency Map Rebuild Request

Rebuild the dependency relationships for the following plans currently in NEW (CREATED) and PLANNED (PLAN REVIEWED) columns:

**Plans to analyze:**
1. Session: abc123... | Topic: "Fix authentication bug" | Column: CREATED | Current deps: none
2. Session: def456... | Topic: "Add user profile page" | Column: PLAN REVIEWED | Current deps: abc123...
3. Session: ghi789... | Topic: "Update API endpoints" | Column: CREATED | Current deps: def456...

**Instructions:**
1. Analyze each plan's content and goals
2. Identify true dependency relationships based on:
   - Technical prerequisites (e.g., API changes needed for UI work)
   - Logical sequencing (e.g., auth system before protected features)
   - Resource conflicts or shared components
3. Update the dependencies field for each plan as needed
4. Use session IDs for dependency references
5. Report which plans can proceed (no blocking deps) vs which are blocked

Return a summary of:
- Updated dependencies for each plan
- Identified dependency chains
- Recommended execution order
- Any circular dependencies detected
```

### Database Query
```typescript
public async getPlansWithDependencies(
    workspaceId: string, 
    columns: string[] = ['CREATED', 'PLAN REVIEWED']
): Promise<KanbanPlanRecord[]> {
    if (!(await this.ensureReady()) || !this._db) return [];
    const placeholders = columns.map(() => '?').join(',');
    const stmt = this._db.prepare(
        `SELECT plan_id, session_id, topic, kanban_column, dependencies 
         FROM plans
         WHERE workspace_id = ? AND status = 'active' AND kanban_column IN (${placeholders})
         ORDER BY kanban_column, updated_at DESC`,
        [workspaceId, ...columns]
    );
    return this._readRows(stmt);
}
```

## Files to Modify

1. `/src/webview/kanban.html` - Add tab UI, styling, and JavaScript logic
2. `/src/services/KanbanDatabase.ts` - Add query method for plans with dependencies
3. `/src/services/TaskViewerProvider.ts` - Add analyst prompt handler
4. `/src/services/KanbanProvider.ts` - Add webview message handling

## Verification Plan

1. **UI Verification**
   - Open kanban board
   - Click DEPENDENCIES tab
   - Verify tab appears between AUTOMATION and SETUP
   - Verify tab content renders correctly

2. **Data Verification**
   - Create plans with dependencies in CREATED and PLAN REVIEWED columns
   - Open DEPENDENCIES tab
   - Verify plans appear in diagram
   - Verify dependency edges are drawn correctly
   - Verify node colors match column status

3. **Analyst Integration Verification**
   - Click "Rebuild Map" button
   - Verify prompt is sent to analyst terminal
   - Verify prompt includes all plan details
   - Verify analyst receives plan list without needing to query board

4. **Edge Cases**
   - Empty state: No plans in target columns
   - No dependencies: Plans exist but none have dependencies set
   - Circular dependencies: Detect and visually indicate
   - Missing analyst terminal: Show error message

## Risks and Considerations

- **Performance**: Large dependency maps may render slowly; consider node limit or pagination
- **Mermaid.js**: Ensure Mermaid is available in webview context or bundle it
- **Privacy**: Dependency map reveals plan relationships; ensure appropriate workspace visibility
- **Analyst Load**: Batch dependency analysis may be CPU-intensive; warn user for large plan counts

## Future Enhancements (Out of Scope)

- Interactive graph editing (drag to add/remove dependencies)
- Real-time dependency validation
- Integration with plan dependency parser for automatic detection
- Export dependency map as PNG/SVG
- Filtering by repo scope or tags
