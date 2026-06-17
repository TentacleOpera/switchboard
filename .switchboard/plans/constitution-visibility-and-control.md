# Constitution Visibility and Control

## Goal

Add UI visibility and user control for the automatic constitution injection feature in Switchboard's planning workflow. Currently, constitutions are automatically injected into planner prompts with no user-facing indication or control mechanism. This should follow the existing "Planning Epic Reference" addon pattern.

## Metadata

**Complexity:** 6

**Tags:** ui, feature, ux

## User Review Required

- [ ] Confirm checkbox label "Project Constitution Reference"
- [ ] Confirm constitution status display in meta bar

## Complexity Audit

### Routine
- Adding checkbox HTML to `kanban.html`
- Adding default config flag to `sharedDefaults.js`
- Adding constitution injection to `buildCustomAgentPrompt`

### Complex / Risky
- Conditional resolution gating in `KanbanProvider.ts` (planner + custom agents)
- `project.js` meta bar status requires message-passing to extension host (no Node APIs in webview)
- Syncing checkbox state across `kanban.html`, `sharedDefaults.js`, and `ROLE_ADDONS`

## Current State

Constitution injection works automatically in the backend:
- `KanbanProvider.ts` resolves `CONSTITUTION.md` from workspace root when generating planner prompts
- `agentPromptBuilder.ts` injects constitution content into planner prompts with "PROJECT CONSTITUTION" header
- Constitution tab in `project.html` allows viewing/editing constitution files
- No UI indication that constitution is being used
- No way to control constitution injection (unlike Planning Epic Reference which has a checkbox)
- Constitution is not integrated into the addon system used by other planner context documents

## Problem Analysis

Users cannot see or control whether constitutions are being used in their planning workflow. This creates confusion because:
1. The constitution tab exists but its purpose in the planning workflow is unclear
2. There's no checkbox to enable/disable constitution injection (unlike Planning Epic Reference)
3. The constitution doesn't follow the established addon pattern used by other context documents
4. Users cannot verify that the correct constitution is being used
5. The prompt preview doesn't show constitution content, making it invisible during debugging

## Plan Corrections & Clarifications

> **Clarification**: The following corrections fix inaccuracies in the original code snippets and line references.

1. **Missing `ROLE_ADDONS` entry**: `sharedDefaults.js` `ROLE_ADDONS.planner` array must include `{ id: 'constitution', label: 'Project Constitution Reference', tooltip: 'Include project constitution as context for planning', default: false }` or the Prompts tab will not render the addon.
2. **Phase 1.3 sync logic**: Actual `kanban.html` uses an `addonIdMap` object (`{ 'plannerAddonPlanningEpic': 'designDoc', ... }`). Add `'plannerAddonConstitution': 'constitution'` to that map instead of the ternary chain shown.
3. **Phase 2.1 wrong file**: The snippet referencing line 2462 belongs in `KanbanProvider.ts` custom agent block, not `agentPromptBuilder.ts`. Remove the duplicate/wrong-file step.
4. **`constitutionEnabled` missing from interface**: `PromptBuilderOptions` in `agentPromptBuilder.ts` does not have `constitutionEnabled`. Gating resolution in `KanbanProvider.ts` is sufficient; the prompt builder already checks `options?.constitutionContent`.
5. **Phase 4.2 `project.js` uses Node APIs**: `fs.existsSync` and `path.join` are unavailable in the webview sandbox. The meta bar must request status via `vscode.postMessage` and the extension host (`KanbanProvider.ts`) must respond with constitution status.

## Implementation Plan

### Phase 1: Add Constitution to Planner Addon System

#### 1.1 Add Constitution Checkbox to kanban.html

**File**: `src/webview/kanban.html`

**Changes**:
- Add checkbox in the planner addons section (near "Planning Epic Reference")
- Follow the existing pattern for `plannerAddonPlanningEpic`
- Label: "Project Constitution Reference"
- Tooltip: "Include project constitution as context for planning"

**HTML structure** (add after line 2514):
```html
<label class="checkbox-item" title="Include project constitution as context for planning">
  <input type="checkbox" id="plannerAddonConstitution">
  <span>Project Constitution Reference</span>
  <span class="tooltip">Include project constitution as context</span>
</label>
```

#### 1.2 Add Constitution to sharedDefaults.js

**File**: `src/webview/sharedDefaults.js`

**Changes**:
- Add `constitution: false` to the addons object in default config
- Follow the existing pattern for `designDoc`

**Implementation**:
```javascript
addons: { switchboardSafeguards: true, designDoc: false, constitution: false, aggressivePairProgramming: false, ... }
```

#### 1.3 Add Constitution to Checkbox Sync Logic

**File**: `src/webview/kanban.html` (JavaScript section)

**Changes**:
- Add `plannerAddonConstitution` to the checkbox sync array
- Map it to `constitution` in the addons object

**Implementation** (update around line 3644):
Add `'plannerAddonConstitution': 'constitution'` to the `addonIdMap` object inside the existing listener, and add `'plannerAddonConstitution'` to the `forEach` array:

```javascript
['plannerAddonSwitchboardSafeguards', 'plannerAddonPlanningEpic', 'plannerAddonConstitution', 'plannerAddonDesignSystemDoc', ...].forEach(id => {
    // ...
    const addonIdMap = {
        'plannerAddonPlanningEpic': 'designDoc',
        'plannerAddonDesignSystemDoc': 'designSystemDoc',
        'plannerAddonConstitution': 'constitution'
    };
    // ...
```

#### 1.4 Add Constitution Checkbox Initialization

**File**: `src/webview/kanban.html` (JavaScript section)

**Changes**:
- Add checkbox initialization in the config loading section
- Follow the pattern for `plannerAddonPlanningEpic`

**Implementation** (add after line 2908):
```javascript
document.getElementById('plannerAddonConstitution').checked = !!config.addons?.constitution;
```

### Phase 2: Add Constitution to Prompt Builder

#### 2.1 Add Constitution to Custom Agent Addons

**File**: `src/services/KanbanProvider.ts`

**Changes**:
- Add constitution resolution for custom agents
- Follow the pattern for designDoc

**Implementation** (add after line 2470, inside the `custom_agent_` block):
```typescript
if (mergedAddons.constitution) {
    const { constitutionLink, constitutionContent } = await this._resolveConstitution(workspaceRoot);
    mergedAddons.constitutionLink = constitutionLink;
    mergedAddons.constitutionContent = constitutionContent;
}
```

#### 2.2 Add Constitution to Planner Config Resolution

**File**: `src/services/KanbanProvider.ts`

**Changes**:
- Add `constitutionEnabled: plannerConfig?.addons?.constitution ?? false` to resolved options
- Follow the pattern for `designDocEnabled`

**Implementation** (add after line 2633 in `_getPromptsConfig`):
```typescript
constitutionEnabled: plannerConfig?.addons?.constitution ?? config.get<boolean>('planner.constitutionEnabled', false),
```

#### 2.3 Update Constitution Resolution to Use Addon Flag

**File**: `src/services/KanbanProvider.ts`

**Changes**:
- Modify `_resolveConstitution` to accept an enabled flag
- Return empty if not enabled
- Update call sites to pass the flag

**Implementation**:
```typescript
private async _resolveConstitution(workspaceRoot: string, enabled: boolean = true): Promise<{ constitutionLink?: string; constitutionContent?: string }> {
    if (!enabled) return {};
    const filePath = path.join(workspaceRoot, 'CONSTITUTION.md');
    if (fs.existsSync(filePath)) {
        try {
            const constitutionContent = await fs.promises.readFile(filePath, 'utf8');
            return { constitutionLink: filePath, constitutionContent };
        } catch { /* non-fatal */ }
    }
    return {};
}
```

**Update call site** (line 2514):
```typescript
const { constitutionLink, constitutionContent } = await this._resolveConstitution(workspaceRoot, resolvedOptions.constitutionEnabled);
```

### Phase 3: Add Constitution to Addon Prompt Injection

#### 3.1 Add Constitution to Custom Agent Prompt Builder

**File**: `src/services/agentPromptBuilder.ts`

**Changes**:
- Add constitution injection in `buildCustomAgentPrompt`
- Follow the pattern for designDoc

**Implementation** (add after the designSystemDoc block, around line 1339):
```typescript
if (addons?.constitutionContent) {
    prompt += `\n\nPROJECT CONSTITUTION (pre-fetched):\n${addons.constitutionContent}`;
} else if (addons?.constitutionLink) {
    prompt += `\n\nPROJECT CONSTITUTION:\n${addons.constitutionLink}`;
}
```

### Phase 4: Add Constitution Status to UI

#### 4.1 Add Constitution Status to Plan Meta Bar

**File**: `src/webview/project.html`

**Changes**:
- Add constitution status indicator in `#kanban-preview-meta-bar`
- Show "Constitution: [file path]" if enabled and exists
- Show "Constitution: Disabled" if checkbox unchecked
- Show "Constitution: None" if no file exists

**HTML structure**:
```html
<div class="kanban-meta-group">
    <span class="kanban-meta-label">Constitution:</span>
    <span class="kanban-meta-value" id="kanban-meta-constitution">Loading...</span>
</div>
```

#### 4.2 Update Meta Bar Rendering with Constitution Status

**File**: `src/webview/project.js`

**Changes**:
- In `renderKanbanMetaBar(plan)`, add constitution status
- Check planner config for constitution addon flag
- Check if constitution file exists
- Display appropriate status

**Implementation**:
In `renderKanbanMetaBar(plan)`, add the constitution status element to the HTML template:

```javascript
metaBar.innerHTML = `
    // ... existing meta groups ...
    <div class="kanban-meta-group">
        <span class="kanban-meta-label">Constitution:</span>
        <span class="kanban-meta-value" id="kanban-meta-constitution">Loading...</span>
    </div>
    // ...
`;

// Request constitution status from extension host (no fs/path in webview)
vscode.postMessage({
    type: 'getConstitutionStatus',
    workspaceRoot: plan.workspaceRoot,
    planFile: plan.planFile
});
```

**Extension host handler** (add to `KanbanProvider.ts` message handler):
```typescript
case 'getConstitutionStatus': {
    const wr = this._resolveWorkspaceRoot(msg.workspaceRoot);
    if (!wr) break;
    const filePath = path.join(wr, 'CONSTITUTION.md');
    const exists = fs.existsSync(filePath);
    const config = await this._getPromptsConfig(wr);
    const enabled = config.constitutionEnabled ?? false;
    let status = 'None';
    if (enabled && exists) { status = 'CONSTITUTION.md'; }
    else if (enabled) { status = 'File not found'; }
    else { status = 'Disabled'; }
    this._panel?.webview.postMessage({ type: 'constitutionStatus', status, planFile: msg.planFile });
    break;
}
```

**project.js message handler**:
```javascript
case 'constitutionStatus':
    const el = document.getElementById('kanban-meta-constitution');
    if (el) el.textContent = msg.status;
    break;
```

#### 4.3 Add Constitution to Prompt Preview

**File**: `src/services/PlanningPanelProvider.ts`

**Changes**:
- When sending prompt preview data, include constitution section if enabled
- Add constitution content to preview data

### Phase 5: Add Help/Documentation

#### 5.1 Add Constitution Help Text

**File**: `src/webview/kanban.html`

**Changes**:
- Ensure tooltip text is clear: "Include project constitution as context for planning"
- Constitution defines inviolate rules and invariants for the project

#### 5.2 Update Constitution Tab Description

**File**: `src/webview/project.html`

**Changes**:
- Add descriptive text in constitution tab explaining its purpose
- Show: "Enable 'Project Constitution Reference' in the planner addons to inject this constitution into planning prompts"
- Link to the planner configuration

## Edge-Case & Dependency Audit

### Race Conditions
- Constitution file deleted between meta bar status request and prompt generation: status shows "File not found" but prompt builder will also see missing file and skip injection. Consistent behavior.
- Config saved while prompt preview is being generated: prompt preview uses snapshot of config at generation time; next refresh picks up new state.

### Security
- No new security risks. Constitution file is read from workspace root (trusted path). No user input is executed.
- Message handler `getConstitutionStatus` validates workspace root against allowed roots before checking filesystem.

### Side Effects
- Reading `CONSTITUTION.md` from disk on every prompt generation. File is small (typically < 5KB) and read is async, but custom agents + planner both trigger reads. No caching layer exists yet.
- `constitutionEnabled` config key added to VS Code settings scope.

### Dependencies & Conflicts
- Depends on existing `_resolveConstitution` in `KanbanProvider.ts` (must remain backward-compatible)
- `ROLE_ADDONS` in `sharedDefaults.js` must be kept in sync with `kanban.html` checkbox IDs and `DEFAULT_ROLE_CONFIG`
- No breaking changes to existing prompt format (constitution section already exists in `agentPromptBuilder.ts`)

## Dependencies

None — self-contained feature with no external session dependencies.

## Adversarial Synthesis

Key risks: (1) `ROLE_ADDONS` desync between `sharedDefaults.js` and `kanban.html` will silently hide the checkbox; (2) `project.js` meta bar implementation without extension-host message-passing will throw runtime errors due to missing Node APIs; (3) `_resolveConstitution` currently reads from disk unconditionally — gating it requires careful call-site updates in both planner and custom agent paths. Mitigations: code-search verify all `ROLE_ADDONS` references, use the message-passing pattern already used by other meta bar data, and update both `_getPromptsConfig` and custom agent merge blocks.

## Verification Plan

### Automated Tests
- SKIP COMPILATION per session directive
- SKIP TESTS per session directive
- Manual verification steps (per Testing Checklist below):
  - [ ] "Project Constitution Reference" checkbox appears in planner addons section
  - [ ] Checkbox state persists across webview reload
  - [ ] Checkbox state is saved to and loaded from config
  - [ ] When checked and constitution file exists, content is injected into planner prompts
  - [ ] When unchecked, constitution is not injected into planner prompts
  - [ ] Constitution status appears in plan meta bar (Enabled/Disabled/File not found/None)
  - [ ] Constitution status updates when checkbox is toggled
  - [ ] Constitution status updates when file is created/deleted
  - [ ] Constitution content appears in prompt preview when enabled
  - [ ] Constitution addon works for custom agents
  - [ ] Multi-workspace setups use correct constitution per workspace
  - [ ] Help tooltip text is clear and accurate
  - [ ] Constitution tab description references the planner addon checkbox

## Remaining Risks

1. **Config sync**: Need to ensure constitution addon state is correctly synced across all config loading paths (`_getPromptsConfig`, custom agent merge, `sharedDefaults.js`, `ROLE_ADDONS`)
2. **Performance**: Reading constitution file for every prompt generation may have performance impact (should be cached; out of scope for this plan)
3. **User confusion**: Users may not understand the difference between constitution tab and the addon checkbox
4. **Preview size**: Large constitutions may make prompt preview unwieldy

---

**Recommendation:** Send to Coder
