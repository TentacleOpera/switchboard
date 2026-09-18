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

This plan modifies durable standing-order text shipped to ~4,000 installs. Unlike the prior commit-instruction migration (which was pure-append), this is a **body edit** — text is removed and restructured in the middle of the prompt, not appended at the end. The migration strategy uses a traditional positive-fragment match (a phrase unique to the old text that is removed from the new text), gated on `COMMIT_INSTRUCTION_MARKER` being present to avoid matching pre-commit-instruction rows. The improve pass discovered THREE CRITICAL test breakages that the original plan did not address: (1) the append-only invariant test at line 726 breaks because the body edit breaks the `snapshot + commit_instruction = NEW` relation; (2) the pre-commit-instruction rewriter test at line 706 breaks because the append now produces intermediate text, not the new text; (3) the operator-edit preservation test at line 747 breaks because the appended row re-matches the replace block on pass 2. All three are addressed in Part 5a items 5-7. A coder should verify the `PRE_CARD_MOVEMENT_RULE_HEADPROMPT_FRAGMENT` constant is present in the frozen snapshot and absent from the new text, and that the marker gate (`COMMIT_INSTRUCTION_MARKER !== -1`) is present in both the teamWiring.ts and terminals.js rewriter conditions before implementation.

## Complexity Audit

### Routine

- Freezing two current headPrompt values as snapshot constants (same pattern as 5 prior frozen snapshots)
- Adding two migration recognisers (same pattern as 5 prior recognisers)
- Updating three mirror sites (teamWiring.ts, kanban.html, terminals.js) — text changes, same byte-identity rule
- Updating contract test assertions (load-bearing literal list, fragment two-copy rule, migration idempotency)

### Complex / Risky

- **Body edit breaks pure-append pattern:** All prior headPrompt migrations (role-boundary, commit-instruction) were append-only. This is the first migration that removes and restructures text in the middle of the prompt. The migration is actually simpler (a removed phrase is a unique positive fragment), but the pattern departure must be verified against the contract tests.
- **`terminals.js` mirror synchronization:** `NEW_CODING_HEAD_PROMPT_CLIENT` and the rewriter mirror in `terminals.js` must be updated alongside `teamWiring.ts`. The `stage-marker-commit-contract.test.js` enforces byte-identity — a missed mirror breaks the test and ships divergent delivery between host and webview.
- **Contract test load-bearing literal changes:** The test at `stage-marker-commit-contract.test.js:395-404` asserts `NEW_CODING_HEAD_PROMPT` includes specific literals. Some of these ("Do NOT use /kanban/move") survive the edit; others may need rewording. The test at `standing-orders-marker-contract.test.js:370` asserts the headPrompt "must reference POST /kanban/dispatch — the endpoint that advances the card AND dispatches the reviewer" — this comment uses "advances" but the assertion checks for `/kanban/dispatch` which survives. The assertion at line 375 checks for "Do NOT use /kanban/move" which also survives (we keep the warning, just shorten it).
- **Append-only invariant test breakage (CRITICAL — discovered during improve pass):** The test at `stage-marker-commit-contract.test.js:726-740` asserts `PRE_COMMIT_INSTRUCTION_CODING_HEAD_PROMPT + TEAM_HEAD_COMMIT_INSTRUCTION === NEW_CODING_HEAD_PROMPT` and the same for Review. The test comment at line 721-725 explicitly warns: "Edit either NEW_* body without re-freezing its snapshot and an appended row stops equalling the shipped text." This plan's body edit breaks the relation for BOTH teams — `NEW_CODING_HEAD_PROMPT` is restructured (not just appended to), and `NEW_REVIEW_TEAM_HEAD_PROMPT` has rules prepended. The test MUST be superseded and updated to assert the two-pass migration reaches the correct state instead of the append-only relation. See Part 5a item 5.
- **Pre-commit-instruction rewriter test breakage (CRITICAL — discovered during improve pass):** The test at `stage-marker-commit-contract.test.js:706-719` creates a pre-commit-instruction row, runs `migrateCodingTeamOrders`, and asserts `row.instruction === NEW_CODING_HEAD_PROMPT.replace(...)`. After the body edit, the APPEND path produces `PRE_COMMIT_INSTRUCTION_CODING_HEAD_PROMPT + TEAM_HEAD_COMMIT_INSTRUCTION` (the OLD `NEW_CODING_HEAD_PROMPT` = `PRE_CARD_MOVEMENT_RULE_CODING_HEAD_PROMPT`), NOT the new `NEW_CODING_HEAD_PROMPT`. The assertion at line 713 FAILS. The idempotency assertion at line 718 also FAILS — the appended row (now has marker + "Only advance...") matches the new fragment condition on pass 2 and is replaced. The test MUST be updated for two-pass migration. See Part 5a item 6.
- **Operator-edit preservation test breakage (CRITICAL — discovered during improve pass):** The test at `stage-marker-commit-contract.test.js:747-763` creates an operator-edited pre-commit-instruction row, runs `migrateCodingTeamOrders`, and asserts the operator's wording is preserved (append, not replace). Pass 1 still works (append preserves edits), but the idempotency assertion at line 761 FAILS — the appended row re-matches the new fragment condition on pass 2 and is replaced, losing the operator's wording. This is consistent with all prior supersessions (operator edits that retain a removed fragment are replaced), but the test MUST be updated to reflect the two-pass behavior. See Part 5a item 7.
- **Rewriter fragment condition needs marker gate (CRITICAL — discovered during improve pass):** The plan's original Part 4a added `PRE_CARD_MOVEMENT_RULE_HEADPROMPT_FRAGMENT` to the replace block WITHOUT checking `COMMIT_INSTRUCTION_MARKER`. But `PRE_COMMIT_INSTRUCTION_CODING_HEAD_PROMPT` (line 763) ALSO contains "Only advance the feature your team worked." Without a marker gate, pre-commit-instruction rows (no marker) match the replace condition and are REPLACED instead of APPENDED — destroying operator edits on the first pass. The fix: gate the new fragment on marker PRESENT (`&& o.instruction.indexOf(COMMIT_INSTRUCTION_MARKER) !== -1`). Pre-commit-instruction rows (no marker) fall through to the append path. See corrected Part 4a.
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
- **Two-pass migration for pre-commit-instruction rows (discovered during improve pass):** The body edit breaks the append-only invariant — `NEW_CODING_HEAD_PROMPT` is no longer `PRE_COMMIT_INSTRUCTION_CODING_HEAD_PROMPT + TEAM_HEAD_COMMIT_INSTRUCTION`. The pre-commit-instruction APPEND path in `migrateCodingTeamOrders` still fires for rows without `COMMIT_INSTRUCTION_MARKER`, appending the commit instruction and producing `PRE_CARD_MOVEMENT_RULE_CODING_HEAD_PROMPT` (the OLD `NEW_CODING_HEAD_PROMPT`). On the next read, this row now has the marker AND "Only advance the feature your team worked" → the new marker-gated replace condition matches → replaces with the new `NEW_CODING_HEAD_PROMPT`. Two-pass migration: append (pass 1) → replace (pass 2). Each pass is idempotent within its own recogniser. Between passes, the lead receives the old text (with "moves the card" and "advance") — this is the same intermediate-state behavior as all prior migrations that run on every read.

### Dependencies & Conflicts

- **`stage-marker-commit-contract.test.js`**: Enforces byte-identity between `NEW_CODING_HEAD_PROMPT` (teamWiring.ts) and `NEW_CODING_HEAD_PROMPT_CLIENT` (terminals.js), fragment byte-identity across both files, and migration idempotency. The load-bearing literal test (line 395-404) must be updated to reflect removed/changed literals. New fragment and snapshot assertions must be added. THREE ADDITIONAL TESTS MUST BE UPDATED (not just added):
  - **Line 726-740 (append-only invariant):** Asserts `PRE_COMMIT_INSTRUCTION_CODING_HEAD_PROMPT + TEAM_HEAD_COMMIT_INSTRUCTION === NEW_CODING_HEAD_PROMPT` and same for Review. BREAKS — body edit breaks the relation. Must be superseded and replaced with a two-pass migration assertion.
  - **Line 706-719 (pre-commit-instruction rewriter):** Asserts `row.instruction === NEW_CODING_HEAD_PROMPT.replace(...)` after append. BREAKS — append now produces `PRE_CARD_MOVEMENT_RULE_CODING_HEAD_PROMPT`, not the new text. Idempotency assertion also breaks. Must be updated for two-pass migration.
  - **Line 747-763 (operator-edit preservation):** Asserts operator's wording preserved and idempotent after append. Pass 1 still works, but idempotency at line 761 BREAKS — row re-matches new fragment on pass 2. Must be updated to reflect two-pass behavior (operator edits preserved on pass 1, replaced on pass 2).
- **`standing-orders-marker-contract.test.js`**: Enforces byte-identical headPrompts between `kanban.html` and `teamWiring.ts`. Both must move together. The assertion at line 370 references "advances the card" in its comment but checks for `/kanban/dispatch` — the assertion survives, the comment is stale but harmless.
- **`seat-safeguards-fleet-prompt-path.test.js`**: Not directly affected — it tests `notifyTurnEnd` and `deliverPrompt` call signatures, not headPrompt content.
- **`terminals.js` cannot import from `teamWiring.ts`**: All shared constants (fragments, prompt text) must be hand-mirrored. The two-copy rule is enforced by `stage-marker-commit-contract.test.js`.
- **Sibling plans (already implemented):** `turn-end-notifications-must-carry-standing-orders.md` and `team-head-standing-orders-must-carry-commit-instruction.md` are already coded — the commit instruction is in the current `NEW_CODING_HEAD_PROMPT` and `NEW_REVIEW_TEAM_HEAD_PROMPT`. This plan builds on top of that state: the frozen snapshots include the commit instruction, and the new text preserves it.

## Dependencies

None — this plan is self-contained. The commit-instruction migration is already implemented and shipped in the current `NEW_CODING_HEAD_PROMPT` / `NEW_REVIEW_TEAM_HEAD_PROMPT`. This plan freezes those as snapshots and produces new versions with restructured card-movement language.

## Adversarial Synthesis

Key risks: (1) **The append-only invariant test (line 726) breaks** — the body edit means `NEW_CODING_HEAD_PROMPT ≠ PRE_COMMIT_INSTRUCTION_CODING_HEAD_PROMPT + TEAM_HEAD_COMMIT_INSTRUCTION`. The test must be superseded and replaced with a two-pass migration assertion. (2) **The pre-commit-instruction rewriter test (line 706) and operator-edit test (line 747) break** — the append path now produces intermediate text (`PRE_CARD_MOVEMENT_RULE_CODING_HEAD_PROMPT`), not the new `NEW_CODING_HEAD_PROMPT`. The idempotency assertions break because the appended row re-matches the new fragment condition on pass 2. Tests must be updated for two-pass migration. (3) **The rewriter fragment condition needs a marker gate** — without `&& o.instruction.indexOf(COMMIT_INSTRUCTION_MARKER) !== -1`, pre-commit-instruction rows (which also contain "Only advance the feature your team worked") match the replace block and are REPLACED instead of APPENDED, destroying operator edits on the first pass. (4) The body edit removes "Only advance the feature your team worked" — this phrase is also present in `PRE_ROLE_BOUNDARY_CODING_HEAD_PROMPT` (line 714) and `PRE_COMMIT_INSTRUCTION_CODING_HEAD_PROMPT` (line 763). The PRE_ROLE_BOUNDARY overlap is harmless (those rows are already matched by `PRE_ROLE_BOUNDARY_HEADPROMPT_FRAGMENT`). The PRE_COMMIT_INSTRUCTION overlap is handled by the marker gate. (5) The new text must still contain `COMMIT_INSTRUCTION_MARKER` so the pre-commit-instruction negative check does not re-match already-migrated rows. The commit instruction is preserved in the new text. (6) The new text must NOT contain the new fragment (`PRE_CARD_MOVEMENT_RULE_HEADPROMPT_FRAGMENT`) so rewritten rows don't re-match. The fragment "Only advance the feature your team worked" is removed entirely from the new text. Mitigations: add marker gate to rewriter fragment condition; supersede append-only invariant test; update pre-commit-instruction and operator-edit tests for two-pass migration; verify fragment presence in frozen snapshot and absence in new text via contract test assertions; verify `COMMIT_INSTRUCTION_MARKER` presence in new text.

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
 * a rewritten row does not contain this fragment and does not re-match.
 *
 * GATED ON COMMIT_INSTRUCTION_MARKER being present: the fragment also
 * appears in PRE_COMMIT_INSTRUCTION_CODING_HEAD_PROMPT (line 763), which
 * does NOT carry the marker. Without the gate, pre-commit-instruction
 * rows would match the replace block and be REPLACED instead of falling
 * through to the append block. The gate ensures only post-commit-instruction
 * rows (marker present) are replaced; pre-commit-instruction rows (no
 * marker) are appended on pass 1 and replaced on pass 2.
 *
 * This fragment also appears in PRE_ROLE_BOUNDARY_CODING_HEAD_PROMPT
 * (line 714), but those rows are already matched by
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

**Load-bearing literals preserved** (verified against `stage-marker-commit-contract.test.js:395-404`):
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

**4a. Add the new fragment to the rewriter — `src/services/teamWiring.ts` (`migrateCodingTeamOrders`, ~line 2280)**

> **Superseded:** The original plan proposed adding `PRE_CARD_MOVEMENT_RULE_HEADPROMPT_FRAGMENT` to the replace block WITHOUT a marker check, and merging the replace and append conditions into one OR chain.
> **Reason:** `PRE_COMMIT_INSTRUCTION_CODING_HEAD_PROMPT` (line 763) also contains "Only advance the feature your team worked." Without a marker gate, pre-commit-instruction rows (no marker) match the replace condition and are REPLACED instead of APPENDED — destroying operator edits on the first pass. Merging the replace and append conditions into one OR chain is also impossible because the two blocks have different bodies (replace vs append).
> **Replaced with:** Add the new fragment to the REPLACE block (first `if`) with a positive marker check (`COMMIT_INSTRUCTION_MARKER` present). Keep the APPEND block (second `if`) as a separate block. Pre-commit-instruction rows (no marker) fall through to the append path. Appended rows (now have marker + fragment) are replaced on the next pass — two-pass migration.

Add a new condition to the existing REPLACE block (the first `if` inside the `team-head` scope check). This is a traditional positive match gated on the commit marker being PRESENT — the fragment is removed from the new text, so rewritten rows don't re-match. The marker gate ensures pre-commit-instruction rows (which also contain the fragment but lack the marker) are NOT matched here and fall through to the append block:

```ts
        if (o.scope === 'team-head' && typeof o.instruction === 'string') {
            // ── REPLACE block: superseded text (fragment removed from new text) ──
            if (o.instruction.indexOf(OLD_HEADPROMPT_FRAGMENT) !== -1
                || o.instruction.indexOf(BUGGY_HEADPROMPT_FRAGMENT) !== -1
                || o.instruction.indexOf(PRE_ROLE_BOUNDARY_HEADPROMPT_FRAGMENT) !== -1
                // Pre-card-movement-rule rows. The fragment "Only advance the
                // feature your team worked" is REMOVED from the new text, so
                // this is a traditional positive match. GATE ON MARKER PRESENT:
                // PRE_COMMIT_INSTRUCTION_CODING_HEAD_PROMPT also contains this
                // fragment (line 763) but lacks COMMIT_INSTRUCTION_MARKER.
                // Without the gate, pre-commit-instruction rows would match
                // here and be REPLACED instead of falling through to the append
                // block below — destroying operator edits on the first pass.
                // An appended row (marker present + fragment present) IS
                // matched here and replaced on the NEXT pass.
                || (o.instruction.indexOf(PRE_CARD_MOVEMENT_RULE_HEADPROMPT_FRAGMENT) !== -1
                    && o.instruction.indexOf(COMMIT_INSTRUCTION_MARKER) !== -1)) {
                const newInstruction = NEW_CODING_HEAD_PROMPT
                    .replace(/\{head\}/g, o.parent || '');
                rewritten.push({ ...o, instruction: newInstruction });
                drop.add(o.id);
                touched = true;
                continue;
            }
            // ── APPEND block: pre-commit-instruction rows (additive change) ──
            // Unchanged from current code. The fragment is present in both old
            // and new text, so gate on COMMIT_INSTRUCTION_MARKER being ABSENT.
            // After appending, the marker is present, so the row does not
            // re-match this block. It DOES match the replace block above on the
            // next pass (marker present + "Only advance..." present) — that is
            // the intended two-pass migration.
            if (o.instruction.indexOf(PRE_COMMIT_INSTRUCTION_HEADPROMPT_FRAGMENT) !== -1
                && o.instruction.indexOf(COMMIT_INSTRUCTION_MARKER) === -1) {
                rewritten.push({ ...o, instruction: o.instruction + TEAM_HEAD_COMMIT_INSTRUCTION });
                drop.add(o.id);
                touched = true;
                continue;
            }
        }
```

**Important ordering note:** The replace block (first `if`) must come BEFORE the append block (second `if`), as in the current code. A pre-card-movement-rule row (marker present + "Only advance..." present) matches the replace block and is replaced — it never reaches the append block. A pre-commit-instruction row (no marker) does NOT match the replace block (marker gate fails) and falls through to the append block. This is the same structure as the current code — the new fragment is simply added to the existing replace block with a marker gate.

**4b. Mirror the rewriter update in `terminals.js` — `src/webview/terminals.js` (~line 10896)**

Add the fragment constant mirror (after the existing `PRE_ROLE_BOUNDARY_HEADPROMPT_FRAGMENT` mirror at ~line 10896):

```js
        // Mirror of PRE_CARD_MOVEMENT_RULE_HEADPROMPT_FRAGMENT in teamWiring.ts.
        // Recognises the commit-instruction headPrompt before the card-movement
        // restructuring. The fragment is REMOVED from the new text, so this is
        // a traditional positive match. GATED ON MARKER PRESENT (same as host):
        // pre-commit-instruction rows also contain this fragment but lack the
        // marker — without the gate they would be replaced instead of appended.
        var PRE_CARD_MOVEMENT_RULE_HEADPROMPT_FRAGMENT = 'Only advance the feature your team worked';
```

Add the condition to the REPLACE block (the first `if` inside the `team-head` scope check, ~line 10940). Keep the APPEND block (second `if`) as a separate block — do NOT merge:

```js
            if (o.scope === 'team-head' && typeof o.instruction === 'string') {
                // ── REPLACE block ──
                if (o.instruction.indexOf(OLD_HEADPROMPT_FRAGMENT) !== -1
                    || o.instruction.indexOf(BUGGY_HEADPROMPT_FRAGMENT) !== -1
                    || o.instruction.indexOf(PRE_ROLE_BOUNDARY_HEADPROMPT_FRAGMENT) !== -1
                    || (o.instruction.indexOf(PRE_CARD_MOVEMENT_RULE_HEADPROMPT_FRAGMENT) !== -1
                        && o.instruction.indexOf(COMMIT_INSTRUCTION_MARKER) !== -1)) {
                    var newInstruction = NEW_CODING_HEAD_PROMPT_CLIENT
                        .replace(/\{head\}/g, o.parent || '');
                    // ... (rest of replace body unchanged) ...
                    continue;
                }
                // ── APPEND block (unchanged) ──
                if (o.instruction.indexOf(PRE_COMMIT_INSTRUCTION_HEADPROMPT_FRAGMENT) !== -1
                    && o.instruction.indexOf(COMMIT_INSTRUCTION_MARKER) === -1) {
                    // ... (append body unchanged) ...
                    continue;
                }
            }
```

**Note:** The existing test at `stage-marker-commit-contract.test.js:774` asserts the pre-commit fragment is NOT inside the replace condition (regex check). The corrected approach keeps the pre-commit fragment in the APPEND block (separate `if`), so this test survives. The new fragment is added to the REPLACE block with a marker gate — it does not affect the regex check.

### Part 5 — Contract test updates

**5a. Update `stage-marker-commit-contract.test.js`**

1. **Load-bearing literal test (line 395-404):** Remove `'Only advance the feature your team worked'` is not in the current list — but the test at line 402 checks `!NEW_CODING_HEAD_PROMPT.includes('satisfied with it, hand it to review yourself')` which still passes. Add new assertions:
   - `assert.ok(NEW_CODING_HEAD_PROMPT.includes('Never move a card backwards'), ...)`
   - `assert.ok(NEW_CODING_HEAD_PROMPT.includes('Never move a card to a new column yourself'), ...)`
   - `assert.ok(NEW_CODING_HEAD_PROMPT.includes('triggers review by dispatching'), ...)`
   - `assert.ok(!NEW_CODING_HEAD_PROMPT.includes('Only advance the feature your team worked'), 'the new text must not contain the fragment the rewriter matches on')`

2. **Fragment two-copy rule test:** Add a new test block for `PRE_CARD_MOVEMENT_RULE_HEADPROMPT_FRAGMENT` following the pattern of the existing fragment tests (lines 556-608). Assert:
   - The fragment exists in exactly two files (teamWiring.ts and terminals.js)
   - The fragment is byte-identical across both files
   - `PRE_CARD_MOVEMENT_RULE_CODING_HEAD_PROMPT.includes(PRE_CARD_MOVEMENT_RULE_HEADPROMPT_FRAGMENT)` is true
   - `!NEW_CODING_HEAD_PROMPT.includes(PRE_CARD_MOVEMENT_RULE_HEADPROMPT_FRAGMENT)` is true (rewritten rows don't re-match)

3. **Migration recogniser tests:** Add tests following the pattern of the pre-commit-instruction tests (lines 778-794):
   - A persisted team-head order carrying `PRE_CARD_MOVEMENT_RULE_CODING_HEAD_PROMPT` (with `{head}` substituted) is rewritten to `NEW_CODING_HEAD_PROMPT` (with `{head}` substituted) and is idempotent (fragment absent after replace)
   - `migrateAgentGroups` converts an untouched pre-card-movement-rule Coding team and is idempotent

4. **Byte-identity test (line 362-369):** Already asserts `NEW_CODING_HEAD_PROMPT_CLIENT === NEW_CODING_HEAD_PROMPT`. This passes automatically once both are updated — no test change needed, but it will fail if only one is updated.

5. **Append-only invariant test (line 726-740) — MUST BE SUPERSEDED:**

   > **Superseded:** `assert.strictEqual(PRE_COMMIT_INSTRUCTION_CODING_HEAD_PROMPT + TEAM_HEAD_COMMIT_INSTRUCTION, NEW_CODING_HEAD_PROMPT, ...)` and same for Review.
   > **Reason:** The body edit restructures `NEW_CODING_HEAD_PROMPT` — it is no longer the frozen snapshot plus the commit instruction. The same applies to `NEW_REVIEW_TEAM_HEAD_PROMPT` (rules prepended). The append-only relation was correct for the commit-instruction migration (additive), but this plan's body edit breaks it by design. The append path now produces intermediate text (`PRE_CARD_MOVEMENT_RULE_CODING_HEAD_PROMPT`) that is replaced on the next pass.
   > **Replaced with:** Remove the two `assert.strictEqual` calls. Keep the `TEAM_HEAD_COMMIT_INSTRUCTION.includes(COMMIT_INSTRUCTION_MARKER)` assertion (line 737-739) — it still holds. Add a new assertion that `PRE_CARD_MOVEMENT_RULE_CODING_HEAD_PROMPT === PRE_COMMIT_INSTRUCTION_CODING_HEAD_PROMPT + TEAM_HEAD_COMMIT_INSTRUCTION` (the frozen snapshot IS the old append relation — this pins the snapshot's integrity without constraining the new text). Add a comment explaining the append-only invariant no longer holds because the body edit is a supersession, not an addition.

6. **Pre-commit-instruction rewriter test (line 706-719) — MUST BE UPDATED for two-pass migration:**

   The current test asserts `row.instruction === NEW_CODING_HEAD_PROMPT.replace(...)` after one pass. After the body edit, one pass APPENDS (producing `PRE_CARD_MOVEMENT_RULE_CODING_HEAD_PROMPT`), and a second pass REPLACES (producing the new `NEW_CODING_HEAD_PROMPT`). Update the test:
   - **Pass 1:** Assert `row.instruction === PRE_CARD_MOVEMENT_RULE_CODING_HEAD_PROMPT.replace(/\{head\}/g, 'lead-1')` (the append produces the intermediate text, not the new text). Assert `row.instruction.includes(COMMIT_INSTRUCTION_MARKER)` (the append added the marker).
   - **Pass 2:** Run `migrateCodingTeamOrders` on the pass-1 output. Assert the row is rewritten to `NEW_CODING_HEAD_PROMPT.replace(/\{head\}/g, 'lead-1')` (the new text). Assert `!row.instruction.includes('Only advance the feature your team worked')` (fragment removed).
   - **Pass 3 (idempotency):** Run `migrateCodingTeamOrders` on the pass-2 output. Assert it returns the input unchanged (fragment absent, marker present — no recogniser matches).

7. **Operator-edit preservation test (line 747-763) — MUST BE UPDATED for two-pass migration:**

   The current test asserts operator's wording is preserved and the row is idempotent after append. After the body edit, pass 1 still preserves the operator's wording (append), but the row is NOT idempotent — it re-matches the replace block on pass 2. Update the test:
   - **Pass 1:** Keep the existing assertions — `row.instruction.includes(houseRule)` (operator's wording preserved) and `row.instruction === edited + TEAM_HEAD_COMMIT_INSTRUCTION` (append is the only change). These still pass.
   - **Remove the idempotency assertion at line 761** (`assert.strictEqual(migrateCodingTeamOrders(out), out, ...)`). This no longer holds — the appended row re-matches the replace block on pass 2.
   - **Pass 2:** Run `migrateCodingTeamOrders` on the pass-1 output. Assert the row is replaced with `NEW_CODING_HEAD_PROMPT.replace(/\{head\}/g, 'lead-1')`. Assert `!row.instruction.includes(houseRule)` (operator's wording is lost — consistent with all prior supersessions where the operator's edit retained a removed fragment). Add a comment explaining this is the intended behavior: the card-movement-rule migration is a supersession (text removed), not an addition, so operator edits that retain the removed fragment are replaced.
   - **Pass 3 (idempotency):** Assert `migrateCodingTeamOrders` on pass-2 output returns the input unchanged.

8. **Client mirror append test (line 765-776) — verify survives:**

   The test at line 774 asserts the pre-commit fragment is NOT inside the replace condition (regex check). The corrected approach keeps the pre-commit fragment in the APPEND block (separate `if`), so this test survives. The new fragment is added to the REPLACE block with a marker gate — it does not affect the regex check. No test change needed, but verify the test passes after implementation.

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

### Automated Tests

1. `node --require ./src/test/bootstrap/sandboxStateHome.js src/test/stage-marker-commit-contract.test.js` — all tests pass, including new fragment/migration assertions, superseded append-only invariant, and updated two-pass migration tests
2. `node --require ./src/test/bootstrap/sandboxStateHome.js src/test/standing-orders-marker-contract.test.js` — all tests pass, including new Review team assertion
3. `node --require ./src/test/bootstrap/sandboxStateHome.js src/test/seat-safeguards-fleet-prompt-path.test.js` — unaffected, should pass as-is

### Manual Verification

4. Manual verification: `NEW_CODING_HEAD_PROMPT` does not contain "advance" or "moves the card" (grep the constant value)
5. Manual verification: `NEW_CODING_HEAD_PROMPT` contains "Never move a card backwards" and "Never move a card to a new column yourself"
6. Manual verification: `NEW_REVIEW_TEAM_HEAD_PROMPT` contains "Never move a card backwards"
7. Manual verification: `PRE_CARD_MOVEMENT_RULE_HEADPROMPT_FRAGMENT` is present in `PRE_CARD_MOVEMENT_RULE_CODING_HEAD_PROMPT` and absent from `NEW_CODING_HEAD_PROMPT`
8. Manual verification: `COMMIT_INSTRUCTION_MARKER` is present in `NEW_CODING_HEAD_PROMPT` (commit instruction preserved)
9. Manual verification: the rewriter fragment condition in both `teamWiring.ts` and `terminals.js` includes `&& o.instruction.indexOf(COMMIT_INSTRUCTION_MARKER) !== -1` (marker gate present)
10. Manual verification: the replace and append blocks remain separate `if` statements (not merged into one OR chain) in both `teamWiring.ts` and `terminals.js`
11. Manual verification (two-pass migration): a pre-commit-instruction row (no marker) is APPENDED on pass 1 (produces `PRE_CARD_MOVEMENT_RULE_CODING_HEAD_PROMPT` with marker) and REPLACED on pass 2 (produces new `NEW_CODING_HEAD_PROMPT` without "Only advance..."). Verify via the updated test at line 706.

## Completion Report

Implemented the card-movement-rule migration for both Coding and Review team headPrompts. Froze the current `NEW_CODING_HEAD_PROMPT` and `NEW_REVIEW_TEAM_HEAD_PROMPT` as `PRE_CARD_MOVEMENT_RULE_*` snapshots, then restructured the Coding prompt to remove all "advance"/"moves the card" language, add hard card-movement rules, and reframe POST /kanban/dispatch as "triggers review by dispatching." The Review prompt got the same backwards-movement prohibition prepended. Added the `PRE_CARD_MOVEMENT_RULE_HEADPROMPT_FRAGMENT` constant with a marker gate in the rewriter (both `teamWiring.ts` and `terminals.js`), two new migration recognisers, and mirrored all text changes to `kanban.html` and `terminals.js` (byte-identity verified). Updated `stage-marker-commit-contract.test.js` with new fragment/migration tests, superseded the append-only invariant test, and updated the pre-commit-instruction and operator-edit tests for two-pass migration. Updated `standing-orders-marker-contract.test.js` with the Review team card-movement rule assertion. Files changed: `src/services/teamWiring.ts`, `src/webview/terminals.js`, `src/webview/kanban.html`, `src/test/stage-marker-commit-contract.test.js`, `src/test/standing-orders-marker-contract.test.js`. No issues encountered.

## Review Findings

Two MAJOR findings fixed, no CRITICALs. (1) `Never move a card to a new column yourself.` shipped as an unqualified absolute in all three Coding mirrors, three sentences before the instruction to `POST /kanban/dispatch` with `"targetColumn":"CODE REVIEWED"` — the plan's rule 2 has a second sentence naming dispatch as the lead's one permitted card action, and it was dropped; a literal-reading lead would now decline to hand features to review at all. Added `: your only card action is the POST /kanban/dispatch call below, and only when your team has a reviewer seat.` byte-identically to `teamWiring.ts`, `terminals.js`, `kanban.html`. (2) A fourth live team-head prompt surface the plan did not enumerate — `writeHeadPromptFile` in `src/services/agentGroupInstantiation.ts`, which generates the external-headed team's `head-prompt.md` — still read `## 7. Advancing & Review` and `4. Dispatch new subtasks to available workers or advance cards.` with no movement prohibition; retitled to `## 7. Triggering Review`, both hard rules added, `or advance cards` removed (regenerated file, no migration burden). Also fixed a stale Step 1e migration log and the `NEW_CODING_HEAD_PROMPT` docblock, and added gates: the exception literal, `!/advanc/i` and `!includes('moves the card')` on both new prompts, and a source pin on the external head prompt. Files changed: `src/services/teamWiring.ts`, `src/services/agentGroupInstantiation.ts`, `src/webview/terminals.js`, `src/webview/kanban.html`, `src/test/stage-marker-commit-contract.test.js`, `src/test/standing-orders-marker-contract.test.js`, `src/test/external-headed-team-contract.test.js`. Validation: `tsc -p tsconfig.test.json` clean; stage-marker-commit 62/62, standing-orders-marker 64/64, external-headed-team 10/10, team-scoped-role-routing 62/62, standing-orders-fleet-root 22/22, queue-pipeline pass, plus mirror/parity/catalog/standalone-fork/kanban-dispatch-callers gates green; seat-safeguards 96/2 with the 2 failures confirmed pre-existing at baseline (stash-verified). Remaining risks: Review-team head *standing orders* are still never rewritten on the read path (`migrateCodingTeamOrders` is Coding-only and `wireSpawnedTeam` skips an existing head order), so already-spawned Review teams get the new rule only on re-spawn — the pre-existing gap this plan documented; and a pre-commit-instruction install still sees the intermediate text on read 1 and the new text on read 2, as designed.
