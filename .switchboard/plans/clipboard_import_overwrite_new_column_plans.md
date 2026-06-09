# NotebookLM Tab: Step 4 Import Plans with NEW Column Overwrite

## Goal

Add a dedicated **Step 4: IMPORT PLANS** button to the NotebookLM tab in `planning.html`. When clicked, it reads the user's clipboard and imports plans with overwrite-deduplication scoped strictly to the **NEW** column. If a clipboard-imported plan's title matches an existing active plan in **NEW**, overwrite that plan's file in-place; otherwise, create a new plan. This applies to both single-plan and multi-plan clipboard content.

## Background / Problem Analysis

The NotebookLM integration workflow in `planning.html` guides users to generate expanded plans for every plan in the **NEW** Kanban column, copy the output, and bring it back into Switchboard. Currently there is no dedicated import step in the NotebookLM tab — users must navigate to the Kanban board and use "Import from clipboard". When they do, the existing `importPlanFromClipboard` logic always writes a new timestamped file and registers a new Kanban card, producing duplicates.

The root cause is that `importPlanFromClipboard` (TaskViewerProvider.ts:15243) always calls `_createInitiatedPlan`, which generates a new timestamped filename and a new Kanban card. There is no code path for matching an existing plan by title and overwriting its file in-place. Additionally, the existing `getPlanByTopic` DB method (KanbanDatabase.ts:2331) does not filter by `kanbanColumn`, so even if we tried to reuse it, we'd risk overwriting plans in columns other than NEW.

## Metadata

**Tags:** frontend, backend, feature
**Complexity:** 5

## User Review Required

- Confirm that overwrite should be scoped to **CREATED** column only (plans in DISPATCHED, REVIEWED, DONE are never overwritten).
- Confirm that title matching should be case-insensitive with whitespace normalization (e.g., "Fix Auth Bug" matches "fix  auth  bug").
- Confirm that Step 3 description should be updated to reference Step 4 instead of the Kanban board "Import from clipboard" option.

## Complexity Audit

### Routine
- Adding HTML section to planning.html (follows existing `.planning-card-section` pattern at lines 3088-3107)
- Adding button click listener in planning.js (follows pattern at lines 454-505)
- Adding message case in PlanningPanelProvider.ts switch block (follows pattern at lines 1432-1434)
- Registering VSCode command in extension.ts (follows pattern at line 658)
- Writing plan file content to disk (standard fs.writeFileSync)
- Updating DB `updatedAt` timestamp via existing `updateLastActionByPlanFile`

### Complex / Risky
- New DB query method `getPlanByTopicAndColumn` needed — existing `getPlanByTopic` does NOT filter by `kanbanColumn`, so a new method is required to guarantee NEW-column-only scoping
- Whitespace normalization for title matching — must normalize both the lookup key and the DB-side topic in JavaScript (not SQL) to handle multi-space collapses
- Mutex protection on overwrite path — `_planCreationInFlight` must wrap the file write + DB update to prevent watcher races
- Webview feedback loop — must send result message back to planning.js to update UI state

## Edge-Case & Dependency Audit

### Race Conditions
- **Concurrent overwrite + dispatch**: If a plan is being dispatched from NEW while import runs, the overwrite could race with the dispatch handler. Mitigation: wrap overwrite in `_planCreationInFlight` mutex (same pattern as `_createInitiatedPlan` at line 15451).
- **Double-click on IMPORT PLANS button**: Could trigger two concurrent imports. Mitigation: disable button immediately on click, re-enable on result (same pattern as `btn-bundle-code` at planning.js:456-460).

### Security
- Clipboard content is untrusted user input. No injection risk since content is written to `.switchboard/plans/` files (not executed), but max size check (200 KB) from existing import should be reused.

### Side Effects
- Overwriting an existing plan file triggers the file watcher. The `_pendingPlanCreations` set is used for creation, not overwrite. **Clarification**: The overwrite path should add the plan file path to `_pendingPlanCreations` before writing and remove it after (with the same 2-second TTL), so the watcher suppresses the redundant change event.

### Dependencies & Conflicts
- Depends on `KanbanDatabase.getPlanByTopicAndColumn` (new method) — must be implemented before the import handler.
- Depends on `_createInitiatedPlan` signature (lines 15425-15528) — no changes needed, just reuse.
- Step 3 description update is a soft dependency — the UI change should be coordinated with Step 4 addition.

## Dependencies

- `sess_clipboardImport` — existing clipboard import infrastructure (importPlanFromClipboard, _importMultiplePlansFromClipboard, CLIPBOARD_SEPARATOR_REGEX)

## Adversarial Synthesis

Key risks: (1) `getPlanByTopic` lacks column filtering — a new DB method is required to prevent overwriting plans outside the NEW column; (2) PlanningPanelProvider cannot call TaskViewerProvider directly — must route through a VSCode command, matching the existing architectural pattern; (3) title whitespace normalization must happen in JS, not SQL, to handle multi-space collapses. Mitigations: add `getPlanByTopicAndColumn` to KanbanDatabase, register `switchboard.importNotebookLMPlans` command in extension.ts, and normalize both sides of the comparison in the lookup helper.

## Proposed Solution

### UI Changes

Add a new section to the NotebookLM card in `planning.html` after Step 3 (line 3107), before the card's closing `</div>` (line 3108):

```html
<div class="planning-card-section">
    <div class="planning-card-section-title">4. IMPORT PLANS</div>
    <div class="planning-card-description">
        Paste your expanded plans from NotebookLM. Plans matching titles in the NEW column will overwrite the originals; others will be created as new plans.
    </div>
    <button id="btn-import-notebooklm-plans" class="planning-button secondary">IMPORT PLANS</button>
</div>
```

Also update Step 3 description (line 3105) from:
```
Generate a prompt for NotebookLM to write expanded plans for every plan in the NEW Kanban column. Copy this output and press the 'Import from clipboard' option on the Kanban board.
```
to:
```
Generate a prompt for NotebookLM to write expanded plans for every plan in the NEW Kanban column. Copy the output and use Step 4 below to import.
```

### Architecture: Command Bridge Pattern

PlanningPanelProvider does **NOT** have a reference to TaskViewerProvider. The existing integration pattern uses VSCode commands as the bridge (see `switchboard.importPlanFromClipboard` at extension.ts:658). The new import must follow the same pattern:

1. Add public method `importNotebookLMPlans` to TaskViewerProvider.
2. Register command `switchboard.importNotebookLMPlans` in extension.ts.
3. PlanningPanelProvider fires `vscode.commands.executeCommand('switchboard.importNotebookLMPlans')`.

### Extension Host Handler

In `PlanningPanelProvider.ts`, add a new case in the message switch block (after line 1434):

```typescript
case 'importNotebookLMPlans': {
    await vscode.commands.executeCommand('switchboard.importNotebookLMPlans');
    break;
}
```

Send a result message back to the webview after the command completes. Since the command is fire-and-forget, PlanningPanelProvider will need to await the command and then post a result. Refine:

```typescript
case 'importNotebookLMPlans': {
    const result = await vscode.commands.executeCommand('switchboard.importNotebookLMPlans') as { overwritten: number; created: number; errors: number };
    this._panel?.webview.postMessage({ type: 'importNotebookLMPlansResult', ...result });
    break;
}
```

### Command Registration

In `extension.ts` (after line 661), add:

```typescript
const importNotebookLMPlansDisposable = vscode.commands.registerCommand('switchboard.importNotebookLMPlans', async () => {
    return await taskViewerProvider?.importNotebookLMPlans();
});
context.subscriptions.push(importNotebookLMPlansDisposable);
```

### TaskViewerProvider: Public Import Method

Add a new public method to TaskViewerProvider (after `importPlanFromClipboard` at line 15324):

```typescript
public async importNotebookLMPlans(): Promise<{ overwritten: number; created: number; errors: number }>
```

This method:
1. Reads the clipboard text (same logic as existing import at lines 15257-15268).
2. Validates content (empty check, 200 KB max — same as lines 15270-15277).
3. Detects single-plan vs multi-plan using `CLIPBOARD_SEPARATOR_REGEX` (line 242).
4. Extracts plan segments with titles.
5. For each plan, calls `_findExistingPlanInNewColumn(title, workspaceRoot)`.
6. If found: calls `_overwriteExistingPlan(record, content)`.
7. If not found: calls `_createInitiatedPlan(title, content, false, { skipBrainPromotion: true })`.
8. Returns summary counts.

### TaskViewerProvider: Lookup Helper

```typescript
private async _findExistingPlanInNewColumn(title: string, workspaceRoot: string): Promise<KanbanPlanRecord | null>
```

Implementation:
1. Normalize title: `title.toLowerCase().replace(/\s+/g, ' ').trim()`.
2. Get `workspaceId` via `_getWorkspaceIdForRoot(workspaceRoot)`.
3. Get `db` via `_getKanbanDb(workspaceRoot)`.
4. Call `db.getPlanByTopicAndColumn(normalizedTitle, 'CREATED', workspaceId)` — **new DB method**.
5. Return the record or null.

### KanbanDatabase: New Query Method

Add to `KanbanDatabase.ts` (after `getPlanByTopic` at line 2343):

```typescript
public async getPlanByTopicAndColumn(topic: string, kanbanColumn: string, workspaceId: string): Promise<KanbanPlanRecord | null> {
    if (!(await this.ensureReady()) || !this._db) return null;
    const stmt = this._db.prepare(
        `SELECT ${PLAN_COLUMNS} FROM plans
         WHERE LOWER(topic) = LOWER(?)
           AND kanban_column = ?
           AND workspace_id = ?
           AND status = 'active'
         LIMIT 1`,
        [topic, kanbanColumn, workspaceId]
    );
    const rows = this._readRows(stmt);
    return rows.length > 0 ? rows[0] : null;
}
```

**Note on whitespace normalization**: The SQL `LOWER()` comparison handles case but not whitespace collapse. The `_findExistingPlanInNewColumn` helper normalizes the input title before passing it to the DB query. For the DB-side topic, we rely on the fact that plan titles are typically clean (no multi-space). If a more robust match is needed, fetch all CREATED plans via `getBoard()` and filter in-memory with full normalization. The current approach is sufficient for the NotebookLM workflow where titles are machine-generated and consistent.

### TaskViewerProvider: Overwrite Helper

```typescript
private async _overwriteExistingPlan(record: KanbanPlanRecord, newContent: string): Promise<void>
```

Implementation:
1. Resolve absolute path from `record.planFile`.
2. Add path to `_pendingPlanCreations` (suppress watcher, same as line 15451).
3. Add path to `_planCreationInFlight` (mutex, same as line 12313).
4. Write `newContent` to the file path via `fs.writeFileSync`.
5. Update DB `updatedAt` via `db.updateLastActionByPlanFile(record.planFile, record.workspaceId, 'notebooklm_overwrite')`.
6. In `finally` block: remove from `_planCreationInFlight`, schedule removal from `_pendingPlanCreations` after 2-second TTL (same as line 15526).
7. Do NOT create a new run sheet (existing one remains valid).
8. Do NOT change the Kanban column (plan stays in CREATED/NEW).

### Webview Feedback

In `planning.js`, add a response handler (in the existing message listener, after the `airlock_exportComplete` case at line 3449):

```javascript
case 'importNotebookLMPlansResult':
    handleImportNotebookLMPlansResult(msg);
    break;
```

Handler function:

```javascript
function handleImportNotebookLMPlansResult(msg) {
    const webaiStatus = document.getElementById('webai-status');
    const importBtn = document.getElementById('btn-import-notebooklm-plans');
    if (webaiStatus) {
        const parts = [];
        if (msg.overwritten > 0) parts.push(`${msg.overwritten} overwritten`);
        if (msg.created > 0) parts.push(`${msg.created} created`);
        if (msg.errors > 0) parts.push(`${msg.errors} failed`);
        webaiStatus.textContent = parts.length > 0 ? `Import: ${parts.join(', ')}` : 'No plans found in clipboard.';
    }
    if (importBtn) {
        importBtn.disabled = false;
        importBtn.textContent = 'IMPORT PLANS';
    }
}
```

### Button Click Handler

In `planning.js`, add after the existing NotebookLM button listeners (after line 505):

```javascript
const importNotebookLMBtn = document.getElementById('btn-import-notebooklm-plans');
if (importNotebookLMBtn) {
    importNotebookLMBtn.addEventListener('click', () => {
        importNotebookLMBtn.disabled = true;
        importNotebookLMBtn.textContent = 'IMPORTING...';
        vscode.postMessage({ type: 'importNotebookLMPlans' });
    });
}
```

## Proposed Changes

### src/webview/planning.html
- **Context**: NotebookLM card at lines 3082-3108. Step 3 ends at line 3107, card closes at line 3108.
- **Logic**: Insert Step 4 section between lines 3107 and 3108. Update Step 3 description at line 3105.
- **Implementation**: Add `.planning-card-section` div with title "4. IMPORT PLANS", description, and `#btn-import-notebooklm-plans` button. Change Step 3 description to reference Step 4.
- **Edge Cases**: Button must use `planning-button secondary` class to match existing secondary button styling.

### src/webview/planning.js
- **Context**: NotebookLM button listeners at lines 454-505. Message handler at line 3449.
- **Logic**: Add click listener for `#btn-import-notebooklm-plans` (disable + post message). Add response handler for `importNotebookLMPlansResult`.
- **Implementation**: Follow exact pattern of `btn-bundle-code` (lines 454-465) for click handler. Follow `handleAirlockExportComplete` (lines 2903-2913) for result handler.
- **Edge Cases**: Button must be re-enabled on both success and error. Status element `webai-status` already exists at line 3086.

### src/services/PlanningPanelProvider.ts
- **Context**: Message switch block at lines 1024-2520. Airlock handlers at lines 1440-1456.
- **Logic**: Add `importNotebookLMPlans` case that fires the VSCode command and posts result back to webview.
- **Implementation**: Insert after `importPlansFromClipboard` case (line 1434). Await command result, post `importNotebookLMPlansResult` message.
- **Edge Cases**: Command may return undefined if taskViewerProvider is not initialized. Guard with optional chaining.

### src/extension.ts
- **Context**: Command registrations around lines 658-661.
- **Logic**: Register `switchboard.importNotebookLMPlans` command that calls `taskViewerProvider.importNotebookLMPlans()`.
- **Implementation**: Follow exact pattern of `switchboard.importPlanFromClipboard` registration at line 658.
- **Edge Cases**: `taskViewerProvider` may be undefined — use optional chaining.

### src/services/TaskViewerProvider.ts
- **Context**: `importPlanFromClipboard` at lines 15243-15324, `_importMultiplePlansFromClipboard` at lines 15326-15423, `_createInitiatedPlan` at lines 15425-15528.
- **Logic**: Add `importNotebookLMPlans` public method, `_findExistingPlanInNewColumn` private helper, `_overwriteExistingPlan` private helper.
- **Implementation**: Reuse clipboard reading logic from `importPlanFromClipboard` (lines 15257-15268). Reuse multi-plan splitting logic from `_importMultiplePlansFromClipboard` (lines 15326-15423). Add title normalization helper. Wrap overwrite in `_pendingPlanCreations` + `_planCreationInFlight` mutex.
- **Edge Cases**: Empty clipboard, oversized content, plans without H1 headers in multi-plan mode (use numbered defaults — these won't match and will create new plans, which is correct behavior).

### src/services/KanbanDatabase.ts
- **Context**: `getPlanByTopic` at lines 2331-2343.
- **Logic**: Add `getPlanByTopicAndColumn` method that adds `kanban_column = ?` filter.
- **Implementation**: Copy `getPlanByTopic`, add column parameter and WHERE clause.
- **Edge Cases**: Column name must be exact string match ('CREATED'). No normalization needed for column names.

## Verification Plan

### Automated Tests
- **Test 1**: Mock Kanban DB with 2 plans in CREATED column and 1 in DISPATCHED column. Import clipboard with 3 plans (2 matching titles, 1 new). Assert: 2 existing files overwritten in-place, 1 new file created, no duplicate Kanban cards, plan in DISPATCHED column untouched.
- **Test 2**: Import clipboard with title that differs only in case/whitespace from a CREATED plan (e.g., "fix  AUTH  bug" vs "Fix Auth Bug"). Assert: overwrite occurs (case-insensitive match).
- **Test 3**: Empty clipboard → warning shown, no files created.
- **Test 4**: Multi-plan clipboard with `--- PLAN ---` separators → each plan processed independently with overwrite-or-create logic.
- **Test 5**: Concurrent import + dispatch race → `_planCreationInFlight` mutex prevents corruption.

### Manual Verification
- Click IMPORT PLANS button → verify button disables and shows "IMPORTING...".
- After import completes → verify `webai-status` shows summary (e.g., "Import: 2 overwritten, 1 created").
- Verify overwritten plan files contain new content.
- Verify overwritten plans remain in CREATED column (column unchanged).
- Verify Step 3 description now references Step 4.

## Scope

- Tightly scoped to the **NEW** (`CREATED`) column. Plans in any other column are never overwritten.
- Applies to both single-plan and multi-plan clipboard content.

## Risks

- **Title collision false positives**: Two genuinely different plans with the same title in NEW could overwrite each other. Mitigation: normalize whitespace and compare case-insensitively, but accept this as a reasonable trade-off since users control the titles.
- **Concurrent edits**: If a plan is being dispatched from NEW while import runs, the overwrite could race. Mitigation: reuse the existing `_planCreationInFlight` mutex pattern around file writes.
- **Whitespace normalization gap**: SQL `LOWER()` does not collapse multi-space. Mitigation: normalize input title in JS before querying; DB-side topics are typically clean.

## Non-Goals

- Overwriting plans in columns other than NEW.
- Merging plan content (always full overwrite).
- Changing the existing Kanban board "Import from clipboard" button behavior (that remains as-is for general use).

## Recommendation

Complexity 5 → **Send to Coder**
