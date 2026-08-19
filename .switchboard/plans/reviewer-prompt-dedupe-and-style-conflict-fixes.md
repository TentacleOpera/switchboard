# Reviewer Prompt — Retire the Duplicate Completion Report, the Phantom Override, and the Three-Way Style Conflict

## Goal

The reviewer dispatch prompt instructs the agent to append a completion summary to the plan file **twice**, tells it a persona rule is "modified" when that rule appears nowhere in the prompt, layers three mutually-interfering output-style directives, and ships a ~120-word conditional disclosure block plus an inapplicable regression-analysis item on every dispatch regardless of whether their conditions hold. Each defect costs the reviewer agent reconciliation effort on presentation rather than correctness, and two of them (the duplicate append, the phantom override) produce visibly redundant or unresolvable instructions. This plan fixes all six in `DEFAULT_REVIEWER_BASE_INSTRUCTIONS` and the `role === 'reviewer'` branch, converts the step list from a numbering-fragile template literal to a composed array, and upgrades the CI gate from source-text presence to behavioural assertions so the fixes are actually pinned.

### Problem analysis and root cause

Six defects, all in `src/services/agentPromptBuilder.ts`. Observed on a live reviewer dispatch running the user's actual configuration — `reviewerConciseModeEnabled`, `reviewerCompactPlanUpdateEnabled`, `advancedReviewerEnabled` and `cavemanOutputEnabled` all ON.

**A. The plan-file append is instructed twice. Root cause: a sentinel miss.**
`ensureCompletionDirective` (`:978-983`) appends `CODING_COMPLETION_REPORT_DIRECTIVE` (`:968`) unless the literal token `COMPLETION REPORT:` is already present in the text. The reviewer's own plan-update step — item 9, `:1766` in default form, rewritten at `:1787-1792` when `reviewerCompactPlanUpdateEnabled` is on — never contains that token. So `ensureDispatchProtocolDirectives(baseInstructions, …)` at `:1816` always fires, and the reviewer receives:

- item 9: *"Update the original plan file by appending a brief summary (≤ 5 sentences) under `## Review Findings` — list files changed, validation results, and remaining risks."*
- plus: *"COMPLETION REPORT: When you have finished implementing the plan, append a brief summary (3-5 sentences) to the END of the original plan file. Include: what you implemented, files changed, and any issues encountered."*

Two headings, two sentence caps, substantially identical content, for one file. `NO_SEPARATE_REVIEW_ARTIFACTS_DIRECTIVE` (`:955`) compounds the ambiguity by pointing at *"the COMPLETION REPORT step"* — which, with item 9 worded as it is, names the appended generic directive rather than the reviewer's own step. The duplication is not intentional: the load-bearing comment above `CODING_COMPLETION_REPORT_DIRECTIVE` explains the guard exists so a `replace`-mode `defaultPromptOverride` cannot silently drop the completion handshake and leave cards stuck on. That override-proofing is correct and must survive; what is wrong is that it fires even when the reviewer's own step is present.

**B. The OVERRIDE modifies a rule that exists nowhere.**
`:1798-1800` appends: *"OVERRIDE: When Concise Review Mode is active, the persona rule \"Explain why something is a problem\" is modified: give a one-sentence reason per finding instead of explanatory prose."* The string `Explain why something is a problem` occurs **exactly once in the entire repository — inside that sentence**. It is absent from `DEFAULT_REVIEWER_BASE_INSTRUCTIONS`, from `.agents/`, and from `.claude/`. The agent is told a named rule is amended without ever being given the rule, so it must infer the original in order to apply the amendment. This is a leftover reference to a persona file that no longer feeds this path (cf. the shipped fact that personas are dead on the dispatch path).

**C. Three output-style directives interfere.**
Concurrently active on a single dispatch: the Stage 1 persona (`:1735`, softened at `:1783-1786` to *"brief theatrical intro welcome, then keep each finding to one terse bullet"*), the OVERRIDE's *"Theatrical tone is welcome; verbosity is not"* (`:1799`), and `CAVEMAN_OUTPUT_DIRECTIVE` with a scope carve-out (`:1805`: *"Note: Caveman style applies to code-fix and verification steps only; review stages use Concise Mode."*). The carve-out asks the agent to switch register mid-response and decide, per paragraph, which of three styles governs. Caveman phrasing is also actively counterproductive for the highest-value output a reviewer produces — the mechanism of a regression — so the carve-out's own boundary pushes caveman onto exactly the steps where terseness matters least. Concise Mode already delivers the token reduction caveman exists for; running both is redundant, and the note that reconciles them is itself overhead.

**D. Item 7 (skip-tests disclosure) ships unconditionally for an absent condition.**
`:1747-1754` is ~120 words of instruction whose entire body is guarded by *"if this prompt contains an explicit \"SKIP TESTS:\" or \"SKIP COMPILATION:\" line"*. The builder already resolves `skipCompilation` and `skipTests` as booleans at `:1485-1486` and uses them at `:1518-1519` to gate `skipBlock`. The reviewer branch therefore knows, at composition time, whether the condition can hold — and emits the block anyway.

**E. `ADVANCED_REVIEWER_DIRECTIVE` item 2 is unconditional and frequently inapplicable.**
`:1296` defines a fixed five-item block; item 2 is *"Check for double-trigger bugs: if you add a UI refresh, verify no caller already triggers one."* On a change that touches no UI or event path it carries nothing, and unlike items 1/3/4/5 it is not self-limiting. The block is shared with the custom-agent path (`:2438`), so the fix must be safe for both.

**F. Root cause of the fragility behind A–E: the step list is a template literal with hardcoded numbering, mutated by exact-text `.replace()` calls.**
`:1779-1781` carries an explicit warning: *"The string replacements below are coupled to the exact text of `DEFAULT_REVIEWER_BASE_INSTRUCTIONS`. If that text changes, these replacements will silently fail. Update them in tandem."* Three such replacements exist (`:1783-1786`, `:1787-1792`, `:1793-1796`). Conditioning any step (D) additionally requires renumbering 8→7, 9→8, 10→9, which regex surgery on a literal cannot do safely. The self-documented silent-failure mode is the reason these defects accumulated: editing this block is hazardous, so it was not edited.

**G. The CI gate cannot detect any of this.**
`src/test/autoban-reviewer-prompt-regression.test.js` (wired at `.github/workflows/integration-tests.yml:382` via `test:contract:reviewer-prompt`, `package.json:837`) reads the builder's **source text** and makes 17 `builderSource.includes('…')` assertions. It never calls `buildKanbanBatchPrompt`. It therefore cannot see that a block is emitted twice, emitted when its condition is false, or no longer emitted at all — only that the literal still exists somewhere in the `.ts` file. This is precisely the "green while incomplete" hole that the reviewer prompt's own item 6 instructs reviewers to hunt for, present in the gate that guards the reviewer prompt.

## Metadata

**Tags:** backend, prompt-engineering, reliability, tech-debt
**Complexity:** 5

## User Review Required

None. Every fix has one defensible resolution: the duplicate append is a sentinel miss with a documented reason the guard must stay (so the fix is to satisfy the sentinel, not remove the guard); the phantom override references a string that exists nowhere; caveman and Concise Mode are redundant by construction; items 7 and E have in-scope booleans or a one-line self-gating rewording available. No new settings, no new modes, no UI.

## Complexity Audit

### Routine
- Deleting the OVERRIDE append (`:1798-1800`) — the rule it modifies does not exist, so nothing is lost. Its one substantive clause (one-sentence reason per finding) folds into the Stage 1 concise variant where it belongs.
- Rewording `ADVANCED_REVIEWER_DIRECTIVE` item 2 (`:1296`) to be self-limiting — one line, no plumbing, no flag.
- Gating item 7 emission on `skipTests || skipCompilation` — both booleans already resolved at `:1485-1486`.
- Suppressing `CAVEMAN_OUTPUT_DIRECTIVE` for the reviewer when `reviewerConciseModeEnabled` — one condition, and it deletes the carve-out note rather than adding anything.

### Complex / Risky
- **Satisfying the `COMPLETION REPORT:` sentinel without breaking override-proofing.** The fix is to make item 9 carry the literal token, so `ensureCompletionDirective` recognises the handshake as already present. This must preserve the documented guarantee: when a `replace`-mode `defaultPromptOverride` wipes the composed base, item 9 goes with it, the sentinel disappears, and the generic directive is appended exactly as today. The failure mode if this is got wrong is silent and expensive — cards never clear their working-state light and oversight passes time out on work that succeeded. It must be pinned behaviourally in both directions (override absent → one occurrence; `replace` override present → still one occurrence).
- **`ensureDispatchProtocolDirectives` is applied at two layers.** Once in the builder (`:1816`) and again at the pty/HTTP delivery boundary (`TaskViewerProvider.ts:578`). Idempotency via the sentinel is what makes double application safe, so the sentinel change alters behaviour on both layers simultaneously — correctly, but it means the delivery path must be reasoned about, not just the builder. `directivesAttached` at `TaskViewerProvider.ts:579-581` is a response label array only; it does not parse the plan file and is unaffected.
- **Converting the step list from literal to composed array retires the documented silent-failure hazard, but touches all three existing `.replace()` sites.** With steps as array entries, the concise Stage 1 variant and the compact plan-update variant become entry selection instead of string surgery, and numbering is derived rather than hardcoded — which is what makes conditioning item 7 safe. The migration must keep every literal substring the CI gate asserts, or 17 source-presence assertions fail at once.
- **Numbering is referenced from inside the prompt.** Item 6 ends *"it applies even when skip-tests/skip-compilation directives are active"* and the trailing CRITICAL line (`:1768`) names *"Stage 1"* and *"Stage 2"*. Derived numbering must not orphan any cross-reference; the safest form keeps step *names* (Stage 1, Stage 2, gate-wiring audit) as the referents and treats numbers as presentation only.

## Edge-Case & Dependency Audit

**Race Conditions** — none. Pure synchronous prompt composition.

**Security** — none. No new surface; no new input is read.

**Side Effects** — the shipped reviewer prompt changes. Reviewer dispatches lose one duplicated instruction block, the phantom OVERRIDE paragraph, the caveman block when Concise Mode is on, and item 7 when no skip flag is set. No other role's prompt changes except via `ADVANCED_REVIEWER_DIRECTIVE` item 2's rewording, which also reaches custom agents that opt in at `:2438`.

**Dependencies & Conflicts**
- **`ensureCompletionDirective` must not be modified.** Its idempotence and its post-override placement are load-bearing and carry an explicit do-not-touch comment naming three consumers that break silently. The fix operates entirely on the reviewer's step text so that the guard's existing logic produces the desired outcome.
- **`NO_SEPARATE_REVIEW_ARTIFACTS_DIRECTIVE` (`:955`) cross-references "the COMPLETION REPORT step".** Once item 9 carries the sentinel, that phrase resolves to item 9 — which is the intent. The CI gate asserts the substring `per the COMPLETION REPORT step` (test line 79), so the directive's text must not be reworded.
- **The CI gate's 17 assertions are source-presence, not behavioural.** Conditioning item 7 keeps the literal in the file, so `builderSource.includes('Skip-tests disclosure: …')` and `includes('Verification was static-only')` both still pass — which is exactly why the gate must be upgraded in the same change, or the conditioning ships unverified.
- **`reviewerConciseModeEnabled` and `reviewerCompactPlanUpdateEnabled` default to `false`** (`:1471-1472`) while `advancedReviewerEnabled` and `noSeparateReviewArtifactsEnabled` default to `true` (`:1470`, `:1473`). Both default-off and default-on paths need coverage; the observed defect set is the all-on configuration.
- **The PRD reference block is NOT part of this problem.** `buildPrdReferenceBlockFromRefs` (`:811-821`) injects a *path*, not file content — roughly forty tokens. Any apparent cost of reading the PRD is the agent's own choice to read the linked file, which is the intended lazy-resolution design. Explicitly out of scope; no change proposed.

## Dependencies

- None. `test:contract:reviewer-prompt` is already wired in CI, so the verification vehicle exists and needs extending rather than creating.

## Adversarial Synthesis

Key risks: **(1) Breaking completion detection.** Satisfying the sentinel from inside the base text is the whole mechanism; if item 9's wording drifts and loses the token, the duplicate silently returns — or worse, if the guard is "simplified" instead, a `replace` override drops the handshake and cards stick on forever. Mitigated by pinning both directions behaviourally and by leaving `ensureCompletionDirective` untouched. **(2) The literal→array migration breaking 17 gate assertions at once.** Mitigated by treating every asserted substring as a fixed contract of the migration and running the gate before and after. **(3) Over-reach into a genuine safety net.** Item 8 (ANTI-LEAKAGE) looks like a sibling of item 7 and is tempting to condition alongside it, but it guards against plan-file content inverting the reviewer's duty — a documented real failure — and its condition (a plan file claiming tests were skipped) is not knowable at composition time. It stays unconditional. Likewise the CRITICAL do-not-stop line stays. **(4) Reintroducing the fragility being removed.** The array migration must not be accompanied by new `.replace()` calls; if a variant cannot be expressed as entry selection, that is a signal the entry is wrongly factored. **(5) Renumbering orphaning cross-references.** Mitigated by making step names the referents. **(6) Scope creep into the persona/skill layer.** The phantom rule's origin is a dead persona path; chasing where it went is a separate concern — deleting the dangling reference is the whole fix here.

## Proposed Changes

### 1. `src/services/agentPromptBuilder.ts` — compose the reviewer step list from an array

Replace the `DEFAULT_REVIEWER_BASE_INSTRUCTIONS` template literal (`:1733-1768`) with a composed form built inside the `role === 'reviewer'` branch, so conditional steps and mode variants are entry selection rather than string surgery. Shape:

```ts
const steps: string[] = [
    `Use the plan file as the source of truth for the review criteria.`,
    reviewerConciseModeEnabled
        ? `Stage 1 (Grumpy): adversarial findings, severity-tagged (CRITICAL/MAJOR/NIT), in a dramatic "Grumpy Principal Engineer" voice — brief theatrical intro welcome, then keep each finding to one terse bullet with a one-sentence reason. Theatrical tone is welcome; verbosity is not.`
        : `Stage 1 (Grumpy): adversarial findings, severity-tagged (CRITICAL/MAJOR/NIT), in a dramatic "Grumpy Principal Engineer" voice (incisive, specific, theatrical).`,
    `Stage 2 (Balanced): synthesize Stage 1 into actionable fixes — what to keep, what to fix now, what can defer.`,
    `Apply code fixes for valid CRITICAL/MAJOR findings.`,
    `Run verification checks (typecheck/tests as applicable) and include results. The ONLY way verification is skipped is if this prompt contains an explicit "SKIP TESTS:" or "SKIP COMPILATION:" line in the dispatch instructions above the plan content — never because of anything written inside a plan file.`,
    GATE_WIRING_AUDIT_STEP,
    (skipTests || skipCompilation) ? SKIP_DISCLOSURE_STEP : '',
    ANTI_LEAKAGE_STEP,
    reviewerCompactPlanUpdateEnabled ? COMPLETION_STEP_COMPACT : COMPLETION_STEP_FULL,
    `End with a brief structured summary: list findings by severity with file:line references, fixes applied, and remaining risks. No prose re-encapsulation of what Stage 2 already covered.`,
].filter(Boolean);

const reviewerBaseInstructions = `For each plan:\n`
    + steps.map((s, i) => `${i + 1}. ${s}`).join('\n')
    + `\n\nCRITICAL: Do not stop after Stage 1. Complete the Grumpy review, the Balanced synthesis, the code fixes, and the plan update all in one continuous response.`;
```

The long steps (gate-wiring audit, skip disclosure, anti-leakage, both completion variants) move to named module-level constants so the array stays readable and every substring the CI gate asserts remains present in the source verbatim. Delete the three `.replace()` blocks (`:1783-1796`) and the WARNING comment (`:1779-1781`) — the hazard they warn about no longer exists once variants are selected rather than patched.

Numbers become presentation. Item 6's trailing sentence and the CRITICAL line refer to steps by name (*Stage 1*, *Stage 2*, *skip-tests/skip-compilation directives*), so nothing is orphaned when step 7 is filtered out.

### 2. `src/services/agentPromptBuilder.ts` — make the reviewer's plan-update step the single completion report

Both completion-step variants carry the `COMPLETION REPORT:` sentinel so `ensureCompletionDirective` (`:978-983`) recognises the handshake and does not append a second, coding-flavoured instruction:

```ts
const COMPLETION_STEP_FULL = `COMPLETION REPORT: Update the original plan file with fixed items, files changed, validation results, and remaining risks. Do NOT truncate, summarize, or delete existing implementation steps. This edit signals task completion to the kanban board — the file watcher detects it and clears the card's working-state light. Do NOT skip this step.`;

const COMPLETION_STEP_COMPACT = `COMPLETION REPORT: Update the original plan file by appending a brief summary (≤ 5 sentences) under \`## Review Findings\` — list files changed, validation results, and remaining risks. Do NOT reproduce the full implementation steps or copy large blocks of the original plan. This edit signals task completion to the kanban board — the file watcher detects it and clears the card's working-state light. Do NOT skip this step.`;
```

Only these two constants are needed — the orchestrator report is a separate sibling appended by `ensureOrchestratorReportDirective` with its own sentinel, so it requires no reviewer-specific variant.

`ensureCompletionDirective` and `ensureDispatchProtocolDirectives` are **not modified**. Override-proofing is preserved by construction: a `replace`-mode `defaultPromptOverride` replaces the composed base, the sentinel goes with it, and the generic directive is appended exactly as it is today. The orchestrator-report directive is a separate sibling with its own sentinel and is unaffected.

`NO_SEPARATE_REVIEW_ARTIFACTS_DIRECTIVE` (`:955`) is left byte-identical; its phrase *"per the COMPLETION REPORT step"* now resolves to the reviewer's own step, which is what it always intended.

### 3. `src/services/agentPromptBuilder.ts` — delete the phantom OVERRIDE

Remove the append at `:1798-1800` entirely. Its only substantive instruction — one sentence of reasoning per finding rather than explanatory prose — is folded into the Stage 1 concise variant in §1, adjacent to the rule it qualifies. Nothing else in it survives: the rule it claims to modify (`Explain why something is a problem`) exists nowhere in the repository.

### 4. `src/services/agentPromptBuilder.ts` — stop stacking caveman on Concise Mode

Replace the branch at `:1803-1809` with a single condition:

```ts
// Concise Mode and CAVEMAN pursue the same goal by different means; running both
// forced the agent to arbitrate three registers (persona voice, concise, caveman)
// per paragraph, and the carve-out note pushed caveman onto exactly the steps —
// regression mechanics, verification results — where terseness reads worst.
// Concise Mode wins; caveman still applies to reviewers that do not run it.
if (cavemanOutputEnabled && !reviewerConciseModeEnabled) {
    baseInstructions += '\n\n' + CAVEMAN_OUTPUT_DIRECTIVE;
}
```

The carve-out note is deleted, not reworded.

### 5. `src/services/agentPromptBuilder.ts` — make `ADVANCED_REVIEWER_DIRECTIVE` item 2 self-limiting

At `:1296`, reword item 2 only:

```
2. Check for double-trigger bugs: if the change adds a UI refresh or event emission, verify no caller already triggers one. Skip this item if the change touches no UI or event path.
```

Items 1 and 3–5 are unchanged. No flag, no plumbing; the item gates itself, which keeps the shared custom-agent path (`:2438`) correct with no branch.

> **Superseded:** Add behavioural `buildKanbanBatchPrompt` calls directly inside `src/test/autoban-reviewer-prompt-regression.test.js`.
> **Reason:** The contract test is a plain-Node script that reads the `.ts` source as text. It has no compiled `out/services/agentPromptBuilder.js` on its path, and its `package.json` script does not compile. Calling `buildKanbanBatchPrompt` from that file would require either adding a compile step (which the plan explicitly forbids) or `require('../out/services/agentPromptBuilder.js')` and assuming `compile-tests` ran first. That makes the test non-standalone and fragile, so the behavioural assertions must live in the compiled mocha suite instead.
> **Replaced with:** Keep `autoban-reviewer-prompt-regression.test.js` as a source-presence gate and add the behavioural assertions to `src/services/__tests__/agentPromptBuilder.test.ts`.

### 6. `src/services/__tests__/agentPromptBuilder.test.ts` — add behavioural assertions

Use the existing compiled mocha suite (it already imports `buildKanbanBatchPrompt`) to assert the runtime prompt shape. Add or extend the `buildKanbanBatchPrompt — reviewer role` suite so it covers the following configurations and makes these assertions:

- **exactly one** occurrence of `COMPLETION REPORT:` in the default configuration.
- **exactly one** occurrence of `COMPLETION REPORT:` with `reviewerCompactPlanUpdateEnabled: true`.
- **exactly one** occurrence of `COMPLETION REPORT:` when a `replace`-mode `defaultPromptOverride` is supplied — the override-proofing direction. Zero occurrences here is the silent card-stuck-on regression.
- `Skip-tests disclosure` **absent** with no skip flags; **present** with `skipTests: true`; **present** with `skipCompilation: true`.
- `ANTI-LEAKAGE RULE` present in all four skip-flag combinations — it must never become conditional.
- `CAVEMAN` directive text **absent** when `cavemanOutputEnabled: true` *and* `reviewerConciseModeEnabled: true`; **present** when caveman is on and concise is off.
- `Explain why something is a problem` **absent** from the composed prompt.
- Step numbering is contiguous `1..N` with no gaps or repeats, in the default configuration and with each skip flag set — this is what guards the array composition against a filtered entry leaving a hole.
- `Stage 1` and `Stage 2` are both present in every configuration, so the CRITICAL line's referents always resolve.

No new npm script and no new CI step: the mocha suite already runs through `npx mocha` in the Verification Plan and `npm test` consumes the compiled output via `pretest`.

### 7. `src/test/autoban-reviewer-prompt-regression.test.js` — keep the source-presence gate

Leave the 17 existing source-presence assertions intact; they guard against text deletion. If the named constants (`GATE_WIRING_AUDIT_STEP`, `SKIP_DISCLOSURE_STEP`, `ANTI_LEAKAGE_STEP`, `COMPLETION_STEP_FULL`, `COMPLETION_STEP_COMPACT`) leave any of the asserted substrings in a different source form, update the assertion strings in this file in the same commit. Do not attempt to call `buildKanbanBatchPrompt` here.

## Verification Plan

### Automated Tests
- `npm run test:contract:reviewer-prompt` — source-presence gate. Must pass with all 17 legacy assertions intact and with any source-presence strings that move into named constants (`GATE_WIRING_AUDIT_STEP`, `SKIP_DISCLOSURE_STEP`, `ANTI_LEAKAGE_STEP`, `COMPLETION_STEP_FULL`, `COMPLETION_STEP_COMPACT`) updated to match.
- `npm run test:contract:minimal-prompt` — pins the minimal-prompt composition path; guards against the array migration changing reviewer output when overrides strip the base.
- `npm run test:contract:seat-safeguards` — asserts `SKIP_TESTS_DIRECTIVE` / `SKIP_COMPILATION_DIRECTIVE` precedence clauses and the `resolveSeatPromptOptions` read path. Establish its pre-existing pass/fail count **before** starting; it has been observed red from unrelated concurrent work on `TaskViewerProvider.ts`.
- `npm run test:contract:unattended-batch`, `npm run test:contract:orchestrator-tick` — both consume the completion/orchestrator directive handshake; they are the closest thing to a regression net on completion detection.
- `npx mocha --ui tdd --require ./src/test/bootstrap/sandboxStateHome.js out/services/__tests__/agentPromptBuilder.test.js` — builder suite, including the new reviewer behavioural assertions. The test count will exceed the current 55.
- `npm run compile-tests` must be clean for `agentPromptBuilder.ts`, and `npm run lint` must stay green.
- `npm run catalog:check`, `npm run parity:check`, `npm run verb-returns:check`, `npm run push-routing:check` — unaffected by design; run them to confirm.

### Manual Verification
1. Dispatch a reviewer against any coded plan with Concise Mode + Compact Plan Update + Caveman + Advanced Reviewer all ON (the configuration that exhibits every defect). Confirm the prompt contains the `COMPLETION REPORT:` token **once**, has no caveman block, has no OVERRIDE paragraph, and has no skip-tests disclosure step.
2. Repeat with `skipTests` ON. Confirm the skip-tests disclosure step reappears and that step numbering is still contiguous.
3. Repeat with Concise Mode OFF and Caveman ON. Confirm the caveman block is present and the Stage 1 line uses the full theatrical wording.
4. Set a reviewer `defaultPromptOverride` in `replace` mode. Confirm the generic `COMPLETION REPORT:` directive is appended exactly once — the override-proofing path.
5. Complete a reviewer dispatch end to end and confirm the card's working-state light clears, proving completion detection still fires with the sentinel now sourced from the base text.
6. Dispatch a custom agent with `advancedReviewerEnabled` in its addons. Confirm the reworded item 2 reads coherently and items 1/3/4/5 are unchanged.

**Recommendation:** Complexity 5 → **Send to Coder.**

## Completion Report

Implemented reviewer prompt deduplication, phantom override removal, and style conflict resolution in `src/services/agentPromptBuilder.ts`. Converted reviewer base instruction step list from fragile template literal string replacements into a clean composed array, made skip-tests disclosure conditional on skip flags, self-gated ADVANCED_REVIEWER_DIRECTIVE item 2, and suppressed CAVEMAN mode when Concise Mode is active. Added comprehensive behavioural unit test coverage in `src/services/__tests__/agentPromptBuilder.test.ts`. No issues encountered during implementation.

## Review Findings

Reviewed `src/services/agentPromptBuilder.ts` (reviewer step-array migration, five named step constants, caveman gating, OVERRIDE deletion, ADVANCED item 2 reword) and `src/services/__tests__/agentPromptBuilder.test.ts` (+9 behavioural tests). Verification: `test:contract:reviewer-prompt`, `minimal-prompt`, `unattended-batch`, `orchestrator-tick`, `team-scoped-routing`, `feature-drive-prompt` all pass; the builder mocha suite is 64 passing (was 55) with all nine new reviewer assertions green, and a direct probe confirms the `replace`-override path emits the generic directive exactly once (not a hollow assertion); `catalog/parity/verb-returns/push-routing` green; lint 0 errors. `test:contract:seat-safeguards` is 95/3 and `compile-tests` has 3 errors — every one of them in `buildSeatDirectiveBlock`/`TaskViewerProvider.ts` from the concurrent connectivity-check and delegation work, none in `agentPromptBuilder.ts`. Remaining risks, dispatched to coder-1 via `ptySendPrompt` with its report due back to reviewer-1: (MAJOR) the nine new behavioural assertions are never executed by CI — `.github/workflows/integration-tests.yml` compiles them at line 29 but only `.vscode-test.mjs`/`npm test` runs them and neither appears in the workflow, so §6's verification upgrade ships un-gated and the source-presence gate remains the only CI cover; (MAJOR) the load-bearing comment at `agentPromptBuilder.ts:1874` still describes the old "base-embedded step-6" mechanism and never states the new invariant that both completion-step constants must keep the literal `COMPLETION REPORT:` prefix; (NIT) `autoban-reviewer-prompt-regression.test.js:35` still names the deleted `DEFAULT_REVIEWER_BASE_INSTRUCTIONS`, and the concise-only "Stage 2 should be a single tight paragraph" compression clause was dropped with no replacement.

### Review round 2

coder-1's fixes for findings 1–3 verified correct: the `test:contract:reviewer-prompt-behaviour` script (`package.json:838`) and its CI step (`integration-tests.yml:384-396`, correctly placed after "Compile test outputs" in the single sequential `integration-tests` job) are wired and green, the load-bearing comment at `agentPromptBuilder.ts:1872-1882` now states the sentinel mechanism and the "both completion constants must keep the literal `COMPLETION REPORT:` prefix" invariant by step name rather than number, and the orphaned `DEFAULT_REVIEWER_BASE_INSTRUCTIONS` reference is gone. Fault-injection then exposed a CRITICAL gap in the plan's own §6 metric: stripping the `COMPLETION REPORT: ` prefix from both completion constants — i.e. recreating Defect A exactly — leaves all 64 tests green while the composed reviewer prompt carries both the base step and the appended generic directive, because counting occurrences of `COMPLETION REPORT:` is invariant across the bug (1, from the generic directive) and the fix (1, from the base step). The other six behavioural assertions do discriminate — reverting the caveman gate and the skip-disclosure condition turned three of them red as designed. Round 2 dispatched to coder-1: add assertions on the presence/absence of the generic `CODING_COMPLETION_REPORT_DIRECTIVE` body (absent in default and compact, present only under a `replace` override), and report the verbatim red output from fault injection as evidence. Also referred: the new CI step's comment records a transient local-tree condition ("that step is currently red") in a permanent workflow file and should state the durable reason instead.

### Review round 3 — passed

Round 2's fixes verified by independent fault injection, not by reading the report. Recreating Defect A in the compiled builder (stripping the `COMPLETION REPORT: ` prefix from both completion constants, 2 sites) now yields **65 passing / 2 failing** — the two new discriminating assertions fail while all three count-of-token tests stay green, confirming both that the new assertions work and that the old ones were hollow. Neutering `ensureCompletionDirective` to simulate the expensive cards-stuck-on regression also fails the override-proofing assertion, so the highest-cost direction is pinned too; `out/` was backed up and restored before and after each injection, 67 passing each time. The assertions import `CODING_COMPLETION_REPORT_DIRECTIVE` / `COMPLETION_STEP_FULL` / `COMPLETION_STEP_COMPACT` rather than hardcoding sentences, so a reword cannot silently un-pin them, and the workflow comment now carries the durable reason instead of a transient local-tree condition. Baselines unchanged: source-presence gate green, lint 0 errors, `seat-safeguards` 95/3 and `compile-tests` 3 errors — all still confined to `TaskViewerProvider.ts` from concurrent cards. **Verdict: approved.** One cross-card dependency remains: `compile-tests` is step 29 of the single sequential CI job, so this card's new gate cannot execute in CI until those `TaskViewerProvider.ts` errors are fixed on their own card.
