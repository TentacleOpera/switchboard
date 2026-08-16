# Auto-Commit Stages the Work, Not the Whole Tree

## Goal

`autoCommitForCodeReview` commits the code that was written plus the plan file that records it — not every file the board happened to touch while the agent was working.

### Why

`TaskViewerProvider.ts:6907` runs `git add -A` unconditionally, then commits. The working tree is never clean, because `.switchboard/plans/` and `.switchboard/features/` are deliberately un-ignored (`.gitignore:53-56`) and the board rewrites status metadata into those files continuously — on import, on card move, on feature reconcile.

The result, from a real commit in this repo (`0269d6a`, "Kanban Board & Automation Tab Cleanup"):

```
11 plan/feature .md files      mostly 4-line metadata churn, unrelated to the change
src/services/ControlPlaneMigrationService.ts   12 +-
src/standalone/cli.ts                          74 ++-
src/test/control-plane-repo-scope.test.js       4 +-
```

Three files of actual work, eleven files of board bookkeeping, one commit message describing only the work. Every auto-commit looks like this. The history is unreadable, `git log -- <file>` is noise, and reverting a change means untangling it from board state that was never part of it.

## What changes

**Stage explicitly, never `-A`.** The commit contains:

- Source changes — everything outside `.switchboard/`.
- The plan file(s) for the plan under review. Its completion report *is* part of the work and belongs in the commit.

Everything else under `.switchboard/` is excluded. Board bookkeeping is not a code change and does not belong in a code commit.

**Do not try to derive the file set from the plan's declared files-to-modify.** A plan that understates its file set would silently leave real work uncommitted, which is worse than committing too much. Excluding board state is a rule about what is *never* work; guessing what *is* work is a different and riskier problem.

**Leave board churn uncommitted.** It stays in the working tree exactly as it does today between auto-commits. Nothing about board state depends on being committed.

## Note for parallel teams

`git add -A` is correct inside a worktree, where the tree contains one team's work by construction. It is wrong in a shared checkout, and with two or more teams working at once it will commit another team's half-finished files under this team's message. If parallel teams ever run in one checkout, this fix is the precondition — not an improvement.

## Metadata

**Complexity:** 2
**Tags:** bugfix, backend, reliability

## Verification Plan

1. With board churn present in `.switchboard/plans/`, an auto-commit contains only source files plus the reviewed plan's own file.
2. `git status` after an auto-commit still shows the board churn, untouched and uncommitted.
3. A plan whose completion report was just appended has that report in the commit.
4. A change touching no source files at all — plan file only — still produces a sensible commit rather than an empty one or a failure.
5. Nothing under `.switchboard/features/` enters a code commit.
6. Auto-commit remains off by default (`TaskViewerProvider.ts:6891`); this changes what it stages, not when it runs.
