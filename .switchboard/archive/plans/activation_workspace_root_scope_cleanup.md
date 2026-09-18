# Activation-Time Workspace Root Scope Cleanup

## Goal

Rename the activation-time `workspaceRoot` variable to `activationWorkspaceRoot` to make its scope intent explicit and prevent future developers from accidentally capturing it in long-lived closures. The variable is currently used correctly for one-shot setup operations during `activate()`, but its generic name makes it a latent risk for stale-capture bugs.

## Metadata

**Tags:** infrastructure, reliability, cleanup
**Complexity:** 2
**Estimated Impact:** Low — rename-only change with minimal functional impact

## Context

During the workspace SSOT consolidation (plan `workspace_ssot_consolidation.md`), the activation-time `workspaceRoot` capture was intentionally kept for one-shot setup operations (lifecycle cleanup, terminal disposal, MCP spawn, setup checks). However, several closures were incorrectly capturing it, causing stale workspace targeting after kanban switches. Those were fixed, but the variable's generic name remains a risk.

## Proposed Changes

### [MODIFY] `src/extension.ts` — Rename `workspaceRoot` to `activationWorkspaceRoot`

**Line 1133:**
```typescript
// BEFORE:
const workspaceRoot = kanbanProvider!.getCurrentWorkspaceRoot();

// AFTER:
const activationWorkspaceRoot = kanbanProvider!.getCurrentWorkspaceRoot();
```

**Replace all 16 `if (workspaceRoot)` and direct `workspaceRoot` references with `activationWorkspaceRoot`**:

| Line | Context | Action |
|------|---------|--------|
| 1150 | `if (workspaceRoot)` | `if (activationWorkspaceRoot)` |
| 1151 | `new WorkspaceExcludeService(workspaceRoot)` | `new WorkspaceExcludeService(activationWorkspaceRoot)` |
| 1203 | `if (workspaceRoot)` | `if (activationWorkspaceRoot)` |
| 1204 | `kanbanProvider!.resolveEffectiveWorkspaceRoot(workspaceRoot)` | `kanbanProvider!.resolveEffectiveWorkspaceRoot(activationWorkspaceRoot)` |
| 1282 | `if (workspaceRoot)` | `if (activationWorkspaceRoot)` |
| 1361 | `if (workspaceRoot)` | `if (activationWorkspaceRoot)` |
| 1486 | `if (workspaceRoot)` | `if (activationWorkspaceRoot)` |
| 1487 | `maybeOfferControlPlaneOnboarding(workspaceRoot)` | `maybeOfferControlPlaneOnboarding(activationWorkspaceRoot)` |
| 2048 | `if (workspaceRoot)` | `if (activationWorkspaceRoot)` |
| 2049 | `resolveEffectiveStateRoot(workspaceRoot)` | `resolveEffectiveStateRoot(activationWorkspaceRoot)` |
| 2050 | `|| workspaceRoot` | `|| activationWorkspaceRoot` |
| 2062 | `resolveEffectiveStateRoot(workspaceRoot)` | `resolveEffectiveStateRoot(activationWorkspaceRoot)` |
| 2097 | `|| workspaceRoot` | `|| activationWorkspaceRoot` |
| 2101 | `spawnBundledMcpServer(context, workspaceRoot, runtimeStateRoot)` | `spawnBundledMcpServer(context, activationWorkspaceRoot, runtimeStateRoot)` |
| 2302 | `if (workspaceRoot)` | `if (activationWorkspaceRoot)` |
| 2303 | `await hasSwitchboardProtocolFiles(workspaceRoot)` | `await hasSwitchboardProtocolFiles(activationWorkspaceRoot)` |
| 2304 | `await hasWorkspaceMcpRuntime(workspaceRoot)` | `await hasWorkspaceMcpRuntime(activationWorkspaceRoot)` |
| 2307 | `await setupProtocolFilesSilent(workspaceRoot, ...)` | `await setupProtocolFilesSilent(activationWorkspaceRoot, ...)` |
| 2312 | `workspaceRoot ? !(await hasSwitchboardConfigs(workspaceRoot)) : false` | `activationWorkspaceRoot ? !(await hasSwitchboardConfigs(activationWorkspaceRoot)) : false` |
| 2315 | `if (needsSetup && workspaceRoot)` | `if (needsSetup && activationWorkspaceRoot)` |
| 2370 | `if (workspaceRoot)` | `if (activationWorkspaceRoot)` |
| 2375 | `taskViewerProvider.prefetchIntegrationData(workspaceRoot)` | `taskViewerProvider.prefetchIntegrationData(activationWorkspaceRoot)` |
| 2446 | `if (workspaceRoot)` | `if (activationWorkspaceRoot)` |

**Note:** The closures that were fixed in the previous review (`onDidOpenTerminal`, `onDidChangeWindowState`, `refreshMcpStatus`, state pruner) already read from `kanbanProvider.getCurrentWorkspaceRoot()` at invocation time. Do not change those — they must continue to read from kanban, not from the activation-time variable.

## Edge Cases

- **None** — this is a pure rename with no behavioral change. All references are one-shot calls during `activate()`.

## Verification Plan

### Automated Tests
- TypeScript build must succeed with zero errors.
- Webpack build must succeed.

### Manual Tests
- Open VS Code with a multi-root workspace.
- Select workspace B in kanban.
- Reload VS Code window.
- **Verify:** Extension activates successfully, no errors in Switchboard output channel.
- Run `Switchboard: Housekeep Now`.
- **Verify:** Command succeeds, targets the kanban-selected workspace.

## Success Criteria
1. All `workspaceRoot` references in `activate()` are renamed to `activationWorkspaceRoot`.
2. Closures that read workspace at invocation time (`onDidOpenTerminal`, `onDidChangeWindowState`, `refreshMcpStatus`, state pruner) continue to read from `kanbanProvider.getCurrentWorkspaceRoot()` (not renamed).
3. TypeScript build succeeds with zero errors.
4. Extension activates successfully with no runtime errors.

---

**Recommendation:** Send to Coder (complexity 2).
