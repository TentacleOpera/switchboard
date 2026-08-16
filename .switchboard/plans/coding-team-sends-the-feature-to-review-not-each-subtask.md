# Coding Team — The Lead Sends the Whole Feature to Review, Through Board Dispatch

## Goal

When every subtask of a feature is finished, the Coding team's lead makes **one** call — the board's advance-and-dispatch, on the feature's card — and the card moves to `CODE REVIEWED`. The lead never writes a review prompt, and never hands work to the reviewer directly.

### Why the lead behaves the way it does now

The lead is carrying two contradictory standing orders, and the wrong one wins.

**Order 1 — the team's `headPrompt`** (`kanban.html`, `SHIPPED_TEAM_TYPES`, Coding):

> "When a coder reports a subtask finished and you are satisfied with it, hand it to review yourself: … POST /kanban/dispatch with `{"plan":"<planId>","targetColumn":"CODE REVIEWED"}` … Do NOT use /kanban/move"

**Order 2 — the `reviewer` relationship preset** (`linkPresets.ts:67-75`), installed *on the lead* because the Coding team declares its reviewer as `{ role: 'reviewer', relationship: 'reviewer' }`:

> "{child} is your reviewer. When you finish a self-contained unit of work, hand {child} a summary of what changed and which files — it cannot see your conversation, so make the summary stand on its own — and ask it to review before you move on to the next unit."

That second order is the observed behaviour, verbatim. It instructs the lead to **compose a summary itself**, **hand it straight to the reviewer**, **per unit of work**, and it says nothing about a card. It wins over the first because it is self-contained — no planId to look up, no port file to read, no endpoint to get right.

The wiring is at `teamWiring.ts:645-680`: a member whose `relationship` resolves to a `head-receives` preset generates a pair-scoped standing order on the head about that member. `reviewer` is such a preset. So declaring the reviewer as the lead's `reviewer` relationship is what installs the instruction to bypass the board.

**Both orders are also the wrong granularity.** Both act per subtask. The ask is per feature.

## What changes

**1. The reviewer stops being the lead's pair partner.**

In the Coding team definition, the reviewer member becomes `relationship: 'reports-to-head'`.

That relationship is `member-receives`, so it generates **no** pair-scoped order on the head — `teamWiring.ts:676-678` carries it in the team prompt instead. The reviewer is still spawned, still seated, still a team member. It is now reached only the way a human reaching it would: by a card arriving in `CODE REVIEWED`. When it finishes, the team prompt already tells it to report back to the lead, which is what we want.

Do not invent a new relationship id for this. `reports-to-head` already produces exactly the required outcome.

**2. The `headPrompt` becomes feature-level and single-action.** It should say, in substance:

- Your coders work the subtasks of one feature. When a coder reports one finished, note it and give the coder the next one. **Do not send anything to the reviewer, and do not write review instructions — that is not your job.**
- When **every** subtask of the feature is finished, read the port from `.switchboard/api-server-port.txt`, confirm no subtask is still outstanding via `GET /kanban/feature`, then make one call: `POST /kanban/dispatch` with `{"plan":"<the FEATURE's planId>","targetColumn":"CODE REVIEWED","from":"{head}"}`.
- That one call moves the card and dispatches the reviewer with the reviewer's own prompt. Do not use `/kanban/move` — it moves the card and dispatches nobody.
- Only advance the feature your team worked.

The prompt must name the **feature's** planId. The current one names a subtask's, which is the other half of why cards never reached review as a unit.

**3. `"from":"{head}"` is load-bearing — do not trim it.** Team-scoped reviewer routing already ships (`resolveTeamScopedRoleTerminal`, `teamWiring.ts:914`, wired at `TaskViewerProvider.ts:9484` and `bootstrap.ts:2049`). It routes on `from`: it looks up the group the origin heads and picks the live member with the wanted role. Drop `from`, or send a name that is in no group, and the resolver returns `null` — dispatch falls back to workspace-wide resolution and hands the card to whichever reviewer sorts alphabetically first. In a one-team workspace that looks correct, so a trimmed prompt survives casual testing and misroutes the moment a second team is live.

**4. Nothing else moves.** No change to `/kanban/dispatch`, to the resolver, to the cascade behaviour, to how subtasks are assigned, or to the reviewer's own role prompt.

Changing the reviewer's `relationship` does **not** affect routing. The resolver reads group *membership* from `terminals.groups`; `relationship` only decides which standing orders get installed. The reviewer stays in the roster and stays addressable — it simply stops receiving hand-written prompts from the lead.

## Supersedes

`feature_plan_20260816164108_coding-team-head-advances-card-to-code-reviewed.md` — that plan is what installed the per-subtask `headPrompt` now in the tree. It correctly identified that the reviewer was never reached, but chose subtask granularity and did not remove the competing `reviewer` pair order, so the bypass survived. Implement this plan instead of that one; do not implement both.

## Already shipped — do not re-plan

`feature_plan_20260816164109_team-scoped-reviewer-routing-on-code-reviewed.md` **is implemented in the tree.** `resolveTeamScopedRoleTerminal` (`teamWiring.ts:914`) is called from both hosts and covered by `src/test/team-scoped-role-routing.test.js`. Nothing in this plan needs to build reviewer routing; it needs only to keep feeding it a correct `from`.

## Metadata

**Complexity:** 3
**Tags:** bugfix, backend, reliability

## Verification Plan

Start a Coding team on a feature with three subtasks and watch:

1. Coders finish subtasks one at a time and report to the lead.
2. After subtask one, **nothing** goes to the reviewer — no prompt in the reviewer terminal, no summary composed by the lead.
3. After the last subtask, the lead makes one `/kanban/dispatch` call on the feature's planId.
4. The feature's card moves to `CODE REVIEWED` on the board — visibly, without anyone dragging it.
5. The reviewer wakes with its own role prompt, not with text the lead wrote.
6. Inspect the lead's standing orders: there is no pair-scoped order naming the reviewer.
7. A second team running concurrently is untouched — its cards do not move.
