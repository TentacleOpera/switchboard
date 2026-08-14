# Merge a Batch of Reviewed Feature Worktrees Back in One Pass

## Goal

Give a single agent one instruction that merges N reviewed feature worktrees back to their integration targets in a deterministic order — in two modes: **verify**, where the agent reads each plan file's appended review outcome first, and **trusted**, where the operator asserts the batch is good and the agent merges without checking.

### Problem analysis

This is the closing half of the parallel-run workflow set up by `bulk-create-feature-worktrees-from-board-selection.md`. Six features get coded and reviewed in six isolated trees; then all six have to come home. Today that final step has no batch path at all.

What exists is `copyWorktreeMergePrompt` (`src/services/KanbanProvider.ts:11902`), and it is good — it should be extended, not replaced. It already encodes the hierarchy rules that make merging safe:

- A **subtask or tier** worktree converges into its feature's **integration** worktree, never into main.
- An **integration** worktree merges into main, with a warning when child branches have not converged yet.
- When a subtask's integration worktree is missing, it deliberately emits **no merge command** and tells the agent to ask which branch to target — refusing to let subtask work land on main by accident.

It is also strictly single-worktree. Merging six features means invoking it six times and shuttling six prompts by hand, and each prompt ends by asking the operator to confirm cleanup — six separate confirmations for one batch.

### Root cause

Two structural gaps, not a missing feature:

1. **The target-resolution logic is trapped inside a `case`.** Lines `:11916-11942` compute `defaultBranch` / `targetPath` / `targetBranch` / `checkoutLabel` / `noTarget` / `note` for one worktree row. A bulk path needs exactly this, per tree. Reimplementing it in a loop is the failure mode to avoid: a bulk merge that bypasses an integration branch is precisely what the existing guard was written to prevent.
2. **Review state lives in two places, and one of them is inside the worktree.** The card's column (`CODE REVIEWED`) lives in `kanban.db` on the primary checkout, while the review outcome text is appended to the plan file **inside each worktree** at `<worktreePath>/.switchboard/plans/…`. Any agent verifying "did this pass" must read the worktree's copy, not the primary checkout's, and must have a stated rule for what happens when the two disagree.

### The plan-file conflict hazard

This is the sharpest risk in the batch case and it does not exist in the single case.

Every worktree in the batch modifies files under `.switchboard/plans/` — that is where review outcomes are appended. So N branches all carry edits to the same tracked directory, which produces a conflict class with nothing to do with the code, on files whose content the merge agent has no basis to arbitrate.

The merges also land in the primary checkout, where the plan-file watcher is live and will re-import every `.switchboard/plans/*.md` the merge touches.

> **Superseded:** "working-tree-changing git operations there cause the plan-file watcher to re-import — which can wipe DB-only board state. Six merges in sequence means six re-import waves during the most state-sensitive operation in the workflow. **Decision:** the batch prompt instructs the agent to pause live sync for the duration (the `pauseLiveSync` / `resumeLiveSync` verbs already exist)…"
> **Reason:** both halves are wrong at HEAD, and the second names a verb that does something else entirely.
>
> *On the hazard:* re-import cannot wipe the board columns. `PlanFileImporter` routes every file-derived record through `insertFileDerivedPlan` precisely because, in its own comment, it "has no business setting DB-owned columns (is_feature, feature_id, kanban_column, status)" (`src/services/PlanFileImporter.ts:141-142`). `insertFileDerivedPlan`'s `ON CONFLICT` clause additionally self-assigns `project` / `project_id` so "no file-derived re-import can ever move a card between projects" (`src/services/KanbanDatabase.ts:2309-2325`). A merge that modifies plan files therefore updates topic/complexity/tags and leaves column, status, feature membership and project untouched.
>
> *On the mitigation:* `pauseLiveSync` / `resumeLiveSync` (`KanbanProvider.ts:10427-10440`) call `ContinuousSyncService.pausePlan(sessionId)` / `resumePlan(sessionId, workspaceRoot)`. That service is the **remote-integration** live sync — it tracks `issueId` / `contentHash` and `markExternallyWritten` for Linear/Notion-backed plans. It is per-plan (needs a `sessionId` for each card), and it has no connection to `PlanIngestionEngine`'s file watcher. Instructing the agent to call it would produce a prompt that looks careful and protects nothing.
>
> The only watcher-side suppression that exists is `isGitOpActive` (`src/services/PlanIngestionEngine.ts:551`), and it does not apply either: it is armed **only** when `.git/HEAD`'s *content* changes (`:536`, 15-second TTL) — a branch switch, not a merge onto the current branch — and it is consulted only by `runPurgeSweep` (`:585`) and `ContinuousSyncService` (`:290`), never by the file-change handler that performs the import.
>
> **Replaced with:** two decisions, one dropped and one kept.
>
> - **Dropped:** the live-sync pause instruction. There is no verb that suspends plan-file re-import, and the prompt must not pretend otherwise. Re-import during the batch is noisy (board refreshes between merges) but not destructive, and the noise is acceptable. If a genuine suspension is wanted later it is a real code change — an `setImportSuspended(workspaceRoot, untilMs)` on `PlanIngestionEngine` honoured by the debounced file handler, exposed as a verb — and it should be scoped as its own plan, not smuggled in as an instruction to an agent.
> - **Kept, and it is the load-bearing half:** resolve `.switchboard/plans/` conflicts by taking the incoming worktree's version. The worktree's copy is the one carrying the review outcome. Refresh the board once at the end rather than between merges.
>
> One residual watcher interaction is worth stating in the prompt: `runPurgeSweep` marks plans missing when their files have been absent for over 24 hours (`PlanIngestionEngine.ts:588-596`). A merge that *deletes* plan files is therefore safe in the short term, but a batch that removes plan files should be reported so the operator knows what left the board.

## Metadata

**Complexity:** 6
**Tags:** backend, feature, reliability, devops
**Project:** Browser Switchboard

## User Review Required

None. Ordering, the `noTarget` refusal, the plan-file-wins disagreement rule, the prefer-incoming conflict policy, and the single end-of-batch cleanup ask are all decided below.

## Complexity Audit

### Routine

- Extracting a self-contained block of target-resolution logic into a private helper.
- A second verb that loops the helper and concatenates prompt sections.
- A mode selector in the multi-select action bar.

### Complex / Risky

- The extraction must leave the existing single-worktree prompt byte-identical on ~4,000 shipped installs — the prompt text *is* the contract with the merge agent.
- Ordering is a correctness property, not a nicety: a child merged after its parent silently defeats the integration-branch guard.
- The prompt's guardrails (ordering, `noTarget` exclusion, prefer-incoming) live in generated text, so they can silently drop out without any test noticing unless asserted.

## Implementation

### 1. Extract the target resolver

Lift lines `:11916-11942` into a private helper — `_resolveMergeTarget(wtRow, allWorktrees, workspaceRoot)` returning `{ defaultBranch, targetPath, targetBranch, checkoutLabel, note, noTarget }`. The existing `case` calls it and its emitted prompt text stays byte-identical; the bulk path calls it once per tree. One implementation, two callers.

Note the block opens with `const defaultBranch = wtRow.base_branch || await this._resolveDefaultBranch(workspaceRoot)` (`:11916`) — the helper must own that resolution too, because `targetBranch` defaults to it. Keep it inside the helper rather than passing it in, so the two callers cannot diverge on the fallback.

### 2. New verb: `copyBulkWorktreeMergePrompt`

Payload `{ workspaceRoot, worktreeIds: number[], mode: 'verify' | 'trusted' }`.

Resolve each row via `db.getWorktrees()`, run each through `_resolveMergeTarget`, and emit **one** prompt describing a merge queue.

**Ordering is part of the contract and must be stated in the prompt.** Children (subtask/tier) before their integration parent; integration trees last. Within a tier, creation order — deterministic and explainable beats clever. Any tree whose resolver returns `noTarget` is listed in a separate "needs your decision" section and excluded from the queue rather than merged on a guess.

**Register the verb properly.** Add it to `src/generated/verbAllowlist.ts` via `npm run catalog:check` (`package.json:887`) and add a `verbSchemas.ts` entry beside `copyWorktreeMergePrompt` (`:496`): `worktreeIds` required array, `mode` string, `workspaceRoot` optional. Return the prompt in the HTTP body per PRD contract #4, mirroring what the single verb already does (`:11962`). The existing verb also pushes `mergePromptReady` to the webview; the bulk verb should push the same message shape so the webview's clipboard handling is reused rather than forked.

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

On a conflict the agent cannot resolve: stop the queue, report which trees merged and which did not, and leave the rest untouched. Never `git merge --abort` unless the operator says so — same wording as the existing single prompt (`:11955`).

For `.switchboard/plans/` conflicts specifically, take the incoming worktree's version (per the decision above). Do not extend that rule to source files — the existing single prompt's "keep both sides' intent; prefer the incoming feature work where they overlap" stays as-is for code.

### 6. One cleanup confirmation for the batch

The existing prompt asks about cleanup per worktree (`:11960`). At six trees that is six prompts for one decision. Ask once, at the end, listing the trees that merged successfully; on a yes, run the `worktree-cleanup` skill (`.agents/skills/worktree-cleanup/SKILL.md`, backed by `POST /worktree/cleanup` — confirmed live at `src/services/LocalApiServer.ts:3977`) for each. Trees that did not merge are never cleaned up.

This is one decision point at the end of a long agent run, not a confirm gate on a button — the project's no-confirmation rule applies to UI controls, and this stays in the prompt text where the existing single-worktree version already puts it.

### 7. Board affordance

A bulk merge action on the same multi-select used by the create plan, plus a mode choice for verify vs trusted. A two-option mode selector is a legitimate choice, not a confirmation gate — but there must be no "are you sure" step on top of it.

Route any progress or result push through the broadcast transport, not a raw `panel.webview.postMessage`: `scripts/check-push-routing.js` holds `KanbanProvider.ts` at a baseline of **1** raw send and fails the build on a second.

## Edge-Case & Dependency Audit

**Race conditions.** `db.getWorktrees()` is snapshotted once when the prompt is generated; the operator can abandon or clean up a tree between generation and the agent running it. The prompt is text, not a live handle, so this is inherent — mitigate by having the prompt instruct the agent to re-check each path exists before merging it (which also covers the stale-row case below). Re-import waves during the batch can refresh the board mid-run; harmless per the analysis above.

**Security.** No new network surface beyond the verb; the schema is the boundary check. Worktree ids are numeric DB keys, and paths come from the DB row rather than the caller.

**Side effects.** Merges mutate the primary checkout. Plan-file re-import fires per merged file and updates file-derived fields only. `runPurgeSweep` will eventually mark plans whose files a merge deleted, after 24 hours.

**Dependencies & conflicts.**
- Not blocked by either sibling — it operates on worktrees that exist, however they were created, and does not depend on which surface their terminals live on.
- **But it contends with `bulk-create-feature-worktrees-from-board-selection.md` on three files**: `src/services/KanbanProvider.ts` (both add a verb case), `src/services/verbSchemas.ts` (both append), and `src/generated/verbAllowlist.ts` (a single generated line both regenerate). Per the project PRD's "one agent stream per provider file", the two must **serialise**, not run concurrently. Both also add a control to the same multi-select action bar in `kanban.html`.

## Dependencies

- None blocking. Serialise against `bulk-create-feature-worktrees-from-board-selection.md` on `KanbanProvider.ts`, `verbSchemas.ts`, `verbAllowlist.ts` and the `kanban.html` action bar.

## Adversarial Synthesis

**Risk summary.** The dominant risk is a guardrail that exists only as generated prose: ordering, the `noTarget` exclusion and the prefer-incoming plan-file rule can silently drop out of the prompt and nothing fails. Mitigations: golden-file the existing single-worktree prompt across all three hierarchy shapes so the extraction is provably byte-identical, and assert the presence of each batch guardrail string in both modes. Secondary risk: a mitigation that protects nothing — the previous revision's live-sync pause named a per-plan remote-sync verb with no bearing on the file watcher; it is removed rather than reworded, and the residual re-import behaviour is documented as benign with evidence.

## Proposed Changes

### `src/services/KanbanProvider.ts`

- **Context.** `case 'copyWorktreeMergePrompt'` at `:11902`; target resolution at `:11916-11942`; prompt assembly at `:11944-11962`; `cleanupWorktree` at `:11964`.
- **Logic.** Extract `_resolveMergeTarget`; add `case 'copyBulkWorktreeMergePrompt'` building an ordered queue over N rows in two modes.
- **Implementation.** Helper owns the `base_branch || _resolveDefaultBranch` fallback. Bulk arm sorts children-before-parents, partitions `noTarget` rows into a "needs your decision" section, emits one cleanup ask, pushes `mergePromptReady` and returns the prompt in the body.
- **Edge cases.** Empty batch → explicit error, not an empty prompt. A row whose path no longer exists on disk is listed as skipped with the reason.

### `src/services/verbSchemas.ts`

- **Context.** `copyWorktreeMergePrompt` schema at `:496`.
- **Logic.** Add `copyBulkWorktreeMergePrompt`.
- **Implementation.** `worktreeIds: { type: 'array', required: true }`, `mode: { type: 'string' }`, `workspaceRoot: { type: 'string' }`.
- **Edge cases.** Permissive per PRD contract #5; an absent `mode` defaults to `verify` (the safer mode).

### `src/generated/verbAllowlist.ts`

- **Context.** Generated single-line `KANBAN_VERBS`.
- **Logic.** Regenerate.
- **Implementation.** `npm run catalog:check`.
- **Edge cases.** Conflicts with the sibling create plan — serialise.

### `src/webview/kanban.html`

- **Context.** `copyWorktreeMergePrompt(worktreeId)` helper at `:12649`, callers at `:5116` and `:12746`; multi-select bar around `:5068`-`:5162`.
- **Logic.** Bulk merge action with a verify/trusted mode choice, reusing the existing `mergePromptReady` clipboard handling.
- **Edge cases.** No confirm gate on top of the mode selector.

## Verification Plan

### Automated Tests

1. **Unit — resolver extraction is behaviour-preserving.** Golden-file the existing single-worktree prompt for an integration tree, a subtask tree with a present integration parent, and a subtask tree with a missing one. Assert byte-identical output after extraction. This is the regression surface of step 1.
2. **Unit — ordering.** A batch mixing two integration trees and three subtask trees. Assert children precede their parents and that the emitted order is deterministic across runs.
3. **Unit — `noTarget` exclusion.** A subtask tree with no integration parent in the batch. Assert it is listed under "needs your decision" and carries no merge command.
4. **Unit — trusted mode narrows correctly.** Assert trusted mode omits the plan-reading instructions but still emits the same ordering, the same hierarchy targets, and the same `noTarget` exclusion as verify mode.
5. **Unit — plan-file policy present.** Assert both modes' prompts carry the prefer-incoming rule for `.switchboard/plans/` conflicts and the "never `git merge --abort` unless told" wording. These are the guardrails; if they can silently drop out of the prompt they will. Assert also that **no** prompt text instructs the agent to call `pauseLiveSync` / `resumeLiveSync` — that mitigation was removed deliberately and must not creep back.
6. **Unit — empty and single-item batches.** Empty → error in the body. One id → a queue of one, still with the ordering and cleanup sections.
7. **Contract — verb registration.** `npm run catalog:check` and `npm run parity:check` pass; `npm run push-routing:check` still reports `KanbanProvider.ts` at its baseline.

### Manual

8. **Full round trip.** Using six trees created by the companion plan: code and review each, move the cards to `CODE REVIEWED` with outcomes appended, then run bulk merge in verify mode. Confirm all six merge in order, the board survives with its columns, feature membership and project assignments intact, and one cleanup confirmation covers the batch.
9. **Verify mode actually gates.** Leave one feature's plan file carrying a failing review outcome while its card sits in `CODE REVIEWED`. Confirm that feature is skipped and named, and the other five merge.
10. **Conflict stop.** Force two features to touch the same file. Confirm the queue stops at the conflict, reports what merged, and leaves the remaining trees untouched and un-cleaned-up.
11. **Stale worktree row.** Delete one tree from disk without updating its DB row (the Worktrees tab does no reconciliation, so this state is reachable). Confirm the batch detects and skips it rather than emitting a merge command for a path that is not there.
12. **Re-import is benign.** Watch the board through the batch. Confirm cards do not change column, lose feature membership, or lose their project assignment as plan files are merged in — the evidence behind dropping the pause instruction.

---

**Recommendation: Send to Coder** (complexity 6).
