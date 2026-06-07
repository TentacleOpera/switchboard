# Rename Airlock output folder to NotebookLM and remove all Airlock toasts

## Goal
1. Consolidate the workspace bundle output folder from the current split state (`.switchboard/airlock` scaffolds but stays empty, `.switchboard/integration` receives actual files) into a single folder: `.switchboard/NotebookLM`.
2. Remove all `_showTemporaryNotification` calls in the Airlock/NotebookLM flow so no toasts appear on commits or manual actions.

### Problem & Root Cause
- `ContextBundler.ts` writes bundles to `.switchboard/integration`.
- `TaskViewerProvider._handleAirlockExport()` creates `.switchboard/airlock` but then uses the `outputDir` returned by `bundleWorkspaceContext()`, which is actually `.switchboard/integration`. The `airlock` folder remains empty and the notification text `.switchboard/airlock/` is misleading.
- `PlanningPanelProvider._handleAirlockExport()` also references `.switchboard/integration` and its `airlock_openFolder` handler opens `.switchboard/integration` — both must be updated for the rename to be consistent across both panels.
- On every git commit, the watcher calls `_handleAirlockExport()` and the notification flashes even though the comment says "Silently re-export on commit."
- The user explicitly instructed these toasts to be gone and the folder renamed to `NotebookLM`.

## Metadata
- **Tags:** backend, bugfix, refactor
- **Complexity:** 3

## User Review Required
- Confirm whether the two `showWarningMessage` calls in `_handleAirlockOpenFolder()` (lines 17592, 17597) should also have their "Airlock:" prefix updated to "NotebookLM:" for consistency, or left as-is.
- Confirm whether internal message type identifiers (e.g. `airlock_export`, `airlock_coderSent`) and webview element IDs (e.g. `btn-open-airlock-folder`) should be renamed in a follow-up plan or left as internal plumbing.

## Complexity Audit

### Routine
- Rename `.switchboard/integration` → `.switchboard/NotebookLM` in `ContextBundler.ts` (path string + git filter)
- Rename `.switchboard/airlock` → `.switchboard/NotebookLM` in `TaskViewerProvider.ts` (3 path references)
- Rename `.switchboard/integration` → `.switchboard/NotebookLM` in `PlanningPanelProvider.ts` (2 path references)
- Delete 3 `_showTemporaryNotification` calls in `TaskViewerProvider.ts`
- Update 2 `showWarningMessage` prefix strings from "Airlock:" → "NotebookLM:"

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None — the rename is a static string replacement; no concurrent access patterns change.
- **Security:** No impact — folder path rename does not affect access control or secret handling.
- **Side Effects:** Old `.switchboard/integration/` and `.switchboard/airlock/` directories will remain on disk if they already exist. The user confirmed no migration concerns. The git-exclusion filter in `ContextBundler.ts` will correctly exclude the new `.switchboard/NotebookLM/` path, preventing recursive bundling.
- **Dependencies & Conflicts:** `.gitignore` already has `.switchboard/*` blanket rule, so the new `NotebookLM/` folder is automatically excluded from version control. No `.gitignore` change needed. The non-git fallback in `ContextBundler.ts` uses `EXCLUDED_DIRS` which includes `.switchboard` — also covers the new path.

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) `PlanningPanelProvider.ts` was missing from the original plan — its two `.switchboard/integration` path references would break the Planning panel's "Bundle Code" and "Open Folder" buttons if not updated alongside the other files. (2) Two `showWarningMessage` calls still say "Airlock:" and will be inconsistent with the renamed folder. Mitigations: both gaps are now explicitly covered in the Proposed Changes below.

## Proposed Changes

### `src/services/ContextBundler.ts`
- **Line 65**: Change `path.join(workspaceRoot, '.switchboard', 'integration')` → `path.join(workspaceRoot, '.switchboard', 'NotebookLM')`.
- **Line 79**: Update comment from `.switchboard/integration` → `.switchboard/NotebookLM`.
- **Lines 89–91**: Update the `git ls-files` filter to exclude `.switchboard/NotebookLM/` instead of `.switchboard/integration/`. Specifically, change `!normalized.startsWith('.switchboard/integration/') && normalized !== '.switchboard/integration'` → `!normalized.startsWith('.switchboard/NotebookLM/') && normalized !== '.switchboard/NotebookLM'`.

### `src/services/TaskViewerProvider.ts`
- **Line 17407**: Change `path.join(workspaceRoot, '.switchboard', 'airlock')` → `path.join(workspaceRoot, '.switchboard', 'NotebookLM')`.
- **Line 17410**: Update the inline comment to reference `.switchboard/NotebookLM/`.
- **Line 17446**: Delete `this._showTemporaryNotification('Airlock: Bundle exported → .switchboard/airlock/');`.
- **Line 17498**: Change `path.join(workspaceRoot, '.switchboard', 'airlock')` → `path.join(workspaceRoot, '.switchboard', 'NotebookLM')`.
- **Line 17522**: Delete `this._showTemporaryNotification(\`Airlock: Patch dispatched to ${targetAgent}\`);`.
- **Line 17534**: Delete `this._showTemporaryNotification('Airlock: Repository synced to cloud successfully.');`.
- **Line 17592**: Change `'Airlock: No workspace open.'` → `'NotebookLM: No workspace open.'`.
- **Line 17595**: Change `path.join(workspaceRoot, '.switchboard', 'airlock')` → `path.join(workspaceRoot, '.switchboard', 'NotebookLM')`.
- **Line 17597**: Change `'Airlock: Folder does not exist yet. Click BUNDLE CODE first.'` → `'NotebookLM: Folder does not exist yet. Click BUNDLE CODE first.'`.

### `src/services/PlanningPanelProvider.ts`
- **Line 4270**: Change `path.join(workspaceRoot, '.switchboard', 'integration')` → `path.join(workspaceRoot, '.switchboard', 'NotebookLM')`.
- **Line 1430**: Change `path.join(workspaceRoot, '.switchboard', 'integration')` → `path.join(workspaceRoot, '.switchboard', 'NotebookLM')`.

## Verification Plan
1. Trigger a manual "Bundle Code" from the sidebar → confirm `.switchboard/NotebookLM/` is created with bundle files, no toast appears.
2. Make a git commit → confirm no "Bundle exported" notification flashes.
3. Use "Send to Coder" → confirm patch lands in `.switchboard/NotebookLM/`, no "Patch dispatched" toast.
4. Use "Open Folder" → confirm it opens `.switchboard/NotebookLM/`.
5. Confirm no `.switchboard/integration/` or `.switchboard/airlock/` directories are created.
6. Trigger "Bundle Code" from the Planning panel → confirm `.switchboard/NotebookLM/` is used (not `.switchboard/integration/`).
7. Use "Open Folder" from the Planning panel → confirm it opens `.switchboard/NotebookLM/`.

### Automated Tests
- (Skipped per session directive — test suite will be run separately by the user.)

## Files Changed
- `src/services/ContextBundler.ts`
- `src/services/TaskViewerProvider.ts`
- `src/services/PlanningPanelProvider.ts`

## Recommendation
**Send to Intern** — Complexity 3: all changes are localized string replacements and line deletions. No architectural changes, no new patterns, no state mutations beyond path strings.
