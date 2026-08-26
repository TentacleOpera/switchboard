# Advance When Ready: A Schedule That Fires On Completion, Not On The Clock

## Goal

Add an **advance when ready** option to a scheduled job. Instead of waiting for its next
scheduled time, the job fires as soon as the lead posts completion and the team is released —
the countdown collapses to zero. Work advances at the pace the agents actually finish, without
an operator watching for the previous card to land.

### The problem, and the root cause

Every scheduled job today is time-triggered and nothing else.
`_tickSurvivorSchedulerJobs` (`TaskViewerProvider.ts:28122`) polls every 60 seconds and runs a
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
- **Complexity:** 4
- **Tags:** backend, api, feature, reliability

## Depends on

`mission-control-schedules-backend.md` — this is a flag on a scheduled job, and the Schedules
tab has no backend until that lands. Team automations can carry the flag first if it ships
earlier; the mechanism is the same.

## Why this is cheap

The trigger does not need a new timer, a new clock, or a teardown of the existing one. The
survivor tick is a **poll**, not a per-job timer, and its only gate is `lastRunAt`. So "the
timer skips to zero" is literally:

```
job.lastRunAt = 0   // next poll fires it
```

No `setInterval` is installed or cleared, which matters because the deleted autoban engine
carried three separate timer-install paths and a code comment warning about them. This adds a
fourth path to nothing.

The cost is latency: up to 60 seconds between the completion post and the next poll. Acceptable
for a batch advance; if not, the completion handler can poke the tick directly rather than
waiting.

## No migration

Clean break. A boolean on `ScheduledJob` (or in `sourceConfig`), absent reads as off, which is
today's behaviour exactly. CLAUDE.md's migration rule is waived.

## Scope: both composition roots

The trigger fires from `LocalApiServer`'s completion handler (shared) but must reach the
scheduler state that `TaskViewerProvider` owns. If that is an option hook on
`LocalApiServerOptions`, wire it in **both** `TaskViewerProvider.ts` and `bootstrap.ts`. An
unwired `Promise`-returning hook is indistinguishable from a working one — the precedent CLAUDE.md
records for the four queue seams, where every gate stayed green for a month.

## Implementation

1. **The flag** — `advanceWhenReady?: boolean` on the job. In the UI it belongs beside the Time
   field, since it is an alternative to it: when set, Time becomes the *fallback* cadence rather
   than the trigger. Say that in the label; "advance when ready" plus a live interval reads as
   two schedules.
2. **The trigger is the completion post, after the commit.** In `_handleKanbanTaskComplete`
   (`LocalApiServer.ts:2364`), once `completed_at` is written, clear `lastRunAt` on every enabled
   advance-when-ready job whose target the release applies to.
   - **After the write, never before.** `completed_at` is what frees the team; a fire that races
     the commit sees the team still holding work and is refused.
   - **Never from a client event.** A fleet poll or webview relay noticing the state change can
     beat the commit. The handler is the only place that knows the write happened.
3. **Fire on release, not on any completion.** A team can hold more than one card, and the
   in-flight scan deliberately checks every candidate rather than stopping at the first
   (`LocalApiServer.ts:1936`). Re-evaluate the predicate after the write and only clear
   `lastRunAt` when the team is actually free. Reuse the extracted helper from
   `team-dispatched-state-reaches-the-rail.md` — one definition of in-flight, now three
   consumers.
4. **Scope the readiness to the job.** Readiness is per-team; a job is not necessarily. A job
   targeting the coding team must not fire because the review team went free. Match the released
   team against the job's target (`teamTarget.groupId`, or the team implied by its columns) and
   clear only matching jobs. Without this, every completion pokes every advance-when-ready job
   and the 409 becomes the de facto scheduler.
5. **Idempotency.** `POST /kanban/task/complete` is explicitly idempotent — *"a repeat call with
   the same `planId` returns the existing record without re-writing `completed_at`"*. Gate the
   trigger on the write having actually happened, not on the handler having been reached. Leads
   do post twice.
6. **Paused and disabled always win.** A disabled job never fires; if a pause concept exists at
   the job level, a completion must not jump it.
7. **An empty run must not reset the cadence.** If the fire finds nothing to advance, do not
   stamp `lastRunAt` with a full interval — otherwise every completion with an empty queue pushes
   the fallback schedule further out and the cadence drifts.
8. **Update the completion endpoint's contract comment.** It currently says "No dispatch, no
   column move." This makes completion able to trigger one, gated on the flag. A stale invariant
   comment is worse than the change it fails to describe.

## Edge cases

- **Two jobs, one release.** Both may legitimately fire; both go through
  `dispatchNextFromQueue` and therefore `_queueNextChain`, so the second re-reads a queue the
  first has drained. Safe, but confirm rather than assume.
- **A release with nothing staged.** Fires, finds nothing, records it. Must not retry in a tight
  loop — the next attempt is the fallback interval.
- **`mcStopMission` / `releaseDispatchHolder`.** A holder cleared without a completion post also
  frees a team. Decide explicitly whether that counts as ready; a stop almost certainly should
  not advance.
- **Advance-when-ready on an agent action.** Meaningless — a prompt-delivery job has no queue to
  advance. Either hide the option for non-board actions or refuse it at save.
- **A dead team.** The team can be free (no held card) and have no live members. The dispatch will
  refuse; record the reason and do not retry outside the fallback cadence.
- **60s latency is a floor, not a bug.** Do not add a second faster poll to shorten it; poke the
  existing tick if it matters.

## Verification plan

1. `npm run compile` clean.
2. Confirm the option hook is wired in both composition roots before testing behaviour — read
   both files.
3. A board-advancing job at a 30-minute interval with advance-when-ready on: dispatch, post
   completion, confirm the next advance happens within one poll rather than in 30 minutes.
4. The same job with the flag **off**: confirm it still waits the full interval — today's
   behaviour unchanged.
5. Post the same completion twice: confirm exactly one advance.
6. Move a card between columns without completing it: confirm no advance.
7. A team holding two cards: complete one, confirm no fire; complete the second, confirm one fire.
8. Two teams, one job targeting team A: complete work on team B, confirm the job does not fire.
9. Stop a mission / release a holder without a completion post: confirm no advance.
10. Fire with an empty queue: confirm no advance, no tight retry, and that the fallback interval
    is not pushed out.
11. Both hosts.
