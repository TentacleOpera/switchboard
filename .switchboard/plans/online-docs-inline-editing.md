# Online Docs Tab — Inline Editing & Unified Docs Model

## Goal

Eliminate the friction of the current import-to-local-then-switch workflow. Users should be able to view and edit online docs directly in the Online Docs tab, with a sync button to push changes back to the source. The local file is the working copy; the online source is the sync target — the same model the Tickets tab uses.

## Metadata

- **Complexity:** 6
- **Tags:** frontend, backend, ux, refactor

## User Review Required

Yes — the decision to collapse Online Docs and Local Docs into a single unified "Docs" tab (vs. keeping them separate with editing added to Online Docs) needs product sign-off before implementation.

## Problem Analysis

The current workflow to edit an online doc is:
1. Open Online Docs tab, find and view the doc
2. Click Import — doc is copied to `.switchboard/docs/`
3. Switch to Local Docs tab
4. Scroll through the list to find the imported doc
5. Edit it
6. Switch back to Online Docs tab to find the sync button

This is 6 steps with 2 tab switches for a task that should be 1 step. The underlying architecture already supports it: `_handleFetchDocsFile` reads the local `.md` cache file, and `_handleSyncToSource` pushes it back. The missing piece is just the edit surface in the Online Docs tab.

The deeper issue is that the Online Docs / Local Docs split is the wrong abstraction. From the user's perspective there is one thing: a doc. It may or may not be connected to an online source. The connection to an online source is metadata (a sync indicator), not a reason to live in a different tab.

## Requirements

### Option A — Inline editing in Online Docs tab (smaller change)

- When a doc is open in the Online Docs preview pane, show an Edit button
- Clicking Edit switches the preview to an editable textarea (same pattern as the Tickets tab edit mode)
- Saving writes to the local `.md` file
- The existing Sync button pushes the local file back to the source
- Import button remains for docs that haven't been fetched yet (first-time fetch)
- File watcher already added (see `_setupDocsFolderWatcher`) refreshes the panel when the file changes externally

### Option B — Unified Docs tab (larger change, better long-term)

- Merge Online Docs and Local Docs into a single Docs tab
- Each doc in the list shows a sync indicator: connected to source (ClickUp/Notion/Linear) or local-only
- Clicking a connected doc fetches latest from source if not yet local, then shows it in the edit pane
- Edit pane is always editable (no separate view/edit mode toggle needed)
- Save writes locally; Sync pushes to source
- Local-only docs have no sync button

**Recommendation: Option B.** Option A adds editing but leaves the confusing dual-tab model in place. The Local Docs tab becomes redundant once online docs are editable in place. Option B is more work upfront but removes a conceptual split that currently requires users to understand the import-to-local model.

## Complexity Audit

### Routine
- Adding textarea edit mode to online docs preview pane (mirrors tickets tab pattern exactly)
- Save handler writing to local `.md` file via existing `saveLocalTicket`-style message
- Edit/Save/Cancel button state management in `planning.js`

### Complex / Risky
- **Option B only:** Merging the two tab data models — online docs use `slugPrefix` as ID + DB-backed metadata; local docs use `filePath` directly. These need to be unified into a single list model.
- **Option B only:** Handling docs that exist locally but have no online source (pure local docs) alongside docs with sync connections — the list needs to handle both gracefully.
- **First-time fetch UX:** If a user clicks an online doc that hasn't been imported yet, the system needs to auto-fetch before showing the edit pane, or clearly communicate that the doc needs to be fetched first.
- **Conflict detection:** If the online source has been updated since last sync, the user should be warned before overwriting with local changes. Currently there is no conflict detection.

## Implementation Plan (Option B)

### Phase 1 — Inline editing on Online Docs tab (unblocks agents immediately)
1. Add Edit button to online docs preview pane in `planning.html`
2. Wire edit/save/cancel in `planning.js` — on save, post `saveOnlineDocFile` message with `slugPrefix` + content
3. Add `saveOnlineDocFile` handler in `PlanningPanelProvider.ts` — resolves file path via `cacheService.resolveImportedDocPath`, writes file, posts confirmation
4. File watcher in `_setupDocsFolderWatcher` already handles live refresh

### Phase 2 — Unified Docs tab
1. Design new unified list data model that covers both local-only docs and source-connected docs
2. Migrate Online Docs tab to render the unified list
3. Migrate Local Docs tab content into the same list with `sourceId: 'local-only'`
4. Retire the separate Local Docs tab (or keep as a filter view)
5. Update `_setupLocalFolderWatchers` and `_setupDocsFolderWatcher` to both feed the unified list

## Dependencies

- Tickets tab file watcher fix (already done) — proves the pattern works
- `cacheService.resolveImportedDocPath` must reliably return the local path for any imported doc (currently does)
- Conflict detection is out of scope for Phase 1 — accept last-write-wins for now

## Acceptance Criteria

- [ ] User can edit an online doc without leaving the Online Docs tab
- [ ] Save writes to the local `.md` file
- [ ] Sync button pushes local changes back to the online source
- [ ] No tab switching required to go from viewing to editing
- [ ] File watcher keeps the pane live when an agent edits the file externally
- [ ] (Phase 2) Single Docs tab shows all docs regardless of source, with sync indicator per doc
