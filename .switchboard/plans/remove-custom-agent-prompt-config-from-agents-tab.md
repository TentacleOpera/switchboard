# Remove Prompt Config from Custom Agent Form in Agents Tab

## Goal

Remove the **Prompt instructions** textarea and the **Prompt Add-ons** section from the custom agent creation/editing form in the AGENTS tab. Replace both with a single redirect message pointing users to the PROMPTS tab. The PROMPTS tab's `renderRoleAddons` and `promptPreview` are the correct home for this configuration — having it in two places creates confusion and a dual source of truth.

### Problem Analysis

The custom agent form in the AGENTS tab currently has three sections:
1. **Identity** (name, startup command) — correct location, keep
2. **Prompt instructions** textarea — sets `promptInstructions` on the agent object, appended as "Additional Instructions: [text]" at the end of the built prompt
3. **Prompt Add-ons** — 12+ checkboxes and a subagent policy radio group that duplicate the PROMPTS tab `renderRoleAddons` functionality

Section 3 is a full duplicate. The PROMPTS tab already shows custom agents in the role dropdown and runs `renderRoleAddons` for them, which reads from `roleConfigs[role].addons`. The AGENTS tab addons are stored separately on the agent object and merged in `KanbanProvider.ts` with PROMPTS tab values (PROMPTS tab wins conflicts).

Section 2 is not yet duplicated in the PROMPTS tab — the `promptPreview` textarea is the full built prompt, not a standalone instructions field. **Before Section 2 is removed, the implementation must wire `roleConfigs[role].prompt` into `buildCustomAgentPrompt` as the replacement.**

The correct end state: AGENTS tab handles identity only; PROMPTS tab handles all prompt behaviour.

## Metadata

- **Complexity:** 4
- **Tags:** frontend, refactor, ui

## User Review Required

Yes — this is a deletion of UI surface. The `promptInstructions` field has a backend implication (see Problem Analysis) that must be reviewed before implementation. Additionally, the silent data-loss risk on agent edit (see Edge-Case Audit) needs explicit sign-off.

## Complexity Audit

### Routine
- Removing HTML for `#agents-tab-custom-agent-prompt` label + textarea (lines 2514-2515)
- Removing HTML for the entire `#agents-tab-custom-agent-addons` div and contents (lines 2516-2572)
- Adding a redirect message in their place
- Removing the corresponding JS load block entries (lines 3236-3266)
- Removing the `promptInstructions` and `addons` keys from the save block (lines 3294, 3298-3316)
- Removing the `ca-subagent-policy` radio listener + custom name input listener (lines 8509-8527)
- Updating `CustomAgentConfig.promptInstructions` from required to optional in `agentConfig.ts`

### Complex / Risky
- **`promptInstructions` backward compatibility**: `buildCustomAgentPrompt` in `agentPromptBuilder.ts` (line 1287) appends `promptInstructions` to the custom agent prompt. After removal from the AGENTS tab, new agents will have an empty/undefined `promptInstructions`. Existing agents retain their stored value. **The implementation must wire the PROMPTS tab prompt template into `buildCustomAgentPrompt` as the replacement before this deletion is complete**, otherwise new custom agents lose the ability to add custom instructions entirely.
- **Addons merge**: `KanbanProvider.ts` lines 2395-2399 merges AGENTS tab `agentConfig.addons` with PROMPTS tab `roleConfigAddons`, with PROMPTS tab winning. After removal, only PROMPTS tab addons remain. Existing saved `agentConfig.addons` values on old agents will persist in storage but be meaningless once removed from the form — they are overridden by PROMPTS tab values anyway, so this is safe.
- **Silent data loss on agent edit**: When a user edits an existing agent and saves, the new save block omits `addons` and `promptInstructions`. This effectively deletes those fields from the stored agent config. Must preserve existing values from the loaded agent object on save (see Step 3 mitigation).

## Edge-Case & Dependency Audit

- **Race Conditions**: None — form save is synchronous, no async conflict.
- **Security**: No secrets or auth tokens involved in removed fields.
- **Side Effects**: 
  - Editing an existing agent and saving will strip `addons`/`promptInstructions` unless explicitly preserved (see Complex/Risky above).
  - `parseCustomAgents` in `agentConfig.ts` (line 236) still reads `promptInstructions` from stored data — this is correct for backward compat and should NOT be changed.
  - `parseCustomAgentAddons` in `agentConfig.ts` (lines 149-201) still parses stored `addons` — same, keep for backward compat.
- **Dependencies & Conflicts**: Step 0 (wire PROMPTS tab prompt into `buildCustomAgentPrompt`) MUST be implemented before Steps 1-4. Without it, new custom agents have no way to inject custom instructions into their prompts.

## Dependencies

- Step 0 prerequisite: PROMPTS tab `roleConfigs[role].prompt` must be wired into `buildCustomAgentPrompt` before AGENTS tab UI removal.

## Adversarial Synthesis

Key risks: silent data loss on agent edit (omitting `addons`/`promptInstructions` from save block deletes existing config), incomplete listener deletion (lines 8509-8527 not just 8509-8513), stale KanbanProvider.ts line numbers. Mitigations: preserve existing agent fields on save, extend listener deletion to full range, correct all line numbers to verified values.

## Requirements

### Functional

1. Remove `<label>Prompt instructions</label>` and `<textarea id="agents-tab-custom-agent-prompt">` from the custom agent form.
2. Remove `<div id="agents-tab-custom-agent-addons">` and all its contents from the custom agent form.
3. Add a redirect notice in place of the removed sections: `"Configure prompt add-ons and custom instructions in the PROMPTS tab after saving this agent."`
4. Remove all JS that reads from or writes to the removed elements in the load and save blocks.
5. Remove the `ca-subagent-policy` radio listener and the `ca-addon-custom-subagent-name` input listener.
6. The PROMPTS tab must accept custom instructions for custom agents before this plan is implemented (see Step 0 below).
7. Preserve existing `addons` and `promptInstructions` from loaded agent on save to prevent silent data loss.

### Non-Functional

- Existing agents' stored `addons` and `promptInstructions` are left in their saved state — no data deletion.
- The backend `buildCustomAgentPrompt` call continues to read `agentConfig?.promptInstructions` for backward compatibility with existing agents.
- `parseCustomAgents` and `parseCustomAgentAddons` in `agentConfig.ts` remain unchanged — they handle stored data correctly.

## Implementation Plan

### Step 0: Wire custom agent instructions into PROMPTS tab (prerequisite)

**File**: `src/services/KanbanProvider.ts`

At lines 2405-2410, the current call is:
```ts
return buildCustomAgentPrompt(
    plans,
    agentConfig?.promptInstructions,
    mergedAddons,
    workspaceRoot
);
```

Replace with:
```ts
const promptTab = this._getRoleConfig(role)?.prompt?.trim() || '';
const instructions = promptTab || agentConfig?.promptInstructions || '';
return buildCustomAgentPrompt(
    plans,
    instructions || undefined,
    mergedAddons,
    workspaceRoot
);
```

This means the PROMPTS tab template takes precedence for new agents, while legacy agents with only `agentConfig.promptInstructions` continue to work.

**File**: `src/services/agentConfig.ts`

At line 44, change `promptInstructions: string;` to `promptInstructions?: string;` to reflect that new agents may not have this field.

### Step 1: Remove HTML from custom agent form

**File**: `src/webview/kanban.html`

Delete lines 2514-2572:
- Line 2514: `<label class="modal-label" for="agents-tab-custom-agent-prompt">Prompt instructions</label>`
- Line 2515: `<textarea id="agents-tab-custom-agent-prompt" ...></textarea>`
- Lines 2516-2572: `<div id="agents-tab-custom-agent-addons" ...>` and all its contents (the 12 `ca-addon-*` checkboxes, the Ticket Update Mode select, the Subagent Policy radio group, the Design Doc checkbox, the custom subagent name input)

Add in their place:
```html
<p style="font-size:10px; color:var(--text-secondary); margin-top:8px; line-height:1.4;">
  Configure prompt add-ons and custom instructions in the <strong>PROMPTS</strong> tab after saving this agent.
</p>
```

### Step 2: Remove JS load block entries

**File**: `src/webview/kanban.html`

Delete lines 3236-3266:
- Line 3236: `document.getElementById('agents-tab-custom-agent-prompt').value = agent?.promptInstructions || '';`
- Lines 3238-3254: All `document.getElementById('ca-addon-*').checked = ...` lines and ticket update mode load
- Lines 3256-3266: The `subagentPolicy` radio load block and `customSubagentName` input load/display

### Step 3: Remove JS save block entries (with data preservation)

**File**: `src/webview/kanban.html`

In the `nextAgent` construction (lines 3289-3317):

**Delete** line 3294:
```js
promptInstructions: document.getElementById('agents-tab-custom-agent-prompt').value.trim(),
```

**Delete** lines 3298-3316 (the entire `addons: { ... }` object).

**Add** data preservation — after the `nextAgent` object, merge existing agent's `addons` and `promptInstructions` if editing:
```js
const nextAgent = {
    id: newId,
    role,
    name,
    startupCommand,
    includeInKanban: false,
    kanbanOrder: 0,
    dragDropMode: 'cli',
};
// Preserve existing agent's prompt config (backward compat)
if (agentsTabEditingAgentId) {
    const existing = agentsTabCustomAgents.find(a => a.id === agentsTabEditingAgentId);
    if (existing) {
        if (existing.promptInstructions) nextAgent.promptInstructions = existing.promptInstructions;
        if (existing.addons) nextAgent.addons = existing.addons;
    }
}
```

This ensures editing an existing agent does not silently delete its stored prompt config. New agents get a clean object with no `promptInstructions` or `addons`.

### Step 4: Remove the `ca-subagent-policy` radio listener and custom name input listener

**File**: `src/webview/kanban.html`

Delete lines 8509-8527 — the full listener block:
- Lines 8509-8522: `ca-subagent-policy` radio change listeners that toggle `ca-addon-custom-subagent-name` visibility
- Lines 8524-8526: `customNameInput.addEventListener('input', ...)` that sanitizes the custom subagent name input

### Step 5: Verify

1. Add a new custom agent — form should show only name and startup command fields plus the redirect message.
2. Save the agent. Select it in the PROMPTS tab. Verify add-ons are available there via `renderRoleAddons`.
3. Enter custom instructions in the PROMPTS tab and copy a prompt for a plan assigned to that agent. Verify the instructions appear in the prompt output.
4. Check that an existing agent (with previously saved `promptInstructions`) still includes those instructions in prompt output — backward compatibility via Step 0 fallback.
5. Edit an existing agent (change name only), save, then check that its stored `addons` and `promptInstructions` are preserved in the saved data.

## Proposed Changes

### `src/webview/kanban.html`
- **Delete** (Step 1): Lines 2514-2572 — `#agents-tab-custom-agent-prompt` label + textarea; `#agents-tab-custom-agent-addons` div and all contents (~59 lines of HTML)
- **Add** (Step 1): One-line redirect notice in place of removed sections
- **Delete** (Step 2): Lines 3236-3266 — load block entries for all removed elements (~31 lines)
- **Delete** (Step 3): Line 3294 (`promptInstructions`) and lines 3298-3316 (`addons` object) from save block (~20 lines)
- **Add** (Step 3): Data preservation block — merge existing agent's `addons`/`promptInstructions` on edit
- **Delete** (Step 4): Lines 8509-8527 — `ca-subagent-policy` radio listener + `ca-addon-custom-subagent-name` input listener (~19 lines)

### `src/services/KanbanProvider.ts`
- **Change** (Step 0): Lines 2405-2410 — Map PROMPTS tab `roleConfigs[role].prompt` into `buildCustomAgentPrompt` as the `promptInstructions` argument, with fallback to legacy `agentConfig.promptInstructions`

### `src/services/agentConfig.ts`
- **Change** (Step 0): Line 44 — Change `promptInstructions: string;` to `promptInstructions?: string;`

## Verification Plan

### Automated Tests
- Skip automated tests per session directive. Manual verification via Step 5 checklist above.

## Acceptance Criteria

- [ ] Custom agent form shows only: name field, startup command field, redirect message, Save/Cancel buttons
- [ ] No `ca-addon-*` elements exist in the DOM after the change
- [ ] Saving a new agent does not include `addons` or `promptInstructions` in the saved object
- [ ] Editing and saving an existing agent preserves its stored `addons` and `promptInstructions`
- [ ] Selecting a custom agent in PROMPTS tab shows add-ons via `renderRoleAddons`
- [ ] Instructions entered in PROMPTS tab appear in the built prompt for that custom agent
- [ ] Existing agents with legacy `promptInstructions` still have those instructions appear in their prompts
- [ ] No runtime errors from orphaned event listeners referencing deleted DOM elements

**Recommendation**: Complexity 4 → Send to Coder
