# Plan: Memo Capture Should Prompt Agent to Suggest Feature Groupings When Relevant

## Problem
After `process memo` creates plan files, the agent does not consistently offer to group related plans into features — even when the created plans clearly share a common theme or root cause. The feature grouping suggestion (step 5 of the Process Memo Command) is frequently skipped in practice.

## Root Cause
The memo capture workflow (`switchboard-memo.md`) **does** include step 5 instructing the agent to offer feature grouping, but the instruction is structurally weak and gets lost:

1. **Buried after a massive step 4.** Step 4 ("Create one plan per entry") is a very long paragraph covering plan format, naming conventions, project pins, and workspace resolution. By the time the agent finishes writing N plan files, it's primed to jump to step 6 (report) and skip step 5 entirely.

2. **No mandatory response marker.** Capture mode uses `[MEMO CAPTURE ACTIVE]` as a hard structural cue every turn. The processing flow has no equivalent marker forcing the grouping check to appear in the output.

3. **Vague analysis requirement.** The step says "if 3 or more of the plans cover a related topic" but doesn't instruct the agent to actively review the plan titles/contents it just generated and look for clusters. The agent must spontaneously decide to do this analysis — which it doesn't.

4. **Threshold too high.** "3 or more" plans sharing a topic is a high bar. Even 2 plans addressing the same feature area or root cause could benefit from grouping.

5. **No explicit "stop and evaluate" gate.** The steps flow linearly (4 → 5 → 6) with no explicit pause requiring the agent to evaluate before reporting. The agent treats step 5 as optional commentary rather than a mandatory gate.

## Fix
Restructure the Process Memo Command flow to make the feature grouping check **prominent, mandatory, and impossible to skip**.

### Files to Change
1. **`.agents/workflows/switchboard-memo.md`** — Process Memo Command section (steps 4-6)

### Changes

#### A. Add explicit analysis sub-step before the offer (new step 5a)
After creating all plans and before offering grouping, the agent must **explicitly list all created plan titles** and identify any thematic clusters:

```markdown
5. **Feature grouping check (MANDATORY).** Before reporting, you MUST perform this check — do not skip to step 6.
   a. **Review:** List all plan files you just created with their titles in a compact table.
   b. **Cluster:** Identify any plans that share a common feature area, root cause, or capability theme. Minimum 2 plans to form a cluster.
   c. **Offer:** For each cluster found, ask the user: "These [N] plans cover [theme] — want me to create a feature to group them together?"
   d. **If no clusters:** State explicitly: "No related plan clusters found — all plans appear standalone."
   e. **Only create features on user confirmation.** Use the `create-feature-from-plans` skill or `create-feature.js` — never hand-write feature files.
```

#### B. Add a mandatory response marker
Require the agent to include `[FEATURE GROUPING CHECK]` in its response before the grouping analysis, similar to `[MEMO CAPTURE ACTIVE]` in capture mode. This makes the check visibly present (or visibly absent) in every `process memo` response.

#### C. Lower threshold from 3 to 2
Change "if 3 or more of the plans cover a related topic" to "if 2 or more plans share a common feature area or root cause."

#### D. Reorder: grouping check before report
Ensure step 5 (grouping check) is the **last actionable step** before step 6 (report). The report in step 6 should include the grouping check result. This prevents the agent from "finishing" at step 6 and never circling back.

#### E. Add anti-skip language
Add explicit instruction: "This step is mandatory. Do NOT proceed to step 6 (Report) without completing the feature grouping check. If you skip this step, the process memo flow is incomplete."

### Proposed Step Structure (revised)

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

## Verification
- Run `process memo` with 3+ entries about the same feature area → agent must include `[FEATURE GROUPING CHECK]` and offer to group them.
- Run `process memo` with 2 entries about the same topic → agent must offer grouping (threshold lowered from 3 to 2).
- Run `process memo` with unrelated entries → agent must state "No related plan clusters found."
- Verify the agent does NOT skip to the report without performing the check.
- Verify features are only created after user confirmation.
