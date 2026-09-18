---
description: Workstream G of the planning.html overhaul — Design System tab: subheader hierarchy, filename display, de-duplicated function bar, Active Design Doc relabel, preview meta strip, card parity
---

# Plan: planning.html Overhaul — Workstream G (Design System tab)

> Child plan split from `planning-html-one-shot-overhaul.md` (release blocker). Run as its own agent session.
> **Execution order:** G1–G4 belong to parent phase 1 (CSS/relabels); G5/G6 belong to phase 2 (meta-strip pattern work, after/alongside Workstream C establishes the render-time-state pattern).

## Resolved Decision (user-confirmed 2026-06-10)
- **Design tab config key:** keep writing `planner.designSystemDocLink`. The similarly named `planner.designDocLink` is the legacy key that the active *planning context* maps to — it came first and was never migrated to avoid risk. Label/status text change only; do NOT touch the config keys or attempt a migration.

## Goal
Fix the Design System tab: visually distinct subheader hierarchy, clean filename display with filetype subtitles, de-duplicated top function bar, "Set as Active Design Doc" relabel, doc-scoped controls moved into a preview meta strip, and card styling parity with other tabs.

**Files touched:** `src/webview/planning.html`, `src/webview/planning.js`.

## Metadata
- **Tags:** frontend, ui, ux, release-blocker
- **Complexity:** 3

## Proposed Changes

**G1. Distinct subheader hierarchy.** Both subfolder headers (planning.js:1975-1978) and file-type group headers (planning.js:1985-1988) use `.folder-subheader` (planning.html:846-859) — visually identical, hence confusing. Add a new `.type-subheader` class for the type groups: smaller (9px), lighter colour, indented 16px, no top margin — clearly subordinate to the folder header above it. Source-folder headers keep `.source-folder-header` (teal, 861-871).

**G2. Filename display.** In the design tab's card render path (`renderDocCard`, planning.js:1025-1063, which already supports `subtitle`): pass `title` = basename without extension (`design` not `design.md`) and `subtitle` = human filetype label in grey — reuse `TYPE_LABELS` (planning.js:1631-1637: Markdown/YAML/JSON) and map image extensions to their format name (`PNG`, `SVG`, …). `.card-subtitle` styling (planning.html:1917-1923) already renders grey/10px — no CSS change needed.

**G3. De-duplicate the top function bar** (planning.html:3269-3280):
- Remove `#btn-manage-design-folders` (line 3278) — the sidebar's dynamically rendered Manage Folders button (planning.js:1875-1886) stays.
- Remove the duplicated doc title and link button from the top bar/title area — doc identity lives in the new meta strip (G5).

**G4. "Set as Active Planning Context" → "Set as Active Design Doc".** Relabel `#btn-set-active-context-design` (planning.html:3273) and its status text ("Setting as active design doc…", planning.js:5509-5529). The backend already does the right thing for `design-folder` sources (writes `planner.designSystemDocLink`, PlanningPanelProvider.ts:2774-2782) — confirmed label-only change. Do NOT touch `planner.designDocLink` (the legacy active-planning-context key) and do not migrate config keys.

**G5. Doc-scoped controls into a preview meta strip.** Following the kanban meta-bar pattern, add `#design-preview-meta-bar` at the top of the design preview pane containing: doc title, Set as Active Design Doc, Link, Edit/Save/Cancel. The top function bar retains only the workspace filter and the new search input (added later by Workstream F). Edit/Save/Cancel state machine (existing handlers at planning.js:5554-5568 and the design edit-mode functions) rebinds to the meta-bar buttons; since the meta bar re-renders on selection, derive button states from `state` at render time (same care as Workstream C's C4).

**G6. Card styling parity.** Ensure design cards use the standard `.tree-node` + `.card-text` classes and gradient (planning.html:963-1004) with no design-tab-specific divergence; remove any overrides found during implementation.

## Complexity Audit

### Routine
- G3 de-duplication, G4 relabel — deletions or one-line edits at known locations.
- G1/G2 — CSS class addition + render-call parameter changes; `renderDocCard` already supports subtitles.

### Complex / Risky
- **G5 meta-bar button rewiring** — meta bars re-render per selection, so any stateful button (edit mode) must derive state at render time and clean up on selection change. Past regressions in this area (see `fix-kanban-second-function-bar.md`, `unify-local-docs-set-context-into-strip-toggle.md`) show this is where agents have broken things before.

## Edge-Case & Dependency Audit
- **Config keys (G4):** label/status text ONLY — `planner.designSystemDocLink` keeps being written; `planner.designDocLink` is untouched; no migration.
- Edit-mode interactions: switching docs while in edit mode must cleanly exit/cancel edit state before the meta bar re-renders (mirror the C4 cleanup pattern in `switchToTab`, planning.js:389-430).

## Dependencies
- Soft: Workstream C (C4) establishes the render-time-state meta-bar pattern this plan's G5 mirrors — running C first is recommended but not required.
- Workstream F adds the Design System search input afterwards; G3/G5 must leave room for it in the top bar (workspace filter + search only).

## Verification
- `npm run compile` clean; run existing test suites.
- Manual checklist in the Extension Development Host:
  - [ ] Folder vs type subheaders are visually distinct (type: 9px, lighter, indented 16px, subordinate to folder headers).
  - [ ] Cards show `design` with a grey `Markdown` subtitle (and `PNG`/`SVG` etc. for images) — no file extensions in titles.
  - [ ] No duplicate Manage Folders button, doc title, or link button in the top bar.
  - [ ] Button reads "Set as Active Design Doc" with matching status text; `planner.designSystemDocLink` is still the key written; `planner.designDocLink` untouched.
  - [ ] Doc controls (title, Set as Active Design Doc, Link, Edit/Save/Cancel) live in `#design-preview-meta-bar`; Edit/Save/Cancel state survives plan switches without stuck state or console errors.
  - [ ] Design cards visually identical to local/kanban cards (gradient, classes), no tab-specific overrides remain.

## Review Findings

**Fixed:**
- `renderDesignMetaBar` used `state.activeDesignDocEnabled` (planning epic state) to decide the "Turn off" button — now uses new `state.designSystemDocEnabled`/`sourceId`/`docId` fields populated from `msg.designSystemDoc` in `updateActiveDocBanner`.
- Removed dead JS references to deleted HTML elements: `btn-set-active-context-design`, `btn-link-to-doc-design`, `btn-edit-design`, `btn-save-design`, `btn-cancel-design` event listeners and `loadDocumentPreview`/`handlePreviewReady` toggles; also removed dead `btn-manage-design-folders` listener.

**Files changed:** `src/webview/planning.js` (state init, `updateActiveDocBanner`, `renderDesignMetaBar`, dead code removal).

**Validation:** `node --check src/webview/planning.js` clean.

**Remaining risks:** `enterEditMode`/`exitEditMode` still branch for design-tab button IDs in shared infrastructure — null-safe no-ops, but untidy for future maintenance.
