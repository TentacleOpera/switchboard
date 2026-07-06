# Consolidate Subtask "Remove" into the Function Strip; Strip It From the Feature Sidebar

## Goal

In the Project panel's **Features tab**, the subtask preview surface exposes dangerous actions inconsistently:

- The **function strip** (`renderFeatureSubtaskMetaBar`, `src/webview/project.js:2400`) — the meta-bar shown above the subtask preview — currently offers `Edit / Save / Cancel / Delete`. It has the *destructive* action (**Delete**) but not the *safe* one (**Remove**).
- The **sidebar accordion** subtask list (`renderFeatureSubtasks`, `src/webview/project.js:2508`) renders an inline **Remove** link on every subtask row, mixing a dangerous action into what should be a plain navigation list.

**Core problem:** the two dangerous subtask operations are split across two surfaces. The strip is the intended home for row-level actions (it already hosts Edit/Save/Cancel/Delete/Copy Link/complexity), yet the safe-but-dangerous **Remove** lives inline in the sidebar next to every link, where it clutters navigation and is easy to fat-finger.

**Fix:** move **Remove** into the function strip next to **Delete**, and strip the inline Remove button (and its handler) out of the sidebar. The sidebar becomes pure navigation (subtask link → preview); the strip becomes the single home for both dangerous actions.

### Background — Delete vs Remove are NOT the same operation

Tracing the two message handlers in `src/services/PlanningPanelProvider.ts` confirms they are semantically distinct and both must remain available:

- **Delete** → `type: 'deleteKanbanPlan'` (handler `PlanningPanelProvider.ts:3528`). **Destructive.** Runs `deletePlanByPlanId` (`DELETE FROM plans WHERE plan_id = ?`) **and** `fs.unlink`s the `.md` plan file from disk. The subtask plan ceases to exist.
- **Remove** → `type: 'removeSubtaskFromFeature'` (handler `PlanningPanelProvider.ts:3640`). **Non-destructive.** Runs `updateFeatureStatus(planId, 0, '')`, which only clears `feature_id`/`is_feature`. The plan row and file survive — the subtask is detached from the feature and returns to the board as a standalone plan. The ex-parent feature's complexity is recomputed.

Because Remove is reversible and Delete is not, the two buttons must be **visually distinguishable** even though both sit in the strip.

### Root cause

Historical: the strip was built to mirror the kanban meta-bar (which has Delete but no feature concept), while Remove was bolted onto the sidebar list because that was the only place subtasks were enumerated before the preview strip existed. The Remove-in-sidebar path (`project.js:2544-2553`) predates the strip gaining per-subtask actions, so it was never migrated.

## Metadata

**Complexity:** 2
**Tags:** frontend, ui, ux, refactor

## Non-Goals

- No change to the backend message handlers (`deleteKanbanPlan`, `removeSubtaskFromFeature`) — the wire protocol is unchanged; only which UI element emits `removeSubtaskFromFeature` moves.
- No confirmation dialogs on either button (per project hard rule; `confirm()` is a no-op in VS Code webviews regardless).
- No change to feature-level Delete (`btn-feature-delete` / `deleteFeature`).

## Implementation

All changes are in `src/webview/project.js` plus a small CSS cleanup in `src/webview/project.html`. (Reminder: the webview loads from `dist/` in the installed VSIX — rebuild before UAT; see Testing.)

### Step 1 — Add the **Remove** button to the strip template

In `renderFeatureSubtaskMetaBar` (`project.js:~2420`), alongside the existing `deleteBtn` const, add a gated `removeBtn`:

```js
const removeBtn = hasPlanId
    ? `<button class="strip-btn" id="feature-subtask-meta-remove-btn" title="Detach this subtask from the feature (keeps the plan)">Remove</button>`
    : '';
const deleteBtn = hasPlanId
    ? `<button class="strip-btn" id="feature-subtask-meta-delete-btn" style="color:#ff6b6b;">Delete</button>`
    : '';
```

In the `metaBar.innerHTML` button group (the `margin-left:auto` group, `project.js:2432-2437`), insert `${removeBtn}` immediately before `${deleteBtn}`:

```html
<div class="kanban-meta-group" style="margin-left: auto;">
    <button class="strip-btn" id="btn-edit-features" ...>Edit</button>
    <button class="strip-btn" id="btn-save-features" ...>Save</button>
    <button class="strip-btn" id="btn-cancel-features" ...>Cancel</button>
    ${removeBtn}
    ${deleteBtn}
</div>
```

**Styling decision:** Remove uses the default `.strip-btn` color (no red); Delete keeps `#ff6b6b`. This gives the reversible detach and the destructive file-delete distinct visual weight so adjacent buttons aren't confused.

### Step 2 — Wire the strip **Remove** handler

Inside the existing `if (hasPlanId) { ... }` block (`project.js:2477-2505`), next to the Delete handler, add:

```js
const rmBtn = document.getElementById('feature-subtask-meta-remove-btn');
if (rmBtn) {
    rmBtn.addEventListener('click', () => {
        vscode.postMessage({
            type: 'removeSubtaskFromFeature',
            subtaskSessionId: plan.sessionId || plan.planId,
            workspaceRoot: plan.workspaceRoot
        });
        // Detach cleanup — mirror the Delete handler: the subtask leaves the
        // feature, so return the preview pane to the selected feature.
        _featureSubtaskPreview = null;
        _featurePreviewFilePath = _featureSelectedPlan ? _featureSelectedPlan.planFile : null;
        if (featuresPreviewContent) featuresPreviewContent.innerHTML = '<div class="kanban-empty-state">Select a feature to preview</div>';
        if (_featureSelectedPlan) renderFeatureMetaBar(_featureSelectedPlan);
        else metaBar.style.display = 'none';
    });
}
```

**Payload note:** the sidebar version sent `subtaskSessionId: st.sessionId || st.planId`. The backend resolves it via `getPlanByPlanId(subtaskSessionId)`, so a planId is a valid value. Using `plan.sessionId || plan.planId` keeps parity with the old sidebar payload and is safe when the cached plan has no `sessionId`.

### Step 3 — Remove the sidebar **Remove** button + handler

In `renderFeatureSubtasks` (`project.js:2515-2520`), drop the Remove button from the row template so each row is link-only:

```js
subtasksDiv.innerHTML = subtasks.map(st => `
    <div class="feature-subtask-item">
        <span class="feature-subtask-link" data-plan-file="${escapeHtml(st.planFile || '')}" style="cursor: pointer; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">• ${escapeHtml(st.topic)} (${escapeHtml(st.kanbanColumn)})</span>
    </div>
`).join('');
```

Then delete the now-orphaned handler-wiring block (`project.js:2544-2553`, the `.feature-remove-subtask-btn` `querySelectorAll` loop) entirely. Keep the `.feature-subtask-link` click→preview wiring (`project.js:2523-2542`) untouched.

### Step 4 — Remove dead CSS

Delete the `.feature-remove-subtask-btn` rule in `src/webview/project.html:493-499` (now unreferenced). Grep the repo for `feature-remove-subtask-btn` first to confirm no remaining references before removing. (CSS is inline per-panel; `shared-tabs.css` is dead and not involved.)

## Edge cases & decisions

- **Subtask with no resolved planId:** `_featureSubtaskPreview` falls back to `{ planId: '', ... }` when the plan isn't in `_kanbanPlansCache` (`project.js:2533`). With `hasPlanId` false, neither Remove nor Delete renders — matches today's Delete gating; no regression.
- **Remove is always valid in the strip:** the strip is only shown via a subtask link, which only exists inside a feature accordion, so a previewed subtask is always a feature member — Remove is never a no-op action against a standalone plan.
- **Sidebar layout:** the row keeps `.feature-subtask-item` with a single `flex:1` link; the flex container is harmless with one child.
- **No confirm gate** on either button (project hard rule).

## Testing (manual UAT via installed VSIX)

Build (`npm run compile`) and reinstall the VSIX, then:

1. Features tab → expand a feature accordion → click a subtask link. **Expect:** preview strip shows `Edit / Save / Cancel / Remove / Delete`, with Remove in default color and Delete in red.
2. Click **Remove**. **Expect:** subtask detaches — it disappears from the feature accordion, the preview returns to the selected feature, and the plan still exists as a standalone card on the board (not deleted).
3. Re-open a subtask and click **Delete**. **Expect:** the plan file is unlinked and the row is gone from the board (destructive).
4. Confirm the sidebar accordion rows show **no** inline Remove links anymore — links only.
5. Confirm no console errors and that `feature-remove-subtask-btn` no longer appears anywhere in `src/`.
