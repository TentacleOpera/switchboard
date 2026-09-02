# A Team Lead's Terminal Header Names The Feature It Was Dispatched

## Goal

When a feature is dispatched to a team lead, the lead's terminal frame header should name the feature — the same way each coder's header names the subtask it received. Today the coders are labelled and the lead is blank.

### Problem Analysis & Root Cause

**The header comes from one shared matcher.** `attributePlansToTerminals` (`src/services/terminalPlanAttribution.ts`) maps terminal → `{planId, planTitle}` and is fed by `KanbanDatabase.getLiveDispatchAttribution`. Its two tiers are name-match then unambiguous-worktree-path, with a deliberate absence of any role-only tier — the module's own comment is explicit that "no title beats a wrong title", and that reasoning is correct and must survive this change.

**The gate that excludes features.** `getLiveDispatchAttribution` (`KanbanDatabase.ts:10699`):

```sql
SELECT plan_id, topic, dispatched_terminal, dispatched_at, feature_id, project
  FROM plans
 WHERE workspace_id = ? AND status = 'active'
   AND dispatched_at IS NOT NULL
 ORDER BY dispatched_at DESC
```

Features are rows in `plans` (`is_feature = 1`), so nothing excludes them *by kind*. They are excluded by `dispatched_at IS NOT NULL`.

**Measured on the live board:**

|| | rows | ever had `dispatched_at` | non-empty `dispatched_terminal` |
|---|---|---|---|---|
| plans (`is_feature=0`) | 2,649 | 2 currently | **539** |
| features (`is_feature=1`) | 318 | **0** | **111** |

So 111 features carry a terminal name and **not one feature has a dispatch timestamp**. The terminal is recorded; the timestamp that makes it visible to the matcher is not. That asymmetry is the whole bug — the lead's seat is already attributed in the row, and the query throws the row away.

**Why terminal and timestamp diverge — CORRECTED analysis.** Every writer of `dispatched_terminal` also writes `dispatched_at` in the same SQL statement:

- `attributePasteDispatch` (`KanbanDatabase.ts:10258`): `SET dispatched_agent = ?, dispatched_terminal = ?, dispatched_at = ?` — one UPDATE, both fields.
- `updateDispatchInfoByPlanFile` (`KanbanDatabase.ts:10216`): `SET routed_to = ?, dispatched_agent = ?, dispatched_ide = ?, dispatched_terminal = ?, dispatched_at = ?` — one UPDATE, both fields.

There is **no code path** that sets `dispatched_terminal` without also setting `dispatched_at`. Therefore the 111 features with `dispatched_terminal` but no `dispatched_at` were stamped with both at dispatch time, then `dispatched_at` was **cleared afterward** while `dispatched_terminal` was preserved. This is mechanism (b) — "stamped and then wiped" — and it is the dominant mechanism. Mechanism (a) alone ("never stamped") cannot produce a row with `dispatched_terminal` set, because every stamp writes both fields together.

> **Superseded:** `dispatched_at` is not on the [preserved-by-omission] list — it is in the upsert's columns. So a plan-file re-import writes `dispatched_at` and leaves `dispatched_terminal` alone. Any re-import while a dispatch is live clears the timestamp and keeps the seat, producing exactly the terminal-without-timestamp rows counted above.
>
> **Reason:** This conflates "in the INSERT column list" with "updated on conflict." The file-watcher re-import path (`insertFileDerivedPlan`, `KanbanDatabase.ts:2514-2543`) does NOT include `dispatched_at` in its INSERT columns OR its ON CONFLICT DO UPDATE SET clause — it preserves `dispatched_at` by omission, exactly like `dispatched_terminal`. The backup-restore upsert (`UPSERT_PLAN_SQL`, `KanbanDatabase.ts:946-998`) does list `dispatched_at` in its INSERT columns, but its ON CONFLICT DO UPDATE SET clause (lines 955-998) does NOT reference `dispatched_at` — so on conflict it is also preserved. Neither upsert path nulls `dispatched_at`. The re-import hypothesis was wrong.
>
> **Replaced with:** The actual clearing paths that null `dispatched_at` while preserving `dispatched_terminal` are:

**The clearing paths (the real mechanism):**

1. **`cascadeFeatureByPlanId`** (`KanbanDatabase.ts:6810`) — **PRIMARY CULPRIT.** Moves the feature row itself to a new column: `UPDATE plans SET kanban_column = ?, ... dispatched_at = NULL, last_liveness_at = NULL, blocked_at = NULL WHERE plan_id = ?`. This nulls `dispatched_at` on the feature row while leaving `dispatched_terminal` untouched. This function is called on **every feature column transition** — dispatch to coding, completion, restore, send-back-for-fixes — which happens constantly during exactly the run whose header we care about. Call sites: `KanbanProvider.ts:8505, 8889, 12374, 12405, 12447, 12499, 12518, 13092`; `TaskViewerProvider.ts:5936, 17163, 19695`; `bootstrap.ts:1454`.

2. **`clearWorkingState`** (`KanbanDatabase.ts:10288`) — `UPDATE plans SET dispatched_at = NULL, last_liveness_at = NULL, blocked_at = NULL WHERE plan_file = ? AND workspace_id = ? AND dispatched_at IS NOT NULL`. Called by the plan watcher on stage-complete marker parse and by the LocalApiServer queue/done handler (`LocalApiServer.ts:3316`). Preserves `dispatched_terminal`.

3. **`clearStaleWorkingState`** (`KanbanDatabase.ts:10765, 10777`) — timeout backstop. Nulls `dispatched_at` on rows whose age basis exceeds the cutoff, and force-clears rows whose terminal has exited. Preserves `dispatched_terminal`.

4. **`updateColumnByPlanFile`** (`KanbanDatabase.ts:2664`) — column move by plan_file. Nulls `dispatched_at`, preserves `dispatched_terminal`.

**The design tension (root cause of the root cause).** `dispatched_at` serves **double duty**: it is both (a) the dispatch-identity timestamp that `getLiveDispatchAttribution` filters on, and (b) the activity-light "working" flag that column transitions, stage completions, and timeouts clear. The comment at `KanbanDatabase.ts:10212` acknowledges this explicitly:

> *NOTE: For feature cards, the working flag is derived from subtasks' dispatched_at values, but we still write/clear the feature row's own dispatched_at for dispatch-identity.*

The system knows the feature's working flag comes from subtasks, yet it still clears the feature row's `dispatched_at` on column moves — destroying the dispatch-identity signal that the attribution matcher needs. For a regular plan, clearing `dispatched_at` on a column move is correct (the coder is done with that stage). For a feature, the lead is still driving the feature across multiple subtask cycles and column transitions — clearing `dispatched_at` on each move makes the feature invisible to the matcher for the entire run except the brief window between dispatch and the first column transition.

**A test asserts the clearing is intentional.** `completion-asserted-never-inferred.test.js:295` asserts `cascadeFeatureByPlanId` clears `dispatched_at` for both the feature and its subtasks (`clears.length === 2`). Any fix that changes this behavior must update this test.

**Mechanism (a) may still contribute.** The extension's strict attribution branch (`TaskViewerProvider.ts:681`) passes `planIds: planId ? [planId] : []` — a single id. If a feature dispatch passes a subtask's id (or none) instead of the feature's own planId, the feature row is never stamped by this path. The fire-and-forget path (`TaskViewerProvider.ts:1240`) uses `extractDispatchIdentity` which scans the prompt body for ALL `PLAN_ID=...` entries, so it would catch the feature id if the prompt includes it. But the strict path is single-id. This means mechanism (a) could cause the feature to never get `dispatched_at` on the extension host — but even if it does get stamped, mechanism (b) (the column-move cascade) will clear it on the next transition. Both may be active; (b) is the one that guarantees the bug persists for the entire run.

**Not a display bug.** `TaskViewerProvider.ts:3782` already renders `planMap.get(t.friendlyName)?.planTitle ?? null` for every seat without caring what kind of card it came from. Give the matcher a feature row and the lead's header renders with no UI change at all.

## Metadata
**Topic:** Team lead terminal header shows the dispatched feature name
**Tags:** bugfix, kanban, terminals, dispatch, attribution
**Complexity:** 6

## User Review Required

None.

## Complexity Audit

### Routine
- Reading the attribution query and matcher — both are small, well-commented functions.
- Verifying that the render path (`TaskViewerProvider.ts:3782`) already handles feature titles without UI changes.
- Confirming `dispatched_terminal` is preserved across all clearing paths (it is — by omission from every clearer's SET clause).

### Complex / Risky
- **The `dispatched_at` dual-purpose conflict.** `dispatched_at` is both the attribution filter key and the activity-light working flag. Any fix that stops clearing it on feature column moves must not break the working-state semantics that the completion broadcast, timeout backstop, and board activity light depend on.
- **The test at `completion-asserted-never-inferred.test.js:295`** asserts `cascadeFeatureByPlanId` clears `dispatched_at` for both feature and subtasks. Changing the feature-row clearing behavior requires updating this test, and the test encodes a deliberate invariant ("column transitions clear dispatch state").
- **Two hosts with different dispatch paths.** The extension host dispatches via `attributePastedPrompt` (strict single-id path at `TaskViewerProvider.ts:681`, fire-and-forget path at `:1240`); the standalone host dispatches via `updateDispatchInfoByPlanFile` (`bootstrap.ts:2561`). A fix in one does not imply the other.
- **Stale row hygiene.** 111 feature rows (and an unknown number of plan rows) carry a stale `dispatched_terminal` with no `dispatched_at`. Any fix that changes the attribution query's filter risks picking up these stale rows and painting wrong titles — the exact failure the "no title beats a wrong title" principle guards against.

## Edge-Case & Dependency Audit

**Race Conditions:**
- `cascadeFeatureByPlanId` runs inside a BEGIN/COMMIT transaction (`KanbanDatabase.ts:6804-6821`) with an immediate `flushPersist` after. A concurrent `attributePasteDispatch` (re-dispatch) landing between the cascade's COMMIT and the flush could be clobbered by the flush's stale in-memory state. The existing flush-after-cascade pattern (line 6828) is designed to close this race in the other direction — verify it holds for the fix.
- The fire-and-forget attribution path (`TaskViewerProvider.ts:1240`) lands AFTER the prompt send. If a column transition fires between the send and the attribution write, the cascade clears `dispatched_at` before the attribution can stamp it. This is a window where even a correct stamp is immediately wiped.

**Security:**
- No security implications — this is a display/attribution bug with no credential or access-control surface.

**Side Effects:**
- Changing `cascadeFeatureByPlanId` to not clear `dispatched_at` on the feature row would affect the activity-light derivation for features. The comment at `KanbanDatabase.ts:10212` says the feature working flag is derived from subtasks, so the feature row's `dispatched_at` may not drive the activity light for features — but this must be verified, not assumed.
- Changing the attribution query's filter (e.g., matching on `dispatched_terminal` instead of `dispatched_at`) would affect ALL plans, not just features. The 539 plan rows and 111 feature rows with stale `dispatched_terminal` would become matchable, painting wrong titles on terminals that have moved on to other work.

**Dependencies & Conflicts:**
- `clearStaleWorkingState` (timeout backstop) keys on `dispatched_at IS NOT NULL`. If `dispatched_at` is never cleared on features, the timeout backstop never fires for feature rows — potentially leaving stale activity lights on forever. The working flag for features is derived from subtasks (per the comment), so this may be benign, but it must be verified.
- The completion broadcast (`broadcastAgentCompleted`) depends on `clearWorkingState` returning true on a real non-NULL→NULL transition. If the feature row's `dispatched_at` is never set (mechanism (a)), `clearWorkingState` is a no-op for the feature — but it may still fire on subtasks, which is the correct completion signal for a feature.

## Dependencies

None — this plan is self-contained.

## Adversarial Synthesis

Key risks: (1) the `dispatched_at` dual-purpose conflict means any fix that stops clearing it on feature column moves could break the activity-light and timeout-backstop semantics; (2) the test at `completion-asserted-never-inferred.test.js:295` encodes the clearing as a deliberate invariant, so changing it is not a silent edit; (3) the 111 stale `dispatched_terminal`-only rows are a landmine — widening the attribution filter to catch them paints wrong titles on terminals that have moved on. Mitigations: scope the fix to the feature-row clearing in `cascadeFeatureByPlanId` only (not subtasks), verify the feature working flag is truly subtask-derived before relying on it, and keep the attribution query's `dispatched_at IS NOT NULL` filter intact so stale rows stay inert.

## Proposed Changes

**1. Diagnose (a) vs (b) empirically — UPDATED test plan.** The original plan proposed testing by moving a subtask and watching the feature file regenerate. That tests the wrong hypothesis (re-import). The correct test is:

- Dispatch a feature to a lead. Immediately: `SELECT dispatched_at, dispatched_terminal FROM plans WHERE plan_id = '<feature>'`.
- If `dispatched_at` is NULL at step one → mechanism (a) is active (the feature was never stamped by this dispatch path). Check whether the strict path (`TaskViewerProvider.ts:681`) passed the feature's planId or a subtask's.
- If `dispatched_at` is present → move the feature to a new column (e.g., via the board or `cascadeFeatureByPlanId`) and read the row again. If `dispatched_at` is now NULL and `dispatched_terminal` is preserved → mechanism (b) confirmed, with `cascadeFeatureByPlanId` as the clearer.
- Also test: does `clearWorkingState` fire on the feature row during the run? Check whether the plan watcher parses a stage-complete marker from the feature file.
- It may be both (a) and (b). (b) is the one that guarantees the bug persists for the entire run.

**2. If (a) — stamp the feature row on dispatch.** When a feature goes to a lead, the feature's own planId must reach `attributePastedPrompt` alongside the subtask ids. Route through the canonical dispatch-plans builder rather than hand-rolling the array at this call site; hand-built single-entry arrays are how feature entries get dropped on individual paths. The fire-and-forget path (`extractDispatchIdentity`) already scans for all PLAN_IDs in the prompt body, so if the feature's PLAN_ID is in the prompt, this path stamps it — verify it is.

**3. If (b) — stop the column-move cascade from clearing the feature row's dispatch identity.**

> **Superseded:** Treat `dispatched_at` the way `dispatched_terminal` is already treated: preserved across upsert, cleared only by a deliberate write (dispatch, completion, or the timeout backstop at `KanbanDatabase.ts:10303`). Removing it from the upsert column list is the smaller change, but confirm nothing depends on re-import clearing it.
>
> **Reason:** `dispatched_at` is ALREADY preserved across upsert — both `insertFileDerivedPlan` (not in its SQL at all) and `UPSERT_PLAN_SQL` (not in its ON CONFLICT SET clause) preserve it. The upsert is not the clearer. The actual clearer is `cascadeFeatureByPlanId` (`KanbanDatabase.ts:6810`), which nulls `dispatched_at` on the feature row on every column move. Removing `dispatched_at` from the upsert column list would be a no-op fix for a non-existent problem.
>
> **Replaced with:** The fix must target `cascadeFeatureByPlanId` (and possibly `clearWorkingState` if it fires on feature rows). The design tension is that `dispatched_at` serves both dispatch-identity and working-state. The cleanest approaches, in order of preference:

  - **(3a) Don't clear `dispatched_at` on the feature row in `cascadeFeatureByPlanId` when the feature still has an active `dispatched_terminal`.** The feature's column move is a board-lifecycle event, not a dispatch-end event — the lead is still driving. Subtask clearing (line 6818) stays unchanged. This requires updating the test at `completion-asserted-never-inferred.test.js:295` to assert `clears.length === 1` (subtasks only) or to scope the feature-row assertion to "only when `dispatched_terminal` is empty." Verify that the feature's activity light is truly derived from subtasks (per the comment at `KanbanDatabase.ts:10212`) and not from the feature row's own `dispatched_at`.

  - **(3b) Re-stamp `dispatched_at` after a column move if the feature is still dispatched.** After `cascadeFeatureByPlanId` clears `dispatched_at`, check whether `dispatched_terminal` is still set and the terminal is still live; if so, re-stamp `dispatched_at = now`. This preserves the clearing invariant (the test stays green) but re-establishes the dispatch-identity signal. Downside: the timestamp no longer reflects the original dispatch time, which affects the `ORDER BY dispatched_at DESC` ordering in the attribution query (a re-dispatch should still win over a stale row, and a re-stamp after column move would make the row appear "fresher" — which is correct, since the lead IS still actively driving).

  - **(3c) Introduce a separate `dispatch_active` flag** (or reuse an existing field) that is NOT cleared by column moves, and have the attribution query filter on it instead of `dispatched_at`. This is the cleanest separation of concerns but the largest change (schema migration, new column, all clearers updated, attribution query updated). Reserve for if (3a) and (3b) both prove unviable.

  **Recommended: (3a).** It is the smallest change that addresses the root cause directly. The feature's working flag is derived from subtasks (per the code comment), so not clearing the feature row's `dispatched_at` should not affect the activity light. The test update is straightforward. If the diagnosis in step 1 shows the feature working flag IS read from the feature row's `dispatched_at` somewhere, fall back to (3b).

**4. Keep the two-tier matcher exactly as it is.** Do not add a role-only tier so the lead can be found by being the lead. `terminalPlanAttribution.ts` argues against that explicitly and it is right — a guessed title persists for the whole session.

**5. The lead's title is the feature, not a subtask.** With the feature row present (both `dispatched_terminal` and `dispatched_at` set), tier 1 matches the lead's seat by name and the coders keep matching theirs. Verify the lead does not instead pick up a subtask title, and that no coder picks up the feature title. The attribution query returns rows ordered `dispatched_at DESC` and the name tier takes the first per name — a feature and a subtask both named to the same terminal would race, but in practice the lead's terminal name differs from the coders' terminal names.

**6. Fix the terminal-without-timestamp rows already on disk, or decide not to.** 111 feature rows and an unknown number of plan rows carry a stale `dispatched_terminal` with no timestamp. They are inert today because the query needs both. If change 3a lands, newly dispatched features will keep both fields; the historical rows stay inert. State the decision: leave them (they're inert and will age out), or run a one-time cleanup that nulls `dispatched_terminal` on rows where `dispatched_at IS NULL AND dispatched_terminal != ''`. The cleanup is safe because the attribution query already excludes these rows — nulling `dispatched_terminal` makes them consistent but changes nothing observable.

## Verification Plan

### Automated Tests
- Update `completion-asserted-never-inferred.test.js:295` if fix 3a changes `cascadeFeatureByPlanId`'s clearing behavior on the feature row. The test currently asserts `clears.length === 2` (both feature and subtasks clear `dispatched_at`); after 3a it should assert the subtask clear remains and the feature-row clear is either removed or scoped to `dispatched_terminal IS NULL`.
- Add a test that dispatches a feature, moves it through a column transition, and asserts the feature row still has `dispatched_at IS NOT NULL` (the regression this plan fixes).
- Add a test that `getLiveDispatchAttribution` returns the feature row after a column move, and that `attributePlansToTerminals` maps it to the lead's terminal.

### Goal Invariants
- Assert `getLiveDispatchAttribution(wsId)` returns a row whose `planId` matches a dispatched feature's planId after that feature has moved through at least one column transition.
- Assert `attributePlansToTerminals(rows, worktrees, terminals)` produces a `TerminalPlanAttribution` entry for the lead's terminal `friendlyName` with the feature's `topic` as `planTitle`, given a feature row with both `dispatchedTerminal` and `dispatchedAt` set.
- Assert `attributePlansToTerminals` does NOT produce an entry for a terminal whose only matching row has `dispatchedTerminal` set but `dispatchedAt` null (the stale-row guard).
- Assert `cascadeFeatureByPlanId` still clears `dispatched_at` on subtask rows (line 6818 unchanged) — the subtask clearing invariant must survive.

### Manual Verification
1. **Establish the baseline.** Dispatch a feature to a lead on the current build and confirm the lead's header is blank while the coders' headers are populated.
2. **Diagnose (a) vs (b).** Immediately after dispatch: `SELECT dispatched_at, dispatched_terminal FROM plans WHERE plan_id = '<feature>'`. Then move the feature to a new column and read it again. Record which transition loses the timestamp.
3. **The lead's header names the feature** after the fix, from dispatch through to the end of the run.
4. **It survives column churn.** Move the feature through multiple column transitions (dispatch → coding → reviewed → completed, or restore/send-back-for-fixes) and confirm the header does not go blank mid-run. This is the (b) regression and the one most likely to be missed.
5. **Coders keep their subtask titles**, unchanged, and none of them shows the feature title.
6. **A plain plan dispatched to a lead** still shows that plan's title — no regression on the non-feature path. Plain plans still clear `dispatched_at` on column moves (the fix is feature-row-only).
7. **Two features in flight** to two different leads: each header shows its own feature. Rows are ordered `dispatched_at DESC` and the name tier takes the first per name, so a re-dispatch must win over a stale row.
8. **No spurious titles.** A lead with nothing dispatched has a blank header, not an inherited one. The absence of a role-only tier is what guarantees this — assert it survived.
9. **Both hosts.** Extension and standalone. The extension dispatch path (`attributePastedPrompt` via `TaskViewerProvider.ts:681` or `:1240`) and the standalone dispatch path (`updateDispatchInfoByPlanFile` via `bootstrap.ts:2561`) both stamp the feature row — verify both. The column-move cascade (`cascadeFeatureByPlanId`) is shared, so fix 3a covers both hosts.
10. **Row hygiene.** Re-run the counts from the problem analysis. Features in flight now have both fields; the historical terminal-only rows are in whatever state change 6 decided.
11. **Activity light unaffected.** After fix 3a, verify the feature's activity light still turns off when all its subtasks complete (the working flag is subtask-derived). If the activity light stays on, the feature row's `dispatched_at` IS read for the working flag and fix 3a is wrong — fall back to 3b.
