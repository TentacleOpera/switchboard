# Fix: Project panel not refreshing — stale/empty plans until close-and-reopen

## Goal

Make the Project panel (`project.html` / `project.js`) reliably show current plans without requiring the user to close and reopen it. Currently, the panel's Kanban tab shows stale or empty plan data after the panel has been hidden and re-shown, or after the extension re-activates. Closing and reopening the panel fixes it because a fresh webview triggers a new `fetchKanbanPlans`, but the persisted webview never re-fetches on its own.

### Problem / background / root cause

The Project panel is created with `retainContextWhenHidden: true` (`PlanningPanelProvider.ts:353`), which preserves the webview's JS state when the panel is hidden. This is intentional — it prevents the webview from rebooting on every tab switch. But it creates a stale-data problem:

**Root cause: No re-fetch trigger when the panel becomes visible again.**

1. **No `onDidChangeViewState` handler.** Neither `PlanningPanelProvider` (Project panel) nor `KanbanProvider` (Kanban board) registers an `onDidChangeViewState` listener. When the panel is hidden and then shown again, the webview's JS state is preserved — the initial `fetchKanbanPlans` (`project.js:391`) only runs once during webview boot. No re-fetch is triggered on visibility change. If plans changed while the panel was hidden, the user sees stale data.

2. **`openProject()` short-circuits on existing panel.** When the panel already exists (`this._projectPanel` is truthy), `openProject()` (`PlanningPanelProvider.ts:342-344`) calls `reveal()` and returns immediately — it does NOT trigger a re-fetch. So if the panel was restored by VS Code (via `deserializeProjectPanel`) and the initial fetch returned empty or stale data, the user has no way to refresh it except by closing and reopening.

3. **Initial full fetch can be discarded by a concurrent fetch request.** The `fetchKanbanPlans` handler has a request-ID guard — an entry check at `PlanningPanelProvider.ts:3452` and a post-loop check at `PlanningPanelProvider.ts:3501` (`if (requestId !== this._latestRequestIds.get(guardKey)) { break; }`). The full fetch loops over every allowed root with awaited DB queries (`PlanningPanelProvider.ts:3465-3500`), so it has a real async window. The guard key `'kanban-plans'` is bumped ONLY by another `fetchKanbanPlans` request — a proactive `kanbanPlansReady` push (a separate message case, e.g. `PlanningPanelProvider.ts:3671`) does NOT bump it. So the post-loop guard trips when a SECOND `fetchKanbanPlans` is queued while the first is still running (e.g. the user clicks the Kanban tab while the boot fetch is in flight, or the new `refreshKanbanPlans` trigger fires concurrently with a tab activation). When the guard trips, the first fetch's full response is dropped via `break`. (Clarification of the original framing, which attributed the discard to a proactive push: the push does not touch the guard, but it does prime the cache with partial data — see root cause 4.)

4. **Partial cache update can fragment the cache.** Proactive pushes set `msg.workspaceRoot` (e.g. `PlanningPanelProvider.ts:3671`, and the feature-subtask/feature-delete pushes at `3799, 3824, 3857`), triggering the partial cache update path in `project.js` (`project.js:465-469`):
   ```js
   _kanbanPlansCache = [
       ..._kanbanPlansCache.filter(p => p.workspaceRoot !== msg.workspaceRoot),
       ...(msg.plans || [])
   ];
   ```
   This replaces plans for ONE workspace only. If the initial full fetch (which sets the entire cache via the `else` branch at `project.js:470-472`) was discarded by the concurrent-fetch guard (root cause 3), the cache only has plans from whichever workspaces happened to send proactive pushes — not all workspaces. Note: a partial push landing AFTER a successful full fetch is correct (it reflects a real change to one workspace); the bug is specifically the full fetch being dropped while a partial push has primed the cache with incomplete data.

**Why it only started recently:** The proactive push mechanism was added/enhanced in recent commits (the `kanbanPlansReady` push after complexity edits, column changes, feature-subtask add/remove, feature delete, etc. — `PlanningPanelProvider.ts:3671, 3799, 3824, 3857`). Before these pushes existed, the initial fetch was the only source of data, and even if a concurrent fetch dropped it the cache would simply be empty (visibly broken) rather than silently partial. Now, a partial push can prime the cache with one workspace's plans, and a concurrent fetch dropping the full response leaves the user looking at that one workspace's data thinking it is complete.

**Why closing and reopening fixes it:** Closing fires `onDidDispose`, clearing `_projectPanel`. Reopening calls `openProject()`, which creates a fresh webview. The fresh webview boots, sends `fetchKanbanPlans`, and — if no proactive push races with it — gets the full response. The cache is populated correctly.

## Metadata

**Tags:** backend, ui, bugfix, reliability
**Complexity:** 3
**Project:** v5 funnel

## User Review Required

No — this is a pure bugfix to existing refresh/re-fetch plumbing. No product-scope change, no new user-facing setting, no data migration. The new `refreshKanbanPlans` message type and `_fullKanbanPlansSent` flag are internal implementation details. Safe to proceed to coding without user sign-off, provided the implementer preserves the existing `retainContextWhenHidden` behavior and the ready-handshake queue (`_projectPanelReady` / `_pendingProjectMessages`).

## Complexity Audit

### Routine
- Registering `onDidChangeViewState` handlers in `openProject()`, `_hydratePanel()` (isProject branch), and the kanban open/`deserializeWebviewPanel` paths — each is a small, self-contained listener registration mirroring the existing `onDidDispose` pattern.
- Adding the `refreshKanbanPlans` case to the `project.js` message switch — one-line `vscode.postMessage` echo.
- The `openProject()` existing-panel refresh trigger — a guarded `postMessage` inside the existing short-circuit branch.

### Complex / Risky
- The `_fullKanbanPlansSent` guard-race fix: introducing a new boolean field that changes the dedup semantics of the `fetchKanbanPlans` handler. Risk of sending a STALE full response that clobbers a newer fetch's fresher data if the newer full fetch completes AFTER the stale one is force-sent. Mitigation: the newer full fetch still sends its own `kanbanPlansReady` (the flag only forces the LOSING fetch to send), and the webview processes messages in order, so the fresher full response lands last and wins. Still requires care that the flag is reset on every new request start and not left true across a panel lifecycle.
- `onDidChangeViewState` fires on EVERY visibility toggle, including rapid tab switching. Each visible=true posts `refreshKanbanPlans` → `fetchKanbanPlans`. Without dedup this can storm the extension host with concurrent full fetches (which is itself the race in root cause 3). Mitigation: the request-ID guard at `PlanningPanelProvider.ts:3452/3501` dedupes the host side, but the webview should debounce or skip if a fetch is already in flight (note for implementer).

## Edge-Case & Dependency Audit

**Race Conditions:**
- *Visibility-toggle fetch storm:* Rapid tab switching fires multiple `refreshKanbanPlans` → `fetchKanbanPlans`. The host guard dedupes by requestId, but the webview may queue redundant requests. Recommend a webview-side in-flight guard or debounce (200ms) in the `refreshKanbanPlans` handler.
- *Stale-full-response clobber:* Covered in Complex/Risky above — the ordering guarantee (loser-sends-first, winner-sends-last) makes this safe, but the implementer must confirm `_postToBothPanels` preserves send order.
- *Restored panel double-registration:* `_hydratePanel` and `deserializeWebviewPanel` must not register `onDidChangeViewState` twice for the same panel (would double-fire refreshes). Use the same disposable-tracking pattern as `onDidDispose`.

**Security:** No new attack surface — all messages are internal webview↔host postMessage, no external input parsing, no file-path interpolation from user input.

**Side Effects:**
- A visibility refresh re-runs `fetchKanbanPlans`, which re-reads every workspace's kanban DB. On large multi-workspace setups this is non-trivial work on every tab focus. Acceptable for correctness; consider a "data changed while hidden" dirty flag optimization later (out of scope here).
- The kanban board `_refreshBoard` on visibility re-pushes the full board snapshot; the existing `_lastBoardSnapshotHash` dedup (`KanbanProvider.ts:1270`) should suppress no-op re-renders.

**Dependencies & Conflicts:**
- Sibling subtask "Fix: Review Plan button shows wrong plans after switching workspace" touches the same `project.js` `kanbanPlansReady` handler and `PlanningPanelProvider.ts` push sites. Coordinate the merge so both edits to `project.js` land cleanly. This plan's `refreshKanbanPlans` trigger and the sibling's `_pendingKanbanSelection` guard are in different code paths but share the `kanbanPlansReady` consumer.
- No dependency on any other feature. The ready-handshake queue (`_projectPanelReady` / `_pendingProjectMessages`) must remain untouched — the new `refreshKanbanPlans` post goes through the same `postMessageToProjectWebview` queueing path.

## Dependencies

- None (no prior session dependency). This is a standalone refresh/reliability bugfix.
- Coordination dependency (not blocking): sibling subtask `feature_plan_20260707100604_review-plan-button-wrong-plans-after-workspace-switch.md` — both edit `project.js` and `PlanningPanelProvider.ts`; merge sequentially.

## Adversarial Synthesis

Key risks: (1) visibility-toggle fetch storms and (2) the `_fullKanbanPlansSent` stale-full-response clobber. Mitigations: webview-side in-flight guard/debounce on `refreshKanbanPlans`, and reliance on postMessage ordering so the winning (fresher) full fetch lands last. The original root-cause-3 framing (proactive push trips the guard) was corrected: only a concurrent `fetchKanbanPlans` trips the guard; the push only primes partial cache. The fix remains valid for the real concurrent-fetch race. Recommendation: complexity 3 — **Send to Coder**.

## Proposed Changes

### src/services/PlanningPanelProvider.ts

**Change 1: Re-fetch when the Project panel becomes visible**

Register an `onDidChangeViewState` handler in `openProject()` (after the panel is created) and in `_hydratePanel()` (for restored panels). When the panel becomes visible, trigger a re-fetch by sending a `fetchKanbanPlans` message to the webview:

```js
// In openProject(), after the onDidDispose block (PlanningPanelProvider.ts:404):
this._projectPanel.onDidChangeViewState(
    (e) => {
        if (e.webviewPanel.visible) {
            // Panel became visible — re-fetch plans in case data changed while hidden.
            // The webview's JS state is preserved (retainContextWhenHidden), so this
            // does NOT re-boot. We must explicitly trigger a refresh.
            this._projectPanel?.webview.postMessage({ type: 'refreshKanbanPlans' });
        }
    },
    null,
    this._disposables
);
```

In `_hydratePanel()` (for restored panels), add the same handler after the `isProject` dispose-handler block (`PlanningPanelProvider.ts:716`):

```js
if (isProject) {
    panel.onDidChangeViewState(
        (e) => {
            if (e.webviewPanel.visible) {
                this._projectPanel?.webview.postMessage({ type: 'refreshKanbanPlans' });
            }
        },
        null,
        this._disposables
    );
}
```

**Change 2: Re-fetch when `openProject()` is called on an existing panel**

In `openProject()`, when the panel already exists, send a refresh trigger instead of just revealing:

```js
// BEFORE (PlanningPanelProvider.ts:342-344):
if (this._projectPanel) {
    this._projectPanel.reveal(vscode.ViewColumn.One);
    return;
}

// AFTER:
if (this._projectPanel) {
    this._projectPanel.reveal(vscode.ViewColumn.One);
    // The panel already exists (either restored or previously opened). Its webview
    // state is preserved (retainContextWhenHidden), so the initial fetchKanbanPlans
    // (project.js:390) did NOT re-fire. Trigger a refresh so the user sees current
    // data instead of stale cache from when the panel was last visible.
    if (this._projectPanelReady) {
        this._projectPanel.webview.postMessage({ type: 'refreshKanbanPlans' });
    }
    return;
}
```

**Change 3: Fix the request-ID guard race**

The post-loop guard at `PlanningPanelProvider.ts:3501` discards the initial full fetch's response if any other `fetchKanbanPlans` request was processed while it was running (the entry guard is at `:3452`). This is correct for deduplication (a newer request supersedes an older one), but it means the initial full fetch can be silently discarded, leaving the webview with only partial data from whatever proactive push happened to prime the cache.

Fix: When the initial full fetch (the one without `msg.workspaceRoot`) is about to be discarded by the guard, send it anyway if no full-fetch response has been sent yet. Track this with a boolean:

```js
// Add a field:
private _fullKanbanPlansSent = false;

// In the fetchKanbanPlans handler, reset it when the request starts:
case 'fetchKanbanPlans': {
    // ... existing guard check ...
    this._fullKanbanPlansSent = false;
    try {
        // ... existing fetch logic ...
        
        // BEFORE the post-loop guard check at PlanningPanelProvider.ts:3501:
        if (requestId !== this._latestRequestIds.get(guardKey)) {
            // A newer request was processed while we were running. If we haven't
            // sent a full response yet, send it anyway — partial proactive pushes
            // may have arrived but they don't cover all workspaces. The full
            // response is the only way to populate the complete cache.
            if (!this._fullKanbanPlansSent) {
                this._postToBothPanels({
                    type: 'kanbanPlansReady',
                    plans: allPlans,
                    workspaceItems,
                    allWorkspaceProjects,
                    columns: mergedColumns,
                    kanbanWorkspaceRoot: this._kanbanProvider?.getCurrentWorkspaceRoot() || null,
                    requestId
                });
                this._fullKanbanPlansSent = true;
            }
            break;
        }
        // ... existing response sending ...
        this._fullKanbanPlansSent = true;
    }
}
```

### src/webview/project.js

**Change 4: Handle the `refreshKanbanPlans` message**

Add a handler for the new `refreshKanbanPlans` message type that triggers a `fetchKanbanPlans`:

```js
case 'refreshKanbanPlans':
    vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });
    break;
```

This goes in the message-handler switch (`project.js:398+`), e.g. adjacent to `case 'kanbanPlansReady':` at `project.js:451`.

### src/services/KanbanProvider.ts

**Change 5: Re-fetch when the Kanban board becomes visible**

Register an `onDidChangeViewState` handler for the kanban panel. The kanban board already has a `_refreshBoard` mechanism — just call it when the panel becomes visible. The kanban panel is created in the open method at `KanbanProvider.ts:1239` (onDidDispose block at `:1261-1276`); restored kanban panels come through `deserializeWebviewPanel` at `KanbanProvider.ts:1290`. Register the handler in BOTH sites:

```js
// In the kanban open method, after the onDidDispose block (KanbanProvider.ts:1276):
this._panel.onDidChangeViewState(
    (e) => {
        if (e.webviewPanel.visible && this._currentWorkspaceRoot) {
            this._refreshBoard(this._currentWorkspaceRoot);
        }
    },
    null,
    this._disposables
);
```

Mirror the same registration in `deserializeWebviewPanel` (`KanbanProvider.ts:1290+`) so a restored kanban panel also re-fetches on first visibility. Guard against double-registration if `deserializeWebviewPanel` reuses the open path.

## Verification Plan

1. **Repro the bug:** Open the Project panel. Switch to another editor tab. Wait a moment (or trigger a kanban board refresh from the kanban panel). Switch back to the Project panel. Observe: the Kanban tab shows stale data (or no plans if the initial fetch was discarded).
2. **Apply fixes** (build/install via VSIX; do NOT run `npm run compile` per session directive — `src/` is the source of truth and `dist/` is not used during dev/testing).
3. **Test visibility re-fetch:** Open the Project panel. Switch to another tab. Switch back. Verify: the Kanban tab re-fetches and shows current plans (check the browser console for a `fetchKanbanPlans` message on visibility change).
4. **Test `openProject()` on existing panel:** With the Project panel already open, run the "Switchboard: Open Project" command. Verify: the panel is revealed AND a re-fetch is triggered (plans update).
5. **Test guard-race fix (concurrent fetch, not proactive push):** The post-loop guard at `PlanningPanelProvider.ts:3501` trips only on a SECOND `fetchKanbanPlans`, not on a proactive push. Repro: open the Project panel (boot `fetchKanbanPlans` fires at `project.js:391`); while that full fetch is still in its async root-loop (a large multi-workspace setup makes the window easier to hit), click the Kanban tab to fire a second `fetchKanbanPlans` (`project.js` tab-click handler). Verify: the Project panel still ends up with all plans from all workspaces (the `_fullKanbanPlansSent` fallback sends the full response even when the boot fetch's guard trips). Separately, trigger a partial proactive push (edit a plan's complexity from the kanban panel → `PlanningPanelProvider.ts:3671`) while a full fetch is in flight AND a second fetch is queued: verify the cache is not left stuck on one workspace's partial data.
6. **Test kanban board visibility:** Open the Kanban board. Switch to another tab. Trigger a plan change (e.g. create a plan from the CLI). Switch back to the Kanban board. Verify: the board refreshes and shows the new plan.
7. **Test restored panel:** Enable `persistPanels`. Open the Project panel. Reload the VS Code window. Verify: the restored Project panel shows current plans (the `onDidChangeViewState` handler fires on first visibility, triggering a re-fetch).
8. **Automated tests:** Skipped per session directive (do NOT run `npm test` as part of this verification). Rely on the manual repro steps above; run the existing webview/kanban regression tests in a follow-up session if desired.

**Stage Complete:** PLAN REVIEWED
