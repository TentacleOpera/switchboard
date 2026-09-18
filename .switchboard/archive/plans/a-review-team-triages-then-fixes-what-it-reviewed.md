# A review team triages a whole feature, then fixes only what it reviewed

## Goal

Let a team of reviewers review every coded plan in a feature at once, produce one triaged list, and have each reviewer fix the plans it reviewed — with intent failures and deferred risks written out as a single artifact for a planner instead of being fixed in place.

### Problem Analysis

**Review is the pipeline's narrowest point, and the current team shape makes it narrower.** A Review team ships today as *reviewer-as-head with a coder member* — `NEW_REVIEW_TEAM_HEAD_PROMPT` (`teamWiring.ts:856`): *"Apply a fully diagnosed fix set under approximately 100 lines directly. Delegate larger, broad, or parallelisable sets to your coder at {coder}… After the coder reports back, re-review ONLY the coder's git diff… If after 5 rounds the same critical issues persist, report to the originating lead that a new plan is needed."* One reviewer, one coder, serial rounds, per feature.

**Three things follow from that shape:**

1. **One reviewer is the whole throughput.** A feature with eight coded subtasks is eight sequential reviews behind one seat.
2. **Fixing and judging are the same act**, so a reviewer's verdict and its repairs are indistinguishable afterwards — a finding it quietly patched looks identical to one that was never there.
3. **Coder resolution is fragile.** The delegation resolver warns (`TaskViewerProvider.ts:21934-21945`) that in the shared-reviewer shape `resolveTeamRoleTerminal(targetAgent)` *"falls through to 'first group in stored order', which can return ANOTHER team's coder (wrong worktree). Do NOT 'simplify' this back to a single resolveTeamRoleTerminal call."* More reviewers make that resolution strictly worse.

**Parallel reviewers need no isolation, which is what makes this cheap.** A review pass that only reads cannot conflict with another, so no worktree and no branch is involved. Isolation only matters once fixes start, and by then the triage has already partitioned the work by plan.

**And the pieces are mostly present.** Head pacing is already this design: `'head'` uses `targetTerminalOverride: from` so *"the requesting head is the terminal… and the head delegates subtasks itself"* (`LocalApiServer.ts:1675-1677`) — a lead receives the feature and assigns its plans. Batch review already exists: the reviewer prompt switches to *"each listed plan"* with batch execution rules when `plans.length > 1`, so "two at a time per reviewer" is a batch of two, not a new concurrency cap.

**What is missing is the middle.** Six reviewers today produce six independent reports — each to the origin lead, each appended to its own plan file — and no single triaged list. There is nowhere a cross-plan verdict can live, and no mechanism that apportions fixes back to the reviewer that formed the opinion.

### Root Cause

The review stage was modelled as one agent per plan, so every artefact it produces is per-plan and every capability it has is per-plan. A feature-level verdict has no author and no home, and the reviewer's context — the most expensive thing the pass produces — is discarded between the judging turn and the fixing turn.

## Metadata

**Complexity:** 7
**Tags:** feature, agents, reliability, backend

## Settled Design

The flow, in order:

1. **A feature is moved to the review team.** One feature at a time, which head pacing's one-in-one-out already enforces.
2. **The lead assigns the feature's plans to its reviewers**, up to **two at once per reviewer** — a batch of two, using the existing multi-plan reviewer prompt.
3. **Each reviewer appends its findings to the plan file and reports to the lead.** Read-only: no fixes in this pass.
4. **When all have reported, the lead triages into four categories:** (1) needs no fixing, (2) fixes needed, (3) follow-ups needed for deferred issues or remaining risks, (4) did not meet intent — which may be a whole-feature verdict rather than a per-plan one.
5. **Categories 2 and 3 are apportioned back to the reviewer that reviewed them**, without clearing its context. Categories 1 and 4 are not fixed at all.
6. **The lead writes one markdown artifact** into the plans folder: deferred items, remaining risks, and plans that failed review on intent.
7. **The user may move that artifact to a planner.** Remediation for an intent failure is a new plan — never an edit to the plan that failed.

**Cards are not moved backward and nothing is reopened.** A plan that fails on intent *was* reviewed; the verdict lives in the artifact, not in the card's position.

## Complexity Audit

### Routine

- A team definition with a reviewer head and reviewer members.
- Assigning batches of two using the existing `plans.length > 1` reviewer prompt.

### Complex / Risky

- **The clear-on-done order destroys the context step 5 depends on.** `TEAM_QUEUE_DONE_ORDER_BODY` (`teamWiring.ts:314-326`) tells a member: *"The system will relay your completion report to your team lead, **clear your terminal**, and dispatch the next queued item."* A reviewer that reports in step 3 loses the review context it needs in step 5. This is not a blocker — `compose-standing-orders-from-a-library.md` already lists that body (`:314`) among the monoliths to break up, and its composition axes already include whether the team has a reviewer seat and which pacing mode is active. A review team composes orders without the clear fragment. The precedent for a selective exemption is in the same relay: the *lead* is sent `clearBeforePrompt: false` because the code *"never reset[s] the lead's context"*.
- **No cross-plan artefact exists.** Every review output today is per-plan; the lead's triaged list and its final artifact are the first feature-level review artefacts, and the plans folder is their home only because a `.md` there becomes a card.
- **Reviewers must not fix during the review pass.** If they can, they will, and the triage loses its input — the same reason the completion-testing stage is barred from fixing. The read-only constraint has to be structural for the review turn and lifted only for the apportioned fix turn.
- **Fix-phase concurrency is real, unlike review-phase.** Up to six reviewers writing at once is the collision the read-only framing avoided. The findings carry `file:line`, so apportionment can be made file-disjoint — the same maximum-independent-set logic `dispatch-analysis` already applies to plans, applied to fixes. Serialising the fix phase is the fallback.
- **Six reviewers on overlapping plans can duplicate findings.** Partitioned assignment (each plan reviewed once) avoids this by construction; it is only a problem if the design later moves to redundant multi-angle review of the same plan.
- **The existing Review team head prompt contradicts this at four points** — self-fix under 100 lines, delegate to a coder, re-review rounds, and commit. ~~It shipped, so it migrates.~~ **Correction: it did not ship.** The teams feature has never reached a published install, so the gallery text is simply replaced and no converter is needed. The `OLD_REVIEW_TEAM_HEAD_PROMPT` recogniser this line pointed at was itself written on the same false premise and has since been deleted.
- **The team definition must be offered, never pre-seeded with members.** `SEEDED_AGENT_GROUP` is deliberately member-less and `OLD_SEEDED_AGENT_GROUP` documents why: a seed with members *"would spawn three unrequested coder agent CLIs per lead — the release gate this migration exists to close."* Six reviewer members would spawn six per lead on the identical mechanism.

## Edge-Case & Dependency Audit

**Migration.** The Review team head prompt shipped and must be converted by exact-value match, leaving operator-edited groups alone. No card or column state changes.

**Security.** Findings and the final artifact are agent-written and render as text, never HTML. Reviewers gain no capability during the review pass and lose the coder-delegation path entirely.

**Side effects.** Six review seats is six CLIs of token cost per feature. The review pass is the expensive half and the parallel half; the fix pass is cheap and partly serial. Worth reporting the two separately rather than as one number.

**Ordering.** The standing-orders library is a precondition for step 5 — without composed orders, the clear-on-done fragment wipes the context the design needs.

## Dependencies

- **Requires** `compose-standing-orders-from-a-library.md` — a review team's orders must omit the clear-on-done fragment.
- **Pairs with** `deferred-findings-become-a-structured-record.md` — category 3 is exactly that record, and a poolable checklist needs its severity + `file:line` shape.
- **Feeds** `completion-testing-stage-checks-acceptance-criteria.md` — the lead's artifact carries the intent verdict and deferred set that stage would otherwise rediscover.
- Independent of the worktree and streams work: a read-only review pass needs no isolation.

## Adversarial Synthesis

**"Six reviewers is extravagant."** The review pass is read-only and parallel-safe, so its cost is tokens rather than risk, and it is bounded by the feature's plan count. The alternative is one seat serialising eight reviews while the rest of the pipeline waits.

**"Let the reviewers fix as they go — the triage is overhead."** Then the record is unreliable: a finding fixed in passing is indistinguishable from one never raised, and the lead has nothing to triage. The triage is what makes categories 1 and 4 meaningful.

**"The lead is a bottleneck at step 4."** It is, deliberately — one agent forming one verdict is the point, and it is reading six reports rather than eight diffs.

**"Have the lead assign fixes to coders instead of back to reviewers."** That discards the review context, which is the expensive artefact, and reintroduces the wrong-worktree coder resolution the delegation resolver warns about.

**"An intent failure should reopen the plan."** No: the plan was reviewed and found wanting, and appending to a failed plan hides that it failed. A new plan is the honest record.

## Proposed Changes

1. **Add a review team definition** — reviewer head, reviewer members — offered rather than seeded.
2. **Compose review-team standing orders** without the clear-on-done fragment, so a reviewer keeps context between its review and fix turns.
3. **Make the review turn read-only** and the fix turn write-enabled, as distinct dispatches to the same seat.
4. **Assign in batches of two** via the existing multi-plan reviewer prompt.
5. **Add the lead's four-category triage** as a defined step with a defined output.
6. **Apportion categories 2 and 3 back to the originating reviewer**, file-disjoint where the findings allow.
7. **Have the lead write one artifact** to the plans folder covering deferred items, remaining risks, and intent failures.
8. **Migrate the shipped Review team head prompt** by exact-value match.
9. **Remove the coder-delegation path** from the review team shape.

### Migration

**None.** An earlier revision of this section called for "exact-value conversion of the shipped Review team head prompt".
That was wrong: the teams feature has never shipped to users, so no install carries an adopted team and there is no
persisted head prompt to convert. Unreleased dev work takes a clean break. Do not add a converter here — a no-op
migration reads to the next person as evidence the team gallery was released.

## Verification Plan

### Goal Invariants

- No reviewer writes code during a review turn.
- Every plan in the feature is reviewed exactly once.
- A reviewer's fix turn sees its own review context.
- Categories 1 and 4 are never fixed.
- Nothing is appended to a plan that failed on intent.

### Automated Tests

- **The review turn cannot write:** assert no code-write path is reachable from a review-turn dispatch, and that its git policy prohibits code commits.
- **Context survives the report:** report from a reviewer, then dispatch its fix turn; assert the terminal was not cleared. This fails today because the shipped order body says to clear it.
- **Coverage without duplication:** assign a feature of eight plans across six seats; assert every plan is reviewed once and none twice.
- **Batch of two, not two dispatches:** assert a two-plan assignment renders the multi-plan reviewer prompt rather than two single dispatches.
- **Fixes land with the original reviewer:** assert a category-2 fix is dispatched to the seat that reviewed that plan, not to any free seat.
- **Concurrent fixes are file-disjoint:** assign two fixes touching the same file; assert they are not dispatched concurrently.
- **Intent failures are not fixed and not reopened:** assert no fix dispatch is generated for category 4, and no write occurs to the failed plan file beyond its findings.
- **One artifact, correct contents:** assert exactly one artifact is written per feature carrying deferred items, remaining risks and intent failures.
- **No team seed spawns a CLI:** assert the definition is offered and `SEEDED_AGENT_GROUP` still has no members.

### Manual Verification

- Run a real multi-plan feature through the flow and confirm the artifact reads as something a planner could act on unaided.

## Outstanding Questions

None.

## Review Findings

The subtask shipped, and it shipped in the right medium: this flow is prompt-level orchestration, so `NEW_REVIEW_TEAM_HEAD_PROMPT` (`teamWiring.ts:814`, mirrored at `kanban.html:4880`) plus the member standing order **are** the implementation — the lead assigns plans in batches of two, the review turn is read-only, reviewers append findings and report, the lead triages and writes one artifact. `applyTeamQueueOrders` gained an `isReviewTeam` flag whose only caller never passed it, so `REVIEW_TEAM_QUEUE_DONE_ORDER_BODY` was defined, tested and never installed; that is now resolved from the group's own `headRole` at `LocalApiServer.ts:5117`. **The remaining finding is dead scaffolding, not a missing seam.** `src/services/reviewTriage.ts` computes assignment, triage, file-disjoint fix waves and the lead artifact in TypeScript — work the lead does in conversation, at a seam that does not exist: team communication is `ptySendPrompt` with lead-authored text, and `LocalApiServer` never calls `generateUnifiedPrompt`, so no composed prompt (and no `readOnlyReview` option) ever reaches a team member. Its CI-wired test was green, which made the board read as "triage implemented" when what is implemented is a paragraph. **Resolved:** `reviewTriage.ts` and the `readOnlyReview`/`reviewPhase` prompt options are deleted, as are the unconsumed `OFFERED_REVIEW_TEAM_GROUP`/`OFFERED_TEAM_DEFINITIONS` exports that had already drifted from the `kanban.html` gallery on member count. `src/test/review-team-triage.test.js` is rewritten to pin what actually ships: the head prompt's flow, the review-team order body **and its call site**, batched multi-plan rendering, the member-less seed, and the structural-repair migration.

## Deferred Findings

- WITHDRAWN — Proposed Change 8 (exact-value migration of the shipped Review team head prompt) was built on a false premise: **the teams feature has never shipped to users.** No published install has an adopted team, so there is no persisted head prompt to convert. `PRE_TRIAGE_REVIEW_HEAD_PROMPT` and `isUntouchedPreTriageReviewTeam` were dead weight the day they were written, and `209cd7fc` was correct to delete that whole family — per CLAUDE.md, unreleased dev work takes clean breaks, no migrations, no compat shims. Nothing outstanding.
