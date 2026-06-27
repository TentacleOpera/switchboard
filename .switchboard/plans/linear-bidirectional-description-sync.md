# Linear Bidirectional Description Sync

## Goal

Make the Linear ↔ Switchboard body/content sync genuinely bidirectional. Currently plan edits push to Linear (via ContinuousSyncService) but Linear description changes are never pulled back — the inbound path only fires when *both* sides changed (conflict dialog). Users who draft or refine plan content in Linear expect it to appear in Switchboard automatically.

## Dependencies

None — builds on existing ContinuousSyncService and RemoteControlService infrastructure.

## Problem Analysis

### Current State: Outbound Only

ContinuousSyncService watches local plan files for changes, debounces 3 seconds (max 60s), and pushes the content to the linked Linear issue description via `issueUpdate` mutation. This works well.

The inbound direction is broken for the common case: `_detectExternalConflict()` in ContinuousSyncService fetches the Linear description but only acts when *both* sides changed. If the user edits in Linear and the local file is untouched, no conflict is detected and the change is silently ignored.

### Root Cause: No Persisted Sync Timestamp Per Issue

`lastSyncAt` in `LiveSyncState` is in-memory only — lost on every extension reload. `fetchIssueUpdates()` in LinearSyncService doesn't fetch `updatedAt` or `description` from Linear, so the remote control poll has no way to detect description changes. There is no persisted "last synced at" per issue to compare against.

### Design: Last-Writer-Wins via Timestamps

On each remote control poll cycle:
- If `issue.updatedAt > persistedCursor` and local file mtime ≤ cursor → **pull** (Linear is newer, local unchanged)
- If `issue.updatedAt > persistedCursor` and local file mtime > cursor → **conflict** (both changed)
- If `issue.updatedAt ≤ cursor` → skip

When ContinuousSyncService pushes to Linear, persist the cursor for that issue so the next poll doesn't re-pull the same content.

Loop prevention: when RemoteControlService writes pulled content to disk, ContinuousSyncService's file watcher fires and would re-push. Guard: before pushing, compare `hash(strippedContent)` against a `markExternallyWritten` hash. If they match, skip the push.

## Implementation

### 1. Extend `fetchIssueUpdates()` — `src/services/LinearSyncService.ts`

Add `updatedAt` and `description` to the GraphQL query and return type. Currently only `state` and `comments` are fetched.

### 2. Persist description-sync cursors — `src/services/KanbanProvider.ts`

Add two methods mirroring the existing `remote.commentCursors` pattern in the DB config table:
- `getDescriptionCursors(): Promise<Record<string, string>>` — reads `remote.descriptionSyncedAt`
- `setDescriptionCursor(issueId: string, timestamp: string): Promise<void>`

### 3. Pull path — `src/services/RemoteControlService.ts`

After existing state-mirror and comment-ingestion steps in `_poll()`, add `_ingestDescription()`:

```
for each card in poll batch:
  cursor = descriptionCursors[issueId] ?? epoch
  if issue.updatedAt <= cursor → skip
  GRACE_MS = 5000
  if localFileMtime > Date(cursor) + GRACE_MS → CONFLICT: notify, skip
  else → PULL:
    read plan file, preserve H1 title
    replace body with issue.description
    write file
    call onDescriptionPulled(issueId, hash(newContent))
    setDescriptionCursor(issueId, issue.updatedAt)
```

Inject into RemoteControlService constructor:
- `getDescriptionCursors`, `setDescriptionCursor` from KanbanProvider
- `onDescriptionPulled: (issueId, contentHash) => void`

### 4. Loop prevention — `src/services/ContinuousSyncService.ts`

- Add `_externallyWrittenHashes: Map<string, string>` (in-memory)
- Add `markExternallyWritten(issueId, hash)` — stores hash; called via `onDescriptionPulled` callback
- In push path: if `hash(strippedContent) === _externallyWrittenHashes.get(issueId)` → skip push, clear entry
- On successful push: call `onDescriptionSynced(issueId, new Date().toISOString())` → persists cursor

### 5. Wire up — `src/services/KanbanProvider.ts`

```typescript
remoteControl = new RemoteControlService({
  ...existingDeps,
  getDescriptionCursors: () => this._getDescriptionCursors(),
  setDescriptionCursor: (id, ts) => this._setDescriptionCursor(id, ts),
  onDescriptionPulled: (issueId, hash) =>
    continuousSyncService?.markExternallyWritten(issueId, hash),
})

continuousSyncService = new ContinuousSyncService({
  ...existingDeps,
  onDescriptionSynced: (issueId, ts) => this._setDescriptionCursor(issueId, ts),
})
```

## Verification

1. **Push path unchanged**: Edit plan locally → ContinuousSyncService pushes → cursor persisted → next poll skips (updatedAt == cursor).
2. **Pull path**: Edit Linear issue description, leave local file untouched → next poll detects change → description written to plan file → no re-push (hash guard).
3. **Conflict path**: Edit both sides between polls → conflict notification shown, no auto-overwrite.
4. **Loop prevention**: After pull, file watcher fires → ContinuousSyncService hash guard triggers → push skipped → no updatedAt bump in Linear → next poll is a no-op.
5. **Reload safety**: Restart extension → cursors loaded from DB → no false positives.

Run: `src/test/integrations/linear/linear-sync-service.test.js`, `linear-import-flow.test.js`. Add unit tests for `_ingestDescription()` covering pull, skip, and conflict branches.
