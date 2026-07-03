# Move Comms Monitor to a Dedicated COMMS Tab

## Goal

The Comms Monitor (formerly MCP Monitor) is currently buried inside the AUTOMATION tab of the kanban panel, sandwiched between kanban-column automation rules (single-column/multi-column mode selectors, batch sizes, complexity routing, watch-mode warnings). This is architecturally wrong: the AUTOMATION tab is about the **kanban automation engine** (autoban) — dispatching plans to agents as they move through columns. The Comms Monitor is a completely separate feature: a periodic check of communications channels (Slack, Gmail, Calendar) via a Claude terminal. It has nothing to do with kanban columns, plan dispatch, or agent routing.

This plan creates a dedicated **COMMS** tab in the kanban panel's tab bar and moves all Comms Monitor UI out of the AUTOMATION tab into it. The AUTOMATION tab becomes purely about kanban automation, and the Comms Monitor gets its own first-class home with room to grow (prompt preview, source details, dependency notices, model indicator — all from companion plans).

### Problem Analysis & Root Cause

**Symptom:** The user opens the AUTOMATION tab expecting to configure kanban column automation. Instead, they find the Comms Monitor config (sources, interval, launch button) mixed in with the autoban engine config. The two features are unrelated but visually interleaved, making both harder to understand.

**Root cause (confirmed by fresh code reading on 2026-07-03 — see "Verified Anchors" below; earlier draft line numbers were stale and have been corrected):** The Comms Monitor UI was added to `createAutobanPanel()` (`kanban.html:7511`), the same JS function that renders the entire AUTOMATION tab content. The function builds:
1. Mode selector (single-column / multi-column / antigravity-batch) near the top of the function (`modeSelect`, guarded at line 7582)
2. The MCP Monitor row + config panel — the **misplaced feature** — built at lines **7599-7754** (`mcpRow` at 7600, `mcpSelect` at ~7606, `mcpConfigPanel` at 7622, interval/sources/custom-instruction/launch/status/help children through ~7730, `saveMonitorConfig` at 7732, and its change/input listeners at 7749-7754)
3. Mode descriptions + safety note (lines 7756-7770) — autoban content, interleaved **between** the monitor config panel and its description/appends
4. The `mcpDesc` description text (lines 7772-7775) and the three monitor `container.appendChild()` calls (lines 7778-7780)
5. The `modeSelect` change handler and all per-mode automation rules (batch size, complexity routing, watch mode, per-column trigger toggles) from ~7782 onward (e.g. `guardInteraction(columnSelect)` at 7924, batch/complexity/routing selects at 8075-8153, 8421-8547)

**Critical anchor correction:** the monitor code is **NOT a single contiguous 7773-7954 block** (the earlier draft's claim). It is split into three pieces (construction 7599-7754, `mcpDesc` 7772-7775, appends 7778-7780) and is **interleaved** with autoban code (the `safetyNote`/`modeHelpText` at 7756-7770 sit between them). The range 7773-7954 in the current file is mostly autoban automation-rules code — deleting it wholesale would destroy the AUTOMATION engine and orphan `mcpRow`/`mcpConfigPanel`. Extraction must pull the three monitor pieces out surgically, not by deleting a line range.

The Comms Monitor is rendered as a subsection inside the autoban panel's `container` div. It shares the same `guardInteraction` mechanism (defined at line 7545, sets `isAutobanPanelInteracting`), the same re-render cycle (`renderAutobanPanel` at line 8865, which targets `#automation-panel-root`), and the same "interaction guard" that blocks re-renders during user input. This coupling means a Comms Monitor config change can trigger an autoban panel re-render (and vice versa), and the interaction guard that's meant for automation rules also affects the monitor config.

**Note on current labels:** the code still says `MCP MONITOR:` (line 7603) and "The MCP Monitor periodically pings…" (line 7775). Renaming these to "COMMS MONITOR" is owned by the sibling **rename-display-labels** subtask — this move must PRESERVE the existing `MCP MONITOR:` text verbatim and not pre-apply the rename (see Dependencies).

**Why a new tab (not a move to an existing tab):**
- **AGENTS tab:** Wrong fit. The AGENTS tab is a simple list of agent visibility checkboxes + CLI commands. The Comms Monitor has a rich config UI (sources, interval, prompt preview, dependency notice, model indicator) that doesn't match the AGENTS tab's pattern.
- **REMOTE tab:** Wrong fit. REMOTE is about driving the kanban board remotely via Linear/Notion. The Comms Monitor is about monitoring communications, not controlling boards.
- **A new COMMS tab:** Correct fit. The Comms Monitor is a distinct feature with its own config, its own terminal, and its own purpose. A dedicated tab gives it room to grow and cleanly separates it from kanban automation.

## Metadata

- **Tags:** frontend, ui, ux, refactor
- **Complexity:** 6
- **Repo:** (root workspace — Switchboard extension)
- **Project:** switchboard
- **Files touched:** `src/webview/kanban.html` (required). `src/services/KanbanProvider.ts` is **optional** — only if the lazy `requestMcpMonitorConfig` message in Step 7 is adopted. Note the config is *already* pushed to the webview on the `ready` message (`KanbanProvider.ts:5902` → `postMcpMonitorConfig()`), so Step 7 is not strictly required (see Step 7).

### Verified Anchors (kanban.html, read 2026-07-03)

| Element | Real line | Earlier-draft claim |
| :--- | :--- | :--- |
| Tab bar `<div class="shared-tab-bar">` | 2494-2503 | 2523-2533 |
| Tabs present | KANBAN, AGENTS, PROMPTS, AUTOMATION, WORKTREES, UAT, SETUP (**7 tabs, no REMOTE**) | 8 incl. REMOTE |
| `automation-tab-content` div | 2581-2583 (root `#automation-panel-root`) | 2613 |
| `createAutobanPanel()` | 7511 | 7690 |
| `guardInteraction` (sets `isAutobanPanelInteracting`) | 7545 | 7719 |
| Monitor construction (`mcpRow`…listeners) | 7599-7754 | (part of 7773-7954) |
| `mcpDesc` text | 7772-7775 | (7775 matches) |
| Monitor `appendChild` calls | 7778-7780 | — |
| `saveMonitorConfig` | 7732 | 7906 |
| `renderAutobanPanel()` (targets `#automation-panel-root`) | 8865 | 9039 |
| Automation-render tab-switch `forEach` | 8896-8906 (`getAutobanConfig` at 8901) | 9070/9074 |
| Generic tab show/hide `forEach` | 3879-3935 (auto-switches any `data-tab`) | — |
| `updateMcpMonitorConfig` msg handler | 6732-6735 | 6803 |
| `isAutobanPanelInteracting` declared | 6068 | — |
| `mcpMonitorConfig` / `mcpMonitorPresets` declared | 6078 / 6080 | — |
| `mcpMonitorResolvedCmd` / `resolvedStartupCommand` | **does not exist** | referenced in Step 6 |

**REMOTE tab reality:** the REMOTE tab no longer lives in kanban.html — it moved to `project.html` (see the comment at kanban.html:2585-2586). Any plan text that treats REMOTE as a kanban tab is stale; corrected below.

## User Review Required

- **Tab placement / count:** Confirm COMMS should sit between UAT and SETUP, making 8 kanban tabs total (KANBAN, AGENTS, PROMPTS, AUTOMATION, WORKTREES, UAT, COMMS, SETUP). There is no REMOTE tab to place it near.
- **Sequencing decision (epic-owned):** This move relocates the exact UI block that ~7 sibling subtasks edit. Reviewer must confirm this subtask runs **first** so siblings target the new `createCommsPanel()`, OR accept the fallback plan (siblings ship first → their additions must be carried across during extraction). This plan does not unilaterally set epic order.
- **Step 7 backend change:** Confirm whether to add the optional `requestMcpMonitorConfig` handler (touches `KanbanProvider.ts`) or rely on the existing `ready`-time push (kanban.html-only).
- **Label preservation:** Confirm the move keeps `MCP MONITOR:` text as-is (rename is a separate subtask).

## Complexity Audit

**Moderate-complex refactor (6/10).** Single primary file (`kanban.html`); the risk is concentration, not file count.

### Routine
- Adding a new tab button (`data-tab="comms"`) + `#comms-tab-content` container — the generic tab-switch handler (3879-3935) picks up any `data-tab`/`${tab}-tab-content` pair automatically, so show/hide needs no new code.
- Adding a `renderCommsPanel()` mirroring `renderAutobanPanel()` (8865) against a new `#comms-panel-root`.
- Wiring one extra `else if` branch in the automation-render `forEach` (8896).
- No new backend logic (config already flows via existing `setMcpMonitorConfig`/`launchMcpMonitorTerminal` messages and the `ready`-time push).

### Complex / Risky
- **Non-contiguous, interleaved extraction.** The monitor code is three separate pieces (7599-7754, 7772-7775, 7778-7780) interleaved with autoban's `safetyNote`/`modeHelpText` (7756-7770). There is no clean line range to cut. Missing a piece orphans DOM or leaves dead references.
- **Interaction-guard split.** Both panels share `isAutobanPanelInteracting` (declared 6068) and `guardInteraction` (7545). A new `isCommsPanelInteracting` + `guardCommsInteraction` must be introduced, and every monitor field's `guardInteraction(...)` call must be re-pointed to the comms guard — miss one and typing in a monitor field silently blocks the autoban panel (or vice versa).
- **Shared closures.** `saveMonitorConfig` (7732), `mcpMonitorConfig`/`mcpMonitorPresets` (6078/6080) and the monitor's event listeners are defined in `createAutobanPanel`'s scope; they must move into `createCommsPanel`'s scope intact (module-level vars stay module-level; the fn + listeners move together).
- **Re-render trigger relocation.** `updateMcpMonitorConfig` (6732) currently re-renders nothing monitor-specific because the monitor rode the autoban re-render; after extraction it must call `renderCommsPanel()` (see Step 6).
- **Six/seven siblings edit this same block** (see Dependencies) — the biggest risk is coordination, not code.

**Backend:** effectively unchanged. The webview still sends/receives the same messages; only rendering location changes. (The earlier note cited `KanbanProvider.ts:5746-5754`; the real monitor handlers are `setMcpMonitorConfig` at 6263 and `launchMcpMonitorTerminal` at 6269, and `postMcpMonitorConfig` lives in `TaskViewerProvider.ts:20579/20600`.)

## Edge-Case & Dependency Audit

### Race Conditions
- **Interaction-guard cross-blocking:** Today the monitor's fields call `guardInteraction` (defn at line 7545) which sets `isAutobanPanelInteracting = true`. After extraction, a new `isCommsPanelInteracting` + `guardCommsInteraction` (same 2-second timeout pattern) must guard the comms fields so typing in the monitor doesn't suppress an autoban re-render, and vice versa. Every monitor field's guard call must be re-pointed; a stray `guardInteraction` left on a comms field re-introduces the coupling.
- **Config-push vs first-render:** `postMcpMonitorConfig()` fires on webview `ready` (KanbanProvider.ts:5902), possibly before the user opens COMMS. `renderCommsPanel()` must read whatever `mcpMonitorConfig` currently holds and be safe to call repeatedly.

### Security
- None. No new IPC surface if Step 7 is skipped; if adopted, `requestMcpMonitorConfig` is a parameterless pull of already-persisted config.

### Side Effects
- **Re-render triggers:** `renderAutobanPanel()` runs on `terminalStatuses` and `customAgents` messages (8885-8892). The monitor used to ride that re-render; after extraction it no longer updates on those messages (correct — it doesn't depend on terminal/agent state), so `updateMcpMonitorConfig` (6732) must now explicitly call `renderCommsPanel()` (Step 6).
- **Tab persistence:** On reload the tab bar defaults to KANBAN (`active` on the KANBAN button, line 2495). No tab persists across reloads — existing behavior, no change needed.

### Dependencies & Conflicts
- **Tab bar reality:** The tab bar (2494-2503) has **7 tabs**: KANBAN, AGENTS, PROMPTS, AUTOMATION, WORKTREES, UAT, SETUP. **There is no REMOTE tab** (it moved to `project.html`; see comment at 2585-2586). Adding COMMS makes **8**. Place COMMS between UAT and SETUP — a tail/utility slot. The bar already scrolls/wraps, so 8 is fine.
- **Initial config load:** No extra request is strictly required — `postMcpMonitorConfig()` already runs on webview `ready` (KanbanProvider.ts:5902), so `mcpMonitorConfig` is populated before COMMS is ever opened. `renderCommsPanel()` can render from state on first tab click. (`postMcpMonitorConfig`/`_postMcpMonitorConfig` live at `TaskViewerProvider.ts:20600`/`20579` — not 20508.) A lazy `requestMcpMonitorConfig` (Step 7) is an optional belt-and-braces enhancement, not a prerequisite.
- **Shared surfaces this plan touches:** `createAutobanPanel()` (7511), the tab bar (2494-2503), the automation tab-content region (2581-2583), the automation-render `forEach` (8896), and the `updateMcpMonitorConfig` handler (6732) — all also read/edited by siblings.
- **This move relocates the block ~7 siblings edit** — see `## Dependencies`. Single most important ordering dependency in the epic.
- **Label preservation:** keep `MCP MONITOR:` (7603) and the `mcpDesc` "MCP Monitor…" text (7775) verbatim; the rename is `rename-display-labels`'s job. Do not pre-apply it here.
- **No `confirm()` dialogs.** No new dialogs introduced (consistent with the project's no-confirm rule).

## Proposed Changes

### 1. `src/webview/kanban.html` — add the COMMS tab button

In the tab bar (lines **2494-2503** — note: **there is no REMOTE tab**; it moved to `project.html`), add the COMMS button between UAT and SETUP. Insert one line at line 2502 (`<button class="shared-tab-btn" data-tab="comms">COMMS</button>`). Result:

```html
    <div class="shared-tab-bar">
        <button class="shared-tab-btn active" data-tab="kanban">KANBAN</button>
        <button class="shared-tab-btn" data-tab="agents">AGENTS</button>
        <button class="shared-tab-btn" data-tab="prompts">PROMPTS</button>
        <button class="shared-tab-btn" data-tab="automation">AUTOMATION</button>
        <button class="shared-tab-btn" data-tab="worktrees">WORKTREES</button>

        <button class="shared-tab-btn" data-tab="uat">UAT</button>
        <button class="shared-tab-btn" data-tab="comms">COMMS</button>
        <button class="shared-tab-btn" data-tab="setup">SETUP</button>
    </div>
```

The generic tab-switch handler (`kanbanTabButtons.forEach` at **3879-3935**) matches on `data-tab` → `${tab}-tab-content` automatically, so this button will show/hide the new content div with no extra wiring for visibility. The only extra wiring needed is the render call (Step 5).

### 2. `src/webview/kanban.html` — add the COMMS tab content container

The automation tab content is `#automation-tab-content` at **2581-2583** (its root is `<div id="automation-panel-root" class="automation-panel"></div>`). Add a sibling COMMS content div nearby (e.g. after the UAT/SETUP content blocks; exact position doesn't matter since the generic handler toggles `active`). Mirror the automation pattern:

```html
    <!-- Comms Tab Content -->
    <div id="comms-tab-content" class="shared-tab-content">
        <div id="comms-panel-root" class="automation-panel"></div>
    </div>
```

### 3. `src/webview/kanban.html` — extract the Comms Monitor rendering into `createCommsPanel()`

Extract the MCP Monitor rendering code from `createAutobanPanel()` into a new function `createCommsPanel()`. **The code to move is NON-CONTIGUOUS** (see "Verified Anchors"): (a) construction `mcpRow`/`mcpSelect` → `saveMonitorConfig` → listeners at **7599-7754**, (b) `mcpDesc` at **7772-7775**, (c) the three `container.appendChild(mcpRow/mcpDesc/mcpConfigPanel)` calls at **7778-7780**. Do **not** cut a line range — the autoban `safetyNote`/`modeHelpText` (7756-7770) is interleaved between (a) and (b) and must stay in `createAutobanPanel`. This function builds and returns a container div with all the Comms Monitor UI:

```js
        function createCommsPanel() {
            const container = document.createElement('div');
            container.style.cssText = 'padding:12px; overflow-y:auto; height:100%;';

            // Comms header — KEEP the existing label text. The current code says
            // 'MCP MONITOR:' (kanban.html:7603); renaming to 'COMMS MONITOR' is the
            // rename-display-labels sibling subtask's job. Preserve 'MCP MONITOR:'
            // here so the two subtasks don't collide / double-rename.
            const commsHeader = document.createElement('div');
            commsHeader.className = 'subsection-header';
            const commsHeaderSpan = document.createElement('span');
            commsHeaderSpan.textContent = 'MCP MONITOR';  // rename subtask changes this later
            commsHeader.appendChild(commsHeaderSpan);
            container.appendChild(commsHeader);

            // Intro text — reuse the existing mcpDesc copy verbatim (it currently
            // starts "The MCP Monitor periodically pings…", line 7775). Do NOT
            // reword to "Comms Monitor" — that is the rename subtask.
            const introText = document.createElement('div');
            introText.style.cssText = 'padding:0 8px 8px 8px; font-family:var(--font-mono); font-size:10px; color:var(--text-secondary); line-height:1.5;';
            introText.textContent = 'The MCP Monitor periodically pings a dedicated Claude terminal to check your Slack, Gmail, and Google Calendar for new messages and events — so you don\'t have to open those apps manually. Results appear in the monitor terminal pane.';
            container.appendChild(introText);

            // ─── Move all MCP Monitor UI here (mcpRow, mcpConfigPanel, etc.) ───
            // (Pieces at 7599-7754 + mcpDesc 7772-7775 + appends 7778-7780,
            //  adapted to use this container instead of the autoban container,
            //  and guardCommsInteraction/isCommsPanelInteracting instead of
            //  guardInteraction/isAutobanPanelInteracting)

            // ... [all the mcpRow, mcpSelect, mcpConfigPanel, intervalRow,
            //      sourcesList, customInstructionRow, statusLine, mcpHelp code] ...
            // ... [moved verbatim, with container.appendChild() instead of
            //      being appended to the autoban container] ...

            return container;
        }
```

**Key extraction details:**
- **Shared style variables:** if the monitor fields reference any autoban-scoped style constants (e.g. an `autobanSelectStyle`-style helper) defined inside `createAutobanPanel`, hoist them to module scope so both panels use them; otherwise inline the styles the monitor already uses. Verify by grepping the moved snippet for any identifier defined only in `createAutobanPanel`'s body before the move — the earlier draft's "lines 7715-7718" is not a reliable anchor.
- **Interaction guard:** `guardInteraction` (defn at **line 7545**) sets `isAutobanPanelInteracting` (declared **6068**). Create a parallel `isCommsPanelInteracting` flag + `guardCommsInteraction` function (same 2-second timeout pattern) and re-point every monitor field's guard call to it. Missing one silently couples the panels.
- **`saveMonitorConfig`** (defn at **line 7732**, not 7906) and all monitor event listeners (7749-7754) move together with the monitor code into `createCommsPanel`.
- **Module-level state** (`mcpMonitorConfig` 6078, `mcpMonitorPresets` 6080) stays module-level — only the rendering closure moves.

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
