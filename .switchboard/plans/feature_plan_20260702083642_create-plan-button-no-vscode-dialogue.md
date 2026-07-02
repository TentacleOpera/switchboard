# Create plan button should not open VS Code dialogue — open project.html Kanban tab instead

## Goal

### Problem
When the user clicks any "Create Plan" button (in implementation.html, kanban.html, or project.html), a VS Code `showInputBox` dialogue appears asking for a plan title. This is disruptive and inconsistent with the desired workflow. The create button should instead directly create a new plan (with a default title) and open the project.html Kanban Plans tab with the new plan selected and editing mode active — no dialogue prompt.

### Background
All three "Create Plan" buttons route through the same backend path:
- **implementation.html** `btn-create-plan` → sends `createDraftPlanTicket` message → `TaskViewerProvider.createDraftPlanTicket()` (TaskViewerProvider.ts:16718)
- **kanban.html** `btn-add-plan` → sends `createPlan` message → `KanbanProvider` handler (KanbanProvider.ts:7163) → `vscode.commands.executeCommand('switchboard.initiatePlan')` → `TaskViewerProvider.createDraftPlanTicket()`
- **project.html** `btn-create-kanban-plan` → sends `createPlan` message → `PlanningPanelProvider` handler (PlanningPanelProvider.ts:3082) → `vscode.commands.executeCommand('switchboard.initiatePlan')` → `TaskViewerProvider.createDraftPlanTicket()`

All paths converge on `createDraftPlanTicket()` (TaskViewerProvider.ts:16718-16760), which calls `vscode.window.showInputBox()` at line 16719 to prompt for a title.

### Root Cause
`createDraftPlanTicket()` unconditionally calls `vscode.window.showInputBox()` to get the plan title before creating the plan. This is the VS Code dialogue the user sees. The method already has a fallback default of `'Untitled Plan'` (line 16728), so the dialogue is technically optional — but it's always shown.

The method already calls `activatePlanInProjectPanel(planFileRelative, workspaceRoot, true)` at line 16745 with `autoEdit: true`, which is exactly the desired behavior (open project panel, select plan, enter edit mode). The ONLY problem is the `showInputBox` call that precedes it.

## Metadata
- **Tags**: `create-plan`, `showInputBox`, `createDraftPlanTicket`, `implementation.html`, `kanban.html`, `project.html`, `ux`, `bug`
- **Complexity**: 3/10

## Complexity Audit
**Routine.** The fix is removing (or bypassing) a single `showInputBox` call and using a default title. The rest of the flow (`_createInitiatedPlan`, `activatePlanInProjectPanel` with `autoEdit: true`) already does exactly what's needed. The only risk is if any caller depends on the dialogue to cancel plan creation (user presses Escape). Since the user explicitly wants no dialogue, this is intentional — the button always creates a plan.

## Edge-Case & Dependency Audit
- **User cancellation via Escape**: Currently, pressing Escape in the `showInputBox` returns `undefined`, which falls back to `'Untitled Plan'` (line 16728 `|| 'Untitled Plan'`). So even today, cancellation doesn't prevent creation — it just uses the default title. Removing the dialogue makes this behavior explicit and consistent.
- **Default title uniqueness**: Multiple "Untitled Plan" plans will have the same title but different timestamps in the filename (`feature_plan_<timestamp>_untitled-plan.md`), so there's no file collision. The kanban dropdown shows topic + date, so they're distinguishable.
- **Renaming after creation**: With `autoEdit: true`, the project panel opens in edit mode. The user can immediately rename the plan by editing the H1 header in the editor. This is a better UX than the dialogue — the user sees the full plan context while naming it.
- **Other callers of `createDraftPlanTicket`**: The command `switchboard.initiatePlan` (extension.ts:741-743) calls `createDraftPlanTicket()`. This is the command used by kanban.html and project.html. All callers want the same behavior (no dialogue).
- **`importPlanFromClipboard` and other plan creation methods**: These have their own flows and do NOT call `createDraftPlanTicket`. They are unaffected.
- **`_buildDraftPlanContent(title)`**: This builds the plan template with the title in the H1 header. Using `'Untitled Plan'` as the default title produces `# Untitled Plan` in the plan content, which the user can edit in the project panel.

## Proposed Changes

### 1. `src/services/TaskViewerProvider.ts` — remove `showInputBox` from `createDraftPlanTicket`

```ts
// BEFORE (lines 16718-16728)
public async createDraftPlanTicket(): Promise<void> {
    const title = await vscode.window.showInputBox({
        prompt: 'Plan title (used for filename and H1 header)',
        placeHolder: 'Untitled Plan',
        value: 'Untitled Plan',
        validateInput: (v) => {
            // Reject titles that would produce an empty slug
            if (!v || !v.trim()) return null; // allow empty (falls back to Untitled Plan)
            return null;
        }
    }) || 'Untitled Plan';
    const createdAt = new Date().toISOString();
    const idea = this._buildDraftPlanContent(title);

// AFTER
public async createDraftPlanTicket(): Promise<void> {
    // No VS Code dialogue — create directly with default title.
    // The project panel opens in edit mode (autoEdit: true) so the user
    // can rename the plan immediately in the editor.
    const title = 'Untitled Plan';
    const createdAt = new Date().toISOString();
    const idea = this._buildDraftPlanContent(title);
```

The rest of the method (lines 16730-16760) remains unchanged — it already calls `activatePlanInProjectPanel(planFileRelative, workspaceRoot, true)` which opens the project panel with `autoEdit: true`.

### 2. Verify button text resets (no changes needed)

The button text reset logic in implementation.html (line 1685: `btnCreatePlan.innerText = 'CREATE'`) and project.js (line 1822: `btnCreateKanbanPlan.textContent = 'Create'`) already resets to the correct label. These are unaffected by removing the dialogue. (Note: if Issue 2's rename to "NEW" is also applied, update the implementation.html reset text accordingly — but that's tracked in the separate plan.)

## Verification Plan
1. **implementation.html CREATE/NEW button**: Click the create button. Verify NO VS Code input dialogue appears. Verify a new "Untitled Plan" plan is created and the project panel opens to the Kanban tab with the new plan selected and the editor in edit mode.
2. **kanban.html + button**: Click the "+" create-plan button on the kanban board. Verify NO dialogue appears. Verify the project panel opens with the new plan selected and editing active.
3. **project.html Create button**: Click "Create" in the project panel's Kanban tab controls strip. Verify NO dialogue appears. Verify the new plan appears in the list, is selected, and the editor enters edit mode.
4. **Rename in editor**: After creation, verify the user can immediately edit the H1 header in the editor to rename the plan. Save and verify the plan topic updates in the kanban list.
5. **Multiple rapid creations**: Click create multiple times quickly. Verify each creates a separate plan with a unique timestamp filename. Verify no errors from concurrent creation.
6. **Command palette**: If `switchboard.initiatePlan` is exposed in the command palette, run it. Verify no dialogue and the same behavior.
