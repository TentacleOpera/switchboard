# Fix Online Docs Tab Empty Regression

## Goal
Restore the Online Docs tab functionality by ensuring adapter registration is guaranteed before the webview processes `fetchRoots`, fixing the regression where the tab shows "No online sources available" instead of ClickUp/Linear/Notion documents.

## Metadata
- **Tags:** [bugfix, frontend]
- **Complexity:** 3

## User Review Required
- Verify that the Online Docs tab shows configured sources (ClickUp/Linear/Notion) after the fix
- Confirm no regression in other message handlers (submitComment, fetchChildren, etc.)

## Complexity Audit

### Routine
- Single-line addition to `_handleMessage()` calling existing method with robust guards
- Updating a stale code comment to match new reality
- The `_ensureAdaptersRegistered()` method is already idempotent with double-guard (roots-key + available-sources check)

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** The current `_ensureAdaptersRegistered()` is fully synchronous — `clearAdapters()` and the re-registration loop execute atomically within a single Node.js tick. No interleaving is possible. The stale comment at line 80-82 warning about race conditions predates the guard improvements and is no longer accurate.
- **Security:** No security implications — adapter registration is an internal operation with no external input handling.
- **Side Effects:** Calling `_ensureAdaptersRegistered()` on every message adds trivial overhead (guard returns early in 99%+ of calls: `_getWorkspaceRoots()` + `JSON.stringify()` + `getAvailableSources()`). No functional side effects since the method is idempotent.
- **Dependencies & Conflicts:** The `_ensureAdaptersRegistered()` method was significantly refactored from the old version (bak3). The old method took a `workspaceRoot` parameter and used a simple `_registeredRoot` guard with no `clearAdapters()`. The current method is parameterless, multi-root, and calls `clearAdapters()` before re-registration when roots change. This is NOT a simple "restore old behavior" — the semantics differ, but the current guards make it safe for the `_handleMessage()` context.

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) The existing comment at lines 80-82 explicitly warns against calling `_ensureAdaptersRegistered()` from `_handleMessage()`, which contradicts the fix — this stale comment must be updated to avoid confusing future developers. (2) The `clearAdapters()` call in the current method differs from the old method's behavior (old method never cleared), but the Node.js single-threaded model guarantees atomicity. Mitigations: Update the comment; the double-guard (roots-key + available-sources) makes the method safe for repeated calls.

## Problem
The Online Docs tab in planning.html shows "No online sources available" instead of displaying ClickUp/Linear/Notion documents. This is a critical regression that broke recently.

## Root Cause
During a refactoring of `PlanningPanelProvider.ts`, the call to `_ensureAdaptersRegistered()` was removed from the `_handleMessage()` method.

**Old behavior (working):**
- `_ensureAdaptersRegistered(workspaceRoot)` was called in `_handleMessage()` before processing any message
- This guaranteed adapters were registered when the webview sent `fetchRoots`

**Current behavior (broken):**
- `_ensureAdaptersRegistered()` is only called during panel initialization (line 270) and workspace folder changes (line 292)
- Not called in `_handleMessage()` anymore
- Race condition: webview sends `fetchRoots` immediately on load, but adapters may not be registered yet
- Result: `_sendOnlineDocsReady()` returns empty roots array → "No online sources available"

**Specific failure scenario:** When the panel is revealed (already exists), `open()` returns early at line 227-228 without calling `_ensureAdaptersRegistered()`. If adapters were previously lost (e.g., `clearAdapters()` called during workspace folder change, then adapter factories returned undefined for new roots), the webview's `fetchRoots` message finds no adapters registered.

## Evidence
- Comparison with `PlanningPanelProvider.ts.bak3` shows the old implementation
- Line 206 in bak3: `this._ensureAdaptersRegistered(workspaceRoot);` in `_handleMessage()`
- Current version: no such call in `_handleMessage()`
- Current version only calls it at line 270 (panel open) and line 292 (workspace folder change)
- Comment at line 80-82 warns against calling from `_handleMessage()`, but this warning predates the guard improvements and is stale

## Solution
Restore the adapter registration call in `_handleMessage()` to ensure adapters are available before processing any webview message, and update the stale warning comment.

### `src/services/PlanningPanelProvider.ts`

**Change 1: Update stale comment on `_ensureAdaptersRegistered()` (lines 80-82)**

Context: The existing comment warns against calling from `_handleMessage()`, but the method's double-guard (roots-key + available-sources check) now makes this safe. The comment must be updated to avoid contradicting the fix.

```typescript
// Ensure adapters are registered for current workspace roots.
// Safe to call from any context — the double-guard (roots-key + available-sources check)
// makes this idempotent and avoids redundant clearAdapters() calls.
private _ensureAdaptersRegistered(): void {
```

**Change 2: Add `this._ensureAdaptersRegistered();` in `_handleMessage()` before the switch statement (line 540)**

Context: This restores the safety net that guarantees adapters are registered before any webview message is processed. The method's guard returns early if adapters are already registered, making this a no-op in the common case.

```typescript
private async _handleMessage(msg: any): Promise<void> {
    const allRoots = this._getWorkspaceRoots();
    if (allRoots.length === 0) {
        this._panel?.webview.postMessage({ type: 'error', message: 'No workspace open' });
        return;
    }

    // Use active workspace root if available, otherwise use first root
    const workspaceRoot = this._getWorkspaceRoot() || allRoots[0];

    // Ensure adapters are registered before processing any message
    this._ensureAdaptersRegistered();

    switch (msg.type) {
        case 'fetchRoots': {
            // ... rest of switch statement
```

## Verification Plan

### Automated Tests
- No automated tests for this specific regression (webview message handling is difficult to unit test in isolation)

### Manual Verification
1. Open planning panel
2. Switch to Online Docs tab
3. Verify ClickUp/Linear/Notion sources appear (if configured)
4. Close panel, reopen — verify sources still appear (tests panel reveal path)
5. Check browser console for log messages:
   - `[PlanningPanel] Adapters already registered for roots: [...]` (guard returning early — expected on most messages)
   - `[PlanningPanel] Registering adapters for roots: [...]` (only on first call or roots change)
   - `[PlanningPanel] Available sources at fetchRoots: [...]` should show non-empty array
6. Verify other message handlers still work (submit a review comment, fetch children, etc.)

## Risk Assessment
- **Risk:** Low — the method is idempotent with robust guards, and this restores a safety net that existed in the working version
- **Impact:** Minimal — single line addition + comment update, no API changes
- **Side effects:** None — the double-guard makes the method safe to call repeatedly; `clearAdapters()` is only invoked when roots actually change, and re-registration is atomic

## Recommendation
Complexity 3 → **Send to Intern**
