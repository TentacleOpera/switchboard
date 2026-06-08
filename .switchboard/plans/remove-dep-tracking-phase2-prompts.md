# Remove Dependency Tracking — Phase 2: Prompt Pipeline

## Goal

Remove all dependency-related prompt injection from the agent prompt builder and agent config: the `DEPENDENCY_CHECK_DIRECTIVE` constant, the `includeDependencyInstructions` option and DEPENDENCY ORDER block, and the `dependencyCheckEnabled` field from the agent addons interface. After this phase, no dependency instructions reach dispatched agents.

## Problem Analysis

The dependency check directive instructed agents to query Kanban for cross-plan dependencies and emit them in plan `## Dependencies` sections. The dependency order block injected a topological execution order into batch dispatch prompts. Both produced unreliable output. Removing them from the prompt pipeline ensures agents no longer attempt dependency tracking.

## Metadata

- **Complexity:** 3
- **Tags:** refactor, backend

## User Review Required

None — removal only, no new behaviour.

## Complexity Audit

### Routine
- Remove `DEPENDENCY_CHECK_DIRECTIVE` constant from agentPromptBuilder.ts
- Remove `dependencyCheckEnabled` from PromptBuilderOptions interface
- Remove `dependencyCheckEnabled` from CustomAgentAddons interface in agentConfig.ts
- Remove `dependencyCheckEnabled` parsing in agentConfig.ts
- Remove `includeDependencyInstructions` from PromptBuilderOptions interface
- Remove `includeDependencyInstructions` read from options

### Complex / Risky
- **agentPromptBuilder.ts DEPENDENCY_ORDER block** — lines 417–428 build a `depSection` string from plans with dependencies, then concatenate it into the dispatch prompt. Must remove the `plansWithDeps` filter, the `depSection` ternary, and its concatenation into the prompt. The `depSection` variable is used in a template string — must remove the reference cleanly.

## Edge-Case & Dependency Audit

- **Race Conditions:** None — no concurrent state.
- **Security:** None.
- **Side Effects:** After this phase, dispatched agents will no longer receive dependency check instructions or dependency ordering. This is the desired outcome. Agents that previously had `dependencyCheckEnabled: true` in their config will simply ignore the now-missing field.
- **Dependencies & Conflicts:** Phase 1 already removed the UI toggles that set these options. The config reads in KanbanProvider (Phase 3) will be removed next. Any remaining config values in user settings are harmless — they're just ignored.

## Dependencies

- Phase 1 (UI layer) — UI toggles already removed, so no new values can be set.

## Adversarial Synthesis

Key risk: The `depSection` variable is concatenated into the prompt string. If removed incompletely, the prompt will contain an undefined variable reference. Mitigation: remove the entire block from `plansWithDeps` through `depSection` concatenation in one clean edit. The `includeDependencyInstructions` option that gates this block is also removed, so there's no path to reach the code anyway.

## Proposed Changes

### `src/services/agentPromptBuilder.ts`
- Remove `DEPENDENCY_CHECK_DIRECTIVE` export constant (line 289)
- Remove `dependencyCheckEnabled?: boolean` from `PromptBuilderOptions` interface (line 92)
- Remove `includeDependencyInstructions?: boolean` from `PromptBuilderOptions` interface (line 131)
- Remove `const includeDependencyInstructions = options?.includeDependencyInstructions ?? false` (line 381)
- Remove the DEPENDENCY_ORDER block: `plansWithDeps` filter, `depSection` ternary, and its concatenation into the prompt (lines 417–428). Also remove the `depSection` reference in the prompt template string.
- Remove the conditional append of `DEPENDENCY_CHECK_DIRECTIVE` to planner prompt (lines 468–470)
- Remove the conditional append of `DEPENDENCY_CHECK_DIRECTIVE` to custom workflow prompt (line 1258)

### `src/services/agentConfig.ts`
- Remove `dependencyCheckEnabled?: boolean` from `CustomAgentAddons` interface (line 17)
- Remove `if (s.dependencyCheckEnabled === true) a.dependencyCheckEnabled = true;` from `parseCustomAgentAddons()` (line 164)

## Verification Plan

### Automated Tests
- Skip (per session directive). Tests cleaned in Phase 6.

### Manual Verification
- Open Kanban Prompts tab — preview text for planner role should not contain `DEPENDENCY CHECK ENABLED` or `DEPENDENCY ORDER`
- Dispatch a batch — prompt should not contain dependency ordering section
- Custom agent prompt should not contain dependency check directive

**Recommendation: Send to Intern** (Complexity 3 — small, focused removal from 2 files)
