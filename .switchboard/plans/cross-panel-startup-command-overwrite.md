# Cross-panel startup command overwrite

## Goal

Fix the cross-panel startup command overwrite bug where saving agent startup commands from one panel (Kanban board or Agent Control) causes the other panel's stale inputs to overwrite the just-saved values on the next autosave. The fix pushes the updated state back to all webviews after every save so their inputs re-hydrate to the latest values.

### Problem Analysis & Root Cause

Both the Kanban board and Agent Control panel share the same `agentsTabSaveConfig()` function (kanban.html:6006-6008) which collects ALL agent startup command inputs and sends them as a **full replacement** via `saveStartupCommands`. After one panel saves, the other panel's inputs are stale. The next autosave from the stale panel (triggered by any checkbox `change` or text input `blur` — listeners at kanban.html:6015-6022) overwrites the saved values with its stale inputs.

The save handler in `KanbanProvider._saveStartupCommands` (KanbanProvider.ts:5149-5197) calls `GlobalIntegrationConfigService.setAgentStartupCommands(msg.commands)` — a full replace, not a merge. After saving, the `case 'saveStartupCommands'` handler (KanbanProvider.ts:12395-12416) broadcasts `startupCommandsChanged` to `SURFACES.terminals` only — it does NOT push the updated `startupCommands` back to the kanban/agent-control webviews.

The same gap exists in `TaskViewerProvider.handleSaveStartupCommands` (TaskViewerProvider.ts:12222-12431) — the setup.html save path also does not notify the kanban/agent-control panels.

**Evidence:**
- Config backups show `reviewer: "claude"` was successfully saved at multiple timestamps (2026-08-18 through 2026-08-20)
- The current `~/.switchboard/integration-config.json` has `reviewer: "agy --dangerously-skip-permissions"` — a later save from the stale Kanban board overwrote it
- The user observed: "it is like each one overwrites the other, or kanban.html always wins"

**Save path convergence:** All save paths converge to two distinct codepaths:
1. **Kanban board / Agent Control panel** → `KanbanProvider._handleMessage` → `case 'saveStartupCommands'` (line 12395) → `_saveStartupCommands` (line 5149). Both panels share the same `_handleMessage` (agent control panel wired at line 1833-1834).
2. **Setup panel (setup.html / implementation.html / SetupPanelProvider)** → `TaskViewerProvider.handleSaveStartupCommands` (line 12222). `SetupPanelProvider` delegates here regardless of whether `_setupService` is active (SetupPanelProvider.ts:146-149 and 666-673 both call `this._taskViewerProvider.handleSaveStartupCommands`).

## Metadata

**Tags:** [frontend, backend, bugfix]
**Complexity:** 5

## User Review Required

This plan modifies the save flow for agent startup commands across two providers. The approach (push-back re-hydration) is a design choice that trades a narrow race window for implementation simplicity. Review the approach before implementation.

## Complexity Audit

### Routine
- Adding a push-back call after existing save logic — the same pattern already exists in `case 'getStartupCommands'` (KanbanProvider.ts:12388-12393), which reads state and posts `startupCommands` to webviews
- The `startupCommands` message handler in kanban.html (line 10665-10693) already re-hydrates inputs — no webview changes needed
- `KanbanProvider.postMessage` (line 2418) already reaches both the kanban board and agent control panel via the secondary-delivery block (line 2442-2446) — a single `postMessage` call fans out to both
- Setting `.value` programmatically in the handler (kanban.html:10669) does NOT trigger `change`/`blur` events in the DOM — no autosave loop risk
- The push-back also syncs `lastVisibleAgents` and calls `updateAllColumnAgents()` / `updateJulesButtonVisibility()` (kanban.html:10688-10692) — these are idempotent

### Complex / Risky
- Narrow race window: if panel B's blur fires between panel A's save completion and the push-back arrival, panel B collects and sends stale values. The push-back from panel B's save then propagates those stale values to panel A. This is a residual edge case that is far better than the current data-loss behavior but does not fully eliminate the race.
- `_getStartupCommands` is private on KanbanProvider — the TaskViewerProvider path needs a public accessor or helper method.

## Edge-Case & Dependency Audit

**Race Conditions:**
- Panel A saves → push-back in-flight → panel B's blur fires → panel B collects stale values → panel B saves stale values → push-back from panel B propagates stale values to panel A. Window is narrow (async gap between save `await` and push-back `await`) but nonzero.
- Mitigation: the push-back from panel B's save re-hydrates panel A, so the system converges. The data loss is limited to the brief window where panel B's stale save overwrote panel A's fresh save. A merge-based save would eliminate this entirely but requires per-input dirty tracking in the webview (significantly more complex).

**Security:** No security implications — startup commands are user-configured CLI invocations, not credentials.

**Side Effects:**
- The push-back re-hydrates the SAVING panel's inputs too. Since the saved values match what the user just entered, this is a no-op in terms of visible values. No UX disruption.
- The `startupCommands` handler also syncs `lastVisibleAgents` and calls `updateAllColumnAgents()` / `updateJulesButtonVisibility()` (kanban.html:10688-10692). Receiving the push-back after a save triggers these again — they are idempotent.

**Dependencies & Conflicts:**
- The push-back relies on `_getStartupCommands` reading fresh values after `_saveStartupCommands` writes. Verified: `_saveStartupCommands` writes to `GlobalIntegrationConfigService.setAgentStartupCommands` (line 5154), and `_getStartupCommands` reads via `TaskViewerProvider.getStartupCommands` which reads from `GlobalIntegrationConfigService.getAgentStartupCommands` (TaskViewerProvider.ts:7349). Same store, fresh read.
- No dependency on other plans or sessions.

## Dependencies

None — this is a standalone bugfix.

## Adversarial Synthesis

Key risks: (1) narrow race window where a stale panel's blur fires between save and push-back, (2) `_getStartupCommands` privacy requiring a public helper, (3) push-back triggering idempotent column-visibility updates. Mitigations: race window is extremely narrow and the system converges on next save; public `pushStartupCommands(workspaceRoot)` helper encapsulates read+post; idempotent updates are harmless.

## Proposed Changes

### 1. `src/services/KanbanProvider.ts` — Add public `pushStartupCommands` helper

**Context:** `postMessage` (line 2418) goes through the broadcaster which fans out to the primary board panel, and has a secondary-delivery block (line 2442-2446) that also posts to the agent control panel. So a single `postMessage` call reaches both panels.

**Logic:** Read the current startup state via `_getStartupCommands` and broadcast it to all webviews. This is the same read+post pattern used by `case 'getStartupCommands'` (line 12388-12393), extracted into a reusable public method.

**Implementation:** Add after `_getStartupCommands` (after line 5147):

```typescript
/**
 * Read the current startup commands state and push it to ALL webviews
 * (kanban board + Agent Control panel) so their AGENTS tab inputs
 * re-hydrate to the latest saved values. Called after any save to
 * prevent a stale panel's next autosave from overwriting fresh values.
 */
public async pushStartupCommands(workspaceRoot: string): Promise<void> {
    try {
        const startupState = await this._getStartupCommands(workspaceRoot);
        this.postMessage({ type: 'startupCommands', ...startupState });
    } catch { /* non-critical — push-back failure must not fail the save */ }
}
```

**Edge Cases:** If `_getStartupCommands` throws (e.g., state file unreadable), the catch absorbs the error — the save itself already succeeded. The push-back is best-effort.

### 2. `src/services/KanbanProvider.ts` — `case 'saveStartupCommands'` (line 12395)

**Context:** After the save and the terminals-surface broadcast, the webviews that sourced the save (and the other panel) still hold their pre-save input values. Without a push-back, the non-saving panel's next autosave sends stale values.

**Logic:** Call `pushStartupCommands` after the existing broadcast to re-hydrate all webviews with the freshly saved state.

**Implementation:** Add the push-back call before `return { success: true }` (after line 12414):

```typescript
case 'saveStartupCommands': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    if (!workspaceRoot) { return { success: false, error: 'No workspace root resolved' }; }
    await this._saveStartupCommands(workspaceRoot, msg);
    this._markConfigDirty();
    try {
        this._broadcaster?.mirrorToWs(SURFACES.terminals, { type: 'startupCommandsChanged' }, 'startupCommandsChanged');
    } catch { /* broadcast failure must not fail the save */ }
    // Push the updated startupCommands back to ALL webviews (kanban board +
    // Agent Control) so their AGENTS tab inputs re-hydrate. Without this, a
    // stale panel's next autosave overwrites the just-saved values.
    await this.pushStartupCommands(workspaceRoot);
    return { success: true };
}
```

**Edge Cases:** The push-back also re-hydrates the saving panel. Since the saved values match the user's input, this is a no-op. Setting `.value` programmatically (kanban.html:10669) does not trigger `change`/`blur` events, so no autosave loop.

### 3. `src/services/TaskViewerProvider.ts` — `handleSaveStartupCommands` (line 12222)

**Context:** This is the save path for setup.html, implementation.html, and SetupPanelProvider. After saving to the global config and broadcasting to terminals, the kanban/agent-control webviews are not notified — their inputs remain stale.

**Logic:** After the existing broadcast (line 12423-12425), call the KanbanProvider helper to push updated state to kanban/agent-control webviews.

**Implementation:** Add before `this._postSharedWebviewMessage({ type: 'saveStartupCommandsResult', success: true })` (line 12426):

```typescript
// Push updated startupCommands to kanban/agent-control webviews so their
// AGENTS tab inputs re-hydrate. Without this, a stale panel's next autosave
// overwrites the just-saved values.
try {
    if (this._kanbanProvider && resolvedWorkspaceRoot) {
        await this._kanbanProvider.pushStartupCommands(resolvedWorkspaceRoot);
    }
} catch { /* non-critical */ }
```

**Edge Cases:** `resolvedWorkspaceRoot` may be undefined — guard with the `if` check. `_kanbanProvider` may be null if the kanban board was never opened — the null guard handles this.

### Why not merge instead of full-replace?

A merge-based save (only sending changed roles) would require tracking which inputs changed since the last hydration. The push-back approach is simpler and more robust: it ensures every panel has the latest values after any save, regardless of which panel initiated it.

### Edge case: active typing

If the user is actively typing in panel B when panel A's save pushes back, panel B's input gets overwritten with the saved value. This is a minor UX issue that only affects the rare case of simultaneous edits, and is far better than the current data-loss behavior.

## Verification Plan

### Automated Tests

*(Skipped for this run per session directive — checks remain documented for future execution.)*

### Manual Verification

1. Open both the Kanban board and Agent Control panel
2. In Agent Control, change `reviewer` from `agy` to `claude`
3. Blur the input (triggers autosave)
4. Switch to the Kanban board's AGENTS tab — the reviewer input should now show `claude`
5. Toggle a checkbox in the Kanban board (triggers autosave)
6. Check `~/.switchboard/integration-config.json` — `reviewer` should still be `claude`
7. Create a reviewer terminal — it should start `claude` and be labeled "CLAUDE CLI"
8. Reverse test: change `reviewer` back to `agy` in the Kanban board, blur, switch to Agent Control — it should show `agy`
9. Test the setup.html path: open the Setup panel, change a startup command, save, then check the Kanban board's AGENTS tab — it should reflect the change

## Outstanding Questions

- **[user]** The push-back approach leaves a narrow race window (panel B's blur fires between panel A's save and push-back). Is this acceptable, or should we invest in merge-based save to eliminate it entirely? — proceeding on the assumption that the narrow race is acceptable given its rarity and the system's convergence on next save.

---

**Recommendation: Send to Coder** (Complexity 5 — multi-file changes with moderate logic, reusing existing patterns)
