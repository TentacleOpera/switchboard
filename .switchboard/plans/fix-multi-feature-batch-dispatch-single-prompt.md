---
description: "BUG: batch-advancing multiple feature cards moves them all but the generated prompt contains only the FIRST feature — the others advance silently unworked. Root cause: single-feature resolution (plans.find) + scalar featureTopic/featurePlanId options + singular feature directive. Fix: partition the batch by feature at the dispatch boundary and emit one prompt per feature group."
---

# Fix: Multi-Feature Batch Dispatch Builds a Prompt for Only One Feature

## Goal

Make batch dispatch honest for multi-feature selections: when several feature cards are advanced together, **every** advanced feature must be covered by a dispatched (or copied) prompt — or not advance at all. Today all selected features move columns, but the prompt describes only one of them, so the rest advance silently unworked and must be dragged back by hand.

### Problem / root cause analysis

**Symptom:** select two or more feature cards, advance/dispatch them together → all cards move to the target column, but the generated prompt (CLI dispatch or Copy Prompt) contains only ONE feature's directive and subtasks. The other features look "in progress" on the board but no agent was ever told about them.

**Root cause (verified in source):**

1. **Single-feature resolution at the dispatch boundary** — `KanbanProvider.ts` ≈4546–4575 (`generateUnifiedPrompt` path):
   ```ts
   const hasSubtasks = plans.some(p => p.isSubtask);
   if (hasSubtasks) {
       const featurePlan = plans.find(p => !p.isSubtask);   // ← FIRST non-subtask wins
       resolvedOptions.featureMode = true;
       resolvedOptions.featureTopic = featurePlan?.topic;    // scalar
       ...
       resolvedOptions.featurePlanId = featurePlan?.sessionId; // scalar
   ```
   With plans = [featureA, A-subtasks…, featureB, B-subtasks…], `find()` returns featureA. `featureTopic`, `featurePlanId`, and `featureWorktreeMode` all bind to featureA only — while `subtaskCount` (line 4549, `subtaskPlans = plans.filter(p => p.isSubtask)`) counts **both** features' subtasks, so the one emitted directive is also numerically wrong.
2. **Scalar options all the way down** — `agentPromptBuilder.ts`: the feature directive block (line 973, `if (options?.featureMode && options?.featureTopic)`) keys off a single `options.featureTopic`; `buildExecutionIntro` (line 350) says "Please implement the feature described below" (singular); the coder role's §10 pre-dispatch regeneration (`KanbanProvider.ts` line 4581) regenerates **one** feature file (`resolvedOptions.featurePlanId`) — the file the prompt references. There is no representation for a second feature anywhere in the options shape.
3. **Move and prompt are decoupled** — the column persist applies to the whole selection before/independently of prompt generation, so the unrepresented features still advance. That decoupling is intentional (persist-before-dispatch, `TaskViewerProvider.ts` lines 4651–4673); the bug is that prompt generation drops members of the selection.

**Shape of the fix — per-feature segments, stacked:** the prompt-builder machinery stays single-feature (its options shape is scalar and correct for one feature). The fix partitions the selection by feature, renders each feature's directive+subtasks **with the existing machinery**, and concatenates the segments into one payload with `=== FEATURE 1 of N ===` headers — the same one-payload semantics as a batch plan send. This is NOT a merged multi-feature directive; each segment is exactly the prompt that feature would have gotten alone. The only case that can't be one payload is per-feature worktree mode with divergent terminal routing — one send cannot reach two terminals — where the segments are sent separately to their own terminals.

## Metadata
- **Tags:** bugfix, backend, api
- **Complexity:** 6

## User Review Required
- None — **DECIDED (user-confirmed 2026-07-16): CONCATENATE.** Multi-feature selections produce ONE prompt payload containing every feature's directive, stacked with `=== FEATURE 1 of N ===` headers — the same one-payload semantics as a batch plan send — for both Copy Prompt and CLI dispatch. The sole exception: in per-feature worktree mode, when the selected features resolve to *different* worktree terminals, one concatenated send cannot reach two terminals — dispatch one prompt per feature to its own terminal in that case only.

## Scope

### ✅ IN SCOPE
- **Partition the batch at the dispatch boundary:** group `plans` into per-feature groups (feature card + its own subtasks, matched by `featureId` — never by array order) plus one group of loose plans. Applies to the shared path used by CLI dispatch, Copy Prompt & Advance, column batch actions, and multi-select advance.
- **Per-group segment rendering:** run the existing single-feature resolution (featureTopic/featurePlanId/worktreeMode/§10 coder regeneration) per group — the currently-correct single-feature machinery is reused as-is, in a loop — producing one prompt segment per feature. Loose plans render with today's batch-prompt behavior as their own segment.
- **Concatenate into one payload (the decided default):** stack the segments with `=== FEATURE 1 of N ===` headers into a single prompt, used identically for Copy Prompt and CLI dispatch — matching the board's existing batch-plan-send semantics.
- **Worktree-routing exception only:** in per-feature worktree mode, when groups resolve to different terminals, send each feature's segment to its own terminal sequentially (a single payload cannot reach two terminals). Same-terminal or no-worktree cases stay concatenated.
- **Move/prompt consistency guard:** a feature card only advances if the payload covering it was actually dispatched/copied; on failure of a per-terminal send, the features not yet sent stay put and the error names them.
- **Correct `subtaskCount`** per group (it currently mixes all selected features' subtasks into one number).

### ⚙️ OUT OF SCOPE
- Making the prompt-builder options shape multi-feature (`featureTopics[]` etc.) — rejected above; the builder stays single-feature.
- Any change to single-feature dispatch, loose-plan batches, or the orchestrator's feature dispatch (`/kanban/orchestration/dispatch` is already one-feature-at-a-time).
- Board UI changes beyond an error/blocked toast.

## Implementation Steps
1. **Extract the partition as a pure exported function** (e.g. `partitionPlansByFeature` in `agentPromptBuilder.ts` or a new `dispatchPartition.ts` util). Signature: `(plans: BatchPromptPlan[]) => { featureGroups: { feature: BatchPromptPlan; subtasks: BatchPromptPlan[] }[]; loosePlans: BatchPromptPlan[] }`. Group by `plan.featureId` (present on every subtask per `expandFeatureSubtaskPlans`, line 3773); a subtask missing `featureId` falls into `loosePlans`. Preserve selection order for group ordering. Pure function → unit-testable without DB, matching the existing `out/services/agentPromptBuilder` test style.
2. **In `generateUnifiedPrompt` (KanbanProvider.ts ~4545–4609), replace the single-feature resolution block with a per-group loop:** for each feature group, build a **fresh copy** of `resolvedOptions` (do NOT mutate one shared object across iterations — scalar `featureTopic`/`featurePlanId`/`featureWorktreeMode`/`subtaskCount` must be isolated per group), set `featureMode=true`, `featureTopic`, `featurePlanId`, `featureWorktreeMode`, and `subtaskCount = group.subtasks.length`, then call `buildKanbanBatchPrompt(role, groupPlans, mergedOptionsForGroup)` to produce one segment. Render loose plans as their own segment with today's batch behavior (`featureMode` false).
3. **Re-run §10 regeneration per group:** the coder-role feature-file regeneration (line 4581) must execute inside the loop, once per group's `featurePlanId`, so every feature file the concatenated payload references is current. Guard: `if (role === 'coder' && groupOptions.featureMode && groupOptions.featurePlanId)`.
4. **Concatenate segments** with `=== FEATURE i of N ===` headers into a single payload string; return it from `generateUnifiedPrompt` for both Copy Prompt and CLI dispatch.
5. **Fix the feature-directive-prefix gate (line 4602–4608):** change `primaryPlan = plans[0]` + `primaryPlan.isFeature` to `plans.some(p => p.isFeature)`. The prefix (`_buildFeatureDirectivePrefix`, lines 4314–4325) is generic — a board-level `/goal`/`ultracode` toggle, NOT feature-specific — so applying it once to the final concatenated payload is correct; the gate just needs to fire when any feature is present, not only when `plans[0]` is one.
6. **In `TaskViewerProvider` batch-dispatch (lines 4644–4719), branch on terminal divergence:** resolve each feature group's target terminal. If all groups share one terminal (or worktree mode is off) → keep today's persist-all-then-send-one-payload ordering (the one payload covers every feature, so the consistency invariant holds). If targets diverge (per-feature worktree mode) → restructure to **per-group persist-then-send**: persist group's cards, send that group's segment to its terminal with the existing pacing (`/clear` + delay), then proceed to the next group. On a per-terminal send failure, stop and leave remaining groups' cards un-persisted; surface an error toast naming the unsent features.
7. **Tests:** two features + subtasks selected → one payload containing both directives, each with its own topic and subtask count; mixed selection (features + loose plans) → both feature segments plus the batch segment; per-feature-worktree divergence → two sends to two terminals; failure mid-sequence leaves unsent features unmoved; prefix present when `plans[0]` is loose but a later plan is a feature.

## Complexity Audit
### Routine
- The partition itself (pure function over an array, group by `featureId`); per-group looping of existing machinery; `subtaskCount` fix; prefix-gate fix (`plans[0].isFeature` → `plans.some(p => p.isFeature)`).
### Complex / Risky
- **Per-group `resolvedOptions` isolation:** scalar options (`featureTopic`/`featurePlanId`/`featureWorktreeMode`/`subtaskCount`) must not leak across loop iterations — a fresh copy per group is mandatory, or group 2 inherits group 1's `featurePlanId` and §10 regenerates the wrong file.
- **Segment boundaries in one payload:** each segment's directive must remain self-contained when stacked (no directive from segment 1 bleeding scope into segment 2 — verify the feature directive's wording under concatenation, and that suppressed batch rules stay suppressed per segment). The `=== FEATURE i of N ===` header is the decoupler.
- **Divergent-terminal sends + per-group persistence (TaskViewerProvider restructure):** the persist-before-dispatch invariant's granularity changes from per-batch to per-group for the divergent case only. Sequential sends to different terminals reuse the existing pacing (`/clear` + delay); verify no interleaving when two sends race. The shared-terminal case preserves today's per-batch persist-then-send unchanged.
- **Consistency guard vs persist-before-dispatch:** for the concatenated case the guard is satisfied trivially (one payload covers all → persist-all-then-send is consistent). For the divergent case the guard falls out of per-group persist-then-send (a failed send leaves that group un-persisted). No rollback path needed.

## Edge-Case & Dependency Audit
- **Race Conditions:** divergent-terminal sequential sends must not interleave — reuse the existing `/clear` + delay pacing between sends; a send to terminal B must not start until terminal A's send is dispatched. The per-group persist-then-send loop is inherently sequential, so no cross-group race.
- **Security:** no new surface — no user input parsing, no credential handling. The partition operates on already-resolved `BatchPromptPlan` objects.
- **Side Effects:** §10 feature-file regeneration now runs N times (once per feature) instead of once — each call is documented as cheap and idempotent (line 4578–4580), so N× cost is acceptable. Persist-before-dispatch granularity changes for the divergent-terminal case only; shared-terminal/single-feature/loose-plan paths are byte-identical to today.
- **Dependencies & Conflicts:**
  - **Subtask attachment:** `buildDispatchPlans` (lines 3839–3852) already expands subtasks via `expandFeatureSubtaskPlans`, pushing each into `plans` with `featureId: featurePlanId` (line 3773) and `isSubtask: true` (line 3771). The partition groups by `featureId` directly off the `plans` array — **no extra DB lookup is needed in the dispatch path**. Defensive invariant: a subtask missing `featureId` falls into `loosePlans` (do not silently drop it).
  - **Feature-directive prefix:** `_buildFeatureDirectivePrefix` (lines 4314–4325) is a board-level `/goal`/`ultracode` toggle, not feature-specific — applying it once to the concatenated payload is correct; only the gate (`plans[0].isFeature`) needs widening to `plans.some(p => p.isFeature)`.
  - **Pair-programming / ultracode / goal-mode prepends** apply per-payload, not once per batch — the concatenated payload receives the prefix once (correct); the divergent-terminal case receives it once per segment (each segment is its own prompt to its own terminal).

> **Superseded:** "Selection containing a feature card but NOT its subtasks (subtasks are normally hidden/implicit): partition must attach the feature's subtasks by featureId lookup, not rely on them being present in `plans`."
> **Reason:** In the dispatch path, `buildDispatchPlans` already calls `expandFeatureSubtaskPlans`, which pushes every subtask into `plans` carrying `featureId` and `isSubtask`. The subtasks ARE present in `plans`; no DB lookup is needed. The original note invented a DB round-trip that does not exist and mis-described the data being partitioned.
> **Replaced with:** Group by `plan.featureId` directly off the `plans` array. Defensive invariant: a subtask missing `featureId` falls into `loosePlans` rather than being silently dropped — but this is a data-hygiene guard, not a DB-lookup requirement.

## Dependencies

> **Superseded:** "None — self-contained in `KanbanProvider` dispatch path. Touches no prompt-builder templates."
> **Reason:** `generateUnifiedPrompt` returns a string — it cannot send to a terminal and does not persist a kanban column. The divergent-terminal send (Implementation Step 6) and the consistency guard both live in `TaskViewerProvider`'s batch-dispatch (lines 4644–4719), which persists all `validPlans` before any send. The fix therefore spans two files, not one. The claim that the fix is self-contained in `KanbanProvider` under-scopes the file surface and would leave the implementer to discover the TaskViewerProvider restructure at coding time.
> **Replaced with:** The fix spans `KanbanProvider.ts` (partition + per-group prompt building + §10-per-group loop + concatenation + prefix-gate fix, lines 4545–4609) and `TaskViewerProvider.ts` (divergent-terminal send + per-group persistence + consistency guard, lines 4644–4719). No prompt-builder template (`agentPromptBuilder.ts` role branches) is edited — the builder stays single-feature and is called once per group. The partition helper is a new pure exported function (Step 1).

- No `sess_…` plan dependencies — self-contained within the dispatch path.
- No prompt-builder template edits (the builder's options shape stays scalar/single-feature).

## Adversarial Synthesis

Key risks: (1) the fix is **two-file, not one** — `KanbanProvider` owns prompt partition/build/concatenate, `TaskViewerProvider` owns persist+send ordering and the consistency guard; under-scoping this leaves the guard unimplemented. (2) Per-group `resolvedOptions` isolation is mandatory — a shared mutated object leaks group 1's `featurePlanId` into group 2's §10 regeneration. (3) The persist-before-dispatch invariant's granularity changes to per-group for the divergent-terminal case only; the shared-terminal case stays byte-identical. Mitigations: extract the partition as a pure function (unit-testable, no DB), fresh `resolvedOptions` per loop iteration, branch the TaskViewerProvider persist+send loop on terminal divergence, widen the prefix gate to `plans.some(p => p.isFeature)`.

## Proposed Changes

### `src/services/agentPromptBuilder.ts` (or new `src/services/dispatchPartition.ts`)
- **Context:** The partition is the only genuinely new logic; isolating it as a pure exported function makes it unit-testable without DB or VS Code deps, matching the existing test style (`require('../../out/services/agentPromptBuilder')`).
- **Logic:** `partitionPlansByFeature(plans)` → walk `plans` in order; for each plan with `isFeature === true`, start a new feature group keyed by its `planId`; for each plan with `featureId` set, attach to the group whose feature's `planId === plan.featureId`; everything else accumulates into `loosePlans`. Return `{ featureGroups, loosePlans }` preserving selection order.
- **Implementation:** ~25 lines, no imports beyond the `BatchPromptPlan` type. Export from `agentPromptBuilder.ts` (alongside `buildKanbanBatchPrompt`) or a sibling util imported by `KanbanProvider`.
- **Edge Cases:** a subtask whose `featureId` matches no feature group in the selection (orphaned) → falls into `loosePlans`; a feature with zero subtasks → group still emitted (its segment carries the feature-file reference, not silently skipped); two features with the same `planId` (should never happen) → last-one-wins merge, logged.

### `src/services/KanbanProvider.ts` — `generateUnifiedPrompt` (lines 4545–4609)
- **Context:** This is the single prompt-building entry shared by every dispatch/copy path (verified: TaskViewerProvider line 4644, KanbanProvider lines 5129/5440/9364, etc.). The fix here covers prompt *content* for all paths.
- **Logic:** Replace the `if (hasSubtasks) { … single featurePlan … }` block (4545–4573) with: call `partitionPlansByFeature(plans)`; if `featureGroups.length <= 1` (and no loose plans mixing), keep today's fast path unchanged; otherwise loop groups, building a fresh `resolvedOptions` copy per group, setting the scalar feature fields per group, running §10 regeneration per group (coder role only), and calling `buildKanbanBatchPrompt` per group to produce a segment. Concatenate segments with `=== FEATURE i of N ===` headers. Loose plans render as one additional segment with `featureMode=false`.
- **Implementation:** ~40–60 lines replacing the 4545–4573 block plus a loop; the §10 block at 4581 moves inside the loop; the prefix gate at 4603 changes from `primaryPlan && primaryPlan.isFeature` to `plans.some(p => p.isFeature)`. The `mergedOptions` merge (4588–4591) is applied per group inside the loop.
- **Edge Cases:** single-feature selection (the common case) must hit the fast path and produce byte-identical output to today — guard with `featureGroups.length <= 1 && loosePlans.length === 0`. Mixed feature+loose selection → feature segments first (in selection order), then the loose-plans segment. A feature group whose `featurePlan` is missing (edge: feature card deleted mid-selection) → skip that group's segment and log; do not emit a directive referencing a missing file.

### `src/services/TaskViewerProvider.ts` — batch-dispatch (lines 4644–4719)
- **Context:** This is where persist-before-dispatch lives (4651–4673 persist all, 4673 sends). The consistency guard and divergent-terminal sends cannot live in `generateUnifiedPrompt` (which returns a string).
- **Logic:** After `generateUnifiedPrompt` returns the concatenated payload, resolve each feature group's target terminal. If all groups share one terminal (or worktree mode is off / no features) → unchanged: persist all `validPlans`, send the one payload. If terminals diverge → switch to per-group persist-then-send: for each group, persist that group's cards (`_updateKanbanColumnForSession` per plan), send that group's segment to its terminal (`_dispatchExecuteMessage` with the existing `/clear` + delay pacing), and on send failure stop the loop, leaving remaining groups un-persisted, and surface an error toast naming the unsent features.
- **Implementation:** ~30–50 lines restructuring the persist+send section (4650–4719) into a divergence branch. The single-terminal branch is byte-identical to today. The divergent branch reuses `_dispatchExecuteMessage` and `_updateKanbanColumnForSession` unchanged — only the loop structure is new.
- **Edge Cases:** a send failure mid-sequence must not leave already-persisted groups rolled back (they were legitimately sent); only the *unsent* groups stay put. The error toast must name the unsent features by topic so the user knows what to re-dispatch. Copy-Prompt paths have no send-failure semantics (clipboard write is atomic) — the guard is a no-op there.

## Verification Plan

> **Session directives:** SKIP COMPILATION and SKIP TESTS are active for this planning pass. The items below describe the tests to **author** during implementation; **running** them is the implementer's step, not part of this plan's verification. No project compilation or automated test execution is performed here.

### Automated Tests
- **Partitioner unit tests** (pure function, no DB — matches `src/test/agent-prompt-builder-subagents.test.js` style):
  - Two features + their subtasks → two feature groups, each with its own subtasks, selection order preserved.
  - Mixed selection (features + loose plans) → feature groups + a `loosePlans` group.
  - A subtask missing `featureId` → lands in `loosePlans`, not dropped.
  - A feature with zero subtasks → group still emitted (non-empty `feature`, empty `subtasks`).
- **Dispatch/prompt tests** (over `generateUnifiedPrompt` with a stub `KanbanProvider` or via `buildKanbanBatchPrompt` per group):
  - Two features + subtasks selected → one payload containing both directives, each with its own `featureTopic` and correct per-group `subtaskCount`; `=== FEATURE 1 of 2 ===` / `=== FEATURE 2 of 2 ===` headers present.
  - §10 regeneration called once per feature group (spy on `_regenerateFeatureFile`), each with the correct `featurePlanId`.
  - Prefix (`/goal`/`ultracode`) present when `plans[0]` is a loose plan but a later plan is a feature (validates the `plans.some(p => p.isFeature)` gate).
  - Single-feature selection → byte-identical output to today (fast-path guard).
- **TaskViewerProvider batch-dispatch tests** (divergence branch):
  - Shared terminal → persist-all-then-send-one-payload (today's behavior, unchanged).
  - Per-feature-worktree divergence → two sequential sends to two terminals, with `/clear` + delay pacing between them; no interleaving.
  - Failure injection on group 1's send → group 2's cards remain in the source column; error toast names group 2's feature topic.

### Manual / behavioral
- Board: select two features, Advance — both features' prompts arrive (one clipboard payload with both, or per-terminal sends per the decision); both features' cards advance; nothing needs dragging back.
- Repeat in per-feature worktree mode — each feature's prompt lands in its own worktree terminal.
- Repeat with a mixed selection (one feature + one loose plan) — the payload contains the feature segment and the loose-plan segment.

## Implementation Completed

Implemented the fix across three files. `src/services/agentPromptBuilder.ts` now exports `partitionPlansByFeature`, which groups selected plans by owning feature and collects loose/orphaned plans. `src/services/KanbanProvider.ts` `generateUnifiedPrompt` now builds per-feature prompt segments with fresh option copies per group, runs §10 regeneration once per feature, concatenates with `=== FEATURE i of N ===` headers, widens the `/goal`/`ultracode` prefix gate to `plans.some(p => p.isFeature)`, and falls back to the original empty-plans preamble behavior when `plans` is empty. `src/services/TaskViewerProvider.ts` `handleKanbanBatchTrigger` now partitions the batch, resolves a terminal per group, and either dispatches one concatenated prompt when all groups share a terminal or performs per-group persist-then-send when worktree terminals diverge, stopping on the first failed send. `npm run lint` passes. Compilation and automated tests were skipped per the active session directives; pre-existing uncommitted changes in the working tree were not touched.
