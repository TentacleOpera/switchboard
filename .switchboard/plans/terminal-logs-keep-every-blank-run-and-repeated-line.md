# Terminal logs keep every blank run and every immediately-repeated line

## Goal

Collapse runs of blank lines and drop a line identical to its immediate predecessor in the terminal
log writer, cutting a session log by roughly a seventh at no fidelity cost.

### Problem Analysis

> **Superseded:** "`terminalLogWriter.ts` already strips ANSI and collapses carriage-return redraws,
> with a carry buffer across flush boundaries (`collapseCarriageReturns`, `:115`). It does not collapse
> blank runs or immediately-repeated lines."
> **Reason:** `src/standalone/terminalLogWriter.ts` is **retired dead code** — `new TerminalLogWriter(`
> appears nowhere in `src/` outside its own (now-stale) contract test, and `bootstrap.ts:3978` records
> that the sibling `terminalWsGateway.ts` it subscribed to "used to, but nothing constructs it." The
> retired `ptyHost.ts` is a 7-line stub that throws. The **live** terminal log writer is
> `cmd/switchboard-pty-host/log.go` (Go), called from `publish()` (`main.go:218-219`) on every output
> event and from `logPrompt` (`prompt.go:250`) on each dispatch. Both composition roots
> (`bootstrap.ts` and `extension.ts`) use the Go pty host via `PtyHostSupervisor`, so `log.go` is the
> one writer shared by both hosts — there is no separate extension-side writer.
> **Replaced with:** The live writer (`log.go`) strips ANSI (`stripAnsi`) and sanitises fences
> (`sanitizeFence`), opens/closes the `console` code block, writes `##` headings on prompt delivery, and
> rolls the session at 10 MiB. It does **not** collapse carriage-return redraws, blank runs, or
> adjacent duplicates — it lacks even the CR collapse the dead TS writer had. The measurements below
> were taken on a real log file produced by this live Go writer, so they stand; the behaviour they
> describe is the Go writer's behaviour.

Measured on a real log — `.switchboard/logs/Coding-mtfqqy7v-da8a5n.md`, 7,005,306 bytes,
108,853 lines:

| | |
| :--- | :--- |
| blank lines | 5,205 (4.8%) |
| single-character lines | 2,629 (2.4%) |
| **collapse adjacent duplicates** | 108,853 → 105,428 lines; **7.00 MB → 6.06 MB (−13.4%)** |
| additionally drop blank + 1-char runs | 6.06 → 6.05 MB (−0.2%) |

So the recoverable size is almost entirely in adjacent duplicates; stripping short lines is close to
free in bytes and worth doing only because it makes the file readable.

**What is NOT recoverable here, and must not be attempted.** The file holds 108,853 lines but only
**21,718 distinct** ones — so ~80% of lines repeat *somewhere but not adjacently*. That is a TUI
repainting a region (same box borders, same status line) interleaved with new content, and no line
filter can collapse it; it needs a screen emulator. `read-the-agents-own-transcript-instead-of-reconstructing-the-terminal.md`
is the plan for that problem and this plan does not overlap it.

**Priority note, recorded honestly.** That transcript plan argues the stripped log is unusable as a
conversation. In practice an orchestrator model reading these logs extracts high-value messages from
them without much trouble — reported by the operator, 2026-09-02. The plan's claim is true of a
*regex* and evidently not of a model, so the transcript work is a token-cost and misread-risk
improvement rather than a repair of a broken loop. This plan captures most of the practical benefit
for a fraction of the work.

### Root Cause

The live writer's cleaning was scoped to ANSI stripping and fence safety. Whole-line redundancy
across lines was never in scope, so nothing looks at the previous emitted line. (The dead TS writer
had CR collapse but no line-level dedup either; neither writer ever did this.)

### Non-goals

- **Do not reorder, reflow or re-wrap.** Line order and content are preserved; only exact adjacent
  repeats and blank runs are reduced.
- **Do not collapse non-adjacent duplicates.** A repeated line separated by other content is real
  history, and treating it otherwise would silently delete output.
- **Do not add carriage-return collapse.** The live Go writer lacks it, and adding it is a separate
  decision with its own correctness surface (overlay semantics, carry cap). It is out of scope here;
  this plan does not inherit the dead TS writer's CR behaviour by reference.
- Do not change the ANSI stripper or the fence safety logic.
- Do not change the 10 MiB rotation cap.

## Metadata

**Topic:** Blank-run and adjacent-duplicate collapse in the terminal log writer
**Complexity:** 2
**Tags:** terminals, logging, backend, standalone

## User Review Required

None.

## Complexity Audit

### Routine
- Per-line predecessor comparison (exact string equality) after ANSI strip and fence sanitise.
- Blank-run collapse to a single blank line.
- Carrying one line of state across `logOutput` calls on the per-terminal `sessionLog`.

### Complex / Risky
- None. The change is local to `log.go`'s `logOutput`/`appendLog` path and adds one field of state.

## Edge-Case & Dependency Audit

- **Race Conditions:** `logOutput` runs under `f.logMu` (held by `appendLog`), but the
  predecessor/blank-run state is per-`sessionLog` and mutated on the same lock path. The carry must be
  flushed on `rollLogLocked` and `closeFenceLocked` so a roll does not leave a stale predecessor that
  suppresses the new session's first line.
- **Security:** No change to path handling or auth; logs stay 0o600.
- **Side Effects:** Fewer bytes on disk and fewer `appendFile` syscalls for duplicate-heavy output.
- **Dependencies & Conflicts:** None. `log.go` is self-contained; no other package imports its
  cleaning logic.

## Dependencies

None.

## Both Hosts

`log.go` is the live writer for **both** composition roots: standalone (`bootstrap.ts`) and the
extension (`extension.ts`) both drive the Go pty host via `PtyHostSupervisor`, and `publish()` calls
`logOutput` regardless of which root spawned the fleet. The change is inside `log.go`, so both hosts
get it. There is no `ptyHost.ts` to wire (it is retired) and no second writer to keep in sync.

> **Superseded:** "standalone — `bootstrap.ts:3209-3222` (`onFlush` plus fleet `renamed`/`closed`);
> extension's pty-host sidecar — `ptyHost.ts:53-61`, the same three subscriptions."
> **Reason:** Those line references are stale. `bootstrap.ts:3209-3222` is tmux terminal lookup, not
> log-writer wiring; `ptyHost.ts` is a 7-line retired stub. The flush-observer subscription model
> belonged to the dead `terminalWsGateway.ts`; the live writer is called directly from `publish()`.
> **Replaced with:** Both hosts reach the one writer through the Go pty host's `publish()`/`logPrompt`.
> Verify a session that spans a `publish()` boundary (the Go host calls `logOutput` per pty data event
  with no coalescing window), since that is where the predecessor carry must hold.

## Adversarial Synthesis

Key risks: a duplicate pair split across two `publish()` calls slips through if the predecessor is
not carried; a session roll leaves a stale predecessor that suppresses the new session's first line.
Mitigations: carry the predecessor on `sessionLog` (not a local), and reset it on `rollLogLocked`/
`closeFenceLocked`. The 13% measurement holds because it was taken on the live Go writer's output.

## Proposed Changes

**Target file: `cmd/switchboard-pty-host/log.go`**

**1. Carry the last emitted line across `logOutput` calls.**

Add a `lastLine string` field to `sessionLog`. The carry is essential: a duplicate pair split across
two `publish()` calls (the Go host has no flush interval — `logOutput` fires per pty data event)
would otherwise slip through. Reset `lastLine` on `rollLogLocked` and `closeFenceLocked` so a new
session does not inherit the old session's predecessor.

**2. Drop a line identical to its immediate predecessor.**

Exact string equality only, after ANSI stripping and fence sanitising, so the comparison sees the same
text the reader will. Implement in `logOutput` before `appendLog`: split the cleaned text into lines,
suppress a line equal to `state.lastLine`, update `state.lastLine` to the last non-suppressed line.

**3. Collapse a run of blank lines to one.**

Blank means empty after the strip. One blank is a paragraph break; a run of twelve is redraw residue.
Collapse within the same line pass as change 2.

**4. Do not touch the fenced-payload safety.**

`sanitizeFence` and the open/close fence logic in `appendLog`/`closeFenceLocked` are unchanged; the
reduction runs in `logOutput` on the cleaned text before it reaches `appendLog`, so which content
gets fenced is unaffected.

## Verification Plan

1. Re-run the writer over a captured pty stream that today produces
   `Coding-mtfqqy7v-da8a5n.md` and confirm ~13% fewer bytes.
2. A duplicate pair straddling a `publish()` boundary is collapsed — construct the case deliberately
   (two `logOutput` calls, identical line split across them).
3. Two identical lines separated by one different line are BOTH kept.
4. A single blank line between paragraphs survives.
5. Dispatch headings (`##` from `logPrompt`) still appear at each prompt boundary and are never
   collapsed into a neighbour.
6. A code-fence payload in agent output is still fenced correctly.
7. **Both hosts:** the change is in `log.go`; run 1 and 2 against a fleet spawned from `bootstrap.ts`
   and from `extension.ts` (both reach the same Go writer via `publish()`).

### Goal Invariants

- Assert a line equal to its immediate predecessor is dropped (in `log.go`'s `logOutput` output).
- Assert a line equal to a NON-adjacent earlier line is kept.
- Assert a blank run collapses to exactly one blank line.
- Assert the predecessor (`sessionLog.lastLine`) is carried across a `publish()` boundary.
- Assert `sessionLog.lastLine` is reset on `rollLogLocked` and `closeFenceLocked`.
- Assert `stripAnsi` and `sanitizeFence` in `log.go` are unchanged.
