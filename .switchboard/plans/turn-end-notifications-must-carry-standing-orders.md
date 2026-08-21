# Team-Head Standing Orders Must Carry a Durable Commit Instruction AND Reach the Lead on Turn-End Notifications

## Goal

A team lead driving a multi-subtask feature repeatedly failed to commit completed work. The lead received turn-end notifications for each coder's completion, acted on each one — reviewed diffs, accepted work, dispatched the next subtask — but never committed, despite the per-dispatch GIT POLICY block telling it `whenDone`. The commit instruction lived only in the per-dispatch seat block, which was delivered on the initial dispatch prompt and on the coder's callback, but the lead had already acted by the time the callback arrived. The turn-end notification — the message the lead actually responded to — carried no standing orders at all, and the standing orders themselves (the headPrompt) contained no commit instruction.

### The problem, observed

Recurring: a team lead drives a 3-subtask feature, receives turn-end notifications, acts on each (review, accept, dispatch next), but never commits the work. The GIT POLICY block with `commit: whenDone` was in the dispatch prompt, but the lead's durable standing orders (the `team-head` scoped headPrompt) said nothing about committing. And the turn-end notification — the message the lead actually reads and acts on — carried no standing orders because `notifyTurnEnd` hardcoded `standingOrders: false`.

### Root cause

Two bugs, both necessary to explain the symptom:

1. **Content gap**: The headPrompt (the `team-head` standing order) contains dispatch instructions, rotation rules, escalation ladders, and feature-level dispatch — but no commit instruction. The per-dispatch GIT POLICY block already differentiates head (`whenDone`) from member (`dontCommit`) at `TaskViewerProvider.ts:729`, but that instruction is ephemeral — it lives in the dispatch prompt, not in the durable standing orders. When the system already created the head/member commit asymmetry for the per-dispatch block, it did not also add the commit instruction to the head's standing orders.

2. **Delivery gap**: The turn-end notifier classifies its message as a "machine-origin notification, not a dispatched task" and hardcodes `standingOrders: false`. This classification was correct about `clearBeforePrompt` (never wipe context) and `seatBlock` (no task to constrain), but wrong about standing orders. Standing orders are the recipient's durable operating instructions — they are not task-specific. A lead that acts on a turn-end notification needs its standing orders in that message, not in a later callback it may never read.

Without the content fix, the delivery fix carries standing orders that don't mention committing. Without the delivery fix, the commit instruction in standing orders still doesn't reach the lead on the message it acts on. Both are required.

## Metadata

**Complexity:** 6
**Tags:** bugfix, backend, reliability, refactor
**Project:** Browser Switchboard

## User Review Required

This plan modifies durable standing-order text shipped to ~4,000 installs. The migration strategy (new fragment + negative-check matching) departs from the established pure-fragment pattern. A coder should verify the `PRE_COMMIT_INSTRUCTION_HEADPROMPT_FRAGMENT` and `COMMIT_INSTRUCTION_MARKER` constants are correct before implementation, and that the negative-check idempotency holds (a rewritten row does not re-match).

## Complexity Audit

### Routine

- Removing `standingOrders: false` from `notifyTurnEnd` in `TaskViewerProvider.ts` — one line deletion, `applySO` defaults to true when absent
- Changing `deliverPrompt` call in `bootstrap.ts` from `false, false` to `true, false` — one argument flip
- Updating doc comments in both hosts — text-only changes
- Appending `TEAM_HEAD_COMMIT_INSTRUCTION` to `NEW_CODING_HEAD_PROMPT` and `NEW_REVIEW_TEAM_HEAD_PROMPT` — string concatenation
- Adding headPrompts to planning team definitions in `kanban.html` — new field on existing objects
- Adding `migrateAgentGroups` recognisers — follows established exact-value-match pattern
- Updating `seat-safeguards-fleet-prompt-path.test.js` — assertion additions/regex updates

### Complex / Risky

- **Standing-orders rewriter fragment + negative check**: The existing `migrateCodingTeamOrders` rewriter matches by `indexOf` on fragments that are ABSENT from the corrected text (idempotency guarantee). This migration is additive (old text + appended instruction), so no fragment can be unique to the old text. A negative-check approach (match if fragment present AND commit marker absent) is required, breaking the established pattern. Must be mirrored in `terminals.js`.
- **`terminals.js` mirror synchronization**: `NEW_CODING_HEAD_PROMPT_CLIENT` and the rewriter mirror in `terminals.js` must be updated alongside `teamWiring.ts`. The `stage-marker-commit-contract.test.js` enforces byte-identity — a missed mirror breaks the test and ships divergent delivery between host and webview.
- **Review team standing-orders gap (pre-existing)**: `migrateCodingTeamOrders` only handles Coding team head orders. Review team head orders are never rewritten on the read path. The `migrateAgentGroups` recogniser fixes the agent group's `headPrompt`, but the persisted `team-head` standing order is not updated (wireSpawnedTeam skips when `headExists`). This is a pre-existing gap worsened by the commit instruction.

## Edge-Case & Dependency Audit

### Race Conditions

- **Standing-orders read vs migration**: The rewriter runs on every read path (`loadEffectiveStandingOrders`). A concurrent write between the read and the next spawn could persist un-migrated data, but the converter is idempotent and runs in-memory before matching — the next read sees the migrated form. No new race introduced.
- **Turn-end notification during team spawn**: If a turn-end notification fires while a team is being spawned, the standing orders may not yet be established for the new head. `applyStandingOrders` returns the prompt unchanged when no orders apply — no crash, no empty block.

### Security

- **`standingOrders: false` removal does not open an HTTP vector**: The `seatBlock: false` opt-out is still stripped at the HTTP boundary (`handlePtyVerb` deletes `payload.seatBlock`). An HTTP caller cannot inject standing orders — the `applySO` path reads from the fleet DB, not from the payload. The `standingOrders` field is also host-only (callers cannot set it to `true` via HTTP; the extension host sets it internally).

### Side Effects

- **Standing orders appended on every turn-end notification**: This is the same behavior as every other `ptySendPrompt` the lead receives. The orders are short and always relevant. No cache, no suppression (unlike the seat block). Inflation is bounded by the standing-order text length.
- **Planning team heads receiving standing orders for the first time**: Planning teams previously had no headPrompt → no team-head standing order. Adding a headPrompt means the planner now receives standing orders on every prompt (including turn-end notifications). The commit instruction tells the planner to commit the plan file when done — correct, plan files are work product.

### Dependencies & Conflicts

- **`stage-marker-commit-contract.test.js`**: Enforces byte-identity between `NEW_CODING_HEAD_PROMPT` (teamWiring.ts) and `NEW_CODING_HEAD_PROMPT_CLIENT` (terminals.js), fragment byte-identity across both files, and migration idempotency. Any change to the prompt or fragments without updating both files breaks this test.
- **`standing-orders-marker-contract.test.js`**: Enforces byte-identical headPrompts between `kanban.html` and `teamWiring.ts`. Both must move together.
- **`seat-safeguards-fleet-prompt-path.test.js`**: Asserts `notifyTurnEnd` passes `seatBlock: false` and the standalone turn-end passes `false, false` to `deliverPrompt`. Both assertions need updating.
- **`terminals.js` cannot import from `teamWiring.ts`**: All shared constants (fragments, commit instruction marker, prompt text) must be hand-mirrored. The two-copy rule is enforced by `stage-marker-commit-contract.test.js`.

## Dependencies

None — this plan is self-contained. No other plan or session is a prerequisite.

## Adversarial Synthesis

Key risks: (1) the standing-orders rewriter (`migrateCodingTeamOrders`) matches by `indexOf` on three fragments, none of which appear in the current `NEW_CODING_HEAD_PROMPT` — the rewriter will NOT match pre-commit-instruction rows, leaving ~4,000 installs with stale standing orders that never mention committing; (2) the `terminals.js` mirror (`NEW_CODING_HEAD_PROMPT_CLIENT` + rewriter) is completely unmentioned in the original plan and will break byte-identity tests; (3) the additive nature of the change makes pure-fragment matching impossible — a negative-check approach (fragment present AND commit marker absent) is required. Mitigations: add `PRE_COMMIT_INSTRUCTION_HEADPROMPT_FRAGMENT` + `COMMIT_INSTRUCTION_MARKER` with negative-check matching in both `teamWiring.ts` and `terminals.js`; update `NEW_CODING_HEAD_PROMPT_CLIENT` alongside `NEW_CODING_HEAD_PROMPT`; add `stage-marker-commit-contract.test.js` assertions for the new fragment and marker.

## Proposed Changes

### Part 1 — Content: Add durable commit instruction to all headPrompts

**1a. Define a shared commit-instruction constant — `src/services/teamWiring.ts`**

Add a new exported constant near the headPrompt definitions:

```ts
/**
 * Durable commit instruction appended to every team-head standing order.
 * This is NOT the per-dispatch GIT POLICY block (branch/push/safety clauses
 * are composed per-dispatch by buildGitPolicyBlock). This is the durable
 * instruction that survives in the head's standing orders so the lead sees
 * it on every message that carries standing orders — including turn-end
 * notifications, which do not carry the per-dispatch GIT POLICY block.
 */
export const TEAM_HEAD_COMMIT_INSTRUCTION =
    ' When the work is complete, stage the files you changed by explicit path '
    + '— never `git add -A` or `git add .`. Then create a single commit with a '
    + 'descriptive message.';
```

This mirrors the commit clause from `GIT_COMMIT_CLAUSES.whenDone` (`agentPromptBuilder.ts:610`) but drops the plan-file-specific language ("this plan's own file") and the stage-trailer instruction (which is per-dispatch and depends on planIds). It is deliberately separate from the GIT POLICY block — the user has explicitly stated the GIT POLICY block should not be in head orders.

**1b. Define a commit-instruction marker constant — `src/services/teamWiring.ts`**

Add a constant used by the standing-orders rewriter for negative-check matching (see step 1g):

```ts
/**
 * Substring unique to TEAM_HEAD_COMMIT_INSTRUCTION. Used by the
 * standing-orders rewriter's negative check: a team-head row that
 * contains a Coding-team fragment but does NOT contain this marker
 * is pre-commit-instruction and must be rewritten. Exported for the
 * stage-marker-commit-contract test.
 */
export const COMMIT_INSTRUCTION_MARKER = 'create a single commit with a descriptive message';
```

**1c. Append the commit instruction to `NEW_CODING_HEAD_PROMPT` — `src/services/teamWiring.ts` (~line 746)**

Freeze the current `NEW_CODING_HEAD_PROMPT` as a new snapshot constant, then update `NEW_CODING_HEAD_PROMPT` to append `TEAM_HEAD_COMMIT_INSTRUCTION`.

Before (current `NEW_CODING_HEAD_PROMPT` ends at line 746):
```ts
    + 'and stop. The card stays where it is.';
```

After:
```ts
    + 'and stop. The card stays where it is.'
    + TEAM_HEAD_COMMIT_INSTRUCTION;
```

Rename the current value to `PRE_COMMIT_INSTRUCTION_CODING_HEAD_PROMPT` (frozen snapshot, same pattern as `PRE_ROLE_BOUNDARY_CODING_HEAD_PROMPT`). Never edit the snapshot — it is what is on ~4,000 installs' disks today.

**1d. Append the commit instruction to `NEW_REVIEW_TEAM_HEAD_PROMPT` — `src/services/teamWiring.ts` (~line 769)**

Same pattern. Freeze current as `PRE_COMMIT_INSTRUCTION_REVIEW_HEAD_PROMPT`, append `TEAM_HEAD_COMMIT_INSTRUCTION` to the new `NEW_REVIEW_TEAM_HEAD_PROMPT`.

Before (current ends at line 769):
```ts
    + 'review, then update the plan file.';
```

After:
```ts
    + 'review, then update the plan file.'
    + TEAM_HEAD_COMMIT_INSTRUCTION;
```

**1e. Update `NEW_CODING_HEAD_PROMPT_CLIENT` in `terminals.js` — `src/webview/terminals.js` (~line 10722)**

> **Superseded:** The original plan did not mention `terminals.js`. It listed only `teamWiring.ts` and `kanban.html` as edit targets for the headPrompt text.
> **Reason:** `NEW_CODING_HEAD_PROMPT` has a byte-identical mirror in `terminals.js` as `NEW_CODING_HEAD_PROMPT_CLIENT` (line 10722). The `stage-marker-commit-contract.test.js` test at line 361 enforces byte-identity (`assert.strictEqual(newClient, NEW_CODING_HEAD_PROMPT, ...)`). Without updating the mirror, the test breaks and the webview renders different order text than the host delivers.
> **Replaced with:** Append `TEAM_HEAD_COMMIT_INSTRUCTION` text to `NEW_CODING_HEAD_PROMPT_CLIENT` in `terminals.js`, keeping it byte-identical to the new `NEW_CODING_HEAD_PROMPT`. Since `terminals.js` cannot import from `teamWiring.ts`, the commit instruction text must be hand-copied (same two-copy rule as all other shared constants).

Before (current `NEW_CODING_HEAD_PROMPT_CLIENT` ends at line 10759):
```js
        + 'and stop. The card stays where it is.';
```

After:
```js
        + 'and stop. The card stays where it is.'
        + ' When the work is complete, stage the files you changed by explicit path '
        + '— never `git add -A` or `git add .`. Then create a single commit with a '
        + 'descriptive message.';
```

**1f. Add headPrompts to planning team definitions — `src/webview/kanban.html` (~lines 4819, 4838)**

The "Multi-agent planning" and "Planning with analyst" team types currently have NO headPrompt, so `wireSpawnedTeam` skips the `team-head` standing order for them (line 1747: `if (headPromptText)`). To deliver the commit instruction to planning team heads, add a minimal headPrompt to each:

```js
headPrompt: 'You lead this planning team. Synthesize your researchers\' findings into a single plan.'
    + ' When the plan is complete, stage the plan file by explicit path and create a single commit with a descriptive message.'
```

Note: These team types have never had headPrompts in any released version, so no migration is needed for them — only the kanban.html shipped definition changes.

**1g. Update the kanban.html Coding and Review headPrompts — `src/webview/kanban.html` (~lines 4752, 4808)**

Append the same `TEAM_HEAD_COMMIT_INSTRUCTION` text to both headPrompts in kanban.html. The `standing-orders-marker-contract.test.js` test enforces byte-identical headPrompts between kanban.html and teamWiring.ts (lines 414-416, 436-438), so both must move together.

**1h. Migration recognisers — `src/services/teamWiring.ts` (~line 900, alongside existing recognisers)**

Add two new migration recognisers following the established pattern:

- `isUntouchedPreCommitInstructionCodingTeam(group)`: matches `headRole === 'lead'` and `headPrompt === PRE_COMMIT_INSTRUCTION_CODING_HEAD_PROMPT` (the frozen snapshot of the current text). Replaces with the new `NEW_CODING_HEAD_PROMPT`.
- `isUntouchedPreCommitInstructionReviewTeam(group)`: matches `headRole === 'reviewer'` and `headPrompt === PRE_COMMIT_INSTRUCTION_REVIEW_HEAD_PROMPT`. Replaces with the new `NEW_REVIEW_TEAM_HEAD_PROMPT`.

Add both to the migration loop alongside the existing recognisers (steps 1b–1e pattern at ~lines 856-925). Operator-edited headPrompts do not match and are left alone — the operator's text wins.

**1i. Update the standing-orders rewriter — `src/services/teamWiring.ts` (`migrateCodingTeamOrders`, line 2064)**

> **Superseded:** The original plan said "The rewriter at ~line 1239 rewrites stale team-head rows by indexOf match. If it rewrites a PRE_COMMIT_INSTRUCTION_CODING_HEAD_PROMPT row to the new text, it must also append the commit instruction. Verify the rewriter uses the constant (not a hardcoded string) so it tracks the new value automatically."
> **Reason:** Two errors. First, the line number is wrong — line 1239 is `findTeamForHeadRoleInRoots`; the actual rewriter is `migrateCodingTeamOrders` at line 2064. Second, the rewriter matches by `indexOf` on three fragments (`OLD_HEADPROMPT_FRAGMENT`, `BUGGY_HEADPROMPT_FRAGMENT`, `PRE_ROLE_BOUNDARY_HEADPROMPT_FRAGMENT`), NONE of which appear in the current `NEW_CODING_HEAD_PROMPT` (which will become `PRE_COMMIT_INSTRUCTION_CODING_HEAD_PROMPT`). The rewriter will NOT match pre-commit-instruction rows. "Verifying the rewriter uses the constant" is insufficient — the replacement text already uses the constant (line 2103: `NEW_CODING_HEAD_PROMPT.replace(...)`), but the MATCHING is by fragments, and no existing fragment matches. Furthermore, the additive nature of this change (old text + appended instruction) means no fragment can be unique to the old text — every substring of the old text is also in the new text. The established pure-fragment approach cannot work here.
> **Replaced with:** Add a new fragment constant (`PRE_COMMIT_INSTRUCTION_HEADPROMPT_FRAGMENT`) and a negative-check condition. The fragment is a unique substring of the current `NEW_CODING_HEAD_PROMPT` that identifies it as a Coding team head order. The negative check uses `COMMIT_INSTRUCTION_MARKER` — if the instruction contains the fragment but NOT the marker, it is pre-commit-instruction and must be rewritten. After rewriting, the instruction WILL contain the marker, so the row does not re-match (idempotency preserved via the negative check, not via fragment absence).

Add a new exported fragment constant:

```ts
/**
 * Substitution-independent fragment unique to the pre-commit-instruction
 * Coding team headPrompt (the current NEW_CODING_HEAD_PROMPT before this
 * change). Also present in the new NEW_CODING_HEAD_PROMPT (it is a prefix),
 * so the rewriter uses a NEGATIVE check: match if the fragment is present
 * AND COMMIT_INSTRUCTION_MARKER is absent. After rewriting, the marker is
 * present, so the row does not re-match.
 *
 * Two copies only: this one and the terminals.js mirror.
 * stage-marker-commit-contract.test.js gates both halves.
 */
export const PRE_COMMIT_INSTRUCTION_HEADPROMPT_FRAGMENT = 'PLAN FILES ARE THE SOURCE OF TRUTH';
```

Update the `migrateCodingTeamOrders` rewriter at line 2099-2110 to add the new condition:

```ts
if (o.scope === 'team-head' && typeof o.instruction === 'string') {
    if (o.instruction.indexOf(OLD_HEADPROMPT_FRAGMENT) !== -1
        || o.instruction.indexOf(BUGGY_HEADPROMPT_FRAGMENT) !== -1
        || o.instruction.indexOf(PRE_ROLE_BOUNDARY_HEADPROMPT_FRAGMENT) !== -1
        // New: pre-commit-instruction rows. The fragment is present in
        // both old and new text, so gate on the COMMIT_INSTRUCTION_MARKER
        // being ABSENT — a rewritten row carries the marker and does not
        // re-match. This is the only recogniser that uses a negative check;
        // it is required because the change is additive (old text + appended
        // instruction), so no fragment can be unique to the old text.
        || (o.instruction.indexOf(PRE_COMMIT_INSTRUCTION_HEADPROMPT_FRAGMENT) !== -1
            && o.instruction.indexOf(COMMIT_INSTRUCTION_MARKER) === -1)) {
        const newInstruction = NEW_CODING_HEAD_PROMPT
            .replace(/\{head\}/g, o.parent || '');
        rewritten.push({ ...o, instruction: newInstruction });
        drop.add(o.id);
        touched = true;
        continue;
    }
}
```

**1j. Mirror the rewriter update in `terminals.js` — `src/webview/terminals.js` (~line 10862)**

> **Superseded:** The original plan did not mention the `terminals.js` rewriter mirror.
> **Reason:** The standing-orders rewriter has a mirror in `terminals.js` (line 10862+) with the same three fragments and `indexOf` matching. Without updating this mirror, the webview's `applyStandingOrdersClient` renders different order text than the host delivers — the host rewrites stale rows, the webview does not.
> **Replaced with:** Add `PRE_COMMIT_INSTRUCTION_HEADPROMPT_FRAGMENT` and `COMMIT_INSTRUCTION_MARKER` mirrors in `terminals.js`, and update the rewriter's `indexOf` condition to include the negative check, exactly matching the `teamWiring.ts` change.

Add the mirror constants near the existing fragments (after line 10878):

```js
var PRE_COMMIT_INSTRUCTION_HEADPROMPT_FRAGMENT = 'PLAN FILES ARE THE SOURCE OF TRUTH';
var COMMIT_INSTRUCTION_MARKER = 'create a single commit with a descriptive message';
```

Update the rewriter condition at line 10902-10904:

```js
if (o.instruction.indexOf(OLD_HEADPROMPT_FRAGMENT) !== -1
    || o.instruction.indexOf(BUGGY_HEADPROMPT_FRAGMENT) !== -1
    || o.instruction.indexOf(PRE_ROLE_BOUNDARY_HEADPROMPT_FRAGMENT) !== -1
    || (o.instruction.indexOf(PRE_COMMIT_INSTRUCTION_HEADPROMPT_FRAGMENT) !== -1
        && o.instruction.indexOf(COMMIT_INSTRUCTION_MARKER) === -1)) {
```

### Part 2 — Delivery: Turn-end notifications carry standing orders

**2a. Extension host — `src/services/TaskViewerProvider.ts`, `notifyTurnEnd` (~line 1761)**

Remove `standingOrders: false` from the `ptySendPrompt` call. Keep `seatBlock: false` and `clearBeforePrompt: false` unchanged.

Before:
```ts
const sendRes = await this._ptyHostVerb('ptySendPrompt', {
    name: recipientName,
    data: message,
    clearBeforePrompt: false,
    standingOrders: false,
    // Host-only opt-out: a machine notice has no task to
    // constrain, so the seat block is noise. Stripped at the
    // HTTP boundary; an HTTP caller cannot set this.
    seatBlock: false,
});
```

After:
```ts
const sendRes = await this._ptyHostVerb('ptySendPrompt', {
    name: recipientName,
    data: message,
    clearBeforePrompt: false,
    // Host-only opt-out: a machine notice has no task to
    // constrain, so the seat block is noise. Stripped at the
    // HTTP boundary; an HTTP caller cannot set this.
    seatBlock: false,
});
```

The `applySO` check at line 625 (`payload?.standingOrders !== false`) defaults to true when the field is absent, so removing the explicit `false` turns standing orders on. The delivery layer's existing `applyStandingOrders` call (lines 789-804) handles the rest.

**2b. Standalone host — `src/standalone/bootstrap.ts`, turn-end notifier (~line 2252)**

Change the `deliverPrompt` call from `false, false` to `true, false` — standing orders ON, seat block OFF.

Before:
```ts
await deliverPrompt(handle, message, { clearBeforePrompt: false }, false, false);
```

After:
```ts
await deliverPrompt(handle, message, { clearBeforePrompt: false }, true, false);
```

**2c. Update doc comments**

Four comment locations need updating:

- `notifyTurnEnd` doc comment (`TaskViewerProvider.ts` ~line 1635): Remove the `standingOrders: false` justification. Replace with: standing orders are ON because the recipient acts on this notification; the orders are the recipient's durable operating instructions, not task-specific.
- Inline comment at `TaskViewerProvider.ts` ~line 1766: Remove the `standingOrders: false` justification from the seat-block comment.
- `deliverPrompt` doc comment (`bootstrap.ts` ~line 250): Update "machine-origin notices (turn-end) pass both false" to "machine-origin notices (turn-end) pass standing orders ON, seat block OFF".
- Inline comment at `bootstrap.ts` ~line 2249: Update "standingOrders (4th arg) false" to "standingOrders (4th arg) true".
- Block comment at `bootstrap.ts` ~line 2178: Update "standing orders suppressed" to "standing orders enabled".

### Part 3 — Tests

**3a. Update `src/test/seat-safeguards-fleet-prompt-path.test.js`**

- **Test at line 521** (`notifyTurnEnd passes seatBlock: false`): Still asserts `seatBlock: false` is present. Add an assertion that `standingOrders: false` is NOT present in the `notifyTurnEnd` body (i.e., standing orders are no longer opted out).
- **Test at line 773** (`standalone turn-end passes applySeatBlock = false`): Update the regex from `/false,\s*false\)/` to `/true,\s*false\)/` to match the new `deliverPrompt` call. Update the test name and assertion message to reflect standing orders ON, seat block OFF.

**3b. Update `src/test/standing-orders-marker-contract.test.js`**

- The byte-identical assertion (lines 414-416, 436-438) will still pass as long as kanban.html and teamWiring.ts move together.
- Add a substring assertion: `NEW_CODING_HEAD_PROMPT` must include the commit instruction text (e.g., `'create a single commit with a descriptive message'`).
- Add a substring assertion: `NEW_REVIEW_TEAM_HEAD_PROMPT` must include the same commit instruction text.
- Add frozen-snapshot assertions: `PRE_COMMIT_INSTRUCTION_CODING_HEAD_PROMPT` must NOT include the commit instruction text, and must differ from `NEW_CODING_HEAD_PROMPT`. Same for the review snapshot.

**3c. Update `src/test/stage-marker-commit-contract.test.js`**

> **Superseded:** The original plan did not mention this test file. It listed only `seat-safeguards-fleet-prompt-path.test.js` and `standing-orders-marker-contract.test.js`.
> **Reason:** `stage-marker-commit-contract.test.js` enforces byte-identity between `NEW_CODING_HEAD_PROMPT` (teamWiring.ts) and `NEW_CODING_HEAD_PROMPT_CLIENT` (terminals.js), fragment byte-identity across both files, and migration idempotency. Without updating this test, the new fragment and mirror are ungated.
> **Replaced with:** Add the following assertions:

- Import `PRE_COMMIT_INSTRUCTION_CODING_HEAD_PROMPT`, `PRE_COMMIT_INSTRUCTION_HEADPROMPT_FRAGMENT`, and `COMMIT_INSTRUCTION_MARKER` from `teamWiring.ts`.
- **Byte-identity**: `NEW_CODING_HEAD_PROMPT_CLIENT` in `terminals.js` must equal `NEW_CODING_HEAD_PROMPT` (existing test at line 361 — will pass if mirror is updated).
- **Fragment two-copy rule**: `PRE_COMMIT_INSTRUCTION_HEADPROMPT_FRAGMENT` must exist in exactly two files (`teamWiring.ts` + `terminals.js`) and be byte-identical. Follow the pattern of the `BUGGY_HEADPROMPT_FRAGMENT` two-copy test (lines 573-584).
- **Marker two-copy rule**: `COMMIT_INSTRUCTION_MARKER` must exist in exactly two files and be byte-identical.
- **Fragment-in-snapshot**: `PRE_COMMIT_INSTRUCTION_CODING_HEAD_PROMPT` must include `PRE_COMMIT_INSTRUCTION_HEADPROMPT_FRAGMENT`.
- **Marker-in-new-prompt**: `NEW_CODING_HEAD_PROMPT` must include `COMMIT_INSTRUCTION_MARKER`.
- **Marker-NOT-in-snapshot**: `PRE_COMMIT_INSTRUCTION_CODING_HEAD_PROMPT` must NOT include `COMMIT_INSTRUCTION_MARKER`.
- **Migration idempotency**: A `team-head` row carrying `PRE_COMMIT_INSTRUCTION_CODING_HEAD_PROMPT` (with `{head}` substituted) must be rewritten by `migrateCodingTeamOrders` to include `COMMIT_INSTRUCTION_MARKER`. A second pass must NOT re-match (the marker is now present). Follow the pattern of the pre-role-boundary migration test (lines 621-627).

**3d. Add migration test for `migrateAgentGroups` recognisers**

Add a test that verifies the new `migrateAgentGroups` recognisers match the frozen snapshots and replace them with the new text. Follow the pattern of existing migration tests in the test suite.

## What does NOT change

- **Seat block** stays `false` on turn-end notifications. A machine notice has no task to constrain.
- **`clearBeforePrompt`** stays `false`. Never wipe the recipient's context.
- **`/terminals/relay`** — agent-to-agent relay path, separate concern, keeps `standingOrders: false`.
- **Queue/done relay to lead** (`LocalApiServer.ts:4128`) — the system handles the next dispatch; the lead doesn't act on this message. Keeps `standingOrders: false`.
- **Standing-orders establish one-shot** (`_deliverStandingOrdersOnEstablish`) — the block IS the message; `standingOrders: false` prevents double-rendering. Unchanged.
- **Per-dispatch GIT POLICY block** — `buildGitPolicyBlock` continues to compose branch/commit/push/safety per-dispatch. The durable commit instruction in the headPrompt is additive — it does not replace the per-dispatch block.
- **Member standing orders** — the `team` scoped order (callback instruction + `GIT_SAFETY_DIRECTIVE`) is unchanged. Members still get `dontCommit` in the per-dispatch block.
- **Frozen snapshot constants** (`OLD_CODING_HEAD_PROMPT`, `CURRENT_BUGGY_CODING_HEAD_PROMPT`, `PRE_ROLE_BOUNDARY_CODING_HEAD_PROMPT`, `OLD_REVIEW_TEAM_HEAD_PROMPT`) — never edited. New wording goes in the new `NEW_*` constants only.
- **Review team standing-orders rewriter gap** — `migrateCodingTeamOrders` only handles Coding team head orders (the fragments are unique to the Coding team prompt). Review team head orders are never rewritten on the read path. This is a pre-existing gap: the `migrateAgentGroups` recogniser (step 1h) fixes the agent group's `headPrompt`, but the persisted `team-head` standing order is not updated until the team is deleted and recreated. This plan does not add a Review team orders rewriter — the agent group migration covers new spawns, and the gap is no worse than the previous Review team headPrompt changes that shipped without a read-path rewriter.

## Edge cases

- **Recipient has no standing orders**: `applyStandingOrders` returns the prompt unchanged when no orders apply (`renderStandaloneOrdersBlock` returns null). No empty block, no noise.
- **Recipient is an orchestrator, not a team lead**: Orchestrator-role terminals may have global-scope standing orders. If they do, they'll be appended — correct, the orchestrator acts on turn-end notifications too. If they don't, nothing is appended.
- **Stalled/blocked outcome**: Same message path, same `notifyTurnEnd` call. A stalled nudge telling the lead to act is exactly when standing orders matter most.
- **Inflation concern**: Standing orders are appended on every turn-end notification. This is the same behavior as every other `ptySendPrompt` the lead receives. The orders are short and always relevant. No cache, no suppression (unlike the seat block).
- **Custom/user-created teams without headPrompts**: The migration only touches shipped team types (Coding, Review). A custom team whose headPrompt the user wrote will not match the recogniser and is left alone — the operator's text wins. The commit instruction will not appear for custom teams unless the user adds it manually.
- **Per-dispatch GIT POLICY duplication**: The per-dispatch block may say `commit: whenDone` AND the standing orders now say "commit when done." This is intentional redundancy — the per-dispatch block is ephemeral, the standing orders are durable. The lead seeing both is not harmful; the lead seeing neither is the bug.
- **Planning team heads receiving commit instruction for the first time**: Planning teams previously had no headPrompt → no team-head standing order. Adding a headPrompt means the planner now receives standing orders on every prompt (including turn-end notifications). The commit instruction tells the planner to commit the plan file when done — this is correct, plan files are work product.
- **Negative-check idempotency**: The new rewriter condition matches if `PRE_COMMIT_INSTRUCTION_HEADPROMPT_FRAGMENT` is present AND `COMMIT_INSTRUCTION_MARKER` is absent. After rewriting, the instruction is `NEW_CODING_HEAD_PROMPT` (which contains both the fragment and the marker). On the next read, the fragment is still present but the marker is now ALSO present, so the negative check fails and the row is not re-matched. Idempotency is preserved by the negative check, not by fragment absence — a deliberate departure from the established pattern, required by the additive nature of the change.
- **`PRE_COMMIT_INSTRUCTION_HEADPROMPT_FRAGMENT` collision with older prompts**: The fragment `'PLAN FILES ARE THE SOURCE OF TRUTH'` was introduced in the current `NEW_CODING_HEAD_PROMPT` (the role-boundary version). It does NOT appear in `OLD_CODING_HEAD_PROMPT`, `CURRENT_BUGGY_CODING_HEAD_PROMPT`, or `PRE_ROLE_BOUNDARY_CODING_HEAD_PROMPT`. So the new condition will not re-match rows already handled by the existing three fragments — those rows are caught by their own fragments first (the conditions are OR-joined, and the existing fragments fire before the new condition is evaluated). However, after the existing fragments rewrite a row to the new `NEW_CODING_HEAD_PROMPT`, the new condition's negative check (marker absent) will NOT fire because the rewritten text includes the marker. So there is no double-rewrite risk.

## Verification Plan

### Automated Tests

1. `node --check src/services/TaskViewerProvider.ts` — syntax check
2. `node --check src/standalone/bootstrap.ts` — syntax check
3. `node --check src/services/teamWiring.ts` — syntax check
4. Run `src/test/seat-safeguards-fleet-prompt-path.test.js` — updated tests pass
5. Run `src/test/standing-orders-marker-contract.test.js` — updated tests pass (byte-identical headPrompts, new substring assertions, frozen-snapshot assertions)
6. Run `src/test/stage-marker-commit-contract.test.js` — updated tests pass (byte-identity, fragment two-copy rule, marker two-copy rule, fragment-in-snapshot, marker-in-new-prompt, marker-NOT-in-snapshot, migration idempotency)
7. Run migration test — `migrateAgentGroups` recognisers match frozen snapshots, replace with new text; `migrateCodingTeamOrders` rewrites pre-commit-instruction rows, idempotent on second pass

### Manual Verification

8. Grep `notifyTurnEnd` in `TaskViewerProvider.ts` — confirm `standingOrders: false` is gone, `seatBlock: false` remains
9. Grep `deliverPrompt(handle, message` in `bootstrap.ts` turn-end section — confirm 4th arg is `true`, 5th is `false`
10. Grep `TEAM_HEAD_COMMIT_INSTRUCTION` in `teamWiring.ts` — confirm it's appended to both `NEW_CODING_HEAD_PROMPT` and `NEW_REVIEW_TEAM_HEAD_PROMPT`
11. Grep `create a single commit with a descriptive message` in `kanban.html` — confirm it appears in both Coding and Review headPrompts, and in both planning team headPrompts
12. Grep `create a single commit with a descriptive message` in `terminals.js` — confirm `NEW_CODING_HEAD_PROMPT_CLIENT` includes it, and `COMMIT_INSTRUCTION_MARKER` is declared
13. Grep `PRE_COMMIT_INSTRUCTION_HEADPROMPT_FRAGMENT` in both `teamWiring.ts` and `terminals.js` — confirm both declare it and it is byte-identical
14. Manual: dispatch a subtask to a coder, wait for turn-end notification, confirm the lead's terminal shows the `=== STANDING ORDERS ===` block (including the commit instruction) appended to the turn-end message

> **Note:** Compilation and automated test execution are skipped for this run per session directives. The checks remain documented above for execution when the coder picks up this plan.

## Completion Summary

Removed the `standingOrders: false` opt-out from both turn-end notification paths so the recipient (team lead) now receives its durable standing orders on the message it actually acts on. In `src/services/TaskViewerProvider.ts` (`notifyTurnEnd`), deleted the `standingOrders: false` field from the `ptySendPrompt` call — the `applySO` check defaults to true when absent, enabling `applyStandingOrders` to append the orders block. In `src/standalone/bootstrap.ts`, changed the `deliverPrompt` call's 4th arg from `false` to `true` (orders ON, seat block still OFF). Updated four comment locations (doc comment, inline comments in both files) to reflect that standing orders are now ON because the recipient acts on the notification. Updated `src/test/seat-safeguards-fleet-prompt-path.test.js`: added an assertion that `standingOrders: false` is absent from the `notifyTurnEnd` body, and changed the standalone turn-end regex from `/false,\s*false\)/` to `/true,\s*false\)/`. No issues encountered; `seatBlock: false` and `clearBeforePrompt: false` remain unchanged in both paths.

### Part 1 (Content Fix) — Completed

Implemented the durable commit instruction in all team-head standing orders. In `src/services/teamWiring.ts`: added `TEAM_HEAD_COMMIT_INSTRUCTION`, `COMMIT_INSTRUCTION_MARKER`, and `PRE_COMMIT_INSTRUCTION_HEADPROMPT_FRAGMENT` constants; froze the current `NEW_CODING_HEAD_PROMPT` and `NEW_REVIEW_TEAM_HEAD_PROMPT` as `PRE_COMMIT_INSTRUCTION_CODING_HEAD_PROMPT` and `PRE_COMMIT_INSTRUCTION_REVIEW_HEAD_PROMPT` snapshots, then appended the commit instruction text (inlined as string literals, not a constant reference, so `readQuotedChain`-based byte-identity tests can parse it); added `isUntouchedPreCommitInstructionCodingTeam` and `isUntouchedPreCommitInstructionReviewTeam` migration recognisers wired into the `migrateAgentGroups` loop; updated `migrateCodingTeamOrders` with a negative-check condition (fragment present AND marker absent) for the additive migration. In `src/webview/terminals.js`: appended the commit instruction text to `NEW_CODING_HEAD_PROMPT_CLIENT` (byte-identical to the host), declared `PRE_COMMIT_INSTRUCTION_HEADPROMPT_FRAGMENT` and `COMMIT_INSTRUCTION_MARKER` mirrors, and updated the `migrateCodingTeamOrdersClient` rewriter with the same negative-check. In `src/webview/kanban.html`: appended the commit instruction to Coding and Review headPrompts, and added headPrompts to both planning team definitions (Multi-agent planning and Planning with analyst). Updated `src/test/stage-marker-commit-contract.test.js` with fragment/marker two-copy rule assertions, fragment-in-snapshot, marker-in-new-prompt, marker-NOT-in-snapshot, migration idempotency, and `migrateAgentGroups` recogniser tests. Updated `src/test/standing-orders-marker-contract.test.js`: changed headPrompt count from 2 to 4, added commit-instruction substring and frozen-snapshot assertions. No issues encountered; the commit instruction text is byte-identical across teamWiring.ts, terminals.js, and kanban.html.


## Review Findings

Part 2 (delivery) is correct: `notifyTurnEnd` no longer sends `standingOrders: false` (so `applySO` defaults true), the standalone twin passes `true, false`, and `seatBlock`/`clearBeforePrompt` are untouched — verified headlessly end to end (a lead's turn-end message carries the `=== STANDING ORDERS ===` block with the commit clause exactly once; a member's prompt carries no commit clause). Two defects found and fixed: the `deliverPrompt` doc comment in `src/standalone/bootstrap.ts` still claimed "machine-origin notices (turn-end) pass both false" — the one comment location step 2c named that was missed, and the next reader would have "corrected" the code back; and the "Planning with analyst" headPrompt told a team with no researcher seat to synthesize "your researchers' findings". Part 1's own fixes (append-instead-of-replace in the standing-orders rewriter, plus the pre-existing red `stage-marker-commit` gate) are recorded in the sibling plan. Files changed here: `src/standalone/bootstrap.ts`, `src/webview/kanban.html`, `src/test/seat-safeguards-fleet-prompt-path.test.js` (test name), on top of the Part 2 edits to `src/services/TaskViewerProvider.ts`. Validation: `tsc -p tsconfig.test.json` clean; `seat-safeguards` 93/97 — both turn-end assertions pass, and the 4 failures are pre-existing at HEAD (identical `_dispatchExecuteMessage` and `groups.find(` counts in the HEAD blob) and belong to other in-flight work; `stage-marker-commit` 58/58, `standing-orders-marker` 64/64, `standing-orders-fleet-root` 22/22, `team-scoped-routing` 62/62, `external-headed-team` 9/9, `pty-prompt-delivery-framing`, `orchestrator-tick`, `queue-pipeline`, `minimal-prompt`, `terminal-coder-dispatch` all green; all three plan-named gates are wired in `.github/workflows/integration-tests.yml` (lines 177, 206, 255) after `compile-tests`. Remaining risks, all accepted by the plan: every lead turn-end notification now carries the full headPrompt (~3.5 KB of context per notice), and already-spawned Review teams' persisted orders still never gain the clause (no Review rewriter, by design).
