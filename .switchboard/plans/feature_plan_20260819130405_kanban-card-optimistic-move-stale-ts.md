# Kanban card jumps to middle on copy-prompt advance, then to top on paste

<!-- board-collapse-03 -->
> **RESCOPED 2026-09-04 (Board Collapse 03, decision 16).** Signed: **one comparator for render and for every optimistic move.**
> > 
> > **Keep** the timestamp bump before the DOM move — still needed so the card's data matches the backend's `updated_at = NOW` and the position signature changes for the right reason.
> > 
> > **Replace** the insert-by-timestamp walk in `moveCardElements` with a call to the same column comparator `renderBoard` uses. Verified at HEAD: that function already carries a second hand-rolled rule — queue position when the target is `STAGING`, timestamp everywhere else — and it knows nothing of the priority order-by shipped in `4df54319`, the star, or the creation-date ordering its sibling adds. A card dragged back into New would otherwise be inserted by a key that column is not sorted on. Extract the comparator once; the sibling sort plan and the optimistic star plan both consume it.


## Goal

### Problem

When the user clicks "Copy advance prompt" on a kanban card, the card sometimes appears in the **middle** of the target column instead of the top. It then jumps to the **top** when the user pastes the prompt into a terminal. The user perceives this as erratic, unpredictable ordering.

### Background Context

The kanban board sorts cards within each column by `_ts` (derived from `lastActivity`, which maps to the DB column `updated_at`) in **descending** order — newest activity at the top. The `_ts` derivation is at <ref_snippet file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html" lines="8066-8067" />, and the full-render sort comparator (ts-descending with a `createdAt` tiebreaker) is at <ref_snippet file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html" lines="8116-8135" />.

The "copy advance prompt" flow has two phases:

1. **Optimistic DOM move (webview, immediate):** `runCopyPrompt` (line 8258) calls `moveCardsOptimistically` (line 8329) → `moveCardElements` (line 6848), which physically relocates the card element to the target column. The insert position is determined by comparing the card's `dataset.ts` against existing children's `dataset.ts` values (lines 6768-6773: `if (cardTs > childTs) { insertBefore }`). At this point `dataset.ts` still holds the **stale** timestamp from the last render — it has NOT been updated to reflect the imminent backend write.

2. **Backend column advance (async):** `_handleCopyPlanLink` calls `_applyManualKanbanColumnChange` → `moveCardToColumnWithReason` → `updateColumnByPlanFileWithReason`, which executes `UPDATE plans SET kanban_column = ?, updated_at = ?` with `updated_at = new Date().toISOString()` (NOW). See <ref_snippet file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanDatabase.ts" lines="2536-2539" />. A debounced board refresh follows.

### Root Cause

The optimistic DOM move inserts the card into the target column using its **stale** `dataset.ts` — the timestamp from before the backend sets `updated_at = NOW`. If the target column already contains cards with newer timestamps, the card sorts into the **middle** of the column rather than the top.

The optimistic render guard (`optimisticMoveUntil`, a 2000ms window armed by `armOptimisticGuard` at line 5752) then suppresses full `renderBoard` calls from subsequent `updateBoard` messages. When the backend's board refresh arrives with the updated `lastActivity = NOW`, the guard's position-signature check (`buildPositionSignature`, which only compares `workspaceRoot|id|column` — see <ref_snippet file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html" lines="6999-7005" />) sees "positions match" and swallows the update without re-sorting. It sets `suppressedRenderPending = true` and does not re-render (lines 9545-9571).

The card stays in the middle until either:
- The guard expires (2000ms + 50ms) and a `refresh` is sent (line 5764), triggering a full render with the updated timestamp → card sorts to top.
- The user pastes the prompt into a terminal, triggering paste attribution → a board refresh that arrives after the guard expires (or clears it) → full render → card sorts to top.

The "sometimes" aspect: if the card's old `ts` happens to be the highest in the target column (e.g., the column is empty or has only older cards), the optimistic insert correctly places it at the top. If the column has cards with newer timestamps, the card lands in the middle.

## Metadata

**Complexity:** 3
**Tags:** frontend, ui, bugfix
**Project:** Browser Switchboard

## User Review Required

- **[user]** The drag-drop move path (line 9159) uses `targetBody.appendChild(cardEl)`, which places the card at the **bottom** of the target column, not the middle. When the backend refresh arrives, the card jumps from bottom to top — a different visual glitch than the copy-prompt "middle" bug. This plan does NOT fix the drag-drop path (it's out of scope for the reported bug). If the drag-drop bottom-to-top jump should also be fixed, a separate plan should be created. — proceeding on the assumption that the drag-drop path is out of scope for this bug report.

## Complexity Audit

### Routine
- Single-file change in the webview's optimistic-move path (`src/webview/kanban.html`).
- No new APIs, no database schema changes, no backend logic changes.
- The backend already sets `updated_at = NOW` correctly — the bug is purely that the webview's optimistic UI does not mirror that timestamp bump before inserting the card.
- The fix adds a timestamp bump + model sync before an existing DOM insert call.

### Complex / Risky
- **Ordering invariant:** `moveCardElements` resolves the source column from `currentCards` (line 6730: `sourceColumn || cardData.column`). The `cardData.column` update MUST happen AFTER `moveCardElements` returns, not before — otherwise the source column count decrement targets the wrong column. The original code's comment at line 6846-6847 documents this invariant.
- **Guard signature interaction:** The bumped `lastActivity` changes `buildBoardSignature(currentCards)`, which affects the guard's suppression logic in the `updateBoard` handler. The signatures will NOT match between optimistic and backend (different millisecond timestamps), but the guard suppresses via the position-signature check anyway — the card is already correctly positioned, so suppression is the desired behavior.

## Edge-Case & Dependency Audit

- **Drag-drop moves:** `moveCardElements` is NOT shared between copy-prompt-advance and drag-drop. The drag-drop path (line 9159) uses `targetBody.appendChild(cardEl)` — a blunt append to the bottom of the target column, not a ts-sorted insert. The fix in `moveCardsOptimistically` does NOT affect the drag-drop path.

  > **Superseded:** `moveCardElements` is shared between copy-prompt-advance and drag-drop. Both paths go through `updateColumnByPlanFileWithReason` which sets `updated_at = NOW`, so bumping `dataset.ts` to `Date.now()` in `moveCardElements` is correct for both. No separate handling needed.
  > **Reason:** The drag-drop path does NOT call `moveCardElements`. It directly calls `targetBody.appendChild(cardEl)` at line 9159, placing the card at the bottom of the target column. The fix is in `moveCardsOptimistically` (line 6839), which is only called from the copy-prompt and column-header advance paths (lines 7372, 7391, 7415, 7434, 8329). The drag-drop path has a separate visual behavior (bottom → top jump on backend refresh) that is out of scope for this bug report.
  > **Replaced with:** The fix only covers paths that go through `moveCardsOptimistically` (copy-prompt advance, column-header move/moveAll/promptSelected/promptAll). The drag-drop path is unaffected and out of scope.

- **Feature cascade moves:** `cascadeFeatureByPlanId` (line 6577) also sets `updated_at = now` (line 6588, UPDATE at 6597-6600), so the same timestamp-bump principle applies if the cascade triggers an optimistic move through `moveCardsOptimistically`.

- **STAGING queue inserts:** `moveCardElements` already has a special `queueInsert` path that inserts by `queue_position` instead of `ts`. At HEAD it keys on `STAGING`, not the retired `DISPATCH`: `const queueInsert = (domTargetColumn === 'STAGING')` (`kanban.html:7668`) — the plan's original line numbers (6743-6767) have drifted. The fix must NOT alter this path; only the `ts`-descending insert path is affected. Bumping `dataset.ts` is harmless for queue-ordered targets because the `queueInsert` branch ignores `dataset.ts` entirely.

- **Board signature stability:** `buildBoardSignature` includes `lastActivity` (line 7024). Updating `dataset.ts` and the `currentCards` model's `lastActivity` in the optimistic path will change the signature.

  > **Superseded:** Updating `dataset.ts` and the `currentCards` model's `lastActivity` in the optimistic path will change the signature, which is correct — it means the next `updateBoard` from the backend will match (both have NOW), preventing a unnecessary re-render bounce.
  > **Reason:** The optimistic `Date.now()` and the backend's `new Date().toISOString()` are called milliseconds apart — they produce different ISO strings, so the board signatures will NOT match. The guard still suppresses the re-render, but via the position-signature check (`buildPositionSignature` at line 9545-9547), not via a board-signature match. This is the desired behavior: the card is already correctly positioned at the top, so suppressing the full render avoids a visual flicker. When the guard expires, the expiry timer sends a `refresh` (line 5764), which triggers a full `renderBoard` with the backend's timestamp — and the card stays at the top because the backend's `lastActivity` is also ≈NOW.
  > **Replaced with:** The signatures will NOT match (different millisecond timestamps). The guard suppresses the re-render via the position-signature check instead. This is correct — the card is already at the top, so no re-render is needed. The card remains stable until the guard expires, at which point the full render confirms the same top position.

- **`currentCards` model sync:** `moveCardsOptimistically` already updates `cardData.column` (line 6852). The fix must also update `cardData.lastActivity` so the in-memory model matches the DOM. The `cardData.column` update MUST remain AFTER the `moveCardElements` call (to preserve the source-column resolution invariant), while `dataset.ts` and `cardData.lastActivity` must be updated BEFORE the call (so the DOM insert uses the bumped ts).

- **`moveCardsFailed` revert path:** When the backend rejects a move, the `moveCardsFailed` handler (line 9419) calls `moveCardElements` (line 9456) to revert the card to its source column. At this point, `dataset.ts` has been bumped to `Date.now()` by the fix. The revert insert will place the card at the **top** of the source column (since the bumped ts is newer than the source column's cards), instead of its original position. When the guard expires and a full render arrives, the card sorts by the backend's real `lastActivity` (the old value, since the move failed) and jumps back to its original position. This is a minor transient visual glitch on the failure path only. It self-corrects within ~2 seconds (guard expiry). Not worth adding complexity to fix — storing and restoring the original `dataset.ts` on revert would over-engineer a rare failure path.

- **`moveCards` confirmation path:** The `moveCards` handler (line 9400) calls `moveCardElements` (line 9407) while the guard is active. Since the fix bumps `dataset.ts` in `moveCardsOptimistically` before the first `moveCardElements` call, the confirmation path will also use the bumped ts. The card stays at the top. Correct.

## Dependencies

None — this is a self-contained single-file bugfix with no prerequisite plans.

## Adversarial Synthesis

Key risks: (1) ordering invariant violation — updating `cardData.column` before `moveCardElements` breaks source-column count resolution; (2) the `moveCardsFailed` revert path inherits the bumped ts, causing a transient top-of-source-column misposition on failure; (3) the drag-drop path is NOT covered by this fix and retains its own bottom-to-top jump. Mitigations: (1) the proposed code updates `dataset.ts` and `lastActivity` before the call but `cardData.column` after, preserving the invariant; (2) the revert glitch is transient (~2s) and self-correcting on guard expiry; (3) the drag-drop path is documented as out of scope in User Review Required.

## Proposed Changes

### File: `src/webview/kanban.html`

**1. Bump `dataset.ts` and `cardData.lastActivity` before the optimistic insert, but keep `cardData.column` update after.**

In `moveCardsOptimistically` (line 6839), bump the card's timestamp to `Date.now()` BEFORE calling `moveCardElements` so the DOM insert places it at the top of the target column (matching the backend's `updated_at = NOW`). The `cardData.column` update MUST remain AFTER `moveCardElements` to preserve the source-column resolution invariant documented at line 6846-6847.

```javascript
// BEFORE (lines 6839-6867):
function moveCardsOptimistically(sessionIds, sourceColumn, targetColumn) {
    const domTargetColumn = resolveDomColumn(targetColumn);
    const targetBody = document.getElementById('col-' + domTargetColumn);
    if (!targetBody) return;

    const entries = sessionIds.map(id => ({ id, targetColumn }));

    // Called before the model mutation below, so the source column resolves from
    // currentCards — no explicit sourceColumn needed here.
    const unresolved = moveCardElements(entries);

    sessionIds.forEach(id => {
        const cardData = currentCards.find(c => (c.planId || c.sessionId) === id);
        if (cardData) cardData.column = targetColumn;
    });

    lastBoardSignature = buildBoardSignature(currentCards);
    armOptimisticGuard(entries);

    if (unresolvedNeedsRender(unresolved)) {
        renderBoard(currentCards);
        lastBoardSignature = buildBoardSignature(currentCards);
    }
    updateDispatchToggleCount();
    updateDispatchViewInfo();
}
```

> **Superseded:** The original proposed "AFTER" code updated `cardData.column = targetColumn` in the same pre-`moveCardElements` loop that bumped `dataset.ts` and `lastActivity`.
> **Reason:** `moveCardElements` resolves the source column from `currentCards` at line 6730 (`sourceColumn || cardData.column`). If `cardData.column` is updated to `targetColumn` before the call, `moveCardElements` reads the NEW column as the source, causing the source-column count decrement (lines 6799-6808) to target the wrong column. The original code's comment at line 6846-6847 explicitly documents this invariant: "Called before the model mutation below, so the source column resolves from currentCards."
> **Replaced with:** Split the updates into two phases: (1) BEFORE `moveCardElements` — bump `dataset.ts` and `cardData.lastActivity` only; (2) AFTER `moveCardElements` — update `cardData.column` (unchanged from original code). This preserves the source-column invariant while ensuring the DOM insert uses the bumped timestamp.

```javascript
// AFTER (corrected):
function moveCardsOptimistically(sessionIds, sourceColumn, targetColumn) {
    const domTargetColumn = resolveDomColumn(targetColumn);
    const targetBody = document.getElementById('col-' + domTargetColumn);
    if (!targetBody) return;

    // Bump the card's timestamp to NOW before the DOM insert. The backend's
    // column advance always sets updated_at = NOW (updateColumnByPlanFileWithReason,
    // cascadeFeatureByPlanId), so the optimistic move must mirror that — otherwise
    // moveCardElements inserts by the stale dataset.ts and the card lands in the
    // middle of the target column instead of the top. The STAGING queue insert
    // path in moveCardElements ignores ts (it sorts by queue_position), so this
    // bump is harmless for queue-ordered targets.
    //
    // IMPORTANT: update dataset.ts and lastActivity BEFORE calling moveCardElements
    // (so the insert uses the bumped ts), but do NOT update cardData.column until
    // AFTER (so moveCardElements can resolve the source column from currentCards).
    const nowTs = Date.now();
    const nowIso = new Date(nowTs).toISOString();
    sessionIds.forEach(id => {
        const cardEl = document.querySelector(`.kanban-card[data-plan-id="${CSS.escape(id)}"]`)
            || document.querySelector(`.kanban-card[data-session="${CSS.escape(id)}"]`);
        if (cardEl) cardEl.dataset.ts = String(nowTs);
        const cardData = currentCards.find(c => (c.planId || c.sessionId) === id);
        if (cardData) cardData.lastActivity = nowIso;
    });

    const entries = sessionIds.map(id => ({ id, targetColumn }));

    // Called before the model mutation below, so the source column resolves from
    // currentCards — no explicit sourceColumn needed here.
    const unresolved = moveCardElements(entries);

    sessionIds.forEach(id => {
        const cardData = currentCards.find(c => (c.planId || c.sessionId) === id);
        if (cardData) cardData.column = targetColumn;
    });

    // lastBoardSignature now reflects the bumped lastActivity, which is correct —
    // it won't match the backend's signature (different ms), but the guard
    // suppresses via position-signature check, not board-signature match.
    lastBoardSignature = buildBoardSignature(currentCards);
    armOptimisticGuard(entries);

    if (unresolvedNeedsRender(unresolved)) {
        renderBoard(currentCards);
        lastBoardSignature = buildBoardSignature(currentCards);
    }
    updateDispatchToggleCount();
    updateDispatchViewInfo();
}
```

**2. No other changes needed.** The existing `sessionIds.forEach` block at lines 6850-6853 that sets `cardData.column = targetColumn` remains in place (after `moveCardElements`). The `lastBoardSignature = buildBoardSignature(currentCards)` at line 6855 now reflects the updated `lastActivity`, which is correct.

## Verification Plan

1. **Reproduce the original bug (pre-fix):** Open the kanban board with multiple cards in a target column (e.g., CODING) that have recent `lastActivity` timestamps. Click "Copy advance prompt" on a card in an earlier column whose `lastActivity` is older than the cards in the target column. Observe the card appears in the middle of the target column, then jumps to the top after pasting into a terminal or after ~2 seconds.

2. **Verify the fix (post-fix):** Repeat the same scenario. The card should appear at the **top** of the target column immediately on click, with no subsequent jump.

3. **Regression — column-header advance:** Click the advance arrow on a column header to move selected cards forward. Cards should appear at the top of the target column immediately (same `moveCardsOptimistically` path).

4. **Regression — STAGING queue ordering:** Stage cards into the STAGING queue in a specific order. The queue should still render by `queue_position` ascending, NOT by timestamp. The `dataset.ts` bump must not affect queue-ordered inserts (the `queueInsert` branch at `kanban.html:7668` ignores `dataset.ts`).

5. **Regression — source column count:** After an optimistic move, verify the source column's card count badge decremented correctly (not the target column's). This confirms the `cardData.column` update remains after `moveCardElements`.

6. **Regression — board signature stability:** After the optimistic move, the next `updateBoard` from the backend should NOT trigger a visible re-render bounce. The guard suppresses via position-signature check. Verify no visible flicker.

7. **Regression — moveCardsFailed revert:** Trigger a failed move (e.g., database unavailable). The card should revert to its source column. It may briefly appear at the top of the source column (due to the bumped ts) before settling to its correct position on guard expiry. This is acceptable transient behavior.

8. **Run existing tests:**
   ```
   node src/test/kanban-ordering-regression.test.js
   node src/test/kanban-render-guard-contract.test.js
   node src/test/kanban-drag-confirm-before-dispatch.test.js
   node src/test/kanban-card-button-drag-guard.test.js
   ```
