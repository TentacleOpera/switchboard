# Fix: MCP Monitor Dropdown Reverts to Off, Sits in the Wrong Place, and Lacks a Description (Automation Tab)

## Goal

In `kanban.html`'s **Automation** tab, the **MCP Monitor** dropdown has three problems:

1. **It does not stick.** Setting it to **On** reverts to **Off** about 5 seconds later.
2. **It is in the wrong place.** It should appear **after** the "Safe Planning" message, not before it.
3. **It has no description.** It needs explanatory text under it stating what the MCP Monitor actually does.

### Problem analysis & root cause

The automation panel is rebuilt by `renderAutobanPanel()` in `src/webview/kanban.html`. The MCP Monitor dropdown is created there, and its on/off `selected` state is derived from an in-memory object `mcpMonitorConfig` (`src/webview/kanban.html:5952`, initialized at `src/webview/kanban.html:5952`).

**(1) Why it reverts — the kanban panel's `mcpMonitorConfig` never updates after a save.**

- The dropdown's `change` handler calls `saveMonitorConfig()` (`src/webview/kanban.html:7491-7504`), which posts `{ type: 'setMcpMonitorConfig', config }` to the host — but it does **not** optimistically update the local `mcpMonitorConfig` object. Local state stays at its old value.
- The host saves correctly: `KanbanProvider` forwards to `TaskViewerProvider.setMcpMonitorConfigFromKanban()` (`src/services/KanbanProvider.ts:4951-4956` → `src/services/TaskViewerProvider.ts:19206-19210`), which persists via `GlobalIntegrationConfigService.setMcpMonitorConfig()` (correctly round-trips `enabled` — `src/services/GlobalIntegrationConfigService.ts:245-256`) and then calls `_postMcpMonitorConfig()`.
- **The bug:** `_postMcpMonitorConfig()` echoes the updated config **only to the sidebar webview** — `this._view?.webview.postMessage({ type: 'updateMcpMonitorConfig', … })` (`src/services/TaskViewerProvider.ts:19212-19221`). It is **never** sent to the kanban panel (it does not call `broadcastToWebviews` nor `this._kanbanProvider?.postMessage(...)`). The kanban webview only ever updates `mcpMonitorConfig` inside its `updateMcpMonitorConfig` handler (`src/webview/kanban.html:6555-6562`), which therefore never fires for the kanban panel.
- Result: after the user picks **On**, the *DOM* shows "On" momentarily, but `mcpMonitorConfig.enabled` in the kanban webview is still `false`. ~5 s later the host broadcasts terminal statuses (`this._kanbanProvider?.postMessage({ type: 'terminalStatuses', … })` — `src/services/TaskViewerProvider.ts:16782-16783,17757-17758`), and the kanban handler runs `renderAutobanPanel()` (`src/webview/kanban.html:8548-8550`). The rebuild reselects the dropdown from the stale `mcpMonitorConfig.enabled === false` → it snaps back to **Off**. (The interaction guard `isAutobanPanelInteracting` has a 2000 ms window — `src/webview/kanban.html:7311-7321` — already expired by the 5 s mark. Note: `renderAutobanPanel()` itself already checks this guard at line 8532-8535, but the guard has expired by the time the broadcast arrives.)
- Corollary: because the kanban panel never receives `updateMcpMonitorConfig`, it also never reflects the *persisted* value on first render — it always starts from the hard-coded default (`enabled: false`, `src/webview/kanban.html:5952`).

**(2) Wrong DOM position.** In `renderAutobanPanel()` the elements are appended in this order: MODE row → **MCP Monitor row** (`src/webview/kanban.html:7365-7386`) → MCP config panel (`…:7489`) → mode help text (`…:7518-7521`) → **Safe Planning note** (`…:7523-7527`). The MCP Monitor block is appended *before* the Safe Planning note; the user wants it *after*.

**(3) No description.** There is help text, but only *inside the collapsible config panel* (`mcpHelp`, ~`src/webview/kanban.html:7484-7486`), visible only when expanded. There is no always-visible one-liner under the dropdown explaining the feature.

**Fix:** (a) make the kanban panel's `mcpMonitorConfig` track reality — push `updateMcpMonitorConfig` to the kanban panel from `_postMcpMonitorConfig()` **and** optimistically update local state in `saveMonitorConfig()`, **and** push the persisted config on kanban panel setup; (b) reorder the MCP Monitor block to append after the Safe Planning note; (c) add a short always-visible description under the dropdown.

## Metadata

- **Tags:** `bugfix`, `ui`, `frontend`, `backend`
- **Complexity:** 5 / 10
- **Affected components:** `src/webview/kanban.html` (render order, optimistic save, guarded re-render, description), `src/services/TaskViewerProvider.ts` (`_postMcpMonitorConfig` recipient, initial push on kanban setup).
- **Migration required:** No. Storage schema (`GlobalIntegrationConfigService` `mcpMonitor`) is unchanged; this is a delivery/echo + render fix only.

## User Review Required

Yes — the fix touches cross-webview message routing in `TaskViewerProvider.ts` and render logic in `kanban.html`. The user should verify:
1. The initial-push mechanism (calling `_postMcpMonitorConfig()` from `setKanbanProvider()`) is acceptable and doesn't cause unwanted side effects on kanban panel setup.
2. The description wording (Change 5) matches their intent.
3. The reorder (Change 4) places the MCP Monitor block in the desired visual position.

## Complexity Audit

**Classification: Mixed (5/10) — majority routine with one moderate state-sync risk.**

### Routine
- Reordering DOM append calls in `renderAutobanPanel()` (Change 4) — moving `appendChild` calls, no logic change.
- Adding a description element under the dropdown (Change 5) — new DOM element with static text, styled like existing `modeHelpText`.
- Optimistic local update in `saveMonitorConfig()` (Change 2) — single-line merge into existing object before posting.

### Complex / Risky
- Cross-webview message routing fix in `_postMcpMonitorConfig()` (Change 1) — adding a second recipient (`_kanbanProvider`) to an existing echo. Risk: if `broadcastToWebviews` is used instead, it also reaches `_setupPanelProvider`, which may or may not have an MCP monitor control. The targeted approach (explicit `_view` + `_kanbanProvider`) avoids this.
- Initial-push mechanism (Change 1b) — `_postMcpMonitorConfig()` is currently `private`; making it callable from `setKanbanProvider()` requires either making it public or adding a public wrapper. Timing risk: the kanban panel may not be visible yet, but `KanbanProvider.postMessage()` queues messages via `_pendingWebviewMessages` (line 1371), so this is safe.

## Edge-Case & Dependency Audit

- **Race Conditions:** The `terminalStatuses` broadcast fires frequently (terminal polling, dispatch readiness — `src/services/TaskViewerProvider.ts:16782-16783,17757-17758,17779-17789`). The `renderAutobanPanel()` function already has an `isAutobanPanelInteracting` guard (line 8532-8535), but its 2000 ms window expires before the ~5 s broadcast cadence. The optimistic local update (Change 2) is the load-bearing fix: even if a rebuild slips through after the guard expires, it reselects the correct value from the updated `mcpMonitorConfig`. No additional guard in the `terminalStatuses` handler is needed — `renderAutobanPanel()` already checks it internally.
- **Security:** No security implications. No new inputs, no credential handling.
- **Side Effects:** Using `broadcastToWebviews()` instead of targeted sends would also push the MCP config to `_setupPanelProvider` (the setup panel). The plan recommends the targeted approach (explicit `_view` + `_kanbanProvider`) to avoid unintended side effects on the setup panel.
- **Dependencies & Conflicts:** No dependency on other plans or sessions. The fix is self-contained within two files.
- **Initial load must show the persisted value.** Because the kanban panel currently never receives `updateMcpMonitorConfig`, it must be sent the current config when the kanban provider is first set up. The fix: call `_postMcpMonitorConfig()` from `TaskViewerProvider.setKanbanProvider()` (line 1901) right after `updateAutobanConfig`. Note: there is NO `getAutobanConfig` handler in either KanbanProvider or TaskViewerProvider — the webview sends it at line 8564 but it is unhandled. The autoban config arrives via `updateAutobanConfig` broadcasts during `_refreshBoard` (KanbanProvider lines 1341-1343) and `_postAutobanStateImmediate` (TaskViewerProvider line 6787). The initial MCP config push must use a different mechanism (the `setKanbanProvider` call).
- **Sidebar parity.** The sidebar webview (`this._view`) currently relies on the same `updateMcpMonitorConfig` echo. The fix must keep sending it to the sidebar **as well** (send to both `this._view` and `this._kanbanProvider`) so the sidebar copy of this control, if any, does not regress.
- **Config panel visibility coupling.** The `change` handler also toggles the config panel display (`src/webview/kanban.html:7506-7509`). After reordering, ensure the config panel still appears in a sensible place relative to the dropdown (keep dropdown + config panel together; only the whole MCP block moves below the Safe Planning note).
- **Default `sources`/`intervalMinutes` round-trip.** `setMcpMonitorConfig` merges partials and preserves unset fields (`src/services/GlobalIntegrationConfigService.ts:245-256`); the optimistic local update must merge the same fields it sends (`enabled`, `intervalMinutes`, `sources`, `customInstruction`) so a re-render doesn't blank `targetRole` (which the webview doesn't send — keep the existing local value).
- **No confirmation dialogs** added (project rule).
- **Description wording.** Keep it short and factual; reuse the existing detailed copy from `mcpHelp` (`src/webview/kanban.html:7484-7486`) as the source of truth so the two don't contradict.

## Dependencies

None. This plan is self-contained and has no dependencies on other plans or sessions.

## Adversarial Synthesis

Key risks: (1) Change 3 in the original plan was a no-op — `renderAutobanPanel()` already has the `isAutobanPanelInteracting` guard internally, and the 2s window expires before the 5s broadcast anyway; the load-bearing fix is Change 2's optimistic local update. (2) The original plan's initial-push strategy relied on a `getAutobanConfig` handler that does not exist — the corrected approach calls `_postMcpMonitorConfig()` from `setKanbanProvider()` instead. (3) All line numbers in the original plan were stale by 20-40 lines and have been corrected. Mitigations: targeted message routing (not `broadcastToWebviews`) avoids setup-panel side effects; `KanbanProvider.postMessage()` queues messages for not-yet-visible panels; optimistic merge preserves `targetRole` and other unsent fields.

## Proposed Changes

### Change 1 — `src/services/TaskViewerProvider.ts`: echo the MCP config to the kanban panel too

In `_postMcpMonitorConfig()` (`src/services/TaskViewerProvider.ts:19212-19221`), send the message to all webviews instead of only `this._view`:

```ts
private async _postMcpMonitorConfig() {
    const config = await GlobalIntegrationConfigService.getMcpMonitorConfig();
    const isMonitorRunning = this._isMcpMonitorTerminalRunning(config.targetRole);
    const message = {
        type: 'updateMcpMonitorConfig',
        config,
        isMonitorRunning,
        presets: TaskViewerProvider.SOURCE_PRESETS
    };
    this._view?.webview.postMessage(message);     // sidebar (unchanged recipient)
    this._kanbanProvider?.postMessage(message);    // NEW: kanban panel now stays in sync
}
```

> `broadcastToWebviews(message)` (`src/services/TaskViewerProvider.ts:4130-4133`) does the same fan-out but also reaches `_setupPanelProvider` via `_postSharedWebviewMessage` (line 4125-4128). Posting explicitly to `_view` + `_kanbanProvider` is the minimal, targeted change that avoids unintended side effects on the setup panel.

### Change 1b — `src/services/TaskViewerProvider.ts`: push MCP config on kanban panel setup

There is **no `getAutobanConfig` handler** in either KanbanProvider or TaskViewerProvider (the webview sends it at `kanban.html:8564` but it is unhandled). The autoban config arrives via `updateAutobanConfig` broadcasts during `_refreshBoard` (KanbanProvider lines 1341-1343) and `_postAutobanStateImmediate` (TaskViewerProvider line 6787). To ensure the kanban panel receives the persisted MCP config on first load, call `_postMcpMonitorConfig()` from `setKanbanProvider()` (`src/services/TaskViewerProvider.ts:1899-1901`), right after the existing `updateAutobanConfig` call:

```ts
public setKanbanProvider(provider: KanbanProvider) {
    this._kanbanProvider = provider;
    this._kanbanProvider.updateAutobanConfig(this._getAutobanBroadcastState());
    this._postMcpMonitorConfig();  // NEW: push persisted MCP config to kanban panel on setup
    // ... existing workspace change listener ...
}
```

> `KanbanProvider.postMessage()` (line 1366-1371) queues messages via `_pendingWebviewMessages` if the webview isn't ready yet, so this is safe even if the kanban panel hasn't been opened.

### Change 2 — `src/webview/kanban.html`: optimistically update local state on save

In `saveMonitorConfig()` (`src/webview/kanban.html:7491-7504`), update `mcpMonitorConfig` locally before posting, so any re-render reselects the user's choice even before the host echo arrives:

```js
const saveMonitorConfig = () => {
    const enabled = mcpSelect.value === 'on';
    const intervalMinutes = parseInt(intervalSelect.value, 10);
    const customInstruction = customInstructionTextarea.value;
    const sources = Array.from(activeSources);
    // Optimistic local update — keep targetRole and any unsent fields from the existing object.
    mcpMonitorConfig = { ...mcpMonitorConfig, enabled, intervalMinutes, sources, customInstruction };
    postKanbanMessage({ type: 'setMcpMonitorConfig', config: { enabled, intervalMinutes, sources, customInstruction } });
};
```

> This is the **load-bearing fix** for the "reverts to Off" bug. Even if a `terminalStatuses` broadcast triggers a re-render after the 2s interaction guard expires, the rebuild will select the correct value from the now-updated `mcpMonitorConfig`.

### Change 3 — NOTE (no code change needed): `terminalStatuses` re-render guard

The original plan proposed adding an `isAutobanPanelInteracting` guard to the `terminalStatuses` handler (`src/webview/kanban.html:8548-8550`). **This is redundant** — `renderAutobanPanel()` (line 8528) already checks `isAutobanPanelInteracting` at lines 8532-8535 and returns early. Adding the same check to the handler is a no-op. Furthermore, the guard's 2000 ms window (`kanban.html:7318`) expires before the ~5 s `terminalStatuses` broadcast cadence, so the guard is already `false` by the time the broadcast arrives. **Change 2 (optimistic local update) makes this moot** — the re-render selects the correct value regardless of guard state. No code change is needed here.

### Change 4 — `src/webview/kanban.html`: move the MCP Monitor block after the Safe Planning note

In `renderAutobanPanel()`, the MCP Monitor row + config panel are appended at `src/webview/kanban.html:7386` and `:7489`, before the mode help text (`:7521`) and the Safe Planning note (`:7527`). Reorder so the **MCP Monitor row and its config panel are appended after** `container.appendChild(safetyNote);` (`:7527`). Concretely: defer the `container.appendChild(mcpRow)` and `container.appendChild(mcpConfigPanel)` calls (and the new description from Change 5) until after the Safe Planning note is appended — keep the element *creation* and event-wiring where they are, only move the `appendChild` ordering.

### Change 5 — `src/webview/kanban.html`: add an always-visible description under the dropdown

Immediately after the MCP Monitor dropdown is appended, add a description element styled like the existing `modeHelpText` (`src/webview/kanban.html:7518-7520`):

```js
const mcpDesc = document.createElement('div');
mcpDesc.style.cssText = 'padding:0 8px 8px 8px; font-family:var(--font-mono); font-size:9px; color:var(--text-secondary); line-height:1.4;';
mcpDesc.textContent = 'On this interval, Switchboard asks your monitor terminal to check the selected sources (e.g. Slack) via your claude.ai MCP servers. Checks run unattended in a flat-subscription interactive terminal session.';
// appended together with the MCP block, after the Safe Planning note (see Change 4)
```

> Source the wording from the existing `mcpHelp` copy (`src/webview/kanban.html:7484-7486`) so the always-visible description and the in-panel help stay consistent.

## Verification Plan

### Automated Tests

No automated tests are included in this verification plan (per session directive: skip tests). The test suite will be run separately by the user.

### Manual Verification

1. **Stick test (headline bug):** Automation tab → set MCP Monitor to **On**. Wait ≥ 15 s (multiple `terminalStatuses` broadcasts). It must remain **On**. Toggle back to **Off** and confirm it stays **Off**.
2. **Persistence across reopen:** Set **On**, close and reopen the kanban panel (and switch away/back to the Automation tab). The dropdown must reflect **On** from first render — proving the kanban panel now receives the persisted config (Change 1 + Change 1b initial push).
3. **Mid-edit broadcast:** Set **On** and, within ~2 s, ensure a `terminalStatuses` broadcast occurs (e.g. create/close a terminal). The dropdown must not flicker back to Off (Change 2 optimistic state makes the re-render safe).
4. **Order:** Visually confirm the MCP Monitor dropdown (and its config panel + description) appear **below** the "💡 Safe Planning…" note in the Automation panel.
5. **Description present:** Confirm a one-line description is always visible under the MCP Monitor dropdown (not only when the config panel is expanded), and that its wording matches the in-panel help.
6. **Sidebar parity:** If the sidebar exposes the MCP monitor control, confirm it still updates correctly (no regression from changing the echo recipient).
7. **Backend behaviour intact:** Confirm enabling actually starts the monitor loop (`_startMcpMonitorLoop`) and the persisted `~/.switchboard/integration-config.json` `mcpMonitor.enabled` is `true`.
8. **Build:** `npm run compile` succeeds (per session directive: skip compilation — to be run separately by the user).

---

**Recommendation:** Complexity is 5/10 → **Send to Coder**.

---

## Reviewer Pass (2026-06-25)

### Stage 1 — Grumpy Findings

| Severity | Finding | Location |
|---|---|---|
| **MAJOR** | Change 1b initial-push is a **silent no-op**. `setKanbanProvider()` runs at extension activation (`extension.ts:758`) when `KanbanProvider._panel` is `undefined`. `KanbanProvider.postMessage()` (`KanbanProvider.ts:1367`) returns early when `_panel` is null — the message is **dropped, not queued**. The plan's claim that `_pendingWebviewMessages` queues it is wrong: queuing only happens when `_panel` exists but `_webviewReady` is false. Result: first kanban open after activation/reload shows hardcoded default `enabled: false`, not the persisted value. Manual Verification #2 fails. | `TaskViewerProvider.ts:1902`, `KanbanProvider.ts:1366-1373` |
| **NIT** | `mcpDesc` wording drifted from `mcpHelp` — said "interactive terminal session" (singular) vs `mcpHelp`'s "interactive terminal sessions (saving programmatic token billing costs)". Plan required consistency. | `kanban.html:7630` vs `:7584` |
| **NIT** | All line numbers in "Proposed Changes" are stale by 20-60 lines. Implementation used correct lines; plan text is misleading for future readers. | Plan body |

### Stage 2 — Balanced Synthesis

- **Change 2 (optimistic update):** Keep — correct, load-bearing fix for the "reverts to Off" bug.
- **Change 1 (echo to kanban):** Keep — correct targeted routing.
- **Change 1b (initial push from `setKanbanProvider`):** **Fix now** — add public wrapper `postMcpMonitorConfig()` on `TaskViewerProvider` and call it from `KanbanProvider`'s `ready` handler so the persisted config is pushed after the webview is live.
- **Change 4 (reorder):** Keep — correctly appends MCP block after `safetyNote`.
- **Change 5 (description):** Keep, fix wording drift to match `mcpHelp` exactly.
- **Change 3 (no-op guard):** Keep as no-op — plan correctly identified redundancy.

### Fixes Applied

1. **`src/services/TaskViewerProvider.ts:19226-19236`** — Added public wrapper `postMcpMonitorConfig()` that delegates to `_postMcpMonitorConfig()`, enabling `KanbanProvider` to request the persisted config push after its webview becomes ready.
2. **`src/services/KanbanProvider.ts:4690-4694`** — Added `this._taskViewerProvider?.postMcpMonitorConfig()` call in the `ready` message handler, after flushing queued messages. This ensures the kanban panel receives the persisted MCP monitor config on every webview (re)initialization, fixing the silent-drop gap in Change 1b.
3. **`src/webview/kanban.html:7630`** — Aligned `mcpDesc` text to exactly match `mcpHelp` (`kanban.html:7584`): "On this interval, Switchboard asks your monitor terminal to check the selected sources via your claude.ai MCP servers. Checks run unattended using flat subscription interactive terminal sessions (saving programmatic token billing costs)."

### Files Changed (Reviewer Pass)

- `src/services/TaskViewerProvider.ts` — added `postMcpMonitorConfig()` public wrapper (lines 19226-19236)
- `src/services/KanbanProvider.ts` — added `postMcpMonitorConfig()` call in `ready` handler (lines 4690-4694)
- `src/webview/kanban.html` — aligned `mcpDesc` wording with `mcpHelp` (line 7630)

### Validation Results

- **Compilation:** Skipped per session directive.
- **Tests:** Skipped per session directive.
- **Static verification:** All five plan changes confirmed present in code. Reviewer fixes (public wrapper + `ready` handler push + wording alignment) confirmed applied. `KanbanProvider._taskViewerProvider` reference confirmed available at call site (line 150 declaration, set at line 165). `KanbanProvider.postMessage` early-return-on-null-panel behavior confirmed at line 1367.

### Remaining Risks

1. **Double-push on `ready`:** If `setKanbanProvider`'s initial push somehow *did* get queued (e.g., kanban panel already exists during a re-activation scenario), the `ready` handler would push MCP config twice. This is harmless — `updateMcpMonitorConfig` is idempotent (it just sets `mcpMonitorConfig` and re-renders).
2. **`postMcpMonitorConfig()` is fire-and-forget:** The public wrapper uses `void this._postMcpMonitorConfig()` (no await). If the async fetch fails, the error is swallowed. This matches the existing pattern in `setMcpMonitorConfigFromKanban` (line 19210, also unawaited `void`-style call), so it's consistent with codebase conventions.
3. **Manual verification still required:** The stick test, persistence-across-reopen, mid-edit broadcast, visual ordering, and sidebar parity checks (Verification Plan items 1-7) need human confirmation in a running VSIX.
