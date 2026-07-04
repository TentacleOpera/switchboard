# Mandatory `**Stage Complete:**` directive in dispatch prompts

## Goal

Ensure **every** agent Switchboard dispatches is told — as a mandatory instruction — to append
`**Stage Complete: <COLUMN>**` to the plan `.md` when it finishes. Without this, the activity
light only ever clears via the 20-minute timeout and never reflects actual completion.

### Core problem & root cause

The marker parsing (`stage-complete-marker-clears-working-state.md`) is useless unless agents
actually write the marker. Agents only do what the dispatched prompt tells them, and the prompt
is assembled in `src/services/agentPromptBuilder.ts`. The directive must reach all roles
(planner/lead/coder/intern/reviewer/tester) and custom agents from a single seam, and must name
the exact target column and plan file so the agent writes a correct, matchable marker.

## Metadata

- **Project:** Switchboard
- **Tags:** prompts, dispatch, agent-instructions
- **Complexity:** 4

## Implementation

1. **Define the directive constant.** Add `STAGE_COMPLETE_DIRECTIVE` alongside the existing
   directive constants at `agentPromptBuilder.ts:384-397` (`GIT_PROHIBITION_DIRECTIVE`,
   `FOCUS_DIRECTIVE`, `REMOTE_MODE_DIRECTIVE`, `BATCH_EXECUTION_RULES`). Content: instruct the
   agent that when it finishes the stage, it MUST append a line `**Stage Complete: <COLUMN>**`
   to the plan file it was given, using the exact column name provided. Make it emphatic
   ("MANDATORY — the board cannot tell you have finished otherwise").

2. **Inject via the shared prefix seam.** Fold the directive into `dispatchPrefixCore`
   (`agentPromptBuilder.ts:782-790`) — the deliberate "reaches every role's suffixBlock without
   touching each role branch" seam used by `buildKanbanBatchPrompt` (`line 703`). Mirror it in
   `buildCustomAgentPrompt` (`line 1432`), which reuses `buildPromptDispatchContext` and
   `BATCH_EXECUTION_RULES`.

3. **Supply the exact column + file.** The plan file paths are already listed via
   `buildPromptDispatchContext.planList` (`agentPromptBuilder.ts:342-350`, `Plan File:
   ${plan.absolutePath}`). The destination column is known at the caller
   `KanbanProvider._generatePromptForColumn` (`KanbanProvider.ts:4687`) →
   `_generatePromptForDestinationRole` (`line 4757`); thread `destinationColumn` into `options`
   so `STAGE_COMPLETE_DIRECTIVE` can name the exact column. For batches spanning multiple plans,
   the directive must tell the agent to append the marker to **each** plan file it completes.

## User Review Required

- Confirm the marker wording matches exactly what `stage-complete-marker-clears-working-state.md`
  parses (`**Stage Complete: <COLUMN>**`).
- Decide whether the directive also ships in the copyable prompt text for remote/manual agents
  (recommended — remote agents are the primary case where Switchboard can't otherwise detect
  completion).

## Complexity Audit

### Routine
- Adding a constant and folding it into an existing `.filter(Boolean).join(...)` prefix array.
- Mirroring one constant into the custom-agent builder.

### Complex / Risky
- **Marker/parser drift.** The emitted string and the parser's expected label must stay in
  lockstep; a wording change here silently breaks clearing. Consider exporting the label from a
  single shared constant consumed by both `agentPromptBuilder.ts` and `planMetadataUtils.ts`.
- **Threading the column through options.** `destinationColumn` must be plumbed into the options
  object without disturbing the existing prefix composition; verify custom-agent columns (whose
  "column" is the custom name) produce a marker the parser's guard accepts.

## Edge-Case & Dependency Audit

- **Dependency:** pairs with `stage-complete-marker-clears-working-state.md` (shared marker
  syntax). Independent of the DB/UI subtasks.
- **Prompt bloat:** the directive is a few lines added to every dispatch — acceptable; keep it
  terse.
- **Batch dispatch:** ensure the multi-plan instruction is unambiguous about per-file markers so
  a batch agent doesn't write one marker for the whole batch.
