# NotebookLM Tab: Step 4 Import Plans with NEW Column Overwrite

## Goal

Add a dedicated **Step 4: IMPORT PLANS** button to the NotebookLM tab in `planning.html`. When clicked, it reads the user's clipboard and imports plans with overwrite-deduplication scoped strictly to the **NEW** column. If a clipboard-imported plan's title matches an existing active plan in **NEW**, overwrite that plan's file in-place; otherwise, create a new plan. This applies to both single-plan and multi-plan clipboard content.

## Background / Problem Analysis

The NotebookLM integration workflow in `planning.html` guides users to generate expanded plans for every plan in the **NEW** Kanban column, copy the output, and bring it back into Switchboard. Currently there is no dedicated import step in the NotebookLM tab — users must navigate to the Kanban board and use "Import from clipboard". When they do, the existing `importPlanFromClipboard` logic always writes a new timestamped file and registers a new Kanban card, producing duplicates.

## Proposed Solution

### UI Changes

Add a new section to the NotebookLM card in `planning.html`:

```html
<div class="planning-card-section">
    <div class="planning-card-section-title">4. IMPORT PLANS</div>
    <div class="planning-card-description">
        Paste your expanded plans from NotebookLM. Plans matching titles in the NEW column will overwrite the originals; others will be created as new plans.
    </div>
    <button id="btn-import-notebooklm-plans" class="planning-button secondary">IMPORT PLANS</button>
</div>
```

Wire the button in `planning.js` to post a message to the extension host (e.g. `type: 'importNotebookLMPlans'`), which delegates to a new handler.

### Extension Host Handler

In `PlanningPanelProvider.ts`, add a new private method:

```typescript
private async _handleImportNotebookLMPlans(workspaceRoot: string): Promise<void>
```

This handler:
1. Reads the clipboard text (same logic as existing import).
2. Detects whether the content is single-plan or multi-plan (using `--- PLAN ---` separator).
3. For each extracted plan title:
   - Query the Kanban DB for an active plan in `kanbanColumn === 'CREATED'` with a matching `topic` (case-insensitive, whitespace-normalized).
   - If found: overwrite the existing plan file at its `planFile` path, update the DB `updatedAt` timestamp, do NOT create a new run sheet.
   - If not found: call `_createInitiatedPlan` to create a new plan file and Kanban card as usual.
4. Show a summary notification distinguishing overwrites vs new imports.

### Single-plan path

For single-plan clipboard content (no `--- PLAN ---` markers):
- Extract title from H1 → H2 → H3 → fallback.
- Perform the same title-matching lookup in the **NEW** column.
- Overwrite existing or create new, following the same rules as multi-plan.

### Multi-plan path

For multi-plan clipboard content (with `--- PLAN ---` markers):
- Split by separator.
- For each plan segment, extract the H1 title.
- Run the same per-plan title-matching logic.

## Files to Modify

- `src/webview/planning.html` — add Step 4 UI section.
- `src/webview/planning.js` — wire button to post extension message.
- `src/services/PlanningPanelProvider.ts` — add `_handleImportNotebookLMPlans` and route it from the message handler.
- `src/services/TaskViewerProvider.ts` — add a public method (e.g. `importNotebookLMPlans`) that contains the shared single/multi-plan parsing and overwrite logic, so it can be called from `PlanningPanelProvider`.

## Implementation Steps

### Step 1: UI — planning.html

Insert the new Step 4 section after the existing Step 3 in the NotebookLM card.

### Step 2: UI wiring — planning.js

Add a click listener for `#btn-import-notebooklm-plans` that posts:

```javascript
vscode.postMessage({ type: 'importNotebookLMPlans' });
```

### Step 3: Extension handler — PlanningPanelProvider.ts

In the existing message switch/case block, add:

```typescript
case 'importNotebookLMPlans': {
    const workspaceRoot = this._resolveWorkspaceRoot();
    if (workspaceRoot) {
        await this._handleImportNotebookLMPlans(workspaceRoot);
    }
    break;
}
```

### Step 4: Shared import logic — TaskViewerProvider.ts

Add a new public method:

```typescript
public async importNotebookLMPlans(workspaceRoot: string): Promise<void>
```

This method:
1. Reads clipboard text.
2. Delegates to a new private `_importPlansWithOverwrite` method.
3. `_importPlansWithOverwrite` contains the shared logic:
   - Parse single or multi-plan.
   - For each plan, `_findExistingPlanInNewColumn(title)` → returns `KanbanPlanRecord | null`.
   - If found: `await this._overwriteExistingPlan(record, content)`.
   - If not found: `await this._createInitiatedPlan(title, content, false, { skipBrainPromotion: true })`.

### Step 5: Overwrite helper

```typescript
private async _overwriteExistingPlan(record: KanbanPlanRecord, newContent: string): Promise<void>
```

- Resolve absolute path from `record.planFile`.
- Write `newContent` to that path.
- Update DB `updatedAt` via `updateLastActionByPlanFile`.
- Do not touch run sheets (they remain valid).

### Step 6: Lookup helper

```typescript
private async _findExistingPlanInNewColumn(title: string, workspaceRoot: string): Promise<KanbanPlanRecord | null>
```

- Normalize title: lowercase, collapse whitespace.
- Fetch `getBoard(workspaceId)` from the Kanban DB.
- Return the first active record where `kanbanColumn === 'CREATED'` and normalized `topic` matches.

## Scope

- Tightly scoped to the **NEW** (`CREATED`) column. Plans in any other column are never overwritten.
- Applies to both single-plan and multi-plan clipboard content.

## Risks

- **Title collision false positives**: Two genuinely different plans with the same title in NEW could overwrite each other. Mitigation: normalize whitespace and compare case-insensitively, but accept this as a reasonable trade-off since users control the titles.
- **Concurrent edits**: If a plan is being dispatched from NEW while import runs, the overwrite could race. Mitigation: reuse the existing `_planCreationInFlight` mutex pattern around file writes.

## Validation

- Unit test: mock Kanban DB with 2 plans in NEW column and 1 in another column. Import clipboard with 3 plans (2 matching titles, 1 new). Assert:
  - 2 existing files overwritten in-place.
  - 1 new file created.
  - No duplicate Kanban cards.
  - Plan in non-NEW column untouched.

## Non-Goals

- Overwriting plans in columns other than NEW.
- Merging plan content (always full overwrite).
- Changing the existing Kanban board "Import from clipboard" button behavior (that remains as-is for general use).
