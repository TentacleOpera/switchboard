# Triage all 17 red contract suites blocking the integration-tests CI job

## Goal

A full sweep of all 137 `test:contract:*` suites at HEAD gives 120 pass / 17 fail. Every one of the 17 failing suites is wired into the `integration-tests` GitHub workflow (`.github/workflows/integration-tests.yml`), so that CI job cannot pass on any PR until they are triaged.

The 17 failing suites are:
1. `browser-panel-verb-routing`
2. `browser-stray-dispatch-surface`
3. `claude-protocol-block`
4. `feature-file-subtask-link`
5. `memo-browser-clear`
6. `memo-workspace-binding`
7. `multi-parent-terminals`
8. `seat-safeguards`
9. `skill-preconditions`
10. `stage-marker-commit`
11. `staging-column`
12. `terminal-focus-affordance`
13. `terminal-operations-no-periodic-reopen`
14. `terminal-plan-attribution`
15. `terminal-replay-gap`
16. `tickets-subtasks`
17. `verb-engine`

Existing triage plans cover only part of this set (`staging-column` and `feature-file-subtask-link` are covered by separate plans). The remaining 15 need a triage pass: run each, read the assertion failure, determine whether the code or the test is wrong, and fix.

**Root cause:** These are pre-existing failures at clean HEAD, independent of any current branch work. Each has a distinct root cause — some are stale tests (the contract changed but the test wasn't updated), some are real bugs (code broke the contract), and some may be environment-specific (tests that pass on Linux CI but fail on macOS, or vice versa).

## Metadata

**Complexity:** 8
**Tags:** test, bugfix, reliability, infrastructure
**Project:** Browser Switchboard

## Complexity Audit

**Routine:**
- Run each failing suite, read the assertion failure, trace the code path, and fix (code or test).
- Suites that fail on stale tests (the contract moved or was deleted) need the test updated to reflect the new contract.
- Suites that fail on real bugs need the code fixed to satisfy the contract.

**Complex/Risky:**
- 17 suites is a large surface area. Each needs individual investigation.
- Some suites may have interdependencies — fixing one may surface or resolve failures in another.
- Some failures may be environment-specific (macOS vs Linux). The CI runs on `ubuntu-latest`, so a suite that fails locally on macOS may pass on CI. Must verify each failure on the same platform CI uses.
- The `claude-protocol-block` suite pins the CLAUDE.md managed block size and content — this is a high-churn file, so the test may be red due to recent protocol additions.
- The `verb-engine` suite pins headless seams and arm host-agnosticism — changes to `TaskViewerProvider.ts` or `bootstrap.ts` may have broken it.
- The `seat-safeguards` suite pins the fleet prompt path — changes to the prompt composer may have broken it.
- The `stage-marker-commit` suite commits into a throwaway repo and runs Mission Control's query — this is a behavioural test that may fail due to git version differences or prompt builder changes.

## Edge-Case & Dependency Audit

- **`staging-column` and `feature-file-subtask-link`:** Covered by separate triage plans. This plan covers the remaining 15.
- **`claude-protocol-block`:** Pins the CLAUDE.md managed block under a size gate, free of dead references, and free of hidden-capability advertising. Recent additions to the protocol block (new skills, new workflow entries) may have pushed it over the size gate or introduced dead references.
- **`skill-preconditions`:** Pins that every discoverable skill states its preconditions. New skills added without a preconditions section would fail this.
- **`browser-panel-verb-routing` and `browser-stray-dispatch-surface`:** Pin that every verb a browser panel posts is reachable on its HTTP route. New verbs added to the panel without corresponding route handlers would fail.
- **`memo-browser-clear` and `memo-workspace-binding`:** Pin memo capture mode behavior in the browser panel. Changes to the memo watcher or browser panel message handling may have broken these.
- **`multi-parent-terminals`:** Pins terminal parentage and spawn behavior. Changes to `PtyFleetService` or terminal spawning may have broken this.
- **`terminal-focus-affordance`, `terminal-operations-no-periodic-reopen`, `terminal-plan-attribution`, `terminal-replay-gap`:** Pin terminal behavior contracts. Changes to terminal management may have broken these.
- **`tickets-subtasks`:** Pins ticket subtask embedding. Changes to the tickets provider may have broken this.
- **`verb-engine`:** Pins headless seams and arm host-agnosticism. Changes to `TaskViewerProvider.ts` constructor or `bootstrap.ts` may have broken this.
- **CI workflow:** All 17 suites are wired as individual steps in `integration-tests.yml`. Fixing each suite will unblock the corresponding CI step.

## Proposed Changes

### Phase 1: Triage each failing suite (one fix per suite)

For each of the 15 remaining failing suites (excluding `staging-column` and `feature-file-subtask-link` which have separate plans):

```bash
# Run the suite and capture the failure
node --require ./src/test/bootstrap/sandboxStateHome.js src/test/<suite-name>-contract.test.js 2>&1 | tee /tmp/<suite-name>-triage.log

# Read the assertion failure
# Trace the code path
# Determine: is the code wrong (fix the code) or is the test stale (fix the test)?
# Apply the fix
# Re-run to verify
```

### Phase 2: Categorize each failure

For each suite, document:
- **Failure summary:** What assertion failed and why.
- **Root cause:** Code bug, stale test, or environment-specific.
- **Fix:** What was changed (code or test).
- **Verification:** The suite now passes.

### Phase 3: Verify the full suite

```bash
# Run all 137 contract suites and verify 0 failures
for suite in $(cat package.json | grep -oP 'test:contract:\K[^"]+' | sort -u); do
  echo "=== $suite ==="
  node --require ./src/test/bootstrap/sandboxStateHome.js src/test/${suite}-contract.test.js 2>&1 | tail -2
done
```

## Verification Plan

1. Run each of the 17 previously-failing suites individually — assert each exits 0.
2. Run the full 137-suite sweep — assert 137 pass / 0 fail.
3. Verify the `integration-tests` GitHub workflow passes on a PR with the fixes (all 17 steps green).
4. Run the full suite on both macOS (local) and Linux (CI) to catch platform-specific issues.
5. Verify no regressions in the 120 previously-passing suites.
