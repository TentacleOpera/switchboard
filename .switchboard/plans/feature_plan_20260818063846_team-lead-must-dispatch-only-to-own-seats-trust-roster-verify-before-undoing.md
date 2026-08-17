# A Team Lead Must Dispatch Only to Its Own Seats, Trust the Roster, and Verify Before Undoing

## Goal

A Coding team lead made three distinct errors in one session, each caused by a gap in the instructions it received:

1. **Dispatched to a standalone coder not on its team.** The lead called `ptyListTerminals`, filtered on `role === "coder"`, got three hits, and dispatched to all three — including `coder-1`, a standalone seat with no `parentInstanceId` that was not on the team at all. The lead treated `role` as the eligibility test; `parentInstanceId` was in the same JSON response and is the field that actually defines team membership.

2. **Invented complexity tiers to rule out the intern.** The lead compared plan complexity scores against a self-invented notion of "intern-tier" work and ruled out the intern seat. The intern exists because the operator seated it. Subtask 5 was persona markdown plus test assertions — obviously the intern's. The lead second-guessed the roster instead of using it.

3. **Sent a stand-down message without verifying any edits existed.** After realising coder-1 was not on the team, the lead told it to revert edits to two files without checking whether any existed. `git diff` was one call away and was not made — so a clean terminal got sent to hunt for damage that was never there.

### Problem Analysis & Root Cause

All three errors trace to text gaps in two documents the lead reads: the `terminal-coder-dispatch` skill (§10) and the Coding team `headPrompt` (`NEW_CODING_HEAD_PROMPT` in `teamWiring.ts:275`).

**Error 1 — wrong eligibility test.** §10 of `terminal-coder-dispatch/SKILL.md` (line 453) says:

> "Before dispatching, enumerate the live terminal pool with `ptyListTerminals` across all roles (`intern`, `coder`, `lead`, etc.)."

It says "across all roles" and never says "your team's seats only." The lead read breadth as permission. The `ptyListTerminals` response includes `parentInstanceId` for every terminal (confirmed at `bootstrap.ts:1530` and `ptyFleetService.ts:35`), and a team member's `parentInstanceId` is the head's `agentInstanceId` — but neither the skill nor the headPrompt names `parentInstanceId` as the team-membership filter. The headPrompt says "dispatch it to a seat of that role on your team" but never says how to identify which seats are on your team.

**Error 2 — roster second-guessing.** The headPrompt says "Each subtask carries a recommendedRole; dispatch it to a seat of that role on your team. If your team has no such seat, dispatch to a coder and say why in your status report." This is the correct rule — but the lead overrode it by inventing its own complexity-based tier mapping. Nothing in the prompt or skill explicitly forbids second-guessing the `recommendedRole` field. The `switchboard-orchestration` skill (line 76-82) says `recommendedRole` is "the seat the board would route this plan to" and "Do not re-derive it by reading the plan file's `Recommendation:` line" — but that instruction is in the orchestration skill, not in the `terminal-coder-dispatch` skill or the headPrompt, and the lead may not have read it.

**Error 3 — unverified stand-down.** §5 of `terminal-coder-dispatch` (line 324) says "review the actual diff, not the coder's account of it" — but only in the context of reviewing a coder's completed work. There is no instruction about verifying before issuing cleanup, revert, or stand-down commands. The lead told coder-1 to revert edits without checking `git diff` — a one-call verification that would have shown the terminal was clean. The skill needs a "verify before you act on a mistake" rule: never send a terminal to revert or clean up without first confirming the state you are undoing actually exists.

## Metadata

**Complexity:** 5
**Tags:** backend, bugfix, reliability, docs
**Project:** Browser Switchboard

## Complexity Audit

**Routine (text changes):**
- Rewriting §10 of `terminal-coder-dispatch/SKILL.md` to say "your team's seats only" and name `parentInstanceId` as the membership filter — a text edit to a skill file.
- Adding a "verify before undoing" rule to the skill — a new subsection or addition to an existing section.
- Adding a "trust the roster" rule to the skill or headPrompt — text addition.
- The `.claude/skills/terminal-coder-dispatch/SKILL.md` mirror must be updated to match (the mirror has a YAML frontmatter block the `.agents` version does not — the body text must still match).

**Moderate risk (headPrompt migration):**
- If the headPrompt is amended (adding "trust the recommendedRole" and "verify before undoing" rules), the same three-place migration machinery applies: `NEW_CODING_HEAD_PROMPT` in `teamWiring.ts`, `NEW_CODING_HEAD_PROMPT_CLIENT` in `terminals.js`, and the Coding team gallery entry in `kanban.html`. Plus a migration recogniser for installs that already have the current text.
- However, the headPrompt is already subject to two other pending plans that rewrite it (`feature_plan_20260818000513` fixes API errors + rotation rule; `feature_plan_20260818062423` removes the orchestrator report instruction). This plan should avoid amending the headPrompt text directly and instead put the new rules in the skill file, which is the single source the lead reads. The headPrompt already says "dispatch it to a seat of that role on your team" — the skill is where the lead learns how to identify those seats.

**Low risk (skill file changes):**
- The skill file is read by the lead at dispatch time. Changes take effect on the next dispatch — no migration needed, no persisted state.
- The `npm run mirror:check` script validates `.agents/` ↔ `.claude/` drift — both files must be updated.

## Edge-Case & Dependency Audit

1. **Shared members have no `parentInstanceId`.** A `scope: 'shared'` team member (e.g. a shared reviewer) is spawned unparented (`bootstrap.ts:495`, `ptyFleetService.ts:495`). Filtering on `parentInstanceId === <head's agentInstanceId>` would exclude shared members. The skill must account for this: shared members are identified by name convention (`${teamName}-${role}`) or by the `terminalGroups` config, not by `parentInstanceId` alone. However, the Coding team's shared member is the reviewer, which the lead never dispatches to directly — so for the Coding team, filtering on `parentInstanceId` is correct for the coder/intern seats the lead does dispatch to. The skill should note the shared-member exception.
2. **`SWITCHBOARD_AGENT_INSTANCE_ID` is the head's own instance ID.** The lead's environment carries this (injected at terminal creation, `terminal-coder-dispatch/SKILL.md` §2 references `SWITCHBOARD_TERMINAL` but not `SWITCHBOARD_AGENT_INSTANCE_ID`). The skill should name it as the value to match against `parentInstanceId`.
3. **Standalone terminals.** A standalone terminal (no team) has `parentInstanceId: null` or `undefined`. The filter `parentInstanceId === $SWITCHBOARD_AGENT_INSTANCE_ID` correctly excludes these.
4. **Exited terminals.** `ptyListTerminals` returns terminals with `status: 'exited'`. The skill already says to check `status: 'active'` — this should be reinforced in the new §10 text.
5. **Multiple teams with the same head role.** Two Coding teams could exist (different worktrees). The `parentInstanceId` filter correctly scopes to the head's own team — a coder on the other team has a different `parentInstanceId`.
6. **The `recommendedRole` field.** The orchestration skill (line 76-82) already says "Do not re-derive it by reading the plan file's `Recommendation:` line." The `terminal-coder-dispatch` skill should cross-reference this or state the same rule: use `recommendedRole` from the plan record, do not invent complexity tiers.
7. **Interaction with existing plans.** The plan `feature_plan_20260817101700_lead-spreads-subtasks-across-idle-seats.md` rewrites the headPrompt to add idle-seat spreading. That plan amends the headPrompt; this plan amends the skill file. They are complementary and do not conflict — the headPrompt says *what* to do (spread across idle seats), the skill says *how* to identify those seats (filter by `parentInstanceId`).
8. **The `git diff` verification rule.** The rule "verify before undoing" should be general, not specific to the stand-down scenario. Any time the lead is about to send a terminal to revert, clean up, or undo work, it must first verify the state exists (`git diff`, `git status`, `git log`). This is the same "ground truth over self-report" principle the orchestrator skill holds (§1, line 20).

## Proposed Changes

### `.agents/skills/terminal-coder-dispatch/SKILL.md` — §10 rewrite (line 451-463)

Replace the current §10 text with a version that (a) scopes the pool to the lead's own team, (b) names `parentInstanceId` as the membership filter, (c) forbids second-guessing `recommendedRole`, and (d) adds a verify-before-undoing rule.

```markdown
## 10. Knowing your roster & tier resolution

Before dispatching, enumerate the live terminal pool with `ptyListTerminals`.
**Filter to your team's seats only** — a terminal is on your team when its
`parentInstanceId` matches your own `SWITCHBOARD_AGENT_INSTANCE_ID`
(injected into your environment at terminal creation). A terminal with no
`parentInstanceId` (null/undefined) is a standalone seat — not on your team,
never dispatch to it, never send it instructions. Role alone is not a
membership test: two standalone coders and your team's coder all report
`role: "coder"`, but only the one whose `parentInstanceId` matches yours is
yours to drive.

```bash
# Enumerate, then filter to your team
curl -s -X POST "$BASE/terminals/verb/ptyListTerminals" $AUTH \
  -H "Content-Type: application/json" --max-time 10 -d '{}' | \
  jq --arg myId "$SWITCHBOARD_AGENT_INSTANCE_ID" \
     '.terminals | map(select(.status == "active" and .parentInstanceId == $myId))'
```

**Shared members** (e.g. a shared reviewer) are spawned unparented and will
not match the `parentInstanceId` filter. This is correct for the Coding team:
the lead never dispatches subtasks to the reviewer directly. If your team
uses shared coders, identify them by the team-group membership in the
terminals config instead.

### Trust the roster — do not second-guess `recommendedRole`

Each subtask's plan record carries a `recommendedRole` field (`lead` | `coder`
| `intern`) — the seat the board would route it to. Use it. Do not invent your
own complexity tiers or compare scores against a self-derived notion of what
is "intern-tier" work. The operator seated the intern because they want it
used; a subtask with `recommendedRole: "intern"` goes to the intern, full stop.
If the recommended role is absent, treat it as `coder`. Do not re-derive it by
reading the plan file's `Recommendation:` line — nothing in the system parses
that line, and a remapped board would make it wrong.

### If the required seat is missing or too small

If the required pool or seat is missing or too small for the feature, **stop
and tell the user** to create terminals — naming the Agents-tab **Agent Groups**
control (which instantiates a wired team in one action) and the `+` button in
the column header (the single-terminal path). Do not attempt to create
terminals yourself; creation is not on the documented verb rail for agents, and
each terminal is a running agent CLI.

### When escalating and the rung above is absent

When escalating and the rung immediately above the failed seat is absent on
your team (e.g. no coder exists between intern and lead), dispatch to the
highest available rung above it and state the skipped rung in the dispatch
prompt. Never fall back downward to the same tier or a lower tier.

### Verify before you undo

Before sending any terminal a revert, cleanup, or stand-down instruction,
verify the state you are undoing actually exists. A stand-down message sent
to a clean terminal sends it hunting for damage that was never there — worse
than the original error. One call:

```bash
git diff          # unstaged changes
git diff --cached # staged changes
git status --porcelain  # any modifications at all
git log --oneline -5    # recent commits
```

If all four are empty (or show nothing relevant), the terminal is clean — say
nothing to it. If there are changes, name the specific files and commits in
your instruction. Never send a terminal to revert files you have not confirmed
are modified.
```

### `.claude/skills/terminal-coder-dispatch/SKILL.md` — mirror update

Update the `.claude` mirror to match the `.agents` version body text. The `.claude` version has a YAML frontmatter block (lines 1-6) that the `.agents` version does not — preserve the frontmatter, update the body. Run `npm run mirror:check` to verify parity.

### `src/services/teamWiring.ts` — `NEW_CODING_HEAD_PROMPT` (line 275)

Add one sentence to the headPrompt that cross-references the skill for team-membership filtering. This is a minimal addition that does not conflict with the two pending headPrompt rewrites (which address different clauses):

After "dispatch it to a seat of that role on your team", add:

> "Filter `ptyListTerminals` to seats whose `parentInstanceId` matches your `SWITCHBOARD_AGENT_INSTANCE_ID` — role alone is not a membership test, and a standalone seat with the same role is not yours to drive. Use the subtask's `recommendedRole` as the routing decision; do not invent complexity tiers or second-guess the roster. Before sending any terminal a revert or stand-down instruction, verify the state exists with `git diff` — a clean terminal sent to hunt for damage that was never there is worse than the original error."

**Migration:** This requires a recogniser for the current `NEW_CODING_HEAD_PROMPT` text (to replace it with the augmented text). However, since two other pending plans also rewrite the headPrompt, the migration should be coordinated: either (a) this plan's sentence is added after the other two plans' changes are merged, or (b) all three plans' headPrompt changes are merged into a single rewrite. Option (a) is simpler and avoids migration conflicts — the skill file changes (which are the primary fix) take effect immediately without migration.

**Recommendation:** Implement the skill file changes first (no migration needed, immediate effect). The headPrompt addition is a belt-and-suspenders reinforcement that can be merged after the other two headPrompt plans land.

### `src/webview/kanban.html` — Coding team `headPrompt` (line 4679)

If the headPrompt is amended, update the gallery entry to match (byte-identical). Defer until the other two headPrompt plans have landed.

### `src/webview/terminals.js` — `NEW_CODING_HEAD_PROMPT_CLIENT` (line 8877)

If the headPrompt is amended, update the client mirror to match (byte-identical). Defer until the other two headPrompt plans have landed.

## Verification Plan

1. **§10 says "your team's seats only".** Read the updated §10. Confirm it says "Filter to your team's seats only" and names `parentInstanceId` and `SWITCHBOARD_AGENT_INSTANCE_ID` as the filter. Confirm it says "Role alone is not a membership test."
2. **§10 says "trust the roster".** Read the updated §10. Confirm it says "Use the subtask's `recommendedRole` as the routing decision; do not invent complexity tiers or second-guess the roster."
3. **§10 says "verify before you undo".** Read the updated §10. Confirm it says "Before sending any terminal a revert, cleanup, or stand-down instruction, verify the state you are undoing actually exists" and shows the `git diff` / `git status` commands.
4. **Mirror parity.** Run `npm run mirror:check` and confirm no drift between `.agents/skills/terminal-coder-dispatch/SKILL.md` and `.claude/skills/terminal-coder-dispatch/SKILL.md`.
5. **Shared-member exception documented.** Read the updated §10. Confirm it notes that shared members (e.g. reviewer) are unparented and will not match the `parentInstanceId` filter, and that this is correct for the Coding team.
6. **No conflict with existing plans.** Read `feature_plan_20260817101700_lead-spreads-subtasks-across-idle-seats.md`. Confirm this plan's skill changes do not conflict with that plan's headPrompt changes — the skill says *how* to identify seats, the headPrompt says *which* seat to pick.
7. **HeadPrompt cross-reference (if implemented).** If the headPrompt sentence is added, confirm it appears in all three places (`teamWiring.ts`, `kanban.html`, `terminals.js`) and that the migration recogniser fires for the current text.
8. **Run tests.** `npx jest src/test/standing-orders-marker-contract.test.js` — confirm the headPrompt substring assertions still pass (the added sentence does not remove any of the pinned literals: `/kanban/dispatch`, `CODE REVIEWED`, `"from":"{head}"`, `Do NOT use /kanban/move`).
