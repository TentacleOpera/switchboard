# Add prompt batching

## Notebook Plan

There should be ways to tell the external ide agent to do all low complexity plans in a single prompt. Or is this best just handled by asking the agent to find and action all low complexity kanban items?

## Goal
Add a **manual batch dispatch** UI control so users can batch-dispatch all low-complexity plans from PLAN REVIEWED to a coder agent in a single action, without waiting for the Autoban timer.

## Source Code Verification (2026-03-15)

### Existing Infrastructure — Already Built
- **`handleKanbanBatchTrigger`** at `src/services/TaskViewerProvider.ts:554-670` — full batch dispatch method already exists. Constructs a multi-plan mega-prompt, updates runsheets sequentially, dispatches to the target agent. Batch size is configurable.
- **Autoban engine** at `src/services/TaskViewerProvider.ts:831-944` — already calls `handleKanbanBatchTrigger` on a timer. Dynamic complexity routing (Low → coder, High → lead) is already implemented at lines 900-936.
- **`get_kanban_state` MCP tool** at `src/mcp-server/register-tools.js:1867-1972` — agents can already query the kanban state. This supports the "agent-driven" approach where an agent reads the board and acts on low-complexity items.

### What's Missing
- **No manual UI trigger** — users cannot trigger batch dispatch on-demand; they must either wait for Autoban or manually drag-drop each card.
- **No complexity-filtered batch button** — the kanban board has no "Batch all Low" button.

## Proposed Changes

### Step 1 — Add "Batch Low" button to PLAN REVIEWED column header (Routine)
- **File:** `src/webview/kanban.html`
- **Inside `renderColumns()`** (line 415), in the column header template for the `PLAN REVIEWED` column:
  - Add a button `<button class="btn-batch" id="btn-batch-low" title="Batch dispatch all Low complexity plans">⚡ Low</button>` next to the column count.
  - Style it similar to `.btn-add-plan` but with a smaller form factor.
- **Wire up the click handler** to send a message:
  ```javascript
  document.getElementById('btn-batch-low')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'batchDispatchLow' });
  });
  ```

### Step 2 — Handle `batchDispatchLow` message in KanbanProvider (Routine)
- **File:** `src/services/KanbanProvider.ts` (and compiled `.js`)
- **In `_handleMessage`**, add a case for `'batchDispatchLow'`:
  ```typescript
  case 'batchDispatchLow':
      await vscode.commands.executeCommand('switchboard.batchDispatchLow');
      break;
  ```

### Step 3 — Register the command in TaskViewerProvider (Complex)
- **File:** `src/services/TaskViewerProvider.ts`
- **Register a new command** `switchboard.batchDispatchLow` (in the constructor or extension activation):
  1. Read all runsheets, filter to PLAN REVIEWED column.
  2. For each, check complexity via `this._kanbanProvider.getComplexityFromPlan()`.
  3. Collect session IDs where complexity === 'Low'.
  4. Call `this.handleKanbanBatchTrigger('coder', lowSessionIds)`.
- **Reuse existing infrastructure** — no new dispatch logic needed; `handleKanbanBatchTrigger` already handles multi-plan prompts, runsheet updates, and error handling.
- **Batch size:** Use `this._autobanState.batchSize` as the cap, or dispatch all if the user explicitly triggered it (configurable).

### Step 4 — Register the command in extension.ts (Routine)
- **File:** `src/extension.ts`
- Register `switchboard.batchDispatchLow` in the `activate` function and wire it to the TaskViewerProvider method.

### Step 5 — Compile (Routine)
- Run `npm run compile`.

### Alternative: Agent-Driven Approach (No Code Change Required)
The `get_kanban_state` MCP tool already returns all plans grouped by column. An agent can:
1. Call `get_kanban_state` to see PLAN REVIEWED items.
2. Read each plan file to check complexity.
3. Use `send_message(action: "execute")` to process each one.

This approach works today with no code changes, but requires the agent to have MCP tool access and initiative. **The manual UI button is the recommended primary approach** because it doesn't depend on agent capabilities.

## Verification Plan
1. Open the Kanban board with 3+ Low complexity plans in PLAN REVIEWED.
2. Click the "⚡ Low" button on the PLAN REVIEWED column header.
3. Verify all Low complexity plans are dispatched to the coder agent in a single batch.
4. Verify High/Unknown plans remain in PLAN REVIEWED.
5. Verify the batch prompt includes all plan file paths (check terminal output).
6. Verify runsheets are updated with the correct workflow event for all dispatched plans.

## Open Questions
- **Resolved:** Batch cap uses `autobanState.batchSize`. For manual triggers, consider allowing uncapped dispatch with a confirmation dialog if >5 plans.
- **Resolved:** The agent-driven approach works today via MCP tools but is not the primary UX path.

---

## Adversarial Review (Grumpy-style Critique)

**Critique:**
"You want to tell an LLM to do five things at once? LLMs are notoriously bad at adhering to long instruction lists. They'll skip step 3, hallucinate step 4, and tell you they finished step 5. And what happens when task 2 breaks the build? Does task 3 still run against broken state?"

**Balanced Synthesis:**
Valid points about LLM attention drift and cascading failures. Mitigations already exist in the codebase:
1. **Batch size cap** — `autobanState.batchSize` defaults to 3 (configurable to 1, 3, or 5).
2. **Existing prompt template** — `handleKanbanBatchTrigger` (line 629) already instructs: "Treat each file path below as a completely isolated context. Execute each plan fully before moving to the next."
3. **Low complexity only** — by filtering to Low complexity plans, we ensure batched tasks are genuinely trivial, reducing the risk of cascading failures.
4. **Independent verification** — the inline challenge directive is injected per-plan, forcing the agent to review before coding.

The existing infrastructure handles all the hard parts. This plan is primarily a UI wiring exercise.

**Recommendation:** This plan has high complexity (command registration, cross-component wiring). Send it to the **Lead Coder**.