# Enforce Discriminating Verification Checks + Gate-Wiring Audit at Review

## Metadata
- **Complexity:** 4
- **Tags:** backend, test, refactor, docs
- **Project:** Browser Switchboard

## Goal

Close the structural hole that let the verb-engine burndowns reach CODE REVIEWED at ~20% completion: plan verification sections currently allow non-discriminating checks (e.g. `npm run compile-tests`) that pass on incomplete work. This plan adds two coupled rules — one at plan authoring time, one at review time — so that every plan's automated verification must include at least one check whose exit code discriminates done from not-done, and the reviewer must audit that those checks are actually wired into CI (not just defined in `package.json`).

### Problem / root-cause analysis

The verb-engine feature (`verb-engine-remaining-provider-burndowns...`) shipped with Setup at `return=2/break=123` and TaskViewer at `return=0/break=146` — reads still `break`-ed, HTTP callers got `{success:true}` with no data. It reached CODE REVIEWED green because:

1. **Plan-time hole:** The `## Verification Plan → ### Automated` section in the burndown plans listed `parity:check` and `push-routing:check` — both pass on incomplete work because they verify dispatch *shape* and vscode-*absence*, not whether arms *return* data. The improve-plan SKILL.md (line 71-72) defines this section as just `### Automated Tests` with no quality bar on what counts as a valid automated check. The AGENTS.md "Plan Authoring & Problem Analysis Protocol" (line 126+) is silent on verification quality. So a plan whose automated verification is structurally incapable of detecting incomplete work is fully compliant.

2. **Review-time hole:** The reviewer prompt (`DEFAULT_REVIEWER_BASE_INSTRUCTIONS`, agentPromptBuilder.ts:1169-1178) step 5 says "Run verification checks (typecheck/tests as applicable)" — but never asks the reviewer to verify that the checks named in the plan are actually *wired into CI*. The return-contract ratchet plan's own review found that `verb-returns:check` was defined in `package.json` and documented but **not invoked by CI** (`.github/workflows/integration-tests.yml` ran only `parity:check` + `push-routing:check`). A gate that isn't wired is a gate that doesn't exist.

These two holes are coupled: the review-time audit only makes sense if the plan-time rule exists (otherwise there's nothing to audit), and the plan-time rule is toothless without the review-time audit (otherwise unwired gates pass silently).

## User Review Required
- **Mechanical-change exemption (default recorded):** should plans with complexity ≤ 2 (trivial config/copy/typo fixes) be exempt from the discriminating-check requirement, with the planner explicitly marking "No discriminating check needed — mechanical change" (mirroring the architecture review's existing mechanical-change escape hatch at improve-plan SKILL.md line 93)? **Recommendation: yes, exempt with explicit marking.** Forcing a discriminating CI gate on a one-line typo fix is disproportionate, and the architecture review already has this pattern. The exemption is claimed, not assumed — a wrong "this is mechanical" is the exact failure to catch.

## Scope

### ✅ IN SCOPE
- **Plan-time rule (Option 1):** Add a "Discriminating Verification" requirement to the improve-plan SKILL.md's `## Verification Plan` section definition, and to the AGENTS.md "Plan Authoring & Problem Analysis Protocol" section. The rule: the `### Automated` subsection must include at least one check whose exit code discriminates done from not-done — not just a command that passes when run. `compile-tests` / `build` / `typecheck` alone are insufficient because they pass on incomplete work. Manual/behavioral criteria may supplement but cannot be the sole acceptance signal. Complexity ≤ 2 plans may claim a mechanical-change exemption with explicit marking.
- **Review-time rule (Option 2):** Add a gate-wiring audit step to `DEFAULT_REVIEWER_BASE_INSTRUCTIONS` in `agentPromptBuilder.ts`. The new step: verify that every automated check named in the plan's `### Automated` verification subsection is actually invoked by CI (grep `.github/workflows/`, `package.json` aggregate scripts, or equivalent gate wiring) — not just defined. If a check is defined but not wired, that is a MAJOR finding (the exact "green while incomplete" hole).
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

### 3. agentPromptBuilder.ts — add gate-wiring audit to reviewer base instructions
**File:** `src/services/agentPromptBuilder.ts`

Add a new step to `DEFAULT_REVIEWER_BASE_INSTRUCTIONS` (lines 1169-1178), between current step 5 (run verification) and step 6 (update plan file). The new step:

```
6. Gate-wiring audit: for every automated check named in the plan's
   `### Automated` verification subsection, verify it is actually invoked by CI
   (grep `.github/workflows/`, `package.json` aggregate scripts, or equivalent
   gate wiring) — not just defined. A check that is defined in `package.json`
   but not invoked by CI is a MAJOR finding: it is the exact "green while
   incomplete" hole. Name the check, where it is defined, and where (if anywhere)
   it is invoked.
```

Renumber the existing step 6 (update plan file) → 7, and step 7 (structured summary) → 8.

**WARNING:** The string replacements at lines 1189-1206 are coupled to the exact text of `DEFAULT_REVIEWER_BASE_INSTRUCTIONS`. The replacement at line 1200 targets the text "Update the original plan file with fixed items, files changed, validation results, and remaining risks. Do NOT truncate, summarize, or delete existing implementation steps." — this text is in the current step 6, which becomes step 7. The replacement will still work because it matches on text content, not step number. Verify this after editing.

### 4. Regression test — assert gate-wiring audit in reviewer prompt
**File:** `src/test/autoban-reviewer-prompt-regression.test.js` (or a new test file)

Add a test case that builds a reviewer prompt and asserts the output contains the gate-wiring audit text (e.g. "Gate-wiring audit" or "verify it is actually invoked by CI"). This prevents the step from being silently dropped in a future refactor.

### 5. Verify
- `npm run compile-tests` passes.
- The new regression test passes.
- Manually inspect a generated reviewer prompt to confirm the gate-wiring audit step appears and step numbering is correct.
- Manually inspect the improve-plan SKILL.md and AGENTS.md to confirm the discriminating-check requirement is present and consistent.

## Complexity Audit
### Routine
- Adding a text block to two markdown protocol files (SKILL.md, AGENTS.md).
- Adding a numbered step to a template string in agentPromptBuilder.ts.
- Adding a regression test assertion.
### Complex / Risky
- **String-replacement coupling:** The reviewer base instructions have `replace()` calls coupled to exact text (lines 1189-1206). Inserting a new step shifts text positions but the replacements match on content not line number — still, verify after editing. If the replacement target text moves relative to other replace targets, the concise-mode and compact-mode overrides could interact unexpectedly.
- **Protocol drift across mirrors:** AGENTS.md, CLAUDE.md, `.agents/skills/improve-plan/SKILL.md`, and `.claude/skills/improve-plan/SKILL.md` may all carry the same protocol text. The plan must update all mirrors or they will drift. Check which files are symlinks vs copies before editing.

## Edge-Case & Dependency Audit
- **Race Conditions:** None — protocol files are read at prompt-generation time, not concurrently.
- **Security:** None.
- **Side Effects:** Existing plans with weak verification sections are not retroactively modified. The rule applies forward-only (creation + improvement). This is intentional — retroactive modification would be a large, separate effort.
- **Dependencies & Conflicts:** The return-contract ratchet plan (`verb-engine-return-contract-ratchet.md`) is the canonical example of a discriminating check done right. This plan generalizes that pattern as a rule. No conflict — they reinforce each other.

## Dependencies
- None. This plan is self-contained protocol + prompt changes.

## Adversarial Synthesis

**Risk Summary:** The discriminating-check requirement is a judgment call, not a mechanically verifiable property — a planner could claim `compile-tests` is discriminating when it isn't, and no tool catches the lie. The rule's value depends on the improve-plan skill's architecture review (step 4) actually challenging the verification plan, not just the implementation approach. The gate-wiring audit adds reviewer workload and could become a checkbox if the reviewer doesn't actually grep CI config. The mechanical-change exemption is the obvious escape hatch for lazy planners — but it's claimed, not assumed, and a wrong claim is a review finding.

## Verification Plan
### Automated
- `npm run compile-tests` passes after all edits.
- New regression test asserts the reviewer prompt contains the gate-wiring audit step.
- `npm run verb-returns:check` still passes (unaffected — this plan doesn't touch verb-engine code).
### Manual / behavioral
- Generate a reviewer prompt for a test plan and confirm: (a) the gate-wiring audit step is present, (b) step numbering is sequential (1-8), (c) the concise-mode and compact-mode string replacements still produce coherent output.
- Read the updated improve-plan SKILL.md and AGENTS.md and confirm the discriminating-check requirement is present, consistent across both, and the mechanical-change exemption is documented.
- Confirm all mirror files (`.claude/skills/improve-plan/SKILL.md`, `CLAUDE.md`) are updated or are symlinks to the `.agents/` versions.
