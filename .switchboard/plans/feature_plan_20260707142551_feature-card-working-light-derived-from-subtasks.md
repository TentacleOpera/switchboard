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

## Verified Corrections (2026-07-07 review)

> Authoritative — supersedes any stale line-number or liveness citation in the original
> Implementation / Proposed Changes text below (original prose preserved per the
> improve-plan content-preservation rule). All line numbers re-verified against current `src/`.

### Card-build site liveness (the single most important correction)

The original plan frames **three live card-build sites** of equal weight. Verified reality:

| Site | Method (file:line) | `working:` line | Liveness | Action |
|------|--------------------|-----------------|----------|--------|
| **Site 1** | `refreshWithData` (`KanbanProvider.ts:1499`) | 1596 | **LIVE — sole production path** | **Critical fix.** This is the only site that paints production cards. |
| **Site 2** | `_refreshBoardImpl` (`KanbanProvider.ts:3015`) | 3139 | **TEST-ONLY** | Apply for test consistency (cheap); no production effect. |
| **Site 3** | `_refreshBoardWithData` (`KanbanProvider.ts:3263`) | 3319 | **DEAD CODE** | Apply as future-proofing only; no runtime effect. |

**Evidence:**
- Production refresh chain: `_refreshBoard` (`KanbanProvider.ts:2997`) does **not** build cards — it
  calls `vscode.commands.executeCommand('switchboard.refreshUI', …)` (3008). That command
  (`extension.ts:1208`) routes to `taskViewerProvider.refreshUI` → `TaskViewerProvider` reads the DB
  once and calls `kanbanProvider.refreshWithData(...)` (`TaskViewerProvider.ts:15785`) → **Site 1**.
  The code's own comment at `KanbanProvider.ts:3004-3007` states this explicitly: "ALL kanban
  refreshes go through the unified path… This eliminates the dual-path bug where
  `_refreshBoardImpl` could show different data."
- `_refreshBoardImpl` (Site 2) has **zero production call sites** — only `__tests__/KanbanProvider.test.ts:624`
  and `test/kanban-persistence.test.ts:147,189` call it (plus comments/log strings).
- `_refreshBoardWithData` (Site 3) has **zero call sites anywhere** — only its own definition at
  3263. Its docstring (`KanbanProvider.ts:3260-3261`) says: "NOTE: This method is currently dead
  code (zero call sites). The active refresh path is the public `refreshWithData()` method. Kept
  for potential future use."

**Consequence for the fix:** the `getFeatureWorkingStates` derivation must be applied to **Site 1**
to fix production. Applying it to Site 2 keeps the test suite from diverging; applying it to Site 3
is pure future-proofing (a 2-line mirror — recommended so a future revival of the dead path does not
reintroduce the bug, but understand it has zero runtime effect today). The original "Complex / Risky"
worry that "Site 3 is a new DB round-trip on a hot path" is **invalid** — the path is not hot, it is
not even reachable. The "DB unavailable fallback" guard for Site 3 is likewise guarding dead code.

### Stale `KanbanDatabase.ts` line numbers (code shifted ~163 lines)

The root-cause analysis and SQL are correct, but every `KanbanDatabase.ts` citation in the original
text is stale. Current verified locations:

| Symbol | Plan said | Actual (current) |
|--------|-----------|------------------|
| `getSubtaskCountsByFeature` | 4656-4676 | **4655-4675** |
| `updateDispatchInfoByPlanFile` | 7188-7200 | **7351-7364** |
| `clearWorkingState` | 7221-7228 | **7384-7390** |
| `clearStaleWorkingState` | 7236-7252 | **7399-7417** |
| dispatched_at purpose comment | 7194-7196 | **7357-7359** |

`GlobalPlanWatcherService.ts` (844-863 marker-clear path, 175 timeout fallback), `KanbanProvider.ts`
(128 constant, 130 `isWorkingState`, 1578/3121 subtask-count calls, 1596/3139/3319 working-flag
lines, 3432-3440 `_scheduleBoardRefresh` w/ 100ms debounce at 3439), `kanban.html` (3906
`OPTIMISTIC_MOVE_WINDOW_MS=2000`, 6520-6563 `updateBoard` handler, 6539 `optimisticActive`), and
`package.json` (509-516, 511 default 1200000, 512 min 60000, 513 max 3600000) all verified correct.

### Optimistic-guard fix depends on a coupling the original plan never verified

The `workingChanged` fix only works because `buildBoardSignature` (`kanban.html:4697`) includes
`${card.working ? '1' : '0'}` — so a working-flag transition flips `nextBoardSignature` and enters
the `if (nextBoardSignature !== lastBoardSignature)` branch where `workingChanged` is consulted.
**Verified:** the coupling holds today. **Risk:** if a future maintainer drops `working` from
`buildBoardSignature`, the fix silently stops working (a working-only change would no longer alter
the signature, fall into the signature-equal `else` branch at 6556, and skip `renderBoard`).
**Mitigation:** add a comment at `buildBoardSignature` tying `working` inclusion to the
`workingChanged` guard in the `updateBoard` handler. Also: move the `workingChanged` computation
*inside* the `if (nextBoardSignature !== lastBoardSignature)` block — the original snippet computes
it unconditionally (an O(n²) `some`+`find` over the card set on every `updateBoard`, even when the
signature matches and the result is unused).

### Proposed-query prose inaccuracy (cosmetic)

The proposed `getFeatureWorkingStates` query does **not** mirror `getSubtaskCountsByFeature`'s
`WHERE` clause — it correctly diverges. Mirror uses `status IN ('active','completed')` and no
`is_feature` filter (counts all subtask-bearing rows). The working-state query uses
`status = 'active' AND is_feature = 0` — which is **more correct** for working state (excludes
completed subtasks whose `dispatched_at` is already nulled, and excludes feature rows themselves,
which carry their own vestigial `dispatched_at`). It mirrors the *workspace-wide grouping shape*,
not the filter. The `is_feature = 0` filter is mostly redundant (feature rows have
`feature_id = NULL`/empty and are already excluded by `feature_id IS NOT NULL AND feature_id != ''`)
but harmless belt-and-suspenders. State the divergence explicitly rather than claiming a mirror.

## Metadata

- **Project:** Switchboard
- **Tags:** backend, frontend, ui, bugfix, reliability
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
- **Review correction (2026-07-07):** place the new method immediately after
  `getSubtaskCountsByFeature` at its **current** location `KanbanDatabase.ts:4655-4675` (the
  original "4656-4676" citation is off by one). Reuse the mirror's `ensureReady()`/`_db` guard and
  `stmt.step()` / `getAsObject()` / `stmt.free()` pattern. The grouped query's `WHERE` deliberately
  diverges from the mirror (see "Proposed-query prose inaccuracy" above) — keep
  `status = 'active' AND is_feature = 0`. SQLite semantics confirmed: `(dispatched_at IS NOT NULL)
  AND (dispatched_at >= ?)` is always 0/1 per row (left operand is never NULL), so `MAX(...)` per
  feature is a clean boolean — no NULL-ambiguity edge case.

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
- **Review correction (2026-07-07) — site liveness (see Verified Corrections):** only **Site 1**
  (`refreshWithData`, `1578`/`1596`) is the production path — this is the critical fix. **Site 2**
  (`_refreshBoardImpl`, `3121`/`3139`) is test-only (production routes through `switchboard.refreshUI`
  → `refreshWithData`); apply the mirror there only to keep tests consistent. **Site 3**
  (`_refreshBoardWithData`, `3307`/`3319`) is dead code (zero call sites); applying the call there is
  future-proofing with no runtime effect — there is no live "DB unavailable fallback" to protect and
  no "hot path" round-trip to worry about. The proposed `working` expression
  `row.isFeature ? (featureWorkingMap.get(row.planId) ?? false) : isWorkingState(row.dispatchedAt)`
  is correct for all three; just understand only Site 1 moves production cards.

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
- **Review correction (2026-07-07):** the fix is structurally sound **only because**
  `buildBoardSignature` (`kanban.html:4697`) includes `${card.working ? '1' : '0'}` — without that,
  a working-only change would not flip `nextBoardSignature` and would bypass this whole branch
  (falling into the signature-equal `else` at 6556). (1) Add a comment at `buildBoardSignature`
  tying `working` inclusion to this `workingChanged` guard so a future cleanup cannot silently break
  it. (2) Move the `workingChanged` computation **inside** the
  `if (nextBoardSignature !== lastBoardSignature)` block (the original snippet runs it
  unconditionally on every `updateBoard`, wasting the `some`+`find` when the signature matches and
  the result is unused). (3) Optional O(n) refinement: build a `Map<planId||sessionId, boolean>` from
  `currentCards` once instead of `find` per `nextCards` entry — not required at <200 cards.

## Adversarial Synthesis

Key risks: (1) the original plan over-counts live card-build sites — only **Site 1**
(`refreshWithData`, `KanbanProvider.ts:1596`) is the production path (Site 2 `_refreshBoardImpl` is
test-only, Site 3 `_refreshBoardWithData` is dead code with zero call sites), so the fix's real
blast radius is one site and the cited `KanbanDatabase.ts` line numbers are ~163 lines stale
(`updateDispatchInfoByPlanFile` 7188→7351, `clearWorkingState` 7221→7384, `clearStaleWorkingState`
7236→7399); (2) the optimistic-guard fix silently depends on `working` remaining in
`buildBoardSignature` (`kanban.html:4697`), so a future cleanup that drops it would re-break the
light with no compile error; (3) the feature row's `dispatched_at` becomes vestigial for the light
but is still written, inviting a well-meaning "cleanup" that deletes the dispatch-identity record.
Mitigations: apply the `getFeatureWorkingStates` derivation to Site 1 as the critical fix and mirror
to Sites 2/3 for consistency/future-proofing only (no production effect); refresh all line numbers
against current `src/`; add a coupling comment at `buildBoardSignature` tying `working` inclusion to
the `workingChanged` guard; extend the `dispatched_at` purpose comment
(`KanbanDatabase.ts:7357-7359`) to note the feature-row value no longer drives the `working` flag.
Secondary (covered by Manual checks): a `workingChanged`-forced `renderBoard` could fire mid-drag if
a timeout sweep clears another card's light during a 2s optimistic window — safe because
`nextCards` carries post-move positions and `renderBoard` replaces the board body, not drag handles.

## Verification Plan

> Per session directives: no automated tests, no compilation. Verify via the installed VSIX.

### Automated Tests

Skipped per session directive (no automated test run as part of this verification plan). Note for
the implementer: `_refreshBoardImpl` (Site 2, `KanbanProvider.ts:3139`) is exercised only by
`src/services/__tests__/KanbanProvider.test.ts` and `src/test/kanban-persistence.test.ts`. If the
derivation is mirrored into Site 2, those tests continue to call `_refreshBoardImpl` directly and
should be reviewed (not run here) to confirm they do not assert the old feature-row-read
`working` behavior — otherwise they will diverge from the live `refreshWithData` (Site 1) path.
Production correctness is verified solely via the Manual checks below against an installed VSIX.

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

**Stage Complete:** PLAN REVIEWED

**Stage Complete:** CODED
