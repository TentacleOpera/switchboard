# Make the ORCHESTRATING Column Appear When an Epic Is Orchestrated

## Goal

When the user orchestrates an epic from the kanban/epics UI, the epic must visibly surface in the **ORCHESTRATING** column on the board. Today nothing appears — a critical UAT failure. Ensure orchestrating an epic (via the default **copy** action as well as **send**) moves the epic into ORCHESTRATING so the column becomes visible.

### Problem Analysis & Root Cause

There is **no per-card "Orchestrate" button on kanban-board cards** by design — board epic cards render only EPIC badge / worktree chip / review / complete (`kanban.html` `createCardHtml`, `5311-5347`). What is supposed to "become visible on the board" is the **ORCHESTRATING column** itself.

The ORCHESTRATING column is defined `epicOnly: true` and `hideWhenNoAgent: true` (`agentConfig.ts:117`). `_filterDynamicColumns` (`KanbanProvider.ts:2411`) shows an `epicOnly` column **only when a card occupies it**:

```js
if (col.epicOnly) return occupiedColumns.has(col.id);
```

Nothing ever lands a card in ORCHESTRATING:
- It is excluded as a drag/drop and integration target (`KanbanProvider.ts:4144-4153`).
- `_getNextColumnId` explicitly skips `epicOnly` columns (`3837-3839`), so pipeline advancement never reaches it.
- In committed HEAD, `dispatchEpicOrchestration` only built/dispatched the prompt and never set the epic's column.

So `occupiedColumns` never contained `ORCHESTRATING` → the column was permanently invisible. That is the reported failure.

**In-progress fix already in the working tree** (`KanbanProvider.ts`, `dispatchEpicOrchestration`, ~`3160-3182`) adds the correct mechanism — a teleport into ORCHESTRATING after dispatch:

```js
const db = this._getKanbanDb(workspaceRoot);
if (db && await db.ensureReady()) {
    const epic = await db.getPlanByPlanId(epicSessionId);
    if (epic && epic.isEpic) {
        if (epic.sessionId) {
            await this.moveCardToColumn(workspaceRoot, epic.sessionId, 'ORCHESTRATING');
        } else if (epic.planFile) {
            await this.moveCardToColumnByPlanFile(workspaceRoot, epic.planFile, 'ORCHESTRATING');
        }
        await this._refreshBoard(workspaceRoot);
    }
}
```

**The remaining defect:** that teleport runs **only in `'send'` mode**. The dispatch handler `case 'orchestrateEpic'` in `PlanningPanelProvider.ts:2877-2913` routes `mode === 'send'` → `dispatchEpicOrchestration` (has the teleport, line `2890`), but `mode === 'copy'`/`'preview'` (the **default**) → `buildEpicOrchestrationPrompt` (line `2898`, **no teleport**). The Epics-tab Orchestrate buttons default to `'copy'`:
- Meta-bar **Orchestrate** → `requestEpicOrchestration('copy')` (`project.js:1647`).
- Only the overlay's **"Send to Orchestrator"** uses `'send'` (`project.js:1804`).

So a user who clicks **Orchestrate** and copies the prompt **never** sees the column. The fix is to also teleport on `'copy'` (but not on `'preview'`, which must stay side-effect-free).

**Critical interdependency:** even after teleporting, the column appears only if the epic survives the active board **project filter** — `_filterDynamicColumns` derives `occupiedColumns` from the project-filtered `cards`. The same working-tree diff fixes `createEpic` (`KanbanProvider.ts:~7794-7858`) to inherit `project`/`projectId` from subtasks; without it a multi-plan-created epic has `project=''`/`projectId=NULL`, is filtered off any project board, and can never occupy ORCHESTRATING there. Both fixes are required together.

## Metadata

- **Tags:** `bugfix`, `ui`, `ux`
- **Complexity:** 5/10
- **Primary files:** `src/services/PlanningPanelProvider.ts`, `src/services/KanbanProvider.ts`; supporting: `src/services/agentConfig.ts`, `src/webview/project.js`

## User Review Required

Yes — before implementation, confirm:
1. **Subtask cascade UX:** When an epic teleports into ORCHESTRATING, `moveCardToColumn` cascades all subtasks with it (the "rigid unit" model via `updateColumnWithEpicCascade`, `KanbanProvider.ts:4795`). Confirm this is the intended UX — subtasks follow the epic into ORCHESTRATING and are no longer shown in their prior columns.
2. **Re-orchestration idempotency:** If a user clicks Orchestrate on an epic already in ORCHESTRATING, the plan short-circuits the move (no-op) to avoid re-firing integration syncs. Confirm this no-op-on-already-orchestrating behavior is desired.
3. **Backfill of legacy epics:** Epics created before the `createEpic` project-inheritance fix may have `project=''` and remain invisible on project-filtered boards even after this fix. A backfill is out of scope. Confirm this is acceptable.

## Complexity Audit

### Routine
- Extracting `markEpicOrchestrating` from the existing inline teleport in `dispatchEpicOrchestration` — pure refactor of already-working code into a reusable public method.
- Adding one `await this._kanbanProvider.markEpicOrchestrating(wsRoot, sessionId)` call in the copy branch of `case 'orchestrateEpic'` (`PlanningPanelProvider.ts:~2904`).
- The `createEpic` project/projectId inheritance and the send-path teleport are already in the working tree — no new work, just preserved.

### Complex / Risky
- **Idempotency / integration-sync spam:** `moveCardToColumn` unconditionally fires `queueIntegrationSyncForSession` (line 4800) after a successful `updateColumnWithEpicCascade`. Re-orchestrating an epic already in ORCHESTRATING would re-sync a no-op status change to Linear/ClickUp. Requires a short-circuit guard (skip the move when the epic is already in ORCHESTRATING).
- **Project-filter coupling:** the `createEpic` project/projectId inheritance (working-tree, `~7794-7858`) is mandatory for project-filtered boards. An incomplete fix appears to work on the default (unfiltered) board but fails on a project-filtered board — a false-positive UAT pass.
- **Cross-plan conflict surface:** a sibling plan (`slim-orchestrator-prompt-addons-epic-link`) modifies `buildEpicOrchestrationPrompt` (adds a defensive `_regenerateEpicFile` call and rewrites the prompt body). This plan refactors `dispatchEpicOrchestration`, which calls `buildEpicOrchestrationPrompt`. Both are compatible but touch the same functions — merge order must be coordinated.

## Edge-Case & Dependency Audit

- **Mode gating:** teleport on `'send'` and `'copy'`; **never** on `'preview'` (preview must not mutate state). Implement via a shared helper `KanbanProvider.markEpicOrchestrating(wsRoot, sessionId)` invoked from the copy branch after the prompt is built (`PlanningPanelProvider.ts:~2904`). Note: `'preview'` mode is currently **unreachable from the UI** — no button in `project.js` calls `requestEpicOrchestration('preview')` (only `'copy'` at 1647/1803 and `'send'` at 1804). The preview guard is retained as defense-in-depth for any future programmatic caller, but it is not a live UX risk today.
- **Epic guard:** `moveCardToColumn`/`moveCardToColumnByPlanFile` reject ORCHESTRATING for non-epics (`KanbanProvider.ts:4787, 4833`). The teleport always resolves an epic first, so this is satisfied.
- **Subtask cascade:** `moveCardToColumn` cascades subtasks (`updateColumnWithEpicCascade`, `4795`), so the epic's subtasks follow it into ORCHESTRATING (the "rigid unit" model). Confirm this is the intended UX (subtasks teleport with the epic).
- **No auto-advance out:** `_getNextColumnId` skips `epicOnly` (`3837`), so once in ORCHESTRATING the epic won't auto-advance — intended.
- **Project filter coupling:** the `createEpic` project/projectId inheritance (working-tree diff, `~7794-7858`) is mandatory for project-filtered boards. `promoteToEpic` already carries the plan's project, so it is unaffected.
- **Migration:** no schema change — ORCHESTRATING already exists in `agentConfig.ts`. Epics created before this fix with `project=''` may still be filtered off a project board; this fix corrects newly created epics. (A backfill is out of scope; noted in User Review Required.)
- **Refresh ownership:** after refactor, `_refreshBoard` is called exclusively inside `markEpicOrchestrating`. Callers (`dispatchEpicOrchestration` send path, copy branch) must NOT also call `_refreshBoard` — the helper owns the single refresh.
- **Error visibility:** `markEpicOrchestrating` must log a `console.warn` on failure (db not ready, move failed, epic not found) so a silent teleport failure is diagnosable. The existing `dispatchEpicOrchestration` warn ("teleport failed — prompt was still dispatched") must be preserved through the refactor.

## Dependencies

- `slim-orchestrator-prompt-addons-epic-link` (plan file `feature_plan_20260625120812_slim-orchestrator-prompt-addons-epic-link.md`) — modifies `buildEpicOrchestrationPrompt` (defensive `_regenerateEpicFile` + prompt body rewrite). This plan refactors `dispatchEpicOrchestration` which calls that function. Compatible but coordinate merge order; if both land, the `_regenerateEpicFile` call runs before `markEpicOrchestrating` — correct ordering (doc regenerated, then board teleported).

## Adversarial Synthesis

Key risks: (1) silent teleport failure — the refactored helper must preserve the existing `console.warn` or the column stays invisibly broken with no diagnostic; (2) integration-sync spam on re-orchestration of an already-orchestrating epic — requires an idempotency short-circuit before `moveCardToColumn`; (3) false-positive UAT pass on the unfiltered board that masks the project-filter coupling. Mitigations: add failure logging + an "already in ORCHESTRATING" guard inside `markEpicOrchestrating`, and always UAT on a project-filtered board.

## Proposed Changes

### `src/services/KanbanProvider.ts`

1. **[ALREADY IN WORKING TREE — preserve]** The teleport at the end of `dispatchEpicOrchestration` (`~3160-3182`).
2. **[ALREADY IN WORKING TREE — preserve]** The `createEpic` project/projectId inheritance (`~7794-7858`):
```js
const epicProject = subtasks.find(st => st.project)?.project || '';
const epicProjectId = subtasks.find(st => st.projectId != null)?.projectId ?? null;
// ... upsertPlan({ ..., project: epicProject, projectId: epicProjectId })
```
3. **[NEW WORK]** Add a reusable `markEpicOrchestrating` helper that consolidates the teleport, adds an idempotency short-circuit, and logs on failure:
```js
async markEpicOrchestrating(workspaceRoot: string, epicSessionId: string): Promise<void> {
    const db = this._getKanbanDb(workspaceRoot);
    if (!db || !(await db.ensureReady())) {
        console.warn(`[KanbanProvider] markEpicOrchestrating: db not ready for ${epicSessionId}`);
        return;
    }
    const epic = await db.getPlanByPlanId(epicSessionId);
    if (!epic || !epic.isEpic) {
        console.warn(`[KanbanProvider] markEpicOrchestrating: no epic found for ${epicSessionId}`);
        return;
    }
    // Idempotency: skip the move (and the integration sync it would fire) if the
    // epic is already in ORCHESTRATING. Prevents re-syncing a no-op status change
    // to Linear/ClickUp when the user re-orchestrates an already-orchestrating epic.
    const currentColumn = this._normalizeLegacyKanbanColumn(epic.kanbanColumn) || '';
    if (currentColumn === 'ORCHESTRATING') {
        return; // already there — no move, no sync, no refresh needed
    }
    try {
        let moved = false;
        if (epic.sessionId) {
            moved = await this.moveCardToColumn(workspaceRoot, epic.sessionId, 'ORCHESTRATING');
        } else if (epic.planFile) {
            moved = await this.moveCardToColumnByPlanFile(workspaceRoot, epic.planFile, 'ORCHESTRATING');
        }
        if (!moved) {
            console.warn(`[KanbanProvider] markEpicOrchestrating: move to ORCHESTRATING returned false for ${epicSessionId}`);
        }
        await this._refreshBoard(workspaceRoot);
    } catch (err) {
        console.warn(`[KanbanProvider] markEpicOrchestrating: teleport to ORCHESTRATING failed for ${epicSessionId}: ${err}`);
    }
}
```
4. **[NEW WORK — refactor]** Replace the inline teleport block in `dispatchEpicOrchestration` (`~3167-3182`) with a single call to the helper, preserving the equivalent error semantics:
```js
try {
    await this.markEpicOrchestrating(workspaceRoot, epicSessionId);
} catch (err) {
    console.warn(`[KanbanProvider] dispatchEpicOrchestration: teleport to ORCHESTRATING failed (prompt was still dispatched): ${err}`);
}
```
(The helper owns `_refreshBoard`; do NOT also refresh in `dispatchEpicOrchestration`.)

### `src/services/PlanningPanelProvider.ts`

In `case 'orchestrateEpic'` (`2877-2913`), occupy the column for `'copy'` as well as `'send'`, but not for `'preview'`. After the copy branch writes to the clipboard (`~2904`):

```js
if (mode === 'copy') {
    await vscode.env.clipboard.writeText(assembled.prompt);
    await this._kanbanProvider.markEpicOrchestrating(wsRoot, sessionId);
}
```
(`'send'` continues through `dispatchEpicOrchestration`, which now also calls `markEpicOrchestrating`. `'preview'` does neither — and is currently UI-unreachable, retained as defense-in-depth.)

## Verification Plan

### Automated Tests
Per session directives, automated tests (unit, integration, e2e) are NOT run in this session — the user runs the suite separately. No new test files are authored as part of this plan.

### Manual Verification
1. Build/install the VSIX.
2. **Default (copy) path:** create an epic (multi-plan creation, so it has subtasks). From the Epics tab meta bar, click **Orchestrate** (default copy mode). Confirm the prompt is copied AND the epic now appears in the **ORCHESTRATING** column on the board, which becomes visible.
3. **Send path:** use the overlay's **"Send to Orchestrator"** and confirm the epic also lands in ORCHESTRATING and the column is visible.
4. **Preview path:** trigger preview mode (programmatically, since no UI button currently exposes it) and confirm board state is **unchanged** (no teleport).
5. **Project-filtered board:** with a project filter active, orchestrate a multi-plan-created epic and confirm it appears in ORCHESTRATING on that filtered board (validates the `createEpic` project/projectId inheritance).
6. **Subtask cascade:** confirm the epic's subtasks move into ORCHESTRATING with it (rigid-unit model) and the board renders consistently.
7. **Empty column hides again:** move the epic out of ORCHESTRATING and confirm the column disappears (epicOnly + hideWhenNoAgent still honored).
8. **Re-orchestration idempotency:** with an epic already in ORCHESTRATING, click Orchestrate again. Confirm no integration sync is re-fired (check Linear/ClickUp task history for duplicate status events) and no board flicker occurs.
9. **Failure visibility:** temporarily break the DB connection (or orchestrate a non-existent epic ID) and confirm a `console.warn` appears in the extension host output — the silent-failure regression is prevented.

## Recommendation

Complexity is 5 (mixed: mostly routine refactor + one well-scoped idempotency guard). **Send to Coder.**

---

## Reviewer Pass — 2026-06-26 (post-implementation, in-place)

**Verdict: APPROVED. Implementation is faithful to the plan and correct. No code changes required.**

### What was verified in code

| Plan requirement | Location | Status |
| :--- | :--- | :--- |
| `markEpicOrchestrating` helper (idempotency short-circuit + failure logging) | `KanbanProvider.ts:3176-3208` | ✅ Matches plan verbatim |
| `dispatchEpicOrchestration` refactored to call helper, try/catch preserved | `KanbanProvider.ts:3164-3168` | ✅ Inline teleport removed; helper owns the single `_refreshBoard` |
| Copy-branch teleport (`'copy'` writes clipboard then `markEpicOrchestrating`) | `PlanningPanelProvider.ts:2903-2906` | ✅ Matches plan |
| `'preview'` does neither (no clipboard, no teleport) | `PlanningPanelProvider.ts:2897-2907` | ✅ Else-branch builds prompt only; teleport gated on `mode === 'copy'` |
| `createEpic` project/projectId inheritance | `KanbanProvider.ts:7850-7851, 7894, 7907` | ✅ Present |
| Refresh ownership (no double-refresh from callers) | `KanbanProvider.ts` | ✅ Only `markEpicOrchestrating` calls `_refreshBoard`; `dispatchEpicOrchestration` does not |

### Supporting facts independently confirmed
- `moveCardToColumn`/`moveCardToColumnByPlanFile` both return `Promise<boolean>` (`4800`, `4847`) — the `if (!moved)` warn is sound, not a spurious-warn-on-void.
- `_normalizeLegacyKanbanColumn('ORCHESTRATING')` returns `'ORCHESTRATING'` unchanged (`1989-1992`, only remaps `CODED→LEAD CODED`) — the idempotency guard compares correctly.
- `_filterDynamicColumns` (`2410-2411`): `epicOnly` columns show iff `occupiedColumns.has(col.id)`; ORCHESTRATING is `epicOnly: true, hideWhenNoAgent: true` (`agentConfig.ts:117`). Teleporting the epic's `kanbanColumn` to ORCHESTRATING makes the (project-filtered) card occupy it → column appears. Mechanism is correct end-to-end.
- The board's "Copy Planning Prompt" button posts `copyEpicPlannerPrompt` (`project.js:1609`), a distinct planning action — correctly NOT an orchestrate path. The only two orchestration entry points are `requestEpicOrchestration('copy')` and `('send')`, both routed correctly.

### Resolution concern investigated and dissolved (was a candidate CRITICAL)
The teleport resolves the epic via `db.getPlanByPlanId(epicSessionId)` (`plan_id = ?` only), but the webview sends `_epicSelectedPlan.sessionId || planId` (`project.js:1799`) and `createEpic` writes **distinct** plan_id/session_id UUIDs (`7865-7866`). On its face this looked like it could return `null` for multi-plan-created epics. Investigation against the live `kanban.db`:
- All 4 epics — including `286f9939`, which has a `createEpic`-style filename `...-epic-286f9939-...md` (5 subtasks) — have `session_id == plan_id`.
- Cause: `createEpic` embeds the plan_id in the epic filename (`${slug}-${planId}.md`, comment at `7876-7879`); the file watcher re-imports and derives plan_id from that trailing UUID, **normalizing `session_id` to equal `plan_id`** in steady state.
- Decisive: `markEpicOrchestrating` and `buildEpicOrchestrationPrompt` use the **identical** resolver with the **same argument** in the same handler. The handler `break`s on a null prompt **before** reaching the teleport, so the teleport is only ever reached when resolution already succeeded. The two paths cannot diverge.

Net: every epic resolves correctly in practice; the teleport fires for any epic that orchestration can resolve at all. The reported bug ("prompt copied, column missing") confirms resolution worked in the failing scenario — exactly what this fix targets.

### Findings

- **CRITICAL:** none.
- **MAJOR:** none.
- **NIT — preview is not strictly side-effect-free at the doc layer:** `'preview'` still calls `buildEpicOrchestrationPrompt`, which calls `_regenerateEpicFile` (a markdown-file write, introduced by the sibling `slim-orchestrator-prompt-addons-epic-link` plan). The plan's "side-effect-free" contract refers to **board/column state**, which preview honors (no teleport, no clipboard). Doc regeneration applies equally to all three modes and is out of this plan's scope. No action.
- **NIT — copy path does not wrap `markEpicOrchestrating` in try/catch** (the send path does, `3164-3168`). The helper guards db/epic resolution with early returns and wraps the move/refresh in its own try/catch; the only unguarded throw would be from `getPlanByPlanId`/`ensureReady` (very unlikely), which would surface via the outer `orchestrateEpic` catch after the clipboard was already written. Matches the plan's snippet exactly. No action.
- **NIT — theoretical double-refresh** in the `moveCardToColumnByPlanFile` fallback (it refreshes internally at `4896`, and the helper refreshes again). Dead in practice: epics always carry a `sessionId`, so the `moveCardToColumn` branch (no internal refresh) is always taken → single refresh. No action.

### Residual risks (carried forward to UAT, unchanged from plan)
1. **Integration status mapping for ORCHESTRATING:** the first teleport into ORCHESTRATING fires `queueIntegrationSyncForSession(..., 'ORCHESTRATING')` (`4825`). The idempotency guard prevents *re-sync*, but verify the first sync maps to a sane Linear/ClickUp status (plan verification step 8).
2. **Legacy epics with `project=''`** remain filtered off project boards until backfilled (out of scope; User Review item #3).

### Verification performed
- Static/structural review of the diff and all supporting call sites (read-only).
- Live `kanban.db` inspection to resolve the plan_id/session_id resolution question.
- Per session directives: **compilation and automated tests were NOT run** (user runs the suite separately). No new tests authored.

### Files changed by this reviewer pass
- None (plan file annotated only; no code edits — implementation was already correct).
