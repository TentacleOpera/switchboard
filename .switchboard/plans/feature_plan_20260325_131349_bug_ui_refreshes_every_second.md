# BUG: UI Refreshes Every Second

## Goal
Eliminate the 1-second visual flickering on the Kanban board caused by `updateAutobanIndicators()` performing a full `innerHTML` rewrite of all autoban timer badges every second, and reduce redundant backend-to-webview `updateAutobanConfig` broadcasts by debouncing `_postAutobanState()`.

## User Review Required
> [!NOTE]
> The fix changes how autoban countdown badges are rendered (from full innerHTML replacement to targeted textContent updates) and adds a 2-second debounce to backend autoban state broadcasts. If you have custom CSS that relies on autoban badge elements being recreated every second (e.g., CSS animations triggered on DOM insertion), those animations will only fire on initial render or when a badge's active/inactive state changes — not every tick. The countdown text itself will still update every second, just without a full DOM teardown. Verify that your autoban badge styling still looks correct after applying this fix.

## Complexity Audit
### Routine
- Replacing `container.innerHTML = badges` with per-badge `textContent` updates in `updateAutobanIndicators()` — straightforward DOM diffing pattern
- Adding a debounce wrapper around `_postAutobanState()` — standard TypeScript timer pattern
- No new dependencies, no API changes, no configuration changes

### Complex / Risky
- **Badge element lifecycle management**: The new approach must handle badges being added/removed when autoban columns change (e.g., user edits column definitions while autoban is running). Must gracefully handle mismatched badge counts between DOM and `autobanColumns` array.
- **Debounce vs. dropped state**: If `_postAutobanState()` is debounced and the user toggles autoban off then immediately on, the "off" state might be swallowed. The debounce must use trailing-edge semantics so the *last* state always wins.
- **Timer cleanup**: `syncAutobanCountdownTimer()` must still correctly clear the interval when autoban is disabled, even if the disable message arrives during a debounce window.

## Edge-Case & Dependency Audit
- **Race Conditions:** The 1-second `setInterval` and incoming `updateAutobanConfig` messages can fire near-simultaneously. The current code already handles this safely because both paths call `updateAutobanIndicators()` synchronously on the UI thread — JavaScript's single-threaded event loop prevents true races. The debounce on the backend side is also safe because `setTimeout`/`clearTimeout` are synchronous operations. No race condition risk.
- **Security:** No security implications. All changes are purely cosmetic (DOM update strategy) and performance (debounce). No user input is processed differently. Badge content is already derived from trusted internal state (`autobanConfig`), not external input.
- **Side Effects:** The `updateAutobanButtonState()` call at the end of `updateAutobanIndicators()` will still fire every second, but it only touches a single button's `textContent`, `classList`, and `title` — negligible cost. The debounce on `_postAutobanState()` means sidebar and kanban webviews will see state updates up to 2 seconds late during rapid backend operations (e.g., bulk autoban ticks). This is acceptable because the countdown timer in the webview runs independently and doesn't depend on backend ticks for visual accuracy.
- **Dependencies & Conflicts:**
  - **feature_plan_20260311_085450** (add "move all" option): MEDIUM risk. If that plan adds new timer-driven UI updates, they should follow the same targeted-update pattern established here. No direct code conflict since it operates on card rendering, not autoban badges.
  - **feature_plan_20260312_053351** (remove MCP server polling): LOW risk. Touches `extension.ts` health-check timers, completely disjoint from kanban autoban timers and `TaskViewerProvider._postAutobanState()`.
  - **KanbanProvider.updateAutobanConfig()** (line 856): This method is the relay between backend and webview. It is NOT debounced — the debounce lives upstream in `_postAutobanState()`. This is intentional: if `updateAutobanConfig()` is called directly (e.g., during board refresh at line 471), it should still fire immediately.

## Adversarial Synthesis
### Grumpy Critique
Oh *wonderful*, another "just debounce it" fix from someone who read one Medium article about performance. Let me count the ways this could go sideways:

1. **You're building a mini virtual-DOM for timer badges.** You know what has a virtual DOM? React. You know what you're not using? React. Your "targeted update" approach maintains implicit state in the DOM itself — the existing badge elements become your source of truth for "what changed." What happens when the DOM gets out of sync with `autobanColumns`? Say someone opens column settings and adds a new autoban column while the timer is running. Your code will try to update badge N+1 that doesn't exist yet. Boom — silent failure, stale UI, confused user.

2. **2-second debounce is a magic number.** Why 2 seconds? Why not 1? Why not 5? You've provided zero justification for this value. If someone sets autoban intervals to 1 minute and has 6 columns, they could see 6 ticks fire in rapid succession — that's 6 calls to `_postAutobanState()` within milliseconds. Your 2-second debounce will collapse all 6 into one broadcast. But what if the first tick moves a card and the sixth tick finds the column empty and stops autoban? The webview won't see the intermediate states. Users will see cards vanish with no countdown animation.

3. **You're not fixing the actual architectural problem.** The real issue is that `updateAutobanIndicators()` is called from BOTH the 1-second timer AND the message handler. After your fix, the timer does targeted updates but the message handler calls the same function — which now ALSO does targeted updates even when a full rebuild would be correct (because the config actually changed). You need two code paths: one for tick-only updates (text changes) and one for config changes (structural rebuild).

### Balanced Response
Grumpy raises legitimate structural concerns. Here's how each is mitigated:

1. **DOM/column sync**: The implementation below handles this explicitly. On every tick, we compare `autobanColumns.length` against the number of existing badge elements. If they differ (column added/removed), we fall back to a full `innerHTML` rebuild. This is the correct hybrid approach — targeted updates for the 99% case (tick-only text changes), full rebuild for the 1% case (structural config changes). This is *not* a virtual DOM; it's a simple length check + `textContent` swap.

2. **Debounce value justification**: 2 seconds is chosen because: (a) the frontend countdown timer runs independently at 1-second intervals, so users see smooth countdowns regardless of backend broadcast frequency; (b) the minimum autoban interval is 1 minute, so a 2-second debounce is <3.3% of the shortest possible tick cycle; (c) it's long enough to collapse burst broadcasts (e.g., engine start fires `_postAutobanState()` once per column) but short enough that manual toggle actions feel responsive. The value could be tuned, but 2s is a defensible starting point.

3. **Two code paths**: Grumpy is right that config changes need a full rebuild. The implementation below uses a `forceRebuild` parameter. The message handler path (`case 'updateAutobanConfig'`) calls `updateAutobanIndicators(true)` to force a full rebuild when config changes. The 1-second timer calls `updateAutobanIndicators()` (no argument, defaults to `false`) for targeted text-only updates. This cleanly separates the two concerns.

## Proposed Changes

### Part 1: Targeted DOM Updates in Autoban Indicators
#### [MODIFY] `src/webview/kanban.html`

- **Context:** The `updateAutobanIndicators()` function (line 1762) is called every 1 second by `setInterval` (line 1239). It rebuilds ALL badge HTML as a string and assigns it to `container.innerHTML`, causing a full DOM teardown and rebuild. This triggers layout recalculation and causes visible flickering, especially when the user is interacting with cards or the sidebar.

- **Logic:**
  1. Add a `forceRebuild` boolean parameter (default `false`) to `updateAutobanIndicators()`.
  2. On each tick, compute the desired text and active state for each badge.
  3. If `forceRebuild` is `true` OR the number of existing badge children doesn't match `autobanColumns.length`, do a full `innerHTML` rebuild (current behavior — needed when columns change).
  4. Otherwise, iterate over existing badge `<span>` elements and update only `textContent` and `classList` if they differ from the computed values. This avoids DOM teardown entirely for the common case.
  5. Update the `case 'updateAutobanConfig'` message handler to call `updateAutobanIndicators(true)` so config changes always trigger a full structural rebuild.

- **Implementation:**

  Replace the `updateAutobanIndicators()` function (lines 1762–1788) with:

  ```javascript
  /** Update autoban timer badges inline in the controls strip. */
  function updateAutobanIndicators(forceRebuild) {
      const container = document.getElementById('autoban-timers-inline');
      if (!container) { updateAutobanButtonState(); return; }

      if (!autobanConfig || !autobanConfig.enabled) {
          if (container.innerHTML !== '') { container.innerHTML = ''; }
          updateAutobanButtonState();
          return;
      }

      // Compute desired state for each badge
      const badgeData = autobanColumns.map(col => {
          const abbrev = COLUMN_ABBREV[col] || col.charAt(0);
          const rule = autobanConfig.rules && autobanConfig.rules[col];
          if (rule && rule.enabled) {
              const lastTickAt = Number(autobanConfig.lastTickAt && autobanConfig.lastTickAt[col]) || Date.now();
              const intervalMs = Math.max(1, Number(rule.intervalMinutes) || 1) * 60 * 1000;
              const nextTickAt = lastTickAt + intervalMs;
              const remainingSec = Math.max(0, Math.ceil((nextTickAt - Date.now()) / 1000));
              const text = remainingSec > 0 ? `${abbrev}: ${formatCountdown(remainingSec)}` : `${abbrev}: GO`;
              return { text, active: true };
          } else {
              return { text: `${abbrev}: off`, active: false };
          }
      });

      const existingBadges = container.children;

      // Full rebuild when structure changes or forced (config update)
      if (forceRebuild || existingBadges.length !== badgeData.length) {
          container.innerHTML = badgeData.map(b =>
              `<span class="autoban-timer-badge${b.active ? ' is-active' : ''}">${b.text}</span>`
          ).join('');
          updateAutobanButtonState();
          return;
      }

      // Targeted update: only touch badges whose content or state changed
      for (let i = 0; i < badgeData.length; i++) {
          const el = existingBadges[i];
          const data = badgeData[i];
          if (el.textContent !== data.text) {
              el.textContent = data.text;
          }
          const hasActive = el.classList.contains('is-active');
          if (data.active !== hasActive) {
              el.classList.toggle('is-active', data.active);
          }
      }
      updateAutobanButtonState();
  }
  ```

  Update the `case 'updateAutobanConfig'` handler (lines 1694–1698) to force a rebuild:

  ```javascript
  case 'updateAutobanConfig':
      autobanConfig = msg.state || null;
      updateAutobanIndicators(true);
      syncAutobanCountdownTimer();
      updateAutobanButtonState();
      break;
  ```

- **Edge Cases Handled:**
  - **Columns added/removed while autoban is running**: The `existingBadges.length !== badgeData.length` check triggers a full rebuild, ensuring badges match the current column set.
  - **Autoban disabled**: The early return clears `innerHTML` only if it's not already empty, avoiding unnecessary DOM writes.
  - **Config change vs. tick update**: The `forceRebuild` parameter ensures config changes (from `updateAutobanConfig` messages) always do a structural rebuild, while 1-second timer ticks do targeted text updates.
  - **Container element missing**: The null check on `container` at the top safely falls through to `updateAutobanButtonState()` only.
  - **Badge text identical across ticks**: The `textContent` comparison skips DOM writes when the countdown text hasn't changed (e.g., during sub-second timer drift).

### Part 2: Debounce `_postAutobanState`
#### [MODIFY] `src/services/TaskViewerProvider.ts`

- **Context:** `_postAutobanState()` (line 2248) is called 14+ times across TaskViewerProvider — on engine start, engine stop, every column tick, config changes, workspace switches, etc. Each call sends `updateAutobanConfig` to both sidebar and kanban webviews, triggering `updateAutobanIndicators()` and `syncAutobanCountdownTimer()` in each. During autoban engine startup with 6 columns, this fires 6+ times within milliseconds. The debounce collapses these bursts into a single broadcast.

- **Logic:**
  1. Add a private `_postAutobanStateDebounceTimer: ReturnType<typeof setTimeout> | null = null` field.
  2. Rename the current `_postAutobanState()` to `_postAutobanStateImmediate()`.
  3. Create a new `_postAutobanState()` that clears any pending timer and sets a 2-second trailing-edge debounce that calls `_postAutobanStateImmediate()`.
  4. Add a `_postAutobanStateNow()` method that flushes any pending debounce and fires immediately — for use in critical paths like `dispose()` or explicit user-triggered actions where latency matters.
  5. Update `dispose()` to clear the debounce timer.

- **Implementation:**

  Add the debounce timer field alongside other timer fields (near the existing `_autobanTimers` declaration):

  ```typescript
  private _postAutobanStateDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  ```

  Replace the existing `_postAutobanState()` method (lines 2248–2256) with:

  ```typescript
  /**
   * Debounced broadcast of autoban state to sidebar and kanban webviews.
   * Collapses rapid successive calls (e.g., engine start, bulk ticks) into
   * a single broadcast. Uses trailing-edge: the last state always wins.
   */
  private _postAutobanState(): void {
      if (this._postAutobanStateDebounceTimer) {
          clearTimeout(this._postAutobanStateDebounceTimer);
      }
      this._postAutobanStateDebounceTimer = setTimeout(() => {
          this._postAutobanStateDebounceTimer = null;
          this._postAutobanStateImmediate();
      }, 2000);
  }

  /** Flush any pending debounced autoban state broadcast and fire immediately. */
  private _postAutobanStateNow(): void {
      if (this._postAutobanStateDebounceTimer) {
          clearTimeout(this._postAutobanStateDebounceTimer);
          this._postAutobanStateDebounceTimer = null;
      }
      this._postAutobanStateImmediate();
  }

  /** Actual broadcast implementation — sends state to both webviews. */
  private _postAutobanStateImmediate(): void {
      const state = this._getAutobanBroadcastState();
      this._view?.webview.postMessage({
          type: 'autobanStateSync',
          state
      });
      this._kanbanProvider?.updateAutobanConfig(state);
  }
  ```

  Update the following call sites to use `_postAutobanStateNow()` for user-initiated actions where immediate feedback matters:
  - **Toggle autoban on/off** (the handler for `toggleAutoban` messages): Change `this._postAutobanState()` to `this._postAutobanStateNow()` so the user sees immediate UI feedback when clicking the START/STOP button.
  - **`dispose()`**: Clear the debounce timer to prevent firing after disposal:
    ```typescript
    if (this._postAutobanStateDebounceTimer) {
        clearTimeout(this._postAutobanStateDebounceTimer);
        this._postAutobanStateDebounceTimer = null;
    }
    ```

  All other call sites (engine start, column ticks, safety sweep, workspace switches) remain on the debounced `_postAutobanState()` since they are backend-initiated and don't need sub-second UI feedback.

- **Edge Cases Handled:**
  - **Toggle off then immediately on**: Trailing-edge semantics ensure the final state (re-enabled) is the one broadcast. The webview's own `syncAutobanCountdownTimer()` handles timer start/stop based on whatever state arrives.
  - **Dispose during pending debounce**: The `dispose()` cleanup clears the timer, preventing a `postMessage` call on a disposed webview (which would throw).
  - **Direct `updateAutobanConfig()` calls in KanbanProvider**: Not affected by the debounce — `KanbanProvider.updateAutobanConfig()` at line 471 (board refresh) is called directly, not through `_postAutobanState()`. This is correct because board refresh needs immediate state sync.
  - **Sidebar `autobanStateSync` messages**: Also debounced via the same `_postAutobanState()` path, which is correct — the sidebar countdown display has the same tolerance for 2-second latency.

## Verification Plan
### Manual Testing
1. **Flickering eliminated**: Open the Kanban board with autoban enabled (at least 2 columns with rules). Observe that countdown badges update smoothly without any visible flickering or layout jumps. Try hovering over cards, dragging cards, and scrolling — interactions should feel smooth.
2. **Countdown accuracy**: Compare displayed countdown values against the actual configured interval. When a countdown reaches `00:00`, it should show `GO` briefly, then reset after the backend tick fires and broadcasts new state.
3. **Toggle responsiveness**: Click the START/STOP AUTOBAN button. The UI should reflect the new state within 1 second (using `_postAutobanStateNow()`), not delayed by 2 seconds.
4. **Column config change**: While autoban is running, change column definitions (add or remove an autoban-enabled column). Badges should rebuild correctly with the new column set.
5. **Autoban disabled state**: With autoban disabled, verify no timer badges are shown and no 1-second `setInterval` is running (check via browser DevTools > Sources > Event Listener Breakpoints > Timer > setInterval).
6. **Rapid engine restart**: Stop and immediately restart autoban. Verify that badge counts and countdown values are correct (no stale badges from the previous session).

### Automated Tests
- **Unit test for targeted DOM update**: Mock a container with N badge elements, call `updateAutobanIndicators()` twice with different countdown values, assert that `innerHTML` was NOT called (only `textContent` changed). Use a `MutationObserver` or spy on `innerHTML` setter.
- **Unit test for force rebuild**: Call `updateAutobanIndicators(true)` and assert that `innerHTML` IS set (full rebuild path).
- **Unit test for structural mismatch**: Start with 3 badges in DOM, change `autobanColumns` to 4 entries, call `updateAutobanIndicators()` without `forceRebuild`, assert that `innerHTML` is rebuilt (length mismatch triggers rebuild).
- **Unit test for debounce**: Call `_postAutobanState()` 5 times in rapid succession, advance timers by 2 seconds, assert that `_postAutobanStateImmediate()` was called exactly once.
- **Unit test for flush**: Call `_postAutobanState()` then immediately `_postAutobanStateNow()`, assert `_postAutobanStateImmediate()` was called exactly once (the debounced call was cancelled, the flush fired).

## POST-IMPLEMENTATION REVIEW (2026-03-25)

### Findings
**Part 1 (kanban.html)**: All 6 requirements were MISSING — implemented during review.
**Part 2 (TaskViewerProvider.ts)**: All 7 requirements were MISSING — implemented during review.

### Fixes Applied
1. **kanban.html** — Rewrote `updateAutobanIndicators()` with `forceRebuild` param, targeted `textContent`/`classList` updates, structural mismatch detection, and guarded `innerHTML = ''` for disabled state.
2. **kanban.html** — Updated `case 'updateAutobanConfig'` to call `updateAutobanIndicators(true)`.
3. **TaskViewerProvider.ts** — Added `_postAutobanStateDebounceTimer` field.
4. **TaskViewerProvider.ts** — Implemented debounced `_postAutobanState()` (2s trailing-edge), `_postAutobanStateNow()` (flush), and `_postAutobanStateImmediate()` (actual broadcast).
5. **TaskViewerProvider.ts** — User-triggered paths (`setAutobanEnabledFromKanban`, `setPairProgrammingEnabled`, sidebar `updateAutobanState`) use `_postAutobanStateNow()` for immediate feedback. All other call sites (ticks, engine start, safety sweep) use debounced `_postAutobanState()`.
6. **TaskViewerProvider.ts** — `dispose()` clears the debounce timer.

### Files Changed
- `src/webview/kanban.html`
- `src/services/TaskViewerProvider.ts`

### Validation: `npm run compile` ✅ | `npm run compile-tests` ✅
### Final Verdict: ✅ Ready
