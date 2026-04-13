# Add Operation Mode Toggle for Event-Driven Integrations

## Goal

Provide a simple way to switch between "Coding Mode" (normal planning/coding workflow) and "Board Management Mode" (event-driven ClickUp/Linear automation). These modes are mutually exclusive because automation polling that creates plans from external tasks would interfere with active coding sessions.

## Metadata

**Tags:** backend, UI
**Complexity:** 6
**Session ID:** sess_1744512000000
**Plan ID:** add_operation_mode_toggle_for_event_driven_integrations

## User Review Required

> [!NOTE]
> - **Two distinct modes**: Coding Mode = normal Switchboard usage for planning and coding. Board Management Mode = passive automation that polls ClickUp/Linear, creates plans from external tasks, and writes back results when plans complete.
> - **Mutual exclusivity**: When in Board Management Mode, automation polling is active. When in Coding Mode, all automation polling is paused to avoid interfering with active work.
> - **Simple toggle**: A single toggle/button in the Kanban header or setup panel switches between modes. Mode is persisted per workspace.
> - **Default state**: New workspaces start in Coding Mode. Existing workspaces with automation configured should stay in Coding Mode until explicitly switched.
> - **Visual indicator**: The Kanban board should clearly show which mode is active (e.g., header color change, badge, or status text).

## Complexity Audit

### Routine
- **Add `_operationMode` property** to `KanbanProvider` class (line ~132 in `src/services/KanbanProvider.ts`) with persistence key `switchboard.operationMode` via `this._context.workspaceState`
- **Add getter/setter methods** (`getOperationMode()`, `setOperationMode()`) to `KanbanProvider`
- **Add `switchOperationMode` message handler** in `KanbanProvider._handleMessage()` (line ~2376)
- **Replace kanban.html setup buttons** (lines 1150-1151: `clickup-setup-btn`, `linear-setup-btn`) with single mode toggle button + CSS classes
- **Remove old click handlers** (lines 1779-1785 in kanban.html) and replace with mode toggle handler
- **Add mode badge** to setup.html Project Management accordion header (line ~709)
- **Add mode toggle buttons** to setup.html Project Management section
- **Broadcast mode state** on board refresh in `_refreshBoardWithData()` (line ~1350)
- **Add `handleSwitchOperationMode()` method** to `TaskViewerProvider` (follows existing `handle*` pattern)
- **Add `switchOperationMode` handler** to `SetupPanelProvider._handleMessage()` (line ~261, delegates to `TaskViewerProvider`)
- **Add `getClickUpConfig()` / `getLinearConfig()` public helpers** to `KanbanProvider` (thin wrappers around `_getClickUpService().loadConfig()`)

### Complex / Risky
- **Mode transition logic**: `setOperationMode()` must call `_configureClickUpAutomation()` / `_configureLinearAutomation()` to start automation, or `IntegrationAutoPullService.stop()` for each integration key to stop. Must handle the case where services aren't yet configured (no config file, setup incomplete).
- **Sync suppression in Board Management Mode**: Column-move sync hooks exist in at least 4 places in `_handleMessage`: `moveCardBackwards` (lines 2546-2591), `moveCardForward` (lines 2613-2659), and indirectly via `_queueClickUpSync` (line 950). Linear sync is **inline** (not via a helper like `_queueClickUpSync`) — needs a new `_queueLinearSync` helper or inline guards at both `moveCardBackwards` and `moveCardForward`.
- **Race condition prevention**: `IntegrationAutoPullService.stop()` sets `enabled=false` and clears the scheduled timeout, but if a poll is already `inFlight`, the state entry lingers until the runner completes (line 63 / line 118-119 in `IntegrationAutoPullService.ts`). A subsequent `setOperationMode('board-management')` call to `_configureClickUpAutomation()` would call `.configure()` which safely replaces the state (line 34-39). This is safe but the plan must verify no double-scheduling occurs.
- **Option B (Continuous File Sync)**: Described in the README section below as an alternative workflow — involves file watchers, debounced sync, termination conditions, and agent prompt integration. This is **separate implementation scope** and should be extracted to its own plan if pursued.

## Edge-Case & Dependency Audit

- **Race Conditions:** `IntegrationAutoPullService.stop()` gracefully handles in-flight polls — sets `enabled=false`, clears timeout, but defers `_states.delete(key)` until `inFlight` completes (lines 60-65 in `IntegrationAutoPullService.ts`). A rapid toggle (Coding → Board Mgmt → Coding) is safe because `.configure()` replaces the existing state entry (lines 34-39). No double-scheduling risk because `_scheduleNext` checks `!state.inFlight` before scheduling (line 93). **Verified safe.**
- **Security:** No new attack surface. Mode state is stored in VS Code `workspaceState` (local-only, not synced). No tokens or credentials involved.
- **Side Effects:**
  - Switching to Coding Mode stops automation polling — external tasks tagged for auto-import will queue up in ClickUp/Linear until Board Management Mode is re-enabled.
  - One-way import (auto-pull) is **not** affected by mode toggle — the plan only gates `clickup-automation` and `linear-automation` integration keys, not `clickup` and `linear` auto-pull keys.
  - Intermediate column-move sync is suppressed in Board Management Mode — ClickUp/Linear won't see `PLAN REVIEWED`, `CODER CODED`, etc. states.
  - Existing users with ClickUp automation running will not experience behavior change until they explicitly toggle modes (default is Coding Mode).
- **Workspace Switching:** Mode is per-workspace via `workspaceState`. Switching workspaces loads the correct mode. `initializeIntegrationAutoPull()` is called on workspace folder changes (extension.ts line 1109-1111) and respects the persisted mode.
- **Mode Persistence:** `workspaceState.update()` persists across VS Code reloads. Constructor reads persisted value on startup.
- **Dependencies & Conflicts:**
  - **"Extend Event Monitoring and Ticket Write-Back to Linear"** (Reviewed, sess_1776031535469): Creates `LinearAutomationService` that this plan's `_configureLinearAutomation()` depends on. If that plan isn't merged first, the Linear automation start/stop in `setOperationMode()` will silently no-op (no rules configured). **Low risk — graceful degradation.**
  - **"Simplify ClickUp Automation"** (Reviewed, sess_1775997088348): May restructure `ClickUpAutomationService` config format or the automation rules interface. If merged first, verify `config.automationRules.some(rule => rule.enabled !== false)` still works as the guard in `_configureClickUpAutomation()`. **Medium risk — verify interface.**
  - **"Remove ClickUp Automation Technical Debt"** (Reviewed, sess_1776025643864): May change `ClickUpAutomationService` method signatures. **Medium risk — verify after merge.**
  - **"Add Kanban Column Management to Setup Panel"** (Reviewed, sess_1776023708343): Also modifies `setup.html` Project Management section. **Low risk — changes are in separate DOM areas (column management vs. mode toggle).**
  - **"Fix Setup Panel Organization and Implement Modern Autosave"** (Reviewed): Also modifies `setup.html` structure. **Low risk — additive changes.**

## Adversarial Synthesis

### Grumpy Critique

Oh *brilliant*, another boolean flag masquerading as an architecture decision. Let me count the ways this plan tries to kill us:

1. **The Linear sync guard is MISSING.** The plan adds a guard to `_queueClickUpSync()` (great, one entry point). But Linear sync? It's **inline** in `moveCardBackwards` (lines 2562-2591) and `moveCardForward` (lines 2630-2659) — raw `linear.debouncedSync()` calls scattered through the handler. The plan proposes *nothing* for Linear sync suppression. So in Board Management Mode, ClickUp won't see intermediate states but Linear will happily broadcast every column move. Brilliant asymmetry.

2. **`initializeIntegrationAutoPull()` ignores mode.** This method (line 973) is called on extension activation AND on workspace folder changes. It unconditionally calls `_configureClickUpAutomation()` and `_configureLinearAutomation()`. So even if the user is in Coding Mode, every time they open their IDE or change workspace folders, automation gets reconfigured. The mode guard inside `_configureClickUpAutomation()` fixes this *if* the guard is the first thing in the method, but the plan's code shows `// ... rest of existing logic` — a PLACEHOLDER. If the implementer puts the guard *after* the rules check, the `IntegrationAutoPullService.stop()` call on line 855 happens anyway (good) but the `.configure()` call on line 860 also runs, starting the timer. Mode check must be the VERY FIRST line.

3. **Option B is scope creep wearing a trench coat.** Sixty lines of "documentation" that includes TypeScript implementation blocks for file watchers, debounced sync, termination conditions, cleanup handlers, and agent prompt integration. That's not a README section — that's a whole separate feature plan pretending to be a workflow example. Anyone implementing this plan will see those code blocks and think they need to build them. Label it clearly or extract it.

4. **The `needsSetup` check is fragile.** The plan calls `this._getClickUpService().isAvailable()` and `this._getLinearService().isAvailable()` — both are async methods that make **network requests** with 2-second timeouts (verified in ClickUpSyncService.ts line 548, LinearSyncService.ts line 238). On *every board refresh*. That's two HTTP roundtrips blocking mode UI rendering. If ClickUp or Linear is down, the mode toggle shows "SETUP INTEGRATIONS" even though setup is complete.

5. **The `_configureClickUpAutomation` and `_configureLinearAutomation` code blocks use placeholders.** `// ... rest of existing logic` and `// ... rest of existing logic (from extend_automation_to_linear.md)`. The how_to_plan rules explicitly forbid `// ... existing code ...` placeholders. The implementer needs to see the COMPLETE modified function.

6. **SetupPanelProvider routing is wrong.** The plan proposes `this._taskViewerProvider?.getKanbanProvider?.()` but `TaskViewerProvider` has no `getKanbanProvider()` method. The plan adds one, but the setup panel message goes: webview → `SetupPanelProvider._handleMessage()` → `TaskViewerProvider.getKanbanProvider()` → `KanbanProvider.setOperationMode()`. That's THREE hops. Why not just route through `TaskViewerProvider` like every other setup panel action? Add a `handleSwitchOperationMode()` method to `TaskViewerProvider` and call it from `SetupPanelProvider` — consistent with the existing pattern.

### Balanced Response

The Grumpy critique identifies six concrete issues. Here's how each is addressed in the implementation below:

1. **Linear sync guard**: A new `_queueLinearSync()` helper method is added (mirroring `_queueClickUpSync`) with the same Board Management Mode guard. The inline `linear.debouncedSync()` calls in `moveCardBackwards` and `moveCardForward` are replaced with calls to this helper.

2. **`initializeIntegrationAutoPull()` mode awareness**: The mode guard is placed as the **first check** in both `_configureClickUpAutomation()` and `_configureLinearAutomation()`, before any config loading or rules checking. When mode is `'coding'`, the method calls `.stop()` and returns immediately.

3. **Option B scope**: Clearly labeled as "**Future Scope — Not Part of This Plan**" in the documentation section. Implementation code blocks are retained as design notes but explicitly marked as deferred.

4. **`needsSetup` check**: Replaced with `loadConfig()` + `config?.setupComplete` check (synchronous file read, already cached in many paths) instead of `isAvailable()` (network request). This avoids HTTP roundtrips on every refresh.

5. **Code placeholders**: All code blocks now show the complete modified function bodies with no truncation.

6. **SetupPanelProvider routing**: Uses the established pattern — `TaskViewerProvider.handleSwitchOperationMode()` delegates to `KanbanProvider.setOperationMode()`. No `getKanbanProvider()` getter needed. Consistent with how `handleSetupClickUp()`, `handleSetupLinear()`, etc. already work.

## Agent Recommendation

Send to Coder (Complexity 6 ≤ 6)

## Proposed Changes

### 1. Add Operation Mode State Management

#### [MODIFY] `src/services/KanbanProvider.ts`

Add operation mode state and persistence:

```typescript
// Add to class properties
private _operationMode: 'coding' | 'board-management' = 'coding';
private static readonly OPERATION_MODE_KEY = 'switchboard.operationMode';

// Add to constructor initialization
this._operationMode = this._context.workspaceState.get<'coding' | 'board-management'>(
    KanbanProvider.OPERATION_MODE_KEY, 
    'coding'
);

// Add public getter
public getOperationMode(): 'coding' | 'board-management' {
    return this._operationMode;
}

// Add mode switch method
public async setOperationMode(mode: 'coding' | 'board-management'): Promise<void> {
    if (this._operationMode === mode) { return; }
    
    this._operationMode = mode;
    await this._context.workspaceState.update(KanbanProvider.OPERATION_MODE_KEY, mode);
    
    // Start/stop automation based on mode
    if (mode === 'board-management') {
        await this._startAllAutomation();
    } else {
        await this._stopAllAutomation();
    }
    
    // Update UI
    this._panel?.webview.postMessage({ type: 'operationModeChanged', mode });
}

// Add automation lifecycle helpers
private async _startAllAutomation(): Promise<void> {
    const roots = this._getWorkspaceRoots();
    for (const workspaceRoot of roots) {
        await this._configureClickUpAutomation(workspaceRoot);
        await this._configureLinearAutomation(workspaceRoot);
    }
}

private async _stopAllAutomation(): Promise<void> {
    const roots = this._getWorkspaceRoots();
    for (const workspaceRoot of roots) {
        this._integrationAutoPull.stop(workspaceRoot, 'clickup-automation');
        this._integrationAutoPull.stop(workspaceRoot, 'linear-automation');
    }
}
```

### 2. Replace Setup Buttons with Unified Mode Toggle

#### [MODIFY] `src/webview/kanban.html`

**Remove** the separate "Setup ClickUp" and "Setup Linear" buttons from the controls strip. **Replace** them with a single unified mode toggle that doubles as the setup entry point.

**Current state (lines 1150-1151):**
```html
<button class="strip-btn" id="clickup-setup-btn" data-tooltip="Setup ClickUp Integration">Setup ClickUp</button>
<button class="strip-btn" id="linear-setup-btn" data-tooltip="Setup Linear Integration">Setup Linear</button>
```

**Replace with:**
```html
<!-- Unified mode toggle + setup entry point -->
<button class="strip-btn mode-toggle-btn" id="mode-toggle-btn" data-tooltip="Toggle Board Management Mode (auto-import from ClickUp/Linear)">
    <span id="mode-icon">💻</span>
    <span id="mode-label">CODING MODE</span>
</button>
```

Add styles for the mode toggle button:

```css
.mode-toggle-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.5px;
    transition: all 0.2s ease;
}

.mode-toggle-btn.coding-mode {
    background: color-mix(in srgb, var(--accent-green) 10%, transparent);
    border-color: color-mix(in srgb, var(--accent-green) 40%, transparent);
    color: color-mix(in srgb, var(--accent-green) 90%, var(--text-secondary));
}

.mode-toggle-btn.board-management-mode {
    background: color-mix(in srgb, var(--accent-teal) 10%, transparent);
    border-color: color-mix(in srgb, var(--accent-teal) 40%, transparent);
    color: color-mix(in srgb, var(--accent-teal) 90%, var(--text-secondary));
}

.mode-toggle-btn.needs-setup {
    background: color-mix(in srgb, var(--accent-orange) 10%, transparent);
    border-color: color-mix(in srgb, var(--accent-orange) 40%, transparent);
    color: color-mix(in srgb, var(--accent-orange) 90%, var(--text-secondary));
}

.mode-toggle-btn:hover:not(:disabled) {
    filter: brightness(1.15);
}
```

Add click handler (replaces old setup button handlers):

```javascript
// Mode toggle click handler - context-aware behavior
document.getElementById('mode-toggle-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('mode-toggle-btn');
    const needsSetup = btn.dataset.needsSetup === 'true';
    
    if (needsSetup) {
        // No integrations configured - open setup panel to Project Management section
        vscode.postMessage({ type: 'openSetupPanel', section: 'project-mgmt' });
    } else {
        // Toggle mode
        const currentMode = btn.dataset.mode || 'coding';
        const newMode = currentMode === 'coding' ? 'board-management' : 'coding';
        vscode.postMessage({ type: 'switchOperationMode', mode: newMode });
    }
});

// Update message handler to set needs-setup state
case 'operationModeChanged': {
    const btn = document.getElementById('mode-toggle-btn');
    const icon = document.getElementById('mode-icon');
    const label = document.getElementById('mode-label');
    
    btn.dataset.mode = message.mode;
    btn.classList.remove('coding-mode', 'board-management-mode', 'needs-setup');
    
    if (message.needsSetup) {
        btn.classList.add('needs-setup');
        btn.dataset.needsSetup = 'true';
        icon.textContent = '⚙️';
        label.textContent = 'SETUP INTEGRATIONS';
        btn.dataset.tooltip = 'Click to set up ClickUp or Linear integration';
    } else if (message.mode === 'coding') {
        btn.classList.add('coding-mode');
        btn.dataset.needsSetup = 'false';
        icon.textContent = '�';
        label.textContent = 'CODING MODE';
        btn.dataset.tooltip = 'Click to enable Board Management Mode (polls ClickUp/Linear for tasks)';
    } else {
        btn.classList.add('board-management-mode');
        btn.dataset.needsSetup = 'false';
        icon.textContent = '📋';
        label.textContent = 'BOARD MGMT MODE';
        btn.dataset.tooltip = 'Click to switch back to Coding Mode';
    }
    break;
}
```

**Remove** the old clickup/linear setup button handlers (lines ~1779-1785):
```javascript
// REMOVE these handlers:
// document.getElementById('clickup-setup-btn')?.addEventListener('click', ...)
// document.getElementById('linear-setup-btn')?.addEventListener('click', ...)
```

### 3. Add Mode Message Handler

#### [MODIFY] `src/services/KanbanProvider.ts`

Add message handler in the webview message switch:

```typescript
case 'switchOperationMode': {
    const workspaceRoot = this._resolveWorkspaceRoot(message.workspaceRoot);
    await this.setOperationMode(message.mode);
    // Use loadConfig() + setupComplete (local file read) instead of isAvailable() (network request)
    // to avoid blocking UI rendering with HTTP roundtrips on every mode switch
    const clickupConfig = workspaceRoot ? await this._getClickUpService(workspaceRoot).loadConfig() : null;
    const linearConfig = workspaceRoot ? await this._getLinearService(workspaceRoot).loadConfig() : null;
    const needsSetup = !clickupConfig?.setupComplete && !linearConfig?.setupComplete;
    this._panel?.webview.postMessage({ type: 'operationModeChanged', mode: message.mode, needsSetup });
    break;
}
```

### 4. Clarify Mode Boundaries — The Core Difference

**Coding Mode (Mirror Mode):**
- Switchboard and ClickUp/Linear stay in sync throughout the plan lifecycle
- Every column move updates the external task status
- Manual import supported
- User creates plans manually or imports specific tasks

**Board Management Mode (Source → Result Mode):**
- Switchboard treats ClickUp/Linear as the **source of truth** for work items
- Plans are auto-created from tagged external tasks (automation polling)
- **No sync during plan lifecycle** — the plan evolves independently in Switchboard
- Only when plan reaches `COMPLETED` does the **result write back** to the external task
- External system never sees intermediate states (plan reviewed, coded, etc.)

#### [MODIFY] `src/services/KanbanProvider.ts`

**Coding Mode**: Keep existing sync-on-move behavior.

**Board Management Mode**: Disable sync-on-move, enable automation polling.

**Context:** The mode guard must be the **first check** in each method, before any config loading or rules checking. This ensures `initializeIntegrationAutoPull()` (called on extension activation and workspace folder changes) respects the persisted mode immediately.

**Implementation — `_configureClickUpAutomation` (replaces existing at line ~850):**

```typescript
private async _configureClickUpAutomation(workspaceRoot: string): Promise<void> {
    // MODE GUARD — must be first check. In Coding Mode, stop automation polling and return.
    if (this._operationMode !== 'board-management') {
        this._integrationAutoPull.stop(workspaceRoot, 'clickup-automation');
        return;
    }

    const clickUp = this._getClickUpService(workspaceRoot);
    const config = await clickUp.loadConfig();
    const hasRules = config?.setupComplete && config.automationRules.some((rule) => rule.enabled !== false);
    if (!hasRules) {
        this._integrationAutoPull.stop(workspaceRoot, 'clickup-automation');
        return;
    }

    const automation = this._getClickUpAutomationService(workspaceRoot);
    this._integrationAutoPull.configure(
        workspaceRoot,
        'clickup-automation',
        true,
        config.pullIntervalMinutes,
        async () => {
            const latestConfig = await clickUp.loadConfig();
            if (!latestConfig?.setupComplete || !latestConfig.automationRules.some((rule) => rule.enabled !== false)) {
                return;
            }

            const pollResult = await automation.poll();
            if (pollResult.errors.length > 0) {
                console.warn('[KanbanProvider] ClickUp automation polling errors:', pollResult.errors);
            }
            await this._postClickUpState(workspaceRoot, pollResult.errors.length > 0);
            if (pollResult.errors.length > 0) {
                throw new Error(pollResult.errors.join('; '));
            }
        }
    );
}
```

**Implementation — `_configureLinearAutomation` (replaces existing at line ~912):**

```typescript
private async _configureLinearAutomation(workspaceRoot: string): Promise<void> {
    // MODE GUARD — must be first check. In Coding Mode, stop automation polling and return.
    if (this._operationMode !== 'board-management') {
        this._integrationAutoPull.stop(workspaceRoot, 'linear-automation');
        return;
    }

    const linear = this._getLinearService(workspaceRoot);
    const config = await linear.loadConfig();
    const hasRules = config?.setupComplete && config.automationRules.some((rule) => rule.enabled !== false);
    if (!hasRules) {
        this._integrationAutoPull.stop(workspaceRoot, 'linear-automation');
        return;
    }

    const automation = this._getLinearAutomationService(workspaceRoot);
    this._integrationAutoPull.configure(
        workspaceRoot,
        'linear-automation',
        true,
        config.pullIntervalMinutes,
        async () => {
            const latestConfig = await linear.loadConfig();
            if (!latestConfig?.setupComplete || !latestConfig.automationRules.some((rule) => rule.enabled !== false)) {
                return;
            }

            const pollResult = await automation.poll();
            if (pollResult.errors.length > 0) {
                console.warn('[KanbanProvider] Linear automation polling errors:', pollResult.errors);
            }
            await this._postLinearState(workspaceRoot, pollResult.errors.length > 0);
            if (pollResult.errors.length > 0) {
                throw new Error(pollResult.errors.join('; '));
            }
        }
    );
}
```

**Implementation — `_queueClickUpSync` (replaces existing at line ~950):**

```typescript
private _queueClickUpSync(
    workspaceRoot: string,
    plan: import('./KanbanDatabase').KanbanPlanRecord,
    targetColumn: string
): void {
    // In Board Management Mode, don't sync intermediate column moves.
    // Only the automation service writes back at completion.
    if (this._operationMode === 'board-management') {
        return;
    }

    const clickUp = this._getClickUpService(workspaceRoot);
    clickUp.debouncedSync(plan.sessionId, {
        planId: plan.planId,
        sessionId: plan.sessionId,
        topic: plan.topic,
        planFile: plan.planFile,
        kanbanColumn: targetColumn,
        status: plan.status,
        complexity: plan.complexity,
        tags: plan.tags,
        dependencies: plan.dependencies,
        createdAt: plan.createdAt,
        updatedAt: plan.updatedAt,
        lastAction: plan.lastAction,
        clickupTaskId: plan.clickupTaskId
    }, (result) => this._handleClickUpSyncResult(workspaceRoot, result));
}
```

**Note:** Manual import (auto-pull) still works in both modes — the mode guard only affects `clickup-automation` and `linear-automation` integration keys. The `clickup` and `linear` auto-pull keys are not gated by mode.

### 4b. Add Linear Sync Guard — `_queueLinearSync` Helper

#### [CREATE] New method in `src/services/KanbanProvider.ts`

**Context:** Linear sync is currently performed **inline** in `moveCardBackwards` (lines 2562-2591) and `moveCardForward` (lines 2630-2659) via raw `linear.debouncedSync()` calls. Unlike ClickUp which has a centralized `_queueClickUpSync` helper, Linear has no single entry point. This creates an asymmetry: the ClickUp mode guard works, but Linear would continue syncing intermediate column moves in Board Management Mode.

**Logic:** Create a `_queueLinearSync` helper (mirroring `_queueClickUpSync`) that:
1. Checks `_operationMode` — returns immediately if `'board-management'`
2. Performs the same `linear.debouncedSync()` call that currently exists inline

**Implementation — Add new method after `_queueClickUpSync` (after line ~971):**

```typescript
private _queueLinearSync(
    workspaceRoot: string,
    plan: import('./KanbanDatabase').KanbanPlanRecord,
    targetColumn: string
): void {
    // In Board Management Mode, don't sync intermediate column moves.
    // Only the automation service writes back at completion.
    if (this._operationMode === 'board-management') {
        return;
    }

    const linear = this._getLinearService(workspaceRoot);
    linear.debouncedSync(plan.sessionId, {
        planId: plan.planId,
        sessionId: plan.sessionId,
        topic: plan.topic,
        planFile: plan.planFile,
        kanbanColumn: targetColumn,
        status: plan.status,
        complexity: plan.complexity,
        tags: plan.tags,
        dependencies: plan.dependencies,
        createdAt: plan.createdAt,
        updatedAt: plan.updatedAt,
        lastAction: plan.lastAction
    }, targetColumn);
}
```

**Replace inline Linear sync in `moveCardBackwards` (lines ~2562-2591):**

Replace the inline `linear.debouncedSync(sid, {...}, targetColumn)` block in the `moveCardBackwards` handler with:

```typescript
// Linear sync hook — fire-and-forget, never blocks kanban moves
try {
    const linear = this._getLinearService(workspaceRoot);
    const linearConfig = await linear.loadConfig();
    if (linearConfig?.setupComplete) {
        const syncDb = this._getKanbanDb(workspaceRoot);
        for (const sid of sessionIds) {
            const plan = await syncDb.getPlanBySessionId(sid);
            if (plan) {
                this._queueLinearSync(workspaceRoot, plan, targetColumn);
            }
        }
        if (linear.consecutiveFailures >= 3) {
            await this._postLinearState(workspaceRoot, true);
        }
    }
} catch { /* Linear sync failure must never block kanban operations */ }
```

**Replace inline Linear sync in `moveCardForward` (lines ~2630-2659) with identical pattern.**

**Edge Cases Handled:**
- Board Management Mode suppresses intermediate sync for both ClickUp AND Linear (symmetry)
- `consecutiveFailures` check still runs even in Board Management Mode path (the `_queueLinearSync` returns early, so `debouncedSync` is never called, but the failure counter check is outside the helper — this is safe because no sync = no failures)

### 4c. Broadcast Mode State on Board Refresh

#### [MODIFY] `src/services/KanbanProvider.ts`

**Context:** `_refreshBoardWithData()` (line ~1257) sends all UI state to the webview on every refresh. The operation mode state must be included so the Kanban header toggle button renders correctly after page loads, workspace switches, and VS Code reloads.

**Logic:** After the existing `_postIntegrationStates(wsRoot)` call (line ~1372), broadcast the mode state.

**Implementation — Add after line ~1372 in `_refreshBoardWithData()`:**

```typescript
const wsRoot = this._currentWorkspaceRoot;
if (wsRoot) {
    void this._postIntegrationStates(wsRoot);

    // Broadcast operation mode state to webview for toggle button rendering
    const clickupConfig = await this._getClickUpService(wsRoot).loadConfig();
    const linearConfig = await this._getLinearService(wsRoot).loadConfig();
    const needsSetup = !clickupConfig?.setupComplete && !linearConfig?.setupComplete;
    this._panel?.webview.postMessage({
        type: 'operationModeChanged',
        mode: this._operationMode,
        needsSetup
    });
}
```

**Edge Cases Handled:**
- Uses `loadConfig()` + `setupComplete` (local file read) instead of `isAvailable()` (network request) per Grumpy critique #4
- Runs on every refresh, ensuring mode toggle button is always in correct state after page load

### 5. Integrate Mode Toggle into Project Management Panel

#### [MODIFY] `src/webview/setup.html`

The Project Management accordion becomes the **control center** for Board Management Mode. It shows current mode status, allows switching, and conditionally displays automation configuration. Core integration features (sync, manual import, mappings) work in both modes.

**Replace the existing Project Management accordion header (lines 708-716) with:**

```html
<div class="startup-section">
    <div class="startup-toggle" id="project-mgmt-toggle">
        <div class="section-label">ClickUp, Linear and Notion Integration</div>
        <span id="project-mgmt-mode-badge" style="margin-left:8px; padding:2px 8px; border-radius:3px; font-size:9px; font-family:var(--font-mono);">💻 CODING</span>
        <span class="chevron" id="project-mgmt-chevron">▶</span>
    </div>
    <div class="startup-fields" id="project-mgmt-fields" data-accordion="true">
        
        <!-- Mode Control Section -->
        <div class="db-subsection" style="background:var(--panel-bg2); padding:12px; border-radius:4px; border:1px solid var(--border-dim);">
            <div style="font-size: 10px; color: var(--text-secondary); margin-bottom:10px; font-family: var(--font-mono); letter-spacing: 1px;">
                OPERATION MODE
            </div>
            
            <div id="mode-control-active" style="display:none;">
                <div style="display:flex; gap:8px; margin-bottom:10px;">
                    <button id="btn-setup-coding-mode" class="secondary-btn" style="flex:1; font-size:11px;">
                        💻 CODING MODE
                    </button>
                    <button id="btn-setup-board-mgmt-mode" class="secondary-btn" style="flex:1; font-size:11px;">
                        📋 BOARD MGMT MODE
                    </button>
                </div>
                <div id="setup-coding-desc" style="font-size:10px; color:var(--accent-green); line-height:1.5; display:none;">
                    ✓ Mirror Mode: Every column move syncs to ClickUp/Linear<br>
                    ✓ Manual import: ENABLED<br>
                    ✓ Plan status reflected in external system throughout lifecycle
                </div>
                <div id="setup-board-mgmt-desc" style="font-size:10px; color:var(--accent-teal); line-height:1.5; display:none;">
                    ✓ Source → Result Mode: Auto-create plans from ClickUp/Linear tasks<br>
                    ✓ No intermediate sync — plan evolves independently<br>
                    ✓ Result written back only when plan reaches COMPLETED
                </div>
            </div>
            
            <div id="mode-control-needs-setup" style="display:none;">
                <div style="font-size:10px; color:var(--accent-orange); line-height:1.5; margin-bottom:8px;">
                    ⚠️ Configure ClickUp or Linear below to enable Board Management Mode.
                </div>
                <div style="font-size:10px; color:var(--text-secondary); line-height:1.5;">
                    In Coding Mode, you manually create and manage plans. Board Management Mode adds automatic plan creation from external tasks.
                </div>
            </div>
        </div>

        <!-- ClickUp Section -->
        <div class="db-subsection">
            <div class="subsection-header">
                <span>ClickUp</span>
                <span id="clickup-setup-status" style="margin-left:auto; font-size:9px; color:var(--text-secondary);">Not configured</span>
            </div>
            <div style="font-size: 10px; color: var(--text-secondary); margin-bottom: 8px; line-height: 1.4;">
                Sync plans to ClickUp tasks and import tasks from ClickUp.
            </div>
            <label class="startup-row" style="display:block; margin-top:6px;">
                <span style="display:block; margin-bottom:4px;">API Token</span>
                <input id="clickup-token-input" type="password" placeholder="Enter ClickUp API token" style="width:100%;">
            </label>
            <button id="btn-setup-clickup" class="action-btn w-full" style="margin-top: 8px;">SETUP CLICKUP</button>
            <div id="clickup-setup-error" style="min-height:16px; color: var(--accent-red); font-size: 10px; margin-top: 6px;"></div>
            <div id="clickup-mapping-summary" style="display:none; margin-top:10px; font-size:10px; color:var(--text-secondary); line-height:1.5;"></div>
            <div id="clickup-mappings-section" class="hidden" style="margin-top:10px; border-top:1px solid var(--border); padding-top:10px;">
                <!-- ... existing mapping UI ... -->
            </div>
            
            <!-- Automation section - hidden when in Coding Mode -->
            <div id="clickup-automation-section" class="hidden" style="margin-top:10px; border-top:1px solid var(--border); padding-top:10px;">
                <div class="subsection-header" style="margin-bottom:6px;">
                    <span>ClickUp Automation Rules</span>
                    <span class="automation-active-badge" style="margin-left:auto; font-size:9px; color:var(--accent-teal); display:none;">📋 ACTIVE</span>
                </div>
                <div style="font-size:10px; color:var(--text-secondary); line-height:1.5; margin-bottom:8px;">
                    Create a normal Switchboard plan when a ClickUp task matches a tag, then write the result back when that plan reaches the configured final column. Only applies in Board Management Mode.
                </div>
                <div class="flex gap-2" style="margin-bottom:8px;">
                    <button id="btn-clickup-add-rule" class="secondary-btn w-full">ADD RULE</button>
                    <button id="btn-clickup-save-automation" class="action-btn w-full">SAVE AUTOMATION</button>
                </div>
                <div id="clickup-automation-rules-list" style="display:flex; flex-direction:column; gap:8px;"></div>
            </div>
        </div>

        <!-- Linear Section -->
        <div class="db-subsection">
            <div class="subsection-header">
                <span>Linear</span>
                <span id="linear-setup-status" style="margin-left:auto; font-size:9px; color:var(--text-secondary);">Not configured</span>
            </div>
            <!-- ... similar structure to ClickUp with mode-conditional automation section ... -->
            <div id="linear-automation-section" class="hidden" style="margin-top:10px; border-top:1px solid var(--border); padding-top:10px;">
                <div class="subsection-header" style="margin-bottom:6px;">
                    <span>Linear Automation Rules</span>
                    <span class="automation-active-badge" style="margin-left:auto; font-size:9px; color:var(--accent-teal); display:none;">📋 ACTIVE</span>
                </div>
                <!-- ... existing automation UI ... -->
            </div>
        </div>

        <!-- Notion Section -->
        <div class="db-subsection">
            <!-- ... existing Notion UI (not mode-dependent) ... -->
        </div>
    </div>
</div>
```

**Add handlers for the integrated mode control:**

```javascript
// Mode toggle buttons in setup panel
document.getElementById('btn-setup-coding-mode')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'switchOperationMode', mode: 'coding' });
});

document.getElementById('btn-setup-board-mgmt-mode')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'switchOperationMode', mode: 'board-management' });
});

// Enhanced operationModeChanged handler
case 'operationModeChanged': {
    // Update accordion header badge
    const badge = document.getElementById('project-mgmt-mode-badge');
    if (badge) {
        if (message.needsSetup) {
            badge.textContent = '⚙️ SETUP';
            badge.style.background = 'color-mix(in srgb, var(--accent-orange) 20%, transparent)';
            badge.style.color = 'var(--accent-orange)';
        } else if (message.mode === 'coding') {
            badge.textContent = '💻 CODING';
            badge.style.background = 'color-mix(in srgb, var(--accent-green) 20%, transparent)';
            badge.style.color = 'var(--accent-green)';
        } else {
            badge.textContent = '📋 BOARD MGMT';
            badge.style.background = 'color-mix(in srgb, var(--accent-teal) 20%, transparent)';
            badge.style.color = 'var(--accent-teal)';
        }
    }
    
    // Show/hide mode control sections
    const controlActive = document.getElementById('mode-control-active');
    const controlNeedsSetup = document.getElementById('mode-control-needs-setup');
    const codingBtn = document.getElementById('btn-setup-coding-mode');
    const boardMgmtBtn = document.getElementById('btn-setup-board-mgmt-mode');
    const codingDesc = document.getElementById('setup-coding-desc');
    const boardMgmtDesc = document.getElementById('setup-board-mgmt-desc');
    
    if (message.needsSetup) {
        controlActive.style.display = 'none';
        controlNeedsSetup.style.display = 'block';
    } else {
        controlActive.style.display = 'block';
        controlNeedsSetup.style.display = 'none';
        
        // Update button states
        if (message.mode === 'coding') {
            codingBtn.classList.add('action-btn');
            codingBtn.classList.remove('secondary-btn');
            boardMgmtBtn.classList.add('secondary-btn');
            boardMgmtBtn.classList.remove('action-btn');
            codingDesc.style.display = 'block';
            boardMgmtDesc.style.display = 'none';
        } else {
            codingBtn.classList.add('secondary-btn');
            codingBtn.classList.remove('action-btn');
            boardMgmtBtn.classList.add('action-btn');
            boardMgmtBtn.classList.remove('secondary-btn');
            codingDesc.style.display = 'none';
            boardMgmtDesc.style.display = 'block';
        }
    }
    
    // Show/hide automation sections based on mode
    const clickupAutoSection = document.getElementById('clickup-automation-section');
    const linearAutoSection = document.getElementById('linear-automation-section');
    const autoBadges = document.querySelectorAll('.automation-active-badge');
    
    if (!message.needsSetup && message.mode === 'board-management') {
        // In Board Management Mode: show automation sections if configured
        if (clickupAutoSection && clickupAutoSection.dataset.configured === 'true') {
            clickupAutoSection.classList.remove('hidden');
        }
        if (linearAutoSection && linearAutoSection.dataset.configured === 'true') {
            linearAutoSection.classList.remove('hidden');
        }
        autoBadges.forEach(b => b.style.display = 'inline');
    } else {
        // In Coding Mode or needs setup: hide automation sections
        clickupAutoSection?.classList.add('hidden');
        linearAutoSection?.classList.add('hidden');
        autoBadges.forEach(b => b.style.display = 'none');
    }
    break;
}
```

**Key behaviors:**
1. **Accordion header badge** shows current mode at a glance (💻 CODING / 📋 BOARD MGMT / ⚙️ SETUP)
2. **Mode control section** at the top of the accordion allows switching modes
3. **Automation rule sections** only visible in Board Management Mode (and only when that integration is configured)
4. **"ACTIVE" badges** appear on automation sections when Board Management Mode is running
5. **Setup prompt** appears when no integrations configured, guiding users to set up ClickUp/Linear first

### 6. Wire Up Setup Panel Message Handler

#### [MODIFY] `src/services/SetupPanelProvider.ts`

**Context:** `SetupPanelProvider` routes ALL actions through `TaskViewerProvider` — it does not hold a direct reference to `KanbanProvider`. The mode switch must follow the same pattern used by `handleSetupClickUp()`, `handleSetupLinear()`, etc. (see lines 91-131 in `SetupPanelProvider.ts`).

**Logic:** Add a `switchOperationMode` case to `SetupPanelProvider._handleMessage()` that delegates to a new `TaskViewerProvider.handleSwitchOperationMode()` method.

**Implementation — Add case to `_handleMessage()` switch (before the `default` case at line ~261):**

```typescript
case 'switchOperationMode': {
    const result = await this._taskViewerProvider.handleSwitchOperationMode(message.mode);
    this._panel.webview.postMessage({ type: 'operationModeChanged', ...result });
    await vscode.commands.executeCommand('switchboard.refreshUI');
    break;
}
```

#### [MODIFY] `src/services/TaskViewerProvider.ts`

**Context:** `TaskViewerProvider` holds the `_kanbanProvider` reference (set at line 860 via `setKanbanProvider()`). It already acts as the delegation layer between `SetupPanelProvider` and `KanbanProvider`.

**Logic:** Add `handleSwitchOperationMode()` that delegates to `KanbanProvider.setOperationMode()` and returns the mode state for the setup panel to render.

**Implementation — Add new method near the other `handle*` methods:**

```typescript
public async handleSwitchOperationMode(mode: 'coding' | 'board-management'): Promise<{
    mode: 'coding' | 'board-management';
    needsSetup: boolean;
}> {
    if (this._kanbanProvider) {
        await this._kanbanProvider.setOperationMode(mode);
    }

    // Determine needsSetup using local config check (no network requests)
    const workspaceRoot = this._getWorkspaceRoot();
    let needsSetup = true;
    if (workspaceRoot && this._kanbanProvider) {
        try {
            const clickupConfig = await this._kanbanProvider.getClickUpConfig(workspaceRoot);
            const linearConfig = await this._kanbanProvider.getLinearConfig(workspaceRoot);
            needsSetup = !clickupConfig?.setupComplete && !linearConfig?.setupComplete;
        } catch { /* non-critical */ }
    }

    return { mode, needsSetup };
}
```

**Clarification:** The `getClickUpConfig()` and `getLinearConfig()` helper methods are thin wrappers that call `this._getClickUpService(workspaceRoot).loadConfig()` and `this._getLinearService(workspaceRoot).loadConfig()` respectively. If these don't already exist as public methods on `KanbanProvider`, add them:

```typescript
// Add to KanbanProvider class
public async getClickUpConfig(workspaceRoot: string) {
    return this._getClickUpService(workspaceRoot).loadConfig();
}

public async getLinearConfig(workspaceRoot: string) {
    return this._getLinearService(workspaceRoot).loadConfig();
}
```

## Verification Plan

### Manual Testing
1. **Fresh workspace (no integrations)**: Open workspace with no ClickUp/Linear configured. Verify mode toggle shows "⚙️ SETUP INTEGRATIONS" and clicking opens setup panel to Project Management section.
2. **Default mode**: Open workspace with ClickUp automation configured. Verify default mode is Coding Mode (green indicator, no automation polling visible in Output channel).
3. **Switch to Board Management Mode**: Click mode toggle → verify teal indicator, `[IntegrationAutoPull]` log entries showing scheduled automation runs.
4. **Switch back to Coding Mode**: Click toggle again → verify green indicator, `[IntegrationAutoPull]` log entries stop.
5. **Persistence**: Reload VS Code window (`Developer: Reload Window`) → verify mode persists (check toggle indicator matches pre-reload state).
6. **ClickUp sync suppression**: In Board Management Mode, drag a card to a new column → verify NO ClickUp sync activity in Output channel (no `[ClickUpSync]` log entries). Switch to Coding Mode, repeat → verify sync DOES fire.
7. **Linear sync suppression**: Same as #6 but for Linear sync entries.
8. **Setup panel alternative**: Open setup panel → Project Management → use mode toggle buttons → verify same behavior as Kanban header toggle.
9. **Rapid toggle**: Quickly switch Coding → Board Mgmt → Coding → Board Mgmt → verify no errors in Output channel and final state is correct.
10. **Auto-pull not affected**: In Coding Mode with ClickUp auto-pull enabled, verify auto-pull still runs (imports tasks). Only automation polling should be gated.

### Automated Tests

#### New test file: `src/test/operation-mode-toggle.test.ts`

- **`setOperationMode` state transitions**: Verify `getOperationMode()` returns the correct mode after `setOperationMode('board-management')` and `setOperationMode('coding')`. Verify no-op when setting same mode.
- **`_configureClickUpAutomation` mode guard**: Mock `IntegrationAutoPullService`. Call `_configureClickUpAutomation()` in Coding Mode → verify `.stop()` called. Call in Board Management Mode with valid config → verify `.configure()` called.
- **`_configureLinearAutomation` mode guard**: Same as above for Linear.
- **`_queueClickUpSync` mode guard**: Call with `_operationMode = 'board-management'` → verify `debouncedSync` NOT called. Call with `_operationMode = 'coding'` → verify `debouncedSync` IS called.
- **`_queueLinearSync` mode guard**: Same as above for Linear.
- **`initializeIntegrationAutoPull` respects mode**: Set mode to Coding → call `initializeIntegrationAutoPull()` → verify automation `.stop()` called for both clickup-automation and linear-automation, but auto-pull `.configure()` still called for clickup and linear.
- **Webview message handler**: Send `{ type: 'switchOperationMode', mode: 'board-management' }` → verify `setOperationMode()` called and `operationModeChanged` message posted back to webview.

## Documentation Updates

### README.md
Add section explaining the two operation modes:

```markdown
## Operation Modes

Switchboard supports two operation modes per workspace:

### Coding Mode (Default)
Normal Switchboard usage. You create plans, dispatch them to agents, and write code. 
External automation polling is paused to avoid interference with your work.

### Board Management Mode
For project managers and automation workflows. Switchboard monitors ClickUp/Linear for 
tagged tasks, automatically creates plans, advances them through columns via timer-based 
automation (existing Automation sidebar controls), and writes results back to the external 
system when complete. No continuous sync during plan lifecycle — the plan evolves 
independently in Switchboard.

**Example workflow (two options):**

**Option A: Completion-triggered write-back**
1. PM creates bug report in ClickUp with tag `switchboard:auto`
2. Switchboard detects it → auto-creates plan in `INVESTIGATION` column
3. `INVESTIGATION` column triggers terminal agent (e.g., Opus) to investigate
4. After 15 minutes (Automation timer), plan auto-advances to `COMPLETED`
5. Investigation result (plan markdown) written back to ClickUp task

**Option B: Continuous file sync (simpler) — ⚠️ FUTURE SCOPE: Not part of this plan. Retained as design notes for a separate plan.**
1. PM creates bug report in ClickUp with tag `switchboard:auto`
2. Switchboard detects it → auto-creates plan in `INVESTIGATION` column
3. `INVESTIGATION` column triggers terminal agent (e.g., Opus) to investigate
4. Switchboard watches the plan markdown file for changes
5. Every 30 seconds (or on file save), latest content synced to ClickUp task description
6. Plan stays in `INVESTIGATION` — no column movement required

**Option B Implementation:**

**File Watching & Sync:**
- Add file watcher in `ClickUpAutomationService` for automation-created plans
- Debounced sync (e.g., 30s cooldown) to avoid excessive API calls
- Toggle in automation settings: "Continuous sync to ClickUp"

**Preventing Overwrite (Section-Based Append):**
```typescript
// In ClickUpAutomationService._syncPlanToClickUp()
const existingDescription = await this._clickUpService.getTaskDescription(taskId);
const separator = '\n\n--- 🤖 Switchboard Output ---\n\n';

// Only keep content above the separator (original ticket content)
const baseContent = existingDescription.split(separator)[0].trim();

// Append plan content below separator
const newDescription = baseContent + separator + planContent;

await this._clickUpService.updateTaskDescription(taskId, newDescription);
```

**Termination Conditions (stop syncing):**
1. **Explicit marker detected**: Plan contains `<!-- SYNC_COMPLETE -->` or `## Investigation Complete`
2. **Timeout**: Max 30 minutes of continuous sync per plan
3. **User action**: Manual "Stop Sync" button in Kanban card
4. **Plan archived**: Plan moved to `COMPLETED` or `ARCHIVED` column
5. **Agent terminal closed**: Detected via terminal lifecycle events

**Cleanup on Stop:**
```typescript
private _stopPlanSync(sessionId: string): void {
    const watcher = this._planFileWatchers.get(sessionId);
    if (watcher) {
        watcher.close();
        this._planFileWatchers.delete(sessionId);
        
        // Final sync with completion marker
        const plan = await this._getPlanContent(sessionId);
        const finalContent = plan + '\n\n<!-- Sync stopped: ' + new Date().toISOString() + ' -->';
        await this._syncToClickUp(sessionId, finalContent);
    }
}
```

**UI Indicator:**
- Kanban card shows `↻ Syncing to ClickUp` spinner while active sync
- Hover shows last sync time and stop button

**Agent Prompt Integration:**

Agents need explicit instructions to write output to the plan file and signal completion:

```markdown
## ClickUp Continuous Sync Mode

You are investigating a bug report that will be continuously synced to ClickUp. 

**Your output MUST go to the plan file**: `/Users/patrickvuleta/Documents/GitHub/switchboard/.switchboard/plans/bug_investigation_123.md`

**Structure your response:**
1. Investigation summary at top
2. Detailed findings with code references
3. Recommended fixes
4. End with marker: `<!-- SYNC_COMPLETE -->`

**Important:**
- The PM sees your output in real-time in ClickUp
- Write clearly — they read it as you type
- The sync stops automatically when you add `<!-- SYNC_COMPLETE -->`
- Do NOT include this marker until you're truly finished
```

**Implementation:** Add to `agentPromptBuilder.ts` when building prompts for Board Management Mode automation plans:

```typescript
const clickupSyncBlock = isBoardManagementAutomationPlan ? `
## ClickUp Continuous Sync
Your output is being synced to the linked ClickUp task in real-time. Write the plan file directly. Include <!-- SYNC_COMPLETE --> when finished.
` : '';
```

## Reviewer-Executor Update

### Fixed Items

- Fixed the setup panel hydration gap: `TaskViewerProvider.postSetupPanelState()` now pushes `operationModeChanged` after integration state payloads so persisted mode/needs-setup state renders correctly on open and refresh.
- Fixed the Project Management automation sections so they truly follow the active operation mode. `setup.html` now tracks current mode state, marks integrations as configured via `data-configured`, and only shows ClickUp/Linear automation rules in Board Management Mode.
- Added a focused regression test for the setup-panel operation-mode wiring.
- Fixed the `ContinuousSyncService` file-watcher subscription typing bug so `npm run compile-tests` succeeds instead of failing on the new `onPlanFileChange` subscription.

### Files Changed

- `src/services/TaskViewerProvider.ts`
- `src/webview/setup.html`
- `src/test/operation-mode-toggle-regression.test.js`
- `src/services/ContinuousSyncService.ts`

### Validation Results

- ✅ `npm run compile-tests`
- ✅ `npm run compile`
- ⚠️ `npm run lint` — fails at repo baseline because ESLint 9 cannot find an `eslint.config.(js|mjs|cjs)` file
- ✅ `node src/test/setup-panel-migration.test.js`
- ✅ `node src/test/operation-mode-toggle-regression.test.js`

### Remaining Risks

- The repo still contains in-progress Live Sync / `ContinuousSyncService` work that the plan explicitly labels as future scope. I only fixed the compile-blocking subscription type issue and did not attempt a broader scope rollback in this pass.
- The lint script is currently not runnable until the repository's ESLint configuration is migrated or restored for ESLint v9.
```
