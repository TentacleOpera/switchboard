# Remove per-subtask & high-low modes; enable agent-managed worktree cleanup

**Plan ID:** 7c3f8a2e-4b6d-4e9c-b1a8-5f7d3e2c6b90

## Metadata

**Complexity:** 5
**Tags:** refactor, backend, frontend

---

## Goal

Remove the two extension-tracked parallel-worktree auto modes (`per-subtask` and `high-low`) —
both unreleased, both creating mess (N-way merge sprawl, terminal explosion, zombie accumulation) —
and narrow the git safety guardrail so agents can `git worktree remove` worktrees they create
themselves when worktree-per-plan guidance is active. After this plan, the only extension-tracked
worktree auto mode is `per-feature` (shipped by the companion plan); within-feature parallelism is
the agent's responsibility via native `git worktree add`/`remove`, untracked by the extension.

### Core problems & background (root-cause analysis)

The worktree auto-mode epic (`.switchboard/plans/epic-worktree-modes-and-directive-scoping.md`,
landed 2026-07-01, **unreleased** — next week's release is the first to ship it) introduced three
auto modes: `per-subtask`, `high-low`, and `none`. A companion plan adds `per-feature`. The two
parallel modes (`per-subtask`, `high-low`) have fundamental problems:

1. **Worktree sprawl.** `per-subtask` creates N+1 worktrees (N subtask + 1 integration) per
   feature. `high-low` creates 3 (2 tier + 1 integration). Each is a full working copy on disk.
2. **Terminal explosion.** `ensureWorktreeTerminals` runs per worktree
   (`KanbanProvider.ts:9887`). N worktrees × M visible agents = N×M terminals.
3. **N-way merge convergence.** Each subtask/tier branch → integration branch → main. N conflict
   surfaces that compound — subtask 3's merge sees subtasks 1+2's changes already landed.
4. **Zombie accumulation.** Abandon/cleanup is manual per-worktree. A stalled feature leaves N
   stale worktrees + N stale branches.
5. **Extension owns the full lifecycle.** The extension creates, tracks, routes, merges, and
   cleans up every worktree. This is the wrong ownership model for subtask-level parallelism —
   agents have native CLI harnesses that can `git worktree add`/`remove` directly.

**Root cause:** the epic over-engineered parallelism at the subtask level (extension-provisioned,
extension-tracked, extension-merged) when the right parallelism unit is the **feature** (one
worktree per feature, multiple features in flight). Within-feature parallelism should be the
agent's call — the agent knows whether its subtasks are independent enough to warrant separate
worktrees, and its CLI harness can create/remove them without extension involvement.

**The guardrail conflict:** `GIT_SAFETY_DIRECTIVE` (`agentPromptBuilder.ts:400`) forbids
"branch/worktree deletion" unconditionally. Agents told to "activate worktree-per-plan isolation"
(base `FEATURE_ORCHESTRATION_DIRECTIVE` at 577, or `WORKTREES_PER_PLAN_DIRECTIVE` at 572 for
standalone plans) can `git worktree add` but **cannot `git worktree remove`** — the guardrail
blocks cleanup. This means agents create worktrees but can't clean them up → zombie accumulation,
which is the exact mess this plan is trying to eliminate.

### Why this is a clean break

Per the product owner: `per-subtask` and `high-low` have **never shipped** in a published VSIX
(next week's release is the first to include the worktree-modes epic). Per CLAUDE.md
[[switchboard-dev-only-no-migrations]]: "Features that have only ever existed in unreleased dev
work can take clean breaks — no migrations, no compat shims." No config values to rewrite, no
orphaned user worktrees to handle, no schema rollback. Pure deletion + one guardrail refinement.

### Non-goals

- No schema change — the `subtask_plan_id` and `tier` columns stay (harmless, no new rows written).
  Removing columns would require a migration; leaving them is free.
- No removal of `_ensureFeatureIntegrationWorktree` — it stays, repurposed for `per-feature` mode
  (companion plan).
- No removal of `WORKTREES_PER_PLAN_DIRECTIVE` or the `useWorktreesPerPlan` config toggle — these
   are the signals that tell agents to self-provision. They stay.
- No new `/worktree/create` API endpoint — agents use `git worktree add` directly via their CLI
  harness. The extension does not track agent-created worktrees.

---

## User Review Required

Before build, confirm:

- **Unreleased status.** This plan assumes `per-subtask` and `high-low` have never shipped in a
  published VSIX. The product owner has confirmed this; the coder should verify no published VSIX
  includes the worktree-modes epic before executing (check the VS Code Marketplace version vs the
  epic merge date 2026-07-01). If somehow already published, this becomes a migration plan, not a
  clean break.
- **Guardrail narrowing scope.** The narrowed guardrail (permits `git worktree remove`) activates
  only when worktree-per-plan guidance is active (`useWorktreesPerPlanEnabled` for standalone
  plans, or `featureMode` for feature dispatches). All other dispatches keep the full guardrail
  (bans `git worktree remove`). Confirm this context-dependent approach is acceptable vs a global
  narrowing.

---

## Complexity Audit

### Routine
- Enum trim: remove `'per-subtask'` and `'high-low'` from `validModes` (`KanbanProvider.ts:9185`).
- Webview trim: remove two entries from `AUTO_MODE_OPTIONS` (`kanban.html:10170-10171`).
- Delete `FEATURE_ORCHESTRATION_DIRECTIVE_PER_SUBTASK` (`agentPromptBuilder.ts:590-597`).
- Delete `FEATURE_ORCHESTRATION_DIRECTIVE_HIGH_LOW` (`agentPromptBuilder.ts:607-615`).
- Delete `PLANNER_HIGH_LOW_CONSOLIDATION_DIRECTIVE` (`agentPromptBuilder.ts:637+`).
- Delete `_provisionSubtaskWorktreeIfNeeded` (`KanbanProvider.ts:9862-9897`).
- Delete `_provisionHighLowTierWorktrees` (`KanbanProvider.ts:9796-9857`).
- Delete call sites: `createFeatureFromPlanIds` subtask loop (10731), `assignPlansToFeature`
  (10806), `addSubtaskToFeature` handler (9355), `createFeatureFromPlanIds` high-low branch
  (10734-10735).
- Delete high-low dispatch-options resolution (`KanbanProvider.ts:4382-4399`).
- Delete high-low planner consolidation injection (`agentPromptBuilder.ts:1047-1053`).
- Simplify `resolveFeatureOrchestrationDirective` (`agentPromptBuilder.ts:678-698`): remove
  per-subtask/high-low branches, keep base directive + unknown-mode warning.
- Simplify `featureDirectiveListsWorktrees` check (`agentPromptBuilder.ts:908-912`): no
  per-subtask/high-low to gate on.
- Comment cleanup: ~40 stale references to per-subtask/high-low across 4 source files (mechanical).
- Test updates: remove per-subtask/high-low test cases from `agentPromptBuilder.test.ts` and
  `dispatch-plan-builder.test.js`.

### Complex / Risky
- **Guardrail parameterization.** Split `GIT_SAFETY_DIRECTIVE` into two variants (standard +
  worktree-mode). Add `worktreePerPlanActive` param to `buildGitPolicyBlock` and thread it through
  ~12 call sites. Each call site must pass the correct signal (`useWorktreesPerPlanEnabled` for
  standalone plans, `featureMode` for feature dispatches). Well-scoped but touches many sites —
  a missed site means an agent gets the wrong guardrail variant.

---

## Edge-Case & Dependency Audit

**Race Conditions**
- No new concurrency. The deleted provisioners (`_provisionSubtaskWorktreeIfNeeded`,
  `_provisionHighLowTierWorktrees`) had race fallbacks; deleting them removes those code paths
  entirely. No race risk from deletion.
- The guardrail narrowing is a string selection at prompt-build time — no concurrency surface.

**Security**
- The narrowed guardrail permits `git worktree remove` (removes a working-copy directory, commits
  survive on the branch) but keeps the ban on `git branch -D` (loses commits), `git reset --hard`,
  `git clean`, force pushes, etc. `git worktree remove` refuses to run on a worktree with
  uncommitted changes unless `--force` is passed; the guardrail's "never run work-discarding
  commands" clause still implicitly forbids `git worktree remove --force` (it would discard
  uncommitted work). No new destructive surface.
- No new injection surface — the guardrail is a static string, no interpolation.

**Side Effects**
- **Vestigial columns:** `subtask_plan_id` and `tier` in the `worktrees` table become write-dead
  (no code writes them after deletion). Existing rows (dev-only, unreleased) are harmless. The
  columns stay — no schema change, no migration.
- **Dead merge-topology guards:** `mergeWorktree` (`KanbanProvider.ts:9240-9247`) has
  subtask→integration convergence logic. With no new subtask/tier worktrees, these guards never
  fire for new rows. Leave the guards — they're harmless for zero rows and removing them would
  touch merge logic unnecessarily.
- **Dead resolver tier:** `worktreeResolver.ts:29-33` looks up `subtask_plan_id`-bound worktrees.
  With no such rows, the lookup always misses and falls through to the feature worktree. Harmless.
  Optional simplification: remove the dead tier.
- **Dead subtask-worktree-map logic:** `expandFeatureSubtaskPlans`
  (`KanbanProvider.ts:3579-3608`) builds a `subtaskWorktreePathMap` that's always empty now.
  `hasOwnWorktree` is always `false`. Harmless. Optional simplification.
- **Subtask removal cleanup:** `removeSubtaskFromFeature` (`KanbanProvider.ts:10392-10401`)
  filters worktrees by `subtask_plan_id` and abandons them. With no such rows, the filter is
  empty. Harmless. Optional simplification.
- **Feature abandon cleanup:** `_cleanupFeatureWorktrees` still needed for per-feature worktree
  cleanup. The comment "subtask + integration" becomes "integration only" but the function works
  unchanged (it cleans up all worktrees bound to the feature_id regardless of subtask/tier).

**Dependencies & Conflicts**
- **Companion plan dependency:** `feature-worktree-per-feature-auto-mode.md` (Plan B) depends on
  this plan. After Plan A's removal, Plan B adds `per-feature` as the sole auto mode alongside
  `none`. If both are executed in one pass (recommended for the coordinated release), Plan A
  executes first (deletion), then Plan B (addition).
- No migration dependency — unreleased clean break.
- No external API impact — the `/worktree/cleanup` endpoint (`LocalApiServer.ts:1397`) stays; it
  handles any worktree row by ID/branch, mode-agnostic.

---

## Dependencies

- Companion: `feature-worktree-per-feature-auto-mode.md` (Plan B) — adds the `per-feature` mode
  that replaces the removed pair. Ship together; execute A before B.
- No prior session (`sess_…`) dependency; all referenced code is in `main`.

---

## Adversarial Synthesis

**Risk Summary:** Key risks are (1) the guardrail narrowing must be context-dependent — a missed
`buildGitPolicyBlock` call site gives an agent the wrong guardrail variant (too permissive or too
restrictive), and (2) the ~40 comment cleanups are tedious and easy to under-do, leaving stale
per-subtask/high-low references that confuse the next reader. Mitigations: the guardrail threading
is mechanical (one new param, one signal source per branch); the coder should grep for
`buildGitPolicyBlock` calls and verify each passes the correct signal. Comment cleanup is
non-functional but should be thorough — a follow-up grep for `per-subtask`/`high-low` after edits
should return zero matches outside migration-history comments.

---

## Proposed Changes

### 1. `src/services/KanbanProvider.ts`

**a. Trim the mode enum** — `setFeatureWorktreeMode` handler (~9185):
```ts
const validModes = ['none', 'per-feature'];  // per-feature added by companion Plan B
```
If Plan A ships before Plan B lands in the same coder pass, temporarily use `['none']` and Plan B
widens it. If both execute together, use `['none', 'per-feature']` directly.

**b. Delete `_provisionSubtaskWorktreeIfNeeded`** (~9862-9897) — entire method.

**c. Delete `_provisionHighLowTierWorktrees`** (~9796-9857) — entire method.

**d. Delete provisioner call sites:**
- `createFeatureFromPlanIds` subtask loop (~10731): delete the
  `_provisionSubtaskWorktreeIfNeeded` call. The `featureWorktreeModeSnapshot` line (10717) and
  the per-subtask/high-low creation branches (10718-10722) are deleted or repurposed by Plan B.
- `assignPlansToFeature` (~10806): delete the `_provisionSubtaskWorktreeIfNeeded` call. The
  `featureWorktreeModeSnapshot` line (10796) can stay or go — it's now unused for provisioning
  (no provisioner to call). If it's not read elsewhere in that function, delete it.
- `addSubtaskToFeature` handler (~9355): delete the `_provisionSubtaskWorktreeIfNeeded` call.

**e. Delete high-low dispatch-options resolution** (~4382-4399): the block that resolves
`tierWorktrees` for high-low executor directives. The `if (mode === 'high-low')` guard and the
`tierWorktrees` assignment become dead.

**f. Comment cleanup** — remove/update ~25 stale references to per-subtask/high-low in comments
across this file. Key sites: 3560, 9242, 9255, 9257, 9744-9759, 9761, 9780, 9809, 9987-9997,
10266-10277, 10339, 10392-10395, 10441-10444. Grep for `per-subtask` and `high-low` after edits
and verify zero matches outside migration-history comments (KanbanDatabase.ts:343, 5968).

**g. Optional dead-code simplification** (leave if time-constrained — harmless):
- `expandFeatureSubtaskPlans` (~3579-3608): remove the `subtaskWorktreePathMap` logic (always
  empty). `hasOwnWorktree` becomes always `false`.
- `worktreeResolver.ts` (~29-33): remove the `subtaskWt` lookup tier (always misses).
- `removeSubtaskFromFeature` (~10392-10401): remove the `subtask_plan_id` worktree filter (empty).

### 2. `src/services/agentPromptBuilder.ts`

**a. Delete directive variants:**
- `FEATURE_ORCHESTRATION_DIRECTIVE_PER_SUBTASK` (~590-597) — entire export.
- `FEATURE_ORCHESTRATION_DIRECTIVE_HIGH_LOW` (~607-615) — entire export.
- `PLANNER_HIGH_LOW_CONSOLIDATION_DIRECTIVE` (~637+) — entire export.

**b. Simplify `resolveFeatureOrchestrationDirective`** (~678-698):
```ts
export function resolveFeatureOrchestrationDirective(
    mode: string | undefined,
    featureTopic: string,
    subtaskCount: number,
    context?: FeatureOrchestrationDirectiveContext
): string {
    // per-subtask/high-low variants removed — base directive is the sole path.
    if (mode !== undefined && !['none', 'per-feature'].includes(mode)) {
        console.warn(`[agentPromptBuilder] Unknown feature_worktree_mode "${mode}" — falling back to base orchestration directive.`);
    }
    return FEATURE_ORCHESTRATION_DIRECTIVE(featureTopic, subtaskCount);
}
```
Remove the `tierWorktrees`/`subtaskWorktrees` resolution branches (684-692). The
`FeatureOrchestrationDirectiveContext` interface (~655-675) loses `tierWorktrees` and
`subtaskWorktrees` fields — or leave them as optional (harmless, never populated).

**c. Simplify `featureDirectiveListsWorktrees`** (~908-912):
```ts
// per-subtask/high-low variants removed — base directive never lists worktree assignments.
const featureDirectiveListsWorktrees = false;
```
Or remove the variable and its sole use at 914 (the `if` condition simplifies to just
`worktreePaths.length > 0`).

**d. Delete high-low planner consolidation injection** (~1047-1053): the
`if (options?.featureWorktreeMode === 'high-low' …)` block that appends
`PLANNER_HIGH_LOW_CONSOLIDATION_DIRECTIVE`.

**e. Narrow the git safety guardrail** — split into two variants:
```ts
// Standard guardrail — for dispatches where agents work in pre-assigned worktrees or
// on the current branch. Forbids worktree deletion (agents don't own the lifecycle).
export const GIT_SAFETY_DIRECTIVE = `Never run work-discarding or history-rewriting commands: git reset (--hard/--mixed), git checkout \`<path>\` / git restore, git clean, git stash drop/clear, force pushes, or branch/worktree deletion. If you make a mistake, do not discard — commit first, then correct forward.`;

// Worktree-mode guardrail — for dispatches where agents are told to self-provision worktrees
// (useWorktreesPerPlanEnabled or featureMode). Permits `git worktree remove` for cleanup after
// merge (removes the working copy, commits survive) while keeping the ban on branch deletion
// (loses commits) and all other destructive ops.
export const GIT_SAFETY_DIRECTIVE_WORKTREE_MODE = `Never run work-discarding or history-rewriting commands: git reset (--hard/--mixed), git checkout \`<path>\` / git restore, git clean, git stash drop/clear, force pushes, or branch deletion. You may remove git worktrees you created with \`git worktree remove\` to clean up after merging — this removes the working copy, not commits. Do not use \`git worktree remove --force\` (would discard uncommitted work). If you make a mistake, do not discard — commit first, then correct forward.`;
```

**f. Thread the guardrail variant through `buildGitPolicyBlock`** (~425-472):
Add a `worktreePerPlanActive?: boolean` param to `BuildGitPolicyBlockOpts` (~442) and to the
function signature (~445):
```ts
const { branch, commit, push, guardrail, worktreeActive, worktreePerPlanActive } = opts;
```
At the guardrail emission site (~466-468):
```ts
if (guardrail) {
    clauses.push(worktreePerPlanActive ? GIT_SAFETY_DIRECTIVE_WORKTREE_MODE : GIT_SAFETY_DIRECTIVE);
}
```

**g. Thread `worktreePerPlanActive` through all `buildGitPolicyBlock` call sites** (~12 sites:
1033, 1130, 1182, 1239, 1287, 1327, 1366, 1397, 1459, 1510, + planner branch). At each, pass:
```ts
worktreePerPlanActive: useWorktreesPerPlanEnabled || options?.featureMode === true
```
`useWorktreesPerPlanEnabled` is resolved at the top of the builder (~861); `options?.featureMode`
is available throughout. The coder should grep for `buildGitPolicyBlock(` and verify each call
passes the param. A missed site = wrong guardrail variant for that role.

**h. Comment cleanup** — remove/update ~15 stale references to per-subtask/high-low in comments.
Key sites: 273-274, 278, 280-282, 583-588, 600-606, 618-636, 655-675, 1262-1270.

### 3. `src/webview/kanban.html`

Remove the `per-subtask` and `high-low` entries from `AUTO_MODE_OPTIONS` (~10170-10171):
```js
const AUTO_MODE_OPTIONS = [
    { value: 'none', label: 'None', desc: 'No automatic worktrees — use the manual creation buttons below to create an individual worktree for a single project or feature to keep work isolated.' },
    // per-feature added by companion Plan B
];
```
If both plans execute together, include the `per-feature` entry here (see Plan B for the text).

### 4. `src/services/worktreeResolver.ts` (optional simplification)

The `subtaskWt` lookup tier (~29-33) is now dead — no `subtask_plan_id` rows are created. Remove:
```ts
// DELETE: subtask-worktree tier (per-subtask mode removed)
if (plan.planId) {
    const subtaskWt = active.find(w => w.subtask_plan_id && String(w.subtask_plan_id) === String(plan.planId));
    if (subtaskWt) { return subtaskWt.path; }
}
```
The resolver becomes two-tier: feature worktree → project worktree → undefined. Leave if
time-constrained — the dead tier is harmless (always misses).

### 5. Tests

- `src/services/__tests__/agentPromptBuilder.test.ts` (~276, 279, 280): remove per-subtask test
  cases for `resolveFeatureOrchestrationDirective`.
- `src/test/dispatch-plan-builder.test.js` (~13, 64, 88, 93, 95, 100, 103, 130, 139, 211, 215):
  remove per-subtask/high-low fixtures and assertions. Update worktree-row fixtures that set
  `subtask_plan_id` or `tier` to use `null` for both.

---

## Verification Plan

### Manual / static (this session)
- Compilation SKIP per session directives (installed-VSIX flow; `dist/` not used — CLAUDE.md).
- Static cross-check all edit sites against current `src/` line numbers before editing (they
  drift). Key sites: `validModes`, the two deleted methods, all call sites, the directive exports,
  `resolveFeatureOrchestrationDirective`, `featureDirectiveListsWorktrees`, the planner injection,
  `AUTO_MODE_OPTIONS`, and all `buildGitPolicyBlock` call sites.
- **Guardrail audit:** grep for `buildGitPolicyBlock(` and verify every call site passes
  `worktreePerPlanActive`. A missed site = wrong guardrail variant.
- **Stale-reference audit:** grep for `per-subtask` and `high-low` across `src/` after edits.
  Expected zero matches outside: migration-history comments (`KanbanDatabase.ts:343, 5968`) and
  this plan file.
- Grep for any accidental `confirm(`/`window.confirm` in touched webview code — forbidden.

### Runtime (after install)
1. WORKTREES tab → confirm only `None` (and `Per Feature` if Plan B is also applied) appears in
   Auto Mode. No `Per Subtask` or `High/Low` radio.
2. Attempt to set `feature_worktree_mode` to `per-subtask` via the API
   (`POST /api/kanban setFeatureWorktreeMode`) → confirm rejection (invalid mode warning).
3. Create a feature with subtasks → confirm **zero** subtask worktrees and **zero** tier worktrees
   are created regardless of mode.
4. Dispatch a standalone plan with `useWorktreesPerPlan` enabled → confirm the agent prompt
   contains `GIT_SAFETY_DIRECTIVE_WORKTREE_MODE` (permits `git worktree remove`), not the standard
   guardrail.
5. Dispatch a standalone plan with `useWorktreesPerPlan` disabled → confirm the agent prompt
   contains the standard `GIT_SAFETY_DIRECTIVE` (bans `git worktree remove`).
6. Dispatch a feature-mode plan → confirm the agent prompt contains
   `GIT_SAFETY_DIRECTIVE_WORKTREE_MODE` (feature directive says "activate worktree-per-plan
   isolation now," so the narrowed guardrail applies).
7. Dispatch a non-feature, non-worktree-per-plan plan (e.g. reviewer) → confirm the standard
   guardrail.
8. Confirm no `PLANNER_HIGH_LOW_CONSOLIDATION_DIRECTIVE` text appears in any planner prompt.
9. Confirm `resolveFeatureOrchestrationDirective('per-subtask', …)` logs the unknown-mode warning
   and returns the base directive (defensive — any stale config value degrades gracefully).

### Automated Tests
*(Authored for the separate test run — SKIP executing in this session per session directives.)*
- `resolveFeatureOrchestrationDirective('per-subtask', …)` returns the base directive and logs
  the unknown-mode warning (not a crash).
- `resolveFeatureOrchestrationDirective('high-low', …)` same.
- `buildGitPolicyBlock({ guardrail: true, worktreePerPlanActive: true })` emits
  `GIT_SAFETY_DIRECTIVE_WORKTREE_MODE` (contains "git worktree remove", does NOT contain
  "branch/worktree deletion").
- `buildGitPolicyBlock({ guardrail: true, worktreePerPlanActive: false })` emits the standard
  `GIT_SAFETY_DIRECTIVE` (contains "branch/worktree deletion").
- `buildGitPolicyBlock({ guardrail: false, worktreePerPlanActive: true })` emits no guardrail at
  all (guardrail flag is the gate, worktreePerPlanActive only selects the variant).

---

## Recommendation

Complexity 5 → **Send to Coder.** Multi-file deletion across 4 source files + 2 test files, plus
one new pattern (guardrail parameterization with ~12 call-site threads). No architecture change,
no schema change, no migration (unreleased clean break). The guardrail threading is the
error-prone part — a missed `buildGitPolicyBlock` call gives the wrong guardrail variant. The coder
should grep-verify every call site after edits. Ship together with Plan B
(`feature-worktree-per-feature-auto-mode.md`) for the coordinated release.

**Stage Complete:** PLAN REVIEWED
