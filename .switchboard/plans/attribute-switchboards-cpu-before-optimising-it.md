# Attribute Switchboard's CPU before optimising it, and catch the wedge in the act

## Goal

Make CPU cost attributable per process and per terminal, and make a blocked event loop dump
where it is blocked. Today "Switchboard is at 90%" cannot be decomposed into the board, the pty
host, the agent CLIs, or the browser — so neither the sustained load nor the wedge can be fixed
without guessing.

### The problem

Two observations, possibly the same cause at different magnitudes:

1. **Sustained.** Four cores of an i9 sit at 87-95% with the standalone board and 4-8 agent CLI
   terminals running.
2. **The wedge.** A board spinning at 98.7% CPU for 1d14h with a blocked event loop, recorded in
   `a-wedged-board-holds-its-port-and-every-liveness-check-lies.md` — and a machine freeze
   requiring a restart, in **attached** mode, which disconfirms that plan's framing of the spin
   as detach-specific and its note that it "may not recur".

Whether these are one problem or two is exactly what cannot currently be answered.

### Root cause of the *unfixability* — nothing attributes cost

The wedged-board plan deferred this deliberately: *"Whatever caused the spin. The specific
infinite loop is unknown and may not recur… diagnosing that one is separate work."* That was the
right call then and this plan is that work. It has to start with attribution, because a
mis-attributed optimisation is worse than none.

**Every byte of terminal output is handled several times, across three processes.** The path is
pty `onData` → per-terminal coalescing buffer → a 6ms flush tick → one coalesced frame → append
to a 256KB scrollback ring (`MAX_SCROLLBACK_BYTES`, `terminalWsGateway.ts:6`) → tee to the
terminal log writer (`:329`) → serialize → WebSocket to the browser → xterm render, in a
separate process again. Agent CLIs are full-screen TUIs that redraw continuously — spinners,
streaming tokens, progress — so this path runs at the CLIs' redraw rate, times the number of
seats.

Nothing measures the volume, so the cost of that fan-out is unknown, and so is its share
relative to the CLIs themselves, which are independent processes and plausibly the majority.

**Verified NOT a cause — do not spend time here.** `OUTPUT_FLUSH_MS = 6`
(`terminalWsGateway.ts:92`) looks like a 167Hz wakeup, but `flushAllPending` (`:1000`-ish)
clears its own interval the moment `pendingFlushTerminals` is empty and re-arms on the next
output. It is proportional to output, not a permanent tick. Recorded here so the next
investigation does not re-derive it.

**The wedge is invisible while it happens.** A blocked loop starves signal handlers, HTTP
callbacks and health responses simultaneously, so by the time it is noticed there is nothing
left that can report on it. Catching it requires something that runs *outside* the blocked loop.

## Implementation

### 1. Per-process CPU attribution

Sample and record CPU and RSS per process, tagged by role: the board, the pty host child, each
agent CLI (by seat name), and — separately, because it is a different process tree — the
browser. Sample on a low frequency; this is a diagnostic, and a sampler that costs CPU corrupts
the thing it measures.

Surface it where the operator already looks rather than in a log they must find. The point is
that "Switchboard is at 90%" resolves into a named list.

This is the load-bearing step. Steps 2 and 3 are only worth their complexity if this shows the
board's own share is significant; if the CLIs dominate, the finding is that the system needs seat
limits or model choices, not micro-optimisation, and this plan should stop there and say so.

### 2. Event-loop lag detector with a stack dump

Run a lag probe — a timer that measures its own drift — and when drift exceeds a threshold,
capture a stack of what the loop is executing and write it to disk, not to the HTTP surface (a
blocked loop cannot serve HTTP; that is the defining symptom).

The capture mechanism must not itself require the blocked loop. A watchdog thread or a signal
handler that triggers a diagnostic dump is the shape; whichever is chosen, verify it fires under
a deliberately-induced busy loop before trusting it.

This is what would have identified the 1d14h spin, and what will identify the next one.

### 3. Output-volume instrumentation on the fan-out

Count bytes and frames per terminal per second through the gateway, and record time spent in the
flush path. This makes the per-byte cost measurable rather than argued about, and it will
directly show whether a single misbehaving TUI (one seat redrawing at an absurd rate) accounts
for a disproportionate share.

Pair it with a per-terminal ceiling: a seat producing pathological output volume should be
detectable, and ideally throttled with a visible notice, rather than being allowed to saturate
the host silently.

### 4. Only then, fixes

Do not pre-commit to optimisations in this plan. Candidates the instrumentation may or may not
justify — coalescing more aggressively, capping scrollback retention, skipping the WS broadcast
for panes not currently visible, moving the log tee off the hot path — are all plausible and all
unfounded until step 1 and step 3 produce numbers. Write the fixes as a follow-up plan informed
by the data.

### Relationship to the wedged-board plan

That plan makes a wedge **survivable** (detectable, stoppable, not holding the port). This plan
makes it **diagnosable**. They are independent and either can ship first — but note the
survivability half has not shipped: `cli.ts:1147` still gates `stop` on `findRunningInstance`,
so a wedged board is still refused before the existing `SIGTERM`→`SIGKILL` escalation can run.
Given the freeze, that half is worth pulling forward regardless of what this plan finds.

## Verification Plan

1. With 4-8 seats running, the attribution surface accounts for the machine's CPU: board, pty
   host, each named CLI seat, browser. The sum is consistent with what the OS reports — if it is
   not, the attribution is wrong and nothing downstream can be trusted.
2. The sampler's own cost is measured and negligible with 8 seats.
3. Induce a busy loop in the board deliberately. The lag detector fires, a stack dump lands on
   disk naming the loop, and the dump is written **while** the loop is still spinning — not
   after it ends.
4. Confirm the dump path works when `/health` is already failing, since that is the real
   condition.
5. Drive one seat to high output (a large `cat`, a fast-redrawing TUI) and confirm the volume
   instrumentation attributes the spike to that seat.
6. Baseline capture: record the attribution with 1, 4 and 8 seats idle, and again under load, so
   the follow-up plan has a before.
7. Both hosts where applicable — the gateway and pty host are standalone; the extension host runs
   its own pty host child. State explicitly which measurements apply to which.
8. `npx tsc --noEmit -p tsconfig.json`.

## Metadata

**Complexity:** 5
**Tags:** backend, performance, reliability, devops
