# Retire the Performance Instrumentation When the Optimising Is Done

## Goal

`cpuAttribution` and `eventLoopWatchdog` are scaffolding. They exist to make performance work
possible, they cost real resources on a Pi, and they have no purpose once that work is finished.
This card exists so they are removed deliberately rather than becoming permanent by inattention —
the failure mode for every diagnostic that outlives its investigation.

### Problem analysis

**They are deliberately kept, for now.** The operator reviewed both on 2026-09-15 and chose to keep
them, because the diagnosis they produce is not obtainable from outside the process:

- An external sampler can see *the board* is at 90% CPU. It cannot decompose that into the board
  process, the Go pty host child, each named CLI seat, and the browser — which is what
  `cpuAttribution` exists to do, and is step 1 of
  `attribute-switchboards-cpu-before-optimising-it.md`, that plan's stated load-bearing step.
- Nothing outside the process can capture a stack from *inside* a wedged one. `eventLoopWatchdog`'s
  docblock establishes why it must be a worker thread plus a `gdb` attach: a blocked event loop
  starves every in-loop mechanism at once — timers, libuv signal handlers, and Node's own
  `--report-on-signal` (upstream `nodejs/node#56879`, verified empirically on Node v24: an armed
  `reportOnSignal` produced nothing while the loop was blocked). A detector on the loop it watches
  cannot fire. `gdb` is present at `/usr/bin/gdb` on this host, so the escalation path works.

**Their cost is real and was measured, not estimated (2026-09-15, this Pi, 204 processes).**

- `cpuAttribution` samples every 5 s. Each sample reads `/proc/<pid>/stat` per tracked process,
  `/proc/stat`, and then `scanBrowserPids()` — a full `readdirSync('/proc')` plus a `readFileSync`
  of `comm` for **every** process, to locate a browser by name. Measured: **204 file reads,
  5.2–7.7 ms per scan (avg 6.1)**, once per 5 s ⇒ **~0.12% of one core sustained**.
- `eventLoopWatchdog` costs one `Atomics.add` per 250 ms on the main thread — negligible — plus a
  **worker thread**, which is a second V8 isolate polling a SharedArrayBuffer every 500 ms. The CPU
  is nothing on four cores; the memory is a small but real addition to a host already idling at
  350–451 MB.

To their credit, both were built knowing this: `cpuAttribution` records `samplerSelfMs` — the wall
time its own last sample took — inside its own output, so the sampler's cost is visible in the thing
it produces, and browser attribution is tagged `matchedBy: 'process-name'` rather than presented as
fact.

**A third service from the same feature is already gone.** `ProbeSamplingService` was removed on
2026-09-15 (`0bd47c42`). It was not the same class of thing: a 60 s timer warning against a
hardcoded 350 MB idle ceiling traceable to CLAUDE.md's *"182 MB RSS on a Pi 400 with no seats"* — so
on a board idling at 350–451 MB it fired every minute forever, and wrote to stdout only. A monitor
that always fires is not a monitor. These two produce a diagnosis; that one produced noise.

**Why a card and not a comment.** Scaffolding becomes permanent when the only record of its
temporariness is the memory of whoever added it. The work these gate is spread across 41
performance-tagged plans, and when the last one lands nobody will be thinking about the
instrumentation that made it possible.

### Root cause

Not a defect — a lifecycle gap. Temporary instrumentation was added without a retirement trigger,
which is how every long-lived diagnostic in every codebase got there.

## Metadata

**Complexity:** 2
**Tags:** refactor, performance, devops

## User Review Required

No. The operator decided on 2026-09-15 to keep both for now and to record their removal for later —
this card is that record.

## Settled Design

- **Removal is gated, not scheduled.** Do not act on this card on a date. Act on it when the
  condition below holds.
- **The trigger is checkable.** Both of the terminal-stream optimisations this instrumentation was
  explicitly parked in front of are COMPLETED:
  - `75334341` — *An idle seat that animates its cursor bills every viewer a frame*
  - `a8f75f5d` — *A keystroke echo waits on two frame boundaries it does not need*

  **and** no plan outside COMPLETED carries the `performance` tag and needs per-process attribution
  or a wedge stack to be verifiable. At the time of writing that set is 41 plans — 23 in
  CODE REVIEWED, 14 in PLAN REVIEWED, 4 in BACKLOG — so this card is not actionable yet, and saying
  so is the point.
- **Scope is exactly two services.** `src/services/cpuAttribution.ts` and
  `src/services/eventLoopWatchdog.ts`, plus their wiring in both composition roots.
- **`hostCapability.ts` is NOT in scope.** It reads once at startup, not periodically, and both
  providers consume it to *constrain behaviour* (`extension.ts:614`, `:1036`). It is load-bearing,
  not instrumentation, and removing it with its neighbours would be the mistake this card exists to
  prevent in the other direction.
- **`ProbeSamplingService` is NOT in scope** — already removed.
- **Removal lands in both roots together.** Both `bootstrap.ts` and `TaskViewerProvider.ts`
  construct their own instances; taking one is a divergence.

## Complexity Audit

### Routine
- Deleting two files and their call sites.

### Complex / Risky
- **Judging the trigger is the hard part, not the deletion.** "Performance optimisation is done" is
  not self-evident; the two named plans plus the tag sweep are the operational test, and someone
  must actually run it rather than assume.
- **Removing too early costs more than removing late.** These are the measurement the optimisation
  work is verified against. Deleting them while perf plans are still open means the next regression
  is diagnosed by guesswork — which is the state
  `attribute-switchboards-cpu-before-optimising-it.md` was written to end.

## Edge-Case & Dependency Audit

- **Race conditions / security.** None.
- **Side effects.** After removal, a wedged board produces no stack and CPU is attributable only to
  the process, not within it. That is the accepted trade, and it should be stated in the commit so a
  future debugging session knows the capability was removed rather than never existing.
- **Dependencies & conflicts.**
  - `attribute-switchboards-cpu-before-optimising-it.md` — the plan that added both. This card is
    its retirement half and should be read alongside it.
  - `75334341`, `a8f75f5d` — the two plans gated on this instrumentation; they are the trigger.
  - `209ce349` *The Host Accumulates Heap and inotify Watches Over a Day's Use* and `1023d997` —
    both rely on measurement over time. Confirm neither is open before removing.
  - **External sampling is the fallback and already exists in practice.** Reading `/proc/<pid>` for
    the board from outside gives RSS, threads, fds, inotify watches and CPU without perturbing the
    process or depending on it being alive. It is strictly weaker (no per-seat attribution, no
    in-process stack) and that is why these two are being kept for now, not replaced.

## Adversarial Synthesis

**Risk summary.** The deletion is trivial; the judgment is not. The two real failure modes are
opposite and both quiet: removing while perf work is still open, which silently returns the project
to guessing at CPU cost; and never removing at all, which is what this card exists to prevent and
the more likely of the two. A third, smaller risk is scope creep into `hostCapability`, which sits
in the same feature commit and looks like a sibling but constrains real behaviour.

## Proposed Changes

**None yet — this card is not actionable until the trigger holds.** When it does:

### Remove `src/services/cpuAttribution.ts`
- Delete the file and its wiring: the construction and `stop()` in `src/standalone/bootstrap.ts`,
  and the equivalent pair in `src/services/TaskViewerProvider.ts`.
- **Edge case:** check whether anything reads its snapshot over HTTP before deleting — a consumer
  would 404 rather than degrade.

### Remove `src/services/eventLoopWatchdog.ts`
- Delete the file, the worker it spawns, and the same two wiring sites.
- **Edge case:** confirm no gate or diagnostic endpoint asserts the watchdog exists.

### Optional interim, if these are kept much longer
- `scanBrowserPids()` (`cpuAttribution.ts:137`) runs a full `/proc` scan on **every** sample purely
  to locate browser PIDs, which change rarely. Caching it with an occasional re-scan removes ~95% of
  the service's I/O — about 200 of the 204 reads per 5 s — for no loss of attribution. Worth doing
  *only* if the retirement trigger turns out to be far off; otherwise it is work on code that is
  leaving.

## Verification Plan

### Goal Invariants

1. **Until the trigger holds, this card changes nothing** — `cpuAttribution.ts` and
   `eventLoopWatchdog.ts` are present and wired in both roots.
2. After removal: neither file exists, and no reference to either remains in `src/`.
3. After removal: `src/services/hostCapability.ts` is **untouched** and still consumed by both
   providers. *(Paired positive — the negative invariant above must not be satisfied by deleting the
   whole host-costs feature.)*
4. After removal: both composition roots are changed in the same commit.
5. The trigger is recorded in the closing commit — which plans were checked, and that the
   performance-tagged set outside COMPLETED was empty of dependents at that time.
