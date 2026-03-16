# Have 'cli trigger' switch at top of kanban

## Notebook Plan

At top of kanban, have a switch called CLI Triggers that defaults to on, and when off, allows the user to move the cards back and forward to columns as described in

[Allow plans to be moved backwards in Kanban](file:///c%3A/Users/patvu/Documents/GitHub/switchboard/.switchboard/plans/feature_plan_20260313_140058_allow_plans_to_be_moved_backwards_in_kanban.md)

This is to allow the user to 'fix' the board in case of card location errors.

## Goal
- Add a toggle switch labelled **"CLI Triggers"** to the kanban board header area. When **ON** (default), drag-drop between columns triggers CLI agent actions as normal. When **OFF**, drag-drop simply repositions cards without firing any agent commands — enabling manual board correction.
- The toggle state should persist across panel reopen (use `workspaceState`).

## Dependencies
- **"Allow plans to be moved backwards in Kanban"** (sess_1773370858568, currently in CODED column) — that plan enables backward drag-drop. This plan builds on top of it by adding the ability to suppress CLI triggers during those moves.
- **"Add main controls strip at top of kanban board"** (sess_1773604319807, CREATED) — that plan proposes a controls strip that includes a CLI TRIGGER button. These two plans **overlap**. Recommendation: implement the toggle here first as a standalone, then the controls strip plan can relocate it into the strip.

## Proposed Changes

### Step 1 — Add toggle state to KanbanProvider (Routine)
- **File**: `src/services/KanbanProvider.ts`
- Add a private field `_cliTriggersEnabled: boolean = true;` initialized from `this._context.workspaceState.get<boolean>('kanban.cliTriggersEnabled', true)`.
- Add a public getter `get cliTriggersEnabled(): boolean`.
- Add a handler in `_handleMessage` for a new message type `'toggleCliTriggers'`:
  ```ts
  case 'toggleCliTriggers':
      this._cliTriggersEnabled = !!msg.enabled;
      await this._context.workspaceState.update('kanban.cliTriggersEnabled', this._cliTriggersEnabled);
      break;
  ```
- In the existing `case 'triggerAction'` handler (line ~575), wrap the agent dispatch in a guard:
  ```ts
  if (!this._cliTriggersEnabled) break; // silent move, no CLI trigger
  ```
- On `_refreshBoard`, send the current state to the webview: `this._panel.webview.postMessage({ type: 'cliTriggersState', enabled: this._cliTriggersEnabled });`

### Step 2 — Add toggle UI to kanban.html (Routine)
- **File**: `src/webview/kanban.html`
- In the `.kanban-header` div (line 384), add a toggle switch element between the title and the refresh button:
  ```html
  <label class="cli-toggle" title="When OFF, drag-drop moves cards without triggering CLI agent actions">
      <input type="checkbox" id="cli-triggers-toggle" checked>
      <span class="toggle-label">CLI Triggers</span>
  </label>
  ```
- Add CSS for the toggle: a small mono-font switch with teal accent color matching existing design system (`--accent-teal`, `--font-mono`, `font-size: 10px`).
- Add JS: listen for `change` event on the checkbox, post `{ type: 'toggleCliTriggers', enabled: checkbox.checked }` to vscode.
- Add JS: listen for incoming `cliTriggersState` message to sync toggle state on load/refresh.

### Step 3 — Visual feedback when triggers are off (Routine)
- When CLI Triggers are OFF, add a subtle visual indicator — e.g. dim the kanban title text or show a small `⚠ TRIGGERS OFF` badge next to the toggle — so the user doesn't forget they disabled triggers.

## Verification Plan
1. `npm run compile` — no build errors.
2. Open kanban board → toggle should appear in header, default ON.
3. With toggle ON: drag a card between columns → verify CLI agent is triggered (terminal command fires).
4. With toggle OFF: drag a card between columns → verify card moves but **no** CLI action is dispatched.
5. With toggle OFF: drag a card **backwards** (e.g. CODED → PLAN REVIEWED) → verify the card repositions without error.
6. Close and reopen kanban panel → verify toggle retains its last state.
7. Re-enable toggle → verify normal drag-drop triggers resume.

## Complexity Audit

### Band A — Routine
- Add boolean state + persistence to KanbanProvider
- Add checkbox toggle to kanban.html
- Guard existing triggerAction handler

### Band B — Complex / Risky
- None

**Recommendation**: Send it to the **Coder agent** — straightforward toggle with no complex logic.
