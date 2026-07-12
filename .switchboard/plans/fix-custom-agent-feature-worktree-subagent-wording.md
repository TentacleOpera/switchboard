# Fix: Custom-Agent Feature Dispatch Emits Contradictory Worktree/Subagent Wording

## Goal

Make **custom-agent** feature dispatches use the same coherent worktree/subagent wording that built-in roles already get, so the "use agent-invoked worktrees" and "use subagents" levers compose without contradicting each other.

### Problem & root-cause analysis

The Feature-Scoped Agent Configuration feature split feature orchestration into two independent clauses (worktree decision vs subagent decision) and centralised the wording in the shared helper `buildFeatureSubagentClause` (`agentPromptBuilder.ts:649`). Built-in roles (lead/coder/intern/planner/etc.) route through that helper — via `resolveFeatureOrchestrationDirective` and the standalone coder feature branch — so for every policy/worktree combination they emit consistent, non-conflicting text.

`buildCustomAgentPrompt` (`agentPromptBuilder.ts:1625`) was **not** migrated onto the helper. Its feature path still assembles the subagent text the legacy way and then bolts the old `WORKTREES_PER_PLAN_DIRECTIVE` on separately (≈`:1666-1683`):

```js
let subagentBlock = '';
if (noSubagentsEnabled) {
    subagentBlock = NO_SUBAGENTS_DIRECTIVE;   // "strictly forbidden from spawning or invoking any subagents"
} else if (customSubagentName) { ... }
  else if (plans.length > 1 && useSubagentsEnabled) { ... }

if (addons?.useWorktreesPerPlan && isFeature) {
    subagentBlock = subagentBlock
        ? subagentBlock + '\n\n' + WORKTREES_PER_PLAN_DIRECTIVE   // "...process each plan using your native subagent or orchestration capabilities..."
        : WORKTREES_PER_PLAN_DIRECTIVE;
}
```

**The contradiction:** a custom agent configured with **Feature Subagent Policy = No Subagents** *and* **Agent-Managed Worktrees = ON** produces a prompt containing both "you are strictly forbidden from spawning or invoking any subagents" and "process each plan using your native subagent or orchestration capabilities." The two feature levers, which the feature was explicitly built to decouple, re-collide for custom agents only. The shared helper resolves the same combination coherently ("Use a dedicated git worktree for each subtask… You are strictly forbidden from spawning or invoking any subagents" — worktrees without subagents, a valid mode).

Root cause: the Worktree+Subagent lever subtask scoped the shared-helper migration to `resolveFeatureOrchestrationDirective` + the coder feature branch and deliberately left the custom-agent template on its own wording. This is the follow-up that finishes the job for custom agents.

## Metadata
**Tags:** backend, refactor, reliability, bugfix
**Complexity:** 4

## User Review Required
- None. This aligns custom agents with the already-shipped decoupling model; behaviour for the non-feature path is unchanged and the feature-path wording converges onto the existing built-in-role wording.

## Complexity Audit
### Routine
- Reusing the existing `buildFeatureSubagentClause` helper (already exported and battle-tested by the built-in roles) for the custom-agent feature branch.
- Deleting the now-redundant `WORKTREES_PER_PLAN_DIRECTIVE` append in `buildCustomAgentPrompt`.
- Declaring the four missing feature fields on `CustomAgentAddons` (`agentConfig.ts`) — additive optional fields, no parser or persistence change.
### Complex / Risky
- **Preserving the non-feature path byte-for-byte** — `buildCustomAgentPrompt` handles BOTH feature and non-feature custom-agent dispatch through the same three ternaries. Only the `isFeature` branch may change; the non-feature (general Subagent Policy) branch must keep today's exact logic, including the `plans.length > 1` gate.
- **Wording convergence, not regression** — the feature-path output changes for custom agents (legacy "per plan" phrasing → shared "per subtask" phrasing). This is the intended fix, not a regression; it makes custom agents identical to built-in roles.

## Edge-Case & Dependency Audit
- **Race Conditions:** none — synchronous prompt assembly.
- **Security:** custom subagent name continues to be sanitised at the input (`[^a-zA-Z0-9_]` strip in the webview) and trimmed here; no new surface. `buildFeatureSubagentClause` already `.trim()`s the custom name internally.
- **Side Effects:** feature-mode custom-agent prompts change wording (converge onto the built-in clause). Non-feature custom-agent prompts are unchanged. No persisted state, no config keys, no migration — prompt text is regenerated per dispatch.
- **Variable-scope safety (verified):** the three intermediate consts (`noSubagentsEnabled`, `customSubagentName`, `useSubagentsEnabled`) plus `featureSubagentPolicy` are referenced ONLY inside the subagent-block assembly. Downstream code uses only `subagentBlock` (kept at outer scope) and reads `addons?.useWorktreesPerPlan` directly from `addons` (git block `worktreePerPlanActive`). So the feature-branch consts can move without breaking later code.
- **`WORKTREES_PER_PLAN_DIRECTIVE` is NOT orphaned by this change:** it is still consumed by `AgentSkillExporter.ts:308`. Only the `buildCustomAgentPrompt` reference is removed. Do not delete the constant.
- **Type-level gap (verified via `tsc --noEmit`):** `CustomAgentAddons` (`src/services/agentConfig.ts:3-70`) does NOT declare `featureSubagentPolicy`, `featureCustomSubagentName`, `featureWorkflowFilePathEnabled`, or `featureWorkflowFilePath` — yet `buildCustomAgentPrompt` already reads all four (`:1644`, `:1648`, `:1650`, `:1658`, `:1663`). That is 6 pre-existing TS2551/TS2561 errors sitting on the exact lines this plan rewrites, and the proposed code keeps reading two of the fields. This plan MUST declare the four fields on the interface (see Proposed Changes) or the fix does not typecheck. Runtime works today only because the values flow through the untyped role-config spread in `KanbanProvider` (`mergedAddons`, `:4340-4344`).
- **`parseCustomAgentAddons` intentionally untouched:** the definition-level parser (`agentConfig.ts:178`) does not copy the feature fields, and this plan does not add them there. The feature levers are role-config-carried (Prompts tab → `_getRoleConfig(role)?.addons`, spread raw into `mergedAddons`), not definition-carried. Declaring the interface fields is a typing fix, not a parsing behavior change.
- **Exported-skill surface keeps the legacy pairing (out of scope):** `AgentSkillExporter.ts:282-311` can still render `NO_SUBAGENTS_DIRECTIVE` and `WORKTREES_PER_PLAN_DIRECTIVE` together in an exported skill doc. That surface renders the *general* (definition-level) policy, not the feature-scoped one, and is a static document, not a live dispatch prompt. Noted for a possible follow-up; do not touch it here.
- **Clause framing is adequate without a FEATURE MODE header:** the helper's clauses say "subtask", and the custom prompt's plan list already labels entries `[FEATURE: <topic>]` / `[SUBTASK]` (`buildPromptDispatchContext`, `agentPromptBuilder.ts:371-378`), so the wording lands with context. The bare-clause (no `FEATURE MODE:` header) pattern matches the built-in worktree-coder path (`:1313-1317`), which also composes the trimmed clause without the header.
- **Dependencies & Conflicts:** builds on the shipped Feature-Scoped Agent Configuration feature (`buildFeatureSubagentClause` must exist — it does, `agentPromptBuilder.ts:649`). No shared surface with any in-flight plan.

## Dependencies
- None.

## Adversarial Synthesis
Key risks: (1) accidentally changing the non-feature custom-agent path — mitigated by gating the helper call on `isFeature` and leaving the `else` branch as a verbatim copy of today's logic; (2) losing the worktree instruction for the noSubagents+worktrees combo — mitigated because `buildFeatureSubagentClause` emits an explicit worktree clause for that combo; (3) shipping code that reads fields `CustomAgentAddons` never declared — mitigated by declaring the four feature fields on the interface as part of this change (also clears 6 pre-existing type errors); (4) breaking a downstream reference to a moved const — ruled out by the variable-scope audit above; (5) leaving `WORKTREES_PER_PLAN_DIRECTIVE` dead — ruled out (still used by `AgentSkillExporter`).

## Proposed Changes

### `src/services/agentConfig.ts` — declare the feature fields on `CustomAgentAddons`
- **Context.** `buildCustomAgentPrompt` already reads `addons?.featureWorkflowFilePathEnabled` / `addons?.featureWorkflowFilePath` (`:1644-1650`) and `addons?.featureSubagentPolicy` / `addons?.featureCustomSubagentName` (`:1658-1663`), and this plan's proposed code keeps reading the latter two — but none of the four exist on `CustomAgentAddons` (`agentConfig.ts:3-70`). `tsc --noEmit` reports 6 errors (TS2551 ×5, TS2561 ×1) at exactly those lines today.
- **Logic.** Add to the interface, alongside the existing `workflowFilePathEnabled`/`workflowFilePath` block:
  ```ts
  // Feature-scoped levers (role-config-carried via the Prompts tab; the
  // definition-level parser parseCustomAgentAddons deliberately does not copy these)
  featureSubagentPolicy?: 'default' | 'noSubagents' | 'useSubagents' | 'customSubagent';
  featureCustomSubagentName?: string;
  featureWorkflowFilePathEnabled?: boolean;
  featureWorkflowFilePath?: string;
  ```
- **Edge Cases.** Do NOT extend `parseCustomAgentAddons` (`:178`) — that would silently start honoring feature fields on custom-agent *definitions*, a behavior change outside this fix. Optional fields are additive; `AgentSkillExporter`'s `CustomAgentAddons` construction sites are unaffected.

### `src/services/agentPromptBuilder.ts` — `buildCustomAgentPrompt`
- **Context.** After the workflow-prepend recursion guards, the function computes `featureSubagentPolicy` + three subagent consts (both branched on `isFeature`), assembles `subagentBlock`, then appends `WORKTREES_PER_PLAN_DIRECTIVE` when `addons?.useWorktreesPerPlan && isFeature` (`:1658-1683` at time of writing).
- **Logic.** Replace the single shared assembly with an `isFeature` split:
  - **Feature branch** → derive `subagentBlock` from the shared helper, matching built-in roles exactly:
    ```js
    let subagentBlock = '';
    if (isFeature) {
        const featureSubagentPolicy = addons?.featureSubagentPolicy || 'default';
        subagentBlock = buildFeatureSubagentClause(
            featureSubagentPolicy,
            addons?.featureCustomSubagentName,
            addons?.useWorktreesPerPlan === true
        ).trim();
    } else {
        // Non-feature dispatch — general Subagent Policy, unchanged from today.
        const noSubagentsEnabled = addons?.subagentPolicy === 'noSubagents';
        const customSubagentName = addons?.subagentPolicy === 'customSubagent' ? addons?.customSubagentName?.trim() : undefined;
        const useSubagentsEnabled = addons?.subagentPolicy === 'useSubagents'
            || (addons?.subagentPolicy === undefined && addons?.useSubagents === true);
        if (noSubagentsEnabled) {
            subagentBlock = NO_SUBAGENTS_DIRECTIVE;
        } else if (customSubagentName) {
            subagentBlock = CUSTOM_SUBAGENT_DIRECTIVE_TEMPLATE(customSubagentName);
            if (plans.length > 1) {
                subagentBlock += '\n\n' + `If your platform supports parallel sub-agents, dispatch one "${customSubagentName}" sub-agent per plan to execute them concurrently. If not, process them sequentially.`;
            }
        } else if (plans.length > 1 && useSubagentsEnabled) {
            subagentBlock = `If your platform supports parallel sub-agents, dispatch one sub-agent per plan to execute them concurrently. If not, process them sequentially.`;
        }
    }
    ```
  - **Delete** the trailing `if (addons?.useWorktreesPerPlan && isFeature) { … WORKTREES_PER_PLAN_DIRECTIVE … }` block — the feature clause now owns all worktree wording, and the non-feature branch never emitted it anyway.
- **Edge Cases.** Keep `subagentBlock` declared at the outer scope (used later at the `if (subagentBlock) prompt += …` site). Do not touch the git block's `worktreePerPlanActive: addons?.useWorktreesPerPlan === true` — the guardrail widening stays. Do not remove the `WORKTREES_PER_PLAN_DIRECTIVE` constant (still used by `AgentSkillExporter`).
- **Intentional behavior deltas on the feature path** (all convergences onto the built-in-role wording; listed so the coder does not "fix" them back):
  - `default` policy + worktrees OFF: today emits **no** subagent text; after the fix it emits the explicit "Handle the subtasks yourself in a sensible order — do NOT create git worktrees or spawn subagents for this dispatch." clause. This is the largest visible change and is exactly what built-in roles emit.
  - `customSubagent` + multiple plans: the legacy extra line "dispatch one \"<name>\" sub-agent per plan … concurrently" disappears; the helper's single authorising clause replaces it.
  - The `plans.length > 1` gate no longer applies in feature mode — the helper emits its clause even for a single-subtask feature (matches built-ins).
  - `customSubagent` with a blank/unset name: helper falls back to the neutral "Use your native subagent or orchestration capabilities…" clause instead of emitting nothing.
  - The `.trim()` on the helper's return matches the built-in worktree-coder call site (`:1313-1317`) — byte-parity is against the *trimmed* clause.

## Verification Plan
### Automated Tests
- Session default: run the suite if enabled. No new unit test is strictly required, but a focused assertion on `buildCustomAgentPrompt` output for the noSubagents+worktrees feature combo would lock the fix.
- **Independence matrix (custom agent, feature dispatch):**
  - `noSubagents` + worktrees ON → single coherent block: worktree clause + "strictly forbidden from spawning or invoking any subagents"; **no** "use your native subagent capabilities" text.
  - `useSubagents` + worktrees OFF → subagent-authorising clause, no worktree clause.
  - `useSubagents` + worktrees ON → both clauses, no contradiction.
  - `default` + worktrees ON/OFF → matches the built-in-role `default` wording for the same worktree state.
  - `customSubagent` "Foo" + worktrees ON → names Foo, worktree clause present.
- **Byte-parity check:** for a given (policy, worktreesEnabled) the custom-agent feature `subagentBlock` equals the built-in-role clause from `buildFeatureSubagentClause` (that is the definition of the fix).
- **Non-feature regression:** a non-feature custom-agent dispatch produces the SAME prompt as before this change (general Subagent Policy path untouched; `plans.length > 1` gate intact; no worktree directive).
- **Grep gate:** confirm `buildCustomAgentPrompt` no longer references `WORKTREES_PER_PLAN_DIRECTIVE`, and that `AgentSkillExporter.ts` still does.
- **Interface gate:** grep `agentConfig.ts` for `featureSubagentPolicy`, `featureCustomSubagentName`, `featureWorkflowFilePathEnabled`, `featureWorkflowFilePath` — all four must now be declared on `CustomAgentAddons`. Side effect: the 6 pre-existing type errors at `agentPromptBuilder.ts:1644/:1648/:1650/:1658/:1663` disappear (observable in editor diagnostics; no compilation run required per session directive).
- **Parser gate:** confirm `parseCustomAgentAddons` was NOT extended with the feature fields (definition-level behavior must not change).

---

> **Superseded:** Complexity 3 → **Send to Coder.**
> **Reason:** Two fixes. (a) Scope grew: the fix now also declares four missing fields on `CustomAgentAddons` in `agentConfig.ts` — without them the proposed code does not typecheck (6 pre-existing TS2551/TS2561 errors on the exact lines being rewritten). Two files, still routine. (b) The original pairing violated the routing map (1-3 → Intern, 4-6 → Coder); at complexity 4 the Coder routing is consistent.
> **Replaced with:** Complexity 4 → **Send to Coder.**

**Recommendation:** Complexity 4 → **Send to Coder.** Mechanical convergence onto an existing, proven helper plus a four-field interface declaration; the real discipline is leaving the non-feature branch byte-identical, not deleting the still-used `WORKTREES_PER_PLAN_DIRECTIVE` constant, and not extending `parseCustomAgentAddons`.
