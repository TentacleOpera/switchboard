# Fix: Team Lead Commits Per-Subtask Instead of Once at End

## Goal

Team leads driving coder teams commit after each subtask instead of once when all subtasks are complete. The `whenDone` git policy clause (forced onto the head by the seat-safeguards symmetry guard) says "When you have finished the task... create a single commit" — but for a driving lead, "the task" is ambiguous and gets read as "this subtask." Neither the `driveMode` feature orchestration directive nor the external `head-prompt.md` template disambiguates commit timing, so the lead commits per-subtask, fragmenting the team's work into N commits instead of one reviewable commit.

### Root Cause

1. **Symmetry guard forces `whenDone` on the head** (`seat-safeguards-fleet-prompt-path.test.js` lines 1236–1263): the delivery layer overrides the head's commit strategy to `whenDone` so someone commits the team's work. This is correct — a team needs a committer.

2. **`whenDone` clause is per-task language** (`agentPromptBuilder.ts` line 610): "When you have finished the task... create a single commit." For a solo coder, "the task" = the one plan. For a driving lead, "the task" could be each subtask or the whole feature — the clause doesn't say.

3. **`driveMode` directive says nothing about commits** (`agentPromptBuilder.ts` lines 1344–1350): the feature orchestration directive for driving leads tells the lead to dispatch, review diffs, and resend fixes — but never mentions when to commit. So the lead falls back to the `whenDone` clause's ambiguous "finished the task" and commits after each subtask review.

4. **`head-prompt.md` template has the same gap** (`agentGroupInstantiation.ts` lines 270–280): §7 says "when all subtasks are complete and verified, dispatch to CODE REVIEWED" but never mentions committing at all.

### What This Is Not

- This is **not** a change to the `whenDone` clause itself — that clause is shared across all roles (solo coders, leads, interns) and its per-task language is correct for solo coders.
- This is **not** a change to the symmetry guard — forcing the head to `whenDone` is correct; the team needs a committer.
- This is **not** a change to the `terminal-coder-dispatch` SKILL.md — the skill already says "commit once as head" (§5.5 rule 3: "A team commits **once**, as its head") and "team's work is complete → commit as head" (§5.6). The skill prose is correct; the problem is the injected directive doesn't reinforce it.

## Metadata

**Complexity:** 3
**Tags:** bugfix, backend, test
**Project:** Browser Switchboard

## User Review Required

No — surgical disambiguation of existing prompt text. No new product decisions, no changes to shared infrastructure (the `whenDone` clause or the symmetry guard), no behavioral changes beyond commit timing for driving leads.

## Complexity Audit

### Routine
- Adding a single sentence to an existing string template literal in `resolveFeatureOrchestrationDirective`'s `driveMode` branch (`agentPromptBuilder.ts`).
- Adding a two-step numbered list to an existing template string in `writeHeadPromptFile`'s §7 (`agentGroupInstantiation.ts`).
- Adding `assert.ok(prompt.includes(...))` assertions to existing test functions in `feature-drive-prompt-reframe-contract.test.js`.
- Adding a source-text regex assertion to `team-scoped-role-routing.test.js` (which already reads `agentGroupInstantiation.ts` as text).

### Complex / Risky
- None — all changes are additive string insertions in prompt-generation code. No logic changes, no state changes, no API changes.

## Edge-Case & Dependency Audit

- **Race Conditions:** None — this is prompt text generation, not concurrent state mutation. The prompt is assembled synchronously before dispatch.
- **Security:** None — no secrets, no auth changes, no new data paths.
- **Side Effects:** The prompt text changes for all drive-mode dispatches (lead, coder, intern) and all external team head-prompt files. Existing tests that assert exact prompt content are unaffected — the new assertions are additive (checking for presence of a new substring), not modifications of existing assertions.
- **Dependencies & Conflicts:** No dependencies on other plans. No conflicts — the changes are additive (new sentences inserted into existing template strings). The `whenDone` clause and symmetry guard are explicitly untouched.

**Prompt ordering note:** In the assembled prompt, the `whenDone` clause (inside the gitBlock/suffixBlock) appears *before* the feature directive block containing the new commit-timing sentence. The order is: `baseInstructions → suffixBlock (gitBlock with whenDone) → featureDirectiveBlock (with new sentence) → PLANS TO PROCESS`. This means the disambiguation arrives after the ambiguous clause. This is not a blocking issue — agents read the full prompt before acting, and the new sentence is a direct negation of the per-subtask reading — but it is worth knowing that the fix is a rear-guard clarification, not a vanguard override.

## Dependencies

None — this plan is self-contained. No other plan must land first.

## Adversarial Synthesis

Key risks: (1) the disambiguation sentence arrives after the `whenDone` clause in prompt order, relying on the agent reading the full prompt before acting; (2) two surfaces (driveMode directive + head-prompt template) carry the commit-timing language with no shared constant, so future drift is possible if one is reworded without the other; (3) the original plan missed `testCoderDriveOn()` in its test assertion list, leaving a coverage gap for the coder drive path. Mitigations: the direct negation ("Do not commit after each subtask") is strong enough to override the earlier ambiguous clause; test assertions on both surfaces serve as a sync check; the coder test assertion has been added to the revised plan.

## Proposed Changes

### `src/services/agentPromptBuilder.ts` — `resolveFeatureOrchestrationDirective`, `driveMode` branch

**Context:** The `driveMode` branch (lines 1344–1350) emits the feature orchestration directive for driving leads. It tells the lead to dispatch, review diffs, and resend fixes, but says nothing about when to commit. The lead falls back to the `whenDone` clause's ambiguous "finished the task" and commits per-subtask.

**Logic:** Insert a commit-timing sentence after the review/resend sentence and before the `unitClause`. The sentence directly negates the per-subtask reading: "Do not commit after each subtask — commit once, as the team's head, when all subtasks are complete and verified."

**Implementation:**

Current (lines 1344–1350):
```typescript
    if (driveMode) {
        return `${opener('driving')}\n` +
            `Dispatch each subtask to a seat on your team — do not implement subtasks yourself. ` +
            `Review each coder's diff before accepting its work; resend a fix prompt to the same seat if it falls short. ` +
            `${unitClause}\n` +
            `Before starting, briefly tell the user how you plan to dispatch the subtasks across your seats.`;
    }
```

Changed:
```typescript
    if (driveMode) {
        return `${opener('driving')}\n` +
            `Dispatch each subtask to a seat on your team — do not implement subtasks yourself. ` +
            `Review each coder's diff before accepting its work; resend a fix prompt to the same seat if it falls short. ` +
            `Do not commit after each subtask — commit once, as the team's head, when all subtasks are complete and verified. ` +
            `${unitClause}\n` +
            `Before starting, briefly tell the user how you plan to dispatch the subtasks across your seats.`;
    }
```

**Edge Cases:** The sentence is additive — it does not alter the existing dispatch/review/resend instructions. The `whenDone` clause remains in the gitBlock (forced by the symmetry guard) and is not modified. The sentence disambiguates "the task" in `whenDone` for the driving-lead context without modifying the shared clause. If a subtask fails and the lead never completes all subtasks, the commit-timing language says "when all subtasks are complete and verified" — the lead does not commit partial work, consistent with `whenDone`'s "when you have finished the task."

### `src/services/agentGroupInstantiation.ts` — `writeHeadPromptFile`, §7 "Advancing & Review"

**Context:** The `writeHeadPromptFile` function (line 199) generates the `head-prompt.md` file written to `.switchboard/teams/<teamId>/head-prompt.md` for external team leads (Antigravity/Cursor/Zed). §7 (lines 270–280) tells the head to dispatch to CODE REVIEWED when all subtasks are complete, but never mentions committing. This is the same ambiguity as the `driveMode` directive, on a different surface.

**Logic:** Add a commit step before the dispatch-to-review step. Restructure §7 from prose + JSON block to a numbered list with an embedded JSON block, making the commit-then-advance sequence explicit.

**Implementation:**

Current §7 (lines 270–280):
```
## 7. Advancing & Review
When all subtasks of the feature are complete and verified:
\`\`\`json
POST /kanban/dispatch
{
  "plan": "<featurePlanId>",
  "targetColumn": "CODE REVIEWED",
  "from": "${headName}"
}
\`\`\`
*(Do not use /kanban/move for review handoff; /kanban/dispatch triggers the reviewer).*
```

Changed §7:
```
## 7. Advancing & Review
When all subtasks of the feature are complete and verified:
1. Commit all changes once, as the team's head — do not commit after each subtask.
2. Advance to review:
\`\`\`json
POST /kanban/dispatch
{
  "plan": "<featurePlanId>",
  "targetColumn": "CODE REVIEWED",
  "from": "${headName}"
}
\`\`\`
*(Do not use /kanban/move for review handoff; /kanban/dispatch triggers the reviewer).*
```

**Edge Cases:** The restructure from prose to a numbered list changes the template structure. No known consumer parses §7 programmatically (the file is read by the external head agent as prose), so this is a minor structural change. The JSON code block and the trailing note about `/kanban/move` are preserved unchanged. The `writeHeadPromptFile` function returns `null` if `.switchboard/` does not exist (line 209) — this guard is unaffected.

### `src/test/feature-drive-prompt-reframe-contract.test.js` — add commit-timing assertions

**Context:** The existing test file imports from `../../out/services/agentPromptBuilder` (compiled output) and tests the drive-mode prompt for lead, coder, intern, and custom-agent paths. The tests assert the presence of dispatch instructions and the absence of implement-coded phrases. No test currently asserts commit-timing language because it does not yet exist.

**Logic:** Add `assert.ok(prompt.includes('Do not commit after each subtask'))` to every drive-mode test function that exercises the `driveMode` branch of `resolveFeatureOrchestrationDirective`.

**Implementation:**

Add the following assertion to each of these existing test functions, after the existing drive-directive assertions:

- `testLeadDriveOn()` (after line 53):
  ```javascript
  assert.ok(prompt.includes('Do not commit after each subtask'), 'Lead should have commit-timing directive');
  ```

- `testCoderDriveOn()` (after line 66):
  ```javascript
  assert.ok(prompt.includes('Do not commit after each subtask'), 'Coder should have commit-timing directive');
  ```

- `testInternDriveOn()` (after line 85):
  ```javascript
  assert.ok(prompt.includes('Do not commit after each subtask'), 'Intern should have commit-timing directive');
  ```

- `testCustomAgentPath()` (after line 147, inside the `driveOn` block):
  ```javascript
  assert.ok(driveOn.includes('Do not commit after each subtask'), 'Custom agent Drive on must contain the commit-timing directive');
  ```

> **Superseded:** The original plan listed only `testLeadDriveOn()`, `testInternDriveOn()`, and `testCustomAgentPath()` for commit-timing assertions.
> **Reason:** The coder role is drive-allowlisted (confirmed by `testCoderDriveOn()` at line 60 of the test file, which already asserts the dispatch instruction). Omitting the coder from commit-timing coverage leaves a gap: if a future refactor of `resolveFeatureOrchestrationDirective` splits the coder branch and accidentally drops the commit-timing sentence, the test suite would not catch it.
> **Replaced with:** All four drive-mode test functions receive the commit-timing assertion: `testLeadDriveOn()`, `testCoderDriveOn()`, `testInternDriveOn()`, and `testCustomAgentPath()`.

**Edge Cases:** The `testDriveOffUnchanged()` function (line 116) must NOT assert the presence of the commit-timing sentence — when Drive is off, the `driveMode` branch is not taken, so the sentence is absent. The existing negative assertions in `testDriveOffUnchanged()` already cover the absence of drive-specific language; no change is needed there. The `testNonFeatureDispatchUnaffected()` function (line 190) asserts that `driveMode` is a no-op when `featureMode` is false — this remains valid because the commit-timing sentence is inside the `driveMode` branch, which is only reached when `driveMode` is true and `featureMode` is true (the branch is inside `resolveFeatureOrchestrationDirective`, which is only called when `options?.featureMode && options?.featureTopic` at line 1680).

### `src/test/team-scoped-role-routing.test.js` — add head-prompt §7 commit-once assertion

**Context:** The `writeHeadPromptFile` function is not tested in `seat-safeguards-fleet-prompt-path.test.js` (confirmed: the only match for `writeHeadPromptFile` in that file is a comment at line 1189). The `team-scoped-role-routing.test.js` file already reads `agentGroupInstantiation.ts` as source text (line 42: `const agentGroupInstantiationTs = fs.readFileSync(...)`) and performs regex assertions against it. This pattern avoids the compilation dependency — the test reads source text, not compiled output.

> **Superseded:** The original plan proposed adding a test that calls `writeHeadPromptFile` and asserts the generated `head-prompt.md` content, in `seat-safeguards-fleet-prompt-path.test.js` or a new test file.
> **Reason:** `writeHeadPromptFile` is async, writes to disk, and returns `null` if `.switchboard/` does not exist. A function-call test requires a temp directory with a `.switchboard/` scaffold, an async call, a file read, and cleanup. Worse, the existing test files import from `out/` (compiled output), so the test cannot run without `npm run compile`. The `team-scoped-role-routing.test.js` file already reads `agentGroupInstantiation.ts` as source text and performs regex assertions — this pattern avoids the compilation dependency entirely.
> **Replaced with:** A source-text regex assertion in `team-scoped-role-routing.test.js` that verifies the §7 template includes the commit-once guidance.

**Logic:** Add a regex assertion that the `agentGroupInstantiationTs` source text includes the commit-once step in §7.

**Implementation:**

Add a new test assertion within the existing test structure (e.g., in a new `item9()` function or appended to an existing item that covers `agentGroupInstantiation.ts`):

```javascript
assert.ok(
    /Commit all changes once, as the team's head — do not commit after each subtask\./
        .test(agentGroupInstantiationTs),
    'writeHeadPromptFile §7 must include the commit-once guidance for the team head'
);
```

**Edge Cases:** The regex asserts presence of the commit-once sentence in the source text. It does not verify the sentence is in §7 specifically (a regex for that would be fragile against template formatting changes). The presence assertion is sufficient — the sentence is unique enough that a false positive is implausible. If a function-call test is desired later (for stronger coverage), it would need to import from `../../out/services/agentGroupInstantiation` and scaffold a temp `.switchboard/` directory.

## Verification Plan

### Automated Tests
1. Run the existing drive-mode contract test: `node src/test/feature-drive-prompt-reframe-contract.test.js` — all assertions pass including the new commit-timing ones. *(Note: this test imports from `out/`, so `npm run compile` is required first.)*
2. Run the seat-safeguards test: `node src/test/seat-safeguards-fleet-prompt-path.test.js` — all assertions pass (unaffected by this change; serves as a regression check that the symmetry guard and `whenDone` clause are untouched).
3. Run the team-scoped role routing test: `node src/test/team-scoped-role-routing.test.js` — all assertions pass including the new §7 commit-once regex assertion. *(Note: this test reads source text, so no compilation is required.)*

### Manual Verification
4. Dispatch a feature in drive mode to a team lead and inspect the generated prompt text — confirm the commit-timing sentence ("Do not commit after each subtask — commit once, as the team's head, when all subtasks are complete and verified.") appears in the drive directive block, after the review/resend sentence and before the unit clause.
5. Create an external team and inspect `.switchboard/teams/<teamId>/head-prompt.md` — confirm §7 includes the commit-once step as step 1 of the numbered list, before the dispatch-to-review step.

## Recommendation

Send to Coder — complexity 3 is at the low end of the Coder band (4–6), but the change spans two source files and two test files, which is more than a single-file Intern task. The changes are mechanical (string insertions and test assertions) but require care to place the sentence in the right position in the template and to add assertions to all four drive-mode test functions.

## Implementation Summary

Implemented by Coding-coder-2. Added the commit-timing sentence ("Do not commit after each subtask — commit once, as the team's head, when all subtasks are complete and verified.") to the `driveMode` branch of `resolveFeatureOrchestrationDirective` in `agentPromptBuilder.ts`, inserted after the review/resend sentence and before the `unitClause`. Restructured §7 of `writeHeadPromptFile` in `agentGroupInstantiation.ts` from prose to a two-step numbered list with the commit-once step first, then the dispatch-to-review step (the actual §7 header "Triggering Review" was preserved, not the plan example's "Advancing & Review"). Added `assert.ok(prompt.includes('Do not commit after each subtask'))` to all four drive-mode test functions (`testLeadDriveOn`, `testCoderDriveOn`, `testInternDriveOn`, `testCustomAgentPath`) in `feature-drive-prompt-reframe-contract.test.js`, and a source-text regex assertion for the §7 commit-once sentence appended to item8 in `team-scoped-role-routing.test.js` (item8 already covers `agentGroupInstantiation.ts` source-text assertions). Compilation and automated tests were skipped per run directives; changes verified by reading modified regions back and confirming escaped backticks / em-dash / concatenation syntax are intact.
