# The Reviewer Is Never Told What To Review — It Is Handed Plan Paths and a Dirty Tree

## Goal

Give the reviewer a **review unit**: the commit that closed the work. Resolve the coded commit for the plans being reviewed and name it in the reviewer's prompt, so review runs against a bounded diff instead of against whatever happens to be sitting in a shared working tree.

### Problem analysis and root cause

**There is no review unit today, at all.** The reviewer prompt (`src/services/agentPromptBuilder.ts`, `promptParts` at `:1682-1691`) assembles `reviewerExecutionBlock`, `safeguardsBlock`, `advancedReviewerBlock`, `baseInstructions`, `suffixBlock`, `featureDirectiveBlock`, then `` `PLANS TO PROCESS:\n${planList}` ``, then `noSeparateReviewArtifactsBlock`. Plan **file paths**. Nothing else.

Grepped for any prompt text that points a reviewer at a diff, a commit or a range:

```
$ grep -rniE "git diff|git show|HEAD~|--stat|uncommitted" \
      src/services/agentPromptBuilder.ts src/services/sharedDefaults.ts
agentPromptBuilder.ts:89   # a code comment about worktree plan-file fallback
agentPromptBuilder.ts:566  # GIT_SAFETY_DIRECTIVE_WORKTREE_MODE prose
```

Two hits, neither a review target. **No prompt in the product tells a reviewer what artefact to read.** It infers the change set from the plan file's prose and from a working tree that may hold several seats' in-flight work at once — which is precisely the state that produced `226b7f09`.

*(Related drift, out of scope here: `AGENTS.md` lists a `review` skill and `.agents/skills/review/` contains no `SKILL.md`. Worth its own look; it is not the mechanism this plan fixes.)*

**Why a commit is the right unit.** Once a team commits once as its head, the head's commit **is** the completed body of work — bounded, immutable, and already named by its trailers. Reviewing it is deterministic in a way that reviewing a tree never can be: the diff cannot shift under the reviewer, it cannot include a peer's half-finished subtask, and the reviewer's own fixes land as a separate `reviewed` commit on top rather than being indistinguishable from what it was reviewing.

**Root cause of the gap.** The review step was designed around plan files because, at the time, nothing identified the commit for a plan. `stage-markers-in-commit-trailers.md` built that identifier and left it inert. This plan is the consumer that makes it load-bearing: `Switchboard-Stage: coded` + `Switchboard-Plan: <id>` is exactly the query that answers "what am I reviewing".

**Blast radius.** Prompt text plus one `git log` invocation at dispatch time. No verb, schema, board or DB write changes. When no commit resolves, the prompt is byte-identical to today.

## Metadata

**Complexity:** 6
**Tags:** feature, reliability, backend

## User Review Required

None. The query shape, the most-recent-wins rule, the caller-resolves split and the silent-degrade behaviour are decided below.

## Complexity Audit

### Routine

- One `execFileAsync('git', …)` call in a provider that already runs a dozen of them.
- One optional string appended to a prompt part list.

### Complex / Risky

- **The builder must not shell out.** `agentPromptBuilder.ts` imports `fs` and `path` and nothing else from node (`:8-11`) — no `child_process`, no `vscode` — and the seat/trailer work depends on it staying that way. The **caller** resolves the sha and passes it in as an option; the builder only renders it. Same split as `lead-dispatched-commits-carry-no-stage-trailers.md` uses for `planIds` — do not let this plan be the one that breaks it. Note the purity assertion must name `child_process`/`execFile` specifically: a blanket "no node builtins" test fails on the existing `fs` import.

- **The reviewer's OWN commit is already marked; this plan is only about its INPUT.** `buildKanbanBatchPrompt`'s reviewer branch already passes `stage: STAGE_BY_ROLE['reviewer']` (→ `reviewed`) and the batch's `planIds` into `buildGitPolicyBlock` (`:1672`), so a reviewer with a committing strategy already ends its own commit with `Switchboard-Stage: reviewed`. Do not add, duplicate, or "fix" that. The gap this plan closes is upstream of it: the reviewer is told what its commit *means* and never what its diff *is*.

- **Rework produces two `coded` commits for the same plan ids, and that is expected.** Reviewer rejects → head fixes → head commits again. Both commits carry `Switchboard-Stage: coded` and the same plan ids. The membership test still holds; only "which one" is ambiguous. **Rule: the most recent `coded` commit carrying this plan id wins.** `git log` returns newest-first, so `-n 1` is the rule, not an optimisation. Do not attempt to diff a range across the rework — a reviewer reviewing the head's latest complete statement of the work is correct, and range logic here would need a "last reviewed" cursor that does not exist.

- **No commit is a normal state, not an error.** The head may not have committed yet; the trailer capability may be off for that role; the work may predate markers entirely. In every case the resolution returns nothing and the prompt must fall back to **exactly today's text** — no `review commit <unknown>`, no empty ref, no invented range. A reviewer told to review a commit that does not exist is worse than one told nothing, because it will invent a target. This is PRD contract #6 applied to prompt text: absent, never a stub that fakes success.

- **A batch reviews N plans and may resolve N different commits.** `buildKanbanBatchPrompt` is M plans : 1 prompt : 1 terminal. Resolve per plan and emit the distinct set — usually one sha when a team closed a feature, occasionally several. Deduplicate; never silently take the first.

- **Worktrees change the `cwd`.** The resolution must run against the repo the plans actually live in. The dispatch path already resolves a workspace root (and a worktree path when one is assigned); reuse that value rather than defaulting to the board's active root.

## Edge-Case & Dependency Audit

**Race Conditions** — the head could commit between resolution and delivery, so the reviewer reviews the previous commit. Bounded by the same "most recent at dispatch time" rule; the reviewer's own report names the sha it read, so a stale review is visible rather than silent.

**Security** — the plan id is interpolated into a `git log --grep` pattern. It comes from the DB, not a wire, and is a UUID — but interpolate it into an `execFile` **argument array**, never a shell string, so no quoting question arises.

**Side Effects** — one `git log -n 1` per distinct plan per reviewer dispatch. Bounded, read-only, and off the hot delivery path (dispatch, not every `ptySendPrompt`). Give it a short timeout in the style of the existing `execFileAsync` call sites and treat a timeout as "no commit found".

**Migration** — none. Prompt text ships with the VSIX; no stored state.

**Dependencies & Conflicts** — touches `src/services/agentPromptBuilder.ts` (reviewer `promptParts`, `:1682-1691`) and `src/services/KanbanProvider.ts` (dispatch path). Shares `agentPromptBuilder.ts` with three sibling plans, but in a region none of them touch: `agent-commits-sweep-the-whole-shared-tree.md` edits the constant at `:553`, and `lead-dispatched-commits-carry-no-stage-trailers.md` edits `SeatDirectiveOptions` / `buildSeatDirectiveBlock` at `:1007-1068`. Still serialise under one-stream-per-file — the regions are disjoint, the file is not.

## Dependencies

- `lead-dispatched-commits-carry-no-stage-trailers.md` — **hard prerequisite.** Without trailers on the head's commit there is nothing to query and this plan resolves nothing on every dispatch.
- `a-team-commits-once-as-its-head.md` — supplies the single coded commit this plan looks for. Without it the query may match one of several per-subtask commits, which is not a body of work.

## Adversarial Synthesis

**Risk summary.** The dominant risk is emitting a review target that does not exist — a dangling ref or an empty range when no coded commit resolves — which converts a reviewer that reads too much into one that confidently reviews nothing. Second is putting the `git log` inside the prompt builder, breaking the vscode-free purity two sibling plans depend on. Third is the rework case producing several `coded` commits for the same plan ids and the implementation guessing among them. Mitigations: absent-or-nothing is asserted as a test, not a convention; the caller resolves and the builder renders; most-recent-wins is stated as the rule with `-n 1` as its mechanism.

## Proposed Changes

### `src/services/KanbanProvider.ts` — resolve the coded commit at the caller

- **Context:** the reviewer dispatch path, alongside the existing `execFileAsync('git', …)` call sites (`:12463-12476` is the closest precedent — `promisify(cp.execFile)` resolved locally, argument array, `cwd` passed explicitly; `:12776` is the precedent for a `timeout`).
- **Logic:** for each plan being dispatched to a reviewer, resolve the newest coded commit carrying its id:

```ts
const { stdout } = await execFileAsync('git', [
    'log', '-n', '1', '--format=%H', '--all-match',
    `--grep=Switchboard-Plan: ${planId}`,
    '--grep=Switchboard-Stage: coded',
], { cwd: repoRoot, timeout: 5000 });
const sha = stdout.trim() || null;
```

  Collect the distinct non-null shas and pass them to the builder. Any throw, timeout or empty result contributes nothing — never a placeholder.

- **Edge Cases:** `--all-match` is required; without it `--grep` is an OR and any coded commit matches. Arguments go in the array, never a shell string.

### `src/services/agentPromptBuilder.ts` — render the unit, or nothing

- **Context:** the reviewer `promptParts` array (`:1682-1691`).
- **Logic:** accept `reviewCommits?: string[]` in the reviewer options and, when non-empty, insert a block above `PLANS TO PROCESS:`:

```
REVIEW UNIT: review commit <sha> — `git show <sha>` is the change set for this review. Do not infer the change set from the working tree: other agents may be working the same tree, and uncommitted files there are not part of this review. Commit your own fixes separately.
```

  Plural form when several shas resolve. When the array is empty or absent, emit **nothing** — the prompt is byte-identical to today.

- **Edge Cases:** the block must sit above `PLANS TO PROCESS:` so the plan list reads as context for the diff rather than as the review target.

### `src/test/stage-marker-commit-contract.test.js` — pin the consumer

- **Logic:** add —
  1. `reviewCommits: ['abc123']` renders `review commit abc123` and the do-not-infer sentence.
  2. `reviewCommits: []` and `reviewCommits: undefined` each render a prompt byte-identical to the same call without the option — the absent case, asserted rather than assumed.
  3. Two distinct shas render both, deduplicated.
  4. Source-text: `agentPromptBuilder.ts` contains no `child_process`, no `execFile`, no `require('child_process')` — the purity guard the sibling plans rely on.

## Verification Plan

### Automated Tests

1. `npm run lint`.
2. The four new cases in `stage-marker-commit-contract.test.js`; all existing cases pass unchanged.
3. `seat-safeguards-fleet-prompt-path.test.js` passes unchanged — the reviewer seat block is untouched by this plan.

### Manual

4. Have a head commit a body of work carrying `Switchboard-Stage: coded` and two `Switchboard-Plan:` lines. Dispatch those two plans to a reviewer and read the prompt: it names one sha, and `git show <sha>` is the whole change set.
5. Dispatch a plan with **no** coded commit anywhere in history: the prompt is byte-identical to today — no `REVIEW UNIT:` block, no empty ref.
6. Rework case: head commits `coded`, reviewer rejects, head commits `coded` again. Re-dispatch — the prompt names the **second** sha.
7. Dispatch a batch spanning two features closed by two different commits: both shas appear, once each.
8. Run 4 with the plans living in an assigned worktree: resolution runs against that worktree's repo, not the board's active root.

---

**Recommendation:** Complexity 6 → **Send to Lead Coder.**
