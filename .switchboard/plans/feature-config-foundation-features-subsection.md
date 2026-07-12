# Feature Config — Foundation: First-Class "Features" Subsection Per Role + Relocate Agent-Managed Worktrees

## Goal

Establish a consistent, first-class **"Features" subsection** in every role's Prompts-tab config, and relocate the **Agent-Managed Worktrees** toggle into it so feature-scoped options stop masquerading as general options. This is the structural foundation the workflow/subagent levers (sibling subtasks) plug into — it makes the plan-vs-feature split *visible* in the config UI before any new behavior lands.

### Problem & context

The plan/feature split is a core differentiator of Switchboard, but the Prompts tab does not express it. Feature-only options sit flat in the general list. The clearest offender: **`useWorktreesPerPlan`** ("Agent-Managed Worktrees (plans + feature subtasks)") is defined with **no `group`** (`sharedDefaults.js:130, 149, 189` for lead/coder/intern, plus the custom-agent inline copy at `kanban.html:3499`), so it renders as a general toggle even though its own label and tooltip describe feature-subtask orchestration.

A generic grouping mechanism **already exists**: any addon carrying `group: 'features'` is auto-rendered by `renderRoleAddons` (`kanban.html:3675-3735`) into a collapsed accordion, and the `features` group specifically gets an injected caption — *"These add-ons only take effect when the dispatched card is a feature (has subtasks). They are ignored for single-plan dispatch."* (`kanban.html:3722-3728`). Today only `staggeredImplementation` (`sharedDefaults.js:126, 145, 185`) uses it. The foundation work is therefore mostly **applying an existing pattern consistently**, not building new UI machinery.

This subtask is deliberately **UI/metadata only** — it does not change what the worktree toggle *does* in the prompt builder (that behavior change belongs to the "Worktree + Subagent levers" sibling). The transient state between this subtask and that one — worktrees shown under "Features" while its builder effect is not yet strictly feature-scoped — is acceptable within a single feature landing in sequence (see Dependencies).

## Metadata
**Tags:** ui, ux, refactor, infrastructure
**Complexity:** 3

## User Review Required
- None. Applying an existing grouping pattern; no product decision beyond the relocation the user explicitly requested.

## Complexity Audit
### Routine
- Adding `group: 'features'` to three existing `useWorktreesPerPlan` definitions + the custom-agent inline copy.
- The accordion renderer and caption already exist; no new rendering code.
### Complex / Risky
- **Label/tooltip rewrite** — the current label says "(plans + feature subtasks)"; relocating to a feature-only section means the copy must stop implying single-plan effect, without over-promising behavior the sibling subtasks haven't landed yet.
- **Planner is hardcoded** — the planner does not render from `ROLE_ADDONS`; its Features accordion is bespoke HTML (`kanban.html:3064-3074`). This subtask only confirms the planner's Features accordion exists and is styled consistently; the planner's actual feature controls land in the "Planner Features UI" sibling.

## Edge-Case & Dependency Audit
- **Race Conditions:** none — static metadata + render-time grouping.
- **Security:** none — no new input surface.
- **Side Effects:** the worktree toggle moves from the flat general list into the collapsed "Features" accordion for lead/coder/intern and custom agents. Its persisted key (`addons.useWorktreesPerPlan`) and default (`false`) are unchanged, so no migration and no value reset. Users who previously toggled it keep their value; it simply renders in a new location.
- **Dependencies & Conflicts:** must land **before** the workflow and subagent lever subtasks (they add feature-grouped addons that rely on the accordion being the established home). No conflict with `staggeredImplementation` (already grouped).

## Dependencies
- `feature-config-workflow-override-per-role.md` — consumes this subsection (workflow lever).
- `feature-config-worktree-subagent-levers.md` — completes the worktree behavior this subtask relocates in the UI.
- `feature-config-planner-features-ui.md` — planner's hardcoded Features accordion.

## Adversarial Synthesis
Key risks: (1) UI says "feature-only" while the worktree builder effect is not yet strictly feature-scoped — mitigated by landing this before the lever subtask and treating the pair as one feature; (2) copy that over-promises — mitigated by neutral relocation-only labelling. No data risk (metadata-only, no migration).

## Proposed Changes

### `src/webview/sharedDefaults.js`
- **Context.** `useWorktreesPerPlan` is defined three times (lead `:130`, coder `:149`, intern `:189`) with no `group`. `staggeredImplementation` (`:126/145/185`) is the reference for the `group: 'features'` shape.
- **Logic.** Add `group: 'features'` to each `useWorktreesPerPlan` definition. Rewrite the label from `Agent-Managed Worktrees (plans + feature subtasks)` to `Agent-Managed Worktrees`, and trim the tooltip so it describes feature-subtask orchestration only (drop the "each plan" single-plan framing).
- **Edge Cases.** Do not touch `DEFAULT_ROLE_CONFIG` seeds (`:25/26/29`) — the persisted key/default are unchanged. `ROLE_ADDONS.planner` is dead metadata (never rendered); leave it or align it, but it has no runtime effect.

### `src/webview/kanban.html`
- **Context.** The custom-agent inline addon list (`:3499`) has its own `useWorktreesPerPlan` copy; `renderRoleAddons` grouping (`:3675-3735`) already renders the `features` accordion + caption.
- **Logic.** Add `group: 'features'` to the custom-agent `useWorktreesPerPlan` entry and mirror the label/tooltip change. Verify every role that will gain feature-grouped addons renders the accordion (it renders whenever ≥1 addon carries a group).
- **Edge Cases.** Confirm the `prettyGroupLabel` mapping (`:3698-3703`) already maps `features` → "Features" (it does). No change to save/load messaging.

## Verification Plan
### Automated Tests
- Session directive: tests are not run here. Expectations for the next suite run + manual repro.
- **Manual repro:** open Prompts tab → lead/coder/intern → confirm "Agent-Managed Worktrees" now appears inside the collapsed "Features" accordion with the standard feature caption, not in the flat general list. Toggle it, reload, confirm the value persists (unchanged key).
- **Custom agent:** create a custom agent → confirm worktrees renders under Features.
- **Regression:** confirm `staggeredImplementation` still renders under the same Features accordion (shared group).

## Reconciliation Notes (improve-feature pass, 2026-07-12)

All line references in this plan were verified against live `src/` and are accurate: `useWorktreesPerPlan` at `sharedDefaults.js:130/149/189`, `staggeredImplementation` (the `group: 'features'` reference shape) at `:126/145/185`, the custom-agent inline copy at `kanban.html:3499`, and the grouping renderer at `kanban.html:3470` (`renderRoleAddons`) with the collapsed-accordion loop at `:3705-3735`, `prettyGroupLabel` (`features → "Features"`) at `:3698-3701`, and the injected features caption at `:3722-3728`.

- **De-risk (accordion presence is proven, not hypothetical).** The custom-agent inline addon list *already* carries a `group: 'features'` member — `applyFeatureDirectives` (`kanban.html:3501`). So the Features accordion already renders for custom agents today. This subtask therefore *adds worktrees to an already-rendering accordion*; it does not have to create the accordion. Likewise `staggeredImplementation` proves the accordion renders for lead/coder/intern. The renderer emits the accordion whenever `≥1` addon carries a group (`:3706-3708`) — confirmed.
- **Ordering (confirmed prerequisite).** This subtask must land first: it is the UI home the Workflow lever and Worktree+Subagent lever plug their `group: 'features'` addons into. See the feature file's Dependencies & sequencing.
- **Scope boundary holds.** This is UI/metadata only. The worktree toggle's *builder* effect (making it feature-only) is owned entirely by the Worktree+Subagent sibling (`agentPromptBuilder.ts:824-826` removal) — do not touch builder code here. The transient "worktrees shown under Features but builder not yet feature-scoped" state is acceptable within the single feature landing.

---

**Recommendation:** Complexity 3 → **Send to Intern.** Pure structural groundwork applying an existing pattern; the material behavior lands in the sibling lever subtasks. Line references verified accurate; no open decisions.

## Completion Report
We have successfully implemented the Foundation subtask. The `useWorktreesPerPlan` addon was moved into the `group: 'features'` section inside `sharedDefaults.js` and `kanban.html`. The label and tooltip were revised to focus on feature-subtask orchestration only, establishing the Features section accordion home for subsequent feature levers. No issues were encountered.
