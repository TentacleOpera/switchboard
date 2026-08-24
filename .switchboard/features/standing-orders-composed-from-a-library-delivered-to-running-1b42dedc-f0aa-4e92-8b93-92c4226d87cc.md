# Standing Orders Composed From a Library, Delivered to Running Teams

**Complexity:** 6

## Goal

Replace fixed per-team order monoliths with a library of small named fragments composed for the situation, give that library an operator-reachable surface, and fix the delivery gap that means prompt-text changes only ever reach newly spawned teams. Today an order edit is invisible to every team already running, so the fleet drifts into two generations of instructions with no way to tell them apart.

## How the Subtasks Achieve This

- **Compose standing orders from a library instead of installing monoliths** — the composition mechanism everything else here plugs into: small named fragments assembled for the situation rather than one fixed body per team.
- **Standing Orders Library section in the tab** — create, edit and delete definitions with a usage count, so the library is operable rather than source-only.
- **Review-team head standing orders must migrate on read** — the read-path rewriter that gets changed order text to teams that are already running.
- **Review-team head orders: supersede the first-generation text** — replaces the old body on that read path, recovering the coder's terminal name from the on-disk text so the placeholder can be filled.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Review-Team Head Standing Orders Must Migrate On Read](../plans/review-team-head-orders-must-migrate-on-read.md) — **PLAN REVIEWED**
- [ ] [Review-Team Head Orders: Supersede The First-Generation Text](../plans/review-team-head-order-old-generation-supersession.md) — **PLAN REVIEWED**
- [ ] [Compose standing orders from a library instead of installing monoliths](../plans/compose-standing-orders-from-a-library.md) — **PLAN REVIEWED**
- [ ] [Standing Orders Library Section in the Tab](../plans/standing-orders-library-section-in-the-tab.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

The library mechanism lands first; the tab section and the two migration subtasks follow it. The two review-team subtasks reference each other and must land together — migrate-on-read is the mechanism and supersession is its first payload; either alone is inert.

The existing **Standing Orders Library and Tab** feature is entirely CODE REVIEWED, so this is follow-on work rather than a duplicate home.

## Team Dispatch Instructions

### Shipping order

1. **Plans 1 & 2 (Review-team migration pair)** — ready to code now. Plan 1 first, plan 2 second. They share `migrateReviewTeamOrders` and its client mirror; plan 2 extends plan 1's converter with a replace branch. Either alone is inert.
2. **Plan 4 (Library section in the tab)** — ready to code now. Independent of plans 1-3. Builds on the existing shipped `StandingOrderDefinition` model and Standing Orders tab.
3. **Plan 3 (Compose from library)** — **blocked**. Depends on `add-a-task-complete-endpoint-for-the-lead.md` (endpoint not implemented) and has outstanding user questions (confirm axes, fragment granularity, orchestrator-liveness signal). Independent of plans 1, 2, 4.

### Per-subtask dispatch

#### Review-Team Head Standing Orders Must Migrate On Read
- **Seat:** Coder (complexity 5)
- **Acceptance criteria:** `migrateReviewTeamOrders` returns its input by reference when nothing is stale (reference short-circuit pinned by test). `PRE_CARD_MOVEMENT_RULE_REVIEW_HEAD_PROMPT` and `PRE_COMMIT_INSTRUCTION_REVIEW_HEAD_PROMPT` rows each converge to exactly `NEW_REVIEW_TEAM_HEAD_PROMPT` in one pass. A second pass returns the input by reference. Coding/Review recognisers are disjoint (negative test). Operator edits survive (house rule preserved verbatim). Client mirror composition literal updated at `stage-marker-commit-contract.test.js:524`.
- **Scope constraints:** Additive transforms only — no whole-text replace (that is plan 2). Do not refactor `NEW_REVIEW_TEAM_HEAD_PROMPT` away from a pure quoted `+` chain (breaks `readQuotedChain`). Do not touch `migrateCodingTeamOrders` or `migrateAgentGroups`. Constants hand-mirrored to `terminals.js` (cannot import).

#### Review-Team Head Orders: Supersede The First-Generation Text
- **Seat:** Coder (complexity 6)
- **Acceptance criteria:** `OLD_REVIEW_TEAM_HEAD_PROMPT` row with `{coder}` → `rev-1` becomes exactly `NEW_REVIEW_TEAM_HEAD_PROMPT` with `{coder}` → `rev-1` in one pass. Post-additive hybrid (`RULE + OLD + COMMIT`) also converges in one pass. Coder name containing `$&` round-trips verbatim (replacer function, not string). Unrecoverable name fails closed (no literal `{coder}` emitted). `NEW_REVIEW_TEAM_HEAD_PROMPT_CLIENT` byte-identical to host constant. Replace branch precedes additive branches.
- **Scope constraints:** Must ship after plan 1 (extends its converter). Do not "fix" the pre-existing `{head}` substitution `$`-pattern hazard in `migrateCodingTeamOrders`. `OLD_REVIEW_TEAM_HEAD_PROMPT` is a frozen snapshot — never edit. Replace destroys operator edits by design (the removed fragment is the supersession signal).

#### Compose standing orders from a library instead of installing monoliths
- **Seat:** Coder (complexity 6) — **but blocked until dependencies resolve**
- **Acceptance criteria:** Every emitted set is the composition of fragments applicable to that team's actual shape. No emitted set contains contradictory card-movement instructions. A team with no reviewer seat is never told to move a card to CODE REVIEWED. A team with no orchestrator is never told to post an orchestrator report. Every seat retains exactly one completion obligation under every combination. Stale monolithic bodies are rewritten to composed sets; hand-added orders survive. Recomposition triggers on team wiring, pacing, roster, and queue-mode changes.
- **Scope constraints:** Blocked by `add-a-task-complete-endpoint-for-the-lead.md` (not implemented). User must confirm the four axes and fragment granularity before coding. The orchestrator-liveness signal is `missionControlArmed` (legacy `orchestratorArmed` renamed); verify it is trustworthy before committing to that axis. This plan's fragment registry is a **separate concept** from plan 4's `StandingOrderDefinition` model — do not conflate them. Mark `context-aware-completion-reporting.md` superseded.

#### Standing Orders Library Section in the Tab
- **Seat:** Coder (complexity 5)
- **Acceptance criteria:** Library section renders above assignments with create/edit/delete and usage counts. `getStandingOrders` verb returns `definitions` alongside `orders` in one round-trip. `addStandingOrder` threads `definitionId` through to `makeStandingOrder`. Three new verbs (`addStandingOrderDefinition`, `updateStandingOrderDefinition`, `deleteStandingOrderDefinition`) resolve through `_resolveStandingOrdersRoot` and appear in the fleet-root contract test's verb list. Assign-from-library dropdown on the add form. Linked-assignment detach notice shown. Role-not-found badge renders. `mutateStandingOrderDefinitions` skips write when mutator returns input by reference. No `onclick=` anywhere (CSP). No `type` field on verb returns.
- **Scope constraints:** Do not add a separate `getStandingOrderDefinitions` verb (usage count would race). Do not call `syncDefinitionToAssignments` from inside a `mutateStandingOrderDefinitions` callback (deadlocks the shared write chain). Run `npm run catalog:generate` after adding verb cases. No confirm gates (CLAUDE.md).

### Reconciliation notes

- **Plans 1 & 2** share `migrateReviewTeamOrders` in `teamWiring.ts` and its client mirror in `terminals.js`. Plan 2 inserts a replace branch ahead of plan 1's additive transforms. No contradiction — ordering is the only constraint.
- **Plan 3 vs Plan 4** — conceptual gap: plan 3's fragment registry (code-defined obligations with predicates) and plan 4's `StandingOrderDefinition` (user-created reusable instructions) are different concepts. The feature Goal's "a library of small named fragments... give that library an operator-reachable surface" implies one library; the plans implement two complementary but distinct systems. If they should converge, that is a user design decision.
- **Feature sequencing discrepancy:** The Dependencies & sequencing section above says "The library mechanism lands first." Plan 3 (library mechanism) is blocked by an external dependency. Plans 1, 2, and 4 are ready now and independent of plan 3.

