---
description: Fix "dependency check enabled" toggle in Prompts tab that keeps reverting to enabled
---

# Fix Dependency Check Toggle Persistence

## Goal
Fix the bug where turning off "Dependency check for improve-plan workflow" in the Prompts tab doesn't persist — the toggle keeps reverting to enabled and the dependency check remains active in the prompt.

## Metadata
**Tags:** bugfix, reliability, workflow
**Complexity:** 4

## User Review Required
None — this is a configuration persistence fix with no design decisions.

## Complexity Audit

### Routine
- Change `config.update` scope from Workspace to Global in `_savePromptsConfig` (`KanbanProvider.ts:2222`)
- Add read-after-write verification in `_savePromptsConfig`
- Ensure `_getPromptsConfig` and `_generateBatchPlannerPrompt` read from consistent scope

### Complex / Risky
- Diagnosing the exact scope mismatch: the write uses `ConfigurationTarget.Workspace` (third arg `true` at line 2222), but `config.get` reads from the merged scope stack. If a Global-level value of `true` exists (from `package.json` default), it may override the Workspace-level `false`. This requires runtime verification.

## Edge-Case & Dependency Audit

- **Race Conditions:** The `savePromptsConfig` is async and the panel may re-read config before the write completes. The `await` on `config.update` should prevent this, but the webview's `promptsConfig` message (sent on panel open at `KanbanProvider.ts:4899`) may race with an in-flight save.
- **Security:** No security implications — this is a boolean preference.
- **Side Effects:** Changing the config update scope from Workspace to Global means the setting will apply across all workspaces. This is likely the desired behaviour (user preference, not project-specific), but worth noting.
- **Dependencies & Conflicts:** None. Kanban NEW and PLANNED columns are empty. No active plans touch prompts config or `KanbanProvider.ts` config handling.

## Dependencies
None

## Adversarial Synthesis
Key risks: (1) The `?? true` fix suggested in the original plan is a no-op — `config.get` with default `true` and `?? true` behave identically for `false` values. The real issue is a configuration scope mismatch. (2) Switching from Workspace to Global scope changes the setting's persistence model — it will apply across all workspaces instead of per-workspace. Mitigations: Verify the scope change is appropriate; add read-after-write check to confirm persistence.

## Problem Analysis

### Current Behavior
1. User unchecks "Dependency check for improve-plan workflow" in the Prompts tab
2. The setting appears to save but reverts on next load
3. The `dependencyCheckEnabled` flag keeps being passed as `true` to `buildKanbanBatchPrompt`

### Root Cause Analysis

**The original plan's diagnosis was incorrect.** The issue is NOT that `config.get<boolean>('planner.dependencyCheckEnabled', true)` can't distinguish `false` from `undefined` — VS Code's `config.get` API correctly returns `false` when the setting is explicitly `false`. The `?? true` "fix" is a no-op because `??` only catches `null`/`undefined`, not `false`.

**The actual root cause is a configuration scope mismatch:**

1. **Write path** (`KanbanProvider.ts:2222`):
   ```typescript
   await config.update('planner.dependencyCheckEnabled', msg.dependencyCheckEnabled, true);
   ```
   The third argument `true` means `ConfigurationTarget.Workspace` — the value is written to the workspace-level `.vscode/settings.json`.

2. **Read path** (`KanbanProvider.ts:2238`):
   ```typescript
   const dependencyCheckEnabled = config.get<boolean>('planner.dependencyCheckEnabled', true);
   ```
   `config.get` reads from the **merged** scope stack: Default → Global → Workspace. The `package.json` default is `true` (line 257). If the workspace-level write doesn't take effect (e.g., no workspace folder open, multi-root workspace resolution issue, or the write goes to a different workspace folder than the one `config.get` resolves from), the read falls back to the `true` default.

3. **Why the toggle reverts:** When the Kanban panel is reopened, `_getPromptsConfig` (line 2200) reads the config and sends it to the webview. If the workspace-scoped `false` isn't resolving correctly, the read returns `true`, and the webview checkbox is checked again.

**Webview flow is correct:**
- Checkbox change → `savePromptsConfig` message (`kanban.html:1995`) → `_savePromptsConfig` handler (`KanbanProvider.ts:4902-4906`)
- `promptsTabCollectConfig()` (`kanban.html:1974`) correctly reads `?.checked ?? false` — returns boolean
- `typeof msg.dependencyCheckEnabled === 'boolean'` guard at line 2221 is satisfied
- No serialization issues in the webview

## Proposed Changes

### Execution Breakdown by Complexity

#### Low Complexity Steps

1. **Change the config update scope from Workspace to Global**
   - **File:** `src/services/KanbanProvider.ts`
   - **Line:** 2222
   - **Context:** The `config.update` call uses `true` (Workspace scope) as the third argument. This means the `false` value is written to workspace settings, which may not be the scope that `config.get` resolves from.
   - **Current code:**
     ```typescript
     if (typeof msg.dependencyCheckEnabled === 'boolean') {
         await config.update('planner.dependencyCheckEnabled', msg.dependencyCheckEnabled, true);
     }
     ```
   - **Fixed code:**
     ```typescript
     if (typeof msg.dependencyCheckEnabled === 'boolean') {
         await config.update('planner.dependencyCheckEnabled', msg.dependencyCheckEnabled, vscode.ConfigurationTarget.Global);
     }
     ```
   - **Rationale:** User preferences like "dependency check enabled" are personal workflow settings, not project-specific. Global scope ensures the value is always readable regardless of workspace context. This matches how other toggle settings (e.g., `accurateCoding.enabled`, `advancedReviewer.enabled`) should also be stored — but changing those is out of scope for this bugfix.
   - **Clarification:** The same scope issue potentially affects ALL prompts config settings in `_savePromptsConfig` (lines 2209-2229), but this plan only fixes `dependencyCheckEnabled` to minimize blast radius. A follow-up plan should audit the other settings.

2. **Apply the same scope fix to the config read in `_getPromptsConfig`**
   - **File:** `src/services/KanbanProvider.ts`
   - **Line:** 2200
   - **Context:** No code change needed — `config.get` already reads from the merged scope stack which includes Global. Once the write goes to Global scope, the read will correctly pick up the `false` value.
   - **Verification only:** Confirm that after the scope fix, `config.get<boolean>('planner.dependencyCheckEnabled', true)` returns `false` when the user has unchecked the toggle.

3. **Add read-after-write verification in `_savePromptsConfig`**
   - **File:** `src/services/KanbanProvider.ts`
   - **Lines:** After 2222
   - **Change:** After updating `planner.dependencyCheckEnabled`, immediately read it back to confirm the value persisted. Log a warning if the read-back doesn't match.
   - **Implementation:**
     ```typescript
     if (typeof msg.dependencyCheckEnabled === 'boolean') {
         await config.update('planner.dependencyCheckEnabled', msg.dependencyCheckEnabled, vscode.ConfigurationTarget.Global);
         // Verify persistence
         const readBack = config.get<boolean>('planner.dependencyCheckEnabled', true);
         if (readBack !== msg.dependencyCheckEnabled) {
             console.warn(`[KanbanProvider] dependencyCheckEnabled persistence failed: wrote ${msg.dependencyCheckEnabled}, read back ${readBack}`);
         }
     }
     ```
   - **Rationale:** This diagnostic log will catch any remaining scope resolution issues without adding user-facing noise.

4. **No change needed in `_generateBatchPlannerPrompt`**
   - **File:** `src/services/KanbanProvider.ts`
   - **Line:** 2238
   - **Context:** `config.get<boolean>('planner.dependencyCheckEnabled', true)` will correctly return `false` once the write goes to Global scope. The `?? true` change from the original plan is a no-op and should NOT be applied.
   - **No code change.**

5. **No change needed in the webview**
   - **File:** `src/webview/kanban.html`
   - **Context:** The checkbox serialization (`?.checked ?? false` at line 1974) correctly produces a boolean. The `savePromptsConfig` message correctly includes `dependencyCheckEnabled`. The `promptsConfig` handler (line 3893) correctly applies `!!msg.dependencyCheckEnabled`. No webview changes required.

## Verification Plan

### Automated Tests
- No existing automated tests for config persistence. Adding tests is out of scope for this bugfix.

### Manual Testing
1. Open Kanban view → Prompts tab
2. Uncheck "Dependency check for improve-plan workflow"
3. Switch to another tab (e.g., Board) and return to Prompts — **verify toggle stays off**
4. Run `/improve-plan` on a test plan
5. **Verify:** The generated prompt does NOT contain dependency check instructions (no `[DEPENDENCY CHECK ENABLED]` section)
6. Reload VS Code window (Developer: Reload Window)
7. Open Kanban → Prompts tab — **verify toggle is still off**
8. Check the VS Code settings: Open Settings JSON and verify `switchboard.planner.dependencyCheckEnabled` appears as `false` in Global settings
9. Re-check the toggle — verify it turns back on and dependency check instructions appear in prompts
10. Check the debug console for any `[KanbanProvider] dependencyCheckEnabled persistence failed` warnings

### Expected Behavior
- Toggle state persists across tab switches, VS Code window reloads, and workspace changes
- When unchecked, planner prompts exclude dependency check instructions
- When checked, planner prompts include dependency check instructions
- No `persistence failed` warnings in the console

## Files to Modify
- `src/services/KanbanProvider.ts` (line 2222 — scope change; after 2222 — read-after-write verification)

## Edge Cases to Handle
1. **Multi-root workspace:** Global scope ensures the setting persists regardless of which workspace folder is active. The original Workspace scope was fragile in multi-root setups.
2. **No workspace folder open:** `config.update` with Workspace scope silently fails when no folder is open. Global scope works in all contexts.
3. **Settings JSON manually edited:** If the user manually sets the value in their global `settings.json`, the toggle should reflect that on next panel open — this already works via `_getPromptsConfig`.
4. **Other prompts config settings:** The same scope issue affects `accurateCoding.enabled`, `advancedReviewer.enabled`, `leadChallenge.enabled`, `aggressivePairProgramming.enabled`, `planner.designDocEnabled`, and `planner.designDocLink` (lines 2209-2229). These should be audited in a follow-up plan but are out of scope here.

## Recommendation
**Send to Coder** — Complexity 4. Single-file fix with a scope change and a diagnostic log. The complexity bump from 3→4 reflects the need to understand VS Code's configuration scope resolution and verify the fix works across workspace contexts.

---
## Review & Verification

### Grumpy Principal Engineer Review
- **NIT:** String concatenation vs template literals in `console.warn` log. `wrote " + msg.dependencyCheckEnabled + ", read back " + readBack` is ugly.

### Balanced Synthesis
- **Action:** Applied code fix to use template literals for the `console.warn` diagnostic log.
- The logic implementation exactly matched the plan. `vscode.ConfigurationTarget.Global` is used, and the read-after-write verification is solid.

### Update
- **Files Modified:** `src/services/KanbanProvider.ts`
- **Validation:** Code compiled successfully using `npm run compile`. Logic appears perfectly aligned with plan requirements. No remaining risks for this isolated bug fix.
