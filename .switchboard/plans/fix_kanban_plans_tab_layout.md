# Fix Kanban Plans Tab Layout

## Goal

Fix three UAT failures in the Kanban Plans tab of `planning.html`: the preview pane is too narrow (should be 2/3 width), status badges are in the wrong position (should replace the action buttons), and the tab order is incorrect (Kanban Plans should be third, after Online Docs).

## Metadata

**Tags:** frontend, UI, UX, bugfix
**Complexity:** 3

## User Review Required

None — purely cosmetic and structural UI fixes with no state, security, or data concerns.

## Complexity Audit

### Routine
- CSS flex-ratio tweak to rebalance a two-pane layout
- HTML template change in a JS `innerHTML` block (remove buttons, reposition badge)
- Reordering six `<button>` elements in a tab strip
- Removing a one-line `BUTTON` guard in a click handler

### Complex / Risky
- None

## Edge-Case & Dependency Audit

### Race Conditions
- None. All changes are rendering/layout only.

### Security
- None. No data flow changes.

### Side Effects
- Removing the "Open File" and "Set Context" buttons leaves three orphaned JS handlers (lines 2293–2316, 2411–2423, 2425–2429 of `planning.js`). These will silently no-op — no runtime errors — but are dead code and should be cleaned up as part of this task.
- `handleKanbanContextSet` (lines 2411–2423) re-enables buttons that will no longer exist. The extension host may still send `kanbanContextSet` messages; the handler will silently loop over an empty NodeList. Clean up this dead handler.

### Dependencies & Conflicts
- **CSS fix must use flex sizing, NOT `grid-template-columns`.** The `#kanban-content-row` element already has `display: flex` set via an existing inline rule at line 1353, which overrides the `.content-row { display: grid }` base class. Inserting `grid-template-columns` on a flex container has zero effect. The correct approach is to update the flex values on the child panes (`#kanban-list-pane` and `.kanban-preview-pane`).

## Dependencies

- None (self-contained UI fix, no dependency on other planned sessions)

## Adversarial Synthesis

Key risks: the plan's original CSS fix (`grid-template-columns`) is incorrect because `#kanban-content-row` is already a flex container, making the override a no-op; the plan also omits cleanup of three orphaned JS handlers that will become dead code after button removal. Mitigations: use flex ratio overrides (`flex: 1` / `flex: 2`) on the child panes instead of grid; explicitly remove the orphaned handler blocks and button CSS as required steps, not optional cleanup.

## Problem

In planning.html, the kanban plans tab has three issues that failed UAT:

1. **Plan preview takes too little room**: Currently the preview pane is roughly 1/2 of the screen (280px fixed sidebar + 1fr preview). It should be 2/3 of the screen instead.

2. **Status labels misplaced**: The status labels (column badges) are currently shown next to the plan topic. They should be in place of the "Open File" and "Set Context" buttons on each plan item, which have no point now and should be removed.

3. **Tab order incorrect**: The Kanban Plans tab should be third (after Online Docs), with Clipboard Import fourth, Research fifth, and NotebookLM sixth.

## Root Cause

- The `#kanban-content-row` uses `display: flex` (set by an existing inline CSS rule at line 1353 of `planning.html`). The child panes both default to `flex: 1`, giving each pane 50% of the available width.
- The JavaScript rendering in `planning.js` places the status badge inline with the plan topic and includes "Open File" and "Set Context" action buttons that are no longer needed.

## Proposed Changes

### `planning.html` (CSS)

#### [MODIFY] [planning.html](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.html) — Pane ratio fix

**Current state (line 1353–1355)**:
```css
#kanban-content-row { display: flex; gap: 0; height: 100%; overflow: hidden; }
#kanban-list-pane { flex: 1; overflow-y: auto; }
.kanban-preview-pane { flex: 1; overflow-y: auto; padding: 12px; border-left: 1px solid var(--border-color, rgba(255,255,255,0.08)); }
```

**Target state** — Update the flex values to 1:2 ratio:
```css
#kanban-content-row { display: flex; gap: 0; height: 100%; overflow: hidden; }
#kanban-list-pane { flex: 1; overflow-y: auto; }
.kanban-preview-pane { flex: 2; overflow-y: auto; padding: 12px; border-left: 1px solid var(--border-color, rgba(255,255,255,0.08)); }
```

Only change: `.kanban-preview-pane` changes from `flex: 1` to `flex: 2`.

> **Clarification**: The plan originally proposed inserting a `grid-template-columns` rule "after line 238". That instruction was incorrect — the kanban row is a flex container, not a grid container. The correct fix is changing the `flex` value on `.kanban-preview-pane` at line 1355. Do NOT insert a new rule at line 238.

#### [MODIFY] [planning.html](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.html) — Remove unused button CSS (required)

**Remove lines 1382–1390**:
```css
.kanban-plan-actions button {
    font-size: 11px; padding: 2px 8px;
    border-radius: 4px; cursor: pointer;
    background: rgba(255,255,255,0.07);
    border: 1px solid rgba(255,255,255,0.1);
    color: inherit;
    transition: background 0.1s;
}
.kanban-plan-actions button:hover { background: rgba(255,255,255,0.14); }
```

These styles target buttons that will no longer exist after the JS change. This is required cleanup, not optional.

#### [MODIFY] [planning.html](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.html) — Tab order fix

**Current tab order (lines 1419–1424)**:
```html
<button class="research-tab-btn active" data-tab="local">LOCAL DOCS</button>
<button class="research-tab-btn" data-tab="online">ONLINE DOCS</button>
<button class="research-tab-btn" data-tab="clipboard">CLIPBOARD IMPORT</button>
<button class="research-tab-btn" data-tab="notebook">NotebookLM</button>
<button class="research-tab-btn" data-tab="research">RESEARCH</button>
<button class="research-tab-btn" data-tab="kanban">KANBAN PLANS</button>
```

**New tab order**:
```html
<button class="research-tab-btn active" data-tab="local">LOCAL DOCS</button>
<button class="research-tab-btn" data-tab="online">ONLINE DOCS</button>
<button class="research-tab-btn" data-tab="kanban">KANBAN PLANS</button>
<button class="research-tab-btn" data-tab="clipboard">CLIPBOARD IMPORT</button>
<button class="research-tab-btn" data-tab="research">RESEARCH</button>
<button class="research-tab-btn" data-tab="notebook">NotebookLM</button>
```

---

### `planning.js` (JavaScript)

#### [MODIFY] [planning.js](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.js) — Remove buttons, reposition badge (lines 2243–2257)

**Current rendering**:
```javascript
itemDiv.innerHTML = `
    <div style="width: 100%;">
        <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;">
            <span class="kanban-plan-topic">${escapeHtml(plan.topic)}</span>
            <span class="kanban-column-badge ${badgeClass}">${escapeHtml(plan.column)}</span>
        </div>
        <div class="kanban-plan-meta" style="margin-top: 4px;">
            ${escapeHtml(metaParts.join(' · '))} · ${escapeHtml(displayTime)}
        </div>
        <div class="kanban-plan-actions">
            <button class="kanban-action-open" data-path="${escapeHtml(plan.planFile)}">Open File</button>
            <button class="kanban-action-context" data-path="${escapeHtml(plan.planFile)}">Set Context</button>
        </div>
    </div>
`;
```

**New rendering**:
```javascript
itemDiv.innerHTML = `
    <div style="width: 100%;">
        <div style="display: flex; align-items: flex-start; gap: 8px;">
            <span class="kanban-plan-topic">${escapeHtml(plan.topic)}</span>
        </div>
        <div class="kanban-plan-meta" style="margin-top: 4px;">
            ${escapeHtml(metaParts.join(' · '))} · ${escapeHtml(displayTime)}
        </div>
        <div class="kanban-plan-actions">
            <span class="kanban-column-badge ${badgeClass}">${escapeHtml(plan.column)}</span>
        </div>
    </div>
`;
```

Changes:
- Removed status badge from the topic row
- Removed "Open File" and "Set Context" buttons from the actions div
- Moved status badge into the `kanban-plan-actions` div

#### [MODIFY] [planning.js](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.js) — Remove BUTTON guard (line 2262)

**Remove**:
```javascript
// If they clicked on buttons, don't trigger row click preview
if (e.target.tagName === 'BUTTON') return;
```

No buttons remain in plan items, so this guard is dead code.

#### [MODIFY] [planning.js](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.js) — Remove orphaned button handlers (lines 2292–2316)

**Remove the entire block**:
```javascript
// Action buttons
const btnOpen = itemDiv.querySelector('.kanban-action-open');
const btnContext = itemDiv.querySelector('.kanban-action-context');

if (btnOpen) {
    btnOpen.addEventListener('click', (e) => {
        e.stopPropagation();
        const path = btnOpen.dataset.path;
        if (path) {
            vscode.postMessage({ type: 'openKanbanPlan', filePath: path });
        }
    });
}

if (btnContext) {
    btnContext.addEventListener('click', (e) => {
        e.stopPropagation();
        const path = btnContext.dataset.path;
        if (path) {
            btnContext.disabled = true;
            btnContext.innerText = 'Setting...';
            vscode.postMessage({ type: 'setKanbanPlanContext', filePath: path });
        }
    });
}
```

Both `querySelector` calls will return `null` after the HTML change, making these handlers dead code. Remove them.

#### [MODIFY] [planning.js](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.js) — Remove orphaned `handleKanbanContextSet` (lines 2411–2423)

**Remove the function body** (or the whole function if not called from any other path):
```javascript
function handleKanbanContextSet(msg) {
    // Re-enable "Set Context" button
    if (kanbanListPane) {
        kanbanListPane.querySelectorAll('.kanban-action-context').forEach(btn => {
            btn.disabled = false;
            btn.innerText = 'Set Context';
        });
    }
    
    if (!msg.success) {
        alert('Failed to set active context: ' + (msg.error || 'Unknown error'));
    }
}
```

> **Edge Case**: The `!msg.success` alert is useful for surfacing extension host errors. If `handleKanbanContextSet` is still registered as a message handler and `setKanbanPlanContext` messages could be sent from other sources, preserve the error-alert path and just remove the button-re-enable code. Otherwise remove the function entirely.

## Verification Plan

### Automated Tests
- None (UI-only change, no automated coverage)

### Manual Verification

1. Open the kanban plans tab in the planning panel
2. Verify the preview pane takes approximately **2/3** of the screen width (list pane ≈ 1/3)
3. Verify the **status badge** (e.g. "created", "coded") appears below the plan metadata, in the position where "Open File" / "Set Context" buttons used to be
4. Verify **no "Open File" or "Set Context" buttons** are visible on plan items
5. Verify **clicking on a plan item** still opens the preview correctly (the BUTTON guard removal must not break this)
6. Verify the **Edit/Save/Cancel buttons** in the controls strip still work (these must NOT be touched)
7. Verify the tab strip order is: LOCAL DOCS → ONLINE DOCS → KANBAN PLANS → CLIPBOARD IMPORT → RESEARCH → NotebookLM

## Files Changed

- `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.html` (CSS flex fix, button CSS removal, tab reorder)
- `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.js` (HTML template, BUTTON guard, orphaned handlers)

---

**Recommendation: Send to Coder**
