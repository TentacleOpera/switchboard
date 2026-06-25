# Fix: 350ms `setTimeout` Race Window in `handleDrop` Between Optimistic Move and Backend Dispatch

## Goal

Eliminate the race condition where a file-watcher or scheduled-refresh `updateBoard` message arrives during the 350ms `setTimeout` window in `handleDrop` (between the optimistic DOM move and the backend dispatch message), causing a spurious full `renderBoard` that can lose epic styling, selection state, and card animation state.

### Problem

When a user drags a card on the Kanban board, `handleDrop` performs an optimistic DOM move immediately (mutating `currentCards[].column` and relocating the card element), then waits 350ms before sending the backend dispatch message (`moveCardForward`, `moveCardBackwards`, `promptOnDrop`, `triggerAction`, etc.) inside a `setTimeout`. During this 350ms window:

1. A file-watcher event (e.g. `GlobalPlanWatcherService.onPlanDiscovered`) fires → `refreshIfShowing` → `_scheduleBoardRefresh` (100ms debounce) → `_refreshBoard` → `_refreshBoardImpl` → `_refreshBoardWithData` → `postMessage({ type: 'updateBoard', cards, ... })`.
2. The webview's `updateBoard` handler compares `buildBoardSignature(nextCards)` against `lastBoardSignature`.
3. If the signatures differ (e.g. because `lastActivity` changed, or a new plan was discovered, or the DB write from a concurrent operation landed), `renderBoard(nextCards)` runs — a full DOM replacement that destroys the optimistic UI state.

The parent plan's `lastBoardSignature` sync (applied after the optimistic mutation, before the `setTimeout`) mitigates the most common case: if the `updateBoard` data matches the optimistic state (same columns), the signature matches and no re-render occurs. But if the `updateBoard` carries genuinely different data (new plan discovered, `lastActivity` timestamp changed, another card moved concurrently), the signature WILL differ and the full re-render fires — even though the user's drag is still in-flight and the backend dispatch hasn't been sent yet.

### Root Cause Analysis

The 350ms `setTimeout` serves a UX purpose: it provides a visual "drop animation" window before the backend dispatch kicks off (which may trigger CLI agent launches, clipboard writes, etc.). But it creates a temporal gap where the webview's `currentCards` has been optimistically mutated but the backend hasn't been notified yet. During this gap, the webview is in a "limbo" state — it looks like the move is done, but the backend doesn't know about it.

The `updateBoard` handler has no concept of "an optimistic move is in-flight." It treats every `updateBoard` message as authoritative and will happily overwrite the optimistic state if the signature differs. This is architecturally sound for normal operation (the backend IS the source of truth), but it's wrong during the optimistic window — the backend hasn't been told about the move yet, so its data is stale relative to the user's intent.

**The race timeline:**

```
t=0ms    handleDrop: optimistic DOM move + currentCards mutation + lastBoardSignature sync
t=0-350ms  ← RACE WINDOW →
         file watcher fires → _scheduleBoardRefresh (100ms debounce)
         → _refreshBoard → _refreshBoardImpl → reads DB (stale, no move yet)
         → postMessage({ type: 'updateBoard', cards: staleData })
         → webview: signature differs (lastActivity changed, or new plan, etc.)
         → renderBoard(staleData) ← DESTROYS optimistic state
t=350ms  setTimeout fires: postKanbanMessage({ type: 'moveCardForward', ... })
         → backend: moveCardToColumn → DB updated
         → backend: postMessage({ type: 'moveCards', ... })
         → webview: moveCards handler updates currentCards + renderBoard
         → BUT the card was already re-rendered with stale data at t<350ms
```

**Why the `lastBoardSignature` sync doesn't fully fix this:**

The signature includes `lastActivity` (the `updatedAt` timestamp from the DB). When the file watcher triggers a refresh, the DB read returns rows with potentially newer `updatedAt` values (if any plan file was touched, even unrelated to the dragged card). This changes the signature even if no card's column changed, triggering a re-render. The signature also includes `topic`, `complexity`, `planFile`, `isEpic`, `subtaskCount`, and `epicId` — any of these changing on ANY card triggers a full re-render of ALL cards.

## Metadata

- **Tags**: `bugfix`, `ui`, `ux`, `frontend`, `race-condition`
- **Complexity**: 4
- **Affected Files**: `src/webview/kanban.html`
- **Parent Plan**: `feature_plan_20260625141328_epic-styling-lost-on-drag.md` (Risk 2)

## Complexity Audit

### Routine
- Adding a boolean flag (`optimisticMoveInFlight`) to guard the `updateBoard` handler is a small, localized change.
- The flag is set in `handleDrop` (already modified by the parent plan) and cleared in the `moveCards`/`triggerAction`/`promptOnDrop` response handlers.
- No new APIs, no schema changes.

### Complex / Risky
- **Flag clearing timing**: The flag must be cleared at the right time — not too early (before the `moveCards` delta arrives) and not too late (blocking legitimate refreshes). The safest approach is to clear it when the `moveCards` delta arrives (which means the backend has processed the move) or after a timeout fallback (in case the backend message is lost).
- **Multiple concurrent drags**: If the user drags multiple cards in rapid succession, each `handleDrop` call sets the flag. The flag must handle overlapping optimistic windows — either reference-counted or replaced by a timestamp-based check.
- **`triggerAction`/`triggerBatchAction` paths**: These don't send a `moveCards` delta — they rely on `_scheduleBoardRefresh` → `updateBoard`. The flag must be cleared by the `updateBoard` itself in this case (after the first `updateBoard` that matches the optimistic state), or by a timeout.
- **`CODED_AUTO` branch**: Has its own `setTimeout` (line 5784) with the same race window. Must be covered by the same guard.

## Edge-Case & Dependency Audit

### Race Conditions
- **This IS the race condition being fixed.** The guard prevents `updateBoard` from firing a full re-render during the optimistic window.
- **Guard bypass**: If the `moveCards` delta never arrives (backend error, panel disposed), the flag must be cleared by a timeout fallback to avoid permanently blocking refreshes.

### Security
- No security implications.

### Side Effects
- **Delayed refresh**: While the guard is active, `updateBoard` messages are deferred (not dropped — the data is still stored in `currentCards` via the `else` branch, but `renderBoard` is skipped). This means if a genuinely unrelated change happens during the window (e.g. a new plan is discovered), its visual update is delayed by up to 350ms + the fallback timeout. This is acceptable — the user is actively dragging, and a 350ms delay on an unrelated card appearance is imperceptible.
- **Signature-only updates**: The `else` branch of `updateBoard` (line 6238-6244) already does `currentCards = nextCards` without re-rendering when the signature matches. The guard extends this behavior to the case where the signature DOESN'T match but we're in an optimistic window.

### Dependencies & Conflicts
- Depends on the parent plan's `lastBoardSignature` sync (already applied).
- No conflicts with other in-flight changes expected.

| Edge Case | Impact | Mitigation |
|-----------|--------|------------|
| Backend error (moveCards never arrives) | Flag stuck active, refreshes permanently blocked | Timeout fallback (e.g. 2000ms) clears the flag |
| Multiple rapid drags | Overlapping optimistic windows | Use a counter or timestamp; clear on last `moveCards` or timeout |
| `triggerAction` path (no `moveCards` delta) | Flag never cleared by `moveCards` | Clear on first `updateBoard` after the `setTimeout` fires, or by timeout |
| `CODED_AUTO` branch | Same race window | Apply same guard to the `CODED_AUTO` `setTimeout` |
| `updateBoard` with genuinely new data (new plan) | Visual update delayed by ~350ms | Acceptable — user is actively dragging |
| User switches workspace during drag | `updateBoard` with different workspace's data | Guard should only apply to the current workspace's cards |

## Dependencies

- **Parent plan**: `feature_plan_20260625141328_epic-styling-lost-on-drag.md` must be merged first (provides the `lastBoardSignature` sync foundation).

## Proposed Changes

### 1. Add optimistic-move guard flag

**In `src/webview/kanban.html`, near the `lastBoardSignature` declaration (line 3767):**

```js
let lastBoardSignature = '';
// Guard: when true, suppress full renderBoard calls from updateBoard
// during an in-flight optimistic drag move. The flag is set in handleDrop
// after the optimistic DOM mutation, and cleared when the backend confirms
// the move (via moveCards delta) or by a timeout fallback.
let optimisticMoveInFlight = false;
let optimisticMoveTimeout = null;
```

### 2. Set the guard in `handleDrop` (both branches)

**Main `validIds` path (after line 5962, the `lastBoardSignature` sync):**

```js
lastBoardSignature = buildBoardSignature(currentCards);

// Suppress full re-renders during the 350ms dispatch window.
// The optimistic DOM move is already visible; a stale updateBoard
// arriving during this window would destroy it.
optimisticMoveInFlight = true;
if (optimisticMoveTimeout) clearTimeout(optimisticMoveTimeout);
optimisticMoveTimeout = setTimeout(() => {
    optimisticMoveInFlight = false;
    optimisticMoveTimeout = null;
}, 2000); // Fallback: clear after 2s in case backend response is lost
```

**`CODED_AUTO` branch (after line 5782, the `lastBoardSignature` sync):**

```js
lastBoardSignature = buildBoardSignature(currentCards);

// Same guard as the main validIds path above.
optimisticMoveInFlight = true;
if (optimisticMoveTimeout) clearTimeout(optimisticMoveTimeout);
optimisticMoveTimeout = setTimeout(() => {
    optimisticMoveInFlight = false;
    optimisticMoveTimeout = null;
}, 2000);
```

### 3. Clear the guard when the backend confirms the move

**In the `moveCards` handler (line 6159-6177), after `renderBoard`:**

```js
case 'moveCards': {
    // ... existing logic ...
    if (changed) {
        lastBoardSignature = buildBoardSignature(currentCards);
        renderBoard(currentCards);
    }
    // Backend confirmed the move — clear the optimistic guard.
    optimisticMoveInFlight = false;
    if (optimisticMoveTimeout) {
        clearTimeout(optimisticMoveTimeout);
        optimisticMoveTimeout = null;
    }
    break;
}
```

**Also clear in `moveCardsFailed` handler (line 6178-6208):** The move failed, so the guard should be cleared to allow the revert re-render:

```js
case 'moveCardsFailed': {
    // ... existing logic ...
    // Move failed — clear guard so the revert re-render can proceed.
    optimisticMoveInFlight = false;
    if (optimisticMoveTimeout) {
        clearTimeout(optimisticMoveTimeout);
        optimisticMoveTimeout = null;
    }
    break;
}
```

### 4. Guard the `updateBoard` handler

**In the `updateBoard` handler (line 6234-6244), modify the signature-mismatch branch:**

```js
if (nextBoardSignature !== lastBoardSignature) {
    if (optimisticMoveInFlight) {
        // An optimistic drag move is in-flight. Don't full-re-render —
        // the backend hasn't processed the move yet, so this updateBoard
        // carries stale data. Silently update currentCards so when the
        // guard clears, the next updateBoard has the freshest baseline.
        currentCards = nextCards;
        lastBoardSignature = buildBoardSignature(currentCards);
        // Still update epic worktrees if they changed (lightweight, no full re-render)
        if (epicWorktreesChanged) {
            renderBoard(currentCards);
        }
    } else {
        lastBoardSignature = nextBoardSignature;
        renderBoard(nextCards);
    }
} else {
    currentCards = nextCards;
    if (epicWorktreesChanged) {
        renderBoard(currentCards);
    }
}
```

**Key design decision**: When the guard is active and the signature differs, we still update `currentCards = nextCards` (so we don't lose the fresh data) and update `lastBoardSignature` (so the next `updateBoard` after the guard clears won't trigger a redundant re-render unless something genuinely changed). We only skip the `renderBoard` call. This means:
- The DOM keeps showing the optimistic state (card in new column, animations intact).
- `currentCards` is silently refreshed with the latest backend data.
- When the `moveCards` delta arrives (clearing the guard), its `renderBoard` will use the correct `currentCards` state.
- If the `moveCards` delta never arrives (timeout fallback clears the guard), the next `updateBoard` will compare against the updated `lastBoardSignature` and only re-render if something genuinely changed.

### 5. Handle `triggerAction`/`triggerBatchAction` paths (no `moveCards` delta)

These paths don't send a `moveCards` delta — they rely on `_scheduleBoardRefresh` → `updateBoard`. The guard's 2000ms timeout fallback handles this: after 2s, the guard clears and the next `updateBoard` proceeds normally. But we can do better:

**In the `updateBoard` handler, add a secondary check after the guard clears:**

When the guard is active and we suppress a re-render, we update `currentCards` and `lastBoardSignature`. When the guard later clears (via timeout), the next `updateBoard` will compare its signature against this updated `lastBoardSignature`. If the backend has since processed the move (via the `_scheduleBoardRefresh` triggered by `triggerAction`), the signature will match and no re-render occurs — the optimistic state is confirmed. If the backend hasn't processed it yet, the signature will differ and a re-render occurs — but at that point the user's drag is no longer in-flight (2s have passed), so the re-render is appropriate.

No additional code needed for this path — the timeout fallback + signature comparison handles it naturally.

## Verification Plan

### Automated Tests
- No existing automated tests cover this race condition (it requires real file-watcher timing). Manual verification is the primary path.

### Manual Verification

1. **Race reproduction — file watcher during drag:**
   - Create an epic with subtasks on the Kanban board
   - Open a terminal that writes to a plan file on a timer (simulating file-watcher activity)
   - Drag the epic card to the next column
   - During the 350ms window, ensure a file-watcher `updateBoard` fires
   - Verify: epic card retains `epic-card` styling (no full re-render)
   - Verify: after the `moveCards` delta arrives, the card is correctly positioned

2. **Normal drag (no race):**
   - Drag a card without any concurrent file activity
   - Verify: card moves correctly, guard doesn't interfere with normal operation

3. **Backend error (moveCards never arrives):**
   - Simulate a backend error by disposing the panel during the 350ms window
   - Wait 2s for the timeout fallback
   - Verify: guard clears, subsequent `updateBoard` messages are processed normally

4. **`triggerAction` path (CLI mode):**
   - Enable CLI triggers, drag a card forward
   - The `triggerAction` path fires (no `moveCards` delta)
   - Verify: during the 350ms window, a file-watcher `updateBoard` doesn't cause a re-render
   - Verify: after 2s timeout, the guard clears and the board updates correctly

5. **`CODED_AUTO` branch:**
   - Drag a card to the synthetic CODED_AUTO column
   - During the 350ms window, trigger a file-watcher refresh
   - Verify: no spurious re-render, card stays in CODED_AUTO

6. **Multiple rapid drags:**
   - Drag card A, then immediately drag card B (within 350ms)
   - Verify: both cards move correctly, guard handles overlapping windows
   - Verify: guard clears after the last `moveCards` delta or the 2s timeout

7. **`moveCardsFailed` path:**
   - Trigger a move that fails (e.g. DB unavailable)
   - Verify: guard clears immediately on `moveCardsFailed`, revert re-render proceeds

8. **Epic worktree update during guard:**
   - During an optimistic drag, trigger an epic worktree change
   - Verify: `renderBoard` still fires for epic worktree changes (lightweight path preserved)

9. **Regression — normal board refresh:**
   - Without any drag in progress, trigger board refreshes (file watcher, manual refresh)
   - Verify: `updateBoard` handler works exactly as before (guard is `false`, normal path)

---

**Recommendation**: Complexity 4 → **Send to Coder**
