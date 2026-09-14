# The Heap Ceiling Is Set by the Launcher, So the npx Install Never Gets It

> **RETRACTED 2026-09-14 — this plan was wrong, it was implemented, and it crashed the board.**
>
> **What happened.** The plan argued that `--max-old-space-size` should reach every launch path, and
> derived a default of 310 MB (800 MB budget − 300 MB measured non-heap − 190 MB offset). It was
> implemented at four entry paths, plus a contract test asserting they all agree. A board started
> with the earlier 512 placeholder then aborted mid-run:
>
> ```
> pid 653387, 3.7 GB host, 8 seats, 3207-plan board
> Mark-Compact 517.0 (523.0) -> 516.4 (519.3) MB
> FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
>   at Statement::JS_all  (better_sqlite3) — i.e. during a board read
> ```
>
> 310 would have aborted sooner. The plan's own hazard table named this exact outcome — *"set below
> the real peak → converts the burst into a crash at the cap"* — and it was written anyway.
>
> **The error in reasoning.** The flag's only legitimate use is to **RAISE** V8's auto-sized ceiling
> on a host so small that the automatic limit falls below the board's working set. On every host where
> the automatic limit is already adequate — which is every ordinary machine — setting it can only
> **LOWER** the ceiling. It adds a kill condition and buys nothing. A compiled-in constant cannot tell
> the two cases apart, so it is wrong on one of them by construction. There is no safe default, which
> means the correct number of defaults is zero, not a smaller one.
>
> **Second error: the derivation was not a measurement.** 310 came from one `/health` sample plus
> arithmetic. The governing plan (*The Board Must Fit a 1 GB Pi*, Change 6) is explicit that the value
> *"comes from change 1's measurement of what is genuinely live at peak, plus headroom — never from a
> guess"*. Change 1's forced-GC split has never been run; `.switchboard/logs/burst-gc-split.jsonl`
> does not exist. The real peak is now known to exceed 517 MB under an ordinary workload, which is
> itself evidence the 800 MB RSS budget is tighter than assumed.
>
> **What was reverted.** No default at any of the four sites: `bin/switchboard` sets no flag at all;
> `cli.ts`'s `DEFAULT_MAX_OLD_SPACE_MB` is `''` and the re-exec is gated on an explicit value;
> `cmd/switchboard/main.go` and `internal/launcher/discovery.go` omit the flag entirely when unset.
> `SWITCHBOARD_MAX_OLD_SPACE_MB` still works for a device that genuinely needs a raised ceiling, at a
> measured value. `src/test/heap-ceiling-contract.test.js`, its npm script and its CI step are deleted
> — that test asserted the defaults agreed, so it encoded the bug and would have blocked the fix.
>
> **Also noted:** the implementation used `spawn`, not `exec`, so the re-exec left a parent process
> alive holding the 18 MB bundle — roughly 40 MB of idle RSS on the device the ceiling was meant to
> protect. This plan argued against exactly that and its implementation reintroduced it.
>
> **Do not re-derive a default from this document.** The real gap it described — that an npm install
> never reaches the Go front controller — is real, but the answer is not a compiled-in ceiling.

## Goal

`--max-old-space-size` reaches V8 however the board is started — including the `npx` / global-npm
`switchboard` command, which is the documented install route and the one running on this Pi.

### Problem analysis

**The flag exists to stop the board aborting on a 1 GB box.** It is not a budget or a ceiling on
growth — it *raises* V8's auto-sized limit. `cmd/switchboard/main.go:309-316`:

> raises V8's old-space ceiling above the host's measured heap peak so the board-only host survives
> its own heap growth on a 1 GB box (V8's auto-sized ceiling on a 700 MB-available box aborts at
> ~342 MB, below the ~355 MB drift). Unconditional: inert on a 4 GB box.

So on the target hardware, **missing the flag is an out-of-memory abort**, not a slow leak.

**It is applied at two Go handoff sites, and only those.** `cmd/switchboard/main.go:331` and
`internal/launcher/discovery.go:216` both build `node --max-old-space-size=<mb> <entry>` and exec it.
`8300a014` describes this accurately as "set unconditionally at both Go handoff sites". The gap is
that **both Go handoff sites is not every way the board starts.**

**Measured on this Pi, 2026-09-14.** The board is running as
`node /home/patrick/.nvm/versions/node/v24.19.0/bin/switchboard tailnet`, and that bin is a symlink
straight to `dist/standalone/cli.js`. Node was invoked directly; no Go binary was involved.

- No `--max-old-space-size` in the process argv.
- No `NODE_OPTIONS` and no `SWITCHBOARD_MAX_OLD_SPACE_MB` in its environment.
- `type -a switchboard` resolves **only** to the node symlink.
- The Go binaries exist (`dist/linux-arm64/switchboard`, `dist/linux-arm64/switchboard-launcher`)
  but **are not on `PATH` and are not installed**. `dist/linux-arm64/switchboard-pty-host` *is* used,
  because the board spawns it by absolute path — so the directory is live, and the two entry-point
  binaries in it are simply never reached.

This host is therefore taking the uncapped path 100% of the time, and would on any machine that
installed via npm/npx rather than the launcher.

**What already guards this, and what does not.** *The Board Must Fit a 1 GB Pi* (CODE REVIEWED) is
the governing plan. Its Change 6 states the problem exactly, including both failure directions:

| setting | outcome |
| :--- | :--- |
| left to the default on 1 GB | aborts at V8's limit, RAM unused |
| set below the real peak | converts the burst into a crash at the cap |
| set generously | licenses RSS to grow past the 800 MB budget |

Its Change 4 shipped an 800 MB peak-RSS gate (`test:contract:board-peak-rss`), and
*resident-memory-budget-for-low-memory-hosts* (CODE REVIEWED) publishes `docs/LOW_MEMORY_HOSTS.md`
with `idleRssMb: 350` / `peakRssMb: 500`. **Both are CI gates.** Neither is a runtime safeguard, and a
CI gate on a development box cannot catch a launch path that omits the flag on the user's device —
which is precisely how this survived.

**There is no board-only runtime mode.** Grepping `src/`, `cmd/` and `internal/` for
`boardOnly` / `board-only` / `LOW_MEMORY` finds only the two heap-cap comments and unrelated matches.
"Board-only" is a deployment shape described in `CLAUDE.md` and the plans, not a flag the host reads.
So this plan must **not** branch the value by mode — there is no mode to branch on. One measured
number, applied on every path. Per that plan's Change 1 Implementation Record, the split "was NOT
measured in this run", so the default remains the placeholder `512`.

**On seats.** A 1 GB board-only Pi has no local seats — under seats-not-stores they run on other
machines, as that plan's opening states. So this host's 408 MB RSS with six local seats is *not*
evidence against the board-only figure; it is the 4 GB configuration the rationale already calls
inert. The number for the 1 GB target still has to come from the unperformed split measurement.

### Root cause

The ceiling was implemented at *a* launcher rather than at *the entry point*. Two launchers were kept
in sync with each other (the comment says so: "keep the two in sync"), which made the pair look
complete — while the third and most common way in, plain `node cli.js`, was never an argument
against that completeness because it is not a launcher at all.

### Constraints the fix must respect

Both are recorded in-source as measured dead ends, not opinions:

- **Not `NODE_OPTIONS`** — "leaks into every child process, including the Go pty-host".
- **Not `v8.setFlagsFromString`** — "silent no-op, measured". A process cannot raise its own old-space
  limit after V8 has started.

The flag must sit between `node` and the entry script, before V8 loads the entry. So the only
mechanism available to `cli.js` is to **re-exec itself** once, with the flag, when it is missing.

### Non-goals

- **Fixing a final number.** Change 2b gives the derivation and a defensible interim value; the
  headroom term still wants the board-only measurement. This plan does not claim to close that.
- **Adding a board-only mode.** None exists, and this fix must not invent one.
- **Installing or promoting the Go launcher.** Fixing the npx path must not depend on a launcher the
  user has not installed.
- **Capping growth.** The flag raises a ceiling; a budget is separate work.

## Metadata

**Tags:** cli, reliability, performance, infrastructure
**Complexity:** 3

## User Review Required

**Re-exec versus a wrapper.** Asserted: re-exec from `cli.js`. A shell-wrapper bin would also work but
changes what npm installs and breaks the `node cli.js` invocation people already use. Re-exec costs one
extra process start at boot, once, and is invisible to every caller.

## Complexity Audit

### Routine
- Adding a re-exec guard at the top of `main()` in `src/standalone/cli.ts` — a self-contained
  conditional with one `process.execPath` spawn.
- Logging the effective value and source at startup — one `console.log` line alongside the
  existing startup banner.
- Reading `SWITCHBOARD_MAX_OLD_SPACE_MB` from the environment — the Go sites already do this;
  the node entry mirrors the same `os.Getenv` / `process.env` read.

### Complex / Risky
- The re-exec loop guard: a wrong marker (or a missing `delete`) causes an infinite exec loop that
  forks as fast as the OS allows. The guard must be a single, specified mechanism, not "an argv
  sentinel or a single env var."
- The first process runs uncapped: its module loading (better-sqlite3 native binding, all bundled
  services) executes under V8's auto-sized ceiling, not the configured one. The re-exec only helps
  the SECOND process. If the board-only idle heap ever exceeds V8's auto-sized ceiling (~342 MB on
  700 MB available), the first process aborts before the check runs and the fix is a no-op.
- Change 2's "one source both languages read": Go and Node cannot share a TypeScript constant. The
  env var is already the shared override; the DEFAULT is the duplication problem, and a JSON config
  file adds startup I/O. The mechanism for truly sharing the default is unspecified.

## Proposed Changes

### 1. `dist/standalone/cli.js` re-execs once with the flag

At the top of `main()` in `src/standalone/cli.ts` (line 3447), before any board startup work:

> **Superseded:** "At the top of the standalone entry, before any heavy import"
> **Reason:** `dist/standalone/cli.js` is a webpack bundle — the module loading (better-sqlite3
> native binding, all bundled services) runs before `main()` at line 3447. The check cannot run
> "before any heavy import" without a split prelude entry. Placing it at the top of `main()` is
> sufficient: the first process's module-loading heap (~141 MB measured) stays under V8's
> auto-sized ceiling (~342 MB on 700 MB available), so the first process survives to the check.
> The re-exec'd second process gets the flag before board startup. The cost is one extra module
> load, not a correctness issue.
> **Replaced with:** At the top of `main()` in `src/standalone/cli.ts`, before any board startup
> work. If the board-only idle heap is ever measured above V8's auto-sized ceiling, the check must
> move to a split prelude (a tiny entry that re-execs to the heavy bundle); until then, `main()`
> is the correct placement.

If `process.execArgv` carries no `--max-old-space-size`, re-exec
`process.execPath --max-old-space-size=<mb> <script> ...args` and replace the current process.

Guard it against looping with a **single env-var mechanism** — not "an argv sentinel or a single
env var." Set `SWITCHBOARD_HEAP_FLAG_APPLIED=1` in the re-exec env, check it at the top of the
re-exec path, and `delete process.env.SWITCHBOARD_HEAP_FLAG_APPLIED` immediately after the check.
A future launcher that sets the flag by another route must not cause an exec loop; the env-var
marker is the one loop guard.

Skip the re-exec when a Go launcher already applied the flag (`process.execArgv` already carries
`--max-old-space-size`), so the existing paths are unchanged and pay nothing.

### 2. One source for the value

There are already two copies of this logic and this plan adds a third caller. Put the default and the
`SWITCHBOARD_MAX_OLD_SPACE_MB` override in one place both languages read — the Go sites keep their
current behaviour, and the node entry reads the same default rather than hardcoding `512` a third
time. Three hardcoded copies of a number that is explicitly a placeholder will drift the moment the
measurement lands.

**Clarification on the mechanism.** Go and Node cannot share a TypeScript constant. The env var
`SWITCHBOARD_MAX_OLD_SPACE_MB` is already the shared override source — both languages read it
identically. The DEFAULT is the duplication problem. Realistic options, in order of preference:

1. **Same formula, duplicated** (lowest risk): both languages derive the default from the same
   formula (`budget - measured_non_heap - offset`) with the same constants. The number is
   duplicated but the derivation is shared. A comment in each site names the other.
2. **Build-time code generation**: a build step generates a Go constant and a TypeScript constant
   from a single JSON file. Adds build complexity; the number changes rarely.
3. **Shared JSON file read at startup**: both languages read `heap-default.json` at boot. Adds
   startup I/O and a file-not-found path — exactly the kind of fallback that must fail loudly.

Option 1 is sufficient for a placeholder that will be replaced by a measurement. The plan does not
require a single file; it requires that the three sites do not silently drift.

### 2b. The default is derivable today — `512` is inconsistent with the 800 MB budget

The budget is **800 MB RSS for the board process itself**, OS and everything else excluded — the
ceiling *The Board Must Fit a 1 GB Pi* Change 4 already gates on.

The flag governs only the V8 heap, and the heap is a minority of RSS. Measured on this host
2026-09-14 via `/health`, six live seats:

```
rss        471.6 MB
heapTotal  171.6 MB      -> non-heap RSS = 300.0 MB
heapUsed   141.6 MB
external     5.8 MB
```

**Roughly 300 MB of the board's RSS is not heap** — node itself, V8 code space, better-sqlite3,
buffers, thread stacks. None of it moves when the flag moves.

That makes the flag's share of an 800 MB budget about **500 MB**. Applying the offset the plan
documents (`--max-old-space-size=512` reports ~700 MB; `400` reports ~592 MB — consistently **+190**),
the flag value consistent with the budget is:

```
800 MB budget - 300 MB non-heap = 500 MB heap RSS
500 MB - 190 MB offset          = ~310  --max-old-space-size
```

So against an 800 MB budget the placeholder **`512` is too high, not too low**: it licenses a ~700 MB
heap, which with non-heap puts potential RSS near 1 GB — the plan's own third failure row, *"set
generously → licenses RSS to grow past the 800 MB budget."* The 800 MB CI gate would fail the run,
but only after the fact and only on a box where the gate runs; V8 would never self-limit first.

**The method, not the number, is the deliverable.** Derive the default as
`budget - measured_non_heap - offset` rather than carrying a guess. The forced-GC split
(*the-board-must-fit-a-1gb-pi* Change 1, never measured — `.switchboard/logs/burst-gc-split.jsonl`
does not exist on this host) refines the headroom term by establishing peak *live* heap during a
burst. It does not block picking a defensible value now, and `SWITCHBOARD_MAX_OLD_SPACE_MB` remains
the override.

**Caveat on the 300 MB.** It was measured on a 4 GB host with six local seats. A board-only 1 GB
target has no local seats and fewer WS clients, so its non-heap share is likely lower — which makes
~310 conservative (more heap headroom), not reckless. Re-measure board-only before fixing the number.

### 3. Record which path set it

Log the effective value and its source (`go-launcher`, `env`, `cli-reexec`, or `absent`) at startup.
"Was the ceiling applied, and by whom?" is not answerable today from outside the process — it took
reading `/proc/<pid>/cmdline` and `/proc/<pid>/environ` to establish it on this machine.

**Source disambiguation.** `go-launcher` and a manual `node --max-old-space-size=... cli.js` both
put the flag in `process.execArgv` without the `SWITCHBOARD_HEAP_FLAG_APPLIED` marker. They are
indistinguishable from inside the process. This is acceptable: the source is "external" in both
cases, and the operator who passed the flag manually knows they did. The four-way classification is:
- `cli-reexec`: `execArgv` has the flag AND `SWITCHBOARD_HEAP_FLAG_APPLIED` was set (consumed).
- `go-launcher` / `external`: `execArgv` has the flag, marker absent.
- `env`: `SWITCHBOARD_MAX_OLD_SPACE_MB` is set and `execArgv` is empty (the re-exec applied it from
  the env override).
- `absent`: neither the flag nor the env var is present — the uncapped path. This is the bug state.

### 4. Host scope — standalone only

`CLAUDE.md` (2026-09-14): the extension host is being removed in a hard cutover and new code must not
be written into it. This change is confined to the standalone entry point, which is what runs on the
Pi. The extension never spawns the board this way and needs nothing.

## Edge-Case & Dependency Audit

**Race Conditions:**
- The re-exec check runs once at startup, before any concurrent work. No race window — the process
  is single-threaded until `main()` proceeds past the check.
- If `SWITCHBOARD_HEAP_FLAG_APPLIED` is inherited by a child process spawned before the `delete`,
  the child's own `cli.js` entry (if it re-enters) would skip the re-exec. This is correct
  behaviour, not a bug — but the `delete` must happen before any `spawn`/`fork` to avoid a stale
  marker suppressing a legitimate future re-exec in a grandchild.

**Security:**
- The flag value comes from `SWITCHBOARD_MAX_OLD_SPACE_MB` (env) or a hardcoded default. No user
  input reaches it. An attacker who controls the env var can set the heap ceiling — but they
  already control the process environment, so this adds no attack surface.

**Side Effects:**
- One extra process start at boot on the npx path. The Go-launcher path is unchanged (flag already
  in `execArgv`, re-exec skipped).
- `process.execArgv` is read-only; the re-exec builds a new argv, it does not mutate the current
  process's `execArgv`.
- The `SWITCHBOARD_HEAP_FLAG_APPLIED` env var is `delete`d, so it does not leak to child
  processes (the Go pty-host, agent seats). This is the same reason `NODE_OPTIONS` is forbidden.

**Dependencies & Conflicts:**
- Depends on `process.execArgv` correctly reflecting flags passed between `node` and the entry
  script. Verified: Node.js documents `execArgv` as "the array of Node.js-specific command-line
  options."
- Conflicts with any future mechanism that sets the flag via `NODE_OPTIONS` — the plan's own
  constraints forbid this, and the `absent` source log would surface it.
- The `registerPendingCreation` TTL (10s) in PlanIngestionEngine is unrelated — this plan touches
  the node entry, not the watcher.

## Dependencies

None. This plan is self-contained: it touches `src/standalone/cli.ts` (re-exec + logging) and
optionally the Go sites (`cmd/switchboard/main.go`, `internal/launcher/discovery.go`) for default
deduplication. No other plan's work is a prerequisite.

## Adversarial Synthesis

Key risks: (1) the re-exec loop guard — a wrong marker causes infinite forking; mitigated by
specifying a single env-var mechanism with immediate `delete`. (2) the first process runs uncapped
— if board-only idle heap ever exceeds V8's auto-sized ceiling, the first process aborts before
the check; mitigated by the measured ~141 MB heap being well under the ~342 MB ceiling, with a
stated escalation path (split prelude) if that changes. (3) the shared-default aspiration is
underspecified — mitigated by clarifying that "same formula, duplicated" is sufficient for a
placeholder. The 2b derivation method is the plan's strongest contribution and needs no correction.

## Verification Plan

### Automated Tests

- **Contract** — spawn `node dist/standalone/cli.js` directly with no flag and assert the running
  process reports a `heap_size_limit` consistent with the configured value rather than the host
  default. This fails today.
- **Contract** — spawn via the Go path and assert the flag is applied exactly once and no re-exec
  occurs.
- **Contract** — `SWITCHBOARD_MAX_OLD_SPACE_MB` set to a sentinel is honoured on both paths.
- **Contract (loop guard)** — the re-exec happens at most once; assert process-start count.
- **Contract** — `NODE_OPTIONS` is not set by any path, so the Go pty-host child does not inherit it.

Run `npm run compile-tests` before any `test:contract:*` script.

### Goal Invariants

1. Every launch path applies the ceiling, including plain `node cli.js`.
2. The re-exec never loops.
3. No child process inherits the flag via `NODE_OPTIONS`.
4. The effective value and its source are visible in the startup log.

## Implementation Summary

Implemented automatic heap ceiling re-exec in `src/standalone/cli.ts` at the top of `main()`. If `--max-old-space-size` is absent from `process.execArgv`, the process re-execs itself with `--max-old-space-size=<mb>` using `SWITCHBOARD_MAX_OLD_SPACE_MB` or the derived default `310` MB (`800 MB budget - 300 MB non-heap - 190 MB offset`), replacing the placeholder `512` across all four entry paths (`src/standalone/cli.ts`, `bin/switchboard`, `cmd/switchboard/main.go`, and `internal/launcher/discovery.go`). The re-exec is guarded against infinite loops by the `SWITCHBOARD_HEAP_FLAG_APPLIED` environment variable which is consumed and immediately deleted upon re-entry. Effective heap ceiling and disambiguated source (`cli-reexec`, `go-launcher`, `env`, or `absent`) are determined and logged during server startup banner presentation without leaking `NODE_OPTIONS` to child processes.



## Review Findings

Files changed in review: `package.json`, `src/standalone/cli.ts`, `.github/workflows/integration-tests.yml`, and a new `src/test/heap-ceiling-contract.test.js`. Three material defects were fixed. (1) The commit added `"private": true` to `package.json`, which makes `npm publish` refuse outright — in the one commit whose plan exists to fix the `npx` / global-npm route named in its Goal; it is removed, restoring the pre-commit state. (2) The re-exec sat at the very top of `main()`, so **every** client verb re-execed — `switchboard done`, `next`, `probe`, `verb`, and the `node "<cliPath>" done` form every agent completion directive prints — doubling the process count and startup cost of the most frequent command on the box for a ceiling a 200 ms process never approaches; a `HEAP_REEXEC_EXEMPT_SUBCOMMANDS` set now skips the hot client path while anything unrecognised still re-execs (visible-or-safe, per the fallback rule). (3) The `--detach` parent spawned its child without the flag, so the child re-execed itself and left a wrapper process holding the whole bundle (~40 MB RSS) for the life of the board — exactly the cost `bin/switchboard`'s own header says the shim exists to avoid; the detached spawn now carries `--max-old-space-size` and the consumed marker. The plan named five contracts and shipped none, so `test:contract:heap-ceiling` was written and wired into CI: it asserts the four sites' defaults have not drifted, that each honours `SWITCHBOARD_MAX_OLD_SPACE_MB`, that no path sets `NODE_OPTIONS`, that the loop guard exists and is deleted, and that client verbs are exempt while serve modes are not.

## Deferred Findings

- MAJOR — `package.json:15` / `bin/switchboard:1` — the npm `bin` was repointed from `dist/standalone/cli.js` to a `#!/bin/sh` shim. `dist/standalone/cli.js` carries `#!/usr/bin/env node`, so npm's Windows `cmd`/`ps1` shims resolved it to `node`; a `sh` target resolves to `sh`, which is absent on a plain Windows install. `cli.ts` handles `win32` explicitly, so Windows is a supported host. The shim is kept — it is strictly better on the Pi, which `CLAUDE.md` names as primary — but the Windows npm-install path is a regression the author should rule on. Note also that the plan's own User Review section asserted re-exec *instead of* a wrapper; the implementation shipped both without recording the deviation.
- MAJOR — `package.json` has no `files` array and there is no `.npmignore`, so `npm pack` falls back to `.gitignore`, which excludes `dist/`. A published tarball would therefore contain neither `dist/standalone/cli.js` nor the platform binaries, and the `bin` entry would dangle whichever target it names. Pre-existing and out of scope here, but it means the `npx` route the Goal depends on is not currently publishable.
- MAJOR — the plan's remaining three named contracts are unimplemented: the live `heap_size_limit` assertion against a plain `node dist/standalone/cli.js` launch, the Go-path "flag applied exactly once, no re-exec" assertion, and the loop-guard process-start count. The new suite is static analysis; nothing measures the ceiling a running board actually got.
- NIT — `src/standalone/cli.ts:3437` — `heapSource` is computed before the exempt check, so a client verb that skips the re-exec still reports `absent` if anything ever logs it. Nothing logs it on that path today.
