# Fix Kanban Automation Tab Bugs

## Goal

Fix three UI/UX bugs in the Antigravity Automation section of the kanban.html automation tab: add a column selector dropdown, display frontend column labels instead of backend IDs, and improve the description text. The backend handler must also be updated to accept and use the selected column parameter.

## Metadata

- **Tags:** frontend, backend, bugfix, UI
- **Complexity:** 4

## User Review Required

> [!IMPORTANT]
> The backend changes (KanbanProvider.ts) are **mandatory**, not optional. The existing `_generateAntigravityPrompt` method hardcodes `'CREATED'` in the DB query and error message. Without updating the method signature and the `generateAntigravityPrompt` case handler to pass `msg.column`, the column selector dropdown will have no effect.

## Complexity Audit

### Routine
- Update description text string (single line change in kanban.html)
- Add column dropdown element after agentSelect (mirrors existing agentSelect pattern)
- Pass `col.label` for display and `col.id` for value (already available from `columnDefinitions`)
- Thread `column` parameter through message handler case in KanbanProvider.ts
- Add `renderAutobanPanel()` call to `updateColumns` message handler

### Complex / Risky
- Backend method signature change (`_generateAntigravityPrompt`) touches an async method used by a message-handling pipeline; must ensure `column` fallback to `'CREATED'` if not provided to avoid regressions for any future callers
- Safe default column selection: `columnDefinitions` may not contain `'CREATED'` in custom kanban setups — must fall back to `columnDefinitions[0].id`

## Edge-Case & Dependency Audit

- **Race Conditions:** The automation panel is rebuilt on `terminalStatuses` and `customAgents` broadcasts. The `updateColumns` message does NOT currently trigger `renderAutobanPanel()`, so the column dropdown can become stale if column definitions change while the automation tab is open. Fix: add `renderAutobanPanel()` to the `updateColumns` handler.
- **Security:** No security surface — this is a UI-level message passing change within the extension webview.
- **Side Effects:** Adding `renderAutobanPanel()` to `updateColumns` causes an extra re-render of the automation panel on column config changes. This is consistent with existing behaviour (same function already runs on `terminalStatuses`). Guard: the existing `isAutobanPanelInteracting` guard in `renderAutobanPanel()` prevents re-render during active user interaction.
- **Dependencies & Conflicts:** `columnDefinitions` is a module-level variable initialized with defaults and updated via `updateColumns`. The new dropdown reads it at render time, so it will always reflect the current state at the time the panel is rendered.

## Dependencies

- None (self-contained within this PR)

## Adversarial Synthesis

Key risks: (1) the backend column parameter is non-optional — the DB query and error message in `_generateAntigravityPrompt` are hardcoded to `'CREATED'` and will silently ignore the frontend selection without explicit code changes; (2) the column dropdown will show stale data if `updateColumns` fires while the automation tab is open, since `renderAutobanPanel()` is not called there. Mitigations: make the backend changes mandatory in the plan (not conditional), add a `renderAutobanPanel()` call in the `updateColumns` handler, and use a safe fallback default for the column selector.

## Proposed Changes

---

### `src/webview/kanban.html`

#### Change 1 — Update Description Text (Line 5519)

**Context:** The `antigravityDesc` text currently says "for the oldest plan in the CREATED column" which will be inaccurate after the column selector is added.

**Logic:** Replace with a two-sentence description that explains both the column selection and the use of the generated prompt.

**Implementation:**

```javascript
// Line 5519 — change:
antigravityDesc.textContent = 'Select an agent and copy a prompt (using prompts tab configuration) for the oldest plan in the CREATED column.';

// To:
antigravityDesc.textContent = 'Select an agent and column, then copy a prompt (using prompts tab configuration) for the oldest plan in that column. Paste this prompt into the Antigravity automation timer (or similar IDE feature) to have Antigravity process all plans in a kanban column.';
```

**Edge Cases:** None — purely cosmetic string change.

---

#### Change 2 — Add Column Dropdown (Lines 5539–5540, after `agentSelect` is appended)

**Context:** `antigravityActions` uses `display:flex; gap:8px; align-items:center`. The new dropdown should sit between `agentSelect` and `copyPromptBtn`, on the same row.

**Logic:** Create a `<select>` element, populate it from `columnDefinitions` (using `col.label` for display, `col.id` as value), default to `'CREATED'` with fallback to the first column.

**Implementation:**

```javascript
// Insert between antigravityActions.appendChild(agentSelect) [line 5539] and the copyPromptBtn block [line 5541]:

const columnSelect = document.createElement('select');
columnSelect.style.cssText = 'background:var(--panel-bg2); border:1px solid var(--border-color); color:var(--text-primary); font-family:var(--font-mono); font-size:10px; padding:2px 4px; border-radius:3px; flex:1;';
guardInteraction(columnSelect);

columnDefinitions.forEach(col => {
    const opt = document.createElement('option');
    opt.value = col.id;
    opt.textContent = col.label;
    columnSelect.appendChild(opt);
});

// Default to 'CREATED'; fall back to first column if not present
const createdExists = columnDefinitions.some(col => col.id === 'CREATED');
columnSelect.value = createdExists ? 'CREATED' : (columnDefinitions[0]?.id || '');

antigravityActions.appendChild(columnSelect);
```

**Edge Cases:**
- If `columnDefinitions` is empty (shouldn't happen given defaults), `columnSelect` will be empty and `columnSelect.value` will be `''`; the backend already guards against missing data.
- Default `'CREATED'` must be set after options are appended (setting `.value` before options exist has no effect).

---

#### Change 3 — Pass `column` in the `generateAntigravityPrompt` Message (Lines 5558–5562)

**Context:** The `postKanbanMessage` call in `copyPromptBtn`'s click handler currently only passes `agent` and `workspaceRoot`. The new `column` field must be added.

**Implementation:**

```javascript
// Lines 5558–5562 — change:
postKanbanMessage({
    type: 'generateAntigravityPrompt',
    agent: selectedAgent,
    workspaceRoot: getActiveWorkspaceRoot()
});

// To:
postKanbanMessage({
    type: 'generateAntigravityPrompt',
    agent: selectedAgent,
    column: columnSelect.value,
    workspaceRoot: getActiveWorkspaceRoot()
});
```

**Edge Cases:** If `columnSelect.value` is `''` (empty definitions edge case), the backend will fall back to `'CREATED'` (after the backend fallback is added in Change 5).

---

#### Change 4 — Trigger `renderAutobanPanel()` on `updateColumns` (Lines 4703–4714)

**Context:** The `updateColumns` message handler updates `columnDefinitions` but does not call `renderAutobanPanel()`. This means the column dropdown shows stale data if columns change while the automation tab is visible.

**Implementation:**

```javascript
// Lines 4703–4714 — inside the 'updateColumns' case, add one line after existing updates:
case 'updateColumns':
    if (Array.isArray(msg.columns) && msg.columns.length > 0) {
        columnDefinitions = msg.columns;
        columns = columnDefinitions.map(col => col.id);
        autobanColumns = columnDefinitions.filter(col => col.autobanEnabled).map(col => col.id);
        lastBoardSignature = '';
        renderColumns();
        renderBoard(currentCards);
        updateAllColumnAgents();
        updateAutobanIndicators();
        renderAutobanPanel();  // ADD THIS LINE — keeps column dropdown in sync
    }
    break;
```

**Edge Cases:** `renderAutobanPanel()` already guards against re-rendering during user interaction via `isAutobanPanelInteracting`, so this is safe.

---

### `src/services/KanbanProvider.ts`

#### Change 5 — Update `generateAntigravityPrompt` Case Handler (Lines 5886–5890)

**Context:** The case handler currently calls `_generateAntigravityPrompt(msg.agent, workspaceRoot)` without passing `msg.column`. The column parameter is never forwarded to the backend method.

**Implementation:**

```typescript
// Lines 5886–5890 — change:
case 'generateAntigravityPrompt': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    if (!workspaceRoot || typeof msg.agent !== 'string') break;
    await this._generateAntigravityPrompt(msg.agent, workspaceRoot);
    break;
}

// To:
case 'generateAntigravityPrompt': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    if (!workspaceRoot || typeof msg.agent !== 'string') break;
    const column = typeof msg.column === 'string' && msg.column.trim() ? msg.column.trim() : 'CREATED';
    await this._generateAntigravityPrompt(msg.agent, workspaceRoot, column);
    break;
}
```

**Edge Cases:** Defaults to `'CREATED'` if `msg.column` is missing or empty — preserves backward compatibility.

---

#### Change 6 — Update `_generateAntigravityPrompt` Method Signature and Body (Lines 2313–2358)

**Context:** The method hardcodes `'CREATED'` in the DB query (line 2349) and in the error message (line 2355). Both must use the passed `column` parameter.

**Implementation:**

```typescript
// Line 2313 — change:
private async _generateAntigravityPrompt(agentName: string, workspaceRoot: string): Promise<void> {

// To:
private async _generateAntigravityPrompt(agentName: string, workspaceRoot: string, column: string = 'CREATED'): Promise<void> {
```

```typescript
// Line 2349 — change:
const createdPlans = await db.getPlansByColumn(workspaceId, 'CREATED');

// To:
const createdPlans = await db.getPlansByColumn(workspaceId, column);
```

```typescript
// Line 2355 — change:
error: 'No plans found in CREATED column'

// To:
error: `No plans found in ${column} column`
```

**Edge Cases:**
- The default parameter value `column = 'CREATED'` ensures any other internal callers (currently none, but future-proofs the API) still work without passing a column.
- If `column` is an invalid column ID, `db.getPlansByColumn` returns an empty array, triggering the existing "no plans found" error path — no crash risk.

---

## Verification Plan

### Automated Tests
- (Skipped per session policy)

### Manual Verification
1. Open the kanban panel and navigate to the **Automation** tab.
2. Verify the **ANTIGRAVITY AUTOMATION** section shows:
   - Updated two-sentence description text
   - Agent dropdown with available agents
   - **Column dropdown** with frontend labels (e.g., "New", "Planned", "Lead Coder") — not backend IDs
   - Column dropdown defaults to "New" (the label for `CREATED`)
3. Select a non-default column (e.g., "Planned") and click **COPY PROMPT** — verify the generated prompt targets plans from `PLAN REVIEWED`, not `CREATED`.
4. Reload the webview and verify that changing kanban column definitions (via settings) causes the column dropdown to update.
5. Verify the **COPY PROMPT** button error message reflects the selected column (e.g., "No plans found in PLAN REVIEWED column").

---

**Recommendation:** Send to Coder
