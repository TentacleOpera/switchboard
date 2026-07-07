# Fix: Subtask Edit Button Hidden When Subtask Opened via In-Preview Link Click

**Plan ID:** 91229069-3594-46e2-9629-2865d5cfda54

## Goal
Improve layout usability and fix a regression in the Features tab of the project webview where the Edit button permanently disappears when a subtask is opened via an in-preview markdown link click.

### Problem
When a user clicks a subtask link **inside the previewed feature/subtask markdown** (the `../plans/foo.md` relative links rendered in the Features tab preview pane), the **Edit button disappears** and cannot be brought back. The user is stuck — they can read the subtask but cannot edit it. Selecting the same subtask from the feature's subtask list (the sidebar list) works fine and shows the Edit button.

This is a regression: subtask editing was added to `renderFeatureSubtaskMetaBar` (which correctly wires the Edit/Save/Cancel buttons to save `_featurePreviewFilePath` — the subtask file), but the older subtask-link click handler was never updated. It still runs stale code that manually hides the Edit button and never calls `renderFeatureSubtaskMetaBar` to set up the subtask meta bar.

### Background Context
The Features tab in `project.html`/`project.js` has two ways to preview a subtask:

1. **Path A — Subtask list click** (`project.js` ~line 2527-2539): Clicking a subtask in the feature's subtask list. This path sets `_featureSubtaskPreview`, calls `renderFeatureSubtaskMetaBar(_featureSubtaskPreview)` (which re-renders the meta bar with the Edit button visible and wired to save the subtask file), then fetches the preview. **Works correctly.**

2. **Path B — In-preview link click** (`project.js` ~line 280-314): Clicking a `../plans/foo.md` relative link rendered inside the previewed markdown. This path sets `_featurePreviewFilePath`, fetches the preview, then **manually hides the Edit button** (`btnEdit.style.display = 'none'`). It does NOT set `_featureSubtaskPreview` and does NOT call `renderFeatureSubtaskMetaBar`. **Broken — Edit button stays hidden.**

When the preview content arrives back (`kanbanPlanPreviewReady` handler, `project.js` ~line 617-626), it only un-**disables** the Edit button (`dynamicEditFeaturesBtn.disabled = false`) — it does not un-**hide** it. So the `display: none` set by Path B persists, and the Edit button is permanently invisible for that subtask until the user selects a different feature/subtask from the list.

### Root Cause
Commit `0a63d67` ("Phase 2: Rename all internal epic identifiers to feature") rewired `renderFeatureSubtaskMetaBar`'s Edit/Save/Cancel buttons to target `_featurePreviewFilePath` (the subtask file) instead of the feature file — enabling subtask editing via Path A. However, the Path B link-click handler (lines 311-313) still contains the pre-editing-era code that hides the Edit button, and it was never updated to call `renderFeatureSubtaskMetaBar`. The two paths diverged, leaving Path B unable to edit.

## Metadata
- **Tags:** bugfix, frontend, ui
- **Complexity:** 3

## User Review Required
Yes — this is a visible behavior change in the Features tab. Confirm before coding:
- Clicking a `../plans/foo.md` link inside the previewed feature markdown should now show the **Subtask** meta bar (with a visible Edit button), matching the behavior of clicking the same subtask from the sidebar subtask list (Path A).
- The previously-permanently-hidden Edit button is the intended fix (not a new bug where Edit shows on a subtask that "shouldn't" be editable).
- For uncached subtasks (not yet in `_kanbanPlansCache`), the Remove/Delete/Complexity controls are intentionally omitted (only Edit/Save/Cancel render) — identical to Path A's existing behavior for uncached plans.

## Complexity Audit

### Routine
- Single-file change (`src/webview/project.js`), single handler (the in-preview link-click handler, ~lines 303-313).
- The correct behavior already exists in Path A (`renderFeatureSubtaskMetaBar`, ~line 2530-2532); Path B simply needs to call the same function instead of manually hiding the Edit button.
- No new abstractions, no backend changes, no data migrations, no new message types.
- Reuses the existing `_featureSubtaskPreview` fallback object pattern (`|| { planFile, planId: '', workspaceRoot: '', complexity: 'Unknown' }`) already used by Path A at line 2531.
- Variables `_featureSubtaskPreview` (declared line 177) and `_kanbanPlansCache` (declared line 167) are module-level `let` bindings — accessible from the link-click handler closure without scope changes.

### Complex / Risky
- None.

## Edge-Case & Dependency Audit
- **Race Conditions:** None new. `renderFeatureSubtaskMetaBar` is called synchronously before `fetchKanbanPlanPreview` is dispatched, so the meta bar (Edit visible) renders immediately while the preview loads async; `kanbanPlanPreviewReady` (line 617-626) then un-disables the Edit button. This ordering is identical to Path A (line 2532 renders, line 2534 fetches) — any pre-existing "Edit enabled before content loads" characteristic is **inherited from Path A**, not introduced by this fix. Out of scope to refactor here; this plan's mandate is parity with the working path.
- **Security:** No new input handling, no eval, no message types added. The `resolvedPath` is already computed and validated (must end in `.md`, not an external URL) before reaching the patched lines. No impact.
- **Side Effects:**
  - Removing the stale `btnEdit.style.display = 'none'` (lines 311-313) is the sole hiding site for `btn-edit-features` — verified by grep: only 6 references to `btn-edit-features` in project.js (lines 312, 623, 2311, 2352, 2412, 2421), and line 312 is the only one that sets `display = 'none'`. The feature-level `renderFeatureMetaBar` (line 2311) and subtask-level `renderFeatureSubtaskMetaBar` (line 2412) both render the button via `state.editMode.features ? 'display:none;' : ''` (visible when not editing) — so after the fix the button is visible, not hidden.
  - **Latent repair (rename handling):** Setting `_featureSubtaskPreview` in Path B also activates the rename handler at lines 1041-1052 (`if (_featureSubtaskPreview)`), which previously was a silent no-op for Path-B-opened subtasks. After the fix, a renamed subtask opened via Path B correctly updates `_featurePreviewFilePath` and `_featureSubtaskPreview.planFile` and re-fetches/re-renders — matching Path A. For a cached subtask, `_featureSubtaskPreview` is a live reference into `_kanbanPlansCache` (`.find()` returns the array element), so mutating `.planFile` updates the cache entry; this is identical to Path A's behavior and is correct.
- **Side Effects (uncached subtask UX):** For a subtask not in `_kanbanPlansCache`, the fallback object has `planId: ''` so `hasPlanId` is false — Remove/Delete/Complexity are omitted, but Edit/Save/Cancel remain. Save works because it reads `_featurePreviewFilePath` (set at line 304), not the plan object. This is identical to Path A's behavior for uncached plans: you cannot Detach/Delete what isn't tracked, but you can edit the file directly.
- **Returning to the feature after viewing a subtask:** Clicking the feature in the sidebar calls `selectFeature()` (line 2275) which sets `_featureSubtaskPreview = null` (line 2279) and calls `renderFeatureMetaBar(plan)` (line 2281) — fully resetting state. No leak.
- **Dependencies & Conflicts:** No dependency on other plans or features. Self-contained fix. Note: the sibling plan "Reorganize Edit and Delete Layouts in Project Webview" restructures `renderFeatureMetaBar` (the *feature-level* meta bar, line ~2295-2315) and explicitly leaves `renderFeatureSubtaskMetaBar` (the *subtask* meta bar, line 2376+) untouched — so the two plans modify different functions in the same file with no logical overlap (only a potential textual merge conflict if coded in parallel, resolved by sequential application).

## Dependencies
- None.

## Adversarial Synthesis
Key risks: (1) the fix achieves parity with the working Path A but inherits Path A's pre-existing "Edit enabled before preview content loads" ordering — out of scope to refactor here, noted as a known condition; (2) setting `_featureSubtaskPreview` in Path B silently activates the rename handler (lines 1041-1052), a latent repair rather than a regression, but one the plan must document so reviewers aren't surprised; (3) tags and Plan ID were missing per workflow requirements. Mitigations: core fix verified against actual lines 303-313 / 617-626 / 2376-2441; grep proof added that line 312 is the sole `display:none` site; tags corrected to the allowed set; Plan ID embedded for feature linking.

## Proposed Changes

### `src/webview/project.js` — Subtask link-click handler (~lines 303-313)

Replace the manual Edit-button hiding with a call to `renderFeatureSubtaskMetaBar`, mirroring Path A (lines 2530-2532).

**Before:**
```js
            if (state.editMode.features) exitEditMode('features');
            _featurePreviewFilePath = resolvedPath;
            featuresPreviewContent.innerHTML = '<div class="kanban-empty-state">Loading preview...</div>';
            vscode.postMessage({
                type: 'fetchKanbanPlanPreview',
                filePath: resolvedPath,
                requestId: ++_kanbanPreviewRequestId
            });
            // Hide the Edit button while a subtask is previewed (not the feature itself).
            const btnEdit = document.getElementById('btn-edit-features');
            if (btnEdit) btnEdit.style.display = 'none';
```

**After:**
```js
            if (state.editMode.features) exitEditMode('features');
            _featurePreviewFilePath = resolvedPath;
            // Mirror the subtask-list click path (project.js ~line 2530-2532): set the
            // subtask preview object and render the subtask meta bar so the Edit button
            // is visible and wired to save _featurePreviewFilePath (the subtask file).
            _featureSubtaskPreview = _kanbanPlansCache.find(p => p.planFile === resolvedPath) || { planFile: resolvedPath, planId: '', workspaceRoot: '', complexity: 'Unknown' };
            renderFeatureSubtaskMetaBar(_featureSubtaskPreview);
            featuresPreviewContent.innerHTML = '<div class="kanban-empty-state">Loading preview...</div>';
            vscode.postMessage({
                type: 'fetchKanbanPlanPreview',
                filePath: resolvedPath,
                requestId: ++_kanbanPreviewRequestId
            });
```

**What this changes:**
1. Removes the stale `btnEdit.style.display = 'none'` line that permanently hid the Edit button.
2. Sets `_featureSubtaskPreview` so the meta bar reflects the subtask (not the feature) — enabling correct Remove/Delete/Complexity buttons when the plan is cached.
3. Calls `renderFeatureSubtaskMetaBar(_featureSubtaskPreview)` which re-renders the meta bar with the Edit button visible (when not in edit mode) and wired to save `_featurePreviewFilePath` (the subtask file) — identical to Path A.

No other files need changes. The `kanbanPlanPreviewReady` handler (line 617-626) already un-disables the Edit button; combined with the button now being visible (not `display: none`), editing will work end-to-end.

## Verification Plan

### Automated Tests
None — per session directive, no automated tests are run and no project compilation is run. (Per `CLAUDE.md`, `dist/` is a release-only artifact and is not the source of truth for testing; `src/` is served directly in dev.) Verification is by manual UI inspection in the installed VSIX webview.

### Manual UI Checks
1. Open a feature in the Features tab that has at least one subtask.
2. Confirm the Edit button is visible for the feature itself.
3. Click a `../plans/foo.md` link **inside the previewed feature markdown** (Path B).
4. **Verify:** The subtask preview loads AND the **Edit button is visible** in the meta bar (labeled "Subtask").
5. Click Edit → confirm the editor opens with the subtask's raw markdown content.
6. Make a change → Save → confirm the subtask file is updated (re-preview shows the change).
7. Click Cancel (without changes) → confirm it exits edit mode and the Edit button reappears.
8. Select the same subtask from the **subtask list** (Path A) → confirm identical behavior (Edit button visible, editing works).
9. Click a different subtask link from within the first subtask's preview → confirm the Edit button remains visible for the new subtask (no stuck hidden state).
10. **Regression check — Remove/Delete buttons:** For a cached subtask opened via Path B, confirm the Remove and Delete buttons appear and function (they depend on `_featureSubtaskPreview.planId` being set from the cache lookup).
11. **Regression check — return to feature:** After viewing a subtask via Path B, click the feature in the sidebar → confirm the feature preview and feature meta bar (with Edit button) restore correctly (`_featureSubtaskPreview` resets to null via `selectFeature`).

## Recommendation
Complexity 3 → **Send to Intern**. Single-file, single-handler fix that mirrors an existing working code path (Path A). The implementer should apply the "After" block verbatim at lines 303-313 and perform no other edits — the rename-handler side-effect (lines 1041-1052) activates automatically and is correct, requiring no additional code.

**Stage Complete:** PLAN REVIEWED
**Stage Complete:** INTERN CODED

## Review Findings
Reviewed `src/webview/project.js` (in-preview link-click handler, lines 302-314) against plan requirements. The stale `btnEdit.style.display = 'none'` was removed and replaced with `_featureSubtaskPreview` assignment + `renderFeatureSubtaskMetaBar(_featureSubtaskPreview)` call (lines 307-308), faithfully mirroring Path A (lines 2538-2539). End-to-end trace confirmed: `renderFeatureSubtaskMetaBar` renders the Edit button visible (when not editing) and wired to save `_featurePreviewFilePath` (the subtask file, line 2435); `kanbanPlanPreviewReady` (line 622-623) then un-disables it. Grep confirmed line 312 was the sole `display:none` site for `btn-edit-features`. The rename handler (lines 1041-1052) now correctly activates for Path-B subtasks (latent repair, documented in plan). Uncached-subtask fallback behavior matches Path A. No material findings — no fixes needed. No compilation/tests run per directive. Remaining risk: inherited "Edit enabled before preview loads" ordering is a pre-existing Path A characteristic, explicitly out of scope.

**Stage Complete:** CODE REVIEWED
