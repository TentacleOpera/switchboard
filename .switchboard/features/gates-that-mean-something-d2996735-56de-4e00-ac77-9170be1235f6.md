# Gates that mean something

**Complexity:** 7

## Goal

A green gate that asserts nothing is worse than a red one. 95 of 208 test files are reachable from no npm script or CI step, 55 source-span extractions treat a failed marker lookup as a valid span, and the parity gate everyone cites cannot fail. Make unreachability a ratcheted failure, make a missed marker throw, pin behaviour rather than spelling, and give the composition roots a gate that actually fails.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [55 hand-rolled source-span extractions treat a failed marker lookup as a valid span — one silently swallows the file, another silently collapses to nothing](../plans/source-span-extraction-guard-shared-helper.md) — **CREATED** — ID: f944fb1d-b9a3-4b51-bd84-80462fda37d0
- [ ] [Source-Regex Test Assertions Must Pin Behaviour, Not Spelling](../plans/test-assertions-pin-behaviour-not-spelling.md) — **CREATED** — ID: 0d37839b-53e9-4959-9fac-8e9afc90bb5f
- [ ] [Test Reachability Ratchet, and Wire the Dark Tests That Already Pass](../plans/test-reachability-ratchet-and-wire-green-tests.md) — **CREATED** — ID: aefc01bb-4df5-4d95-ad4f-387888be7dd8
- [ ] [Triage the 45 Dark Test Files That Fail When Actually Run](../plans/triage-the-failing-dark-tests.md) — **CREATED** — ID: 38f01993-6e18-40d6-86fe-0a145f33cdc9
- [ ] [Give the 12 BDD-Style Dark Test Files a Runner](../plans/give-the-bdd-style-dark-tests-a-runner.md) — **CREATED** — ID: c1ceb6aa-dc09-4b15-a87b-c79acfc3a93b
- [ ] [A composition-root parity gate that actually fails](../plans/a-composition-root-parity-gate-that-actually-fails.md) — **CREATED** — ID: a82e0a62-9e12-4997-839a-2151c4d49f68
<!-- END SUBTASKS -->

## Dependencies & sequencing (2026-09-04, Board Collapse 09)

1. **Test Reachability Ratchet** — lands first and alone. It makes unreachability a failure without
   changing any test, and the siblings then lower its baseline.
2. **A composition-root parity gate that actually fails** — its baseline is now green-able, since
   `cf57044b` wired the seams the old audit plan tracked. It inherits the option-supply assertion
   from that deleted card (Board Collapse 01).
3. **Give the 12 BDD-style dark test files a runner** — ships disabled by baseline until triaged.
4. **Triage the 45 dark test files that fail when actually run** — absorbs whatever the BDD runner
   exposes. Delete a test only when the behaviour it guarded provably no longer exists, and record
   the commit that removed it.
5. **Source-Regex Test Assertions Must Pin Behaviour, Not Spelling** — the sweep, now carrying the
   first-clause anchoring failure mode inherited from a deleted duplicate.
6. **55 hand-rolled source-span extractions** — the shared `at()`/`span()` helper and its ratchet.
   **Lands last of the test-file changes**, because it migrates files that the *Red at HEAD* repairs
   own: it touches `memo-panel-workspace-binding-contract.test.js`, `shell-terminal-strip.test.js`
   and `ws-surface-scoping-contract.test.js`, all three of which are being repaired there.

**Shared contention.** Five or more cards across this feature and others add a `test:contract:*`
script to `package.json` and a step to `.github/workflows/integration-tests.yml`. Expect merge
conflicts in those two files and serialise the landings rather than authoring in parallel.
