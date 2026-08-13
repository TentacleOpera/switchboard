# Dispatch-Surface Ratchet — Stop `apiOriginated` Growing Back

## Goal

Add `scripts/check-dispatch-surface.js`, wire it as `npm run dispatch-surface:check` and add a CI step, so the caller-surface dispatch flag cannot be reintroduced. `delete-allowptyfleet-resolve-terminals-by-name.md` deleted the flag from the dispatch path across nine files and named this ratchet as Automated verification item 11 — the deletion landed, the ratchet did not.

### Problem analysis and root cause

**What was deleted.** The caller-surface flag answered "what kind of client is calling?" and selected the terminal set from the answer. It was replaced by name-based resolution: `TaskViewerProvider._pickTerminalCandidate` states one precedence rule (live-first, fleet-wins-among-equals) and the three role-matching scans hand their candidates to it. Nothing in the dispatch path reads a caller surface any more.

**Why the deletion is fragile without a gate.** The flag's failure mode was a *silent positive*: drop it at any hop and the dispatch resolves a `vscode.Terminal`, delivers, and returns `true` — no error, no log, no UI signal. That is why it survived so long and why `ea1077da` "fixed" it by adding one more forwarding site to a shape that manufactures forwarding sites. The shape is gone, but the pressure that created it is not: the next person who needs a browser-only behaviour has an obvious-looking move available (thread a boolean), and nothing in the build objects.

**Root cause in one line:** the deletion's success criterion was "grep returns nothing today", and nothing converts that into "grep returns nothing tomorrow".

### ⚠ Scope correction — `allowPtyFleet` is NOT banned and must NOT be in the zero-check

**Verified against the working tree on 2026-08-14.** This plan previously specified a guard asserting *zero* occurrences of **both** `apiOriginated` **and** `allowPtyFleet` outside three allowlisted lines. That specification is wrong and a guard written to it fails on the unmodified tree — the plan's own verification item 3 contradicts its Proposed Changes.

`allowPtyFleet` is a **live, load-bearing, intentional API** on the terminal-pool resolver. It survives at four non-test source sites, all deliberate:

| Site | What it is |
|---|---|
| `src/services/TaskViewerProvider.ts:6020` | `getRoleTerminalSet(role, workspaceRoot, opts?: { allowPtyFleet?: boolean })` — public signature |
| `src/services/TaskViewerProvider.ts:8994` | `_getAliveAutobanTerminalRegistry(workspaceRoot, opts?: { allowPtyFleet?: boolean })` |
| `src/services/TaskViewerProvider.ts:9029` | `const isPtyRow = opts?.allowPtyFleet && this._isFleetTerminalInfo(info);` — the PTY-liveness branch |
| `src/services/KanbanProvider.ts:5840` | `getRoleTerminalSet('planner', workspaceRoot, { allowPtyFleet: true })` — the one caller, **unconditional** |

Four contract tests **assert these exact shapes are present**: `browser-planner-dispatch-surface.test.js:148` (the `getRoleTerminalSet` signature *with* `opts?: { allowPtyFleet?: boolean }`), `:151` (the registry signature), `:157` (the `isPtyRow` gate), and `:184` (the `{ allowPtyFleet: true }` call site). A zero-check on this identifier does not merely fail — the obvious "fix" under time pressure is to delete the parameter, which breaks four asserting tests and re-collapses a whole grid of planner terminals onto one. The 10-line comment at `KanbanProvider.ts:5831-5839` exists specifically to warn the next person off that edit, and names the consequence: the standalone host, where PTY is the only fleet, goes permanently empty.

**The real distinction the guard must encode.** What was deleted was `allowPtyFleet` **threaded as a caller-surface signal through the dispatch path** — `_dispatchExecuteMessage`'s sixth argument, `dispatchCustomPromptToRole`, `_resolveAgentTerminalForPlan`, the airlock path. What survives is `allowPtyFleet` **as an opt-in on the pool resolver, set unconditionally by its single caller**. The first is banned; the second is the intended API. A per-file expected-count check distinguishes them; a global zero-check cannot.

**Therefore this guard bans `apiOriginated` only**, and pins `allowPtyFleet` to an exact per-file count so that *growth* is caught while the four legitimate sites are preserved. The identifier rename in this plan's title reflects that.

### ⚠ Correction — the arity claim was wrong in two ways

This plan previously stated that no existing test asserts the positional arity the dead slots protect, and that both commands declare seven parameters. Both are wrong:

1. **`src/test/dispatch-analysis-scope-contract.test.js:173-193` already asserts it** — "both host registrations declare analysisScope as the 7th positional" walks the parameter order in `extension.ts` *and* `standalone/bootstrap.ts` for `triggerBatchAgentFromKanban`. The **batch** command's arity is already gated in both hosts.
2. **The single-card command declares EIGHT parameters, not seven.** `extension.ts:1653` is `(role, sessionId, instruction?, workspaceRoot?, targetTerminalOverride?, _apiOriginated?, bypassTriggerGate?, unattended?)`. An assertion written for "seven ending `_apiOriginated?, bypassTriggerGate?`" fails on the unmodified tree.

So the genuinely missing arity coverage is exactly one thing: **`switchboard.triggerAgentFromKanban` in `extension.ts`**, whose `_apiOriginated` slot protects `bypassTriggerGate` and `unattended`, and which no test covers. That is what this guard adds. The batch assertion is already carried by the contract test — do not duplicate it; reference it in the script header instead.

### The allowlist is five lines of prose plus three registrations

`apiOriginated` survives at eight non-test source lines, not three:

| Line | Kind |
|---|---|
| `src/extension.ts:1653` | **dead-slot registration** (single-card) |
| `src/extension.ts:1676` | **dead-slot registration** (batch) |
| `src/standalone/bootstrap.ts:842` | **dead-slot registration** (batch, standalone) |
| `src/extension.ts:1647` | comment explaining the slot |
| `src/extension.ts:1673` | comment explaining the slot |
| `src/standalone/bootstrap.ts:838` | comment explaining the slot |
| `src/services/TaskViewerProvider.ts:4875` | comment — "replaces the old apiOriginated gate" |
| `src/services/KanbanProvider.ts:5837` | comment — inside the `allowPtyFleet` rationale block |

A scan that excludes only `src/test/**` still sees five comment occurrences in shipped source. Either strip line comments before counting, or use per-file exact expected counts. **Prefer per-file exact counts** — it is the same shape as `check-push-routing.js`, it needs no comment parser, and it catches a fourth occurrence appearing in an already-allowlisted file, which allowlisting by filename would admit.

### Why a text ratchet, not an AST guard

No existing guard in `scripts/` parses TypeScript. `check-push-routing.js`, `check-verb-return-contract.js`, `check-protocol-parity.js`, `check-standalone-push-parity.js` and `check-claude-mirror.js` are all text/regex ratchets over source. The target here is *per-file occurrence counts of one identifier* plus *one arity assertion*, which a text scan answers exactly. An AST walk would add a parse step, a new top-level dependency and a novel pattern to buy nothing. Model this script directly on `scripts/check-push-routing.js`.

*(Retracted: this plan previously flagged `typescript` as absent from `package.json` and a latent CI break. It is present — `devDependencies.typescript: ^5.9.3`. There is no such break; the note has been removed rather than carried forward.)*

## Metadata

**Tags:** test, reliability, backend
**Complexity:** 3
**Project:** Browser Switchboard

## User Review Required

None.

## Complexity Audit

### Routine
- Copying the shape of `scripts/check-push-routing.js`: per-file occurrence counts against a declared baseline, ceilings that only ratchet down, non-zero exit on breach.
- Adding the `package.json` script and the CI step next to `push-routing:check`.

### Complex / Risky
- **The baseline table is load-bearing and must be per-file exact, not nominal.** Allowlisting `extension.ts` wholesale lets a *fourth* `apiOriginated` occurrence appear in that file undetected — the very reintroduction the gate exists to exclude. Exact counts per file, and the guard must fail on **greater than** the baseline while reporting **less than** as an improvement to be locked in.
- **`allowPtyFleet` must be pinned, not banned** (see the scope correction above). Its baseline is 3 in `TaskViewerProvider.ts` and 1 in `KanbanProvider.ts`, and the script header must state why deleting them is wrong, so a future reader does not "improve" the count to zero. This is the inverse of a normal ratchet and the one place the guard needs a comment more than an assertion.
- **The arity assertion catches a hazard the occurrence count cannot.** A cleanup that deletes the dead slot produces no compile error — `executeCommand` is untyped through the command-registry seam — and slides `bypassTriggerGate` into slot 6. The occurrence count goes *down* while the bug goes in. Assert the single-card registration in `extension.ts` still declares `_apiOriginated?` followed by `bypassTriggerGate?` followed by `unattended?`; the batch equivalents are already covered by `dispatch-analysis-scope-contract.test.js`.
- **False positives on prose.** The identifier appears in five comments in shipped source and throughout `src/test/**`. Per-file exact counts handle both; a naive zero-check handles neither.

## Edge-Case & Dependency Audit

**Race Conditions** — none; this is a static script.

**Security** — none. The guard reads source and exits non-zero.

**Side Effects**
- A new CI step. If it is authored to pass against the current tree without ever being seen to fail, it guards nothing — the same "green while incomplete" hole this plan exists to close.

**Dependencies & Conflicts**
- `package.json` and `.github/workflows/integration-tests.yml` are shared with other gate-adding plans — serialise edits. Insert after the `Push-routing ratchet (Gap A)` step at workflow line 37-38.
- Does not touch any provider file, so it parallelises freely against provider work.
- The sibling subtask (*Finish the `advanceCards` Extraction*) edits `scripts/check-kanban-dispatch-callers.js` only, and changes no `package.json` entry — that script is already wired. **No file overlap with this plan beyond the workflow file.**

## Dependencies

None. `delete-allowptyfleet-resolve-terminals-by-name.md` has landed.

## Adversarial Synthesis

**Risk Summary.** The dominant risk was, until this revision, in the plan itself: a specification that bans an identifier the codebase legitimately depends on, whose "obvious fix" deletes a load-bearing parameter and re-collapses the planner terminal grid. That is now corrected, and the correction is the plan's main content — a guard is only as good as the thing it is told to assert.

The remaining risks are the ordinary ones. First, a guard that cannot fail: authored against the current tree, passing on the first run, never demonstrated to catch a reintroduction. Second, an allowlist that is too coarse — by file rather than by count — so a genuine reintroduction in `extension.ts` is admitted by the very mechanism meant to exclude it. Third, the inverse failure: a scan that includes `src/test/**` or comment prose fails immediately on the contract tests and the dead-slot comments, and the fix under time pressure is to loosen the pattern until it stops complaining.

Mitigations: prove the guard red both ways before wiring it; count per file with exact expected values; and pin the scan scope and the `allowPtyFleet`-is-intentional rationale in the script's header comment so a later loosening is visible as a diff.

## Proposed Changes

### `scripts/check-dispatch-surface.js` (new)
- **Context:** No gate exists for the deleted caller-surface flag. Modelled on `scripts/check-push-routing.js`.
- **Logic:**
  1. Scan `src/**/*.ts`, `src/**/*.js` and `src/webview/**`, excluding `src/test/**`.
  2. **`apiOriginated` — per-file exact baselines.** `src/extension.ts`: 4 (2 registrations + 2 comments). `src/standalone/bootstrap.ts`: 2 (1 registration + 1 comment). `src/services/TaskViewerProvider.ts`: 1 (comment). `src/services/KanbanProvider.ts`: 1 (comment). Every other file: 0. Fail on any count **above** its baseline, naming the file and the offending line; report a count **below** baseline as an improvement to lock in.
  3. **`allowPtyFleet` — pinned, not banned.** `src/services/TaskViewerProvider.ts`: 3. `src/services/KanbanProvider.ts`: 1. Every other file: 0. Header comment must state that these four are the intended pool-resolver API, that four contract tests assert their presence, and that lowering them to 0 re-collapses the planner terminal grid.
  4. **Arity assertion (the half no test covers).** In `src/extension.ts`, the `switchboard.triggerAgentFromKanban` registration must declare `_apiOriginated?` immediately followed by `bypassTriggerGate?` and then `unattended?`. Walk the parameter names in order, as `dispatch-analysis-scope-contract.test.js:180-186` does. Do **not** re-assert the batch registrations — that test already covers both hosts; reference it by path in the header.
  5. Exit non-zero with the offending file, line and identifier.
- **Edge Cases:** Baselines are line **occurrence** counts, not line numbers — line numbers have already drifted once and must not be hardcoded. The webview bundle may still *send* `apiOriginated` from an older cached build; that is harmless (`validateVerbPayload` ignores undeclared fields) and the scan covers source, not shipped browser caches. Do not add an assertion that would fail on a stale browser build.

### `package.json` + `.github/workflows/integration-tests.yml`
- **Logic:** Add `"dispatch-surface:check": "node scripts/check-dispatch-surface.js"` next to `"push-routing:check"` (currently `package.json:890`), and a CI step immediately after the `Push-routing ratchet (Gap A)` step (workflow lines 37-38), with a comment naming the failure mode it guards (silent-positive dispatch into an invisible terminal).

## Verification Plan

*Compilation and automated test execution are out of scope for this planning pass; the items below are the acceptance criteria for the implementing agent.*

### Automated
1. **The guard passes on the unmodified tree.** With the baselines above, a clean checkout is green. Any red here means a baseline was miscounted — re-count, do not loosen the pattern.
2. **The occurrence half fails.** Temporarily add `apiOriginated?: boolean` to one wrapper in `TaskViewerProvider.ts`, run `npm run dispatch-surface:check`, confirm non-zero exit naming that file and line, then revert. Record the observed failure output in the completion summary.
3. **The occurrence half fails inside an allowlisted file.** Temporarily add a fourth `apiOriginated` occurrence to `src/extension.ts`, confirm the guard still fails — this is the assertion that per-file counts buy over filename allowlisting.
4. **The arity half fails independently.** Temporarily delete the `_apiOriginated` slot from `extension.ts:triggerAgentFromKanban`, confirm the guard fails on arity even though the occurrence count went *down*, then revert.
5. **The `allowPtyFleet` pin holds in both directions.** Adding a fifth occurrence fails; the four legitimate sites pass untouched. Confirm `browser-planner-dispatch-surface.test.js` still passes — if the guard and that test ever disagree, the guard is wrong.
6. The guard does not false-positive on `src/test/**`, on the five dead-slot/rationale comments, or on the three registrations.
7. Existing gates stay green: `catalog:check`, `parity:check`, `push-routing:check`, `standalone-parity:check`, `standalone-fork:check`, `kanban-dispatch-callers:check`, `verb-returns:check`, full `test:contract:*`.

### Manual
1. Confirm the CI step appears in the workflow and runs on a pull request.

## Recommendation

Complexity 3 → **Send to Intern Coder.** A single new text-ratchet script modelled line-for-line on an existing one, plus two wiring edits. The judgement calls — allowlist granularity, and which identifier is actually banned — are now both settled in the plan text. The two things that must not be skipped: verification item 2 (a ratchet never seen to fail is not a ratchet) and verification item 5 (the `allowPtyFleet` pin is a *floor*, not a target; anyone who "improves" it to zero breaks four tests and the standalone host).
