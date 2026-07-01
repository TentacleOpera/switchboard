# Epics Tab: Make Action Buttons Column-Aware (Respect Board State)

## Goal

### Problem
The Epics tab in `project.html` renders action buttons on each epic card that are **completely static** — they ignore the epic's current kanban column. When an epic is moved from `CREATED` (New) to `PLAN REVIEWED` (Planned) or any later column, the card still shows "Copy Planning Prompt" and "Send to Planner" buttons, which are only meaningful for the pre-planning stage.

Concretely, after moving an epic to the `PLAN REVIEWED` column:
- The column badge correctly updates to "Planned" (the label for `PLAN REVIEWED`).
- But the buttons still say "Copy Planning Prompt" and "Send to Planner" — a mismatch between the displayed status and the available actions.
- Clicking "Send to Planner" is actively **regressive**: it moves the epic *backwards* to the `CREATED` column (project.js:2055-2067), undoing the user's board progression.
- Clicking "Copy Planning Prompt" generates a **planner**-role prompt (PlanningPanelProvider.ts:3233 — `generateUnifiedPrompt('planner', ...)`), which is the wrong stage for an epic that has already been planned.

### Root Cause
Two layers ignore the column:

1. **Frontend (`src/webview/project.js`, `renderEpicsList`, lines 1962-1969):** The `actionButtons` template is built unconditionally — "Copy Planning Prompt" and "Send to Planner" are emitted whenever `plan.sessionId || plan.planId` is truthy, with no check on `plan.column` or the column's `kind`. Contrast with the kanban board (`kanban.html:5452-5470`), which derives the copy-button label from the *next* column's role, and the regular kanban plans list (`project.js:1506`), which passes `data-column` to the column-aware `copyKanbanPlanPrompt` backend path.

2. **Backend (`src/services/PlanningPanelProvider.ts`, `copyEpicPlannerPrompt` handler, lines 3199-3239):** This handler hardcodes `generateUnifiedPrompt('planner', ...)` at line 3233. It never reads the epic's `kanbanColumn` and never resolves a stage-appropriate role. The column-aware path (`copyKanbanPlanPrompt` → `copyPlanFromKanban` → `_handleCopyPlanLink` in `TaskViewerProvider.ts:14263-14343`) *does* resolve the role from the column (`columnToPromptRole` + complexity routing for `PLAN REVIEWED`) and *does* expand epic subtasks (lines 14321-14334) — but the epics tab bypasses it entirely.

### Background
The kanban pipeline stages and their column `kind` values (from `agentConfig.ts:106-116`):

| Column ID | Label | kind | Next-stage role |
|---|---|---|---|
| `CREATED` | New | `created` | planner |
| `PLAN REVIEWED` | Planned | `review` | lead/coder (complexity-routed) |
| `LEAD CODED` / `CODER CODED` / `INTERN CODED` | Lead/Coder/Intern | `coded` | reviewer |
| `CODE REVIEWED` | Reviewed | `reviewed` | tester |
| `ACCEPTANCE TESTED` | Acceptance Tested | `reviewed` | — |
| `COMPLETED` | Completed | `completed` | — |

The `columnToPromptRole` mapping (`agentPromptBuilder.ts:1235-1251`): `CREATED`→planner, `PLAN REVIEWED`→lead, coded columns→reviewer, `CODE REVIEWED`→tester.

The kanban board's per-card copy button label logic (`kanban.html:5456-5467`) derives the label from the *destination* column's role: planner→"Copy planning prompt", lead/coder/intern→"Copy coder prompt", reviewer→"Copy review prompt", custom→"Copy advance prompt".

## Metadata
- **Tags:** `epics`, `project-webview`, `kanban`, `ui`, `board-state`
- **Complexity:** 5/10

## Complexity Audit
**Complex / Risky.** The frontend change is routine (conditional button rendering + label derivation, mirroring an existing pattern in `kanban.html`). The backend change is the risky part: `copyEpicPlannerPrompt` must become column-aware without breaking the epic subtask expansion it already performs, and without diverging from the proven `copyKanbanPlanPrompt` path. The safest approach is to make `copyEpicPlannerPrompt` accept a `column` parameter and resolve the role the same way `_handleCopyPlanLink` does (`columnToPromptRole` + complexity routing for `PLAN REVIEWED`), keeping the existing epic-expansion block intact.

Risk factors:
- The `kanbanPlanPromptCopied` response handler (project.js:775-798) finds the button via `.kanban-plan-copy-prompt[data-session-id]` and restores `oldText` after 2s — the new dynamic label must survive this restore cycle (it captures `btn.textContent` at response time, so a dynamic label is preserved correctly).
- The response handler only refreshes the list when `activeTab === 'kanban'` (line 795) — it does NOT refresh the epics tab. After a copy-and-advance, the epic card would stay in its old column in the epics list until a manual refresh. This is a secondary bug that should be fixed in the same change.

## Edge-Case & Dependency Audit

1. **Epic with no column (`plan.column` falsy):** Treat as `CREATED` (pre-planning). Show "Copy Planning Prompt" + "Send to Planner". This matches the existing fallback in `_handleCopyPlanLink` (`_normalizeLegacyKanbanColumn(effectiveColumn || 'CREATED')`, TaskViewerProvider.ts:14296).

2. **Epic in `CREATED`:** Current behavior is correct — show "Copy Planning Prompt" + "Send to Planner". No change.

3. **Epic in `PLAN REVIEWED`:** "Send to Planner" must be hidden (regressive). "Copy Planning Prompt" should become "Copy Coder Prompt" (the next stage is a coded column; complexity routing picks lead vs coder on the backend). The backend must resolve the role as `lead` (or complexity-routed coder/intern), not `planner`.

4. **Epic in a coded column (`LEAD CODED` / `CODER CODED` / `INTERN CODED`):** "Send to Planner" hidden. Button label → "Copy Review Prompt" (next stage is `CODE REVIEWED`).

5. **Epic in `CODE REVIEWED`:** "Send to Planner" hidden. Button label → "Copy Acceptance Test Prompt" (next stage is `ACCEPTANCE TESTED`, role `tester`).

6. **Epic in `ACCEPTANCE TESTED` or `COMPLETED`:** "Send to Planner" hidden. No next stage — hide the copy-prompt button entirely (or show a disabled "Completed" state). "Copy Link" remains.

7. **Custom columns (`kind: 'custom-agent'` / `'custom-user'`):** `columnToPromptRole` returns the column id itself for `custom_agent_*` columns, and `null` otherwise. For unknown/custom columns, fall back to "Copy Advance Prompt" and pass the column through — the backend's `generateUnifiedPrompt` handles custom roles.

8. **`_kanbanAvailableColumns` may lack `kind`/`role` fields:** The webview receives columns from the backend (`msg.columns`, project.js:466). The backend sends full `KanbanColumnDefinition` objects (which include `kind` and `role`). Verified: `PlanningPanelProvider` sends the resolved column definitions. But defensive coding should fall back to `columnToPromptRole`-style ID matching when `kind`/`role` are absent (the kanban board does this: `kanban.html:5459` checks `nextDef.role === 'planner' || nextDef.id === 'PLAN REVIEWED'`).

9. **List refresh after copy-and-advance:** The `kanbanPlanPromptCopied` handler (project.js:795) only fires `fetchKanbanPlans` when `activeTab === 'kanban'`. When the epics tab is active, the epic card will not refresh after a copy-and-advance. Must add an `activeTab === 'epics'` branch (or just fire unconditionally — the backend has a request-ID dedup guard).

10. **No migration needed:** This is unreleased dev-work UI behavior (the epics tab button rendering). No persisted state format changes. Clean break.

## Proposed Changes

### 1. `src/webview/project.js` — `renderEpicsList` (lines 1945-2081)

**Add a helper to derive the copy-prompt button label from the epic's column** (mirroring `kanban.html:5456-5467` but based on the *current* column's next stage, since the epics tab is a management view, not a board column):

```js
function _epicCopyPromptLabel(plan) {
    if (!plan.column) return 'Copy Planning Prompt'; // no column = pre-planning
    const colDef = _kanbanAvailableColumns.find(c => c.id === plan.column);
    const kind = colDef?.kind;
    // CREATED → planner stage
    if (plan.column === 'CREATED' || kind === 'created') return 'Copy Planning Prompt';
    // PLAN REVIEWED → coder stage (complexity-routed on backend)
    if (plan.column === 'PLAN REVIEWED' || (kind === 'review' && colDef?.role === 'planner')) return 'Copy Coder Prompt';
    // Coded columns → reviewer stage
    if (kind === 'coded') return 'Copy Review Prompt';
    // CODE REVIEWED / ACCEPTANCE TESTED → tester / done
    if (plan.column === 'CODE REVIEWED') return 'Copy Acceptance Test Prompt';
    if (kind === 'reviewed' || kind === 'completed') return null; // no next stage
    // Custom columns
    if (kind === 'custom-agent' || kind === 'custom-user') return 'Copy Advance Prompt';
    return 'Copy Prompt';
}
```

**Make the action buttons conditional** (replace lines 1962-1969):

```js
const copyPromptLabel = _epicCopyPromptLabel(plan);
const showSendToPlanner = !plan.column || plan.column === 'CREATED'
    || (_kanbanAvailableColumns.find(c => c.id === plan.column)?.kind === 'created');
const actionButtons = `
    <div class="kanban-plan-actions" style="margin-top: 6px;">
        ${columnBadge}
        ${plan.planFile ? `<button class="kanban-plan-copy-link epic-card-action" data-plan-file="${escapeHtml(plan.planFile)}">Copy Link</button>` : ''}
        ${copyPromptLabel && (plan.sessionId || plan.planId) ? `<button class="kanban-plan-copy-prompt epic-card-action" data-session-id="${escapeHtml(plan.sessionId || plan.planId)}" data-column="${escapeHtml(plan.column || 'CREATED')}" data-workspace-root="${escapeHtml(plan.workspaceRoot || '')}">${escapeHtml(copyPromptLabel)}</button>` : ''}
        ${showSendToPlanner && (plan.sessionId || plan.planId) ? `<button class="epic-send-to-planner epic-card-action" data-plan-file="${escapeHtml(plan.planFile || '')}" data-workspace-root="${escapeHtml(plan.workspaceRoot || '')}">Send to Planner</button>` : ''}
    </div>
`;
```

**Update the Copy Planning Prompt click handler** (lines 2029-2045) to pass the column:

```js
vscode.postMessage({
    type: 'copyEpicPlannerPrompt',
    sessionId: epicCopyPromptBtn.dataset.sessionId,
    column: epicCopyPromptBtn.dataset.column,   // NEW
    workspaceRoot: epicCopyPromptBtn.dataset.workspaceRoot
});
```

### 2. `src/services/PlanningPanelProvider.ts` — `copyEpicPlannerPrompt` handler (lines 3199-3239)

**Accept `column` and resolve a stage-appropriate role** instead of hardcoding `'planner'`. Mirror `_handleCopyPlanLink` (TaskViewerProvider.ts:14303-14310):

```ts
case 'copyEpicPlannerPrompt': {
    const sessionId = String(msg.sessionId || '');
    const column = String(msg.column || '');
    const wsRoot = String(msg.workspaceRoot || workspaceRoot);
    if (!sessionId || !this._kanbanProvider) {
        this._projectPanel?.webview.postMessage({ type: 'kanbanPlanPromptCopied', success: false, sessionId: '', error: 'No sessionId or kanban provider' });
        break;
    }
    try {
        const kp = this._kanbanProvider;
        const db = (kp as any)._getKanbanDb(wsRoot);
        if (!db || !(await db.ensureReady())) {
            this._projectPanel?.webview.postMessage({ type: 'kanbanPlanPromptCopied', success: false, sessionId, error: 'Could not resolve this epic.' });
            break;
        }
        const epic = await db.getPlanByPlanId(sessionId);
        if (!epic || !epic.isEpic) {
            this._projectPanel?.webview.postMessage({ type: 'kanbanPlanPromptCopied', success: false, sessionId, error: 'Could not resolve this epic.' });
            break;
        }
        // Resolve effective column: explicit param > epic's DB column > CREATED
        const effectiveColumn = column || epic.kanbanColumn || 'CREATED';
        // Resolve role from column (mirror _handleCopyPlanLink, TaskViewerProvider.ts:14303-14310)
        let role: string;
        if (effectiveColumn === 'PLAN REVIEWED') {
            const complexity = await kp.getComplexityFromPlan(wsRoot, (kp as any)._resolvePlanFilePath(wsRoot, epic.planFile));
            role = kp.resolveRoutedRole(parseComplexityScore(complexity));
        } else {
            role = columnToPromptRole(effectiveColumn) || 'planner';
        }
        const plans: import('./agentPromptBuilder').BatchPromptPlan[] = [{
            topic: epic.topic,
            absolutePath: (kp as any)._resolvePlanFilePath(wsRoot, epic.planFile),
            complexity: epic.complexity,
            sessionId: epic.sessionId || epic.planId,
            epicId: epic.planId || undefined,
            isEpic: true
        }];
        const subtaskPlans = await kp.expandEpicSubtaskPlans(
            wsRoot, epic.planId, epic.topic, epic.kanbanColumn || '', undefined
        );
        for (const sp of subtaskPlans) { plans.push(sp); }
        const prompt = await kp.generateUnifiedPrompt(role, plans, wsRoot);
        await vscode.env.clipboard.writeText(prompt);
        this._projectPanel?.webview.postMessage({ type: 'kanbanPlanPromptCopied', success: true, sessionId });
    } catch (err) {
        this._projectPanel?.webview.postMessage({ type: 'kanbanPlanPromptCopied', success: false, sessionId, error: String(err) });
    }
    break;
}
```

**Required imports** at the top of `PlanningPanelProvider.ts` (verify presence; add if missing):
- `columnToPromptRole` from `./agentPromptBuilder`
- `parseComplexityScore` (from wherever `_handleCopyPlanLink` imports it — check `TaskViewerProvider.ts` imports)

### 3. `src/webview/project.js` — `kanbanPlanPromptCopied` handler (lines 795-797)

**Refresh the epics list too**, so the card reflects any column advance the backend performed after copying:

```js
if (activeTab === 'kanban' || activeTab === 'epics') {
    vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });
}
```

## Verification Plan

1. **Manual — CREATED epic:** Create a new epic (lands in `CREATED`). Confirm the card shows "Copy Planning Prompt" + "Send to Planner". Click "Copy Planning Prompt" → clipboard contains a planner-role prompt. Click "Send to Planner" → epic moves to `CREATED` (no-op if already there).

2. **Manual — PLAN REVIEWED epic (the reported bug):** Move an epic to `PLAN REVIEWED`. Confirm:
   - The card shows "Copy Coder Prompt" (NOT "Copy Planning Prompt").
   - "Send to Planner" is **absent**.
   - Click "Copy Coder Prompt" → clipboard contains a coder/lead-role prompt (complexity-routed), with epic subtask expansion (`EPIC MODE` directive present).

3. **Manual — Coded column epic:** Move an epic to `LEAD CODED`. Confirm the card shows "Copy Review Prompt", no "Send to Planner". Click → clipboard contains a reviewer-role prompt.

4. **Manual — CODE REVIEWED epic:** Move an epic to `CODE REVIEWED`. Confirm "Copy Acceptance Test Prompt", no "Send to Planner".

5. **Manual — COMPLETED epic:** Move an epic to `COMPLETED`. Confirm no copy-prompt button and no "Send to Planner" — only "Copy Link" remains.

6. **Manual — list refresh:** On the epics tab, copy a prompt for a `CREATED` epic. Confirm the epics list refreshes (the card updates if the backend advanced the column).

7. **Regression — regular kanban plans list:** Confirm the kanban plans list "Copy Prompt" button is unchanged (still uses `copyKanbanPlanPrompt`, still column-aware via the existing path).

8. **Regression — kanban board:** Confirm the kanban board's per-card copy buttons are unchanged (this plan does not touch `kanban.html`).

9. **Unit test:** Add a test verifying `_epicCopyPromptLabel` returns the correct label for each column kind (created→"Copy Planning Prompt", review/planner→"Copy Coder Prompt", coded→"Copy Review Prompt", reviewed→"Copy Acceptance Test Prompt"/null, completed→null, custom→"Copy Advance Prompt"). Mirror the existing `src/test/planning-copy-labels-regression.test.js` pattern.

10. **Build:** `npm run compile` succeeds with no new type errors (verify `columnToPromptRole` and `parseComplexityScore` imports resolve in `PlanningPanelProvider.ts`).
