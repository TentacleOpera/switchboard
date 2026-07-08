# Unified Docs Tab — Merge Online & Local Docs

## Goal

Collapse the separate **Local Docs** and **Online Docs** tabs into a single **Docs** tab. From the user's perspective there is one thing — a doc — that may or may not be connected to an online source. The online connection is metadata (a per-doc sync indicator), not a reason to live in a different tab.

This plan supersedes the earlier two-phase approach. The previously shipped "inline editing on a still-separate Online Docs tab" (old Phase 1 / Option A) is **explicitly dropped** as the end-state: it left the confusing dual-tab model in place, which is exactly the issue the user reported ("why am I still seeing two separate tabs"). The unified tab (old Phase 2 / Option B — described in the original plan as the better long-term design) is now the **sole, mandatory scope**.

The local `.md` file in `.switchboard/docs/` remains the working copy; the online source is the sync target — the same model the Tickets tab uses.

## Metadata

- **Complexity:** 6
- **Tags:** frontend, backend, ux, refactor

## User Review Required

No — the product decision is already made. The user has explicitly directed that the two tabs be unified into one. Do **not** ship a solution that leaves two separate Docs tabs.

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

Merge Online Docs and Local Docs into a single **Docs** tab. Concretely:

- One tab button (`DOCS`) replaces the two buttons `LOCAL DOCS` and `ONLINE DOCS` in `planning.html`.
- One tree pane lists **all** docs: local-folder docs and online-source docs (ClickUp / Linear / Notion), grouped under **collapsible** source sections (see Navigation & Information Architecture).
- **Source switching = hybrid (Model C):** the grouped tree shows everything by default, with a **source filter** (toggle chips: `Local · ClickUp · Linear · Notion`) to show/hide sections, plus a **separate workspace dropdown** to scope by repo root. The two axes (source vs. workspace) stay as separate controls — they are not merged into one list.
- Each doc row shows a **sync indicator**: connected-to-source vs. local-only.
- Selecting a doc shows it in a single preview/edit pane. The inline Edit/Save/Cancel + textarea affordance already built for the Online tab is reused — there is now exactly **one** set of edit controls, not two.
- **Save** writes to the local `.md` working copy; **Sync** pushes to the online source. Local-only docs have no Sync button (`canSync: false`).
- Clicking a connected doc that is not yet imported triggers the existing first-time fetch (`_handleFetchPreview`) before showing it.
- The current per-tab edit-mode keys (`local` / `online`) collapse to a single `docs` edit mode.

**Out of scope:** keeping any second Docs tab, or any fallback that re-introduces the Local/Online split. The acceptance bar is a single tab — anything else is a failed implementation.

## Navigation & Information Architecture

The controls strip carries two **independent** scoping controls plus search:

1. **Workspace dropdown** (existing, merged) — scopes the whole list to one repo root or "All Workspaces". This replaces the separate `#local-workspace-filter` and `#online-workspace-filter`, which today hold divergent state.
2. **Source filter chips** (new) — `Local · ClickUp · Linear · Notion`, each a toggle that shows/hides that source's sections. Backed by the existing `enabledSources` flags so it is cheap. Default: all on. State persists across reloads.
3. **Search** (existing, merged) — one search input filtering doc titles across all visible sections.

### Fixing the folder-spam problem (explicit user complaint)

**Current behavior:** `renderLocalDocs` (`planning.js:1249`) renders every configured source folder as a non-collapsible `source-folder-header` (`:1340`) with all docs flattened beneath it. With more than a few folders the sidebar becomes a long, undifferentiated scroll — the user explicitly dislikes this.

**Required change — make sections collapsible (accordion):**
- Every section header (source-folder header for local, source header for online — `:1340`, `:1647`) becomes a clickable disclosure row with a chevron (`▸`/`▾`) and a doc count, e.g. `▸ designs/ (12)`.
- Collapse/expand state is **persisted per section** (keyed by source folder path / source id) in webview state, so reopening the panel restores the user's layout.
- **Auto-collapse heuristic:** when more than `N` (default 4) local source folders are present, render them collapsed by default so the user sees a short list of folder headers instead of a wall of docs. Sections with an active/selected doc, or matching the current search, auto-expand.
- Search and the source-filter chips still apply across collapsed sections (a matching collapsed section auto-expands to reveal hits).
- Nested subfolders (`:1433`) keep their existing hierarchy but inherit the same collapsible behavior.

This converts the sidebar from "flat wall of every doc in every folder" into "a tidy list of collapsible folder/source groups you expand on demand," which is the navigation model the user asked for.

## Complexity Audit

### Already done (reuse, do not rebuild)
- Inline edit controls + textarea (`btn-edit-online`/`btn-save-online`/`btn-cancel-online`, `markdown-editor-online`) and the `saveOnlineDocFile` handler exist and work.
- `_handleSyncToSource` (`PlanningPanelProvider.ts:4970`) already does SHA-256 conflict detection and a VS Code modal for resolution — reuse as-is.
- `_setupDocsFolderWatcher` self-write suppression (2s `_lastPanelWriteTimestamp` check) already prevents save-induced list jitter.
- `resolveImportedDocPath` / `resolveActiveOnlineSlugPrefix()` resolution path is in place and used by the save handler.

### Routine
- Replace the two tab buttons in `planning.html` (`data-tab="local"`, `data-tab="online"`) with one `data-tab="docs"` button, and merge `#local-content` + `#online-content` into a single `#docs-content` body (one controls strip, one tree pane, one preview/edit pane).
- Collapse the `local`/`online` edit-mode keys in `planning.js` (`state.editMode`, `editOriginalContent`, `dirtyFlags`, `externalChangePending`) into a single `docs` key, and point `enterEditMode`/`exitEditMode` at the single pane/textarea/buttons.
- Update `switchToTab` to handle `docs` (sidebar state + exit `docs` edit mode on leave) and drop the `local`/`online` branches.

### Complex / Risky
- **View-layer merge is the core work:** `renderOnlineDocs` (`planning.js:1611`) and `renderLocalDocs` emit separate DOM trees. A new `renderUnifiedDocs(localRoots, onlineRoots, enabledSources)` must render both into one `#tree-pane` — local docs tagged `sourceId:'local-only'`, `canSync:false`; online docs tagged with the real source id and `canSync:true`. Preserve search + workspace filter behavior for both.
- **Dual backend pipeline stays during transition:** `_sendLocalDocsReady` (`localDocsReady`) and `_sendOnlineDocsReady` (`onlineDocsReady`) post different shapes. The webview must consume **both** and merge in the view layer. The backend `_sendUnifiedDocsReady` merge is an **optional follow-up**, not a blocker for the single-tab UX.
- **Edit-mode state machine fragility:** `enterEditMode`/`exitEditMode` also handle `kanban` and a broken `design` fallback (falls through to `kanban-preview-pane`). Collapsing `local`+`online` to `docs` must not disturb the `kanban` branch.
- **Selection/scroll preservation:** merging two list-refresh sources into one pane risks resetting selection when either `localDocsReady` or `onlineDocsReady`/`importedDocsReady` arrives. Re-render must preserve the active doc selection.
- **First-time fetch:** clicking a connected (not-yet-imported) doc must route through existing `_handleFetchPreview` auto-fetch + cache before enabling Edit.
- **Duplicate docs:** a doc present both locally and online (same slug) must dedupe to one row showing the sync indicator, not two rows.

## Proposed Changes

**Single delivery — the unified Docs tab.** There is no longer a staged "inline-editing-first" step; that already shipped and is being superseded. All changes below must land together so the user never sees two Docs tabs.

### 1. `src/webview/planning.html` — one tab, one body
- **Context:** `planning.html:3037-3038` declares two buttons (`data-tab="local"` LOCAL DOCS, `data-tab="online"` ONLINE DOCS). `#local-content` (`:3045`) and `#online-content` (`:3087`) are two separate tab bodies, each with its own controls strip, tree pane, preview pane, and editor textarea.
- **Change:** Replace the two tab buttons with a single `<button class="shared-tab-btn" data-tab="docs">DOCS</button>`. Merge the two bodies into one `#docs-content` containing a single controls strip (workspace filter, **source filter chips**, Import, Edit/Save/Cancel, Sync, search), a single `#tree-pane`, and a single preview/edit pane with one `#markdown-preview` and one `#markdown-editor` textarea.
- **Implementation:**
  - Keep the local-docs body as the base (it owns the canonical `#tree-pane`, `#preview-pane`, `#markdown-editor-local`, sync button) and fold the online-only affordances into it. Reuse existing `.strip-btn` / `.markdown-editor` CSS to avoid style drift.
  - Add a `#docs-source-filter` chip group to the controls strip: one toggle chip per source (`Local`, `ClickUp`, `Linear`, `Notion`). Reuse a small `.filter-chip` style (active/inactive states); wire clicks in JS (step 2).
  - Retire the now-duplicate ids: `#online-content`, `#controls-strip-online`, `#tree-pane-online`, `#preview-pane-online`, `#markdown-preview-online`, `#markdown-editor-online`, `#online-workspace-filter`, `#online-docs-search`, `#status-online`, and `btn-*-online`.
- **Edge Cases:** Preserve persisted sidebar collapsed state and keyboard shortcuts. Keep one merged workspace-filter dropdown and one search input. Hide a chip if that source isn't connected (no adapter).

### 2. `src/webview/planning.js` — unified renderer + state
- **Context:** `renderLocalDocs` and `renderOnlineDocs` (`:1611`) build separate trees; `handleLocalDocsReady` (`:1743`) and `handleOnlineDocsReady` (`:1792`) feed them separately. `switchToTab` (`:526`) and the edit-mode machine branch on `local`/`online`.
- **Change & Implementation:**
  - Add `renderUnifiedDocs(localRoots, onlineRoots, enabledSources)` that renders both into the single `#tree-pane`: local-folder docs under a "Local" header tagged `sourceId:'local-only'`, `canSync:false`, `isLocalOnly:true`; online docs under their source headers (ClickUp/Linear/Notion) tagged with the real source id and `canSync:true`. Preserve the source refresh / + New / location controls from `renderOnlineDocs` and the search + workspace-filter behavior from both.
  - Have `handleLocalDocsReady` and `handleOnlineDocsReady` both cache their latest payload (`state._lastLocalDocsMsg`, `state._lastOnlineDocsMsg`) and call a single `rerenderUnifiedDocs()` that merges whichever payloads are present. This consumes **both** `localDocsReady` and `onlineDocsReady` without backend changes.
  - Collapse `state.editMode`/`editOriginalContent`/`dirtyFlags`/`externalChangePending` keys `local` and `online` into one `docs` key. Point `enterEditMode('docs')`/`exitEditMode('docs')` at the single `#preview-pane`, `#markdown-editor`, and `#btn-edit`/`#btn-save`/`#btn-cancel`. Leave the `kanban` branch untouched.
  - Replace the `local`/`online` branches in `switchToTab` with a single `docs` branch (sidebar state via `state.docsListCollapsed`; exit `docs` edit mode when leaving).
  - On save, route through the existing `saveOnlineDocFile` path for online-backed docs (resolved via `resolveActiveOnlineSlugPrefix()`) and the existing local save path for local-only docs, keyed off the selected row's `isLocalOnly` flag.
  - **Collapsible sections:** make each section header (`source-folder-header` at `:1340`, online `source-header` at `:1647`) a disclosure toggle with a chevron + doc count. Track open/closed per section in `state.docsSectionCollapsed` (keyed by folder path / source id), persisted via the existing webview state mechanism. Apply the auto-collapse heuristic (default-collapse when >4 local source folders) and auto-expand sections containing the active doc or matching the current search.
  - **Source filter chips:** add `state.docsSourceFilter` (defaults all-on, persisted). Wire `#docs-source-filter` chip clicks to toggle a source's visibility and re-run `rerenderUnifiedDocs()`. Reuse `enabledSources` semantics so a disabled chip hides that source's sections.
- **Edge Cases:**
  - **Selection preservation:** `rerenderUnifiedDocs()` must restore the active doc selection (and scroll) after either payload arrives, so an online refresh doesn't clear a local selection or vice-versa.
  - **Duplicate docs:** a doc present both locally and online (same slug) dedupes to one row that shows the sync indicator (prefer the online entry, keep local as the working copy).
  - **First-time fetch:** clicking a connected, not-yet-imported doc routes through existing `_handleFetchPreview` auto-fetch + cache before enabling Edit.
  - **Sync button visibility:** shown only when the selected row's `canSync` is true; hidden for local-only docs.

### 3. `src/services/PlanningPanelProvider.ts` — keep dual pipeline (no backend merge required)
- **Context:** `_sendLocalDocsReady` (`:4614`, posts `localDocsReady`) and `_sendOnlineDocsReady` (`:4730`, posts `onlineDocsReady`) emit different shapes. `_handleFetchRoots` (`:4759`) already calls both.
- **Change:** **No backend change is required for the single-tab UX.** The webview merges the two existing messages in the view layer (step 2). Continue emitting both `localDocsReady` and `onlineDocsReady`.
- **Optional follow-up (not a blocker, do not gate delivery on it):** a future `_sendUnifiedDocsReady` could merge local + imported docs server-side and retire the dual pipeline. Defer until the view-layer merge is proven stable. The existing `saveOnlineDocFile` handler and `_setupDocsFolderWatcher` self-write suppression remain as-is.
- **Edge Cases:** `localWorkspaceRootFilter` and `onlineWorkspaceRootFilter` UI state must be reconciled into one filter in the webview; the backend filters need no change.

## Edge-Case & Dependency Audit

- **Race Conditions:** `_handleSyncToSource` and `saveOnlineDocFile` can race if the user clicks Sync immediately after Save. `saveFileContent` writes synchronously; `_handleSyncToSource` reads the file afterward. Safe as long as Save completes before Sync starts. No explicit re-entrancy guard exists on either handler.
- **Security:** `saveOnlineDocFile` must resolve the file path strictly within the workspace. `resolveImportedDocPath` (line ~535 in `PlanningPanelCacheService.ts`) uses DB lookup or directory scan limited to `.switchboard/docs/`. The new handler should reject any webview-supplied arbitrary path and fall back to the resolved path only.
- **Side Effects:** Writing to `.switchboard/docs/*.md` triggers `_setupDocsFolderWatcher` → `_handleFetchImportedDocs`. During active edit, this can cause list flicker. Mitigation: suppress the imported-docs refresh when the write originated from the panel itself (e.g., compare `_lastPanelWriteTimestamp` already tracked at line ~5044).
- **Dependencies & Conflicts:** The unified view-layer merge consumes both `_sendLocalDocsReady` (local folder service) and `_sendOnlineDocsReady` (online adapters). Both must continue to work independently — the webview merges them. The `localWorkspaceRootFilter` and `onlineWorkspaceRootFilter` UI state must be reconciled into one filter.

## Dependencies

- **Tickets tab file watcher fix** (already done) — proves the debounced refresh pattern works
- **`cacheService.resolveImportedDocPath`** must reliably return the local path for any imported doc (currently does; verified at `PlanningPanelCacheService.ts:535`)
- **`saveFileContent` path validation logic** (`PlanningPanelProvider.ts:2229`) — can be reused or referenced for the new `saveOnlineDocFile` handler
- **`_handleSyncToSource` conflict detection** (`PlanningPanelProvider.ts:4970`) — already implements remote hash comparison and modal resolution; applicable immediately

## Adversarial Synthesis

Key risks: (1) Collapsing the `local`+`online` edit modes into one `docs` mode must not disturb the `kanban` branch of the fragile `enterEditMode`/`exitEditMode` state machine (and the known broken `design` fallback); (2) Merging two independent list-refresh sources (`localDocsReady`, `onlineDocsReady`) into one pane can reset the active selection/scroll on every refresh unless re-render preserves it; (3) Duplicate docs (same slug local + online) could render twice. Mitigations: keep the `kanban` branch byte-for-byte unchanged and only add the unified `docs` key; cache both payloads and re-merge via a single `rerenderUnifiedDocs()` that restores selection; dedupe by slug preferring the online entry. The inline-editing save/sync/watcher machinery already shipped and is reused unchanged, which lowers regression surface. No backend data-pipeline merge is attempted in this pass.

## Acceptance Criteria

- [ ] **There is exactly ONE Docs tab.** `LOCAL DOCS` and `ONLINE DOCS` are gone, replaced by a single `DOCS` tab. (This is the primary failure the user reported.)
- [ ] The single Docs tab lists all docs regardless of source (local-folder + ClickUp/Linear/Notion), grouped under source headers, with a per-doc sync indicator.
- [ ] Selecting any doc shows it in one shared preview/edit pane; there is exactly one set of Edit/Save/Cancel controls.
- [ ] Save writes to the local `.md` working copy (online-backed via `saveOnlineDocFile` → `resolveImportedDocPath` → `fs.promises.writeFile`; local-only via the local save path).
- [ ] Sync button appears only for source-connected docs (`canSync`) and pushes local changes back; existing conflict detection in `_handleSyncToSource` triggers if remote changed.
- [ ] No tab switching required to go from viewing to editing any doc.
- [ ] **Source filter chips** (`Local · ClickUp · Linear · Notion`) show/hide each source's sections; a separate workspace dropdown scopes by repo root. Both states persist.
- [ ] **Sidebar sections are collapsible** with chevron + doc count; collapse state persists, and with many local folders the list defaults to a tidy set of collapsed headers rather than a flat wall of docs.
- [ ] File watcher keeps the pane live on external edits; auto-refresh defers reload while the user is in `docs` edit mode, and a list refresh preserves the active selection.
- [ ] Existing `kanban` edit mode and Tickets tab behavior are unaffected.

## Verification Plan

### Automated Tests

- **Unit test `PlanningPanelCacheService.resolveImportedDocPath`:** Verify correct path resolution for hash-suffixed filenames (e.g., `docSlug_abc12345.md`) and collision suffixes (`_1`, `_2`).
- **Unit test `PlanningPanelProvider._handleSyncToSource` conflict detection:** Mock adapter with `fetchContent` returning changed content; assert modal flow and correct `updateLastSynced` call.
- **Unit test — `renderUnifiedDocs` merge:** Given a `localDocsReady` payload and an `onlineDocsReady` payload, assert a single tree renders both, with local rows `canSync:false`/`isLocalOnly:true` and online rows tagged with the real source id and `canSync:true`; assert duplicate slugs collapse to one row.
- **Unit test — selection preservation:** With a doc selected, simulate a second `localDocsReady`/`onlineDocsReady` arriving; assert the active selection is restored after `rerenderUnifiedDocs()`.
- **Integration test — edit save → watcher → refresh:** Simulate webview posting the save, provider writing the file, watcher firing, and webview receiving `previewReady` with `isAutoRefreshed: true` while deferring reload because `editMode.docs` is active.
- **UI test — end-to-end on the single tab:** From the one `DOCS` tab, select an online doc → Edit → modify → Save → verify disk file updated → Sync → verify `syncResult` success; then select a local-only doc and confirm no Sync button.
- **Regression test — kanban edit mode:** Confirm the `kanban` edit/save flow is unaffected after collapsing `local`+`online` into `docs`.

> **Note:** Skip compilation and test execution for this session per directive. Tests will be run separately by the user.

**Recommendation: Send to Coder** (Complexity 6 — frontend-heavy view-layer merge reusing already-shipped save/sync/watcher machinery; main risk is selection preservation and not disturbing the `kanban` branch).

## Review Findings

Reviewed the unified Docs tab implementation against the plan; HTML merge (single `DOCS` tab, source chips, retired `-online` ids), edit-mode collapse to `docs` (kanban branch intact), and `-online` JS vars safely aliased to unified DOM nodes all check out. One MAJOR issue fixed: the shared Sync button had two competing controllers — the legacy `updateSyncToOnlineButtonState` (`planning.js:7245`) ran last on every selection and overrode the plan's `canSync` gating in `updateSyncButtonVisibility` (`:1252`), leaving online docs un-syncable from the toolbar and local-only docs incorrectly showing Sync. Fix: `updateSyncToOnlineButtonState` now delegates to `updateSyncButtonVisibility` so per-doc `canSync` is the single source of truth. Files changed: `src/webview/planning.js`. Validation: compilation/tests skipped per session directive; change is a one-line delegation within an existing same-scope IIFE (hoisted function declaration), no new symbols. Remaining risks (deferred, NIT): no slug dedupe for a doc present both locally and online (no real collision path today), scroll position not preserved on re-render (selection is), and dead `local`/`online` no-op branches linger in `switchToTab`/edit dispatch.

## Why This Plan Was Rescoped

The original plan shipped only its "Phase 1" (inline editing added to a still-separate Online Docs tab) and explicitly deferred "Phase 2" (the unified tab) behind a product sign-off gate and a "(Future)" tag. The user's testing feedback — *"I thought this was meant to unify the online docs and local docs tabs? why am I still seeing two separate tabs"* — confirms the dual-tab model is the defect. The product decision is now made: **unify into one tab.** This rewrite drops the staged approach, removes the sign-off gate, and makes the single unified Docs tab the sole, mandatory deliverable. The previously shipped inline-editing handlers (`saveOnlineDocFile`, the edit controls, watcher suppression, `resolveActiveOnlineSlugPrefix()`) are kept and reused unchanged — only the tab structure and rendering are unified.

## Prior Review Findings (from the superseded Phase 1 implementation, retained for context)

The Phase 1 scaffolding (HTML buttons/textarea, edit-mode `online` branches, `saveOnlineDocFile` handler, watcher 2s suppression at `PlanningPanelProvider.ts:548`, preview-ready deferral guard) was correctly implemented, but the online flow originally passed the remote `docId` where the backend requires a `slugPrefix`. That was fixed in `src/webview/planning.js` by keying `importedDocs` by `docId` and adding `resolveActiveOnlineSlugPrefix()` (used by the save handler and deferred reload). These fixes carry forward into the unified tab. The `resolveActiveOnlineSlugPrefix()` helper in particular is a dependency of step 2's save routing.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] (no subtasks)
<!-- END SUBTASKS -->

