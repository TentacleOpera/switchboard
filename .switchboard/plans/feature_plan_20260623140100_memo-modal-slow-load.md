# Kanban Webview — Cold-Open Message Race Buffer

## Goal (Problem analysis + Root Cause with cited file:line)

**Problem.** `KanbanProvider.postMessage()` (`src/services/KanbanProvider.ts:1328-1332`) sends messages directly to `this._panel.webview` with no readiness gate:

```ts
public postMessage(message: any): void {
    if (this._panel) {
        this._panel.webview.postMessage(message);
    }
}
```

On a **cold open** — the panel was closed and `open()` just called `createWebviewPanel` + set `webview.html` (`src/services/KanbanProvider.ts:886-900`) — the iframe exists (`this._panel` is non-undefined) but its JavaScript has not yet parsed and executed. The webview's `message` event listener is registered at `src/webview/kanban.html:5912`, and the `ready` signal is posted at `src/webview/kanban.html:8518`. Any `postMessage()` call that lands in the window between panel creation and listener registration is silently dropped — VS Code's webview bridge does not buffer messages delivered to an iframe whose script hasn't registered a listener yet.

**Evidence the race is real.** The `_pendingTab` pattern (`src/services/KanbanProvider.ts:108`, set at `:873`, flushed at `:4409-4411`) exists precisely because `switchToTab` messages were being dropped during cold open. It is a special-case workaround for a single message type. The general problem affects every external caller of `postMessage()`.

**External callers at risk during cold open:**

| Caller | Message types | Self-healing? |
|--------|--------------|---------------|
| `ContinuousSyncService` (10 call sites, `src/services/ContinuousSyncService.ts:153,169,213,531,568,685,820,914,992,1114`) | `liveSyncUpdate`, `liveSyncStates` | Yes — next sync cycle re-emits current state; `ready` handler's `fullSync` repopulates the board |
| `extension.ts:postKanbanStatus` (`src/extension.ts:2541-2542`, called at `:2752` and `:2812`) | `showStatusMessage` | Transient — dropping during boot is harmless |
| `KanbanProvider` internal (`switchboardThemeChanged` at `:320`) | Theme change broadcast | Rare during cold open; next config change re-fires |

**Practical impact today: low.** All current external messages are either self-healing or transient. The `ready` handler (`src/services/KanbanProvider.ts:4401-4426`) calls `fullSync`, which repopulates the entire board from the DB, so no data is permanently lost. The race buffer is **defensive hardening** — it eliminates a class of subtle, hard-to-debug message-drop bugs and future-proofs against new callers that may not be self-healing.

**Fix.** Add a `_webviewReady` flag and a `_pendingWebviewMessages` queue to `KanbanProvider`. `postMessage()` queues messages when the webview is not ready and flushes them on `ready`. Reset both on dispose. This generalizes the `_pendingTab` workaround into a universal safety net. `_pendingTab` is kept as-is (it is set before the panel exists, so it cannot go through `postMessage` — see Complexity Audit).

## Metadata

**Complexity:** 3/10
**Tags:** `reliability`, `backend`

## User Review Required

- **None.** This is a defensive hardening change with no user-visible behavior change. All design decisions (keep `_pendingTab`, queue-then-flush, reset on dispose) are decided in this plan.

## Complexity Audit

### Routine
- Adding `_webviewReady` (boolean) and `_pendingWebviewMessages` (array) fields near `_panel` (`src/services/KanbanProvider.ts:107-108`).
- Updating `postMessage()` (`src/services/KanbanProvider.ts:1328-1332`) to queue when `!this._webviewReady`.
- Setting `_webviewReady = true` as the FIRST statement in the `ready` case (before `await fullSync`), then draining the queue after the existing `_pendingTab` flush.
- Resetting both fields in both `onDidDispose` handlers (`src/services/KanbanProvider.ts:908-911` and `:946-949`).
- Explicitly setting `_webviewReady = false` at the start of `open()` (after the existing-panel early return, before `createWebviewPanel`) and `deserializeWebviewPanel()` (before `this._panel = panel`) — defense-in-depth so a new panel always starts with a clean slate.

### Complex / Risky
- **`_pendingTab` cannot be replaced by the buffer.** `_pendingTab` is set at `src/services/KanbanProvider.ts:873` — BEFORE `this._panel` is assigned (line 886). `postMessage()` checks `this._panel` (line 1329) and would no-op if the panel doesn't exist. Replacing `_pendingTab` would require restructuring `open()` to set the panel first, then call `postMessage()` — a larger refactor with no practical benefit. Keep `_pendingTab` as-is; the buffer is additive.
- **`deserializeWebviewPanel`** (`src/services/KanbanProvider.ts:925-954`) also creates a panel and sets HTML. The same race applies. `_webviewReady` starts `false` and flips to `true` on `ready`, so restored panels are handled by the same path. The dispose handler at `:946-949` must also reset the flag/queue.
- **Queue growth.** The queue only accumulates during the cold-open window (seconds at most). It is drained exactly once on `ready` and cleared on dispose. Bounded by the number of messages posted during boot — typically zero to a few (ContinuousSyncService timers are 5-60s intervals). No unbounded growth risk.
- **Dispose-during-await resurrection (CRITICAL — fixed in this plan).** The `ready` handler does `await vscode.commands.executeCommand('switchboard.fullSync')` (line 4404), which yields control. If the panel is disposed during that await, the `onDidDispose` handler sets `_webviewReady = false` and clears the queue — correct. But if `_webviewReady = true` were set AFTER the await (as in the original draft), the `ready` handler would resume and re-set it to `true` on a dead panel. The next `open()` wouldn't reset it (no explicit reset), so `postMessage()` during the new cold open would bypass the queue and send to an unready webview — the race returns. **Fix:** set `this._webviewReady = true` as the VERY FIRST statement in `case 'ready':`, before any `await`. The webview IS ready (it just sent `ready`), so this is semantically correct. If dispose fires during the await, it sets the flag back to `false`, and `ready` does not touch it again. Additionally, explicitly reset `_webviewReady = false` at the start of `open()` and `deserializeWebviewPanel()` as defense-in-depth.

## Edge-Case & Dependency Audit

- **No migration concerns.** This changes runtime message flow only. No state schema, no settings, no files-on-disk format change.
- **No confirmation dialogs introduced** (project hard rule). N/A here.
- **Webview build:** Host-side `.ts` edits require `npm run compile` (per CLAUDE.md). No `kanban.html` edits are needed — the `ready` signal and message listener are already in place.
- **`retainContextWhenHidden: true`** (`src/services/KanbanProvider.ts:892`): once a panel is opened, it stays mounted. Warm opens (the common case for active users) do not re-trigger the race — `_webviewReady` stays `true`. The buffer only activates on cold opens and dispose/re-create cycles.
- **Double-drain guard.** If `ready` fires twice (theoretically possible on serialize/deserialize), the queue is already empty after the first drain (`_pendingWebviewMessages = []` before the loop), so the second drain is a no-op. No guard needed beyond the clear-before-drain pattern.
- **Ordering: drain after `_pendingTab` flush.** The `ready` handler already flushes `_pendingTab` at `:4409-4411`. The queue drain should come AFTER this, so if a `switchToTab` was somehow queued via `postMessage` (not via `_pendingTab`), it arrives after the `_pendingTab` flush. In practice `_pendingTab` handles all `switchToTab` cases, so this is belt-and-suspenders.

### Race Conditions
- **Buffer vs. ready race.** If `postMessage()` is called concurrently with the `ready` handler (both are async-adjacent — `postMessage` is sync, `ready` handler is async), the queue could be cleared by `ready` while `postMessage` is mid-push. JavaScript is single-threaded, so this cannot happen — `postMessage` runs to completion before the `ready` handler's microtasks resume. No mutex needed.
- **Dispose-during-await in `ready` handler.** The `ready` handler awaits `fullSync` (line 4404). If the panel is disposed during that await, the dispose handler fires synchronously (setting `_webviewReady = false`, clearing the queue, setting `_panel = undefined`). When `ready` resumes, the drain loop uses `this._panel?.webview.postMessage(m)` (optional chaining → safe no-op) and the queue is already empty (cleared by dispose). Because `_webviewReady = true` is set BEFORE the await (not after), the flag is not re-set to `true` on resume. This race is fully handled.

### Security
- No new trust boundary. The buffer holds the same message objects that would otherwise be sent directly. No user input is introduced.

### Side Effects
- **Slightly delayed message delivery on cold open.** Messages that would have been dropped are now delivered after `ready` fires. This is strictly better than the current behavior (dropped = never delivered).

### Dependencies & Conflicts
- None. This change is internal to `KanbanProvider` and does not touch any other provider or the webview HTML.

## Dependencies

- None. This plan is self-contained within `src/services/KanbanProvider.ts`.

## Adversarial Synthesis

Key risks: (1) dispose-during-await in the `ready` handler could resurrect `_webviewReady = true` on a dead panel if the flag is set after `await fullSync` — fixed by setting it before any await; (2) missing explicit reset in `open()`/`deserializeWebviewPanel()` could leave a stale `true` flag if a prior dispose-during-await occurred — fixed with defense-in-depth resets. Mitigations: set `_webviewReady = true` as the first statement in `case 'ready':`, reset to `false` at the start of both panel-creation methods, and use optional chaining in the drain loop so a disposed panel is a safe no-op.

## Proposed Changes

### 1. `src/services/KanbanProvider.ts` — add readiness flag + message queue

**(a) Fields.** Near `_panel` (`src/services/KanbanProvider.ts:107-108`):

```ts
// BEFORE
private _panel?: vscode.WebviewPanel;
private _pendingTab?: string;
```
```ts
// AFTER
private _panel?: vscode.WebviewPanel;
private _pendingTab?: string;
/** Whether the webview has reported 'ready' (listener registered). */
private _webviewReady = false;
/** Messages queued before the webview reported 'ready'; drained on 'ready'. */
private _pendingWebviewMessages: any[] = [];
```

**(b) `postMessage()` — queue when not ready.** At `src/services/KanbanProvider.ts:1328-1332`:

```ts
// BEFORE
public postMessage(message: any): void {
    if (this._panel) {
        this._panel.webview.postMessage(message);
    }
}
```
```ts
// AFTER
public postMessage(message: any): void {
    if (!this._panel) { return; }
    if (this._webviewReady) {
        this._panel.webview.postMessage(message);
    } else {
        // Cold open: webview JS hasn't registered its message listener yet.
        // Queue and flush on 'ready' so the message isn't silently dropped.
        this._pendingWebviewMessages.push(message);
    }
}
```

**(c) Drain on `ready`.** In the `ready` handler (`src/services/KanbanProvider.ts:4401-4426`), set `_webviewReady = true` as the FIRST statement (before `await fullSync` — the webview IS ready, it just told us), then drain the queue after the existing `_pendingTab` flush (after line 4412, before the remote-control block at 4413):

```ts
case 'ready':
    // Set readiness BEFORE any await. If the panel is disposed during
    // the fullSync await below, the dispose handler resets this to false,
    // and we won't re-set it on resume. Setting it first is semantically
    // correct — the webview's listener IS registered (it just sent 'ready').
    this._webviewReady = true;
    await vscode.commands.executeCommand('switchboard.fullSync');
    {
        const currentTheme = vscode.workspace.getConfiguration('switchboard').get<string>('theme.name', 'afterburner');
        this._panel?.webview.postMessage({ type: 'switchboardThemeNameSetting', theme: currentTheme });
    }
    if (this._pendingTab) {
        this._panel?.webview.postMessage({ type: 'switchToTab', tab: this._pendingTab });
        this._pendingTab = undefined;
    }
    // ── Flush messages queued during cold open ──
    if (this._pendingWebviewMessages.length) {
        const queued = this._pendingWebviewMessages;
        this._pendingWebviewMessages = [];
        for (const m of queued) {
            this._panel?.webview.postMessage(m);
        }
    }
    // ── End flush ──
    // §10 — Constant-mode remote control auto-starts on load.
    {
        const rcRoot = this._resolveWorkspaceRoot(undefined);
        // ... existing remote control code unchanged ...
    }
    break;
```

**(d) Reset on dispose.** Both `onDidDispose` handlers — `src/services/KanbanProvider.ts:908-911` (from `open()`) and `:946-949` (from `deserializeWebviewPanel()`):

```ts
// BEFORE (both occurrences)
this._panel.onDidDispose(() => {
    this._panel = undefined;
    this._lastColumnsSignature = null;
}, null, this._disposables);
```
```ts
// AFTER (both occurrences)
this._panel.onDidDispose(() => {
    this._panel = undefined;
    this._lastColumnsSignature = null;
    this._webviewReady = false;
    this._pendingWebviewMessages = [];
}, null, this._disposables);
```

**(e) Defense-in-depth reset in `open()`.** At `src/services/KanbanProvider.ts:871-884`, after the existing-panel early return (line 884) and before `createWebviewPanel` (line 886):

```ts
// AFTER the existing-panel early return, BEFORE createWebviewPanel:
this._webviewReady = false;
this._pendingWebviewMessages = [];
```

This ensures a fresh panel always starts with the buffer active, even if a prior dispose-during-await left `_webviewReady` stale.

**(f) Defense-in-depth reset in `deserializeWebviewPanel()`.** At `src/services/KanbanProvider.ts:925-929`, before `this._panel = panel` (line 929):

```ts
// BEFORE this._panel = panel:
this._webviewReady = false;
this._pendingWebviewMessages = [];
```

Same rationale — a deserialized panel's JS hasn't loaded yet, so the buffer must be active.

## Verification Plan

1. **Build:** `npm run compile` (webpack) — must succeed with zero TypeScript errors. Only `KanbanProvider.ts` changed; no `kanban.html` edits.
2. **Warm open (no regression):** Open the Kanban board, let it finish loading, switch focus elsewhere, then re-open via `switchboard.openKanban`. The board must appear instantly with fresh data (warm path: `_webviewReady` is `true`, `postMessage` sends directly, `fullSync` runs as before).
3. **Cold open — tab switching (no regression):** Fully close the Kanban panel. Run `switchboard.openKanban` with a tab argument (e.g., via a command that passes a tab). The board must open on the correct tab — `_pendingTab` flush on `ready` is unchanged.
4. **Cold open — queued message delivery:** Fully close the Kanban panel. Trigger a `ContinuousSyncService` action (e.g., start live sync on a plan) that posts `liveSyncUpdate` while the panel is still booting, then immediately open the Kanban board. After `ready` fires, the live sync indicator should reflect the correct state without waiting for the next sync cycle. (This is hard to time manually — the primary proof is that no errors are thrown and the board renders correctly.)
5. **Cold open — no dropped `showStatusMessage`:** Fully close the panel. Trigger an action that calls `postKanbanStatus` (e.g., agent grid creation) while the panel is booting. After `ready`, the status message should appear briefly (it would have been silently dropped before this fix).
6. **Dispose/reset cycle:** Open the board, close it, open it again. Confirm no stale messages from the first session appear in the second (the dispose handler clears the queue).
7. **Dispose-during-ready (edge case):** Cold-open the board, then immediately close the panel while `fullSync` is still running (before the board renders). Re-open the board. Confirm the board loads correctly and messages are properly queued during the second cold open (i.e., `_webviewReady` was correctly reset to `false` by dispose, not left stale at `true`).
8. **Serialize/deserialize:** With `retainContextWhenHidden: true`, hide the panel (switch tabs), reveal it. Confirm `_webviewReady` stays `true` and messages flow normally (no re-queueing on reveal).
9. **No confirmation dialogs introduced** anywhere in the changed paths (project hard rule).

### Automated Tests

- No automated unit/integration tests are added; the race buffer is a runtime message-flow concern that the repo verifies manually (steps 2–8 above).
- **Per session directive, the test suite and `npm run compile` are deferred to the user.** When run, `npm run compile` (webpack) must succeed with zero TypeScript errors.

---

**Recommendation:** Complexity 3/10 → **Send to Intern.**
