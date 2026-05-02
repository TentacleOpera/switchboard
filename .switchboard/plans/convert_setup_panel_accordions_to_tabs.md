# Convert Setup Panel from Accordions to Tabs

## Goal
Convert the setup panel (`src/webview/setup.html`) from an accordion-based layout to a tab-based interface for improved usability. Currently, all sections are stacked as accordions that expand/collapse individually. The new design will show section labels as horizontal tabs, with only one section visible at a time.

## Metadata
**Tags:** frontend, UI, UX
**Complexity:** 6
**Repo:** switchboard

## User Review Required
UI pattern change will affect muscle memory for existing users. Previously open sections may reset to first tab on initial load until state persistence is implemented.

## Complexity Audit

### Routine
- Add tab navigation HTML structure (new container, preserve existing section content)
- Create CSS classes for tab styling (`.tab-nav`, `.tab-btn`, `.tab-content`)
- Implement `activateTab()` function (simpler than accordion toggle — no collapse others logic)
- Persist `activeTabId` via `vscode.setState()` (standard VS Code webview pattern)

### Complex / Risky
- DOM structure change breaks existing `.closest('.startup-section')` selectors in kanban drag-drop handlers (lines 2156-2181)
- `openAccordion()` callers from message handlers (line 4313) need redirection to tab activation
- 11 tabs cause horizontal overflow on narrow panels — requires responsive design strategy
- Form input state persistence across webview lifecycle (scroll position, focus, partial inputs)
- Risk of dual event handlers if `bindAccordion()` accidentally called during tab lifecycle

## Edge-Case & Dependency Audit

**Race Conditions:**
- Message handler `openSetupSection` fires before tab initialization complete. **Mitigation:** Queue section activation requests until `initTabs()` completes.
- Webview destroyed while user editing form — state lost. **Mitigation:** Accept as acceptable trade-off; VS Code webview lifecycle is transient by design.

**Security:**
- No user input directly evaluated; all tab switching is client-side DOM manipulation
- No changes to VS Code API message contracts that could expose sensitive data

**Side Effects:**
- Tab switch resets scroll position within section (different from accordion behavior)
- Active tab state lost on webview recreation (until `vscode.setState()` implemented)
- Visual hierarchy change may confuse existing users initially

**Dependencies & Conflicts:**
No active conflicts detected in Kanban "New" or "Planned" columns. Setup panel changes are isolated from database/planning work.

## Dependencies
None

## Adversarial Synthesis
Key risks: DOM selector breakage in kanban drag-drop; 11-tab overflow on narrow viewports; `openAccordion()` callers creating chaos. Mitigations: Audit and update all traversing selectors; implement scrollable tab container with overflow indicator; redirect accordion callers to `activateTab()`.

## Current State Analysis
- **File**: `src/webview/setup.html` (~4400 lines)
- **Current Pattern**: 11 accordion sections (`.startup-section`) with toggle headers (`.startup-toggle`) and collapsible content (`.startup-fields` / `.db-sync-fields` with `data-accordion="true"`)
- **JS Functions**: `bindAccordion()`, `openAccordion()`, `collapseAllAccordions()` manage the accordion behavior

### Current Sections (in order):
1. Setup (basic plugin initialization)
2. Custom Agents
3. Ollama via Claude Code
4. Kanban Structure
5. Orchestration Framework Integration
6. Database Operations
7. Workspace Database Mappings
8. ClickUp, Linear and Notion Integration
9. Planning Sources
10. Control Plane Setup
11. PLANNING PANEL SYNC

## Proposed Changes

### src/webview/setup.html - HTML Structure

#### [MODIFY] `src/webview/setup.html` - Wrap sections in tab container (lines 471-1125)

**Context:** Wrap existing 11 `.startup-section` divs in tab navigation structure while preserving ALL content, IDs, and event handlers.

**Logic:**
1. Insert `.tab-nav` container immediately after `<body>` opening, before `.setup-shell`
2. Add 11 tab buttons corresponding to each section
3. Wrap each `.startup-section` content area in `.tab-content` div
4. Preserve all existing IDs on section wrappers and internal elements
5. Add `data-section-id` attributes for robust JavaScript selectors

**Implementation:**

```html
<body>
    <!-- Tab Navigation -->
    <div class="tab-nav" role="tablist" aria-label="Setup sections">
        <button class="tab-btn active" data-tab="setup" role="tab" aria-selected="true">Setup</button>
        <button class="tab-btn" data-tab="custom-agents" role="tab" aria-selected="false">Custom Agents</button>
        <button class="tab-btn" data-tab="ollama" role="tab" aria-selected="false">Ollama</button>
        <button class="tab-btn" data-tab="kanban" role="tab" aria-selected="false">Kanban</button>
        <button class="tab-btn" data-tab="orchestration" role="tab" aria-selected="false">Orchestration</button>
        <button class="tab-btn" data-tab="database" role="tab" aria-selected="false">Database</button>
        <button class="tab-btn" data-tab="workspace" role="tab" aria-selected="false">Workspace</button>
        <button class="tab-btn" data-tab="integration" role="tab" aria-selected="false">Integrations</button>
        <button class="tab-btn" data-tab="sources" role="tab" aria-selected="false">Sources</button>
        <button class="tab-btn" data-tab="control" role="tab" aria-selected="false">Control Plane</button>
        <button class="tab-btn" data-tab="sync" role="tab" aria-selected="false">Sync</button>
    </div>

    <div class="setup-shell">
        <!-- Setup Section -->
        <div class="startup-section" data-section-id="setup">
            <div class="startup-toggle" id="setup-toggle">
                <div class="section-label">Setup</div>
                <span class="chevron" id="setup-chevron" style="display: none;">▶</span>
            </div>
            <div class="startup-fields tab-content open" id="startup-fields" data-accordion="true" data-tab-content="setup">
                <!-- ALL EXISTING CONTENT PRESERVED -->
                <div class="flex gap-2">
                    <button id="btn-initialize" class="secondary-btn w-full">INIT PLUGIN</button>
                    <button id="btn-connect-mcp" class="secondary-btn w-full">CONNECT MCP</button>
                </div>
                <!-- ... rest of section content unchanged ... -->
            </div>
        </div>

        <!-- Custom Agents Section -->
        <div class="startup-section" data-section-id="custom-agents">
            <div class="startup-toggle" id="custom-agents-toggle">
                <div class="section-label">Custom Agents</div>
                <span class="chevron" id="custom-agents-chevron" style="display: none;">▶</span>
            </div>
            <div class="startup-fields tab-content" id="custom-agents-fields" data-accordion="true" data-tab-content="custom-agents">
                <!-- ALL EXISTING CONTENT PRESERVED -->
            </div>
        </div>

        <!-- [REPEAT PATTERN FOR REMAINING 9 SECTIONS] -->
        <!-- Ollama: data-tab-content="ollama" -->
        <!-- Kanban: data-tab-content="kanban" -->
        <!-- Orchestration: data-tab-content="orchestration" -->
        <!-- Database: data-tab-content="database" (uses db-sync-fields class) -->
        <!-- Workspace: data-tab-content="workspace" -->
        <!-- Integration: data-tab-content="integration" -->
        <!-- Sources: data-tab-content="sources" -->
        <!-- Control Plane: data-tab-content="control" -->
        <!-- Sync: data-tab-content="sync" -->
    </div>
</body>
```

**Edge Cases Handled:**
- Chevron spans hidden via inline style (not CSS) to prevent accidental display
- `data-section-id` attributes enable robust JavaScript selection independent of DOM depth
- First tab content has `.open` class for initial visibility
- ALL existing IDs preserved exactly to maintain event handler attachments

---

### src/webview/setup.html - CSS Styles

#### [MODIFY] `src/webview/setup.html` - Add tab styles in `<style>` block (after line 306)

**Implementation:**
```css
/* Tab Navigation Styles */
.tab-nav {
    display: flex;
    gap: 4px;
    padding: 8px 16px;
    background: var(--panel-bg);
    border-bottom: 1px solid var(--border-color);
    overflow-x: auto;
    scrollbar-width: thin;
    scrollbar-color: var(--border-color) transparent;
    position: sticky;
    top: 0;
    z-index: 10;
}

.tab-nav::-webkit-scrollbar {
    height: 4px;
}

.tab-nav::-webkit-scrollbar-thumb {
    background: var(--border-color);
    border-radius: 2px;
}

.tab-btn {
    flex-shrink: 0;
    padding: 8px 16px;
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--text-secondary);
    font-family: var(--font-mono);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 1px;
    cursor: pointer;
    transition: all 0.15s ease;
    white-space: nowrap;
}

.tab-btn:hover {
    color: var(--text-primary);
    border-bottom-color: var(--border-bright);
}

.tab-btn.active {
    color: var(--accent-teal);
    border-bottom-color: var(--accent-teal);
}

.tab-btn:focus-visible {
    outline: 1px solid var(--accent-teal);
    outline-offset: -1px;
}

/* Tab Content Styles */
.tab-content {
    display: none;
}

.tab-content.open {
    display: flex;
    flex-direction: column;
    gap: 8px;
}

/* Override accordion open display for tab mode */
.startup-fields.tab-content.open {
    display: flex;
}

.db-sync-fields.tab-content.open {
    display: flex;
}

/* Hide accordion toggles in tab mode */
.startup-toggle {
    cursor: default;
}

.startup-toggle .chevron {
    display: none !important;
}

/* Setup shell adjustment for tab layout */
.setup-shell {
    padding-top: 0;
}
```

**Edge Cases Handled:**
- Sticky tab nav stays visible during scroll
- Horizontal scroll with thin scrollbar for narrow viewports
- `!important` on chevron display ensures hidden state regardless of JS class toggles
- Specificity overrides for `.startup-fields.open` accordion styles

---

### src/webview/setup.html - JavaScript

#### [MODIFY] `src/webview/setup.html` - Replace accordion initialization with tabs (around line 1385)

**Implementation:**
```javascript
// Tab State
let activeTabId = 'setup';

// Initialize tabs
function initTabs() {
    const tabButtons = document.querySelectorAll('.tab-btn');
    const tabContents = document.querySelectorAll('.tab-content');
    
    // Restore persisted tab if available
    const persistedState = vscode.getState?.() || {};
    if (persistedState.activeTabId) {
        activeTabId = persistedState.activeTabId;
    }
    
    // Bind tab button clicks
    tabButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const tabId = btn.dataset.tab;
            activateTab(tabId);
        });
    });
    
    // Show initial tab
    activateTab(activeTabId, false);
}

// Activate specific tab
function activateTab(tabId, persist = true) {
    const tabButtons = document.querySelectorAll('.tab-btn');
    const tabContents = document.querySelectorAll('.tab-content');
    
    // Update button states
    tabButtons.forEach(btn => {
        const isActive = btn.dataset.tab === tabId;
        btn.classList.toggle('active', isActive);
        btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
    
    // Update content visibility
    tabContents.forEach(content => {
        const isActive = content.dataset.tabContent === tabId;
        content.classList.toggle('open', isActive);
    });
    
    // Persist active tab
    activeTabId = tabId;
    if (persist && vscode.setState) {
        vscode.setState({ ...vscode.getState?.(), activeTabId });
    }
}

// Legacy compatibility: redirect openAccordion to tab activation
function openAccordion(fieldsId, chevronId, onOpen) {
    // Map fields ID to tab ID
    const tabIdMap = {
        'startup-fields': 'setup',
        'custom-agents-fields': 'custom-agents',
        'ollama-fields': 'ollama',
        'kanban-structure-fields': 'kanban',
        'orchestration-fields': 'orchestration',
        'db-sync-fields': 'database',
        'workspace-mapping-fields': 'workspace',
        'project-mgmt-fields': 'integration',
        'planning-sources-fields': 'sources',
        'control-plane-fields': 'control',
        'planning-panel-fields': 'sync'
    };
    
    const tabId = tabIdMap[fieldsId];
    if (tabId) {
        activateTab(tabId);
        if (typeof onOpen === 'function') {
            onOpen();
        }
    }
}

// Initialize on DOM ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initTabs);
} else {
    initTabs();
}
```

**Edge Cases Handled:**
- `openAccordion()` mapped to `activateTab()` for backward compatibility with message handlers
- Persist flag prevents state write during initial load (avoid unnecessary storage)
- Graceful degradation if `vscode.getState/setState` unavailable

---

#### [MODIFY] `src/webview/setup.html` - Update kanban drag-drop selectors (around line 2136)

**Context:** Existing code uses `.closest('.startup-section')` which will break with new DOM structure.

**Current Code (line ~2136):**
```javascript
const handle = document.createElement('div');
handle.className = item.fixed ? 'kanban-structure-lock' : 'kanban-structure-handle';
handle.textContent = item.fixed ? '🔒' : '⋮⋮';
```

**No change needed to this section** — the drag-drop handlers use `row.dataset.id` and don't traverse to `.startup-section`. The kanban list is contained within a single tab, so no cross-tab issues.

**Verification:** Search for `.closest('.startup-section')` — no matches found in current file. Safe to proceed.

---

#### [MODIFY] `src/webview/setup.html` - Disable accordion bindings (around line 2400)

**Context:** Remove accordion initialization calls while keeping function definitions.

**Current Code:**
```javascript
// After initial render calls:
bindAccordion('setup-toggle', 'startup-fields', 'setup-chevron');
bindAccordion('custom-agents-toggle', 'custom-agents-fields', 'custom-agents-chevron');
// ... etc for all 11 sections
```

**Implementation:**
```javascript
// Tab mode: accordion bindings replaced by initTabs()
// bindAccordion() functions kept for rollback compatibility but not called for main sections
initTabs();
```

**Clarification:** Keep `bindAccordion()`, `collapseAllAccordions()`, `openAccordion()` function definitions intact for rollback capability. Only remove the 11 `bindAccordion()` initialization calls.

## Implementation Plan

### Phase 1: HTML Structure Changes
**Goal**: Wrap existing sections in a tab container while preserving all content.

1. **Add Tab Navigation Bar**
   - Insert a `.tab-nav` container at the top of `.setup-shell`
   - Create tab buttons for each section with `data-tab` attributes linking to section IDs
   - First tab is active by default

2. **Wrap Section Content**
   - Keep existing `.startup-section` containers
   - Add `.tab-content` class to each section's content area
   - Add unique IDs to each section for tab targeting
   - Hide all tab content except the active tab (via CSS)

3. **Preserve Existing Content**
   - Do NOT modify any form elements, inputs, buttons, or modals
   - Keep all `id` attributes on existing elements
   - Maintain all event handlers and VS Code API calls

### Phase 2: CSS Changes
**Goal**: Style tabs to match the existing dark theme.

1. **Tab Navigation Styles**
   - Horizontal flex layout with gap
   - Tab button styling: border-bottom, hover states, active state with accent color
   - Scrollable if tabs overflow (horizontal scroll with hidden scrollbar)

2. **Tab Content Styles**
   - Hide inactive tabs: `.tab-content { display: none; }`
   - Show active tab: `.tab-content.active { display: block; }` (or flex for `.startup-fields`)
   - Remove accordion-specific styles (chevrons, toggle cursor)
   - Keep existing `.startup-fields` display behavior for the active tab

3. **Remove Accordion Visuals**
   - Hide chevrons in tab mode (or remove entirely)
   - Remove pointer cursor from section headers when in tab mode
   - Keep `.startup-toggle` styling for the tab buttons themselves

### Phase 3: JavaScript Changes
**Goal**: Replace accordion logic with tab switching.

1. **Initialize Tab System**
   - Create `initTabs()` function called on DOM ready
   - Bind click handlers to tab buttons
   - Show first tab by default

2. **Tab Switching Logic**
   - On tab click: hide all `.tab-content`, remove `.active` from all tabs
   - Add `.active` to clicked tab and corresponding content
   - Optional: Persist active tab in session (not required for MVP)

3. **Remove/Disable Accordion Logic**
   - Remove calls to `bindAccordion()` for the main sections
   - Keep `bindAccordion()` function definition (may be used elsewhere or for fallback)
   - Remove `collapseAllAccordions()` calls
   - Keep accordion functions available but unused for the main sections

4. **Maintain Existing Functionality**
   - All existing button click handlers remain unchanged
   - All VS Code message posting remains unchanged
   - All modal handling remains unchanged
   - All form input handlers remain unchanged

### Phase 4: Testing Checklist

**Visual Verification**:
- [ ] All 11 tabs are visible and clickable
- [ ] Active tab has distinct visual state
- [ ] Tab content switches correctly when clicking tabs
- [ ] No content is duplicated or missing
- [ ] Dark theme styling is consistent

**Functionality Verification**:
- [ ] "INIT PLUGIN" button works
- [ ] "CONNECT MCP" button works
- [ ] "COPY MCP CONFIG" button works
- [ ] Git ignore strategy dropdown works
- [ ] Custom agent add/edit/delete works
- [ ] Kanban column add/reorder/restore works
- [ ] Database location radio buttons work
- [ ] ClickUp/Linear/Notion integration forms work
- [ ] All modals (custom agent, kanban column, custom prompts) open/close correctly
- [ ] Control plane detection and migration works

**Edge Cases**:
- [ ] Verify no console errors on tab switch
- [ ] Verify state persistence across tab switches (inputs retain values)
- [ ] Test with narrow panel width (horizontal scroll or wrap)

## Files to Modify

| File | Changes |
|------|---------|
| `src/webview/setup.html` | Add tab navigation HTML, modify section wrapper classes, add tab CSS, replace accordion JS with tab JS |

## Rollback Plan
If issues arise, revert via git OR quick in-file rollback:

1. **Git revert:** `git checkout HEAD -- src/webview/setup.html`

2. **In-file manual rollback:**
   - Remove `.tab-nav` element and `.tab-content` wrappers
   - Delete CSS rules for `.tab-*` classes
   - Replace `initTabs()` call with 11 `bindAccordion()` calls
   - Restore chevron `display: block` styles

3. **Accordion functions kept intact** — no function definitions modified, only initialization calls changed.

Key accordion functions (`bindAccordion`, `collapseAllAccordions`) are kept (but unused) to allow quick reversion by restoring the binding calls.

## Verification Plan

### Automated Tests
- No existing automated tests for setup.html webview
- Manual verification required

### Manual Testing Checklist

**Visual Verification:**
- [ ] All 11 tabs are visible and clickable in tab navigation
- [ ] Active tab has distinct visual state (teal underline)
- [ ] Tab content switches correctly when clicking tabs
- [ ] No content is duplicated or missing
- [ ] Dark theme styling is consistent
- [ ] Horizontal scrollbar appears on narrow viewports
- [ ] Chevron arrows are completely hidden

**Functionality Verification:**
- [ ] "INIT PLUGIN" button works
- [ ] "CONNECT MCP" button works
- [ ] "COPY MCP CONFIG" button works
- [ ] Git ignore strategy dropdown works
- [ ] Custom agent add/edit/delete works
- [ ] Kanban column add/reorder/restore works (drag-drop)
- [ ] Database location radio buttons work
- [ ] ClickUp/Linear/Notion integration forms work
- [ ] All modals (custom agent, kanban column, custom prompts) open/close correctly
- [ ] Control plane detection and migration works

**Tab Behavior:**
- [ ] Active tab persists when hiding/showing panel (vscode.setState)
- [ ] `openSetupSection` message activates correct tab (integration setup flow)
- [ ] No console errors on tab switch
- [ ] Form inputs retain values within same tab session

**Responsive Behavior:**
- [ ] Tab navigation scrolls horizontally when viewport narrow
- [ ] Tab buttons remain clickable at minimum VS Code sidebar width

## Success Criteria
1. All 11 setup sections are accessible via tabs
2. Only one section is visible at a time
3. All existing functionality works identically to before
4. No visual regressions in the dark theme styling
5. No JavaScript errors in the developer console
6. Active tab persists across webview lifecycle (vscode.setState)
7. Backward compatibility: `openAccordion()` calls redirect to tab activation

---

**Recommendation:** Send to Lead Coder (Complexity 6 = threshold, DOM structure risk warrants senior review)

---

## Execution Summary

**Status:** COMPLETED ✅

**Date:** 2026-05-02

**Files Modified:**
- `src/webview/setup.html`

**Changes Made:**

1. **Tab Navigation HTML** (line 561-574): Added tab navigation bar with 11 tab buttons immediately after `<body>` opening

2. **Section Content Wrappers** (lines 581, 620, 631, 669, 686, 719, 785, 810, 1075, 1112, 1226): Added `tab-content` class and `data-tab-content` attributes to all 11 sections' content areas

3. **CSS Styles** (lines 468-555): Added comprehensive tab styling including:
   - `.tab-nav` with sticky positioning and horizontal scroll
   - `.tab-btn` with active/hover states using teal accent color
   - `.tab-content` visibility management
   - Chevron hiding with `!important`

4. **JavaScript Functions** (lines 1490-1625):
   - `openAccordion()` modified to redirect to `activateTab()` for backward compatibility
   - `initTabs()` function for tab initialization with state persistence
   - `activateTab()` function for tab switching with VS Code state API integration
   - Tab load callbacks for each section to maintain functionality

5. **Initialization** (line 3899): Replaced 11 `bindAccordion()` calls with single `initTabs()` call

**Backward Compatibility:**
- `openAccordion()` redirects to `activateTab()` for all mapped section IDs
- Original accordion functions (`bindAccordion`, `collapseAllAccordions`) preserved for rollback capability

**Testing Recommendations:**
- Verify all 11 tabs switch correctly
- Verify active tab persists across webview hide/show
- Verify all section-specific data loading works (each tab triggers appropriate VS Code messages)
- Test horizontal scrolling on narrow viewports

---

## Reviewer Pass

**Reviewer:** Antigravity (adversarial inline audit)
**Date:** 2026-05-02
**Verdict:** ✅ PASS — No material defects found. Implementation is clean, complete, and backward-compatible.

### Code Audit Findings

#### 1. Tab Navigation HTML (lines 562-574) ✅
- 11 tab buttons correctly mapped to `data-tab` attributes
- ARIA `role="tablist"` and `aria-selected` attributes present for accessibility
- Initial `active` class correctly set on first tab ("Setup")

#### 2. CSS (lines 468-555) ✅
- `.tab-nav` uses `position: sticky; top: 0; z-index: 10` — correct for webview context
- `overflow-x: auto` with custom scrollbar styling handles narrow viewport overflow
- `.tab-content` defaults to `display: none`, with `.tab-content.open` showing as flex column
- `!important` override on `.startup-toggle .chevron { display: none !important }` is justified to suppress deeply-nested accordion chevrons without rewriting upstream CSS
- `.setup-shell { padding-top: 0 }` correctly removes the padding that previously sat above accordion headers

#### 3. Section Content Wrappers (11 sections) ✅
- All 11 `startup-fields` divs have dual-role: `class="startup-fields tab-content"` with `data-tab-content="<id>"`
- `data-accordion="true"` preserved on all sections for rollback capability
- First section (`startup-fields`) has `class="startup-fields tab-content open"` — correct initial visible state

#### 4. Tab ID Mapping Completeness ✅
All 11 sections verified with correct `data-tab-content` ↔ `data-tab` pairings:
| Tab Button | Content ID | Section |
|---|---|---|
| `setup` | `startup-fields` | Setup |
| `custom-agents` | `custom-agents-fields` | Custom Agents |
| `ollama` | `ollama-fields` | Ollama |
| `kanban` | `kanban-structure-fields` | Kanban |
| `orchestration` | `orchestration-fields` | Orchestration |
| `database` | `db-sync-fields` | Database |
| `workspace` | `workspace-mapping-fields` | Workspace |
| `integration` | `project-mgmt-fields` | Integrations |
| `sources` | `planning-sources-fields` | Sources |
| `control` | `control-plane-fields` | Control Plane |
| `sync` | `planning-panel-fields` | Sync |

#### 5. JavaScript — `initTabs()` (lines 1532-1552) ✅
- Correctly restores persisted state via `vscode.getState?.()`
- Binds click handlers on all `.tab-btn` elements
- Calls `activateTab(activeTabId, false)` on init (persist=false avoids redundant write)

#### 6. JavaScript — `activateTab()` (lines 1555-1625) ✅
- Correctly toggles `.active` class on buttons and `.open` class on content panels
- Updates `aria-selected` for accessibility
- Persists via `vscode.setState({ ...vscode.getState?.(), activeTabId })` — correctly merges with existing state
- **Tab load callbacks** (lines 1579-1619): All 11 tabs fire the correct `vscode.postMessage` calls matching what the original accordion `onOpen` callbacks did

#### 7. Backward Compatibility — `openAccordion()` (lines 1490-1526) ✅
- Maps all 11 `fieldsId` values to their tab equivalents via `tabIdMap`
- Falls through to original accordion behavior for unmapped IDs (future-proof)
- Calls `onOpen()` callback after tab activation (preserves existing contract)

#### 8. Initialization (line 3899) ✅
- Single `initTabs()` call replaces all previous `bindAccordion()` calls
- Comment `// Initialize tabs (replaces bindAccordion calls)` is accurate
- `bindAccordion` function definition preserved (line 1474) for rollback — NOT called anywhere, verified by grep

### Adversarial Challenges

| Challenge | Verdict |
|---|---|
| **Stale `bindAccordion` calls?** | SAFE — grep confirms only the function definition remains; no call sites exist |
| **DOM selector breakage?** | SAFE — accordion structure preserved (`startup-section`, `startup-toggle`); only visibility mechanism changed |
| **11-tab overflow on narrow panels?** | HANDLED — `overflow-x: auto` with scrollbar styling |
| **State persistence race?** | SAFE — `vscode.getState()` is synchronous; setState merges correctly |
| **Tab load callback completeness?** | VERIFIED — all 11 tabs mapped, each fires correct postMessage types |
| **openAccordion redirection correctness?** | VERIFIED — all 11 fieldsId→tabId mappings match the HTML structure |

### TypeScript Compilation ✅
- `npx tsc --noEmit` reports 2 pre-existing errors (module resolution in `ClickUpSyncService.ts:2114` and `KanbanProvider.ts:3649`) — both unrelated to this plan

### Remaining Risks (Low)
1. **Manual QA needed**: Tab switching on various VS Code panel widths (especially sidebar vs full-width panel)
2. **Keyboard navigation**: `tab-btn` elements are `<button>` (focusable by default) but no keyboard shortcut for cycling tabs — acceptable for v1
