# autoban needs countdown in ui

When the autoban is active, there is no timer in the kanban columns. it simply shows - autoban active 15 minutes (or something similar) so I don't know when the next autoban send will fire for each column. The simple time interval display needs to be replaced by a timer, like used to be the case under the old automated feature. 

## Goal
Replace the static "Auto: 15m (Batch: 3)" text in each kanban column's autoban status bar with a live countdown timer showing time until the next autoban tick fires. Format: `⚡ Next: 04:32 (Batch: 3)`. When the timer hits 00:00, it should reset to the full interval.

## Source Analysis

**Current display** in `src/webview/kanban.html` line ~1075:
```js
indicator.textContent = `Auto: ${rule.intervalMinutes}m (Batch: ${autobanConfig.batchSize})`;
```
This is a static string set by `updateAutobanIndicators()` whenever `updateAutobanConfig` messages arrive from the backend. There is no countdown logic.

**Backend timer** in `src/services/TaskViewerProvider.ts`:
- `_startAutobanEngine()` (~line 1212) creates `setInterval()` timers per column with `rule.intervalMinutes * 60 * 1000` ms.
- `_autobanTimers` Map stores the interval handles.
- There is **no** mechanism to communicate the "last tick time" or "next tick time" to the kanban webview.

**Autoban config state** type (`KanbanProvider.ts` line 12):
```ts
type AutobanConfigState = { enabled: boolean; batchSize: number; rules: Record<string, { enabled: boolean; intervalMinutes: number }> };
```
This type does **not** include `lastTickAt` or `nextTickAt` fields.

## Proposed Changes

### Step 1: Add `lastTickAt` to autoban state broadcast (Routine)
**File:** `src/services/TaskViewerProvider.ts`
- Add a `_autobanLastTickAt` Map<string, number> to track the epoch ms of each column's last tick.
- In `_enqueueAutobanTick()` / `_autobanTickColumn()`, after each tick completes, set `this._autobanLastTickAt.set(column, Date.now())`.
- In `_startAutobanEngine()`, set the initial `lastTickAt` to `Date.now()` for each enabled column (since an immediate tick fires).
- In `_stopAutobanEngine()`, clear the map.

### Step 2: Broadcast tick timestamps to kanban webview (Routine)
**File:** `src/services/TaskViewerProvider.ts` and `src/services/KanbanProvider.ts`
- Extend `AutobanConfigState` to include `lastTickAt?: Record<string, number>`.
- In `_postAutobanState()` (~line 1136), merge `_autobanLastTickAt` entries into the broadcasted state object.
- `KanbanProvider.updateAutobanConfig()` already relays this to the kanban webview — no change needed there.

### Step 3: Implement client-side countdown in kanban.html (Moderate)
**File:** `src/webview/kanban.html`
- In `updateAutobanIndicators()` (~line 1062), replace the static text with countdown calculation:
  ```js
  const lastTick = autobanConfig.lastTickAt?.[col] || Date.now();
  const intervalMs = rule.intervalMinutes * 60 * 1000;
  const nextTickAt = lastTick + intervalMs;
  const remainingSec = Math.max(0, Math.ceil((nextTickAt - Date.now()) / 1000));
  indicator.textContent = `Next: ${formatCountdown(remainingSec)} (Batch: ${autobanConfig.batchSize})`;
  ```
- Start a `setInterval(updateAutobanIndicators, 1000)` when autoban is enabled; clear it when disabled.
- The `formatCountdown()` helper already exists at line ~1055.
- When `remainingSec` hits 0, display "Dispatching..." briefly until the next `updateAutobanConfig` message arrives with a fresh `lastTickAt`.

### Step 4: Also broadcast after each tick completes (Routine)
**File:** `src/services/TaskViewerProvider.ts`
- After updating `_autobanLastTickAt` in the tick handler, call `this._postAutobanState()` so the kanban webview receives the updated timestamp promptly (rather than waiting for the next config change).

## Dependencies
- **Plan 1 (live feed logging):** Independent but related — both touch autoban engine internals. No file-level conflicts.
- No blocking dependencies on other plans.

## Verification Plan
1. Enable Autoban with CREATED column at 2-minute interval.
2. Observe the kanban CREATED column status bar shows a live countdown: `Next: 01:45 (Batch: 3)`.
3. Watch the countdown tick down every second.
4. When it reaches 00:00, confirm it briefly shows "Dispatching..." then resets.
5. Disable autoban — confirm the status bar clears.
6. Run `npm run compile` to verify no type errors.

## Complexity Audit

### Band A (Routine)
- Adding `_autobanLastTickAt` map and setting it on tick (~5 lines).
- Extending `AutobanConfigState` type (~1 line).
- Broadcasting updated state after tick (~1 line).

### Band B — Complex / Risky
- None.


## Adversarial Review

### Grumpy Critique
- "What happens when the user's machine sleeps? The countdown will be wrong when it wakes up." → Valid but minor. The next `updateAutobanConfig` broadcast (which fires after every tick) will resync the countdown. Acceptable drift.
- "setInterval(1000) in a webview — isn't that wasteful?" → Tolerable. It's a single interval updating a text node. Only active when autoban is enabled.
- "What if the backend tick takes 30 seconds to complete? The countdown shows 0 but nothing happens." → Show "Dispatching..." when remaining ≤ 0 instead of resetting to full interval.

### Balanced Synthesis
- The "Dispatching..." state handles the tick-duration gap gracefully.
- Sleep/wake drift is acceptable — self-corrects on next tick broadcast.
- Clear the 1-second interval when autoban is disabled to avoid unnecessary work.

## Agent Recommendation
Send it to the **Coder agent** — the backend changes are routine; the webview countdown is moderate but well-scoped with the existing `formatCountdown()` helper.

## Reviewer Pass Update

### Review Outcome
- Reviewer pass completed in-place against the implemented code.
- The implementation successfully added `lastTickAt` tracking, relayed countdown state into the Kanban webview, and rendered a live `Next: MM:SS` countdown with a `Dispatching...` fallback.
- One material defect remained in the state synchronization path: when the Kanban provider was attached after autoban was already running, `TaskViewerProvider` could seed it with the raw `_autobanState` object, which omitted the live `lastTickAt` map. In that case the board could reopen with an incorrect fresh countdown until the next backend tick broadcast arrived.

### Fixed Items
- Added a shared autoban-state broadcast helper so the countdown relay always includes `lastTickAt`.
- Updated `TaskViewerProvider.setKanbanProvider()` to seed the Kanban provider with the merged autoban broadcast state instead of the raw `_autobanState`.
- Updated `_postAutobanState()` and `_tryRestoreAutoban()` to use the same merged broadcast state path for consistency.
- Added a focused regression test covering autoban broadcast state merging.

### Files Changed During Reviewer Pass
- `src/services/autobanState.ts`
- `src/services/TaskViewerProvider.ts`
- `src/services/KanbanProvider.ts`
- `src/test/autoban-state-regression.test.js`

### Validation Results
- `npm run compile` ✅ Passed.
- `npm run compile-tests` ✅ Passed.
- `node src\test\autoban-state-regression.test.js` ✅ Passed.
- `npm run lint` was not rerun for this pass because repository linting remains blocked by the pre-existing ESLint 9 configuration issue (`eslint.config.*` missing).

### Remaining Risks
- The focused regression test validates the autoban broadcast merge logic, but there is still no browser-level end-to-end test that exercises the live Kanban countdown after reopening the panel mid-run.
- Repository linting remains unavailable until the ESLint configuration is migrated or restored for ESLint 9.

### Final Reviewer Assessment
- Ready. The countdown implementation now satisfies the plan requirements, and the live `lastTickAt` synchronization defect has been corrected and verified.
