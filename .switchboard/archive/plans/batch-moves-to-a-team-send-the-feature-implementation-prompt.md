# Batch moves to a team send the feature implementation prompt

## Goal

When a batch move targets a team head, send the prompt that tells the lead to **allocate** the plans across its seats instead of the prompt that tells the recipient to work them itself. No feature row is created — only the prompt changes.

### Problem Analysis

**The batch prompt instructs the recipient to do the work.** `BATCH_EXECUTION_RULES` (`agentPromptBuilder.ts:852-855`): *"Treat each plan file path below as a completely isolated context… Execute each plan fully before moving to the next (if sequential)."* Correct for a lone coder. Sent to a team lead it directly contradicts the lead's own standing order, which says the lead distributes: *"You lead this team. Your coders work the subtasks of one feature… Each subtask carries a recommendedRole; dispatch it to a seat of that role on your team"* (`teamWiring.ts:768-773`).

So a batch onto a team either serialises N plans behind the lead's own hands or forces it to disregard its dispatch instructions. Either way the team's other seats stay idle, which defeats the reason the user started a team.

**The prompt that does the right thing already exists — but as TWO flags, not one.** `featureMode` and `driveMode` together compose the allocate reframe. Setting `featureMode` does three things with no new code:

1. **Suppresses `BATCH_EXECUTION_RULES` automatically** — `agentPromptBuilder.ts:1794`: `const effectiveBatchExecutionRules = (options?.featureMode === true) ? '' : batchExecutionRules;`
2. **Suppresses the subagent block** — `:1795`, on the same condition.
3. **Injects the orchestration directive** via `resolveFeatureOrchestrationDirective(featureTopic, subtaskCount, …)` (`:1356`).

But `featureMode` alone switches the intro to *"Please execute the feature described below"* (`buildExecutionIntro`, `:448-458`) and the authorization to *"begin implementation immediately"* (`:1805`) — still "do it yourself." The **allocate** framing — *"Dispatch each subtask to a seat on your team — do not implement subtasks yourself"* — is the `driveMode` branch of `resolveFeatureOrchestrationDirective` (`:1391-1398`), and the *"begin dispatching subtasks to your team seats immediately"* authorization is gated on `(options?.driveMode && options?.featureMode)` (`:1803-1804`).

> **Superseded:** `featureMode` is set on the dispatch when the batch target is a team head, with `subtaskCount` = the number of plans sent. *(Original Settled Design — featureMode alone.)*
> **Reason:** `featureMode` alone produces the default directive branch (`:1400-1405`): *"You are implementing the feature… Work through the subtasks… begin implementation immediately."* That is "do it yourself," not "allocate." The allocate framing lives in the `driveMode` branch (`:1391-1398`), which the original plan never set. The plan's own Automated Test expected *"the dispatch-to-seats authorization"* (`:1804`) — a line gated on `driveMode` — but the Settled Design specified no mechanism to produce it. Internal inconsistency: the test demanded a flag the design never set.
> **Replaced with:** Set **both** `featureMode` and `driveMode` on the team-head batch path. `featureMode` supplies the suppressions (BATCH_EXECUTION_RULES, subagent block); `driveMode` supplies the dispatch-to-seats framing and authorization. A new `batchMode` parameter on `resolveFeatureOrchestrationDirective` selects a batch-specific directive branch (see Proposed Changes §3a) that replaces the feature-file-read instruction and the unit clause with batch-appropriate wording.

**But the `driveMode` directive assumes a feature file, and a batch has none.** The `driveMode` branch (`:1396`) says *"Read the feature file's Team Dispatch Instructions section for seat assignments, acceptance criteria, and scope constraints per subtask — do not read individual plan files."* A batch has no feature row, no feature file, and no Team Dispatch Instructions — and the lead *must* read the individual plan files to do the conflict pass. So `driveMode` cannot be reused as-is; a batch directive branch is required that drops the feature-file-read instruction and tells the lead to read the plans themselves.

**And the directive asserts a cohesion a batch does not have.** `resolveFeatureOrchestrationDirective` (`:1374-1376`) emits a unit clause:

> *"All subtasks are part of a single delivery unit — do not treat them as independent tickets."*

and, with several topics, *"The subtasks of each feature are a single delivery unit — do not treat them as independent tickets, and do not interleave work across features."*

For a batch that is precisely backwards. The plans may be completely unrelated — that is the normal case for an ad-hoc selection — and telling the lead not to treat them as independent tickets misdescribes the work. So the batch directive must replace this with the opposite assertion and add what a feature file would otherwise have supplied: check the plans for file overlap and declared dependencies, sequence the ones that collide, parallelise the rest.

**And what a batch actually lacks is the dependency advice a feature carries.** A feature's subtasks declare their dependencies in their own plan files — which is why `dispatch-analysis` can treat a feature as indivisible by *unioning both file sets and dependencies across its subtasks*. A batch has no such declaration and no feature file to carry it, so nothing tells the lead which of the five may run together. It must work that out from the plans themselves before dispatching, or it will hand two seats plans that edit the same file.

**The cap of five exists for two reasons, and both matter.** It bounds the length of the conflict analysis the lead has to do unaided, *and* it limits how much the lead holds in context at once. Five plan files plus a conflict pass plus its own dispatch bookkeeping is already a lot for one seat; ten is a lead that reads everything and retains none of it.

**And the routing inputs are already on the loose plans.** `_withRecommendedRole` (`LocalApiServer.ts:5815-5820`) stamps `recommendedRole` on plan rows from *each row's own complexity*, not from feature membership — *"Resolved by the board… never by an agent reading the plan file's `Recommendation:` line"* — with a documented fallback when complexity is unknown: *"the head prompt's documented fallback ('dispatch to a coder and say why') covers absence, and a guessed role would be worse than none."*

So the lead can already route five loose plans correctly. It is simply being told to do the wrong thing with them.

### Root Cause

Batch dispatch chooses its prompt by plan *count*, not by what the recipient is. One plan gets the single-plan prompt, several get the batch prompt, and a team head — whose job is to distribute rather than execute — has no branch of its own even though the prompt it needs already exists behind two flags (`featureMode` + `driveMode`) that need a batch-specific directive to avoid asserting a false cohesion and referencing a non-existent feature file.

## Metadata

**Complexity:** 5
**Tags:** bugfix, backend

## User Review Required

Yes — this plan corrects the original approach's central mechanism (featureMode-alone → featureMode + driveMode + batch directive). The original Settled Design is preserved under Superseded callouts; the user should confirm the corrected approach before dispatch.

## Settled Design

- **No feature is created.** No row, no subtask links, no entry in the features list.
- **`featureMode` AND `driveMode` are set on the dispatch** when the batch target is a team head, with `subtaskCount` = the number of plans sent. `featureMode` suppresses `BATCH_EXECUTION_RULES` and the subagent block; `driveMode` switches the intro, the authorization, and the directive to the dispatch-to-seats framing.

> **Superseded:** `featureMode` is set on the dispatch when the batch target is a team head, with `subtaskCount` = the number of plans sent.
> **Reason:** `featureMode` alone produces "execute the feature… begin implementation immediately" (the default directive branch, `:1400-1405`) — still "do it yourself," not "allocate." The allocate framing is the `driveMode` branch (`:1391-1398`), which the original Settled Design never set. The plan's own test expected the driveMode-gated authorization (`:1804`) that the design never produced.
> **Replaced with:** Set both `featureMode` and `driveMode`. `featureMode` owns the suppressions; `driveMode` owns the dispatch framing. A `batchMode` parameter on `resolveFeatureOrchestrationDirective` selects a batch directive branch that replaces the feature-file-read instruction and the unit clause.

- **A batch directive branch in `resolveFeatureOrchestrationDirective`.** The feature clause asserts a single delivery unit and reads a feature file; the batch clause says the opposite — these plans are independent and may be unrelated — requires a conflict pass before anything runs in parallel, and tells the lead to read the individual plan files (not a feature file that does not exist).
- **The topic label is generic.** "Batch send", or equivalent. No synthesised theme.
- **Cap of five plans**, for two reasons: bounding the lead's conflict analysis and bounding its context. A larger selection sends five; the remainder are left where they are and the user is told which went and which did not.
- **`BATCH_EXECUTION_RULES` disappears by consequence**, not by a second edit — `:1794` already drops it under `featureMode`.

## Complexity Audit

### Routine

- Detecting that a batch move's resolved target is a team head (caller resolves team-ness via `resolveTeamMembers`, passes as an override to `generateUnifiedPrompt`).
- Passing `featureMode`, `driveMode`, a topic label and `subtaskCount` on that path.
- Capping the sent set at five.
- Disclosing the cap in the control label before the click.

### Complex / Risky

- **The gate must be "team head", and the codebase already warns why.** The comment at `:1798-1802` explains that `driveMode` is gated on `featureMode` *"anyway"* because `buildKanbanBatchPrompt` is exported and called outside the board path, and *"an unpaired flag would otherwise tell a plain single-plan coder to dispatch subtasks to seats it has none of."* Setting `featureMode` + `driveMode` on a batch to a standalone seat reproduces exactly that. The gate is the whole safety property of this change. `generateUnifiedPrompt` receives `role` (a string), not team-ness — the caller must resolve team-ness (via `resolveTeamMembers`) and pass it as an override. Gate on a coding-role team head, not on "the target belongs to a team".
- **`featureMode` also redirects the planner's workflow file.** `:1808`: `isFeatureTarget = options?.featureMode === true || plans.some(p => p.isFeature)` selects `plannerFeatureWorkflowPath || DEFAULT_FEATURE_PLANNER_WORKFLOW`. So the flag must not leak onto planner batches, or a batch plan-review silently switches which workflow the planner follows. Gate on a coding-role team head, not on "the target belongs to a team".
- **The `driveMode` directive assumes a feature file — a batch has none.** The `driveMode` branch (`:1396`) says *"Read the feature file's Team Dispatch Instructions section… do not read individual plan files."* A batch has no feature file, and the lead *must* read the individual plans to do the conflict pass. A batch directive branch must drop the feature-file-read instruction and tell the lead to read the plans. Without this, setting `driveMode` sends the lead to read a document that does not exist and forbids it from reading the five plans it must read.
- **The unit clause must be replaced, not just the label.** Making the topic generic stops the *name* lying, but `:1374-1376` still says *"do not treat them as independent tickets"* — the substantive false claim. A batch clause has to state the opposite and add what a feature file would otherwise have supplied: check the plans for file overlap and declared dependencies, sequence the ones that collide, parallelise the rest. Without that the lead either serialises everything (losing the point) or dispatches conflicting plans concurrently.
- **The cap is not freely raisable, and it is load-bearing twice over.** It bounds the conflict pass the lead does unaided, with no dependency map and no feature file — and it bounds the lead's context, which carries five plan files, the conflict analysis and its own dispatch bookkeeping simultaneously. Raising it degrades both at once, and both fail silently: a missed overlap looks like ordinary work until two seats fight over a file, and a context-saturated lead misroutes without reporting that it was overloaded.
- **The cap must be disclosed before the click, not reported after it.** `Move All` onto a team with twelve cards sends five and leaves seven, and a user who learns that from a toast has already been surprised. The count belongs in the control itself — a label reading *"SEND 5 OF 12"* is honest at the moment of decision, where *"sent 5, skipped 7"* afterwards is an explanation for something already done. The precedent is the planner fan-out control, whose whole point is *"no visible toggle, no label saying what will happen"* being the defect it fixes; repeating that omission here recreates it. Post-action reporting is still needed, but it is the second line of defence, not the first.
- **Which five must be deterministic — and the sort already exists.**

> **Superseded:** Which five must be deterministic — and oldest-first is wrong wherever the user has expressed an order. People reorder a board to prioritise, and a cap that ignores that sends the five they least wanted. But manual ordering exists in exactly one place: `queue_position`, written by `reorderQueue` (`KanbanProvider.ts:8263`), which is *"the webview drop handler's same-column STAGING reorder"* and is gated on `effectiveTargetColumn === 'STAGING'` (`kanban.html:9408`). No other column persists a hand-set order. So the rule splits: Source is STAGING → sort by `queue_position`. Source is any other column → oldest-first, as the only defensible default.
> **Reason:** V63 shipped `column_order` for every non-STAGING column — fully wired: `reorderColumn` (`KanbanProvider.ts:8604`), `compareByPrecedence` (`kanbanOrdering.ts:69`), DB schema + migration (`KanbanDatabase.ts:613-628`), webview drop handler (`kanban.html:10067-10125`). The claim that "no other column persists a hand-set order" is false. A user who drags cards in CREATED or PLAN REVIEWED to prioritise HAS their intent stored as `column_order`, and oldest-first overrides it. Furthermore, `_distributePlannerDispatch` — cited as having an "oldest-first sort" to avoid copying — already uses `compareByPrecedence` (`KanbanProvider.ts:7060`), not oldest-first; the V63 comment at `:7050` documents the replacement of the former lastActivity ASC sort.
> **Replaced with:** Use `compareByPrecedence(plans, sourceColumn)` from `kanbanOrdering.ts` — the shared V63 comparator that handles `queue_position` (STAGING), `column_order` (every other column), starred-first, and the `column_entered_at` DESC → `createdAt` DESC fallback uniformly. This is the same comparator `_distributePlannerDispatch` already uses (`:7060`), so the batch cap and the planner fan-out select the same five for the same column. One function, both columns, already tested.

- **Outside STAGING there is no order to respect, which is a gap rather than a sorting bug.**

> **Superseded:** Outside STAGING there is no order to respect, which is a gap rather than a sorting bug. A user who drags cards in CREATED or PLAN REVIEWED to prioritise is not being overridden — their intent was never stored. Two honest resolutions: extend persisted ordering beyond STAGING, or accept that staging *is* how priority is expressed and say so.
> **Reason:** V63 already extended persisted ordering beyond STAGING via `column_order`. The gap described here no longer exists — `reorderColumn` stores manual order in every non-STAGING column, and `compareByPrecedence` reads it. The "two honest resolutions" are moot; the first (extend persisted ordering) already shipped.
> **Replaced with:** No gap. `compareByPrecedence` respects `column_order` in every non-STAGING column and `queue_position` in STAGING. The cap sort uses it directly.

- **This cap belongs on the manual dispatch path, never on a schedule rule — and there is a test that will catch getting it wrong.** The autoban panel's `MAX BATCH SIZE` (`the-automation-model-four-things-not-a-mode-axis.md:9`) is being retired with that panel, and that plan does not carry it forward: a schedule is *"a small recurring rule — time window, source column, selector, target column. No agent, no role, no batch size"*, and it warns that *"the moment a rule needs a role, a batch size or a complexity band, it has become the thing being deleted. Resist that in the schema, not in the UI"*. It even ships a tripwire — a schema test asserting the rule admits *"no role, batch size or complexity field"*, *"because the regrowth would arrive as a new field"*.

  So there is no competing control to align with, which frees the naming. But a coder who implements this cap as configuration will reach for the schedule schema and trip that test, correctly, without understanding why. The cap is a property of a manual batch move — the number of plans one lead is handed by a human click — and it has nothing to do with automated sweeps. Keep it out of the schedule schema entirely.
- **`subtaskCount` is used in the directive's wording**, so it must be the number actually sent (five), not the number selected (twelve), or the lead is told to expect work it never receives.

## Edge-Case & Dependency Audit

**Migration.** None. No stored state, no schema, no card structure. Only the composed prompt text changes on one path.

**Security.** Neutral — a different prompt through the same dispatch path.

**Side effects.** A team receiving an allocate-style batch will fan the work across its seats rather than working it serially, which is the intent. Nothing changes for standalone seats or for the planner fan-out.

**Ordering.** Independent and shippable alone.

## Dependencies

- **Constrained by** `the-automation-model-four-things-not-a-mode-axis.md`: the retired `MAX BATCH SIZE` is deliberately not carried forward, so this cap must live on the manual dispatch path and never enter the schedule rule schema.
- **Sibling of** `feature_plan_20260820220404_created-column-batch-move-planner-fanout-toggle.md` — the same surface for the planner role, which fans out across a flat pool rather than handing a set to a head. Worth aligning the wording of the two controls, but neither blocks the other.
- Independent of the completion-signal, review-team and worktree work.

## Adversarial Synthesis

Key risks: (1) `featureMode` alone produces "execute yourself," not "allocate" — the dispatch-to-seats framing requires `driveMode`, which the original plan never set; (2) the `driveMode` directive assumes a feature file that a batch does not have, so a batch directive branch is required; (3) the original sorting rule was built on a false premise (V63 `column_order` already persists manual order in every non-STAGING column). Mitigations: set both flags + a `batchMode` directive branch that drops the feature-file-read instruction and replaces the unit clause; use `compareByPrecedence` for the cap sort, matching `_distributePlannerDispatch`.

## Proposed Changes

1. **Branch batch dispatch on the resolved target being a coding-role team head.** The caller resolves team-ness via `resolveTeamMembers` and passes it as an override to `generateUnifiedPrompt` (which receives `role`, not team-ness). Gate on a coding-role team head (`role === 'lead'` with a confirmed team roster), not on "the target belongs to a team".
2. **Set `featureMode` AND `driveMode` on that path**, with `subtaskCount` equal to the number of plans actually sent. `featureMode` suppresses `BATCH_EXECUTION_RULES` (`:1794`) and the subagent block (`:1795`); `driveMode` switches the intro (`:448-458`), the authorization (`:1803-1804`), and the directive (`:1391-1398`) to the dispatch-to-seats framing.
3. **Use a generic topic label** — "Batch send" or equivalent, never a synthesised theme.
3a. **Add a `batchMode` parameter to `resolveFeatureOrchestrationDirective`** that selects a batch directive branch when set. The batch branch:
   - Keeps the `driveMode` dispatch framing: *"Dispatch each subtask to a seat on your team — do not implement subtasks yourself."*
   - **Drops the feature-file-read instruction** (`:1396`) — there is no feature file; the lead reads the individual plan files.
   - **Replaces the unit clause** with a batch clause: the plans are independent and possibly unrelated; check for file overlap and declared dependencies; sequence what collides and parallelise the rest.
   - Keeps the `DRIVE_COMMIT_ONCE_SENTENCE` (commit once as the team's head).
4. **Cap the sent set at five**, ordered by `compareByPrecedence(plans, sourceColumn)` from `kanbanOrdering.ts` — the shared V63 comparator that handles `queue_position` (STAGING), `column_order` (other columns), starred-first, and fallbacks. This is the same comparator `_distributePlannerDispatch` uses (`KanbanProvider.ts:7060`). Leave the remainder in place.
5. **Disclose the cap in the control before the click** — a label carrying the sent-of-selected count — and report both sets after.
6. **Change nothing on the non-team and planner paths.**

### Migration

None.

## Verification Plan

### Goal Invariants

- A team head never receives `BATCH_EXECUTION_RULES`.
- A team head's batch prompt contains the dispatch-to-seats authorization (*"begin dispatching subtasks to your team seats immediately"*), not *"begin implementation immediately"*.
- A team head's batch prompt contains the dispatch-to-seats directive (*"Dispatch each subtask to a seat on your team — do not implement subtasks yourself"*), not the default *"Work through the subtasks"*.
- A team head's batch prompt does NOT reference a feature file or "Team Dispatch Instructions" (no feature file exists for a batch).
- A non-team target's prompt is byte-identical to today's.
- No feature row is created by a batch move.
- The plan count in the prompt equals the count actually sent.

### Automated Tests

- **The team path allocates:** assert a team-head batch prompt contains the drive-mode intro (*"drive the feature… through your team seats"*), the dispatch-to-seats authorization, and the dispatch-to-seats directive — and does **not** contain `BATCH_EXECUTION_RULES` or *"begin implementation immediately"*. This is the defect, so it is the first test.
- **No feature is created:** assert no feature row, no `feature_id` on any card, and no subtask links after a team batch move. A prompt-only test would pass an implementation that quietly created one.
- **The flag does not leak to standalone seats:** assert a batch to a non-team seat still renders `BATCH_EXECUTION_RULES` and no feature framing. This is the codebase's own documented hazard — *"tell a plain single-plan coder to dispatch subtasks to seats it has none of."*
- **The flag does not leak to the planner:** assert a batch plan-review still resolves the non-feature planner workflow path, since `featureMode` would otherwise redirect it via `isFeatureTarget`.
- **No false cohesion:** assert the batch prompt does **not** contain "single delivery unit" or "do not treat them as independent tickets", and does carry the conflict-pass instruction. A test that only checks the intro passes while the directive still misdescribes the work.
- **No feature-file reference:** assert the batch prompt does **not** contain "Read the feature file" or "Team Dispatch Instructions" — the batch directive branch must drop the feature-file-read instruction that the unmodified `driveMode` directive carries.
- **The feature path keeps its unit clause:** assert a real feature dispatch still asserts a single delivery unit and the feature-file-read instruction. The batch variant must not leak back into feature mode.
- **Cap and remainder:** select twelve; assert five are sent, seven are untouched, and `subtaskCount` is five.
- **The count is visible before the click:** with twelve selected on a team target, assert the control renders the sent-of-selected count. A test that only checks the post-action report passes the exact surprise this is meant to prevent.
- **The same selection sends the same five:** run an identical twelve-plan selection twice; assert the same five go, in the same order.
- **A staged reorder is respected:** stage twelve, drag the newest to the front, batch-send; assert it is among the five. The sort uses `compareByPrecedence`, which reads `queue_position` in STAGING.
- **A non-STAGING reorder is respected:** place twelve in CREATED, drag one to the front via the V63 same-column reorder, batch-send; assert it is among the five. The sort uses `compareByPrecedence`, which reads `column_order` in non-STAGING columns. Oldest-first would have sent the five the user deprioritised.
- **Routing still comes from the board:** assert each sent plan carries `recommendedRole` from its own complexity, and that unknown complexity yields no role rather than a guess.
- **Planner fan-out unaffected:** assert the planner path still round-robins.
- **The cap is not schedule config:** assert no batch-size field is added to the schedule rule schema, so the automation plan's regrowth tripwire still passes.

### Manual Verification

- Batch six plans onto a team and confirm the lead distributes rather than working them itself, and that the sixth is reported as not sent.

## Recommendation

Complexity 5 (Mixed) — **Send to Coder**.

## Implementation Summary

- Added `batchMode?: boolean` to `PromptBuilderOptions` interface in `agentPromptBuilder.ts`.
- Added a `batchMode` branch to `resolveFeatureOrchestrationDirective` and updated `buildExecutionIntro` to emit batch drive framing ("Please drive the batch of N plans below through your team seats.").
- Suppressed `BATCH_EXECUTION_RULES`, subagent blocks, "Team Dispatch Instructions", and unit clauses ("single delivery unit") when `batchMode` is active. Replaced with conflict pass instructions for independent plans.
- Prevented `batchMode` from redirecting the planner workflow selection (`isFeatureTarget` check updated to exclude `batchMode`).
- In `KanbanProvider.ts`'s `generateUnifiedPrompt`, detected when loose plan batches target a team head and enabled `featureMode`, `driveMode`, and `batchMode` with `subtaskCount` capped at 5 plans sorted via `compareByPrecedence`.
- Added `column`, `priorityStarred`, `queuePosition`, `columnOrder`, `columnEnteredAt`, `createdAt`, `lastActivity` to `BatchPromptPlan` interface and `buildDispatchPlans` so `compareByPrecedence` sorts loose plans by precedence.
- Created contract test `src/test/batch-move-team-prompt-contract.test.js` verifying team head batch prompt, non-team batch prompt, planner workflow non-leak, and real feature unit clause retention.

## Review Findings

Files changed: `src/services/agentPromptBuilder.ts`, `src/services/KanbanProvider.ts`, `src/services/TaskViewerProvider.ts`, `src/test/batch-move-team-prompt-contract.test.js`, `package.json`, `.github/workflows/integration-tests.yml`, `protocol-catalog.json`. The team-head gate was dead on the real dispatch path — it resolved team-ness from `_getVisibleAgents` (a role→boolean *visibility* map), so `originName` always fell back to the literal role string and matched no `team_<headName>` group; team-ness now resolves off the dispatch target's terminal name via a new `KanbanProvider.isCodingTeamHead`. The cap truncated only the prompt while `handleKanbanBatchTrigger` still advanced and stamped dispatch identity on every selected card, leaving the remainder orphaned in the coding column marked in-flight; the cap now runs at the dispatch caller before any card moves, the leftovers are reverted through the `moveCardsFailed` channel and named in a post-dispatch report. Also removed the `|| overrides?.driveMode` disjunct that widened the gate to any coder/intern, blocked `batchMode` from the coder feature-file branch (which names plan #1 as the feature file and drops plans #2..N from the prompt entirely), suppressed the staggered-implementation directive's feature-file reference under `batchMode`, and wired the contract test into `package.json` + CI (it was invoked by nothing), extending it from 4 to 8 cases. Verification: `npm run compile-tests` clean, `test:contract:batch-move-team-prompt` and the 97-case prompt-builder suite pass, and catalog/parity/push-routing/standalone-parity/host-seam-parity/verb-returns/kanban-dispatch-callers are green after regenerating `protocol-catalog.json`; `mirror:check`, `test:contract:staging-column` and one case in `feature-file-subtask-link-contract` are red at clean HEAD too (verified in a detached worktree) and are unrelated to this work.

## Deferred Findings

- MAJOR — The cap is still disclosed only AFTER the click; the plan's first line of defence (a control label carrying the sent-of-selected count) is not implemented. `Move All` is an icon-only button and the board state carries no team-headness for the drop target, so the label needs new board-state plumbing the plan did not scope. `src/webview/kanban.html:8121`
- MAJOR — A batch lead is told to dispatch to seats but is handed none of the means. `_buildFeatureDirectivePrefix` is gated on `plans.some(p => p.isFeature)`, so the batch path gets no YOUR TEAM roster, no API port, no `ptySendPrompt` recipe and no per-subtask completion POST. The existing drive prefix cannot be reused verbatim — it is feature-file-centric and forbids opening individual plans, which a batch lead must do. `src/services/KanbanProvider.ts:6394`
- MAJOR — The standalone host never gets this feature. Its `triggerAction` builds prompts with `buildPromptForCards`, not `generateUnifiedPrompt`, so no batch framing, no gate, no cap. Pre-existing whole-stack divergence, not introduced by this plan, but it means the plan shipped extension-only. `src/standalone/bootstrap.ts:2136`
- MAJOR — 8 of the plan's 15 named automated tests are still absent: no feature-row assertion after a team batch move, no end-to-end cap/remainder through `handleKanbanBatchTrigger`, no pre-click count assertion, no `recommendedRole` routing assertion, no planner fan-out regression, and no schedule-schema regrowth tripwire assertion. `src/test/batch-move-team-prompt-contract.test.js:1`
- NIT — `isCodingTeamHead` inherits `resolveTeamMembersForHead`'s fallback arm ("first group in stored order that contains the origin"), so a lead terminal that is a *member* of another team resolves as a head. Matches the established reviewer-delegation precedent (`TaskViewerProvider.ts:7590`) rather than inventing a stricter resolver. `src/services/KanbanProvider.ts:5965`
- NIT — `selectTeamBatchPlans` derives its sort column from `plans[0].column`, so a selection spanning two columns is ordered entirely by the first plan's column semantics (queue_position vs column_order). Same shortcut `_distributePlannerDispatch` takes. `src/services/KanbanProvider.ts:5987`
- NIT — `BatchPromptPlan.lastActivity` is populated as `(rec as any).lastActivity || rec.updatedAt`; `KanbanPlanRecord` has no `lastActivity`, so it is always `updatedAt`. Harmless (it is only a fallback inside `compareByPrecedence`) but the cast advertises a field that does not exist. `src/services/KanbanProvider.ts:4724`
