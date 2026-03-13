---
description: Internal adversarial review workflow (self mode only)
---
# Challenge - Internal Adversarial Review

This workflow is internal-only. It does not dispatch to external agents.

Use this for:
- `/challenge --self`
- `/challenge`

## File Creation Rules
- When creating files in `.switchboard/`, always use `IsArtifact: false` to prevent path validation errors.

## Quick Reference
- **Valid Actions**: None (internal-only workflow, no cross-agent delegation)

## CRITICAL CONSTRAINTS

> [!CAUTION]
> **YOU ARE A REVIEWER. NOT AN IMPLEMENTER. DO NOT CONFUSE THE TWO.**

- **NO IMPLEMENTATION**: You are strictly FORBIDDEN from modifying any project source files to fix the issues you identify. This applies to ALL tools including `write_to_file`, `replace_file_content`, `multi_replace_file_content`, and `run_command`.
- **PLAN ONLY**: Your ONLY permissible write action (beyond the review artifact files) is updating the existing Feature Plan document (`.switchboard/plans/features/*.md`) to reflect approved findings.
- **VIOLATION RESPONSE**: If you feel tempted to fix something yourself, STOP IMMEDIATELY. Call `notify_user` to explain what you found and await instructions. Do not apply the fix.
- **NO SKIPPING REVIEWS**: You must ALWAYS perform a fresh adversarial review. NEVER skip the review just because the plan document already contains headers like "Adversarial Synthesis", "Grumpy Critique", or "Balanced Response". Existing reviews must be considered stale and overwritten.
- **CONTENT PRESERVATION**: You are FORBIDDEN from deleting original implementation details, prose, or context. Your goal is to **APPEND** or **OVERWRITE ONLY THE REVIEW SECTION**, not replace or truncate the rest of the plan.
- **NOTE**: This is advisory governance. The tools remain available; compliance is required by role, not enforced by the system.

## Steps

1. **Start + Scope**
   - Call `start_workflow(name: "challenge", force: true)` to auto-replace any stale workflows.
   - Identify the exact plan/code scope to review from the user's message (e.g. a file link, plan name, or path).
   - **PIN THE TARGET SESSION NOW** — scan `.switchboard/sessions/*.json` to find the session whose `planFile` matches the target plan. Store this as `targetSessionId` and `targetPlanFile`. Do NOT defer this to step 5. If no matching session is found, ask the user to confirm the correct plan before proceeding.
   - `targetSessionId` will be passed to `complete_workflow_phase(phase: 5)` to guarantee the correct Kanban card is promoted, even if the user creates new plans during the review.
   - Resolve output paths up front:
     - `grumpyPath` default: `.switchboard/reviews/grumpy_critique.md`
     - `balancedPath` default: `.switchboard/reviews/balanced_review.md`
     - If user explicitly requests different filenames, use those filenames for all subsequent steps.
   - Call `complete_workflow_phase(phase: 1, workflow: "challenge", artifacts: [{ path: ".switchboard", description: "Internal review scope established" }])`.

2. **Dependency & Conflict Check**
   - MANDATORY: Read the code of any service, utility, or module being modified or worked around.
   - MANDATORY: Scan `.switchboard/plans/` or the current Kanban state to identify if this plan conflicts with, or relies on, other pending work.
   - Do not assume black-box behavior. Verify actual implementation before review.
   - Call `complete_workflow_phase(phase: 2, workflow: "challenge", artifacts: [{ path: ".switchboard", description: "Dependencies verified" }])`.

3. **Execute Internal Review**
   - ⛔ Do NOT implement any findings. Update the Feature Plan only.
   - ⚠️ ALWAYS perform a fresh review. If the plan already contains an "Adversarial Synthesis", overwrite it. Do NOT skip this step.
   - MUST read current plan/task objective.
   - MUST read `.agent/personas/grumpy.md`. If missing, HALT.
   - Generate `grumpyPath` in CRITICAL/MAJOR/NIT format.
   - MUST include at least 5 distinct findings.
   - MUST read `.agent/personas/lead_developer.md`. If missing, HALT.
   - Generate `balancedPath` with:
     - Summary of Review
     - Valid Concerns
     - Action Plan
     - Dismissed Points
   - Call `complete_workflow_phase(phase: 3, workflow: "challenge", artifacts: [{ path: "<grumpyPath>", description: "Adversarial critique" }, { path: "<balancedPath>", description: "Balanced synthesis" }])`.

4. **Present Findings**
   - Notify user with both artifact paths:
     - `grumpyPath`
     - `balancedPath`
   - Call `complete_workflow_phase(phase: 4, workflow: "challenge", artifacts: [{ path: ".switchboard/reviews", description: "Findings presented to user" }])`.

5. **Complete + Integrate**
   - MANDATORY before calling `complete_workflow_phase`: update the original Feature Plan document with the Action Plan items from the balanced review.
     - Use `targetPlanFile` pinned in Step 1 as the absolute path to the Feature Plan. **DO NOT re-read the sessions directory** to find the plan — this would pick up the most-recently-touched session which may be a different plan if the user created new plans during the review.
     - Edit the Feature Plan to integrate the approved Action Plan items. ⚠️ **CRITICAL: Ensure you do NOT truncate, summarize, or delete the existing implementation steps, code blocks, or goal statements when editing.** This is a permitted write under the CRITICAL CONSTRAINTS block — it is orchestration, not implementation.
   - Call `complete_workflow_phase(phase: 5, workflow: "challenge", sessionId: "<targetSessionId>", artifacts: [{ path: "<balancedPath>", description: "Final internal review output" }, { path: "<targetPlanFile>", description: "Feature Plan updated with review findings" }])`.
   - **Kanban**: Passing `sessionId` ensures the correct card is promoted to **PLAN REVIEWED**, regardless of any other plan activity during the review.
     > [!NOTE]
     > `targetSessionId` must be the value pinned in Step 1. Omitting it falls back to the most-recently-active session (unsafe if plans were created during the review).

## Final-Phase Recovery Rule
- Phase 5 is terminal for `challenge`. Do NOT call phase 6.
- If phase 5 succeeded but summary still shows active:
  - Call `get_workflow_state`.
  - If still active, call `stop_workflow(reason: "Recovery: final phase completed but workflow remained active")`.
