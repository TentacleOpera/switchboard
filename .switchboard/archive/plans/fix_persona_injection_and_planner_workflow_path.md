# Fix: Remove Persona Injection from Kanban Prompts and Restore Planner Workflow Path

## Goal
Remove persona file content injection from Kanban prompt generation and ensure the planner workflow path appears correctly in planner prompts.

## Metadata
- **Tags:** bugfix, workflow, security
- **Complexity:** 4

## User Review Required
No

## Complexity Audit
### Routine
- Remove `getPersonaForRole()` calls from KanbanProvider.ts (8 call sites)
- Set `personaContent: undefined` in all `buildKanbanBatchPrompt` calls in KanbanProvider.ts
- Remove `getPersonaForRole()` call and set `personaContent: undefined` in TaskViewerProvider.ts (1 call site)
- Remove `personaContent` field from `PromptBuilderOptions` interface
- Simplify `resolveBaseInstructions()` to remove personaContent branch
- Update 3 test files to remove personaContent-dependent tests
- Run existing test suite

### Complex / Risky
- Lead and coder roles currently use `options?.personaContent` as their ONLY base instructions (agentPromptBuilder.ts lines 443, 479) — after removing personaContent, these roles need replacement base instructions or the prompts will have empty base instruction blocks
- `agent-prompt-builder-subagents.test.js` has a `testResolveBaseInstructions()` function (lines 299-345) that tests personaContent precedence — some assertions may already be incorrect vs. current code behavior

## Edge-Case & Dependency Audit
- **Race Conditions:** None
- **Security:** Persona files may contain PII or sensitive information — removing injection prevents accidental exposure in prompts
- **Side Effects:** Persona files will no longer appear in Kanban prompts (this is the intended behavior). Lead and coder prompts will lose persona-derived base instructions and need replacement defaults.
- **Dependencies & Conflicts:** The `getPersonaForRole` webview message handler (KanbanProvider.ts lines 5505-5512) and terminal dispatch path (`_resolvePersona` / `_formatPersonaMessage` in TaskViewerProvider.ts lines 15287-15294) must be preserved — they serve different purposes (UI display and terminal `---PERSONA---` wrapping).

## Dependencies
None

## Adversarial Synthesis
Key risks: (1) Lead/coder roles lose all base instructions when personaContent is removed, producing structurally degraded prompts. (2) Dead `personaContent` field and `resolveBaseInstructions` branch remain in the interface, inviting future re-introduction. (3) Two test files not mentioned in original plan will break or test dead functionality. Mitigations: Provide hardcoded default base instructions for lead/coder; remove `personaContent` from `PromptBuilderOptions` and simplify `resolveBaseInstructions`; update all 3 test files; broaden verification to cover all affected test suites.

## Problem Statement

### Issue 1: Persona Information Being Injected into Kanban Prompts
The current code fetches persona file content via `getPersonaForRole()` and passes it to `buildKanbanBatchPrompt` in multiple locations throughout KanbanProvider.ts (lines 2078, 2258, 2309, 2346, 2541, 2571, 5484, 5867) and TaskViewerProvider.ts (line 5963). This persona content is then used as base instructions in the prompt via `resolveBaseInstructions()`:

```typescript
const base = options?.personaContent?.trim() || defaultBase;
```

This is incorrect. Persona files are meant to be linked reference documents, not content to be injected into agent prompts. Persona files may contain PII or sensitive information that should not be exposed in Kanban batch operations.

### Issue 2: Planner Workflow Path Not Appearing in Prompts
Because personaContent takes precedence over defaultBase in `resolveBaseInstructions()`, the planner workflow path reference is being overridden. The planner base instruction should be:

```typescript
let plannerBase = `Read ${workflowPath} and follow it step-by-step.\n\n`;
```

But when personaContent is provided, it completely replaces this base, removing the workflow path reference entirely.

### Issue 3: Lead and Coder Roles Have No Hardcoded Default Base
The lead and coder roles in `buildKanbanBatchPrompt` use personaContent as their sole base instructions:

```typescript
// Line 443 (lead):
let leadBase = options?.personaContent?.trim() || '';
// Line 479 (coder):
let coderBase = options?.personaContent?.trim() || '';
```

Unlike planner, reviewer, and tester which have meaningful hardcoded defaults, lead and coder fall back to an empty string. After removing personaContent, these roles need replacement base instructions.

## Root Cause

The `resolveBaseInstructions()` function prioritizes personaContent over the role-specific defaultBase:

```typescript
const base = options?.personaContent?.trim() || defaultBase;
```

Since KanbanProvider.ts and TaskViewerProvider.ts fetch and pass personaContent in multiple locations, persona file content is being injected into Kanban prompts and overriding role-specific instructions like the planner workflow path.

Additionally, the lead and coder roles were designed to rely on personaContent as their primary base instructions, with no hardcoded fallback — making the persona injection not just a security issue but a structural dependency for these roles.

## Proposed Changes

### `src/services/agentPromptBuilder.ts`

1. **Line 100** — Remove `personaContent` field from `PromptBuilderOptions` interface:
   - Delete: `personaContent?: string;` and its JSDoc comment (line 99)

2. **Line 117** — Simplify `resolveBaseInstructions()` to remove personaContent branch:
   - Change: `const base = options?.personaContent?.trim() || defaultBase;`
   - To: `const base = defaultBase;`
   - This ensures the defaultBase (role-specific instructions) is always used

3. **Lines 443-444** — Replace personaContent-derived base for lead role with hardcoded default:
   - Change: `let leadBase = options?.personaContent?.trim() || '';`
   - To: `let leadBase = '';`
   - **Clarification**: Lead role has no meaningful hardcoded base instructions — the role framing comes from the intro text, execution directive, and safeguards. An empty base is acceptable and matches the intern/analyst pattern. The pair programming add-on is appended conditionally below.

4. **Lines 479-480** — Replace personaContent-derived base for coder role with hardcoded default:
   - Change: `let coderBase = options?.personaContent?.trim() || '';`
   - To: `let coderBase = '';`
   - **Clarification**: Same as lead — coder role framing comes from intro, execution directive, safeguards, and the accuracy instruction add-on. Empty base is acceptable.

### `src/services/KanbanProvider.ts`

Remove all `getPersonaForRole()` calls and set `personaContent: undefined` in all `buildKanbanBatchPrompt` calls:

1. **Line 2078** (_getDefaultPromptPreviews):
   - Remove: `const personaContent = await this._taskViewerProvider?.getPersonaForRole(role);`
   - Remove: `personaContent: personaContent?.trim() || undefined,` from options object

2. **Line 2258** (_generateBatchPlannerPrompt):
   - Remove: `const personaContent = await this._taskViewerProvider?.getPersonaForRole('planner');`
   - Remove: `personaContent: personaContent?.trim() || undefined,` from options object

3. **Line 2309** (_generateBatchExecutionPrompt):
   - Remove: `const personaContent = await this._taskViewerProvider?.getPersonaForRole(role);`
   - Remove: `personaContent: personaContent?.trim() || undefined,` from options object

4. **Line 2346** (_generateBatchCoderPrompt):
   - Remove: `const coderPersonaContent = await this._taskViewerProvider?.getPersonaForRole('coder');`
   - Remove: `personaContent: coderPersonaContent?.trim() || undefined,` from options object

5. **Line 2541** (_generateBatchReviewerPrompt):
   - Remove: `const personaContent = await this._taskViewerProvider?.getPersonaForRole('reviewer');`
   - Remove: `personaContent: personaContent?.trim() || undefined,` from options object

6. **Line 2571** (_generateBatchGenericRolePrompt):
   - Remove: `const personaContent = await this._taskViewerProvider?.getPersonaForRole(role);`
   - Remove: `personaContent: personaContent?.trim() || undefined,` from options object

7. **Line 5484** (getPromptPreview handler):
   - Remove: `const personaContent = await this._taskViewerProvider?.getPersonaForRole(role);`
   - Remove: `personaContent: personaContent?.trim() || undefined,` from options object

8. **Line 5867** (_generateBatchTesterPrompt):
   - Remove: `const personaContent = await this._taskViewerProvider?.getPersonaForRole('tester');`
   - Remove: `personaContent: personaContent?.trim() || undefined,` from options object

**PRESERVE** the `getPersonaForRole` webview message handler at lines 5505-5512 — this serves a different purpose (returning persona content to the UI for display) and is NOT related to prompt injection.

### `src/services/TaskViewerProvider.ts`

1. **Line 5963** (_buildKanbanBatchPrompt):
   - Remove: `const personaContent = await this.getPersonaForRole(role);`
   - Remove: `personaContent: personaContent?.trim() || undefined,` from options object

**PRESERVE** the `getPersonaForRole` public method (line 15283) and `_resolvePersona` / `_formatPersonaMessage` methods (lines 15287-15294) — these are used for terminal agent dispatch via the `---PERSONA---` wrapper, which is a separate and correct use of persona content.

### `src/services/__tests__/agentPromptBuilder.test.ts`

Remove or update the personaContent-dependent tests in the `buildKanbanBatchPrompt — personaContent & overrides` suite (lines 66-186):

- **Lines 67-85**: Tests for `clearAntigravityContext` — **KEEP** (no personaContent dependency)
- **Lines 87-97**: "uses personaContent as base instructions when no override exists" — **DELETE** (tests personaContent injection)
- **Lines 99-112**: "replace override takes precedence over personaContent" — **DELETE** (tests personaContent with overrides)
- **Lines 114-124**: "replace mode preserves role framing" — **KEEP** (doesn't use personaContent, already tests with defaultBase)
- **Lines 126-134**: "falls back to hardcoded default when personaContent is empty string" — **DELETE** (tests personaContent fallback)
- **Lines 136-145**: "falls back to personaContent when override text is empty string" — **DELETE** (tests personaContent fallback)
- **Lines 147-159**: "prepend mode adds override before base instructions" — **UPDATE**: Remove `personaContent` from options, test that prepend works with the hardcoded default reviewer base instead
- **Lines 161-173**: "append mode adds override after base instructions" — **UPDATE**: Remove `personaContent` from options, test that append works with the hardcoded default reviewer base instead
- **Lines 175-185**: "advanced reviewer add-on is still injected with personaContent" — **UPDATE**: Remove `personaContent` from options, rename to "advanced reviewer add-on is still injected without personaContent", test that advanced reviewer directive appears with default base

### `src/test/agent-prompt-builder-subagents.test.js`

Update the `testResolveBaseInstructions()` function (lines 299-345):

- **Lines 302-304**: Test that personaContent is ignored / defaultBase is used — **UPDATE**: Since `personaContent` no longer exists in `PromptBuilderOptions`, remove the `personaContent` option from this test. The test should verify that `defaultBase` is returned when no override exists.
- **Lines 306-308**: Test fallback to personaContent when defaultBase is empty — **DELETE** (personaContent no longer exists)
- **Lines 310-315**: Tests for empty values — **UPDATE**: Remove `personaContent` references, simplify to test that empty defaultBase returns empty string
- **Lines 317-343**: Override mode tests (replace/prepend/append) — **UPDATE**: Remove `personaContent` from all options objects. Tests should verify override modes work with defaultBase only.

**Note**: Some assertions in this test may already be incorrect vs. current code behavior (e.g., line 303-304 expects `defaultBase` to win over `personaContent`, but the current code at line 117 does the opposite). After removing `personaContent`, these tests will naturally become correct.

### `src/test/kanban-default-prompt-previews.test.js`

Update the mock and test code:

1. **Line 17**: Change mock `getPersonaForRole` to return `undefined` instead of `"Mock persona for ${role}"`:
   - Change: `getPersonaForRole: async (role) => \`Mock persona for ${role}\``
   - To: `getPersonaForRole: async (role) => undefined`

2. **Lines 53, 56**: Remove personaContent from the copied `_getDefaultPromptPreviews` implementation:
   - Remove: `const personaContent = await this._taskViewerProvider?.getPersonaForRole(role);`
   - Remove: `personaContent: personaContent?.trim() || undefined,` from options object

## Verification Plan

### Automated Tests
1. Run primary test suite: `npm run compile-tests && npx mocha out/services/__tests__/agentPromptBuilder.test.js --ui tdd`
2. Run subagent test suite: `npx mocha out/test/agent-prompt-builder-subagents.test.js`
3. Run kanban default prompt previews test: `npx mocha out/test/kanban-default-prompt-previews.test.js`
4. Run full test compilation to catch any TypeScript errors from interface changes: `npm run compile-tests`

### Manual Verification
1. Open Kanban board and copy a planner prompt
2. Verify the prompt includes: `Read .agent/workflows/improve-plan.md and follow it step-by-step.`
3. Verify no persona file content appears in the prompt
4. Test with other roles (coder, reviewer, lead) — verify no persona content in prompts
5. Verify lead and coder prompts still have proper structure (intro, execution directive, safeguards, plan list) even without base instructions
6. Verify terminal agent dispatch still works correctly (terminal dispatch uses personas separately via `---PERSONA---` wrapper)
7. Verify the `getPersonaForRole` webview handler still returns persona content to the UI

## Success Criteria
1. Persona file content does NOT appear in any Kanban-generated prompts
2. Planner prompts include the workflow path reference
3. All existing tests pass (3 test suites)
4. Terminal agent dispatch still functions correctly (personas used via separate path)
5. No PII or sensitive information from persona files is exposed in Kanban prompts
6. Lead and coder prompts remain structurally complete (intro, directives, plan list)
7. `PromptBuilderOptions` interface no longer contains `personaContent` field
8. `resolveBaseInstructions` no longer references `personaContent`

## Scope
All Kanban prompt generation paths in KanbanProvider.ts and TaskViewerProvider.ts. Terminal agent dispatch is unaffected. The `getPersonaForRole` webview message handler is unaffected.

## Recommendation
Complexity 4 → **Send to Coder**

---

## Review Results (Reviewer Pass)

### Stage 1: Grumpy Principal Engineer Review

All 8 plan requirements verified against actual code:

| # | Requirement | Status | Evidence |
|---|-------------|--------|----------|
| 1 | Remove `personaContent` from `PromptBuilderOptions` | DONE | Interface at lines 74-115 has no `personaContent` field |
| 2 | Simplify `resolveBaseInstructions()` | DONE | Line 123: `const base = defaultBase;` — no personaContent reference |
| 3 | Replace lead personaContent-derived base | DONE | Line 465: `let leadBase = '';` with conditional pair-programming add-on |
| 4 | Replace coder personaContent-derived base | DONE | Line 503: `let coderBase = '';` with conditional pair-programming add-on |
| 5 | Remove 8 `getPersonaForRole()` calls from KanbanProvider.ts | DONE | Only webview handler remains (preserved as required) |
| 6 | Remove `personaContent` from all `buildKanbanBatchPrompt` calls | DONE | No `personaContent` in any options objects across both files |
| 7 | Remove `getPersonaForRole()` from TaskViewerProvider.ts `_buildKanbanBatchPrompt` | DONE | Method at lines 5881-5925 has no personaContent |
| 8 | Update 3 test files | DONE | All personaContent-dependent tests removed/updated |

**Findings:**

- **NIT-1** (FIXED): Test suite name `buildKanbanBatchPrompt — personaContent & overrides` was stale — no test in the suite uses personaContent. Renamed to `buildKanbanBatchPrompt — overrides & context flags`.
- **NIT-2** (FIXED): Test name `advanced reviewer add-on is still injected without personaContent` was a historical reference. Renamed to `advanced reviewer add-on is injected with default base instructions`.
- **No CRITICAL or MAJOR findings.**

### Stage 2: Balanced Synthesis

Both NITs were zero-cost renames with no behavioral change. Applied immediately.

### Code Fixes Applied

| File | Change | Severity |
|------|--------|----------|
| `src/services/__tests__/agentPromptBuilder.test.ts` line 66 | Suite name: `personaContent & overrides` → `overrides & context flags` | NIT |
| `src/services/__tests__/agentPromptBuilder.test.ts` line 125 | Test name: `without personaContent` → `with default base instructions` | NIT |

### Verification Results

| Test Suite | Command | Result |
|------------|---------|--------|
| TypeScript compilation | `npm run compile-tests` | PASS (exit 0) |
| agentPromptBuilder.test.ts | `npx mocha out/services/__tests__/agentPromptBuilder.test.js --ui tdd` | 26 passing |
| agent-prompt-builder-subagents.test.js | `node src/test/agent-prompt-builder-subagents.test.js` | All PASS |
| kanban-default-prompt-previews.test.js | `node src/test/kanban-default-prompt-previews.test.js` | All PASS |

### Success Criteria Verification

1. ✅ Persona file content does NOT appear in any Kanban-generated prompts
2. ✅ Planner prompts include the workflow path reference (`Read ${workflowPath} and follow it step-by-step.`)
3. ✅ All existing tests pass (3 test suites, all green)
4. ✅ Terminal agent dispatch still functions correctly (preserved methods intact)
5. ✅ No PII or sensitive information from persona files is exposed in Kanban prompts
6. ✅ Lead and coder prompts remain structurally complete (intro, directives, plan list)
7. ✅ `PromptBuilderOptions` interface no longer contains `personaContent` field
8. ✅ `resolveBaseInstructions` no longer references `personaContent`

### Remaining Risks

None identified. The implementation is complete and verified.
