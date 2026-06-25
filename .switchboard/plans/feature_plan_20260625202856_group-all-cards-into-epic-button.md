# Replace Code Map Icon in New Column with "Group All Cards Into Epic"

## Goal

### Problem
The CREATED (New) column on the kanban board currently has a "code map" icon button in its header that runs the analyst's code map function on selected (or all) plans. The user wants this button replaced with a new function: **"group all cards in the new column into an epic"**, reusing the existing icon. The functionality should be exactly as if the user had manually selected all cards in the column and pressed the EPIC button.

### Root Cause
This is not a bug — it is a feature replacement. The code map button (`codeMapBtn`, kanban.html line 4535) is rendered in the CREATED column header when the analyst agent is visible. Its click handler (`case 'codeMapSelected'`, line 4771) sends a `codeMapSelected` message to the backend. The user wants this button repurposed to group all cards into an epic instead.

The existing "promote to epic" flow for multiple cards works as follows:
1. User selects multiple non-epic cards
2. User clicks the EPIC button in the controls strip (line 9275)
3. The handler detects `epics.length === 0 && nonEpics.length > 1` and calls `openEpicCreateModal()` (line 9313)
4. The modal reads from `selectedCards`, shows a name input (pre-filled from the first card's topic), and a plan list
5. On submit, it sends a `createEpic` message with the subtask plan IDs

The new button should automate step 1 (select all cards in the column) and then trigger the same modal flow.

### Desired Behavior
- The code map icon in the CREATED column header is replaced with an "epic group" function (same icon, new tooltip)
- Clicking it selects all non-epic cards in the CREATED column and opens the epic create modal
- The user names the epic and clicks "Create Epic" — exactly the same flow as manual selection + EPIC button
- Cards that are already epics are excluded (you can't nest an epic inside another epic)
- If the column has 0 non-epic cards, the button does nothing (or is not rendered)

## Metadata

- **Tags:** `ui`, `feature`
- **Complexity:** 3/10
- **Files touched:** 1 (`src/webview/kanban.html`)
- **Risk:** Low — frontend-only change, reuses existing epic creation modal and backend handler

## User Review Required

No user review required. This is a straightforward frontend-only feature replacement with no backend changes, no data migrations, and no security implications. The change reuses the existing `openEpicCreateModal()` flow and `createEpic` backend handler without modification.

## Complexity Audit

### Routine
- Updating the button rendering: change `data-action`, tooltip text, and visibility condition (remove analyst-gate, keep `isCreated` gate)
- Adding a new click handler case that selects all non-epic cards and opens the existing epic create modal
- No backend changes — the existing `createEpic` message handler in `KanbanProvider.ts` already supports creating an epic from multiple subtask IDs
- Reuses existing `getAllInColumn()`, `selectedCards`, `currentCards`, and `openEpicCreateModal()` functions

### Complex / Risky
- **`nextCol` guard bypass (line 4667):** The column-icon-btn click handler has an early-return guard: `if (!nextCol && action !== 'julesSelected' && ...)` — the new `groupAllIntoEpic` action is NOT in this exception list. For the CREATED column `getNextColumn()` normally returns a valid next column, so the guard passes today. However, this is semantically wrong (the epic-group action has nothing to do with moving cards forward) and fragile (if CREATED is ever the last column, the button silently fails). **Fix:** add `&& action !== 'groupAllIntoEpic'` to the guard condition at line 4667.

## Edge-Case & Dependency Audit

| Edge Case | Analysis |
|-----------|----------|
| Column has 0 cards | Button click does nothing. Consider not rendering the button if the column is empty, but the current code map button renders regardless — matching that behavior is simpler. |
| Column has only epic cards | All cards are epics → no non-epic cards to group → do nothing (show a brief status or silently return). |
| Column has a mix of epics and non-epics | Only non-epic cards are selected and grouped. Existing epics are left alone. |
| Column has 1 non-epic card | The EPIC button handler for a single non-epic card does `promoteToEpic` (in-place promotion, no modal). But the new button should always open the modal for consistency — even with 1 card, grouping into an epic makes sense. We should force the modal path by ensuring `nonEpics.length >= 1` and calling `openEpicCreateModal()` directly. |
| `selectedCards` has pre-existing selections | The new button should clear any existing selection first, then select all non-epic cards in the column. This prevents mixing selections from other columns. |
| Analyst agent visibility | The current code map button only renders when `lastVisibleAgents.analyst !== false`. The new epic-group button has nothing to do with the analyst agent — it should render unconditionally in the CREATED column (or at minimum, not be gated on analyst visibility). |
| Existing code map functionality | The `codeMapSelected` message handler and backend logic remain intact — only the button is removed from the CREATED column header. If code map is triggered from elsewhere, it still works. |
| Epic create modal name pre-fill | The modal pre-fills the name from the first selected card's topic (line 7177–7183). This will work correctly since we populate `selectedCards` before opening the modal. |
| `nextCol` guard (line 4667) | The click handler early-returns if `!nextCol` and the action is not in the exception list. `groupAllIntoEpic` must be added to this exception list, otherwise the button silently fails if CREATED has no next column. See Complexity Audit → Complex / Risky. |
| Backlog mode (`showingBacklog`) | The CREATED column can display as "BACKLOG" (line 4566). The button is gated on `isCreated`, so it renders in both normal and backlog mode. Grouping backlog cards into an epic is a valid use case — no special handling needed. |
| Modal cancel leaves cards selected | If the user opens the modal via the new button and then cancels, `closeEpicCreateModal()` only hides the modal — it does NOT clear `selectedCards`. The cards remain visually selected. This matches the existing manual flow (select → EPIC → cancel → cards stay selected), so it is consistent and expected. |
| `codeMapSelected` / `codeMapConfirm` backend handlers | The backend `KanbanProvider.ts` (lines 6610, 6621) still handles `codeMapConfirm` and `codeMapSelected` messages. These become unreachable from the kanban board UI but remain harmless dead code. The test file `src/test/context-map-batching-regression.test.js` checks for the `codeMapSelected` case in KanbanProvider — it will still pass since we are NOT removing the backend handler. |

## Dependencies

None — this plan is self-contained and has no dependency on other plans or sessions.

## Adversarial Synthesis

Key risks: (1) the `nextCol` guard at line 4667 will silently swallow the click if `groupAllIntoEpic` is not added to the exception list — this is the most critical gap in the original plan; (2) storing full card objects in `selectedCards` instead of the partial objects used by the normal click handler is safe but inconsistent with codebase conventions. Mitigations: add `groupAllIntoEpic` to the guard exception list; the full-card storage is functionally safe since all downstream consumers only read `.isEpic` or use `.keys()`.

## Proposed Changes

### File: `src/webview/kanban.html`

#### Change 1: Replace the code map button rendering (lines 4535–4539)

Replace the `codeMapBtn` definition:

```javascript
// BEFORE:
const codeMapBtn = (isCreated && lastVisibleAgents.analyst !== false)
    ? `<button class="column-icon-btn" data-action="codeMapSelected" data-column="${escapeAttr(def.id)}" data-tooltip="Run code map on selected plans (or all if none selected)">
           <img src="${ICON_CODE_MAP}" alt="Code Map">
       </button>`
    : '';

// AFTER:
const epicGroupBtn = isCreated
    ? `<button class="column-icon-btn" data-action="groupAllIntoEpic" data-column="${escapeAttr(def.id)}" data-tooltip="Group all plans in this column into an epic">
           <img src="${ICON_CODE_MAP}" alt="Group Into Epic">
       </button>`
    : '';
```

#### Change 2: Update the button area template (line 4561)

Replace `${codeMapBtn}` with `${epicGroupBtn}`:

```javascript
// BEFORE:
${codeMapBtn}

// AFTER:
${epicGroupBtn}
```

#### Change 3: Add `groupAllIntoEpic` to the `nextCol` guard exception list (line 4667)

**Clarification (implied by existing requirements):** The epic-group action does not move cards to a next column, so it must be exempt from the early-return guard just like `julesSelected`, `rePlanSelected`, etc.

```javascript
// BEFORE:
if (!nextCol && action !== 'julesSelected' && action !== 'rePlanSelected' && action !== 'completeSelected' && action !== 'completeAll' && action !== 'testingFailed' && action !== 'splitterSelected') return;

// AFTER:
if (!nextCol && action !== 'julesSelected' && action !== 'rePlanSelected' && action !== 'completeSelected' && action !== 'completeAll' && action !== 'testingFailed' && action !== 'splitterSelected' && action !== 'groupAllIntoEpic') return;
```

#### Change 4: Add new click handler case (replace the `codeMapSelected` case at lines 4771–4785)

Replace the `case 'codeMapSelected'` block with a new `case 'groupAllIntoEpic'`:

```javascript
// BEFORE:
case 'codeMapSelected': {
    let ids = getSelectedInColumn(column);
    const usedAll = ids.length === 0;
    if (usedAll) {
        ids = getAllInColumn(column);
    }
    if (ids.length === 0) return;
    if (usedAll && ids.length > 5) {
        postKanbanMessage({ type: 'codeMapConfirm', sessionIds: ids, count: ids.length, workspaceRoot: getActiveWorkspaceRoot() });
    } else {
        postKanbanMessage({ type: 'codeMapSelected', sessionIds: ids, workspaceRoot: getActiveWorkspaceRoot() });
    }
    ids.forEach(id => selectedCards.delete(id));
    break;
}

// AFTER:
case 'groupAllIntoEpic': {
    // Select all non-epic cards in the column, then open the epic create modal.
    // This replicates the user manually selecting all cards and pressing the EPIC button.
    const allIds = getAllInColumn(column);
    if (allIds.length === 0) return;
    // Clear any existing selection to avoid mixing cards from other columns
    selectedCards.clear();
    document.querySelectorAll('.kanban-card.selected').forEach(el => el.classList.remove('selected'));
    // Populate selectedCards with non-epic card objects
    const nonEpicCards = [];
    for (const id of allIds) {
        const card = currentCards.find(c => (c.planId || c.sessionId) === id);
        if (card && !card.isEpic) {
            selectedCards.set(id, card);
            nonEpicCards.push(card);
            // Visually select the card in the DOM
            const cardEl = document.querySelector(`.kanban-card[data-plan-id="${CSS.escape(id)}"]`) || document.querySelector(`.kanban-card[data-session="${CSS.escape(id)}"]`);
            if (cardEl) cardEl.classList.add('selected');
        }
    }
    if (nonEpicCards.length === 0) return;
    // Open the epic create modal (same flow as EPIC button with multiple non-epic cards selected)
    openEpicCreateModal();
    break;
}
```

> **Note on card selector:** The plan originally used a combined comma selector `.kanban-card[data-plan-id="..."], .kanban-card[data-session="..."]`. The codebase consistently uses the `||` pattern with two separate `querySelector` calls (lines 4222, 5499). The code above has been updated to match this convention.

#### Change 5: Remove the `ICON_CODE_MAP` constant if no longer used (optional)

Check if `ICON_CODE_MAP` (line 3788) is referenced anywhere else after this change. If the code map button was the only consumer, the constant can be left in place (harmless) or removed. **Recommendation: leave it in place** — removing it risks breaking the icon injection template (`{{ICON_CODE_MAP}}`) and the constant is harmless if unused.

## Verification Plan

### Automated Tests

Automated tests and compilation are skipped per session directives. The test suite will be run separately by the user.

> **Note:** The existing test `src/test/context-map-batching-regression.test.js` checks for the `codeMapSelected` case in `KanbanProvider.ts`. Since we are NOT removing the backend handler, this test will continue to pass.

### Manual Verification

1. **Manual test — basic flow**:
   - Add 3+ plans to the CREATED column.
   - Click the new epic-group icon button in the CREATED column header.
   - Verify all non-epic cards become visually selected (highlighted).
   - Verify the epic create modal opens with all cards listed.
   - Verify the name field is pre-filled from the first card's topic + " Epic".
   - Enter a name and click "Create Epic".
   - Verify the epic is created and all cards become subtasks (cards disappear from CREATED, epic appears).
2. **Manual test — mixed epic/non-epic cards**:
   - Have 1 epic card and 3 regular cards in the CREATED column.
   - Click the epic-group button.
   - Verify only the 3 regular cards are selected (epic card is not selected).
   - Verify the modal lists only the 3 regular cards.
3. **Manual test — empty column**:
   - Clear the CREATED column (no cards).
   - Click the epic-group button.
   - Verify nothing happens (no modal, no error).
4. **Manual test — only epic cards**:
   - Have only epic card(s) in the CREATED column.
   - Click the epic-group button.
   - Verify nothing happens (no modal, no error).
5. **Manual test — single card**:
   - Have 1 non-epic card in the CREATED column.
   - Click the epic-group button.
   - Verify the modal opens (not the in-place promoteToEpic flow) — the user can name the epic.
6. **Manual test — pre-existing selection**:
   - Select a card in a different column.
   - Click the epic-group button in the CREATED column.
   - Verify the previous selection is cleared and only CREATED column cards are selected.
7. **Manual test — old code map handler removed**:
   - Verify the `codeMapSelected` case no longer appears in the click handler (it has been replaced).
   - Verify no console errors when clicking the new button.
8. **Manual test — backlog mode**:
   - Toggle the CREATED column to backlog mode (if applicable).
   - Click the epic-group button.
   - Verify it still works correctly (selects non-epic backlog cards, opens modal).
9. **Manual test — modal cancel**:
   - Click the epic-group button, then cancel the modal.
   - Verify the cards remain visually selected (consistent with manual EPIC button + cancel behavior).

---

**Recommendation:** Complexity is 3/10 → **Send to Coder** (boundary case; 1-3 is "Send to Intern" but the `nextCol` guard fix adds a small coordination concern across two locations in the same file — Coder is the safer routing).

---

## Review Pass — Completed

### Reviewer
In-place reviewer-executor pass (Grumpy Principal Engineer → Balanced synthesis).

### Files Changed (Implementation)
- `src/webview/kanban.html` — all 5 plan changes applied:
  1. **Button rendering** (lines 4662–4666): `codeMapBtn` replaced with `epicGroupBtn`, gated on `isCreated` only (analyst-visibility gate removed). Uses `ICON_CODE_MAP` with alt text "Group Into Epic".
  2. **Template injection** (line 4688): `${epicGroupBtn}` replaces `${codeMapBtn}` in the `else`-branch button area.
  3. **`nextCol` guard** (line 4794): `&& action !== 'groupAllIntoEpic'` added to the early-return exception list.
  4. **Click handler** (lines 4898–4916): `case 'codeMapSelected'` replaced with `case 'groupAllIntoEpic'`. Clears prior selection, selects all non-epic cards in the column, opens `openEpicCreateModal()`.
  5. **`ICON_CODE_MAP` constant** (line 3925): Left in place per plan recommendation (still referenced at line 4664).

### Findings by Severity

| Severity | Finding | Location | Status |
|----------|---------|----------|--------|
| NIT-1 | `ICON_CODE_MAP` constant name now semantically misleading (epic-group icon, not code-map). Harmless. Plan says leave it. | `kanban.html:3925` | Deferred — renaming risks `{{ICON_CODE_MAP}}` template injection breakage |
| NIT-2 | For 1-card case, modal shows description field but `promoteToEpic` backend silently ignores it. Plan-accepted trade-off (forcing multi-card modal path for consistency). | `kanban.html:9533` (submit handler) | Deferred — would require backend change or reverting plan's modal-path choice |
| NIT-3 | Alt text "Group Into Epic" vs tooltip "Group all plans in this column into an epic" — minor wording inconsistency. | `kanban.html:4663–4664` | Deferred — cosmetic only |

**CRITICAL: 0 | MAJOR: 0 | NIT: 3 (all deferred)**

### Fixes Applied
None required. No CRITICAL or MAJOR findings. Implementation matches all 5 plan changes exactly.

### Verification Results
- **Compilation:** Skipped per session directives.
- **Tests:** Skipped per session directives.
- **Static verification performed:**
  - All 5 plan changes confirmed present in `src/webview/kanban.html`.
  - No orphaned references to `codeMapBtn`, `codeMapSelected`, or `codeMapConfirm` in `kanban.html`.
  - Backend handlers `codeMapSelected`/`codeMapConfirm` preserved in `KanbanProvider.ts` (lines 6884–6895) — test `context-map-batching-regression.test.js` will pass.
  - Backend handlers `createEpic` (line 7780) and `promoteToEpic` (line 7714) exist for modal submit flow.
  - `openEpicCreateModal()` (line 7363) reads from `selectedCards.keys()` — confirms handler's `selectedCards.set()` calls feed the modal.
  - `getAllInColumn()` (line 4436) returns IDs from `currentCards` — confirms handler's `currentCards.find()` lookup succeeds.
  - Modal submit handler (lines 9531–9537) routes 1-card → `promoteToEpic`, multi-card → `createEpic` — both backend cases exist.

### Remaining Risks
1. **NIT-2 (1-card description ignored):** If a user groups a single card into an epic, enters a description, and clicks "Create Epic", the description is silently dropped. This is a minor UX wart but not a functional bug — the card is still promoted to an epic with the user's chosen name. Fixing would require either (a) passing `{ singlePlanPromote: true }` for the 1-card case (which the plan explicitly rejected to force modal consistency), or (b) modifying the `promoteToEpic` backend handler to accept a description (out of scope — backend change).
2. **NIT-1 (icon semantic mismatch):** The code-map icon now launches an epic-grouping action. Users familiar with the old code-map button may be briefly confused. The tooltip clarifies the new function. No functional impact.
3. **Dead backend code:** `codeMapSelected`/`codeMapConfirm` handlers in `KanbanProvider.ts` are now unreachable from the kanban UI. They are intentionally preserved for test compatibility. If code map is never re-exposed in the UI, this dead code could be cleaned up in a future refactor (along with updating/removing the test).
