# Feature Plan: Remove Plan-Presentation Step from Accuracy Workflow

**Plan ID:** 9fee378f-cfc7-47c7-87a4-fc8da97cd7ff

## Goal

Remove the "produce a detailed plan in your reply" gate from `/accuracy` Step 3 so the workflow codes directly (with internal planning) instead of presenting a plan and stopping — keeping `/accuracy` as the complement to the planning-only `/improve-plan` workflow.

### Problem
The accuracy workflow (`/accuracy`) Step 3 states: "MUST produce a detailed plan in your reply listing every change, which files are affected, and how to verify each." This makes the agent stop and present a plan in its reply instead of proceeding directly to coding. This directly conflicts with the Switchboard planner role — `/improve-plan` is the workflow that produces plans, while `/accuracy` is a solo coding workflow that should implement directly with self-review.

### Background
- The accuracy workflow is defined in `.agents/workflows/accuracy.md` (64 lines).
- Step 3 "Thorough Plan" spans lines 28–33 in the workflow; line 29 is the "MUST produce a detailed plan in your reply..." bullet. (Line 34 is the blank/next-step boundary, not part of Step 3.)
- The workflow even acknowledges the conflict ("plan files are the domain of `/improve-plan`") but still requires a plan-in-reply, which causes the agent to present a plan and wait instead of coding.
- The `.claude/skills/accuracy/SKILL.md` is a mirror with the same Step 3 body at lines 30–35 (+2 offset from the extra `name: accuracy` frontmatter line, as documented by prior plan `dadc1229`).
- The `/improve-plan` workflow (`improve-plan.md` lines 9–13) is explicitly "FORBIDDEN from modifying any project source files" — it produces plans only. The accuracy workflow should be its complement: it codes directly.
- Step 4 ("Implement in verified groups") is the actual coding phase — Step 3's plan-presentation creates a false stopping point.
- **Prior-plan interaction (important):** Plan `dadc1229` ("Accuracy Workflow — Stop Writing Out Artifacts", status: CODE REVIEWED) deliberately reworded "create a detailed plan" → "produce a detailed plan in your reply... **Do NOT write a plan file to disk**" to stop agents writing plan FILES to disk. It also added a top-level **No-Artifact Rule** section (now at workflow line 11 / SKILL line 13) whose body (line 12 / line 14) states: *"All planning, progress tracking, and review output belongs in your reply to the user."* This plan refines that work — it must **preserve** the anti-disk-write guarantee while removing the plan-in-reply presentation gate, and must **reconcile** the No-Artifact Rule (which currently says planning belongs in the reply — directly contradicting this plan's intent).

### Root Cause
Step 3's "MUST produce a detailed plan in your reply" instruction creates a plan-presentation gate that conflicts with the workflow's purpose as a direct coding workflow. The agent interprets this as "present a plan and wait for approval" rather than "think through the plan internally, then code." A secondary root cause is that the existing No-Artifact Rule (installed by `dadc1229`) says "all planning... belongs in your reply," which reinforces the same plan-presentation behaviour and must be reconciled alongside the Step 3 edit.

## Metadata

- **Tags:** docs, refactor
- **Complexity:** 3

## User Review Required

No — text-only edit to two workflow markdown files with no runtime code change, no migration, and no breaking behavior. The intent (accuracy codes directly, no plan-presentation gate) is confirmed by the originating request. One addition beyond the original draft — the **No-Artifact Rule reconciliation** (Change 2) — is a necessary correctness fix to avoid contradicting the new Step 3, not a scope change; it is labelled "Clarification" below. Safe to proceed directly to coding.

## Complexity Audit

### Routine
- Editing Step 3 in `.agents/workflows/accuracy.md` (lines 28–33) to remove the plan-presentation requirement and rename it to "Internal Planning".
- Editing the identical Step 3 body in `.claude/skills/accuracy/SKILL.md` (lines 30–35, +2 offset).
- One-line reconciliation of the No-Artifact Rule in both files (workflow line 12 / SKILL line 14) so "planning" no longer says it belongs in the reply (Change 2 — Clarification).
- Optionally merging Step 3's useful parts (dependency mapping, risk identification) into Step 2 (context gathering) or Step 4 (implementation) — the chosen approach keeps them in Step 3 under the new "Internal Planning" heading.

### Complex / Risky
- **Prior-plan interaction (anti-disk-write regression):** The explicit "Do NOT write a plan file to disk" guard installed by plan `dadc1229` must be preserved in Step 3. Removing it and relying solely on the No-Artifact Rule backstop would weaken a load-bearing guard. Mitigation: keep an explicit per-step "Do NOT write a plan file to disk" bullet that cross-references the No-Artifact Rule (defense in depth).
- **No-Artifact Rule contradiction:** The existing No-Artifact Rule says "All planning... belongs in your reply," which directly conflicts with the new "Do NOT produce a plan-in-reply" instruction. Left unreconciled, an agent gets two contradictory directives. Mitigation: Change 2 narrows the No-Artifact Rule to "progress tracking and review output belong in your reply; planning is internal (Step 3)."

## Edge-Case & Dependency Audit

### Race Conditions
- None.

### Security
- None.

### Side Effects
- Agents using `/accuracy` will now proceed directly from context gathering to implementation without presenting a plan-in-reply first. This is the intended behaviour for a solo coding workflow.
- The internal planning (thinking through dependencies and risks) still happens — it just isn't output as a formal plan-in-reply that creates a stopping point.
- The No-Artifact Rule's anti-disk-write guarantee is **preserved** (explicit Step 3 bullet + backstop section), so agents still do NOT write plan files to `.switchboard/plans/` when running `/accuracy`.

### Dependencies & Conflicts
- Must update BOTH `.agents/workflows/accuracy.md` AND `.claude/skills/accuracy/SKILL.md` — they are mirrors and must stay in sync (they differ only in frontmatter; step bodies are identical).
- **Preserves, does not reverse, prior plan `dadc1229`** ("Stop Writing Out Artifacts"). That plan installed the "Do NOT write a plan file to disk" guard and the No-Artifact Rule; this plan keeps both guarantees while removing only the plan-in-reply presentation gate, and reconciles the No-Artifact Rule wording so it no longer contradicts the new behaviour.
- Only two source-of-truth files contain the target phrase — confirmed by repo-wide grep for "produce a detailed plan in your reply" and "Thorough Plan" (other matches are inside `.switchboard/plans/` documents, not workflow definitions).

## Dependencies

None — self-contained. Preserves the guarantees installed by prior plan `dadc1229` (Accuracy Workflow — Stop Writing Out Artifacts); this plan refines, does not reverse, that work.

## Adversarial Synthesis

Key risks: (1) anti-disk-write regression — the original "AFTER" drops the explicit "Do NOT write a plan file to disk" guard installed by `dadc1229`, weakening a load-bearing wall; (2) No-Artifact Rule contradiction — "All planning... belongs in your reply" (lines 12/14) is at war with the new "Do NOT produce a plan-in-reply," leaving agents with two conflicting directives; (3) unsound verification — the grep sweep as written hits false positives in `.switchboard/plans/` plan documents. Mitigations: keep an explicit per-step no-disk-write bullet that cites the No-Artifact Rule backstop (defense in depth), reconcile the No-Artifact Rule with a one-line narrowing ("planning is internal"), and scope all grep checks to the two source files.

## Proposed Changes

---

### 1. `.agents/workflows/accuracy.md` — Rewrite Step 3 (lines 28–33)

**Context**: Lines 28–33, Step 3 "Thorough Plan". Line 29 is the plan-presentation bullet; line 33 is the RULE bullet. Line 34 is the blank/next-step boundary (not part of Step 3).

**Logic**: Replace the plan-presentation requirement with an internal-planning instruction that flows directly into implementation, while **preserving** the explicit "Do NOT write a plan file to disk" guard installed by prior plan `dadc1229` (defense in depth alongside the No-Artifact Rule).

**Implementation**:

```markdown
# BEFORE (lines 28-33):
3. **Thorough Plan**:
   - MUST produce a detailed plan in your reply listing every change, which files are affected, and how to verify each. Do NOT write a plan file to disk — plan files are the domain of `/improve-plan`, not `/accuracy`.
   - MUST map dependencies between changes — which must happen first?
   - MUST identify risks: what could break? What edge cases exist?
   - **DESTRUCTION CHECK**: If deleting files, MUST run `grep_search` to confirm nothing depends on them.
   - **RULE**: Spend more time planning. A plan that prevents 1 rework cycle saves an entire prompt.

# AFTER:
3. **Internal Planning** (think before you code, but do NOT present a plan-in-reply):
   - MUST map dependencies between changes internally — which must happen first?
   - MUST identify risks: what could break? What edge cases exist?
   - **DESTRUCTION CHECK**: If deleting files, MUST run `grep_search` to confirm nothing depends on them.
   - **RULE**: Spend more time thinking. A thought-through approach that prevents 1 rework cycle saves an entire prompt.
   - Do NOT produce a plan-in-reply or present a plan for approval — proceed directly to Step 4 (implementation).
   - Do NOT write a plan file to disk — plan files are the domain of `/improve-plan`, not `/accuracy` (enforced by the No-Artifact Rule above).
```

**Edge Cases**: The "Do NOT write a plan file to disk" bullet is deliberately kept explicit (not folded into the presentation-gate bullet) so the prior plan's anti-disk-write guarantee survives the rewrite. It cross-references the No-Artifact Rule (Change 2) as the catch-all backstop.

---

### 2. `.agents/workflows/accuracy.md` — Reconcile the No-Artifact Rule (line 12) *(Clarification)*

**Context**: Line 12, the body bullet of the "No-Artifact Rule" section (section header at line 11). Installed by prior plan `dadc1229`.

**Logic**: The existing wording — *"All planning, progress tracking, and review output belongs in your reply to the user"* — directly contradicts Change 1's "Do NOT produce a plan-in-reply." Narrow it so only progress tracking and review output belong in the reply; planning is internal per Step 3. *(Clarification, not new scope — reconciles two existing directives.)*

**Implementation**:

```markdown
# BEFORE (line 12):
- `/accuracy` is a solo, in-conversation workflow. Do NOT write out artifacts to disk as part of execution — no `task.md`, no plan files, no Red Team Findings file, no progress logs. All planning, progress tracking, and review output belongs in your reply to the user. The only files you create or modify are the actual code files required by the task itself.

# AFTER:
- `/accuracy` is a solo, in-conversation workflow. Do NOT write out artifacts to disk as part of execution — no `task.md`, no plan files, no Red Team Findings file, no progress logs. All progress tracking and review output belongs in your reply to the user; planning itself is internal (see Step 3) and is NOT presented as a plan-in-reply. The only files you create or modify are the actual code files required by the task itself.
```

**Edge Cases**: This keeps Step 5's "Document findings in your reply under `### Red Team Findings`" and Step 4's "track progress in your reply" consistent (review/progress output still belongs in the reply). Only "planning" is reclassified as internal.

---

### 3. `.claude/skills/accuracy/SKILL.md` — Apply both changes (Step 3 lines 30–35, No-Artifact Rule line 14)

**Context**: Step 3 "Thorough Plan" spans lines 30–35 (+2 offset from the extra `name: accuracy` frontmatter line). The No-Artifact Rule body bullet is at line 14 (section header line 13).

**Logic**: SKILL.md is the mirror consumed by Claude Code / hosts reading `.claude/skills/`. Its step body must stay byte-identical to the workflow definition (the only permitted difference is the frontmatter block).

**Implementation**: Apply the **exact same replacement as Change 1** to lines 30–35, and the **exact same replacement as Change 2** to line 14, so the skill mirror's step body stays identical to the workflow definition.

```markdown
# BEFORE (Step 3, lines 30-35) — identical to workflow lines 28-33:
3. **Thorough Plan**:
   - MUST produce a detailed plan in your reply listing every change, which files are affected, and how to verify each. Do NOT write a plan file to disk — plan files are the domain of `/improve-plan`, not `/accuracy`.
   - MUST map dependencies between changes — which must happen first?
   - MUST identify risks: what could break? What edge cases exist?
   - **DESTRUCTION CHECK**: If deleting files, MUST run `grep_search` to confirm nothing depends on them.
   - **RULE**: Spend more time planning. A plan that prevents 1 rework cycle saves an entire prompt.

# AFTER:
3. **Internal Planning** (think before you code, but do NOT present a plan-in-reply):
   - MUST map dependencies between changes internally — which must happen first?
   - MUST identify risks: what could break? What edge cases exist?
   - **DESTRUCTION CHECK**: If deleting files, MUST run `grep_search` to confirm nothing depends on them.
   - **RULE**: Spend more time thinking. A thought-through approach that prevents 1 rework cycle saves an entire prompt.
   - Do NOT produce a plan-in-reply or present a plan for approval — proceed directly to Step 4 (implementation).
   - Do NOT write a plan file to disk — plan files are the domain of `/improve-plan`, not `/accuracy` (enforced by the No-Artifact Rule above).
```

And the No-Artifact Rule reconciliation at line 14 (identical text to Change 2's AFTER).

**Edge Cases**: After both edits, the step bodies of the two files must be identical (only frontmatter differs). Verified by the sync check in the Verification Plan.

---

### 4. Verify no other references to "produce a detailed plan in your reply"

**Context**: Search the two source-of-truth files for any residual references. (The phrase legitimately persists inside `.switchboard/plans/` plan documents — those are NOT workflow definitions and must NOT be edited.)

**Implementation** (scoped to the two source files to avoid false positives):
```bash
grep -n "produce a detailed plan in your reply" .agents/workflows/accuracy.md .claude/skills/accuracy/SKILL.md
```
Expected: **no results** in either file. (If a match is found in any OTHER workflow/skill file, apply the same fix; do not edit `.switchboard/plans/` documents.)

## Verification Plan

### Manual Verification
- [ ] Read `.agents/workflows/accuracy.md` Step 3 (lines 28–33) — confirm "produce a detailed plan in your reply" is removed and the step is renamed "Internal Planning".
- [ ] Confirm an explicit "Do NOT write a plan file to disk" bullet is still present in Step 3 (anti-disk-write guarantee preserved).
- [ ] Read `.agents/workflows/accuracy.md` No-Artifact Rule (line 12) — confirm it now says "planning itself is internal (see Step 3) and is NOT presented as a plan-in-reply" (reconciled).
- [ ] Read `.claude/skills/accuracy/SKILL.md` Step 3 (lines 30–35) and No-Artifact Rule (line 14) — confirm the same two changes are applied.
- [ ] Confirm Step 2 (context gathering) and Step 4 (implementation) are unchanged.
- [ ] Confirm Step 5 (Red Team Findings) still says "in your reply" — consistent with the reconciled No-Artifact Rule.
- [ ] Dispatch an agent with `/accuracy` on a small task — verify it proceeds directly to coding without presenting a plan-in-reply first.
- [ ] Verify the agent still does internal planning (dependency mapping, risk identification) before coding, and does NOT write a plan file to disk.

### Automated Tests
- None — markdown-only change with no code surface. Per session directives, **compilation and automated test suites are skipped**. Static checks below are the automated verification.

### Static Checks (grep / diff)
- [ ] `grep -n "produce a detailed plan in your reply" .agents/workflows/accuracy.md .claude/skills/accuracy/SKILL.md` → **no results** (scoped to the two source files; do NOT run unscoped against the repo, which would false-positive on `.switchboard/plans/` documents).
- [ ] `grep -n "All planning, progress tracking, and review output belongs in your reply" .agents/workflows/accuracy.md .claude/skills/accuracy/SKILL.md` → **no results** (the old contradictory No-Artifact Rule phrasing is gone).
- [ ] `grep -n "Do NOT write a plan file to disk" .agents/workflows/accuracy.md .claude/skills/accuracy/SKILL.md` → **one match per file** (the anti-disk-write guard is preserved).
- [ ] `grep -n "No-Artifact Rule" .agents/workflows/accuracy.md .claude/skills/accuracy/SKILL.md` → **one match per file** (backstop section intact).
- [ ] **Mirror sync check:** `diff <(tail -n +4 .agents/workflows/accuracy.md) <(tail -n +6 .claude/skills/accuracy/SKILL.md)` → **no differences** (step bodies identical; workflow frontmatter is lines 1–3, SKILL.md frontmatter is lines 1–4 plus blank line 5).

## Files Changed

- `.agents/workflows/accuracy.md` — rewrite Step 3 (lines 28–33) to "Internal Planning"; reconcile the No-Artifact Rule (line 12).
- `.claude/skills/accuracy/SKILL.md` — mirror both changes (Step 3 lines 30–35; No-Artifact Rule line 14).

## Recommendation

**Complexity: 3 → Send to Intern.** The plan now spells out every edit with exact before/after text, including the prior-plan interaction and the No-Artifact Rule reconciliation, so the subtlety is fully captured for a straightforward markdown execution.
