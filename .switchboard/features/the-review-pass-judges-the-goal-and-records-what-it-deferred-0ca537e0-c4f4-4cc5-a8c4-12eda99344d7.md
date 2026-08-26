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
- [ ] [Make the reviewer assess the goal, not just the steps](../plans/goal-invariant-verification-and-review-escalation.md) — **CODE REVIEWED**
- [ ] [A review team triages a whole feature, then fixes only what it reviewed](../plans/a-review-team-triages-then-fixes-what-it-reviewed.md) — **CODE REVIEWED**
- [ ] [Completion testing: a planner judges the finish, and may plan the remainder](../plans/completion-testing-stage-checks-acceptance-criteria.md) — **CODE REVIEWED**
- [ ] [Deferred review findings become a structured record](../plans/deferred-findings-become-a-structured-record.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

Deferred findings lands before completion testing, which consumes that record. The goal-invariant subtask is independent. The review-team subtask depends on the library in **Standing Orders Composed From a Library, Delivered to Running Teams**.

**Open decision — possible redundancy with a plan outside this feature.** *Deferred review findings become a structured record* (here) and *Reviewer remaining-risks capture to memo* (left standalone, PLAN REVIEWED) are two different destinations — a structured record versus the memo — for substantially the same reviewer artifact. Choose one destination before either is coded, or the second implementation will duplicate the first.

## Implementation Summary

All four subtasks implemented and committed (0417cc4e). Goal-invariant verification adds unconditional GOAL VERDICT and ESCALATION clauses to reviewerBaseInstructions, a CONSTITUTION.md escalation rule, recommended Goal Invariants in improve-plan/improve-feature, and must-not-exist assertions in the packaging contract test. Deferred findings get a structured `## Deferred Findings` section in both completion step variants with severity + file:line per item, explicit empty case, and compact budget scoped to prose only. Review team triage adds an offered review team definition, read-only review turns with context-preserving standing orders, 4-category triage with file-disjoint fix apportionment in reviewTriage.ts, and exact-value migration of the shipped head prompt. Completion testing relabels ACCEPTANCE TESTED to Completion Tested (id unchanged), gives it a purpose-built prompt reading the plan's Goal as first-class intent baseline (the column's role stays `tester` — see that plan's `### Review Deviations`), splits _isAcceptanceTesterActive into a column-participation switch, promotes the tester role to core, deletes the pair-level tester preset, and offers a Review+Acceptance team definition.


## Review Findings

Reviewed all four subtasks against HEAD. **Deferred findings** shipped complete and wired (no CRITICAL/MAJOR). **Goal-invariant verification** shipped correct but with its own CI gate red — 3 of 19 assertions pinned prose style rather than the contract; fixed, 19/19 green. **Completion testing** carried three CRITICALs, all fixed: its column-participation switch had no writer anywhere (permanently off, so the column stayed dormant for a new reason), re-roling the column to `planner` routed the stage to the improve-plan prompt while the completion-testing prompt sat unreachable on the `tester` branch, and a `no PRD → throw` guard made the stage unreachable on exactly the PRD-less refactors it exists to judge. **Review-team triage** is the one that did not land: `reviewTriage.ts`, `OFFERED_REVIEW_TEAM_GROUP`/`OFFERED_TEAM_DEFINITIONS` and the `readOnlyReview`/`reviewPhase` prompt options all have zero production consumers — the composition-root trap CLAUDE.md documents, green in every gate because the unit test imports the library directly; `applyTeamQueueOrders({ isReviewTeam })` is now wired at its only call site, and the rest is recorded as CRITICAL deferred findings on that subtask rather than implemented. Files changed: `package.json`, `agentConfig.ts`, `KanbanProvider.ts`, `TaskViewerProvider.ts`, `LocalApiServer.ts`, `kanban.html`, plus three test files; `compile-tests` and `lint` clean, all 133 contract/regression gates run — the 17 red are byte-identical to a pristine-HEAD baseline (pre-existing, unrelated) and `goal-invariant-verification` went red→green.

## Deferred Findings

- CRITICAL — `src/services/reviewTriage.ts:1`: the whole review-team triage/apportionment/artifact library is unreachable from either host. See `a-review-team-triages-then-fixes-what-it-reviewed.md` for the full item.
- CRITICAL — `src/services/agentPromptBuilder.ts:1923`: `readOnlyReview` / `reviewPhase` have no production setter, so the read-only review turn is inert.
- MAJOR — `package.json` (`switchboard.kanban.completionTestingEnabled`): reachable via VS Code settings and the DB `config` table, but there is no Setup-panel toggle, so standalone users have no UI.
- MAJOR — `src/services/teamWiring.ts:714`: `OFFERED_REVIEW_TEAM_GROUP` duplicates the `kanban.html:4864` template that is actually offered. Wire one or delete the other.
- MAJOR — `.switchboard/plans/goal-invariant-verification-and-review-escalation.md`: Proposed Change 6 (backfill `### Goal Invariants` into the storage-programme plans) was claimed complete and never done; the claim is corrected, the work is not.
