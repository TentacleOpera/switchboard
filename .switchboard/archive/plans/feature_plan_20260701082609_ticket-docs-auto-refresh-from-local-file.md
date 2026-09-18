# Auto-Refresh Ticket Docs from Local File in Planning Tab

## Goal

The Tickets tab in `planning.html` must always display the current contents of the
ticket's local `.md` file — not a stale in-memory snapshot. When an external agent
edits the ticket file on disk, the open ticket detail in the Tickets tab should
update automatically (or at minimum on the next ticket selection / tab focus),
without requiring a full Refresh + re-import.

### Problem Analysis & Root Cause

The user reports: an agent edits a ticket, but the Tickets tab still shows the old
content, "even though it SHOULD just be displaying the local file." This has been
requested repeatedly.

**Investigation findings:**

1. A file watcher DOES exist: `_setupTicketsViewWatcher` in
   `PlanningPanelProvider.ts` (line ~8568) watches `*.md` files in the ticket save
   locations and posts a `ticketFileChanged` message to the webview. The webview
   handler (`planning.js` line ~4576) updates the in-memory detail cache and calls
   `renderTicketsTab()`.

2. **However, the display is cache-driven, not file-driven.** When a ticket card is
   clicked (`planning.js` line ~8180), the click handler checks
   `cachedLinear.detailsFetched` / `cachedClickUp.detailsFetched`. If `true`, it
   short-circuits to the cache and **never sends `readLocalTicketFile`** — i.e. it
   never re-reads the local file. The description shown is the snapshot captured the
   first time the ticket was loaded. The `detailsFetched` flag is intended to avoid
   re-fetching comments/attachments from the API, but it also suppresses the local
   file re-read, so the description goes stale.

3. **The file watcher is the only refresh path for external edits, and it is
   unreliable for that use case.** `vscode.workspace.createFileSystemWatcher` has
   known limitations for edits made by external processes (atomic write-and-rename,
   paths outside the workspace folder, platform edge cases). When the watcher misses
   an event, the cache is permanently stale until a manual full Refresh.

**Root cause:** The ticket description is served from an in-memory cache
(`linearIssueDetailCache` / `clickUpTaskDetailCache`) that is only refreshed by an
unreliable file-watcher push. There is no "read fresh from disk on selection / on
tab focus" path once `detailsFetched` is set. The user's expectation that the tab
"just displays the local file" is not met.

## Metadata

- **Tags:** frontend, ui, ux, bugfix, feature
- **Complexity:** 4/10

## User Review Required

Yes — confirm the 4-second safety-net poll interval is acceptable (vs. a longer
interval such as 8–10s) and that polling only while the Tickets tab is active is the
desired behaviour (as opposed to polling whenever a ticket is selected regardless of
tab visibility). Also confirm that tickets without a local `.md` file (subtasks in
drill-down, API-only tickets never imported) should keep showing the cached API
description rather than attempting a re-fetch on every refresh tick.

## Complexity Audit

### Routine
- `readLocalTicketFile` message + `localTicketFileRead` response already re-read the
  file from disk and update the cache + re-render (`planning.js` ~4534,
  `PlanningPanelProvider.ts` ~5453).
- `ticketFileChanged` watcher path already updates the cache + re-renders.
- The change is to (a) call the existing `readLocalTicketFile` path on every ticket
  selection and on tab focus even when `detailsFetched` is true, and (b) add a
  lightweight safety-net poll while the tab is active. No new backend endpoints, no
  data-model changes, no migrations.
- The `_lastTicketsDetailContentHtml` (Linear, line ~9249) and
  `_lastTicketsClickUpDetailContentHtml` (ClickUp, line ~9748) short-circuits
  already prevent redundant DOM writes when rendered HTML is unchanged, so the poll
  produces no flicker on identical content for either provider.
- The failure-fallback guard (Change #6) is a 3-line conditional inside the existing
  `localTicketFileRead` handler — no new pattern.

### Complex / Risky
- **Failure-fallback API spam / view wipe (mitigated by Change #6):** The existing
  `localTicketFileRead` `success: false` branch calls
  `loadLinearTaskDetails` / `loadClickUpTaskDetails`, which null out the selected
  issue and fire an API fetch. Without the guard, the new poll + always-read-on-select
  would re-trigger this every 4s for any ticket without a local file (subtasks in
  drill-down, deleted files, never-imported tickets), causing API rate-limit spam and
  a flickering wipe of comments/attachments. Change #6 gates the fallback on
  `detailsFetched === false` so it only fires when the API data is genuinely missing.
- Synchronous `fs.readFileSync` on the extension host runs on every poll tick (every
  4s). This is a pre-existing pattern in the `readLocalTicketFile` handler
  (PlanningPanelProvider.ts line ~5467); the poll amplifies its frequency but only
  for a single small `.md` file. Low risk; noted for awareness.

## Edge-Case & Dependency Audit

- **Edit mode active:** When the user is editing a ticket in-place
  (`ticketsEditMode === true`), auto-refresh must NOT clobber the textarea. Skip the
  re-read while edit mode is active; re-read on `exitTicketsEditMode`.
- **No local file yet:** `readLocalTicketFile` already returns `success: false` and
  the webview falls back to a live API fetch (`localTicketFileRead` handler line
  ~4535). This path is preserved **only when `detailsFetched` is false** — see
  Change #6. When `detailsFetched` is already true, a missing local file is a silent
  no-op (the cached API description stays on screen).
- **`localDescription: true` guard:** The `localTicketFileRead` handler sets
  `localDescription: true` so a subsequent API response (for comments/attachments)
  does not overwrite the local description. This must be preserved so re-reading the
  file does not get clobbered by a racing API response.
- **Watcher still useful:** Keep the existing `ticketFileChanged` watcher as the
  primary instant-refresh path; the poll + on-select re-read are safety nets for
  when the watcher misses (external edits).
- **Tab inactive:** The poll should only run while the Tickets tab is the active tab
  (avoid unnecessary work / message traffic when the user is on another tab).
- **Comments/attachments:** Re-reading the local file only refreshes the
  description. Comments/attachments come from the API and are gated by
  `detailsFetched`; do not re-fetch them on every selection.
- **Object identity:** The `ticketFileChanged` handler deliberately avoids
  re-setting the cache when the changed ticket is the current selection and content
  is identical, to preserve object identity. The on-select re-read should similarly
  skip the cache write + re-render when the rendered HTML is unchanged (avoid
  flicker / redundant DOM writes via the existing `_lastTicketsDetailContentHtml`
  short-circuit).
- **Workspace root resolution:** `readLocalTicketFile` already uses
  `_resolveWorkspaceRoot`; no change needed.
- **Subtasks in drill-down:** A subtask selected in drill-down typically has no
  local `.md` file of its own (subtasks are embedded into the parent's file via
  `importTicketSubtasks`, not imported as standalone files). The poll's
  `_refreshSelectedTicketFromFile()` will send `readLocalTicketFile` for the subtask
  id, which returns `success: false`. Change #6 ensures this does NOT wipe the
  displayed subtask detail or spam the API when the subtask's details are already
  cached (`detailsFetched: true`).
- **Poll timer lifecycle:** The poll timer must be cleared on tab-leave (the `else`
  branch of `switchToTab`), in `resetTicketsInMemoryState`, and on webview unload
  (`pagehide` / `beforeunload`) to avoid a leaked interval if the panel is disposed
  without those paths firing.

## Dependencies

- None. This plan is self-contained within `src/webview/planning.js`. No other
  session or plan must complete first.

## Adversarial Synthesis

Key risks: (1) the `localTicketFileRead` failure fallback nulls the selected issue
and fires an API fetch, which the new 4s poll + always-read-on-select would
re-trigger endlessly for any ticket without a local file (subtasks, deleted files,
never-imported tickets) — causing API spam and a flickering wipe of
comments/attachments; (2) synchronous `fs.readFileSync` on the extension host runs
on every poll tick. Mitigations: Change #6 gates the failure fallback on
`detailsFetched === false` so missing local files become a silent no-op when API
data is already cached, defusing both the spam and the flicker in one stroke; the
sync read is a pre-existing pattern amplified only for a single small file and is
acceptable, with the poll restricted to the active tab.

## Proposed Changes

### 1. `src/webview/planning.js` — Always re-read local file on ticket selection

In the ticket-card click handler (~line 8180), send `readLocalTicketFile` on EVERY
selection, regardless of `detailsFetched`. Keep the `detailsFetched` short-circuit
only for the API comment/attachment fetch.

```js
// BEFORE (Linear branch, ~line 8185):
if (cachedLinear && cachedLinear.detailsFetched) {
    selectedLinearIssue = cachedLinear;
    renderTicketsLinearPanel();
} else {
    if (cachedLinear) {
        selectedLinearIssue = cachedLinear;
        renderTicketsLinearPanel();
    }
    vscode.postMessage({ type: 'readLocalTicketFile', provider: 'linear', id: linearId, workspaceRoot: ticketsWorkspaceRoot });
    vscode.postMessage({ type: 'linearLoadTaskDetails', issueId: linearId, workspaceRoot: ticketsWorkspaceRoot || undefined });
}

// AFTER:
// Always read the local file fresh on selection — the local .md is the source of
// truth for the description. Render the cached snapshot instantly (if any) for
// responsiveness, then the localTicketFileRead response updates it.
if (cachedLinear) {
    selectedLinearIssue = cachedLinear;
    renderTicketsLinearPanel();
}
vscode.postMessage({ type: 'readLocalTicketFile', provider: 'linear', id: linearId, workspaceRoot: ticketsWorkspaceRoot });
// Only fetch comments/attachments from the API once per session (detailsFetched).
if (!cachedLinear || !cachedLinear.detailsFetched) {
    vscode.postMessage({ type: 'linearLoadTaskDetails', issueId: linearId, workspaceRoot: ticketsWorkspaceRoot || undefined });
}
```

Apply the same change to the ClickUp branch (~line 8198): always send
`readLocalTicketFile`; gate only the `clickupLoadTaskDetails` API call on
`detailsFetched`.

> **Note:** This change is safe ONLY because Change #6 guards the
> `localTicketFileRead` failure fallback. Without that guard, a ticket with
> `detailsFetched: true` but no local file would hit the failure path, null the
> selection, and re-fetch on every click — a regression. Implement Change #6 in the
> same patch.

### 2. `src/webview/planning.js` — Re-read selected ticket on tab focus

In `switchToTab('tickets')` (~line 1330), after the existing init/load logic, when
the tab is already initialized and a ticket is selected, re-read its local file so
returning to the tab shows current disk content:

```js
if (tabName === 'tickets') {
    if (!ticketsInitialized) {
        initTicketsTab();
        restoreTicketsState();
        ticketsInitialized = true;
    }
    if (lastIntegrationProvider && !ticketsLoadedOnce) {
        if (lastIntegrationProvider === 'clickup') loadClickUpSpaces();
        else if (lastIntegrationProvider === 'linear') loadLinearProject();
        loadLocalTicketFiles();
    } else {
        renderTicketsTab();
        // NEW: re-read the currently-selected ticket's local file on tab focus
        // so an external edit made while the tab was hidden is reflected.
        _refreshSelectedTicketFromFile();
    }
}
```

Add a small helper:

```js
function _refreshSelectedTicketFromFile() {
    if (ticketsEditMode) return; // never clobber an active edit
    if (lastIntegrationProvider === 'linear' && selectedLinearIssue?.issue?.id) {
        vscode.postMessage({ type: 'readLocalTicketFile', provider: 'linear', id: selectedLinearIssue.issue.id, workspaceRoot: ticketsWorkspaceRoot });
    } else if (lastIntegrationProvider === 'clickup' && selectedClickUpIssue?.task?.id) {
        vscode.postMessage({ type: 'readLocalTicketFile', provider: 'clickup', id: selectedClickUpIssue.task.id, workspaceRoot: ticketsWorkspaceRoot });
    }
}
```

### 3. `src/webview/planning.js` — Safety-net poll while tab is active

Add a periodic re-read of the selected ticket's file (every 4s) as a backstop for
watcher misses. Start/stop it with the tab activation so it only runs while the
Tickets tab is visible.

```js
let _ticketsFilePollTimer = null;
function _startTicketsFilePoll() {
    _stopTicketsFilePoll();
    _ticketsFilePollTimer = setInterval(() => {
        if (!isTicketsTabActive()) { _stopTicketsFilePoll(); return; }
        _refreshSelectedTicketFromFile();
    }, 4000);
}
function _stopTicketsFilePoll() {
    if (_ticketsFilePollTimer) { clearInterval(_ticketsFilePollTimer); _ticketsFilePollTimer = null; }
}
```

- Call `_startTicketsFilePoll()` at the end of `switchToTab('tickets')` (after
  init/load).
- Call `_stopTicketsFilePoll()` in the `else` branch of `switchToTab` (when leaving
  the tickets tab) and in `resetTicketsInMemoryState`.
- Add a `window.addEventListener('pagehide', _stopTicketsFilePoll)` (and/or
  `beforeunload`) so the interval is cleared if the webview is disposed without the
  tab-leave path firing.
- The poll re-uses `readLocalTicketFile`; the existing `localTicketFileRead`
  handler skips redundant DOM writes when rendered HTML is unchanged (via
  `_lastTicketsDetailContentHtml` for Linear at line ~9249 and
  `_lastTicketsClickUpDetailContentHtml` for ClickUp at line ~9748), so identical
  content produces no flicker for either provider.
- **Relies on Change #6:** for a selected ticket without a local file, the poll's
  `readLocalTicketFile` returns `success: false`; without the guard this would
  null the selection and fire an API fetch every 4s. Change #6 makes it a no-op
  when `detailsFetched` is true.

### 4. `src/webview/planning.js` — Re-read after exiting edit mode

In `exitTicketsEditMode` (~line 8552), after `renderTicketsTab()`, call
`_refreshSelectedTicketFromFile()` so the view reflects the just-saved file (and any
external edit that landed during the edit session).

### 5. `src/services/PlanningPanelProvider.ts` — No change required

The `readLocalTicketFile` handler (line ~5453) already reads the file fresh from
disk on every call and posts `localTicketFileRead`. The existing
`_setupTicketsViewWatcher` (line ~8568) is retained as the instant-refresh path.
No backend changes needed.

### 6. `src/webview/planning.js` — Guard the `localTicketFileRead` failure fallback (CRITICAL)

**This is the fix for the API-spam / view-wipe regression identified in adversarial
review.** The current `localTicketFileRead` handler (~line 4534) unconditionally
calls `loadLinearTaskDetails` / `loadClickUpTaskDetails` on `success: false`, which
nulls the selected issue and fires an API fetch. With Changes #1 and #3 now sending
`readLocalTicketFile` on every selection and every 4s poll, any ticket without a
local file (subtasks in drill-down, deleted files, never-imported tickets) would
trigger this fallback repeatedly — wiping the displayed comments/attachments and
spamming the API.

Guard the fallback so it only fires when the API data is genuinely missing
(`detailsFetched === false`). When `detailsFetched` is already true, a missing local
file is a silent no-op: the cached API description stays on screen.

```js
// BEFORE (~line 4534):
case 'localTicketFileRead': {
    if (!msg.success) {
        // No local file — fall back to live API fetch
        if (msg.provider === 'clickup') loadClickUpTaskDetails(msg.id);
        else loadLinearTaskDetails(msg.id);
        break;
    }
    // ... existing success path unchanged ...
}

// AFTER:
case 'localTicketFileRead': {
    if (!msg.success) {
        // No local file. Only fall back to a live API fetch when we don't already
        // have cached API details — otherwise (detailsFetched true) the cached
        // description/comments/attachments stay on screen and we avoid re-fetching
        // on every selection / poll tick. This is critical now that readLocalTicketFile
        // is sent on every selection and on the 4s safety-net poll.
        const existing = msg.provider === 'clickup'
            ? clickUpTaskDetailCache.get(msg.id)
            : linearIssueDetailCache.get(msg.id);
        if (!existing || !existing.detailsFetched) {
            if (msg.provider === 'clickup') loadClickUpTaskDetails(msg.id);
            else loadLinearTaskDetails(msg.id);
        }
        break;
    }
    // ... existing success path unchanged ...
}
```

**Edge cases preserved:**
- First-ever selection of a ticket with no local file and no cache: `existing` is
  `undefined` → fallback fires → API fetch proceeds as today.
- Subsequent selections of the same ticket after API details arrived:
  `detailsFetched: true` → no-op → no spam, no flicker.
- Subtask in drill-down with cached details: `detailsFetched: true` → no-op.
- Ticket whose local file was deleted after import but API details are cached:
  `detailsFetched: true` → no-op (API description shown).

## Verification Plan

> **Session constraints:** No compilation step and no automated test run are
> performed in this session. The verification plan below is for manual execution by
> the user (or a later session). `npm run compile` is only needed when producing a
> VSIX for release; `src/` is the source of truth.

### Automated Tests
- None. The Switchboard webview layer has no unit/integration test harness for
  `planning.js` message handlers. Verification is manual via an installed VSIX.

### Manual Verification Steps

1. **Manual — external edit reflects instantly (watcher path):**
   - Open the Tickets tab, select a ticket, observe its description.
   - In a terminal/editor, edit the ticket's local `.md` file and save.
   - Confirm the Tickets tab updates within ~1s (watcher) without clicking Refresh.

2. **Manual — external edit reflects on re-select (cache short-circuit fix):**
   - Select ticket A (loads details, sets `detailsFetched`).
   - Externally edit ticket A's `.md` file in a way the watcher might miss (e.g.
     disable watcher temporarily, or edit via `cat > file` atomic replace).
   - Click ticket B, then click ticket A again.
   - Confirm ticket A now shows the new content (proves the `detailsFetched`
     short-circuit no longer blocks the local-file re-read).

3. **Manual — tab focus refresh:**
   - Select a ticket, switch to the Kanban tab.
   - Externally edit the selected ticket's `.md` file.
   - Switch back to the Tickets tab.
   - Confirm the description reflects the edit (via `_refreshSelectedTicketFromFile`
     on tab focus, or the poll).

4. **Manual — safety-net poll:**
   - With the Tickets tab active and a ticket selected, externally edit the file
     using a method that does not trigger the watcher (e.g. `tee` via a pipe, or
     touch the file with identical mtime tricks if reproducible).
   - Confirm the display updates within ~4s via the poll.

5. **Edit-mode safety:**
   - Enter edit mode on a ticket. Externally edit the file. Confirm the textarea is
     NOT clobbered (poll + tab-focus refresh skip while `ticketsEditMode` is true).
   - Exit edit mode. Confirm the view re-reads the file and shows current content.

6. **No API spam:**
   - Select a ticket whose `detailsFetched` is already true. Confirm no
     `linearLoadTaskDetails` / `clickupLoadTaskDetails` message is sent (only
     `readLocalTicketFile`). Verify via the VS Code developer tools console or by
     monitoring network in the extension host.

7. **No flicker on identical content:**
   - With a ticket selected and the poll running, leave the file unchanged for ~20s.
     Confirm the detail pane does not flicker or re-render (the
     `_lastTicketsDetailContentHtml` / `_lastTicketsClickUpDetailContentHtml`
     short-circuits hold).

8. **No API spam / no wipe for tickets without a local file (Change #6):**
   - Select a subtask inside drill-down (no standalone local `.md` file) whose
     `detailsFetched` is true. Confirm the detail pane does NOT flash to a loading
     state and no `linearLoadTaskDetails` / `clickupLoadTaskDetails` message is sent
     on selection or on any 4s poll tick.
   - Delete a previously-imported ticket's local `.md` file while the ticket is
     selected and `detailsFetched` is true. Confirm the displayed description
     (sourced from the API cache) remains on screen and no API refetch is triggered
     by the poll.
   - Select a ticket with no local file and no cached details (fresh). Confirm the
     API fallback DOES fire once (proving the guard only suppresses redundant
     refetches, not the initial load).

## Review Findings

All six changes verified as correctly implemented in `src/webview/planning.js` (no backend changes needed, confirmed `PlanningPanelProvider.ts` unchanged). Change #6 diverges from the plan's `detailsFetched` guard — uses a simpler `break` on `!msg.success` that relies on the click handler's parallel API dispatch; this is equivalent and avoids a flash-to-empty that the plan's approach would cause. Three NIT-level findings: (1) pre-existing race in `localTicketFileRead` success path (line 4597) — doesn't verify `msg.id` matches current selection, slightly amplified by always-send-on-click but negligible due to sync file read; (2) Change #6 deviation is undocumented but sound; (3) cache object always replaced on poll tick even when content identical — DOM short-circuit prevents flicker. No CRITICAL or MAJOR findings; no code fixes applied. Static verification passed (no compilation/tests per session constraints). Remaining risk: the `localTicketFileRead` race could cause a brief flash of a previous ticket if the user clicks two tickets within a sync-read roundtrip window — defer a guard to a future patch.
