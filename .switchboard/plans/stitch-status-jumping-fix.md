# Stitch Status Jumping Fix

## Goal

Fix the status indicator in the Stitch tab that jumps around unnecessarily, showing "Screen ready" or "Preview ready" messages even when screens already have images and no state change occurred.

## Metadata

- **Tags:** bugfix, frontend, ui
- **Complexity:** 3

## User Review Required

No — localized single-file change with clear manual test scenarios.

## Complexity Audit

### Routine
- Add helper function and conditional guard in one handler
- Reuse existing state comparison patterns

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** Multiple `stitchScreenReady` messages may arrive concurrently; conditional guard prevents flicker but `stitchScreenPolls.size` is checked after each `clearStitchScreenPoll`, keeping counts accurate.
- **Security:** None — client-side UI only.
- **Side Effects:** `clearStitchScreenPoll` and polling schedule remain inside the guarded block. Skipping the block for unchanged screens is safe because a screen with an existing image cannot be pollable (`isScreenPollable` requires `!screen.imageUrl`). In the unlikely event a poll exists for a screen that regains an identical image, the poll will expire naturally after 6 attempts.
- **Dependencies & Conflicts:** None.

## Dependencies

None.

## Adversarial Synthesis

Key risks: overly aggressive filtering could suppress legitimate status updates during rapid state transitions. Mitigation: compare `imageUrl`, `status`, and `statusMessage` to ensure any material change triggers the status. Polling clear logic stays inside the guard, so counters remain accurate.

## Problem

The teal status indicator in the top-right of the Stitch tab constantly updates with messages like "Screen ready" or "Preview ready — X still waiting" even when:
- Screens already have images loaded
- No actual state change occurred
- The user is just hovering or viewing the gallery

This creates visual noise and makes it unclear when actual meaningful events are happening.

## Background

### Current Behavior

The `stitchScreenReady` message handler in `src/webview/design.js` (lines 2983-3071) updates the status on **every** screen update:

```javascript
case 'stitchScreenReady': {
    // ... update state ...
    
    const hasImage = !!msg.screen.imageUrl;
    if (hasImage) {
        clearStitchScreenPoll(projectId, msg.screen.id, state.stitchWorkspaceRoot);
        if (state.stitchScreenPolls.size > 0) {
            setStitchStatus(`Preview ready — ${state.stitchScreenPolls.size} still waiting`, 'busy');
        } else {
            setStitchStatus('Screen ready', 'success');  // ← Fires even if screen already had image
        }
    }
    // ...
}
```

### Root Cause

The backend sends `stitchScreenReady` from multiple operations:
1. **Phase 3 of `stitchGetProjectScreens`** (line 1346 in DesignPanelProvider.ts) - sends new screens from API
2. **`stitchRefreshScreen`** (line 1431) - manual screen refresh
3. **`stitchGenerate`** (line 1835) - new screen generation
4. **`stitchEdit`** (line 1848) - screen editing

The webview handler doesn't check if the incoming screen data actually differs from the existing screen in `state.stitchScreens`. It unconditionally updates the status, causing the jumping behavior.

### Why This Happens

When a project loads:
1. Phase 1 serves screens from cache (with images)
2. Phase 2 fetches from API and updates DB
3. Phase 3 sends `stitchScreenReady` for each screen (even if identical to cached version)
4. Each `stitchScreenReady` call updates status to "Screen ready"
5. If multiple screens update in quick succession, status flickers between "Screen ready" and "Preview ready — X still waiting"

> **Clarification:** The backend code at `DesignPanelProvider.ts:1343` shows Phase 3 only sends `stitchScreenReady` for screens not present in the cache (`!cachedIds.has(s.id)`). The primary redundant sources are actually `stitchRefreshScreen`, `stitchGenerate`, and `stitchEdit`.

## Solution

Add state comparison logic to `stitchScreenReady` handler to only update status when meaningful state changes occur:

### Changes to Check

Only call `setStitchStatus` when:
1. **Image URL changed**: null → has image (new preview), or has image → null (unlikely but handle)
2. **Status changed**: e.g., rendering → failed, or any status transition
3. **Screen is new**: screen ID not in existing `state.stitchScreens`

If the screen already exists with the same image URL and status, skip status update entirely.

### Implementation

**File**: `src/webview/design.js`

In the `stitchScreenReady` handler (around line 2983):

1. Find existing screen in `state.stitchScreens` by ID
2. Compare `imageUrl` and `status` fields
3. Only execute status update logic if either:
   - Screen is new (not found in state)
   - Image URL changed
   - Status changed
4. Otherwise, update state silently without status change

## Implementation Plan

### Phase 1: Add State Comparison Helper

**File**: `src/webview/design.js`

Add helper function to detect meaningful screen changes:

```javascript
function hasScreenStateChanged(newScreen, existingScreen) {
    if (!existingScreen) return true; // New screen
    return newScreen.imageUrl !== existingScreen.imageUrl ||
           newScreen.status !== existingScreen.status;
}
```

### Phase 2: Update stitchScreenReady Handler

**File**: `src/webview/design.js`

Modify the `stitchScreenReady` case handler:

1. After updating `state.stitchScreens`, find the existing screen
2. Call `hasScreenStateChanged` to check if meaningful change occurred
3. Wrap status update logic in conditional guard
4. Keep state updates unconditional (always update screen data)

### Phase 3: Test Scenarios

1. **Load project with cached screens**: Status should show "X screens loaded" once, not flicker
2. **Generate new screen**: Status should show "Screen ready" when image arrives
3. **Edit existing screen**: Status should update only if image/status changes
4. **Manual screen refresh**: Status should update only if data changed
5. **Multiple screens polling**: Status should show "Preview ready — X still waiting" accurately without flicker

## Proposed Changes

### `src/webview/design.js`

**Context:** `stitchScreenReady` message handler (lines 2983-3071) and helper near polling utilities (~line 1718).

**Logic:** Introduce `hasScreenStateChanged(newScreen, existingScreen)` returning true when `existingScreen` is missing or when `imageUrl`, `status`, or `statusMessage` differ. In the handler, capture `existingScreen` before overwriting state. Only enter the `hasImage` / `isFailed` / `else` status branches when the helper returns true. State array updates and DOM surgical updates remain unconditional.

**Implementation:**

1. **Helper** (insert near `isScreenPollable`, ~line 1718):
```javascript
function hasScreenStateChanged(newScreen, existingScreen) {
    if (!existingScreen) return true;
    return newScreen.imageUrl !== existingScreen.imageUrl ||
           newScreen.status !== existingScreen.status ||
           newScreen.statusMessage !== existingScreen.statusMessage;
}
```

2. **Guarded handler** (lines 2983-3071):
   - After finding `existingIdx`, read `existingScreen` from `updatedScreens[existingIdx]`.
   - Update `updatedScreens` and `state.stitchScreens` unconditionally.
   - Perform DOM surgical update unconditionally (existing behavior).
   - Then evaluate `if (hasScreenStateChanged(msg.screen, existingScreen))` before the status/polling block.

**Edge Cases:**
- New screen → helper true, status updates.
- Refresh with identical data → helper false, status skipped, DOM still refreshed.
- Status changes to FAILED with same image → helper true, error shown.
- Image URL changes → helper true, "Screen ready" shown.
- `statusMessage` changes while `status` stays FAILED → helper true, status bar reflects new message.

## Verification Plan

### Automated Tests
Skipped per session directive. No compilation or automated test execution required.

### Manual Test Scenarios
1. **Load project with cached screens**: Status should show "X screens loaded" once, not flicker.
2. **Generate new screen**: Status should show "Screen ready" when image arrives.
3. **Edit existing screen**: Status should update only if image/status changes.
4. **Manual screen refresh**: Status should update only if data changed.
5. **Multiple screens polling**: Status should show "Preview ready — X still waiting" accurately without flicker.

## Files Changed

- `src/webview/design.js` - Add comparison helper and conditional status updates

## Validation

- [ ] Status no longer jumps when viewing screens with existing images
- [ ] Status still updates correctly for new screens
- [ ] Status still updates correctly for screen edits/generations
- [ ] Status still updates correctly for failed screens
- [ ] Polling status ("Preview ready — X still waiting") displays accurately

## Remaining Risks

- **Missed status updates**: If we're too conservative, users might not see important state changes. Mitigation: thorough testing of all screen operations.
- **Edge cases**: Screens with partial data (image but no status, or vice versa). Mitigation: comparison handles both fields independently.

## Review Findings

- **Files changed:** `src/webview/design.js` — removed 2 lines of dead code (`key` and `isPolling` variables at former line 3075-3076) that were orphaned by the branch restructuring.
- **Validation:** Code review only; no compilation or tests run per session directive.
- **Remaining risks:** `statusMessage` comparison in `hasScreenStateChanged` may trigger status updates on trivial backend message changes (e.g., progress text deltas), but this matches the plan specification.
- **Out-of-scope note:** Same commit also added an unrelated `btnForceReloadScreens` event listener; not reviewed as part of this plan.

**Recommendation:** Send to Intern
