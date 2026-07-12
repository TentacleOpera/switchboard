# Feature Config — Workflow Lever: Per-Role Feature Workflow Override

## Goal

Give **every role** a feature-scoped **workflow file override** so a user can materially change which workflow an agent follows when the dispatched card is a feature — distinct from the workflow it follows on a single plan. Today only the planner has any feature-vs-plan workflow distinction, and it is a non-overridable hardcode.

### Problem & root-cause analysis

Every role already exposes a general "Workflow File" control (`workflowFilePath` — top-level for the planner, `addons.workflowFilePath` for others), consumed in the builder at `agentPromptBuilder.ts:314-315` (non-planner: `Read <path> and follow it step-by-step`) and `:909-934` (planner). But feature dispatches have **no per-role feature workflow**:

- **Planner:** when the target is a feature (`isFeatureTarget`, `agentPromptBuilder.ts:909`), the workflow is **hardcoded** to `DEFAULT_FEATURE_PLANNER_WORKFLOW = '.agents/skills/improve-feature/SKILL.md'` (`:744, :911`), ignoring any custom `plannerWorkflowPath`. A user who customises the planner workflow cannot customise it for features at all.
- **Non-planner roles:** the general `workflowFilePath` prepend at `:314-315` is **not** feature-gated — it fires identically for single-plan and feature dispatches. So there is no way to say "follow workflow X on a plan, workflow Y on a feature."

The `group: 'features'` accordion foundation (sibling subtask) is the UI home; this subtask adds the config field, plumbing, and builder resolution.

**Fallback semantics (load-bearing for compat, ~4000 installs).** The feature workflow override must default to *unset*, and when unset must **fall back to the role's general workflow** — otherwise existing users silently lose their configured workflow on features. Only when a user explicitly sets a feature workflow does it replace the general one for feature dispatches. The planner is the one asymmetry: its feature default is `.agents/skills/improve-feature/SKILL.md` (today's hardcode, now an overridable default), while its general default stays `.agents/skills/improve-plan/SKILL.md`.

## Metadata
**Tags:** feature, backend, ui, infrastructure
**Complexity:** 6

## User Review Required
- None. The override + general-fallback semantics are dictated by compat; no open product decision.

## Complexity Audit
### Routine
- New addon keys (`addons.featureWorkflowFilePath`, `addons.featureWorkflowFilePathEnabled`) — clean break, no migration (absent → default).
- New `*ByRole` maps in `_getPromptsConfig` mirroring the existing `workflowFilePathByRole` pattern.
### Complex / Risky
- **General-fallback resolution** — the builder must resolve feature workflow → general workflow → role default in the correct precedence, per role, without breaking today's non-feature behavior.
- **Planner hardcode replacement** — `:909-912` currently hardcodes the feature workflow; making it an overridable default must preserve the improve-feature default and must NOT regress the single-plan path.
- **Interaction with the stale-path fix** — the new feature workflow path field must also be covered by the retired-path normalization guard from `fix-planner-workflowpath-stale-override.md` (so a feature workflow pointing at a retired `.agents/workflows/*.md` resolves to the skills path).

## Edge-Case & Dependency Audit
- **Race Conditions:** none new — resolution is synchronous at prompt-build time.
- **Security:** feature workflow path is a plain string read into a `Read <path>` instruction, same surface as the existing workflow path; the retired-path guard is a fixed map, no injection.
- **Side Effects:** with the override unset, behavior is byte-identical to today (general workflow used for both modes; planner feature = improve-feature). A set override changes only feature dispatches for that role.
- **Dependencies & Conflicts:** depends on the Foundation subtask (Features accordion) for the UI home. Shares `_getPromptsConfig` edit surface with the Worktree+Subagent lever subtask (neighbouring `*ByRole` maps — trivial merge). Depends on / coordinates with `fix-planner-workflowpath-stale-override.md` for the normalization guard.

## Dependencies
- `feature-config-foundation-features-subsection.md` — provides the Features accordion UI home.
- `fix-planner-workflowpath-stale-override.md` — the `normalizeRetiredWorkflowPath` guard must also normalize the feature workflow path.
- `feature-config-planner-features-ui.md` — wires this field into the planner's hardcoded UI.

## Adversarial Synthesis
Key risks: (1) silently overriding an existing user's general workflow on features — mitigated by unset-default + general-fallback; (2) regressing the planner single-plan path when replacing the feature hardcode — mitigated by keeping `plannerWorkflowPath` for single plans and adding a separate `plannerFeatureWorkflowPath` defaulting to improve-feature; (3) a retired path slipping through — mitigated by routing the new field through the stale-path guard.

## Proposed Changes

### `src/webview/sharedDefaults.js`
- **Context.** `ROLE_ADDONS[role]` arrays define addons; `DEFAULT_ROLE_CONFIG` seeds defaults.
- **Logic.** Add a `featureWorkflowFilePath` addon (type `file`, `group: 'features'`, default `false`) to every role's `ROLE_ADDONS` entry (and the custom-agent inline list). Seed `addons.featureWorkflowFilePath: ''` and `addons.featureWorkflowFilePathEnabled: false` in `DEFAULT_ROLE_CONFIG` for consistency (optional — absent falls to default anyway).
- **Edge Cases.** Planner UI is hardcoded (handled in the Planner Features UI subtask); this file only feeds data-driven roles.

### `src/services/KanbanProvider.ts`
- **Context.** `_getPromptsConfig` (`:4553+`) builds `workflowFilePathByRole` (`:4584`) / `workflowFilePathEnabledByRole` (`:4573`); resolvedOptions assembly at `:4388-4450`.
- **Logic.** Add `featureWorkflowFilePathByRole` + `featureWorkflowFilePathEnabledByRole` maps (source `<role>Config?.addons?.featureWorkflowFilePath` etc.). For the **planner**, source a `plannerFeatureWorkflowPath` scalar defaulting to `.agents/skills/improve-feature/SKILL.md` when unset. Thread `resolvedOptions.featureWorkflowFilePath(+Enabled)` (all roles) and `resolvedOptions.plannerFeatureWorkflowPath` (planner branch, `:4437-4450`). Route every resolved workflow value through the `normalizeRetiredWorkflowPath` guard (per the stale-path plan).
- **Edge Cases.** Keep `workflowFilePath`/`plannerWorkflowPath` (general) untouched — feature fields are additive.

### `src/services/agentPromptBuilder.ts`
- **Context.** Non-planner workflow prepend at `:314-315`; planner workflow resolution at `:909-912` (`isFeatureTarget ? DEFAULT_FEATURE_PLANNER_WORKFLOW : (plannerWorkflowPath || DEFAULT_PLANNER_WORKFLOW)`).
- **Logic.**
  - **Planner (`:909-912`):** when `isFeatureTarget`, resolve `options.plannerFeatureWorkflowPath || DEFAULT_FEATURE_PLANNER_WORKFLOW` (was: hardcoded `DEFAULT_FEATURE_PLANNER_WORKFLOW`). Single-plan branch unchanged.
  - **Non-planner (`:314-315`):** when `options.featureMode` and `featureWorkflowFilePathEnabled && featureWorkflowFilePath`, prepend the feature workflow; otherwise fall back to today's general `workflowFilePathEnabled && workflowFilePath` behavior.
- **Edge Cases.** Preserve the planner's `workflowFilePathEnabled !== false` gate (`:933`). Feature workflow enabled=false → exactly today's behavior. Add the new option fields to the options interface (`~:171, :246-248`).

## Verification Plan
### Automated Tests
- Session directive: tests not run here; expectations + manual repro.
- **Planner feature override:** set a custom planner feature workflow; dispatch a feature → prompt reads the custom path. Unset → prompt reads `.agents/skills/improve-feature/SKILL.md`. Single-plan dispatch still reads the general planner workflow (unaffected).
- **Non-planner fallback:** coder with a general workflow set, feature override unset → feature dispatch still reads the general workflow (no regression). Set the feature override → feature dispatch reads it; single-plan still reads the general one.
- **Retired-path guard:** set a feature workflow to `.agents/workflows/improve-feature.md` → prompt resolves to `.agents/skills/improve-feature/SKILL.md`.
- **Grep gate:** confirm no remaining hardcoded `DEFAULT_FEATURE_PLANNER_WORKFLOW` read that bypasses the override.

## Reconciliation Notes (improve-feature pass, 2026-07-12)

All line references verified against live `src/`: non-planner workflow prepend at `agentPromptBuilder.ts:314-315` (inside `resolveBaseInstructions`), planner workflow resolution at `:909-912`, `DEFAULT_PLANNER_WORKFLOW` `:743` / `DEFAULT_FEATURE_PLANNER_WORKFLOW` `:744`; in `KanbanProvider.ts`, `_getPromptsConfig` at `:4553`, `workflowFilePathEnabledByRole` `:4573`, `workflowFilePathByRole` `:4584`, `plannerWorkflowPath` source `:4620`, and the planner resolvedOptions branch at `:4441-4442`. Accurate.

- **Coder feature path is covered for free (no extra coder-branch edit for THIS lever).** The coder feature branch (`agentPromptBuilder.ts:1204-1253`) builds `baseInstructions` via `resolveBaseInstructions('coder', coderBase, options)` at `:1223`. Because the workflow prepend lives *inside* `resolveBaseInstructions` (`:314-315`), feature-gating that prepend in this plan automatically threads the feature workflow into the coder feature dispatch. **Do not add a separate workflow-prepend edit to the coder feature branch** — it would double-prepend. (Contrast: the *subagent* policy is NOT auto-covered there — that is the sibling Worktree+Subagent plan's explicit coder-branch work, because the coder branch has no `featureDirectiveBlock`.)
- **The stale-path guard is a SOFT (additive) dependency, not a blocker.** As of 2026-07-12, `normalizeRetiredWorkflowPath` does **not exist** in `src/` — `fix-planner-workflowpath-stale-override.md` is unimplemented. This lever functions correctly *without* it: an explicitly-set feature workflow path is read verbatim into the `Read <path>` instruction. Routing resolved workflow values through the guard is *additive hardening* (it rewrites four retired `.agents/workflows/*.md` paths to their skills paths). Sequencing options: land the guard first, or land this lever with a clearly-marked `// TODO: route through normalizeRetiredWorkflowPath once fix-planner-workflowpath-stale-override lands` at each resolved-workflow site (`KanbanProvider.ts` per this plan's Proposed Changes). **Do not block this lever on the sibling fix.**

> **Clarification:** The Complex/Risky bullet "the new feature workflow path field must *also* be covered by the retired-path normalization guard" and the Recommendation's "cross-plan interaction with the stale-path guard" should be read as *coordinate-when-both-present*, not *hard prerequisite*. The lever ships and works standalone; the guard is layered on when it exists.

- **Shared `_getPromptsConfig` surface with the Worktree+Subagent lever.** This plan adds `featureWorkflowFilePathByRole` / `featureWorkflowFilePathEnabledByRole` / `plannerFeatureWorkflowPath`; the sibling adds `featureUseSubagentsByRole` / `featureNoSubagentsByRole` / `featureCustomSubagentNameByRole`. Distinct map names, neighbouring insertion points, and both append to the resolvedOptions assembly (`:4388-4450`) — a trivial textual merge, no logical conflict. Whichever lands second rebases onto the first.

---

**Recommendation:** Complexity 6 → **Send to Coder.** The material "workflow" lever; carries a real compat constraint (general-fallback). The stale-path guard is an additive coordination, not a blocker (see Reconciliation Notes). Line references verified accurate.
