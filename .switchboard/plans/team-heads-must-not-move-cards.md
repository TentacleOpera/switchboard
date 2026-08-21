# Team-Head Standing Orders Must Prohibit All Card Movement Except Reviewer Dispatch

## Goal

Team leads are moving cards when they should not. Two observed failures:

1. **Backwards movement:** A team lead moved a card from CODER CODED back to PLAN REVIEWED, intending to re-dispatch a coder for remaining work. This sent the card through the planning pipeline again for no reason. The correct action was to dispatch a coder directly from CODER CODED — no column change needed.

2. **Forward movement misinterpretation:** A team lead interpreted the word "advance" in its standing orders as a general instruction to move cards to new columns. The current headPrompt says "Only advance the feature your team worked" — the word "advance" is being read as "move the card," not "trigger review via POST /kanban/dispatch."

### Root cause

The current `NEW_CODING_HEAD_PROMPT` (teamWiring.ts:783) tells the team lead to "advance" the card and describes POST /kanban/dispatch as "that one call moves the card and dispatches the reviewer." This language teaches the lead that card movement is its job. The reviewer-conditional ("If your team has a reviewer seat...") is buried in a wall of text mid-prompt, not stated as a hard rule. The result: leads move cards backwards when they need to re-dispatch, and move cards forward when they shouldn't.

The fix is a **body edit** (option b per user direction): restructure the Coding team headPrompt to remove all "advance" / "moves the card" language, state the card-movement restrictions as hard rules, and frame POST /kanban/dispatch solely as "trigger review" — never as "move the card." The Review team headPrompt gets the same backwards-movement prohibition appended.

### The rules

1. **Never move a card backwards to an earlier pipeline stage.** Only the orchestrator may do that. If a coder completed only part of the work and the card remains in a coded column, dispatch another coder directly from that column — do not move the card back.

2. **Never move a card to a new column yourself.** The team lead's only card action is POST /kanban/dispatch, and only when a reviewer is in the team. If no reviewer is present, post a finished report and stop. The card stays where it is.

## Metadata

**Complexity:** 7
**Tags:** bugfix, backend, reliability, refactor
**Project:** Browser Switchboard

## User Review Required

This plan modifies durable standing-order text shipped to ~4,000 installs. Unlike the prior commit-instruction migration (which was pure-append), this is a **body edit** — text is removed and restructured in the middle of the prompt, not appended at the end. The migration strategy uses a traditional positive-fragment match (a phrase unique to the old text that is removed from the new text), which is simpler than the negative-check approach but must be verified to not collide with existing recogniser fragments. A coder should verify the `PRE_CARD_MOVEMENT_RULE_HEADPROMPT_FRAGMENT` constant is present in the frozen snapshot and absent from the new text before implementation.

## Complexity Audit

### Routine

- Freezing two current headPrompt values as snapshot constants (same pattern as 5 prior frozen snapshots)
- Adding two migration recognisers (same pattern as 5 prior recognisers)
- Updating three mirror sites (teamWiring.ts, kanban.html, terminals.js) — text changes, same byte-identity rule
- Updating contract test assertions (load-bearing literal list, fragment two-copy rule, migration idempotency)

### Complex / Risky

- **Body edit breaks pure-append pattern:** All prior headPrompt migrations (role-boundary, commit-instruction) were append-only. This is the first migration that removes and restructures text in the middle of the prompt. The migration is actually simpler (a removed phrase is a unique positive fragment), but the pattern departure must be verified against the contract tests.
- **`terminals.js` mirror synchronization:** `NEW_CODING_HEAD_PROMPT_CLIENT` and the rewriter mirror in `terminals.js` must be updated alongside `teamWiring.ts`. The `stage-marker-commit-contract.test.js` enforces byte-identity — a missed mirror breaks the test and ships divergent delivery between host and webview.
- **Contract test load-bearing literal changes:** The test at `stage-marker-commit-contract.test.js:392-401` asserts `NEW_CODING_HEAD_PROMPT` includes specific literals. Some of these ("Do NOT use /kanban/move") survive the edit; others may need rewording. The test at `standing-orders-marker-contract.test.js:370` asserts the headPrompt "must reference POST /kanban/dispatch — the endpoint that advances the card AND dispatches the reviewer" — this comment uses "advances" but the assertion checks for `/kanban/dispatch` which survives. The assertion at line 375 checks for "Do NOT use /kanban/move" which also survives (we keep the warning, just shorten it).
- **Review team standing-orders rewriter gap (pre-existing):** `migrateCodingTeamOrders` only handles Coding team head orders. Review team head orders are never rewritten on the read path. The `migrateAgentGroups` recogniser fixes the agent group's `headPrompt`, but the persisted `team-head` standing order is not updated (wireSpawnedTeam skips when `headExists`). This is a pre-existing gap — the new Review team rule (backwards-movement prohibition) will reach new and re-spawned Review teams but not already-spawned ones until re-spawn.

## Edge-Case & Dependency Audit

### Race Conditions

- None new. The migration runs synchronously in `migrateAgentGroups` on every DB read. The standing-order rewriter runs in-memory at read sites. No concurrent-write hazard introduced.

### Security

- None. No new endpoints, no new user input surfaces, no new file paths.

### Side Effects

- **POST /kanban/dispatch reframed as "trigger review":** The lead still calls the same endpoint with the same body. The behavioral change is purely in how the instruction is worded — the lead is told it is triggering review, not moving a card. The endpoint still moves the card to CODE REVIEWED and dispatches the reviewer; the lead just doesn't think of it as "moving the card."
- **"Do NOT use /kanban/move" shortened:** The current text says "Do NOT use /kanban/move: it moves the card and dispatches nobody." The new text shortens this to "Do NOT use /kanban/move." The reason clause is removed because it uses "moves the card" language. The warning itself survives — the contract test at `standing-orders-marker-contract.test.js:375` checks for "Do NOT use /kanban/move" which is still present.
- **Review team head receives backwards-movement prohibition:** The Review team head (reviewer role) gets "Never move a card backwards" prepended to its standing orders. The reviewer doesn't currently move cards, so this is a guardrail, not a behavioral change.

### Dependencies & Conflicts

- **`stage-marker-commit-contract.test.js`**: Enforces byte-identity between `NEW_CODING_HEAD_PROMPT` (teamWiring.ts) and `NEW_CODING_HEAD_PROMPT_CLIENT` (terminals.js), fragment byte-identity across both files, and migration idempotency. The load-bearing literal test (line 392-401) must be updated to reflect removed/changed literals. New fragment and snapshot assertions must be added.
- **`standing-orders-marker-contract.test.js`**: Enforces byte-identical headPrompts between `kanban.html` and `teamWiring.ts`. Both must move together. The assertion at line 370 references "advances the card" in its comment but checks for `/kanban/dispatch` — the assertion survives, the comment is stale but harmless.
- **`seat-safeguards-fleet-prompt-path.test.js`**: Not directly affected — it tests `notifyTurnEnd` and `deliverPrompt` call signatures, not headPrompt content.
- **`terminals.js` cannot import from `teamWiring.ts`**: All shared constants (fragments, prompt text) must be hand-mirrored. The two-copy rule is enforced by `stage-marker-commit-contract.test.js`.
- **Sibling plans (already implemented):** `turn-end-notifications-must-carry-standing-orders.md` and `team-head-standing-orders-must-carry-commit-instruction.md` are already coded — the commit instruction is in the current `NEW_CODING_HEAD_PROMPT` and `NEW_REVIEW_TEAM_HEAD_PROMPT`. This plan builds on top of that state: the frozen snapshots include the commit instruction, and the new text preserves it.

## Dependencies

None — this plan is self-contained. The commit-instruction migration is already implemented and shipped in the current `NEW_CODING_HEAD_PROMPT` / `NEW_REVIEW_TEAM_HEAD_PROMPT`. This plan freezes those as snapshots and produces new versions with restructured card-movement language.

## Adversarial Synthesis

Key risks: (1) the body edit removes "Only advance the feature your team worked" — this phrase is also present in `PRE_ROLE_BOUNDARY_CODING_HEAD_PROMPT` (line 725), so the new rewriter fragment will match pre-role-boundary rows too. This is harmless: those rows are already matched by `PRE_ROLE_BOUNDARY_HEADPROMPT_FRAGMENT` ('then make one call: ') and rewritten to the new text. The OR conditions mean a row matching multiple fragments is rewritten once — no double-rewrite. (2) The new text must still contain `COMMIT_INSTRUCTION_MARKER` so the pre-commit-instruction negative check does not re-match already-migrated rows. The commit instruction is preserved in the new text. (3) The new text must NOT contain the new fragment (`PRE_CARD_MOVEMENT_RULE_HEADPROMPT_FRAGMENT`) so rewritten rows don't re-match. The fragment "Only advance the feature your team worked" is removed entirely from the new text. Mitigations: verify fragment presence in frozen snapshot and absence in new text via contract test assertions; verify `COMMIT_INSTRUCTION_MARKER` presence in new text.

## Proposed Changes

### Part 1 — Coding team headPrompt: restructure card-movement language

**1a. Freeze current `NEW_CODING_HEAD_PROMPT` as `PRE_CARD_MOVEMENT_RULE_CODING_HEAD_PROMPT` — `src/services/teamWiring.ts` (~line 783)**

Rename the current `NEW_CODING_HEAD_PROMPT` value to `PRE_CARD_MOVEMENT_RULE_CODING_HEAD_PROMPT` (frozen snapshot, same pattern as all prior frozen snapshots). Never edit the snapshot — it is what is on ~4,000 installs' disks today (including the commit instruction appended by the prior migration).

**1b. Define a new rewriter fragment constant — `src/services/teamWiring.ts`**

Add near the existing fragment constants (~line 2207):

```ts
/**
 * Substitution-independent fragment unique to the pre-card-movement-rule
 * Coding team headPrompt (the current NEW_CODING_HEAD_PROMPT before this
 * change). The phrase "Only advance the feature your team worked" is
 * REMOVED from the new text, so this is a traditional positive match —
 * unlike the pre-commit-instruction recogniser, no negative check is
 * needed. A rewritten row does not contain this fragment and does not
 * re-match.
 *
 * This fragment also appears in PRE_ROLE_BOUNDARY_CODING_HEAD_PROMPT
 * (line 725), but those rows are already matched by
 * PRE_ROLE_BOUNDARY_HEADPROMPT_FRAGMENT ('then make one call: '). The
 * OR conditions mean a row matching both fragments is rewritten once.
 *
 * Two copies only: this one and the terminals.js mirror.
 * stage-marker-commit-contract.test.js gates both halves.
 */
export const PRE_CARD_MOVEMENT_RULE_HEADPROMPT_FRAGMENT = 'Only advance the feature your team worked';
```

**1c. Write the new `NEW_CODING_HEAD_PROMPT` — `src/services/teamWiring.ts`**

The new text restructures the "When every subtask is finished" block. Key changes from the current text:

- **Add hard rules at the top of the completion block:** "Never move a card backwards to an earlier pipeline stage — only the orchestrator may do that. Never move a card to a new column yourself."
- **Reframe POST /kanban/dispatch:** Change "that one call moves the card and dispatches the reviewer" → "that one call triggers review by dispatching the reviewer" (removes "moves the card").
- **Remove "advance" language:** Delete "Only advance the feature your team worked; leave other cards alone." entirely.
- **Shorten /kanban/move warning:** Change "Do NOT use /kanban/move: it moves the card and dispatches nobody." → "Do NOT use /kanban/move." (removes "moves the card" language, keeps the warning).
- **Broaden no-reviewer instruction:** Change "do NOT move the card to CODE REVIEWED" → "do NOT move the card" (not column-specific — the lead should not move the card at all without a reviewer).
- **Preserve the commit instruction** at the end (unchanged).

The full new `NEW_CODING_HEAD_PROMPT` (showing only the changed section, from "When every subtask" onward; everything before that is identical):

```ts
// ... (everything before "When every subtask" is identical to current) ...
    + 'When every subtask of the feature is finished, read the '
    + 'port from .switchboard/api-server-port.txt, confirm no subtask is still outstanding via GET '
    + '/kanban/plans?featureId=<the FEATURE planId>&workspaceRoot=<your current working directory — run '
    + 'pwd> (that read returns one record per subtask, each with its kanbanColumn). '
    + 'Never move a card backwards to an earlier pipeline stage — only the orchestrator may do that. '
    + 'Never move a card to a new column yourself. '
    + 'Check your team roster (the YOUR TEAM block in your prompt or ptyListTerminals) for a seat '
    + 'with role "reviewer". If your team has a reviewer seat, make one call: '
    + 'POST /kanban/dispatch with '
    + '{"plan":"<the FEATURE planId>","targetColumn":"CODE REVIEWED","from":"{head}","workspaceRoot":'
    + '"<your current working directory — run pwd>"} — that one call triggers review by dispatching '
    + 'the reviewer with the reviewer\'s own prompt. Do NOT use /kanban/move. '
    + 'Do not wait to be asked. When the reviewer reports the feature passed, POST /kanban/queue/next with '
    + '{"from":"{head}"} against the port in .switchboard/api-server-port.txt; if it returns '
    + 'a dispatched card, work it; if it returns dispatched: null, report that the queue is '
    + 'empty and stop. '
    + 'If your team has NO reviewer seat, do NOT move the card — that is not your role. '
    + 'Post a finished report to .switchboard/orchestrator/reports/ naming the feature and its planId, '
    + 'and stop. The card stays where it is.'
    + ' When the work is complete, stage the files you changed by explicit path '
    + '— never `git add -A` or `git add .`. Then create a single commit with a '
    + 'descriptive message.';
```

**Load-bearing literals preserved** (verified against `stage-marker-commit-contract.test.js:392-401`):
- `/kanban/dispatch` — present
- `CODE REVIEWED` — present
- `"from":"{head}"` — present
- `Do NOT use /kanban/move` — present (shortened but substring survives)
- `GET /kanban/plans?featureId=` — present
- `FEATURE planId` — present
- `intern → coder → lead` — present (unchanged section)
- `seat fails review on the same subtask twice` — present (unchanged section)
- `stop and report to the human instead of dispatching again` — present (unchanged section)
- `PLAN FILES ARE THE SOURCE OF TRUTH` — present (unchanged section)
- `If your team has NO reviewer seat` — present (reworded but substring survives: "If your team has NO reviewer seat, do NOT move the card")

**Load-bearing literals removed** (must be removed from the test assertion list):
- `Only advance the feature your team worked` — removed (this is the fragment)

**New load-bearing literals to add to the test assertion list:**
- `Never move a card backwards` — the new hard rule
- `Never move a card to a new column yourself` — the new hard rule
- `triggers review by dispatching` — the reframed POST /kanban/dispatch description

**1d. Update `NEW_CODING_HEAD_PROMPT_CLIENT` in `terminals.js` — `src/webview/terminals.js` (~line 10722)**

Replace the entire `NEW_CODING_HEAD_PROMPT_CLIENT` value with the byte-identical new text. Since `terminals.js` cannot import from `teamWiring.ts`, the text must be hand-copied (same two-copy rule as all other shared constants).

**1e. Update the kanban.html Coding team headPrompt — `src/webview/kanban.html` (~line 4752)**

Replace the headPrompt value with the byte-identical new text. The `standing-orders-marker-contract.test.js` enforces byte-identical headPrompts between kanban.html and teamWiring.ts.

### Part 2 — Review team headPrompt: add backwards-movement prohibition

**2a. Freeze current `NEW_REVIEW_TEAM_HEAD_PROMPT` as `PRE_CARD_MOVEMENT_RULE_REVIEW_HEAD_PROMPT` — `src/services/teamWiring.ts` (~line 856)**

Same freeze pattern. The current Review team headPrompt (with commit instruction) becomes the frozen snapshot.

**2b. Write the new `NEW_REVIEW_TEAM_HEAD_PROMPT` — `src/services/teamWiring.ts`**

Prepend the backwards-movement prohibition to the existing text (this is an append/prepend, not a body edit — the Review team headPrompt has no "advance" language to remove):

```ts
export const NEW_REVIEW_TEAM_HEAD_PROMPT =
    'Never move a card backwards to an earlier pipeline stage — only the orchestrator may do that. '
    + 'Never move a card to a new column yourself. '
    + 'You are the reviewer on a review team. When work lands in your terminal, review it '
    + '(Stage 1: adversarial findings, Stage 2: balanced synthesis). Apply a fully diagnosed fix set under '
    // ... (rest identical to current) ...
    + 'descriptive message.';
```

**2c. Update the kanban.html Review team headPrompt — `src/webview/kanban.html` (~line 4811)**

Replace with the byte-identical new text.

**Note:** `terminals.js` has no Review team headPrompt mirror (`NEW_CODING_HEAD_PROMPT_CLIENT` is Coding-only). No terminals.js change needed for the Review team.

### Part 3 — Migration recognisers

**3a. Add `isUntouchedPreCardMovementRuleCodingTeam` recogniser — `src/services/teamWiring.ts` (~line 1341, alongside existing recognisers)**

```ts
function isUntouchedPreCardMovementRuleCodingTeam(group: any): boolean {
    if (!group || group.headRole !== 'lead') { return false; }
    return typeof group.headPrompt === 'string'
        && group.headPrompt === PRE_CARD_MOVEMENT_RULE_CODING_HEAD_PROMPT;
}
```

Add to the migration loop alongside the existing recognisers (after the pre-commit-instruction recogniser at ~line 1035):

```ts
        // Step 1f: convert an install that already migrated to the
        // commit-instruction headPrompt but before the card-movement-rule
        // restructuring. Exact-value match on
        // PRE_CARD_MOVEMENT_RULE_CODING_HEAD_PROMPT; an operator-edited group
        // does not match and is left alone.
        if (isUntouchedPreCardMovementRuleCodingTeam(g)) {
            g = {
                ...g,
                headPrompt: NEW_CODING_HEAD_PROMPT,
            };
            changed = true;
            console.log(
                `[teamWiring] Migration: restructured card-movement language in Coding team `
                + `'${g.id || g.name}' — headPrompt → card-movement rules.`
            );
        }
```

**3b. Add `isUntouchedPreCardMovementRuleReviewTeam` recogniser — `src/services/teamWiring.ts`**

```ts
function isUntouchedPreCardMovementRuleReviewTeam(group: any): boolean {
    if (!group || group.headRole !== 'reviewer') { return false; }
    return typeof group.headPrompt === 'string'
        && group.headPrompt === PRE_CARD_MOVEMENT_RULE_REVIEW_HEAD_PROMPT;
}
```

Add to the migration loop (after the pre-commit-instruction Review recogniser at ~line 1052):

```ts
        // Step 1f (Review): convert an install that already migrated to the
        // commit-instruction Review headPrompt but before the card-movement
        // rule was prepended. Exact-value match on
        // PRE_CARD_MOVEMENT_RULE_REVIEW_HEAD_PROMPT; an operator-edited group
        // does not match and is left alone.
        if (isUntouchedPreCardMovementRuleReviewTeam(g)) {
            g = { ...g, headPrompt: NEW_REVIEW_TEAM_HEAD_PROMPT };
            changed = true;
            console.log(`[teamWiring] Migration: added card-movement rule to Review team '${g.id || g.name}'.`);
        }
```

### Part 4 — Standing-order rewriter update

**4a. Add the new fragment to the rewriter — `src/services/teamWiring.ts` (`migrateCodingTeamOrders`, ~line 2274)**

Add a new condition to the existing OR chain. This is a traditional positive match (the fragment is removed from the new text, so rewritten rows don't re-match):

```ts
        if (o.scope === 'team-head' && typeof o.instruction === 'string') {
            if (o.instruction.indexOf(OLD_HEADPROMPT_FRAGMENT) !== -1
                || o.instruction.indexOf(BUGGY_HEADPROMPT_FRAGMENT) !== -1
                || o.instruction.indexOf(PRE_ROLE_BOUNDARY_HEADPROMPT_FRAGMENT) !== -1
                // Pre-card-movement-rule rows. The fragment "Only advance the
                // feature your team worked" is REMOVED from the new text, so
                // this is a traditional positive match — no negative check
                // needed. A rewritten row does not contain the fragment.
                // Note: this fragment also appears in PRE_ROLE_BOUNDARY rows,
                // but those are already matched by PRE_ROLE_BOUNDARY_FRAGMENT;
                // the OR means no double-rewrite.
                || o.instruction.indexOf(PRE_CARD_MOVEMENT_RULE_HEADPROMPT_FRAGMENT) !== -1
                || (o.instruction.indexOf(PRE_COMMIT_INSTRUCTION_HEADPROMPT_FRAGMENT) !== -1
                    && o.instruction.indexOf(COMMIT_INSTRUCTION_MARKER) === -1)) {
```

**Important ordering note:** The new fragment condition must come BEFORE the pre-commit-instruction negative check. Here's why: the current `NEW_CODING_HEAD_PROMPT` (which becomes `PRE_CARD_MOVEMENT_RULE_CODING_HEAD_PROMPT`) contains both `PRE_CARD_MOVEMENT_RULE_HEADPROMPT_FRAGMENT` ("Only advance the feature your team worked") AND `COMMIT_INSTRUCTION_MARKER`. The pre-commit-instruction negative check requires the marker to be ABSENT, so it does NOT match these rows. The new positive fragment match DOES match them. Since the conditions are OR'd, order doesn't actually matter for correctness — but placing the new condition first makes the intent clearer.

**4b. Mirror the rewriter update in `terminals.js` — `src/webview/terminals.js` (~line 10888)**

Add the fragment constant mirror:

```js
        // Mirror of PRE_CARD_MOVEMENT_RULE_HEADPROMPT_FRAGMENT in teamWiring.ts.
        // Recognises the commit-instruction headPrompt before the card-movement
        // restructuring. The fragment is REMOVED from the new text, so this is
        // a traditional positive match — no negative check needed.
        var PRE_CARD_MOVEMENT_RULE_HEADPROMPT_FRAGMENT = 'Only advance the feature your team worked';
```

Add the condition to the rewriter OR chain (~line 10916):

```js
            if (o.scope === 'team-head' && typeof o.instruction === 'string') {
                if (o.instruction.indexOf(OLD_HEADPROMPT_FRAGMENT) !== -1
                    || o.instruction.indexOf(BUGGY_HEADPROMPT_FRAGMENT) !== -1
                    || o.instruction.indexOf(PRE_ROLE_BOUNDARY_HEADPROMPT_FRAGMENT) !== -1
                    || o.instruction.indexOf(PRE_CARD_MOVEMENT_RULE_HEADPROMPT_FRAGMENT) !== -1
                    || (o.instruction.indexOf(PRE_COMMIT_INSTRUCTION_HEADPROMPT_FRAGMENT) !== -1
                        && o.instruction.indexOf(COMMIT_INSTRUCTION_MARKER) === -1)) {
```

### Part 5 — Contract test updates

**5a. Update `stage-marker-commit-contract.test.js`**

1. **Load-bearing literal test (line 392-401):** Remove `'Only advance the feature your team worked'` is not in the current list — but the test at line 399 checks `!NEW_CODING_HEAD_PROMPT.includes('satisfied with it, hand it to review yourself')` which still passes. Add new assertions:
   - `assert.ok(NEW_CODING_HEAD_PROMPT.includes('Never move a card backwards'), ...)`
   - `assert.ok(NEW_CODING_HEAD_PROMPT.includes('Never move a card to a new column yourself'), ...)`
   - `assert.ok(NEW_CODING_HEAD_PROMPT.includes('triggers review by dispatching'), ...)`
   - `assert.ok(!NEW_CODING_HEAD_PROMPT.includes('Only advance the feature your team worked'), 'the new text must not contain the fragment the rewriter matches on')`

2. **Fragment two-copy rule test:** Add a new test block for `PRE_CARD_MOVEMENT_RULE_HEADPROMPT_FRAGMENT` following the pattern of the existing fragment tests (lines 549-601). Assert:
   - The fragment exists in exactly two files (teamWiring.ts and terminals.js)
   - The fragment is byte-identical across both files
   - `PRE_CARD_MOVEMENT_RULE_CODING_HEAD_PROMPT.includes(PRE_CARD_MOVEMENT_RULE_HEADPROMPT_FRAGMENT)` is true
   - `!NEW_CODING_HEAD_PROMPT.includes(PRE_CARD_MOVEMENT_RULE_HEADPROMPT_FRAGMENT)` is true (rewritten rows don't re-match)

3. **Migration recogniser tests:** Add tests following the pattern of the pre-commit-instruction tests (lines 699-730):
   - A persisted team-head order carrying `PRE_CARD_MOVEMENT_RULE_CODING_HEAD_PROMPT` is rewritten to `NEW_CODING_HEAD_PROMPT` and is idempotent
   - `migrateAgentGroups` converts an untouched pre-card-movement-rule Coding team and is idempotent

4. **Byte-identity test (line 359-366):** Already asserts `NEW_CODING_HEAD_PROMPT_CLIENT === NEW_CODING_HEAD_PROMPT`. This passes automatically once both are updated — no test change needed, but it will fail if only one is updated.

**5b. Update `standing-orders-marker-contract.test.js`**

1. **Review headPrompt assertions (line 408-421):** Add assertions for the new Review team card-movement rule:
   - `assert.ok(reviewHeadPrompt.includes('Never move a card backwards'), ...)`

2. **Coding headPrompt assertions (line 366-388):** The existing assertions check for `/kanban/dispatch`, `CODE REVIEWED`, `"from":"{head}"`, `Do NOT use /kanban/move`, `workspaceRoot`, and `If your team has NO reviewer seat`. All of these survive the edit. No changes needed to existing assertions. The assertion at line 370 says "the endpoint that advances the card AND dispatches the reviewer" in its comment — the comment is stale (we removed "advances" language) but the assertion checks for `/kanban/dispatch` which survives. Optionally update the comment.

## What does NOT change

- **Per-dispatch GIT POLICY block** — `buildGitPolicyBlock` continues to compose branch/commit/push/safety per-dispatch. Unchanged.
- **Member standing orders** — the `team` scoped order is unchanged. Members still get `dontCommit` in the per-dispatch block.
- **All prior frozen snapshot constants** — `OLD_CODING_HEAD_PROMPT`, `CURRENT_BUGGY_CODING_HEAD_PROMPT`, `PRE_ROLE_BOUNDARY_CODING_HEAD_PROMPT`, `PRE_COMMIT_INSTRUCTION_CODING_HEAD_PROMPT`, `OLD_REVIEW_TEAM_HEAD_PROMPT`, `PRE_COMMIT_INSTRUCTION_REVIEW_HEAD_PROMPT` — never edited.
- **Startup delivery** (`_deliverStandingOrdersOnEstablish`) — unchanged.
- **Per-dispatch `applyStandingOrders`** — unchanged.
- **Turn-end notification delivery** — unchanged (already fixed by the sibling plan).
- **POST /kanban/dispatch endpoint** — unchanged. The endpoint still moves the card to CODE REVIEWED and dispatches the reviewer. Only the prompt wording changes — the lead is told it is "triggering review," not "moving the card."
- **Planning team headPrompts** — unchanged. Planning team heads don't move cards.

## Verification Plan

1. `node --require ./src/test/bootstrap/sandboxStateHome.js src/test/stage-marker-commit-contract.test.js` — all tests pass, including new fragment/migration assertions
2. `node --require ./src/test/bootstrap/sandboxStateHome.js src/test/standing-orders-marker-contract.test.js` — all tests pass, including new Review team assertion
3. `node --require ./src/test/bootstrap/sandboxStateHome.js src/test/seat-safeguards-fleet-prompt-path.test.js` — unaffected, should pass as-is
4. Manual verification: `NEW_CODING_HEAD_PROMPT` does not contain "advance" or "moves the card" (grep the constant value)
5. Manual verification: `NEW_CODING_HEAD_PROMPT` contains "Never move a card backwards" and "Never move a card to a new column yourself"
6. Manual verification: `NEW_REVIEW_TEAM_HEAD_PROMPT` contains "Never move a card backwards"
7. Manual verification: `PRE_CARD_MOVEMENT_RULE_HEADPROMPT_FRAGMENT` is present in `PRE_CARD_MOVEMENT_RULE_CODING_HEAD_PROMPT` and absent from `NEW_CODING_HEAD_PROMPT`
8. Manual verification: `COMMIT_INSTRUCTION_MARKER` is present in `NEW_CODING_HEAD_PROMPT` (commit instruction preserved)
