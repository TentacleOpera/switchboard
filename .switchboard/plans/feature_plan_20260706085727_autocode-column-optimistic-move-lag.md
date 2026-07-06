# Fix Autocode Column Card Appearance Lag

## Goal

When a card is advanced to the AUTOCODE column (the collapsed view of the three coder columns: LEAD CODED, CODER CODED, INTERN CODED), it takes ~1 second for the card to visually appear in the column. Other columns show the card immediately via optimistic DOM updates. The AUTOCODE column is not as snappy because the optimistic move fails silently when coders are collapsed.

### Problem Analysis & Root Cause

When the "Collapse Coders" feature is enabled, the three coder columns (LEAD CODED, CODER CODED, INTERN CODED) are replaced by a single synthetic column with `id: 'CODED_AUTO'` and `label: 'AUTOCODE'` (see `renderColumns()` at line 4645-4665). This synthetic column exists in the rendered DOM as `col-CODED_AUTO`, but the **logical** column IDs remain `LEAD CODED`, `CODER CODED`, `INTERN CODED` — `CODED_AUTO` is NOT in the `columns` array (`columns` is built at line 3788-3790 from `columnDefinitions.map(col => col.id)`; the synthetic entry is only injected into `renderDefs` inside `renderColumns`, never into `columns`).

The optimistic move path for the Copy Prompt button (lines 5489-5527) works as follows:
1. It gets the card's current column (e.g., `PLAN REVIEWED`) from `btn.dataset.column`, which is set to the **logical** column `card.column` at card-render time (line 5616: `data-column="${escapeAttr(card.column)}"`).
2. It calls `getNextColumn(nextColSource)` (line 5508) to find the next column — which returns `LEAD CODED` (the first coder column present in the `columns` array).
3. It calls `moveCardsOptimistically([sessionId], column, nextCol)` (line 5516) with `nextCol = 'LEAD CODED'`.

Inside `moveCardsOptimistically` (line 4413-4488):
```javascript
const targetBody = document.getElementById('col-' + targetColumn);
if (!targetBody) return;  // <-- EARLY RETURN: col-LEAD CODED doesn't exist when collapsed!
```

When coders are collapsed, `document.getElementById('col-LEAD CODED')` returns `null` because only `col-CODED_AUTO` exists in the DOM. The function returns immediately without moving the card. The card only appears after the backend processes the move and sends an `updateBoard` message with the new positions, which takes ~1 second round-trip.

The source column resolution already handles this correctly (line 4436-4438):
```javascript
const CODED_IDS = ['LEAD CODED', 'CODER CODED', 'INTERN CODED'];
const sourceDomCol = (collapseCodersEnabled && CODED_IDS.includes(actualColumn))
    ? 'CODED_AUTO'
    : actualColumn;
```

But the **target** column is never resolved to `CODED_AUTO` when collapsed. This is the bug.

**Scope of the silent failure (verified):** `moveCardsOptimistically` is called from **five** sites — the per-card Copy Prompt handler (line 5516) and four column-header handlers: `moveSelected` (4896), `moveAll` (4912), `promptSelected` (4933), `promptAll` (4949). The internal `domTargetColumn` fix rescues the *card move* for all five. However, every one of those five call sites **also** resolves the highlight target via `document.getElementById('col-' + nextCol)` (lines 4891, 4907, 4928, 4944, 5511) — and all five fail to flash when the next column is a coder column and coders are collapsed. The original plan patched only the per-card site (5511); the other four were missed.

## Metadata

- **Plan ID:** D05BF6C1-FD1B-4659-8E6B-E34C68714734
- **Tags:** bugfix, ui, performance, frontend
- **Complexity:** 4

## User Review Required

Not required. The fix is a mechanical application of the **existing** source-resolution pattern (line 4436-4438) to the target-column path — no new product/UX decision is introduced. The intended behavior already matches the bespoke drag-drop path (`handleDrop` for `CODED_AUTO`, line 5909), which has shipped correctly. No confirm dialogs are involved (and per `CLAUDE.md`, none may be added). Proceed to coding.

## Complexity Audit

### Routine
- Single-file change (`src/webview/kanban.html`), all edits localized to the optimistic-move + highlight code paths.
- Reuses an already-proven pattern: the source-column → `CODED_AUTO` resolution at line 4436-4438 is mirrored onto the target column.
- No backend, data-model, or persistence changes — `card.column` stays on the logical column; only DOM container/count lookups change.
- The drag-drop path (`handleDrop`, line 5909) already does the equivalent resolution correctly, so the behavior is well-understood and precedent exists.

### Complex / Risky
- Five highlight call sites must be updated consistently; missing any one leaves a column-header path without the target flash (cosmetic regression, not a correctness regression).
- `CODED_IDS` is currently duplicated in five places (4435, 4513, 4876, 5501, 5910); adding more inline copies without a shared constant invites a silent drift bug if one copy diverges. Mitigated by hoisting one module-level constant + helper (see Proposed Changes).
- Stale line numbers in the original plan were off by ~9-10 lines from the current file; implementer must anchor to the corrected numbers below.

## Edge-Case & Dependency Audit

- **Race Conditions:** The `optimisticMoveUntil` render-guard (armed at line 4487, window `OPTIMISTIC_MOVE_WINDOW_MS = 2000` at line 3817) suppresses `renderBoard` during the optimistic window. Currently the guard is armed *after* the early-return risk — but with the fix, `targetBody` resolves to `col-CODED_AUTO` (which exists), so the function proceeds past the guard-arming line. No new race: the guard prevents a stale `updateBoard` (carrying pre-move positions) from snapping the card back, exactly as on the expanded path. The `lastBoardSignature` recompute at 4475 keeps the guard in sync with the mutated `currentCards[].column`.
- **Security:** None. Pure client-side DOM manipulation inside the webview; no message content, credentials, or user input is handled.
- **Side Effects:**
  - `card.column` is mutated to the **logical** target (e.g. `LEAD CODED`), not `CODED_AUTO` — so the backend round-trip (`promptSelected`/`moveSelected` etc.) and any subsequent `updateBoard` remain consistent with the data model. Confirmed at line 4445 (`if (cardData) cardData.column = targetColumn;`) — this line must keep using `targetColumn`, NOT the DOM-resolved column.
  - Count elements: the synthetic column's count span is `count-CODED_AUTO` (rendered via `count-${def.id}` at line 4701/4706, where `def.id === 'CODED_AUTO'` for the synthetic entry). The target-count increment (line 4466) must resolve to the DOM column.
  - Empty-state removal uses `targetBody` (line 4418) and is unaffected once `targetBody` resolves correctly.
- **Dependencies & Conflicts:**
  - Collapsed vs expanded coders: when NOT collapsed, `col-LEAD CODED` exists and `CODED_IDS.includes(targetColumn)` is still true — but `collapseCodersEnabled` is false, so `domTargetColumn` falls through to `targetColumn`. No behavior change on the expanded path.
  - `getNextColumn` returns a logical ID (e.g. `LEAD CODED`), never `CODED_AUTO` (since `CODED_AUTO` is not in `columns`). The fix maps logical→DOM for lookups while keeping logical for `card.column`. If `LEAD CODED` is hidden via `lastVisibleAgents`, the first coder column in `columns` may be `CODER CODED` or `INTERN CODED`; the `CODED_IDS.includes(...)` check handles any of them generically.
  - Feature cards: excluded from `CODED_AUTO` aggregation in `getAllInColumn` (line 4514: `&& !c.featureId`). The fix does not touch feature-card filtering.
  - Backward moves (from a coder column to a non-coder column): source resolution (line 4436) already handles the collapsed source; the target is a real DOM column, so no change needed.

## Dependencies

None. This is a self-contained webview-only bugfix with no prerequisite plans or sessions.

## Adversarial Synthesis

Key risks: (1) the highlight flash is broken at 4 of 5 call sites — fixing only the per-card site leaves the column-header `moveAll`/`moveSelected`/`promptAll`/`promptSelected` paths without the target flash; (2) `CODED_IDS` duplicated across 5+ sites invites a silent drift bug if one copy diverges. Mitigations: hoist a single module-level `CODED_IDS` constant plus a `resolveDomColumn(logicalCol)` helper, and apply it at every DOM-resolution site (the `moveCardsOptimistically` body + all five highlight sites); keep `card.column` on the logical column so the backend round-trip and render-guard stay consistent.

## Proposed Changes

### `src/webview/kanban.html` — Hoist shared `CODED_IDS` + `resolveDomColumn()` helper (~line 3800, near `collapseCodersEnabled`)

**Context:** `CODED_IDS = ['LEAD CODED', 'CODER CODED', 'INTERN CODED']` is currently duplicated at lines 4435, 4513, 4876, 5501, and 5910. Adding more inline copies (as the original plan proposed) multiplies the drift risk. Hoist one constant and a tiny resolver.

**Logic:** A single helper maps a logical column to its DOM container id when coders are collapsed, and is a no-op identity otherwise. This is the exact predicate already inlined at line 4436-4438, just named.

**Implementation** (insert near the `collapseCodersEnabled` declaration, ~line 3800):
```javascript
const CODED_IDS = ['LEAD CODED', 'CODER CODED', 'INTERN CODED'];
/** Map a logical column id to its rendered DOM column id.
 *  When coders are collapsed, the three coder columns share the synthetic
 *  `col-CODED_AUTO` container; otherwise each maps to itself. */
function resolveDomColumn(logicalCol) {
    return (collapseCodersEnabled && CODED_IDS.includes(logicalCol))
        ? 'CODED_AUTO'
        : logicalCol;
}
```
Then replace the inline `CODED_IDS` declarations at 4435, 4513, 4876, 5501, and 5910 with references to the hoisted constant (delete the local `const CODED_IDS = [...]` lines; keep the surrounding logic). This is a Clarification-level cleanup strictly implied by the existing pattern — no new behavior.

**Edge Cases:** `collapseCodersEnabled` is a module-level `let` initialized at line 3800 and restored from webview state at 3802-3807; the helper reads it live, so a mid-session toggle is handled correctly. `CODED_AUTO` passed in is not in `CODED_IDS`, so it returns itself — safe for the `column === 'CODED_AUTO'` branches at 4878/4915/4952/5503.

### `src/webview/kanban.html` — Resolve target column to DOM column in `moveCardsOptimistically` (line 4413)

**Context:** The early return at line 4415 (`if (!targetBody) return;`) is the root cause — when collapsed, `col-LEAD CODED` does not exist.

**Logic:** Resolve the DOM target while keeping the logical `targetColumn` for `card.column` updates. Mirror the source-resolution pattern at 4436-4438.

**Implementation** (top of `moveCardsOptimistically`, line 4413-4415):
```javascript
function moveCardsOptimistically(sessionIds, sourceColumn, targetColumn) {
    // When coders are collapsed, the target DOM container is CODED_AUTO, not the
    // individual coder column. Resolve the DOM target while keeping the logical
    // targetColumn for card.column updates.
    const domTargetColumn = resolveDomColumn(targetColumn);

    const targetBody = document.getElementById('col-' + domTargetColumn);
    if (!targetBody) return;
```

Then update the **DOM-only** references within the function to use `domTargetColumn`; keep `targetColumn` for the logical mutation:

1. **Empty-state removal (line 4418):** Already uses `targetBody` — no change needed.
2. **Card append (line 4442):** Already uses `targetBody` — no change needed.
3. **Count increment (line 4466):** Change `count-' + targetColumn` to `count-' + domTargetColumn`:
   ```javascript
   const tgtCount = document.getElementById('count-' + domTargetColumn);
   if (tgtCount) {
       tgtCount.textContent = String((parseInt(tgtCount.textContent || '0') + actualMovedCount));
   }
   ```
4. **`card.column` update (line 4445):** KEEP using `targetColumn` (the logical column) — this is correct and must NOT change:
   ```javascript
   if (cardData) cardData.column = targetColumn;  // logical column, NOT domTargetColumn
   ```
5. **Render-guard signature + arming (lines 4475 & 4487):** Unchanged — they operate on `currentCards` (logical) and `Date.now()`, not DOM column ids.

### `src/webview/kanban.html` — Fix Copy Prompt handler target highlight (line 5511-5515)

**Context:** The per-card Copy Prompt handler resolves `nextCol = getNextColumn(nextColSource)` (line 5508) — a logical id. The highlight at 5511 uses `col-' + nextCol`, which returns null when collapsed. The `moveCardsOptimistically` call at 5516 is now fixed internally (per the change above), so no change to the call itself — only the highlight lookup.

**Implementation** (line 5510-5515):
```javascript
if (nextCol) {
    const domNextCol = resolveDomColumn(nextCol);
    const targetBody = document.getElementById('col-' + domNextCol);
    if (targetBody) {
        targetBody.classList.add('highlight');
        targetBody.addEventListener('animationend', () => targetBody.classList.remove('highlight'), { once: true });
    }
    moveCardsOptimistically([sessionId], column, nextCol);
}
```

### `src/webview/kanban.html` — Fix the four column-header highlight sites (lines 4891, 4907, 4928, 4944)

**Context:** The `moveSelected`/`moveAll`/`promptSelected`/`promptAll` header handlers each do `const targetBody = document.getElementById('col-' + nextCol);` for the highlight flash. When `nextCol` is a coder column and coders are collapsed, this returns null and the flash is silently skipped. The card move itself is already rescued by the `moveCardsOptimistically` internal fix; only the highlight is missing.

**Logic:** Apply the same `resolveDomColumn(nextCol)` mapping at each of the four sites. The `nextCol` value and the `moveCardsOptimistically(ids, column, nextCol)` call stay on the logical id.

**Implementation** — apply the identical 2-line change at each of the four sites (4890-4891, 4906-4907, 4927-4928, 4943-4944):
```javascript
if (nextCol) {
    const domNextCol = resolveDomColumn(nextCol);
    const targetBody = document.getElementById('col-' + domNextCol);
    if (targetBody) {
        targetBody.classList.add('highlight');
        targetBody.addEventListener('animationend', () => targetBody.classList.remove('highlight'), { once: true });
    }
    moveCardsOptimistically(ids, column, nextCol);  // unchanged — logical nextCol
}
```
The `postKanbanMessage(...)` dispatch lines (e.g. 4898, 4916/4918, 4935, 4953/4955) are unchanged — they send `backendColumn`, not the DOM column.

**Edge Cases:**
- When the source column is `CODED_AUTO` (e.g. advancing out of AUTOCODE to CODE REVIEWED), `nextCol` is a real DOM column, `resolveDomColumn` returns it unchanged — highlight works as before.
- When coders are expanded, `collapseCodersEnabled` is false → `resolveDomColumn` is identity → no behavior change on the expanded path.

## Verification Plan

### Automated Tests

None. Per session directive, automated tests and compilation (`npm run compile`) are skipped. `dist/` is not used during development/testing (per `CLAUDE.md`); all verification is manual via an installed VSIX. Verification is by manual UI reproduction below.

### Manual Verification

1. Enable "Collapse Coders" so the AUTOCODE column is visible.
2. Create a plan in the PLAN REVIEWED column.
3. Click "Copy Prompt" on the card to advance it.
4. Verify the card immediately appears in the AUTOCODE column (no ~1s delay).
5. Verify the AUTOCODE column count increments immediately.
6. Verify the source column count decrements and shows "No plans" if empty.
7. Verify the AUTOCODE column header flashes the highlight animation on advance.
8. Verify the card stays in the column (no snap-back) during the 2s render-guard window.
9. From PLAN REVIEWED, use the column-header "Move All" / "Prompt All" buttons — verify cards move immediately AND the AUTOCODE header flashes (covers the 4891/4907/4928/4944 sites).
10. Use "Move Selected" / "Prompt Selected" with a selected card — verify same.
11. Disable "Collapse Coders" and repeat steps 3-10 — verify cards still move and highlight correctly to individual coder columns (regression check for the expanded path).
12. Test advancing a card that is already in a coder column (e.g. LEAD CODED → next column) — verify it works both collapsed and expanded (covers the `column === 'CODED_AUTO'` / `CODED_IDS.includes(column)` branch at 5503).
13. Toggle Collapse Coders mid-session (without a board reload) and re-test — confirms `resolveDomColumn` reads `collapseCodersEnabled` live.

---

**Recommendation:** Complexity 4 (Low — routine single-file change reusing an existing pattern). **Send to Coder.**
