# Fix Prompts Tab Add-on Preview/Dispatch Mismatch

## Goal
Fix the mismatch between the prompts tab preview and actual agent dispatch where add-on settings are not consistently applied, so the preview always shows what will actually be sent to the agent.

## Metadata
- **Tags:** [bugfix, frontend]
- **Complexity:** 4

## Problem
The prompts tab preview and actual agent dispatch use different code paths to read add-on settings, leading to inconsistent behavior:

- **Prompts tab preview** (`KanbanProvider.ts` case `'getPromptPreview'`): Uses `_getPromptsConfig()` which reads from workspaceState with specific fallback logic
- **Actual dispatch** (`TaskViewerProvider.ts` `_buildKanbanBatchPrompt()`): Uses dedicated getter methods (`_isAccurateCodingEnabled()`, `_isDependencyCheckEnabled()`) with different fallback logic

### Specific Issues Found

1. **Accuracy add-on fallback mismatch**:
   - `_getPromptsConfig()` defaults to `false` when not set (line 2305-2307)
   - `_isAccurateCodingEnabled()` defaults to `true` when not set (line 13995)
   - `package.json` declares `"default": true` for `accurateCoding.enabled` (line 219)
   - This causes the preview to show accuracy disabled while dispatch actually enables it
   - Accuracy should work like every other checkbox: default OFF, shows ON when the user switches it on

2. **Phantom config keys — advanced reviewer**:
   - `_getPromptsConfig()` reads `config.get<boolean>('advancedReviewer.enabled', false)` (line 2314) — WRONG key
   - `_isAdvancedReviewerEnabled()` reads `config.get<boolean>('reviewer.advancedMode', false)` (line 14002) — CORRECT key
   - `_savePromptsConfig()` writes to `config.update('advancedReviewer.enabled', ...)` (line 2591) — WRONG key
   - TaskViewerProvider writes to `config.update('reviewer.advancedMode', ...)` (line 6273) — CORRECT key
   - `package.json` declares `"switchboard.reviewer.advancedMode"` (line 227) — confirms correct key
   - Result: settings toggled from the Kanban prompts tab are written to a dead key and lost on reload

3. **Phantom config keys — lead challenge**:
   - `_getPromptsConfig()` reads `config.get<boolean>('leadChallenge.enabled', false)` (line 2315) — WRONG key
   - `_isLeadInlineChallengeEnabled()` reads `config.get<boolean>('leadCoder.inlineChallenge', false)` (line 14008) — CORRECT key
   - `_savePromptsConfig()` writes to `config.update('leadChallenge.enabled', ...)` (line 2594) — WRONG key
   - TaskViewerProvider writes to `config.update('leadCoder.inlineChallenge', ...)` (line 6280) — CORRECT key
   - `package.json` declares `"switchboard.leadCoder.inlineChallenge"` (line 222) — confirms correct key
   - Result: same dead-key problem as advanced reviewer

4. **Dependency check**: Both use similar logic and correct config key (`planner.dependencyCheckEnabled`), but the paths are different, creating maintenance burden and potential for drift

5. **All KanbanProvider dispatch paths affected**: `_getPromptsConfig()` is called from 13+ sites across KanbanProvider (preview handler, batch planner/execution/reviewer/tester prompt generation, single-card dispatch, etc.). The wrong defaults and config keys affect actual prompts sent to agents, not just the preview.

## Solution
Align both paths so accuracy defaults to OFF (like every other checkbox), and fix the phantom config keys so settings persist correctly. Specifically:
1. Change `_isAccurateCodingEnabled()` and `package.json` to default accuracy to `false` — so both preview and dispatch agree that accuracy is OFF by default
2. Fix `_getPromptsConfig()` and `_savePromptsConfig()` to use the correct config key names (`reviewer.advancedMode`, `leadCoder.inlineChallenge`) instead of phantom keys

## User Review Required
- None. Accuracy will now default to OFF in both preview and dispatch (matching every other checkbox). Users who previously relied on accuracy being silently enabled by the dispatch path will need to explicitly check the accuracy checkbox. This is the correct behavior — the checkbox should control the setting.

## Complexity Audit

### Routine
- Fixing config key strings in `_getPromptsConfig` (2 key renames)
- Fixing config key strings in `_savePromptsConfig` (2 key renames)
- Changing accuracy default in `_isAccurateCodingEnabled` from `true` to `false`
- Changing accuracy default in `package.json` from `true` to `false`
- These are straightforward string replacements with clear correct values

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions**: None. Config reads are synchronous VS Code API calls; writes are async but fire-and-forget. No concurrent modification risk beyond what already exists.
- **Security**: No security implications. These are user-facing boolean settings.
- **Side Effects**: Fixing the write-path config keys means settings saved from the Kanban prompts tab will now persist correctly across reloads. Previously they were written to phantom keys and lost — this is a pure improvement.
- **Dependencies & Conflicts**: The `_savePromptsConfig` write-path fix must use the same config keys as TaskViewerProvider's write path (lines 6273, 6280) to avoid the two providers writing to different keys. Both currently write on different triggers (Kanban prompts tab vs sidebar), so there's no direct conflict, but they must agree on key names.

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) changing the accuracy default from `true` to `false` in the dispatch path means accuracy mode will no longer be silently enabled for users who haven't explicitly toggled it — they must check the checkbox, (2) phantom config keys mean any values previously saved to `advancedReviewer.enabled` or `leadChallenge.enabled` are orphaned and won't be read after the fix. Mitigations: (1) this is the correct behavior — accuracy should work like every other checkbox (off by default, on when checked), (2) orphaned values in dead keys are harmless; users will need to re-toggle these settings once after the fix.

## Proposed Changes

### `src/services/TaskViewerProvider.ts` — `_isAccurateCodingEnabled` (line 13990)
- **Context**: This private method determines whether accuracy mode is enabled for dispatch. It currently defaults to `true`, which is inconsistent with every other checkbox defaulting to `false`.
- **Logic**: Change the fallback default from `true` to `false` so accuracy behaves like all other add-on checkboxes.
  - Line 13995: Change `config.get<boolean>('accurateCoding.enabled', true)` → `config.get<boolean>('accurateCoding.enabled', false)`
- **Implementation**: Direct string replacement.
- **Edge Cases**: Users who never explicitly set the accuracy setting will now have accuracy OFF by default in dispatch (matching the preview). Previously dispatch silently enabled it.

### `package.json` — `accurateCoding.enabled` declaration (line 217)
- **Context**: The VS Code setting declaration for accuracy coding. Currently declares `"default": true`.
- **Logic**: Change default to `false` to match the new runtime default.
  - Line 219: Change `"default": true` → `"default": false`
- **Implementation**: Direct string replacement.

### `src/services/KanbanProvider.ts` — `_getPromptsConfig` (line 2285)
- **Context**: This method reads add-on settings for all roles and returns a config object used by 13+ call sites.
- **Logic**: Fix the phantom config key names to match `package.json` declarations:
  - Line 2314: Change `config.get<boolean>('advancedReviewer.enabled', false)` → `config.get<boolean>('reviewer.advancedMode', false)` (matches `_isAdvancedReviewerEnabled` line 14002 and `package.json` key)
  - Line 2315: Change `config.get<boolean>('leadChallenge.enabled', false)` → `config.get<boolean>('leadCoder.inlineChallenge', false)` (matches `_isLeadInlineChallengeEnabled` line 14008 and `package.json` key)
- **Implementation**: Direct string replacement in the return object of `_getPromptsConfig`.
- **Edge Cases**: Users who previously saved values to `advancedReviewer.enabled` or `leadChallenge.enabled` via the Kanban prompts tab will have those values orphaned. The correct keys (`reviewer.advancedMode`, `leadCoder.inlineChallenge`) will be read with their actual stored values (likely unset/default). This is acceptable — the old values were never being read by the dispatch path anyway.

### `src/services/KanbanProvider.ts` — `_savePromptsConfig` (line 2584)
- **Context**: This method persists add-on setting changes from the Kanban prompts tab UI.
- **Logic**: Fix the config key names to match `package.json` declarations:
  - Line 2591: Change `config.update('advancedReviewer.enabled', ...)` → `config.update('reviewer.advancedMode', ...)`
  - Line 2594: Change `config.update('leadChallenge.enabled', ...)` → `config.update('leadCoder.inlineChallenge', ...)`
- **Implementation**: Direct string replacement.
- **Edge Cases**: After this fix, toggling these settings from the Kanban prompts tab will persist correctly. Previously saved values under the wrong keys remain in the user's settings.json but are harmless (they'll be ignored).

## Implementation Plan

### Step 1: Fix accuracy default in dispatch path
- In `src/services/TaskViewerProvider.ts`, method `_isAccurateCodingEnabled` (line 13990):
  - Line 13995: Change `true` → `false` in the config.get fallback
- In `package.json` (line 217):
  - Line 219: Change `"default": true` → `"default": false`

### Step 2: Fix phantom config keys in `_getPromptsConfig`
- In `src/services/KanbanProvider.ts`, method `_getPromptsConfig` (starting line 2285):
  - Line 2314: Change `advancedReviewer.enabled` → `reviewer.advancedMode`
  - Line 2315: Change `leadChallenge.enabled` → `leadCoder.inlineChallenge`

### Step 3: Fix phantom config keys in `_savePromptsConfig`
- In `src/services/KanbanProvider.ts`, method `_savePromptsConfig` (starting line 2584):
  - Line 2591: Change `advancedReviewer.enabled` → `reviewer.advancedMode`
  - Line 2594: Change `leadChallenge.enabled` → `leadCoder.inlineChallenge`

### Step 4: Verify the fix
- Verify that accuracy checkbox defaults to OFF in both preview and dispatch
- Verify that checking accuracy checkbox makes preview show ON and dispatch sends accuracy instructions
- Verify that checking/unchecking advanced reviewer checkbox in prompts tab persists across reload
- Verify that checking/unchecking lead challenge checkbox in prompts tab persists across reload
- Verify that the preview matches what is actually sent when dispatching

## Files to Modify
1. `src/services/TaskViewerProvider.ts` — Fix `_isAccurateCodingEnabled` default (line 13995)
2. `package.json` — Fix `accurateCoding.enabled` default (line 219)
3. `src/services/KanbanProvider.ts` — Fix `_getPromptsConfig` config keys (lines 2314-2315)
4. `src/services/KanbanProvider.ts` — Fix `_savePromptsConfig` config keys (lines 2591, 2594)

## Success Criteria
- Prompts tab preview accurately reflects the addon settings that will be applied during dispatch
- No mismatch between preview and actual agent prompts
- Accuracy checkbox defaults to OFF, shows ON when checked — in both preview and dispatch
- Advanced reviewer setting toggled from Kanban prompts tab persists correctly (writes to `reviewer.advancedMode`)
- Lead challenge setting toggled from Kanban prompts tab persists correctly (writes to `leadCoder.inlineChallenge`)
- Dependency checkbox state in preview matches actual dispatch behavior

## Verification Plan

### Automated Tests
- Existing test file `src/test/prompts-tab-move-regression.test.js` already validates config key names (lines 361-367). It checks for `leadCoder.inlineChallenge` and `reviewer.advancedMode` — these should continue to pass after the fix.
- No new automated tests required for this change; the fix is a string replacement that aligns KanbanProvider with already-tested TaskViewerProvider keys.

**Recommendation**: Send to Coder (Complexity 4)


## Review & Execution Results

### Stage 1 (Grumpy Review)
- **NIT**: The fix opts for simple string replacements in KanbanProvider.ts rather than refactoring to use a single shared getter method with TaskViewerProvider.ts. While this leaves a small amount of duplicated config-fetching logic, it minimizes the blast radius and perfectly addresses the problem described in the plan.
- **CRITICAL/MAJOR**: None. The changes exactly match the plan's requirements.

### Stage 2 (Balanced Synthesis)
- The implementation is completely accurate and correctly aligns the configuration keys across KanbanProvider, TaskViewerProvider, and package.json.
- The accuracy setting's default behavior is now correctly unified (false across the board).
- No code fixes were necessary.

### Files Modified
- src/services/TaskViewerProvider.ts
- package.json
- src/services/KanbanProvider.ts

### Validation Results
- Code inspection confirms that reviewer.advancedMode and leadCoder.inlineChallenge are now used consistently in both KanbanProvider and TaskViewerProvider.
- Code inspection confirms that accurateCoding.enabled defaults to false in both TaskViewerProvider and package.json.
- Automated test runs were explicitly skipped as per instructions, but existing UI tests (src/test/prompts-tab-move-regression.test.js) are logically expected to pass since the correct keys align with them.

### Remaining Risks
- Users who had explicitly turned on the orphaned configuration keys (advancedReviewer.enabled, leadChallenge.enabled) via the UI previously will need to re-toggle them, as their saved states won't automatically migrate to the new correct keys. This is considered acceptable as those settings were previously orphaned anyway.
