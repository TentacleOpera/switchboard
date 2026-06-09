# Worktrees Tab Overhaul: Agent Terminal Behaviour Config, False Warning Fix, and UX Redesign

## Goal

Redesign the Worktrees tab to fix a false "No Control Plane" warning banner, replace the hardcoded "Safety Session" UI with a configurable agent-terminal-behaviour radio menu, persist the selected behaviour across restarts, and make the control plane genuinely optional.

### Problem Analysis

#### Root Cause 1: False "No Control Plane" Warning Banner

`KanbanProvider.ts` sends the `updateWorkspaceSelection` message to the webview in three locations (lines 1123–1131, 1842–1850, 1981–1989) but **omits all control-plane-related fields** that `TaskViewerProvider.ts` correctly includes via `handleGetDbPath()` (lines 3401–3429):

| Field | In TaskViewerProvider | In KanbanProvider |
|-------|----------------------|-------------------|
| `controlPlaneMode` | Yes | **Missing** |
| `controlPlaneRoot` | Yes | **Missing** |
| `effectiveControlPlaneRoot` | Yes | **Missing** |
| `explicitControlPlaneRoot` | Yes | **Missing** |
| `pendingCandidate` | Yes | **Missing** |
| `repoScopeFilter` | Yes | **Missing** |

The webview handler at `kanban.html:5521` does:

```javascript
currentControlPlaneMode = msg.controlPlaneMode || msg.mode || 'none';
```

Since `controlPlaneMode` is absent from KanbanProvider's payload, it always falls back to `'none'`. The `createSafetySessionPanel()` function then renders the red warning banner (lines 7919–7923) regardless of whether the user actually has a control plane configured.

#### Root Cause 2: Unreadable and Misplaced "Start Safety Session" Button

The current "START SAFETY SESSION" button (`kanban.html:7956–7963`) uses the `complexity-routing-btn` CSS class (lines 1151–1201), which is designed for 28×28px icon buttons — not text buttons. The button has poor contrast/readability in the worktrees tab context. The button is also buried inside the worktree viewer / session state panel rather than presented as the primary action of the tab.

#### Root Cause 3: Hardcoded Single Workflow

The entire tab is built around a single hardcoded concept — the "Safety Session" — which creates a git worktree and stores branch/path metadata in the kanban DB. There is no configurability for what happens to agent terminals when a worktree is created. The user currently has no way to specify:
- Whether agents should be spawned in the worktree or the control plane
- Whether existing agents should be reused, reset, or left alone
- Whether the choice should persist across VS Code restarts

#### Why Control Plane Should Be Optional

The current code assumes a control plane is mandatory (`kanban.html:7919`). However, a worktree is a valid git construct on its own. A user may want to create a worktree in the current workspace and have agents work directly inside it without any control-plane indirection. The tab's logic should support both modes.

---

## Metadata

**Tags:** frontend, backend, ux, feature, api
**Complexity:** 8

---

## User Review Required

- [ ] Confirm the four radio-menu behaviour options match intended product behaviour (especially "Use existing agents" — should this option exist if it requires terminal-liveness detection from the webview?)
- [ ] Confirm that agent startup commands should always be queried from the workspace/control-plane root (not the worktree path), even when terminals are spawned with `cwd` set to the worktree. Justification: agent configurations are workspace-level settings stored in VS Code config and DB, not worktree-local.
- [ ] Confirm the single-worktree constraint is acceptable for v1, or whether multi-worktree support should be planned.

---

## Complexity Audit

### Routine
- Adding control plane fields to three `updateWorkspaceSelection` payloads in `KanbanProvider.ts` (lines 1123, 1842, 1981) — mechanical field addition; existing `getControlPlaneSelectionStatus()` method (lines 3579–3606) already returns all needed fields
- Replacing `complexity-routing-btn` with `worktree-primary-btn` CSS class for ALL buttons in the worktree panel (not just the primary action button)
- Adding `getWorktreeConfig`, `createWorktree`, `clearRememberedWorktreeChoice` message handlers — follows existing handler pattern in `_handleMessage` switch (line 3921)
- Persisting behaviour/path to `kanban_meta` table — uses existing `setMeta()`/`getMeta()` API (KanbanDatabase.ts:1402–1422), no schema changes
- Renaming "Safety Session" → "Worktree" labels throughout the tab
- Adding `clearRememberedWorktreeChoice` calls to existing `mergeSafetySession` and `abandonSafetySession` handlers

### Complex / Risky
- **Terminal liveness detection for "Use existing agents" option**: The webview has no current mechanism to query whether agent terminals are alive. Requires adding an `activeTerminalCount` field to the `getWorktreeConfig` response, derived from `vscode.window.terminals` filtered by grid-matched names on the extension host side.
- **`worktreeReset` disposal strategy**: Requires a new `disposeAllGridTerminals()` function that disposes ALL grid-matched terminals (not just exited/duplicate ones like the existing `clearGridBlockers` at extension.ts:2187–2237). This is a fundamentally different disposal strategy that could kill healthy terminals mid-task.
- **`createAgentGrid` cwd override**: Modifying the function signature and adding DB-read logic introduces a new coupling point. The override must affect terminal `cwd` (line 2258) while keeping agent config queries (`getVisibleAgents`, `getCustomAgents`, `getStartupCommands` at lines 2151–2154) pointed at the workspace root, since configs are workspace-level settings.
- **Message type migration**: Replacing `startSafetySession`/`getSafetySession`/`safetySession` with `createWorktree`/`getWorktreeConfig`/`worktreeConfig` while maintaining backward compatibility for the `safetySession` response message (still sent after worktree creation for other consumers).

---

## Edge-Case & Dependency Audit

### Race Conditions
- **Terminal creation during `worktreeReset`**: If the user clicks "Create New Worktree" with `worktreeReset` behaviour while agents are actively running commands, disposing terminals mid-execution could leave the worktree in a partial state. Mitigation: Confirm dialog before disposing active terminals.
- **Concurrent `createWorktree` calls**: Double-clicking the button could trigger two worktree creations. Mitigation: Disable button immediately on click; re-enable only after response or error.
- **Stale remembered path on startup**: If the remembered worktree path is deleted between VS Code sessions, `createAgentGrid` must detect this before using the path. Mitigation: `fs.existsSync()` check before using remembered path; clear and notify if missing.

### Security
- **Path injection via remembered worktree path**: The `worktree_remembered_path` meta value is read from the DB and used as `cwd` for terminal creation. If the DB is tampered with, this could point to an arbitrary directory. Mitigation: Validate that the path is within a known workspace root before using it.

### Side Effects
- **`worktreeReset` disposes terminals that may be running other tasks**: If the user has non-grid terminals with names matching grid agent names, they could be incorrectly disposed. Mitigation: Only dispose terminals registered in `registeredTerminals` map with `purpose: 'agent-grid'`.
- **Merge/abandon clears remembered choice even if user manually set it**: The plan specifies clearing the remembered choice on merge/abandon, which is correct, but the user should be notified that their preference was cleared.

### Dependencies & Conflicts
- **`getControlPlaneSelectionStatus()` method** (KanbanProvider.ts:3579–3606): Must be called to populate the new fields. Already exists and returns all needed data via `ControlPlaneSelectionStatus` type (lines 55–68).
- **`kanban_meta` table** (KanbanDatabase.ts:213–216): Key-value store used for persistence. Existing `getMeta()`/`setMeta()` methods (lines 1402–1422) support the new keys without schema changes.
- **`_createSafetyWorktree()` method** (KanbanProvider.ts:6366–6388): Reused as-is for git worktree creation. Creates worktree as child directory of workspace root (`path.join(workspaceRoot, branchName)`) — existing behavior, no change needed. **Note:** If the workspace root is the control plane, the worktree ends up as a subdirectory of the control plane. This is the current behavior and is not changed by this plan.
- **`clearGridBlockers` function** (extension.ts:2187–2237): Used for deduplication only — disposes EXITED terminals and DUPLICATE healthy terminals, preserving the first healthy terminal per agent. A new `disposeAllGridTerminals()` function is needed for the `worktreeReset` behaviour — these are different operations and must not be conflated.
- **`resolveEffectiveWorkspaceRoot()` method**: Used by `createAgentGrid` at line 2150. The cwd override should NOT change this resolution — it determines where agent configs are read from. Only the terminal `cwd` at line 2258 should be overridden.

---

## Dependencies

- `sess_None — No external session dependencies. All changes are internal to the switchboard extension.`

---

## Adversarial Synthesis

Key risks: (1) "Use existing agents" option requires terminal-liveness data that the webview currently cannot access — without an `activeTerminalCount` field in the config response, the disabled state will never trigger. (2) `worktreeReset` disposal conflates two different strategies — the existing `clearGridBlockers` preserves healthy terminals, but `worktreeReset` must kill them all, requiring a new dedicated `disposeAllGridTerminals()` function. (3) The `createAgentGrid` cwd override must only affect terminal `cwd`, not agent config queries, to avoid reading configs from the wrong root. Mitigations: Add `activeTerminalCount` to `getWorktreeConfig` response; create separate `disposeAllGridTerminals()` function; split cwd override from config root resolution.

---

## Requirements & Edge Cases

### Behaviour Options (Radio Menu)

The radio menu must offer exactly these four mutually exclusive options:

1. **Use existing agents** — Does not create or modify any agent terminals. Assumes agents are already running in the control plane directory (if one exists) or workspace root. This option is disabled/greyed out if no agent terminals are currently alive (determined by `activeTerminalCount` field from `getWorktreeConfig` response).
2. **Create new agents in control plane directory** — Calls `createAgentGrid` with `cwd` set to the control plane directory (or workspace root if no control plane). Existing terminals are deduplicated/cleaned via the existing `clearGridBlockers` logic.
3. **Reset existing agents and create new agent terminals in worktree directory** — Explicitly disposes all existing grid-matched terminals via new `disposeAllGridTerminals()` function, then calls `createAgentGrid` with `cwd` set to the newly created worktree path.
4. **Create new agent terminals in worktree directory** — Calls `createAgentGrid` with `cwd` set to the newly created worktree path. Does **not** dispose existing terminals; new terminals are created alongside any existing ones (VS Code will append " (2)" suffixes as usual).

### "Remember Choice for Next Startup"

- When checked, the selected radio option and the active worktree path are persisted to `kanban_meta` (keys: `worktree_agent_behaviour`, `worktree_remembered_path`, `worktree_remember_enabled`).
- On the next VS Code session, when the user clicks **"Open Agent Grid"** (status bar button, command palette, or kanban automation), `createAgentGrid` reads these settings. If `worktree_remember_enabled` is true and `worktree_remembered_path` still exists on disk, it uses that path as `cwd` instead of `effectiveWorkspaceRoot`.
- The remembered choice is automatically cleared when:
  - The user clicks **"Abandon Worktree"** (deletes the worktree).
  - The user clicks **"Merge Back"** (merges the worktree and deletes it).
  - The remembered worktree path no longer exists on disk (detected at startup, with an info notification).
- A manual **"Clear Remembered Choice"** button should be available in the tab for explicit reset.

### Worktree Lifecycle

- Only **one active worktree** is supported at a time (consistent with the current safety-session model). The kanban DB already stores this via `active_safety_session_branch`, `active_safety_session_path`, and `active_safety_session_started_at`.
- The new tab should still display the active worktree's branch, path, and start time when one exists.
- The "Create New Worktree" button must be disabled if a worktree already exists, with a clear message: "An active worktree already exists. Abandon or merge it before creating a new one."

### Control Plane Optional

- The warning banner should be replaced with an **informational note** (not a warning) when no control plane is configured: "No control plane configured. Agents will run in the workspace root unless a worktree directory is selected."
- Options 1 and 2 that reference the "control plane directory" should gracefully fall back to the **workspace root** when no control plane is configured.

### Agent Grid Integration

- `extension.ts:createAgentGrid()` currently hardcodes `cwd: effectiveWorkspaceRoot` (`line 2258`).
- It must be modified to accept an optional `options?: { cwdOverride?: string }` parameter, or to check the kanban DB for remembered worktree settings before defaulting to `effectiveWorkspaceRoot`.
- **Important**: Agent config queries (`getVisibleAgents`, `getCustomAgents`, `getStartupCommands` at lines 2151–2154) must continue using `effectiveWorkspaceRoot` — agent configurations are workspace-level settings, not worktree-local. Only the terminal `cwd` is overridden.
- The `TaskViewerProvider` terminal state records (`terminals` state object) must store `worktreePath` for terminals created inside a worktree, so the system can track which agents belong to which directory.

---

## Proposed Changes

### `src/services/KanbanProvider.ts`

**Context:** Central provider for the kanban webview. Handles all message passing between extension host and webview.

#### Phase 1: Fix False Warning Banner (Lines 1123, 1842, 1981)

Add control plane fields to all three `updateWorkspaceSelection` payloads. Before each `postMessage` call, obtain the status object:

```typescript
const cpStatus = this.getControlPlaneSelectionStatus(resolvedWorkspaceRoot);
```

Then add these fields to each payload object:
- `controlPlaneMode: cpStatus.mode`
- `controlPlaneRoot: cpStatus.controlPlaneRoot`
- `effectiveControlPlaneRoot: cpStatus.effectiveWorkspaceRoot`
- `explicitControlPlaneRoot: cpStatus.explicitControlPlaneRoot`
- `pendingCandidate: cpStatus.pendingCandidate`
- `repoScopeFilter: cpStatus.repoScopeFilter`

**Verification:** Open the Worktrees tab with a configured control plane. The red warning banner must not appear.

#### Phase 3: New Message Handlers (after line ~6153)

1. **`getWorktreeConfig` handler** — Replaces `getSafetySession`. Reads from kanban DB:
   - Existing keys: `active_safety_session_branch`, `active_safety_session_path`, `active_safety_session_started_at`
   - New keys: `worktree_agent_behaviour`, `worktree_remembered_path`, `worktree_remember_enabled`
   - **Clarification**: Also computes `activeTerminalCount` by filtering `vscode.window.terminals` for grid-matched names. This enables the "Use existing agents" disabled state in the webview. The matching logic should mirror the `matchesGridAgentName` pattern from `extension.ts:2164–2175` — consider extracting a shared helper or exposing a method on `TaskViewerProvider`.
   - Responds with `worktreeConfig` message containing all fields plus `hasActiveSession` boolean.
   - Also sends `safetySession` message for backward compatibility with other consumers.

2. **`createWorktree` handler** — Replaces `startSafetySession` (line 6051). Accepts `agentBehaviour` and `rememberChoice` from the webview:
   - Creates the git worktree via `_createSafetyWorktree(workspaceRoot)` (existing, line 6366)
   - Stores session metadata (existing keys)
   - Based on `agentBehaviour`:
     - `existing`: Do nothing with terminals. If no terminals are alive, show a warning: "No active agent terminals found. Consider creating new agents instead."
     - `controlPlaneNew`: Call `createAgentGrid({ cwdOverride: cpStatus.effectiveWorkspaceRoot })`.
     - `worktreeReset`: Call new `disposeAllGridTerminals()`, then `createAgentGrid({ cwdOverride: wtPath })`.
     - `worktreeNew`: Call `createAgentGrid({ cwdOverride: wtPath })`.
   - If `rememberChoice` is true, persist `worktree_agent_behaviour`, `worktree_remembered_path`, `worktree_remember_enabled` to kanban_meta.
   - Sends `safetySession` message (backward compat) AND `worktreeConfig` message.

3. **`clearRememberedWorktreeChoice` handler** — Clears the three new kanban_meta keys. Also called from `mergeSafetySession` and `abandonSafetySession` handlers (add calls after the existing `setMeta('active_safety_session_*', '')` blocks at lines 6097–6099 and 6145–6147).

**Edge Cases:**
- If `agentBehaviour` is `controlPlaneNew` and no control plane is configured, fall back to workspace root for `cwdOverride`.
- The `getSafetySession` handler should be updated to also return the new worktree config fields, OR deprecated in favor of `getWorktreeConfig`. **Recommended**: Keep `getSafetySession` as a thin wrapper that calls the same internal logic as `getWorktreeConfig` and sends both message types.

### `src/webview/kanban.html`

**Context:** The kanban webview HTML. Contains all tab rendering logic and message handlers.

#### Phase 2: Refactor Worktrees Tab UI

1. **Replace warning banner** (lines 7919–7923): Remove the red warning block. Replace with a subtle informational note (blue/teal background, not red) that only appears when no control plane is configured:
   ```
   "No control plane configured. Agents will run in the workspace root unless a worktree directory is selected."
   ```

2. **Replace `createSafetySessionPanel()`** (lines 7915–8058) with new `renderWorktreesTab()` function.

3. **New UI Structure** (no active worktree):
   ```
   ┌─ WORKTREE CONFIGURATION ─────────────┐
   │ Agent terminal behaviour:            │
   │ (•) Use existing agents              │
   │ ( ) Create new agents in control     │
   │     plane directory                  │
   │ ( ) Reset existing agents and create │
   │     new agent terminals in worktree  │
   │ ( ) Create new agent terminals in    │
   │     worktree directory               │
   │                                      │
   │ [☐] Remember choice for next startup │
   │                                      │
   │ [  Create New Worktree  ]            │
   └──────────────────────────────────────┘
   ```
   - "Use existing agents" radio is disabled/greyed out when `activeTerminalCount === 0` (from `worktreeConfig` response).

4. **When a worktree is active**, display a status card below the config:
   ```
   ┌─ ACTIVE WORKTREE ──────────────────┐
   │ Branch: switchboard-safety-...     │
   │ Path: /Users/.../workspace/...     │
   │ Started: Jun 9, 2026, 10:00 AM   │
   │                                      │
   │ [   Merge Back   ]                 │
   │ [ Ask Agent To Merge ]             │
   │ [ Abandon Worktree ]               │
   │ [ Clear Remembered Choice ]        │
   └──────────────────────────────────────┘
   ```

5. **Styling:** Replace ALL uses of `complexity-routing-btn` in the worktree panel with new `worktree-primary-btn` class:
   - Primary action: teal background (#00ad9f), white text, 14px font, 8px 16px padding
   - Destructive action: red border (#e55), red text, same sizing
   - Secondary action: transparent background, teal border, teal text
   - All buttons: `width: 100%; text-align: center; border-radius: 4px; cursor: pointer; font-size: 14px; padding: 8px 16px;`

6. **State hydration:** On tab activation (lines 3513–3516), replace `loadSafetySession()` + `renderSafetySessionPanel()` with `loadWorktreeConfig()` + `renderWorktreesTab()`. The `loadWorktreeConfig()` function posts `getWorktreeConfig` message.

7. **Message handler update** (lines 5596–5600): Add `worktreeConfig` case that stores the config and re-renders:
   ```javascript
   case 'worktreeConfig': {
       lastWorktreeConfig = msg;
       lastSafetySession = msg.hasActiveSession ? { branch: msg.branch, path: msg.path, startedAt: msg.startedAt, pathExists: msg.pathExists } : null;
       renderWorktreesTab();
       break;
   }
   ```
   Keep the existing `safetySession` case for backward compatibility.

8. **"Create New Worktree" button disabled state:** When `hasActiveSession` is true, disable the button and show: "An active worktree already exists. Abandon or merge it before creating a new one."

9. **Double-click protection:** Disable the "Create New Worktree" button immediately on click; re-enable only after the `worktreeConfig` response or an error.

### `src/extension.ts`

**Context:** Main extension entry point. Contains `createAgentGrid()` and command registrations.

#### Phase 4: Agent Grid `cwd` Override (Lines 2142–2358)

1. **Modify function signature** (line 2142):
   ```typescript
   async function createAgentGrid(options?: { cwdOverride?: string }) {
   ```

2. **Determine effective cwd** (after line 2150):
   ```typescript
   let effectiveCwd = effectiveWorkspaceRoot;
   if (options?.cwdOverride) {
       effectiveCwd = options.cwdOverride;
   } else {
       // Check for remembered worktree path
       const db = kanbanProvider?._getKanbanDb(currentWorkspaceRoot);
       if (db && await db.ensureReady()) {
           const rememberEnabled = await db.getMeta('worktree_remember_enabled');
           if (rememberEnabled === 'true') {
               const rememberedPath = await db.getMeta('worktree_remembered_path');
               if (rememberedPath && fs.existsSync(rememberedPath)) {
                   effectiveCwd = rememberedPath;
               } else if (rememberedPath) {
                   // Stale path — clear and notify
                   await db.setMeta('worktree_remember_enabled', '');
                   await db.setMeta('worktree_remembered_path', '');
                   vscode.window.showInformationMessage('Remembered worktree path no longer exists. Using workspace root instead.');
               }
           }
       }
       // Fallback: if DB not ready or no remembered path, effectiveCwd stays as effectiveWorkspaceRoot
   }
   ```

3. **Apply cwd override** (line 2258): Replace `cwd: effectiveWorkspaceRoot` with `cwd: effectiveCwd`.

4. **Keep config queries at workspace root** (lines 2151–2154): `getVisibleAgents`, `getCustomAgents`, `getStartupCommands` continue to use `effectiveWorkspaceRoot` — agent configs are workspace-level settings, not worktree-local.

5. **New `disposeAllGridTerminals()` function** (add before `createAgentGrid`):
   ```typescript
   async function disposeAllGridTerminals() {
       for (const [name, terminal] of Array.from(registeredTerminals.entries())) {
           if (terminal.exitStatus === undefined) {
               outputChannel?.appendLine(`[Extension] Disposing grid terminal '${name}' for worktreeReset`);
               terminal.dispose();
           }
           registeredTerminals.delete(name);
       }
       await taskViewerProvider.updateState(async (state: any) => {
           if (!state.terminals) state.terminals = {};
           const currentIde = vscode.env.appName || '';
           for (const key of Object.keys(state.terminals)) {
               const entry = state.terminals[key];
               if (entry?.purpose === 'agent-grid' && isCompatibleIdeName(entry.ideName, currentIde)) {
                   delete state.terminals[key];
               }
           }
       });
   }
   ```
   **Important:** This is NOT the same as `clearGridBlockers`. `clearGridBlockers` preserves the first healthy terminal per agent. `disposeAllGridTerminals` kills everything. Do not conflate them.

6. **Update command registration** (lines 670–677): No changes needed — commands call `createAgentGrid()` with no options, which triggers the remembered-path logic.

7. **Terminal state tracking**: When terminals are created with a worktree `cwd`, the `terminals` state object should store `worktreePath` for tracking. Add to the batch registration object:
   ```typescript
   if (effectiveCwd !== effectiveWorkspaceRoot) {
       state.terminals[reg.name].worktreePath = effectiveCwd;
   }
   ```

**Edge Cases:**
- DB not ready when `createAgentGrid` checks remembered path → fall back to `effectiveWorkspaceRoot` (the `if (db && await db.ensureReady())` guard handles this).
- Path validation: The `cwdOverride` path should be validated as an existing directory before use. Add `fs.existsSync()` check.

### `src/services/KanbanDatabase.ts`

**Context:** SQLite database wrapper. No schema changes needed.

- Uses existing `kanban_meta` table (schema at lines 213–216) and `getMeta()`/`setMeta()` methods (lines 1402–1422).
- New keys to be stored: `worktree_agent_behaviour`, `worktree_remembered_path`, `worktree_remember_enabled`.
- No code changes required in this file.

### Phase 5: Cleanup & Deprecation

1. **Rename message types** in `kanban.html`:
   - `startSafetySession` → `createWorktree` (with `agentBehaviour` and `rememberChoice` fields)
   - `getSafetySession` → `getWorktreeConfig`
   - Keep `safetySession` response handler for backward compatibility

2. **Rename UI labels** from "Safety Session" to "Worktree" throughout the tab:
   - "SAFETY SESSION" header → "WORKTREE CONFIGURATION"
   - "NO ACTIVE SAFETY SESSION" → "NO ACTIVE WORKTREE"
   - "ACTIVE SAFETY SESSION" → "ACTIVE WORKTREE"
   - "START SAFETY SESSION" → "Create New Worktree"
   - "ABANDON SESSION" → "Abandon Worktree"
   - "CLEAR SESSION RECORD" → "Clear Session Record" (keep — it's about the DB record, not the worktree)

3. **Keep `mergeSafetySession` and `abandonSafetySession` message types** in KanbanProvider.ts — they perform git operations that are worktree-agnostic. Add `clearRememberedWorktreeChoice` calls to both.

---

## Files Changed

- `src/services/KanbanProvider.ts` — Add control plane fields to `updateWorkspaceSelection` payloads (lines 1123, 1842, 1981); add `getWorktreeConfig`, `createWorktree`, `clearRememberedWorktreeChoice` message handlers; update merge/abandon handlers to clear remembered choice.
- `src/webview/kanban.html` — Rewrite `createSafetySessionPanel` → `renderWorktreesTab` (lines 7915–8058); add radio menu, remember checkbox, new button styling (`worktree-primary-btn` for ALL panel buttons); update tab hydration logic (lines 3513–3516); add `worktreeConfig` message handler; add double-click protection.
- `src/extension.ts` — Modify `createAgentGrid` (line 2142) to support `options?: { cwdOverride?: string }` parameter and remembered worktree `cwd` override; add `disposeAllGridTerminals()` function; add `worktreePath` to terminal state records.
- `src/services/KanbanDatabase.ts` — No schema changes required (uses existing `kanban_meta` table).

---

## Verification Plan

### Automated Tests

- No automated tests specified (SKIP TESTS directive). Manual verification below.

### Manual Verification

- [ ] With a configured control plane, the Worktrees tab shows no red warning banner.
- [ ] Without a control plane, the tab shows an informational note (not a warning) and all options still function.
- [ ] Creating a worktree with "Create new agent terminals in worktree directory" opens new terminals with `cwd` set to the worktree path.
- [ ] "Use existing agents" radio is disabled when no agent terminals are alive (`activeTerminalCount === 0`).
- [ ] Checking "Remember choice for next startup", closing VS Code, reopening, and clicking "Open Agent Grid" opens terminals in the remembered worktree path.
- [ ] Merging or abandoning the worktree clears the remembered choice.
- [ ] The "Create New Worktree" button is disabled when a worktree already exists.
- [ ] All buttons in the worktree panel use `worktree-primary-btn` styling with readable text (14px+, high contrast).
- [ ] `createAgentGrid` called from command palette uses remembered worktree path if one exists.
- [ ] `createAgentGrid` called from KanbanProvider with explicit `cwdOverride` bypasses remembered logic.
- [ ] Stale remembered path (deleted between sessions) is detected and cleared with info notification.
- [ ] `worktreeReset` behaviour disposes ALL grid terminals (not just duplicates/exited ones).
- [ ] Agent config queries (`getVisibleAgents`, `getCustomAgents`, `getStartupCommands`) always use workspace root, not worktree path.

---

## Risks

- **Terminal state desync:** If `createAgentGrid` opens terminals in a worktree but the user later deletes the worktree outside of Switchboard, the remembered path will be stale. Mitigation: Check path existence before using remembered path; clear and notify if missing.
- **Multiple worktrees not supported:** Users may expect to create multiple worktrees. The current single-worktree model is retained for scope control, but the UI should make this limitation clear.
- **Breaking change to `startSafetySession` message:** The webview will send `createWorktree` instead. Old extension versions will ignore it. Ensure graceful degradation or bump the minimum extension version if needed.
- **`worktreeReset` kills active terminals:** Disposing terminals mid-execution could lose in-progress work. Mitigation: Confirm dialog before disposing active terminals when `worktreeReset` is selected.

---

**Recommendation:** Complexity 8 → **Send to Lead Coder**
