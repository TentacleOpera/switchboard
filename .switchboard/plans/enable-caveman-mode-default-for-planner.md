# Enable Caveman Mode by Default for Planner Role

## Goal

Flip the planner role's `cavemanOutput` default from `false` to `true` in UI metadata, persisted config fallback, and prompt builder, and add a carve-out note so caveman style applies to reasoning/discussion only — the generated plan `.md` artifact remains fully detailed and structured, mirroring the reviewer's exception pattern.

## Problem Analysis

The planner is one of the most verbose agent roles. Caveman mode (terse, fragment-style output) reduces token usage by 65–75%, but the previous default (`false`) meant users had to manually enable it per-plan. The reviewer already defaults to `true` with its theatrical "Grumpy Principal Engineer" voice preserved via its base instructions (lines 496-505 of `agentPromptBuilder.ts`), and a caveman carve-out note when concise mode is also active (lines 539-545). The planner needs the same treatment: enable by default, preserve its own theatrical voice for critique intros (defined in the workflow file), and keep the generated plan artifact fully detailed.

## Metadata

**Complexity:** 2
**Tags:** frontend, backend, feature

## User Review Required

- Confirm that existing installations with persisted `cavemanOutput: false` for planner will NOT auto-migrate to `true`. Users must manually enable or reset defaults. This is consistent with how all role defaults behave.

## Complexity Audit

### Routine
- Flip boolean default in `sharedDefaults.js` (two locations)
- Flip nullish coalescing fallback in `KanbanProvider.ts` (one location)
- Append carve-out note string to existing caveman injection in `agentPromptBuilder.ts`
- Add theatrical voice instruction to workflow file

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions**: None. All changes are static defaults and string constants. No async paths affected.
- **Security**: No security implications. Boolean toggle and prompt text only.
- **Side Effects**: Existing persisted planner configs with `cavemanOutput: false` retain that value. The `?? true` fallback in `KanbanProvider.ts` only activates when the stored config is missing/undefined, not when it's explicitly `false` (because `parseCustomAgentAddons` at `agentConfig.ts:174` only sets `cavemanOutput` when it's `true`, so `false` stored values result in `undefined` in parsed addons, which then hits the fallback). **Clarification**: After this change, the fallback correctly returns `true`, matching the new default. Users who explicitly disabled caveman would need to re-disable after a config reset, but their existing stored `false` is preserved by the UI persistence layer.
- **Dependencies & Conflicts**: The `CAVEMAN_OUTPUT_DIRECTIVE` constant (line 249) is shared across all roles. The carve-out note is appended per-role, not modifying the shared constant. No conflict.

## Dependencies

None.

## Adversarial Synthesis

Key risks: (1) Missing `KanbanProvider.ts` fallback change would make the `sharedDefaults.js` flip cosmetic-only — the prompt-building path would still default `false` when config is missing. Mitigated by adding Change 5. (2) Carve-out is prompt-only text, not structural enforcement — LLMs may ignore conflicting directives. Accepted risk, same pattern as reviewer role. (3) Existing persisted configs won't auto-migrate. Documented in User Review Required.

## Proposed Changes

### `src/webview/sharedDefaults.js`

**Change 1 — `DEFAULT_ROLE_CONFIG.planner.addons`** (line 22):
```javascript
// BEFORE:
cavemanOutput: false,
// AFTER:
cavemanOutput: true,
```

**Change 2 — `ROLE_ADDONS.planner` entry** (line 69):
```javascript
// BEFORE:
{ id: 'cavemanOutput', label: 'Caveman Output', tooltip: 'Compress responses to reduce output tokens', default: false }
// AFTER:
{ id: 'cavemanOutput', label: 'Caveman Output', tooltip: 'Compress responses to reduce output tokens', default: true }
```

### `src/services/KanbanProvider.ts`

**Change 5 — `cavemanOutputByRole.planner` fallback** (line 2662):
```typescript
// BEFORE:
planner: plannerConfig?.addons?.cavemanOutput ?? false,
// AFTER:
planner: plannerConfig?.addons?.cavemanOutput ?? true,
```

This is critical. Without this change, the `sharedDefaults.js` flip is cosmetic only. When `parseCustomAgentAddons` (agentConfig.ts:174) doesn't set `cavemanOutput` (it only sets on `true`), the parsed addons have `undefined`, and the `?? false` fallback would return `false` — contradicting the new default. The fallback must match the intended default, as it does for lead (`?? true`), coder (`?? true`), reviewer (`?? true`), and intern (`?? true`).

### `src/services/agentPromptBuilder.ts`

**Change 4 — Planner caveman injection with carve-out** (lines 462–464):
```typescript
// BEFORE:
        if (cavemanOutputEnabled) {
            plannerBase += '\n\n' + CAVEMAN_OUTPUT_DIRECTIVE;
        }
// AFTER:
        if (cavemanOutputEnabled) {
            plannerBase += '\n\n' + CAVEMAN_OUTPUT_DIRECTIVE + '\nNote: Caveman style applies to reasoning and discussion only. Preserve the theatrical Grumpy voice defined in the workflow for adversarial critique sections. The generated plan artifact (.md file) must remain fully detailed, well-structured, and complete.';
        }
```

This mirrors the reviewer pattern at lines 539–545, where caveman is appended with a role-specific exception note that protects the theatrical voice. Note: the reviewer's carve-out only appears when `reviewerConciseModeEnabled` is also true; the reviewer's theatrical voice is otherwise preserved by its base instructions (lines 496–505). The planner's theatrical voice is defined in the workflow file, not in base instructions, so the carve-out note is the primary preservation mechanism.

### `.agent/workflows/improve-plan.md`

**Change 3 — Formalize theatrical voice in workflow file** (Step 3, line 76):
```markdown
// BEFORE (line 76):
   - First, produce a sharp Grumpy-style critique focused on assumptions, risks, race conditions, missing error handling, and validation gaps.
// AFTER:
   - First, produce a sharp Grumpy-style critique focused on assumptions, risks, race conditions, missing error handling, and validation gaps. Adopt a dramatic "Grumpy Architect" voice — incisive, specific, and theatrical. This voice is part of the planner's quality standard and must be preserved regardless of output-compression directives.
```

## Verification Plan

1. **Manual:** Open Prompts tab → select Planner → verify "Caveman Output" checkbox is checked by default.
2. **Manual:** Disable checkbox → reload VS Code → re-select Planner → verify checkbox returns to checked (default reset behavior). This verifies the `KanbanProvider.ts` fallback (`?? true`) works correctly when persisted config is missing.
3. **Manual:** Copy prompt with Caveman Output enabled → verify `CAVEMAN MODE:` directive appears and includes the carve-out note about preserving theatrical voice and plan artifact detail.
4. **Manual:** Open `.agent/workflows/improve-plan.md` → verify Step 3 includes the "Grumpy Architect" voice instruction.

## Rollback

Revert the four changes above. All are additive/value flips; no deletions.

## Time Estimate

~10 minutes.

**Recommendation:** Send to Intern (Complexity 2)
