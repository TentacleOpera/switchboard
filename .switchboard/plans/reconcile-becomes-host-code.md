# Reconcile Becomes Host Code, Not A Prompt

## Goal

Reimplement the `reconcile` scheduled job as deterministic host code. It scans pulled plan
files for new completion sections and advances the matching cards forward — work with no
judgement in it, currently delegated to an agent through a prompt whose exact wording is the
only thing preventing cards being moved backwards or twice.

### The problem, and the root cause

`buildReconcilePrompt` (`schedulerPresets.ts:80`) hands an agent a four-step procedure:

1. `git fetch --prune` and `git pull --all || true`
2. scan `.switchboard/plans/` on recently-pushed branches for a **new**
   `## Completion Report` or `## Review Findings` section, scoping with
   `git log --since="last reconcile"` or a comparison against the last reconcile commit
3. for each, determine the correct next column and run
   `node .agents/skills/kanban_operations/move-card.js "<planId>" "<nextColumn>" "" "<root>"`,
   skipping cards a human already advanced, never moving backwards, never double-advancing
4. report what moved and what was skipped

Every step is mechanical. There is no ambiguity for a model to resolve — only a diff to compute
and a column transition to look up. The prompt's own doc comment states the risk that follows
from delegating it anyway:

> "Forward-only + idempotent: skip cards a human already advanced. **A wrong prompt silently
> moves cards backward or double-advances, so the wording is load-bearing** — this text is
> unchanged from the retired scheduler surface."

Load-bearing wording is the defect. Three specific fragilities the prose cannot close:

- **"New since the last reconcile pass" is undefined state.** The prompt offers two different
  ways to scope it (`--since="last reconcile"`, or comparison against "the last reconcile
  commit") and nothing records either. The agent re-derives the boundary every run, so the same
  completion section can read as new twice.
- **"Determine the correct next column from the workspace pipeline"** is a lookup the host can
  do exactly and an agent must infer. The prompt's fallback is "if you cannot determine it, SKIP
  and report" — which turns a resolvable question into silent no-ops.
- **Forward-only is a request, not a constraint.** `move-card.js` will move a card anywhere.

The root cause is inheritance: the text is explicitly "unchanged from the retired scheduler
surface", so it was carried forward rather than reconsidered when the surface it belonged to was
replaced.

## Metadata
- **Complexity:** 6
- **Tags:** backend, reliability, refactor, bugfix

## No migration

Clean break. The job keeps its `source: 'reconcile'` id and its stored config so existing
schedules keep working; only its execution changes from prompt-delivery to host code. No
persisted state migrates. CLAUDE.md's migration rule is waived.

## Scope: both composition roots

`runSchedulerJob` lives in `TaskViewerProvider` (extension). If reconcile's implementation is
host code invoked from there, the standalone host needs the same path or reconcile silently
stops existing for npx users — the exact divergence class CLAUDE.md records. Put the
implementation in a service both roots can call, and wire it in both in one diff.

## Implementation

1. **Record the boundary.** Persist a reconcile watermark — the commit SHA or timestamp of the
   last successful pass — on the job (`sourceConfig.lastReconciledAt` / `lastReconciledSha`,
   alongside the existing `lastRunAt`). This is what makes "new since last time" a fact instead
   of an inference, and it is the single largest correctness gain in the plan.
2. **Fetch, do not merge.** `git fetch --prune` only. The current prompt runs
   `git pull --all || true`, which merges into the operator's working tree on a schedule — an
   unattended job must not move the branch the operator is sitting on. Read the plan files from
   the fetched refs (`git show <ref>:<path>`) rather than checking anything out.
3. **Detect new sections by diff, not by presence.** For each plan file changed between the
   watermark and the fetched head, compare the section set before and after. A
   `## Completion Report` that existed at the watermark is not new. Presence-testing is what
   makes the current version re-advance.
4. **Resolve the next column from the pipeline, exactly.** Use the same column-order source the
   board uses. A card whose current column is at or past the expected next column is skipped —
   as data, not as an instruction.
5. **Move through the sanctioned path with the guards on.** `POST /kanban/move` /
   `move-card.js`'s underlying operation, so the cascades and syncs fire — never raw SQL, per
   CLAUDE.md. Forward-only is enforced by comparing indices before calling, so a backwards move
   is impossible rather than discouraged.
6. **Report as data.** Write the run's outcome to the job's `lastOutcome` — counts moved and
   skipped, with reasons — so the panel can show it. The current version's output is a prose
   report from an agent that nothing parses.
7. **Delete `buildReconcilePrompt`** once the host path lands. Leaving both means the next reader
   cannot tell which one runs.

## Edge cases

- **The watermark is missing (first run, or a cleared config).** Do not treat every existing
  completion section as new — that would advance the entire board on first run. With no
  watermark, record the current head and move nothing, reporting "baseline established".
- **A plan file deleted or renamed between watermark and head.** Skip and report; do not attempt
  to resolve a card from a path that no longer exists.
- **Two branches carrying different completion states for the same plan.** Deterministic
  resolution required — prefer the most recent commit touching the file, and report the conflict
  rather than picking silently.
- **A card that a human moved *backwards* since the watermark.** Its column may now be behind
  the expected next column, which looks like "not yet advanced". Advancing it would undo a
  deliberate human action. Skip anything whose column moved backwards since the watermark and
  report it.
- **Features versus plans.** A subtask's completion may imply a feature transition. Whatever the
  current rule is, state it — the prompt version never did, so behaviour here is whatever the
  agent guessed.
- **Merge conflicts / detached state in the working tree.** Fetch-only makes this mostly moot,
  which is the point.
- **No remote configured.** No-op with a recorded reason, not an error every 10 minutes.

## Verification plan

1. `npm run compile` clean.
2. **Idempotency, the headline test:** run reconcile twice with no new commits between; confirm
   the second run moves nothing.
3. Push a plan file with a new `## Completion Report` to a remote branch; run reconcile; confirm
   exactly the matching card advances exactly one column.
4. Run reconcile again immediately; confirm no double-advance.
5. Manually advance a card two columns, then run reconcile; confirm it is skipped, not moved
   backwards or re-advanced.
6. Manually move a card backwards, then run reconcile; confirm it is skipped and reported.
7. Confirm the working tree is untouched: no merge, no branch switch, no staged changes — assert
   `git status` is unchanged across a run.
8. First run with no watermark: confirm nothing moves and a baseline is recorded.
9. Confirm `lastOutcome` carries parseable counts, and the panel renders them.
10. Both hosts — and confirm reconcile actually runs under standalone, not just the extension.
