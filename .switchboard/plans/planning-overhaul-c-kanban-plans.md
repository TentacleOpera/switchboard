---
description: Workstream C of the planning.html overhaul — Kanban Plans tab: single Epics toggle, remove Refresh and panel-wide Log, move Review into the doc-preview meta bar
---

# Plan: planning.html Overhaul — Workstream C (Kanban Plans tab)

> Child plan split from `planning-html-one-shot-overhaul.md` (release blocker). Run as its own agent session.
> **Execution order:** phase 1 of the parent plan (deletions/relabels; lowest risk, biggest visual payoff).

## Goal
Clean up the Kanban Plans tab function strip: collapse the All/Epics button pair into a single toggle, remove the redundant Refresh and panel-wide Log buttons, and move the Review button into the doc-preview meta bar.

**Files touched:** `src/webview/planning.html`, `src/webview/planning.js`.

## Metadata
- **Tags:** frontend, ui, ux, release-blocker
- **Complexity:** 3

## Proposed Changes

**C1. All/Epics → single toggle.** Remove `#kanban-view-all` (planning.html:3233). Make `#kanban-view-epics` a toggle: click flips `_kanbanViewMode` between `'all'` and `'epics'`, toggles its own `.active` class, re-renders (`renderKanbanPlans`, filter at planning.js:4640-4642). Delete `updateKanbanViewButtons` two-button logic (planning.js:4443-4464).

**C2. Remove Refresh button.** Delete `#kanban-refresh-btn` (planning.html:3236, CSS 1967-1974, handler planning.js:5274-5278). Safe: the file watcher in `_setupKanbanPlansWatcher` (PlanningPanelProvider.ts:590-635) already auto-refreshes on any `.switchboard/plans/**/*.md` change with 800ms debounce, and `switchToTab('kanban')` fetches on entry.

**C3. Remove panel-wide Log button.** Delete `#btn-kanban-log` (planning.html:3238) and its enable-state code (planning.js:5202-5205). The doc-scoped Log button in the preview meta bar stays (planning.js:4914, handler 4976-4984).

**C4. Move Review into the doc-preview meta bar.** Remove `#btn-review-kanban` from the panel strip (planning.html:3240). Render it inside `renderKanbanMetaBar(plan)` (planning.js:~4914) alongside Column/Complexity/Log/Delete. Rewiring care: `enterReviewMode`/`exitReviewMode` (planning.js:4475-4504) mutate the button's text ("REVIEW" ↔ "EXIT REVIEW") and hide Edit — since the meta bar re-renders on every plan selection, the button's label/state must be derived from `state.reviewMode.kanban` at render time, and switching plans while in review mode must call `exitReviewMode('kanban', true)` first (extend the cleanup already done in `switchToTab`, planning.js:389-430).

## Complexity Audit

### Routine
- C1–C3 button removals — deletions or one-line edits at known locations.

### Complex / Risky
- **C4 meta-bar button rewiring** — meta bars re-render per selection, so any stateful button (review mode) must derive state at render time and clean up on selection change. Past regressions in this area (see `fix-kanban-second-function-bar.md`, `unify-local-docs-set-context-into-strip-toggle.md`) show this is where agents have broken things before.

## Edge-Case & Dependency Audit
- **Side effects (C2):** removing Refresh removes the only manual recovery if the watcher dies — acceptable per requirements; tab-entry fetch in `switchToTab` remains a fallback.
- The same render-time-state pattern established here for C4 is reused by Workstream G's design meta strip (G5) — keep it clean and obvious.

## Dependencies
- None. Safe to run first.
- Workstream F adds the kanban search input pattern as the shared helper template — the kanban search itself already exists and is untouched here.

## Execution Summary
- **Status:** Completed
- **Date:** 2026-06-10
- **Agent:** direct execution (no delegation)

### Changes Applied
**`src/webview/planning.html`**
- Removed `#kanban-view-all` button; kept `#kanban-view-epics` as a single toggle.
- Removed `#kanban-refresh-btn` and its CSS block.
- Removed `#btn-kanban-log` (panel-wide Log).
- Removed `#btn-review-kanban` (panel-wide Review).

**`src/webview/planning.js`**
- Replaced two-button All/Epics logic with a single toggle on `#kanban-view-epics` that flips `_kanbanViewMode` between `'all'` and `'epics'` and toggles its own `.active` class.
- Deleted `updateKanbanViewButtons()` and `kanbanViewAllBtn` references.
- Removed `kanbanRefreshBtn` variable and event listener.
- Removed `btnKanbanLog` enable-state code and `btnReviewKanban` panel listener/enable-state code.
- Moved Review button into `renderKanbanMetaBar()` alongside Column/Complexity/Log/Delete. Button text derived at render time from `state.reviewMode.kanban`.
- Wired click handler on the meta-bar Review button to call `enterReviewMode('kanban')` / `exitReviewMode('kanban', true)`.
- Updated `enterReviewMode` and `exitReviewMode` to re-render the meta bar (`renderKanbanMetaBar(_kanbanSelectedPlan)`) instead of mutating a removed panel button. Panel Edit hide/show behavior preserved.

### Risks / Follow-up
- Existing selection-change cleanup already exits review mode before re-rendering meta bar (no stuck state).
- `switchToTab` already exits review mode when leaving the kanban tab.
- No compilation or tests run per session directives.

## Verification
- `npm run compile` clean; run existing kanban test suites.
- Manual checklist in the Extension Development Host:
  - [ ] Single Epics toggle flips between all/epics views, with `.active` styling reflecting state.
  - [ ] No Refresh button; editing a plan file in `.switchboard/plans/` still auto-refreshes the board (watcher); entering the tab fetches fresh data.
  - [ ] No panel-wide Log button; the doc-scoped Log button in the meta bar still works.
  - [ ] Review button lives in the doc-preview meta bar; entering review mode flips it to "EXIT REVIEW" and hides Edit.
  - [ ] Switching plans while in review mode cleanly exits review mode first — no stuck state, no console errors.

## Review Findings
- **Files changed:** `src/webview/planning.html` (added `.strip-btn.active` CSS rule at line 370), `src/webview/planning.js` (no changes needed — implementation was already correct).
- **Validation:** JavaScript syntax check passed (`node --check`). No compilation or tests run per session directives.
- **Remaining risks:** None material. The `.strip-btn.active` CSS fix was the only gap; all state management for review mode, edit mode hiding, and selection-change cleanup is correctly wired.
