# Fix "Make All Tasks in Column Epic" Sweeping In Backlog Subtasks

## Goal

The "Make all tasks in column epic" action must group **only the loose, visible cards in the targeted column** into a new epic. It is currently also pulling in subtasks that belong to a **Backlog** epic — a critical UAT failure. Scope the collection to exactly the cards the board shows in that column.

### Problem Analysis & Root Cause

The "make all tasks in column epic" feature is the **`groupAllIntoEpic`** action. When clicked, it collects card IDs via the frontend helper `getAllInColumn(column)`. That helper filters on `c.column === col` **but does NOT exclude subtask cards (`!c.epicId`)**:

```js
// kanban.html:4320-4326 (current — the bug)
function getAllInColumn(col) {
    if (col === 'CODED_AUTO') {
        const CODED_IDS = ['LEAD CODED', 'CODER CODED', 'INTERN CODED'];
        return currentCards.filter(c => CODED_IDS.includes(c.column)).map(c => c.planId || c.sessionId || '').filter(Boolean);
    }
    return currentCards.filter(c => c.column === col).map(c => c.planId || c.sessionId || '').filter(Boolean);
}
```

A subtask of a **Backlog** epic carries its **own** `kanban_column`, independent of its parent epic. If that subtask's column is, say, `'CREATED'`, the board *hides* it (the board rolls subtasks up under their epic via `displayCards.filter(card => !card.epicId)` at `kanban.html:5035`), but `getAllInColumn('CREATED')` still returns it because it only checks `c.column`. The `groupAllIntoEpic` handler loop (`kanban.html:4797-4818`) only filters `!card.isEpic` (line `4805`) — never `!card.epicId` — so the hidden subtask of a Backlog epic gets swept into the new epic. That is the "pulls in backlog tasks" symptom.

This is the **same divergence** a prior fix (commit `3fff80a`, "Epic Subtasks Leak Into Column-Batch Ops") corrected on the **backend** by introducing `_visibleColumnCards` (`KanbanProvider.ts:364-368`, which filters `card.column === column && !card.epicId`). That fix never touched this **frontend** `getAllInColumn` path — which is why the issue "went through code review" yet still fails. The frontend collector must mirror the backend's visible-column contract.

**Why the bug survived code review:** The existing regression test (`src/test/kanban-subtask-column-leak-regression.test.js`) only reads `KanbanProvider.ts` and asserts the backend uses `_visibleColumnCards`. It never tests the frontend `getAllInColumn` collector. The backend was "fixed" but the frontend collector — the actual source of IDs for `groupAllIntoEpic` — was never covered. A frontend static-source regression test is needed to prevent re-regression.

> Verified via simulation: a Backlog epic with a subtask carrying `column='CREATED'` — the board shows only the loose CREATED card, but `getAllInColumn('CREATED')` returns the loose card **plus** the backlog-epic's subtask.

## Metadata

- **Tags:** `bugfix`, `frontend`, `ui`
- **Complexity:** 4/10
- **Primary files:** `src/webview/kanban.html`, `src/test/kanban-subtask-column-leak-regression.test.js`

## User Review Required

No user review required for the core fix — the one-line collector change is a strict correctness improvement that mirrors the existing backend `_visibleColumnCards` contract. The optional defense-in-depth hardening (handler-level `!card.epicId` filter at line 4805) is recommended but can be deferred if a minimal diff is preferred.

## Complexity Audit

### Routine
- One-line filter addition (`!c.epicId`) to both return paths of `getAllInColumn` — mirrors the existing backend `_visibleColumnCards` pattern (`KanbanProvider.ts:364-368`).
- No DB or schema impact — frontend filter change only, no migration needed.
- The `CODED_AUTO` aggregate branch gets the identical one-line fix.
- Adding a static-source regression test follows the exact pattern of the existing backend test.

### Complex / Risky
- `getAllInColumn` is a **shared collector** used by **five** consumers (`groupAllIntoEpic`, `moveAll`, `promptAll`, `completeAll`, `recoverAll`). The one-line fix corrects all five at once, but every consumer must be verified to ensure the change is a strict improvement across all paths.
- This exact bug class (subtask leak into column-batch ops) has **regressed before** — the backend was fixed in commit `3fff80a` but the frontend was never touched. A frontend regression test is mandatory to break the regression cycle.
- `recoverAll` sends `sessionIds` directly to the backend (which trusts them), so a subtask leak there causes data-integrity issues (subtasks resurrected as loose cards), not just a UI inconsistency.

## Edge-Case & Dependency Audit

- **All five consumers of `getAllInColumn` (verified via grep):**
  1. **`groupAllIntoEpic`** (`kanban.html:4798`) — the primary bug. Sends IDs to the epic-create modal. The handler's own filter at line 4805 checks `!card.isEpic` but NOT `!card.epicId`, so subtasks pass through. **Fixed by the collector change.**
  2. **`moveAll`** (`kanban.html:4713`) — for non-`CODED_AUTO` columns, sends `{ type: 'moveAll', column }` and the backend re-derives via `_visibleColumnCards` (already safe). For `CODED_AUTO`, sends `{ type: 'moveSelected', sessionIds: ids }` and the backend **trusts the IDs** — subtask IDs would be moved. **Fixed by the collector change.**
  3. **`promptAll`** (`kanban.html:4750`) — same pattern as `moveAll`. For `CODED_AUTO`, sends `{ type: 'promptSelected', sessionIds: ids }` and the backend trusts the IDs — subtask IDs would get prompts generated. **Fixed by the collector change.**
  4. **`completeAll`** (`kanban.html:4835`) — calls `getAllInColumn` as a guard only; sends `{ type: 'completeAll', workspaceRoot }` (no IDs). Backend uses `_visibleColumnCards(workspaceRoot, 'CODE REVIEWED')` (`KanbanProvider.ts:6625`, already safe). Adding `!c.epicId` makes the frontend guard consistent with the backend's actual filtering. **Strict correctness improvement.**
  5. **`recoverAll`** (`kanban.html:5500`) — sends `{ type: 'recoverAll', sessionIds: allCompleted }` **directly** to the backend, which iterates and calls `restorePlanFromKanban` on each (`KanbanProvider.ts:5833-5835`). A subtask in `COMPLETED` would be resurrected as a loose card, detached from its parent epic. **Fixed by the collector change.**

- **`CODED_AUTO` aggregate path:** the special-case branch (combining `LEAD CODED`/`CODER CODED`/`INTERN CODED`) has the same defect and must get the same `!c.epicId` exclusion. A subtask can carry `column: 'CODER CODED'` (one of the `CODED_IDS`) and `epicId` set — it's hidden from the board but would be returned by the collector.

- **Backlog-view scoping (secondary, document only):** the `groupAllIntoEpic` button keeps `data-column="CREATED"` even in **backlog view**, where the CREATED column is relabeled "BACKLOG" and shows backlog cards (`kanban.html:4561-4565`, label swap `4592/4502`). In backlog view, `getAllInColumn('CREATED')` returns hidden real-CREATED cards rather than the visible backlog cards — a separate scoping confusion. The clear-cut defect is the missing `!c.epicId` exclusion (fixed here); if UAT also flags backlog-view behavior, suppress the button in backlog view or have it operate on `_effectiveColumn`. Not in scope for this fix unless reproduced.

- **No migration:** frontend filter change only; no DB or schema impact.

## Dependencies

None — this is a standalone bugfix with no prerequisite plans.

## Adversarial Synthesis

Key risks: (1) the edge-case audit originally documented only 2 of 5 consumers — `promptAll` and `recoverAll` were missed, with `recoverAll` being a data-integrity risk (subtasks resurrected as loose cards); (2) no frontend regression test exists, which is exactly why this bug survived the prior code review. Mitigations: the collector-level fix corrects all five consumers in one shot; a new frontend static-source test mirroring the backend regression pattern is added to break the regression cycle.

## Proposed Changes

### `src/webview/kanban.html`

**Primary fix — add subtask exclusion (`!c.epicId`) to both return paths of `getAllInColumn` (lines 4320-4326), mirroring `_visibleColumnCards` and the board's `!card.epicId` display filter:**

```js
function getAllInColumn(col) {
    if (col === 'CODED_AUTO') {
        const CODED_IDS = ['LEAD CODED', 'CODER CODED', 'INTERN CODED'];
        return currentCards.filter(c => CODED_IDS.includes(c.column) && !c.epicId).map(c => c.planId || c.sessionId || '').filter(Boolean);
    }
    return currentCards.filter(c => c.column === col && !c.epicId).map(c => c.planId || c.sessionId || '').filter(Boolean);
}
```

- **Context:** `getAllInColumn` is the frontend collector used by five batch-action consumers. It currently matches on column only, ignoring `epicId`, so hidden subtasks (rolled up under their epic via `displayCards.filter(card => !card.epicId)` at line 5035) leak into batch operations.
- **Logic:** Adding `&& !c.epicId` to both filter predicates ensures the collector returns only loose, visible cards — exactly what the board renders. This mirrors the backend `_visibleColumnCards` contract (`KanbanProvider.ts:364-368`).
- **Implementation:** Two filter predicates, one per return path. No other lines change.
- **Edge Cases:** The `CODED_AUTO` branch must also get the exclusion — a subtask can carry `column: 'CODER CODED'` and `epicId` set. All five consumers (`groupAllIntoEpic`, `moveAll`, `promptAll`, `completeAll`, `recoverAll`) are corrected by this single change.

**Optional hardening — add `!card.epicId` to the `groupAllIntoEpic` handler's own filter at line 4805 (defense in depth):**

```js
// Current (line 4805):
if (card && !card.isEpic) {

// Hardened:
if (card && !card.isEpic && !card.epicId) {
```

- **Context:** After the collector fix, subtasks never reach this line. But if a future code path feeds IDs to this handler without going through `getAllInColumn`, the handler's own filter is the last line of defense.
- **Clarification (not a new requirement):** This is optional insurance against future regressions. The collector fix is sufficient. Recommended given this bug class has regressed before, but can be deferred for a minimal diff.

### `src/test/kanban-subtask-column-leak-regression.test.js`

**Add a frontend static-source regression test mirroring the existing backend test pattern:**

Append a new test block that reads `src/webview/kanban.html`, extracts the `getAllInColumn` function, and asserts both return paths filter `!c.epicId`:

```js
// 7. Frontend collector: getAllInColumn must exclude subtask cards (!c.epicId)
//    on BOTH return paths, mirroring the backend _visibleColumnCards contract.
//    The backend was fixed in commit 3fff80a but the frontend collector was
//    never touched — this test prevents that exact regression.
const htmlPath = path.join(process.cwd(), 'src', 'webview', 'kanban.html');
const html = fs.readFileSync(htmlPath, 'utf8');

const collectorMatch = html.match(/function getAllInColumn\(col\)\s*\{[\s\S]*?\n\s{4}\}/);
assert.ok(collectorMatch, 'getAllInColumn function must exist in kanban.html');

// Both the CODED_AUTO branch and the default branch must exclude subtasks.
const collectorBody = collectorMatch[0];
const codedAutoFilter = collectorBody.match(/CODED_IDS\.includes\(c\.column\)([^)]*)\)/);
assert.ok(
    codedAutoFilter && /!c\.epicId/.test(codedAutoFilter[0]),
    'getAllInColumn CODED_AUTO branch must exclude subtask cards via !c.epicId'
);
const defaultFilter = collectorBody.match(/c\.column === col([^)]*)\)/);
assert.ok(
    defaultFilter && /!c\.epicId/.test(defaultFilter[0]),
    'getAllInColumn default branch must exclude subtask cards via !c.epicId'
);
```

- **Context:** The existing test only covers `KanbanProvider.ts`. The frontend `getAllInColumn` collector — the actual source of IDs for `groupAllIntoEpic` and four other batch actions — has no test coverage. This is why the bug survived code review.
- **Logic:** Static-source test (same approach as the existing backend assertions). Reads the HTML, extracts the function via regex, asserts both filter predicates include `!c.epicId`.
- **Edge Cases:** The regex must match both the `CODED_AUTO` branch filter and the default branch filter independently, confirming neither path was missed.

## Verification Plan

### Automated Tests

Per session directives, automated tests are not run in this session — the user will run the test suite separately. The following test should be written and run by the user:

1. **New frontend regression test** (added to `src/test/kanban-subtask-column-leak-regression.test.js`): run `node src/test/kanban-subtask-column-leak-regression.test.js` and confirm it passes, including the new frontend `getAllInColumn` assertions.
2. **Existing backend regression test**: confirm the existing backend assertions still pass (no backend changes in this fix, but verify no regressions).

### Manual UAT

1. **Primary repro:** create a Backlog epic with at least one subtask whose own column is `CREATED` (so the subtask is hidden under the epic but lives in CREATED). Add one or more *loose* cards directly in CREATED. Click "Make all tasks in column epic" on the CREATED column.
2. Confirm the new epic contains **only** the loose CREATED cards — the Backlog epic's subtask is **not** pulled in, and the Backlog epic remains intact.
3. Repeat for the `CODED_AUTO` aggregate column to confirm the special-case branch also excludes subtasks.
4. **Regression for `recoverAll`:** complete a subtask of a Backlog epic (so it's in `COMPLETED` but hidden under the epic). Add a loose completed card. Click "Recover All" on the COMPLETED column. Confirm only the loose completed card is recovered — the subtask stays under its epic.
5. **Regression for `promptAll` on `CODED_AUTO`:** with a subtask in a `CODER CODED` column (hidden under its epic) plus a loose coder-coded card, click "Prompt All" on the `CODED_AUTO` column. Confirm only the loose card gets a prompt.
6. **Regression for siblings (`moveAll`, `completeAll`):** run "Move all" and "Complete all" on a column that contains a loose card plus a hidden foreign subtask; confirm only the loose card is affected.
7. Confirm no console errors and the board re-renders correctly after each grouping.

---

**Recommendation:** Complexity is 4/10 → **Send to Coder**.

## Reviewer Pass — Completed

### Stage 1: Adversarial Findings (Grumpy Principal Engineer)

| Severity | Finding | File:Line |
|----------|---------|-----------|
| CRITICAL | None — plan-scoped code is correct. | — |
| MAJOR (process) | Commit `6c72aa4` bundled 3 unrelated changes with the one-line fix: (1) new Jules/Re-plan/Splitter button definitions, (2) a pre-existing `completeAll` case-block brace fix, (3) a dynamic review tooltip. Reverting the subtask-leak fix would revert all three. | `src/webview/kanban.html:4546-4559`, `:4840`, `:5327/5339` |
| NIT | Test regex `\n\s{8}\}` is indentation-fragile — a reformat would break it. Consistent with existing backend test patterns, so acceptable. | `src/test/kanban-subtask-column-leak-regression.test.js:101` |
| NIT | Plan proposed regex `\n\s{4}\}` but actual closing brace is at 8-space indent. Implementer silently corrected to `\s{8}`. Plan text above still shows the wrong regex (documentation drift). | plan text line 124 |

### Stage 2: Balanced Synthesis

**Keep (no changes needed):**
- `getAllInColumn` collector fix — both return paths now filter `&& !c.epicId`, exactly mirroring backend `_visibleColumnCards` (`KanbanProvider.ts:364-368`). Correct.
- Handler-level `!card.epicId` hardening at line 4805 — defense in depth as recommended. Correct.
- Test block #7 — regex validated against actual source; both CODED_AUTO and default branch assertions pass. Correct.
- `completeAll` brace fix (line 4840) — this was a real pre-existing structural bug (`case 'completeAll': {` was missing its closing `}`, silently consuming the switch's closing brace). Fixing it was correct even though undocumented.

**Fix now:** Nothing — plan-scoped implementation is complete and correct.

**Defer:**
- Out-of-scope bundled changes (Jules/Re-plan/Splitter buttons, review tooltip) — functional and wired up, but not this plan's concern. User may want to split into separate commits for hygiene.
- Backlog-view scoping — explicitly out-of-scope per plan. Defer unless UAT reproduces.

### Files Changed (Plan-Scoped)

| File | Change | Lines |
|------|--------|-------|
| `src/webview/kanban.html` | `getAllInColumn` CODED_AUTO branch: added `&& !c.epicId` | 4323 |
| `src/webview/kanban.html` | `getAllInColumn` default branch: added `&& !c.epicId` | 4325 |
| `src/webview/kanban.html` | `groupAllIntoEpic` handler: added `&& !card.epicId` (defense in depth) | 4805 |
| `src/test/kanban-subtask-column-leak-regression.test.js` | New test block #7: frontend `getAllInColumn` static-source regression assertions | 94-115 |

### Files Changed (Out-of-Scope, Bundled in Same Commit)

| File | Change | Lines |
|------|--------|-------|
| `src/webview/kanban.html` | New `julesBtn`/`rePlanBtn`/`splitterBtn` button definitions + rendering | 4546-4559, 4584-4586 |
| `src/webview/kanban.html` | `completeAll` case-block closing brace fix (pre-existing latent structural bug) | 4840 |
| `src/webview/kanban.html` | Dynamic review tooltip (`reviewTooltip` variable) | 5327, 5339 |

### Verification Results

- **Compilation:** Skipped per session directives.
- **Tests:** Skipped per session directives. User to run `node src/test/kanban-subtask-column-leak-regression.test.js` separately.
- **Static verification (performed):**
  - All 5 `getAllInColumn` consumers confirmed: `moveAll` (4713), `promptAll` (4750), `groupAllIntoEpic` (4798), `completeAll` (4835), `recoverAll` (5501).
  - Backend `_visibleColumnCards` contract confirmed at `KanbanProvider.ts:364-368` — frontend now mirrors it.
  - Test regex manually validated against actual source — both branch assertions will pass.
  - Switch/block brace structure confirmed balanced (lines 4834-4843) after the `completeAll` brace fix.
  - Out-of-scope button constants (`ICON_JULES`, `ICON_ANALYST_MAP`, `ICON_SPLITTER`) and handlers (`julesSelected`, `rePlanSelected`, `splitterSelected`) confirmed present — no dangling references.

### Remaining Risks

1. **Commit hygiene:** The subtask-leak fix shares a commit with unrelated features. If the fix needs to be reverted, the Jules/Re-plan/Splitter buttons and tooltip change revert with it. Recommend the user split commits in future auto-commit cycles.
2. **Backlog-view scoping:** The `groupAllIntoEpic` button retains `data-column="CREATED"` in backlog view, where the CREATED column is relabeled "BACKLOG". `getAllInColumn('CREATED')` may return hidden real-CREATED cards instead of visible backlog cards. Documented as out-of-scope; defer unless UAT reproduces.
3. **Test regex fragility:** The `\n\s{8}\}` pattern depends on exact 8-space indentation of the closing brace. A formatter change would break the test. Acceptable given existing pattern consistency.
