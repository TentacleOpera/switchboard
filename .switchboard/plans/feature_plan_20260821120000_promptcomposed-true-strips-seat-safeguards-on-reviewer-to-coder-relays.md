# Two reviewer→coder relays pass `promptComposed: true` and strip the coder's seat safeguards

## Goal

`_dispatchExecuteMessage`'s `promptComposed: true` argument means "this payload already came out of `agentPromptBuilder`, so do not append the seat directive block." Two call sites pass it for a payload that is **hand-built prose**, not a composed prompt. Both send fix-these-findings instructions to a coder terminal, and both therefore deliver those instructions with the coder's git policy, skip directives, subagent policy and output shaping silently absent.

Both sites must stop claiming composition. The audit gate that is supposed to catch exactly this must then be re-pinned to the post-fix inventory (composed 5 → 3), and its audit note repaired so it stops recording the two relays as deliberate composed sites.

### Problem analysis

`promptComposed` is threaded `_dispatchExecuteMessage` (`TaskViewerProvider.ts:22678`) → `_attemptDirectTerminalPush` (`:22756`) → `addonsComposed: promptComposed` on the `ptySendPrompt` payload. Because `_attemptDirectTerminalPush` calls `_ptyHostVerb` directly, it bypasses the HTTP-boundary strip at `TaskViewerProvider.ts:4454` — the marker survives, and the delivery layer's `applySeatBlock = payload?.addonsComposed !== true && payload?.seatBlock !== false && !payload?.machineOrigin && !isMessage` (`TaskViewerProvider.ts:1141`) evaluates false. The entire seat-block branch (`:1226-1290`) is skipped.

The two offending sites are inside the reviewer pre-dispatch gate:

```ts
// TaskViewerProvider.ts:23350 — mechanical pre-check failed
const coderReport = `MECHANICAL GATE FAILED — pre-check before reviewer dispatch found issues. Fix these and report back:\n\n${findingsText}\n\nCheck details:\n${checkDetails}`;
await this._dispatchExecuteMessage(resolvedWorkspaceRoot, reviewerCoderTerminal, coderReport, {}, 'sidebar', true, undefined, true);

// TaskViewerProvider.ts:23402 — phone-a-friend pre-review returned FAIL
const coderReport = `PHONE-A-FRIEND PRE-REVIEW FAILED — fix these gaps before reviewer dispatch:\n\n${preReviewResult.findings || 'The pre-review agent reported FAIL without details.'}`;
await this._dispatchExecuteMessage(resolvedWorkspaceRoot, reviewerCoderTerminal, coderReport, {}, 'sidebar', true, undefined, true);
```

Neither `coderReport` passes through `generateUnifiedPrompt`, `buildKanbanBatchPrompt` or `buildSeatDirectiveBlock`. They are template literals assembled from gate findings. The 6th positional argument (`promptComposed`) is `true` at both, and the marker is simply wrong.

Note the full argument list: `{}, 'sidebar', true, undefined, true`. The 6th (`true`) is `promptComposed` — the bug. The 7th (`undefined`) is `delivery`. The 8th (`true`) is `ptyOnly` — load-bearing: it restricts delivery to the PTY fleet and stops a fallback to a same-named VS Code terminal. **The fix touches only the 6th argument; the 7th and 8th must be preserved.**

### Root cause

The 6th positional argument defaults to `false` precisely so a new call site gains the safeguard by omission (`TaskViewerProvider.ts:22684`). These two sites were added by the review self-fix / two-tier delegation work (`f6e46fcb`, then `ab5100d7`) and passed `true` by copying the shape of the neighbouring *composed* dispatch at `:23535`, where `messagePayload` genuinely does come from `generateUnifiedPrompt`. The argument is positional and unnamed at the call site, so `'sidebar', true, undefined, true` reads as boilerplate rather than as a claim about the payload.

### Consequences

`reviewerCoderTerminal` is resolved by team-scoped role resolution (`:23220-23226`), so the recipient is a **team member** by construction. Suppressing its seat block drops, specifically:

1. **The team-commit gate.** `resolveTeamStanding` forces `gitCommitStrategy: 'dontCommit'` for a non-head member (`:1238-1241`). With the block suppressed, a coder told to fix findings receives no commit instruction at all — so it may commit directly, against the team contract that only the head commits.
2. **`skipTests` / `skipCompilation`** — the coder may run suites the operator turned off for that seat.
3. **`noSubagents` / `customSubagent`** — the coder may spawn subagents the operator forbade. This is the *verbatim* incident the seat-safeguards suite was written for: "a lead drove a coder via `ptySendPrompt` and the coder's configured `noSubagents` safeguard was silently absent" (`seat-safeguards-fleet-prompt-path.test.js:6-9`).
4. **`cavemanOutput` / `suppressWalkthrough` / `accurateCoding`.**

Standing orders are unaffected — neither site passes a `delivery` object, so `applySO` stays true and the orders block is still applied.

The seat-block cache (`:1280-1288`) does NOT save this. The cache only suppresses a *repeat* of an identical block (`shouldDeliver = !instanceId || isClearingSend || cachedEntry?.block !== seatBlock`). But the block is never built at all when `applySeatBlock` is false — so there is nothing to cache and nothing to replay. If the coder terminal has no prior cached entry (its first dispatch that session), the suppression is total. The 2026-08-31 audit note's rationale for leaving the relays ("the recipient is mid-turn with its seat block already cached, so nothing is lost today") holds only when the coder was dispatched earlier that turn; it does not hold for a freshly-spawned coder terminal whose first prompt is the findings relay. That is the case this plan closes.

### Why the gate did not stop this — current state (2026-08-31 audit)

`seat-safeguards-fleet-prompt-path.test.js` pins the inventory. The gate is **GREEN at HEAD**, not red. A 2026-08-31 reviewer pass re-pinned it from 12/5/7 → **14/5/9**: the classifier was repaired (paren-balanced `dispatchCallArgs` at `:625-653`, replacing the old tail-anchored test), two new `createFleetTerminalAndDeliver` sites were added to the uncomposed set, and the composed allowance was raised to 5. The audit note (`:670-692`) enumerates the five composed sites and **deliberately keeps the two reviewer→coder relays as composed** (items 3 and 4), with the recorded rationale quoted above — deferring the change to "the plan under review."

This plan IS that plan. Its action is to **overrule the deferral**: drop the marker at the two relay sites, lower the composed allowance 5 → 3, raise the uncomposed count 9 → 11, and rewrite the audit note so it no longer lists the two relays as deliberate composed sites. The classifier is already correct — no classifier repair is in scope. The total stays 14 (no call sites are added or removed; two move from composed to uncomposed).

## Metadata

- **Complexity:** 3
- **Tags:** bugfix, backend, reliability, security

## User Review Required

- None. Both sites send hand-built prose and the marker is factually false at each; removing it restores the documented default. The verdict on all three remaining composed sites is settled below, so there is no classification left for a human to make.

## Complexity Audit

### Routine

- Changing the 6th argument from `true` to `false` at two call sites (`TaskViewerProvider.ts:23350`, `:23402`), preserving the 7th (`undefined`) and 8th (`true` / `ptyOnly`) arguments. No signature change — `promptComposed` already defaults to `false`.
- Re-pinning two count assertions (`seat-safeguards-fleet-prompt-path.test.js:693` total stays 14; `:701` composed 5 → 3; `:711` uncomposed 9 → 11) to the post-fix inventory.
- Rewriting the audit note (`:670-692`) to remove items 3 and 4 from the composed list.

### Complex / Risky

- **The classifier is already repaired — do not touch it.** The 2026-08-31 pass replaced the broken tail-anchored test with `dispatchCallArgs` (paren-balanced, reads the 6th positional argument by balancing parentheses). Any "repair" applied to the old form would regress it. The only test work is re-pinning the counts and rewriting the note.
- **The composed allowance goes 5 → 3, not 2 → 3.** After the fix, three sites legitimately pass `true`: `:8827` (batch-group, `finalPrompt`), `:23535` (single-card, `messagePayload` from `generateUnifiedPrompt`), and `:2915` (`_deliverStandingOrdersOnEstablish`, self-rendered standing-orders block). The assertion message must enumerate all three by name and reason, because the whole value of this gate is that a fourth requires a human to justify it.
- **Do not "fix" the eleven uncomposed sites.** `promptComposed=false` is the safe direction: those sites GAIN the seat block. The only work on the uncomposed side is enumeration (the count rises to 11 because the two relays join it).
- **`:2915` must keep its `true`.** It renders the standing-orders block itself and pairs the marker with `standingOrders: false`; appending a seat block there would add directives to a pure orders delivery. Changing it would be a regression, not a cleanup.
- **Preserve `ptyOnly` (8th arg) at the two relay sites.** Both pass `true, undefined, true`. The fix changes only the 6th argument (`true` → `false`); the 8th (`ptyOnly: true`) restricts delivery to the PTY fleet and must survive. Dropping it (as a naive "remove `, true`" edit would) lets the dispatch fall back to a same-named VS Code terminal — the wrong seat gets the findings.

## Edge-Case & Dependency Audit

- **Double-directive risk from restoring the block:** none. Both `coderReport` payloads are gate findings with no directive constants in them, so every part of the seat block is absent and nothing is filtered. `buildSeatDirectiveBlock`'s `existingPrompt` dedupe (plan `51f3f3e4`, already shipped) makes this safe even if a findings string ever did quote a directive verbatim.
- **Seat-block cache:** neither site passes `clearBeforePrompt`, so `isClearingSend` is false and the block is memoised per `agentInstanceId` (`:1280-1288`). If the reviewer gate fails twice for the same coder without an intervening clear, the second delivery suppresses an identical block — correct, existing behaviour, and the coder still holds the first copy in context.
- **Delivery ordering:** the block lands between the findings prose and the standing-orders block, which is the same shape a board dispatch has (`:1226-1290`). No ordering change.
- **Timing / races:** none new. Both sites already `await` the dispatch inside the reviewer gate's dispatch lock (`clearDispatchLock()` is called on the failure paths immediately after). Adding the seat block adds two DB reads inside the existing branch, not a new async boundary.
- **`resolveSeatPromptOptions` on an unresolved role:** falls back to workspace defaults with the git guardrail ON (`:1215-1218`), so the worst case is a stricter block, never an empty one.
- **Standalone twin:** none needed. `_dispatchExecuteMessage` is extension-host-only; the standalone host's equivalent relay goes through `deliverPrompt`, which strips `addonsComposed` from any HTTP caller (`bootstrap.ts:2740`).
- **Security:** narrowing, not widening. Two paths stop asserting a host-only marker they were not entitled to.

## Dependencies

- None. `51f3f3e4` (seat-block dedupe) is already shipped and merely makes this fix safer; it is not a prerequisite.

## Adversarial Synthesis

Key risks: (1) applying a stale "remove `, true`" edit that drops the 8th `ptyOnly` argument along with the 6th, letting the findings land on a same-named VS Code terminal — mitigated by naming the full argument list and requiring the coder to change only the 6th; (2) "repairing" the classifier, which is already repaired — mitigated by stating explicitly that the classifier is out of scope and any change to it is a regression; (3) removing `:2915`'s marker along with the other two, which would append directives to a pure standing-orders delivery — mitigated by naming that site as must-keep in both the Complexity Audit and the change list; (4) re-pinning against the pre-2026-08-31 numbers (12/3/9) instead of the current (14/3/11) — mitigated by recording the current gate state and the exact post-fix counts.

## Proposed Changes

### 1. `src/services/TaskViewerProvider.ts:23350` — the mechanical-gate findings relay

Change the 6th positional argument from `true` to `false`. Preserve the 7th (`undefined`) and 8th (`true` / `ptyOnly`):

```ts
-                                await this._dispatchExecuteMessage(resolvedWorkspaceRoot, reviewerCoderTerminal, coderReport, {}, 'sidebar', true, undefined, true);
+                                // NOT composed: coderReport is a template literal built
+                                // from the pre-check findings above, never a
+                                // generateUnifiedPrompt/buildKanbanBatchPrompt product. Passing
+                                // promptComposed: true here set addonsComposed on the
+                                // ptySendPrompt payload and suppressed this coder's whole seat
+                                // block — including the team-commit gate that forces a member to
+                                // dontCommit. Set promptComposed: false (the default) so the
+                                // seat block is appended. ptyOnly (8th arg) stays true — the
+                                // reviewer's coder is a PTY fleet terminal.
+                                await this._dispatchExecuteMessage(resolvedWorkspaceRoot, reviewerCoderTerminal, coderReport, {}, 'sidebar', false, undefined, true);
```

### 2. `src/services/TaskViewerProvider.ts:23402` — the phone-a-friend pre-review relay

Same shape — change the 6th argument only:

```ts
-                                        await this._dispatchExecuteMessage(resolvedWorkspaceRoot, reviewerCoderTerminal, coderReport, {}, 'sidebar', true, undefined, true);
+                                        // NOT composed — same reason as the mechanical-gate relay
+                                        // above: coderReport is assembled from
+                                        // preReviewResult.findings, so the coder must still get
+                                        // its seat directive block. ptyOnly stays true.
+                                        await this._dispatchExecuteMessage(resolvedWorkspaceRoot, reviewerCoderTerminal, coderReport, {}, 'sidebar', false, undefined, true);
```

### 3. `src/services/TaskViewerProvider.ts:2915` — leave exactly as it is

No edit. Documented here only so the coder does not sweep it in with the other two. It renders its own standing-orders block and correctly pairs `promptComposed: true` with `standingOrders: false`.

### 4. `src/test/seat-safeguards-fleet-prompt-path.test.js:670-692` — rewrite the audit note

The audit note currently lists five composed sites and keeps the two reviewer relays (items 3 and 4) as deliberate. Rewrite it to list three composed sites and record that the two relays were moved to uncomposed by this plan:

```js
// Audit re-run 2026-09-14 (promptComposed-relays plan). The two reviewer→coder
// findings relays (MECHANICAL GATE FAILED, PHONE-A-FRIEND PRE-REVIEW FAILED) were
// moved from composed to uncomposed: their payloads are template literals, not
// agentPromptBuilder output, so the marker stripped the coder's seat block
// (team-commit gate, skip directives, subagent policy). The composed allowance
// drops 5 → 3; uncomposed rises 9 → 11; total stays 14.
//
// The three composed sites, each justified:
//   1. the standing-orders one-shot (:2915) — the rendered orders block IS the
//      payload, so a seat directive block appended after it would be a second
//      suffix; pairs the marker with standingOrders: false;
//   2. batch-group dispatch (:8827) — prompt from buildKanbanBatchPrompt;
//   3. single-card dispatch (:23535) — prompt from generateUnifiedPrompt.
```

### 5. `src/test/seat-safeguards-fleet-prompt-path.test.js:693-707` — re-pin the composed count

Lower the composed allowance from 5 to 3; total stays 14. Enumerate each composed site so a fourth cannot be added silently:

```js
    assert.strictEqual(
        composed.length + uncomposed.length, 14,
        `Expected 14 _dispatchExecuteMessage call sites (the audited set), found ${composed.length + uncomposed.length}. `
        + 'A new call site must be classified deliberately: it defaults to promptComposed=false and therefore '
        + 'GAINS the seat block, which is the safe direction — but the audit must be re-run.'
    );
    assert.strictEqual(
        composed.length, 3,
        `Exactly 3 call sites may pass promptComposed: true — the batch-group dispatch (:8827, prompt from `
        + `buildKanbanBatchPrompt), the single-card dispatch (:23535, prompt from generateUnifiedPrompt), and `
        + `_deliverStandingOrdersOnEstablish (:2915, which renders its own standing-orders block and pairs the `
        + `marker with standingOrders: false). Found ${composed.length} at lines [${composed.join(', ')}]. `
        + 'Marking a fourth exempts an uncomposed path from its seat safeguards, silently — which is exactly '
        + 'what the two reviewer→coder findings relays did before this plan moved them to uncomposed.'
    );
```

### 6. `src/test/seat-safeguards-fleet-prompt-path.test.js:709-734` — re-pin the uncomposed enumeration

Raise to 11 (the 9 existing plus the 2 sites this plan converts). Refresh the named list to include the two reviewer relays by name. The per-site "must reach the funnel unmarked" loop below it is unchanged.

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

1. `npm run compile-tests` — clean. *(Compilation skipped this run per dispatch directive; the check remains written for the implementing coder.)*
2. `node -e` (or a scratch script) printing the classifier's output against `src/services/TaskViewerProvider.ts` **after** editing the two call sites but **before** editing the count assertions. Confirm it reports **3 composed** at lines `[2915, 8827, 23535]` and **11 uncomposed** including `23350` and `23402`. Only then write the numbers in. *(Not executed this run.)*
3. `npm run test:contract:seat-safeguards` — must reach **0 failed**. CI-wired at `.github/workflows/integration-tests.yml:206`. *(Not executed this run.)*
4. `npm run test:contract:team-scoped-routing` — the reviewer-delegation cases exercise the same gate path; must stay green. *(Not executed this run.)*
5. Mutation-check the new pin from step 7: re-add `, true` to one relay, confirm the new test goes red, then revert. A pin that cannot fail is not a pin. *(Not executed this run.)*
6. `npm run parity:check` and `npm run verb-returns:check` — the dispatch funnel is on both ratchets' surface. *(Not executed this run.)*

### Manual

7. Start a Coding team (head `lead`, a `coder` member, a `reviewer`). Configure the coder's role with **No subagents** and **Skip tests** in the AGENTS/PROMPTS tab.
8. Dispatch a card to the reviewer with the mechanical pre-review gate enabled, on a plan whose diff will fail the pre-check (e.g. touch a file outside plan scope).
9. **Expect:** the coder receives the `MECHANICAL GATE FAILED` report **followed by** its seat directive block — the no-subagents directive, the skip-tests directive, and a `GIT POLICY:` line instructing it **not** to commit (it is a member, not the head). Before the fix, the report arrives alone.
10. Scroll back and confirm the standing-orders block still appears exactly once and last.
11. Repeat with the phone-a-friend pre-review path returning FAIL, confirming the same block on the `PHONE-A-FRIEND PRE-REVIEW FAILED` report.
12. Regression — dispatch a normal card to a coder and confirm the composed board prompt still carries each directive exactly **once** (site `:23535` still claims composition, and plan `51f3f3e4`'s dedupe covers it).

### Goal Invariants

- The two reviewer-gate relays (`MECHANICAL GATE FAILED`, `PHONE-A-FRIEND PRE-REVIEW FAILED`) pass `promptComposed: false` (or omit it, defaulting to false) — never `true`.
- `ptyOnly` (the 8th argument) remains `true` at both relay sites.
- The composed-site count is exactly 3; the three named composed sites (`:2915`, `:8827`, `:23535`) are unchanged.
- The uncomposed-site count is exactly 11 and includes both relay lines.
- No change to the classifier (`dispatchCallArgs` / `classifyDispatchCallSites`).

---

**Recommendation: Send to Coder** (complexity 3 — two single-argument call-site fixes, but the test work is count-sensitive: rewrite the audit note, lower the composed count 5 → 3, raise the uncomposed count 9 → 11. Three sites must be left alone, and one of them looks exactly like the two being changed. The 8th `ptyOnly` argument must survive the edit.)
