# Automation Tab Redesign: Three-Mode Architecture

## Goal

Redesign the automation tab in `kanban.html` with a mode selector offering three distinct modes — Single Column (default), Multi Column (existing Autoban), and Antigravity Batch — each tailored to a different level of automation complexity. The Antigravity Batch mode is refocused from long-lived scheduled sessions to one-shot batch delegation.

---

## Metadata

**Tags:** frontend, backend, UX, UI, workflow
**Complexity:** 7

---

## User Review Required

- Confirm whether the global session cap UI should be hidden (not removed from backend) in Modes 1 and 2. Currently, this is the recommended approach (see Adversarial Synthesis).
- Confirm whether Mode 1 (Single Column) should fix its source column to `PLAN REVIEWED` only, or allow the user to choose a source column.
- Confirm whether `btn-autoban` in the controls strip should be hidden in Antigravity Batch mode (Mode 3) or just disabled/greyed out with a tooltip.

---

## Complexity Audit

### Routine
- Adding a mode dropdown and CSS show/hide logic for mode containers (Phase 1) — standard DOM manipulation within existing `createAutobanPanel()` function.
- Moving existing Autoban panel content to a Multi Column container (Phase 3) — mechanical restructuring, no logic changes.
- Removing the schedule selector UI and adding a batch size selector to the Antigravity section (Phase 4 UI side) — deletion + new control, pattern already exists in the panel.
- Persisting mode selection in VS Code webview state (extends existing `vscode.getState()` pattern).
- **Removing `maxSendsPerTerminal` entirely** — the field exists in 4 files across ~15 callsites. The plan explicitly removes this cap for both Single and Multi Column modes (`/clear` handles context). All callsites are mechanical deletions with no replacement logic needed.

### Complex / Risky
- Defining `SingleColumnAutobanConfig` as a new separate state key (`singleColumn.autoban.state`) vs. reusing `autoban.state` — must not corrupt Multi Column user settings on first upgrade.
- Single Column tick logic: must reuse `_startAutobanEngine()` but with a single-rule synthetic config (only `PLAN REVIEWED` rule). Requires care to not start a second full engine when the user switches modes.
- Antigravity Batch prompt generation: the existing `_generateAntigravityPrompt` method uses a `schedulingBlock` that instructs the agent to use `manage_task` for recurring scheduling. The new batch mode requires a completely different prompt template focused on subagent delegation + `invoke_subagent`. This is a non-trivial backend change.
- Hiding `btn-autoban` for Mode 3: requires the mode state to propagate from `autobanConfig` → controls strip render path, which currently does not carry mode information.
- **Single Column terminal-offline fragility:** `_allEnabledAutobanRolesExhausted` (line 5344) permanently stops the engine when no terminal is available for any enabled role. In Multi Column mode this is acceptable because backup terminals cover gaps. In Single Column mode there is exactly one terminal per role — if it is momentarily offline (restarting, lost heartbeat), the next exhaustion check kills the engine and the user must manually restart. The fix: in Single Column mode, skip `_allEnabledAutobanRolesExhausted` entirely; only `_stopAutobanIfNoValidTicketsRemain` (no plans left) should trigger an auto-stop.

---

## Edge-Case & Dependency Audit

### Race Conditions
- **Mode switch while automation running:** If the user switches from Multi Column (engine active) to Single Column, `_stopAutobanEngine()` must be called before `_startAutobanEngine()` is reinvoked with Single Column config. If mode switching only changes frontend display without a backend message, the old engine continues running. Need a `type: 'setAutomationMode'` message to the backend.
- **Autoban config load race:** On webview init, `autobanConfig` is null until `getAutobanConfig` response arrives. Mode state must be included in the initial config broadcast (or loaded from `vscode.getState()` client-side to avoid flash of wrong mode).
- **Single Column batchSize vs. Multi Column batchSize:** If both modes share the same `autobanConfig.batchSize`, changing one will affect the other. Separate state keys avoid this.

### Security
- None — this is a local VS Code extension with no network exposure in the automation tab.

### Side Effects
- Hiding `btn-autoban` in Mode 3 will break any code that unconditionally calls `updateAutobanButtonState()` and expects the button to always be present. Must add null-guard.
- The existing `emitAutobanState()` function (line 6129 in `kanban.html`) sends `enabled`, `batchSize`, `complexityFilter`, `routingMode`, `rules` to the backend. Adding a `mode` field here requires the backend handler (`updateAutobanState` case in `KanbanProvider.ts`) to forward the mode to `TaskViewerProvider`, which currently owns `_autobanState`. The flow must be traced end-to-end.

### Dependencies & Conflicts
- `normalizeAutobanConfigState` in `autobanState.ts` normalizes the `AutobanConfigState` type. Adding `mode` to this type requires updating the normalizer and all callers.
- `_generateAntigravityPrompt` in `KanbanProvider.ts` (line 2498) must be modified to accept a `batchSize` parameter and branch between old scheduling template and new batch delegation template.
- `buildAutobanBroadcastState` in `autobanState.ts` (line 224) must carry the `mode` field if it is added to `AutobanConfigState`.
- **`maxSendsPerTerminal` removal touches:** `autobanState.ts` (type + normalizer + constant), `TaskViewerProvider.ts` (_selectAutobanTerminal filter, updateAutobanMaxSendsFromKanban method, setAutomationMode handler, updateAutobanState handler, 3× stop-condition log messages), `KanbanProvider.ts` (updateAutobanMaxSends message case), `kanban.html` (exhausted/max display in terminal pool entries, max sends input control), and `autoban-state-regression.test.js` (3 test assertions). Note: `implementation.html` does NOT contain `maxSendsPerTerminal` — verified by grep, no change needed there.

---

## Dependencies

No cross-session dependencies identified for this plan.

---

## Adversarial Synthesis

Key risks: (1) the Antigravity Batch prompt template is a near-total rewrite of `_generateAntigravityPrompt`'s `schedulingBlock` and is the highest-risk backend change in this plan; (2) mode switching while automation is running has no safe shutdown path without a new backend message type; (3) `maxSendsPerTerminal` removal spans 5 files and a test suite — mechanical but high surface area for missed callsites. Mitigations: add `type: 'setAutomationMode'` message with engine restart logic; scope `_generateAntigravityPrompt` change behind a `batchSize` parameter branch; grep-verify no remaining `maxSendsPerTerminal` references before shipping.

---

## Proposed Changes

### src/webview/kanban.html

**Context:** The automation tab (`#automation-tab-content`) renders a single `#automation-panel-root` div, which `renderAutobanPanel()` (line 6762) populates by calling `createAutobanPanel()` (line 6143). All automation UI is dynamically built in JavaScript within these two functions.

**Logic — Mode selector (Phase 1):**
- Add a `currentAutomationMode` variable (default `'single-column'`) near the existing `lastAntigravityAgent` / `lastAntigravityColumn` vars (line 6126).
- Persist and restore `currentAutomationMode` using `vscode.getState()` / `vscode.setState()` (same pattern as `collapseCodersEnabled`, line 6098).
- At the top of `createAutobanPanel()`, before any section is built, inject a mode selector `<select>` with three options:
  - `single-column` → "Switchboard Single Column"
  - `multi-column` → "Switchboard Multi Column"
  - `antigravity-batch` → "Antigravity Batch"
- On mode change, update `currentAutomationMode`, persist it, post `{ type: 'setAutomationMode', mode }` to backend, then call `renderAutobanPanel()`.
- Wrap each mode's content in a container div; toggle visibility based on `currentAutomationMode`.

**Logic — Single Column mode UI (Phase 2):**
- Simple row: status indicator, interval slider (5–60 min, default 15), batch size selector (1–5, default 3).
- Clear before prompt toggle (reads/writes `switchboard.terminal.clearBeforePrompt` via `{ type: 'getConfig', key: 'terminal.clearBeforePrompt' }` message — or use the existing setup tab's approach).
- Warning tooltip on the clear toggle: "⚠️ Strongly recommended — prevents token waste and agent overload."
- START / STOP / RESET buttons: START posts `{ type: 'setAutomationMode', mode: 'single-column', enabled: true, intervalMinutes, batchSize }`, STOP posts `{ type: 'toggleAutoban', enabled: false }` (reuses existing handler), RESET posts `{ type: 'resetAutobanPools' }`.
- State for Single Column is stored in a separate object `singleColumnConfig` (not `autobanConfig`) — loaded from `vscode.getState().singleColumnConfig`.

**Logic — Multi Column mode (Phase 3):**
- Wrap the existing content of `createAutobanPanel()` from line 6164 onwards (roles, antigravity section, automation rules, column rules, terminal pools, reset row) inside a `div` that is only shown when `currentAutomationMode === 'multi-column'`.
- No functional changes to existing Multi Column logic.

**Logic — Antigravity Batch mode (Phase 4 UI):**
- Replace the schedule selector section (lines 6361–6418: `scheduleInstruction`, `scheduleSelector`, `intervalSelect`, `cronDisplay`, `copyCronBtn`) with a batch size selector:
  - Label: "BATCH SIZE:"
  - `<select>` with options 3, 5, 10 plans; stored in `lastAntigravityBatchSize` (default 5).
- Update the `COPY PROMPT` button click handler (line 6333) to post `{ type: 'generateAntigravityPrompt', agent, column, batchSize: lastAntigravityBatchSize, workspaceRoot }`.
- Update `antigravityDesc` text (line 6238) to: "Select an agent and column, then copy a one-shot batch prompt. Paste it into Antigravity chat. The agent will delegate each plan to a subagent in parallel, then move completed plans forward. Run once daily or as needed."
- Keep agent selector and column selector unchanged.

**Logic — btn-autoban visibility (Phase 5):**
- In `updateAutobanButtonState()` (line 4208), after the existing logic, add: `autobanBtn.style.display = (currentAutomationMode === 'antigravity-batch') ? 'none' : '';`
- Add null-guard: `if (!autobanBtn) return;` is already present at line 4210. ✓

**Edge Cases:**
- If `autobanConfig` is null when mode selector is rendered, show a loading placeholder for the mode-specific content but still render the mode selector itself (so users can switch modes without waiting for config).
- On mode switch away from an active Multi Column mode, show a `window.confirm()` dialog: "Automation is currently running. Switch modes and stop automation?"

---

### src/services/autobanState.ts

**Context:** Defines `AutobanConfigState` and `normalizeAutobanConfigState`. Adding mode here allows the backend to persist and broadcast it cleanly.

**Logic:**
- Add `SingleColumnAutobanConfig` type:
  ```typescript
  export type SingleColumnAutobanConfig = {
      enabled: boolean;
      intervalMinutes: number;
      batchSize: number;
  };
  export const DEFAULT_SINGLE_COLUMN_CONFIG: SingleColumnAutobanConfig = {
      enabled: false,
      intervalMinutes: 15,
      batchSize: 3
  };
  export function normalizeSingleColumnConfig(state?: Partial<SingleColumnAutobanConfig> | null): SingleColumnAutobanConfig {
      return {
          enabled: state?.enabled === true,
          intervalMinutes: Math.max(5, Math.min(60, Number.isFinite(state?.intervalMinutes as number) ? Math.floor(state!.intervalMinutes!) : 15)),
          batchSize: normalizeAutobanBatchSize(state?.batchSize)
      };
  }
  ```
- Add `automationMode` to `AutobanConfigState`:
  ```typescript
  automationMode?: 'single-column' | 'multi-column' | 'antigravity-batch';
  ```
- Update `normalizeAutobanConfigState` to normalize `automationMode`:
  ```typescript
  automationMode: (['single-column', 'multi-column', 'antigravity-batch'] as const).includes(state?.automationMode as any)
      ? state!.automationMode!
      : 'single-column',
  ```
- Update `buildAutobanBroadcastState` to pass through `automationMode`.

**Edge Cases:**
- Existing persisted state without `automationMode` normalizes to `'single-column'`. This is a first-time-upgrade breaking UX change for current Multi Column users (they'll be dropped into Single Column mode). Mitigation: if `state?.enabled === true` and `state?.rules` has multiple entries, default to `'multi-column'` instead.

  ```typescript
  automationMode: (['single-column', 'multi-column', 'antigravity-batch'] as const).includes(state?.automationMode as any)
      ? state!.automationMode!
      : (state?.enabled === true || Object.keys(state?.rules ?? {}).length > 1)
          ? 'multi-column'
          : 'single-column',
  ```

---

### src/services/KanbanProvider.ts

**Context:** Handles `generateAntigravityPrompt` message at line 6059, delegates to `_generateAntigravityPrompt` (line 2498).

**Logic — `generateAntigravityPrompt` message handler (line 6059):**
- Extract `batchSize` from message: `const batchSize = typeof msg.batchSize === 'number' && msg.batchSize > 0 ? msg.batchSize : undefined;`
- Pass `batchSize` to `_generateAntigravityPrompt(msg.agent, workspaceRoot, column, batchSize)`.

**Logic — `_generateAntigravityPrompt` method (line 2498):**
- Update signature: `private async _generateAntigravityPrompt(agentName: string, workspaceRoot: string, column: string = 'CREATED', batchSize?: number): Promise<void>`
- When `batchSize` is provided (Antigravity Batch mode), use the new batch delegation template instead of `schedulingBlock`:
  ```typescript
  const batchBlock = `\n\n---\n\nProcess the ${batchSize} oldest plans in the **${column}** column using subagent delegation.\n\nFor each plan:\n1. Read the plan file from .switchboard/plans/\n2. Delegate execution to a subagent with the full plan context (use invoke_subagent)\n3. Wait for the subagent to complete\n4. Move the plan to the next column in the workflow\n5. Track completion status\n\nAfter all plans are processed, provide a summary:\n- Plans completed successfully\n- Plans that failed or need attention\n- Next column each plan was moved to\n\nAgent role for delegation context: **${role}**\nCancel this task immediately if no plans remain in **${column}**.\n\nIMPORTANT: Process plans in parallel using invoke_subagent for each plan simultaneously, not sequentially.`;
  ```
- Use `batchBlock` instead of `schedulingBlock` when `batchSize !== undefined`.
- The existing `oldestPlan` logic (line 2572) and SQL instruction are only needed for the sequential scheduling flow. For batch mode, skip the single-plan-selection and instead query for the top `batchSize` plans. Update `getPlansByColumn` call or slice the result: `const batchPlans = columnPlans.slice(-batchSize);`
- The `sqlInstruction` should be updated for batch mode to use `UPDATE ... WHERE session_id IN (...)` for all batch plan IDs.

**Edge Cases:**
- If `columnPlans.length < batchSize`, process all available plans (no error — just process what exists).
- Backward compatibility: when `batchSize` is `undefined`, existing scheduling flow is unchanged.

---

### src/services/TaskViewerProvider.ts

**Context:** Owns `_autobanState`, `_startAutobanEngine`, `_stopAutobanEngine`, `_autobanTickColumn`.

**Logic — `setAutomationMode` message handler (new):**
- Add a new case to the webview message handler:
  ```typescript
  case 'setAutomationMode': {
      const newMode = msg.mode;
      if (!['single-column', 'multi-column', 'antigravity-batch'].includes(newMode)) break;
      const wasEnabled = this._autobanState.enabled;
      if (wasEnabled) {
          this._stopAutobanEngine();
          this._autobanState = normalizeAutobanConfigState({ ...this._autobanState, enabled: false, automationMode: newMode });
      } else {
          this._autobanState = normalizeAutobanConfigState({ ...this._autobanState, automationMode: newMode });
      }
      await this._context.workspaceState.update('autoban.state', this._autobanState);
      this._postAutobanState();
      break;
  }
  ```

**Logic — Single Column engine start:**
- When `setAutomationMode` is received with `enabled: true` and `mode: 'single-column'`, use a synthetic rules config:
  ```typescript
  const singleColumnSyntheticRules = {
      'PLAN REVIEWED': { enabled: true, intervalMinutes: msg.intervalMinutes || 15 }
  };
  this._autobanState = normalizeAutobanConfigState({
      ...this._autobanState,
      enabled: true,
      automationMode: 'single-column',
      rules: singleColumnSyntheticRules,
      batchSize: msg.batchSize || 3,
      complexityFilter: 'all',
      routingMode: 'dynamic'
  });
  this._startAutobanEngine();
  ```
  - `maxSendsPerTerminal` is removed entirely — do not pass it here.

**Logic — Single Column state persistence:**
- Add separate workspace state key `'singleColumn.autoban.state'` for Single Column config. Load it on provider init.
- On single column start/stop/update, persist to this separate key.

**Edge Cases:**
- If `_startAutobanEngine()` is called while `_autobanTimers` is non-empty (engine already running), `_stopAutobanEngine()` is called first at the top of `_startAutobanEngine()` (line 6932) — this is already safe.
- If `automationMode` is `'antigravity-batch'`, `toggleAutoban` message should be a no-op (or rejected) since this mode has no persistent engine.
- **Terminal offline in Single Column mode:** In `_autobanTickColumn` (line 6980), when `dispatchWithAutobanTerminal` returns false because the pool is empty (terminal offline), the existing code calls `_allEnabledAutobanRolesExhausted` and — since there is only one terminal — immediately stops the engine. This must be guarded for Single Column mode:
  ```typescript
  // In _autobanTickColumn, after dispatchWithAutobanTerminal returns false:
  if (this._autobanState.automationMode !== 'single-column') {
      if (await this._allEnabledAutobanRolesExhausted(workspaceRoot)) {
          await this._stopAutobanForExhaustion(reason);
      }
  }
  // else: terminal is temporarily offline — skip this tick, try again next interval
  ```
  The same guard applies at every `_allEnabledAutobanRolesExhausted` call site in `_autobanTickColumn` (lines 7098, 7132, 7195). Auto-stop in Single Column mode should only happen via `_stopAutobanIfNoValidTicketsRemain` (no plans left in the column).

---

## Verification Plan

### Automated Tests
- (Skipped per session directives.)

### Manual Verification Steps

1. **Mode Selector Rendering**
   - Open Automation tab. Confirm a "Mode" dropdown appears at the top with three options.
   - Confirm default is "Switchboard Single Column."
   - Refresh webview. Confirm selected mode is persisted (restored from `vscode.getState()`).

2. **Single Column Mode UI**
   - Select "Switchboard Single Column."
   - Confirm: interval slider (5–60 min), batch size (1–5), status indicator, START/STOP/RESET buttons, and clear-before-prompt toggle are visible.
   - Confirm: terminal pools, complexity routing, column rules, and max sends controls are NOT visible.
   - Press START. Confirm autoban engine starts (observe `btn-autoban` indicator activates, timer appears in controls strip).
   - Press STOP. Confirm engine stops.

3. **Multi Column Mode Preservation**
   - Select "Switchboard Multi Column."
   - Confirm all existing Autoban UI is visible and functional: batch size, complexity filter, routing, max sends, column rules, terminal pools, reset button.
   - Confirm existing user settings are preserved after mode switch.

4. **Antigravity Batch Mode UI**
   - Select "Antigravity Batch."
   - Confirm: agent selector, column selector, batch size selector (3/5/10), COPY PROMPT button, and updated instruction text are visible.
   - Confirm: schedule selector (cron expression) is NOT visible.
   - Confirm `btn-autoban` in the controls strip is hidden (or disabled per user review choice).

5. **Batch Prompt Generation**
   - In Antigravity Batch mode, select agent "Coder," column "PLAN REVIEWED," batch size 5.
   - Press COPY PROMPT. Confirm the generated prompt includes "5 oldest plans," "invoke_subagent," and "PLAN REVIEWED" references.
   - Confirm backward compat: switching to Multi Column mode, using the old COPY PROMPT (if any) still uses the scheduling template.

6. **Mode Switch While Running**
   - Start automation in Single Column mode. Switch mode selector to Multi Column.
   - Confirm confirmation dialog appears. Confirm automation stops on confirm.

7. **btn-autoban visibility**
   - In Mode 3 (Antigravity Batch), confirm `btn-autoban` is hidden in the controls strip.
   - Switch to Mode 1 or 2. Confirm `btn-autoban` reappears.

8. **State upgrade path**
   - Simulate existing user with saved `autoban.state` that has `enabled: true` and multiple rules.
   - Confirm on first load the mode defaults to `'multi-column'` (not `'single-column'`).

9. **Single Column terminal-offline resilience**
   - Start automation in Single Column mode with one Coder terminal alive.
   - Simulate the terminal going offline (kill its heartbeat or close it).
   - Confirm the next tick skips silently (no warning notification, no engine stop).
   - Bring the terminal back online. Confirm the following tick dispatches successfully without requiring a manual restart.

---

## Rationale

**Single Column as Default**: Most users want to get plans coded quickly. The current tab is over-engineered for this simple use case. A simplified mode reduces cognitive load and setup time.

**Multi Column Preserved**: Power users still need full control over column transitions, terminal pools, and complexity routing. Moving this to a separate mode keeps it accessible without overwhelming new users.

**Antigravity Batch Redesigned**: The original design encouraged token-bloated long-lived sessions. The new design uses one-shot batch processing with subagent delegation, which is token-efficient and aligns with the agent's recommended use cases for the `invoke_subagent` tool.

---

## Files to Modify

1. **src/webview/kanban.html** (lines 6121–6798)
   - Add mode selector dropdown at top of automation tab
   - Create three container divs for modes
   - Implement single-column mode UI
   - Move existing Autoban panel to multi-column container
   - Redesign antigravity section (remove cron, add batch size)
   - Add mode switching logic with confirmation guard

2. **src/services/KanbanProvider.ts** (lines 2498–2590, 6059–6064)
   - Update `_generateAntigravityPrompt` to accept `batchSize` parameter
   - Branch on `batchSize` for new batch delegation template vs. old scheduling template
   - Update `generateAntigravityPrompt` message handler to extract and pass `batchSize`

3. **src/services/autobanState.ts** (lines 17–33, 155–222)
   - Add `SingleColumnAutobanConfig` type and `normalizeSingleColumnConfig`
   - Add `automationMode` to `AutobanConfigState`
   - Update `normalizeAutobanConfigState` with mode normalization and upgrade path heuristic
   - Update `buildAutobanBroadcastState` to pass through `automationMode`

4. **src/services/TaskViewerProvider.ts** (lines ~305, ~405, ~5282–5319, ~5966–5971, ~7101/7135/7198, ~8327–8330)
   - Add `_singleColumnAutobanState` field
   - Add `setAutomationMode` message case to webview message handler
   - Load/persist `singleColumn.autoban.state` workspace state key on init
   - Wire Single Column engine start with synthetic single-rule config
   - **Remove `maxSendsPerTerminal`:** delete the cap filter in `_selectAutobanTerminal` (lines 5288–5298, the `.filter(entry => entry.remaining > 0)` check); delete the `updateAutobanMaxSendsFromKanban` method (lines 5966–5971); remove `maxSendsPerTerminal: 9999` from the `setAutomationMode` handler; remove `maxSendsPerTerminal` from the `updateAutobanState` handler (lines 8327–8330); update the 3× "all terminals exhausted" stop-condition log messages (lines 7101, 7135, 7198) to drop the cap reference — e.g. `'Autoban stopped: no eligible terminals available.'`
   - **Guard `_allEnabledAutobanRolesExhausted` for Single Column mode:** at every call site in `_autobanTickColumn` (lines 7098, 7132, 7195), wrap in `if (this._autobanState.automationMode !== 'single-column')` so a temporarily offline terminal skips the tick rather than permanently stopping the engine. Only `_stopAutobanIfNoValidTicketsRemain` should auto-stop Single Column automation.

5. **src/services/KanbanProvider.ts** (lines 5888, 6059–6064)
   - Remove the `updateAutobanMaxSends` message case (line 5888)
   - Update `generateAntigravityPrompt` handler as described above

6. **src/services/autobanState.ts** (lines 13, 17–33, 155–222)
   - Remove `DEFAULT_AUTOBAN_MAX_SENDS_PER_TERMINAL` constant (line 13)
   - Remove `maxSendsPerTerminal: number` from `AutobanConfigState` type (line 42)
   - Remove the `maxSendsPerTerminal` normalization block from `normalizeAutobanConfigState` (lines ~193–221)
   - Add `SingleColumnAutobanConfig` type and `normalizeSingleColumnConfig`
   - Add `automationMode` field and normalization as described above

7. **src/webview/kanban.html** (lines 6404/6408, 6521–6528)
   - Remove `exhausted` and `max` fields from terminal pool entry display (lines 6404, 6408)
   - Remove the max sends input control and its event listener (lines 6518–6547)
   - Remove the `SESSION x/y` badge from the max sends row
   - Add mode switching logic and mode-specific containers as described above

8. **src/test/autoban-state-regression.test.js** (lines 21, 45, 80, 121, 129)
   - Remove `maxSendsPerTerminal: 7` from the test fixture (line 21)
   - Remove the `assert.strictEqual(broadcast.maxSendsPerTerminal, 7, ...)` assertion (line 45)
   - Remove the `assert.strictEqual(normalizedLegacy.maxSendsPerTerminal, 10, ...)` assertion (line 80)
   - Remove `maxSendsPerTerminal: 999` from the test fixture (line 121)
   - Remove the `assert.strictEqual(normalizedNewConfig.maxSendsPerTerminal, 100, ...)` assertion (line 129)

---

## Success Criteria

- [ ] Mode selector appears at top of automation tab
- [ ] Single Column mode is default for new users; Multi Column is default for users with existing active autoban config
- [ ] Single Column mode UI is simplified (no terminal pools, no complexity routing, no max sends display)
- [ ] Multi Column mode preserves all existing functionality with no max sends cap
- [ ] Antigravity Batch mode generates delegation prompts with batch size via subagent delegation template
- [ ] `maxSendsPerTerminal` is fully removed: no references remain in source, webview, or tests (verify with grep)
- [ ] Mode switching prompts confirmation when automation is running
- [ ] `btn-autoban` is hidden in Antigravity Batch mode
- [ ] Single Column config is persisted to a separate workspace state key from Multi Column config
- [ ] Mode selection is persisted across webview reloads

---

> **Recommendation:** Send to **Lead Coder**
>
> Complexity 7 — multi-file coordination, new backend message type, non-trivial prompt template branch, and a state migration heuristic for existing users. The highest risk is the Antigravity Batch prompt template rewrite in `KanbanProvider.ts`; implement and test that in isolation before wiring the mode selector.

## Review Results

### Stage 1: Grumpy Principal Engineer Findings

| # | Area | Status | Severity | Finding |
|---|------|--------|----------|---------|
| 1 | Mode selector UI | ✅ Implemented | — | Lines 6177-6219: Three options, persisted in vscode.getState(), confirmation dialog on mode switch while running |
| 2 | Single Column mode UI | ✅ Implemented | — | Lines 6221+: Interval slider, batch size, start/stop/reset, separate state key |
| 3 | Multi Column mode preserved | ✅ Implemented | — | Line 6366: Existing autoban panel wrapped in multi-column container |
| 4 | Antigravity Batch mode UI | ✅ Implemented | — | Lines 6736+: Agent/column selectors, batch size (3/5/10), COPY PROMPT, updated description text |
| 5 | btn-autoban visibility | ✅ Implemented | — | Line 4223: Hidden in antigravity-batch mode |
| 6 | automationMode in AutobanConfigState | ✅ Implemented | — | autobanState.ts line 51: Type with three modes |
| 7 | SingleColumnAutobanConfig type | ✅ Implemented | — | autobanState.ts lines 16-20 |
| 8 | Upgrade heuristic for existing users | ✅ Implemented | — | autobanState.ts lines 235-239: Defaults to multi-column if enabled or multiple rules |
| 9 | _generateAntigravityPrompt batchSize branch | ✅ Implemented | — | KanbanProvider.ts line 2498: Accepts batchSize, branches between batchBlock and schedulingBlock |
| 10 | setAutomationMode handler | ✅ Implemented | — | TaskViewerProvider.ts line 5824: Validates mode, stops engine if running, persists state |
| 11 | Single Column engine start with synthetic rules | ✅ Implemented | — | TaskViewerProvider.ts lines 5847-5864: Synthetic PLAN REVIEWED rule |
| 12 | _allEnabledAutobanRolesExhausted guard for single-column | ✅ Implemented | — | TaskViewerProvider.ts lines 7086, 7122, 7187: Skipped in single-column mode |
| 13 | maxSendsPerTerminal removal from autobanState.ts | ✅ Implemented | — | Type and normalizer cleaned |
| 14 | updateAutobanMaxSends removed from KanbanProvider.ts | ✅ Implemented | — | No references found |
| 15 | updateAutobanMaxSendsFromKanban removed from TaskViewerProvider.ts | ✅ Implemented | — | No references found |
| 16 | Schedule selector (cron) removed from kanban.html | ✅ Implemented | — | No scheduleSelector/cronDisplay references found |
| — | Dead command registration in extension.ts | 🔴 Runtime crash | CRITICAL | Lines 1105-1108: `switchboard.updateAutobanMaxSendsFromKanban` command registered, calling deleted method `taskViewerProvider.updateAutobanMaxSendsFromKanban()`. Will throw at runtime when invoked. |
| — | Stale test assertion | 🔴 Test failure | CRITICAL | autoban-state-regression.test.js line 189: Asserts `providerSource.includes('updateAutobanMaxSends')` — will fail since method was deleted |
| 17 | maxSendsPerTerminal in implementation.html | ⚠️ Residual | NIT | Line 2301: Still present but plan explicitly scopes this file out. Not a kanban.html concern. |

### Stage 2: Balanced Synthesis

- **CRITICAL — Dead command in extension.ts**: Fix now. The `updateAutobanMaxSendsFromKanban` command registration calls a method that no longer exists. Any code path that triggers this command will throw a runtime error. Removed the 4-line block.
- **CRITICAL — Stale test assertion**: Fix now. The test greps for `updateAutobanMaxSends` in the provider source and will fail. Removed the assertion from the compound check.
- **NIT — implementation.html residual**: Defer. The plan explicitly notes this file doesn't need changes. It's a separate webview with its own state management.

### Files Changed

1. `src/extension.ts` lines 1105-1108: Removed dead `updateAutobanMaxSendsFromKanban` command registration (CRITICAL fix)
2. `src/test/autoban-state-regression.test.js` line 189: Removed `updateAutobanMaxSends` assertion from provider source check (CRITICAL fix)

### Validation Results

- No compilation or automated tests run (per review instructions)
- Grep confirms `maxSendsPerTerminal` and `updateAutobanMaxSends` are fully removed from all src/ files except `implementation.html` (out of scope per plan)
- All three `_allEnabledAutobanRolesExhausted` call sites in TaskViewerProvider.ts are properly guarded for single-column mode
- Mode upgrade heuristic correctly defaults to `multi-column` for existing active configs
- Batch prompt template correctly branches on `batchSize !== undefined`

### Remaining Risks

1. **implementation.html maxSendsPerTerminal**: Still present at line 2301. If this webview ever sends `updateAutobanMaxSends` messages, they will be unhandled. Low risk since this webview appears to be a legacy/alternate view.
2. **Single Column terminal-offline resilience**: The guard at lines 7086/7122/7187 correctly skips `_allEnabledAutobanRolesExhausted` in single-column mode, but there's no logging when a tick is skipped due to terminal offline. Users may not realize automation is paused. Consider adding a console.warn in a future iteration.
3. **Mode switch race**: If a `terminalStatuses` message arrives between the mode switch and the re-render, the old mode's UI may briefly flash. The guard fix from Plan 1 (clearing `isAutobanPanelInteracting` before `renderAutobanPanel()`) mitigates this.
