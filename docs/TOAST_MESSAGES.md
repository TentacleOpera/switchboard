# Switchboard Toast Messages Reference

> Auto-generated inventory of all VS Code notification toasts triggered by the Switchboard extension.
> Source: `src/` directory, excluding test files.

---

## Information Messages (54)

| # | Message |
|---|---------|
| 1 | `Plan completed.` |
| 2 | `Plan deleted.` |
| 3 | `Coder prompt copied to clipboard.` |
| 4 | `Lead prompt copied to clipboard (IDE mode).` |
| 5 | `Lead prompt copied. Paste to IDE chat, then click below for Coder prompt.` |
| 6 | `ClickUp API token saved securely.` |
| 7 | `Linear API token saved securely.` |
| 8 | `Notion API token saved securely.` |
| 9 | `Only one database found. Nothing to reconcile.` |
| 10 | `Prompt settings exported to .switchboard/settings.json` |
| 11 | `Prompt settings imported from .switchboard/settings.json` |
| 12 | `Switchboard housekeeping complete.` |
| 13 | `Switchboard working memory cleaned.` |
| 14 | `Live sync started — plans will sync to enabled integrations when edited.` |
| 15 | `Live sync stopped.` |
| 16 | `Kanban database was updated by another machine. Reloading…` |
| 17 | `No CREATED plans available for batch planner prompt.` |
| 18 | `No LOW-complexity PLAN REVIEWED plans available for Jules dispatch.` |
| 19 | `No LOW-complexity PLAN REVIEWED plans available for batch coding prompt.` |
| 20 | `No matching plans found for prompt generation.` |
| 21 | `No matching plans found.` |
| 22 | `No plans in Reviewed to complete.` |
| 23 | `No registered terminals to focus.` |
| 24 | `Pair Programming: Routine tasks identified. Click to copy Coder prompt.` |
| 25 | `Pair Programming: Routine tasks ready. Copy Coder prompt?` |
| 26 | `Complex prompt copied to clipboard. Dispatching Routine tasks to Coder terminal...` |
| 27 | `Merge prompt copied for ${validPlans.length} plans.` |
| 28 | `Code map dispatched for ${succeeded}/${msg.sessionIds.length} plan(s).${failMsg}` |
| 29 | `Completed ${successCount} of ${msg.sessionIds.length} plans.` |
| 30 | `Completed ${successCount} of ${reviewedCards.length} plans.` |
| 31 | `Dispatched ${dispatchedCount} LOW-complexity plans to Jules.` |
| 32 | `Dispatched ${dispatchedCount} plans to Jules.` |
| 33 | `Dispatched ${eligibleSessionIds.length} plan(s) to Splitter.` |
| 34 | `Planning chat prompt copied to clipboard${planWord}.` |
| 35 | `Recovered ${successCount} of ${msg.sessionIds.length} plans.` |
| 36 | `Sent ${msg.sessionIds.length} plan(s) to planner for re-plan (improve-plan).` |
| 37 | `Successfully reassigned ${successCount} plan${successCount === 1 ? '' : 's'} to the target workspace.` |
| 38 | `Kanban database reset. ${restoredPart}Imported ${importResult.count} plan(s) from .switchboard/plans/.` |
| 39 | `↩ Recovered ${recovered} plan(s).` |
| 40 | `✅ Reconciliation complete. ${merged} plans merged.` |
| 41 | `📦 Archived ${archived} plan(s) to DuckDB.` |
| 42 | `Control Plane workspace created at ${workspaceFilePath}.` |
| 43 | `Create the "${folderName}" folder in the My Drive folder then click Continue.` |
| 44 | `Copied prompt for ${sourceCards.length} plans. No next column to advance to.` |
| 45 | `Document path copied to clipboard: ${docPath}` |
| 46 | `Agent Grid initialized: ${agents.map(a => a.name).join(', ')}` |
| 47 | `Live sync skipped for "${plan.topic || sessionId}": ${syncResult.reason}. Enable real-time sync in Setup to activate.` |
| 48 | `Notion design doc fetched (${result.charCount?.toLocaleString()} chars).` |
| 49 | `No plans in ${column} for prompt generation.` |
| 50 | `No plans in ${column} to move.` |
| 51 | `Testing failure prompt copied and ${sourceCards.length} plan(s) moved to Lead Coder. ${verb}` |
| 52 | `${movedMsg}${skippedCount} plan(s) skipped (unknown complexity). Enable in setup to allow auto-moving.` |
| 53 | `Switchboard: Set up a Control Plane in your GitHub folder? All config stays outside your repos — no .gitignore needed.` |

---

## Warning Messages (88)

| # | Message |
|---|---------|
| 1 | `Please select a workspace in the kanban board first.` |
| 2 | `Select a workspace in the kanban board first.` |
| 3 | `No workspace folder found.` |
| 4 | `No workspace selected.` |
| 5 | `No workspace root found.` |
| 6 | `No planner agent found. Set one up in the Setup panel.` |
| 7 | `Planner agent is currently disabled in setup.` |
| 8 | `Splitter agent is currently disabled in setup.` |
| 9 | `Jules is currently disabled in setup.` |
| 10 | `ClickUp is not configured. Open the Setup panel first.` |
| 11 | `Linear is not configured. Open the Setup panel first.` |
| 12 | `Set up ClickUp before configuring auto-pull.` |
| 13 | `Set up Linear before configuring auto-pull.` |
| 14 | `Archive path not configured. Please set it in the Database Operations panel first.` |
| 15 | `DuckDB CLI not found. Please install DuckDB to use the archive feature.` |
| 16 | `No valid plans found to archive.` |
| 17 | `No settings file found at .switchboard/settings.json` |
| 18 | `No Notion design doc URL configured. Set one in Switchboard settings.` |
| 19 | `Clipboard is empty. Copy a Markdown plan first.` |
| 20 | `Clipboard content is too large (>200 KB). Aborting import.` |
| 21 | `No valid plans found in clipboard content.` |
| 22 | `Nothing to copy to the clipboard.` |
| 23 | `Plan file not found: ${planPath}` |
| 24 | `Failed to access one or both workspace databases.` |
| 25 | `Cannot determine source workspace for reassignment.` |
| 26 | `Cannot determine workspace IDs for reassignment.` |
| 27 | `Source and target workspaces are the same — no plans were moved.` |
| 28 | `No plans were reassigned (0 of ${totalCount}). The plans may not exist in the source workspace.` |
| 29 | `Reassigned ${successCount} of ${totalCount} plans. ${totalCount - successCount} plan(s) failed — check the developer console for details.` |
| 30 | `Both local and cloud databases contain plans.` |
| 31 | `Both the current and target databases contain plans. Automatic migration skipped.` |
| 32 | `Current database is empty but plans were found in the local database. Migrate data?` |
| 33 | `Clear trusted Control Plane auto-detect decisions for this workspace?` |
| 34 | `Clear cached control-plane trust/rejection decisions and re-run auto-detect?` |
| 35 | `This will delete the local Kanban database and rebuild it. If a backup exists, column assignments will be restored first, then plan files will be re-imported. Continue?` |
| 36 | `Reset the kanban database? All plan metadata will be permanently deleted.` |
| 37 | `Merge ${source.label} → ${target.label}? Conflicts resolved by newest updated_at.` |
| 38 | `This will clear all transient Switchboard state (inbox, outbox, sessions, cooldowns) and reset state.json. Active agents will be disconnected.` |
| 39 | `Testing failure report requires feedback.` |
| 40 | `Worktree mode requires an explicit control plane. Configure one in the workspace selector.` |
| 41 | `Worktree used for this plan. Clean it up?` |
| 42 | `iCloud Drive preset is only available on macOS.` |
| 43 | `No active terminal sessions found.` |
| 44 | `The 'Jules Monitor' terminal is monitor-only and cannot receive agent actions.` |
| 45 | `Analyst agent is not available.` |
| 46 | `Jules remote session started, but session details could not be fully parsed from CLI output.` |
| 47 | `Auto-sync failed — Jules send cancelled: ${msg}` |
| 48 | `Jules remote start failed: ${shortDetail || 'unknown error'}.` |
| 49 | `Could not deliver prompt to '${targetAgent}'. The terminal is not running in VS Code.` |
| 50 | `Terminal '${terminalName}' not found. Please open the terminal in VS Code: and try again.` |
| 51 | `Terminal '${terminalName}' not found. It may have been closed.` |
| 52 | `Terminal with PID ${pid} not found.` |
| 53 | `${roleLabel} already has ${MAX_AUTOBAN_TERMINALS_PER_ROLE} autoban terminals.` |
| 54 | `Worktree cap (${maxCap}) reached. Cannot auto-create worktree.` |
| 55 | `${assignedCards.length} plan(s) are assigned to this worktree. Delete anyway?` |
| 56 | `Conflict: Both the local and remote document "${importEntry.docName}" have been modified since the last sync.` |
| 57 | `Conflict detected for plan ${sessionId}. External task was edited.` |
| 58 | `Merge conflict for plan "${plan.topic || plan.sessionId}". Manual resolution required.` |
| 59 | `Code: file conflict for "${plan.topic || plan.sessionId}". Manual resolution required.` |
| 60 | `Plan file conflict for "${plan.topic || plan.sessionId}". Resolve manually in the main branch, then re-press Merge.` |
| 61 | `Live sync for "${planName}" timed out. Will retry.` |
| 62 | `Plan "${plan.topic}" exceeds 100KB limit — live sync disabled for this plan.` |
| 63 | `Plan "${plan.topic}" has unmet dependencies:\n${notReadyList}` |
| 64 | `Notion content truncated — page was too large. Planner will use the first portion.` |
| 65 | `Unable to load external content for plan ${sessionId}.` |
| 66 | `Kanban DB initialization failed: ${initError}. DB-backed views may appear empty until the database is repaired or reset.` |
| 67 | `Kanban DB conflict copies found (${siblings.length}). Check ${dir} and remove stale files.` |
| 68 | `Switchboard: Child workspace "${root}" has a stray .switchboard/kanban.db with active plans. Remove it?` |
| 69 | `Switchboard found an existing sub-repo kanban.db in ${outcome.dir}. Delete it so the Control Plane parent stays authoritative, or keep it and proceed with a warning.` |
| 70 | `No selected plans are currently in the Planned column.` |
| 71 | `Pair Program is only available for PLAN REVIEWED cards.` |
| 72 | `Pair Program: no Coder terminal found. Please register a Coder terminal first.` |
| 73 | `Pair Program: no workspace root found.` |
| 74 | `Please select at least one plan to re-plan.` |
| 75 | `Please select at least one plan to split.` |
| 76 | `Prompt copied but card advance errored. Try refreshing the board.` |
| 77 | `Prompt copied but card could not be advanced. Try refreshing the board.` |
| 78 | `Prompt copied to clipboard but could not dispatch to lead coder. Paste manually.` |
| 79 | `Recover ${count} completed plan(s) back to the active board?` |
| 80 | `Run code map on all ${msg.sessionIds.length} plans in this column?` |
| 81 | `Found ${plans.length} plans in clipboard. Import all?` |
| 82 | `Delete "${docName}" from local docs?` |
| 83 | `Move "${docName}" to trash?` |
| 84 | `Directory not found at ${parentDir}. Create it?` |
| 85 | `Cannot restore: brain file no longer exists at ${entry.brainSourcePath}` |
| 86 | `The "${folderName}" folder does not exist in your cloud storage. This extension cannot create it automatically due to OS restrictions. ${msgSuffix}` |
| 87 | `NotebookLM: No workspace open.` |
| 88 | `NotebookLM: Folder does not exist yet. Click BUNDLE CODE first.` |

---

## Error Messages (62)

| # | Message |
|---|---------|
| 1 | `No agent assigned to role 'analyst'. Please assign a terminal first.` |
| 2 | `No agent assigned to role '${role}'. Please assign a terminal first.` |
| 3 | `No agent assigned to role '${role}'. Cannot dispatch batch.` |
| 4 | `Analyst terminal is not open.` |
| 5 | `Auto-pull interval must be 5, 15, 30, or 60 minutes.` |
| 6 | `Unknown integration for auto-pull settings.` |
| 7 | `Could not locate the plan file to delete. The plan may have already been removed or the runsheet is corrupted.` |
| 8 | `Custom database path cannot be empty.` |
| 9 | `Document not found` |
| 10 | `Failed to open review panel: invalid plan path.` |
| 11 | `Failed to open review panel: no workspace folder found.` |
| 12 | `Kanban provider unavailable. Cannot evaluate plan complexity for batch dispatch.` |
| 13 | `No workspace folder found. Cannot create an autoban terminal.` |
| 14 | `No workspace folder open` |
| 15 | `No workspace root found.` |
| 16 | `Plan not found in registry.` |
| 17 | `Plan path is outside the configured plan-source directories.` |
| 18 | `Review plan path is outside the workspace boundary.` |
| 19 | `Plugin README.md not found.` |
| 20 | `No ClickUp lists are mapped. Update ClickUp in the Setup panel first.` |
| 21 | `Unsupported autoban pool role '${role}'.` |
| 22 | `Unknown role: ${role}` |
| 23 | `Workspace root not found: ${targetWorkspaceRoot}` |
| 24 | `Plan cannot be restored from status "${entry.status}".` |
| 25 | `Plan not found in database for session: ${sessionId}` |
| 26 | `Plan creation failed: ${msg}` |
| 27 | `Notion token is invalid or expired.` |
| 28 | `Failed to import ${failedPlans.length} plan(s). Check output panel for details.` |
| 29 | `Failed to claim plan: ${e}` |
| 30 | `Failed to copy plan link: ${errorMessage}` |
| 31 | `Failed to create directory: ${error instanceof Error ? error.message : String(error)}` |
| 32 | `Failed to delete DB: ${err}` |
| 33 | `Failed to export prompt settings: ${error.message || error}` |
| 34 | `Failed to import prompt settings: ${error.message || error}` |
| 35 | `Failed to link to document: ${String(err)}` |
| 36 | `Failed to mark plan complete: ${e}` |
| 37 | `Failed to open agent terminals: ${msg}` |
| 38 | `Failed to open plan: ${e}` |
| 39 | `Failed to open review panel: ${e}` |
| 40 | `Failed to open review panel: ${message}` |
| 41 | `Failed to send analyst message: ${e}` |
| 42 | `Failed to send message: ${e}` |
| 43 | `Failed to write external content back to plan ${sessionId}: ${error}` |
| 44 | `Folder "${folderName}" still not found. Please create it and try again.` |
| 45 | `Import failed: ${err.message} Run "Switchboard: Reset Kanban Database" to recreate.` |
| 46 | `Import failed: ${result.error}` |
| 47 | `Clipboard import failed: ${msg}` |
| 48 | `Invalid analyst agent name configured: ${targetAgent}` |
| 49 | `Invalid analyst agent name: ${targetAgent}` |
| 50 | `Migration failed: ${result.skipped}` |
| 51 | `NotebookLM export failed: ${msg}` |
| 52 | `NotebookLM send to coder failed: ${msg}` |
| 53 | `NotebookLM sync failed: ${msg}` |
| 54 | `Notion fetch failed: ${result.error}` |
| 55 | `Reconciliation failed: ${err instanceof Error ? err.message : String(err)}` |
| 56 | `Merge failed for session ${sessionId}: ${err.message}` |
| 57 | `Setup panel error: ${errorMessage}` |
| 58 | `Switchboard housekeeping failed: ${msg}` |
| 59 | `Error: ${errorMessage}` |
| 60 | `⚠️ Database test error: ${dbErr.message}` |
| 61 | `❌ Database connection failed: ${error}` |
| 62 | `❌ Invalid path: ${validation.error}` |

---

## Modal Dialogs (InputBox / QuickPick)

These are user-prompt dialogs (not toasts), but triggered through the same VS Code: API:

| Type | Prompt |
|------|--------|
| InputBox | `Enter your ClickUp API token (starts with pk_)` |
| InputBox | `Enter your Linear API token` |
| InputBox | `Enter project name` (placeholder: `e.g. frontend, backend, infrastructure`) |
| InputBox | `Enter your Notion API token` |
| QuickPick | Select ClickUp list to import from |
| QuickPick | Select SOURCE database (copy FROM) |
| QuickPick | Select TARGET database (merge INTO) |
| QuickPick | Select projects |

---

## Source Files by Match Count

| File | Matches |
|------|---------|
| `src/services/TaskViewerProvider.ts` | 98 |
| `src/services/KanbanProvider.ts` | 72 |
| `src/extension.ts` | 56 |
| `src/services/SetupPanelProvider.ts` | 11 |
| `src/services/ContinuousSyncService.ts` | 8 |
| `src/services/PlanningPanelProvider.ts` | 6 |
| `src/services/LinearSyncService.ts` | 3 |
| `src/services/NotionFetchService.ts` | 3 |
| `src/services/PlanningPanelCacheService.ts` | 3 |
| `src/services/ClickUpSyncService.ts` | 2 |
| `src/services/KanbanDatabase.ts` | 2 |
| `src/services/MultiRepoScaffoldingService.ts` | 2 |
| `src/services/ReviewProvider.ts` | 2 |

---

*Total: 211 unique toast/dynamic messages across 13 source files.*
