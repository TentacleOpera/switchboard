# Terminal Output Is a Conversation, Not a Screen Recording

**Complexity:** 7

## Goal

Plans on the same root cause: the terminal streams and stores every byte, including output that has already scrolled away, blank runs and repeated lines. The feature addresses the volume and readability of what a seat emits and what a reader gets back, across two layers: the on-disk log (a screen recording that no filter can turn into a conversation) and the live wire (every byte sent). The live surfaces are in the Go pty host (`cmd/switchboard-pty-host`) for logging and sending — both composition roots reach the Go host via `PtyHostSupervisor`, so the server-side work lands once for both.

> **Input latency left this feature (2026-09-18).** This feature was written around
> *output volume* and *input latency* together. The input-latency half — predictive
> local echo — now belongs to **Typing on a Remote Board Should Not Wait on the Link**
> (`94aa8b26`), which owns `A Remote Terminal Round-Trips Every Keystroke — Add
> Predictive Local Echo` (`1ee5b5fa`) along with the client fast-path and Go
> coalescing-window plans. The board has reflected the move for some time; this file's
> prose had not, and still carried a dispatch block demanding an RTT gate on
> prediction — a gate `94aa8b26` deliberately removed on 2026-09-17. Anyone
> dispatching from that stale text would have rebuilt the thing that was deleted. It is
> gone from here. **This feature is output-side only.**
>
> Two subtasks in the auto-generated list below — `Terminal Buffer Snapshot API`
> (`a2eb60fa`) and `Terminal Logs Record Every Repaint, Not Every Event`
> (`b6bc1534`) — are not described in the prose above and have no dispatch block.
> They need both before this feature is dispatched.

### Dropped subtask — read the agent's own transcript

A fourth subtask — reading each CLI's native on-disk JSONL transcript instead of the raw PTY log — was considered and dropped. It is a per-CLI chase: one CLI (Claude Code) has a known transcript, the rest of the fleet does not, and an honest `null` fallback leaves two-thirds of seats with the same soup they have today. The operator confirmed (2026-09-02) that an orchestrator model already extracts high-value messages from the raw log without much trouble, so the transcript work is a token-cost improvement for one CLI family, not a repair of a broken loop. Subtask 2 (blank/duplicate collapse) captures most of the practical fleet-wide benefit at a fraction of the work. Do not re-propose the transcript adapter without a fleet-wide answer.

## How the Subtasks Achieve This

- **Terminal logs keep every blank run and every immediately-repeated line**: collapses blank runs and adjacent-duplicate lines in the live Go log writer (`log.go`), cutting a session log ~13% at no fidelity cost. Contributes the volume fix for the log, and the practical benefit an orchestrator model sees today.
- **The Terminal Streams Every Byte, Including Output That Has Already Scrolled Away**: coalesces superseded output against a screen model on the Go send side under backpressure, so a ten-thousand-line build transmits one screen update, not ten thousand lines. Contributes the output-volume fix: the viewer stops waiting on a backlog of bytes it will never read.

## Dependencies & sequencing

- **Subtasks are independent on the file level** and can land in any order; the sequencing below is a soft preference, not a hard dependency.
- **Prerequisite guard:** the output-coalescing plan's prerequisite (restoring the send queue and backpressure the retired TS gateway had) must land before the screen model has a trigger.
- **That prerequisite is being built elsewhere (2026-09-18).** `The Go PTY host has no
  coalescing window — add a link-aware one` (`e05303a4`, in feature `94aa8b26`) adds the
  per-terminal send queue, the coalescing window and the flush tick to
  `cmd/switchboard-pty-host` — substantially change 0 of
  `The Terminal Streams Every Byte…`. **Do not dispatch `ac14e43b` until `e05303a4`
  has landed**, or two plans build the same send queue in the same file. Once it has,
  `ac14e43b` re-scopes to the screen model plus the high/low water marks `e05303a4`
  does not add. See the note at the head of that plan.

## Team Dispatch Instructions

### Terminal logs keep every blank run and every immediately-repeated line
- **Seat:** Intern (Complexity 2)
- **Acceptance:**
  - A line equal to its immediate predecessor is dropped; a line equal to a non-adjacent earlier line is kept; a blank run collapses to exactly one blank line.
  - The predecessor is carried across a `publish()` boundary and reset on session roll/close; dispatch headings are never collapsed into a neighbour.
  - ~13% fewer bytes on a captured duplicate-heavy stream; the change is in `log.go` and both hosts get it via the Go pty host.
- **Must not touch:** the ANSI stripper, the fence-safety logic, the 10 MiB rotation cap; do not add carriage-return collapse (separate scope).

### The Terminal Streams Every Byte, Including Output That Has Already Scrolled Away
- **Seat:** Lead Coder (Complexity 7)
- **Acceptance:**
  - A ten-thousand-line command leaves the viewer's final screen byte-identical to a full replay, while transmitting a small fraction of the bytes.
  - A terminal keeping up transmits byte-for-byte (coalescing inactive below the water mark); a progress bar animates rather than jumping.
  - The session log contains the complete byte stream regardless of coalescing; the coalescing/backpressure layer and the screen model both live in `cmd/switchboard-pty-host`.
- **Must not touch:** the session log (logging is not a viewport — the full stream is always logged); the client-side prediction layer and the client batch machinery in `terminalViewport.js` (both owned by feature `94aa8b26`, not by this one); do not alter output on a healthy link.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Terminal Buffer Snapshot API — `GET /terminals/:name/buffer`](../plans/feature_plan_20260818180000_terminal-buffer-snapshot-api.md) — **PLAN REVIEWED** — ID: a2eb60fa-72d8-4643-85e6-1ab24e98b676
- [ ] [Terminal logs keep every blank run and every immediately-repeated line](../plans/terminal-logs-keep-every-blank-run-and-repeated-line.md) — **PLAN REVIEWED** — ID: 77bc8f5c-e7d5-400f-b081-d03141394bd7
- [ ] [The Terminal Streams Every Byte, Including Output That Has Already Scrolled Away](../plans/the-terminal-streams-every-byte-including-output-already-scrolled-away.md) — **PLAN REVIEWED** — ID: ac14e43b-aa8a-4dec-b223-3f24f34b2cb2
- [ ] [Terminal Logs Record Every Repaint, Not Every Event](../plans/terminal-logs-record-every-repaint-not-every-event.md) — **PLAN REVIEWED** — ID: b6bc1534-67f7-43aa-842b-8103606cb47d
<!-- END SUBTASKS -->

[Terminal Logs Record Every Repaint, Not Every Event](../plans/terminal-logs-record-every-repaint-not-every-event.md) — **PLAN REVIEWED** — ID: b6bc1534-67f7-43aa-842b-8103606cb47d

