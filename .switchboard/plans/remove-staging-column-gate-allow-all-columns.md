# Remove STAGING column gate — allow drag-back from any column

## Goal

The STAGING column's drag-into-STAGING path and the backend `stageForQueue` handler both refuse plans from coded/reviewed/tested/completed/researcher/ticket-updater columns via a `stageableColumns` allowlist. This gate was carried over from the old DISPATCH model (where re-staging an already-dispatched plan was a pipeline regression) and retargeted to STAGING during the DISPATCH→STAGING migration — but the requirement no longer holds. Under the STAGING model, dragging a card backwards is a legitimate user action (rework, re-dispatch, reassignment). The consequence of the gate failing silently (card appears to move, backend refuses, card strands visually) is worse than the risk of a user accidentally dragging something into STAGING.

### Problem Analysis

The STAGING column replaced DISPATCH as the pre-dispatch queue. Unlike DISPATCH (a one-way pipeline gate — once dispatched, a plan was "in flight"), STAGING is an organizational column that users can drag cards into from any direction. The old column gate was preserved through the migration without re-evaluating whether it still made sense.

### Root Cause

Two layers retain a column allowlist that should not exist:

1. **Backend** (`src/services/KanbanProvider.ts`, lines 8189–8203): `_resolveStageablePlanIds` has a `stageableColumns` set containing only `['CREATED', 'BACKLOG', 'PLAN REVIEWED', 'STAGING']`. Any plan not in that set is refused. This was retargeted from `DISPATCH` to `STAGING` during the migration but the coded/reviewed/tested columns were never added back — and per the new requirement, they should not be gated at all.

2. **Frontend** (`src/webview/kanban.html`, lines 6142 and 9407–9409): A `STAGEABLE_COLUMNS` constant (same 4 columns) is used to filter which dragged cards are sent to `stageForQueue`. Cards not in the set are silently dropped from the drag — the user sees them move optimistically, but they're never sent to the backend, so they strand visually until a board repaint.

3. **Error messages** (`src/services/KanbanProvider.ts`, lines 8226 and 11902): Both the total-refusal error and the partial-refusal suffix say "already-dispatched plans cannot be staged" — after this fix, the only refusal reason is subtasks.

A fourth issue was discovered during plan review: the queue pop's `isQueueable` filter (`src/services/LocalApiServer.ts`, line 1879) checks `!p.dispatchedAt`. The staging writer `appendQueuePositions` (`src/services/KanbanDatabase.ts`, lines 10090–10092) sets `kanban_column` and `queue_position` but does NOT clear `dispatched_at`, `last_liveness_at`, or `blocked_at`. A card from a coded/reviewed/completed column — which has `dispatched_at` set from its previous dispatch — would be staged (get a queue position) but silently skipped by the pop forever. This must be fixed alongside the gate removal or the plan's goal is defeated for the very columns the gate previously blocked.

## Metadata

> **Superseded:** **Complexity:** 2
> **Reason:** The original score of 2 accounted only for the gate removal (deletions in 2 files). The improve pass identified two additional required changes: (1) clearing `dispatched_at`/`last_liveness_at`/`blocked_at` in `appendQueuePositions` — a data-consistency concern in the DB layer, and (2) rewriting `staging-column-contract.test.js` check #6 which would otherwise break CI. The plan now touches 4 files across 3 layers (backend, frontend, DB, test) with a real behavioral consequence (queue eligibility) if the `dispatchedAt` clear is missed.
> **Replaced with:** **Complexity:** 3

**Complexity:** 3
**Tags:** bugfix, backend, ui
**Project:** Browser Switchboard

## User Review Required

None — the change is a straightforward gate removal with a necessary dispatch-state reset. The behavioral consequence (re-staging a card now clears its activity light and previous dispatch metadata) is the intended behavior: a re-queued card is a fresh start, not a continuation of a previous dispatch.

## Complexity Audit

### Routine
- Removing the `stageableColumns` Set declaration and column-membership check in `_resolveStageablePlanIds` (4 lines deleted, 3 lines deleted).
- Removing the `STAGEABLE_COLUMNS` constant declaration and comment block in `kanban.html` (6 lines deleted).
- Removing the `STAGEABLE_COLUMNS.includes(card.column)` filter from the drag-into-STAGING handler (1 clause removed from a filter expression).
- Updating two error messages to drop the "already-dispatched plans" wording.
- Updating one stale comment block on the STAGING drop handler.
- Rewriting `staging-column-contract.test.js` check #6 to assert the new contract (no allowlist).

### Complex / Risky
- Extending `appendQueuePositions` to clear `dispatched_at`, `last_liveness_at`, and `blocked_at` on stage. This is a data-consistency change: without it, re-staged cards from coded/reviewed/completed columns are stranded in STAGING (staged but never popped). The change itself is a 3-column addition to an existing UPDATE statement, but the consequence of missing it is a silent functional bug.

## Edge-Case & Dependency Audit

### Race Conditions
None. All changes are subtractive (removing a check) or additive to an existing atomic UPDATE. Removing the `stageableColumns` check cannot introduce a race — it only allows more plans through a gate that was already serialized. The `appendQueuePositions` UPDATE is already inside a try/catch with `_persist()` and runs in the caller's order.

### Security
None. No auth/permission surface is involved. The staging gate was a workflow constraint, not a security boundary.

### Side Effects
- **Activity light reset:** Re-staging a card from a coded/reviewed/completed column now clears `dispatched_at`, which turns off the activity light. This is correct — the card is being re-queued, not continued. The light will re-illuminate when the card is popped and dispatched.
- **Stall watch re-arm:** `stageForQueue` already arms the queue watch. Clearing `dispatched_at` does not interfere — the watch tracks from the staging moment, not from `dispatched_at`.
- **In-flight predicate:** The in-flight check in `_runQueuePop` (LocalApiServer.ts:1846–1851) scans coding columns for cards with `dispatchedTerminal` set. A re-staged card is in STAGING (not a coding column), so clearing `dispatchedTerminal` is not strictly necessary for the in-flight check. However, clearing it alongside `dispatched_at` is correct hygiene — a re-queued card should not carry stale dispatch identity. Note: `appendQueuePositions` does NOT currently write `dispatched_terminal`, so it will retain its previous value. This is harmless (the pop overwrites it on dispatch), but the plan does NOT clear `dispatched_terminal` — only `dispatched_at`, `last_liveness_at`, and `blocked_at`, matching `clearWorkingState`'s null set.

### Dependencies & Conflicts
- **`staging-column-contract.test.js` check #6** — directly asserts the old contract (`STAGEABLE_COLUMNS` exists, excludes coded/reviewed/completed). Must be rewritten in the same change or CI breaks.
- **`queue-pipeline-contract.test.js` line 129** — tests the queue pop's `isQueueable` filter (`!p.dispatchedAt`). This test creates cards directly in the mock board, not via `stageForQueue`, so it is NOT affected by the `dispatchedAt` clearing. The test remains valid: the pop still excludes cards with `dispatchedAt` set; the fix ensures `stageForQueue` clears `dispatchedAt` so re-staged cards don't have it.
- **`staging-column-contract.test.js` check #5** — tests that a drop into STAGING routes through `stageForQueue` or `reorderQueue`. Still valid after the change (routing is unchanged, only the filter inside is removed).
- **`staging-column-contract.test.js` check #7** — tests that `stageForQueue` arms the queue watch. Still valid (untouched by the plan).

## Dependencies

- None

## Adversarial Synthesis

Key risks: (1) the plan missed `staging-column-contract.test.js` check #6, which directly asserts the old allowlist contract and would break CI; (2) removing the gate without clearing `dispatched_at` in `appendQueuePositions` creates a silent stranding bug — cards from coded/reviewed/completed columns stage successfully but are never popped because the queue pop's `isQueueable` filter rejects cards with stale `dispatched_at`. Mitigations: rewrite check #6 to assert the new no-allowlist contract; extend `appendQueuePositions`'s UPDATE to null `dispatched_at`, `last_liveness_at`, and `blocked_at` on stage, matching `clearWorkingState`'s null set.

## Proposed Changes

### 1. Backend — `src/services/KanbanProvider.ts` (lines 8189–8203, inside `_resolveStageablePlanIds`)

Remove the `stageableColumns` set and the column-membership check. The subtask refusal (line 8200) stays — features stage as one card, subtasks are still refused.

**Remove lines 8189–8192** (the comment and `stageableColumns` declaration):
```typescript
        // Plans in coded/reviewed/tested/completed columns have already been
        // dispatched and must not be re-queued. STAGING itself is stageable
        // (re-positioning). Mirrors the frontend STAGEABLE_COLUMNS gate.
        const stageableColumns = new Set(['CREATED', 'BACKLOG', 'PLAN REVIEWED', 'STAGING']);
```

**Remove lines 8201–8203** (the column check):
```typescript
            // Refuse plans already past the dispatch stage — they have been
            // dispatched and coding/review has begun or completed.
            if (!stageableColumns.has(plan.kanbanColumn)) { refused++; continue; }
```

The remaining body of `_resolveStageablePlanIds` keeps only the null-plan check and the subtask check.

### 2. Frontend — `src/webview/kanban.html` (lines 9407–9409, drag-into-STAGING filter)

Remove the `STAGEABLE_COLUMNS.includes(card.column)` filter so all non-STAGING cards are sent to `stageForQueue`. The `card.column !== 'STAGING'` check stays (already-staged cards are re-positioned, not re-appended).

**Replace lines 9407–9409:**
```javascript
                const stagedIds = sessionIds.filter(id => {
                    const card = currentCards.find(c => (c.planId || c.sessionId) === id);
                    return card && card.column !== 'STAGING';
                });
```

### 3. Frontend — `src/webview/kanban.html` (lines 6136–6142, dead constant)

Remove the `STAGEABLE_COLUMNS` constant declaration and its comment block. It is no longer referenced after change #2.

### 4. Frontend — `src/webview/kanban.html` (lines 9399–9406, stale comment)

Update the comment block on the STAGING drop handler to reflect that all columns are now stageable. Remove references to "coded/reviewed/completed column is refused by the backend" and the stranding rationale — that no longer applies.

### 5. Backend — `src/services/KanbanProvider.ts` (line 8226, total-refusal error)

Update the error message to only mention subtasks:

```typescript
            return { success: false, staged: 0, refused, error: refused > 0 ? 'No stageable plans selected (subtasks cannot be staged)' : 'No plans resolved' };
```

### 6. Backend — `src/services/KanbanProvider.ts` (line 11902, partial-refusal suffix)

Update the suffix to only mention subtasks:

```typescript
                const refusedSuffix = result.refused > 0 ? ` (${result.refused} refused — subtasks cannot be staged)` : '';
```

### 7. DB — `src/services/KanbanDatabase.ts` (lines 10090–10092, inside `appendQueuePositions`)

Extend the UPDATE statement to clear `dispatched_at`, `last_liveness_at`, and `blocked_at` when staging a card. Without this, a card from a coded/reviewed/completed column (which has `dispatched_at` set from its previous dispatch) will be staged but silently skipped by the queue pop's `isQueueable` filter (`!p.dispatchedAt` at LocalApiServer.ts:1879). The null set matches `clearWorkingState` (KanbanDatabase.ts:10032) — re-queuing a card is a fresh start.

**Replace the UPDATE at lines 10090–10092:**
```typescript
                this._db.run(
                    'UPDATE plans SET queue_position = ?, kanban_column = ?, column_entered_at = ?, dispatched_at = NULL, last_liveness_at = NULL, blocked_at = NULL WHERE plan_id = ? AND workspace_id = ?',
                    [next, 'STAGING', dispatchNow, planId, workspaceId]
                );
```

**Update the JSDoc above `appendQueuePositions`** (lines 10065–10069) to note that staging clears the working-state fields:
```
 * Clears dispatched_at, last_liveness_at, and blocked_at on stage so a
 * re-queued card from a coded/reviewed/completed column is eligible for
 * the queue pop (isQueueable checks !p.dispatchedAt). Matches the null
 * set in clearWorkingState — re-queuing is a fresh start.
```

### 8. Test — `src/test/staging-column-contract.test.js` (lines 39–41 and 195–206, check #6)

Rewrite check #6 to assert the new contract: no `STAGEABLE_COLUMNS` constant exists, and the drag-into-STAGING filter does not gate on column membership.

**Update the JSDoc at lines 39–41:**
```
 * 6. **Webview staging gate removed.** The frontend no longer filters
 *    dragged cards by column — all non-STAGING cards are sent to
 *    stageForQueue. The STAGEABLE_COLUMNS constant is gone.
```

**Replace the check at lines 195–206:**
```javascript
    // ─── 6. Webview staging gate removed ─────────────────────────────────

    check('STAGEABLE_COLUMNS is gone and the drag filter does not gate on column', () => {
        const idx = kanbanHtml.indexOf('const STAGEABLE_COLUMNS');
        assert.strictEqual(idx, -1, 'STAGEABLE_COLUMNS must not exist — the column gate is removed');
        // The drag-into-STAGING filter must not reference STAGEABLE_COLUMNS.
        const dropIdx = kanbanHtml.indexOf("effectiveTargetColumn === 'STAGING'");
        assert.notStrictEqual(dropIdx, -1, "the drop handler must gate on effectiveTargetColumn === 'STAGING'");
        const branchBody = kanbanHtml.slice(dropIdx, dropIdx + 800);
        assert.ok(
            !/STAGEABLE_COLUMNS/.test(branchBody),
            'the STAGING drop branch must not reference STAGEABLE_COLUMNS — all columns are stageable'
        );
    });
```

## Verification Plan

### Automated Tests

- **Backend unit check:** Call `stageForQueue` with a plan ID known to be in a coded column (e.g. LEAD CODED). Verify the return is `{ success: true, staged: 1, refused: 0 }` and the plan's `kanban_column` in the DB is now `STAGING` with a `queue_position` assigned.
- **Dispatch-state clearing check:** After staging a card that previously had `dispatched_at` set (e.g. a COMPLETED card), verify `dispatched_at`, `last_liveness_at`, and `blocked_at` are all NULL in the DB. Then verify the queue pop's `isQueueable` filter accepts the card (i.e. it is eligible for dispatch).
- **Subtask refusal still works:** Call `stageForQueue` with a subtask plan ID. Verify it is refused with the updated message "subtasks cannot be staged."
- **Contract test passes:** Run `staging-column-contract.test.js` and verify all 9 checks pass, including the rewritten check #6.

### Manual Tests

1. **Drag a coded card into STAGING:**
   - Select a card in LEAD CODED (or CODER CODED / INTERN CODED).
   - Drag it into the STAGING column.
   - Verify the card moves to STAGING and receives a queue position.
   - Verify no error message appears.
   - Verify the activity light turns off (dispatched_at was cleared).

2. **Drag a CODE REVIEWED / ACCEPTANCE TESTED card into STAGING:**
   - Same as above — verify it stages successfully.

3. **Drag a RESEARCHER / TICKET UPDATER card into STAGING:**
   - Same as above — verify it stages successfully.

4. **Drag a COMPLETED card into STAGING:**
   - Same as above — verify it stages successfully (no column is refused).
   - Verify the card is eligible for queue pop (trigger a pop and confirm it dispatches).

5. **Mixed drag (coded + pre-dispatch cards):**
   - Select one LEAD CODED card and one PLAN REVIEWED card.
   - Drag both into STAGING.
   - Verify both stage successfully with queue positions assigned.

6. **Subtask still refused:**
   - Select a subtask card (non-empty featureId, isFeature=false).
   - Drag it into STAGING.
   - Verify it is refused with "subtasks cannot be staged" in the status message.

7. **Re-positioning still works:**
   - Drag a card already in STAGING back into STAGING (re-order).
   - Verify its queue position updates without duplication.

8. **Re-staged card is poppable (the critical edge case):**
   - Drag a COMPLETED card into STAGING.
   - Trigger a queue pop (e.g. via Run Queue or a coder requesting the next card).
   - Verify the re-staged card IS dispatched (not silently skipped).
   - This confirms `dispatched_at` was cleared by `appendQueuePositions`.
