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

> **Verified against source (2026-06-25).** `buildBoardSignature` is at `src/webview/kanban.html:4523`. Its per-card key is exactly:
> `${workspaceRoot}|${planId||sessionId}|${column}|${topic}|${planFile}|${complexity}|${lastActivity}|${isEpic}|${subtaskCount}|${epicId}` — so the root-cause analysis above is accurate: any drift in `lastActivity` (or any other field) on any card flips the signature and forces a full re-render.

## Metadata

- **Tags**: `bugfix`, `ui`, `ux`, `frontend`, `reliability`
  - _(Note: `race-condition` from the original draft is not in the allowed tag list; mapped to `reliability`.)_
- **Complexity**: 5 _(was 4 — see Complexity Audit; raised one notch because the guard's correctness hinges on subtle render-suppression and overlapping-window handling, not because the diff is large)_
- **Affected Files**: `src/webview/kanban.html`
- **Parent Plan**: `feature_plan_20260625141328_epic-styling-lost-on-drag.md` (Risk 2)

## User Review Required

- **None.** All design decisions are made and stated below:
  - Guard mechanism: a **timestamp deadline** (`optimisticMoveUntil`), not a boolean + clear-on-`moveCards` (rationale in Adversarial Synthesis and Proposed Changes — it is the only variant that correctly survives overlapping rapid drags).
  - Suppression window: **2000 ms** from the moment of drop, re-armed per drag. Tunable constant `OPTIMISTIC_MOVE_WINDOW_MS`.
  - The `COMPLETED`/archive path (no 350 ms `setTimeout`) is **out of scope** for this plan; see Edge-Case audit for the documented residual.

## Complexity Audit

### Routine
- Declaring a guard variable (`optimisticMoveUntil`) and a constant next to the existing `lastBoardSignature` declaration is a small, localized change (`src/webview/kanban.html:3766`).
- Arming the guard is a single assignment added immediately after the two existing `lastBoardSignature = buildBoardSignature(currentCards)` sync lines (`:5781` CODED_AUTO path, `:5962` main `validIds` path).
- No new APIs, no schema changes, no backend changes. Single file.
- Uses only standard browser globals already used throughout the file (`Date.now`, `setTimeout`).

### Complex / Risky
- **Render-suppression correctness**: the guard must suppress the *full* `renderBoard` during the window — including the `epicWorktreesChanged` branch. The original draft (Proposed Change #4) still called `renderBoard(currentCards)` when `epicWorktreesChanged` was true *inside* the guard, which would have reverted the optimistic move and re-introduced the exact bug. The revised design closes this.
- **Overlapping rapid drags**: clearing the guard on the *first* `moveCards` delta (original Proposed Change #3) leaves a still-in-flight second drag unguarded. The revised deadline approach re-arms the window on every drop, so the guard naturally outlives the last drag.
- **`triggerAction`/`triggerBatchAction` paths**: these don't send a `moveCards` delta — they rely on `_scheduleBoardRefresh` → `updateBoard`. The deadline expiring is the sole, correct clear path for them.
- **`CODED_AUTO` branch**: has its own `setTimeout` (`:5783`) with the same race window. Covered by arming the guard at `:5781`.
- **Data/DOM transient desync**: while the guard absorbs `currentCards = nextCards` (stale w.r.t. the move) but skips `renderBoard`, `currentCards` momentarily disagrees with the DOM. This is intentional and self-heals on the next authoritative render; see the design note in Proposed Changes.

## Edge-Case & Dependency Audit

### Race Conditions
- **This IS the race condition being fixed.** The guard prevents `updateBoard` from firing a full re-render during the optimistic window.
- **Guard never clears**: impossible with the deadline approach — `Date.now() < optimisticMoveUntil` is false once wall-clock passes the deadline, regardless of whether any backend message arrived. No stuck-flag failure mode.
- **Overlapping drags**: each drop pushes `optimisticMoveUntil` forward, so the guard stays armed until 2 s after the *last* drag — every in-flight move is covered.

### Security
- No security implications.

### Side Effects
- **Delayed refresh**: while the guard is active, signature-mismatching `updateBoard` messages are absorbed into `currentCards` but not rendered. A genuinely unrelated change (e.g. a newly discovered plan) is visually delayed by up to the window (≤2 s after the last drag). Acceptable — the user is actively dragging, and the data is not lost; it renders on the next authoritative render (a `moveCards`/`moveCardsFailed` delta, or the first post-window `updateBoard`).
- **Signature-only updates**: the `else` branch of `updateBoard` (`:6238`) already does `currentCards = nextCards` without re-rendering when the signature matches. The guard extends this "store-but-don't-render" behavior to the signature-mismatch case during the window, and additionally suppresses the `epicWorktreesChanged` re-render during the window so a worktree change can't cut the drop animation.

### Dependencies & Conflicts
- Depends on the parent plan's `lastBoardSignature` sync — **verified already present in source** at `:5781` (CODED_AUTO) and `:5962` (main `validIds`).
- Touches the same `updateBoard` handler as the sibling plan `feature_plan_20260625213001_button-movecards-subtask-id-inclusion.md` (which concerns `moveCards` payload shape). No logical conflict — that plan changes the `moveCards` *message contents*; this plan changes *when `updateBoard` renders*. Land order does not matter, but expect a textual merge near the `moveCards`/`updateBoard` cases.

| Edge Case | Impact | Mitigation |
|-----------|--------|------------|
| Backend error (moveCards never arrives) | Guard would stay stuck (boolean approach) | Deadline approach auto-clears at wall-clock expiry — no stuck state |
| Multiple rapid drags | Overlapping optimistic windows | Deadline re-armed on each drop → covers the last drag's full window |
| `triggerAction` path (no `moveCards` delta) | No delta to clear on | Deadline expiry is the intended clear path; post-window `updateBoard` reconciles via signature |
| `CODED_AUTO` branch | Same race window | Arm the guard at `:5781` (alongside its `lastBoardSignature` sync) |
| `updateBoard` with genuinely new data (new plan) | Visual update delayed ≤2 s | Acceptable — user is actively dragging; data absorbed into `currentCards`, rendered on next authoritative render |
| Epic worktree change during window | Original draft re-rendered → reverted the move | Suppress `epicWorktreesChanged` re-render while guard active; worktree data is stored and renders post-window |
| User switches workspace/project during drag | New workspace's board suppressed until window expires | Reset `optimisticMoveUntil = 0` at the two switch sites (`:6898`, `:6942`) that already reset `lastBoardSignature` |
| `COMPLETED`/archive drop | Mutates `card.column` + posts `completePlan` **immediately** (no `setTimeout`, no `lastBoardSignature` sync) | **Out of scope** — no 350 ms window. Residual: a stale `updateBoard` between the mutation and `completePlan` processing can transiently desync data vs DOM, self-healing on the real post-archive `updateBoard`. Optional follow-up: arm the guard + sync `lastBoardSignature` at `:5868` for consistency. |

## Dependencies

- **No cross-session (`sess_…`) dependencies.**
- **Plan dependency**: `feature_plan_20260625141328_epic-styling-lost-on-drag.md` (parent) — provides the `lastBoardSignature` sync foundation, already merged into source.
- **Sibling (informational, not blocking)**: `feature_plan_20260625213001_button-movecards-subtask-id-inclusion.md` — edits the adjacent `moveCards` case; expect a textual merge, no semantic conflict.

## Adversarial Synthesis

**Risk Summary**: The dominant risk is a self-defeating guard — the original draft still called `renderBoard` inside the guarded branch when `epicWorktreesChanged`, which would revert the very move it was protecting; the fix is to suppress *all* `renderBoard` paths during the window. The second risk is overlapping rapid drags: clearing on the first `moveCards` delta exposes later in-flight moves, so the guard uses a re-armed timestamp deadline (`optimisticMoveUntil`) instead of a boolean cleared by handlers — this also removes the stuck-flag failure mode entirely and drops the need to touch the `moveCards`/`moveCardsFailed` handlers. Mitigations: deadline auto-expiry, per-drop re-arm, full render-suppression during the window, and a guard reset on workspace/project switch.

## Proposed Changes

> The numbered changes below preserve the original draft. The **"Adversarial Review Revisions"** block that follows supersedes the implementation specifics where the review found correctness gaps. Implement the revised versions; the originals are retained for traceability.

### 1. Add optimistic-move guard flag

**In `src/webview/kanban.html`, near the `lastBoardSignature` declaration (line 3766):**

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

**Main `validIds` path (after the `lastBoardSignature` sync at `:5962`):**

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

**`CODED_AUTO` branch (after the `lastBoardSignature` sync at `:5781`):**

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

**In the `moveCards` handler (`:6165`), after `renderBoard`:**

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

**Also clear in `moveCardsFailed` handler (`:6184`):** The move failed, so the guard should be cleared to allow the revert re-render:

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

**In the `updateBoard` handler (signature-mismatch branch at `:6234`):**

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

---

### Adversarial Review Revisions (implement these)

The review found two correctness gaps and one missing case in the boolean+timeout design above. The revised design replaces the boolean/timeout pair with a single re-armed **timestamp deadline**, which (a) cannot get stuck, (b) correctly covers overlapping drags, and (c) removes the need to touch the `moveCards`/`moveCardsFailed` handlers at all.

**Revision A — declare a deadline, not a boolean (supersedes Change #1).** Near `:3766`:

```js
let lastBoardSignature = '';
// Render-guard deadline (epoch ms). While Date.now() < this value an in-flight
// optimistic drag is suppressing full renderBoard calls from updateBoard. 0 = inactive.
// Re-armed on every drop so overlapping drags EXTEND the window rather than
// clearing it prematurely; auto-expires so it can never get stuck.
let optimisticMoveUntil = 0;
const OPTIMISTIC_MOVE_WINDOW_MS = 2000; // covers the 350ms dispatch + backend round-trip
```

**Revision B — arm the deadline at both `setTimeout` paths (supersedes Change #2).** Immediately after each existing `lastBoardSignature = buildBoardSignature(currentCards);` line — i.e. after `:5781` (CODED_AUTO) and after `:5962` (main `validIds`):

```js
lastBoardSignature = buildBoardSignature(currentCards);
optimisticMoveUntil = Date.now() + OPTIMISTIC_MOVE_WINDOW_MS;  // arm/extend the render guard
```

No `clearTimeout`/timeout-handle bookkeeping — the deadline replaces it.

**Revision C — drop Change #3 entirely.** Do **not** clear the guard from `moveCards`/`moveCardsFailed`. Those handlers already call `renderBoard(currentCards)` from authoritative state when `changed`, so they don't need the guard cleared to function — and clearing on the first delta is exactly what breaks overlapping drags. The deadline is the single source of truth for "is a drag window active," and it expires on its own. (Leaving the guard armed for the remainder of the window after a confirmed move only defers *unrelated* `updateBoard` re-renders, which is already documented as acceptable.)

**Revision D — suppress ALL renders during the window (fixes the self-defeating bug in Change #4).** Replace the `:6234` branch with:

```js
const optimisticActive = Date.now() < optimisticMoveUntil;
if (nextBoardSignature !== lastBoardSignature) {
    if (optimisticActive) {
        // Optimistic drag in-flight: backend hasn't processed the move yet, so
        // nextCards is stale w.r.t. the user's intent. Absorb the data (so the next
        // authoritative render — a moveCards delta or a post-window updateBoard —
        // has the freshest baseline) but DO NOT renderBoard: a full DOM replacement
        // here would revert the optimistic move and strip epic styling/animation.
        // currentEpicWorktrees is already updated above; worktree visuals render
        // when the window expires.
        currentCards = nextCards;
        lastBoardSignature = buildBoardSignature(currentCards);
    } else {
        lastBoardSignature = nextBoardSignature;
        renderBoard(nextCards);
    }
} else {
    currentCards = nextCards;
    if (epicWorktreesChanged && !optimisticActive) {
        renderBoard(currentCards);
    }
}
```

The critical difference from Change #4: the `epicWorktreesChanged` re-render is gated behind `!optimisticActive` in **both** branches. `renderBoard` is a full DOM rebuild (the same call this plan exists to prevent) — it is *not* a lightweight worktree-only update, so it must not run mid-window.

**Revision E — reset the guard on workspace/project switch (new, fixes the workspace-switch edge case).** At the two sites that already reset `lastBoardSignature = ''` for an explicit switch — `:6898` (reassign-to-workspace) and `:6942` (workspace-project-select change) — add alongside each:

```js
lastBoardSignature = '';
optimisticMoveUntil = 0;  // a deliberate workspace switch ends any in-flight drag guard
```

This guarantees the newly selected workspace's board renders immediately instead of being suppressed for the remainder of a stale drag window.

**Design note — transient `currentCards`/DOM desync (intentional).** While the guard absorbs `currentCards = nextCards` but skips `renderBoard`, `currentCards` reflects backend (pre-move) data while the DOM shows the optimistic (post-move) position. This is deliberate and self-heals: the next authoritative render rebuilds the DOM from `currentCards`. On the `moveCards` path, the delta maps over `currentCards`, re-applies the moved card's `targetCol` (→ `changed = true`), and `renderBoard` produces the fully correct state **including** any new plans that arrived during the window — folding the move-correction and the fresh data into a single render. On the `triggerAction` path (no delta), the first post-window `updateBoard` reconciles via signature comparison.

## Verification Plan

### Automated Tests
- No existing automated tests cover this race condition (it requires real file-watcher timing). Manual verification is the primary path.
- Per session directive, the test suite is run separately by the user; no test run is performed as part of this planning pass.

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
   - Wait for the window to expire (≤2s)
   - Verify: guard auto-expires, subsequent `updateBoard` messages are processed normally

4. **`triggerAction` path (CLI mode):**
   - Enable CLI triggers, drag a card forward
   - The `triggerAction` path fires (no `moveCards` delta)
   - Verify: during the 350ms window, a file-watcher `updateBoard` doesn't cause a re-render
   - Verify: after the window expires, the guard clears and the board updates correctly

5. **`CODED_AUTO` branch:**
   - Drag a card to the synthetic CODED_AUTO column
   - During the 350ms window, trigger a file-watcher refresh
   - Verify: no spurious re-render, card stays in CODED_AUTO

6. **Multiple rapid drags (overlap):**
   - Drag card A, then immediately drag card B (within 350ms)
   - Verify: both cards move correctly; the second drag's optimistic state is NOT disrupted by A's `moveCards` delta (deadline re-armed by B's drop)
   - Verify: guard auto-clears ~2s after the last drag

7. **`moveCardsFailed` path:**
   - Trigger a move that fails (e.g. DB unavailable)
   - Verify: the revert `renderBoard` proceeds and shows the card back in its source column (guard does not need explicit clearing for this to work)

8. **Epic worktree update during guard (regression of the original draft's bug):**
   - During an optimistic drag, trigger an epic worktree change so `epicWorktreesChanged` is true mid-window
   - Verify: NO full re-render fires during the window; the dragged card keeps its optimistic position and styling
   - Verify: the worktree visual update appears after the window expires / on the next authoritative render

9. **Workspace/project switch during drag:**
   - Begin a drag, then switch workspace or project before the window expires
   - Verify: the newly selected workspace's board renders immediately (guard reset to inactive)

10. **Regression — normal board refresh:**
    - Without any drag in progress, trigger board refreshes (file watcher, manual refresh)
    - Verify: `updateBoard` handler works exactly as before (`Date.now() >= optimisticMoveUntil`, normal path)

---

**Recommendation**: Complexity 5 → **Send to Coder**

---

## Reviewer Pass (2026-06-26)

Direct in-place reviewer-executor pass against the implemented code in `src/webview/kanban.html`. Implementation found substantially complete and faithful to the **Adversarial Review Revisions (A–E)**; one MAJOR gap in Revision E was found and fixed in code.

### Stage 1 — Grumpy Principal Engineer

> *Adjusts monocle, exhales through nose.*
>
> So. You wrote an entire plan — a *beautiful* plan, mind you, with a timeline diagram and an edge-case table that could double as a wedding seating chart — explicitly naming **two** sites for the workspace-switch guard reset: "reassign-to-workspace" and "workspace-project-select change." Revision E. In writing. With line numbers.
>
> And then you implemented it at... the `updateColumns` handler. Which is *neither of those two things.* (**MAJOR**, `src/webview/kanban.html:6380`.) You walked into a room with two clearly labelled doors and went out the window.
>
> Here's why I'm not merely pedantic: I followed the wire. `selectWorkspace` in `KanbanProvider.ts:5152` calls `_refreshBoard` — which posts **`updateBoard`**, not `updateColumns`. So the dropdown — the *primary, user-facing workspace switcher* at `:6955` — clears `lastBoardSignature` at `:6966` but leaves `optimisticMoveUntil` armed. A user who starts a drag and then flicks the workspace dropdown within two seconds gets the new workspace's board **silently swallowed** by the very guard that was supposed to protect *the other* workspace's drag. The board you put the guard at (`updateColumns`) *already* calls `renderBoard` unconditionally — so the reset there is decorative. You guarded the door nobody uses and left the front gate open. (**MAJOR**.)
>
> The rest? Annoyingly competent, I'll grudgingly admit. The deadline approach is in. Both `setTimeout` race windows armed — CODED_AUTO at `:5788`, the `validIds` path at `:5970` — and the CODED_AUTO branch even has the decency to `return` at `:5824` so the two windows don't bleed into each other. The self-defeating `epicWorktreesChanged` re-render from the original Change #4 is properly throttled behind `!optimisticActive` in **both** branches (`:6244`, `:6261`) — good, because a full `renderBoard` mid-drag is exactly the arson this plan exists to prevent. You did NOT touch `moveCards`/`moveCardsFailed` (Revision C) — correct, and they still render from `currentCards` so the self-heal holds. No stuck-flag, no boolean residue.
>
> And then, because you cannot have nice things, the indentation at `:6380` was knocked seven columns out of true (**NIT**). It compiles. It also makes my eye twitch.
>
> Minor grumbles, filed for the record and *not* worth a line of code: the suppression branch recomputes `buildBoardSignature(currentCards)` at `:6253` when `nextBoardSignature` was already in hand at `:6230` (**NIT**, faithful to the plan text, leave it). And the 2000 ms window is a wager that the backend round-trip beats 1650 ms post-dispatch — lose that bet and you get a bounded ≤2 s flicker that self-heals on the next `moveCards`. You documented that residual, so I'll allow it. Begrudgingly.

### Stage 2 — Balanced Synthesis

**Keep (verified correct, no change):**
- Deadline declaration + window constant (`:3771–3772`) — Revision A. ✓
- Both arm sites after their `lastBoardSignature` sync (`:5788` CODED_AUTO, `:5970` main `validIds`) — Revision B; the two windows are mutually exclusive (CODED_AUTO `return` at `:5824`). ✓
- `updateBoard` suppression with `epicWorktreesChanged` gated behind `!optimisticActive` in both branches (`:6242`, `:6244`, `:6261`) — Revision D, the self-defeating-render fix. ✓
- `moveCards`/`moveCardsFailed` deliberately untouched (`:6173`, `:6192`) — Revision C; self-heal via render-from-`currentCards` confirmed. ✓
- COMPLETED immediate `completePlan` path left unguarded (`:5880`) — documented out-of-scope, correct. ✓

**Fix now (applied this pass):**
- **MAJOR — missing Revision-E guard reset at the workspace-project-select dropdown handler.** `selectWorkspace` → `_refreshBoard` → `updateBoard` (never `updateColumns`), so the dropdown switch (`:6964`) needed its own `optimisticMoveUntil = 0`. Added at `:6967`.
- **NIT — indentation at `:6380`** normalized to match surrounding block.

**Defer / accept (no action):**
- Redundant signature recompute at `:6253` — faithful to plan, negligible cost.
- ≤2 s self-healing flicker if backend round-trip exceeds ~1650 ms post-dispatch — documented residual.
- Extra guard reset retained at `updateColumns` (`:6380`) — not one of the two named sites, but harmless and arguably beneficial (a column-structure change should not be suppressed mid-drag); left in place rather than removed.

### Fixes Applied

| Severity | Location | Fix |
|----------|----------|-----|
| MAJOR | `src/webview/kanban.html:6967` | Added `optimisticMoveUntil = 0;` in the `workspace-project-select` change handler's `isDifferentWorkspace` branch (Revision E's second named site, previously missed). Confirmed via `KanbanProvider.ts:5152` that `selectWorkspace` emits `updateBoard`, not `updateColumns`, so the reset at `:6380` did not cover this path. |
| NIT | `src/webview/kanban.html:6380` | Normalized indentation of the `optimisticMoveUntil = 0;` line to match the surrounding block. |

### Files Changed
- `src/webview/kanban.html` — 1 line added (`:6967`), 1 line reindented (`:6380`).

### Validation
- **Compilation**: skipped per session directive (no `tsc`/build run). `dist/` is not used in dev/testing per CLAUDE.md; `src/` is source of truth.
- **Tests**: skipped per session directive (suite run separately by user).
- **Static review**: all guard sites enumerated and verified consistent — declaration (`:3771`), two arm sites (`:5788`, `:5970`), suppression handler (`:6242`), three workspace/project-switch resets (`:6380`, `:6910`, `:6967`). No `optimisticMoveInFlight`/`optimisticMoveTimeout` boolean residue remains. `moveCards`/`moveCardsFailed` confirmed untouched.
- Edits are additive single lines mirroring adjacent verified code; no structural/brace changes.

### Remaining Risks
- **COMPLETED/archive drop** (`:5880`) remains unguarded by design — transient data/DOM desync possible between the optimistic mutation and `completePlan` processing, self-healing on the post-archive `updateBoard`. Documented out-of-scope; optional follow-up only.
- **Window vs. round-trip**: if backend dispatch + DB write + `moveCards` exceeds the 2000 ms deadline, a stale `updateBoard` in the gap can cause a bounded ≤2 s flicker that self-heals on the next authoritative render. Accepted residual.
- **Manual verification still required**: scenarios 1–10 in the Verification Plan (esp. #6 overlapping drags, #8 epic-worktree-during-guard, #9 workspace-switch-during-drag — the last now exercised by the `:6967` fix) require a running webview and were not executed in this static pass.
