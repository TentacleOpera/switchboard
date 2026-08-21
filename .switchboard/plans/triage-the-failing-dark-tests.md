# Triage the 45 Dark Test Files That Fail When Actually Run

## Goal

Run the 45 dark test files that fail today, decide per file whether the test is wrong or the code is wrong, fix accordingly, and wire each one as it goes green.

### Problem

95 test files under `src/test/` are reachable from no npm script and no CI step. Of the 83 that are runnable as standalone scripts, **38 pass and 45 fail** — 42 with assertion errors and 3 with import/reference errors. None of those 45 failures is visible to anyone, because nothing runs them.

Each failure is one of three things, and they need opposite responses:

- **A stale assertion** — the code moved on legitimately and the test was never updated. Fix the test.
- **Harness rot** — the test cannot construct its fixture any more (a renamed module, a migration that now double-applies, a provider API that changed shape). Fix the harness, or delete the test if what it guarded is gone.
- **Real drift** — the code lost a behaviour the test was protecting, and nobody noticed because nobody ran it. Fix the code, and treat the finding as a bug in its own right.

The third category is the reason this is worth doing. At least one candidate is visible in the failure output already: `kanban-subtask-column-leak-regression.test.js` asserts *"getAllInColumn default branch must exclude subtask cards via `!c.featureId`"* — if that guard is genuinely gone, subtask cards leak into column queries, which is a board-correctness bug, not a test problem.

### Root Cause Analysis

Two mechanisms compounded.

**Nothing ran these files**, so a failure produced no signal. That is the subject of the sibling reachability plan and is not re-litigated here.

**Several of the assertions pin implementation spelling rather than behaviour**, so they were destined to fail on the next rename regardless. The already-diagnosed instance is `plan-registry-reconciliation.test.js`, which required the literal `await db.upsertPlans(records);` and failed when `760c49c5` swapped it to `insertFileDerivedPlan(record)` — persistence still worked. The failure list here shows the same shapes: *"Expected exactly 3 locations clearing…"* (a hardcoded count), *"Expected element with id=… to exist"* (a webview id), *"Expected TaskViewerProvider to pass…"* (a call signature). The convention fix for that is a separate plan; this plan applies its criterion while triaging.

A third contributor is specific to these files: 3 fail on imports that no longer resolve, which means they were never re-run after a refactor moved the module. `review-column-persistence-regression.test.js` requires `src/services/kanbanColumnDerivation.js` — a plain `.js` helper that `tsc` does not copy into `out/`, which a sibling suite works around by explicitly `fs.copyFileSync`-ing it. That workaround exists because the problem is known; this file simply never got it.

### Measured Scope

The 45 failures, by observed error class:

| Class | Count | Examples from the failure output |
| :--- | :--- | :--- |
| Assertion failure | 42 | `Expected PLAN REVIEWED autoban routing…`, `Expected exactly 3 locations clearing…`, `getAllInColumn default branch must exclude subtask cards via !c.featureId` |
| Unresolved import / undefined reference | 3 | `Cannot find module '../services/standby-status'`, `Cannot find module '…/kanbanColumnDerivation.js'`, `DEFAULT_VISIBLE_AGENTS is not defined` |

Fixture-construction failures are a visible sub-cluster inside the 42 — `kanban DB should initialize`, `ensureReady() must return true`, `duplicate column name: needs_path_fix`, `this._getKanbanDb is not a function` — and are harness rot rather than assertion staleness despite surfacing as assertions.

## Metadata
- **Complexity:** 7
- **Tags:** testing, bugfix, reliability, maintainability

## User Review Required
None. Every outcome is decided by the triage criterion below: fix the test, fix the code, or delete the test with its justification recorded. Deletion is permitted only for the stated case (the guarded behaviour is provably gone), so no judgment call is deferred to the reader.

## Complexity Audit

### Routine
- Running one dark test and reading its failure.
- Rewriting a stale assertion once its intended invariant is established.
- Adding the npm script + CI step for a file that has gone green.

### Complex / Risky
- **Distinguishing stale assertion from real drift.** These are the same symptom — a red assertion — with opposite fixes. Get it backwards and you either paper over a live bug by "fixing" the test, or churn working code to satisfy a rotten assertion. This is the entire risk of the plan and the reason it is sized at 7 rather than 4.
- **`git log -S` archaeology per finding.** Establishing whether a behaviour was deliberately removed or accidentally dropped requires finding the commit that changed it and reading its intent. Several of these files predate the current architecture, so the answer is sometimes "this was superseded" — which is a delete, not a fix.
- **Fixture-rot repairs touch shared harness assumptions.** `duplicate column name: needs_path_fix` is a migration replaying against a DB the test did not create fresh; `this._getKanbanDb is not a function` is a provider constructed differently than the current shape expects. Repairing these means matching how the *current* working suites build their fixtures, not inventing a new pattern.
- **Real-drift findings are separate bugs.** A confirmed code regression found here should be fixed with its own verification and reported as a finding, not folded silently into a "test fixes" commit where nobody will see it.

## Edge-Case & Dependency Audit

- **Deletion criterion, stated narrowly.** A test may be deleted only when the behaviour it guards provably no longer exists (the feature was removed, the module was deleted, the mechanism was superseded). "It is hard to fix" and "it looks obsolete" are not grounds. Every deletion records the commit that removed the guarded behaviour.
- **Never delete to reach green.** The failure mode this plan is most likely to produce is a sweep that deletes awkward tests and reports 45 resolved. Track fixed / code-fixed / deleted as three separate counts in the completion report so the ratio is visible.
- **`standby-status.test.js` requires a module that does not exist.** Determine whether `services/standby-status` was renamed or removed. Renamed → fix the import. Removed → the test guards nothing and is a delete.
- **`review-column-persistence-regression.test.js` needs the `out/` gap fill.** `tsc` does not copy plain `.js` helpers into `out/`; the working sibling suites `fs.copyFileSync` them at startup. Reuse that exact pattern rather than changing the build.
- **Cross-test state pollution.** These files have only ever run alone. The shared sql.js WASM heap presents exhaustion as "disk I/O error" across every DB at once, so a newly wired test can make an *unrelated* suite fail. Run the full suite after each batch.
- **Do not fix assertions by loosening them into tautologies.** A loosened assertion must still fail when the behaviour it guards breaks. Mutation-validate every rewrite.
- **The 12 BDD/mocha-style dark files are out of scope.** They throw `describe is not defined` under `node` and are blocked on a runner decision (sibling plan). Their assertions are not triaged here.

## Dependencies

None blocking — the failures can be triaged and fixed without either sibling plan landing.

Sequencing note: the *reachability ratchet* plan sets a baseline of unreachable files, and each file this plan turns green lowers it. If the ratchet lands first, lower its baseline as part of each batch. If it lands after, it simply starts from a smaller number. Neither ordering blocks the other.

The *pin behaviour, not spelling* plan defines the assertion-rewrite criterion used here; if it has not landed, apply the criterion inline (it is restated in Proposed Changes).

## Adversarial Synthesis

Key risks: (1) triaging in the wrong direction — "fixing" a test that was correctly reporting a live bug, which converts a findable regression into a permanent one; (2) deletion-to-green, which is indistinguishable from progress in a summary and only visible if fix/code-fix/delete are counted separately; (3) loosening assertions into tautologies, producing 45 green tests that guard nothing; (4) real-drift fixes buried inside test-fix commits where no reviewer will look for them; (5) volume-induced attention decay across 45 files. Mitigations: for every failure, establish the intended invariant from the assertion message and `git log -S` on the guarded symbol BEFORE deciding direction; mutation-validate every rewritten assertion; commit code fixes separately from test fixes with the regression named in the message; cap batches at ~8 files with a full-suite run per batch; report the three counts.

## Proposed Changes

### Triage procedure, per failing file

1. **Run it and read the assertion message, not just the diff.** The message states the intended invariant; the regex is often the drift.
2. **Find the guarded symbol's history** — `git log -S '<symbol>'` on the source file the test reads. This is what separates "deliberately superseded" from "accidentally dropped", and it is the step that must not be skipped.
3. **Classify:**
   - *Code lost a behaviour it should still have* → **fix the code.** Separate commit, named as a regression, with its own verification.
   - *Behaviour changed legitimately, assertion pins the old spelling* → **fix the assertion** to the invariant. Apply the criterion: *would this assertion fail if the behaviour were unchanged but written differently?* Yes → loosen to the invariant. No → the assertion is right and the code is wrong; go back to the previous branch.
   - *Behaviour is provably gone* → **delete the test**, recording the commit that removed it.
   - *Fixture cannot be constructed* → **repair the harness** by matching how the current passing suites build theirs.
4. **Mutation-validate** any rewritten assertion: break the guarded behaviour, confirm the assertion fails, restore, confirm it passes and the source is byte-identical.
5. **Wire it** — npm script + CI step (or add to the relevant aggregate script) — and lower the reachability baseline if that gate has landed.

### Batching

~8 files per batch, grouped by subsystem so the archaeology compounds (all `kanban-database-*` together, all `project-panel-*` together, all `setup-panel-*` together). Full suite after each batch.

### Named starting points

- **`kanban-subtask-column-leak-regression.test.js`** — first, because it is the strongest real-drift candidate: it asserts `getAllInColumn`'s default branch excludes subtask cards via `!c.featureId`. If that guard is gone, subtask cards leak into column queries. Confirm against the current `getAllInColumn` before assuming the test is stale.
- **The 3 import failures** — cheapest and unambiguous: each is either a rename (fix the import), a deletion (delete the test), or the known `out/` gap fill (`review-column-persistence-regression.test.js`).
- **The fixture-rot cluster** (`kanban-database-delete`, `-mtime`, `-reload-recovery`, `local-plan-duplicate-regression`, `plan-creation-status-regression`, `planner-workflow-path-migration`) — all fail on DB initialisation, so one harness fix likely clears several.

## Verification Plan

### Automated Tests

- Every file turned green passes via its npm script.
- **Mutation validation for every rewritten assertion** — break the guarded behaviour, confirm failure, restore, confirm pass and byte-identical source. This is the deliverable, not the green.
- **Full suite after every batch** — `npm test`-reachable contract/regression scripts plus the eight static gates — because these files have never co-executed and the shared sql.js heap fails globally when exhausted.
- `npm run compile-tests` clean after any code fix.
- For each code fix, a regression assertion that fails against the pre-fix source.
- Assertion counts per touched test file must not decrease unless the file was deleted outright.

### Manual Verification

1. Read the completion report's three counts — tests fixed, code fixed, tests deleted. A delete-heavy ratio is the failure signature.
2. For each deletion, confirm the recorded commit genuinely removed the guarded behaviour.
3. For each code fix, confirm it was committed separately from test fixes and names the regression.
4. `git diff --stat` on test-fix commits shows changes confined to `src/test/`.

## Outstanding Questions

None.
