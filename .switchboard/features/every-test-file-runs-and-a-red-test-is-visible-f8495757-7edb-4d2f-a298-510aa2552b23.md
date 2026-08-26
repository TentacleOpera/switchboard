# Every test file runs, and a red test is visible

**Complexity:** 7

## Goal

95 of 208 test files under src/test/ are reachable from no npm script and no CI step, so their failures are invisible. That is the mechanism by which commit 760c49c5 — an auto-commit before code review — rode for two months: the test that caught it went red and nothing ran it. This feature makes unreachability a CI failure, pays down the existing debt, and gives the 12 mocha-style files a runner they currently lack entirely.

## How the Subtasks Achieve This

- **Test Reachability Ratchet, and Wire the Dark Tests That Already Pass**: builds the gate that makes this class of defect impossible to reintroduce — a ratchet, mirroring the established `scripts/check-push-routing.js` shape, that fails when the count of unreachable test files exceeds a baseline and can only ever be lowered. Wires the 38 dark files that already pass, so the debt starts shrinking on landing. This is the only subtask that prevents recurrence; the other two pay down what has already accumulated.
- **Triage the 45 Dark Test Files That Fail When Actually Run**: the debt itself, and the only subtask that can find live bugs. Each failure is one of three things with opposite fixes — a stale assertion, harness rot, or real code drift where the codebase lost a behaviour and nobody noticed because nobody ran the test. `kanban-subtask-column-leak-regression.test.js` is the strongest drift candidate: it asserts `getAllInColumn` excludes subtask cards via `!c.featureId`, which if gone is a board-correctness bug.
- **Give the 12 BDD-Style Dark Test Files a Runner**: unblocks the only files that cannot be triaged at all. They use mocha's `describe`/`it` globals and throw `ReferenceError: describe is not defined` under plain `node`, while `.vscode-test.mjs` globs five explicit `out/` paths that none of them match. Their assertions have never executed once.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Test Reachability Ratchet, and Wire the Dark Tests That Already Pass](../plans/test-reachability-ratchet-and-wire-green-tests.md) — **CREATED** — ID: aefc01bb-4df5-4d95-ad4f-387888be7dd8
- [ ] [Triage the 45 Dark Test Files That Fail When Actually Run](../plans/triage-the-failing-dark-tests.md) — **CREATED** — ID: 38f01993-6e18-40d6-86fe-0a145f33cdc9
- [ ] [Give the 12 BDD-Style Dark Test Files a Runner](../plans/give-the-bdd-style-dark-tests-a-runner.md) — **CREATED** — ID: c1ceb6aa-dc09-4b15-a87b-c79acfc3a93b
<!-- END SUBTASKS -->

## Dependencies & sequencing

**No subtask blocks another, but the ratchet's baseline is the shared contract between them.**

Start with **Test Reachability Ratchet**. It is deliberately sized to land first and alone: it sets the baseline at today's real count, so it is green on arrival and does not wait on any triage. Landing it later still works — it simply starts from a smaller number.

The other two are independent of each other and can run in parallel. Each file either of them turns green should lower the ratchet's baseline in the same change, which is the only coupling between the three.

**What must NOT be done in one step:** wiring the unreachable files into CI before their failures are triaged. 45 of the standalone files and all 12 of the BDD-style files fail today, so a gate demanding full reachability — or a batch that wires them optimistically — puts CI red on contact. That constraint is why this is three subtasks rather than one.

**Triage** should absorb whatever the BDD-style files report once they are runnable, using the same three-way criterion, rather than that work being duplicated in the runner subtask.

