# Dispatch-Surface Ratchet — Stop `apiOriginated` / `allowPtyFleet` Growing Back

## Goal

Add `scripts/check-dispatch-surface.js`, wire it as `npm run dispatch-surface:check` and add a CI step, so the caller-surface dispatch flag cannot be reintroduced. `delete-allowptyfleet-resolve-terminals-by-name.md` deleted the flag from 164 source lines across nine files and named this ratchet as Automated verification item 11 — the deletion landed, the ratchet did not.

### Problem analysis and root cause

**What was deleted.** The `apiOriginated` / `allowPtyFleet` pair answered "what kind of client is calling?" and selected the terminal set from the answer. It was replaced by name-based resolution: `TaskViewerProvider._pickTerminalCandidate` states one precedence rule (live-first, fleet-wins-among-equals) and the three role-matching scans hand their candidates to it. Nothing in the dispatch path reads a caller surface any more.

**Why the deletion is fragile without a gate.** The flag's failure mode was a *silent positive*: drop it at any hop and the dispatch resolves a `vscode.Terminal`, delivers, and returns `true` — no error, no log, no UI signal. That is why it survived so long and why `ea1077da` "fixed" it by adding one more forwarding site to a shape that manufactures forwarding sites. The shape is gone, but the pressure that created it is not: the next person who needs a browser-only behaviour has an obvious-looking move available (thread a boolean), and nothing in the build objects. Verified in the working tree on 2026-08-10, the identifier survives at exactly three deliberate sites — the `_apiOriginated` **dead positional slots** in `extension.ts` (two command registrations) and `standalone/bootstrap.ts` (one) — each carrying a comment explaining that closing the slot up would silently slide `bypassTriggerGate` / `analysisScope` into it. Those three are the allowlist; everything else must be zero.

**Why the existing tests are not the gate.** Four CI-wired contract tests were updated in place rather than retired, and three of them do assert absence — `browser-stray-dispatch-surface.test.js` has *"no apiOriginated parameter or variable remains in TaskViewerProvider"*, and `browser-planner-dispatch-surface.test.js` asserts the 3-arg `dispatchCustomPromptToRole` form. But each is scoped to one file and one shape. None of them covers `KanbanProvider`, `PlanningPanelProvider`, `DesignPanelProvider`, `TicketsPanelProvider`, `LocalApiServer`, `verbSchemas` or the webview bundle, and none asserts the positional arity that the dead slots exist to protect. A reintroduction in any of those six files is invisible to the current suite.

**Root cause in one line:** the deletion's success criterion was "grep returns nothing today", and nothing converts that into "grep returns nothing tomorrow".

### Why a text ratchet, not an AST guard

No existing guard in `scripts/` parses TypeScript. `check-push-routing.js`, `check-verb-return-contract.js`, `check-protocol-parity.js`, `check-standalone-push-parity.js` and `check-claude-mirror.js` are all text/regex ratchets over source. The target here is *zero occurrences of two identifiers outside a named allowlist* plus *two arity assertions*, which a text scan answers exactly. An AST walk would add a parse step, a new top-level dependency and a novel pattern to buy nothing. Model this script directly on `scripts/check-push-routing.js`.

Separately and independently of this guard: `typescript` is in neither `dependencies` nor `devDependencies` at HEAD and resolves only as a transitive hoist, while `npm run compile-tests` invokes `tsc`. That is a latent CI break. Flag it; do not let it gate this change.

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
- **The allowlist is load-bearing and must be positional, not just nominal.** Three `_apiOriginated` sites are deliberate dead slots. Allowlisting them by filename alone lets a *fourth* occurrence appear in the same file undetected. Match on the specific registration line, or count per file with an exact expected count.
- **The arity assertion is the half that catches the real hazard.** A future cleanup that deletes the dead slot is exactly the change the comments warn about, and it produces no compile error — `executeCommand` is untyped through the command-registry seam. The guard must assert both registrations still declare seven parameters in both hosts, and that `bypassTriggerGate` / `analysisScope` are the seventh.
- **False positives on prose.** The identifiers appear in comments and in plan/doc files. Scope the scan to `src/**` source and exclude `src/test/**` (the contract tests legitimately name the identifier in their assertion strings), or the guard fails on its own documentation.

## Edge-Case & Dependency Audit

**Race Conditions** — none; this is a static script.

**Security** — none. The guard reads source and exits non-zero.

**Side Effects**
- A new CI step. If it is authored to pass against the current tree without ever being seen to fail, it guards nothing — the same "green while incomplete" hole this plan exists to close.

**Dependencies & Conflicts**
- `package.json` and `.github/workflows/integration-tests.yml` are shared with every other gate-adding plan — serialise edits.
- Does not touch any provider file, so it parallelises freely against provider work.

## Dependencies

None. `delete-allowptyfleet-resolve-terminals-by-name.md` has landed.

## Adversarial Synthesis

**Risk Summary.** The dominant risk is a guard that cannot fail: authored against the post-deletion tree, passing on the first run, never demonstrated to catch a reintroduction. The second is an allowlist that is too coarse — allowlisting `extension.ts` wholesale rather than the two specific registration lines means a genuine reintroduction in that file is admitted by the very mechanism meant to exclude it. The third is the inverse failure: a scan that includes `src/test/**` or comment text fails immediately on the contract tests that legitimately name the identifier, and the fix under time pressure is to loosen the pattern until it stops complaining. Mitigations: prove the guard red by temporarily reintroducing the parameter at one call site before wiring it; allowlist by exact line, not by file; and pin the scan scope explicitly in the script's header comment so a later loosening is visible as a diff.

## Proposed Changes

### `scripts/check-dispatch-surface.js` (new)
- **Context:** No gate exists for the deleted flag. Modelled on `scripts/check-push-routing.js`.
- **Logic:** Scan `src/**/*.ts`, `src/**/*.js` and `src/webview/**` excluding `src/test/**`. Count occurrences of `apiOriginated` and `allowPtyFleet` per file. Assert every file is 0 except the three allowlisted dead-slot lines, matched on their exact registration text with the reason inline. Then assert positional arity: `switchboard.triggerAgentFromKanban` declares seven parameters ending `_apiOriginated?, bypassTriggerGate?` in `extension.ts`, and `switchboard.triggerBatchAgentFromKanban` declares seven ending `_apiOriginated?, analysisScope?` in **both** `extension.ts` and `standalone/bootstrap.ts`. Exit non-zero with the offending file, line and identifier.
- **Edge Cases:** The webview bundle may still *send* `apiOriginated` from an older cached build; that is harmless (`validateVerbPayload` ignores undeclared fields) and the scan covers source, not shipped browser caches. Do not add an assertion that would fail on a stale browser build.

### `package.json` + `.github/workflows/integration-tests.yml`
- **Logic:** Add `"dispatch-surface:check": "node scripts/check-dispatch-surface.js"` and a CI step immediately after the `Push-routing ratchet` step, with a comment naming the failure mode it guards (silent-positive dispatch into an invisible terminal).

## Verification Plan

### Automated
1. **The guard fails before it passes.** Temporarily add `apiOriginated?: boolean` to one wrapper in `TaskViewerProvider.ts`, run `npm run dispatch-surface:check`, confirm non-zero exit naming that file and line, then revert. Record the observed failure output in the completion summary.
2. **The arity half fails independently.** Temporarily delete the `_apiOriginated` slot from `extension.ts:triggerAgentFromKanban`, confirm the guard fails on arity even though the occurrence count went *down*, then revert.
3. The guard passes on the unmodified tree.
4. The guard does not false-positive on `src/test/**`, on comment prose, or on the three allowlisted dead-slot lines.
5. Existing gates stay green: `catalog:check`, `parity:check`, `push-routing:check`, `standalone-parity:check`, `standalone-fork:check`, `kanban-dispatch-callers:check`, `verb-returns:check`, full `test:contract:*`.

### Manual
1. Confirm the CI step appears in the workflow and runs on a pull request.

## Recommendation

Complexity 3 → **Send to Intern Coder.** A single new text-ratchet script modelled line-for-line on an existing one, plus two wiring edits. The only judgement call is allowlist granularity, and the plan states it. The one thing that must not be skipped is verification item 1 — a ratchet never seen to fail is not a ratchet.
