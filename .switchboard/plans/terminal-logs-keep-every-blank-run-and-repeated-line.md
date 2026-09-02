# Terminal logs keep every blank run and every immediately-repeated line

## Goal

Collapse runs of blank lines and drop a line identical to its immediate predecessor in the terminal
log writer, cutting a session log by roughly a seventh at no fidelity cost.

### Problem Analysis

`terminalLogWriter.ts` already strips ANSI and collapses carriage-return redraws, with a carry buffer
across flush boundaries (`collapseCarriageReturns`, `:115`). It does **not** collapse blank runs or
immediately-repeated lines.

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

The writer's collapsing was scoped to the one artifact that made output actively wrong — a CR redraw
concatenating drafts on a single line. Whole-line redundancy across lines was never in scope, so
nothing looks at the previous emitted line.

### Non-goals

- **Do not reorder, reflow or re-wrap.** Line order and content are preserved; only exact adjacent
  repeats and blank runs are reduced.
- **Do not collapse non-adjacent duplicates.** A repeated line separated by other content is real
  history, and treating it otherwise would silently delete output.
- Do not change the ANSI stripper or the CR-collapse carry.
- Do not change the 10 MiB rotation cap.

## Metadata

**Topic:** Blank-run and adjacent-duplicate collapse in the terminal log writer
**Complexity:** 2
**Tags:** terminals, logging, backend, standalone

## User Review Required

None.

## Dependencies

None.

## Both Hosts

`TerminalLogWriter` is constructed at both composition roots, wired to the same gateway flush
observer:

- standalone — `bootstrap.ts:3209-3222` (`onFlush` plus fleet `renamed`/`closed`)
- extension's pty-host sidecar — `ptyHost.ts:53-61`, the same three subscriptions

The change is inside the writer, so both get it. The rotation cap and the carry state are per-writer
instance; verify a session that spans a flush boundary in both, since that is where the existing carry
already lives and a per-line predecessor is new state alongside it.

## Proposed Changes

**1. Carry the last emitted line across flushes.**

Alongside the existing `crCarry`, hold the last line actually written. The carry is essential: a
duplicate pair split across two flushes would otherwise slip through, which is the same reason
`collapseCarriageReturns` already carries its trailing line.

**2. Drop a line identical to its immediate predecessor.**

Exact string equality only, after ANSI stripping and CR collapse, so the comparison sees the same text
the reader will.

**3. Collapse a run of blank lines to one.**

Blank means empty after the strip. One blank is a paragraph break and prose in the original; a run of
twelve is redraw residue.

**4. Do not touch the fenced-payload safety.** The writer keeps its output fence-safe; the reduction
must run before or within that logic without changing which content gets fenced.

## Verification Plan

1. Re-run the writer over a captured pty stream that today produces
   `Coding-mtfqqy7v-da8a5n.md` and confirm ~13% fewer bytes.
2. A duplicate pair straddling a flush boundary is collapsed — construct the case deliberately.
3. Two identical lines separated by one different line are BOTH kept.
4. A single blank line between paragraphs survives.
5. Dispatch headings (`##`) still appear at each prompt boundary and are never collapsed into a
   neighbour.
6. A code-fence payload in agent output is still fenced correctly.
7. **Both hosts:** run 1 and 2 with the writer wired from `bootstrap.ts` and from `ptyHost.ts`.

### Goal Invariants

- Assert a line equal to its immediate predecessor is dropped.
- Assert a line equal to a NON-adjacent earlier line is kept.
- Assert a blank run collapses to exactly one blank line.
- Assert the predecessor is carried across a flush boundary.
- Assert the ANSI stripper and `collapseCarriageReturns` are unchanged.
