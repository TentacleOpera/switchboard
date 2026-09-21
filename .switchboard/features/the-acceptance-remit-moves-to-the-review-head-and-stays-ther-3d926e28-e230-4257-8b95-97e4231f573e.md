# The Acceptance Remit Moves to the Review Head, and Stays There

**Complexity:** 6

## Goal

The Acceptance Tester role is retired and its intent-judging job folds into the Review team head. Separately, that head is about to become its own lead-reviewer role, and half the fold is keyed on the role rather than the team — so it would arrive and then stop arriving. These two plans are the fold and the thing that keeps it delivered, grouped so the handoff between them is owned rather than assumed.

## Problem analysis

Two plans were written weeks apart, by different passes, against the same
surface — and neither knew about the other. Grouping them is how the seam between
them gets an owner instead of being discovered by whoever lands second.

**`cdbf4ebe` retires the Acceptance Tester and folds its job into the Review
head.** The tester's intent contract is fully specified at
`agentPromptBuilder.ts:2435` and completely dark: the role is disabled by default
(`tester: false`) and the ACCEPTANCE TESTED column is gated behind
`_isAcceptanceTesterActive`, so nothing in the pipeline currently asks whether a
delivered change achieves what was asked. That plan removes the role and the
column, and extends `REVIEW_HEAD_WORK` so the head verifies deferred findings
(distinguishing "no deferred record" from "no deferred findings"), judges intent
against the plan's `## Goal` rather than its letter, and may write one bounded
follow-up plan.

**The second plan exists because the head is about to stop being a `reviewer`.**
The companion feature *A Review Lead Is Its Own Role* (`ff6b8977`) changes the
Review team's head to `lead-reviewer`. `cdbf4ebe` predates that idea and
reasonably assumes a reviewer-headed team.

The fold then splits in two, and only one half survives:

- **Team-keyed, safe.** `NEW_REVIEW_TEAM_HEAD_PROMPT` appends to
  `REVIEW_HEAD_WORK` and composes on the *team*, so the head prompt still reaches
  a head whose role changed. `cdbf4ebe` pinned that landing site deliberately.
- **Role-keyed, lost.** Dispatch prompts are keyed on the column's role
  (`CODE REVIEWED -> 'reviewer'`) and today's head receives them because its seat
  sits in the reviewer pool. The reshape removes it from that pool — silently.
  `resolveBaseInstructions('reviewer', ...)` carries the `GOAL VERDICT` clause and
  stops matching. And `buildKanbanBatchPrompt` has no default arm, so a
  `lead-reviewer`-keyed build throws `Unknown role`.

One half goes quiet, the other goes bang, and no gate in either plan covers it:
`cdbf4ebe`'s assert the fragment's *content*, the role feature's assert stage and
routing. That the clause reaches the actual head is asserted by neither.

## Ownership boundary

The two subtasks overlap on one file and one concept. The boundary is explicit so
neither seat has to infer it:

| | `cdbf4ebe` — the fold | the delta plan |
| :--- | :--- | :--- |
| `standingOrderFragments.ts` | **owns** — the clauses, the deferred-record distinction, the bounded follow-up remit, the artifact-ban rewording | must not edit |
| `tester` role, ACCEPTANCE TESTED column, `'tester-pass'` remap | **owns** | must not touch |
| `ticket_updater`, `claude_designer`/`claude_artifacts`/`claude_import` | **owns** | out of scope |
| `agentPromptBuilder.ts` role arms, `buildKanbanBatchPrompt` | out of scope | **owns** |
| `goal-invariant-verification.test.js` delivery assertions | out of scope | **owns** |
| what the acceptance remit *says* | **authoritative** | asserts it arrives, never restates it |

Where the two disagree about the fold's wording, `cdbf4ebe` wins. The delta plan
says so in its own Goal.

## What this feature does NOT close

Recorded so the next reader does not assume the remit covers more than it does.
Neither subtask owns these; both were measured on 2026-09-21 while reviewing plan
`9bb74844`.

**1. An instruction to judge intent is not a gate — and this was demonstrated,
not theorised.** The review dispatch template already carries `GOAL VERDICT
(mandatory — your review is incomplete without it)`. Reviewing `9bb74844`, the
head produced that verdict, correctly returned NOT ACHIEVED, and still got the
cause wrong: it judged against `## Proposed Changes` §1 and never opened the
`## Goal` on line 5, which already specified the simpler rule the implementation
had abandoned. The clause fired and missed. `cdbf4ebe` now requires the verdict
to QUOTE the Goal verbatim, which is the cheapest available discriminator — you
cannot produce the quote without reading it. But it remains a model following an
instruction; nothing asserts the verdict was *performed*, only that the clause
*arrived*. The delta plan closes arrival. Performance is still open.

**2. Nothing checks a plan against itself, at any stage.** `9bb74844` contained
both rules before a line of code existed: its `## Goal` (line 5) specified
`accept 3` for a lead on a feature subtask, and its `## Proposed Changes` §1
(line 329) specified a generalised non-feature candidate list ordered
`owner_since ASC`. Six CRITICAL findings followed from the second — all of them
properties of machinery the Goal never asked for. Every gate in the pipeline asks
whether the CODE matches the PLAN. No gate asks whether the plan matches itself.
This is the cheapest catch in the chain and the only one nobody is making:
review-time detection pays for the mistake twice, because the coder has already
built it.

**3. The contradiction was introduced by a protocol working correctly.** The
`improve-plan` workflow's Step 4 ("Challenge the approach") supersedes a plan's
chosen approach when an alternative looks better, and `9bb74844`'s callout
(lines 305-314) is fully protocol-compliant — Superseded / Reason / Replaced-with
all present. Its stated reason was that the original spec "only covered feature
subtasks, while `accept` is also the self-acceptance verb for non-feature
callers." That is a real observation with a wrong remedy: a non-feature caller
holds ONE card, so bare `accept` already resolved it and needed no ordering at
all. Step 4's load-bearing probe is asymmetric — it asks whether an approach only
*appears* to achieve the goal (under-delivery) and never whether it delivers
*more* than the goal requires (over-delivery), and its "list 2-3 alternatives"
step does not require the minimum viable option or "keep the current spec" to be
among them. So supersede ratchets toward machinery. Fixing that belongs in
`.agents/protocols/improve-plan/SKILL.md`, which is outside both subtasks and
outside this feature.

## How the Subtasks Achieve This

- **The Agents Tab Stops Offering Roles Nobody Should Pick**: cuts the optional
  roles down to those that earn a seat and folds the retired tester's acceptance
  criteria into `REVIEW_HEAD_WORK` — the one source the head prompt appends to —
  so intent judging lands somewhere rather than being deleted with the role.
- **The Folded Acceptance Remit Survives the Review Head Becoming Its Own Role**:
  keeps the role-keyed half of that fold delivered once the head becomes
  `lead-reviewer` — the base-instructions arm, the batch builder's missing arm,
  and the gate that asserts the clause *reaches* a head rather than merely
  existing in the builder's source.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [The Agents Tab Stops Offering Roles Nobody Should Pick](../plans/the-agents-tab-stops-offering-roles-nobody-should-pick.md) — **PLAN REVIEWED** — ID: cdbf4ebe-8181-418c-abf6-4241076b2148
- [ ] [The Folded Acceptance Remit Survives the Review Head Becoming Its Own Role](../plans/the-review-lead-inherits-the-acceptance-testers-intent-remit.md) — **PLAN REVIEWED** — ID: fe022a93-4843-4d2d-b17a-b5c0a18cef26
<!-- END SUBTASKS -->

## Dependencies & sequencing

1. **`cdbf4ebe` lands first.** It is self-contained against today's
   reviewer-headed team and needs nothing from its sibling. Landing it alone is
   correct and leaves the board better.
2. **The delta plan lands with or before the team reshape** — *The Review Team Is
   a Lead Reviewer and Three Reviewers* in feature `ff6b8977`. The window between
   the head changing role and the delta landing is a window in which the lead
   judges nothing against the goal, and the pool-path failure is silent.

**Cross-feature dependency.** The delta plan also needs *Lead Reviewer Is a Core
Role* (`ff6b8977`) for the role to exist at all. It is deliberately the join
between the two features rather than a subtask of either: it is meaningless
without the fold, and harmless without the role. Sequencing across both is
therefore: `cdbf4ebe` -> works-at declaration -> the role -> **this delta** -> the
team reshape.

Each subtask carries a discrimination proof — break the mechanism, show the named
assertion goes red, restore by inverse edit, never `git restore`. For the delta
plan that proof is the point: removing the `lead-reviewer` arm must turn the
delivery cases red while the reviewer cases stay green, because a gate that passes
either way is what let this seam open.

