# Fix: ClickUp Hierarchy Vanishes on Startup in Tickets Tab

## Metadata

**Complexity:** 4
**Tags:** frontend, bugfix, ui

## Goal

The ClickUp Space/Folder/List dropdowns in the Tickets tab of `planning.js` lose their restored selections and rendered options on startup. Two race conditions in the webview message handling cause the hierarchy to be wiped or never restored. This plan fixes both races so that persisted ClickUp navigation state survives a panel reload.

## Problem Analysis

### Bug 1: Double `loadClickUpSpaces()` wipes restored hierarchy

**Trigger sequence:**

1. `switchToTab('tickets')` → `restoreTicketsState()` → `ticketsWorkspaceRoot` is null → sends `ticketsDefaultRoot`
2. `restoredTabState` arrives → restores `ticketsWorkspaceRoot` → `restoreTicketsStateForRoot()` sets `_restoringClickUpHierarchy = true`, calls `loadClickUpSpaces()` → **first restore chain begins** (spaces → folders → lists → project)
3. `restoredTabState` handler also sends `ticketsRootChanged` to backend
4. Backend responds with `integrationProviderStates`
5. `integrationProviderStates` handler (line ~4187) sees `ticketsAutoSync === true` → calls `loadClickUpSpaces()` **unconditionally** — no guard against an in-progress restore or already-loaded state
6. Second `clickupSpacesLoaded` arrives → wipes `clickUpAvailableFolders`, `clickUpAvailableListsInFolder`, `clickUpAvailableDirectLists` (line 3965-3967)
7. `_restoringClickUpHierarchy` is already `false` (first chain completed) → no re-restore → dropdowns render empty

**Root cause:** The `integrationProviderStates` autoSync branch lacks the `!ticketsLoadedOnce` guard that the non-autoSync branch has.

### Bug 2: `ticketsDefaultRoot` fires before `restoredTabState` — hierarchy IDs never restored

**Trigger sequence:**

1. `ticketsDefaultRoot` response arrives before `restoredTabState`
2. Handler calls `getRestoredState('tickets', root)` — but `_restoredPanelState.byRoot` is empty → returns `undefined`
3. Falls through to direct `loadClickUpSpaces()` without `restoreTicketsStateForRoot()` → no persisted space/folder/list IDs set
4. `restoredTabState` arrives → `ticketsWorkspaceRoot` already set → sends `ticketsRootChanged` but **skips** `restoreTicketsStateForRoot` (line 2867-2868)
5. Persisted hierarchy selections are permanently lost

**Root cause:** The `restoredTabState` handler only calls `restoreTicketsStateForRoot` when it's the one that set `ticketsWorkspaceRoot`. If `ticketsDefaultRoot` already set it, the restore is skipped.

## Implementation

### Fix A: Guard `integrationProviderStates` autoSync path

**File:** `src/webview/planning.js` (~line 4187)
**Change:** Add `_restoringClickUpHierarchy` and `ticketsLoadedOnce` guards to the autoSync branch, matching the pattern already used in `switchToTab` (line 698).

**Before:**
```js
if (ticketsAutoSync) {
    if (lastIntegrationProvider === 'clickup') loadClickUpSpaces();
    else loadLinearProject();
} else if (!ticketsLoadedOnce) {
    loadLocalTicketFiles();
}
```

**After:**
```js
if (ticketsAutoSync) {
    if (lastIntegrationProvider === 'clickup' && !_restoringClickUpHierarchy && !ticketsLoadedOnce) loadClickUpSpaces();
    else if (lastIntegrationProvider === 'linear' && !ticketsLoadedOnce) loadLinearProject();
} else if (!ticketsLoadedOnce) {
    loadLocalTicketFiles();
}
```

This prevents the second `loadClickUpSpaces()` from firing while the first restore chain is in progress or has already completed.

### Fix B: Deferred restore when `ticketsDefaultRoot` arrives before `restoredTabState`

**File:** `src/webview/planning.js`

**B1 — Add a pending-restore flag (near line 192, alongside other tickets state vars):**
```js
let _pendingTicketsRestore = false;
```

**B2 — Set flag in `ticketsDefaultRoot` handler (line ~4144-4148):**

When `getRestoredState` returns `undefined` because `restoredTabState` hasn't arrived yet, set `_pendingTicketsRestore = true` instead of immediately calling `loadClickUpSpaces()`.

**Before:**
```js
if (ticketsWorkspaceRoot) {
    const restoredState = getRestoredState('tickets', ticketsWorkspaceRoot);
    if (restoredState) {
        restoreTicketsStateForRoot(restoredState);
    } else {
        ticketsLoadedOnce = false;
        if (isTicketsTabActive()) {
            if (lastIntegrationProvider === 'clickup') {
                loadClickUpSpaces();
            } else if (lastIntegrationProvider === 'linear') {
                loadLinearProject();
            }
        }
    }
}
```

**After:**
```js
if (ticketsWorkspaceRoot) {
    const restoredState = getRestoredState('tickets', ticketsWorkspaceRoot);
    if (restoredState) {
        restoreTicketsStateForRoot(restoredState);
    } else {
        // restoredTabState hasn't arrived yet — defer until it does
        _pendingTicketsRestore = true;
    }
}
```

**B3 — Handle pending flag in `restoredTabState` handler (line ~2853-2868):**

When `ticketsWorkspaceRoot` is already set (by `ticketsDefaultRoot`), check `_pendingTicketsRestore` and call `restoreTicketsStateForRoot` before sending `ticketsRootChanged`.

**Before:**
```js
} else {
    vscode.postMessage({ type: 'ticketsRootChanged', workspaceRoot: ticketsWorkspaceRoot });
}
```

**After:**
```js
} else {
    if (_pendingTicketsRestore) {
        _pendingTicketsRestore = false;
        const restoredState = getRestoredState('tickets', ticketsWorkspaceRoot);
        if (restoredState) {
            restoreTicketsStateForRoot(restoredState);
        }
    }
    vscode.postMessage({ type: 'ticketsRootChanged', workspaceRoot: ticketsWorkspaceRoot });
}
```

**B4 — Reset flag in `resetTicketsInMemoryState` (line ~7658):**

Add `_pendingTicketsRestore = false;` alongside the other resets.

## Edge Cases

- **Both bugs fire simultaneously:** Fix A prevents the double-load; Fix B ensures the restore chain runs with correct IDs. The two fixes are independent and complementary.
- **No persisted state exists (first-time user):** `getRestoredState` returns `undefined` in both `ticketsDefaultRoot` and `restoredTabState`. `_pendingTicketsRestore` is set, then cleared when `restoredTabState` arrives with no state to restore. Falls through to `ticketsRootChanged` → `integrationProviderStates` → normal first-load flow. No regression.
- **User switches workspace roots:** `resetTicketsInMemoryState` clears `_pendingTicketsRestore` (B4), so stale flags don't bleed across roots.
- **`ticketsAutoSync` is false:** The autoSync branch is skipped entirely; the `!ticketsLoadedOnce` guard on the local-files path is unchanged. Fix A has no effect. Fix B still ensures hierarchy IDs are restored for manual refresh.
- **Linear provider:** Fix A adds a `!ticketsLoadedOnce` guard to the Linear autoSync path too, preventing an analogous double-fetch. Fix B is ClickUp-specific but the pattern could be extended if Linear has the same race (currently Linear uses a project picker, not a hierarchy chain, so the impact is lower).

## Verification

1. **Reproduce the original bug first:** Open Switchboard planning panel, select a ClickUp space/folder/list, close and reopen the panel. Confirm dropdowns are empty (bug present).
2. **Apply both fixes, rebuild the extension.**
3. **Test startup restore:** Close and reopen the panel. Confirm the Space/Folder/List dropdowns populate with the previously selected values and the task list loads.
4. **Test workspace switching:** Switch to a different workspace root in the tickets dropdown, then switch back. Confirm hierarchy restores correctly.
5. **Test first-time (no persisted state):** Clear persisted state for a root, open tickets tab. Confirm dropdowns load empty but are functional (no crash, no stuck loading).
6. **Test autoSync off:** Disable autoSync, repeat startup test. Confirm hierarchy IDs restore but tasks don't auto-load until manual refresh.
7. **Test Linear provider:** If Linear is configured, repeat startup test to confirm no regression from Fix A's Linear guard.

## Risks

- **Low:** Fix A could suppress a legitimate refresh if `ticketsLoadedOnce` is stale. However, `ticketsLoadedOnce` is reset to `false` in `resetTicketsInMemoryState` (workspace switch) and in the `ticketsDefaultRoot` no-state path. The only scenario where `ticketsLoadedOnce` stays `true` across a needed reload is a manual refresh — which uses `loadClickUpProject(true)` directly, not `loadClickUpSpaces()`. Safe.
- **Low:** Fix B introduces a new flag `_pendingTicketsRestore`. If `restoredTabState` never arrives (backend error), the flag stays `true` and the tab never loads. However, `restoredTabState` is sent unconditionally in the `fetchRoots` handler (`PlanningPanelProvider.ts:1491-1495`), so this only fails if the entire panel initialization fails — in which case nothing works anyway.

## Review Pass (2026-06-20)

### Stage 1: Grumpy Principal Engineer

> **Listen. I've been doing this since before your framework was a glint in npm's eye, and what I see here is a classic "fixed the race you thought about, created the race you didn't."**

**CRITICAL — Fix B2 broke first-time users on the Tickets tab.** `planning.js:4157` (original implementation). The plan's edge case analysis claims: "No persisted state exists → `_pendingTicketsRestore` is set, then cleared when `restoredTabState` arrives." **WRONG.** The webview sends `ticketsDefaultRoot` at line 722 (`switchToTab` during page init) BEFORE `fetchRoots` at line 8020. The backend processes both concurrently, but `fetchRoots` sends `restoredTabState` synchronously (line 1491 — no await before the `postMessage`), while `ticketsDefaultRoot` handler awaits `_getIntegrationWorkspaces()` (line 1561). So `restoredTabState` arrives at the webview FIRST. By the time `ticketsDefaultRoot` response arrives, `restoredTabState` has already been processed. `_pendingTicketsRestore = true` is set but the `restoredTabState` handler already ran — the flag is **permanently stuck** and `ticketsRootChanged` is never sent. The ClickUp hierarchy **never loads** for first-time users whose initial tab is Tickets. This is a worse bug than the one being fixed. The plan's own edge case analysis was based on a false assumption about message ordering.

**NIT — Plan's edge case analysis is inaccurate.** The "No persisted state" edge case claims `_pendingTicketsRestore` is "set, then cleared when `restoredTabState` arrives." This is only true in the narrow Bug 2 scenario where `ticketsDefaultRoot` response arrives before `restoredTabState` (which requires `_getIntegrationWorkspaces()` to be slower than `getAllStates()` — possible but not guaranteed). The common case is the reverse ordering, which the analysis didn't consider.

**NIT — `switchToTab` line 700-702 lacks `!_restoringClickUpHierarchy` guard.** Fix A added both `!_restoringClickUpHierarchy` and `!ticketsLoadedOnce` to `integrationProviderStates`. The `switchToTab` load path (line 699-705) only has `!ticketsLoadedOnce`. This is safe because `restoreTicketsStateForRoot` sets both flags together (line 7712-7713), so `ticketsLoadedOnce === true` whenever `_restoringClickUpHierarchy === true`. Belt-and-suspenders would be nicer but this is not a bug.

### Stage 2: Balanced Synthesis

| Finding | Severity | Action |
|:--------|:---------|:-------|
| Fix B2 stuck `_pendingTicketsRestore` breaks first-time load | CRITICAL | **Fix now** — distinguish "byRoot not yet populated" (defer) from "byRoot populated but no state for this root" (direct load) |
| Edge case analysis inaccuracy | NIT | **Fix now** — update plan to reflect actual message ordering |
| `switchToTab` missing `_restoringClickUpHierarchy` guard | NIT | **Defer** — `ticketsLoadedOnce` is sufficient, no race exists |

### Code Fix Applied

**File:** `src/webview/planning.js` — `ticketsDefaultRoot` handler (line ~4152-4171)

**Root cause:** The original Fix B2 unconditionally set `_pendingTicketsRestore = true` when `getRestoredState` returned `undefined`, assuming `restoredTabState` would arrive later to clear it. But `restoredTabState` almost always arrives BEFORE the `ticketsDefaultRoot` response (backend sends it synchronously during `fetchRoots`, while `ticketsDefaultRoot` response requires an `await`). The flag gets stuck and the hierarchy never loads.

**Fix:** Added a check on `Object.keys(_restoredPanelState.byRoot).length > 0` to distinguish:
- **byRoot already populated** (restoredTabState has arrived) → no state for this root → fall through to direct `loadClickUpSpaces()` / `loadLinearProject()` (preserves original first-time-user behavior)
- **byRoot empty** (restoredTabState hasn't arrived yet) → set `_pendingTicketsRestore = true` (deferred restore, the Bug 2 fix)

This preserves the Bug 2 fix (deferred restore when `restoredTabState` genuinely hasn't arrived) while restoring the first-time-user load path that the original Fix B2 inadvertently removed.

### Files Changed

- `src/webview/planning.js` — `ticketsDefaultRoot` handler (line ~4152-4171): three-way branch replacing the original two-way `else { _pendingTicketsRestore = true; }`

### Validation

- **Compilation:** Skipped per session instructions.
- **Tests:** Skipped per session instructions.
- **Manual trace verification:** All six startup scenarios traced through the message ordering:
  1. ✅ First-time user, initial tab = Tickets, `restoredTabState` arrives first → byRoot populated → direct load
  2. ✅ First-time user, initial tab ≠ Tickets → byRoot populated, tab not active → no immediate load → loads on tab visit via `switchToTab` line 699
  3. ✅ Returning user with persisted state, `restoredTabState` arrives first → `tickets.root` restored → `restoreTicketsStateForRoot` → `ticketsRootChanged` → `integrationProviderStates` → Fix A guards prevent double-load
  4. ✅ Bug 2 scenario: `ticketsDefaultRoot` response arrives before `restoredTabState` → byRoot empty → `_pendingTicketsRestore = true` → cleared by `restoredTabState` else branch → `ticketsRootChanged` → load
  5. ✅ Bug 1 scenario: double `loadClickUpSpaces()` → Fix A `!_restoringClickUpHierarchy && !ticketsLoadedOnce` guard prevents second wipe
  6. ✅ Workspace switch → `resetTicketsInMemoryState` clears all flags including `_pendingTicketsRestore`

### Remaining Risks

- **Low:** If `_getIntegrationWorkspaces()` in the `ticketsDefaultRoot` backend handler completes faster than `getAllStates()` + `postMessage('restoredTabState')` in `fetchRoots`, the `ticketsDefaultRoot` response could arrive before `restoredTabState`. In this case, `_pendingTicketsRestore = true` is set (byRoot empty), then cleared by `restoredTabState`'s else branch. This is the intended Bug 2 fix path and works correctly.
- **Low:** The `Object.keys(_restoredPanelState.byRoot).length > 0` check assumes `byRoot` is empty `{}` before `restoredTabState` arrives and has at least one key after. This is guaranteed by `PanelStateStore.getAllStates()` which always populates `byRoot[tabKey] = {}` for each tabKey (line 35), and the initialization at `planning.js:49` (`{ panel: {}, byRoot: {} }`).
