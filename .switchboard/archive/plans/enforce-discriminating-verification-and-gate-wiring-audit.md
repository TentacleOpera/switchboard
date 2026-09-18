# Enforce Discriminating Verification Checks + Gate-Wiring Audit + Skip-Tests Disclosure at Review

## Metadata
- **Complexity:** 5
- **Tags:** backend, test, refactor, docs
- **Project:** Browser Switchboard

## Goal

Close the structural hole that let the verb-engine burndowns reach CODE REVIEWED at ~20% completion: plan verification sections currently allow non-discriminating checks (e.g. `npm run compile-tests`) that pass on incomplete work. This plan adds three coupled rules — one at plan authoring time, two at review time — so that every plan's automated verification must include at least one check whose exit code discriminates done from not-done, the reviewer must audit that those checks are actually wired into CI (not just defined in `package.json`), and when the reviewer operates under skip-tests/skip-compilation directives it must explicitly disclose that constraint in its findings so a "CODE REVIEWED" verdict is never silently downgraded.

### Problem / root-cause analysis

The verb-engine feature (`verb-engine-remaining-provider-burndowns...`) shipped with Setup at `return=2/break=123` and TaskViewer at `return=0/break=146` — reads still `break`-ed, HTTP callers got `{success:true}` with no data. It reached CODE REVIEWED green because:

1. **Plan-time hole:** The `## Verification Plan → ### Automated` section in the burndown plans listed `parity:check` and `push-routing:check` — both pass on incomplete work because they verify dispatch *shape* and vscode-*absence*, not whether arms *return* data. The improve-plan SKILL.md (line 71-72) defines this section as just `### Automated Tests` with no quality bar on what counts as a valid automated check. The AGENTS.md "Plan Authoring & Problem Analysis Protocol" (line 126+) is silent on verification quality. So a plan whose automated verification is structurally incapable of detecting incomplete work is fully compliant.

2. **Review-time hole (gate wiring):** The reviewer prompt (`DEFAULT_REVIEWER_BASE_INSTRUCTIONS`, agentPromptBuilder.ts:1169-1178) step 5 says "Run verification checks (typecheck/tests as applicable)" — but never asks the reviewer to verify that the checks named in the plan are actually *wired into CI*. The return-contract ratchet plan's own review found that `verb-returns:check` was defined in `package.json` and documented but **not invoked by CI** (`.github/workflows/integration-tests.yml` ran only `parity:check` + `push-routing:check`). A gate that isn't wired is a gate that doesn't exist.

3. **Review-time hole (skip-tests silence):** The `skipBlock` (agentPromptBuilder.ts:990-993) passes `SKIP_TESTS_DIRECTIVE` / `SKIP_COMPILATION_DIRECTIVE` to the reviewer via `assembleSuffix` (line 1232). The reviewer's base instructions step 5 says "Run verification checks ... *unless specified otherwise in this prompt*" — so skip-tests is the escape hatch. But nothing forces the reviewer to *disclose that it used the escape hatch*. The review findings get written to the plan file the same way whether the reviewer ran the tests or not. A reader of "CODE REVIEWED" can't tell the difference between "tests passed" and "tests were never run." This is a silent downgrade: the verdict looks equivalent to a full review but is structurally weaker.

These three holes are coupled: the gate-wiring audit only makes sense if the plan-time rule exists (otherwise there's nothing to audit), the plan-time rule is toothless without the gate-wiring audit (otherwise unwired gates pass silently), and both are undermined if the reviewer can operate under skip-tests without disclosing it (the verdict appears complete when the discriminating checks were never executed).

## User Review Required
- **Mechanical-change exemption (default recorded):** should plans with complexity ≤ 2 (trivial config/copy/typo fixes) be exempt from the discriminating-check requirement, with the planner explicitly marking "No discriminating check needed — mechanical change" (mirroring the architecture review's existing mechanical-change escape hatch at improve-plan SKILL.md line 93)? **Recommendation: yes, exempt with explicit marking.** Forcing a discriminating CI gate on a one-line typo fix is disproportionate, and the architecture review already has this pattern. The exemption is claimed, not assumed — a wrong "this is mechanical" is the exact failure to catch.

## Scope

### ✅ IN SCOPE
- **Plan-time rule (Option 1):** Add a "Discriminating Verification" requirement to the improve-plan SKILL.md's `## Verification Plan` section definition, and to the AGENTS.md "Plan Authoring & Problem Analysis Protocol" section. The rule: the `### Automated` subsection must include at least one check whose exit code discriminates done from not-done — not just a command that passes when run. `compile-tests` / `build` / `typecheck` alone are insufficient because they pass on incomplete work. Manual/behavioral criteria may supplement but cannot be the sole acceptance signal. Complexity ≤ 2 plans may claim a mechanical-change exemption with explicit marking.
- **Review-time rule (Option 2):** Add a gate-wiring audit step to `DEFAULT_REVIEWER_BASE_INSTRUCTIONS` in `agentPromptBuilder.ts`. The new step: verify that every automated check named in the plan's `### Automated` verification subsection is actually invoked by CI (grep `.github/workflows/`, `package.json` aggregate scripts, or equivalent gate wiring) — not just defined. If a check is defined but not wired, that is a MAJOR finding (the exact "green while incomplete" hole).
- **Skip-tests disclosure rule (Option 2b):** When the reviewer operates under `SKIP_TESTS_DIRECTIVE` or `SKIP_COMPILATION_DIRECTIVE`, the reviewer must explicitly disclose in its findings that verification was static-only and the plan's automated checks were not executed. The verdict is provisional: the card can move to CODE REVIEWED, but the findings must note that the discriminating checks were not run, so a subsequent pass with tests enabled is needed for full confidence. The gate-wiring audit (step 6) still applies — it is static analysis and works without running anything.
- **Sync:** The same wording goes into both AGENTS.md and improve-plan SKILL.md so the planner (which reads the SKILL.md) and the consultation-mode prompt (which embeds AGENTS.md rules) enforce the same bar.
- **Regression test:** Add or extend a prompt-builder unit test to assert the reviewer base instructions contain the gate-wiring audit step (similar to `autoban-reviewer-prompt-regression.test.js`).

### ⚙️ OUT OF SCOPE
- Retroactively fixing existing plans' verification sections — the rule applies at creation/improvement time only.
- Building a tool that statically verifies a plan's automated checks are discriminating — this is a human/agent judgment call encoded as a rule, not an automated checker.
- Adding new CI gates for specific features — that's per-feature work (the return-contract ratchet plan is the example).
- Changes to the tester role's prompt (product acceptance reviewer) — the gate-wiring audit is a code-review concern, not an intent-review concern.

## Implementation Steps

### 1. improve-plan SKILL.md — add discriminating-verification requirement
**File:** `.agents/skills/improve-plan/SKILL.md` (and `.claude/skills/improve-plan/SKILL.md` if it mirrors)

Update the `## Verification Plan` section definition (currently line 71-72, just `### Automated Tests`) to:

```markdown
9. **## Verification Plan**
   - ### Automated
     - **Discriminating-check requirement:** must include at least one check
       whose exit code discriminates done from not-done — not just a command
       that passes when run. `compile-tests` / `build` / `typecheck` alone are
       insufficient because they pass on incomplete work. The check must fail
       if the plan's stated goal is unmet, even if the code compiles.
     - **Mechanical-change exemption:** plans with complexity ≤ 2 may omit the
       discriminating check by explicitly writing "No discriminating check
       needed — mechanical change" in the Automated subsection. A wrong claim
       is the failure this exists to catch.
   - ### Manual / behavioral
     - May supplement but cannot be the sole acceptance signal.
```

### 2. AGENTS.md — add the rule to the Plan Authoring protocol
**File:** `AGENTS.md` (and `CLAUDE.md` if it mirrors the protocol section)

Add to the "Plan Authoring & Problem Analysis Protocol" section (after the existing Plan Sizing bullet, before Workspace Detection):

```markdown
- **Discriminating Verification:** Every plan's `## Verification Plan → ### Automated`
  section must include at least one check whose exit code discriminates done from
  not-done. `compile-tests` / `build` / `typecheck` alone are insufficient — they
  pass on incomplete work. The check must fail if the plan's stated goal is unmet.
  Manual/behavioral criteria may supplement but cannot be the sole acceptance signal.
  Plans with complexity ≤ 2 may claim a mechanical-change exemption by explicitly
  writing "No discriminating check needed — mechanical change" in the Automated
  subsection. This rule is enforced at plan creation and improvement time; existing
  plans are not retroactively modified.
```

### 3. agentPromptBuilder.ts — add gate-wiring audit + skip-tests disclosure to reviewer base instructions
**File:** `src/services/agentPromptBuilder.ts`

Add two new steps to `DEFAULT_REVIEWER_BASE_INSTRUCTIONS` (lines 1169-1178), between current step 5 (run verification) and step 6 (update plan file). The new steps:

```
6. Gate-wiring audit: for every automated check named in the plan's
   `### Automated` verification subsection, verify it is actually invoked by CI
   (grep `.github/workflows/`, `package.json` aggregate scripts, or equivalent
   gate wiring) — not just defined. A check that is defined in `package.json`
   but not invoked by CI is a MAJOR finding: it is the exact "green while
   incomplete" hole. Name the check, where it is defined, and where (if anywhere)
   it is invoked. This step is static analysis — it applies even when
   skip-tests/skip-compilation directives are active.
7. Skip-tests disclosure: if this prompt includes a SKIP TESTS or SKIP
   COMPILATION directive, you MUST state in your review findings:
   "Verification was static-only — the plan's automated checks were not
   executed in this review pass." The review verdict is provisional: the card
   may move to CODE REVIEWED, but the findings must note that the
   discriminating checks were not run and a subsequent pass with tests enabled
   is needed for full confidence. Do not omit this disclosure even if all
   other findings are clean.
```

Renumber the existing step 6 (update plan file) → 8, and step 7 (structured summary) → 9.

**WARNING:** The string replacements at lines 1189-1206 are coupled to the exact text of `DEFAULT_REVIEWER_BASE_INSTRUCTIONS`. The replacement at line 1200 targets the text "Update the original plan file with fixed items, files changed, validation results, and remaining risks. Do NOT truncate, summarize, or delete existing implementation steps." — this text is in the current step 6, which becomes step 8. The replacement will still work because it matches on text content, not step number. Verify this after editing.

### 4. Regression test — assert gate-wiring audit + skip-tests disclosure in reviewer prompt
**File:** `src/test/autoban-reviewer-prompt-regression.test.js` (or a new test file)

Add test cases that build a reviewer prompt and assert the output contains:
- The gate-wiring audit text (e.g. "Gate-wiring audit" or "verify it is actually invoked by CI").
- The skip-tests disclosure text (e.g. "Skip-tests disclosure" or "Verification was static-only").

Add a second test case that builds a reviewer prompt *with* `skipTests: true` and asserts the skip-tests disclosure step is present and references the static-only constraint. This prevents either step from being silently dropped in a future refactor.

> **Superseded:** "Add test cases that build a reviewer prompt and assert the output contains"
> **Reason:** The existing regression test (`autoban-reviewer-prompt-regression.test.js`) uses a source-grep pattern — it reads `agentPromptBuilder.ts` as text and asserts `.includes()`. It does not build a prompt at runtime. Introducing runtime prompt-building would require importing the TS module in a plain `.js` test and diverges from the established, lower-complexity pattern. Verified: the existing test (lines 1-39) reads the builder source as a string and asserts substrings — no prompt construction.
> **Replaced with:** Extend the existing source-grep pattern — read `agentPromptBuilder.ts` as text and assert the source contains the gate-wiring audit text (e.g. `Gate-wiring audit`) and the skip-tests disclosure text (e.g. `Skip-tests disclosure` / `Verification was static-only`). For the skip-tests case, assert the disclosure step text is present in the static base instructions (the step is always present in the prompt; its conditional fires on the directive, which lives in the suffix block). This is a **prompt-content presence test**, not a behavior test — label it honestly. It guards against the steps being silently dropped from the source, not against the reviewer failing to act on them.

### 5. Verify
- `npm run compile-tests` passes.
- The new regression tests pass.
- Manually inspect a generated reviewer prompt (without skip-tests) to confirm: (a) the gate-wiring audit step is present, (b) the skip-tests disclosure step is present, (c) step numbering is sequential (1-9).
- Manually inspect a generated reviewer prompt (with skip-tests enabled) to confirm the skip-tests disclosure step is present and the static-only constraint is stated.
- Manually inspect the improve-plan SKILL.md and AGENTS.md to confirm the discriminating-check requirement is present and consistent.

### 6. improve-plan SKILL.md — wire discriminating-check enforcement into the architecture review (step 4)
**File:** `.agents/skills/improve-plan/SKILL.md` (and `.claude/skills/improve-plan/SKILL.md` mirror)

The plan's own Adversarial Synthesis notes that the discriminating-check rule's value "depends on the improve-plan skill's architecture review (step 4) actually challenging the verification plan, not just the implementation approach." Step 4 currently challenges the *implementation approach*; it does not explicitly name the verification plan as a challenge target. Without this wiring, a planner can satisfy the new rule nominally (write `compile-tests` as the "discriminating" check) and step 4 won't catch it — the hole is recreated one layer up.

Add to step 4's challenge list (after the "Goal-vs-appearance probe" bullet, before the "Output" bullet):

```markdown
- **Verification-plan probe:** does the plan's `### Automated` verification subsection
  actually include a check whose exit code discriminates done from not-done? A check
  that passes when the code compiles but the goal is unmet is non-discriminating
  (e.g. `compile-tests`, `build`, `typecheck` alone). If the plan claims a
  mechanical-change exemption, is the claim correct? Name the check and argue why
  it discriminates — or flag it as a top finding.
```

This closes the named-but-unacted gap: the rule is now enforced at the only hook that challenges a plan during authoring. Update both the `.agents/` and `.claude/` mirrors (they are separate files, not symlinks — the `.claude/` version carries YAML frontmatter the `.agents/` version lacks; preserve it).

## Complexity Audit
### Routine
- Adding a text block to two markdown protocol files (SKILL.md, AGENTS.md).
- Adding two numbered steps to a template string in agentPromptBuilder.ts.
- Adding regression test assertions.
### Complex / Risky
- **String-replacement coupling:** The reviewer base instructions have `replace()` calls coupled to exact text (lines 1189-1206). Inserting two new steps shifts text positions but the replacements match on content not line number — still, verify after editing. If the replacement target text moves relative to other replace targets, the concise-mode and compact-mode overrides could interact unexpectedly.
- **Protocol drift across mirrors:** AGENTS.md, CLAUDE.md, `.agents/skills/improve-plan/SKILL.md`, and `.claude/skills/improve-plan/SKILL.md` may all carry the same protocol text. The plan must update all mirrors or they will drift. Check which files are symlinks vs copies before editing.
- **Skip-tests disclosure conditional:** The disclosure step must fire only when skip-tests/skip-compilation is active. The reviewer base instructions are static text — the step is always present in the prompt, but its instruction is conditional ("if this prompt includes a SKIP TESTS or SKIP COMPILATION directive"). The reviewer must self-detect whether the directive is present in its prompt. This is reliable because the directive is in the same prompt, but verify the wording is unambiguous enough that a reviewer under skip-tests actually triggers the disclosure.

## Edge-Case & Dependency Audit
- **Race Conditions:** None — protocol files are read at prompt-generation time, not concurrently.
- **Security:** None.
- **Side Effects:** Existing plans with weak verification sections are not retroactively modified. The rule applies forward-only (creation + improvement). This is intentional — retroactive modification would be a large, separate effort.
- **Dependencies & Conflicts:** The return-contract ratchet plan (`verb-engine-return-contract-ratchet.md`) is the canonical example of a discriminating check done right. This plan generalizes that pattern as a rule. No conflict — they reinforce each other.

## Dependencies
- None. This plan is self-contained protocol + prompt changes.

## Adversarial Synthesis

**Risk Summary:** The discriminating-check requirement is a judgment call, not a mechanically verifiable property — a planner could claim `compile-tests` is discriminating when it isn't, and no tool catches the lie. The original plan named this dependency ("the rule's value depends on step 4 actually challenging the verification plan") but did not wire enforcement into step 4 — a named-but-unacted gap that recreated the hole one layer up; Implementation Step 6 now closes it by adding a verification-plan probe to the architecture review. The gate-wiring audit adds reviewer workload and could become a checkbox if the reviewer doesn't actually grep CI config; the regression test guards prompt *content* (source-grep), not reviewer *behavior*. The skip-tests disclosure relies on the reviewer self-detecting the skip directive in the suffix block — if the directive is buried the disclosure could be omitted; a future robustness improvement would inject a `⚠️ SKIP-TESTS ACTIVE` flag dynamically when `skipTests` is true. The mechanical-change exemption is the obvious escape hatch for lazy planners — but it's claimed, not assumed, and step 4's new verification-plan probe now checks the claim. The three rules together raise the floor but don't eliminate the need for a sharp reviewer; they make the failure modes *visible* rather than *invisible*, which is the achievable goal.

## Proposed Changes

### `.agents/skills/improve-plan/SKILL.md` (+ `.claude/skills/improve-plan/SKILL.md` mirror)
- **Context:** The Verification Plan section definition (line 71-72) has no quality bar on what counts as a valid automated check. Step 4 (architecture review) challenges the implementation approach but not the verification plan.
- **Logic:** Add a discriminating-check requirement + mechanical-change exemption to the `### Automated` subsection definition; add a `### Manual / behavioral` subsection; add a verification-plan probe to step 4's challenge list.
- **Implementation:** See Implementation Steps §1 and §6.
- **Edge Cases:** The `.claude/` mirror is a separate file (not a symlink) carrying YAML frontmatter the `.agents/` version lacks — edit both, preserve frontmatter.

### `AGENTS.md` (+ `CLAUDE.md` mirror)
- **Context:** The "Plan Authoring & Problem Analysis Protocol" section (line 126+) is silent on verification quality.
- **Logic:** Add a "Discriminating Verification" bullet after the Plan Sizing bullet (line 135), before the Workspace Detection header (line 137).
- **Implementation:** See Implementation Steps §2.
- **Edge Cases:** CLAUDE.md mirrors the protocol section (line 157+) — update both. Both are separate files, not symlinks.

### `src/services/agentPromptBuilder.ts`
- **Context:** `DEFAULT_REVIEWER_BASE_INSTRUCTIONS` (lines 1169-1178) step 5 runs verification but never audits gate wiring; skip-tests disclosure is silent. `skipBlock` (lines 990-993) passes the skip directives via `assembleSuffix` (line 1232).
- **Logic:** Insert step 6 (gate-wiring audit) + step 7 (skip-tests disclosure) between current step 5 and step 6; renumber existing 6→8, 7→9.
- **Implementation:** See Implementation Steps §3. String replacements at lines 1189-1206 match on text content not line number — the compact-mode replacement (line 1200) targets text in the renumbered step 8; verify it still matches after editing.
- **Edge Cases:** Concise-mode (line 1193-1196) and compact-mode (line 1197-1206) replacements target text in the renumbered step 8 — confirm both still produce coherent output.

### `src/test/autoban-reviewer-prompt-regression.test.js`
- **Context:** Existing regression test uses a source-grep pattern (reads `agentPromptBuilder.ts` as text, asserts `.includes()` — lines 1-39). It does not build a prompt at runtime.
- **Logic:** Extend with assertions that the source contains the gate-wiring audit text and the skip-tests disclosure text. This is a prompt-content presence test, not a behavior test.
- **Implementation:** See Implementation Steps §4 (corrected to source-grep pattern via Superseded callout).
- **Edge Cases:** Source-grep proves text presence, not reviewer behavior — label the test honestly. A future robustness improvement (out of scope) would add a runtime prompt-build test.

## Verification Plan
### Automated
- **Discriminating check:** the new regression test asserting the reviewer prompt source contains the gate-wiring audit step and the skip-tests disclosure step — this test FAILS if the steps are absent from `agentPromptBuilder.ts`, so it discriminates done from not-done for this plan's core deliverable.
- `npm run compile-tests` passes after all edits (supplementary — compile-only, non-discriminating per this plan's own rule; ensures TypeScript compiles but passes on incomplete work).
- A regression test with `skipTests: true` asserts the skip-tests disclosure text is present.
- `npm run verb-returns:check` still passes (unaffected — this plan doesn't touch verb-engine code).
### Manual / behavioral
- Generate a reviewer prompt (without skip-tests) for a test plan and confirm: (a) the gate-wiring audit step is present, (b) the skip-tests disclosure step is present, (c) step numbering is sequential (1-9), (d) the concise-mode and compact-mode string replacements still produce coherent output.
- Generate a reviewer prompt with `skipTests: true` and confirm the skip-tests disclosure step is present and the static-only constraint is stated.
- Read the updated improve-plan SKILL.md and AGENTS.md and confirm the discriminating-check requirement is present, consistent across both, and the mechanical-change exemption is documented.
- Confirm step 4 of improve-plan SKILL.md now includes the verification-plan probe (Implementation Step 6).
- Confirm all mirror files (`.claude/skills/improve-plan/SKILL.md`, `CLAUDE.md`) are updated and consistent — these are separate copies, not symlinks; diff them against the `.agents/`/`AGENTS.md` versions to confirm the protocol text matches (frontmatter may differ).

---

**Recommendation:** Complexity 5 → **Send to Coder.**

## Review Findings

Reviewer pass found the original implementation incomplete: Steps 1, 2, and 6 were never applied — the discriminating-check requirement was absent from both improve-plan SKILL.md mirrors, the Discriminating Verification bullet was absent from AGENTS.md and CLAUDE.md, and the verification-plan probe was missing from step 4 of both SKILL.md mirrors, yet the prior Review Findings falsely claimed "Implemented all six implementation steps." Steps 3 and 4 (agentPromptBuilder.ts gate-wiring audit + skip-tests disclosure steps, and the regression test) were correctly done and verified — the regression test passes and step numbering is sequential 1-9. Fixes applied this pass: added the discriminating-check requirement + mechanical-change exemption + Manual/behavioral subsection to the Verification Plan section of both `.agents/skills/improve-plan/SKILL.md` and `.claude/skills/improve-plan/SKILL.md`; added the verification-plan probe to step 4 of both mirrors; added the Discriminating Verification bullet to `AGENTS.md` and `CLAUDE.md` after the Plan Sizing bullet. Verification was static-only per SKIP COMPILATION + SKIP TESTS directives — `npm run compile-tests` was not run; the regression test (`node src/test/autoban-reviewer-prompt-regression.test.js`) passed, and manual inspection confirmed mirror consistency and that the compact-mode/concise-mode string replacements still match their targets in the renumbered step 8. Remaining risk: the regression test only asserts agentPromptBuilder.ts source text (Steps 3-4); it does not guard the SKILL.md/AGENTS.md protocol text (Steps 1, 2, 6) against silent removal — a future robustness improvement (out of scope) would add source-grep assertions for the protocol files.
