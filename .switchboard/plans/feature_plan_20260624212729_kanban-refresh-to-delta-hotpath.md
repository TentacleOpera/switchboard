# Refresh-to-Delta (Part 1 of 2): Interactive Hot Path — Prompt & Dispatch Handlers

## Goal

Make the Kanban board snappy on the **frequent interactive actions** by replacing whole-board refreshes with targeted `moveCards` deltas on the prompt-advance and dispatch handlers. Each `_refreshBoard` re-runs the full pipeline (custom-agents, custom-columns, visible-agents, the DB `getBoard` query, a per-plan `fs.existsSync` ghost-plan filter, completed-plans, projects) and forces the webview to relayout **every card in every column**. The webview already has a lightweight `moveCards` delta ([kanban.html:6073](../../src/webview/kanban.html#L6073)) that updates only the affected cards and recomputes counts from the array `renderBoard` is handed ([kanban.html:5116](../../src/webview/kanban.html#L5116)). For a card move, the full refresh is pure overhead.

This is **Part 1** of a two-part split. It covers the high-value, low-risk hot path: the remaining prompt-advance handlers and the dispatch handlers. **Part 2** ([feature_plan_20260624212730_kanban-refresh-to-delta-backlog.md](feature_plan_20260624212730_kanban-refresh-to-delta-backlog.md)) is backlogged and covers complete/recover/archive (needs new delta infra) and documents the structural refreshes that must stay.

### Problem Analysis & Root Cause (verified against live code)

The board redraws the whole column set on every interactive move because the prompt/dispatch handlers funnel through two full-refresh mechanisms:

1. **Direct `await this._refreshBoard(workspaceRoot)`** — runs the entire `refreshUI` → `refreshWithData` pipeline and posts `updateBoard`, relayouting every card.
2. **`switchboard.kanbanForwardMove` → `handleKanbanForwardMove`** ([TaskViewerProvider.ts:3258](../../src/services/TaskViewerProvider.ts#L3258)) — used by `promptAll`, `promptOnDrop`, and the move handlers. **This command always ends with `await vscode.commands.executeCommand('switchboard.refreshUI', resolvedWorkspaceRoot)`** ([TaskViewerProvider.ts:3277](../../src/services/TaskViewerProvider.ts#L3277)) — a full board refresh. So even handlers that already post a `moveCards` delta *defeat it* by then calling `kanbanForwardMove`, which redraws everything. **This is the hidden obstacle the original plan missed.**

The fix shape established by the prerequisite (and already shipped on `promptSelected`, `moveCardForward`, `moveCardBackwards`, `moveSelected`, `moveAll`): call `moveCardToColumn` directly and post `{type:'moveCards', sessionIds, targetColumn}` — never route through `kanbanForwardMove` and never call `_refreshBoard` for a pure card move.

### Dependency & scope note (read first)

This plan **depends on and follows** [feature_plan_20260624210141_kanban-advance-buttons-bounce-back.md](feature_plan_20260624210141_kanban-advance-buttons-bounce-back.md), which has **landed**. Verified state of the prerequisite:

- The webview `moveCards` handler reconciles **planId-primary** (`card.planId || card.sessionId`, [kanban.html:6079](../../src/webview/kanban.html#L6079)) so deltas match file-based plans with empty `session_id`. ✓
- `moveAll`, `moveSelected`, `moveCardForward`, `moveCardBackwards` already post `moveCards` deltas with no `_refreshBoard`. ✓
- `promptOnDrop` and `julesLowComplexity` **start-refreshes** (the bounce defect) are already removed. ✓

**⚠️ Critical correction — `_reloadLastCards` does NOT exist and will NOT be created.** The prerequisite plan's *Decision #1* explicitly rejected introducing a data-only reload helper: *"no data-only variant is introduced — `moveAll` filters the existing `this._lastCards` directly."* Confirmed by grep: zero matches for `_reloadLastCards` in `KanbanProvider.ts`. **Every reference to `_reloadLastCards` in the original draft of this plan is void.** Where a handler needs fresh `_lastCards`, filter the existing `this._lastCards` directly (the `moveSelected`/`moveAll` pattern) — do not invent or call `_reloadLastCards`.

So the four core advance handlers are **already done** and are **explicitly out of scope here** to avoid collision. What remains for the hot path is re-scoped into the tiers below after a live-code audit.

## Metadata

- **Tags:** `performance`, `refactor`, `ui`, `frontend`
- **Complexity:** 7/10
- **Depends on:** `feature_plan_20260624210141_kanban-advance-buttons-bounce-back.md` (landed)

## User Review Required

Yes — the re-scope below **removes** three handlers from the original plan's Tier 2 (`julesLowComplexity`, `julesSelected`, `splitterSelected`) because they do not move cards server-side and a `moveCards` delta would misrelocate them, and **reclassifies** `triggerAction`/`triggerBatchAction` to keep their debounced correction refresh. It also **adds** a small refactor to `_advanceSessionsInColumn` (return `{sessionId, targetColumn}` pairs) that the original plan did not anticipate. Confirm this re-scope before implementation.

## Complexity Audit

### Routine
- Replacing `await this._refreshBoard(...)` with a `moveCards` delta on handlers that already know the target column and already persist via `moveCardToColumn` / `db.updateColumn` (`testingFailed` → `LEAD CODED`).
- Replacing `switchboard.kanbanForwardMove` calls with direct `moveCardToColumn` + `moveCards` on `promptAll` and `promptOnDrop` — mirrors the already-shipped `promptSelected` pattern exactly.
- Filtering `this._lastCards` directly instead of a start-refresh on `batchPlannerPrompt`/`batchLowComplexity`/`testingFailed` — the `moveSelected`/`moveAll` pattern.
- Excluding already-converted handlers (`promptSelected`, `rePlanSelected`, `codeMapSelected`) — no work, just don't touch.

### Complex / Risky
- **`_advanceSessionsInColumn` return-shape refactor.** `batchPlannerPrompt` and `batchLowComplexity` derive each card's target column *inside* this helper via `deriveKanbanColumn(updatedEvents, customAgents)` ([KanbanProvider.ts:3731](../../src/services/KanbanProvider.ts#L3731)) and return only `advanced: string[]` — **not the columns**. To emit per-card `moveCards` deltas, the helper must return `{sessionId, targetColumn}[]` (or post the delta internally). This is shared with the planner "Advance all" path, so the refactor must not regress `_distributePlannerDispatch` callers.
- **`handleKanbanForwardMove` is a shared command.** It always does a full `refreshUI`. Any handler that keeps calling it stays on the full-redraw path. The fix is to *stop calling it* on the converted paths and do direct `moveCardToColumn` + `moveCards` instead — but `kanbanForwardMove` also records run-sheet workflow events via `_applyManualKanbanColumnChange`, so the replacement must preserve that run-sheet side effect or the column derivation will drift.
- **No-move dispatch handlers must NOT receive `moveCards`.** `julesLowComplexity`, `julesSelected`, `splitterSelected` only dispatch an agent; the card's column does not change in the handler. Posting `moveCards` would visually fling cards into an un-persisted column with no correction. These are excluded (see User Review Required).
- **Drag-drop correction refreshes.** `triggerAction`/`triggerBatchAction` use `_scheduleBoardRefresh` (100ms debounced) as a *correction* for optimistic drag UI, not a redundant redraw. Dropping it loses failure reconciliation.

## Edge-Case & Dependency Audit

- **`_reloadLastCards` is void.** Do not call it; it does not exist and the prerequisite explicitly decided against it. Filter `this._lastCards` directly everywhere a start-refresh was used to populate `sourceCards`.
- **`handleKanbanForwardMove` trailing `refreshUI`.** This is the *real* full-refresh source on `promptAll`/`promptOnDrop`/move paths. Converting these handlers requires replacing the `kanbanForwardMove` call, not just deleting a `_refreshBoard` line. Preserve the run-sheet workflow-event write that `_applyManualKanbanColumnChange` performs.
- **Multi-target batches.** `promptAll`/`promptOnDrop` PLAN REVIEWED branches split across complexity-routed target columns. Emit one `{sessionIds, targetColumn}` delta per group inside the existing grouping loop (the loops already exist in `promptAll` 5986-6003 and `promptOnDrop` 5471-5481).
- **planId-primary reconcile.** Already in place (prerequisite). Deltas match file-based plans with empty `session_id`. No webview change required in Part 1.
- **Dispatch side effects must remain.** Removing a refresh must not remove the prompt copy / CLI trigger / terminal send — only the board redraw. Verify the dispatch still fires.
- **No-move handlers (excluded).** `julesLowComplexity` (5576), `julesSelected` (6041), `splitterSelected` (6068) keep their trailing reconciliation `_refreshBoard`. They do not move cards; a delta is incorrect. Deferred to Part 2 only if a later agent-driven delta mechanism is added.
- **Drag-drop correction (excluded).** `triggerAction` (5030, 5073) and `triggerBatchAction` (5098) keep `_scheduleBoardRefresh`. The webview already moved the card optimistically; the debounced refresh corrects dispatch failures. Do not replace with a redundant `moveCards`.
- **Already-converted (excluded).** `promptSelected` (5852), `rePlanSelected` (6343), `codeMapSelected` (6376) have no `_refreshBoard` and already post deltas (or don't refresh). Out of scope.
- **Structural refreshes are NOT touched here.** Anything that changes columns, projects, epic membership, worktree badges, or the completed list stays on full refresh (Part 2 / keep-list).

## Dependencies

- `sess_20260624210141 — kanban-advance-buttons-bounce-back` (prerequisite; **landed**. Provides planId-primary `moveCards` reconcile and the filter-`_lastCards`-directly pattern. Explicitly did NOT introduce `_reloadLastCards`.)

## Adversarial Synthesis

Key risks: (1) the original plan depended on a `_reloadLastCards` helper that was never created (the prerequisite explicitly rejected it) — every such reference is void; (2) the real full-refresh source on `promptAll`/`promptOnDrop` is `handleKanbanForwardMove`'s trailing `refreshUI`, which the original plan never identified, so "drop the trailing `_refreshBoard`" is empty where no such line exists; (3) three Tier-2 handlers (`julesLowComplexity`/`julesSelected`/`splitterSelected`) don't move cards server-side, so the prescribed `moveCards` delta would misrelocate them with no DB backing. Mitigations: delete all `_reloadLastCards` references and filter `this._lastCards` directly; replace `kanbanForwardMove` calls with direct `moveCardToColumn`+`moveCards` (preserving the run-sheet workflow-event write); exclude the no-move dispatch handlers and the drag-drop correction refreshes; add a small `_advanceSessionsInColumn` return-shape refactor so `batchPlannerPrompt`/`batchLowComplexity` can emit known-target deltas.

## Call-Site Scope

**Line numbers verified against live `src/services/KanbanProvider.ts` at audit time.** Re-verify before editing — numbers shift as edits land.

### Tier 1 — Prompt handlers still on the full-refresh path (the real win)

| Handler | Live site(s) | Actual full-refresh source | Treatment |
|---|---|---|---|
| `promptAll` | 5934; `kanbanForwardMove` at 6001, 6020 | `handleKanbanForwardMove` → `refreshUI` (no trailing `_refreshBoard` exists) | Replace the `kanbanForwardMove` calls (6001, 6020) with direct `moveCardToColumn` + per-group `moveCards` delta. The `moveCards` posts at 6000/6019 already exist — keep them, drop the `kanbanForwardMove` call that redraws. Preserve the run-sheet workflow-event write. |
| `promptOnDrop` | 5420; `_refreshBoard` at 5458 (custom-user branch) and 5498 (general); `kanbanForwardMove` at 5476, 5483 | `_refreshBoard` + `handleKanbanForwardMove` → `refreshUI` | Custom-user branch (5458): replace `_refreshBoard` with `moveCards` to `targetColumn`; keep `promptOnDropResult`. General branch (5476/5483 + 5498): replace `kanbanForwardMove` + `_refreshBoard` with direct `moveCardToColumn` + per-group `moveCards`; keep `promptOnDropResult`. **Start-refresh already removed by prerequisite — do not touch.** |

**Already done (do NOT re-touch):** `promptSelected` (5852) — no `_refreshBoard`, every branch posts `moveCards` after direct `moveCardToColumn`. The original plan's "drop trailing refresh" for it is stale.

### Tier 2 — Dispatch/batch handlers that genuinely move cards (low–moderate risk)

| Handler | Live site(s) | Treatment |
|---|---|---|
| `batchPlannerPrompt` | 5503; start `_refreshBoard` 5508; trailing `_refreshBoard` 5518 | Drop start-refresh; filter `this._lastCards`/`_visibleColumnCards` directly. **Refactor `_advanceSessionsInColumn` to return `{sessionId, targetColumn}[]`** so the caller can emit per-card `moveCards` deltas. Drop trailing refresh; emit one delta per target group. |
| `batchLowComplexity` | 5530; start `_refreshBoard` 5535; trailing `_refreshBoard` 5547 | Same as `batchPlannerPrompt`. Target is nominally `CODER CODED` but the helper derives it dynamically — use the returned pairs, not a hardcoded guess. |
| `testingFailed` | 6405; start `_refreshBoard` 6414; trailing `_refreshBoard` 6470 | Drop start-refresh; filter `this._lastCards` directly for `sourceCards`. Cards are moved to `LEAD CODED` via `db.updateColumn` (6454) — known target. Replace trailing refresh with `moveCards` to `LEAD CODED`. |

### Excluded after audit (original plan listed these — do NOT convert)

| Handler | Live site(s) | Why excluded |
|---|---|---|
| `triggerAction` | 5030, 5073 (`_scheduleBoardRefresh`) | Drag-drop correction refresh (debounced). Webview already moved card optimistically; refresh reconciles dispatch failure. Dropping loses the safety net; `moveCards` is redundant. |
| `triggerBatchAction` | 5098 (`_scheduleBoardRefresh`) | Same drag-drop correction. |
| `julesLowComplexity` | 5576 (`_refreshBoard`) | Only dispatches Jules agent; **no `moveCardToColumn`**. Card column unchanged in handler. `moveCards` would misrelocate. Keep reconciliation refresh. |
| `julesSelected` | 6041 (`_refreshBoard`) | Same — only dispatches, no move. |
| `splitterSelected` | 6068 (`_refreshBoard`) | Same — only dispatches splitter, no move. |
| `rePlanSelected` | 6343 | **No `_refreshBoard` exists.** Already not refreshing. |
| `codeMapSelected` | 6376 | **No `_refreshBoard` exists.** Already not refreshing. |

> **Cross-plan boundary rule (preserved).** The bounce-back plan owns the **start-refresh removal** (the bounce fix) for `moveAll`, `promptOnDrop`, and `julesLowComplexity` — all already landed. This plan owns converting all **other** (post-dispatch / trailing / `kanbanForwardMove`-routed) refreshes on the prompt/dispatch handlers to `moveCards` deltas. Verify exact line numbers against the live code before editing.

## Proposed Changes

### File: `src/services/KanbanProvider.ts`

1. **`promptAll` (5934).** In the PLAN REVIEWED branch and the else branch, the `moveCards` delta is already posted (6000, 6019). **Remove the `await vscode.commands.executeCommand('switchboard.kanbanForwardMove', ...)` calls at 6001 and 6020** — they trigger `handleKanbanForwardMove`'s full `refreshUI`, defeating the delta. Replace each with the direct persist the `moveCards` delta implies is already done (the DB-first `dbPa.updateColumn` / `dbPa2.updateColumn` blocks at 5992-5998 / 6011-6017 already persist). **Preserve the run-sheet workflow-event write** that `_applyManualKanbanColumnChange` would have performed — add an equivalent `log.updateRunSheet` push of the `{workflow, action:'start'}` event so `deriveKanbanColumn` stays consistent on the next structural refresh.

2. **`promptOnDrop` (5420).**
   - **Custom-user branch (5458):** replace `await this._refreshBoard(workspaceRoot)` with
     ```js
     this._panel?.webview.postMessage({ type: 'moveCards', sessionIds, targetColumn });
     ```
     keeping the existing `promptOnDropResult` post.
   - **General branch (5476/5483 + 5498):** replace the `switchboard.kanbanForwardMove` calls (5476 per-group, 5483 single) **and** the trailing `await this._refreshBoard(workspaceRoot)` (5498) with direct `moveCardToColumn` + per-group `moveCards`:
     ```js
     for (const sid of sids) {
         await this.moveCardToColumn(workspaceRoot, sid, targetCol);
         await this._taskViewerProvider?.recordRunSheetForColumnMove(sid, targetCol, 'forward', workspaceRoot);
     }
     this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: sids, targetColumn: targetCol });
     ```
     Keep the `promptOnDropResult` and `showStatusMessage` posts. **Do NOT touch the start-refresh (already gone).**

3. **`_advanceSessionsInColumn` refactor (3688).** Change the return type from `Promise<string[]>` to `Promise<{sessionId: string, targetColumn: string}[]>`. Where it currently does `advanced.push(sessionId)` (3753), push `{ sessionId, targetColumn: normalizedColumn }` instead (the `normalizedColumn` is already in scope at 3732). Update the two callers in this plan (`batchPlannerPrompt`, `batchLowComplexity`) to consume the pairs. **Audit the other caller (`_distributePlannerDispatch` planner path) and update it to read `.sessionId` from the pairs** so it does not break.

4. **`batchPlannerPrompt` (5503).** Drop the start `await this._refreshBoard(workspaceRoot)` (5508); derive `sourceCards` via `this._visibleColumnCards(workspaceRoot, 'CREATED')` against the existing `_lastCards` (the helper already reads `_lastCards`). After `_advanceSessionsInColumn` returns the `{sessionId, targetColumn}[]` pairs, group by `targetColumn` and emit one `moveCards` delta per group. Drop the trailing `_refreshBoard` (5518).

5. **`batchLowComplexity` (5530).** Same treatment as `batchPlannerPrompt`: drop start-refresh (5535); use the returned pairs to emit per-group `moveCards` deltas; drop trailing refresh (5547).

6. **`testingFailed` (6405).** Drop the start `await this._refreshBoard(workspaceRoot)` (6414); filter `this._lastCards` directly for `sourceCards` (6415). The cards are persisted to `LEAD CODED` via `db.updateColumn` (6454) — replace the trailing `await this._refreshBoard(workspaceRoot)` (6470) with
   ```js
   this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: msg.sessionIds, targetColumn: 'LEAD CODED' });
   ```

7. **No `_reloadLastCards`.** Anywhere a refresh was used only to populate `_lastCards`, filter `this._lastCards` directly. Do not introduce or call `_reloadLastCards`.

No webview changes are required in Part 1 — the `moveCards` handler (with the prerequisite plan's planId-primary fix, [kanban.html:6079](../../src/webview/kanban.html#L6079)) already covers every case here.

## Verification Plan

> **Per session directives:** skip compilation (`tsc`/webpack) and skip automated tests. Verification is manual, against an installed VSIX. The test suite will be run separately by the user.

### Automated Tests
- Skipped per session directive. The existing `pair-programming-comprehensive.test.ts` references `kanbanForwardMove` and `_advanceSessionsInColumn` callers — flag to the user that the `_advanceSessionsInColumn` return-shape change (step 3) will require updating those test stubs when the suite is run.

### Manual Verification
**Step 1 — `promptAll`.** On a column with multiple plans, use the column-header prompt-all button (single target and a PLAN REVIEWED batch that splits across target columns). Confirm: cards advance and stay, prompt is copied, Extension Host log shows `moveCards` deltas with **no** `refreshUI`/`getBoard`/ghost-plan-filter lines from `handleKanbanForwardMove`. Only affected cards + counts change; no full-board relayout.

**Step 2 — `promptOnDrop`.** Drag-drop in prompt mode (custom-user column and built-in column; PLAN REVIEWED split). Confirm cards land in the correct column(s) via delta, `promptOnDropResult` fires, counts are right, no full redraw.

**Step 3 — `batchPlannerPrompt` / `batchLowComplexity`.** Run each batch prompt. Confirm per-group `moveCards` deltas fire for the derived target columns, the prompt is copied, and no full redraw occurs. Verify the `_advanceSessionsInColumn` refactor did not regress the planner "Advance all" path (run an Advance-all on NEW with extra terminals).

**Step 4 — `testingFailed`.** Trigger a testing-failure report (copyPrompt and sendToLead). Confirm cards move to `LEAD CODED` via delta, prompt is copied/dispatched, no full redraw.

**Step 5 — Excluded handlers (regression check).** Run `julesLowComplexity`, `julesSelected`, `splitterSelected`, and a drag-drop dispatch (`triggerAction`/`triggerBatchAction`). Confirm these **still** reconcile via their kept refresh and that cards are **not** visually misrelocated by a spurious delta.

**Step 6 — Reconcile correctness.** With file-based plans (empty `session_id`), confirm deltas match (planId-primary) — cards move authoritatively, not just optimistically.

**Step 7 — Structural untouched.** Confirm project/workspace/epic/worktree/column actions STILL trigger a full refresh and render correctly (not regressed).

**Step 8 — Snappiness.** On a board with 50+ cards, compare prompt-all/dispatch responsiveness before vs after. Interactive moves should feel instant with no relayout of unrelated columns.

**Step 9 — Build & install.** Build the VSIX, reload, re-run Steps 1–4 against the installed extension (not `dist/`).

## Uncertain Assumptions

None. All call-site line numbers, the `_reloadLastCards` absence, the `handleKanbanForwardMove` trailing `refreshUI`, the planId-primary `moveCards` reconcile, and the no-move behavior of the excluded dispatch handlers were verified directly against the live source. No web research is required before implementation.

---

**Recommendation:** Complexity is 7/10 (the `_advanceSessionsInColumn` return-shape refactor + the shared `handleKanbanForwardMove` obstacle + run-sheet side-effect preservation). **Send to Lead Coder.**

---

## Reviewer Pass (executed in-place)

### Stage 1 — Grumpy Principal Engineer

> *Slams chair back.* You know what I love? A plan that spends six paragraphs agonizing over a `_reloadLastCards` ghost and a `handleKanbanForwardMove` "hidden obstacle," then quietly drops the one side effect that actually mattered. Let me read you the riot act.

- **CRITICAL — `promptAll` epic-cascade amnesia.** `KanbanProvider.ts:6026` & `6050` (pre-fix). The pre-conversion path was `kanbanForwardMove` → `_applyManualKanbanColumnChange` → `_updateKanbanColumnForSession` → **`moveCardToColumn`** (`TaskViewerProvider.ts:2204`), and `moveCardToColumn` **cascades epic subtasks** (`KanbanProvider.ts:4444-4448`, `updateColumnWithEpicCascade`). Your "DB-first" replacement called `dbPa.updateColumn` / `dbPa2.updateColumn` directly — which does **zero** cascade. So the moment a user hits prompt-all on a column holding an epic parent, the parent moves and its subtasks are **orphaned in the source column**. Worse: your own `_visibleColumnCards` helper (`KanbanProvider.ts:362`, `!card.epicId`) deliberately excludes subtasks from `sourceCards` because they roll up under the epic — so the subtasks were NEVER advanced independently either. Net: subtasks stranded, epic/subtask column divergence, exactly the class of bug `kanban-subtask-column-leak-regression.test.js` exists to prevent. The plan's "the DB-first blocks already persist" line was true and **irrelevant** — persisting the parent is not persisting the family. You optimized the redraw and broke the data model. Fix: use `moveCardToColumn` (epic-aware, DB-first, no refresh) — which is *literally what `promptOnDrop`'s general branch already does* (`KanbanProvider.ts:5503`). Consistency, people.

- **MAJOR (downgraded to NIT after fix) — run-sheet write was correct, just for the wrong reason.** `recordRunSheetForColumnMove` → `_updateSessionRunSheet` writes a `move-to-<target>` event (`TaskViewerProvider.ts:3068-3074`, `14599-14605`), and `deriveKanbanColumn` **does** consume `move-to-X` slugs (`kanbanColumnDerivationImpl.js:50-64`). So the "preserve the run-sheet workflow-event write" requirement is genuinely satisfied — the next structural refresh re-derives the same column. Good. But the plan framed this as "add an equivalent `log.updateRunSheet` push" and the implementation used `recordRunSheetForColumnMove` instead. Functionally equivalent (it calls `updateRunSheet` internally). Not a defect — noting only because the plan's prescription and the implementation's mechanism diverged and nobody flagged it.

- **NIT — `batchLowComplexity` status message hardcodes `CODER CODED`.** `KanbanProvider.ts:5579`. The helper derives the target dynamically (called with `workflow: undefined`, so derivation falls back to prior events) and the delta correctly uses the returned pairs via `_postMoveCardsByTarget`. The user-facing string still says "to CODER CODED" regardless of the actual derived column. Cosmetic; pre-existing pattern (the helper's dynamic derivation predates this plan). Defer.

- **NIT — `testingFailed` does not cascade epic subtasks.** `KanbanProvider.ts:6495` uses `db.updateColumn` directly. Pre-conversion `testingFailed` **also** used `db.updateColumn` directly (no `kanbanForwardMove`, no `moveCardToColumn`) — so this is **parity, not a regression**. An epic sent back to `LEAD CODED` on a testing-failure report leaves its subtasks behind. Pre-existing behavior; out of this plan's scope. Flag for Part 2 if epic-failure handling matters.

- **NIT — `codeMapSelected` still routes through `kanbanForwardMove`.** `KanbanProvider.ts:6361, 6380`. The plan excluded `codeMapSelected` claiming "No `_refreshBoard` exists. Already not refreshing." Technically true about `_refreshBoard`, but `kanbanForwardMove` → `refreshUI` **is** a full redraw — so the exclusion rationale was half-wrong. It's correctly out of scope (no `moveCards` infra wired there), but the plan should have said "excluded; still full-refreshes via kanbanForwardMove — defer to a later part." Not a regression; just sloppy reasoning.

- **CLEAN — everything else.** `_advanceSessionsInColumn` return-shape refactor (`KanbanProvider.ts:3688`) ✓. `_postMoveCardsByTarget` helper (`KanbanProvider.ts:3768`) ✓. `batchPlannerPrompt`/`batchLowComplexity` start-refresh dropped, pairs → per-group deltas (`5532`, `5560`) ✓. `promptOnDrop` custom-user + general branches converted, `moveCardToColumn` + `recordRunSheetForColumnMove` + per-group `moveCards`, `promptOnDropResult` preserved (`5441-5530`) ✓. `testingFailed` start/trailing refreshes dropped, `moveCards` to `LEAD CODED` (`6446-6518`) ✓. Excluded handlers (`julesLowComplexity` 5607, `julesSelected` 6082, `splitterSelected` 6109, `triggerAction` 5051/5094, `triggerBatchAction` 5119) all retain their reconciliation refreshes ✓. Zero `_reloadLastCards` references ✓. Webview `moveCards` planId-primary reconcile confirmed (`kanban.html:6079`) — no webview change needed ✓. Test stubs already updated for the return-shape change (`kanban-complexity.test.ts:324,380`) ✓.

### Stage 2 — Balanced Synthesis

**Keep as-is:** `_advanceSessionsInColumn` refactor + `_postMoveCardsByTarget`; `batchPlannerPrompt`/`batchLowComplexity`/`testingFailed`/`promptOnDrop` conversions; all excluded-handler refreshes; run-sheet write via `recordRunSheetForColumnMove`.

**Fix now (CRITICAL):** `promptAll` epic-cascade regression — replace the direct `dbPa.updateColumn`/`dbPa2.updateColumn` blocks in both branches with `this.moveCardToColumn(workspaceRoot, sid, target)`. This restores the pre-conversion cascade (which flowed through `moveCardToColumn` via `kanbanForwardMove`), keeps the DB-first persist, preserves the `_autoCommitIfCodeReviewTransition` + `queueIntegrationSyncForSession` side effects that the old `kanbanForwardMove` path also performed, and still emits the targeted `moveCards` delta with no full refresh. `_schedulePlanStateWrite` is a no-op (`KanbanProvider.ts:55-56`) so dropping it is lossless. This makes `promptAll` consistent with `promptOnDrop`'s general branch.

**Defer (NIT):** `batchLowComplexity` hardcoded status string; `testingFailed`/`codeMapSelected` epic-cascade + full-refresh gaps (pre-existing / out-of-scope).

### Code Fixes Applied

**File: `src/services/KanbanProvider.ts`**
- `promptAll` PLAN REVIEWED branch (~line 6022-6028): replaced `dbPa.updateColumn` loop + `_schedulePlanStateWrite` with `this.moveCardToColumn(workspaceRoot, sid, targetCol)` — restores epic subtask cascade.
- `promptAll` else branch (~line 6044-6049): replaced `dbPa2.updateColumn` loop + `_schedulePlanStateWrite` with `this.moveCardToColumn(workspaceRoot, sid, nextCol)` — same.
- Updated accompanying comments to document the epic-cascade rationale.

No other files modified in this review pass.

### Validation Results

- **Compilation:** Skipped per session directive.
- **Automated tests:** Skipped per session directive. Noted: `kanban-complexity.test.ts` and `kanban-batch-prompt-regression.test.js` already reflect the `_advanceSessionsInColumn` return-shape change; `pair-programming-comprehensive.test.ts` `kanbanForwardMove` assertions target `codeMapSelected` (excluded, still uses `kanbanForwardMove`) so they remain green; `kanban-subtask-column-leak-regression.test.js` asserts `promptAll` uses `_visibleColumnCards` (still satisfied) — the epic-cascade fix is complementary to that test's intent (subtasks roll up under the epic and follow it).
- **Static checks performed:** grep-verified zero `_reloadLastCards` references; no dangling `dbPa`/`dbPa2` identifiers in `promptAll` after edit; webview `moveCards` handler confirmed planId-primary; `moveCardToColumn` epic-cascade path confirmed (`updateColumnWithEpicCascade`); `recordRunSheetForColumnMove` → `deriveKanbanColumn` `move-to-X` consumption confirmed.
- **Manual verification:** Still required per the plan's Verification Plan (Steps 1–9), against an installed VSIX. **Add to Step 1:** verify an epic parent advanced via prompt-all carries its subtasks to the target column (the cascade regression scenario).

### Remaining Risks

1. **`testingFailed` epic subtask stranding** (pre-existing, not a regression) — an epic moved to `LEAD CODED` on a failure report leaves subtasks behind. Defer to Part 2 if epic-failure reconciliation is desired.
2. **`codeMapSelected` full refresh** — still routes through `kanbanForwardMove` → `refreshUI` (`KanbanProvider.ts:6361,6380`). Out of scope here; the plan's exclusion rationale ("already not refreshing") was inaccurate. Candidate for a future delta-conversion part.
3. **`moveCardToColumn` failure is not surfaced on the `moveCards` delta path** — if a per-card persist returns `false`, the `moveCards` delta still posts for that id (pre-existing pattern shared with `promptOnDrop`/`moveSelected`). Card would visually move then revert on next structural refresh. Not introduced by this plan; noting for completeness.
4. **`batchLowComplexity` target derivation with `workflow: undefined`** — the helper pushes an event with no workflow, so `deriveKanbanColumn` falls back to prior events to pick the column. This is unchanged pre-conversion behavior; the delta correctly uses the returned pairs. Flagged only because the status message's hardcoded `CODER CODED` may occasionally mismatch the actual derived column.
