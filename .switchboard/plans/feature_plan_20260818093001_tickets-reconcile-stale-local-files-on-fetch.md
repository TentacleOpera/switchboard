# Reconcile and Delete Stale Local Ticket Markdown Files on Fetch

## Goal
In `tickets.html`, neither "Refetch" nor "Refresh" deletes stale local markdown (`.md`) files from the workspace tickets directory. When tickets are moved to a different list/project remotely, closed (when closed tickets are excluded), or deleted remotely, the local `.md` files remain on disk indefinitely. Agents consulting `.switchboard/tickets/` find orphaned, out-of-date ticket files and make incorrect assumptions about the current backlog.

The local tickets directory for a selected list or project must be an exact, authoritative mirror of the remote list at the time of fetch, pruning any local files that no longer belong to the remote set.

### Problem & Root Cause Analysis
1. **Delta Pull Skip**: During delta pulls (`isDelta === true`), the cleanup prune in `TaskViewerProvider.importAllTasks` is completely bypassed (`if (!isDelta && targetDir && fetchIsAuthoritative)`).
2. **Over-reliance on Existence Probing (`_confirmRemotelyDeleted`)**: The existing deletion sweep checks candidates via `_confirmRemotelyDeleted` -> `probeTaskExistence(id)`. When a task is moved to another list or project, it still exists in the remote organization, so `probeTaskExistence` returns `'exists'`, preventing deletion of the local file in the previous list's directory.
3. **Subtask Exclusion from Candidates**: `_collectDeletionCandidates` deliberately ignores files containing `parentId:`, meaning subtasks that are deleted or moved remotely are never considered for deletion.
4. **Authoritative Fetch Invariant**: An explicit "Refetch" (or full list sync) is intended to discard local discrepancies and match the remote list exactly. Without full directory reconciliation, stale files accumulate across list renames, moves, and deletions.

> **Superseded:** The original plan proposed introducing a directory reconciliation prune that deletes any `${provider}_*.md` file in `targetDir` whose ID is not in `keepIds`, gated on `fetchIsAuthoritative`, with subtask inclusion in candidates and a locally-modified preservation check.
> **Reason:** That prune already exists verbatim at `TaskViewerProvider.ts` lines 25209-25245 (`if (!isDelta && targetDir && fetchIsAuthoritative)`, `keepIds` set, `${provider}_` prefix scan, `deleteImportedTicket` cache cleanup, mtime grace). A separate per-ticket-probe deletion sweep also already runs on BOTH full pulls (25269) and delta pulls (25315), nominating absent files via `_collectDeletionCandidates` and proving each gone via `_confirmRemotelyDeleted` before unlinking. Root causes #1 and #4 are already addressed for top-level tickets on both pull paths. The plan's Proposed Changes code block was a transcript of already-shipped code, not a proposal.
> **Replaced with:** A surgical retarget to the two surviving gaps: (a) subtask files are still excluded from `_collectDeletionCandidates` (line 24660), so the delta sweep never nominates/probes remotely-deleted subtasks — only the full-pull prune catches them via `keepIds`; (b) the prune's locally-modified preservation runs regardless of `authoritative`, so an explicit Refetch leaves moved-and-edited stale files on disk, contradicting the write-side conflict guard which honours `authoritative`.

## Metadata
- **Complexity:** 4
- **Tags:** backend, bugfix, reliability
- **Project:** Browser Switchboard
- **Feature:** 820d1f5b-f9aa-4e26-84ec-b64a198d3d5c

## User Review Required
No user decision required. The two gaps are well-scoped defects against the plan's own stated invariants; the fix reuses existing probe/sweep machinery with no new design surface.

## Complexity Audit
### Routine
- Removing the `parentId:` skip in `_collectDeletionCandidates` so subtask files are nominated like top-level files (one conditional removal, line 24656-24661).
- Gating the prune's locally-modified preservation on `!authoritative` so an explicit Refetch purges moved-and-edited files (one condition change at 25227).

### Complex / Risky
- Ensuring nominated subtask files are probed against the correct endpoint (subtask id, not parent id) — the existing `_confirmRemotelyDeleted` already probes `candidate.remoteId`, which is the file's own id extracted from the filename, so this is correct by construction but must be verified not to double-probe a parent whose subtask is also nominated.

## Edge-Case & Dependency Audit
- **Network / API Failures**: The deletion sweep is already immune — `_confirmRemotelyDeleted` probes each candidate individually and only unlinks on a positive `'deleted'` verdict; a failed/empty fetch nominates over-broadly but proves each ticket before unlinking. The prune remains gated on `fetchIsAuthoritative` (`fetchComplete && !resolutionFailed && rawItemCount > 0`), so a transient empty fetch never wipes the directory. Both gaps' fixes preserve these guards.
- **Subtask Files**: After the fix, subtask files with `parentId:` frontmatter are nominated by `_collectDeletionCandidates` on delta pulls and proved gone via their own endpoint. On full pulls they are already handled by the prune via `keepIds` (seeded at 25196-25199 from `subtaskItems`). A subtask whose parent was moved but the subtask itself remains remote returns `'exists'` and is kept — correct.
- **Unpushed Local Edits**: On routine "Refresh" (delta, non-authoritative), the sweep does NOT preserve locally-modified files (per the comment at 24782-24784: a remotely-deleted ticket's unpushed edit has nowhere to go) — this is unchanged. On explicit "Refetch" (`authoritative === true`), the prune now also stops preserving locally-modified files, matching the write-side conflict guard (25021) which overwrites modified files on Refetch. A moved-and-edited ticket is now purged on Refetch.
- **Database Cache Sync**: Unchanged — both the prune (25237) and `_applyConfirmedDeletions` (24817) already call `cacheService.deleteImportedTicket(slugPrefix)`.

## Dependencies
- None. This plan targets `TaskViewerProvider.importAllTasks` and `_collectDeletionCandidates` only, both of which are stable shipped code paths with existing tests.

## Adversarial Synthesis
Key risks: (1) nominating subtask files on delta could over-broaden the probe set and burn the `_DELETION_PROBE_CAP` on a list with many subtasks, deferring top-level reconciliation; (2) dropping the modified-preservation on authoritative Refetch could delete a file with unpushed edits the user expected to keep. Mitigations: the probe cap already defers excess candidates to the next refresh (documented at 24762-24767), and authoritative Refetch is the explicit "remote wins" action — the write-side already overwrites modified files on the same flag, so the prune aligning with it is consistency, not a new data-loss vector.

## Proposed Changes

### `src/services/TaskViewerProvider.ts`
- In `_collectDeletionCandidates` (line 24630):
  - **Remove the `parentId:` skip** at lines 24656-24661 so subtask files are nominated for the deletion sweep. The filename-shape extraction at 24663 (`remoteId = fname.slice(filePrefix.length, -3).split('_')[0]`) already yields the subtask's own id, so `_confirmRemotelyDeleted` probes the correct endpoint. Keep the nomination's `remoteIds.has(remoteId)` guard (24638) so a subtask present in the remote payload is still spared.
  - **Clarification (implied, not new scope):** the comment at 24656-24657 ("a separate file with parentId is not a sidebar entry and must not be nominated") described the *sidebar* rendering concern, not the deletion concern — nomination is not deletion, and probing is the safety net. Update the comment to reflect that subtask files ARE nominated and proved individually.

```typescript
// In _collectDeletionCandidates, REPLACE the parentId skip:
//   try {
//       const head = fs.readFileSync(fullPath, 'utf8').slice(0, 2048);
//       if (/^parentId:\s*\S+/m.test(head)) { continue; }
//   } catch { /* ignore unreadable files */ }
// WITH: (no skip — subtask files are nominated and proved gone individually)
// The remoteIds.has(remoteId) guard at `add()` (24638) already spares a
// subtask present in the remote payload; a remotely-deleted subtask is
// nominated, probed via its own endpoint, and unlinked only on 'deleted'.
```

- In `importAllTasks` prune block (line 25209-25245):
  - **Gate the locally-modified preservation on `!authoritative`** at 25227. On an explicit Refetch (`authoritative === true`), the remote state wins — purge stale files even if locally modified, matching the write-side conflict guard (25021) which overwrites modified files on Refetch.

```typescript
// In the prune loop, REPLACE:
//   if (dbEntry && dbEntry.lastSyncedAt) {
//       try {
//           if (fs.statSync(fullPath).mtimeMs > new Date(dbEntry.lastSyncedAt).getTime() + 1000) {
//               continue; // modified — keep it
//           }
//       } catch { /* fall through to delete */ }
//   }
// WITH:
if (!authoritative && dbEntry && dbEntry.lastSyncedAt) {
    try {
        if (fs.statSync(fullPath).mtimeMs > new Date(dbEntry.lastSyncedAt).getTime() + 1000) {
            continue; // modified — keep it (Refetch overrides this)
        }
    } catch { /* fall through to delete */ }
}
```

### `src/services/TicketsPanelProvider.ts`
- No change required. `refreshTicketsDelta` (line 2029) already passes `listId`/`projectId` and the `forceFull`/`authoritative` flags down to `switchboard.importAllTasks`; the original plan's proposed scope-passing change is already live.

## Verification Plan

### Automated Tests
- Run existing ticket sync and delta sweep tests:
  - `npm test src/test/tickets-delta-sweep-gate-regression.test.js`
  - `npm test src/test/verb-engine-tickets-headless.test.js`
- Add unit/integration test verifying that:
  1. A remotely-deleted subtask's `.md` file is removed on a delta Refresh (not just a full Refetch).
  2. A moved-and-locally-edited top-level ticket is purged on an explicit Refetch (`authoritative: true`).
  3. A failed or empty fetch with error does not wipe the tickets directory (existing guard, regression-protect).

### Manual Verification
1. Import a ClickUp list or Linear project with a parent + 2 subtasks.
2. Delete one subtask remotely. Click "Refresh" (delta). Verify the deleted subtask's `.md` is removed from disk and the sidebar.
3. Move a top-level ticket to another list remotely, then locally edit its file. Click "Refetch". Verify the moved-and-edited file is purged from the original list directory.
