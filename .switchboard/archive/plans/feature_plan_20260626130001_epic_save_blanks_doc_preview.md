# Fix: Saving an Epic File in the Project Panel Blanks the Doc Preview

## Goal

When the user edits and saves an epic file in the Project panel (`project.html` → Epics tab), the doc preview pane goes blank instead of re-rendering the saved content.

### Problem analysis & root cause

The save flow for an epic posts `saveFileContent` with `{ filePath, content, originalContent, tab: 'epics' }`. The provider's `saveFileContent` handler in `PlanningPanelProvider.ts` writes the file and then runs a **rename-on-save** block that fires for `tab === 'kanban' || tab === 'epics'` (`src/services/PlanningPanelProvider.ts:3633`).

That rename block was designed for kanban plan files named `feature_plan_<YYYYMMDD>_<HHMMSS>_<underscore_slug>.md`. It derives the slug the file "should" have from the H1 title (lower-cased, non-alphanumerics → `_`) and renames the file if that slug differs from the current one:

```ts
// PlanningPanelProvider.ts:3640-3652
const newSlug = h1Title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'new_plan';
const currentBasename = path.basename(resolved);
const currentSlug = currentBasename.replace(/^feature_plan_\d{8}_\d{6}_/, '').replace(/\.md$/, '');
if (newSlug !== currentSlug) {
    const timestamp = currentBasename.match(/^feature_plan_(\d{8}_\d{6})_/)?.[1] || '';
    const newBasename = `feature_plan_${timestamp}_${newSlug}.md`;
    ...
    await fs.promises.rename(resolved, newPath);
```

**Epic files are named with hyphen slugs** — `createEpic` writes them to `.switchboard/epics/<slug>.md` where `slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-')…` (`PlanningPanelProvider.ts:2985`, `:3006`). So for any epic:

- `newSlug` = `online_docs_inline_editing` (underscores, from the H1)
- `currentSlug` = `online-docs-inline-editing` (hyphens — there's no `feature_plan_<TS>_` prefix to strip)
- They always differ → the rename **fires on every epic save**, and because there is no timestamp to capture, the file is renamed to `feature_plan__<slug>.md` (note the double underscore from the empty `${timestamp}`).

Consequences:
1. The on-disk path no longer matches what the webview has selected (`_epicPreviewFilePath`), and for **standalone epic documents** (`isEpicDocument: true`, absolute `planFile`) there is no kanban DB record, so the DB row update at `:3662-3665` is skipped and the list keeps the now-deleted path.
2. After save, the epics branch of the result handler only re-issues `fetchKanbanPlans` (project.js), never `fetchEpicDocuments`, so standalone epic docs keep the stale path.
3. Any subsequent preview fetch for the old path returns `error: 'File not found'` with `content: ''` (`_handleFetchKanbanPlanPreview`, `PlanningPanelProvider.ts:1222-1226`), and the webview's `kanbanPlanPreviewReady` epics branch writes `epicsPreviewContent.innerHTML = msg.content || ''` → **blank pane** (project.js).

Evidence: a corrupted artifact from this bug already exists on disk — `.switchboard/epics/feature_plan__random_plans_to_test_epic_feature.md` (empty-timestamp double underscore).

The fix is to **stop renaming epic files on save** (epics are not the timestamp-named plan files the rename targets), plus two defensive hardenings on the webview side so a path desync can never blank the pane.

## Metadata

- **Tags:** bugfix, ui, backend
- **Complexity:** 4 / 10
- **Primary files:** `src/services/PlanningPanelProvider.ts`, `src/webview/project.js`
- **Affected feature area:** Project panel → Epics tab (doc editing/preview)

## User Review Required

Yes — the fix touches the shared rename-on-save code path used by both kanban and epics tabs. The user should confirm that the `isTimestampedPlan` guard does not regress kanban plan rename behavior for their workflow before implementation proceeds.

## Complexity Audit

### Routine
- Adding a regex guard (`isTimestampedPlan`) to an existing conditional — single-line logic change in `PlanningPanelProvider.ts`.
- Adding one `postMessage` call (`fetchEpicDocuments`) to an existing handler branch in `project.js`.
- Adding a defensive `!msg.error` guard to an existing `innerHTML` assignment in `project.js`.
- No schema changes, no new message types, no new dependencies.

### Complex / Risky
- The rename guard shares a code path with genuine kanban plan renames. The regex `/^feature_plan_\d{8}_\d{6}_/` must correctly classify all existing file names — a false negative would silently break kanban rename, a false positive would reintroduce the epic bug. Verified against `createEpic` slug logic (hyphens, no timestamp prefix) and kanban plan naming (timestamp prefix, underscores).

## Edge-Case & Dependency Audit

- **Race Conditions:** After save, the epics branch fires three async messages: `selectEpic` (→ `fetchKanbanPlanPreview`), `fetchKanbanPlans`, and the new `fetchEpicDocuments`. Responses arrive in unspecified order. `epicDocumentsReady` (project.js:436-439) calls `renderEpicsList()` which only reads `_epicSelectedPlan` for highlight styling (line 1496) and never clears it. No race — the selection and preview state are preserved across list re-renders. This invariant should be preserved during future refactors.
- **Security:** No new attack surface. The `isAllowed` path check in `_handleFetchKanbanPlanPreview` (line 1220) is unchanged. The rename guard does not alter path validation.
- **Side Effects:**
  - **Legacy hyphen-named kanban plans** (e.g. `add-complexity-scoring-to-agents.md`): these would suffer the same spurious rename. Gating the rename on the `feature_plan_<YYYYMMDD>_<HHMMSS>_` pattern protects them too — a strict improvement.
  - **Genuine kanban plan rename must still work:** files matching `feature_plan_\d{8}_\d{6}_<slug>.md` must continue to rename when their H1 changes. The guard preserves this — it only *adds* a precondition that the current basename already matches the timestamped pattern.
  - **DB-backed epics vs standalone epic docs:** DB-backed epics (`isEpic`, `kanbanColumn`) carry a relative `planFile`; standalone epic docs (`_epicDocumentsCache`) carry an absolute `planFile` and have no DB row. The webview hardening (re-fetch `fetchEpicDocuments` after save) covers both.
  - **Existing corrupted file** `feature_plan__random_plans_to_test_epic_feature.md`: this is pre-existing user data created by the bug. Do **not** auto-delete it (migration rule — never destroy user files). It will still render fine; the user can rename or delete it manually. Out of scope for the code fix.
  - **No confirmation dialogs** introduced (per project rule).
  - **`_lastPanelWriteTimestamp` watcher suppression** (`:3627`) is unaffected — the watcher was never the cause; we are not touching it.
- **Dependencies & Conflicts:**
  - **Known related risk (out of scope):** The kanban branch of `kanbanPlanPreviewReady` (project.js:374) has the same `kanbanPreviewContent.innerHTML = msg.content || ''` blanking pattern. However, kanban plans are DB-backed and their rename path updates the DB row (lines 3662-3665), so the path desync that causes the epic blanking does not occur for kanban plans. Applying the same `!msg.error` guard to the kanban branch would be a consistent hardening but is a distinct change outside this plan's goal.
  - No external library or API dependencies are introduced or changed.

## Dependencies

- None — this is a standalone bugfix with no prerequisite plans.

## Adversarial Synthesis

Key risks: (1) the defensive guard must use `!msg.error` alone, not `!msg.error && msg.content`, to avoid skipping legitimate empty-file renders; (2) the `isTimestampedPlan` regex shares a code path with kanban renames and must not regress that behavior. Mitigations: the regex is verified against both naming conventions (epic hyphen-slugs vs kanban timestamp-prefix), and the guard condition is refined to distinguish error from success solely via the `msg.error` flag, which is always set on the error path and undefined on the success path.

## Proposed Changes

### 1. `src/services/PlanningPanelProvider.ts` — gate the rename to timestamped plan files only

The rename block currently runs for both `kanban` and `epics` tabs. Restrict it so it only renames files that actually use the `feature_plan_<TS>_` naming convention. Epic files (hyphen slugs) and any non-conforming file are then left untouched.

Change the inner H1 guard so the rename is skipped unless the current basename matches the timestamped plan pattern:

```ts
// PlanningPanelProvider.ts ~3633-3646
if (tab === 'kanban' || tab === 'epics') {
    try {
        const currentBasename = path.basename(resolved);
        // Only auto-rename files that follow the feature_plan_<YYYYMMDD>_<HHMMSS>_<slug>.md
        // convention. Epic files use hyphen slugs (.switchboard/epics/<slug>.md) and legacy
        // hand-named plans do NOT round-trip through the slug logic — renaming them produces
        // a corrupt `feature_plan__<slug>.md` (empty timestamp) and desyncs the preview path.
        const isTimestampedPlan = /^feature_plan_\d{8}_\d{6}_/.test(currentBasename);
        const h1Match = content.match(/^#\s+(.+)$/m);
        const h1Title = h1Match ? h1Match[1].trim() : '';
        if (isTimestampedPlan && h1Title) {
            // ... existing slug derivation + rename, unchanged ...
        }
    } catch (renameErr) {
        renamedTo = undefined;
        console.error('[PlanningPanelProvider] Plan rename on save failed:', renameErr);
    }
}
```

> Implementation note: move the `const currentBasename = path.basename(resolved);` declaration up (it is currently computed inside the `if (h1Title)` block at `:3644`) and reuse it for the `isTimestampedPlan` test, then keep the existing slug/rename body inside the combined `if (isTimestampedPlan && h1Title)`.

This is the primary fix — epic saves will no longer rename the file, so the preview path stays valid.

### 2. `src/webview/project.js` — re-fetch epic documents after save (robustness)

In the `saveFileContentResult` handler's epics branch (currently re-issues only `fetchKanbanPlans`), also re-issue `fetchEpicDocuments` so standalone epic docs can never keep a stale path entry:

```js
} else if (msg.tab === 'epics') {
    exitEditMode('epics');
    if (msg.renamedFilePath && _epicSelectedPlan) { _epicSelectedPlan.planFile = msg.renamedFilePath; }
    if (_epicSelectedPlan) selectEpic(_epicSelectedPlan);
    vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });
    vscode.postMessage({ type: 'fetchEpicDocuments' }); // keep standalone epic-doc list in sync
}
```

### 3. `src/webview/project.js` — never blank the pane on a failed preview (defensive)

In the `kanbanPlanPreviewReady` handler's epics branch, only overwrite the preview content when the provider reports **no error**. On the success path (`PlanningPanelProvider.ts:1249-1256`), `msg.error` is undefined and `msg.content` is the rendered HTML (which may be `''` for an empty file — that is a legitimate render, not a failure). On the error path (lines 1222-1226, 1258-1260), `msg.error` is always set and `content` is `''`. Therefore the correct guard is `!msg.error` alone — NOT `!msg.error && msg.content`, which would incorrectly skip rendering for legitimately empty files:

```js
if (epicsPreviewContent && _epicPreviewFilePath && _epicPreviewFilePath === msg.filePath) {
    if (state.editMode.epics) {
        state.externalChangePending.epics = true;
    } else if (!msg.error) {
        epicsPreviewContent.innerHTML = msg.content || '';
        state.editOriginalContent.epics = msg.rawContent || '';
        const dynamicEditEpicsBtn = document.getElementById('btn-edit-epics');
        if (dynamicEditEpicsBtn) dynamicEditEpicsBtn.disabled = false;
    }
    // else: render failed (msg.error set) — keep what's on screen instead of blanking
}
```

> **Refinement from adversarial review:** The original plan proposed `!msg.error && msg.content`. This was corrected to `!msg.error` because `msg.content` can be a legitimate empty string for empty files — gating on `msg.content` would leave stale content on screen after saving an empty file. The `msg.error` flag is the reliable discriminator: it is always set on the error path and undefined on the success path.

## Verification Plan

### Automated Tests

No automated tests are run as part of this session (per session directive — the test suite will be run separately by the user). No project compilation step is run (per session directive — the project is assumed pre-compiled).

### Manual Verification

1. **Epic save no longer renames / blanks:**
   - Create an epic via the Epics tab "+ New Epic" (e.g. "Online Docs Inline Editing").
   - Select it, enter edit mode, change a line, save.
   - Confirm: the file on disk keeps its name `.switchboard/epics/online-docs-inline-editing.md` (no `feature_plan__…` appears), and the preview pane re-renders the saved markdown (not blank).
2. **Edit the H1 of an epic and save:** confirm the file name is still unchanged and the preview shows the new title.
3. **Genuine kanban plan rename still works (regression guard):** open a `feature_plan_<TS>_<slug>.md` plan in the Project panel's Kanban tab, change its H1, save, and confirm the file is renamed to the new slug (timestamp preserved) and the preview re-renders — i.e. the intended rename behaviour is intact.
4. **Standalone epic doc path sync:** create an epic without a DB record (legacy standalone doc), save, and confirm the list entry and preview both reference the correct (unchanged) path.
5. **Empty epic file renders correctly:** create an epic, delete all content, save, and confirm the preview shows an empty pane (not stale content from before the save).
6. **No leftover blanks:** repeatedly save the same epic several times; the preview must render every time.

## Recommendation

Complexity is 4/10 → **Send to Coder**.

---

## Review Pass — 2026-06-26

### Reviewer
In-place reviewer pass (Grumpy Principal Engineer → Balanced synthesis → verification).

### Files Changed (verified in commit `6c72aa4`)
- `src/services/PlanningPanelProvider.ts` — `isTimestampedPlan` regex guard at lines 3619-3660; `currentBasename` hoisted to top of try block; rename gated on `isTimestampedPlan && h1Title`.
- `src/webview/project.js` — `fetchEpicDocuments` postMessage added at line 790 (epics save branch); `!msg.error` guard added at line 387 (kanbanPlanPreviewReady epics branch).

### Findings

| # | Severity | Location | Description | Disposition |
|---|----------|----------|-------------|-------------|
| 1 | NIT | `project.js:387` | Silent error swallow on failed epic preview fetch — no `console.warn` when `msg.error` is set and not in edit mode | Defer — path unreachable after fix; add logging in future hardening |
| 2 | NIT | `project.js:374` | Kanban branch has same unguarded `innerHTML = msg.content || ''` blanking pattern | Defer — explicitly scoped out (line 74); DB-backed plans don't desync; consistent hardening for future |

**No CRITICAL findings. No MAJOR findings. No code fixes applied.**

### Verification Results
- **Regex validation**: Verified `/^feature_plan_\d{8}_\d{6}_/` against 146 `feature_plan_*` files and 5 epic files on disk. Correctly classifies all naming conventions (timestamped with `_\d{8}_\d{6}_` → rename; hyphen-slugs, `_\d{8}_` only, contiguous 14-digit → no rename).
- **Control flow trace**: Single `saveFileContent` handler (line 3534); conflict path breaks before rename block (line 3582); watcher suppression unchanged (line 3613); auto-refresh dedupe bypassed by incremented requestId.
- **Race condition audit**: `renderEpicsList()` (line 1473) reads `_epicSelectedPlan` for highlight only, never clears it. Three async post-save messages (`selectEpic`, `fetchKanbanPlans`, `fetchEpicDocuments`) have no ordering dependency.
- **Compilation**: Skipped per session directive.
- **Tests**: Skipped per session directive.

### Remaining Risks
1. **NIT-1 (deferred)**: If a future regression reintroduces epic preview fetch failures, the silent swallow will make debugging harder. Consider adding `console.warn('[epics] preview fetch failed:', msg.error)` in the `else` branch.
2. **NIT-2 (deferred)**: The kanban branch blanking pattern (line 374) remains unguarded. If a future change breaks the DB row update on kanban rename (lines 3653-3657), kanban previews could blank the same way. Applying `!msg.error` there would be consistent hardening.
3. **Pre-existing corrupted file**: `.switchboard/epics/feature_plan__random_plans_to_test_epic_feature.md` remains on disk (per migration rule — not auto-deleted). User can rename or delete manually.
