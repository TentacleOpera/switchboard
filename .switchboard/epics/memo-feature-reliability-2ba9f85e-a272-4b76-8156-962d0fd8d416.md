---
description: 'Memo Feature Reliability'
---

# Memo Feature Reliability

## Goal

Fix two reliability bugs in the Memo capture feature: memo content targets the wrong `.switchboard` directory in multi-parent workspaces, and zombie memo content persists in the Implementation panel after the memo has been processed and cleared. Together these make the Memo feature unreliable — users lose captured entries to the wrong workspace and see stale content that should have been purged.

## How the Subtasks Achieve This

- **Bug: Memo Targets Wrong .switchboard Directory in Multi-Parent Workspaces**: When a workspace has multiple parent folders (multi-root workspace), the Memo capture mode writes to the wrong `.switchboard/` directory — it picks the first workspace folder instead of the active one. Root cause is the workspace root resolution using `workspace.workspaceFolders[0]` instead of the active editor's containing folder. This plan fixes the resolution to use the same workspace detection decision tree as plan creation (active editor → containing workspace folder → `.switchboard/` path).

- **Fix Zombie Memo Content Persisting in the Implementation Panel**: After a memo is processed (`process memo`), the memo entries are converted to plan files and the memo file is cleared. However, the Implementation panel's Memo sub-tab continues to show the old memo content — the webview's cached state isn't invalidated when the memo file is cleared. This plan adds a cache invalidation hook that fires when the memo file is cleared, forcing the Memo sub-tab to re-read from disk and show an empty state.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Bug: Memo Targets Wrong .switchboard Directory in Multi-Parent Workspaces](../plans/feature_plan_20260626100858_memo_wrong_switchboard_directory.md) — **PLAN REVIEWED**
- [ ] [Fix Zombie Memo Content Persisting in the Implementation Panel](../plans/feature_plan_20260626124049_memo_zombie_cache_implementation_panel.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->
