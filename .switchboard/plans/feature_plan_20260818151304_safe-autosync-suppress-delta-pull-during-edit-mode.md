# Safe Auto-Sync: Suppress Delta-Pull During Edit Mode, Reliable Autopush on Save

## Goal

Make the tickets auto-sync engine safe to leave ON by suppressing the 45-second delta-pull timer while the user has unsaved edits open in the webview editor, and by making autopush-on-save reliable and immediate rather than dependent on the file watcher alone. This eliminates the need for the manual Refresh + Push workflow the user currently resorts to because auto-sync is too risky to leave enabled.

### Problem Analysis & Root Cause

**The core problem:** The auto-sync engine (`_updateTicketsAutoSyncWatcher` in `TicketsPanelProvider.ts`) runs two independent mechanisms when auto-sync is ON:

1. **File watcher (autopush):** watches local `.md` ticket files; on `change`, debounces 2s, then pushes to remote via `switchboard.pushTicketEdits`. This is the "autopush on save" — it already exists and works.
2. **Delta-pull timer (autofetch):** a 45s `setInterval` that calls `switchboard.importAllTasks` with a delta cursor to pull remote changes and overwrite local `.md` files on disk.

The delta-pull timer fires **unconditionally** every 45s. It has no awareness of whether the user is actively editing a ticket in the webview. The webview's `ticketsEditMode` flag (frontend-only, `tickets.js` line 111) protects the detail pane from being clobbered by file-read responses — `_refreshSelectedTicketFromFile()`, `_applyTicketFilePayloadToSelected()`, `renderTicketsLinearTaskDetail()`, and `renderTicketsClickUpTaskDetail()` all early-return when `ticketsEditMode === true`. But the backend never receives this state.

**What goes wrong today:**

- User enters edit mode (clicks Edit), starts typing in the textarea.
- Delta-pull timer fires. `importAllTasks` fetches remote content and **overwrites the local `.md` file on disk** with the remote version. The per-file conflict guard (`isDelta && item.id` → check `syncStatus === 'modified'`) does NOT protect this file because the user hasn't saved yet — the file's mtime still matches `last_synced_at`, so the guard sees it as unmodified and overwrites it.
- The webview detail pane is protected (edit mode flag), so the user doesn't see the clobber immediately. But the on-disk file now holds remote content, not the user's in-progress edits.
- If the user clicks **Cancel** (exits edit mode without saving), the detail pane re-renders from the on-disk file — which now has the remote content. The user's unsaved edits are silently lost.
- If the user clicks **Save**, `saveLocalTicketFile` writes their version to disk (overwriting the just-pulled remote content), then the file watcher pushes. The user's edit wins, but any remote changes that arrived during the edit session are silently discarded — a data-loss path that's invisible to the user.
- Additionally, the delta-pull triggers `loadLocalTicketFiles()` in the webview (`importAllTicketsComplete` handler), causing a sidebar refresh that's visually disruptive while editing.

**Why the user uses the manual method instead:** Because auto-sync ON means the delta-pull can clobber their work at any 45s boundary, the user turns auto-sync OFF and relies on the manual Refresh + Push buttons. But this is "too difficult to keep things in sync" — they have to remember to refresh before editing and push after saving, and it's easy to forget.

**Root cause:** The backend's delta-pull timer has no knowledge of the webview's edit-mode state. The `ticketsEditMode` flag is frontend-only; no message is sent to the backend when edit mode is entered or exited.

**Secondary issue — default is OFF:** `_getTicketsAutoSync` (line 872) returns `false` when both the global and per-folder config values are unset. New installs and users who never touched the toggle get auto-sync OFF by default, so they're dropped into the manual Refresh + Push workflow immediately. Since the edit-mode suppression (below) makes auto-sync safe, the default should flip to ON.

## User Review Required

- **Default-ON flip conflicts with PRD contract #2** ("behaviour-preserving" on shipped extension, "New capabilities ship default-OFF"). Flipping the auto-sync default from OFF to ON changes behavior for ~4,000 existing installs — users who never touched the toggle will suddenly have background polling active. The edit-mode suppression makes this *safe*, but "safe" ≠ "desired by the user." Decide: (a) ship the default-ON flip as a deliberate override of contract #2, justified by the safety improvement, or (b) keep the default OFF and let users opt in. The plan below includes the flip as proposed, but this is a product call, not a technical one.
- **Direct push on save fires even when auto-sync is OFF.** This is a behavior change: users who turned auto-sync OFF to avoid automatic network pushes will now get an auto-push every time they save a ticket file. The plan deliberately bundles this as "autopush-on-save as a standalone behavior," but some users may have auto-sync OFF specifically to control when pushes happen. Decide: (a) always direct-push on save (current plan), or (b) only direct-push when auto-sync is ON, and let the manual Push button handle the OFF case.

## Metadata
- **Complexity:** 5
- **Tags:** backend, frontend, ui, reliability, feature
- **Project:** Browser Switchboard

## Complexity Audit

### Routine
- Adding a `setTicketsEditMode` message from webview to backend (modeled exactly on the existing `setTicketsAutoSync` message pattern).
- Storing edit-mode state in a `Map<string, boolean>` on `TicketsPanelProvider` (one line declaration, one line set).
- Adding a guard at the top of the delta-pull timer callback: `if (this._ticketsEditMode.get(workspaceRoot)) { return; }`.
- Triggering an immediate delta-pull after edit mode exits (extract the timer callback body into a reusable method).
- Sending `setTicketsEditMode` notifications from `enterTicketsEditMode()` and `exitTicketsEditMode()` in `tickets.js`.
- Resetting edit-mode state to `false` on `setupTicketsWatcher` re-init.

### Complex / Risky
- Adding a direct push in the `saveLocalTicketFile` handler (after the file write succeeds) without double-pushing via the file watcher. The file watcher debounce for that file must be cancelled when the direct push fires. A residual race remains: the file watcher may set a *new* debounce after the cancellation but before the direct push completes, causing a second push 2s later. The push is idempotent (same content → no-op on remote), so this is an efficiency issue, not data loss. The coder should add a short-lived "skip-next-watch" flag for the saved file path to fully close the race, or accept the benign double-push.
- Post-save re-sync: after the direct push completes, triggering an immediate delta-pull to catch remote changes that arrived during the edit session. Must not race with the file watcher's own push or create a push-pull echo.
- Ensuring the edit-mode notification is sent reliably even if the webview is disposed or the panel switches roots mid-edit.
- Flipping the auto-sync default to ON without breaking the per-folder explicit opt-out path — requires distinguishing "unset" from "explicitly false" in the local config (see Superseded callout in Proposed Changes §1).

## Edge-Case & Dependency Audit

- **Edit mode entered but panel switched / webview disposed:** If the user enters edit mode, then switches to a different workspace root or closes the panel, the backend may never receive the `editing: false` message. The delta-pull would stay suppressed indefinitely for that root. **Mitigation:** On `setupTicketsWatcher` / panel re-init, reset edit-mode state to `false`. Also add a safety timeout: if edit mode has been active for more than 10 minutes without a save/cancel, auto-clear it (the user likely walked away).
- **File watcher + direct push double-push:** When `saveLocalTicketFile` writes the file, the file watcher fires and debounces a push. If we also push directly in the handler, we get two pushes. **Mitigation:** In the `saveLocalTicketFile` handler, cancel any pending debounce for that file path (`_ticketsAutoSyncDebounces`) before the direct push. **Residual race:** the OS file-change event may arrive *after* the cancellation but *before* the direct push completes, setting a new debounce that fires 2s later. The push is idempotent so this is benign; a "skip-next-watch" flag for the saved path would fully close it.
- **Delta-pull suppression scope:** Suppressing the entire delta-pull (not just the ticket being edited) means other tickets' remote updates are delayed by up to 45s after the user exits edit mode. This is acceptable — the user is actively working and a 45s catch-up is immaterial. The post-save immediate delta-pull minimizes this window.
- **Push-pull echo after save:** After the direct push completes, the immediate delta-pull may fetch the user's just-pushed edit back. The delta cursor (`last_delta_pull_*`) is updated after each successful pull, and the pushed content matches the remote, so the re-pull is a no-op for that ticket. No echo.
- **Auto-sync OFF:** When auto-sync is OFF, the delta-pull timer is not armed, so edit-mode suppression is moot. The direct push on save should still fire (it's independent of the timer) so the user gets autopush-on-save even without auto-sync. This directly addresses "will autopush on save" as a standalone behavior. **Note:** this is a behavior change for users who currently have auto-sync OFF — see User Review Required.
- **Immediate delta-pull on edit-mode exit may be skipped by backoff:** If there were consecutive delta-pull failures before the user entered edit mode, `_ticketsAutoSyncNextEligible` may be set to a future time. The extracted `_runTicketsDeltaPull` method checks `nextEligible > now` and returns early. The "immediate" delta-pull on edit-mode exit would be silently skipped. **Mitigation:** the next 45s timer tick handles it once the backoff window expires. If truly immediate catch-up is desired, clear `_ticketsAutoSyncNextEligible` and `_ticketsAutoSyncFailures` on edit-mode exit (but only if failures < 5 — don't reset the hard pause).
- **Conflict guard interaction:** The existing delta-pull conflict guard (skip files with `syncStatus === 'modified'`) continues to protect on-disk modifications that haven't been pushed yet. Edit-mode suppression is an additional layer for unsaved (in-editor) edits that the conflict guard cannot see. These two mechanisms are complementary, not redundant.
- **Multiple tickets surfaces (editor panel + browser tabs):** The `ticketsAutoSyncChanged` broadcast pattern pushes to all surfaces. The `setTicketsEditMode` message should be handled per-root (not broadcast) since only one surface can be in edit mode at a time for a given root.
- **PRD contract #2 (byte-compatibility):** The default-ON flip is a behavior change on shipped installs. The edit-mode suppression and direct-push-on-save are new internal mechanisms (not user-facing toggles), so they don't violate the "new capabilities ship default-OFF" clause. But the default flip itself does conflict with "behaviour-preserving." See User Review Required.

## Dependencies

- `feature_plan_20260807103000_tickets-autosync-migration-regression` — moved the auto-sync engine from PlanningPanelProvider to TicketsPanelProvider. Completed; the engine is live in `TicketsPanelProvider.ts`. This plan builds on that foundation.

## Adversarial Synthesis

Key risks: (1) the `_getTicketsAutoSync` default-ON logic cannot distinguish "unset" from "explicitly false" because `getTicketsAutoSync()` collapses both to `false` — the proposed code would never actually default to ON; (2) the default-ON flip conflicts with PRD contract #2's "behaviour-preserving" requirement on ~4,000 shipped installs; (3) a residual double-push race between the file watcher and the direct push on save (benign — push is idempotent). Mitigations: add a `getTicketsAutoSyncRaw()` method to `LocalFolderService` to distinguish unset from false; surface the PRD conflict as a User Review item; accept the benign double-push or add a skip-next-watch flag.

## Proposed Changes

### 1. `src/services/LocalFolderService.ts` — Add `getTicketsAutoSyncRaw()` method

The existing `getTicketsAutoSync()` method returns `this._getOrLoadCachedConfig().ticketsAutoSync === true`, which collapses `undefined` (unset) and `false` (explicit opt-out) to the same `false` return value. The default-ON logic in `_getTicketsAutoSync` (Proposed Changes §2) needs to distinguish these two cases. Add a new method that returns the raw value:

```typescript
/**
 * Return the raw ticketsAutoSync config value — `true`, `false`, or
 * `undefined` when unset. Used by TicketsPanelProvider._getTicketsAutoSync
 * to distinguish "user never touched the toggle" (undefined → default ON)
 * from "user explicitly turned it off" (false → respect the opt-out).
 * getTicketsAutoSync() collapses both to `false` and cannot make this
 * distinction.
 */
getTicketsAutoSyncRaw(): boolean | undefined {
    return this._getOrLoadCachedConfig().ticketsAutoSync;
}
```

### 2. `src/services/TicketsPanelProvider.ts` — Default auto-sync ON

In `_getTicketsAutoSync` (line 872), change the fallback from `false` to `true` so new installs and users who never touched the toggle get auto-sync ON by default. The promotion-to-global branch is preserved so the choice sticks.

> **Superseded:** The original plan proposed checking `localValue === false` via `getTicketsAutoSync()` to distinguish an explicit opt-out from an unset value. The plan stated: "the per-folder check now distinguishes an explicit `false` opt-out from an unset value (previously it only checked truthiness, so an explicit `false` fell through to the `return false` default — now it's respected as a deliberate choice)."
> **Reason:** `getTicketsAutoSync()` returns `this._getOrLoadCachedConfig().ticketsAutoSync === true`. This collapses `undefined` (unset) and `false` (explicit opt-out) to the same `false` return value. The proposed `localValue === false` check would be true for BOTH cases, so ALL users with no global config would be treated as explicit opt-outs and get `false` promoted to global. The default-ON behavior would never actually fire. The plan's claim that it "distinguishes" the two cases is incorrect — it cannot, using `getTicketsAutoSync()`.
> **Replaced with:** Use the new `getTicketsAutoSyncRaw()` method (Proposed Changes §1) which returns `boolean | undefined`, allowing a three-way branch: `true` → promote true, `false` → promote false (explicit opt-out), `undefined` → default ON (promote true).

```typescript
private async _getTicketsAutoSync(root: string): Promise<boolean> {
    const globalConfig = await GlobalIntegrationConfigService.loadGlobal();
    if (globalConfig.ticketsAutoSync === undefined) {
        const localService = this._getLocalFolderService(root);
        const localValue = localService.getTicketsAutoSyncRaw();
        if (localValue === true) {
            // Explicit per-folder opt-in — promote to global.
            await GlobalIntegrationConfigService.setTicketsAutoSync(true);
            return true;
        }
        if (localValue === false) {
            // Explicit per-folder opt-out — respect it and promote to global.
            await GlobalIntegrationConfigService.setTicketsAutoSync(false);
            return false;
        }
        // Unset everywhere — default ON: edit-mode suppression makes
        // auto-sync safe to enable. Promote to global so this branch
        // doesn't re-run every call.
        await GlobalIntegrationConfigService.setTicketsAutoSync(true);
        return true;
    }
    return globalConfig.ticketsAutoSync === true;
}
```

The key change: the `return false` fallback at the old line 881 becomes `return true`, and the per-folder check now uses `getTicketsAutoSyncRaw()` to distinguish an explicit `false` opt-out from an unset value (previously `getTicketsAutoSync()` collapsed both to `false`).

### 3. `src/services/TicketsPanelProvider.ts` — Edit-mode state tracking

Add a new field alongside the existing auto-sync state maps (near line 78):

```typescript
// Edit-mode state: when true for a workspace root, the delta-pull timer
// skips all ticks. Set by the webview via setTicketsEditMode when the
// user enters/exits the ticket editor. Prevents the delta-pull from
// overwriting the on-disk file while the user has unsaved edits in the
// webview textarea.
private _ticketsEditMode: Map<string, boolean> = new Map();
```

### 4. `src/services/TicketsPanelProvider.ts` — `setTicketsEditMode` message handler

Add a new case in the message handler switch (modeled on `setTicketsAutoSync` at line 1386):

```typescript
case 'setTicketsEditMode': {
    const root = this._resolveWorkspaceRoot(msg.workspaceRoot) || this._getWorkspaceRoot() || '';
    const editing = msg.editing === true;
    if (!root) { return { success: false, error: 'No workspace root resolved' }; }
    this._ticketsEditMode.set(root, editing);
    // When edit mode exits, trigger an immediate delta-pull to catch
    // any remote changes that arrived during the edit session — don't
    // wait up to 45s for the next timer tick.
    if (!editing) {
        this._runTicketsDeltaPull(root).catch(() => { /* logged inside */ });
    }
    return { success: true, editing };
}
```

### 5. `src/services/TicketsPanelProvider.ts` — Extract delta-pull into a reusable method

Extract the body of the `setInterval` callback (lines 972–1059) into a private method so it can be called both from the timer and from the `setTicketsEditMode` handler. The extracted method includes: the failure-count check, exponential backoff check, selection lookup, cache service initialization, delta cursor read, `importAllTasks` call, cursor update on success, `importAllTicketsComplete` post to webview, and failure/backoff tracking on error.

```typescript
/**
 * Run a single delta-pull cycle for the given workspace root. Reads the
 * delta cursor, calls importAllTasks, updates the cursor on success, and
 * posts importAllTicketsComplete to the webview. Handles exponential
 * backoff on failure. Extracted from the setInterval callback so the
 * post-edit-mode-exit immediate re-sync can call it directly.
 */
private async _runTicketsDeltaPull(workspaceRoot: string): Promise<void> {
    const failures = this._ticketsAutoSyncFailures.get(workspaceRoot) || 0;
    if (failures >= 5) { return; }
    const now = Date.now();
    const nextEligible = this._ticketsAutoSyncNextEligible.get(workspaceRoot) || 0;
    if (nextEligible > now) { return; }
    const selection = this._ticketsCurrentSelection.get(workspaceRoot);
    if (!selection || !selection.provider) { return; }
    // ... (body verbatim from the current setInterval callback, lines 986–1058:
    //      cache service init, delta cursor read, importAllTasks call,
    //      cursor update, importAllTicketsComplete post, failure tracking)
}
```

The `setInterval` callback becomes:

```typescript
const timer = setInterval(async () => {
    // Suppress delta-pull while the user has unsaved edits in the webview
    // editor. The file watcher (autopush) continues to operate — only the
    // pull side is paused. This prevents the delta-pull from overwriting
    // the on-disk file with remote content while the user is mid-edit.
    if (this._ticketsEditMode.get(workspaceRoot)) { return; }
    await this._runTicketsDeltaPull(workspaceRoot);
}, POLL_INTERVAL_MS);
```

### 6. `src/services/TicketsPanelProvider.ts` — Direct push on save

In the `saveLocalTicketFile` handler (after the `nfs.writeFileSync` succeeds, around line 2174), add a direct push so autopush-on-save is reliable and immediate, not dependent on the file watcher's 2s debounce. Add `break` inside the catch block so the push only fires on successful write:

```typescript
try {
    const nfs = require('fs') as typeof import('fs');
    const existing = nfs.readFileSync(filePath, 'utf8');
    const frontmatterMatch = existing.match(/^(---\n[\s\S]*?\n---\n?)/);
    const frontmatter = frontmatterMatch ? frontmatterMatch[1] : '';
    nfs.writeFileSync(filePath, frontmatter + content, 'utf8');
} catch (writeErr) {
    const errMsg = writeErr instanceof Error ? writeErr.message : String(writeErr);
    this._seams().ui.showErrorMessage(`Save failed: ${errMsg}`);
    break;
}

// ── Autopush on save: push the local file to the remote provider
//    immediately, without waiting for the file watcher's 2s debounce.
//    Cancel any pending file-watcher debounce for this file to avoid
//    a double-push. This works whether auto-sync is ON or OFF — the
//    user gets autopush-on-save as a standalone behavior. ──
const debounceKey = filePath;
const pendingDebounce = this._ticketsAutoSyncDebounces.get(debounceKey);
if (pendingDebounce) { clearTimeout(pendingDebounce); this._ticketsAutoSyncDebounces.delete(debounceKey); }
try {
    const pushResult: any = await this._seams().commands.executeCommand(
        'switchboard.pushTicketEdits',
        { workspaceRoot, provider, id }
    );
    this.postMessageToWebview({
        type: 'pushTicketResult',
        success: pushResult?.success ?? false,
        id,
        error: pushResult?.error,
        autoSync: true
    });
} catch (pushErr) {
    this.postMessageToWebview({
        type: 'pushTicketResult',
        success: false,
        id,
        error: pushErr instanceof Error ? pushErr.message : String(pushErr),
        autoSync: true
    });
}
```

**Note on residual race:** The file watcher may detect the `writeFileSync` change *after* the debounce cancellation above but *before* the direct push completes, setting a new 2s debounce that fires a second push. The push is idempotent (same content → no-op on remote), so this is benign. To fully close the race, the coder may add a short-lived `Set<string>` of "skip-next-watch" file paths that the file watcher callback checks before arming a debounce.

### 7. `src/webview/tickets.js` — Send edit-mode notifications

In `enterTicketsEditMode()` (line 3041), after setting `ticketsEditMode = true`, notify the backend:

```javascript
function enterTicketsEditMode() {
    const provider = lastIntegrationProvider;
    const issue = provider === 'linear' ? selectedLinearIssue : selectedClickUpIssue;
    if (!issue) return;
    ticketsEditMode = true;
    // Notify the backend so the delta-pull timer suppresses ticks while
    // the user has unsaved edits. Without this, the 45s delta-pull can
    // overwrite the on-disk file with remote content, and a Cancel would
    // silently lose the user's in-progress edits.
    vscode.postMessage({ type: 'setTicketsEditMode', editing: true, workspaceRoot: ticketsWorkspaceRoot || undefined });
    // ... rest of existing function unchanged
```

In `exitTicketsEditMode()` (line 3137), after setting `ticketsEditMode = false`, notify the backend:

```javascript
function exitTicketsEditMode() {
    ticketsEditMode = false;
    _ticketsEditBackupHtml = null;
    // Notify the backend that edit mode has exited. The backend will
    // trigger an immediate delta-pull to catch any remote changes that
    // arrived during the edit session.
    vscode.postMessage({ type: 'setTicketsEditMode', editing: false, workspaceRoot: ticketsWorkspaceRoot || undefined });
    // ... rest of existing function unchanged
```

### 8. `src/services/TicketsPanelProvider.ts` — Reset edit-mode on panel re-init

In `setupTicketsWatcher` (around line 1919, where the auto-sync engine is armed on panel open), reset edit-mode state to `false` to handle the case where the webview was disposed mid-edit and the `editing: false` message was never sent:

```typescript
// Reset edit-mode state on re-init — the webview may have been disposed
// mid-edit without sending editing: false, which would leave the delta-pull
// suppressed indefinitely.
this._ticketsEditMode.set(root, false);
```

### 9. `src/test/tickets-auto-sync-edit-mode-suppression.test.js` — New test file

Add a static-analysis test (matching the pattern of `tickets-auto-refresh-on-file-change.test.js`) that verifies:

```javascript
function testTicketsAutoSyncEditModeSuppression() {
    const providerTs = fs.readFileSync(path.join(__dirname, '../services/TicketsPanelProvider.ts'), 'utf8');
    const folderSvcTs = fs.readFileSync(path.join(__dirname, '../services/LocalFolderService.ts'), 'utf8');
    const ticketsJs = fs.readFileSync(path.join(__dirname, '../webview/tickets.js'), 'utf8');

    // 1. Backend has edit-mode state tracking
    assert.ok(providerTs.includes('_ticketsEditMode'), 'TicketsPanelProvider must declare _ticketsEditMode map');

    // 2. LocalFolderService has getTicketsAutoSyncRaw (distinguishes unset from false)
    assert.ok(folderSvcTs.includes('getTicketsAutoSyncRaw'), 'LocalFolderService must declare getTicketsAutoSyncRaw');

    // 3. _getTicketsAutoSync defaults to ON (uses getTicketsAutoSyncRaw, not getTicketsAutoSync)
    const getAutoSyncIdx = providerTs.indexOf('private async _getTicketsAutoSync(');
    assert.notStrictEqual(getAutoSyncIdx, -1, '_getTicketsAutoSync must exist');
    const getAutoSyncBody = providerTs.slice(getAutoSyncIdx, providerTs.indexOf('private ', getAutoSyncIdx + 1));
    assert.ok(getAutoSyncBody.includes('getTicketsAutoSyncRaw'), '_getTicketsAutoSync must use getTicketsAutoSyncRaw');
    assert.ok(!getAutoSyncBody.match(/return false;\s*}/), '_getTicketsAutoSync must not have a bare `return false` fallback — default is ON');

    // 4. setTicketsEditMode handler exists
    assert.ok(providerTs.includes("case 'setTicketsEditMode'"), 'setTicketsEditMode handler must exist');

    // 5. Delta-pull timer checks edit-mode state
    const timerIdx = providerTs.indexOf('_ticketsAutoSyncTimers.set');
    assert.notStrictEqual(timerIdx, -1, 'timer set must exist');
    const timerBody = providerTs.slice(providerTs.lastIndexOf('setInterval', timerIdx), timerIdx);
    assert.ok(timerBody.includes('_ticketsEditMode'), 'delta-pull timer callback must check _ticketsEditMode');

    // 6. saveLocalTicketFile triggers a direct push
    const saveIdx = providerTs.indexOf("case 'saveLocalTicketFile'");
    const saveEnd = providerTs.indexOf('break;', providerTs.indexOf('nfs.writeFileSync', saveIdx));
    const saveBody = providerTs.slice(saveIdx, saveEnd);
    assert.ok(saveBody.includes('pushTicketEdits'), 'saveLocalTicketFile must directly call pushTicketEdits');

    // 7. Webview sends setTicketsEditMode on enter and exit
    const enterIdx = ticketsJs.indexOf('function enterTicketsEditMode()');
    const enterBody = ticketsJs.slice(enterIdx, ticketsJs.indexOf('function exitTicketsEditMode()'));
    assert.ok(enterBody.includes("setTicketsEditMode"), 'enterTicketsEditMode must post setTicketsEditMode');

    const exitIdx = ticketsJs.indexOf('function exitTicketsEditMode()');
    const exitBody = ticketsJs.slice(exitIdx, exitIdx + 500);
    assert.ok(exitBody.includes("setTicketsEditMode"), 'exitTicketsEditMode must post setTicketsEditMode');

    console.log('  ✓ tickets-auto-sync-edit-mode-suppression: all assertions passed');
}

try {
    testTicketsAutoSyncEditModeSuppression();
} catch (e) {
    console.error('  ✗ tickets-auto-sync-edit-mode-suppression:', e.message);
    process.exit(1);
}
```

Register the test in `package.json` under the test script section (matching the existing pattern).

## Verification Plan

### Automated Tests
- Run the new static-analysis test: `node src/test/tickets-auto-sync-edit-mode-suppression.test.js`
- Run existing ticket sync tests to confirm no regressions:
  - `node src/test/tickets-auto-refresh-on-file-change.test.js`
  - `node src/test/tickets-delta-sweep-gate-regression.test.js`
  - `node src/test/verb-engine-tickets-headless.test.js`
- Run the full test suite: `npm test`

### Manual Verification
1. **Default ON:** On a fresh install (or after clearing the `ticketsAutoSync` value from global config), open the Tickets tab and select a ClickUp list or Linear project. Verify the auto-sync toggle is already checked and the delta-pull timer starts firing (sidebar populates without clicking Refresh).
2. **Edit-mode suppression:** With auto-sync ON, wait for the first delta-pull to complete (sidebar populates). Click Edit on a ticket. Wait 60s (two delta-pull cycles). Verify no `importAllTicketsComplete` messages arrive while in edit mode (check the browser console or VS Code developer tools for the absence of auto-sync delta-pull logs).
3. **Cancel preserves unsaved edits:** While in edit mode, make changes to the description. Wait 60s. Click Cancel. Verify the detail pane shows the user's unsaved edits are gone BUT the on-disk file still holds the pre-edit content (not remote-overwritten content). The key assertion: the file on disk was NOT overwritten by a delta-pull during edit mode.
4. **Autopush on save:** While in edit mode, make changes. Click Save. Verify the `pushTicketResult` message arrives within 1s (not 2s+ from the file watcher debounce). Verify the remote ticket (in ClickUp/Linear web UI) reflects the saved changes.
5. **Post-save re-sync:** After saving, verify an immediate delta-pull fires (within 1–2s, not 45s). Check that any remote changes to other tickets that arrived during the edit session appear in the sidebar.
6. **Auto-sync OFF + autopush on save:** Turn auto-sync OFF. Edit a ticket and click Save. Verify the direct push still fires (autopush-on-save works independently of the auto-sync toggle). Verify the delta-pull timer does NOT fire (auto-sync OFF = no background polling).
7. **Stale edit-mode recovery:** Enter edit mode. Close the panel (dispose the webview) without clicking Save or Cancel. Reopen the panel. Verify the delta-pull timer resumes (edit-mode state was reset on re-init). Wait 50s and confirm a delta-pull fires.
8. **Explicit opt-out respected:** Turn auto-sync OFF. Reload the panel. Verify the toggle stays unchecked (the explicit `false` choice was promoted to global config and is respected, not overridden by the new default-ON logic).
9. **Unset → default ON:** On a fresh install with no per-folder or global `ticketsAutoSync` value set, verify the toggle is ON and the delta-pull timer fires. This tests the `getTicketsAutoSyncRaw() === undefined` → `true` path.

## Outstanding Questions
- **[user]** Should the auto-sync default flip from OFF to ON for existing ~4,000 installs? PRD contract #2 says "behaviour-preserving" — the flip changes behavior for users who never touched the toggle. — proceeding on the assumption that the flip is desired (the edit-mode suppression makes it safe, and the plan's Goal explicitly calls for it), but this is a product decision that the User Review Required section surfaces.
- **[user]** Should direct push on save fire when auto-sync is OFF? This changes behavior for users who turned auto-sync OFF to control push timing. — proceeding on the assumption that autopush-on-save should always fire (the plan's Goal says "reliable autopush on save" as a standalone behavior), but some users may want manual push control when auto-sync is OFF.
