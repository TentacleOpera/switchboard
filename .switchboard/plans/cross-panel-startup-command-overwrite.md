# Cross-panel startup command overwrite

## Problem

Both the Kanban board and Agent Control panel share the same `agentsTabSaveConfig()` function (kanban.html:5540-5542) which collects ALL agent startup command inputs and sends them as a **full replacement** via `saveStartupCommands`. After one panel saves, the other panel's inputs are stale. The next autosave from the stale panel (triggered by any checkbox `change` or text input `blur`) overwrites the saved values with its stale inputs.

The save handler in `KanbanProvider._saveStartupCommands` (KanbanProvider.ts:5072-5100) calls `GlobalIntegrationConfigService.setAgentStartupCommands(msg.commands)` — a full replace, not a merge. After saving, it broadcasts `startupCommandsChanged` to `SURFACES.terminals` only — it does NOT push the updated `startupCommands` back to the kanban/agent-control webviews.

The same gap exists in `TaskViewerProvider.handleSaveStartupCommands` (TaskViewerProvider.ts:12014-12223) — the setup.html save path also does not notify the kanban/agent-control panels.

## Evidence

- Config backups show `reviewer: "claude"` was successfully saved at multiple timestamps (2026-08-18 through 2026-08-20)
- The current `~/.switchboard/integration-config.json` has `reviewer: "agy --dangerously-skip-permissions"` — a later save from the stale Kanban board overwrote it
- The user observed: "it is like each one overwrites the other, or kanban.html always wins"

## Fix

After a successful save, push the updated `startupCommands` back to ALL kanban/agent-control webviews so their inputs re-hydrate to the latest saved values. This ensures the next autosave from any panel sends the fresh values, not stale ones.

### Changes

#### 1. `src/services/KanbanProvider.ts` — `case 'saveStartupCommands'` (line ~12217)

After `_saveStartupCommands` succeeds, re-read the saved state and push it back to the webviews:

```typescript
case 'saveStartupCommands': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    if (!workspaceRoot) { return { success: false, error: 'No workspace root resolved' }; }
    await this._saveStartupCommands(workspaceRoot, msg);
    this._markConfigDirty();
    try {
        this._broadcaster?.mirrorToWs(SURFACES.terminals, { type: 'startupCommandsChanged' }, 'startupCommandsChanged');
    } catch { /* broadcast failure must not fail the save */ }
    // NEW: Push the updated startupCommands back to ALL webviews (kanban board +
    // Agent Control) so their AGENTS tab inputs re-hydrate. Without this, a stale
    // panel's next autosave overwrites the just-saved values with its stale inputs.
    try {
        const startupState = await this._getStartupCommands(workspaceRoot);
        this.postMessage({ type: 'startupCommands', ...startupState });
    } catch { /* non-critical */ }
    return { success: true };
}
```

#### 2. `src/services/TaskViewerProvider.ts` — `handleSaveStartupCommands` (line ~12203)

After the save, notify the KanbanProvider to push updated commands to its webviews:

```typescript
await Promise.all([
    this._postSidebarConfigurationState(resolvedWorkspaceRoot),
    this.postSetupPanelState(resolvedWorkspaceRoot)
]);
// NEW: Push updated startupCommands to kanban/agent-control webviews so their
// AGENTS tab inputs re-hydrate. Without this, a stale panel's next autosave
// overwrites the just-saved values.
try {
    const startupState = await this._kanbanProvider?._getStartupCommands(resolvedWorkspaceRoot);
    if (startupState) {
        this._kanbanProvider?.postMessage({ type: 'startupCommands', ...startupState });
    }
} catch { /* non-critical */ }
```

Note: `_getStartupCommands` is private in KanbanProvider. Either make it public or add a public helper `pushStartupCommands(workspaceRoot)` that reads and posts.

### Why not merge instead of full-replace?

A merge-based save (only sending changed roles) would require tracking which inputs changed since the last hydration. The push-back approach is simpler and more robust: it ensures every panel has the latest values after any save, regardless of which panel initiated it.

### Edge case: active typing

If the user is actively typing in panel B when panel A's save pushes back, panel B's input gets overwritten with the saved value. This is a minor UX issue that only affects the rare case of simultaneous edits, and is far better than the current data-loss behavior.

## Verification

1. Open both the Kanban board and Agent Control panel
2. In Agent Control, change `reviewer` from `agy` to `claude`
3. Blur the input (triggers autosave)
4. Switch to the Kanban board's AGENTS tab — the reviewer input should now show `claude`
5. Toggle a checkbox in the Kanban board (triggers autosave)
6. Check `~/.switchboard/integration-config.json` — `reviewer` should still be `claude`
7. Create a reviewer terminal — it should start `claude` and be labeled "CLAUDE CLI"
