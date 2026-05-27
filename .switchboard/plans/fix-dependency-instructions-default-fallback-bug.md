# Fix Dependency Instructions Default Fallback Bug

## Goal
Fix the bug where dependency instructions are being injected into coder prompts despite NOT being selected in the kanban.html prompt builder.

## Metadata
- **Tags:** [bugfix, frontend]
- **Complexity:** 2

## User Review Required
No — the fix is a straightforward alignment of fallback values with documented defaults. No design decisions required.

## Current State
The dependency instruction "DEPENDENCY ORDER: Execute in order; do not start a plan until its dependencies are implemented:" appears in coder prompts even when the "Include Dependency Instructions" checkbox is unchecked in the prompt builder UI.

## Root Cause
In `src/services/KanbanProvider.ts`, the fallback value for `includeDependencyInstructions` is set to `true` when the configuration value is undefined:

```typescript
includeDependencyInstructions: (role === 'lead' || role === 'coder' || role === 'intern')
    ? (promptsConfig.includeDependencyInstructionsByRole?.[role as any] ?? true)
    : undefined,
```

However, in `src/webview/sharedDefaults.js`, the default value for `includeDependencyInstructions` is explicitly set to `false` for all roles:

```javascript
lead: { prompt: '', addons: { ..., includeDependencyInstructions: false } },
coder: { prompt: '', addons: { ..., includeDependencyInstructions: false } },
intern: { prompt: '', addons: { ..., includeDependencyInstructions: false } },
```

This mismatch causes the dependency instructions to be injected by default, ignoring the user's checkbox selection in the UI.

## Complexity Audit

### Routine
- Changing `?? true` to `?? false` in 9 locations within a single file
- All changes are fallback value adjustments, no logic changes
- Pattern is consistent with every other addon in the same file (e.g., `suppressWalkthroughByRole` uses `?? false` at lines 2398-2400)

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None — this is a static fallback value, not a concurrent state.
- **Security:** No security implications.
- **Side Effects:** Changing the fallback from `true` to `false` means that when `promptsConfig.includeDependencyInstructionsByRole` is not populated from user config, dependency instructions will no longer be injected. This is the *intended* behavior per `sharedDefaults.js`.
- **Dependencies & Conflicts:** The `sharedDefaults.js` file (lines 22-26, 83, 96, 126) already defines `includeDependencyInstructions: false` as the default for lead, coder, and intern roles. The `ROLE_ADDONS` UI metadata (lines 83, 96, 126) also specifies `default: false`. The KanbanProvider.ts fallbacks are the sole inconsistency.

## Dependencies
None — this is an isolated bug fix with no cross-plan dependencies.

## Adversarial Synthesis
Key risks: The original plan missed 3 of 9 occurrences (lines 2403-2405), which are the upstream construction of `promptsConfig.includeDependencyInstructionsByRole` and the actual root cause. Mitigations: All 9 occurrences are now enumerated with exact line numbers; the fix is a trivial `true`→`false` change consistent with every other addon's fallback pattern.

## Affected Locations
The incorrect fallback `?? true` appears in **9 locations** in `src/services/KanbanProvider.ts`:

**Upstream construction** (building `promptsConfig.includeDependencyInstructionsByRole`):
- Line 2403: `leadConfig?.addons?.includeDependencyInstructions ?? true`
- Line 2404: `coderConfig?.addons?.includeDependencyInstructions ?? true`
- Line 2405: `internConfig?.addons?.includeDependencyInstructions ?? true`

**Downstream reads** (consuming `promptsConfig.includeDependencyInstructionsByRole`):
- Line 2205: `promptsConfig.includeDependencyInstructionsByRole?.[role as any] ?? true` (batch dispatch preview)
- Line 2686: `promptsConfig.includeDependencyInstructionsByRole?.[role] ?? true` (dispatch with pair programming)
- Line 2725: `promptsConfig.includeDependencyInstructionsByRole?.coder ?? true` (coder prompt in pair programming)
- Line 5438: `promptsConfig.includeDependencyInstructionsByRole?.lead ?? true` (lead prompt in pair programming)
- Line 5455: `promptsConfig.includeDependencyInstructionsByRole?.coder ?? true` (coder prompt in pair programming)
- Line 5913: `promptsConfig.includeDependencyInstructionsByRole?.[role as any] ?? true` (batch dispatch)

## Fix Plan
Change all occurrences of `?? true` to `?? false` for `includeDependencyInstructions` in `src/services/KanbanProvider.ts` to match the default configuration in `sharedDefaults.js`.

## Implementation Steps
1. Open `src/services/KanbanProvider.ts`
2. Search for all occurrences of `includeDependencyInstructionsByRole?.[role as any] ?? true`
   - Line 2205: Replace with `includeDependencyInstructionsByRole?.[role as any] ?? false`
   - Line 5913: Replace with `includeDependencyInstructionsByRole?.[role as any] ?? false`
3. Search for all occurrences of `includeDependencyInstructionsByRole?.coder ?? true`
   - Line 2725: Replace with `includeDependencyInstructionsByRole?.coder ?? false`
   - Line 5455: Replace with `includeDependencyInstructionsByRole?.coder ?? false`
4. Search for all occurrences of `includeDependencyInstructionsByRole?.lead ?? true`
   - Line 5438: Replace with `includeDependencyInstructionsByRole?.lead ?? false`
5. Search for all occurrences of `includeDependencyInstructionsByRole?.[role] ?? true`
   - Line 2686: Replace with `includeDependencyInstructionsByRole?.[role] ?? false`
6. Search for all occurrences of `addons?.includeDependencyInstructions ?? true`
   - Line 2403: Replace with `addons?.includeDependencyInstructions ?? false`
   - Line 2404: Replace with `addons?.includeDependencyInstructions ?? false`
   - Line 2405: Replace with `addons?.includeDependencyInstructions ?? false`
7. Verify no remaining `includeDependencyInstructions` occurrences use `?? true`

## Proposed Changes

### src/services/KanbanProvider.ts
- **Context:** The `includeDependencyInstructions` fallback values are inconsistent with `sharedDefaults.js` and all other addon fallbacks in the same file.
- **Logic:** Change 9 occurrences of `?? true` to `?? false` for `includeDependencyInstructions`-related expressions.
- **Implementation:** Simple find-and-replace. No logic changes, no new code paths.
- **Edge Cases:** If `promptsConfig.includeDependencyInstructionsByRole` is entirely undefined (no user config loaded), the fallback chain now correctly defaults to `false` instead of `true`.

## Verification Plan

### Automated Tests
- SKIP (per session directive)

### Manual Verification
1. Open the kanban.html prompt builder
2. Uncheck "Include Dependency Instructions" for the coder role
3. Generate a coder prompt
4. Verify that the "DEPENDENCY ORDER" section does NOT appear in the generated prompt
5. Check the "Include Dependency Instructions" checkbox for the coder role
6. Generate a coder prompt
7. Verify that the "DEPENDENCY ORDER" section DOES appear in the generated prompt when plans have dependencies
8. Repeat steps 2-7 for the lead and intern roles
9. Verify with a fresh workspace (no saved config) that dependency instructions are NOT included by default

## Files Changed
- `src/services/KanbanProvider.ts`

## Risk Assessment
Low risk. This change aligns the fallback behavior with the documented default configuration in `sharedDefaults.js`. The change only affects the default behavior when the configuration is explicitly undefined, which should be rare in normal usage.

## Recommendation
**Send to Intern** — Complexity 2: trivial single-file fallback value change with no logic modifications.
