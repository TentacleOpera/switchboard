# Audit source-pin regexes for first-clause anchoring false-reds

## Goal

Source-pin regexes that anchor to the FIRST clause of a predicate are a recurring false-red pattern in `src/test/`. The `completion-asserted-never-inferred` test previously pinned `const inFlight = board.some(p =>\n p && !p.completedAt` — a regex anchored to the first clause of the predicate. It went red the moment a correct extra clause was added ahead of it (e.g., a type guard or filter), while staying green on a column read moved one line down. It pinned spelling, not the rule.

The test was already rewritten (lines 323–329 of `completion-asserted-never-inferred.test.js`) to split on `const inFlight = board.some(p =>` and assert over the whole predicate body up to `if (inFlight)`. But other source pins in `src/test/` may have the same first-clause anchoring shape and are ticking false-red bombs.

**Root cause:** Source-pin regexes that match a specific code shape (exact whitespace, clause ordering, variable naming) instead of the semantic rule they intend to pin. When the code is correctly refactored (adding a clause, reordering, renaming), the regex goes red even though the rule it pins is still satisfied.

## Metadata

**Complexity:** 6
**Tags:** test, refactor, reliability
**Project:** Browser Switchboard

## Complexity Audit

**Routine:**
- Audit all source-pin regexes in `src/test/` that use `.test()` against source text.
- Identify those that anchor to a specific clause ordering or spelling rather than the whole predicate/function body.
- Rewrite them to assert over the whole body (using `split` + `slice` to extract the relevant block, then testing semantic properties).

**Complex/Risky:**
- 43 test files use `.split()` or `indexOf().slice()` patterns — not all are first-clause anchors. Many correctly extract a function body and assert over it. The audit must distinguish good pins (whole-body) from bad pins (first-clause).
- Rewriting a source pin changes what the test asserts. Must verify the rewritten pin still catches the regression it was designed to catch (i.e., the rule is still pinned, just more robustly).
- Some pins may be intentionally narrow (e.g., pinning exact string constants that must not change). These are NOT first-clause anchors and should not be rewritten.

## Edge-Case & Dependency Audit

- **43 test files use split/indexOf patterns:** The audit scope is large. Must prioritize files that pin predicates (boolean expressions with multiple clauses) over files that pin string constants or single-line assertions.
- **`completion-asserted-never-inferred.test.js` (already fixed):** The rewritten pattern at lines 323–329 is the reference implementation: split on the predicate start, extract up to the next control-flow boundary, assert semantic properties (`!p.completedAt` is present, `kanbanColumn` is absent). Other tests should follow this pattern.
- **`stage-marker-commit-contract.test.js`:** 5 split/indexOf matches — likely pins git commit message structure. May have first-clause anchors in the prompt builder assertions.
- **`terminal-plan-attribution-contract.test.js`:** 4 split/indexOf matches — pins terminal plan attribution logic. May have first-clause anchors.
- **`seat-safeguards-fleet-prompt-path.test.js`:** 3 split/indexOf matches — pins the fleet prompt block. May have first-clause anchors in the directive assertions.
- **`mission-control-tick-and-reports-contract.test.js`:** 4 split/indexOf matches — pins mission control tick logic. May have first-clause anchors.
- **`autoban-state-regression.test.js`:** 3 split/indexOf matches — pins autoban state normalization. May have first-clause anchors.

## Proposed Changes

### 1. Audit all source-pin regexes

For each of the 43 test files that use `.split()` or `indexOf().slice()`:

```bash
# List all test files with split/indexOf patterns
grep -rl '\.split(\|indexOf.*slice' src/test/
```

For each file, read the source-pin assertions and classify:
- **GOOD (whole-body):** The pin extracts a function/predicate body and asserts semantic properties over the whole body. No change needed.
- **BAD (first-clause):** The pin anchors to a specific clause ordering, whitespace, or spelling within a multi-clause predicate. Rewrite needed.
- **N/A (string constant):** The pin asserts an exact string constant that must not change. No change needed.

### 2. Rewrite first-clause anchors to whole-body assertions

For each BAD pin, rewrite following the `completion-asserted-never-inferred.test.js` pattern:

**Before (first-clause anchor — false-red prone):**
```javascript
assert.ok(/const inFlight = board.some\(p =>\n p && !p\.completedAt/.test(src),
    'the in-flight predicate must read !p.completedAt as its first clause');
```

**After (whole-body assertion — robust):**
```javascript
const inFlightTail = src.split('const inFlight = board.some(p =>')[1];
assert.ok(inFlightTail, 'the in-flight predicate must exist');
const inFlightPredicate = inFlightTail.split('if (inFlight)')[0];
assert.ok(/!p\.completedAt/.test(inFlightPredicate),
    'the in-flight predicate must read !p.completedAt');
assert.ok(!/kanbanColumn/.test(inFlightPredicate),
    'the in-flight predicate must not read board position');
```

### 3. Verify each rewritten pin still catches its regression

For each rewritten pin, verify:
- The pin passes on the current (correct) code.
- The pin fails when the rule it pins is violated (e.g., removing `!p.completedAt` or adding a `kanbanColumn` check).

## Verification Plan

1. Run every rewritten test file — assert each passes on HEAD.
2. For each rewritten pin, temporarily break the rule it pins and verify the test goes red. Revert the break.
3. Run the full contract suite — assert no regressions from the rewritten pins.
4. Document the audit results: which files had BAD pins, which were rewritten, and which were GOOD/N/A.
