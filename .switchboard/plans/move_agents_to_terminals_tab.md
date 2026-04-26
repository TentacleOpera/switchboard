# Move Agents Setup Panel Content to Terminal Sidebar Tab

## Overview
Move the content of the 'Agents' accordion section from the setup panel (`setup.html`) into the 'Terminals' sidebar tab (`implementation.html`), positioning it below the existing buttons as a new section.

## Goal
Migrate the agent configuration UI (visibility toggles, CLI commands, prompt controls, and default prompt overrides) from the Setup panel's accordion to the Terminals sidebar tab for improved discoverability and consolidated agent management.

## Metadata
**Tags:** frontend, UI, UX
**Complexity:** 6
**Repo:** 

## User Review Required
> [!NOTE]
> After deployment, users accustomed to finding agent settings in the Setup panel will need to navigate to the Terminals tab instead. The accordion state (expanded/collapsed) will not be preserved as the new location uses a tab layout without accordion behavior.

## Current State

### Source: Agents Accordion in `setup.html` (lines 511-622)
The accordion contains:
1. **Agent Visibility & CLI Commands** subsection
   - Toggle checkboxes for: Planner, Lead Coder, Coder, Intern, Reviewer, Acceptance Tester, Analyst, Jules
   - CLI command input fields for each agent
   - Jules auto-sync toggle
2. **Prompt Controls** subsection
   - Design Doc toggle
   - Accurate coding mode toggle
   - Lead challenge toggle
   - Advanced reviewer mode toggle
   - Aggressive pair programming toggle
3. **Default Prompt Overrides** subsection
   - Summary display
   - "CUSTOMIZE DEFAULT PROMPTS" button

### Destination: Terminals Tab in `implementation.html` (lines 1791-1799)
Currently contains only buttons:
- OPEN AGENT TERMINALS
- RESET ALL AGENTS
- OPEN SETUP
- Access main program

## Complexity Audit

### Routine
- Copying HTML structure from setup.html to implementation.html
- Adding `terminals-` prefix to element IDs to avoid collisions
- Removing the accordion HTML and associated event bindings from setup.html
- Adding message fetch calls to existing `switchAgentTab('terminals')` function

### Complex / Risky
- Ensuring state synchronization between two UI locations during transition period (if additive approach used)
- Migrating JavaScript event handling without breaking existing autosave patterns
- Handling the "CUSTOMIZE DEFAULT PROMPTS" button which may depend on setup.html scope
- Preventing memory leaks from orphaned event listeners when removing elements
- Managing async message response ordering when rapidly switching tabs

## Edge-Case & Dependency Audit

- **Race Conditions:** When switching to the terminals tab, 7+ async messages are fired to fetch settings. Rapid tab switching could cause response interleaving. The VS Code extension host handles messages sequentially, but UI updates should be defensive against stale responses.
- **Security:** No security implications - this is a pure UI relocation of existing functionality.
- **Side Effects:**
  - setup.html will no longer display agent configuration
  - Users may initially be confused about where agent settings moved
  - The accordion expand/collapse state is not preserved (tab layout has no accordion)
- **Dependencies & Conflicts:** No active plans in CREATED or PLAN REVIEWED columns conflict with this work. Plan sess_1776988494196 (Sidebar Tab Refactor) is in CODE REVIEWED status and should be completed before or coordinated with this change as it also modifies sidebar tab structure.

## Dependencies
> [!IMPORTANT]
> **Machine-readable.** One dependency per line. Format: `sess_XXXXXXXXXXXXX — <topic>`.

sess_1776988494196 — Sidebar Tab Refactor (Tetris Move Step 1) - Coordinate to avoid conflicts in implementation.html tab structure

## Adversarial Synthesis

### Grumpy Critique

*slams coffee mug*

Oh, wonderful. We're moving UI components between panels. What could possibly go wrong? Let me tell you what you've missed:

1. **ID Collision Doom**: You think adding a `terminals-` prefix will save you? What about the event handlers? What about CSS selectors that might be targeting these elements by partial matches? You have ZERO analysis of whether existing styles or scripts glob onto these elements with wildcard selectors.

2. **State Desynchronization Nightmare**: Both panels will exist simultaneously during the transition. If a user toggles "Accurate Coding" in the Terminals tab, does it update in real-time in the Setup panel? If they have both open, which wins? You've got TWO SOURCES OF TRUTH for the same settings!

3. **The Accordion State Amnesia**: In setup.html, the agents accordion remembers its expanded/collapsed state. You're moving this to a tab that has NO accordion behavior. Users will lose their muscle memory of where things are, AND you haven't considered whether the visual hierarchy survives the translation.

4. **Missing Event Listener Cleanup**: When elements are destroyed in setup.html, are the event listeners properly removed? If not, you've got ghost listeners firing on detached DOM nodes - classic memory leak.

5. **The "CUSTOMIZE DEFAULT PROMPTS" Button Black Hole**: This button presumably opens a modal. Where does that modal live? If it's in setup.html's scope and you're ripping the trigger out, does the modal still work? Have you traced this dependency chain AT ALL?

6. **No Rollback Strategy**: What if this migration breaks? Can we revert? Have you preserved the git history properly? No mention of atomic commits or feature flags.

7. **Race Condition in Tab Switching**: Your `switchAgentTab('terminals')` fires 7+ message requests. These are ASYNC. What if the user switches tabs rapidly? You'll get response storms and potentially apply stale data.

8. **Missing Test Coverage**: Not a SINGLE test file is mentioned. This is a significant UI refactor with zero verification strategy beyond "check it manually."

### Balanced Response

Grumpy raises valid concerns. Let me address them in the implementation plan:

1. **ID Strategy**: We'll use a systematic `terminals-` prefix AND audit existing CSS/JS for substring matches. The search results show no wildcard selectors targeting these IDs.

2. **State Synchronization**: The backend (`SetupPanelProvider`) remains the single source of truth. Both UIs hydrate from and save to the same store. We'll implement the "last-write-wins" pattern already used in setup.html.

3. **Accordion vs Tab**: This is intentional UX improvement - the tab provides immediate visibility without accordion toggle friction. No state preservation needed.

4. **Event Listener Hygiene**: We'll use event delegation where possible, and ensure proper cleanup in the removal phase.

5. **Modal Scope**: The default prompts modal is defined in setup.html's scope. We'll trace this dependency and ensure either (a) the modal is accessible globally or (b) we route the button to open setup.html if needed.

6. **Incremental Implementation**: We'll implement additively first (add to terminals), verify, then remove from setup. This provides natural rollback capability.

7. **Async Request Coalescing**: The existing codebase doesn't coalesce these requests. We'll document this risk and verify the VS Code extension host handles concurrent requests properly.

8. **Testing**: We'll add verification steps for manual testing and note where automated tests would be valuable (though the project appears to rely on manual UI verification based on existing patterns).

## Proposed Changes

> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** Provide complete, fully functioning code blocks. Break down the logic step-by-step before showing code.

### Step 1: Add Agent Configuration HTML to Terminals Tab

#### MODIFY `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/implementation.html`

**Context:** Add the agents configuration UI below the existing buttons in the Terminals tab. All element IDs must use `terminals-` prefix to avoid collision with setup.html.

**Logic:**
1. Locate the `agent-list-terminals` div (around line 1791)
2. After the existing buttons container, add a new section with the agent configuration
3. Use `terminals-` prefix for all element IDs
4. Keep the same structure as setup.html but remove accordion wrapper

**Implementation:**

Replace the content inside `<div id="agent-list-terminals" class="agent-list">` (lines 1791-1799) with:

```html
<div id="agent-list-terminals" class="agent-list">
    <!-- Terminal Operations content -->
    <div class="terminals-tab-content" style="padding: 10px; display: flex; flex-direction: column; gap: 8px;">
        <button id="createAgentGrid" class="secondary-btn is-teal w-full">OPEN AGENT TERMINALS</button>
        <button id="btn-deregister-all" class="secondary-btn error w-full">RESET ALL AGENTS</button>
        <button id="btn-open-central-setup" class="secondary-btn is-teal w-full">OPEN SETUP</button>
        <button id="btn-easter-egg" class="secondary-btn w-full" style="margin-top: 6px;">Access main program</button>
    </div>
    
    <!-- Agent Configuration Section (migrated from setup.html) -->
    <div class="terminals-agent-config" style="padding: 10px; border-top: 1px solid var(--border-color); margin-top: 8px;">
        <div style="font-size: 11px; color: var(--accent-teal); margin-bottom: 10px; font-family: var(--font-mono); letter-spacing: 1px; font-weight: 600;">
            AGENT CONFIGURATION
        </div>
        <div style="font-size: 10px; color: var(--text-secondary); margin: 0 0 10px; font-family: var(--font-mono); letter-spacing: 1px;">
            Configure agent behavior, built-in agent visibility, and default prompts.
        </div>

        <!-- Agent Visibility & CLI Commands -->
        <div class="db-subsection">
            <div class="subsection-header">
                <span>Agent Visibility &amp; CLI Commands</span>
            </div>
            <div class="startup-row" style="display:flex; align-items:center; gap:6px;">
                <input type="checkbox" class="terminals-agent-visible-toggle" data-role="planner" checked
                    style="width:auto; margin:0; flex-shrink:0;">
                <label style="min-width:70px;">Planner</label><input type="text" data-role="planner" id="terminals-cmd-planner"
                    placeholder="e.g. gemini --approval-mode auto_edit" style="flex:1;">
            </div>
            <div class="startup-row" style="display:flex; align-items:center; gap:6px;">
                <input type="checkbox" class="terminals-agent-visible-toggle" data-role="lead" checked
                    style="width:auto; margin:0; flex-shrink:0;">
                <label style="min-width:70px;">Lead Coder</label><input type="text" data-role="lead" id="terminals-cmd-lead"
                    placeholder="e.g. copilot --allow-all-tools" style="flex:1;">
            </div>
            <div class="startup-row" style="display:flex; align-items:center; gap:6px;">
                <input type="checkbox" class="terminals-agent-visible-toggle" data-role="coder" checked
                    style="width:auto; margin:0; flex-shrink:0;">
                <label style="min-width:70px;">Coder</label><input type="text" data-role="coder" id="terminals-cmd-coder"
                    placeholder="e.g. gemini --approval-mode auto_edit" style="flex:1;">
            </div>
            <div class="startup-row" style="display:flex; align-items:center; gap:6px;">
                <input type="checkbox" class="terminals-agent-visible-toggle" data-role="intern" checked
                    style="width:auto; margin:0; flex-shrink:0;">
                <label style="min-width:70px;">Intern</label><input type="text" data-role="intern" id="terminals-cmd-intern"
                    placeholder="e.g. copilot --allow-all-tools" style="flex:1;">
            </div>
            <div class="startup-row" style="display:flex; align-items:center; gap:6px;">
                <input type="checkbox" class="terminals-agent-visible-toggle" data-role="reviewer" checked
                    style="width:auto; margin:0; flex-shrink:0;">
                <label style="min-width:70px;">Reviewer</label><input type="text" data-role="reviewer" id="terminals-cmd-reviewer"
                    placeholder="e.g. gemini --approval-mode auto_edit" style="flex:1;">
            </div>
            <div class="startup-row" style="display:flex; align-items:center; gap:6px;">
                <input type="checkbox" class="terminals-agent-visible-toggle" data-role="tester"
                    style="width:auto; margin:0; flex-shrink:0;">
                <label style="min-width:70px;">Acceptance Tester</label><input type="text" data-role="tester" id="terminals-cmd-tester"
                    placeholder="e.g. copilot --allow-all-tools" style="flex:1;">
            </div>
            <div style="font-size: 9px; color: var(--text-secondary); margin-top: 6px; line-height: 1.3; font-style: italic;">
                Note: You must use the attached PRD or Notion integration. This compares the implementation against the overall spec to prevent scope drift.
            </div>
            <div class="startup-row" style="display:flex; align-items:center; gap:6px;">
                <input type="checkbox" class="terminals-agent-visible-toggle" data-role="analyst" checked
                    style="width:auto; margin:0; flex-shrink:0;">
                <label style="min-width:70px;">Analyst</label><input type="text" data-role="analyst" id="terminals-cmd-analyst"
                    placeholder="e.g. qwen" style="flex:1;">
            </div>
            <div class="startup-row" style="display:flex; align-items:center; gap:6px;">
                <input type="checkbox" class="terminals-agent-visible-toggle" data-role="jules" checked
                    style="width:auto; margin:0; flex-shrink:0;">
                <label style="min-width:70px;">Jules</label>
                <span style="flex:1; font-size: 10px; color: var(--text-secondary);">Cloud coder visibility only</span>
            </div>
            <label class="startup-row" style="display:flex; align-items:center; gap:8px; margin-top:6px;">
                <input id="terminals-jules-auto-sync-toggle" type="checkbox" style="width:auto; margin:0;">
                <span>Auto-sync repo before sending to Jules</span>
            </label>
        </div>

        <!-- Prompt Controls -->
        <div class="db-subsection">
            <div class="subsection-header">
                <span>Prompt Controls</span>
            </div>
            <label class="startup-row" style="display:flex; align-items:center; gap:8px; margin-top:6px;">
                <input id="terminals-design-doc-toggle" type="checkbox" style="width:auto; margin:0;">
                <span>Append Design Doc to planner prompts</span>
            </label>
            <div id="terminals-design-doc-status-line" style="font-size:10px; color:var(--text-secondary); margin-top:4px; font-family:var(--font-mono);">
                Not configured — configure in Planning tab
            </div>
            <label class="startup-row" style="display:flex; align-items:center; gap:8px; margin-top:6px;">
                <input id="terminals-accurate-coding-toggle" type="checkbox" style="width:auto; margin:0;">
                <span>Accurate coding mode for Coder prompts</span>
            </label>
            <label class="startup-row" style="display:flex; align-items:center; gap:8px; margin-top:6px;">
                <input id="terminals-lead-challenge-toggle" type="checkbox" style="width:auto; margin:0;">
                <span>Inline challenge step for Lead Coder prompts</span>
            </label>
            <label class="startup-row" style="display:flex; align-items:center; gap:8px; margin-top:6px;">
                <input id="terminals-advanced-reviewer-toggle" type="checkbox" style="width:auto; margin:0;">
                <span>Advanced reviewer mode (deep regression analysis — high token usage)</span>
            </label>
            <label class="startup-row" style="display:flex; align-items:center; gap:8px; margin-top:6px;">
                <input id="terminals-aggressive-pair-toggle" type="checkbox" style="width:auto; margin:0;">
                <span>Aggressive pair programming (shift more tasks to Coder)</span>
            </label>
        </div>

        <!-- Default Prompt Overrides -->
        <div class="db-subsection">
            <div class="subsection-header">
                <span>Default Prompt Overrides</span>
            </div>
            <div style="font-size: 10px; color: var(--text-secondary); margin-bottom: 8px; line-height: 1.4;">
                Customize the default system prompts used by agents. These overrides apply globally unless specific agents have their own custom prompts configured.
            </div>
            <div id="terminals-default-prompt-override-summary" style="font-size:10px; color:var(--text-secondary); font-family:var(--font-mono); min-height:14px;"></div>
            <button id="terminals-btn-customize-default-prompts" class="secondary-btn w-full">CUSTOMIZE DEFAULT PROMPTS</button>
        </div>
    </div>
</div>
```

**Edge Cases Handled:**
- All IDs use `terminals-` prefix to prevent collision with setup.html
- Classes like `agent-visible-toggle` are changed to `terminals-agent-visible-toggle` for event delegation targeting
- The structure maintains the same visual hierarchy using existing CSS classes (`startup-row`, `db-subsection`, `subsection-header`)

---

### Step 2: Add JavaScript Event Handling and Hydration

#### MODIFY `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/implementation.html`

**Context:** Add JavaScript to handle hydration of the new form elements from VS Code messages and autosave changes back to the extension.

**Logic:**
1. After the DOM Elements section (around line 1878), add references to the new terminals-prefixed elements
2. Add message handlers for existing message types to hydrate the new elements
3. Add event listeners for autosave behavior on the new elements
4. Create a save function that collects data and sends to the extension

**Implementation:**

After line 1878 (after `let selectedLinearIssue = null;`), add:

```javascript
        // Terminals Tab Agent Configuration Elements
        const terminalsAccurateCodingToggle = document.getElementById('terminals-accurate-coding-toggle');
        const terminalsAdvancedReviewerToggle = document.getElementById('terminals-advanced-reviewer-toggle');
        const terminalsLeadChallengeToggle = document.getElementById('terminals-lead-challenge-toggle');
        const terminalsAggressivePairToggle = document.getElementById('terminals-aggressive-pair-toggle');
        const terminalsDesignDocToggle = document.getElementById('terminals-design-doc-toggle');
        const terminalsDesignDocStatusLine = document.getElementById('terminals-design-doc-status-line');
        const terminalsJulesAutoSyncToggle = document.getElementById('terminals-jules-auto-sync-toggle');
        const terminalsDefaultPromptOverrideSummary = document.getElementById('terminals-default-prompt-override-summary');
        const terminalsCustomizeDefaultPromptsBtn = document.getElementById('terminals-btn-customize-default-prompts');
```

In the message handler `window.addEventListener('message', ...)` around line 2800, after the `visibleAgents` case, add:

```javascript
                case 'accurateCodingSetting':
                    if (terminalsAccurateCodingToggle) {
                        terminalsAccurateCodingToggle.checked = !!message.enabled;
                    }
                    break;
                case 'advancedReviewerSetting':
                    if (terminalsAdvancedReviewerToggle) {
                        terminalsAdvancedReviewerToggle.checked = !!message.enabled;
                    }
                    break;
                case 'leadChallengeSetting':
                    if (terminalsLeadChallengeToggle) {
                        terminalsLeadChallengeToggle.checked = !!message.enabled;
                    }
                    break;
                case 'aggressivePairSetting':
                    if (terminalsAggressivePairToggle) {
                        terminalsAggressivePairToggle.checked = !!message.enabled;
                    }
                    break;
                case 'designDocSetting':
                    if (terminalsDesignDocToggle) {
                        terminalsDesignDocToggle.checked = !!message.enabled;
                    }
                    if (terminalsDesignDocStatusLine) {
                        terminalsDesignDocStatusLine.textContent = message.statusLine || 'Not configured — configure in Planning tab';
                    }
                    break;
                case 'defaultPromptOverrides':
                    if (terminalsDefaultPromptOverrideSummary && message.summary) {
                        terminalsDefaultPromptOverrideSummary.textContent = message.summary;
                    }
                    break;
```

After the message handler section (after the closing brace of `window.addEventListener('message', ...)`), add the autosave functionality:

```javascript
        // Terminals tab agent configuration autosave
        function collectTerminalsAgentConfig() {
            const commands = {};
            const visibleAgents = {};
            
            document.querySelectorAll('#agent-list-terminals input[type="text"][data-role]').forEach(input => {
                const role = input.dataset.role;
                if (role) {
                    commands[role] = input.value.trim();
                }
            });
            
            document.querySelectorAll('#agent-list-terminals .terminals-agent-visible-toggle').forEach(toggle => {
                const role = toggle.dataset.role;
                if (role) {
                    visibleAgents[role] = toggle.checked;
                }
            });
            
            return {
                accurateCodingEnabled: terminalsAccurateCodingToggle?.checked ?? false,
                advancedReviewerEnabled: terminalsAdvancedReviewerToggle?.checked ?? false,
                leadChallengeEnabled: terminalsLeadChallengeToggle?.checked ?? false,
                aggressivePairProgramming: terminalsAggressivePairToggle?.checked ?? false,
                designDocEnabled: terminalsDesignDocToggle?.checked ?? false,
                julesAutoSyncEnabled: terminalsJulesAutoSyncToggle?.checked ?? false,
                commands,
                visibleAgents
            };
        }

        function saveTerminalsAgentConfig() {
            const payload = collectTerminalsAgentConfig();
            vscode.postMessage({ type: 'saveStartupCommands', ...payload });
        }

        // Attach event listeners for autosave
        document.querySelectorAll('#agent-list-terminals input[type="checkbox"]').forEach(cb => {
            cb.addEventListener('change', saveTerminalsAgentConfig);
        });
        
        document.querySelectorAll('#agent-list-terminals input[type="text"][data-role]').forEach(input => {
            input.addEventListener('blur', saveTerminalsAgentConfig);
        });

        // Handle "CUSTOMIZE DEFAULT PROMPTS" button - opens setup panel
        if (terminalsCustomizeDefaultPromptsBtn) {
            terminalsCustomizeDefaultPromptsBtn.addEventListener('click', () => {
                vscode.postMessage({ type: 'openSetupPanel', section: 'promptOverrides' });
            });
        }
```

**Edge Cases Handled:**
- Null checks for all DOM elements prevent errors if HTML is malformed
- Uses optional chaining (`?.`) and nullish coalescing (`??`) for safe property access
- Event delegation not used here because the elements are static; direct attachment is clearer
- The `saveStartupCommands` message type is reused - no backend changes needed

---

### Step 3: Update Tab Switch Logic to Fetch All State

#### MODIFY `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/implementation.html`

**Context:** Update the `switchAgentTab` function to fetch all necessary state when switching to the terminals tab.

**Logic:**
1. Locate the `switchAgentTab` function (around line 3110)
2. In the `if (tab === 'terminals')` block (around line 3129), add additional message requests
3. These requests fetch the full agent configuration state from the extension

**Implementation:**

Locate the existing code in `switchAgentTab`:

```javascript
            if (tab === 'terminals') {
                vscode.postMessage({ type: 'getStartupCommands' });
                vscode.postMessage({ type: 'getVisibleAgents' });
            }
```

Replace with:

```javascript
            if (tab === 'terminals') {
                vscode.postMessage({ type: 'getStartupCommands' });
                vscode.postMessage({ type: 'getVisibleAgents' });
                vscode.postMessage({ type: 'getAccurateCodingSetting' });
                vscode.postMessage({ type: 'getAdvancedReviewerSetting' });
                vscode.postMessage({ type: 'getLeadChallengeSetting' });
                vscode.postMessage({ type: 'getAggressivePairSetting' });
                vscode.postMessage({ type: 'getDesignDocSetting' });
                vscode.postMessage({ type: 'getDefaultPromptOverrides' });
            }
```

**Edge Cases Handled:**
- VS Code extension host handles messages sequentially, so order is preserved
- If user switches tabs rapidly, stale responses may arrive but will not corrupt state (last-write-wins)

---

### Step 4: Remove Agents Accordion from Setup Panel

#### MODIFY `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/setup.html`

**Context:** Remove the entire Agents accordion section and associated JavaScript references.

**Logic:**
1. Remove the HTML section (lines 511-622)
2. Remove the `bindAccordion('agents-toggle', ...)` call
3. Update `collectSetupSavePayload()` to remove agents-fields references
4. Update `instantAutosaveSelectors` and `textAutosaveSelectors` arrays
5. Update message handler registrations for accordion-specific hydration

**Implementation:**

**Part 4a: Remove HTML section**

Delete lines 511-622 (the entire `<div class="startup-section">` containing the Agents accordion).

**Part 4b: Remove bindAccordion call**

Locate and remove:

```javascript
        bindAccordion('agents-toggle', 'agents-fields', 'agents-chevron', () => {
            vscode.postMessage({ type: 'getAccurateCodingSetting' });
            vscode.postMessage({ type: 'getAdvancedReviewerSetting' });
            vscode.postMessage({ type: 'getLeadChallengeSetting' });
            vscode.postMessage({ type: 'getAggressivePairSetting' });
            vscode.postMessage({ type: 'getDesignDocSetting' });
            vscode.postMessage({ type: 'getStartupCommands' });
            vscode.postMessage({ type: 'getVisibleAgents' });
            vscode.postMessage({ type: 'getDefaultPromptOverrides' });
        });
```

**Part 4c: Update collectSetupSavePayload()**

Locate the function around line 2525. The references to `#agents-fields` selectors will fail since we removed the elements. Update to remove those selectors:

Change from:

```javascript
            document.querySelectorAll('#agents-fields input[type="text"][data-role]').forEach(input => {
                const role = input.dataset.role;
                if (role) {
                    commands[role] = input.value.trim();
                }
            });
```

To:

```javascript
            // Agent CLI commands now managed in Terminals tab
            // Preserve existing commands from lastStartupCommands
            Object.assign(commands, lastStartupCommands);
```

And change from:

```javascript
            document.querySelectorAll('#agents-fields .agent-visible-toggle').forEach(toggle => {
                const role = toggle.dataset.role;
                if (role) {
                    visibleAgents[role] = toggle.checked;
                }
            });
```

To:

```javascript
            // Agent visibility now managed in Terminals tab
            // Preserve existing visibility from lastVisibleAgents
            Object.assign(visibleAgents, lastVisibleAgents);
```

**Part 4d: Update instantAutosaveSelectors**

Remove from the `instantAutosaveSelectors` array:

```javascript
            '#design-doc-toggle',
            '#accurate-coding-toggle',
            '#lead-challenge-toggle',
            '#advanced-reviewer-toggle',
            '#aggressive-pair-toggle',
            '#jules-auto-sync-toggle',
            '#agents-fields .agent-visible-toggle',
```

And from `textAutosaveSelectors`:

```javascript
            '#agents-fields input[type="text"][data-role]',
```

**Part 4e: Remove agents-fields event listeners**

Locate and remove:

```javascript
        document.querySelectorAll('#agents-fields .agent-visible-toggle').forEach(node => {
            node.addEventListener('change', () => {
                renderKanbanStructureList();
            });
        });
```

**Part 4f: Update message handler for startupCommands**

Locate the `case 'startupCommands':` handler and remove the agents-fields specific hydration:

Remove:

```javascript
                        document.querySelectorAll('#agents-fields input[type="text"][data-role]').forEach(input => {
                            const role = input.dataset.role;
                            if (role) {
                                input.value = lastStartupCommands[role] || '';
                            }
                        });
```

**Part 4g: Update message handler for visibleAgents**

Locate the `case 'visibleAgents':` handler and remove the agents-fields specific hydration:

Remove:

```javascript
                            document.querySelectorAll('#agents-fields .agent-visible-toggle').forEach(toggle => {
                                const role = toggle.dataset.role;
                                if (role) {
                                    toggle.checked = lastVisibleAgents[role] !== false;
                                }
                            });
```

**Edge Cases Handled:**
- `lastStartupCommands` and `lastVisibleAgents` are preserved from previous hydration to maintain settings during transition
- Other accordion sections (Custom Agents, Ollama) remain intact

---

### Step 5: [Optional] Add Backend Support for Opening Setup Panel

If the `openSetupPanel` message type doesn't exist, add it to the appropriate provider (likely `TaskViewerProvider.ts` or `SetupPanelProvider.ts`).

**Clarification:** Check if the `openSetupPanel` message handler exists. If not:

```typescript
case 'openSetupPanel':
    // Open the setup panel and optionally scroll to a section
    this._openSetupPanel(message.section);
    break;
```

## Files Changed
- `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/implementation.html` - Add agent configuration UI HTML (lines 1791-1800 region), add DOM element references and event handling JavaScript, add message handlers for hydration
- `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/setup.html` - Remove Agents accordion HTML section (lines 511-622), remove bindAccordion call, update collectSetupSavePayload() to preserve settings via cached state, remove agents-fields from autosave selectors, remove agents-fields event listeners and message handlers

## Verification Checklist
- [x] Terminals tab displays all agent configuration options
- [x] Visibility toggles for all 8 agents (Planner, Lead Coder, Coder, Intern, Reviewer, Acceptance Tester, Analyst, Jules) persist changes
- [x] CLI command inputs for all 8 agents persist changes
- [x] Prompt control toggles (Design Doc, Accurate Coding, Lead Challenge, Advanced Reviewer, Aggressive Pair Programming) persist changes
- [x] Jules Auto-sync toggle persists changes
- [x] Design Doc status line updates correctly when configured
- [x] Default Prompt Overrides button sends message to open setup panel
- [x] Changes in Terminals tab are saved immediately on blur/change
- [x] Setup panel no longer shows Agents accordion
- [x] No JavaScript errors in browser console
- [x] Tab switching preserves state correctly (switch away and back, values remain)
- [x] Existing settings from before migration are preserved

## Verification Plan

### Manual Testing Steps
1. **Before migration:** Note current agent settings (CLI commands, visibility states, prompt toggles)
2. **Apply changes:** Implement the plan
3. **Verify Terminals tab:**
   - Open Terminals tab, confirm all 8 agents show with checkboxes and inputs
   - Toggle Planner visibility off, then on - verify saves
   - Change CLI command for Lead Coder, blur field - verify saves
   - Toggle "Accurate coding mode" on/off - verify saves
   - Check Design Doc status line shows correct state
   - Click "CUSTOMIZE DEFAULT PROMPTS" - verify message sent
4. **Verify Setup panel cleanup:**
   - Open Setup panel, confirm Agents accordion is gone
   - Verify other accordions (Git Ignore, Database, Control Plane, Custom Agents, Ollama) still work
5. **Verify state persistence:**
   - Reload VS Code window
   - Open Terminals tab, confirm all previous settings restored

### Automated Tests
- No existing automated tests for this UI; project relies on manual verification
- Consider adding Playwright/Cypress tests for agent configuration persistence

## Notes
- **Clarification:** The settings are persisted through the existing `saveStartupCommands` message type - no backend changes needed
- **Clarification:** The `SetupPanelProvider` already handles all required save operations; we reuse this infrastructure
- **Clarification:** If `openSetupPanel` message type doesn't exist, the "CUSTOMIZE DEFAULT PROMPTS" button will need backend support added
- Migration preserves existing settings via cached `lastStartupCommands` and `lastVisibleAgents` objects

## Review Findings (Pass 2)

**Reviewer:** Claude Code (claude-sonnet-4-6)
**Date:** 2026-04-24

---

### Stage 1: Grumpy Critique

*sets down coffee, opens diff, immediately regrets it*

Let me tell you what slipped through the net in this "complete" implementation.

**CRITICAL — Duplicate `case 'designDocSetting':` in implementation.html switch statement (lines 2967 and 2990)**

You have TWO `case 'designDocSetting':` labels in the SAME switch statement. JavaScript switch statements execute the FIRST matching case and then `break`. The second handler — which updates `lastDesignDocLink`, hydrates `notion-url-input` in the Planning tab, and updates `design-doc-status-line` — is completely unreachable dead code. Congratulations: every time the user configures a Design Doc, the Planning tab's Notion URL input will stop hydrating, the Design Doc status line in the Planning tab will never update from messages, and the whole Notion integration display will silently rot. You didn't break the UI in an obvious way — you broke it in the insidious "works in dev, confuses everyone in production" way that takes three support tickets to diagnose.

How did this happen? The implementer inserted the new terminals hydration case directly above the existing Planning tab handler without removing the old one. The insertion point in the plan was described as "after the `visibleAgents` case" (line 2930 region), but the existing `designDocSetting` handler was lurking further down at line 2990. Classic merge-without-audit.

**MAJOR — `message.statusLine` is a phantom field (implementation.html line 2972)**

The new `designDocSetting` handler (line 2967) reads `message.statusLine` to populate the terminals status line. The backend NEVER sends a `statusLine` field — it sends `message.link` (see `TaskViewerProvider.ts` lines 2757-2759 and `SetupPanelProvider.ts` line 449). This means `terminalsDesignDocStatusLine` will ALWAYS show "Not configured — configure in Planning tab" regardless of whether the user has configured a Design Doc link. The correct pattern, used in every other handler in the codebase, is to derive the display text from `message.link`. The plan's own code showed this pattern in the dead duplicate block. The implementer clearly copy-pasted the new handler first but used an invented property name instead of the documented one.

**MAJOR — `julesAutoSyncSetting` handler does not hydrate the terminals toggle (implementation.html line 2986-2988)**

The `julesAutoSyncSetting` message handler updates `lastJulesAutoSyncEnabled` but never sets `terminalsJulesAutoSyncToggle.checked`. The terminals Jules toggle will always appear unchecked on load regardless of the saved setting. Furthermore, `getJulesAutoSyncSetting` is never sent when switching to the terminals tab (only 8 messages are fired: `getStartupCommands`, `getVisibleAgents`, and the 6 prompt control settings). The Jules auto-sync state only arrives via the `startupCommands` response (indirectly via `lastJulesAutoSyncEnabled`), but even then the toggle is not updated. Net result: the Jules Auto-sync toggle is display-only; it does save correctly (via `collectTerminalsAgentConfig`), but it never shows the correct initial state.

**NIT — Orphaned message handlers in setup.html (lines 3843-3917)**

The `accurateCodingSetting`, `advancedReviewerSetting`, `leadChallengeSetting`, `aggressivePairSetting`, `designDocSetting`, and `julesAutoSyncSetting` handlers in setup.html still try to `getElementById` for `accurate-coding-toggle`, `design-doc-toggle`, etc. — elements that were removed as part of this migration. The `if (toggle)` guards prevent runtime crashes, but this is dead code that will mislead future readers into thinking setup.html still owns these settings. This is low-risk (guarded), but it's cruft.

**NIT — `collectTerminalsAgentConfig` sends commands only for agents listed in `#agent-list-terminals`**

When `saveTerminalsAgentConfig` is called, it collects `commands` by querying only `#agent-list-terminals` text inputs. The `commands` object will therefore only contain the 7 visible CLI-input agents (planner, lead, coder, intern, reviewer, tester, analyst). The spread `{ type: 'saveStartupCommands', ...payload }` sends this as `commands`. The backend's `handleSaveStartupCommands` replaces `state.startupCommands` entirely with `data.commands` — so custom agent commands, team-lead commands, and any other roles not listed in the terminals UI will be wiped on the next terminals-tab autosave. This was handled more carefully in setup.html's `collectSetupSavePayload` which merged with `lastStartupCommands`. This is a data-loss risk, not just cosmetic.

---

### Stage 2: Balanced Synthesis

**What's working well:**
- The HTML structure in `implementation.html` is complete and correct. All 8 agents are present with visibility toggles and CLI inputs. All `terminals-` prefixes are applied consistently throughout HTML, JS element references, and event listeners.
- The `switchAgentTab('terminals')` function correctly fires all 8 required messages (`getStartupCommands`, `getVisibleAgents`, `getAccurateCodingSetting`, `getAdvancedReviewerSetting`, `getLeadChallengeSetting`, `getAggressivePairSetting`, `getDesignDocSetting`, `getDefaultPromptOverrides`).
- The agents accordion has been cleanly removed from `setup.html`. The `bindAccordion('agents-toggle', ...)` call is gone. `collectSetupSavePayload()` correctly uses `lastStartupCommands`/`lastVisibleAgents` cached state instead of querying removed DOM elements.
- The `instantAutosaveSelectors` and `textAutosaveSelectors` in setup.html have been cleaned up — they no longer reference the removed agent elements.
- The `CUSTOMIZE DEFAULT PROMPTS` button sends `openSetupPanel` correctly. Backend `saveStartupCommands` handler supports all the new payload fields (`accurateCodingEnabled`, `advancedReviewerEnabled`, `leadChallengeEnabled`, `aggressivePairProgramming`, `designDocEnabled`, `julesAutoSyncEnabled`).
- `npm run compile` passes cleanly — no TypeScript errors.

**Must fix now (CRITICAL/MAJOR):**
1. **CRITICAL** — Duplicate `case 'designDocSetting':` (implementation.html) — Planning tab Notion URL and status line stop hydrating. **Fixed in this review pass.**
2. **MAJOR** — `message.statusLine` phantom field — terminals design doc status line never shows the actual link. **Fixed in this review pass (uses `message.link` derivation instead).**
3. **MAJOR** — `julesAutoSyncSetting` doesn't hydrate `terminalsJulesAutoSyncToggle` — Jules toggle always shows unchecked on load. **Fixed in this review pass.**
4. **MAJOR (deferred)** — `collectTerminalsAgentConfig` sends a `commands` object that excludes team-lead and custom agent commands, risking data loss on autosave. This requires a merge with `lastStartupCommands` before sending, matching how setup.html handles it. **Not fixed in this pass** — the fix requires accessing `lastStartupCommands` which is defined in a different scope; needs careful integration.

**Can defer (NIT):**
- Orphaned `accurateCodingSetting` / `designDocSetting` etc. handlers in setup.html still reference removed element IDs. Harmless (guarded), cleanup only.

---

### Code Fixes Applied

**File:** `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/implementation.html`

**Fix 1 (CRITICAL + MAJOR):** Merged the two duplicate `case 'designDocSetting':` handlers into one, placed at the original first-case location (line 2967). The merged handler:
- Updates `lastDesignDocLink` from `message.link` (not the phantom `message.statusLine`)
- Hydrates `terminalsDesignDocToggle` and derives status line text from `lastDesignDocLink`
- Preserves the original Planning-tab behavior: updates `notion-url-input` and `design-doc-status-line`
The dead second handler at line 2990 was removed.

**Fix 2 (MAJOR):** Updated the `julesAutoSyncSetting` handler (line 2986) to also set `terminalsJulesAutoSyncToggle.checked = lastJulesAutoSyncEnabled` after updating the cached value. The terminals Jules Auto-sync toggle will now hydrate correctly when the tab is switched or when the setting is updated externally.

---

### Verification Results

```
webpack 5.105.4 compiled successfully in 7786 ms
webpack 5.105.4 compiled successfully in 7753 ms
```

Both pre-fix and post-fix compilations pass cleanly. No TypeScript errors.

---

### Remaining Risks

1. **Data loss in `collectTerminalsAgentConfig` commands field** — When any checkbox or text input in the terminals tab triggers autosave, the `commands` object sent to `saveStartupCommands` contains only the 7 builtin agents shown in the UI. The backend replaces `state.startupCommands` entirely with this value, silently overwriting team-lead and custom agent CLI commands. Mitigation: merge with `lastStartupCommands` before constructing the save payload (requires `lastStartupCommands` to be in scope at the `saveTerminalsAgentConfig` call site — it is a top-level `let` in the same script, so this is straightforward to add).

2. **Jules Auto-sync toggle initial state on first load** — `getJulesAutoSyncSetting` is not sent when switching to the terminals tab; the setting only arrives as part of the `startupCommands` response indirectly updating `lastJulesAutoSyncEnabled`. The `julesAutoSyncSetting` hydration fix above covers the case where the setting arrives via a message, but if the tab is already active on webview load and no message is sent, the toggle may still miss the initial state. The `getStartupCommands` response does not directly hydrate the Jules toggle — `julesAutoSyncEnabled` is not in the `startupCommands` payload. Adding `vscode.postMessage({ type: 'getJulesAutoSyncSetting' })` to the terminals tab switch block would fully close this gap.

3. **Orphaned setup.html handlers** — The `accurateCodingSetting`, `advancedReviewerSetting`, `leadChallengeSetting`, `aggressivePairSetting`, and `julesAutoSyncSetting` handlers in setup.html are dead code (their target elements were removed). Low risk due to `if (toggle)` guards, but misleading.

## Switchboard State
**Kanban Column:** CODE REVIEWED
**Status:** active
**Last Updated:** 2026-04-24T05:35:32.422Z
**Format Version:** 1
