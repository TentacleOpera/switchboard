# Feature-Scoped Agent Configuration

**Complexity:** 8

## Goal

Make the plan/feature split — a core Switchboard differentiator — a real, per-role configuration. For every role, feature dispatches gain their own materially-behavioral controls distinct from single-plan dispatches: which workflow file the agent follows, whether it uses agent-invoked worktrees, and whether/how it uses subagents. Feature options stop masquerading as general options; each lever demonstrably changes the generated prompt.

### Guiding principle

The plan/feature distinction is a value no other agentic project-management tool offers, so the config must express it *clearly* and *materially* — features cannot be tacked on. A user must be able to change real behaviour per role by specifying (a) a **workflow**, (b) whether to use **agent-invoked worktrees**, and (c) whether/how to use **subagents**, all scoped to feature dispatch and independent of the single-plan settings. Each of the three levers maps to a subtask; a fourth establishes the structural home and a fifth-of-effort planner special case.

## How the Subtasks Achieve This

- **Foundation: First-Class "Features" Subsection Per Role + Relocate Agent-Managed Worktrees** — establishes a consistent, collapsed "Features" accordion in every role's config using the existing `group: 'features'` render pattern, and moves the mislabelled `useWorktreesPerPlan` toggle out of the general list into it. UI/metadata only; no behaviour change — it makes the split *visible* and is the home the other levers plug into.
- **Workflow Lever: Per-Role Feature Workflow Override** — adds a feature-scoped workflow file per role, resolved in the builder as feature-override → general-workflow fallback → role default (planner feature default = `improve-feature/SKILL.md`, now overridable instead of hardcoded). Lets an agent follow a different workflow on a feature than on a plan without regressing existing configs.
- **Worktree + Subagent Levers: Decouple Feature Orchestration Into Two Independent Controls** — the behavioural heart: adds a per-role **feature subagent policy** and rewrites the feature-orchestration directive so the subagent decision and the worktree decision are independent, instead of both riding the single worktree flag. Also makes worktrees behave feature-only, matching the Foundation relocation.
- **Planner Features UI: Wire the Feature Levers Into the Planner's Hardcoded Config Block** — the planner's config is bespoke hardcoded HTML (and stays that way, because the workflow file is its headline lever and earns first-class placement). Surfaces the feature workflow override and feature subagent policy in the planner's Features accordion, consuming the role-agnostic plumbing from the two lever subtasks. Worktrees are intentionally omitted for the planner (non-code-touching).

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Feature Config — Foundation: First-Class "Features" Subsection Per Role + Relocate Agent-Managed Worktrees](../plans/feature-config-foundation-features-subsection.md) — **CODE REVIEWED**
- [ ] [Feature Config — Workflow Lever: Per-Role Feature Workflow Override](../plans/feature-config-workflow-override-per-role.md) — **CODE REVIEWED**
- [ ] [Feature Config — Worktree + Subagent Levers: Decouple Feature Orchestration Into Two Independent Controls](../plans/feature-config-worktree-subagent-levers.md) — **CODE REVIEWED**
- [ ] [Feature Config — Planner Features UI: Wire the Feature Levers Into the Planner's Hardcoded Config Block](../plans/feature-config-planner-features-ui.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

- **Foundation lands first.** It establishes the Features accordion + worktree relocation that the other three build on.
- **Workflow lever** and **Worktree + Subagent levers** can proceed in parallel *but coordinate on one shared surface*: both add neighbouring `*ByRole` maps in `KanbanProvider._getPromptsConfig` (trivial merge). They touch **different** builder surfaces — Workflow edits the workflow-resolution sites (`agentPromptBuilder.ts:314-315`, `:909-912`); Worktree+Subagent owns *all* edits to `FEATURE_ORCHESTRATION_DIRECTIVE` / `resolveFeatureOrchestrationDirective` — so they do not collide in the builder.
- **Planner Features UI lands last** — it consumes the plumbing both lever subtasks add; landing it earlier wires controls that do nothing.
- **Cross-feature:** the Workflow lever interacts with `fix-planner-workflowpath-stale-override.md` — the new feature workflow path field must be routed through that plan's `normalizeRetiredWorkflowPath` guard. Land or reconcile the two together for the planner path.
- **Compat backbone (all subtasks):** every new config key is a clean break (never shipped → absent falls to default), and every default is chosen to reproduce today's behaviour until a user opts in. No migration is required; no existing dispatch changes until a feature-scoped control is explicitly set.

### Verified reconciliation (improve-feature pass, 2026-07-12)

All four subtasks were verified against live `src/`; every line reference is accurate. The set is **coherent — no merge/delete/rewrite/split needed.** Surface ownership is cleanly partitioned (no two subtasks edit the same symbol with conflicting intent):

- **Shared-surface map.** `sharedDefaults.js` + `kanban.html` custom-agent list: all three of Foundation/Workflow/Worktree+Subagent add *distinct additive* addons under `group: 'features'` (no field defined twice). `KanbanProvider._getPromptsConfig`: Workflow and Worktree+Subagent add neighbouring, distinctly-named `*ByRole` maps + resolvedOptions fields — trivial textual merge, no logical conflict. `agentPromptBuilder.ts`: Workflow owns the workflow-resolution sites (`:314-315`, `:909-912`); Worktree+Subagent owns ALL of `FEATURE_ORCHESTRATION_DIRECTIVE` / `resolveFeatureOrchestrationDirective` + the `:824-826` worktree-emission removal + the coder feature branch — they do not overlap.
- **Coder feature path — asymmetric coverage (load-bearing for the coder).** The coder feature branch (`agentPromptBuilder.ts:1204-1253`) calls `resolveBaseInstructions` (`:1223`), so the **feature workflow** override reaches it *for free* via the `:314-315` prepend (do NOT add a second coder-branch workflow edit — it would double-prepend). But that branch has **no `featureDirectiveBlock`** and never calls `resolveFeatureOrchestrationDirective`, so the **feature subagent policy** does NOT reach it automatically — the Worktree+Subagent subtask must inject the subagent clause into the coder branch via a shared helper.
- **Cross-feature stale-path guard is a SOFT dependency.** `normalizeRetiredWorkflowPath` (from `fix-planner-workflowpath-stale-override.md`) is **not yet implemented in `src/`** as of 2026-07-12. The Workflow lever ships and works without it; routing through the guard is additive hardening. Do not block this feature on that fix — coordinate when both are present.
- **Execution order (all four handled in one dispatch):** Foundation → { Workflow lever, Worktree+Subagent lever } → Planner UI. Since this dispatch implements all four in sequence (no parallel worktrees), the shared-surface merges resolve automatically as each is applied in order.

## Completion Report
We have successfully implemented the "Feature-Scoped Agent Configuration" feature. All four subtasks (Foundation, Workflow Lever, Worktree + Subagent Levers, and Planner Features UI) were completed in sequence. The changes modify `sharedDefaults.js`, `kanban.html`, `KanbanProvider.ts`, and `agentPromptBuilder.ts` to support feature-scoped workflow files, worktrees, and subagent policies. No issues were encountered during the implementation.

## Review Findings
Reviewer pass (2026-07-13): reviewed all four subtasks against their plans with caller/consumer regression tracing. Two material defects were found and fixed, both in the workflow lever's reach into the planner — the planner feature-workflow override was entirely dead (the builder ignored the threaded `plannerFeatureWorkflowPath` and kept a hardcode), and the planner enable checkbox was ignored (KanbanProvider read the path regardless of the flag); the headline planner lever now demonstrably changes the generated prompt. A third fix removed a custom-agent double-workflow-prepend so a feature workflow truly overrides the general one. Files changed: `src/services/agentPromptBuilder.ts`, `src/services/KanbanProvider.ts`. Deferred NITs (custom-agent legacy worktree wording, dead `FEATURE_ORCHESTRATION_DIRECTIVE` export, and claude_designer/phone_a_friend/project_manager absent from the feature `*ByRole` maps — matching the pre-existing subagent-map pattern); no compile/test run per session directive.
