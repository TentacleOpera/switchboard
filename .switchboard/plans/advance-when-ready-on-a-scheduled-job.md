# Advance When Ready: A Schedule That Fires On Completion, Not On The Clock

## Goal

Add an **advance when ready** option to a scheduled job. Instead of waiting for its next
scheduled time, the job fires as soon as the lead posts completion and the team is released —
the countdown collapses to the next survivor poll (up to 60 seconds), not the full interval.
Work advances at the pace the agents actually finish, without an operator watching for the
previous card to land.

### The problem, and the root cause

Every scheduled job today is time-triggered and nothing else.
`_tickSurvivorSchedulerJobs` (`TaskViewerProvider.ts:28177`) polls every 60 seconds and runs a
job only when the clock says so:

```
const intervalMs = Math.max(Number(job.intervalMinutes) || 1, 1) * 60 * 1000;
if (job.lastRunAt && now - job.lastRunAt < intervalMs) continue;
```

So a board-advancing schedule set to 30 minutes advances 30 minutes after the last run,
regardless of whether the team finished in four minutes or is still mid-task at forty. The
operator's choices are a short interval that dispatches into busy teams and gets refused, or a
long one that leaves seats idle. Neither is the thing they want, which is "next, when ready".

Nothing signals readiness to the scheduler. Completion is asserted by
`POST /kanban/task/complete`, which writes `completed_at` and — by its own documented contract —
does nothing else: *"No dispatch, no column move."* Team release is derived from that write, by
the in-flight predicate in the dispatch handler (`LocalApiServer.ts:1924`):

> "A team is in flight when any card belonging to it is held by a team member and has no
> completion post… Exactly ONE fact releases a team: `completed_at`… Board position is not part
> of the predicate — moving a card never releases a team."

That predicate is computed on every dispatch attempt and thrown away, surviving only inside a
409 message. So the system knows precisely when a team becomes ready and tells nobody.

## Metadata
- **Complexity:** 5
- **Tags:** backend, api, feature, reliability

## User Review Required

Yes — the 60-second latency floor (survivor poll interval) is the default delivery mechanism.
If the operator's expectation is "instant advance," the direct-poke variant (Step 3 of Proposed
Changes) must be the primary mechanism, not the escape hatch. The plan defaults to the poll
path because it is a one-line state change with zero new timer management; the direct-poke is
specified as a fallback that can be promoted. The user should confirm which latency is
acceptable before implementation.

## Complexity Audit

### Routine
- Adding a boolean `advanceWhenReady` field to the `ScheduledJob` interface (`GlobalIntegrationConfigService.ts:45`). Absent reads as `false` — today's behaviour.
- Adding a checkbox to the team-automations UI in `terminals.js` beside the interval field.
- Clearing `lastRunAt` to `0` on matching jobs — the survivor tick's gate (`lastRunAt && now - lastRunAt < intervalMs`) already treats `0` as "due now".
- Updating the completion endpoint's contract comment from "No dispatch, no column move" to reflect the conditional trigger.

### Complex / Risky
- **Both-roots wiring of the option hook.** The completion handler lives in `LocalApiServer` (shared); the scheduler state lives in `TaskViewerProvider` (instantiated by both hosts). A new `LocalApiServerOptions` hook must be wired in BOTH `TaskViewerProvider.ts:3707` (extension) and `bootstrap.ts:3082` (standalone). An unwired `Promise<void>` hook is indistinguishable from a working one — the exact failure mode CLAUDE.md records for the four queue seams.
- **In-flight predicate dependency is unimplemented.** The plan references an extracted `resolveTeamInFlight` helper from `team-dispatched-state-reaches-the-rail.md`, but that plan is in PLAN REVIEWED — the helper does not exist. The predicate is still inlined at `LocalApiServer.ts:1937-1966`. The helper must be extracted as part of this plan's implementation, or the predicate must be re-evaluated inline.
- **Empty-run cadence drift.** `runSchedulerJob` stamps `lastRunAt = Date.now()` in its `finally` block (`TaskViewerProvider.ts:28249`) unconditionally — even on empty prompts, missing teams, and dead roles. An advance-when-ready fire that finds nothing pushes the fallback interval out by a full cycle. The stamping logic must be conditioned for advance-when-ready jobs.
- **Team resolution from completion post.** The completion handler knows `planId` and `from` (the lead's terminal), not which team was released. Resolving the released team requires reading the completed card's `dispatchedTerminal`, resolving the team roster via `resolveTeamMembers`, and re-evaluating the in-flight predicate against that roster.

## Edge-Case & Dependency Audit

### Race Conditions
- **Fire after the write, never before.** `completed_at` is what frees the team; a fire that races the commit sees the team still holding work and is refused. The trigger must execute after `db.setCompletedAt` succeeds (`LocalApiServer.ts:2482`).
- **Two jobs, one release.** Both may legitimately fire; both go through `runSchedulerJob` and therefore `_schedulerInFlight` guard, so the second re-reads a queue the first has drained. Safe, but confirm rather than assume.
- **Idempotent completion re-post.** `POST /kanban/task/complete` is idempotent — a repeat call returns the existing record without re-writing `completed_at` (`LocalApiServer.ts:2428`). The trigger must gate on the write having actually happened (the `updated` check at line 2484), not on the handler having been reached.

### Security
- The trigger fires from an authenticated endpoint (`_checkAuth` at line 2378). No new attack surface — the hook callback runs in-process, not over the wire.
- `planId` path-separator validation already exists (line 2406). No new interpolation.

### Side Effects
- **`releaseDispatchHolder` / `mcStopMission`.** A holder cleared without a completion post also frees a team (clears `dispatchedTerminal`). This trigger hooks ONLY `POST /kanban/task/complete`, so holder releases are naturally excluded. A stop should not advance — and it doesn't, because stops go through `releaseDispatchHolder`, not the completion endpoint. This is correct by construction, not by accident.
- **Empty queue on fire.** If the fire finds nothing to advance, `runSchedulerJob` stamps `lastRunAt = Date.now()` unconditionally, pushing the fallback cadence out. Must be conditioned (see Complex / Risky above).
- **Stale contract comment.** The completion endpoint's doc says "No dispatch, no column move." This change makes completion able to trigger a scheduler fire, gated on the flag. The comment must be updated.

### Dependencies & Conflicts
- **`mission-control-schedules-backend.md`** (PLAN REVIEWED, unimplemented) — the Schedules tab has no backend. The `advanceWhenReady` flag can be carried by team automations first (the Terminals tab UI at `terminals.js:12052` already manages `team-automation` jobs). The mechanism is the same once the Schedules tab lands.
- **`team-dispatched-state-reaches-the-rail.md`** (PLAN REVIEWED, unimplemented) — proposes extracting `resolveTeamInFlight` from the inlined predicate at `LocalApiServer.ts:1937-1966`. This plan depends on that helper. If it has not landed, the helper must be extracted as Step 1 of implementation.

## Dependencies

- `mission-control-schedules-backend.md` — the Schedules tab has no backend until that lands. Team automations can carry the flag first; the mechanism is the same.
- `team-dispatched-state-reaches-the-rail.md` — proposes the extracted `resolveTeamInFlight` helper that this plan reuses for release detection. Unimplemented; must be extracted first or as Step 1 of this plan.

## Adversarial Synthesis

Key risks: (1) both-roots hook wiring — an unwired `Promise<void>` seam is indistinguishable from working, the exact failure mode CLAUDE.md records; verification must read both files. (2) The `resolveTeamInFlight` helper is unimplemented — the plan references a dependency that has not landed. (3) `runSchedulerJob` stamps `lastRunAt` unconditionally in its `finally` block, so empty fires drift the fallback cadence. Mitigations: (1) specify the exact hook signature and wire sites, with a verification step that reads both. (2) Extract the helper as Step 1 or evaluate inline. (3) Condition the stamp for advance-when-ready jobs — skip on empty outcome, or stamp a short retry backoff.

## Proposed Changes

### `src/services/GlobalIntegrationConfigService.ts`
**Context:** The `ScheduledJob` interface (line 45) defines the persisted shape of every scheduled job. `sourceConfig` is an untyped bag; `teamTarget` carries the team targeting. The `SchedulerConfig` has `schemaVersion: 1`.

**Logic:** Add `advanceWhenReady?: boolean` as a top-level field on `ScheduledJob`. Absent reads as `false` — byte-for-byte today's behaviour. No `schemaVersion` bump is needed because the field is optional and the config loader already preserves unknown keys.

**Implementation:**
```typescript
export interface ScheduledJob {
    // ... existing fields ...
    advanceWhenReady?: boolean;
}
```

**Edge Cases:** A job with `advanceWhenReady: true` but no `teamTarget.groupId` is meaningless — the trigger cannot match a team. Either hide the option for non-team-automation jobs or refuse it at save. The UI should only show the checkbox for `source: 'team-automation'` jobs.

### `src/services/LocalApiServer.ts`
**Context:** The completion handler `_handleKanbanTaskComplete` (line 2377) writes `completed_at` (line 2482), records the event (line 2491), clears the coding seat (line 2498), and sends the response (line 2516). The in-flight predicate is inlined at lines 1937-1966 — `heldByTeam` function plus a fresh-read scan over every candidate card. `LocalApiServerOptions` (line 129) carries optional hooks that both composition roots wire.

**Logic:** Three changes to this file:

1. **Extract the in-flight predicate.** Lift `heldByTeam` and its fresh-read scan (lines 1938-1966) into an exported helper:
   ```
   resolveTeamInFlight(db, teamMemberNames): Promise<{ inFlight: boolean, planId?: string, dispatchedTerminal?: string }>
   ```
   The dispatch handler (line 1937) calls the helper instead of inlining it. This is the extraction `team-dispatched-state-reaches-the-rail.md` proposes — one definition of in-flight, now three consumers (dispatch gate, rail indicator, advance-when-ready trigger). If that plan has already landed, reuse its helper; if not, extract it here.

2. **Add the option hook.** Add to `LocalApiServerOptions`:
   ```typescript
   onTeamReleased?: (workspaceRoot: string, teamMemberNames: string[]) => Promise<void>;
   ```
   This hook fires after a completion post that releases a team. It is optional — absent in headless/test harnesses (the `Promise<void>` no-op).

3. **Fire the trigger after the write.** In `_handleKanbanTaskComplete`, after `setCompletedAt` succeeds (line 2482, gated on `updated` being truthy) and BEFORE the response is sent (line 2516):
   - Resolve the completed card's team: read `existing.dispatchedTerminal`, resolve the team roster via `this._options.resolveTeamMembers?.(workspaceRoot, existing.dispatchedTerminal)`.
   - Re-evaluate the in-flight predicate: call `resolveTeamInFlight(db, roster)`. If `inFlight === false`, the team is released.
   - If released and `this._options.onTeamReleased` is wired, call it with `(workspaceRoot, roster)`. Fire-and-forget — the response must not wait for the hook.
   - **Idempotency gate:** only fire on the first completion write (the `updated` check at line 2484 already gates this — the idempotent early-return at line 2428 never reaches this code).

> **Superseded:** Reuse the extracted helper from `team-dispatched-state-reaches-the-rail.md` — one definition of in-flight, now three consumers.
> **Reason:** The helper (`resolveTeamInFlight`) does not exist. `team-dispatched-state-reaches-the-rail.md` is in PLAN REVIEWED — unimplemented. The predicate is still inlined at `LocalApiServer.ts:1937-1966`. Referencing a non-existent helper would send the implementer searching or cause them to reinvent it (creating the second parallel implementation the dependency plan exists to prevent).
> **Replaced with:** Extract `resolveTeamInFlight` as Step 1 of this plan's implementation. If `team-dispatched-state-reaches-the-rail.md` lands first, reuse its helper. The extraction is small and well-defined: lift `heldByTeam` + fresh-read scan, add a short-circuit parameter for the rail path (per the dependency plan's spec).

**Edge Cases:**
- `resolveTeamMembers` may return `null` (no resolver wired). In that case, fall back to `[existing.dispatchedTerminal]` — the single-seat team. The predicate still works: if no other card is held by that terminal, the team is free.
- The hook callback must never throw into the completion handler. Wrap in try/catch; log and continue.
- `onTeamReleased` is fire-and-forget. The response at line 2516 must not await it.

### `src/services/TaskViewerProvider.ts`
**Context:** The survivor scheduler timer (`_startSurvivorJobsTimer`, line 28154) ticks every 60 seconds and calls `_tickSurvivorSchedulerJobs` (line 28177), which filters to enabled jobs in survivor sources (`fetch-plans`, `reconcile`, `team-automation`) and fires `runSchedulerJob` (line 28197) when `lastRunAt` gate passes. `runSchedulerJob` stamps `lastRunAt = Date.now()` in its `finally` block (line 28249) unconditionally. The extension wires `LocalApiServer` options at line 3707.

**Logic:** Three changes:

1. **Wire the `onTeamReleased` hook** in the `LocalApiServer` options at line 3707:
   ```typescript
   onTeamReleased: async (wsRoot, teamMemberNames) => {
       this._clearAdvanceWhenReadyJobs(wsRoot, teamMemberNames);
   },
   ```
   Add a private method `_clearAdvanceWhenReadyJobs(workspaceRoot, teamMemberNames)` that:
   - Loads the scheduler config via `GlobalIntegrationConfigService.getSchedulerConfig()`.
   - Filters to enabled jobs with `advanceWhenReady: true` and `source: 'team-automation'`.
   - For each job, checks whether `job.teamTarget.groupId` matches the released team's group. Resolve the group ID from `teamMemberNames` by looking up which registered group contains those members (via `db.getConfigJson(TERMINALS_GROUPS_KEY, [])`).
   - For matching jobs, sets `job.lastRunAt = 0` and saves the config.
   - **Optional direct-poke:** if latency matters, call `void this.runSchedulerJob(job)` directly instead of waiting for the next poll. This is the escape hatch the Goal section references.

2. **Fix empty-run stamping for advance-when-ready jobs.** In `runSchedulerJob`'s `finally` block (line 28249), condition the `lastRunAt` stamp:
   ```typescript
   if (targetJob) {
       if (targetJob.advanceWhenReady && outcome !== 'sent') {
           // Don't stamp full interval — empty fire must not push fallback cadence out.
           // Stamp a short retry backoff (30s) so the next poll re-attempts sooner
           // than the full fallback interval, but doesn't tight-loop.
           targetJob.lastRunAt = Date.now() - (intervalMs - 30 * 1000);
       } else {
           targetJob.lastRunAt = Date.now();
       }
       targetJob.lastOutcome = outcome;
       targetJob.lastTarget = resolvedTarget;
       await GlobalIntegrationConfigService.setSchedulerConfig(latestSched);
   }
   ```
   This way an empty fire sets `lastRunAt` to "30 seconds ago" — the next poll (within 60s) re-attempts, but the full fallback interval is not consumed.

3. **Disabled jobs always win.** The survivor tick already checks `!job.enabled` (line 28182) and skips. The `_clearAdvanceWhenReadyJobs` method must also check `job.enabled` — a disabled job's `lastRunAt` must not be cleared.

> **Superseded:** If a pause concept exists at the job level, a completion must not jump it.
> **Reason:** No pause concept exists on `ScheduledJob`. The interface (`GlobalIntegrationConfigService.ts:45`) has `enabled: boolean` only — no `paused` field, no pause/unpause verbs. The survivor tick already gates on `!job.enabled`.
> **Replaced with:** `enabled: false` is the only disable mechanism. The `_clearAdvanceWhenReadyJobs` method checks `job.enabled` and skips disabled jobs. No pause handling is needed.

**Edge Cases:**
- Two jobs targeting the same team: both get `lastRunAt` cleared. Both fire on the next poll. The `_schedulerInFlight` guard (line 28204) prevents concurrent runs of the same job, but two different jobs can run in parallel — both go through `dispatchNextFromQueue` and the second re-reads a queue the first may have drained. Safe, but confirm.
- A dead team (free but no live members): the fire runs, `runSchedulerJob` calls `_deliverTeamAutomationJob`, which returns `{ success: false, outcome: 'target role not live' }`. The empty-run stamping fix prevents cadence drift. The next attempt is the fallback interval.

### `src/standalone/bootstrap.ts`
**Context:** The standalone host constructs `LocalApiServer` at line 3082 with an options object. It instantiates `TaskViewerProvider` at line 1014 and calls `restoreAutobanOnStartup()` at line 3180, which starts the survivor timer. Both hosts share the same `TaskViewerProvider` and `LocalApiServer` code.

**Logic:** Wire the `onTeamReleased` hook in the options object passed to `new LocalApiServer(options)` at line 3082:
```typescript
onTeamReleased: async (wsRoot, teamMemberNames) => {
    taskViewerProvider?._clearAdvanceWhenReadyJobs(wsRoot, teamMemberNames);
},
```
Or, if the method is kept private, expose it via a public delegate or add it to the headless runtime injection at line 3098.

**Edge Cases:** `taskViewerProvider` may be null at wiring time (it's assigned at line 1014, before `server` at line 3082). The lazy arrow captures the variable, not the value — same pattern as `setQueueEscalationRecorder` at line 2613. The truthiness check inside the async body is load-bearing.

### `src/webview/terminals.js`
**Context:** The team-automations modal (`openTeamAutomationsModal`, line 12052) renders job cards with an enabled checkbox, label, interval, and actions. Jobs are filtered to `source: 'team-automation'` matching the current team (line 12099).

**Logic:** Add an "Advance when ready" checkbox beside the interval field on each job card. When checked, show a label clarifying that Time becomes the fallback cadence: "Fires on completion; interval is the fallback." When unchecked, the interval is the only trigger (today's behaviour).

**Edge Cases:** The checkbox should only appear for `team-automation` source jobs. A `fetch-plans` or `reconcile` job has no team to release — the flag is meaningless. Either hide the checkbox or disable it for non-team sources.

### `src/services/LocalApiServer.ts` — Contract Comment
**Context:** The completion handler's doc comment (line 2371-2376) says "No dispatch, no column move."

**Logic:** Update to reflect the conditional trigger:
```
 * - No dispatch, no column move. When an advance-when-ready job targets the
 *   released team, the completion triggers a scheduler fire by clearing the
 *   job's lastRunAt — gated on the flag and the team match. This is the one
 *   exception to "no dispatch": the scheduler fires on its own tick, not
 *   inline from this handler.
```

## Verification Plan

### Automated Tests
*(Skipped this run per session directive — checks remain written down for execution later.)*

1. `npm run compile` clean.
2. Confirm the option hook is wired in both composition roots before testing behaviour — read both `TaskViewerProvider.ts:3707` and `bootstrap.ts:3082`.
3. A board-advancing job at a 30-minute interval with advance-when-ready on: dispatch, post completion, confirm the next advance happens within one poll rather than in 30 minutes.
4. The same job with the flag **off**: confirm it still waits the full interval — today's behaviour unchanged.
5. Post the same completion twice: confirm exactly one advance (idempotency gate).
6. Move a card between columns without completing it: confirm no advance.
7. A team holding two cards: complete one, confirm no fire; complete the second, confirm one fire.
8. Two teams, one job targeting team A: complete work on team B, confirm the job does not fire.
9. Stop a mission / release a holder without a completion post: confirm no advance.
10. Fire with an empty queue: confirm no advance, no tight retry, and that the fallback interval is not pushed out (empty-run stamping fix).
11. Both hosts — repeat steps 3-10 in standalone (`npx switchboard`).

### Goal Invariants
- Assert `advanceWhenReady?: boolean` exists on the `ScheduledJob` interface in `src/services/GlobalIntegrationConfigService.ts`.
- Assert `onTeamReleased` is present in the `LocalApiServerOptions` interface in `src/services/LocalApiServer.ts`.
- Assert `onTeamReleased` is wired in the options object at `src/services/TaskViewerProvider.ts:3707` (extension composition root).
- Assert `onTeamReleased` is wired in the options object at `src/standalone/bootstrap.ts:3082` (standalone composition root).
- Assert `resolveTeamInFlight` is an exported function in `src/services/LocalApiServer.ts` (or a shared module) that returns `{ inFlight: boolean, planId?, dispatchedTerminal? }`.
- Assert `runSchedulerJob`'s `finally` block in `src/services/TaskViewerProvider.ts` conditions the `lastRunAt` stamp for `advanceWhenReady` jobs with non-`'sent'` outcomes.
- Assert the completion handler's contract comment in `src/services/LocalApiServer.ts` mentions the advance-when-ready trigger (no longer says only "No dispatch, no column move").

## Outstanding Questions
- **[user]** Is 60-second latency (survivor poll interval) acceptable as the default, or should the direct-poke variant (calling `runSchedulerJob` immediately from `onTeamReleased`) be the primary mechanism? — proceeding on the assumption that 60s is acceptable for batch advances and the direct-poke is the escape hatch.
