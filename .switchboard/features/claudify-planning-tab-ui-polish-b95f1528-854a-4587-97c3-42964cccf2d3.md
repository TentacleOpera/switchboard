# Claudify & Planning Tab UI Polish

**Complexity:** 4

## Goal

Two Claudify/planning-tab UI fixes surfaced during testing: (1) remove the pixel-font option and its GeistPixel H1 rendering from the Claudify theme entirely; (2) give the Dev Docs tab sidebar proper bordered .tree-node cards matching the other planning tabs.

## How the Subtasks Achieve This

- **Remove the Pixel-Font Option From the Claudify Theme**: Fully excises the Claudify pixel-font feature across all 16 files that reference it — the `switchboard.theme.pixelFont` setting, the first-paint body class, the `GeistPixel` H1 CSS + `claudify-pixel-font-disabled` overrides in three webviews, the Setup UI, and every message-handler / broadcast wire (SetupPanelProvider cases, TaskViewerProvider/DesignPanelProvider/PlanningPanelProvider listeners, five inbound webview `case` handlers, and the generated `verbAllowlist.ts` + its `protocol-catalog.json` source). After removal, Claudify H1 falls back to Hanken + terracotta (via `--doc-heading`→`--accent-primary`), matching H2–H6 in font and color — the "polish" half of the feature.
- **Give the Dev Docs Tab Proper Sidebar Cards Like the Other Tabs**: Rewrites `renderDevDocsList()` in `planning.js` to emit the canonical `.tree-node` > `.card-text` > `.card-title` (+ `.card-subtitle`) card structure already styled in `planning.html`, replacing the orphaned `system-file-item` class that is undefined in that webview. This gives Dev Docs the same bordered, theme-aware sidebar cards (hover ring, selected glow) the other planning tabs already have — the "consistency" half of the feature.

## Dependencies & sequencing

- **Cross-feature dependencies:** None. Neither subtask depends on work outside this feature. (Note: an unrelated loose plan, `fix-dev-docs-tab-empty-list-dropdown-and-buttons.md`, also touches `renderDevDocsList()`, but its `buildSidebarToggleRow` helper already exists in current source and it edits different lines — no blocking dependency.)
- **Shipping order within this feature:** The two subtasks are **independent and can land in any order**. They share one file (`src/webview/planning.js`) but in non-overlapping regions — pixel-font removal deletes the `case 'pixelFontSetting'` handler at ~line 4875, while the Dev Docs change rewrites `renderDevDocsList()` at ~line 12127+. No shared symbols, no merge conflict.
- **Prerequisites / guards:** For the pixel-font subtask only — after editing `protocol-catalog.json`, the generated `src/generated/verbAllowlist.ts` must be regenerated (`node scripts/generate-verb-allowlist.js --write`) and the parity check (`scripts/check-protocol-parity.js`) confirmed clean, or CI drift results.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Remove the Pixel-Font Option From the Claudify Theme](../plans/feature_plan_20260716151401_remove-claudify-pixel-font-option.md) — **CODE REVIEWED**
- [ ] [Give the Dev Docs Tab Proper Sidebar Cards Like the Other Tabs](../plans/feature_plan_20260716151402_devdocs-tab-sidebar-cards.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

## Review Findings

Both subtasks reviewed in-place against their plan criteria. Pixel-font removal: 16-file excision confirmed complete (grep sweep zero matches; parity check passes); fixed stale "keep base GeistPixel" comment in 3 webviews and collapsed cosmetic blank lines in `TaskViewerProvider.ts`. Dev Docs sidebar cards: implementation correct (`.tree-node` cards, both querySelectors swapped, `buildSidebarToggleRow` confirmed not a `.tree-node`); no fixes needed. Files changed in review: `src/webview/planning.html`, `src/webview/design.html`, `src/webview/project.html`, `src/services/TaskViewerProvider.ts`. Remaining risk: dead `--display-font`/`GeistPixel` `@font-face` + URI injection remain (out of scope, harmless).

