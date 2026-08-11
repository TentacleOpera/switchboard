# Convert-to-subtask must stamp `parentId` into the local ticket file and refresh the sidebar

## Goal

Make "To subtask" (converting an existing ticket into a subtask of another ticket) produce an
immediately visible sidebar change: the converted ticket disappears from the top-level list, and
the parent's cached subtask set includes the new child.

### Problem

Working down a ticket list and re-parenting tickets one by one, the sidebar never changes. Every
converted ticket stays in the top-level list looking exactly as it did before the conversion, so
there is no way to tell which tickets have already been re-parented and which are still to do.
The remote (ClickUp/Linear) *is* updated correctly — only the local view is wrong.

### Root cause — two independent defects, both required for the symptom

**1. The conversion never touches the local ticket file (primary).**

The Tickets sidebar is *file-backed*. `TicketsPanelProvider.listLocalTicketFiles`
(`src/services/TicketsPanelProvider.ts:1981`) builds the list by reading each imported ticket's
`.md` frontmatter and hiding anything that carries a `parentId:` key:

```ts
// src/services/TicketsPanelProvider.ts:2073
const pm = fm[1].match(/^parentId:\s*(.+)$/m);
if (pm) { parentId = pm[1].trim(); }
...
// src/services/TicketsPanelProvider.ts:2098
if (parentId) {
    hiddenBySubtask++;
    continue;
}
```

The identical rule exists on the filesystem-scan fallback path
(`_scanLocalTicketFiles`, `src/services/TicketsPanelProvider.ts:449` — `if (options?.skipSubtasks && parentId) { continue; }`).

`parentId:` is written into the frontmatter **only at import time**, by
`_buildLinearImportPlanContent` (`src/services/TaskViewerProvider.ts:7312`) and
`_buildClickUpImportPlanContent` (`src/services/TaskViewerProvider.ts:7586`).

The `convertToSubtask` verb (`src/services/TicketsPanelProvider.ts:2957`) calls the remote API and
nothing else:

```ts
if (msg.provider === 'clickup') {
    const clickUp = this._adapterFactories.getClickUpSyncService(workspaceRoot);
    await clickUp.updateTask(msg.taskId, { parent: msg.parentId });
} else if (msg.provider === 'linear') {
    const linear = this._adapterFactories.getLinearSyncService(workspaceRoot);
    await linear.updateIssueParent(msg.taskId, msg.parentId);
}
```

So the local `.md` still has no `parentId:`, the subtask-hiding rule never fires for it, and the
sidebar keeps rendering it as a top-level card — permanently, until a full re-fetch happens to
rewrite the file. **The refresh the webview already performs is not the problem; the data it
refreshes from is stale.**

**2. The success handler never invalidates the detail caches (secondary).**

`case 'subtaskConverted'` (`src/webview/tickets.js:7509`) reloads the remote project list:

```js
if (message.provider === 'clickup') { loadClickUpProject(true); }
else { loadLinearProject(true); }
```

It leaves `clickUpTaskDetailCache` / `linearIssueDetailCache` untouched. The parent's cached entry
still holds its pre-conversion `subtasks` array, and the child's entry still has no parent — so
drilling into the parent shows a stale subtask list and the child's "To parent task" control stays
hidden until the panel is reloaded. If drill-down is active, the separately-held
`_drillDownSubtasks` array (`src/webview/tickets.js:138`) is stale for the same reason.

## Metadata

- **Complexity:** 5
- **Tags:** bugfix, frontend, backend, ui

## Complexity Audit (Routine vs Complex/Risky)

**Routine**
- Adding a `parentId:` line to an existing frontmatter block — the same string-splice shape already
  used elsewhere in the ticket file writers.
- Deleting two cache entries in the `subtaskConverted` webview handler.
- Re-listing local files after the write (`loadLocalTicketFiles()` already exists and is already
  called from the project-loaded handlers).

**Complex / Risky**
- **Frontmatter rewriting is a destructive write to a user-visible file.** The ticket `.md` may
  contain a user's local edits that have not been pushed. The rewrite must touch *only* the
  frontmatter block and must never re-serialise or reorder the body. Splice the single line in;
  do not round-trip through a YAML parser.
- **`syncStatus` is derived from file mtime vs `lastSyncedAt`**
  (`_ticketSyncStatusFromTimestamps`, used at `src/services/TicketsPanelProvider.ts:2095`). Writing
  the file bumps its mtime and will flip the ticket's badge to `modified`, falsely claiming the
  user has unpushed local edits. The conversion is a *remote-originated* change, so `lastSyncedAt`
  must be advanced alongside the write.
- **Ticket files with no frontmatter block at all.** Legacy imports predate the frontmatter
  writers; `content.match(/^---\n([\s\S]*?)\n---/)` returns null for them. The rewrite must create
  a block rather than throw or corrupt the file.
- **The file may not exist.** The parent picker can offer tickets that were never imported locally.
  A missing file is not an error — the remote conversion still succeeded.

## Edge-Case & Dependency Audit

| Case | Required behaviour |
| :--- | :--- |
| Ticket `.md` has frontmatter but no `parentId:` | Insert `parentId: <id>` as a new line inside the existing `---` block. |
| Ticket `.md` already has a `parentId:` (re-parenting an existing subtask) | Replace the value in place. Do not append a duplicate key — `listLocalTicketFiles` uses a non-global `match`, so a duplicate key silently wins/loses by position. |
| Ticket `.md` has no frontmatter block | Prepend `---\nparentId: <id>\n---\n` above the existing content. |
| Ticket `.md` does not exist on disk | Skip the write silently. Still report `success: true` — the remote conversion happened. |
| Remote call throws | Do **not** write the file. The existing catch already posts `success: false`. |
| File write throws (permissions, read-only FS) | Still report the conversion as successful, but include a `localFileUpdated: false` field so the webview can surface an honest "converted remotely; local view may be stale" status rather than claiming a clean result. |
| Drill-down is active on the parent when a child is converted into it | `_drillDownSubtasks` must be refreshed, not left stale. Simplest correct move: clear the parent's detail cache and re-fetch details for the drill-down parent. |
| Converted ticket is the currently selected ticket | Its detail cache entry must be dropped so the next selection re-fetches and the "To parent task" control appears. |
| ClickUp file scoped to a different list than the parent | Out of scope — this plan does not change `listId:`. The ticket is hidden as a subtask regardless of scope because the `parentId` check runs *before* the scope check (`src/services/TicketsPanelProvider.ts:2098` precedes `:2102`). |
| The tickets file watcher fires on the rewrite | Harmless: `_scheduleSidebarRefreshFromFiles` (`src/webview/tickets.js:1388`) debounces to one reload per 300ms burst, and it calls the same `loadLocalTicketFiles()` this plan calls explicitly. |

**Dependencies**
- `convertToSubtask` is in the tickets verb allowlist (`src/generated/verbAllowlist.ts:11`) and has a
  schema at `src/services/verbSchemas.ts:1000` requiring `provider`/`taskId`/`parentId`. Adding a
  response field does not touch the request schema — no allowlist or schema change needed.
- `src/test/verb-engine-tickets-headless.test.js:310-330` asserts the `convertToSubtask` payload
  contract. Those assertions must keep passing unchanged.
- `_ticketSyncStatusFromTimestamps` and the imported-tickets cache service
  (`this._cacheService`, `registerImportedTicket`) already exist and are used in this file.

**Shipped-state note:** `parentId:` frontmatter is an already-released key read by two code paths.
This plan only *writes* a key that is already read — no migration is required, and files written
by older versions stay valid.

## Proposed Changes

### 1. `src/services/TicketsPanelProvider.ts` — stamp `parentId` into the local file on conversion

Add a private helper near the other file helpers (e.g. below `_scanLocalTicketFiles`, ~line 458):

```ts
/**
 * Writes/updates the `parentId:` frontmatter key on a ticket's local .md file.
 *
 * The Tickets sidebar is file-backed and hides any ticket whose file carries a
 * `parentId:` (listLocalTicketFiles / _scanLocalTicketFiles). convertToSubtask only
 * mutates the remote, so without this the converted ticket stays visible as a
 * top-level card forever.
 *
 * Splices a single line — never re-serialises the body — because the file may hold
 * unpushed user edits.
 *
 * Returns false when there was no local file to update (not an error).
 */
private _stampTicketParentIdInFile(filePath: string, parentId: string): boolean {
    const nfs = require('fs') as typeof import('fs');
    if (!filePath || !nfs.existsSync(filePath)) { return false; }
    const content = nfs.readFileSync(filePath, 'utf8');
    const fm = content.match(/^---\n([\s\S]*?)\n---/);
    let next: string;
    if (!fm) {
        // Legacy import with no frontmatter block — create one.
        next = `---\nparentId: ${parentId}\n---\n${content}`;
    } else if (/^parentId:\s*.+$/m.test(fm[1])) {
        // Re-parenting an existing subtask: replace in place, never append a
        // second key (the readers use a non-global match).
        const patched = fm[1].replace(/^parentId:\s*.+$/m, `parentId: ${parentId}`);
        next = content.replace(fm[0], `---\n${patched}\n---`);
    } else {
        next = content.replace(fm[0], `---\n${fm[1]}\nparentId: ${parentId}\n---`);
    }
    nfs.writeFileSync(filePath, next, 'utf8');
    return true;
}
```

Then extend `case 'convertToSubtask'` (`src/services/TicketsPanelProvider.ts:2957`) so the success
arm updates the file and re-stamps `lastSyncedAt`:

```ts
                    // The remote is now correct. Mirror the parent into the local .md so the
                    // file-backed sidebar hides it as a subtask on the next list. Without this
                    // the sidebar refreshes but reads unchanged data — the reported bug.
                    let localFileUpdated = false;
                    try {
                        if (!this._cacheService) {
                            this._cacheService = this._adapterFactories.getCacheService(workspaceRoot);
                        }
                        const imported = await this._cacheService.getImportedTickets();
                        const row = imported.find((t: any) => t.slugPrefix === `${msg.provider}_${msg.taskId}`);
                        if (row?.filePath) {
                            localFileUpdated = this._stampTicketParentIdInFile(row.filePath, msg.parentId);
                            if (localFileUpdated) {
                                // The rewrite bumps mtime. syncStatus is derived from
                                // mtime vs lastSyncedAt, so without this the ticket would
                                // falsely badge as `modified` — it has no unpushed edits.
                                await this._cacheService.registerImportedTicket(
                                    msg.provider, msg.taskId, row.docName,
                                    row.slugPrefix, row.filePath, row.url || ''
                                );
                            }
                        }
                    } catch (err) {
                        console.error('[TicketsPanelProvider] convertToSubtask: local file stamp failed:', err);
                    }
                    this.postMessageToWebview({
                        type: 'subtaskConverted',
                        success: true,
                        provider: msg.provider,
                        taskId: msg.taskId,
                        parentId: msg.parentId,
                        localFileUpdated,
                        workspaceRoot
                    });
```

> Verify `registerImportedTicket`'s signature and its `lastSyncedAt` behaviour before wiring it —
> it is the same call the backfill at `src/services/TicketsPanelProvider.ts:2031` uses. If it does
> not refresh `lastSyncedAt`, use whichever cache-service method does (the one the sync path calls
> after a successful push).

### 2. `src/webview/tickets.js` — invalidate caches and reload from files

Replace `case 'subtaskConverted'` (`src/webview/tickets.js:7509`):

```js
            case 'subtaskConverted': {
                const modal = document.getElementById('convert-subtask-modal');
                if (modal) modal.style.display = 'none';
                if (message.success) {
                    showTicketsStatus(
                        message.localFileUpdated === false
                            ? 'Converted remotely; no local file to update'
                            : 'Converted to subtask ✓',
                        false
                    );
                    const cache = message.provider === 'clickup' ? clickUpTaskDetailCache : linearIssueDetailCache;
                    // Both ends of the relationship are now stale: the parent's cached
                    // `subtasks` array predates the new child, and the child's entry still
                    // has no parent (so "To parent task" would stay hidden).
                    cache.delete(message.taskId);
                    cache.delete(message.parentId);
                    if (message.provider === 'clickup') {
                        if (selectedClickUpIssue?.task?.id === message.taskId) { selectedClickUpIssue = null; }
                    } else {
                        if (selectedLinearIssue?.issue?.id === message.taskId) { selectedLinearIssue = null; }
                    }
                    // Drill-down renders from its own array, which the cache delete above
                    // does not touch. Re-fetch the parent so the sibling list gains the
                    // new child instead of silently omitting it.
                    if (_sidebarDrillDownParentId === message.parentId) {
                        _pendingDrillDownParentId = message.parentId;
                        _drillDownSubtasks = null;
                        if (message.provider === 'clickup') { loadClickUpTaskDetails(message.parentId); }
                        else { loadLinearTaskDetails(message.parentId); }
                    }
                    // The sidebar is file-backed — list the files, do NOT re-pull the
                    // remote project (that path repaints from the same local files anyway).
                    loadLocalTicketFiles();
                    renderTicketsTab();
                } else {
                    console.error('Failed to convert to subtask:', message.error);
                    showTicketsStatus(message.error || 'Failed to convert ticket', true);
                }
                break;
            }
```

Note the deliberate removal of `loadClickUpProject(true)` / `loadLinearProject(true)`: those fire a
full remote list pull whose `clickupProjectLoaded` / `linearProjectLoaded` arms
(`src/webview/tickets.js:7069`, `:7095`) end by calling `loadLocalTicketFiles()` regardless. Calling
the file lister directly gets the same sidebar with one fewer round-trip and no spinner flash.

## Verification Plan

**Automated**
1. `npm test` — the existing tickets suites must stay green, in particular
   `src/test/verb-engine-tickets-headless.test.js` (payload contract),
   `src/test/tickets-sidebar-list-scoping.test.js` (subtask/scope hiding rules) and
   `src/test/tickets-auto-refresh-on-file-change.test.js`.
   Per the repo's known state, stash-verify first: confirm which tests are already red at HEAD
   before attributing any failure to this change.
2. New unit test for `_stampTicketParentIdInFile` covering all four file shapes — frontmatter
   without `parentId`, frontmatter with an existing `parentId` (assert exactly one key afterwards),
   no frontmatter block at all, and a non-existent path (returns `false`, throws nothing). Assert
   the body content is byte-identical after the rewrite in the first three cases.

**Manual (installed VSIX — `dist/` is not used for testing)**
3. Tickets tab, ClickUp provider, a scoped list. Select a top-level ticket → control-strip overflow
   → **To subtask** → pick a parent → Confirm.
   - The converted ticket disappears from the sidebar list immediately, with no manual refresh.
   - Its `.md` file now contains `parentId: <parent>` inside the frontmatter block, and the body is
     unchanged.
   - Its sync badge does **not** read `modified`.
4. Drill into the parent (its subtask list). The converted ticket is present as a subtask card.
5. Select the converted ticket. The meta bar shows **To parent task**, and it navigates to the parent.
6. Repeat 3–5 with the Linear provider.
7. Re-parent an already-converted subtask to a different parent. It stays hidden from the top-level
   list, the file has exactly one `parentId:` line, and it now appears under the new parent.
8. Convert a ticket that has no local `.md` file. The modal closes, the status reads
   "Converted remotely; no local file to update", and no error is logged.
