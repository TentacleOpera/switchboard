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

| | |
| :--- | ---: |
| accumulated logs | **353 MB** |
| written in 4 hours with a team running | **35 MB** |
| implied rate | **~200 MB/day** |
| files | 481 |

**And most of it is the same lines over and over.** A single 504 KB seat log:

| | |
| :--- | ---: |
| non-empty lines | 3,254 |
| distinct lines | 1,291 |
| duplicate lines | **1,963 — 60% of the file** |

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

## Metadata

- **Complexity:** 3
- **Tags:** pty-host, logging, pi, performance

## User Review Required

None.

## Proposed Changes

### 1. Suppress a frame identical to the one before it

Hold the last written chunk per terminal. When `logOutput` produces bytes identical to it, drop
them and increment a counter instead of appending.

Identity, not similarity: a chunk that differs by one character is different output and is
written in full. This is a cheap exact comparison on a string the function already has in hand,
and it removes the repaint class without any judgement about what matters.

### 2. Record that frames were suppressed, not just their absence

When the run of identical frames ends, write a single marker naming the count — the log should
say a pane repainted 204 times, because "this seat was idle for four minutes" is itself a fact
worth reading, and a silent gap looks like a crash.

### 3. Collapse the composer/status line specifically

The highest-count repeats are the CLI's own chrome — the bordered prompt line and the status bar
— and they recur interleaved with real output, so change 1 alone will not catch them all. Write
the current chrome line once per change of content rather than once per frame.

This is per-family, declared and not inferred, in the same spirit as `clearStrategy`: a family
with no declared chrome pattern gets change 1 only, which is today's behaviour minus the exact
duplicates.

### 4. State the volume in the log itself

A short header line per session recording bytes written and frames suppressed. The reason this
went unnoticed is that nothing reports it: 353 MB accumulated with no counter anywhere, and the
only way to find it was `du`.

## Verification Plan

### Automated Tests

1. **Go test** over `logOutput` against a captured fixture of real seat output (the 504 KB sample
   measured above is a suitable source): asserts the distinct-line count is unchanged, the
   duplicate count falls to zero, and a suppression marker carries the correct run length.
   Distinct-line parity is the assertion that matters — it is what proves nothing was lost.
2. Assert a chunk differing by one byte from its predecessor is written in full.
3. Assert an idle seat emitting a repeating status frame produces bounded log growth over a fixed
   interval — the property the 200 MB/day comes from.
4. Regression: `go test ./cmd/...`, `gofmt -l ./cmd`.

### Goal Invariants

- Replaying a suppressed log answers the same questions the current one does: which calls failed,
  what the error text was, what the agent said it was doing. Verified against the three 2026-09-13
  incidents named above, which are in the existing logs.
- An idle seat with no output writes a bounded amount per hour, not an unbounded stream.
- Every suppressed run is visible as a count, so silence and idling are distinguishable.
- Daily log volume with a four-seat team is a stated number with a test that fails when it grows.
