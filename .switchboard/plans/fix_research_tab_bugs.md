# Fix Research Tab Bugs in Planning Panel

## Goal
Fix three UX bugs in the Research tab: (1) missing AGENTS.md documentation for web_research and deep_planning skills, (2) non-functional mode switch with confusing panel layout, (3) hardcoded save location ignoring user-configured local docs folder.

## Metadata
**Tags:** frontend, UI, bugfix, documentation
**Complexity:** 3
**Repo:** switchboard

---

## User Review Required
No breaking changes. Users will see unified Research Mode panel and working mode switch. Previously copied prompts may have referenced wrong skill if mode switch was in wrong state.

## Complexity Audit

### Routine
- Add 2 rows to AGENTS.md skills table (single file, localized change)
- Consolidate HTML panels into single structure (markup only, preserve all IDs)
- Replace two button handlers with single handler (reuse existing clipboard logic)
- Update description text for Import Options (text change only)
- Add state variable for researchMode (standard JS pattern)
- Add placeholder message handlers for analyst integration (deferred to separate plan)

### Complex / Risky
- State persistence across webview lifecycle (requires vscode.setState/getState integration)
- Dynamic save location from LocalFolderService with fallback handling (state synchronization between tabs)
- Accessibility compliance for mode switch (aria-live regions, aria-describedby linkage)

**Note:** Analyst terminal integration is deferred to separate plan `add_analyst_integration_to_planning_panel.md` (Complexity 3) to follow existing VS Code command pattern used by KanbanProvider.

## Edge-Case & Dependency Audit

**Race Conditions:**
- User changes Local Docs folder path while Research tab is open. `handleLocalFolderPathUpdated()` receives message but `generateResearchPrompt()` may use stale value. **Mitigation:** Store path in state AND re-query on each prompt generation.
- Webview destroyed/recreated (panel hidden then shown). `researchMode` state resets to default. **Mitigation:** Persist mode preference via `vscode.setState()` and restore in `init()`.

**Security:**
- Path traversal not applicable — LocalFolderService already validates paths in `fetchDocContent()` (lines 177-181)
- No user input directly interpolated into shell commands

**Side Effects:**
- Analyst availability check runs on every panel load — minimal overhead, cached result
- Mode switch UI change affects muscle memory for existing users

**Dependencies & Conflicts:**
No active conflicts detected in Kanban "New" or "Planned" columns. The related "Research Tab for Planning View" plan (sess_1777415652953) is in CODE REVIEWED status — implementation complete, no overlap concerns.

## Dependencies
None

## Adversarial Synthesis
Key risks: State staleness when Local Docs folder changes mid-session; analyst button may appear enabled but terminal unavailable; mode preference lost on webview reload. Mitigations: Re-query folder path before prompt generation; check both config and runtime availability; use vscode.setState for persistence.

---

## Issues Summary

### Issue 1: Missing AGENTS.md Documentation
**Problem**: The `web_research` and `deep_planning` skills exist as skill files in `.agent/skills/` but are not documented in `AGENTS.md`, making them hard to discover.

**Location**: 
- Skills exist at: `.agent/skills/web_research.md` and `.agent/skills/deep_planning.md`
- Missing from: `AGENTS.md` Available Skills table (lines 70-84)

### Issue 2: Research Mode Switch Does Nothing + Confusing Panel Layout
**Problem**: 
- The "RESEARCH MODE" segmented control (Web Research / Deep Planning) toggles visual state but doesn't affect behavior
- Both "COPY WEB RESEARCH PROMPT" and "COPY DEEP PLANNING PROMPT" buttons exist and both call `generateResearchPrompt()` which dynamically reads the mode
- Having separate panels for "RESEARCH PROMPTS" and "RESEARCH MODE" is confusing

**Current Code Locations**:
- `src/webview/planning.html:1233-1297` - Research tab content with separate panels
- `src/webview/planning.js:20-28` - Segmented control click handler (only toggles visual state)
- `src/webview/planning.js:92-136` - Two separate copy buttons, both calling `generateResearchPrompt()`
- `src/webview/planning.js:1614-1650` - Prompt generation function that reads mode dynamically

**User Requested Behavior**:
- Single unified "Research Mode" panel
- Mode switch changes the prompt content
- Only two action buttons:
  1. "Copy Prompt" - copies the generated prompt to clipboard
  2. "Send to Analyst" - sends prompt to analyst terminal (only visible if analyst available)

### Issue 3: Import Options Saves to Wrong Location
**Problem**: The prompt hardcodes save location as `.switchboard/docs/` for web research and `.switchboard/plans/` for deep planning, ignoring the user's configured local docs folder.

**Current Code Location**:
- `src/webview/planning.js:1636` - Hardcoded paths:
  ```javascript
  const saveLocation = isWebMode ? '.switchboard/docs/' : '.switchboard/plans/';
  ```

**Required Behavior**: Use the dynamically configured local docs folder path from the Local Docs tab (configured via `switchboard.research.localFolderPath` setting, managed by `LocalFolderService`).

**Related Code**:
- `src/services/LocalFolderService.ts:63-67` - `getFolderPath()` method
- `src/services/PlanningPanelProvider.ts:873-917` - `_sendLocalDocsReady()` sends `folderPath` to webview
- `src/webview/planning.js:962-967` - `handleLocalFolderPathUpdated()` receives path

---

## Implementation Plan

### Phase 1: Add Skills to AGENTS.md Documentation

**File**: `AGENTS.md` (lines 70-84)

**Changes**:
1. Add two new rows to the Available Skills table:
   - `web_research` | User asks to "research X", "investigate Y", or needs authoritative sources
   - `deep_planning` | User requests complex code changes requiring architecture understanding

**Verification**: Read AGENTS.md and confirm skills appear in the table with proper descriptions.

---

### Phase 2: Consolidate Research UI and Fix Mode Switch

**Files**: 
- `src/webview/planning.html` (lines 1233-1297)
- `src/webview/planning.js` (multiple locations)

**HTML Changes** (`planning.html`):

Replace the current two-panel structure:
```html
<!-- CURRENT (lines 1233-1297) -->
<div id="research-content" class="research-tab-content">
    <div class="planning-card">
        <div class="planning-card-header">RESEARCH PROMPTS</div>
        <div class="prompt-buttons-container">
            <button id="btn-copy-web-research">COPY WEB RESEARCH PROMPT</button>
            <button id="btn-copy-deep-planning">COPY DEEP PLANNING PROMPT</button>
        </div>
    </div>
    <div class="planning-card">
        <div class="planning-card-header">RESEARCH MODE</div>
        <div class="segmented-control">
            <button class="segmented-btn active" data-mode="web">WEB RESEARCH</button>
            <button class="segmented-btn" data-mode="deep">DEEP PLANNING</button>
        </div>
    </div>
    <!-- ... complexity and import cards ... -->
</div>
```

With unified single-panel structure:
```html
<!-- NEW -->
<div id="research-content" class="research-tab-content">
    <div class="planning-card">
        <div class="planning-card-header">RESEARCH MODE</div>
        <div class="planning-card-description">Select research mode and configure options. The generated prompt will guide the AI through the selected research protocol.</div>
        
        <!-- Mode Switch -->
        <div class="segmented-control">
            <button class="segmented-btn active" data-mode="web">WEB RESEARCH</button>
            <button class="segmented-btn" data-mode="deep">DEEP PLANNING</button>
        </div>
        
        <!-- Mode Description -->
        <div id="research-mode-description" class="mode-description">
            Comprehensive web research on any topic using iterative search strategies.
        </div>
        
        <!-- Action Buttons -->
        <div class="prompt-buttons-container">
            <button id="btn-copy-research-prompt" class="planning-button">COPY PROMPT</button>
            <button id="btn-send-to-analyst" class="planning-button secondary" style="display: none;">SEND TO ANALYST</button>
        </div>
    </div>
    <!-- ... complexity and import cards remain ... -->
</div>
```

**JavaScript Changes** (`planning.js`):

1. **Update segmented control handler** (lines 20-28) to:
   - Keep visual toggle
   - Update mode description text
   - Store current mode in state variable

2. **Replace two copy button handlers** (lines 92-136) with single handler:
   - Remove `btn-copy-web-research` and `btn-copy-deep-planning` handlers
   - Add single `btn-copy-research-prompt` handler that uses stored mode

3. **Add analyst availability check**:
   - Post message to backend to check if analyst terminal is available
   - Show/hide "Send to Analyst" button based on response
   - Add handler for "Send to Analyst" button

4. **Update `generateResearchPrompt()`** to use stored mode instead of reading from DOM

**New State Variable**:
```javascript
const state = {
    // ... existing state ...
    researchMode: 'web', // 'web' | 'deep'
    analystAvailable: false
};
```

**Backend Changes** (`PlanningPanelProvider.ts`):

1. Add handler for `'checkAnalystAvailability'` message type
2. Check if analyst agent is available (use existing `_getVisibleAgents()` pattern from line 2505)
3. Return availability status to webview

---

### Phase 3: Fix Import Options Save Location

**File**: `src/webview/planning.js`

**Current Code** (lines 1636-1644):
```javascript
const saveLocation = isWebMode ? '.switchboard/docs/' : '.switchboard/plans/';
// ...
if (importEnabled) {
    prompt += `IMPORTANT: After completing the ${isWebMode ? 'research' : 'plan'}, ${saveAction} to the local ${saveLocation} folder using the write_to_file tool so I can review them later.\n\n`;
}
```

**Required Changes**:

1. **Store local folder path when received**:
   - In `handleLocalFolderPathUpdated()` (line 962), store `folderPath` in state
   - In `handleLocalDocsReady()` (line 650), store `folderPath` in state

2. **Update `generateResearchPrompt()`** to use stored folder path:
   ```javascript
   function generateResearchPrompt() {
       const complexityInput = document.querySelector('input[name="complexity"]:checked');
       const importToggle = document.getElementById('import-toggle');
       
       const complexity = complexityInput ? complexityInput.value : 'quick';
       const importEnabled = importToggle ? importToggle.checked : false;
       const mode = state.researchMode; // Use stored mode instead of reading DOM
       
       // ... complexityLabels ...
       
       const isWebMode = mode === 'web';
       const skillName = isWebMode ? 'web_research' : 'deep_planning';
       const taskType = isWebMode ? 'conduct comprehensive research on the following topic' : 'create a comprehensive implementation plan for the following task';
       const depthLabel = isWebMode ? 'Research depth' : 'Planning depth';
       
       // Use configured local docs folder path instead of hardcoded
       const saveLocation = state.localFolderPath || '.switchboard/docs/';
       const saveAction = 'save the results';
       const protocolAction = isWebMode ? 'proposing a research plan' : 'proposing a planning approach';
       
       let prompt = `Use the ${skillName} skill to ${taskType}.\n\n`;
       prompt += `${depthLabel}: ${complexityLabels[complexity] || complexity}\n\n`;
       
       if (importEnabled) {
           prompt += `IMPORTANT: After completing the ${isWebMode ? 'research' : 'plan'}, ${saveAction} to ${saveLocation} using the write_to_file tool so I can review them later.\n\n`;
       }
       
       prompt += `Please begin by ${protocolAction} for my approval, following the ${skillName} skill protocol.`;
       
       return prompt;
   }
   ```

3. **Update Import Options description** (`planning.html` line 1282-1283):
   - Change from: "save research results to your local `.switchboard/docs/` folder"
   - To: "save research results to your configured local docs folder"

---

## Verification Steps

1. **Documentation**:
   - [ ] Open AGENTS.md and verify `web_research` and `deep_planning` appear in Skills table (lines 70-84)
   - [ ] Verify skill files exist at `.agent/skills/web_research.md` and `.agent/skills/deep_planning.md`

2. **Research Tab UI**:
   - [ ] Open Planning Panel → Research tab
   - [ ] Verify single unified panel (not two separate panels)
   - [ ] Verify mode switch shows Web Research / Deep Planning options
   - [ ] Verify mode description updates when switching (dynamic text change)
   - [ ] Verify "COPY PROMPT" button exists with proper `aria-describedby`
   - [ ] Verify "SEND TO ANALYST" button appears when analyst terminal available

3. **Mode Switch Functionality**:
   - [ ] Select "Web Research" mode, click Copy Prompt → verify prompt references `web_research` skill
   - [ ] Select "Deep Planning" mode, click Copy Prompt → verify prompt references `deep_planning` skill
   - [ ] Hide panel, reopen → verify mode preference persists

4. **Save Location**:
   - [ ] Configure Local Docs folder in Local Docs tab
   - [ ] Return to Research tab, enable "Save results locally"
   - [ ] Copy prompt → verify prompt contains the configured folder path (not `.switchboard/docs/`)
   - [ ] Change Local Docs folder, regenerate prompt → verify new path reflected immediately

5. **Accessibility**:
   - [ ] Verify `aria-live="polite"` region announces mode changes
   - [ ] Verify Copy Prompt button has `aria-describedby` linking to mode description

6. **Analyst Integration** (if analyst configured):
   - [ ] Verify "SEND TO ANALYST" button visible when analyst terminal running
   - [ ] Verify button disabled with tooltip when analyst configured but not running
   - [ ] Click button → verify prompt sent to analyst terminal via `sendToAnalyst` message

---

## Proposed Changes

### AGENTS.md

#### [MODIFY] `AGENTS.md` (lines 70-84)

**Context:** Add documentation for existing skills that are discoverable but not documented.

**Logic:**
1. Locate Available Skills table at lines 70-84
2. Add two new rows after existing entries:
   - `web_research` | User asks to "research X", "investigate Y", or needs authoritative sources
   - `deep_planning` | User requests complex code changes requiring architecture understanding

**Implementation:**
```markdown
### 📚 Available Skills

| Skill | When to Use |
|-------|-------------|
| `archive` | User asks to "search archives", "query archives", "find old plans", "export conversation" |
| `review` | User asks to review code changes, a PR, or specific files |
| `kanban_operations` | Move kanban cards or query kanban state via direct database access |
| `query_archive` | Query the DuckDB archive directly using duckdb CLI |
| `complexity_scoring` | Assess and assign numeric complexity scores (1-10) to plans and tasks |
| `web_research` | User asks to "research X", "investigate Y", or needs authoritative sources |
| `deep_planning` | User requests complex code changes requiring architecture understanding |
```

**Edge Cases Handled:**
- Verify skill files exist before documenting (prevent false expectations)
- Use consistent pipe-delimited table format matching existing entries

---

### src/webview/planning.html

#### [MODIFY] `src/webview/planning.html` (lines 1233-1297)

**Context:** Consolidate separate "RESEARCH PROMPTS" and "RESEARCH MODE" panels into unified single-panel layout with integrated mode switch and action buttons.

**Logic:**
1. Replace lines 1233-1297 (entire research-content div)
2. Keep complexity and import options cards unchanged (lines 1256-1293)
3. Add mode description div that updates dynamically
4. Add aria-live region for accessibility

**Implementation:**
```html
<div id="research-content" class="research-tab-content">
    <div class="planning-card">
        <div class="planning-card-header">RESEARCH MODE</div>
        <div class="planning-card-description">Select research mode and configure options. The generated prompt will guide the AI through the selected research protocol.</div>
        
        <!-- Mode Switch -->
        <div class="segmented-control" role="tablist" aria-label="Research mode selection">
            <button class="segmented-btn active" data-mode="web" role="tab" aria-selected="true" aria-controls="research-mode-description">WEB RESEARCH</button>
            <button class="segmented-btn" data-mode="deep" role="tab" aria-selected="false" aria-controls="research-mode-description">DEEP PLANNING</button>
        </div>
        
        <!-- Mode Description -->
        <div id="research-mode-description" class="mode-description" aria-live="polite">
            Comprehensive web research on any topic using iterative search strategies.
        </div>
        
        <!-- Action Buttons -->
        <div class="prompt-buttons-container">
            <button id="btn-copy-research-prompt" class="planning-button" aria-describedby="research-mode-description">COPY PROMPT</button>
            <button id="btn-send-to-analyst" class="planning-button secondary" style="display: none;" title="Send prompt to analyst terminal">SEND TO ANALYST</button>
        </div>
    </div>

    <div class="planning-card">
        <div class="planning-card-header">COMPLEXITY LEVEL</div>
        <!-- existing content unchanged -->
    </div>

    <div class="planning-card">
        <div class="planning-card-header">IMPORT OPTIONS</div>
        <div class="planning-card-description">When enabled, the prompt will instruct the agent to save research results to your configured local docs folder for later viewing.</div>
        <!-- existing toggle unchanged -->
    </div>
</div>
```

**Edge Cases Handled:**
- aria-live region announces mode changes to screen readers
- aria-describedby links Copy Prompt button to mode description
- Button initially hidden, shown only after availability check (prevents flash of unavailability)

---

### src/webview/planning.js

#### [MODIFY] `src/webview/planning.js` - State Management (after line 2)

**Context:** Add state variables for research mode and analyst availability, with VS Code state persistence.

**Logic:**
1. Add state object with researchMode and localFolderPath
2. Restore researchMode from vscode.getState() on init
3. Persist researchMode on mode change

**Implementation:**
```javascript
(function() {
    const vscode = acquireVsCodeApi();
    
    // Restore persisted state
    const persistedState = vscode.getState() || {};
    
    const state = {
        activeRoot: '',
        importedDocs: [],
        researchMode: persistedState.researchMode || 'web',
        localFolderPath: '',
        analystAvailable: false
    };
    
    // ... rest of existing code ...
})();
```

---

#### [MODIFY] `src/webview/planning.js` - Segmented Control Handler (lines 20-28)

**Context:** Update handler to persist mode and update description text.

**Implementation:**
```javascript
// Segmented Control for Research Mode
const segmentedBtns = document.querySelectorAll('.segmented-btn');
const modeDescription = document.getElementById('research-mode-description');

const modeDescriptions = {
    web: 'Comprehensive web research on any topic using iterative search strategies.',
    deep: 'Deep architectural planning for complex code changes with dependency analysis.'
};

segmentedBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        const parent = btn.closest('.segmented-control');
        const mode = btn.dataset.mode;
        
        // Update visual state
        parent.querySelectorAll('.segmented-btn').forEach(b => {
            b.classList.remove('active');
            b.setAttribute('aria-selected', 'false');
        });
        btn.classList.add('active');
        btn.setAttribute('aria-selected', 'true');
        
        // Update state and persist
        state.researchMode = mode;
        vscode.setState({ ...vscode.getState(), researchMode: mode });
        
        // Update description
        if (modeDescription) {
            modeDescription.textContent = modeDescriptions[mode] || modeDescriptions.web;
        }
    });
});

// Initialize mode from state
const initialModeBtn = document.querySelector(`.segmented-btn[data-mode="${state.researchMode}"]`);
if (initialModeBtn && modeDescription) {
    initialModeBtn.click(); // Trigger state synchronization
}
```

---

#### [DELETE] `src/webview/planning.js` - Old Button Handlers (lines 91-137)

**Remove:**
- `copyWebResearchBtn` handler (lines 91-113)
- `copyDeepPlanningBtn` handler (lines 115-137)

#### [CREATE] `src/webview/planning.js` - Unified Button Handlers (after clipboard import logic, ~line 89)

**Implementation:**
```javascript
// Research Tab: Unified Copy Button
const copyResearchPromptBtn = document.getElementById('btn-copy-research-prompt');
if (copyResearchPromptBtn) {
    copyResearchPromptBtn.addEventListener('click', async () => {
        if (copyResearchPromptBtn.innerText === 'COPIED') return;

        const prompt = generateResearchPrompt();
        try {
            await navigator.clipboard.writeText(prompt);
            const originalText = copyResearchPromptBtn.innerText;
            copyResearchPromptBtn.innerText = 'COPIED';
            setTimeout(() => {
                if (copyResearchPromptBtn) copyResearchPromptBtn.innerText = originalText;
            }, 2000);
        } catch (err) {
            console.error('[Research] Failed to copy to clipboard:', err);
            copyResearchPromptBtn.innerText = 'FAILED';
            setTimeout(() => {
                if (copyResearchPromptBtn) copyResearchPromptBtn.innerText = originalText;
            }, 2000);
        }
    });
}

// Research Tab: Send to Analyst Button
const sendToAnalystBtn = document.getElementById('btn-send-to-analyst');
if (sendToAnalystBtn) {
    sendToAnalystBtn.addEventListener('click', () => {
        const prompt = generateResearchPrompt();
        vscode.postMessage({
            type: 'sendToAnalyst',
            prompt: prompt
        });
        sendToAnalystBtn.innerText = 'SENT';
        setTimeout(() => {
            if (sendToAnalystBtn) sendToAnalystBtn.innerText = 'SEND TO ANALYST';
        }, 2000);
    });
}

// Check analyst availability on load
function checkAnalystAvailability() {
    vscode.postMessage({ type: 'checkAnalystAvailability' });
}

// Call after DOM ready
checkAnalystAvailability();
```

---

#### [MODIFY] `src/webview/planning.js` - Store Local Folder Path (line 962, handleLocalFolderPathUpdated)

**Context:** Store received folder path in state for prompt generation.

**Implementation:**
```javascript
function handleLocalFolderPathUpdated(folderPath) {
    console.log('[PlanningPanel] Local folder path updated:', folderPath);
    state.localFolderPath = folderPath || '';
    // ... rest of existing logic ...
}
```

---

#### [MODIFY] `src/webview/planning.js` - Store Local Folder Path (line 650, handleLocalDocsReady)

**Context:** Also store path from localDocsReady message.

**Implementation:**
```javascript
function handleLocalDocsReady(msg) {
    console.log('[PlanningPanel Webview] handleLocalDocsReady called:', msg);
    state.localFolderPath = msg.folderPath || '';
    renderLocalDocs({
        sourceId: msg.sourceId || 'local-folder',
        nodes: msg.nodes || [],
        folderPath: msg.folderPath || '',
        error: msg.error
    });
}
```

---

#### [MODIFY] `src/webview/planning.js` - generateResearchPrompt (lines 1614-1650)

**Context:** Use stored mode and folder path instead of reading from DOM.

**Implementation:**
```javascript
function generateResearchPrompt() {
    const complexityInput = document.querySelector('input[name="complexity"]:checked');
    const importToggle = document.getElementById('import-toggle');
    
    // Use state instead of DOM query for mode
    const complexity = complexityInput ? complexityInput.value : 'quick';
    const importEnabled = importToggle ? importToggle.checked : false;
    const mode = state.researchMode; // Use stored mode

    const complexityLabels = {
        quick: 'Quick (5-10 sources)',
        standard: 'Standard (15-30 sources)',
        deep: 'Deep (50-100+ sources)',
        academic: 'Academic (100-200+ sources)'
    };

    const isWebMode = mode === 'web';
    const skillName = isWebMode ? 'web_research' : 'deep_planning';
    const taskType = isWebMode ? 'conduct comprehensive research on the following topic' : 'create a comprehensive implementation plan for the following task';
    const depthLabel = isWebMode ? 'Research depth' : 'Planning depth';
    
    // Use configured local docs folder path with fallback
    const configuredPath = state.localFolderPath;
    const saveLocation = configuredPath || '[CONFIGURE LOCAL DOCS FOLDER]';
    const saveAction = 'save the results';
    const protocolAction = isWebMode ? 'proposing a research plan' : 'proposing a planning approach';

    let prompt = `Use the ${skillName} skill to ${taskType}.\n\n`;
    prompt += `${depthLabel}: ${complexityLabels[complexity] || complexity}\n\n`;

    if (importEnabled) {
        if (!configuredPath) {
            prompt += `NOTE: Local docs folder not configured. Please configure it in the Local Docs tab before saving.\n\n`;
        } else {
            prompt += `IMPORTANT: After completing the ${isWebMode ? 'research' : 'plan'}, ${saveAction} to ${saveLocation} using the write_to_file tool so I can review them later.\n\n`;
        }
    }

    prompt += `Please begin by ${protocolAction} for my approval, following the ${skillName} skill protocol.`;

    return prompt;
}
```

**Edge Cases Handled:**
- Empty folder path shows configuration warning instead of invalid path
- Mode always uses persisted state value
- Graceful degradation if elements missing

---

### src/services/PlanningPanelProvider.ts

#### [MODIFY] `src/services/PlanningPanelProvider.ts` - Add placeholder message handlers

**Context:** Add placeholder handlers for `checkAnalystAvailability` and `sendToAnalyst` message types.

**Note:** Full analyst terminal integration requires VS Code command registration in extension.ts (following the pattern used by KanbanProvider). This is deferred to a separate plan: `add_analyst_integration_to_planning_panel.md`.

**Implementation:**
```typescript
case 'checkAnalystAvailability': {
    // Placeholder: Full implementation in add_analyst_integration_to_planning_panel.md
    // TODO: Implement via vscode.commands.executeCommand('switchboard.checkAnalystAvailability')
    this._panel?.webview.postMessage({
        type: 'analystAvailabilityResult',
        available: false,
        agents: []
    });
    break;
}

case 'sendToAnalyst': {
    const prompt = message.prompt;
    if (!prompt) {
        this._panel?.webview.postMessage({
            type: 'sendToAnalystResult',
            success: false,
            error: 'No prompt provided'
        });
        break;
    }

    // Placeholder: Full implementation in add_analyst_integration_to_planning_panel.md
    // TODO: Implement via vscode.commands.executeCommand('switchboard.sendToAnalystFromPlanningPanel', prompt)
    this._panel?.webview.postMessage({
        type: 'sendToAnalystResult',
        success: false,
        error: 'Analyst integration not yet implemented - see add_analyst_integration_to_planning_panel.md'
    });
    break;
}
```

---

#### [MODIFY] `src/webview/planning.js` - Handle availability result (in message listener)

**Context:** Add handler for analyst availability response.

**Implementation:**
```javascript
case 'analystAvailabilityResult': {
    const analystBtn = document.getElementById('btn-send-to-analyst');
    if (analystBtn) {
        analystBtn.style.display = message.available ? 'inline-block' : 'none';
        if (!message.available) {
            analystBtn.title = 'Analyst terminal not available. Configure an analyst agent to enable this feature.';
        }
    }
    break;
}
```

## Files Changed

| File | Changes |
|------|---------|
| `AGENTS.md` | Add `web_research` and `deep_planning` to Available Skills table (lines 70-84) |
| `src/webview/planning.html` | Consolidate research panels, update button IDs, add mode description, accessibility attributes |
| `src/webview/planning.js` | State management with persistence, unified button handlers, folder path storage, updated prompt generation |
| `src/services/PlanningPanelProvider.ts` | Add `checkAnalystAvailability` and `sendToAnalyst` message handlers |

## Verification Plan

### Automated Tests
- Existing webview tests should pass (no breaking changes to message protocol)
- Manual verification checklist above

### Manual Testing Steps
(As listed in Issues Summary section above)

---

## Estimated Effort

- **Phase 1** (Documentation): 5 minutes
- **Phase 2** (UI Consolidation): 45 minutes
- **Phase 3** (Save Location): 15 minutes
- **Testing**: 15 minutes

**Total**: ~1.5 hours

---

**Recommendation:** Send to Coder (Complexity 3 ≤ 6)

## Code Review Results

**Reviewer:** Antigravity (Claude Opus 4.6 Thinking)
**Date:** 2026-05-02
**Status:** ✅ APPROVED

### Files Changed (Validated)

| File | Status |
|------|--------|
| `AGENTS.md` (lines 78-79) | ✅ `web_research` and `deep_planning` added to skills table |
| `src/webview/planning.html` (lines 1233-1294) | ✅ Unified panel, accessibility attributes, updated import description |
| `src/webview/planning.js` (multiple locations) | ✅ State management, unified button, folder path storage, prompt generation |
| `src/services/PlanningPanelProvider.ts` (lines 683-729) | ✅ Message handlers upgraded to live command execution |

### Findings

| ID | Severity | Description | Resolution |
|----|----------|-------------|------------|
| G-08 | CRITICAL | `originalText` variable scoped inside `try` but referenced in `catch` — causes ReferenceError on clipboard failure | **FIXED** — hoisted `const originalText` before `try` block (line 130) |

### Verification

- **TypeScript compilation:** ✅ No new errors (2 pre-existing dynamic import extension warnings)
- **Code review:** All 3 plan issues addressed correctly:
  - Issue 1 (AGENTS.md docs): ✅ Both skills documented
  - Issue 2 (Mode switch + panel layout): ✅ Unified panel, functional mode switch with persistence
  - Issue 3 (Save location): ✅ Uses `state.localFolderPath` with fallback and config warning

### Remaining Risks

- Mode persistence via `vscode.setState` may not survive extension host restart (by design — webview lifecycle)
- `localFolderPath` state depends on `localDocsReady` message arriving before user copies prompt (race window minimal)

**Note:** Analyst terminal integration deferred to separate plan `add_analyst_integration_to_planning_panel.md`
