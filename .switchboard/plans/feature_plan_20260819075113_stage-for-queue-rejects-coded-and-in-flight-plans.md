# Stage for Queue button must reject plans already coded or in flight

## Goal

The "STAGE FOR QUEUE" button in the Kanban toolbar accepts plans from any column — including plans that have already been dispatched and coded (LEAD CODED, CODER CODED, INTERN CODED), are in code review (CODE REVIEWED), or have passed acceptance testing (ACCEPTANCE TESTED). Staging such a plan yanks it back into the DISPATCH queue via `appendQueuePositions`, which unconditionally sets `kanban_column = 'DISPATCH'` and assigns a new `queue_position`. This is incorrect: those plans have already been dispatched through the pipeline and should not be re-queued.

### Problem Analysis

The dispatch queue (DISPATCH column) is a staging area for plans that are ready to be dispatched to coders but have not yet been sent. Plans enter DISPATCH from pre-coding columns (CREATED, BACKLOG, PLAN REVIEWED). Once a plan has been dispatched to a coder and moved to a coded column, it has left the queue — re-staging it would regress it backwards through the pipeline.

### Root Cause

Two layers are missing a column gate:

1. **Frontend (`src/webview/kanban.html`, lines 10201–10210):** The stage button enable/disable logic lives inside `updateReassignButtonVisibility` (the function spanning lines 10189–10211), which is called on every selection change (lines 7978, 8194, 8689, 8812, 8977, 10282, 10341, 10767). It enables the STAGE FOR QUEUE button whenever `selectedCards.size > 0`, with no check on which column the selected cards are in. The comment explicitly says "Stage for queue is enabled whenever there is a selection." A user can select cards in CODER CODED or CODE REVIEWED and click STAGE FOR QUEUE — the button is active.

   > **Superseded:** The `updateFeatureActionButton` function enables the STAGE FOR QUEUE button whenever `selectedCards.size > 0`.
   > **Reason:** `updateFeatureActionButton` starts at line 10213 — AFTER the stage button block closes at line 10211. The stage button logic (lines 10201–10210) is inside `updateReassignButtonVisibility` (starts line 10189), not `updateFeatureActionButton`. The line references and code blocks were already correct; only the prose function name was wrong.
   > **Replaced with:** The stage button enable/disable logic lives inside `updateReassignButtonVisibility` (lines 10189–10211), called on every selection change.

2. **Backend (`src/services/KanbanProvider.ts`, lines 7522–7542):** The `_resolveStageablePlanIds` method only refuses subtasks (plans with a non-empty `featureId` that are not features). It does NOT inspect `plan.kanbanColumn`. Any non-subtask plan passes the gate, regardless of its column. The subsequent `appendQueuePositions` call then blindly writes `kanban_column = 'DISPATCH'` and a new `queue_position`, moving the plan backwards.

3. **Database (`src/services/KanbanDatabase.ts`, lines 9955–9961):** `appendQueuePositions` unconditionally updates the row to DISPATCH. It has no column guard — it trusts the caller to have already filtered. This is correct by separation of concerns, but it means the filter must happen upstream.

## Metadata

**Complexity:** 3
**Tags:** bugfix, ui, backend
**Project:** Browser Switchboard

## User Review Required

- **[user]** Confirm that RESEARCHER and TICKET UPDATER columns should be refused by the stage gate (i.e. plans sent to a researcher or ticket updater are "in flight" and must not be re-queued into DISPATCH). Proceeding on the assumption that both are correctly excluded — RESEARCHER is a dispatch destination (research agent in flight), and TICKET UPDATER is a post-coding column (kind `'reviewed'`, order 9000).

## Complexity Audit

### Routine
- Column-membership check added to two existing functions — no new data structures, no schema changes, no migrations.
- The stageable columns set is a small constant array derivable from the existing `CODED_IDS` constant and the column definitions in `agentConfig.ts`.
- The frontend already has access to `currentCards` (which includes `column` per card) and can look up each selected card's column — the same `currentCards.find(c => (c.planId || c.sessionId) === id)` lookup already used at line 7965.
- The backend already fetches the plan row (which includes `kanbanColumn`) in `_resolveStageablePlanIds`.
- Both `BACKLOG` and `DISPATCH` are real stored DB column values — `BACKLOG` is written via `moveCardToColumn` (line 11026), `DISPATCH` via `appendQueuePositions` (line 9958). Both are in `VALID_KANBAN_COLUMNS` (line 930). The gate checks real stored values, not display labels.

### Complex / Risky
- None. The only behavioral change is that the button becomes disabled / the backend refuses when the selection contains only already-dispatched plans. Plans in CREATED, BACKLOG, PLAN REVIEWED, and DISPATCH (re-positioning) continue to stage exactly as before. No migration needed — this is a pure logic gate on existing data.

## Edge-Case & Dependency Audit

1. **Mixed selection (some stageable, some not):** If a user selects 3 plans — one in PLAN REVIEWED (stageable) and two in CODER CODED (not stageable) — what should happen? The frontend should count only stageable plans in the button label and enable the button if at least one stageable plan is selected. The backend should refuse the non-stageable ones and stage the rest, mirroring how subtasks are already partially refused (the `refused` count pattern at line 7561).

2. **DISPATCH re-positioning:** The existing comment at line 10203 says "Staging a card already in DISPATCH re-positions it; that is allowed, not refused." DISPATCH must remain in the stageable set — a card already in the queue can be re-ordered by re-staging. DISPATCH is a real stored `kanban_column` value (written by `appendQueuePositions` at line 9958), so the backend gate matches it correctly.

3. **BACKLOG column:** BACKLOG is a display-mode variant of CREATED (a holding pen, per `DISPLAY_MODE_COLUMNS` in `agentConfig.ts` line 168). Plans in BACKLOG have not been dispatched and should be stageable. BACKLOG is a real stored `kanban_column` value (written via `moveCardToColumn` at line 11026, included in `VALID_KANBAN_COLUMNS` at line 932), so the backend gate matches it correctly. The frontend `currentCards` entries carry `column: 'BACKLOG'` when backlog view is active (see `effectiveColumnOf` at line 6693).

4. **COMPLETED column:** Plans in COMPLETED are done. They should never be stageable. This is already implicitly covered (COMPLETED is not in the stageable set), but the backend explicitly refuses it via the allowlist gate.

5. **RESEARCHER column:** Plans in RESEARCHER have been dispatched to a research agent — they are in flight, not awaiting coder dispatch. RESEARCHER is correctly excluded from `STAGEABLE_COLUMNS`. Re-staging a RESEARCHER plan would yank it out of research and regress it into the coder queue. The allowlist gate refuses it.

6. **TICKET UPDATER column:** Plans in TICKET UPDATER are in a post-coding column (kind `'reviewed'`, order 9000). They are correctly excluded from `STAGEABLE_COLUMNS`. The allowlist gate refuses them.

7. **Remote intake path (`onStageForQueue` in KanbanProvider.ts, line 2435):** The remote control service calls `stageForQueue` (line 2437) for plans arriving from Linear/Notion. These plans arrive in CREATED or PLAN REVIEWED, so they will pass the column gate. No change needed to the remote path — the backend gate covers it. Verified: `stageForQueue` routes through `_resolveStageablePlanIds`; there is no bypass path. `appendQueuePositions` is called only at line 7565 (inside `stageForQueue`), so the single write path is gated.

8. **`appendQueuePositions` in KanbanDatabase.ts:** No change needed. The database method is a low-level primitive that trusts its caller. The filter belongs in `_resolveStageablePlanIds`.

9. **Feature cards (isFeature=true):** Features stage as one card. The existing subtask refusal in `_resolveStageablePlanIds` handles this. A feature in a coded column (rare but possible if a feature was manually moved) should also be refused by the column gate.

10. **Total-refusal error message (line 7561):** When ALL selected plans are refused (e.g. all in coded columns), `planIds.length === 0` and `stageForQueue` returns the error at line 7561. The current message says "subtasks cannot be staged" — after the column gate is added, the refusal reason may be column-based, not subtask-based. This message must be updated alongside the partial-refusal suffix at line 11271 (see Proposed Changes #4).

## Dependencies

None. This is a standalone bugfix with no prerequisite plans.

## Adversarial Synthesis

Key risks: (1) the total-refusal error message at line 7561 was originally missed — it lies ("subtasks cannot be staged") when the real reason is column-based refusal; (2) the frontend and backend allowlists are duplicated constants in different languages with no shared module, so they could drift if a future column is added to only one side; (3) RESEARCHER and TICKET UPDATER are correctly excluded but were originally undocumented, leaving no reasoning for the next agent to inherit. Mitigations: update line 7561 alongside 11271 (Proposed Changes #4); cross-reference comments in both constants ("Mirrors the frontend/backend STAGEABLE_COLUMNS gate"); document RESEARCHER and TICKET UPDATER exclusions explicitly in the Edge-Case Audit (cases 5 and 6).

## Proposed Changes

### 1. Frontend — `src/webview/kanban.html` (lines 10201–10210, inside `updateReassignButtonVisibility`)

Add a column check to the STAGE FOR QUEUE button enable/disable logic in `updateReassignButtonVisibility`. Look up each selected card in `currentCards` to get its `column`, and only count cards in stageable columns.

**Stageable columns (frontend constant):**
```javascript
const STAGEABLE_COLUMNS = ['CREATED', 'BACKLOG', 'PLAN REVIEWED', 'DISPATCH'];
```

**Replace lines 10201–10210:**
```javascript
            // V60: Stage for queue is enabled when at least one selected
            // card is in a pre-dispatch column (CREATED, BACKLOG, PLAN
            // REVIEWED) or already in DISPATCH (re-positioning). Cards in
            // coded, reviewed, tested, or completed columns have already
            // been dispatched and must not be re-queued.
            const STAGEABLE_COLUMNS = ['CREATED', 'BACKLOG', 'PLAN REVIEWED', 'DISPATCH'];
            const stageBtn = document.getElementById('btn-stage-for-queue');
            if (stageBtn) {
                let stageableCount = 0;
                for (const id of selectedCards.keys()) {
                    const card = currentCards.find(c => (c.planId || c.sessionId) === id);
                    if (card && STAGEABLE_COLUMNS.includes(card.column)) {
                        stageableCount++;
                    }
                }
                stageBtn.disabled = stageableCount === 0;
                stageBtn.textContent = stageableCount > 0
                    ? `STAGE FOR QUEUE (${stageableCount})`
                    : 'STAGE FOR QUEUE';
            }
```

The `STAGEABLE_COLUMNS` constant should be declared at module scope (near `CODED_IDS` at line 5519) so it is available to both this function and any future call site. Place it right after `CODED_IDS`:

```javascript
const CODED_IDS = ['LEAD CODED', 'CODER CODED', 'INTERN CODED'];
/** Columns whose plans are eligible for staging into the DISPATCH queue.
 *  Plans in coded/reviewed/tested/completed columns have already been
 *  dispatched and must not be re-queued. DISPATCH itself is included so
 *  a card already in the queue can be re-positioned by re-staging.
 *  Mirrors the backend stageableColumns Set in _resolveStageablePlanIds. */
const STAGEABLE_COLUMNS = ['CREATED', 'BACKLOG', 'PLAN REVIEWED', 'DISPATCH'];
```

Then reference `STAGEABLE_COLUMNS` in the button logic instead of re-declaring it inline.

### 2. Backend — `src/services/KanbanProvider.ts` (lines 7522–7542)

Add a column check to `_resolveStageablePlanIds`. After resolving the plan row, inspect `plan.kanbanColumn` and refuse plans not in the stageable set. This is defense-in-depth — the remote intake path and any future caller are covered even if the frontend gate is bypassed.

**Replace the body of `_resolveStageablePlanIds` (lines 7528–7541):**
```typescript
        const planIds: string[] = [];
        let refused = 0;
        if (!db || !workspaceId) return { planIds, refused: ids.length, workspaceId };
        // Plans in coded/reviewed/tested/completed columns have already been
        // dispatched and must not be re-queued. DISPATCH itself is stageable
        // (re-positioning). Mirrors the frontend STAGEABLE_COLUMNS gate.
        const stageableColumns = new Set(['CREATED', 'BACKLOG', 'PLAN REVIEWED', 'DISPATCH']);
        for (const id of ids) {
            let plan = await db.getPlanByPlanId(id);
            if (!plan) { plan = await db.getPlanBySessionId(id); }
            if (!plan) { refused++; continue; }
            // Subtasks (non-empty featureId) are refused — features stage as one
            // card, never as their subtasks. Mirrors the staged-count contract
            // (!c.featureId) on the toggle and the Send-all set.
            if (plan.featureId && !plan.isFeature) { refused++; continue; }
            // Refuse plans already past the dispatch stage — they have been
            // dispatched and coding/review has begun or completed.
            if (!stageableColumns.has(plan.kanbanColumn)) { refused++; continue; }
            planIds.push(plan.planId);
        }
        return { planIds, refused, workspaceId };
```

### 3. Backend partial-refusal status message — `src/services/KanbanProvider.ts` (line 11271)

Update the refused suffix message to account for column-based refusals, not just subtask refusals. The current message says "subtasks cannot be staged" — it should also mention already-dispatched plans.

**Replace line 11271:**
```typescript
                const refusedSuffix = result.refused > 0 ? ` (${result.refused} refused — subtasks or already-dispatched plans cannot be staged)` : '';
```

### 4. Backend total-refusal error message — `src/services/KanbanProvider.ts` (line 7561)

When ALL selected plans are refused (e.g. all in coded columns), `planIds.length === 0` and `stageForQueue` returns the error at line 7561. The current message says "subtasks cannot be staged" — after the column gate is added, the refusal reason may be column-based. This message must be updated to match the partial-refusal suffix at line 11271.

**Replace line 7561:**
```typescript
            return { success: false, staged: 0, refused, error: refused > 0 ? 'No stageable plans selected (subtasks or already-dispatched plans cannot be staged)' : 'No plans resolved' };
```

## Verification Plan

### Automated Tests

- **Backend unit check:**
  - Call `stageForQueue` with a plan ID known to be in a coded column.
  - Verify the return is `{ success: false, staged: 0, refused: 1, error: 'No stageable plans selected ...' }` (or `{ success: true, staged: N, refused: 1 }` if mixed with stageable plans).
  - Verify the plan's `kanban_column` in the DB is unchanged (still the coded column, not DISPATCH).

### Manual Tests

1. **Button disabled for coded plans:**
   - Select one or more cards in a coded column (LEAD CODED, CODER CODED, or INTERN CODED).
   - Verify the STAGE FOR QUEUE button is disabled (greyed out, no count).
   - Select a mix of one PLAN REVIEWED card and one CODER CODED card.
   - Verify the button reads "STAGE FOR QUEUE (1)" — only the stageable card is counted.
   - Click it. Verify only the PLAN REVIEWED card moves to DISPATCH; the CODER CODED card stays in place.

2. **Button enabled for pre-dispatch plans:**
   - Select cards in CREATED and/or PLAN REVIEWED.
   - Verify the button is enabled and shows the correct count.
   - Click it. Verify the cards move to DISPATCH with queue positions assigned.

3. **DISPATCH re-positioning still works:**
   - In Dispatch view, select a card already in DISPATCH.
   - Verify the button is enabled (DISPATCH is in the stageable set).
   - Click it. Verify the card is re-positioned (queue position updated), not duplicated.

4. **CODE REVIEWED and ACCEPTANCE TESTED refused:**
   - Select cards in CODE REVIEWED or ACCEPTANCE TESTED.
   - Verify the button is disabled.
   - If the backend is called directly (e.g. via the API or remote intake), verify the plan is refused and the status message names the refusal reason.

5. **RESEARCHER and TICKET UPDATER refused:**
   - Select a card in RESEARCHER or TICKET UPDATER.
   - Verify the button is disabled (neither is in the stageable set).
   - If the backend is called directly, verify the plan is refused with the updated error message naming "already-dispatched plans."

6. **Total-refusal error message:**
   - Select only cards in coded columns (no stageable cards in the selection).
   - Click STAGE FOR QUEUE (if the frontend allows it via API/direct call).
   - Verify the error message says "subtasks or already-dispatched plans cannot be staged" — not just "subtasks cannot be staged."

## Completion Report

Implemented column gate for staging cards into the DISPATCH queue on both frontend and backend. In `src/webview/kanban.html`, defined `STAGEABLE_COLUMNS` (`['CREATED', 'BACKLOG', 'PLAN REVIEWED', 'DISPATCH']`) and updated `updateReassignButtonVisibility` to enable `STAGE FOR QUEUE` and count only cards residing in stageable columns. In `src/services/KanbanProvider.ts`, updated `_resolveStageablePlanIds` to refuse plans not in `stageableColumns`, and aligned refusal error/status messages across `stageForQueue` and its message handler to cite already-dispatched plans. No issues encountered during implementation.
