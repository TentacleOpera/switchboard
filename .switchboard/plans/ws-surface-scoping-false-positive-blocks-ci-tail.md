# A whole-file regex in the WS surface-scoping contract false-positives on a debug log

> **Superseded:** Title — "…false-positives on a debug log, turning the last 7 CI steps off".
> **Reason:** The trailing clause asserts a causal claim that measurement disproves. This step is run-step 94 of 101 and **six steps ahead of it are already red at HEAD**, the earliest at step 11, so CI halts long before reaching it. Repairing this assertion unblocks zero CI steps today. Leaving the clause in the title propagates the wrong causal model to every reader of the board card.
> **Replaced with:** The title states the defect only. The corrected severity — prospective, not accrued — is in "Blast radius" below.

## Goal

Repair the `the client does not double-filter` assertion in `src/test/ws-surface-scoping-contract.test.js` so it pins what it claims to pin — that `transport.js` never *branches* on the WS surface tag — instead of failing on any mention of `msg.surface` anywhere in the file. The assertion is red at HEAD on a diagnostic log line, and because it sits near the end of a 103-step workflow with no `continue-on-error`, it will halt the job before the **final 7 CI steps** — including `Lint` and `Run integration suite` — once the steps ahead of it are green.

### Problem Analysis

`src/test/ws-surface-scoping-contract.test.js:125-128` is a whole-file source-text assertion:

```js
test('the client does not double-filter', () => {
    assert.ok(!/msg\.surface/.test(transportJs),
        'a second client-side filter would only mask a producer mis-tag by making it look like a delivery problem');
});
```

The contract it is defending is real and worth defending: `wsHub.broadcast` already filters by surface per connection (`wsHub.ts`), so a *second* filter in the browser client would convert a producer mis-tag into what looks like a delivery problem — a panel that silently stops updating, which the test file's own header calls out as the failure class the whole file exists for.

But the assertion tests for the **presence of a substring**, not for a filter. `transport.js` has exactly one occurrence of `msg.surface`, at line 242:

```js
wsLog('frame', msg.type, 'seq=' + msg.seq, 'surface=' + (msg.surface || '<untagged>'));
```

That is a frame trace. It reads the tag and routes nothing — the unwrap immediately below it (`transport.js:244-250`) merges `msg.payload` with `msg.type` and dispatches unconditionally, exactly as the contract requires. The test cannot tell the two apart, so it reports a violation that does not exist.

Two supporting details confirm the diagnosis rather than merely fitting it:

- The other two `transportJs` assertions in the same file (`:109`, `:117`) are **block-scoped** — they extract `PANEL_SURFACES_MAP` and `wsUrl()` and assert within those. Line 126 is the only whole-file scan in the file, and it is the only one that broke.
- `git log -S"msg.surface" -- src/webview/transport.js` returns exactly one commit: `3b3c6367` ("multi-window cockpit reliability + reviewer gate repairs", Tue 2026-08-11). The log line and the red test arrived together, in a commit about diagnosing multi-window WS delivery.

**Verified at HEAD (2026-08-14):** `node src/test/ws-surface-scoping-contract.test.js` → `12 passed, 1 failed`, the single failure being `the client does not double-filter`. `grep -c "msg\.surface" src/webview/transport.js` → `1`, at line 242, inside a `wsLog(` call.

### Root Cause

A source-text contract written as a blanket substring ban over an entire file. The predicate `!/msg\.surface/` encodes "the string never appears", but the contract is "the value never drives control flow". Those diverge the moment anyone legitimately *observes* the value — which is precisely what a diagnostic does, and precisely what someone debugging surface routing will reach for first.

### Blast radius — prospective, not accrued

> **Superseded:** "The step is wired at `.github/workflows/integration-tests.yml:642` … Everything after line 642 is unreachable … Lint and the integration suite have not run in CI since `3b3c6367`. The failure is not 'one contract test is red' — it is 'the tail of the pipeline is dark, and the signal that would tell you is the same red X you have learned to attribute to the known-red test.'"
> **Reason:** Reasoned from workflow step ordering without checking what CI actually does. Three separate errors. (1) **CI never reaches this step.** `gh run list` shows every run for the last month failed, and the most recent (2026-08-10) halted at run-step 16 with ~88 steps skipped. At HEAD, **six steps are red before this one**, the earliest at step 11. Repairing this assertion unblocks nothing today. (2) **"Since `3b3c6367`" is wrong in both directions.** That commit is 2026-08-11 — three days before this plan, with exactly one commit since (`1bd39f4a`, unpushed) — not "months" and not "several commits' worth". And `Lint` last ran, and **passed**, on the 2026-07-27 run; the step that failed that run was `Run integration suite` (the last step), which was therefore already red three weeks *before* this regression existed. (3) **"The red X you have learned to attribute to the known-red test"** presumes observed red runs attributable to this test. No CI run has ever failed on this step.
> **Replaced with:** the measured account below. The defect is real and worth fixing; its severity is that it *will* halt the tail once the steps ahead of it are green, not that it does so now.

The step is wired as run-step **94 of 101** (`.github/workflows/integration-tests.yml:611` at HEAD; line 642 in the working tree, which carries 31 uncommitted lines of newly-added steps — cite the **step name**, not a line number, since both numbers are already stale). The workflow is a **single job** (`integration-tests`) with **zero** `continue-on-error` declarations, so GitHub Actions halts at the first failing step. Exactly **7** steps follow this one:

| Run-step | Blocked step |
| :--- | :--- |
| 95 | WS popout broadcast contract (stalled resync cannot orphan a connection) |
| 96 | Setup panel WS hydration contract (cached server, subscribe signal, re-request) |
| 97 | Project panel review mode (review buttons + popup/active-state CSS survive edits) |
| 98 | **Lint (TypeScript only)** |
| 99 | Paste attribution + clipboard copy contract |
| 100 | Dispatch-analysis scope + feature-atomicity contract |
| 101 | **Run integration suite** |

**What actually keeps that tail dark.** Measured at HEAD by running every step from 2 to 93 locally (compilation excluded — see Verification):

| Run-step | Command | Status | Character |
| :--- | :--- | :--- | :--- |
| 11 | `npm run mirror:check` | **RED** | `.claude/skills/delegates/SKILL.md` is committed but absent from the `MIRROR_MANIFEST` in `src/services/ClaudeCodeMirrorService.ts` (the string `delegates` appears nowhere in that file). The mirror file is committed and clean, so CI fails identically. **This is the first blocker.** |
| 64 | `test:contract:memo-browser-clear` | RED locally | 16/1. Failing assertion is *behavioural* (`the unresolvable-workspace failure is ROUTABLE and carries error`) and the file `require`s `../../out/services/TaskViewerProvider`. Local `out/` is stale (2026-07-17), so this one **may be a stale-build artifact**; unclassified until a fresh compile. |
| 65 | `test:contract:memo-workspace-binding` | **RED** | 10/1 — `memo.js sends the live root, not the load-time constant`. Source-text assertion over `src/webview/memo.js` (`clearTimeout` must precede `_wsRoot = msg.workspaceRoot`). Environment-independent. |
| 76 | `test:contract:terminal-pane-fit` | **RED** | 2 contracts failed — `end marker not found AFTER "function batchFitVisiblePanes(": const DEFAULT_ROLES`. **The same failure family as this plan**: a `block()` anchor that drifted out of the source. |
| 78 | `test:contract:terminal-focus-affordance` | **RED** | 11/1 — `the notice must reset on reconnect, or the second outage is silent`. |
| 80 | `test:contract:shell-terminal-strip` | **RED** | 39/1. |
| 94 | `test:contract:ws-surface-scoping` | **RED** | **This plan.** |

All other 75 of steps 13–93 pass, and gates 2–10 and 12 pass. So **at least five** steps (six counting the unclassified step 64) must go green before this repair changes anything a CI run does.

**Why nobody noticed.** The workflow triggers are `pull_request`, `workflow_dispatch`, and `schedule: '0 9 * * 1'` — **there is no `push` trigger**. Direct-to-main pushes (the intended workflow here) never run it, so the pipeline is exercised weekly, on Mondays. The last four scheduled runs each died at a different step (2026-07-20 at step 2 `catalog:check`; 07-27 at step 101; 08-03 at step 37 `verb-engine`; 08-10 at step 16 `pty-dispatch-focus`, since fixed in `3b3c6367`). The first blocker is a **moving target**, and this test is the newest entry in the queue, not its head. This is context for why the rot accumulated — **not** a recommendation to add a `push:` trigger; the direct-to-main bypass is intentional.

## Metadata

**Complexity:** 4
**Tags:** bugfix, test, devops, reliability
**Project:** Browser Switchboard

> **Superseded:** **Complexity:** 3 → "Send to Intern".
> **Reason:** The edit is still one file with no production changes, but the dominant failure mode is a *silently weakened* assertion that looks identical to success, and the repair now carries permanent self-test fixtures plus a hard scope fence against six adjacent red steps. A seat that drops the fixtures leaves the contract unguarded and green forever — the documented worst outcome — and dropped wiring is exactly what the lowest tier drops.
> **Replaced with:** **Complexity:** 4 → "Send to Coder".

## User Review Required

None.

## The one thing that will go wrong if you rush it

**Do not delete the `wsLog` line at `transport.js:242` to make the test pass.** It is the tempting one-character-cheaper fix and it is backwards. `wsLog` is opt-in behind `?wsdebug=1` or `localStorage['sb-debug-ws'] === '1'` (`transport.js:70-79`) and returns immediately when unset, so it costs nothing in normal operation. The frame trace *with its surface tag* is the exact instrument you reach for when a panel silently stops updating — the failure mode this entire test file exists to prevent. Removing the diagnostic to satisfy a regex deletes the tool you need on the day the contract is genuinely violated, and leaves the broken predicate in place to fire again on the next legitimate observation of the value.

**And do not fix the six red steps listed in Blast radius.** They are named here so the implementer is not surprised by them and does not mistake them for fallout from this edit. They belong to whichever changes introduced them and get their own plan (see Dependencies).

## Complexity Audit

### Routine

- One assertion body plus one predicate helper and one self-test, in one test file. No production code changes, no schema, no migration, no shipped state.
- The test is already wired into CI (run-step 94) and already has a `package.json` script (`test:contract:ws-surface-scoping`). No new wiring.
- The file is a plain `node` script with a local `test()` harness and `process.exit(1)` on failure — no framework, no fixtures, no async.

### Complex / Risky

- **Weakening is the failure mode, not breaking.** An over-relaxed predicate leaves the test permanently green and the contract unguarded, and nothing downstream would ever notice. The repair must still fail on a real filter — which is why the negative controls become permanent in-suite fixtures rather than a manual insert-and-revert ritual.
- **The scope fence is load-bearing.** Six steps ahead of this one are red. The implementer will see them the moment they run anything broader than the single script, and absorbing even one turns a one-file test repair into an unreviewable sprawl.

> **Superseded:** "The fix unblocks 7 steps that have not run in months. Landing the assertion repair is the easy half; the newly-reachable steps may themselves be red…" and "`Lint` … has not gated a merge since `3b3c6367`, so it may have accumulated violations from several commits' worth of unlinted work."
> **Reason:** Both rest on the disproved premise that this step is what CI halts on. It unblocks nothing until steps 11/65/76/78/80 are green, so nothing becomes "newly reachable" from this change alone. And `Lint` ran and passed on the 2026-07-27 scheduled run — three weeks of commits, not "months", and not unlinted since `3b3c6367`.
> **Replaced with:** the two risks above. The tail is still worth running locally (Verification steps 5–6), but as reconnaissance, not as this change's consequence.

## Edge-Case & Dependency Audit

- **Multi-line filters must still be caught.** A filter spelled across lines — `if (msg.surface &&\n    !mySurfaces.has(msg.surface)) return;` — has its opening line containing `msg.surface` and *not* containing `wsLog(`, so the line-scoped form below fails it on the opener. This is asserted, not assumed: it is fixture case 2 in the predicate self-test.

- **Accepted residual: same-line smuggling.** A filter written on the same physical line as a `wsLog(` call (`wsLog('frame', msg.type); if (msg.surface !== s) return;`) would pass the allowlist. This is accepted deliberately: closing it means either balanced-paren parsing of the call expression or enumerating filter shapes (`if`/`return`/`&&`/`?`), and shape-enumeration is the same class of brittleness that produced this bug. One statement per line is already the file's uniform style and the repo lints TypeScript, so the smuggling shape is not a realistic accident.

- **Accepted residual: prose mentioning `msg.surface` fails too.** The ban stays total, so a comment in `transport.js` that spells `msg.surface` is reported as an offender. This is intentional — a second carve-out for comments widens the exemption surface for no present need — and it is encoded as fixture case 6 so the behaviour is documented rather than discovered. If it ever bites, the fix is to write "the surface tag" in prose; the failure message names the exact line, so it costs seconds. No current comment in `transport.js` trips it (the unwrap comment at `:244-245` says "type/seq/payload/surface", not `msg.surface`).

- **Do not switch to a filter-shaped regex.** The obvious alternative — `!/if\s*\([^)]*msg\.surface/` — is worse in both directions: it misses `const skip = msg.surface && !set.has(msg.surface);` (a filter with no `if`), and the existing log line already contains `||`, so any operator-based variant re-breaks on line 242. Allowlisting the diagnostic and banning everything else inverts the fragility correctly. Both of those shapes are fixture cases 1 and 3, so a future "simplification" back to a shape-regex fails the suite.

- **Failure output must name the offender.** The current assertion prints only its rationale, which is why the failure read as an unexplained regression rather than "line 242 is a log". The repaired form must include the offending line number and text, so the next person spends seconds rather than the archaeology this one took.

- **The wiring is as weakenable as the predicate.** Fixtures prove `surfaceBranchOffenders` works; they do not prove the real assertion still passes it `transportJs`. A repair that reads a fixture instead of the file would pass the whole suite. One live negative control against the real `transport.js` (Verification step 2) is what pins the wiring; the fixtures pin the logic. Both are needed — they cover different failure modes.

- **Scope of the surrounding file.** Only line 126 scans the whole file; `:109` and `:117` are block-scoped via the local `block()` helper and are unaffected. No other assertion in the file reads `transportJs`.

- **Test count changes.** The file goes from 13 tests to 14 (the predicate self-test is a new `test()` call). Expected result is `14 passed, 0 failed`.

- **Security / behaviour.** None. No production file changes, no runtime path, no network surface. `wsLog` remains gated behind an explicit debug opt-in.

- **Dependencies & conflicts.** `transport.js` is untouched by this plan, so this does not serialise against any browser-cockpit stream. The gates (`parity:check`, `push-routing:check`, `verb-returns:check`) do not read test files and are verified green at HEAD.

## Dependencies

- None to land this change.
- **Blocks-on for the CI outcome (not for the edit):** the tail cannot execute in CI until run-steps 11, 65, 76, 78, 80 — and 64, once classified — are green. No plan file owns those yet; one should be created (see Agent Recommendation). Landing this repair without them is still correct: it removes a real defect and takes this step out of the queue permanently.

## Adversarial Synthesis

**Risk Summary.** The tempting fixes are both wrong in the same direction: deleting the log line trades a zero-cost diagnostic for a broken predicate that will fire again, and relaxing the predicate to a filter-shaped regex swaps a false positive for a false negative that nobody will ever see. The repair keeps the ban total, carves out exactly one provably-inert construct — a `wsLog` line — and pins the predicate against fixtures in-suite so a silently-weakened form fails the build instead of relying on a reviewer's memory of a reverted experiment. The genuine risk is no longer "the newly-reachable steps may be red" but the opposite: the plan originally claimed a CI outcome it cannot produce, since six steps ahead of this one are already red and CI halts at step 11. Land the repair on its own merits, report the six as reconnaissance, and let them get their own plan — absorbing them here hides their causes and makes this change unreviewable.

## Proposed Changes

### `src/test/ws-surface-scoping-contract.test.js` — scope the ban to non-diagnostic lines, and pin the predicate

**Context.** Lines 125-128, the only whole-file assertion in the file.

**Logic.** Keep the ban total, allowlist exactly one inert construct, report the offender, and self-test the predicate so a weakened form is caught by the suite rather than by a reviewer. Extract the predicate to a named function so the real check and the fixtures share one implementation — two copies would drift and the fixtures would stop guarding anything.

**Implementation.**

> **Superseded:** the original single-`test()` implementation, whose guard against a weakened predicate lived entirely in Verification steps 2-3 as manual insert-into-`transport.js`-then-revert negative controls.
> **Reason:** Those controls leave no artifact, cannot be verified by a reviewer (the plan's own Agent Recommendation reduced to "the reviewer must check that they were actually run"), and evaporate the instant they are reverted — so the repair's dominant failure mode, a silently over-relaxed predicate, is guarded by nothing durable. A green metric is not a substitute for the check.
> **Replaced with:** the predicate extracted to `surfaceBranchOffenders()` and exercised against inline fixtures in a permanent `test()`, so every future CI run re-proves the predicate can still fail. The live-file negative control survives as one step (it pins the *wiring*, which fixtures cannot).

```js
// The contract is that transport.js never BRANCHES on the surface tag: wsHub.broadcast
// already filtered per connection, so a second client-side filter would only mask a
// producer mis-tag by making it look like a delivery problem — a panel that silently
// stops updating, which is the failure class this whole file exists for.
//
// This used to be a whole-file `!/msg\.surface/`, which cannot tell a filter from a
// diagnostic. It went red the day a frame trace started printing the tag
// (transport.js:242, commit 3b3c6367) — a log line that READS the value and routes
// nothing.
//
// Line-scoped allowlist, not a filter-shaped regex: enumerating filter shapes
// (`if (`, `&&`, `?`) is the same brittleness that caused this bug, and would miss
// `const skip = msg.surface && ...` anyway. Every mention must sit on a wsLog() line;
// everything else fails, including a multi-line filter, whose `if (msg.surface &&`
// opener is itself a non-wsLog line.
function surfaceBranchOffenders(src) {
    return src
        .split('\n')
        .map((text, i) => ({ text, no: i + 1 }))
        .filter(({ text }) => text.includes('msg.surface') && !/wsLog\(/.test(text));
}

// The dominant failure mode of this repair is not breaking — it is a silently WEAKENED
// predicate that stays green forever while the contract goes unguarded, and nothing
// downstream would ever notice. So the predicate is pinned against fixtures here, in
// the suite, instead of by a reviewer remembering that someone once hand-inserted a
// filter into transport.js and reverted it.
test('the surface-branch predicate still catches a real filter', () => {
    const cases = [
        ["if (msg.surface && msg.surface !== 'kanban') { return; }", 1,
            'single-line if filter'],
        ["if (msg.surface &&\n    !mySurfaces.has(msg.surface)) { return; }", 2,
            'multi-line filter — the opener is itself a non-wsLog line, so both lines report'],
        ['const skip = msg.surface && !mySurfaces.has(msg.surface);', 1,
            'a filter with no `if` — the shape any filter-shaped regex misses'],
        ["const s = msg.surface ? msg.surface : 'common';", 1,
            'ternary read'],
        ["    wsLog('frame', msg.type, 'seq=' + msg.seq, 'surface=' + (msg.surface || '<untagged>'));", 0,
            'the diagnostic at transport.js:242 is the one allowed construct'],
        ['// msg.surface is filtered by the hub, never here', 1,
            'prose fails too: the ban is total by design — write "the surface tag" instead'],
    ];
    cases.forEach(([src, expected, why]) => {
        assert.strictEqual(surfaceBranchOffenders(src).length, expected,
            `predicate regression (${why}) — expected ${expected} offender(s)`);
    });
});

test('the client does not branch on the surface tag', () => {
    const offenders = surfaceBranchOffenders(transportJs);
    assert.strictEqual(offenders.length, 0,
        'transport.js must not branch on msg.surface — the hub already filtered, and a '
        + 'second client-side filter would only mask a producer mis-tag by making it look '
        + 'like a delivery problem. Offending line(s): '
        + offenders.map(o => `${o.no}: ${o.text.trim()}`).join(' | '));
});
```

**Edge cases.** The test name changes from `the client does not double-filter` to `the client does not branch on the surface tag` — nothing greps for test names in this repo (the harness is a local `test()` function, not a runner with `--grep`), and the new name states the actual predicate. `assert.strictEqual` on a count rather than `assert.ok` on a boolean is what makes the offending line appear in the failure text. `surfaceBranchOffenders` is a file-local function declaration alongside the existing `block()` helper; place it directly above the two tests, not at the top of the file, so the comment block sits with what it explains.

## Verification Plan

Per session directive, no compilation step is included; the previously-listed `npx tsc -p tsconfig.test.json --noEmit` is dropped (it is a compile step, and it typechecks nothing relevant to a plain-JS test edit). Note that this leaves run-step 64 unclassified — see step 6.

### Automated

1. `npm run test:contract:ws-surface-scoping` — must report **14 passed, 0 failed** (currently 12/1; the count rises from 13 because the predicate self-test is a new `test()`).

   > **Superseded:** "must report **13 passed, 0 failed**".
   > **Reason:** correct for the original single-test implementation; the added predicate self-test makes the file 14 tests.
   > **Replaced with:** 14 passed, 0 failed.

2. **Live negative control — the assertion must be wired to the real file.** The fixtures in step 1 prove the predicate can fail; they cannot prove the assertion still reads `transportJs`. Temporarily insert a real filter into `transport.js` immediately above the unwrap at `:244`:
   ```js
   if (msg.surface && msg.surface !== 'kanban') { return; }
   ```
   Re-run: the test must fail and the message must name that line number. **Revert the edit.** Run this once; it is the only manual control that remains, and the fixtures carry the rest permanently.
3. `npm run parity:check`, `npm run push-routing:check`, `npm run verb-returns:check` — unchanged and green. All three verified green at HEAD before this change; no production file is touched and none of them read test files.

### Reconnaissance — what the dark tail says

This section is information-gathering, **not** a consequence of this change. Repairing run-step 94 does not make CI reach run-step 95; six earlier steps must go green first (Blast radius).

4. Run the 7 steps that follow this one, locally, in workflow order:
   ```
   npm run test:contract:ws-popout-broadcast
   npm run test:contract:setup-panel-ws-hydration
   node src/test/project-panel-review-mode.test.js   # invoked directly in CI; has no npm script
   npm run lint
   npm run test:contract:paste-attribution
   npm run test:contract:dispatch-analysis-scope
   npm run test:integration:all
   ```
   Note `test:integration:all` was already the failing step on the 2026-07-27 scheduled CI run, so a red result there is pre-existing and three weeks old, not fallout.
5. **Report every result, green or red, in the completion report** — including the six earlier red steps from Blast radius, restated so the next plan can pick them up.
6. **Classify run-step 64.** `test:contract:memo-browser-clear` fails locally on a behavioural assertion while loading `../../out/services/TaskViewerProvider` from a stale `out/` (2026-07-17). A fresh compile decides whether it is a real failure or a build artifact. Compilation is out of scope for this plan per session directive — record it as unclassified and hand it to the companion plan rather than guessing.
7. **Nothing found in steps 4-6 gets fixed here.** Those failures belong to whichever change introduced them; absorbing them turns a one-file test repair into an unreviewable sprawl and hides their real cause. By construction none of them can be caused by this edit, since no production file changes.

### Manual

8. Open the browser cockpit with `?wsdebug=1`, move a card on the Board, and confirm the console still prints `[transport:ws] frame updateBoard seq=N surface=kanban` — i.e. the diagnostic this plan refused to delete still works.

## Agent Recommendation

**Send to Coder** (complexity 4) — the edit is small and fully specified, but two things make the lowest tier the wrong fit: the failure mode is a silently-weakened assertion that looks identical to success, and the scope fence against six adjacent red steps has to hold under the temptation of a nearly-green pipeline.

The reviewer should check three things: that `surfaceBranchOffenders` is shared by the fixtures and the real assertion (two copies would drift and the fixtures would stop guarding anything); that all six fixture cases are present with the stated expected counts; and that no production file appears in the diff.

**Companion plan needed.** Run-steps 11, 65, 76, 78, 80 (and 64, pending classification) are red at HEAD and block CI from ever reaching this step. Two of them are worth calling out as a pattern rather than six unrelated bugs: run-step 76 (`terminal-pane-fit`) fails on a drifted `block()` end-marker, which is the **same failure family** as the bug this plan fixes — source-text contracts silently rotting against legitimate edits — and run-step 11 (`mirror:check`) is the known host-split manifest trap, `.claude/skills/delegates/SKILL.md` committed without a matching `MIRROR_MANIFEST` entry in `src/services/ClaudeCodeMirrorService.ts`. Create that plan after this one lands.
