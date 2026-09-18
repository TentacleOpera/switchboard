# A keystroke echo waits on two frame boundaries it does not need

## Goal

Deliver a small, lone output frame straight to xterm instead of holding it for the next animation
frame — removing roughly 8–17 ms (one rAF cycle) from every keystroke's echo without touching the
client-side batching that bulk output depends on.

### Problem Analysis

Per keystroke, on top of the actual network round trip, the echo path crosses:

| Stage | Cost |
| :--- | :--- |
| Client `scheduleBatchFlush` waits for `requestAnimationFrame` | ~8 ms mean, 17 ms worst |
| `term.write()` → `WriteBuffer` parse → renderer paints next frame | ~8-17 ms |

> **Superseded (2026-09-17):** the original analysis carried a third row — "Gateway coalesce —
> shared `setInterval(OUTPUT_FLUSH_MS = 6)`, ~3 ms mean" — and this plan's second half built an
> adaptive coalescing window plus RTT measurement inside `src/standalone/terminalWsGateway.ts`.
> **Reason:** `TerminalWsGateway` is retired — its own doc comment (`terminalWsGateway.ts:392-403`)
> says "do not construct in production"; `ptyHost.ts` is a stub that throws; nothing in
> `bootstrap.ts` constructs it. Both hosts proxy `/ws/terminal` upgrades to the Go pty host
> (`cmd/switchboard-pty-host`), whose `routeOutput` (main.go:920) sends every pty chunk as its own
> binary frame with **no coalescing window at all**. There is no gateway hold to remove for
> keystrokes, and no existing window to scale — building one is throughput work, not this feature's
> latency goal. Every line reference in the original gateway sections was dead code.
> **Replaced with:** the gateway half is split into a sibling plan,
> `the-go-pty-host-has-no-coalescing-window-add-a-link-aware-one.md`, which carries the RTT probe /
> adaptive window / lone-frame-bypass design forward against `cmd/switchboard-pty-host`. This plan
> keeps only the client fast path, which is where the remaining frame quantization actually lives.

Two of those three are frame quantizations, and neither is needed for the case in question. A
keystroke echo is a handful of bytes arriving alone; batching it with nothing costs a frame and saves
nothing. `scheduleBatchFlush` is unconditional (`terminalViewport.js:1000`) — every frame, however
small, waits for the shared rAF.

**The batching itself is correct and must stay.** Its own rationale is on the record: forwarding every pty
read as its own write "made the browser pay a decode + xterm write per chunk — the
dominant cost in the webview". Under a firehose, coalescing is the reason the pane is usable. The
defect is that the *only* policy is the firehose policy.

**The second boundary is xterm-internal and stays.** `term.write()` parses through `WriteBuffer` and
the render debouncer paints on the next frame — there is no public API to force a synchronous paint,
and reaching into xterm internals to get one is not worth it for the remaining ~8-17 ms. This plan
removes the rAF boundary; the prediction sibling (`1ee5b5fa`) is what makes the whole wait invisible.

### Root Cause

The client write path was tuned for bulk output: one shared rAF drains every terminal's queue, which
is optimal under load and pure latency for a lone echo. Nothing in the path asks whether the frame is
small and the queue empty — the two facts that make batching pointless.

### Non-goals

- **Do not remove rAF batching.** Bulk output must keep coalescing; only a small lone frame takes the
  fast path.
- **Do not bypass xterm's WriteBuffer or render debouncer.** The fast path still goes through
  `term.write` — it skips our rAF, not xterm's internals.
- **Do not add an input-side prediction or local echo.** Predictive echo is the sibling plan
  `1ee5b5fa` and is explicitly out of scope here.
- **No server-side changes.** The Go pty host already forwards every chunk immediately; any
  coalescing-window work there is the sibling plan named above, not this one.

## Metadata

**Topic:** Fast path for small lone frames in the client write path
**Complexity:** 4
**Tags:** performance, frontend, reliability

## User Review Required

None. The threshold is specified below.

## Complexity Audit

### Routine
- Client fast path: single file (`terminalViewport.js`), reuses `flushBatch`'s `term.write` +
  `onWriteParsed` code path, extracted as a shared seam. Conditions are boolean checks on existing
  entry fields.
- Diagnostic counter: one additional field in `__sbTerminalStats`.

### Complex / Risky
- Ordering: a fast-path write must never overtake bytes already queued in `batchQueue` or already
  scheduled for a rAF flush. The guard conditions below exist precisely to make overtake impossible.
- The fast path bypasses `scheduleBatchFlush`, which currently calls `deps.bumpStartupCurtain` — the
  fast path must call it directly or the startup curtain will not arm for lone-echo terminals.
- The fast path must apply to both the binary frame handler and the legacy `t:'out'` text handler,
  or a browser tab left open across a downgrade will not benefit.
- `writeLiveChars` becomes the seam the predictive-echo sibling hooks — name it, keep it single.

## Edge-Case & Dependency Audit

**Race Conditions:**
- *Fast path during replay write:* If a live frame arrives while `entry.suppressAnswerback` is true
  (a replay write is mid-parse), the fast path declines to the normal path. xterm's `WriteBuffer`
  queues writes in order, so even if it did fire, ordering would be preserved — but declining is the
  conservative choice and prevents the fast path from firing inside the replay window.
- *Fast path vs. queued batch:* Guarded by `entry.batchQueue.length === 0 &&
  !pendingBatchEntries.has(entry)`. If anything is queued or scheduled for this entry, the frame
  joins the batch — a fast-path write can never reorder against pending output.
- *Back-to-back lone frames:* The first takes the fast path (never enters the queue), so the second
  also sees an empty queue and takes the fast path. xterm's `WriteBuffer` serialises both in order.
- *`BATCH_FALLBACK_MS` timer:* The shared 200 ms fallback (`terminalViewport.js:227`, armed in
  `scheduleBatchFlush` at :1010) is armed by *scheduling*, not by arrival. A fast-path frame never
  schedules, so it neither arms nor strands the timer; a timer armed by other entries still drains
  them normally. The `!pendingBatchEntries.has(entry)` guard is what keeps this entry's own queued
  bytes from sitting behind a fallback timer while a newer frame jumps past via the fast path.

**Security:** No security implications. No new wire traffic, no new fields on the socket.

**Side Effects:**
- The fast path bypasses `scheduleBatchFlush`, which calls `deps.bumpStartupCurtain(entry.name)`
  (line 1002). The fast path must call `deps.bumpStartupCurtain` directly.
- The fast path does not add the entry to `pendingBatchEntries` and does not arm the rAF or the
  fallback timer. That is the point — but it means all three stamping/bump side effects of the
  normal path must be reproduced explicitly.

**Dependencies & Conflicts:**
- Shares `terminalViewport.js` with the predictive-echo sibling (`1ee5b5fa`). **This plan lands
  first**: it introduces `writeLiveChars`, the single seam where live bytes meet xterm, and the
  sibling's reconciliation hooks that seam rather than the two call sites separately.

## Dependencies

None.

## Both Hosts

The change is confined to `src/webview/terminalViewport.js` — the shared viewport module both hosts
serve (browser cockpit and extension webview both reach it through
`window.SwitchboardTerminalViewport.create`). No composition-root wiring exists to diverge: there is
no new service, no new constructor argument, no new setter. One implementation, both hosts, by
construction.

## Adversarial Synthesis

Key risks: (1) an out-of-order write if a frame takes the fast path while this entry has bytes queued
or a flush scheduled — prevented by checking both `batchQueue.length === 0` and
`!pendingBatchEntries.has(entry)` before writing; (2) the startup curtain and silence-signal timers
silently not armed because the fast path bypassed `scheduleBatchFlush` — prevented by calling
`deps.bumpStartupCurtain` and the stamping block explicitly; (3) the legacy `t:'out'` arm forgotten —
a downgrade-tab would keep paying the rAF. Mitigations: the guard set is applied identically in both
handlers via the same condition block, and `writeLiveChars` is the only write call so ack accounting
cannot diverge.

## Proposed Changes

### `src/webview/terminalViewport.js` — Extract `writeLiveChars`, the single live-write seam

**Context:** `flushBatch` (line 1031) joins `entry.batchQueue` and calls
`entry.term.write(combined, () => onWriteParsed(entry, combined.length))` inside a try/catch that
increments `writeThrowCount` (lines 1044–1051). `writeReplay` deliberately has its own write path and
must NOT share this seam — replay is not live output, carries the suppression window, and is not
billed to the ack ledger the same way.

**Logic:** Extract the write + callback + throw accounting into:

```js
function writeLiveChars(entry, text) {
    try {
        entry.term.write(text, () => onWriteParsed(entry, text.length));
    } catch (err) {
        entry.writeThrowCount = (entry.writeThrowCount || 0) + 1;
        console.error(`[Terminals] term.write failed for terminal ${entry.name}:`, err);
    }
}
```

`flushBatch` calls it after the join. This seam exists so the predictive-echo sibling hooks ONE
place; do not add a second `term.write` call site for live output.

### `src/webview/terminalViewport.js` — Client fast path for a small lone frame

**Context:** The binary frame arm (`ws.onmessage`, ~line 2025; live-data path at ~2054–2071) and the
legacy `t:'out'` arm (~line 2076–2097) both push to `entry.batchQueue` and then call
`scheduleBatchFlush(entry)`, which unconditionally waits for a shared `requestAnimationFrame` —
costing ~8–17 ms even for a lone 3-byte echo.

**Logic:** In the binary arm the fast-path check goes *after* the `awaitingReplayFrame` early-return
(line 2040–2053 — replay frames keep their own write path) and *before* `entry.batchQueue.push(text)`.
The live-frame stamping (`firstFrameAt`/`lastFrameAt`/`lastPrintableAt`/`clearWorkingSilence`,
lines 2062–2070) must run on BOTH paths, so hoist it ahead of the check. Then:

```
// Fast path: lone small frame, nothing queued, no flush pending, no replay in flight
if (entry.batchQueue.length === 0
    && !pendingBatchEntries.has(entry)
    && text.length < 512
    && !entry.suppressAnswerback
    && entry.term && !entry.disposed && !entry.suspended) {
    deps.bumpStartupCurtain(entry.name);
    entry.fastPathWrites = (entry.fastPathWrites || 0) + 1;
    writeLiveChars(entry, text);
    return;
}

// Normal path
entry.batchQueue.push(text);
scheduleBatchFlush(entry);
return;
```

Apply the identical block to the legacy `t:'out'` arm, checked against `rawData`, placed after its
stamping block and before `entry.batchQueue.push(rawData)` (line 2086).

Conditions, and why each exists:
1. `entry.batchQueue.length === 0` — nothing already queued from a prior frame (ordering).
2. `!pendingBatchEntries.has(entry)` — no rAF flush already holding this entry's bytes (ordering;
   also what keeps queued bytes from sitting behind the fallback timer while a new frame jumps past).
3. `text.length < 512` — the payload is under the small-frame ceiling.
4. `!entry.suppressAnswerback` — no replay write is in progress.
5. `entry.term && !entry.disposed && !entry.suspended` — same writability gate `flushBatch` applies.

If any condition fails, fall through to today's exact behaviour: push to `batchQueue`, call
`scheduleBatchFlush`.

**Edge Cases:**
- *Two lone frames arrive back-to-back:* both take the fast path; `WriteBuffer` serialises them in
  order. Correct — two small frames are still small.
- *Lone frame then a burst:* the first takes the fast path; a >512-char frame or a non-empty queue
  sends the rest down the normal path. Latency for the first byte, throughput for the rest.
- *Frame arrives mid-replay:* `suppressAnswerback` is set → declines to the normal path, which queues
  behind the replay inside `WriteBuffer`. Correct.
- *Frame arrives while a flush is scheduled but not yet run:* `pendingBatchEntries` contains the
  entry → declines to the normal path. The frame joins the pending batch; ordering preserved.
- *Background tab:* rAF does not fire in occluded tabs — that is what `BATCH_FALLBACK_MS` covers for
  the normal path. The fast path needs no fallback: it never waits on either timer.

### `src/webview/terminals.js` — Diagnostic surface

**Context:** `__sbTerminalStats` (line 11237) already reports `batchQueueLength`, `pendingAckChars`,
`bytesWritten`, `writeThrowCount` per entry.

**Logic:** Add `fastPathWrites: entry.fastPathWrites || 0`. A latency feature whose effect cannot be
read back is the shape of bug this codebase keeps paying for; the counter is how "did the fast path
fire" is answered from the diagnostic dump instead of by re-deriving it.

## Verification Plan

1. Measure keystroke echo latency on a tailnet board before and after. Expect a reduction of roughly
   one frame time (~8-17 ms); record the actual numbers.
2. Measure the same on a loopback board. It must not regress.
3. Paste 40 KB into a pane. Rendering stays coalesced — assert the fast path did **not** fire per
   chunk (frame count / `fastPathWrites` unchanged for the burst).
4. Run a firehose (`yes`-style) and confirm the pane stays responsive — the rAF batch still
   coalesces; `fastPathWrites` stays flat while `batchQueueLength` cycles.
5. Ack accounting: `pendingAckChars` / `ackSuppressChars` behave identically, and a replay's
   suppression budget is still burned correctly — the fast path goes through `onWriteParsed` via
   `writeLiveChars`.
6. Answerback suppression during replay still works: the fast path must not fire while
   `entry.suppressAnswerback` is set; the frame declines to the normal path and queues behind the
   replay via `WriteBuffer`.
7. Startup curtain: a terminal whose first output is a lone echo (fast path) still arms and
   dismisses the startup curtain — `deps.bumpStartupCurtain` is called in the fast path.
8. Legacy text frames: with a server speaking the `t:'out'` protocol, confirm the fast path still
   fires for small lone frames.
9. Ordering: with a batch queued (throttled flush) and a new small frame arriving, the new frame
   joins the batch — `batchQueueLength` grows rather than the frame jumping ahead.

### Goal Invariants

- Assert the client fast path fires only when `entry.batchQueue.length === 0`,
  `!pendingBatchEntries.has(entry)`, `text.length < 512`, `!entry.suppressAnswerback`, and
  `entry.term && !entry.disposed && !entry.suspended`.
- Assert the fast path writes via `writeLiveChars(entry, text)`, which invokes
  `onWriteParsed(entry, text.length)` from the `term.write` callback.
- Assert the fast path calls `deps.bumpStartupCurtain(entry.name)` directly.
- Assert the fast path does not push to `entry.batchQueue` and does not call `scheduleBatchFlush`.
- Assert the fast path is present in both the binary frame handler and the legacy `t:'out'` handler.
- Assert live-frame stamping (`firstFrameAt`/`lastFrameAt`/`lastPrintableAt`/`clearWorkingSilence`)
  runs on the fast path and the normal path alike.
- Assert `writeLiveChars` is the only call site that writes live output to `entry.term` —
  `writeReplay` retains its own path.
- Assert `sharedBatchRafId` and `sharedBatchFallbackTimer` remain single shared timers (no
  per-terminal timer introduced).
- Assert `__sbTerminalStats` exposes `fastPathWrites` per terminal.

## Outstanding Questions

- **[user]** The 512-char ceiling for the fast path is a design choice — a keystroke echo is
  typically 1–10 bytes, but 512 chars allows a small prompt redraw or ANSI sequence through.
  Proceeding on the assumption that 512 is the right ceiling; adjust if measurement shows it should
  be lower (e.g., 128) to avoid mid-prompt coalescing breaks.

## Implementation Summary (2026-09-18)

Done. `writeLiveChars(entry, text)` extracted in `src/webview/terminalViewport.js` as the single live-write seam (term.write + `onWriteParsed` + `writeThrowCount` accounting); `flushBatch` now calls it after the join, and `writeReplay` keeps its own path. The fast-path guard block (`batchQueue` empty, `!pendingBatchEntries.has(entry)`, `<512` chars, `!suppressAnswerback`, writable term) lands identically in both the binary frame arm and the legacy `t:'out'` arm, with live-frame stamping hoisted ahead of it and `deps.bumpStartupCurtain` + `fastPathWrites` called explicitly on the fast path. `fastPathWrites` initialized on the entry and exposed via `__sbTerminalStats` in `src/webview/terminals.js`. `node --check` passes on both files; runtime verification items remain as written (skipped per dispatch directive).
