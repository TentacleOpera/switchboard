# Typing on a Remote Board Should Not Wait on the Link

**Complexity:** 7

## Goal

Input latency, not output throughput. Every keystroke in a Switchboard terminal currently waits out a full network round trip plus two local frame boundaries before the character appears. On the operator's own link that is 53 ms mean with 64 ms of jitter, and the jitter is what makes typing feel broken rather than merely slow. This feature holds the two changes that address the keystroke path specifically: predicting the echo so the round trip stops being visible, and removing the frame quantization so the confirmation lands cleanly. The goal is a remote terminal that types like mosh over the same wifi.

## How the Subtasks Achieve This

- **A Remote Terminal Round-Trips Every Keystroke — Add Predictive Local Echo** (`1ee5b5fa`): renders a typed character locally the moment it is typed, as a DOM overlay marked unconfirmed — never as bytes injected into the xterm buffer — and reconciles against the PTY's authoritative echo when it arrives. The round trip still happens; the operator stops waiting on it. Ungated by link (decided 2026-09-17), and explicitly blind in alternate-screen mode, under the hidden-input gate, and mid-escape-sequence, where a guess would be visible garbage. This is the head of the path and the one that changes how typing feels.
- **A keystroke echo waits on two frame boundaries it does not need** (`a8f75f5d`): delivers a small lone output frame straight to xterm instead of holding it for the next animation frame, removing ~8-17 ms of client rAF quantization per keystroke. Also extracts `writeLiveChars`, the single live-write seam the prediction plan's reconciler hooks.
- **The Go PTY host has no coalescing window — add a link-aware one** (added 2026-09-17): the throughput half of `a8f75f5d`, re-aimed at the real gateway. The Go pty host sends every pty chunk as its own frame — zero hold for keystrokes, worst-case shape for bulk output on a remote link. This plan adds a coalescing window sized by measured client RTT, with a lone-frame bypass so the window can never hold a keystroke echo. Server-side; independent of the other two.

They are complementary, not alternatives: prediction hides the network, de-quantization makes the confirmation land cleanly, and the Go-side window keeps bulk output efficient on the link without ever delaying a lone echo.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [A keystroke echo waits on two frame boundaries it does not need](../plans/the-echo-path-pays-two-frames-of-quantization.md) — **CODE REVIEWED** — ID: a8f75f5d-f377-482a-8ca0-99e4686b99cf
- [ ] [A Remote Terminal Round-Trips Every Keystroke — Add Predictive Local Echo](../plans/a-remote-terminal-round-trips-every-keystroke-add-predictive-local-echo.md) — **CODE REVIEWED** — ID: 1ee5b5fa-9776-4c61-9bf9-808bafa379a1
- [ ] [The Go PTY host has no coalescing window — add a link-aware one](../plans/the-go-pty-host-has-no-coalescing-window-add-a-link-aware-one.md) — **CODE REVIEWED** — ID: e05303a4-687f-42e0-af7e-d0e256d18bf4
<!-- END SUBTASKS -->

## Dependencies & sequencing

**Sequencing (updated 2026-09-17):** `a8f75f5d` (client fast path) lands **first** — it extracts
`writeLiveChars`, the single seam where live bytes meet xterm, and `1ee5b5fa`'s reconciler hooks
that seam. The Go coalescing plan is independent of both and can land in any order; it is
server-side while the other two are client-side.

**The CPU-attribution parking is lifted (2026-09-17).** `a8f75f5d` previously carried a PARKED banner holding it behind *Attribute Switchboard's CPU before optimising it* (`1023d997`). That plan is in Reviewed and the numbers exist, so the banner has been removed from the plan file. Do not re-park it.

**No RTT measurement feeds prediction.** `1ee5b5fa` predicts unconditionally — the RTT gate was removed on 2026-09-17, because a gate that hides a reconciliation bug on the local board and silently resolves to "prediction off" when unmeasured is worse than no gate. Its Proposed Change 3 says so explicitly.

RTT probes exist only in the Go coalescing plan, **only** to size the adaptive window — a different mechanism for a different purpose, and it does not gate prediction. Read the set together as: *nothing decides whether to predict by measuring the link.*

**The gateway the old plan targeted is retired.** `terminalWsGateway.ts` is dead code — nothing constructs it in either host; both proxy terminal sockets to `cmd/switchboard-pty-host`, which has no coalescing window at all. `a8f75f5d`'s gateway half was therefore split into the Go plan rather than deleted: the intent (link-aware window, RTT probes, lone-frame bypass, `flushWindow` read-back) survives there, translated to the real surface.

**Code references now point at `terminalViewport.js`.** `scheduleBatchFlush` (:1000), both frame
handlers (:2054 binary, :2086 legacy `t:'out'`), `writeLiveChars`'s future home beside `flushBatch`
(:1031), `BATCH_FALLBACK_MS` (:227), and `term.onData` (:1645). The diagnostic dump stayed in
`terminals.js` (`__sbTerminalStats`, :11237). The fast path declines whenever the entry is in
`pendingBatchEntries`, which is what keeps queued bytes from stranding behind the fallback timer.

## Team Dispatch Instructions

### A keystroke echo waits on two frame boundaries it does not need

- **Seat:** coder
- **Acceptance:**
  - In `terminalViewport.js`, both the binary and legacy `t:'out'` arms write a lone frame directly via `writeLiveChars` when the queue is empty, no flush is pending, the payload is under 512 chars, and no replay is in flight — stamping and `bumpStartupCurtain` still run on both paths.
  - `writeLiveChars` is the only call site writing live output to `entry.term`; `writeReplay` keeps its own path.
  - `__sbTerminalStats` reports `fastPathWrites`; a 40 KB paste does not increment it per chunk.
  - No changes under `src/standalone/` or `cmd/` — the gateway half moved to the sibling plan.
- **Must not touch:** `cmd/switchboard-pty-host/*`, `src/standalone/terminalWsGateway.ts`, the `term.onData` input path (the sibling's surface). Do not add rAF removal or prediction.

### The Go PTY host has no coalescing window — add a link-aware one

- **Seat:** lead
- **Acceptance:**
  - A lone chunk under 512 bytes on an empty queue flushes immediately — no timer, no `notBefore`.
  - The window applies only when a queue is forming (`len(parts) > 1`), clamped 6–40 ms, resolved from max client RTT; unmeasured clients get the floor.
  - `{t:'ping',ts}` → `{t:'pong',ts}` round-trips; `{t:'rtt',ms}` updates `wsClient.rttMs`; `hello` carries `flushWindow` and changes push `{t:'flushWindow',ms}`.
  - `__sbTerminalStats` shows `lastRttMs`/`flushWindowMs`, null when unobserved; loopback resolves to the floor.
  - `f.close` drains pending output before deleting terminal state.
- **Must not touch:** `src/webview/terminalViewport.js` batch machinery beyond the probe/pong/flushWindow arms and diagnostic fields; the retired `terminalWsGateway.ts`; prediction code.

### A Remote Terminal Round-Trips Every Keystroke — Add Predictive Local Echo

- **Seat:** lead
- **Acceptance:**
  - A typed printable character renders immediately as an unconfirmed overlay glyph on a 50 ms+ link; the display converges on the PTY's bytes.
  - Predictions never pass through `term.write`; they live only in the DOM overlay.
  - No prediction in alternate-screen mode, under the hidden-input gate, mid-escape-sequence, for non-printable input, or per-character on paste.
  - Reconciliation hooks `writeLiveChars` only and drops overlay glyphs in the write callback, not at hand-off — no visible flicker or one-frame hole.
  - No RTT probe or latency gate anywhere in the prediction path.
- **Must not touch:** `terminals.js` (no duplicate prediction layer), `writeReplay`, `cmd/` — prediction is client-side only. Land after the `a8f75f5d` seam exists.

## Review Findings

Reviewed 2026-09-19 as one delivery unit across `d6df5cdf` (fast path), `f0ba3aef` (prediction) and `388a9aea` (Go coalescing). Files changed in this review pass: `src/webview/terminalViewport.js` (one CRITICAL and three MAJOR fixes, all in the prediction layer), `src/test/terminal-flow-control-contract.test.js` and `src/test/terminal-content-free-collapse-contract.test.js` (two CI-wired gates that the fast-path commit had turned red or made vacuous), and `src/test/terminals-panel-payload-contract.test.js` (byte budget raised 1100→1145 KB with an itemised note). The CRITICAL was that the predictive-echo overlay was a 0×0 `overflow:hidden` box that clipped every predicted glyph out of existence — the feature's whole visible effect rendered nothing. Validation: `go build`/`vet`/`gofmt`/`go test` clean, `node --check` and `compile-tests` (tsc) and eslint clean, 22/35 terminal contract suites pass with all 13 remaining failures individually confirmed pre-existing by re-running each against the pre-feature source. Remaining risk: nothing in CI discriminates on whether prediction actually predicts, reconciles or converges, and `go test -race` cannot run on this Pi, so the feature's core mechanisms rest on manual verification that was not performed.

## Deferred Findings

- MAJOR — the panel first-load byte budget was **already breached by 2.5 KB before this feature** (1102.5 KB against the 1100 KB line). This feature's +27.7 KB is itemised in the note at `src/test/terminals-panel-payload-contract.test.js`, but that pre-existing 2.5 KB of unattributed re-accretion is not this feature's and is still owed an explanation.
- MAJOR — the feature's core mechanisms have no automated discriminating check. Every latency and correctness claim (echo appears before the PTY confirms, display converges, no flicker, coalescing actually coalesces, lone frames are never held) is manual-only, and no manual verification ran in this pass. Passing the contract suites is not evidence any of it works.
- See each subtask plan's own `## Deferred Findings` for the per-plan items.
