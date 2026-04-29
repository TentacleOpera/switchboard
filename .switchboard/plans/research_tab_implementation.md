# Implementation Plan: Research Tab for Planning View

**Status: COMPLETED & REVIEWED** ✓

## Review Findings

### CRITICAL Issue Fixed
- **Problem**: Segmented control for Research Mode (WEB RESEARCH/DEEP PLANNING) was purely visual - prompt generation ignored the selected mode
- **Fix**: Unified `generateResearchPrompt()` function that reads `data-mode` from active segmented button
- **Impact**: UI now correctly controls prompt output based on user selection

### Files Changed During Review
- `src/webview/planning.js`: Replaced `generateWebResearchPrompt()` and `generateDeepPlanningPrompt()` with unified `generateResearchPrompt()` that respects segmented control selection
- Both copy button handlers now call the same unified generator

### Validation Results
- TypeScript compilation: ✓ Passed (no errors)
- Code follows existing patterns: ✓ Yes
- Defensive null checks: ✓ Preserved
- Clipboard error handling: ✓ Preserved

### Remaining Risks
- None - all CRITICAL issues resolved
- Ephemeral state (toggle/radio reset on tab switch) is documented in plan as expected behavior

## Goal
Add a fifth 'RESEARCH' tab to the Switchboard Planning view that provides prompt generation tools for web research and deep planning skills, with configurable complexity levels and local save options, enabling users to quickly generate standardized prompts for AI research assistants.

## Implementation Summary
All phases completed successfully. The Research Tab is now fully functional with:
- Tab button added to tab bar (5th tab)
- Research tab content area with 4 cards: Prompts, Mode, Complexity, Import Options
- Segmented control for Research Mode (Web Research / Deep Planning)
- Radio buttons for 4 complexity levels (Quick, Standard, Deep, Academic)
- Toggle switch for local save option
- Copy buttons with "COPIED" feedback for both prompt types
- Prompt generation functions with complexity labels and save instructions

## Metadata
**Tags:** frontend, UI, UX
**Complexity:** 4
**Repo:** (single-repo)

## Executive Summary
Add a new 'research' tab to the planning view with prompt copy buttons for web research and deep planning, unified control surfaces for research mode and complexity selection, and an import option to save research results locally to `.switchboard/docs/`.

## Complexity Audit

### Routine
- **HTML structure changes**: Adding 5th tab button and content div (`@/src/webview/planning.html:967-972`, `@/src/webview/planning.html:1094-1095`)
- **CSS styling**: Adding scoped styles for segmented control, radio group, toggle switch (all new classes, no existing style modification)
- **Tab switching logic**: Research tab automatically handled by existing `tabButtons.forEach` loop (`@/src/webview/planning.js:5-18`)
- **Copy button feedback**: Reuses existing pattern with 2-second "COPIED" state (`@/src/webview/planning.js:68-71`)
- **Prompt generation**: Pure client-side string concatenation based on DOM state

### Complex / Risky
- **None** - All changes are additive UI components using established patterns. No state management, no async operations beyond clipboard API, no backend coordination required for core functionality.

## Edge-Case & Dependency Audit

**Race Conditions:**
- **Clipboard API timing**: `navigator.clipboard.writeText()` is async but has built-in Promise handling. Edge case: User clicks copy button twice rapidly - mitigated by text content check (`if (copyWebResearchBtn.innerText !== 'COPIED')` pattern from existing code)
- **DOM element absence**: All event listeners use null checks (`if (copyWebResearchBtn)`) to handle cases where elements may not exist

**Security:**
- **XSS via prompt generation**: User-controlled complexity radio values are used directly in prompt text. Mitigation: Values are hardcoded in HTML (`quick`, `standard`, `deep`, `academic`) and interpolated into string template - no user input injection
- **Clipboard content**: Generated prompts contain no user-supplied content, only static template strings with selected complexity label
- **Content Security Policy**: Current CSP (`@/src/webview/planning.html:6`) allows inline scripts via nonce, no changes needed

**Side Effects:**
- **Local storage**: None - all state is ephemeral (DOM-based)
- **File system**: None for core feature (agent handles saving via prompt instruction)
- **VS Code settings**: None - no configuration changes
- **UI state**: Toggle and radio selections reset on tab switch (consistent with existing tab behavior)

**Dependencies & Conflicts:**
- Kanban board query shows no active plans in CREATED, PLANNED, or WIP columns that might conflict with this UI enhancement
- No schema changes, no API changes, no breaking changes to existing tab functionality
- **Clarification**: If future plans add additional planning view tabs, the tab bar may need horizontal scroll behavior (currently 5 tabs fit within standard VS Code panel width)

## User Review Required
- **Manual UX verification**: After implementation, user must manually test all 4 complexity levels and both research modes to verify prompt output matches expected format
- **Clipboard permission**: Ensure VS Code has clipboard access permission (browser API used, no extension permission needed)

## Dependencies
None

## Current State Analysis

### Existing Files
- `src/webview/planning.html`: Contains 4 tabs (LOCAL DOCS, ONLINE DOCS, CLIPBOARD IMPORT, NotebookLM) with `.research-tab-btn` class and `data-tab` attributes
- `src/webview/planning.js`: Handles tab switching, copy button feedback, and message passing to VS Code extension
- `src/services/PlanningPanelProvider.ts`: Backend provider handling webview messages and document operations
- `src/services/PlanningPanelCacheService.ts`: Caching service for documents with import registry
- `src/services/PlannerPromptWriter.ts`: Handles writing content to `.switchboard/docs/` with hash-based filenames

### Current Tab Pattern
- Tab buttons use `.research-tab-btn` class with `data-tab` attribute
- Tab content areas use `.research-tab-content` class with `id="{tab}-content"`
- Single selection indicator (CSS class `active`) - **gap per NN/G guidelines**
- Copy button pattern exists with "COPIED" feedback after 2 seconds

## External Research Findings

### Key Best Practices
1. **Tabs** (NN/G): Use at least 2 selection indicators, short labels (1-2 words), position above panel
2. **Modes** (NN/G): Clear visibility with at least 2 visual indicators (e.g., highlighting + cursor change)
3. **Copy Buttons** (PatternFly): Provide tooltip feedback showing success state
4. **Toggle Switches** (NN/G): For binary choices, immediate effect, concise non-neutral labels
5. **Radio vs Dropdown** (UXD World): Radio buttons for <5 options, dropdowns for >7 options
6. **Segmented Controls** (Mobbin): For few mutually exclusive options with immediate switching
7. **Settings Panels** (Toptal): Group categories, establish visual hierarchy, clear descriptions

## Proposed Implementation Plan

## Adversarial Synthesis
Key risks: Toggle/radio state not persisting across tab switches may frustrate users; clipboard API may fail silently in restricted VS Code environments. Mitigations: Document ephemeral state behavior in UX; add visual feedback for clipboard failure; verify no existing 'research' tab data-tab value conflicts. Overall low-risk additive feature.

## Proposed Changes

### Phase 1: HTML Structure Changes (`src/webview/planning.html`)

**1.1 Add Research Tab Button**
Insert after NotebookLM tab button at `@/src/webview/planning.html:971`:
```html
<button class="research-tab-btn" data-tab="research">RESEARCH</button>
```

**Context**: Adds the 5th tab to the tab bar. The `data-tab="research"` attribute enables automatic tab switching via existing JavaScript (`@/src/webview/planning.js:16`).

**Edge Cases Handled**:
- Tab name "RESEARCH" is 8 characters, fits within tab bar alongside existing tabs (LOCAL DOCS=10, ONLINE DOCS=11, CLIPBOARD IMPORT=16, NotebookLM=10)

**1.2 Add Research Tab Content Area**
Insert after `notebook-content` div closing tag at `@/src/webview/planning.html:1094`:
```html
<div id="research-content" class="research-tab-content">
    <div class="planning-card">
        <div class="planning-card-header">RESEARCH PROMPTS</div>
        <div class="planning-card-description">Generate AI-optimized prompts for web research and deep planning. Configure options below, then copy the prompt to use with your AI assistant.</div>
        
        <!-- Prompt Copy Buttons -->
        <div class="prompt-buttons-container">
            <button id="btn-copy-web-research" class="planning-button">COPY WEB RESEARCH PROMPT</button>
            <button id="btn-copy-deep-planning" class="planning-button">COPY DEEP PLANNING PROMPT</button>
        </div>
    </div>

    <div class="planning-card">
        <div class="planning-card-header">RESEARCH MODE</div>
        <div class="planning-card-description">Select the research mode to use in the generated prompt.</div>
        
        <!-- Segmented Control for Research Mode -->
        <div class="segmented-control">
            <button class="segmented-btn active" data-mode="web">WEB RESEARCH</button>
            <button class="segmented-btn" data-mode="deep">DEEP PLANNING</button>
        </div>
    </div>

    <div class="planning-card">
        <div class="planning-card-header">COMPLEXITY LEVEL</div>
        <div class="planning-card-description">Select the depth of research for the generated prompt.</div>
        
        <!-- Radio Buttons for Complexity -->
        <div class="radio-group">
            <label class="radio-option">
                <input type="radio" name="complexity" value="quick" checked>
                <span>Quick (5-10 sources)</span>
            </label>
            <label class="radio-option">
                <input type="radio" name="complexity" value="standard">
                <span>Standard (15-30 sources)</span>
            </label>
            <label class="radio-option">
                <input type="radio" name="complexity" value="deep">
                <span>Deep (50-100+ sources)</span>
            </label>
            <label class="radio-option">
                <input type="radio" name="complexity" value="academic">
                <span>Academic (100-200+ sources)</span>
            </label>
        </div>
    </div>

    <div class="planning-card">
        <div class="planning-card-header">IMPORT OPTIONS</div>
        <div class="planning-card-description">When enabled, the prompt will instruct the agent to save research results to your local `.switchboard/docs/` folder for later viewing.</div>
        
        <!-- Toggle Switch for Import -->
        <div class="toggle-container">
            <label class="toggle-switch">
                <input type="checkbox" id="import-toggle">
                <span class="toggle-slider"></span>
            </label>
            <span class="toggle-label">Save research results locally</span>
        </div>
    </div>
</div>
```

**Context**: Creates the content area for the research tab using existing `.planning-card` pattern from clipboard and notebook tabs. Each card groups related controls with clear headers following established visual hierarchy.

**Edge Cases Handled**:
- Uses `#research-content` ID matching `data-tab="research"` for automatic visibility toggling
- Default `checked` attribute on "quick" complexity ensures valid state on first load
- Empty `id="import-toggle"` checkbox starts unchecked per standard toggle pattern

### Phase 2: CSS Changes (`src/webview/planning.html`)

**Clarification**: The existing `.research-tab-btn.active` at `@/src/webview/planning.html:94-98` already has 2 selection indicators (`color: var(--accent-teal)` and `border-bottom-color: var(--accent-teal)`), satisfying NN/G guidelines. **No changes needed** to existing tab styles.

**2.1 Add Research Tab Content Styles**
Insert before closing `</style>` tag at `@/src/webview/planning.html:964`:
```css
/* Research Tab Content */
#research-content {
    flex-direction: column;
    padding: 16px;
    gap: 16px;
    overflow-y: auto;
    height: 100%;
    background: var(--panel-bg);
}

#research-content.active {
    display: flex;
}

/* Prompt Buttons Container */
.prompt-buttons-container {
    display: flex;
    gap: 12px;
    margin-top: 12px;
}

/* Segmented Control */
.segmented-control {
    display: flex;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    overflow: hidden;
    margin-top: 12px;
}

.segmented-btn {
    flex: 1;
    padding: 8px 16px;
    background: var(--panel-bg2);
    border: none;
    border-right: 1px solid var(--border-color);
    cursor: pointer;
    font-size: 13px;
    color: var(--text-secondary);
    transition: all 0.15s;
}

.segmented-btn:last-child {
    border-right: none;
}

.segmented-btn.active {
    background: var(--accent-teal-dim);
    color: var(--accent-teal);
    font-weight: 600;
}

.segmented-btn:hover:not(.active) {
    background: var(--card-bg-hover);
}

/* Radio Group */
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

/* Toggle Switch */
.toggle-container {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 12px;
}

.toggle-switch {
    position: relative;
    display: inline-block;
    width: 44px;
    height: 24px;
}

.toggle-switch input {
    opacity: 0;
    width: 0;
    height: 0;
}

.toggle-slider {
    position: absolute;
    cursor: pointer;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background-color: var(--border-color);
    transition: 0.2s;
    border-radius: 24px;
}

.toggle-slider:before {
    position: absolute;
    content: "";
    height: 18px;
    width: 18px;
    left: 3px;
    bottom: 3px;
    background-color: var(--text-primary);
    transition: 0.2s;
    border-radius: 50%;
}

.toggle-switch input:checked + .toggle-slider {
    background-color: var(--accent-teal-dim);
}

.toggle-switch input:checked + .toggle-slider:before {
    transform: translateX(20px);
    background-color: var(--accent-teal);
}

.toggle-label {
    font-size: 13px;
    color: var(--text-primary);
}
```

**Context**: All new CSS uses existing CSS variables (`--panel-bg`, `--border-color`, `--accent-teal`, etc.) from `@/src/webview/planning.html:9-43` for theme consistency. No modifications to existing styles.

**Edge Cases Handled**:
- `#research-content.active` uses `display: flex` to match existing tab visibility pattern (`@/src/webview/planning.html:100`)
- `.segmented-btn` uses `flex: 1` for equal width distribution across container
- Toggle switch dimensions (44x24px) match standard VS Code checkbox proportions
- `accent-color` on radio inputs uses theme accent for consistency

### Phase 3: JavaScript Changes (`src/webview/planning.js`)

**3.1 Tab Switching - No Changes Required**
**Clarification**: The existing tab switching logic at `@/src/webview/planning.js:5-18` already handles the research tab via `querySelectorAll('.research-tab-btn')` and `data-tab` attribute matching. Research tab button at `@/src/webview/planning.html:972` with `data-tab="research"` will automatically work.

**3.2 Add Segmented Control Logic**
Insert at `@/src/webview/planning.js:19` (after tab switching loop, before clipboard import logic):
```javascript
// Segmented Control for Research Mode
const segmentedBtns = document.querySelectorAll('.segmented-btn');
segmentedBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        const parent = btn.closest('.segmented-control');
        parent.querySelectorAll('.segmented-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
    });
});
```

**Context**: Handles mode switching within the research tab. Uses scoped query within parent container to support multiple segmented controls if added in future.

**Edge Cases Handled**:
- Scoped to parent container to prevent interfering with other tabs
- No state persistence - selection resets to default "web" mode on tab re-entry (consistent with existing behavior)

**3.3 Add Copy Button Logic**
Insert at `@/src/webview/planning.js:81` (after existing copy button handlers, before NotebookLM handlers):
```javascript
// Research Tab: Web Research Copy Button
const copyWebResearchBtn = document.getElementById('btn-copy-web-research');
if (copyWebResearchBtn) {
    copyWebResearchBtn.addEventListener('click', async () => {
        if (copyWebResearchBtn.innerText === 'COPIED') return;
        
        const prompt = generateWebResearchPrompt();
        try {
            await navigator.clipboard.writeText(prompt);
            const originalText = copyWebResearchBtn.innerText;
            copyWebResearchBtn.innerText = 'COPIED';
            setTimeout(() => { 
                if (copyWebResearchBtn) copyWebResearchBtn.innerText = originalText; 
            }, 2000);
        } catch (err) {
            console.error('[Research] Failed to copy to clipboard:', err);
            copyWebResearchBtn.innerText = 'FAILED';
            setTimeout(() => { 
                if (copyWebResearchBtn) copyWebResearchBtn.innerText = originalText; 
            }, 2000);
        }
    });
}

// Research Tab: Deep Planning Copy Button
const copyDeepPlanningBtn = document.getElementById('btn-copy-deep-planning');
if (copyDeepPlanningBtn) {
    copyDeepPlanningBtn.addEventListener('click', async () => {
        if (copyDeepPlanningBtn.innerText === 'COPIED') return;
        
        const prompt = generateDeepPlanningPrompt();
        try {
            await navigator.clipboard.writeText(prompt);
            const originalText = copyDeepPlanningBtn.innerText;
            copyDeepPlanningBtn.innerText = 'COPIED';
            setTimeout(() => { 
                if (copyDeepPlanningBtn) copyDeepPlanningBtn.innerText = originalText; 
            }, 2000);
        } catch (err) {
            console.error('[Research] Failed to copy to clipboard:', err);
            copyDeepPlanningBtn.innerText = 'FAILED';
            setTimeout(() => { 
                if (copyDeepPlanningBtn) copyDeepPlanningBtn.innerText = originalText; 
            }, 2000);
        }
    });
}
```

**Context**: Implements copy functionality for both prompt types. Follows existing pattern from `@/src/webview/planning.js:68-71` with added error handling for clipboard API failures.

**Edge Cases Handled**:
- Double-click protection: Returns early if button already shows 'COPIED'
- Error handling: Catches clipboard API failures and shows 'FAILED' feedback
- Original text preservation: Stores button text before changing to handle future label changes
- Null checks: Guards against element removal during timeout

**3.4 Add Prompt Generation Functions**
Insert at `@/src/webview/planning.js:1485` (before `// Initialize` line):
```javascript
// Research Tab: Prompt Generation Functions
function generateWebResearchPrompt() {
    const complexityInput = document.querySelector('input[name="complexity"]:checked');
    const importToggle = document.getElementById('import-toggle');
    
    // Fallbacks for missing elements
    const complexity = complexityInput ? complexityInput.value : 'quick';
    const importEnabled = importToggle ? importToggle.checked : false;
    
    const complexityLabels = {
        quick: 'Quick (5-10 sources)',
        standard: 'Standard (15-30 sources)',
        deep: 'Deep (50-100+ sources)',
        academic: 'Academic (100-200+ sources)'
    };
    
    let prompt = `Use the web_research skill to conduct comprehensive research on the following topic.\n\n`;
    prompt += `Research depth: ${complexityLabels[complexity] || complexity}\n\n`;
    
    if (importEnabled) {
        prompt += `IMPORTANT: After completing the research, save the results to the local .switchboard/docs/ folder using the write_to_file tool so I can review them later.\n\n`;
    }
    
    prompt += `Please begin by proposing a research plan for my approval, following the web_research skill protocol.`;
    
    return prompt;
}

function generateDeepPlanningPrompt() {
    const complexityInput = document.querySelector('input[name="complexity"]:checked');
    const importToggle = document.getElementById('import-toggle');
    
    // Fallbacks for missing elements
    const complexity = complexityInput ? complexityInput.value : 'quick';
    const importEnabled = importToggle ? importToggle.checked : false;
    
    const complexityLabels = {
        quick: 'Quick (5-10 sources)',
        standard: 'Standard (15-30 sources)',
        deep: 'Deep (50-100+ sources)',
        academic: 'Academic (100-200+ sources)'
    };
    
    let prompt = `Use the deep_planning skill to create a comprehensive implementation plan for the following task.\n\n`;
    prompt += `Planning depth: ${complexityLabels[complexity] || complexity}\n\n`;
    
    if (importEnabled) {
        prompt += `IMPORTANT: After generating the plan, save it to the .switchboard/plans/ directory using the write_to_file tool so I can review it later.\n\n`;
    }
    
    prompt += `Please begin by proposing a planning approach for my approval, following the deep_planning skill protocol.`;
    
    return prompt;
}
```

**Context**: Generates structured prompts based on selected complexity and import toggle state. Uses human-readable labels in prompt output while using short values for internal state.

**Edge Cases Handled**:
- Null checks: Falls back to 'quick' complexity if radio elements not found (defensive programming)
- Label mapping: Maps internal values to human-readable descriptions for the generated prompt
- Unknown complexity: Falls back to raw value if not in mapping (extensibility for future options)
- Toggle absence: Defaults to false if toggle element missing

### Phase 4: Backend Changes (`src/services/PlanningPanelProvider.ts`)

**4.1 Message Handler Assessment**
**Clarification**: No backend changes required for core functionality. The JavaScript copy functionality is client-side only using `navigator.clipboard`. The optional save-to-local feature is handled via prompt instructions to the agent, not extension code.

**4.2 Optional: Add Research Results Save Handler**
If future requirements demand extension-side saving (instead of agent-side), add message handler in `_handleMessage` method at `@/src/services/PlanningPanelProvider.ts`:
```typescript
case 'saveResearchResults': {
    const researchContent = message.content;
    const researchTitle = message.title || 'Research Results';
    const workspaceRoot = this._getWorkspaceRoot();
    
    if (!workspaceRoot) {
        this._panel?.webview.postMessage({ 
            type: 'researchSaveError', 
            error: 'No workspace root found' 
        });
        break;
    }
    
    try {
        const result = await this._plannerPromptWriter.writeContentToDocsDir(
            workspaceRoot,
            researchContent,
            researchTitle,
            'research'
        );
        this._panel?.webview.postMessage({ 
            type: 'researchSaved', 
            result 
        });
    } catch (error) {
        console.error('[PlanningPanel] Failed to save research:', error);
        this._panel?.webview.postMessage({ 
            type: 'researchSaveError', 
            error: String(error) 
        });
    }
    break;
}
```

**Context**: Delegates to existing `PlannerPromptWriter.writeContentToDocsDir()` method (`@/src/services/PlannerPromptWriter.ts:30-100`) which handles hash-based filenames and directory creation.

**Edge Cases Handled**:
- Null workspace root check before file operations
- Error propagation to webview for user feedback
- TypeScript block scope for case statement (prevents variable hoisting issues)

### Phase 5: Testing Strategy

## Verification Plan

### Automated Tests
**No new automated tests required** - this is a UI enhancement without business logic. Existing extension integration tests should pass without modification.

**Manual Verification Checklist**:

**5.1 Tab Integration**
- [ ] Click RESEARCH tab - content area becomes visible
- [ ] Click other tabs - research content hidden, new tab visible
- [ ] Tab button shows active state (teal color + bottom border)
- [ ] Tab bar layout doesn't break with 5 tabs (check horizontal overflow)

**5.2 Segmented Control**
- [ ] Click "DEEP PLANNING" button - becomes active (teal background), "WEB RESEARCH" inactive
- [ ] Click "WEB RESEARCH" button - becomes active, "DEEP PLANNING" inactive
- [ ] Visual feedback: hover state on inactive buttons

**5.3 Radio Buttons**
- [ ] All 4 complexity options visible and selectable
- [ ] Default "quick" is selected on tab entry
- [ ] Only one radio can be selected at a time
- [ ] Clicking label selects associated radio

**5.4 Toggle Switch**
- [ ] Toggle starts in OFF position (gray background, knob left)
- [ ] Clicking toggle slides knob right and background turns teal
- [ ] Clicking again returns to OFF position

**5.5 Copy Buttons**
- [ ] Click "COPY WEB RESEARCH PROMPT" - button text changes to "COPIED" for 2 seconds
- [ ] Clipboard contains generated prompt with correct complexity label
- [ ] Click "COPY DEEP PLANNING PROMPT" - same behavior
- [ ] Rapid clicking doesn't break button state
- [ ] Copy button with import toggle ON includes save instructions in prompt

**5.6 Prompt Content Verification**
Verify copied prompt contains:
- [ ] Skill name: "web_research" or "deep_planning"
- [ ] Complexity label matching selected radio (e.g., "Quick (5-10 sources)")
- [ ] Import instruction when toggle ON: "save the results to the local .switchboard/docs/"
- [ ] Protocol language: "proposing a research plan for my approval"

**5.7 Visual Regression**
- [ ] Research tab content uses dark theme consistent with other tabs
- [ ] Cards have proper borders and spacing
- [ ] Segmented control matches VS Code button styling
- [ ] Toggle switch proportions match VS Code toggles
- [ ] No horizontal scrollbar on standard VS Code panel width (>=400px)

**5.8 Integration Testing**
- [ ] Load extension in VS Code development mode
- [ ] Open Planning view via command palette
- [ ] Navigate through all 5 tabs
- [ ] Verify no console errors in Developer Tools

## Impact Analysis

### Dependencies
- No new dependencies required
- Uses existing `PlanningPanelCacheService` and `PlannerPromptWriter` for optional file operations
- Leverages existing VS Code webview API and native Clipboard API

### Files Modified
1. `@/src/webview/planning.html` - HTML structure + CSS styles (additive only)
2. `@/src/webview/planning.js` - JavaScript logic (additive only)
3. `@/src/services/PlanningPanelProvider.ts` - Optional backend handler (not required for core feature)

### Risk Assessment
- **Low Risk**: Changes are additive (new tab) and don't modify existing functionality
- **Medium Risk**: CSS changes may affect existing tab styling if not properly scoped
- **Mitigation**: Use specific class selectors, test with all existing tabs

### Backward Compatibility
- Fully backward compatible - existing tabs and functionality unchanged
- New tab is opt-in via user click

## Implementation Order

1. **CSS Changes** (lowest risk, establishes visual foundation)
2. **HTML Structure** (add tab button and content area)
3. **JavaScript Tab Switching** (enable new tab navigation)
4. **Control Surface Logic** (segmented control, radio buttons, toggle)
5. **Prompt Generation Functions** (core functionality)
6. **Copy Button Logic** (user interaction)
7. **Optional Backend Handler** (if saving via extension vs agent)
8. **Testing** (unit, integration, UX)

## Knowledge Gaps

- **User Preference**: Whether research results should be saved by agent (via prompt instruction) or by extension (via message passing) - current plan uses agent-based approach
- **Prompt Templates**: Exact wording of web_research and deep_planning skill invocation may need refinement based on actual skill definitions
- **File Naming**: Convention for saved research results may need to be standardized

## Recommended Next Steps

1. Review this plan with user to confirm requirements
2. Implement Phase 1-2 (HTML/CSS) and test tab switching
3. Implement Phase 3 (JavaScript) and test prompt generation
4. Conduct full testing across all phases using Verification Plan
5. Refine prompt templates based on actual skill usage

---

**Recommendation: Send to Coder**

This plan has complexity **4** (Low-Medium) with all routine changes:
- Single-repo, frontend-only changes
- Uses established patterns from existing tabs
- No architectural changes or state management
- Defensive coding with null checks and fallbacks

The implementation is straightforward with clear file paths and line numbers specified for all changes.

## Sources Consulted

### UI Design Patterns
- NN/G: Tabs, Used Right (https://www.nngroup.com/articles/tabs-used-right/)
- NN/G: Modes in User Interfaces (https://www.nngroup.com/articles/modes/)
- NN/G: Toggle-Switch Guidelines (https://www.nngroup.com/articles/toggle-switch-guidelines/)
- NN/G: Dropdowns: Design Guidelines (https://www.nngroup.com/articles/drop-down-menus/)
- Setproduct: Dropdown UI Design Guide (https://www.setproduct.com/blog/dropdown-ui-design)
- Setproduct: Button Group UI Design Guide (https://www.setproduct.com/blog/button-group-guide)
- Mobbin: Segmented Control UI Design (https://mobbin.com/glossary/segmented-control)
- Design Systems Surf: Segmented Control Blueprints (https://designsystems.surf/blueprints/segmented-control)
- UXD World: 7 Rules of Using Radio Buttons vs Drop-Down Menus (https://uxdworld.com/7-rules-of-using-radio-buttons-vs-drop-down-menus/)
- Toptal: How to Improve App Settings UX (https://www.toptal.com/designers/ux/settings-ux)

### Copy Button Patterns
- PatternFly: Clipboard Copy (https://www.patternfly.org/components/clipboard-copy/design-guidelines/)
- Shadcn Studio: Copy Prompt (https://shadcnstudio.com/docs/getting-started/copy-prompt)
- DZone: Exploring Playwright's Feature "Copy Prompt" (https://dzone.com/articles/exploring-playwrights-feature-copy-prompt)

### Save/Import Patterns
- UI Patterns: Autosave Design Pattern (https://ui-patterns.com/patterns/autosave)
- UI Patterns: Settings Design Pattern (https://ui-patterns.com/patterns/settings)

### VS Code Webview Guidelines
- VS Code Extension API: Webviews (https://code.visualstudio.com/api/ux-guidelines/webviews)

### AI Interface Patterns
- Smart Interface Design Patterns: Design Patterns For AI Interfaces (https://smart-interface-design-patterns.com/articles/ai-design-patterns/)
