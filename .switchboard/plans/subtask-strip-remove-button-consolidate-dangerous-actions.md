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
- **Remove** → `type: 'removeSubtaskFromFeature'` (handler `PlanningPanelProvider.ts:3640`). **Non-destructive.** Resolves the subtask via `getPlanByPlanId(subtaskSessionId)`, then runs `updateFeatureStatus(subtask.planId, 0, '')`, which only clears `feature_id`/`is_feature`. The plan row and file survive — the subtask is detached from the feature and returns to the board as a standalone plan. The ex-parent feature's complexity is recomputed.

Because Remove is reversible and Delete is not, the two buttons must be **visually distinguishable** even though both sit in the strip.

### Root cause

Historical: the strip was built to mirror the kanban meta-bar (which has Delete but no feature concept), while Remove was bolted onto the sidebar list because that was the only place subtasks were enumerated before the preview strip existed. The Remove-in-sidebar path (`project.js:2544-2553`) predates the strip gaining per-subtask actions, so it was never migrated.

## Metadata

**Complexity:** 3
**Tags:** frontend, ui, ux, refactor

## Non-Goals

- No change to the backend message handlers (`deleteKanbanPlan`, `removeSubtaskFromFeature`) — the wire protocol is unchanged; only which UI element emits `removeSubtaskFromFeature` moves.
- No confirmation dialogs on either button (per project hard rule; `confirm()` is a no-op in VS Code webviews regardless).
- No change to feature-level Delete (`btn-feature-delete` / `deleteFeature`).
- **DO NOT touch `src/webview/planning.js` or `src/webview/planning.html`.** The **sidebar panel** (a *separate* webview) renders its own `feature-remove-subtask-btn` at `planning.js:4195` with a delegated handler at `planning.js:6332-6338`. That is out of scope and must keep working. This plan only affects the **Project panel** Features tab (`project.js` / `project.html`). See the Edge-Case audit for why this matters to Step 4.

## User Review Required

- None. This is a mechanical UI consolidation with no product ambiguity: Remove moves from sidebar to strip; both actions and both backend handlers are unchanged. The visual-weight decision (Remove = default color, Delete = red) is fixed below.

## Complexity Audit

### Routine
- Single-file JS change (`src/webview/project.js`): add one button to a template, wire one click handler that mirrors the adjacent Delete handler verbatim, delete one orphaned handler-wiring loop.
- Single-block CSS deletion in `src/webview/project.html`.
- Reuses existing patterns end-to-end (the Delete handler at `project.js:2494-2504` is the exact template for the Remove handler; the payload mirrors the old sidebar payload).
- No backend, no schema, no wire-protocol change.

### Complex / Risky
- **Cross-webview footgun (the one real gotcha):** the CSS class `feature-remove-subtask-btn` is shared by name with the sidebar panel (`planning.js`). Step 4's cleanup must be scoped to `project.*` only; a naive repo-wide grep-and-delete would break the sidebar's Remove button. Documented and fenced in Non-Goals and Step 4.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. All changes are synchronous DOM render + click-handler wiring in a single webview. The Remove click posts a message and optimistically resets the preview pane, identical to the existing Delete flow; the authoritative `kanbanPlansReady` re-render from the backend (`PlanningPanelProvider.ts:3649-3651`) reconciles the accordion afterward.
- **Security:** None. No new user input, no new file paths, no new backend surface. The `removeSubtaskFromFeature` handler already validates via `getPlanByPlanId` and no-ops on an unknown id (`PlanningPanelProvider.ts:3646-3647`).
- **Side Effects:**
  - Removing the `.feature-remove-subtask-btn` CSS rule from `project.html` is safe: after Step 3 nothing in `project.html`'s DOM emits that class. The rule is **not** shared with the sidebar — `planning.html` has **no** `.feature-remove-subtask-btn` rule (verified); its button styles via `.strip-btn` + inline styles. So the rule is genuinely dead *within this document* even though the class name reappears in `planning.js`.
  - `renderFeatureSubtaskMetaBar` has **two** callers: the subtask-link click (`project.js:2534`) and the save-success re-render (`project.js:1055`). Because the new Remove handler is wired **inside** `renderFeatureSubtaskMetaBar` (Step 2), both entry paths get a live handler automatically — no separate wiring needed. (The Goal's phrasing "the strip is only shown via a subtask link" is therefore imprecise; the strip is shown for any `_featureSubtaskPreview`, whether reached by click or by save re-render. In both cases the previewed plan is a real feature member.)
- **Dependencies & Conflicts:**
  - **Payload parity to verify:** the old sidebar sent `subtaskSessionId: st.sessionId || st.planId` where `st` came from the feature's subtask list; the new strip sends `subtaskSessionId: plan.sessionId || plan.planId` where `plan` is the `_kanbanPlansCache` entry (`project.js:2533`). Both objects represent the same plan and the backend resolves either via `getPlanByPlanId`, so behavior should match. This is a parity assumption, not a proven identity — confirm in UAT step 2 that Remove actually detaches the correct subtask.
  - No merge conflicts expected — all edits are localized to `project.js`/`project.html` regions listed in Proposed Changes.

## Dependencies

- None. No upstream session or plan is required before this can be coded.

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) a repo-wide grep-and-delete of `feature-remove-subtask-btn` in Step 4 could clobber the *separate* sidebar-panel Remove in `planning.js` — mitigated by scoping the grep to `project.*` and fencing `planning.js` in Non-Goals; (2) payload parity between the old sidebar `st` object and the new cached `plan` object is assumed, not proven — mitigated by explicit UAT verification that Remove detaches the right subtask. Otherwise this is a low-risk, single-file, pattern-mirroring UI consolidation.

## Proposed Changes

All changes are in `src/webview/project.js` plus a small CSS cleanup in `src/webview/project.html`. (Reminder: the installed VSIX serves the webview from `dist/`, so a rebuild is required before UAT; see Verification Plan. Per session directive, do NOT run compilation as part of this task.)

### `src/webview/project.js`

**Context.** `renderFeatureSubtaskMetaBar(plan)` (line 2400) builds the strip shown above a subtask preview; `renderFeatureSubtasks(feature, subtasks)` (line 2508) renders the sidebar accordion rows. The Remove action must migrate from the second into the first.

**Logic.** Add a gated Remove button to the strip template next to Delete; wire its click handler inside the existing `if (hasPlanId)` block, mirroring the Delete handler's optimistic preview-reset; then delete the sidebar Remove button from the row template and its now-orphaned handler-wiring loop.

**Implementation.**

#### Step 1 — Add the **Remove** button to the strip template

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

**Styling decision:** Remove uses the default `.strip-btn` color (no red); Delete keeps `#ff6b6b`. This gives the reversible detach and the destructive file-delete distinct visual weight so adjacent buttons aren't confused. The new button reuses `.strip-btn`, so **no new CSS is added** (contrast with the removed sidebar button, which had its own `.feature-remove-subtask-btn` rule).

#### Step 2 — Wire the strip **Remove** handler

Inside the existing `if (hasPlanId) { ... }` block (`project.js:2477-2505`), next to the Delete handler (`project.js:2494-2504`), add:

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

**Why inside `renderFeatureSubtaskMetaBar`:** this function is invoked from both the subtask-link click (`project.js:2534`) and the save-success re-render (`project.js:1055`). Wiring the handler here means both entry paths get a live Remove handler with no extra wiring — the same reason the Delete handler lives here.

**Payload note:** the sidebar version sent `subtaskSessionId: st.sessionId || st.planId`. The backend resolves it via `getPlanByPlanId(subtaskSessionId)`, so a planId is a valid value. Using `plan.sessionId || plan.planId` keeps parity with the old sidebar payload and is safe when the cached plan has no `sessionId`. See the Edge-Case audit's parity note — confirm in UAT that the correct subtask detaches.

#### Step 3 — Remove the sidebar **Remove** button + handler

In `renderFeatureSubtasks` (`project.js:2515-2520`), drop the Remove button from the row template so each row is link-only:

```js
subtasksDiv.innerHTML = subtasks.map(st => `
    <div class="feature-subtask-item">
        <span class="feature-subtask-link" data-plan-file="${escapeHtml(st.planFile || '')}" style="cursor: pointer; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">• ${escapeHtml(st.topic)} (${escapeHtml(st.kanbanColumn)})</span>
    </div>
`).join('');
```

Then delete the now-orphaned handler-wiring block (`project.js:2544-2553`, the `.feature-remove-subtask-btn` `querySelectorAll` loop) entirely. Keep the `.feature-subtask-link` click→preview wiring (`project.js:2523-2542`) untouched.

**Edge Cases.**
- **Subtask with no resolved planId:** `_featureSubtaskPreview` falls back to `{ planId: '', ... }` when the plan isn't in `_kanbanPlansCache` (`project.js:2533`). With `hasPlanId` false, neither Remove nor Delete renders — matches today's Delete gating; no regression.
- **Remove is always valid in the strip:** the strip is only rendered for a `_featureSubtaskPreview`, and a previewed subtask reached from a feature accordion is always a feature member — so Remove is never a no-op against a standalone plan. (The empty-fallback case above renders neither button.)
- **Sidebar layout:** the row keeps `.feature-subtask-item` with a single `flex:1` link; the flex container is harmless with one child.
- **No confirm gate** on either button (project hard rule).

### `src/webview/project.html`

**Context.** The sidebar Remove button had a dedicated CSS rule at `project.html:493-499`. After Step 3, nothing in `project.html`'s DOM emits `.feature-remove-subtask-btn`.

**Logic.** Delete the dead rule — but scope the safety-grep so it does not entangle the identically-named class in the *separate* sidebar panel.

**Implementation.**

#### Step 4 — Remove dead CSS

Delete the `.feature-remove-subtask-btn` rule in `src/webview/project.html:493-499` (now unreferenced within this document).

**⚠️ Scoping the safety grep — do this correctly:** confirm the class is unused **within `project.js` and `project.html`** before removing the rule, e.g.:

```sh
grep -n "feature-remove-subtask-btn" src/webview/project.js src/webview/project.html
```

Expect **zero** hits after Steps 1–3. **Do NOT run a repo-wide grep and treat sidebar hits as blockers.** A repo-wide `grep -rn feature-remove-subtask-btn src/` will legitimately return `src/webview/planning.js:4195` and `:6332` — those belong to the **sidebar panel** (`planning.html`), a completely separate webview with its own render + handler, and they **must stay**. `planning.html` has no `.feature-remove-subtask-btn` CSS rule of its own (its button styles via `.strip-btn` + inline styles), so deleting `project.html`'s rule cannot affect the sidebar. CSS is inline per-panel; `shared-tabs.css` is dead and not involved.

**Edge Cases.**
- After removal, verify no `project.html`-scoped selector still references the class (the scoped grep above covers this).
- Do not delete or edit `planning.js` / `planning.html` — see Non-Goals.

## Verification Plan

### Automated Tests

- **None.** Per session directive (SKIP TESTS), no automated tests are added or run for this change. The change is presentation-layer wiring with no unit-testable seam; the effective verification is the manual UAT below.

### Manual UAT (installed VSIX)

Build (`npm run compile`) and reinstall the VSIX — the installed webview loads from `dist/`, so the change is invisible until rebuilt. (Per session directive, the coding agent should NOT run compilation as part of implementation; this build/reinstall step is the user's UAT prerequisite.) Then:

1. Features tab → expand a feature accordion → click a subtask link. **Expect:** preview strip shows `Edit / Save / Cancel / Remove / Delete`, with Remove in default color and Delete in red.
2. Click **Remove**. **Expect:** the *correct* subtask detaches — it disappears from the feature accordion, the preview returns to the selected feature, and the plan still exists as a standalone card on the board (not deleted). (This also confirms the payload-parity assumption in the Edge-Case audit.)
3. Re-open a subtask and click **Delete**. **Expect:** the plan file is unlinked and the row is gone from the board (destructive).
4. Confirm the Features-tab sidebar accordion rows show **no** inline Remove links anymore — links only.
5. Confirm no console errors and that `feature-remove-subtask-btn` no longer appears in `src/webview/project.js` or `src/webview/project.html` (it will still appear in `planning.js` — that is correct and expected).
6. **Regression check:** open the **sidebar panel** feature view and confirm its **Remove** button still renders and still detaches subtasks (proves Step 4 did not spill into `planning.js`).

## Recommendation

Complexity **3** (routine single-file UI consolidation with one cross-webview footgun to avoid) → **Send to Intern**.
