# Ticket Delete: Local File Not Removed When Remote Is Archived

## Goal

When a user clicks **Delete** on a ticket in the planning.html Tickets tab, the remote ticket (ClickUp task or Linear issue) is archived successfully, but the local imported `.md` file remains on disk. The file should be deleted alongside the remote, and the local files sidebar should refresh to reflect the deletion.

### Problem Analysis

The Tickets tab's Delete button (`btn-delete-ticket`) sends a `deleteTicketConfirmed` message to the extension host, which calls `switchboard.deleteTicket` → `TaskViewerProvider.deleteTicket()`. That method:

1. Calls `_findTicketDocument()` to locate the local `.md` file by scanning the filesystem for a `${provider}_${id}_` prefix.
2. Archives the remote (Linear `archiveIssue` / ClickUp `archiveTask`).
3. If the remote archive succeeds **and** `localFilePath` is non-null, calls `fs.promises.unlink(localFilePath)`.
4. Deletes the DB registry entry via `cacheService.deleteImportedTicket()`.

### Root Cause

**`TaskViewerProvider._findTicketDocument()` is scan-only — it does NOT consult the import registry (DB) first.** It only recursively scans two base directories:
- `config.ticketSaveLocation/<provider>`
- `<resolvedRoot>/.switchboard/tickets/<provider>`

The `resolvedRoot` for the Tickets tab is unreliable: the Tickets tab has no explicit workspace assignment, so `_resolveWorkspaceRoot()` falls back to the Kanban board's currently-selected workspace root. If the Kanban board is pointed at a different workspace than the one where the ticket file was imported, the scan searches the wrong `.switchboard/tickets/<provider>` tree and returns `null`. With `localFilePath === null`, the `unlink` step is silently skipped — the remote is archived but the local file survives.

This exact problem was already identified and fixed in `PlanningPanelProvider._findTicketFilePath()`, which was made **DB-first**: it looks up the absolute file path from `cacheService.getImportBySlugPrefix()` (the same path the sidebar renders from), and only falls back to a filesystem scan if the DB entry is missing or stale. The fallback scan was also expanded to cover **all allowed workspace roots**, not just the single resolved root. That fix was never ported to `TaskViewerProvider._findTicketDocument()`.

A **secondary issue** exists in the webview: the `ticketDeleted` handler in `planning.js` removes the ticket from the remote issues list and re-renders the remote list, but does **not** call `loadLocalTicketFiles()` to refresh the local files sidebar. So even when the file IS deleted from disk, the sidebar shows a stale entry until a manual refresh.

## Metadata

- **Tags:** bug, tickets, planning-panel, local-files, delete
- **Complexity:** 4

## Complexity Audit

**Routine.** The fix mirrors an existing, proven pattern (`PlanningPanelProvider._findTicketFilePath`) in the same codebase. No new abstractions, no architectural changes — just porting the DB-first lookup + expanded root scan to the sibling method, and adding one `loadLocalTicketFiles()` call in the webview. The risk surface is small: the change only affects the delete path, and the DB lookup is strictly more reliable than the scan it replaces.

## Edge-Case & Dependency Audit

| Edge Case / Dependency | Consideration |
|---|---|
| DB entry exists but file was already deleted from disk | `getImportBySlugPrefix` returns a path; `fs.existsSync` check (already in the PlanningPanelProvider version) guards against unlinking a non-existent file. The existing `unlinkErr.code !== 'ENOENT'` guard in `deleteTicket` also silently handles this. |
| No DB entry (legacy/orphan file) | The filesystem scan fallback (expanded to all allowed roots) still covers this — same as today, just with a wider search net. |
| `ticketSaveLocation` reconfigured between import and delete | The DB stores the absolute path at import time, so the DB-first lookup is immune to config drift. The scan fallback also checks the current `ticketSaveLocation`. |
| Multiple workspace roots (multi-root workspace) | The expanded scan iterates `_getAllowedRoots()` (already available on `TaskViewerProvider`), covering all roots — not just the Kanban board's selected one. |
| Webview refresh after delete | Adding `loadLocalTicketFiles()` to the `ticketDeleted` handler ensures the sidebar re-fetches from the DB, which no longer has the entry. |
| Remote archive fails | No change to existing behavior — `localFilePath` lookup happens before the remote call, but `unlink` only runs `if (res.success)`, so a failed remote archive leaves the local file intact (correct). |
| `getImportBySlugPrefix` needs a workspace ID | The method resolves the effective workspace ID internally via `_getEffectiveWorkspaceId`. The cache service is already obtained via `_getCacheService(resolvedRoot)` elsewhere in `deleteTicket`. |

## Proposed Changes

### 1. `src/services/TaskViewerProvider.ts` — Make `_findTicketDocument` DB-first + expand scan roots

Port the DB-first pattern from `PlanningPanelProvider._findTicketFilePath` into `TaskViewerProvider._findTicketDocument`. Add a DB lookup before the filesystem scan, and expand the scan fallback to cover all allowed workspace roots.

**Current code** (lines ~20930–20949):

```typescript
private async _findTicketDocument(resolvedRoot: string, provider: string, id: string): Promise<string | null> {
    // Search recursively for the ticket file by its `${provider}_${id}_` prefix.
    // Don't reconstruct the path from live space/folder/list names—tickets are
    // imported into nested folder hierarchies (sprints, etc.) that won't match.
    const prefix = `${provider}_${id}_`;
    const baseDirs: string[] = [];
    try {
        const config = await GlobalIntegrationConfigService.loadConfig(provider as any);
        if (config && config.ticketSaveLocation) {
            baseDirs.push(path.join(config.ticketSaveLocation, provider));
        }
    } catch { /* ignore */ }
    baseDirs.push(path.join(resolvedRoot, '.switchboard', 'tickets', provider));

    for (const dir of baseDirs) {
        const found = this._scanForTicketFile(dir, prefix);
        if (found) { return found; }
    }
    return null;
}
```

**Replace with:**

```typescript
private async _findTicketDocument(resolvedRoot: string, provider: string, id: string): Promise<string | null> {
    // DB-FIRST. The Tickets sidebar renders every row from the import registry's
    // recorded absolute file_path, so the delete path MUST resolve through the
    // SAME source — otherwise a ticket that's plainly visible in the sidebar
    // survives on disk after delete because the scan-only fallback searched the
    // wrong workspace root (the Tickets tab has no explicit workspace assignment;
    // _resolveWorkspaceRoot falls back to the Kanban board's selected workspace,
    // which may differ from where the file was imported). Mirrors the fix already
    // applied in PlanningPanelProvider._findTicketFilePath.
    try {
        const cacheService = this._getCacheService(resolvedRoot);
        const entry = await cacheService.getImportBySlugPrefix(`${provider}_${id}`);
        if (entry && entry.filePath && fs.existsSync(entry.filePath)) {
            return entry.filePath;
        }
    } catch { /* fall through to filesystem scan */ }

    // Fallback: scan for the `${provider}_${id}_` prefix. Covers legacy/unregistered
    // files and DB rows whose recorded path went stale. Scan the configured global
    // location, then EVERY allowed workspace root's .switchboard/tickets — not just
    // the resolved root — so the scan no longer depends on which workspace the
    // Kanban board happens to point at.
    const prefix = `${provider}_${id}_`;
    const baseDirs: string[] = [];
    try {
        const config = await GlobalIntegrationConfigService.loadConfig(provider as any);
        if (config && config.ticketSaveLocation) {
            baseDirs.push(path.join(config.ticketSaveLocation, provider));
        }
    } catch { /* ignore */ }
    const roots = new Set<string>([resolvedRoot, ...this._getAllowedRoots()]);
    for (const root of roots) {
        baseDirs.push(path.join(root, '.switchboard', 'tickets', provider));
    }

    for (const dir of baseDirs) {
        const found = this._scanForTicketFile(dir, prefix);
        if (found) { return found; }
    }
    return null;
}
```

### 2. `src/webview/planning.js` — Refresh local files sidebar after ticket deletion

In the `ticketDeleted` case (lines ~5398–5416), add a `loadLocalTicketFiles()` call after the remote list is updated, so the local files sidebar drops the deleted entry.

**Current code:**

```javascript
case 'ticketDeleted':
    setTicketsLoadingState(false);
    if (msg.success) {
        showTicketsStatus('Archived/Deleted ✓', false);
        selectedLinearIssue = null;
        selectedClickUpIssue = null;
        if (lastIntegrationProvider === 'linear') {
            linearProjectIssues = linearProjectIssues.filter(i => i.id !== msg.id);
            renderTicketsLinearList();
            renderTicketsLinearTaskDetail();
        } else {
            clickUpProjectIssues = clickUpProjectIssues.filter(t => t.id !== msg.id);
            renderTicketsClickUpList();
            renderTicketsClickUpTaskDetail();
        }
    } else {
        showTicketsStatus(msg.error || 'Failed to delete ticket', true);
    }
    break;
```

**Replace with:**

```javascript
case 'ticketDeleted':
    setTicketsLoadingState(false);
    if (msg.success) {
        showTicketsStatus('Archived/Deleted ✓', false);
        selectedLinearIssue = null;
        selectedClickUpIssue = null;
        if (lastIntegrationProvider === 'linear') {
            linearProjectIssues = linearProjectIssues.filter(i => i.id !== msg.id);
            renderTicketsLinearList();
            renderTicketsLinearTaskDetail();
        } else {
            clickUpProjectIssues = clickUpProjectIssues.filter(t => t.id !== msg.id);
            renderTicketsClickUpList();
            renderTicketsClickUpTaskDetail();
        }
        // Refresh the local files sidebar so the deleted ticket's .md file
        // disappears from the list (the DB entry was removed by deleteTicket).
        loadLocalTicketFiles();
    } else {
        showTicketsStatus(msg.error || 'Failed to delete ticket', true);
    }
    break;
```

## Verification Plan

1. **Build**: Run the extension build (`npm run compile` or equivalent) and confirm no type errors.

2. **Reproduce the original bug first** (pre-fix baseline):
   - Import a ClickUp or Linear ticket into the Tickets tab.
   - Confirm the local `.md` file exists on disk and appears in the local files sidebar.
   - If possible, switch the Kanban board to a different workspace root (to trigger the resolved-root mismatch).
   - Click **Delete** on the ticket.
   - Observe: remote is archived, but the local `.md` file remains on disk.

3. **Apply the fix and verify**:
   - Repeat the same steps.
   - After clicking **Delete**, confirm:
     - The remote ticket is archived (same as before).
     - The local `.md` file is **deleted from disk** (check the filesystem).
     - The local files sidebar **no longer shows** the deleted ticket (no manual refresh needed).
   - Verify with the Kanban board pointed at the **same** workspace root (happy path) — file is deleted.
   - Verify with the Kanban board pointed at a **different** workspace root (the original failure case) — file is still deleted (DB-first lookup finds the absolute path regardless of the board's selected workspace).

4. **Edge cases**:
   - Delete a ticket whose DB entry exists but whose file was already removed manually → no crash, no error (ENOENT is silently handled).
   - Delete a ticket with no DB entry (legacy orphan file on disk) → the expanded filesystem scan finds and deletes it.
   - Delete a ticket when the remote archive fails → local file is NOT deleted (existing `if (res.success)` guard holds).

5. **Regression check**: Verify that `pushTicketEdits` (which also calls `_findTicketDocument`) still works correctly — the DB-first lookup returns the same path the scan would have found, so push-to-remote should be unaffected.

## Review Findings

**Stage 1 (Grumpy Principal Engineer):** Welcome. You ported a pattern. Let's see if you ported the bugs too.
- **NIT** — `_getCacheService(resolvedRoot)` opens the DB for `resolvedRoot` only; if the ticket was imported under a *different* workspace root, the DB-first lookup misses and falls through to the scan. The scan (now expanded to all roots) still finds and deletes the file, but the orphan DB row in the other workspace's kanban.db survives. Same limitation exists in the reference `PlanningPanelProvider._findTicketFilePath` — not a regression, but the "DB-first is immune to config drift" claim in the plan is overstated for the cross-workspace case.
- **NIT** — `loadLocalTicketFiles()` is fire-and-forget in the `ticketDeleted` handler; if the DB-entry deletion at `TaskViewerProvider.ts:21643` fails (caught at 21644), the sidebar re-query returns a stale row pointing at a now-unlinked file. Edge case, pre-existing error-handling gap.
- **NIT** — Reference uses `loadConfigSync`; this port uses async `loadConfig`. Consistent with the pre-existing code in this method, but a stylistic divergence from the reference. Harmless.

**Stage 2 (Balanced):** All three are NITs — no fix warranted now. The primary bug (local file survives delete) is fixed: DB-first resolves the absolute path in the common case, and the expanded all-roots scan catches the cross-workspace fallback. The `if (res.success)` unlink gate, the ENOENT guard, and the `fs.existsSync` check all hold. `loadLocalTicketFiles()` refreshes the sidebar without double-triggering (it posts a separate `listLocalTicketFiles` message distinct from the remote-list re-render). No race: `deleteTicket` fully commits (unlink + DB delete) before sending `ticketDeleted`, so the re-query sees a consistent state.

**Regression audit:** Traced all 3 callers of `_findTicketDocument` — `deleteTicket` (21614), `pushTicketEdits` (20981), `_resolveCommentsJsonDir` (21718). DB-first returns the same path the sidebar renders from; `pushTicketEdits` and `_resolveCommentsJsonDir` get strictly-more-reliable resolution. `getImportBySlugPrefix` returns `ImportedDocEntry` with `filePath` field (confirmed `PlanningPanelCacheService.ts:542`). `_getAllowedRoots` exists (`TaskViewerProvider.ts:2084`). `_getCacheService` returns `PlanningPanelCacheService` with the needed method (`7015`). No orphaned references. No signature change.

**Files changed:** `src/services/TaskViewerProvider.ts` (lines 20930–20969, DB-first + expanded root scan), `src/webview/planning.js` (line 5630, `loadLocalTicketFiles()` in `ticketDeleted` success branch).
**Validation:** Compilation/tests skipped per directive. Code inspection confirms the port matches the reference pattern, all guard clauses hold, and all helper methods exist on the class.
**Remaining risks:** Orphan DB row in cross-workspace delete scenario (NIT, pre-existing in reference). Stale sidebar row if DB-entry deletion fails (NIT, edge case).
