# Fix: Auto-refresh for Kanban Plans Tab

## Problem
The Kanban Plans tab in `planning.html` does not automatically refresh when plan files are modified or new plans are added. Users must manually click the refresh button to see changes, which creates a poor UX and can lead to working with stale data.

## Root Cause
The current implementation only refreshes the kanban plans list when:
1. The user manually clicks the refresh button (`#kanban-refresh-btn`)
2. The tab is initially loaded

There is no mechanism to detect file system changes in the `.switchboard/plans/` directories and trigger automatic refreshes.

## Solution Overview
Implement auto-refresh functionality by:
1. Adding a file watcher on the extension side to monitor `.switchboard/plans/` directories
2. Sending refresh messages to the webview when changes are detected
3. Adding debouncing to prevent excessive refreshes during rapid file changes
4. Optionally adding a visual indicator when auto-refresh occurs

## Implementation Plan

### Phase 1: File Watcher Setup (Extension Side)

**File**: `src/services/PlanningPanelProvider.ts` (or appropriate service)

1. **Add file watcher for plans directories**
   - Use VS Code's `FileSystemWatcher` API to monitor `.switchboard/plans/` directories
   - Watch for file creation, modification, and deletion events
   - Handle multiple workspace roots (multi-root support)

2. **Implement debouncing mechanism**
   - Add a debounce delay (e.g., 500-1000ms) to prevent rapid successive refreshes
   - Clear pending refresh timer on new change events

3. **Send refresh messages to webview**
   - When changes are detected, post a message to the webview
   - Reuse existing `fetchKanbanPlans` message type or add new `autoRefreshKanbanPlans` type

### Phase 2: Webview Updates

**File**: `src/webview/planning.js`

1. **Handle auto-refresh messages**
   - Add message handler for auto-refresh events from extension
   - Call existing `renderKanbanPlans()` with updated data
   - Show subtle visual feedback (e.g., toast or status indicator) when auto-refresh occurs

2. **Optional: Add auto-refresh toggle**
   - Add a toggle button in the kanban controls strip to enable/disable auto-refresh
   - Persist user preference in `vscode.getState()`

### Phase 3: Testing

1. **Manual testing scenarios**
   - Create a new plan file → verify it appears in kanban tab without manual refresh
   - Modify an existing plan file → verify changes are reflected
   - Delete a plan file → verify it's removed from the list
   - Rapid file changes → verify debouncing prevents excessive refreshes

2. **Edge cases**
   - Multi-root workspace with plans in multiple locations
   - File system watcher failures (graceful degradation)
   - Webview not focused (should still update in background)

## Files to Modify

1. `src/services/PlanningPanelProvider.ts` - Add file watcher logic
2. `src/webview/planning.js` - Handle auto-refresh messages
3. `src/webview/planning.html` - Optional: Add auto-refresh toggle UI

## Success Criteria

- [ ] Kanban plans tab automatically updates when plan files change
- [ ] Auto-refresh works for file creation, modification, and deletion
- [ ] Debouncing prevents excessive refreshes during rapid changes
- [ ] Works correctly in multi-root workspaces
- [ ] Optional: User can toggle auto-refresh on/off
- [ ] Visual feedback indicates when auto-refresh occurs

## Risks & Mitigations

**Risk**: File watcher may miss events on some file systems
- **Mitigation**: Keep manual refresh button as fallback

**Risk**: Excessive file system polling could impact performance
- **Mitigation**: Use VS Code's native file watcher (event-based, not polling)

**Risk**: Auto-refresh could interrupt user if they're viewing a plan
- **Mitigation**: Only refresh the list, preserve currently selected plan if it still exists

## Notes

- Reuse existing `fetchKanbanPlans` infrastructure where possible
- Follow existing patterns in the codebase for file watching (check if other features already implement this)
- Consider adding a small visual indicator (e.g., "Auto-refreshed just now" toast) for transparency
