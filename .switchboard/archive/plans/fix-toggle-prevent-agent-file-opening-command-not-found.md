# Fix togglePreventAgentFileOpening Command Not Found

## Goal

Fix the "command 'switchboard.togglePreventAgentFileOpening' not found" error by moving the command registration (and the related `forceOpenFile` command) outside the `if (workspaceRoot)` conditional block so they're always available.

## Metadata

**Tags:** bugfix, infrastructure
**Complexity:** 2

## Context

The `switchboard.togglePreventAgentFileOpening` command is registered at line 2251 in `src/extension.ts`, inside the `if (workspaceRoot)` block that starts at line 2127. The status bar item that references this command is created unconditionally at line 2412-2420.

If `workspaceRoot` is null at activation time, the command registration is skipped, but the status bar item is still created. When the user clicks the status bar item, VS Code attempts to execute a command that was never registered, resulting in the "command not found" error.

The command implementation (lines 2250-2257) does not depend on `workspaceRoot` — it simply toggles the `switchboard.preventAgentFileOpening` workspace configuration setting. Therefore, the command should be registered unconditionally, not conditioned on a workspace being selected.

The `switchboard.forceOpenFile` command (lines 2240-2248) has the same problem — it is inside the `if (workspaceRoot)` block but only uses the module-level `allowedUrisToOpen` set (line 48) and `vscode.commands.executeCommand('vscode.open', uri)`.

## Root Cause Analysis

**Assumption:** A workspace IS currently selected in the kanban board (user confirmed this). The issue is not that no workspace is selected, but that the activation-time `workspaceRoot` variable (line 1206) is null, causing the command registration to be skipped.

**Potential Cause Identified:** Schema mismatch in persisted workspace data in `KanbanProvider.ts`:

- **Line 243** (constructor):
  ```typescript
  const persistedWorkspace = this._context.workspaceState.get<{ index: number; name: string } | null>('kanban.lastSelectedWorkspace', null);
  ```

- **Line 512** (`_resolvePersistedWorkspace`):
  ```typescript
  if (typeof p.index !== 'number' || !Array.isArray(p.pathSegments)) {
  ```

The persisted schema is `{ index: number; name: string }` but `_resolvePersistedWorkspace` expects `{ index: number; pathSegments: string[] }`. If old persisted data has `name` instead of `pathSegments`, the check fails and returns null, causing `workspaceRoot` to be null at activation time.

**Why This Causes the Command Not Found:**
1. At activation time (line 1206), `workspaceRoot = kanbanProvider!.getCurrentWorkspaceRoot()` is called
2. If `_resolvePersistedWorkspace` returns null due to schema mismatch, `workspaceRoot` is null
3. The `if (workspaceRoot)` block at line 2127 is skipped
4. The command registrations at lines 2240-2248 and 2250-2257 are never executed
5. The status bar item at line 2412-2420 is still created and assigned the command
6. When the user clicks the status bar item, VS Code tries to execute a command that was never registered

**Note:** The schema mismatch in `KanbanProvider.ts` is a separate bug that should be tracked as its own plan. Fixing it requires migration logic for existing persisted state, which is a different complexity class. This plan scopes the fix to the command registration only.

## Complexity Audit

### Routine
- Moving two small command registration blocks (8 lines + 8 lines) outside a conditional block
- No behavioral change to command logic
- No new dependencies or API usage
- Line numbers verified against current source

### Complex / Risky
- None — this is a pure code relocation with no logic changes

## Edge-Case & Dependency Audit

- **Race Conditions:** None. Command registration happens synchronously during `activate()`. The status bar item is created after the commands, so there's no window where the item exists but the command doesn't.
- **Security:** No impact. The commands were already accessible when `workspaceRoot` was non-null; this just makes them available in the null case too.
- **Side Effects:** If there is no VS Code workspace folder open at all (not just no kanban workspace selected), `config.update('preventAgentFileOpening', !current, vscode.ConfigurationTarget.Workspace)` may silently fail or no-op because there's no workspace scope to write to. This is acceptable — the status bar item already exists unconditionally in this scenario, so the UX is already "present but possibly non-functional" regardless of this fix.
- **Dependencies & Conflicts:** The `onDidChangeTabs` handler (lines 2220-2238) and the `forceOpenFile` command both reference `allowedUrisToOpen` (module-level Set at line 48). Moving `forceOpenFile` outside the block is safe because `allowedUrisToOpen` is always in scope. The `onDidChangeTabs` handler remains inside the `if (workspaceRoot)` block — this is correct because file-opening prevention only makes sense when a workspace exists.

## Dependencies

None — this plan is self-contained.

## Adversarial Synthesis

Key risks: (1) `forceOpenFile` command has the same conditional-registration bug and should be moved alongside the toggle command for consistency. (2) The `config.update` call in the toggle command may no-op in a truly workspace-less window, but this is pre-existing behavior from the unconditional status bar item. (3) The underlying schema mismatch in `KanbanProvider.ts` remains unfixed and should be tracked separately. Mitigations: Move both commands; document the no-workspace edge case as acceptable; file a follow-up plan for the schema mismatch.

## Proposed Changes

### [MODIFY] `src/extension.ts` — Move command registrations outside `if (workspaceRoot)` block

**Move lines 2240-2257 (both `forceOpenFile` and `togglePreventAgentFileOpening` commands) to after line 2260 (the closing `}` of the `if (workspaceRoot)` block).**

```typescript
// BEFORE (lines 2240-2260):
        context.subscriptions.push(
            vscode.commands.registerCommand('switchboard.forceOpenFile', async (uri: vscode.Uri) => {
                if (!uri) {
                    return;
                }
                allowedUrisToOpen.add(uri.toString());
                await vscode.commands.executeCommand('vscode.open', uri);
            })
        );

        context.subscriptions.push(
            vscode.commands.registerCommand('switchboard.togglePreventAgentFileOpening', async () => {
                const config = vscode.workspace.getConfiguration('switchboard');
                const current = config.get<boolean>('preventAgentFileOpening', false);
                await config.update('preventAgentFileOpening', !current, vscode.ConfigurationTarget.Workspace);
                // UI refresh is handled by the configuration change listener.
            })
        );

        // 9. LEASE SYSTEM: Heartbeat removed — only used for MCP server re-registration.
    }

// AFTER:
        // 9. LEASE SYSTEM: Heartbeat removed — only used for MCP server re-registration.
    }

    // Register file-opening commands unconditionally — they do not depend on workspaceRoot
    context.subscriptions.push(
        vscode.commands.registerCommand('switchboard.forceOpenFile', async (uri: vscode.Uri) => {
            if (!uri) {
                return;
            }
            allowedUrisToOpen.add(uri.toString());
            await vscode.commands.executeCommand('vscode.open', uri);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('switchboard.togglePreventAgentFileOpening', async () => {
            const config = vscode.workspace.getConfiguration('switchboard');
            const current = config.get<boolean>('preventAgentFileOpening', false);
            await config.update('preventAgentFileOpening', !current, vscode.ConfigurationTarget.Workspace);
            // UI refresh is handled by the configuration change listener.
        })
    );
```

**Context:** Both commands use only module-level state (`allowedUrisToOpen` at line 48) and VS Code APIs that don't require a workspace root. The `onDidChangeTabs` handler (lines 2220-2238) stays inside the block because it depends on workspace-scoped file operations.

**Logic:** Pure code relocation — no logic changes.

**Implementation:** Cut lines 2240-2257, paste after line 2260 (the closing brace of the `if (workspaceRoot)` block), adjust indentation from 8-space to 4-space (module-level scope).

**Edge Cases:** In a workspace-less window, `config.update(..., ConfigurationTarget.Workspace)` may no-op. This is acceptable pre-existing behavior.

## Verification Plan

### Automated Tests
- ~~TypeScript build must succeed with zero errors.~~ (Skipped per session directive)
- ~~Webpack build must succeed.~~ (Skipped per session directive)

### Manual Tests
1. Reload VS Code window.
2. Click the shield icon in the status bar (right side).
3. **Verify:** The toggle command executes without error, and the status bar item text toggles between "Agent Open: Blocked" and "Agent Open: Allowed".
4. Check the Switchboard settings to verify the `preventAgentFileOpening` setting toggles correctly.
5. **No-workspace scenario:** Open VS Code with no folder (`code -n`). Verify the extension activates and the status bar item appears. Clicking it should not produce a "command not found" error (a no-op on the config update is acceptable).

## Success Criteria
1. Both `forceOpenFile` and `togglePreventAgentFileOpening` command registrations moved outside `if (workspaceRoot)` block.
2. Status bar item click executes successfully regardless of kanban workspace selection.
3. Extension activates successfully with no runtime errors.
4. `forceOpenFile` command is also available unconditionally.

---

**Recommendation:** Send to Intern (complexity 2 — pure code relocation, no logic changes).

## Review & Validation (Reviewer Pass)

### Stage 1: Grumpy Review (Adversarial Findings)
*   **[NIT] Missing Error Handling in `switchboard.forceOpenFile`**: Look at `await vscode.commands.executeCommand('vscode.open', uri);`. If that throws, it's swallowed or bubbles up ungracefully. This is pre-existing though, so I'll let it slide, barely.
*   **[NIT] Unnecessary Comment**: You left a comment `// Register file-opening commands unconditionally...`. It's stating the obvious since it's placed outside the `if (workspaceRoot) {` block. Code should explain *why*, not *what*. But whatever, it passes.

### Stage 2: Balanced Synthesis
The implementation perfectly matches the plan requirements. The commands were successfully relocated outside the `if (workspaceRoot)` block and into the root of the activation function, ensuring they are registered unconditionally. The module-level state `allowedUrisToOpen` is correctly accessed, and there are no scope-related issues. The build succeeds perfectly. No further code changes are strictly required, as the implementation meets all success criteria. The edge case regarding workspace configuration updating in a no-workspace scenario was already acknowledged in the plan and is acceptable pre-existing behavior.

### Action Plan & Status
- **Code Fixes**: None required.
- **Verification**: `npm run compile` passed with no errors.
- **Status**: **APPROVED**.
