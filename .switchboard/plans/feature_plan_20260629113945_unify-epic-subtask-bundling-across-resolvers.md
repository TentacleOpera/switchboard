# Unify Epic Subtask Bundling Across Both Plan Resolvers

## Goal

Make epic subtask bundling behave identically on **both** prompt paths — Copy Prompt (board) and CLI dispatch (terminal) — by extracting the subtask-expansion logic into a single shared helper consumed by both resolvers. Today only the copy path bundles; a CLI-dispatched epic silently drops every subtask.

### Problem

There are two plan-resolver functions that build the `plans[]` array fed to the unified prompt builder, and only one of them bundles epic subtasks:

- **Copy / board path** — `promptSelected` → `_generatePromptForColumn` (`src/services/KanbanProvider.ts:3896`) → `_generatePromptForDestinationRole` (3966) → `_cardsToPromptPlans` (2469), which fetches + appends subtasks (`getSubtasksByEpicId`, block at 2526-2554) → `generateUnifiedPrompt` (3998). **Bundles. ✓** (Empirically confirmed: Copy Prompt on an epic yields `EPIC MODE` + the `[SUBTASK]` list.)
- **CLI-dispatch / terminal path** — `_dispatchConfiguredKanbanColumnPrompt` / `copyMergePrompt` / batch trigger → `_resolveKanbanDispatchPlans` (`src/services/TaskViewerProvider.ts:2902-2979`) → `generateUnifiedPrompt`. This resolver builds the array from the card's own plan file only; for an epic it copies `epicId` (line 2950) but **never** calls `getSubtasksByEpicId` (verified: that method is referenced nowhere in `TaskViewerProvider.ts`). **Does not bundle. ✗**

### Root Cause

`generateUnifiedPrompt` (`KanbanProvider.ts:2906`) detects epic mode via `plans.some(p => p.isSubtask)` (line 3064). Since the CLI resolver never places subtasks in the array, epic mode never fires for a CLI-dispatched epic.

The divergence is historical: `_resolveKanbanDispatchPlans` was created 2026-05-30 (`7ca965d`). The **"Unified Prompt Building Architecture"** commit (`0fe71f6`, 2026-05-31) unified the *prompt builder* (`generateUnifiedPrompt`) — both resolvers were pointed at it — but it did **not** merge the two resolvers. When the epic/subtask system landed (`827a9a5`, 2026-06-09) and bundling was refined through late June (last `957df2a`, 2026-06-27), subtask-expansion was added **only to `_cardsToPromptPlans`**. So the builder is unified; the resolver layer is not, and epic bundling lives in only one of the two resolvers.

### Background

Both resolvers funnel into `generateUnifiedPrompt`, which renders the EPIC MODE directive (`agentPromptBuilder.ts`) whenever the array contains subtasks. The expansion block (`KanbanProvider.ts:2526-2554`) is a self-contained DB query: it reads `epic_max_subtasks` (default 20), fetches via `getSubtasksByEpicId`, emits the epic entry + `[SUBTASK]`-labeled subtask entries, and appends an overflow-warning card when subtasks exceed the cap.

## Metadata
- **Tags**: backend, refactor, bugfix, reliability
- **Complexity**: 5/10

## User Review Required
None. This closes a pre-existing asymmetry; the canonical bundling logic remains the existing, tested copy-path block — only its call site is shared.

## Complexity Audit

### Routine
- Extracting an existing inline code block into a method (mechanical refactor).
- Calling the new method from a second site that already has a `KanbanProvider` reference (`_kanbanProvider` field, line 350).
- No new UI, no new DB schema, no new message protocol.

### Complex / Risky
- **Worktree path resolution divergence**: The copy-path block resolves subtask worktree paths via a private `worktreePathMap` built inside `_cardsToPromptPlans`. The CLI resolver does not have this map. The shared helper must either accept the map as a parameter or resolve worktree paths internally via `TaskViewerProvider.resolveWorktreePathForPlan` (already called in the CLI path at line 2953). This is the one non-trivial design decision.
- **Cross-provider call ordering**: `_resolveKanbanDispatchPlans` runs before `generateUnifiedPrompt` is called by its callers (lines 3006, 3379, 3410). The subtask expansion must happen inside `_resolveKanbanDispatchPlans` (or between it and the `generateUnifiedPrompt` call), requiring access to the DB — which the method already obtains via `this._getKanbanDb(workspaceRoot)`.

## Edge-Case & Dependency Audit

**Race Conditions:**
- Subtasks could be added/removed between the time `_resolveKanbanDispatchPlans` reads the plan record and when it calls `getSubtasksByEpicId`. This is the same window the copy path already has — no new risk.

**Security:**
- No new attack surface. The helper reads plan files already accessible to the caller.

**Side Effects:**
- The shared helper must not mutate the input `promptPlans` array in place if called from the CLI path (which builds a fresh array). The copy path pushes into an existing array. Design the helper to **return** a new array of subtask plans that the caller appends, rather than mutating.

**Dependencies & Conflicts:**
- Lands **before** "Remove the Epic Orchestrator Role…" — that plan deletes `buildEpicOrchestrationPrompt` (3112-3160), which contains a near-duplicate expansion block (3124-3156). The shared helper here becomes the surviving canonical copy.
- Co-edits `generateUnifiedPrompt` indirectly (no direct edit, but the plans array it receives changes shape on the CLI path). No conflict with Plan 2 or Plan 3's direct edits to that function.

## Dependencies

- Epic: **"Replace Epic Orchestrator with Lead-Coder Dispatch and Workflow Buttons"**
- Sibling: *"Remove the Epic Orchestrator Role, ORCHESTRATING Column, and Orchestrate Buttons"* — depends on this plan landing first (shared helper is the canonical copy).
- Sibling: *"Sticky Epic Workflow Toggle Buttons"* — independent; both feed into `generateUnifiedPrompt` but on different axes (array content vs. prefix string).

## Adversarial Synthesis

Key risks: (1) worktree-path resolution diverges between the two call sites because the copy path uses a private `worktreePathMap` the CLI path lacks — the helper must resolve worktrees independently. (2) The helper must return rather than mutate arrays to avoid side-effect bugs when called from both contexts. Mitigations: accept an optional `worktreePathMap` parameter (copy path) and fall back to `resolveWorktreePathForPlan` (CLI path); design as a pure function returning `BatchPromptPlan[]`.

## Proposed Changes

### `src/services/KanbanProvider.ts`
- **Context**: The subtask-expansion block at lines 2526-2554 inside `_cardsToPromptPlans` is the canonical bundling logic. It must be extracted into a reusable method.
- **Logic**: Create `public async expandEpicSubtaskPlans(workspaceRoot: string, epicPlanId: string, epicTopic: string, epicColumn: string, worktreePath?: string, worktreePathMap?: Map<string, string>): Promise<BatchPromptPlan[]>`. The method reads `epic_max_subtasks` from DB, calls `getSubtasksByEpicId`, slices to cap, emits `[SUBTASK]` entries, and appends overflow warning. For each subtask, resolve `worktreePath` via `worktreePathMap?.get(String(st.epicId))` if the map is provided (copy path), otherwise fall back to the passed `worktreePath` or call `TaskViewerProvider.resolveWorktreePathForPlan` (CLI path).
- **Implementation**: Replace the inline block at 2526-2554 with a call to the new method. The epic entry itself (the non-subtask plan) is already pushed by `_cardsToPromptPlans` before this block — keep that push in place and only extract the subtask-expansion portion.
- **Edge Cases**: Epic with zero subtasks → helper returns empty array, no change in behavior. Subtasks exceeding cap → overflow warning card emitted (same as current).

### `src/services/TaskViewerProvider.ts`
- **Context**: `_resolveKanbanDispatchPlans` (2902-2979) builds the plans array from the card's plan file only. It has access to `_kanbanProvider` (line 350) and obtains the DB via `this._getKanbanDb(workspaceRoot)`.
- **Logic**: After resolving a plan whose DB record has `isEpic === true` (check `plan.isEpic` from the `getPlanBySessionId` result), call `this._kanbanProvider.expandEpicSubtaskPlans(workspaceRoot, sid, topic, plan.kanbanColumn, worktreePath)` and append the returned subtask plans to `validPlans`. Set `isSubtask: true` is already handled by the helper.
- **Implementation**: Add the epic-detection check after line 2950 (where `epicId` is copied). If `plan.isEpic`, call the helper and `validPlans.push(...subtaskPlans)`. The `BatchPromptPlan` type (defined in `agentPromptBuilder.ts:28-38`) already supports `isSubtask`, `epicTopic`, `epicId`.
- **Edge Cases**: If `_kanbanProvider` is undefined (not yet set), skip expansion with a console warning — same defensive pattern used at other cross-provider call sites. If the DB is unavailable, skip (already guarded by `if (db)` block).

## Verification Plan

### Automated Tests
- Test that CLI dispatch on an epic produces a prompt containing `EPIC MODE` and `[SUBTASK]` entries (parity with copy path).
- Test that the subtask cap (`epic_max_subtasks`) is respected on both paths.
- Test epic with zero subtasks — no crash, no spurious entries.
- Test overflow warning card appears when subtasks exceed cap on CLI path.

> **Note**: Per session directives, automated tests are not run during this planning session. The user will run the test suite separately.

## Epic / Dependencies

Subtask of epic **"Replace Epic Orchestrator with Lead-Coder Dispatch and Workflow Buttons."** Recommended to land **before** *"Remove the Epic Orchestrator Role, ORCHESTRATING Column, and Orchestrate Buttons"* — that plan deletes `buildEpicOrchestrationPrompt`, which contains a near-duplicate of this expansion logic (3124-3156); the shared helper here is the surviving canonical copy.

**Recommendation: Complexity 5/10 → Send to Coder**
