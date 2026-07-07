# Feature card activity light derived from subtask working state + 10-minute timeout

## Goal

Fix the feature-mode activity light: a feature card's `working` flag is currently derived from the
feature row's own `dispatched_at`, but the `**Stage Complete:**` marker clear is plan-file-scoped
and only ever hits subtask rows. There is no path — even with perfect agent compliance — for a
subtask marker to clear the parent feature's `dispatched_at`, so feature cards' lights can only
ever clear via the timeout. Derive the feature card's `working` flag from its subtasks' states
instead (a feature is "working" while any active subtask has a live `dispatched_at`), and reduce
the timeout default from 20 minutes to 10 minutes.

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

**Timeout reduction.** The 20-minute default was a "prefer false-off over stuck-on" trade. With
the derived-down fix, the marker path actually works for feature cards, so the timeout is purely
the backstop for ghosted agents — 10 minutes is a tighter backstop and reduces the
stuck-on-window without being so aggressive that legitimate single-plan runs get false-cleared.
Update the constant, the `package.json` default, and the watcher's fallback default.

## Metadata

- **Project:** Switchboard
- **Tags:** kanban, backend, activity-light, feature-mode
- **Complexity:** 4

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

## User Review Required

- Confirm 10 minutes as the new default (vs. keeping 20 and only fixing the derivation).
- Confirm the feature row's `dispatched_at` should remain set at dispatch (vestigial for the
  light, kept for dispatch-identity) rather than stopping the write entirely.

## Complexity Audit

### Routine
- One new grouped SQL query mirroring the existing `getSubtaskCountsByFeature` shape.
- Three card-build sites: add one map lookup, swap the `working` expression for feature rows.
- Three constant/default value changes (20 → 10 min).

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
feature card's `working` flag.

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

### Recommendation
Complexity 4 → **Send to Coder.**
