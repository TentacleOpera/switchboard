# Linear Integration — Part 2: Setup Flow

## Goal

Implement the Linear setup flow: a "Setup Linear" button in the kanban webview header that walks the user through selecting a team, optionally scoping to a project, mapping Switchboard columns to Linear workflow states, and creating a "switchboard" tracking label. Stores the result in `linear-config.json`. Much simpler than ClickUp setup — Linear needs no folder/list creation.

## Metadata

**Tags:** backend, UI, infrastructure
**Complexity:** 5

## User Review Required

> [!NOTE]
> - **Single entry point**: The "Connect Linear" button in the kanban header is the ONLY thing users need to click. The setup wizard handles everything — token prompt, team selection, state mapping — in one guided flow. The separate `switchboard.setLinearToken` command (from Part 1) exists for power users who need to rotate their token, but is NOT required for first-time setup.
> - **Token prompt is step 1 of the wizard**: If no token is stored, the wizard opens with an `InputBox` asking for the API key (password-masked). Token is validated against `{ viewer { id } }` before continuing. If validation fails, the user is shown a link to `https://linear.app/settings/api`.
> - **No ClickUp-style folder creation**: Linear organises work via teams and states — there's no folder/list structure to create. Setup only reads existing data and stores mappings.
> - **State mapping**: Each Switchboard column must be mapped to a Linear workflow state in the chosen team (e.g. `CREATED` → "Triage", `BACKLOG` → "Backlog", `COMPLETED` → "Done"). Unmapped columns are silently skipped during sync.
> - **switchboard label**: Setup creates a `switchboard` label in the team if one doesn't exist. This is used to tag all issues created by Switchboard so they're identifiable in Linear.
> - **Project is optional**: Users can optionally scope the integration to a single project. If omitted, all issues in the team are visible to import.
> - **Primary trigger is the webview button**: The "📐 Setup Linear" button in `kanban.html` sends a `setupLinear` message to `KanbanProvider.ts`, which calls `syncService.setup()`. The command palette command (`switchboard.setupLinear`) is a secondary entry point for discoverability. This matches the ClickUp pattern exactly.

## Complexity Audit

### Routine
- **`listTeams()` query**: Simple GraphQL `{ teams { nodes { id name } } }`
- **`listStates()` query**: `{ team(id) { states { nodes { id name type } } } }`
- **`listProjects()` query**: `{ team(id) { projects { nodes { id name } } } }`
- **Config save**: Uses `saveConfig()` from Part 1
- **Webview button**: Same pattern as ClickUp — `linearState` message to webview
- **`package.json` command entry**: Copy ClickUp pattern (`switchboard.setupLinear`)
- **`extension.ts` command palette command**: Copy ClickUp `registerCommand` pattern (secondary entry point)
- **`kanban.html` button HTML**: Copy ClickUp `clickup-setup-btn` pattern (line 1567)

### Complex / Risky
- **Column-to-state mapping UX**: 8 canonical columns need individual QuickPick prompts. Not all teams have 8 states. User can skip any column (maps to nothing → sync skipped for that column). Must show current state name suggestions based on Linear `state.type` (e.g. `started` → suggest for `LEAD CODED`).
- **Label creation**: `labelCreate` mutation requires team ID and name. If a "switchboard" label already exists, reuse its ID. Must search existing labels before creating.
- **`LinearSyncService.ts` `setup()` method**: Multi-step wizard with token validation, team/project/state selection, label creation, and error handling. All intermediate failures must abort cleanly.
- **`KanbanProvider.ts` message handler + factory + import + startup push**: Must add `case 'setupLinear'` handler (mirrors `setupClickUp` at line 1902), `_getLinearService()` factory (mirrors `_getClickUpService()` at line 438), `_linearServices` Map (mirrors `_clickUpServices` at line 100), import statement, and startup state push (mirrors ClickUp push at line 811-824).
- **`kanban.html` `linearState` message handler**: Must add the `case 'linearState'` handler in the message switch (mirrors `clickupState` at line 2573) to control button visibility and text.

## Edge-Case & Dependency Audit

- **No states in team**: Show error — team must have at least one workflow state configured
- **Setup double-click**: `_setupInProgress` flag prevents re-entry
- **User cancels mid-flow**: No partial state written — config only saved on full completion
- **Label already exists**: Query `{ team(id) { labels { nodes { id name } } } }` first; reuse if found
- **Project scope later**: If user omits project during setup, they can re-run setup to add one

### Cross-Plan Dependencies

- **Depends on** `linear_1_foundation.md` — needs `LinearSyncService` class, `graphqlRequest()`, `loadConfig()`, `saveConfig()`, `getApiToken()`, `isAvailable()`
- **Part 3** (`linear_3_sync_on_move.md`) depends on this plan's `columnToStateId` config mapping
- **Import plan** (`linear_import_pull_issues.md`) depends on this plan's `config.teamId` and `config.projectId`

### Cross-Plan Conflict Analysis

- **`src/services/KanbanProvider.ts`** is also modified by `linear_3_sync_on_move.md` and `clickup_3_sync_on_move.md` — changes are additive (separate `case` handlers and hook blocks; no overlapping lines)
- **`src/webview/kanban.html`** is also modified by `clickup_2_setup_flow.md` — changes are additive (separate buttons, separate message handlers)
- **`package.json`** is modified by multiple plans — all add separate command entries to the `contributes.commands` array
- **`src/extension.ts`** is modified by multiple plans — all add separate `registerCommand` calls; no overlapping code

## Adversarial Synthesis

### Grumpy Critique

1. **Setup is triggered from webview, not command palette**: The plan shows a VS Code command `switchboard.setupLinear` in `extension.ts`, but ClickUp's setup is actually triggered by a `case 'setupClickUp'` message handler in `KanbanProvider.ts` (line 1902) when the user clicks the button in `kanban.html`. The command palette command is a secondary entry point. The plan is missing the **PRIMARY** entry point — the `KanbanProvider` message handler. Without it, clicking the "📐 Setup Linear" button does absolutely nothing.

2. **Missing `_getLinearService()` factory**: `KanbanProvider` needs a cached service factory method (same as `_getClickUpService()` at line 438). Without it, every setup/sync call creates a new `LinearSyncService` instance, losing debounce timers and `_setupInProgress` guards. The guard becomes useless if a new instance is created each time.

3. **Missing `_linearServices` Map and import**: `KanbanProvider` needs `private _linearServices = new Map<string, LinearSyncService>();` (same pattern as `_clickUpServices` at line 100) and an `import { LinearSyncService } from './LinearSyncService';` statement (same as ClickUp import at line 16).

4. **Missing `kanban.html` button details**: The plan says "Add Setup Linear button... Same postMessage pattern as ClickUp button" but doesn't show the actual HTML, the `linearState` message handler, or the button click handler. The ClickUp button is at line 1567 with `id="clickup-setup-btn"` and `style="display:none;"`. The `linearState` handler (mirroring `clickupState` at line 2573) controls button visibility. Without the handler, the button stays hidden forever.

5. **Missing `linearState` push on KanbanProvider startup**: ClickUp pushes its state to the webview during board refresh (lines 811-824) so the button shows immediately when the kanban panel opens. Linear needs the same startup push. Without it, the button stays `display:none` until setup is somehow triggered by other means (which can't happen because the button is hidden).

6. **`CANONICAL_COLUMNS` is defined in `ClickUpSyncService.ts`**: The plan references `CANONICAL_COLUMNS` in the `setup()` code but doesn't clarify where `LinearSyncService` gets this constant. It's currently exported from `ClickUpSyncService.ts` (line 36): `['CREATED', 'BACKLOG', 'PLAN REVIEWED', 'LEAD CODED', 'CODER CODED', 'CODE REVIEWED', 'CODED', 'COMPLETED']`. Either import it from ClickUp or define a shared constant. The plan should specify which approach.

7. **ClickUp `setup()` returns `{ success, error }` but Linear `setup()` returns `boolean`**: The KanbanProvider handler for ClickUp checks `result.success` and uses `result.error` for the error message. The Linear `setup()` method returns `Promise<boolean>`. The handler code must account for this difference. The provided handler code in the task already handles this correctly (checks truthy `result` directly), but the coder must not copy the ClickUp handler verbatim.

### Balanced Response

1. **KanbanProvider `case 'setupLinear'` handler added** — mirrors `setupClickUp` (line 1902) but adapted for `boolean` return type. Posts `linearState` back to webview on success/failure. Full code provided below.

2. **`_getLinearService()` factory added** — mirrors `_getClickUpService()` at line 438. Uses `_linearServices` Map for instance caching. Full code provided below.

3. **`_linearServices` Map and import added** — Map declared at class property level (near line 100); import added alongside ClickUp import (line 16).

4. **`kanban.html` button HTML and handlers specified** — Button HTML, `linearState` message handler, and button click handler all provided with exact code below.

5. **Startup state push for Linear added** — Pushed alongside the ClickUp push in the board refresh method (after line 824). Uses `_getLinearService()`, `loadConfig()`, and `getApiToken()` to determine availability.

6. **`CANONICAL_COLUMNS` sourced via import** — Import from `ClickUpSyncService.ts` for now. If a shared module is created later, the import path changes but the constant doesn't. Add note for coder to import: `import { CANONICAL_COLUMNS } from './ClickUpSyncService';` in `LinearSyncService.ts`.

7. **Return type difference documented** — Linear `setup()` returns `boolean` (not `{ success, error }`). Handler code checks truthiness directly rather than `.success` property.

## Proposed Changes

### Target File 1: Setup Method
#### MODIFY `src/services/LinearSyncService.ts`

Add `setup()` method and import `CANONICAL_COLUMNS`:

```typescript
// At top of file, add import:
import { CANONICAL_COLUMNS } from './ClickUpSyncService';
```

```typescript
async setup(): Promise<boolean> {
  if (this._setupInProgress) { return false; }
  this._setupInProgress = true;

  try {
    // 0. Token — prompt if not already stored
    let token = await this.getApiToken();
    if (!token) {
      const input = await vscode.window.showInputBox({
        prompt: 'Enter your Linear API token — find it at linear.app/settings/api',
        password: true,
        placeHolder: 'lin_api_...',
        ignoreFocusOut: true,
        validateInput: (v) => (!v || v.trim().length < 10) ? 'Token appears too short' : null
      });
      if (!input) { return false; }
      await this._secretStorage.store('switchboard.linear.apiToken', input.trim());
      token = input.trim();
    }

    // Validate token before continuing
    if (!(await this.isAvailable())) {
      vscode.window.showErrorMessage(
        'Linear token is invalid. Get a valid token at linear.app/settings/api',
        'Open linear.app'
      ).then(choice => { if (choice) { vscode.env.openExternal(vscode.Uri.parse('https://linear.app/settings/api')); } });
      return false;
    }

    // 1. Select team
    const teamsResult = await this.graphqlRequest(`{
      teams { nodes { id name } }
    }`);
    const teams = teamsResult.data.teams.nodes;
    const selectedTeam = await vscode.window.showQuickPick(
      teams.map((t: any) => ({ label: t.name, id: t.id })),
      { placeHolder: 'Select your Linear team' }
    );
    if (!selectedTeam) { return false; }

    // 3. Optional project scope
    const projectsResult = await this.graphqlRequest(`
      query($teamId: String!) { team(id: $teamId) { projects { nodes { id name } } } }
    `, { teamId: selectedTeam.id });
    const projects = projectsResult.data.team.projects.nodes;
    const projectOptions = [{ label: '(All issues in team)', id: '' }, ...projects.map((p: any) => ({ label: p.name, id: p.id }))];
    const selectedProject = await vscode.window.showQuickPick(projectOptions, { placeHolder: 'Scope to a project? (optional)' });
    if (selectedProject === undefined) { return false; }

    // 4. Map columns to states
    const statesResult = await this.graphqlRequest(`
      query($teamId: String!) { team(id: $teamId) { states { nodes { id name type } } } }
    `, { teamId: selectedTeam.id });
    const states = statesResult.data.team.states.nodes;
    const stateOptions = [
      { label: '(skip — do not sync)', id: '' },
      ...states.map((s: any) => ({ label: `${s.name} (${s.type})`, id: s.id }))
    ];

    const columnToStateId: Record<string, string> = {};
    for (const column of CANONICAL_COLUMNS) {
      const selected = await vscode.window.showQuickPick(stateOptions, {
        placeHolder: `Map Switchboard column "${column}" to a Linear state`
      });
      if (selected === undefined) { return false; } // cancelled
      if (selected.id) { columnToStateId[column] = selected.id; }
    }

    // 5. Ensure "switchboard" label exists
    const labelsResult = await this.graphqlRequest(`
      query($teamId: String!) { team(id: $teamId) { labels { nodes { id name } } } }
    `, { teamId: selectedTeam.id });
    const existingLabel = labelsResult.data.team.labels.nodes.find((l: any) => l.name === 'switchboard');
    let switchboardLabelId: string;
    if (existingLabel) {
      switchboardLabelId = existingLabel.id;
    } else {
      const createResult = await this.graphqlRequest(`
        mutation($teamId: String!, $name: String!, $color: String!) {
          issueLabelCreate(input: { teamId: $teamId, name: $name, color: $color }) {
            issueLabel { id }
          }
        }
      `, { teamId: selectedTeam.id, name: 'switchboard', color: '#6366f1' });
      switchboardLabelId = createResult.data.issueLabelCreate.issueLabel.id;
    }

    // 6. Save config
    await this.saveConfig({
      teamId: selectedTeam.id,
      teamName: selectedTeam.label,
      projectId: selectedProject.id || undefined,
      columnToStateId,
      switchboardLabelId,
      setupComplete: true,
      lastSync: null
    });

    vscode.window.showInformationMessage(`Linear integration set up for team "${selectedTeam.label}".`);
    return true;
  } finally {
    this._setupInProgress = false;
  }
}
```

### Target File 2: VS Code Command (secondary entry point)
#### MODIFY `src/extension.ts`

Register `switchboard.setupLinear` command near the existing `switchboard.setupClickUp` registration (around line 1342). This is a **secondary** entry point for command palette discoverability — the primary trigger is the webview button → KanbanProvider message handler.

```typescript
context.subscriptions.push(
  vscode.commands.registerCommand('switchboard.setupLinear', async () => {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) { vscode.window.showErrorMessage('No workspace folder open.'); return; }
    const service = new LinearSyncService(workspaceRoot, context.secrets);
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Setting up Linear integration...', cancellable: false },
      async () => service.setup()
    );
  })
);
```

### Target File 3: Command Registration
#### MODIFY `package.json`

Add to `contributes.commands` array (near the existing `switchboard.setupClickUp` entry at line 107):

```json
{
  "command": "switchboard.setupLinear",
  "title": "Setup Linear Integration",
  "category": "Switchboard"
}
```

### Target File 4: KanbanProvider Integration (PRIMARY entry point)
#### MODIFY `src/services/KanbanProvider.ts`

This is the **primary** entry point for the setup flow. When the user clicks "📐 Setup Linear" in the kanban webview, it posts a `setupLinear` message to KanbanProvider. Four additions needed:

**4a. Import** — add alongside ClickUp import (line 16):
```typescript
import { LinearSyncService } from './LinearSyncService';
```

**4b. Service cache Map** — add near `_clickUpServices` (line 100):
```typescript
private _linearServices = new Map<string, LinearSyncService>();
```

**4c. Factory method** — add near `_getClickUpService()` (after line 445):
```typescript
private _getLinearService(workspaceRoot: string): LinearSyncService {
    const resolved = path.resolve(workspaceRoot);
    const existing = this._linearServices.get(resolved);
    if (existing) { return existing; }
    const service = new LinearSyncService(resolved, this._context.secrets);
    this._linearServices.set(resolved, service);
    return service;
}
```

**4d. Message handler** — add near `case 'setupClickUp'` (after line 1919):

> **Note:** Linear `setup()` returns `Promise<boolean>` (not `{ success, error }` like ClickUp). The handler checks truthiness directly.

```typescript
case 'setupLinear': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    if (!workspaceRoot) { break; }
    const syncService = this._getLinearService(workspaceRoot);
    const result = await syncService.setup();
    if (result) {
        vscode.window.showInformationMessage('Linear integration setup complete!');
        this._panel?.webview.postMessage({
            type: 'linearState', available: true, setupComplete: true
        });
    } else {
        this._panel?.webview.postMessage({
            type: 'linearState', available: true, setupComplete: false
        });
    }
    break;
}
```

**4e. Startup state push** — add after the ClickUp availability push (after line 824):

```typescript
// Push Linear availability state to webview alongside board data
try {
    const wsRoot = this._currentWorkspaceRoot;
    if (wsRoot) {
        const linear = this._getLinearService(wsRoot);
        const config = await linear.loadConfig();
        const hasToken = !!(await linear.getApiToken());
        this._panel.webview.postMessage({
            type: 'linearState',
            available: hasToken,
            setupComplete: config?.setupComplete ?? false
        });
    }
} catch { /* non-blocking */ }
```

### Target File 5: Webview Button + State Handler
#### MODIFY `src/webview/kanban.html`

**5a. Button HTML** — add after the ClickUp button (after line 1568), inside `rightSide`:

```javascript
const linearSetupBtn = isCreated
    ? `<button class="backlog-toggle-btn" id="linear-setup-btn" style="display:none;" data-tooltip="Setup Linear Integration">📐 Setup Linear</button>`
    : '';
```

And include `${linearSetupBtn}` in the `rightSide` template string (after `${clickupSetupBtn}`):

```javascript
const rightSide = isCreated
    ? `<div style="display: flex; align-items: center; gap: 8px; line-height: 1;">
            ${clickupSetupBtn}
            ${linearSetupBtn}
            ${backlogToggleBtn}
            ...`
    : `...`;
```

**5b. Button click handler** — add near the ClickUp button handler (after line 1685):

```javascript
document.getElementById('linear-setup-btn')?.addEventListener('click', () => {
    const btn = document.getElementById('linear-setup-btn');
    if (btn) {
        btn.disabled = true;
        btn.textContent = '⏳ Setting up...';
    }
    postKanbanMessage({ type: 'setupLinear' });
});
```

**5c. `linearState` message handler** — add in the message switch (near `clickupState` handler, after line 2588):

```javascript
case 'linearState': {
    const btn = document.getElementById('linear-setup-btn');
    if (!btn) break;
    btn.style.display = msg.available ? 'inline-block' : 'none';
    if (msg.syncError) {
        btn.textContent = '📐 Linear ⚠️';
        btn.dataset.tooltip = 'Linear sync is failing — check connection';
    } else if (msg.setupComplete) {
        btn.textContent = '📐 Linear ✓';
        btn.dataset.tooltip = 'Linear integration active';
    } else {
        btn.textContent = '📐 Setup Linear';
        btn.disabled = false;
    }
    break;
}
```

## Verification Plan

- Setup with 2 teams → QuickPick shows both → select one → continues
- Skip project → `projectId` is undefined in config
- Cancel during column mapping → returns false, no config written
- "switchboard" label already exists → reused, not duplicated
- Full happy path → `linear-config.json` written with `setupComplete: true`
- Click "📐 Setup Linear" button → `setupLinear` message received by KanbanProvider → `setup()` called → button text updates to "📐 Linear ✓"
- Open kanban panel fresh → Linear startup push sends `linearState` → button appears if token exists
- No token stored → button hidden (`available: false`) → user uses command palette or setup flow prompts for token
- Double-click button → `_setupInProgress` flag prevents re-entry → second call returns `false`

## Files to Modify

1. `src/services/LinearSyncService.ts` — MODIFY (add `setup()` method, import `CANONICAL_COLUMNS`)
2. `src/extension.ts` — MODIFY (register `switchboard.setupLinear` command — secondary entry point)
3. `package.json` — MODIFY (add command entry)
4. `src/webview/kanban.html` — MODIFY (add "📐 Setup Linear" button, click handler, `linearState` message handler)
5. `src/services/KanbanProvider.ts` — MODIFY (add import, `_linearServices` Map, `_getLinearService()` factory, `case 'setupLinear'` handler, startup state push)

## Agent Recommendation

**Send to Coder** — Complexity 5. All GraphQL queries are simple; the only multi-step logic is the column-mapping loop. Much simpler than ClickUp setup (no folder/list creation, no transactional rollback needed). KanbanProvider changes follow an established pattern with exact line references.

## Implementation Review (2026-04-09)

### Stage 1: Grumpy Principal Engineer

Oh. Oh my. Someone implemented 4 out of 5 target files and called it done? *Chef's kiss of incompetence.*

1. **CRITICAL — `kanban.html` completely untouched**: The plan's Target File 5 specifies three additions to `kanban.html`: (a) the `📐 Setup Linear` button HTML, (b) the button click handler, and (c) the `linearState` message handler. NONE of these were implemented. The KanbanProvider dutifully pushes `linearState` messages on startup (line 897) and after setup (line 2074), but the webview has NO handler for them. The button was never rendered. The entire webview integration — *the PRIMARY entry point for setup* — is a ghost. Users can only trigger setup via command palette, which the plan explicitly calls a "secondary entry point for discoverability." The button that users are supposed to click? Invisible. Forever.

2. **MAJOR — `extension.ts` setup command creates NEW instance**: The `switchboard.setupLinear` command (line 1441) creates `new LinearSyncService(wsRoot, context.secrets)` instead of using a cached singleton. This means the `_setupInProgress` guard is useless — a second invocation gets a fresh instance with `_setupInProgress = false`. The KanbanProvider correctly uses `_getLinearService()` for its handler, but the extension.ts command palette path bypasses caching entirely. ClickUp's extension.ts command has the same pattern, so this is a "consistent bug" — but it's still a bug.

3. **NIT — QuickPick item types**: The plan shows `teams.map((t: any) => ({ label: t.name, id: t.id }))` but the implementation (line 189-190) adds explicit `String()` coercion: `teams.map((t: any) => ({ label: String(t.name), id: String(t.id) }))`. This is actually an improvement — defensive against unexpected API types.

### Stage 2: Balanced Synthesis

| Finding | Severity | Action |
|:--------|:---------|:-------|
| Missing `kanban.html` webview code | **CRITICAL** | ✅ **FIXED** — Button HTML, click handler, and `linearState` message handler added |
| `extension.ts` creates non-cached instance | MAJOR | Defer — matches ClickUp pattern; fix would require shared singleton infrastructure |
| QuickPick String() coercion | NIT (improvement) | ✅ Already correct |

### Code Changes Applied

**`src/webview/kanban.html`** — 3 additions:
1. **Button HTML** (after line 1568): Added `linearSetupBtn` variable with `id="linear-setup-btn"`, included in `rightSide` template
2. **Click handler** (after line 1685): Added `addEventListener` for `linear-setup-btn` that disables button and posts `setupLinear` message
3. **Message handler** (after `clickupState` case): Added `case 'linearState'` with button visibility, sync error, and setup-complete states

### Validation Results

- `npx tsc --noEmit`: ✅ Pass (only pre-existing ArchiveManager error)
- `npm run compile`: ✅ webpack compiled successfully
- All 5 target files verified:
  - `src/services/LinearSyncService.ts` — ✅ `setup()` method present (line 155), imports `CANONICAL_COLUMNS`
  - `src/extension.ts` — ✅ `setupLinear` command registered (line 1435)
  - `package.json` — ✅ Command entry present (line 132)
  - `src/webview/kanban.html` — ✅ **FIXED**: Button, click handler, and message handler now present
  - `src/services/KanbanProvider.ts` — ✅ Import (line 17), `_linearServices` Map (line 104), `_getLinearService()` factory (line 500), `setupLinear` handler (line 2067), startup push (line 897)

### Remaining Risks

- `extension.ts` command palette path creates non-cached instance (MAJOR deferred — matches ClickUp pattern, low user impact since primary path is webview button)
