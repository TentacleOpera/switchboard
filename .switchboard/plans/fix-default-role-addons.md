# Fix Default Role Add-ons in sharedDefaults.js

## Goal
Update the default add-on configurations in `src/webview/sharedDefaults.js` so that `DEFAULT_ROLE_CONFIG` and `ROLE_ADDONS` defaults align with the desired role behaviors — disabling `useSubagents` and `includeDependencyInstructions` for most roles, enabling `cavemanOutput`/`skipCompilation`/`skipTests` for execution roles, and enabling `researchEnabled` for the researcher role.

## Problem
The default add-on configurations in `src/webview/sharedDefaults.js` do not match the desired defaults for various roles. Several roles have add-ons enabled by default that should be disabled, and some roles are missing add-ons that should be enabled.

## Solution
Update the `DEFAULT_ROLE_CONFIG` object **and** the `ROLE_ADDONS` `default` properties in `src/webview/sharedDefaults.js` to adjust the default add-on states for the following roles.

> **Important**: There are two sources of truth for addon defaults in this file:
> - `DEFAULT_ROLE_CONFIG` (lines 17-33) — provides the actual default values when no user config is saved
> - `ROLE_ADDONS` (lines 60-172) — provides `default` properties used as UI checkbox fallback when `roleConfigs[role]?.addons?.[addon.id]` is `undefined` (see `renderRoleAddons()` at line 2585: `const isChecked = roleConfigs[role]?.addons?.[addon.id] ?? addon.default`)
>
> Both must be updated in sync to avoid inconsistent UI behavior for existing users with saved configs.

### Changes Required

**planner**
- Change `useSubagents`: `true` → `false`

**lead**
- Change `includeDependencyInstructions`: `true` → `false`
- Change `useSubagents`: `true` → `false`
- Change `cavemanOutput`: `false` → `true`
- Change `skipCompilation`: `false` → `true`
- Change `skipTests`: `false` → `true`

**coder**
- Change `includeDependencyInstructions`: `true` → `false`
- Change `useSubagents`: `true` → `false`
- Change `cavemanOutput`: `false` → `true`
- Change `skipCompilation`: `false` → `true`
- Change `skipTests`: `false` → `true`

**intern**
- Change `includeDependencyInstructions`: `true` → `false`
- Change `useSubagents`: `true` → `false`
- Change `cavemanOutput`: `false` → `true`
- Change `skipCompilation`: `false` → `true`
- Change `skipTests`: `false` → `true`

**reviewer**
- Change `useSubagents`: `true` → `false`
- Change `skipCompilation`: `false` → `true`
- Change `skipTests`: `false` → `true`

**tester**
- Change `useSubagents`: `true` → `false`

**analyst**
- Change `useSubagents`: `true` → `false`

**ticket_updater**
- Change `useSubagents`: `true` → `false`

**researcher**
- Change `researchEnabled`: `false` → `true`
- Change `useSubagents`: `true` → `false`

**research_planner**
- Change `useSubagents`: `true` → `false`

## Metadata
- **Tags:** [frontend, bugfix]
- **Complexity:** 3

## User Review Required
- Confirm that disabling `useSubagents` by default across all roles is intentional (this changes the multi-plan parallel execution behavior)
- Confirm that enabling `cavemanOutput`/`skipCompilation`/`skipTests` for lead/coder/intern/reviewer is desired (these are token-saving defaults that may surprise users expecting full output)
- Confirm that enabling `researchEnabled` for researcher by default is correct

## Complexity Audit

### Routine
- Changing boolean values in a single configuration object (`DEFAULT_ROLE_CONFIG`)
- Changing `default` properties in the `ROLE_ADDONS` UI metadata array
- All changes are in one file (`src/webview/sharedDefaults.js`)
- No logic changes — only data value updates
- Pattern is repetitive: same set of changes applied across multiple roles

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions**: None — this is a static configuration object with no async operations
- **Security**: No security implications — these are UI/prompt configuration defaults
- **Side Effects**: Users with existing saved role configs will NOT be affected (their saved settings persist). Only fresh installs or role resets will pick up the new defaults. The `ROLE_ADDONS[].default` values serve as fallback for missing keys in saved configs, so updating them ensures consistency for existing users too.
- **Dependencies & Conflicts**: Test files reference these defaults and may need assertion updates:
  - `src/test/agent-prompt-builder-subagents.test.js` — references `useSubagents` defaults
  - `src/test/kanban-default-prompt-previews.test.js` — references default prompt previews
  - `src/services/__tests__/agentPromptBuilder.test.ts` — references addon defaults

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) `ROLE_ADDONS` defaults must be updated in sync with `DEFAULT_ROLE_CONFIG` or the UI will show stale fallback values for existing users with saved configs missing new addon keys. (2) Test files that assert old default values will fail and need assertion updates. Mitigations: Both sources of truth are in the same file, making synchronized edits straightforward. Test updates are mechanical and scoped.

## Proposed Changes

### src/webview/sharedDefaults.js

**Context**: This file defines two configuration objects that control role addon defaults. `DEFAULT_ROLE_CONFIG` (lines 17-33) provides the actual default values used at runtime. `ROLE_ADDONS` (lines 60-172) provides UI metadata including `default` properties for checkbox rendering.

**Logic**: Change boolean values in both objects to align with desired defaults. All changes are value substitutions — no structural changes, no new keys, no key removals.

**Implementation**:

#### Part A: DEFAULT_ROLE_CONFIG (lines 17-33)

| Role | Key | Old Value | New Value | Line |
|------|-----|-----------|-----------|------|
| planner | `useSubagents` | `true` | `false` | 20 |
| lead | `includeDependencyInstructions` | `true` | `false` | 22 |
| lead | `useSubagents` | `true` | `false` | 22 |
| lead | `cavemanOutput` | `false` | `true` | 22 |
| lead | `skipCompilation` | `false` | `true` | 22 |
| lead | `skipTests` | `false` | `true` | 22 |
| coder | `includeDependencyInstructions` | `true` | `false` | 23 |
| coder | `useSubagents` | `true` | `false` | 23 |
| coder | `cavemanOutput` | `false` | `true` | 23 |
| coder | `skipCompilation` | `false` | `true` | 23 |
| coder | `skipTests` | `false` | `true` | 23 |
| reviewer | `useSubagents` | `true` | `false` | 24 |
| reviewer | `skipCompilation` | `false` | `true` | 24 |
| reviewer | `skipTests` | `false` | `true` | 24 |
| tester | `useSubagents` | `true` | `false` | 25 |
| intern | `includeDependencyInstructions` | `true` | `false` | 26 |
| intern | `useSubagents` | `true` | `false` | 26 |
| intern | `cavemanOutput` | `false` | `true` | 26 |
| intern | `skipCompilation` | `false` | `true` | 26 |
| intern | `skipTests` | `false` | `true` | 26 |
| analyst | `useSubagents` | `true` | `false` | 27 |
| ticket_updater | `useSubagents` | `true` | `false` | 28 |
| researcher | `researchEnabled` | `false` | `true` | 29 |
| researcher | `useSubagents` | `true` | `false` | 29 |
| research_planner | `useSubagents` | `true` | `false` | 31 |

#### Part B: ROLE_ADDONS default properties (lines 60-172)

| Role | Addon ID | Old default | New default | Line |
|------|----------|-------------|-------------|------|
| planner | `useSubagents` | `true` | `false` | 70 |
| lead | `includeDependencyInstructions` | `true` | `false` | 83 |
| lead | `cavemanOutput` | `false` | `true` | 79 |
| lead | `skipCompilation` | `false` | `true` | 81 |
| lead | `skipTests` | `false` | `true` | 82 |
| lead | `useSubagents` | `true` | `false` | 84 |
| coder | `includeDependencyInstructions` | `true` | `false` | 96 |
| coder | `cavemanOutput` | `false` | `true` | 92 |
| coder | `skipCompilation` | `false` | `true` | 94 |
| coder | `skipTests` | `false` | `true` | 95 |
| coder | `useSubagents` | `true` | `false` | 97 |
| reviewer | `skipCompilation` | `false` | `true` | 105 |
| reviewer | `skipTests` | `false` | `true` | 106 |
| reviewer | `useSubagents` | `true` | `false` | 107 |
| tester | `useSubagents` | `true` | `false` | 114 |
| intern | `includeDependencyInstructions` | `true` | `false` | 126 |
| intern | `cavemanOutput` | `false` | `true` | 122 |
| intern | `skipCompilation` | `false` | `true` | 124 |
| intern | `skipTests` | `false` | `true` | 125 |
| intern | `useSubagents` | `true` | `false` | 127 |
| analyst | `useSubagents` | `true` | `false` | 134 |
| ticket_updater | `useSubagents` | `true` | `false` | 142 |
| researcher | `researchEnabled` | `false` | `true` | 147 |
| researcher | `useSubagents` | `true` | `false` | 149 |
| research_planner | `useSubagents` | `true` | `false` | 164 |

**Edge Cases**:
- Planner role uses custom checkbox rendering (kanban.html lines 2540-2553) instead of `renderRoleAddons()`, but `ROLE_ADDONS.planner` still needs its `useSubagents` default updated for consistency
- `gatherer` and `splitter` roles are NOT changed by this plan (they already lack the relevant addon keys or don't need changes)
- `jules` role is NOT in `DEFAULT_ROLE_CONFIG` and is not affected

## Verification Plan

### Automated Tests
- **Note**: Per session directives, automated tests are NOT run as part of this plan. The following is for reference when tests are run separately:
  - `src/test/agent-prompt-builder-subagents.test.js` — may need assertion updates for `useSubagents` default changes
  - `src/test/kanban-default-prompt-previews.test.js` — may need updates for changed default prompt previews
  - `src/services/__tests__/agentPromptBuilder.test.ts` — may need updates for addon default assertions

### Manual Verification
- Open the Switchboard webview and navigate to the Prompts tab
- For each modified role, verify that the addon checkboxes reflect the new defaults when no saved config exists
- Reset a role config to defaults and verify the checkboxes match the expected state
- Verify that the `DEFAULT_ROLE_CONFIG` object syntax remains valid (no trailing commas, no duplicate keys)
- Verify that `ROLE_ADDONS` entries still render correctly in the UI

## Files Changed
- `src/webview/sharedDefaults.js`

## Recommendation
**Send to Intern** — Complexity 3: single-file, configuration-only changes with clear before/after values. No logic changes, no architectural impact.

---
## Review & Verification

### Grumpy Principal Engineer Review (Stage 1)
WHAT IS THIS?! An implementation that actually matches the plan? Did the intern hit their head and accidentally become competent? I've scoured every single boolean flag in this defaults file, ready to rip into whoever forgot to sync `DEFAULT_ROLE_CONFIG` with `ROLE_ADDONS`. But no! The checkboxes align, the underlying default values align, and the syntax isn't even broken. I'm taking away your coffee rights just so you don't get arrogant.

**Findings:**
- None. (I'm watching you, though.)

### Balanced Synthesis (Stage 2)
The implementation accurately reflects the plan's requirements. Both `DEFAULT_ROLE_CONFIG` and `ROLE_ADDONS` have been properly synchronized.

- **Files verified**: `src/webview/sharedDefaults.js`
- **Validation results**: Code logic and data structures match requirements.
- **Remaining risks**: We skipped running tests per instructions, so test suites mentioning these default flags will need to be manually updated when test execution is allowed.
