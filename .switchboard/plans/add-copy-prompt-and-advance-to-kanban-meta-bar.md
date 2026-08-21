# Add Copy Prompt and Advance Buttons to Project.html Kanban Plans Meta-Bar

## Goal

### Problem

The kanban plans tab in project.html has no Copy Prompt or Advance button in its meta-bar (the function bar above the document preview). These actions exist only on sidebar cards, which is the same discoverability problem as Copy Link. Additionally, the kanban board (kanban.html) has a distinct "Advance" action (move to next column + auto-dispatch prompt to terminal) that is completely absent from the project.html plans tab.

### Background

The kanban board (kanban.html) has two distinct column-advancement actions per card:
- **Copy Prompt** (`promptSelected` verb): copies the next-stage prompt to clipboard AND advances the card to the next column. Does NOT dispatch to a terminal.
- **Advance / Move** (`moveSelected` verb): advances the card to the next column AND auto-delivers the prompt to the appropriate agent terminal (CLI dispatch). Does NOT copy to clipboard.

The project.html kanban plans tab currently only has Copy Prompt on sidebar cards (which sends `copyKanbanPlanPrompt` → backend calls `promptSelected`). There is no Advance/Move button anywhere — the only way to advance a plan's column from the plans tab is via the column dropdown (which changes the column without dispatching to a terminal or copying a prompt).

### Root Cause

The project.html kanban meta-bar (`renderKanbanMetaBar()` in project.js) was built with management actions (Column, Complexity, Edit, Save, Cancel, Review, Upload, Log, Delete) but was never given the workflow-advancement actions that the kanban board has. The Copy Prompt button was added to sidebar cards as a convenience but never promoted to the meta-bar. The Advance/Move action was never implemented for the plans tab at all — it only exists on the kanban board.

## Metadata

**Complexity:** 5
**Tags:** frontend, backend, ui, ux, feature
**Project:** Browser Switchboard

## Affected Files

### Frontend (JS)
- `src/webview/project.js` — add Copy Prompt + Advance buttons to `renderKanbanMetaBar()` (~line 1968); remove Copy Prompt from kanban plan sidebar card template (~line 1716) and its event listener (~lines 1743-1763)

### Backend (TS)
- `src/services/PlanningPanelProvider.ts` — add `advanceKanbanPlan` message handler (~line 3886, after `moveKanbanPlanColumn` handler) that calls `handleServiceVerb('moveSelected', ...)`
- `src/generated/verbSchemas.ts` — add `advanceKanbanPlan` schema (~line 637, near `moveKanbanPlanColumn`)
- `src/generated/verbAllowlist.ts` — add `advanceKanbanPlan` to `PLANNING_VERBS` set (~line 9)

### Frontend (JS — vestigial)
- `src/webview/planning.js` — remove Copy Prompt from vestigial kanban plan card template (~line 5676) and its event listener (~lines 5723-5740)

## Implementation Plan

### Step 1: Add `advanceKanbanPlan` backend message handler

**PlanningPanelProvider.ts** (~line 3886, after the `moveKanbanPlanColumn` case):
Add a new case `advanceKanbanPlan` that:
1. Extracts `sessionId`, `column`, `workspaceRoot` from the message
2. Calls `this._kanbanProvider.handleServiceVerb('moveSelected', { sessionIds: [sessionId], column, workspaceRoot })`
3. Posts a result message back to the webview: `{ type: 'kanbanPlanAdvanced', success, sessionId, targetColumn }`

This mirrors the existing `copyKanbanPlanPrompt` handler (~line 3833) which calls `handleServiceVerb('promptSelected', ...)`.

**verbSchemas.ts** (~line 637):
Add schema for `advanceKanbanPlan`:
```
advanceKanbanPlan: {
    sessionId: { type: 'string' },
    column: { type: 'string' },
    workspaceRoot: { type: 'string' },
},
```

**verbAllowlist.ts** (~line 9):
Add `'advanceKanbanPlan'` to the `PLANNING_VERBS` set.

### Step 2: Add Copy Prompt button to kanban meta-bar

**project.js** — `renderKanbanMetaBar()` (~line 1968):

In the meta-bar innerHTML template, add a Copy Prompt button. Place it in the right group (near Review/Log/Delete) or in a new center group.

The button label should be derived from the plan's current column, using the same logic as the existing `_featureCopyPromptLabel()` function (~line 2307). However, for the kanban tab (not features tab), the label derivation should match the kanban board's approach: derive from the NEXT column's role, not the current column's stage. The existing `_getCopyLabel()` function in planning.js (~line 5381) does this. Project.js does not have an equivalent for the kanban tab — the sidebar card's Copy Prompt button just says "Copy Prompt" without a derived label.

**Decision**: Use the same label derivation as `_featureCopyPromptLabel()` in project.js, since it's already in the same file and handles all the column/kind cases. The label will be contextually appropriate (e.g., "Copy Coder Prompt" for plans in PLAN REVIEWED, "Copy Review Prompt" for plans in coded columns).

The button HTML:
```html
${copyPromptLabel ? `<button class="strip-btn" id="kanban-meta-copy-prompt-btn">${escapeHtml(copyPromptLabel)}</button>` : ''}
```

Where `copyPromptLabel` is computed from `plan.column` using the same logic as `_featureCopyPromptLabel()`.

Wire the click handler after innerHTML render:
```js
const copyPromptBtn = document.getElementById('kanban-meta-copy-prompt-btn');
if (copyPromptBtn) {
    copyPromptBtn.addEventListener('click', () => {
        copyPromptBtn.textContent = 'Copying…';
        vscode.postMessage({
            type: 'copyKanbanPlanPrompt',
            sessionId: plan.sessionId,
            column: plan.column,
            workspaceRoot: plan.workspaceRoot
        });
    });
}
```

Handle the `kanbanPlanPromptCopied` response message (already handled at ~line 868) — update the button text to "Copied!" / "Failed" and restore after 2s. The existing handler looks for `.kanban-plan-copy-prompt[data-session-id="..."]` — it needs to also check `#kanban-meta-copy-prompt-btn` or be generalized.

### Step 3: Add Advance button to kanban meta-bar

**project.js** — `renderKanbanMetaBar()` (~line 1968):

Add an Advance button next to the Copy Prompt button. The button should:
- Be labeled "Advance" (or "Advance →" for visual clarity)
- Be hidden when there is no next column (terminal column, or `_optimisticNextColumn()` returns null)
- On click: send `advanceKanbanPlan` message, show "Advancing…" feedback

The button HTML:
```html
${nextColumn ? `<button class="strip-btn" id="kanban-meta-advance-btn" title="Advance to ${escapeHtml(nextColumnLabel)} and dispatch to terminal">Advance</button>` : ''}
```

Where `nextColumn` is computed via `_optimisticNextColumn(plan.column)` and `nextColumnLabel` is the label of that column from `_kanbanAvailableColumns`.

Wire the click handler:
```js
const advanceBtn = document.getElementById('kanban-meta-advance-btn');
if (advanceBtn) {
    advanceBtn.addEventListener('click', () => {
        advanceBtn.textContent = 'Advancing…';
        advanceBtn.disabled = true;
        vscode.postMessage({
            type: 'advanceKanbanPlan',
            sessionId: plan.sessionId,
            column: plan.column,
            workspaceRoot: plan.workspaceRoot
        });
    });
}
```

Add a response handler for `kanbanPlanAdvanced` in the message listener (~line 868, near `kanbanPlanPromptCopied`):
```js
case 'kanbanPlanAdvanced': {
    const btn = document.getElementById('kanban-meta-advance-btn');
    if (btn) {
        btn.textContent = msg.success ? 'Advanced' : 'Failed';
        setTimeout(() => { btn.disabled = false; btn.textContent = 'Advance'; }, 2000);
    }
    if (msg.success) {
        vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });
    }
    break;
}
```

### Step 4: Remove Copy Prompt from sidebar cards

**project.js** — Kanban plan card template (~line 1716):
Remove `${plan.sessionId ? \`<button class="kanban-plan-copy-prompt" ...>Copy Prompt</button>\` : ''}` from the template string. Remove the `copyPromptBtn` event listener block (~lines 1743-1763).

**planning.js** — Vestigial kanban plan card template (~line 5676):
Remove the Copy Prompt button from the template string. Remove the `copyPromptBtn` event listener block (~lines 5723-5740).

### Step 5: Update `kanbanPlanPromptCopied` handler for meta-bar button

**project.js** (~line 868):
The existing `kanbanPlanPromptCopied` handler looks for `.kanban-plan-copy-prompt[data-session-id="..."]` which was the sidebar card button. Since that button is being removed, update the handler to also (or instead) check for `#kanban-meta-copy-prompt-btn`:

```js
case 'kanbanPlanPromptCopied': {
    const btn = document.getElementById('kanban-meta-copy-prompt-btn');
    if (btn) {
        const oldText = btn.textContent;
        btn.textContent = msg.success ? 'Copied!' : 'Failed';
        btn.disabled = true;
        setTimeout(() => { btn.textContent = oldText; btn.disabled = false; }, 2000);
    }
    if (msg.success) {
        vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });
    }
    break;
}
```

## Edge Cases & Risks

1. **PLAN REVIEWED complexity routing**: When advancing from PLAN REVIEWED, the backend routes to different coder columns (LEAD CODED, CODER CODED, INTERN CODED) based on complexity. The optimistic UI in the kanban board suppresses the optimistic move for PLAN REVIEWED when dynamic complexity routing is enabled (because the FE can't predict the exact target). The project.html plans tab doesn't do optimistic card moves (it re-fetches the plan list on success), so this is not an issue — the `fetchKanbanPlans` refresh after success will show the correct column.

2. **Terminal columns**: If the plan is in the last column (COMPLETED/ACCEPTANCE TESTED with no next), `_optimisticNextColumn()` returns null. Both Copy Prompt and Advance buttons should be hidden. The `_featureCopyPromptLabel()` function already returns `null` for terminal columns, which suppresses the Copy Prompt button. The Advance button's `nextColumn` guard does the same.

3. **DISPATCH display mode**: DISPATCH is a display mode of PLAN REVIEWED, not a real column. The kanban board resolves it to PLAN REVIEWED before calling getNextColumn. In project.js, `_optimisticNextColumn()` doesn't handle DISPATCH — it returns null for PLAN REVIEWED (line 1598: `if (currentColumn === 'PLAN REVIEWED') return null;`). This means plans in the DISPATCH display mode won't get an Advance button. This is acceptable — DISPATCH is a board-specific view that doesn't appear in the plans tab.

4. **No sessionId**: Some plans may not have a `sessionId` (only a `planFile`). The Copy Prompt button requires `sessionId` to send `copyKanbanPlanPrompt`. The Advance button also requires `sessionId` to send `advanceKanbanPlan`. Both buttons should be hidden when `sessionId` is absent.

5. **`moveSelected` verb behavior**: The `moveSelected` verb on the backend advances the card to the next column AND dispatches the prompt to the appropriate agent terminal. If no terminal is configured for the next column's role, the advance may succeed (column change) but the terminal dispatch may fail silently. The backend should handle this gracefully (the kanban board already deals with this). The `kanbanPlanAdvanced` response should indicate success/failure.

6. **Copy Prompt label derivation**: The `_featureCopyPromptLabel()` function was written for the features tab, which derives labels from the current column's stage. The kanban board derives from the NEXT column's role. For standard columns, both approaches yield identical labels. For custom columns, there may be subtle differences. Since the user asked to "mirror the kanban board buttons," the label derivation should match the board's approach. However, reusing `_featureCopyPromptLabel()` is simpler and the labels match for all standard columns. Use `_featureCopyPromptLabel()` and note the discrepancy in a code comment.

7. **Verb allowlist is generated**: `src/generated/verbAllowlist.ts` and `src/generated/verbSchemas.ts` are in a `generated/` directory. Check whether these files are auto-generated from a source file. If so, edit the source and regenerate. If they're hand-maintained despite the directory name, edit directly. The existing `copyKanbanPlanPrompt` and `moveKanbanPlanColumn` entries suggest they're edited directly.

## Verification Plan

1. **Copy Prompt in meta-bar**: Select a plan in the kanban tab → verify Copy Prompt button appears in the meta-bar with the correct label (e.g., "Copy Coder Prompt" for PLAN REVIEWED plans) → click it → verify prompt is on the clipboard → verify the plan's column advances (plan list refreshes) → verify the sidebar card no longer has a Copy Prompt button

2. **Advance in meta-bar**: Select a non-terminal plan → verify Advance button appears in the meta-bar → click it → verify the plan advances to the next column (plan list refreshes) → verify the prompt was dispatched to the appropriate terminal (check terminal output) → verify the button shows "Advanced" feedback

3. **Terminal column**: Select a plan in COMPLETED → verify neither Copy Prompt nor Advance buttons appear in the meta-bar

4. **No sessionId**: Select a plan with only a planFile (no sessionId) → verify neither Copy Prompt nor Advance buttons appear

5. **Backend handler**: Send `advanceKanbanPlan` message with a valid sessionId → verify the backend calls `moveSelected` on the kanban provider → verify the plan's column changes → verify the response message `kanbanPlanAdvanced` is received

6. **Verb schema/allowlist**: Verify `advanceKanbanPlan` is in the `PLANNING_VERBS` set and has a valid schema entry
