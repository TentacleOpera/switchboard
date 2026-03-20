# Add Setup Option to Auto Sync for Jules

## Goal
Add a new boolean toggle to the Setup panel — **"Auto-sync repo before sending to Jules"** — that, when enabled, automatically runs a `git add -A && git commit && git push` (equivalent to the existing "Sync Repo" button) before dispatching a plan to Jules via the sidebar button or the Kanban "Send to Jules" button. Jules must not be triggered until the sync confirms success. The option defaults to OFF.

## User Review Required
> [!NOTE]
> The option must be positioned **directly below the "Enable Jules" row** (the Jules visibility checkbox at line 1379 in `implementation.html` / line 1245 in the onboarding step). The label should read: *"Auto-sync repo before sending to Jules"*.
>
> The sync uses the same Git execution path as the existing `airlock_sync` message handler. If the sync fails, the Jules send must be aborted and an error must be surfaced to the user in the same status element that the manual sync uses (`jules-sync-status`).

> [!IMPORTANT]
> **Defaults to OFF.** Do not flip the default to ON — existing users must opt in explicitly.

## Complexity Audit

### Band A — Routine
- Add a new `<label>` / `<input type="checkbox">` row in the **Setup panel** HTML (`implementation.html` ~line 1383), below the Jules visibility row.
- Add a new `<label>` / `<input type="checkbox">` row in the **Onboarding** panel HTML (`implementation.html` ~line 1248), below the Jules visibility row.
- Add `julesAutoSyncEnabled` to the `saveStartupCommands` message payload in the `btn-save-startup` click handler (`implementation.html` ~line 1844).
- Add `julesAutoSyncEnabled: false` to the onboarding `btn-onboard-save` payload (`implementation.html` line 3434) with a live read of the new checkbox.
- Add a `getJulesAutoSyncSetting` / `julesAutoSyncSetting` message round-trip so the toggle hydrates correctly when the Setup panel is opened (follows the `getAccurateCodingSetting` / `accurateCodingSetting` pattern at lines 1819, 2218–2223).
- Persist the setting in `TaskViewerProvider.ts` (or wherever `saveStartupCommands` is handled) using the extension's existing `globalState` or `settings.json` storage.

### Band B — Complex / Risky
- **Intercept the Jules dispatch flow** in `TaskViewerProvider.ts` (or the handler that processes `{ type: 'julesSelected' }` / `{ type: 'triggerAgentAction', role: 'jules' }` messages from both the sidebar and the Kanban webview): if `julesAutoSyncEnabled` is true, fire `airlock_sync` first and await its result before proceeding with the Jules send. If the sync fails, post `airlock_syncError` back to the webview and bail — do not trigger the Jules task.
- This requires converting what is currently a fire-and-forget Jules action into an **async, guarded flow** with a Promise that resolves on `airlock_syncComplete` or rejects on `airlock_syncError`. Ensure the flow is not triggered twice if the user clicks Jules rapidly.
- **Deduplication / re-entrancy guard**: while a Jules sync-then-send is in flight, the Jules button(s) must be disabled or show a "SYNCING…" state to prevent double-submission.

## Edge-Case & Dependency Audit
- **Race Conditions:**
  - User clicks Jules twice before the first sync finishes → second click must be silently dropped (button disabled during in-flight sync).
  - The `airlock_sync` timeout (no `airlock_syncComplete` received within N seconds) → must treat as failure and surface error; do not leave Jules in a permanent pending state. Recommendation: 60-second timeout.
- **Security:** Git commit + push exposes whatever uncommitted local changes exist. The setting defaults to OFF and the user opts in deliberately — no additional guard needed.
- **Side Effects:**
  - The existing manual "SYNC REPO" button in the Jules sidebar panel is unchanged. Auto-sync is additive.
  - If the user has the option enabled and fires multiple Jules sends in quick succession, only the first sync runs (subsequent ones are blocked by the re-entrancy guard).
  - `git push` will fail if the branch has no upstream configured — this surfaces as `airlock_syncError` and the Jules send is cancelled. Acceptable.
- **Dependencies & Conflicts:**
  - No open Kanban plans are known to be modifying the Jules dispatch path or `TaskViewerProvider.ts` at this time. Verify before merging.
  - The existing `airlock_sync` message must remain compatible — this feature reuses it as-is.

## Adversarial Synthesis

### Grumpy Critique
> "Where do I even start. You want to intercept the Jules action and inject an async Git operation — great, but you haven't told me *where* that guard lives. Is it in the webview, in `TaskViewerProvider.ts`, or somewhere else? If it's in the webview, you're doing async in a message-passing environment with no real Promise chaining — you're going to end up with a global flag like `let julesSyncInFlight = false` and a `setTimeout` that resets it when nobody's looking. Elegant.
>
> Second: what happens to the Kanban `julesSelected` path? The Kanban sends `{ type: 'julesSelected', sessionIds }` — that's a *different* code path from the sidebar `{ type: 'triggerAgentAction', role: 'jules' }`. You need to intercept **both** of them, not just the one you're thinking about. Miss one and you have a setting that only half-works.
>
> Third: the setting needs to reach the backend *before* the Jules send is attempted. If you read `julesAutoSyncEnabled` from the in-memory state in the webview and post as part of the message, fine. But if the backend decides, you need to make sure `saveStartupCommands` is actually persisted before a Jules fire can read it. Race condition: user adds the checkmark, immediately clicks Jules — does the setting make it to the backend in time? Answer: no, not unless you save on toggle-change or read the checkbox value from the live DOM at dispatch time.
>
> Finally: no timeout on the sync? If `git push` hangs (no network, auth prompt), the Jules button is permanently disabled and the user has to reload the window. Add a timeout."

### Balanced Response
All four concerns from Grumpy are valid and addressed in the implementation steps below:

1. **Where the guard lives** — the intercept is in the **extension backend** (in the `message.type === 'julesSelected'` and `message.type === 'triggerAgentAction'` handlers in `TaskViewerProvider.ts`), not in the webview. The backend has direct access to `globalState` and can await the sync promise cleanly without webview hacks.
2. **Both Jules paths** — both `julesSelected` (Kanban) and `triggerAgentAction` with `role: 'jules'` (sidebar) route through `TaskViewerProvider.ts`. The guard is implemented once in a shared `dispatchJulesAction(sessionIds)` helper that both handlers call.
3. **Setting read at dispatch time** — the backend reads `julesAutoSyncEnabled` from `globalState` at the moment of dispatch; no race with `saveStartupCommands` because the backend always holds the authoritative value.
4. **Timeout** — a 60-second timeout on the sync promise is specified explicitly; on timeout, an error is posted back to the webview and the Jules send is cancelled.

## Proposed Changes

> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** Provide complete, fully functioning code blocks.

---

### 1. Setup Panel UI (main sidebar)

#### [MODIFY] `src/webview/implementation.html`

- **Context:** The Jules visibility row in the Setup panel ends at line ~1383. A new checkbox row must be inserted immediately after.
- **Logic:** Add a `<label>` element with a new checkbox `id="jules-auto-sync-toggle"` styled identically to `accurate-coding-toggle` (line 1384–1387).
- **Implementation — HTML addition** (insert after line 1383, before the "Accurate coding mode" label):

```html
<label class="startup-row" style="display:flex; align-items:center; gap:8px; margin-top:6px;">
    <input id="jules-auto-sync-toggle" type="checkbox" style="width:auto; margin:0;">
    <span>Auto-sync repo before sending to Jules</span>
</label>
```

- **Logic — Setup open handler** (line ~1819, where `getAccurateCodingSetting` and `getLeadChallengeSetting` are dispatched on panel open):

```javascript
// Add after existing getLeadChallengeSetting dispatch:
vscode.postMessage({ type: 'getJulesAutoSyncSetting' });
```

- **Logic — Save handler** (line ~1841–1844, inside `btnSaveStartup` click handler):

```javascript
// Add to the existing block. Full updated message:
const julesAutoSyncEnabled = !!document.getElementById('jules-auto-sync-toggle')?.checked;
vscode.postMessage({
    type: 'saveStartupCommands',
    commands,
    visibleAgents,
    accurateCodingEnabled,
    leadChallengeEnabled,
    julesAutoSyncEnabled,   // ← NEW
    planIngestionFolder,
    customAgents: lastCustomAgents
});
```

- **Logic — Incoming message handler** (after line ~2230, alongside `leadChallengeSetting` case):

```javascript
case 'julesAutoSyncSetting': {
    const toggle = document.getElementById('jules-auto-sync-toggle');
    if (toggle) {
        // Default OFF: message.enabled must be explicitly true to check
        toggle.checked = message.enabled === true;
    }
    break;
}
```

- **Edge Cases Handled:** Toggle defaults to unchecked (OFF) because `message.enabled === true` is a strict equality check; `undefined` or `false` both leave the box unchecked.

---

### 2. Onboarding Panel UI

#### [MODIFY] `src/webview/implementation.html`

- **Context:** The Jules row in the onboarding CONFIGURE CLI AGENTS step is at line ~1245–1249. A new row must be added below it.
- **Logic:** Add a similar checkbox row using the same `onboard-agent-toggle` class pattern (but for a boolean setting, not role visibility — so use a distinct id).
- **Implementation** (insert after line 1249, before the bottom button row):

```html
<label class="startup-row" style="display:flex; align-items:center; gap:8px; margin-top:4px;">
    <input id="onboard-jules-auto-sync" type="checkbox" style="width:auto; margin:0;">
    <span style="font-size:10px; color:var(--text-secondary);">Auto-sync repo before sending to Jules (default OFF)</span>
</label>
```

- **Logic — Onboarding save handler** (line ~3434):

```javascript
// Updated btn-onboard-save payload:
vscode.postMessage({
    type: 'saveStartupCommands',
    commands: agents,
    visibleAgents,
    accurateCodingEnabled: false,
    julesAutoSyncEnabled: !!document.getElementById('onboard-jules-auto-sync')?.checked,  // ← NEW
    onboardingComplete: true
});
```

- **Edge Cases Handled:** During onboarding the checkbox defaults to unchecked, so `julesAutoSyncEnabled: false` is always saved unless the user explicitly opts in.

---

### 3. Backend Setting Persistence

#### [MODIFY] `src/services/TaskViewerProvider.ts` (or the JS equivalent that handles `saveStartupCommands`)

- **Context:** The `saveStartupCommands` message handler already persists `accurateCodingEnabled` and `leadChallengeEnabled` via `globalState` or a config file. `julesAutoSyncEnabled` follows the exact same pattern.
- **Logic:**
  1. In the `saveStartupCommands` handler: read `message.julesAutoSyncEnabled` (default `false` if absent) and persist it via `context.globalState.update('julesAutoSyncEnabled', !!message.julesAutoSyncEnabled)`.
  2. In the `getJulesAutoSyncSetting` handler: read from `globalState` and post back:
     ```typescript
     case 'getJulesAutoSyncSetting':
         panel.webview.postMessage({
             type: 'julesAutoSyncSetting',
             enabled: context.globalState.get<boolean>('julesAutoSyncEnabled', false)
         });
         break;
     ```
- **Implementation:** Follow the verbatim pattern of `getAccurateCodingSetting` / `accurateCodingSetting` already present in this file, substituting key and message type name.
- **Edge Cases Handled:** `globalState.get('julesAutoSyncEnabled', false)` — the second argument supplies the default, so first-time users who have never saved always get OFF.

---

### 4. Jules Dispatch Guard (the core Band B change)

#### [MODIFY] `src/services/TaskViewerProvider.ts`

- **Context:** This file handles both `{ type: 'julesSelected', sessionIds }` (from Kanban) and `{ type: 'triggerAgentAction', role: 'jules', sessionFile, instruction }` (from the sidebar). Both must go through a shared async helper that conditionally runs the sync first.
- **Logic:**
  1. Extract a private async helper `dispatchJulesAction(sessionIds: string[], webviewPanel: vscode.WebviewPanel, context: vscode.ExtensionContext): Promise<void>`.
  2. At the start of the helper, read `julesAutoSyncEnabled` from `globalState`.
  3. If `true`, run the sync:
     - Post `{ type: 'airlock_syncStart' }` back to the webview to trigger the "SYNCING…" UI state on the Jules button.
     - Call the existing `syncRepo()` / `airlock_sync` execution function (reuse whatever the manual SYNC REPO button calls).
     - Await a Promise that resolves on success or rejects on error/timeout (60-second timeout).
     - On failure: post `{ type: 'airlock_syncError', message: err.message }` to the webview and `return` — Jules send is cancelled.
  4. On sync success (or if `julesAutoSyncEnabled` is false): proceed with the normal Jules dispatch logic.
  5. Use a module-level boolean `_julesSyncInFlight = false` as a re-entrancy guard: set to `true` at the top of `dispatchJulesAction`, reset in both success and error paths (including `finally`).

- **Implementation:**

```typescript
// Re-entrancy guard
let _julesSyncInFlight = false;

async function dispatchJulesAction(
    sessionIds: string[],
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    existingJulesDispatch: (ids: string[]) => Promise<void>
): Promise<void> {
    if (_julesSyncInFlight) {
        return; // Drop duplicate click silently
    }
    _julesSyncInFlight = true;

    try {
        const autoSync = context.globalState.get<boolean>('julesAutoSyncEnabled', false);

        if (autoSync) {
            // Signal UI: show syncing state
            panel.webview.postMessage({ type: 'airlock_syncStart' });

            // Race: sync vs 60-second timeout
            await Promise.race([
                runAirlockSync(),  // ← existing sync function
                new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error('Sync timed out after 60s')), 60_000)
                )
            ]);

            // Signal UI: sync complete
            panel.webview.postMessage({ type: 'airlock_syncComplete' });
        }

        // Proceed with Jules send
        await existingJulesDispatch(sessionIds);

    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        panel.webview.postMessage({ type: 'airlock_syncError', message: msg });
        // Jules send is NOT triggered
    } finally {
        _julesSyncInFlight = false;
    }
}
```

- **Wiring** — in the message handler:

```typescript
case 'julesSelected': {
    const ids: string[] = message.sessionIds || [];
    if (ids.length === 0) return;
    dispatchJulesAction(ids, panel, context, (resolvedIds) => sendToJules(resolvedIds));
    break;
}
case 'triggerAgentAction': {
    if (message.role === 'jules') {
        const ids = message.sessionFile ? [message.sessionFile] : [];
        dispatchJulesAction(ids, panel, context, (resolvedIds) => sendToJules(resolvedIds));
        return;
    }
    // ... existing non-jules handling
}
```

- **Edge Cases Handled:**
  - Re-entrancy: `_julesSyncInFlight` guard drops the second click.
  - Timeout: 60-second `Promise.race` rejects and surfaces `airlock_syncError`.
  - Sync error from Git: `runAirlockSync()` rejection propagates to catch, surfaces error and cancels Jules.
  - `julesAutoSyncEnabled` is read from `globalState` at dispatch time — no race with `saveStartupCommands`.

---

### 5. Webview Jules Button: "SYNCING…" State

#### [MODIFY] `src/webview/implementation.html`

- **Context:** When `airlock_syncStart` is received, the Jules sidebar "SYNC REPO" button should show "SYNCING…" and the Jules dispatch button(s) should be disabled to prevent double-fire. This mirrors the existing `airlock_syncError` / `airlock_syncComplete` cases (lines 2303–2315).
- **Logic:** Add a new `case 'airlock_syncStart':` in the `window.addEventListener('message', ...)` switch.
- **Implementation:**

```javascript
case 'airlock_syncStart': {
    const sBtn = document.getElementById('jules-sync-btn');
    if (sBtn) {
        sBtn.disabled = true;
        sBtn.innerText = 'SYNCING...';
        sBtn.classList.add('dispatching');
    }
    const statusEl = document.getElementById('jules-sync-status');
    if (statusEl) statusEl.innerText = 'Auto-syncing before Jules send...';
    break;
}
```

- **Edge Cases Handled:** If the user cannot see the Jules sidebar panel during a Kanban Jules send, the DOM elements won't exist — `document.getElementById` returning `null` is handled by `if (sBtn)` guards.

## Verification Plan

### Automated Tests

1. **Unit test for `dispatchJulesAction`** — add a new test file `src/test/jules-auto-sync.test.ts`:
   - Test: with `julesAutoSyncEnabled = false`, Jules fires immediately, `runAirlockSync` is never called.
   - Test: with `julesAutoSyncEnabled = true` and sync success, Jules fires after sync.
   - Test: with `julesAutoSyncEnabled = true` and sync failure, Jules does NOT fire, `airlock_syncError` is posted.
   - Test: re-entrancy guard — second call while `_julesSyncInFlight = true` returns immediately.
   - Test: 60-second timeout — mock sync that never resolves; assert `airlock_syncError` fires at timeout.

2. Run full test suite:
   ```
   npm test
   ```

### Manual Verification

1. Open the Setup panel → confirm new checkbox "Auto-sync repo before sending to Jules" appears directly below the Jules visibility row with default unchecked.
2. Enable the option → save config → close and reopen Setup panel → confirm checkbox is checked (hydration working).
3. With option **ON**: Click "Send to Jules" (sidebar) → observe the Jules sync-status element shows "Auto-syncing before Jules send..." → SYNC REPO button shows "SYNCING…" → on success, Jules task fires.
4. With option **ON**: Simulate sync failure (disconnect network, ensure git push fails) → confirm Jules task does NOT fire and an error message is shown in `jules-sync-status`.
5. With option **ON**: Click Jules button twice rapidly → confirm second click is silent-dropped (only one sync + send occurs).
6. With option **OFF**: Click "Send to Jules" → Jules fires immediately, no sync occurs.
7. Repeat steps 3–6 via the Kanban "Send to Jules" column button to confirm both dispatch paths are covered.

---

## Agent Recommendation
**Send to Lead Coder** — Band B work is significant: the async dispatch guard in `TaskViewerProvider.ts` requires careful Promise handling with timeout, re-entrancy protection, and correct wiring of both Jules message paths. The UI changes are Band A, but the backend intercept warrants a Lead Coder execution pass.
