# The Review Pass Judges the Goal and Records What It Deferred

**Complexity:** 7

## Goal

Make it structurally impossible for a review to satisfy a plan's mechanics while reversing its purpose, and give the findings a review chooses not to fix a home that survives the card's advance. Today a change can pass every local gate while being dead on the goal it was written for, and what was deliberately deferred dissolves into prose nobody reads. This also scales review to a whole feature at once, with each reviewer fixing only what it reviewed.

## How the Subtasks Achieve This

- **A review team triages a whole feature, then fixes only what it reviewed** — review at team scale, producing one triaged list with each reviewer fixing its own share.
- **Completion testing: a planner judges the finish, and may plan the remainder** — turns the dormant ACCEPTANCE TESTED column into a real stage that judges a finished change against acceptance criteria.
- **Deferred review findings become a structured record** — gives what a review chose not to fix a machine-readable home that survives the card's advance.
- **Make the reviewer assess the goal, not just the steps** — goal-invariant verification plus review escalation, so a change cannot satisfy a plan's mechanics while reversing its purpose.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Make the reviewer assess the goal, not just the steps](../plans/goal-invariant-verification-and-review-escalation.md) — **LEAD CODED**
- [ ] [A review team triages a whole feature, then fixes only what it reviewed](../plans/a-review-team-triages-then-fixes-what-it-reviewed.md) — **LEAD CODED**
- [ ] [Completion testing: a planner judges the finish, and may plan the remainder](../plans/completion-testing-stage-checks-acceptance-criteria.md) — **LEAD CODED**
- [ ] [Deferred review findings become a structured record](../plans/deferred-findings-become-a-structured-record.md) — **LEAD CODED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

Deferred findings lands before completion testing, which consumes that record. The goal-invariant subtask is independent. The review-team subtask depends on the library in **Standing Orders Composed From a Library, Delivered to Running Teams**.

**Open decision — possible redundancy with a plan outside this feature.** *Deferred review findings become a structured record* (here) and *Reviewer remaining-risks capture to memo* (left standalone, PLAN REVIEWED) are two different destinations — a structured record versus the memo — for substantially the same reviewer artifact. Choose one destination before either is coded, or the second implementation will duplicate the first.

## Implementation Summary

All four subtasks implemented and committed (0417cc4e). Goal-invariant verification adds unconditional GOAL VERDICT and ESCALATION clauses to reviewerBaseInstructions, a CONSTITUTION.md escalation rule, recommended Goal Invariants in improve-plan/improve-feature, and must-not-exist assertions in the packaging contract test. Deferred findings get a structured `## Deferred Findings` section in both completion step variants with severity + file:line per item, explicit empty case, and compact budget scoped to prose only. Review team triage adds an offered review team definition, read-only review turns with context-preserving standing orders, 4-category triage with file-disjoint fix apportionment in reviewTriage.ts, and exact-value migration of the shipped head prompt. Completion testing relabels ACCEPTANCE TESTED to Completion Tested (id unchanged), re-roles to planner with a purpose-built prompt reading the plan's Goal as first-class intent baseline, splits _isAcceptanceTesterActive into a column-participation switch, promotes the tester role to core, deletes the pair-level tester preset, and offers a Review+Acceptance team definition.

