# Feature Config — Planner Features UI: Wire the Feature Levers Into the Planner's Hardcoded Config Block

## Goal

Surface the feature workflow override and feature subagent policy in the **planner's** Prompts-tab config. The planner's config is bespoke hardcoded HTML (not data-driven like other roles), and — per the product decision — it **stays hardcoded** because the workflow file is the planner's headline lever and deserves first-class placement (input + Validate + example paths), not a generic file row.

### Problem & context

Every other role renders its config from `ROLE_ADDONS` via `renderRoleAddons`, so the Workflow lever and Subagent lever subtasks light up their UI automatically. The **planner does not** — it is a hardcoded block (`kanban.html:2966-3101`) with its own listeners/load/save, and its `ROLE_ADDONS.planner` entry is dead metadata. Its existing "Features" accordion (`:3064-3074`) holds exactly one checkbox (`writeFeatureDescriptionIfEmpty`). This subtask extends that hardcoded Features accordion to expose the two new planner feature controls, consuming the (role-agnostic) plumbing the lever subtasks add.

Worktrees are intentionally **not** added to the planner: the planner is non-code-touching and does not provision worktrees. The planner's feature levers are the **workflow** (headline) and the **subagent policy**.

## Metadata
**Tags:** ui, ux, feature
**Complexity:** 5

## User Review Required
- None. Planner-stays-hardcoded and planner-omits-worktrees were decided with the user.

## Complexity Audit
### Routine
- Adding two control groups to an existing hardcoded accordion, following the planner's own existing patterns (the general workflow input at `:2967-2994` and the general subagent radios at `:3076-3097` are direct templates).
### Complex / Risky
- **Bespoke wiring** — the planner has hand-written listeners (`:4309-4420`), load (`:3419-3446`), and save (`roleConfigs.planner`, top-level `workflowFilePath`). The new controls need parallel wiring; missing any one silently drops the value.
- **Two workflow inputs** — the planner will now show a general workflow input AND a feature workflow input; the UI must make the distinction obvious (which applies to plans vs features) to avoid confusion.
- **Storage shape asymmetry** — the general planner workflow path is a **top-level** field (`roleConfigs.planner.workflowFilePath`); the new feature workflow should live under `addons.featureWorkflowFilePath` (matching other roles) so the plumbing reads it uniformly.

## Edge-Case & Dependency Audit
- **Race Conditions:** none — webview event wiring.
- **Security:** feature workflow path + custom subagent name reuse the existing validation/sanitization patterns (`fileExists` validate; `[^a-zA-Z0-9_]` strip).
- **Side Effects:** the planner's Features accordion grows from one checkbox to a workflow input + subagent radios + the existing checkbox. No effect on non-planner roles.
- **Dependencies & Conflicts:** must land **after** the Workflow and Subagent lever subtasks (their `_getPromptsConfig`/builder plumbing is what makes these controls do anything). Purely additive to the hardcoded block.

## Dependencies
- `feature-config-workflow-override-per-role.md` — provides `plannerFeatureWorkflowPath` plumbing + builder resolution.
- `feature-config-worktree-subagent-levers.md` — provides the feature subagent policy plumbing + builder clause.
- `feature-config-foundation-features-subsection.md` — the Features-accordion pattern the planner mirrors.

## Adversarial Synthesis
Key risks: (1) partial wiring silently dropping a value — mitigated by mirroring the planner's existing three-point wiring (listener/load/save) for each new control and verifying round-trip persistence; (2) user confusion between the two workflow inputs — mitigated by explicit labels ("Workflow File (single plan)" vs "Feature Workflow File") and placing the feature one inside the Features accordion; (3) landing before the plumbing exists — mitigated by the stated sequencing.

## Proposed Changes

### `src/webview/kanban.html`
- **Context.** Planner block `:2966-3101`: general workflow subsection `:2967-2994` (input `#workflowFilePath` + `#plannerWorkflowEnabled` + `#validateWorkflowPath` + examples), general subagent radios `:3076-3097` (`name="plannerSubagentPolicy"` + `#plannerAddonCustomSubagentName`), Features accordion `:3064-3074`. Listeners `:4309-4420`; load `:3419-3446`; save via `saveRoleConfig('planner')`.
- **Logic.**
  - Inside the Features accordion, add a **Feature Workflow File** control mirroring the general workflow subsection: input `#plannerFeatureWorkflowFilePath` + enable checkbox + a Validate button + a short example (default value `.agents/skills/improve-feature/SKILL.md`). Persist to `roleConfigs.planner.addons.featureWorkflowFilePath` (+`featureWorkflowFilePathEnabled`).
  - Add a **Feature Subagent Policy** radio group (`name="plannerFeatureSubagentPolicy"`, values default/noSubagents/useSubagents/customSubagent) + a `#plannerFeatureCustomSubagentName` input revealed on `customSubagent`, mirroring `:3076-3097`. Persist to `addons.featureSubagentPolicy` / `addons.featureCustomSubagentName`.
  - Wire listeners (mirror `:4309-4420`), load-into-UI (mirror `:3419-3446`), and ensure each writes `roleConfigs.planner` then `saveRoleConfig('planner')`.
  - Relabel the existing general workflow input to make the plan-vs-feature distinction explicit.
- **Edge Cases.** Reuse the existing `fileExists` validate message + status element pattern. Clearing away from `customSubagent` wipes `featureCustomSubagentName` (mirror `:4401-4404`). Do not disturb the general (top-level) `workflowFilePath` wiring.

## Verification Plan
### Automated Tests
- Session directive: tests not run here; expectations + manual repro.
- **Round-trip:** set planner feature workflow + feature subagent policy, reload window, confirm both persist and re-display.
- **Materiality:** with a planner feature workflow set, dispatch a feature → generated planner prompt reads that path (proves the UI value reaches the builder via the lever subtasks). Set feature subagent policy to `noSubagents` → feature directive shows the no-subagent clause.
- **No cross-talk:** the general (single-plan) planner workflow still drives single-plan dispatches; the two inputs are independent.

## Reconciliation Notes (improve-feature pass, 2026-07-12)

All line references verified against live `src/webview/kanban.html`: planner block `:2966-3101`; general workflow subsection — input `#workflowFilePath` `:2981`, enable `#plannerWorkflowEnabled` `:2974`, Validate `#validateWorkflowPath` `:2982`; Features accordion + its feature-only caption `:3067`; general subagent radios `name="plannerSubagentPolicy"` `:3080-3094` with `#plannerAddonCustomSubagentName` `:3094`; load-into-UI at `:3419-3446` (workflow-enabled `:3422`, subagent policy `:3439-3444`); listeners `:4309-4417` (workflow-enable `:4309`, Validate `:4332`, subagent radios `:4392`, save via `saveRoleConfig('planner')`). Accurate.

- **Storage-shape asymmetry confirmed.** The general planner workflow *path* is a **top-level** field: `KanbanProvider.ts:4620` reads `plannerConfig?.workflowFilePath` (top-level), while its *enabled* flag lives under `addons.workflowFilePathEnabled` (loaded at `kanban.html:3422`). The NEW feature workflow must live under `addons.featureWorkflowFilePath` (+`featureWorkflowFilePathEnabled`) so the Workflow-lever plumbing reads it uniformly with the other roles' `addons.featureWorkflowFilePath`. Do **not** put the feature workflow at top-level — that would diverge from the role-agnostic plumbing.
- **Hard sequencing — lands LAST.** This subtask only wires UI; the controls do nothing until BOTH lever subtasks' plumbing exists: `plannerFeatureWorkflowPath` resolution (Workflow lever, `agentPromptBuilder.ts:909-912` + `KanbanProvider.ts` planner branch) and the feature-subagent clause (Worktree+Subagent lever). Landing this before them wires dead controls — exactly the "reachable but not usable" failure the feature's materiality checks guard against. The Materiality verification here (dispatch a feature → prompt reads the set path / shows the no-subagent clause) is what proves the wiring reaches the builder; keep it.
- **Three-point wiring is the whole risk.** For each of the two new controls, mirror the planner's existing listener (`:4309-4417`) → load (`:3419-3446`) → save (`saveRoleConfig('planner')`) triad. A missing leg silently drops the value with no error. This is completeness work, not novelty — hence complexity 5.

---

**Recommendation:** Complexity 5 → **Send to Coder.** Bespoke but pattern-following UI wiring; the risk is completeness of the three-point wiring, not novelty. Must land after both lever subtasks (see Reconciliation Notes). Line references verified accurate.
