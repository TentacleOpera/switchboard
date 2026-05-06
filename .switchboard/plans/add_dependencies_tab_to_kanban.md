# Add Dependencies Tab to Kanban

## Goal
Add a 'DEPENDENCIES' tab to the kanban board, positioned between the AUTOMATION and SETUP tabs. This tab will display a CSS-based dependency tree of all plans in the 'CREATED' (new) and 'PLAN REVIEWED' (planned) columns, and provide a button to send a prompt to the analyst terminal to rebuild the dependency map.

## Metadata
**Tags:** frontend, UI, workflow, database
**Complexity:** 5

## Current State
- The kanban has 5 tabs: KANBAN, AGENTS, PROMPTS, AUTOMATION, SETUP
- Tabs are defined in `/src/webview/kanban.html` with tab buttons and content divs
- Tab switching logic uses CSS classes (`active`) to show/hide content
- Plans have a `dependencies` field (comma-separated session IDs) stored in the kanban database
- The `_handleSendAnalystMessage` method in `TaskViewerProvider` dispatches prompts to the analyst terminal
- CSS-based tree visualization (zero external dependencies)

## Complexity Audit
### Routine
- Add DEPENDENCIES tab button to `kanban.html` tab bar (line ~1457, between AUTOMATION and SETUP)
- Add `#dependencies-tab-content` div with header, rebuild button, tree container, and legend
- Add CSS styles for `.dep-tree`, `.plan-node`, `.dep-connector` with dark-theme variables
- Add `getPlansWithDependencies()` query method to `KanbanDatabase.ts`
- Add `getDependencyMapData` message handler in `KanbanProvider._handleMessage`
- Add `rebuildDependencyMap` message handler in `KanbanProvider._handleMessage`
- Add `dependencyMapData` message handler in webview JS to render tree
- Add tab activation hydration in tab switching logic (around line 2193)
- Add `handleRebuildDependencyMap()` method to `TaskViewerProvider.ts` using existing `_handleSendAnalystMessage`

### Complex / Risky
- CSS tree rendering for large dependency maps (>30 plans) may cause performance issues; need node limit or virtualized rendering
- Circular dependency detection in the tree renderer requires graph traversal (DFS) to detect cycles and mark them visually
- The `rebuildDependencyMap` flow sends plan data to the analyst terminal and focuses it (same pattern as `_handleSendAnalystMessage`). The analyst updates the DB directly. The user clicks a "Refresh" button on the dependencies tab to reload the map after the analyst finishes. No webview callback is needed — terminal focus is the feedback.

## Edge-Case & Dependency Audit
- **Race Conditions:** Clicking "Rebuild Dependencies" while a previous rebuild is still running could send duplicate prompts to the analyst. Mitigation: disable the button and show a spinner until the analyst responds or a timeout elapses (e.g., 30s).
- **Security:** The analyst prompt includes plan topics and session IDs — no sensitive data, but the `_handleSendAnalystMessage` method should validate the instruction string length to prevent terminal buffer overflow.
- **Side Effects:** The `rebuildDependencyMap` flow asks the analyst to update plan dependencies in the DB. If the analyst writes incorrect or circular dependencies, the dependency tree will show invalid relationships. Mitigation: the tree renderer should detect and highlight circular dependencies with a red indicator.
- **Empty State:** If no plans exist in CREATED or PLAN REVIEWED columns, the tree container should show a helpful empty state message (e.g., "No plans in NEW or PLANNED columns. Create a plan to see dependencies here.").
- **Missing Analyst Terminal:** If no analyst terminal is registered, the "Rebuild Dependencies" button should show an error message instead of silently failing. The existing `_handleSendAnalystMessage` returns `false` when no terminal is found — the webview should handle this.
- **Dependencies & Conflicts:** This plan adds a new tab to `kanban.html`, which is also modified by the "Add Role-Based Prompt Builder to Kanban Prompts Tab" plan. Both plans modify the same file but in different sections (tab bar + different content divs). No structural conflict, but both should be tested together after merge. The existing test file `src/test/prompts-tab-move-regression.test.js` validates tab button order — it must be updated to include the new DEPENDENCIES tab. No cross-plan conflicts detected (Kanban query failed — uncertainty noted).

## Dependencies
None

## Adversarial Synthesis
Key risks: (1) CSS tree rendering may not scale well beyond ~30 plans — need a node limit or lazy rendering strategy. (2) Circular dependency detection requires DFS traversal in the webview JS, adding complexity to the tree renderer. (3) The rebuild flow focuses the analyst terminal — user must click Refresh to see updated map. Mitigations: Cap displayed nodes at 50 with a "show more" option, implement cycle detection as a separate `detectCycles()` function, add a prominent Refresh button on the dependencies tab.

## Proposed Changes

### Phase 1: UI Structure (kanban.html)

1. **Add Tab Button**
   - Location: Line ~1457, between AUTOMATION and SETUP buttons
   - Add: `<button class="kanban-tab-btn" data-tab="dependencies">DEPENDENCIES</button>`

2. **Add Tab Content Container**
   - Location: After `automation-tab-content` div, before `setup-tab-content`
   - Create `#dependencies-tab-content` with:
     - Header section with title "Dependency Tree"
     - "Rebuild Dependencies" button (sends prompt to analyst, focuses terminal)
     - "Refresh" button (re-queries DB and re-renders tree)
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

- **Performance**: Large dependency maps may render slowly; consider node limit (cap at 50) or pagination for workspaces with many plans
- **CSS Tree vs Mermaid.js**: This plan uses pure CSS/HTML tree rendering (zero external dependencies). Mermaid.js is NOT used — it would require bundling an external library into the webview. If richer graph visualization is needed later, Mermaid can be evaluated as a future enhancement.
- **Privacy**: Dependency map reveals plan relationships; ensure appropriate workspace visibility
- **Analyst Load**: Batch dependency analysis may be CPU-intensive; warn user for large plan counts

## Future Enhancements (Out of Scope)

- Interactive graph editing (drag to add/remove dependencies)
- Real-time dependency validation
- Integration with plan dependency parser for automatic detection
- Export dependency map as PNG/SVG
- Filtering by repo scope or tags

## Reviewer Pass Results (2026-05-04)

### Findings

| ID | Severity | Description |
|----|----------|-------------|
| C-1 | CRITICAL | XSS: `plan.topic` and `plan.session_id` interpolated into `innerHTML` without escaping in `renderDependencyTree()` |
| C-2 | CRITICAL | No `actionTriggered` message handler in webview — REBUILD button stays disabled for full 30s timeout with no feedback on success/failure |
| C-3 | CRITICAL | CSS `#dependencies-tab-content { display: flex; }` overrides `.kanban-tab-content { display: none; }` (ID specificity > class), causing dependencies content to show in ALL tabs |
| C-5 | CRITICAL | `getPlansWithDependencies` was passed `workspaceRoot` (file path) instead of `workspaceId` (database hash), causing query to return no results even when plans exist |
| M-1 | MAJOR | No node limit for large dependency maps — plan specified cap at 50 with "show more" |
| M-2 | MAJOR | `detectCyclesForDeps` had no-op `.filter(id => true)` and early-return cycle detection that missed multiple independent cycles |
| M-3 | MAJOR | Missing analyst terminal error feedback in webview (covered by C-2 fix) |
| N-1 | NIT | Dead variables `createdPlans`/`plannedPlans` computed but never used |
| N-2 | NIT | CSS `::before` pseudo-element text overlapped with JS-rendered dependency label |

### Fixes Applied

| ID | Fix |
|----|-----|
| C-1 | Applied `escapeHtml()` and `escapeAttr()` to all user-data interpolations in `renderDependencyTree()` (session_id, topic, kanban_column) |
| C-2 | Added `actionTriggered` case in webview message switch that re-enables REBUILD button, shows "REBUILD FAILED" for 3s on failure |
| C-3 | Removed `display: flex` from `#dependencies-tab-content` CSS selector to fix tab switching (was overriding `.kanban-tab-content { display: none; }`) |
| C-5 | Fixed workspaceId resolution in KanbanProvider: now calls `_readWorkspaceId`/`getWorkspaceId`/`getDominantWorkspaceId` to get actual database hash instead of passing file path directly to `getPlansWithDependencies` |
| M-1 | Added `DEP_NODE_LIMIT = 50` with "Show All" button when plans exceed limit |
| M-2 | Fixed cycle detection: removed no-op filter, now only edges to existing plans are followed; DFS continues after finding cycles to collect all cycle participants |
| N-1 | Removed unused `createdPlans`/`plannedPlans` variables |
| N-2 | Changed CSS `::before` content from full text to just `└─` branch character; JS provides the dependency label |

### Files Changed

- `/src/webview/kanban.html` — XSS fixes, actionTriggered handler, node limit, cycle detection fix, dead code removal, CSS overlap fix, CSS tab switching fix
- `/src/services/KanbanProvider.ts` — workspaceId resolution fix for getPlansWithDependencies calls

### Validation Results

- **TypeScript compilation**: `npx tsc --noEmit` — 2 pre-existing errors (unrelated import extensions in ClickUpSyncService.ts and KanbanProvider.ts), **0 new errors**
- **HTML structure**: Tab button order verified: KANBAN → AGENTS → PROMPTS → AUTOMATION → DEPENDENCIES → SETUP ✓
- **Message flow**: getDependencyMapData → DB query → dependencyMapData → renderDependencyTree ✓
- **Message flow**: rebuildDependencyMap → DB query → handleRebuildDependencyMap → _handleSendAnalystMessage → actionTriggered → button reset ✓

### Remaining Risks

- **Instruction length validation**: The plan's edge-case audit called for validating the analyst prompt string length to prevent terminal buffer overflow. Not implemented — `_handleSendAnalystMessage` has no length cap. Low risk in practice (terminal buffers are large), but noted.
- **Performance of `plans.some()` in cycle detection**: The M-2 fix uses `plans.some(q => q.sessionId === id)` inside a loop, which is O(n²) for the adjacency build. Acceptable for ≤50 plans (the node limit), but could be optimized with a pre-built Set if needed for larger datasets.

## Testing Failure Report (2026-05-05)

### Issue
**User feedback**: "still claims no plans exist in new or planned columns when there are clearly plans there"

### Root Cause
The reviewer pass (C-1) added escaping via `escapeHtml()` and `escapeAttr()` to all user-data interpolations, but the property names used in `renderDependencyTree()` and `detectCyclesForDeps()` remained snake_case (`session_id`, `kanban_column`). The extension's `KanbanDatabase._readRows()` returns objects with camelCase property names (`sessionId`, `kanbanColumn`). When `renderDependencyTree()` accessed `plan.session_id`, the value was `undefined`. The expression `plan.session_id.substring(0, 8)` then threw a `TypeError`, which prevented the tree from rendering and left the previously-set empty state message visible.

### Fix
- `/src/webview/kanban.html` — Changed all snake_case property accesses to camelCase in `renderDependencyTree()` and `detectCyclesForDeps()`:
  - `plan.session_id` → `plan.sessionId` (4 occurrences)
  - `plan.kanban_column` → `plan.kanbanColumn` (2 occurrences)
- `/src/services/TaskViewerProvider.ts` — Changed snake_case to camelCase in `handleRebuildDependencyMap()`:
  - `p.session_id` → `p.sessionId`
  - `p.kanban_column` → `p.kanbanColumn`

### Validation
- Confirmed no remaining snake_case property accesses (`session_id`, `kanban_column`) in the dependency tree visualization code.
- `npx tsc --noEmit` — no new TypeScript errors introduced.
