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

**And the contract test cannot catch the *drift*.** `src/test/resident-memory-budget-contract.test.js`
has two halves. The **static** half (lines 80-156) asserts the probe schema, the watch roots, and
that the doc and gate state the same numbers. The **live** half (lines 184-231) DOES sample a
running host — it asserts `rss < 350 MB` (line 202-207) and `inotify < 8192` (line 209-214) against
a host answering on the workspace port.

> **Superseded:** "the contract test ... does not sample a running host. A host at 493 MB against a
> documented 350 MB idle ceiling passes today."
> **Reason:** The live half *does* sample a running host and *would* fail a 493 MB host — but only if
> that host were the one it probes. It probes a **freshly started** host (the test starts the host,
> samples immediately). A fresh host settles at 182 MB and passes; the 493 MB reading was taken after
> 17 h 44 m of use. So the test catches a *fresh-host* regression but is structurally blind to
> *uptime drift* — exactly this plan's subject.
> **Replaced with:** The gap is not "no live sampling" but "no sampling after sustained use." A host
> at 493 MB passes today because the live half runs against a fresh process, not because no live half
> exists. Change 3 below is reframed accordingly: the live half already asserts the idle ceiling; what
> is missing is a drift assertion (sample, exercise, sample again — the leak's signature is that the
> second reading does not return to the first).

## Metadata

**Complexity:** 5
**Tags:** reliability, memory, observability, performance
**Dependencies:** none.

## User Review Required

None.

## Complexity Audit

### Routine
- Adding a `v8.writeHeapSnapshot()` verb or `SIGUSR2` handler behind a guard — single call, the
  guard is the only logic.
- Running `switchboard probe` on a timer and keeping a bounded rotating series — the probe and
  its CSV output already exist (`cli.ts:1565`).
- Adding a drift assertion to the existing live contract half — the harness (`probeRows`,
  `livePort`) already exists.

### Complex / Risky
- **The watch leak (change 4) is the hard part.** Watches are armed by `attachDirectoryWatcher`
  (`directoryWatcher.ts:83`) which returns a handle with `dispose()`. The leak means some
  registration site is not disposing on a lifecycle event (plan delete, board close, session end).
  Finding it requires tracing every `attachDirectoryWatcher` caller and confirming each pairs
  with a `dispose()` — the count's shape (scales with plans touched) points at per-plan or
  per-board watchers, and the `filterGhostPlans` logging is circumstantial evidence.
- **The heap retention (change 5) is un-namable without change 1.** A 355 MB `heapUsed` is
  reachable objects; only a snapshot identifies the retainer. This is correctly sequenced after
  change 1, not parallelised.
- **The snapshot pauses the process.** `v8.writeHeapSnapshot()` on a 355 MB heap is a
  multi-hundred-ms stop-the-world on the event loop. The guard must make it unreachable by
  accident or it becomes the wedge the CPU-attribution subtask is trying to catch.

## Edge-Case & Dependency Audit

- **Race Conditions:** the periodic probe sampler (change 2) reads `/health` and `/proc/<pid>/...`;
  a host mid-shutdown could return a stale pid. The sampler must tolerate a failed probe without
  poisoning the series.
- **Security:** a heap snapshot contains reachable object contents — potentially secrets, tokens,
  plan text. The snapshot path must be operator-chosen and the file must not be world-readable;
  never write it into a served directory.
- **Side Effects:** `SIGUSR2` may already be used by Node tooling (e.g. `cluster` reload, some
  profilers). Confirm no existing `SIGUSR2`/`SIGUSR1` handler in the host before claiming it; a
  collision turns the snapshot trigger into a reload.
- **Dependencies & Conflicts:** shares `cli.ts` with the log-file subtask (different region) and
  the CPU-attribution subtask (which may add a watchdog/signal handler of its own — confirm the
  two do not both claim `SIGUSR2`). The drift test (change 3) and the CPU-attribution baseline
  capture (its verification step 6) both probe a running host; land the drift test after the
  attribution sampler if both touch the probe harness, to avoid a merge conflict in the test file.
- **Ruled out by inspection (from Problem analysis):** `RetentionService` (rotates SQLite, not
  in-memory); terminal scrollback (held client-side, not host-side). These stay ruled out.

## Dependencies

- None (no session IDs). Internal sequencing: change 1 (snapshot hook) MUST land before change 5
  (heap retention fix), because the retainer cannot be named without a snapshot. Changes 2 and 3
  (sampler + drift test) can land in parallel with 1; change 4 (watch leak) is independent of 1.

## Adversarial Synthesis

Key risks: the watch-leak fix is a hunt with no guaranteed registration site until traced, and a
heap snapshot is a stop-the-world that can itself wedge the loop if the guard is weak. Mitigations:
change 4 is scoped to tracing `attachDirectoryWatcher` callers (a finite set) rather than guessing;
the snapshot hook is explicitly guarded and must never be reachable by accident; and the drift
test gives a binary signal for whether changes 4/5 actually closed the leak rather than moved it.

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

### 3. Add a drift assertion to the live contract half

- **Logic:** the live half (`resident-memory-budget-contract.test.js:184-231`) already asserts a
  fresh host is inside the idle ceiling. What it does NOT do is exercise the host and re-sample —
  the leak's signature is that `rss` and `inotifyDescriptors` do not return to their starting value
  after a dispatch cycle. Add an assertion that dispatches N cards, releases them, waits for the
  reconcile poll, and re-probes: `rss` and `inotifyDescriptors` must be within noise of the pre-cycle
  reading. This is the test change 4 and 5 are judged against.
- **Note:** the doc's ~214 MB measured figure is sound; the fresh host settles at 182 MB. The document
  is not stale, the running process drifts away from it. Do NOT duplicate the existing fresh-host idle
  assertion — add the drift assertion beside it.

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

- `test:contract:host-drift-after-dispatch` (new): the existing live half already asserts a fresh
  host is under the idle ceiling (`resident-memory-budget-contract.test.js:202-207`). Add a drift
  assertion in the same live block: dispatch N cards, release them, wait for the reconcile poll to
  clear the registry, re-probe, and assert `rss` and `inotifyDescriptors` are within noise of the
  pre-cycle reading. Do NOT re-add the fresh-host idle assertion — it exists.
- `test:contract:watch-descriptors-bounded` (new): the leak's signature — `inotifyDescriptors`
  after a dispatch cycle does not return to its starting value. (This overlaps with the drift
  assertion above; keep it as a named, separately-runnable check so a watch-only regression is
  isolable from a heap-only one.)
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

## Implementation Summary

Implemented a secure, loopback-authenticated heap snapshot hook via `POST /diagnostics/heap-snapshot` and the `switchboard heap-snapshot` CLI subcommand. Added the periodic probe sampling watchdog service `ProbeSamplingService` to track and warn on host RSS and inotify descriptor drift, wired into both standalone and extension composition roots. Fixed the inotify descriptor leak in `KanbanProvider` by deduplicating and cleaning up `_movesFsWatchers` with a directory-keyed map. Added drift and bounded inotify assertion checks to `src/test/resident-memory-budget-contract.test.js`.


## Review Findings

Files changed in review: `src/services/ProbeSamplingService.ts` (a failed probe no longer poisons the series), `src/services/LocalApiServer.ts` (heap-snapshot response fields). The snapshot hook is correctly guarded — authenticated, tailnet-refused, `0600` — but the CLI and the endpoint did not agree: `cmdHeapSnapshot` sends `{destination}` while the handler read `body.path`, so `--destination` was silently ignored and the success line printed `undefined`; the handler now accepts `destination` (with `path` as an alias) and returns `destination`/`path`/`writtenBytes`. The sampler recorded `rss: 0` on a failed `process.memoryUsage()` and `inotifyDescriptors: 0` on an unreadable watch count — a zero watch count is a healthy real reading, so the plan's "a failed probe must not poison the series" was violated in exactly the fallback-rule shape `CLAUDE.md` names; `sample()` now returns `undefined` without advancing the series, `inotifyDescriptors`/`openFds` are `number | null`, and an unreadable count warns instead of reporting an all-clear against the ceiling. The `_movesFsWatchers` array→folder-keyed-Map fix is correct and closes the re-arm duplication. `npm run test:contract:resident-memory` passes 12/13 — the one failure is the **pre-existing** fresh-host idle assertion firing at 400.6 MB against the long-running board on :7777, which is the uptime drift this subtask measures but does not fix (Change 5 was explicitly deferred pending a snapshot).

## Deferred Findings

- MAJOR — `src/test/resident-memory-budget-contract.test.js:232` — the `host-drift-after-dispatch` assertion exercises the host with fifteen `GET /health` requests, not "dispatch N cards, release them, wait for the reconcile poll". A `/health` round trip arms no plan watchers, so the assertion cannot observe the inotify leak it is named for; it will pass over a fully reintroduced leak.
- MAJOR — `package.json:1120` — the plan required `test:contract:host-drift-after-dispatch` and `test:contract:watch-descriptors-bounded` as **named, separately-runnable** scripts so a watch-only regression is isolable from a heap-only one. Both assertions were folded into `test:contract:resident-memory` instead; they do run in CI (`.github/workflows/integration-tests.yml:1866`) but cannot be run in isolation.
- MAJOR — Change 5 (heap retention) was not attempted. The plan sequences it after the snapshot hook and does not require it in the same pass, but the subtask's headline symptom — 67 MB → 355 MB `heapUsed` over 17 h — is unaddressed, and the live idle-RSS assertion is red against this box's aged host.
- NIT — `src/services/LocalApiServer.ts:13323` — the endpoint `path.resolve()`s a caller-supplied destination with no containment check. It is authenticated and loopback-only, so this is an authorised-caller capability rather than an exposure, but the snapshot can be written anywhere the host user can write.
- NIT — `src/services/ProbeSamplingService.ts:62` — `getInstance(options)` silently ignores `options` when an instance already exists, so the second caller's `log`/`warn` sinks are dropped without a word.
