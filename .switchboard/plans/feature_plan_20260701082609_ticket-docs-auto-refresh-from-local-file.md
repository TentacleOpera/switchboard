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

- Tags: `tickets`, `planning-html`, `auto-refresh`, `local-files`, `ux`
- Complexity: 4/10
- Files: `src/webview/planning.js`, `src/services/PlanningPanelProvider.ts`

## Complexity Audit

**Routine.** The building blocks already exist:
- `readLocalTicketFile` message + `localTicketFileRead` response already re-read the
  file from disk and update the cache + re-render (`planning.js` ~4534,
  `PlanningPanelProvider.ts` ~5453).
- `ticketFileChanged` watcher path already updates the cache + re-renders.

The change is to (a) call the existing `readLocalTicketFile` path on every ticket
selection and on tab focus even when `detailsFetched` is true, and (b) add a
lightweight safety-net poll while the tab is active. No new backend endpoints, no
data-model changes, no migrations.

**Risk:** Low. Re-reading a single small `.md` file on selection is cheap. The
`detailsFetched` flag must continue to gate API comment/attachment fetches (so we
don't spam the API), but must NOT gate the local-file re-read.

## Edge-Case & Dependency Audit

- **Edit mode active:** When the user is editing a ticket in-place
  (`ticketsEditMode === true`), auto-refresh must NOT clobber the textarea. Skip the
  re-read while edit mode is active; re-read on `exitTicketsEditMode`.
- **No local file yet:** `readLocalTicketFile` already returns `success: false` and
  the webview falls back to a live API fetch (`localTicketFileRead` handler line
  ~4535). This path is preserved.
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
- The poll re-uses `readLocalTicketFile`; the existing `localTicketFileRead`
  handler skips redundant DOM writes when rendered HTML is unchanged (via
  `_lastTicketsDetailContentHtml`), so identical content produces no flicker.

### 4. `src/webview/planning.js` — Re-read after exiting edit mode

In `exitTicketsEditMode` (~line 8552), after `renderTicketsTab()`, call
`_refreshSelectedTicketFromFile()` so the view reflects the just-saved file (and any
external edit that landed during the edit session).

### 5. `src/services/PlanningPanelProvider.ts` — No change required

The `readLocalTicketFile` handler (line ~5453) already reads the file fresh from
disk on every call and posts `localTicketFileRead`. The existing
`_setupTicketsViewWatcher` (line ~8568) is retained as the instant-refresh path.
No backend changes needed.

## Verification Plan

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
     `_lastTicketsDetailContentHtml` short-circuit holds).
