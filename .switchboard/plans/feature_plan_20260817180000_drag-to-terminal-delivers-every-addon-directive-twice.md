# Dragging a Card Onto a Terminal Pane Delivers Every Add-on Directive Twice

## Goal

A plan dragged from a kanban pane onto a terminal pane must arrive as ONE prompt with each add-on directive stated once. Today the delivered text carries the git policy, skip-compilation, skip-tests, caveman-output, suppress-walkthrough, accurate-coding and subagent directives **twice** — once from the board's prompt builder and once again from the delivery layer's seat directive block.

### Problem analysis

The pane drop handler is a two-hop dispatch (`src/webview/terminals.js:4614` and `:4673`):

1. `POST /kanban/verb/promptSelected` → returns `data.prompt`, the board-composed advance prompt for the dragged plan(s).
2. `POST /terminals/verb/ptySendPrompt` with `{ name, data: promptText, clearBeforePromptFromConfig: true }`.

Step 1's prompt is built by `KanbanProvider._generatePromptForColumn` (`src/services/KanbanProvider.ts:9887`), which resolves the role's add-ons into `PromptBuilderOptions` (`KanbanProvider.ts:5062-5099`) and hands them to `agentPromptBuilder`. The returned string therefore **already contains** the composed directive constants.

Step 2 lands in `TaskViewerProvider.handlePtyVerb`, whose `ptySendPrompt` arm appends a **seat directive block** on top (`src/services/TaskViewerProvider.ts:584-754`, with the `buildSeatDirectiveBlock` call at `:717`):

```ts
const applySeatBlock = payload?.addonsComposed !== true && payload?.seatBlock !== false;
...
const seatBlock = effectiveOpts
    ? buildSeatDirectiveBlock({ ...effectiveOpts, planIds })
    : '';
if (seatBlock) {
    ...
    data = data + '\n\n' + seatBlock;
    ...
}
```

### Root cause

`buildSeatDirectiveBlock` (`src/services/agentPromptBuilder.ts:1139-1175`) emits the **same verbatim constants the board path already emitted** — its own comments say so ("Git policy — same builder the board path uses", "Skip directives — verbatim constants, shared with the board path"):

- `NO_SUBAGENTS_DIRECTIVE` / `CUSTOM_SUBAGENT_DIRECTIVE_TEMPLATE`
- `buildGitPolicyBlock(...)` → `GIT POLICY: …`
- `SKIP_COMPILATION_DIRECTIVE`, `SKIP_TESTS_DIRECTIVE`
- `CAVEMAN_OUTPUT_DIRECTIVE`, `SUPPRESS_WALKTHROUGH_DIRECTIVE`, `ACCURATE_CODING_DIRECTIVE`

The mechanism that is supposed to prevent the double-apply is the `addonsComposed: true` marker — set by internal senders that know the prompt was already composed (`TaskViewerProvider.ts:20653-20666`, `_attemptDirectTerminalPush`). But that marker is **deliberately deleted at the HTTP boundary** in both hosts, because a caller that could set it could opt a seat out of its own safeguards:

- `src/services/TaskViewerProvider.ts:2918` — `if (payload.addonsComposed !== undefined) { delete payload.addonsComposed; }`
- `src/standalone/bootstrap.ts:1608` — the same strip, same rationale.

The pane drop path is an HTTP caller by construction (the webview has no in-process channel), so it can never set the marker. It is the only sender that carries a **board-composed** prompt across that boundary. Result: composed prompt in, seat block appended on top, every add-on directive stated twice.

The standing-orders half of the block does **not** duplicate — `stripStandingOrdersBlock` runs first (`TaskViewerProvider.ts:670`, `bootstrap.ts:306`) and `applyStandingOrders` strips internally. Only the seat directive block has no such idempotence.

### Why not "just let the drop path set addonsComposed"

That re-opens the exact hole the strip exists to close: any holder of the API token (every pty child is handed one) could then send `addonsComposed: true` and strip a seat's safeguards. The fix must make the append itself idempotent, not weaken the boundary.

## User Review Required

- **[user]** None — the fix is fully specified and the root cause is confirmed against the live code. Proceeding without a user decision.

## Metadata

- **Complexity:** 4
- **Tags:** bugfix, backend, reliability
- **Project:** Browser Switchboard

## Complexity Audit

### Routine

- One filter inside `buildSeatDirectiveBlock`'s caller chain — the parts are already built as an array of discrete strings and joined at the end (`agentPromptBuilder.ts:1140-1174`).
- Both hosts call the same exported builder (`TaskViewerProvider.ts:717`, `bootstrap.ts:350`), so one change covers the extension host and the standalone/browser host.
- No schema change, no new verb, no config, no migration.

### Complex / Risky

- **The dedupe key must be the individual part, not the whole block.** A prompt may carry the git policy (composed by the board) but not the caveman directive (role default changed since). Dropping the whole block on a single match under-delivers; keeping the whole block on a single miss re-duplicates. The filter runs per part.
- **`buildGitPolicyBlock` output is composed at both ends from the same clause set but the two callers pass different worktree flags** (`worktreeActive` / `worktreePerPlanActive` are seat-scoped). A seat inside a worktree can legitimately produce a *different* `GIT POLICY:` line from the board's. Matching on the exact string is correct — a genuinely different policy line is not a duplicate and must still be delivered. Do NOT dedupe on the `GIT POLICY:` prefix.
- **Whitespace fidelity.** The board path joins directives with `\n\n`; the seat block joins with `\n\n`. `String.includes` on the exact constant is safe because the constants are emitted verbatim by both builders. Normalising whitespace before comparison would risk false positives against plan prose.
- **The strip must not become a bypass.** A caller who wants to suppress a directive would have to include that directive's exact text in its own payload — which delivers the directive. The dedupe is therefore not weaponisable.
- **Seat-block cache interaction.** Both hosts memoise the seat block per `agentInstanceId` (`TaskViewerProvider.ts:722-728`, `bootstrap.ts:355-361`), comparing the full block string and suppressing re-delivery of an identical block. The fix changes what the block string IS (filtered vs full), so the cache now stores the filtered block. This is safe: a composed prompt that filters to `''` caches nothing (the `if (seatBlock)` guard at `:719`/`:352` skips both delivery and cache write), so the next non-composed send still delivers the full block; a partially-filtered block caches as the partial string, so a subsequent non-composed send delivers the full block (full !== partial → `shouldDeliver` true). No change to the cache logic itself is needed — it compares whatever block string the builder returns.

## Edge-Case & Dependency Audit

- **Race conditions:** none new. The filter is pure string work inside the existing `applySeatBlock` branch, before the write; the per-terminal send lock is untouched.
- **Multi-plan drag:** `promptSelected` composes ONE prompt for N plans; the seat block is appended once regardless. The fix is unaffected by N.
- **Shift-drop branch:** `terminals.js:4426-4446` writes over the raw WebSocket and applies only `applyStandingOrdersClient`. That path never reaches `handlePtyVerb`, so it never gained a seat block and never duplicated. Leave it alone.
- **Standalone twin:** `src/standalone/bootstrap.ts:304-365` (`deliverPrompt`) has the same append with the same builder (`:350`). It must receive the same filter or the browser-served-by-npx host keeps duplicating.
- **Other HTTP callers of `ptySendPrompt`:** fleet agents reporting to a head, the orchestrator relay, `terminals.js:9337`. These send prose, not a composed board prompt, so no part matches and the filter is a no-op for them.
- **`seatBlock: false` / `addonsComposed: true` internal senders:** unaffected — they skip the branch entirely (`applySeatBlock` false at `:585`).
- **Security:** no widening. The HTTP-boundary strips at `TaskViewerProvider.ts:2918` and `bootstrap.ts:1608` stay exactly as they are.
- **Tests:** existing seat-directive tests (`src/test/seat-safeguards-fleet-prompt-path.test.js`) assert that a plain prompt gets the full block via string-equal assertions against the shared constants. Those stay green (no part is present in a plain prompt, nothing is filtered). New coverage asserts the composed-prompt case and the git-policy-divergence case.

## Dependencies

- None — this is a self-contained bugfix with no prerequisite plans.

## Adversarial Synthesis

Key risks: (1) stale line-number citations could send a coder to the wrong code — corrected in this revision against the live source; (2) the seat-block cache stores the filtered block, which is safe but must be documented so a future cache change doesn't silently break the dedupe; (3) the git-policy-worktree-divergence case is the most subtle and must be tested explicitly. Mitigations: all citations verified against current source, cache interaction documented in the Complexity Audit, divergence test added to the verification plan.

## Proposed Changes

### 1. `src/services/agentPromptBuilder.ts` (lines 1139-1175) — make the seat block idempotent against an already-composed prompt

Add an optional `existingPrompt` argument and filter parts already present verbatim. Keep the existing zero-argument behaviour for every current caller.

```ts
export function buildSeatDirectiveBlock(opts: SeatDirectiveOptions, existingPrompt?: string): string {
    const parts: string[] = [];

    // …unchanged part construction…

    // A board-composed prompt already carries these constants verbatim
    // (KanbanProvider._generatePromptForColumn → agentPromptBuilder). The
    // `addonsComposed` marker that suppresses this block is stripped at the HTTP
    // boundary by design, so a webview drag-drop cannot set it — dedupe here
    // instead of weakening that strip. Exact-string match per part: a seat inside
    // a worktree can legitimately emit a DIFFERENT `GIT POLICY:` line from the
    // board's, and that one is not a duplicate.
    const emitted = existingPrompt
        ? parts.filter(p => !existingPrompt.includes(p))
        : parts;

    if (emitted.length === 0) { return ''; }
    return emitted.join('\n\n');
}
```

### 2. `src/services/TaskViewerProvider.ts` (line 717) — pass the prompt in

```ts
-                            const seatBlock = effectiveOpts
-                                ? buildSeatDirectiveBlock({ ...effectiveOpts, planIds })
-                                : '';
+                            // `data` here is post-strip (standing orders already removed
+                            // by stripStandingOrdersBlock at :670), which is what we want
+                            // to test against — the SO block is handled by
+                            // applyStandingOrders' own strip at :746.
+                            const seatBlock = effectiveOpts
+                                ? buildSeatDirectiveBlock({ ...effectiveOpts, planIds }, data)
+                                : '';
```

### 3. `src/standalone/bootstrap.ts` (line 350) — the standalone twin

```ts
-                const seatBlock = effectiveOpts
-                    ? buildSeatDirectiveBlock({ ...effectiveOpts, planIds })
-                    : '';
+                // `out` here is post-strip (standing orders already removed by
+                // stripStandingOrdersBlock at :306), which is what we want to
+                // test against — the SO block is handled by applyStandingOrders'
+                // own strip at :370.
+                const seatBlock = effectiveOpts
+                    ? buildSeatDirectiveBlock({ ...effectiveOpts, planIds }, out)
+                    : '';
```

### 4. `src/webview/terminals.js` (line 4673 area) — record the fix at the call site

Extend the existing comment block on the normal-drop branch so the next reader knows why a composed prompt is safe to POST:

```js
// The prompt returned by promptSelected is already composed by
// agentPromptBuilder. The delivery layer cannot be told that over HTTP
// (addonsComposed is stripped at the boundary as a safeguard), so the seat
// directive block dedupes itself against the prompt instead — see
// buildSeatDirectiveBlock's existingPrompt argument.
```

### 5. Test — `src/test/seat-safeguards-fleet-prompt-path.test.js` (the seat-directive suite)

> **Superseded:** The original plan placed tests in `src/services/__tests__/` and ran them with `npx jest`.
> **Reason:** That directory and runner do not exist in this codebase. The seat-directive suite is `src/test/seat-safeguards-fleet-prompt-path.test.js` — a plain `node` script run via `node --require ./src/test/bootstrap/sandboxStateHome.js`, which loads assertions from `out/services/*.js` (requires `npm run compile-tests` first).
> **Replaced with:** Add the new cases to the existing `src/test/seat-safeguards-fleet-prompt-path.test.js` file, in the BEHAVIOUR section alongside the existing `buildSeatDirectiveBlock` assertions.

Add three cases:

```ts
test('BEHAVIOUR: omits directives the composed prompt already carries', () => {
    const opts = { skipTests: true, cavemanOutput: true, gitProhibitionEnabled: true, gitBranchStrategy: 'current', gitCommitStrategy: 'whenDone', gitPushStrategy: 'noPush' };
    const full = buildSeatDirectiveBlock(opts);
    assert.strictEqual(
        buildSeatDirectiveBlock(opts, `some board prompt\n\n${full}`),
        '',
        'A board-composed prompt that already carries every part must yield an empty seat block.'
    );
});

test('BEHAVIOUR: still emits parts the composed prompt lacks', () => {
    const opts = { skipTests: true, cavemanOutput: true };
    const out = buildSeatDirectiveBlock(opts, `board prompt\n\n${SKIP_TESTS_DIRECTIVE}`);
    assert.ok(out.includes(CAVEMAN_OUTPUT_DIRECTIVE), 'Caveman directive must still be delivered when absent from the composed prompt.');
    assert.ok(!out.includes(SKIP_TESTS_DIRECTIVE), 'Skip-tests directive must NOT be re-delivered when already present.');
});

test('BEHAVIOUR: a divergent worktree git policy is NOT deduped against the board non-worktree policy', () => {
    const boardOpts = { gitProhibitionEnabled: true, gitBranchStrategy: 'current', gitCommitStrategy: 'whenDone', gitPushStrategy: 'noPush', worktreeActive: false };
    const seatOpts = { gitProhibitionEnabled: true, gitBranchStrategy: 'current', gitCommitStrategy: 'whenDone', gitPushStrategy: 'noPush', worktreeActive: true };
    const boardBlock = buildSeatDirectiveBlock(boardOpts);
    const seatBlock = buildSeatDirectiveBlock(seatOpts, `board prompt\n\n${boardBlock}`);
    // If the two git policy lines differ (worktree flag changes the output), the
    // seat's policy MUST still appear in the filtered block.
    const boardGit = buildGitPolicyBlock({ branch: 'current', commit: 'whenDone', push: 'noPush', guardrail: true, worktreeActive: false });
    const seatGit = buildGitPolicyBlock({ branch: 'current', commit: 'whenDone', push: 'noPush', guardrail: true, worktreeActive: true });
    if (boardGit !== seatGit) {
        assert.ok(seatBlock.includes(seatGit), 'A divergent worktree git policy must NOT be deduped — it is seat-scoped truth.');
    }
    // If they happen to be identical (worktree flag does not change the line for
    // this clause set), the seat block is empty — also correct.
});
```

## Verification Plan

> **Superseded:** `npx jest src/services/__tests__` (or the repo's test runner).
> **Reason:** The repo has no jest configuration for this suite and no `src/services/__tests__/` directory. The seat-directive suite is a plain `node` script.
> **Replaced with:** The actual commands below.

### Automated Tests

1. `npm run compile-tests` — compiles `src/services/*.ts` to `out/services/*.js` so the test can load the builder.
2. `node --require ./src/test/bootstrap/sandboxStateHome.js src/test/seat-safeguards-fleet-prompt-path.test.js` — the three new cases pass and the existing seat-directive suite stays green.

*(Session directive: compilation and tests are NOT executed in this improve pass — the checks remain written down for the coder.)*

### Manual

3. Manual, browser cockpit (`/terminals`):
   - Put a terminal in one pane and a kanban column in another (pane mode → kanban).
   - Enable at least two visible add-ons for that terminal's role in the AGENTS/PROMPTS tab (e.g. Skip tests + Caveman output) so the duplication is easy to see.
   - Drag a card onto the terminal pane.
   - **Expect:** each directive appears exactly once in the delivered prompt. Before the fix, each appears twice.
4. Scroll back in the same terminal and confirm the standing-orders block still appears exactly once and last.
5. Regression — a non-composed HTTP send still gets its full seat block:
   ```
   curl -s -X POST http://127.0.0.1:$(cat .switchboard/api-server-port.txt)/terminals/verb/ptySendPrompt \
     -H 'Content-Type: application/json' \
     -d '{"name":"<a live seat>","data":"hello","clearBeforePrompt":false}'
   ```
   The seat's configured directives must still arrive.
6. Standalone parity: run the npx host, repeat step 3 against its `/terminals` page, confirm the same single-copy result.

---

**Recommendation: Send to Coder** (complexity 4 — single-function change with two call-site wirings and three test cases; no architectural surface, but the cache interaction and git-policy divergence require care).

## Completion Report

Implemented seat-directive deduplication in `buildSeatDirectiveBlock` by adding an optional `existingPrompt` parameter to filter directives already present in the prompt string. Updated `TaskViewerProvider.ts` and `bootstrap.ts` to pass the stripped prompt text (`data` and `out` respectively) into `buildSeatDirectiveBlock`. Updated comments in `terminals.js` and added unit test cases covering directive deduping, partial additions, and divergent worktree git policy in `seat-safeguards-fleet-prompt-path.test.js`. No issues encountered.

