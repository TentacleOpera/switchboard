# Fix: AUTOCODE Column Prompt Button Labels Show Wrong Text

## Goal

Fix the copy-prompt button labels on kanban cards visually displayed in the AUTOCODE (`CODED_AUTO`) column so they correctly read **"Copy review prompt"** instead of **"Copy coder prompt"**.

## Metadata

- **Tags:** bugfix, frontend, UI
- **Complexity:** 2

## User Review Required

No

## Complexity Audit

### Routine
- Single-file conditional refactor in `src/webview/kanban.html` (~6 lines).
- Update existing regression test to use realistic column data.

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None. Label is computed synchronously during card HTML generation.
- **Security:** None. No user input is evaluated.
- **Side Effects:** Cards in individual coder columns when `collapseCodersEnabled` is false retain existing correct labels. Cards hidden due to agent visibility settings are bucketed to `CREATED` and unaffected.
- **Dependencies & Conflicts:** None. Self-contained frontend fix.

## Dependencies

- None

## Adversarial Synthesis

Key risks: (1) The test extraction window must include `collapseCodersEnabled` or the regression test will fail to evaluate the new branch; (2) The `columns.includes(id)` logic relies on the global `columns` array which is not dynamically updated by `collapseCodersEnabled`, but coder columns are visible by default so the logic holds; (3) Missing regression assertion for the uncollapsed case (`LEAD CODED` with `collapseCodersEnabled=false` should still show "Copy coder prompt"). Mitigations: expand test extraction/injection, add the uncollapsed assertion, and clarify the comment on `visibleCodedIds`.

## Bug Summary

Cards displayed in the AUTOCODE column show **"Copy coder prompt"** on their primary action button, but should show **"Copy review prompt"** because advancing from the coded state goes to `CODE REVIEWED`.

## Root Cause Analysis

Two interacting frontend bugs in `src/webview/kanban.html`:

### Bug 1: `CODED_AUTO` normalization relies on `kind: 'coded'` that real columns lack
The label logic (line ~3945) normalizes `card.column === 'CODED_AUTO'` like this:
```javascript
const sourceColumn = (card.column === 'CODED_AUTO')
    ? (columnDefinitions.find(d => d.kind === 'coded')?.id || 'LEAD CODED')
    : card.column;
```
The real `LEAD CODED` and `CODER CODED` entries in `columnDefinitions` do **not** have `kind: 'coded'`. Only the synthetic `CODED_AUTO` column (created inside `renderColumns`) has that `kind`. The `find()` therefore misses and falls back to `'LEAD CODED'`.

### Bug 2: Frontend `getNextColumn` does not skip parallel coded lanes
Unlike the backend's `_getNextColumnId` which skips parallel coded lanes to return the post-coder column (e.g. `CODE REVIEWED`), the frontend's `getNextColumn` simply returns `columns[idx + 1]`.

Because the `columns` array is never updated when coders are collapsed, it still contains `['LEAD CODED', 'CODER CODED', ...]`. So:
- `getNextColumn('LEAD CODED')` → `'CODER CODED'`
- `getNextColumn('CODER CODED')` → `'CODE REVIEWED'`

After Bug 1 falls back to `'LEAD CODED'`, the label resolves against `CODER CODED` (role = `coder`), producing **"Copy coder prompt"**.

### Additional Issue: Cards originally in `LEAD CODED` rendered in AUTOCODE
When `collapseCodersEnabled` is true, cards with `card.column === 'LEAD CODED'` are visually grouped into AUTOCODE, but `createCardHtml` uses their raw `card.column`. These cards also get `getNextColumn('LEAD CODED')` → `CODER CODED` → **"Copy coder prompt"**, which is equally wrong from the user's perspective.

## Proposed Changes

### `src/webview/kanban.html`

**File:** `src/webview/kanban.html`  
**Location:** lines 3943–3965 inside `createCardHtml`

Replace the existing label block with:

```javascript
let copyLabel = 'Copy Prompt';
const CODED_IDS = ['LEAD CODED', 'CODER CODED', 'INTERN CODED'];
let sourceColumn = card.column;

// When a card is in the AUTOCODE bucket (visually collapsed or stored as CODED_AUTO),
// the next step is always the column after the coded lanes.
if (sourceColumn === 'CODED_AUTO' || (collapseCodersEnabled && CODED_IDS.includes(sourceColumn))) {
    const visibleCodedIds = CODED_IDS.filter(id => columns.includes(id));
    sourceColumn = visibleCodedIds[visibleCodedIds.length - 1] || 'CODER CODED';
}

const nextColId = getNextColumn(sourceColumn);
if (nextColId) {
    const nextDef = columnDefinitions.find(d => d.id === nextColId);
    if (nextDef) {
        const isCustom = nextDef.kind === 'custom-user' || nextDef.kind === 'custom-agent';
        if (isCustom) {
            copyLabel = 'Copy advance prompt';
        } else if (nextDef.role === 'planner' || nextDef.id === 'PLAN REVIEWED') {
            copyLabel = 'Copy planning prompt';
        } else if (['lead', 'coder', 'intern'].includes(nextDef.role)) {
            copyLabel = 'Copy coder prompt';
        } else if (nextDef.role === 'reviewer' || nextDef.id === 'CODE REVIEWED') {
            copyLabel = 'Copy review prompt';
        } else {
            copyLabel = 'Copy advance prompt';
        }
    }
}
```

**Rationale:**
- `CODED_AUTO` cards and real coder-column cards rendered in AUTOCODE are all treated as being at the end of the coded lane.
- `visibleCodedIds` filters against the global `columns` array (initialized at startup from `columnDefinitions` and `lastVisibleAgents`). Coder columns are visible by default, so `visibleCodedIds` typically contains all of them; the last entry is used as the source for `getNextColumn`.
- `getNextColumn(lastVisibleCodedColumn)` then correctly returns the post-coder next column (e.g. `CODE REVIEWED`).

### `src/test/kanban-card-prompt-labels-regression.test.js`

**File:** `src/test/kanban-card-prompt-labels-regression.test.js`

The existing test passes mocked data that does not match the real frontend state:
- It puts `kind: 'coded'` on `LEAD CODED` (real `columnDefinitions` lacks this).
- It conflates `columnDefinitions` with the `columns` array, omitting `CODER CODED` entirely.

Update the test to:
1. Separate `columnDefinitions` from `columns`.
2. Use realistic `columnDefinitions` (no `kind` on real coder columns).
3. Use a realistic `columns` array including `CODER CODED`.
4. Update the `CODED_AUTO` test assertion to assert "Copy review prompt" via the new fixed logic.
5. Add an assertion for `LEAD CODED` when `collapseCodersEnabled` is true → "Copy review prompt".
6. Add an assertion for `LEAD CODED` when `collapseCodersEnabled` is false → "Copy coder prompt" (regression guard).

**Important:** The current test extracts the label logic block via regex (`let copyLabel = 'Copy Prompt';...`) and executes it via `new Function('card', 'columnDefinitions', 'getNextColumn', ...)`. The new fix references `collapseCodersEnabled`, which is defined *outside* the extracted block (line 2850 of `kanban.html`). The test must be updated to either:
- Expand the regex extraction to include the `collapseCodersEnabled` variable declaration, or
- Pass `collapseCodersEnabled` as an additional parameter to the `Function` constructor and set it in the test cases.

The simpler approach is to modify `evaluateLabel` to accept a fourth argument:
```javascript
function evaluateLabel(cardColumn, getNextColumnImpl, columnDefs, collapseCodersEnabled = true) {
    let card = { column: cardColumn };
    let columnDefinitions = columnDefs;
    let getNextColumn = getNextColumnImpl;
    const wrappedLogic = logicStr + '\nreturn copyLabel;';
    const func = new Function('card', 'columnDefinitions', 'getNextColumn', 'collapseCodersEnabled', wrappedLogic);
    return func(card, columnDefinitions, getNextColumn, collapseCodersEnabled);
}
```

Example updated test structure:
```javascript
const stdDefs = [
    { id: 'CREATED', kind: 'standard' },
    { id: 'PLAN REVIEWED', kind: 'standard', role: 'planner' },
    { id: 'CONTEXT GATHERER', kind: 'gather', role: 'gatherer' },
    { id: 'LEAD CODED', role: 'lead' },        // no kind, realistic
    { id: 'CODER CODED', role: 'coder' },      // no kind, realistic
    { id: 'CODE REVIEWED', role: 'reviewer' },
    { id: 'ACCEPTANCE TESTED', role: 'tester' },
    { id: 'COMPLETED', kind: 'completed' }
];

const stdColumns = stdDefs.map(d => d.id);

// Mock getNextColumn using columns array, not defs
function mockGetNextColumn(src, cols) {
    const idx = cols.indexOf(src);
    if (idx >= 0 && idx < cols.length - 1) return cols[idx + 1];
    return null;
}

// Assert CODED_AUTO -> CODE REVIEWED -> "Copy review prompt"
label = evaluateLabel('CODED_AUTO', (src) => mockGetNextColumn(src, stdColumns), stdDefs);
assert.strictEqual(label, 'Copy review prompt', 'CODED_AUTO synthetic card failed');

// Assert LEAD CODED (when collapseCodersEnabled=true) -> CODE REVIEWED -> "Copy review prompt"
// This requires injecting collapseCodersEnabled into the test evaluator
```

## Verification Plan

### Automated Tests
1. Update `src/test/kanban-card-prompt-labels-regression.test.js` with realistic data as described above.
2. Run the test:
   ```bash
   node src/test/kanban-card-prompt-labels-regression.test.js
   ```
3. Run existing kanban regression tests to confirm no regressions:
   ```bash
   node src/test/kanban-coded-auto-batching-regression.test.js
   node src/test/kanban-coded-auto-drag-out-regression.test.js
   node src/test/kanban-complexity-regression.test.js
   node src/test/kanban-smart-router-regression.test.js
   ```

### Manual Tests
1. Open the Switchboard Kanban panel with coder columns collapsed (AUTOCODE visible).
2. Verify that a card in AUTOCODE shows **"Copy review prompt"** on its primary button.
3. Expand coder columns (disable collapse) and verify:
   - Cards in `LEAD CODED` show **"Copy coder prompt"**.
   - Cards in `CODER CODED` show **"Copy review prompt"**.
4. Drag a plan from `NEW` into `AUTOCODE` (or use the copy button) and confirm the prompt targets the reviewer role.

## Files Changed
- `src/webview/kanban.html` (lines ~3943–3965)
- `src/test/kanban-card-prompt-labels-regression.test.js`

## Risk Assessment
- **Low risk.** Both changes are localized to the webview frontend. No backend API or database schema is touched.
- The new logic only activates when `card.column === 'CODED_AUTO'` or when `collapseCodersEnabled && card.column` is a coded lane. Existing behavior for all other columns is unchanged.
- **Test extraction risk:** The regression test must correctly inject `collapseCodersEnabled` into the `Function` evaluator; failure to do so will cause the new branch to be unreachable in tests.
- **Uncollapsed regression risk:** Without an explicit assertion for `LEAD CODED` / `CODER CODED` when `collapseCodersEnabled=false`, a future refactor could accidentally apply the review label to all coded columns.

**Recommendation: Send to Coder.**

## Reviewer Execution Pass

### Stage 1: Grumpy Principal Engineer Review

* **[NIT/MINOR] Memory & CPU Overhead in Render Loop:** Bah! You allocated an array `['LEAD CODED', 'CODER CODED', 'INTERN CODED']` inside a render loop for every single card. You also run `.filter(id => columns.includes(id))` on every iteration! Do you know what performance is? Sure, the array is tiny and `columns` is short, so it won't actually lag the UI, but it's sloppy! Hoist the calculation of the last visible coded column out of the per-card rendering.
* **[NIT] Test Extraction Coupling:** I see why you did it inline though—your test suite's regex specifically extracts the `let copyLabel = 'Copy Prompt';[\s\S]*?(?=primaryActionBtn =)` block. If you properly hoisted the `CODED_IDS` array to the top of `renderBoard`, the test would immediately crash because `CODED_IDS` wouldn't be in the extracted string. A more robust test harness would allow injecting dependencies, but given the constraints, your hack works.

### Stage 2: Balanced Synthesis

* **What to keep:** The routing logic is mathematically sound. It correctly handles the `CODED_AUTO` edge cases, evaluates `collapseCodersEnabled`, and falls back safely if a column is missing. The test assertions are excellent and cover both the collapsed and uncollapsed states perfectly.
* **What to fix now:** Nothing. The performance hit of the inline array allocation is negligible for the scale of Kanban cards (typically <100). The code works, it's safe, and breaking the test harness to fix a sub-microsecond allocation is a bad tradeoff.
* **What can defer:** In the future, the frontend should dynamically resolve coder roles from `columnDefinitions` instead of hardcoding `['LEAD CODED', 'CODER CODED', 'INTERN CODED']`.

### Verification & Fixes

* **Code Fixes Applied:** None required. The existing implementation exactly matched the plan requirements and passed the Grumpy audit.
* **Files Evaluated:** `src/webview/kanban.html`, `src/test/kanban-card-prompt-labels-regression.test.js`
* **Validation Results:** 
  * Ran `node src/test/kanban-card-prompt-labels-regression.test.js` -> `kanban card prompt labels regression test passed`. 
  * The logic successfully normalizes `CODED_AUTO` to `CODE REVIEWED` ("Copy review prompt") and properly leaves `LEAD CODED` alone when uncollapsed ("Copy coder prompt").
* **Remaining Risks:** None. 

**ACCURACY VERIFICATION COMPLETE**
