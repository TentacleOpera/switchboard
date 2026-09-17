# Terminal Output Is a Conversation, Not a Screen Recording

**Complexity:** 7

## Goal

Three plans on the same root cause: the terminal streams and stores every byte, including output that has already scrolled away, blank runs and repeated lines — and a remote keystroke round-trips before it echoes. The feature addresses the volume and readability of what a seat emits and what a reader gets back, across two layers: the on-disk log (a screen recording that no filter can turn into a conversation) and the live wire (every byte sent, every keystroke waited on). The live surfaces are in the Go pty host (`cmd/switchboard-pty-host`) for logging and sending, and in the shared client viewport (`src/webview/terminalViewport.js`) for echo — both composition roots reach the Go host via `PtyHostSupervisor`, so the server-side work lands once for both.

### Dropped subtask — read the agent's own transcript

A fourth subtask — reading each CLI's native on-disk JSONL transcript instead of the raw PTY log — was considered and dropped. It is a per-CLI chase: one CLI (Claude Code) has a known transcript, the rest of the fleet does not, and an honest `null` fallback leaves two-thirds of seats with the same soup they have today. The operator confirmed (2026-09-02) that an orchestrator model already extracts high-value messages from the raw log without much trouble, so the transcript work is a token-cost improvement for one CLI family, not a repair of a broken loop. Subtask 2 (blank/duplicate collapse) captures most of the practical fleet-wide benefit at a fraction of the work. Do not re-propose the transcript adapter without a fleet-wide answer.

## How the Subtasks Achieve This

- **Terminal logs keep every blank run and every immediately-repeated line**: collapses blank runs and adjacent-duplicate lines in the live Go log writer (`log.go`), cutting a session log ~13% at no fidelity cost. Contributes the volume fix for the log, and the practical benefit an orchestrator model sees today.
- **A Remote Terminal Round-Trips Every Keystroke — Add Predictive Local Echo**: adds a client-side prediction layer in `terminalViewport.js` that renders a typed character immediately and reconciles against the PTY's authoritative echo. Contributes the input-latency fix: typing stops feeling like the link.
- **The Terminal Streams Every Byte, Including Output That Has Already Scrolled Away**: coalesces superseded output against a screen model on the Go send side under backpressure, so a ten-thousand-line build transmits one screen update, not ten thousand lines. Contributes the output-volume fix: the viewer stops waiting on a backlog of bytes it will never read.

## Dependencies & sequencing

- **Subtasks are independent on the file level** and can land in any order; the sequencing below is a soft preference, not a hard dependency.
- **Ship `The Terminal Streams Every Byte…` before `…Add Predictive Local Echo` (soft).** Output-volume coalescing drains the backlog that keystroke-echo latency sits behind; addressing the output side first reduces the queue the input side is measured against. They are different layers (Go server vs client xterm.js) and can proceed in parallel.
- **Prerequisite guard:** the output-coalescing plan's prerequisite (restoring the send queue and backpressure the retired TS gateway had) must land as its change 0 before the screen model has a trigger.

## Team Dispatch Instructions

### Terminal logs keep every blank run and every immediately-repeated line
- **Seat:** Intern (Complexity 2)
- **Acceptance:**
  - A line equal to its immediate predecessor is dropped; a line equal to a non-adjacent earlier line is kept; a blank run collapses to exactly one blank line.
  - The predecessor is carried across a `publish()` boundary and reset on session roll/close; dispatch headings are never collapsed into a neighbour.
  - ~13% fewer bytes on a captured duplicate-heavy stream; the change is in `log.go` and both hosts get it via the Go pty host.
- **Must not touch:** the ANSI stripper, the fence-safety logic, the 10 MiB rotation cap; do not add carriage-return collapse (separate scope).

### A Remote Terminal Round-Trips Every Keystroke — Add Predictive Local Echo
- **Seat:** Lead Coder (Complexity 7)
- **Acceptance:**
  - On a 50 ms+ RTT link a typed character renders before the PTY echo arrives and the display converges on the PTY's output; a wrong prediction resolves without a visible flicker.
  - No prediction at a password prompt, in alternate-screen mode, or mid-escape-sequence; backspace/arrows/control keys leave no stray predicted character; a large paste produces no per-character predictions.
  - A local board (1 ms RTT) has prediction inactive and behaves byte-for-byte as today; the layer lives in `terminalViewport.js` only, not duplicated in `terminals.js`.
- **Must not touch:** the server-side send path (owned by the output-coalescing subtask); the PTY remains the source of truth — a prediction never overrides authoritative echo.

### The Terminal Streams Every Byte, Including Output That Has Already Scrolled Away
- **Seat:** Lead Coder (Complexity 7)
- **Acceptance:**
  - A ten-thousand-line command leaves the viewer's final screen byte-identical to a full replay, while transmitting a small fraction of the bytes.
  - A terminal keeping up transmits byte-for-byte (coalescing inactive below the water mark); a progress bar animates rather than jumping.
  - The session log contains the complete byte stream regardless of coalescing; the coalescing/backpressure layer and the screen model both live in `cmd/switchboard-pty-host`.
- **Must not touch:** the session log (logging is not a viewport — the full stream is always logged); the client-side prediction layer (separate subtask); do not alter output on a healthy link.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Terminal Buffer Snapshot API — `GET /terminals/:name/buffer`](../plans/feature_plan_20260818180000_terminal-buffer-snapshot-api.md) — **PLAN REVIEWED** — ID: a2eb60fa-72d8-4643-85e6-1ab24e98b676
- [ ] [Terminal logs keep every blank run and every immediately-repeated line](../plans/terminal-logs-keep-every-blank-run-and-repeated-line.md) — **PLAN REVIEWED** — ID: 77bc8f5c-e7d5-400f-b081-d03141394bd7
- [ ] [The Terminal Streams Every Byte, Including Output That Has Already Scrolled Away](../plans/the-terminal-streams-every-byte-including-output-already-scrolled-away.md) — **PLAN REVIEWED** — ID: ac14e43b-aa8a-4dec-b223-3f24f34b2cb2
- [ ] [Terminal Logs Record Every Repaint, Not Every Event](../plans/terminal-logs-record-every-repaint-not-every-event.md) — **PLAN REVIEWED** — ID: b6bc1534-67f7-43aa-842b-8103606cb47d
<!-- END SUBTASKS -->

[Terminal Logs Record Every Repaint, Not Every Event](../plans/terminal-logs-record-every-repaint-not-every-event.md) — **PLAN REVIEWED** — ID: b6bc1534-67f7-43aa-842b-8103606cb47d

