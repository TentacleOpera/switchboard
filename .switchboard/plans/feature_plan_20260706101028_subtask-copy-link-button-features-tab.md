# Add Copy Link button to subtask meta bar in Features tab

## Goal

### Problem
In the Features tab of `project.html`, when a user clicks on an individual subtask (a plan that belongs to a feature), the preview meta bar ("functions bar") is rendered by `renderFeatureSubtaskMetaBar()`. This bar shows a "Subtask" label, a Complexity indicator, and Edit / Save / Cancel / Delete buttons — but it is **missing a Copy Link button**.

Every other plan-viewing surface in the same webview already has a Copy Link button:
- The Kanban tab meta bar (`kanban-meta-copy-link-btn`, project.js:1807)
- The Kanban sidebar list items (`.kanban-plan-copy-link`, project.js:1570)
- The Features tab feature-card list items (`.kanban-plan-copy-link.feature-card-action`, project.js:2179)

The subtask meta bar is the only plan preview surface without one, so users must back out to the feature card list to copy a subtask's plan-file link — an inconsistency discovered during testing.

### Root Cause
`renderFeatureSubtaskMetaBar(plan)` (project.js:2400–2488) builds its innerHTML without emitting a Copy Link button, and has no click-listener wiring for one. The `plan` object it receives already carries `planFile` (set at project.js:2515 from the cache or the link's `data-plan-file`), so all data needed for the button is present — it was simply never added.

## Metadata
- **Tags:** ui, features-tab, copy-link, subtask, project-panel
- **Complexity:** 2

## Complexity Audit

**Tier: Routine**

This is a pure UI additive change that mirrors an existing, well-established pattern (the Kanban meta bar Copy Link button at project.js:1807–1840). No backend changes, no state-machine changes, no data-model changes. The CSS class `.kanban-plan-copy-link` is already defined in project.html:386. The `toAgentRef()` helper is already in scope. The only risk is a duplicate-ID collision, which is avoided by using a unique element id (see Proposed Changes).

## Edge-Case & Dependency Audit

1. **Subtask with no `planFile`** — Some subtask previews are loaded from a `data-plan-file` attribute that could be empty (project.js:2499 guards with `st.planFile || ''`). The button must be conditionally rendered only when `plan.planFile` is truthy, exactly as the Kanban meta bar does (`${plan.planFile ? ... : ''}`). ✅ handled by conditional emission.

2. **Subtask with no `planId`** — `renderFeatureSubtaskMetaBar` already gates the Complexity and Delete controls behind `hasPlanId`. Copy Link only needs `planFile`, not `planId`, so it should be gated on `plan.planFile` independently — not on `hasPlanId`. This means a subtask resolved purely from a file path (the fallback object at project.js:2515) still gets a Copy Link button. ✅ correct behavior.

3. **Element ID collision** — The Kanban meta bar uses `kanban-meta-copy-link-btn`. The feature-card list uses a class-based selector. The subtask meta bar must use a **distinct id** (e.g. `feature-subtask-meta-copy-link-btn`) because `renderFeatureSubtaskMetaBar` and `renderFeatureMetaBar` render into the **same** `#feature-preview-meta-bar` container. Reusing the kanban id would not collide (different tabs), but reusing a feature-level id would. A dedicated subtask id is safest. ✅ handled.

4. **Edit-mode visibility** — Copy Link is a read-only action; it should remain visible in both view and edit modes (unlike Edit/Save/Cancel which toggle). The Kanban meta bar keeps Copy Link always visible, so we mirror that. ✅ no special toggling needed.

5. **Clipboard API in VS Code webview** — `navigator.clipboard.writeText` is already used successfully by the other Copy Link buttons in this same webview, so no sandbox concern. ✅ verified by existing working buttons.

6. **No confirm dialog** — Per project rule (CLAUDE.md), Copy Link is non-destructive and needs no confirm gate. ✅ compliant.

## Proposed Changes

### File: `src/webview/project.js`

**Change 1 — Add the Copy Link button to the subtask meta bar HTML (in `renderFeatureSubtaskMetaBar`).**

Insert the button into the complexity group (or as a standalone next to it), gated on `plan.planFile`. Place it inside the `complexityGroup` block so it sits next to the complexity indicator, mirroring the Kanban meta bar layout.

At project.js:2409–2418, the `complexityGroup` is built. Add a `copyLinkBtn` constant and emit it:

```js
const copyLinkBtn = plan && plan.planFile
    ? `<button class="strip-btn" id="feature-subtask-meta-copy-link-btn" title="Copy plan link to clipboard">Copy Link</button>`
    : '';
```

Then in the `metaBar.innerHTML` template (project.js:2422–2433), insert `${copyLinkBtn}` after the complexity group and before the right-aligned action group:

```js
metaBar.innerHTML = `
    <div class="kanban-meta-group">
        <span class="kanban-meta-label" style="color: var(--text-secondary); font-style: italic;">Subtask</span>
    </div>
    ${complexityGroup}
    ${copyLinkBtn}
    <div class="kanban-meta-group" style="margin-left: auto;">
        <button class="strip-btn" id="btn-edit-features" style="${state.editMode.features ? 'display:none;' : ''}">Edit</button>
        <button class="strip-btn" id="btn-save-features" style="${state.editMode.features ? '' : 'display:none;'}">Save</button>
        <button class="strip-btn" id="btn-cancel-features" style="${state.editMode.features ? '' : 'display:none;'}">Cancel</button>
        ${deleteBtn}
    </div>
`;
```

**Change 2 — Wire the click listener (in `renderFeatureSubtaskMetaBar`).**

After the existing listener-wiring block (project.js:2435–2456 area), add the Copy Link handler. This mirrors the Kanban meta bar handler at project.js:1830–1840:

```js
// Copy Link — mirror kanban meta bar pattern (project.js:1830-1840)
const subtaskCopyLinkBtn = document.getElementById('feature-subtask-meta-copy-link-btn');
if (subtaskCopyLinkBtn) {
    subtaskCopyLinkBtn.addEventListener('click', () => {
        const path = plan.planFile;
        navigator.clipboard.writeText(toAgentRef(path)).then(() => {
            const oldText = subtaskCopyLinkBtn.textContent;
            subtaskCopyLinkBtn.textContent = 'Copied';
            setTimeout(() => { subtaskCopyLinkBtn.textContent = oldText; }, 2000);
        });
    });
}
```

This block should be placed **outside** the `if (hasPlanId)` guard (project.js:2459) since Copy Link only requires `planFile`, not `planId`.

### No other files need changes
- `project.html` — the `.kanban-plan-copy-link` and `.strip-btn` CSS classes already exist (project.html:386, plus the general `.strip-btn` styles). The button uses `strip-btn` class for consistent styling with the other meta-bar buttons.
- No backend/extension-side changes — Copy Link is a pure client-side clipboard operation using the already-available `toAgentRef()` helper.

## Verification Plan

1. **Manual (webview):** Open the project panel → Features tab → click a feature card to expand it → click a subtask link in the Subtasks accordion. Confirm the preview meta bar now shows a "Copy Link" button between the complexity indicator and the Edit/Save/Cancel group.
2. **Click Copy Link** → paste into a text field → confirm the clipboard contains the agent-ref link (same format as the Kanban tab's Copy Link produces).
3. **Visual feedback:** Confirm the button text temporarily changes to "Copied" for ~2 seconds then reverts.
4. **Edge case — subtask with no planId:** Click a subtask whose plan isn't in the kanban cache (fallback object at project.js:2515). Confirm Copy Link still appears (gated on `planFile`, not `planId`) and works, while Delete and Complexity correctly stay hidden.
5. **Edge case — subtask with no planFile:** If a subtask link has an empty `data-plan-file`, confirm no Copy Link button renders (no broken empty button).
6. **No regression:** Switch back to the feature-level view (click the feature card itself, not a subtask). Confirm `renderFeatureMetaBar` still renders correctly and is not affected by the new code (different render path, same container — verify no stale button remains).
7. **Build:** Run `npm run compile` to confirm no webpack/TS errors are introduced (project.js is a webview asset bundled via webpack).
