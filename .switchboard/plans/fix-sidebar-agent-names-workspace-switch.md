# Fix: Lock Agent Names to Terminals (Kanban & Sidebar)

## Goal

Fix both the kanban board and sidebar implementation.html to display agent names derived from actual running terminals instead of workspace configuration, so that switching workspaces does not cause the displayed agent names to change while terminals remain running.

## Metadata

- **Tags:** [bugfix, frontend, backend]
- **Complexity:** 4

## User Review Required

> [!IMPORTANT]
> **Step 1 — Removing `clearRegisteredTerminalsMap()`**: The call at KanbanProvider.ts line 4267 exists to prevent stale dispatch-map entries from routing commands to terminals that belonged to the previous workspace. Removing it means terminals from workspace A could theoretically receive commands dispatched in workspace B (if workspace-agnostic dispatch logic is ever used). **Step 2's fix makes Step 1 unnecessary for agent-name correctness alone**, but the dispatch-safety tradeoff must be confirmed before removing.
>
> Current recommendation: **Keep the `clearRegisteredTerminalsMap()` call intact** and rely solely on Step 2 to fix agent name display. Only remove Step 1 if the team confirms that dispatch map re-population (on re-registration) makes this safe.

## Complexity Audit

### Routine
- Replacing `_registeredTerminals` iteration with `vscode.window.terminals` in `getActualTerminalAgentNames()` — a mechanical swap within one method
- Adding `_notifyTerminalAgentNamesChanged()` private helper — trivial, calls existing `postMessage`
- Adding a `case 'terminalAgentNames':` to the `implementation.html` message switch — straightforward extension
- Adding `lastTerminalAgentNames` variable declaration alongside existing `lastStartupCommands`

### Complex / Risky
- Coordinating message flow across backend (TaskViewerProvider) and frontend (implementation.html) with two separate trigger points (workspace switch + terminal state change) — ordering and debounce risk
- The call to `renderAgentList()` inside the new `terminalAgentNames` handler must be added or names will not visually update between `terminalStatuses` messages
- Ghost dispatch risk if `clearRegisteredTerminalsMap()` is removed — dispatch map persists and could route to wrong-workspace terminals

## Edge-Case & Dependency Audit

### Race Conditions
- **Workspace switch + terminal creation overlap**: If `_postSidebarConfigurationState` fires while a new terminal is halfway through `setTerminalAgentInfo`, the sidebar receives an intermediate (incomplete) snapshot. Mitigated by the sidebar's fallback to `lastStartupCommands`.
- **`terminalAgentNames` arrives before `startupCommands`**: On initial load, `_postSidebarConfigurationState` sends `startupCommands` then `terminalAgentNames` sequentially. If they arrive in order, terminal names take priority correctly. If delivery reorders (unlikely in VS Code IPC), workspace-derived names temporarily show. Acceptable.

### Security
- No new attack surface: message payloads are terminal names already visible in the VS Code terminal panel.

### Side Effects
- `_notifyTerminalAgentNamesChanged()` fires on every `setTerminalAgentInfo` and `clearTerminalAgentInfo` call. During `createAgentGrid`, this may fire once per agent (up to ~8 times). Each call re-derives the full map via `vscode.window.terminals`. Performance is acceptable; `vscode.window.terminals` is a synchronous in-process list.
- `clearAllTerminalAgentInfo()` (called on `deactivate()`) does not call `_notifyTerminalAgentNamesChanged()` — the view is being torn down, so no notification is needed.

### Dependencies & Conflicts
- `getActualTerminalAgentNames()` is only called by KanbanProvider (for column header badges). The new implementation using `vscode.window.terminals` must match the same role→displayName semantics or kanban column headers may change unexpectedly.
- `clearTerminalAgentInfo(name)` at TaskViewerProvider.ts:14006 is called after the terminal closure cleanup path. The new notification fires synchronously — the sidebar may briefly show empty names until the next `terminalStatuses` push. Acceptable.

## Dependencies

- None (self-contained bugfix; no cross-session dependencies)

## Adversarial Synthesis

Key risks: (1) removing `clearRegisteredTerminalsMap()` may allow stale dispatch-map entries to route commands to wrong-workspace terminals; (2) forgetting `renderAgentList()` in the new `terminalAgentNames` case means the sidebar never visually updates between `terminalStatuses` pushes; (3) the `vscode.window.terminals` staleness window during rapid terminal create/close is negligible but must be acknowledged. Mitigations: keep the dispatch-map clear call (Step 1) as a non-issue by keeping it; always call `renderAgentList()` in the message handler; rely on the existing `terminalStatuses` push to converge any stale snapshot.

## Problem Description

The existing fix for `fix_agent_names_locked_to_terminals.md` added a terminal cache and modified `_getAgentNames()` to use it, but the fix is broken because `_registeredTerminals` is cleared on workspace switch. This causes `getActualTerminalAgentNames()` to return an empty map, making the terminal cache ineffective.

When switching workspaces via the kanban workspace picker:
1. KanbanProvider calls `clearRegisteredTerminalsMap()` on workspace switch (line 4267)
2. This calls `_registeredTerminals.clear()` in TaskViewerProvider — the map is emptied (not set to `undefined`)
3. `getActualTerminalAgentNames()` iterates over `_registeredTerminals.entries()` (line 470)
4. Since `_registeredTerminals` is empty, the `for...of` loop yields zero iterations and returns an empty map
5. The kanban board falls back to workspace configuration, showing wrong agent names
6. The sidebar also shows wrong agent names because it uses workspace-derived `lastStartupCommands`

> [!NOTE]
> **Clarification:** The guard `if (!this._registeredTerminals) return result;` (line 468) is a null-check for the `undefined` case (field is typed `Map | undefined`). `clearRegisteredTerminalsMap()` calls `.clear()` (empties the map but leaves it as a non-null `Map`), so the null-check never triggers. The real failure is zero loop iterations on an empty map.

**Example scenario:**
1. Start a lead coder terminal with gemini in workspace A
2. Switch to workspace B where lead coder is configured as claude
3. Both kanban and sidebar show "CLAUDE CLI" even though the terminal is still running gemini

## Root Cause Analysis

The `getActualTerminalAgentNames()` method in TaskViewerProvider requires `_registeredTerminals` to iterate over terminals and look up their cached agent info:

```typescript
// TaskViewerProvider.ts line 465-488
public getActualTerminalAgentNames(): Record<string, string> {
    const result: Record<string, string> = {};

    if (!this._registeredTerminals) return result;  // ← Only guards undefined, not empty Map

    for (const [name, terminal] of this._registeredTerminals.entries()) {
        // Skip exited terminals
        if (terminal.exitStatus !== undefined) {
            this._terminalAgentInfo.delete(name);
            continue;
        }

        const info = this._terminalAgentInfo.get(name);
        if (!info) continue;

        if (!(info.role in result)) {
            result[info.role] = info.displayName;
        }
    }

    return result;
}
```

However, KanbanProvider clears `_registeredTerminals` on workspace switch:

```typescript
// KanbanProvider.ts line 4266-4268
if (prevWorkspaceRoot !== this._currentWorkspaceRoot) {
    this._taskViewerProvider?.clearRegisteredTerminalsMap();
}
```

This is incorrect for agent-name purposes because:
- The terminals are still running and valid
- `_registeredTerminals` is a dispatch map, not workspace-specific state
- Clearing it breaks the ability to look up terminal agent info
- The `_terminalAgentInfo` cache is preserved but becomes inaccessible via the existing iteration

## Files Affected

- `src/services/KanbanProvider.ts` — (Optional) Remove or retain `clearRegisteredTerminalsMap()` call on workspace switch (see User Review Required)
- `src/services/TaskViewerProvider.ts` — Make `getActualTerminalAgentNames()` work without `_registeredTerminals`; add `_notifyTerminalAgentNamesChanged()`; emit `terminalAgentNames` in `_postSidebarConfigurationState`; hook notifications into `setTerminalAgentInfo` and `clearTerminalAgentInfo`
- `src/webview/implementation.html` — Add `lastTerminalAgentNames` variable; handle `terminalAgentNames` message; update agent name display to prefer terminal-derived names

## Proposed Changes

### `src/services/KanbanProvider.ts`

#### Around line 4266-4268 (inside `case 'selectWorkspace':`)

**Context:** The `clearRegisteredTerminalsMap()` call fires on every workspace switch. After Step 2's rewrite of `getActualTerminalAgentNames()`, this call no longer affects agent-name display. It may still be useful for dispatch safety (see User Review Required).

**Decision point:** If removing, delete the entire `if (prevWorkspaceRoot !== this._currentWorkspaceRoot)` block. If retaining, leave as-is — Step 2 makes this a no-op for correctness.

```typescript
// OPTION A — Remove (if dispatch safety confirmed safe):
// Delete lines 4266-4268 entirely

// OPTION B — Retain (recommended default):
// Leave unchanged; Step 2 makes it harmless for agent name display
if (prevWorkspaceRoot !== this._currentWorkspaceRoot) {
    this._taskViewerProvider?.clearRegisteredTerminalsMap();
}
```

---

### `src/services/TaskViewerProvider.ts`

#### Step 2: Rewrite `getActualTerminalAgentNames()` (lines 465-488)

Replace the existing implementation with one that iterates `_terminalAgentInfo` directly and validates liveness using `vscode.window.terminals`:

```typescript
// BEFORE (lines 465-488):
public getActualTerminalAgentNames(): Record<string, string> {
    const result: Record<string, string> = {};

    if (!this._registeredTerminals) return result;

    for (const [name, terminal] of this._registeredTerminals.entries()) {
        if (terminal.exitStatus !== undefined) {
            this._terminalAgentInfo.delete(name);
            continue;
        }
        const info = this._terminalAgentInfo.get(name);
        if (!info) continue;
        if (!(info.role in result)) {
            result[info.role] = info.displayName;
        }
    }

    return result;
}

// AFTER:
public getActualTerminalAgentNames(): Record<string, string> {
    const result: Record<string, string> = {};

    // Get all currently open VS Code terminals
    const allTerminals = vscode.window.terminals;
    const terminalNames = new Set(allTerminals.map(t => t.name));

    // Iterate over cached agent info and check if terminal is still open
    for (const [name, info] of this._terminalAgentInfo.entries()) {
        // Skip if terminal is no longer open; prune stale cache entry
        if (!terminalNames.has(name)) {
            this._terminalAgentInfo.delete(name);
            continue;
        }

        // First alive terminal per role wins (deterministic: Map insertion order)
        if (!(info.role in result)) {
            result[info.role] = info.displayName;
        }
    }

    return result;
}
```

**Edge Cases:**
- `vscode.window.terminals` may contain terminals that have exited but have not yet fired `onDidCloseTerminal`. These will have `exitStatus !== undefined`. The terminal name will still be in the set. To guard against this, optionally filter by `t.exitStatus === undefined` — but the existing `clearTerminalAgentInfo` call path already handles cleanup on close, so this is low-risk.
- Map mutation during iteration (`this._terminalAgentInfo.delete(name)`) is safe in JavaScript Maps (V8 and SpiderMonkey specs guarantee it).

#### Step 3 & 5: Add `_notifyTerminalAgentNamesChanged()` and hook into `setTerminalAgentInfo`/`clearTerminalAgentInfo`

Insert after the existing `clearAllTerminalAgentInfo()` method (around line 442):

```typescript
// Add private helper (insert after clearAllTerminalAgentInfo at line 444):
private _notifyTerminalAgentNamesChanged(): void {
    if (this._view) {
        const terminalAgentNames = this.getActualTerminalAgentNames();
        this._view.webview.postMessage({ type: 'terminalAgentNames', agentNames: terminalAgentNames });
    }
}
```

Modify `setTerminalAgentInfo` (line 434-436) to notify after setting:

```typescript
// BEFORE:
public setTerminalAgentInfo(suffixedName: string, role: string, displayName: string): void {
    this._terminalAgentInfo.set(suffixedName, { role, displayName });
}

// AFTER:
public setTerminalAgentInfo(suffixedName: string, role: string, displayName: string): void {
    this._terminalAgentInfo.set(suffixedName, { role, displayName });
    // Notify sidebar immediately so it doesn't wait for next terminalStatuses push
    this._notifyTerminalAgentNamesChanged();
}
```

Modify `clearTerminalAgentInfo` (line 438-440) to notify after clearing:

```typescript
// BEFORE:
public clearTerminalAgentInfo(suffixedName: string): void {
    this._terminalAgentInfo.delete(suffixedName);
}

// AFTER:
public clearTerminalAgentInfo(suffixedName: string): void {
    this._terminalAgentInfo.delete(suffixedName);
    // Notify sidebar so it updates immediately on terminal close
    this._notifyTerminalAgentNamesChanged();
}
```

> [!NOTE]
> `clearAllTerminalAgentInfo()` (called only from `deactivate()`) should NOT call `_notifyTerminalAgentNamesChanged()` — the view is being torn down and posting a message would be a no-op or error.

#### Step 3: Emit `terminalAgentNames` in `_postSidebarConfigurationState` (line 3340-3379)

Add immediately after the existing `startupCommands` post at line 3352:

```typescript
// EXISTING (line 3351-3352):
const startupState = await this.handleGetStartupCommands(workspaceRoot);
this._view.webview.postMessage({ type: 'startupCommands', ...startupState });

// ADD AFTER:
// Send terminal-derived agent names (workspace-agnostic, locked to actual running terminals)
const terminalAgentNames = this.getActualTerminalAgentNames();
this._view.webview.postMessage({ type: 'terminalAgentNames', agentNames: terminalAgentNames });
```

---

### `src/webview/implementation.html`

#### Step 4a: Declare `lastTerminalAgentNames` variable (near line 2291)

```javascript
// EXISTING (line 2291):
let lastStartupCommands = {};

// ADD IMMEDIATELY AFTER:
let lastTerminalAgentNames = {}; // Terminal-derived agent names; workspace-agnostic
```

#### Step 4b: Handle `terminalAgentNames` message (after line 3017, inside the message switch)

```javascript
// ADD after the 'startupCommands' case (after line 3017):
case 'terminalAgentNames':
    lastTerminalAgentNames = message.agentNames || {};
    renderAgentList(); // Re-render so terminal-derived names take effect immediately
    break;
```

> [!IMPORTANT]
> `renderAgentList()` MUST be called here. Without it, `lastTerminalAgentNames` is updated but the DOM is not refreshed until the next `terminalStatuses` message. This is the most commonly forgotten step.

#### Step 4c: Update agent name display logic (lines 4806-4811)

```javascript
// BEFORE (lines 4806-4811):
if (roleId !== 'jules' && lastStartupCommands[roleId]) {
    const cmd = lastStartupCommands[roleId].trim().split(/\s+/)[0].toUpperCase();
    name.innerText = `${label} - ${cmd} CLI`;
} else {
    name.innerText = label;
}

// AFTER:
if (roleId !== 'jules') {
    if (lastTerminalAgentNames[roleId]) {
        // Prefer terminal-derived name (locked to actual running terminal, workspace-agnostic)
        name.innerText = `${label} - ${lastTerminalAgentNames[roleId]}`;
    } else if (lastStartupCommands[roleId]) {
        // Fallback: derive from workspace startup command config
        const cmd = lastStartupCommands[roleId].trim().split(/\s+/)[0].toUpperCase();
        name.innerText = `${label} - ${cmd} CLI`;
    } else {
        name.innerText = label;
    }
} else {
    name.innerText = label;
}
```

#### Step 4d: Update analyst agent display (lines 5515-5520)

```javascript
// BEFORE (lines 5515-5520):
if (lastStartupCommands['analyst']) {
    const cmd = lastStartupCommands['analyst'].trim().split(/\s+/)[0].toUpperCase();
    name.innerText = `ANALYST - ${cmd} CLI`;
} else {
    name.innerText = 'ANALYST';
}

// AFTER:
if (lastTerminalAgentNames['analyst']) {
    name.innerText = `ANALYST - ${lastTerminalAgentNames['analyst']}`;
} else if (lastStartupCommands['analyst']) {
    const cmd = lastStartupCommands['analyst'].trim().split(/\s+/)[0].toUpperCase();
    name.innerText = `ANALYST - ${cmd} CLI`;
} else {
    name.innerText = 'ANALYST';
}
```

## Testing Strategy

1. **Manual test scenario**:
   - Open workspace A with lead coder configured as gemini
   - Start a lead coder terminal
   - Verify kanban shows "GEMINI CLI" in column header
   - Verify sidebar shows "LEAD CODER - GEMINI CLI"
   - Switch to workspace B where lead coder is configured as claude
   - Verify kanban still shows "GEMINI CLI"
   - Verify sidebar still shows "LEAD CODER - GEMINI CLI"
   - Close the terminal
   - Verify kanban shows "CLAUDE CLI" (fallback to workspace config)
   - Verify sidebar shows "LEAD CODER - CLAUDE CLI"

2. **Regression tests**:
   - Ensure kanban agent display still works when no terminals are running
   - Ensure sidebar agent display still works when no terminals are running
   - Ensure workspace switching doesn't break other functionality
   - Ensure terminal creation updates agent names correctly
   - Ensure terminal closure updates agent names correctly

## Risks and Considerations

1. **Terminal dispatch map persistence**: Retaining `clearRegisteredTerminalsMap()` on workspace switch means the dispatch map is still reset for dispatch safety (not agent-name correctness — that is now handled by Step 2).
2. **`renderAgentList()` in message handler**: Must be called inside `case 'terminalAgentNames':` — without it, the display does not update until the next `terminalStatuses` push.
3. **Map mutation during iteration**: Safe per JavaScript specification; `_terminalAgentInfo.delete(name)` during `for...of` of the same map is well-defined.
4. **`vscode.window.terminals` includes exited terminals**: Terminals that closed but haven't fired `onDidCloseTerminal` yet will still be in the array. The existing `clearTerminalAgentInfo` call-path handles cleanup; tolerate a brief staleness window.
5. **Message ordering**: Terminal agent names might arrive after startup commands on initial load — mitigated by prioritizing terminal names in display logic.
6. **Backward compatibility**: If the sidebar doesn't receive terminal agent names (e.g., old extension version hot-reloaded), it falls back to workspace config — no regression.

## Success Criteria

- Kanban board agent names are locked to the terminals that created them
- Sidebar agent names are locked to the terminals that created them
- Switching workspaces does not change displayed terminal names in either kanban or sidebar
- Kanban and sidebar show consistent agent names
- Fallback to workspace configuration works when no terminals are running
- Terminal creation/closure updates agent names correctly in both kanban and sidebar

## Verification Plan

### Manual Tests
- Workspace switch does not change kanban agent names for running terminals
- Workspace switch does not change sidebar agent names for running terminals
- Kanban and sidebar show consistent agent names
- Terminal closure causes both kanban and sidebar to fall back to workspace config
- Terminal creation causes both kanban and sidebar to update to terminal-derived name

### Automated Tests
- Unit test: `getActualTerminalAgentNames()` works without `_registeredTerminals` being populated
- Unit test: `getActualTerminalAgentNames()` prunes stale entries for closed terminals
- Unit test: terminal agent names are sent to sidebar on terminal creation
- Unit test: terminal agent names are sent to sidebar on terminal closure
- Unit test: sidebar prioritizes terminal-derived names over workspace config
- Integration test: workspace switch does not change kanban agent names
- Integration test: workspace switch does not change sidebar agent names

---

**Recommendation: Send to Coder**
