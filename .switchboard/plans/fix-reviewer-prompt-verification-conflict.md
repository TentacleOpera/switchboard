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

## Reviewer Pass Results

### Stage 1: Grumpy Principal Engineer Findings

1. **NIT** — Tester role lacks conditional clause on its "Run verification checks" line (line 539). Tester has no skip add-ons and no skipBlock in suffix, so no active contradiction. Future-proofing note only.
2. **MAJOR** — Redundant test assertion: `builderSource.includes('unless specified otherwise in this prompt')` is a strict substring of the full-string assertion at line 27-30. Tautological test provides zero independent coverage — if the full-string assertion passes, the substring assertion is guaranteed to pass.
3. **NIT** — Plan line numbers stale (plan says 416, actual is 469; plan says 471, actual is 539; plan says 28, actual is 27).
4. **NIT** — Tester suffix block (line 553) omits `skipBlock` entirely, silently ignoring any user-enabled skip add-ons. Pre-existing architectural issue, outside plan scope.

### Stage 2: Balanced Synthesis

1. **Tester conditional clause** → Defer. Not in scope — no active contradiction. Address if skip add-ons are ever added to tester.
2. **Redundant test assertion** → Fix now. Removed tautological assertion. The full-string assertion at line 27-30 already validates the conditional clause.
3. **Stale line numbers** → Fix now. Updated in corrected line numbers table below.
4. **Tester suffix omits skipBlock** → Defer. Pre-existing, out of scope.

### Stage 3: Code Fixes Applied

- **`src/test/autoban-reviewer-prompt-regression.test.js`**: Removed the redundant `builderSource.includes('unless specified otherwise in this prompt')` assertion (was lines 37-40). The full-string assertion at line 27-30 already validates this substring.

### Stage 4: Verification Results

- `node src/test/autoban-reviewer-prompt-regression.test.js` — **PASSED** (all assertions green)
- Core implementation verified:
  - `agentPromptBuilder.ts` line 469: Reviewer instruction includes conditional clause ✓
  - `agentPromptBuilder.ts` line 539: Tester instruction unchanged (no skip add-ons, no skipBlock in suffix) ✓
  - `agentPromptBuilder.ts` line 504: Reviewer suffix includes `skipBlock` ✓
  - `agentPromptBuilder.ts` line 553: Tester suffix omits `skipBlock` (pre-existing, out of scope) ✓
  - `sharedDefaults.js` line 24: Reviewer has `skipCompilation: true, skipTests: true` ✓
  - `sharedDefaults.js` line 25: Tester has no skip add-ons ✓

### Corrected Line Numbers

- "line 416" (reviewer verification) → actual line 469 in `agentPromptBuilder.ts`
- "line 436" (reviewer suffixBlock) → actual line 504 in `agentPromptBuilder.ts`
- "line 471" (tester role) → actual line 539 in `agentPromptBuilder.ts`
- "line 485" (tester suffixBlock) → actual line 553 in `agentPromptBuilder.ts`
- "line 28" (regression test assertion) → actual line 27 in `autoban-reviewer-prompt-regression.test.js`
- "line 35" (Grumpy critique assertion) → actual line 33 in `autoban-reviewer-prompt-regression.test.js`

### Remaining Risks

1. **Tester suffix omits skipBlock** — If skip add-ons are ever added to the tester role defaults, the suffix block at line 553 must be updated to include `skipBlock`, and the tester's verification instruction at line 539 should receive the same conditional clause.
2. **Other roles with verification instructions** — The coder and lead roles also include `skipBlock` in their suffixes. If any of their base instructions contain "Run verification checks" or similar, the same contradiction pattern could appear. Currently they do not use this exact phrasing, but future prompt edits should be aware of the pattern.

## Recommendation

Complexity 3 → **Send to Intern**
