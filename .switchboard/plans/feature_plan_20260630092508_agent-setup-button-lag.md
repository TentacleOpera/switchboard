# Fix Lag When Opening Kanban via "Agent Setup" Button

## Goal

### Problem
When the user clicks the **AGENT SETUP** button in the Terminals tab of `implementation.html`, there is a noticeable lag of several seconds before `kanban.html` appears/switches to the Agents tab. Other buttons that open webview panels (Design, Planning/Artifacts, Project) open instantly. This inconsistency degrades the UX and makes the AGENT SETUP button feel broken.

### Background Context
The AGENT SETUP button was introduced by a prior plan (`agent-setup-button-change.md`) which wired the button to send `{ type: 'openKanban', tab: 'agents' }`. That message is handled by `TaskViewerProvider`, which calls `switchboard.openKanban` with the `tab` argument, which in turn calls `KanbanProvider.open('agents')`.

### Root Cause Analysis
The lag is caused by a **redundant, blocking `await` on `switchboard.fullSync`** inside `KanbanProvider.open()`.

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

This is disk-I/O-heavy and takes several seconds. The `switchToTab` message — a pure UI operation that switches the visible tab — is gated behind this sync and cannot execute until it completes.

**Why the `fullSync` is redundant on the reveal path:**

The DB is already kept in sync **proactively** by `TaskViewerProvider`'s file watchers, which are active for the entire lifetime of the extension (set up in the constructor at line 462):

- **Plan watcher** (`_setupPlanWatcher`, line 10404): `vscode.workspace.createFileSystemWatcher` on `.switchboard/plans/**/*.md` — fires `onDidCreate`/`onDidChange` on any plan file change, calls `_handlePlanCreation` → `_syncFilesAndRefreshRunSheets` → `refreshUI` (lightweight DB read that pushes data to both sidebar and kanban).
- **Brain watcher** (`_setupBrainWatcher`, line 10575): watches Antigravity brain plan sources, mirrors to `.switchboard/plans/`, and syncs.
- **Memo watcher** (`_setupMemoWatcher`, line 10538): watches `.switchboard/memo.md`.
- **Configured plan watcher** (`_refreshConfiguredPlanWatcher`, line 11146): watches external configured plan folders.
- **Git commit watcher** (`_setupGitCommitWatcher`, line 10297): re-exports on commit.

These watchers fire on every relevant file change, sync to the DB, and call `refreshUI` — a **lightweight single DB read** (no disk scan) that pushes fresh data to the kanban webview. The board is continuously updated while the panel is open.

The `fullSync` call on reveal is therefore **redundant defensive code** — it re-scans everything from disk that the watchers have already synced. It was likely added as a "just in case" catch-all, but it's the wrong tool: a heavy disk scan where at most a lightweight DB read is needed. The `fullSync` command's own docstring (line 2727) confirms its intended use: *"Called by 'Sync Board' button and startup only"* — not by panel reveal.

**Contrast with other panels** (confirming the root cause):
- `DesignPanelProvider.open()` — reveal + `return` (instant, no sync)
- `PlanningPanelProvider.open()` — reveal + `return` (instant, no sync)
- `SetupPanelProvider.open()` — reveal + `await postSetupPanelState()` (lighter — single state post, no disk scan)

Only `KanbanProvider.open()` awaits a full disk-to-DB sync before sending the tab-switch message.

## Metadata
- **Tags:** [performance, frontend, UX, kanban, backend]
- **Complexity:** 2

## Complexity Audit

### Routine
- Removing the `await fullSync` call from the reveal path in `KanbanProvider.open()`
- Reordering the `switchToTab` postMessage to fire immediately after `reveal()`
- Optionally replacing the heavy `fullSync` with a lightweight `refreshUI` (single DB read, no disk I/O) as a belt-and-suspenders data freshness check
- No new files, no new APIs, no schema changes

### Complex / Risky
- **Stale data edge case:** If a watcher event was somehow missed (e.g. VS Code watcher exclusion, gitignore interference), the board could show stale data on reveal. Mitigation: the plan watcher has a **native `fs.watch` fallback** (line 10430) specifically to catch events VS Code's watcher misses. Additionally, the "Sync Board" button remains available for a manual full rescan. As a final safety net, the fix can include a lightweight `refreshUI` call (DB read only, no disk scan) to push the current DB state to the webview on reveal — this is cheap (<10ms) and guarantees the board shows whatever the DB currently holds.
- **No race condition on `_pendingTab`:** The `_pendingTab` field is read and cleared synchronously before any async work, so there is no risk of a second `open()` call interleaving and stealing the pending tab.

## Edge-Case & Dependency Audit

- **Race Conditions:** The `switchToTab` postMessage is sent synchronously after `reveal()` and before any async work. Since `_pendingTab` is cleared in the same synchronous block, a concurrent `open()` call cannot interleave and lose the tab.
- **New panel path (panel does not exist):** The new-panel branch (lines 941–983) is unchanged. It creates the panel, loads HTML, and relies on the `ready` message from the webview to trigger sync. The `_pendingTab` is already dispatched in the `ready` handler (per the prior plan). No change needed there.
- **Backward compatibility:** `open()` called without a `tab` argument still works — `_pendingTab` stays `undefined`, no `switchToTab` is sent. The board still gets fresh data via watchers + optional lightweight `refreshUI`.
- **Status bar / command palette callers:** `switchboard.openKanban` is also invoked from the status bar item (line 1909) and command palette (line 2195) without a `tab` argument. These callers benefit from the same speedup (instant reveal) with no behavior change.
- **"Sync Board" button still works:** The manual `fullSync` path is untouched — it's still triggered by the `refresh` message handler (line 5047) and the `ready` handler on first panel creation (line 4979). Users can always force a full rescan.
- **Security:** No new user input, no new data paths. The `tab` parameter is a hardcoded string from the implementation sidebar.
- **Dependencies & Conflicts:** No test currently asserts the ordering of `fullSync` vs `switchToTab`. The change is a removal + reorder with no external API impact.

## Proposed Changes

### `/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts`

**Context:** The `open()` method (line 926) reveals the panel, then blocks on `fullSync` before sending the tab-switch message. The `fullSync` is redundant because `TaskViewerProvider`'s file watchers already keep the DB synced proactively.

**Logic:** Remove the blocking `fullSync` call from the reveal path. Send the `switchToTab` message immediately after `reveal()`. Replace the heavy `fullSync` with a lightweight `refreshUI` (single DB read, no disk I/O) as a cheap safety net to push current DB state to the webview.

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
    // Switch the visible tab immediately — do NOT gate on fullSync.
    // The DB is kept in sync proactively by TaskViewerProvider's file watchers
    // (plan watcher, brain watcher, etc.), which call refreshUI on every file
    // change. A fullSync here is redundant and blocks for seconds while scanning
    // all session files from disk. Use lightweight refreshUI (single DB read) as
    // a cheap safety net to push current DB state to the webview.
    if (this._pendingTab) {
        this._panel.webview.postMessage({ type: 'switchToTab', tab: this._pendingTab });
        this._pendingTab = undefined;
    }
    void vscode.commands.executeCommand('switchboard.refreshUI');
    return;
}
```

**Edge Cases:**
- If `_pendingTab` is undefined (no tab requested), only the lightweight `refreshUI` runs — pushes current DB state to the board without any disk scan.
- `refreshUI` is a single DB read (<10ms) that feeds both sidebar and kanban. It does NOT scan files from disk. The watchers handle file→DB sync.
- If a watcher event was genuinely missed, the board will show slightly stale data until the next watcher event or a manual "Sync Board" click. This is the same tradeoff every other panel already makes (they don't sync on reveal at all).

### No other files require changes

- `implementation.html` — button handler is correct (`{ type: 'openKanban', tab: 'agents' }`)
- `TaskViewerProvider.ts` — message handler correctly passes `data.tab` to the command; `refreshUI` method (line 2748) already exists and is the lightweight refresh path
- `extension.ts` — command registration correctly passes `tab` to `kanbanProvider.open(tab)`; `switchboard.refreshUI` command is already registered
- `kanban.html` — `switchToTab` handler (line 6016) correctly clicks the target tab button

The entire fix is a removal of one blocking `await` + reorder + lightweight replacement in a single method.

## Verification Plan

### Manual Verification
- [ ] Open the implementation sidebar, go to the Terminals tab, click **AGENT SETUP** — the Kanban panel should reveal and switch to the Agents tab **instantly** (sub-second)
- [ ] With the Kanban panel already open on a different tab (e.g. KANBAN), click **AGENT SETUP** — the tab should switch to Agents immediately, without the multi-second delay previously observed
- [ ] With the Kanban panel closed, click **AGENT SETUP** — the panel should open and land on the Agents tab (new-panel path unchanged)
- [ ] Click the Kanban status bar item (no tab arg) — panel reveals instantly, default KANBAN tab shown
- [ ] Open Kanban via command palette — same instant reveal behavior
- [ ] Verify board data is current on reveal (watchers + lightweight `refreshUI` push current DB state) — create a plan file in `.switchboard/plans/` while board is open, switch to another tab, click AGENT SETUP, confirm the new card is visible
- [ ] Verify the onboarding-state AGENT SETUP button (shown when no agents connected) also opens without lag

### Regression Checks
- [ ] Other panels (Design, Artifacts/Planning, Project) still open instantly — no change to their providers
- [ ] "Sync Board" button still triggers a full `fullSync` (manual rescan path untouched)
- [ ] File watchers still push updates to the board on plan file changes (add/modify a plan file while board is visible, confirm card appears/updates without manual sync)
- [ ] No console errors in the developer tools for either the implementation sidebar or kanban webview
