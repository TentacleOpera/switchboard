# Activity light: feature-card derivation, optimistic-render guard, 10-minute timeout

## Goal

Fix three activity-light defects:
1. **Feature-card derivation** — a feature card's `working` flag is derived from the feature
   row's own `dispatched_at`, but the `**Stage Complete:**` marker clear is plan-file-scoped and
   only ever hits subtask rows. Derive the feature card's `working` flag from its subtasks'
   states instead (a feature is "working" while any active subtask has a live `dispatched_at`).
2. **Optimistic-render guard swallows the working-flag update** — the webview's 2-second
   optimistic move window (`OPTIMISTIC_MOVE_WINDOW_MS = 2000` at `kanban.html:3906`) absorbs the
   `updateBoard` that carries `working: true` without re-rendering, then updates
   `lastBoardSignature` to match the absorbed data — so no future `updateBoard` triggers a
   re-render either. The light data is in memory but never painted to the DOM. This affects ALL
   dispatch types (prompt, CLI, forward-move), not just one column. Fix the `updateBoard` handler
   to re-render when the `working` flag changed, even during the optimistic window.
3. **Timeout reduction** — reduce the timeout default from 20 minutes to 10 minutes.

### Core problem & root cause

A feature-mode dispatch sets `dispatched_at` on the feature row AND on each subtask row
(`updateDispatchInfoByPlanFile` at `KanbanDatabase.ts:7188-7200` is called once per plan file in
the batch). The directive in the dispatch prompt correctly tells the agent to append
`**Stage Complete:**` to **each** plan file it completes — and a well-behaved agent that only
touched one new subtask writes exactly one marker to that one subtask file. That is correct
compliance, not a failure.

The failure is on the system side. The marker clear path
(`GlobalPlanWatcherService.ts:844-862`) calls `db.clearWorkingState(relativePath, workspaceId)`,
which runs `UPDATE plans SET dispatched_at = NULL WHERE plan_file = ? AND workspace_id = ?`
(`KanbanDatabase.ts:7221-7228`) — it only nulls the row matching that exact plan file. The
parent feature row's `dispatched_at` is never touched by a subtask marker. The feature card's
`working` flag is then computed at card-build time as `isWorkingState(row.dispatchedAt)`
(`KanbanProvider.ts:1596, 3139, 3319`) — reading the **feature row's** `dispatched_at`, which is
still set. So the feature card's light stays on until the 20-minute timeout sweep clears the
feature row.

Observed in production: feature "Webview Action-Button and Layout Consistency" was dispatched
with three subtasks. The agent correctly wrote `**Stage Complete:** PLAN REVIEWED` to the one
new subtask it worked on (`feature_plan_...fix-subtask-edit-button...`). The watcher cleared
that subtask's `dispatched_at` (confirmed `NULL` in the DB). The feature row and the two
untouched subtasks still have `dispatched_at` set — so the feature card's light remained on.

### Design

**Derive down, don't propagate up.** The feature card's `working` flag should be computed as
"any active subtask under this feature has a live `dispatched_at`" — not read from the feature
row's own `dispatched_at`. This:

- Makes the light naturally turn off as the last subtask's marker clears, with zero
  propagation logic in the watcher.
- Gives correct behavior even when the agent only touches a subset of subtask files (the
  untouched subtasks' `dispatched_at` will time out via the sweep, and once all are clear, the
  feature light goes off).
- Keeps the feature row's `dispatched_at` as a dispatch-identity record (still set at dispatch,
  still cleared by the sweep) — it just stops being the source of the feature card's `working`
  flag.

The feature row's `dispatched_at` becomes vestigial for the light. It is still written at
dispatch (no change to `updateDispatchInfoByPlanFile`) and still cleared by the sweep (no change
to `clearStaleWorkingState`) — leaving it set does no harm, and removing the write would be a
larger, riskier change with no benefit.

**Optimistic-render guard swallows the working-flag update.** The webview's `updateBoard`
handler (`kanban.html:6520-6557`) has a 2-second optimistic move window
(`OPTIMISTIC_MOVE_WINDOW_MS = 2000` at `kanban.html:3906`). When an `updateBoard` message
arrives during this window, the handler absorbs the data into `currentCards` but does NOT call
`renderBoard` — it updates `lastBoardSignature = buildBoardSignature(currentCards)` and returns.
This is designed to prevent a stale `updateBoard` (carrying pre-move column positions) from
snapping a dragged card back to its source column.

The problem: the board refresh that carries `working: true` is debounced at only 100ms
(`_scheduleBoardRefresh` at `KanbanProvider.ts:3436`). So the `updateBoard` with the
working-flag arrives at ~100ms — well within the 2-second optimistic window. The handler
absorbs the data (so `currentCards` has `working: true`) but doesn't render it. Then it updates
`lastBoardSignature` to match the absorbed data. After the 2-second window expires, the next
`updateBoard` has the same data → `nextBoardSignature === lastBoardSignature` → no re-render.
The light is stuck: data says `working: true`, DOM never got the update, and the signature
match prevents any future re-render from picking it up.

This affects ALL dispatch types (prompt, CLI, forward-move) and ALL columns — not just CODE
REVIEWED. The user noticed it on a prompt-mode drop to CODE REVIEWED, but the root cause is in
the webview's render guard, not in any specific dispatch path.

The fix: in the `updateBoard` handler, during the optimistic absorb path, detect whether the
`working` flag changed for any card. If it did, force a `renderBoard(nextCards)` even during
the optimistic window. The column position is already correct in `nextCards` (the server-side
move completed before the board refresh), so there's no revert risk — the optimistic guard's
concern (stale pre-move positions) doesn't apply to the `working` flag.

## Metadata

- **Project:** Switchboard
- **Tags:** kanban, backend, activity-light, feature-mode, webview, render-guard
- **Complexity:** 5

## Implementation

1. **Add a workspace-wide "feature working states" query.** In `KanbanDatabase.ts`, add
   `getFeatureWorkingStates(workspaceId): Promise<Map<string, boolean>>` near
   `getSubtaskCountsByFeature` (`KanbanDatabase.ts:4656-4676`). One grouped query:

   ```sql
   SELECT feature_id AS featureId,
          MAX(dispatched_at IS NOT NULL AND dispatched_at >= ?) AS anyWorking
   FROM plans
   WHERE workspace_id = ? AND feature_id IS NOT NULL AND feature_id != ''
     AND status = 'active' AND is_feature = 0
   GROUP BY feature_id
   ```

   The cutoff (`?`) is `new Date(Date.now() - timeoutMs).toISOString()` — same ISO-UTC
   comparison as `clearStaleWorkingState` (`KanbanDatabase.ts:7236-7252`). This keeps the
   read-time check and the sweep in sync: a subtask whose `dispatched_at` is older than the
   timeout reads as "not working" here AND gets nulled by the next sweep. Return a
   `Map<featureId, boolean>`.

   **Why a separate query and not a join into the card-build query:** the card-build query
   (`getBoardFilteredByProject`) is already project/repo-filtered; subtask working state must be
   workspace-wide (a feature's subtasks can live in any project, mirroring the
   `getSubtaskCountsByFeature` rationale at `KanbanDatabase.ts:4648-4654`). A grouped query is
   one extra round-trip per refresh, same shape as the existing `getSubtaskCountsByFeature` call
   that already runs at every card-build site.

2. **Use the feature working-states map at all three card-build sites.** At each site that
   already calls `getSubtaskCountsByFeature`, also call `getFeatureWorkingStates(workspaceId)`
   and use it to compute the `working` flag for feature rows (`isFeature === true`):

   - **Site 1** (`KanbanProvider.ts:1578-1598`): `subtaskCountMap` is read at 1578; add the
     working-states map alongside it. For feature rows, `working: featureWorkingMap.get(row.planId) ?? false`.
     For non-feature rows, keep `working: isWorkingState(row.dispatchedAt)` unchanged.
   - **Site 2** (`KanbanProvider.ts:3121-3141`): `subtaskCountMap2` at 3121; mirror the same
     pattern.
   - **Site 3** (`KanbanProvider.ts:3307-3321`): this site does NOT currently call
     `getSubtaskCountsByFeature` (it's the simpler board path that doesn't render subtask
     counts). Add the `getFeatureWorkingStates` call here too — feature cards still render on
     this path and their `working` flag must be derived, not read from the feature row. If the
     DB is unavailable, fall back to `isWorkingState(row.dispatchedAt)` (the old behavior) so a
     DB error doesn't blank all feature lights.

   The completed-rows builders (1600-1614, 3145-3159, 3323-3334) do not set `working` at all —
   no change needed there.

3. **Reduce the timeout default from 20 min to 10 min.** Three sites reference the default:

   - `KanbanProvider.ts:128`: `DEFAULT_WORKING_STATE_TIMEOUT_MS = 20 * 60 * 1000` →
     `10 * 60 * 1000`. This is the read-time fallback used by `isWorkingState` (134) and,
     after this change, by the new `getFeatureWorkingStates` cutoff.
   - `GlobalPlanWatcherService.ts:175`: `activityConfig.get<number>('timeoutMs', 20 * 60 * 1000)`
     → fallback `10 * 60 * 1000`.
   - `package.json:511`: `"default": 1200000` → `600000`. Update the description text
     ("Default 20 minutes" → "Default 10 minutes").

   The `minimum` (60000) and `maximum` (3600000) in `package.json:512-513` stay — they bound
   the user's override range, not the default.

4. **Fix the optimistic-render guard in the webview's `updateBoard` handler.** In
   `kanban.html:6539-6550`, during the optimistic absorb path (`optimisticActive === true`),
   detect whether the `working` flag changed for any card between `currentCards` and `nextCards`.
   If it did, force a `renderBoard(nextCards)` even during the optimistic window. The column
   position is already correct in `nextCards` (the server-side move completed before the board
   refresh), so there's no revert risk.

   Implementation: before the `if (optimisticActive)` branch, compute a `workingChanged` flag
   by comparing the `working` field of each card in `nextCards` against the corresponding card
   in `currentCards` (matched by `planId || sessionId`). If `workingChanged` is true, fall
   through to the normal `renderBoard(nextCards)` path instead of the absorb path. This is a
   targeted exception — the optimistic guard still protects column positions, but the
   `working` flag is always rendered promptly.

   ```javascript
   const optimisticActive = Date.now() < optimisticMoveUntil;
   const workingChanged = nextCards.some(nc => {
       const cur = currentCards.find(cc =>
           (cc.planId || cc.sessionId) === (nc.planId || nc.sessionId)
       );
       return !!cur && !!nc.working !== !!cur.working;
   });
   if (nextBoardSignature !== lastBoardSignature) {
       if (optimisticActive && !workingChanged) {
           // Absorb but don't render (existing behavior)
           currentCards = nextCards;
           lastBoardSignature = buildBoardSignature(currentCards);
       } else {
           lastBoardSignature = nextBoardSignature;
           renderBoard(nextCards);
       }
   }
   ```

## User Review Required

- Confirm 10 minutes as the new default (vs. keeping 20 and only fixing the derivation).
- Confirm the feature row's `dispatched_at` should remain set at dispatch (vestigial for the
  light, kept for dispatch-identity) rather than stopping the write entirely.
- Confirm the optimistic-guard fix should force-render on `working` changes (not shorten the
  optimistic window or remove the signature update).

## Complexity Audit

### Routine
- One new grouped SQL query mirroring the existing `getSubtaskCountsByFeature` shape.
- Three card-build sites: add one map lookup, swap the `working` expression for feature rows.
- Three constant/default value changes (20 → 10 min).
- One `workingChanged` check + conditional in the webview `updateBoard` handler.
- Three drag-drop CLI paths: add one `_recordDispatchIdentity` call per dispatched sid.

### Complex / Risky
- **Site 3 has no existing subtask-count call.** Adding `getFeatureWorkingStates` here is a new
  DB round-trip on a path that currently doesn't make one — verify it's inside the
  `db && await db.ensureReady()` guard (the site at 3307 is within the branch that already has
  a `db` handle from the active-rows query; confirm before adding the call).
- **Empty-feature edge case.** A feature with zero active subtasks (all completed or none yet
  linked) yields no row in the grouped query, so the map returns `false` → feature light is
  off. This is correct: a feature with no in-flight subtasks is not "working." But verify a
  freshly-dispatched feature whose subtasks haven't been imported yet doesn't briefly show
  off-then-on (the dispatch sets subtask `dispatched_at` in the same batch, so by the next
  refresh the subtasks exist and the map picks them up).
- **Timeout/sweep sync.** The `getFeatureWorkingStates` cutoff must use the same
  `switchboard.activityLight.timeoutMs` setting the sweep uses — read it from the same config
  key, defaulting to the new 10-min constant. If the read-time check and the sweep diverge on
  the timeout value, a subtask could read as "not working" while its `dispatched_at` is still
  set (or vice versa).

## Edge-Case & Dependency Audit

- **Feature with subtasks across projects.** The grouped query is workspace-wide (unfiltered by
  project/repo), matching `getSubtaskCountsByFeature` — a feature's working state is intrinsic,
  not board-view-dependent.
- **Completed subtasks.** The query filters `status = 'active' AND is_feature = 0`, so
  completed subtasks don't keep a feature light on. (Completed subtasks have `dispatched_at`
  nulled by the completion path anyway, but the filter is belt-and-suspenders.)
- **Feature row's own `dispatched_at` after this change.** Still set at dispatch, still swept at
  timeout. No code reads it for the `working` flag after this change (for feature rows). It
  remains in the DB as a dispatch timestamp — harmless.
- **Non-feature cards.** Unchanged — `working: isWorkingState(row.dispatchedAt)` still reads the
  row's own `dispatched_at`. The derivation only applies to `isFeature === true` rows.
- **DB unavailable fallback.** Site 3's path and any error path must fall back to
  `isWorkingState(row.dispatchedAt)` so a transient DB failure doesn't blank feature lights
  silently.

## Dependencies

- None upstream — this is a fix to the existing activity-light feature
  (`working-state-model-and-dispatch-on.md`, `stage-complete-marker-clears-working-state.md`,
  `working-state-timeout-sweep.md`, `card-working-light-ui.md`).
- No schema change — uses the existing `dispatched_at`, `feature_id`, `is_feature`, `status`
  columns.

## Proposed Changes

### src/services/KanbanDatabase.ts
- **Context:** owns `dispatched_at` and the subtask-count query (`getSubtaskCountsByFeature` at
  4656-4676).
- **Logic:** add `getFeatureWorkingStates(workspaceId, timeoutMs): Promise<Map<string, boolean>>`
  immediately after `getSubtaskCountsByFeature`. Grouped query over active non-feature rows with
  `feature_id`, returning `MAX(dispatched_at IS NOT NULL AND dispatched_at >= cutoff)` per
  feature. Cutoff is `new Date(Date.now() - timeoutMs).toISOString()`.
- **Edge cases:** empty result for a workspace with no subtasks → empty map (callers default to
  `false`); ISO-UTC string comparison (same convention as `clearStaleWorkingState`).

### src/services/KanbanProvider.ts
- **Context:** three card-build sites (1578-1598, 3121-3141, 3307-3321) and the
  `DEFAULT_WORKING_STATE_TIMEOUT_MS` constant at 128.
- **Logic:**
  - Change `DEFAULT_WORKING_STATE_TIMEOUT_MS` from `20 * 60 * 1000` to `10 * 60 * 1000`.
  - Site 1 (1578): add `const featureWorkingMap = await db.getFeatureWorkingStates(workspaceId ?? '', DEFAULT_WORKING_STATE_TIMEOUT_MS);`
    alongside the `subtaskCountMap` call. For feature rows in the `.map`, use
    `working: row.isFeature ? (featureWorkingMap.get(row.planId) ?? false) : isWorkingState(row.dispatchedAt)`.
  - Site 2 (3121): mirror site 1.
  - Site 3 (3307): add the `getFeatureWorkingStates` call (this site has no existing
    subtask-count call — add it inside the `db && ensureReady` guard). Same conditional
    `working` expression. On DB error, fall back to `isWorkingState(row.dispatchedAt)`.
- **Edge cases:** non-feature rows unchanged; completed-rows builders unchanged; DB-unavailable
  fallback preserves old behavior.

### src/services/GlobalPlanWatcherService.ts
- **Context:** the timeout sweep fallback default at line 175.
- **Logic:** change `20 * 60 * 1000` → `10 * 60 * 1000` in the
  `activityConfig.get<number>('timeoutMs', ...)` fallback.
- **Edge cases:** none — the live setting is still read first; only the fallback changes.

### package.json
- **Context:** `switchboard.activityLight.timeoutMs` declaration at 509-516.
- **Logic:** `"default": 1200000` → `"default": 600000`; update description
  "Default 20 minutes" → "Default 10 minutes".
- **Edge cases:** `minimum` (60000) and `maximum` (3600000) unchanged — user overrides still
  bounded. Existing users who never touched the setting get the new 10-min default on next
  config read; users who explicitly set a value keep theirs.

### src/webview/kanban.html — updateBoard handler (6539-6557)
- **Context:** the `updateBoard` message handler. During the 2-second optimistic move window
  (`optimisticActive`), it absorbs `nextCards` into `currentCards` without calling
  `renderBoard`, then updates `lastBoardSignature` to match — preventing stale pre-move
  `updateBoard` data from reverting a drag. The board refresh that carries `working: true` is
  debounced at 100ms, so it arrives well within the 2-second window and gets swallowed.
- **Logic:** before the `if (optimisticActive)` branch, compute `workingChanged` by comparing
  the `working` field of each card in `nextCards` against `currentCards` (matched by
  `planId || sessionId`). If `workingChanged` is true, fall through to the normal
  `renderBoard(nextCards)` path instead of the absorb path. Change the condition from
  `if (optimisticActive)` to `if (optimisticActive && !workingChanged)`.
- **Edge cases:** the `workingChanged` check is O(n) over the card set but the board is
  typically <200 cards and the check only runs when `nextBoardSignature !== lastBoardSignature`
  (already gated above); cards in `nextCards` without a match in `currentCards` (new card)
  don't trigger `workingChanged` — they'll be handled by the normal signature-mismatch
  render after the optimistic window expires, which is correct (a new card appearing is not a
  working-flag transition).

## Adversarial Synthesis

Key risks: (1) **site 3 is a new DB round-trip on a path that didn't have one** — if the path
is hot (e.g. a refresh storm), the extra query adds latency; mitigation is that the query is a
single grouped `SELECT` with no joins, mirroring the already-present
`getSubtaskCountsByFeature` cost on the other two sites, and the refresh-storm backstop
(snapshot-hash skip) at `KanbanProvider.ts:186` gates the push, not the query. (2) **the
read-time cutoff and the sweep must agree on the timeout** — if `getFeatureWorkingStates` reads
the setting at query time and the sweep reads it 10 seconds later and the user changed it
in between, a subtask could flicker; mitigation is that both read the same config key with the
same fallback constant, and the divergence window is one scan interval (≤10s) — acceptable.
(3) **a feature with subtasks in a different project than the board filter** — the grouped
query is workspace-wide, so the feature light correctly reflects subtask state regardless of
the board's project filter; this matches `getSubtaskCountsByFeature`'s established pattern.
(4) **the feature row's `dispatched_at` is now vestigial for the light but still written** —
a future maintainer might "clean up" by removing the write and break the dispatch-identity
record; mitigation is the comment at `KanbanDatabase.ts:7194-7196` already documents the
column's purpose — extend it to note the feature-row value is no longer the source of the
feature card's `working` flag. (5) **the `workingChanged` exception to the optimistic guard
could cause a full `renderBoard` during a drag if a timeout sweep clears a different card's
light while the user is mid-drag** — mitigation is that `renderBoard` is a DOM replacement of
the board body, not the drag handles, and the 100ms debounce means the `updateBoard` arrives
after the user has already dropped the card (the drag-end → drop → postMessage → backend
processing chain takes >100ms); if it does fire mid-drag, the card positions in `nextCards`
match the server-side state which is already post-move, so there's no visual revert.

## Verification Plan

> Per session directives: no automated tests, no compilation. Verify via the installed VSIX.

### Manual checks
- Dispatch a feature with 3 subtasks → confirm the feature card's light turns ON.
- Agent writes `**Stage Complete:**` to ONE subtask file → confirm that subtask's row
  `dispatched_at` is NULLed (existing behavior) and the feature card's light STAYS ON (two
  subtasks still working).
- Agent writes markers to the remaining two subtask files → confirm the feature card's light
  turns OFF promptly after the last subtask's marker is parsed (no 10-min wait).
- Dispatch a feature, do NOT write any markers → confirm the feature card's light turns OFF
  within ~10 min + one scan interval (~10s) via the timeout sweep (the sweep nulls the
  subtasks' `dispatched_at`, the next refresh's `getFeatureWorkingStates` reads all-false).
- Confirm a non-feature (single-plan) card's light still turns off on its own marker (no
  regression — non-feature rows still use `isWorkingState(row.dispatchedAt)`).
- Set `switchboard.activityLight.timeoutMs` to a small value (e.g. 30s) → confirm a dispatched
  feature's light clears at ~30s+10s, proving the setting is honored by the derived path.
- Confirm a feature with subtasks across different projects reflects working state correctly
  when the board is filtered to one project.
- Confirm a freshly-dispatched feature (subtasks just imported) shows the light ON on the
  first refresh after dispatch (no off-then-on flicker).
- **Optimistic guard fix:** drag-drop a card to CODE REVIEWED in prompt mode → confirm the
  light appears within ~1 second (not stuck off until the next unrelated refresh).
- **Optimistic guard fix:** drag-drop a card to any column in CLI mode → confirm the light
  appears promptly.
- **Optimistic guard regression:** drag-drop a card → confirm the card does NOT snap back to
  its source column during the 2-second optimistic window (the guard still protects column
  position; only the `working` flag bypasses it).
- **Optimistic guard + timeout interaction:** dispatch a card, wait for the light to appear,
  then wait 10 min → confirm the light turns off (the timeout sweep nulls `dispatched_at`, the
  next `updateBoard` carries `working: false`, `workingChanged` is true, re-render fires).

### Recommendation
Complexity 5 → **Send to Coder.**
