# Unify Research Role UX - Researcher and Code Researcher

## Goal
Unify the kanban prompts tab UX for Researcher and Code Researcher roles by replacing the Code Researcher's custom "Deep Planning Settings" section with a shared "Research Complexity" radio section (matching planning.html's pattern) that appears for both roles. Also rename `research_planner` → `code_researcher` across the codebase to better reflect each role's purpose.

## Role Definitions

| Role | Key | Purpose | Output |
|:-----|:----|:--------|:-------|
| **Code Researcher** | `code_researcher` | Uses research to improve a coding plan — scopes implementation plans with codebase exploration and external research | Enriched plan with research context inline |
| **Researcher** | `researcher` | Uses research to write a document about a research topic (e.g. competitive research on X industry) and saves it to local docs (`.switchboard/docs/`) | Standalone research document saved to local docs |

## Metadata
- **Tags:** [frontend, UX, workflow]
- **Complexity:** 6

## User Review Required
- Confirm that hiding the generic add-ons section (Switchboard Safeguards, Git Prohibition, etc.) for researcher and code_researcher roles is acceptable, since those add-ons will still apply via their defaults (safeguards=true, gitProhibition=true).
- Confirm the `research_planner` → `code_researcher` rename is acceptable — this affects VS Code settings keys (e.g. `switchboard.prompts.roleConfig_research_planner`), so existing user configs will need migration or will reset to defaults.

## Complexity Audit

### Routine
- Removing the `research_plannerConfig` div from kanban.html (lines 2301-2327)
- Adding the new `researchComplexityConfig` div with radio buttons
- Adding CSS for `.radio-group` and `.radio-option` (matching planning.html pattern)
- Adding radio button change listener in `initPromptsTabListeners()`
- Updating `handleRoleChange()` to show/hide the new section
- Removing `researcher` from `PROMPT_OVERRIDE_EXCLUDED_KEYS` in sharedDefaults.js
- Removing the old `rp-enable-deep-planning` and `rp-research-depth` listeners from `initPromptsTabListeners()`
- Renaming `research_planner` → `code_researcher` in sharedDefaults.js (keys, labels, configs, add-ons)
- Renaming `research_planner` → `code_researcher` in kanban.html (agents tab, role select, config div IDs, JS references)
- Updating display labels: "Research Planner" → "Code Researcher"
- Updating agent descriptions to reflect the clarified role purposes

### Complex / Risky
- Updating `agentPromptBuilder.ts` researcher branch (lines 715-744) to accept and use `researchDepth` option — currently the researcher prompt builder only reads `researchEnabled` (boolean), not a depth level. Without this change, the UI complexity selector will have zero effect on the generated researcher prompt.
- Updating `KanbanProvider.ts` to read `researchComplexity` from researcher config and pass it as `researchDepth` to the prompt builder — currently `researchDepth` is only passed for `research_planner` (lines 2490-2491, 2152-2153, 2914-2915). Must also be passed for `researcher`.
- Renaming `research_planner` → `code_researcher` in KanbanProvider.ts (15 occurrences) — this affects VS Code settings keys. Existing user configs stored under `roleConfig_research_planner` will be orphaned; the new `roleConfig_code_researcher` key will use defaults.
- Renaming `research_planner` → `code_researcher` in agentPromptBuilder.ts — the `role === 'research_planner'` branch must become `role === 'code_researcher'`, and the prompt text must change from "You are a Research Planner Agent" to "You are a Code Researcher Agent".
- Updating the researcher prompt to include a "save to local docs" instruction when a `saveToLocalDocs` option is enabled — matching planning.html's import-toggle behavior (lines 1332-1343, planning.js lines 1715-1760). This is a new prompt behavior for the researcher role.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. All UI changes are synchronous DOM operations. Config saves are fire-and-forget messages.
- **Security:** No security implications. This is purely UI/prompt configuration.
- **Side Effects:** Removing `researcher` from `PROMPT_OVERRIDE_EXCLUDED_KEYS` will cause setup.html to show the prompt customization textarea for the researcher role. Previously it was hidden. This is intentional — researcher should be configurable like other roles.
- **Dependencies & Conflicts:** The `researchEnabled` add-on checkbox currently shown for researcher (in `ROLE_ADDONS.researcher`) becomes redundant since research complexity is now controlled by the radio section. It should be removed from the add-ons list. Also, the `promptCustomization` div is currently shown for researcher (displaying "No add-ons available") — the plan hides it for researcher/code_researcher, which means those roles' add-ons (Switchboard Safeguards, Git Prohibition, etc.) won't be visible or toggleable. These add-ons still apply via their defaults but users lose the ability to toggle them.
- **Config Migration:** The rename from `research_planner` to `code_researcher` means existing VS Code settings under keys like `switchboard.prompts.roleConfig_research_planner` will be orphaned. The simplest approach: read the old key as a fallback when the new key is not found. Alternatively, accept that configs reset to defaults (low impact since this role is hidden by default).

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) The researcher prompt builder doesn't consume a `researchDepth` option — the UI complexity selector will be cosmetic-only until the backend is updated. (2) Hiding the add-ons section for researcher/code_researcher removes user control over safeguards and git prohibition toggles. (3) The `research_planner` → `code_researcher` rename orphans existing user configs. Mitigations: (1) Backend changes are explicitly specified below with exact file paths and line numbers. (2) Add-ons still apply via defaults; a future plan can add them to the complexity section if needed. (3) Add a fallback read of the old settings key in KanbanProvider.ts, or accept the reset since the role is hidden by default.

## Proposed Changes

### 1. sharedDefaults.js — Rename research_planner → code_researcher + Update Configs

**Context:** The rename affects DEFAULT_VISIBLE_AGENTS, DEFAULT_ROLE_CONFIG, BUILT_IN_AGENT_LABELS, PROMPT_OVERRIDE_EXCLUDED_KEYS, and ROLE_ADDONS. Also replace `enableDeepPlanning`/`researchDepth` with `researchComplexity`, remove `researchEnabled` add-on from researcher, and update labels/descriptions.

**DEFAULT_VISIBLE_AGENTS** (line 14):
```javascript
code_researcher: false
```

**DEFAULT_ROLE_CONFIG** (lines 29, 31):
```javascript
researcher: { prompt: '', researchComplexity: 'deep', addons: { switchboardSafeguards: true, gitProhibition: true, clearAntigravityContext: false, useSubagents: false } },
// ...
code_researcher: { prompt: '', researchComplexity: 'deep', addons: { switchboardSafeguards: true, gitProhibition: true, clearAntigravityContext: false, cavemanOutput: false, useSubagents: false } },
```

**BUILT_IN_AGENT_LABELS** (line 39):
```javascript
{ key: 'code_researcher', label: 'Code Researcher' },
```

**PROMPT_OVERRIDE_EXCLUDED_KEYS** (line 57):
```javascript
const PROMPT_OVERRIDE_EXCLUDED_KEYS = new Set(['ticket_updater', 'splitter', 'code_researcher']);
```
Note: `researcher` is removed from this set (it should be configurable in setup.html). `code_researcher` remains excluded because its prompt is auto-generated.

**ROLE_ADDONS** — Remove `researchEnabled` from researcher add-ons (lines 144-150), rename `research_planner` key to `code_researcher` (lines 159-165):
```javascript
researcher: [
    { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true },
    { id: 'gitProhibition', label: 'Git Prohibition', tooltip: 'Include git prohibition directive', default: true },
    { id: 'clearAntigravityContext', label: 'Clear Antigravity Context', tooltip: 'Instruct agent to ignore previous checkpoint summaries from prior sessions', default: false },
    { id: 'useSubagents', label: 'Use Subagents for Multiple Plans', tooltip: 'When processing multiple plans, instruct platform to use parallel subagents (if supported)', default: false }
],
// ...
code_researcher: [
    { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true },
    { id: 'gitProhibition', label: 'Git Prohibition', tooltip: 'Include git prohibition directive', default: true },
    { id: 'clearAntigravityContext', label: 'Clear Antigravity Context', tooltip: 'Instruct agent to ignore previous checkpoint summaries from prior sessions', default: false },
    { id: 'cavemanOutput', label: 'Caveman Output', tooltip: 'Compress responses to reduce tokens by 65-75% while maintaining accuracy', default: false },
    { id: 'useSubagents', label: 'Use Subagents for Multiple Plans', tooltip: 'When processing multiple plans, instruct platform to use parallel subagents (if supported)', default: false }
],
```

### 2. kanban.html — Rename research_planner → code_researcher in Agents Tab + Role Select

**Agents tab** (line 2070-2071): Update the startup row and description:
```html
<div class="startup-row"><input type="checkbox" class="agents-tab-visible-toggle" data-role="code_researcher" style="width:auto;margin:0;flex-shrink:0;"><label style="min-width:70px;">Code Researcher</label><input type="text" data-role="code_researcher" id="agents-tab-cmd-code-researcher" placeholder="e.g. agy --approval-mode auto_edit" style="flex:1;"></div>
<div class="agent-description">Uses research to scope and improve coding plans with codebase exploration and external research.</div>
```

**Researcher description** (line 2089): Update to reflect the clarified purpose:
```html
<div class="agent-description">Researches general topics and saves results as documents to local docs storage (.switchboard/docs/).</div>
```

**Role select dropdown** (line 2185):
```html
<option value="code_researcher">Code Researcher</option>
```

### 3. kanban.html (lines 2301-2327) — Remove Code Researcher Config Section

**Context:** The `research_plannerConfig` div (to be renamed `code_researcherConfig`) contains a checkbox and dropdown that are being replaced by a unified radio section matching planning.html's complexity pattern.

Remove the entire div:
```html
<!-- Research Planner-specific configuration -->
<div id="research_plannerConfig" class="role-config" style="display: none;">
  ...
</div>
```

### 4. kanban.html (after removed div, ~line 2301) — Add Research Complexity Section

**Context:** New shared section for both `researcher` and `code_researcher` roles. Matches the complexity panel pattern from planning.html (lines 1308-1329).

```html
<!-- Research Complexity Section (for researcher and code_researcher) -->
<div id="researchComplexityConfig" class="role-config" style="display: none;">
  <div class="db-subsection">
    <div class="subsection-header"><span>Research Complexity</span></div>
    <div class="config-section">
      <p class="section-desc">Select the depth of research for the generated prompt.</p>
      
      <div class="radio-group">
        <label class="radio-option">
          <input type="radio" name="researchComplexity" value="quick">
          <span>Quick (5-10 sources)</span>
        </label>
        <label class="radio-option">
          <input type="radio" name="researchComplexity" value="standard">
          <span>Standard (15-30 sources)</span>
        </label>
        <label class="radio-option">
          <input type="radio" name="researchComplexity" value="deep" checked>
          <span>Deep (50-100+ sources)</span>
        </label>
        <label class="radio-option">
          <input type="radio" name="researchComplexity" value="academic">
          <span>Academic (100-200+ sources)</span>
        </label>
      </div>
    </div>
  </div>
</div>
```

**Edge Cases:** The `name="researchComplexity"` attribute creates a single radio group — only one option can be selected at a time across both roles. Since researcher and code_researcher are never shown simultaneously, this works correctly.

### 5. kanban.html (lines 2530-2569) — Update handleRoleChange() Function

**Context:** The current function references `research_plannerConfig` which is being removed. Must reference the new `researchComplexityConfig` instead and show it for both researcher and code_researcher.

**Logic:** 
- `plannerConfig` shows only for `planner`
- `researchComplexityConfig` shows for `researcher` and `code_researcher`
- `promptCustomization` shows for all roles EXCEPT `planner`, `researcher`, and `code_researcher` (these roles use dedicated config sections instead of generic add-ons)

Replace the function:
```javascript
async function handleRoleChange() {
    const plannerConfig = document.getElementById('plannerConfig');
    const researchComplexityConfig = document.getElementById('researchComplexityConfig');
    const promptCustomization = document.getElementById('promptCustomization');
    if (!plannerConfig || !researchComplexityConfig || !promptCustomization) return;

    plannerConfig.style.display = currentRole === 'planner' ? 'block' : 'none';
    researchComplexityConfig.style.display = (currentRole === 'researcher' || currentRole === 'code_researcher') ? 'block' : 'none';
    promptCustomization.style.display = (currentRole === 'planner' || currentRole === 'researcher' || currentRole === 'code_researcher') ? 'none' : 'block';

    if (currentRole === 'planner') {
        const config = roleConfigs.planner;
        document.getElementById('workflowFilePath').value = config.workflowFilePath || '.agent/workflows/improve-plan.md';
        document.getElementById('plannerAddonSwitchboardSafeguards').checked = config.addons?.switchboardSafeguards !== false;
        document.getElementById('plannerAddonDependencyCheck').checked = !!config.addons?.dependencyCheck;
        document.getElementById('plannerAddonDesignDoc').checked = !!config.addons?.designDoc;
        document.getElementById('plannerAddonAggressivePairProgramming').checked = !!config.addons?.aggressivePairProgramming;
        document.getElementById('plannerAddonGitProhibition').checked = !!config.addons?.gitProhibition;
        document.getElementById('plannerAddonSplitPlan').checked = !!config.addons?.splitPlan;
        document.getElementById('plannerAddonClearAntigravityContext').checked = !!config.addons?.clearAntigravityContext;
        document.getElementById('plannerAddonCavemanOutput').checked = !!config.addons?.cavemanOutput;
        document.getElementById('plannerAddonSkipCompilation').checked = !!config.addons?.skipCompilation;
        document.getElementById('plannerAddonSkipTests').checked = !!config.addons?.skipTests;
        document.getElementById('plannerAddonUseSubagents').checked = config.addons?.useSubagents !== false;
    } else if (currentRole === 'researcher' || currentRole === 'code_researcher') {
        const config = roleConfigs[currentRole];
        const complexity = config.researchComplexity || 'deep';
        const radio = document.querySelector(`input[name="researchComplexity"][value="${complexity}"]`);
        if (radio) radio.checked = true;
        renderRoleAddons(currentRole);
    } else {
        renderRoleAddons(currentRole);
    }

    const previewEl = document.getElementById('promptPreview');
    if (previewEl) {
        previewEl.readOnly = (currentRole === 'planner' || currentRole === 'code_researcher');
    }

    refreshPreview();
}
```

**Edge Cases:** When `config.researchComplexity` is undefined (existing user configs), it defaults to `'deep'` which matches the current default behavior for both roles.

### 6. kanban.html (in initPromptsTabListeners, ~lines 3136-3155) — Replace Old Listeners with Radio Listener

**Context:** Remove the old `rp-enable-deep-planning` and `rp-research-depth` listeners. Add a single listener for the `researchComplexity` radio group.

Remove these listeners (lines 3136-3155):
```javascript
// Research Planner specific listeners
const rpEnableDeepPlanning = document.getElementById('rp-enable-deep-planning');
...
const rpResearchDepth = document.getElementById('rp-research-depth');
...
```

Add new listener:
```javascript
// Research complexity radio buttons (shared by researcher and code_researcher)
document.querySelectorAll('input[name="researchComplexity"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
        if (!roleConfigs[currentRole]) roleConfigs[currentRole] = { prompt: '', addons: {} };
        roleConfigs[currentRole].researchComplexity = e.target.value;
        saveRoleConfig(currentRole);
        refreshPreview();
    });
});
```

### 7. kanban.html (CSS section, ~line 693) — Add Radio Button Styles

**Context:** Match the styles from planning.html (lines 1090-1108) for visual consistency. Use 13px font-size to match planning.html.

```css
.radio-group {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 12px;
}

.radio-option {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    font-size: 13px;
    color: var(--text-primary);
}

.radio-option input[type="radio"] {
    cursor: pointer;
    accent-color: var(--accent-teal);
}
```

### 8. kanban.html — Update remaining research_planner JS references

**Context:** All JavaScript references to `research_planner` in kanban.html must be updated to `code_researcher`. Key locations:
- Line 2497: `data-role="research_planner"` → `data-role="code_researcher"` (if applicable in batch buttons)
- Line 3130: `currentRole === 'research_planner'` → `currentRole === 'code_researcher'` (prompt preview read-only check)

Search for all `research_planner` string literals in kanban.html and replace with `code_researcher`.

### 9. agentPromptBuilder.ts (lines 107-110) — Update PromptBuilderOptions Interface

**Context:** Remove `enableDeepPlanning` and `researchEnabled` options — both are replaced by `researchDepth` which already exists at line 110. Also add `saveToLocalDocs` option for researcher.

Remove:
```typescript
/** When true, the research_planner role triggers the full deep research protocol. */
enableDeepPlanning?: boolean;
```

Remove:
```typescript
/** When false (explicitly), researcher uses a lightweight base prompt without DEEP_RESEARCH_DIRECTIVE. Defaults to enabled (undefined). */
researchEnabled?: boolean;
```

Add:
```typescript
/** When true, researcher prompt includes instruction to save results to local docs folder (.switchboard/docs/). */
saveToLocalDocs?: boolean;
/** The local docs folder path for the save-to-local-docs instruction. */
localDocsPath?: string;
```

### 10. agentPromptBuilder.ts (lines 715-744) — Update Researcher Prompt Generation

**Context:** This is a critical backend change. Currently the researcher branch only reads `researchEnabled` (boolean) and uses the hardcoded `DEEP_RESEARCH_DIRECTIVE` with no depth parameterization. Must add `researchDepth` support so the complexity radio selection actually affects the generated prompt. Also add the "save to local docs" instruction when `saveToLocalDocs` is enabled, matching planning.html's import-toggle behavior.

```typescript
if (role === 'researcher') {
    const researchDepth = options?.researchDepth || 'deep';

    const depthLabels: Record<string, string> = {
        quick: 'Quick (5-10 sources)',
        standard: 'Standard (15-30 sources)',
        deep: 'Deep (50-100+ sources)',
        academic: 'Academic (100-200+ sources)'
    };
    const label = depthLabels[researchDepth] || researchDepth;

    // Parameterize the research directive with the selected depth
    const customDeepDirective = DEEP_RESEARCH_DIRECTIVE
        .replace('depth set to "deep" (50-100 sources)', `depth set to "${researchDepth}" (${label})`)
        .replace('TARGET SOURCE COUNT: 50-100 sources', `TARGET SOURCE COUNT: ${label}`);

    let researcherBase = `You are a Researcher Agent.\n\n${customDeepDirective}`;

    // Add save-to-local-docs instruction if enabled (matches planning.html import-toggle behavior)
    const saveToLocalDocs = options?.saveToLocalDocs ?? false;
    if (saveToLocalDocs) {
        const savePath = options?.localDocsPath || '.switchboard/docs/';
        researcherBase += `\n\nIMPORTANT: After completing the research, save the results to ${savePath} using the write_to_file tool so I can review them later.`;
    }

    let baseInstructions = resolveBaseInstructions('researcher', researcherBase, options);
    if (cavemanOutputEnabled) {
        baseInstructions += '\n\n' + CAVEMAN_OUTPUT_DIRECTIVE;
    }

    const safeguardsBlock = switchboardSafeguardsEnabled ? batchExecutionRules : '';
    const focusBlock = switchboardSafeguardsEnabled ? FOCUS_DIRECTIVE : '';
    const gitBlock = gitProhibitionEnabled ? GIT_PROHIBITION_DIRECTIVE : '';
    const suffixBlock = [dispatchContextPrefix, focusBlock, gitBlock, antigravityBlock]
        .filter(Boolean)
        .join('\n\n');

    const promptParts = [
        baseInstructions,
        safeguardsBlock,
        suffixBlock,
        `PLANS TO PROCESS:\n${planList}`
    ].filter(Boolean).join('\n\n');

    return normalizeNewlines(promptParts);
}
```

**Edge Cases:** The `researchEnabled` option is no longer consumed — research is always included, with complexity controlled by the radio selector. The `resolveBaseInstructions` call still allows prompt overrides (prepend/append/replace) via `defaultPromptOverrides`, preserving extensibility.

### 11. agentPromptBuilder.ts (lines 746-788) — Update Code Researcher Prompt Generation

**Context:** Rename the `research_planner` branch to `code_researcher`. Remove the `enableDeepPlanning` conditional branch. Always include the research directive, parameterized by `researchDepth`. Update the agent self-identification from "Research Planner Agent" to "Code Researcher Agent".

```typescript
if (role === 'code_researcher') {
    const depth = options?.researchDepth || 'deep';

    const depthLabels: Record<string, string> = {
        quick: 'Quick (5-10 sources)',
        standard: 'Standard (15-30 sources)',
        deep: 'Deep (50-100+ sources)',
        academic: 'Academic (100-200+ sources)'
    };
    const label = depthLabels[depth] || depth;

    // Parameterize the research directive with the selected depth
    const customDeepDirective = DEEP_RESEARCH_DIRECTIVE
        .replace('depth set to "deep" (50-100 sources)', `depth set to "${depth}" (${label})`)
        .replace('TARGET SOURCE COUNT: 50-100 sources', `TARGET SOURCE COUNT: ${label}`);

    let crBase = `You are a Code Researcher Agent.\n\n${customDeepDirective}`;

    let baseInstructions = resolveBaseInstructions('code_researcher', crBase, options);
    if (cavemanOutputEnabled) {
        baseInstructions += '\n\n' + CAVEMAN_OUTPUT_DIRECTIVE;
    }

    const safeguardsBlock = switchboardSafeguardsEnabled ? batchExecutionRules : '';
    const focusBlock = switchboardSafeguardsEnabled ? FOCUS_DIRECTIVE : '';
    const gitBlock = gitProhibitionEnabled ? GIT_PROHIBITION_DIRECTIVE : '';
    const suffixBlock = [dispatchContextPrefix, focusBlock, gitBlock, antigravityBlock]
        .filter(Boolean)
        .join('\n\n');

    const promptParts = [
        baseInstructions,
        safeguardsBlock,
        suffixBlock,
        `PLANS TO PROCESS:\n${planList}`
    ].filter(Boolean).join('\n\n');

    return normalizeNewlines(promptParts);
}
```

### 12. KanbanProvider.ts — Rename research_planner → code_researcher + Update Config Reading

**Context:** 15 occurrences of `research_planner` must be renamed to `code_researcher`. Also must read `researchComplexity` from both researcher and code_researcher configs and pass it as `researchDepth` to the prompt builder. Must remove `enableDeepPlanning` references. Must add `saveToLocalDocs`/`localDocsPath` passing for researcher.

**Config key rename:** All `roleConfig_research_planner` → `roleConfig_code_researcher`. Add fallback read of old key for migration:
```typescript
const codeResearcherConfig: any = this._getSetting('switchboard.prompts.roleConfig_code_researcher', undefined)
    ?? this._getSetting('switchboard.prompts.roleConfig_research_planner', undefined);
```

**In `_buildPromptsConfig()` (~line 2285-2288):** Replace the `researchPlanner` sub-object:
```typescript
codeResearcher: {
    researchDepth: codeResearcherConfig?.researchComplexity || 'deep',
},
```
Remove `enableDeepPlanning` from this object.

**Add researcher researchDepth reading (~line 2366):**
```typescript
researchEnabled: researcherConfig?.addons?.researchEnabled ?? true,  // REMOVE this line
researchDepth: researcherConfig?.researchComplexity || 'deep',       // ADD this line
saveToLocalDocs: researcherConfig?.saveToLocalDocs ?? false,         // ADD
localDocsPath: this._getSetting('switchboard.localFolderPath', undefined),  // ADD
```

**In prompt preview generation (~line 2152-2153):** Replace:
```typescript
enableDeepPlanning: promptsConfig.codeResearcher?.enableDeepPlanning,  // REMOVE
researchDepth: promptsConfig.codeResearcher?.researchDepth,            // KEEP
```

**In prompt preview generation (~line 2181):** Replace:
```typescript
researchEnabled: role === 'researcher' ? promptsConfig.researchEnabled : undefined,  // REMOVE
researchDepth: role === 'researcher' ? promptsConfig.researchDepth : undefined,       // ADD
saveToLocalDocs: role === 'researcher' ? promptsConfig.saveToLocalDocs : undefined,   // ADD
localDocsPath: role === 'researcher' ? promptsConfig.localDocsPath : undefined,       // ADD
```

**In batch prompt generation (~line 2490-2491):** Replace:
```typescript
enableDeepPlanning: role === 'code_researcher' ? promptsConfig.codeResearcher?.enableDeepPlanning : undefined,  // REMOVE
researchDepth: role === 'code_researcher' ? promptsConfig.codeResearcher?.researchDepth : undefined,            // KEEP
```

**In batch prompt generation (~line 2494):** Replace:
```typescript
researchEnabled: role === 'researcher' ? promptsConfig.researchEnabled : undefined,  // REMOVE
researchDepth: role === 'researcher' ? promptsConfig.researchDepth : undefined,       // ADD
saveToLocalDocs: role === 'researcher' ? promptsConfig.saveToLocalDocs : undefined,   // ADD
localDocsPath: role === 'researcher' ? promptsConfig.localDocsPath : undefined,       // ADD
```

**In autoban dispatch (~line 2914-2915):** Same pattern — remove `enableDeepPlanning`, keep `researchDepth`, add `saveToLocalDocs`/`localDocsPath` for researcher.

**All other `research_planner` string literals** in KanbanProvider.ts (lines 2085, 2237, 2269, 2282, 2300, 2313, 2326, 2339, 2352, 2892, 3236, 6052, 6053): Replace with `code_researcher`.

### 13. TaskViewerProvider.ts (lines 2854, 5889-5890) — Update References

**Context:** TaskViewerProvider also passes `enableDeepPlanning`/`researchDepth` to the prompt builder and references `research_planner`. Must update to match the new interface.

- Rename `research_planner` → `code_researcher`
- Remove `enableDeepPlanning` reference
- Ensure `researchDepth` is passed for both researcher and code_researcher roles
- Add `saveToLocalDocs`/`localDocsPath` for researcher

### 14. kanban.html — Add "Save to Local Docs" Toggle for Researcher

**Context:** The Researcher role needs a "Save to Local Docs" toggle matching planning.html's import-toggle (lines 1332-1343). This should appear inside the `researchComplexityConfig` div, only for the researcher role. The Code Researcher does NOT need this toggle — its output enriches the plan inline, not as a separate document.

Add a toggle inside the `researchComplexityConfig` div, after the radio group:
```html
<!-- Save to local docs toggle (researcher only) -->
<div id="saveToLocalDocsRow" class="checkbox-group" style="margin-top: 16px; display: none;">
  <label class="checkbox-item" title="Save research results to .switchboard/docs/ for later viewing">
    <input type="checkbox" id="saveToLocalDocs">
    <span>Save Results to Local Docs</span>
    <span class="tooltip">Instructs the agent to save research results to .switchboard/docs/ using write_to_file</span>
  </label>
</div>
```

**In `handleRoleChange()`:** Show/hide the toggle based on role:
```javascript
const saveToLocalDocsRow = document.getElementById('saveToLocalDocsRow');
if (saveToLocalDocsRow) {
    saveToLocalDocsRow.style.display = currentRole === 'researcher' ? 'block' : 'none';
    if (currentRole === 'researcher') {
        const config = roleConfigs.researcher;
        document.getElementById('saveToLocalDocs').checked = !!config.saveToLocalDocs;
    }
}
```

**In `initPromptsTabListeners()`:** Add listener:
```javascript
const saveToLocalDocsCheckbox = document.getElementById('saveToLocalDocs');
if (saveToLocalDocsCheckbox) {
    saveToLocalDocsCheckbox.addEventListener('change', (e) => {
        if (!roleConfigs.researcher) roleConfigs.researcher = { prompt: '', addons: {} };
        roleConfigs.researcher.saveToLocalDocs = e.target.checked;
        saveRoleConfig('researcher');
        refreshPreview();
    });
}
```

### 15. Test Files — Update References

- `src/test/kanban-default-prompt-previews.test.js` (lines 49, 62, 67-68, 85, 95-96) — rename `research_planner` → `code_researcher`, remove `enableDeepPlanning`/`researchEnabled` assertions, add `researchDepth` assertions
- `src/test/minimal-prompt.test.js` (lines 190, 229, 230-231) — rename `research_planner` → `code_researcher`, remove `enableDeepPlanning` references
- `src/test/agent-prompt-builder-subagents.test.js` (lines 282, 284, 290, 296) — rename `research_planner` → `code_researcher`, remove `enableDeepPlanning` reference

## Verification Plan

### Automated Tests
- Update all test files listed in Change 15
- Add test for researcher prompt with `saveToLocalDocs: true` — verify "save the results to" instruction appears
- Add test for researcher prompt with `saveToLocalDocs: false` — verify no save instruction
- Add test for code_researcher prompt — verify agent self-identifies as "Code Researcher Agent"
- Add test for researcher prompt with different `researchDepth` values — verify source count changes in output

### Manual Verification
1. Open kanban prompts tab, select Researcher role — should show "Research Complexity" radio section with 4 options (Quick, Standard, Deep, Academic), defaulting to Deep
2. Verify Researcher also shows "Save Results to Local Docs" checkbox
3. Open kanban prompts tab, select Code Researcher role — should show identical "Research Complexity" radio section but NO "Save Results to Local Docs" checkbox
4. Verify the old "Deep Planning Settings" section (checkbox + dropdown) no longer appears
5. Verify the old "No add-ons available" message no longer appears for Researcher
6. Select a different complexity (e.g., "Quick") for Researcher — verify the prompt preview updates to show "depth set to quick (5-10 sources)"
7. Enable "Save Results to Local Docs" for Researcher — verify the prompt preview includes "save the results to .switchboard/docs/"
8. Select a different complexity for Code Researcher — verify the prompt preview updates similarly
9. Verify Code Researcher prompt self-identifies as "Code Researcher Agent"
10. Reload the workspace — verify the selected complexity persists across sessions for both roles
11. Verify other roles (planner, coder, etc.) are unaffected — their config sections display normally
12. Verify the add-ons section still appears for roles other than researcher/code_researcher/planner
13. Verify setup.html now shows prompt customization for the researcher role
14. Verify the agents tab shows "Code Researcher" label (not "Research Planner")
15. Verify the role select dropdown shows "Code Researcher" (not "Research Planner")

---

## Review Results (Reviewer Pass)

### Stage 1 — Grumpy Principal Engineer Findings

| # | Severity | File | Finding |
|---|----------|------|---------|
| 1 | CRITICAL | TaskViewerProvider.ts:5870,5889,5894 | `_buildKanbanBatchPrompt()` still passes `enableDeepPlanning` and `researchEnabled` — both removed from `PromptBuilderOptions` interface. TypeScript excess property violation. |
| 2 | MAJOR | TaskViewerProvider.ts:5890 | `researchDepth: roleConfig?.researchDepth` reads from wrong config key. UI saves as `researchComplexity`; this will always be `undefined` for migrated configs. |
| 3 | MAJOR | TaskViewerProvider.ts | Missing `saveToLocalDocs`/`localDocsPath` for researcher role. Plan Change 13 explicitly requires these. |
| 4 | NIT | kanban.html:2166 | Custom agent `ca-addon-research` label hardcodes "50-100 sources" — stale vs. unified UX (out of plan scope). |
| 5 | NIT | agentConfig.ts:17, TaskViewerProvider.ts:5966 | `researchEnabled` in `CustomAgentAddons` and `buildCustomAgentPrompt()` — for custom agents only, out of plan scope. |

### Stage 2 — Balanced Synthesis

- **Fix now:** Findings 1-3 (all in TaskViewerProvider.ts `_buildKanbanBatchPrompt()`, one surgical edit)
- **Defer:** Findings 4-5 (custom agent scope, not part of this plan)

### Stage 3 — Code Fixes Applied

**File: `src/services/TaskViewerProvider.ts` (lines 5869-5894)**

Changes:
1. Removed `const researchEnabled = roleConfig?.addons?.researchEnabled ?? true;` (dead code)
2. Removed `enableDeepPlanning: roleConfig?.enableDeepPlanning,` from options (removed from interface)
3. Removed `researchEnabled,` from options (removed from interface)
4. Changed `researchDepth: roleConfig?.researchDepth` → `researchDepth: roleConfig?.researchComplexity || 'deep'` (reads from correct config key, matching KanbanProvider pattern)
5. Added `saveToLocalDocs: role === 'researcher' ? (roleConfig?.saveToLocalDocs ?? false) : undefined,`
6. Added `localDocsPath: role === 'researcher' ? vscode.workspace.getConfiguration('switchboard').get<string>('research.localFolderPath', undefined) : undefined,`

### Stage 4 — Validation Results

- [x] `enableDeepPlanning` — zero references in all TS files
- [x] `researchEnabled` in kanban batch path — removed from TaskViewerProvider (only remains in custom agent `buildCustomAgentPrompt()` — out of scope)
- [x] `researchDepth` — reads from `researchComplexity` config key in both KanbanProvider and TaskViewerProvider
- [x] `saveToLocalDocs`/`localDocsPath` — passed for researcher in both KanbanProvider and TaskViewerProvider
- [x] `research_planner` — only remaining reference is intentional migration fallback in KanbanProvider.ts:2238
- [x] All other plan changes (1-12, 14-15) verified clean in prior implementation

### Remaining Risks

1. **Custom agent `researchEnabled` inconsistency** (NIT, deferred): The `ca-addon-research` checkbox in the custom agent form and `researchEnabled` in `CustomAgentAddons` still use the old boolean model. A future plan should consider adding a `researchComplexity` option for custom agents to match the unified UX.
2. **Config migration**: Existing user configs under `roleConfig_research_planner` will fall back correctly via KanbanProvider.ts:2238, but TaskViewerProvider has no such fallback. Since TaskViewerProvider reads `roleConfig_${role}` dynamically and the role key is now `code_researcher`, old configs under `roleConfig_research_planner` won't be found by TaskViewerProvider either. This is acceptable per the plan's stated approach ("accept that configs reset to defaults since this role is hidden by default").

---

**Recommendation:** Complexity 6 → Send to Coder
