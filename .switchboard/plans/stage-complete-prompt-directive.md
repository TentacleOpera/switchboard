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
   directive constants at `agentPromptBuilder.ts:376-389` (`GIT_PROHIBITION_DIRECTIVE` at 376,
   `FOCUS_DIRECTIVE` at 377, `REMOTE_MODE_DIRECTIVE` at 383, `BATCH_EXECUTION_RULES` at
   386-389). Content: instruct the agent that when it finishes the stage, it MUST append a line
   `**Stage Complete: <COLUMN>**` to the plan file it was given, using the exact column name
   provided. Make it emphatic ("MANDATORY — the board cannot tell you have finished otherwise").
   **Share the label:** export the literal label string (`Stage Complete`) from a single
   constant consumed by both this file and `planMetadataUtils.ts` (B-2's parser) so the emitter
   and parser cannot drift (see Complexity Audit).

2. **Inject via the shared prefix seam.** Fold the directive into `dispatchPrefixCore`
   (`agentPromptBuilder.ts:785` — the array
   `[dispatchContextBlock, worktreeBlock, remoteModeBlock, prdBlock].filter(Boolean).join('\n\n')`)
   — the deliberate "reaches every role's suffixBlock without touching each role branch" seam
   assembled inside `buildKanbanBatchPrompt` (prefix built at line 785). Mirror it in
   `buildCustomAgentPrompt` (`agentPromptBuilder.ts:1428`, which composes
   `BATCH_EXECUTION_RULES`/`FOCUS_DIRECTIVE` at 1469-1470), so custom agents also emit the
   directive.

3. **Supply the exact column + file.** The plan file paths are already listed via
   `buildPromptDispatchContext.planList` (`agentPromptBuilder.ts:329`; the list is built at
   334-342 with `Plan File: ${plan.absolutePath}`). The destination column is **already** a
   parameter of `KanbanProvider._generatePromptForColumn` (`KanbanProvider.ts:4821`, param
   `destinationColumn` at 4825, used at 4835/4847/4857) which calls
   `_generatePromptForDestinationRole` (`KanbanProvider.ts:4891`). The remaining work is to
   **forward `destinationColumn` into the prompt-builder `options`** object so
   `STAGE_COMPLETE_DIRECTIVE` can interpolate the exact column. (Call sites already passing a
   destination column: 6563, 6580, 6654, 6672, 7563, 7652, 8420; sites 7120 and 8404 pass none —
   for those, the directive should fall back to "append `**Stage Complete:**` with the column
   you were dispatched for" or omit the column token rather than emit `undefined`.) For batches
   spanning multiple plans, the directive must tell the agent to append the marker to **each**
   plan file it completes.

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

## Dependencies

- Pairs with `stage-complete-marker-clears-working-state.md` (B-2) — they MUST share the exact
  marker label `Stage Complete` via one shared constant (emitted here, parsed there).
- Independent of the DB/UI subtasks (B-1/B-5/UI) at the code level, but the feature only
  behaves end-to-end once B-2 is also landed.

## Proposed Changes

### src/services/agentPromptBuilder.ts
- **Context:** assembles every dispatched prompt; `dispatchPrefixCore` (785) is the seam that
  reaches every role, and `buildCustomAgentPrompt` (1428) is the custom-agent path.
- **Logic:** add a `STAGE_COMPLETE_DIRECTIVE` constant (near 376-389) templated on the
  destination column; add the directive to the `dispatchPrefixCore` array (785) inside
  `buildKanbanBatchPrompt`; mirror it in `buildCustomAgentPrompt` (1428, near 1469-1470);
  export a shared `STAGE_COMPLETE_LABEL` constant for the parser. Forward
  `destinationColumn` from `_generatePromptForColumn` (KanbanProvider 4821) into the builder
  `options` so the directive can name the column.
- **Edge cases:** call sites 7120/8404 pass no destination column — directive must degrade
  gracefully (omit the column token, never emit literal `undefined`); batch dispatch must
  instruct per-file markers.

### src/services/planMetadataUtils.ts (shared constant only)
- **Context:** B-2 parses the label here.
- **Logic:** import the shared `STAGE_COMPLETE_LABEL` constant so the parser's
  `extractEmbeddedMetadata(content, STAGE_COMPLETE_LABEL)` and the emitter reference one
  string. (The `stageComplete` field + parse call are added by B-2.)

## Adversarial Synthesis

Key risks: (1) marker/parser label drift — a wording change here silently breaks the
OFF-switch in B-2; mitigation is the single shared constant. (2) `destinationColumn` is
already a parameter at the KanbanProvider layer but is NOT currently forwarded into the
builder `options` — assuming "thread it through" is trivially done risks emitting
`undefined` in the marker; mitigation is the graceful fallback for the two call sites that
pass no column. (3) custom agents (buildCustomAgentPrompt) are a separate path — omitting the
mirror means custom-agent dispatches never tell the agent to write the marker, so their
lights only ever clear on timeout.

## Verification Plan

> Per session directives: no automated tests, no compilation. Verify via the installed VSIX.

### Manual checks
- Dispatch a card to a tracked role (planner/coder/reviewer) → inspect the copied/generated
  prompt text; confirm the `**Stage Complete: <COLUMN>**` directive is present with the exact
  destination column name (not `undefined`).
- Dispatch via a custom agent → confirm the directive also appears (buildCustomAgentPrompt
  mirror).
- Confirm the label string in the directive exactly matches what B-2's parser expects (single
  shared constant — grep both files reference the same export).
- Dispatch a batch of 2+ plans → confirm the directive instructs a per-file marker, not one
  for the whole batch.

### Recommendation
Complexity 4 → **Send to Coder.**
