# Transform "Auto" Tab into "Autoban" Control Center

## Goal
The introduction of the global Kanban board has made the old "Auto" sidebar tab (which triggered hardcoded pipeline workflows) obsolete. This plan transforms the "Auto" tab into the "Autoban" (Auto-Kanban) control center. It moves the complex automation configuration (timers, toggles, and batch sizes) out of the Kanban visualization and into a dedicated sidebar UI, acting as a global control panel for the autonomous factory.

## Complexity Audit
### Band A — Routine
- **Sidebar UI (`implementation.html`)**: Rename the "Auto" tab to "Autoban". Redesign the tab's DOM structure to replace all old composite workflows ("Pipeline", "Lead Coder + Coder", "Auto-Agent", and "Coder -> Reviewer") with Kanban configuration controls.
- **Provider Binding (`TaskViewerProvider.ts`)**: Add message handlers for the new Autoban configuration toggles and inputs.

### Band B — Complex / Risky
- **State Synchronization**: The Kanban Webview (`kanban.html` / `KanbanProvider.ts`) and the Sidebar Webview (`implementation.html` / `TaskViewerProvider.ts`) must stay in sync. When settings are changed in Autoban, they must securely propagate to the active Kanban auto-move engine.
- **Backend Teardown**: Completely rip out the legacy `InteractiveOrchestrator` backend and the fragile `_coderReviewerSessions` polling loops, as the new Autoban engine natively supersedes them.
- **Timer Migration**: Moving the actual timer execution logic out of the Kanban webview. Timers will now continuously poll in the background, firing staggered waves of batches if a backlog builds up, or silently waiting if a column is empty, rather than auto-stopping.

## Edge-Case Audit
- **Split Views:** A user might have the Sidebar open but the Kanban board closed. If they toggle "Start Autoban" in the sidebar, the background engine must run regardless of whether the Kanban webview is active.
- **Global Settings vs Session State:** Autoban settings (like Batch Size = 3) need to be persisted to workspace state so they survive VS Code reloads.
- **Continuous Polling:** The new background timers must not crash or leak memory when constantly polling empty columns. They must safely stagger batch waves without overlapping dispatches.

## Adversarial Synthesis
### Grumpy Critique
You're splitting the controls from the thing they control! If I'm looking at the Kanban board, I want the timer right there on the column. If you move it to the sidebar, I have to constantly toggle back and forth to see if the timer is running. Also, syncing state between two completely different webviews in VS Code is notoriously buggy. You're going to end up with the sidebar saying "Timer On" while the Kanban board is frozen. Finally, ripping out the `InteractiveOrchestrator` sounds dangerous—what if some obscure command still relies on it?

### Balanced Response
Grumpy is right about the danger of disconnected UIs. We will keep a *read-only visual indicator* (like a tiny glowing dot or status text) on the Kanban columns so users can see if automation is active at a glance without leaving the board. However, moving the *configuration* to the sidebar is the right architectural move because it prevents the Kanban UI from becoming a cluttered mess. To ensure state consistency, we will store the master `autobanState` in the extension's workspace context, which acts as a single source of truth. Regarding the `InteractiveOrchestrator` teardown, we will rigorously verify all existing references to ensure a clean removal, as the Kanban column rules genuinely supersede all of its functionality.

## Proposed Changes

### 1. Sidebar UI Update (`src/webview/implementation.html`)
- **Rename Tab**: Change `<button class="sub-tab-btn" data-tab="auto">Auto</button>` to `data-tab="autoban">Autoban`. Update the corresponding container ID to `agent-list-autoban`.
- **Remove All Legacy Buttons**: Completely delete all 4 legacy composites (`createPipelineRow`, `createCompositeRow`, `createAutoAgentRow`, and `createCoderReviewerRow`).
- **Build Pure Autoban UI**: Inject a new, focused rules engine configuration form:
  - **Master Toggle**: `[ ] Enable Autoban Engine`
  - **Global Batch Size**: `<select>` for "Max Batch Size" (1, 3, 5).
  - **Column Interval Rules**: Toggles/inputs for each transition (e.g., `[x] CREATED -> PLAN REVIEWED every [5] min`).
- **Emit State**: When any input changes, emit a `updateAutobanState` IPC message.

### 2. Extension State Management (`src/services/TaskViewerProvider.ts`)
- **Teardown**: Remove references to `InteractiveOrchestrator` and delete the `_coderReviewerSessions` polling loops.
- **Listen for Config**: Catch `updateAutobanState` messages from the sidebar.
- **Persist State**: Save the configuration object to `vscode.workspace.getConfiguration('switchboard').update('autoban', state)`.
- **Broadcast State**: When the state changes, find the active Kanban webview panel (if open) and send it the updated configuration via a new `kanbanProvider.updateAutobanConfig(state)` method.
- **Background Timers**: Implement the continuous background polling loop that reads the saved `autoban` state and dispatches batches even if the Kanban UI is closed.

### 3. Kanban Engine Update (`src/webview/kanban.html` & `KanbanProvider.ts`)
- **Clean UI**: Remove the heavy `automove-bar` (inputs, start/stop buttons) from the column headers. Replace it with a subtle read-only status indicator (e.g., `⚡ Auto: 5m (Batch: 3)` or a progress bar).
- **Receive Config**: Add a message listener in `kanban.html` for `updateAutobanConfig`. 
- **Timer Migration**: The Kanban webview no longer controls the timers. It purely visualizes the state pushed from the backend, trusting `TaskViewerProvider.ts` to execute the actual continuous batch dispatching.

## Verification Plan
### Automated Tests
- Run `npm run compile` to ensure the removal of `InteractiveOrchestrator` doesn't break other systems.

### Manual Testing
1. **UI Cleanliness**: Open Kanban board. Verify the clunky auto-move input bars are gone, replaced by a clean visual layout.
2. **Sidebar Migration**: Open Switchboard sidebar. Click the "Autoban" tab. Verify all 4 old Pipeline/Team buttons are completely gone and the new pure rules engine is present.
3. **Background Execution**: Close the Kanban board completely. Enable Autoban in the sidebar. Verify the system still processes and dispatches cards in the background.
4. **Continuous Polling**: Leave a column empty with the timer running. Add 5 cards. Verify it immediately starts processing them in staggered batches based on the global batch size.