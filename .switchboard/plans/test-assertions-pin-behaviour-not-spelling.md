# Source-Regex Test Assertions Must Pin Behaviour, Not Spelling

## Goal

Sweep the CI-wired source-regex test suites and convert assertions that pin *implementation spelling* into assertions that pin *behaviour*, so a rename or refactor stops producing red gates that nobody believes.

### Problem

Switchboard leans heavily on source-regex tests: of the 112 test files CI can reach, **95 read a source file and assert regexes against its text**. That style is load-bearing here — it is the only way to gate things no runtime test can see (prompt directives, wiring that exists but has no caller, a webview rule that renders as a solid block instead of an icon).

But a source-regex assertion has two failure modes, and only one of them is useful:

- **Behaviour changed** — the signal the test exists for.
- **Spelling changed** — a method renamed, a local variable renamed, a count shifted, a log line added. The behaviour is intact and the gate is lying.

The second kind is not a harmless nuisance. It costs three ways: the gate goes red, the red is dismissed as noise, and once dismissed it stops being read at all — at which point a *real* failure in the same file is invisible too. Because assertions run in sequence and the first throw aborts the rest, one stale assertion also **masks every assertion after it in the same file**.

### Root Cause Analysis

Three instances were found and fixed on 2026-08-21 while reviewing an unrelated plan. All three were the same defect wearing different clothes:

1. **Call-name pin.** `plan-registry-reconciliation.test.js` required the literal `await db.upsertPlans(records);`. Commit `760c49c5` — an auto-commit before code review, for an unrelated epic task — swapped it to `db.insertFileDerivedPlan(record)`. Persistence still worked; the assertion failed on the name. Sat red **two months**.
2. **Variable-name pin.** The same file required `RelativePattern(workspaceRoot, '.switchboard/plans/**/*.md')`. The watcher now loops `for (const folder of safeFolders)` and passes `folder` — the same root under another name. This one was **invisible behind defect 1** until it was fixed.
3. **Over-broad match.** `ws-surface-scoping-contract.test.js` forbade any `/msg\.surface/` in `transport.js` to prove the client does not double-filter. The only occurrence was a `wsLog` *printing* the surface for diagnosis. Logging a value is not filtering on it.

The common root cause: **the assertion encodes how the code is written today instead of what must remain true.** Nothing in the repo states the convention, so each test author picks a strictness level ad hoc, and the strictest choice — match the exact current text — is both the easiest to write and the fastest to rot.

### Measured Scope

Heuristic scan over the 95 CI-reachable source-reading test files:

| Pattern | Files |
| :--- | :--- |
| Call-name pin — a regex containing `someName\(` | 76 |
| Identifier-argument pin — a regex containing `\(someLocal,` | 23 |
| Hardcoded-count pin — `exactly N`, `.length, N)` | 19 |
| Element-id pin — `id=\"…"`, `getElementById(` | 5 |
| **At least one pattern** | **82** |

These are **candidates, not confirmed defects.** Pinning a call name is sometimes exactly the contract — `feature-file-subtask-link-contract.test.js` deliberately asserts that `getSubtasksByFeatureId` does **not** appear inside `linkFeatureSubtasksByPaths`, because its presence would mean a removed unlink pass came back. That assertion must survive this sweep untouched. The work is triage, not a find-and-replace.

## Metadata
- **Complexity:** 6
- **Tags:** testing, ci, reliability, maintainability

## User Review Required
None. The triage criterion below is decided, and the sweep is behaviour-preserving by construction — it only ever changes test files, and every change is validated by mutation (the assertion must still fail when the behaviour it guards is broken).

## Complexity Audit

### Routine
- Applying the triage criterion to one assertion and rewriting it (regex loosening, or slicing the method body out and asserting within it).
- Running each touched suite and confirming it still passes.
- Recording the batch in the completion report.

### Complex / Risky
- **Telling a legitimate pin from a spelling pin.** The criterion is stated below and is mechanical, but it requires reading what the assertion is *for*, which is often only in its message string or a nearby comment. A wrong call in the loosening direction silently removes a gate — strictly worse than the false alarm it replaces. This is the whole risk of the plan.
- **Mutation-validating 82 files' worth of assertions.** Every loosened assertion must be proven to still fail when its guarded behaviour breaks. Skipping this converts the sweep into "made the gates green", which is the opposite of the goal.
- **Sequential-abort masking.** Fixing the first stale assertion in a file exposes later ones that have never run. Each file must be re-run to convergence, not once.

## Edge-Case & Dependency Audit

- **Legitimate absence pins.** An assertion may pin that a call is *not* present (a removed unlink pass, a removed confirm dialog). Loosening these destroys the gate. Identify by the assertion using `assert.ok(!…)` / `doesNotMatch`, and preserve them exactly.
- **Legitimate call pins.** Where using a *different* API is itself the bug, the call name IS the behaviour — e.g. "prompt delivery must use `sendRobustText`, never raw `sendText`", or "moves must route through `move-card.js`, never raw SQL". Preserve.
- **Counts that are the contract.** `allowPtyFleet` has four contract tests asserting it is PRESENT; a count pinned to an exact number is correct where the number is the invariant. Pin to the exact count, never to zero, and never loosen a count that exists to catch silent growth.
- **Element-id pins on webviews.** A webview element id often *is* the contract (the handler queries it by id). Preserve unless the id is incidental to the assertion's stated purpose.
- **Scope boundary — CI-reachable only.** Tests CI cannot reach are excluded deliberately; a name-pinned assertion in a test nothing runs produces no false alarm and so is not this plan's problem. See Dependencies.
- **No automated prevention is proposed.** A linter cannot distinguish a legitimate call-name pin from a rotten one — the difference is intent, which is not in the source. Attempting a gate here would either block legitimate pins or pass everything. The convention is documented instead, and enforcement is left to review.

## Dependencies

None — self-contained, and touches only files under `src/test/`.

Adjacent but deliberately **out of scope**: 95 of 208 test files are reachable from no npm script and no CI step, and 42 of the runnable ones fail today. That is a separate defect (tests that do not run at all, rather than tests that run and cry wolf) with a different fix, and folding it in would make neither half reviewable. It needs its own plan.

## Adversarial Synthesis

Key risks: (1) the sweep is judged by "gates are green", which any careless loosening achieves — so mutation validation is the deliverable, not the loosening; (2) 82 files is enough volume that attention decays and later batches get rubber-stamped; (3) loosening a legitimate absence-pin or API-pin silently deletes a real gate, and the loss is invisible precisely because the test still passes; (4) fixing one assertion exposes previously-masked ones, so "the file passes now" does not mean the file is finished. Mitigations: mutation-validate every loosened assertion, cap batches at ~10 files with a passing suite run per batch, treat `assert.ok(!…)` / `doesNotMatch` and documented API pins as preserve-by-default, and re-run each file until it converges rather than once.

## Proposed Changes

### The triage criterion (apply per assertion)

> **Would this assertion fail if the behaviour it describes were unchanged but written differently?**
> - **Yes** → spelling pin. Loosen it to the invariant.
> - **No** → behaviour pin. Leave it alone.

### `src/test/*.test.js` — the sweep

Work in batches of ~10 files, ordered by the table in Measured Scope (call-name first — largest and highest-yield). For each flagged assertion:

1. **Read the assertion's message string first.** It states the intended invariant more often than the regex does; the regex is the drift.
2. **Classify** via the criterion. Preserve-by-default when the assertion is `assert.ok(!…)` / `doesNotMatch`, or when its message says a *specific* API must or must not be used.
3. **Rewrite to the invariant.** The three shapes that covered every case found so far:
   - *Call name → alternation or capability.* `await db\.upsertPlans\(` becomes `await db\.(?:upsertPlans|insertFileDerivedPlan)\(` — or better, slice the enclosing method's body out of the source and assert a DB write happens somewhere inside it.
   - *Identifier argument → wildcard the identifier, keep the payload.* `RelativePattern\(workspaceRoot, '…\*\*/\*\.md'\)` becomes `RelativePattern\([A-Za-z_$][\w$]*, '…\*\*/\*\.md'\)`. The glob is load-bearing; the local's name is not.
   - *Over-broad match → exclude the benign context.* Strip logging calls (`wsLog`, `console.*`) before matching, then apply the original strictness to the remainder — so the assertion keeps its teeth everywhere it matters. While doing this, check whether the pattern is also too *narrow*: `/msg\.surface/` missed `.filter(m => m.surface === …)` because the binding was renamed.
4. **Add the reason inline.** One or two lines: what the invariant is, and what the old pin broke on. Without it the next author re-tightens it.
5. **Mutation-validate.** Break the guarded behaviour in the source, confirm the assertion fails, restore, confirm it passes. An assertion that survives its own mutation is not a gate.
6. **Re-run the whole file to convergence** — a fixed assertion can expose a later one that has never executed.

### `src/test/README.md` (new, or the convention appended to an existing test doc)

Record the criterion, the three rewrite shapes, the preserve-by-default categories, and the mutation-validation requirement. Two lines on *why*: a gate that cries wolf gets ignored, and an ignored gate hides real failures — with `760c49c5` as the worked example of what that costs.

## Verification Plan

### Automated Tests

- Every suite touched in a batch must pass: `npm run <its script>` for each.
- **Mutation validation per loosened assertion** (the load-bearing check): break the guarded behaviour in the source file, confirm the assertion fails, restore the source, confirm it passes and the source is byte-identical to HEAD.
- Full CI-reachable sweep at the end of each batch: every `test:contract:*` / `test:regression:*` script the batch touched, plus the eight static gates (`push-routing`, `catalog`, `parity`, `verb-returns`, `standalone-fork`, `standalone-parity`, `mirror`, `kanban-dispatch-callers`).
- `npm run compile-tests` — the sweep must not change any `src/` behaviour, so this is a no-op check that nothing outside `src/test/` was touched.
- Confirm no assertion was *deleted*: the count of `assert.` calls per touched file must not decrease. A dropped assertion is the failure mode this plan is most likely to produce.

### Manual Verification

1. Pick three files from different batches and re-read each loosened assertion against its message string — does the assertion now say what the message claims?
2. Confirm no `assert.ok(!…)` / `doesNotMatch` assertion was loosened anywhere in the diff.
3. `git diff --stat` shows changes confined to `src/test/` (plus the new convention doc).

## Outstanding Questions

None.


## Inherited: the first-clause anchoring failure mode (2026-09-04, Board Collapse 09)

*Audit source-pin regexes for first-clause anchoring false-reds* has been **merged into this plan
and deleted**. It censused 43 test files using `.split()` or `indexOf().slice()` source pins; this
plan's sweep covers 82 of the 95 CI-reachable source-reading files, so its population is a subset.
One thing it named that this plan did not, and which the sweep must therefore look for explicitly:

**First-clause anchoring.** A pin that splits on the opening of a multi-line expression and asserts
only over what follows, up to the first delimiter, silently stops covering the rest of the
predicate. It does not fail — it passes while checking almost nothing, which is worse than a red
test. The reference repair is `completion-asserted-never-inferred.test.js:323-329`, rewritten to
split on `const inFlight = board.some(p =>` and assert over the **whole** predicate body.

Classify each pin three ways, per the deleted plan: **whole-body** (correct, leave alone),
**first-clause** (rewrite), **string-constant** (not a source pin, out of scope). Not every
`.split()` is a defect; many correctly extract a function body. Distinguishing them is the work.

Named candidates from its census, to check first: `stage-marker-commit-contract`,
`terminal-plan-attribution-contract`, `seat-safeguards-fleet-prompt-path`,
`mission-control-tick-and-reports-contract`, `autoban-state-regression`.

**`seat-safeguards-fleet-prompt-path` is claimed by another plan.** See the ownership note in the
*Red at HEAD* feature: *Two reviewer→coder relays pass `promptComposed: true`* owns that gate's
counts and re-pins them. Do not re-baseline it here; rewrite its pin shape only if that plan has
already landed, and coordinate either way.
