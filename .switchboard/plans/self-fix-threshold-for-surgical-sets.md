# Reviewer Fix Delegation: Self-Fix Threshold + Diagnosis-Only for Judgment Calls

## Metadata
**Complexity:** 5
**Tags:** backend, refactor, performance
**Project:** Browser Switchboard

## Goal

Allow the reviewer to fix small, fully-diagnosed code sets directly instead of mandating delegation to a coder, even when delegation mode is active. When the reviewer has fully diagnosed a fix set under approximately 100 lines, the cost of writing precise instructions + round-tripping through a coder exceeds the cost of typing the fix. The reviewer reads the code to verify the coder's diff regardless, so delegation on surgical sets adds instruction-writing cost + round-trips without saving the analysis or the verification.

Additionally, stop forcing the reviewer to specify exact fixes for every CRITICAL/MAJOR finding when delegating to a coder. Mechanical fixes (compile errors, type mismatches) get precise instructions because the compiler is a shared oracle. Judgment calls (which artifact is wrong, design decisions, what's load-bearing) get diagnosis + reasoning only — the coder chooses the fix.

## Problem

Two related failure modes in the delegation `fixStep` at `src/services/agentPromptBuilder.ts:1824`:

**Failure mode 1 — No self-fix escape hatch:** The `isDelegationActive` branch at line 1822 is binary: if all three delegation options are present (`reviewerDelegationMode`, `reviewerCoderTerminal`, `reviewerOriginLead`), the reviewer is told "Do NOT fix the code yourself" and must delegate all fixes. There is no escape hatch for small diagnosed sets. In the session that motivated this plan, the reviewer had fully diagnosed a ~60-line fix set. Delegation then required four long, exact messages. The precision cost scaled with how exactly the reviewer had to specify, not with how much code changed. Fixing directly would have been faster and would have skipped the self-inflicted rounds. The reviewer re-read the diff to verify every fix anyway — so they read the code regardless.

The reviewer's own rule: "once I've fully diagnosed a fix set under roughly a hundred lines, fix it myself. Delegate when the set is broad, parallelisable, or when the coder holds context I'd have to rebuild."

**Failure mode 2 — Over-prescriptive instructions on judgment calls:** The delegation `fixStep` currently instructs: "name each file, the issue, **and the fix needed**." This forces the reviewer to specify exact fixes regardless of finding type. In the session that motivated this plan, this caused Round 3: the reviewer specified "make the test regex robust," the coder implemented it literally (moved production CSS to satisfy the regex), and the reviewer's actual judgment (the test was the wrong artifact, delete it) never transferred through the instruction. Precise instructions on judgment calls are both expensive to write and counterproductive — they channel the coder toward the reviewer's potentially-wrong fix instead of letting the coder apply their own context.

Contrast: TS2783 (invalid TypeScript specified by the reviewer) was caught by the coder's compiler at compile time, fixed inline, zero round-trip. The compiler is a shared oracle — both parties agree on what it says. "Which artifact is wrong" has no shared oracle.

## Root Cause

**For the self-fix threshold:** The delegation gate is a boolean (`isDelegationActive`) with no size or diagnosis-completeness check. The dispatch code in `TaskViewerProvider.ts` (lines 21488-21557) sets `reviewerDelegationMode: true` whenever a coder terminal is resolved for the reviewer — unconditionally, regardless of the fix set size. The prompt builder then has no information about the fix set size and no way to route differently.

**For the over-prescriptive instructions:** `fixStep` is a single template string that treats all findings identically. There is no distinction between mechanical findings (compiler/test suite is the oracle) and judgment findings (the reviewer's reasoning is the only signal, and it doesn't survive precise instruction-passing).

## Implementation

### 1. The threshold check belongs in the prompt builder, not the dispatch code

The dispatch code (`TaskViewerProvider.ts`) doesn't know the fix set size at dispatch time — the reviewer hasn't run yet. The threshold can only be evaluated by the reviewer itself, after Stage 1 (Grumpy findings) and Stage 2 (Balanced synthesis), when it knows how many findings there are and how many lines they span.

This means the change is to the `fixStep` and `verifyStep` template strings, not to the dispatch routing. The reviewer is given a conditional instruction: if your diagnosed fix set is under ~100 lines, fix it yourself; otherwise, delegate to your coder.

### 2. Modify the fixStep to include the self-fix escape hatch AND the two-tier mechanical/judgment distinction

The `fixStep` at line 1824 changes from:

> "Send fix instructions for valid CRITICAL/MAJOR findings to your coder at {terminal}... Do NOT fix the code yourself."

To a merged template that composes both changes:

> "For valid CRITICAL/MAJOR findings: if your diagnosed fix set totals under approximately 100 lines of change, apply the fixes directly yourself. If the set is larger, broad, or parallelisable, send fix instructions to your coder at {terminal} via POST /terminals/verb/ptySendPrompt with {name, data, clearBeforePrompt:false} against the port in .switchboard/api-server-port.txt. For each delegated finding: name the file and the issue. For mechanical fixes (compile errors, type issues, missing imports), specify the exact fix — the compiler is a shared oracle. For judgment calls (design decisions, which artifact is wrong, test policy), describe the problem and your reasoning — let the coder choose the fix. You will re-review their diff regardless. Tell the coder to run verification checks (typecheck/tests as applicable) and include results in their report. If the fix set grows beyond ~100 lines during implementation, switch to delegating the remaining fixes to your coder."

The self-fix threshold is the outer conditional (Plan 2). The two-tier mechanical/judgment distinction lives within the delegation branch (Plan 1). The "Do NOT fix the code yourself" clause is replaced by the conditional — the reviewer now has a choice.

### 3. Modify the verifyStep to handle both paths

The `verifyStep` at line 1827 needs to cover both outcomes:

**If the reviewer fixed directly:** Run verification checks (typecheck/tests as applicable) and include results. (This is the existing non-delegation verifyStep text.)

**If the reviewer delegated:** After the coder reports back, re-review ONLY the coder's git diff (git diff HEAD~<coder's commit count> or git log --oneline -5 to find the coder's commits). Do NOT re-review the entire codebase — scope your re-review to the changed lines only. The coder may have chosen a different fix direction than you would have for judgment calls — evaluate whether the chosen fix resolves the finding, not whether it matches what you would have done. If issues remain in the diff, send another round of fix instructions. Loop until satisfied. If after 5 rounds the same critical issues persist, stop — report to {lead} via ptySendPrompt that the plan is badly scoped and a new plan is needed for the remaining work. When review passes, report to {lead} via ptySendPrompt that the feature passed review, then update the plan file with your review summary.

The template becomes a conditional: "If you applied fixes directly, run verification checks (typecheck/tests as applicable) and include results. If you delegated to your coder, after the coder reports back, re-review ONLY the coder's git diff..."

### 4. Modify the completion reporting

The delegation completion step reports to `reviewerOriginLead` via ptySendPrompt. When the reviewer self-fixes, it should still report completion to the lead (the lead needs to know the review passed), but the report says "fixes applied directly" instead of "fixes delegated."

The summary step at line 1844 changes to: "fixes applied (directly or delegated) and their status."

### 5. The anti-leakage step — use Option B (keep both steps, prefix with condition)

When the reviewer self-fixes, `DELEGATION_ANTI_LEAKAGE_STEP` (which says "you do NOT run tests yourself") is wrong — the reviewer IS running tests. The step selection at line 1841 needs to cover both paths.

> **Superseded:** Option A — merge the two anti-leakage steps into one that covers both paths: "If you applied fixes directly, you MUST run tests yourself. If you delegated to your coder, you do NOT run tests..."
> **Reason:** Two contradictory instructions in one step. An LLM reading this will pick one branch and ignore the other. Correctness over brevity.
> **Replaced with:** Option B — keep both steps in the prompt, prefixed with their condition: "IF YOU FIXED DIRECTLY: {ANTI_LEAKAGE_STEP text}. IF YOU DELEGATED: {DELEGATION_ANTI_LEAKAGE_STEP text}." The LLM sees both paths explicitly and selects the applicable one.

### 6. The skipDisclosureStep

Currently `skipDisclosureStep` is empty in delegation mode (line 1829). When the reviewer self-fixes, it needs the skip disclosure. Same conditional approach as the anti-leakage step: include the skip disclosure with a "IF YOU FIXED DIRECTLY:" prefix. The delegation path does not need the skip disclosure — in delegation mode, the coder runs tests (the reviewer doesn't), so the skip disclosure (which is about the reviewer's verification) is irrelevant in the delegation path.

### 7. Regression test coverage

The render test in `team-scoped-role-routing.test.js` (item9) asserts the delegation `fixStep` and `verifyStep` text. This test needs updating to:
- Assert the self-fix threshold language is present ("under approximately 100 lines" or equivalent)
- Assert the two-tier mechanical/judgment language is present ("specify the exact fix" for mechanical, "describe the problem" / "let the coder choose" for judgment)
- Assert the delegation language is still present (ptySendPrompt, terminal name, port reference)
- Assert the conditional verifyStep covers both paths
- Assert the anti-leakage step covers both paths (Option B: both `ANTI_LEAKAGE_STEP` and `DELEGATION_ANTI_LEAKAGE_STEP` text present, prefixed with conditions)
- Assert the summary step says "fixes applied (directly or delegated)" instead of "fixes delegated"
- Assert the "Do NOT fix the code yourself" clause is NO LONGER present (replaced by the conditional)

The existing assertions that will break:
- `prompt.includes('Send fix instructions')` — new fixStep starts with "For valid CRITICAL/MAJOR findings"
- `prompt.includes('fixes delegated and their status')` — new summary says "fixes applied (directly or delegated)"
- `prompt.includes('ANTI-LEAKAGE RULE (delegation)')` — with Option B, both anti-leakage steps are present
- `!prompt.includes('Apply code fixes for valid CRITICAL/MAJOR findings.')` — this may still pass (the non-delegation fixStep is unchanged)

## Edge cases

- **Reviewer misjudges size:** The reviewer estimates the fix set size after diagnosis. If they underestimate and start fixing directly, then discover it's larger than expected, they should be able to switch to delegation mid-stream. The prompt says: "If the fix set grows beyond ~100 lines during implementation, switch to delegating the remaining fixes to your coder."
- **No coder terminal available:** If `reviewerCoderTerminal` is set but the terminal is no longer live (coder was cleared or crashed), the reviewer can't delegate. The self-fix path is the fallback — which is the correct behavior. The existing `ptyListTerminals` check the coder does before sending is sufficient.
- **Lead expects delegation:** The lead dispatched the reviewer in delegation mode expecting fixes to go to the coder. If the reviewer self-fixes, the lead's mental model is wrong. The completion report to the lead should clearly state "fixes applied directly, not delegated" so the lead knows the coder was not involved.
- **Reviewer classifies everything as mechanical:** The reviewer could label all findings "mechanical" to avoid the harder work of reasoning through judgment calls. The verifyStep re-review catches this — if the coder's fix is wrong, the reviewer catches it in the diff. The risk is efficiency loss, not correctness loss.

## Scope

Single file change: `src/services/agentPromptBuilder.ts` (the `fixStep`, `verifyStep`, anti-leakage step selection, skip disclosure step, and completion summary — all in the `role === 'reviewer'` block, lines 1820-1850). One test file update: the render test that asserts delegation prompt text (`team-scoped-role-routing.test.js` item9).

No change to `TaskViewerProvider.ts` — the dispatch code still sets `reviewerDelegationMode: true` unconditionally. The threshold is a runtime decision by the reviewer, not a dispatch-time routing change.

## What does NOT change

- The dispatch routing in `TaskViewerProvider.ts` (still resolves coder terminal, still sets delegation mode)
- The `isDelegationActive` gate (still requires all three options)
- The ptySendPrompt protocol (still used when the reviewer chooses to delegate)
- The 5-round escalation limit
- The gate wiring audit step
- The delegation protocol (still ptySendPrompt, still coder runs verification, still reviewer re-reviews the diff)
- The `isDelegationActive` gate (still requires all three: `reviewerDelegationMode`, `reviewerCoderTerminal`, `reviewerOriginLead`)

## User Review Required

No user review required. The plan changes prompt template strings in a single file. No user-facing UI changes, no configuration changes, no migration concerns. The behavioral change (reviewer can self-fix small sets) is a prompt-level instruction, not a code-level routing change.

## Complexity Audit

### Routine
- Modifying template string constants in `agentPromptBuilder.ts` (prompt text changes, no logic changes)
- Updating render test assertions in `team-scoped-role-routing.test.js` (assertion text changes)
- The `skipDisclosureStep` conditional (adding a prefix to existing text)

### Complex / Risky
- The merged `fixStep` template composes two design changes (self-fix threshold + two-tier mechanical/judgment) into one string — the wording must be clear enough for an LLM to follow both conditionals
- The anti-leakage step Option B (both steps present, prefixed with conditions) — the LLM must correctly select the applicable branch
- The verifyStep conditional — two paths in one string, the LLM must follow the correct path based on what it actually did
- Test assertion updates — multiple existing assertions will break and need coordinated replacement

## Edge-Case & Dependency Audit

- **Race Conditions:** None — all changes are to prompt template strings, not to concurrent code paths.
- **Security:** None — no new inputs, no new endpoints, no shell commands.
- **Side Effects:** None — prompt text changes only. The reviewer's behavior changes (may self-fix instead of delegate), but this is the intended effect.
- **Dependencies & Conflicts:** This plan merged the former "Reviewer Sends Diagnosis-Only for Judgment Calls" plan into this one. Both plans modified the same `fixStep` string at line 1824 — merging them avoids conflicting edits. The merged plan owns the `fixStep`/`verifyStep` surface once. No dependency on the tiered review plan (Plan 3) — different files, different surfaces. They compose conceptually: the reviewer sees pre-checked work (Plan 3), then applies the self-fix threshold with two-tier delegation (this plan).

## Dependencies

This plan is independent of the tiered review plan (Plan 3) at the code level. Plan 3 changes what reaches the reviewer (pre-check gate). This plan changes what the reviewer does with findings (self-fix threshold + two-tier delegation). They compose: the reviewer sees pre-checked work, then applies the self-fix threshold with diagnosis-only delegation for judgment calls.

## Adversarial Synthesis

Key risks: (1) the merged `fixStep` composes two conditionals (self-fix threshold + mechanical/judgment tier) into one string — unclear wording could cause the LLM to conflate the two decisions; (2) Option B for anti-leakage (both steps present) relies on the LLM correctly selecting the applicable branch — if it follows the wrong branch, it either runs tests when it shouldn't (delegation path) or doesn't run tests when it should (self-fix path); (3) the test assertion updates are coordinated — multiple existing assertions break simultaneously. Mitigations: the two conditionals are at different levels (outer = self-fix vs delegate, inner = mechanical vs judgment within delegation), the anti-leakage prefixes are explicit ("IF YOU FIXED DIRECTLY:" / "IF YOU DELEGATED:"), and the test updates are specified in detail.

## Proposed Changes

### `src/services/agentPromptBuilder.ts`
- **Context:** The `fixStep` (line 1824), `verifyStep` (line 1827), `skipDisclosureStep` (line 1829), anti-leakage step selection (line 1841), and summary step (line 1844) — all in the `role === 'reviewer'` block.
- **Logic:**
  - `fixStep`: Replace the single delegation template with a merged template that has the self-fix threshold as the outer conditional and the two-tier mechanical/judgment distinction within the delegation branch. Remove "Do NOT fix the code yourself."
  - `verifyStep`: Replace with a conditional covering both paths (self-fix = run verification, delegation = re-review coder's diff with acknowledgment that coder may choose different fix direction).
  - `skipDisclosureStep`: Include with "IF YOU FIXED DIRECTLY:" prefix when skip directives are active. Delegation path doesn't need it.
  - Anti-leakage step (line 1841): Use Option B — include both `ANTI_LEAKAGE_STEP` and `DELEGATION_ANTI_LEAKAGE_STEP`, prefixed with "IF YOU FIXED DIRECTLY:" and "IF YOU DELEGATED:" respectively.
  - Summary step (line 1844): Change "fixes delegated and their status" to "fixes applied (directly or delegated) and their status."
- **Implementation:** All changes are to template string constants and the steps array composition. No new functions, no new types, no new control flow. The `isDelegationActive` ternary structure stays — the delegation branch templates are rewritten.
- **Edge Cases:** Reviewer misjudges size → prompt says switch to delegation mid-stream. No coder terminal → self-fix is the fallback. Reviewer classifies everything as mechanical → verifyStep re-review catches wrong fixes.

### `src/test/team-scoped-role-routing.test.js`
- **Context:** Item 9 render assertions for delegation mode.
- **Logic:** Update assertions to match the new merged template text. The existing assertions that will break: `prompt.includes('Send fix instructions')`, `prompt.includes('fixes delegated and their status')`, `prompt.includes('ANTI-LEAKAGE RULE (delegation)')` (with Option B, both steps are present). New assertions: self-fix threshold language, two-tier mechanical/judgment language, conditional verifyStep, both anti-leakage steps present with prefixes, summary says "fixes applied (directly or delegated)."
- **Implementation:** Replace the broken assertions in the "render: delegation ON" test block. Add new assertions for the merged content. The "render: delegation OFF" test block should remain unchanged (non-delegation path is unaffected).
- **Edge Cases:** The defensive guard test (missing coder/lead falls back to fix-itself) should still pass — the `isDelegationActive` gate is unchanged.

## Verification Plan

1. `npm run compile` — exit 0, 0 errors
2. The render test in `team-scoped-role-routing.test.js` passes with updated assertions
3. Manual: dispatch a reviewer in delegation mode on a small fix set and confirm the rendered prompt contains the self-fix threshold language
4. Manual: confirm the prompt still contains the delegation path (ptySendPrompt, terminal name, port) for when the set is large
5. Manual: confirm the prompt contains the two-tier mechanical/judgment distinction within the delegation branch
6. Manual: confirm the anti-leakage step covers both paths (Option B: both steps present with condition prefixes)
7. Manual: confirm the "Do NOT fix the code yourself" clause is no longer present
8. Manual: confirm the ptySendPrompt endpoint, terminal name, and port reference are still correctly interpolated in the new template string

> **Note:** Per session directives, compilation (step 1) and automated tests (step 2) are not executed in this planning pass. The checks remain written down for the implementer.

## Outstanding Questions

- **[user]** The ~100-line threshold is a prompt-level guideline, not a hard gate. Is this acceptable, or should there be a code-level enforcement mechanism? — proceeding on the assumption that prompt-level guidance is sufficient (the reviewer is a trusted agent, and the verifyStep re-review is the safety net)
