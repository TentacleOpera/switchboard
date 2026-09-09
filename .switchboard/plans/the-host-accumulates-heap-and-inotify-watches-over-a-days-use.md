# The Host Accumulates Heap and inotify Watches Over a Day's Use

## Goal

Stop the standalone host drifting away from its own published budget while it runs. Two things grow
with uptime and are never given back: resident heap and inotify watch descriptors. Neither is
sampled over time, so the drift is invisible until someone measures by hand.

### Problem analysis

**Measured on the Pi 400 host, 2026-09-09/10. Both readings taken with ZERO terminals live**, so the
fleet is not the variable — the same host, one restart between them:

| | rss | heapUsed | heapTotal | inotify watches |
|---|---|---|---|---|
| after 17 h 44 m of use | **493 MB** | **355 MB** | 362 MB | **549** |
| fresh restart, settled | **182 MB** | 67 MB | 69 MB | **2** |

**The heap is retained, not merely un-shrunk.** `heapUsed` went 67 MB → 355 MB, a 5× increase in
*reachable* objects. V8 declining to return pages would look like a large `heapTotal` against a small
`heapUsed`; this is the opposite, so something is holding references. 144 MB of the old instance had
been pushed to swap and never touched again — consistent with retained-but-unused state.

**The watch count is the more dangerous of the two.** 2 → 549 descriptors over one day. It is a hard
kernel limit, not a soft one: `docs/LOW_MEMORY_HOSTS.md` budgets **< 8,192** and states *"the ceiling
is the target, not something the operator raises"*, and records a prior regression holding **17,218**
— twice a Pi's entire allowance. This box currently has `max_user_watches = 30517`, i.e. the limit
**has** been raised here, so the Pi that the budget is written for would hit trouble long before this
one does.

**Why it matters on the target hardware.** 311 MB of drift is an eighth of the 2 GB minimum the site
advertises, accruing silently across a day of exactly the usage the product is for. The box gets
slower the longer it has been useful, and a restart is the only remedy.

**Ruled out by inspection**

- `RetentionService` is not the heap holder — its rotation works on SQLite (`plan_events` selects and
  archives, `RetentionService.ts:404-441`), not on an in-memory window.
- Terminal scrollback is not held by this process. Every `scrollback` reference in `src` concerns the
  *agent's* buffer or xterm.js on the client, not host-side retention.

**Not yet ruled out:** per-dispatch board state, websocket surface state (14 clients were connected on
the aged instance), plan/feature caches in `KanbanDatabase`, and file watchers registered per plan or
per board — the last being the obvious suspect for the watch count, since watches and dispatches both
scale with plans touched.

**The measurement surface already exists; nothing uses it over time.** `lc probe` (today
`switchboard probe`) emits precisely the right columns and costs almost nothing to run:

```
timestamp,pid,rss,heapUsed,heapTotal,external,arrayBuffers,inotifyDescriptors,openFds
2026-09-09T20:39:46.181Z,409949,186302464,70168200,72441856,4425163,564086,2,34
```

So this is not a missing-instrumentation problem. It is a nobody-is-looking problem.

**And the contract test cannot catch it.** `src/test/resident-memory-budget-contract.test.js` asserts
that the published document and the gate state the same numbers — it does not sample a running host.
A host at 493 MB against a documented 350 MB idle ceiling passes today.

## Metadata

**Complexity:** 5
**Tags:** reliability, memory, observability
**Dependencies:** none.

## User Review Required

None.

## Proposed Changes

### 1. A heap snapshot hook, because the cause cannot be named without one

- **Logic:** the host has no way to produce a heap snapshot. `grep -rn "writeHeapSnapshot|--inspect|heapdump"`
  over `src` returns nothing, and `process.memoryUsage()` at `LocalApiServer.ts:11863` is the only
  memory surface. Totals say the heap is retained; only a snapshot says by what.
- **Implementation:** `v8.writeHeapSnapshot()` behind a verb or a `SIGUSR2` handler, writing to a path
  the caller names. Guard it — a snapshot of a 355 MB heap is a large file and pauses the process
  while it is written, so it must never be reachable by accident.
- **Do this first.** Everything below is either measurement or a guess until a snapshot exists.

### 2. Sample the probe periodically and warn on drift

- **Logic:** `lc probe` already emits the right columns. Run it on a timer, keep a bounded series, and
  warn when `rss` crosses the documented idle ceiling with no terminals live, or when
  `inotifyDescriptors` crosses a fraction of `fs.inotify.max_user_watches`.
- **Bounded:** the series must itself be small and rotate, or the thing watching for a leak becomes
  one.

### 3. Make the budget contract test sample a live host

- **Logic:** the existing test proves the doc and the gate agree. Add an assertion that a host started
  with no fleet is inside the idle ceiling — a real reading, not a restatement of the document.
- **Note:** the doc's ~214 MB measured figure is sound; the fresh host settles at 182 MB. The document
  is not stale, the running process drifts away from it.

### 4. Find and fix the watch leak

- **Logic:** 2 → 549 in a day, and watches are registered per something that scales with use. Find
  the registration site, confirm nothing unregisters, and unregister it.
- **Where to look:** watchers keyed by plan file or board, given the count's shape. The kanban ghost-plan
  logging (`filterGhostPlans`, which fired on every tick for a plan file that did not exist) is
  evidence that per-plan machinery outlives the plan.

### 5. Find and fix the heap retention

- Named after change 1 produces a snapshot. Not guessed at here.

## Verification Plan

### Automated Tests

- `test:contract:host-idle-memory-live` (new): start a host, no fleet, assert `rss` under the
  documented idle ceiling from an actual reading.
- `test:contract:watch-descriptors-bounded` (new): dispatch N cards, release them, assert
  `inotifyDescriptors` returns to its starting value — the leak's signature is that it does not.
- The heap-snapshot hook is not reachable without explicit invocation.

### Goal Invariants

- With no terminals live, `rss` is inside the published idle ceiling regardless of uptime.
- `inotifyDescriptors` after a dispatch cycle equals the count before it.
- Every column the probe emits has a threshold something checks.

### Manual

1. Fresh host, no fleet: probe. Record.
2. Run a team through several cards, release it, wait for the reconcile poll to clear the registry.
3. Probe again. `rss` and `inotifyDescriptors` should be within noise of step 1. Today they are not:
   the measured drift is +311 MB and +547 watches over a day.

## Outstanding Questions

- Is the drift proportional to dispatches, to plans touched, or to uptime alone? Step 2 above answers
  it and narrows change 4 and 5 considerably. Worth measuring before either is attempted.
- `fs.inotify.max_user_watches` is 30517 on this box, not the 8192 the budget assumes. Was that raised
  deliberately? If so the doc's premise needs revisiting; if not, the box is masking a limit the
  target hardware would hit.
