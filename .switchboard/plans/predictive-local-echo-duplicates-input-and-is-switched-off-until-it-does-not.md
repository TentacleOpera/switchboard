# Predictive Local Echo Duplicates Input, and Is Switched Off Until It Does Not

## Goal

Make predicted glyphs reconcile against the real echo without ever leaving a
duplicate on screen, prove it against a **lossy, latent link** rather than a local
one, and only then switch the feature back on.

The operator must never read back their own typing garbled. A latency optimisation
whose failure mode corrupts the input it is optimising is worse than the latency.

## Problem analysis

Predictive local echo shipped 2026-09-19 (`f0ba3aef`, review fix `f5828a4b`) and was
switched off the same day (`26515355`) because on a real tailnet link it **duplicated
input**: whole phrases read back twice. Not mispositioned — repeated.

**It is off behind one constant**, `PREDICTIVE_ECHO_ENABLED` in
`src/webview/terminalViewport.js`, with the ledger left intact and unreferenced. The
reconciliation logic is the hard part and is worth fixing rather than rewriting, so
nothing was deleted.

**The defect is in reconcile, not in prediction.** The pieces:

- `recordPrediction(entry, char)` pushes `{ char, row, col }`, deriving position from
  the previous prediction when one exists and from `buffer.active.cursorX/Y`
  otherwise.
- `paintPredictions` draws them into an overlay; `dropAllPredictions` clears the
  ledger and the overlay together.
- A lull timer (`ECHO_LULL_MS`) retires pending glyphs when nothing echoes back.
- Live output is fed through the ledger **before** it reaches xterm, so predictions
  that the real echo has now covered can be retired.

The duplication says a predicted run was **not retired when its echo arrived**: the
overlay kept painting glyphs that xterm had already drawn underneath. Candidate
causes, all to be discriminated by the repro rather than reasoned about:

1. The echo arrives **split across chunks**, so the per-chunk matcher never sees a
   whole predicted run and retires none of it.
2. The echo arrives **re-wrapped or re-positioned** (a prompt redraw, a line wrap at
   `term.cols`), so the ledger's `{row, col}` no longer matches and the match fails.
3. The ledger is **per-entry but the overlay is not cleared on some paths** — a
   re-render repaints stale entries.
4. Two chunks arrive close enough that reconciliation runs against an already-mutated
   buffer.

**Why the gates missed it.** Every existing check exercises a local, lossless link.
Nothing in the suite delays, splits, reorders or re-wraps a frame, which is the only
condition under which the ledger is under load at all. That is the actual hole — a
correct fix with no lossy-link gate would simply re-ship the same failure.

## Metadata

**Complexity:** 6
**Tags:** terminals, pty, latency, webview, regression-gate
**Scope:** `src/webview/terminalViewport.js` (the ledger and overlay) and the
contract suite. The Go pty host is untouched: this is a client-side reconciliation
defect, not a transport one.

## Dependencies

None. The feature is off, so this blocks nothing and nothing blocks it.

## Proposed changes

### 1. Reproduce it in a harness before touching the ledger

A test that drives `maybePredictEcho` + the reconcile path against a **synthetic lossy
link**: echo delayed by a configurable RTT, split at arbitrary byte boundaries
(including mid-escape-sequence and mid-UTF-8), occasionally re-wrapped, occasionally
preceded by a prompt redraw.

The first assertion is the reported failure: **after the echo of a typed run fully
arrives, the overlay is empty and the visible line contains that run exactly once.**
Write it failing, with the feature forced on, before any fix.

### 2. Reconcile on CONTENT, not on remembered coordinates

Whatever the specific cause, `{row, col}` recorded at predict time is a guess about
where the echo will land, and a re-wrap or redraw invalidates it. Retirement should
key on the predicted characters being present in the live frame, with position as a
hint rather than the match condition.

State the new rule in the code as plainly as the old one was stated, including what it
does when the echo is *different* from the prediction (the user backspaced, the shell
rewrote the line) — that case must clear the ledger, not leave a partial run.

### 3. A predicted run is retired ALL-OR-NOTHING per echo pass

A partially-retired run is what a duplicate looks like on screen. If a pass cannot
account for every pending glyph, it drops the whole ledger and lets the real echo
stand. Losing the optimisation for one keystroke is free; leaving half a run painted
is the bug.

### 4. The kill switch stays, and gains a reason

`PREDICTIVE_ECHO_ENABLED` remains after the fix. It is the only thing that made the
failure survivable, and a latency feature that cannot be switched off is one that has
to be reverted by deploy.

## Verification plan

### Automated

- **The reported failure, as a test:** type a phrase over a synthetic link with
  delayed, split echo; once the echo has fully arrived the overlay is empty and the
  line contains the phrase exactly once. Fails before the fix.
- Echo split mid-escape-sequence and mid-multi-byte-character retires correctly and
  never paints a partial glyph.
- A line wrap at `term.cols` during the unechoed window does not leave a stranded
  prediction on the previous row.
- A prompt redraw arriving between predict and echo clears the ledger rather than
  matching against the redrawn line.
- An echo that DIFFERS from the prediction clears the whole ledger — no partial run
  survives.
- The lull timer still retires a run at a prompt that swallows input, and the hidden
  input gate still suppresses prediction there.
- With `PREDICTIVE_ECHO_ENABLED = false`, `maybePredictEcho` returns before touching
  the ledger and no overlay element is ever created.

### Goal invariants

- The operator never sees their own input twice.
- A prediction that cannot be proven retired is dropped, never left painted.
- Every gate for this feature runs against a link that delays and splits frames. A
  test on a lossless local link is not evidence about this code.

### Manual

On a real tailnet seat, type a long sentence fast, then a command with a backspace
mid-word, then something at a password prompt. Read the line back after each.

## Outstanding questions

- **Which of the four candidate causes is it?** Deliberately not guessed here. Change
  1 exists to answer it, and the answer should be written into this plan before
  Change 2 is designed — a fix aimed at the wrong one will pass a local test and fail
  on the link again.
