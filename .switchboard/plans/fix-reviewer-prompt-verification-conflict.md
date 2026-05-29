# Fix Reviewer Prompt Verification Conflict

## Goal

Resolve the direct contradiction in the reviewer role's generated prompt between its base instruction ("Run verification checks") and the `skipTests`/`skipCompilation` add-on directives ("SKIP TESTS" / "SKIP COMPILATION"), both of which are enabled by default.

## Metadata

- **Tags:** [bugfix, reliability]
- **Complexity:** 3

## User Review Required

- Confirm that the "unless specified otherwise" conditional wording approach is preferred over a larger refactor to dynamically build the base instructions.

## Complexity Audit

### Routine
- Wording change to a single hardcoded string literal in `agentPromptBuilder.ts`
- Update one exact-match assertion in the regression test
- Add one new assertion to the existing regression test

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None — this is a static prompt string, not runtime state.
- **Security:** No security implications.
- **Side Effects:** The wording change applies to ALL reviewer prompts regardless of add-on state. When `skipTests`/`skipCompilation` are disabled, the "unless specified otherwise" clause is harmlessly redundant (no override exists, so the base instruction stands).
- **Dependencies & Conflicts:** The regression test (`autoban-reviewer-prompt-regression.test.js` line 28) does an exact `includes()` match on the current wording. Any change to the string will break this test unless the assertion is updated in the same commit.

## Dependencies

None

## Adversarial Synthesis

Key risks: (1) The `skipCompilation` conflict is the same class of bug as `skipTests` and must be fixed in the same pass — the original plan missed this. (2) The tester role has no `skipTests` add-on and no `skipBlock` in its suffix, so applying the same change there is unnecessary. Mitigations: Address both `skipTests` and `skipCompilation` in the reviewer base; drop the tester change; add an automated prompt-consistency assertion.

## Proposed Changes

### `src/services/agentPromptBuilder.ts`

**Context:** The reviewer base instructions are a hardcoded template string (lines 411-419). The `skipBlock` — which emits `SKIP_COMPILATION_DIRECTIVE` and/or `SKIP_TESTS_DIRECTIVE` when their respective add-ons are enabled — is appended later as part of `suffixBlock` (line 436). This creates a temporal contradiction: the base says "run verification" then the suffix says "skip verification."

**Logic:** Add the conditional qualifier "unless specified otherwise in this prompt" to the verification step, making the base instruction explicitly deferrable by add-on directives.

**Implementation:**

- **Line 416** — Change:
  ```
  5. Run verification checks (typecheck/tests as applicable) and include results.
  ```
  To:
  ```
  5. Run verification checks (typecheck/tests as applicable) and include results, unless specified otherwise in this prompt.
  ```

  This single change resolves both the `skipTests` conflict AND the `skipCompilation` conflict, because "typecheck" is mentioned in the same line and the `skipCompilation` directive also appears in the `skipBlock` suffix.

- **Tester role (line 471)** — NO CHANGE. The tester role has no `skipTests` or `skipCompilation` add-ons in `sharedDefaults.js` (lines 109-115) and its `suffixBlock` does not include `skipBlock` (line 485). There is no conflict to resolve.

**Edge Cases:**
- When both `skipTests` and `skipCompilation` are disabled, the "unless specified otherwise" clause is harmlessly inert — no override directive exists, so the agent runs verification as instructed.
- When only one skip directive is active (e.g., `skipCompilation` but not `skipTests`), the agent should run tests but skip compilation. The "unless specified otherwise" qualifier allows this partial override correctly.

### `src/test/autoban-reviewer-prompt-regression.test.js`

**Context:** The regression test at line 28 asserts the exact current wording. It must be updated to match the new conditional wording.

**Implementation:**

- **Line 28** — Change:
  ```js
  builderSource.includes('Run verification checks (typecheck/tests as applicable) and include results.'),
  ```
  To:
  ```js
  builderSource.includes('Run verification checks (typecheck/tests as applicable) and include results, unless specified otherwise in this prompt.'),
  ```

- **Add new assertion after line 35** (after the Grumpy critique assertion) — Add a prompt-consistency check:
  ```js
  assert.ok(
      builderSource.includes('unless specified otherwise in this prompt'),
      'Expected reviewer verification instruction to include conditional override clause for skipTests/skipCompilation add-ons.'
  );
  ```

**Edge Cases:** The new assertion validates that the conditional clause exists in the source, ensuring future edits don't accidentally remove it.

## Verification Plan

### Automated Tests
- Run `node src/test/autoban-reviewer-prompt-regression.test.js` — all assertions pass with updated wording.
- The new conditional-clause assertion confirms the override mechanism is present in the source.

### Manual Verification
- Open the Prompts tab in the Switchboard webview
- Select Reviewer role
- With `skipTests` enabled (default): verify the prompt preview contains both "Run verification checks... unless specified otherwise" AND "SKIP TESTS" — no contradiction
- With `skipTests` disabled: verify the prompt preview contains "Run verification checks... unless specified otherwise" with NO "SKIP TESTS" directive — the conditional clause is harmlessly inert
- Repeat for `skipCompilation` enable/disable
- Verify `skipTests` add-on still toggles correctly in the UI

## Problem

The reviewer role has a direct conflict between its base prompt instructions and the `skipTests`/`skipCompilation` add-ons:

- **Base prompt** (`src/services/agentPromptBuilder.ts` line 416): "Run verification checks (typecheck/tests as applicable) and include results."
- **Add-on** (`src/webview/sharedDefaults.js` line 105-106): `skipCompilation` and `skipTests` are both enabled by default for the reviewer role, emitting "SKIP COMPILATION" and "SKIP TESTS" directives in the `skipBlock` suffix.

This creates an inconsistent prompt where the base instructions say "run verification" but the add-on suffix says "skip verification."

## Solution

Update the base reviewer prompt to be conditional, allowing add-on directives to override verification behavior. A single wording change resolves both the `skipTests` and `skipCompilation` conflicts.

## Implementation Steps

1. Edit `src/services/agentPromptBuilder.ts` line 416
   - Change: `5. Run verification checks (typecheck/tests as applicable) and include results.`
   - To: `5. Run verification checks (typecheck/tests as applicable) and include results, unless specified otherwise in this prompt.`

2. ~~Verify the same pattern is applied to the tester role (line 471)~~ — **SKIPPED**: The tester role has no `skipTests`/`skipCompilation` add-ons and no `skipBlock` in its suffix. No conflict exists.

3. Update the regression test `src/test/autoban-reviewer-prompt-regression.test.js`
   - Line 28: Change assertion string from `'Run verification checks (typecheck/tests as applicable) and include results.'` to `'Run verification checks (typecheck/tests as applicable) and include results, unless specified otherwise in this prompt.'`
   - After line 35: Add new assertion verifying the conditional clause exists: `builderSource.includes('unless specified otherwise in this prompt')`

4. Manual verification:
   - Build the extension
   - Open the Prompts tab
   - Select Reviewer role
   - Enable/disable `skipTests` add-on — verify prompt preview shows consistent instructions
   - Enable/disable `skipCompilation` add-on — verify prompt preview shows consistent instructions

## Risk Assessment

- **Low risk** — simple wording change to base prompt string
- **No functional change** — add-on behavior remains the same
- **Improves clarity** — makes the relationship between base instructions and add-ons explicit
- **Covers both conflicts** — the single wording change resolves both `skipTests` and `skipCompilation` contradictions

## Verification

- Regression test passes with updated assertion
- New conditional-clause assertion passes
- Prompt preview shows no conflicting instructions when `skipTests`/`skipCompilation` are enabled
- `skipTests` and `skipCompilation` add-ons still function as expected when enabled/disabled

## Recommendation

Complexity 3 → **Send to Intern**
