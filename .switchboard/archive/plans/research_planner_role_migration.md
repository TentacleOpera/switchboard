# Plan: Migrate Deep Planning to Research Planner Role

## Goal
Remove the "DEEP PLANNING" mode button from the Planning Panel and migrate its functionality to a new dedicated "research planner" role in the Kanban interface.

## Metadata
- **Tags:** UI, UX, workflow
- **Complexity:** 5
- **Repo:** none

## User Review Required
- None

## Complexity Audit
### Routine
- Removing the "DEEP PLANNING" button from `src/webview/planning.html` and simplifying `src/webview/planning.js` mode logic.
- Adding the `research_planner` role checkbox to `src/webview/kanban.html` (unchecked by default).
- Adding the `research_planner` role selector option and its specific configuration section (Deep Planning Settings) to the Prompts tab in `kanban.html`.
- Updating `src/webview/sharedDefaults.js` to include `research_planner` in `DEFAULT_ROLE_CONFIG`, `BUILT_IN_AGENT_LABELS`, and `DEFAULT_VISIBLE_AGENTS` (as false).

### Complex / Risky
- None

## Edge-Case & Dependency Audit
- **Race Conditions**: None anticipated. The UI state updates synchronously.
- **Security**: None. Configuration is saved locally.
- **Side Effects**: Changing the role system might break existing plans if they relied on an implicit behavior, but `research_planner` is a net-new role so it should only affect users who opt-in.
- **Dependencies & Conflicts**: The `DEFAULT_ROLE_CONFIG` and `ROLE_KEYS` were recently moved to `src/webview/sharedDefaults.js`. The plan must target this new file instead of `kanban.html` for configuration defaults to prevent duplication or runtime errors.

## Dependencies
None

## Adversarial Synthesis
Key risks: The original plan targeted `kanban.html` for adding default configurations, but `DEFAULT_ROLE_CONFIG` and related constants were recently migrated to `src/webview/sharedDefaults.js`. Mitigations: Target `sharedDefaults.js` for updating `DEFAULT_ROLE_CONFIG`, `DEFAULT_VISIBLE_AGENTS`, and `BUILT_IN_AGENT_LABELS` to ensure correct propagation.

## Proposed Changes

### src/webview/planning.html
- **Context:** The Planning Panel currently has a "DEEP PLANNING" button in the research mode segmented control.
- **Logic:** Remove the deep planning mode option entirely to simplify to a single web research mode.
- **Implementation:**
  - Remove the `<button class="segmented-btn" data-mode="deep" ...>DEEP PLANNING</button>` element (around line 1296).
  - Simplify the segmented control wrapper to a simple mode indicator.
  - Update the mode description text to reflect single-mode operation.

### src/webview/planning.js
- **Context:** Handles the selection of the deep planning mode in the UI.
- **Logic:** Remove deep mode logic from prompt generation.
- **Implementation:**
  - Remove `isWebMode` conditionals (around line 1729).
  - Hardcode `skillName = 'web_research'` and `taskType = 'conduct comprehensive research on the following topic'`.
  - Hardcode `depthLabel = 'Research depth'`.
  - Update `protocolAction` and prompt instructions to use the web research variants unconditionally.

### src/webview/sharedDefaults.js
- **Context:** Defines the default configuration and visibility for all agent roles.
- **Logic:** Register the new `research_planner` role across the system.
- **Implementation:**
  - Add `research_planner: false` to `DEFAULT_VISIBLE_AGENTS` (unchecked by default).
  - Add `research_planner` config to `DEFAULT_ROLE_CONFIG` with `enableDeepPlanning: false` and `researchDepth: 'deep'`.
  - Add `research_planner: 'Research Planner'` to `BUILT_IN_AGENT_LABELS`.
  - *Note: `ROLE_KEYS` is automatically generated from `Object.keys(DEFAULT_ROLE_CONFIG)`, so it will automatically include `research_planner`.*

### src/webview/kanban.html
- **Context:** The Agents tab and Prompts tab control agent selection and configuration.
- **Logic:** Add UI controls for the new `research_planner` role.
- **Implementation:**
  - **Agents Tab:** Add a new `.startup-row` with a checkbox (`class="agents-tab-visible-toggle" data-role="research_planner"`) that does NOT have the `checked` attribute, and a text input for the command placeholder. Position it near the `researcher` role (around line 1997).
  - **Prompts Tab:** Add `<option value="research_planner">Research Planner</option>` to the role selector dropdown (around line 2100).
  - **Prompts Tab Config:** Add a new `<div id="research_plannerConfig" class="role-config hidden">` containing the Deep Planning Settings (a checkbox for `rp-enable-deep-planning` and a select for `rp-research-depth`).
  - **JS Logic:** 
    - Update `handleRoleChange()` to show `research_plannerConfig` when `currentRole === 'research_planner'`.
    - Update save logic to ensure the custom fields `enableDeepPlanning` and `researchDepth` are persisted in the role's configuration object when saved.

### src/services/agentPromptBuilder.ts
- **Context:** Builds the actual prompt sent to the LLM.
- **Logic:** Ensure `DEEP_RESEARCH_DIRECTIVE` is accessible for the new role if they enable it.
- **Implementation:**
  - Add an `if (role === 'research_planner')` block that constructs the prompt similarly to `researcher`, but includes the `DEEP_RESEARCH_DIRECTIVE` and dynamic `depth` if the user's config specifies `enableDeepPlanning` is true.

## Verification Plan
### Automated Tests
- Check if any existing UI tests for `planning.html` or `kanban.html` fail.
- Update unit tests for `agentPromptBuilder.ts` to cover the new role mapping and configuration parsing.

### Manual Checks
- [ ] Verify DEEP PLANNING button is removed from `planning.html`.
- [ ] Verify web research mode still works in Planning Panel.
- [ ] Verify `research_planner` appears in agents tab with checkbox unchecked.
- [ ] Verify `research_planner` appears in prompts tab role selector.
- [ ] Verify `research_planner` config section appears when selected in prompts tab.
- [ ] Verify deep planning settings persist after save/reload.
- [ ] Verify `research_planner` role can be enabled/disabled via agents tab checkbox.
- [ ] Verify CLI command for `research_planner` saves and loads correctly.
- [ ] Test deep planning protocol triggers when `research_planner` is used with deep planning enabled.

## Reviewer Pass

### 🛡️ Stage 1: Grumpy Review
- **[CRITICAL] Missing UI Protection (Prompt Overrides):** The `research_planner` role was NOT included in `PROMPT_OVERRIDE_EXCLUDED_KEYS` within `src/webview/sharedDefaults.js`. While the Kanban JS attempts to hide the text box, excluding it from this list means `setup.html` would mistakenly expose it for generic prompt overriding, breaking the strict configuration contract (it's supposed to be driven by deep/quick settings, not a freeform box).
- **[MAJOR] Missing Test Coverage:** The plan explicitly stated: "Update unit tests for `agentPromptBuilder.ts` to cover the new role mapping and configuration parsing." But there were zero mentions of `research_planner` in `agent-prompt-builder-subagents.test.js` or any other test file. Who marked this plan complete without writing tests? This is unacceptable.

### ⚖️ Stage 2: Balanced Synthesis
The implementation was mostly solid on the UI and builder fronts, successfully handling the prompt construction. The remaining issues are straightforward but critical for correctness:
- **Action 1:** Add `'research_planner'` to `PROMPT_OVERRIDE_EXCLUDED_KEYS` in `src/webview/sharedDefaults.js` to ensure the config flow is watertight across all settings pages.
- **Action 2:** Add tests to `src/test/agent-prompt-builder-subagents.test.js` to verify that `buildKanbanBatchPrompt` properly handles the `research_planner` role with and without `enableDeepPlanning` and parses `researchDepth`.

### 🛠️ Code Fixes Applied
- **`src/webview/sharedDefaults.js`**: Appended `'research_planner'` to `PROMPT_OVERRIDE_EXCLUDED_KEYS`.
- **`src/test/agent-prompt-builder-subagents.test.js`**: Added `testResearchPlannerPrompt` function and execution block to fully cover the role templates and parameter parsing.

### 🧪 Verification Phase
- Ran the unit tests locally: `node src/test/agent-prompt-builder-subagents.test.js`
- Tests passed. Output confirmed: `Testing research_planner prompt template... PASS: research_planner prompt templates correctly implemented`.
- The configuration exclusion acts as a safeguard.

**Remaining Risks:**
- Manual tests of the UI (ensuring the `setup.html` correctly omits it and the `kanban.html` still displays it correctly under settings) should be double-checked by the user.

**ACCURACY VERIFICATION COMPLETE**
