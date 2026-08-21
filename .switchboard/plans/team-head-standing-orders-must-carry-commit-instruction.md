# Team-Head Standing Orders Must Carry a Durable Commit Instruction

## Goal

Team leads repeatedly fail to commit completed work. The per-dispatch GIT POLICY block already tells the head to commit (`gitCommitStrategy: 'whenDone'` at `TaskViewerProvider.ts:729`, mirrored at `standalone/bootstrap.ts:334`), but that instruction is ephemeral — it lives in the dispatch prompt, not in the head's durable standing orders. The headPrompt (the `team-head` standing order) contains dispatch instructions, rotation rules, escalation ladders, and feature-level dispatch — but no commit instruction. The startup delivery mechanism (`_deliverStandingOrdersOnEstablish`) faithfully delivers whatever orders exist at terminal spawn, but those orders say nothing about committing.

The fix: add a durable commit instruction to all team-head standing orders (the headPrompts). The existing delivery mechanisms — startup establish, per-dispatch `applyStandingOrders`, and (via the sibling plan) turn-end notifications — will carry it automatically to **newly-spawned** teams. Already-spawned teams require the standing-order rewriter or a re-spawn (see Edge-Case & Dependency Audit).

### The problem, observed

Recurring: a team lead drives a multi-subtask feature, receives turn-end notifications, acts on each (review, accept, dispatch next), but never commits the work. The GIT POLICY block with `commit: whenDone` was in the dispatch prompt, but the lead's durable standing orders (the `team-head` scoped headPrompt) said nothing about committing. When the system created the head/member commit asymmetry for the per-dispatch block (`whenDone` for head, `dontCommit` for members at `TaskViewerProvider.ts:729`), it did not also add the commit instruction to the head's standing orders.

### Root cause

The headPrompt text — `NEW_CODING_HEAD_PROMPT` and `NEW_REVIEW_TEAM_HEAD_PROMPT` in `teamWiring.ts` — was written to encode the lead's team-management behavior: dispatch, rotation, escalation, feature-level handoff to review. Committing was left to the per-dispatch GIT POLICY block, which is composed dynamically by `buildGitPolicyBlock` (`agentPromptBuilder.ts:663`) and rides only on dispatch prompts. The head's durable orders — delivered at startup by `_deliverStandingOrdersOnEstablish` and on every prompt by `applyStandingOrders` — never mention committing.

The planning team types ("Multi-agent planning" and "Planning with analyst") have no headPrompt at all, so `wireSpawnedTeam` skips the `team-head` standing order for them (line 1747: `if (headPromptText)`). Their heads receive no team-head standing orders whatsoever.

**Sibling plan:** `turn-end-notifications-must-carry-standing-orders.md` fixes the delivery pipe so standing orders (including this new commit instruction) reach the lead on turn-end notifications. Both are needed — without this content fix, the delivered orders don't mention committing; without the delivery fix, the orders don't reach the lead on the message it acts on after review rounds.

## What changes

**1. Define a shared commit-instruction constant — `src/services/teamWiring.ts`**

Add a new exported constant near the headPrompt definitions:

```ts
/**
 * Durable commit instruction appended to every team-head standing order.
 * This is NOT the per-dispatch GIT POLICY block (branch/push/safety clauses
 * are composed per-dispatch by buildGitPolicyBlock). This is the durable
 * instruction that survives in the head's standing orders so the lead sees
 * it on every message that carries standing orders — including startup
 * delivery and turn-end notifications, which do not carry the per-dispatch
 * GIT POLICY block.
 */
export const TEAM_HEAD_COMMIT_INSTRUCTION =
    ' When the work is complete, stage the files you changed by explicit path '
    + '— never `git add -A` or `git add .`. Then create a single commit with a '
    + 'descriptive message.';
```

This mirrors the commit clause from `GIT_COMMIT_CLAUSES.whenDone` (`agentPromptBuilder.ts:610`) but drops the plan-file-specific language ("this plan's own file") and the stage-trailer instruction (which is per-dispatch and depends on planIds). It is deliberately separate from the GIT POLICY block — the GIT POLICY block should not be in head orders.

**2. Freeze current `NEW_CODING_HEAD_PROMPT` and append the commit instruction — `src/services/teamWiring.ts` (~line 746)**

Rename the current `NEW_CODING_HEAD_PROMPT` value to `PRE_COMMIT_INSTRUCTION_CODING_HEAD_PROMPT` (frozen snapshot, same pattern as `PRE_ROLE_BOUNDARY_CODING_HEAD_PROMPT`). Never edit the snapshot — it is what is on ~4,000 installs' disks today.

Then update `NEW_CODING_HEAD_PROMPT` to append `TEAM_HEAD_COMMIT_INSTRUCTION`:

Before (current `NEW_CODING_HEAD_PROMPT` ends at line 746):
```ts
    + 'and stop. The card stays where it is.';
```

After:
```ts
    + 'and stop. The card stays where it is.'
    + TEAM_HEAD_COMMIT_INSTRUCTION;
```

**3. Freeze current `NEW_REVIEW_TEAM_HEAD_PROMPT` and append the commit instruction — `src/services/teamWiring.ts` (~line 769)**

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

**4. Update the kanban.html Coding and Review headPrompts — `src/webview/kanban.html` (~lines 4752, 4808)**

Append the same `TEAM_HEAD_COMMIT_INSTRUCTION` text to both headPrompts in kanban.html. The `standing-orders-marker-contract.test.js` test enforces byte-identical headPrompts between kanban.html and teamWiring.ts (lines 414-416, 436-438), so both must move together.

**5. Update the terminals.js mirror — `src/webview/terminals.js` (~line 10722)**

> **Superseded:** The original plan covered only two mirrors (teamWiring.ts and kanban.html).
> **Reason:** `stage-marker-commit-contract.test.js:356-363` asserts `NEW_CODING_HEAD_PROMPT_CLIENT` in terminals.js is byte-identical to `NEW_CODING_HEAD_PROMPT` in teamWiring.ts. The terminals.js client-side rewriter (`migrateCodingTeamOrders` mirror at line 10905) uses `NEW_CODING_HEAD_PROMPT_CLIENT` to rewrite stale team-head rows. A third mirror exists and the test enforces it.
> **Replaced with:** A third update site — append the same `TEAM_HEAD_COMMIT_INSTRUCTION` text to `NEW_CODING_HEAD_PROMPT_CLIENT` in terminals.js (line 10722). This is the webview-side mirror that cannot import the TypeScript constant; the text must be inlined byte-identically. No Review team headPrompt mirror exists in terminals.js (only Coding), so only `NEW_CODING_HEAD_PROMPT_CLIENT` needs updating.

**6. Add headPrompts to planning team definitions — `src/webview/kanban.html` (~lines 4819, 4838)**

The "Multi-agent planning" and "Planning with analyst" team types currently have NO headPrompt, so `wireSpawnedTeam` skips the `team-head` standing order for them (line 1747: `if (headPromptText)`). To deliver the commit instruction to planning team heads, add a minimal headPrompt to each:

```js
headPrompt: 'You lead this planning team. Synthesize your researchers\' findings into a single plan.'
    + ' When the plan is complete, stage the plan file by explicit path and create a single commit with a descriptive message.'
```

Note: These team types have never had headPrompts in any released version, so no migration is needed for them — only the kanban.html shipped definition changes.

**7. Update the contract test headPrompt count assertion — `src/test/standing-orders-marker-contract.test.js` (~line 362)**

> **Superseded:** The original plan did not mention updating the contract test's headPrompt count assertion.
> **Reason:** `standing-orders-marker-contract.test.js:362-364` asserts `headPromptMatches.length === 2`. Step 6 adds headPrompts to two planning team types, making the count 4. The test will fail.
> **Replaced with:** Update the assertion from 2 to 4 and update the comment to reflect that four shipped headPrompts now exist (Coding, Review, Multi-agent planning, Planning with analyst). The `find` calls at lines 366 and 408 (which locate the Coding and Review headPrompts by substring) still work with 4 entries — only the count assertion breaks.

**8. Migration recognisers — `src/services/teamWiring.ts` (~line 920, alongside existing recognisers)**

Add two new migration recognisers following the established pattern:

- `isUntouchedPreCommitInstructionCodingTeam(group)`: matches `headRole === 'lead'` and `headPrompt === PRE_COMMIT_INSTRUCTION_CODING_HEAD_PROMPT` (the frozen snapshot of the current text). Replaces with the new `NEW_CODING_HEAD_PROMPT`.
- `isUntouchedPreCommitInstructionReviewTeam(group)`: matches `headRole === 'reviewer'` and `headPrompt === PRE_COMMIT_INSTRUCTION_REVIEW_HEAD_PROMPT`. Replaces with the new `NEW_REVIEW_TEAM_HEAD_PROMPT`.

Add both to the migration loop alongside the existing recognisers (step 1d, 1e pattern at ~lines 856-925). Operator-edited headPrompts do not match and are left alone — the operator's text wins.

**9. Verify the standing-order rewriter — `src/services/teamWiring.ts`, function `migrateCodingTeamOrders` (line 2064)**

> **Superseded:** The original plan referenced "the rewriter at ~line 1239" and said to verify it tracks the new value automatically.
> **Reason:** Line 1239 is `findTeamForHeadRoleInRoots`, not the rewriter. The actual rewriter is `migrateCodingTeamOrders` at line 2064 (the stale line number originates from the contract test comment at line 428, which is equally stale). More importantly, the rewriter's `indexOf`-based matching CANNOT handle this migration — see Edge-Case & Dependency Audit §"Already-spawned teams" for the full analysis.
> **Replaced with:** Verify `migrateCodingTeamOrders` (line 2064) and its terminals.js mirror (line 10905) both use the `NEW_CODING_HEAD_PROMPT` / `NEW_CODING_HEAD_PROMPT_CLIENT` constant (not a hardcoded string) so the rewritten text tracks the new value automatically. The rewriter rewrites stale rows carrying OLD/BUGGY/PRE_ROLE_BOUNDARY fragments to the new text (which now includes the commit instruction). This is correct for those older versions. However, rows carrying the current `NEW_CODING_HEAD_PROMPT` text (which becomes `PRE_COMMIT_INSTRUCTION_CODING_HEAD_PROMPT`) are NOT matched by any existing fragment — see Edge-Case & Dependency Audit for why and what to do about it.

## What does NOT change

- **Per-dispatch GIT POLICY block** — `buildGitPolicyBlock` continues to compose branch/commit/push/safety per-dispatch. The durable commit instruction in the headPrompt is additive — it does not replace the per-dispatch block. The lead may see both; that is intentional redundancy.
- **Member standing orders** — the `team` scoped order (callback instruction + `GIT_SAFETY_DIRECTIVE`) is unchanged. Members still get `dontCommit` in the per-dispatch block.
- **Frozen snapshot constants** (`OLD_CODING_HEAD_PROMPT`, `CURRENT_BUGGY_CODING_HEAD_PROMPT`, `PRE_ROLE_BOUNDARY_CODING_HEAD_PROMPT`, `OLD_REVIEW_TEAM_HEAD_PROMPT`) — never edited. New wording goes in the new `NEW_*` constants only.
- **Startup delivery** (`_deliverStandingOrdersOnEstablish`) — unchanged. It already delivers whatever standing orders resolve; it will now deliver orders that include the commit instruction.
- **Per-dispatch `applyStandingOrders`** — unchanged. It already appends standing orders to every dispatch prompt; it will now append orders that include the commit instruction.

## User Review Required

The plan introduces a known limitation: already-spawned teams (running before the upgrade) will not receive the commit instruction in their standing orders until the team is re-spawned. This is because the standing-order rewriter's `indexOf`-based matching cannot distinguish "old text without commit instruction" from "new text with commit instruction" (the change is append-only — every substring of the old text survives into the new text). See Edge-Case & Dependency Audit §"Already-spawned teams" for the full analysis and the two options (extend the rewriter with a two-condition match, or accept the limitation). The plan proceeds on the assumption that this is acceptable — teams are typically per-session and restart frequently, so the limitation is transient. If you want already-spawned teams covered immediately, the rewriter extension is the path.

## Complexity Audit

### Routine
- Appending a shared constant to two headPrompt strings (teamWiring.ts)
- Mirroring the same text in kanban.html (2 headPrompts) and terminals.js (1 mirror)
- Freezing two current headPrompt values as snapshot constants (same pattern as 3 prior frozen snapshots)
- Adding two migration recognisers (same pattern as 3 prior recognisers)
- Adding headPrompts to two planning team definitions (inline text, no migration)
- Updating one test assertion (count from 2 to 4)

### Complex / Risky
- The standing-order rewriter (`migrateCodingTeamOrders`) cannot handle the append-only nature of this change via its existing `indexOf` fragment matching — already-spawned teams are not covered (see Edge-Case & Dependency Audit)
- Three mirror sites (teamWiring.ts, kanban.html, terminals.js) must stay byte-identical, enforced by two contract tests; a miss at any site fails the test
- Planning team headPrompts are a third copy of commit text with different wording ("stage the plan file" vs "stage the files you changed"), not pinned by any test — drift risk

## Edge-Case & Dependency Audit

### Race Conditions
- None. The migration runs synchronously in `migrateAgentGroups` on every DB read. The standing-order rewriter runs in-memory at read sites. No concurrent-write hazard.

### Security
- None. No new endpoints, no new user input surfaces, no new file paths.

### Side Effects
- **Per-dispatch GIT POLICY duplication**: The per-dispatch block may say `commit: whenDone` AND the standing orders now say "commit when done." This is intentional redundancy — the per-dispatch block is ephemeral, the standing orders are durable. The lead seeing both is not harmful; the lead seeing neither is the bug.
- **Planning team heads receiving standing orders for the first time**: Planning teams previously had no headPrompt → no team-head standing order. Adding a headPrompt means the planner now receives standing orders on every prompt (including startup delivery and turn-end notifications). The commit instruction tells the planner to commit the plan file when done — this is correct, plan files are work product.
- **Review team head committing**: The review team head (reviewer role) now gets a commit instruction in its standing orders. The reviewer applies fixes directly (under ~100 lines) and delegates larger sets to its coder. Telling the reviewer to commit when work is complete is correct — the reviewer is the head and the per-dispatch block already sets `whenDone` for heads.
- **Stage-trailer gap on turn-end notifications**: The durable commit instruction deliberately omits the stage-trailer instruction (`Switchboard-Stage: coded`, `Switchboard-Plan: <id>`) because it depends on planIds, which are per-dispatch. When the head commits based on the durable instruction alone (e.g., on a turn-end notification that carries standing orders but NOT the per-dispatch GIT POLICY block), the commit lacks the stage trailer. The orchestrator's `git log --format='%(trailers:key=Switchboard-Stage...)'` query won't find the commit. This is minor: the per-dispatch GIT POLICY block (which carries the trailer) is in the head's context on every dispatch, and the head commits after dispatching — the turn-end notification is an intermediate signal, not the commit trigger. The durable instruction is a reminder, not the sole source.

### Dependencies & Conflicts
- **Already-spawned teams (CRITICAL LIMITATION):** The standing-order rewriter `migrateCodingTeamOrders` (teamWiring.ts:2064) and its terminals.js mirror (line 10905) rewrite stale team-head standing order rows by `indexOf` match on fragments unique to older prompt versions (`OLD_HEADPROMPT_FRAGMENT`, `BUGGY_HEADPROMPT_FRAGMENT`, `PRE_ROLE_BOUNDARY_HEADPROMPT_FRAGMENT`). The current `NEW_CODING_HEAD_PROMPT` text (which becomes `PRE_COMMIT_INSTRUCTION_CODING_HEAD_PROMPT`) contains NONE of those fragments. And since this migration APPENDS text (removes nothing), every substring of the old text survives into the new text — there is no fragment that can distinguish "old without commit instruction" from "new with commit instruction" via `indexOf` alone. Result: already-spawned Coding AND Review teams will NOT receive the commit instruction in their standing orders. The group-level migration (step 8) updates the group's `headPrompt` field, but `wireSpawnedTeam` skips creating a new team-head order when one already exists (`if (!headExists)` at line 1750). The old standing-order row persists and keeps delivering the old text. Two options:
  1. **Extend the rewriter with a two-condition match:** match rows that contain a pre-commit fragment AND do NOT contain the commit instruction text. E.g., `o.instruction.indexOf(PRE_COMMIT_FRAGMENT) !== -1 && o.instruction.indexOf(COMMIT_INSTRUCTION_FRAGMENT) === -1`. This requires a new fragment constant and a change to the matching logic in both `migrateCodingTeamOrders` and its terminals.js mirror. The Review team has no standing-order rewriter at all — one would need to be added (parallel to `migrateCodingTeamOrders` but matching Review headPrompt fragments).
  2. **Accept the limitation:** Teams are typically per-session. When a team is stopped and re-spawned after the upgrade, `wireSpawnedTeam` installs a fresh team-head order from the migrated group `headPrompt` — but ONLY if the old order was cleaned up on team teardown. If the old order persists (the `if (!headExists)` guard), even re-spawning doesn't help. This plan proceeds on option 2 (accept the limitation). If immediate coverage of already-spawned teams is required, option 1 is the path — it should be a follow-up plan.
- **Custom/user-created teams without headPrompts**: The migration only touches shipped team types (Coding, Review). A custom team whose headPrompt the user wrote will not match the recogniser and is left alone — the operator's text wins. The commit instruction will not appear for custom teams unless the user adds it manually.
- **Planning team headPrompt drift risk**: The planning team headPrompt commit text ("stage the plan file by explicit path and create a single commit with a descriptive message") is a third copy of the commit instruction, with different wording from `TEAM_HEAD_COMMIT_INSTRUCTION` ("stage the files you changed"). It is not pinned by any contract test. When `TEAM_HEAD_COMMIT_INSTRUCTION` is updated, the planning team text can drift silently. This is accepted — the wording difference is intentional (planning teams commit plan files, not code files) and pinning it would require a new test for marginal benefit.
- **Sibling plan dependency**: `turn-end-notifications-must-carry-standing-orders.md` must also ship for the commit instruction to reach the lead on turn-end notifications. Without it, the durable instruction reaches the lead only on startup and per-dispatch delivery — which covers the common case but not the post-review-round case.

## Dependencies

- `turn-end-notifications-must-carry-standing-orders.md` — sibling plan fixing the delivery pipe so standing orders reach the lead on turn-end notifications. Both plans are needed for full coverage.

## Adversarial Synthesis

Key risks: (1) the terminals.js mirror (`NEW_CODING_HEAD_PROMPT_CLIENT`) is a third copy that the original plan missed — the contract test will fail without updating it; (2) the contract test's headPrompt count assertion (2 → 4) will fail when planning team headPrompts are added; (3) already-spawned teams won't receive the commit instruction because the standing-order rewriter's `indexOf` matching can't distinguish append-only changes. Mitigations: add the terminals.js update step, update the test count assertion, and document the already-spawned-team limitation as accepted (teams are per-session, re-spawn resolves it).

## Proposed Changes

### `src/services/teamWiring.ts`
- **Context:** Defines headPrompt constants, migration recognisers, and the standing-order rewriter.
- **Logic:** Add `TEAM_HEAD_COMMIT_INSTRUCTION` constant. Freeze current `NEW_CODING_HEAD_PROMPT` as `PRE_COMMIT_INSTRUCTION_CODING_HEAD_PROMPT` and current `NEW_REVIEW_TEAM_HEAD_PROMPT` as `PRE_COMMIT_INSTRUCTION_REVIEW_HEAD_PROMPT`. Append `TEAM_HEAD_COMMIT_INSTRUCTION` to both `NEW_*` constants. Add `isUntouchedPreCommitInstructionCodingTeam` and `isUntouchedPreCommitInstructionReviewTeam` recognisers to `migrateAgentGroups` (~line 920).
- **Implementation:** See steps 1-3, 8 above. The frozen snapshots must be byte-identical to the current `NEW_*` values before appending. The recognisers follow the exact pattern of `isUntouchedPreRoleBoundaryCodingTeam` (line 1177).
- **Edge Cases:** Operator-edited headPrompts do not match the recogniser and are left alone. The `migrateCodingTeamOrders` rewriter (line 2064) automatically produces the new text (with commit instruction) when rewriting older rows — no change needed to the rewriter itself for OLD/BUGGY/PRE_ROLE_BOUNDARY rows. Rows with the current NEW text are NOT rewritten (see Edge-Case & Dependency Audit).

### `src/webview/kanban.html`
- **Context:** Ships the gallery team definitions that operators adopt via USE.
- **Logic:** Append `TEAM_HEAD_COMMIT_INSTRUCTION` text to the Coding headPrompt (~line 4752) and Review headPrompt (~line 4808). Add headPrompts to the "Multi-agent planning" (~line 4819) and "Planning with analyst" (~line 4838) team definitions.
- **Implementation:** See steps 4, 6 above. The Coding and Review headPrompt text must be byte-identical to the teamWiring.ts constants (enforced by `standing-orders-marker-contract.test.js` lines 414-416, 436-438). The planning team headPrompts are new inline text, not pinned by any test.
- **Edge Cases:** The planning team headPrompt commit text uses "stage the plan file" (not "stage the files you changed") — intentional wording difference for plan files vs code files. This is a third unpinned copy of the commit instruction (drift risk documented above).

### `src/webview/terminals.js`
- **Context:** Client-side mirror of teamWiring.ts constants and the standing-order rewriter.
- **Logic:** Append the same `TEAM_HEAD_COMMIT_INSTRUCTION` text to `NEW_CODING_HEAD_PROMPT_CLIENT` (line 10722). No Review team headPrompt mirror exists in terminals.js.
- **Implementation:** See step 5 above. The text must be byte-identical to `NEW_CODING_HEAD_PROMPT` in teamWiring.ts (enforced by `stage-marker-commit-contract.test.js` lines 356-363). The client-side rewriter at line 10905 uses `NEW_CODING_HEAD_PROMPT_CLIENT` — it will automatically produce the new text (with commit instruction) when rewriting older rows.
- **Edge Cases:** Same already-spawned-team limitation as the host-side rewriter — rows with the current text are not matched by any existing fragment.

### `src/test/standing-orders-marker-contract.test.js`
- **Context:** Enforces byte-identity of headPrompts between kanban.html and teamWiring.ts, and asserts the count of shipped headPrompts.
- **Logic:** Update the headPrompt count assertion from 2 to 4 (~line 362). Update the comment to reflect four shipped headPrompts (Coding, Review, Multi-agent planning, Planning with analyst).
- **Implementation:** See step 7 above. The `find` calls at lines 366 and 408 still work with 4 entries. No other assertions in this test are affected by the commit instruction text (the substring assertions at lines 383-388 check for ABSENCE of certain strings, none of which appear in the commit instruction).
- **Edge Cases:** None. The test is a source-level string comparison; no runtime behavior is tested.

### `src/test/stage-marker-commit-contract.test.js`
- **Context:** Enforces byte-identity of `NEW_CODING_HEAD_PROMPT_CLIENT` (terminals.js) with `NEW_CODING_HEAD_PROMPT` (teamWiring.ts), and asserts load-bearing literals in `NEW_CODING_HEAD_PROMPT`.
- **Logic:** No changes needed. The byte-identity assertion (lines 356-363) will pass as long as both mirrors are updated. The load-bearing literal assertions (lines 389-398) check for PRESENCE of strings that are already in the current text — appending the commit instruction does not remove any of them. The `!includes` assertion at line 396 checks for `OLD_HEADPROMPT_FRAGMENT` text — the commit instruction does not contain it.
- **Edge Cases:** None.

## Verification Plan

### Automated Tests
1. `node --check src/services/teamWiring.ts` — syntax check
2. Run `src/test/standing-orders-marker-contract.test.js` — byte-identical headPrompts between kanban.html and teamWiring.ts still hold; updated count assertion (4) passes; new substring assertions pass
3. Run `src/test/stage-marker-commit-contract.test.js` — `NEW_CODING_HEAD_PROMPT_CLIENT` in terminals.js is byte-identical to `NEW_CODING_HEAD_PROMPT` in teamWiring.ts; load-bearing literals still present
4. Run migration test — recognisers match frozen snapshots, replace with new text

### Manual Checks
5. Grep `TEAM_HEAD_COMMIT_INSTRUCTION` in `teamWiring.ts` — confirm it's appended to both `NEW_CODING_HEAD_PROMPT` and `NEW_REVIEW_TEAM_HEAD_PROMPT`
6. Grep `create a single commit with a descriptive message` in `kanban.html` — confirm it appears in both Coding and Review headPrompts, and in both planning team headPrompts
7. Grep `create a single commit with a descriptive message` in `terminals.js` — confirm it appears in `NEW_CODING_HEAD_PROMPT_CLIENT`
8. Grep `PRE_COMMIT_INSTRUCTION_CODING_HEAD_PROMPT` and `PRE_COMMIT_INSTRUCTION_REVIEW_HEAD_PROMPT` — confirm frozen snapshots exist and do NOT contain the commit instruction text
9. Grep `headPromptMatches.length, 4` in `standing-orders-marker-contract.test.js` — confirm the count assertion was updated
10. Manual: start a Coding team, confirm the lead's startup orientation message includes the commit instruction in the `=== STANDING ORDERS ===` block

## Metadata

**Complexity:** 4
**Tags:** bugfix, backend, reliability
**Project:** Browser Switchboard

## Completion Report

Appended durable commit instruction `TEAM_HEAD_COMMIT_INSTRUCTION` to `NEW_CODING_HEAD_PROMPT` and `NEW_REVIEW_TEAM_HEAD_PROMPT`, added headPrompts to planning team definitions in `kanban.html`, and updated client mirror `NEW_CODING_HEAD_PROMPT_CLIENT` in `terminals.js`. Added frozen snapshot constants and migration recognisers for pre-commit-instruction team groups and standing orders. Updated contract test assertions and verified multi-site prompt byte-identity. Files modified: `src/services/teamWiring.ts`, `src/webview/kanban.html`, `src/webview/terminals.js`, `src/test/standing-orders-marker-contract.test.js`, and `src/test/stage-marker-commit-contract.test.js`. No issues encountered.

