# Fix: Planner Terminal Rotation Only Works for Kanban Moves — All Other "Send to Planner" Paths Always Hit Terminal 1

## Goal

The prior plan (`feature_plan_20260625120004_planner-extra-terminals-rotation-stuck-terminal-1.md`) fixed sequential terminal rotation for **kanban card moves** only — single-card drags into the planner column and batch Move All / Move Selected buttons now round-robin across live planner terminals. However, **every other "Send to Planner" entry point in the extension still always dispatches to the default (first) planner terminal**, ignoring the rotation cursor entirely.

The affected entry points are:

1. **Memo "Send to Planner"** button in `implementation.html` — posts `memoGeneratePrompt` with `action: 'send'`, which calls `dispatchCustomPromptToRole('planner', …)`.
2. **ClickUp / Linear "Ask Agent"** — `askAgentTask(…)` calls `dispatchCustomPromptToRole('planner', …)`.
3. **Constitution Builder / Updater** in `project.html` (via `project.js`) — posts `invokeConstitutionBuilder` / `invokeConstitutionUpdater`, handled in `PlanningPanelProvider.ts` using ad-hoc terminal finding (`vscode.window.terminals.find(t => t.name.toLowerCase().includes('planner'))`).

All three bypass the rotation cursor and always land on the same terminal.

### Problem analysis & root cause

**Where rotation lives.** The round-robin cursor is implemented via three primitives in `TaskViewerProvider`:
- `getRoleTerminalSet('planner', workspaceRoot)` — returns `{ terminals, locationKey }` (`TaskViewerProvider.ts:3459-3483`)
- `getPlannerRotationCursor(locationKey)` — reads the persisted cursor (`TaskViewerProvider.ts:3492-3497`)
- `advancePlannerRotationCursor(locationKey, by)` — advances it (`TaskViewerProvider.ts:3499-3504`)

**Where rotation is wired in (kanban only).** The prior plan added rotation to exactly two kanban paths:
- **Single-card drag** — `KanbanProvider.ts:5195-5264` (custom-user planner branch) and the built-in planner branch: reads cursor, picks `terminals[cursor % terminals.length]`, passes as `targetTerminalOverride` to `triggerAgentFromKanban`, advances cursor after successful dispatch.
- **Batch buttons** — `_distributePlannerDispatch` (`KanbanProvider.ts:3460-3516`) fans out across terminals using the same cursor.

**Where rotation is NOT wired in (the gap).** The central function for all non-kanban planner dispatches is `dispatchCustomPromptToRole` (`TaskViewerProvider.ts:2634-2646`):

```ts
public async dispatchCustomPromptToRole(role: string, prompt: string, workspaceRoot: string): Promise<boolean> {
    const resolvedWorkspaceRoot = this._resolveWorkspaceRoot(workspaceRoot);
    if (!resolvedWorkspaceRoot) { return false; }
    const targetAgent = await this._resolveAgentTerminalForPlan(role, resolvedWorkspaceRoot);
    if (!targetAgent) {
        vscode.window.showErrorMessage(`No agent assigned to role '${role}'. Please assign a terminal first.`);
        return false;
    }
    if (!this._isValidAgentName(targetAgent)) { return false; }
    vscode.commands.executeCommand('switchboard.focusTerminalByName', targetAgent);
    await this._dispatchExecuteMessage(resolvedWorkspaceRoot, targetAgent, prompt, {});
    return true;
}
```

`_resolveAgentTerminalForPlan` (`TaskViewerProvider.ts:5946-5956`) returns the **default assigned terminal** for the role — it never reads or advances the rotation cursor. So every call to `dispatchCustomPromptToRole('planner', …)` goes to terminal 1.

**Callers of `dispatchCustomPromptToRole('planner', …)`:**
- `TaskViewerProvider.ts:9507` — Memo "Send to Planner" (`memoGeneratePrompt` handler, `action === 'send'`)
- `TaskViewerProvider.ts:5230` — ClickUp/Linear "Ask Agent" (`askAgentTask`)

**Constitution Builder — separate mechanism.** `PlanningPanelProvider.ts:3274-3298` (`invokeConstitutionBuilder` / `invokeConstitutionUpdater`) finds a terminal by name pattern (`t.name.toLowerCase().includes('planner') || t.name.toLowerCase().includes('lead')`) and sends text via `sendRobustText`. This doesn't use `dispatchCustomPromptToRole` or the agent registry at all — it's a completely separate dispatch path.

**Root cause (one line):** `dispatchCustomPromptToRole` — the shared chokepoint for all non-kanban "send to planner" actions — resolves the target terminal via `_resolveAgentTerminalForPlan` (default terminal only) and never reads or advances the rotation cursor; the constitution builder uses an even more ad-hoc path that also bypasses rotation.

**Fix:** Add rotation cursor logic to `dispatchCustomPromptToRole` when `role === 'planner'`, mirroring the kanban single-card pattern (read cursor → pick terminal → dispatch → advance cursor only on success). Refactor the constitution builder to route through `dispatchCustomPromptToRole` so it inherits rotation for free.

## Metadata

- **Tags:** `bugfix`, `backend`, `ui`
- **Complexity:** 4 / 10
- **Affected components:** `src/services/TaskViewerProvider.ts` (`dispatchCustomPromptToRole` — add rotation), `src/services/PlanningPanelProvider.ts` (constitution builder/updater — route through `dispatchCustomPromptToRole`; add `_taskViewerProvider` field + setter), `src/extension.ts` (wire `setTaskViewerProvider` on `planningPanelProvider`)
- **Migration required:** No. The rotation cursor (`globalState['switchboard.planner.rotationCursor']`) keeps its existing key/semantics; this only adds new callers that read/advance it.

## Complexity Audit

### Routine
- Reading/advancing the existing persistent rotation cursor (`getPlannerRotationCursor` / `advancePlannerRotationCursor`) — primitives already exist and are persistent across reloads.
- Enumerating the live planner terminal set via `getRoleTerminalSet('planner', workspaceRoot)` — already used by the kanban paths.
- Scoping the change to `role === 'planner'` only; other roles (`lead`, `orchestrator`, `coder`) keep their current single-terminal behaviour.
- Empty / single-terminal fallback (no rotation → default resolution, identical to today).
- Refactoring the constitution builder to call `dispatchCustomPromptToRole` instead of ad-hoc terminal finding — the prompt text and workspace root are already available; only the terminal-selection mechanism changes.

### Complex / Risky
- **Shared cursor coherence.** The cursor is keyed by `locationKey` (derived from `getRoleTerminalSet`). The new caller in `dispatchCustomPromptToRole` MUST use the same `locationKey` derivation so kanban moves and non-kanban sends advance one consistent cursor — otherwise the two paths would rotate independently and interleave oddly. This is straightforward since `getRoleTerminalSet` is already the shared API.
- **Cursor advance timing.** Must advance the cursor ONLY after successful dispatch (mirroring the kanban single-card fix from the prior plan). A failed dispatch should not skip a terminal. `dispatchCustomPromptToRole` returns `boolean` — advance only when it returns `true`.
- **Constitution builder refactoring risk.** The current constitution builder creates a new terminal if none is found (`vscode.window.createTerminal({ name: 'Constitution Builder', cwd: wsRoot })`). Routing through `dispatchCustomPromptToRole` changes this: if no planner agent is registered, it shows an error instead of creating a terminal. This is a behaviour change — see Edge-Case Audit for mitigation.

## Edge-Case & Dependency Audit

- **Race conditions:** For user-paced sequential sends the persisted cursor write (`globalState.update`) completes well before the next send, so no debounce/lock is needed. The existing dedupe lock in `_handleTriggerAgentActionInternal` is not involved (different code path).
- **Security:** No new surface. The rotation-picked terminal name comes from `getRoleTerminalSet` (enumerated live terminals from the agent registry), not user input. `dispatchCustomPromptToRole` already validates via `_isValidAgentName` (`TaskViewerProvider.ts:2642`); the rotation-picked terminal must also pass this check (it will — it's from the live-terminal registry).
- **Side effects:** `dispatchCustomPromptToRole` calls `vscode.commands.executeCommand('switchboard.focusTerminalByName', targetAgent)` then `_dispatchExecuteMessage`. Changing only which terminal is selected does not alter the dispatch semantics — the prompt content, workspace root, and message metadata are unchanged.
- **Empty / single-terminal pool:** If `getRoleTerminalSet('planner', workspaceRoot)` returns zero terminals, fall back to `_resolveAgentTerminalForPlan` (existing default resolution). If it returns exactly one terminal, rotation is a no-op (correct — one terminal means everything goes there).
- **Cursor advance on failure:** Read the cursor and pick the terminal WITHOUT advancing. Advance the cursor by 1 ONLY after `_dispatchExecuteMessage` succeeds (returns `true`). This mirrors the kanban single-card fix and ensures a failed dispatch doesn't skip a terminal.
- **Shared cursor across kanban and non-kanban:** Use `getRoleTerminalSet('planner', workspaceRoot)` to obtain `{ terminals, locationKey }` and the same `getPlannerRotationCursor` / `advancePlannerRotationCursor` calls. A memo send advances the cursor by 1, so a subsequent kanban move (or another memo send) continues from the right offset, and vice-versa.
- **Constitution builder — no registered planner agent:** Today, the constitution builder creates a new terminal if none is found. After refactoring to `dispatchCustomPromptToRole`, if no planner agent is registered, the user sees `No agent assigned to role 'planner'. Please assign a terminal first.` instead of a new terminal being created. **Mitigation:** Keep the fallback — if `dispatchCustomPromptToRole` returns `false` (no agent), fall back to the existing ad-hoc terminal creation + `sendRobustText` path. This preserves the create-if-missing behaviour while adding rotation when a planner IS registered.
- **Constitution builder — 'lead' fallback:** Today the constitution builder searches for terminals named 'planner' OR 'lead'. After refactoring, `dispatchCustomPromptToRole('planner', …)` only targets the planner role. If the user has a lead terminal but no planner terminal, the fallback path (above) handles it by falling back to the ad-hoc search.
- **Other roles unaffected:** `dispatchCustomPromptToRole` is also called for `'orchestrator'` (KanbanProvider.ts:3045) and `'lead'` (KanbanProvider.ts:6695). The rotation logic MUST be gated on `role === 'planner'` only — other roles keep their current behaviour.
- **No confirmation dialogs** (project rule).

## Proposed Changes

### Change 1 — `src/services/TaskViewerProvider.ts`: add rotation to `dispatchCustomPromptToRole`

Modify `dispatchCustomPromptToRole` (`TaskViewerProvider.ts:2634-2646`) to use the rotation cursor when `role === 'planner'`:

```ts
public async dispatchCustomPromptToRole(role: string, prompt: string, workspaceRoot: string): Promise<boolean> {
    const resolvedWorkspaceRoot = this._resolveWorkspaceRoot(workspaceRoot);
    if (!resolvedWorkspaceRoot) { return false; }

    // For planner role: pick the next terminal from the rotation cursor
    // (mirrors the kanban single-card path). For other roles: use default resolution.
    let targetAgent: string | undefined;
    let plannerLocationKey: string | undefined;
    if (role === 'planner') {
        const { terminals, locationKey } = await this.getRoleTerminalSet('planner', resolvedWorkspaceRoot);
        if (terminals.length > 0) {
            const cursor = this.getPlannerRotationCursor(locationKey);
            const picked = terminals[cursor % terminals.length];
            if (picked && this._isValidAgentName(picked)) {
                targetAgent = picked;
                plannerLocationKey = locationKey;
            }
        }
    }
    // Fallback: default resolution (also covers non-planner roles and empty/single-terminal pools)
    if (!targetAgent) {
        targetAgent = await this._resolveAgentTerminalForPlan(role, resolvedWorkspaceRoot);
    }

    if (!targetAgent) {
        vscode.window.showErrorMessage(`No agent assigned to role '${role}'. Please assign a terminal first.`);
        return false;
    }
    if (!this._isValidAgentName(targetAgent)) { return false; }
    vscode.commands.executeCommand('switchboard.focusTerminalByName', targetAgent);
    const success = await this._dispatchExecuteMessage(resolvedWorkspaceRoot, targetAgent, prompt, {});

    // Advance the rotation cursor ONLY after successful dispatch
    // (consistent with the kanban single-card path — a failed dispatch doesn't skip a terminal)
    if (success && plannerLocationKey) {
        await this.advancePlannerRotationCursor(plannerLocationKey, 1);
    }
    return success;
}
```

**Key design decisions:**
- The rotation pick happens BEFORE dispatch; the cursor advance happens AFTER successful dispatch.
- If `getRoleTerminalSet` returns zero terminals, or the picked terminal fails `_isValidAgentName`, we fall back to `_resolveAgentTerminalForPlan` (existing default behaviour). This ensures no regression for single-terminal or no-terminal setups.
- The `plannerLocationKey` is only set when we actually used the rotation pick, so the cursor advance is gated correctly.

### Change 2 — `src/services/PlanningPanelProvider.ts` + `src/extension.ts`: route constitution builder through `dispatchCustomPromptToRole`

**Wiring (prerequisite):** `PlanningPanelProvider` currently has no reference to `TaskViewerProvider`. Add one, mirroring the existing `setKanbanProvider` pattern:

1. **`src/services/PlanningPanelProvider.ts`** — add a field and setter (near the existing `_kanbanProvider` at line 111):
```ts
// Type-only reference (avoids a runtime circular import with TaskViewerProvider).
// Used to dispatch constitution builder/updater prompts through the planner rotation.
private _taskViewerProvider?: import('./TaskViewerProvider').TaskViewerProvider;

public setTaskViewerProvider(provider: import('./TaskViewerProvider').TaskViewerProvider): void {
    this._taskViewerProvider = provider;
}
```

2. **`src/extension.ts:852`** — after `planningPanelProvider.setKanbanProvider(kanbanProvider!)`, add:
```ts
planningPanelProvider.setTaskViewerProvider(taskViewerProvider);
```

**Handler changes:** Modify `invokeConstitutionBuilder` (`PlanningPanelProvider.ts:3274-3285`) and `invokeConstitutionUpdater` (`PlanningPanelProvider.ts:3287-3298`) to try `dispatchCustomPromptToRole` first, falling back to the existing ad-hoc terminal creation if no planner agent is registered:

```ts
case 'invokeConstitutionBuilder': {
    const wsRoot = msg.workspaceRoot;
    if (!allRoots.includes(wsRoot)) { break; }
    const promptText = `Follow instructions in .agents/skills/constitution_builder.md to build or improve CONSTITUTION.md in this project.`;
    // Try dispatching via the planner role (gets rotation for free).
    // Fall back to ad-hoc terminal creation if no planner agent is registered.
    if (this._taskViewerProvider) {
        const dispatched = await this._taskViewerProvider.dispatchCustomPromptToRole('planner', promptText, wsRoot);
        if (dispatched) { break; }
    }
    // Fallback: create a terminal if no planner agent is registered
    const terminal = vscode.window.terminals.find(t => t.name.toLowerCase().includes('planner') || t.name.toLowerCase().includes('lead'))
        || vscode.window.createTerminal({ name: 'Constitution Builder', cwd: wsRoot });
    terminal.show();
    const { sendRobustText } = require('./terminalUtils');
    await sendRobustText(terminal, promptText);
    break;
}
```

Apply the same pattern to `invokeConstitutionUpdater` with its respective prompt text:

```ts
case 'invokeConstitutionUpdater': {
    const wsRoot = msg.workspaceRoot;
    if (!allRoots.includes(wsRoot)) { break; }
    const promptText = `Follow instructions in .agents/skills/constitution_builder.md to improve and update the existing CONSTITUTION.md in this project.`;
    if (this._taskViewerProvider) {
        const dispatched = await this._taskViewerProvider.dispatchCustomPromptToRole('planner', promptText, wsRoot);
        if (dispatched) { break; }
    }
    // Fallback: create a terminal if no planner agent is registered
    const terminal = vscode.window.terminals.find(t => t.name.toLowerCase().includes('planner') || t.name.toLowerCase().includes('lead'))
        || vscode.window.createTerminal({ name: 'Constitution Builder', cwd: wsRoot });
    terminal.show();
    const { sendRobustText } = require('./terminalUtils');
    await sendRobustText(terminal, promptText);
    break;
}
```

**Key design decisions:**
- Try `dispatchCustomPromptToRole('planner', …)` first — this gets rotation for free and uses the proper agent registry.
- If it returns `false` (no planner agent registered), fall back to the existing ad-hoc terminal finding + creation + `sendRobustText`. This preserves the create-if-missing behaviour and the 'lead' terminal fallback.
- `this._taskViewerProvider` must be accessible from `PlanningPanelProvider`. Verify the reference exists (it likely does since `PlanningPanelProvider` already coordinates with `TaskViewerProvider` for other actions). If not, add a reference or pass it via constructor.

### Change 3 (verification) — confirm `askAgentTask` is covered

`askAgentTask` (`TaskViewerProvider.ts:5221-5231`) calls `dispatchCustomPromptToRole('planner', prompt, resolvedRoot)`. No change needed — it automatically inherits rotation from Change 1. Verify this during testing.

## Verification Plan

> **Note:** Per project conventions, compilation (`npm run compile`) and automated tests are NOT run as part of this plan. The user will run the build and test suite separately. The steps below are manual verification checks to perform after implementation.

### Manual Verification

1. **Memo Send to Planner rotation:** With ≥3 live planner terminals, use the Memo "Send to Planner" button in `implementation.html` → dispatches to terminal 1. Send another memo → terminal 2. Third → terminal 3. Fourth → wraps to terminal 1.
2. **Ask Agent rotation:** Use the ClickUp/Linear "Ask Agent" action → dispatches to the next terminal in the rotation (continuing from where the memo send left off).
3. **Shared cursor coherence across paths:** Do a memo send (lands on terminal 1, cursor → 1), then a kanban single-card drag → terminal 2 (continues the cursor), then another memo send → terminal 3.
4. **Constitution Builder rotation:** With ≥2 live planner terminals, click "Build via Planner" in the Project tab → dispatches to the next terminal in the rotation. Click "Update via Planner" → next terminal.
5. **Constitution Builder fallback (no planner agent):** With no planner agent registered (but a lead terminal exists), click "Build via Planner" → falls back to the ad-hoc terminal finding (existing behaviour, no regression).
6. **Single-terminal pool:** With one planner terminal, all "send to planner" actions go to it (rotation no-op, no errors).
7. **No-terminal fallback:** With no live planner terminal, memo send falls back to default resolution (`_resolveAgentTerminalForPlan`) without throwing.
8. **Non-planner roles unaffected:** `sendToLead` (KanbanProvider.ts:6695) and epic orchestrator dispatch (KanbanProvider.ts:3045) still go to their default terminals (no rotation, no override).
9. **Cursor persists across reload:** After sends land on 1→2, reload the window, send another memo → continues to terminal 3 (cursor is in globalState).
10. **Failed dispatch doesn't skip a terminal:** If a dispatch fails (e.g. terminal closed mid-dispatch), the cursor is NOT advanced — the next send retries the same terminal slot.
