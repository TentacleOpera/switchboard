---
description: One-shot overhaul of planning.html — local docs, online docs, kanban plans, tickets, and design system tabs plus cross-tab search and local→online sync
---

# Plan: planning.html One-Shot Overhaul (Release Blocker)

## Goal
Fix every outstanding UX/behaviour problem across the planning panel's five content tabs in a single coordinated pass so the extension upgrade can ship. The work decomposes into seven workstreams: (A) Local Docs, (B) Online Docs, (C) Kanban Plans, (D) Tickets, (E) Sync-to-Online flow, (F) universal sidebar search, (G) Design System. Workstreams A–D and G are webview-only (planning.html / planning.js); E and the create-doc half of B add one new backend capability (`createDocument`) to the three online adapters.

**Files touched:** `src/webview/planning.html` (~3548 lines), `src/webview/planning.js` (~6745 lines), `src/services/PlanningPanelProvider.ts` (~5054 lines), `src/services/ClickUpDocsAdapter.ts`, `src/services/LinearDocsAdapter.ts`, `src/services/NotionFetchService.ts` / `NotionBrowseService.ts`, `src/services/ResearchImportService.ts` (adapter interface).

## Metadata
- **Tags:** frontend, ui, ux, feature, refactor, backend, release-blocker
- **Complexity:** 8

## Resolved Decisions (user-confirmed 2026-06-10)
- **Online doc creation location:** default to the source's currently filtered space/container. Additionally, the user can set a persistent per-source **upload location** once (most users have a central docs location) — no modal appears on every create. A picker is shown only when no upload location is set, or when the user explicitly changes it. Stored in `.switchboard/planning-sync-config.json`.
- **Sync-to-Online re-sync:** YES — remember the local→remote mapping in `.switchboard/planning-sync-config.json` so a person can keep working on an uploaded document; subsequent syncs update the same remote doc via `updateContent()` rather than creating duplicates.
- **Design tab config key:** keep writing `planner.designSystemDocLink`. The similarly named `planner.designDocLink` is the legacy key that the active *planning context* maps to — it came first and was never migrated to avoid risk. Label/status text change only; do NOT touch the config keys or attempt a migration.
- **Tickets banner:** delete the teal banner entirely — do NOT relocate its buttons to a meta strip. The sidebar card buttons are sufficient (and some may be removed later). Banner buttons (Import / Refine / Ask Agent / Back-to-Parent) are deleted with it; Ask Agent is added per-card (D2), and Refine/Import already exist on cards. Back-to-Parent navigation is dropped.

## Proposed Changes

### Workstream A — Local Docs tab

**A1. Folder link buttons in sidebar.** Folders currently have only an Import button (`folder-import-btn`, planning.js:2120-2144); docs have a link mechanism but folders don't. Add a small `Link` button to every source-folder header (planning.js:2110-2145) and nested subfolder header (planning.js:2169-2182). Click posts a new message `linkToFolder { folderPath }`; new provider handler validates the path exists and copies the absolute folder path to the clipboard with a status confirmation (reuse the path-resolution logic from `_handleLinkToDocument`, PlanningPanelProvider.ts:2805-2868). This is the mechanism for directing agents to specific folders.

**A2. Copy button → "Link", no emoji.** planning.js:1074-1075 renders `'<span>🔗</span><span class="btn-label">Copy</span>'`. Change to `'<span class="btn-label">Link</span>'`. No handler change (it already posts `linkToDocument`).

**A3. Sidebar collapse must actually collapse.** The collapsed CSS (planning.html:382-428) currently keeps tree-node icons visible at 16px in a 40px rail, so plan files still show. Change the collapsed state so the doc list (`#doc-list` content, all tree-nodes, subheaders, import buttons) is `display:none` entirely; only the `.sidebar-toggle-row` with the `»` button remains in the 40px rail. Applies to all tabs sharing `applySidebarState` (local, research, online — planning.js:336-364).

**A4. Create new document.** No create flow exists today (confirmed: no `createDoc`-style message in planning.js or the provider switch). Add:
- A `+` create icon button on each source-folder header AND each subfolder header, next to Import/Link.
- New message `createLocalDoc { folderPath }`. Provider handler: `vscode.window.showInputBox` for the doc name → sanitize (strip path separators, enforce `.md`, reject collisions with an error message) → write a `# <Title>` stub → `_sendLocalDocsReady()` → post a message instructing the webview to select and preview the new doc.

**A5. "Sync to Online" button** in `controls-strip-local` (planning.html:3047-3059), placed after Edit. Enabled only when a local doc is selected AND at least one online source is configured. Opens the Workstream E modal.

**A6. Search bar** — see Workstream F.

### Workstream B — Online Docs tab

**B1. Fix ugly load-in.** Two changes:
- `_sendOnlineDocsReady` (PlanningPanelProvider.ts:3348-3371) hardcodes `enabledSources: { clickup: true, linear: true, notion: true }`. Change it to derive from `getAvailableSources()` so the webview only ever renders sources that are actually configured.
- Replace the static placeholder ("Loading online docs...", planning.html:3109) with a proper loading skeleton: 3–4 shimmer placeholder rows using a new `.sidebar-skeleton` style (subtle animated gradient, matches theme). When `onlineDocsReady` arrives with zero configured sources, render a clean empty state: "No online sources connected — configure ClickUp, Linear or Notion in Setup." Never render named service headers before the ready message confirms them.

**B2. Remove "Set as active planning context" and "Link to Document".** Delete `#btn-append-to-prompts-online` and `#btn-link-to-doc-online` (planning.html:3101-3102), their handlers (planning.js:4258-4290), and any enable/disable state management referencing them. The strip keeps only Import (+ the new search and per-source create from B3/F).

**B3. Import lands the user in Local Docs with the doc open.** Extend `_handleImportFullDoc` (PlanningPanelProvider.ts:4225-4305) so `importFullDocResult` includes the imported doc's local node id / file path (it writes to `.switchboard/docs/{docName}.md` via `writeContentToDocsDir`). In the webview handler (planning.js:3653-3693), on success: call `switchToTab('local')`, then select the imported doc in the local tree and fetch its preview (`fetchPreview` with `sourceId: 'local-folder'`). Sequencing: `_sendLocalDocsReady()` already fires before `importFullDocResult` in the provider, so the node exists in the webview when the result arrives — but guard with a retry-on-next-`localDocsReady` fallback in case of races.

**B4. Per-source "create document" button.** Add a `+ New` button to each `source-header-row` (planning.js:2291-2366). Requires the new backend capability (shared with Workstream E):
- Extend `ResearchSourceAdapter` (ResearchImportService.ts:28-41) with optional `createDocument?(params: { parentId?: string; title: string; content?: string }): Promise<{ success: boolean; docId?: string; url?: string; error?: string }>`.
- **ClickUp** (ClickUpDocsAdapter.ts): `POST /v3/workspaces/{workspaceId}/docs` then `POST .../docs/{docId}/pages` with markdown content.
- **Linear** (LinearDocsAdapter.ts): GraphQL `documentCreate` mutation (`title`, `content` markdown, `projectId`).
- **Notion**: `POST /v1/pages` with a parent page/database id; convert markdown to paragraph blocks chunked ≤2000 chars (same constraint already handled in `updatePageContent`, NotionFetchService.ts:559).
- **Upload location resolution (in order):** (1) the source's currently selected container filter if set; (2) the per-source persistent upload location from `.switchboard/planning-sync-config.json`; (3) only if neither exists, show a one-time location picker whose choice is saved as the upload location. Add a small "Set upload location" affordance (gear/edit icon next to `+ New`, or an entry in the source header row) so the user can set/change it explicitly once and never see a picker again.
- Flow: `+ New` → resolve parent per the order above → input box for title → on success refresh that source's nodes and select the new doc.

**B5. Search bar** — see Workstream F.

### Workstream C — Kanban Plans tab

**C1. All/Epics → single toggle.** Remove `#kanban-view-all` (planning.html:3233). Make `#kanban-view-epics` a toggle: click flips `_kanbanViewMode` between `'all'` and `'epics'`, toggles its own `.active` class, re-renders (`renderKanbanPlans`, filter at planning.js:4640-4642). Delete `updateKanbanViewButtons` two-button logic (planning.js:4443-4464).

**C2. Remove Refresh button.** Delete `#kanban-refresh-btn` (planning.html:3236, CSS 1967-1974, handler planning.js:5274-5278). Safe: the file watcher in `_setupKanbanPlansWatcher` (PlanningPanelProvider.ts:590-635) already auto-refreshes on any `.switchboard/plans/**/*.md` change with 800ms debounce, and `switchToTab('kanban')` fetches on entry.

**C3. Remove panel-wide Log button.** Delete `#btn-kanban-log` (planning.html:3238) and its enable-state code (planning.js:5202-5205). The doc-scoped Log button in the preview meta bar stays (planning.js:4914, handler 4976-4984).

**C4. Move Review into the doc-preview meta bar.** Remove `#btn-review-kanban` from the panel strip (planning.html:3240). Render it inside `renderKanbanMetaBar(plan)` (planning.js:~4914) alongside Column/Complexity/Log/Delete. Rewiring care: `enterReviewMode`/`exitReviewMode` (planning.js:4475-4504) mutate the button's text ("REVIEW" ↔ "EXIT REVIEW") and hide Edit — since the meta bar re-renders on every plan selection, the button's label/state must be derived from `state.reviewMode.kanban` at render time, and switching plans while in review mode must call `exitReviewMode('kanban', true)` first (extend the cleanup already done in `switchToTab`, planning.js:389-430).

### Workstream D — Tickets tab

**D1. Remove the teal banner entirely — no relocation.** Delete `#active-doc-banner-tickets` and everything inside it (planning.html:3402-3417): the "Active Ticket" label/name, `#tickets-detail-meta` (status/assignee), and all four banner buttons (`#tickets-detail-import`, `#tickets-detail-refine`, `#tickets-detail-ask-agent`, `#tickets-back-to-parent`). The sidebar card buttons cover these actions. Remove every JS reference to the deleted elements so nothing throws on a null `getElementById` — known sites: `detailAskAgentButton` enable logic (planning.js:6133), the banner button click handlers, the status/assignee meta population, and the Back-to-Parent visibility logic (Back-to-Parent navigation is intentionally dropped per user decision). Also delete the now-unused `.tickets-banner-actions` and `.tickets-detail-meta` CSS (planning.html:579-587).

**D2. Ask Agent on every sidebar ticket card.** In the card template (planning.js:6017-6025), add an `ASK AGENT` button next to REFINE/IMPORT, posting the same message the (now-deleted) banner Ask Agent button sent, parameterised by `data-linear-issue-id`. With the banner gone, the cards are the only home for this action.

**D3. Unify sidebar card button styling.** `.tickets-issue-import-btn` is a bespoke class. Restyle ticket card actions to the shared card action classes used by other tabs (`card-icon-btn` family / `.tree-node .card-actions` pattern, planning.html:1924-1929) so size, font, border and hover match kanban/local cards exactly. Keep `.ticket-node`'s column layout but align padding/margins to `.tree-node` values where they differ.

**D4. Fix duplicated grid + add glass overlay.** Root cause found: `#markdown-preview-tickets` receives the grid background from BOTH the primary rule (planning.html:2294-2306, applied to its parent `#preview-pane-tickets`) and the duplicate rule (planning.html:2308-2318) — two stacked 40px grids. Fix: remove `#markdown-preview-tickets` from the 2308-2318 rule. Glass overlay: other tabs place a `.cyber-scanlines` overlay div inside `.preview-panel-wrapper` (e.g. online tab, planning.html:3131); verify the tickets preview wrapper has the same structure and add `.cyber-scanlines` if absent, so the glass treatment matches every other tab.

**D5. Proper loading state in the preview.** While tickets load, the preview area is bare. Add a centered spinner + "Loading tickets…" state mirroring the HTML tab's loader (planning.html:3348-3350, `spin` animation), shown whenever `linearProjectStatus === 'loading'` (planning.js:5980-5987), and skeleton rows in the sidebar instead of plain text.

**D6. Fix the font.** Two offenders: (a) conflicting `#markdown-preview-tickets` font rules at planning.html:1151-1158 — delete both tickets-specific declarations and let the tickets preview inherit exactly the same rules as `#markdown-preview` (the local docs preview) so every theme renders identically; (b) `.tickets-issue-meta` hardcodes `var(--font-mono)` (planning.html:2746) — change card metadata to `var(--font-family)` to match other tabs' card subtitles. Audit the tickets CSS block (planning.html:2696-2770) for any other `font-family` overrides and remove them.

### Workstream E — Local → Online "Sync to Online" flow

**E1. Backend:** the `createDocument` adapter methods from B4 are the engine. Add provider handler `syncDocToOnline { sourceId, parentId, docId, mode: 'create'|'update' }`: read the local file → `createDocument` (or `updateContent` when mode='update', already implemented for ClickUp docs at ClickUpDocsAdapter.ts:907 and Notion at NotionFetchService.ts:559; Linear via `LinearDocsAdapter.updateContent`, line 309) → store the local→remote mapping in `.switchboard/planning-sync-config.json` → post result with the remote URL. The mapping is load-bearing (user-confirmed): a person who keeps working on an uploaded document re-syncs and the same remote doc updates — no duplicates.

**E2. Modal:** reuse the existing `.folder-modal` pattern (markup planning.html:3443-3500, CSS 2582-2960 — the only surviving modal pattern after the webview-modal removal). New `#sync-online-modal`:
1. **Fast path first:** if the doc already has a remote mapping, the modal opens on a one-click "Update '<remote doc>' on <source>" confirm (with a secondary "Sync somewhere else…" link into the full flow). If no mapping but a per-source upload location is set (shared with B4), prefill source + location so sync is one click.
2. **Source step** (full flow only): radio list of configured sources (from the same configured-source set as B1).
3. **Location step:** cascading tree/dropdown driven by existing listing methods — `ClickUpDocsAdapter.fetchChildren` (line 138: workspace→space→folder→list), `LinearDocsAdapter.fetchChildren` (line 71: teams→projects), Notion via `NotionBrowseService.searchPages`/`searchDatabases` (lines 47, 90) with a search input for parent page selection. Offer "remember as upload location" checkbox.
4. **Confirm step:** doc name (prefilled from local filename), Sync button with in-modal progress/status and the resulting remote link on success.

### Workstream F — Search bars in every tab

Replicate the kanban search pattern (input planning.html:3231; debounced handler planning.js:5263-5271; filter logic 4629-4633) as a shared helper in planning.js: `wireSidebarSearch(inputId, getItems, render)` — 200ms debounce, case-insensitive substring match on title. Add a search input to the controls strip of:
- **Local Docs** — filters tree nodes by title; folder/type subheaders with zero visible children are hidden.
- **Online Docs** — filters the loaded doc nodes per source (client-side, no refetch).
- **HTML Previews** — input in `#tree-pane-html` region (sidebar populated via `_sendHtmlDocsReady`, PlanningPanelProvider.ts:3193-3270).
- **Tickets** — filters ticket cards on title/identifier/assignee (extend the existing `filteredIssues` computation, planning.js:5970-6035).
- **Design System** — same tree filter as Local Docs.
All use one CSS class for consistent sizing (`flex: 1` inside the strip like `#kanban-search`).

### Workstream G — Design System tab

**G1. Distinct subheader hierarchy.** Both subfolder headers (planning.js:1975-1978) and file-type group headers (planning.js:1985-1988) use `.folder-subheader` (planning.html:846-859) — visually identical, hence confusing. Add a new `.type-subheader` class for the type groups: smaller (9px), lighter colour, indented 16px, no top margin — clearly subordinate to the folder header above it. Source-folder headers keep `.source-folder-header` (teal, 861-871).

**G2. Filename display.** In the design tab's card render path (`renderDocCard`, planning.js:1025-1063, which already supports `subtitle`): pass `title` = basename without extension (`design` not `design.md`) and `subtitle` = human filetype label in grey — reuse `TYPE_LABELS` (planning.js:1631-1637: Markdown/YAML/JSON) and map image extensions to their format name (`PNG`, `SVG`, …). `.card-subtitle` styling (planning.html:1917-1923) already renders grey/10px — no CSS change needed.

**G3. De-duplicate the top function bar** (planning.html:3269-3280):
- Remove `#btn-manage-design-folders` (line 3278) — the sidebar's dynamically rendered Manage Folders button (planning.js:1875-1886) stays.
- Remove the duplicated doc title and link button from the top bar/title area — doc identity lives in the new meta strip (G5).

**G4. "Set as Active Planning Context" → "Set as Active Design Doc".** Relabel `#btn-set-active-context-design` (planning.html:3273) and its status text ("Setting as active design doc…", planning.js:5509-5529). The backend already does the right thing for `design-folder` sources (writes `planner.designSystemDocLink`, PlanningPanelProvider.ts:2774-2782) — confirmed label-only change. Do NOT touch `planner.designDocLink` (the legacy active-planning-context key) and do not migrate config keys.

**G5. Doc-scoped controls into a preview meta strip.** Following the kanban meta-bar pattern, add `#design-preview-meta-bar` at the top of the design preview pane containing: doc title, Set as Active Design Doc, Link, Edit/Save/Cancel. The top function bar retains only the workspace filter and the new search input. Edit/Save/Cancel state machine (existing handlers at planning.js:5554-5568 and the design edit-mode functions) rebinds to the meta-bar buttons; since the meta bar re-renders on selection, derive button states from `state` at render time (same care as C4).

**G6. Card styling parity.** Ensure design cards use the standard `.tree-node` + `.card-text` classes and gradient (planning.html:963-1004) with no design-tab-specific divergence; remove any overrides found during implementation.

## Complexity Audit

### Routine
- A2 label change, C1–C3 button removals, D4 duplicate-rule removal, D6 font consolidation, G3 de-duplication, G4 relabel — all are deletions or one-line edits at known locations.
- A1/A4 folder buttons follow the existing `folder-import-btn` pattern (planning.js:2120-2144).
- B2 button removal — handlers are self-contained event listeners.
- F search bars — direct replication of a proven in-file pattern.
- G1/G2 — CSS class addition + render-call parameter changes; `renderDocCard` already supports subtitles.

### Complex / Risky
- **B4/E1 `createDocument` adapters** — three new API integrations (ClickUp v3 doc+page creation, Linear GraphQL mutation, Notion page creation with markdown→block conversion). Each needs auth, error handling, and rate-limit awareness. Largest single chunk of work; Notion block conversion is the fiddliest.
- **C4/G5 meta-bar button rewiring** — meta bars re-render per selection, so any stateful button (review mode, edit mode) must derive state at render time and clean up on selection change. Past regressions in this area (see `fix-kanban-second-function-bar.md`, `unify-local-docs-set-context-into-strip-toggle.md`) show this is where agents have broken things before.
- **B3 import→local-tab handoff** — depends on message ordering between `_sendLocalDocsReady` and `importFullDocResult`; needs the race guard described.
- **A3 collapse CSS** — `applySidebarState` is shared across three tabs; verify collapse still works per-tab without affecting tabs that lack the toggle.
- **D1 banner removal** — `active-doc-banner-tickets` element ids are referenced in multiple JS code paths (enable/disable, back-to-parent visibility, status/assignee meta); every reference must be deleted (not retargeted — nothing replaces the banner) or the tab silently breaks on null elements.
- **B4/E upload-location persistence** — `.switchboard/planning-sync-config.json` gains two new shapes (per-source upload location, local→remote doc mappings); writes must merge with the existing `browseFilterContainers` content via `_resolveSyncConfig`, not clobber it.

## Edge-Case & Dependency Audit

**Race conditions:**
- B3: import result may arrive before the webview has processed the refreshed `localDocsReady`. Guard: if the node isn't found, stash the pending doc id and select it on the next `localDocsReady`.
- F: search re-render racing the auto-refresh (kanban watcher, tickets polling) — filters live in a state object and every render path must re-apply them (the kanban pattern already does this; replicate, don't fork).

**Security:**
- A4/B4/E: user-supplied doc titles must be HTML-escaped before rendering (existing `escapeHtml`, planning.js:220-227) and sanitized before filesystem writes (A4) — strip `/ \ .. :` from filenames.
- E: never log API tokens; tokens stay in `SecretStorage` (`switchboard.{clickup,linear,notion}.apiToken`).

**Side effects:**
- A4: writing a new doc into a watched folder triggers existing watchers — `_sendLocalDocsReady` will fire twice (handler + watcher); dedupe by content-hash is already in place for imports, but verify no duplicate sidebar entries (see `fix-local-docs-duplicates-and-preview.md`).
- C2: removing Refresh removes the only manual recovery if the watcher dies — acceptable per requirements; tab-entry fetch in `switchToTab` remains a fallback.
- D6: removing `--font-mono` from `.tickets-issue-meta` changes density of state/assignee lines; check truncation still behaves.

**Dependencies & conflicts:**
- E and B4 share the `createDocument` adapter interface — implement once, consume twice.
- B1's configured-source detection feeds A5's button-enable logic, B4's `+ New` visibility, and E's modal source list — derive all from one webview state field set by `onlineDocsReady`.
- `unify-tickets-tab-layout-with-docs-tabs.md` and `tickets-tab-ui-fix.md` are prior attempts at D; their failure mode was patching symptoms (adding rules) instead of removing the conflicting rules — this plan removes the duplicates at planning.html:2308-2318 and 1151-1158 rather than adding more overrides.

## Suggested Execution Order (one shot, commit-per-workstream)
1. **C** (kanban strip cleanup) + **A2/A3** + **D4/D6** + **G1–G4** — all deletions/relabels/CSS fixes; lowest risk, biggest visual payoff.
2. **D1–D3, D5** (tickets banner deletion, card buttons, loading state) and **G5/G6** (design meta strip) — G5 is the only remaining meta-bar pattern work.
3. **A1/A4** (folder link + create doc) and **B1–B3** (online load-in, button removal, import handoff).
4. **F** (search everywhere) — after tab structures have settled so inputs land in final strips.
5. **B4 + E** (createDocument adapters, + New buttons, Sync-to-Online modal) — the only new backend surface, last so everything else ships even if API work needs iteration.

## Verification
- `npm run compile` clean; run existing test suites (planning-modal-contract, planning-aggregate-cache, kanban tests).
- Manual checklist per tab in the Extension Development Host:
  - Local: collapse shows icon-only rail; folder Link copies path; `+` creates and opens a doc; "Link" button has no emoji; Sync to Online opens modal.
  - Online: skeleton → only configured sources render; sole button is Import; import jumps to Local with doc open; `+ New` creates a remote doc in the filtered space / saved upload location without a picker; search filters.
  - Kanban: single Epics toggle; no Refresh/panel Log; Review lives in the meta bar and survives plan switches; auto-refresh works after a plan file edit.
  - Tickets: teal banner gone with no replacement strip and no console errors from removed element refs; Ask Agent / Refine / Import on every card with unified styling; single grid + glass overlay; spinner while loading; font matches Local Docs preview in all themes (check theme-afterburner-updated specifically).
  - Sync to Online: first sync via modal (location saved); second sync of the same doc is a one-click update of the same remote doc.
  - Design: folder vs type subheaders visually distinct; `design` + grey `Markdown` labels; no duplicate Manage Folders/title/link; "Set as Active Design Doc"; doc controls in the preview meta strip.
