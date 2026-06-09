# Quick Actions Section Above Plan Select

## Goal
Add a dedicated "Quick Actions" section above the plan-select header in `implementation.html` that groups the three primary navigation buttons (OPEN AUTOBAN, PLANNING, OPEN SETUP) at the top of the sidebar for persistent, always-visible access.

---

## Metadata
- **Tags:** frontend, UI, UX
- **Complexity:** 3

---

## User Review Required

> [!IMPORTANT]
> **Button deduplication decision required.** The plan's original "recommended approach" of reusing existing IDs (`btn-open-kanban`, `btn-open-planning`) will produce dead buttons — `getElementById` only binds to the first match. The correct approach is:
> - Use **new unique IDs** for the quick-actions buttons (`btn-quick-kanban`, `btn-quick-planning`, `btn-quick-setup`)
> - **Remove** `btn-open-kanban` / `btn-open-planning` from the `.header-section` (they will be superseded by the new quick-actions bar)
> - Optionally keep `btn-open-central-setup` in the Terminals tab or remove it to reduce redundancy

---

## Complexity Audit

### Routine
- Adding a new `<div class="quick-actions-section">` block with three buttons above `.header-section`
- Adding `.quick-actions-section` CSS rule mirroring `.header-section`
- Adding three event listeners for the new button IDs
- Removing two existing buttons from `.header-section` (lines 1753–1756)

### Complex / Risky
- None

---

## Edge-Case & Dependency Audit

**Race Conditions:** None — all changes are static HTML/CSS; no async or state.

**Security:** None — buttons only fire `postMessage` to the VS Code backend, same as existing buttons.

**Side Effects:**
- Removing `btn-open-kanban` and `btn-open-planning` from `.header-section` will break any existing event listeners bound by ID. Mitigation: the plan adds new listeners on the new IDs; the old listener registration code at lines 2097–2100 must be updated to reference the new IDs (`btn-quick-kanban`, `btn-quick-planning`).
- `btn-open-central-setup` uses ID `btn-open-central-setup` — the new setup button will use `btn-quick-setup`. The existing listener at lines 2101–2106 must also be updated.

**Dependencies & Conflicts:**
- No external dependencies. CSS variables (`--panel-bg`, `--border-color`) already defined in the same file.
- No TypeScript backend changes required — messages (`openKanban`, `openPlanningPanel`, `openSetupPanel`) are unchanged.

---

## Dependencies
- None from prior sessions

---

## Adversarial Synthesis
Key risks: duplicate-ID collision causing dead buttons if old IDs are reused in the new section; visual clutter from tripling button count if original buttons are not removed. Mitigations: use unique IDs (`btn-quick-kanban`, `btn-quick-planning`, `btn-quick-setup`) for the new section, remove the superseded `btn-open-kanban`/`btn-open-planning` rows from `.header-section`, and update the three event listener bindings to the new IDs.

---

## Problem (Original)
In the implementation.html sidebar, the most important buttons are currently scattered:
- "OPEN AUTOBAN" and "PLANNING" buttons are in the `.header-section`, sandwiched between plan-management buttons (COMPLETE / COPY / CREATE)
- "OPEN SETUP" button is in the Terminals sub-tab — buried two taps deep

These navigation-type buttons should be prominently visible at all times in a dedicated, visually distinct zone.

## Solution (Original)
Create a dedicated "Quick Actions" section ABOVE the plan select area in the main container that contains:
1. OPEN AUTOBAN button
2. PLANNING button  
3. OPEN SETUP button

This section should:
- Be placed immediately after the opening of `#main-container` and before the existing `.header-section`
- Use the same styling as the header-section for visual consistency
- Be visible at all times (not dependent on onboarding state)
- Use the existing button styles (secondary-btn with appropriate color classes)

---

## Proposed Changes

### `src/webview/implementation.html`

**Context:** Single-file HTML/CSS/JS webview. All changes are isolated to this file. The `.header-section` currently lives at line 1729; the button registration block is at lines 2097–2106.

**Logic:** Add the quick-actions section before `.header-section`, use unique IDs, update event listeners, remove old buttons.

**Implementation:**

#### Step 1 — Add CSS (insert near `.header-section` rule, around line 91)
```css
.quick-actions-section {
    padding: 12px;
    background: var(--panel-bg);
    border-bottom: 1px solid var(--border-color);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
}
```

#### Step 2 — Add HTML block (insert at line 1728, between `<div id="main-container" ...>` and `<!-- HEADER: PLAN SELECTION -->`)
```html
<!-- QUICK ACTIONS SECTION -->
<div class="quick-actions-section">
    <div class="section-header">
        <div class="section-label">QUICK ACTIONS</div>
    </div>
    <div style="display:flex; gap:6px;">
        <button id="btn-quick-kanban" class="secondary-btn is-teal" style="flex:1">OPEN AUTOBAN</button>
        <button id="btn-quick-planning" class="secondary-btn is-cyan" style="flex:1">PLANNING</button>
        <button id="btn-quick-setup" class="secondary-btn is-teal" style="flex:1">OPEN SETUP</button>
    </div>
</div>
```

#### Step 3 — Remove old buttons from `.header-section` (lines 1753–1756)
Delete:
```html
<div style="margin-top: 6px; display:flex; gap:6px;">
    <button id="btn-open-kanban" class="secondary-btn is-teal" style="flex:1">OPEN AUTOBAN</button>
    <button id="btn-open-planning" class="secondary-btn is-cyan" style="flex:1">PLANNING</button>
</div>
```

#### Step 4 — Update event listeners (lines 2097–2106)
Replace:
```js
const btnKanban = document.getElementById('btn-open-kanban');
if (btnKanban) btnKanban.addEventListener('click', () => vscode.postMessage({ type: 'openKanban' }));
const btnPlanning = document.getElementById('btn-open-planning');
if (btnPlanning) btnPlanning.addEventListener('click', () => vscode.postMessage({ type: 'openPlanningPanel' }));
const btnOpenCentralSetup = document.getElementById('btn-open-central-setup');
if (btnOpenCentralSetup) {
    btnOpenCentralSetup.addEventListener('click', () => {
        vscode.postMessage({ type: 'openSetupPanel' });
    });
}
```
With:
```js
const btnQuickKanban = document.getElementById('btn-quick-kanban');
if (btnQuickKanban) btnQuickKanban.addEventListener('click', () => vscode.postMessage({ type: 'openKanban' }));
const btnQuickPlanning = document.getElementById('btn-quick-planning');
if (btnQuickPlanning) btnQuickPlanning.addEventListener('click', () => vscode.postMessage({ type: 'openPlanningPanel' }));
const btnQuickSetup = document.getElementById('btn-quick-setup');
if (btnQuickSetup) btnQuickSetup.addEventListener('click', () => vscode.postMessage({ type: 'openSetupPanel' }));
// Keep existing btn-open-central-setup listener for backwards compat (Terminals tab button)
const btnOpenCentralSetup = document.getElementById('btn-open-central-setup');
if (btnOpenCentralSetup) {
    btnOpenCentralSetup.addEventListener('click', () => {
        vscode.postMessage({ type: 'openSetupPanel' });
    });
}
```

**Edge Cases:**
- `btn-open-central-setup` in the Terminals tab should be kept to avoid any state-management regressions; the new `btn-quick-setup` is additive.
- If `needsSetup` is true, `main-container` is hidden — the quick-actions section will also be hidden, which is correct behavior.

---

## Files to Modify
- `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/implementation.html`

---

## Verification Plan

### Automated Tests
- No automated webview tests exist for this component; manual verification required.

### Manual Checklist
- [ ] Quick actions section appears at the very top of `#main-container`, above the plan select dropdown
- [ ] OPEN AUTOBAN button (`btn-quick-kanban`) opens the kanban panel
- [ ] PLANNING button (`btn-quick-planning`) opens the planning panel
- [ ] OPEN SETUP button (`btn-quick-setup`) opens the setup panel
- [ ] Styling matches existing `.header-section` (same background, border-bottom, shadow)
- [ ] Old `btn-open-kanban` / `btn-open-planning` row is removed from `.header-section`
- [ ] `btn-open-central-setup` in Terminals tab still works
- [ ] Layout does not overflow sidebar width (~250px) — three `flex:1` buttons should fit
- [ ] Quick-actions section is hidden when `onboarding-container` is shown (i.e., `main-container` is hidden)
- [ ] Existing onboarding buttons (if any) continue to work

## Risks (Original)
- **Low risk**: This is a UI-only change that adds a new section without modifying existing functionality
- **Event listener conflicts**: If we use the same IDs, we need to ensure event listeners are attached before the buttons are rendered (current implementation does this at the bottom of the script)
- **Visual clutter**: Adding three buttons at the top might make the sidebar feel crowded - should monitor user feedback

## Rollback Plan
If the change causes issues, simply:
1. Remove the `.quick-actions-section` div from the HTML
2. Remove the CSS for `.quick-actions-section`
3. Re-add the original `btn-open-kanban` / `btn-open-planning` row to `.header-section`
4. Restore original event listener bindings
5. The existing buttons in terminals will continue to work as before

---

**Send to Coder**

---

## Review Pass Complete

### Stage 1 (Grumpy Principal Engineer)
Look, I'm trying to find something to yell about, but the developer actually followed the spec perfectly. The new HTML block is where it's supposed to be, the new IDs are wired up correctly, the old redundant buttons are deleted, and the backward-compatibility for Terminals was maintained. If I have to be pedantic, jamming three buttons with text like 'OPEN AUTOBAN' into a 250px flex row without explicit overflow handling is asking for text clipping on smaller viewports, but since this was explicitly in your design doc, I guess it's your funeral. The implementation itself is solid.

### Stage 2 (Balanced Review)
The implementation aligns exactly with the requirements. All necessary changes were made without regressions to the event listeners or styles. The component correctly handles IDs and safely preserves backward-compatible components as mandated.

### Fixes Applied
- None required. Implementation strictly follows the plan.

### Files Changed
- `src/webview/implementation.html`

### Validation Results
- Validated CSS class `.quick-actions-section` matches `.header-section`
- Validated new HTML structure uses the specified unique IDs
- Confirmed `btn-open-kanban` and `btn-open-planning` old rows were deleted
- Confirmed JS event listener registration code references `btn-quick-*` appropriately
- Confirmed `btn-open-central-setup` backward compatibility code persists

### Remaining Risks
- **Text Clipping:** 'OPEN AUTOBAN' and 'PLANNING' buttons in a 3-column flex layout within ~250px space may clip or overflow on very narrow viewports, depending on OS text rendering. Recommend monitoring for UI bug reports.
