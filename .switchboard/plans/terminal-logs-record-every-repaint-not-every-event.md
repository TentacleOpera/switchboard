# Terminal Logs Record Every Repaint, Not Every Event

## Goal

A terminal log records what happened in the seat, not how many times the seat redrew it. The
transcript stays complete and becomes shorter, so a Pi can keep it on an SD card without paying
for frames that carry no information.

### Problem analysis

`routeOutput` — the fan-out every chunk of terminal output passes through — opens with an
unconditional disk write:

```go
func (f *fleet) routeOutput(name, data string) {
    f.logOutput(name, data)      // every chunk, always
    …
}
```

`logOutput` strips ANSI, sanitises fences, and appends. There is no level, no sampling, no
switch, and the only bound anywhere is `logCapBytes = 10 MB` — which caps one file before it
rolls, not the total.

**Measured on this host, 2026-09-13:**

|| | |
|| :--- | ---: |
|| accumulated logs | **353 MB** |
|| written in 4 hours with a team running | **35 MB** |
|| implied rate | **~200 MB/day** |
|| files | 481 |

**And most of it is the same lines over and over.** A single 504 KB seat log:

|| | |
|| :--- | ---: |
|| non-empty lines | 3,254 |
|| distinct lines | 1,291 |
|| duplicate lines | **1,963 — 60% of the file** |

The repeats are exactly what you would expect from a TUI, not from a transcript:

```
x204   ' LocalApiServer.ts'
x137   '────────── (bypass permissions on) ─❭ Guide Devin while it'
 x51   ' in ./src/services/LocalApiServer.ts'
```

That third one is a status/composer line and the first is a fragment of a redrawn file list. The
agent did not say `LocalApiServer.ts` 204 times; it repainted a pane that contained it.

**Why `stripAnsi` does not solve this.** It removes the escape codes and keeps the text. A
repaint therefore survives as a byte-identical copy of the previous frame, and the CLIs in use
repaint continuously — devin emits on the order of 12 frames a second even at rest. So an idle
seat with a spinner and a status bar writes to disk indefinitely while nothing is happening.

### Why not just log less

The logs are the only record of several things that are invisible everywhere else. On
2026-09-13 they were the sole evidence for: seven refused completion posts and the exact 409 text
that caused them; a fix round (`promptSeq 4`) that the host reported delivered and the recipient
never received; and the CSRF rejections behind a stalled team. None of that appears in the board,
the receipts, or any UI.

Two plans in BACKLOG — *Terminal logs are named for what they record* and *Terminal logs live in
the logs sibling, with an index* — treat these files as a searchable record of work done, and
they are right to. Sampling or truncating would have cost every answer above.

The information is in the **distinct** lines. The duplicates are the cost of a rendering model
leaking into a record. Removing them makes the transcript shorter AND more readable, which is why
this does not fight those two plans — it is the volume fix that leaves their premise intact.

### Non-goals

- **A log level, a sampling rate, or an off switch.** The record must stay complete. The problem
  is redundancy, not verbosity.
- **Dropping ANSI handling.** `stripAnsi` and `sanitizeFence` stay exactly as they are.
- **Renaming or relocating the files.** Those are the two BACKLOG plans; this one only changes
  what gets written into them.
- **Retention policy.** Deleting old logs is a separate question and a worse lever: it discards
  answers rather than noise.
- **A full screen emulator.** Non-adjacent non-chrome repeats (the bulk of the 60%) are not
  recovered here; they are deferred to the screen-emulator plan
  (`read-the-agents-own-transcript-instead-of-reconstructing-the-terminal.md`). This plan attacks
  the chrome subset of that class with a declared per-family pattern, not a frame model.

## Metadata

- **Complexity:** 5
- **Tags:** performance, backend, reliability

## User Review Required

None.

## Complexity Audit

### Routine
- Per-line predecessor carry on `sessionLog` (shared seam with the sibling plan).
- Count-marker emission when a run of adjacent identical lines ends.
- Volume-header counters on `sessionLog`, flushed on roll/close.
- `stripAnsi` / `sanitizeFence` / fence open-close logic unchanged.

### Complex / Risky
- **Per-family chrome-line non-adjacent dedup.** A new declared-pattern surface
  (`chromeLinePattern(family)`) mirroring `clearStrategy`'s declared-not-inferred stance, plus
  non-adjacent scoped suppression (a chrome line identical to the last *emitted* chrome line is
  dropped regardless of intervening real output). New logic, not a reuse of an existing pattern.
- **Family threading into the log path.** `logOutput(name, data)` has no family today; `cliFamily`
  lives on `t` under `f.mu`, which `logOutput` does not hold. Must thread the family from the
  caller (`routeOutput`/`publish` already have `t.cliFamily`) to avoid nesting `f.mu` inside
  `f.logMu`.
- **Composition with the sibling plan.** Both plans modify `logOutput`/`sessionLog` in `log.go`;
  ordering and state sharing must be explicit or the two silently collide on the same struct.

## Edge-Case & Dependency Audit

- **Race Conditions:** `logOutput` runs under `f.logMu` (held by `appendLog`). The carry
  (`lastLine`), the chrome-line last-emitted, the suppression counter, and the volume counters
  are all per-`sessionLog` and mutated on the same lock path — safe. They MUST be flushed/reset on
  `rollLogLocked` and `closeFenceLocked` so a roll does not leave a stale predecessor that
  suppresses the new session's first line, nor a pending count that never gets written.
- **Security:** No change to path handling or auth; logs stay `0o600`. The declared chrome
  pattern is a Go `*regexp.Regexp` compiled once, not user input.
- **Side Effects:** Fewer bytes on disk and fewer `appendFile` syscalls for duplicate-heavy
  output. A suppressed run is visible as a count marker, so silence and idling stay
  distinguishable from a crash.
- **Dependencies & Conflicts:**
  - **Sibling plan `terminal-logs-keep-every-blank-run-and-repeated-line.md`** modifies the SAME
    `logOutput`/`sessionLog` path in `log.go` (adds `lastLine` carry, line-level adjacent dedup,
    blank-run collapse). This plan BUILDS ON that seam: it adds the count marker, the per-family
    chrome dedup, and the volume header on top of the sibling's line-level carry. If the sibling
    has not landed, this plan's implementation must include the line-level carry as a
    prerequisite (see Outstanding Questions). The two plans MUST be landed in dependency order or
    merged, never independently — independent landings collide on `sessionLog` fields.
  - **Deferred screen-emulator plan** (`read-the-agents-own-transcript...`) owns the
    non-adjacent non-chrome repeats. This plan's chrome dedup is a strict subset of what that
    emulator would do; the declared-pattern approach is the cheap version that does not require
    the emulator's correctness surface.

## Dependencies

- `terminal-logs-keep-every-blank-run-and-repeated-line.md` — line-level adjacent dedup +
  blank-run collapse in `log.go`. This plan's change 1 (count marker) and the carry seam depend
  on the sibling's `sessionLog.lastLine` existing; if the sibling is not yet implemented, this
  plan must land that carry first.

## Adversarial Synthesis

Key risks: change 1 was scoped to chunk granularity (fragile to 4096-byte read boundaries and
subsumed by the sibling's line-level dedup) — superseded to compose with the sibling; the
"duplicate count falls to zero" verification was unreachable for the proposed mechanism and is
corrected; the chrome pattern declaration seam and the family-threading into `logOutput` were
unspecified. Mitigations: build on the sibling's line-level carry, declare `chromeLinePattern`
as a Go function mirroring `clearStrategy`, thread `family` from the caller to avoid nested
locks, and flush all carry/counters on roll/close.

## Proposed Changes

### `cmd/switchboard-pty-host/log.go`

**Context.** `logOutput(name, data)` (log.go:121) is the single write path called from
`routeOutput` (main.go:874) on every pty data event. `sessionLog` (log.go:19) currently holds
`path, open, size, session`. `stripAnsi`/`sanitizeFence` run before append. The sibling plan
adds a `lastLine` carry for adjacent line dedup; this plan adds the count marker, chrome dedup,
and volume header on top of that carry.

#### 1. Compose with the sibling's line-level carry; add a suppression count

> **Superseded:** "Hold the last written chunk per terminal. When `logOutput` produces bytes
> identical to it, drop them and increment a counter instead of appending."
> **Reason:** A chunk is a 4096-byte read-buffer artifact (main.go:377), not a semantic frame.
> Two identical TUI repaints yield identical chunk strings only when the read boundary aligns to
> the frame boundary — true for small status-bar frames, false for larger redraws — so the unit
> is fragile. Worse, the sibling plan `terminal-logs-keep-every-blank-run-and-repeated-line.md`
> already collapses adjacent identical *lines* (a strictly finer, buffer-invariant granularity)
> in the same `logOutput`/`sessionLog` path; when both land, chunk-level suppression is a no-op
> (the sibling already dropped the lines) and its counter never fires.
> **Replaced with:** Depend on the sibling's `sessionLog.lastLine` line-level adjacent dedup
> (carry one line across `logOutput` calls; drop a line equal to its immediate predecessor;
> collapse blank runs to one). This plan's contribution to that collapse is the **count marker**
> (change 2), not a separate chunk-level comparison. If the sibling has not landed, land its
> `lastLine` carry as a prerequisite of this plan — do not reinvent a chunk-level comparison.

#### 2. Record that frames were suppressed, not just their absence

When a run of adjacent identical lines ends (a different line arrives, or the session
rolls/closes), write a single marker naming the run length — e.g. `<!-- suppressed N identical
lines -->` — so the log says a pane repainted N times. "This seat was idle for four minutes" is
itself a fact worth reading, and a silent gap looks like a crash.

- The pending count is per-`sessionLog`, incremented when a line is dropped as an adjacent
  duplicate, flushed to a marker when the next *different* line is written, on `rollLogLocked`,
  and on `closeFenceLocked` (so a session that ends mid-idle still records the storm).
- The marker is a markdown HTML comment so it does not alter the visible transcript and survives
  fence boundaries.

#### 3. Collapse the composer/status line specifically (per-family, declared)

The highest-count repeats are the CLI's own chrome — the bordered prompt line and the status
bar — and they recur *interleaved* with real output, so change 1 (line-level adjacent) does not
catch them. Write the current chrome line once per change of content rather than once per frame:
a chrome line identical to the last *emitted* chrome line is suppressed regardless of
intervening real output.

- **Declared, not inferred**, mirroring `clearStrategy` (prompt.go:101): add a Go function
  `chromeLinePattern(family string) *regexp.Regexp` (or a line-predicate) returning `nil` for
  families with no declared chrome pattern. A `nil` pattern means "line-level adjacent dedup
  only" — today's behaviour minus the exact duplicates. The pattern is compiled once at package
  scope, never from user input.
- **Family threading.** `logOutput(name, data)` has no family today; `cliFamily` lives on `t`
  under `f.mu`, which `logOutput` does not hold. Thread `family` (or the terminal) from the
  caller: `routeOutput` is called from `publish` (main.go:434) and from the `readOutput` EOF path
  (main.go:398), both of which already hold `t` and thus `t.cliFamily`. Change the call seam to
  pass the family through; do NOT nest `f.mu` inside `f.logMu`.
- **False-match risk.** A real output line that coincidentally matches the declared chrome
  pattern would be wrongly suppressed. The declared pattern must be specific to the family's
  chrome (e.g. the devin bordered composer line's signature glyphs), not a broad prefix. This is
  the one judgement call in the plan and it lives in the declared pattern, not in the dedup logic.
- **Carry.** The last emitted chrome line is per-`sessionLog` (`lastChrome string`), reset on
  `rollLogLocked`/`closeFenceLocked`.

#### 4. State the volume in the log itself

A short header line per session file recording bytes written and lines/frames suppressed. The
reason this went unnoticed is that nothing reports it: 353 MB accumulated with no counter
anywhere, and the only way to find it was `du`.

- Counters (`bytesWritten`, `linesSuppressed`) are per-`sessionLog`, written into the file header
  on `rollLogLocked` (so each rolled 10 MiB file carries its own totals) and on `closeFenceLocked`
  (the final file). Reset after each roll.

### Both Hosts

`log.go` is the live writer for **both** composition roots: standalone (`bootstrap.ts`) and the
extension (`extension.ts`) both drive the Go pty host via `PtyHostSupervisor`, and `publish()`
calls `logOutput` regardless of which root spawned the fleet. The change is inside `log.go`, so
both hosts get it with no second writer to keep in sync and no composition-root wiring to audit.
The declared `chromeLinePattern` lives in the Go host; the TS projection does not participate in
dedup, so no `cliIdentity.ts` mirror is required (unlike `clearStrategy`, which the TS side reads
to decide readiness-tracking behaviour).

## Verification Plan

### Automated Tests

1. **Go test** over `logOutput` against a captured fixture of real seat output (the 504 KB sample
   measured above is a suitable source): asserts the distinct-line count is unchanged and a
   suppression marker carries the correct run length. Distinct-line parity is the assertion that
   matters — it is what proves nothing was lost.
2. Assert a line differing by one byte from its predecessor is written in full.
3. Assert an idle seat emitting a repeating status frame produces bounded log growth over a fixed
   interval — the property the 200 MB/day comes from.
4. Assert a chrome line identical to the last *emitted* chrome line is suppressed even when
   separated by intervening real output (the non-adjacent chrome case), and that a chrome line
   with changed content is written.
5. Assert the suppression count is flushed to a marker on `rollLogLocked` and `closeFenceLocked`
   (a session ending mid-idle still records the storm).
6. Assert the volume header carries correct `bytesWritten`/`linesSuppressed` totals per rolled
   file.
7. Regression: `go test ./cmd/...`, `gofmt -l ./cmd`.

### Goal Invariants

- Replaying a suppressed log answers the same questions the current one does: which calls failed,
  what the error text was, what the agent said it was doing. Verified against the three 2026-09-13
  incidents named above, which are in the existing logs.
- An idle seat with no output writes a bounded amount per hour, not an unbounded stream.
- Every suppressed run is visible as a count, so silence and idling are distinguishable.
- Daily log volume with a four-seat team is a stated number with a test that fails when it grows.

> **Superseded:** Verification #1 originally asserted "the duplicate count falls to zero."
> **Reason:** The 60% duplicate figure is mostly *non-adjacent* line repeats (per the sibling
> plan's measurement on the same writer: ~80% of lines repeat non-adjacently). This plan attacks
> only the chrome subset of non-adjacent repeats via a declared pattern; the remainder is
> explicitly deferred to the screen-emulator plan. "Falls to zero" is unreachable by the proposed
> mechanism — a green-looking assertion the implementation cannot satisfy.
> **Replaced with:** Assert distinct-line count is unchanged (nothing lost) and that adjacent
> duplicates plus the declared chrome subset collapse. Total duplicate count does NOT fall to
> zero and is not asserted to.

## Outstanding Questions

- **[user]** Should this plan absorb the sibling `terminal-logs-keep-every-blank-run-and-repeated-line.md`
  (line-level carry + blank collapse) as a prerequisite section, or depend on it landing first? —
  proceeding on the assumption that this plan BUILDS ON the sibling's `sessionLog.lastLine` carry
  and lands after it (or includes it). If the two land independently without coordination they will
  collide on `sessionLog` fields.
