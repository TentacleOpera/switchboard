# Batch-to-team-head completion

**Complexity:** 7

## Goal

Complete the batch-to-team-head dispatch path: add dispatch means to the allocate prompt, show the cap before click, fix the npx/standalone host divergence, and add the 8 missing automated tests. The batch-to-team-head feature shipped with a gate that sets `featureMode = true` to reuse the feature prompt template, but the drive prefix prepend checks `p.isFeature` (not `batchOptions.featureMode`), so the lead receives a batch prompt with no team roster, API port, or ptySendPrompt recipe. The cap is enforced backend-only with no pre-click disclosure, and the standalone/npx host uses a completely separate prompt builder that never got the batch logic. These four subtasks close all three gaps plus the test debt.

## How the Subtasks Achieve This

- **Batch-to-team-head allocate prompt lacks dispatch means (roster, API port, pty recipe)**: Fixes the gate at KanbanProvider.ts:6394 to route batch-to-team-head dispatches through a new `_buildBatchDrivePrefix` method, which prepends the team roster, API port, ptySendPrompt recipe, and per-plan completion POST instructions. Extracts a shared `_resolveRosterAndPort` helper to avoid duplicating roster/port resolution between the feature and batch prefix builders.
- **Batch-to-team-head cap disclosed only after click — no pre-click "SEND N OF 12" label**: Adds `teamHeadColumns` and `teamBatchPlanCap` to the `updateBoard` payload so the webview can render a "SEND N OF M" label on the Move All and Move Selected buttons when a team-head column exceeds the cap. The label is advisory — the backend remains the safety net.
- **Batch allocate prompt exists only in VS Code extension host — npx/standalone host diverges**: Replaces the standalone host's minimal `buildPromptForCards` with a call to `generateUnifiedPrompt`, with a fallback on throw or empty-string return. This routes the standalone host through the same batch/team-head/cap logic as the extension host, closing the divergence.
- **Eight of fifteen batch-to-team-head automated tests still absent**: Adds 8 missing tests to `batch-move-team-prompt-contract.test.js` covering feature-row absence, end-to-end cap/remainder, pre-click count, role routing, planner fan-out, and schedule schema. Extracts `applyBatchCap` as a pure function to make the cap logic testable without mocking `TaskViewerProvider`.

## Dependencies & sequencing

- **Subtask 1 (dispatch means) must land first.** It fixes the gate at line 6394 and adds `_buildBatchDrivePrefix`. Subtask 3 routes the standalone host through `generateUnifiedPrompt`, which contains this gate fix — without subtask 1, the standalone host gets the same broken prompt.
- **Subtask 2 (cap label) lands second.** No code dependency on subtask 1, but both touch `KanbanProvider.ts` (different methods). Landing after subtask 1 avoids merge conflicts.
- **Subtask 3 (npx divergence) lands third.** Depends on subtask 1's gate fix — the standalone host calls `generateUnifiedPrompt` which must already have the batch drive prefix gate.
- **Subtask 4 (missing tests) lands last.** Tests the behavior established by subtasks 1–3. Landing it first would produce failing tests. Also extracts `applyBatchCap` (a small production refactor in `KanbanProvider.ts` or `agentPromptBuilder.ts`).
- **Prerequisite:** A team-headed lead must be configured (team wiring in `terminals.groups` DB config) for the batch-to-team-head path to activate. Without it, `isCodingTeamHead` returns false and the gate never fires.

## Team Dispatch Instructions

### Batch-to-team-head allocate prompt lacks dispatch means (roster, API port, pty recipe)
- **Seat:** Coder (complexity 6)
- **Acceptance:**
  - `generateUnifiedPrompt` with `role='lead'`, `batchMode=true`, and a team-headed lead returns a prompt containing `YOUR TEAM:`, `API:`, `ptySendPrompt`, and `/kanban/task/complete`
  - The batch drive prefix does NOT contain `FEATURE FILE:` or `single delivery unit`
  - The batch drive prefix DOES contain `Read each individual plan file`
  - A non-team lead batch does NOT prepend a drive prefix
  - `_resolveRosterAndPort` returns identical results to the original inline code in `_buildDrivePrefix` (refactor preserves behavior)
- **Must not touch:** `_buildFeatureDirectivePrefix`, `buildKanbanBatchPrompt`, the feature dispatch path (only the batch gate and prefix builder are in scope)

### Batch-to-team-head cap disclosed only after click — no pre-click "SEND N OF 12" label
- **Seat:** Coder (complexity 6)
- **Acceptance:**
  - `updateBoard` payload contains `teamHeadColumns` array and `teamBatchPlanCap` number when a team-headed lead is configured
  - Move All button on a team-head column with >5 plans shows a `<span class="cap-label">` with text matching `SEND \d+ OF \d+`
  - Move Selected button on a team-head column with >5 selected plans shows the cap label
  - Non-team-head columns show no cap label (icon-only button)
  - `teamBatchPlanCap` in the payload equals the exported `TEAM_BATCH_PLAN_CAP` constant (not hardcoded)
- **Must not touch:** `generateUnifiedPrompt`, the batch prompt builder, the gate at line 6394 (only the board state payload and webview rendering are in scope)

### Batch allocate prompt exists only in VS Code extension host — npx/standalone host diverges
- **Seat:** Lead Coder (complexity 7)
- **Acceptance:**
  - Standalone host dispatch for `role='lead'` with >1 loose plans and a team-headed lead produces a prompt containing `YOUR TEAM:` and `BATCH MODE`
  - Standalone host dispatch for `role='coder'` with 1 plan produces a prompt containing the plan content and `FOCUS_DIRECTIVE`
  - When `generateUnifiedPrompt` returns `''`, the fallback to `buildPromptForCards` fires and the prompt is non-empty
  - Existing standalone dispatch tests still pass
- **Must not touch:** `generateUnifiedPrompt` itself, `buildKanbanBatchPrompt`, the gate at line 6394 (only the standalone dispatch handler's call site is in scope)

### Eight of fifteen batch-to-team-head automated tests still absent
- **Seat:** Coder (complexity 5)
- **Acceptance:**
  - `npm run test:contract:batch-move-team-prompt` passes with all 15 tests (7 existing + 8 new)
  - `applyBatchCap(12 plans, 5, true)` returns `{ sent: 5, skipped: 7 }`
  - `applyBatchCap(12 plans, 5, false)` returns `{ sent: 12, skipped: 0 }`
  - Batch prompt does NOT contain `FEATURE FILE:` (no feature row created)
  - Schedule rule schema does NOT admit a `batchSize` field
- **Must not touch:** `generateUnifiedPrompt`, `buildKanbanBatchPrompt`, the webview, the standalone host (only the test file and the `applyBatchCap` extraction are in scope)

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Batch-to-team-head allocate prompt lacks dispatch means (roster, API port, pty recipe)](../plans/feature_plan_20260827144006_batch-to-team-head-lacks-dispatch-means.md) — **PLAN REVIEWED** — ID: ac107ef4-82ff-487b-85f6-81fce0f7adc8
- [ ] [Batch-to-team-head cap disclosed only after click — no pre-click "SEND N OF 12" label](../plans/feature_plan_20260827144007_batch-cap-not-shown-before-click.md) — **PLAN REVIEWED** — ID: 6458af6f-74fe-4b9b-a78b-e8472ee95057
- [ ] [Batch allocate prompt exists only in VS Code extension host — npx/standalone host diverges](../plans/feature_plan_20260827144008_batch-allocate-prompt-extension-only-npx-divergence.md) — **PLAN REVIEWED** — ID: 8fa93e14-cb6b-4c4a-b556-91a3c2fe3a55
- [ ] [Eight of fifteen batch-to-team-head automated tests still absent](../plans/feature_plan_20260827144009_missing-batch-to-team-head-automated-tests.md) — **PLAN REVIEWED** — ID: 2aed6757-6cd4-4f37-abe2-9582d3dafa19
<!-- END SUBTASKS -->

