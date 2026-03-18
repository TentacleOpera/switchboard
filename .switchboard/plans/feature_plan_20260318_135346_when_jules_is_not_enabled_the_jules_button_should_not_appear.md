# when jules is not enabled the jules button should not appear

## Goal

When Jules is disabled in setup (the checkbox at `src/webview/implementation.html:1380`), the "Send selected plans to Jules" button in the Kanban PLAN REVIEWED column header should not appear. Currently the button renders unconditionally because the render-time check only tests `isPlanReviewed` and the post-render visibility function `updateJulesButtonVisibility()` is a no-op stub.

## Root Cause

1. **`src/webview/kanban.html:851`** — The Jules button is rendered whenever `isPlanReviewed` is true, with no guard on `lastVisibleAgents.jules`:
   ```js
   const julesBtn = isPlanReviewed
       ? `<button class="column-icon-btn" data-action="julesSelected" ...>` : '';
   ```
2. **`src/webview/kanban.html:996-998`** — `updateJulesButtonVisibility()` is an empty stub:
   ```js
   function updateJulesButtonVisibility() {
       // Jules button is now per-column in PLAN REVIEWED; visibility managed by renderColumns
   }
   ```
   This is called on the `visibleAgents` IPC message (line 1332) but does nothing, so toggling Jules in setup while the Kanban is open has no effect on the button.

The backend plumbing is already correct:
- Setup saves `visibleAgents.jules` to `.switchboard/state.json` (`TaskViewerProvider.ts:2933`)
- Provider notifies Kanban via `sendVisibleAgents()` → IPC `{ type: 'visibleAgents', agents }` (`KanbanProvider.ts:691-696`)
- Kanban merges into `lastVisibleAgents` (line 1330) and calls the stub

## Proposed Changes

### Change 1 — Guard render-time button creation  
**File:** `src/webview/kanban.html` · **Line 851**

```diff
- const julesBtn = isPlanReviewed
+ const julesBtn = (isPlanReviewed && lastVisibleAgents.jules !== false)
```

This prevents the button HTML from being emitted when Jules is disabled at initial render or on any subsequent `renderColumns()` call.

### Change 2 — Implement `updateJulesButtonVisibility()`  
**File:** `src/webview/kanban.html` · **Lines 996-998**

Replace the empty stub with a targeted DOM toggle so that when the `visibleAgents` IPC message arrives while the Kanban is already open, existing buttons are hidden/shown without a full re-render:

```js
function updateJulesButtonVisibility() {
    const visible = lastVisibleAgents.jules !== false;
    document.querySelectorAll('[data-action="julesSelected"]').forEach(btn => {
        btn.style.display = visible ? '' : 'none';
    });
}
```

**No backend changes required.** The IPC pipeline (`KanbanProvider.sendVisibleAgents` → `visibleAgents` message → `lastVisibleAgents` merge → `updateJulesButtonVisibility()`) is already wired up correctly; only the webview rendering is missing the check.

### Files touched

| File | Change |
|:---|:---|
| `src/webview/kanban.html:851` | Add `&& lastVisibleAgents.jules !== false` guard |
| `src/webview/kanban.html:996-998` | Implement `updateJulesButtonVisibility()` with DOM toggle |

## Complexity Audit

| Criterion | Assessment |
|:---|:---|
| **Band** | **A — Single-file conditional visibility** |
| Lines changed | ~5 net lines in one file |
| Cross-file coupling | None — backend IPC already sends the data |
| Risk | Very low — additive guard; no removal of existing logic |

## Edge-Case & Dependency Audit

| Scenario | Handling |
|:---|:---|
| Jules toggled while Kanban is open | `visibleAgents` IPC triggers `updateJulesButtonVisibility()` which toggles `display` on existing button(s). ✅ |
| Jules disabled before Kanban opens | `renderColumns()` reads `lastVisibleAgents` (populated on `visibleAgents` message sent during `resolveWebviewView`), so button is never emitted. ✅ |
| `lastVisibleAgents.jules` is `undefined` (fresh install) | `undefined !== false` evaluates to `true`, so button shows by default — matches current default-visible behavior and the `defaults` map at `KanbanProvider.ts:645`. ✅ |
| Backend check still guards dispatch | Even if a race condition somehow leaves the button visible, `KanbanProvider.ts:1288` checks `visibleAgents.jules === false` and shows a warning. ✅ (defense in depth) |
| Other columns | Jules button is only rendered for `isPlanReviewed` columns; no other columns affected. ✅ |

## Verification Plan

1. **Disable Jules in setup** → Open Kanban → Confirm the Jules icon button is absent from the PLAN REVIEWED column header.
2. **Enable Jules in setup** → Open Kanban → Confirm the Jules icon button is present and functional.
3. **Toggle while open**: With Kanban open, toggle Jules off in setup → button disappears without page reload. Toggle back on → button reappears.
4. **Fresh workspace** (no `state.json`): Kanban should show the Jules button by default (matches existing behavior).
5. **Build check**: Run `npm run compile` to ensure no TypeScript/webpack errors.

## Open Questions

- None — the fix is self-contained within the webview. The backend IPC and state persistence are already correct.

## Recommended Route

> **/accuracy** — Conditional visibility toggle. Band A single-file change with two surgical edits and straightforward manual verification.
