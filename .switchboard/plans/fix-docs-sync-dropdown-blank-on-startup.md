# Fix: Docs Tab Sync Dropdown Blank on Startup

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

## Metadata
**Complexity:** 3
**Tags:** frontend, backend, bugfix, ui

## User Review Required
No — all changes are defensive guards and fallbacks. No behavior change for valid configurations. The cosmetic label rename ("No Sync (Manual Only)" → "Manual") is the only user-visible change and is low-risk.

## Complexity Audit

### Routine
- Adding `selected` attribute to an `<option>` element (1-line HTML change)
- Adding a validation guard before `select.value = msg.mode` in the webview JS
- Wrapping an existing handler in try/catch following an established pattern (neighbor `getSyncConfig` handler at line 4771)
- Adding a validation guard in `setPlanningPanelSyncMode` to reject invalid mode strings before writing to DB

### Complex / Risky
- None. All changes are independent defensive guards. No architectural shifts, no state machine changes, no data migrations.

## Edge-Case & Dependency Audit

**Race Conditions:** The `planningPanelSyncModeReady` message is async. If the user changes the dropdown before the backend response arrives, the response could override their selection. This is a pre-existing condition — the fix does not introduce or worsen it. The HTML `selected` attribute on the default option mitigates the visual impact of a late/no response.

**Security:** The `setPlanningPanelSyncMode` handler accepts any string from the webview and stores it in the DB. While the webview is not an external attack surface, a buggy or stale message could write garbage. The added validation on the write side closes this gap.

**Side Effects:** The label rename from "No Sync (Manual Only)" to "Manual" is purely cosmetic — no code references the option text, only the `value` attribute. Verified via grep: the label string appears only in `planning.html:3077`.

**Dependencies & Conflicts:** No dependencies on other plans or sessions. The `triggerSync` method at line 6761 already handles unknown modes gracefully (does nothing for unrecognized values), so an invalid mode stored in the DB would not crash sync — it would only blank the dropdown, which is the bug being fixed.

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) the write side (`setPlanningPanelSyncMode` at line 4805) accepts any string and stores it in the DB — the original plan only guarded the read side, leaving the door open for garbage to re-enter on every mode change; (2) the missing try/catch on `getPlanningPanelSyncMode` could cause an unhandled promise rejection in the extension host if `_resolveSyncConfig()` throws, not just a missing UI response. Mitigations: validate mode against the three known values on both read and write paths; wrap the backend handler in try/catch with a `no-sync` fallback response.

## Proposed Changes

### src/webview/planning.html
**Lines:** 3077-3079

**Context:** The `#docs-cache-mode` select has three options but none has a `selected` attribute. The browser defaults to the first option, but if `select.value` is set to an invalid value via JS, the select goes blank (`selectedIndex = -1`).

**Implementation:**
- Add `selected` attribute to the `no-sync` `<option>` so the select always has a visible default even if the backend message never arrives or arrives late.
- Rename the option label from `No Sync (Manual Only)` to `Manual` (cosmetic clarification — no code references the label text).

```html
<option value="no-sync" selected>Manual</option>
<option value="auto-sync-all">Auto Sync All</option>
<option value="sync-selected">Sync Selected Containers</option>
```

**Edge Cases:** If the backend never sends `planningPanelSyncModeReady`, the select shows "Manual" by default. This is correct — `no-sync` is the intended default behavior.

### src/webview/planning.js
**Lines:** 2762-2774

**Context:** The `planningPanelSyncModeReady` case at line 2762 does `select.value = msg.mode` with no validation. If `msg.mode` is any value not in the option set, the select goes blank.

**Implementation:**
- Validate `msg.mode` against the three known values before assigning. Fall back to `'no-sync'` if no match.

```javascript
case 'planningPanelSyncModeReady': {
    const validModes = ['no-sync', 'auto-sync-all', 'sync-selected'];
    const mode = validModes.includes(msg.mode) ? msg.mode : 'no-sync';
    const select = document.getElementById('docs-cache-mode');
    if (select) {
        select.value = mode;
    }
    const picker = document.getElementById('docs-sync-container-picker');
    if (picker) {
        picker.style.display = mode === 'sync-selected' ? 'flex' : 'none';
    }
    if (mode === 'sync-selected') {
        vscode.postMessage({ type: 'fetchAvailableSyncContainers' });
    }
    break;
}
```

**Edge Cases:** If `msg.mode` is `undefined`, `null`, or an unrecognized string, the dropdown falls back to "Manual" and the container picker stays hidden. This is correct.

### src/services/PlanningPanelProvider.ts — `getPlanningPanelSyncMode` (read side)
**Lines:** 4783-4797

**Context:** The `getPlanningPanelSyncMode` handler has no try/catch (unlike the neighboring `getSyncConfig` handler at line 4771). If `_resolveSyncConfig()` or `db.getConfig()` throws, the promise rejects unhandled — potential extension host crash. Additionally, a stale/corrupted `planning.syncMode` value from the DB passes through unchecked.

**Implementation:**
- Wrap the entire case in try/catch (matching the pattern of `getSyncConfig` at line 4771).
- On error, still send `planningPanelSyncModeReady` with `mode: 'no-sync'` so the webview always gets a response.
- Validate the DB value against the three known options before sending; fall back to `'no-sync'` for any unrecognized value.

```typescript
case 'getPlanningPanelSyncMode': {
    try {
        const { sourceRoot } = await this._resolveSyncConfig();
        const resolvedRoot = sourceRoot || this._getWorkspaceRoot() || allRoots[0];
        if (!resolvedRoot) {
            this._panel?.webview.postMessage({
                type: 'planningPanelSyncModeReady',
                mode: 'no-sync',
                selectedContainers: []
            });
            break;
        }
        const db = KanbanDatabase.forWorkspace(resolvedRoot);
        const rawMode = await db.getConfig('planning.syncMode') || 'no-sync';
        const validModes = ['no-sync', 'auto-sync-all', 'sync-selected'];
        const mode = validModes.includes(rawMode) ? rawMode : 'no-sync';
        const selectedContainers = await db.getConfigJson<string[]>('planning.selectedContainers', []);
        this._panel?.webview.postMessage({
            type: 'planningPanelSyncModeReady',
            mode,
            selectedContainers
        });
    } catch (err) {
        this._panel?.webview.postMessage({
            type: 'planningPanelSyncModeReady',
            mode: 'no-sync',
            selectedContainers: []
        });
    }
    break;
}
```

**Edge Cases:** If `resolvedRoot` is falsy (no workspace root available), the original code silently broke out of the switch with no message. The improved version sends a `no-sync` fallback so the webview always receives a response.

### src/services/PlanningPanelProvider.ts — `setPlanningPanelSyncMode` (write side)
**Lines:** 4799-4810

**Context:** The `setPlanningPanelSyncMode` handler at line 4805 does `const syncMode = typeof msg.mode === 'string' ? msg.mode : 'no-sync'` — this accepts ANY string and stores it in the DB. A buggy or stale webview message could write `planning.syncMode = 'garbage'`, which would then blank the dropdown on next startup. This is the write side of the same bug.

**Implementation:**
- Validate `msg.mode` against the three known values before storing. Fall back to `'no-sync'` for any unrecognized value.

```typescript
case 'setPlanningPanelSyncMode': {
    const validModes = ['no-sync', 'auto-sync-all', 'sync-selected'];
    const syncMode = validModes.includes(msg.mode) ? msg.mode : 'no-sync';
    const { sourceRoot } = await this._resolveSyncConfig();
    const resolvedRoot = sourceRoot || this._getWorkspaceRoot() || allRoots[0];
    if (!resolvedRoot) {
        break;
    }
    const db = KanbanDatabase.forWorkspace(resolvedRoot);
    await db.setConfig('planning.syncMode', syncMode);
    this._resolvedConfigCache = null;
    await this.triggerSync(resolvedRoot, syncMode);
    break;
}
```

**Edge Cases:** `triggerSync` at line 6761 already handles unknown modes gracefully (does nothing for unrecognized values), so even if an invalid mode somehow reached `triggerSync`, it would not crash. The validation here prevents garbage from entering the DB in the first place.

## Files Changed
- `src/webview/planning.html` (1 line — add `selected` attribute, rename label)
- `src/webview/planning.js` (~5 lines — add validation guard)
- `src/services/PlanningPanelProvider.ts` (~20 lines — try/catch + validation on read side, validation on write side)

## Verification Plan

### Automated Tests
- **Skipped per session directive.** The user will run the test suite separately.

### Manual Verification
- Open the Planning Panel with no `planning.syncMode` in the DB → dropdown should show "Manual".
- Set a corrupted/invalid value in the DB (e.g., `planning.syncMode = 'garbage'`) → dropdown should still show "Manual".
- Switch to another tab and back → dropdown should remain correct.
- Select each of the three options → dropdown should display the selected option text after closing.
- Simulate a backend error (e.g., temporarily throw in `_resolveSyncConfig`) → dropdown should show "Manual" (not blank), and no unhandled rejection should appear in the extension host output.
- Send a `setPlanningPanelSyncMode` message with an invalid mode (e.g., `{ type: 'setPlanningPanelSyncMode', mode: 'garbage' }`) → DB should store `no-sync`, not `garbage`.

## Recommendation
Complexity 3 → **Send to Intern**
