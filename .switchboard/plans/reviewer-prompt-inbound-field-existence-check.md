# Reviewer Prompt: Inbound Field-Existence Check & Plan-Authority Split

## Metadata

**Tags:** refactor, test, reliability
**Complexity:** 3
**Project:** Browser Switchboard

## Goal

The code reviewer prompt in `src/services/agentPromptBuilder.ts` has three structural holes that allowed an inbound field-existence bug (`headRole` filtered on but never written by `wireSpawnedTeam`) to pass review. This plan closes all three by editing prompt text constants and their gating tests. No runtime behavior changes — only the text dispatched to reviewer agents.

## Background

A reviewer agent approved code that filtered on `headRole` from a persisted group object, but the writer (`wireSpawnedTeam` in `teamWiring.ts`) never sets that field. The reviewer missed it because:

1. **ADVANCED_REVIEWER_DIRECTIVE is entirely outbound** — all 5 items ask "what does my change break downstream?" None ask "is what my change consumes actually there?" The bug was inbound (reading a field written by a different flow at a different time).
2. **Line 1838 grants the plan blanket authority** — "Use the plan file as the source of truth for the review criteria." A reviewer obeying this literally grades conformance to the plan, not correctness of the plan's claims about the codebase. The plan asserted a false data shape and the reviewer had no instruction to challenge it.
3. **Nothing in the prompt could go red** — the verify step runs checks "as applicable"; the gate-wiring audit only checks whether named automated checks are CI-wired. If the plan's core mechanism has no automated check at all, both steps pass green by vacuity, producing zero discriminating evidence.

**Root-cause verification (improve pass):** The persisted group object literal in `wireSpawnedTeam` (lines 1371-1380 of `teamWiring.ts`) contains `id`, `name`, `source`, `teamGroup`, `layout`, `members`, `order`, `externalHead` — and does NOT set `headRole`. Yet the migration/normalization code at lines 665-706 reads and filters on `g.headRole`. This confirms the inbound field-existence gap: the writer omits the field, the reader assumes it exists, and the reviewer prompt had no instruction to check this direction.

## User Review Required

This plan modifies the text dispatched to all reviewer agents. While the changes are prompt-text-only (no runtime behavior), the altered plan-authority language (Fix 2) changes the reviewer's relationship to the plan file — reviewers are now explicitly told the plan is NOT authoritative on codebase facts. The user should confirm this is the intended division of labor before implementation. Additionally, the Fix 3 optional/mandatory question (see Outstanding Questions) requires a user decision.

## Complexity Audit

### Routine
- Editing three prompt-text constants in a single file (`src/services/agentPromptBuilder.ts`).
- Appending one new item to an existing numbered list (`ADVANCED_REVIEWER_DIRECTIVE`).
- Rewriting one string literal (step 1 of the `steps` array).
- Inserting one new string into an array literal (new step 2).
- Adding string-presence assertions to two existing test files.
- Step numbering is dynamic (`steps.map((s, i) => \`${i + 1}. ${s}\`)` at line 1857) — no hardcoded numbers to update. Verified: no test files or builder source reference reviewer step numbers by hardcoded integer.

### Complex / Risky
- The plan-authority split (Fix 2) changes the reviewer's semantic relationship to the plan file — a behavioral change in review posture, not just added text. This is the highest-risk change: if the new language is too aggressive, reviewers may waste tokens re-verifying facts the planner already established correctly; if too weak, the original hole persists.
- Fix 3 (if included) introduces a "provisional verdict" concept that could cause cards to stall in review if reviewers flag provisional on changes that are actually well-tested manually. This is a workflow-flow risk, not a code risk.

## Edge-Case & Dependency Audit

### Race Conditions
- None. All changes are to static string constants and their test assertions. No async state, no file watchers, no concurrent writes.

### Security
- None. No secrets, credentials, or auth logic touched. Prompt text is not user-controlled input.

### Side Effects
- **Token cost increase:** Every reviewer dispatch will carry the new text. Estimated impact: Fix 1a adds ~30 words, Fix 1b adds ~60 words, Fix 2 is approximately net-neutral (replaces one sentence with a slightly longer one), Fix 3 adds ~40 words. Total: ~130 words (~3-5% of an already multi-paragraph reviewer prompt). Impact is small but non-zero — every review across all workspaces pays this cost permanently.
- **Step numbering shift:** Inserting a new step 2 in the `steps` array shifts all subsequent step numbers by 1. The steps are numbered dynamically, so this is automatic. Verified: no hardcoded step references exist in test files or builder source.
- **Delegation mode interaction:** The `steps` array is shared between delegation and non-delegation reviewer paths. Fixes 1a and 2 apply to both. `ADVANCED_REVIEWER_DIRECTIVE` is a module-level constant injected in both paths when enabled. Fix 1b applies to both. No delegation-specific handling needed.

### Dependencies & Conflicts
- **`advancedReviewerEnabled` flag:** Fix 1b (full grep protocol) fires only when this flag is true. Fix 1a (short version) and Fix 2 fire unconditionally (base steps). Fix 3 fires unconditionally. This is the intended design — baseline protection regardless of the flag, enhanced protocol when advanced mode is on.
- **Existing test for "ADVANCED REGRESSION ANALYSIS" string:** The `kanban-default-prompt-previews.test.js` test checks for presence/absence of the header string `"ADVANCED REGRESSION ANALYSIS"`. Adding item 6 doesn't change the header, so these assertions remain valid. Verified: no test asserts on the exact string `"source of truth for the review criteria"` — Fix 2's rewrite won't break existing tests.
- **No migration needed:** These are prompt-text changes, not state/file/format changes. The CLAUDE.md migration rules apply to persisted user state, not to prompt constants.
- **Separate plan exists for the actual `headRole` bug fix:** `.switchboard/plans/fix-headrole-missing-from-live-terminal-groups.md` addresses the runtime bug (adding `headRole` to the persisted group object). This plan addresses only the reviewer prompt that failed to catch it. The two plans are independent — this plan does not depend on the fix plan being implemented first.

## Dependencies

None — this plan is self-contained. It edits only prompt-text constants and their gating tests. No other plan needs to complete first.

## Adversarial Synthesis

Key risks: (1) prompt-text instructions rely on agent instruction-following — no enforcement mechanism guarantees a reviewer will actually open the writer and verify field existence; (2) the Goal states "closes all three" holes but Fix 3 (hole 3) is marked optional, creating an internal contradiction; (3) the plan-authority split changes reviewer posture in ways that could increase review token cost on well-specified plans. Mitigations: the two-tier approach (unconditional short check + advanced grep protocol) maximizes coverage across both flag states; the Fix 3 contradiction should be resolved by the user (see Outstanding Questions); the authority split preserves legitimate scope authority while stripping only codebase-fact authority, limiting unnecessary re-verification.

## Proposed Changes

### `src/services/agentPromptBuilder.ts`

**Context:** All edits are in this file. No data migrations needed — these are prompt-text changes only. Three constants are modified: the `steps` array (line 1837), `ADVANCED_REVIEWER_DIRECTIVE` (line 1388), and `GATE_WIRING_AUDIT_STEP` (line 996, only if Fix 3 is included).

#### Fix 1a: Unconditional inbound-field check in base reviewer steps

**Location:** `steps` array at line 1837, inserted as a new step immediately after the (modified) step 1.

**Current step 1 (line 1838):**
```
`Use the plan file as the source of truth for the review criteria.`
```

**New step 1 (replaces current — see Fix 2):**
```
`Use the plan file as the source of truth for review scope — what to build and what's out of bounds. The plan is NOT authoritative on codebase facts: where it asserts a data shape, a function's behaviour, or a field's existence, verify against the code. A plan's confidence is not evidence.`
```

**New step 2 (inserted after step 1, before Stage 1 Grumpy):**
```
`Inbound field-existence check: for every persisted or external field the change reads or filters on, open the writer and verify the field exists in the object literal that goes to disk — not in a type, docblock, or sibling reader.`
```

**Implementation:** Insert the new string as the second element in the `steps` array (after the rewritten step 1, before the `reviewerConciseModeEnabled ? ... : ...` entry that is currently at index 1). The `.filter(Boolean)` at line 1854 and dynamic numbering at line 1857 handle the shift automatically.

**Edge Cases:** This step fires for every review regardless of the `advancedReviewerEnabled` flag. It gives the reviewer a concrete action (open the writer, read the literal) without the full grep protocol. For reviews where the change touches no persisted/external fields, the step is a no-op instruction (the reviewer finds nothing to check).

#### Fix 1b: Full grep-protocol version as item 6 in ADVANCED_REVIEWER_DIRECTIVE

**Location:** `ADVANCED_REVIEWER_DIRECTIVE` constant at line 1388.

**Current (lines 1388-1394):** 5 numbered items ending with item 5 and a closing line (`This analysis is token-intensive but catches regressions that plan-compliance-only reviews miss.`).

**New item 6 (appended after item 5, before the closing line):**
```
6. Inbound field-existence check: for every persisted or external field the change reads or filters on, grep for the field name across the codebase to find its writer, then read the object literal that is persisted to disk. A docblock, a TypeScript type (especially any[]), a sibling reader, or the plan's citation of an existing function is a claim, not evidence — only the persisted literal proves the field exists. If the writer does not set the field, this is a CRITICAL finding.
```

**Implementation:** Insert the new item 6 text between item 5 and the closing line of the template literal. The closing line remains unchanged.

**Edge Cases:** This full version fires only when `advancedReviewerEnabled` is true. It adds the grep protocol, the explicit callout of `any[]` types as non-evidence, and the severity classification (CRITICAL). The `any[]` callout is TypeScript-specific — this is correct for this codebase (the project is TypeScript); for non-TS changes the callout is harmless noise.

#### Fix 2: Split plan authority on line 1838

**Location:** Line 1838, the first entry in the `steps` array.

**Current:**
```
`Use the plan file as the source of truth for the review criteria.`
```

**New:**
```
`Use the plan file as the source of truth for review scope — what to build and what's out of bounds. The plan is NOT authoritative on codebase facts: where it asserts a data shape, a function's behaviour, or a field's existence, verify against the code. A plan's confidence is not evidence.`
```

**Implementation:** Replace the string literal at line 1838 with the new text. This is a direct string replacement in the `steps` array.

**Edge Cases:** This splits the plan's authority: it remains the source of truth for scope (what to review, what's out of bounds) but is explicitly stripped of authority over codebase facts (data shapes, function behavior, field existence). The last sentence ("A plan's confidence is not evidence") directly addresses the failure mode where the reviewer trusted the plan's confident assertion of `headRole`'s existence. No existing test asserts on the current string — verified by grep across `src/test/`.

#### Fix 3 (optional, separable): Provisional verdict for manual-only core mechanism

**Location:** `GATE_WIRING_AUDIT_STEP` constant at line 996.

**Current (lines 996-1003):** Audits whether named automated checks are CI-wired.

**New text appended to the constant (before the closing backtick):**
```
 Additionally: if the plan's core mechanism has no automated check that could discriminate on its correctness — only manual verification — and that manual verification was not executed in this review pass, the verdict is provisional. State explicitly that passing unrelated suites is not evidence the core mechanism works.
```

**Implementation:** Append the new text to the `GATE_WIRING_AUDIT_STEP` template literal, before the closing backtick.

**Edge Cases:** This closes Hole 3: the case where the gate-wiring audit finds no named checks to audit (because the plan's verification is all manual), and the verify step passes because unrelated suites pass. The reviewer must now flag this as provisional rather than reporting clean success. This fix is separable — it can be shipped independently of Fixes 1-2 or omitted entirely. It addresses a different failure mode (vacuous green) than Fixes 1-2 (missing inbound check + plan authority).

> **Note on Goal consistency:** The Goal states "closes all three" holes, but Fix 3 (which closes hole 3) is marked optional. If Fix 3 is omitted, only holes 1-2 are closed. See Outstanding Questions for the user decision on this.

### `src/test/kanban-default-prompt-previews.test.js`

**Context:** This test file verifies the default prompt previews for each role. TEST 1 (lines 116-134) tests the disabled state (`advancedReviewerEnabled = false`). TEST 2 (lines 136-157) tests the enabled state (`advancedReviewerEnabled = true`).

**Implementation — Add assertions to TEST 2 (enabled state, after line 151):**

1. Assert reviewer preview includes `"Inbound field-existence check"` when `advancedReviewerEnabled` is true (verifies Fix 1b).
2. Assert reviewer preview includes `"NOT authoritative on codebase facts"` in both TEST 1 (disabled) and TEST 2 (enabled) states (verifies Fix 2 is in base steps, unconditional).
3. Assert reviewer preview includes `"open the writer and verify the field exists"` in both states (verifies Fix 1a is in base steps, unconditional).

**Implementation — Add assertions to TEST 1 (disabled state, after line 130):**

4. Assert reviewer preview does NOT include `"grep for the field name"` (the full grep protocol is advanced-only; the base version doesn't mention grep).

**Edge Cases:** The test file requires `../../out/services/agentPromptBuilder` (compiled output). Tests are run via `node` against the compiled `out/` directory, not `src/` directly. The source-text assertions in the regression test file (below) cover the source-level check.

### `src/test/autoban-reviewer-prompt-regression.test.js`

**Context:** This test reads the builder source file directly (`src/services/agentPromptBuilder.ts`) and asserts on string presence. It does not require compiled output.

**Implementation — Add source-text presence assertions (after line 81, before the closing log at line 83):**

5. Assert builder source includes `"Inbound field-existence check"` (Fix 1a/1b).
6. Assert builder source includes `"NOT authoritative on codebase facts"` (Fix 2).
7. Assert builder source includes `"only the persisted literal proves the field exists"` (Fix 1b full version).
8. If Fix 3 is included: assert builder source includes `"passing unrelated suites is not evidence"` (Fix 3).

**Edge Cases:** These are source-text presence tests, not behavior tests. They guard against the new prompt text being silently dropped from the constants. They do not verify that a reviewer agent actually performs the inbound check — that is inherent to prompt-text changes and cannot be unit-tested.

## Verification Plan

### Automated Tests
1. Run `node src/test/kanban-default-prompt-previews.test.js` — all assertions pass (existing + new). Note: this test requires compiled output in `out/` — run `npm run compile` first if `out/` is stale.
2. Run `node src/test/autoban-reviewer-prompt-regression.test.js` — all assertions pass (existing + new). This test reads source directly, no compilation needed.

### Manual Verification
3. Manual: grep the builder source for each new string to confirm presence:
   - `grep -n "Inbound field-existence check" src/services/agentPromptBuilder.ts` — should hit twice (base step + advanced directive).
   - `grep -n "NOT authoritative on codebase facts" src/services/agentPromptBuilder.ts` — should hit once (step 1 rewrite).
   - `grep -n "only the persisted literal proves" src/services/agentPromptBuilder.ts` — should hit once (advanced directive item 6).
4. If Fix 3 is included: `grep -n "passing unrelated suites is not evidence" src/services/agentPromptBuilder.ts` — should hit once (GATE_WIRING_AUDIT_STEP extension).

## Outstanding Questions
- **[user]** Should Fix 3 (provisional verdict for manual-only core mechanism) be mandatory or optional? The Goal states "closes all three" holes, but Fix 3 is marked optional/separable. If Fix 3 is omitted, only holes 1-2 are closed and the Goal overstates. — proceeding on the assumption that Fix 3 is optional and the Goal's "all three" language refers to the plan's complete scope (all three fixes available), not a guarantee that all three will be shipped.

## Recommendation

Complexity 3 → **Send to Intern**. Single-file prompt-text changes with clear, specific edits and well-defined test assertions. The highest-risk aspect (plan-authority posture change in Fix 2) is a text change, not an architectural one — the risk is in the wording, which is already specified verbatim in this plan.

### Implementation Summary
Implemented all three fixes in `src/services/agentPromptBuilder.ts` to close structural holes in reviewer prompts. Added unconditional inbound field-existence verification and split plan authority in the base reviewer steps, appended the full grep-protocol inbound check to `ADVANCED_REVIEWER_DIRECTIVE`, and appended the provisional verdict requirement for manual-only core mechanisms to `GATE_WIRING_AUDIT_STEP`. Updated `src/test/kanban-default-prompt-previews.test.js` and `src/test/reviewer-prompt-anti-artifact-contract.test.js` to assert presence of all new prompt directives across enabled and disabled configurations. All changes are prompt-text constants and test guards without modifying runtime logic.
