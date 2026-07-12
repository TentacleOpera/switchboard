# Feature Config — Worktree + Subagent Levers: Decouple Feature Orchestration Into Two Independent Controls

## Goal

Make **"use agent-invoked worktrees"** and **"use subagents"** two *independent*, feature-scoped, per-role controls that materially change how an agent executes a feature. Add a per-role **feature subagent policy** (all roles) and rewire the feature-orchestration directive so the subagent decision and the worktree decision are no longer fused behind a single toggle.

### Problem & root-cause analysis

In feature mode the subagent decision is currently made by the **worktree** flag, and the general subagent policy is discarded — the two levers the user wants separated are conflated:

- The generic subagent block (`useSubagents`/`noSubagents`/`customSubagentName`, assembled at `agentPromptBuilder.ts:812-826`) is **suppressed entirely in feature mode**: `effectiveSubagentBlock = (options?.featureMode === true) ? '' : subagentBlock` (`:904`). So the Subagent Policy radio does nothing on a feature.
- Feature-mode subagent behavior is instead owned by `FEATURE_ORCHESTRATION_DIRECTIVE` (`:606-614`, selected via `resolveFeatureOrchestrationDirective` `:633-644`), whose subagent clause is gated **solely on `useWorktreesPerPlanEnabled`** (passed as `worktreesEnabled` at `:891`): worktrees ON → "use your native subagent/orchestration capabilities … worktree-per-plan"; OFF → "handle subtasks yourself, do NOT create worktrees or spawn subagents."

Net: on a feature, "spawn subagents" literally means "turn on worktrees." There is no way to say "use subagents but not worktrees," or "use worktrees without subagents," or "no subagents." This subtask cuts that seam: a **feature subagent policy** drives the subagent clause; the (now feature-only, per the Foundation subtask) **worktree toggle** drives the worktree clause; the two compose freely.

The generic non-feature subagent block stays as-is (the general Subagent Policy radio continues to govern non-feature multi-plan batches). Worktrees also stops acting outside feature mode (see Proposed Changes) so the UI relocation from the Foundation subtask matches behavior.

## Metadata
**Tags:** feature, backend, refactor, reliability
**Complexity:** 8

## User Review Required
- None. The decoupling model (two independent clauses) was set by the user; defaults preserve current behavior.

## Complexity Audit
### Routine
- New addon keys (`addons.featureSubagentPolicy`, `addons.featureCustomSubagentName`) — clean break, no migration.
- New `*ByRole` maps mirroring the existing subagent-policy projections (`:4713-4745`).
### Complex / Risky
- **Directive rewrite touched by every role branch** — `FEATURE_ORCHESTRATION_DIRECTIVE` is injected across ~8 role branches; the clause split must be applied via the shared builder (`resolveFeatureOrchestrationDirective`) so every branch inherits it consistently.
- **Coder feature branch is a separate template** — the coder's feature path (`:1210-1253`) builds its own block and passes **no** subagent block; the feature subagent policy must be threaded in there too, or the coder ignores it.
- **Worktree behavior change** — removing the non-feature `WORKTREES_PER_PLAN_DIRECTIVE` emission (`:824-826`) so worktrees is truly feature-only is a behavior change for anyone who toggled worktrees on a non-feature multi-plan batch (rare, but shipped).
- **Default preservation** — feature subagent policy `default` must reproduce today's behavior *given the worktree flag* (see Edge Cases) so existing feature dispatches don't shift.

## Edge-Case & Dependency Audit
- **Race Conditions:** none new — synchronous prompt assembly.
- **Security:** custom subagent name is sanitized (`[^a-zA-Z0-9_]` removed) at the existing input, reused here; no new injection surface.
- **Side Effects:** default (`featureSubagentPolicy: 'default'`) must map to today's effective behavior. Decision: with `default`, the subagent clause is driven by the worktree flag exactly as today (back-compat), so an existing feature dispatch is unchanged until the user picks an explicit policy. Explicit `noSubagents`/`useSubagents`/`customSubagent` override that. Removing the non-feature worktree directive changes only non-feature multi-plan dispatches with worktrees toggled on.
- **Dependencies & Conflicts:** depends on Foundation (worktree relocated to Features) and shares the `_getPromptsConfig` edit surface with the Workflow lever (neighbouring maps). Owns ALL edits to `FEATURE_ORCHESTRATION_DIRECTIVE` / `resolveFeatureOrchestrationDirective` so no other subtask races that surface.

## Dependencies
- `feature-config-foundation-features-subsection.md` — relocates the worktree toggle this subtask makes behaviorally feature-only.
- `feature-config-workflow-override-per-role.md` — shares `_getPromptsConfig` maps (coordinate merge).
- `feature-config-planner-features-ui.md` — wires the feature subagent policy into the planner's hardcoded UI.

## Adversarial Synthesis
Key risks: (1) shifting existing feature dispatches by changing the `default` semantics — mitigated by making `default` reproduce today's worktree-gated behavior; (2) the coder feature branch silently ignoring the new policy — mitigated by explicitly threading it into `:1210-1253`; (3) inconsistent application across role branches — mitigated by centralizing the clause split in `resolveFeatureOrchestrationDirective`; (4) worktree behavior change outside feature mode — mitigated by scoping the removal to the non-feature `WORKTREES_PER_PLAN_DIRECTIVE` emission and calling it out in verification.

## Proposed Changes

### `src/webview/sharedDefaults.js`
- **Context.** `SUBAGENT_POLICY_RADIO` (`:89-97`) is the reference shape; `useWorktreesPerPlan` already relocated by Foundation.
- **Logic.** Add a `featureSubagentPolicy` radio (`group: 'features'`, values `default`/`noSubagents`/`useSubagents`/`customSubagent`, `textInputOn: 'customSubagent'` → `featureCustomSubagentName`) to every role's `ROLE_ADDONS` + custom-agent list. Seed defaults in `DEFAULT_ROLE_CONFIG` (`featureSubagentPolicy: 'default'`, `featureCustomSubagentName: ''`).
- **Edge Cases.** Planner via hardcoded UI (Planner Features UI subtask).

### `src/services/KanbanProvider.ts`
- **Context.** Subagent projections at `:4713-4745` (`useSubagentsByRole`/`noSubagentsByRole`/`customSubagentNameByRole`); `useWorktreesPerPlanByRole` at `:4746` (lead/coder/intern).
- **Logic.** Add feature projections: `featureUseSubagentsByRole`, `featureNoSubagentsByRole`, `featureCustomSubagentNameByRole`, derived from `addons.featureSubagentPolicy` exactly like the general ones. Thread into resolvedOptions (`featureUseSubagentsEnabled`, `featureNoSubagentsEnabled`, `featureCustomSubagentName`). Worktree map stays as-is (lead/coder/intern).
- **Edge Cases.** Keep the general subagent maps untouched (they still govern non-feature).

### `src/services/agentPromptBuilder.ts`
- **Context.** `FEATURE_ORCHESTRATION_DIRECTIVE` (`:606-614`), `resolveFeatureOrchestrationDirective` (`:633-644`), injected via `featureDirectiveBlock` (`:885-897`, `worktreesEnabled` arg at `:891`); coder feature branch `:1210-1253`; non-feature worktree directive at `:824-826`; suppression at `:904`.
- **Logic.**
  - Split the feature orchestration directive into an independent **worktree clause** (gated on `useWorktreesPerPlanEnabled`) and **subagent clause** (gated on the new feature subagent policy: `noSubagents` → explicit prohibition; `useSubagents` → authorize native subagents; `customSubagent` → authorize the named subagent; `default` → reproduce today's worktree-gated wording for back-compat). Do this inside `resolveFeatureOrchestrationDirective` so all role branches inherit it.
  - Pass the feature subagent policy fields into `resolveFeatureOrchestrationDirective`/`featureDirectiveBlock` (`:885-897`) alongside `worktreesEnabled`.
  - Thread the same into the coder feature branch (`:1210-1253`), which currently passes no subagent block.
  - Make worktrees feature-only in behavior: remove the `WORKTREES_PER_PLAN_DIRECTIVE` append at `:824-826` (non-feature path) — worktree behavior now lives solely in the feature directive. Leave `worktreePerPlanActive` git-guardrail selection (`|| featureMode`) intact.
- **Edge Cases.** `effectiveSubagentBlock = ''` in feature mode (`:904`) stays — the generic block remains non-feature-only. Add the new option fields to the options interface.

## Verification Plan
### Automated Tests
- Session directive: tests not run here; expectations + manual repro.
- **Independence matrix (feature dispatch, per role):** worktrees ON + subagents `useSubagents` → both clauses present; worktrees OFF + `useSubagents` → subagents authorized, no worktree clause; worktrees ON + `noSubagents` → worktree clause present, explicit no-subagent; both default → prompt matches today's worktree-gated wording (back-compat).
- **Coder feature branch:** confirm the feature subagent policy appears in the coder's feature template (previously ignored).
- **Non-feature regression:** general Subagent Policy still governs non-feature multi-plan batches; worktree toggle no longer emits a worktree directive on a non-feature batch.
- **Default preservation:** an existing feature config (no feature subagent policy set) produces the same prompt as before this change.

## Reconciliation Notes (improve-feature pass, 2026-07-12)

All line references verified against live `src/`: `WORKTREES_PER_PLAN_DIRECTIVE` `agentPromptBuilder.ts:604` (emitted non-feature at `:824-826`), `FEATURE_ORCHESTRATION_DIRECTIVE` `:606-614`, `resolveFeatureOrchestrationDirective` `:633-644`, `featureDirectiveBlock` assembly `:885-897`, feature-mode suppression `effectiveSubagentBlock = '' ` at `:904`, coder feature branch `:1204-1253`; in `KanbanProvider.ts`, subagent projections `useSubagentsByRole`/`noSubagentsByRole`/`customSubagentNameByRole` at `:4713-4745` and `useWorktreesPerPlanByRole` at `:4746`. Accurate.

- **The coder feature branch does NOT call `resolveFeatureOrchestrationDirective` and has NO `featureDirectiveBlock`.** Verified: `:1204-1253` builds its own `featureExecutionBlock` (`:1216`) and its `promptParts` (`:1240-1249`) omit any feature directive; `assembleSuffix('coder', …)` at `:1234` is passed **no** subagent block. Consequence: **centralizing the subagent-clause split inside `resolveFeatureOrchestrationDirective` will NOT reach the coder.** Threading "the fields" into the branch is insufficient if the branch never renders the directive. **Extract the subagent-clause construction into a shared pure helper** (e.g. `buildFeatureSubagentClause(policy, customName, worktreesEnabled)`) that BOTH `resolveFeatureOrchestrationDirective` AND the coder feature branch call, so the wording is byte-identical across every role. Append the clause into the coder branch's `promptParts` (a `featureSubagentBlock`, filtered like the others).
- **`resolveFeatureOrchestrationDirective` already takes a `mode` param — extend, don't replace, the signature.** Current signature: `(mode, featureTopic, subtaskCount, worktreesEnabled = false, _context)` (`:633-638`); it validates `feature_worktree_mode` for a warning only (`:640-642`) then calls `FEATURE_ORCHESTRATION_DIRECTIVE`. Add the feature-subagent-policy args (policy + custom name) alongside `worktreesEnabled` and leave the mode-validation branch untouched. Thread the same fields through `featureDirectiveBlock` at `:885-897`.
- **Worktree-removal side effect (call out in verification, not a regression).** `worktreePerPlanActive: useWorktreesPerPlanEnabled || options?.featureMode === true` appears in ~8 git blocks (`:975, :1070, :1122, :1181, :1233, :1277, :1318, :1351`) — **leave all intact** (the git guardrail widening stays). After removing the non-feature `WORKTREES_PER_PLAN_DIRECTIVE` emission at `:824-826`, a *non-feature* batch with worktrees toggled ON will have the git guardrail still permitting worktree ops but **no directive instructing them** — this is harmless and intended ("worktrees = feature-only"); ensure the verification step treats the absence of the worktree directive on a non-feature batch as *correct*, not a bug.
- **Shared `_getPromptsConfig` surface with the Workflow lever** — see that plan's Reconciliation Notes: distinct map names, trivial textual merge in the resolvedOptions assembly (`:4388-4450`). This plan owns ALL edits to `FEATURE_ORCHESTRATION_DIRECTIVE` / `resolveFeatureOrchestrationDirective`; the Workflow lever touches none of it. No builder collision.

---

**Recommendation:** Complexity 8 → **Send to Lead Coder.** The behavioral heart of the feature; the subagent-clause split must be a shared helper reaching BOTH the directive and the standalone coder feature branch (see Reconciliation Notes), plus a shipped-behavior change (worktree scope) needing careful default preservation. Line references verified accurate.

## Completion Report
We have successfully implemented the Worktree and Subagent Levers subtask. We added `featureSubagentPolicy` (type: radio, group: features) and `featureCustomSubagentName` settings to `sharedDefaults.js` and custom agent configurations in `kanban.html`. The backend maps in `KanbanProvider.ts` resolve these options by role and pass them to the prompt builder. We defined a shared `buildFeatureSubagentClause` helper in `agentPromptBuilder.ts` to split feature orchestration into independent worktree and subagent clauses. This helper is called by both the feature orchestration directive resolver and the standalone coder feature branch, ensuring consistent output. Non-feature worktree directive emission was removed. No issues were encountered.
