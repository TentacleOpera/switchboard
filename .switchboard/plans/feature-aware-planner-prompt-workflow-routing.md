# Feature-Aware Planner Prompt: Route Features to improve-feature Workflow at Prompt Generation Time

## Goal

When any kanban mechanism (column move, autoban, CLI dispatch, copy-prompt button, prompt preview) generates a planner prompt for a **feature** card, the prompt must reference `improve-feature.md` — not `improve-plan.md`. Today, all planner prompts use the configured `plannerWorkflowPath` (defaulting to `improve-plan.md`) regardless of whether the target is a feature or a single plan. The improve-plan workflow contains a guard that says "if this is a feature, stop and use improve-feature instead," but agents routinely ignore this redirect because the literal prompt instruction ("Read improve-plan.md and follow it step-by-step") takes precedence in their reasoning.

### Core Problem

The redirect guard inside `improve-plan.md` (lines 15–17) is a **workflow-level soft redirect** — it asks the agent to abandon the workflow it was told to follow and switch to another. Agents treat the explicit prompt directive ("Read X and follow it") as authoritative, so they follow improve-plan and either skip or rationalize away the redirect. This is a structural weakness: the decision to use improve-plan vs improve-feature is made at **prompt generation time** (the workflow path is baked into the prompt text), but the correction is attempted at **workflow execution time** (a guard inside the workflow). The correction needs to move upstream to where the workflow path is chosen.

### Root Cause

In `src/services/agentPromptBuilder.ts` line 869, the planner workflow path is resolved as:

```typescript
const workflowPath = options?.plannerWorkflowPath || DEFAULT_PLANNER_WORKFLOW;
```

`DEFAULT_PLANNER_WORKFLOW` is `.agents/workflows/improve-plan.md` (line 707). The `plannerWorkflowPath` option is set by `KanbanProvider.generateUnifiedPrompt()` from static config (line 4570):

```typescript
plannerWorkflowPath: plannerConfig?.workflowFilePath || config.get<string>('planner.workflowPath', '.agents/workflows/improve-plan.md'),
```

This value is set **unconditionally** — it does not check whether the dispatch target is a feature. Meanwhile, `generateUnifiedPrompt()` already detects feature mode at line 4436–4441 (`hasSubtasks = plans.some(p => p.isSubtask)` → `resolvedOptions.featureMode = true`) and the prompt builder already has feature-mode-aware logic (suppressing `batchExecutionRules`, `subagentBlock`, etc. at lines 863–864). The workflow path is the one piece that was never made feature-aware.

The resolved `workflowPath` is consumed at line 891 inside the `if (options?.workflowFilePathEnabled !== false)` gate:

```typescript
if (options?.workflowFilePathEnabled !== false) {
    plannerBase = `Read ${workflowPath} and follow it step-by-step.\n\n`;
}
```

So the feature-aware routing only affects the emitted prompt text when `workflowFilePathEnabled` is not explicitly `false` for the planner role. When a user has disabled workflow-file-path injection, `plannerBase` stays empty and no "Read X" line is emitted for *any* target — feature or plan. The fix remains correct and consistent in that case (it simply has no observable effect); this interaction is documented below rather than treated as a defect.

## Metadata

- **Plan ID:** 31cb1d59-45f7-40ca-9e39-c85788b25053
- **Complexity:** 4
- **Tags:** backend, bugfix, feature, refactor

## User Review Required

**No.** The change is a self-contained, single-resolution-point behavioral fix with no data migration, no schema change, no breaking API contract, and no security surface. The one product-level judgment call — that feature mode always overrides a custom `plannerWorkflowPath` — is already user-approved (see design decision in Proposed Changes §1) and documented as a known limitation. Safe to dispatch to a coder without further review.

## Complexity Audit

### Routine
- Adding one module-level constant (`DEFAULT_FEATURE_PLANNER_WORKFLOW`) near line 707.
- Replacing one workflow-path resolution expression at line 869 with an `isFeatureTarget ? feature : plan` ternary — reuses the existing `featureMode`/`isFeature` options already threaded through the builder.
- Authoring four unit tests in `agentPromptBuilder.test.ts` following the established `buildKanbanBatchPrompt(role, plans, options)` + `assert.ok(prompt.includes(...))` pattern.
- Keeping the `improve-plan.md` guard unchanged as a fallback (no edit).

### Complex / Risky
- **Test-helper scoping trap:** the existing `makeFeaturePlans()` helper is block-scoped inside the `§9 regression — lean dispatch prompts` suite (line 250). The new feature-routing suite cannot reference it without a `ReferenceError` at collection time. The helper must be hoisted to the outer `suite('agentPromptBuilder')` scope (or redefined locally in the new suite). This is a real mechanical defect in the original test plan and must be handled or three of the four tests will not compile.
- **`workflowFilePathEnabled` interaction:** the fix is a no-op when workflow-file-path injection is disabled for the planner role. The side-effects claim must be qualified accordingly and a regression test added for that corner.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. The workflow path is resolved synchronously during prompt building; no concurrent state is involved.
- **Security:** No security implications.
- **Side Effects:** The only behavioral change is which workflow file path appears in the generated planner prompt text for features — **and only when `workflowFilePathEnabled` is not `false` for the planner role** (the gate at line 890 that wraps the `Read ${workflowPath} ...` emission). When workflow-file-path injection is disabled, no "Read X" line is emitted for any target and the routing change has no observable effect. All other prompt content (feature directives, plan list, git policy, etc.) is unchanged.
- **Dependencies & Conflicts:** None. This is a self-contained change to one resolution point. The dual feature-detection signals (prompt-time `isFeature` DB flag vs. the retained `improve-plan.md` guard's file-location/`<!-- BEGIN SUBTASKS -->` check) are intentionally coupled via `createFeature`'s invariant that feature files always live under `.switchboard/features/`. A future contributor who severs that file-placement invariant must update both mechanisms in lockstep, or the primary routing and the fallback guard will disagree on what counts as a feature.

## Dependencies

None.

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) the test plan referenced a suite-scoped `makeFeaturePlans()` helper that would throw `ReferenceError` — must hoist it; (2) the "only behavioral change" claim ignored the `workflowFilePathEnabled !== false` gate, making the fix a silent no-op in that config — qualified and a regression test added; (3) the always-override design removes the user's escape hatch for a custom feature-aware workflow — documented as a known limitation, not hidden. Mitigations: hoist the helper, add the disabled-workflow-file-path test, document the no-escape-hatch and the dual-signal coupling. Complexity bumped 3 → 4; route to Coder.

## Proposed Changes

### 1. `src/services/agentPromptBuilder.ts` — Feature-aware workflow path resolution

**Add a constant** near line 707:

```typescript
const DEFAULT_FEATURE_PLANNER_WORKFLOW = '.agents/workflows/improve-feature.md';
```

**Change the workflow path resolution** at line 869 from:

```typescript
const workflowPath = options?.plannerWorkflowPath || DEFAULT_PLANNER_WORKFLOW;
```

to:

```typescript
const isFeatureTarget = options?.featureMode === true || plans.some(p => p.isFeature);
const workflowPath = isFeatureTarget
    ? DEFAULT_FEATURE_PLANNER_WORKFLOW
    : (options?.plannerWorkflowPath || DEFAULT_PLANNER_WORKFLOW);
```

**Design decision (user-approved):** Feature mode **always** overrides to `improve-feature.md`, even if the user has configured a custom `plannerWorkflowPath`. Rationale: a custom plan workflow is likely also wrong for features; the feature/plan distinction is structural, not a preference.

**Known limitation (no escape hatch):** Because the override is unconditional and silent, a user who legitimately maintains a custom feature-aware workflow (a fork of `improve-feature.md`, an org-specific variant) has their `plannerWorkflowPath` config silently ignored for feature dispatches, with no log, warning, or telemetry signal. This is an accepted tradeoff of the user-approved design. If a per-role `featureWorkflowPath` config override is desired later, it should be added as a follow-up — **do not** hack it into this change.

**Edge case — feature with zero subtasks:** `featureMode` is set by `generateUnifiedPrompt` only when `plans.some(p => p.isSubtask)` is true. A feature with zero subtasks would have `featureMode === false` but `plans[0].isFeature === true`. The `plans.some(p => p.isFeature)` check in the new code covers this case — the feature card itself carries `isFeature: true` from `buildDispatchPlans` (line 3741). Verified: for a zero-subtask feature, `buildDispatchPlans` pushes only the primary feature card with `isFeature: true` (subtask expansion at line 3747 adds nothing), so `plans === [{ isFeature: true, ... }]`, `hasSubtasks === false`, but `plans.some(p => p.isFeature) === true`.

**`workflowFilePathEnabled` interaction:** The resolved `workflowPath` is only emitted into the prompt at line 891 inside `if (options?.workflowFilePathEnabled !== false)`. When a user disables workflow-file-path injection for the planner role (`promptsConfig.workflowFilePathEnabledByRole?.planner === false`, resolved at `KanbanProvider.ts` line 4392), `plannerBase` stays empty and no "Read X" line is produced for any target. The feature-aware routing remains correct (it changes `workflowPath`, which is simply never read) and consistent with existing non-feature behavior in that config. No special handling is required.

**Provenance note:** Both halves of the `isFeatureTarget` OR (`options.featureMode` and `plans[].isFeature`) ultimately derive from flags populated by `KanbanProvider.buildDispatchPlans`, documented as "THE single place" for `BatchPromptPlan[]` construction (line 3687). The two intentional bypasses (`chatCopyPrompt`, `handleGetDefaultPromptPreviews`) do not route through the planner branch, so they are unaffected. This is defense-by-convention rather than defense-in-depth — both clauses rest on the same `buildDispatchPlans` invariant. Acceptable; the `isFeature` clause still adds value for the zero-subtask case where `featureMode` is false.

### 2. `.agents/workflows/improve-plan.md` — Keep existing guard as fallback

**No changes.** The guard at lines 15–17 stays as a safety net for:
- Manual `/improve-plan` invocation against a feature (human explicitly typed the command).
- Any edge case where a feature somehow still receives an improve-plan prompt (third-party tools, stale cached prompts, etc.).

The guard is a fallback, not the primary mechanism. With the prompt-generation fix in place, generated prompts will never trigger it for features.

**Dual-signal coupling note:** The prompt-time fix keys off the `isFeature` DB flag; the retained guard keys off file location (`.switchboard/features/`) or a `<!-- BEGIN SUBTASKS -->` marker. These two signals are kept in agreement by `createFeature`'s invariant that feature files always live under `.switchboard/features/`. If that file-placement invariant is ever broken, the primary routing and the fallback guard will disagree on what counts as a feature — update both mechanisms together.

### 3. Tests — Add coverage for feature-aware workflow routing

**`src/services/__tests__/agentPromptBuilder.test.ts`** — Add tests in a new suite.

**Helper hoisting (REQUIRED — do not skip):** The existing `makeFeaturePlans()` helper is currently block-scoped inside the `§9 regression — lean dispatch prompts` suite (line 250). Before adding the new suite, **hoist `makeFeaturePlans()` to the outer `suite('agentPromptBuilder')` scope** (alongside `makePlans` at line 5) so both the new suite and the §9 suite can reference it. Alternatively, redefine a local copy inside the new suite. Without this, the new tests throw `ReferenceError: makeFeaturePlans is not defined` at suite-collection time and three of the four tests below will not run.

**New suite `feature-aware workflow routing`:**

- `feature-mode planner prompt uses improve-feature workflow path`: Call `buildKanbanBatchPrompt('planner', makeFeaturePlans(), { featureMode: true, featureTopic: 'Test Feature', subtaskCount: 2 })` and assert the prompt includes `Read .agents/workflows/improve-feature.md and follow it step-by-step` and does NOT include `improve-plan.md`.
- `isFeature on plan (no subtasks) uses improve-feature workflow path`: Call `buildKanbanBatchPrompt('planner', [{ topic: 'Lonely Feature', absolutePath: '/workspace/.switchboard/features/lonely.md', isFeature: true }], {})` and assert the prompt includes `improve-feature.md`.
- `feature-mode overrides custom plannerWorkflowPath`: Call `buildKanbanBatchPrompt('planner', makeFeaturePlans(), { featureMode: true, plannerWorkflowPath: '.custom/workflows/my-planner.md' })` and assert the prompt includes `improve-feature.md`, NOT the custom path.
- `non-feature planner prompt still uses configured workflow path (regression)`: Call `buildKanbanBatchPrompt('planner', makePlans(1), { plannerWorkflowPath: '.agents/workflows/improve-plan.md' })` and assert the prompt includes `improve-plan.md` (existing behavior unchanged).
- `workflowFilePathEnabled: false emits no workflow path for feature-mode (regression)`: Call `buildKanbanBatchPrompt('planner', makeFeaturePlans(), { featureMode: true, workflowFilePathEnabled: false })` and assert the prompt includes NEITHER `improve-feature.md` NOR `improve-plan.md`. This pins the documented interaction: when workflow-file-path injection is disabled, the routing change is a no-op and no "Read X" line is emitted for any target.

**`src/test/minimal-prompt.test.js`** — Existing tests pass `plannerWorkflowPath: '.agents/workflows/improve-plan.md'` without `featureMode` or `isFeature`, so they are unaffected. No changes needed.

**`src/test/kanban-default-prompt-previews.test.js`** — Existing tests use empty plan arrays (`[]`) with no `featureMode`, so `isFeatureTarget` is false and behavior is unchanged. No changes needed.

## Verification Plan

> **Session directive:** This plan was reviewed in a session that skips project compilation and skips automated test execution. The verification steps below reflect that constraint: tests are **authored** as part of the change but are **not run** in this session. A subsequent session (or the coder dispatching the work) is responsible for running them.

### Automated Tests

1. **(Authored, not run this session.)** Run the project test runner and verify all existing tests pass — especially `agentPromptBuilder.test.ts`, `minimal-prompt.test.js`, and `kanban-default-prompt-previews.test.js`. Per session directive, automated test execution is skipped here; the coder who picks up this plan must run them.
2. **(Authored, not run this session.)** Run the new feature-aware workflow routing tests (including the `workflowFilePathEnabled: false` regression) and verify they pass. Confirm the `makeFeaturePlans()` hoist did not break the existing `§9 regression` suite that previously declared the helper locally.
3. **(Skipped this session.)** Project compilation (`npm run compile`) — skipped per session directive. `src/` is the source of truth; `dist/` is not used during development/testing.

### Manual Verification

4. Manual verification: dispatch a feature card from the kanban board to the planner role (column move or copy-prompt button) and confirm the generated prompt says "Read .agents/workflows/improve-feature.md and follow it step-by-step" — not improve-plan.md.
5. Manual verification: dispatch a single (non-feature) plan to the planner role and confirm the prompt still says "Read .agents/workflows/improve-plan.md and follow it step-by-step."
6. Manual verification (edge case): dispatch a feature that currently has zero subtasks to the planner role and confirm the prompt still references `improve-feature.md` (exercises the `plans.some(p => p.isFeature)` clause with `featureMode === false`).

---

**Recommendation:** Complexity 4 → **Send to Coder.** The core edit is small, but the test-helper hoisting, the `workflowFilePathEnabled` interaction, and the dual-signal coupling context require a coder who will read the surrounding architecture rather than apply the diff blind.

---

**Implementation Note:** Implemented. Feature routing logic added to `agentPromptBuilder.ts` and test suite updated in `agentPromptBuilder.test.ts`.
