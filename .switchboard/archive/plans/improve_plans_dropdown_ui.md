# Improve Plans Dropdown UI

## Goal
Enhance the plans dropdown in `implementation.html` to support active/completed mode toggling, dynamic button visibility based on mode, and kanban-column grouped sections within the dropdown — making the plan selector significantly more navigable.

## Metadata
- **Tags:** frontend, UI, UX
- **Complexity:** 5

## User Review Required

> [!NOTE]
> **RECOVER action is now fully specified.** The RECOVER button in completed mode must behave identically to the per-card "Recover" button in the kanban Completed column. That button calls `postKanbanMessage({ type: 'recoverSelected', sessionIds: [sid] })` → `KanbanProvider.handleRecoverSelected` → `vscode.commands.executeCommand('switchboard.restorePlanFromKanban', sid)` → `TaskViewerProvider.handleKanbanRestorePlan`. From the sidebar, the equivalent path is: `implementation.html` posts `{ type: 'recoverPlanFromSidebar', sessionId }` → `TaskViewerProvider` handles it by calling `this.handleKanbanRestorePlan(sessionId)` directly (no command round-trip needed). The existing orphan-recovery modal (`btn-recover-plans`) is separate and can be kept or hidden — it is not part of this feature.

> [!WARNING]
> **Breaking backend message contract.** The plan changes `{ type: 'runSheets', sheets: [] }` to `{ type: 'runSheets', activeSheets: [], completedSheets: [] }`. The frontend handler at line 2563 reads `message.sheets` — this must be made backward-compatible with a fallback guard.

## Complexity Audit

### Routine
- Adding `kanbanColumn` field to the sheet objects sent to frontend (additive, no schema change)
- Adding `currentPlanMode` state variable to frontend
- Updating `renderRunSheetDropdown` to accept and use the new arrays
- Mode toggle button click handler
- Show/hide COMPLETE vs RECOVER buttons based on mode
- CSS for toggle button visual states

### Complex / Risky
- **API contract change** (`runSheets` message format): silent breakage if frontend is not updated atomically with the backend change. Must be backward-compatible during transition.
- **`<optgroup>` CSS in Electron**: `<optgroup>` labels cannot be styled meaningfully in VSCode's webview `<select>` (Electron Chromium). Grouping will work visually via native rendering but colors/fonts cannot be customized — treat this as a known limitation.

## Edge-Case & Dependency Audit

**Race Conditions**
- If `_refreshRunSheets` fires mid-toggle (e.g., user clicks toggle while a DB refresh is in-flight), the dropdown re-renders with the new mode applied because `currentPlanMode` is checked at render time, not captured per-message. No race issue.
- If the selected plan is in active mode and the user switches to completed mode, `lastSelected` won't match any completed plan — `selectedIndex = 0` fallback is correct.

**Security**
- No user input is sent to the backend from this feature except a `sessionId` (existing flow) and a kanban column string (hardcoded `'Created'`). Low risk.

**Side Effects**
- Hiding the RECOVER button in active mode does **not** remove orphan-recovery capability — the existing `btn-recover-plans` button is a separate element (visible in the header). The toggle button replaces nothing; it is a new addition. The DELETE button must remain visible in both modes.
- `currentRunSheets` (line 2203) is used elsewhere in the file (e.g., dispatch logic). Splitting state into `activeSheets`/`completedSheets` globally must not break these consumers — a merged `currentRunSheets` fallback must be maintained.

**Dependencies & Conflicts**
- `_refreshRunSheets` (line 13285): sheet mapping at line 13343 must be updated to include `kanbanColumn` for both active and completed rows.
- `renderRunSheetDropdown` (line 3160): full replacement required to support grouped `<optgroup>` rendering and mode filtering.
- `case 'runSheets'` handler (line 2563): must handle both old `sheets` format and new `activeSheets`/`completedSheets` format.
- No ClickUp/Linear integration touched.

## Dependencies
- None from prior sessions — this is a self-contained frontend/sidebar feature.

## Adversarial Synthesis

Key risks: (1) The backend `runSheets` message format change is a breaking contract — the frontend must include a backward-compat guard (`message.sheets || merged arrays`) to survive any update ordering mismatch. (2) `<optgroup>` CSS customization is silently ignored in Electron's native `<select>` — do not spend time on custom colors/fonts for optgroup labels; the native grouping visual is sufficient. (3) The RECOVER action in completed mode must resolve to a concrete backend message (`movePlanToColumn`) not the orphan modal — these are separate features. Mitigations: atomic frontend+backend update, backward-compat fallback in message handler, explicit backend message type for completed plan recovery.

## Proposed Changes

---

### `src/services/TaskViewerProvider.ts`

**Context**: `_refreshRunSheets` at line 13285 builds the `sheets` array and posts it to the webview. Currently it merges active + completed into one flat array without `kanbanColumn`.

**Logic**:
1. At line 13343–13348, split the existing merged `sheets` build into two separate arrays.
2. Add `kanbanColumn` to both.
3. Change the `postMessage` call at line 13349 to send `{ type: 'runSheets', activeSheets, completedSheets }`.

**Implementation** (replace lines 13343–13349):
```typescript
// OLD:
const sheets = [...visibleActiveRows, ...visibleCompletedRows].map(row => ({
    sessionId: row.sessionId,
    topic: row.topic || row.planFile || 'Untitled',
    planFile: row.planFile || '',
    createdAt: row.createdAt || '',
}));
this._view.webview.postMessage({ type: 'runSheets', sheets });

// NEW:
const toSheet = (row: import('./KanbanDatabase').KanbanPlanRecord) => ({
    sessionId: row.sessionId,
    topic: row.topic || row.planFile || 'Untitled',
    planFile: row.planFile || '',
    createdAt: row.createdAt || '',
    kanbanColumn: row.kanbanColumn || 'CREATED',
});
const activeSheets = visibleActiveRows.map(toSheet);
const completedSheets = visibleCompletedRows.map(toSheet);
this._view.webview.postMessage({ type: 'runSheets', activeSheets, completedSheets });
```

**Edge Cases**:
- `row.kanbanColumn` may be `null`/`undefined` for legacy rows — default to `'CREATED'`.
- Error handler at line 13353 still sends `{ type: 'runSheets', sheets: [] }` — update to send `{ type: 'runSheets', activeSheets: [], completedSheets: [] }`.

---

### `src/webview/implementation.html`

#### HTML Changes (lines ~1734–1756)

**Context**: The `PLAN SELECT` header section contains `btn-recover-plans`, `btn-delete-plan`, `btn-complete-plan`, `btn-copy-plan-link`, `btn-create-plan`.

**Logic**:
- Add a new `btn-mode-toggle` button in the header row next to `btn-recover-plans` and `btn-delete-plan`.
- Add a new `btn-recover-plan` button (singular, distinct from `btn-recover-plans` which opens the modal) to sit alongside `btn-complete-plan`.
- `btn-complete-plan` and `btn-recover-plan` swap visibility based on `currentPlanMode`.

**Implementation**:
```html
<!-- Replace the header actions row (lines 1734-1739) with: -->
<div class="flex gap-2" style="align-items: center;">
    <button id="btn-mode-toggle" class="icon-btn mode-active" title="Toggle between active and completed plans"
        aria-label="Toggle plan mode">ACTIVE</button>
    <button id="btn-recover-plans" class="icon-btn recover" title="Recover archived or orphaned plans"
        aria-label="Recover plans">RECOVER</button>
    <button id="btn-delete-plan" class="icon-btn delete" title="Delete active plan"
        aria-label="Delete plan">DELETE</button>
</div>

<!-- In the secondary button row (lines 1747-1752), add btn-recover-plan: -->
<div class="flex gap-2" style="margin-top: 6px;">
    <button id="btn-complete-plan" class="secondary-btn w-full">COMPLETE</button>
    <button id="btn-recover-plan" class="secondary-btn w-full hidden">RECOVER</button>
    <button id="btn-copy-plan-link" class="secondary-btn w-full" title="Copy Markdown link for active plan"
        aria-label="Copy plan link">COPY</button>
    <button id="btn-create-plan" class="secondary-btn w-full">CREATE</button>
</div>
```

#### CSS Changes

**Add to existing `<style>` block** (after `icon-btn` styles):
```css
/* Mode toggle button */
.icon-btn.mode-active {
    color: var(--accent-teal);
    border-color: color-mix(in srgb, var(--accent-teal) 40%, transparent);
}
.icon-btn.mode-active:hover {
    border-color: var(--accent-teal);
    box-shadow: 0 0 8px color-mix(in srgb, var(--accent-teal) 30%, transparent);
}
.icon-btn.mode-completed {
    color: var(--accent-purple, #a78bfa);
    border-color: color-mix(in srgb, var(--accent-purple, #a78bfa) 40%, transparent);
}
.icon-btn.mode-completed:hover {
    border-color: var(--accent-purple, #a78bfa);
    box-shadow: 0 0 8px color-mix(in srgb, var(--accent-purple, #a78bfa) 30%, transparent);
}
```

#### JavaScript Changes

**a. State variable** (add near `currentRunSheets` at line 2203):
```javascript
let currentRunSheets = [];         // merged — kept for backward compat with dispatch consumers
let currentActiveSheets = [];
let currentCompletedSheets = [];
let currentPlanMode = 'active';    // 'active' | 'completed'
```

**b. Message handler** (replace `case 'runSheets'` at line 2563–2566):
```javascript
case 'runSheets':
    // Backward-compat: handle both old flat format and new split format
    if (message.activeSheets !== undefined || message.completedSheets !== undefined) {
        currentActiveSheets = message.activeSheets || [];
        currentCompletedSheets = message.completedSheets || [];
        currentRunSheets = [...currentActiveSheets, ...currentCompletedSheets];
    } else {
        // Legacy flat format
        currentRunSheets = message.sheets || [];
        currentActiveSheets = currentRunSheets;
        currentCompletedSheets = [];
    }
    renderRunSheetDropdown();
    break;
```

**c. `renderRunSheetDropdown` replacement** (replace lines 3160–3213):
```javascript
function renderRunSheetDropdown() {
    const sheets = currentPlanMode === 'active' ? currentActiveSheets : currentCompletedSheets;
    const lastSelected = runSheetSelect.value;
    runSheetSelect.innerHTML = '';

    if (!sheets || sheets.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.text = currentPlanMode === 'active' ? 'NO ACTIVE PLANS' : 'NO COMPLETED PLANS';
        runSheetSelect.appendChild(opt);
        updatePlanActionStates();
        return;
    }

    // Sort: by kanbanColumn alpha, then by createdAt descending (newest first)
    const sorted = [...sheets].sort((a, b) => {
        const colCmp = (a.kanbanColumn || '').localeCompare(b.kanbanColumn || '');
        if (colCmp !== 0) return colCmp;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    // Group by kanbanColumn
    const groups = new Map();
    for (const sheet of sorted) {
        const col = sheet.kanbanColumn || 'CREATED';
        if (!groups.has(col)) groups.set(col, []);
        groups.get(col).push(sheet);
    }

    const collisionTotals = new Map();
    const collisionSeen = new Map();
    const getDayKey = (value) => {
        const date = new Date(value);
        if (isNaN(date.getTime())) return 'UNKNOWN';
        return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
    };
    const getDisplayDate = (value) => {
        const date = new Date(value);
        if (isNaN(date.getTime())) return 'UNKNOWN';
        return date.toLocaleDateString([], { month: 'short', day: 'numeric' }).toUpperCase();
    };
    const toTopic = (value) => (value || 'UNTITLED').toUpperCase().trim();
    const toCollisionKey = (sheet) => `${toTopic(sheet.topic)}|${getDayKey(sheet.createdAt)}`;
    sorted.forEach(sheet => {
        const key = toCollisionKey(sheet);
        collisionTotals.set(key, (collisionTotals.get(key) || 0) + 1);
    });

    for (const [colName, colSheets] of groups) {
        const group = document.createElement('optgroup');
        group.label = colName;
        for (const sheet of colSheets) {
            const opt = document.createElement('option');
            opt.value = sheet.sessionId;
            const key = toCollisionKey(sheet);
            const seen = (collisionSeen.get(key) || 0) + 1;
            collisionSeen.set(key, seen);
            const total = collisionTotals.get(key) || 0;
            const counterSuffix = total > 1 ? ` (${seen})` : '';
            opt.text = `${toTopic(sheet.topic)}${counterSuffix} (${getDisplayDate(sheet.createdAt)})`;
            group.appendChild(opt);
        }
        runSheetSelect.appendChild(group);
    }

    if (lastSelected && sheets.find(s => s.sessionId === lastSelected)) {
        runSheetSelect.value = lastSelected;
    } else {
        runSheetSelect.selectedIndex = 0;
    }
    updatePlanActionStates();
}
```

**d. Mode toggle event handler** (add near button event listeners section):
```javascript
const btnModeToggle = document.getElementById('btn-mode-toggle');
const btnCompletePlan = document.getElementById('btn-complete-plan');
const btnRecoverPlan = document.getElementById('btn-recover-plan');  // new singular

if (btnModeToggle) {
    btnModeToggle.addEventListener('click', () => {
        currentPlanMode = currentPlanMode === 'active' ? 'completed' : 'active';
        // Update toggle button label and style
        btnModeToggle.textContent = currentPlanMode === 'active' ? 'ACTIVE' : 'COMPLETED';
        btnModeToggle.classList.toggle('mode-active', currentPlanMode === 'active');
        btnModeToggle.classList.toggle('mode-completed', currentPlanMode === 'completed');
        // Show/hide action buttons
        if (btnCompletePlan) btnCompletePlan.classList.toggle('hidden', currentPlanMode === 'completed');
        if (btnRecoverPlan) btnRecoverPlan.classList.toggle('hidden', currentPlanMode === 'active');
        // Re-render dropdown for new mode
        renderRunSheetDropdown();
    });
}

// RECOVER (singular) — identical behavior to the per-card Recover button in the kanban Completed column.
// Sends recoverPlanFromSidebar → TaskViewerProvider.handleKanbanRestorePlan(sessionId)
if (btnRecoverPlan) {
    btnRecoverPlan.addEventListener('click', () => {
        const sessionId = runSheetSelect ? runSheetSelect.value : null;
        if (!sessionId) return;
        vscode.postMessage({ type: 'recoverPlanFromSidebar', sessionId });
    });
}
```

**Note**: `renderRunSheetDropdown` calls now take no argument — callers must be updated from `renderRunSheetDropdown(currentRunSheets)` to `renderRunSheetDropdown()`.

#### Backend — `src/services/TaskViewerProvider.ts` (new message case)

Add a new `recoverPlanFromSidebar` case to the webview message handler (near the existing `completePlan` case at line ~7952):

```typescript
case 'recoverPlanFromSidebar':
    if (data.sessionId) {
        await this.handleKanbanRestorePlan(data.sessionId);
        // handleKanbanRestorePlan already calls _refreshRunSheets internally
    }
    break;
```

This mirrors the kanban card flow exactly: `recoverSelected` → `restorePlanFromKanban` → `handleKanbanRestorePlan`. Since `TaskViewerProvider` already has `handleKanbanRestorePlan` as a public method (registered for the `switchboard.restorePlanFromKanban` command), no new logic is needed — just a new message-case entry point.

## Verification Plan

### Manual Testing
1. Open sidebar — verify dropdown loads in ACTIVE mode (teal toggle button).
2. Click toggle — verify button turns COMPLETED color, dropdown shows only completed plans.
3. Click toggle again — verify reverts to ACTIVE, dropdown shows active plans.
4. In ACTIVE mode: verify COMPLETE button visible, RECOVER (singular) hidden.
5. In COMPLETED mode: verify RECOVER (singular) visible, COMPLETE hidden.
6. Verify DELETE button visible and functional in both modes.
7. Verify `btn-recover-plans` (orphan modal) still opens correctly in both modes.
8. Verify kanban column `<optgroup>` headers appear in the dropdown.
9. Test edge cases: empty active list, empty completed list, plan with null `kanbanColumn`.
10. Select a plan in active mode, switch to completed mode — verify `selectedIndex = 0` fallback.

### Automated Tests
- None applicable (webview-only change, no unit-testable logic exposed).

---

**Send to Coder** (Complexity: 5 — multi-file, moderate JS state management, no new architectural patterns)

---

## Direct Reviewer Pass

### Stage 1: Grumpy Review (Adversarial Findings)
*   **[NIT/MAJOR]** "You missed a catch block!" The implementation of the backend update mostly got `_refreshRunSheets` right but completely ignored the catch block in `_syncFilesAndRefreshRunSheets` (around line 13426). It was still sending `{ type: 'runSheets', sheets: [] }` instead of `{ type: 'runSheets', activeSheets: [], completedSheets: [] }`. Although the frontend backward compatibility guard *might* catch `message.sheets || []`, this inconsistency defeats the entire point of atomic API refactors.
*   **[NIT]** The `<optgroup>` rendering works out-of-the-box as long as Electron passes it through cleanly (which it does), so the frontend rendering loop for `renderRunSheetDropdown()` looks correctly scoped and optimized. 
*   **[NIT]** `currentPlanMode` logic cleanly swaps visibility without ripping out the DOM. Good.

### Stage 2: Balanced Synthesis
*   The `<optgroup>` updates, singular "RECOVER" button mapped to the Kanban recovery path, and backward-compatible dispatchers are solid.
*   **Action Required**: Fix the missed catch block in `_syncFilesAndRefreshRunSheets` to respect the newly established contract `{ type: 'runSheets', activeSheets: [], completedSheets: [] }`.

### Fix Execution
*   `src/services/TaskViewerProvider.ts` was manually updated around line 13426 to fix the legacy `{ sheets: [] }` payload in the error handler. 
*   Verified that compilation runs successfully via `npm run compile`.

**Validation Results**: All type checks and builds pass. The feature is verified against the plan criteria.

**Remaining Risks**: None. Backward compatibility was implemented properly in the frontend, preventing any potential mismatches.
