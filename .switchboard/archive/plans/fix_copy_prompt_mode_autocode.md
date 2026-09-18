# Fix: Copy Prompt Mode on AUTOCODE Column Does Not Work

## Goal

Fix the copy-prompt drag-drop mode toggle on the AUTOCODE (CODED_AUTO) column so that dropped plans actually copy prompts to the clipboard and the toggle state persists across backend refreshes.

## Metadata

**Tags:** bugfix, frontend, UI, workflow
**Complexity:** 2

## User Review Required

No — the root cause is unambiguous and the fix is two localized one-line changes in a single frontend file.

## Complexity Audit

### Routine
- Change drop handler mode lookup from `resolvedTarget` to `'CODED_AUTO'` (`src/webview/kanban.html:4315`).
- Change `updateColumnDragDropModes` handler from full replacement to a key-by-key merge (`src/webview/kanban.html:4854`).

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None introduced. The merge preserves `CODED_AUTO` state when backend refresh messages arrive.
- **Security:** `msg.modes` originates from the extension backend (trusted). No user input is evaluated.
- **Side Effects:** The merge strategy keeps stale keys for columns removed from `effectiveModes`, but the backend never removes built-in columns without a full reload, so this is harmless. If the backend later explicitly sends a `CODED_AUTO` key, it will overwrite the frontend value — this is desired behavior.
- **Dependencies & Conflicts:** None. Self-contained frontend fix; no backend, API, or database changes.

## Dependencies

- None

## Adversarial Synthesis

Key risks: (1) The `CODED_AUTO` mode is purely frontend state and will reset to `cli` on full reload because the backend does not persist it. (2) The merge strategy never deletes keys, so hypothetically stale column modes could linger, but this is benign given the backend's behavior. Mitigations: keep the fix minimal; do not attempt backend persistence for a synthetic column in this bug-fix scope.

## Proposed Changes

### `src/webview/kanban.html`

**Drop handler mode lookup (line ~4315)**
- **Context:** When a card is dropped onto `CODED_AUTO`, `handleDrop` resolves the real coder column via `resolveCodedAutoTarget(card)`, then reads the drag-drop mode from `columnDragDropModes[resolvedTarget]`. Because `resolvedTarget` is a real column (e.g., `LEAD CODED`) and the user toggled mode on the synthetic `CODED_AUTO` column, the lookup misses and falls back to `cli`.
- **Logic:** The mode authority for drops onto `CODED_AUTO` is the `CODED_AUTO` toggle, not the resolved real column.
- **Implementation:** Change `const dropMode = columnDragDropModes[resolvedTarget] || 'cli';` to `const dropMode = columnDragDropModes['CODED_AUTO'] || 'cli';`.
- **Edge Cases:** If `CODED_AUTO` has no mode entry (first load), it falls back to `'cli'` as before.

**Preserve frontend-only keys in `updateColumnDragDropModes` (line ~4854)**
- **Context:** The backend's `_buildKanbanColumns` knows nothing about the frontend-only synthetic `CODED_AUTO` column, so `effectiveModes` omits it. When the handler assigns `columnDragDropModes = msg.modes`, the `CODED_AUTO` key is erased, causing the toggle to bounce back to CLI after any backend refresh.
- **Logic:** Merge incoming backend modes into the existing object instead of replacing it wholesale.
- **Implementation:** Replace `columnDragDropModes = msg.modes;` with a loop: `for (const [key, value] of Object.entries(msg.modes)) { columnDragDropModes[key] = value; }`.
- **Edge Cases:** If the backend ever sends a `CODED_AUTO` key, it will overwrite the frontend value — correct because backend should win for known columns.

## Verification Plan

### Automated Tests
- Update `src/test/kanban-coded-auto-batching-regression.test.js` to assert that the `CODED_AUTO` drop block uses `columnDragDropModes['CODED_AUTO']` rather than `columnDragDropModes[resolvedTarget]`.
- Create `src/test/kanban-coded-auto-prompt-mode-regression.test.js` to assert:
  - The `updateColumnDragDropModes` handler merges with `Object.entries(msg.modes)` instead of replacing `columnDragDropModes`.
  - The toggle-icon update loop inside that handler still references `columnDragDropModes[colId]`.
- Run existing kanban regression tests to confirm no regressions:
  ```bash
  node src/test/kanban-coded-auto-batching-regression.test.js
  node src/test/kanban-coded-auto-drag-out-regression.test.js
  node src/test/kanban-complexity-regression.test.js
  node src/test/kanban-smart-router-regression.test.js
  ```

### Manual Verification
1. Open the kanban board with coder columns collapsed (AUTOCODE visible).
2. Click the mode toggle on AUTOCODE — verify it switches to the prompt icon (teal clipboard).
3. Drag a plan from **NEW** into **AUTOCODE**.
4. Confirm:
   - A toast appears: *"Copied prompt for N plan(s) to clipboard."*
   - The prompt is actually on the system clipboard (paste test).
   - The mode toggle **remains** on the prompt icon after the drop completes.
5. Refresh the board (e.g. by switching workspaces or waiting for a natural refresh) and confirm the toggle still shows prompt mode.

---

## Bug Summary
The copy-prompt mode toggle on the AUTOCODE (CODED_AUTO) column does not function:
- Clicking the toggle appears to switch to "Copy Prompt" mode, but when dragging a plan into AUTOCODE, **no prompt is copied to the clipboard**.
- After the drag completes, the mode toggle **bounces back to CLI Dispatch**.

## Root Cause Analysis

Two related frontend bugs in `src/webview/kanban.html`:

### Bug 1: Drop handler looks up mode on resolved real column instead of CODED_AUTO
In the `handleDrop` function for drops onto `CODED_AUTO` (lines ~4296–4357), each card is routed to a real coder column (`LEAD CODED`, `CODER CODED`, or `INTERN CODED`) based on complexity routing. The drop handler then reads the drag-drop mode using the **resolved real column ID**:

```javascript
const resolvedTarget = resolveCodedAutoTarget(card);  // e.g. "LEAD CODED"
const dropMode = columnDragDropModes[resolvedTarget] || 'cli';  // BUG: looks up LEAD CODED, not CODED_AUTO
```

The user toggled mode on the **AUTOCODE** (`CODED_AUTO`) column, so `columnDragDropModes['CODED_AUTO'] = 'prompt'`. But `columnDragDropModes['LEAD CODED']` is undefined, so `dropMode` silently falls back to `'cli'`. The frontend therefore sends a CLI dispatch or simple move instead of `promptOnDrop`, and **no prompt is ever generated**.

### Bug 2: `updateColumnDragDropModes` destructively overwrites frontend state
The message handler for `updateColumnDragDropModes` (line ~4852) does a full replacement:

```javascript
case 'updateColumnDragDropModes':
    if (msg.modes && typeof msg.modes === 'object') {
        columnDragDropModes = msg.modes;  // BUG: wipes CODED_AUTO key
        ...
    }
```

`CODED_AUTO` is a **frontend-only synthetic column** (created inside `renderColumns()` when `collapseCodersEnabled` is true). The backend’s `_buildKanbanColumns()` knows nothing about it, so `_refreshBoard()` sends `effectiveModes` containing only real columns. When the frontend receives that message, `columnDragDropModes['CODED_AUTO']` is erased. The next re-render shows the toggle as CLI, causing the **bounce-back**.

## Fix Plan

### Step 1: Fix drop handler mode lookup (kanban.html)
In `handleDrop`, when processing a drop onto `CODED_AUTO`, use the synthetic column’s mode instead of the resolved real column’s mode:

**File:** `src/webview/kanban.html`  
**Change at line ~4315:**
```javascript
// BEFORE:
const dropMode = columnDragDropModes[resolvedTarget] || 'cli';

// AFTER:
const dropMode = columnDragDropModes['CODED_AUTO'] || 'cli';
```

Rationale: The mode toggle the user interacts with belongs to `CODED_AUTO`; that is the authority for drops onto the AUTOCODE bucket.

### Step 2: Preserve frontend-only keys in `updateColumnDragDropModes` (kanban.html)
Merge incoming modes instead of replacing the entire object:

**File:** `src/webview/kanban.html`  
**Change at line ~4854:**
```javascript
// BEFORE:
columnDragDropModes = msg.modes;

// AFTER:
for (const [key, value] of Object.entries(msg.modes)) {
    columnDragDropModes[key] = value;
}
```

Rationale: This keeps `CODED_AUTO` (and any future frontend-only synthetic columns) intact while still updating real-column overrides from the backend.

### Step 3: Verification
1. Open the kanban board with coder columns collapsed (AUTOCODE visible).
2. Click the mode toggle on AUTOCODE — verify it switches to the prompt icon (teal clipboard).
3. Drag a plan from **NEW** into **AUTOCODE**.
4. Confirm:
   - A toast appears: *"Copied prompt for N plan(s) to clipboard."*
   - The prompt is actually on the system clipboard (paste test).
   - The mode toggle **remains** on the prompt icon after the drop completes.
5. Refresh the board (e.g. by switching workspaces or waiting for a natural refresh) and confirm the toggle still shows prompt mode.

## Files to Change
- `src/webview/kanban.html` (~2 line changes)

## Risk Assessment
- **Low risk.** Both changes are localized to the webview frontend. No backend API or database schema is touched.
- The merge strategy in Step 2 is additive; it cannot remove valid backend state.

**Recommendation: Send to Coder.**

---

## Direct Reviewer Pass

### Stage 1: Grumpy Principal Engineer Review
- **Findings:** Hmph. The frontend fixes are actually implemented as requested in `kanban.html`. You correctly hooked `dropMode` to the synthetic `CODED_AUTO` column and implemented the backend `effectiveModes` payload merge logic rather than blowing away the whole object. The minimal required fixes were done without over-engineering state persistence for a synthetic bucket. Acceptable.
- **Severity:** NIT

### Stage 2: Balanced Synthesis
- **Assessment:** The implementation in `src/webview/kanban.html` meets the exact requirements of the plan. 
- **Actionable Fixes:** None required. The implementation is solid.

### Validation Results
- **Files Changed:** `src/webview/kanban.html`
- **Tests:** `kanban-coded-auto-batching-regression.test.js` and `kanban-coded-auto-prompt-mode-regression.test.js` verified and passing.
- **Remaining Risks:** None.
- **Status:** **APPROVED & VERIFIED**
