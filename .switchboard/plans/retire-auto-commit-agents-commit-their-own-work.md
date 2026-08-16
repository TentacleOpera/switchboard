# Retire Auto-Commit — Leads and Reviewers Commit, and a Review Commit Means Done

## Goal

Delete `autoCommitForCodeReview`. Commit responsibility moves to the roles that already have a per-role commit strategy — the lead and the reviewer — and a reviewer's commit becomes the git-visible marker that a plan is finished.

### Why

**Two committers, one of them blind.** `GIT_COMMIT_CLAUSES.whenDone` (`agentPromptBuilder.ts:574`) already tells a dispatched agent to commit when finished. `autoCommitForCodeReview` (`TaskViewerProvider.ts:6898`) separately runs `git add -A` before code review. With both active the agent makes a real commit and the extension then commits **whatever is left** — board bookkeeping, under a generic message.

**The tree is never clean.** `.switchboard/plans/` and `.switchboard/features/` are deliberately un-ignored (`.gitignore:53-56`) and the board rewrites status metadata into them on import, on card move, on feature reconcile. From a real commit here (`0269d6a`): eleven plan and feature files of 4-line churn alongside three files of actual work, under a message describing only the work.

**A review commit is a completion signal.** It is unambiguous, in git, and it means *reviewed* rather than *written* — which the persona's "verify via git, status of record" rule already asks for and has no clean source of today.

**The per-role mechanism exists, but it deliberately excludes the reviewer — and that exclusion is the real decision here.** `gitCommitStrategyByRole` (`KanbanProvider.ts:5397`) resolves `lead`, `coder`, `intern` and `claude_designer` from role config and hardcodes the rest to `'notSpecified'`. That is not an oversight: `sharedDefaults.js:62` scopes the three git-policy radios to *"the four code-writing roles"*, the reviewer's default addons carry `gitProhibition` and none of the three strategies, and the UI renders `ROLE_ADDONS[role]` so the control never appears for a reviewer. All three layers agree. Nothing is silently ignored and there is no dead control.

So letting a reviewer commit is not unhardcoding a line — it changes what a reviewer **is**. Today the model has one category, "roles that touch git," and the reviewer is outside it. This introduces a distinction the model does not currently draw: signing off on work someone else wrote is not the same as writing code, and only the first is being granted.

## What changes

**1. Delete auto-commit** — `autoCommitForCodeReview`, the `switchboard.kanban.autoCommitOnCodeReview` setting, its `globalState` read, and the call site.

**2. Give the reviewer a commit strategy — three changes, all of them required.** Missing any one leaves a control that does nothing or an option nobody can set:

- `sharedDefaults.js` — add `gitCommitStrategy` to the reviewer's default addons.
- `ROLE_ADDONS.reviewer` — add the radio so the control renders.
- `KanbanProvider.ts:5403` — read `reviewerConfig?.addons?.gitCommitStrategy`, as `lead` and `coder` do.

Give the reviewer **only** the commit strategy. Not branch, not push. The grant is "may commit work it has reviewed", not "is now a code-writing role", and adding the other two radios would erase the distinction this plan is introducing.

Leave the `'incremental'` → `'notSpecified'` mapping intact — a retired value, not this plan's business.

**3. Tighten `whenDone`.** "Stage all your changes" is the same greedy instruction that made the extension's version messy — an agent following it literally runs `git add -A` and sweeps the board churn itself. It should say: stage the files you changed, by path; never `git add -A` or `git add .`; nothing under `.switchboard/` except this plan's own file, whose completion report is part of the work; one commit, message describing the change.

**4. Both options, independently settable.** Lead commits, reviewer commits, either, or neither. `dontCommit` stays for dispatches where work is deliberately left in the tree.

`planner`, `tester`, `analyst`, `researcher` and `ticket_updater` stay as they are. They are excluded for the same deliberate reason, and nothing here needs them.

## Metadata

**Complexity:** 3
**Tags:** refactor, backend, reliability

## Verification Plan

1. Nothing in `src/` references `autoCommitForCodeReview` or `autoCommitOnCodeReview`.
2. The commit-strategy control appears in the reviewer's role config, and setting it to `whenDone` produces a `GIT POLICY:` block with a commit clause in the reviewer's dispatch prompt — all three layers wired, not two.
2a. The reviewer gains **no** branch or push strategy control.
3. A reviewer finishing a review produces one commit containing the reviewed changes — no other plan or feature files.
4. That commit is identifiable as a review commit, so "reviewed" can be read from git rather than inferred.
5. Lead and reviewer strategies are independent — setting one does not change the other.
6. Board churn in `.switchboard/plans/` remains uncommitted after both.
7. `dontCommit` on any role still leaves that role's work in the working tree.
8. No `git add -A` appears anywhere in the emitted policy text.
