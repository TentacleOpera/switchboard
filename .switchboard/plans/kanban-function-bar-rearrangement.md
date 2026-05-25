# Plan: Rearrange Kanban Function Bar Layout

## Goal
Reorganize the function bar in `src/webview/kanban.html` to place workspace/project controls on the left and automation/view controls on the right, replacing wordy text buttons with compact icon buttons.

## Metadata
- **Tags:** [frontend, UI, UX]
- **Complexity:** 5

## User Review Required
- Icon selection is placeholder — user should replace with final icons later.
- Confirm that removing the CLI toggle switch (replacing with icon button) is acceptable UX.

## Complexity Audit

### Routine
- Reordering HTML elements within `.controls-strip` (lines 1920-1947)
- Adding a flex spacer `<div>` between left and right groups
- Adding new CSS class `.strip-icon-btn` and its hover/active/off variants
- Removing the `strip-divider` element
- Rewriting `updateCliToggleUi()` to target new element IDs

### Complex / Risky
- Rewriting `updateAutobanButtonState()` (line 4060-4067) — currently uses `textContent` which would destroy `<img>` children; must switch to class-based state toggling
- `flex-wrap: wrap` on `.controls-strip` (line 117) conflicts with the flex-spacer layout pattern — must be changed to `nowrap` or removed
- `.icon-btn` class name collides with existing `.card-btn.icon-btn` (line 578) — must use distinct name `.strip-icon-btn`

## Edge-Case & Dependency Audit

- **Race Conditions:** None. All UI state changes are synchronous DOM updates triggered by user clicks or backend messages.
- **Security:** No security implications. All changes are client-side UI only.
- **Side Effects:** Removing `#cli-triggers-toggle` checkbox breaks `updateCliToggleUi()` (line 3358-3367) which queries it. Must rewrite before removing the element. The backend message handler `cliTriggersState` (line 5136-5138) calls `updateCliToggleUi()` — the function must continue to work with the new icon button.
- **Dependencies & Conflicts:** Icon images must use `{{ICON_XX}}` template placeholders resolved by `KanbanProvider.ts` (line 6452-6475), NOT relative filesystem paths. The webview cannot access `../icons/` directly. The needed placeholders (`{{ICON_22}}`, `{{ICON_28}}`, `{{ICON_41}}`) already exist in the `iconMap`.

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) Icon paths using relative filesystem URLs will fail silently in VS Code webview — must use `{{ICON_XX}}` placeholder pattern. (2) `updateAutobanButtonState()` uses `textContent` which would destroy `<img>` children — must rewrite to class-based toggling. (3) `flex-wrap: wrap` on `.controls-strip` defeats the flex-spacer layout. Mitigations: Use existing placeholder system, rewrite state functions to toggle CSS classes, and set `flex-wrap: nowrap`.

## Overview
Reorganize the function bar in `src/webview/kanban.html` to improve layout and replace wordy controls with square icons.

## Current Layout (lines 1920-1947)
```
[START AUTOMATION] [Timers] [CLI Triggers toggle] [Pair Programming dropdown] [COLLAPSE CODERS] | [Workspace/Project dropdown] [ASSIGN] [Add Project] [badges]
```

## Target Layout
```
[Workspace/Project dropdown] [ASSIGN] [Add Plan] ................................................ [Start Automation icon] [CLI Triggers icon] [Pair Programming dropdown] [Collapse Coders icon]
```

### Left Side (left-aligned)
1. **Workspace/Project dropdown** - Most left position
2. **ASSIGN button** - Beside the dropdown
3. **Add Plan button** - Beside assign button

### Right Side (right-aligned)
1. **Start Automation** - Convert to square icon button
2. **CLI Triggers** - Convert to square icon button (replace toggle switch)
3. **Pair Programming dropdown** - Keep as dropdown (already compact)
4. **Collapse Coders** - Convert to square icon button

## Implementation Details

### 1. HTML Structure Changes
File: `src/webview/kanban.html` (lines 1920-1947)

**Current:**
```html
<div class="controls-strip">
    <button class="strip-btn" id="btn-autoban" data-tooltip="Start or stop the automation engine">▶ START AUTOMATION</button>
    <div class="autoban-timers-inline" id="autoban-timers-inline"></div>
    <label class="cli-toggle-inline" id="cli-toggle" data-tooltip="When OFF, moves and prompts do not trigger CLI agent actions">
        <label class="toggle-switch">
            <input type="checkbox" id="cli-triggers-toggle" checked>
            <span class="toggle-slider"></span>
        </label>
        <span class="toggle-label">CLI Triggers</span>
    </label>
    <select id="pairProgrammingModeSelect" class="kanban-mode-dropdown" data-tooltip="Pair Programming mode: controls how Lead and Coder prompts are dispatched">
        <option value="off">Pair Programming: Off</option>
        <option value="cli-cli">CLI Lead + CLI Coder</option>
        <option value="cli-ide">CLI Lead + IDE Coder</option>
        <option value="ide-cli">IDE Lead + CLI Coder</option>
        <option value="ide-ide">IDE Lead + IDE Coder</option>
    </select>
    <button class="strip-btn" id="btn-collapse-coders" data-tooltip="Toggle collapsed coder columns view">⇥ COLLAPSE CODERS</button>
    <span class="strip-divider"></span>
    <select id="workspace-project-select" class="workspace-project-select" data-tooltip="Select workspace and project" style="min-width:280px;"></select>
    <button class="strip-btn is-teal" id="btn-assign-workspace-project" data-tooltip="Assign selected plan(s) to this workspace/project" disabled>ASSIGN</button>
    <span id="workspace-filter-badge" class="workspace-filter-badge" hidden></span>
    <span id="workspace-control-plane-badge" class="workspace-filter-badge" hidden></span>
    <button id="workspace-reset-control-plane" class="strip-btn" hidden>RESET AUTO-DETECT</button>
    <button class="btn-add-plan" id="btn-add-project" data-tooltip="Add new project">+</button>
    <button id="btn-delete-project" class="strip-btn" title="Delete selected project" style="display:none;">DELETE PROJECT</button>
    <span id="project-filter-badge" class="workspace-filter-badge" hidden></span>
</div>
```

**Target:**
```html
<div class="controls-strip">
    <!-- Left Side: Workspace/Project controls -->
    <select id="workspace-project-select" class="workspace-project-select" data-tooltip="Select workspace and project" style="min-width:280px;"></select>
    <button class="strip-btn is-teal" id="btn-assign-workspace-project" data-tooltip="Assign selected plan(s) to this workspace/project" disabled>ASSIGN</button>
    <button class="btn-add-plan" id="btn-add-project" data-tooltip="Add new project">+</button>

    <!-- Spacer to push right-side controls to the right -->
    <div style="flex: 1;"></div>

    <!-- Right Side: Automation and view controls -->
    <button class="strip-icon-btn" id="btn-autoban" data-tooltip="Start or stop the automation engine">
        <img src="${ICON_AUTOBAN}" alt="Start Automation" style="width: 24px; height: 24px;">
    </button>
    <div class="autoban-timers-inline" id="autoban-timers-inline"></div>

    <button class="strip-icon-btn" id="btn-cli-triggers" data-tooltip="Toggle CLI triggers on/off">
        <img src="${ICON_CLI_TRIGGERS}" alt="CLI Triggers" style="width: 24px; height: 24px;">
    </button>

    <select id="pairProgrammingModeSelect" class="kanban-mode-dropdown" data-tooltip="Pair Programming mode: controls how Lead and Coder prompts are dispatched">
        <option value="off">Pair Programming: Off</option>
        <option value="cli-cli">CLI Lead + CLI Coder</option>
        <option value="cli-ide">CLI Lead + IDE Coder</option>
        <option value="ide-cli">IDE Lead + CLI Coder</option>
        <option value="ide-ide">IDE Lead + IDE Coder</option>
    </select>

    <button class="strip-icon-btn" id="btn-collapse-coders" data-tooltip="Toggle collapsed coder columns view">
        <img src="${ICON_COLLAPSE_CODERS}" alt="Collapse Coders" style="width: 24px; height: 24px;">
    </button>

    <!-- Hidden elements (unchanged) -->
    <span id="workspace-filter-badge" class="workspace-filter-badge" hidden></span>
    <span id="workspace-control-plane-badge" class="workspace-filter-badge" hidden></span>
    <button id="workspace-reset-control-plane" class="strip-btn" hidden>RESET AUTO-DETECT</button>
    <button id="btn-delete-project" class="strip-btn" title="Delete selected project" style="display:none;">DELETE PROJECT</button>
    <span id="project-filter-badge" class="workspace-filter-badge" hidden></span>
</div>
```

**IMPORTANT — Icon path mechanism:** The `<img src="${ICON_AUTOBAN}">` references are JavaScript template literals that resolve at render time. The constants must be defined in the JS section (around line 3073) using the `{{ICON_XX}}` placeholder pattern that `KanbanProvider.ts` replaces at webview initialization. Do NOT use relative filesystem paths like `../icons/...` — they will not work in a VS Code webview context.

### 2. CSS Changes

**Add new CSS class for strip icon buttons** (insert near the existing `.strip-btn` rules, around line 196):

```css
.strip-icon-btn {
    width: 32px;
    height: 32px;
    padding: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--border-color);
    background: var(--panel-bg2);
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.15s;
    flex-shrink: 0;
}

.strip-icon-btn:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent-teal) 8%, transparent);
    border-color: var(--accent-teal-dim);
}

.strip-icon-btn img {
    width: 24px;
    height: 24px;
    object-fit: contain;
    pointer-events: none;
}

.strip-icon-btn.is-active {
    border-color: var(--accent-teal-dim);
    box-shadow: var(--glow-teal);
    background: color-mix(in srgb, var(--accent-teal) 10%, transparent);
}

.strip-icon-btn.is-active img {
    filter: brightness(1.2);
}

.strip-icon-btn.is-off {
    border-color: color-mix(in srgb, var(--accent-orange) 45%, transparent);
    opacity: 0.6;
}

.strip-icon-btn.is-off img {
    filter: grayscale(0.5) brightness(0.7);
}
```

**Modify `.controls-strip`** (line 110-118) — remove `flex-wrap: wrap` to prevent the flex spacer from wrapping:
```css
.controls-strip {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 16px;
    border-bottom: 1px solid var(--border-color);
    background: var(--panel-bg2);
    /* flex-wrap: wrap removed — single-row layout with flex spacer */
}
```

**Optional cleanup (not blocking):** The following CSS rules become dead code after removing the CLI toggle switch:
- `.toggle-switch` (line 1203)
- `.toggle-switch input` (line 1211)
- `.toggle-slider` (line 1217)
- `.toggle-slider::before` (line 1226)
- `.toggle-switch input:checked + .toggle-slider` (line 1238)
- `.toggle-switch input:checked + .toggle-slider::before` (line 1242)
- `.cli-toggle-inline` (line 1274)
- `.cli-toggle-inline.is-off` (line 1288)
- `.strip-divider` (line 88)

### 3. JavaScript Changes

#### 3a. Add icon constants (around line 3073, with existing ICON_ constants)

```javascript
const ICON_AUTOBAN = '{{ICON_22}}';           // Play/automation icon
const ICON_CLI_TRIGGERS = '{{ICON_28}}';      // Toggle-like icon
const ICON_COLLAPSE_CODERS = '{{ICON_41}}';   // Collapse/expand icon
```

**Note:** These `{{ICON_XX}}` placeholders already exist in the `iconMap` in `KanbanProvider.ts` (lines 6455-6469), so no backend changes are needed. The template replacement system will resolve them to proper `vscode-webview://` URIs at runtime.

#### 3b. Rewrite `updateAutobanButtonState()` (line 4060-4067)

The current function uses `autobanBtn.textContent = ...` which would destroy the `<img>` child element in the new icon button. Rewrite to use class-based state toggling:

```javascript
function updateAutobanButtonState() {
    const autobanBtn = document.getElementById('btn-autoban');
    if (!autobanBtn) return;
    const isEnabled = !!(autobanConfig && autobanConfig.enabled);
    autobanBtn.classList.toggle('is-active', isEnabled);
    autobanBtn.dataset.tooltip = isEnabled ? 'Stop automation engine' : 'Start automation engine';
    // Optionally swap icon for visual clarity:
    const img = autobanBtn.querySelector('img');
    if (img) {
        img.alt = isEnabled ? 'Stop Automation' : 'Start Automation';
        // Could swap src here if a stop-icon constant is added later
    }
}
```

#### 3c. Rewrite `updateCliToggleUi()` (line 3358-3367)

The current function queries `#cli-triggers-toggle` and `#cli-toggle` — both removed in the new HTML. Rewrite to target the new `#btn-cli-triggers` icon button:

```javascript
function updateCliToggleUi() {
    const btn = document.getElementById('btn-cli-triggers');
    if (btn) {
        btn.classList.toggle('is-active', !!cliTriggersEnabled);
        btn.classList.toggle('is-off', !cliTriggersEnabled);
    }
}
```

#### 3d. Replace CLI toggle event listener (line 5601-5606)

Remove the old `#cli-triggers-toggle` change listener and add a click handler for `#btn-cli-triggers`:

```javascript
// OLD (remove):
// document.getElementById('cli-triggers-toggle').addEventListener('change', (event) => { ... });

// NEW:
document.getElementById('btn-cli-triggers')?.addEventListener('click', () => {
    cliTriggersEnabled = !cliTriggersEnabled;
    updateCliToggleUi();
    postKanbanMessage({ type: 'toggleCliTriggers', enabled: cliTriggersEnabled });
});
```

#### 3e. Update Collapse Coders handler (line 5828-5844)

The existing handler already uses `classList.toggle('is-active')` which works with the new icon button. The only change needed is the button element is now a `.strip-icon-btn` instead of `.strip-btn`, but the JS logic is identical. No code change required — just verify it still works after the HTML swap.

#### 3f. Remove `#cli-triggers-toggle` initial checked state

The old HTML had `<input type="checkbox" id="cli-triggers-toggle" checked>`. The new icon button initializes its visual state via `updateCliToggleUi()` which is already called at line 5635. Ensure `updateCliToggleUi()` runs after the new `#btn-cli-triggers` element exists in the DOM.

### 4. Icon Selection (Placeholders)
Using icons from `/icons/` folder via the `{{ICON_XX}}` placeholder system:
- **Start Automation**: `{{ICON_22}}` → `25-1-100 Sci-Fi Flat icons-22.png` (play-like icon)
- **CLI Triggers**: `{{ICON_28}}` → `25-1-100 Sci-Fi Flat icons-28.png` (toggle-like icon)
- **Collapse Coders**: `{{ICON_41}}` → `25-1-100 Sci-Fi Flat icons-41.png` (collapse/expand-like icon)

**Note**: User will replace these with unique icons later.

## Proposed Changes

### src/webview/kanban.html — HTML (lines 1920-1947)
- **Context:** The `.controls-strip` div contains all function bar controls for the kanban tab.
- **Logic:** Reorder children: workspace/project controls first, flex spacer, then automation/view controls. Replace text buttons with icon buttons. Remove CLI toggle switch and strip divider.
- **Implementation:** See Section 1 (Target HTML) above. Replace the entire `<div class="controls-strip">...</div>` block.
- **Edge Cases:** Hidden elements (`workspace-filter-badge`, `workspace-control-plane-badge`, `workspace-reset-control-plane`, `btn-delete-project`, `project-filter-badge`) must remain in the DOM for their existing show/hide logic to work. Their position within the strip doesn't matter since they're hidden by default.

### src/webview/kanban.html — CSS (line 110-118, and new rules near line 196)
- **Context:** `.controls-strip` currently has `flex-wrap: wrap` which conflicts with the flex-spacer layout.
- **Logic:** Remove `flex-wrap: wrap` to ensure single-row layout. Add `.strip-icon-btn` class with hover, active, and off states.
- **Implementation:** See Section 2 above.
- **Edge Cases:** The `.strip-icon-btn.is-active` style must be visually distinct enough to convey toggle state without text labels. The `.is-off` state (for CLI Triggers disabled) uses orange tint matching the existing `.cli-toggle.is-off` convention.

### src/webview/kanban.html — JavaScript (lines 3073, 3358-3367, 4060-4067, 5601-5606)
- **Context:** Three JS functions and one event listener reference removed DOM elements.
- **Logic:** Add icon constants, rewrite `updateAutobanButtonState()` to use class toggling instead of `textContent`, rewrite `updateCliToggleUi()` to target `#btn-cli-triggers`, replace change listener with click handler.
- **Implementation:** See Sections 3a-3d above.
- **Edge Cases:** The `cliTriggersState` backend message handler (line 5136-5138) calls `updateCliToggleUi()` — the rewritten function must handle the case where `#btn-cli-triggers` doesn't exist yet (early load race). The existing `if (btn)` guard handles this.

### src/services/KanbanProvider.ts — No changes needed
- **Context:** The `iconMap` (lines 6454-6472) already contains `{{ICON_22}}`, `{{ICON_28}}`, and `{{ICON_41}}` entries.
- **Logic:** The new JS constants `ICON_AUTOBAN`, `ICON_CLI_TRIGGERS`, `ICON_COLLAPSE_CODERS` use these existing placeholders, so no new entries are required.

## Verification Plan

### Manual Verification
- [ ] Verify workspace/project dropdown is leftmost
- [ ] Verify ASSIGN button is beside dropdown
- [ ] Verify Add Plan button is beside ASSIGN
- [ ] Verify right-side controls are right-aligned (flex spacer works)
- [ ] Verify Start Automation icon button toggles automation on/off
- [ ] Verify Start Automation icon shows `.is-active` state when running
- [ ] Verify CLI Triggers icon button toggles CLI triggers on/off
- [ ] Verify CLI Triggers icon shows `.is-active` (on) and `.is-off` (off) states
- [ ] Verify Pair Programming dropdown still works
- [ ] Verify Collapse Coders icon button toggles collapse
- [ ] Verify Collapse Coders icon shows `.is-active` state when collapsed
- [ ] Verify tooltips display correctly on all icon buttons
- [ ] Verify hover states on icon buttons
- [ ] Verify layout does not wrap on narrow viewports (flex-wrap removed)
- [ ] Verify backend `cliTriggersState` message correctly updates icon button visual state
- [ ] Verify backend `updateAutobanConfig` message correctly updates icon button visual state
- [ ] Verify hidden elements (badges, reset button, delete button) still appear/hide correctly

## Testing Checklist
- [ ] Verify workspace/project dropdown is leftmost
- [ ] Verify ASSIGN button is beside dropdown
- [ ] Verify Add Plan button is beside ASSIGN
- [ ] Verify right-side controls are right-aligned
- [ ] Verify Start Automation icon button works (toggles automation)
- [ ] Verify CLI Triggers icon button works (toggles CLI triggers)
- [ ] Verify Pair Programming dropdown still works
- [ ] Verify Collapse Coders icon button works (toggles collapse)
- [ ] Verify tooltips display correctly on icon buttons
- [ ] Verify visual feedback (hover states, active states)
- [ ] Verify layout does not break on narrow viewports

## Recommendation
Complexity 5 → **Send to Coder**
