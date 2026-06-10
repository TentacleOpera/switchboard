---
description: Workstream E of the planning.html overhaul — createDocument adapters for ClickUp/Linear/Notion, per-source + New buttons (B4), Local Docs Sync button (A5), and the Sync-to-Online modal with persistent mappings
---

# Plan: planning.html Overhaul — Workstream E (Sync to Online + createDocument adapters)

> Child plan split from `planning-html-one-shot-overhaul.md` (release blocker). Run as its own agent session.
> **Execution order:** parent phase 5 — **run last**, after all other workstreams, so everything else ships even if API work needs iteration. This plan absorbs **B4** (per-source `+ New` button) and **A5** (Local Docs "Sync to Online" button) from Workstreams B and A, because the parent plan specifies the `createDocument` adapter interface is "implement once, consume twice" and schedules B4 + E together.

## Resolved Decisions (user-confirmed 2026-06-10)
- **Online doc creation location:** default to the source's currently filtered space/container. Additionally, the user can set a persistent per-source **upload location** once (most users have a central docs location) — no modal appears on every create. A picker is shown only when no upload location is set, or when the user explicitly changes it. Stored in `.switchboard/planning-sync-config.json`.
- **Sync-to-Online re-sync:** YES — remember the local→remote mapping in `.switchboard/planning-sync-config.json` so a person can keep working on an uploaded document; subsequent syncs update the same remote doc via `updateContent()` rather than creating duplicates.

## Goal
Add the one new backend capability of the overhaul — `createDocument` on the three online adapters — and the two UI surfaces that consume it: a per-source `+ New` button on the Online Docs tab, and a "Sync to Online" flow (button + modal) from the Local Docs tab, with persistent upload locations and local→remote re-sync mappings.

**Files touched:** `src/webview/planning.html`, `src/webview/planning.js`, `src/services/PlanningPanelProvider.ts`, `src/services/ClickUpDocsAdapter.ts`, `src/services/LinearDocsAdapter.ts`, `src/services/NotionFetchService.ts` / `NotionBrowseService.ts`, `src/services/ResearchImportService.ts` (adapter interface).

## Metadata
- **Tags:** frontend, backend, feature, release-blocker
- **Complexity:** 6

## Proposed Changes

### E0 (= B4 backend). `createDocument` adapter capability
- Extend `ResearchSourceAdapter` (ResearchImportService.ts:28-41) with optional `createDocument?(params: { parentId?: string; title: string; content?: string }): Promise<{ success: boolean; docId?: string; url?: string; error?: string }>`.
- **ClickUp** (ClickUpDocsAdapter.ts): `POST /v3/workspaces/{workspaceId}/docs` then `POST .../docs/{docId}/pages` with markdown content.
- **Linear** (LinearDocsAdapter.ts): GraphQL `documentCreate` mutation (`title`, `content` markdown, `projectId`).
- **Notion**: `POST /v1/pages` with a parent page/database id; convert markdown to paragraph blocks chunked ≤2000 chars (same constraint already handled in `updatePageContent`, NotionFetchService.ts:559).

### B4 (absorbed from Workstream B). Per-source "create document" button
- Add a `+ New` button to each `source-header-row` (planning.js:2291-2366).
- **Upload location resolution (in order):** (1) the source's currently selected container filter if set; (2) the per-source persistent upload location from `.switchboard/planning-sync-config.json`; (3) only if neither exists, show a one-time location picker whose choice is saved as the upload location. Add a small "Set upload location" affordance (gear/edit icon next to `+ New`, or an entry in the source header row) so the user can set/change it explicitly once and never see a picker again.
- Flow: `+ New` → resolve parent per the order above → input box for title → on success refresh that source's nodes and select the new doc.

### A5 (absorbed from Workstream A). "Sync to Online" button
- Add to `controls-strip-local` (planning.html:3047-3059), placed after Edit. Enabled only when a local doc is selected AND at least one online source is configured (consume the configured-source state field set by `onlineDocsReady` — established by Workstream B's B1). Opens the E2 modal.

### E1. Backend sync handler
The `createDocument` adapter methods from E0 are the engine. Add provider handler `syncDocToOnline { sourceId, parentId, docId, mode: 'create'|'update' }`: read the local file → `createDocument` (or `updateContent` when mode='update', already implemented for ClickUp docs at ClickUpDocsAdapter.ts:907 and Notion at NotionFetchService.ts:559; Linear via `LinearDocsAdapter.updateContent`, line 309) → store the local→remote mapping in `.switchboard/planning-sync-config.json` → post result with the remote URL. The mapping is load-bearing (user-confirmed): a person who keeps working on an uploaded document re-syncs and the same remote doc updates — no duplicates.

### E2. Modal
Reuse the existing `.folder-modal` pattern (markup planning.html:3443-3500, CSS 2582-2960 — the only surviving modal pattern after the webview-modal removal). New `#sync-online-modal`:
1. **Fast path first:** if the doc already has a remote mapping, the modal opens on a one-click "Update '<remote doc>' on <source>" confirm (with a secondary "Sync somewhere else…" link into the full flow). If no mapping but a per-source upload location is set (shared with B4), prefill source + location so sync is one click.
2. **Source step** (full flow only): radio list of configured sources (from the same configured-source set as B1).
3. **Location step:** cascading tree/dropdown driven by existing listing methods — `ClickUpDocsAdapter.fetchChildren` (line 138: workspace→space→folder→list), `LinearDocsAdapter.fetchChildren` (line 71: teams→projects), Notion via `NotionBrowseService.searchPages`/`searchDatabases` (lines 47, 90) with a search input for parent page selection. Offer "remember as upload location" checkbox.
4. **Confirm step:** doc name (prefilled from local filename), Sync button with in-modal progress/status and the resulting remote link on success.

## Complexity Audit

### Routine
- A5 button placement and enable logic (one state field, one button).

### Complex / Risky
- **E0 `createDocument` adapters** — three new API integrations (ClickUp v3 doc+page creation, Linear GraphQL mutation, Notion page creation with markdown→block conversion). Each needs auth, error handling, and rate-limit awareness. Largest single chunk of work; Notion block conversion is the fiddliest.
- **Upload-location persistence** — `.switchboard/planning-sync-config.json` gains two new shapes (per-source upload location, local→remote doc mappings); writes must merge with the existing `browseFilterContainers` content via `_resolveSyncConfig`, not clobber it.

## Edge-Case & Dependency Audit
- **Security:** user-supplied doc titles must be HTML-escaped before rendering (existing `escapeHtml`, planning.js:220-227). Never log API tokens; tokens stay in `SecretStorage` (`switchboard.{clickup,linear,notion}.apiToken`).
- **Shared interface:** E1 and B4 share the `createDocument` adapter interface — implement once, consume twice.
- **Configured-source state:** A5 enable logic, B4 `+ New` visibility, and the E2 modal source list all derive from the one webview state field set by `onlineDocsReady` (Workstream B's B1) — do not fork per-feature copies.

## Dependencies
- **Workstream B (B1)** must land first: it provides the configured-source state field this plan consumes for A5/B4/modal.
- Soft: run after all other workstreams (parent phase 5).

## Verification
- `npm run compile` clean; run existing test suites (planning-modal-contract, planning-aggregate-cache).
- Manual checklist in the Extension Development Host:
  - [ ] `+ New` on each configured source header creates a remote doc in the filtered space / saved upload location **without a picker**; the source's nodes refresh and the new doc is selected.
  - [ ] With no filter and no saved location: one-time picker appears, choice is persisted, never shown again; "Set upload location" affordance can change it.
  - [ ] "Sync to Online" button in Local Docs is enabled only with a doc selected and ≥1 source configured; opens the modal.
  - [ ] First sync via modal: source → location (with "remember" checkbox) → confirm → in-modal progress → remote link on success; mapping saved.
  - [ ] Second sync of the same doc: one-click "Update '<remote doc>' on <source>" — updates the same remote doc, **no duplicate created**; "Sync somewhere else…" enters the full flow.
  - [ ] `.switchboard/planning-sync-config.json` merges new shapes with existing `browseFilterContainers` content (no clobbering).
  - [ ] No API tokens in logs; create/update verified against ClickUp, Linear, and Notion individually.

## Review Findings

All core requirements implemented: `createDocument` adapters for ClickUp/Linear/Notion, per-source `+ New` buttons with upload-location resolution, "Sync to Online" button with modal fast path, and persistent doc mappings. `npm run compile` clean.

**Fixes applied during review:**
- `planning.js`: fast-path text now uses display names ("ClickUp" not "clickup").
- `planning.js`: when multiple sources have saved upload locations, modal now shows source-selection step instead of arbitrarily picking the first.
- `planning.js` + `planning.html`: confirm step now displays the selected source and target location so users know where the doc will sync.
- `NotionFetchService.ts`: `updatePageContent` now chunks content into multiple ≤2000 char paragraph blocks (same as `createPage`), fixing a **data-loss bug** where re-syncs truncated everything after 2000 characters.

**Remaining risks:**
- `onlineDocCreated` handler has an 800ms race between `refreshSource` and `loadDocumentPreview`.
