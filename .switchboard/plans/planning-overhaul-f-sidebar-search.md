---
description: Workstream F of the planning.html overhaul — shared debounced sidebar search helper rolled out to Local Docs, Online Docs, HTML Previews, Tickets, and Design System tabs
---

# Plan: planning.html Overhaul — Workstream F (Search bars in every tab)

> Child plan split from `planning-html-one-shot-overhaul.md` (release blocker). Run as its own agent session.
> **Execution order:** parent phase 4 — after the tab-structure workstreams (A, B, C, D, G) have settled, so the inputs land in the final control strips.

## Goal
Replicate the kanban sidebar search pattern as a shared helper and add a search input to every remaining tab's controls strip: Local Docs, Online Docs, HTML Previews, Tickets, and Design System.

**Files touched:** `src/webview/planning.html`, `src/webview/planning.js`.

## Metadata
- **Tags:** frontend, ui, ux, feature, release-blocker
- **Complexity:** 3

## Proposed Changes

Replicate the kanban search pattern (input planning.html:3231; debounced handler planning.js:5263-5271; filter logic 4629-4633) as a shared helper in planning.js: `wireSidebarSearch(inputId, getItems, render)` — 200ms debounce, case-insensitive substring match on title. Add a search input to the controls strip of:
- **Local Docs** — filters tree nodes by title; folder/type subheaders with zero visible children are hidden.
- **Online Docs** — filters the loaded doc nodes per source (client-side, no refetch).
- **HTML Previews** — input in `#tree-pane-html` region (sidebar populated via `_sendHtmlDocsReady`, PlanningPanelProvider.ts:3193-3270).
- **Tickets** — filters ticket cards on title/identifier/assignee (extend the existing `filteredIssues` computation, planning.js:5970-6035).
- **Design System** — same tree filter as Local Docs.

All use one CSS class for consistent sizing (`flex: 1` inside the strip like `#kanban-search`).

## Complexity Audit

### Routine
- Direct replication of a proven in-file pattern (the kanban search) across five tabs.

### Complex / Risky
- None individually; the risk is consistency — filters must live in a state object and survive re-renders (see below).

## Edge-Case & Dependency Audit
- **Race conditions:** search re-render racing the auto-refresh (kanban watcher, tickets polling) — filters live in a state object and every render path must re-apply them (the kanban pattern already does this; **replicate, don't fork**).
- Empty-result states: hide folder/type subheaders with zero visible children (Local Docs / Design System) rather than showing orphaned headers.

## Dependencies
- **Run after Workstreams A, B, C, D, G** — the control strips this adds inputs to are restructured by those workstreams (buttons removed/moved); landing search first would mean rework.
- Tickets filter extends `filteredIssues` as left by Workstream D.

## Verification
- `npm run compile` clean; run existing test suites.
- Manual checklist in the Extension Development Host, per tab (Local, Online, HTML Previews, Tickets, Design):
  - [ ] Search input sits in the controls strip with consistent sizing (`flex: 1`) across all tabs.
  - [ ] Typing filters items case-insensitively on title (Tickets: also identifier/assignee) with 200ms debounce.
  - [ ] Subheaders with zero visible children are hidden (Local Docs / Design System).
  - [ ] Filter survives an auto-refresh (edit a plan file / let tickets poll) — the filtered view re-applies, doesn't reset.
  - [ ] Clearing the input restores the full list.

## Review Findings

Review completed: 5 material issues found and fixed in `src/webview/planning.js`. Tickets search was using a rogue 300ms inline debounce instead of the shared `wireSidebarSearch` helper; refactored to use the shared helper with correct 200ms debounce. ClickUp panel was hiding the search input (`display: none`); now visible so ClickUp users can client-side filter loaded tasks. ClickUp list renderer didn't sync the input value from restored state; added sync. ClickUp client-side filter excluded task `id` and `identifier` from its haystack; added both to match the plan's "title/identifier/assignee" requirement. Files changed: `src/webview/planning.js` only. Compilation and tests skipped per session directive. Remaining risk: ClickUp search is client-side only over already-loaded tasks; server-side `searchQuery` is only sent during initial load/more, not on typing. No other risks identified.
