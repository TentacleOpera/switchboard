# Abandoning a Worktree Removes the Checkout and Leaves Everything That Points At It

<!-- board-collapse-07b -->
> **SCHEMA DEPENDENCY 2026-09-04 (Board Collapse 07).** This plan reads or writes columns that *Split the schema into shared board state and machine-local runtime* **relocates**: `dispatched_terminal`, `dispatched_at`, `last_liveness_at`, `blocked_at` and the `worktrees` table move out of `plans` into separate machine-local runtime tables keyed by `plan_id` + `device_id`, in a different database file that never travels to a remote store. Whichever lands second must target the schema that then exists. The tier split is step 6 of the storage programme (see the *Storage layer overhaul* feature file), so in practice this plan lands first — but do not assume it: check where those columns live before writing the query.


## Goal

Make **Abandon** clean up the two things that outlive the checkout: the branch, and the `## Worktrees` block in the feature file that still names the deleted path.

### The problem

Abandon works — and that is why this is confusing. `KanbanProvider.ts:12193` runs `git worktree remove --force`, so the directory really is gone. But the operator still sees the worktree's name in two places afterwards and concludes the button did nothing.

**Root cause: the arm cleans the checkout only.** `case 'abandonWorktree'` (`KanbanProvider.ts:12180-12204`) does exactly three things — close the worktree's terminals, `git worktree remove --force`, and `updateWorktreeStatus(id, 'abandoned')`. Nothing touches the branch, and nothing touches the feature file. Both keep pointing at a path that no longer exists.

Measured on this install after abandoning four feature worktrees:

- **Five orphan branches**: `a-finished-stage-is-a-fact-not-an-infere`, `automation-is-three-exclusive-modes`, `teams-you-can-see-start-and-trust`, `the-orchestrator-runs-as-a-ticking-agent`, `reaching-an-agent-from-where-you-are-fle`. `git worktree list` is clean; `git branch` is not.
- **Six feature files** still carry a `## Worktrees` block naming a removed directory, e.g. `teams-you-can-see-start-and-trust-7c52086e….md` → `**Feature integration**: teams-you-can-see-start-and-trust → /Users/…/worktrees/switchboard/teams-you-can-see-start-and-trust`.

**Second root cause, found while verifying the first (2026-08-17).** The feature-file half is not only "the arm never triggers a regeneration". `_regenerateFeatureFile` (`KanbanProvider.ts:13086`) wraps its **entire** `## Worktrees` splice — build lines, find the existing block, replace or append — in

```ts
const featureWorktrees = allWorktrees.filter(w => String(w.feature_id) === String(featurePlanId));
if (featureWorktrees.length > 0) { … }
```

`getWorktrees()` returns only `status = 'active'` rows. So the moment a feature's **last** worktree is abandoned, `featureWorktrees.length` is `0`, the whole branch is skipped, and the stale block is left exactly as it was. The block is self-healing only while at least one *other* worktree for that feature survives — which is not the case anyone actually hits. This is why `regenerateAllFeatureFiles` (`TaskViewerProvider.ts:5180`), which runs over every feature on startup, walked past all six stale blocks without fixing one.

**Residue note (2026-08-17).** Both residues have since been cleared by hand: `git branch --list` on this install now shows only `main` and an unrelated `claude/…` branch, and no file under `.switchboard/features/` currently contains a `BEGIN WORKTREES` marker — `git log -S "BEGIN WORKTREES"` attributes their removal to commit `6a4df070`, an edit, not a regeneration. The measurements above stand as the report that produced this plan, and the source defect they exposed is unchanged at HEAD. Verification therefore **recreates** the scenario rather than assuming the residue is present.

**Not part of this bug:** the DB row. `updateWorktreeStatus` tombstones it rather than deleting it, but `getWorktrees` (`KanbanDatabase.ts:3908`) reads `WHERE status = 'active'`, so an abandoned row never reaches the Worktrees tab. The tombstone is deliberate history and stays. Do not "fix" it.

## Metadata

- **Complexity:** 5
- **Tags:** bugfix, backend, reliability
- **Project:** Browser Switchboard

## User Review Required

None.

## Complexity Audit

### Routine

- Adding one `execFile` call and folding its outcome into the existing information message.
- Calling the already-public `regenerateFeatureFile(workspaceRoot, featureId)` (`KanbanProvider.ts:13221`) from the arm.

### Complex / Risky

- **Branch deletion is destructive and irreversible from the UI.** `-d` is the entire safety mechanism; there is no undo and no confirm gate (repo rule), so the flag choice *is* the design.
- **`_regenerateFeatureFile` is shared.** It is reached from `regenerateAllFeatureFiles`, `_removeSubtaskFromFeature`, and every subtask-mutation path. A change to its WORKTREES branch is a change to all of them, and it sits behind two guards that silently suppress writes (the bodyless-husk refusal and the byte-identical no-op skip).
- **Repo resolution.** The arm runs git with `cwd: workspaceRoot`. For a control-plane child repo that is the wrong repository — a latent defect the branch delete would inherit and make destructive-adjacent rather than merely broken.
- **Ordering is load-bearing in two directions**: the feature id must be read *before* the status flip (only active rows are readable), and the regeneration must happen *after* it.

## Edge-Case & Dependency Audit

### Race Conditions

- **Read-then-flip.** `feature_id` must be captured from the live row before `updateWorktreeStatus`; afterwards it is unreachable through `getWorktrees()`. There is no `getWorktreeById` on `KanbanDatabase` — the established pattern is `_cleanupWorktree`'s `allWorktrees.find(w => w.id === worktreeId)` (`KanbanProvider.ts:12773`). Reuse it.
- **Regeneration vs. the plan watcher.** `_regenerateFeatureFile` already calls `GlobalPlanWatcherService.registerPendingCreation` before writing, and skips the write entirely when content is byte-identical, specifically to avoid a self-write loop. Removing the block *changes* the content, so the write fires once and the pending-creation guard absorbs the watcher event. Do not add a second suppression.
- **Two abandons on the same feature.** Each regenerates from the then-current DB state; the last write wins and is correct either way, because the block is derived, never accumulated.

### Security

- `cp.execFile` with an argument array, never `exec` with a string — the branch name reaches git as a single argv entry and cannot inject.
- **`-D` must never appear on this path.** `-d` refuses a branch holding commits not merged into its base; `-D` deletes it regardless. On a worktree branch the unmerged case is precisely the case where the commits exist *nowhere else*.
- Deleting a branch Switchboard did not create is out of bounds — see Dependencies & Conflicts.

### Side Effects

- The information message changes text. It is a `showInformationMessage` through the UI seam, so it is host-agnostic already.
- A feature file write occurs during abandon where none did before. Bounded to the one feature named by `feature_id`; never `regenerateAllFeatureFiles`, whose own doc comment warns it "rewrites every feature .md and risks a refresh storm".
- Fixing the `length > 0` guard means every *other* caller of `_regenerateFeatureFile` also starts stripping orphan blocks. That is the intended blast radius: it turns the existing startup self-heal into an actual heal.

### Dependencies & Conflicts

- **`worktrees-tab-never-looks-at-git.md` edits the same arm** (`case 'abandonWorktree'`, `KanbanProvider.ts:12180`). PRD orchestration discipline: one agent stream per provider file. Serialise the two; do not run them concurrently.
- **Cross-plan constraint:** that plan makes Abandon reachable for *external* worktrees, which have no DB row. Branch deletion here must be gated on the presence of a row — Switchboard neither created nor owns an external worktree's branch. Write the gate now (`if (hasRow)`) so the two land in either order without a follow-up.
- `cleanupWorktree` (the merge-back path, `KanbanProvider.ts:12756`) also leaves branches behind. Out of scope: cleanup follows a merge, so its branch is merged and its residue is benign. Named here so the omission is deliberate rather than missed.
- Return-contract ratchet: `scripts/verb-return-contract-baseline.json` `"Kanban": 1`. The arm already `return`s; introduce no new `break`.

## Dependencies

- None (no prior session artefacts). The sequencing constraint against `worktrees-tab-never-looks-at-git.md` is recorded above.

## Adversarial Synthesis

Key risks: destroying unmerged commits via the wrong delete flag; running git in the wrong repository under a control plane; and shipping the feature-file half against a mechanism that does not exist — regeneration alone provably cannot clear the last-worktree block, so an implementation that only adds the call would pass its own review and fix nothing. Mitigations: `-d` only, with the refusal surfaced rather than swallowed and non-zero exit (not stderr text) as the signal; derive the repo root from the worktree before it is removed; and fix `_regenerateFeatureFile`'s `length > 0` guard as part of this change, with a test that abandons a feature's **only** worktree.

## Proposed Changes

### `src/services/KanbanProvider.ts:13086` — always run the `## Worktrees` splice

> **Superseded:** "The block is generated from active rows, so a regeneration after the status flip removes the stale entry on its own — the arm just never triggers one. Call the same regeneration the create path uses; do not hand-edit the markdown."
> **Reason:** The first half is false, and it is the half the implementation would rest on. `_regenerateFeatureFile` gates its entire WORKTREES splice behind `if (featureWorktrees.length > 0)`. When the abandoned worktree is the feature's last one — the ordinary case, and the case in all six measured files — the count is zero, the branch is skipped, and the stale block is preserved untouched. Adding the missing call alone would leave the reported symptom exactly as it is. The empirical proof is already in hand: `regenerateAllFeatureFiles` runs over every feature at startup and walked past all six.
> **Replaced with:** Fix the generator first, then call it. Run the splice **unconditionally**; emit the block when there are lines to emit, and strip any existing block when there are not. The second half of the original — call the shared regeneration, never hand-edit the markdown — is correct and stands.

**Context.** `KanbanProvider.ts:13084-13136`. The SUBTASKS block immediately above already has the correct shape: it is always spliced, and emits `- [ ] (no subtasks)` in the empty case. The WORKTREES block is the odd one out.

**Logic.** Three states, not two:

- lines to emit → replace-or-append the block (today's behaviour, unchanged).
- no lines **and** an existing block → remove the block and collapse the surrounding blank lines.
- no lines **and** no existing block → leave the file alone. Never append an empty block; a `none`-mode feature that has never had a worktree must see a byte-identical file, or the no-op skip stops protecting against the self-write loop.

**Implementation.** Hoist the `wtRegexes` array and the `firstWtIndex` search out of the `if`, then branch on `worktreeLines.length`:

```ts
// (regexes + firstWtIndex search now run unconditionally)
if (worktreeLines.length > 0) {
    // …existing replace-or-append…
} else if (firstWtIndex !== -1) {
    // Feature has no active worktrees but the file still carries a block:
    // strip it. Without this the last-worktree-abandoned case never heals.
    let stripped = newContent;
    for (const regex of wtRegexes) { stripped = stripped.replace(regex, ''); }
    newContent = stripped.replace(/\n{3,}/g, '\n\n');
}
```

Reuse the existing `wtRegexes` verbatim — including the line-anchored `^##\s*Worktrees\b` form, whose comment explains that a bare `/##\s*Worktrees\b/` also matches the literal text inside prose. That hazard is *larger* on the strip path than on the splice path: a mis-anchored regex here deletes authored prose instead of misplacing a generated block.

**Edge cases.** A feature file whose only content is the two auto-blocks is already refused by the bodyless-husk guard below — unchanged, and the strip runs before that check, so the guard still sees the post-strip content. The byte-identical no-op skip continues to hold: strip changes content, so the write proceeds; no-block-and-no-lines changes nothing, so it does not.

### `src/services/KanbanProvider.ts:12180` — delete the branch, keep unmerged work

**Context.** The arm's success path currently runs `git worktree remove --force`, flips the row, and shows one information message.

**Logic.** After the successful removal, delete the branch with `git branch -d` (safe delete, **never** `-D`). `-d` refuses a branch holding commits that are not merged into its base — which is exactly the case where deleting it would destroy work, and exactly the case where the operator wants to be told rather than protected silently.

Fold the outcome into the existing information message instead of raising a second one:

- deleted → `Abandoned worktree: <branch>`
- refused → `Abandoned worktree: <branch> — branch kept, it has unmerged commits`

No prompt, no confirm gate (repo rule). The message is the whole interaction.

The `git worktree remove` failure path already flips the row to `abandoned` and warns; leave it alone — if the checkout could not be removed, the branch is still in use and must not be deleted.

> **Superseded:** Run the delete against `workspaceRoot`, the same `cwd` the existing `git worktree remove` uses.
> **Reason:** Under a control plane the worktree may belong to a child repo, and `workspaceRoot` then names the wrong repository. The existing `worktree remove` has the same latent defect, but a wrong-repo `worktree remove` fails loudly; a wrong-repo `branch -d` targets a *different repository's* branch of the same name. Same-named branches across sibling repos are the normal case here, since branch names are derived from feature topics.
> **Replaced with:** Derive the owning repo from the worktree itself, **before** it is removed:
> ```ts
> const { stdout } = await execFileAsync(
>     'git', ['-C', wtPath, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
> const repoRoot = path.dirname(stdout.trim());   // <repo>/.git → <repo>
> ```
> Fall back to `workspaceRoot` if that call fails, and run both `worktree remove` and `branch -d` against the resolved root.

**Implementation.**

```ts
let branchNote = '';
if (hasRow && branch) {                     // hasRow: never delete an external worktree's branch
    try {
        await execFileAsync('git', ['branch', '-d', branch], { cwd: repoRoot });
    } catch (e: any) {
        branchNote = ' — branch kept, it has unmerged commits';
    }
}
void this._seams().ui.showInformationMessage(`Abandoned worktree: ${branch}${branchNote}`);
```

**Edge cases.**

- **Classify by exit code, never by stderr text.** Git's messages are localised; `"not fully merged"` is not a stable string. Any non-zero exit means "not deleted" — say so and keep the branch. A branch that is already absent also exits non-zero; the message is then mildly wrong but never destructive, which is the correct direction to be wrong in.
- **`-d` compares against the repo's current `HEAD`** (or the branch's upstream, when one is set). If the main checkout is parked on some other branch, a branch that *is* merged into `main` can still be refused. The result is a kept branch and an honest message — an acceptable false negative, and the reason `-D` must not be reached for as a "fix" for it.
- **Registered but missing checkout.** The arm skips `worktree remove` when `!fs.existsSync(wtPath)`, so git may still hold the registration and `branch -d` fails with "checked out at …". Call the existing `_pruneWorktrees(repoRoot)` (`KanbanProvider.ts:12731`) before the branch delete on that path.
- **No `branch`** in the payload → skip the delete entirely; never derive a branch name from the path.

### `src/services/KanbanProvider.ts:12180` — drop the block from the feature file

**Context.** `regenerateFeatureFile(workspaceRoot, featureId)` (`KanbanProvider.ts:13221`) is already public and already documented as the targeted single-feature entry point for delete/detach paths. Nothing new is needed to reach it.

**Logic.** When the abandoned row carries a `feature_id`, regenerate that feature's file so the `## Worktrees` block reflects the DB. With the generator fixed above, that regeneration now actually removes the last entry.

Order matters, in both directions:

1. **Capture `feature_id` before the status flip** — `getWorktrees()` returns only `active` rows, so after the flip the row is unreadable. Resolve it with `allWorktrees.find(w => w.id === Number(worktreeId))`, the same lookup `_cleanupWorktree` uses.
2. **Regenerate after the flip** — otherwise the block is rebuilt from a row that still reads `active`.

**Implementation.** Between the status write and `_sendWorktreeConfig`:

```ts
if (featureId) {
    try { await this.regenerateFeatureFile(workspaceRoot, featureId); }
    catch (e) { console.warn('[KanbanProvider] abandonWorktree: feature-file regen failed (continuing):', e); }
}
```

Never `regenerateAllFeatureFiles` — its own doc comment forbids it for single-row removals.

**Edge cases.** No `feature_id` (project or unbound worktree) → skip; there is no file to heal. A regeneration failure must not fail the abandon — the checkout is already gone and the row already flipped, so throwing here would report failure for work that succeeded.

## Verification Plan

*Compilation and automated-test execution are deliberately out of scope for this planning pass; the checks below are the specification the implementer runs.*

### Automated Tests

1. **Source-text guard on the arm** (`KanbanProvider.ts` `case 'abandonWorktree'`): contains `'branch', '-d'` and does **not** contain `'-D'`.
2. **The last-worktree case — the regression this plan exists for.** A feature with exactly one worktree and a `## Worktrees` block in its file: abandon it, then assert the file contains no `BEGIN WORKTREES` marker. This is the test the original plan's mechanism would have failed.
3. **The not-last case, unchanged:** a feature with two worktrees, abandon one → the block survives and names only the remaining one.
4. **The never-had-one case:** a feature with no worktrees and no block → `_regenerateFeatureFile` produces a byte-identical file (the no-op skip still fires, so no write and no watcher event).
5. **Prose safety:** a feature file containing the literal text `## Worktrees` inside a fenced code block or mid-sentence, with no auto-block markers, is not modified by the strip path.
6. **Merged branch** → `git branch --list <branch>` is empty after abandon.
7. **Unmerged branch** → the branch is still present, the commit is still reachable, and the returned/displayed message carries the "branch kept" note.
8. **External worktree** (no DB row, from the sibling plan) → no `git branch -d` is attempted.
9. **Unchanged invariants:** an abandoned row is still absent from `getWorktrees()` and still present in the `worktrees` table.
10. **Ratchet:** no new `break` in the arm; `"Kanban": 1` in `scripts/verb-return-contract-baseline.json` still holds.

### Manual

11. Abandon a feature worktree from the Worktrees tab. Confirm the directory, the branch and the feature file's block are all gone, in one click, with one message.
12. Repeat with an uncommitted-but-unmerged commit on the branch: the directory goes, the branch stays, and the message says why — once, not twice.

## Existing residue (not a plan phase)

*(As of 2026-08-17 both residues are already cleared — see the Residue note under **The problem**. Retained as the record of what the reported state was, and as the procedure if it recurs.)*

The five branches above were orphaned. `git branch -d <name>` clears each; any that refuses has unmerged commits and should be looked at before deleting. The six stale feature blocks clear on the next regeneration of each file **only once the `length > 0` guard is fixed** — before that fix, no number of regenerations touches them.

---

**Recommendation: Send to Coder.** (Complexity 5 — small surface, but one destructive git call and one shared generator whose guards are subtle.)
