# A Seat That Finishes Without Reporting Is Watched by Nothing Once the Queue Is Empty

kanbanColumn: CREATED

## Goal

A seat holding an uncompleted card that has gone idle is noticed, whether or not anything is queued behind it. The lead is told, once, and can act.

### Problem analysis

**Observed 2026-09-04.** A coder completed its work and did not post its completion report. Its lead waited hours. Nothing nudged either of them, and the operator had to notice by hand.

The guard for this appears to exist. `PlanIngestionEngine.ts:1542` carries the message verbatim:

> `[switchboard:turn-end] Queue stall (seat pacing) — you have gone idle holding card 'X' with N card(s) staged in the dispatch queue.`

It is armed in both hosts — `bootstrap.ts:3189-3221` wires all four queue seams, so the extension-only divergence recorded in `CLAUDE.md` is fixed and is not the cause here.

**The cause is the scope.** At `:1324` the watch short-circuits:

```js
const queueCards = board.filter(…);       // :1319
if (queueCards.length === 0) { … }        // :1324
```

Every branch below that gate — the no-pacer escalation, the dead-seat re-stage, and the idle-seat nudge at `:1542` — runs only when cards are **staged in the dispatch queue**. The whole mechanism exists to keep a queue moving.

The lead in the reported case had dispatched all of its subtasks. Nothing remained staged. So the queue was empty, the watch returned, and a seat sitting idle holding an uncompleted card was never examined. There was no queue to stall, so nothing looked.

**The signal to detect this already exists and is already plumbed.** `_terminalLivenessProvider` (`:333`) supplies `{ friendlyName, lastDataAt, status }` per seat, and `dispatched_at set / completed_at NULL` identifies a held card. A seat whose `lastDataAt` is older than the liveness window while holding such a card has either finished and not reported, or died. Both need the lead told.

**This does not mean inferring completion.** Completion remains the explicit POST and nothing here changes that — a nudge says *"this seat has gone quiet holding your card"*, never *"this card is done"*. The lead decides.

**Why the lead did nothing on its own.** It had no signal to act on. The coder's report is the only event that reaches it, and the seat never sent one. A lead waiting on a report it will never receive cannot distinguish that from a coder still working, for exactly the same reason the watch cannot.

## Metadata

- **Complexity:** 4
- **Tags:** teams, completion, watchdog, both-hosts, bugfix

## User Review Required

None.

## Proposed Changes

### 1. The idle-seat check runs regardless of the queue

Move the "seat has gone idle holding an uncompleted card" check out from behind the `queueCards.length` gate. A held card and a quiet seat are the whole condition; what is or is not staged behind it is irrelevant to whether that seat needs attention.

The existing branches that genuinely concern the queue — no pacer with cards staged, dead pacer to re-stage — keep their gate. This is one check moving, not a rewrite of the watch.

### 2. Say it to the lead, not only to the seat

The message at `:1542` is addressed to the seat (*"you have gone idle"*). In the reported case that seat had stopped producing anything, so a prompt to it may land on an agent that has already ended its turn.

The party that is stuck is the lead. It is waiting on a report and cannot know it will not arrive. Tell the lead which seat is quiet and which card it holds, so the recovery it already has a ladder for can start.

### 3. Once, not repeatedly

A seat can be legitimately quiet — thinking, waiting on a long build, blocked on a prompt. The nudge fires once per seat per held card and does not repeat until something changes. A watchdog that repeats becomes noise, and noise is ignored, which is the same as not having one.

### 4. Do not infer completion from silence

Explicitly, because the temptation is obvious once a seat is detected as done-looking: silence is not a completion. The card stays open, `completed_at` stays NULL, and the lead posts as it does today. This produces a notification and nothing else.

## Edge-Case & Dependency Audit

1. **A genuinely slow seat must not be declared stuck.** The liveness window is the existing tunable; use it rather than a new literal. Note that `LocalApiServer.ts:5322` hardcodes 90000 where three other readers take it from configuration — do not add a fourth hardcode.
2. **A seat holding a card with no queue behind it is the *normal* end state**, not an error. The nudge is informational and must read that way.
3. **A dead seat is already handled** by the dead-pacer branch when a queue exists. Confirm the two paths do not both fire when a queue is present.
4. **Both hosts.** The seams are wired in both now; the change is in shared code, but verify the liveness provider is supplied in each.
5. **Relates to `711fa15e`.** A stale `completed_at` from a previous run makes a held card look complete, so this check would skip a seat that is genuinely stuck. That card resets the field on dispatch and this one depends on it being right.
6. **`3b387cf6`** (*Team lead escalation must exhaust cheap recovery before declaring a subtask blocked*) owns what the lead does once told. This card only makes sure it is told.
7. **A false nudge is cheap; a missed one costs hours.** Where the two trade off, prefer telling the lead.

## Verification Plan

1. A seat that finishes and does not report, with an empty queue, produces a nudge naming the seat and the card.
2. The lead receives it, not only the silent seat.
3. It fires once, not on every tick.
4. A seat that is merely slow, still producing output, produces nothing.
5. No card is marked complete by this path under any circumstances.
6. The existing queue-stall branches still fire when cards are staged.
7. Both hosts behave identically.
