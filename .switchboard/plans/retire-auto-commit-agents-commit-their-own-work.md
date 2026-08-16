# Retire Auto-Commit — the Agent That Did the Work Commits It

## Goal

Delete `autoCommitForCodeReview`. The agent that wrote the code stages the files it changed and writes its own commit message, using the git policy clause that already exists.

### Why

**There are two committers, and one of them is blind.** `GIT_COMMIT_CLAUSES.whenDone` (`agentPromptBuilder.ts:574`) already tells a dispatched agent: *"When you have finished the task, stage all your changes and create a single descriptive commit."* Separately, `autoCommitForCodeReview` (`TaskViewerProvider.ts:6898`) runs `git add -A` and commits before code review.

When both are active the agent makes a proper commit, and then auto-commit fires and commits **whatever is left** — which is board bookkeeping, under a generic message.

**The tree is never clean, so auto-commit always finds something.** `.switchboard/plans/` and `.switchboard/features/` are deliberately un-ignored (`.gitignore:53-56`) and the board rewrites status metadata into them on import, on card move, on feature reconcile. From a real commit here (`0269d6a`, "Kanban Board & Automation Tab Cleanup"): eleven plan and feature files of 4-line metadata churn, alongside three files of actual work, under a message describing only the work.

**The agent knows what it changed; the extension is guessing.** Any extension-side rule — exclude `.switchboard/`, derive the file set from the plan's declared files-to-modify — is a heuristic over information the agent has exactly. And no heuristic produces a commit message worth reading.

## What changes

**1. Delete auto-commit.** `autoCommitForCodeReview`, the `switchboard.kanban.autoCommitOnCodeReview` setting, its `globalState` read, and the call site before code review.

**2. Tighten the `whenDone` clause.** "Stage all your changes" is the same greedy instruction that made the extension's version messy — an agent following it literally runs `git add -A` and sweeps the board churn itself. It should say, in substance: stage the files you changed, by path. Never `git add -A` or `git add .`. Nothing under `.switchboard/` except this plan's own file, whose completion report is part of the work. One commit, message describing the change.

**3. Team leads get the same clause.** A lead that commits integration work is doing the same job under the same rule.

**`dontCommit` stays** — leaving work in the tree for the user to review is a legitimate dispatch mode and is unaffected.

## The risk, stated

This moves a guaranteed mechanism to an instructed one, and instructions in this system are the layer that fails. If an agent does not commit, its work sits in the working tree: visible, reviewable, and not lost. That is a recoverable outcome, and a better one than a bookkeeping commit under a generic message — which is what the guarantee actually produces today.

## Metadata

**Complexity:** 3
**Tags:** refactor, backend, reliability

## Verification Plan

1. Nothing in `src/` references `autoCommitForCodeReview` or `autoCommitOnCodeReview`.
2. A dispatched coder finishing a subtask produces exactly one commit, containing its source changes and its own plan file — no other plan or feature files.
3. That commit's message describes the change, not a timestamp and a topic.
4. Board churn in `.switchboard/plans/` is still uncommitted after the agent finishes.
5. An agent that fails to commit leaves its work in the tree and nothing else commits it on its behalf.
6. A dispatch using `dontCommit` still leaves everything in the working tree.
7. A lead committing integration work follows the same rule — no `git add -A` anywhere in the policy text.
