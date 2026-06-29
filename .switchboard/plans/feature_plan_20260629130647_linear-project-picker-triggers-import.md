# Linear Project Picker Change Triggers File-Backed Import

## Goal

When a Linear user selects a different project from the project picker dropdown in the Tickets tab, the sidebar should immediately import (or delta-pull) tickets for that project and render from local files — exactly like ClickUp's list-select dropdown already does. Today the picker change only filters the already-loaded in-memory issue list locally; no backend message is sent, so no files are imported and the sidebar stays empty or stale until the user manually clicks Refresh.

### Problem

The ClickUp list-select dropdown (`planning.js:8710`) calls `loadClickUpProject(false, listId)` → backend fetches the list → `clickupProjectLoaded` fires → `refreshTicketsDelta` is sent → files get imported → `loadLocalTicketFiles()` renders the sidebar from files.

The Linear project picker dropdown (`planning.js:7507`) does none of this. Its change handler is:

```js
projectPicker?.addEventListener('change', (e) => {
    linearProjectPickerValue = e.target.value;
    renderTicketsLinearList();
    saveTicketsState();
});
```

It sets the picker value, re-renders the in-memory list (filtered by project), and saves state. No `refreshTicketsDelta` message. No backend round-trip. No file import. The user sees an empty or stale sidebar.

### Root Cause

The Linear project picker was originally a *client-side filter* on a single batch of issues loaded via `linearLoadProject` (which fetches all issues for the team, across all projects). Selecting a project just filtered that pre-loaded array. When the file-backed sync refactor (feature_plan_20260629111030) redefined the sidebar to show only tickets with local files, the ClickUp path was updated to trigger import-on-list-select, but the Linear picker was left as a pure client-side filter — it was never wired to send `refreshTicketsDelta` for the newly-selected project.

### Background

- `linearProjectPickerValue` is the selected project **name** (not ID). The picker is populated from `linearProjectIssues` project names (`planning.js:8184-8199`), so option values are project names.
- The `linearProjectLoaded` handler (`planning.js:4922-4928`) already sends `refreshTicketsDelta` with `projectId: linearProjectPickerValue` — i.e., it sends the project **name** as `projectId`. This is the established convention for the Linear path.
- The Refresh button (`planning.js:7536-7542`) also sends `projectId: linearProjectPickerValue` (the name) — same convention.
- The `refreshTicketsDelta` handler (`PlanningPanelProvider.ts:4849`) builds the delta cursor key as `last_delta_pull_linear_${projectId || ''}` (line 4865) and stores the selection in `_ticketsCurrentSelection` (line 4855). The auto-sync timer (`PlanningPanelProvider.ts:8353-8355`) reads the same `selection.projectId` for its cursor key. **All paths must use the same value (name) for cursor key consistency.**
- `linearProjectIssues` is populated by `linearLoadProject` which fetches all team issues. Each issue has `project: { id, name }`.
- **Important clarification (corrects original plan):** The `queryIssues` method in `LinearSyncService.ts` does **NOT** use the `projectId` parameter for server-side filtering. The `projectId` parameter is only used for (a) cache keying (`LinearSyncService.ts:740-741`) and (b) the reverse index `_issueProjectIndex` (`LinearSyncService.ts:826-827`). Actual project filtering comes from the Linear config's `includeProjectNames`/`excludeProjectNames` via `_resolveSingleIncludeProjectId` (server-side, `LinearSyncService.ts:758`) and `_applyProjectNameFilters` (client-side, `LinearSyncService.ts:818`). The `importAllTasks` fast path (`TaskViewerProvider.ts:18753`) calls `queryIssues({ projectId, ... })` but the `projectId` only affects the cache namespace, not which issues are returned. The file save directory is derived from `items[0]?.project?.name` (`TaskViewerProvider.ts:18757`), not from `projectId`.

## Metadata
- **Tags**: bugfix, ui, ux
- **Complexity**: 2/10

## User Review Required
None. The fix is a straightforward wiring gap — the picker change handler needs to send the same message the Refresh button already sends.

## Complexity Audit

### Routine
- Adding a `vscode.postMessage({ type: 'refreshTicketsDelta', ... })` call to an existing event handler — single file, single handler, 5 lines of code.
- The backend handler (`refreshTicketsDelta` in `PlanningPanelProvider.ts:4849`) already exists and works unchanged.
- The message format is identical to what the Refresh button already sends — no new message type, no new backend logic.

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** Rapid picker changes fire multiple `refreshTicketsDelta` messages. Each reads its own cursor and does a delta pull. The last one wins for sidebar rendering (the `importAllTicketsComplete` handler calls `loadLocalTicketFiles()`). This is the same behavior as rapid ClickUp list switches and rapid Refresh button clicks — no new race condition.
- **Security:** No security implications — the message only triggers a backend import for the already-authenticated Linear workspace.
- **Side Effects:** The picker change now triggers a backend round-trip (file import) that it didn't before. This is the intended behavior and matches ClickUp parity. The in-memory `renderTicketsLinearList()` call is preserved (renders immediately from cached issues) while the file-backed import runs in the background and updates the sidebar on completion.
- **Dependencies & Conflicts:** Depends on the file-backed sync infrastructure from `feature_plan_20260629111030_tickets-tab-file-backed-sync.md` (the `refreshTicketsDelta` handler, per-project delta cursor, `loadLocalTicketFiles()` rendering). That plan is already implemented. No conflicts.

### Edge Cases

- **Picker populated from restored state but issues not loaded:** This edge case **cannot occur** via the picker `change` event. The picker options are populated from `linearProjectIssues` (`planning.js:8184-8194`). If `linearProjectIssues` is empty, the picker has no options (only "All projects"), so the user cannot trigger a `change` event for a specific project. The restored-value case is handled separately by the `linearProjectLoaded` handler (`planning.js:4905-4914`) which fires after issues are loaded. No fallback to `loadLinearProject(true)` is needed in the picker change handler.
- **Project name collisions:** Two projects with the same name in different teams. The picker value is the name, and the cursor key is `last_delta_pull_linear_<name>`. This is the same behavior as the existing Refresh button and `linearProjectLoaded` handler — not a regression.
- **`window.confirm` / dialogs:** none introduced.

## Dependencies
- `feature_plan_20260629111030` — Tickets Tab File-Backed Sync (the `refreshTicketsDelta` handler, per-project delta cursor, `loadLocalTicketFiles()` rendering). Already implemented.

## Adversarial Synthesis

Key risks: (1) **Cursor key mismatch** — the original plan proposed resolving the project name to a project UUID before sending `refreshTicketsDelta`, but the existing Refresh button and `linearProjectLoaded` handler both send the project **name** as `projectId`. Mixing UUIDs and names would create different cursor keys (`last_delta_pull_linear_<UUID>` vs `last_delta_pull_linear_<name>`) for the same project, causing unnecessary full re-imports when switching between picker-change and Refresh-button triggers. Mitigation: send the name directly, matching existing convention. (2) **Incorrect backend claim** — the original plan's Step 2 claimed `queryIssues` filters by project ID; it does not. The `projectId` parameter is only a cache/reverse-index label. This doesn't affect the fix but the explanation was wrong. Mitigation: corrected in Background section above.

## Proposed Changes

### Step 1 — Wire the picker change handler to send `refreshTicketsDelta`
**`src/webview/planning.js`** (project picker change handler, `:7507`)

The picker value is a project **name**. The existing convention (Refresh button at `:7536-7542`, `linearProjectLoaded` handler at `:4922-4928`) is to send this name directly as `projectId` in the `refreshTicketsDelta` message. The backend handler (`PlanningPanelProvider.ts:4865`) builds the cursor key from this value, so all trigger paths must use the same value (name) for cursor consistency.

**Do NOT resolve name→ID.** The original plan proposed resolving the picker value (name) to a project UUID via `linearProjectIssues.find(...)`. This would break cursor key consistency: the picker change would store the cursor under `last_delta_pull_linear_<UUID>` while the Refresh button stores it under `last_delta_pull_linear_<name>`. The first Refresh after a picker change would not find the cursor and do a full re-import instead of a delta pull.

The correct fix is to send the name directly — identical to the Refresh button:

```js
projectPicker?.addEventListener('change', (e) => {
    linearProjectPickerValue = e.target.value;
    renderTicketsLinearList();
    saveTicketsState();
    // Wire the picker change to the same delta-aware import path that
    // the Refresh button and the initial linearProjectLoaded handler use.
    // The picker value is a project name; send it directly as projectId
    // to match the existing convention (Refresh button :7536, linearProjectLoaded
    // handler :4922). The backend uses it as a cursor key label, not a
    // server-side filter — queryIssues filters via config.includeProjectNames.
    if (linearProjectPickerValue) {
        vscode.postMessage({
            type: 'refreshTicketsDelta',
            provider: 'linear',
            projectId: linearProjectPickerValue,
            workspaceRoot: ticketsWorkspaceRoot
        });
    }
});
```

**Why no `loadLinearProject(true)` fallback is needed:** The picker `change` event only fires when the user selects from populated options. Options are populated from `linearProjectIssues` (`planning.js:8184-8194`), so if the user can select a project, issues are already loaded. The restored-state-without-issues case is handled by the `linearProjectLoaded` handler (`:4905-4914`), not by the picker change handler.

### Step 2 — Verify the `refreshTicketsDelta` handler (no code change needed)
**`src/services/PlanningPanelProvider.ts`** (`refreshTicketsDelta` handler, `:4849`)

The handler uses `projectId` to build the cursor key (`last_delta_pull_linear_${projectId}`, `:4865`), stores the selection in `_ticketsCurrentSelection` (`:4855`), and passes `projectId` to `importAllTasks` (`:4882`). The auto-sync timer reads the same `selection.projectId` for its cursor key (`:8355`). All paths are consistent as long as the same value (name) is sent.

**No code change needed here.** The handler already works with the project name. The only gap was that the picker change handler never sent the message.

**Correction to original plan:** The original plan claimed "`queryIssues` filters by project ID." This is incorrect. `queryIssues` (`LinearSyncService.ts:708`) uses `options.projectId` only for cache keying (`:740-741`) and the reverse index (`:826-827`). Actual project filtering comes from `config.includeProjectNames`/`excludeProjectNames` via `_resolveSingleIncludeProjectId` (server-side, `:758`) and `_applyProjectNameFilters` (client-side, `:818`). The `importAllTasks` fast path (`TaskViewerProvider.ts:18753`) passes `projectId` to `queryIssues`, but it only affects the cache namespace. The file save directory is derived from `items[0]?.project?.name` (`TaskViewerProvider.ts:18757`), not from `projectId`.

## Verification Plan

### Automated Tests
- None required — the change is a webview event wiring fix, not a backend logic change.

> **Session directives:** No compilation step. No automated tests.

### Manual Verification
1. Open the Tickets tab with Linear as the provider.
2. Select project A from the picker → confirm local `.md` files appear for project A's issues and the sidebar lists them.
3. Select project B from the picker → confirm the sidebar updates to show project B's tickets (files imported, not just filtered in-memory).
4. Select project A again → confirm **delta pull** (only changed tasks, not full re-import — verify the cursor key `last_delta_pull_linear_<projectA_name>` is set and reused).
5. **Cursor consistency check:** After selecting project A via the picker, click the Refresh button → confirm it does a **delta pull** (not a full re-import). This verifies the picker change and Refresh button use the same cursor key.
6. **ClickUp parity check:** repeat the same flow with ClickUp (select list A, then list B) → confirm both providers now behave identically.

---

## Code Review Results

### Stage 1 — Grumpy Principal Engineer Review

> *(theatrical grumpy voice)*

**NIT — Verification steps 4-5 describe delta pulls that don't happen.** The plan says "Select project A again → confirm **delta pull**" and "click the Refresh button → confirm it does a **delta pull**." But the actual `refreshTicketsDelta` handler (`PlanningPanelProvider.ts:4881-4897`) ALWAYS does a full import — it calls `switchboard.importAllTasks` with NO `deltaSince`/`deltaSinceIso` parameters. The comment at `:4881-4885` explicitly says "The user-facing select/Refresh always does a FULL import + prune... Delta pulls are reserved for the background auto-sync timer." So the verification steps are testing for behavior that doesn't exist on this path. The wiring fix itself is correct — it sends the right message — but the plan's description of what happens next is stale.

**NIT — Line references in comments are off.** The code comment at `planning.js:7645` says "Refresh button :7661" but the Refresh button's `refreshTicketsDelta` call is at `:7681`. Minor, but if someone's grepping for line numbers from comments they'll be confused.

### Stage 2 — Balanced Synthesis

**Keep:** The core wiring fix is correct and complete. The picker `change` handler sends `refreshTicketsDelta` with `provider: 'linear'`, `projectId: linearProjectPickerValue` (the project name), and `workspaceRoot: ticketsWorkspaceRoot` — matching the Refresh button (`:7681`) and `linearProjectLoaded` handler (`:4961`) conventions exactly. Cursor key consistency is maintained. The `if (linearProjectPickerValue)` guard correctly prevents sending a message for the "All projects" option. No code fix needed.

**Fix now:** Nothing — the code is correct.

**Defer (documentation):** The verification steps 4-5 should be updated to reflect that manual Refresh/picker-change does a full import (not delta pull). Delta pulls only happen via the auto-sync timer. This is a documentation discrepancy, not a code bug — the actual behavior (full import on manual action) is arguably better for correctness because it runs the prune + deletion sweep.

### Fixes Applied
- None — the code implementation matches the plan's intent.

### Files Changed
- None (code already correct as implemented).

### Validation Results
- **Code inspection:** The picker change handler (`planning.js:7638-7656`) sends the correct message with the correct fields. The backend handler (`PlanningPanelProvider.ts:4865-4932`) processes it correctly. The `linearProjectLoaded` handler (`planning.js:4936-4968`) and Refresh button (`planning.js:7675-7700`) use the same convention.
- **No compilation step** (per session directives).
- **No automated tests** (per session directives).

### Remaining Risks
- **Low:** Verification steps 4-5 in the plan describe delta-pull behavior that doesn't occur on the manual Refresh path (full import instead). This is a documentation issue only — the code works correctly. The auto-sync timer does use delta pulls.
- **Low:** Comment line-number references are slightly stale due to code shifts.
