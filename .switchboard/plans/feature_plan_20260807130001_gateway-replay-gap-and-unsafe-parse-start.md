# Scrollback Replay Splices Silently Over Evicted Output and Can Start Mid-Escape-Sequence

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

The ring behind it evicts (`flushOutput`, line 435; the eviction loop at line 463):

```typescript
while (buffer.totalBytes > MAX_SCROLLBACK_BYTES && buffer.chunks.length > 1) {
    const removed = buffer.chunks.shift()!;
    buffer.totalBytes -= removed.data.length;
}
```

`MAX_SCROLLBACK_BYTES` is 256 KB (line 5). So when a client reconnects carrying a `lastSeq`
older than the oldest chunk the ring still holds, the filter cannot distinguish "you missed
nothing" from "everything you missed is gone". It returns whatever survived and the
client writes it as if it were contiguous with what it already has.

Two distinct defects fall out of that, and they need different fixes.

**Defect A — silent gap.** Output between the client's `lastSeq` and the oldest retained
chunk is dropped with no signal. The client then sets `entry.lastSeq` from the replayed
frame's seq (`src/webview/terminals.js:4793`), so the hole is sealed over and nothing
downstream can ever detect it. The operator sees a transcript that reads as continuous and
is not. This is reachable in normal use: backpressure eviction after `HIGH_WATER_GRACE_MS`
(30 s), laptop sleep, a suspended background tab, or any network blip — combined with a
terminal that produced more than 256 KB meanwhile, which a build log, a test run, or a
streaming agent does routinely.

**Defect B — unsafe parse start.** The ring stores whole flush chunks and evicts whole
chunks, so the splice always lands on a *chunk* boundary. A chunk boundary is not an
*escape sequence* boundary. The gateway already knows this and documents it, in the
`scanTerminalModes` carry comment (line 522):

> The carry is load-bearing: pty reads split wherever the kernel says, so `\x1b[?20` and
> `04h` routinely arrive in different chunks and a stateless scan would miss the only
> escape that matters.

The same splitting applies to the replay: the first retained chunk can begin with the tail
of a sequence whose `ESC` was evicted. xterm then parses the orphaned remainder as literal
text — `?2004h` printed into the buffer.

> **Superseded:** "…and worse, a truncated CSI can swallow the printable bytes that follow
> it while it hunts for a final byte."
> **Reason:** That hazard requires a sequence whose `ESC` survives and whose terminator is
> cut — which is what the *input* path does (`findSafeBoundary`, line 301, slices at
> `INPUT_CHUNK_BYTES` and can strand an ESC). Ring eviction removes a **prefix**: if an ESC
> is present in a retained chunk then every byte after it is also retained, so a replay
> payload can only ever lose the *head* of a sequence, never its tail. To a ground-state
> parser an ESC-less remainder is literal text, so nothing is swallowed and no answerback
> can be provoked (an orphaned `[6n` prints; it does not reply).
> **Replaced with:** Defect B's blast radius is **cosmetic**: a bounded run of literal
> junk at the very top of a replay (an orphaned CSI tail such as `?2004h`, or a fragment
> of an OSC 52 base64 payload). It is worth fixing exactly and for free; it is **not**
> worth fixing with a heuristic that can eat real output (see the Proposed Changes).

Defect B is **not** limited to gapped reconnects. A *fresh* attach takes the
`lastSeq > 0 ? … : buffer.chunks` else-branch and replays from the oldest retained chunk,
which is only the true stream origin while the terminal has produced under 256 KB total.
Attaching to any long-running terminal hits this on the first frame.

### Background Context

`nextSeq` is terminal-scoped and starts at 1 (`trackTerminalData`, line 389; the comment
at lines 136-140 records the bug that came from making it per-connection). Chunks are
pushed once per flush and evicted only from the front, so retained seqs are **contiguous**.
That makes `buffer.chunks[0].seq === 1` an exact test for "the ring still holds the stream
origin", and `oldestRetained > lastSeq + 1` an exact test for a gap. Both are cheap and
need no new bookkeeping.

The gateway already owns escape-boundary logic for the *input* path:
`findSafeBoundary` (line 301) and `isEscapeSequenceComplete` (line 327), written to stop
`INPUT_CHUNK_BYTES` slicing from turning `\x1b[200~` into a bare ESC plus literal `[200~`.
Their doc-comment names the same family of hazard in the opposite direction. They operate
on `Buffer` and return a boolean; the replay path holds strings and needs an *index*, so
this needs a sibling rather than a reuse.

The client-side replay path is already carefully sequenced and must not be disturbed:

- `hello` carries `replayChars`, and `entry.ackSuppressChars` burns that budget in
  `onWriteParsed` (line 4998) so replay is not billed to the connection's credit ledger.
- `entry.awaitingReplayFrame` (set on the hello arm at line 4841, consumed in `onmessage`
  at line 4797) routes the next binary frame to `writeReplay` rather than the batch queue.
- `writeReplay` (line 4974) mutes answerback for the replay parse and applies
  `entry.pendingModes` in the write callback — the exact boundary at which the replay has
  been fully consumed and no live chunk has been parsed yet.
- Synthetic client-side writes are deliberately made **without** a write callback
  (`applyServerModes`, line 4072, and its comment at lines 4063-4067): characters the
  server never credited must not reach `onWriteParsed` or they corrupt the ack ledger.

### Verified facts about the vendored parser (`src/webview/vendor/xterm/xterm.js`)

These were read out of the bundle, not assumed, because three design decisions below turn
on them:

1. **`term.reset()` does NOT reset the escape-sequence parser.** `Terminal.reset()` →
   `_core.reset()` → `{ this._setup(); super.reset(); … }` → `CoreTerminal.reset()` =
   `_inputHandler.reset(), _bufferService.reset(), _charsetService.reset(),
   coreService.reset(), coreMouseService.reset()`. `InputHandler.reset()` only re-clones
   `_curAttrData`/`_eraseAttrData`; `_parser.reset()` is called **only** from
   `fullReset()`. So a `term.reset()` issued while the parser sits mid-sequence leaves it
   mid-sequence, and the first bytes of the following write are consumed as that
   sequence's continuation.
2. **RIS (`\x1bc`) does reset the parser, and is ordered in-band.**
   `fullReset(){ return this._parser.reset(), this._onRequestReset.fire(), !0 }`, and the
   browser `Terminal` wires `this._inputHandler.onRequestReset(() => this.reset())`. So RIS
   is a strict superset of `term.reset()`: parser reset **plus** the identical
   buffer/scrollback/DEC-defaults reset — and because it travels through `WriteBuffer` it
   is ordered against the replay write instead of racing it.
3. **ESC aborts whatever the parser was doing.** In `VT500_TRANSITION_TABLE`,
   `e.add(27, o, 11, 1)` is applied for every state `o` — byte 27 → action 11 (CLEAR),
   state 1 (ESCAPE). So RIS recovers even from a half-consumed CSI.
4. **CSI terminates on 0x40–0x7E** (`e.addMany(i(64,127), 3, 7, 0)` — CSI_DISPATCH →
   GROUND), params are 0x30–0x3F, intermediates 0x20–0x2F. **OSC terminates on**
   `[156, 27, 24, 26, 7]` (ST / ESC / CAN / SUB / BEL).

## Metadata

**Complexity:** 6
**Tags:** backend, frontend, bugfix, reliability

## User Review Required

None. Three decisions were taken rather than deferred, and are recorded here so they are
visible without reading the whole plan:

- **A gapped reconnect wipes the visible screen** (RIS) rather than preserving it. The
  content discarded is precisely the content known to be discontinuous with what follows,
  and the retained ring repaints up to 256 KB immediately.
- **The trim is exact, not heuristic.** Where the two conflict, correctness of live output
  wins over suppressing cosmetic junk: when the gateway cannot prove where the orphaned
  remainder ends, it trims nothing and the junk stays.
- **The gap is signalled on pane chrome only** (badge + toast), never written into the
  terminal buffer.

## Complexity Audit

### Routine

- Adding a field to the `hello` control frame, following the existing
  omit-when-absent convention used by `bracketedPaste` and `modes` (line 869-873).
- Adding one number to the `ScrollbackBuffer` interface (line 133) and initialising it in
  `trackTerminalData` (line 389).
- A `console.warn` on the gap branch.
- One more field on `window.__sbTerminalStats` (line 5026), the established diagnosis
  surface for this subsystem.
- A `.pane-badge` colour variant in `src/webview/terminals.html` (line 850) using the
  existing `--state-connecting` semantic token (line 48).

### Complex / Risky

- **A string-domain escape-sequence scanner.** New parser-adjacent code whose failure mode
  in one direction is silent data loss (over-trim) and in the other is unchanged cosmetic
  junk (under-trim). Mitigated by making every ambiguous case bail to "trim nothing", and
  by bounding every scan.
- **Parser-state assumptions.** The trim is only sound when the client's parser is at
  GROUND at the replay's first byte. That is true on a fresh attach and after RIS, and
  **false** on a contiguous reconnect — which is why the trim is gated on the replay
  starting at the ring head (see Proposed Changes, File 1).
- **Writing RIS into a live pane.** Correct only because `applyServerModes` runs *after*
  the replay parses, in `writeReplay`'s callback (line 4984-4987), so the gateway's
  recorded DEC modes overwrite the defaults RIS restored.
- **Badge-map overloading.** `terminalBadges` is not a generic badge map — it is the
  agent-completed signal, and `postFleetStateToShell` (line 665-667) derives
  `light: 'done'` from mere membership. Writing a gap badge into it would light the shell
  rail as if an agent had finished.

## Edge-Case & Dependency Audit

### Race Conditions

- **Hello and replay are one synchronous block.** `setupClient` sends hello then the replay
  frame with no `await` between them (lines 861-888), and a WebSocket preserves order
  across text and binary frames. So the client's "next binary frame is the replay"
  assumption holds, and moving the reset to the hello arm cannot land after the replay.
- **A socket that dies between hello and replay.** `entry.replayGap` is assigned
  unconditionally on every hello (like `awaitingReplayFrame`, line 4841), so a flag armed
  by a dead socket cannot leak into the next connection. `connectWs`'s teardown block
  (lines 4738-4747) additionally clears it alongside the other per-socket windows.
- **Stale batch queue vs. the reset.** With RIS written through `WriteBuffer`, parse order
  is: whatever was already queued → RIS (wipes it) → replay. The net screen state is
  correct in either case, but the queued bytes are pre-gap by definition, so the gap path
  drops the queue instead of flushing it.
- **Concurrent flush during `setupClient`.** Unchanged: the block is synchronous and node
  is single-threaded, so no flush can interleave (the comment at line 876-878 already
  records this).
- **Eviction while a replay is being framed.** Also unchanged — same synchronous window.

### Security

- No new network input is trusted. `replayGap` travels server → client and is read as
  `frame.replayGap === true`, so a malformed or absent field degrades to `false`.
- The scanner is bounded in every direction (`REPLAY_CSI_SCAN_MAX`,
  `REPLAY_BOUNDARY_CARRY_MAX`), so no pty output can drive it into unbounded work — the
  same discipline the `{0,MODE_SCAN_CARRY_MAX}` bound already enforces in
  `scanTerminalModes` (lines 511-520).
- The gap log prints a terminal name and two integers; no pty content is logged.

### Side Effects

- RIS clears the pane's scrollback. Intended, and only on the gap path.
- RIS restores DEC private-mode defaults; `applyServerModes` reasserts the recorded state
  afterwards. Modes the gateway never observed are absent from `modes` and stay at
  xterm's defaults — the rule `applyServerModes` documents at line 4069-4070.
- **Alt screen after a reset.** `REARMABLE_DEC_MODES` (line 4057) deliberately excludes
  1049 in the enable direction, so an app sitting in the alternate buffer is not restored
  to it. **Pre-existing** — every fresh attach already lands in the normal buffer — and
  the reset makes it reachable on gapped reconnects too. Accepted rather than fixed here:
  asserting `?1049h` into a freshly reset xterm switches to an empty alt buffer and hides
  the scrollback the replay just wrote, which `applyServerModes` documents at length
  (lines 4080-4105) as strictly worse than the bug.
- **A TUI does not repaint on demand.** After a gapped reconnect the pane shows the
  replayed ring until the app's next render. That is already today's behaviour on any
  attach; the reset does not make it worse and this plan does not try to force a repaint
  (see the rejected alternative in Adversarial Synthesis).
- `term.reset()` / RIS do not touch `options`, so a read-only exited terminal stays
  read-only and `resolveInputState` is unaffected.
- The RIS write carries no write callback, so it is not billed to `pendingAckChars` —
  matching `applyServerModes`' rule for synthetic writes.

### Dependencies & Conflicts

- **`terminal-rename-rekey-contract.test.js`** derives its collection list from
  `untrackTerminalData` by regex, so any *new name-keyed Map on the gateway* would have to
  be rekeyed or that test fails. This plan adds **no** new gateway map — the new state is
  a field on the existing `ScrollbackBuffer` object, which `rekeyTerminal` (line 634)
  already moves wholesale. Do not "tidy" it into a sibling `Map`.
- **Client-side rename** (`terminals.js:3906-3908`) rekeys `terminalBadges` by hand. The
  new `terminalReplayGaps` set must be rekeyed in the same block; nothing enforces this
  client-side.
- **Sibling plan** `feature_plan_20260807130000_terminal-chrome-writes-corrupt-tui-buffer.md`
  removes the last four client notices from the xterm buffer. This plan must not add a
  fifth: the gap notice goes on pane chrome only. The two plans are independent and can
  land in either order.
- `MODE_SCAN_CARRY_MAX` and `encodeOutputFrame` already exist in the same file. An older
  client that ignores `replayGap` behaves exactly as it does today, and the trim alone
  still removes the parse hazard for it.
- New test script must be registered in `package.json` and added to
  `.github/workflows/integration-tests.yml` — the three sibling terminal contracts are
  wired in both (`test:contract:terminal-flow-control`, `:terminal-answerback`,
  `:terminal-dec-mode-restore`). A test file with no script entry never runs.

## Dependencies

None.

## Adversarial Synthesis

**Risk Summary.** Key risks: an exact-looking trim that actually eats live output (the
original heuristic cut after the first byte in 0x40–0x7E, which is every ASCII letter, and
was gated on a condition true on *every* contiguous reconnect); a `term.reset()` that does
not reset the parser and races the pending write queue; and a gap badge written into the
map that drives the shell's agent-completed light. Mitigations: derive the safe start
**exactly** at eviction time from the evicted chunk's own tail and use it only when the
replay starts at the ring head; reset in-band with RIS (`\x1bc`) from the hello arm; keep
gap state in its own set with its own badge colour. Residual accepted risk: when the
orphaned remainder cannot be resolved within the scan bounds the trim is skipped, leaving
today's cosmetic junk.

## Proposed Changes

### File 1: `src/standalone/terminalWsGateway.ts` — record the safe parse start at eviction

> **Superseded:** A `findSafeReplayStart(text: string): number` helper that scans forward
> from byte 0 of the replay payload and returns `i` at the first `ESC`, `i + 1` at the
> first byte in 0x40–0x7E, or `i + 1` at the first BEL.
> **Reason:** 0x40–0x7E is not "the final byte of an orphaned sequence" — it is every
> ASCII letter and most punctuation. `"build ok"` returns 1 (drops `b`); `"1234 build"`
> skips the digits and the space (none are in range, none are ESC) and returns 6, dropping
> `1234 b`. The heuristic cannot distinguish a sequence tail from plain text because,
> stripped of its introducer, a sequence tail *is* plain text. It also cannot know where
> a multi-chunk OSC payload ends. Worse, its gate (`missed[0].seq > 1`) is satisfied on
> **every** contiguous reconnect — `missed[0].seq === lastSeq + 1 ≥ 2` — so the common
> reconnect path, where nothing was lost and the client's parser is legitimately
> mid-sequence, would lose its first characters on every single reconnect.
> **Replaced with:** the gateway computes the safe start **exactly**, at eviction time,
> from the chunk it is about to discard — the only moment at which the bytes preceding the
> new ring head are still in hand — and stores it as `buffer.headSafeStart`. The replay
> path applies it only when the payload starts at the ring head.

Add the bounds and a pure, exported scanner next to the existing input-path helpers
(after `isEscapeSequenceComplete`, line 346), and export them so they are unit-testable:

```typescript
/**
 * Ceiling on the CSI param/intermediate run the replay boundary scanner will cross.
 *
 * A legitimate CSI is short (`\x1b[?1049;2004;1000;1002;1006h` is 28 bytes). Anything
 * longer is either not a CSI or is unresolvable, and both cases must bail to "trim
 * nothing" rather than guess. Same ceiling and same reason as MODE_SCAN_CARRY_MAX.
 */
export const REPLAY_CSI_SCAN_MAX = 64;

/**
 * Ceiling on the unterminated tail carried across an eviction, and on the forward scan
 * into the new head chunk. Larger than the CSI bound because OSC 52 (clipboard) payloads
 * are legitimately kilobytes; small enough that the per-terminal cost is one 4 KB string
 * held only between an eviction and the next one.
 */
export const REPLAY_BOUNDARY_CARRY_MAX = 4096;

/**
 * Index just past the end of the escape sequence starting at `escIdx`, or -1 when it does
 * not terminate within `text`.
 *
 * The string-domain, index-returning sibling of isEscapeSequenceComplete (line 327). Not
 * merged with it deliberately: that one is on the INPUT hot path, operates on Buffer, and
 * returns a boolean by design. Changing its shape to serve the replay path would churn
 * shipped input-path behaviour for no gain.
 *
 * Terminator sets are taken from the vendored VT500_TRANSITION_TABLE, not from memory:
 * CSI dispatches to GROUND on 0x40-0x7E; OSC ends on ST / ESC / CAN / SUB / BEL.
 */
export function escapeSequenceEnd(text: string, escIdx: number): number {
    let j = escIdx + 1;
    if (j >= text.length) { return -1; }   // bare ESC at the very end
    const introducer = text.charCodeAt(j);

    if (introducer === 0x5b /* [ */) {
        const limit = Math.min(text.length, j + 1 + REPLAY_CSI_SCAN_MAX);
        for (let k = j + 1; k < limit; k++) {
            const c = text.charCodeAt(k);
            // ESC aborts the sequence (transition table: byte 27 -> CLEAR/ESCAPE from
            // every state). Bail rather than pretend to know where the abort leaves us.
            if (c === 0x1b) { return -1; }
            if (c >= 0x40 && c <= 0x7e) { return k + 1; }
            if (c < 0x20 || c > 0x3f) { return -1; }  // not a param/intermediate byte
        }
        return -1;
    }

    // OSC (ESC ]) and the string families DCS/APC/PM/SOS (ESC P / _ / ^ / X). All end on
    // ST (ESC \) and OSC also on BEL. ESC alone is treated as the terminator, consuming a
    // following `\` when present — the one-byte ambiguity is accepted: over-consuming a
    // lone trailing `\` costs one character at the very top of a replay, and refusing to
    // resolve it at all would leave the whole OSC payload printed as junk.
    if (introducer === 0x5d /* ] */ || introducer === 0x50 /* P */
        || introducer === 0x5f /* _ */ || introducer === 0x5e /* ^ */
        || introducer === 0x58 /* X */) {
        const limit = Math.min(text.length, j + 1 + REPLAY_BOUNDARY_CARRY_MAX);
        for (let k = j + 1; k < limit; k++) {
            const c = text.charCodeAt(k);
            if (c === 0x07 /* BEL */ || c === 0x18 /* CAN */ || c === 0x1a /* SUB */) { return k + 1; }
            if (c === 0x9c /* ST, 8-bit */) { return k + 1; }
            if (c === 0x1b) { return text.charCodeAt(k + 1) === 0x5c ? k + 2 : k + 1; }
        }
        return -1;
    }

    // ESC <intermediate> <final> (ESC ( B, ESC # 8 …): one more byte closes it.
    if (introducer >= 0x20 && introducer <= 0x2f) { return j + 2 <= text.length ? j + 2 : -1; }

    // Two-byte escape (ESC c, ESC 7, ESC =): the introducer itself closes it.
    return j + 1;
}

/**
 * The trailing fragment of `text` that is an escape sequence still open at its end, or ''
 * when `text` ends at a clean boundary.
 *
 * Called ONCE PER EVICTION, over the chunk being discarded — the last moment at which the
 * bytes preceding the new ring head still exist. Returns '' (give up) when the open
 * sequence is longer than REPLAY_BOUNDARY_CARRY_MAX, which degrades to today's behaviour
 * rather than to a guess.
 */
export function unterminatedEscapeTail(text: string): string {
    const escIdx = text.lastIndexOf('\x1b');
    if (escIdx === -1) { return ''; }
    if (escapeSequenceEnd(text, escIdx) !== -1) { return ''; }
    const tail = text.slice(escIdx);
    return tail.length > REPLAY_BOUNDARY_CARRY_MAX ? '' : tail;
}

/**
 * Offset into `head` at which a parser starting COLD can safely begin, given `carry` — the
 * unterminated tail of the chunk immediately before it.
 *
 * Returns 0 whenever the remainder cannot be resolved inside the bounds. That direction is
 * deliberate and asymmetric: an under-trim leaves the cosmetic junk this exists to remove,
 * an over-trim deletes real pty output. Only the first is acceptable.
 */
export function replaySafeStart(carry: string, head: string): number {
    if (!carry) { return 0; }
    const combined = carry + head.slice(0, REPLAY_BOUNDARY_CARRY_MAX);
    const end = escapeSequenceEnd(combined, 0);
    if (end === -1) { return 0; }
    return Math.max(0, Math.min(head.length, end - carry.length));
}
```

Extend `ScrollbackBuffer` (line 133) with the recorded offset:

```typescript
interface ScrollbackBuffer {
    chunks: ScrollbackChunk[];
    totalBytes: number;
    /**
     * Offset into chunks[0].data at which a COLD parser can safely start.
     *
     * Non-zero only after an eviction that cut an escape sequence in half. 0 while the
     * ring still holds the stream origin, which is why an origin replay is never trimmed.
     *
     * A field on the buffer, NOT a sibling Map keyed by terminal name: rekeyTerminal
     * (line 634) moves the buffer wholesale, and terminal-rename-rekey-contract.test.js
     * derives its collection list from untrackTerminalData — a new name-keyed Map would
     * have to be threaded through both.
     */
    headSafeStart: number;
    nextSeq: number;
}
```

Initialise it in `trackTerminalData` (line 389):

```typescript
const buffer: ScrollbackBuffer = { chunks: [], totalBytes: 0, headSafeStart: 0, nextSeq: 1 };
```

Compute it in the eviction loop (`flushOutput`, line 463):

```typescript
while (buffer.totalBytes > MAX_SCROLLBACK_BYTES && buffer.chunks.length > 1) {
    const removed = buffer.chunks.shift()!;
    buffer.totalBytes -= removed.data.length;
    // The bytes before the new head are about to stop existing. This is the only
    // moment at which "does the new head begin mid-sequence" is answerable exactly
    // rather than guessed from the head's own bytes — stripped of its introducer, a
    // sequence tail is indistinguishable from plain text.
    buffer.headSafeStart = replaySafeStart(unterminatedEscapeTail(removed.data), buffer.chunks[0].data);
}
```

Cost is one `lastIndexOf` plus a bounded forward scan **per eviction**, and nothing at all
on the flush path when the ring is not full. `removed.data` may itself carry a leading
remainder from an earlier eviction; that region ends at its own terminator and cannot
strand a later ESC, so scanning the whole string is correct.

Rewrite the replay resolution in `setupClient` (lines 843-855):

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
        // Seqs are contiguous (one per flush, evicted only from the front), so this
        // comparison is exact, not a heuristic.
        replayGap = lastSeq > 0 && oldestRetained > lastSeq + 1;
        const missed = lastSeq > 0
            ? buffer.chunks.filter(c => c.seq > lastSeq)
            : buffer.chunks;
        if (missed.length > 0) {
            const replaySeq = missed[missed.length - 1].seq;
            let combined = missed.map(c => c.data).join('');
            // Trim ONLY when the payload starts at the RING HEAD, which is exactly
            // when the receiving parser is at GROUND: a fresh attach builds a new
            // xterm, and a gapped reconnect is preceded by RIS on the client.
            //
            // On a CONTIGUOUS reconnect the payload starts mid-ring against the SAME
            // xterm instance, whose parser may legitimately be mid-sequence from the
            // chunk it already consumed — the continuation is parsed correctly and
            // trimming it would corrupt the common path. headSafeStart is 0 while the
            // ring still holds the origin, so this also leaves an origin replay
            // byte-identical.
            if (missed.length === buffer.chunks.length && buffer.headSafeStart > 0) {
                combined = combined.slice(buffer.headSafeStart);
            }
            // AFTER the trim. replayChars is the client's ackSuppressChars budget
            // and it must equal what the client actually writes, or the ledger
            // drifts by the trimmed bytes on every attach.
            replayChars = combined.length;
            if (replayChars > 0) {
                replayFrame = encodeOutputFrame(replaySeq, combined);
            }
        }
        if (replayGap) {
            // The client-side badge tells the operator; this is what makes the drop
            // diagnosable afterwards, since it is otherwise invisible in every log.
            console.warn(
                `[TerminalWsGateway] Scrollback gap on ${terminal.name}: client lastSeq=${lastSeq}, ` +
                `oldest retained seq=${oldestRetained} — ${oldestRetained - lastSeq - 1} frame(s) evicted before reattach`
            );
        }
    }
```

> **Superseded:** "`console.warn` the terminal name, the client's `lastSeq`, the oldest
> retained seq, and the byte count of the hole."
> **Reason:** The byte count of the hole is not knowable. The evicted chunks' lengths were
> subtracted from `totalBytes` and the strings were released; nothing retains a per-seq
> byte tally, and a cumulative `evictedBytes` counter could not be attributed to this
> particular seq range either.
> **Replaced with:** log the **frame count** of the hole (`oldestRetained - lastSeq - 1`),
> which is exact and derivable from data still in hand.

Add `replayGap` to the `hello` frame beside `replayChars` (line 868), omitted when false to
match the frame's existing convention for `bracketedPaste` and `modes`:

```typescript
            replayChars,
            ...(replayGap ? { replayGap: true } : {}),
```

### File 2: `src/webview/terminals.js` — reset in-band, before the replay

> **Superseded:** Record `entry.replayGap` on the hello arm, then in the replay branch of
> `onmessage` call `flushBatch(entry)`, `entry.term.reset()`, and `writeReplay(entry, text)`.
> **Reason:** Two defects. (1) `term.reset()` does not reset the escape-sequence parser —
> only `fullReset()` calls `_parser.reset()`, and `Terminal.reset()` never reaches it (see
> "Verified facts", item 1). A gapped reconnect whose last write left the parser mid-CSI
> therefore feeds the replay's first bytes into that stale sequence, which is the exact
> failure the plan set out to prevent. (2) `term.reset()` is a direct API call while
> `flushBatch`'s `term.write` is queued in `WriteBuffer`, so the reset executes *before*
> the bytes it was meant to supersede are parsed, and the stale tail lands on the freshly
> cleared screen.
> **Replaced with:** write RIS (`\x1bc`) through the write queue from the **hello arm**,
> and drop the stale batch rather than flushing it. RIS resets the parser as well as the
> buffer, recovers even from a half-consumed sequence (ESC aborts from every parser
> state), and is ordered against the replay write instead of racing it. Doing it on hello
> — which the gateway sends synchronously before the replay frame — also covers the case
> where there is no replay frame at all.

On the hello arm (after `entry.awaitingReplayFrame` is assigned, line 4841):

```javascript
                    // The ring evicted output this connection never saw, so what is
                    // already on screen is not contiguous with what is about to be
                    // written. Splicing the two produces a transcript that READS
                    // continuous and is not, and leaves the parser holding state from
                    // before the hole.
                    //
                    // RIS rather than term.reset(): term.reset() does NOT reset the
                    // escape-sequence parser (only fullReset() calls _parser.reset(),
                    // and Terminal.reset() never reaches it), so it cannot guarantee the
                    // clean parse start this whole change exists to provide. RIS also
                    // travels through WriteBuffer, so it is ORDERED before the replay
                    // write instead of racing it, and an ESC aborts whatever the parser
                    // was mid-way through.
                    //
                    // No write callback, deliberately: these two characters were never
                    // credited by the server, and billing them to pendingAckChars would
                    // corrupt the backpressure ledger — the same rule applyServerModes
                    // follows for its synthetic writes.
                    //
                    // Safe against the mode-restore path: RIS restores DEC defaults, and
                    // writeReplay's callback applies the gateway's recorded `modes` AFTER
                    // the replay parses — so the authoritative state still wins, in the
                    // right order. When there is no replay to wait for, the inline
                    // applyServerModes below does the same job.
                    if (frame.replayGap === true) {
                        // Pre-gap output from the dead socket. Superseded by definition —
                        // dropped rather than flushed, so it cannot be parsed after RIS.
                        entry.batchQueue = [];
                        try { entry.term.write('\x1bc'); } catch { /* disposed */ }
                        markReplayGap(entry.name);
                    }
```

Placing this **before** the `applyServerModes` call already on that arm (line 4857) keeps
the no-replay case correct: RIS clears, then the recorded modes are reasserted inline.

Clear the per-socket flag in `connectWs`'s teardown block (beside
`entry.awaitingReplayFrame = false`, line 4744) so a socket that died mid-handshake cannot
leave gap state behind:

```javascript
        entry.replayGap = false;
```

The replay branch of `onmessage` (line 4797) is **unchanged** — with the reset moved to
hello, it keeps its existing `flushBatch` → `writeReplay` sequence for the normal path.

Add `markReplayGap` beside the other pane-chrome helpers, and its own state:

> **Superseded:** "`markReplayGap` surfaces the loss on the pane chrome … A toast plus a
> header badge (`terminalBadges` / `.pane-badge`, already used for `DONE`) is the whole
> signal." (`markReplayGap` was referenced but never defined.)
> **Reason:** `terminalBadges` is not a generic badge map — it is the agent-completed
> signal. `postFleetStateToShell` (line 665-667) derives `light: 'done'` from mere
> membership, so a gap badge would report a finished agent to the shell rail; `.pane-badge`
> is `--accent-teal`, which reads as success; and the map holds one value per terminal, so
> a gap would silently overwrite a real `DONE` (and vice versa).
> **Replaced with:** a separate `terminalReplayGaps` set with its own amber badge,
> rendered alongside `DONE` rather than instead of it, and invisible to
> `postFleetStateToShell`.

```javascript
    /** Terminals whose last reattach spliced over evicted output. Deliberately NOT
     *  terminalBadges: that map is the agent-completed signal and feeds the shell rail's
     *  `done` light (postFleetStateToShell), so a gap recorded there would report a
     *  finished agent. */
    const terminalReplayGaps = new Set();

    /**
     * Surface an unrecoverable scrollback gap on the PANE CHROME.
     *
     * Never written into the terminal buffer: a notice injected there lands inside a
     * screen the CLI believes it owns and shifts the row count its next relative redraw
     * depends on — the defect the sibling chrome-writes plan exists to remove.
     */
    function markReplayGap(terminalName) {
        terminalReplayGaps.add(terminalName);
        renderSidebarList();
        renderPaneGrid();
        showPaneToast(`${terminalName}: scrollback gap — screen reset (output was evicted while disconnected)`);
    }
```

`showPaneToast` (line 885) is called with no `onUndo`, which hides its Undo button — the
established pattern for a non-undoable notice.

Render the badge at both existing badge sites, additively:

- sidebar (`renderSidebarList`, after the `terminalBadges` block at lines 1253-1258)
- pane header (`renderPaneGrid`, after the block at lines 2506-2511)

```javascript
        if (terminalReplayGaps.has(item.friendlyName)) {
            const gapBadge = document.createElement('span');
            gapBadge.className = 'pane-badge is-gap';
            gapBadge.textContent = 'GAP';
            gapBadge.title = 'Output was evicted while this pane was disconnected — the screen was reset rather than spliced';
            info.appendChild(gapBadge);
        }
```

Clear the flag wherever `terminalBadges` is already cleared for the same reason — the
operator has looked at the pane, so the notice has been delivered:

| Site | Line | Action |
| :--- | :--- | :--- |
| focus an already-seated terminal | 1780 | `terminalReplayGaps.delete(terminalName)` |
| seat a terminal into a pane | 1866-1868 | `terminalReplayGaps.delete(terminalName)` |
| rename rekey | 3906-3908 | move the entry from `name` to `next` |
| close terminal | 3969 | `terminalReplayGaps.delete(name)` |
| clear one terminal | 3984 | `terminalReplayGaps.delete(name)` |
| clear all terminals | 4012-4016 | `terminalReplayGaps.clear()` |

The rename site is the one with no test behind it — the gateway's rekey contract only
covers gateway-side collections.

Add the flag to the diagnosis surface (`window.__sbTerminalStats`, line 5026), beside
`ackSuppressChars`:

```javascript
                replayGapped: terminalReplayGaps.has(name),
```

### File 3: `src/webview/terminals.html` — a badge colour that does not read as success

Add one rule after `.pane-badge` (line 850):

```css
        /* Semantic status, not brand accent — a gap is a warning, and reusing
           --accent-teal would make a lost-output notice look like DONE. Same token
           family and same reasoning as the input-state chip (line 44-49). */
        .pane-badge.is-gap {
            background: var(--state-connecting);
        }
```

`--state-connecting` (line 48) is deliberately outside the theme-swapped accent family, so
the badge reads amber in both the default and `theme-claudify` palettes.

## Verification Plan

### Automated Tests

> **Superseded:** "New `src/test/terminal-replay-gap-contract.test.js`, exercising the
> gateway directly (the replay path is pure Node and needs no browser)."
> **Reason:** The tests are plain `node` scripts run against source, and
> `terminalWsGateway.ts` is TypeScript — the three sibling terminal contracts
> (`terminal-flow-control`, `terminal-answerback-replay`, `terminal-dec-mode-restore`) all
> read the `.ts` as **text** and assert on source structure for exactly this reason.
> Requiring the gateway means `npm run compile-tests` first and a fake `PtyFleetService`
> plus a fake `ws`; two tests do take that route (`require('../../out/…')`), so it is
> available, but only worth paying for the pure helpers.
> **Replaced with:** a source-text contract for the wiring, plus behavioural unit cases
> for the three exported pure functions via `out/`. Both live in one file, and the file is
> registered in `package.json` and the CI workflow — a test with no script entry never
> runs.

New `src/test/terminal-replay-gap-contract.test.js`, following the sibling files' harness
(`fs.readFileSync` + a `block(code, start, end)` slicer + a local `test()` counter):

**Behavioural — the exported helpers** (`require('../../out/standalone/terminalWsGateway')`,
after `npm run compile-tests`):

1. **`escapeSequenceEnd`** — `'\x1b[?2004h'` at 0 → 8; `'\x1b[?2004'` → -1 (no final
   byte); `'\x1b]0;title\x07rest'` → index past BEL; `'\x1b]0;title\x1b\\rest'` → index
   past ST; `'\x1bc'` → 2 (two-byte escape); `'\x1b(B'` → 3 (intermediate + final);
   `'\x1b'` → -1; a CSI param run longer than `REPLAY_CSI_SCAN_MAX` → -1; an ESC inside a
   CSI → -1.
2. **`unterminatedEscapeTail`** — plain text → `''`; text ending `…\x1b[?20` → `'\x1b[?20'`;
   text ending in a *complete* sequence → `''`; text with no ESC at all → `''`; an open
   sequence longer than `REPLAY_BOUNDARY_CARRY_MAX` → `''` (gives up rather than guesses).
3. **`replaySafeStart`** — `('', 'anything')` → 0 (no carry, never trims);
   `('\x1b[?20', '04h then real output')` → 3, i.e. exactly past the `h`;
   `('\x1b]0;ti', 'tle\x07rest')` → past the BEL; `('\x1b[?20', 'no terminator here…')`
   → 0 (unresolvable → no trim). **The load-bearing one:** `('', 'build ok')` → 0 and
   `('', '1234 build ok')` → 0 — plain output is never trimmed, which is precisely what
   the superseded heuristic got wrong.

**Behavioural — the ring** (construct the gateway with a stub fleet service exposing
`list() → []`, `onDidChange()`, `get(name)`; drive `flushOutput` via the tracked `onData`
closure; call `gateway.dispose()` in a `finally`):

4. **`headSafeStart` is 0 while the origin is retained**, and becomes non-zero only after
   an eviction that cut a sequence — seed a chunk ending `'\x1b[?20'` followed by one
   starting `'04h…'`, force eviction, assert the offset points past the `h`.
5. **`headSafeStart` stays 0 when the eviction lands on a clean boundary.**

**Source-text — the wiring** (assertions on `terminalWsGateway.ts` and `terminals.js` as
text, scoped with `block()`):

6. **The trim is gated on the ring head, not on `seq > 1`.** Assert the `setupClient`
   block contains `missed.length === buffer.chunks.length` and does **not** contain a
   `missed[0].seq > 1` gate — the regression that would corrupt every contiguous
   reconnect.
7. **`replayChars` is assigned after the slice.** Assert the index of the
   `combined.slice(` call precedes the `replayChars = combined.length` assignment inside
   the same block — the ack-ledger invariant.
8. **`replayGap` uses the exact comparison** `oldestRetained > lastSeq + 1`, and rides the
   hello frame conditionally (`...(replayGap ? { replayGap: true } : {})`) rather than
   being sent as `false`.
9. **The gap log names both seqs and a frame count**, and does not claim a byte count.
10. **The client resets in-band, on the hello arm, before the replay.** Assert the hello
    arm block contains `entry.term.write('\x1bc')`, that it does **not** contain
    `term.reset()`, that `entry.batchQueue = []` appears on the same branch, and that the
    `markReplayGap` call is inside it. Assert the RIS write has no write callback (no `,`
    + arrow inside the `write('\x1bc'` call) so the ack ledger stays clean.
11. **The gap flag is per-socket.** Assert `entry.replayGap = false` appears in the
    `connectWs` teardown block alongside `entry.awaitingReplayFrame = false`.
12. **Gap state is not in `terminalBadges`.** Assert `markReplayGap`'s body touches
    `terminalReplayGaps` and not `terminalBadges`, and that `postFleetStateToShell` still
    derives its `done` light from `terminalBadges` only.
13. **Every `terminalBadges` clear site has a `terminalReplayGaps` counterpart.** Derive
    the site list by regex (`terminalBadges.delete(`, `terminalBadges.clear()`) and assert
    a matching `terminalReplayGaps` call within a small window of each — the drift guard,
    modelled on the rename-rekey contract's derived-collection assertion.
14. **The badge does not reuse the success colour.** Assert `terminals.html` defines
    `.pane-badge.is-gap` and that its declaration references `--state-connecting`, not
    `--accent-teal`.

Register the file as `test:contract:terminal-replay-gap` in `package.json` (alongside
`test:contract:terminal-flow-control`, line 829) and add the step to
`.github/workflows/integration-tests.yml` next to the sibling terminal contracts
(lines 348 / 377 / 432).

`terminal-flow-control-contract.test.js`, `terminal-answerback-replay-contract.test.js` and
`terminal-dec-mode-restore-contract.test.js` must all stay green — the `ackSuppressChars`
budget and the post-replay `applyServerModes` ordering are exactly what this change threads
through. Extend the answerback file with one assertion that the RIS write precedes
`writeReplay` in document order.

### Manual Verification

1. Start a terminal and run a generator that overruns the ring quickly
   (`yes "$(head -c 200 /dev/urandom | base64)"`).
2. With it running, kill the browser tab's WebSocket (DevTools → Network → the terminal
   socket → close) and leave it closed long enough to push more than 256 KB.
3. Reconnect. **Verify:** the pane shows the amber `GAP` badge and a toast, the screen is
   reset rather than spliced, and the visible transcript is internally consistent — no
   half-line seam where the splice landed.
4. **Verify:** the standalone host logged the terminal name, both seqs, and the **frame
   count** of the hole.
5. **Verify:** the badge is amber and distinct from a `DONE` badge, and that a terminal
   carrying both shows both. **Verify** the shell rail's light for that terminal is not
   reported as `done` (inspect `postFleetStateToShell`'s payload, or the rail itself).
6. Attach a second surface to a terminal that has already produced well over 256 KB.
   **Verify:** the top of the replayed scrollback shows no literal `?2004h`-style
   fragment, and the rest of the pane renders normally.
7. Reconnect with no gap (close and immediately reopen the socket). **Verify:** no reset,
   no badge, no toast, and scrollback continues seamlessly with **no missing characters at
   the seam** — this is the path the superseded heuristic would have corrupted, so read
   the first line after the reconnect carefully.
8. Run a full-screen CLI (Claude Code), force a gapped reconnect as above. **Verify:** the
   CLI's UI redraws correctly once it next renders (press a key if it is idle — the pane
   legitimately shows replayed frame history until then), bracketed paste still works
   (mode restore survived RIS), and a multi-line paste lands as one block.
9. Click into the gapped pane. **Verify:** the badge clears.
10. Rename a terminal that is carrying a `GAP` badge. **Verify:** the badge follows the new
    name and does not strand on the old one.

---

**Recommendation: Send to Lead Coder.** (Complexity 6 sits in Coder range, but the change
turns on verified parser internals and one wrong comparison silently corrupts the common
reconnect path — see the two correctness supersessions above.)
