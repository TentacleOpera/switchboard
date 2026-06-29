# Tickets Tab: File-Backed Source of Truth + Initial-Load-Then-Delta Sync

## Goal

Make the Planning panel **Tickets tab** behave the way it was always meant to: selecting a list imports **every task in that list as a local document file**, the sidebar shows **only tickets that have files**, and after the initial load the tab keeps files current with **delta updates** (only tasks changed since the last sync) rather than full re-fetches. Editing, pushing, creating, and "Sync changes" must all operate on a file layer that is **guaranteed to exist**, eliminating the "Document file not found" class of failures.

As part of this, redefine the **auto-sync toggle** so that OFF is a fully-working **manual mode** (files still created, Edit/Push/Refresh all work — just no background network activity) rather than the current broken state where OFF leaves the file layer empty and Push/Save/Sync silently no-op.

### Problem

The tab has four user-visible failures, all observed 2026-06-29 with **auto-sync OFF**:

1. **Push on any ticket → `Push to clickup failed: Document file not found for ticket <id>. Re-open with Edit.`** — no local file exists to push.
2. **"Sync changes" does nothing** — it reports `Synced 0 tickets successfully` and writes nothing.
3. **Editing "works" but never persists** — you can Edit + Save a ticket, the UI looks updated, but on reload it's gone and Push still fails.
4. **Creating a new ticket → Push says no file exists** — the ticket is created remotely but no local file is written, yet the UI says "created ✓".

The user's stated design (twice): *the sidebar only shows tickets that have files; selecting a list imports every task as a file; after the initial load only delta updates are needed.* None of that is what the code does today.

### Root Cause

**The local `.md` file is treated as best-effort by every code path that WRITES it, but as mandatory by every path that READS it.** With auto-sync OFF the file layer is empty, so the readers all fail:

| Subsystem | Current source of truth | Behavior with no file |
|---|---|---|
| Sidebar list | live API (`planning.js:5072` `clickupProjectLoaded` overwrites `clickUpProjectIssues = msg.tasks`; list dropdown always calls `loadClickUpProject` at `planning.js:8705`) | shows remote tasks regardless of files |
| Edit / Save | in-memory API object + cache; `saveLocalTicketFile` does `if (!filePath) break;` (`PlanningPanelProvider.ts:4826`) | edit lives only in webview memory; Save writes nothing |
| Push / "Sync changes" | on-disk files only (`_findTicketDocument`, `TaskViewerProvider.ts:18475`; `syncAllTickets` scans dirs, `PlanningPanelProvider.ts:5085`) | "Document file not found" / pushes 0 files |
| Create | calls `importTaskAsDocument` then **discards its `{success:false}` return** (`PlanningPanelProvider.ts:5517`); ClickUp read-after-write lag makes `getTaskDetails` return null | "created ✓", no file |

**The only path that writes files** (`importAllTickets` → `importMode:'document'`) is gated behind the auto-sync toggle. For ClickUp, the gate at `planning.js:5085` is `(ticketsAutoSync || _pendingRefreshImport)` — so clicking Refresh sets `_pendingRefreshImport = true` and allows import even with auto-sync OFF. For Linear, the gate at `planning.js:4909` is **only** `ticketsAutoSync` — no `_pendingRefreshImport` fallback. This asymmetry means Linear users with auto-sync OFF have no manual workaround at all.

**There is also no delta engine.** `getListTasks` (`ClickUpSyncService.ts:1118`) fetches the **entire list** every time (no `date_updated` filter); `queryIssues` (`LinearSyncService.ts:697`) has no `updatedAt` filter. `config.lastSync` is **vestigial** — written only by `syncColumn` (plan→column push, `ClickUpSyncService.ts:2778`), read only at config load. The only real cursor-based delta polling in the repo is `RemoteControlService` — a separate kanban remote-control subsystem that does **not** touch these ticket files.

### Background

- `importTaskAsDocument` (`TaskViewerProvider.ts:18332`) writes `<ticketSaveLocation>/<provider>/<space>/<folder>/<list>/<provider>_<id>_<slug>.md` and registers it in the cache DB with a `last_synced_at` baseline. Its signature accepts only `{ provider, id, includeSubtasks }` — **no pre-fetched task object** — so it always re-fetches via `getTaskDetails`/`getIssue`, which is where the read-after-write lag bug originates.
- `_findTicketDocument` (`TaskViewerProvider.ts:18475`) and `PlanningPanelProvider._findTicketFilePath` (`PlanningPanelProvider.ts:1836`) both **recursively scan** `ticketSaveLocation/<provider>` and `.switchboard/tickets/<provider>` for the `<provider>_<id>_` prefix, so file location vs. live hierarchy mismatches don't matter for *finding* a file — only its *existence* does.
- `listLocalTicketFiles` (`PlanningPanelProvider.ts:4922`) already renders the list purely from the imported-tickets DB (with a 24h filesystem backfill scan throttled by a `last_ticket_heal_scan_<wsId>` meta key at `:4941`). This is exactly the "files only" source the design wants — it's just not used on list-select.
- Sync status is a timestamp comparison: `_ticketSyncStatusFromTimestamps` (`PlanningPanelProvider.ts:7949`) returns `modified` when the file mtime is newer than `last_synced_at`. Push conflict detection already exists (`PlanningPanelProvider.ts:7362`) and compares remote vs. local content hashes.
- Auto-sync ON already installs a filesystem watcher that **auto-pushes** changed ticket files to the remote after a 2s debounce (`_updateTicketsAutoSyncWatcher`, `PlanningPanelProvider.ts:8062`). This is the one genuine ON-only behavior worth keeping.
- `createTask` returns a normalized `ClickUpTask` (`ClickUpSyncService.ts:1285`) — the same shape `_buildClickUpImportPlanContent` consumes — so a created ticket's document can be built directly from the create response + the description the user just typed, with no fragile re-fetch.
- **`_buildClickUpImportPlanContent`** (`TaskViewerProvider.ts:5317`) and **`_buildLinearImportPlanContent`** (`TaskViewerProvider.ts:5057`) are **private methods on `TaskViewerProvider`**, not `PlanningPanelProvider`. The create handlers in `PlanningPanelProvider` call `importTaskAsDocument` via `vscode.commands.executeCommand('switchboard.importTaskAsDocument', ...)` — they do not have direct access to these builders. Step 1 must either (a) extend `importTaskAsDocument` to accept a pre-fetched task object, or (b) expose a new command that builds + writes the document from a passed-in task.
- **`_buildTicketDir`** (`TaskViewerProvider.ts:18451`) is the helper that resolves `<ticketSaveLocation>/<provider>/<hierarchy>/` from the integration config. It is also private on `TaskViewerProvider`. The Save path's create-if-missing (Step 2) in `PlanningPanelProvider` needs directory resolution — it must either call through to `TaskViewerProvider` or replicate the logic using `GlobalIntegrationConfigService.loadConfigSync` (which `_buildTicketDir` itself uses at `:18452`).

## Metadata
- **Tags**: bugfix, feature, ui, ux, backend, api, database
- **Complexity**: 7/10

## User Review Required
None. The behavior is fully specified by the user: design **(a)** — OFF = no *background* network activity, but the initial import and manual Refresh/Push still work; ON adds the timer-based delta pull and auto-push-on-save. The only product call (where to draw the ON/OFF line) is already decided.

## Auto-Sync Semantics After This Change

This is the contract the implementation must satisfy:

| | **Auto-sync ON** | **Auto-sync OFF** |
|---|---|---|
| Files created for chosen list | ✅ on first list-select | ✅ on first list-select *(now unconditional)* |
| Sidebar = local files only | ✅ | ✅ |
| Edit / Save / Push / Create / "Sync changes" | ✅ work | ✅ work |
| Pull remote→local (delta on `date_updated`/`updatedAt`) | ✅ automatic on a timer | ⛔ only on manual **Refresh** |
| Push local→remote | ✅ automatic on file change (existing watcher) | ⛔ only on manual **Push** / **Sync changes** |

One-line summary: **the toggle stops deciding whether the tab works at all, and becomes purely "background automation on/off."**

## Complexity Audit

### Routine
- **Create path** (`PlanningPanelProvider.ts:5512` clickupCreateTask, `:5547` linearCreateIssue): check the `importTaskAsDocument` return value; on `success:false` surface a real error instead of unconditionally posting `success:true`. Build the document from the create response + typed description to dodge read-after-write lag.
- **Save path** (`PlanningPanelProvider.ts:4821` saveLocalTicketFile): replace `if (!filePath) break;` with create-if-missing — resolve the target dir via the same helper `importTaskAsDocument` uses and write the file (frontmatter + body), then register it in the cache DB.
- **"Sync changes" feedback** (`planning.js:4357` in the `syncAllTicketsResult` handler at `:4352`): when `count === 0`, show "No local ticket files to sync" instead of "Synced 0 tickets successfully."
- **Remove the auto-sync gate on initial import** (`planning.js:5085` for ClickUp, `:4909` for Linear): import-as-documents fires whenever a list is selected, regardless of `ticketsAutoSync`. **Also fix the Linear asymmetry**: add `_pendingRefreshImport` to the Linear gate at `:4909` to match ClickUp's `(ticketsAutoSync || _pendingRefreshImport)` pattern at `:5085`.
- **Render sidebar from files in both modes**: route list population through `listLocalTicketFiles` → `localTicketFilesListed` (`planning.js:4383`) after the import completes, instead of leaving `clickUpProjectIssues` set to the raw live-API list from `clickupProjectLoaded` (`planning.js:5072`).

### Complex / Risky
- **Delta fetch (new capability, both providers):**
  - ClickUp: add a `dateUpdatedGt?: number` option to `getListTasks` (`ClickUpSyncService.ts:1118`) that appends `&date_updated_gt=<epochMs>&order_by=updated` and **bypasses the list cache** (delta queries must hit the API — the cache is keyed on `isSimpleQuery` at `:1137`; a delta query is not "simple"). Verify the exact ClickUp param name during implementation (see Uncertain Assumptions).
  - Linear: add an `updatedAfter?: string` option to `queryIssues` (`LinearSyncService.ts:697`) wired into the GraphQL `IssueFilter` as `updatedAt: { gt: $updatedAfter }` (`:436`). The current `LinearIssueFilter` type (`:82-85`) only has `team` and `project` — `updatedAt` must be added to the type. The `updatedAt` field already exists in the GraphQL query results (`:454`) but not as a filter parameter. Verify Linear's API supports `updatedAt` in `IssueFilter` (see Uncertain Assumptions).
- **Per-list delta cursor:** introduce a `last_delta_pull_<provider>_<listId>` (ClickUp) / `<provider>_<projectId>` (Linear) meta key in the kanban DB, mirroring the existing `last_ticket_heal_scan_` throttle pattern (`PlanningPanelProvider.ts:4941`). Do **not** reuse the vestigial `config.lastSync`. Update the cursor only after a successful delta pull. (The blessed home for state is the DB, per project convention — not `state.json`, not the integration config file.)
- **Delta application + conflict safety:** for each changed task, re-import its document — **unless** the local file has unpushed changes (`syncStatus === 'modified'`). In that case do NOT clobber; mark it and route through the existing conflict path (`PlanningPanelProvider.ts:7362`). A delta pull must never silently overwrite local edits.
- **Timer-based pull (ON only):** add an interval that runs the delta pull for the selected list when `ticketsAutoSync` is true; tear it down when toggled off or the panel disposes. Reuse/extend the existing watcher lifecycle in `_updateTicketsAutoSyncWatcher` rather than inventing a parallel timer system.
- **Deletions/removals:** decide delta handling for tasks deleted remotely (out of scope for v1 — note it; do not auto-delete local files, which could destroy local edits).
- **Cross-class private method access:** `PlanningPanelProvider` needs directory resolution (`_buildTicketDir`) and content building (`_buildClickUpImportPlanContent`/`_buildLinearImportPlanContent`) that are private on `TaskViewerProvider`. The cleanest path is extending `importTaskAsDocument` to accept an optional pre-fetched task object (skipping the internal `getTaskDetails` re-fetch), keeping all file-writing logic in one class.

## Edge-Case & Dependency Audit
- **Read-after-write lag (the create bug):** building the doc from the `createTask`/`createIssueSimple` response avoids the immediate `getTaskDetails` round-trip that returns null. If we still want subtasks/comments, schedule a *follow-up* delta pull rather than blocking the create on a re-fetch.
- **Large lists:** the initial import is a full fetch (paged 100 ClickUp / 50 Linear, concurrency 3, 200ms delay in `importAllTasks`). This is the agreed "initial load" cost and happens **once per list**; deltas are cheap thereafter. **Do not** re-import the whole list on every list-select — gate the full import on "files missing or cursor unset for this list," else fall through to a delta pull.
- **Conflict / local-modified:** never overwrite a `modified` file during a delta pull (see above). Sync-status badges already exist to show this.
- **`ticketSaveLocation` not configured:** `importTaskAsDocument` returns `success:false` with a "not configured" error. After this change that surfaces to the user (good) instead of being swallowed. Save's create-if-missing must handle this the same way (cannot write a file with nowhere to put it → real error, not silent no-op).
- **Migration / shipped state (~4000 installs):** `ticketsAutoSync` is shipped config — its *key* is preserved; only its *runtime meaning* changes (behavioral, not a data migration). The new `last_delta_pull_*` meta keys are additive; absence = "never pulled" = full initial import, which is correct. No file format change to existing `<provider>_<id>_<slug>.md` docs. No `*.migrated.bak` needed.
- **List-select always loading remote (`planning.js:8705`):** must change so selecting a list triggers import-then-render-from-files, not a raw remote overwrite. Verify the initial-tab-load path (`planning.js:5198` `integrationProviderStates`) and the dropdown-change path (`planning.js:8682`) converge on the same flow (today they diverge — that inconsistency is part of the bug).
- **Workspace switching / multiple roots:** delta cursors and watchers are per-workspace-root; ensure switching the tickets workspace dropdown (`planning.js:7150`) re-resolves them. Respects the existing per-tab independent workspace selection.
- **Linear vs ClickUp parity:** every change must be implemented for both providers (list import, delta filter, create, save). Linear's analog of list = project. **The `_pendingRefreshImport` asymmetry** (ClickUp has it at `:5085`, Linear doesn't at `:4909`) must be fixed as part of Step 3.
- **`window.confirm` / dialogs:** none introduced. Deletes and pushes remain immediate per project rule.

## Dependencies
- None on other in-flight plans. This plan touches `planning.js`, `PlanningPanelProvider.ts`, `TaskViewerProvider.ts`, `ClickUpSyncService.ts`, `LinearSyncService.ts`. No overlap with the epics-removal or HTML-tab plans.

## Uncertain Assumptions
- **ClickUp `date_updated_gt` API parameter name:** The plan assumes the ClickUp v2 REST API supports a `date_updated_gt` query parameter on the `/list/{id}/task` endpoint for filtering tasks by last-updated timestamp. This has not been verified against ClickUp's current API documentation. The user was advised to run web research to confirm the exact parameter name and format before implementation.
- **Linear GraphQL `IssueFilter.updatedAt` filter support:** The plan assumes Linear's GraphQL API accepts `updatedAt: { gt: <ISO timestamp> }` as a field within the `IssueFilter` input type. The current codebase `LinearIssueFilter` type only includes `team` and `project`, and `updatedAt` appears only as a query result field, not a filter. Whether Linear's API actually supports filtering by `updatedAt` has not been verified. The user was advised to run web research to confirm this before implementation.

## Adversarial Synthesis
Key risks: (1) a delta pull silently overwriting unpushed local edits — mitigated by the mandatory `modified` guard routing to conflict handling instead of blind re-import; (2) re-importing the entire list on every interaction — mitigated by strictly gating full import on "cursor unset / files missing for this list" with all subsequent syncs being delta-only; (3) the toggle redefinition confusing existing ON users — mitigated because the new model is strictly more functional (files always exist; ON just adds automation). Verification anchor: the four reproduction steps in Problem must each pass with auto-sync **OFF**.

## Proposed Changes

> Implementation order is designed so each step is independently testable. Steps 1–3 fix the "no file" failures; step 4 adds delta; step 5 redefines the toggle.

### Step 1 — Create path writes a guaranteed file
**`src/services/PlanningPanelProvider.ts`** (`clickupCreateTask` case `:5512`, import call `:5517`; `linearCreateIssue` case `:5547`, import call `:5581`)
- After `createTask`/`createIssueSimple`, build the local document directly from the returned task/issue + the `msg.description`/`msg.title` already in hand. Two implementation options:
  - **(a) Preferred:** Extend `importTaskAsDocument` (`TaskViewerProvider.ts:18332`) to accept an optional `preFetchedTask?: ClickUpTask | LinearIssue` parameter. When provided, skip the internal `getTaskDetails`/`getIssue` re-fetch and use the passed object directly with `_buildClickUpImportPlanContent` (`:5317`) / `_buildLinearImportPlanContent` (`:5057`).
  - **(b) Alternative:** Expose a new command `switchboard.writeTicketDocument` that accepts a pre-built task object + content and writes the file + registers the cache entry, bypassing the fetch entirely.
- **Check the result.** If the file isn't written, post `clickupTaskCreated`/`linearIssueCreated` with `success:false` and the real error — do not post `success:true`. Currently the `await vscode.commands.executeCommand(...)` return value at `:5517` (ClickUp) and `:5581` (Linear) is discarded entirely.

### Step 2 — Save creates the file if missing
**`src/services/PlanningPanelProvider.ts`** (`saveLocalTicketFile` `:4821`, `if (!filePath) break;` at `:4826`)
- Replace `const filePath = this._findTicketFilePath(...); if (!filePath) break;` with: find-or-create. If no file exists, resolve the target dir (same logic `importTaskAsDocument` uses via `_buildTicketDir` at `TaskViewerProvider.ts:18451`, which reads `GlobalIntegrationConfigService.loadConfigSync` at `:18452`), write `frontmatter + content`, and register it in the cache DB. If `ticketSaveLocation` is unconfigured, post a real error back to the webview.
- **Cross-class access note:** `_buildTicketDir` is private on `TaskViewerProvider`. `PlanningPanelProvider` must either (a) call `importTaskAsDocument` with the pre-fetched task option from Step 1, (b) replicate the directory resolution using `GlobalIntegrationConfigService.loadConfigSync` directly, or (c) expose `_buildTicketDir` as a public/static method.

### Step 3 — List-select imports unconditionally + sidebar renders from files
**`src/webview/planning.js`**
- `clickupProjectLoaded` (`:5072`) / list dropdown change (`:8682`): drop the `ticketsAutoSync` gate at `:5085` (ClickUp) and `:4909` (Linear); always trigger `importAllTickets` (`importMode:'document'`) for the selected list **when its delta cursor is unset / files are missing**, then call `loadLocalTicketFiles()` so the sidebar renders from `localTicketFilesListed` (`:4383`) in both modes.
- **Fix the Linear `_pendingRefreshImport` asymmetry:** add `|| _pendingRefreshImport` to the Linear gate at `:4909` to match ClickUp's pattern at `:5085`. This ensures manual Refresh works for Linear even with auto-sync OFF.
- Converge the initial-tab-load path (`:5198` `integrationProviderStates`) and dropdown-change path (`:8682`) on the same import-then-render-from-files flow.
- "Sync changes" zero-file feedback (`:4357` in the `syncAllTicketsResult` handler at `:4352`): when `msg.succeeded === 0`, show "No local ticket files to sync" instead of "Synced 0 tickets successfully."

### Step 4 — Real delta pull
**`src/services/ClickUpSyncService.ts`** (`getListTasks` `:1118`): add `dateUpdatedGt?: number`; when set, append the delta query param + `order_by=updated` and bypass the list cache (the `isSimpleQuery` check at `:1137` must treat a delta query as non-simple).
**`src/services/LinearSyncService.ts`** (`queryIssues` `:697`, GraphQL `:436`, `LinearIssueFilter` type `:82`): add `updatedAfter?: string` → `IssueFilter.updatedAt.gt`. Also extend the `LinearIssueFilter` type to include `updatedAt?: { gt: string }`.
**`src/services/TaskViewerProvider.ts`** (`importAllTasks` `:18661`): add a delta mode that fetches only changed IDs since the per-list cursor and re-imports them via `_writeTaskDocument` (`:18747`), **skipping `modified` files** (conflict guard).
**`src/services/PlanningPanelProvider.ts`**: add per-list `last_delta_pull_*` meta key read/write; a `refreshTicketsDelta` message handler invoked by the manual **Refresh** button (`planning.js:7516`); update the cursor after a successful pull.

### Step 5 — Redefine the auto-sync toggle
**`src/services/PlanningPanelProvider.ts`** (`_updateTicketsAutoSyncWatcher` `:8062`):
- Keep the auto-push-on-file-change watcher as the ON-only push automation.
- Add an interval (ON only) that runs the delta pull for the selected list; tear down on toggle-off / dispose.
**`src/webview/planning.js`**: remove all remaining `ticketsAutoSync`-conditioned *list-source* logic (`:5198` `integrationProviderStates`, `:5036` `clickupSpacesLoaded`, `:1326` tab switch handler) — the list is always file-backed now; `ticketsAutoSync` only governs background pull/push.

## Verification Plan

### Automated Tests
- Unit: `saveLocalTicketFile` creates a file when none exists (and errors cleanly when `ticketSaveLocation` is unset).
- Unit: create handler returns `success:false` when the document write fails (mock `importTaskAsDocument` failure).
- Unit: `getListTasks({dateUpdatedGt})` appends the delta param and bypasses cache; `queryIssues({updatedAfter})` injects the GraphQL filter.
- Unit: delta application skips a file whose mtime > `last_synced_at` (conflict guard).
- Run the existing `tickets-link-to-ticket-regression.test.js` and any ticket-import tests to confirm no regression. (Per project rule: `dist/` is irrelevant; `src/` is source of truth.)

> **Session directives:** No compilation step (`npm run compile`, `tsc`, etc.) is run as part of this verification plan — the project is assumed pre-compiled. No automated tests (unit, integration, e2e) are run — the test suite will be run separately by the user.

### Manual Verification — **all with auto-sync OFF** (the broken mode)
1. Select a ClickUp list → confirm local `.md` files appear for every task and the sidebar lists them (files, not raw API).
2. Open a ticket → **Edit** → change text → **Save** → reload the tab → the edit persists.
3. **Push** that ticket → succeeds, no "Document file not found".
4. **Create** a new ticket → confirm a local file is written immediately → **Push** succeeds.
5. **"Sync changes"** with real local edits → pushes them; with none → shows "No local ticket files to sync".
6. Click **Refresh** → changes made to a task in ClickUp's UI appear locally (delta pull), but a locally-`modified` file is NOT overwritten (conflict surfaced).
7. **Linear parity check:** select a Linear project with auto-sync OFF → confirm files are imported (the `_pendingRefreshImport` fix), Edit/Save/Push/Create all work.

### Manual Verification — auto-sync ON
8. Edit a local file → it auto-pushes within ~2s (existing watcher).
9. Change a task remotely → it appears locally on the next timer tick without pressing Refresh.
10. Toggle auto-sync OFF → confirm the timer and watcher are torn down (no further background pulls/pushes); manual buttons still work.

**Recommendation**: Complexity 7/10 → Send to Lead Coder. Multi-file, cross-provider, behavior-changing on a shipped feature with conflict-safety requirements and cross-class private method dependencies.
