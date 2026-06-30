# Fix: Tickets Tab "New Ticket" Button Does Not Work

## Goal

### Problem
The "+ New Ticket" button on the Tickets tab in the Planning panel is permanently disabled (greyed out, unclickable) after opening the tab. The button was working previously but has regressed.

### Background Context
The Tickets tab integrates with ClickUp or Linear to display and create tickets. The "+ New Ticket" button opens a modal dialog (`create-ticket-modal`) that lets the user create a new ticket (or subtask). The button starts with the `disabled` attribute in the static HTML (`planning.html` line 3639) and must be programmatically enabled by `renderTicketsTab()` once the integration provider is known.

### Root Cause Analysis
The button enable/disable logic is driven by `renderTicketsTab()` (`planning.js` ~line 8228), which branches on `lastIntegrationProvider`:

- **Linear**: `renderTicketsLinearPanel()` always sets `createButton.disabled = false` (line 8259).
- **ClickUp**: `renderTicketsClickUpPanel()` only enables the button if `clickUpSelectedListId` is set (line 8728); otherwise disables with "Select a list first" (line 8731).
- **No provider**: `renderTicketsTab()` disables the button with "Configure an integration in Setup first" (line 8239).

The initialization flow on first tab visit is:

1. `switchToTab('tickets')` calls `initTicketsTab()` + `restoreTicketsState()`.
2. `restoreTicketsState()` sends an async `ticketsDefaultRoot` request to the backend.
3. At this point `lastIntegrationProvider` is still `null`, so `switchToTab` falls to the `else` branch and calls `renderTicketsTab()` → **disables** the button.
4. The backend eventually responds with `ticketsDefaultRoot` (or `integrationProviderStates`), which sets `lastIntegrationProvider` and triggers `loadLocalTicketFiles()`.
5. `loadLocalTicketFiles()` → backend responds with `localTicketFilesListed` → calls `renderTicketsTab()` → should **enable** the button.

**The race condition**: In step 4, when the `ticketsDefaultRoot` response arrives, if `restoredTabState` hasn't arrived yet, the handler sets `_pendingTicketsRestore = true` and does NOT call `loadLocalTicketFiles()` or `renderTicketsTab()`. The button stays disabled. The re-enable depends on `restoredTabState` arriving later, which sends `ticketsRootChanged` → `integrationProviderStates` → `loadLocalTicketFiles()` → `localTicketFilesListed` → `renderTicketsTab()`. If any link in this deferred chain fails or races (e.g., `integrationProviderStates` arrives but `ticketsLoadedOnce` is already `true` from a parallel path, skipping the load), the button is never re-enabled.

Additionally, the `integrationProviderStates` handler (line 5298) sets `lastIntegrationProvider` but does NOT call `renderTicketsTab()` directly — it only calls `loadLocalTicketFiles()` when `!ticketsLoadedOnce`. If `ticketsLoadedOnce` is already true (from a concurrent `localTicketFilesListed`), no render happens and the button state is never synced with the now-set provider.

## Metadata
- **Tags**: `bug`, `tickets-tab`, `planning-panel`, `ui`, `regression`, `race-condition`
- **Complexity**: 4/10
- **Files affected**: `src/webview/planning.js`

## Complexity Audit
**Routine.** The fix is adding `renderTicketsTab()` calls at two points in the async message handlers to ensure the button state is always synced when `lastIntegrationProvider` is set. No architectural changes, no new dependencies, no data migrations. The risk is low — `renderTicketsTab()` is idempotent and already called from many places.

## Edge-Case & Dependency Audit
- **ClickUp without list selected**: The button should remain disabled with "Select a list first" tooltip. The fix must not enable the button in this case — `renderTicketsClickUpPanel()` already handles this correctly.
- **No integration configured**: The button should remain disabled with "Configure an integration in Setup first". The fix must not enable the button when `lastIntegrationProvider` is null — `renderTicketsTab()` already handles this.
- **Tab not active**: `renderTicketsTab()` returns early if `!isTicketsTabActive()`. Calling it from the message handlers when the tab is not active is a no-op, which is safe.
- **Double-render**: `renderTicketsTab()` is already called from many handlers. Adding two more calls is safe — the function is idempotent and uses DOM guard comparisons (`_lastTickets*Html` caching) to avoid unnecessary DOM writes.
- **`ticketsLoadedOnce` already true**: The fix specifically addresses this edge case by calling `renderTicketsTab()` even when the load is skipped.

## Proposed Changes

### File: `src/webview/planning.js`

#### Change 1: Add `renderTicketsTab()` call in `ticketsDefaultRoot` handler after setting provider

In the `case 'ticketsDefaultRoot'` handler, after `lastIntegrationProvider` is set (line ~5265), add a `renderTicketsTab()` call to sync the button state immediately, regardless of whether the load is deferred.

**Current code** (~line 5263-5265):
```js
// Don't overwrite a provider preference already restored from saved state
if (!lastIntegrationProvider) {
    lastIntegrationProvider = msg.provider || null;
}
```

**Proposed code**:
```js
// Don't overwrite a provider preference already restored from saved state
const _providerWasNull = !lastIntegrationProvider;
if (!lastIntegrationProvider) {
    lastIntegrationProvider = msg.provider || null;
}
// Sync button state now that the provider is known — don't wait for the
// deferred load chain (which may not fire if _pendingTicketsRestore is set).
if (_providerWasNull && lastIntegrationProvider && isTicketsTabActive()) {
    renderTicketsTab();
}
```

#### Change 2: Add `renderTicketsTab()` call in `integrationProviderStates` handler after setting provider

In the `case 'integrationProviderStates'` handler, after `lastIntegrationProvider` is set (line ~5324), add a `renderTicketsTab()` call outside the `!ticketsLoadedOnce` guard, so the button state is synced even when the load is skipped.

**Current code** (~line 5322-5341):
```js
// Only set lastIntegrationProvider if not already restored from
// saved state — the backend's default ('clickup' when both are
// configured) should not overwrite the user's persisted preference.
if (!lastIntegrationProvider) {
    lastIntegrationProvider = msg.provider || null;
}
if (providerSelector && lastIntegrationProvider) {
    providerSelector.value = lastIntegrationProvider;
}
ticketsAutoSync = msg.ticketsAutoSync === true;
if (isTicketsTabActive() && lastIntegrationProvider && !ticketsLoadedOnce) {
    // ...load...
    loadLocalTicketFiles();
}
```

**Proposed code**:
```js
// Only set lastIntegrationProvider if not already restored from
// saved state — the backend's default ('clickup' when both are
// configured) should not overwrite the user's persisted preference.
const _providerWasNull = !lastIntegrationProvider;
if (!lastIntegrationProvider) {
    lastIntegrationProvider = msg.provider || null;
}
if (providerSelector && lastIntegrationProvider) {
    providerSelector.value = lastIntegrationProvider;
}
ticketsAutoSync = msg.ticketsAutoSync === true;
if (isTicketsTabActive() && lastIntegrationProvider && !ticketsLoadedOnce) {
    // ...load...
    loadLocalTicketFiles();
} else if (_providerWasNull && lastIntegrationProvider && isTicketsTabActive()) {
    // Provider was just determined but the load was skipped (ticketsLoadedOnce
    // already true, or another condition). Sync the button state so the
    // create button isn't left disabled from the initial null-provider render.
    renderTicketsTab();
}
```

#### Change 3 (defensive): Don't disable the button in `switchToTab` when provider is unknown

In `switchToTab('tickets')`, when `lastIntegrationProvider` is null on first visit, the `else` branch calls `renderTicketsTab()` which disables the button. This is premature — the provider hasn't been determined yet. Instead, skip the render entirely and let the async handlers enable/disable the button once the provider is known.

**Current code** (~line 1327-1335):
```js
if (lastIntegrationProvider && !ticketsLoadedOnce) {
    if (lastIntegrationProvider === 'clickup') loadClickUpSpaces();
    else if (lastIntegrationProvider === 'linear') loadLinearProject();
    loadLocalTicketFiles();
} else {
    renderTicketsTab();
}
```

**Proposed code**:
```js
if (lastIntegrationProvider && !ticketsLoadedOnce) {
    if (lastIntegrationProvider === 'clickup') loadClickUpSpaces();
    else if (lastIntegrationProvider === 'linear') loadLinearProject();
    loadLocalTicketFiles();
} else if (lastIntegrationProvider) {
    // Returning to the tab with data already loaded — re-render to sync UI.
    renderTicketsTab();
}
// If lastIntegrationProvider is null, DON'T render yet — the async
// initialization chain (ticketsDefaultRoot / integrationProviderStates)
// will set the provider and call renderTicketsTab() once it's known.
// Rendering now would prematurely disable the create button.
```

## Verification Plan

1. **Linear integration configured**:
   - Open the Planning panel → click the Tickets tab.
   - Verify the "+ New Ticket" button becomes enabled (not greyed out) within a second of the tab loading.
   - Click "+ New Ticket" → verify the "Create New Ticket" modal opens.
   - Fill in a title and click "Create" → verify the ticket is created and the modal closes.

2. **ClickUp integration configured, list previously selected**:
   - Open the Planning panel → click the Tickets tab.
   - Verify the "+ New Ticket" button becomes enabled after the hierarchy restores and the saved list is selected.
   - Click "+ New Ticket" → verify the modal opens.

3. **ClickUp integration configured, no list selected**:
   - Open the Tickets tab without a previously saved list selection.
   - Verify the button shows "Select a list first" tooltip and is disabled.
   - Select a Space → Folder → List from the Source modal.
   - Verify the button becomes enabled after selecting a list.

4. **No integration configured**:
   - Open the Tickets tab with no ClickUp or Linear integration set up.
   - Verify the button is disabled with "Configure an integration in Setup first" tooltip.

5. **Race condition timing**:
   - Close and reopen the Planning panel multiple times, immediately clicking the Tickets tab each time.
   - Verify the button always becomes enabled (for Linear) regardless of timing.

6. **Run existing tests**:
   - `npm test` — verify no regressions in existing ticket-related tests.
