# Fix Planner Prompt in Prompts Tab to Use Simple Base Prompt

## Goal
Fix the planner role prompt so that the prompts tab and copy prompt buttons display the correct simple base prompt (`Read .agent/workflows/improve-plan.md and follow it step-by-step.`) instead of the long persona essay from `.agent/personas/planner.md`.

## Metadata
- **Tags:** [frontend, backend, bugfix]
- **Complexity:** 3

## User Review Required
- Confirm whether the persona essay from `planner.md` should be completely excluded from Kanban prompt generation, or appended as supplementary context after the base prompt.
- Confirm whether the same fix should be applied to other roles with specific base instructions (reviewer, tester, ticket_updater) that could also be overridden by persona content.

## Complexity Audit
### Routine
- Single-line change to `resolveBaseInstructions` in `agentPromptBuilder.ts` (swap `personaContent || defaultBase` to `defaultBase || personaContent`)
- Verify existing tests still pass
- Manual verification of prompts tab and copy prompt buttons

### Complex / Risky
- None

## Edge-Case & Dependency Audit
- **Race Conditions:** None. Persona file read is synchronous; no concurrent mutation risk.
- **Security:** Persona file content is local workspace data; no security implications.
- **Side Effects:** Swapping precedence in `resolveBaseInstructions` affects ALL roles that pass `personaContent`. Roles with empty `defaultBase` (lead, coder, intern, analyst) will still fall through to `personaContent` as before. Roles with specific `defaultBase` instructions (reviewer, tester, ticket_updater) will now correctly keep their specific instructions instead of being overridden by persona content — this is a positive side effect, not a regression.
- **Dependencies & Conflicts:** None. No other plans modify `agentPromptBuilder.ts`.

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) The original plan incorrectly claimed "Copy Prompt Buttons are CORRECT" — both paths are equally affected because both pass `personaContent`. (2) Swapping precedence in `resolveBaseInstructions` changes behavior for all roles, but only positively — roles with specific base instructions keep them; roles with empty bases still get persona content. Mitigations: The swap is safe because `defaultBase` is always role-specific and intentionally constructed; persona content is a generic fallback.

## Current State Analysis

### The Bug
The planner prompts tab AND copy prompt buttons display the 19-line persona essay from `.agent/personas/planner.md` instead of the simple base prompt (`Read .agent/workflows/improve-plan.md and follow it step-by-step.`).

### Root Cause (Confirmed)
`resolveBaseInstructions` in `agentPromptBuilder.ts` (line 113) uses this precedence:
```typescript
const base = options?.personaContent?.trim() || defaultBase;
```
When `personaContent` is non-empty (which it is — `.agent/personas/planner.md` exists with 19 lines), it **replaces** the role-specific `defaultBase` entirely. For the planner role, `defaultBase` is the correctly constructed `plannerBase` (the simple workflow reference), but the persona content overrides it.

### Affected Code Paths
All three Kanban prompt generation paths pass `personaContent` for the planner role:
1. **`_getDefaultPromptPreviews`** (KanbanProvider.ts line 2042-2045) — prompts tab preview on load
2. **`getPromptPreview` handler** (KanbanProvider.ts line 5389-5392) — prompts tab preview on refresh
3. **`_generateBatchPlannerPrompt`** (KanbanProvider.ts line 2213-2224) — copy prompt buttons

All three call `buildKanbanBatchPrompt` which calls `resolveBaseInstructions`, where the persona content replaces the simple base.

### Why Copy Prompt Buttons Are Also Broken
The original plan stated "Copy Prompt Buttons are CORRECT," but code analysis confirms `_generateBatchPlannerPrompt` passes `personaContent` at line 2224, so copy prompt buttons produce the same persona-essay prompt as the prompts tab.

## Proposed Changes

### `src/services/agentPromptBuilder.ts`
- **Context:** `resolveBaseInstructions` (line 107-122) determines the base instruction text for each role. Currently, `personaContent` takes precedence over `defaultBase`.
- **Logic:** Swap the precedence so that role-specific `defaultBase` always takes priority over generic `personaContent`. Persona content becomes a fallback for roles with empty/minimal bases.
- **Implementation:** Change line 113 from:
  ```typescript
  const base = options?.personaContent?.trim() || defaultBase;
  ```
  to:
  ```typescript
  const base = defaultBase || options?.personaContent?.trim();
  ```
- **Edge Cases:**
  - Roles with non-empty `defaultBase` (planner, reviewer, tester, ticket_updater): persona content is ignored; specific base instructions are preserved. This is the desired behavior.
  - Roles with empty `defaultBase` (lead, coder, intern, analyst): `defaultBase` is empty/falsy, so `personaContent` is used as before. No regression.
  - When `defaultPromptOverrides` exist: overrides are applied on top of the base regardless of which source the base came from. No change in override behavior.

## Verification Plan

### Automated Tests
- Run existing test suite: `src/test/prompts-tab-move-regression.test.js` — verify no regressions in prompts tab behavior.
- Add a unit test for `resolveBaseInstructions` verifying:
  1. When `defaultBase` is non-empty and `personaContent` is non-empty, `defaultBase` is used (not `personaContent`)
  2. When `defaultBase` is empty and `personaContent` is non-empty, `personaContent` is used
  3. When both are empty, empty string is returned
  4. Override modes (replace/prepend/append) still work correctly with the new precedence

### Manual Verification
1. Open the prompts tab in kanban.html and select planner role — verify preview shows `Read .agent/workflows/improve-plan.md and follow it step-by-step.`
2. Use a copy prompt button for planner — verify the generated prompt starts with the simple base, not the persona essay
3. Select other roles (lead, coder) — verify persona content still appears as base (no regression)
4. Test planner add-on checkboxes (dependency check, aggressive pair programming, etc.) — verify they append correctly to the simple base

## Scope
**Planner role only** — other roles (lead, coder, reviewer, etc.) will be investigated separately if their persona content incorrectly overrides their base instructions.

## Success Criteria
1. Planner prompts tab displays simple base prompt (workflow file + safeguards)
2. Planner copy prompt buttons generate the simple base prompt
3. Planner add-on checkboxes correctly append their instructions to the base
4. Planner prompts tab preview matches what copy prompt buttons generate
5. No planner persona content or long essays in the planner base prompt
6. No regression for other roles (lead, coder still use persona content as base)

## Reviewer Updates

### Stage 1 (Grumpy)
* **[CRITICAL] `lead` and `coder` Persona Data Loss in Pair Programming Mode**: You completely broke pair programming mode for the lead and coder roles! Your "fix" for planner assumes that `leadBase` and `coderBase` are *always* falsy when `defaultBase` is passed in, but wait! Lines 430 and 456 conditionally append instructions to `leadBase` and `coderBase`. When they do, `defaultBase` is no longer empty, it's truthy, and so your brilliant `defaultBase || options?.personaContent?.trim()` swallows the entire persona document! The lead and coder agents will wake up with pair programming instructions but NO idea who they are or what their persona is!
* **[MAJOR] Flawed Precedence Assumption**: The original assumption that `defaultBase` is static and role-defining while `personaContent` is fallback is demonstrably false. `defaultBase` for lead/coder acts as "dynamic add-ons", not "base". You need a way to combine them or explicitly differentiate roles that have a static base vs dynamic add-ons.

### Stage 2 (Balanced)
The fix was too simplistic. By changing the OR precedence, any dynamic content appended to an empty base suddenly overshadows the persona content.
To fix this, we need to explicitly initialize `leadBase` and `coderBase` with the persona content before dynamically appending add-ons. This preserves both the base persona and the dynamic instructions without getting swallowed by `resolveBaseInstructions`.

### Code Fixes Applied
- Updated `src/services/agentPromptBuilder.ts` to initialize `leadBase` and `coderBase` with `options?.personaContent?.trim() || ''` instead of `''`.
- Tested the pair programming conditionals.

### Validation Results
- `node src/test/prompts-tab-move-regression.test.js`: PASS
- `node src/test/agent-prompt-builder-subagents.test.js`: PASS
- The regression is fixed, and the original issue is fixed.

Send to Coder
