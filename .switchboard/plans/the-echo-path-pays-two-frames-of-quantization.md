# A keystroke echo waits on two frame boundaries it does not need

## Goal

Deliver a small, lone output frame straight to xterm instead of holding it for the next animation
frame, and scale the gateway's coalescing window to the link instead of to a 60 Hz local renderer —
removing roughly 20-35 ms from every keystroke on a remote board without touching the batching that
bulk output depends on.

### Problem Analysis

Per keystroke, on top of the actual network round trip, the current path adds:

| Stage | Cost |
| :--- | :--- |
| Gateway coalesce — shared `setInterval(OUTPUT_FLUSH_MS = 6)` | ~3 ms mean |
| Client `scheduleBatchFlush` waits for `requestAnimationFrame` | ~8 ms mean, 17 ms worst |
| `term.write()` → `WriteBuffer` parse → renderer paints next frame | ~8-17 ms |

Two of those three are frame quantizations, and neither is needed for the case in question. A
keystroke echo is a handful of bytes arriving alone; batching it with nothing costs a frame and saves
nothing. `scheduleBatchFlush` is unconditional (`terminals.js:10677`) — every frame, however small,
waits for the shared rAF.

**The batching itself is correct and must stay.** Its own rationale is on the record: forwarding every pty
read as its own frame "made the browser pay a JSON.parse + decode + xterm write per chunk — the
dominant cost in the webview". Under a firehose, coalescing is the reason the pane is usable. The
defect is that the *only* policy is the firehose policy.

**And `OUTPUT_FLUSH_MS` was chosen against the wrong client.** Its comment says so plainly: "~6ms is
under one 60Hz frame, so coalescing never costs a rendered frame of latency: the client rAF-batches
writes anyway." That reasoning is sound for a loopback client and wrong for a 40 ms-RTT tunnel, where
the flush fires roughly seven times more often than the link can benefit from — paying per-frame
overhead, and (with compression) denying deflate the larger frames it works best on.

### Root Cause

Both constants were tuned for a same-machine client where latency is dominated by rendering, not by
transit. Nothing in either path asks how far away the client actually is, even though the gateway
already exchanges ping/pong with it and could answer that question.

### Non-goals

- **Do not remove rAF batching.** Bulk output must keep coalescing; only a small lone frame takes the
  fast path.
- **Do not lower `OUTPUT_FLUSH_MS` for a local client.** 6 ms is right for loopback; this plan makes
  it adaptive upward, never downward.
- **Do not add an input-side prediction or local echo.** Predictive echo is a separate, riskier idea
  and is explicitly out of scope here.
- No new gateway constructor argument or setter — see Both Hosts.

## Metadata

**Topic:** Fast path for small lone frames, and link-aware output coalescing
**Complexity:** 5
**Tags:** terminals, performance, remote, webview, backend

## User Review Required

None. Both thresholds and the RTT source are specified below.

## Dependencies

None. Recommended to land after
`terminal-websockets-cross-every-link-uncompressed.md`, because the adaptive window changes frame
sizes and the two should be measured together rather than separately attributed.

## Both Hosts

Both changes live in shared files — `terminals.js` (the client, served by both hosts) and
`terminalWsGateway.ts` (constructed at `bootstrap.ts:3202` in-process and at `ptyHost.ts:46` as the
extension's sidecar). Neither requires wiring at either root, which is deliberate: a two-call-site
seam is the known trap here, evidenced by `setBindPolicy` being wired in `bootstrap.ts:3599` and
nowhere in `ptyHost.ts`.

The extension's client connects over loopback, so the adaptive window must resolve to today's 6 ms
there. That is the regression fence, not an afterthought.

## Proposed Changes

**1. Client fast path for a small lone frame (`terminals.js`).**

In the socket's message handler, before `scheduleBatchFlush`: if the entry's `batchQueue` is empty,
no rAF flush is already pending for it, and the incoming payload is under a small ceiling
(**512 chars**), write it immediately via the same code path `flushBatch` uses — preserving the
`onWriteParsed` callback so ack accounting is unchanged.

Anything else — a queue already forming, a larger frame, a burst — falls through to today's exact
behaviour. Under load the first frame takes the fast path and the rest coalesce, which is the correct
shape: latency for the first byte, throughput for the rest.

**2. Link-aware coalescing window (`terminalWsGateway.ts`).**

Derive a per-terminal flush window from the *slowest attached client's* observed RTT, measured from
the existing ping/pong exchange (`PING_INTERVAL_MS`, and the `'ping'`/`pong` handler already in the
message switch). Clamp it: floor at today's `OUTPUT_FLUSH_MS` (6 ms), ceiling at 40 ms. With no RTT
observed yet, use the floor — an unmeasured client must behave exactly like today.

Take the **slowest** client, not the mean: a local client attached alongside a remote one must not
have its window stretched invisibly, and the min/max choice is the same kind of decision
`reconcileTerminalSize` already makes explicitly for size votes.

**3. Keep the flush timer shared.**

`sharedFlushInterval` drives every terminal from one `setInterval`, which is why a blocking observer
would stall them all. Do not fan it out into a timer per terminal. Implement the per-terminal window
as a "not before" stamp checked inside `flushAllPending`, leaving one timer at the floor interval.

**4. Record the window that was used.**

Expose the resolved window per terminal (alongside the existing stats) so "why is this pane sluggish"
is answerable after the fact rather than by re-deriving RTT. A tuning value that changes behaviour and
cannot be read back is the shape of bug this codebase keeps paying for.

## Verification Plan

1. Measure keystroke echo latency on a tailnet board before and after. Expect a reduction of roughly
   one to two frame times; record the actual numbers.
2. Measure the same on a loopback board. It must not regress, and the resolved window must read 6 ms.
3. Paste 40 KB into a pane. Rendering stays coalesced — assert the fast path did **not** fire per
   chunk by checking that frame count at the client is unchanged from today.
4. Run a firehose (`yes`-style) and confirm the pane stays responsive and `MAX_FLUSH_BYTES` still
   caps a frame.
5. Attach a local and a remote client to the same terminal. Confirm the window resolves to the remote
   client's value and that detaching the remote one returns it to the floor.
6. Ack accounting: `pendingAckChars` / `ackSuppressChars` behave identically, and a replay's
   suppression budget is still burned correctly — the fast path must go through `onWriteParsed`.
7. Answerback suppression during replay still works: the fast path must not bypass
   `entry.suppressAnswerback`, which is cleared in the write callback.
8. **Both hosts:** run 1, 2 and 3 against standalone and the extension's pty-host sidecar.

### Goal Invariants

- Assert the client fast path fires only when the batch queue is empty and no flush is pending.
- Assert the fast path invokes `onWriteParsed` with the written length.
- Assert the fast path does not run while `suppressAnswerback` is set for that entry.
- Assert the resolved coalescing window is never below `OUTPUT_FLUSH_MS` and never above 40 ms.
- Assert a terminal with no RTT observation uses the floor.
- Assert `sharedFlushInterval` remains a single timer for all terminals.
- Assert the resolved window is readable per terminal for diagnosis.
