# A working agent's card goes dark after ten minutes, because the liveness heartbeat has never once fired

## Goal

Make `dispatched_at` survive for as long as the agent is actually working. Today a board dispatch is
force-forgotten exactly `activityLight.timeoutMs` (default **10 minutes**) after it is issued,
whether or not the seat is producing output, because the heartbeat that is supposed to widen that
window has never stamped a single row. Restore the heartbeat, and make the failure loud if it stops
again instead of silently degrading every backstop that reads the row.

### Problem analysis

**Measured on 2026-09-07, not inferred.** Two subtasks were dispatched from the CLI:

```
21:33:14.826Z  switchboard dispatch 28173753 --seat Coding-coder-1
21:34:23.628Z  switchboard dispatch 480a4e88 --seat Coding-coder-2
```

Ten minutes and fifty-four seconds later, with the operator confirming `Coding-coder-1` was visibly
working, the rows read:

| plan | routed_to | dispatched_agent | dispatched_ide | dispatched_terminal | dispatched_at |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 28173753 | `'LEAD CODED'` | `'lead'` | `'switchboard-pty'` | `Coding-coder-1` | **NULL** |
| 480a4e88 | `'LEAD CODED'` | `'lead'` | `'switchboard-pty'` | `Coding-coder-2` | **NULL** |

`routed_to`, `dispatched_agent` and `dispatched_ide` are written by exactly one function —
`KanbanDatabase.updateDispatchInfoByPlanFile` (`:11252`) — and `updated_at` on both rows matches the
dispatch timestamps to the millisecond. So the dispatch registered correctly, in the same single
`UPDATE` that also sets `dispatched_at = new Date().toISOString()`. Something nulled that one column
afterwards and left the rest of the row standing.

**A half-cleared row is not a state any reader can interpret.** `dispatched_terminal` says a seat
holds this card; `dispatched_at` says nothing is running. Nothing in the schema forbids it and no
reader tests for it.

### Root cause

The clearer is `clearStaleWorkingState` (`KanbanDatabase.ts`), whose age basis is deliberately
widened so a working agent is not timed out:

```sql
UPDATE plans SET dispatched_at = NULL, last_liveness_at = NULL, blocked_at = NULL
WHERE workspace_id = ? AND dispatched_at IS NOT NULL
  AND MAX(dispatched_at, COALESCE(last_liveness_at, dispatched_at)) < ?
```

`last_liveness_at` is the widening term. It is stamped by `db.recordLiveness(...)` in
`PlanIngestionEngine.ts:630`, for terminals selected here (`:609`):

```ts
} else if (nowMs - entry.lastDataAt < livenessWindowMs) {
    liveNames.push(entry.friendlyName);
}
```

**`entry.lastDataAt` is frozen, so `liveNames` is always empty.** Every sweep in the host log, across
the whole session, reports the same thing:

```
[GlobalPlanWatcher] Activity-light timeout sweep cleared N stale working card(s) (liveness: recorded=0, forced=3)
```

`recorded=0` — the heartbeat has never stamped a single row. Measured directly: `Coding-coder-1`'s
`lastDataAt` was **531 minutes** stale and did not move across the entire session, while the operator
confirmed that seat was actively working. `Coding-coder-2`'s `promptCount` went 4 → 6 in response to
a `ptySendPrompt`, and its `lastDataAt` did not move either. Output is flowing; the timestamp is not.

With `last_liveness_at` permanently NULL, `COALESCE(last_liveness_at, dispatched_at)` collapses to
`dispatched_at`, the widened basis degrades to the plain one, and the predicate becomes "clear every
dispatch older than `timeoutMs`". `timeoutMs` defaults to `10 * 60 * 1000`
(`PlanIngestionEngine.ts:560`), which is exactly the interval observed.

**The `forced=3` in that log line is a red herring.** The force-clear branch fires on
`dispatched_terminal IN (...)` for terminals reporting `status === 'exited'`; here those are three
dead probe seats — `oscproof`, `pushprobe-seat`, `loadprobe` — which hold no cards. They inflate the
log line and clear nothing. Anyone reading that line while diagnosing this will chase them.

**Where the freeze is, and the one link not yet proven.** The Go PTY host does stamp the field on
every read — `cmd/switchboard-pty-host/main.go:194`, inside `readOutput`, under the fleet mutex — and
projects it at `:110` and `:386`. On the TypeScript side `goPtyFleetProjection.refresh()` copies it
forward (`:529`, `existing.lastDataAt = row.lastDataAt ?? existing.lastDataAt`) and the live WebSocket
stream stamps it independently (`:601`, `handle.lastDataAt = Date.now()`). Yet `ptyListTerminals` —
which reaches the Go host through the supervisor — returns the stale value, so **the Go host's own
`t.lastDataAt` is stale**, which means `readOutput` is not the path these seats' output travels. That
last link is the investigation's first step, not a conclusion; see Proposed Changes 1.

> **Superseded:** "the Go host's own `t.lastDataAt` is stale, which means `readOutput` is not the path these seats' output travels. That last link is the investigation's first step, not a conclusion."
> **Reason:** The link was proven on 2026-09-08 by an uncommitted working-tree diff. The Go host's `readOutput` WAS stamping correctly all along (`main.go:194`, every read, under the mutex). The broken hop was on the TypeScript side: `goPtyFleetProjection.ts:attachLiveStream`'s `socket.on('message')` handler parsed EVERY frame as JSON and `return`ed on parse failure, while the Go host publishes output as binary frames (`encodeOutputFrame`). Every output chunk was silently discarded, so `handle.lastDataAt` never advanced. The proof is the explanatory comment at `goPtyFleetProjection.ts:589-597`, written as part of the fix.
> **Replaced with:** The freeze is the projection's JSON-only message handler, not `readOutput`. The fix decodes binary frames first (`goPtyFleetProjection.ts:600-606`) and stamps `handle.lastDataAt = Date.now()` on decode. The Go host side (`main.go:publish`, `ws.go:handleWebSocket`) now sends binary frames, handles binary input, and sends a coalesced binary replay with `replayChars`. See Proposed Changes 1-2 (DONE) and `## Resolved Assumptions` below.

### What it costs

Every consumer of `dispatched_at` degrades silently, and all of them were built on the assumption
that it survives an active turn:

| Consumer | Fails as |
| :--- | :--- |
| Activity light | a working agent's card goes dark after 10 minutes |
| Stall / blocked sweep | a genuinely stalled seat is indistinguishable from a working one |
| Turn-end completion notice | `plan-file mtime > dispatched_at` cannot evaluate against NULL |
| `switchboard dispatch` / `/kanban/dispatch/state` | report `"no dispatch was recorded"` and `state: "unknown"` on a **successful** dispatch |
| Commit trailer plan ids | `getActiveDispatchedByTerminal` returns nothing; `Switchboard-Stage` ships with no `Switchboard-Plan` |

The last one is why this is worth its own card rather than a tolerated wart: the reviewer's review
unit is the commit the trailers resolve, and with no trailers the review falls back to a dirty tree.

## Metadata

**Complexity:** 4
**Tags:** bugfix, reliability, pty, backstops, observability

## Non-goals

- **Not raising `timeoutMs`.** The window is not the bug; the heartbeat that widens it is. A longer
  timeout hides this for longer and makes a genuinely dead seat hold its card that much longer.
- **Not reintroducing mtime-based completion.** It is retired deliberately
  (`GlobalPlanWatcher: "mtime-based completion retired — waiting for POST /kanban/queue/done"`), and
  nothing here brings it back.
- **Not changing the sweep's purpose.** A dispatch to a seat that really has died must still be
  cleared; this plan restores the evidence the sweep needs to tell the two apart.
- **Not touching `a-lead-dispatched-plan-is-never-registered.md`'s work.** That plan (COMPLETED)
  fixed registration on the *fleet* `ptySendPrompt` path. This is the *board dispatch* path, whose
  registration works and is then erased.

## Dependencies

- **Supersedes nothing, but corrects a premise.** `a-lead-dispatched-plan-is-never-registered.md`
  states that the board dispatch path writes both columns. It does — and they do not survive ten
  minutes. That plan's downstream table of blinded consumers applies here unchanged.
- **`feature_plan_20260807103000_pty-liveness-heartbeat-gates-activity-light-sweep.md`** (COMPLETED)
  built the heartbeat this plan repairs. Its design is correct; the input feeding it is dead.
- **No new route, no new seam.** The change is inside the pty host, its projection and the sweep, so
  neither composition root gains wiring — assert that rather than assume it (Verification 8).

## Resolved Assumptions

- **The broken hop is proven.** The freeze was the projection's `socket.on('message')` JSON-only
  parser in `goPtyFleetProjection.ts:attachLiveStream`, not the Go host's `readOutput`. The Go host
  was stamping `t.lastDataAt` correctly all along (`main.go:194`). Bytes were discarded on the
  TypeScript side because the host publishes output as binary frames (`encodeOutputFrame`) while the
  handler parsed every frame as JSON and `return`ed on failure. Proven by the uncommitted working-tree
  diff dated 2026-09-08 (`goPtyFleetProjection.ts:589-606`, `main.go:publish`, `ws.go:handleWebSocket`).
- **The binary frame fix is in the working tree but uncommitted.** Changes 1-2 (prove the hop, restore
  the stamp) are DONE by this diff. It needs a rebuild before any manual verification can pass.
- **The two-writer race is currently benign.** With the fix, both `refresh()` (`:529`) and the socket
  handler (`:601`) advance `handle.lastDataAt`. The clobber is within the 90s liveness window. The race
  is a regression risk, not a live defect.

## User Review Required

None.

**A half-cleared row is a bug, not a state.** `dispatched_terminal` set with `dispatched_at` NULL is
treated here as an invariant violation to be made impossible, not a condition to be tolerated by
teaching each reader to handle it.

**A dead heartbeat fails loudly.** Per `CLAUDE.md`, a default that behaves like a configured value
turns a loud failure into a quiet wrong answer — which is precisely how this survived: `recorded=0`
was printed on every sweep, all session, and read as normal. It becomes a warning that names the
condition.

## Complexity Audit

### Routine

- Adding a warning when `recordLiveness` stamps zero rows while dispatched cards exist.
- Adding the source-level assertion for the two-writer resolution (Change 3).
- Asserting the dispatch path reports a real state (Change 6).

### Complex / Risky

- **The two-writer race on `handle.lastDataAt` is a regression guard, not a live fix.** With the
  uncommitted binary frame fix, both `refresh()` (`:529`) and the socket handler (`:601`) advance the
  field. The clobber is currently benign — both values are within the 90s liveness window. The
  remaining work is to make one writer authoritative by construction (source-level assertion) so a
  future edit that breaks the Go host's stamping cannot silently reintroduce the freeze via
  `refresh()` overwriting the socket's stamp with a frozen one.
- **The sweep must still clear a genuinely dead seat.** A heartbeat that stamps unconditionally
  makes every card immortal and converts this bug into its mirror image: cards that never clear and
  a queue that never drains.
- **The half-cleared row is a SQL-level bug independent of the heartbeat.** `clearStaleWorkingState`
  and `clearWorkingState` null `dispatched_at` and leave `dispatched_terminal` standing. This fires
  for every genuinely stale seat, even with a perfect heartbeat. It is the most user-visible
  remaining defect — a row that says a seat holds a card that is not running.
- **Do not fix this by widening a fallback.** `COALESCE(last_liveness_at, dispatched_at)` is already
  the fallback that made the failure invisible; making it more forgiving deepens the bug.

## Edge-Case & Dependency Audit

- **Both hosts.** The extension host reaches the pty through `goPtyFleetProjection`; the standalone
  host runs `ptyFleetService` with its own supervisor. `getLiveness()` exists on both and the sweep
  is host-agnostic — verify the heartbeat lands on **both**, since a fix in the projection alone
  leaves standalone dark.
- **Detached seats.** A seat registered but driven from outside its pty (`SWITCHBOARD_DETACHED=1`)
  legitimately produces no output on that pty. It must not be force-cleared as dead, and must not be
  stamped as live either — it is a third state and should be named as one, not folded into either.
- **Exited-terminal force-clear.** Tombstones for names since recreated would force-clear a live
  seat's card, because the branch matches on `dispatched_terminal` alone. Not observed here (the
  three forced names are retired probes), but the branch has no recency guard.
- **Feature cards.** `updateDispatchInfoByPlanFile`'s comment records that a feature row's `working`
  flag is derived from its subtasks' `dispatched_at` while the feature row keeps its own. Clearing
  subtasks silently darkens the parent.
- **`sql.js` is gone;** `better-sqlite3` is the only driver, so the WASM-heap budget cited in the
  sweep's comment (`~1 write per live card per 10s`) is no longer the binding constraint. Do not
  inherit that reasoning unexamined.
- **No `confirm()`**, per `CLAUDE.md`.

## Adversarial Synthesis

The root-cause fix (binary frame decoding) has landed uncommitted in the working tree, so the
dominant risk the plan was written against — fixing the symptom while leaving the heartbeat dead —
is moot. The remaining risks are regression and adjacent bugs. First is the two-writer race on
`handle.lastDataAt`: currently benign (both writers advance), but `refresh()` still clobbers the
socket's stamp, and a future edit that breaks the Go host's stamping silently reintroduces the freeze
through that clobber. Second is the half-cleared row: `clearStaleWorkingState` nulls `dispatched_at`
without clearing `dispatched_terminal`, a SQL-level bug that fires for every genuinely stale seat
regardless of heartbeat health. Third is the silent `recorded=0`: if the heartbeat dies again, the
first sweep must say so by name, not print zero inside an unrelated success line. Mitigations: pin
the two-writer resolution with a source-level assertion (Change 3); clear the holder in the same
statement that nulls `dispatched_at` (Change 5); gate the whole thing behind a loud warning (Change 4);
and require a rebuild of the uncommitted binary frame fix before any manual verification.

## Proposed Changes

### 1. Prove where the timestamp dies, before changing it — DONE (uncommitted, needs rebuild)

The proof landed on 2026-09-08 as an uncommitted working-tree diff. The broken hop is the
`socket.on('message')` handler in `goPtyFleetProjection.ts:attachLiveStream` — it parsed every frame
as JSON and `return`ed on failure, while the Go host publishes output as binary frames
(`encodeOutputFrame`). The fix decodes binary first (`goPtyFleetProjection.ts:600-606`) and stamps
`handle.lastDataAt = Date.now()`. The Go host side (`main.go:publish`, `ws.go:handleWebSocket`) now
sends binary frames, handles binary input, and sends a coalesced binary replay with `replayChars`.
The explanatory comment at `goPtyFleetProjection.ts:589-597` IS the proof.

> **Superseded:** "Instrument once and read it: log `lastDataAt` at the Go host (`readOutput`), as returned by `ptyListTerminals`, and as held in the projection cache, for one seat known to be producing output. The three values identify the broken hop. This step is the deliverable for the first commit."
> **Reason:** The investigation landed as the uncommitted binary frame fix on 2026-09-08. The broken hop was the projection's JSON-only message handler, not `readOutput`. The Go host's `readOutput` was stamping correctly all along; the bytes were discarded on the TypeScript side.
> **Replaced with:** No further investigation needed. The fix is in the working tree (uncommitted) — `goPtyFleetProjection.ts:600-606`, `main.go:publish`, `ws.go:handleWebSocket`. It needs a rebuild before any manual verification.

### 2. Restore the stamp on the proven hop — DONE (uncommitted, needs rebuild)

The stamp is restored. `handle.lastDataAt = Date.now()` fires on every binary frame
(`goPtyFleetProjection.ts:601`). The Go host's `readOutput` was already stamping `t.lastDataAt`
correctly (`main.go:194`); the fix was on the consumer side.

> **Superseded:** "Fix the identified hop only. If it is `readOutput` not running for reattached seats, stamp where the bytes actually flow (`publish`). If it is `refresh()` clobbering the socket's stamp, make the newer of the two win explicitly (`Math.max`), with a comment naming the other writer."
> **Reason:** The identified hop was the projection's JSON-only message handler, not `readOutput` or `refresh()`. The fix decodes binary frames and stamps on decode. The `refresh()` clobber (the second sub-case) is NOT addressed by the uncommitted diff and remains as Change 3.
> **Replaced with:** Binary frame decoding + stamping at `goPtyFleetProjection.ts:600-606` (uncommitted). The `refresh()` clobber is deferred to Change 3.

### 3. One authoritative writer for `handle.lastDataAt` — REMAINING

`refresh()` still does `existing.lastDataAt = row.lastDataAt ?? existing.lastDataAt`
(`goPtyFleetProjection.ts:529`), overwriting the socket's `Date.now()` stamp (`:601`) with the Go
host's `row.lastDataAt`. With the binary frame fix, both writers now advance, so the clobber is
benign within the 90s liveness window — but it is still a race: whichever runs last wins, and a
future edit that breaks the Go host's stamping would make `refresh()` clobber the socket's working
stamp with a frozen one, silently reintroducing this bug. Pin the resolution with a source-level
assertion so a later edit to either writer fails the gate rather than reintroducing the race.

### 4. A dead heartbeat is loud

In the sweep, when `recordLiveness` stamps **zero** rows while at least one card carries
`dispatched_at`, log a warning naming the condition — the fleet reports N active terminals and none
of them look alive. Today that state prints as `recorded=0` inside an unrelated success line.

### 5. Make the half-cleared row impossible

`clearStaleWorkingState` and `clearWorkingState` null `dispatched_at` and leave `dispatched_terminal`
standing, producing a row that says a seat holds a card that is not running. Clear the holder in the
same statement, or record explicitly why the holder outlives the clock — and pin whichever is chosen,
so the pair cannot drift apart again.

### 6. Report the truth on the dispatch path

`switchboard dispatch` and `/kanban/dispatch/state` currently answer `"no dispatch was recorded
(dispatchedAt unchanged)"` and `state: "unknown"` for a dispatch that fully succeeded — the check
reads `dispatched_at`, which the sweep has since nulled. Once 3–5 land the false negative disappears
on its own (1-2 are already done uncommitted); assert it, so the reassuring message cannot come back
detached from reality.

## Verification Plan

### Automated Tests

> **Prerequisite:** The uncommitted binary frame fix (Changes 1-2) must be rebuilt before any
> manual or automated verification can pass. Without it, `recordLiveness` stamps zero rows and
> tests 1-3 cannot succeed. The fix is in `goPtyFleetProjection.ts:600-606`, `main.go:publish`, and
> `ws.go:handleWebSocket`.

1. **A live seat's card survives past `timeoutMs`.** Stamp a heartbeat, advance the clock beyond the
   timeout, run the sweep; `dispatched_at` is intact. This is the defect, stated directly. (Tests
   the uncommitted binary frame fix — Change 2.)
2. **A dead seat's card is still cleared** past the timeout with no heartbeat. The mirror image, so
   the fix cannot be "never clear anything".
3. **`recordLiveness` stamps a row for a terminal that produced output within the window** — the
   step that has never once executed in production. (Tests the uncommitted binary frame fix —
   Change 2.)
4. **Zero heartbeats with outstanding dispatched cards emits the warning** (Change 4), asserted on
   the log call, since the whole failure mode is that this state is silent.
5. **`dispatched_terminal` and `dispatched_at` are cleared together** — no reachable path leaves one
   set and the other NULL (Change 5).
6. **One authoritative writer for `handle.lastDataAt`** — source-level, so a future edit to
   `refresh()` or `attachLiveStream` that reintroduces the clobber fails (Change 3).
7. **The force-clear branch cannot match a live seat** whose name was reused after a tombstone.
8. **Neither composition root changes.** `bootstrap.ts` and `TaskViewerProvider.ts` are untouched by
   this diff; the heartbeat reaches both hosts through the shared sweep. Assert it rather than
   assume it, per `CLAUDE.md`.

### Goal Invariants

- A seat that is producing output keeps its card's `dispatched_at` indefinitely.
- A seat that has produced nothing for `timeoutMs` still loses it.
- No row ever carries `dispatched_terminal` with a NULL `dispatched_at`.
- If the heartbeat dies again, the first sweep says so in the log, by name.

### Manual

- Dispatch to a live coder seat; after 15 minutes the card is still lit and
  `/kanban/dispatch/state` reports a real state, not `"unknown"`.
- Kill a seat mid-dispatch; its card clears on the next sweep.
- Confirm a commit made by that seat carries its `Switchboard-Plan` trailer — the downstream symptom
  that motivated this card.
