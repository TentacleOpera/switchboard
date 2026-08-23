# Batch moves to a team send the feature implementation prompt

## Goal

When a batch move targets a team head, send the prompt that tells the lead to **allocate** the plans across its seats instead of the prompt that tells the recipient to work them itself. No feature row is created — only the prompt changes.

### Problem Analysis

**The batch prompt instructs the recipient to do the work.** `BATCH_EXECUTION_RULES` (`agentPromptBuilder.ts:833-836`): *"Treat each plan file path below as a completely isolated context… Execute each plan fully before moving to the next (if sequential)."* Correct for a lone coder. Sent to a team lead it directly contradicts the lead's own standing order, which says the lead distributes: *"Your coders work the subtasks of one feature. Each subtask carries a recommendedRole; dispatch it to a seat of that role on your team"* (`teamWiring.ts:784-789`).

So a batch onto a team either serialises N plans behind the lead's own hands or forces it to disregard its dispatch instructions. Either way the team's other seats stay idle, which defeats the reason the user started a team.

**The prompt that does the right thing already exists, as a flag.** `featureMode` is exactly this reframe, and its own field doc says so — `driveMode` is documented as *"reframe execution-coded blocks from 'implement yourself' to 'dispatch to team seats.'"* Setting `featureMode` does four things with no new code:

1. **Switches the intro**: `buildExecutionIntro` (`:441-445`) returns *"Please {verb} the feature described below"*, or *"Please drive the feature described below through your team seats"* under `driveMode`, instead of *"Please {verb} the N plans below"*.
2. **Suppresses `BATCH_EXECUTION_RULES` automatically** — `:1718`: `const effectiveBatchExecutionRules = (options?.featureMode === true) ? '' : batchExecutionRules;`
3. **Suppresses the subagent block** — `:1719`, on the same condition.
4. **Injects the orchestration directive** via `resolveFeatureOrchestrationDirective(featureTopic, subtaskCount, …)`.

And under `driveMode` the authorization line changes to *"begin dispatching subtasks to your team seats immediately"* rather than *"begin implementation immediately"*.

**Its inputs do not require a feature to exist.** `featureMode` reads only `featureTopic`, `featureTopics` and `subtaskCount` — a label and a count, both derivable from the selection. Nothing in the flag needs a feature row, a `feature_id`, or subtask links.

**But the directive asserts a cohesion a batch does not have, and that is the one thing `featureMode` gets wrong.** `resolveFeatureOrchestrationDirective` (`:1327-1329`) emits a unit clause:

> *"All subtasks are part of a single delivery unit — do not treat them as independent tickets."*

and, with several topics, *"The subtasks of each feature are a single delivery unit — do not treat them as independent tickets, and do not interleave work across features."*

For a batch that is precisely backwards. The plans may be completely unrelated — that is the normal case for an ad-hoc selection — and telling the lead not to treat them as independent tickets misdescribes the work. So `featureMode` supplies the reframe that is wanted (allocate, not execute) bundled with an assertion that is false.

**And what a batch actually lacks is the dependency advice a feature carries.** A feature's subtasks declare their dependencies in their own plan files — which is why `dispatch-analysis` can treat a feature as indivisible by *unioning both file sets and dependencies across its subtasks*. A batch has no such declaration and no feature file to carry it, so nothing tells the lead which of the five may run together. It must work that out from the plans themselves before dispatching, or it will hand two seats plans that edit the same file.

**The cap of five exists for two reasons, and both matter.** It bounds the length of the conflict analysis the lead has to do unaided, *and* it limits how much the lead holds in context at once. Five plan files plus a conflict pass plus its own dispatch bookkeeping is already a lot for one seat; ten is a lead that reads everything and retains none of it.

**And the routing inputs are already on the loose plans.** `_withRecommendedRole` (`LocalApiServer.ts:4796-4809`) stamps `recommendedRole` on plan rows from *each row's own complexity*, not from feature membership — *"Resolved by the board… never by an agent reading the plan file's `Recommendation:` line"* — with a documented fallback when complexity is unknown: *"the head prompt's documented fallback ('dispatch to a coder and say why') covers absence, and a guessed role would be worse than none."*

So the lead can already route five loose plans correctly. It is simply being told to do the wrong thing with them.

### Root Cause

Batch dispatch chooses its prompt by plan *count*, not by what the recipient is. One plan gets the single-plan prompt, several get the batch prompt, and a team head — whose job is to distribute rather than execute — has no branch of its own even though the prompt it needs already exists behind a flag.

## Metadata

**Complexity:** 3
**Tags:** bugfix, agents, backend

## Settled Design

- **No feature is created.** No row, no subtask links, no entry in the features list.
- **`featureMode` is set on the dispatch** when the batch target is a team head, with `subtaskCount` = the number of plans sent.
- **A batch variant of the unit clause.** The feature clause asserts a single delivery unit; the batch clause says the opposite — these plans are independent and may be unrelated — and requires a conflict pass before anything runs in parallel.
- **The topic label is generic.** "Batch send", or equivalent. No synthesised theme.
- **Cap of five plans**, for two reasons: bounding the lead's conflict analysis and bounding its context. A larger selection sends five; the remainder are left where they are and the user is told which went and which did not.
- **`BATCH_EXECUTION_RULES` disappears by consequence**, not by a second edit — `:1718` already drops it under `featureMode`.

## Complexity Audit

### Routine

- Detecting that a batch move's resolved target is a team head.
- Passing `featureMode`, a topic label and `subtaskCount` on that path.
- Capping the sent set at five.

### Complex / Risky

- **The gate must be "team head", and the codebase already warns why.** The comment at `:1721-1726` explains that `driveMode` is gated on `featureMode` *"anyway"* because `buildKanbanBatchPrompt` is exported and called outside the board path, and *"an unpaired flag would otherwise tell a plain single-plan coder to dispatch subtasks to seats it has none of."* Setting `featureMode` on a batch to a standalone seat reproduces exactly that. The gate is the whole safety property of this change.
- **`featureMode` also redirects the planner's workflow file.** `:1731-1734`: `isFeatureTarget = options?.featureMode === true || plans.some(p => p.isFeature)` selects `plannerFeatureWorkflowPath || DEFAULT_FEATURE_PLANNER_WORKFLOW`. So the flag must not leak onto planner batches, or a batch plan-review silently switches which workflow the planner follows. Gate on a coding-role team head, not on "the target belongs to a team".
- **The unit clause must be replaced, not just the label.** Making the topic generic stops the *name* lying, but `:1327-1329` still says *"do not treat them as independent tickets"* — the substantive false claim. A batch clause has to state the opposite and add what a feature file would otherwise have supplied: check the plans for file overlap and declared dependencies, sequence the ones that collide, parallelise the rest. Without that the lead either serialises everything (losing the point) or dispatches conflicting plans concurrently.
- **The cap is not freely raisable, and it is load-bearing twice over.** It bounds the conflict pass the lead does unaided, with no dependency map and no feature file — and it bounds the lead's context, which carries five plan files, the conflict analysis and its own dispatch bookkeeping simultaneously. Raising it degrades both at once, and both fail silently: a missed overlap looks like ordinary work until two seats fight over a file, and a context-saturated lead misroutes without reporting that it was overloaded.
- **The remainder above the cap must be visibly not-sent.** Moving five and silently leaving seven looks like a partial failure. Whatever the surface reports, it has to name both sets — this is the only user-facing behaviour in the change.
- **`subtaskCount` is used in the directive's wording**, so it must be the number actually sent (five), not the number selected (twelve), or the lead is told to expect work it never receives.

## Edge-Case & Dependency Audit

**Migration.** None. No stored state, no schema, no card structure. Only the composed prompt text changes on one path.

**Security.** Neutral — a different prompt through the same dispatch path.

**Side effects.** A team receiving an allocate-style batch will fan the work across its seats rather than working it serially, which is the intent. Nothing changes for standalone seats or for the planner fan-out.

**Ordering.** Independent and shippable alone.

## Dependencies

- **Sibling of** `feature_plan_20260820220404_created-column-batch-move-planner-fanout-toggle.md` — the same surface for the planner role, which fans out across a flat pool rather than handing a set to a head. Worth aligning the wording of the two controls, but neither blocks the other.
- Independent of the completion-signal, review-team and worktree work.

## Adversarial Synthesis

**"Create a real feature — it gets cascade moves, derived complexity and a worktree."** Those are properties of grouped work, and this is not grouped work: it is an ad-hoc selection a user made once. Creating a feature row for it puts a permanent grouping in the features list, and — because `dispatch-analysis` treats a feature as indivisible, unioning file sets *and* dependencies across its subtasks — it would turn five unrelated plans into one large conflict set that may never stage. The prompt was the only thing wrong; a feature row fixes the prompt and breaks staging.

**"Just remove `BATCH_EXECUTION_RULES` for team targets."** That gets halfway: the lead stops being told to execute, but is not told to allocate, and loses the orchestration directive. `featureMode` is the existing, tested composition of all of it — subtracting one block by hand reimplements part of a flag that already exists.

**"Use `featureMode` unchanged — the directive is close enough."** It is not: it tells the lead the plans are one delivery unit and not independent tickets, which for an ad-hoc selection is false, and it supplies no substitute for the dependency advice a feature file carries. Close enough here means the lead is confidently misinformed about both cohesion and conflicts.

**"Round-robin the plans across the team's seats from the board instead."** That bypasses the head, which is the only thing on a team that knows which seat suits which plan, and leaves seats holding work the lead never dispatched and cannot report on.

**"Five is arbitrary."** It is a deliberate cap on how much one lead is asked to hold at once. What matters is that the overflow is reported rather than dropped silently.

## Proposed Changes

1. **Branch batch dispatch on the resolved target being a coding-role team head.**
2. **Set `featureMode` on that path**, with `subtaskCount` equal to the number of plans actually sent.
3. **Use a generic topic label** — "Batch send" or equivalent, never a synthesised theme.
3a. **Add a batch variant of the unit clause**: the plans are independent and possibly unrelated; check for file overlap and declared dependencies; sequence what collides and parallelise the rest.
4. **Cap the sent set at five**, leaving the remainder in place.
5. **Report both sets** — sent and not sent — to the user.
6. **Change nothing on the non-team and planner paths.**

### Migration

None.

## Verification Plan

### Goal Invariants

- A team head never receives `BATCH_EXECUTION_RULES`.
- A non-team target's prompt is byte-identical to today's.
- No feature row is created by a batch move.
- The plan count in the prompt equals the count actually sent.

### Automated Tests

- **The team path allocates:** assert a team-head batch prompt contains the feature intro and the dispatch-to-seats authorization, and does **not** contain `BATCH_EXECUTION_RULES`. This is the defect, so it is the first test.
- **No feature is created:** assert no feature row, no `feature_id` on any card, and no subtask links after a team batch move. A prompt-only test would pass an implementation that quietly created one.
- **The flag does not leak to standalone seats:** assert a batch to a non-team seat still renders `BATCH_EXECUTION_RULES` and no feature framing. This is the codebase's own documented hazard — *"tell a plain single-plan coder to dispatch subtasks to seats it has none of."*
- **The flag does not leak to the planner:** assert a batch plan-review still resolves the non-feature planner workflow path, since `featureMode` would otherwise redirect it via `isFeatureTarget`.
- **No false cohesion:** assert the batch prompt does **not** contain "single delivery unit" or "do not treat them as independent tickets", and does carry the conflict-pass instruction. A test that only checks the intro passes while the directive still misdescribes the work.
- **The feature path keeps its unit clause:** assert a real feature dispatch still asserts a single delivery unit. The batch variant must not leak back into feature mode.
- **Cap and remainder:** select twelve; assert five are sent, seven are untouched, `subtaskCount` is five, and both sets are named in what the user sees.
- **Routing still comes from the board:** assert each sent plan carries `recommendedRole` from its own complexity, and that unknown complexity yields no role rather than a guess.
- **Planner fan-out unaffected:** assert the planner path still round-robins.

### Manual Verification

- Batch six plans onto a team and confirm the lead distributes rather than working them itself, and that the sixth is reported as not sent.

## Outstanding Questions

None.
