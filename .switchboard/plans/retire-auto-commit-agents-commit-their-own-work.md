# Retire Auto-Commit — Leads and Reviewers Commit, and a Review Commit Means Done

## Goal

Delete `autoCommitForCodeReview`. Commit responsibility moves to the roles that already have a per-role commit strategy — the lead and the reviewer — and a reviewer's commit becomes the git-visible marker that a plan is finished.

### Why

**Two committers, one of them blind.** `GIT_COMMIT_CLAUSES.whenDone` (`agentPromptBuilder.ts:574`) already tells a dispatched agent to commit when finished. `autoCommitForCodeReview` (`TaskViewerProvider.ts:6898`) separately runs `git add -A` before code review. With both active the agent makes a real commit and the extension then commits **whatever is left** — board bookkeeping, under a generic message.

**The tree is never clean.** `.switchboard/plans/` and `.switchboard/features/` are deliberately un-ignored (`.gitignore:53-56`) and the board rewrites status metadata into them on import, on card move, on feature reconcile. From a real commit here (`0269d6a`): eleven plan and feature files of 4-line churn alongside three files of actual work, under a message describing only the work.

**A review commit is a completion signal.** It is unambiguous, in git, and it means *reviewed* rather than *written* — which the persona's "verify via git, status of record" rule already asks for and has no clean source of today.

**The per-role mechanism exists but the reviewer is locked out.** `gitCommitStrategyByRole` (`KanbanProvider.ts:5397`) resolves per role, and `lead`, `coder`, `intern` and `claude_designer` read from their role config. `reviewer` is the hardcoded literal `'notSpecified'` (`:5403`) — as are `planner`, `tester`, `analyst`, `researcher` and `ticket_updater`. So a reviewer cannot be given a commit strategy at all, whatever its config says.

## What changes

**1. Delete auto-commit** — `autoCommitForCodeReview`, the `switchboard.kanban.autoCommitOnCodeReview` setting, its `globalState` read, and the call site.

**2. Let the reviewer's config reach the prompt.** Read `reviewerConfig?.addons?.gitCommitStrategy` at `:5403`, exactly as `lead` and `coder` do. Leave the `'incremental'` → `'notSpecified'` mapping intact — that is a retired value and not this plan's business.

**3. Tighten `whenDone`.** "Stage all your changes" is the same greedy instruction that made the extension's version messy — an agent following it literally runs `git add -A` and sweeps the board churn itself. It should say: stage the files you changed, by path; never `git add -A` or `git add .`; nothing under `.switchboard/` except this plan's own file, whose completion report is part of the work; one commit, message describing the change.

**4. Both options, independently settable.** Lead commits, reviewer commits, either, or neither. `dontCommit` stays for dispatches where work is deliberately left in the tree.

The other hardcoded roles are out of scope. Unlock the reviewer because it is the one this needs; the rest can follow when something needs them.

## Metadata

**Complexity:** 3
**Tags:** refactor, backend, reliability

## Verification Plan

1. Nothing in `src/` references `autoCommitForCodeReview` or `autoCommitOnCodeReview`.
2. Setting the reviewer role's commit strategy to `whenDone` produces a `GIT POLICY:` block with a commit clause in the reviewer's dispatch prompt.
3. A reviewer finishing a review produces one commit containing the reviewed changes — no other plan or feature files.
4. That commit is identifiable as a review commit, so "reviewed" can be read from git rather than inferred.
5. Lead and reviewer strategies are independent — setting one does not change the other.
6. Board churn in `.switchboard/plans/` remains uncommitted after both.
7. `dontCommit` on any role still leaves that role's work in the working tree.
8. No `git add -A` appears anywhere in the emitted policy text.
