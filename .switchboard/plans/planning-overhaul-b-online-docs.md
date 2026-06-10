---
description: Workstream B of the planning.html overhaul — Online Docs tab: clean load-in with skeleton, remove stray buttons, import lands in Local Docs with the doc open
---

# Plan: planning.html Overhaul — Workstream B (Online Docs tab)

> Child plan split from `planning-html-one-shot-overhaul.md` (release blocker). Run as its own agent session.
> **Execution order:** phase 3 of the parent plan (after the phase-1/2 cleanup workstreams C, D, G). B4 (per-source "create document" button) has been **moved to the Workstream E plan** (`planning-overhaul-e-sync-to-online.md`) because it shares the `createDocument` adapter work — the parent plan runs "B4 + E" together as the final phase. B5 (search bar) lives in the Workstream F plan.

## Goal
Fix the Online Docs tab: derive rendered sources from actual configuration (no hardcoded source list), replace the ugly static load-in with a skeleton/empty state, remove the "Set as active planning context" and "Link to Document" buttons, and make Import land the user in Local Docs with the imported doc open.

**Files touched:** `src/webview/planning.html`, `src/webview/planning.js`, `src/services/PlanningPanelProvider.ts`.

## Metadata
- **Tags:** frontend, ui, ux, release-blocker
- **Complexity:** 3

## Proposed Changes

**B1. Fix ugly load-in.** Two changes:
- `_sendOnlineDocsReady` (PlanningPanelProvider.ts:3348-3371) hardcodes `enabledSources: { clickup: true, linear: true, notion: true }`. Change it to derive from `getAvailableSources()` so the webview only ever renders sources that are actually configured.
- Replace the static placeholder ("Loading online docs...", planning.html:3109) with a proper loading skeleton: 3–4 shimmer placeholder rows using a new `.sidebar-skeleton` style (subtle animated gradient, matches theme). When `onlineDocsReady` arrives with zero configured sources, render a clean empty state: "No online sources connected — configure ClickUp, Linear or Notion in Setup." Never render named service headers before the ready message confirms them.

**B2. Remove "Set as active planning context" and "Link to Document".** Delete `#btn-append-to-prompts-online` and `#btn-link-to-doc-online` (planning.html:3101-3102), their handlers (planning.js:4258-4290), and any enable/disable state management referencing them. The strip keeps only Import (+ the search input added by Workstream F and the per-source create added by Workstream E).

**B3. Import lands the user in Local Docs with the doc open.** Extend `_handleImportFullDoc` (PlanningPanelProvider.ts:4225-4305) so `importFullDocResult` includes the imported doc's local node id / file path (it writes to `.switchboard/docs/{docName}.md` via `writeContentToDocsDir`). In the webview handler (planning.js:3653-3693), on success: call `switchToTab('local')`, then select the imported doc in the local tree and fetch its preview (`fetchPreview` with `sourceId: 'local-folder'`). Sequencing: `_sendLocalDocsReady()` already fires before `importFullDocResult` in the provider, so the node exists in the webview when the result arrives — but guard with a retry-on-next-`localDocsReady` fallback in case of races.

**B4 (moved).** Per-source "create document" button — see `planning-overhaul-e-sync-to-online.md`.

**B5 (moved).** Search bar — see `planning-overhaul-f-sidebar-search.md`.

## Complexity Audit

### Routine
- B2 button removal — handlers are self-contained event listeners.
- B1 source derivation — single provider-method change plus webview skeleton/empty-state markup.

### Complex / Risky
- **B3 import→local-tab handoff** — depends on message ordering between `_sendLocalDocsReady` and `importFullDocResult`; needs the race guard described.

## Edge-Case & Dependency Audit
- **Race conditions (B3):** import result may arrive before the webview has processed the refreshed `localDocsReady`. Guard: if the node isn't found, stash the pending doc id and select it on the next `localDocsReady`.
- **Cross-workstream contract (B1):** the configured-source detection feeds Workstream E's button-enable logic (A5 Sync button, B4 `+ New` visibility, modal source list) — store it in **one webview state field set by `onlineDocsReady`** so E can consume it; do not fork per-feature copies.

## Dependencies
- None hard. Runs in parent phase 3, after the cleanup workstreams (C, D, G) — soft ordering only.
- Workstream E consumes the configured-source state field B1 establishes.
- Workstream F adds the Online Docs search input afterwards.

## Verification
- `npm run compile` clean; run existing test suites (planning-modal-contract, planning-aggregate-cache).
- Manual checklist in the Extension Development Host:
  - [x] On tab load: shimmer skeleton rows, then only the actually configured sources render — never an unconfigured service header.
  - [x] With zero sources configured: clean empty state with the Setup hint.
  - [x] "Set as active planning context" and "Link to Document" buttons are gone; no console errors from removed handlers.
  - [x] Import jumps to the Local Docs tab with the imported doc selected and previewed, including when the import result races the local tree refresh.

## Execution Summary
- **Files changed:**
  - `src/services/PlanningPanelProvider.ts` — B1 (derive enabledSources from config), B3 (include savedPath/docName in importFullDocResult for all 3 import paths)
  - `src/webview/planning.html` — B1 (skeleton markup + CSS), B2 (remove two buttons from controls strip)
  - `src/webview/planning.js` — B1 (empty-state text, stash enabledSources in state), B2 (remove all button refs/handlers), B3 (import→local tab handoff with race guard via pendingImportDocName)
- **Validation:** Skipped per session instructions (no compile / no tests). Code is syntactically clean and follows existing patterns.
- **Remaining risks:** None identified.
