# Add main controls strip at top of kanban board

## Notebook Plan

Have a strip underneath the kanban title that has all the whole of board controls:

AUTOBAN - starts autoban
CLI TRIGGER - turns off the cli trigger behaviour to allow board state to be altered without triggering actions
BATCH PLANNER PROMPT - copies to clipboard a prompt that tells the agent to run the improve plan workflow on all new plans. Agent should be told to deploy subagents if available.
BATCH LOW COMPLEXITY PROMPT - copies a prompt to clipboard that tells the agent to action all low complexity plans in the plan reviewed column. Agent should be told to deploy subagents if available. 
LOW COMPLEXITY TO JULES - sends all the low complexity work in the plan reviewed column to Jules, if jules is not disabled. Should only apepar i jules has been enabled in setup. 
REFRESH - same button, differnet location

Each prompt button should move all the affected plans to the next column when pressed

## Goal
- Add a **controls strip** beneath the kanban header bar (`.kanban-header`) containing 6 action buttons.
- Each button that copies a prompt must also **auto-advance** the affected cards to their next Kanban column.
- The strip replaces the current standalone Refresh button location and subsumes the CLI Trigger toggle from the sibling plan.

## Dependencies
- **"Have 'cli trigger' switch at top of kanban"** (sess_1773603838873, CREATED) — the CLI TRIGGER toggle should be implemented first as a standalone, then this plan relocates it into the strip.
- **"Allow Jules to be turned on or off"** (sess_1773177814226, CODED) — the LOW COMPLEXITY TO JULES button's visibility depends on the Jules enabled flag. The button should be conditionally rendered based on `julesEnabled` state from setup config.
- **Autoban engine** — already exists in `TaskViewerProvider.ts` lines 100-118 and the kanban webview. The AUTOBAN button simply toggles the existing `autobanState.enabled` flag.

## Proposed Changes

### Step 1 — Add the controls strip HTML (Routine)
- **File**: `src/webview/kanban.html`
- Insert a new `<div class="controls-strip">` between the `.kanban-header` div (line 384-387) and the `.kanban-board` div (line 388).
- Adjust `.kanban-board` height calc to account for the new strip height (~36px): `height: calc(100vh - 50px - 36px)`.
- The strip contains 6 buttons in a horizontal flex row:
  ```html
  <div class="controls-strip">
      <button class="strip-btn" id="btn-autoban" title="Toggle Autoban engine">⚡ AUTOBAN</button>
      <label class="strip-toggle" title="Toggle CLI trigger behavior on drag-drop">
          <input type="checkbox" id="cli-triggers-toggle" checked>
          <span>CLI TRIGGERS</span>
      </label>
      <button class="strip-btn" id="btn-batch-planner" title="Copy improve-plan prompt for all CREATED plans">📋 BATCH PLANNER</button>
      <button class="strip-btn" id="btn-batch-low" title="Copy coding prompt for low-complexity PLAN REVIEWED plans">📋 BATCH LOW</button>
      <button class="strip-btn" id="btn-jules-low" title="Send low-complexity plans to Jules" style="display:none">🚀 JULES LOW</button>
      <button class="strip-btn" id="btn-refresh-strip" title="Refresh board">↻ REFRESH</button>
  </div>
  ```
- Remove the old `btn-refresh` from the `.kanban-header` div.

### Step 2 — CSS for controls strip (Routine)
- **File**: `src/webview/kanban.html` `<style>` section
- Style `.controls-strip`: `display: flex; gap: 8px; padding: 6px 16px; background: var(--panel-bg2); border-bottom: 1px solid var(--border-color); align-items: center;`
- Style `.strip-btn`: mono font, 9px, uppercase, teal border on hover, consistent with existing `.btn-refresh` styling.
- Style `.strip-toggle`: same as the CLI trigger toggle from the sibling plan.
- Active state for AUTOBAN button: when autoban is enabled, apply teal glow + `is-active` class.

### Step 3 — Backend message handlers in KanbanProvider (Moderate)
- **File**: `src/services/KanbanProvider.ts`
- Add new message handlers in `_handleMessage`:
  - `'toggleAutoban'` → post message to TaskViewerProvider to toggle autoban enabled state via existing command.
  - `'toggleCliTriggers'` → same as sibling plan (guard `triggerAction` handler).
  - `'batchPlannerPrompt'` → collect all CREATED column cards, generate a prompt instructing the agent to run `/improve-plan` on each, copy to clipboard, then advance all CREATED cards to PLAN REVIEWED.
  - `'batchLowComplexity'` → collect all LOW complexity cards in PLAN REVIEWED, generate a coding prompt, copy to clipboard, then advance those cards to CODED.
  - `'julesLowComplexity'` → dispatch all LOW complexity PLAN REVIEWED cards to Jules via existing Jules dispatch mechanism.
  - `'refresh'` → already exists (line 572).

### Step 4 — Prompt generation logic (Moderate)
- **File**: `src/services/KanbanProvider.ts` (new private methods)
- `_generateBatchPlannerPrompt(cards: KanbanCard[]): string` — generates a prompt like:
  ```
  Run the /improve-plan workflow on all ${cards.length} plans in the CREATED column. Use the get_kanban_state MCP tool to identify all plans instantly (column filter: "CREATED"). If MCP unavailable, plans are listed below with absolute paths.

  For each plan:
  1. Read the plan file to understand scope
  2. Read referenced source files (grep for classes/functions mentioned in the plan)
  3. Check for dependency conflicts with other plans (search .switchboard/plans/ for overlaps)
  4. Run internal adversarial review (Grumpy critique + balanced synthesis)
  5. Update the plan file with: detailed steps, file paths, line numbers, dependencies, complexity audit, and agent recommendation
  6. Move to next plan without pausing

  Key source context locations:
  - Kanban webview: src/webview/kanban.html
  - Kanban backend: src/services/KanbanProvider.ts, src/services/TaskViewerProvider.ts
  - Column definitions: src/services/agentConfig.ts
  - DB layer: src/services/KanbanDatabase.ts, src/services/KanbanMigration.ts
  - MCP tools: src/mcp-server/register-tools.js
  - Workflows: src/mcp-server/workflows.js

  Plans to improve:
  ${cards.map((c, i) => `${i + 1}. ${c.topic} — ${c.planFile}`).join('\n')}

  Work through all plans in one continuous session. Do not stop after each plan for confirmation.
  ```
- `_generateBatchLowComplexityPrompt(cards: KanbanCard[]): string` — generates:
  ```
  Implement all ${cards.length} LOW-complexity plans from the PLANNED column. Use get_kanban_state MCP tool with complexity filter if available. If MCP unavailable, plans listed below.

  For each plan:
  1. Read the plan file for implementation steps
  2. Read the referenced source files
  3. Make the changes as specified (use multi_edit for multiple changes to same file)
  4. Verify with npm run compile
  5. Move to next plan

  Work serially through all plans. Each plan is small scope (routine changes, single-file edits, or simple UI additions). Do not stop between plans.

  Plans to implement:
  ${cards.map((c, i) => `${i + 1}. ${c.topic} (${c.complexity}) — ${c.planFile}`).join('\n')}

  After completing all plans, summarize what was changed and any verification steps needed.
  ```
- Both use `vscode.env.clipboard.writeText(prompt)` to copy.

### Step 5 — Auto-advance cards on prompt copy (Moderate)
- After clipboard write, call the existing column-advance mechanism to move affected cards.
- For BATCH PLANNER: move CREATED → PLAN REVIEWED for all affected session IDs.
- For BATCH LOW: move PLAN REVIEWED → CODED for affected LOW-complexity session IDs.
- Use the existing `switchboard.advanceKanbanCard` command or directly update runsheet events.

### Step 6 — Jules button visibility (Routine)
- Listen for `visibleAgents` message in the webview. If `agents.jules === true`, show `#btn-jules-low`; otherwise hide it.
- On button click, post `{ type: 'julesLowComplexity' }` to the backend.

### Step 7 — Remove old refresh button (Routine)
- Remove the `<button class="btn-refresh">` from `.kanban-header` (line 386).
- Update the refresh event listener at line 870 to target `#btn-refresh-strip`.

## Verification Plan
1. `npm run compile` — no build errors.
2. Open kanban → controls strip visible beneath header with all 6 buttons.
3. AUTOBAN button toggles autoban state; indicator updates on columns.
4. CLI TRIGGERS toggle works as specified in sibling plan.
5. BATCH PLANNER: click → clipboard contains correct improve-plan prompt listing all CREATED cards → cards advance to PLAN REVIEWED.
6. BATCH LOW: click → clipboard contains correct coding prompt for LOW-complexity PLAN REVIEWED cards → those cards advance to CODED.
7. JULES LOW: button hidden when Jules disabled; visible when enabled; click dispatches to Jules.
8. REFRESH: board refreshes.
9. Close/reopen panel → strip renders correctly, CLI toggle state persists.

## Complexity Audit

### Band A — Routine
- HTML/CSS for the controls strip layout
- Refresh button relocation
- Jules button visibility toggle
- CLI triggers toggle (from sibling plan)

### Band B — Complex / Risky
- Prompt generation logic (must correctly enumerate cards, handle edge cases like 0 cards)
- Auto-advance cards after clipboard copy (must update runsheet events atomically and refresh board)
- Race condition: if autoban fires while batch prompt is being generated, cards could double-advance. Mitigation: disable autoban temporarily during batch operations, or check card column before advancing.

**Recommendation**: Send it to the **Lead Coder** — this involves coordinated frontend + backend changes with auto-advance logic and edge cases.
