# Fix Stitch Project Load Screen Image Polling

## Goal

Fix the Stitch tab in the Design Panel so screens that initially load as `Rendering…` recover automatically without requiring the user to switch to another project and back.

### Problem Analysis

When a Stitch project is selected, `src/webview/design.js` sends `stitchGetProjectScreens` and `src/services/DesignPanelProvider.ts` handles it by calling `projectInstance.screens()`. Each screen is serialized through `_formatScreen()`, which calls `screen.getImage()` and `screen.getHtml()`. If the list response or follow-up `get_screen` response does not yet expose `screenshot.downloadUrl`, `_formatScreen()` returns `imageUrl: ""` and the webview renders a placeholder.

The current retry fix only works for a single `stitchScreenReady` path. It uses global state (`stitchReloadPending`, `stitchReloadRetries`, `stitchReloadTimer`) and does not start polling for all image-less screens returned by `stitchScreensReady`. As a result, a full project load can leave multiple cards permanently stuck on `Rendering…`, even though the images exist or become available moments later.

Switching away and back works because it triggers a fresh `stitchGetProjectScreens` request after time has passed. The fix should automate that recovery path: detect missing project-load images, poll each screen independently, update cards as images become available, and fall back to a bounded whole-project refresh when needed.

## Metadata

- **Complexity:** 6
- **Tags:** frontend, backend, bugfix, api, ui, ux, performance, reliability

## User Review Required

- [ ] Confirm desired polling limits for project-load missing screens: recommended 6 attempts per screen with 4s/8s/16s/32s capped backoff.
- [ ] Confirm whether project-load polling should be silent per card or show aggregate status text such as `Loading previews: 3 remaining…`.
- [ ] Confirm whether final exhausted state should keep the manual `Reload Screen` button visible on each unresolved card.

## Complexity Audit

### Routine

- Add per-screen retry bookkeeping in `src/webview/design.js`.
- Start background refreshes for screens with missing `imageUrl` after `stitchScreensReady`.
- Clear timers on project switch, workspace switch, preview close, generate/edit/variants/sync, and webview reload paths.
- Reuse existing `stitchRefreshScreen` host message and `_formatScreen()` response shape.

### Complex / Risky

- Avoid stale timers from an old project updating the newly selected project.
- Avoid turning transient image element load errors into unbounded API polling.
- Avoid global busy-state deadlocks while background card polling is active.
- Keep manual reload behavior predictable while background polling may also be running.
- Handle multiple missing screens concurrently without flooding the Stitch API.

## Edge-Case & Dependency Audit

- **Race Conditions:** A user can switch projects while per-screen timers are pending. Timers must be keyed by project id and screen id, and each callback must verify the currently selected project/workspace before posting `stitchRefreshScreen`.
- **API Load:** Polling every missing screen at once can create a request burst. Use a bounded concurrency strategy or stagger initial attempts slightly.
- **Security:** No new untrusted input surfaces. Existing image URLs continue to be assigned to `<img src>` under the webview CSP.
- **Side Effects:** `setStitchBusy(true)` should not be used for passive background polling, otherwise the user may be blocked from generating/editing while thumbnails recover.
- **Dependencies & Conflicts:** Builds on `stitch-reload-screen-fix.md`, which already added `status`, `statusMessage`, and single-screen retry logic. This plan supersedes its global retry-state limitations rather than reverting its behavior.

## Dependencies

- Existing Stitch provider message handlers:
  - `stitchGetProjectScreens`
  - `stitchRefreshScreen`
  - `stitchScreensReady`
  - `stitchScreenReady`
- Existing `_formatScreen()` fields:
  - `id`
  - `projectId`
  - `imageUrl`
  - `htmlUrl`
  - `status`
  - `statusMessage`

## Adversarial Synthesis

Key risks: (1) stale timers updating the wrong project after a switch unless every callback validates active workspace/project, (2) global `stitchReloadPending` mutex orphans all other missing screens when one is manually reloaded, (3) full-project refresh fallback needs a hard one-attempt cap or it becomes a slow infinite loop, (4) `renderStitchScreens` unconditionally re-opens the preview pane which collides with passive background polling, and (5) timers keep firing while the webview is hidden due to `retainContextWhenHidden`. Mitigations: key all polls by `${workspaceRoot}::${projectId}::${screenId}`, fully delete global reload state, add `projectRefreshAttempted` boolean, guard `openStitchPreview` during passive updates, and check `document.hidden` before posting refresh messages.

## Proposed Changes

### `src/webview/design.js`

#### Replace global reload state with per-screen polling state

- **Context:** Current state only supports one retry chain via `stitchReloadPending`, `stitchReloadRetries`, and `stitchReloadTimer`.
- **Logic:** Introduce a map keyed by `${workspaceRoot}::${projectId}::${screenId}` for background screen polling.
- **Implementation:** Add fields such as:
  - `stitchScreenPolls: new Map()` (do not persist through `vscode.setState()`)
  - `stitchProjectRefreshAttempted: false` (hard one-attempt cap for full-project fallback)
- **Edge Cases:** If plain object state is preferred for serialization safety, do not persist this field through `vscode.setState()`.

#### Add helper functions for polling lifecycle

Implement helpers with clear responsibilities:

- `getStitchScreenPollKey(projectId, screenId, workspaceRoot)`
- `clearStitchScreenPoll(projectId, screenId, workspaceRoot)`
- `clearAllStitchScreenPolls()`
- `scheduleStitchScreenPoll(screen, options)`
- `startMissingStitchScreenPolling(screens, reason)`
- `hasUsableStitchImage(screen)`

Rules:

- A screen is pollable when it has an id, belongs to the selected project, does not have `imageUrl`, and is not `FAILED`.
- Polling should use bounded exponential backoff: 4s, 8s, 16s, then 32s capped.
- Polling should stop when `imageUrl` appears or `status === 'FAILED'`.
- Polling should stop if the selected project or workspace changes.

#### Start polling after full project load

- **Context:** `case 'stitchScreensReady'` currently calls `renderStitchScreens(screens)` and sets a success count.
- **Logic:** After rendering, identify missing images and start per-screen polling.
- **Implementation:**
  1. Render the screens immediately so the user sees all cards.
  2. Call `startMissingStitchScreenPolling(screens, 'project-load')`.
  3. Set status to either:
     - `${screens.length} screens loaded`
     - or `${screens.length} screens loaded — waiting for ${missing.length} preview(s)`.
- **Edge Cases:** Do not mark the entire Stitch tab busy for background polling.

#### Update `stitchScreenReady` to resolve individual polls

- **Context:** Current handler uses global retry state and status messages.
- **Logic:** When a refreshed screen arrives, update only that screen, clear that screen's poll if resolved, or schedule its next poll if still pending.
- **Implementation:**
  1. Merge `msg.screen` into `state.stitchScreens`.
  2. Re-render cards or update the specific card.
  3. If `msg.screen.imageUrl`, clear that screen poll and show non-blocking status.
  4. If `msg.screen.status === 'FAILED'`, clear that screen poll and render failed placeholder.
  5. Otherwise, schedule the next attempt for that same screen.
- **Edge Cases:** If a manual reload is active for the preview screen, keep the existing direct user feedback, but do not let it corrupt background polls for other screens.

#### Add bounded whole-project refresh fallback

- **Context:** Switching projects fixes the issue because a full `stitchGetProjectScreens` eventually returns fresher screen metadata.
- **Logic:** If one or more screen polls exhaust attempts, perform one full project refresh for the active project instead of requiring manual project switching.
- **Implementation:**
  - Track whether a full-project refresh has been attempted with `stitchProjectRefreshAttempted` boolean.
  - After any screen poll exhausts its 6 attempts, if `!stitchProjectRefreshAttempted` and active project/workspace still match, set it to `true` and schedule a single debounced `stitchGetProjectScreens`.
  - Do not loop full-project refresh indefinitely; one attempt only.
- **Edge Cases:** Preserve `activePreviewScreenId` if the same screen still exists after the full refresh.

#### Improve image element error handling

- **Context:** Gallery thumbnail `img.onerror` currently replaces the image with a placeholder, and preview image `onerror` triggers the global reload path.
- **Logic:** Treat an image load error with a non-empty URL as a fresh-screen fetch trigger for that specific screen, not as a permanent rendering state.
- **Implementation:**
  - On thumbnail image error, replace with placeholder and call `scheduleStitchScreenPoll(screen, { reason: 'image-error', immediate: true })`.
  - On preview image error, hide image, show `Preview failed to load`, and schedule poll for that screen.
  - Add a guard so one broken URL does not cause infinite retries after max attempts.
- **Edge Cases:** Some image URLs may fail due to transient network/CSP issues even though metadata is correct. The manual reload button should remain visible after retry exhaustion.

#### Preserve manual reload UX

- **Context:** Users already have `Reload Screen` buttons in cards and preview placeholders.
- **Logic:** Manual reload should reset that screen's individual retry counter and request immediately.
- **Implementation:**
  - Replace manual reload's global state reset with `clearStitchScreenPoll(...)` followed by `scheduleStitchScreenPoll(..., { immediate: true, manual: true })`.
  - Manual reload may show busy/status text, but should not disable unrelated Stitch operations longer than the immediate request.
- **Edge Cases:** Double-clicking reload should not create duplicate timers for the same screen.

#### Cleanup on context changes

Call `clearAllStitchScreenPolls()` before or during:

- Project select `change`
- Workspace filter `change`
- `closeStitchPreview()` if preview-specific manual retry state exists
- `stitchGenerate`
- `stitchEdit`
- `stitchVariants`
- `stitchSyncProject`
- Any `stitchError` that applies to the current active polling operation

### `src/services/DesignPanelProvider.ts`

#### Keep provider API stable

- **Context:** The backend already exposes `stitchRefreshScreen` and `_formatScreen()` includes image/status fields.
- **Logic:** Prefer no provider change unless frontend polling reveals that `_formatScreen()` still returns stale data because `screen.getImage()` uses cached fields before calling `get_screen`.
- **Implementation:** Audit `_formatScreen()` and consider an optional `forceFresh` parameter only if needed.

Potential defensive improvement:

```typescript
private async _formatScreen(screen: any, forceFresh = false): Promise<any> {
    const target = forceFresh && screen.projectId && screen.id
        ? await (await loadStitch()).project(screen.projectId).getScreen(screen.id)
        : screen;
    return {
        id: target.id,
        projectId: target.projectId,
        name: target.data?.title || target.data?.displayName || target.id,
        deviceType: target.data?.deviceType,
        imageUrl: await target.getImage(),
        htmlUrl: await target.getHtml(),
        status: target.data?.screenMetadata?.status || null,
        statusMessage: target.data?.screenMetadata?.statusMessage || null
    };
}
```

Only add this if manual verification proves `stitchRefreshScreen` is not fresh enough. The existing handler already calls `project.getScreen(screenId)`, so frontend polling should be sufficient.

## Implementation Steps

1. **Introduce per-screen poll state** (`src/webview/design.js` ~line 59)
   - Remove `stitchReloadPending`, `stitchReloadRetries`, `stitchReloadTimer` from the `state` block.
   - Add `stitchScreenPolls: new Map()` (or plain object; do NOT persist through `vscode.setState()`).
   - Add `stitchProjectRefreshAttempted: false`.
   - Add helpers immediately after the state block (~line 1680):
     - `getStitchScreenPollKey(projectId, screenId, workspaceRoot)`
     - `clearStitchScreenPoll(projectId, screenId, workspaceRoot)`
     - `clearAllStitchScreenPolls()`
     - `scheduleStitchScreenPoll(screen, options)` — includes `document.hidden` guard before posting
     - `startMissingStitchScreenPolling(screens, reason)`
     - `hasUsableStitchImage(screen)`
   - Replace `clearStitchReloadTimer()` calls at project select (~line 2049), workspace filter change, preview close (~line 1874), generate (~line 2027), edit (~line 1822), variants (~line 1841), sync, and error paths with `clearAllStitchScreenPolls()`.

2. **Poll missing screens after project load** (`src/webview/design.js` ~line 2856)
   - In `case 'stitchScreensReady'`:
     1. Render screens immediately via `renderStitchScreens(screens)`.
     2. Call `startMissingStitchScreenPolling(screens, 'project-load')`.
     3. Set status to `"${screens.length} screens loaded"` or, if missing images exist, `"${screens.length} screens loaded — waiting for ${missing.length} preview(s)"`.
     4. Do NOT call `setStitchBusy(true)`.

3. **Refactor `stitchScreenReady` handling** (`src/webview/design.js` ~line 2864)
   - Replace the global `stitchReloadPending` / `stitchReloadRetries` logic with per-screen poll resolution.
   - Merge `msg.screen` into `state.stitchScreens` and re-render.
   - If `msg.screen.imageUrl` exists, call `clearStitchScreenPoll(...)` and set non-blocking status.
   - If `msg.screen.status === 'FAILED'`, clear poll and show failed state.
   - Otherwise, if this screen still has no image and is in `stitchScreenPolls`, schedule its next attempt with capped exponential backoff.
   - Do NOT call `setStitchBusy(false)` for passive background arrivals.

4. **Wire manual reload and image error paths into per-screen polling** (`src/webview/design.js` ~line 2151 and ~line 2176)
   - Card reload button (`makeThumbPlaceholder` → click handler): replace global-reset logic with `clearStitchScreenPoll(...)` then `scheduleStitchScreenPoll(screen, { immediate: true, manual: true })`.
   - Preview reload button (`openStitchPreview`): same pattern.
   - Thumbnail `img.onerror` (~line 2176): replace with placeholder + `scheduleStitchScreenPoll(screen, { reason: 'image-error', immediate: true })`. Add max-attempt guard so broken URLs don't loop forever.
   - Preview `img.onerror` (`openStitchPreview`): same pattern.

5. **Add full-project refresh fallback with one-attempt cap** (`src/webview/design.js`)
   - In `scheduleStitchScreenPoll`, when a screen exhausts its 6 attempts:
     1. If `!state.stitchProjectRefreshAttempted` and the active project/workspace still match, set `stitchProjectRefreshAttempted = true`.
     2. Post `stitchGetProjectScreens` for the current project (single debounced call).
     3. Do NOT schedule further per-screen polls for that screen.
   - On `stitchScreensReady` (new project load), reset `stitchProjectRefreshAttempted = false`.

6. **Guard passive updates from re-opening preview** (`src/webview/design.js` ~line 2101)
   - In `renderStitchScreens`, only call `openStitchPreview(activeScreen)` if `state.activePreviewScreenId` is truthy **and** the preview pane is currently visible. During passive background polling, update the screen data without forcing the preview pane open.

7. **Validate behavior manually**
   - Manually exercise project load with multiple missing thumbnails.

## Verification Plan

### Automated / Static Verification

- Search `src/webview/design.js` for any remaining uses of global `stitchReloadPending`, `stitchReloadRetries`, and `stitchReloadTimer`; confirm fully removed.
- Confirm every `scheduleStitchScreenPoll` callback validates `stitchProjectSelect.value` and `state.stitchWorkspaceRoot` before posting `stitchRefreshScreen`.
- Confirm `scheduleStitchScreenPoll` returns early (or defers) when `document.hidden` is `true`.
- Confirm `stitchProjectRefreshAttempted` is reset to `false` inside `stitchScreensReady` and never reset elsewhere.

### Manual Verification

1. Open the Design Panel and switch to the Stitch tab.
2. Select a project known to show some cards as `Rendering…` on first load.
3. Confirm all cards render immediately, with placeholders for missing previews.
4. Wait without switching projects.
5. Confirm missing thumbnails update as their images become available.
6. Confirm the status text truthfully indicates pending previews and does not show false success for unresolved screens.
7. Open a screen preview while other cards are still polling.
8. Confirm the active preview updates if its image becomes available.
9. Switch to another project while polling is active.
10. Confirm no old project's screens or timers update the new project's gallery.
11. Switch back to the original project and confirm the UI no longer depends on the switch workaround.
12. Trigger an image load failure if possible and confirm retry exhaustion leaves a manual reload affordance.

## Files Changed

Expected:

- `src/webview/design.js`

Possible but not preferred unless verification requires it:

- `src/services/DesignPanelProvider.ts`

## Risk Assessment

- **Medium risk.** The change touches asynchronous UI state, timers, and project/workspace scoping.
- **Primary risk:** stale timers updating the wrong project after a switch.
- **Mitigation:** key all polls by workspace/project/screen and validate active context before every request and response-driven retry.
- **Secondary risk:** excessive Stitch API calls when many screens are missing.
- **Mitigation:** bounded attempts, capped backoff, and optional staggered starts.

## Recommendation

Send to Coder with reviewer pass afterward. This is not a one-line fix; it changes the Stitch tab's async state machine and should be reviewed specifically for stale-timer and project-switch races.

## Review Findings

- **CRITICAL fixed:** `scheduleStitchScreenPoll` had `else { return; }` at line 1739 that killed ALL subsequent re-polls. When `stitchScreenReady` called `scheduleStitchScreenPoll(msg.screen)` with no options, the existing `pollInfo` matched, neither `manual` nor `hiddenRetry` was set, so it returned without scheduling the next attempt. Every screen got exactly one poll and then got stuck forever. Fixed by replacing `else { return; }` with `else if (pollInfo.timerId) { return; }` and adding `pollInfo.timerId = null` when the timer fires, so re-scheduling proceeds when the timer has fired but is blocked when an active timer already exists.
- **MAJOR fixed:** `document.hidden` path decremented `attempts` and re-called `scheduleStitchScreenPoll` every 1 second, creating an infinite loop while the tab was hidden (`attempts` oscillated 0→1→0→1… never reaching the max). Fixed by deferring via a 3-second timer that refunds the attempt and clears `timerId` before re-entering `scheduleStitchScreenPoll`.
- **MAJOR fixed:** `isScreenPollable` had a strict `screen.projectId === state.selectedStitchProjectId` check. If the Stitch SDK omitted `projectId` from screen objects (observed on `getScreen` responses), `isScreenPollable` returned `false` and polling never started for that screen. Fixed by accepting `!screen.projectId` as a valid match.
- **Validation:** No remaining references to removed globals (`stitchReloadPending`, `stitchReloadRetries`, `stitchReloadTimer`). `stitchProjectRefreshAttempted` resets only in `stitchScreensReady`. Timer callbacks validate active project/workspace before posting. All cleanup paths call `clearAllStitchScreenPolls()`.
- **Remaining risks:** Large projects with many missing screens may still burst the API at the first poll window. Consider adding a small stagger (e.g., `index * 500ms`) if load testing shows issues. Image URLs that fail after all retries leave cards in the manual-reload state, which is the intended UX.
