# Kanban dynamic displaying newly created plans

## Problem
1. The kanban should not need a manual click of the refresh button for a plan to appear in the created column. When a plan is created it needs to appear instantly in the created column.
2. When kanban cards are moved, they stay in their old column unless the refresh button is manually clicked.
3. The drop target (landing area) for the columns is too small. Users must be very precise to trigger the green border and successfully drop a card; otherwise, it resets.

## Goals
- Provide real-time UI updates to the Kanban webview when a new plan is created in the workspace.
- Ensure the UI dynamically updates to reflect state changes when a plan is moved across columns.
- Improve the drag-and-drop user experience by expanding the acceptable drop targets (landing areas) for each column.
- Clarify expected outcome and scope of the event-driven updates.

## Constraints
- Preserve existing behavior outside this change.
- Do not introduce performance regressions (e.g., avoid unconstrained polling).

## Task Split & Proposed Changes

### High Complexity (Architectural / Data Flow)
1. **Implement File System Watcher (Extension Host)**
   - *Clarification:* Use `vscode.workspace.createFileSystemWatcher` scoped strictly to the `.switchboard/plans/**/*.md` directory (or utilize an existing state manager) to monitor for new file creations AND modifications/moves.
2. **Webview Messaging Integration**
   - *Clarification:* Wire the watcher's `onDidCreate` event to dispatch a `{ type: 'planCreated', plan: {...} }` message.
   - *Clarification:* Wire the watcher's `onDidChange` (or equivalent file move/rename event) to dispatch a `{ type: 'planUpdated', plan: {...} }` message to the `KanbanProvider`'s webview instance.

### Low Complexity (UI & Routine)
1. **Handle Webview Messages (UI)**
   - *Clarification:* Add event listeners in `src/webview/kanban.html` (or its associated script) to listen for the specific creation and update messages.
2. **DOM Updates for Creation and Moves**
   - *Clarification:* For creations, dynamically construct the plan card DOM element and append it to the appropriate column container.
   - *Clarification:* For updates (moves), locate the existing plan card by ID and move it to the new column container without triggering a full board re-render.
3. **Improve Drag-and-Drop Hit Area (CSS/JS)**
   - *Clarification:* Adjust the CSS padding/margins or the JavaScript `dragover`/`drop` event listeners so the entire column height acts as a valid drop zone, not just the column header or existing cards. Ensure the visual indicator (green border) triggers more easily.

## Verification Plan
- Create a new plan file manually or via a command in the `.switchboard/plans` directory while the Kanban webview is visible.
- Verify the new plan appears in the expected column immediately.
- Drag a plan card to a new column. Verify the card moves successfully and the backend state updates.
- Verify that moving a plan file via the file explorer or another command automatically updates the card's position in the Kanban webview.
- Verify that dropping a card anywhere within a column's general area (even below existing cards) successfully registers the drop and triggers the green visual indicator.
- Verify no full page refresh occurs (maintaining scroll position and other UI state).
- Verify the file watcher or event listener disposes correctly when the extension deactivates or the webview is destroyed.

## Open Questions
- Is there an existing central plan registry or state manager we should hook into instead of spinning up a dedicated file watcher just for the Kanban provider?
