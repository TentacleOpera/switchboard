# The Log Tail the Controller Reads Has Had Its Spaces Removed

## Goal

The log tail served by `GET /terminals/<name>/log` — and therefore the evidence every model-judged
row reads — contains the words that were on the terminal screen, separated by the spaces that were
between them.

### Problem analysis

**Verified 2026-09-17 against a live seat**, not against stored files. `switchboard api GET
/terminals/analyst-1/log` returns:

```
hadn'tIt'saclaimina
document,notevidence.

Usecase:Ican'tconstruct
one.I'venowtriedthree
timesandproducedonly
rationalisations:
```

and elsewhere `Allowedbyautomode`, `Writtenandimported—`, `⏵⏵automodeon`. The spaces are gone. Line
endings are `CR CR` and lines are ~25 characters, so the capture is also recording a narrow pane's
wrapped output rather than the logical lines.

**Mechanism.** `terminalLogWriter.ts:97` strips ANSI with `ANSI_REGEX` and
`collapseCarriageReturns` resolves `\r` redraws. Both are correct as far as they go, and the
CR-collapse in particular is what stops a spinner turning the log into megabytes of frames. What is
missing is any handling of **horizontal position**. Agent CLIs (Devin, Claude Code) do not emit
spaces between words — they place each run with cursor-movement escapes and let the terminal's
column arithmetic do the spacing. Strip the escapes and the runs become adjacent. Nothing in the
writer reconstructs a column grid, so the spacing has nowhere to survive.

This is not a redaction bug and not a transport bug. The information is destroyed at capture, so no
consumer can recover it.

**Why it matters.** `logTail` is declared evidence on **five of the eight matrix rows** — every
model-judged one (`matrix.ts:145, 167, 178, 189, 208`), and `buildClassificationPrompt` appends the
tail unconditionally under `--- log tail (redacted) ---` (`controller.ts:820-823`). So every
judgement call this feature makes is reading text with destroyed word boundaries. Unspaced text
tokenises far worse than prose, and the smaller the judgement model, the more that costs.

The two diagnoses that depend *entirely* on reading words are the two the operator specifically
named as things they catch by eye:

- **quota** — row 5's signal is "provider error text in tail". A real log from this board carries
  `Pro · 5% remaining (resets in 3d 4h)`; what the model receives is `Pro·5%remaining(resetsin3d4h)`.
- **waiting-human** — row 3's signal is "log tail ends in a question or prompt".

**Why no test caught it.** Every fixture is written by hand, with spaces. A synthetic tail exercises
the parser but not the capture, so the defect is invisible from inside the test suite and only
appears against a live seat.

### What already works and must not be disturbed

- **CR-collapse.** `collapseCarriageReturns` is the reason a spinner does not produce a
  multi-megabyte log. Any fix must keep that property; the largest log on this board is already
  10 MB.
- **Fence sanitisation.** `sanitizeFencePayload` stops agent-printed code fences closing the log's
  own block.
- **Redaction**, which runs on the tail before it leaves the host.

### Non-goals

- **Screenshots or vision.** A terminal screen is a grid of characters; an image of it contains
  nothing the grid does not. More to the point, producing an image *requires* the same terminal
  emulation this plan adds, so a screenshot path is this fix plus a rasteriser plus an image
  encoder. (A screenshot of the whole *board UI* is a different proposition — several panes, card
  positions and computed chips at once — and is deliberately out of scope here rather than
  dismissed.)
- **Changing what the rows ask for.** This plan repairs the evidence; it does not touch the matrix.
- **The bundle enrichment** (CPU, RSS, last worktree write) tracked by the judgement-bundle plan.
  Those signals are numbers and are unaffected by this defect. This fix must not block them, and
  they must not wait on it.

## Metadata

**Feature:** (unassigned)
- **Complexity:** 5
- **Tags:** backend, controller, terminals

## User Review Required

- **[user] This adds a terminal emulator to the host process.** Reconstructing columns means
  replaying the byte stream through something that maintains a screen grid — `@xterm/headless` plus
  `@xterm/addon-serialize`, given `@xterm/xterm` is already a dependency for the webview. The
  writer runs on the **board** host, which carries the 800 MB peak-RSS budget and nine measured
  seats. A grid per seat is bounded state (rows × columns, not scrollback) but it is new, and it
  lands on the machine with the tightest budget rather than on the controller host.
- **[user] Alternative worth weighing:** emulate at **read** time rather than capture time — keep
  storing raw bytes and reconstruct the grid only when a tail is requested. That costs the board
  host nothing between reads and moves the work to a rare path, at the price of storing more bytes
  and re-deriving on every read. The trade is memory against disk and CPU-per-read; it needs your
  call because it is a budget decision, not a correctness one.

## Complexity Audit

### Routine

- Wiring a serialiser over an existing byte stream.
- Keeping CR-collapse and fence sanitisation in the pipeline.

### Complex / Risky

- **Terminal width is not known to the writer.** The capture above is ~25 columns, which suggests
  the pane was narrow, and a grid rendered at the wrong width re-wraps every line. Width must come
  from the PTY's own resize events, and a seat resized mid-session changes it.
- **State per seat, on the tightest host.** Nine grids is nine terminal instances to construct,
  feed and dispose. Disposal on seat close must be certain or this is a leak on the machine that
  can least afford one.
- **Existing logs stay broken.** 211 files, up to 10 MB, already captured without spacing. They
  cannot be repaired — the escapes are gone. Anything reading history must tolerate both shapes.

## Edge-Case & Dependency Audit

### Race Conditions

- **Resize mid-flush.** A width change between two chunks re-wraps the grid; the serialised frame
  must be taken after the resize is applied, not across it.
- **Seat closed while a tail is being served.** Read-time emulation must not touch a disposed
  terminal.

### Security

- **Redaction must run after reconstruction, not before.** A secret split across cursor positions
  is not matchable in the raw stream but *is* matchable once the grid puts it back together. Doing
  it in the current order would let a reassembled secret through — this is the one ordering in the
  plan that is a security property rather than a quality one.

### Side Effects

- **Log size changes.** Adding the spaces back makes tails larger, and `evidenceTailBytes` is a
  byte budget — the same setting now buys fewer *words*. It should be re-tuned, not left.

### Dependencies & Conflicts

- Independent of the judgement-bundle plan; that plan's numeric signals do not touch this path.
  They can land in either order.
- Touches `terminalLogWriter.ts`, which the standalone host owns. Per the cutover rule, standalone
  only; the extension host is out of scope.

## Adversarial Synthesis

The risk is adding a terminal emulator per seat to the one host with a hard memory budget, to fix a
signal that two of eight rows depend on. Read-time emulation avoids that cost entirely and is the
option to take if measurement says the grids do not fit. The opposite risk is doing nothing:
quota and waiting-human are the two failure modes the operator named as things they currently catch
by eye, and both are exactly the ones that cannot be diagnosed from numbers.

## Proposed Changes

### 1. Reconstruct the screen grid before the tail is text

Replay the seat's byte stream through a headless terminal that maintains a column grid, and take
the tail from the serialised grid rather than from a regex-stripped stream. Capture-time or
read-time per the User Review decision above.

CR-collapse stays. Fence sanitisation stays, applied to the serialised output.

### 2. Redact after reconstruction

Move redaction to run on the reconstructed text. A secret that was split across cursor positions is
only matchable once the grid has reassembled it, so the current order can leak what the new order
catches.

### 3. Re-tune `evidenceTailBytes`

The same byte budget now carries fewer words, because the spaces are real. Set it against a measured
real tail rather than leaving the existing number to mean something different than it did.

### 4. Tolerate both shapes on read

211 existing logs have no spacing and cannot be repaired. Any consumer of historical logs must not
assume the new shape.

## Verification Plan

### Automated Tests

- **The failing case, from real bytes.** A fixture captured from a live agent CLI — not hand-written
  — reconstructs to text containing `Allowed by auto mode`, with the spaces. This is the test that
  would have caught the defect, and it must use recorded bytes, because a hand-written fixture has
  spaces already and passes trivially.
- **Quota line survives.** A recorded tail containing `Pro · 5% remaining (resets in 3d 4h)`
  reconstructs with its spaces intact.
- **CR-collapse preserved.** A spinner emitting N frames still yields one line, and the output does
  not grow with N.
- **Redaction after reassembly.** A secret written across two cursor positions, unmatchable in the
  raw stream, is redacted in the served tail.
- **Width from resize.** A stream carrying a resize renders subsequent lines at the new width.
- **Disposal.** Closing a seat disposes its terminal; a soak over repeated open/close shows no
  growth.
- **Historical logs.** A pre-fix log file is served without error.

### Goal Invariants

- A tail served for a live seat contains the spaces that were on screen.
- No consumer of the tail needs to know how it was reconstructed.
- Spinner redraws still collapse; log size does not grow with frame count.
- Redaction runs on reassembled text.
- Closing a seat releases everything the reconstruction held.
- Logs captured before this change are still readable.

## Outstanding Questions

- **Capture-time or read-time?** See User Review. It is a memory-versus-disk trade on the host with
  the tightest budget, and it needs a measurement against nine live seats before it is chosen.
- **What width should a tail be rendered at when the PTY never reported one?** Rendering at the
  wrong width re-wraps every line, and a default here is exactly the kind of quiet-wrong-answer
  fallback this repo's rules warn about — it should carry its source, or fail loudly.
- **Does the ~25-column capture reflect the real pane, or a default applied somewhere?** If panes
  are genuinely that narrow, the tail is wrapped prose regardless of spacing, and the row-3
  "ends in a question" signal is reading fragments.
