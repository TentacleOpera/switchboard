# Test Reachability Ratchet, and Wire the Dark Tests That Already Pass

## Goal

Make "a test file no runner can reach" a CI failure instead of an invisible default, and wire in the 38 dark test files that already pass today.

### Problem

**95 of 208 test files under `src/test/` are reachable from no npm script and no CI step.** Not stale, not skipped — simply never executed by anything. A 96th (`terminal-operations-no-periodic-reopen.test.js`) has an npm script that no CI step invokes.

This is not a hygiene complaint. It is the mechanism by which an unreviewed change rode for two months: `plan-registry-reconciliation.test.js` went red when commit `760c49c5` (an auto-commit before code review, for an unrelated epic task) swapped the plan-registry persistence writer. Nothing ran the file, so nothing reported it. It was found only because a reviewer ran it by hand while working on something else.

The repo already treats "defined but not invoked by CI" as a first-class defect — the reviewer protocol calls it "the exact green while incomplete hole" and requires a gate-wiring audit for every check a plan names. That rule is enforced by human attention on new plans, and by nothing at all on the 95 files that predate it.

### Root Cause Analysis

Adding a test file requires three independent edits — write the file, add an npm script, add a CI step — and only the first is enforced by anything. Miss the second or third and the test still *looks* delivered: it exists, it has assertions, it is committed, it is named in a completion report. Nothing distinguishes it from a wired test except running the wiring audit by hand.

The repo has the right pattern for this class of problem already: `scripts/check-push-routing.js` is a **ratchet** — a per-file baseline of allowed violations that fails when the count *exceeds* the baseline, with the rule "baselines must never be raised — they should only ever be lowered." That converts a large existing debt into a hard floor without demanding it be paid off first. The same shape applies here, and does not exist.

### Measured Scope

| | Count |
| :--- | :--- |
| Test files under `src/test/` | 208 |
| Reachable from a CI step (directly or via a chained npm script) | 112 |
| Has an npm script, but no CI step invokes it | 1 |
| **No npm script at all — dark** | **95** |

Of the 95 dark files, **38 pass today** and can be wired immediately. The remainder are this plan's baseline, and are paid down by two sibling plans.

## Metadata
- **Complexity:** 4
- **Tags:** testing, ci, infrastructure, reliability

## User Review Required
None. Wiring a passing test cannot break CI, and the ratchet is set to today's actual count so it is green on landing.

## Complexity Audit

### Routine
- One npm script per wired test file, following the existing `test:contract:*` / `test:regression:*` naming.
- One CI step per wired test file in `.github/workflows/integration-tests.yml`.
- Re-running each wired test to confirm it still passes under `npm run`.

### Complex / Risky
- **Reachability detection must follow chained scripts.** `test:integration:all` invokes other npm scripts, which invoke test files. A detector that only reads `npm run x` lines in the workflow and stops there under-reports reachability and produces false "dark" findings. It must expand script→script references transitively before resolving to files. This is the one place the gate can be wrong in the direction that wastes someone's day.
- **A test that passes standalone can fail under CI's ordering.** These 38 have only ever been run individually. Shared state (the sql.js WASM heap, the sandboxed state home, `.switchboard/` fixtures) is why the existing suites carry "ONE temp workspace for the whole suite" harness notes. A newly wired test that pollutes a shared fixture surfaces as a *different* suite failing.

## Edge-Case & Dependency Audit

- **Baseline direction.** The ratchet must fail when unreachable count *exceeds* baseline, and must print a "lower the baseline" nudge when it drops below — mirroring `check-push-routing.js` exactly. Never raise it.
- **A test can be legitimately unwired.** A scratch or manually-driven harness may exist deliberately. The gate needs an explicit opt-out list (a named constant in the script, not a magic comment), so an intentional exclusion is a visible, reviewable line rather than a silent gap.
- **The gate must count files, not scripts.** A test file referenced by a script that CI never invokes is still dark; that is the `terminal-operations-no-periodic-reopen.test.js` case, and it must be counted as unreachable, not as wired.
- **Do not wire the 12 BDD/mocha-style files here.** They throw `describe is not defined` under plain `node` and need a runner decision, which is a sibling plan. Wiring them with a `node` invocation would add 12 permanently-red CI steps.
- **Do not wire the 45 failing files here.** Same reason — CI goes red on contact. They are the baseline this plan establishes.
- **CI step count.** The workflow already carries ~130 steps; adding 38 more is a wall-clock cost on every PR. Group the wired tests into a small number of aggregate npm scripts (by subsystem) rather than 38 individual steps, and keep each aggregate's failure message naming the specific file.

## Dependencies

None. This plan is the floor the two sibling plans pay down against, and is deliberately shippable before either:
- *Triage the failing dark tests* — fixes the 45 failures, lowering this baseline.
- *Give the BDD-style dark tests a runner* — makes the 12 runnable, lowering it further.

## Adversarial Synthesis

Key risks: (1) a reachability detector that ignores chained npm scripts reports wired tests as dark, and the resulting false findings discredit the gate on day one; (2) wiring 38 never-co-executed tests surfaces cross-test state pollution as failures in *other* suites, which reads as "the wiring broke CI" rather than "these tests were never isolated"; (3) 38 individual CI steps measurably slow every PR; (4) an opt-out mechanism, if implemented as a comment or filename convention, becomes an invisible bypass — the exact defect this gate exists to close. Mitigations: expand script references transitively and diff the detector's "wired" list against the 112 known-reachable files before trusting it; wire in subsystem batches and run the FULL suite after each batch, not just the batch; use aggregate scripts rather than per-file steps; put opt-outs in a named array in the script with a required justification comment per entry.

## Proposed Changes

### `scripts/check-test-reachability.js` (new)

- **Context:** No gate exists for test reachability. `scripts/check-push-routing.js` is the established ratchet shape in this repo and should be mirrored, including its "never raise the baseline" docblock rule.
- **Logic:**
  1. Enumerate `src/test/**/*.test.js`.
  2. Collect npm scripts CI invokes: parse `npm run <name>` from `.github/workflows/integration-tests.yml`, then **transitively expand** — for each named script, recursively resolve any `npm run <other>` inside its body.
  3. Resolve that reached script set to test file paths.
  4. Any test file not in that set is unreachable, unless listed in an explicit `INTENTIONALLY_UNWIRED` array (each entry carrying a one-line justification).
  5. Fail when the unreachable count exceeds `BASELINE`; report "improved — lower the baseline" when under; pass when equal.
- **Edge Cases:** the `npm test` (vscode-test) entries are invoked with `--grep`, so they reach only what `.vscode-test.mjs` globs — resolve those through the glob, not the script name, or the 12 BDD files read as wired when they are not.

### `package.json`

- Add `test-reachability:check` running the new script.
- Add one aggregate script per subsystem grouping the 38 passing dark tests (e.g. `test:group:brain`, `test:group:kanban-db`, `test:group:setup-panel`), each chaining its members so a failure names the file.

### `.github/workflows/integration-tests.yml`

- Add a `Test reachability ratchet` step alongside the other static gates (near `push-routing:check`), with a comment stating what the gate catches and citing `760c49c5` as the worked example of the cost.
- Add one step per aggregate script from above.

## Verification Plan

### Automated Tests

- `npm run test-reachability:check` passes at the committed baseline.
- **Detector correctness, both directions** — the check that matters most, because a wrong detector is worse than no gate:
  - Its "reachable" set must contain all 112 files currently known reachable. Any of those reported dark is a detector bug, not a finding.
  - Temporarily remove a CI step for a wired test → the count must rise and the gate must fail.
  - Temporarily add a test file with no script → the count must rise and the gate must fail.
  - A test reachable only via a chained aggregate script must be reported reachable.
- Every newly wired aggregate script passes: `npm run test:group:*`.
- **Full suite after each wiring batch**, not just the batch — the cross-test pollution risk surfaces elsewhere.
- All eight existing static gates still pass (`push-routing`, `catalog`, `parity`, `verb-returns`, `standalone-fork`, `standalone-parity`, `mirror`, `kanban-dispatch-callers`).
- Every CI step in the workflow resolves to a real npm script (the workflow is parsed and each `npm run <name>` checked against `package.json`).

### Manual Verification

1. Read the detector's unreachable list and confirm each entry is genuinely unwired by grepping `package.json` and the workflow for its filename.
2. Confirm the baseline in the script equals the detector's reported count on a clean tree — an inflated baseline is a silent allowance.
3. Confirm `INTENTIONALLY_UNWIRED` is empty or every entry carries a justification.

## Outstanding Questions

None.
