# Every terminal WebSocket crosses the link uncompressed, and terminal output is the most compressible traffic there is

## Goal

Enable permessage-deflate on the terminal WebSocket above a size threshold, so a remote board pays
roughly a seventh of the bytes for the same screen while a keystroke echo stays uncompressed.

> **Superseded:** "while a keystroke echo stays uncompressed" — achievable via the `threshold` option.
> **Reason:** The `ws` library (v8.21.0) only applies the `threshold` check when `server_no_context_takeover` is in the negotiated params (`sender.js:374-383`). With `serverNoContextTakeover: false` (required for cross-frame dictionary retention), the threshold is **ignored entirely** — all messages are compressed regardless of size. The threshold and context takeover are mutually exclusive in `ws`; you cannot have both.
> **Replaced with:** Accept that all messages are compressed, including small frames. The cost is negligible: zlib level 6 on a 3-byte payload completes in microseconds on modern hardware, and the frame enlargement (~3 bytes → ~5-7 bytes of deflate output) is noise on any link slow enough to benefit from compression. The goal's compression target (roughly a seventh) is best met with context takeover, which requires dropping the "keystroke echo stays uncompressed" clause. See the **User Review Required** section for the trade-off decision.

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

> **Superseded:** The per-message overhead concern for small frames, while theoretically valid, is negligible in practice with `serverNoContextTakeover: false`. The `ws` library's `threshold` option — the plan's original mitigation — does not function when context takeover is enabled (see Superseded callout in Goal above). zlib level 6 on a 3-byte input completes in microseconds; the frame enlargement is 2-4 bytes. The "wrong trade" framing overstates a cost that is not measurable in practice.
> **Reason:** The threshold was the load-bearing mechanism for avoiding this cost. With the threshold non-functional under context takeover, the plan must either accept the cost (negligible) or sacrifice context takeover (significant ratio loss). The analysis below shows the cost is negligible.
> **Replaced with:** Accept that all messages are compressed. The CPU cost for small frames is sub-millisecond. The bandwidth enlargement (a few bytes per small frame) is dwarfed by the savings on large frames. The operator cannot perceive the difference. The real trade-off is context takeover vs. no context takeover — see Proposed Changes.

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
**Tags:** backend, performance, reliability

## User Review Required

**The goal says "while a keystroke echo stays uncompressed." That clause cannot be met with the approach that delivers the best compression ratio.** The `ws` library forces a choice:

- **Option A (recommended): `serverNoContextTakeover: false`** — retain the deflate dictionary across frames (best ratio, ~6.8:1 or better). All messages are compressed, including keystroke echoes. The cost is negligible: sub-millisecond CPU, ~2-4 byte frame enlargement on small frames. The "keystroke echo stays uncompressed" clause is not met, but the operator cannot perceive the difference.
- **Option B: `serverNoContextTakeover: true` + `threshold: 1024`** — the threshold works: small frames skip compression. But the deflate dictionary is reset every message, so cross-frame repetition (same box borders, same status line) is lost. The compression ratio drops — likely to ~4:1 or worse (unmeasured). "Roughly a seventh" may become "roughly a quarter."

Proceeding on the assumption that **Option A** is correct — the compression ratio on the dominant traffic class (large coalesced repaints) matters more than the theoretical cost of compressing small frames. If the user chooses Option B, update the `perMessageDeflate` config and the verification plan accordingly.

## Dependencies

None.

## Complexity Audit

### Routine

- Single constructor options change on one `WebSocketServer` instantiation (`terminalWsGateway.ts:393`).
- Both composition roots (standalone `bootstrap.ts:3202`, extension sidecar `ptyHost.ts:46`) use the same `TerminalWsGateway` class, so the change reaches both with no additional wiring.
- No client-side changes — browsers negotiate permessage-deflate automatically and decompress transparently.
- No new dependencies; `ws` already supports `perMessageDeflate` natively.

### Complex / Risky

- The `ws` library's `threshold` option is **non-functional** when `serverNoContextTakeover: false` — a subtle interaction that makes the plan's original strategy impossible without sacrificing context takeover.
- `ws.bufferedAmount` semantics shift with deflate enabled: during async compression, `_bufferedBytes` holds the uncompressed byte count; after compression, the socket buffer holds compressed bytes. The backpressure check at `:790` runs while data is in the compression queue (uncompressed), but the drain poller at `:1430` and ack handler at `:1327` see post-compression state. The pause/resume thresholds still function but the semantics are mixed.
- `concurrencyLimit` is a **module-level global** in `ws` (`permessage-deflate.js:65-70`), shared across all WebSocket connections in the process — not per-terminal, not per-connection. 10 concurrent zlib operations is adequate for typical multi-seat usage but could queue under extreme load.

## Edge-Case & Dependency Audit

**Race Conditions:**
- The backpressure check at `:790` runs synchronously after `safeSendBinary`, while data is in `_bufferedBytes` (uncompressed). The drain poller at `:1430` runs every 250ms and may see compressed bytes in the socket buffer. This means the pause threshold (1 MB uncompressed) and resume threshold (256 KB compressed) operate on different byte counts. Net effect: pause behavior is roughly unchanged (uncompressed bytes counted during compression), resume happens sooner (compressed bytes drain faster). This is a net improvement — less pty pause time — but the asymmetry should be documented.

**Security:**
- No new attack surface. permessage-deflate is a standard WebSocket extension negotiated in the upgrade handshake. The `zlibDeflateOptions` do not include a custom dictionary (which could leak information).

**Side Effects:**
- Memory: context takeover retains a deflate dictionary per connection (~32-256 KB per connection depending on window bits). For a multi-seat gateway with many terminals, this is per-client, not per-terminal — each WebSocket connection gets its own deflate/inflate pair. At `zlibDeflateOptions: { level: 6, memLevel: 8 }` with default window bits (15), the dictionary is ~256 KB per direction per connection. 10 connected clients = ~5 MB of dictionary memory. Acceptable.
- CPU: every message now goes through zlib, including small frames. The `concurrencyLimit: 10` global limiter queues excess compressions. Under heavy multi-seat load, this adds latency to the compression path but not to the send path (compression is async).

**Dependencies & Conflicts:**
- `ws` v8.21.0 is the installed version. The `threshold` / `serverNoContextTakeover` interaction is confirmed in this version's source. A `ws` upgrade could change this behavior — the plan should note the version dependency.
- No conflict with `MAX_FLUSH_BYTES` (128 KB cap) — the cap limits one frame's uncompressed size, and deflate compresses the result. The cap still prevents a single frame from becoming a multi-megabyte deflate job.
- No conflict with `wsHub.ts` — its two `WebSocketServer` instances are separate objects and are not modified.

## Adversarial Synthesis

Key risks: (1) the `threshold` option is non-functional under `serverNoContextTakeover: false`, making the plan's original strategy impossible — corrected by accepting all-message compression with negligible cost; (2) `bufferedAmount` semantics shift to a mix of uncompressed (during compression) and compressed (in socket buffer) bytes, but backpressure still functions and actually improves (faster resume); (3) `concurrencyLimit` is a process-global limiter that could queue under extreme multi-seat load. Mitigations: keep context takeover for best ratio, document the `bufferedAmount` asymmetry, note the global limiter for future tuning if multi-seat latency is observed.

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

**1. Enable deflate with context takeover (`terminalWsGateway.ts:393`).**

> **Superseded:** Enable deflate with a threshold (`serverNoContextTakeover: false`, `threshold: 1024`).
> **Reason:** The `threshold` option is ignored by `ws` v8.21.0 when `serverNoContextTakeover: false`. The threshold check in `sender.js:374-383` is gated on `perMessageDeflate.params['server_no_context_takeover']` being truthy, which only occurs when `serverNoContextTakeover: true`. With context takeover enabled (the plan's choice for best compression ratio), ALL messages are compressed regardless of size. The threshold is dead config.
> **Replaced with:** Enable deflate with context takeover and no threshold. Accept that all messages are compressed. The cost on small frames is negligible (sub-ms CPU, ~2-4 byte enlargement). See User Review Required for the trade-off decision.

```
new WebSocketServer({
    noServer: true,
    perMessageDeflate: {
        zlibDeflateOptions: { level: 6, memLevel: 8 },
        concurrencyLimit: 10,
        serverNoContextTakeover: false,   // keep the window across frames
    },
})
```

**Context takeover stays ON deliberately.** Terminal output repeats itself heavily across frames
(same box borders, same status line), so a retained window is where much of the ratio comes from.
It costs memory per connection (~256 KB per direction at default window bits); that is the trade
being made, and it must be stated because `serverNoContextTakeover: true` is the reflexive "safe"
choice and would discard most of the benefit.

**The `threshold` option is omitted** because it is non-functional under `serverNoContextTakeover: false` (see Superseded callout above). Setting it would be dead config that misleads future readers into thinking small frames bypass compression.

**2. Nothing changes client-side.** Browsers negotiate permessage-deflate automatically and
decompress transparently; `terminals.js` sees the same `ArrayBuffer` it sees today.

**3. Do not remove `MAX_FLUSH_BYTES`.** The 128 KB cap still matters — it keeps one frame from
becoming a multi-megabyte deflate job that stalls the client's decode and defeats backpressure, which
is what its comment already says.

**4. Do not adjust backpressure thresholds.** `HIGH_WATER_MARK_BYTES` (1 MB) and `LOW_WATER_MARK_BYTES` (256 KB) remain unchanged. With deflate enabled, `ws.bufferedAmount` is a mix: during async compression, `sender._bufferedBytes` holds the **uncompressed** byte count (the backpressure check at `:790` runs in this state); after compression, the socket buffer holds **compressed** bytes (the drain poller at `:1430` and ack handler at `:1327` run in this state). The pause threshold effectively still triggers at ~1 MB of uncompressed data (same as before). The resume threshold triggers at 256 KB of compressed data — which represents more uncompressed data than before, meaning the pty resumes sooner. This is a net improvement, not a regression. The `unackedChars` path (uncompressed, unaffected by deflate) provides a second independent backpressure signal that is unchanged.

**5. Document the `concurrencyLimit` global scope.** The `concurrencyLimit: 10` is a module-level limiter in `ws` (`permessage-deflate.js:65-70`), shared across all WebSocket connections in the process. This is not per-terminal. Under heavy multi-seat load (many terminals flushing simultaneously), excess compressions queue behind the limiter. 10 is adequate for typical usage; if multi-seat compression latency is observed, increase this value. Note that the first `PerMessageDeflate` instance to initialize creates the limiter, so the `concurrencyLimit` from this config is the one used globally.

## Verification Plan

1. Confirm the negotiated extension: `Sec-WebSocket-Extensions: permessage-deflate` on the
   `/ws/terminal` upgrade response.
2. Measure bytes on the wire for a fixed workload — run a command producing ~1 MB of TUI output and
   compare captured socket bytes before and after. Expect a large multiple, not a few percent.
3. Measure keystroke echo latency before and after on the same link. It must not regress perceptibly;
   frames under 1024 bytes **will** be compressed (the threshold is non-functional under context
   takeover), but the cost is sub-millisecond and should not be measurable in echo latency.
4. Host CPU during a heavy multi-seat burst stays within an acceptable margin — record the number
   rather than asserting it is fine. Note that all messages now go through zlib, not just large ones.
5. Scrollback replay on attach (a single large frame) arrives intact and is measurably smaller.
6. Backpressure still functions: force a slow client and confirm `checkBackpressure` still pauses and
   resumes. Note that `ws.bufferedAmount` is now a mix of uncompressed bytes (during compression, in
   `sender._bufferedBytes`) and compressed bytes (in the socket buffer). The pause threshold (1 MB)
   triggers at roughly the same uncompressed data volume; the resume threshold (256 KB) triggers
   sooner because compressed bytes drain faster. Confirm the pty pauses and resumes correctly under
   sustained slow-client load.
7. **Both hosts:** repeat 1 and 2 against standalone and against the extension's pty-host sidecar.
8. **Memory:** with 10 connected clients, measure per-process memory increase. Expect ~5 MB of
   deflate/inflate dictionary memory (256 KB × 2 directions × 10 clients). Confirm this is within
   acceptable bounds.

### Automated Tests

- Unit test: assert `perMessageDeflate` is configured on the `WebSocketServer` in `TerminalWsGateway` with `serverNoContextTakeover: false` and no `threshold` property (or threshold absent, since it is non-functional).
- Integration test: connect a WebSocket client to the gateway, verify `permessage-deflate` is negotiated in the upgrade response headers.
- Integration test: send a large output frame (> 1024 bytes) and verify the frame is compressed (compressed payload smaller than uncompressed).
- Integration test: send a small output frame (< 1024 bytes) and verify the frame is still compressed (threshold is non-functional under context takeover — this confirms the corrected behavior, not the original plan's claim).

### Goal Invariants

- Assert `perMessageDeflate` is configured on the terminal `WebSocketServer` with `serverNoContextTakeover: false`.
- Assert `perMessageDeflate` is NOT configured on `wsHub.ts`'s two `WebSocketServer` instances.
- Assert `MAX_FLUSH_BYTES` is unchanged (still `128 * 1024`).
- Assert `HIGH_WATER_MARK_BYTES` is unchanged (still `1024 * 1024`).
- Assert no new constructor parameter or setter was added to `TerminalWsGateway`.
- Assert `OUTPUT_FLUSH_MS` is unchanged (still `6`).
- Assert the `perMessageDeflate` config does NOT include a `threshold` property (it is non-functional under `serverNoContextTakeover: false` and would mislead future readers).

## Implementation Summary

Enabled `perMessageDeflate` with context takeover (`serverNoContextTakeover: false`) on the terminal `WebSocketServer` at `terminalWsGateway.ts:393`. Config: `zlibDeflateOptions: { level: 6, memLevel: 8 }`, `concurrencyLimit: 10`, no `threshold` (non-functional under context takeover). Added a documentation block explaining the threshold/context-takeover interaction, the all-messages-compressed trade-off, and the global scope of `concurrencyLimit`. No changes to `wsHub.ts`, backpressure thresholds, `MAX_FLUSH_BYTES`, `OUTPUT_FLUSH_MS`, or the `TerminalWsGateway` constructor signature. Compilation and automated tests skipped per run directives.

## Review Findings

Reviewed and extended the implementation: `src/standalone/terminalWsGateway.ts` (rewrote the
`perMessageDeflate` comment, which claimed `serverNoContextTakeover: false` merely "keeps the window
across frames" — measured, it also makes `ws` refuse any offer carrying `server_no_context_takeover`
with **HTTP 400** rather than downgrading; added a note at `checkBackpressure` that `bufferedAmount`
is now a mix of compressed socket bytes and uncompressed queued bytes, so `unackedChars` is the
signal that still paces the pty), plus the plan's four missing `### Automated Tests` as
`src/test/terminal-ws-deflate-contract.test.js`, wired via `package.json` and a new
`.github/workflows/integration-tests.yml` step. Verification: `tsc -p tsconfig.test.json` clean; the
new suite 15/15 and confirmed to go **red** under a `serverNoContextTakeover: true` + `threshold`
mutation; `npm test`, `parity:check`, `push-routing:check`, `host-seam-parity:check`,
`standalone-fork:check`, `verb-returns:check`, `mirror:check` and ten terminal/ws contract suites all
pass. The core mechanism is measured, not assumed: against a live server built from the shipped
options literal, `permessage-deflate` negotiates for Chrome- and Firefox/Safari-shaped offers, a
repeated 4096-byte frame leaves in ~20 wire bytes, a 2-byte echo is compressed to 4 bytes, and real
session logs deflate 6.1:1 / 6.4:1 / 14.7:1 at 22 µs per keystroke-sized frame — the goal's "roughly
a seventh" is met. All seven Goal Invariants hold and no destination or approach in the plan was
changed.

## Deferred Findings

- MAJOR — `serverNoContextTakeover: false` refuses a client offering `server_no_context_takeover` with HTTP 400 rather than downgrading; safe today only because every client is a browser, and there is no diagnostic if a future non-browser client is refused. Kept because the plan's Goal Invariants name the value explicitly; documented in code and pinned by the new suite. `src/standalone/terminalWsGateway.ts:397`
- NIT — zlib runs on the libuv threadpool (default 4), shared with all host fs I/O; multi-seat compression bursts and plan/log writes now contend. Unmeasured. `src/standalone/terminalWsGateway.ts:420`
- NIT — per-connection deflate/inflate dictionaries (~300 KB) scale linearly with connected clients and are bounded by nothing in this codebase. `src/standalone/terminalWsGateway.ts:420`
- NIT — the 1 MB / 30 s byte-based lagging-client eviction now needs several times its nominal volume of terminal output to arm; the ping reaper is the effective backstop for a wedged client. `src/standalone/terminalWsGateway.ts:1101`
- NIT — `zlibDeflateOptions: { level: 6, memLevel: 8 }` restates zlib's own defaults; kept as documentation of intent. `src/standalone/terminalWsGateway.ts:424`
- NIT — plan verification steps 2, 4, 7 and 8 (bytes over a real remote link, host CPU under multi-seat burst, the extension's pty-host sidecar, 10-client memory) were measured at the `ws` layer with the shipped config rather than end-to-end against a live tunnel. `src/standalone/terminalWsGateway.ts:393`
