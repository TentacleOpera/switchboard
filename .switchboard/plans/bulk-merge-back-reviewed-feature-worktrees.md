# Merge a Batch of Reviewed Feature Worktrees Back in One Pass

## Goal

Give a single agent one instruction that merges N reviewed feature worktrees back to their integration targets in a deterministic order — in two modes: **verify**, where the agent reads each plan file's appended review outcome first, and **trusted**, where the operator asserts the batch is good and the agent merges without checking.

### Problem analysis

This is the closing half of the parallel-run workflow set up by `bulk-create-feature-worktrees-from-board-selection.md`. Six features get coded and reviewed in six isolated trees; then all six have to come home. Today that final step has no batch path at all.

What exists is `copyWorktreeMergePrompt` (`src/services/KanbanProvider.ts:11577`), and it is good — it should be extended, not replaced. It already encodes the hierarchy rules that make merging safe:

- A **subtask or tier** worktree converges into its feature's **integration** worktree, never into main.
- An **integration** worktree merges into main, with a warning when child branches have not converged yet.
- When a subtask's integration worktree is missing, it deliberately emits **no merge command** and tells the agent to ask which branch to target — refusing to let subtask work land on main by accident.

It is also strictly single-worktree. Merging six features means invoking it six times and shuttling six prompts by hand, and each prompt ends by asking the operator to confirm cleanup — six separate confirmations for one batch.

### Root cause

Two structural gaps, not a missing feature:

1. **The target-resolution logic is trapped inside a `case`.** Lines `:11599-11617` compute `targetPath` / `targetBranch` / `noTarget` / `note` for one worktree row. A bulk path needs exactly this, per tree. Reimplementing it in a loop is the failure mode to avoid: a bulk merge that bypasses an integration branch is precisely what the existing guard was written to prevent.
2. **Review state lives in two places, and one of them is inside the worktree.** The card's column (`CODE REVIEWED`) lives in `kanban.db` on the primary checkout, while the review outcome text is appended to the plan file **inside each worktree** at `<worktreePath>/.switchboard/plans/…`. Any agent verifying "did this pass" must read the worktree's copy, not the primary checkout's, and must have a stated rule for what happens when the two disagree.

### The plan-file conflict hazard

This is the sharpest risk in the batch case and it does not exist in the single case.

Every worktree in the batch modifies files under `.switchboard/plans/` — that is where review outcomes are appended. So N branches all carry edits to the same tracked directory, which produces a conflict class with nothing to do with the code, on files whose content the merge agent has no basis to arbitrate.

Worse, the merges land in the primary checkout, and working-tree-changing git operations there cause the plan-file watcher to re-import — which can wipe DB-only board state. Six merges in sequence means six re-import waves during the most state-sensitive operation in the workflow.

**Decision:** the batch prompt instructs the agent to pause live sync for the duration (the `pauseLiveSync` / `resumeLiveSync` verbs already exist) and to resolve plan-file conflicts by taking the incoming worktree's version — the worktree's copy is the one carrying the review outcome. Resume sync and refresh the board once at the end, not between merges.

## Implementation

### 1. Extract the target resolver

Lift lines `:11599-11617` into a private helper — `_resolveMergeTarget(wtRow, allWorktrees, workspaceRoot)` returning `{ targetPath, targetBranch, checkoutLabel, note, noTarget }`. The existing `case` calls it and its emitted prompt text stays byte-identical; the bulk path calls it once per tree. One implementation, two callers.

### 2. New verb: `copyBulkWorktreeMergePrompt`

Payload `{ workspaceRoot, worktreeIds: number[], mode: 'verify' | 'trusted' }`.

Resolve each row via `db.getWorktrees()`, run each through `_resolveMergeTarget`, and emit **one** prompt describing a merge queue.

**Ordering is part of the contract and must be stated in the prompt.** Children (subtask/tier) before their integration parent; integration trees last. Within a tier, creation order — deterministic and explainable beats clever. Any tree whose resolver returns `noTarget` is listed in a separate "needs your decision" section and excluded from the queue rather than merged on a guess.

### 3. Verify mode

The prompt instructs the agent, per feature and **before** merging it:

- read the feature's subtask plan files at `<worktreePath>/.switchboard/plans/…`;
- confirm each carries an appended review outcome that passes;
- skip any feature whose plans do not, and name it in the report with the reason.

State the disagreement rule explicitly: **the plan file inside the worktree wins**. A card sitting in `CODE REVIEWED` whose plan file records a failing review is not merged — the column is a board affordance an operator can drag, the appended outcome is what the reviewer actually wrote.

### 4. Trusted mode

Omit the plan-reading step entirely — the operator has asserted the batch is good and re-deriving that is wasted work. Trusted mode relaxes **only** the review check. It does not relax the hierarchy rules, the ordering, or the `noTarget` refusal; a subtask branch still must not land on main because the operator said the work was good.

### 5. Merge, verify, then continue

After each merge in the queue, build/test as appropriate before starting the next. Discovering a broken merge six merges later means unpicking an entangled history; discovering it immediately means one revert.

On a conflict the agent cannot resolve: stop the queue, report which trees merged and which did not, and leave the rest untouched. Never `git merge --abort` unless the operator says so — same wording as the existing single prompt.

### 6. One cleanup confirmation for the batch

The existing prompt asks about cleanup per worktree. At six trees that is six prompts for one decision. Ask once, at the end, listing the trees that merged successfully; on a yes, run the `worktree-cleanup` skill (`.agents/skills/worktree-cleanup/SKILL.md`, backed by `POST /worktree/cleanup`) for each. Trees that did not merge are never cleaned up.

### 7. Board affordance

A bulk merge action on the same multi-select used by the create plan, plus a mode choice for verify vs trusted. A two-option mode selector is a legitimate choice, not a confirmation gate — but there must be no "are you sure" step on top of it.

## Verification Plan

1. **Unit — resolver extraction is behaviour-preserving.** Golden-file the existing single-worktree prompt for an integration tree, a subtask tree with a present integration parent, and a subtask tree with a missing one. Assert byte-identical output after extraction. This is the regression surface of step 1.
2. **Unit — ordering.** A batch mixing two integration trees and three subtask trees. Assert children precede their parents and that the emitted order is deterministic across runs.
3. **Unit — `noTarget` exclusion.** A subtask tree with no integration parent in the batch. Assert it is listed under "needs your decision" and carries no merge command.
4. **Unit — trusted mode narrows correctly.** Assert trusted mode omits the plan-reading instructions but still emits the same ordering, the same hierarchy targets, and the same `noTarget` exclusion as verify mode.
5. **Unit — plan-file policy present.** Assert both modes' prompts carry the pause-live-sync instruction and the prefer-incoming rule for `.switchboard/plans/` conflicts. These are the guardrails; if they can silently drop out of the prompt they will.
6. **Manual — full round trip.** Using six trees created by the companion plan: code and review each, move the cards to `CODE REVIEWED` with outcomes appended, then run bulk merge in verify mode. Confirm all six merge in order, the board survives with its DB-only state intact, and one cleanup confirmation covers the batch.
7. **Manual — verify mode actually gates.** Leave one feature's plan file carrying a failing review outcome while its card sits in `CODE REVIEWED`. Confirm that feature is skipped and named, and the other five merge.
8. **Manual — conflict stop.** Force two features to touch the same file. Confirm the queue stops at the conflict, reports what merged, and leaves the remaining trees untouched and un-cleaned-up.
9. **Manual — stale worktree row.** Delete one tree from disk without updating its DB row (the Worktrees tab does no reconciliation, so this state is reachable). Confirm the batch detects and skips it rather than emitting a merge command for a path that is not there.

## Metadata

**Complexity:** 6
**Tags:** backend, feature, reliability, devops
**Project:** Browser Switchboard
