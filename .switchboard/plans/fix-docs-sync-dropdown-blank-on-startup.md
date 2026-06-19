# Fix: Docs Tab Sync Dropdown Blank on Startup

## Metadata
**Complexity:** 3
**Tags:** frontend, backend, bugfix, ui

## Goal

The `#docs-cache-mode` select in the Docs tab renders as an empty black box on initial load. After the user manually selects an option, it works fine. The root cause is that `select.value` is set to a value that doesn't match any `<option>`, causing the browser to set `selectedIndex = -1` (blank).

### Root Cause

1. **No `selected` attribute on any `<option>`** in the HTML — the browser defaults to the first option, but this is fragile.
2. **The `planningPanelSyncModeReady` message handler** at `planning.js:2765` does `select.value = msg.mode` with no validation. If `msg.mode` is any value not in `{no-sync, auto-sync-all, sync-selected}`, the select goes blank.
3. **The backend `getPlanningPanelSyncMode` handler** at `PlanningPanelProvider.ts:4783` has no try/catch (unlike the neighboring `getSyncConfig` handler at line 4771). If `_resolveSyncConfig()` or `db.getConfig()` throws, no `planningPanelSyncModeReady` message is sent at all. The select stays at its HTML default — but if a stale/corrupted `planning.syncMode` value exists in the DB, it passes through unchecked and blanks the select.

### What Each Sync Option Does

- **Manual** — `no-sync`: No automatic syncing. Documents are only cached locally when the user manually imports them. This is the default.

- **Auto Sync All** — `auto-sync-all`: On panel open and every 30 minutes, iterates all connected sources (ClickUp, Linear, Notion, local folder, Antigravity), calls `adapter.listFiles()` to get every document, fetches content for each, and caches them locally via `PlanningPanelCacheService.cacheDocument()`. This is the "sync everything" mode.

- **Sync Selected Containers** — `sync-selected`: Same periodic sync (30 min interval), but only syncs documents from specific "containers" the user picks. A container is a logical grouping per source — e.g., a ClickUp Space, a Linear Team, a Notion page, or the local folder root. When this mode is selected, a container picker UI appears (`#docs-sync-container-picker`) listing available containers from all connected sources. The user checks which containers to sync, and only documents within those containers are fetched and cached. Selected containers are stored in the DB as `planning.selectedContainers` (array of `sourceId:containerId` strings).

## Changes

### 1. HTML — Add `selected` to default option and rename label
**File:** `src/webview/planning.html:3077`
- Add `selected` attribute to the `no-sync` `<option>` so the select always has a visible default even if the backend message never arrives or arrives late.
- Rename the option label from `No Sync (Manual Only)` to `Manual`.

### 2. Webview JS — Validate `msg.mode` before assigning
**File:** `src/webview/planning.js:2762-2766`
- In the `planningPanelSyncModeReady` case, validate `msg.mode` against the three known values (`no-sync`, `auto-sync-all`, `sync-selected`). Fall back to `'no-sync'` if no match.

### 3. Backend — Wrap handler in try/catch, always respond
**File:** `src/services/PlanningPanelProvider.ts:4783-4797`
- Wrap the `getPlanningPanelSyncMode` case in try/catch (matching the pattern of `getSyncConfig` at line 4771).
- On error, still send `planningPanelSyncModeReady` with `mode: 'no-sync'` so the webview always gets a response.
- Validate the DB value against the three known options before sending; fall back to `'no-sync'` for any unrecognized value.

## Files Changed
- `src/webview/planning.html` (1 line)
- `src/webview/planning.js` (~5 lines)
- `src/services/PlanningPanelProvider.ts` (~10 lines)

## Validation
- Open the Planning Panel with no `planning.syncMode` in the DB → dropdown should show "Manual".
- Set a corrupted/invalid value in the DB (e.g., `planning.syncMode = 'garbage'`) → dropdown should still show "Manual".
- Switch to another tab and back → dropdown should remain correct.
- Select each of the three options → dropdown should display the selected option text after closing.

## Risks
- None material. All changes are defensive guards and fallbacks. No behavior change for valid configurations.
