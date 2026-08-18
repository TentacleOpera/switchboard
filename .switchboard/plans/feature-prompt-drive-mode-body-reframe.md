# Feature Prompt — Reframe the Entire Prompt Body When Drive Mode Is Active

## Goal

When the Drive toggle is on, a feature-dispatch prompt must tell the receiving agent to **dispatch subtasks to team seats** — not to implement them itself. Today the Drive toggle prepends a single-line prefix ("This feature is to be driven through a coder terminal. Read and follow terminal-coder-dispatch/SKILL.md.") and leaves the rest of the prompt body untouched. The body is entirely execution-coded for solo implementation, so the agent reads the overwhelming signal of the body as governing and the one-line Drive prefix as the outlier — which is the reasonable reading. The fix threads the `drive` flag into `agentPromptBuilder.ts` and reframes every execution-coded block that contradicts it.

### Problem analysis and root cause

A team-lead coder dispatched in feature mode with Drive on receives a prompt assembled from these blocks (lead role, `agentPromptBuilder.ts:1899-1944`):

| # | Source | Text (abbreviated) | Framing |
|---|--------|---------------------|---------|
| 1 | `DRIVE_FEATURE_PREFIX` (`KanbanProvider.ts:76`) | "This feature is to be driven through a coder terminal. Read and follow terminal-coder-dispatch/SKILL.md." | **Dispatch to seats** |
| 2 | `buildExecutionIntro('execute', …)` (`agentPromptBuilder.ts:427`) | "Please execute the feature described below." | Do the work |
| 3 | `executionDirective` (`agentPromptBuilder.ts:1595`) | "AUTHORIZATION: These plans are pre-approved — begin implementation immediately; do not produce a separate planning document first." | Do it yourself |
| 4 | `featureDirectiveBlock` → `resolveFeatureOrchestrationDirective` → `buildFeatureSubagentClause` (`agentPromptBuilder.ts:1242-1247`) | "FEATURE MODE: You are implementing the feature… Handle the subtasks yourself in a sensible order — do NOT create git worktrees or spawn subagents for this dispatch." (default policy) or "…Handle all subtasks yourself." (noSubagents) | Do it yourself |
| 5 | `PLANS TO PROCESS` | the plan list | Here's your work |

Line 1 says "dispatch to seats." Lines 2–5 all say "implement this yourself, begin immediately, handle the subtasks yourself." The coder feature branch is even more explicit — it adds `featureExecutionBlock` (`agentPromptBuilder.ts:1959`): *"EXECUTION MODE: The feature below is pre-approved — begin implementation immediately… Execute each subtask plan in full before moving to the next… All subtasks are one delivery unit."*

The lead read the body as governing and coded both subtasks itself, leaving its wired team idle. That is not a misread — it is the reasonable resolution of a prompt where one line says "dispatch" and the entire remaining body says "implement yourself."

**Root cause: the Drive flag never reaches `agentPromptBuilder.ts`.** The `drive` boolean is read from the DB config key `feature_drive_enabled` in `KanbanProvider._buildFeatureDirectivePrefix` (`KanbanProvider.ts:5094`) and used solely to prepend the `DRIVE_FEATURE_PREFIX` string at position-zero of the final prompt (`KanbanProvider.ts:5510-5512`). It is not threaded into `batchOptions` (`KanbanProvider.ts:5460`), not declared on `PromptBuilderOptions` (`agentPromptBuilder.ts:153-349`), and not read by any function in `agentPromptBuilder.ts`. The prompt builder has no idea Drive is on, so every block it emits is execution-coded for solo implementation regardless of the toggle.

The same applies to the custom-agent path: `buildCustomAgentPrompt` receives the prefix via `KanbanProvider.ts:5257-5258` but has no `driveMode` option either.

## Metadata

**Tags:** backend, bugfix, reliability
**Complexity:** 5
**Project:** Browser Switchboard

## User Review Required

None. The correct behaviour is unambiguous: when Drive is on, the prompt body must say "dispatch to seats" in every block that currently says "implement yourself." No design decision is needed — the Drive toggle's semantics are already defined by `terminal-coder-dispatch/SKILL.md`.

## Complexity Audit

### Routine
- Adding a `driveMode?: boolean` field to `PromptBuilderOptions` (`agentPromptBuilder.ts:153-349`) — one optional field, additive, no parser or persistence change.
- Threading the `drive` flag from `KanbanProvider._buildFeatureDirectivePrefix` into `batchOptions` (`KanbanProvider.ts:5460`) — one line reading the already-resolved `drive` boolean.
- Conditionally swapping four text blocks in `agentPromptBuilder.ts` when `driveMode` is true — each is a string constant or inline template, no logic change.

### Complex / Risky
- **Five execution-coded blocks must all flip, or the contradiction survives partially.** The `buildExecutionIntro`, `executionDirective`, `resolveFeatureOrchestrationDirective`/`buildFeatureSubagentClause`, and the coder-specific `featureExecutionBlock` each independently tell the agent to implement. Fixing one and missing the others leaves a weaker but still real contradiction — the agent sees "dispatch" in the intro and "implement yourself" in the feature directive.
- **The `buildFeatureSubagentClause` noSubagents clause is the sharpest contradiction.** "Handle all subtasks yourself" directly negates "dispatch to seats." But the noSubagents policy is about the Agent tool (spawning subagents within the same process), not about fleet terminals. When Drive is on, the clause must either be suppressed entirely or reworded to clarify the distinction. Suppressing is safer: the Drive prefix already names the skill, and the skill's §10 (rewritten by the team-lead-dispatch-only-to-own-seats plan) already governs terminal dispatch. Emitting a noSubagents clause alongside a dispatch instruction is a contradiction regardless of wording — the agent has no way to know "subagents" means "the Agent tool" and not "fleet terminals."
- **The coder feature branch has its own `featureExecutionBlock`** (`agentPromptBuilder.ts:1959`) that is separate from the lead's `executionDirective`. Both must be made drive-aware, but they are in different role branches (`if (role === 'lead')` vs `if (role === 'coder')`).
- **The custom-agent path** (`buildCustomAgentPrompt`, `agentPromptBuilder.ts:2330-2340`) also calls `buildFeatureSubagentClause` and would carry the same contradiction if Drive is on for a custom agent. The `driveMode` flag must reach this path via `CustomAgentAddons` (NOT `PromptBuilderOptions` — `buildCustomAgentPrompt` is called from `KanbanProvider:5233` with `mergedAddons`, and its signature takes `addons?: CustomAgentAddons`). Add `driveMode?: boolean` to `CustomAgentAddons` (`agentConfig.ts:14`) and set `mergedAddons.driveMode` at `KanbanProvider:5188-5192`. Note: the custom-agent path does NOT use `buildExecutionIntro` or `executionDirective`, so only the subagent-clause bypass (§7) applies — the §2/§3 changes are no-ops for custom agents.
- **Non-feature dispatch is unaffected.** Drive only applies to feature dispatch (`KanbanProvider.ts:5509` gates on `plans.some(p => p.isFeature)`). The `driveMode` flag should only be set when `featureMode` is true, and the execution-coded blocks that need to flip are all feature-gated already.

## Edge-Case & Dependency Audit

**Race Conditions** — none. Pure prompt construction, synchronous.

**Security** — none. No new surface; the `driveMode` flag is read from the same DB config key that already gates the prefix.

**Side Effects** — the shipped feature-dispatch prompt changes when Drive is on. This is the intent. Feature dispatches with Drive **off** are byte-identical to today. The `DRIVE_FEATURE_PREFIX` prepend in `KanbanProvider.ts:5510-5512` stays — it names the skill by path, which is still needed. The body reframe is additive to what the prefix already does.

**Dependencies & Conflicts**
- **`DRIVE_FEATURE_PREFIX` stays in `KanbanProvider.ts`.** The prefix names the skill; the body reframe tells the agent what to do (dispatch, not implement). Both are needed — the prefix is the discovery mechanism, the body is the instruction. Removing the prefix would break the skill-path reference that `terminal-coder-dispatch/SKILL.md` depends on.
- **The `drive` flag must be threaded into `batchOptions` at `KanbanProvider.ts:5460`.** Today `batchOptions` is built from `resolvedOptions` and `overrides` — neither carries `driveMode`. The flag must be added explicitly, sourced from the same `db.getConfig('feature_drive_enabled')` read that `_buildFeatureDirectivePrefix` already does. To avoid a second DB read, resolve `drive` once in `generateUnifiedPrompt` and pass it into both `_buildFeatureDirectivePrefix` (which currently re-reads it) and `batchOptions`.
- **The custom-agent path** (`KanbanProvider.ts:5256-5258`) prepends the prefix but builds the prompt via `buildCustomAgentPrompt`, which receives `addons?: CustomAgentAddons` (NOT `PromptBuilderOptions`). The `driveMode` flag must be threaded into `mergedAddons` at `KanbanProvider:5188-5192` (gated on `primaryPlan?.isFeature && mergedAddons.applyFeatureDirectives === true`), and `driveMode?: boolean` must be added to the `CustomAgentAddons` interface (`agentConfig.ts:14`). The custom-agent path does not call `buildExecutionIntro` or use `executionDirective`, so only the `buildFeatureSubagentClause` bypass (§7) applies.
- **The planner role is unaffected.** `resolveFeatureOrchestrationDirective` already has a planner-specific branch (`agentPromptBuilder.ts:1236-1240`) that emits "Process the subtask plan files yourself" — planners never drive coders, and Drive is allowlisted to `['lead', 'coder', 'intern']` (`KanbanProvider.ts:5509`), so the planner branch is never reached with `driveMode` true.
- **The `executionDirective` constant** (`agentPromptBuilder.ts:1595`) is used by the lead role branch (`:1932`) and the coder non-feature branch (`:2037`). Both must be made drive-aware. The coder feature branch uses `featureExecutionBlock` (`:1959`) instead — a separate constant that must also flip. The intern branch (`:2078-2089`) does NOT use `executionDirective`.
- **No test currently asserts the Drive prompt body.** The toggle plan's verification (items 3–10) were manual and not executed. A regression test should assert that `buildKanbanBatchPrompt('lead', makeFeaturePlans(), { featureMode: true, driveMode: true })` contains dispatch language and does NOT contain "begin implementation immediately" or "Handle the subtasks yourself" or "Handle all subtasks yourself."

## Dependencies

- None. The Drive toggle (`feature_plan_20260812120200`) is shipped and CODE REVIEWED. The `terminal-coder-dispatch` skill is shipped. This plan makes the prompt body coherent with the prefix that already ships.

## Adversarial Synthesis

Key risks: (1) Partial fix — flipping some blocks but missing others leaves a weaker but still real contradiction. Mitigated by enumerating all five blocks and gating each on `driveMode`. (2) The noSubagents clause is the sharpest contradiction — "Handle all subtasks yourself" vs "dispatch to seats." Suppressing it when Drive is on is safer than rewording, because any wording that mentions "subagents" alongside a dispatch instruction recreates the ambiguity the agent already misread. (3) The custom-agent path takes `CustomAgentAddons`, not `PromptBuilderOptions` — `driveMode` must be added to the `CustomAgentAddons` interface and threaded into `mergedAddons` at `KanbanProvider:5188-5192`; the §2/§3 `buildExecutionIntro`/`executionDirective` changes are no-ops for custom agents (that path uses neither). Mitigated by resolving the routing definitively in §6/§7. (4) Over-reframing — changing blocks that are not contradictory (e.g. the git block, the feature file block) would be scope creep. Mitigated by limiting the reframe to the four execution-coded blocks that directly tell the agent to implement. (5) The intern path is Drive-allowlisted (`['lead','coder','intern']`) and reachable at `:2079` — its `buildExecutionIntro` call and `featureDirectiveBlock` must be drive-aware. Mitigated by §2 and §4 covering intern (the `resolveFeatureOrchestrationDirective` fix is role-agnostic except the planner bypass). (6) Triple DB read of `feature_drive_enabled` without the hoist — resolved by committing to the single-read hoist in `generateUnifiedPrompt` (§6).

## Proposed Changes

### 1. `src/services/agentPromptBuilder.ts` — add `driveMode` to `PromptBuilderOptions`

Add to the interface (after `featureMode` at `:294`):

```ts
/** When true, the Drive toggle is active — reframe execution-coded blocks from
 *  "implement yourself" to "dispatch to team seats." Only set when featureMode
 *  is also true. The DRIVE_FEATURE_PREFIX (naming terminal-coder-dispatch/SKILL.md)
 *  is prepended by KanbanProvider; this flag reframes the prompt body to match. */
driveMode?: boolean;
```

### 2. `src/services/agentPromptBuilder.ts` — `buildExecutionIntro` (`:425-433`)

When `featureMode` and `driveMode` are both true, the intro should say "drive" not "execute":

```ts
function buildExecutionIntro(verb: string, plans: BatchPromptPlan[], featureMode?: boolean, driveMode?: boolean): string {
    if (featureMode) {
        return driveMode
            ? `Please drive the feature described below through your team seats.`
            : `Please ${verb} the feature described below.`;
    }
    if (plans.length <= 1) {
        return `Please ${verb} the plan below.`;
    }
    return `Please ${verb} the ${plans.length} plans below.`;
}
```

Update all call sites that pass `options?.featureMode` to also pass `options?.driveMode`.

> **Superseded:** The call sites are at `:1931` (lead), `:1991` (coder feature branch), `:2036` (generic), `:2079` (tester), `:2112` (analyst), `:2173` (ticket_updater), `:2224` (code_researcher). Only the lead and coder branches are reachable with `driveMode` true (Drive is allowlisted to `['lead', 'coder', 'intern']`), but all call sites should pass the flag for consistency — it no-ops when `featureMode` is false.
> **Reason:** Verified against source. `:2079` is the **intern** branch, not tester (tester is at `:1830` and builds its intro inline at `:1859`, never calling `buildExecutionIntro`). `:2036` is the **coder non-feature** branch, not "generic." `:2173` (ticket_updater) and `:2224` (researcher, mislabeled "code_researcher") do **not** call `buildExecutionIntro` at all — their `promptParts` start with `baseInstructions`. Three phantom call sites and one mislabeled role would send a coder threading `driveMode` into function calls that don't exist.
> **Replaced with:** The actual `buildExecutionIntro` call sites are `:1931` (lead, verb `'execute'`), `:1991` (coder feature branch, verb `'execute'`), `:2008` (coder non-feature branch, verb `'execute'`), `:2079` (intern, verb `'process'`), `:2112` (analyst, verb `'process'`). Drive is allowlisted to `['lead', 'coder', 'intern']` (`KanbanProvider.ts:5509`), so the **lead, coder, and intern** branches are all reachable with `driveMode` true — the analyst site (`:2112`) is not Drive-reachable but should still pass the flag for consistency (it no-ops when `featureMode` is false, and the analyst role is never dispatched with a feature in practice).

### 3. `src/services/agentPromptBuilder.ts` — `executionDirective` (`:1595`)

The `executionDirective` constant is used by the lead (`:1932`) and coder non-feature (`:2037`) branches. (The intern branch at `:2078-2089` does **not** include `executionDirective` in its `promptParts` — only `buildExecutionIntro` and `featureDirectiveBlock`.) Make it a function of `driveMode`:

```ts
const executionDirective = options?.driveMode
    ? `AUTHORIZATION: These plans are pre-approved — begin dispatching subtasks to your team seats immediately; do not produce a separate planning document first.`
    : `AUTHORIZATION: These plans are pre-approved — begin implementation immediately; do not produce a separate planning document first.`;
```

This is a local `const`, not an exported constant — it is already computed inline at `:1595`. The change is a ternary on the existing line.

### 4. `src/services/agentPromptBuilder.ts` — `resolveFeatureOrchestrationDirective` / `buildFeatureSubagentClause` (`:1183-1248`)

When `driveMode` is true, the feature directive must say "dispatch each subtask to a seat" instead of "handle the subtasks yourself," and the subagent clause must be suppressed (or reframed) to avoid the "Handle all subtasks yourself" / "dispatch to seats" contradiction.

**Option A (preferred): add a `driveMode` parameter to `resolveFeatureOrchestrationDirective` and bypass `buildFeatureSubagentClause` when it is true.**

This mirrors the existing planner bypass (`:1236-1240`). When `driveMode` is true, emit a drive-coded directive inline:

```ts
if (driveMode) {
    return `${opener('driving')}\n` +
        `Dispatch each subtask to a seat on your team — do not implement subtasks yourself. ` +
        `Review each coder's diff before accepting its work; resend a fix prompt to the same seat if it falls short. ` +
        `${unitClause}\n` +
        `Before starting, briefly tell the user how you plan to dispatch the subtasks across your seats.`;
}
```

This bypasses `buildFeatureSubagentClause` entirely, which is correct: the noSubagents/useSubagents/customSubagent policies are about the Agent tool, not fleet terminals, and emitting any of them alongside a dispatch instruction recreates the ambiguity. The worktree clause is also irrelevant — the driving agent does not create worktrees; the host provisions them.

Add `driveMode?: boolean` as a parameter to `resolveFeatureOrchestrationDirective` (after `role`, before `featureTopics`). Thread it from the call site at `:1573-1581`:

```ts
const directive = resolveFeatureOrchestrationDirective(
    options.featureTopic,
    options.subtaskCount || 0,
    useWorktreesPerPlanEnabled,
    featureSubagentPolicy,
    options.featureCustomSubagentName,
    role,
    options.featureTopics,
    options?.driveMode  // new
);
```

**The coder feature branch** (`:1981-1986`) also calls `buildFeatureSubagentClause` directly. When `driveMode` is true, replace `featureSubagentBlock` with a drive-coded clause:

```ts
const featureSubagentBlock = options?.driveMode
    ? `Dispatch each subtask to a seat on your team — do not implement subtasks yourself. Review each coder's diff before accepting its work.`
    : buildFeatureSubagentClause(
        featureSubagentPolicy,
        options?.featureCustomSubagentName,
        useWorktreesPerPlanEnabled
    ).trim();
```

### 5. `src/services/agentPromptBuilder.ts` — coder `featureExecutionBlock` (`:1959`)

The coder feature branch has its own execution block that says "begin implementation immediately… Execute each subtask plan in full." When `driveMode` is true:

```ts
const featureExecutionBlock = options?.driveMode
    ? `EXECUTION MODE: The feature below is pre-approved — begin dispatching subtasks to your team seats immediately; do not produce a separate planning document. Dispatch each subtask plan to a coder seat; review the diff on callback and resend a fix prompt if it falls short. All subtasks are one delivery unit.`
    : `EXECUTION MODE: The feature below is pre-approved — begin implementation immediately; do not produce a separate planning document. Execute each subtask plan in full before moving to the next; if a subtask hits an issue, report it clearly and continue with the remaining subtasks when safe. All subtasks are one delivery unit.`;
```

### 6. `src/services/KanbanProvider.ts` — thread `drive` into `batchOptions` (`:5460`)

Resolve `drive` once alongside the feature prefix read, and pass it into `batchOptions`:

At `:5460`, after `batchOptions` is constructed:
```ts
if (totalFeatureGroups > 0 && plans.some(p => p.isFeature) && ['lead', 'coder', 'intern'].includes(role)) {
    const drive = (await db?.getConfig('feature_drive_enabled')) === 'true';
    if (drive) {
        batchOptions.driveMode = true;
    }
}
```

This reads the same DB key as `_buildFeatureDirectivePrefix` (`:5094`). **Commit to the hoist — do not leave it as an option.** Resolve `drive` once in `generateUnifiedPrompt` (before both the custom-agent early-return at `:5233` and the `batchOptions` construction at `:5460`), then thread it into: (a) `_buildFeatureDirectivePrefix` — refactor its signature to accept a pre-resolved `drive: boolean` instead of re-reading `db.getConfig('feature_drive_enabled')` at `:5094`; (b) `batchOptions.driveMode` at `:5460`; (c) `mergedAddons.driveMode` at the custom-agent call site (`:5188-5192`). Without the hoist, the same config key is read up to **three** times in one synchronous prompt build (the built-in path reads it at `:5094` via the prefix builder and again at `:5460` via `batchOptions`; the custom-agent path reads it again at `:5094` via its own `_buildFeatureDirectivePrefix` call at `:5257`).

**The custom-agent path** (`KanbanProvider.ts:5256-5258`) prepends the prefix but does not pass `driveMode` into the prompt builder.

> **Superseded:** Check whether `buildCustomAgentPrompt` is called from within `buildKanbanBatchPrompt` (receiving `options`) or directly from `KanbanProvider`. If the latter, the `driveMode` flag must be threaded into the custom-agent call site as well — either by passing it through `addons` or by adding it to the custom-agent's options.
> **Reason:** Verified against source. `buildCustomAgentPrompt` is called **directly from `KanbanProvider` at `:5233`**, not from inside `buildKanbanBatchPrompt`. Its signature is `(plans, promptInstructions?, addons?: CustomAgentAddons, workspaceRoot?)` — it takes `CustomAgentAddons`, **not** `PromptBuilderOptions`. So the `driveMode` flag cannot flow through `PromptBuilderOptions` for this path; it must be added to the `CustomAgentAddons` interface (`src/services/agentConfig.ts:14`) and threaded into `mergedAddons` at `KanbanProvider:5188-5192`.
> **Replaced with:** Add `driveMode?: boolean` to `CustomAgentAddons` (`agentConfig.ts:14`, in the Feature-scoped levers block near `:81`). At `KanbanProvider:5188-5192`, set `mergedAddons.driveMode = drive` (using the hoisted `drive` boolean from `generateUnifiedPrompt`) when `primaryPlan?.isFeature && mergedAddons.applyFeatureDirectives === true` — the same gate that already prepends the prefix at `:5256`. The custom-agent feature branch in `buildCustomAgentPrompt` (`agentPromptBuilder.ts:2331-2340`) then reads `addons?.driveMode` and applies the §7 bypass.

**Scope note — the custom-agent path does not use `buildExecutionIntro` or `executionDirective`.** `buildCustomAgentPrompt` builds its prompt from `dispatchContextPrefix + safeguardsBlock + PLANS TO PROCESS + subagentBlock + gitBlock + addon directives` (see `:2364-2431`). It never calls `buildExecutionIntro` and never references `executionDirective`. So the §2 and §3 changes are **no-ops** for custom agents — the only execution-coded contradiction in the custom-agent path is `buildFeatureSubagentClause` at `:2335` (emitting "Handle all subtasks yourself" when the policy is `noSubagents`). Only the §7 subagent-clause bypass applies to custom agents.

### 7. `src/services/agentPromptBuilder.ts` — `buildCustomAgentPrompt` feature branch (`:2331-2340`)

When `driveMode` is true, the custom-agent feature branch must also bypass `buildFeatureSubagentClause`. The flag is read from `addons?.driveMode` (the `CustomAgentAddons` field added per §6):

```ts
if (isFeature) {
    if (addons?.driveMode) {
        subagentBlock = `Dispatch each subtask to a seat on your team — do not implement subtasks yourself. Review each coder's diff before accepting its work.`;
    } else {
        const featureSubagentPolicy = addons?.featureSubagentPolicy || 'default';
        subagentBlock = buildFeatureSubagentClause(
            featureSubagentPolicy,
            addons?.featureCustomSubagentName,
            addons?.useWorktreesPerPlan === true
        ).trim();
    }
    subagentBlock += '\nWork through the subtasks in a sensible order.';
}
```

> **Superseded:** The `driveMode` flag must be available in `buildCustomAgentPrompt`. Check whether it receives `PromptBuilderOptions` or only `addons`. If only `addons`, add `driveMode` to the addons object at the custom-agent call site in `KanbanProvider.ts`.
> **Reason:** Verified — `buildCustomAgentPrompt` takes `addons?: CustomAgentAddons`, not `PromptBuilderOptions`. The "check whether" hedge is resolved: it is `addons`, full stop.
> **Replaced with:** Read `addons?.driveMode` directly in the snippet above. The flag is populated at `KanbanProvider:5188-5192` per §6 (added to `mergedAddons` from the hoisted `drive` boolean, gated on `primaryPlan?.isFeature && mergedAddons.applyFeatureDirectives === true`).

## Verification Plan

### Automated Tests
- Add a regression test in `src/services/__tests__/agentPromptBuilder.test.ts` (or `src/test/agent-prompt-builder-subagents.test.js`):
  - `buildKanbanBatchPrompt('lead', makeFeaturePlans(), { featureMode: true, driveMode: true, featureTopic: 'Test', subtaskCount: 2 })` contains "drive the feature" and "dispatching subtasks to your team seats" and does NOT contain "begin implementation immediately" or "Handle the subtasks yourself" or "Handle all subtasks yourself" or "Execute each subtask plan in full."
  - `buildKanbanBatchPrompt('coder', makeFeaturePlans(), { featureMode: true, driveMode: true, featureTopic: 'Test', subtaskCount: 2 })` contains "dispatching subtasks to your team seats" and does NOT contain "begin implementation immediately" or "Execute each subtask plan in full."
  - `buildKanbanBatchPrompt('lead', makeFeaturePlans(), { featureMode: true, featureTopic: 'Test', subtaskCount: 2 })` (no `driveMode`) is byte-identical to today — regression check.
  - `buildKanbanBatchPrompt('lead', makeFeaturePlans(), { featureMode: true, driveMode: true, featureNoSubagentsEnabled: true, featureTopic: 'Test', subtaskCount: 2 })` does NOT contain "Handle all subtasks yourself" — the noSubagents clause is suppressed when Drive is on.
  - `buildKanbanBatchPrompt('intern', makeFeaturePlans(), { featureMode: true, driveMode: true, featureTopic: 'Test', subtaskCount: 2 })` contains "drive the feature" / "dispatching subtasks to your team seats" and does NOT contain "Handle the subtasks yourself" — the intern path (Drive-allowlisted, `:2079`) is covered.
  - `buildCustomAgentPrompt(makeFeaturePlans(), 'custom-agent', { featureSubagentPolicy: 'noSubagents', useWorktreesPerPlan: false, driveMode: true })` does NOT contain "Handle all subtasks yourself" — the custom-agent subagent-clause bypass (§7) fires on `addons?.driveMode`.
  - `buildCustomAgentPrompt(makeFeaturePlans(), 'custom-agent', { featureSubagentPolicy: 'noSubagents', useWorktreesPerPlan: false })` (no `driveMode`) still contains "Handle all subtasks yourself" — regression check that the custom-agent path is byte-identical when Drive is off.

### Manual Verification
1. With Drive on, dispatch a lead against a feature with subtasks. Confirm the prompt says "drive the feature… dispatching subtasks to your team seats" and does NOT say "begin implementation immediately" or "Handle the subtasks yourself."
2. With Drive off, dispatch the same lead against the same feature. Confirm the prompt is identical to today — "execute the feature… begin implementation immediately… Handle the subtasks yourself."
3. With Drive on, dispatch a coder against a feature. Confirm the prompt says "dispatching subtasks to your team seats" and does NOT say "Execute each subtask plan in full."
4. With Drive on and Feature Subagent Policy = No Subagents, confirm the prompt does NOT contain "Handle all subtasks yourself" — the noSubagents clause is suppressed.
5. Confirm the `DRIVE_FEATURE_PREFIX` ("This feature is to be driven through a coder terminal…") is still prepended — the prefix names the skill, the body reframes the instruction.
6. With Drive on, dispatch an **intern** against a feature with subtasks. Confirm the prompt says "drive the feature… dispatching subtasks to your team seats" and does NOT contain "Handle the subtasks yourself" — the intern path is Drive-allowlisted and must be covered (not just lead/coder).
7. With Drive on, dispatch a **custom agent** (with `applyFeatureDirectives` enabled) against a feature with Feature Subagent Policy = No Subagents. Confirm the prompt does NOT contain "Handle all subtasks yourself" — the `addons?.driveMode` bypass (§7) fires. With Drive off, confirm the custom-agent prompt is byte-identical to today.

**Recommendation:** Complexity 5 → **Send to Coder.**
