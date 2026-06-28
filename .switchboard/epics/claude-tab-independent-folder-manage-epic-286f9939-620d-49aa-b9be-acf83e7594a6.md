---
description: 'Claude Tab: Independent Folder Manage... Epic'
---

# Claude Tab: Independent Folder Manage... Epic

Improvements to the Claude tab of design.html

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Claude Tab: Independent Folder Management (Not Shared with HTML Previews)](../plans/feature_plan_20260625104014_claude-tab-independent-folder-management.md)
- [ ] [Move Claude Tab to Second Position (After Stitch)](../plans/feature_plan_20260625104015_claude-tab-move-to-second-position.md)
- [ ] [Separate Images and HTML in Claude Tab with Subheaders](../plans/feature_plan_20260625104016_claude-tab-separate-images-html-subheaders.md)
- [ ] [Remove Invented "Repo Folders & Files" Subheader from Claude Tab](../plans/feature_plan_20260625104017_claude-tab-remove-repo-folders-files-subheader.md)
- [ ] [Remove Confusing "Target" and "Active Terminal" from Claude Tab Function Bar](../plans/feature_plan_20260625104018_claude-tab-remove-target-active-terminal-function-bar.md)
<!-- END SUBTASKS -->

## Implementation Status — Implemented 2026-06-25 (Epic Orchestrator)

All 5 subtasks code-complete in a single coupled change (4 files: `src/webview/design.html`, `src/webview/design.js`, `src/services/LocalFolderService.ts`, `src/services/DesignPanelProvider.ts`). Executed sequentially in one context (not parallel worktrees) because every subtask edits overlapping regions of the same files and several conflict by design — see each subtask plan's own "Implementation Status" section for details and evidence.

- **Static verification:** `node --check src/webview/design.js` → OK; `tsc --noEmit` → no errors in any edited file (2 pre-existing errors are in untouched files).
- **Subtask plan files** updated with per-plan acceptance criteria + evidence.
- **Not done by orchestrator:** git commit (per GIT POLICY) and runtime/visual verification (requires launching the VSIX). Subtask-checkbox state above is left to the system (auto-generated block).

> NOTE: the `## Subtasks` block above is auto-generated and was intentionally left unedited; subtask completion is tracked by the host/kanban, not by hand-editing the checkboxes.

## Reviewer Pass — 2026-06-25 (In-place Reviewer-Executor)

**Verdict: APPROVED. No code fixes required.**

### Stage 1 (Grumpy) — Adversarial Findings
- **CRITICAL:** None. All three CRITICAL gates verified correct in source.
- **MAJOR:** None. Migration idempotent, watchers mirrored, poll integrated, tab restore wired.
- **NIT-1 (consistency, non-blocking):** `design.js` L2808 `claudeDocsReady` uses block scope; sibling `htmlDocsReady` (L2793) does not despite `const` decl. Claude case is the safer pattern. Pre-existing inconsistency, not a regression.
- **NIT-2 (naming, pre-existing):** `DesignPanelProvider.ts` L456 comment references `_autoRefreshHtmlPreview` handling Claude — function name is misleading but pre-existing. Defer rename.
- **NIT-3 (future-proofing, non-blocking):** `LocalFolderService.ts` L133 `saveFolderPathsConfig` destructure strips `_migrated*` keys but not `_migratedClaude`. No such key is ever set (key-absence detection used instead). Defensive-only.

### Stage 2 (Balanced) — Synthesis
- **Keep as-is:** All 5 subtasks correctly implemented. No material defects.
- **Fix now:** Nothing — no CRITICAL/MAJOR findings.
- **Defer:** NIT-1 (block scope on htmlDocsReady), NIT-2 (rename _autoRefreshHtmlPreview), NIT-3 (add _migratedClaude to strip list). All optional, non-blocking.

### Verification Results
- `node --check src/webview/design.js` → EXIT 0 (syntax OK).
- Grep `src/` for `"Repo Folders"` → 0 matches.
- Grep `src/` for `sendClaudeImportPrompt` → 0 matches.
- Grep `src/` for `updateClaudeTargetFolderStatus` → 0 matches.
- Grep `src/` for `btn-send-claude-prompt` / `claude-target-folder` → 0 matches.
- Tab order: STITCH, CLAUDE, BRIEFS, HTML PREVIEWS, IMAGES, DESIGN SYSTEM (`design.html` L3626-3631).
- `validTabs` includes `'claude'` (`design.js` L2658).
- CRITICAL gate 1: `fetchPreview` accepts `'claude-folder'` (`DesignPanelProvider.ts` L1570).
- CRITICAL gate 2: allowed-folders whitelist includes `getClaudeFolderPaths()` (L3061); error string updated (L3068).
- CRITICAL gate 3: `htmlDocsReady`/`claudeDocsReady` fully decoupled (L2793-2822).
- Migration idempotent via `loadFolderPathsConfigRaw()` key-absence (L606-618).
- Compilation (tsc) and automated tests skipped per session directives.

### Files Reviewed (no changes made)
- `src/webview/design.js` — state, modal branches, message handlers, renderClaudeDocs, loadClaudePreview, switchTab, validTabs, panel restore.
- `src/webview/design.html` — tab order, controls strip.
- `src/services/LocalFolderService.ts` — config interface, defaults/merges, claude folder methods, loadFolderPathsConfigRaw.
- `src/services/DesignPanelProvider.ts` — watchers, _sendClaudeDocsReady, migration, fetchPreview gate, allowed-folders, refreshDocsForTab, poll integration, activeTabChanged, disposeWatchers.

### Remaining Risks
- **Runtime/visual verification pending** (requires launching the VSIX): folder independence between Claude/HTML tabs, preview load via new sourceId gate, watcher auto-refresh, one-time migration behavior, subheader rendering, controls strip layout.
- **NIT-1/2/3** are optional polish items that do not affect correctness.
