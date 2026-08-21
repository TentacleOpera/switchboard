# Two reviewer→coder relays pass `promptComposed: true` and strip the coder's seat safeguards

## Goal

`_dispatchExecuteMessage`'s `promptComposed: true` argument means "this payload already came out of `agentPromptBuilder`, so do not append the seat directive block." Two call sites pass it for a payload that is **hand-built prose**, not a composed prompt. Both send fix-these-findings instructions to a coder terminal, and both therefore deliver those instructions with the coder's git policy, skip directives, subagent policy and output shaping silently absent.

Both sites must stop claiming composition. The audit gate that is supposed to catch exactly this must then be re-pinned to the true site inventory, and its classifier repaired so it stops mis-binning a third site.

### Problem analysis

`promptComposed` is threaded `_dispatchExecuteMessage` → `_attemptDirectTerminalPush` → `addonsComposed: promptComposed` on the `ptySendPrompt` payload. Because `_attemptDirectTerminalPush` calls `_ptyHostVerb` directly, it bypasses the HTTP-boundary strip at `TaskViewerProvider.ts:3314` — the marker survives, and the delivery layer's `applySeatBlock = payload?.addonsComposed !== true` (`TaskViewerProvider.ts:651`) evaluates false. The entire seat-block branch (`:734-807`) is skipped.

The two offending sites are inside the reviewer pre-dispatch gate:

```ts
// TaskViewerProvider.ts:22150 — mechanical pre-check failed
const coderReport = `MECHANICAL GATE FAILED — pre-check before reviewer dispatch found issues. Fix these and report back:\n\n${findingsText}\n\nCheck details:\n${checkDetails}`;
await this._dispatchExecuteMessage(resolvedWorkspaceRoot, reviewerCoderTerminal, coderReport, {}, 'sidebar', true);

// TaskViewerProvider.ts:22202 — phone-a-friend pre-review returned FAIL
const coderReport = `PHONE-A-FRIEND PRE-REVIEW FAILED — fix these gaps before reviewer dispatch:\n\n${preReviewResult.findings || '…'}`;
await this._dispatchExecuteMessage(resolvedWorkspaceRoot, reviewerCoderTerminal, coderReport, {}, 'sidebar', true);
```

Neither `coderReport` passes through `generateUnifiedPrompt`, `buildKanbanBatchPrompt` or `buildSeatDirectiveBlock`. They are template literals assembled from gate findings. The marker is simply wrong.

### Root cause

The 6th positional argument defaults to `false` precisely so a new call site gains the safeguard by omission (`TaskViewerProvider.ts:21537`). These two sites were added by the review self-fix / two-tier delegation work (`f6e46fcb`, then `ab5100d7`) and passed `true` by copying the shape of the neighbouring *composed* dispatch at `:22322`, where `messagePayload` genuinely does come from `generateUnifiedPrompt` (`:22225-22285`). The argument is positional and unnamed at the call site, so `'sidebar', true` reads as boilerplate rather than as a claim about the payload.

### Consequences

`reviewerCoderTerminal` is resolved by team-scoped role resolution (`:22050-22054`), so the recipient is a **team member** by construction. Suppressing its seat block drops, specifically:

1. **The team-commit gate.** `resolveTeamStanding` forces `gitCommitStrategy: 'dontCommit'` for a non-head member (`:750-757`). With the block suppressed, a coder told to fix findings receives no commit instruction at all — so it may commit directly, against the team contract that only the head commits.
2. **`skipTests` / `skipCompilation`** — the coder may run suites the operator turned off for that seat.
3. **`noSubagents` / `customSubagent`** — the coder may spawn subagents the operator forbade. This is the *verbatim* incident the seat-safeguards suite was written for: "a lead drove a coder via `ptySendPrompt` and the coder's configured `noSubagents` safeguard was silently absent" (`seat-safeguards-fleet-prompt-path.test.js:6-9`).
4. **`cavemanOutput` / `suppressWalkthrough` / `accurateCoding`.**

Standing orders are unaffected — neither site passes a `delivery` object, so `applySO` stays true and the orders block is still applied.

### Why the gate did not stop this

`seat-safeguards-fleet-prompt-path.test.js` pins the inventory: exactly 7 `_dispatchExecuteMessage` call sites, exactly 2 composed. That gate **is** red at HEAD and **is** CI-wired (`integration-tests.yml:206`), so it did its job — it was simply left red rather than acted on. The 2026-08-21 reviewer pass declined to re-baseline it for this exact reason.

The gate has a secondary defect that must be fixed in the same pass, or the re-pinned numbers will be wrong. Its classifier tests the trimmed call text for a trailing `, true` (`:589-592`). Site `:2038` (`_deliverStandingOrdersOnEstablish`) passes `true` followed by a 7th argument on the next line:

```ts
await this._dispatchExecuteMessage(
    workspaceRoot, terminalName, block, {}, 'sidebar', true,
    { clearBeforePrompt: false, standingOrders: false }
);
```

That site is **correct** — the payload is a standing-orders block the method rendered itself, which is why it also passes `standingOrders: false`. The classifier bins it as *uncomposed*, which is why the reported split (4 composed / 8 uncomposed) disagrees with the source (5 composed / 7 uncomposed). Re-pinning to the reported numbers would enshrine the mis-bin.

## Metadata

- **Complexity:** 3
- **Tags:** bugfix, backend, reliability, security

## User Review Required

- None. Both sites send hand-built prose and the marker is factually false at each; removing it restores the documented default. The verdict on all five composed sites is settled below, so there is no classification left for a human to make.

## Complexity Audit

### Routine

- Dropping the 6th argument at two call sites (`TaskViewerProvider.ts:22150`, `:22202`). No signature change — `promptComposed` already defaults to `false`.
- Re-pinning two count assertions (`seat-safeguards-fleet-prompt-path.test.js:598`, `:615`) to the true inventory.

### Complex / Risky

- **The classifier must be fixed before the counts are re-pinned, not after.** Its trailing-`, true` test mis-bins `:2038`. Repair the classifier first, confirm it reports 5 composed / 7 uncomposed, and only then write those numbers into the assertions. Re-pinning against the buggy classifier's output bakes the mis-bin into the gate permanently.
- **The composed allowance goes 2 → 3, not 2 → 5.** After the fix, three sites legitimately pass `true`: `:7377` (batch-group, `finalPrompt`), `:22322` (single-card, `messagePayload` from `generateUnifiedPrompt`), and `:2038` (self-rendered standing-orders block). The assertion message must enumerate all three by name and reason, because the whole value of this gate is that a fourth requires a human to justify it.
- **Do not "fix" the seven uncomposed sites.** `promptComposed=false` is the safe direction: those sites GAIN the seat block. Two are newer than the last audit (`_deliverStandingOrdersOnEstablish`'s sibling paths and `_deliverTeamAutomationJob` at `:27918`) and are correct as-is. The only work on the uncomposed side is enumeration.
- **`:2038` must keep its `true`.** It renders the standing-orders block itself and pairs the marker with `standingOrders: false`; appending a seat block there would add directives to a pure orders delivery. Changing it would be a regression, not a cleanup.

## Edge-Case & Dependency Audit

- **Double-directive risk from restoring the block:** none. Both `coderReport` payloads are gate findings with no directive constants in them, so every part of the seat block is absent and nothing is filtered. `buildSeatDirectiveBlock`'s `existingPrompt` dedupe (plan `51f3f3e4`, already shipped) makes this safe even if a findings string ever did quote a directive verbatim.
- **Seat-block cache:** neither site passes `clearBeforePrompt`, so `isClearingSend` is false and the block is memoised per `agentInstanceId` (`:792-798`). If the reviewer gate fails twice for the same coder without an intervening clear, the second delivery suppresses an identical block — correct, existing behaviour, and the coder still holds the first copy in context.
- **Delivery ordering:** the block lands between the findings prose and the standing-orders block, which is the same shape a board dispatch has (`:734-829`). No ordering change.
- **Timing / races:** none new. Both sites already `await` the dispatch inside the reviewer gate's dispatch lock (`clearDispatchLock()` is called on the failure paths immediately after). Adding the seat block adds two DB reads inside the existing branch, not a new async boundary.
- **`resolveSeatPromptOptions` on an unresolved role:** falls back to workspace defaults with the git guardrail ON (`:730-733`), so the worst case is a stricter block, never an empty one.
- **Standalone twin:** none needed. `_dispatchExecuteMessage` is extension-host-only; the standalone host's equivalent relay goes through `deliverPrompt`, which never sets `addonsComposed` for an HTTP caller (`bootstrap.ts:1687-1689`).
- **Security:** narrowing, not widening. Two paths stop asserting a host-only marker they were not entitled to.

## Dependencies

- None. `51f3f3e4` (seat-block dedupe) is already shipped and merely makes this fix safer; it is not a prerequisite.

## Adversarial Synthesis

Key risks: (1) re-pinning the counts before repairing the classifier, which would permanently enshrine the `:2038` mis-bin and leave the gate reporting numbers that do not match the source — mitigated by ordering the steps explicitly and requiring the coder to print the classifier output before editing the assertions; (2) "fixing" the seven uncomposed sites out of tidiness, which would strip safeguards from paths that currently have them — mitigated by stating that `false` is the safe direction and that only enumeration is in scope; (3) removing `:2038`'s marker along with the other two, which would append directives to a pure standing-orders delivery — mitigated by naming that site as must-keep in both the Complexity Audit and the change list.

## Proposed Changes

### 1. `src/services/TaskViewerProvider.ts:22150` — the mechanical-gate findings relay

```ts
-                                await this._dispatchExecuteMessage(resolvedWorkspaceRoot, reviewerCoderTerminal, coderReport, {}, 'sidebar', true);
+                                // NOT composed: coderReport is a template literal built
+                                // from the pre-check findings above, never a
+                                // generateUnifiedPrompt/buildKanbanBatchPrompt product. Passing
+                                // promptComposed: true here set addonsComposed on the
+                                // ptySendPrompt payload and suppressed this coder's whole seat
+                                // block — including the team-commit gate that forces a member to
+                                // dontCommit. Omit the argument so the default (false) applies.
+                                await this._dispatchExecuteMessage(resolvedWorkspaceRoot, reviewerCoderTerminal, coderReport, {}, 'sidebar');
```

### 2. `src/services/TaskViewerProvider.ts:22202` — the phone-a-friend pre-review relay

```ts
-                                        await this._dispatchExecuteMessage(resolvedWorkspaceRoot, reviewerCoderTerminal, coderReport, {}, 'sidebar', true);
+                                        // NOT composed — same reason as the mechanical-gate relay
+                                        // above: coderReport is assembled from
+                                        // preReviewResult.findings, so the coder must still get
+                                        // its seat directive block.
+                                        await this._dispatchExecuteMessage(resolvedWorkspaceRoot, reviewerCoderTerminal, coderReport, {}, 'sidebar');
```

### 3. `src/services/TaskViewerProvider.ts:2038` — leave exactly as it is

No edit. Documented here only so the coder does not sweep it in with the other two. It renders its own standing-orders block and correctly pairs `promptComposed: true` with `standingOrders: false`.

### 4. `src/test/seat-safeguards-fleet-prompt-path.test.js:~589` — repair the classifier

The trailing-`, true` test must tolerate a following argument on a later line. Match the marker by argument position inside the call's argument list rather than by end-of-string:

```js
-        (/'[a-z]+',\s*true\s*$/m.test(call.trimEnd()) || /,\s*true\s*$/.test(call.trimEnd()))
+        // The marker is the 6th positional argument. Anchor on the `sender` string
+        // that precedes it, NOT on end-of-call: `_deliverStandingOrdersOnEstablish`
+        // passes a 7th `delivery` argument on the following line, and an
+        // end-anchored test bins that composed site as uncomposed.
+        (/'[a-z]+'\s*,\s*true\b/.test(call))
```

### 5. `src/test/seat-safeguards-fleet-prompt-path.test.js:598` — re-pin the inventory

Raise the total to the post-fix count and the composed allowance to 3, enumerating each composed site so a fourth cannot be added silently:

```js
    assert.strictEqual(
        composed.length + uncomposed.length, 12, /* … */);
    assert.strictEqual(
        composed.length, 3,
        `Exactly 3 call sites may pass promptComposed: true — the batch-group dispatch and the `
        + `single-card dispatch (both out of generateUnifiedPrompt/buildKanbanBatchPrompt), and `
        + `_deliverStandingOrdersOnEstablish (which renders its own standing-orders block and `
        + `pairs the marker with standingOrders: false). Found ${composed.length} at lines `
        + `[${composed.join(', ')}]. Marking a fourth exempts an uncomposed path from its seat `
        + `safeguards, silently — which is exactly what the two reviewer→coder findings relays did.`
    );
```

### 6. `src/test/seat-safeguards-fleet-prompt-path.test.js:615` — re-pin the uncomposed enumeration

Raise to 9 (the 7 existing plus the 2 sites this plan converts) and refresh the named list to include `_deliverTeamAutomationJob` and the second orchestrator-kickoff send. The per-site "must reach the funnel unmarked" loop below it is unchanged.

### 7. New behavioural pin — the two relays must not claim composition

Add a case asserting the two reviewer-gate relays specifically, so a future copy-paste of the neighbouring composed dispatch is caught by name rather than only by a count that a coder may be tempted to bump:

```js
test('SOURCE: the reviewer-gate findings relays do NOT claim composition', () => {
    for (const marker of ['MECHANICAL GATE FAILED', 'PHONE-A-FRIEND PRE-REVIEW FAILED']) {
        const at = TASK_VIEWER_SRC.indexOf(marker);
        assert.ok(at > 0, `relay not found: ${marker}`);
        const relay = TASK_VIEWER_SRC.slice(at, TASK_VIEWER_SRC.indexOf(');', at));
        assert.ok(!/'sidebar'\s*,\s*true/.test(relay),
            `the "${marker}" relay must not pass promptComposed: true — coderReport is a template `
            + 'literal, and the marker strips the coder\'s seat block including the team-commit gate');
    }
});
```

## Verification Plan

### Automated

1. `npm run compile-tests` — clean.
2. `node -e` (or a scratch script) printing the repaired classifier's output against `src/services/TaskViewerProvider.ts` **before** editing the count assertions. Confirm it reports **3 composed** at lines `[2038, 7377, 22322]` and **9 uncomposed** including `22150` and `22202`. Only then write the numbers in.
3. `npm run test:contract:seat-safeguards` — must reach **0 failed**. This is the gate that has been red since `f6e46fcb`; the plan is not done while it is red. CI-wired at `.github/workflows/integration-tests.yml:206`.
4. `npm run test:contract:team-scoped-routing` — the reviewer-delegation cases (item 9) exercise the same gate path; must stay green.
5. Mutation-check the new pin from step 7: re-add `, true` to one relay, confirm the new test goes red, then revert. A pin that cannot fail is not a pin.
6. `npm run parity:check` and `npm run verb-returns:check` — the dispatch funnel is on both ratchets' surface.

### Manual

7. Start a Coding team (head `lead`, a `coder` member, a `reviewer`). Configure the coder's role with **No subagents** and **Skip tests** in the AGENTS/PROMPTS tab.
8. Dispatch a card to the reviewer with the mechanical pre-review gate enabled, on a plan whose diff will fail the pre-check (e.g. touch a file outside plan scope).
9. **Expect:** the coder receives the `MECHANICAL GATE FAILED` report **followed by** its seat directive block — the no-subagents directive, the skip-tests directive, and a `GIT POLICY:` line instructing it **not** to commit (it is a member, not the head). Before the fix, the report arrives alone.
10. Scroll back and confirm the standing-orders block still appears exactly once and last.
11. Repeat with the phone-a-friend pre-review path returning FAIL, confirming the same block on the `PHONE-A-FRIEND PRE-REVIEW FAILED` report.
12. Regression — dispatch a normal card to a coder and confirm the composed board prompt still carries each directive exactly **once** (site `:22322` still claims composition, and plan `51f3f3e4`'s dedupe covers it).

---

**Recommendation: Send to Coder** (complexity 3 — two one-line call-site fixes, but the test work is order-sensitive: repair the classifier, read its output, then re-pin. Three sites must be left alone, and one of them looks exactly like the two being changed.)
