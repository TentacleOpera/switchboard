# Create plan button should not open VS Code dialogue — open project.html Kanban tab instead

**Plan ID:** 40d46c89-9272-43c2-a180-772dac1bf6a1

## Goal

### Problem
When the user clicks any "Create Plan" button (in implementation.html, kanban.html, or project.html), a VS Code `showInputBox` dialogue appears asking for a plan title. This is disruptive and inconsistent with the desired workflow. The create button should instead directly create a new plan (with a default title) and open the project.html Kanban Plans tab with the new plan selected and editing mode active — no dialogue prompt.

### Background
All three "Create Plan" buttons route through the same backend path:
- **implementation.html** `btn-create-plan` → sends `createDraftPlanTicket` message → `TaskViewerProvider.createDraftPlanTicket()` (TaskViewerProvider.ts:16766)
- **kanban.html** `btn-add-plan` → sends `createPlan` message → `KanbanProvider` handler (KanbanProvider.ts:7219/7238) → `vscode.commands.executeCommand('switchboard.initiatePlan')` → `TaskViewerProvider.createDraftPlanTicket()`
- **project.html** `btn-create-kanban-plan` → sends `createPlan` message → `PlanningPanelProvider` handler (PlanningPanelProvider.ts:3113-3114) → `vscode.commands.executeCommand('switchboard.initiatePlan')` → `TaskViewerProvider.createDraftPlanTicket()`

All paths converge on `createDraftPlanTicket()` (TaskViewerProvider.ts:16766-16808), which calls `vscode.window.showInputBox()` at line 16767 to prompt for a title.

### Root Cause
`createDraftPlanTicket()` unconditionally calls `vscode.window.showInputBox()` to get the plan title before creating the plan. This is the VS Code dialogue the user sees. The method already has a fallback default of `'Untitled Plan'` (line 16776: `|| 'Untitled Plan'`), so the dialogue is technically optional — but it's always shown.

The method already calls `activatePlanInProjectPanel(planFileRelative, workspaceRoot, true)` at line 16793 with `autoEdit: true`, which is exactly the desired behavior (open project panel, select plan, enter edit mode). The ONLY problem is the `showInputBox` call that precedes it.

## Metadata
- **Tags:** ui, ux, bugfix
- **Complexity:** 3/10

## User Review Required
No. The change removes a single dialogue prompt and uses an existing default-title fallback. The downstream flow (`activatePlanInProjectPanel` with `autoEdit: true`) already implements the desired behavior. The user explicitly requested no dialogue. Safe to proceed.

## Complexity Audit

### Routine
- Removing the `vscode.window.showInputBox(...)` call and replacing the `title` expression with the literal `'Untitled Plan'`.
- All three entry points (implementation.html, kanban.html, project.html) already converge on the single method, so only one backend edit is needed.
- The project-panel activation + edit-mode flow already exists unchanged.

### Complex / Risky
- None for the core change. Minor consideration: any caller that relied on the dialogue as a cancellation gate loses that gate — but per the user's explicit intent, the button should always create a plan, so this is desired behavior, not a risk.

## Edge-Case & Dependency Audit
- **User cancellation via Escape**: Currently, pressing Escape in the `showInputBox` returns `undefined`, which falls back to `'Untitled Plan'` (line 16776 `|| 'Untitled Plan'`). So even today, cancellation doesn't prevent creation — it just uses the default title. Removing the dialogue makes this behavior explicit and consistent.
- **Default title uniqueness**: Multiple "Untitled Plan" plans will have the same title but different timestamps in the filename (`feature_plan_<timestamp>_untitled-plan.md`), so there's no file collision. The kanban dropdown shows topic + date, so they're distinguishable.
- **Renaming after creation**: With `autoEdit: true`, the project panel opens in edit mode. The user can immediately rename the plan by editing the H1 header in the editor. This is a better UX than the dialogue — the user sees the full plan context while naming it.
- **Other callers of `createDraftPlanTicket`**: The command `switchboard.initiatePlan` (extension.ts:742-745) calls `createDraftPlanTicket()`. This is the command used by kanban.html and project.html. All callers want the same behavior (no dialogue).
- **`importPlanFromClipboard` and other plan creation methods**: These have their own flows and do NOT call `createDraftPlanTicket`. They are unaffected.
- **`_buildDraftPlanContent(title)`**: This builds the plan template with the title in the H1 header. Using `'Untitled Plan'` as the default title produces `# Untitled Plan` in the plan content, which the user can edit in the project panel.
- **Button reset text**: implementation.html resets `btnCreatePlan.innerText` to `'CREATE'` (line 1685 and 2319) — the sibling layout plan renames these to `'NEW'`. project.js resets `btnCreateKanbanPlan.textContent` to `'Create'` at lines 436, 578, and 1822. These are unaffected by removing the dialogue (they reset on `planCreated` regardless). The kanban `btn-add-plan` uses opacity/disabled state, no text reset. No changes needed here for this plan.

## Dependencies
- `sess_sidebar_plan_select_ux` — sibling subtask "implementation.html plan select panel layout improvements" (`feature_plan_20260702083641_implementation-plan-select-panel-layout-improvements.md`). That plan renames the implementation.html CREATE→NEW reset text; this plan's verification confirms no dialogue appears. Apply both as one unit.

## Adversarial Synthesis
Key risks: (1) a caller outside the three known entry points invoking `createDraftPlanTicket` directly and expecting the dialogue for validation; (2) rapid repeated clicks creating many "Untitled Plan" files before the button-disable guard engages. Mitigations: grep confirms only `switchboard.initiatePlan` and the implementation.html message handler call this method; the existing 3-second button-disable guards in all three webviews throttle rapid clicks. The change is safe.

## Proposed Changes

### 1. `src/services/TaskViewerProvider.ts` — remove `showInputBox` from `createDraftPlanTicket`

```ts
// BEFORE (lines 16766-16778)
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

The rest of the method (lines 16780-16808) remains unchanged — it already calls `activatePlanInProjectPanel(planFileRelative, workspaceRoot, true)` which opens the project panel with `autoEdit: true`, and posts `planCreated` to both the implementation webview and kanban provider so button states reset.

### 2. Verify button text resets (no changes needed in this plan)

The button text reset logic in implementation.html (line 1685: `btnCreatePlan.innerText = 'CREATE'`, and line 2319 in the `planCreated` handler) and project.js (lines 436, 578, 1822: `btnCreateKanbanPlan.textContent = 'Create'`) already resets to the correct label on `planCreated`. These are unaffected by removing the dialogue. The sibling layout plan handles the implementation.html CREATE→NEW rename.

## Verification Plan

### Automated Tests
Skipped per session directive. The test suite will be run separately by the user. No compilation step required.

### Manual Verification
1. **implementation.html CREATE/NEW button**: Click the create button. Verify NO VS Code input dialogue appears. Verify a new "Untitled Plan" plan is created and the project panel opens to the Kanban tab with the new plan selected and the editor in edit mode.
2. **kanban.html + button**: Click the "+" create-plan button on the kanban board. Verify NO dialogue appears. Verify the project panel opens with the new plan selected and editing active.
3. **project.html Create button**: Click "Create" in the project panel's Kanban tab controls strip. Verify NO dialogue appears. Verify the new plan appears in the list, is selected, and the editor enters edit mode.
4. **Rename in editor**: After creation, verify the user can immediately edit the H1 header in the editor to rename the plan. Save and verify the plan topic updates in the kanban list.
5. **Multiple rapid creations**: Click create multiple times quickly. Verify each creates a separate plan with a unique timestamp filename. Verify no errors from concurrent creation.
6. **Command palette**: If `switchboard.initiatePlan` is exposed in the command palette, run it. Verify no dialogue and the same behavior.

---

**Recommendation:** Complexity 3/10 → Send to Intern.
