# Move Clear Antigravity Context to Prompts Tab as Per-Role Addon

## Goal
Move the "Clear Antigravity Context" feature from a global Setup tab toggle to a per-role addon in the Prompts tab for all roles. This allows each role to be independently configured to ignore previous checkpoint summaries.

## Metadata
- **Tags:** UI, workflow, refactor
- **Complexity:** 4

## User Review Required
No

## Complexity Audit
### Routine
- Following the established pattern for role addons in `sharedDefaults.js` (add `{ id, label, tooltip, default }` to each role's addon array).
- Adding the addon to `DEFAULT_ROLE_CONFIG` for all 11 roles with default `false`.
- Removing the Setup tab HTML checkbox and all related JavaScript (variable, event listener, UI update function, message handler).
- Removing the KanbanProvider field `_clearAntigravityContext` and all related persistence logic.
- Removing the VSCode configuration property from `package.json`.
- Adding `clearAntigravityContextByRole` to `_getPromptsConfig` return value (following the exact pattern of `gitProhibitionByRole` and `switchboardSafeguardsByRole`).
- Updating all 10 `buildKanbanBatchPrompt` call sites to read from `promptsConfig.clearAntigravityContextByRole` instead of `this._clearAntigravityContext`.

### Complex / Risky
- The `clearAntigravityContext` option is currently passed to all 10 `buildKanbanBatchPrompt` call sites from a global KanbanProvider field. After this change, each call site must read from the role-specific config via `promptsConfig`. Missing any call site would cause the option to be silently ignored for that dispatch path.

## Edge-Case & Dependency Audit
- **Race Conditions**: None.
- **Security**: None.
- **Side Effects**: The old global VSCode setting `switchboard.prompt.clearAntigravityContext` will be removed from `package.json`. Any existing user preferences stored in that setting will become an orphaned key in their `settings.json` — VS Code will silently ignore it but won't clean it up. This is acceptable since the feature was incorrectly implemented as a global toggle; users will reconfigure per-role.
- **Dependencies & Conflicts**: The new addon must be added to all 11 roles in `ROLE_ADDONS` and `DEFAULT_ROLE_CONFIG`. The backend must read from `promptsConfig.clearAntigravityContextByRole?.[role]` instead of `this._clearAntigravityContext`.

## Dependencies
None

## Adversarial Synthesis
Key risks: Missing any of the 10 `buildKanbanBatchPrompt` call sites would cause the option to be silently ignored for that dispatch path. The per-role config read must use the existing `_getPromptsConfig` pattern (not ad-hoc `this._getSetting` calls) for architectural consistency. The VSCode setting removal will orphan existing user preferences (acceptable, no migration needed). Mitigations: Enumerate all call sites with verified line numbers. Use `promptsConfig.clearAntigravityContextByRole?.[role] ?? false` pattern consistently — `promptsConfig` is already in scope at all 10 sites.

## Proposed Changes

### `src/webview/sharedDefaults.js` — Add Addon to All 11 Roles in ROLE_ADDONS
- **Context**: The `ROLE_ADDONS` object defines per-role addons (lines 59-117). Each role has an array of addon objects with `id`, `label`, `tooltip`, and `default` properties. There are 11 roles with addon arrays: planner, lead, coder, reviewer, tester, intern, analyst, ticket_updater, researcher, splitter, research_planner. (Gatherer and jules are in `BUILT_IN_AGENT_LABELS` but do NOT have addon arrays or `DEFAULT_ROLE_CONFIG` entries.)
- **Implementation**: Add `{ id: 'clearAntigravityContext', label: 'Clear Antigravity Context', tooltip: 'Instruct agent to ignore previous checkpoint summaries from prior sessions', default: false }` to ALL 11 role arrays:
  - **planner** (line 67): Add after the `splitPlan` addon
  - **lead** (line 74): Add after the `gitProhibition` addon
  - **coder** (line 80): Add after the `gitProhibition` addon
  - **reviewer** (line 85): Add after the `gitProhibition` addon
  - **tester** (line 89): Add after the `gitProhibition` addon
  - **intern** (line 93): Add after the `gitProhibition` addon
  - **analyst** (line 97): Add after the `gitProhibition` addon
  - **ticket_updater** (line 102): Add after the `ticketUpdateEnabled` addon
  - **researcher** (line 107): Add after the `researchEnabled` addon
  - **splitter** (line 112): Add after the `complexityScoringSkill` addon
  - **research_planner** (line 116): Add after the `gitProhibition` addon

### `src/webview/sharedDefaults.js` — Add Default to All 11 Roles in DEFAULT_ROLE_CONFIG
- **Context**: The `DEFAULT_ROLE_CONFIG` object defines default addon states for each role (lines 17-32). There are 11 roles with entries.
- **Implementation**: Add `clearAntigravityContext: false` to the `addons` object for ALL 11 roles:
  - **planner** (line 20): Add `clearAntigravityContext: false` to the addons object
  - **lead** (line 22): Add `clearAntigravityContext: false` to the addons object
  - **coder** (line 23): Add `clearAntigravityContext: false` to the addons object
  - **reviewer** (line 24): Add `clearAntigravityContext: false` to the addons object
  - **tester** (line 25): Add `clearAntigravityContext: false` to the addons object
  - **intern** (line 26): Add `clearAntigravityContext: false` to the addons object
  - **analyst** (line 27): Add `clearAntigravityContext: false` to the addons object
  - **ticket_updater** (line 28): Add `clearAntigravityContext: false` to the addons object
  - **researcher** (line 29): Add `clearAntigravityContext: false` to the addons object
  - **splitter** (line 30): Add `clearAntigravityContext: false` to the addons object
  - **research_planner** (line 31): Add `clearAntigravityContext: false` to the addons object

### `src/webview/kanban.html` — Remove Setup Tab HTML Checkbox
- **Context**: The "Clear Antigravity Context" checkbox lives in the Setup tab's "Antigravity Context" subsection (lines 1993-2006).
- **Implementation**: Remove the entire subsection:
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

### `src/webview/kanban.html` — Remove JS Variable Declaration
- **Context**: JS variable for toggle state is declared at line 2811.
- **Implementation**: Remove the line:
  ```javascript
  let clearAntigravityContext = false;
  ```

### `src/webview/kanban.html` — Remove JS Event Listener
- **Context**: Event listener for toggle is registered at lines 5107-5111.
- **Implementation**: Remove the entire event listener block:
  ```javascript
  document.getElementById('clear-antigravity-context-toggle')?.addEventListener('change', (event) => {
      const checked = !!event.target?.checked;
      clearAntigravityContext = checked;
      updateClearAntigravityContextUi();
      postKanbanMessage({ type: 'toggleClearAntigravityContext', enabled: checked });
  });
  ```

### `src/webview/kanban.html` — Remove JS UI Update Function
- **Context**: UI update function for toggle is defined at lines 3143-3152.
- **Implementation**: Remove the entire function:
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

### `src/webview/kanban.html` — Remove JS Message Handler for State Restoration
- **Context**: The JS message handler switch restores toggle states from the backend. The `clearAntigravityContextState` case is at lines 4710-4713.
- **Implementation**: Remove the case block:
  ```javascript
  case 'clearAntigravityContextState':
      clearAntigravityContext = msg.enabled !== false;
      updateClearAntigravityContextUi();
      break;
  ```

### `src/services/KanbanProvider.ts` — Remove Field & Constructor
- **Context**: The `_clearAntigravityContext` field is declared at line 132 and initialized at line 258.
- **Implementation**: 
  - Remove line 132: `private _clearAntigravityContext: boolean;`
  - Remove line 258: 
    ```typescript
    this._clearAntigravityContext = vscode.workspace.getConfiguration('switchboard').get<boolean>('prompt.clearAntigravityContext', false);
    ```

### `src/services/KanbanProvider.ts` — Remove Message Handler
- **Context**: The `toggleClearAntigravityContext` case is at lines 4166-4181.
- **Implementation**: Remove the entire case block:
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

### `src/services/KanbanProvider.ts` — Remove State Synchronization
- **Context**: Initial state is sent in `refreshWithData` at lines 1067-1070, and board refresh state is sent in `_refreshBoardImpl` at lines 1783-1786.
- **Implementation**: 
  - Remove the `clearAntigravityContextState` postMessage in `refreshWithData` (lines 1067-1070):
    ```typescript
    this._panel.webview.postMessage({
        type: 'clearAntigravityContextState',
        enabled: this._clearAntigravityContext
    });
    ```
  - Remove the `clearAntigravityContextState` postMessage in `_refreshBoardImpl` (lines 1783-1786):
    ```typescript
    this._panel.webview.postMessage({
        type: 'clearAntigravityContextState',
        enabled: this._clearAntigravityContext
    });
    ```

### `src/services/KanbanProvider.ts` — Add `clearAntigravityContextByRole` to `_getPromptsConfig`
- **Context**: The `_getPromptsConfig` method (lines 2137-2195) already loads all 11 role configs and returns per-role maps like `gitProhibitionByRole` (lines 2168-2180) and `switchboardSafeguardsByRole` (lines 2181-2193). This is the canonical pattern for per-role addon resolution.
- **Implementation**: Add a `clearAntigravityContextByRole` map to the return object, following the exact pattern of `gitProhibitionByRole`:
  ```typescript
  clearAntigravityContextByRole: {
      planner: plannerConfig?.addons?.clearAntigravityContext ?? false,
      lead: leadConfig?.addons?.clearAntigravityContext ?? false,
      coder: coderConfig?.addons?.clearAntigravityContext ?? false,
      reviewer: reviewerConfig?.addons?.clearAntigravityContext ?? false,
      tester: testerConfig?.addons?.clearAntigravityContext ?? false,
      intern: internConfig?.addons?.clearAntigravityContext ?? false,
      analyst: analystConfig?.addons?.clearAntigravityContext ?? false,
      researcher: researcherConfig?.addons?.clearAntigravityContext ?? false,
      splitter: splitterConfig?.addons?.clearAntigravityContext ?? false,
      ticket_updater: ticketUpdaterConfig?.addons?.clearAntigravityContext ?? false,
      research_planner: researchPlannerConfig?.addons?.clearAntigravityContext ?? false,
  },
  ```

### `src/services/KanbanProvider.ts` — Update All 10 `buildKanbanBatchPrompt` Call Sites
- **Context**: All call sites currently pass `clearAntigravityContext: this._clearAntigravityContext`. After this change, they must read from `promptsConfig.clearAntigravityContextByRole`. All 10 call sites already have `promptsConfig` in scope (verified by code inspection). The role variable is also available at each site (either as a loop variable, a function parameter, or a hardcoded string).
- **Implementation**: Replace `clearAntigravityContext: this._clearAntigravityContext` with `clearAntigravityContext: promptsConfig.clearAntigravityContextByRole?.[role] ?? false` at all 10 locations:
  1. **Line 2081** — Role Preview (Generic): `role` is a loop variable from `for (const role of roles)`. `promptsConfig` is already available (line 2077).
  2. **Line 2260** — Planner Prompt: Role is hardcoded `'planner'`. Use `promptsConfig.clearAntigravityContextByRole?.planner ?? false`. `promptsConfig` is already available (line 2248).
  3. **Line 2311** — Generic Role Prompt (with instruction): `role` is a function parameter. `promptsConfig` is already available (line 2302).
  4. **Line 2348** — Coder Prompt: Role is hardcoded `'coder'`. Use `promptsConfig.clearAntigravityContextByRole?.coder ?? false`. `promptsConfig` is already available (line 2342).
  5. **Line 2543** — Reviewer Prompt: Role is hardcoded `'reviewer'`. Use `promptsConfig.clearAntigravityContextByRole?.reviewer ?? false`. `promptsConfig` is already available (line 2539).
  6. **Line 2573** — Research/Analyst/Splitter/Ticket Updater/Research Planner Roles: `role` is a function parameter. `promptsConfig` is already available (line 2570).
  7. **Line 5148** — Lead Prompt (Autoban Dispatch): Role is hardcoded `'lead'`. Use `promptsConfig.clearAntigravityContextByRole?.lead ?? false`. `promptsConfig` is already available (line 5136).
  8. **Line 5159** — Coder Prompt (Autoban Dispatch): Role is hardcoded `'coder'`. Use `promptsConfig.clearAntigravityContextByRole?.coder ?? false`. `promptsConfig` is already available (line 5136).
  9. **Line 5487** — Prompt Preview (Generic with conditional options): `role` is from `msg`. `promptsConfig` is already available (line 5482).
  10. **Line 5869** — Tester Prompt: Role is hardcoded `'tester'`. Use `promptsConfig.clearAntigravityContextByRole?.tester ?? false`. `promptsConfig` is already available (line 5865).

### `src/services/agentPromptBuilder.ts` — No Changes Needed
- **Context**: The `PromptBuilderOptions` interface (line 108) and option extraction (line 253) use the name `clearAntigravityContext`. This name remains correct — the option name and behavior in the prompt builder are unchanged; only the *source* of the value changes (from a global KanbanProvider field to per-role config via `promptsConfig`).

### `package.json` — Remove VSCode Configuration Property
- **Context**: The `switchboard.prompt.clearAntigravityContext` property is at lines 261-265.
- **Implementation**: Remove the entire property:
  ```json
  "switchboard.prompt.clearAntigravityContext": {
    "type": "boolean",
    "default": false,
    "description": "When enabled, instructs agents to ignore previous checkpoint summaries from prior sessions."
  },
  ```
- **Side Effect**: Users who previously set this property in their `settings.json` will have an orphaned key. VS Code silently ignores unknown properties, so no error occurs, but the key will remain in their settings file until manually removed. No migration code is needed.

## Verification Plan

### Automated Tests
- The existing test cases for `clearAntigravityContext` in `agentPromptBuilder.test.ts` (lines 67-84) should continue to pass since the option name and behavior in `buildKanbanBatchPrompt` remain the same.
- The existing test cases in `minimal-prompt.test.js` (lines 138, 150) should also continue to pass for the same reason — they call `buildKanbanBatchPrompt` directly with the option.
- No new tests needed. The change is a data-source refactor, not a behavioral change.

### Manual Testing
- Open the Kanban board and navigate to the Setup tab.
- Verify the "Antigravity Context" subsection NO LONGER appears in the Setup tab.
- Navigate to the Prompts tab.
- For each of the 11 roles (planner, lead, coder, reviewer, tester, intern, analyst, ticket_updater, researcher, splitter, research_planner):
  - Select the role.
  - Verify the "Clear Antigravity Context" checkbox appears in the Add-ons section.
  - Check the checkbox and verify the state persists after closing and reopening the panel.
  - Copy a prompt with the checkbox enabled and verify the instruction "Ignore any previous checkpoint summaries..." appears in the generated prompt.
  - Copy a prompt with the checkbox unchecked and verify the instruction does NOT appear.

**Recommendation:** Send to Coder

---

## Reviewer Pass Results

### Review Date: 2026-05-21

### Stage 1: Grumpy Principal Engineer Findings

| # | Finding | Severity | Details |
|---|---------|----------|---------|
| F1 | Plan says "10 call sites" but actual count is 11 | NIT | The `_generateAntigravityPrompt` function (line 2397 in current code) was not enumerated in the plan's call site list. However, it WAS correctly updated to use `promptsConfig.clearAntigravityContextByRole?.[role] ?? false`. Documentation accuracy issue only — no code bug. |
| F2 | `_getPromptsConfig` return type not explicitly declared | NIT | The `clearAntigravityContextByRole` map is added to the inferred return type. Same pattern as existing `gitProhibitionByRole` and `switchboardSafeguardsByRole` — consistent, not a regression. |
| F3 | No migration for orphaned VSCode setting | NIT | `switchboard.prompt.clearAntigravityContext` fully removed from `package.json`. Users with this key in `settings.json` will have an orphaned entry. VS Code silently ignores unknown properties. Consistent with project convention (other deprecated settings use `deprecationMessage`; this was fully removed since the feature was incorrectly global). |
| F4 | No code bugs found | — | All removals clean, all additions follow patterns, all call sites correctly updated. |

### Stage 2: Balanced Synthesis

| Finding | Verdict | Action |
|---------|---------|--------|
| F1: Plan miscounted call sites (10 vs 11) | Keep — code is correct | Update plan documentation to reflect 11 call sites |
| F2: Return type inferred | Keep — consistent with existing pattern | No action needed |
| F3: No migration for orphaned setting | Keep — acceptable per plan | No action needed |

**No CRITICAL or MAJOR findings. No code fixes required.**

### Verification Results

- **TypeScript (`tsc --noEmit`)**: 2 pre-existing errors in unrelated files (`ClickUpSyncService.ts` line 2309, `KanbanProvider.ts` line 4470 — both about relative import paths). Not caused by this change.
- **Unit Tests (`minimal-prompt.test.js`)**: All 15 tests PASS, including `testClearAntigravityContextEnabled` and `testClearAntigravityContextDisabled`.
- **Unit Tests (`kanban-default-prompt-previews.test.js`)**: PASS.

### Implementation Verification Checklist

| Requirement | Status | Evidence |
|-------------|--------|----------|
| `ROLE_ADDONS`: addon added to all 11 roles | ✅ DONE | Lines 67, 75, 82, 88, 93, 98, 103, 109, 115, 121, 126 in `sharedDefaults.js` |
| `DEFAULT_ROLE_CONFIG`: default `false` for all 11 roles | ✅ DONE | Lines 20-31 in `sharedDefaults.js` |
| Setup tab HTML checkbox removed | ✅ DONE | No `clear-antigravity-context` IDs found in `kanban.html` |
| JS variable `let clearAntigravityContext = false` removed | ✅ DONE | No matches in `kanban.html` |
| JS event listener removed | ✅ DONE | No `toggleClearAntigravityContext` in `kanban.html` |
| JS UI update function removed | ✅ DONE | No `updateClearAntigravityContextUi` in `kanban.html` |
| JS message handler `clearAntigravityContextState` removed | ✅ DONE | No matches in `kanban.html` |
| `_clearAntigravityContext` field removed from KanbanProvider | ✅ DONE | No matches in `src/` |
| `toggleClearAntigravityContext` message handler removed | ✅ DONE | No matches in `KanbanProvider.ts` |
| `clearAntigravityContextState` postMessage removed (2 locations) | ✅ DONE | No matches in `KanbanProvider.ts` |
| `clearAntigravityContextByRole` added to `_getPromptsConfig` | ✅ DONE | Lines 2287-2299 in `KanbanProvider.ts` |
| All 11 `buildKanbanBatchPrompt` call sites updated | ✅ DONE | Lines 2160, 2397, 2498, 2547, 2582, 2775, 2803, 5380, 5391, 5781, 6180 in `KanbanProvider.ts` |
| `agentPromptBuilder.ts` unchanged (as expected) | ✅ DONE | `clearAntigravityContext` option name and behavior preserved at lines 114, 257 |
| `package.json` config property removed | ✅ DONE | No `prompt.clearAntigravityContext` in `package.json` |
| Planner addon checkbox in HTML | ✅ DONE | `plannerAddonClearAntigravityContext` at line 2217 in `kanban.html` |
| Other 10 roles: dynamic addon rendering | ✅ DONE | `renderRoleAddons()` generates checkboxes from `ROLE_ADDONS` data |
| Planner event listener includes new addon | ✅ DONE | Line 3009 in `kanban.html` |
| Planner state restoration includes new addon | ✅ DONE | Line 2453 in `kanban.html` |

### Remaining Risks

- **Orphaned VSCode setting**: Users who had `switchboard.prompt.clearAntigravityContext` in their `settings.json` will have a dead key. No runtime impact; manual cleanup only.
- **Manual testing required**: The per-role checkbox rendering, state persistence, and prompt generation for all 11 roles should be verified in the live extension. Automated tests cover the prompt builder but not the webview UI.
