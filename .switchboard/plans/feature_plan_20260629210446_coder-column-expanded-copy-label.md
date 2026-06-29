# Fix: Coder Columns Expanded Show "Copy Coder Prompt" Instead of "Copy Review Prompt"

## Goal

### Problem
When the three coder columns (Lead Coder, Coder, Intern) are **expanded** (not collapsed into the AUTOCODE bucket), cards sitting in the **Lead Coder** or **Intern** columns display their primary action button as **"Copy coder prompt"** instead of the expected **"Copy review prompt"**.

The user correctly suspects the cause: the label logic walks to the *adjacent* column in the `columns` array, and when coders are expanded the adjacent column for `LEAD CODED` is `CODER CODED` (another coder column), not `CODE REVIEWED`.

### Background
The three coder columns — `LEAD CODED`, `CODER CODED`, `INTERN CODED` — are **mutually exclusive parallel lanes**. A plan is routed into exactly ONE of them (by complexity routing) and then advances to `CODE REVIEWED`. They are never sequential; a plan does not flow `LEAD CODED → CODER CODED → INTERN CODED`.

### Root Cause
In `src/webview/kanban.html`, the card-rendering label logic (lines ~5304–5332) resolves the "next column" for label purposes:

```js
const CODED_IDS = ['LEAD CODED', 'CODER CODED', 'INTERN CODED'];
let sourceColumn = card.column;

if (sourceColumn === 'CODED_AUTO' || (collapseCodersEnabled && CODED_IDS.includes(sourceColumn))) {
    const visibleCodedIds = CODED_IDS.filter(id => columns.includes(id));
    sourceColumn = visibleCodedIds[visibleCodedIds.length - 1] || 'CODER CODED';
}

const nextColId = getNextColumn(sourceColumn);
```

The guard `collapseCodersEnabled && CODED_IDS.includes(sourceColumn)` only resolves the coder column to the **last visible coder column** when coders are **collapsed**. When coders are **expanded** (`collapseCodersEnabled === false`), the guard is false, so `sourceColumn` stays as e.g. `LEAD CODED`.

`getNextColumn` (line 4281) simply returns the next entry in the `columns` array:

```js
function getNextColumn(col) {
    const idx = columns.indexOf(col);
    if (idx < 0 || idx >= columns.length - 1) return null;
    return columns[idx + 1];
}
```

With the standard column order `[..., LEAD CODED, CODER CODED, CODE REVIEWED, ...]`, `getNextColumn('LEAD CODED')` returns `CODER CODED`. The label logic then sees `nextDef.role === 'coder'` and sets `copyLabel = 'Copy coder prompt'`.

**Contrast with the other two code paths**, which do NOT have the `collapseCodersEnabled` guard and therefore work correctly in both modes:
- Column-header prompt buttons (line ~4754): `if (CODED_IDS.includes(backendColumn) || column === 'CODED_AUTO')`
- Card click handler (line ~5211): `if (CODED_IDS.includes(column) || column === 'CODED_AUTO')`

Only the card-render label path has the extra `collapseCodersEnabled &&` condition, making it inconsistent.

## Metadata
- **Tags**: bug, kanban, ui, copy-prompt, coder-columns
- **Complexity**: 2

## Complexity Audit
**Routine.** This is a one-line condition fix plus a regression-test update. The pattern is already established in two sibling code paths in the same file. No architectural changes, no data migrations, no backend involvement.

## Edge-Case & Dependency Audit

| Edge Case | Analysis |
|-----------|----------|
| Coders collapsed (`collapseCodersEnabled=true`) | Already handled — `sourceColumn` resolves to last visible coder column. Unchanged by fix. |
| Coders expanded, card in `LEAD CODED` | **Fixed**: resolves to last visible coder column → `getNextColumn` returns `CODE REVIEWED` → label "Copy review prompt". |
| Coders expanded, card in `CODER CODED` | Already correct (adjacent column IS `CODE REVIEWED`). Fix is a no-op here but harmless. |
| Coders expanded, card in `INTERN CODED` | **Fixed**: same as LEAD CODED — resolves past sibling coder columns to `CODE REVIEWED`. |
| Only one coder column visible (e.g. INTERN hidden) | `visibleCodedIds` filters to present columns; last visible is used. Works in both modes. |
| `CODED_AUTO` synthetic column | Handled by the `sourceColumn === 'CODED_AUTO'` branch, untouched. |
| Existing regression test | `kanban-card-prompt-labels-regression.test.js` line 71-73 currently **asserts the buggy behavior** (`LEAD CODED` expanded → "Copy coder prompt"). Must be updated to expect "Copy review prompt". |

**Dependencies**: None. Pure frontend label logic. No backend, no DB, no prompt-generation changes (the actual prompt content is determined server-side from the source column; only the button *label* is affected here).

## Proposed Changes

### 1. `src/webview/kanban.html` — Remove the `collapseCodersEnabled` guard in card-render label logic

**File**: `src/webview/kanban.html`, line ~5310

**Before:**
```js
if (sourceColumn === 'CODED_AUTO' || (collapseCodersEnabled && CODED_IDS.includes(sourceColumn))) {
    const visibleCodedIds = CODED_IDS.filter(id => columns.includes(id));
    sourceColumn = visibleCodedIds[visibleCodedIds.length - 1] || 'CODER CODED';
}
```

**After:**
```js
if (sourceColumn === 'CODED_AUTO' || CODED_IDS.includes(sourceColumn)) {
    const visibleCodedIds = CODED_IDS.filter(id => columns.includes(id));
    sourceColumn = visibleCodedIds[visibleCodedIds.length - 1] || 'CODER CODED';
}
```

This makes the card-render path consistent with the column-header handler (line 4754) and the card-click handler (line 5211), neither of which gates on `collapseCodersEnabled`.

### 2. `src/test/kanban-card-prompt-labels-regression.test.js` — Update the expanded-coder assertion

**File**: `src/test/kanban-card-prompt-labels-regression.test.js`, lines 71-73

**Before:**
```js
// TEST: LEAD CODED -> CODER CODED -> "Copy coder prompt" (when collapseCodersEnabled=false)
label = evaluateLabel('LEAD CODED', (src) => sourceToNext(src, stdColumns), stdDefs, stdColumns, false);
assert.strictEqual(label, 'Copy coder prompt', 'LEAD CODED -> CODER CODED failed (collapsed=false)');
```

**After:**
```js
// TEST: LEAD CODED (expanded) -> resolves past CODER CODED to CODE REVIEWED -> "Copy review prompt"
label = evaluateLabel('LEAD CODED', (src) => sourceToNext(src, stdColumns), stdDefs, stdColumns, false);
assert.strictEqual(label, 'Copy review prompt', 'LEAD CODED expanded should show Copy review prompt');
```

## Verification Plan

1. **Run the regression test:**
   ```
   node src/test/kanban-card-prompt-labels-regression.test.js
   ```
   Expect: `kanban card prompt labels regression test passed`

2. **Manual verification in VS Code webview:**
   - Open the Kanban board with coder columns **expanded** (toggle the collapse button so Lead Coder, Coder, and Intern are each visible as separate columns).
   - Place a card in the **Lead Coder** column.
   - Confirm the card's primary button reads **"Copy review prompt"** (not "Copy coder prompt").
   - Repeat with a card in the **Intern** column (if visible) — should also read "Copy review prompt".
   - Confirm a card in the **Coder** column still reads "Copy review prompt" (was already correct).
   - Toggle coders to **collapsed** (AUTOCODE bucket) and confirm cards still read "Copy review prompt".
   - Confirm a card in **PLAN REVIEWED** still reads "Copy coder prompt" (next stage IS a coder column).

3. **Build check (optional, for VSIX release only):**
   ```
   npm run compile
   ```
   Per project rules, `dist/` is not used during dev/testing — this is only needed when producing a release VSIX.
