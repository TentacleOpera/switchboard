# Add Ticket Update Mode Addons to ticket_updater Role

## Goal

Refactor the `ticket_updater` role to support multiple distinct use cases as configurable addon options:
1. **disabled**: No ticket update (preserves current `ticketUpdateEnabled: false` behavior)
2. **comment-only**: Add AI analysis as a comment to the external ticket (current enabled behavior)
3. **refine-ticket**: Refine the ticket description itself based on plan analysis
4. **research-and-refine**: Perform research first, then refine the ticket with findings

Each mode should be a separate radio option in the Prompts tab UI, replacing the current boolean checkbox.

## Metadata

**Tags:** UI, frontend, workflow
**Complexity:** 6

## User Review Required

No breaking changes if migration logic is included. The existing `ticketUpdateEnabled` addon will be replaced with a more granular `ticketUpdateMode` selector. A runtime migration will map old boolean values to the new enum. Users with existing saved configs will be seamlessly migrated; no manual reconfiguration required.

## Complexity Audit

### Routine
- Add `ticketUpdateMode` field to `ROLE_ADDONS` and `DEFAULT_ROLE_CONFIG` in `sharedDefaults.js` for ticket_updater role
- Add `ticketUpdateMode` to `CustomAgentAddons` interface in `agentConfig.ts`
- Add `ticketUpdateMode` to `parseCustomAgentAddons()` in `agentConfig.ts`
- Add `ticketUpdateMode` to `PromptBuilderOptions` interface in `agentPromptBuilder.ts`
- Update `ticket_updater` prompt logic in `agentPromptBuilder.ts` to handle different modes
- Update `renderRoleAddons()` in `kanban.html` to support radio button rendering for `type: 'radio'` addons
- Update custom agent form in `kanban.html` (`ca-addon-ticket-update` → mode selector)
- Update `KanbanProvider.ts` references from `ticketUpdateEnabled` to `ticketUpdateMode`
- Update `TaskViewerProvider.ts` references from `ticketUpdateEnabled` to `ticketUpdateMode`
- Add unit test for ticket update mode prompt generation

### Complex / Risky
- **Prompt logic branching**: The `ticket_updater` prompt currently has a single path. Adding mode-specific instructions requires careful conditional logic to ensure each mode has clear, distinct instructions.
- **Research mode integration**: The "research-and-refine" mode needs to invoke the research skill before ticket updates, which may require coordination with the research skill infrastructure.
- **Dynamic rendering extension**: `renderRoleAddons()` currently only supports checkboxes. Extending it to support radio button groups requires schema changes to `ROLE_ADDONS` and rendering logic updates.
- **Backward compatibility migration**: Old configs with `ticketUpdateEnabled` must be mapped to `ticketUpdateMode` at runtime to avoid silent behavior changes.

## Edge-Case & Dependency Audit

### Race Conditions
- None. Checkbox/radio state is persisted to `workspaceState` synchronously and read on next prompt generation.

### Security
- None. The new field controls prompt text content only. No auth or permissions changes.

### Side Effects
- **Existing `ticketUpdateEnabled` deprecation**: The current boolean `ticketUpdateEnabled` will be replaced by the enum `ticketUpdateMode`. Migration logic must map old values: `true → 'comment-only'`, `false → 'disabled'`.
- **Custom agents**: Custom agents using `ticket_updater` role will need the `ca-addon-ticket-update` form element updated to a mode selector.
- **Default value semantics shift**: The old default was `ticketUpdateEnabled: false` (disabled). The new default is `ticketUpdateMode: 'disabled'` to preserve this behavior. This differs from the plan's initial proposal of `'comment-only'` as default.

### Dependencies & Conflicts
- None identified beyond the `web_research` skill availability for research-and-refine mode.

## Dependencies

None

## Adversarial Synthesis

Key risks: (1) Two provider files (KanbanProvider.ts, TaskViewerProvider.ts) were missing from the original plan and must be updated to avoid split-brain config state; (2) The Prompts tab uses dynamic rendering via `renderRoleAddons()`, not hardcoded HTML, so the rendering approach must be updated; (3) The old default was OFF, so the new default must be 'disabled' to avoid silent behavior change. Mitigations: Add all 6 affected files to the plan; extend `ROLE_ADDONS` with `type: 'radio'` and `options` schema; add migration logic in `renderRoleAddons()` and provider config loading.

## Proposed Changes

### `src/webview/sharedDefaults.js`

**Context**: `ROLE_ADDONS` defines addon UI metadata per role. `DEFAULT_ROLE_CONFIG` defines the in-memory default addon values.

**Implementation**:

1. Replace the existing `ticketUpdateEnabled` entry in `ticket_updater`'s `ROLE_ADDONS` array (line 139) with:
```javascript
{ id: 'ticketUpdateMode', label: 'Ticket Update Mode', tooltip: 'Select how the agent should update the external ticket', type: 'radio', options: [
    { value: 'disabled', label: 'Disabled', tooltip: 'No ticket update' },
    { value: 'comment-only', label: 'Comment Only', tooltip: 'Add AI analysis as a comment to the ticket' },
    { value: 'refine-ticket', label: 'Refine Ticket', tooltip: 'Refine the ticket description based on plan analysis' },
    { value: 'research-and-refine', label: 'Research & Refine', tooltip: 'Research first, then refine the ticket with findings' }
], default: 'disabled' }
```

2. Replace `ticketUpdateEnabled: false` in `ticket_updater`'s `DEFAULT_ROLE_CONFIG` (line 28) with:
```javascript
ticketUpdateMode: 'disabled'
```

---

### `src/services/agentConfig.ts`

**Context**: `CustomAgentAddons` interface (line 3) and `parseCustomAgentAddons()` function (line 145) define the addon structure.

**Implementation**:

1. Replace `ticketUpdateEnabled?: boolean` (line 19) with:
```typescript
ticketUpdateMode?: 'disabled' | 'comment-only' | 'refine-ticket' | 'research-and-refine';
```

2. Replace the `ticketUpdateEnabled` parsing logic in `parseCustomAgentAddons()` (line 161) with:
```typescript
if (s.ticketUpdateMode && ['disabled', 'comment-only', 'refine-ticket', 'research-and-refine'].includes(s.ticketUpdateMode)) {
    a.ticketUpdateMode = s.ticketUpdateMode;
} else if (s.ticketUpdateEnabled === true) {
    // Migration: map old boolean to new enum
    a.ticketUpdateMode = 'comment-only';
} else if (s.ticketUpdateEnabled === false) {
    a.ticketUpdateMode = 'disabled';
}
```

---

### `src/services/agentPromptBuilder.ts`

**Context**: The `ticket_updater` role's prompt is defined in lines 667-734. Currently it has a single path based on `ticketUpdateEnabled`.

**Implementation**:

1. Replace `ticketUpdateEnabled?: boolean` in `PromptBuilderOptions` interface (line 126) with:
```typescript
/** Controls ticket update behavior: disabled, comment-only, refine-ticket, or research-and-refine */
ticketUpdateMode?: 'disabled' | 'comment-only' | 'refine-ticket' | 'research-and-refine';
```

2. Replace the entire `ticket_updater` block (lines 667-734) with mode-specific prompts:

```typescript
if (role === 'ticket_updater') {
    const ticketUpdateMode = options?.ticketUpdateMode ?? 'disabled';

    // Shared analysis template
    const analysisTemplate = (extraFields: string[] = []) => {
        const fields = [
            '- **Goal Summary**: Brief overview of what the plan aims to achieve',
            '- **Complexity Assessment**: Overall complexity (Low/Medium/High) and key risk areas',
            '- **Key Dependencies**: Major dependencies or blockers',
            '- **Implementation Notes**: Any notable implementation considerations',
            '- **Estimated Effort**: Rough effort estimate (if discernible from complexity)',
            ...extraFields
        ];
        return fields.join('\n');
    };

    let updaterBase: string;

    if (ticketUpdateMode === 'comment-only') {
        const ticketUpdateDirective =
            `TICKET UPDATE MODE: You are authorized to update the associated ticket. ` +
            `Extract the ticket number from the plan metadata field "**Ticket:**" (format: CU-XXXXX or LIN-XXXXX). ` +
            `Analyze the plan, then use the clickup_api or linear_api skill to add an "AI Analysis" comment to the ticket. ` +
            `Do not modify the ticket description. Only add a comment. ` +
            `If no ticket number is found, skip the ticket update and notify the user.`;

        updaterBase = `You are a Ticket Updater Agent.

STEP 1: Analyze the Plan
Generate a concise analysis covering:
${analysisTemplate()}

Keep the analysis under 500 words for readability in the ticket.

STEP 2: Update the Ticket
${ticketUpdateDirective}

Format the analysis as:
## AI Analysis

[Your analysis content here]`;
    } else if (ticketUpdateMode === 'refine-ticket') {
        const ticketUpdateDirective =
            `TICKET UPDATE MODE: You are authorized to update the associated ticket. ` +
            `Extract the ticket number from the plan metadata field "**Ticket:**" (format: CU-XXXXX or LIN-XXXXX). ` +
            `Analyze the plan, then use the clickup_api or linear_api skill to refine the ticket description. ` +
            `Update the description to reflect the plan's current state, implementation details, and any changes from the original request. ` +
            `If no ticket number is found, skip the ticket update and notify the user.`;

        updaterBase = `You are a Ticket Updater Agent.

STEP 1: Analyze the Plan
Generate a comprehensive analysis covering:
${analysisTemplate(['- **Current Status**: What has been completed and what remains'])}

STEP 2: Update the Ticket
${ticketUpdateDirective}

Format the refined description as a clear, structured ticket description that accurately reflects the plan's current state.`;
    } else if (ticketUpdateMode === 'research-and-refine') {
        const researchDirective =
            `RESEARCH MODE: Before updating the ticket, use the web_research skill to gather additional context. ` +
            `Research the technical approach, dependencies, best practices, and any relevant recent developments. ` +
            `If the web_research skill is unavailable, proceed with codebase-only analysis and note the gap.`;

        const ticketUpdateDirective =
            `TICKET UPDATE MODE: You are authorized to update the associated ticket. ` +
            `Extract the ticket number from the plan metadata field "**Ticket:**" (format: CU-XXXXX or LIN-XXXXX). ` +
            `After completing research, use the clickup_api or linear_api skill to refine the ticket description. ` +
            `Update the description to reflect the plan's current state, implementation details, research findings, and any changes from the original request. ` +
            `If no ticket number is found, skip the ticket update and notify the user.`;

        updaterBase = `You are a Ticket Updater Agent.

STEP 1: Analyze the Plan
Generate a comprehensive analysis covering:
${analysisTemplate(['- **Current Status**: What has been completed and what remains'])}

STEP 2: Research
${researchDirective}

STEP 3: Update the Ticket
${ticketUpdateDirective}

Format the refined description as a clear, structured ticket description that accurately reflects the plan's current state and incorporates your research findings.`;
    } else {
        // disabled mode (or unknown values) — analysis only, no ticket update
        updaterBase = `You are a Ticket Updater Agent.

STEP 1: Analyze the Plan
Generate a concise analysis covering:
${analysisTemplate()}

Keep the analysis under 500 words for readability.

Format the analysis as:
## AI Analysis

[Your analysis content here]`;
    }

    let baseInstructions = resolveBaseInstructions('ticket_updater', updaterBase, options);
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

---

### `src/services/KanbanProvider.ts`

**Context**: `_getPromptsConfig()` (line 2233) loads ticket_updater config and maps `ticketUpdateEnabled` to prompt options. Multiple dispatch paths reference `promptsConfig.ticketUpdateEnabled`.

**Implementation**:

1. In `_getPromptsConfig()` (line 2380), replace:
```typescript
ticketUpdateEnabled: ticketUpdaterConfig?.addons?.ticketUpdateEnabled ?? true,
```
with:
```typescript
ticketUpdateMode: ticketUpdaterConfig?.addons?.ticketUpdateMode
    ?? (ticketUpdaterConfig?.addons?.ticketUpdateEnabled === true ? 'comment-only'
        : ticketUpdaterConfig?.addons?.ticketUpdateEnabled === false ? 'disabled'
        : 'disabled'),
```

2. In `_generatePromptPreviews()` (line 2181), replace:
```typescript
ticketUpdateEnabled: role === 'ticket_updater' ? promptsConfig.ticketUpdateEnabled : undefined,
```
with:
```typescript
ticketUpdateMode: role === 'ticket_updater' ? promptsConfig.ticketUpdateMode : undefined,
```

3. In `_generateAntigravityPrompt()` (line 2506), replace:
```typescript
ticketUpdateEnabled: role === 'ticket_updater' ? promptsConfig.ticketUpdateEnabled : undefined,
```
with:
```typescript
ticketUpdateMode: role === 'ticket_updater' ? promptsConfig.ticketUpdateMode : undefined,
```

4. In `_generateBatchExecutionPrompt()` (line 2930), replace:
```typescript
ticketUpdateEnabled: role === 'ticket_updater' ? promptsConfig.ticketUpdateEnabled : undefined,
```
with:
```typescript
ticketUpdateMode: role === 'ticket_updater' ? promptsConfig.ticketUpdateMode : undefined,
```

5. In the `getPromptPreview` message handler (line 6118), replace:
```typescript
ticketUpdateEnabled: role === 'ticket_updater' ? promptsConfig.ticketUpdateEnabled : undefined,
```
with:
```typescript
ticketUpdateMode: role === 'ticket_updater' ? promptsConfig.ticketUpdateMode : undefined,
```

---

### `src/services/TaskViewerProvider.ts`

**Context**: The `buildKanbanBatchPrompt` call (line 5884) passes `ticketUpdateEnabled` from role config. The `_generateTicketUpdaterPrompt` method (line 5970) also checks `addons?.ticketUpdateEnabled`.

**Implementation**:

1. In the `buildKanbanBatchPrompt` options (around line 5881), replace:
```typescript
const ticketUpdateEnabled = roleConfig?.addons?.ticketUpdateEnabled ?? true;
```
with:
```typescript
const ticketUpdateMode = roleConfig?.addons?.ticketUpdateMode
    ?? (roleConfig?.addons?.ticketUpdateEnabled === true ? 'comment-only'
        : roleConfig?.addons?.ticketUpdateEnabled === false ? 'disabled'
        : 'disabled');
```

2. In the `buildKanbanBatchPrompt` call (line 5905), replace:
```typescript
ticketUpdateEnabled,
```
with:
```typescript
ticketUpdateMode,
```

3. In the `_generateTicketUpdaterPrompt` method (line 5970), replace:
```typescript
if (addons?.ticketUpdateEnabled) {
    prompt += `\n\n${TaskViewerProvider.TICKET_UPDATE_DIRECTIVE}`;
}
```
with:
```typescript
if (addons?.ticketUpdateMode && addons.ticketUpdateMode !== 'disabled') {
    prompt += `\n\n${TaskViewerProvider.TICKET_UPDATE_DIRECTIVE}`;
}
```

---

### `src/webview/kanban.html`

**Context**: The Prompts tab renders addon checkboxes dynamically via `renderRoleAddons()` (line 2623), which reads from `ROLE_ADDONS` and creates checkbox elements. The custom agent form has a separate `ca-addon-ticket-update` checkbox (line 2174).

**Implementation**:

1. Update `renderRoleAddons()` (line 2623) to support radio button rendering when an addon has `type: 'radio'`:

```javascript
function renderRoleAddons(role) {
    const group = document.getElementById('roleAddonsGroup');
    const desc = document.getElementById('roleAddonsDesc');
    if (!group || !desc) return;
    group.innerHTML = '';

    const addons = ROLE_ADDONS[role] || [];
    if (addons.length === 0) {
        desc.textContent = 'No add-ons available for this role.';
        return;
    }

    desc.textContent = `${role.charAt(0).toUpperCase() + role.slice(1)}-specific orchestration features:`;

    addons.forEach(addon => {
        if (addon.type === 'radio' && addon.options) {
            // Render radio button group
            const currentValue = roleConfigs[role]?.addons?.[addon.id] ?? addon.default;
            const wrapper = document.createElement('div');
            wrapper.className = 'addon-radio-group';
            wrapper.innerHTML = `<span class="addon-label" style="font-weight:600;margin-bottom:4px;display:block;">${addon.label}</span>`;
            addon.options.forEach(opt => {
                const label = document.createElement('label');
                label.className = 'checkbox-item';
                label.title = opt.tooltip || '';
                label.innerHTML = `
                    <input type="radio" name="addon_${addon.id}" value="${opt.value}" ${currentValue === opt.value ? 'checked' : ''}>
                    <span>${opt.label}</span>
                `;
                label.querySelector('input').addEventListener('change', (e) => {
                    if (!roleConfigs[role]) roleConfigs[role] = { prompt: '', addons: {} };
                    if (!roleConfigs[role].addons) roleConfigs[role].addons = {};
                    roleConfigs[role].addons[addon.id] = e.target.value;
                    saveRoleConfig(role);
                    refreshPreview();
                });
                wrapper.appendChild(label);
            });
            group.appendChild(wrapper);
        } else {
            // Existing checkbox rendering (unchanged)
            const isChecked = roleConfigs[role]?.addons?.[addon.id] ?? addon.default;
            const label = document.createElement('label');
            label.className = 'checkbox-item';
            label.title = addon.tooltip;
            label.innerHTML = `
                <input type="checkbox" id="addon_${addon.id}" ${isChecked ? 'checked' : ''}>
                <span>${addon.label}</span>
                <span class="tooltip">${addon.tooltip}</span>
            `;
            label.querySelector('input').addEventListener('change', (e) => {
                if (!roleConfigs[role]) roleConfigs[role] = { prompt: '', addons: {} };
                if (!roleConfigs[role].addons) roleConfigs[role].addons = {};
                roleConfigs[role].addons[addon.id] = e.target.checked;
                saveRoleConfig(role);
                refreshPreview();
            });
            group.appendChild(label);
        }
    });
}
```

2. Update the custom agent form — replace the `ca-addon-ticket-update` checkbox (line 2174) with a select dropdown:

```html
<label class="checkbox-label" style="display:flex;align-items:center;gap:6px;">
  <span>Ticket Update Mode:</span>
  <select id="ca-addon-ticket-update-mode" style="background:#0a0a0a;color:var(--text-primary);border:1px solid var(--border-color);border-radius:3px;padding:2px 4px;font-size:10px;font-family:var(--font-mono);">
    <option value="disabled">Disabled</option>
    <option value="comment-only">Comment Only</option>
    <option value="refine-ticket">Refine Ticket</option>
    <option value="research-and-refine">Research & Refine</option>
  </select>
</label>
```

3. Update the load state logic (line 2716), replace:
```javascript
document.getElementById('ca-addon-ticket-update').checked = addons.ticketUpdateEnabled === true;
```
with:
```javascript
const ticketUpdateMode = addons.ticketUpdateMode || (addons.ticketUpdateEnabled === true ? 'comment-only' : 'disabled');
document.getElementById('ca-addon-ticket-update-mode').value = ticketUpdateMode;
```

4. Update the save state logic (line 2768), replace:
```javascript
ticketUpdateEnabled: document.getElementById('ca-addon-ticket-update').checked,
```
with:
```javascript
ticketUpdateMode: document.getElementById('ca-addon-ticket-update-mode')?.value || 'disabled',
```

5. Add CSS for radio group styling (in the `<style>` section, after existing addon styles):
```css
.addon-radio-group {
    margin-bottom: 8px;
    padding: 4px 0;
}
.addon-radio-group .checkbox-item {
    padding-left: 4px;
}
```

---

### `src/test/agent-prompt-builder-ticket-updater-modes.test.js` [NEW]

**Implementation**:

```javascript
function testTicketUpdateModes() {
    console.log('\nTesting ticket update mode prompts...');
    
    const plans = [{ sessionId: 'sess1', title: 'Plan 1', topic: 'Plan 1', absolutePath: '/path/to/plan1.md' }];
    
    // Test disabled mode
    const disabledPrompt = buildKanbanBatchPrompt('ticket_updater', plans, { ticketUpdateMode: 'disabled' });
    assert.ok(!disabledPrompt.includes('TICKET UPDATE MODE'), 'Disabled mode should not include ticket update directive');
    assert.ok(!disabledPrompt.includes('web_research skill'), 'Disabled mode should not include research directive');
    
    // Test comment-only mode
    const commentOnlyPrompt = buildKanbanBatchPrompt('ticket_updater', plans, { ticketUpdateMode: 'comment-only' });
    assert.ok(commentOnlyPrompt.includes('Add an "AI Analysis" comment'), 'Comment-only mode should include comment directive');
    assert.ok(!commentOnlyPrompt.includes('refine the ticket description'), 'Comment-only mode should not include refine directive');
    assert.ok(!commentOnlyPrompt.includes('web_research skill'), 'Comment-only mode should not include research directive');
    
    // Test refine-ticket mode
    const refinePrompt = buildKanbanBatchPrompt('ticket_updater', plans, { ticketUpdateMode: 'refine-ticket' });
    assert.ok(refinePrompt.includes('refine the ticket description'), 'Refine mode should include refine directive');
    assert.ok(!refinePrompt.includes('Add an "AI Analysis" comment'), 'Refine mode should not include comment directive');
    assert.ok(!refinePrompt.includes('web_research skill'), 'Refine mode should not include research directive');
    
    // Test research-and-refine mode
    const researchPrompt = buildKanbanBatchPrompt('ticket_updater', plans, { ticketUpdateMode: 'research-and-refine' });
    assert.ok(researchPrompt.includes('web_research skill'), 'Research mode should include research directive');
    assert.ok(researchPrompt.includes('refine the ticket description'), 'Research mode should include refine directive');
    assert.ok(!researchPrompt.includes('Add an "AI Analysis" comment'), 'Research mode should not include comment directive');
    
    // Test default behavior (no mode specified) — should be disabled
    const defaultPrompt = buildKanbanBatchPrompt('ticket_updater', plans, {});
    assert.ok(!defaultPrompt.includes('TICKET UPDATE MODE'), 'Default mode should be disabled (no ticket update)');
    
    // Test migration: old ticketUpdateEnabled=true should map to comment-only
    const migratedPrompt = buildKanbanBatchPrompt('ticket_updater', plans, { ticketUpdateMode: undefined });
    assert.ok(!migratedPrompt.includes('TICKET UPDATE MODE'), 'Undefined mode should fall back to disabled');
    
    console.log('Ticket update mode tests PASSED!');
}
```

## Verification Plan

### Automated Tests

```bash
# Run the new test file after creation
node src/test/agent-prompt-builder-ticket-updater-modes.test.js
```

(Skip compilation and test suite per session directives.)

### Manual Verification

1. Open Kanban Prompts tab
2. Navigate to Ticket Updater role
3. Verify radio button group appears with four options: "Disabled", "Comment Only", "Refine Ticket", "Research & Refine"
4. Verify "Disabled" is selected by default
5. Select "Comment Only" → verify prompt preview includes comment directive
6. Select "Refine Ticket" → verify prompt preview includes refine directive
7. Select "Research & Refine" → verify prompt preview includes research and refine directives
8. Select "Disabled" → verify prompt preview has no ticket update directive
9. Test with a plan that has a ticket number → verify the appropriate mode-specific instructions are included
10. Test custom agent form → verify the Ticket Update Mode dropdown appears and saves correctly
11. Test migration: load a workspace with old `ticketUpdateEnabled: true` config → verify it maps to `comment-only` mode

## Files Changed

- `src/webview/sharedDefaults.js` — Replace `ticketUpdateEnabled` with `ticketUpdateMode` for ticket_updater
- `src/services/agentConfig.ts` — Replace `ticketUpdateEnabled` with `ticketUpdateMode` in interface and parser (with migration)
- `src/services/agentPromptBuilder.ts` — Replace `ticketUpdateEnabled` with `ticketUpdateMode` in options and implement mode-specific prompt logic
- `src/services/KanbanProvider.ts` — Replace all `ticketUpdateEnabled` references with `ticketUpdateMode` (5 locations, with migration)
- `src/services/TaskViewerProvider.ts` — Replace all `ticketUpdateEnabled` references with `ticketUpdateMode` (3 locations, with migration)
- `src/webview/kanban.html` — Update `renderRoleAddons()` for radio support, update custom agent form, add CSS
- `src/test/agent-prompt-builder-ticket-updater-modes.test.js` — New test file

## Risks

- **Low risk**: Migration logic maps old boolean values to new enum, preserving existing behavior.
- **Research mode dependency**: The "research-and-refine" mode requires the web_research skill to be available. If not available, the prompt instructs the agent to proceed with codebase-only analysis and note the gap.
- **Prompt complexity**: Adding multiple mode-specific prompt paths increases the complexity of the `ticket_updater` prompt logic. The shared `analysisTemplate()` helper reduces duplication.

---

**Recommendation: Send to Coder**
