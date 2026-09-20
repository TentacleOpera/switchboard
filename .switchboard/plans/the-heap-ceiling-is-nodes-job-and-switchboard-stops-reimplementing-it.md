# The Heap Ceiling Is Node's Job, and Switchboard Stops Reimplementing It

## Goal

Delete the heap-ceiling machinery. Node sizes its own heap, which is what every
install had before this was added and what every install has today anyway. An
operator who genuinely needs a raised ceiling sets `NODE_OPTIONS`, which node
already honours with no Switchboard code at all.

## Problem analysis

### The feature has already disabled itself

`src/standalone/cli.ts:4159`:

```ts
const DEFAULT_MAX_OLD_SPACE_MB = '';
```

The comment above it is unusually emphatic, and correct:

> **WHY NO DEFAULT CAN BE CORRECT:** this flag's only legitimate use is to RAISE
> V8's auto-sized ceiling on a host so small that the automatic limit falls below
> the board's working set. On every host where the automatic limit is already
> adequate, setting it can only LOWER the ceiling — it adds a kill condition and
> buys nothing… Unset, node sizes the heap from the machine it is actually on,
> which is correct everywhere and is what every install had before this was added.

It records two defaults that were tried and were both kill conditions — `512`
and `310` — and the 2026-09-14 abort they caused: pid 653387, 3.7 GB host,
8 seats, 3207-plan board, `Mark-Compact 517.0 -> 516.4 MB`, `FATAL ERROR:
Reached heap limit`, inside `better_sqlite3 Statement::JS_all`, i.e. a board read.

So the conclusion was reached and acted on. What was left behind is the
*apparatus* for a value that is never set.

### This continues a retraction already on the board

`the-heap-ceiling-is-set-by-the-launcher-so-the-npx-install-never-gets-it`
(plan `072a002b`, complexity 3) is the plan that introduced this machinery. It
carries a **RETRACTED 2026-09-14** heading in its own words: *"this plan was
wrong, it was implemented, and it crashed the board."* It is the source of the
310 MB derivation and of the abort quoted above, and it states the conclusion
this plan acts on:

> There is no safe default, which means the correct number of defaults is zero,
> not a smaller one.

That retraction removed the default. This plan removes the apparatus the default
used to flow through. **Nothing here re-litigates it** — the argument is settled;
what remains is dead machinery.

Note also that the retracted plan currently sits in **CODE REVIEWED**, not in a
terminal column, so a retracted plan is parked where it can still be picked up.
Worth moving as board hygiene; it is not part of this plan's scope.

### Node already provides this, natively

Measured on this box:

```
NODE_OPTIONS=--max-old-space-size=333 node -e '...'   → 525 MB
node -e '...'                                          → 2090 MB
```

`NODE_OPTIONS` needs no re-exec, no marker env var, no exempt-subcommand
allowlist and no Go branch. Switchboard has reimplemented a native capability
and taken on maintenance for the copy.

### What the copy costs

- **A re-exec gate on the hot path.** `main()` runs for every client verb —
  `done`, `next`, `accept`, `verb`, the `node "<cliPath>" done` form every agent
  directive tells seats to use. It is kept off that path by
  `HEAP_REEXEC_EXEMPT_SUBCOMMANDS`, a hand-maintained allowlist of 28 names
  whose documented rule is *"anything unrecognised (including a future
  subcommand) re-execs"*. **Every new client subcommand silently inherits a
  re-exec** until someone remembers this list.
- **Two spawn sites** — the re-exec at `cli.ts:4207` and the detached spawn at
  `cli.ts:5551`.
- **A four-valued source tag** (`cli-reexec` | `go-launcher` | `env` | `absent`)
  computed on every launch to describe a value that is always absent.
- **Two Go call sites** — `cmd/switchboard/main.go:397` and
  `internal/launcher/discovery.go:226`. Both are already correctly guarded with
  `if mb != ""`, and both carry a copy of the same long comment.
- **A startup line that renders blank:** `Heap ceiling:  MB (source: absent)`
  (`cli.ts:5697`). The source is tagged, per the fallback rule, but the value
  formats as nothing at all.

### Two gates mandate the opposite, and neither tests behaviour

`src/test/board-peak-rss-contract.test.js:115`:

> `must set --max-old-space-size explicitly — V8's derived limit aborts the host on 1 GB`

`src/test/board-payload-size-contract.test.js:224`:

> `must set --max-old-space-size explicitly`

These contradict `cli.ts`, which says a compiled-in value is wrong by
construction and caused a measured OOM. **Both gates pass right now** — they are
source greps satisfied by the literal string `--max-old-space-size=` appearing
at the two spawn sites, while the branch containing it never fires because
`effectiveHeapMb` is `''`. They assert spelling, not behaviour, which is why the
contradiction has survived unnoticed.

The peak-rss claim is the one substantive argument for keeping any of this and
**it must be settled by measurement, not deleted around** — see Constraints.

### One thing that is NOT a bug

`cli.ts:5551` passes `--max-old-space-size=${effectiveHeapMb}` **unguarded**, so
on the detach path node receives a literal `--max-old-space-size=` with an empty
value. Measured: node ignores it — 2090 MB either way, identical to unset. It is
benign today. It survives only by accident of node's argument parsing, which is
a reason to remove it rather than a defect to file.

## Metadata

**Complexity:** 4
**Tags:** standalone, cli, launcher, cleanup, go, gates
**Scope:** `src/standalone/cli.ts`, `cmd/switchboard/main.go`,
`internal/launcher/discovery.go`, `src/test/board-peak-rss-contract.test.js`,
`src/test/board-payload-size-contract.test.js`.
**Standalone and the Go launcher only.** The VS Code extension does not launch
the board and is out of scope.

## Constraints

**Settle the 1 GB claim before deleting the gates.** `board-peak-rss-contract`
asserts that V8's derived limit aborts the host on 1 GB. If that is true, the
flag has exactly one legitimate use and removal must be accompanied by a
documented `NODE_OPTIONS` recipe for that device — not silence. Measure the
board's heap limit and peak usage on the smallest supported target before the
gate is retargeted. **Do not delete a gate because it is inconvenient; delete it
because its claim was checked.**

**The measurement already has a home and has never been run.** The retracted
plan names it: the governing plan *The Board Must Fit a 1 GB Pi* (Change 1)
specifies a forced-GC split writing to `.switchboard/logs/burst-gc-split.jsonl`,
and the probe that writes it is at `KanbanProvider.ts:10854`. The retraction
records that this split *"has never been run"*, which is why 310 was arithmetic
rather than evidence. Run it before retargeting change 6 — do not substitute a
second derivation for the first.

**A retired env var must not be silently ignored.** `SWITCHBOARD_MAX_OLD_SPACE_MB`
is read today. After removal, a host where it is set must say so and name
`NODE_OPTIONS` as the replacement, rather than starting with a ceiling the
operator believes is applied and is not. That is the fallback rule applied to a
knob being retired: "set and honoured" and "set and ignored" must not look the
same.

**No new default.** This plan removes a mechanism; it does not substitute a
compiled-in number for it. Unset is the target state.

## Proposed changes

### 1. Delete the re-exec gate and both spawn flags

Remove `DEFAULT_MAX_OLD_SPACE_MB`, `heapMarker`, `hasHeapArg`, `envHeapMb`,
`effectiveHeapMb`, `heapSource`, the `SWITCHBOARD_HEAP_FLAG_APPLIED` marker and
the re-exec branch at `cli.ts:4207`. The detached spawn at `cli.ts:5551` drops
the flag and spawns `process.execPath, [__filename, ...childArgv]`.

### 2. Delete `HEAP_REEXEC_EXEMPT_SUBCOMMANDS`

Its only purpose is deciding who re-execs. With no re-exec it is dead, and so is
the trap where a new subcommand inherits a re-exec by omission.

### 3. Delete the startup line

`Heap ceiling: … (source: …)` goes. Nothing replaces it: the heap limit is
node's, visible in a heap snapshot, and the `probe` CSV already records
`heapUsed` / `heapTotal` per sample.

### 4. Drop both Go branches

`cmd/switchboard/main.go` and `internal/launcher/discovery.go` stop reading
`SWITCHBOARD_MAX_OLD_SPACE_MB` and stop appending the flag. Both long comments
go with them.

### 5. Say so when the retired variable is set

If `SWITCHBOARD_MAX_OLD_SPACE_MB` is present in the environment at board start,
log once, loudly: it is no longer read, and `NODE_OPTIONS=--max-old-space-size=<n>`
is the supported way. One line, at startup, not a warning on every verb.

### 6. Retarget the two gates to the claim that matters

Replace the source-grep assertions with what they were reaching for: the board
starts and serves on the smallest supported target without a heap abort. If the
1 GB measurement shows node's derived limit is genuinely too low there, the gate
becomes "the documented `NODE_OPTIONS` recipe for that device is present and
correct" — an assertion about the documented fix, not about a string in a spawn
call.

## Verification plan

### Automated

- `--max-old-space-size`, `SWITCHBOARD_MAX_OLD_SPACE_MB` and
  `SWITCHBOARD_HEAP_FLAG_APPLIED` appear nowhere in `src/`, `cmd/` or
  `internal/` except the retirement notice of change 5.
- A client verb (`done`, `next`, `accept`, `verb`) runs in **one** process — no
  re-exec, asserted by process count, which also proves the exempt list is gone
  rather than merely unused.
- The detached spawn passes no heap flag and the board comes up.
- Setting `SWITCHBOARD_MAX_OLD_SPACE_MB` produces the retirement notice exactly
  once, and does **not** change the heap limit.
- `NODE_OPTIONS=--max-old-space-size=<n>` **does** change it — the replacement
  path is asserted, not assumed.
- Both retargeted gates fail if the board cannot start on the target they name.

### Goal invariants

- Switchboard never sets V8's heap ceiling.
- A client verb costs one process.
- An operator who sets the retired variable is told, never silently ignored.
- No compiled-in heap number exists to be wrong on some host.

### Manual

Start the board on the smallest supported device, load the largest available
board, and confirm no heap abort. Record the measured heap limit and peak usage
in the plan before closing it — that number is the evidence the gates were
retargeted against.

## Outstanding questions

- **Is the 1 GB claim in `board-peak-rss-contract` still true?** It is the only
  remaining argument for the feature and it has never been re-measured since the
  default was removed. Measure first; the answer decides whether change 6 is a
  deletion or a rewrite.
- **Does the Go launcher have its own ceiling need?** It re-execs node directly
  rather than going through `cli.ts`, so confirm nothing downstream depended on
  it supplying the flag.
