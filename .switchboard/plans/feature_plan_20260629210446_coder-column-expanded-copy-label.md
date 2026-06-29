# Fix: Coder Columns Expanded Show "Copy Coder Prompt" Instead of "Copy Review Prompt"

## Goal

Fix the card-render label logic so that cards in any coder column (Lead Coder, Coder, Intern) display "Copy review prompt" when coder columns are **expanded**, not "Copy coder prompt". The root cause is an inconsistent `collapseCodersEnabled` guard that only exists in one of three sibling code paths.

### Problem
When the three coder columns (Lead Coder, Coder, Intern) are **expanded** (not collapsed into the AUTOCODE bucket), cards sitting in the **Lead Coder** or **Intern** columns display their primary action button as **"Copy coder prompt"** instead of the expected **"Copy review prompt"**.

The user correctly suspects the cause: the label logic walks to the *adjacent* column in the `columns` array, and when coders are expanded the adjacent column for `LEAD CODED` is `CODER CODED` (another coder column), not `CODE REVIEWED`.

### Background
The three coder columns — `LEAD CODED`, `CODER CODED`, `INTERN CODED` — are **mutually exclusive parallel lanes**. A plan is routed into exactly ONE of them (by complexity routing) and then advances to `CODE REVIEWED`. They are never sequential; a plan does not flow `LEAD CODED → CODER CODED → INTERN CODED`.

### Root Cause
In `src/webview/kanban.html`, the card-rendering label logic (line 5303) resolves the "next column" for label purposes:

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

`getNextColumn` (line 4274) simply returns the next entry in the `columns` array:

```js
function getNextColumn(col) {
    const idx = columns.indexOf(col);
    if (idx < 0 || idx >= columns.length - 1) return null;
    return columns[idx + 1];
}
```

With the standard column order `[..., LEAD CODED, CODER CODED, CODE REVIEWED, ...]`, `getNextColumn('LEAD CODED')` returns `CODER CODED`. The label logic then sees `nextDef.role === 'coder'` and sets `copyLabel = 'Copy coder prompt'`.

**Contrast with the other two code paths**, which do NOT have the `collapseCodersEnabled` guard and therefore work correctly in both modes:
- Column-header prompt buttons (line 4747): `if (CODED_IDS.includes(backendColumn) || column === 'CODED_AUTO')`
- Card click handler (line 5204): `if (CODED_IDS.includes(column) || column === 'CODED_AUTO')`

Only the card-render label path has the extra `collapseCodersEnabled &&` condition, making it inconsistent.

## Metadata
- **Tags:** bugfix, ui
- **Complexity:** 2

## User Review Required
No. This is a straightforward one-line condition fix that makes the card-render path consistent with two existing sibling code paths in the same file. No architectural decisions, no product scope changes, no data migrations.

## Complexity Audit

### Routine
- Remove the `collapseCodersEnabled &&` guard from a single `if` condition (line 5303).
- Update one regression test assertion to expect the corrected label (test file lines 71-73).
- The pattern is already established in two sibling code paths (lines 4747 and 5204) in the same file.
- No backend, no DB, no prompt-generation changes — only the button *label* string is affected.

### Complex / Risky
- None

## Edge-Case & Dependency Audit

| Edge Case | Analysis |
|-----------|----------|
| Coders collapsed (`collapseCodersEnabled=true`) | Already handled — `sourceColumn` resolves to last visible coder column. Fix is a no-op here: `CODED_IDS.includes(sourceColumn)` is true regardless of `collapseCodersEnabled`, so the block still enters. Unchanged behavior. |
| Coders expanded, card in `LEAD CODED` | **Fixed**: `CODED_IDS.includes('LEAD CODED')` is true → resolves to last visible coder column → `getNextColumn` returns `CODE REVIEWED` → label "Copy review prompt". |
| Coders expanded, card in `CODER CODED` | Already correct (adjacent column IS `CODE REVIEWED`). Fix is a no-op here but harmless. |
| Coders expanded, card in `INTERN CODED` | **Fixed**: same as LEAD CODED — resolves past sibling coder columns to `CODE REVIEWED`. (Note: INTERN CODED is not in the default `columnDefinitions` but can be dynamically added; `visibleCodedIds.filter(id => columns.includes(id))` correctly handles its presence or absence.) |
| Only one coder column visible (e.g. INTERN hidden) | `visibleCodedIds` filters to present columns; last visible is used. Works in both modes. |
| `CODED_AUTO` synthetic column | Handled by the `sourceColumn === 'CODED_AUTO'` branch, untouched by fix. |
| Existing regression test | `kanban-card-prompt-labels-regression.test.js` line 71-73 currently **asserts the buggy behavior** (`LEAD CODED` expanded → "Copy coder prompt"). Must be updated to expect "Copy review prompt". |
| Test regex extraction unaffected | The test extracts logic via regex `let copyLabel = 'Copy Prompt';[\s\S]*?(?=primaryActionBtn =)`. The fix changes a condition *inside* the matched block, not the start/end boundaries, so the regex still captures the full logic block correctly. |

**Race Conditions**: None. This is synchronous render-time label computation with no async state.

**Security**: None. No user input, no network, no secrets.

**Side Effects**: The button label string changes from "Copy coder prompt" to "Copy review prompt" for expanded LEAD CODED / INTERN CODED cards. The actual prompt content is determined server-side from the source column and is unaffected — only the visible label text changes.

**Dependencies & Conflicts**: None. Pure frontend label logic. No backend, no DB, no prompt-generation changes.

## Dependencies
None. This plan is self-contained.

## Adversarial Synthesis
Key risks: (1) the regression test currently asserts the buggy behavior and must be updated in lockstep with the fix; (2) INTERN CODED is a dynamically-added column not in the default `columnDefinitions`, but the existing `visibleCodedIds.filter(id => columns.includes(id))` logic correctly handles its presence or absence — this is pre-existing and out of scope. Mitigations: update the test assertion in the same change; the fix makes the card-render path identical to two already-correct sibling paths, eliminating the inconsistency rather than introducing new logic.

## Proposed Changes

### 1. `src/webview/kanban.html` — Remove the `collapseCodersEnabled` guard in card-render label logic

**File**: `src/webview/kanban.html`, line 5303

**Context**: The card-render label logic (lines 5297-5326) computes the `copyLabel` string for the primary action button. It resolves the "source column" to determine which pipeline stage comes next. The `collapseCodersEnabled &&` guard prevents the coder-column resolution from running when coders are expanded, leaving `sourceColumn` as the raw coder column ID (e.g. `LEAD CODED`), which causes `getNextColumn` to return the adjacent coder column instead of `CODE REVIEWED`.

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

**Logic**: Removing `collapseCodersEnabled &&` makes the card-render path consistent with the column-header handler (line 4747) and the card-click handler (line 5204), neither of which gates on `collapseCodersEnabled`. Now, regardless of collapse state, any card in a coder column resolves `sourceColumn` to the last visible coder column, so `getNextColumn` returns the next *pipeline stage* (`CODE REVIEWED`), not the next sibling coder column.

**Edge Cases**: 
- Collapsed mode: `CODED_IDS.includes(sourceColumn)` is true (same as before with the guard), so behavior is unchanged.
- `CODED_AUTO` branch: untouched, still enters via the `===` check.
- Cards in non-coder columns (e.g. `PLAN REVIEWED`): `CODED_IDS.includes()` is false, `sourceColumn` unchanged — no effect.

### 2. `src/test/kanban-card-prompt-labels-regression.test.js` — Update the expanded-coder assertion

**File**: `src/test/kanban-card-prompt-labels-regression.test.js`, lines 71-73

**Context**: The regression test extracts the label logic from `kanban.html` via regex and evaluates it with mock data. Line 71-73 currently asserts the buggy behavior: that `LEAD CODED` with `collapseCodersEnabled=false` produces "Copy coder prompt". After the fix, it should produce "Copy review prompt".

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

**Edge Cases**: The test's `stdColumns` mock is `['CREATED', 'PLAN REVIEWED', 'LEAD CODED', 'CODER CODED', 'CODE REVIEWED']` (no INTERN CODED). With the fix, `visibleCodedIds = ['LEAD CODED', 'CODER CODED']`, `sourceColumn = 'CODER CODED'`, `getNextColumn('CODER CODED')` = `'CODE REVIEWED'`, `nextDef.role = 'reviewer'` → `'Copy review prompt'`. The existing assertion at line 77 (`CODER CODED` expanded → "Copy review prompt") and line 85 (`LEAD CODED` collapsed → "Copy review prompt") remain correct and unchanged.

## Verification Plan

### Automated Tests
1. **Run the regression test:**
   ```
   node src/test/kanban-card-prompt-labels-regression.test.js
   ```
   Expect: `kanban card prompt labels regression test passed`

   This test extracts the live label logic from `kanban.html` via regex, so it validates the actual fix, not a copy. The regex boundaries (`let copyLabel = 'Copy Prompt';` ... `primaryActionBtn =`) are unaffected by the condition change inside the block.

### Manual Verification
2. **Manual verification in VS Code webview:**
   - Open the Kanban board with coder columns **expanded** (toggle the collapse button so Lead Coder, Coder, and Intern are each visible as separate columns).
   - Place a card in the **Lead Coder** column.
   - Confirm the card's primary button reads **"Copy review prompt"** (not "Copy coder prompt").
   - Repeat with a card in the **Intern** column (if visible) — should also read "Copy review prompt".
   - Confirm a card in the **Coder** column still reads "Copy review prompt" (was already correct).
   - Toggle coders to **collapsed** (AUTOCODE bucket) and confirm cards still read "Copy review prompt".
   - Confirm a card in **PLAN REVIEWED** still reads "Copy coder prompt" (next stage IS a coder column).

### Build Check (optional, release only)
3. **Build check (optional, for VSIX release only):**
   ```
   npm run compile
   ```
   Per project rules, `dist/` is not used during dev/testing — this is only needed when producing a release VSIX.

---

**Recommendation:** Complexity is 2 → **Send to Intern**.
