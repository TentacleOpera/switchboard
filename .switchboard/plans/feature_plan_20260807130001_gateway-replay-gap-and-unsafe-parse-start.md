# Scrollback Replay Splices Silently Over Evicted Output and Can Start Mid-Escape-Sequence

## Metadata

**Complexity:** 5
**Tags:** backend, frontend, bugfix, terminals, reliability

## Goal

Make the gateway's scrollback replay honest about what it can and cannot deliver: detect
when the ring has evicted output a reconnecting client never received, tell the client so
it can start from a clean screen instead of splicing onto a stale one, and never hand any
client a payload that begins in the middle of an escape sequence.

### Root Cause

`setupClient` (`src/standalone/terminalWsGateway.ts:823`) resolves the replay payload with
a bare filter (line 846):

```typescript
const missed = lastSeq > 0
    ? buffer.chunks.filter(c => c.seq > lastSeq)
    : buffer.chunks;
```

The ring behind it evicts (`flushOutput`, line 459):

```typescript
while (buffer.totalBytes > MAX_SCROLLBACK_BYTES && buffer.chunks.length > 1) {
    const removed = buffer.chunks.shift()!;
    buffer.totalBytes -= removed.data.length;
}
```

`MAX_SCROLLBACK_BYTES` is 256 KB. So when a client reconnects carrying a `lastSeq` older
than the oldest chunk the ring still holds, the filter cannot distinguish "you missed
nothing" from "everything you missed is gone". It returns whatever survived and the
client writes it as if it were contiguous with what it already has.

Two distinct defects fall out of that, and they need different fixes.

**Defect A — silent gap.** Output between the client's `lastSeq` and the oldest retained
chunk is dropped with no signal. The client then sets `entry.lastSeq` from the replayed
frame's seq, so the hole is sealed over and nothing downstream can ever detect it. The
operator sees a transcript that reads as continuous and is not. This is reachable in
normal use: backpressure eviction after `HIGH_WATER_GRACE_MS` (30 s), laptop sleep, a
suspended background tab, or any network blip — combined with a terminal that produced
more than 256 KB meanwhile, which a build log, a test run, or a streaming agent does
routinely.

**Defect B — unsafe parse start.** The ring stores whole flush chunks and evicts whole
chunks, so the splice always lands on a *chunk* boundary. A chunk boundary is not an
*escape sequence* boundary. The gateway already knows this and documents it, in the
`scanTerminalModes` carry comment (line 552):

> The carry is load-bearing: pty reads split wherever the kernel says, so `\x1b[?20` and
> `04h` routinely arrive in different chunks and a stateless scan would miss the only
> escape that matters.

The same splitting applies to the replay: the first retained chunk can begin with the tail
of a sequence whose `ESC` was evicted. xterm then parses the orphaned remainder as literal
text — `[?2004h` printed into the buffer — and worse, a truncated CSI can swallow the
printable bytes that follow it while it hunts for a final byte.

Defect B is **not** limited to gapped reconnects. A *fresh* attach takes the
`lastSeq > 0 ? … : buffer.chunks` else-branch and replays from the oldest retained chunk,
which is only the true stream origin while the terminal has produced under 256 KB total.
Attaching to any long-running terminal hits this on the first frame.

### Background Context

`nextSeq` is terminal-scoped and starts at 1 (`trackTerminalData`, line 389; the comment
at line 139 records the bug that came from making it per-connection). So
`buffer.chunks[0].seq === 1` is an exact test for "the ring still holds the stream
origin", and `oldestRetained > lastSeq + 1` is an exact test for a gap. Both are cheap and
need no new bookkeeping.

The gateway already owns escape-boundary logic for the *input* path:
`findSafeBoundary` (line 301) and `isEscapeSequenceComplete` (line 327), written to stop
`INPUT_CHUNK_BYTES` slicing from turning `\x1b[200~` into a bare ESC plus literal `[200~`.
Their doc-comment names exactly the hazard this plan addresses, in the other direction.
They operate on `Buffer`; the replay path holds strings, so this needs a sibling rather
than a reuse.

The client-side replay path is already carefully sequenced and must not be disturbed:

- `hello` carries `replayChars`, and `entry.ackSuppressChars` burns that budget in
  `onWriteParsed` (line 4773) so replay is not billed to the connection's credit ledger.
- `entry.awaitingReplayFrame` (line 4575) routes the next binary frame to `writeReplay`
  rather than the batch queue.
- `writeReplay` (line 4749) mutes answerback for the replay parse and applies
  `entry.pendingModes` in the write callback — the exact boundary at which the replay has
  been fully consumed and no live chunk has been parsed yet.

## Proposed Changes

### File 1: `src/standalone/terminalWsGateway.ts` — trim to a safe parse start

Add a string-domain sibling to the existing input-path helpers:

```typescript
/**
 * Index of the first byte of `text` that is safe to hand a parser cold.
 *
 * The replay ring evicts whole CHUNKS, and a chunk boundary is not an escape
 * boundary — see the scanTerminalModes carry comment: `\x1b[?20` and `04h`
 * routinely arrive in different chunks. So a payload that does not start at the
 * stream origin can begin with the tail of a sequence whose ESC was evicted,
 * which xterm prints as literal text and which can swallow the bytes after it
 * while a truncated CSI hunts for a final byte.
 *
 * Only ever called for a payload that is NOT the stream origin. An origin start
 * is clean by construction and must not be trimmed.
 */
private findSafeReplayStart(text: string): number {
    // A dangling remainder is short by definition — its ESC was in the evicted
    // chunk, so only the tail can be here. Scanning past a bounded window would
    // let a legitimate run of printable text look like sequence params.
    const window = Math.min(text.length, MODE_SCAN_CARRY_MAX);
    for (let i = 0; i < window; i++) {
        const c = text.charCodeAt(i);
        if (c === 0x1b) { return i; }          // a real sequence starts here
        if (c >= 0x40 && c <= 0x7e) { return i + 1; }  // CSI/OSC final byte closes the orphan
        if (c === 0x07) { return i + 1; }      // BEL closes an orphaned OSC
    }
    return 0;
}
```

Rewrite the replay resolution in `setupClient` (lines 844-855):

```typescript
    let replayFrame: Buffer | undefined;
    let replayChars = 0;
    let replayGap = false;
    if (buffer && buffer.chunks.length > 0) {
        const oldestRetained = buffer.chunks[0].seq;
        // The ring evicts at MAX_SCROLLBACK_BYTES, so a client that was away long
        // enough is asking for output that no longer exists. The filter alone
        // cannot tell that from "you missed nothing" — it returns the survivors
        // either way and the client seals the hole by advancing its lastSeq.
        replayGap = lastSeq > 0 && oldestRetained > lastSeq + 1;
        const missed = lastSeq > 0
            ? buffer.chunks.filter(c => c.seq > lastSeq)
            : buffer.chunks;
        if (missed.length > 0) {
            const replaySeq = missed[missed.length - 1].seq;
            let combined = missed.map(c => c.data).join('');
            // Trim ONLY when this payload is not the stream origin. seq is
            // terminal-scoped and starts at 1, so missed[0].seq === 1 is an exact
            // test for "nothing before this was ever produced".
            if (missed[0].seq > 1) {
                combined = combined.slice(this.findSafeReplayStart(combined));
            }
            // AFTER the trim. replayChars is the client's ackSuppressChars budget
            // and it must equal what the client actually writes, or the ledger
            // drifts by the trimmed bytes on every attach.
            replayChars = combined.length;
            replayFrame = encodeOutputFrame(replaySeq, combined);
        }
    }
```

Add `replayGap` to the `hello` frame beside `replayChars` (line 868). Omit it when false,
matching the frame's existing convention for `bracketedPaste` and `modes`.

### File 2: `src/webview/terminals.js` — reset before a gapped replay

Record the flag on the hello arm (line 4611), next to `awaitingReplayFrame`:

```javascript
                    entry.replayGap = frame.replayGap === true;
```

Reset in the replay branch of `onmessage` (line 4575), before `writeReplay`:

```javascript
                    if (entry.awaitingReplayFrame) {
                        entry.awaitingReplayFrame = false;
                        flushBatch(entry);
                        if (entry.replayGap) {
                            // The ring evicted output this connection never saw, so
                            // what is already on screen is not contiguous with what
                            // is about to be written. Splicing the two produces a
                            // transcript that READS continuous and is not, and
                            // leaves the parser holding state from before the hole.
                            // Reset is the only thing that guarantees a clean start;
                            // the retained ring repopulates the screen immediately.
                            //
                            // Safe against the mode-restore path: reset() restores
                            // DEC defaults, and writeReplay's callback applies the
                            // gateway's recorded `modes` AFTER the replay parses —
                            // so the authoritative state still wins, in the right
                            // order.
                            try { entry.term.reset(); } catch { /* ignore */ }
                            entry.replayGap = false;
                            markReplayGap(entry);
                        }
                        writeReplay(entry, text);
                        return;
                    }
```

`markReplayGap` surfaces the loss on the **pane chrome**, never in the buffer — a notice
written into the terminal would be the exact defect the sibling plan
`feature_plan_20260807130000_terminal-chrome-writes-corrupt-tui-buffer.md` exists to
remove, and would land inside a screen the CLI believes it owns. A toast plus a header
badge (`terminalBadges` / `.pane-badge`, already used for `DONE`) is the whole signal.

### File 3: `src/standalone/terminalWsGateway.ts` — log the gap server-side

`console.warn` the terminal name, the client's `lastSeq`, the oldest retained seq, and the
byte count of the hole. The client-side signal tells the operator; this is what makes the
condition diagnosable after the fact, and the drop is otherwise invisible in every log.

## Edge Cases

**A gap with nothing retained.** `buffer.chunks.length === 0` cannot coexist with a gap —
the eviction loop guarantees `chunks.length > 1` before it stops, so an empty ring means
the terminal has produced nothing. The existing outer guard already covers it.

**`lastSeq` ahead of the ring.** A client reconnecting to a *restarted* host sees
`nextSeq` back at 1 while it carries a large `lastSeq`. `missed` comes back empty, no
replay frame is sent, and `replayGap` is false (`oldestRetained > lastSeq + 1` fails).
Correct: there is no gap in a stream that started over. The terminal-scoped seq comment at
line 139 records why this shape matters.

**Trim eats the whole payload.** A retained chunk that is nothing but the tail of a long
sequence yields an empty `combined`. `replayChars` is then 0, `awaitingReplayFrame` stays
false on the client (it is gated on `ackSuppressChars > 0`, line 4619), and
`applyServerModes` is applied inline from the hello arm instead. The existing branch
already handles the no-replay case; no extra code path.

**Alt screen after a reset.** `REARMABLE_DEC_MODES` (line 3810) deliberately excludes 1049
in the enable direction, so an app sitting in the alternate buffer is not restored to it
after `term.reset()`. This is a **pre-existing** limitation — every fresh attach already
lands in the normal buffer — and the reset makes it reachable on gapped reconnects too.
Accepted rather than fixed here: asserting `?1049h` into a freshly reset xterm switches to
an empty alt buffer and hides the scrollback the replay just wrote, which
`applyServerModes` documents at length as strictly worse than the bug.

**Ack ledger.** `replayChars` is computed after the trim, so `ackSuppressChars` matches the
bytes the client actually parses. Without that ordering the ledger under-suppresses by the
trimmed length on every attach — small per attach, unbounded over a long session, and it
would disable backpressure for exactly the stretch after a reconnect that the mechanism
exists to protect.

**Reset and `disableStdin`.** `term.reset()` does not touch `options`, so a read-only
exited terminal stays read-only and `resolveInputState` is unaffected.

## Dependencies

None. `MODE_SCAN_CARRY_MAX` and `encodeOutputFrame` already exist in the same file. The
client change rides the `hello` frame's existing extension convention, and an older client
that ignores `replayGap` behaves exactly as it does today — the trim alone still removes
the parse hazard for it.

## Adversarial Synthesis

**"Just make the ring bigger."** Raising `MAX_SCROLLBACK_BYTES` moves the threshold and
removes nothing: any bound is crossable by a long enough absence or a loud enough
terminal, and the failure stays silent when it is crossed. Memory cost is real and per
terminal. Detection is the fix; ring size is a tuning knob.

**"Reset is heavy-handed — it throws away scrollback the operator might still want."** The
scrollback it discards is precisely the content known to be discontinuous with what
follows, and the retained ring repaints up to 256 KB immediately. The alternative is
keeping a transcript that silently lies about being continuous, which is worse than a
short one that is honest.

**"The trim could remove legitimate output."** It can, bounded by `MODE_SCAN_CARRY_MAX`
(64 bytes) and only on a payload that is provably not the stream origin. The scan stops at
the first `ESC`, so a payload that already starts clean is returned untouched — the common
case costs one character comparison. Trading up to 64 bytes at the very top of a replay
for a guaranteed-parseable start is the right side of that trade.

**"Defect B was never actually observed."** True — it is derived from the eviction and
chunking code rather than from a report, and it should be described that way. It is also
already proven reachable by the codebase's own `modeScanCarry` comment, which exists
because escape sequences demonstrably split across chunks in this exact stream. The fix is
~15 lines and carries a bounded, characterised cost.

**Risk: two behaviour changes in one plan.** Deliberate. The trim without the gap
detection leaves the silent hole; the gap detection without the trim still hands the
client a payload that can start mid-sequence on a *fresh* attach, which the gap flag does
not cover. They are one defect seen from two ends of the same splice.

## Verification Plan

### Automated Tests

New `src/test/terminal-replay-gap-contract.test.js`, exercising the gateway directly (the
replay path is pure Node and needs no browser):

1. **A gap is detected and flagged.** Push chunks until eviction, then call `setupClient`
   with a `lastSeq` older than `chunks[0].seq - 1`. Assert `hello.replayGap === true`.
2. **A contiguous reconnect is not flagged.** `lastSeq === chunks[0].seq - 1` must yield no
   `replayGap` field. Guards the off-by-one directly.
3. **A fresh attach to an evicted stream trims.** Seed the ring so `chunks[0].seq > 1` with
   a first chunk beginning `[?2004h` (an orphaned CSI tail). Assert the framed payload
   starts after the final byte.
4. **An origin-start replay is never trimmed.** `chunks[0].seq === 1` must round-trip
   byte-identical, even when the payload happens to begin with `[`.
5. **`replayChars` equals the framed payload length after trimming.** The ledger invariant;
   assert against the frame body, not the pre-trim string.
6. **A payload that trims to empty sends no replay frame** and reports `replayChars: 0`.
7. **`findSafeReplayStart` unit cases:** clean text → 0; orphaned CSI tail → after the
   final byte; orphaned OSC tail → after BEL; leading `ESC` → 0; 64+ bytes of printable
   text with no final byte → 0 (the window bound holds).

Client-side, extend `terminal-answerback-replay-contract.test.js` in its source-scanning
style: assert `term.reset()` is called on the `replayGap` path, that it precedes
`writeReplay`, and that `entry.replayGap` is cleared so a later contiguous reconnect
cannot inherit it.

`terminal-flow-control-contract.test.js` and `terminal-dec-mode-restore-contract.test.js`
must both stay green — the `ackSuppressChars` budget and the post-replay
`applyServerModes` ordering are exactly what this change is threading through.

### Manual Verification

1. Start a terminal and run a generator that overruns the ring quickly
   (`yes "$(head -c 200 /dev/urandom | base64)"`).
2. With it running, kill the browser tab's WebSocket (DevTools → Network → the terminal
   socket → close) and leave it closed long enough to push more than 256 KB.
3. Reconnect. **Verify:** the pane shows the gap badge/toast, the screen is reset rather
   than spliced, and the visible transcript is internally consistent — no half-line seam
   where the splice landed.
4. **Verify:** the standalone host logged the terminal name, both seqs, and the byte count
   of the hole.
5. Attach a second surface to a terminal that has already produced well over 256 KB.
   **Verify:** the top of the replayed scrollback shows no literal `[?2004h`-style
   fragment, and the rest of the pane renders normally.
6. Run a full-screen CLI (Claude Code), force a gapped reconnect as above. **Verify:** the
   CLI's UI redraws correctly after the reset, bracketed paste still works (mode restore
   survived the reset), and a multi-line paste lands as one block.
7. Reconnect with no gap (close and immediately reopen the socket). **Verify:** no reset,
   no badge, and scrollback continues seamlessly — the common path is untouched.
