# Fix: MCP Monitor Dropdown Reverts to Off, Sits in the Wrong Place, and Lacks a Description (Automation Tab)

## Goal

In `kanban.html`'s **Automation** tab, the **MCP Monitor** dropdown has three problems:

1. **It does not stick.** Setting it to **On** reverts to **Off** about 5 seconds later.
2. **It is in the wrong place.** It should appear **after** the "Safe Planning" message, not before it.
3. **It has no description.** It needs explanatory text under it stating what the MCP Monitor actually does.

### Problem analysis & root cause

The automation panel is rebuilt by `renderAutobanPanel()` in `src/webview/kanban.html`. The MCP Monitor dropdown is created there, and its on/off `selected` state is derived from an in-memory object `mcpMonitorConfig` (`src/webview/kanban.html:7381`, initialized at `src/webview/kanban.html:5952`).

**(1) Why it reverts — the kanban panel's `mcpMonitorConfig` never updates after a save.**

- The dropdown's `change` handler calls `saveMonitorConfig()` (`src/webview/kanban.html:7491-7508`), which posts `{ type: 'setMcpMonitorConfig', config }` to the host — but it does **not** optimistically update the local `mcpMonitorConfig` object. Local state stays at its old value.
- The host saves correctly: `KanbanProvider` forwards to `TaskViewerProvider.setMcpMonitorConfigFromKanban()` (`src/services/KanbanProvider.ts:4913-4918` → `src/services/TaskViewerProvider.ts:19194-19198`), which persists via `GlobalIntegrationConfigService.setMcpMonitorConfig()` (correctly round-trips `enabled` — `src/services/GlobalIntegrationConfigService.ts:245-256`) and then calls `_postMcpMonitorConfig()`.
- **The bug:** `_postMcpMonitorConfig()` echoes the updated config **only to the sidebar webview** — `this._view?.webview.postMessage({ type: 'updateMcpMonitorConfig', … })` (`src/services/TaskViewerProvider.ts:19200-19208`). It is **never** sent to the kanban panel (it does not call `broadcastToWebviews` nor `this._kanbanProvider?.postMessage(...)`). The kanban webview only ever updates `mcpMonitorConfig` inside its `updateMcpMonitorConfig` handler (`src/webview/kanban.html:6555-6562`), which therefore never fires for the kanban panel.
- Result: after the user picks **On**, the *DOM* shows "On" momentarily, but `mcpMonitorConfig.enabled` in the kanban webview is still `false`. ~5 s later the host broadcasts terminal statuses (`this._kanbanProvider?.postMessage({ type: 'terminalStatuses', … })` — `src/services/TaskViewerProvider.ts:16771,17746`), and the kanban handler runs `renderAutobanPanel()` **unconditionally** (`src/webview/kanban.html:8548-8550`). The rebuild reselects the dropdown from the stale `mcpMonitorConfig.enabled === false` → it snaps back to **Off**. (The interaction guard `isAutobanPanelInteracting` has a 2000 ms window — `src/webview/kanban.html:7311-7321` — already expired by the 5 s mark, and the `terminalStatuses` handler does not consult it anyway.)
- Corollary: because the kanban panel never receives `updateMcpMonitorConfig`, it also never reflects the *persisted* value on first render — it always starts from the hard-coded default (`enabled: false`, `src/webview/kanban.html:5952`).

**(2) Wrong DOM position.** In `renderAutobanPanel()` the elements are appended in this order: MODE row → **MCP Monitor row** (`src/webview/kanban.html:7365-7386`) → MCP config panel (`…:7489`) → mode help text (`…:7518-7521`) → **Safe Planning note** (`…:7523-7527`). The MCP Monitor block is appended *before* the Safe Planning note; the user wants it *after*.

**(3) No description.** There is help text, but only *inside the collapsible config panel* (`mcpHelp`, ~`src/webview/kanban.html:7484-7486`), visible only when expanded. There is no always-visible one-liner under the dropdown explaining the feature.

**Fix:** (a) make the kanban panel's `mcpMonitorConfig` track reality — push `updateMcpMonitorConfig` to the kanban panel from `_postMcpMonitorConfig()` **and** optimistically update local state in `saveMonitorConfig()`, **and** stop the `terminalStatuses` handler from clobbering a live edit; (b) reorder the MCP Monitor block to append after the Safe Planning note; (c) add a short always-visible description under the dropdown.

## Metadata

- **Tags:** `automation`, `mcp-monitor`, `kanban`, `webview`, `state-sync`, `bugfix`, `ui`
- **Complexity:** 5 / 10
- **Affected components:** `src/webview/kanban.html` (render order, optimistic save, guarded re-render, description), `src/services/TaskViewerProvider.ts` (`_postMcpMonitorConfig` recipient).
- **Migration required:** No. Storage schema (`GlobalIntegrationConfigService` `mcpMonitor`) is unchanged; this is a delivery/echo + render fix only.

## Complexity Audit

**Classification: Complex/Risky (state-sync timing across two webviews).**

- The persistence bug is a cross-webview message-routing/timing defect, which is subtle: the value *is* saved on disk, but the panel that shows it never hears about it. Fixing only the DOM order or only the description would leave the headline "doesn't stick" bug intact.
- Defense-in-depth is warranted: a single fix (e.g. only echoing to the kanban panel) still races against the `terminalStatuses` re-render if the echo is slow. Combining (a) optimistic local update, (b) echo to the kanban panel, and (c) not re-rendering over an in-flight edit makes the result robust to ordering.
- The reorder + description (items 2 and 3) are routine and low-risk.

## Edge-Case & Dependency Audit

- **Initial load must show the persisted value.** Because the kanban panel currently never receives `updateMcpMonitorConfig`, it must be sent the current config when the automation panel first needs it (e.g. on `getAutobanConfig` or when the automation tab opens — `src/webview/kanban.html:8558-8568`). Otherwise the dropdown shows the default until the user interacts. Pushing the echo to the kanban panel (Change 1) plus an initial push covers this.
- **Sidebar parity.** The sidebar webview (`this._view`) currently relies on the same `updateMcpMonitorConfig` echo. The fix must keep sending it to the sidebar **as well** (use `broadcastToWebviews`, or send to both `this._view` and `this._kanbanProvider`) so the sidebar copy of this control, if any, does not regress.
- **`terminalStatuses` cadence.** This broadcast fires frequently (terminal polling, dispatch readiness — `src/services/TaskViewerProvider.ts:16771,17746,17773`). The re-render it triggers must not discard a user's in-progress dropdown change. Guard the rebuild with `isAutobanPanelInteracting` (mirroring the `updateMcpMonitorConfig` handler at `src/webview/kanban.html:6559`), and ensure local `mcpMonitorConfig` is already updated before any rebuild so a rebuild reselects the correct value.
- **Config panel visibility coupling.** The `change` handler also toggles the config panel display (`src/webview/kanban.html:7506-7509`). After reordering, ensure the config panel still appears in a sensible place relative to the dropdown (keep dropdown + config panel together; only the whole MCP block moves below the Safe Planning note).
- **Default `sources`/`intervalMinutes` round-trip.** `setMcpMonitorConfig` merges partials and preserves unset fields (`src/services/GlobalIntegrationConfigService.ts:245-256`); the optimistic local update must merge the same fields it sends (`enabled`, `intervalMinutes`, `sources`, `customInstruction`) so a re-render doesn't blank `targetRole` (which the webview doesn't send — keep the existing local value).
- **No confirmation dialogs** added (project rule).
- **Description wording.** Keep it short and factual; reuse the existing detailed copy from `mcpHelp` (`src/webview/kanban.html:7484-7486`) as the source of truth so the two don't contradict.

## Proposed Changes

### Change 1 — `src/services/TaskViewerProvider.ts`: echo the MCP config to the kanban panel too

In `_postMcpMonitorConfig()` (`src/services/TaskViewerProvider.ts:19200-19208`), send the message to all webviews instead of only `this._view`:

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

> `broadcastToWebviews(message)` (`src/services/TaskViewerProvider.ts:4128-4131`) does the same fan-out and may be used instead; if so, confirm it also reaches the setup panel without side effects. Posting explicitly to `_view` + `_kanbanProvider` is the minimal, targeted change.

Also push the config to the kanban panel on automation-panel load so the dropdown reflects the persisted value immediately. The kanban automation tab already requests `getAutobanConfig` on open (`src/webview/kanban.html:8562-8564`); have that handler in `KanbanProvider`/`TaskViewerProvider` also trigger `_postMcpMonitorConfig()` (or include the mcp config in the autoban-config reply).

### Change 2 — `src/webview/kanban.html`: optimistically update local state on save

In `saveMonitorConfig()` (`src/webview/kanban.html:7491-7504`), update `mcpMonitorConfig` locally before/after posting, so any re-render reselects the user's choice even before the host echo arrives:

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

### Change 3 — `src/webview/kanban.html`: stop `terminalStatuses` from clobbering a live edit

Guard the unconditional re-render in the `terminalStatuses` handler (`src/webview/kanban.html:8548-8550`) with the existing interaction flag (same guard the `updateMcpMonitorConfig` handler already uses at `src/webview/kanban.html:6559`):

```js
if (msg.type === 'terminalStatuses') {
    lastTerminals = msg.terminals || {};
    if (!isAutobanPanelInteracting) renderAutobanPanel();
}
```

(With Change 2, even a rebuild that does slip through now reselects the correct value, so this guard is the secondary safety net rather than the sole fix.)

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

1. **Stick test (headline bug):** Automation tab → set MCP Monitor to **On**. Wait ≥ 15 s (multiple `terminalStatuses` broadcasts). It must remain **On**. Toggle back to **Off** and confirm it stays **Off**.
2. **Persistence across reopen:** Set **On**, close and reopen the kanban panel (and switch away/back to the Automation tab). The dropdown must reflect **On** from first render — proving the kanban panel now receives the persisted config (Change 1 + initial push).
3. **Mid-edit broadcast:** Set **On** and, within ~2 s, ensure a `terminalStatuses` broadcast occurs (e.g. create/close a terminal). The dropdown must not flicker back to Off (Change 3 guard + Change 2 optimistic state).
4. **Order:** Visually confirm the MCP Monitor dropdown (and its config panel + description) appear **below** the "💡 Safe Planning…" note in the Automation panel.
5. **Description present:** Confirm a one-line description is always visible under the MCP Monitor dropdown (not only when the config panel is expanded), and that its wording matches the in-panel help.
6. **Sidebar parity:** If the sidebar exposes the MCP monitor control, confirm it still updates correctly (no regression from changing the echo recipient).
7. **Backend behaviour intact:** Confirm enabling actually starts the monitor loop (`_startMcpMonitorLoop`) and the persisted `~/.switchboard/integration-config.json` `mcpMonitor.enabled` is `true`.
8. **Build:** `npm run compile` succeeds.
