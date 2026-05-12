# Fix: Context Gatherer Visibility in Agents Tab and Setup Tab

## Goal

Fix two related bugs:
1. Context gatherer does not show in agents tab of kanban.html as a checkbox
2. Context gatherer shows up in setup tab of kanban.html as hidden even when not selected. Only selected agents in the agents tab should show up in the structure arrangement in the setup tab of kanban.html

## Metadata

**Tags:** bugfix, UI, frontend
**Complexity:** 4

## User Review Required

None. This is a bugfix restoring intended behavior. No breaking changes.

## Complexity Audit

### Routine
- Add gatherer to BUILT_IN_AGENT_LABELS constant in agentConfig.ts
- Add gatherer checkbox to agents tab HTML in kanban.html
- Update _buildSetupKanbanStructure to filter out unselected agents entirely

### Complex / Risky
- Changing visibility filtering logic in _buildSetupKanbanStructure could affect other columns
- Need to verify that the change doesn't break custom agents or custom columns

## Edge-Case & Dependency Audit

**Race Conditions:** None. This is a configuration and UI change, not a runtime race condition.

**Security:** None. This change only affects UI visibility state, not data access or permissions.

**Side Effects:**
- Users who have previously toggled gatherer visibility will have their preference overridden to match the new agents tab state
- The context gatherer column will be visible by default in the agents tab (checkbox checked)
- Users can still hide it by unchecking the checkbox in the agents tab
- The setup tab structure list will no longer show "Hidden" columns - only selected agents will appear

**Dependencies & Conflicts:**
- This fix relates to the previous bugfix in `bugfix_kanban_context_gatherer_visibility.md` which set `gatherer: false` in the defaults
- We need to change the default to `gatherer: true` to match the new agents tab checkbox state
- No known conflicts with other active plans based on manual review

## Dependencies

None

## Adversarial Synthesis

Key risks: The _buildSetupKanbanStructure filter removes unselected built-in agents entirely from the setup tab structure list, which may surprise users accustomed to re-enabling columns via a SHOW button there; they must now use the Agents tab checkboxes instead. Mitigations: The SHOW button was always redundant with the agents tab, and this change enforces a single source of truth for visibility. Ensure the gatherer checkbox appears alongside all other built-in agents so users discover the correct control surface.

## Proposed Changes

### Change 1: Add gatherer to BuiltInAgentRole type and BUILT_IN_AGENT_LABELS in agentConfig.ts

**File:** `/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/agentConfig.ts`

**Context:** The BuiltInAgentRole type (line 1) is the union of all built-in agent roles. It currently includes: lead, coder, intern, reviewer, tester, planner, analyst, ticket_updater, researcher, splitter - but NOT gatherer. The BUILT_IN_AGENT_LABELS constant (lines 70-81) is typed `Record<BuiltInAgentRole, string>`, so adding gatherer to the record without updating the type causes a TypeScript compilation error.

**Logic:**
1. Add `'gatherer'` to the BuiltInAgentRole union type on line 1
2. Add `'gatherer': 'Context Gatherer'` to the BUILT_IN_AGENT_LABELS constant
3. Also add `'gatherer'` to the `VALID_ROLES` array in `parseDefaultPromptOverrides` (line 356) so prompt overrides work for the gatherer role

**Implementation:**

Line 1 current:
```typescript
export type BuiltInAgentRole = 'lead' | 'coder' | 'intern' | 'reviewer' | 'tester' | 'planner' | 'analyst' | 'ticket_updater' | 'researcher' | 'splitter';
```

Line 1 fixed:
```typescript
export type BuiltInAgentRole = 'lead' | 'coder' | 'intern' | 'reviewer' | 'tester' | 'planner' | 'analyst' | 'ticket_updater' | 'researcher' | 'splitter' | 'gatherer';
```

Lines 70-81 current:
```typescript
export const BUILT_IN_AGENT_LABELS: Record<BuiltInAgentRole, string> = {
    lead: 'Lead Coder',
    coder: 'Coder',
    intern: 'Intern',
    reviewer: 'Reviewer',
    tester: 'Acceptance Tester',
    planner: 'Planner',
    'analyst': 'Analyst',
    'ticket_updater': 'Ticket Updater',
    'researcher': 'Researcher',
    'splitter': 'Splitter Agent'
};
```

Lines 70-81 fixed:
```typescript
export const BUILT_IN_AGENT_LABELS: Record<BuiltInAgentRole, string> = {
    lead: 'Lead Coder',
    coder: 'Coder',
    intern: 'Intern',
    reviewer: 'Reviewer',
    tester: 'Acceptance Tester',
    planner: 'Planner',
    'analyst': 'Analyst',
    'ticket_updater': 'Ticket Updater',
    'researcher': 'Researcher',
    'splitter': 'Splitter Agent',
    'gatherer': 'Context Gatherer'
};
```

Line 356 current:
```typescript
    const VALID_ROLES: BuiltInAgentRole[] = ['planner', 'lead', 'coder', 'reviewer', 'tester', 'intern', 'analyst', 'ticket_updater', 'researcher', 'splitter'];
```

Line 356 fixed:
```typescript
    const VALID_ROLES: BuiltInAgentRole[] = ['planner', 'lead', 'coder', 'reviewer', 'tester', 'intern', 'analyst', 'ticket_updater', 'researcher', 'splitter', 'gatherer'];
```

### Change 2: Add gatherer checkbox to agents tab in kanban.html

**File:** `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html`

**Context:** The agents tab (lines 2023-2041) has checkboxes for built-in agents. Currently includes: planner, lead, coder, intern, reviewer, tester, analyst, ticket_updater, researcher, splitter, jules - but NOT gatherer.

**Logic:**
1. Add a checkbox row for gatherer after the splitter row (line 2036) and before the jules row
2. Set the checkbox to checked by default to match the new default visibility
3. Use a span instead of a text input since gatherer uses disabled dragDropMode and has no startup command

**Implementation:**

Lines 2026-2037 current:
```html
<div class="startup-row"><input type="checkbox" class="agents-tab-visible-toggle" data-role="planner" checked style="width:auto;margin:0;flex-shrink:0;"><label style="min-width:70px;">Planner</label><input type="text" data-role="planner" id="agents-tab-cmd-planner" placeholder="e.g. gemini --approval-mode auto_edit" style="flex:1;"></div>
<div class="startup-row"><input type="checkbox" class="agents-tab-visible-toggle" data-role="lead" checked style="width:auto;margin:0;flex-shrink:0;"><label style="min-width:70px;">Lead Coder</label><input type="text" data-role="lead" id="agents-tab-cmd-lead" placeholder="e.g. copilot --allow-all-tools" style="flex:1;"></div>
<div class="startup-row"><input type="checkbox" class="agents-tab-visible-toggle" data-role="coder" checked style="width:auto;margin:0;flex-shrink:0;"><label style="min-width:70px;">Coder</label><input type="text" data-role="coder" id="agents-tab-cmd-coder" placeholder="e.g. gemini --approval-mode auto_edit" style="flex:1;"></div>
<div class="startup-row"><input type="checkbox" class="agents-tab-visible-toggle" data-role="intern" checked style="width:auto;margin:0;flex-shrink:0;"><label style="min-width:70px;">Intern</label><input type="text" data-role="intern" id="agents-tab-cmd-intern" placeholder="e.g. copilot --allow-all-tools" style="flex:1;"></div>
<div class="startup-row"><input type="checkbox" class="agents-tab-visible-toggle" data-role="reviewer" checked style="width:auto;margin:0;flex-shrink:0;"><label style="min-width:70px;">Reviewer</label><input type="text" data-role="reviewer" id="agents-tab-cmd-reviewer" placeholder="e.g. gemini --approval-mode auto_edit" style="flex:1;"></div>
<div class="startup-row"><input type="checkbox" class="agents-tab-visible-toggle" data-role="tester" style="width:auto;margin:0;flex-shrink:0;"><label style="min-width:70px;">Acceptance Tester</label><input type="text" data-role="tester" id="agents-tab-cmd-tester" placeholder="e.g. copilot --allow-all-tools" style="flex:1;"></div>
<div class="startup-row"><input type="checkbox" class="agents-tab-visible-toggle" data-role="analyst" checked style="width:auto;margin:0;flex-shrink:0;"><label style="min-width:70px;">Analyst</label><input type="text" data-role="analyst" id="agents-tab-cmd-analyst" placeholder="e.g. qwen" style="flex:1;"></div>
<div class="startup-row"><input type="checkbox" class="agents-tab-visible-toggle" data-role="ticket_updater" style="width:auto;margin:0;flex-shrink:0;"><label style="min-width:70px;">Ticket Updater</label><input type="text" data-role="ticket_updater" id="agents-tab-cmd-ticket-updater" placeholder="e.g. gemini" style="flex:1;"></div>
<div class="startup-row"><input type="checkbox" class="agents-tab-visible-toggle" data-role="researcher" style="width:auto;margin:0;flex-shrink:0;"><label style="min-width:70px;">Researcher</label><input type="text" data-role="researcher" id="agents-tab-cmd-researcher" placeholder="e.g. claude" style="flex:1;"></div>
<div class="startup-row"><input type="checkbox" class="agents-tab-visible-toggle" data-role="splitter" style="width:auto;margin:0;flex-shrink:0;"><label style="min-width:70px;">Splitter Agent</label><input type="text" data-role="splitter" id="agents-tab-cmd-splitter" placeholder="e.g. claude" style="flex:1;"></div>
<div class="startup-row"><input type="checkbox" class="agents-tab-visible-toggle" data-role="jules" checked style="width:auto;margin:0;flex-shrink:0;"><label style="min-width:70px;">Jules</label><span style="flex:1;font-size:10px;color:var(--text-secondary);">Cloud coder visibility only</span></div>
```

Lines 2026-2038 fixed (add gatherer row after splitter, before jules):
```html
<div class="startup-row"><input type="checkbox" class="agents-tab-visible-toggle" data-role="planner" checked style="width:auto;margin:0;flex-shrink:0;"><label style="min-width:70px;">Planner</label><input type="text" data-role="planner" id="agents-tab-cmd-planner" placeholder="e.g. gemini --approval-mode auto_edit" style="flex:1;"></div>
<div class="startup-row"><input type="checkbox" class="agents-tab-visible-toggle" data-role="lead" checked style="width:auto;margin:0;flex-shrink:0;"><label style="min-width:70px;">Lead Coder</label><input type="text" data-role="lead" id="agents-tab-cmd-lead" placeholder="e.g. copilot --allow-all-tools" style="flex:1;"></div>
<div class="startup-row"><input type="checkbox" class="agents-tab-visible-toggle" data-role="coder" checked style="width:auto;margin:0;flex-shrink:0;"><label style="min-width:70px;">Coder</label><input type="text" data-role="coder" id="agents-tab-cmd-coder" placeholder="e.g. gemini --approval-mode auto_edit" style="flex:1;"></div>
<div class="startup-row"><input type="checkbox" class="agents-tab-visible-toggle" data-role="intern" checked style="width:auto;margin:0;flex-shrink:0;"><label style="min-width:70px;">Intern</label><input type="text" data-role="intern" id="agents-tab-cmd-intern" placeholder="e.g. copilot --allow-all-tools" style="flex:1;"></div>
<div class="startup-row"><input type="checkbox" class="agents-tab-visible-toggle" data-role="reviewer" checked style="width:auto;margin:0;flex-shrink:0;"><label style="min-width:70px;">Reviewer</label><input type="text" data-role="reviewer" id="agents-tab-cmd-reviewer" placeholder="e.g. gemini --approval-mode auto_edit" style="flex:1;"></div>
<div class="startup-row"><input type="checkbox" class="agents-tab-visible-toggle" data-role="tester" style="width:auto;margin:0;flex-shrink:0;"><label style="min-width:70px;">Acceptance Tester</label><input type="text" data-role="tester" id="agents-tab-cmd-tester" placeholder="e.g. copilot --allow-all-tools" style="flex:1;"></div>
<div class="startup-row"><input type="checkbox" class="agents-tab-visible-toggle" data-role="analyst" checked style="width:auto;margin:0;flex-shrink:0;"><label style="min-width:70px;">Analyst</label><input type="text" data-role="analyst" id="agents-tab-cmd-analyst" placeholder="e.g. qwen" style="flex:1;"></div>
<div class="startup-row"><input type="checkbox" class="agents-tab-visible-toggle" data-role="ticket_updater" style="width:auto;margin:0;flex-shrink:0;"><label style="min-width:70px;">Ticket Updater</label><input type="text" data-role="ticket_updater" id="agents-tab-cmd-ticket-updater" placeholder="e.g. gemini" style="flex:1;"></div>
<div class="startup-row"><input type="checkbox" class="agents-tab-visible-toggle" data-role="researcher" style="width:auto;margin:0;flex-shrink:0;"><label style="min-width:70px;">Researcher</label><input type="text" data-role="researcher" id="agents-tab-cmd-researcher" placeholder="e.g. claude" style="flex:1;"></div>
<div class="startup-row"><input type="checkbox" class="agents-tab-visible-toggle" data-role="splitter" style="width:auto;margin:0;flex-shrink:0;"><label style="min-width:70px;">Splitter Agent</label><input type="text" data-role="splitter" id="agents-tab-cmd-splitter" placeholder="e.g. claude" style="flex:1;"></div>
<div class="startup-row"><input type="checkbox" class="agents-tab-visible-toggle" data-role="gatherer" checked style="width:auto;margin:0;flex-shrink:0;"><label style="min-width:70px;">Context Gatherer</label><span style="flex:1;font-size:10px;color:var(--text-secondary);">Clipboard context gathering only</span></div>
<div class="startup-row"><input type="checkbox" class="agents-tab-visible-toggle" data-role="jules" checked style="width:auto;margin:0;flex-shrink:0;"><label style="min-width:70px;">Jules</label><span style="flex:1;font-size:10px;color:var(--text-secondary);">Cloud coder visibility only</span></div>
```

### Change 3: Update gatherer default visibility from false to true in KanbanProvider

**File:** `/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts`

**Context:** The _getVisibleAgents method (lines 2612-2626) has defaults with `gatherer: false`. Since we're adding a checkbox in the agents tab that defaults to checked, we need to update the default to true to match.

**Logic:**
1. Change `gatherer: false` to `gatherer: true` in the defaults object (line 2613)

**Implementation:**

Lines 2613-2626 current:
```typescript
        const defaults: Record<string, boolean> = { 
            lead: true, 
            coder: true, 
            intern: true, 
            reviewer: true, 
            tester: false, 
            planner: true, 
            analyst: true, 
            jules: true, 
            gatherer: false,
            ticket_updater: false,
            researcher: false,
            splitter: false
        };
```

Lines 2613-2626 fixed:
```typescript
        const defaults: Record<string, boolean> = { 
            lead: true, 
            coder: true, 
            intern: true, 
            reviewer: true, 
            tester: false, 
            planner: true, 
            analyst: true, 
            jules: true, 
            gatherer: true,
            ticket_updater: false,
            researcher: false,
            splitter: false
        };
```

### Change 4: Update gatherer default visibility from false to true in TaskViewerProvider

**File:** `/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts`

**Context:** The getVisibleAgents method (lines 2656-2670) has defaults with `gatherer: false`. We need to update this to match KanbanProvider.

**Logic:**
1. Change `gatherer: false` to `gatherer: true` in the defaults object (line 2657)

**Implementation:**

Lines 2657-2670 current:
```typescript
        const defaults: Record<string, boolean> = { 
            lead: true, 
            coder: true, 
            intern: true, 
            reviewer: true, 
            tester: false, 
            planner: true, 
            analyst: true, 
            jules: true, 
            gatherer: false,
            ticket_updater: false,
            researcher: false,
            splitter: false
        };
```

Lines 2657-2670 fixed:
```typescript
        const defaults: Record<string, boolean> = { 
            lead: true, 
            coder: true, 
            intern: true, 
            reviewer: true, 
            tester: false, 
            planner: true, 
            analyst: true, 
            jules: true, 
            gatherer: true,
            ticket_updater: false,
            researcher: false,
            splitter: false
        };
```

### Change 5: Update gatherer default in kanban.html lastVisibleAgents

**File:** `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html`

**Context:** The kanban.html frontend has its own `lastVisibleAgents` default object (line 2881) used for initial column filtering before state is loaded from the server. It currently has `gatherer: false`, which means the CONTEXT GATHERER column won't appear until the server state is fetched.

**Logic:**
1. Change `gatherer: false` to `gatherer: true` in the `lastVisibleAgents` object on line 2881

**Implementation:**

Line 2881 current:
```typescript
let lastVisibleAgents = { lead: true, coder: true, intern: true, reviewer: true, tester: false, planner: true, analyst: true, jules: true, gatherer: false };
```

Line 2881 fixed:
```typescript
let lastVisibleAgents = { lead: true, coder: true, intern: true, reviewer: true, tester: false, planner: true, analyst: true, jules: true, gatherer: true };
```

### Change 6: Update gatherer default in setup.html lastVisibleAgents

**File:** `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/setup.html`

**Context:** The setup.html frontend also has a `lastVisibleAgents` default object (line 1308) used for caching agent visibility state. It currently has `gatherer: false`. Additionally, lines 2609-2613 have a stale comment: "gatherer is a built-in column toggled via the Kanban structure list, not a custom agent" — this is outdated now that gatherer will be toggled via the Agents tab.

**Logic:**
1. Change `gatherer: false` to `gatherer: true` in the `lastVisibleAgents` object on line 1308
2. **Clarification:** The gatherer persistence logic on lines 2609-2613 still works mechanically (it reads from `lastVisibleAgents`), but the comment is misleading. Update the comment to reflect that gatherer is now toggled via the Agents tab checkboxes like other built-in agents.

**Implementation:**

Line 1308 current:
```typescript
let lastVisibleAgents = { planner: true, lead: true, coder: true, intern: true, reviewer: true, tester: false, analyst: true, jules: true, gatherer: false };
```

Line 1308 fixed:
```typescript
let lastVisibleAgents = { planner: true, lead: true, coder: true, intern: true, reviewer: true, tester: false, analyst: true, jules: true, gatherer: true };
```

Lines 2609-2613 current:
```typescript
            const visibleAgents = {
                ...getCustomVisibleAgentsPatch(),
                // gatherer is a built-in column toggled via the Kanban structure list,
                // not a custom agent — include it explicitly so the server persists the user's preference.
                gatherer: lastVisibleAgents['gatherer'] !== false
            };
```

Lines 2609-2613 fixed:
```typescript
            const visibleAgents = {
                ...getCustomVisibleAgentsPatch(),
                // gatherer is a built-in agent toggled via the Agents tab checkboxes.
                // Include it explicitly so the server persists the user's preference.
                gatherer: lastVisibleAgents['gatherer'] !== false
            };
```

### Change 7: Filter out unselected agents from setup tab structure list

**File:** `/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts`

**Context:** The _buildSetupKanbanStructure method (lines 1310-1339) currently includes ALL columns from buildKanbanColumns and marks them as visible or hidden based on visibleAgents. The user wants only selected agents to appear in the structure arrangement - unselected agents should not appear at all.

**Logic:**
1. After building the column list, filter out columns where:
   - column.source === 'built-in' AND column.role exists AND visibleAgents[column.role] === false
2. This ensures that only agents selected in the agents tab appear in the setup tab structure list
3. Fixed columns (CREATED, COMPLETED) should always appear regardless of visibility

**Implementation:**

Lines 1315-1339 current:
```typescript
        return this._buildKanbanColumnsForWorkspace(customAgents, customKanbanColumns).map((column) => {
            const fixed = column.id === 'CREATED' || column.id === 'COMPLETED';
            const visible = fixed
                ? true
                : column.source === 'built-in'
                    ? (!column.role || visibleAgents[column.role] !== false)
                    : true;
            return {
                id: column.id,
                label: column.label,
                role: column.role,
                kind: column.kind,
                source: column.source,
                fixed,
                reorderable: !fixed,
                visible,
                order: column.order,
                assignedAgent: column.role,
                triggerPrompt: column.triggerPrompt,
                dragDropMode: column.dragDropMode,
                editable: column.source === 'custom-user',
                deletable: !fixed
            };
        });
```

Lines 1315-1339 fixed:
```typescript
        const allColumns = this._buildKanbanColumnsForWorkspace(customAgents, customKanbanColumns);
        return allColumns
            .filter((column) => {
                const fixed = column.id === 'CREATED' || column.id === 'COMPLETED';
                if (fixed) return true; // Always include fixed columns
                if (column.source === 'built-in' && column.role && visibleAgents[column.role] === false) {
                    return false; // Filter out unselected built-in agents
                }
                return true;
            })
            .map((column) => {
                const fixed = column.id === 'CREATED' || column.id === 'COMPLETED';
                const visible = fixed
                    ? true
                    : column.source === 'built-in'
                        ? (!column.role || visibleAgents[column.role] !== false)
                        : true;
                return {
                    id: column.id,
                    label: column.label,
                    role: column.role,
                    kind: column.kind,
                    source: column.source,
                    fixed,
                    reorderable: !fixed,
                    visible,
                    order: column.order,
                    assignedAgent: column.role,
                    triggerPrompt: column.triggerPrompt,
                    dragDropMode: column.dragDropMode,
                    editable: column.source === 'custom-user',
                    deletable: !fixed
                };
            });
```

**Note:** The visible property is still computed and used for other purposes, but the filter ensures unselected agents don't appear in the structure list at all.

## Verification Plan

### Automated Tests
- Run existing extension tests: `npm run test` or VS Code extension host launch
- No new unit tests required for this UI configuration change

### Manual Verification Steps

**Bug 1 - Context gatherer shows in agents tab:**
1. Open the kanban board in a workspace
2. Click on the Setup tab
3. Navigate to the Agents sub-tab
4. Verify that "Context Gatherer" checkbox is visible and checked by default
5. Uncheck the "Context Gatherer" checkbox
6. Verify the checkbox state is unchecked
7. Save the configuration
8. Refresh the kanban board
9. Verify the CONTEXT GATHERER column is NOT visible on the kanban board
10. Re-check the "Context Gatherer checkbox"
11. Save the configuration
12. Refresh the kanban board
13. Verify the CONTEXT GATHERER column IS visible on the kanban board

**Bug 2 - Context gatherer only shows in setup tab when selected:**
1. Open the kanban board in a workspace
2. Click on the Setup tab
3. Navigate to the Kanban Structure sub-tab
4. Verify that "Context Gatherer" appears in the structure list (since checkbox is checked by default)
5. Uncheck the "Context Gatherer" checkbox in the Agents tab
6. Save the configuration
7. Navigate back to Kanban Structure sub-tab
8. Verify that "Context Gatherer" NO LONGER appears in the structure list
9. Re-check the "Context Gatherer checkbox"
10. Save the configuration
11. Navigate back to Kanban Structure sub-tab
12. Verify that "Context Gatherer" reappears in the structure list
13. Test with other agents (e.g., uncheck "Analyst") to verify the filter works for all built-in agents

**Additional verification:**
- Verify that custom agents still appear in the structure list when selected
- Verify that custom columns still appear in the structure list
- Verify that CREATED and COMPLETED columns always appear regardless of selection
- Verify that the kanban board columns update correctly when toggling agent visibility

## Original Problem (Preserved)

**Bug 1:** Context gatherer does not show in agents tab of kanban.html as a checkbox, making it impossible for users to enable the context gatherer column.

**Bug 2:** Context gatherer shows up in setup tab of kanban.html as hidden even when not selected in the agents tab. The user expects that only selected agents in the agents tab should show up in the structure arrangement in the setup tab.

## Original Root Cause (Preserved)

**Bug 1:**
- The BUILT_IN_AGENT_LABELS constant in agentConfig.ts does not include gatherer
- The agents tab HTML in kanban.html hardcodes checkboxes for specific agents and does not include gatherer
- The gatherer agent was never added to the agents tab when it was introduced

**Bug 2:**
- The _buildSetupKanbanStructure method in TaskViewerProvider.ts includes ALL columns from buildKanbanColumns
- The visibility logic marks columns as visible or hidden based on visibleAgents, but still includes them in the structure list
- The user wants unselected agents to be filtered out entirely from the structure list, not just marked as hidden

## Original Affected Code (Preserved)

**Bug 1:**
- `/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/agentConfig.ts` (line 1, lines 70-81, line 356) - BuiltInAgentRole type and BUILT_IN_AGENT_LABELS missing gatherer; VALID_ROLES missing gatherer
- `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html` (lines 2026-2037) - agents tab checkboxes missing gatherer
- `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html` (line 2881) - lastVisibleAgents default has gatherer: false
- `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/setup.html` (line 1308) - lastVisibleAgents default has gatherer: false
- `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/setup.html` (lines 2609-2613) - stale comment about gatherer being toggled via Kanban structure list

**Bug 2:**
- `/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts` (lines 1310-1339) - _buildSetupKanbanStructure includes all columns

## Original Fix (Preserved)

1. Add 'gatherer' to BuiltInAgentRole type and BUILT_IN_AGENT_LABELS in agentConfig.ts
2. Add 'gatherer' to VALID_ROLES in parseDefaultPromptOverrides in agentConfig.ts
3. Add gatherer checkbox to agents tab in kanban.html
4. Change gatherer default from false to true in KanbanProvider.ts _getVisibleAgents
5. Change gatherer default from false to true in TaskViewerProvider.ts getVisibleAgents
6. Change gatherer default from false to true in kanban.html lastVisibleAgents
7. Change gatherer default from false to true in setup.html lastVisibleAgents and update stale comment
8. Filter out unselected built-in agents from the structure list in _buildSetupKanbanStructure

## Original Implementation Steps (Preserved)

### Step 1: Add gatherer to BuiltInAgentRole type and BUILT_IN_AGENT_LABELS
- Open agentConfig.ts
- Add 'gatherer' to the BuiltInAgentRole union type on line 1
- Add 'gatherer': 'Context Gatherer' to the BUILT_IN_AGENT_LABELS constant
- Add 'gatherer' to the VALID_ROLES array in parseDefaultPromptOverrides on line 356

### Step 2: Add gatherer checkbox to agents tab
- Open kanban.html
- Add a checkbox row for gatherer after the splitter row and before the jules row in the agents tab
- Set the checkbox to checked by default
- Use a span (not text input) explaining it's clipboard context gathering only

### Step 3: Update gatherer default visibility in providers
- Open KanbanProvider.ts
- Change gatherer: false to gatherer: true in _getVisibleAgents defaults (lines 2613-2626)
- Open TaskViewerProvider.ts
- Change gatherer: false to gatherer: true in getVisibleAgents defaults (lines 2657-2670)

### Step 4: Update gatherer default visibility in frontend defaults
- Open kanban.html
- Change gatherer: false to gatherer: true in lastVisibleAgents (line 2881)
- Open setup.html
- Change gatherer: false to gatherer: true in lastVisibleAgents (line 1308)
- Update stale comment on lines 2609-2613 about gatherer being toggled via Kanban structure list

### Step 5: Filter unselected agents from setup tab structure
- Open TaskViewerProvider.ts
- Modify _buildSetupKanbanStructure to filter out columns where:
  - column.source === 'built-in' AND column.role exists AND visibleAgents[column.role] === false
- Keep the visible property computation for other uses

### Step 6: Verification
- Build the extension
- Test both bugs as described in the verification plan

## Original Files to Modify (Preserved)

- `/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/agentConfig.ts` (line 1, lines 70-81, line 356)
- `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html` (lines 2026-2037, line 2881)
- `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/setup.html` (line 1308, lines 2609-2613)
- `/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts` (lines 2613-2626)
- `/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts` (lines 2657-2670, lines 1315-1339)

## Original Verification Steps (Preserved)

1. Open kanban board, navigate to Setup > Agents tab
2. Verify Context Gatherer checkbox exists and is checked by default
3. Toggle checkbox and verify kanban board column visibility updates
4. Navigate to Setup > Kanban Structure tab
5. Verify Context Gatherer appears when checked, disappears when unchecked
6. Test with other agents to verify filter works correctly
7. Verify fixed columns (CREATED, COMPLETED) always appear
8. Verify custom agents and columns still work correctly
9. Verify that existing agents (ticket_updater, researcher, splitter) still appear in the agents tab

## Improvement Notes

This plan was improved on 2026-05-10. The following corrections were made during the improve-plan workflow:

1. **BuiltInAgentRole type updated** — The original plan noted the type might need updating but never formalized it as a required change. Without adding `'gatherer'` to the `BuiltInAgentRole` union on line 1 of `agentConfig.ts`, adding `'gatherer'` to `BUILT_IN_AGENT_LABELS` (which is typed `Record<BuiltInAgentRole, string>`) causes a TypeScript compilation error. This is now Change 1.

2. **VALID_ROLES array updated** — The `parseDefaultPromptOverrides` function on line 356 of `agentConfig.ts` has a hardcoded `VALID_ROLES` array that also needs `'gatherer'` added, or prompt overrides for the gatherer role will be silently discarded.

3. **kanban.html HTML corrected** — The original plan's HTML snippet for the agents tab was missing `ticket_updater`, `researcher`, and `splitter` rows that exist in the actual file. A coder following the original snippet would have overwritten and deleted those three agents. The corrected snippet preserves all existing rows and inserts the gatherer row after `splitter` and before `jules`.

4. **Two missing frontend defaults identified** — `kanban.html` line 2881 and `setup.html` line 1308 both have `lastVisibleAgents` objects with `gatherer: false`. These need updating or the CONTEXT GATHERER column won't appear on initial load before server state is fetched.

5. **Stale comment in setup.html identified** — Lines 2609-2613 in `setup.html` contain a comment stating "gatherer is a built-in column toggled via the Kanban structure list, not a custom agent." This is the exact buggy behavior being fixed. The comment has been flagged for cleanup.

6. **All line numbers refreshed** — The original plan's line numbers were off by hundreds of lines due to code drift since the plan was written. All line references have been updated to match the current source files.

7. **Metadata tags fixed** — Removed invalid tags `agents` and `visibility` which are not in the allowed tag list.

8. **Adversarial Synthesis condensed** — Reduced from a multi-sentence paragraph to the required 2-3 sentence Risk Summary format.

---

**Recommendation:** Complexity is 4 (routine, localized changes following existing patterns). Send to Coder.
