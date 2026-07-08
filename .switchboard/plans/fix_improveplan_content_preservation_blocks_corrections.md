# Fix: improve-plan CONTENT PRESERVATION rule blocks correction of bad conclusions

## Metadata

**Complexity:** 3
**Tags:** refactor, docs

## Goal

The `improve-plan` workflow's `CONTENT PRESERVATION` constraint forbids deleting any original plan content — "Append and refine; do not truncate." This rule was written to prevent weak/lazy models from silently dropping context during an improve pass. But it overcorrects: when a stronger model identifies that a conclusion in the plan is wrong or superseded, it cannot remove or replace it. It can only append a contradicting recommendation, leaving the plan with two opposing approaches that the downstream coding agent must reconcile — strictly worse than a clean correction.

**Core problem:** The rule treats all original content as equally worth preserving, conflating *factual context* (constraints, requirements, scope — must never be lost) with *reasoning outputs* (chosen approaches, conclusions, design decisions — must be correctable). The result is that bad conclusions accumulate as dead weight and contradictions get deferred to the coding agent.

**Root cause:** A single blunt rule ("never delete anything") is doing two jobs: (1) preventing silent context loss, and (2) preventing the planner from cleaning up wrong reasoning. These need to be separated.

**Desired outcome:** Replace the blunt "never delete" rule with a two-tier rule that (a) preserves all factual context unconditionally, and (b) allows the planner to correct any superseded conclusion or approach, provided the correction is marked with an auditable `> **Superseded:**` callout block so the change is visible and reversible — not silent.

## Design Decisions (user-approved)

1. **Marking convention: Superseded callout blocks.** When the planner corrects a conclusion, the old text is wrapped in a `> **Superseded:**` blockquote with a reason, followed by the replacement text. This is scannable, works in all markdown renderers, and preserves the original text for audit.

2. **Correction threshold: Any improvement.** The planner may correct any conclusion or approach that the improve pass determines is inferior to a better alternative. This is the most permissive option — the callout auditing mechanism is the sole safeguard against silent plan-drift.

## Proposed Changes

### File 1: `/Users/patrickvuleta/Documents/GitHub/switchboard/.agents/workflows/improve-plan.md`
**Priority: Canonical (most evolved version — has feature-routing, project pinning, post-review board state)**

#### Change A: Replace the CONTENT PRESERVATION constraint (line 11)

**Current:**
```
- **CONTENT PRESERVATION**: You are FORBIDDEN from deleting original implementation details, code blocks, prose, or goal statements. Append and refine; do not truncate. This includes product scope explicitly stated in the plan's Goal or Problem Description — you must not narrow or remove supported scenarios (e.g. multi-root workspaces) even if the current session is single-repo.
```

**New:**
```
- **CONTENT PRESERVATION (two-tier)**:
  - **Factual context — NEVER delete.** Goal statements, product scope, requirements, constraints, environment details, and problem/background analysis must be preserved verbatim. This includes product scope explicitly stated in the plan's Goal or Problem Description — you must not narrow or remove supported scenarios (e.g. multi-root workspaces) even if the current session is single-repo. If you believe a goal or scope statement is wrong, flag it in chat for the user — do not unilaterally correct it.
  - **Reasoning outputs — correct with audit marking.** Conclusions, chosen approaches, design decisions, and code examples may be corrected or replaced when the improve pass produces a better alternative. Every correction MUST be marked with a superseded callout so the change is auditable:
    > **Superseded:** <original conclusion or approach>
    > **Reason:** <why it was wrong or inferior>
    > **Replaced with:** <new conclusion or approach>

    Never silently delete a conclusion and write a new one in its place. The callout is the audit trail — without it, the change is a protocol violation.
```

#### Change B: Update step 4 "Preserve" instruction (line 90)

**Current:**
```
   - Preserve all existing implementation steps, code blocks, and goal statements.
```

**New:**
```
   - Preserve all factual context (goal statements, requirements, constraints, scope) per the CONTENT PRESERVATION rule. Correct superseded conclusions and approaches using superseded callout blocks — never silently delete.
```

### File 2: `/Users/patrickvuleta/Documents/GitHub/switchboard/.claude/skills/improve-plan/SKILL.md`
**Priority: High (Claude Code skill — active in this host)**

Apply the same two changes (A and B) as File 1. The constraint text and step 4 text are identical to File 1's, so the replacements are the same. **Also duplicate the full Superseded Callout Format Specification** (see section below) into this file — each file must be self-contained so a model reading either one gets the complete instructions without chasing a reference.

> **Scope note:** The Gitlab mono-repo copies (`.claude/skills/improve-plan/SKILL.md` and `.agents/workflows/improve-plan.md` under `/Users/patrickvuleta/Documents/Gitlab/`) are **not being updated** per user decision. They will retain the old rule. If they need to be synced later, that's a separate task.

## The Superseded Callout — Format Specification

**Placement:** Inline, at the location of the original conclusion being corrected.

**Format:**
```markdown
> **Superseded:** <original conclusion, approach, or code snippet>
> **Reason:** <concise explanation of why it was wrong or inferior>
> **Replaced with:** <new conclusion or approach>
```

**Rules:**
1. The `**Superseded:**` line must contain the original text (or a faithful summary if it was long). Do not paraphrase in a way that hides what was actually said.
2. The `**Reason:**` line is mandatory. A correction without a stated reason is a silent deletion with extra steps.
3. The `**Replaced with:**` line must immediately follow. If the replacement is long (e.g. a code block), it may continue below the callout.
4. Multiple corrections in the same plan are fine — each gets its own callout.
5. The callout replaces the original text in the document body. Do not leave the original text outside the callout AND inside it — that duplicates the contradiction.

**Example:**
```markdown
> **Superseded:** Use a polling loop with 500ms interval to detect file changes.
> **Reason:** Polling wastes CPU and introduces up to 500ms latency. The codebase already has a file watcher utility (`src/utils/watcher.ts`) that uses native FS events.
> **Replaced with:** Use `watchFileChanges()` from `src/utils/watcher.ts` — subscribes to native FS events, zero polling overhead, sub-10ms latency.
```

## Edge Cases

1. **Goal/scope statements that are wrong.** The new rule explicitly forbids the planner from unilaterally correcting goal or scope statements — these are product decisions. The planner must flag the issue in chat for the user to decide. This preserves the original rule's intent (don't let the model narrow scope) while still allowing reasoning-output corrections.

2. **Code blocks showing a wrong approach.** Code blocks are reasoning outputs, not factual context. They can be corrected via callout. For long code blocks, the `**Superseded:**` line can reference the code ("the polling implementation above") rather than reproducing it inline, and the `**Replaced with:**` section carries the new code block below the callout.

3. **The SESSION vs PRODUCT SCOPE rule (line 12/13).** This rule is orthogonal — it's about not conflating session constraints with product scope. It stays unchanged. The new CONTENT PRESERVATION rule reinforces it by explicitly listing "product scope" under "factual context — NEVER delete."

4. **The adversarial review interaction.** The Grumpy/Balanced synthesis (step 3) already produces "reject weak concerns, keep valid ones" language. Corrections should flow naturally from the Balanced synthesis — if the synthesis concludes an original approach is inferior, the correction is written during step 4 (plan update) using the callout format. No change needed to step 3.

5. **Plans with no wrong conclusions.** If the improve pass finds nothing to correct, no callouts are written. The new rule is permissive, not mandatory — it unlocks correction; it doesn't require it.

6. **Multiple improve passes on the same plan.** A second improve pass may supersede a correction from the first pass. The new callout would reference the previous "Replaced with" text as its "Superseded" content. This creates a clean audit chain without accumulating contradictions.

7. **Migration of existing plans.** No migration needed. Existing plans written under the old rule are valid. The new rule only changes how future improve passes behave — existing plans don't need to be retroactively corrected.

## Edge-Case & Dependency Audit

- **Race Conditions:** N/A — no concurrent state; editing static markdown files.
- **Security:** N/A — no auth, no user-input handling, no secret surface. The change is prompt text only.
- **Side Effects:** Behavioral blast radius is wide — the new rule governs every future `improve-plan` pass in this repo (Antigravity via the workflow file, Claude Code via the skill file). A planner that over-applies the "any improvement" threshold will produce more callouts and more churn than today. This is the intended trade-off (correctness over stability) and is bounded by the factual-context guardrail.
- **Dependencies & Conflicts:** The two target files must stay identical in their rule text or the two hosts diverge silently. There is no automated test asserting parity. The Gitlab mono-repo copies (`.agents/workflows/improve-plan.md` and `.claude/skills/improve-plan/SKILL.md` under `/Users/patrickvuleta/Documents/Gitlab/`) are intentionally NOT updated and will retain the old rule — a known, accepted divergence.

## Dependencies

- None. This plan has no prerequisite sessions or upstream plans; it edits two self-contained markdown files.

## Verification Plan

### Manual Verification
1. After editing both files, read each one and confirm:
   - The old `CONTENT PRESERVATION` text is fully replaced (no leftover "Append and refine; do not truncate" language).
   - The new two-tier rule is present and identical across both files.
   - Step 4's "Preserve" instruction is updated in both files.
   - The `SESSION vs PRODUCT SCOPE` rule and all other sections are untouched.
2. Confirm the superseded callout format specification is duplicated in both files (self-contained — no cross-file references).

### Behavioral Verification
3. Run a test improve-plan pass on an existing plan that contains a known-weak conclusion. Confirm the model:
   - Produces a superseded callout (not a silent deletion, not an unmarked append).
   - Preserves all factual context (goal, scope, requirements).
   - Includes a `**Reason:**` line in the callout.
4. Run a test improve-plan pass on a clean plan (no wrong conclusions). Confirm no spurious callouts are written.

### Automated Tests
- None. This is a markdown/prompt-text change with no code path to test. (Automated tests are skipped per session directive; the manual + behavioral verification above cover the change.)

## User Review Required

- [x] Confirm the two-tier rule text is acceptable — **approved** (flag-in-chat policy for goal/scope statements confirmed).
- [x] Confirm the superseded callout format is the right convention — **approved**.
- [x] Confirm scope: only the 2 switchboard files are updated; Gitlab copies are out of scope — **approved**.
- [x] Confirm the callout format specification is duplicated in both files (self-contained) — **approved**.

## Complexity Audit

### Routine
- Text replacement in 2 markdown files — no code logic, no parsing changes.
- The new rule text is self-contained and doesn't interact with other workflow sections.
- No data migration, no state changes, no build step.

### Complex / Risky
- The "any improvement" threshold is permissive — if the callout mechanism is ignored by a weak model, the plan-drift problem returns. The mitigation is that the callout is a hard protocol requirement ("without it, the change is a protocol violation"), but this is enforced by prompt text, not code.
- 2 files within the same repo must stay in sync. If they drift, different hosts (Antigravity vs Claude Code) will follow different rules. Low risk — both files are in the switchboard repo and can be diffed easily.
- The Gitlab mono-repo copies are intentionally not updated — they will retain the old rule. This is a known divergence, not a drift risk.

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) the "any improvement" threshold is permissive and callout enforcement is prompt-level, so a non-compliant model could silently delete conclusions under cover of "correction"; (2) the two in-repo files must stay manually in sync with no automated parity check; (3) the Gitlab mono-repo copies are intentionally diverged with no staleness marker. Mitigations: the callout makes corrections *visible* for review (a net auditability gain over the old silent over-preservation), the factual-context tier is an absolute guardrail independent of the threshold, and the Gitlab divergence is a deliberate scoped cut that can be synced later.

---

**Recommendation:** Complexity 3 → **Send to Intern.** Mechanical text replacement in two near-identical markdown files — no code, no parsing, no migration. The Intern should apply Change A and Change B to both files and duplicate the Superseded Callout Format Specification into the Claude skill copy so each file is self-contained.
