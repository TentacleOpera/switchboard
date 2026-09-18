# Plan: Customisable /clear-to-prompt delay

## Problem
The delay between sending `/clear` to a terminal and dispatching the actual prompt is hardcoded at ~1.5 s (paced) / ~0.5 s (non-paced). On fast machines with lightweight CLIs the clear finishes instantly, wasting time. On slower machines or heavy CLIs the clear has not finished before the prompt arrives, causing the prompt to be concatenated with residual output.

## Goal
Expose a user-configurable delay (in milliseconds) for the wait between submitting `/clear` and sending the prompt, preserving the existing paced/non-paced scaling ratio.

## Metadata
- **Tags:** [frontend, UX, workflow]
- **Complexity:** 5

## User Review Required
- Confirm default delay value (1500 ms preserves current paced behavior; 2000 ms adds safety margin for slow CLIs).
- Confirm whether non-paced delay should scale proportionally (paced delay / 3) or use the same raw value.

## Complexity Audit
### Routine
- Add `clearBeforePromptDelay` number setting to `package.json` — follows existing setting pattern.
- Read config value in `TaskViewerProvider._attemptDirectTerminalPush` — one-liner addition next to existing config read.
- Add private field + config read in `KanbanProvider` constructor — mirrors existing `_clearTerminalBeforePrompt` pattern.
- Add `clearTerminalBeforePromptDelayState` broadcast messages — mirrors existing boolean state broadcast.
- Add webview message handler and event listener in `kanban.html` — mirrors existing toggle pattern.

### Complex / Risky
- **Paced/non-paced delay scaling**: Applying a single delay value to both paced and non-paced modes changes existing behavior. Must scale proportionally (3:1 ratio) to avoid regressing same-agent dispatch speed.
- **Runtime clamping**: Config value must be clamped at read time to guard against manual `settings.json` edits outside the 0–10000 range.

## Edge-Case & Dependency Audit
- **Race Conditions**: None — the delay is read synchronously from config before the `setTimeout` call. No concurrent writers.
- **Security**: No sensitive data involved. The setting is a numeric delay; no injection risk.
- **Side Effects**: Changing the delay affects the total time before prompt dispatch. A very low value (< 200 ms) may cause prompt concatenation on slow CLIs. A very high value (> 5000 ms) makes the UI feel unresponsive. The `minimum`/`maximum` in `package.json` and runtime clamping mitigate both.
- **Dependencies & Conflicts**: The existing `terminal.clearBeforePrompt` boolean toggle gates the entire clear flow. The delay setting is only relevant when the toggle is on. No conflict with other settings.

## Dependencies
- None — this is a self-contained feature addition.

## Adversarial Synthesis
Key risks: applying a single delay value without paced/non-paced scaling would make same-agent dispatches 3–4x slower; missing runtime clamping allows pathological values from manual settings.json edits; the setup.html addition is scope creep given no terminal UI exists there today. Mitigations: scale non-paced delay as `Math.max(100, Math.round(clearDelay / 3))` to preserve the existing 3:1 ratio; add a one-line `Math.min(Math.max(...))` clamp; defer setup.html to a follow-up.

## Proposed Changes

### `package.json` (lines 249–253)
- **Context**: Currently defines `switchboard.terminal.clearBeforePrompt` (boolean, default `false`) with description "2 seconds".
- **Logic**: Add a new `clearBeforePromptDelay` number setting adjacent to the existing boolean. Update the boolean's description to remove the hardcoded "2 seconds" wording.
- **Implementation**:
  ```jsonc
  // AFTER the existing clearBeforePrompt entry (line ~253), add:
  "switchboard.terminal.clearBeforePromptDelay": {
    "type": "number",
    "default": 1500,
    "minimum": 0,
    "maximum": 10000,
    "description": "Milliseconds to wait after sending /clear before dispatching the prompt. Only used when terminal.clearBeforePrompt is enabled. Non-paced (same-agent) dispatches use approximately 1/3 of this value."
  }
  ```
  Update existing boolean description (line 252) from:
  ```
  "When enabled, sends /clear to the terminal 2 seconds before dispatching prompts..."
  ```
  to:
  ```
  "When enabled, sends /clear to the terminal before dispatching prompts. The wait duration is configurable via terminal.clearBeforePromptDelay."
  ```
- **Edge Cases**: The `minimum`/`maximum` constraints are only enforced by the Settings UI. Runtime clamping in `TaskViewerProvider` handles manual `settings.json` edits.

### `src/services/TaskViewerProvider.ts` (lines 13794–13803)
- **Context**: `_attemptDirectTerminalPush` reads `terminal.clearBeforePrompt` at line 13794, then uses two hardcoded `setTimeout` calls at lines 13800 and 13803.
- **Logic**: Read the new `clearBeforePromptDelay` setting. Replace only the **second** `setTimeout` (line 13803 — the post-clear wait). The first `setTimeout` (line 13800 — submit delay) remains hardcoded because it is purely mechanical (time to paste and press Enter), not user-perceptible wait. Apply paced/non-paced scaling: paced uses the raw value, non-paced uses `Math.max(100, Math.round(clearDelay / 3))` to preserve the existing 3:1 ratio. Clamp the value at read time.
- **Implementation**:
  ```typescript
  // Line 13794 — add after the existing clearBeforePrompt read:
  const rawClearDelay = vscode.workspace.getConfiguration('switchboard').get<number>('terminal.clearBeforePromptDelay', 1500);
  const clearDelay = Math.min(Math.max(rawClearDelay, 0), 10000);

  // Line 13803 — replace:
  // OLD: await new Promise(r => setTimeout(r, paced ? 1500 : 500));
  // NEW:
  await new Promise(r => setTimeout(r, paced ? clearDelay : Math.max(100, Math.round(clearDelay / 3))));
  ```
- **Edge Cases**:
  - Default 1500 ms → paced: 1500 ms, non-paced: 500 ms (zero behavior change for existing users).
  - User sets 0 ms → both modes skip the post-clear wait entirely (clear may not finish on slow CLIs — user's choice).
  - User sets 10000 ms → paced: 10000 ms, non-paced: 3333 ms.

### `src/services/KanbanProvider.ts`
- **Context**: Constructor reads `terminal.clearBeforePrompt` at line 249 into `_clearTerminalBeforePrompt`. Broadcasts state at lines 956–959 and 1698–1701. Handles toggle at lines 3989–4004.
- **Logic**: Add a private field `_clearTerminalBeforePromptDelay: number`, read it in the constructor, broadcast it alongside the existing boolean state, and handle webview updates.
- **Implementation**:
  - **Line 128** — Add private field:
    ```typescript
    private _clearTerminalBeforePromptDelay: number;
    ```
  - **Line 249** — Read config in constructor (after existing read):
    ```typescript
    this._clearTerminalBeforePromptDelay = Math.min(Math.max(
      vscode.workspace.getConfiguration('switchboard').get<number>('terminal.clearBeforePromptDelay', 1500),
      0
    ), 10000);
    ```
  - **Lines 956–959 and 1698–1701** — Add delay to existing broadcast messages:
    ```typescript
    // Append to the existing clearTerminalBeforePromptState message:
    this._panel.webview.postMessage({
      type: 'clearTerminalBeforePromptState',
      enabled: this._clearTerminalBeforePrompt,
      delay: this._clearTerminalBeforePromptDelay
    });
    ```
  - **Lines 3989–4004** — Add new case for delay updates (after the existing toggle handler):
    ```typescript
    case 'updateClearTerminalBeforePromptDelay':
      const clampedDelay = Math.min(Math.max(msg.delay ?? 1500, 0), 10000);
      this._clearTerminalBeforePromptDelay = clampedDelay;
      try {
        await vscode.workspace.getConfiguration('switchboard').update(
          'terminal.clearBeforePromptDelay',
          clampedDelay,
          true
        );
      } catch (err) {
        console.error('[KanbanProvider] Failed to persist clearTerminalBeforePromptDelay:', err);
      }
      this._panel?.webview.postMessage({
        type: 'clearTerminalBeforePromptDelayState',
        delay: clampedDelay
      });
      break;
    ```
- **Edge Cases**: The cached value may go stale if the user edits `settings.json` directly. This is consistent with the existing boolean toggle behavior and is an acceptable trade-off.

### `src/webview/kanban.html`
- **Context**: Terminal Context section at lines 1988–2001 has the toggle. State variable at line 2781. UI update function at lines 3067–3076. Message handler at lines 4609–4612. Event listener at lines 4925–4930.
- **Logic**: Add a number input that appears when the toggle is enabled. Wire it to send `updateClearTerminalBeforePromptDelay` messages on `change` event (fires on blur/Enter, avoiding rapid updates). Handle `clearTerminalBeforePromptDelayState` messages to sync the input value.
- **Implementation**:
  - **Lines 1997–2000** — Replace static hint text with dynamic delay input (inside the existing toggle label div, after the toggle-label span):
    ```html
    <span class="toggle-label">Clear before prompt</span>
    </label>
    <div class="hint-text" id="clear-delay-container" style="display:none; margin-top:4px; align-items:center; gap:6px;">
      <label style="font-size:11px;">Delay:</label>
      <input type="number" id="clear-terminal-delay-input" min="0" max="10000" step="100" value="1500"
             style="width:70px; font-size:11px; padding:2px 4px; border:1px solid #555; border-radius:3px; background:var(--vscode-input-background); color:var(--vscode-input-foreground);">
      <span style="font-size:10px; opacity:0.7;">ms (0–10000)</span>
    </div>
    ```
  - **Line 2781** — Add state variable:
    ```javascript
    let clearTerminalBeforePromptDelay = 1500;
    ```
  - **Lines 3067–3076** — Update `updateClearTerminalBeforePromptUi()` to show/hide the delay container:
    ```javascript
    function updateClearTerminalBeforePromptUi() {
      const toggle = document.getElementById('clear-terminal-before-prompt-toggle');
      const toggleLabel = document.getElementById('clear-terminal-before-prompt-label');
      const delayContainer = document.getElementById('clear-delay-container');
      const delayInput = document.getElementById('clear-terminal-delay-input');
      if (toggle) {
        toggle.checked = !!clearTerminalBeforePrompt;
      }
      if (toggleLabel) {
        toggleLabel.classList.toggle('is-off', !clearTerminalBeforePrompt);
      }
      if (delayContainer) {
        delayContainer.style.display = clearTerminalBeforePrompt ? 'flex' : 'none';
      }
      if (delayInput) {
        delayInput.value = String(clearTerminalBeforePromptDelay);
      }
    }
    ```
  - **Lines 4609–4612** — Update message handler to also capture delay from the combined state message:
    ```javascript
    case 'clearTerminalBeforePromptState':
      clearTerminalBeforePrompt = msg.enabled !== false;
      if (msg.delay !== undefined) {
        clearTerminalBeforePromptDelay = msg.delay;
      }
      updateClearTerminalBeforePromptUi();
      break;
    case 'clearTerminalBeforePromptDelayState':
      if (msg.delay !== undefined) {
        clearTerminalBeforePromptDelay = msg.delay;
        const delayInput = document.getElementById('clear-terminal-delay-input');
        if (delayInput) delayInput.value = String(msg.delay);
      }
      break;
    ```
  - **After line 4930** — Add event listener for the delay input (use `change` event, not `input`, to avoid rapid updates):
    ```javascript
    document.getElementById('clear-terminal-delay-input')?.addEventListener('change', (event) => {
      const value = parseInt(event.target?.value, 10);
      if (!isNaN(value)) {
        const clamped = Math.min(Math.max(value, 0), 10000);
        clearTerminalBeforePromptDelay = clamped;
        event.target.value = String(clamped);
        postKanbanMessage({ type: 'updateClearTerminalBeforePromptDelay', delay: clamped });
      }
    });
    ```
  - **Line 1991** — Update tooltip on the toggle label:
    ```html
    data-tooltip="Send /clear to CLI agents before dispatching prompts (delay is configurable)"
    ```
- **Edge Cases**: The `change` event fires on blur/Enter, not on each keystroke. Client-side clamping ensures the value is always within bounds before posting to the provider.

### `src/webview/setup.html` (deferred)
- **Context**: There is currently **no Terminal Context UI** in setup.html. Adding one requires creating a new tab or section from scratch.
- **Logic**: Defer to a follow-up plan. The kanban webview is the primary interface for this setting. Adding a Terminal Context section to setup.html is a separate feature that should be planned independently.
- **Implementation**: N/A — deferred.
- **Edge Cases**: N/A.

## Verification Plan
### Automated Tests
- No automated tests exist for this feature area. Manual verification steps:
  - [ ] Toggle on/off still works; delay input is hidden when toggle is off, visible when on.
  - [ ] Setting value persists across VS Code restarts.
  - [ ] Setting value clamped between 0 and 10000 ms in UI and at runtime.
  - [ ] Prompt dispatch respects the custom delay (verified by adding a temporary `console.log` around the `setTimeout` in `TaskViewerProvider.ts`).
  - [ ] Default delay of 1500 ms preserves existing behaviour for existing users (paced: 1500 ms, non-paced: 500 ms).
  - [ ] Non-paced dispatches scale delay to ~1/3 of the configured value.
  - [ ] Changing the delay in the kanban UI immediately updates the in-memory value in KanbanProvider.

## Risks
- **Breaking existing users**: Mitigated by keeping the boolean toggle intact and defaulting the delay to 1500 ms (same total wait as today for paced dispatches; non-paced stays at ~500 ms via scaling).
- **UI clutter**: Mitigated by only showing the delay input when the toggle is enabled.
- **Extremely low delays (< 200 ms)**: Could cause prompt concatenation on slow CLIs. This is user-configurable risk; the UI hint should warn that very low values may not work on slow terminals.

---

## Review Results (2026-05-16)

### Stage 1 — Grumpy Principal Engineer Findings

| # | File | Finding | Severity |
|---|------|---------|----------|
| 1 | `package.json` | New setting correctly typed, bounded, described. Boolean description updated. | — (no issue) |
| 2 | `TaskViewerProvider.ts` | Config read with runtime clamping present. Paced/non-paced scaling with `Math.max(100, Math.round(clearDelay / 3))` correct. First setTimeout left hardcoded. Default 1500 ms produces zero regression. | — (no issue) |
| 3 | `KanbanProvider.ts` | Private field, constructor clamping, all three broadcast sites include delay, `updateClearTerminalBeforePromptDelay` case with clamping + persistence + echo. `msg.delay ?? 1500` correctly uses nullish coalescing (0 is treated as 0, not missing). | — (no issue) |
| 4 | `kanban.html` | `clear-delay-container` used `class="hint-text"` which dragged in `font-family: var(--font-mono)` and `letter-spacing: 0.5px` from the stylesheet — unintended monospace rendering on the delay input and label. | NIT |
| 5 | `kanban.html` | Display toggling via `style.display = 'flex'/'none'` works correctly with inline style properties preserved. | — (no issue) |
| 6 | `kanban.html` | `change` event (not `input`) on delay input. Client-side clamping. State variable, UI update function, message handlers all wired correctly. | — (no issue) |

**No CRITICAL or MAJOR findings.**

### Stage 2 — Balanced Synthesis

| Finding | Verdict | Action Taken |
|---------|---------|--------------|
| `hint-text` CSS class contamination on delay container | Fix now — trivial | Removed `class="hint-text"`, preserved needed styles inline (`font-size:10px; color:var(--text-secondary)`) |
| All other implementation | Keep | No changes needed |

### Stage 3 — Code Fixes Applied

- **`src/webview/kanban.html` line 1998**: Removed `class="hint-text"` from `clear-delay-container` div. Added `font-size:10px; color:var(--text-secondary)` inline to preserve the intended hint-text color/size without inheriting monospace font and letter-spacing. This ensures the delay input renders in the default VS Code input font rather than monospace.

### Stage 4 — Verification

- **TypeScript check (`tsc --noEmit`)**: 2 pre-existing errors in unrelated files (`ClickUpSyncService.ts`, `KanbanProvider.ts` — relative import path issues). Zero errors related to the clear-delay feature.
- **Webpack build (`npm run compile`)**: Compiled successfully. No warnings related to the feature.
- **Manual verification items** (from Verification Plan): Not yet checked — requires VS Code runtime with the extension active.

### Files Changed by Review

| File | Change |
|------|--------|
| `src/webview/kanban.html` | Removed `class="hint-text"` from `clear-delay-container`, added inline `font-size` and `color` styles |

### Remaining Risks

- **Stale cached value in KanbanProvider**: If user edits `settings.json` directly (bypassing the UI), the KanbanProvider's `_clearTerminalBeforePromptDelay` field goes stale until the next webview refresh. This is consistent with the existing boolean toggle behavior and is an acceptable trade-off.
- **No automated tests**: The Verification Plan items are all manual. No test infrastructure exists for this feature area.
- **setup.html deferred**: No Terminal Context UI in setup.html yet. Follow-up plan needed if parity is desired.
