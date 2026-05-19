# Add Clear Antigravity Context Checkbox

## Goal
Add a new checkbox option to the Kanban Setup tab called "Clear Antigravity Context" that, when enabled, adds a line into the prompt builder instructing the agent to ignore any previous checkpoint summary.

## Metadata
- **Tags:** UI, workflow
- **Complexity:** 3

## User Review Required
No

## Complexity Audit
### Routine
- Following the established pattern for the "Clear before prompt" toggle (HTML checkbox, JS variable, JS event listener, JS message handler, JS UI update function, KanbanProvider field, KanbanProvider constructor init, KanbanProvider message handler, KanbanProvider state sync, VSCode setting persistence, prompt builder option).
- Adding an optional boolean field to `PromptBuilderOptions` interface (line 107).
- Adding the option extraction with `?? false` default in `buildKanbanBatchPrompt` (after line 250).
- Adding a VSCode configuration property to `package.json` following the existing pattern.

### Complex / Risky
- None

## Edge-Case & Dependency Audit
- **Race Conditions**: None.
- **Security**: None.
- **Side Effects**: The checkbox state will be persisted to VSCode settings, so it will persist across sessions. This is intentional and follows the existing pattern.
- **Dependencies & Conflicts**: The new option must be added to the `PromptBuilderOptions` interface and all 10 `buildKanbanBatchPrompt` call sites must pass the option. The option is optional in the interface (defaults to `false` via `?? false`), so existing call sites that omit it will continue to work correctly. The `sharedDefaults.js` file does NOT need modification — this is a global toggle, not a per-role addon.

## Dependencies
None

## Adversarial Synthesis
Key risks: Missing any of the 10 `buildKanbanBatchPrompt` call sites would cause the option to be silently ignored for that dispatch path. The antigravity instruction text must be precise — it should instruct agents to ignore checkpoint summaries only, not all workspace context. Mitigations: Enumerate all call sites with exact line numbers. Use `?? false` default so omitted call sites default to disabled (safe). Refine instruction text to target checkpoint summaries specifically.

## Proposed Changes

### `src/webview/kanban.html` — HTML Checkbox
- **Context**: The "Clear before prompt" checkbox lives in the Setup tab's "Terminal Context" subsection (lines 1945-1964). A new `db-subsection` should be inserted between the "Terminal Context" subsection (ending at line 1964) and the "Kanban Structure" subsection (starting at line 1965).
- **Implementation**:
  - After line 1964 (closing `</div>` of the Terminal Context subsection), insert a new subsection:
    ```html
    <div class="db-subsection">
        <div class="subsection-header"><span>Antigravity Context</span></div>
        <div class="setup-section">
            <div class="setup-field">
                <label class="cli-toggle-inline" id="clear-antigravity-context-label" data-tooltip="Instruct agents to ignore previous checkpoint summaries when enabled">
                    <label class="toggle-switch">
                        <input type="checkbox" id="clear-antigravity-context-toggle">
                        <span class="toggle-slider"></span>
                    </label>
                    <span class="toggle-label">Clear Antigravity Context</span>
                </label>
            </div>
        </div>
    </div>
    ```

### `src/webview/kanban.html` — JS Variable Declaration
- **Context**: JS variables for toggle states are declared around line 2767-2768.
- **Implementation**:
  - After line 2768 (`let clearTerminalBeforePromptDelay = 1500;`), add:
    ```javascript
    let clearAntigravityContext = false;
    ```

### `src/webview/kanban.html` — JS Event Listener
- **Context**: Event listeners for toggles are registered around lines 5046-5060.
- **Implementation**:
  - After the `clear-terminal-delay-input` event listener block (after line 5060), add:
    ```javascript
    document.getElementById('clear-antigravity-context-toggle')?.addEventListener('change', (event) => {
        const checked = !!event.target?.checked;
        clearAntigravityContext = checked;
        updateClearAntigravityContextUi();
        postKanbanMessage({ type: 'toggleClearAntigravityContext', enabled: checked });
    });
    ```

### `src/webview/kanban.html` — JS UI Update Function
- **Context**: UI update functions for toggles are defined around lines 3081-3098.
- **Implementation**:
  - After the `updateClearTerminalBeforePromptUi()` function (after line 3098), add:
    ```javascript
    function updateClearAntigravityContextUi() {
        const toggle = document.getElementById('clear-antigravity-context-toggle');
        const toggleLabel = document.getElementById('clear-antigravity-context-label');
        if (toggle) {
            toggle.checked = !!clearAntigravityContext;
        }
        if (toggleLabel) {
            toggleLabel.classList.toggle('is-off', !clearAntigravityContext);
        }
    }
    ```

### `src/webview/kanban.html` — JS Message Handler for State Restoration
- **Context**: The JS message handler switch restores toggle states from the backend. The `clearTerminalBeforePromptState` case is at lines 4654-4660.
- **Implementation**:
  - After the `clearTerminalBeforePromptDelayState` case (after line 4667), add:
    ```javascript
    case 'clearAntigravityContextState':
        clearAntigravityContext = msg.enabled !== false;
        updateClearAntigravityContextUi();
        break;
    ```

### `src/services/KanbanProvider.ts` — Field & Constructor
- **Context**: The `_clearTerminalBeforePrompt` field is declared at line 134 and initialized at line 256.
- **Implementation**:
  - After line 135 (`private _clearTerminalBeforePromptDelay: number;`), add:
    ```typescript
    private _clearAntigravityContext: boolean;
    ```
  - After line 260 (the `_clearTerminalBeforePromptDelay` initialization), add:
    ```typescript
    this._clearAntigravityContext = vscode.workspace.getConfiguration('switchboard').get<boolean>('prompt.clearAntigravityContext', false);
    ```

### `src/services/KanbanProvider.ts` — Message Handler
- **Context**: The `toggleClearTerminalBeforePrompt` case is at lines 4120-4136.
- **Implementation**:
  - After the `toggleClearTerminalBeforePrompt` case block (after line 4136), add:
    ```typescript
    case 'toggleClearAntigravityContext':
        this._clearAntigravityContext = !!msg.enabled;
        try {
            await vscode.workspace.getConfiguration('switchboard').update(
                'prompt.clearAntigravityContext',
                this._clearAntigravityContext,
                true
            );
        } catch (err) {
            console.error('[KanbanProvider] Failed to persist clearAntigravityContext:', err);
        }
        this._panel?.webview.postMessage({
            type: 'clearAntigravityContextState',
            enabled: this._clearAntigravityContext
        });
        break;
    ```

### `src/services/KanbanProvider.ts` — State Synchronization
- **Context**: Initial state is sent in `refreshWithData` at line 1039, and board refresh state is sent in `_refreshBoardImpl` at line 1769.
- **Implementation**:
  - After the `clearTerminalBeforePromptState` postMessage in `refreshWithData` (after line 1042), add:
    ```typescript
    this._panel.webview.postMessage({
        type: 'clearAntigravityContextState',
        enabled: this._clearAntigravityContext
    });
    ```
  - After the `clearTerminalBeforePromptState` postMessage in `_refreshBoardImpl` (after line 1772), add:
    ```typescript
    this._panel.webview.postMessage({
        type: 'clearAntigravityContextState',
        enabled: this._clearAntigravityContext
    });
    ```

### `src/services/KanbanProvider.ts` — All 10 `buildKanbanBatchPrompt` Call Sites
- **Context**: The `clearAntigravityContext` option must be passed to every call site. All 10 locations:
  1. **Line 2065** — Role Preview (Generic): Add `clearAntigravityContext: this._clearAntigravityContext` to the options object.
  2. **Line 2244** — Planner Prompt: Add `clearAntigravityContext: this._clearAntigravityContext` to the options object.
  3. **Line 2294** — Generic Role Prompt (with instruction): Add `clearAntigravityContext: this._clearAntigravityContext` to the options object.
  4. **Line 2330** — Coder Prompt: Add `clearAntigravityContext: this._clearAntigravityContext` to the options object.
  5. **Line 2524** — Reviewer Prompt: Add `clearAntigravityContext: this._clearAntigravityContext` to the options object.
  6. **Line 2553** — Research/Analyst/Splitter/Ticket Updater/Research Planner Roles: Add `clearAntigravityContext: this._clearAntigravityContext` to the options object.
  7. **Line 5102** — Lead Prompt (Autoban Dispatch): Add `clearAntigravityContext: this._clearAntigravityContext` to the options object.
  8. **Line 5112** — Coder Prompt (Autoban Dispatch): Add `clearAntigravityContext: this._clearAntigravityContext` to the options object.
  9. **Line 5438** — Prompt Preview (Generic with conditional options): Add `clearAntigravityContext: this._clearAntigravityContext` to the options object.
  10. **Line 6150** — Tester Prompt: Add `clearAntigravityContext: this._clearAntigravityContext` to the options object.

### `src/services/agentPromptBuilder.ts` — Interface & Option Extraction
- **Context**: The `PromptBuilderOptions` interface is at lines 66-107. Option extraction is at lines 240-250.
- **Implementation**:
  - Before the closing `}` of the interface (line 107), add:
    ```typescript
    /** When true, instructs agents to ignore previous checkpoint summaries. */
    clearAntigravityContext?: boolean;
    ```
  - After line 250 (`const sourceColumnLabel = options?.sourceColumnLabel;`), add:
    ```typescript
    const clearAntigravityContext = options?.clearAntigravityContext ?? false;
    ```

### `src/services/agentPromptBuilder.ts` — Antigravity Block Construction & Injection
- **Context**: The function builds blocks like `challengeBlock` (line 261) and injects them before `PLANS TO PROCESS:` in each role branch. The same pattern should be used for the antigravity block.
- **Implementation**:
  - After the `challengeBlock` construction (line 261), add:
    ```typescript
    const antigravityBlock = clearAntigravityContext
        ? `\n\nIgnore any previous checkpoint summaries or context carried over from prior agent sessions. Do NOT ignore workspace-level context such as AGENTS.md, existing code conventions, or project configuration.\n`
        : '';
    ```
  - Inject `antigravityBlock` before `PLANS TO PROCESS:` in every role branch. The insertion point in each branch is immediately before the line containing `\n\nPLANS TO PROCESS:\n${planList}`. Specifically:
    - **Planner** (line 342): Change `plannerPrompt += `\n\nPLANS TO PROCESS:\n${planList}`;` to `plannerPrompt += `${antigravityBlock}\n\nPLANS TO PROCESS:\n${planList}`;`
    - **Reviewer** (line 382-383): Change `PLANS TO PROCESS:\n${planList}`;` to `${antigravityBlock}\n\nPLANS TO PROCESS:\n${planList}`;`
    - **Tester** (line 419-420): Change `PLANS TO PROCESS:\n${planList}`;` to `${antigravityBlock}\n\nPLANS TO PROCESS:\n${planList}`;`
    - **Lead** (line 457-458): Change `PLANS TO PROCESS:\n${planList}`;` to `${antigravityBlock}\n\nPLANS TO PROCESS:\n${planList}`;`
    - **Coder** (line 490-491): Change `PLANS TO PROCESS:\n${planList}`, accurateCodingEnabled);` to `${antigravityBlock}\n\nPLANS TO PROCESS:\n${planList}`, accurateCodingEnabled);`
    - **Intern** (line 506-507): Change `PLANS TO PROCESS:\n${planList}`;` to `${antigravityBlock}\n\nPLANS TO PROCESS:\n${planList}`;`
    - **Analyst** (line 519-520): Change `PLANS TO PROCESS:\n${planList}`;` to `${antigravityBlock}\n\nPLANS TO PROCESS:\n${planList}`;`
    - **Ticket Updater** (line 557-558): Change `PLANS TO PROCESS:\n${planList}`;` to `${antigravityBlock}\n\nPLANS TO PROCESS:\n${planList}`;`
    - **Researcher, Splitter, Research Planner, and Generic Fallback branches**: Apply the same pattern — insert `${antigravityBlock}` before `PLANS TO PROCESS:`.

### `package.json` — VSCode Configuration Property
- **Context**: The `switchboard.terminal.clearBeforePrompt` property is at lines 249-252. The new property should be placed nearby, after the `switchboard.terminal.clearBeforePromptDelay` property (after line 259).
- **Implementation**:
  - After line 259 (closing `}` of `clearBeforePromptDelay`), add:
    ```json
    "switchboard.prompt.clearAntigravityContext": {
      "type": "boolean",
      "default": false,
      "description": "When enabled, instructs agents to ignore previous checkpoint summaries from prior sessions."
    },
    ```

## Verification Plan

### Automated Tests
- Add a test case to `agentPromptBuilder.test.ts` (after line 151) to verify that when `clearAntigravityContext: true` is passed, the prompt includes the antigravity context instruction.
- Add a test case to verify that when `clearAntigravityContext` is false or undefined, the instruction is not included.
- Add a test case to verify the instruction text includes "checkpoint summaries" but does NOT include overly broad language like "no historical context".

### Manual Testing
- Open the Kanban board and navigate to the Setup tab.
- Verify the new "Clear Antigravity Context" checkbox appears in the "Antigravity Context" subsection, between "Terminal Context" and "Kanban Structure".
- Check the checkbox and verify the state persists after closing and reopening the panel.
- Copy a prompt with the checkbox enabled and verify the instruction "Ignore any previous checkpoint summaries..." appears in the generated prompt.
- Copy a prompt with the checkbox unchecked and verify the instruction does NOT appear.
- Verify the checkbox works for all role types (planner, lead, coder, reviewer, tester, intern).

**Recommendation:** Send to Coder

---
## Code Review & Validation (Completed)

### Stage 1 (Grumpy)
- **[CRITICAL] Verification Ignored:** The "Verification Plan" demanded three distinct automated test cases in `agentPromptBuilder.test.ts`. None were implemented! Do we just write test plans for fun?
- **[CRITICAL] Collateral Damage:** The implementation of another feature swapped `defaultBase` and `personaContent` priority in `agentPromptBuilder.ts`'s `resolveBaseInstructions`, breaking four existing test cases!
- **[NIT] Text Specificity:** We should always ensure the exact requested label in `package.json` was maintained.

### Stage 2 (Balanced)
- **What to Keep:** The Kanban UI injection, toggle persistence, and IPC bindings were implemented flawlessly. Passing the option all the way down to `buildKanbanBatchPrompt` was done with impressive completeness across all 10 call sites.
- **What to Fix:** 
  1. Add the missing test cases to `agentPromptBuilder.test.ts`.
  2. Revert the erroneous base instruction override logic in `agentPromptBuilder.ts` so `personaContent` continues to properly override `defaultBase` to fix the broken test cases.
- **What to Defer:** The package.json configuration text matches expectations, no further modifications needed.

### Validation Results
- Added three test cases validating `clearAntigravityContext: true`, `false`, and `undefined` in `agentPromptBuilder.test.ts`.
- Reverted `resolveBaseInstructions` regression in `agentPromptBuilder.ts`.
- `npm run compile-tests && npx mocha out/services/__tests__/agentPromptBuilder.test.js --ui tdd` passes all 30 tests cleanly.

### Files Changed
- `src/services/__tests__/agentPromptBuilder.test.ts`
- `src/services/agentPromptBuilder.ts`

### Remaining Risks
- None.
