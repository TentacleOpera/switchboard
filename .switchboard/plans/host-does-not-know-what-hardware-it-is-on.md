# Switchboard Does Not Know What Hardware It Is On, So Nothing Warns Before a Small Box Runs Out

kanbanColumn: CREATED

## Goal

The host measures its own memory and cores once at startup, records the figures with their source,
shows them to the operator, and refuses to silently sail past them. A seat that would take the box
past its measured headroom is reported before it starts, and agents dispatched on a constrained
host are told they are on one.

### Problem analysis

**Nothing in `src/` reads host capability.** `os.totalmem`, `os.freemem`, `os.cpus`,
`os.availableParallelism` and `loadavg` appear nowhere outside tests. Switchboard behaves
identically on a 128 GB workstation and a 3.7 GB Pi 400: the same seat counts, the same dispatch,
the same prompts. The only concurrency ceiling anywhere is `_maxConcurrentSyncs = 3` in
`ContinuousSyncService`, which is about tracker sync and has nothing to do with the machine.

**Measured on a Pi 400, 2026-09-06.** Two agent seats: 964 MB of 3.8 GB, CPU 95% idle, 45°C, swap
untouched — comfortable. Five seats plus one `npm test`: 1.9 GB used, webpack alone at 582 MB and
167% CPU, run queue 5–8 against 4 cores, and **the first swap use this box has seen**. Nothing
reported any of it. The operator found out by asking.

Note what did *not* fail. The SD card kept up — `vmstat` io-wait was 0–1%, so the constraint is
memory and cores, not disk. Thermals were 47.7°C with `throttled=0x0` and the ARM clock at its
full 1800 MHz. A safeguard aimed at temperature or disk would be aimed at the wrong thing.

**The trigger was a build the host did not need.** `npm test`'s pretest chain runs
`compile-tests && compile && lint` — a full `tsc`, a full webpack over 184 TypeScript files, and
eslint over `src` — and `CLAUDE.md` states `dist/` is not used during development or testing. So
the single heaviest process on the box produced 60 MB nothing would read. That specific waste is a
repo fact and belongs in the repo's own guidance, not here. What belongs here is that **the host
had no way to know the request was disproportionate to the machine**, and no way to say so.

**This is a fallback-rule problem before it is a resource problem.** Today the absence of a
capability read is indistinguishable from a machine with infinite capability. There is no value to
be wrong about, which is why no gate catches it and why it has never been reported as a bug — it
presents as slowness, not as a fault.

## Metadata

- **Complexity:** 5
- **Tags:** infrastructure, standalone, both-hosts, reliability, raspberry-pi

## User Review Required

None. Three scoping decisions are taken here rather than deferred: the ceiling is derived from
measurement and never asked for as a setting, the guard reports and proceeds rather than blocking,
and the agent-facing directive says nothing repo-specific.

## Proposed Changes

### 1. Measure once, and tag the reading

A `hostCapability` service reading, at startup: total memory, available memory, core count, and
whether the process is inside a cgroup memory limit (a container gets `os.totalmem` of the *host*,
which on a constrained deployment is the exact wrong number). It returns
`{ value, source }` per the fallback rule — `source` being `'cgroup'`, `'os'` or `'unavailable'` —
and logs the source where it is used.

**`'unavailable'` must not resolve to a plausible number.** A host whose capability cannot be read
is reported as unknown and every consumer below treats unknown as "do not constrain", because
guessing small would throttle a workstation and guessing large is what happens today. Unknown is a
third state, not a synonym for either.

### 2. Wire it in both composition roots

The service is constructed and handed to the same consumers in `src/extension.ts` **and**
`src/standalone/bootstrap.ts`. This is the seam class that has silently diverged four times in this
codebase, and the failure mode here is the quiet one: an unwired capability service returns
unknown, unknown means "do not constrain", and the standalone host — *the one most likely to be on
a Pi* — is exactly the host that would lose the feature while every gate stayed green.

Diff the two roots by hand. A verb-reachability check will not catch this.

### 3. Report the ceiling at dispatch, and proceed

When starting a seat would take the count past what the measured memory supports, say so — in the
dispatch result and in the log — naming the figures: seats running, memory used, memory total, and
the estimate that was exceeded.

**It reports; it does not block, and it must never prompt.** No confirmation dialog, no "are you
sure", no two-click pattern — that is a hard rule in this codebase and a resource warning is not an
exception to it. The operator dispatching a sixth seat onto a Pi may know exactly what they are
doing; what they cannot currently do is find out that they are doing it.

The per-seat estimate comes from observed RSS of running seats, not a constant. A constant would be
wrong for every CLI — measured here at 91–325 MB across `devin` and `agy` on the same box, a 3.5×
spread — and a wrong constant is a fallback that behaves like a measurement.

### 4. One directive, and nothing repo-specific in it

A `CONSTRAINED_HOST_DIRECTIVE`, injected only when capability is known **and** below threshold,
joining the ~20 existing fragments in `agentPromptBuilder.ts`. It states the machine's memory and
core count and asks the agent to prefer the cheapest verification that satisfies the plan, and to
say so when it declines an expensive step.

It must not name commands, scripts or build systems. `npm test` running an unnecessary webpack is a
fact about this repository, and the place for it is the repo's own constitution or `CLAUDE.md` —
a directive that hardcodes it would be wrong in every other workspace and would rot here the moment
the pretest chain changes. The directive supplies the *fact about the machine*; the repo supplies
the *fact about its build*.

`SKIP_COMPILATION_DIRECTIVE` already exists and is operator-controlled. Do not re-point it at
hardware. An operator toggle that starts flipping itself based on a measurement is precisely the
fallback that behaves like a configured value.

## Edge-Case & Dependency Audit

1. **Both hosts, and standalone is the one that matters.** See change 2. The extension host is
   usually a workstation; the standalone host is what runs on a Pi.
2. **Containers report the host's memory.** `os.totalmem` inside a container is the machine's, not
   the container's limit. Read the cgroup limit where present and prefer it; record which answered.
3. **A shared machine.** Memory used by other tenants is invisible to `os.freemem` accounting done
   naively. Report used-vs-total from the OS rather than inferring from seat count alone.
4. **Thermal and disk are deliberately excluded.** Both were measured healthy on the constrained
   box — `throttled=0x0`, io-wait 0–1%. Adding thermal or SD-wear monitoring would be guarding a
   failure that has not been observed. The SD write volume (18.3 GB in 13 h) is a hardware-choice
   argument, not a runtime safeguard.
5. **Do not build a scheduler.** No queueing of seats, no deferral, no admission control. This plan
   measures and reports. A host that starts making dispatch decisions for the operator is a much
   larger change and is not justified by anything observed.
6. **Unknown must stay cheap.** If capability cannot be read, no directive is injected and no
   ceiling is reported. Silence on an unmeasurable host is correct; a warning about a number nobody
   has is noise.

## Verification Plan

1. On the Pi, `hostCapability` reports 4 cores and ~3.7 GB with `source: 'os'`, and the figures
   appear in the log and in the operator-facing panel.
2. On a machine where the reading fails, the source is `'unavailable'`, no directive is injected,
   and no ceiling is reported — nothing substitutes a plausible number.
3. Inside a container with a memory limit below the host's, the reported total is the **cgroup**
   limit and the source says so.
4. Starting a seat past the measured headroom emits a report naming seats, used, total and the
   estimate — and **the seat still starts**. No dialog appears at any point.
5. The per-seat estimate tracks observed RSS: with `devin` at ~118 MB and `agy` at ~290 MB running,
   the estimate is not a single constant.
6. An agent dispatched on the Pi receives `CONSTRAINED_HOST_DIRECTIVE` containing the machine's
   figures and **no** command, script or build-system name.
7. An agent dispatched on an unconstrained host receives no such directive.
8. `SKIP_COMPILATION_DIRECTIVE` is unchanged and still follows only its operator toggle.
9. The service is constructed in both `extension.ts` and `bootstrap.ts`, verified by reading both
   composition roots — not by checking that a verb answers.
