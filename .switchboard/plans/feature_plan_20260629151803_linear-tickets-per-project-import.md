# Linear Tickets Tab: Picker-Driven Per-Project Import (parity with ClickUp)

**Plan ID:** 5e3a1f20-3c8d-4e2a-9b1f-7c6d5e4a3b2c

## Goal

Make the **Tickets tab Linear project picker behave like the ClickUp list picker**: selecting a project imports **that project's issues as local files** (parents + open), the sidebar shows **only that project**, and **all** of the project's issues are fetched (not capped at 100). Today the picker fires an import message but `queryIssues` ignores the picker's `projectId` in the GraphQL filter and caps at 100 issues, so Linear in the Tickets tab fetches the whole team (≤100) instead of the selected project.

### Problem (verified in code, 2026-07-02)

1. **The picker IS wired but the fetch ignores it.** The Linear project `<select>` change handler (`src/webview/planning.js:8023-8041`) sets `linearProjectPickerValue`, calls `renderTicketsLinearList()` / `saveTicketsState()`, and **does** send `vscode.postMessage({ type: 'refreshTicketsDelta', provider: 'linear', projectId: linearProjectPickerValue, workspaceRoot: ticketsWorkspaceRoot })` (lines 8033-8040). The import message fires — but the backend's `queryIssues` does not use `projectId` as a real filter (see claim 2), so the fetch returns the whole team, not the picked project.

2. **The fetch ignores the picker.** `LinearSyncService.queryIssues({ projectId })` (`src/services/LinearSyncService.ts:711`) **does not use `options.projectId`** to build the GraphQL filter. It builds the filter from `_resolveSingleIncludeProjectId(config)` (`:761`) — i.e. the integration config's `includeProjectNames`, and **only** when there is exactly one include and no excludes (`:637`). Otherwise it fetches the **whole team** and filters client-side. `options.projectId` is used only in the **cache key** (`:743`), never as a real filter.

3. **Hard 100-issue cap.** `queryIssues` clamps `limit = Math.min(Math.floor(requestedLimit), 100)` (`:731-732`) and loops `while (issues.length < limit ...)` (`:770`). The Linear import (`TaskViewerProvider.importAllTasks` Linear fast path, `:19440`) passes `limit: 100`. So a project/team with >100 issues only ever imports the first 100.

**Consequence:** changing the dropdown fires an import but fetches the whole team (≤100); per-project sidebar scoping (already built for ClickUp in the preceding plan) is **disabled for Linear** because the import isn't per-project and the file frontmatter records a project *id* while the picker is name-based.

### Root Cause

The Linear integration's fetch path was built for the **kanban-sync** use case: "sync a curated set of project *names* (include/exclude) from a team." The Tickets tab — whose UI is shaped around ClickUp's *navigate-to-one-container-then-fetch* model — reused that config-driven, team-scoped fetch. A recent commit wired the picker to send `refreshTicketsDelta` (Step 5 is already done), but the backend `queryIssues` was never updated to honor `projectId` as a real GraphQL filter — it only uses it as a cache key. The result is a ClickUp-shaped UI sending the right message to a Linear backend that ignores it. There's even a legacy migration confirming the shift: single `projectId` → `includeProjectNames[]` (`LinearSyncService.ts:258-274`).

### Background (anchors for the implementer)

- **`LinearConfig`**: `{ teamId, teamName, includeProjectNames?[], excludeProjectNames?[], excludeBacklog?, selectedProjectName }`. `selectedProjectName` is literally commented *"Persisted project picker value for sidebar filter."* Keep persisting it.
- **`getAvailableProjects(): {id,name}[]`** (`LinearSyncService.ts:551`) — use for name→id resolution. `_resolveSingleIncludeProjectId` (`:637`) already uses it.
- **`queryIssues` callers** — the new behavior MUST be opt-in so these are unaffected:
  - `PlanningPanelProvider.ts:4348` (`linearLoadProject`, the sidebar browse load) — passes **no** `projectId`, `limit: 100`. Must stay as-is (this powers the browse list + client-side picker filter).
  - `TaskViewerProvider.ts:19440` (import fast path) — **the one to change**.
  - `TaskViewerProvider.ts:19710` (import pagination) — also needs `projectScoped: true`.
  - `TaskViewerProvider.ts:5089` (`handleLinearQueryIssues`, generic passthrough), `TaskViewerProvider.ts:6131` (`_prefetchLinearProjects`, `limit: 50`), `TaskViewerProvider.ts:8941` (task viewer panel, `limit: 100`), `LinearSyncService.ts:1698` (`resolveIssueIdOrIdentifier` search) — leave behavior unchanged.
- **ClickUp flow this mirrors** (already implemented in the preceding plan): list-select → `clickupProjectLoaded` → `refreshTicketsDelta {listId}` → `importAllTasks` full import + **prune** + sidebar **scope by frontmatter `listId`**.
- **Sidebar scoping** lives in `PlanningPanelProvider.listLocalTicketFiles` (`:5431`). It currently scopes ClickUp by frontmatter `listId` and **forces Linear unscoped** (`scopeId = ''`). The Linear ticket-file frontmatter already records `status`, `statusType`, `projectId` (= `issue.project.id`), `parentId` (written by `_buildLinearImportPlanContent` at `TaskViewerProvider.ts:5250-5262`).
- **Import filter + cleanup prune** already apply to Linear in `importAllTasks` (parents via `!parentId`; open via `state.type` not `completed`/`canceled`; prune gated on `rawItemCount > 0` at `:19449`). This plan must keep the prune safe under per-project fetch.

## Metadata
- **Tags**: bugfix, feature, backend, api, ui, ux
- **Complexity**: 6/10

## User Review Required
None. Behavior is fully specified: the Linear picker should drive a per-project import with full pagination and per-project sidebar scoping, mirroring ClickUp. The only judgment call (scope key) is decided below: **scope Linear by project name** (the picker is name-based), accepting the rare same-name-within-a-team collision and noting it.

## Complexity Audit

### Routine
- Adding `projectName` to frontmatter (one line in `_buildLinearImportPlanContent`)
- Changing the sidebar scope block from `''` to `msg.projectId` for Linear
- Changing the frontmatter regex from `projectId:` to `projectName:` for Linear scope matching
- Marking Step 5 as already implemented (no code change needed)

### Complex / Risky
- `queryIssues` opt-in `projectScoped` path: name→id resolution, full pagination loop, skipping `_applyProjectNameFilters` — touches a shipped function with multiple callers
- Prune safety under per-project fetch: must never delete files when resolution fails or fetch returns empty
- Name-based scoping collision risk (same project name within a team) — accepted tradeoff, documented

## Edge-Case & Dependency Audit
- **Race Conditions**: None significant. The picker change is user-initiated and synchronous; the import is a single async round-trip.
- **Security**: No new auth surfaces. `getAvailableProjects()` uses existing credentials.
- **Side Effects**: Full pagination for large projects (up to `maxPages * 50` issues) is a one-time initial-load cost. Deltas thereafter via `updatedAfter`.
- **Dependencies & Conflicts**: `linearLoadProject` (sidebar browse, `:4348`) is unchanged and separate. The file-backed `localTicketFilesListed` overwrites `linearProjectIssues` — verify the two don't fight.
- **Name→id resolution failure**: return `[]` + skip prune (Step 1/6). Surface the existing "Refresh failed" path if appropriate; do not destroy files.
- **Same project name within a team** (rare): name-based scoping would merge them. Note it. A future hardening: have the webview resolve name→id from already-loaded `linearProjectIssues` (each has `project.id` + `project.name`) and scope by id; deferred to avoid empty-sidebar risk when issues aren't loaded yet.
- **Large project pagination**: full fetch is the agreed one-time initial-load cost (paged 50, 200ms delay, `maxPages` cap with warning). Deltas thereafter via the existing `updatedAfter` filter.
- **Sidebar browse vs import**: `linearLoadProject` (`:4348`, `limit 100`, no `projectId`) is unchanged and separate. Since the sidebar is now file-backed, the visible list = imported files for the selected project; the browse fetch is only the source for the picker's option list and hierarchy.
- **Migration / shipped state (~4000 installs)**: `queryIssues`/`LinearConfig` are shipped. New `projectScoped` option is additive and opt-in — existing fetch behavior is byte-for-byte unchanged for every current caller. New frontmatter key `projectName` is additive. No data migration; no `*.migrated.bak`.
- **`window.confirm` / dialogs**: none introduced. Deletes remain immediate.

## Dependencies
- **Builds on the preceding (uncommitted) Tickets-tab work** in this session: progressive import filter (parents + open), cleanup prune, ClickUp per-list frontmatter scoping, status-filter→includeClosed, subtasks-on-open, and the `loadLocalTicketFiles` workspace-root-guard fix. This plan should land **after** those are committed.
- Touches `LinearSyncService.ts`, `TaskViewerProvider.ts`, `PlanningPanelProvider.ts`, `planning.js`. No overlap with non-tickets work.

## Adversarial Synthesis
Key risks: (1) the plan's original Problem section incorrectly claimed the picker sends no message — it does (lines 8033-8040); the real issue is `queryIssues` ignoring `projectId` in the filter. (2) Line numbers were off by 600+ lines in multiple places — all corrected to actual locations. (3) Name-based scoping accepts same-name collision risk within a team. Mitigations: opt-in `projectScoped` flag leaves all existing callers untouched; prune safety guard prevents deletion on failed/empty fetch; `projectName` frontmatter is additive with no migration needed.

## Proposed Changes

### Step 1 — `queryIssues`: honor an explicit project + full pagination (OPT-IN)
**`src/services/LinearSyncService.ts`** (`queryIssues` `:711`, `buildLinearIssueFilter` `:90`)
- Add an opt-in option `projectScoped?: boolean`. Reuse the existing `projectId` option as the **picker value** (a project *name* or an id).
- When `projectScoped` is true:
  - **Resolve the project**: if `projectId` matches a `getAvailableProjects()` id, use it; else treat it as a name and look up the id (case-insensitive). If resolution **fails**, return `[]` and set a resolution-failed signal (see Step 6) — do **not** silently fall back to a team-wide fetch (that would make the Step-6 prune dangerous).
  - **Filter on that project id** via `buildLinearIssueFilter(teamId, resolvedId, updatedAfter)`, overriding the config-based `_resolveSingleIncludeProjectId`.
  - **Paginate fully**: loop until `pageInfo.hasNextPage` is false / cursor is null, ignoring the 100 cap. Keep a sane `maxPages` (e.g. 40 ≈ 2000 issues at 50/page) with the existing logged warning if exceeded. Keep the 200ms inter-page delay.
  - Skip `_applyProjectNameFilters` (`:602`) for project-scoped queries — the server filter already scopes; the client name-filter is redundant and would re-introduce name matching.
- When `projectScoped` is falsy: **unchanged** (sidebar load + all other callers keep current behavior; `projectId` keeps only affecting the cache key).

### Step 2 — Linear import uses the picker's project + full fetch
**`src/services/TaskViewerProvider.ts`** (`importAllTasks` Linear fast path `:19440`, pagination `:19710`)
- Call `queryIssues({ projectId: <picker value>, projectScoped: true, ...(deltaSinceIso ? { updatedAfter: deltaSinceIso } : {}) })`. Remove the `limit: 100` cap for this path (full fetch).
- Derive `targetDir`/segments from the **resolved project** (the fetched issues' `project.name`, which now all belong to the picked project) rather than `items[0]` ambiguously — for a project-scoped fetch they're the same project, so `items[0]?.project?.name` is now correct, but assert/guard for the empty-result case.

### Step 3 — Record the project name in the ticket file (scope key)
**`src/services/TaskViewerProvider.ts`** (`_buildLinearImportPlanContent` frontmatter `:5250-5262` — already emits `status`/`statusType`/`projectId`/`parentId`)
- Add `projectName: <issue.project.name>` to the frontmatter (keep `projectId` too). This is the key the name-based picker scopes against.

### Step 4 — Scope the Linear sidebar to the selected project
**`src/services/PlanningPanelProvider.ts`** (`listLocalTicketFiles` scope block `:5431`, currently `scopeId = provider === 'clickup' ? msg.listId : ''`)
- For Linear: `scopeId = String(msg.projectId || '').trim()` (the picker **name**), and read the file's frontmatter `projectName` as `fileScopeId` (the per-provider regex already branches — change the Linear branch from `projectId:` to `projectName:`).
- Apply the same strict rule already used for ClickUp: `if (scopeId && fileScopeId !== scopeId) continue;`. Remove the Linear "unscoped" special-case.

### Step 5 — Picker change drives the import (ALREADY IMPLEMENTED)
**`src/webview/planning.js`** (project picker `change` handler `:8023-8041`)
- **No change needed.** The handler already sends `vscode.postMessage({ type: 'refreshTicketsDelta', provider: 'linear', projectId: linearProjectPickerValue, workspaceRoot: ticketsWorkspaceRoot })` at lines 8033-8040. This was wired in a recent commit.
- Keep `renderTicketsLinearList()`/`saveTicketsState()`.
- The initial `linearProjectLoaded` path and the Refresh button already send `refreshTicketsDelta` with the project — keep them consistent (they pass `projectId: linearProjectPickerValue`).

### Step 6 — Prune safety under per-project fetch (CRITICAL)
**`src/services/TaskViewerProvider.ts`** (`importAllTasks` prune block `:19449`, gated on `rawItemCount > 0`)
- The prune deletes files in the project's `targetDir` not in `keepIds`. This is only safe if the fetch genuinely returned that project's issues.
- Add a guard: **only prune Linear when the project resolution succeeded** (Step 1). If `queryIssues` returned `[]` because resolution failed (name not found / API error), `rawItemCount` is 0 → prune already skipped — but make this explicit so a future change can't accidentally fetch team-wide and prune a single project's dir. Never delete another project's files; never delete on a failed/empty fetch.

## Verification Plan

### Automated Tests
No automated tests run as part of this plan (session directive: skip tests). The test suite will be run separately by the user. Static checks only: `node -c src/webview/planning.js` for webview syntax and `npx tsc --noEmit --skipLibCheck` on the changed `.ts` files (ignoring pre-existing `downlevelIteration` noise).

### Manual (the Linear failure modes)
1. Select a Linear project with **>100** issues → **all** its open parent issues import as files (not capped at 100). Confirm file count matches the project's open-parent count.
2. Sidebar shows **only** that project; switching to another project re-imports it and re-scopes (no cross-project bleed).
3. Sub-issues excluded (`parentId`); completed/canceled excluded unless a closed state is chosen via the state filter.
4. **Prune safety**: switching projects prunes only the *previous*/current project's dir as appropriate; a project whose name fails to resolve imports nothing and deletes nothing; an empty/erroring fetch deletes nothing.
5. Locally-modified Linear files are preserved across re-import (existing `modified` guard).

### Regression
6. **ClickUp unaffected**: list-select still imports + prunes + scopes (the `queryIssues` change is opt-in; no ClickUp code path touched).
7. Linear **browse** (sidebar) still lists the selected project's files; search/state filters still work client-side.

> **Session directives:** No compilation step is run as part of verification (project assumed pre-compiled; `src/` is source of truth, `dist/` irrelevant). No automated tests run here.

**Recommendation**: Complexity 6/10 → Send to Lead Coder. Cross-file change on a shipped provider with pagination, name resolution, and file-deletion (prune) safety requirements.

## Review Findings

All 6 steps verified as implemented. `queryIssues` has opt-in `projectScoped` with name→id resolution, full pagination (maxPages=40, 50/page, 200ms delay), and skips `_applyProjectNameFilters` for scoped queries (`LinearSyncService.ts:714-852`). Import fast path (`TaskViewerProvider.ts:19681-19685`) and slow path (`:19959`) both pass `projectScoped: true`. Frontmatter emits `projectName` (`:5347`). Sidebar scopes Linear by `msg.projectId` against `projectName:` frontmatter regex (`PlanningPanelProvider.ts:5830-5856`). Prune guard explicitly checks `!resolutionFailed` (`:19798`). All other `queryIssues` callers verified unaffected (no `projectScoped` passed). One fix applied: stale comment at `PlanningPanelProvider.ts:5823-5828` updated to reflect actual Linear scoping behavior. Verification: `node -c src/webview/planning.js` passed. Remaining risk: same-name project collision within a team (documented, accepted); legacy Linear files without `projectName` frontmatter hidden until re-import (no data loss).
