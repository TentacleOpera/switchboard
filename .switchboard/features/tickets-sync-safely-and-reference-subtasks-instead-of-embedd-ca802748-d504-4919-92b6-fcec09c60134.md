# Tickets Sync Safely and Reference Subtasks Instead of Embedding Them

**Complexity:** 6

## Goal

Make the tickets auto-sync engine safe to leave switched on, and stop parent tickets duplicating content that already lives in subtask files. Suppress the delta-pull timer while unsaved edits are open in the editor and make autopush-on-save reliable; replace embedded subtask descriptions with file references the way code imports modules rather than pasting them; and unstick the parent card frozen on a Checking badge in the drill-down sidebar.

## How the Subtasks Achieve This

- **Safe auto-sync: suppress delta-pull during edit mode, reliable autopush on save** — suppresses the periodic delta-pull while unsaved edits are open in the webview editor, and makes autopush-on-save reliable, so auto-sync is safe to leave switched on.
- **Replace embedded subtask content with file references in parent ticket docs** — the parent references subtask files by name rather than inlining their descriptions, so content is not duplicated across two files that then drift.
- **Fix parent ticket card stuck on Checking sync status in subtasks sidebar** — resolves the parent card's sync badge in drill-down mode instead of leaving it permanently mid-check.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Replace embedded subtask content with file references in parent ticket docs](../plans/feature_plan_20260818103104_subtask-file-references-not-embedded-content.md) — **PLAN REVIEWED**
- [ ] [Fix Parent Ticket Card Stuck on 'Checking' Sync Status in Subtasks Sidebar](../plans/feature_plan_20260818103943_fix_parent_ticket_checking_status_subtasks_sidebar.md) — **PLAN REVIEWED**
- [ ] [Safe Auto-Sync: Suppress Delta-Pull During Edit Mode, Reliable Autopush on Save](../plans/feature_plan_20260818151304_safe-autosync-suppress-delta-pull-during-edit-mode.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->
## Dependencies & sequencing

Auto-sync safety lands first: it is the subtask that currently costs users work. The other two are independent of it and of each other.

