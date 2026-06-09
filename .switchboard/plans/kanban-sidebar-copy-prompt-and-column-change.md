# Add Copy Prompt and Column Change to Kanban Sidebar Cards

## Goal
In the Kanban Plans tab of `planning.html` (the sidebar), each plan card currently only offers "Copy Link". We need two enhancements:
1. A **"Copy Prompt"** button alongside "Copy Link" that copies a role-specific prompt for the plan *and* advances the card to the next kanban column (same behaviour as the main Kanban board).
2. The **column status pill** on each card should become a dropdown that lets the user move the plan to any available kanban column.

These changes must work correctly when a user is managing the board from the Planning Panel sidebar and later opens the main Kanban view — all state changes must be persisted to the database.

**Root Cause / Background:** The sidebar cards are rendered in `renderKanbanPlans` (`src/webview/planning.js:3370`). The copy-prompt logic already exists in `TaskViewerProvider._handleCopyPlanLink` (`src/services/TaskViewerProvider.ts:13283`), but it is only wired up for the main Kanban board and the Task Viewer. The existing command `switchboard.copyPlanFromKanban` in `extension.ts:1069` already delegates to `taskViewerProvider.handleKanbanCopyPlan`, so `PlanningPanelProvider` can reuse this without adding new cross-service dependencies.

**CRITICAL CODE STATE NOTE (as of plan improvement):** The frontend implementation described in the original plan **already exists** in the codebase:
- `renderKanbanPlans` at `planning.js:3370` already renders the Copy Prompt button (line 3436), clickable column badge (line 3431), and column dropdown (line 3432)
- Event listeners for all three are already wired (lines 3497-3553)
- Frontend message handlers for `kanbanPlanPromptCopied` and `kanbanPlanColumnChanged` already exist (lines 2591-2612)
- **What is MISSING:** Backend handlers in `PlanningPanelProvider.ts` and CSS styles in `planning.html`

## Metadata
**Complexity:** 3
**Tags:** ui, frontend, backend, feature

## User Review Required
- Verify that the `moveKanbanPlanColumn` handler should use `KanbanProvider.moveCardToColumnByPlanFile` (which handles worktree assignment, integration sync, and auto-commit) rather than calling `KanbanDatabase.updateColumnByPlanFile` directly.

## Complexity Audit

### Routine
- Adding two `case` branches to `_handleMessage` switch in `PlanningPanelProvider.ts`
- Adding CSS styles for `.kanban-plan-copy-prompt`, `.kanban-column-badge.clickable`, and `.kanban-column-dropdown`
- The `copyKanbanPlanPrompt` handler delegates to an existing command that already handles clipboard copy + column advance

### Complex / Risky
- **`moveKanbanPlanColumn` must use `KanbanProvider.moveCardToColumnByPlanFile`** — calling `KanbanDatabase.updateColumnByPlanFile` directly would bypass worktree assignment (for CODER CODED columns), auto-commit on CODE REVIEWED transition, worktree cleanup on COMPLETED, and ClickUp/Linear integration sync. This is the most important architectural decision in this plan.
- **`_handleCopyPlanLink` posts `copyPlanLinkResult` to `this._view` (TaskViewer webview), not the PlanningPanel webview.** The `copyKanbanPlanPrompt` handler must send its own `kanbanPlanPromptCopied` response to `this._panel.webview` based on the command's boolean return value, not rely on the command's internal postMessage.

## Edge-Case & Dependency Audit
- **Race Conditions:** Rapid clicks on Copy Prompt could fire multiple `copyKanbanPlanPrompt` messages. The existing `_handleCopyPlanLink` is idempotent for clipboard writes, but column advance could race. Mitigate by disabling the button immediately on click (already done in frontend: `copyPromptBtn.textContent = 'Copying…'`).
- **Security:** `msg.workspaceRoot` must be validated against known workspace roots before being passed to `KanbanProvider`. The existing `_resolveWorkspaceRoot` pattern handles this.
- **Side Effects:** `moveCardToColumnByPlanFile` triggers integration sync (ClickUp/Linear) and worktree operations. These are intentional and desired — the sidebar should have parity with the main board.
- **Dependencies & Conflicts:** No conflicts with existing handlers. The `copyKanbanPlanPrompt` and `moveKanbanPlanColumn` message types are not currently handled (they fall through to `default`).

## Dependencies
- `switchboard.copyPlanFromKanban` command (registered in `extension.ts:1069`) — already exists
- `KanbanProvider.moveCardToColumnByPlanFile` (`src/services/KanbanProvider.ts:3971`) — already exists

## Adversarial Synthesis
Key risks: (1) Direct DB call for column change would bypass worktree/integration side effects — must use `KanbanProvider.moveCardToColumnByPlanFile` instead. (2) `_handleCopyPlanLink` posts response to wrong webview — handler must send its own response. Mitigations: delegate to existing KanbanProvider method; check command return value and post to `this._panel`.

## Requirements

### 1. Copy Prompt Button
- Add a small button next to "Copy Link" in each sidebar card. **[ALREADY IMPLEMENTED in frontend]**
- On click, send a message to the extension host that copies the appropriate prompt (based on the card's current column) to the clipboard. **[ALREADY IMPLEMENTED in frontend]**
- The backend must trigger the same advance logic as the main Kanban board so the card moves to the next column. **[NEEDS BACKEND HANDLER]**
- The UI should show transient feedback (e.g., button text changes to "Copied!"). **[ALREADY IMPLEMENTED in frontend]**

### 2. Clickable Column Status Pill
- Convert the static `<span class="kanban-column-badge">` into a clickable dropdown. **[ALREADY IMPLEMENTED in frontend]**
- Clicking the badge opens a small inline `<select>` dropdown listing all `_kanbanAvailableColumns`. **[ALREADY IMPLEMENTED in frontend]**
- Selecting a column sends a message to the extension host to update the plan's column in the Kanban database. **[NEEDS BACKEND HANDLER]**
- After a successful update, the sidebar list should refresh to show the new column badge. **[ALREADY IMPLEMENTED in frontend]**

### 3. Backend Message Handlers **[ALL NEEDS IMPLEMENTATION]**
- `PlanningPanelProvider` must handle two new webview message types:
  - `copyKanbanPlanPrompt` — execute the existing VS Code command `switchboard.copyPlanFromKanban` (which delegates to `TaskViewerProvider.handleKanbanCopyPlan`) using the plan's `sessionId` and `column`. Post `kanbanPlanPromptCopied` back to the webview.
  - `moveKanbanPlanColumn` — use `KanbanProvider.moveCardToColumnByPlanFile(workspaceRoot, planFile, newColumn)` to set the new column (NOT `KanbanDatabase.updateColumnByPlanFile` directly — that bypasses worktree and integration side effects), then post `kanbanPlanColumnChanged` and trigger a re-fetch.

### 4. State Consistency
- After any successful move or copy-prompt, the sidebar plan list must refresh so the card displays in the correct column. **[ALREADY IMPLEMENTED in frontend]**
- If the user has unsaved changes in the Kanban Plans preview pane, the existing dirty-flag check must still guard plan selection (but not block these inline actions). **[ALREADY IMPLEMENTED — `e.stopPropagation()` on both buttons]**

### 5. CSS Styles **[NEEDS IMPLEMENTATION]**
- `.kanban-plan-copy-prompt` — mirror `.kanban-plan-copy-link` styles
- `.kanban-column-badge.clickable` — cursor: pointer
- `.kanban-column-dropdown` — absolute positioning, background, border, z-index

## Edge Cases
- **No sessionId**: Some plans may have a `planFile` but no `sessionId`. The copy-prompt action should gracefully degrade (button hidden or disabled). **[ALREADY HANDLED — button is gated on `plan.sessionId` in template literal at line 3436]**
- **No next column**: If a plan is in the last column, the copy-prompt should still copy the prompt but not attempt to advance. `TaskViewerProvider._handleCopyPlanLink` already handles this.
- **Column validation**: The dropdown should only show columns that are valid for the current workspace (already fetched in `_kanbanAvailableColumns`). **[ALREADY IMPLEMENTED]**
- **Dirty state**: Clicking "Copy Prompt" or changing the column should not trigger the "unsaved changes" discard confirmation if the user is only acting on the card in the sidebar list, not selecting it for preview. Use `e.stopPropagation()`. **[ALREADY IMPLEMENTED]**
- **Multi-workspace**: Both actions must include the correct `workspaceRoot` so the backend operates on the right database. **[ALREADY IMPLEMENTED in frontend — `data-workspace-root` attribute on both buttons and dropdown]**

## Proposed Changes

### `src/services/PlanningPanelProvider.ts`
- **Context:** `_handleMessage` switch at line 911
- **Logic:** Add two new `case` branches after the existing `setKanbanPlanContext` case (around line 1647):
  1. `case 'copyKanbanPlanPrompt'` — resolve workspace root, execute `switchboard.copyPlanFromKanban` command, post `kanbanPlanPromptCopied` to `this._panel`
  2. `case 'moveKanbanPlanColumn'` — resolve workspace root, call `KanbanProvider.moveCardToColumnByPlanFile`, post `kanbanPlanColumnChanged` to `this._panel`
- **Implementation:**
  ```typescript
  case 'copyKanbanPlanPrompt': {
      const sessionId = String(msg.sessionId || '');
      const column = String(msg.column || '');
      const wsRoot = String(msg.workspaceRoot || workspaceRoot);
      if (!sessionId) {
          this._panel?.webview.postMessage({ type: 'kanbanPlanPromptCopied', success: false, sessionId: '', error: 'No sessionId' });
          break;
      }
      try {
          const success = await vscode.commands.executeCommand<boolean>(
              'switchboard.copyPlanFromKanban', sessionId, column, wsRoot
          );
          this._panel?.webview.postMessage({ type: 'kanbanPlanPromptCopied', success: !!success, sessionId });
      } catch (err) {
          this._panel?.webview.postMessage({ type: 'kanbanPlanPromptCopied', success: false, sessionId, error: String(err) });
      }
      break;
  }
  case 'moveKanbanPlanColumn': {
      const planFile = String(msg.planFile || '');
      const newColumn = String(msg.newColumn || '');
      const wsRoot = String(msg.workspaceRoot || workspaceRoot);
      if (!planFile || !newColumn) {
          this._panel?.webview.postMessage({ type: 'kanbanPlanColumnChanged', success: false, error: 'Missing planFile or newColumn' });
          break;
      }
      try {
          // Use KanbanProvider.moveCardToColumnByPlanFile (NOT KanbanDatabase.updateColumnByPlanFile)
          // to ensure worktree assignment, integration sync, and auto-commit logic fire correctly.
          const moved = await vscode.commands.executeCommand<boolean>(
              'switchboard.moveKanbanCardByPlanFile', wsRoot, planFile, newColumn
          );
          this._panel?.webview.postMessage({ type: 'kanbanPlanColumnChanged', success: !!moved, error: moved ? undefined : 'Column update failed' });
      } catch (err) {
          this._panel?.webview.postMessage({ type: 'kanbanPlanColumnChanged', success: false, error: String(err) });
      }
      break;
  }
  ```
- **Edge Cases:** Empty sessionId/planFile guarded; workspace root validated by command handler; command return value checked

### `src/webview/planning.html`
- **Context:** After `.kanban-plan-copy-link:hover` styles (around line 2090)
- **Logic:** Add CSS for the three new selectors
- **Implementation:**
  ```css
  .kanban-plan-copy-prompt {
      background: transparent;
      border: 1px solid var(--border-color);
      color: var(--text-secondary);
      font-size: 10px;
      padding: 2px 8px;
      border-radius: 10px;
      cursor: pointer;
      transition: all 0.15s;
      white-space: nowrap;
  }
  .kanban-plan-copy-prompt:hover {
      background: var(--accent-teal);
      color: var(--panel-bg);
      border-color: var(--accent-teal);
  }
  .kanban-column-badge.clickable {
      cursor: pointer;
  }
  .kanban-column-badge.clickable:hover {
      opacity: 0.8;
  }
  .kanban-column-dropdown {
      position: absolute;
      background: var(--panel-bg2);
      border: 1px solid var(--border-color);
      border-radius: 4px;
      padding: 2px;
      z-index: 100;
      font-size: 11px;
      color: var(--text-primary);
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
  }
  ```

### `src/extension.ts` (Clarification)
- **Context:** Near existing `copyPlanFromKanban` command registration (line 1069)
- **Logic:** Register a new `switchboard.moveKanbanCardByPlanFile` command that delegates to `KanbanProvider.moveCardToColumnByPlanFile`. This is needed because `PlanningPanelProvider` does not hold a direct reference to `KanbanProvider`; it accesses it through commands.
- **Implementation:**
  ```typescript
  const moveKanbanCardByPlanFileDisposable = vscode.commands.registerCommand(
      'switchboard.moveKanbanCardByPlanFile',
      async (workspaceRoot: string, planFile: string, targetColumn: string) => {
          return await kanbanProvider.moveCardToColumnByPlanFile(workspaceRoot, planFile, targetColumn);
      }
  );
  context.subscriptions.push(moveKanbanCardByPlanFileDisposable);
  ```
- **Edge Cases:** `moveCardToColumnByPlanFile` already handles workspace ID resolution, worktree ops, and integration sync internally

## Verification Plan

### Automated Tests
- No new automated tests required for this scope (UI-only changes with backend delegation to existing tested methods)

### Manual Verification
1. Open Planning Panel → Kanban Plans tab → click "Copy Prompt" on a CREATED plan. Verify clipboard contains a prompt and the card moves to the next column on refresh.
2. Click the column badge on any card, select a different column, verify the badge updates and the card remains selectable.
3. Move a plan to "CODER CODED" via the dropdown — verify worktree is assigned (check Worktrees tab).
4. Move a plan to "COMPLETED" via the dropdown — verify worktree cleanup fires.
5. Regression: ensure "Copy Link" and plan selection still work as before.
6. Verify Copy Prompt button does NOT appear on plans without a `sessionId`.

## Recommendation
**Complexity 3 → Send to Coder** (was 5, downgraded because frontend is already implemented; only backend handlers + CSS remain)

---

## Execution Results

**Status:** ✅ COMPLETED

**Files Changed:**
1. `src/services/PlanningPanelProvider.ts` - Added two message handlers (`copyKanbanPlanPrompt`, `moveKanbanPlanColumn`) after `setKanbanPlanContext` case (lines 1709-1744)
2. `src/webview/planning.html` - Added CSS styles for `.kanban-plan-copy-prompt`, `.kanban-column-badge.clickable`, and `.kanban-column-dropdown` (lines 2087-2119)
3. `src/extension.ts` - Registered `switchboard.moveKanbanCardByPlanFile` command that delegates to `KanbanProvider.moveCardToColumnByPlanFile` (lines 1076-1082)

**Implementation Notes:**
- `copyKanbanPlanPrompt` handler delegates to existing `switchboard.copyPlanFromKanban` command, posts response to `this._panel.webview`
- `moveKanbanPlanColumn` handler uses new `switchboard.moveKanbanCardByPlanFile` command (not direct DB call), ensuring worktree assignment, integration sync, and auto-commit logic fire correctly
- Both handlers validate required parameters and post appropriate success/error messages to webview
- CSS styles match existing design patterns (hover states, transitions, z-index for dropdown)

**Validation:**
- Manual verification required per plan (open Planning Panel → Kanban Plans tab, test Copy Prompt and column dropdown)
- No automated tests added per plan scope (UI-only changes with backend delegation to existing tested methods)

**Remaining Risks:**
- None identified - implementation follows plan exactly with proper architectural decisions (using KanbanProvider method instead of direct DB call)

---

## Reviewer Pass (In-Place)

**Reviewer:** Grumpy Principal Engineer
**Date:** 2026-06-07

### Stage 1: Adversarial Findings

| # | Severity | Finding | Location |
|---|----------|---------|----------|
| 1 | NIT | `.kanban-plan-copy-prompt` CSS missing `margin-left: auto` and `font-family: var(--font-family)` — when Copy Link is absent (plan has sessionId but no planFile), Copy Prompt stays left-aligned instead of right-aligned, creating layout inconsistency vs Copy Link | `planning.html:2087-2097` |
| 2 | NIT | `kanbanPlanColumnChanged` response lacks `planFile` field for traceability (frontend doesn't use it, so no functional impact) | `PlanningPanelProvider.ts:1771` |

**No CRITICAL or MAJOR findings.** Both key architectural decisions from the plan are correctly implemented:
1. `moveKanbanPlanColumn` delegates to `switchboard.moveKanbanCardByPlanFile` → `KanbanProvider.moveCardToColumnByPlanFile` (not direct DB call) ✅
2. `copyKanbanPlanPrompt` posts its own `kanbanPlanPromptCopied` to `this._panel.webview` (not relying on `_handleCopyPlanLink`'s internal postMessage to `this._view`) ✅

### Stage 2: Balanced Synthesis

- **Keep**: All backend handler logic, command registration, frontend event wiring, message handlers — architecturally sound and consistent with existing patterns.
- **Fix now**: Finding #1 — CSS `margin-left: auto` and `font-family` gap on `.kanban-plan-copy-prompt`. One-line fix preventing visible layout inconsistency.
- **Defer**: Finding #2 — `planFile` in `kanbanPlanColumnChanged` response. No functional impact.

### Fixes Applied

1. **`src/webview/planning.html:2087-2099`** — Added `font-family: var(--font-family)` and `margin-left: auto` to `.kanban-plan-copy-prompt` CSS rule, matching `.kanban-plan-copy-link` at line 2069-2081. This ensures Copy Prompt is right-aligned when Copy Link is absent.

### Validation

- Skip compilation per instructions
- Skip automated tests per instructions
- Manual verification still required per original plan (open Planning Panel → Kanban Plans tab, test Copy Prompt and column dropdown)

### Updated Remaining Risks

- **Low**: When both Copy Link and Copy Prompt are present, both have `margin-left: auto`. In a flex row, the first auto-margined element (Copy Link) consumes available space, pushing both buttons right. Copy Prompt's auto margin has no visible effect in this case. No layout regression expected.
- **Low**: `kanbanPlanColumnChanged` response doesn't include `planFile` — could be added later if frontend needs it for targeted DOM updates instead of full re-fetch.

