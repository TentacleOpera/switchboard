---
description: Workstream D of the planning.html overhaul — Tickets tab: delete the teal banner, Ask Agent on every card, unified card styling, single grid + glass overlay, loading state, font fix
---

# Plan: planning.html Overhaul — Workstream D (Tickets tab)

> Child plan split from `planning-html-one-shot-overhaul.md` (release blocker). Run as its own agent session.
> **Execution order:** D4/D6 belong to parent phase 1 (CSS fixes); D1–D3 and D5 belong to phase 2.

## Resolved Decision (user-confirmed 2026-06-10)
- **Tickets banner:** delete the teal banner entirely — do NOT relocate its buttons to a meta strip. The sidebar card buttons are sufficient (and some may be removed later). Banner buttons (Import / Refine / Ask Agent / Back-to-Parent) are deleted with it; Ask Agent is added per-card (D2), and Refine/Import already exist on cards. Back-to-Parent navigation is dropped.

## Goal
Fix the Tickets tab: remove the teal "Active Ticket" banner entirely, add Ask Agent to every sidebar ticket card, unify card button styling with other tabs, fix the doubled grid background and add the glass overlay, add a proper loading state, and fix the font inconsistencies.

**Files touched:** `src/webview/planning.html`, `src/webview/planning.js`.

## Metadata
- **Tags:** frontend, ui, ux, release-blocker
- **Complexity:** 3

## Proposed Changes

**D1. Remove the teal banner entirely — no relocation.** Delete `#active-doc-banner-tickets` and everything inside it (planning.html:3402-3417): the "Active Ticket" label/name, `#tickets-detail-meta` (status/assignee), and all four banner buttons (`#tickets-detail-import`, `#tickets-detail-refine`, `#tickets-detail-ask-agent`, `#tickets-back-to-parent`). The sidebar card buttons cover these actions. Remove every JS reference to the deleted elements so nothing throws on a null `getElementById` — known sites: `detailAskAgentButton` enable logic (planning.js:6133), the banner button click handlers, the status/assignee meta population, and the Back-to-Parent visibility logic (Back-to-Parent navigation is intentionally dropped per user decision). Also delete the now-unused `.tickets-banner-actions` and `.tickets-detail-meta` CSS (planning.html:579-587).

**D2. Ask Agent on every sidebar ticket card.** In the card template (planning.js:6017-6025), add an `ASK AGENT` button next to REFINE/IMPORT, posting the same message the (now-deleted) banner Ask Agent button sent, parameterised by `data-linear-issue-id`. With the banner gone, the cards are the only home for this action.

**D3. Unify sidebar card button styling.** `.tickets-issue-import-btn` is a bespoke class. Restyle ticket card actions to the shared card action classes used by other tabs (`card-icon-btn` family / `.tree-node .card-actions` pattern, planning.html:1924-1929) so size, font, border and hover match kanban/local cards exactly. Keep `.ticket-node`'s column layout but align padding/margins to `.tree-node` values where they differ.

**D4. Fix duplicated grid + add glass overlay.** Root cause found: `#markdown-preview-tickets` receives the grid background from BOTH the primary rule (planning.html:2294-2306, applied to its parent `#preview-pane-tickets`) and the duplicate rule (planning.html:2308-2318) — two stacked 40px grids. Fix: remove `#markdown-preview-tickets` from the 2308-2318 rule. Glass overlay: other tabs place a `.cyber-scanlines` overlay div inside `.preview-panel-wrapper` (e.g. online tab, planning.html:3131); verify the tickets preview wrapper has the same structure and add `.cyber-scanlines` if absent, so the glass treatment matches every other tab.

**D5. Proper loading state in the preview.** While tickets load, the preview area is bare. Add a centered spinner + "Loading tickets…" state mirroring the HTML tab's loader (planning.html:3348-3350, `spin` animation), shown whenever `linearProjectStatus === 'loading'` (planning.js:5980-5987), and skeleton rows in the sidebar instead of plain text.

**D6. Fix the font.** Two offenders: (a) conflicting `#markdown-preview-tickets` font rules at planning.html:1151-1158 — delete both tickets-specific declarations and let the tickets preview inherit exactly the same rules as `#markdown-preview` (the local docs preview) so every theme renders identically; (b) `.tickets-issue-meta` hardcodes `var(--font-mono)` (planning.html:2746) — change card metadata to `var(--font-family)` to match other tabs' card subtitles. Audit the tickets CSS block (planning.html:2696-2770) for any other `font-family` overrides and remove them.

## Complexity Audit

### Routine
- D4 duplicate-rule removal, D6 font consolidation — deletions at known locations.

### Complex / Risky
- **D1 banner removal** — `active-doc-banner-tickets` element ids are referenced in multiple JS code paths (enable/disable, back-to-parent visibility, status/assignee meta); every reference must be deleted (not retargeted — nothing replaces the banner) or the tab silently breaks on null elements.

## Edge-Case & Dependency Audit
- **Side effects (D6):** removing `--font-mono` from `.tickets-issue-meta` changes density of state/assignee lines; check truncation still behaves.
- **Prior failed attempts:** `unify-tickets-tab-layout-with-docs-tabs.md` and `tickets-tab-ui-fix.md` are earlier attempts at this workstream; their failure mode was patching symptoms (adding rules) instead of removing the conflicting rules — this plan removes the duplicates at planning.html:2308-2318 and 1151-1158 rather than adding more overrides.

## Dependencies
- None. D4/D6 can run in parent phase 1; the rest in phase 2.
- Workstream F extends the ticket card filter (`filteredIssues`, planning.js:5970-6035) afterwards — do not restructure that computation in a way that breaks substring filtering.

## Verification
- `npm run compile` clean; run existing test suites.
- Manual checklist in the Extension Development Host:
  - [ ] Teal banner gone with no replacement strip and **no console errors** from removed element references (click around the whole tab).
  - [ ] Ask Agent / Refine / Import on every sidebar card, with styling (size, font, border, hover) matching kanban/local cards.
  - [ ] Single 40px grid background in the preview, with the `.cyber-scanlines` glass overlay matching other tabs.
  - [ ] Spinner + "Loading tickets…" in the preview and skeleton rows in the sidebar while `linearProjectStatus === 'loading'`.
  - [ ] Preview font matches the Local Docs preview in all themes (check theme-afterburner-updated specifically); card metadata uses `var(--font-family)` and truncation still behaves.
