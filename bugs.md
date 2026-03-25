repeated warning flash:

The UI displays the warning ⚠️ Database unavailable — card positions may not reflect manual
  moves because the KanbanProvider periodically sends a dbUnavailable: true flag to the webview.

  Based on the codebase, this happens due to a failure during the periodic background sync.
  Specifically:

   1. Persistence Race Conditions: When syncing metadata to the database, KanbanDatabase calls
      _persist(), which dumps the entire in-memory database, writes it to a temporary file
      (kanban.db.[Date.now()].tmp), and then renames it to kanban.db. If rapid successive writes
      occur, or if there are file locking issues/collisions with the Date.now() timestamp, the
      rename/write operation fails.
   2. Fallback Triggered: When _persist() fails, the sync functions (syncPlansMetadata or
      updateMetadataBatch) return false.
   3. Warning Displayed: The KanbanProvider catches this false return value, logs
      [KanbanProvider] Kanban DB sync failed, sets dbUnavailable = true, and falls back to a
      file-derived board state. 

  This causes the warning banner to temporarily flash on the board until a subsequent sync
  succeeds.

missing plans: 

Your plans are no longer appearing because they were permanently marked as completed in the
  database due to a bug in how the system handles transient read errors.

  Here is the exact sequence of failure:
   1. Orphan Reconciliation: The KanbanProvider compares your local .switchboard/sessions files
      against the database. If it doesn't see a local file for a database entry (e.g., during a
      transient file-read error), it assumes the card was deleted and permanently marks it as
      completed in the DB.
   2. Missing Resurrection Logic: When your local session files are successfully read again on
      the next sync, the KanbanMigration.syncPlansMetadata function sees that the session IDs


    kanban is sitll relying on md and session files, not displaying an accurate picture of the database:

    he implementation failed its architectural goal. The codebase explicitly comments // 7. Build
  cards directly from DB — DB is the authority, but immediately before that step, it forces the
  database to blindly mirror the file system.

  On every single refresh, the KanbanProvider scans the local .switchboard/sessions folder. If a
  database record doesn't perfectly match a currently existing local file, the code triggers an
  "orphan reconciliation" and permanently marks the database record as completed. 

  It didn't decouple the Kanban board from the file system; it just added a database as a
  fragile caching layer that destructively overwrites its own state whenever a file read
  stutters.

  sidebar is still displaying plans different to the kanban, and is flickering every seocnd. this demonstrates that the plugin is STILL reading its files from files, and is STILL pinging the frontend every second.


1. Why plans still appear in the sidebar:
  The sidebar (TaskViewerProvider) bypasses the database entirely. It reads its list directly
  from the raw JSON files in your .switchboard/sessions/ directory. Because the bug only changed
  their status to completed inside the SQLite database—and never actually deleted your local
  files—the sidebar continues to see them as active plans.

  2. Why the sidebar is flickering:
  You are seeing an infinite file-watcher refresh loop. 
  Because the sidebar relies on the file system and the Kanban board relies on the database, the
  two providers are now completely out of sync. Every time the sidebar reads the files, it sees
  they are missing from the active DB board and tries to "sync" them by updating their metadata
  in the database. 

  This database write triggers the VS Code file system watchers on the .switchboard folder. The
  watcher fires, waits for its debounce timer (about 200-300ms), and calls a full refresh() on
  the sidebar. The sidebar flashes its "loading" state, re-reads the files, attempts another
  database sync, and triggers the watcher all over again in an endless 1-second cycle.


