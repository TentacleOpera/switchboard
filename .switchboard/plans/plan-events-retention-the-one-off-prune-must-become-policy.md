# plan_events Retention: the Prune That Ran Once Must Become Policy

**Complexity:** 4
**Tags:** database, performance, retention, backend

## Goal

# plan_events Retention: the Prune That Ran Once Must Become Policy

## Goal

Keep `plan_events` bounded automatically using per-type rules matching what each type is actually
read for. A one-off prune on 2026-09-18 took the table from 5,823 rows to 2,549 with no behaviour
change; nothing stops it growing back.

### Problem analysis

**The table is 97% unread by any feature.** Measured 2026-09-18:

| type | before | read by | kept |
| :--- | ---: | :--- | ---: |
| `workflow_event` | 3,610 | only its own append guard, which reads the latest row per (plan, workflow) | 1,340 |
| `turn_end` | 1,591 | `getTurnEndReports`, capped at `limit=500`, filtered by kind | 587 |
| `state-migrated-v81` | 454 | nothing -- but payloads carry dropped column values | 454 (kept) |
| `completed`/`dispatched`/`released` | 168 | dispatch delivery evidence -- load bearing | 168 |
| orphans (parent in neither table) | 1,922 | nothing; unreachable by every reader | 0 |
| NULL `plan_id` | 50 | nothing; the guard matches `plan_id = ?` | 0 |

**A flat timestamp cutoff -- the mechanism `RetentionService.ts:466` contemplates -- would break
the append guard.** The guard rejects a duplicate consecutive start/stop by reading the single
latest `workflow_event` per `(plan, workflow)`. A date-based DELETE removes that row for any key
whose last transition is older than the window, and the guard silently stops guarding. The rule
must be *latest-per-key*, not *newer-than-date*.

**Dispatch evidence cannot be pruned by age alone.** It is read as a watermark: the dispatcher
records the latest `event_id` before dispatching and accepts only an outcome newer than that
baseline. Evidence for a settled card is spent; for a card mid-dispatch it is load bearing, and
age does not distinguish them.

### Root Cause

`plan_events` is four things in one table -- a dedup ledger, a notification copy, a migration
audit record, and dispatch evidence -- and retention was only considered for the table as a whole.
The retention plan named it as an unbounded append-only table but scoped by time, which is the
wrong axis for three of the four.

### What this card must build

1. Per-type rules, as applied by hand on 2026-09-18:
   - `workflow_event`: keep `MAX(event_id)` per `(plan_id, workflow)`.
   - `turn_end`: keep newest 500 per `(workspace_id, action)` -- the endpoint cannot serve more.
   - orphans and NULL `plan_id`: delete.
   - dispatch evidence: keep while the card is unsettled; prunable once settled.
   - `state-migrated-v81`: leave until V81 is confirmed complete; payloads are the only copy.
2. Wire into `RetentionService` on the existing schedule, replacing the timestamp cutoff here.
3. A test asserting the guard still rejects a duplicate transition *after* a prune.
4. `VACUUM` after a prune, or freed pages are not returned -- the one-off prune plus vacuum took
   the board file from 13.77 MB to 8.42 MB.

## Metadata

**Complexity:** 4
**Tags:** database, performance, retention, backend
**Dependencies:** none. Shares a surface with `retention-and-archive-for-unbounded-growth.md`,
which owns the policy windows.

## User Review Required

1. **When is dispatch evidence spent?** Recommendation: once the card is archived, since an
   archived card is not mid-dispatch -- making bin semantics the natural trigger.
2. **Is V81 complete?** If yes the 454 `state-migrated-v81` rows can go. The columns they record
   as dropped (`routed_to`, `dispatched_agent`, `dispatched_ide`) are still present on `plans`,
   and there is a `V81 aborted` path in the code, so this needs a human answer.

