# Terminal Input Path: Binary Frames and Paced PTY Writes

## Goal

Make a large paste cheap to send and impossible to head-of-line-block behind. Replace the char-by-char base64 + JSON input encoding with binary frames, and pace the pty write so a megabyte paste cannot stall the gateway's event loop or delay the keystrokes typed after it.

### Problem

Pasting a large block into a browser terminal makes it unusable for several seconds: the whole pasted text is echoed back and re-rendered, and typing during and immediately after the paste does nothing. Small pastes are fine; the cost scales sharply and nonlinearly with size.

### Root cause — four stages, each amplifying the last

**1. The client encoding is O(n) allocations on the shared main thread (`src/webview/terminals.js:29-36`, `:1134-1142`).**

```js
function utf8ToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) { bin += String.fromCharCode(bytes[i]); }
    return btoa(bin);
}
```

xterm delivers a paste as a **single** `onData` event, so a 200 KB paste is 200 000 loop iterations, then `btoa` over the result (~270 KB), then `JSON.stringify` escaping that string again — all synchronous, all on the main thread that six panel iframes share. The output path already moved to binary frames for exactly this reason (`terminalWsGateway.ts:55-67`); the input path was left on the old encoding.

**2. The server does one unbounded write, so every later keystroke queues behind it (`terminalWsGateway.ts:409-410`, `ptyBackend.ts:89-91`).**

```ts
const decoded = Buffer.from(parsed.data, 'base64').toString('utf8');
terminal.write(decoded);
```

`ptyProcess.write` queues into node-pty's socket with no size bound and no pacing. Input ordering must be preserved, so a 1 MB paste sitting at the head of that queue delays every subsequent keystroke until it drains. **That is the "I can't type" half of the symptom** — it is a queueing property, not a rendering one, and none of the output-path work touches it.

**3. The kernel tty buffer splits the paste into many reads.** The pty master→slave path holds only single-digit KB, so one `write()` of 100 KB reaches the shell as a dozen-plus separate reads regardless of how it was written. Applications that detect bracketed paste by testing whether a *single* chunk starts with `\x1b[200~` and ends with `\x1b[201~` fail on a split paste and fall back to treating it as typed input — which is why the whole block gets echoed instead of collapsing into a placeholder. `PtyTerminalBackend.create` spawns a bare login shell (`ptyBackend.ts:68-69`, `['-l']`), so the echo comes from the shell's line editor with no application-level paste handling at all.

**4. The resulting echo storm re-enters the output path.** Whatever the shell or TUI redraws in response now has to cross the WebSocket and be parsed by xterm. Sizing that path is the sibling plan's job; this plan's job is to stop manufacturing the storm and to stop blocking input while it plays out.

### Context

What this plan can and cannot fix is worth stating plainly, because the boundary is not obvious:

- **Can fix:** the encoding cost, the head-of-line blocking, and any case where *we* split a bracketed-paste marker across writes.
- **Cannot fix:** an application that fails to reassemble a paste across kernel reads. That is the receiving program's responsibility, and no terminal emulator can deliver a large paste as one read. Real terminals have the same property — it is why iTerm2 and Terminal.app warn before large pastes.

The honest framing is that this plan removes our contribution to the problem and makes the remainder survivable, and that the output-side flow control in `terminal-output-flow-control.md` is what keeps the terminal responsive while the echo plays out.

## Scope

- `src/webview/terminals.js` — binary input frames, paste instrumentation.
- `src/standalone/terminalWsGateway.ts` — binary input decode, chunked paced writes, input high-water notice.
- `src/standalone/ptyBackend.ts` — a write primitive that reports queue depth.

## Metadata

- **Complexity:** 5
- **Tags:** performance, bugfix, backend, frontend, terminals

## User Review Required

None.

## Complexity Audit

### Routine

- The binary frame precedent exists and is documented: `encodeOutputFrame` (`terminalWsGateway.ts:68-74`) and the client's `typeof event.data !== 'string'` discriminator (`terminals.js:1189-1201`). The input frame is the same idea in the other direction.
- Chunking a buffer is a loop.
- `ws.binaryType = 'arraybuffer'` is already set (`terminals.js:1168`), so the client already handles binary in one direction.

### Complex / Risky

- **Splitting a UTF-8 sequence corrupts input.** Chunking must never cut a multi-byte codepoint. Since the server holds a `Buffer`, this means finding a safe boundary by inspecting continuation bytes — not slicing at a fixed offset. The output path already reasons about this (`:38-41`, "so a surrogate pair can't be cut across two separately-UTF-8-encoded payloads"); the input path needs the same care in the opposite direction.
- **Splitting an escape sequence changes its meaning.** A chunk boundary inside `\x1b[200~` delivers a bare `\x1b` followed by `[200~` — the app sees an escape and then literal text. The bracketed-paste markers specifically must be kept whole.
- **Pacing must not reorder.** Chunked writes must complete in order and must not interleave with a later keystroke, or the operator's input arrives scrambled in the middle of their paste. A single per-terminal FIFO is required; a naive `setTimeout` per chunk without a queue will reorder under a second paste.
- **Backpressure on input has no obvious correct answer.** Dropping input is unacceptable. Blocking the socket read is not directly available. The chosen answer — a bounded queue with a client-visible notice and no dropping — must be implemented so that the notice is informational and the queue still drains.
- **The two frame formats must coexist during a mixed-version window.** The panel is unreleased so a clean break is permitted, but the server must still not crash on a stale tab holding the old JSON format.

## Edge-Case & Dependency Audit

### Race Conditions

- **Keystroke arriving mid-paste.** Must land after the paste completes, never inside it. This is the ordering requirement above and the reason for a per-terminal FIFO rather than per-message pacing.
- **Terminal exits mid-paste.** `untrackTerminalData` (`:227-251`) tears the terminal down while chunks are still queued. The queue must be discarded and the pacing timer cleared, or the drain loop writes to a dead pty.
- **Client disconnects mid-paste.** The write queue belongs to the terminal, not the client — a disconnect must not cancel input the shell has partly consumed. Keep draining.
- **Resize arriving mid-paste.** `terminal.resize` is a separate ioctl and does not go through the write queue; it may land between chunks. That is correct and matches a real terminal.
- **Two clients pasting into one terminal simultaneously.** Both feed the same FIFO. Their content interleaves at chunk granularity, which is the same behaviour two people typing into one terminal already get. No special handling.

### Security

- The binary input frame must validate its length before slicing, exactly as the output path does (`terminals.js:1191`, `if (view.byteLength < 4) return`). A truncated frame must be dropped, not decoded from a negative offset.
- Cap the maximum single input frame the server will accept and log-and-drop anything larger. Today a client can hand the server an unbounded base64 string that is decoded into memory before anything checks it.
- No new data sources or persisted state.

### Side Effects

- **Paste completion becomes slightly slower and much smoother.** Chunked, paced writes finish marginally later than one blocking write, but the gateway keeps serving output throughout, so the terminal stays alive rather than freezing and catching up.
- **The old JSON input path is removed from the client.** Any external tool posting `{t:'input'}` frames to `/ws/terminal` would break — the server keeps accepting the JSON form for exactly this reason (see Migration).
- **`ptyBackend`'s `write` grows a return value.** Its `TerminalHandle` shape is shared with `hostSeams.ts:215` and the no-op host stubs (`hostSeams.ts:298`, `hostServices.ts:324`); widening the interface touches those.

### Dependencies & Conflicts

- **`terminal-output-flow-control.md`** edits the same `ws.on('message')` handler in `terminalWsGateway.ts` (it adds an `ack` branch) and the same `terminals.js`. Land the flow-control plan first: the echo storm this plan reduces still needs a paced output path to be survivable, and the message-handler edits are easier to apply on top than underneath.
- **`terminal-view-lifecycle-teardown.md`** edits `terminals.js` but not `term.onData`. No conflict.
- No new libraries.

## Dependencies

None blocking. Recommended order: after `terminal-output-flow-control.md`.

**Migration:** none for persisted state. Protocol compatibility is handled by keeping the server's existing `{t:'input', data:<base64>}` branch (`terminalWsGateway.ts:408-410`) alongside the new binary branch, mirroring how the client already retains the legacy text-output branch for the reverse case (`terminals.js:1204-1216`, "retained so a browser tab left open across a server downgrade still renders"). The Terminals panel is unreleased (first commit 2026-07-31) so no install-base migration is required; the dual branch exists only to survive a stale tab across a dev restart.

## Adversarial Synthesis

**Risk summary.** Chunking is where this goes wrong. A boundary inside a multi-byte codepoint silently corrupts pasted text — the kind of defect that shows up months later as a mangled command in someone's history. A boundary inside `\x1b[200~` turns a paste into an escape plus literal text, which is *worse* than not chunking at all. And pacing without a per-terminal FIFO reorders a keystroke into the middle of a paste, which looks like a phantom input bug. Mitigations: pick boundaries by scanning backwards past UTF-8 continuation bytes and past any incomplete escape sequence rather than slicing at a fixed offset; keep one FIFO per terminal so ordering is structural rather than timing-dependent; and discard the queue on terminal exit. The residual honest limitation, stated in **Context** and worth repeating in the code comment, is that an application which does not reassemble a paste across kernel reads will still echo the whole block — that is not ours to fix, and this plan's contribution there is to keep the terminal usable while it happens rather than to prevent it.

## Proposed Changes

### `src/webview/terminals.js`

#### (a) Binary input frames

Add `encodeInputFrame(data)` mirroring the server's `encodeOutputFrame` convention: a one-byte opcode (`0x01` = input) followed by the UTF-8 bytes from `TextEncoder`. Send it with `ws.send(frame)` — the browser sends an `ArrayBuffer` as a binary frame automatically, but pass the buffer explicitly rather than a view whose `byteOffset` is non-zero.

Rewrite `term.onData` (`:1134-1142`) to use it. Delete `utf8ToBase64` (`:29-36`) once it has no callers — check `base64ToUtf8` (`:38-42`) separately, since it still serves the legacy output branch at `:1214` and must stay.

Add a comment mirroring the one at `terminalWsGateway.ts:55-67` explaining why input moved to binary: the base64 inflation, the JSON escape, and the per-byte `String.fromCharCode` loop that a single paste event runs in full.

#### (b) Paste instrumentation

Record the largest single `onData` payload seen and a running total in the debug stats object (introduced by the flow-control plan as `window.__sbTerminalStats`; add the fields here if that plan has not landed). A paste that behaves badly should be measurable rather than described.

### `src/standalone/terminalWsGateway.ts`

#### (c) Binary input decode

In the `ws.on('message')` handler (`:405-419`), branch on frame type before `JSON.parse`, mirroring the client's discriminator:

- Binary with opcode `0x01` → decode the remainder as UTF-8 and enqueue.
- String → the existing JSON path, unchanged, including the `{t:'input'}` base64 branch (kept per Migration).

Validate: reject a binary frame shorter than 1 byte, and reject any input frame whose payload exceeds `MAX_INPUT_FRAME_BYTES` with a `console.warn` naming the terminal. Today there is no bound at all.

#### (d) Per-terminal input FIFO with paced chunking

Add an input queue keyed by terminal name: `{ chunks: Buffer[], queuedBytes: number, draining: boolean }`.

`enqueueInput(terminalName, buf)` appends and starts the drain if idle. The drain writes at most `INPUT_CHUNK_BYTES` (4096 — comfortably under the tty buffer) per turn, then yields with `setImmediate` so the gateway can service output flushes and other clients between slices.

Boundary selection is the load-bearing part. Before slicing at `INPUT_CHUNK_BYTES`, walk **backwards** to a safe boundary:

- past any UTF-8 continuation bytes (`0b10xxxxxx`) so no codepoint is cut;
- past any incomplete escape sequence — if an `\x1b` appears within the tail and its sequence has not terminated, cut before the `\x1b` rather than inside it. This is what keeps `\x1b[200~` and `\x1b[201~` whole.

If no safe boundary exists within the slice (a single codepoint or sequence longer than the chunk, which cannot happen for well-formed input but must not hang), write the whole slice and log.

`queuedBytes` above `INPUT_HIGH_WATER_BYTES` sends `{t:'inputThrottled', queued:N}` to the terminal's clients once per crossing. **Nothing is dropped** — the notice is informational so the operator understands why a paste is still landing. Send the complementary clear when it drains below the low-water mark.

Clear the queue and its drain state in `untrackTerminalData` (`:227-251`), next to the existing `pendingOutput.delete(name)` (`:240`), and in `dispose` (`:482-497`).

**Edge cases.** A terminal that is paused for *output* backpressure must still accept input — the two directions are independent and conflating them would make a lagging terminal unusable. An input frame for an unknown terminal (post-exit) is dropped silently; that path already exists for the JSON branch.

### `src/standalone/ptyBackend.ts`

#### (e) Report the write outcome

`write` (`:89-91`) currently returns `void`. Widen it to return the node-pty write result so the gateway can see whether the socket accepted the data, and widen the `TerminalHandle` interface at `hostSeams.ts:215` accordingly. Update the two no-op stubs (`hostSeams.ts:298`, `hostServices.ts:324`) to match.

Keep this minimal — it is one return value, not a new backpressure mechanism. The gateway's pacing is time-based by design; node-pty's queue depth is a diagnostic, not a control input.

### Client-side handling of the throttle notice

`ws.onmessage`'s control-frame branch (`terminals.js:1217-1226`) gains an `inputThrottled` case that writes a single dim status line into the terminal. It must **not** set `disableStdin` — the operator can keep typing; their input is queued, not refused.

## Verification Plan

### Automated Tests

New `src/test/terminal-input-path-contract.test.js`, on the existing source-text convention, registered in `package.json` and the CI workflow.

1. **Client sends binary input.** Assert `term.onData`'s handler calls `encodeInputFrame` and no longer calls `utf8ToBase64`.
2. **`utf8ToBase64` is gone; `base64ToUtf8` remains.** Assert the first is deleted and the second is still referenced by the legacy output branch.
3. **Server accepts both formats.** Assert the message handler has a binary branch **and** retains the `parsed.t === 'input'` base64 branch.
4. **Input frames are size-capped.** Assert `MAX_INPUT_FRAME_BYTES` is checked before decode.
5. **Chunking picks safe boundaries.** Assert the slice helper inspects continuation bytes (`0x80`/`0xC0` masking) and scans for `\x1b`, rather than slicing at a bare offset.
6. **Ordering is FIFO per terminal.** Assert the queue is keyed by terminal name and that the drain is guarded by a `draining` flag.
7. **The queue is torn down.** Assert `untrackTerminalData` clears the input queue alongside `pendingOutput`.
8. **Throttle does not disable stdin.** Assert the client's `inputThrottled` branch contains no `disableStdin`.
9. **Input is independent of output pause.** Assert the enqueue path does not consult `pausedTerminals`.

### Manual

1. **Reproduce first.** Paste a 200 KB block (e.g. `head -c 200000 /dev/urandom | base64`) into a browser terminal running a plain shell. Record: time until the prompt is usable, whether typing during the paste registers, and the tab's CPU. Capture the same for a 1 MB block.
2. **Post-fix, same pastes:** typing during the paste registers and appears **after** the pasted content, never inside it. The panel stays interactive.
3. **Content integrity — the critical test.** Paste a file with known content into `cat > /tmp/paste-test`, terminate, and `diff` against the original. Repeat with a UTF-8 file containing multi-byte characters (CJK, emoji, combining marks) at sizes that straddle the 4096-byte boundary — pad deliberately so a codepoint sits across the seam. Zero differences, or the boundary logic is wrong.
4. **Escape sequences survive.** Paste text containing literal `\x1b[` sequences and confirm they are not split — feed it to `cat -v` and compare.
5. **Bracketed paste still brackets.** In an app that supports it, confirm the paste is still recognised as a paste. Then confirm the honest limitation: in an app that does *not* reassemble across reads, the block still echoes — and note that the terminal remains responsive throughout, which is the deliverable.
6. **Throttle notice.** Paste something large enough to cross the high-water mark; confirm the status line appears once, the paste still completes fully, and typing is still accepted.
7. **Terminal exit mid-paste.** Paste a large block and immediately close the terminal. Confirm no error in the server console and no write-after-exit.
8. **Disconnect mid-paste.** Paste a large block and kill the WS from devtools. Confirm the shell still receives the whole paste (the queue belongs to the terminal) and the client reconnects cleanly.
9. **Two terminals.** Paste into terminal A while terminal B is producing output. Confirm B keeps rendering throughout — this is the `setImmediate` yield doing its job.
10. **Stale-tab compatibility.** With a tab open, restart the standalone server and confirm the old tab's input still works via the retained JSON branch until it reconnects.
11. **Regression suite.** Run the contract tests; stash-verify the five known-red tests at HEAD before attributing failures here.

## Recommendation

Complexity 5 → **Standard coder**, with the caveat that the chunk-boundary logic is the whole plan. If verification item 3 is skipped, this ships silent data corruption.
