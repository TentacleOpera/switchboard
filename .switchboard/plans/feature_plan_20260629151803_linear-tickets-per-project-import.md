# Linear Tickets Tab: Picker-Driven Per-Project Import (parity with ClickUp)

## Goal

Make the **Tickets tab Linear project picker behave like the ClickUp list picker**: selecting a project imports **that project's issues as local files** (parents + open), the sidebar shows **only that project**, and **all** of the project's issues are fetched (not capped at 100). Today the Linear picker is a cosmetic client-side filter that drives no fetch, so Linear in the Tickets tab is effectively broken for real use.

### Problem (verified in code, 2026-06-29)

1. **The picker drives nothing.** The Linear project `<select>` change handler (`src/webview/planning.js:7510`) only does `linearProjectPickerValue = e.target.value; renderTicketsLinearList(); saveTicketsState();`. It sends **no** import/fetch message. `getFilteredLinearIssues()` then filters the already-loaded list by `issue.project.name === linearProjectPickerValue` — a **client-side name filter only**.

2. **The fetch ignores the picker.** `LinearSyncService.queryIssues({ projectId })` (`src/services/LinearSyncService.ts:716`) **does not use `options.projectId`** to build the GraphQL filter. It builds the filter from `_resolveSingleIncludeProjectId(config)` (`:758`) — i.e. the integration config's `includeProjectNames`, and **only** when there is exactly one include and no excludes (`:638`). Otherwise it fetches the **whole team** and filters client-side. `options.projectId` is used only in the **cache key** (`:740`), never as a real filter.

3. **Hard 100-issue cap.** `queryIssues` clamps `limit = Math.min(requestedLimit, 100)` (`:728`) and loops `while (issues.length < limit ...)` (`:767`). The Linear import (`TaskViewerProvider.importAllTasks` Linear fast path, `:18765`) passes `limit: 100`. So a project/team with >100 issues only ever imports the first 100.

**Consequence:** changing the dropdown imports nothing new; the imported file set is whatever the *config* fetches (≤100); and per-project sidebar scoping (already built for ClickUp in the preceding plan) is **disabled for Linear** because the import isn't per-project and the picker is name-based while the file frontmatter records a project *id*.

### Root Cause

The Linear integration's fetch path was built for the **kanban-sync** use case: "sync a curated set of project *names* (include/exclude) from a team." The Tickets tab — whose UI is shaped around ClickUp's *navigate-to-one-container-then-fetch* model — reused that config-driven, team-scoped fetch and bolted a **name-based picker** on top purely to narrow the *view*. Nobody wired the picker to re-fetch, because the fetch unit was already the team+config, not a single project. The result is a ClickUp-shaped UI sitting on Linear's team/config-shaped data model. There's even a legacy migration confirming the shift: single `projectId` → `includeProjectNames[]` (`LinearSyncService.ts:255-261`).

### Background (anchors for the implementer)

- **`LinearConfig`**: `{ teamId, teamName, includeProjectNames?[], excludeProjectNames?[], excludeBacklog?, selectedProjectName }`. `selectedProjectName` is literally commented *"Persisted project picker value for sidebar filter."* Keep persisting it.
- **`getAvailableProjects(): {id,name}[]`** (`LinearSyncService.ts:548`) — use for name→id resolution. `_resolveSingleIncludeProjectId` (`:635`) already uses it.
- **`queryIssues` callers** — the new behavior MUST be opt-in so these are unaffected:
  - `PlanningPanelProvider.ts:4105` (`linearLoadProject`, the sidebar browse load) — passes **no** `projectId`, `limit: 100`. Must stay as-is (this powers the browse list + client-side picker filter).
  - `TaskViewerProvider.ts:18765` (import fast path) — **the one to change**.
  - `TaskViewerProvider.ts:5925` (`limit: 50`), `:18920`, `:8657`, `:4896` (generic passthrough), `LinearSyncService.ts:1637` (`search`) — leave behavior unchanged.
- **ClickUp flow this mirrors** (already implemented in the preceding plan): list-select → `clickupProjectLoaded` → `refreshTicketsDelta {listId}` → `importAllTasks` full import + **prune** + sidebar **scope by frontmatter `listId`**.
- **Sidebar scoping** lives in `PlanningPanelProvider.listLocalTicketFiles` (`:5076`). It currently scopes ClickUp by frontmatter `listId` and **forces Linear unscoped** (`scopeId = ''`). The Linear ticket-file frontmatter already records `status`, `statusType`, `projectId` (= `issue.project.id`), `parentId` (written by `_buildLinearImportPlanContent`).
- **Import filter + cleanup prune** already apply to Linear in `importAllTasks` (parents via `!parentId`; open via `state.type` not `completed`/`canceled`; prune gated on `rawItemCount > 0`). This plan must keep the prune safe under per-project fetch.

## Metadata
- **Tags**: bugfix, feature, backend, api, ui, ux, linear
- **Complexity**: 6/10

## User Review Required
None. Behavior is fully specified: the Linear picker should drive a per-project import with full pagination and per-project sidebar scoping, mirroring ClickUp. The only judgment call (scope key) is decided below: **scope Linear by project name** (the picker is name-based), accepting the rare same-name-within-a-team collision and noting it.

## Proposed Changes

### Step 1 — `queryIssues`: honor an explicit project + full pagination (OPT-IN)
**`src/services/LinearSyncService.ts`** (`queryIssues` `:697`, `buildLinearIssueFilter` `:87`)
- Add an opt-in option `projectScoped?: boolean`. Reuse the existing `projectId` option as the **picker value** (a project *name* or an id).
- When `projectScoped` is true:
  - **Resolve the project**: if `projectId` matches a `getAvailableProjects()` id, use it; else treat it as a name and look up the id (case-insensitive). If resolution **fails**, return `[]` and set a resolution-failed signal (see Step 6) — do **not** silently fall back to a team-wide fetch (that would make the Step-6 prune dangerous).
  - **Filter on that project id** via `buildLinearIssueFilter(teamId, resolvedId, updatedAfter)`, overriding the config-based `_resolveSingleIncludeProjectId`.
  - **Paginate fully**: loop until `pageInfo.hasNextPage` is false / cursor is null, ignoring the 100 cap. Keep a sane `maxPages` (e.g. 40 ≈ 2000 issues at 50/page) with the existing logged warning if exceeded. Keep the 200ms inter-page delay.
  - Skip `_applyProjectNameFilters` (`:818`) for project-scoped queries — the server filter already scopes; the client name-filter is redundant and would re-introduce name matching.
- When `projectScoped` is falsy: **unchanged** (sidebar load + all other callers keep current behavior; `projectId` keeps only affecting the cache key).

### Step 2 — Linear import uses the picker's project + full fetch
**`src/services/TaskViewerProvider.ts`** (`importAllTasks` Linear fast path `:18751`–`:18768`)
- Call `queryIssues({ projectId: <picker value>, projectScoped: true, ...(deltaSinceIso ? { updatedAfter: deltaSinceIso } : {}) })`. Remove the `limit: 100` cap for this path (full fetch).
- Derive `targetDir`/segments from the **resolved project** (the fetched issues' `project.name`, which now all belong to the picked project) rather than `items[0]` ambiguously — for a project-scoped fetch they're the same project, so `items[0]?.project?.name` is now correct, but assert/guard for the empty-result case.

### Step 3 — Record the project name in the ticket file (scope key)
**`src/services/TaskViewerProvider.ts`** (`_buildLinearImportPlanContent` frontmatter — already emits `status`/`statusType`/`projectId`/`parentId`)
- Add `projectName: <issue.project.name>` to the frontmatter (keep `projectId` too). This is the key the name-based picker scopes against.

### Step 4 — Scope the Linear sidebar to the selected project
**`src/services/PlanningPanelProvider.ts`** (`listLocalTicketFiles` scope block, currently `scopeId = provider === 'clickup' ? msg.listId : ''`)
- For Linear: `scopeId = String(msg.projectId || '').trim()` (the picker **name**), and read the file's frontmatter `projectName` as `fileScopeId` (the per-provider regex already branches — change the Linear branch from `projectId:` to `projectName:`).
- Apply the same strict rule already used for ClickUp: `if (scopeId && fileScopeId !== scopeId) continue;`. Remove the Linear "unscoped" special-case.

### Step 5 — Picker change drives the import
**`src/webview/planning.js`** (project picker `change` handler `:7510`)
- On change: set `linearProjectPickerValue`, then `vscode.postMessage({ type: 'refreshTicketsDelta', provider: 'linear', projectId: linearProjectPickerValue, workspaceRoot: ticketsWorkspaceRoot })` and `loadLocalTicketFiles()` — mirroring the ClickUp list-select flow. This triggers the full per-project import + prune + scoped listing.
- Keep `renderTicketsLinearList()`/`saveTicketsState()`.
- Confirm the initial `linearProjectLoaded` path (`:4922`) and the Refresh button (`:7537`) already send `refreshTicketsDelta` with the project — keep them consistent (they pass `projectId: linearProjectPickerValue`).

### Step 6 — Prune safety under per-project fetch (CRITICAL)
**`src/services/TaskViewerProvider.ts`** (`importAllTasks` prune block, gated on `rawItemCount > 0`)
- The prune deletes files in the project's `targetDir` not in `keepIds`. This is only safe if the fetch genuinely returned that project's issues.
- Add a guard: **only prune Linear when the project resolution succeeded** (Step 1). If `queryIssues` returned `[]` because resolution failed (name not found / API error), `rawItemCount` is 0 → prune already skipped — but make this explicit so a future change can't accidentally fetch team-wide and prune a single project's dir. Never delete another project's files; never delete on a failed/empty fetch.

## Edge-Case & Dependency Audit
- **Name→id resolution failure**: return `[]` + skip prune (Step 1/6). Surface the existing "Refresh failed" path if appropriate; do not destroy files.
- **Same project name within a team** (rare): name-based scoping would merge them. Note it. A future hardening: have the webview resolve name→id from already-loaded `linearProjectIssues` (each has `project.id` + `project.name`) and scope by id; deferred to avoid empty-sidebar risk when issues aren't loaded yet.
- **Large project pagination**: full fetch is the agreed one-time initial-load cost (paged 50, 200ms delay, `maxPages` cap with warning). Deltas thereafter via the existing `updatedAfter` filter.
- **Sidebar browse vs import**: `linearLoadProject` (`:4105`, `limit 100`, no `projectId`) is unchanged and separate. Since the sidebar is now file-backed, the visible list = imported files for the selected project; the browse fetch is only the source for the picker's option list and hierarchy. Verify the two don't fight (the file-backed `localTicketFilesListed` overwrites `linearProjectIssues`).
- **Migration / shipped state (~4000 installs)**: `queryIssues`/`LinearConfig` are shipped. New `projectScoped` option is additive and opt-in — existing fetch behavior is byte-for-byte unchanged for every current caller. New frontmatter key `projectName` is additive. No data migration; no `*.migrated.bak`.
- **`window.confirm` / dialogs**: none introduced. Deletes remain immediate.

## Dependencies
- **Builds on the preceding (uncommitted) Tickets-tab work** in this session: progressive import filter (parents + open), cleanup prune, ClickUp per-list frontmatter scoping, status-filter→includeClosed, subtasks-on-open, and the `loadLocalTicketFiles` workspace-root-guard fix. This plan should land **after** those are committed.
- Touches `LinearSyncService.ts`, `TaskViewerProvider.ts`, `PlanningPanelProvider.ts`, `planning.js`. No overlap with non-tickets work.

## Verification Plan

### Manual (the Linear failure modes)
1. Select a Linear project with **>100** issues → **all** its open parent issues import as files (not capped at 100). Confirm file count matches the project's open-parent count.
2. Sidebar shows **only** that project; switching to another project re-imports it and re-scopes (no cross-project bleed).
3. Sub-issues excluded (`parentId`); completed/canceled excluded unless a closed state is chosen via the state filter.
4. **Prune safety**: switching projects prunes only the *previous*/current project's dir as appropriate; a project whose name fails to resolve imports nothing and deletes nothing; an empty/erroring fetch deletes nothing.
5. Locally-modified Linear files are preserved across re-import (existing `modified` guard).

### Regression
6. **ClickUp unaffected**: list-select still imports + prunes + scopes (the `queryIssues` change is opt-in; no ClickUp code path touched).
7. Linear **browse** (sidebar) still lists the selected project's files; search/state filters still work client-side.

> **Session directives:** No compilation step is run as part of verification (project assumed pre-compiled; `src/` is source of truth, `dist/` irrelevant). No automated tests run here — `node -c src/webview/planning.js` for webview syntax and `npx tsc --noEmit --skipLibCheck` on the changed `.ts` files (ignoring pre-existing `downlevelIteration` noise) are the static checks.

**Recommendation**: Complexity 6/10 → Lead Coder. Cross-file change on a shipped provider with pagination, name resolution, and file-deletion (prune) safety requirements.
