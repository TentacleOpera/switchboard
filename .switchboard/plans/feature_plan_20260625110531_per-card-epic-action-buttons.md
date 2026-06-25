# Add Per-Card Action Buttons to Epic Cards in the Epics Tab

## Goal

Add inline action buttons (Copy Link, Send to Planner, Copy Planning Prompt) directly on each epic card in the Epics tab of `project.html`, so users can action epics without switching to the kanban board. This mirrors the per-card buttons that already exist on regular plan cards in the Kanban tab and supports the split-mode workflow (plan with planner → orchestrate) entirely from the Epics tab.

### Problem analysis & root cause

The Epics tab renders epic cards via `renderEpicList` (`project.js:1285-1324`). Each card shows only the topic, workspace/time metadata, and a subtasks accordion. All epic actions (Orchestrate, +Subtask, Delete) live in the **meta-bar** (`renderEpicMetaBar`, `project.js:1345-1412`) which only appears after selecting an epic and is positioned in the preview pane — not on the card itself.

Meanwhile, regular plan cards in the Kanban tab (`project.js:928-944`) already have inline per-card buttons: "Copy Link" (copies the plan file path via `toAgentRef`) and "Copy Prompt" (sends `copyKanbanPlanPrompt` to the backend, which calls `switchboard.copyPlanFromKanban`). Epic cards have none of these.

The root cause is that the epic-orchestration-onramp plan (Phase 2) added epic management actions only to the meta-bar, not to the cards themselves. The "How to run an epic" explainer recommends dragging the epic to the Planner column for split mode — but the user has to go to the kanban board to do that. Adding "Send to Planner" (move to planner column) and "Copy Planning Prompt" (copy the planner's batch prompt for the epic) as per-card buttons eliminates the need to manage epics on the board.

## Metadata

- **Tags:** `feature`, `ui`, `epics-tab`, `backend`
- **Complexity:** 4/10 (frontend card rendering + reusing existing backend handlers for copy/move; one new backend handler for epic-specific planner prompt)

## Complexity Audit

### Routine
- Adding per-card buttons to the epic card `innerHTML` in `renderEpicList` (`project.js:1294-1300`) — follows the exact pattern of regular plan cards (`project.js:934-942`).
- Wiring "Copy Link" — copy epic plan file path via `toAgentRef` (`sharedUtils.js:7`), identical to `project.js:955-964`.
- Wiring "Send to Planner" — send `moveKanbanPlanColumn` with the epic's plan file and the planner column id, reusing the existing handler at `PlanningPanelProvider.ts:2635-2651`.
- CSS for the action row — reuse `.kanban-plan-actions` / `.kanban-plan-copy-link` / `.kanban-plan-copy-prompt` classes already defined for regular plan cards.

### Complex / Risky
- **"Copy Planning Prompt" for an epic** — the existing `copyKanbanPlanPrompt` handler (`PlanningPanelProvider.ts:2617-2633`) calls `switchboard.copyPlanFromKanban(sessionId, column, wsRoot)`. For an epic, this should assemble the **planner's** batch prompt covering all subtasks (with `EPIC_ORCHESTRATION_DIRECTIVE`). Need to verify that `copyPlanFromKanban` handles epic expansion the same way the board dispatch does (`_cardsToPromptPlans` at `KanbanProvider.ts:2407+`). If it does not, a new `copyEpicPlannerPrompt` backend handler is needed that calls `buildKanbanBatchPrompt('planner', …)` with the epic's expanded subtasks.
- **Standalone epic documents** — cards with `plan.isEpicDocument === true` have no DB record and no subtasks; the action buttons should be hidden for these (matching the `isManageable` guard at `project.js:1351`).
- **Planner column id resolution** — the planner column id is not hardcoded; it must be resolved from `_kanbanAvailableColumns` by matching the role `'planner'` or the column label. Need to verify how columns map to roles (`columnToPromptRole` at `agentPromptBuilder.ts:1200-1218`).

## Edge-Case & Dependency Audit

- **Standalone epic documents:** `plan.isEpicDocument === true` cards get no action buttons (no sessionId, no DB record — same guard as the meta-bar's `isManageable` check at `project.js:1351`).
- **No planner column configured:** If the kanban board has no Planner column (user customized columns), "Send to Planner" should show a toast: "No Planner column found on the kanban board." Do not silently fail.
- **Epic not on the kanban board:** If the epic has no `planFile` or no kanban column, "Copy Link" and "Copy Planning Prompt" should be hidden (matching the `plan.planFile ?` guard on regular cards at `project.js:939`).
- **No confirmation dialogs** (project rule) — "Send to Planner" moves the epic immediately, like any other column move.
- **Click propagation:** Per-card button clicks must `e.stopPropagation()` to avoid triggering the card's select handler (`project.js:1303-1309`), matching the pattern at `project.js:957-964`.
- **Existing meta-bar buttons:** The meta-bar Orchestrate / +Subtask / Delete buttons remain. The per-card buttons are additive — they provide quick actions without selecting the epic first. The meta-bar still appears on selection for full management.

## Proposed Changes

### `src/webview/project.js` — `renderEpicList` (lines 1285-1324)

**1. Add an action row to each epic card's `innerHTML` (after the subtasks accordion, ~line 1300):**

```javascript
const isManageable = plan && !plan.isEpicDocument;
const actionButtons = isManageable ? `
    <div class="kanban-plan-actions" style="margin-top: 6px;">
        ${plan.planFile ? `<button class="kanban-plan-copy-link epic-card-action" data-plan-file="${escapeHtml(plan.planFile)}">Copy Link</button>` : ''}
        ${plan.sessionId ? `<button class="kanban-plan-copy-prompt epic-card-action" data-session-id="${escapeHtml(plan.sessionId)}" data-workspace-root="${escapeHtml(plan.workspaceRoot || '')}" data-epic-id="${escapeHtml(plan.planId || '')}">Copy Planning Prompt</button>` : ''}
        ${plan.sessionId ? `<button class="epic-send-to-planner epic-card-action" data-plan-file="${escapeHtml(plan.planFile || '')}" data-workspace-root="${escapeHtml(plan.workspaceRoot || '')}">Send to Planner</button>` : ''}
    </div>
` : '';
```

Insert `${actionButtons}` into the card `innerHTML` after the `</details>` closing tag.

**2. Wire the per-card buttons (after the accordion toggle listener, ~line 1321):**

```javascript
// Copy Link — same pattern as regular plan cards (project.js:955-964)
const epicCopyLinkBtn = itemDiv.querySelector('.epic-card-action.kanban-plan-copy-link');
if (epicCopyLinkBtn) {
    epicCopyLinkBtn.addEventListener('click', e => {
        e.stopPropagation();
        const filePath = epicCopyLinkBtn.dataset.planFile;
        navigator.clipboard.writeText(toAgentRef(filePath)).then(() => {
            epicCopyLinkBtn.textContent = 'Copied';
            setTimeout(() => epicCopyLinkBtn.textContent = 'Copy Link', 2000);
        });
    });
}

// Copy Planning Prompt — reuse copyKanbanPlanPrompt with the epic's column
const epicCopyPromptBtn = itemDiv.querySelector('.epic-card-action.kanban-plan-copy-prompt');
if (epicCopyPromptBtn) {
    epicCopyPromptBtn.addEventListener('click', e => {
        e.stopPropagation();
        vscode.postMessage({
            type: 'copyEpicPlannerPrompt',
            sessionId: epicCopyPromptBtn.dataset.sessionId,
            workspaceRoot: epicCopyPromptBtn.dataset.workspaceRoot
        });
        epicCopyPromptBtn.textContent = 'Copied';
        setTimeout(() => epicCopyPromptBtn.textContent = 'Copy Planning Prompt', 2000);
    });
}

// Send to Planner — move the epic to the Planner column
const epicSendPlannerBtn = itemDiv.querySelector('.epic-send-to-planner');
if (epicSendPlannerBtn) {
    epicSendPlannerBtn.addEventListener('click', e => {
        e.stopPropagation();
        const planFile = epicSendPlannerBtn.dataset.planFile;
        const wsRoot = epicSendPlannerBtn.dataset.workspaceRoot;
        // Resolve the planner column id from available columns
        const plannerCol = _kanbanAvailableColumns.find(c =>
            c.role === 'planner' || /planner/i.test(c.label || c.id));
        if (!plannerCol) {
            showToast('No Planner column found on the kanban board.', 'error');
            return;
        }
        vscode.postMessage({
            type: 'moveKanbanPlanColumn',
            planFile,
            newColumn: plannerCol.id,
            workspaceRoot: wsRoot
        });
        epicSendPlannerBtn.textContent = 'Sent';
        setTimeout(() => epicSendPlannerBtn.textContent = 'Send to Planner', 2000);
    });
}
```

### `src/services/PlanningPanelProvider.ts` — New `copyEpicPlannerPrompt` handler

**3. Add a new message handler (near `copyKanbanPlanPrompt` at line 2617):**

```typescript
case 'copyEpicPlannerPrompt': {
    const sessionId = String(msg.sessionId || '');
    const wsRoot = String(msg.workspaceRoot || workspaceRoot);
    if (!sessionId || !this._kanbanProvider) {
        this._projectPanel?.webview.postMessage({ type: 'kanbanPlanPromptCopied', success: false, sessionId: '', error: 'No sessionId or kanban provider' });
        break;
    }
    try {
        // Assemble the planner's batch prompt for this epic (expands subtasks
        // with EPIC_ORCHESTRATION_DIRECTIVE, same as board dispatch).
        const success = await vscode.commands.executeCommand<boolean>(
            'switchboard.copyPlanFromKanban', sessionId, 'planner', wsRoot
        );
        this._projectPanel?.webview.postMessage({ type: 'kanbanPlanPromptCopied', success: !!success, sessionId });
    } catch (err) {
        this._projectPanel?.webview.postMessage({ type: 'kanbanPlanPromptCopied', success: false, sessionId, error: String(err) });
    }
    break;
}
```

> **Note:** Verify that `switchboard.copyPlanFromKanban` expands epic subtasks the same way the board dispatch does (`_cardsToPromptPlans` at `KanbanProvider.ts:2407+`). If it does not handle epic expansion, the handler must call `buildKanbanBatchPrompt('planner', …)` directly with the epic's expanded subtask plans. Check the command registration in `extension.ts` for `copyPlanFromKanban`.

### `src/webview/project.html` — CSS (optional, if epic cards need action-row styling)

**4. Ensure `.kanban-plan-actions` flex layout applies to epic cards:**

The `.kanban-plan-actions` class is already defined for regular plan cards. If epic cards use a different container class (`.epic-plan-item`), add a rule:

```css
.epic-plan-item .kanban-plan-actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    align-items: center;
}
.epic-card-action {
    font-size: 10px;
    padding: 2px 6px;
    border: 1px solid var(--border-color);
    border-radius: 3px;
    cursor: pointer;
    background: transparent;
    color: var(--text-secondary);
}
.epic-card-action:hover {
    border-color: var(--accent-teal);
    color: var(--text-primary);
}
```

## Verification Plan

> Manual verification against an installed VSIX (per project norm).

### Manual Verification

1. **Copy Link:** Click "Copy Link" on an epic card → clipboard contains the epic's plan file path. Button shows "Copied" for 2 seconds. Card is not selected (click does not trigger selection).
2. **Copy Planning Prompt:** Click "Copy Planning Prompt" on an epic card → clipboard contains the planner's batch prompt for the epic (orchestrator directive + subtask list). Button shows "Copied" for 2 seconds.
3. **Send to Planner:** Click "Send to Planner" on an epic card → the epic moves to the Planner column on the kanban board. Button shows "Sent" for 2 seconds. Verify on the kanban board that the epic is now in the Planner column.
4. **No Planner column:** If the kanban board has no Planner column, clicking "Send to Planner" shows a toast error and does not move the epic.
5. **Standalone epic documents:** Cards for standalone epic documents (`.switchboard/epics/*.md` with no DB record) show no action buttons.
6. **Click propagation:** Clicking any per-card button does not select the epic card or open the preview pane (stopPropagation works).
7. **Meta-bar still works:** Selecting an epic still shows the meta-bar with Orchestrate / +Subtask / Delete — the per-card buttons are additive.
8. **Theme check:** Buttons render correctly in afterburner, claudify, and cyber themes.
