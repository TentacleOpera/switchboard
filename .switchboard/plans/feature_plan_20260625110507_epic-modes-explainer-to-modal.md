# Move "How to Run an Epic" Explainer Into a Modal Opened by a Question-Mark Button

## Goal

Replace the always-visible `<details>` "How to run an epic (3 ways)" explainer in the Epics tab of `project.html` with a compact question-mark (?) button that opens a modal containing the same content. This declutters the Epics tab controls strip while keeping the three execution-mode instructions (Step / Orchestrate / Split) discoverable on demand.

### Problem analysis & root cause

The Epics tab currently renders a `<details class="epic-modes-explainer">` element (`project.html:1481-1488`) directly below the controls strip. It is always present in the DOM, occupies vertical space even when collapsed, and visually competes with the workspace filter / New Epic buttons above it. The content is reference material — the user only needs it occasionally when they forget how epic orchestration works — so it should be an on-demand affordance, not a permanent fixture.

The root cause is a design choice in the original epic-orchestration-onramp plan (Phase 2) that placed the explainer as an inline `<details>` for simplicity. A modal triggered by a small `?` button is the established pattern in this codebase (e.g. the New Epic modal at `project.html:1622` and the Epic Orchestration overlay at `project.html:1649` both use the `.kanban-log-overlay` / `.kanban-log-modal` pattern).

## Metadata

- **Tags:** `feature`, `ui`, `epics-tab`
- **Complexity:** 2/10 (pure HTML/CSS/JS — move existing content into an existing modal pattern, add a trigger button)

## Complexity Audit

### Routine
- Adding a `?` button to the Epics tab controls strip and a new `.kanban-log-overlay` modal — both follow the established pattern (`project.html:1622-1646` for the New Epic modal, `project.html:1649-1664` for the orchestrate overlay).
- Moving the three-mode explainer text from the `<details>` into the modal body — copy-paste of existing HTML.
- Wiring the open/close handlers in `project.js` — follows the same `vscode.postMessage` / `addEventListener` convention used by `closeEpicOrchestrateOverlay` (`project.js:1474-1477`).

### Complex / Risky
- None. No backend changes, no state migration, no data flow changes.

## Edge-Case & Dependency Audit

- **Theme compatibility:** The modal reuses `.kanban-log-overlay` / `.kanban-log-modal` which are already theme-aware (styled for afterburner, claudify, cyber themes). No new CSS needed beyond a small `?` button style.
- **No confirmation dialogs** (project rule) — this is a read-only info modal, no confirm gate involved.
- **Mobile/narrow layouts:** The modal uses `max-width: 90vw` (matching the orchestrate overlay at `project.html:1650`), so it adapts to narrow viewports.
- **Accessibility:** The `?` button should have a `title` attribute ("How to run an epic") for hover tooltip.

## Proposed Changes

### `src/webview/project.html`

**1. Remove the `<details>` explainer (lines 1481-1488):**

```html
<!-- DELETE this block -->
<details class="epic-modes-explainer" style="margin: 0 8px 6px; font-size: 11px; color: var(--text-secondary);">
    <summary style="cursor: pointer;">How to run an epic (3 ways)</summary>
    <div style="padding: 6px 4px 2px; line-height: 1.5;">
        <div><b>Step</b> — drag the epic column-to-column on the board; each column's agent batch-processes every subtask.</div>
        <div><b>Orchestrate</b> — click <b>Orchestrate</b> below; one orchestrator agent runs the whole epic end-to-end with native subagents.</div>
        <div><b>Split (recommended)</b> — drag the epic to the <b>Planner</b> column to improve every subtask plan, <i>then</i> click <b>Orchestrate</b> here to hand the improved epic to the orchestrator to implement.</div>
    </div>
</details>
```

**2. Add a `?` button to the controls strip (after the `+ New Epic` button, line 1479):**

```html
<button id="btn-new-epic" class="strip-btn">+ New Epic</button>
<button id="btn-epic-modes-help" class="strip-btn" title="How to run an epic (3 ways)" style="font-weight: bold; min-width: 28px; padding: 2px 8px;">?</button>
```

**3. Add the modal overlay (after the Epic Orchestration overlay, ~line 1664):**

```html
<!-- Epic Modes Help Modal -->
<div id="epic-modes-help-overlay" class="kanban-log-overlay" style="display: none;">
    <div class="kanban-log-modal" style="width: 480px; max-width: 90vw;">
        <div style="padding: 12px 16px; font-weight: bold; border-bottom: 1px solid var(--border-color);">
            How to Run an Epic (3 Ways)
        </div>
        <div style="padding: 16px; line-height: 1.6; font-size: 12px;">
            <div style="margin-bottom: 10px;"><b>Step</b> — drag the epic column-to-column on the board; each column's agent batch-processes every subtask.</div>
            <div style="margin-bottom: 10px;"><b>Orchestrate</b> — click <b>Orchestrate</b> on an epic; one orchestrator agent runs the whole epic end-to-end with native subagents.</div>
            <div><b>Split (recommended)</b> — drag the epic to the <b>Planner</b> column to improve every subtask plan, <i>then</i> click <b>Orchestrate</b> in the Epics tab to hand the improved epic to the orchestrator to implement.</div>
        </div>
        <div class="kanban-log-close" style="display: flex; justify-content: flex-end; padding: 12px 16px;">
            <button id="btn-epic-modes-help-close" class="strip-btn">Close</button>
        </div>
    </div>
</div>
```

### `src/webview/project.js`

**4. Add open/close handlers (near the epic orchestration handlers, ~line 1530):**

```javascript
// ---- Epic modes help modal ----
const btnEpicModesHelp = document.getElementById('btn-epic-modes-help');
const btnEpicModesHelpClose = document.getElementById('btn-epic-modes-help-close');
const epicModesHelpOverlay = document.getElementById('epic-modes-help-overlay');

if (btnEpicModesHelp) btnEpicModesHelp.addEventListener('click', () => {
    if (epicModesHelpOverlay) epicModesHelpOverlay.style.display = 'flex';
});
if (btnEpicModesHelpClose) btnEpicModesHelpClose.addEventListener('click', () => {
    if (epicModesHelpOverlay) epicModesHelpOverlay.style.display = 'none';
});
// Close on overlay backdrop click
if (epicModesHelpOverlay) epicModesHelpOverlay.addEventListener('click', (e) => {
    if (e.target === epicModesHelpOverlay) epicModesHelpOverlay.style.display = 'none';
});
```

### `src/webview/project.html` — CSS cleanup (optional)

**5. Remove the now-unused `.epic-modes-explainer` style if present** (check for a CSS rule referencing it; if none exists inline, no action needed — the `<details>` used only inline styles).

## Verification Plan

> Manual verification against an installed VSIX (per project norm).

### Manual Verification

1. **Modal opens:** Click the `?` button in the Epics tab controls strip → the "How to Run an Epic (3 Ways)" modal appears with all three modes described.
2. **Modal closes:** Click "Close" or click the overlay backdrop → modal disappears.
3. **No inline explainer:** The old `<details>` "How to run an epic" block is gone from the Epics tab — the controls strip is cleaner.
4. **Tooltip:** Hover the `?` button → "How to run an epic (3 ways)" tooltip appears.
5. **Theme check:** Open in afterburner, claudify, and cyber themes → modal renders correctly (reuses `.kanban-log-overlay` / `.kanban-log-modal` which are already theme-aware).
6. **No regression:** The Orchestrate button, + Subtask, Delete Epic, and New Epic buttons all still work as before.
