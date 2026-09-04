# Startup Orientation Fires Into a Working Agent and Tells It to Stop

kanbanColumn: CREATED

## Goal

A seat that has been given work never receives the startup orientation. The orientation exists to hold an idle seat until it is dispatched; delivering it to a seat mid-task stops the task.

### Problem analysis

**Observed 2026-09-04. A coder sat idle for hours holding a task it had already started.**

The sequence:

1. The seat is created. `_relayStartupOrientation` (`TaskViewerProvider.ts:1436`, `bootstrap.ts:583`) is fired and forgotten — `void (async () => …)()`.
2. It waits for the seat to go quiet via `waitForSeatQuiescence`: 1200 ms of silence, or 4000 ms with no output at all.
3. The dispatch arrives inside that window. The coder reads the plan, greps the tree, starts work — **continuous output, so quiescence never arrives**.
4. `ORIENTATION_MAX_WAIT_MS = 15000` fires. Its comment states the intent plainly: *"hard cap: always relay eventually."*
5. The orientation lands in a working agent: *"Startup orientation — your standing orders follow. Acknowledge them in one line and wait; **do not begin any work until you are given a task.**"*
6. The coder obeys. It acknowledges, stops, and waits for a task it is already holding. Only an operator asking "have you not finished your task?" unsticks it.

**Three things compose into it.**

- **The wait cannot distinguish a booting CLI from a working agent.** Both are output. Quiescence is a proxy for "the CLI has finished starting", and it does not mean that once work has begun.
- **Nothing cancels the relay.** `grep -nE "cancel|dispatched|hasWork|suppress" src/services/startupOrientation.ts` returns nothing. The relay has no idea a dispatch happened, and the dispatch path never tells it.
- **The message is an imperative, not a notice.** "Do not begin any work" is a direct instruction that a compliant agent will follow over the task in its context. A well-behaved coder is *more* likely to get stuck, not less.

**And by then it is redundant.** The dispatch prompt already carries the standing-orders block inline — it is visible at the end of the task prompt in the reported transcript. The orientation's only job is holding a seat that has *not* been dispatched.

## Metadata

- **Complexity:** 3
- **Tags:** teams, dispatch, prompts, both-hosts, bugfix

## User Review Required

None.

## Proposed Changes

### 1. A dispatched seat does not get the orientation

Cancel the pending relay when a dispatch is delivered to that seat, or have the relay check before sending and drop out. Either is fine; what matters is that the seat's state at *send* time decides, not its state at *schedule* time.

This is the whole fix. The remaining changes make the failure loud rather than silent if it recurs.

### 2. The hard cap must not mean "send regardless"

`ORIENTATION_MAX_WAIT_MS` exists so a seat whose CLI never settles still gets its orders. That is reasonable for an idle seat and wrong for a busy one. On expiry, send only if the seat is still undispatched; otherwise log that the orientation was dropped and why.

"Always relay eventually" is the line that turned a timeout into a stop command.

### 3. Soften the imperative

Even correctly targeted, "do not begin any work until you are given a task" is a strong instruction to an agent that may already have one. Phrase it so a seat holding work is not told to abandon it — the orders themselves are what matter, not the wait.

## Edge-Case & Dependency Audit

1. **Both hosts.** `TaskViewerProvider.ts:1436` and `bootstrap.ts:583` carry the same relay. Fixing one leaves the other stuck.
2. **The genuinely idle seat still needs its orders.** This must not turn into "never send the orientation" — a seat created and not dispatched still needs holding.
3. **A dispatch that arrives after the orientation is fine** and is the normal path. This is only about the reverse order.
4. **Three call sites schedule the relay** (`:3965`, `:3971`, `:13643`) — a team start, a create result, and a worker spawn. The guard must cover all three, not the one that was debugged.
5. **Related but distinct: `7dae7ef2`** covers the after-*clear* standing-orders block leaving a lead awake with no task. Same family — a task-less prompt reaching a seat that should be working — different trigger. Do not merge; do check the fixes agree.

## Verification Plan

1. A seat created and dispatched within 15 seconds receives the dispatch and no orientation.
2. A seat created and left undispatched still receives its orientation.
3. A seat producing continuous output when the cap expires, having been dispatched, gets nothing and the drop is logged.
4. Both hosts behave identically.
5. All three relay call sites are covered.
6. A coder that receives an orientation while holding a task does not abandon the task.
