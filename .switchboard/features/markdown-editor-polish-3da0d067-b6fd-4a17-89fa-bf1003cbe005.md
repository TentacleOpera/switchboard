# Markdown Editor Polish

**Complexity:** 6

## Goal

Fix a cluster of UX and visual defects in the Switchboard markdown editor — a wrong toolbar icon, broken image rendering in live preview, a mismatched blue background, and a cramped internal scrollbar. These all stem from the same markdownEditor.js / live-preview code path and share a single capability theme: making the in-panel markdown editing experience look and behave correctly.

## How the Subtasks Achieve This

- **Fix Table Icon Shows Calendar Emoji**: Replaces the calendar emoji on the Insert Table toolbar button with a grid icon (`⊞`), correcting a copy-paste icon error in `markdownEditor.js`.
- **Fix Image Attachments Not Showing in Edit Preview**: Calls `_rewriteLocalImagePaths` before `markdown.api.render` in the `renderMarkdownLive` handler so attached images resolve to webview URIs and render in the live preview pane.
- **Fix Blue Background on Markdown Editor Panel**: Replaces undefined CSS variables (falling back to GitHub's blue-black `#0d1117`) with existing theme variables (`--panel-bg`, `--panel-bg2`) so the editor shell, toolbar, and preview match the panel's black theme.
- **Fix Markdown Editor Internal Scrollbar**: Changes `md-editor-shell` from `height: 100%` to `min-height: 480px; flex: 1` and ensures `#tickets-detail-content` has proper overflow, eliminating the tiny internal scrollbar.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Plan: Fix Markdown Editor Internal Scrollbar](../plans/feature_plan_20260716_fix_markdown_editor_internal_scrollbar.md) — **CODER CODED**
- [ ] [Plan: Fix Blue Background on Markdown Editor Panel](../plans/feature_plan_20260716_fix_blue_background_on_markdown_editor.md) — **CODER CODED**
- [ ] [Plan: Fix Image Attachments Not Showing in Edit Preview](../plans/feature_plan_20260716_fix_image_attachments_not_showing_in_edit_preview.md) — **CODER CODED**
- [ ] [Plan: Fix Table Icon Shows Calendar Emoji](../plans/feature_plan_20260716_fix_table_icon_shows_calendar.md) — **CODER CODED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

The CSS background fix and scrollbar fix both touch `markdownEditor.js` styling and should be landed together to avoid conflicting stylesheet edits. The image-preview fix touches `PlanningPanelProvider.ts` + the webview message contract and is independent. The icon fix is fully independent. No hard ordering constraints otherwise; subtasks can largely be executed in parallel with care around the shared `markdownEditor.js` stylesheet.
