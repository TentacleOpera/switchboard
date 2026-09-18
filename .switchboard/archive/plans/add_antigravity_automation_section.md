# Add Antigravity Automation Section to Kanban Tab

## Goal
Add a new "Antigravity automation" section at the top of the automation tab in kanban.html that allows the user to select an agent from the enabled agents tab and copy a prompt for that agent (using the prompts tab configuration) for the oldest plan in the 'CREATED' column.

## Metadata
- **Tags:** [frontend, backend, UI, workflow]
- **Complexity:** 5

## User Review Required
- Confirm the target column for "oldest plan" is 'CREATED' (plans ready to be dispatched). Alternative: 'PLAN REVIEWED'.
- Confirm whether custom agents should appear in the dropdown alongside built-in agents.

## Complexity Audit

### Routine
- Adding a new subsection div to the automation panel (follows existing `db-subsection` pattern)
- Populating a `<select>` from `lastVisibleAgents` (existing pattern used throughout kanban.html)
- Adding a `case` to the `_handleMessage` switch statement (standard pattern)
- Renaming the automation rules header text
- Copy-to-clipboard with visual feedback (existing pattern in kanban.html)

### Complex / Risky
- Mapping `KanbanPlanRecord` → `BatchPromptPlan` correctly (field name differences: `planFile` vs `absolutePath`, string `createdAt` vs numeric sort)
- Loading comprehensive role config via `_getPromptsConfig()` rather than manual addon plucking — must match the same options the prompts tab preview uses
- Handling custom agents: mapping agent name → role to fetch the correct prompts config
- Button selector reliability: must use a unique ID to avoid matching wrong elements in the automation panel

## Edge-Case & Dependency Audit

- **Race Conditions**: Button `disabled = true` guard prevents double-click. No other race condition risk since this is a single fire-and-forget prompt generation.
- **Security**: No user input is executed or evaluated. Agent name comes from `lastVisibleAgents` (controlled by backend). Prompt text is generated server-side and only copied to clipboard.
- **Side Effects**: None — this is read-only (generates a prompt and copies to clipboard). Does not move plans, create files, or modify state.
- **Dependencies & Conflicts**: Depends on `buildKanbanBatchPrompt` signature remaining stable. Depends on `_getPromptsConfig()` returning the expected shape. No conflict with existing automation rules.

## Dependencies
- None

## Adversarial Synthesis
Key risks: incorrect method names in the original plan (`handleKanbanMessage` → `_handleMessage`, `_postKanbanMessage` → `this._panel?.webview.postMessage`, `KanbanDatabase.forWorkspace` → `this._getKanbanDb`), 'planned' column doesn't exist (should be 'CREATED'), and `KanbanPlanRecord.absolutePath` doesn't exist (must construct from `planFile`). Mitigations: corrected all method names to match actual codebase, clarified column name, fixed field mapping, and switched to `_getPromptsConfig()` for comprehensive role config loading.

## Proposed Changes

### 1. Add Antigravity Automation Section to Frontend
**File:** `src/webview/kanban.html`

**Location:** In the `createAutobanPanel()` function, add the new section before the existing automation rules section (before line 5416, before `const automationRulesSection = ...`).

**New Section Structure:**
```javascript
// Add before line 5416 (before automationRulesSection)
const antigravitySection = document.createElement('div');
antigravitySection.className = 'db-subsection';
container.appendChild(antigravitySection);

const antigravityHeader = document.createElement('div');
antigravityHeader.className = 'subsection-header';
const antigravitySpan = document.createElement('span');
antigravitySpan.textContent = 'ANTIGRAVITY AUTOMATION';
antigravityHeader.appendChild(antigravitySpan);
antigravitySection.appendChild(antigravityHeader);

const antigravityDesc = document.createElement('div');
antigravityDesc.style.cssText = 'padding:0 8px; font-family:var(--font-mono); font-size:10px; color:var(--text-secondary); margin-bottom:8px;';
antigravityDesc.textContent = 'Select an agent and copy a prompt (using prompts tab configuration) for the oldest plan in the CREATED column.';
antigravitySection.appendChild(antigravityDesc);

const antigravityActions = document.createElement('div');
antigravityActions.style.cssText = 'padding:0 8px; display:flex; gap:8px; align-items:center;';
antigravitySection.appendChild(antigravityActions);

const agentSelect = document.createElement('select');
agentSelect.style.cssText = 'background:var(--panel-bg2); border:1px solid var(--border-color); color:var(--text-primary); font-family:var(--font-mono); font-size:10px; padding:2px 4px; border-radius:3px; flex:1;';
guardInteraction(agentSelect);

// Populate with enabled agents from lastVisibleAgents
const enabledAgents = Object.keys(lastVisibleAgents || {}).filter(name => lastVisibleAgents[name] !== false);
enabledAgents.forEach(agentName => {
    const opt = document.createElement('option');
    opt.value = agentName;
    opt.textContent = agentName;
    agentSelect.appendChild(opt);
});

antigravityActions.appendChild(agentSelect);

const copyPromptBtn = document.createElement('button');
copyPromptBtn.className = 'strip-btn';
copyPromptBtn.id = 'antigravity-copy-prompt-btn';  // Unique ID for reliable selection
copyPromptBtn.textContent = 'COPY PROMPT';
copyPromptBtn.style.cssText = 'font-family:var(--font-mono); font-size:10px;';
copyPromptBtn.addEventListener('click', async () => {
    try {
        const selectedAgent = agentSelect.value;
        if (!selectedAgent) {
            console.error('No agent selected');
            return;
        }

        copyPromptBtn.textContent = 'LOADING...';
        copyPromptBtn.disabled = true;

        // Request the prompt for the selected agent using prompts tab configuration
        postKanbanMessage({
            type: 'generateAntigravityPrompt',
            agent: selectedAgent
        });

        // The response will be handled via a new message listener case
    } catch (err) {
        console.error('Failed to generate prompt:', err);
        copyPromptBtn.textContent = 'COPY PROMPT';
        copyPromptBtn.disabled = false;
    }
});
antigravityActions.appendChild(copyPromptBtn);
```

**Key corrections from original plan:**
- Added `copyPromptBtn.id = 'antigravity-copy-prompt-btn'` for reliable selection (avoids fragile `.strip-btn` querySelector)
- Changed `lastVisibleAgents[name]` to `lastVisibleAgents[name] !== false` to match the actual pattern used elsewhere (e.g., line 3619, 3642)
- Clarified column name in description text: 'CREATED' not 'planned'

### 2. Add Message Listener for Antigravity Prompt Response
**File:** `src/webview/kanban.html`

**Location:** Add to the MAIN `window.addEventListener('message', ...)` block starting at line 4530 (inside the `switch (msg.type)` statement), NOT the secondary listener at line 5768.

**Add new case inside the switch statement (e.g., after the `settingResult` case around line 4605):**
```javascript
case 'antigravityPrompt': {
    const copyPromptBtn = document.getElementById('antigravity-copy-prompt-btn');
    if (copyPromptBtn && msg.prompt) {
        navigator.clipboard.writeText(msg.prompt).then(() => {
            copyPromptBtn.textContent = 'COPIED!';
            setTimeout(() => {
                copyPromptBtn.textContent = 'COPY PROMPT';
                copyPromptBtn.disabled = false;
            }, 2000);
        }).catch(err => {
            console.error('Failed to copy prompt:', err);
            copyPromptBtn.textContent = 'ERROR';
            setTimeout(() => {
                copyPromptBtn.textContent = 'COPY PROMPT';
                copyPromptBtn.disabled = false;
            }, 2000);
        });
    } else if (copyPromptBtn) {
        copyPromptBtn.textContent = msg.error ? 'NO PLANS' : 'ERROR';
        setTimeout(() => {
            copyPromptBtn.textContent = 'COPY PROMPT';
            copyPromptBtn.disabled = false;
        }, 2000);
    }
    break;
}
```

**Key corrections from original plan:**
- Uses `document.getElementById('antigravity-copy-prompt-btn')` instead of fragile `document.querySelector('#automation-panel-root .strip-btn')`
- Placed in the main message listener (line 4530) instead of the secondary one (line 5768)
- Added `break;` statement (was missing in original)
- Shows 'NO PLANS' when `msg.error` is present, giving the user more context than just 'ERROR'

### 3. Add Backend Handler for Antigravity Prompt Generation
**File:** `src/services/KanbanProvider.ts`

**Location:** Add a new `case` to the `_handleMessage` method's switch statement (line 3688). Add it near the other message handlers (e.g., after `getPromptPreview` around line 5478).

**Add new case:**
```typescript
case 'generateAntigravityPrompt': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    if (!workspaceRoot || typeof msg.agent !== 'string') break;
    await this._generateAntigravityPrompt(msg.agent, workspaceRoot);
    break;
}
```

**Add new method:**
```typescript
private async _generateAntigravityPrompt(agentName: string, workspaceRoot: string): Promise<void> {
    try {
        if (!agentName) {
            this._panel?.webview.postMessage({
                type: 'antigravityPrompt',
                prompt: null,
                error: 'No agent specified'
            });
            return;
        }

        // Get the oldest plan in the 'CREATED' column
        const db = this._getKanbanDb(workspaceRoot);
        if (!await db.ensureReady()) {
            this._panel?.webview.postMessage({
                type: 'antigravityPrompt',
                prompt: null,
                error: 'Database not available'
            });
            return;
        }

        const workspaceId = await this._readWorkspaceId(workspaceRoot)
            || await db.getWorkspaceId()
            || await db.getDominantWorkspaceId();

        if (!workspaceId) {
            this._panel?.webview.postMessage({
                type: 'antigravityPrompt',
                prompt: null,
                error: 'No workspace ID found'
            });
            return;
        }

        // Query for plans in 'CREATED' column
        const createdPlans = await db.getPlansByColumn(workspaceId, 'CREATED');

        if (!createdPlans || createdPlans.length === 0) {
            this._panel?.webview.postMessage({
                type: 'antigravityPrompt',
                prompt: null,
                error: 'No plans found in CREATED column'
            });
            return;
        }

        // Sort by creation timestamp (oldest first) — createdAt is a string
        createdPlans.sort((a, b) => {
            const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
            const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
            return aTime - bTime;
        });
        const oldestPlan = createdPlans[0];

        // Convert KanbanPlanRecord to BatchPromptPlan
        // NOTE: KanbanPlanRecord has planFile (relative), BatchPromptPlan needs absolutePath
        const plans: BatchPromptPlan[] = [{
            sessionId: oldestPlan.sessionId,
            topic: oldestPlan.topic,
            absolutePath: path.resolve(workspaceRoot, oldestPlan.planFile),
            complexity: oldestPlan.complexity !== 'Unknown' ? oldestPlan.complexity : undefined,
            dependencies: oldestPlan.dependencies || undefined,
            workingDir: resolveWorkingDir(workspaceRoot, oldestPlan.repoScope) || undefined
        }];

        // Map agent name to role (for custom agents, use their role)
        let role = agentName;
        const customAgents = await this._getCustomAgents(workspaceRoot);
        const customAgent = customAgents.find(a => a.name === agentName);
        if (customAgent && customAgent.role) {
            role = customAgent.role;
        }

        // Use _getPromptsConfig for comprehensive role config loading
        // (matches what the prompts tab preview uses — includes all addon flags)
        const promptsConfig = await this._getPromptsConfig(workspaceRoot);
        const defaultPromptOverrides = await this._getDefaultPromptOverrides(workspaceRoot);

        // Build options from prompts config (mirrors getPromptPreview handler logic)
        const options: any = {
            workspaceRoot,
            defaultPromptOverrides,
            clearAntigravityContext: promptsConfig.clearAntigravityContextByRole?.[role] ?? false,
            gitProhibitionEnabled: promptsConfig.gitProhibitionByRole?.[role] ?? true,
            switchboardSafeguardsEnabled: promptsConfig.switchboardSafeguardsByRole?.[role] ?? true,
            advancedReviewerEnabled: role === 'reviewer' ? promptsConfig.advancedReviewerEnabled : undefined,
            dependencyCheckEnabled: role === 'planner' ? promptsConfig.dependencyCheckEnabled : undefined,
            aggressivePairProgramming: role === 'planner' ? promptsConfig.aggressivePairProgrammingEnabled : undefined,
            splitPlan: role === 'planner' ? promptsConfig.splitPlanEnabled : undefined,
        };

        // Generate prompt using actual prompts tab configuration
        const prompt = buildKanbanBatchPrompt(role, plans, options);

        this._panel?.webview.postMessage({
            type: 'antigravityPrompt',
            prompt
        });
    } catch (error) {
        console.error('[KanbanProvider] Failed to generate antigravity prompt:', error);
        this._panel?.webview.postMessage({
            type: 'antigravityPrompt',
            prompt: null,
            error: String(error)
        });
    }
}
```

**Key corrections from original plan:**
- Uses `_handleMessage` (not `handleKanbanMessage`)
- Uses `this._getKanbanDb(workspaceRoot)` (not `KanbanDatabase.forWorkspace(workspaceRoot)`)
- Uses `this._panel?.webview.postMessage(...)` (not `this._postKanbanMessage(...)`)
- Uses `this._resolveWorkspaceRoot(msg.workspaceRoot)` for workspace resolution
- Uses `this._readWorkspaceId()` + fallback chain (matches existing pattern at line 5652)
- Column is 'CREATED' (not 'planned')
- `createdAt` is sorted as `new Date(a.createdAt).getTime()` (not numeric subtraction on strings)
- `absolutePath` is constructed via `path.resolve(workspaceRoot, oldestPlan.planFile)` (not `oldestPlan.absolutePath` which doesn't exist)
- Includes `workingDir` from `resolveWorkingDir(workspaceRoot, oldestPlan.repoScope)` (was missing)
- Includes `complexity` and `dependencies` fields in `BatchPromptPlan` (were missing)
- Uses `_getPromptsConfig()` for comprehensive role config loading (not manual addon plucking from `_getSetting`)
- Uses `_getDefaultPromptOverrides()` for prompt overrides (was missing)
- Adds `db.ensureReady()` check before querying (was missing)

### 4. Rename Automation Rules Header
**File:** `src/webview/kanban.html`

**Location:** Line 5423 in the `createAutobanPanel()` function.

**Change:**
```javascript
// Before:
automationRulesSpan.textContent = 'AUTOMATION RULES';

// After:
automationRulesSpan.textContent = 'KANBAN AUTOMATION RULES';
```

## Verification Plan

### Automated Tests
- No automated tests are proposed for this UI feature. Manual verification is required.

### Manual Testing Steps
1. Open the kanban webview
2. Navigate to the Automation tab
3. Verify the new "ANTIGRAVITY AUTOMATION" section appears at the top
4. Verify the explanatory sentence is displayed
5. Verify the agent dropdown is populated with enabled agents from the agents tab
6. Ensure there is at least one plan in the 'CREATED' column of the kanban database
7. Select an agent from the dropdown
8. Click the "COPY PROMPT" button
9. Verify the button text changes to "LOADING..." while generating
10. Verify the button text changes to "COPIED!" briefly, then back to "COPY PROMPT"
11. Paste from clipboard to verify the prompt was generated for the selected agent
12. Verify the prompt uses the add-on configuration from the prompts tab for that agent (not hardcoded)
13. Verify the prompt references the oldest plan in the CREATED column
14. Test with different agents — verify each uses its respective prompts tab configuration
15. Test with no plans in CREATED column — verify error handling (button shows "NO PLANS" briefly)
16. Verify the existing automation rules section now shows "KANBAN AUTOMATION RULES" instead of "AUTOMATION RULES"
17. Verify all existing automation rules functionality still works (batch size, complexity, routing, max sends, column rules, terminal pools)

## Notes
- The new section uses the same styling pattern as other subsections in the kanban tab
- The copy button provides visual feedback during generation (LOADING...) and after copy (COPIED!)
- The agent dropdown is populated from `lastVisibleAgents` (enabled agents from the agents tab)
- The prompt is dynamically generated by the backend using `buildKanbanBatchPrompt` with the selected agent's prompts tab configuration via `_getPromptsConfig()`
- Add-ons are NOT hardcoded — they are read from the actual prompts config (`_getPromptsConfig()`) for the selected agent, matching the same logic the prompts tab preview uses
- For custom agents, the backend maps the agent name to its underlying role to fetch the correct prompts tab configuration
- The backend queries the kanban database for the oldest plan in the 'CREATED' column (sorted by `createdAt` ascending)
- Error handling is included for cases where no plans exist in the CREATED column, no agent is selected, or the database is unavailable
- The existing automation rules section is preserved with only the header text changed
- The `antigravity-copy-prompt-btn` ID ensures reliable button selection even if other `.strip-btn` elements are added to the automation panel

## Reviewer Pass Results

### Stage 1: Grumpy Principal Engineer Findings

| # | Severity | Finding | Location |
|---|----------|---------|----------|
| 1 | **MAJOR** | Missing `plannerWorkflowPath` in options — antigravity prompt for planner role diverges from prompts tab preview | `KanbanProvider.ts:2341` |
| 2 | **MAJOR** | Using raw `path.resolve` instead of `this._resolvePlanFilePath` — edge case bug if `planFile` is empty (returns workspaceRoot as path) + inconsistency with codebase pattern | `KanbanProvider.ts:2321` |
| 3 | **NIT** | Unnecessary `as any` cast on `role` parameter — `buildKanbanBatchPrompt` accepts `string`, no cast needed | `KanbanProvider.ts:2359` |
| 4 | **NIT** | `options` typed as `any` instead of `PromptBuilderOptions` | `KanbanProvider.ts:2341` |
| 5 | **NIT** | Redundant `workspaceRoot: getActiveWorkspaceRoot()` in `postKanbanMessage` call (function already injects it) | `kanban.html:5532` |

### Stage 2: Balanced Synthesis — Actions Taken

| Finding | Action | Rationale |
|---------|--------|-----------|
| Missing `plannerWorkflowPath` | **Fixed** | Direct behavioral divergence — planner prompts would be missing custom workflow path |
| `path.resolve` vs `_resolvePlanFilePath` | **Fixed** | Edge case bug + inconsistency with established pattern across codebase |
| `as any` cast | **Fixed** | Trivial removal, improves type safety |
| `options: any` | Deferred | Low risk, would require import adjustment |
| Redundant `workspaceRoot` | Deferred | Harmless, not worth diff noise |

### Files Changed

- `src/services/KanbanProvider.ts` — 3 fixes applied:
  1. Added `plannerWorkflowPath: role === 'planner' ? promptsConfig.plannerWorkflowPath : undefined` to options object (line 2351)
  2. Changed `path.resolve(workspaceRoot, oldestPlan.planFile)` → `this._resolvePlanFilePath(workspaceRoot, oldestPlan.planFile)` (line 2321)
  3. Removed unnecessary `as any` cast: `buildKanbanBatchPrompt(role as any, ...)` → `buildKanbanBatchPrompt(role, ...)` (line 2360)

### Validation Results

- **TypeScript typecheck**: `npx tsc --noEmit` — no new errors introduced. Pre-existing errors in `ClickUpSyncService.ts` and `KanbanProvider.ts:4410` (unrelated import path issues) remain.
- **Frontend (kanban.html)**: No changes needed — all frontend implementation matches plan spec correctly.
- **Backend (KanbanProvider.ts)**: `_handleMessage` case, `_generateAntigravityPrompt` method, error handling, DB access patterns, custom agent mapping, and options construction all verified correct after fixes.

### Remaining Risks

- `options: any` type annotation means future option additions won't be caught by the compiler if they don't match `PromptBuilderOptions`. Low risk since the options are now fully mirroring `getPromptPreview`.
- No automated test coverage for this UI feature (as noted in plan). Manual testing per the verification plan is required.

## Recommendation
Complexity 5 → **Send to Coder**
