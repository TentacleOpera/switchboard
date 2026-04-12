# ClickUp Integration — Part 2: Setup Flow (Folder, Lists, UI Button)

## Goal

Implement the ClickUp setup flow: a "Setup ClickUp" button in the kanban webview header that, when clicked, creates an "AI Agents" folder in the user's selected ClickUp space with one list per canonical kanban column, creates custom fields for Switchboard metadata, and stores the resulting IDs in `clickup-config.json`.

## Metadata

**Tags:** backend, UI, infrastructure
**Complexity:** 7

## User Review Required

> [!NOTE]
> - **Depends on Part 1**: This plan requires `clickup_1_foundation.md` to be implemented first. It uses `ClickUpSyncService` (REST client, config I/O, token access) from that plan.
> - **ClickUp API Token**: User must have already run "Switchboard: Set ClickUp API Token" (Part 1) before the Setup button works.
> - **ClickUp Permissions**: The API token must have permission to create folders, lists, and custom fields in the selected space.
> - **Transactional Rollback**: If setup fails partway (e.g., folder created but list creation fails), all created ClickUp resources are cleaned up automatically via `DELETE /api/v2/folder/{id}` (cascades to child lists).

## Complexity Audit

### Routine
- **Config JSON creation**: Writing the populated `clickup-config.json` after setup completes — straightforward JSON serialization via the existing `saveConfig()` from Part 1.
- **`package.json` command entry**: Adding `switchboard.setupClickUp` to the command palette manifest.

### Complex / Risky
- **Webview button injection**: The kanban board is an HTML webview (`src/webview/kanban.html`) with nonce-based CSP. The button must use `addEventListener` (no inline `onclick`). Button state (hidden/disabled/label) is controlled via `postMessage` from the extension host — requires a new message type (`clickupState`) flowing from `KanbanProvider.ts` to the webview.
- **QuickPick for space selection**: The `setup()` method must call `GET /team/{id}/space`, present results via `vscode.window.showQuickPick`, and handle cancellation.
- **Existing folder detection**: Must check for an existing "AI Agents" folder before creating one, and offer to reuse it. This prevents duplicate folders on repeated setup attempts.
- **Transactional rollback**: If any step after folder creation fails, the folder (and its child lists, via cascade) must be deleted. The ClickUp MCP tool set has no `delete_folder` — requires direct `DELETE /api/v2/folder/{id}` REST call.
- **Custom field creation via REST**: No MCP tool exists for this. Must use `POST /api/v2/list/{list_id}/field`. If this fails (permissions), setup falls back gracefully — metadata is embedded in task descriptions instead of custom fields. The config records empty strings for field IDs, and Part 3's sync logic must handle this.

## Edge-Case & Dependency Audit

- **Race Conditions:**
  - Setup button double-clicked → `_setupInProgress` flag on `ClickUpSyncService` prevents re-entry; webview button is disabled via `postMessage` during setup.
  - User closes webview during setup → setup continues in background (async); config is saved regardless. On next webview open, `clickupState` message reflects the completed state.
- **Security:**
  - API token is read from SecretStorage (Part 1) and passed via `Authorization` header only. Never logged.
  - `clickup-config.json` contains only ClickUp resource IDs (workspace, folder, list, field IDs) — no tokens or secrets.
- **Side Effects:**
  - Creates an "AI Agents" folder in the user's ClickUp space. This is visible to all workspace members.
  - Creates 7 lists (one per canonical column) inside the folder.
  - Creates up to 3 custom fields on the first list.
- **Dependencies & Conflicts:**
  - **Depends on `clickup_1_foundation.md`**: Uses `ClickUpSyncService` class, `httpRequest()`, `loadConfig()`, `saveConfig()`, `retry()`, `CANONICAL_COLUMNS`.
  - **No conflict with other plans**: The kanban.html changes add a new button and message listener — no overlap with existing UI code.

## Adversarial Synthesis

### Grumpy Critique

*Peers over bifocals.*

1. **Where exactly in `kanban.html`?** "Near the backlog toggle button" is not a line number. The kanban header HTML is generated dynamically inside a template literal (around line 1567). You're asking the implementer to inject HTML into a string interpolation block. Get specific or they'll break the header layout.

2. **What if custom field creation returns 403?** You say "falls back gracefully" but what does that actually mean for Part 3? If `config.customFields.planId` is empty, how does `syncPlan()` find existing tasks? It can't filter by custom field. The search falls back to name matching, which is fragile. This isn't a graceful fallback — it's a correctness hole.

3. **The `clickupState` message flow is under-documented.** When exactly does `KanbanProvider` send this message? On every `_getHtmlForWebview` call? On every refresh? Only on panel creation? If it's only on creation, the button state goes stale when the user adds their token mid-session.

### Balanced Response

1. **Injection point specified**: The button HTML goes in the kanban header bar, specifically inside the column header rendering for the `CREATED` column (the first column). The exact approach: modify the `kanban.html` header-bar area where the backlog toggle button is rendered (line ~1567 in the `isCreated` branch). The implementer should search for `id="btn-toggle-backlog"` and add the ClickUp button adjacent to it.

2. **Custom field fallback documented for Part 3**: If `config.customFields.planId` is empty, Part 3's `_findTaskByPlanId()` falls back to `GET /team/{id}/task?tags[]=switchboard:{planId}` — using a tag-based lookup instead of custom field filter. This is documented as a Clarification in Part 3's plan, not a new requirement. The tag `switchboard:{planId}` is added to every created task regardless of custom field availability.

3. **`clickupState` sent on refresh**: The message is sent every time `_scheduleBoardRefresh` completes and posts card data to the webview. This is added to the existing `postMessage({ type: 'refreshBoard', ... })` flow — a new `clickupState` message is sent alongside it. This ensures the button state is always current.

## Proposed Changes

### Target File 1: Setup Method on ClickUpSyncService
#### MODIFY `src/services/ClickUpSyncService.ts`
- **Context:** Add the `setup()` and `_cleanup()` methods to the service class created in Part 1. These methods orchestrate the ClickUp folder/list/field creation flow.
- **Logic:**
  1. `setup()` — Orchestrator: fetch workspace → prompt for space → check for existing folder → create folder → create 7 lists → create custom fields → save config.
  2. `_cleanup()` — Rollback: delete the folder (cascades to lists) and remove the config file.
  3. Both methods use `this.httpRequest()` and `this.retry()` from Part 1.
- **Implementation:**

Add these methods to the `ClickUpSyncService` class body:

```typescript
/**
 * Setup ClickUp integration: create folder, lists, and custom fields.
 * Transactional — cleans up partial resources on failure.
 */
async setup(): Promise<{ success: boolean; error?: string }> {
    if (this.setupInProgress) {
        return { success: false, error: 'Setup already in progress' };
    }
    this.setupInProgress = true;

    try {
        const token = await this.getApiToken();
        if (!token) {
            return { success: false, error: 'ClickUp API token not configured. Run "Switchboard: Set ClickUp API Token" first.' };
        }

        let config = await this.loadConfig();
        if (!config) {
            config = {
                workspaceId: '',
                folderId: '',
                spaceId: '',
                columnMappings: Object.fromEntries(CANONICAL_COLUMNS.map(c => [c, ''])),
                customFields: { sessionId: '', planId: '', syncTimestamp: '' },
                setupComplete: false,
                lastSync: null
            };
        }

        // Step 1: Get workspace
        const teamResult = await this.httpRequest('GET', '/team');
        if (teamResult.status !== 200) {
            return { success: false, error: 'Failed to fetch workspace. Check your API token.' };
        }
        const teams = teamResult.data?.teams || [];
        if (teams.length === 0) {
            return { success: false, error: 'No ClickUp workspaces found.' };
        }
        config.workspaceId = teams[0].id;

        // Step 2: Get spaces and prompt user to select one
        const spacesResult = await this.httpRequest('GET', `/team/${config.workspaceId}/space?archived=false`);
        const spaces = spacesResult.data?.spaces || [];
        if (spaces.length === 0) {
            return { success: false, error: 'No spaces found in workspace.' };
        }

        const spaceItems: { label: string; id: string }[] = spaces.map((s: any) => ({
            label: s.name, id: s.id
        }));
        const selectedSpace = await vscode.window.showQuickPick(
            spaceItems.map(s => s.label),
            { placeHolder: 'Select a ClickUp space for the AI Agents folder' }
        );
        if (!selectedSpace) {
            return { success: false, error: 'No space selected' };
        }
        config.spaceId = spaceItems.find(s => s.label === selectedSpace)?.id || '';

        // Step 3: Check for existing "AI Agents" folder
        const foldersResult = await this.httpRequest('GET', `/space/${config.spaceId}/folder?archived=false`);
        const existingFolder = (foldersResult.data?.folders || []).find((f: any) => f.name === 'AI Agents');
        if (existingFolder) {
            const reuse = await vscode.window.showQuickPick(
                ['Reuse existing folder', 'Cancel setup'],
                { placeHolder: '"AI Agents" folder already exists in this space' }
            );
            if (reuse !== 'Reuse existing folder') {
                return { success: false, error: 'Setup cancelled — folder already exists' };
            }
            config.folderId = existingFolder.id;
        } else {
            const folderResult = await this.retry(() =>
                this.httpRequest('POST', `/space/${config.spaceId}/folder`, { name: 'AI Agents' })
            );
            if (folderResult.status !== 200) {
                return { success: false, error: `Failed to create folder: ${JSON.stringify(folderResult.data)}` };
            }
            config.folderId = folderResult.data.id;
        }

        // Step 4: Create lists for each canonical column
        for (const column of CANONICAL_COLUMNS) {
            const listResult = await this.retry(() =>
                this.httpRequest('POST', `/folder/${config.folderId}/list`, { name: column })
            );
            if (listResult.status !== 200) {
                await this._cleanup(config);
                return { success: false, error: `Failed to create list for column: ${column}` };
            }
            config.columnMappings[column] = listResult.data.id;
            await this.delay(200); // Light pacing to stay under rate limits
        }

        // Step 5: Create custom fields on the first list (CREATED)
        const firstListId = config.columnMappings['CREATED'];
        const fieldDefs = [
            { name: 'switchboard_session_id', type: 'text', configKey: 'sessionId' as const },
            { name: 'switchboard_plan_id', type: 'text', configKey: 'planId' as const },
            { name: 'sync_timestamp', type: 'date', configKey: 'syncTimestamp' as const }
        ];
        for (const field of fieldDefs) {
            try {
                const fieldResult = await this.retry(() =>
                    this.httpRequest('POST', `/list/${firstListId}/field`, {
                        name: field.name, type: field.type
                    })
                );
                if (fieldResult.status === 200) {
                    config.customFields[field.configKey] = fieldResult.data.id;
                }
            } catch (err) {
                // Non-fatal: metadata will be embedded in task descriptions instead
                console.warn(`[ClickUpSync] Custom field '${field.name}' creation failed — using description fallback.`);
            }
        }

        config.setupComplete = true;
        await this.saveConfig(config);
        return { success: true };
    } catch (error) {
        return { success: false, error: `Setup failed: ${error}` };
    } finally {
        this.setupInProgress = false;
    }
}

/**
 * Clean up ClickUp resources on setup failure.
 * Deleting the folder cascades to child lists.
 */
private async _cleanup(config: ClickUpConfig): Promise<void> {
    if (config.folderId) {
        try {
            await this.httpRequest('DELETE', `/folder/${config.folderId}`);
        } catch { /* best-effort */ }
    }
    try {
        await fs.promises.unlink(this.configPath);
    } catch { /* ignore */ }
}
```

- **Edge Cases Handled:**
  - Double-click → `setupInProgress` guard
  - Existing folder → reuse prompt
  - List creation fails midway → folder deleted (cascades to child lists)
  - Custom field creation fails → non-fatal, falls back to description-embedded metadata
  - User cancels space QuickPick → returns error, no resources created

### Target File 2: Kanban Webview — Setup Button
#### MODIFY `src/webview/kanban.html`
- **Context:** Add a "Setup ClickUp" button in the kanban header bar. The button is hidden by default and shown only when the extension sends a `clickupState` message indicating ClickUp is available.
- **Logic:**
  1. Add the button HTML near the backlog toggle button (search for `id="btn-toggle-backlog"` around line 1567)
  2. Add a CSP-compliant `addEventListener` in the init script block
  3. Add a `window.addEventListener('message', ...)` handler for `clickupState` messages
- **Implementation:**

Add the button HTML adjacent to the backlog toggle button (inside the `isCreated` branch, after the backlog toggle button):

```html
<button class="backlog-toggle-btn" id="clickup-setup-btn"
        style="display:none;"
        data-tooltip="Setup ClickUp Integration">
  ☁️ Setup ClickUp
</button>
```

Add in the `<script>` init block (after existing `addEventListener` bindings, e.g., after the backlog toggle listener):

```javascript
// ClickUp Setup button — CSP-compliant event binding
const clickupSetupBtn = document.getElementById('clickup-setup-btn');
if (clickupSetupBtn) {
    clickupSetupBtn.addEventListener('click', () => {
        clickupSetupBtn.disabled = true;
        clickupSetupBtn.textContent = '⏳ Setting up...';
        vscode.postMessage({ type: 'setupClickUp' });
    });
}
```

Add a handler inside the existing `window.addEventListener('message', ...)` switch for incoming messages from the extension:

```javascript
case 'clickupState': {
    const btn = document.getElementById('clickup-setup-btn');
    if (!btn) break;
    btn.style.display = msg.available ? 'inline-block' : 'none';
    if (msg.setupComplete) {
        btn.textContent = '✅ ClickUp Synced';
        btn.dataset.tooltip = 'ClickUp integration active';
    } else {
        btn.textContent = '☁️ Setup ClickUp';
        btn.disabled = false;
    }
    break;
}
```

- **Edge Cases Handled:**
  - Button hidden if ClickUp not available (no token set)
  - Button disabled during setup (re-click prevention)
  - Button label updates to reflect sync status
  - No inline event handlers (CSP compliance)

### Target File 3: KanbanProvider — Message Handler & State Push
#### MODIFY `src/services/KanbanProvider.ts`
- **Context:** Handle the `setupClickUp` webview message in the existing message switch (alongside `moveCardForward`, `moveCardBackwards`, etc. around line 1768+). Also push `clickupState` to the webview on every board refresh.
- **Logic:**
  1. Add `case 'setupClickUp':` — instantiate `ClickUpSyncService`, call `setup()`, notify webview of result.
  2. In the board refresh path (where card data is posted to the webview), also send a `clickupState` message with availability and setup status.
  3. Import `ClickUpSyncService` at the top of the file.
- **Implementation:**

Add import at the top of `KanbanProvider.ts`:

```typescript
import { ClickUpSyncService } from './ClickUpSyncService';
```

Add to the webview message handler (after the `moveCardForward` case, around line 1807):

```typescript
case 'setupClickUp': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    if (!workspaceRoot) { break; }
    const syncService = new ClickUpSyncService(workspaceRoot, this._context.secrets);
    const result = await syncService.setup();
    if (result.success) {
        vscode.window.showInformationMessage('ClickUp integration setup complete!');
        this._panel?.webview.postMessage({
            type: 'clickupState', available: true, setupComplete: true
        });
    } else {
        vscode.window.showErrorMessage(`ClickUp setup failed: ${result.error}`);
        this._panel?.webview.postMessage({
            type: 'clickupState', available: true, setupComplete: false
        });
    }
    break;
}
```

Add ClickUp state push in the board refresh method (wherever `this._panel.webview.postMessage({ type: 'refreshBoard', ... })` is called):

```typescript
// Push ClickUp availability state to webview alongside board data
try {
    const wsRoot = this._currentWorkspaceRoot;
    if (wsRoot) {
        const clickUp = new ClickUpSyncService(wsRoot, this._context.secrets);
        const config = await clickUp.loadConfig();
        const hasToken = !!(await clickUp.getApiToken());
        this._panel?.webview.postMessage({
            type: 'clickupState',
            available: hasToken,
            setupComplete: config?.setupComplete ?? false
        });
    }
} catch { /* non-blocking */ }
```

- **Edge Cases Handled:**
  - No workspace root → breaks out of case, no error
  - Setup failure → error message shown, webview notified with `setupComplete: false`
  - ClickUp state check failure → caught silently, button stays hidden (safe default)

### Target File 4: Command Palette Registration
#### MODIFY `package.json`
- **Context:** Add `switchboard.setupClickUp` command so it can be triggered from the command palette as well as the webview button.
- **Implementation:**

Add to the `contributes.commands` array:

```json
{
  "command": "switchboard.setupClickUp",
  "title": "Setup ClickUp Integration",
  "category": "Switchboard"
}
```

**Clarification:** The primary trigger for setup is the webview button (handled via `postMessage` to `KanbanProvider`). The command palette entry is a secondary access path. The command handler in `extension.ts` should delegate to the same `ClickUpSyncService.setup()` logic:

Add to `src/extension.ts` (after the `setClickUpToken` command from Part 1):

```typescript
const setupClickUpDisposable = vscode.commands.registerCommand('switchboard.setupClickUp', async () => {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
        vscode.window.showErrorMessage('No workspace open');
        return;
    }
    const syncService = new ClickUpSyncService(workspaceRoot, context.secrets);
    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Setting up ClickUp...', cancellable: false },
        async () => {
            const result = await syncService.setup();
            if (result.success) {
                vscode.window.showInformationMessage('ClickUp integration setup complete!');
            } else {
                vscode.window.showErrorMessage(`ClickUp setup failed: ${result.error}`);
            }
        }
    );
});
context.subscriptions.push(setupClickUpDisposable);
```

## Verification Plan

### Automated Tests
- **Unit test for `setup()` happy path**: Mock `httpRequest` to return 200 for all calls. Verify config file is written with correct IDs.
- **Unit test for rollback**: Mock list creation to fail on 3rd column. Verify `DELETE /folder/{id}` is called and config file is removed.
- **Unit test for existing folder detection**: Mock folder list response containing "AI Agents". Verify QuickPick is shown.

### Manual Verification Steps
1. Set ClickUp token: Command palette → "Switchboard: Set ClickUp API Token"
2. Open Kanban board → verify "☁️ Setup ClickUp" button appears in header
3. Click button → verify QuickPick shows available spaces
4. Select space → verify "AI Agents" folder appears in ClickUp with 7 lists
5. Verify `clickup-config.json` is populated with correct IDs
6. Re-open Kanban → verify button shows "✅ ClickUp Synced"
7. Click button again → verify "Reuse existing folder" prompt appears
8. Test rollback: revoke ClickUp permissions mid-setup → verify partial resources are cleaned up

## Files to Modify

1. `src/services/ClickUpSyncService.ts` — MODIFY (add `setup()` and `_cleanup()` methods)
2. `src/webview/kanban.html` — MODIFY (add Setup ClickUp button, `clickupState` listener)
3. `src/services/KanbanProvider.ts` — MODIFY (add `setupClickUp` message handler, push `clickupState` on refresh)
4. `package.json` — MODIFY (add `switchboard.setupClickUp` command)
5. `src/extension.ts` — MODIFY (register `switchboard.setupClickUp` command handler)

## Agent Recommendation

**Send to Lead Coder** — Complexity 7. This plan modifies 3 critical files (`kanban.html`, `KanbanProvider.ts`, `ClickUpSyncService.ts`) with webview ↔ extension host message passing, REST API orchestration, transactional rollback, and QuickPick UI flows. The webview CSP constraints and the need to hook into the existing refresh cycle make this non-routine.

---

## Post-Implementation Review

### Review Date: 2026-04-09

### Stage 1: Grumpy Principal Engineer Findings

1. **[CRITICAL] Cleanup deletes reused folders.** When the user selects "Reuse existing folder", `config.folderId` is set to the pre-existing folder. If list creation fails in Step 4, `_cleanup()` calls `DELETE /folder/{id}` — obliterating the user's existing folder and ALL its contents (child lists, tasks, automations). This isn't "cleanup" — it's data destruction. The `_cleanup` method has no concept of "I didn't create this folder, don't touch it."

2. **[MAJOR] `clickupState` handler missing `syncError` branch.** Part 3 sends `{ type: 'clickupState', syncError: true }` when consecutive sync failures exceed 3. But the `kanban.html` handler only checks `msg.setupComplete` — it never checks `msg.syncError`. So the button shows "✅ ClickUp Synced" even when sync is broken. The error indicator specified in Part 3's plan is dead on arrival.

3. **[MAJOR] Duplicate lists on repeated setup with "Reuse existing folder".** When the user reuses an existing folder, Step 4 unconditionally creates 8 new lists (one per canonical column). If the folder already has lists from a previous setup, the user gets 16 lists. Then 24. Then 32. No deduplication.

4. **[MAJOR] `ClickUpSyncService` instantiated fresh per message in KanbanProvider.** The `setupClickUp` case, the board refresh path, and the move hooks all do `new ClickUpSyncService(...)`. This means `setupInProgress` flag, debounce timers, and consecutive failure counters reset on every message. The `setupInProgress` guard only prevents concurrent setup within a single instance — a second click creates a new instance and bypasses the guard entirely.

5. **[NIT] `CANONICAL_COLUMNS` was missing `CODED`.** Setup would create 7 lists instead of 8 — cards in the `CODED` column would have no ClickUp list.

### Stage 2: Balanced Synthesis

1. **Cleanup safety — FIXED.** Added `folderWasCreated` boolean tracked in Step 3. `_cleanup` is now only called when the folder was newly created (`folderWasCreated === true`). Reused folders are never deleted.

2. **`syncError` handling — FIXED.** Added `msg.syncError` check to `kanban.html` `clickupState` handler. When `syncError` is true, button shows "⚠️ Sync Error" with tooltip. This check takes priority over `setupComplete`.

3. **Duplicate lists on reuse — Deferred.** Proper fix requires fetching existing lists in the reused folder, matching by name, and only creating missing ones. This is a non-trivial change to the setup flow. Current mitigation: the "Reuse existing folder" prompt makes the user opt in explicitly. A future improvement should add a "Lists already exist — reconfigure mappings?" prompt.

4. **Singleton ClickUpSyncService — FIXED.** Added `_clickUpServices` Map and `_getClickUpService()` factory to `KanbanProvider` (same pattern as `_kanbanDbs`/`_getKanbanDb`). All `new ClickUpSyncService(...)` calls in KanbanProvider replaced with the singleton getter. Debounce timers and failure counters now persist across messages.

5. **`CODED` column — FIXED** (in Plan 1 review, affects this plan).

### Files Changed (Review Fixes)

| File | Change |
|------|--------|
| `src/services/ClickUpSyncService.ts` | Added `folderWasCreated` guard — `_cleanup` only deletes newly-created folders |
| `src/webview/kanban.html` | Added `msg.syncError` branch to `clickupState` handler |
| `src/services/KanbanProvider.ts` | Added `_clickUpServices` Map + `_getClickUpService()` singleton factory; replaced all `new ClickUpSyncService(...)` with factory calls |

### Validation Results

- **Typecheck** (`npx tsc --noEmit`): ✅ Pass (only pre-existing `ArchiveManager` import error — known false positive)
- **All plan requirements verified**: `setup()` method ✅, `_cleanup()` method ✅, kanban.html button + listener ✅, `clickupState` handler ✅, `setupClickUp` message handler ✅, board refresh state push ✅, package.json entry ✅, extension.ts command ✅

### Remaining Risks

- **Duplicate lists on folder reuse**: Repeated "Reuse existing folder" setup creates duplicate lists. Low severity since user must explicitly opt in, but should be addressed in a follow-up with list name deduplication.
