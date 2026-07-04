# Add Copy Link & Copy Prompt buttons to the Kanban document top bar

## Goal

In `project.html`'s Kanban tab, the **Copy Link** and **Copy Prompt** actions currently exist only on each plan's sidebar list item (`renderKanbanPlans`, <ref_snippet file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/project.js" lines="1785-1786" />). When a user has a plan open in the preview pane, they must scroll the sidebar to find that plan's row to access these buttons. This is friction the user should not have to pay: the document's top bar (the `#kanban-preview-meta-bar`) already shows the column, complexity, and action buttons for the currently-selected plan, so Copy Link and Copy Prompt belong there too — next to the complexity score.

### Problem Analysis & Root Cause

**Current state of the top bar** — `renderKanbanMetaBar(plan)` builds `#kanban-preview-meta-bar` with three groups (<ref_snippet file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/project.js" lines="1972-2002" />):

1. Column group (label + hidden select)
2. Complexity group (label + dot + value + hidden select)
3. Right-aligned action group (`margin-left: auto`) with Save/Cancel (edit mode), Upload (conditional), AutoFetch, Log, Delete.

Copy Link and Copy Prompt are absent from this bar. They are only rendered per-sidebar-item at lines 1785-1786, with handlers wired at lines 1801-1824:

- **Copy Link** (`kanban-plan-copy-link`): `navigator.clipboard.writeText(toAgentRef(planFile))` then transient "Copied" label.
- **Copy Prompt** (`kanban-plan-copy-prompt`): posts `{ type: 'copyKanbanPlanPrompt', sessionId, column, workspaceRoot }` to the extension.

**Root cause of the gap:** The meta bar was built up incrementally and these two actions were never promoted into it. There is no technical blocker — the selected plan (`_kanbanSelectedPlan` / the `plan` argument to `renderKanbanMetaBar`) carries `planFile`, `sessionId`, `column`, and `workspaceRoot`, which is exactly the data the sidebar handlers use. The fix is purely additive: render the two buttons in the complexity group (or immediately after it) and wire identical handlers.

## Metadata

- **Tags:** feature, ui, ux
- **Complexity:** 2
- **Files:** `src/webview/project.js`
- **Project:** switchboard

## User Review Required

- Confirm that placing the Copy Link and Copy Prompt buttons inside the complexity meta group (visually adjacent to the complexity score) is acceptable — an alternative would be a dedicated button group between the complexity group and the right-aligned action group.
- Confirm that the transient "Copied" text feedback (2-second revert via `setTimeout`) feels right for the top bar context, or whether an icon-based indicator (e.g., a checkmark) would be preferred.

## Complexity Audit

### Routine

A purely additive UI change inside one function (`renderKanbanMetaBar`) in one file. No new message types (reuses the existing `copyKanbanPlanPrompt` message and the existing `toAgentRef` clipboard pattern). No backend changes, no migrations, no state changes. The only risk is duplicating logic that already exists in the sidebar — which is acceptable here because the sidebar and meta bar are independently rendered and the logic is two lines each.

### Complex

Not applicable — no cross-file orchestration, no async coordination beyond the existing `navigator.clipboard.writeText` promise, no state machine changes.

### Risky

Not applicable — no data migration, no external API calls, no security-sensitive operations.

## Edge-Case & Dependency Audit

- **Plan with no `planFile`:** Some plans (e.g. session-only entries) have no file path. The sidebar already guards this with `${plan.planFile ? '<button>Copy Link</button>' : ''}` (line 1785). The meta bar Copy Link button must be hidden/disabled the same way when `plan.planFile` is falsy.
- **Plan with no `sessionId`:** Copy Prompt is gated on `plan.sessionId` in the sidebar (line 1786). The meta bar Copy Prompt button must follow the same gate.
- **Transient "Copied" feedback:** The sidebar swaps the button text to "Copied" for 2s (lines 1807-1808). The meta bar button should mirror this so the UX is consistent across both locations.
- **Re-render resets:** `renderKanbanMetaBar` rebuilds `metaBar.innerHTML` on every selection change, so the "Copied" transient state is naturally reset when the user switches plans — no stale-state leak.
- **Edit mode visibility:** The Save/Cancel buttons toggle visibility based on `state.editMode.kanban`. Copy Link/Copy Prompt are not edit-mode actions and should remain visible in both read and edit modes (they copy the file path / prompt, not the buffer content). Place them in the complexity group, not the right-aligned edit-action group, to keep them visually separate from Save/Cancel.
- **No external dependencies.** `toAgentRef` is already loaded globally via `sharedUtils.js` (<ref_snippet file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/sharedUtils.js" lines="7-10" />).

## Dependencies

None. The epic sibling plan touches `tryResolvePendingKanbanSelection`, a different function in the same file; no conflict.

## Adversarial Synthesis

Duplicating the two-line clipboard and postMessage handlers is acceptable given their trivial size, though a future clipboard fallback (e.g. insecure-context polyfill) would need updating in both locations. The primary risk is narrow-viewport crowding when both conditionally-rendered buttons appear alongside the complexity group's existing elements, but `.strip-btn`'s compact sizing and the conditional gates mitigate this in practice. The `setTimeout`-based "Copied" reset is safe against re-render leaks since `innerHTML` rebuild replaces the element entirely, making the old timer's callback a no-op on a detached node.

## Proposed Changes

### `src/webview/project.js` — `renderKanbanMetaBar(plan)`

**1. Add the two buttons into the complexity meta group** (immediately after the complexity `<select>`, before the closing `</div>` of the complexity group at line 1989). Placing them here keeps them visually adjacent to the complexity score as requested.

Replace the complexity group block (lines 1983-1989):

```js
<div class="kanban-meta-group">
    <span class="kanban-meta-label">Complexity:</span>
    <span class="complexity-dot ${complexityClass}"></span>
    <span class="kanban-meta-value" id="kanban-meta-complexity">${complexityLabel}</span>
    <select class="kanban-meta-dropdown" id="kanban-meta-complexity-select" style="display:none;" data-plan-id="${escapeHtml(plan.planId)}" data-workspace-root="${escapeHtml(plan.workspaceRoot)}">
        ${['Unknown', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10'].map(v => `<option value="${v}" ${v === plan.complexity ? 'selected' : ''}>${v}</option>`).join('')}
    </select>
</div>
```

with:

```js
<div class="kanban-meta-group">
    <span class="kanban-meta-label">Complexity:</span>
    <span class="complexity-dot ${complexityClass}"></span>
    <span class="kanban-meta-value" id="kanban-meta-complexity">${complexityLabel}</span>
    <select class="kanban-meta-dropdown" id="kanban-meta-complexity-select" style="display:none;" data-plan-id="${escapeHtml(plan.planId)}" data-workspace-root="${escapeHtml(plan.workspaceRoot)}">
        ${['Unknown', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10'].map(v => `<option value="${v}" ${v === plan.complexity ? 'selected' : ''}>${v}</option>`).join('')}
    </select>
    ${plan.planFile ? `<button class="strip-btn" id="kanban-meta-copy-link-btn" title="Copy plan link to clipboard">Copy Link</button>` : ''}
    ${plan.sessionId ? `<button class="strip-btn" id="kanban-meta-copy-prompt-btn" title="Copy dispatch prompt to clipboard">Copy Prompt</button>` : ''}
</div>
```

**2. Wire the handlers** in the dynamic-listener section of `renderKanbanMetaBar` (after the complexity select toggles, within lines 2004-2089), mirroring the sidebar handlers:

```js
// Copy Link / Copy Prompt — promoted into the top bar so the user does not
// have to locate the plan in the sidebar to access these actions.
const metaCopyLinkBtn = document.getElementById('kanban-meta-copy-link-btn');
if (metaCopyLinkBtn) {
    metaCopyLinkBtn.addEventListener('click', () => {
        const path = plan.planFile;
        navigator.clipboard.writeText(toAgentRef(path)).then(() => {
            const oldText = metaCopyLinkBtn.textContent;
            metaCopyLinkBtn.textContent = 'Copied';
            setTimeout(() => { metaCopyLinkBtn.textContent = oldText; }, 2000);
        });
    });
}
const metaCopyPromptBtn = document.getElementById('kanban-meta-copy-prompt-btn');
if (metaCopyPromptBtn) {
    metaCopyPromptBtn.addEventListener('click', () => {
        vscode.postMessage({
            type: 'copyKanbanPlanPrompt',
            sessionId: plan.sessionId,
            column: plan.column,
            workspaceRoot: plan.workspaceRoot
        });
    });
}
```

No CSS changes are required — the buttons reuse the existing `.strip-btn` class already used by Save/Cancel/Log/Delete in the same bar (within the metaBar.innerHTML template, lines 1972-2002), so they inherit the correct sizing, padding, and theme styling.

## Verification Plan

1. **Apply the change** and reload the `project.html` webview.
2. **Happy path — Copy Link:** Select a plan that has a `planFile`. Confirm the **Copy Link** button appears in the top bar next to the complexity score. Click it; confirm the absolute plan path is on the clipboard (paste into a scratch buffer to verify). Confirm the button text briefly changes to "Copied" then reverts.
3. **Happy path — Copy Prompt:** Select a plan that has a `sessionId`. Confirm the **Copy Prompt** button appears. Click it; confirm the dispatch prompt is copied (the extension's existing `copyKanbanPlanPrompt` handler writes to the clipboard — verify by pasting).
4. **No planFile:** Select a plan with no `planFile` (session-only). Confirm the **Copy Link** button is absent from the top bar. Confirm the **Copy Prompt** button still appears if `sessionId` is present.
5. **No sessionId:** Select a plan with no `sessionId`. Confirm the **Copy Prompt** button is absent. Confirm **Copy Link** still appears if `planFile` is present.
6. **Parity with sidebar:** For a plan that has both, click Copy Link in the top bar and Copy Link on the same plan's sidebar row; confirm both produce identical clipboard contents. Repeat for Copy Prompt.
7. **Plan switch resets state:** Click Copy Link (button shows "Copied"), then immediately select a different plan. Confirm the new plan's top bar renders with "Copy Link" (not a stale "Copied") — `renderKanbanMetaBar` rebuilds innerHTML so this should hold by construction.
8. **Edit mode:** Enter edit mode on a plan (Save/Cancel appear). Confirm Copy Link / Copy Prompt remain visible and functional — they are not edit-buffer actions.
9. **No regressions:** Confirm the existing sidebar Copy Link / Copy Prompt buttons still work unchanged. Confirm the complexity dot/value and the column/complexity dropdowns in the top bar still function.

**Recommendation:** Send to Intern
