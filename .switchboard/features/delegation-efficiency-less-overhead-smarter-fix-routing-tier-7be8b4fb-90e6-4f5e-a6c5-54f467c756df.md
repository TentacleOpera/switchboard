# Delegation Efficiency: Less Overhead, Smarter Fix Routing, Tiered Review

**Complexity:** 7

## Goal

Reduce pointless overhead in the reviewer-coder delegation loop across three dimensions: (1) stop forcing reviewers to specify exact fixes for judgment calls where the coder has better context, (2) allow reviewers to self-fix small diagnosed sets under ~100 lines instead of mandating delegation, and (3) add a two-stage pre-review gate (mechanical compile/diff-coverage check + phone-a-friend sanity review) so the expensive reviewer only sees work that has passed cheap checks. Composed from a real session post-mortem where a ~60-line surgical set generated four long messages, one wasted round from over-prescriptive instructions, and ~20 dead source-text test assertions.

## How the Subtasks Achieve This

- **Reviewer Fix Delegation: Self-Fix Threshold + Diagnosis-Only for Judgment Calls**: Merges two related changes to the delegation `fixStep`/`verifyStep` templates in `agentPromptBuilder.ts` into one plan that owns the shared surface. The self-fix threshold adds a conditional escape hatch: when the reviewer has fully diagnosed a fix set under ~100 lines, they fix directly instead of delegating (the threshold is a runtime decision after Stage 1 + Stage 2, not a dispatch-time routing change). Within the delegation branch, the two-tier mechanical/judgment distinction gives precise fix instructions for mechanical findings (compiler is a shared oracle) and diagnosis + reasoning only for judgment calls (letting the coder choose the fix). Uses Option B for the anti-leakage step (both steps present, prefixed with conditions) so the LLM explicitly sees both paths. Eliminates both the instruction-writing cost on small diagnosed sets and the Round 3 failure mode where over-prescriptive instructions channeled the coder toward the reviewer's potentially-wrong fix direction.
- **Tiered Review: Mechanical Gate + Phone-a-Friend Pre-Review Before Expensive Reviewer**: Adds a two-stage pre-filter before the expensive reviewer is dispatched. Stage 1 is a system-level mechanical gate (new `POST /review/pre-check` endpoint) running compile + diff coverage at zero agent cost. Stage 2 repositions phone-a-friend from a post-batch side-channel to a pre-review pipeline stage that checks "did they actually implement it" at low agent cost. The expensive reviewer only sees pre-checked work and is told to focus on deep analysis. Gracefully degrades: if phone-a-friend isn't configured, the mechanical gate still catches the cheapest failures.

## Dependencies & sequencing

Subtasks are independent at the code level and can be executed in parallel. The delegation plan modifies `agentPromptBuilder.ts` template strings (lines 1820-1850). The tiered review plan modifies `LocalApiServer.ts` (new endpoint), `TaskViewerProvider.ts` (dispatch pipeline), `agentPromptBuilder.ts` (reviewer prompt addition — different section from the delegation plan), and `KanbanProvider.ts` (phone-a-friend mode). No shared-file conflicts: the `agentPromptBuilder.ts` changes are in different sections (delegation plan = fixStep/verifyStep at lines 1824-1844; tiered review plan = reviewer base instructions, a one-line addition).

They compose conceptually: the reviewer sees pre-checked work (tiered review), then applies the self-fix threshold with two-tier delegation (delegation plan). Recommended execution order if sequencing: delegation plan first (smaller, single-file, immediate overhead reduction), then tiered review plan (larger, new endpoint, pipeline change).

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Reviewer Fix Delegation: Self-Fix Threshold + Diagnosis-Only for Judgment Calls](../plans/self-fix-threshold-for-surgical-sets.md) — **CODE REVIEWED** — ID: e5ff5d65-be48-4891-aaec-e9df41d5c2f7
- [ ] [Tiered Review: Mechanical Gate + Phone-a-Friend Pre-Review Before Expensive Reviewer](../plans/tiered-review-mechanical-gate-and-phone-a-friend-pre-review.md) — **CODE REVIEWED** — ID: 2cd20aeb-8eb6-4863-8da1-beedc4584bbb
<!-- END SUBTASKS -->

## Review Findings

Reviewed the combined delivery and fixed material issues across `src/services/agentPromptBuilder.ts`, `LocalApiServer.ts`, `TaskViewerProvider.ts`, `KanbanProvider.ts`, `teamWiring.ts`, `src/webview/kanban.html`, `protocol-catalog.json`, and the two contract tests. The fixes make the self-fix instruction consistent through the full prompt/standing-order path, run the mechanical gate asynchronously in the routed worktree, make Phone-a-Friend a verdict-bearing sequential gate, prevent mode races and post-batch double triggers, and migrate untouched shipped Review-team prompts. Validation passed: `npm run compile`, `npm run compile-tests`, `npm run test:contract:team-scoped-routing` (62/62), `npm run test:contract:standing-orders-marker` (55/55), `npm run catalog:check`, and `npm run lint` (0 errors; existing warnings remain). CI invokes compile and both contract scripts in `.github/workflows/integration-tests.yml`; remaining risk is limited to the intentionally unbounded wait when a live Phone-a-Friend never sends its completion signal, which emits the existing stall notice.

