# Kanban Board Implementation Plan

Implement a Kanban-style visualization for active plans in the editor area, allowing users to track and advance plan stages via drag-and-drop.

## User Review Required

> [!IMPORTANT]
> **Drag-and-Drop Actions**: Dragging a plan to a new column will immediately trigger the corresponding agent action (e.g., dragging to "Coded" triggers the Lead Coder).
> **Reverse Transitions**: Dragging a plan "backwards" will re-trigger that stage's agent (e.g., dragging from "Coded" back to "Reviewed" will re-trigger the Planner).

## Proposed Changes

---

### High Complexity Tasks

#### [NEW] [KanbanProvider.ts](file:///c:/Users/patvu/Documents/GitHub/switchboard/src/services/KanbanProvider.ts)
- **Role**: Create a new provider to manage the `WebviewPanel` in the editor area.
- **State Management**:
    - Listen for `SessionActionLog` changes to push real-time updates to the webview.
    - *Clarification*: Implement a mapping function that translates raw `SessionActionLog` events into the distinct Kanban columns (CREATED, REVIEWED, CODED, CODE REVIEWED).
- **Message Handling** (from Kanban webview):
    - `refresh`: Fetch all active runsheets from `SessionActionLog`.
    - `triggerAction`: Call `TaskViewerProvider` or `InteractiveOrchestrator` to start an agent.
    - `completePlan`: Mark a plan as complete.

#### [NEW] [kanban.html](file:///c:/Users/patvu/Documents/GitHub/switchboard/src/webview/kanban.html)
- **UI Implementation**: Implement a premium Kanban UI with four columns:
    1. **CREATED**: Plans with no major agent activity.
    2. **REVIEWED**: Plans where the `Planner` has run.
    3. **CODED**: Plans where the `Lead Coder` has run.
    4. **CODE REVIEWED**: Plans where the `Reviewer` has run.
- **Interactivity**: Use HTML5 Drag & Drop API for card movement.
- **Aesthetic**: Industrial dark-mode aesthetic matching the current sidebar.

---

### Low Complexity Tasks

#### [MODIFY] [extension.ts](file:///c:/Users/patvu/Documents/GitHub/switchboard/src/extension.ts)
- **Registration**: Register the `switchboard.openKanban` command.
- **Initialization**: Initialize the `KanbanViewProvider` and pass the `extensionUri` and `SessionActionLog` instance.

#### [MODIFY] [implementation.html](file:///c:/Users/patvu/Documents/GitHub/switchboard/src/webview/implementation.html)
- **UI Update**: Add an "OPEN KANBAN" button below the "CREATE PLAN" button in the sidebar.
- **Styling**: Add CSS styling for the new button to match existing secondary buttons.

---

## Verification Plan

### Manual Verification
1. **Launch Kanban**: Click "OPEN KANBAN" in the sidebar. Verify the panel opens in the editor area.
2. **Initial State**: Verify active plans appear in the "CREATED" column (or their respective stages based on logs).
3. **Forward Drag**: Drag a plan from "CREATED" to "CODED". 
    - Verify the "Lead Coder" agent is dispatched in the sidebar.
    - Verify the card moves (or stays pending) based on the log update.
4. **Reverse Drag**: Drag a plan from "CODED" back to "REVIEWED".
    - Verify the "Planner" agent is re-triggered.
5. **Auto-Update**: Mark a plan as "Complete" in the sidebar. Verify it disappears from the Kanban board.
6. **Persistence**: Close and re-open the Kanban board. Verify state is restored correctly from logs.
