# A Remote Terminal Round-Trips Every Keystroke — Add Predictive Local Echo

kanbanColumn: CREATED

## Goal

A character typed into a remote Switchboard terminal appears immediately, before the PTY confirms it, and is reconciled when the real echo arrives. Typing stops feeling like the link.

### Problem analysis

Every keystroke in a Switchboard terminal makes a full round trip before the user sees it. On a good link that is invisible. On a real one it is the dominant cost and it is what makes the terminal feel broken.

Measured on this operator's own link (2026-09-04): gateway ping **min 3.5 ms, avg 53.1, max 189.0, jitter 64.0**. Every character waits out that distribution before appearing. The variance is worse than the mean — typing at 53 ms average with 64 ms of jitter does not feel like a 53 ms delay, it feels unpredictable, which is what the operator reports as "far snappier" about mosh over the same wifi.

**This is the difference mosh is famous for.** Mosh renders the keystroke locally and immediately, marked as unconfirmed, then reconciles against the server's authoritative screen. The round trip still happens; the user simply stops waiting on it. Nothing about that technique requires mosh's transport — it is a client-side prediction layer, and xterm.js is perfectly capable of hosting one.

**What exists today.** `a8f75f5d` (*A keystroke echo waits on two frame boundaries it does not need*, Backlog) removes roughly one rAF cycle (~8-17 ms) of client-side frame quantization from the echo path. Real, and worth landing — but it optimises the tail of a path whose head is a network round trip. Removing 10 ms from a 53±64 ms wait does not change how typing feels.

This card is the head of that path.

## Metadata

- **Complexity:** 7
- **Tags:** terminals, performance, remote, browser

## User Review Required

None.

## Complexity Audit

### Routine
- Rendering a typed character locally the moment it is typed, visually distinguished as unconfirmed.
- Reconciling a confirmed prediction against the PTY's authoritative echo on arrival.

### Complex / Risky
- Detecting the states where prediction is unsafe — alternate-screen buffer, hidden-input
  prompt, mid-escape-sequence — only two of the three are actual xterm.js state queries; the
  hidden-input one is not (see Proposed Change 2).
- Reconciliation that resolves before paint so a wrong prediction never visibly flickers or changes
  on screen.
- Backspace, arrows, control characters, and bracketed paste: a naive char-level predictor produces
  garbage on cursor movement; predict them properly or predict nothing.

## Proposed Changes

All changes live in `src/webview/terminalViewport.js`. Both embedders (browser cockpit, extension
webview) reach the module through `window.SwitchboardTerminalViewport.create`, so one implementation
serves both hosts. Do not duplicate the layer in `terminals.js`.

### 1. Predict the echo as a DOM overlay — never as injected terminal bytes

Render a typed character locally the moment it is typed, visually distinguished as unconfirmed
(mosh's convention: underlined). When the PTY's real output arrives, reconcile: matching predictions
become confirmed, mismatches are discarded and the authoritative bytes win.

**The mechanism is a DOM overlay, not `term.write`.** A prediction must never enter xterm's buffer:
injected bytes are indistinguishable from real output to the parser, and "un-writing" a wrong guess
means emitting erase sequences that corrupt cursor state. Instead, keep a per-entry list of pending
predictions `{row, col, char}` and draw them in an absolutely-positioned overlay element inside the
pane container, positioned from `term.buffer.active.cursorX`/`cursorY` and the rendered cell
geometry measured off `.xterm-rows` in the DOM. On any incoming live output the overlay is dropped —
the real bytes then paint the truth. The terminal buffer is never touched by a guess.

**Where prediction hooks:** inside `term.onData` (terminalViewport.js:1645), *after* the
`suppressAnswerback`/`isAnswerback` guard and after `deps.transformInput` — the prediction must
reflect the bytes actually sent, and must never fire for a terminal's own synthetic replies.

**Where reconciliation hooks:** `writeLiveChars(entry, text)` — the single live-write seam
introduced by the sibling plan `a8f75f5d`. Every live byte meets xterm through that one function
(fast path and batched path alike); wrap it so each incoming chunk first feeds the reconciler
(match predicted chars against the chunk's leading bytes; a full or partial match confirms, any
mismatch discards all pending predictions for that entry), then writes through as normal. Timing:
drop the overlay glyphs in the `term.write` *callback* (post-parse), not at hand-off — removing them
at hand-off leaves a one-frame hole where neither prediction nor echo is painted, which is exactly
the flicker this plan exists to avoid.

The PTY is always the source of truth. A prediction is a hint shown early, never a substitute — if
the two disagree, the screen must converge on what the PTY actually said, not on what was guessed.

### 2. Predict only where prediction is safe

Prediction is correct for a plain printable character echoed at a shell prompt. It is wrong, and
visibly wrong, in a full-screen application, at a password prompt, mid-escape-sequence, or anywhere
the application is redrawing rather than echoing.

> **Superseded (2026-09-17):** "Detecting the states where prediction is unsafe — alternate-screen
> buffer, password/hidden-input prompt, mid-escape-sequence — each is a distinct xterm.js state
> query, not one check."
> **Reason:** Two of the three are real queries — `term.buffer.active.type === 'alternate'` is
> already used at terminalViewport.js:907 and `term.modes.bracketedPasteMode` is public API in the
> vendored xterm 5.5 — but **no xterm.js state reports "the application is reading hidden input"**.
> Echo suppression lives in the pty's termios on the *server* side, and for ssh/mosh-transport and
> tmux control-mode seats even the Go host's own pty fd does not reflect the remote app's flags.
> The premise as written would have shipped a plan whose privacy gate was a query that does not
> exist.
> **Replaced with:** the gate set below — three real state checks plus a conservative
> prompt-line heuristic for hidden input, with the residual risk stated plainly in Outstanding
> Questions.

Suppress prediction when ANY of:

1. `term.buffer.active.type === 'alternate'` — TUIs redraw rather than echo.
2. `term.modes.bracketedPasteMode` is set and the input is a paste — no per-character predictions on
   paste, ever.
3. The input is not a single printable character — backspace, arrows, control characters, function
   keys, multi-byte input. Predict them properly or not at all; v1 is not-at-all.
4. The input stream appears mid-escape-sequence — the viewport sees every inbound byte before xterm
   does; maintain a per-entry "parser in flight" flag by scanning each live chunk's tail for an
   unterminated CSI/OSC/DCS before it is written, and suppress while set.
5. The prompt line under the cursor looks like a hidden-input prompt — heuristic: the text of the
   cursor's row matches /pass(word|phrase)?|pin|secret|token/i, or no echo-like output has arrived
   since the last keystroke within a short window. **This is a heuristic, not a guarantee** — the
   residual risk is recorded in Outstanding Questions.
6. `entry.suspended`, `!entry.term`, socket not OPEN — already the conditions under which input is
   dropped or stale anyway.

A terminal that guesses wrong in a TUI is worse than one that waits — the failure is visible
garbage rather than a pause.

### 3. Predict unconditionally — no RTT gate, no latency measurement

**Decided 2026-09-17: prediction is always on. Do not build an RTT gate, and do not build RTT
measurement infrastructure to feed one.**

An earlier draft of this plan gated prediction on a measured round trip so a local board would be
untouched. That gate is removed, for three reasons:

1. **It buys nothing when the code is right.** Reconciliation that is correct at 50 ms is correct at
   1 ms. The gate does not make prediction safe; the state checks in Change 2 do.
2. **It actively hides the failure when the code is wrong.** Gating prediction to remote links means
   a reconciliation bug never appears on the operator's own board and surfaces only over the
   tailnet — the worst place to find it. Ungated, a bad prediction shows up on the first keystroke
   in dev.
3. **The measurement does not exist and its absence is silent.** There is no RTT signal to read:
   the production gateway is the Go pty host, whose message switch (ws.go:166) has no ping/pong at
   all. A gate built on a nonexistent signal resolves to the floor forever — prediction permanently
   off, every invariant green. That is the fallback-indistinguishable-from-a-real-value failure
   this codebase bans, built deliberately. (The sibling plan
   `the-go-pty-host-has-no-coalescing-window-add-a-link-aware-one.md` builds RTT probes for a
   different purpose — sizing the coalescing window. Nothing here depends on them.)

So there is no link-awareness in this change and nothing to configure. A local board runs the same
prediction path as a remote one; on a 1 ms link the confirmation simply arrives before the
prediction is perceptible.

### 4. Do not ship prediction as the only echo improvement

`a8f75f5d` is complementary, not redundant: prediction hides the network, and frame de-quantization
makes the confirmation land cleanly. Land both. Neither substitutes for the other.

**Ordering:** this plan lands AFTER `a8f75f5d`. That plan extracts `writeLiveChars`, the single
seam where live bytes meet xterm; this plan's reconciler hooks that seam. If this plan lands first
it must introduce the seam itself — do not hook `flushBatch` and the fast-path write separately.

## Edge-Case & Dependency Audit

1. **A wrong prediction must be invisible, not corrected on screen.** The reconciler drops overlay
   glyphs on mismatch before the real bytes paint; a character that appears and then visibly changes
   is worse than one that appeared late.
2. **Password and hidden input.** A prompt that suppresses echo must not have its input predicted
   onto the screen. Client-side this is heuristic only (see Proposed Change 2) — stated plainly so
   the reviewer does not mistake the regex for a guarantee.
3. **Full-screen applications.** Editors, pagers and TUIs redraw rather than echo. Prediction is off
   in alternate-screen mode (`term.buffer.active.type`).
4. **Backspace, arrows, control characters.** These do not echo as themselves. v1 predicts nothing
   for them — a naive character-level predictor produces garbage on cursor movement.
5. **Paste and bracketed paste.** A large paste must not generate a prediction per character; the
   mode check and the multi-character check both suppress it.
6. **Both hosts.** The browser cockpit and the extension webview both render terminals and both need
   this — and it is client-side, so it is one implementation in `src/webview/terminalViewport.js`,
   reached by both through `window.SwitchboardTerminalViewport.create`. Do not duplicate the layer
   in `terminals.js`.
7. **Local boards run prediction too.** There is no RTT gate, so a loopback board takes the same
   path. That is intentional: it is the only way a reconciliation bug is caught in dev rather than
   over the tailnet. A local board must therefore still pass every correctness invariant below —
   "it only misbehaves on localhost" is a bug, not an acceptable tradeoff.
8. **Replay frames.** `writeReplay` has its own write path and never passes through
   `writeLiveChars` — a replay cannot confirm or collide with a pending prediction. Predictions
   pending across a reconnect are dropped on socket close.

## Dependencies

`a8f75f5d` — *A keystroke echo waits on two frame boundaries it does not need* — lands first: it
introduces `writeLiveChars`, the seam this plan's reconciler hooks. The dependency is on the seam,
not the latency win.

## Adversarial Synthesis

Key risks: a prediction that flickers (appears then changes) passes a latency metric while failing
the real goal (typing that feels right); prediction in a TUI produces visible garbage; hidden-input
prediction leaks secrets — and the only fully reliable echo-state signal lives server-side in
termios, invisible to the client and unreachable through ssh/tmux transports. Mitigations: render
predictions in a DOM overlay that never enters the terminal buffer (a wrong guess is deleted, not
erased), gate on the three real xterm.js state queries plus a conservative prompt heuristic, hook
reconciliation at the single `writeLiveChars` seam and resolve it in the write callback so neither
glyph is absent for a frame, and predict nothing for backspace/arrows/control/paste.

## Verification Plan

1. Typing on a link with 50 ms+ RTT shows characters immediately, and the display converges on the
   PTY's output.
2. A prediction that turns out wrong resolves without a visible flicker or a character that changes
   on screen.
3. No prediction occurs at a hidden-input prompt (per the gate in Change 2), in alternate-screen
   mode, or mid-escape-sequence.
4. Backspace and arrow keys never leave a stray predicted character.
5. A large paste does not produce per-character predictions.
6. A local board runs prediction and shows no visible flicker, no stray character and no divergence
   from the PTY.
7. Measured end-to-end: perceived keystroke latency on the operator's own link, before and after, on
   the same connection.
8. A reconnect with pending predictions drops them; the replay/`writeReplay` path never feeds the
   reconciler.

### Goal Invariants

- Assert a typed character on a 50 ms+ RTT link renders before the PTY echo arrives (in
  `terminalViewport.js`).
- Assert the display converges on the PTY's authoritative output when the echo arrives (PTY is
  source of truth).
- Assert predicted text is never passed to `term.write` — predictions live only in the overlay and
  cannot enter the terminal buffer.
- Assert no prediction is emitted in alternate-screen mode, under the hidden-input gate, or
  mid-escape-sequence.
- Assert backspace/arrow/control keys leave no stray predicted character.
- Assert a large paste does not produce per-character predictions.
- Assert no RTT probe, ping timestamp or latency-derived gate exists anywhere in the prediction
  path.
- Assert the prediction layer exists in `terminalViewport.js` only, not duplicated in
  `terminals.js`.
- Assert reconciliation is hooked at `writeLiveChars` and nowhere else — `writeReplay` is untouched.

## Outstanding Questions

- **[user]** Hidden-input detection is heuristic — the prompt-row regex plus an echo-lull window.
  There is no client-side way to see the pty's termios ECHO flag, and for ssh/mosh-transport or tmux
  control-mode seats even the host cannot see the remote app's flags. The residual risk: a
  nonstandard password prompt ("enter secret:" phrasing the regex misses) leaks predicted keystrokes
  to the overlay for up to one RTT each. Proceeding on the assumption the heuristic is acceptable
  for v1 because mosh ships the same exposure; the alternatives are a server-side echo-state control
  frame (partial coverage — useless for ssh/tmux seats) or predicting nothing when the prompt line
  cannot be positively identified as a shell prompt (safest; costs prediction in any unfamiliar
  prompt).

## Implementation summary

Predictive local echo landed entirely in `src/webview/terminalViewport.js`. `maybePredictEcho` runs
inside `term.onData` after the answerback guard, `transformInput`, and the socket-OPEN send;
`shouldPredictEcho` gates on alternate-screen buffer, non-single-printable input (which also covers
bracketed paste, since xterm delivers it as one multi-character chunk), `parserInFlight`,
`suppressAnswerback`, the hidden-prompt regex on the cursor row (`baseY + cursorY`), and the
`ECHO_LULL_MS` echo-lull window. Predictions are `{char,row,col}` entries painted as underlined
absolutely-positioned spans in a `.sb-echo-overlay` div measured off `.xterm-screen` — never through
`term.write`. `reconcilePredictions` runs at the head of `writeLiveChars` (the `a8f75f5d` seam),
confirms leading-byte matches, discards on any mismatch, and repaints inside the `term.write`
callback so neither glyph is absent for a frame; `writeReplay` runs only the parser-tail scanner,
never the reconciler. Pending predictions drop on socket close, reconnect teardown, suspend,
destroy, resize, scroll, exit/error frames, and a `predictionLullTimer` that retires unechoed
predictions after one second of silence. `scanParserInFlight` tracks ground/esc/csi/osc/dcs/str
state across live chunks and replay chunks alike. No RTT probe or latency-derived gate exists in the
prediction path; `terminals.js` is untouched. Verification per the plan's list is deferred —
compilation and tests were skipped per dispatch directive; `node --check` is clean.
