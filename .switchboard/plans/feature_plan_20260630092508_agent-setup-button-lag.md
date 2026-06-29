# Fix Lag When Opening Kanban via "Agent Setup" Button

## Goal

### Problem
When the user clicks the **AGENT SETUP** button in the Terminals tab of `implementation.html`, there is a noticeable lag of several seconds before `kanban.html` appears/switches to the Agents tab. Other buttons that open webview panels (Design, Planning/Artifacts, Project) open instantly. This inconsistency degrades the UX and makes the AGENT SETUP button feel broken.

### Background Context
The AGENT SETUP button was introduced by a prior plan (`agent-setup-button-change.md`) which wired the button to send `{ type: 'openKanban', tab: 'agents' }`. That message is handled by `TaskViewerProvider`, which calls `switchboard.openKanban` with the `tab` argument, which in turn calls `KanbanProvider.open('agents')`.

### Root Cause Analysis
The lag is caused by a **blocking `await` on `switchboard.fullSync`** inside `KanbanProvider.open()`.

In `KanbanProvider.ts` (lines 930–938), when the kanban panel already exists (the common case after first open):

```typescript
if (this._panel) {
    this._panel.reveal(vscode.ViewColumn.One);
    // Trigger unified refresh so the board gets fresh data
    await vscode.commands.executeCommand('switchboard.fullSync');   // ← BLOCKS for seconds
    if (this._pendingTab) {
        this._panel.webview.postMessage({ type: 'switchToTab', tab: this._pendingTab });
        this._pendingTab = undefined;
    }
    return;
}
```

`switchboard.fullSync` dispatches to `TaskViewerProvider.fullSync()` (lines 2729–2742), which:
1. Posts a `loading` flag to the sidebar webview
2. **Awaits** `Promise.all` of: `_refreshSessionStatus()`, `_refreshTerminalStatuses()`, `_syncFilesAndRefreshRunSheets()` (reads **ALL** session files from disk → syncs to DB), `_refreshJulesStatus()`
3. Clears the `loading` flag

This is disk-I/O-heavy and takes several seconds. The `switchToTab` message — a pure UI operation that switches the visible tab — is gated behind this sync and cannot execute until it completes. The panel is *revealed* instantly by `this._panel.reveal()`, but the tab doesn't switch (and for a new panel, the board doesn't render its data) until `fullSync` finishes, creating the perceived lag.

**Contrast with other panels** (confirming the root cause):
- `DesignPanelProvider.open()` — reveal + `return` (instant, no sync)
- `PlanningPanelProvider.open()` — reveal + `return` (instant, no sync)
- `SetupPanelProvider.open()` — reveal + `await postSetupPanelState()` (lighter — single state post, no disk scan)

Only `KanbanProvider.open()` awaits a full disk-to-DB sync before sending the tab-switch message.

## Metadata
- **Tags:** [performance, frontend, UX, kanban, backend]
- **Complexity:** 3

## Complexity Audit

### Routine
- Reordering two statements in `KanbanProvider.open()` so the `switchToTab` postMessage fires before the sync
- Changing `await fullSync` to fire-and-forget (`void`) in the reveal path so it doesn't block the return
- No new files, no new APIs, no schema changes

### Complex / Risky
- **Stale data on tab open:** If fullSync is made fire-and-forget, the Agents tab may briefly render with stale data before the sync completes and pushes fresh data. This is acceptable — the tab switch is instant, and the sync-driven refresh arrives moments later (the webview already handles incremental `refreshUI`/data-push messages). This is the same tradeoff every other panel already makes (they don't sync on reveal at all).
- **No race condition on `_pendingTab`:** The `_pendingTab` field is read and cleared synchronously before any async work, so there is no risk of a second `open()` call interleaving and stealing the pending tab.

## Edge-Case & Dependency Audit

- **Race Conditions:** The `switchToTab` postMessage is sent synchronously after `reveal()` and before any `await`. Since `_pendingTab` is cleared in the same synchronous block, a concurrent `open()` call cannot interleave and lose the tab. The fire-and-forget `fullSync` runs concurrently but does not touch `_pendingTab`.
- **New panel path (panel does not exist):** The new-panel branch (lines 941–983) is unchanged. It creates the panel, loads HTML, and relies on the `ready` message from the webview to trigger sync. The `_pendingTab` is already dispatched in the `ready` handler (per the prior plan). No change needed there.
- **Backward compatibility:** `open()` called without a `tab` argument still works — `_pendingTab` stays `undefined`, no `switchToTab` is sent, and fullSync still runs (now fire-and-forget). The board still gets fresh data, just non-blockingly.
- **Status bar / command palette callers:** `switchboard.openKanban` is also invoked from the status bar item (line 1909) and command palette (line 2195) without a `tab` argument. These callers benefit from the same speedup (non-blocking reveal) with no behavior change.
- **Security:** No new user input, no new data paths. The `tab` parameter is a hardcoded string from the implementation sidebar.
- **Dependencies & Conflicts:** No test currently asserts the ordering of `fullSync` vs `switchToTab`. The change is internal reordering with no external API impact.

## Proposed Changes

### `/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts`

**Context:** The `open()` method (line 926) reveals the panel, then blocks on `fullSync` before sending the tab-switch message.

**Logic:** Send the `switchToTab` message **immediately** after `reveal()` and before any sync work. Make the `fullSync` call fire-and-forget (`void`, not `await`) so the method returns instantly and the webview receives the tab switch without delay. The sync still runs and pushes fresh data to the board when it completes.

**Implementation:**

Replace lines 930–938:
```typescript
if (this._panel) {
    this._panel.reveal(vscode.ViewColumn.One);
    // Trigger unified refresh so the board gets fresh data
    await vscode.commands.executeCommand('switchboard.fullSync');
    if (this._pendingTab) {
        this._panel.webview.postMessage({ type: 'switchToTab', tab: this._pendingTab });
        this._pendingTab = undefined;
    }
    return;
}
```

with:
```typescript
if (this._panel) {
    this._panel.reveal(vscode.ViewColumn.One);
    // Switch the visible tab immediately — do NOT gate on fullSync (which scans
    // session files from disk and takes seconds). The sync runs concurrently and
    // pushes fresh data to the board when it completes.
    if (this._pendingTab) {
        this._panel.webview.postMessage({ type: 'switchToTab', tab: this._pendingTab });
        this._pendingTab = undefined;
    }
    // Fire-and-forget: refresh board data in the background without blocking reveal.
    void vscode.commands.executeCommand('switchboard.fullSync');
    return;
}
```

**Edge Cases:**
- If `_pendingTab` is undefined (no tab requested), only the fire-and-forget `fullSync` runs — same as before, just non-blocking.
- The `fullSync` → `refreshUI` pipeline already pushes data incrementally to the webview, so the board updates when the sync completes without any additional wiring.

### No other files require changes

- `implementation.html` — button handler is correct (`{ type: 'openKanban', tab: 'agents' }`)
- `TaskViewerProvider.ts` — message handler correctly passes `data.tab` to the command
- `extension.ts` — command registration correctly passes `tab` to `kanbanProvider.open(tab)`
- `kanban.html` — `switchToTab` handler (line 6016) correctly clicks the target tab button

The entire fix is a 2-statement reorder + `await` → `void` change in a single method.

## Verification Plan

### Manual Verification
- [ ] Open the implementation sidebar, go to the Terminals tab, click **AGENT SETUP** — the Kanban panel should reveal and switch to the Agents tab **instantly** (sub-second), with board data populating moments later
- [ ] With the Kanban panel already open on a different tab (e.g. KANBAN), click **AGENT SETUP** — the tab should switch to Agents immediately, without the multi-second delay previously observed
- [ ] With the Kanban panel closed, click **AGENT SETUP** — the panel should open and land on the Agents tab (new-panel path unchanged)
- [ ] Click the Kanban status bar item (no tab arg) — panel reveals instantly, default KANBAN tab shown, data syncs in background
- [ ] Open Kanban via command palette — same instant reveal behavior
- [ ] Verify board data still refreshes correctly after the fire-and-forget sync completes (cards appear/update within a second or two of reveal)
- [ ] Verify the onboarding-state AGENT SETUP button (shown when no agents connected) also opens without lag

### Regression Checks
- [ ] Other panels (Design, Artifacts/Planning, Project) still open instantly — no change to their providers
- [ ] `switchboard.fullSync` still runs and updates the board — verify by adding a plan file to `.switchboard/plans/` while the board is open, clicking AGENT SETUP, and confirming the new card appears after the background sync completes
- [ ] No console errors in the developer tools for either the implementation sidebar or kanban webview
