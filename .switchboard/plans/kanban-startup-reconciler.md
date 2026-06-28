# Kanban Startup Reconciler for Remote Plan Status Changes

## Goal

Add a startup reconciliation step to the Switchboard extension that queries Linear/Notion on IDE load, detects plan statuses updated by a remote agent since the last sync, and advances the corresponding kanban cards in `kanban.db` — without requiring a manual card move or a git pull.

### Problem & Background

When a remote agent uses `/improve-remote-plan`, it writes improved content and updates the plan status in Linear/Notion. But the Switchboard extension only processes Linear/Notion status changes in "active polling" mode — which assumes the local machine is running and the user is actively working. When the machine was off, those status changes accumulate unprocessed. On next IDE startup, the extension loads `kanban.db` from disk, which has stale column state — the cards are still in their pre-remote-session column.

There is no timing problem with a startup reconciler (unlike a local `pending-moves.json` file) because the extension queries Linear/Notion directly during startup, not from the filesystem. The remote state is always available regardless of git pull order.

The natural insertion point is `initializeKanbanDbOnStartup()` in `src/services/TaskViewerProvider.ts` (line 2491), which already runs after the kanban DB is loaded and before the webview renders.

---

## Implementation Tasks

### 1. Identify the sync timestamp

The reconciler needs to know what "since last sync" means. Options:
- Read the `last_remote_sync` timestamp from `kanban.db` config table (key already used by the existing polling sync)
- Fall back to "last 7 days" if no timestamp exists (covers the case where polling was never run)

Use whichever timestamp the existing polling sync already writes — do not create a new timestamp key unless one doesn't exist.

### 2. Add `reconcileRemoteStatusChanges()` to TaskViewerProvider

**Location:** `src/services/TaskViewerProvider.ts`

**Call site:** At the end of `initializeKanbanDbOnStartup()`, after the existing plan import logic.

**Logic:**
```
reconcileRemoteStatusChanges(db, workspaceRoot):
  1. Check if remote control is configured and enabled for this workspace
     - Read remote config from kanban.db (key: remote.config)
     - If not configured or disabled: return immediately (no-op)
  2. Determine since-timestamp (last_remote_sync or 7-day fallback)
  3. Query Linear/Notion for issues in the mapped project updated since that timestamp
     - Use the existing remote control service/client (do not create new API wrappers)
     - Filter to issues whose status changed (not just description edits)
  4. For each changed issue:
     a. Find matching kanban card by Linear issue ID or plan file path stored in the card's metadata
     b. If found: move card to the column mapped to the new Linear/Notion status
     c. If not found: log a warning, skip (do not create a new card — that's the file watcher's job)
  5. Update last_remote_sync timestamp in kanban.db
  6. Log a summary: "Startup reconciler: N cards advanced from remote status changes"
```

### 3. Reuse existing remote control client

The extension already has a Linear/Notion client used by the polling sync. The reconciler must use the same client and the same status→column mapping logic — do not duplicate it. Identify the service class handling remote polling (likely in `src/services/` or `src/remote/`) and call it from the reconciler.

### 4. Startup mode flag

The reconciler runs once at startup and then stops. It must not start a polling interval. Add a clear comment distinguishing it from the active polling mode.

---

## Edge Cases & Risks

- **Remote control not configured**: Must be a clean no-op — no error, no warning, just skip
- **Network unavailable at startup**: Wrap the Linear/Notion query in a try/catch; log the failure but do not block the rest of startup
- **Card not found for a changed issue**: This can happen if the plan was created remotely and hasn't been imported to kanban.db yet. Log it, skip it — the file watcher or next polling cycle will handle import
- **Multiple status changes since last sync**: Apply the latest status only (the issue's current state), not intermediate transitions
- **Timestamp drift**: If the local machine clock differs significantly from Linear/Notion server time, the since-timestamp filter may miss changes. Use a small buffer (e.g. subtract 5 minutes from last_remote_sync)
- **Rate limits**: The startup query is a single list call per workspace — well within Linear/Notion limits. Do not paginate unnecessarily; limit to recently updated issues

---

## Out of Scope

- Creating new kanban cards for remotely-created plans (handled by the existing file watcher / plan import)
- Syncing plan content changes back to `.md` files (the remote plan stays in Linear/Notion)
- ClickUp support (follow-on)
- Changing the active polling mode

---

## Metadata

**Complexity:** 4
**Tags:** backend, infrastructure, reliability, feature
