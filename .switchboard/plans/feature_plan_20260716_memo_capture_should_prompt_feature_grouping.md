# Plan: Memo Capture Should Prompt Agent to Suggest Feature Groupings When Relevant

## Goal

After the memo-to-plan step creates plan files, the agent should reliably offer to group related plans into a feature — even when the created plans clearly share a common theme or root cause. Today the feature-grouping offer is frequently skipped. Make the grouping check **prominent, mandatory, and impossible to skip** across **both** memo entry points, so the "memo → plans" workflow consistently produces groupable output.

### Problem

The feature-grouping suggestion is frequently skipped in practice. The memo workflow *does* instruct the agent to offer grouping, but the instruction is structurally weak and gets lost. Worse, the memo pipeline has **two entry points** and the grouping offer is duplicated across **three** prompt surfaces, all at a high threshold — so fixing only one leaves the workflow inconsistent with itself.

### Root Cause

**A. The `process memo` chat workflow (`.agents/workflows/switchboard-memo.md`, step 5) is structurally weak:**

1. **Buried after a massive step 4.** Step 4 ("Create one plan per entry") is a very long paragraph covering plan format, naming conventions, project pins, and workspace resolution. By the time the agent finishes writing N plan files, it is primed to jump to step 6 (report) and skip step 5 entirely.
2. **No mandatory response marker.** Capture mode uses `[MEMO CAPTURE ACTIVE]` as a hard structural cue every turn. The processing flow has no equivalent marker forcing the grouping check to appear in the output.
3. **Vague analysis requirement.** The step says "if 3 or more of the plans cover a related topic" but does not instruct the agent to actively review the plan titles/contents it just generated and look for clusters. The agent must spontaneously decide to do this analysis — which it doesn't.
4. **Threshold too high.** "3 or more" plans sharing a topic is a high bar. Even 2 plans addressing the same feature area or root cause could benefit from grouping.
5. **No explicit "stop and evaluate" gate.** The steps flow linearly (4 → 5 → 6) with no explicit pause requiring the agent to evaluate before reporting. The agent treats step 5 as optional commentary rather than a mandatory gate.

**B. The Memo sub-tab dispatched prompt (`_buildMemoPlannerPrompt`, `src/services/TaskViewerProvider.ts:4013`) carries the SAME grouping offer at the SAME high threshold (3+):**

The Memo sub-tab's "Send to Planner" / "Copy Prompt" buttons dispatch a prompt built by `_buildMemoPlannerPrompt` (invoked from the `memoGeneratePrompt` handler at `TaskViewerProvider.ts:11638`). Its "Important" section (line 4013) says *"If you created 3 or more plan files that cover a related topic … offer to create a feature grouping them"*. This is functionally the same memo workflow as `process memo`, just backend-driven — but if only `switchboard-memo.md` is fixed, this path keeps the old threshold and the offer stays inconsistent. The feature's goal ("reliably offers feature grouping after creating plans") is only met if **both** entry points are aligned.

> **Reconciliation note (from the feature audit):** A third surface — `DEFAULT_CHAT_BASE_INSTRUCTIONS` step 5 (`agentPromptBuilder.ts:806`) — also offers grouping at 3+. That surface is the *general* chat/planning prompt button, **not** the memo workflow, so its threshold is intentionally left at 3+ and out of scope for this memo-focused feature. See the feature file's Dependencies & sequencing.

## Fix

Restructure the Process Memo Command flow (`switchboard-memo.md`) to make the feature-grouping check prominent, mandatory, and impossible to skip; and lower the sub-tab prompt's grouping threshold (`_buildMemoPlannerPrompt`) to match, so both memo entry points behave identically.

### Files to Change
1. **`.agents/workflows/switchboard-memo.md`** — Process Memo Command section (steps 4-6). Full mandatory-check restructure.
2. **`src/services/TaskViewerProvider.ts`** — `_buildMemoPlannerPrompt` grouping-offer bullet (line ~4013). Threshold + phrasing alignment only (a dispatched prompt, not a re-read workflow doc — a lighter touch than the marker/gate ritual applied to the workflow file).

### Changes

#### A. `switchboard-memo.md` — Add explicit analysis sub-step before the offer (new step 5)
After creating all plans and before reporting, the agent must **explicitly list all created plan titles** and identify any thematic clusters:

```markdown
5. **Feature grouping check (MANDATORY).** Before reporting, you MUST perform this check — do not skip to step 6.
   a. **Review:** List all plan files you just created with their titles in a compact table.
   b. **Cluster:** Identify any plans that share a common feature area, root cause, or capability theme. Minimum 2 plans to form a cluster.
   c. **Offer:** For each cluster found, ask the user: "These [N] plans cover [theme] — want me to create a feature to group them together?"
   d. **If no clusters:** State explicitly: "No related plan clusters found — all plans appear standalone."
   e. **Only create features on user confirmation.** Use the `create-feature-from-plans` skill or `create-feature.js` — never hand-write feature files.
```

#### B. `switchboard-memo.md` — Add a mandatory response marker
Require the agent to include `[FEATURE GROUPING CHECK]` in its response before the grouping analysis, similar to `[MEMO CAPTURE ACTIVE]` in capture mode. This makes the check visibly present (or visibly absent) in every `process memo` response.

#### C. `switchboard-memo.md` — Lower threshold from 3 to 2
Change "if 3 or more of the plans cover a related topic" to "if 2 or more plans share a common feature area or root cause."

#### D. `switchboard-memo.md` — Reorder: grouping check before report
Ensure the grouping check is the **last actionable step** before step 6 (report). The report in step 6 should include the grouping-check result. This prevents the agent from "finishing" at step 6 and never circling back.

#### E. `switchboard-memo.md` — Add anti-skip language
Add explicit instruction: "This step is mandatory. Do NOT proceed to step 6 (Report) without completing the feature grouping check. If you skip this step, the process memo flow is incomplete."

#### F. `_buildMemoPlannerPrompt` (TaskViewerProvider.ts:4013) — Align the sub-tab path
Lower the sub-tab prompt's grouping threshold from "3 or more" to "2 or more", and tighten the phrasing to instruct active review of the plans just created (rather than a passive conditional). Keep it proportionate: this is a one-shot dispatched prompt, so it does not need the `[FEATURE GROUPING CHECK]` marker or the multi-step gate — the threshold + "actively review the titles you just wrote for 2+ sharing a theme" phrasing is sufficient.

**Before (line 4013):**
```
- If you created 3 or more plan files that cover a related topic (sharing a common feature area or root cause), offer to create a feature grouping them: "These [N] plans cover related work — want me to create a feature to group them together?" ...
```
**After (threshold + phrasing):**
```
- After writing all plan files, review the titles you just created and look for 2 or more that share a common feature area or root cause. For each such cluster, offer to create a feature grouping them: "These [N] plans cover related work — want me to create a feature to group them together?" ...
```
(Everything after the offer sentence — the `create-feature.js` mechanics and the "Do NOT hand-write" guidance — stays byte-for-byte unchanged.)

### Proposed Step Structure (revised — `switchboard-memo.md`)

```
4. Create one plan per entry. (unchanged)
5. Feature grouping check (MANDATORY — do not skip).
   a. Review all created plan titles.
   b. Identify clusters of 2+ plans sharing a theme/root cause.
   c. Offer to group each cluster as a feature.
   d. If no clusters: state "No related plan clusters found."
   e. Only create features on user confirmation.
6. Report. (include grouping check outcome in the report)
```

## Metadata

- **Tags:** docs, refactor

- **Complexity:** 2

## User Review Required

- **None.** This is a prompt/workflow-text change with no product decision. The one scoping call — leaving the *general* chat button (`DEFAULT_CHAT_BASE_INSTRUCTIONS`) grouping threshold at 3+ while lowering both *memo* paths to 2 — is made deliberately (memo-scoped feature) and recorded in the feature file; it is not left open.

## Complexity Audit

### Routine
- Restructure of one markdown workflow section (`switchboard-memo.md` steps 4-6) — prose/format only.
- A single-line threshold + phrasing change in one TypeScript string template (`_buildMemoPlannerPrompt`).
- No control-flow, type, IPC, DB, or webview-contract changes.

### Complex / Risky
- **Regression guard (must not break):** `src/test/prompt-split-guidance-sync.test.js:140` asserts *"switchboard-memo.md step 5 must NOT mention splitting"* (a guard against a prior orphan-plan timing bug). The restructured step 5 is about **feature grouping**, not plan **splitting** — do NOT introduce any "split into multiple plans" language into step 5. The same test also asserts `_buildMemoPlannerPrompt` retains its splitting signals ("3+ distinct deliverables", "2+ independently-shippable phases", line 3996) and the Important-section splitting reference (line 4010); the change here is confined to line ~4013 (the grouping bullet) and must leave those lines intact.

## Edge-Case & Dependency Audit

- **Race Conditions:** None — both edits are static prompt text; no runtime state.
- **Security:** None — no new input surface; text is a static instruction.
- **Side Effects:** The `process memo` flow and the Memo sub-tab dispatch will now consistently surface a grouping offer at the 2-plan threshold. Slightly more grouping offers (by design); the user still confirms before any feature is created, so no unattended side effects.
- **Dependencies & Conflicts:**
  - **Shared-file coordination with the sibling metadata subtask:** the sibling ("Memo Process Prompt: Add Complexity Ratings & Correct Metadata Format") also edits `_buildMemoPlannerPrompt`, but a **disjoint region** — the `## Plan File Format` block (lines 3998-4007), not the grouping bullet (line ~4013) this plan owns. No overlap. Recommended landing order in the feature file.
  - **Skill references verified:** `create-feature-from-plans` and `create-feature` skills both exist under `.agents/skills/`. No new skill needs to be authored.
  - **`[FEATURE GROUPING CHECK]` marker scope:** applies only to `switchboard-memo.md` (a workflow the agent re-reads each turn). The sub-tab prompt is a one-shot dispatch and deliberately does not carry the marker.

## Adversarial Synthesis

Key risks: (1) accidentally introducing plan-**splitting** language into `switchboard-memo.md` step 5, tripping the `prompt-split-guidance-sync.test.js` regression guard — mitigated by keeping step 5 strictly about feature *grouping*; (2) over-engineering the sub-tab prompt with the full marker/gate ritual meant for the re-read workflow doc — mitigated by scoping the sub-tab change to threshold + phrasing only. Both risks are low-severity and prompt-text-only.

## Verification
- Run `process memo` with 3+ entries about the same feature area → agent must include `[FEATURE GROUPING CHECK]` and offer to group them.
- Run `process memo` with 2 entries about the same topic → agent must offer grouping (threshold lowered from 3 to 2).
- Run `process memo` with unrelated entries → agent must state "No related plan clusters found."
- Verify the agent does NOT skip to the report without performing the check.
- Verify features are only created after user confirmation.
- Memo sub-tab: click "Copy Prompt" with content that would produce 2 related plans → inspect the clipboard prompt and confirm the grouping bullet now reads "2 or more" and instructs an active review.
- Confirm `src/test/prompt-split-guidance-sync.test.js` still passes (step 5 must not mention splitting; `_buildMemoPlannerPrompt` splitting signals intact).

## Recommendation

Complexity 2 → **Send to Intern.**

## Completion Summary

Implemented the grouping-gate subtask by restructuring `.agents/workflows/switchboard-memo.md` step 5 into a mandatory `[FEATURE GROUPING CHECK]` gate with a 2-plan threshold, active title review, explicit cluster offer, and no-cluster reporting. Aligned `src/services/TaskViewerProvider.ts` `_buildMemoPlannerPrompt` grouping bullet to the same 2-plan active-review phrasing while leaving its plan-splitting signals untouched. No splitting language was introduced into `switchboard-memo.md` step 5.
