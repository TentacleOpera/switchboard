# Fix Terminal Disconnect on Minimize

## Goal
When the user minimizes the IDE and then restores it, all sidebar terminals should remain connected if the underlying terminal processes are still running. Fix the minimize/restore path so the UI and terminal command routing re-synchronize instead of showing stale disconnected agents.

## Metadata
**Tags:** UI, bugfix
**Complexity:** 4

## User Review Required
> [!NOTE]
> - Scope stays limited to the minimize/restore terminal desynchronization bug.
> - Do not change terminal ownership rules, heartbeat thresholds, or cross-IDE reclaim behavior as part of this fix.
> - **Clarification:** Reuse the existing `syncTerminalRegistryWithState()` reclaim path in `src/extension.ts`; do not add a second registry-rebuild mechanism.
> - **Clarification:** The sidebar repaint still flows through `TaskViewerProvider.refresh()` / `_refreshTerminalStatuses()`, so the restore handler must schedule that refresh after re-syncing terminals.
> - **Recommended Agent:** Send to Coder

## Complexity Audit
### Routine
- Update the focused-window branch in `src/extension.ts:1636-1641` so it reuses `syncTerminalRegistryWithState(workspaceRoot)` on restore instead of only refreshing MCP status and scanning inboxes.
- Keep the existing `refreshMcpStatus().catch(() => { });` and `inboxWatcher?.triggerScan();` calls intact in the same restore path.
- Add a follow-up `taskViewerProvider.refresh()` so the sidebar recomputes `terminalStatuses` from `.switchboard/state.json` and live VS Code terminals after the registry sync completes.
- Add a focused source-regression test in `src/test/terminal-disconnect-on-minimize-regression.test.js`.

### Complex / Risky
- Minimize/restore can race with the existing startup, state-watcher, and terminal-open resync paths. The fix must go through the existing `syncInFlight` / `syncPending` serialization in `syncTerminalRegistryWithState()` (`src/extension.ts:1671-1687`) rather than introducing a second reclaim flow.
- The original draft underestimates the UI half of the bug: `TaskViewerProvider._refreshTerminalStatuses()` (`src/services/TaskViewerProvider.ts:11740-11897`) derives the sidebar's connected/disconnected state from `.switchboard/state.json` plus `vscode.window.terminals`, not from the extension's private map alone. A restore-time registry sync without a sidebar refresh can fix command routing while leaving the UI stale.
- Preserve the existing PID-based reclaim, name fallback, and `ideName` cross-IDE gate in `_syncTerminalRegistryWithStateImpl()` (`src/extension.ts:1689-1760`). Broadening that logic while fixing a focus bug would create a far worse terminal-ownership bug.

## Edge-Case & Dependency Audit
- **Race Conditions:** The restore-time focus event can fire while `state.json` watchers (`src/extension.ts:1589-1605`) or terminal-open hooks (`src/extension.ts:1574-1580`) are also requesting a registry sync. Reusing `syncTerminalRegistryWithState()` keeps those concurrent calls coalesced by the existing `syncInFlight` / `syncPending` guards. `TaskViewerProvider.refresh()` is already debounced (`src/services/TaskViewerProvider.ts:1318-1332`), so adding it to the focus path should not create a refresh storm.
- **Security:** No credential, authentication, or file-permission surface changes. Keep the existing `sendToTerminal` source-metadata validation (`src/extension.ts:566-646`) and the current cross-IDE ownership gates untouched.
- **Side Effects:** If a terminal actually closed while the window was minimized, the restore flow should continue to show it as disconnected. If the terminal survived, the restore flow should reclaim it and repaint the sidebar. The original symptom notes still apply and should stay covered by the fix: VS Code's extension host may throttle during minimize, the webview can return with stale UI state, and the `InboxWatcher` / terminal registry path can drift from live `vscode.window.terminals` without a restore-time reclaim. **Clarification:** the existing `syncTerminalRegistryWithState()` block already updates `InboxWatcher` with the rebuilt registry, so command routing and folder scanning should recover through that existing path instead of duplicating registry propagation code elsewhere. New terminals created while minimized should continue to be picked up by the existing `state.json` watcher path on the next state change.
- **Dependencies & Conflicts:** `switchboard-get_kanban_state` shows no active plans in **New** and four other active plans in **Planned**. Based on the current plan files in `.switchboard/plans/`, none is a direct dependency for this bugfix:
  - `fix_disable_clipboard_import_brain_promotion.md` targets `src/services/TaskViewerProvider.ts` clipboard/brain promotion logic, not the terminal restore path in `src/extension.ts`.
  - `brain_f0df2dc1687320b9685b43413e91ac53e7b8ceaedca3083dd769c0e19de4f4b7_antigravity_brain_plans_still_not_being_detected.md` currently points at `src/services/TaskViewerProvider.ts::_isLikelyPlanFile`; the plan is incomplete, so its eventual file surface is not fully proven, but no `src/extension.ts` overlap is presently documented.
  - `simplify_clickup_automation.md` is ClickUp automation/service work (`src/services/ClickUp*`, `src/services/KanbanProvider.ts`, `src/webview/setup.html`), unrelated to terminal focus restore.
  - `restore_completed_column_visibility_and_preserve_completed_status.md` targets `src/services/TaskViewerProvider.ts` and `src/services/KanbanDatabase.ts`; no direct dependency or conflict with the focus-handler change is documented.
  - Net: no blocking active dependency. The only mild merge-awareness item is the incomplete Antigravity detection plan because its final implementation surface is not yet fully specified.

## Adversarial Synthesis
### Grumpy Critique
> Oh, good — another “tiny one-line fix” that allegedly solves a stale UI bug by sprinkling one more function call into a focus handler and praying the rest of the extension sorts itself out. That is how you ship fake fixes. The current draft talks as if re-syncing `registeredTerminals` alone will heal the sidebar. It will not. The actual sidebar connected/disconnected state is recalculated in `TaskViewerProvider._refreshTerminalStatuses()` from `.switchboard/state.json` and `vscode.window.terminals`. If you skip the follow-up `taskViewerProvider.refresh()`, you can easily recover `sendToTerminal` while the user still stares at a sidebar full of “disconnected” agents and reports the bug as unresolved.  
>
> And do not get clever with the reclaim path. `syncTerminalRegistryWithState()` already serializes concurrent calls with `syncInFlight` / `syncPending`. If this fix invents a second restore-only reclaim flow or weakens the existing PID/name + `ideName` checks, congratulations: you just traded a minimize glitch for a cross-IDE terminal hijack. That is not a bugfix; that is collateral damage with a comment above it.  
>
> The regression test also needs a spine. “The handler mentions `syncTerminalRegistryWithState`” is not enough. The guard has to lock the full restore contract: focused-window branch keeps MCP refresh, keeps inbox scan, adds registry re-sync, and schedules a sidebar refresh. Anything less is a feel-good patch note masquerading as engineering.

### Balanced Response
> Fair. The minimize bug is really two coupled failures: the extension-side terminal registry used for routing can go stale, and the sidebar can stay visually stale until `TaskViewerProvider.refresh()` recomputes terminal liveliness from authoritative state. The plan is updated accordingly: keep the existing focus-handler work (`refreshMcpStatus()` and `inboxWatcher?.triggerScan()`), reuse the already-serialized `syncTerminalRegistryWithState(workspaceRoot)` reclaim path, and explicitly refresh the Task Viewer after that sync so the webview repaints on restore.  
>
> The regression coverage is tightened to match that contract. The new source-level test should assert that the focused-window branch performs all four restore actions together, while existing PID/name reclaim logic and `InboxWatcher` propagation remain intact elsewhere in `src/extension.ts`. That keeps the fix surgical, verifiable, and within the original scope.

## Preserved Original Draft
### Problem

When the user minimizes the IDE and then restores it, all sidebar terminals appear "disconnected" even though the underlying terminal processes are still running. The UI state becomes desynchronized from the actual terminal registry.

### Root Cause

The `onDidChangeWindowState` event handler at `src/extension.ts:1636-1641` only triggers `inboxWatcher?.triggerScan()` and `refreshMcpStatus()` when the window regains focus. It does **not** re-synchronize the terminal registry with `state.json`.

The sidebar's terminal status is driven by `registeredTerminals` Map, which may become stale if:
- VS Code's extension host throttles during minimize
- The webview loses state and doesn't re-fetch terminal status
- The `InboxWatcher` terminal registry drifts from the actual `vscode.window.terminals`

### Solution

Add a full terminal registry re-sync when the window regains focus. The existing `syncTerminalRegistryWithState()` function already implements proper PID-based and name-based matching to reclaim terminals.

### Files to Modify

1. `src/extension.ts:1636-1641`

### Original Implementation Details

#### Step 1: Update window state handler

Modify the `onDidChangeWindowState` handler to call `syncTerminalRegistryWithState()` when focused:

```typescript
context.subscriptions.push(vscode.window.onDidChangeWindowState((state) => {
    if (state.focused) {
        refreshMcpStatus().catch(() => { });
        inboxWatcher?.triggerScan();
        // Re-sync terminal registry after minimize/restore to fix UI desync
        if (workspaceRoot) {
            syncTerminalRegistryWithState(workspaceRoot).catch(() => { });
        }
    }
}));
```

#### Step 2: Ensure InboxWatcher receives updated registry

The `syncTerminalRegistryWithState()` function already updates `inboxWatcher` at line 1755-1757:

```typescript
// Update InboxWatcher folder state and registry
if (inboxWatcher) {
    inboxWatcher.updateRegisteredTerminals(registeredTerminals);
}
```

This ensures the inbox watcher has the corrected terminal references after re-sync.

### Original Testing Notes

1. Open Switchboard sidebar with agent terminals
2. Verify terminals show as "connected" in sidebar
3. Minimize IDE window
4. Wait 5-10 seconds
5. Restore IDE window
6. Verify terminals still show as "connected" (not "disconnected")
7. Verify terminal input forwarding still works via `sendToTerminal`

### Original Edge Cases

- **Terminals actually closed while minimized**: The sync will correctly mark them as disconnected
- **New terminals created while minimized**: They'll be picked up by the next state.json change event
- **Cross-IDE interference**: The existing `isCompatibleIdeName` check in `syncTerminalRegistryWithState()` prevents claiming other IDE's terminals

### Original Complexity

Low - Single-line change to add re-sync call in existing event handler.

## Proposed Changes
> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** Keep this fix surgical. The only production edit should be the restore-time focus handler in `src/extension.ts`; the new test file should lock the intended contract without changing runtime behavior.

### 1. Restore terminals on window focus and repaint the sidebar
#### [MODIFY] `src/extension.ts`
- **Context:** The current `vscode.window.onDidChangeWindowState` handler at `src/extension.ts:1636-1641` only does:
  - `refreshMcpStatus().catch(() => { });`
  - `inboxWatcher?.triggerScan();`

  That is enough to refresh MCP diagnostics and inbox delivery, but it does not mirror the existing resync paths already used elsewhere in the same file:
  - startup reclaim via `await syncTerminalRegistryWithState(workspaceRoot);` at `src/extension.ts:1568-1569`
  - terminal-open reclaim via `void syncTerminalRegistryWithState(workspaceRoot);` at `src/extension.ts:1575-1579`
  - `state.json` watcher reclaim + sidebar refresh at `src/extension.ts:1589-1605`

  The original root-cause symptoms remain the same and should still guide the fix:
  - VS Code's extension host throttles during minimize
  - the webview can return with stale UI state
  - the `InboxWatcher` terminal registry can drift from live `vscode.window.terminals` when no restore-time reclaim runs
- **Logic:**
  1. Keep the `if (state.focused)` guard unchanged; do nothing on blur.
  2. Preserve the existing restore-time MCP refresh and inbox scan exactly as they are today.
  3. Add the original plan's core reclaim step so restore-time focus also calls `syncTerminalRegistryWithState(workspaceRoot)` when `workspaceRoot` exists.
  4. **Clarification:** after that restore-time reclaim finishes (success or failure), call `taskViewerProvider.refresh()` so the sidebar reruns `_refreshTerminalStatuses()` and repaints the agent rows from current `.switchboard/state.json` + live terminal data.
  5. Do not modify `syncTerminalRegistryWithState()` itself, its `syncInFlight` / `syncPending` queueing, or the PID/name/`ideName` reclaim rules in `_syncTerminalRegistryWithStateImpl()`.
  6. Preserve the existing minimal core change from the original plan:
     ```typescript
     // Re-sync terminal registry after minimize/restore to fix UI desync
     if (workspaceRoot) {
         syncTerminalRegistryWithState(workspaceRoot).catch(() => { });
     }
     ```
     The final implementation below keeps that core reclaim step but adds the missing UI refresh contract.
- **Implementation:**
```typescript
        context.subscriptions.push(vscode.window.onDidChangeWindowState((state) => {
            if (state.focused) {
                refreshMcpStatus().catch(() => { });
                inboxWatcher?.triggerScan();
                if (workspaceRoot) {
                    void syncTerminalRegistryWithState(workspaceRoot).finally(() => {
                        taskViewerProvider.refresh();
                    });
                } else {
                    taskViewerProvider.refresh();
                }
            }
        }));
```
- **Edge Cases Handled:** Restore-time focus now matches the extension's existing reclaim pathways, surviving minimize/restore without claiming other IDEs' terminals. If a terminal really died while minimized, the subsequent refresh still shows it as disconnected instead of masking a real closure.

### 2. Preserve the existing InboxWatcher registry handoff
#### [MODIFY] `src/extension.ts`
- **Context:** The original plan correctly noted that the reclaim helper already updates `InboxWatcher` after rebuilding `registeredTerminals`. That behavior is necessary for message scanning and terminal input forwarding after restore.
- **Logic:**
  1. Route the focus fix through `syncTerminalRegistryWithState(workspaceRoot)` instead of duplicating registry-updater logic in the focus handler.
  2. Leave the existing post-swap `InboxWatcher` update block intact.
  3. Treat this block as authoritative for registry propagation after reclaim.
- **Implementation:**
```typescript
            // Update InboxWatcher folder state and registry
            if (inboxWatcher) {
                inboxWatcher.updateRegisteredTerminals(registeredTerminals);
            }
```
- **Edge Cases Handled:** `InboxWatcher` continues to see reclaimed terminal handles after minimize/restore, so passive scans and terminal-targeted actions do not keep using stale references.

### 3. Add a focused regression test for the restore contract
#### [CREATE] `src/test/terminal-disconnect-on-minimize-regression.test.js`
- **Context:** There is no focused test that proves the restore-time focus handler performs the complete recovery sequence. Existing tests do not lock this branch in `src/extension.ts`.
- **Logic:**
  1. Read `src/extension.ts` from disk with `fs.readFileSync`.
  2. Extract the `vscode.window.onDidChangeWindowState((state) => { ... })` handler so the assertions stay scoped to the restore path.
  3. Assert that the focused-window branch preserves MCP refresh and inbox scan while also adding `syncTerminalRegistryWithState(workspaceRoot)` and `taskViewerProvider.refresh()`.
  4. Assert that `_syncTerminalRegistryWithStateImpl()` still updates `InboxWatcher` after the atomic registry swap.
  5. Keep the test as a simple Node script so it can run independently of the VS Code integration harness.
- **Implementation:**
```javascript
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const extensionPath = path.join(__dirname, '..', 'extension.ts');
const extensionSource = fs.readFileSync(extensionPath, 'utf8');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  PASS ${name}`);
        passed++;
    } catch (error) {
        console.error(`  FAIL ${name}: ${error.message}`);
        failed++;
    }
}

function extractWindowStateHandler(tsSource) {
    const marker = 'vscode.window.onDidChangeWindowState((state) => {';
    const start = tsSource.indexOf(marker);
    if (start < 0) {
        throw new Error('Window state handler not found');
    }

    const bodyStart = tsSource.indexOf('{', start);
    if (bodyStart < 0) {
        throw new Error('Window state handler body start not found');
    }

    let depth = 0;
    for (let i = bodyStart; i < tsSource.length; i++) {
        const ch = tsSource[i];
        if (ch === '{') depth++;
        if (ch === '}') depth--;
        if (depth === 0) {
            return tsSource.slice(bodyStart, i + 1);
        }
    }

    throw new Error('Window state handler closing brace not found');
}

function run() {
    console.log('\nRunning terminal disconnect on minimize regression tests\n');

    const windowStateHandlerSource = extractWindowStateHandler(extensionSource);

    test('focused restore handler refreshes MCP, rescans inboxes, re-syncs terminals, and refreshes the sidebar', () => {
        assert.match(
            windowStateHandlerSource,
            /if \(state\.focused\) \{[\s\S]*refreshMcpStatus\(\)\.catch\(\(\) => \{ \}\);[\s\S]*inboxWatcher\?\.triggerScan\(\);[\s\S]*if \(workspaceRoot\) \{[\s\S]*syncTerminalRegistryWithState\(workspaceRoot\)[\s\S]*taskViewerProvider\.refresh\(\);[\s\S]*\}[\s\S]*else \{[\s\S]*taskViewerProvider\.refresh\(\);[\s\S]*\}[\s\S]*\}/,
            'Expected restore-time focus handler to keep MCP refresh and inbox scan while reclaiming terminals and refreshing the sidebar UI.'
        );
    });

    test('terminal reclaim still propagates the rebuilt registry into InboxWatcher', () => {
        assert.match(
            extensionSource,
            /registeredTerminals\.clear\(\);[\s\S]*for \(const \[k, v\] of newRegistry\) \{[\s\S]*registeredTerminals\.set\(k, v\);[\s\S]*\}[\s\S]*if \(inboxWatcher\) \{[\s\S]*inboxWatcher\.updateRegisteredTerminals\(registeredTerminals\);[\s\S]*\}/,
            'Expected syncTerminalRegistryWithState to keep updating InboxWatcher after the registry swap.'
        );
    });

    console.log(`\nResult: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
        process.exit(1);
    }
}

run();
```
- **Edge Cases Handled:** This locks the intended restore contract without depending on minimize timing or a VS Code UI harness, and it protects the existing `InboxWatcher` propagation that the runtime already depends on.

## Verification Plan
### Automated Tests
- Run `node src/test/terminal-disconnect-on-minimize-regression.test.js`.
- Run `npm run compile`.
- Record that `npm run lint` currently fails at baseline because ESLint 9 cannot find an `eslint.config.*` file; do not expand this bugfix to repair repo-wide lint tooling.

### Manual Checks
- Open the Switchboard sidebar with one or more registered agent terminals and confirm they initially show as connected.
- Minimize the IDE window for 5-10 seconds, restore it, and confirm the same terminals still show as connected.
- After restore, send input through the existing terminal bridge (`sendToTerminal` path) and confirm forwarding still works.
- Close one of the terminals for real, repeat the restore flow, and confirm the closed terminal still shows as disconnected rather than being falsely reclaimed.
- If a second compatible IDE window is available, confirm the restore path still does not claim terminals owned by another IDE.

## Agent Recommendation
Send to Coder

## Review Update

### Stage 1 — Grumpy Principal Engineer Critique
- [MAJOR] The restore handler looked correct on paper, but `syncTerminalRegistryWithState()` could still hand back immediately when a sync was already in flight. That means `taskViewerProvider.refresh()` could fire before the reclaimed registry actually settled, which is exactly how you keep a minimize/restore bug alive with prettier source code.
- [NIT] The regression test is source-string based instead of runtime-based. It locks the contract, but it still depends on the implementation shape staying textually stable.

### Stage 2 — Balanced Synthesis
- Keep the existing reuse of `syncTerminalRegistryWithState(workspaceRoot)`, the `refreshMcpStatus()` call, the inbox scan, and the `InboxWatcher` registry propagation.
- Fix now: ensure the sync helper resolves only after any queued reclaim work finishes, so the restore-path sidebar refresh truly follows the reclaim.
- Defer: a runtime VS Code focus/minimize harness. The current source regression test is sufficient for this surgical bugfix.

### Fixes Applied
- `src/extension.ts`: made `syncTerminalRegistryWithState()` return a completion promise that resolves only after queued sync work drains, so the restore handler’s `finally(() => taskViewerProvider.refresh())` runs after the registry reclaim actually finishes.

### Files Changed
- `src/extension.ts`
- `.switchboard/plans/fix_terminal_disconnect_on_minimize.md`

### Validation Results
- `node src/test/terminal-disconnect-on-minimize-regression.test.js` ✅
- `npm run compile` ✅
- `npm run lint` not run; known baseline failure due to missing `eslint.config.*`

### Remaining Risks
- The fix closes the in-flight sync race for restore, but VS Code minimize/restore timing can still make the UI briefly stale until the next refresh tick.
- Manual restore/close verification in the editor is still the best end-to-end confidence check.
