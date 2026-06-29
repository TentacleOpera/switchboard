# Unify Epic Subtask Bundling Across Both Plan Resolvers

## Goal

Make epic subtask bundling behave identically on **both** prompt paths — Copy Prompt (board) and CLI dispatch (terminal) — by extracting the subtask-expansion logic into a single shared helper consumed by both resolvers. Today only the copy path bundles; a CLI-dispatched epic silently drops every subtask.

### Problem

There are two plan-resolver functions that build the `plans[]` array fed to the unified prompt builder, and only one of them bundles epic subtasks:

- **Copy / board path** — `promptSelected` → `_generatePromptForColumn` (`src/services/KanbanProvider.ts:3896`) → `_generatePromptForDestinationRole` (3966) → `_cardsToPromptPlans` (2469), which fetches + appends subtasks (`getSubtasksByEpicId`, block at 2526-2555) → `generateUnifiedPrompt` (3998). **Bundles. ✓** (Empirically confirmed: Copy Prompt on an epic yields `EPIC MODE` + the `[SUBTASK]` list.)
- **CLI-dispatch / terminal path** — `_dispatchConfiguredKanbanColumnPrompt` / `copyMergePrompt` / batch trigger → `_resolveKanbanDispatchPlans` (`src/services/TaskViewerProvider.ts:2902-2979`) → `generateUnifiedPrompt`. This resolver builds the array from the card's own plan file only; for an epic it copies `epicId` (line 2971) but **never** calls `getSubtasksByEpicId` (verified: that method is referenced nowhere in `TaskViewerProvider.ts`). **Does not bundle. ✗**

### Root Cause

`generateUnifiedPrompt` (`KanbanProvider.ts:3064`) detects epic mode via `plans.some(p => p.isSubtask)`. Since the CLI resolver never places subtasks in the array, epic mode never fires for a CLI-dispatched epic.

The divergence is historical: `_resolveKanbanDispatchPlans` was created 2026-05-30 (`7ca965d`). The **"Unified Prompt Building Architecture"** commit (`0fe71f6`, 2026-05-31) unified the *prompt builder* (`generateUnifiedPrompt`) — both resolvers were pointed at it — but it did **not** merge the two resolvers. When the epic/subtask system landed (`827a9a5`, 2026-06-09) and bundling was refined through late June (last `957df2a`, 2026-06-27), subtask-expansion was added **only to `_cardsToPromptPlans`**. So the builder is unified; the resolver layer is not, and epic bundling lives in only one of the two resolvers.

### Background

Both resolvers funnel into `generateUnifiedPrompt`, which renders the EPIC MODE directive (`agentPromptBuilder.ts`) whenever the array contains subtasks. The expansion block (`KanbanProvider.ts:2526-2555`) is a self-contained DB query: it reads `epic_max_subtasks` (default 20), fetches via `getSubtasksByEpicId`, emits the epic entry + `[SUBTASK]`-labeled subtask entries, and appends an overflow-warning card when subtasks exceed the cap.

## Metadata
- **Tags**: backend, refactor, bugfix, reliability
- **Complexity**: 5/10

## Implementation

1. **Extract a shared subtask-expansion helper.** Lift the block at `KanbanProvider.ts:2526-2555` into a single method, e.g. `public async expandEpicSubtaskPlans(workspaceRoot, epicPlanId, epicTopic, worktreePath?): Promise<BatchPromptPlan[]>`. Have `_cardsToPromptPlans` call it (replacing its inline block) so copy-path behavior is unchanged.
2. **Call the shared helper from the CLI-dispatch resolver.** In `_resolveKanbanDispatchPlans` (`TaskViewerProvider.ts:2902-2979`), after resolving a plan whose record `isEpic === true`, append the helper's subtask plans to the returned array, via the existing `KanbanProvider` reference (cross-provider calls already exist here).
3. **EPIC MODE renders automatically.** With subtasks present on both paths, `generateUnifiedPrompt` (3064-3094) + the EPIC MODE directive produce the bundled prompt for the lead-coder role. No prompt-template body work required.
4. **Verify parity.** Copy Prompt and CLI dispatch on the same epic now produce equivalent bundled `plans[]` (same subtasks, same cap, same overflow warning).

## User Review Required
None. This closes a pre-existing asymmetry; the canonical bundling logic remains the existing, tested copy-path block — only its call site is shared.

## Epic / Dependencies

Subtask of epic **"Replace Epic Orchestrator with Lead-Coder Dispatch and Workflow Buttons."** Recommended to land **before** *"Remove the Epic Orchestrator Role, ORCHESTRATING Column, and Orchestrate Buttons"* — that plan deletes `buildEpicOrchestrationPrompt`, which contains a near-duplicate of this expansion logic (3126-3156); the shared helper here is the surviving canonical copy.
