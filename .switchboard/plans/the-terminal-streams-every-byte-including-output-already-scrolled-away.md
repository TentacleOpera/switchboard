# The Terminal Streams Every Byte, Including Output That Has Already Scrolled Away

kanbanColumn: CREATED

## Goal

A remote terminal transmits what the viewer needs to see, not every byte the PTY ever produced. Output superseded before it could be displayed is not sent.

### Problem analysis

Switchboard streams raw PTY bytes to the browser over a WebSocket. Every byte crosses the link, including the overwhelming majority that scrolls off screen before anyone could read it. A build that emits ten thousand lines transmits ten thousand lines to render a screen holding forty.

> **Superseded (target surface):** The "send queue" framing inherits from the retired
> `src/standalone/terminalWsGateway.ts`, which had a coalescing window (`OUTPUT_FLUSH_MS`, 6 ms), a
> frame cap (`MAX_FLUSH_BYTES`, 128 KB), and high/low-water backpressure.
> **Reason:** `terminalWsGateway.ts` is retired — `bootstrap.ts:3978` records "nothing constructs it."
> The **live** send path is `cmd/switchboard-pty-host/main.go:publish()` + `ws.go`, reached by both
> composition roots via a raw socket splice (`LocalApiServer._proxyTerminalUpgrade`). `publish()` sends
> every pty data event as its own binary frame immediately — **no coalescing window, no send queue, no
> backpressure, no water marks.** The content-free collapse the dead gateway had is also gone.
> **Replaced with:** The live Go host is *worse* than the plan implies: it does not even batch chunks.
> The screen-model coalescing this plan proposes needs a pressure signal to trigger ("only under
> pressure"), and that signal does not exist because there is no queue. Restoring basic coalescing +
> backpressure is therefore a prerequisite of the screen-model design, not a separate nicety — the
> "only under pressure, never by default" invariant has no baseline to defend on the live host, which
> already transmits per-event frames rather than coalesced ones.

On a fast link this is invisible. On a slow or jittery one it is the reason a terminal appears to hang: the viewer is not waiting for the current output, it is waiting for the backlog to drain first. The operator saw exactly this shape on the board this morning — column icons that "finally rendered, just took forever" — and it is the same failure mode.

**This is mosh's other advantage.** Mosh synchronises screen *state*, not a byte stream: it computes the diff to the final screen and sends that, skipping every intermediate frame the user was never going to see. A thousand-line scroll becomes one screen update. The technique does not require mosh's transport — it requires the sender to know that pending output has been superseded.

TCP makes it worse. A WebSocket is ordered and reliable, so a lost packet on bad wifi stalls everything queued behind it, and the queue is full of output that no longer matters.

## Metadata

- **Complexity:** 7
- **Tags:** terminals, performance, remote, both-hosts

## User Review Required

None.

## Complexity Audit

### Routine
- Pairing with compression (`599a075d`) — distinct layers, no duplication.
- The scrollback-contract decision and its UI signal.

### Complex / Risky
- A screen model on the send side that resolves pending bytes against terminal state and sends a diff
  instead of byte history. A model that mishandles one escape sequence corrupts the display forever.
- Restoring the coalescing window + send queue + high/low-water backpressure the retired TS gateway
  had, now in Go — this is the prerequisite pressure signal the screen model needs to trigger.
- Preserving output-timing programs (progress bars, spinners) so they animate rather than jump: a
  burst-condense is different from a slow-stream-condense.
- Logging the full byte stream regardless of coalescing (logging is not a viewport).

## Proposed Changes

**Target surface: `cmd/switchboard-pty-host/main.go` (`publish()`) + `ws.go`.** Both composition roots
reach this path via the raw socket splice, so one Go implementation serves both hosts.

### 0. Restore the send queue and pressure signal (prerequisite)

The live `publish()` sends every pty data event as its own frame with no queue and no backpressure.
The screen-model coalescing in change 1 triggers "only under pressure," and pressure needs a queue and
a water mark. Re-introduce a coalescing window, a per-terminal send queue, and high/low-water marks in
Go (the retired `terminalWsGateway.ts` had `OUTPUT_FLUSH_MS`, `MAX_FLUSH_BYTES`, `HIGH/LOW_WATER_*`).
This is in-scope as the prerequisite, not a separate card — without it, change 1 has no trigger.

### 1. Drop output that has been superseded before it is sent

When the send queue for a terminal has grown beyond what the viewer can consume, coalesce it: resolve
the pending bytes against a screen model and send the resulting state rather than the byte history.

The test for correctness is that the viewer's final screen is identical to what a full byte replay would
have produced. Anything that changes the end state is a bug, not an optimisation.

### 2. Never drop the scrollback contract silently

A terminal's scrollback is a real feature and this must not quietly amputate it. Either the coalescing preserves scrollback, or the terminal states plainly that output was condensed during a burst. What it must not do is present a gap as though it were the whole output.

Decide which, and make it visible in the UI rather than in a comment.

### 3. Only under pressure, never by default

A terminal keeping up with its output must behave exactly as it does today, byte for byte. Coalescing engages when the queue is backing up and disengages when it drains.

A mechanism that alters output on a healthy link to save bytes that were never a problem is a regression with a performance justification.

### 4. Pair with compression, do not duplicate it

`599a075d` (*Every terminal WebSocket crosses the link uncompressed*) is through review and is the other half. Compression makes each byte cheaper; this makes the unnecessary bytes not exist. They compose and neither replaces the other.

## Edge-Case & Dependency Audit

1. **The end state must be byte-identical to a full replay.** This is the entire correctness bar. A screen model that mishandles an escape sequence corrupts the display in a way that looks like a terminal bug forever after.
2. **Alternate-screen applications** already redraw whole screens; coalescing there is both safest and highest value.
3. **Programs that depend on output timing** — progress bars, spinners — must still animate, not jump. Condensing a burst is different from condensing a slow stream.
4. **A terminal being logged.** Session logs must record the full byte stream regardless of what was sent to the viewer. Logging is not a viewport.
5. **Both hosts.** The browser cockpit and the extension webview both consume this stream — both via the Go pty host's `publish()`/`ws.go` reached through the board's raw socket splice. One Go implementation serves both; there is no separate extension-side sender to wire.
6. **Prediction is separate.** The keystroke-echo card covers input latency; this covers output volume. Same felt symptom, different mechanism.

## Dependencies

None blocking. Complementary to `599a075d` (compression) — compression makes each byte cheaper, this makes the unnecessary bytes not exist; they compose. The prerequisite (change 0: coalescing + backpressure) is internal to this plan.

## Adversarial Synthesis

Key risks: a screen model that mishandles one escape sequence corrupts the display forever after (the entire correctness bar is "final screen byte-identical to a full replay"); the "only under pressure" invariant has no trigger on the live Go host because there is no queue, so the prerequisite coalescing/backpressure must land first or the design is not codeable; output-timing programs (progress bars) must animate, not jump. Mitigations: restore the queue and water marks as change 0; gate the screen model behind the high-water mark and disengage at low-water; keep the full byte stream in the session log regardless of coalescing.

## Verification Plan

1. A command emitting ten thousand lines leaves the viewer's final screen identical to a full byte replay.
2. That command's transmitted bytes are a small fraction of its output.
3. A terminal keeping up with its output transmits byte-for-byte as it does today.
4. A progress bar animates rather than jumping to its end state.
5. Scrollback behaves per the change-2 decision, and the UI says so if output was condensed.
6. Session logs contain the complete stream regardless of coalescing.
7. Measured on the operator's own link: time from command start to a usable screen, before and after.

### Goal Invariants

- Assert the viewer's final screen after a coalesced burst is byte-identical to a full byte replay.
- Assert superseded output (scrolled off before display) is absent from the wire frames, not merely compressed.
- Assert a terminal keeping up with its output transmits byte-for-byte (coalescing inactive below the water mark).
- Assert the session log (`log.go` output) contains the complete byte stream regardless of coalescing.
- Assert a progress bar animates rather than jumping to its end state.
- Assert the coalescing/backpressure layer and the screen model both live in `cmd/switchboard-pty-host` (no TS-side sender).
