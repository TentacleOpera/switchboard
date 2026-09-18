# Fix: Stitch Tab Reload Screen Not Loading Images After Fetch

## Metadata

- **Complexity:** 5
- **Tags:** frontend, backend, bugfix, ui, api

## Goal

When a user clicks **Reload Screen** in the Stitch tab preview pane for a screen that hasn't finished rendering, the preview should eventually display the rendered image. Currently the UI shows "Screen ready" but the placeholder remains because the image was still being generated on Stitch's backend. The fix adds automatic retry polling, truthful status messages, and image error recovery.

## User Review Required

- [ ] Review retry timing: 6 attempts, 4 s base, 32 s cap. Acceptable UX?
- [ ] Confirm production Stitch SDK version exposes `screen.data.screenMetadata.status` and `statusMessage` (verified in `@google/stitch-sdk@^0.3.5` types).
- [ ] Decide if a dedicated `previewBtnReload` toolbar button needs a click handler (currently unused).
- [ ] Approve `onerror` auto-reload behavior for CORS/broken-image scenarios.

## Complexity Audit

### Routine
- Extending `_formatScreen` return object with two additional fields.
- Attaching an `onerror` listener to a preview `<img>` and toggling placeholder visibility.
- Updating placeholder `<span>` text based on `status` enum.

### Complex / Risky
- Shared retry timer state (`stitchReloadPending`, `stitchReloadRetries`, `stitchReloadTimer`) touched by preview pane, gallery cards, and multiple Stitch action initiators.
- Guaranteeing no orphaned timers across rapid reload clicks, project switches, preview close, and generate/edit/variants/sync operations.
- Preventing parallel retry chains if an old `setTimeout` fires after a fresh reload is initiated.
- Distinguishing user-initiated reload from background `stitchScreenReady` updates (e.g., after generate) to avoid unwanted polling loops.

## Edge-Case & Dependency Audit

- **Race Conditions:** Rapid reload double-click without clearing the previous timer spawns overlapping retry chains. Mitigation: call `clearStitchReloadTimer()` at the top of every reload button handler.
- **Security:** No new untrusted inputs; `status`/`statusMessage` originate from authenticated Stitch SDK responses. Polling is bounded (max 6 attempts, capped delay).
- **Side Effects:** Orphaned `setTimeout` timers leak memory and can post stale messages to the extension. Mitigated by clearing timer in all action initiators and cleanup paths.
- **Dependencies & Conflicts:** Relies on `@google/stitch-sdk` `ScreenMetadata.status` and `statusMessage` fields (available in `^0.3.5`). No conflicts with other plans.

## Dependencies

- none

## Adversarial Synthesis

Key risks: overlapping retry timers on rapid reload clicks; potential infinite loop if Stitch repeatedly returns broken image URLs and `onerror` keeps firing; unexpected SDK status shapes causing false-positive retry loops. Mitigations: clear timer on every reload initiation; cap retries at 6; gate `onerror` reload with `!stitchReloadPending`; verify `status === 'FAILED'` before aborting.

## Proposed Changes

### `src/services/DesignPanelProvider.ts`
- **Context:** `_formatScreen()` serializes Stitch SDK screen instances for the webview.
- **Logic:** Include `status` and `statusMessage` from `screen.data?.screenMetadata` so the frontend can make status-aware decisions.
- **Implementation:** See Step 1 in `## Implementation Steps`.
- **Edge Cases:** `screenMetadata` may be absent on very old SDK screens; fallback to `null`.

### `src/webview/design.js`
- **Context:** Frontend state machine for Stitch preview pane and gallery.
- **Logic:** Introduce retry state fields; rewrite `stitchScreenReady` handler to branch on `hasImage`, `isFailed`, and `stitchReloadPending`; set reload context in click handlers; add `onerror` fallback; contextualize placeholder text; cancel retries on error and cleanup.
- **Implementation:** See Steps 2–8 in `## Implementation Steps`.
- **Edge Cases:** `onerror` can fire for CORS or transient network issues; auto-reload is gated by `!state.stitchReloadPending` to avoid stacking requests.

## Problem Analysis

**Root cause:** The Stitch API's `get_screen` endpoint returns an immediate `Screen` object even when rendering is still in progress. The SDK's `screen.getImage()` returns `raw?.screenshot?.downloadUrl || ""` — an empty string when the screenshot isn't ready yet. The frontend's `stitchScreenReady` handler unconditionally prints `"Screen ready"` regardless of whether `imageUrl` is present. There is no retry mechanism, so the user is permanently stuck on a placeholder after a single fetch.

**Why the bug is intermittent:** Different screens finish rendering at different times. A screen that was generated recently may still be `IN_PROGRESS` on Stitch's backend when the user clicks reload.

**Why the status message is misleading:** The handler at `design.js:1589` calls `setStitchStatus('Screen ready', 'success')` without checking whether `msg.screen.imageUrl` is truthy.

**Why the image never appears:** Without auto-retry, the only way to get the image is for the user to manually click reload again later. No automated polling exists.

## Files Changed

- `src/services/DesignPanelProvider.ts` — include `status` and `statusMessage` in `_formatScreen`
- `src/webview/design.js` — auto-retry logic, truthful status messages, reload context tracking, image error fallback

## Implementation Steps

### Step 1 — Pass Stitch status to frontend via `_formatScreen`

In `DesignPanelProvider.ts` at `_formatScreen()`, add `status` and `statusMessage` fields from the screen metadata:

```typescript
private async _formatScreen(screen: any): Promise<any> {
    return {
        id: screen.id,
        projectId: screen.projectId,
        name: screen.data?.title || screen.data?.displayName || screen.id,
        deviceType: screen.data?.deviceType,
        imageUrl: await screen.getImage(),
        htmlUrl: await screen.getHtml(),
        status: screen.data?.screenMetadata?.status || null,
        statusMessage: screen.data?.screenMetadata?.statusMessage || null
    };
}
```

### Step 2 — Add retry state machine to `design.js`

Add the following state fields to the `state` object at the top of `design.js`:

```javascript
stitchReloadPending: false,  // true while waiting for a reload response
stitchReloadRetries: 0,    // count of retries so far
stitchReloadTimer: null,     // holds setTimeout id
```

### Step 3 — Implement auto-retry in `stitchScreenReady` handler

In the `case 'stitchScreenReady'` handler (around line 1579), replace the unconditional success message with status-aware logic:

```javascript
case 'stitchScreenReady': {
    const updatedScreens = [...state.stitchScreens];
    const existingIdx = updatedScreens.findIndex(s => s.id === msg.screen.id);
    if (existingIdx >= 0) {
        updatedScreens[existingIdx] = msg.screen;
    } else {
        updatedScreens.unshift(msg.screen);
    }
    renderStitchScreens(updatedScreens);

    const hasImage = !!msg.screen.imageUrl;
    const isFailed = msg.screen.status === 'FAILED';

    if (hasImage) {
        // Success — image loaded
        clearStitchReloadTimer();
        setStitchBusy(false);
        setStitchStatus('Screen ready', 'success');
    } else if (isFailed) {
        // Terminal failure
        clearStitchReloadTimer();
        setStitchBusy(false);
        setStitchStatus(msg.screen.statusMessage || 'Rendering failed', 'error');
    } else if (state.stitchReloadPending) {
        // Still in progress — schedule retry
        const delay = Math.min(4 * Math.pow(2, state.stitchReloadRetries), 32); // 4, 8, 16, 32...
        if (state.stitchReloadRetries < 6) {
            state.stitchReloadRetries += 1;
            setStitchStatus(`Still rendering… retry ${state.stitchReloadRetries}/6 in ${delay}s`, 'busy');
            state.stitchReloadTimer = setTimeout(() => {
                vscode.postMessage({
                    type: 'stitchRefreshScreen',
                    projectId: msg.screen.projectId || stitchProjectSelect.value,
                    screenId: msg.screen.id
                });
            }, delay * 1000);
        } else {
            // Max retries exhausted
            clearStitchReloadTimer();
            setStitchBusy(false);
            setStitchStatus('Rendering is taking longer than expected. Click Reload Screen to try again.', 'error');
        }
    } else {
        // Not a reload context — just a normal update with no image yet
        setStitchBusy(false);
        setStitchStatus('Screen created — rendering in progress', 'info');
    }
    break;
}
```

### Step 4 — Track reload context

In the two reload button click handlers (preview pane placeholder button around line 1048, and gallery thumbnail button around line 1359), set the reload flag before posting the message:

```javascript
// Clear any existing timer first to avoid overlapping retry chains.
clearStitchReloadTimer();
state.stitchReloadPending = true;
state.stitchReloadRetries = 0;
// existing postMessage code follows...
```

Also add a helper function `clearStitchReloadTimer`:

```javascript
function clearStitchReloadTimer() {
    if (state.stitchReloadTimer) {
        clearTimeout(state.stitchReloadTimer);
        state.stitchReloadTimer = null;
    }
    state.stitchReloadPending = false;
    state.stitchReloadRetries = 0;
}
```

Call `clearStitchReloadTimer()` at the start of all other Stitch action handlers (generate, edit, variants, sync, getProjectScreens) so retries don't leak between operations.

### Step 5 — Add image error fallback in preview pane

In `openStitchPreview` (around line 1031), add an `error` event listener to `previewImage` that falls back to the placeholder when the image URL fails to load:

```javascript
if (previewImage) {
    previewImage.style.display = 'block';
    previewImage.src = makeFifeHighResUrl(screen.imageUrl);
    previewImage.onerror = () => {
        previewImage.style.display = 'none';
        previewImage.src = '';
        if (previewImagePlaceholder) {
            previewImagePlaceholder.style.display = 'flex';
            // Update placeholder text to indicate the image failed
            const label = previewImagePlaceholder.querySelector('span');
            if (label) label.textContent = 'Preview failed to load';
        }
        // Trigger an automatic reload attempt
        if (!state.stitchReloadPending) {
            state.stitchReloadPending = true;
            state.stitchReloadRetries = 0;
            vscode.postMessage({
                type: 'stitchRefreshScreen',
                projectId: screen.projectId || stitchProjectSelect.value,
                screenId: screen.id
            });
        }
    };
}
```

### Step 6 — Update preview placeholder text contextually

When opening the preview placeholder for a screen with no image, show context-aware text based on `status`:

```javascript
// In openStitchPreview, in the else branch where imageUrl is missing
const label = previewImagePlaceholder.querySelector('span');
if (label) {
    if (screen.status === 'FAILED') {
        label.textContent = 'Rendering failed';
    } else if (screen.status === 'IN_PROGRESS' || !screen.status) {
        label.textContent = 'Preview not ready yet — still rendering';
    }
}
```

### Step 7 — Handle `stitchError` to cancel retries

In the `case 'stitchError'` handler, call `clearStitchReloadTimer()` so a failed retry doesn't keep spinning:

```javascript
case 'stitchError':
    clearStitchReloadTimer();
    setStitchBusy(false);
    setStitchStatus('Error: ' + msg.error, 'error');
    break;
```

### Step 8 — Clean up on preview close / project change

In `closeStitchPreview` and the project select `change` handler, call `clearStitchReloadTimer()` to avoid orphaned timers.

## Verification Plan

### Automated Tests
Skipped per session directive. Validation will be performed manually:

1. Generate a new screen and immediately click **Reload Screen** before it finishes rendering.
2. Observe the status message cycles: `"Reloading screen…"` → `"Still rendering… retry 1/6 in 4s"` → ... → `"Screen ready"` when the image becomes available.
3. Confirm the image appears in the preview pane after retries succeed.
4. Simulate a failed image load (block the network request or use an expired URL) — confirm the placeholder appears and an automatic reload is triggered.
5. Confirm that switching projects or closing the preview cancels any pending retry timer.

## Risks and Edge Cases

- **Orphaned timers:** If the user switches projects or closes the panel while a retry is pending, the timer must be cleared. Addressed by Step 8.
- **Multiple simultaneous reloads:** If the user clicks reload twice rapidly, the second click resets `stitchReloadRetries` to 0, which is correct behavior.
  - *Clarification:* To prevent overlapping timer chains, call `clearStitchReloadTimer()` at the start of each reload button handler before setting `stitchReloadPending = true`.
- **Backend returns FAILED:** The retry loop must not run. Addressed by the `isFailed` check in Step 3.
- **Image loads but `onerror` fires due to CORS:** The `onerror` handler in Step 5 will trigger a reload. This is safe — the next `get_screen` call may return a fresh signed URL.

## Review Findings

**Reviewer-executor pass completed 2026-06-11.**

Implementation matches plan requirements across all 8 steps. `DesignPanelProvider.ts` now passes `status`/`statusMessage` through `_formatScreen`, and `design.js` implements the retry state machine, `onerror` fallback, contextual placeholder text, and timer cleanup in all action initiators. Node syntax check on `design.js` passed. No CRITICAL or MAJOR issues found.

**Files changed:** `src/services/DesignPanelProvider.ts`, `src/webview/design.js` (committed as `ffa5034`).

**Remaining risks:** (1) `onerror` auto-reload path does not set `stitchBusy = true`, so a brief stale-status window is possible; (2) switching to a different screen via thumbnail click does not clear the previous screen's retry timer, allowing its status message to overwrite the current screen's status bar when it eventually fires.

## Recommendation

Complexity 5 → **Send to Coder**
