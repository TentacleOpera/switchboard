---
description: "Fix the display bug where copy-prompt advancing a card (or feature) into a hidden dynamic column (e.g. INTERN CODED with hideWhenNoAgent) renders it in the CREATED bucket: the promptSelected/promptAll PLAN REVIEWED branches post only a visual moveCards delta without refreshing columns, and the webview render fallback dumps cards of non-visible columns into CREATED."
---

# Fix: Copy-Prompt Advance into a Hidden Dynamic Column Displays the Card in CREATED

## Goal

Pressing "Copy coder prompt" on a complexity-4 feature card in PLAN REVIEWED made the whole
feature appear to jump backwards into CREATED. The DB was never wrong — the feature and all
its subtasks were correctly cascaded to INTERN CODED (verified via `GET /kanban/board`:
all four rows `kanbanColumn: "INTERN CODED"`). The board *display* placed the feature card
in CREATED. Fix the display path so a card advanced into a currently-hidden dynamic column
renders in the right place (or the column is made visible), never in CREATED.

### Root cause (verified in source + live board, 2026-07-11)

Three cooperating defects — each fine alone, broken together:

1. **Hidden dynamic column.** `INTERN CODED` is declared `hideWhenNoAgent: true`
   (`src/services/agentConfig.ts:129`). `_filterDynamicColumns()`
   (`src/services/KanbanProvider.ts:3514-3527`) removes it from the column set pushed to the
   webview (`updateColumns`, `KanbanProvider.ts:3255`) when the intern agent is not visible
   AND the column is empty. Before the press, INTERN CODED was empty → the webview's
   `columns` array did not contain it. (The webview's own default `columnDefinitions`,
   `kanban.html:4004-4012`, doesn't even list INTERN CODED — it only arrives via
   `updateColumns`.)

2. **Visual-only move delta with no column refresh.** The `promptSelected` handler's
   PLAN REVIEWED complexity-routing branch (`src/services/KanbanProvider.ts:8241`, branch at
   `:8300-8332`) persists the move (`moveCardToColumn` → `cascadeFeatureByPlanId`: feature +
   subtasks atomically), then posts only
   `{ type: 'moveCards', sessionIds, targetColumn: 'INTERN CODED' }`. It calls neither
   `_refreshBoard` nor anything that recomputes `_filterDynamicColumns` — so the webview
   never learns that INTERN CODED is now occupied and should be visible. The same shape
   exists in `promptAll` (`:8334` onward) and in both handlers' custom-user dispatch
   sub-branches (they too post `moveCards` without a refresh). Note `moveCardToColumn`
   (`KanbanProvider.ts:6178`) does NOT refresh the board — unlike
   `moveCardToColumnByPlanFile` (`:6241`) which ends with `await this._refreshBoard(...)`.

3. **Render fallback dumps unknown columns into CREATED.** The webview bucketing
   (`src/webview/kanban.html:5752-5758`):
   `const col = columns.includes(effectiveCol) ? effectiveCol : 'CREATED';`
   A card whose column isn't in the (filtered) `columns` array renders in the CREATED
   bucket. This is the same mechanism as the known slug-stranding hazard ("board=CREATED
   bucket"), now triggered by a *legitimate canonical column* that happens to be filtered
   out. The `moveCards` webview handler (`kanban.html:6827-6845`) sets
   `card.column = 'INTERN CODED'` and re-renders immediately with the stale `columns` —
   so the feature card lands in CREATED on screen while the DB is correct.

The FE even anticipates the hidden-column case in its optimistic prediction —
`resolveCodedAutoTarget()` (`kanban.html:6338`) deliberately falls back to CODER CODED when
`columnDefinitions` lacks INTERN CODED — which produces a cosmetic double-jump (optimistic
move to one column, backend delta to another) before the final mis-bucketing. The backend
routes to INTERN CODED regardless of column visibility (`_targetColumnForDispatchRole`),
which is correct — visibility is presentation, not routing.

Why it surfaced now: this was the first feature dispatched whose complexity (4) fell in the
intern band (default routing 1-4 → INTERN CODED) while INTERN CODED was hidden-because-empty.
Features routed to LEAD/CODER columns (always visible) never hit the fallback.

## Metadata
- **Tags:** bugfix, ui, frontend
- **Complexity:** 4

## User Review Required

- None — display-path fix only; no routing, persistence, or cascade behavior changes.

## Scope

### ✅ IN SCOPE
1. **Backend: schedule a board refresh after copy-prompt advances.** In
   `src/services/KanbanProvider.ts`, at the end of the `promptSelected` PLAN REVIEWED
   routing branch, the `promptSelected` custom-user branch, and the equivalent `promptAll`
   branches: call `this._scheduleBoardRefresh(workspaceRoot)` (existing 100ms-debounced
   helper, `KanbanProvider.ts:~3530`) after the moves complete. The refresh recomputes
   `_filterDynamicColumns` (the target column is now occupied → included), pushes
   `updateColumns` + `updateBoard`, and corrects any FE mis-bucketing authoritatively.
2. **Webview: never dump a known coded column into CREATED.** In the bucketing at
   `kanban.html:5752-5758`: initialize buckets for all of `CODED_IDS` (static list
   `['LEAD CODED','CODER CODED','INTERN CODED']`, `kanban.html:4038`) in addition to
   `columns`, so a card in a filtered-out coded column still renders through the AUTOCODE
   (`CODED_AUTO`) merge when `collapseCodersEnabled` (the merge at `:5760-5777` already
   reads `buckets[colId]` for every CODED_ID). When collapse is OFF and the coded column
   is not in `columns`, request a board refresh once (see #3) instead of mis-bucketing;
   keep the CREATED fallback ONLY for genuinely unknown column values (slugs, removed
   custom columns) so the existing stranding behavior for bad data remains visible rather
   than hidden.
3. **Webview: `moveCards` handler self-heals on unknown target.** In the handler
   (`kanban.html:6827`): after updating `currentCards`, if `msg.targetColumn` is not in
   `columns` (and not coverable by the CODED_AUTO merge), post a single
   `{ type: 'refresh' }` message (debounce/one-shot guard so a burst of deltas can't storm
   the backend) so `updateColumns`/`updateBoard` arrive and re-render correctly.

### ⚙️ OUT OF SCOPE
- Changing `hideWhenNoAgent` semantics or `_filterDynamicColumns` (hiding empty agent-less
  columns is intended behavior; occupied columns are already kept).
- Changing complexity routing or `_targetColumnForDispatchRole` (routing to a hidden column
  is correct — the column becomes visible once occupied).
- The optimistic-move prediction (`resolveCodedAutoTarget` CODER CODED fallback) — the
  authoritative refresh in #1 corrects the cosmetic double-jump; predicting a hidden
  column's appearance ahead of the backend push is not worth the complexity.
- Drag-and-drop and `/kanban/move` / `/kanban/dispatch` API paths — they run through
  `moveCardToColumnByPlanFile`/`triggerAction` arms that already end in `_refreshBoard`.
- The slug-stranding hazard itself (unknown non-canonical columns) — unchanged, by design.

## Complexity Audit
### Routine
- Adding `_scheduleBoardRefresh` calls at the end of existing handler branches (the helper
  and debounce already exist).
- Extending bucket initialization by a static three-element list.
### Complex / Risky
- **Refresh-storm guard:** the `moveCards`-handler refresh request (#3) must be one-shot per
  render cycle — a multi-card cascade posts one `moveCards` per role group, and each could
  otherwise request its own refresh.
- **Signature suppression:** `_refreshBoard` skips the `updateColumns` push when
  `_lastColumnsSignature` is unchanged (`KanbanProvider.ts:3253-3257`) — verify the
  signature actually changes when a hidden column becomes occupied (it does: the filtered
  set gains a column), otherwise the fix silently no-ops.
- **Collapse-off path:** when `collapseCodersEnabled` is false there is no CODED_AUTO
  container; the fix must fall through to the refresh request, not crash on a missing
  bucket/container.

## Edge-Case & Dependency Audit
- **Feature cascade:** `moveCards` carries feature + subtask ids; subtasks are render-hidden
  (`!card.featureId` filter at `kanban.html:5750`) so only the feature card's bucketing
  matters — but `currentCards` must still update subtask columns (it does, by id map).
- **BACKLOG remap:** the `_effectiveColumn` remap for backlog view runs before bucketing —
  the new coded-bucket logic must use `effectiveCol` (post-remap), unchanged.
- **Custom hidden columns** (`hideWhenNoAgent` on custom-agent columns, e.g. RESEARCHER,
  TICKET UPDATER, ACCEPTANCE TESTED — `agentConfig.ts:125-132`): not in CODED_IDS, so they
  take the refresh-request path (#3). Verify a prompt-advance into ACCEPTANCE TESTED while
  the tester agent is hidden self-heals the same way.
- **Race with the optimistic move:** the optimistic DOM move may have already relocated the
  card element; the authoritative `updateBoard` re-render replaces the whole board DOM, so
  no reconciliation is needed.
- **Column visibility toggled off while occupied:** `_filterDynamicColumns` keeps occupied
  columns, so cards can't be stranded by a visibility toggle alone.
- **Dependencies:** none on other plans. No verb/endpoint changes → no catalog regen. No
  skill-file changes → no `mirror:check` impact.

## Proposed Changes
### src/services/KanbanProvider.ts
- `promptSelected` case (`:8241`): after the PLAN REVIEWED routing loop's `moveCards`
  postMessages, and after the custom-user branch's postMessages, add
  `this._scheduleBoardRefresh(workspaceRoot);`
- `promptAll` case: same two additions in the mirrored branches.

### src/webview/kanban.html
- Bucketing (`:5752-5758`): initialize `buckets` for `columns` ∪ `CODED_IDS`; bucket
  resolution becomes — visible column → itself; hidden CODED_ID with collapse on → itself
  (flows into the CODED_AUTO merge); hidden CODED_ID with collapse off, or hidden custom
  column → one-shot refresh request + temporary CREATED placement until the push arrives;
  genuinely unknown value → CREATED (unchanged).
- `moveCards` handler (`:6827`): after updating `currentCards`, if
  `!columns.includes(msg.targetColumn)` and not (CODED_ID + collapse on), post one
  `{ type: 'refresh' }` guarded by a `pendingColumnsRefresh` flag cleared on the next
  `updateColumns`/`updateBoard`.

## Verification Plan
(No compilation or automated-test run required for sign-off of this plan; verification is
behavioral.)
### Manual / behavioral
- Repro first: hide the intern agent (AGENT SETUP), empty INTERN CODED, put a complexity-4
  card (or feature) in PLAN REVIEWED, press "Copy coder prompt" → pre-fix it appears in
  CREATED; post-fix it appears in AUTOCODE (collapse on) or INTERN CODED appears as a
  column (collapse off, via refresh), and `GET /kanban/board` shows `INTERN CODED`.
- Feature cascade variant: same press on a feature card → feature card renders correctly;
  subtasks remain hidden; feature file's subtask block shows INTERN CODED.
- Custom hidden column variant: prompt-advance into ACCEPTANCE TESTED with tester hidden →
  column appears (occupied) after the scheduled refresh; card never shows in CREATED.
- Regression: copy-prompt from PLAN REVIEWED with all target columns visible → single clean
  move, no extra flicker from the added refresh (debounced, single push).
- Regression: slug/unknown column value still lands in CREATED bucket (stranding stays
  visible for bad data).

---
**Recommendation:** Complexity 4 → Send to Coder.
