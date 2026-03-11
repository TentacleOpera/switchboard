# Add 'move all' option to top of kanban columns

## Notebook Plan

Add a 'move all' button and timer interval to the top of each kanban column. This should work like the auto agent pipeline. WHen the user presses this button, on every interval, the system moves a card in the column to the next column. The timer needs to be unique per column, a user may have timers for different columns going at once. This solves the use case of if a user creates 10 different plans, they may want to send each to the planner on  minute intervals. 

Do not worry about edge cases of 'is this agent available?' if it fails for that reason ,that is the user fault, and honestly isn't the end of the world.

## Goal
- Implement a per-column "auto-move" feature in the Kanban board.
- Allow users to set a unique time interval for each column.
- Automatically move one card from the column to the next column at each interval until the column is empty or stopped.

## Proposed Changes
- (Pending Investigation) Identify where Kanban column headers are rendered in `kanban.html` and add UI elements: a number input for the interval (e.g., in seconds/minutes) and a "Start/Stop Move All" button.
- Update `KanbanProvider.ts` to handle new IPC messages from the webview (`startAutoMove`, `stopAutoMove`).
- Implement a timer manager in the backend (e.g., in `StateManager` or `InteractiveOrchestrator`) that maintains a map of active intervals/timers keyed by column ID.
- The timer callback should fetch the top card in the specified column and invoke the existing "move card" logic to transition it to the next column.
- Update the webview UI to reflect the active timer state (e.g., button turns into a "Stop" button, maybe show a small countdown indicator).

## Verification Plan
- Render the Kanban view and verify the interval input and button appear on all columns.
- Enter an interval, click "Start", and verify the backend receives the message and starts a timer.
- Verify that every X seconds/minutes, exactly one card moves to the adjacent column.
- Verify that clicking "Stop" successfully cancels the active timer for that specific column.
- Verify that two different columns can have timers running simultaneously without interfering with each other.
- Verify that when the column becomes empty, the timer stops automatically.

## Open Questions
- What happens if VS Code is closed or reloaded while timers are running? Do we need to persist these timers to workspace state, or is it acceptable for them to be ephemeral (session-only)?
- How do we handle rate-limiting or API quotas if a user sets a very short interval (e.g., 1 second) and bombards an agent? The plan says "don't worry about edge cases", but we need basic protections against catastrophic loops.

## Review Feedback
- **Grumpy Review:** "Don't worry about edge cases"?! Are you kidding me?! That's a developer's famous last words before bringing down the whole system! What happens when the user types '1 millisecond' and DDOSes the LLM API?! Where is this timer state living? In the webview? In the backend? What happens if the webview reloads? You want background jobs running without a proper job queue or state persistence?! This isn't a "plan," it's a recipe for a memory leak and a frozen extension!
- **Balanced Synthesis:** The use case is completely valid: users need a way to batch-process a queue of plans without manually dragging them one by one. However, brushing off "edge cases" is dangerous for background timers. We must implement these timers in the backend (not the webview UI) so they survive panel closures, and we need to ensure the `setInterval` IDs are strictly managed to prevent memory leaks or duplicate processing. We also need basic validation on the interval input to prevent system abuse.
- **User Clarification:** The instruction to "not worry about edge cases" specifically refers to checking whether the agent is actually active in the terminal before moving the card. The system should assume the user has correctly set up their terminals before pressing the button. Implementing status checks would add too much complexity. This feature should heavily borrow from the existing auto agent pipeline automation that was recently implemented and proven to work, adding only the guardrails strictly necessary for it to run from the Kanban view.