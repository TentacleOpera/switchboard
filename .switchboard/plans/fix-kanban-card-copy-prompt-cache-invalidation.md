# Fix Kanban Card Copy Prompt Cache Invalidation

## Goal

The kanban card copy prompt buttons read stale cached prompt overrides instead of the latest values saved in the Prompts Tab. This plan fixes the cache invalidation gap so all card copy buttons always reflect current custom prompts.

## Metadata

- **Tags:** bugfix, reliability
- **Complexity:** 3

## User Review Required

None. This is a contained single-method fix with no breaking changes or API surface changes.

## Complexity Audit

### Routine

- Single-method change in one file (`saveRoleConfig` in `TaskViewerProvider.ts`)
- Cache rebuild calls the already-existing `_getDefaultPromptOverrides` — no new logic required
- The `roleConfig_` guard pattern matches existing key conventions
- Error handling follows the existing silent-suppression pattern used throughout the provider

### Complex / Risky

- None

## Edge-Case & Dependency Audit

### Race Conditions

- **Concurrent saves**: If the user saves multiple role configs in rapid succession, multiple cache rebuilds fire concurrently. The last write to `_cachedDefaultPromptOverrides` wins, which is deterministic and correct.
- **Prompts Tab open during save**: `handleGetDefaultPromptOverrides` and the new `saveRoleConfig` cache rebuild could race. Both read from the same source and produce the same result — no corruption possible.

### Security

- No security implications. This is a local in-memory cache of user-controlled prompt text.

### Side Effects

- `saveRoleConfig` gains an async I/O side effect (reading `state.json`). Mitigated by wrapping in try/catch so failures are silent (matching existing `_getDefaultPromptOverrides` error suppression).
- If `_getWorkspaceRoot()` returns `null` (e.g., during extension startup), the cache rebuild is skipped. The cache will be refreshed the next time the Prompts Tab is opened — this is acceptable degraded behavior.

### Dependencies & Conflicts

- The old `.switchboard/state.json` path (`handleSaveDefaultPromptOverrides`, line 6416) also updates the cache independently. The new fix is additive — it does not touch or conflict with that path.
- `_getDefaultPromptOverrides` (line 6014–6039) reads from both `state.json` and workspaceState/globalState, then merges. The rebuild correctly includes both sources.

## Dependencies

- None (no cross-plan dependencies)

## Adversarial Synthesis

Key risks: `_getDefaultPromptOverrides` does async filesystem I/O that could throw, and `_getWorkspaceRoot()` can return `null` during startup. Mitigations: wrap the cache rebuild in try/catch to swallow errors silently, and guard with a null-check on workspace root before attempting the rebuild. With these two additions the fix is production-safe.

## Problem Description

The kanban card copy prompt buttons (the buttons on individual cards like "Copy planning prompt", "Copy coder prompt", "Copy review prompt") do not reflect custom prompt overrides configured in the Prompts Tab. Even after saving custom prompts in the Prompts Tab, the copied prompts use the default prompts instead of the custom overrides.

This affects all roles (planner, lead, coder, reviewer, tester, intern, analyst, etc.), not just the planner role.

## Root Cause Analysis

The kanban card copy buttons use a cached version of the prompt overrides:

**Code path:**
1. Card button click → `copyPlanLink` message (kanban.html line 3908)
2. KanbanProvider → `switchboard.copyPlanFromKanban` command (KanbanProvider.ts line 5422)
3. TaskViewerProvider → `handleKanbanCopyPlan` → `_handleCopyPlanLink` (TaskViewerProvider.ts line 12366)
4. `_handleCopyPlanLink` calls `buildKanbanBatchPrompt` with `defaultPromptOverrides: this._cachedDefaultPromptOverrides` (TaskViewerProvider.ts line 12444)

**The cache invalidation gap:**
- `_cachedDefaultPromptOverrides` is a private field in TaskViewerProvider (line 316)
- It is only updated in two places:
  1. `handleGetDefaultPromptOverrides` (line 3016) - called when the Prompts Tab is opened
  2. `handleSaveDefaultPromptOverrides` (line 6416) - called when saving via the old `.switchboard/state.json` mechanism
- When users save custom prompts in the Prompts Tab UI, it calls `saveRoleConfig` (line 515-517)
- `saveRoleConfig` saves to workspaceState/globalState but **does not update the cache**
- The cache remains stale until the user reopens the Prompts Tab

**Why this happens:**
The Prompts Tab UI uses `saveRoleConfig` to persist role-specific prompts (e.g., `switchboard.prompts.roleConfig_planner`). This is separate from the old `.switchboard/state.json` mechanism. The cache was never updated to reflect this new save path.

## Proposed Changes

### `src/services/TaskViewerProvider.ts`

**Context:** `saveRoleConfig` is the sole write path for Prompts Tab role configs. It persists to workspaceState/globalState but never updates `_cachedDefaultPromptOverrides`, leaving card copy buttons reading stale data.

**Logic:** After persisting the setting, check if the key is a role config (prefix `roleConfig_`). If so, and if the workspace root is resolvable, rebuild the cache. Wrap in try/catch to mirror the existing silent-suppression pattern in `_getDefaultPromptOverrides`.

**Implementation:**

- **Location:** Line 515–517
- **Current code:**
  ```typescript
  public async saveRoleConfig(key: string, value: unknown): Promise<void> {
      await this.updateSetting(`switchboard.prompts.${key}`, value);
  }
  ```
- **Updated code:**
  ```typescript
  public async saveRoleConfig(key: string, value: unknown): Promise<void> {
      await this.updateSetting(`switchboard.prompts.${key}`, value);

      // Invalidate and rebuild the cached prompt overrides when a role config changes.
      // This ensures kanban card copy buttons reflect the latest custom prompts
      // without requiring the user to reopen the Prompts Tab.
      if (key.startsWith('roleConfig_')) {
          const workspaceRoot = this._getWorkspaceRoot();
          if (workspaceRoot) {
              try {
                  this._cachedDefaultPromptOverrides = await this._getDefaultPromptOverrides(workspaceRoot);
              } catch {
                  // Silently ignore — cache will be refreshed next time the Prompts Tab is opened
              }
          }
      }
  }
  ```

**Edge Cases:**
- `_getWorkspaceRoot()` returns `null` → skip rebuild (safe degraded behavior; cache refreshes on next Prompts Tab open)
- `_getDefaultPromptOverrides` throws (e.g., malformed `state.json`) → caught silently, cache unchanged
- Rapid concurrent saves → last assignment wins; deterministic and correct

## Verification Plan

### Automated Tests

- No automated tests currently cover this flow end-to-end. Manual verification is the primary path.

### Manual Verification Steps

1. Open the Kanban board
2. Open the Prompts Tab
3. Select a role (e.g., "coder")
4. Enter custom text in the prompt textarea
5. Click Save
6. **Without reopening the Prompts Tab**, click a kanban card in a column that uses that role (e.g., a card in CODE REVIEWED for reviewer, or PLAN REVIEWED for coder/lead)
7. Click the card's copy prompt button (e.g., "Copy coder prompt")
8. Paste the clipboard content
9. Verify the custom prompt text from the Prompts Tab is included in the pasted prompt
10. Repeat for different roles (planner, reviewer, tester, intern, analyst) to confirm the fix works across all roles

## Files Changed

- `src/services/TaskViewerProvider.ts` — Updated `saveRoleConfig` method (line 515) to rebuild `_cachedDefaultPromptOverrides` after persisting a role config, guarded by null-check and wrapped in try/catch

## Related Issues

This is related to the previous plan `unify-kanban-copy-prompts-to-prompts-tab.md`, which fixed the column header buttons but did not address the individual card copy buttons' cache invalidation issue.

---

**Recommendation:** Send to Intern

---

## Reviewer Pass (2026-05-23)

### Findings Summary

| Finding | Severity | Verdict |
|---|---|---|
| TOCTOU safety: `updateSetting` awaited before cache read — no race | Analysed safe | ✅ Keep |
| Plan comment says "workspaceState" but `globalSettingsEnabled` toggle exists — code is correct, comment mildly imprecise | NIT / doc | Defer |
| Legacy `handleSaveDefaultPromptOverrides` path doesn't include roleConfig overlay — pre-existing asymmetry, out of scope | NIT / pre-existing | No action |
| `workspaceRoot` from Kanban passed to `_getDefaultPromptOverrides` — safe because roleConfig reads via `getSetting()` which is workspace-agnostic when global | Analysed safe | ✅ Keep |
| Bindingless `catch {}` syntax — matches 50+ uses throughout the file, ES2022/TS4+ valid | NIT — conformant | ✅ Keep |

**Verdict: PASS. Zero CRITICAL, zero MAJOR findings. No code fixes required.**

### Fixed Items

None — implementation was correct as written.

### Files Changed

- `src/services/TaskViewerProvider.ts` — `saveRoleConfig` method at line 515, +14 lines added (cache rebuild block)

### Validation Results

```
npx tsc --noEmit
→ 2 pre-existing errors (import extension issues in ClickUpSyncService.ts, KanbanProvider.ts — unrelated)
→ 0 new errors introduced by this change
```

```
git diff HEAD -- src/services/TaskViewerProvider.ts
→ Exactly 14 lines added to saveRoleConfig, matching plan spec verbatim
→ No other files modified
```

### Remaining Risks

- **No automated test coverage** for this code path (acknowledged in plan). Manual verification per the steps in the Verification Plan is the only gate.
- **Legacy path is dead code**: The `handleSaveDefaultPromptOverrides` path (state.json via Setup Panel modal) is completely inaccessible — the modal exists but the button to open it (`btn-customize-default-prompts`) is missing from the HTML. The event listener uses optional chaining and silently fails to attach. Zero probability of user impact. This dead code should be removed in a future cleanup.
