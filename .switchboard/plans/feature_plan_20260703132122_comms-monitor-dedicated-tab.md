# Move Comms Monitor to a Dedicated COMMS Tab

## Goal

The Comms Monitor (formerly MCP Monitor) is currently buried inside the AUTOMATION tab of the kanban panel, sandwiched between kanban-column automation rules (single-column/multi-column mode selectors, batch sizes, complexity routing, watch-mode warnings). This is architecturally wrong: the AUTOMATION tab is about the **kanban automation engine** (autoban) — dispatching plans to agents as they move through columns. The Comms Monitor is a completely separate feature: a periodic check of communications channels (Slack, Gmail, Calendar) via a Claude terminal. It has nothing to do with kanban columns, plan dispatch, or agent routing.

This plan creates a dedicated **COMMS** tab in the kanban panel's tab bar and moves all Comms Monitor UI out of the AUTOMATION tab into it. The AUTOMATION tab becomes purely about kanban automation, and the Comms Monitor gets its own first-class home with room to grow (prompt preview, source details, dependency notices, model indicator — all from companion plans).

### Problem Analysis & Root Cause

**Symptom:** The user opens the AUTOMATION tab expecting to configure kanban column automation. Instead, they find the Comms Monitor config (sources, interval, launch button) mixed in with the autoban engine config. The two features are unrelated but visually interleaved, making both harder to understand.

**Root cause (confirmed by code reading):** The Comms Monitor UI was added to `createAutobanPanel()` (`kanban.html:7690+`), the same JS function that renders the entire AUTOMATION tab content. The function builds:
1. The "CONFIGURE AUTOMATION" header (line 7742)
2. Mode selector (single-column / multi-column / antigravity-batch) (line 7749)
3. Per-mode automation rules (batch size, complexity routing, watch mode) (lines 8226-8762)
4. The MCP Monitor row + config panel (lines 7773-7954) — **this is the misplaced feature**
5. Safety notes and mode descriptions

The Comms Monitor is rendered as a subsection inside the autoban panel's `container` div, appended after the automation rules. It shares the same `guardInteraction` mechanism, the same re-render cycle (`renderAutobanPanel`), and the same "interaction guard" that blocks re-renders during user input. This coupling means a Comms Monitor config change can trigger an autoban panel re-render (and vice versa), and the interaction guard that's meant for automation rules also affects the monitor config.

**Why a new tab (not a move to an existing tab):**
- **AGENTS tab:** Wrong fit. The AGENTS tab is a simple list of agent visibility checkboxes + CLI commands. The Comms Monitor has a rich config UI (sources, interval, prompt preview, dependency notice, model indicator) that doesn't match the AGENTS tab's pattern.
- **REMOTE tab:** Wrong fit. REMOTE is about driving the kanban board remotely via Linear/Notion. The Comms Monitor is about monitoring communications, not controlling boards.
- **A new COMMS tab:** Correct fit. The Comms Monitor is a distinct feature with its own config, its own terminal, and its own purpose. A dedicated tab gives it room to grow and cleanly separates it from kanban automation.

## Metadata

- **Tags:** comms-monitor, mcp-monitor, ux, ia, refactor, tab-bar, kanban
- **Complexity:** 6
- **Project:** switchboard
- **Files touched:** `src/webview/kanban.html`

## Complexity Audit

**Moderate-complex refactor.** This is a single-file change (`kanban.html`) but it involves:
1. Adding a new tab button + tab content container to the HTML structure.
2. Extracting the Comms Monitor rendering code out of `createAutobanPanel()` into a new `createCommsPanel()` function.
3. Adding a new render function (`renderCommsPanel`) and wiring it to the tab-switch logic.
4. Decoupling the Comms Monitor's interaction guard from the autoban panel's interaction guard (they currently share `isAutobanPanelInteracting`).
5. Ensuring the Comms Monitor config messages (`updateMcpMonitorConfig`, `setMcpMonitorConfig`, `launchMcpMonitorTerminal`) still work when rendered in a different tab.

**No backend changes needed.** All the message handling (`KanbanProvider.ts:5746-5754`) and backend logic (`TaskViewerProvider.ts`) remain unchanged — the webview still sends/receives the same messages; only the rendering location changes.

**Risk:** The Comms Monitor rendering code is deeply interleaved with the autoban panel code (shared `container` div, shared `guardInteraction`, shared style variables like `autobanSelectStyle`). Extraction must carefully separate the shared styles (which both panels can use) from the shared state (which must be split). The `isAutobanPanelInteracting` guard must not block Comms Monitor re-renders when the AUTOMATION tab isn't even visible.

## Edge-Case & Dependency Audit

- **Tab bar crowding:** The tab bar currently has 8 tabs (KANBAN, AGENTS, PROMPTS, AUTOMATION, REMOTE, WORKTREES, UAT, SETUP). Adding COMMS makes 9. This is acceptable — the tab bar already scrolls/wraps. Place COMMS between UAT and SETUP (it's a utility/config feature, not a core workflow tab, so it belongs in the tail group with UAT and SETUP rather than in the main workflow group with KANBAN/AGENTS/PROMPTS/AUTOMATION/REMOTE/WORKTREES).
- **Interaction guard decoupling:** The Comms Monitor currently uses `guardInteraction` (line 7719) which sets `isAutobanPanelInteracting = true`. If we extract the monitor into its own panel, it needs its own interaction guard (`isCommsPanelInteracting`) so that typing in the monitor's config fields doesn't block autoban panel re-renders (and vice versa). Both guards should use the same 2-second timeout pattern.
- **Re-render triggers:** `renderAutobanPanel()` is called on `terminalStatuses` and `customAgents` messages (lines 9059-9065). The Comms Panel needs its own re-render on `updateMcpMonitorConfig` messages. Currently, the monitor config is rendered as part of `createAutobanPanel`, so it re-renders whenever the autoban panel re-renders. After extraction, `updateMcpMonitorConfig` should call `renderCommsPanel()` directly.
- **Initial config load:** The AUTOMATION tab requests autoban config on first open (line 9074: `postKanbanMessage({ type: 'getAutobanConfig' })`). The COMMS tab should request the MCP monitor config on first open via `postMcpMonitorConfig()` (already exists as a backend method, `TaskViewerProvider.ts:20508`). The webview should send a message to request it — check if there's an existing request type, or add one.
- **Tab persistence:** If the user is on the COMMS tab and reloads, the tab bar defaults to KANBAN (the `active` class is on the KANBAN button, line 2524). This is existing behavior — no tab persists across reloads. No change needed.
- **Companion plans:** The editable prompt preview plan, the rename plan, and the dependency/haiku plan all modify the Comms Monitor UI. This plan should be executed **first** (or in coordination) so those plans target the new COMMS tab rather than the AUTOMATION tab. If those plans ship first, their changes will be in `createAutobanPanel` and will need to be moved during this extraction.
- **No `confirm()` dialogs.** No new dialogs introduced.

## Proposed Changes

### 1. `src/webview/kanban.html` — add the COMMS tab button

In the tab bar (line 2523-2533), add the COMMS button after AUTOMATION:

```html
    <div class="shared-tab-bar">
        <button class="shared-tab-btn active" data-tab="kanban">KANBAN</button>
        <button class="shared-tab-btn" data-tab="agents">AGENTS</button>
        <button class="shared-tab-btn" data-tab="prompts">PROMPTS</button>
        <button class="shared-tab-btn" data-tab="automation">AUTOMATION</button>
        <button class="shared-tab-btn" data-tab="remote">REMOTE</button>
        <button class="shared-tab-btn" data-tab="worktrees">WORKTREES</button>

        <button class="shared-tab-btn" data-tab="uat">UAT</button>
        <button class="shared-tab-btn" data-tab="comms">COMMS</button>
        <button class="shared-tab-btn" data-tab="setup">SETUP</button>
    </div>
```

### 2. `src/webview/kanban.html` — add the COMMS tab content container

After the automation tab content (line 2613), add:

```html
    <!-- Comms Tab Content -->
    <div id="comms-tab-content" class="shared-tab-content">
        <div id="comms-panel-root" class="automation-panel"></div>
    </div>
```

### 3. `src/webview/kanban.html` — extract the Comms Monitor rendering into `createCommsPanel()`

Extract the MCP Monitor rendering code from `createAutobanPanel()` (lines 7773-7954 — the `mcpRow`, `mcpConfigPanel`, `mcpDesc`, and all their children) into a new function `createCommsPanel()`. This function builds and returns a container div with all the Comms Monitor UI:

```js
        function createCommsPanel() {
            const container = document.createElement('div');
            container.style.cssText = 'padding:12px; overflow-y:auto; height:100%;';

            // Comms header
            const commsHeader = document.createElement('div');
            commsHeader.className = 'subsection-header';
            const commsHeaderSpan = document.createElement('span');
            commsHeaderSpan.textContent = 'COMMS MONITOR';
            commsHeader.appendChild(commsHeaderSpan);
            container.appendChild(commsHeader);

            // Intro text
            const introText = document.createElement('div');
            introText.style.cssText = 'padding:0 8px 8px 8px; font-family:var(--font-mono); font-size:10px; color:var(--text-secondary); line-height:1.5;';
            introText.textContent = 'The Comms Monitor periodically pings a dedicated Claude terminal to check your Slack, Gmail, and Google Calendar for new messages and events — so you don\'t have to open those apps manually. Results appear in the monitor terminal pane.';
            container.appendChild(introText);

            // ─── Move all MCP Monitor UI here (mcpRow, mcpConfigPanel, etc.) ───
            // (Lines 7773-7954 from createAutobanPanel, adapted to use container
            //  instead of the autoban container, and isCommsPanelInteracting
            //  instead of isAutobanPanelInteracting)

            // ... [all the mcpRow, mcpSelect, mcpConfigPanel, intervalRow,
            //      sourcesList, customInstructionRow, statusLine, mcpHelp code] ...
            // ... [moved verbatim, with container.appendChild() instead of
            //      being appended to the autoban container] ...

            return container;
        }
```

**Key extraction details:**
- The shared style variables (`autobanSelectStyle`, `autobanNumberInputStyle`, etc., lines 7715-7718) are defined inside `createAutobanPanel`. Either move them to a shared scope (module-level) or duplicate them inside `createCommsPanel`. Recommended: move to a shared scope since both panels use them.
- The `guardInteraction` function (line 7719) sets `isAutobanPanelInteracting`. Create a parallel `isCommsPanelInteracting` flag and a `guardCommsInteraction` function (same 2-second timeout pattern) for the Comms panel.
- The `saveMonitorConfig` function (line 7906) and all event listeners stay with the Comms Monitor code — they move together.

### 4. `src/webview/kanban.html` — remove the Comms Monitor code from `createAutobanPanel()`

Delete lines 7773-7954 from `createAutobanPanel()`. The autoban panel now contains only:
- The "CONFIGURE AUTOMATION" header
- Mode selector
- Per-mode automation rules
- Safety notes and mode descriptions

No Comms Monitor UI remains in the AUTOMATION tab.

### 5. `src/webview/kanban.html` — add `renderCommsPanel()` and wire it to the tab-switch logic

Add a render function (parallel to `renderAutobanPanel`, line 9039):

```js
        let isCommsPanelInteracting = false;
        let commsPanelInteractionTimer = null;

        function renderCommsPanel() {
            try {
                const root = document.getElementById('comms-panel-root');
                if (!root) return;
                if (isCommsPanelInteracting) {
                    console.log('[kanban] Skipping comms panel re-render: user interaction guard active');
                    return;
                }
                root.innerHTML = '';
                root.appendChild(createCommsPanel());
            } catch (err) {
                console.error('[kanban webview] error rendering comms panel:', err);
            }
        }
```

Wire the tab-switch logic (extend the existing `kanbanTabButtons.forEach` at line 9070):

```js
        kanbanTabButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                if (btn.dataset.tab === 'automation') {
                    if (!autobanConfig) {
                        postKanbanMessage({ type: 'getAutobanConfig' });
                    }
                    renderAutobanPanel();
                } else if (btn.dataset.tab === 'comms') {
                    // Request MCP monitor config if not already loaded
                    if (!mcpMonitorConfig || !mcpMonitorConfig.enabled) {
                        postKanbanMessage({ type: 'requestMcpMonitorConfig' });
                    }
                    renderCommsPanel();
                }
            });
        });
```

### 6. `src/webview/kanban.html` — re-render comms panel on config updates

In the `updateMcpMonitorConfig` message handler (line 6803), add a call to `renderCommsPanel()`:

```js
                  mcpMonitorConfig = msg.config || mcpMonitorConfig;
                  mcpMonitorPresets = msg.presets || mcpMonitorPresets;
                  mcpMonitorResolvedCmd = msg.resolvedStartupCommand || '';
                  renderCommsPanel();  // NEW — re-render the comms tab with updated config
```

### 7. `src/services/KanbanProvider.ts` — add a `requestMcpMonitorConfig` message handler

Add a case in the message handler (near line 5746) so the webview can request the config when the COMMS tab is first opened:

```ts
            case 'requestMcpMonitorConfig': {
                if (this._taskViewerProvider) {
                    this._taskViewerProvider.postMcpMonitorConfig();
                }
                break;
            }
```

`postMcpMonitorConfig` already exists (`TaskViewerProvider.ts:20508`) and sends the config + presets + running status to the kanban webview.

## Verification Plan

1. **Build:** `npm run compile` succeeds with no type errors.
2. **Manual — COMMS tab appears:**
   - Open the kanban panel. Confirm the tab bar now shows: KANBAN, AGENTS, PROMPTS, AUTOMATION, REMOTE, WORKTREES, UAT, **COMMS**, SETUP.
3. **Manual — AUTOMATION tab no longer has the monitor:**
   - Click the AUTOMATION tab. Confirm it shows only kanban automation config (mode selector, column rules, batch sizes, watch-mode warnings). No Comms Monitor UI (no "MCP MONITOR:" / "COMMS MONITOR:" dropdown, no source checkboxes, no launch button).
4. **Manual — COMMS tab has the monitor:**
   - Click the COMMS tab. Confirm it shows the Comms Monitor config (the on/off dropdown, interval selector, source checkboxes, custom instruction field, launch button, status line, help text).
5. **Manual — config changes work from COMMS tab:**
   - In the COMMS tab, enable the monitor, select sources, change the interval. Confirm the config is saved (check `~/.switchboard/integration-config.json`).
6. **Manual — launch from COMMS tab:**
   - Click "Launch Comms Monitor Terminal" in the COMMS tab. Confirm the terminal is created and the status line updates to "🟢 running".
7. **Manual — interaction guards are independent:**
   - Open the AUTOMATION tab, start typing in a batch-size field (triggers `isAutobanPanelInteracting`). Switch to the COMMS tab, toggle a source checkbox. Confirm the COMMS panel re-renders correctly (not blocked by the autoban interaction guard).
   - Reverse: type in the COMMS tab's custom instruction field (triggers `isCommsPanelInteracting`). Switch to AUTOMATION, confirm autoban panel re-renders correctly.
8. **Manual — config updates re-render COMMS tab:**
   - With the COMMS tab open, change the monitor config from another source (e.g. edit `~/.switchboard/integration-config.json` directly and trigger a config push, or launch the terminal from the command palette which calls `_postMcpMonitorConfig`). Confirm the COMMS tab re-renders with the updated state.
9. **Manual — first-open config request:**
   - Reload the window. Click the COMMS tab for the first time. Confirm the config loads (the `requestMcpMonitorConfig` message fires and the panel populates with persisted config).
10. **Regression:** The AUTOMATION tab's autoban engine functionality (start/stop, mode switching, column rules) is unaffected. All autoban config changes still save and apply correctly. The 8 existing tabs all still render and switch correctly.
