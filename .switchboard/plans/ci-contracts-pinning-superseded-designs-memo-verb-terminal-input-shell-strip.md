# Three CI contracts pin implementations that were deliberately replaced — the code moved on and the assertions did not

## Goal

Re-author three red contract assertions so each defends its stated **intent** against the design that actually shipped, instead of the implementation shape that has since been replaced. All three block CI (run-steps 64, 78, 80 of 101 — verified: `test:contract:memo-browser-clear` is the 64th `run:` step in `.github/workflows/integration-tests.yml`, `terminal-focus-affordance` the 78th, `shell-terminal-strip` the 80th, of 101 total). In all three cases the production code is correct and the design change was deliberate; the contracts were left behind.

> **Superseded:** "One of the three also carries a genuine open question about a residual behaviour gap, which this plan surfaces as an explicit decision rather than assuming away."
> **Reason:** The question — whether the old `if (!isKnown)` refetch covered the `!targetTerm` case — is answerable from git history, not a judgement call. `git show ab384c01 -- src/webview/terminals.js` shows the `const isKnown` / `if (!isKnown) { fetchTerminalList(); }` block was introduced **inside** the `if (targetTerm)` block, and `1bd39f4a` replaced it in place at the same nesting level. The old form never covered `!targetTerm` either. Shipping "the implementer must decide and record" where one `git show` settles it converts a verifiable fact into a hedge, and the completion report then reads as thorough while nothing was verified.
> **Replaced with:** All three changes are **test-only, zero production edits**. The `!targetTerm` refetch is *net-new scope* — no coverage was lost, so adding it is a feature request, explicitly out of scope for a CI-signal repair. See the step-80 section.

### Problem Analysis

These are not anchor drift (a marker that moved — see `ci-contract-span-rot-memo-binding-and-pane-fit.md` for that class). Every marker here still resolves. These assertions *run*, and they fail because they encode **how** the code once achieved a contract rather than **what** the contract is. When the how was deliberately replaced by something better, the assertion became a guard against the improvement.

---

#### Run-step 64 — `test:contract:memo-browser-clear` (16 passed, 1 failed of 17)

Failing assertion: `the unresolvable-workspace failure is ROUTABLE and carries \`error\` (PRD contract #4)` at `src/test/memo-browser-clear-and-copy-contract.test.js:274-289`. It dies on the *first* line of its own body:

```js
vscodeStub.setWorkspaceFolders([]);
const res = await provider.handleServiceVerb('memoGeneratePrompt', { content: 'Bug: one', action: 'copy' });
vscodeStub.setWorkspaceFolders([tmpRoot]);
assert.strictEqual(res.success, false);      // ← AssertionError: true !== false
```

The test's own comment states the premise: *"`_resolveWorkspaceRoot()` returns null only when there are NO roots at all, which is what makes this branch reachable."* That premise was true when the provider read `vscode.workspace.workspaceFolders`. It is no longer true. Resolution is now **seam-first** (PRD contract #3 — providers reach the host only through `hostSeams.ts`):

```ts
// TaskViewerProvider.ts:3061-3065
private _getWorkspaceRoots(): string[] {
    const seamRoots = this._hostSeams?.workspace?.getWorkspaceRoots();
    if (seamRoots && seamRoots.length > 0) { return seamRoots; }   // ← short-circuits here
    return (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.fsPath);
}
```

The full chain, verified at HEAD: the arm calls `_resolveStateWorkspaceRoot(data.workspaceRoot)` (`:13352`) → `_resolveWorkspaceRoot(workspaceRoot)` (`:3240`) → whose final fallback is `const roots = this._getWorkspaceRoots(); return roots.length > 0 ? roots[0] : null;` (`:3258-3259`).

And the harness builds seams that are **not** empty — `createHeadlessTestSeams({ roots: [tmpRoot], ...seamOpts })`, where the helper wires `getWorkspaceRoots: () => opts.roots || []` (`src/test/helpers/verbEngineTestSeams.js:309`). So the seam returns `[tmpRoot]`, `_getWorkspaceRoots()` short-circuits before the vscode fallback, the root resolves, the arm succeeds, and `res.success` is `true`.

**The lever the test pulls is no longer connected to the branch it targets.** The arm's failure branch is present and exactly PRD-#4-compliant (`TaskViewerProvider.ts:13351-13362`):

```ts
case 'memoGeneratePrompt': {
    const workspaceRoot = this._resolveStateWorkspaceRoot(data.workspaceRoot);
    if (!workspaceRoot) {
        const noRootMsg = 'No workspace folder found for memo.';
        this.postMessage({ type: 'memoError', message: noRootMsg });
        // TYPED + `error`, like the two returns below it. Untyped, transport.js stops
        // before dispatchMessage and raises the useless toast "Action failed:
        // memoGeneratePrompt" over a panel status line that never updates from the reply
        // (PRD contract #4: a failure body carries `error`).
        return { success: false, type: 'memoError', message: noRootMsg, error: noRootMsg };
    }
```

Nothing about that is wrong. The test simply cannot reach it any more. **Classified with a fresh `out/`** (`npm run compile-tests`, exit 0) — this is not a stale-build artifact; it fails identically against freshly compiled output.

**Also stale, and load-bearing for the next reader:** the harness comment at `memo-browser-clear-and-copy-contract.test.js:68-70` asserts *"`_getWorkspaceRoots()` reads `vscode.workspace.workspaceFolders` DIRECTLY (not via a seam), and every root validation flows through it"*. That is the exact false premise that produced this failure, sitting 200 lines above it. Left in place it re-teaches the mistake.

Note that `setWorkspaceFolders([])` appears at **exactly one** site in the whole suite (`:278`). No sibling test depends on the stale lever.

---

#### Run-step 78 — `test:contract:terminal-focus-affordance` (11 passed, 1 failed of 12)

Failing assertion: `keystrokes on a non-OPEN socket are reported, not swallowed` at `src/test/terminal-focus-affordance-contract.test.js:108-115`. Two of its three probes pass; the third does not:

```js
assert.ok(terminalsJs.includes('notifyInputDropped(entry)'), '…');              // ✓ present
assert.ok(!terminalsJs.includes('entry.inputQueue'), '…');                      // ✓ absent
assert.ok(terminalsJs.includes('entry.inputDropNoticed = false'),
    'the notice must reset on reconnect, or the second outage is silent');      // ✗
```

`inputDropNoticed` appears nowhere in `src/webview/terminals.js` — it survives only inside this assertion string (`grep -rn inputDropNoticed src/` returns one hit, this test). It was removed **deliberately** in `886849ce` (2026-08-05), and the diff is explicit about why — it rewrote the doc comment in the same hunk:

```diff
-     *  is the PERSISTENT signal — this line only catches the operator who is
-     *  looking at the terminal rather than the header. */
+     * The header chip (refreshInputState) is the whole signal. It is chrome, it
+     * self-corrects when the socket returns, and it leaves no residue. */
      function notifyInputDropped(entry) {
          refreshInputState(entry.name);
-         if (entry.inputDropNoticed) { return; }
-         entry.inputDropNoticed = true;
-         try {
-             entry.term.write('\r\n\x1b[33m[Not connected — keystroke discarded]\x1b[0m\r\n');
-         } catch { /* ignore */ }
      }
```

The same commit dropped `inputDropNoticed: false` from the entry initialiser and `entry.inputDropNoticed = false;` from `ws.onopen`. What was removed is a **notice written into the terminal buffer**, latched behind a once-per-outage flag that needed resetting on reconnect. That buffer write is prohibited by a documented rule this codebase enforces in two other places (`terminals.js:7682`, `:7962` — *"see the prohibition on notifyInputDropped"*): a notice injected into the buffer lands inside a screen the CLI believes it owns and shifts the row count its next relative redraw depends on. The surviving doc comment at `terminals.js:3779-3792` adds a second reason the latch was worthless: *"Its 'once per disconnect episode' guard did not hold either: `ws.onopen` cleared the flag, so a flapping socket wrote a fresh line every reconnect cycle."*

So the latch is gone because the thing it was latching is gone — and because the latch did not even work. The whole function is now two lines (`terminals.js:3793-3795`):

```js
function notifyInputDropped(entry) {
    refreshInputState(entry.name);
}
```

The signal is now the **derived** header chip — which is exactly what the sibling assertion in the same file pins, and that one passes: `the input-state chip is derived, never cached`. With nothing latched, there is nothing to reset, and the failure mode the assertion names — *"the second outage is silent"* — **cannot occur**: a derived chip re-derives on every state change.

The assertion is therefore guarding against the correct design, on behalf of a hazard the correct design eliminated.

---

#### Run-step 80 — `test:contract:shell-terminal-strip` (39 passed, 1 failed of 40)

Failing assertion: `an agentCompleted for a name absent from fleetList triggers a refetch` at `src/test/shell-terminal-strip.test.js:126-136` (the test block is eleven lines and carries **two** assertions, not one — the second, an ordering check, passes):

```js
const handler = block(terminalsJs, 'function handleAgentCompleted(msg) {', 'function showCompletionToast(');
assert.ok(
    /const isKnown = fleetList\.some\([\s\S]*if \(!isKnown\) \{[\s\S]*fetchTerminalList\(\)/.test(handler),
    'a badge for a terminal not yet in fleetList must trigger fetchTerminalList so the strip converges'
);                                                                              // ✗
assert.ok(
    handler.indexOf('terminalBadges.set(') < handler.indexOf('fetchTerminalList()'),
    'the badge must be set BEFORE the refetch, or the relayed snapshot will not carry it'
);                                                                              // ✓
```

Both `block()` markers still resolve (`handleAgentCompleted` at `terminals.js:7892`, `showCompletionToast` at `:7927`), so this is purely assertion semantics. The regex demands a *conditional* refetch — compute `isKnown`, and refetch only when the name is unknown. The current handler replaced that with an **unconditional** refetch, and says so (`terminals.js:7908-7917`):

```js
if (targetTerm) {
    terminalBadges.set(targetTerm, { label: 'DONE', stamp: ++badgeStampSeq });
    renderSidebarList();
    renderPaneGrid();
    postFleetStateToShell();

    // Unconditional refetch: the completion clear has nulled dispatched_at,
    // so this retires the plan strip in the same beat as the DONE badge.
    fetchTerminalList();
}
```

For the scenario the test names, the replacement is a **superset**: if `msg.terminalName` is supplied but absent from `fleetList`, `targetTerm` is truthy, the badge is set and `fetchTerminalList()` fires. The strip converges. The contract's intent is met — by a simpler mechanism with a second, independent justification (retiring the plan strip on the nulled `dispatched_at`).

**The `!targetTerm` question — settled by git, not by the implementer.**

> **Superseded:** "The refetch now sits *inside* `if (targetTerm)`. When `msg.terminalName` is absent **and** the role/worktree fallback finds no match, `targetTerm` is falsy: no badge, and **no refetch**. Whether the old `if (!isKnown)` form covered that case, and whether it needs covering, is a decision this plan requires the implementer to make explicitly rather than assume. Arguments both ways are recorded under Proposed Changes."
> **Reason:** The first half of that question has an answer in the repository. `git show ab384c01 -- src/webview/terminals.js` shows the block was **introduced inside `if (targetTerm)`**, immediately after `postFleetStateToShell()` and before the brace that closes `if (targetTerm)`; `git show 1bd39f4a -- src/webview/terminals.js` shows the four lines replaced in place, at the same nesting level. The `!targetTerm` path has **never** refetched, in either form. So there is no regression, no residual, and nothing for an implementer to weigh — leaving an answerable question open would have manufactured a production edit inside a test-repair plan.
> **Replaced with:** The refetch coverage is **unchanged** by `1bd39f4a`. Adding a refetch to the `!targetTerm` path is **net-new scope** and is explicitly out of scope here: this plan repairs CI signal and touches no production code. If it is ever wanted it is its own plan, with its own justification for one HTTP request per unidentifiable completion. Record it as unchanged in the completion report; do not re-litigate it.

### Root Cause

Contracts written as assertions over implementation shape — a latched flag, a named local, a specific conditional — rather than over observable contract behaviour. Each was accurate when written. Each became a ratchet against improvement the moment the implementation was deliberately bettered, and each then reported the improvement as a violation.

The distinguishing feature versus ordinary anchor rot: **the markers all resolve and the assertions all run.** No helper fires a "marker not found" diagnostic. The failure text accuses the source of missing a behaviour it delivers by other means, which is why all three read as regressions and none is.

### Why this matters beyond three red ticks

The workflow is a **single job** with **zero** `continue-on-error` declarations (verified: `grep -n continue-on-error .github/workflows/integration-tests.yml` returns nothing), so each of these halts the entire run. Run-step 64 is the earliest of the three. None is a product defect; all three are pure signal loss, and each one that stays red keeps the steps behind it dark for no reason.

## Metadata

**Tags:** test, bugfix, reliability
**Complexity:** 5
**Project:** Browser Switchboard

> **Superseded:** Complexity 6.
> **Reason:** 6 priced in a possible production edit to `terminals.js` and an unresolved behavioural question. Both are gone — the `!targetTerm` question is answered from git history and the diff is exactly three test files. What remains is three design verdicts (each requiring a historical diff to be read), one behavioural test that needs a compiled `out/`, and three negative controls. That is Mixed, not High.
> **Replaced with:** Complexity 5. Agent recommendation unchanged (**Send to Coder**, 4-6 band).

## User Review Required

None. There is no longer any open question: the one candidate — whether the `!targetTerm` branch of `handleAgentCompleted` lost refetch coverage — is answered by `ab384c01` and `1bd39f4a` (it never had it). All three changes are test-only.

## The trap: three failure messages accuse correct code

- `true !== false` reads as "the memo verb returns a false success on an unresolvable workspace" — a direct PRD contract #4 violation. It is not one. The branch is correct and unreachable from the test's lever.
- `the notice must reset on reconnect, or the second outage is silent` reads as "someone deleted the reconnect reset". They deleted the whole latch, on purpose, because the thing being latched was a prohibited buffer write — and because the latch leaked on every reconnect anyway.
- `a badge for a terminal not yet in fleetList must trigger fetchTerminalList` reads as "the refetch is missing". It is unconditional and strictly broader for the tested case, with identical coverage of the untested one.

**Do not "restore" any of the three removed implementations.** Re-adding a latched `inputDropNoticed` reintroduces a buffer write that corrupts the CLI's screen model. Re-adding `if (!isKnown)` narrows a deliberately widened refetch. And nothing in `TaskViewerProvider.ts` or `terminals.js` needs touching at all — **the entire diff for this plan is three files under `src/test/`.**

## Complexity Audit

### Routine

- Three test files, **zero** production files. `buildHeadlessTaskViewer` is defined locally inside `memo-browser-clear-and-copy-contract.test.js:67` (not a shared helper) and **already accepts `seamOpts` and spreads it into `createHeadlessTestSeams`**, so even the step-64 harness change is inside one of the three files.
- All three are already wired into CI with existing `package.json` scripts (`test:contract:memo-browser-clear`, `test:contract:terminal-focus-affordance`, `test:contract:shell-terminal-strip` — verified at `package.json:881`, `:916`, `:918`). No new wiring.
- Steps 78 and 80 are plain synchronous source-text contracts — no framework, no fixtures, no async.
- The three are mutually independent and can land separately in any order.
- No overlap with the sibling span-rot plan: it targets `terminal-pane-fit-verification-contract.test.js`, `terminal-renderer-lifecycle-contract.test.js`, and `memo-panel-workspace-binding-contract.test.js` — three different files. The two plans parallelise safely.

### Complex / Risky

- **Each one requires a design verdict, not a mechanical edit.** "Was the replacement deliberate and correct, and what should the contract now assert?" has to be answered per case by reading the historical diff. An implementer who skips that reading will either restore the old implementation or delete the assertion — both wrong.
- **Step 64 needs a compiled `out/`.** Unlike the other two it is a *behavioural* test that loads `../../out/services/TaskViewerProvider`. It must be run after `npm run compile-tests`, or the result is meaningless. (Verified: fails identically with fresh output, so the failure is real.)
- **Deletion is the tempting non-fix.** All three assertions could be removed and CI would go green. Each defends something real — a routable failure body, a keystroke-drop signal, strip convergence — so each must be *re-authored*, never dropped. A deleted assertion and a repaired one look identical from the outside: green.
- **Every replacement is written against code that already satisfies it, so a green run proves nothing.** This is the plan's own dominant failure mode, not a hypothetical: the *surviving* first probe of step 78 (`terminalsJs.includes('notifyInputDropped(entry)')`) is already a tautology — the string is a substring of the function's own declaration line, so it passes with the `term.onData` call site deleted. Assertions that cannot fail are indistinguishable from assertions that pass. The negative controls in Verification step 5 are the only defence and are not optional.
- **Step 64's replacement lever must be genuinely unreachable-making.** Emptying only the seam is not enough if the vscode fallback then supplies roots; emptying only the vscode stub is what already fails. Both halves have to be empty at once, and the test must prove the branch was actually entered rather than merely that `success` was false for some other reason.
- **Test-block counts are not a quality metric.** The three suites report 17 / 12 / 40 test *blocks* (verified by counting `test(` / `await test(` declarations); the current failures are 16+1 / 11+1 / 39+1). An assertion silently weakened *inside* a block leaves those totals untouched.

## Edge-Case & Dependency Audit

- **Race conditions.** None. Steps 78 and 80 are synchronous source reads. Step 64 awaits a single `handleServiceVerb` call with no concurrency.

- **Security.** None. No auth, secrets, network surface, or user-supplied input is involved. Step 64 briefly makes a provider resolve zero workspace roots inside a test harness; nothing persists.

- **Side effects.** Step 64 must restore whatever it emptied, in both the seam and the vscode stub, before the next test in the file runs. The vscode stub is process-global and `vscodeStub.reset()` clears **only the access log**, not `workspace.workspaceFolders` (`verbEngineTestSeams.js:127`), so an unrestored `[]` persists for the remainder of the file. Test-order coupling is the hazard: a leaked empty stub would make every subsequent test resolve no root and cascade unrelated failures. Construct a **separate** short-lived provider for the seam half so an empty seam cannot leak at all, and restore the vscode half in a `finally`.
  - Sequencing detail: `buildHeadlessTaskViewer` itself calls `vscodeStub.setWorkspaceFolders([tmpRoot])` on entry (`:70`), so the `setWorkspaceFolders([])` must come **after** the build call, never before.
  - Mitigating factor, not a licence to skip the `finally`: the next test in the file (`setApiServer BEFORE the hub exists…`) re-sets the folders itself, so today a leak would be masked there rather than everywhere. That is luck, and it changes if tests are reordered.

- **Step 64: assert the branch, not just the shape of the result.** `success: false` is also what an aggregate `catch` returns. The test must confirm it landed in the *no-root* branch specifically — `res.type === 'memoError'` and `res.error === 'No workspace folder found for memo.'` — otherwise a future unrelated throw inside the arm would satisfy the assertion and the contract would be unguarded.

- **Step 64: `_getAllowedRoots()` reads machine state, the null path does not.** `_getAllowedRoots()` (`TaskViewerProvider.ts:3262`) folds in `workspaceDatabaseMappings` via `getMappingsFromIndex()`, so it can be non-empty on a developer machine even with zero workspace roots. That does not affect this test: the allowed-roots set is consulted only on the explicit-`workspaceRoot` and kanban-delegate paths, and the test passes no `workspaceRoot` and has no `_kanbanProvider`. The final fallback reads `_getWorkspaceRoots()` directly (`:3258-3259`), which both arms leave empty. Do **not** "simplify" the test by passing an explicit `workspaceRoot` — that reroutes it through machine-dependent state.

- **Step 78: the replacement assertion must be a real guard, not a tautology.** Asserting only that `notifyInputDropped` calls `refreshInputState` is weak — it would pass on a body that also reintroduced the buffer write. Pair it with a negative: the function body must not contain `term.write(`. That pins the prohibition the removal existed to honour, and is strictly stronger than the latch assertion it replaces.

- **Step 78: scope both the negative *and* the drop-is-reported probe to a span, not the file.** `terminals.js` legitimately calls `term.write(` elsewhere (that is how a terminal works), so the prohibition must be evaluated inside the `notifyInputDropped` span only. Symmetrically, the "the drop is reported" probe must be evaluated inside the `term.onData` span — file-wide it is satisfied by the declaration of the very function whose invocation it claims to check. The file already has a `block()` helper (`terminal-focus-affordance-contract.test.js:33-38`) for exactly this.

- **Step 80: `block()` markers still resolve — do not "fix" them.** `function handleAgentCompleted(msg) {` (`:7892`) and `function showCompletionToast(` (`:7927`) are both present and correctly ordered. This is not the span-rot class; changing the markers would be a no-op that obscures the real edit.

- **Step 80: keep the surviving ordering assertion's intent.** The failing block's second assertion (badge before refetch) passes today and encodes a real requirement — the relayed snapshot must already carry the badge. Whether it survives as a separate `assert.ok` or is folded into the convergence regex, the ordering must still be pinned; dropping it while "replacing the stale regex" would be a silent coverage loss inside a plan about silent coverage loss.

- **Dependencies & conflicts.** No gate reads test files (`parity:check`, `push-routing:check`, `verb-returns:check` — all verified green at HEAD). With the `!targetTerm` question settled as out-of-scope there is **no** production edit, so the PRD's one-agent-per-provider-file rule does not bind this plan at all: three test-only changes serialise against nothing.

## Dependencies

- None to land these changes.
- **Sequencing note (not a blocker):** run-step 11 (`mirror:check`) fails ahead of all three, so CI will not reach any of them until that lands — see `mirror-check-red-delegates-skill-missing-manifest-entry.md`. Run-steps 65 and 76 also fail ahead of steps 78 and 80 — see `ci-contract-span-rot-memo-binding-and-pane-fit.md`. Each fix here is still independently correct and independently landable; each permanently removes one step from the blocking queue.

## Adversarial Synthesis

**Risk Summary.** All three failure messages accuse correct production code, so the dominant risk is an implementer who "restores" a deliberately-removed implementation — re-latching `inputDropNoticed` (which reinstates a prohibited terminal-buffer write that corrupts the CLI's screen model) or re-narrowing an intentionally unconditional refetch. The second and deeper risk is that every replacement assertion here is authored against code that already satisfies it, so a green run is not evidence of a guard: the step-78 probe this plan *inherits* is already a tautology satisfied by a function declaration, which is precisely how an assertion decays into decoration — the per-assertion negative controls in Verification step 5 are the only thing that distinguishes a repair from a deletion. Third, step 64's lever: emptying only the seam or only the vscode stub leaves the target branch unreachable, asserting bare `success: false` would be satisfied by any unrelated throw, and the process-global vscode stub does not self-restore on `reset()`, so an unrestored `[]` cascades into every test after it.

## Proposed Changes

### `src/test/memo-browser-clear-and-copy-contract.test.js` — reach the branch through the seam, prove which branch was reached, and delete the false premise

**Context.** Two edits in one file: the failing test at lines 274-289, and the stale harness comment at lines 68-70 that states the premise which caused the failure.

**Logic.** Resolution is seam-first, so `vscodeStub.setWorkspaceFolders([])` alone cannot make the root unresolvable — the seam's `getWorkspaceRoots()` still returns `[tmpRoot]` and short-circuits. Build a provider whose **seam** reports no roots (`createHeadlessTestSeams({ roots: [] })`, per `verbEngineTestSeams.js:309`) *and* whose vscode stub reports none, so `_getWorkspaceRoots()` returns empty through both arms and `_resolveWorkspaceRoot()` reaches its `roots.length > 0 ? roots[0] : null` fallback as `null`. Then tighten the assertions to prove the no-root branch specifically, so an unrelated throw cannot satisfy the test.

**Implementation.**

```js
await test('the unresolvable-workspace failure is ROUTABLE and carries `error` (PRD contract #4)', async () => {
    // Resolution is SEAM-FIRST (PRD contract #3): _getWorkspaceRoots() returns
    // _hostSeams.workspace.getWorkspaceRoots() whenever it is non-empty and only then
    // falls back to vscode.workspace.workspaceFolders. This test used to force the
    // branch with vscodeStub.setWorkspaceFolders([]) alone, which stopped working the
    // moment the arm went through the seam — the seam kept returning [tmpRoot], the
    // root resolved, the arm succeeded, and the assertion read as a PRD #4 violation in
    // code that is in fact compliant. BOTH arms must be empty. Use a dedicated
    // provider so an empty seam cannot leak into the tests that follow, and empty the
    // vscode stub AFTER the build — buildHeadlessTaskViewer sets it to [tmpRoot] itself.
    const { provider: rootlessProvider } = buildHeadlessTaskViewer(tmpRoot, { roots: [] });
    vscodeStub.setWorkspaceFolders([]);
    let res;
    try {
        res = await rootlessProvider.handleServiceVerb('memoGeneratePrompt', {
            content: 'Bug: one', action: 'copy',
        });
    } finally {
        // vscodeStub.reset() clears only the access log, not workspaceFolders, so an
        // unrestored [] would starve every test after this one of a workspace root.
        vscodeStub.setWorkspaceFolders([tmpRoot]);
    }

    assert.strictEqual(res.success, false);
    // Pin the BRANCH, not just the shape: `success:false` is also what the aggregate
    // catch returns, so without these an unrelated throw inside the arm would satisfy
    // this test and leave the contract unguarded.
    assert.strictEqual(res.type, 'memoError',
        'untyped failure body — transport.js stops before dispatchMessage, so the panel never shows it');
    assert.strictEqual(res.error, 'No workspace folder found for memo.',
        'this must be the no-root branch, not an incidental throw');
    assert.strictEqual(res.error, res.message, 'the toast and the panel status must say the same thing');
});
```

No harness signature change is needed.

> **Superseded:** "`buildHeadlessTaskViewer` must accept and forward seam options; if it does not already, extend it minimally (forwarding an `opts` object into `createHeadlessTestSeams`) rather than duplicating the harness."
> **Reason:** Verified at HEAD — it already does. `function buildHeadlessTaskViewer(tmpRoot, seamOpts = {})` (`:67`) calls `createHeadlessTestSeams({ roots: [tmpRoot], ...seamOpts })` (`:74`), so `{ roots: [] }` overrides the default. Leaving the hedge in invites a needless refactor and, worse, made Verification step 6 unable to state the expected diff exactly.
> **Replaced with:** Pass `{ roots: [] }` as the existing second parameter. The harness is unchanged and the plan's total diff is exactly three test files.

The second edit in this file replaces the comment that caused the failure — the plan's whole point is that a stale premise sitting above a test re-teaches the mistake:

```js
// _getWorkspaceRoots() is SEAM-FIRST: it returns _hostSeams.workspace.getWorkspaceRoots()
// whenever that is non-empty and only falls back to vscode.workspace.workspaceFolders
// otherwise (TaskViewerProvider.ts:3061-3065). Every root validation flows through it, so
// the arm only accepts an explicit `workspaceRoot` listed in one of the two — and making a
// root UNRESOLVABLE requires emptying BOTH, not just the vscode side.
```

**Edge cases.** `_resolveWorkspaceRoot` also consults `this._kanbanProvider?.getCurrentWorkspaceRoot()`, but every branch validates against `_getAllowedRoots()` / `_getWorkspaceRoots()`; the harness constructs no kanban provider and the final fallback reads `_getWorkspaceRoots()` directly, so the result is still `null`. If a future change lets the kanban provider supply an unvalidated root, this test fails loudly rather than silently, which is the correct direction.

### `src/test/terminal-focus-affordance-contract.test.js` — assert the derived signal, the buffer-write prohibition, and scope the surviving probe

**Context.** Lines 108-115, the `keystrokes on a non-OPEN socket are reported, not swallowed` test.

> **Superseded:** "The first two probes are correct and stay."
> **Reason:** Probe 2 (`!terminalsJs.includes('entry.inputQueue')`) is correct — a file-wide negative is the right scope for "this must not exist anywhere". Probe 1 is **not**: `terminalsJs.includes('notifyInputDropped(entry)')` is satisfied by the function's own declaration line, `function notifyInputDropped(entry) {`, which contains that substring. The probe therefore passes with the `term.onData` else-branch call at `terminals.js:7384` deleted — i.e. it cannot detect the exact regression its message claims to guard ("the else branch of term.onData must surface the drop"). Carrying it forward unchanged, in a plan about assertions that cannot fail, would be the plan committing its own diagnosis.
> **Replaced with:** Keep probe 2 as-is; re-scope probe 1 to the `term.onData` span so the declaration cannot satisfy it. `term.onData(` occurs exactly once in the file (`:7314`), so `block(terminalsJs, 'term.onData((data) => {', 'connectTerminalSocket(entry);')` is an unambiguous span — verified to contain the call and to exclude the declaration at `:3793`.

**Logic.** The latch (`inputDropNoticed`) and the terminal-buffer notice it gated were removed together in `886849ce`, because a notice written into the buffer shifts the row count the CLI's next relative redraw depends on — the prohibition referenced at `terminals.js:7682` and `:7962` — and because `ws.onopen` cleared the flag anyway, so a flapping socket wrote a fresh line per reconnect. With nothing latched there is no reset to assert, and "the second outage is silent" is structurally impossible against a derived chip. Replace the latch probe with two that pin the design that actually ships: the drop is reported via `refreshInputState`, and the buffer write must not come back. Scope every span-sensitive probe to its span.

**Implementation.**

```js
test('keystrokes on a non-OPEN socket are reported, not swallowed', () => {
    // Scoped to the onData handler, not the file: `notifyInputDropped(entry)` is a
    // substring of the function's own declaration, so a file-wide includes() passes
    // with this call site deleted — the precise regression this probe names.
    const onData = block(terminalsJs, 'term.onData((data) => {', 'connectTerminalSocket(entry);');
    assert.ok(/\} else \{[\s\S]*notifyInputDropped\(entry\);/.test(onData),
        'the else branch of term.onData must surface the drop');
    assert.ok(!terminalsJs.includes('entry.inputQueue'),
        'input must NOT be queued — replaying stale keystrokes can complete a half-typed command');

    // This used to assert `entry.inputDropNoticed = false` — the reset of a once-per-
    // outage LATCH that gated a `[Not connected — keystroke discarded]` notice written
    // into the terminal BUFFER. Both were removed on purpose in 886849ce: a notice in
    // the buffer lands inside a screen the CLI believes it owns and shifts the row count
    // its next relative redraw depends on (the prohibition referenced at terminals.js
    // :7682 and :7962), and the latch leaked anyway — ws.onopen cleared it, so a
    // flapping socket wrote a fresh line every reconnect. The signal is now the DERIVED
    // header chip, so there is no latch to reset and "the second outage is silent"
    // cannot happen — a derived chip re-derives every time. Pin the shipped design
    // instead, in both directions.
    const notify = block(terminalsJs, 'function notifyInputDropped(entry) {', '\n    }');
    assert.ok(notify.includes('refreshInputState('),
        'the drop must reach the derived header chip — that chip IS the signal now');
    assert.ok(!notify.includes('term.write('),
        'do NOT write the notice into the terminal buffer: it shifts the row count the '
        + "CLI's next relative redraw depends on. The header chip is chrome and leaves no residue.");
});
```

Both spans use the `block()` helper already defined in this file (`:33-38`) — no second idiom.

**Edge cases.** Both spans were executed against HEAD before being written down: the `notifyInputDropped` span resolves to `"function notifyInputDropped(entry) {\n        refreshInputState(entry.name);"` (contains `refreshInputState(`, does not contain `term.write(`), and the `onData` span is 4,315 chars containing the `} else {` → `notifyInputDropped(entry);` sequence and no `inputQueue`. The `'\n    }'` end marker assumes the function's closing brace sits at four-space indentation, which is the file's uniform style; if `notifyInputDropped` ever grows a nested block closing at that indentation the span would truncate early — acceptable for a two-line function, and the `refreshInputState(` probe fails loudly if it ever does. The `onData` span's end marker `connectTerminalSocket(entry);` is the next statement after the handler; if a future edit inserts another `connectTerminalSocket(entry);` inside the handler the span shortens and the regex fails loudly rather than passing vacuously.

### `src/test/shell-terminal-strip.test.js` — assert convergence and ratchet the decision shut

**Context.** Lines 126-136, the `an agentCompleted for a name absent from fleetList triggers a refetch` test. Both `block()` markers resolve; only the first assertion's regex is stale — the second (ordering) passes and its intent must survive.

**Logic.** The `const isKnown = fleetList.some(…)` / `if (!isKnown)` conditional was replaced by an unconditional `fetchTerminalList()` on the badge path, justified by a second requirement the old form did not serve (the completion clear nulls `dispatched_at`, so the plan strip must retire in the same beat as the DONE badge). Git confirms both forms lived at the same nesting level inside `if (targetTerm)`, so for every scenario either form covered — including the one the test names — the new form is a superset. Re-anchor the assertion to convergence — a refetch is reached whenever a badge is placed — rather than to the vanished local, keep the badge-before-refetch ordering, and add a ratchet so the replacement cannot be quietly reverted.

**Implementation.**

```js
test('an agentCompleted badge always drives a refetch, so the strip converges', () => {
    const handler = block(terminalsJs, 'function handleAgentCompleted(msg) {', 'function showCompletionToast(');
    // This used to require `const isKnown = fleetList.some(...)` + `if (!isKnown) {`.
    // That conditional was deliberately replaced by an UNCONDITIONAL refetch on the
    // badge path (1bd39f4a): the completion clear has nulled dispatched_at, so the plan
    // strip must retire in the same beat as the DONE badge. Both forms sat INSIDE
    // `if (targetTerm)` (introduced there in ab384c01), so no path lost coverage — for
    // the case this test was written for, a name present in msg but absent from
    // fleetList, the new form is a strict superset. Pin CONVERGENCE (a badge implies a
    // refetch, in that order) rather than the vanished local.
    assert.ok(/terminalBadges\.set\(targetTerm[\s\S]*fetchTerminalList\(\)/.test(handler),
        'every badge placement must be followed by fetchTerminalList() so the strip converges — '
        + 'and in that order, or the relayed snapshot will not carry the badge');
    assert.ok(!/const isKnown\b/.test(handler),
        'the conditional refetch was replaced on purpose — do not reintroduce it');
});
```

The regex spans badge→refetch, so it carries the ordering requirement the old second assertion made explicitly; the second assertion is a ratchet that makes a regression back to the conditional form fail, so this design decision cannot be quietly reverted by a future tidy-up. If a reviewer prefers the ordering pinned separately, keep the original `indexOf` pair alongside the regex — both are acceptable; dropping the ordering entirely is not.

**Edge cases.** The regex will break if a future edit moves `fetchTerminalList()` above the badge write. That is the correct sensitivity — the ordering is the contract (badge, then converge). The `!targetTerm` path is out of scope (see the Superseded callout under run-step 80); if a future plan ever adds a refetch there, extend this test with a distinct assertion for that branch rather than loosening this one.

## Verification Plan

> **Session note.** These steps were **not executed** while authoring this pass — the improve session ran under explicit `SKIP COMPILATION` / `SKIP TESTS` directives. Every factual claim above was instead verified by reading source at HEAD, by `git show` on `ab384c01` / `1bd39f4a` / `886849ce`, and by executing the two proposed `block()` spans standalone against `src/webview/terminals.js`. The steps below are the implementer's contract and are unabridged: this plan's deliverable *is* three automated tests, so a verification plan without test runs would not verify it.

### Automated Tests

1. `npm run compile-tests` — **required before step 2 only.** `memo-browser-clear` loads `../../out/services/TaskViewerProvider`, so a stale `out/` makes its result meaningless. The other two tests read `src/` and do not need it.
2. `npm run test:contract:memo-browser-clear` — must report **17 passed, 0 failed** (currently 16/1 of 17).
3. `npm run test:contract:terminal-focus-affordance` — must report **12 passed, 0 failed** (currently 11/1 of 12).
4. `npm run test:contract:shell-terminal-strip` — must report **40 passed, 0 failed** (currently 39/1 of 40).
5. **Negative control per assertion — each re-authored contract must still be able to fail.** All three replace an assertion that was firing on correct code; the failure mode of the repair is one that can no longer fire at all. Test-block counts (17/12/40) do not move when an assertion inside a block is weakened, so these controls are the only real check. Run each, then **revert**:
   - *step 64, body shape:* make the arm's no-root branch return a bare `{ success: false }` (drop `type`/`error`). The test must fail on the untyped-body assertion.
   - *step 64, the lever:* restore a non-empty seam root (`{ roots: [tmpRoot] }`) while leaving the vscode stub empty. The test must fail on `success` — proving the seam half, not just the vscode half, is what now controls the branch.
   - *step 78, the prohibition:* add `entry.term.write('x');` inside `notifyInputDropped`. The test must fail on the buffer-write prohibition.
   - *step 78, the drop report:* delete the `notifyInputDropped(entry);` call at `terminals.js:7384` (leaving the function defined). The test must fail. **This one is the reason the probe was re-scoped** — against the old file-wide `includes()` it passed, which is how the tautology is demonstrated rather than argued.
   - *step 80, ordering:* move `fetchTerminalList()` above the `terminalBadges.set(...)` line. The test must fail on convergence ordering.
   - *step 80, the ratchet:* reintroduce `const isKnown = fleetList.some(t => t.friendlyName === targetTerm);`. The test must fail on the do-not-reintroduce assertion.
6. Confirm `git diff --name-only` lists **exactly three paths**, all under `src/test/`: `memo-browser-clear-and-copy-contract.test.js`, `terminal-focus-affordance-contract.test.js`, `shell-terminal-strip.test.js`. `TaskViewerProvider.ts`, `src/webview/terminals.js`, and `src/test/helpers/verbEngineTestSeams.js` must **not** appear.
7. `npm run parity:check`, `npm run push-routing:check`, `npm run verb-returns:check` — green (all verified green at HEAD; none read test files).

### Manual

8. None. No runtime path changes — the diff is test-only.

## Agent Recommendation

**Send to Coder** (complexity 5) — three independent design verdicts, each requiring a historical diff to be read before a line is written, against failure messages that all point confidently at innocent production code, plus one behavioural test that is meaningless without a compiled `out/`.

The reviewer should check five things:

1. The diff is **exactly three test files** — no `TaskViewerProvider.ts`, no `terminals.js`, no `verbEngineTestSeams.js`.
2. No removed implementation was restored: no `inputDropNoticed`, no `const isKnown`, no `term.write(` inside `notifyInputDropped`.
3. **All seven negative controls in step 5 were actually run**, with the specific mutation and the resulting failure message recorded. An assertion that can no longer fail looks exactly like one that passes, and this plan's own inherited probe was a live example.
4. Every span-sensitive probe is evaluated inside a `block()` span, not against the whole file — specifically the `term.onData` drop-report probe and the `notifyInputDropped` buffer-write prohibition.
5. The stale seam-first comment at `memo-browser-clear-and-copy-contract.test.js:68-70` was corrected. It is the false premise that produced run-step 64's failure; leaving it in place ships the bug's cause with the bug's fix.
