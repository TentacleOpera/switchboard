# Memo Workflow Quality

**Complexity:** 2

## Goal

Improve the reliability and output quality of the memo→plan pipeline so it produces complete, well-structured, groupable plans across **both** memo entry points (the `process memo` chat command and the Memo sub-tab "Send/Copy" button). One subtask fixes the memo planner prompt so generated plans carry correct metadata (numeric complexity ratings, allowed tags, project pins); the other makes the feature-grouping offer prominent, mandatory, and low-threshold. Both address the same capability theme: the memo-to-plan workflow producing complete, well-structured, groupable output — consistently, no matter which entry point the user used.

## How the Subtasks Achieve This

- **Memo Process Prompt: Add Complexity Ratings & Correct Metadata Format**: Rewrites the `## Plan File Format` Metadata spec in `_buildMemoPlannerPrompt` (TaskViewerProvider.ts, lines 3998-4007) to match the canonical format from `DEFAULT_CHAT_BASE_INSTRUCTIONS` / improve-plan SKILL.md (numeric `**Complexity:**`, the exact allowed `**Tags:**` vocabulary, conditional `**Project:**`), and syncs the chat-base tag vocabulary (`agentPromptBuilder.ts:793`) to include `authentication`. Result: all three plan-producing paths emit identical metadata instructions.
- **Memo Capture Should Prompt Agent to Suggest Feature Groupings When Relevant**: Restructures `switchboard-memo.md`'s Process Memo Command step 5 into a mandatory, marker-flagged (`[FEATURE GROUPING CHECK]`), anti-skip gate with a lowered threshold (2+ plans), AND lowers the same grouping offer in the Memo sub-tab dispatched prompt (`_buildMemoPlannerPrompt`, line ~4013) to 2+ so **both** memo entry points behave identically. The general chat-button grouping offer (`DEFAULT_CHAT_BASE_INSTRUCTIONS`) is intentionally left at 3+ — it is not a memo path (see Dependencies).

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Plan: Memo Capture Should Prompt Agent to Suggest Feature Groupings When Relevant](../plans/feature_plan_20260716_memo_capture_should_prompt_feature_grouping.md) — **CODE REVIEWED**
- [ ] [Memo Process Prompt: Add Complexity Ratings & Correct Metadata Format](../plans/feature_plan_20260716125702_memo-process-prompt-complexity-format.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

- **Cross-feature dependencies:** None. This feature stands alone.
- **Shared file — coordinate, don't parallelize blindly:** both subtasks edit `_buildMemoPlannerPrompt` in `src/services/TaskViewerProvider.ts`, but in **disjoint regions** — the metadata subtask owns the `## Plan File Format` block (lines 3998-4007); the grouping subtask owns the grouping-offer bullet (line ~4013). The edits do not overlap and are independently applicable. **Recommended landing order:** metadata subtask first (larger, self-contained block edit), then the grouping subtask's one-line threshold change — this minimizes rebase friction if the two are ever coded in separate worktrees. If coded together in one session, order is immaterial.
- **Reconciled end-state (feature audit):** the feature-grouping offer is duplicated across three prompt surfaces. Target end-state:
  - `switchboard-memo.md` step 5 → threshold **2+**, mandatory marker + anti-skip gate (grouping subtask).
  - `_buildMemoPlannerPrompt` line ~4013 (Memo sub-tab dispatch) → threshold **2+**, active-review phrasing (grouping subtask).
  - `DEFAULT_CHAT_BASE_INSTRUCTIONS` step 5 (general chat button, **not** a memo path) → **left at 3+** deliberately; only its tag list gains `authentication` (metadata subtask). Lowering it is out of scope for this memo-focused feature.
- **Regression guard both subtasks must respect:** `src/test/prompt-split-guidance-sync.test.js` asserts `switchboard-memo.md` step 5 must NOT mention plan **splitting**, and that `_buildMemoPlannerPrompt` retains its splitting signals. Keep step 5 about *grouping* only; keep the `_buildMemoPlannerPrompt` edits confined to the metadata block and the grouping bullet.

## Completion Summary

Implemented both memo-workflow-quality subtasks across the two memo entry points. Updated `src/services/TaskViewerProvider.ts` `_buildMemoPlannerPrompt` to use the explicit `**Complexity:**`, `**Tags:**`, and `**Project:**` metadata format and lowered the feature-grouping offer to a 2-plan threshold with active title review. Synced `authentication` into `DEFAULT_CHAT_BASE_INSTRUCTIONS` (`src/services/agentPromptBuilder.ts`) and `.agents/workflows/switchboard-cloud.md`. Restructured `.agents/workflows/switchboard-memo.md` step 5 into a mandatory `[FEATURE GROUPING CHECK]` gate with the same 2-plan threshold. Static grep verification passed; compilation and automated tests were skipped per session directives.

## Review Findings

Both subtasks' own edits verified correct against their plans. Review uncovered a CRITICAL pre-existing regression (introduced by the unrelated commit `a1928ce`, not by this feature): the Plan Sizing splitting signals required by `src/test/prompt-split-guidance-sync.test.js` had been deleted from `switchboard-memo.md` step 4, `switchboard-cloud.md`, and `switchboard-remote.md`, leaving the regression guard cited by both plans silently failing on 3 of 5 surfaces. Fixes applied during review: restored the "Before writing / 3+ distinct deliverables / 2+ independently-shippable phases / no orphan plans" sentence to `switchboard-memo.md:53` step 4; restored the 3-step "Assess scope → Plan → Gate" Process (with splitting signals) and the "step 5 (Gate)" pointer in `switchboard-cloud.md`, removing the forbidden standalone `## Feature Grouping` section; restored the `## Plan Sizing & Feature Grouping` header + splitting signals in `switchboard-remote.md`. Verification: 33 static assertions replicating the sync test's exact checks across all 5 prompt surfaces now pass (compilation and automated tests skipped per directives). Remaining risk: the `a1928ce` compact-Process rewrite of `switchboard-cloud.md` is partially reverted — if that compactness was a deliberate UX choice it warrants a separate follow-up.
