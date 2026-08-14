# Two CI contracts extract a span that no longer exists — a renamed declaration and a guard clause silently emptied their assertion windows

## Goal

Re-anchor the span extraction in `src/test/terminal-pane-fit-verification-contract.test.js` and `src/test/memo-panel-workspace-binding-contract.test.js` so both stop failing on source they are not actually asserting about. Both are red at HEAD, both block CI (run-steps 76 and 65 of 101), and in both cases **the production code is correct** — the tests lost their grip on it when an unrelated, legitimate edit moved the landmark each one navigates by.

*Clarification (added during review, strictly implied by the above):* the dead marker `DEFAULT_ROLES` also survives in **two documentation comments** — the pane-fit test's own header and the header of `src/test/terminal-renderer-lifecycle-contract.test.js`, which is green and whose live markers are unaffected. Retiring the marker means retiring all three sites; leaving prose pointing at a constant deleted five months ago is the same defect in the medium that a `grep` for the fix will not catch.

### Problem Analysis

Two independent instances of one mechanism: a source-text contract locates its assertion window by searching for a literal landmark, and something legitimate moved the landmark. The predicate never got a chance to run — extraction failed first, or extracted an empty window.

**Run-step 76 — `test:contract:terminal-pane-fit` (2 contracts failed).** The test reads `src/webview/terminals.js` and uses `const DEFAULT_ROLES` both as the tail of a declaration-order chain and as the end-marker of the `batchFitVisiblePanes` span:

```js
const order = [
    'function readRenderedGrid(', 'function inspectPaneFit(', 'function resyncPaneRenderer(',
    'function startFitLadder(', 'function batchFitVisiblePanes(', 'const DEFAULT_ROLES'
].map(m => [m, SRC.indexOf(m)]);
// …
const batch = block('function batchFitVisiblePanes(', 'const DEFAULT_ROLES');
```

`DEFAULT_ROLES` no longer exists anywhere in `src/webview/` or `src/services/`. It was renamed to `NO_ROLE` in `1c7de0f6` ("Headless Host Correctness — Boot, Catalog & Verb Rail", 2026-08-05). The failures are `missing declaration: const DEFAULT_ROLES` and `end marker not found AFTER "function batchFitVisiblePanes(": const DEFAULT_ROLES` — the `block()` helper's own guards firing correctly on a dead marker.

The replacement is unambiguous. `const NO_ROLE = 'shell';` at `terminals.js:6040` is the first top-level declaration after `function batchFitVisiblePanes()` at `:6018` — exactly the role `DEFAULT_ROLES` played. Verified positions of all six markers at HEAD:

| Marker | Line |
| :--- | :--- |
| `function readRenderedGrid(` | 5736 |
| `function inspectPaneFit(` | 5765 |
| `function resyncPaneRenderer(` | 5809 |
| `function startFitLadder(` | 5906 |
| `function batchFitVisiblePanes(` | 6018 |
| `const NO_ROLE` | 6040 |

Strictly ascending, so the forward-only chain holds and the `batchFitVisiblePanes` span is non-empty once re-anchored. `const NO_ROLE` occurs exactly once in the file, so the marker is unambiguous.

> **Superseded:** "The four assertions inside that span (`startFitLadder` present; no `requestAnimationFrame`; no `fitAndReportSize`) were never evaluated."
> **Reason:** Miscount. The test `the fit is verified, not fired once and forgotten` (lines 59–65) contains **three** assertions, not four — the parenthetical already listed only three. In a plan whose entire subject is imprecise navigation, an inflated assertion count is exactly the kind of unchecked number that makes a verification step un-falsifiable.
> **Replaced with:** The **three** assertions inside that span were never evaluated.

The three assertions inside that span (`startFitLadder` present; no `requestAnimationFrame`; no `fitAndReportSize`) were never evaluated. Static check of the re-anchored span (`terminals.js:6018–6040`) confirms all three will pass: the body calls `startFitLadder(name)` at `:6022`, and neither `requestAnimationFrame` nor `fitAndReportSize` appears anywhere between `:6018` and `:6040`.

**The stale marker is named in two more places, both documentation.** `SRC.indexOf` does not read comments, so neither is red — but both are the exact text a future renamer would consult, and both name a constant that has not existed since `1c7de0f6`:

| File | Line | Text |
| :--- | :--- | :--- |
| `src/test/terminal-pane-fit-verification-contract.test.js` | 14 | `*   -> batchFitVisiblePanes -> const DEFAULT_ROLES` |
| `src/test/terminal-renderer-lifecycle-contract.test.js` | 23 | `startFitLadder -> batchFitVisiblePanes -> const DEFAULT_ROLES` |

The second file is **not failing** — its own `declaration order keeps the pane-fit contract spans forward-only` test (`:235`) anchors only on `function readRenderedGrid(` and asserts seven renderer functions sit *above* it. It guards the **head** of the chain; nothing guards the **tail**. Its doc comment is the sole cross-file record of what the tail marker is, and it is wrong. Fixing the two live markers while leaving both prose copies pointing at a dead constant is this plan's own failure mode, committed in the same change that repairs it.

**Run-step 65 — `test:contract:memo-workspace-binding` (10 passed, 1 failed).** The test slices the `workspaceChanged` handler out of `src/webview/memo.js` and stops at the first `break;`:

```js
const handler = memoJs.slice(memoJs.indexOf("case 'workspaceChanged'"));
const body = handler.slice(0, handler.indexOf('break;'));
const clearIdx = body.indexOf('clearTimeout(_memoSaveTimer)');
const assignIdx = body.indexOf('_wsRoot = msg.workspaceRoot');
assert.ok(clearIdx !== -1 && assignIdx !== -1, 'workspaceChanged handler is missing its guard or its reassignment');
```

The handler now opens with an early-exit guard, and **that guard's `break;` is the first one**:

```js
case 'workspaceChanged': {                                   // memo.js:106
    // A board workspace switch must not undo an explicit memo target.
    if (_wsRootExplicit) { break; }                          // :108  ← first `break;`
    if (msg.workspaceRoot && msg.workspaceRoot !== _wsRoot) {
        if (_memoSaveTimer) { clearTimeout(_memoSaveTimer); _memoSaveTimer = null; }  // :110
        _memoDirty = false;
        _submittedContent = null;                            // :112
        _wsRoot = msg.workspaceRoot;                         // :113
        // …
    }
    vscode.postMessage({ type: 'memoListWorkspaces' });
    break;                                                   // :120  ← the real end
}
```

So `body` is only lines 106–108. Both `indexOf` calls return `-1` and the assertion reports "missing its guard or its reassignment" about code sitting two lines below the truncation point. **The contract it defends is satisfied**: `clearTimeout` at `:110` precedes `_wsRoot = msg.workspaceRoot` at `:113`, so the debounce data-loss window the test exists to close is closed. The two assertions after it (`clearIdx < assignIdx`, and `_submittedContent = null` present) were also never meaningfully evaluated.

### Root Cause

Span extraction by literal landmark, with the landmark chosen from whatever happened to sit at the boundary on the day the test was written. Neither landmark is part of the contract: `DEFAULT_ROLES` was an adjacent constant, and "the first `break;`" was an accident of a handler that then had no guard clause. Any legitimate rename or any inserted early-exit moves them. The `block()` helper fails loudly, which is right — but the *choice* of marker is what made a correct refactor look like a contract violation.

This is the same failure family as the WS surface-scoping false positive (see `ws-surface-scoping-false-positive-blocks-ci-tail.md`): a source-text contract that encodes an incidental property of the source instead of the property it means to defend.

### Why this matters beyond two red ticks

Both steps sit in a **single-job** workflow (`integration-tests`, `runs-on: ubuntu-latest`) with **zero** `continue-on-error` declarations across all 101 `run:` steps, so each halts the whole run. Verified at HEAD: `mirror:check` is run-step 11 (`integration-tests.yml:53`), `test:contract:memo-workspace-binding` is run-step 65 (`:377`), `test:contract:terminal-pane-fit` is run-step 76 (`:482`). Run-step 65 is the earlier of the two, and the last four scheduled CI runs each died at a different step — the first blocker is a moving target and these are two entries in the queue. Neither is a product defect; both are pure signal loss. Every minute they stay red is a minute the ~35 steps behind them are dark for no reason at all.

## Metadata

**Tags:** test, bugfix, reliability, devops
**Complexity:** 4
**Project:** Browser Switchboard

## User Review Required

None.

## The trap: both of these look like code bugs and are not

Each failure message accuses the production source of a missing behaviour that is demonstrably present. `missing declaration: const DEFAULT_ROLES` reads as "someone deleted a constant"; `workspaceChanged handler is missing its guard or its reassignment` reads as "someone dropped the debounce cancel". **Do not edit `terminals.js` or `memo.js`.** Re-introducing `DEFAULT_ROLES` to satisfy a marker, or reordering the memo handler to move its `break;`, would be shaping production code around a test's navigation bug — and in the memo case would mean deleting the `_wsRootExplicit` guard, which exists so a board workspace switch cannot silently retarget an explicitly-chosen memo. Both files are correct. Only the tests move.

## Complexity Audit

### Routine

- Three test files — two with live marker edits, one comment-only. No production code. No schema, no migration, no shipped state, no runtime path.
- Both failing tests are plain `node` scripts with local `test()` harnesses — no framework, no fixtures, no async in the affected assertions.
- Both are already wired into CI and already have `package.json` scripts (`test:contract:terminal-pane-fit`, `test:contract:memo-workspace-binding`). No new wiring.
- The step-76 replacement marker is mechanically determined: `NO_ROLE` occupies the exact position `DEFAULT_ROLES` did, occurs exactly once in `terminals.js`, and all six marker positions are verified ascending at HEAD.

### Complex / Risky

- **The dark assertions may reveal a genuine failure underneath.** The three `batchFitVisiblePanes` assertions and the two ordering assertions in memo have not evaluated since their markers broke. Re-anchoring is the first time in weeks they actually run. A red result *after* re-anchoring is a real finding and must be reported, not re-suppressed by widening the span again. (Static reading of `terminals.js:6018–6040` says all three pane-fit assertions will pass; the memo pair is likewise satisfied at `:110`/`:113`. Reading the source is not the same as running it — treat the prediction as a hypothesis the run confirms.)
- **Choosing the memo span technique is a judgment call, and getting it wrong recreates the bug.** "Stop at the first `break;`" failed because a guard was added. "Stop at the next `case '`" is robust to guards but assumes the handler stays a switch arm with no nested switch. Pick the technique that survives the *next* legitimate edit, not just this one — and note that the guard-against-recurrence is harder to get right than the span itself: the obvious one (assert a `break;` exists) is satisfied by the guard's own `break;` and so passes on the very truncation it targets.
- **Weakening is the failure mode.** Deleting either assertion, or slicing so wide that the predicate can match text from a neighbouring handler, turns both steps green permanently while defending nothing. That looks identical to success.

## Edge-Case & Dependency Audit

- **Race conditions.** None. Both tests are synchronous source-text reads.

- **Security.** None. No production file changes, no runtime path, no network surface, no secrets.

- **Side effects.** None outside the three test files. None of them is read by any gate (`parity:check`, `push-routing:check`, `verb-returns:check` do not read test files). The `terminal-renderer-lifecycle` edit is comment-only and cannot change that file's result.

- **The memo span must not swallow the neighbouring handler.** `case 'memoWorkspaceItems'` begins at `memo.js:122`, two lines after the real `break;`. A span ending at the next `case '` stops at `:122` and therefore includes the true `break;` at `:120` — correct. It must use a non-zero `fromIndex`, because the slice *starts* with the literal `case 'workspaceChanged'` and `indexOf("case '")` from 0 would return 0 and produce an empty body — the same class of bug in a new spelling.

- **`_wsRootExplicit` must stay outside the asserted window's requirements.** The guard is legitimate and unrelated to the debounce contract. Re-anchoring must not accidentally start asserting on it (e.g. by requiring a specific statement count in the handler).

- **A nested `switch` inside the arm would truncate the next-arm span, and a `break;`-existence check cannot detect it.** `handler.indexOf("case '", 1)` matches the first `case '` at any nesting depth. There is no nested switch in `workspaceChanged` today, but if one is ever added the span truncates at the inner arm — a *shorter* window that still contains the guard's own `break;` at `:108`. A sanity assertion of the form `assert.ok(/\bbreak;/.test(body))` therefore passes on exactly the failure it is meant to catch. The window must be proven to reach the **end of the arm**, not merely to contain a `break;`. See the superseded callout in Proposed Changes.

- **The re-anchored pane-fit window now contains ~15 lines of JSDoc prose.** The span runs from `function batchFitVisiblePanes(` (`:6018`) to `const NO_ROLE` (`:6040`), so the `NO_ROLE` doc comment at `:6026–6039` sits inside it. Two of the three assertions in that test are **negative** (`!batch.includes('requestAnimationFrame')`, `!batch.includes('fitAndReportSize')`), so a future edit that merely *mentions* either identifier in that comment fails the test with a message accusing the function body. This is inherent to bounding a function span with the next declaration and was equally true under `DEFAULT_ROLES`; it is accepted, not fixed, but it must be written down where the next reader will see it.

- **Step 76's declaration-order chain is load-bearing and must stay.** The chain exists so an inverted span fails with "check declaration order" instead of silently extracting backwards. Swap the tail marker; do not drop the chain.

- **The `block()` helper's guards are correct — do not soften them.** `end marker not found AFTER …` is precisely the diagnostic that made this diagnosable in seconds. Any change that makes a missing marker return an empty string instead of throwing would convert this loud failure into a silent green.

- **Dependencies & conflicts.** `terminals.js` and `memo.js` are untouched, so this does not serialise against any browser-cockpit or terminals stream (PRD: "one agent stream per provider file" — no provider file is in this diff). The two failing test files are independent of each other and can land separately; the `terminal-renderer-lifecycle` comment fix belongs with the pane-fit half, since it documents the same chain.

## Dependencies

- None to land this change.
- **Sequencing note (not a blocker):** run-step 11 (`mirror:check`) fails ahead of both of these, so CI will not reach either step until that lands. Each fix is still independently correct and independently landable — it removes a step from the blocking queue permanently. See `mirror-check-red-delegates-skill-missing-manifest-entry.md`.

## Adversarial Synthesis

**Risk Summary.** Both failures accuse correct production code of a defect it does not have, so the dominant risk is an implementer who "fixes" `terminals.js` or `memo.js` — re-adding a renamed constant, or deleting the `_wsRootExplicit` guard to move a `break;` — and thereby damages working code to satisfy a test's navigation bug. The second risk is weakening: deleting the failing assertions, or widening the memo span until it matches text from a neighbouring handler, turns both steps green while defending nothing, and looks identical to success — which is why the negative controls, not the green ticks, are the acceptance signal. The third is that five assertions have not evaluated in months, so re-anchoring may surface a real failure underneath — a finding to report, not a reason to re-widen the span. The fourth is the quiet one: the rename left the dead marker in two prose sites and the guard-against-recurrence in the first draft (`break;` exists) passes on the exact truncation it targets, so a repair that stops at "CI is green" leaves the next renamer reading a wrong map and the next guard-clause author re-opening the same hole.

## Proposed Changes

### `src/test/terminal-pane-fit-verification-contract.test.js` — retarget the tail marker

**Context.** Three sites naming the dead marker `const DEFAULT_ROLES` — two live, one prose:

| Line | Kind | Text |
| :--- | :--- | :--- |
| 46 | live | tail of the `order` array in `declaration order keeps every contract span forward-only` (lines 39–57) |
| 60 | live | end-marker in `block('function batchFitVisiblePanes(', 'const DEFAULT_ROLES')` |
| 14 | prose | the file header's declaration-order chain |

**Logic.** `DEFAULT_ROLES` was renamed `NO_ROLE` in `1c7de0f6` (confirmed by `git log -S"DEFAULT_ROLES" -- src/webview/terminals.js`). `const NO_ROLE = 'shell';` (`terminals.js:6040`) is the first top-level declaration after `function batchFitVisiblePanes()` (`:6018`), so it plays the identical boundary role, and the literal `const NO_ROLE` occurs exactly once in the file. Replace both live occurrences and the header prose. Add a comment recording why the marker is a *boundary sentinel* rather than part of the contract, so the next renamer knows what they moved.

**Implementation.**

Header comment (line 14) — update the chain so the file's own documentation stops naming a constant that has not existed since 2026-08-05:

```js
 *   readRenderedGrid -> inspectPaneFit -> resyncPaneRenderer -> startFitLadder
 *   -> batchFitVisiblePanes -> const NO_ROLE   (see AFTER_BATCH_FIT below)
```

Then hoist the marker:

```js
// NO_ROLE is a BOUNDARY SENTINEL, not part of the contract: it is simply the first
// declaration after batchFitVisiblePanes, and it bounds that function's span. It was
// `DEFAULT_ROLES` until the rename in 1c7de0f6, which broke both sites below and took
// this whole step — plus every CI step behind it — down with it. If you rename it
// again, retarget this one constant and the header comment in the same change.
//
// The span this bounds therefore INCLUDES NO_ROLE's own JSDoc block (terminals.js
// :6026-6039). Two assertions below are negative, so writing the words
// `requestAnimationFrame` or `fitAndReportSize` into that comment fails this test
// with a message that blames the function body. That is the accepted cost of
// bounding a function by the next declaration; there is no tighter marker.
const AFTER_BATCH_FIT = 'const NO_ROLE';

test('declaration order keeps every contract span forward-only', () => {
    const order = [
        'function readRenderedGrid(',
        'function inspectPaneFit(',
        'function resyncPaneRenderer(',
        'function startFitLadder(',
        'function batchFitVisiblePanes(',
        AFTER_BATCH_FIT
    ].map(m => [m, SRC.indexOf(m)]);
    // … unchanged …
});

test('the fit is verified, not fired once and forgotten', () => {
    const batch = block('function batchFitVisiblePanes(', AFTER_BATCH_FIT);
    // … unchanged …
});
```

Hoisting the marker to a single named constant is the point: two copies of a boundary literal is what let one of them be forgotten. Do not inline it back.

**Edge cases.** The three assertions inside the `batchFitVisiblePanes` span have not run since `1c7de0f6` and evaluate for the first time here. Static reading predicts all three pass. If any is red, report it — do not adjust the span to make it pass.

### `src/test/terminal-renderer-lifecycle-contract.test.js` — correct the cross-file chain in the header comment

**Context.** Line 23. Comment-only; this file is **green** and its live markers (`function attachRenderer(term, entry)` → `const ALL_THEME_CLASSES`, and the seven-function `at < anchor` chain at `:235`) are untouched by the rename.

**Logic.** This file's header is the only cross-file record of the pane-fit declaration chain, and it exists specifically to stop a future author declaring a function *inside* one of those spans. It names `const DEFAULT_ROLES` as the tail. A reader who trusts it will look for a constant that does not exist and conclude the comment is stale in some unknown way — or, worse, take the chain as unreliable and ignore it.

**Implementation.** One-line edit:

```js
 * slices spans between `readRenderedGrid -> inspectPaneFit -> resyncPaneRenderer ->
 * startFitLadder -> batchFitVisiblePanes -> const NO_ROLE`. Declaring any of them
 * between those markers silently widens another suite's spans.
```

**Edge cases.** None — no assertion in this file reads its own comments. This edit cannot change the file's pass/fail state, which is precisely why it is easy to skip and why it must not be. Note also that this file's `:235` test guards only the **head** of the chain (everything must be above `readRenderedGrid`); **nothing** guards the tail. The only detector of a future `NO_ROLE` rename is `test:contract:terminal-pane-fit` failing loudly — which is the behaviour being restored here, not a gap to close in this plan.

### `src/test/memo-panel-workspace-binding-contract.test.js` — bound the handler by its own arm, not by the first `break;`

**Context.** Lines 271–279 in the workspace-binding test (inside `memo.js sends the live root, not the load-time constant`, the 11th and last `await test(...)`). The three whole-file assertions earlier in the same test (`case 'workspaceChanged'` present, no `workspaceRoot: WS_ROOT`, `liveSites >= 5`) run *before* the failing line and currently pass — only the span-dependent tail is dark.

**Logic.** The handler now opens with `if (_wsRootExplicit) { break; }`, so "first `break;`" truncates the body to three lines and both `indexOf` probes return `-1`. Bound the span by the start of the **next switch arm** instead — the technique already used elsewhere in this repo's contract suite (`ws-surface-scoping-contract.test.js` bounds each resync entry by "the next `type: '` starts the next one"). A guard clause, an early return, or any number of added `break;` statements cannot move that boundary. Verified at HEAD: `case 'memoWorkspaceItems'` at `memo.js:122` is the next `case '` after index 0 of the slice, so the window is `:106–:121` and contains the real `break;` at `:120`.

**Sanity assertion — corrected.**

> **Superseded:** `assert.ok(/\bbreak;/.test(body), 'the workspaceChanged arm span is empty or unterminated …')`
> **Reason:** Vacuous against the failure it targets. The guard's own `break;` sits at `memo.js:108`, inside *every* truncation of this arm — including the empty-ish window the old code produced and the short window a future nested `switch` would produce (`indexOf("case '", 1)` matches at any nesting depth). The assertion passes on exactly the mis-bounding it claims to detect. "Contains a `break;`" is a property of the arm's *first three lines*; the property that actually matters is that the window reaches the arm's **end**.
> **Replaced with:** Assert the window contains the arm's terminal statement — `vscode.postMessage({ type: 'memoListWorkspaces' })`, which sits after the `if` block and before the closing `break;` and therefore cannot be reached by any early truncation.

**Implementation.**

```js
// Bound the arm by the START OF THE NEXT ARM, not by the first `break;`. This used to
// slice to `handler.indexOf('break;')`, which silently emptied the window the day an
// `if (_wsRootExplicit) { break; }` guard was added at the top of the handler — the
// assertions below then reported the clear/reassign pair "missing" while both sat two
// lines past the truncation point. fromIndex 1 is load-bearing: the slice STARTS with
// `case 'workspaceChanged'`, so searching from 0 would match at index 0 and give an
// empty body — the same bug in a new spelling.
const handler = memoJs.slice(memoJs.indexOf("case 'workspaceChanged'"));
const nextArm = handler.indexOf("case '", 1);
const body = nextArm === -1 ? handler : handler.slice(0, nextArm);

// The window must reach the END of the arm, not merely contain a `break;` — the
// `_wsRootExplicit` guard's own break sits three lines in, so a break-existence check
// would pass on precisely the truncation it is meant to catch. memoListWorkspaces is
// the arm's last statement: it is unreachable by any early cut, including one caused
// by a nested `switch` (indexOf("case '") matches at any depth).
assert.ok(body.includes("type: 'memoListWorkspaces'"),
    'the workspaceChanged span was cut short of the arm end — a marker moved again; '
    + 're-anchor this span rather than editing memo.js');

const clearIdx = body.indexOf('clearTimeout(_memoSaveTimer)');
const assignIdx = body.indexOf('_wsRoot = msg.workspaceRoot');
assert.ok(clearIdx !== -1 && assignIdx !== -1,
    'workspaceChanged handler is missing its debounce cancel or its root reassignment');
assert.ok(clearIdx < assignIdx,
    'the pending save is cancelled AFTER the root is reassigned — the debounce data-loss window is open');
assert.match(body, /_submittedContent = null/,
    'an in-flight memoPromptResult from the previous workspace can still clear the new memo');
```

The added end-of-arm sanity assertion is the guard against the *next* instance of this bug: it fails with an explicit "re-anchor this span" instruction rather than accusing `memo.js` of a missing statement.

**Edge cases.**

- **`workspaceChanged` becomes the last arm.** `indexOf("case '", 1)` returns `-1` and the span runs to end-of-file. Harmless: all four probes are for statements unique to this handler, and the end-of-arm check still passes.
- **A nested `switch` is added inside the arm.** The span truncates at the inner `case '`. The end-of-arm assertion catches this and names the fix; the old `break;`-existence check would not have.
- **Why not brace-matching.** Scanning from the arm's opening `{` to its matching `}` is the only *structurally* correct technique, but naive depth counting miscounts braces inside string literals, template literals, regexes, and comments — trading one incidental assumption ("no nested `case '`") for another ("no braces in strings"), at four times the code. Rejected as not obviously safer. It is the correct escalation if this span rots a third time.

## Verification Plan

### Automated Tests

1. `npm run test:contract:terminal-pane-fit` — must report **0 contract(s) failed** (currently 2). The two previously-erroring tests must now *evaluate*, and the three assertions inside the `batchFitVisiblePanes` span must be seen to run.
2. `npm run test:contract:memo-workspace-binding` — must report **11 passed, 0 failed** (currently 10/1). The file contains exactly 11 `await test(...)` calls, so 11 is the full set, not a partial run.
3. `npm run test:contract:terminal-renderer-lifecycle` (`package.json:914`; CI run-step at `integration-tests.yml:443`, ahead of pane-fit and behind memo) — must stay green. The edit there is comment-only; a change in its result means something other than a comment was touched.
4. **Negative control per file — each re-anchored span must still be able to fail.** These prove the window is non-empty *and* correctly bounded, which is the whole defect being repaired: a mis-bounded window satisfies every negative assertion vacuously and is indistinguishable from success without a control. **Run these before step 5, and revert each before running the next.**
   - `terminal-pane-fit`: temporarily insert `requestAnimationFrame(() => {});` inside `batchFitVisiblePanes()` in `terminals.js`. The test must fail on `the single-rAF body must be gone`. **Revert.**
   - `memo-workspace-binding` (end-of-arm guard): temporarily insert a `break;` immediately after the `if (_wsRootExplicit) { break; }` line — i.e. simulate the old truncation without removing anything. The re-anchored test must still **pass**, proving the span no longer keys on the first `break;`. **Revert.**
   - `memo-workspace-binding` (ordering assertion): temporarily move `_wsRoot = msg.workspaceRoot;` above the `clearTimeout(_memoSaveTimer)` line in `memo.js`. The test must fail on `the pending save is cancelled AFTER the root is reassigned`. **Revert.**

   If either sabotage-must-fail control passes with the sabotage in place, the span is still empty or still mis-bounded and the repair is not done.
5. Confirm `git diff --name-only` lists **only the three test files** — `terminal-pane-fit-verification-contract.test.js`, `memo-panel-workspace-binding-contract.test.js`, `terminal-renderer-lifecycle-contract.test.js`. Any appearance of `src/webview/terminals.js` or `src/webview/memo.js` in the final diff means either the trap in "The trap" section was walked into, or a step-4 control was not reverted.
6. `grep -rn "DEFAULT_ROLES" src/` must return **zero** matches. The rename is five months stale in three places; the fix is not done while any of them survives.
7. `npm run parity:check`, `npm run push-routing:check`, `npm run verb-returns:check` — green (verified green at HEAD; none read test files).

### Manual

8. None required. No change touches a runtime path.

## Uncertain Assumptions

None. Every factual claim in this plan was verified directly against the working tree at HEAD: all six `terminals.js` marker line numbers and the uniqueness of `const NO_ROLE`; the full text of the `workspaceChanged` arm and its neighbour at `memo.js:122`; the three `DEFAULT_ROLES` sites and the two live marker sites; the `1c7de0f6` rename via `git log -S`; the CI run-step indices (11 / 65 / 76 of 101), the single-job shape, and the absence of any `continue-on-error`; the 11-test count in the memo file; and the `terminal-renderer-lifecycle` declaration-order test's markers. The only behavioural claims are about `String.prototype.indexOf(searchValue, fromIndex)` and Node's `assert`, which need no confirmation. **No web research is required before implementation.**

## Agent Recommendation

**Send to Coder** (complexity 4) — mechanically small, but it demands the discipline to leave two correct production files alone while their tests scream that they are broken, to pick a span technique that survives the next edit rather than only this one, and to make a comment-only edit in a green third file that no gate will ever reward.

The reviewer should check five things: that the diff contains **no production files**; that `grep -rn "DEFAULT_ROLES" src/` is empty, including the two prose sites; that the memo sanity assertion checks the **arm's terminal statement** and not merely the presence of a `break;` (the `break;` form passes on the very truncation it claims to catch); that all three negative controls in step 4 were actually run and reverted; and that the step-76 marker is hoisted to one named constant rather than re-inlined at both sites.
