# Every terminal WebSocket crosses the link uncompressed, and terminal output is the most compressible traffic there is

## Goal

Enable permessage-deflate on the terminal WebSocket above a size threshold, so a remote board pays
roughly a seventh of the bytes for the same screen while a keystroke echo stays uncompressed.

### Problem Analysis

`ws` defaults `perMessageDeflate` to **false**, and every server in the codebase takes that default:

- `terminalWsGateway.ts:393` — `new WebSocketServer({ noServer: true })`
- `wsHub.ts:177` and `:223` — the control-plane hub, same

So terminal output — the single largest traffic class Switchboard produces — crosses the wire
verbatim. On a tailnet or any WireGuard tunnel nothing else compresses it either.

**Measured, not assumed.** 400 KB taken from a real session log
(`.switchboard/logs/Coding-mtfqqy7v-da8a5n.md`) compresses to 58.7 KB at `gzip -6` — **6.8:1**. That
sample is already ANSI-stripped by `terminalLogWriter`, so it is a *floor*: raw wire traffic carries
repeated CSI runs and identically repainted rows, which compress better than the stripped text does.

**The reason this is not simply "turn it on".** Deflate has per-message overhead that a 3-byte
keystroke echo cannot amortise — compressing it costs CPU and can enlarge the frame. So a blanket
enable trades bulk throughput for typing latency, which is the wrong trade on the one path the
operator feels most.

### Root Cause

The gateway was written and tuned against a loopback client, where bandwidth is free and CPU is not.
`OUTPUT_FLUSH_MS = 6` carries that assumption in its own comment ("~6ms is under one 60Hz frame").
Compression is the inverse trade, and it was never revisited when the board became reachable over a
tunnel.

### Non-goals

- **Not the control-plane hub.** `wsHub.ts` carries small JSON pushes where deflate would be mostly
  overhead. Its two construction sites are noted above for completeness only; leave them alone.
- Not a change to `OUTPUT_FLUSH_MS` or the coalescing window — see
  `the-echo-path-pays-two-frames-of-quantization.md`.
- Not a compression scheme of our own. Standard permessage-deflate, negotiated by the client, or
  nothing.

## Metadata

**Topic:** permessage-deflate on the terminal WebSocket, above a size threshold
**Complexity:** 3
**Tags:** terminals, performance, remote, standalone, backend

## User Review Required

None. Threshold and deflate parameters are specified below.

## Dependencies

None.

## Both Hosts

The `WebSocketServer` is constructed **inside** `TerminalWsGateway` (`:393`), and that class is shared
by both composition roots — standalone in-process (`bootstrap.ts:3202`) and the extension's pty-host
sidecar (`ptyHost.ts:46`). So this change reaches both hosts with no wiring, which is the reason to
make it in the constructor options rather than as a settable seam. Do not add a setter: `setBindPolicy`
is wired at `bootstrap.ts:3599` and nowhere in `ptyHost.ts`, which is what a two-call-site seam looks
like after a year.

The extension host benefits less in practice (its page connects to `ws://127.0.0.1:<port>`), but it
must not regress, and the CPU cost lands there too.

## Proposed Changes

**1. Enable deflate with a threshold (`terminalWsGateway.ts:393`).**

```
new WebSocketServer({
    noServer: true,
    perMessageDeflate: {
        threshold: 1024,            // below this, send uncompressed
        zlibDeflateOptions: { level: 6, memLevel: 8 },
        concurrencyLimit: 10,
        serverNoContextTakeover: false,   // keep the window across frames
    },
})
```

`threshold` is the load-bearing option: frames under it — every keystroke echo, every cursor wiggle —
skip deflate entirely, so typing latency is untouched. Frames over it are the coalesced repaints
where the 6.8:1 lives.

**Context takeover stays ON deliberately.** Terminal output repeats itself heavily across frames
(same box borders, same status line), so a retained window is where much of the ratio comes from.
It costs memory per connection; that is the trade being made, and it must be stated because
`serverNoContextTakeover: true` is the reflexive "safe" choice and would discard most of the benefit.

**2. Nothing changes client-side.** Browsers negotiate permessage-deflate automatically and
decompress transparently; `terminals.js` sees the same `ArrayBuffer` it sees today.

**3. Do not remove `MAX_FLUSH_BYTES`.** The 128 KB cap still matters — it keeps one frame from
becoming a multi-megabyte deflate job that stalls the client's decode and defeats backpressure, which
is what its comment already says.

## Verification Plan

1. Confirm the negotiated extension: `Sec-WebSocket-Extensions: permessage-deflate` on the
   `/ws/terminal` upgrade response.
2. Measure bytes on the wire for a fixed workload — run a command producing ~1 MB of TUI output and
   compare captured socket bytes before and after. Expect a large multiple, not a few percent.
3. Measure keystroke echo latency before and after on the same link. It must not regress; frames
   under 1024 bytes must show no deflate in a capture.
4. Host CPU during a heavy multi-seat burst stays within an acceptable margin — record the number
   rather than asserting it is fine.
5. Scrollback replay on attach (a single large frame) arrives intact and is measurably smaller.
6. Backpressure still functions: force a slow client and confirm `checkBackpressure` still pauses and
   resumes, since `ws.bufferedAmount` now counts compressed bytes.
7. **Both hosts:** repeat 1 and 2 against standalone and against the extension's pty-host sidecar.

### Goal Invariants

- Assert `perMessageDeflate` is configured on the terminal `WebSocketServer` with a numeric `threshold`.
- Assert the threshold is > 0, so small frames bypass compression rather than being compressed at a loss.
- Assert `MAX_FLUSH_BYTES` is unchanged.
- Assert `wsHub.ts`'s two servers are NOT given deflate by this change.
- Assert no new constructor parameter or setter was added to `TerminalWsGateway`.
