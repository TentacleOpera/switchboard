# A content-free heartbeat eats two thirds of the scrollback ring, and a working seat looks dead

## Goal

Stop content-free redraw frames consuming the terminal scrollback ring, and give the operator a truthful signal that a silent seat is still working. A coding lead running devin emits ~12 no-op frames per second and no text at all while it works; those frames evict the real history that the operator actually needs, and the pane's stillness is indistinguishable from a dead terminal.

### The problem, as measured

The operator loses insight into the coding lead. The pane stops changing mid-run while the lead is demonstrably alive — it is still relaying prompts to its team members — and neither a Terminals refresh nor a full browser reload recovers it. When the feature completes, the display fills with the real output at once.

**Measured on the affected seat** (`Coding`, role `lead`, `devin --permission-mode bypass`), by attaching a WebSocket client to `/ws/terminal` and sampling the live stream for 15 seconds:

| | |
|---|---|
| frames | 183 (12.2/s) |
| bytes | 6,475 (432 B/s) |
| synchronized-update cycles | 185 |
| **printable characters** | **0** |

Every frame is the same 30-byte sequence:

```
ESC[?2026h  ESC[3B  ESC[3A  CR  ESC[2C  ESC[?25h  ESC[?2026l
```

That is: begin synchronized update (DEC 2026), cursor down 3, cursor up 3, carriage return, cursor forward 2, show cursor, end synchronized update. It contains **no glyph**. Net cursor effect is "column 2 of the current row" — the same position it already held.

**So the pane is not frozen and Switchboard is not dropping anything.** It renders exactly what arrives, and what arrives is a heartbeat that paints nothing. The stillness is accurate. The operator's inference that the terminal is "stuck" is the only wrong part, and it is a reasonable inference because nothing distinguishes this from a wedged pane.

### Ruled out by measurement, not reasoning

Three plausible causes were tested and eliminated. Recording them so they are not re-investigated:

- **Server-side backpressure, client eviction, or a wedged pty.** Every one of those paths `console.warn`s. A 9.4 MB `server.log` contains **zero** `TerminalWsGateway` lines and no exceptions. `seq` was 133,044 and climbing — the gateway is streaming normally.
- **Alternate-screen divergence on reattach.** The gateway's recorded modes for the seat are `{"1004":true,"1049":false,"2004":true}`. Mode **1049 is false** — the app is not in the alt buffer, so the known one-directional re-arm gap in `applyServerModes` (`terminals.js:9388`) is not in play here.
- **A wedged synchronized update.** The 256 KB replay contains 5,687 `?2026h` and 5,687 `?2026l` — **perfectly balanced**, ending on a close. No client can be trapped mid-frame by this replay.

### Root cause

**The ring stores frames, and judges them only by byte count.** `flushOutput` (`terminalWsGateway.ts:596`) appends every coalesced chunk to the scrollback buffer and evicts from the head once `totalBytes > MAX_SCROLLBACK_BYTES` (256 KB). Nothing distinguishes a frame that changes the screen from one that does not.

At 12 heartbeats per second, 30 bytes each, an idle seat writes ~21 KB per minute of pure no-op into a 256 KB ring. Measured on the live ring: **5,687 spinner cycles occupy ~170,610 of 262,040 bytes — 65% of the scrollback is content-free heartbeat.** Only 43,718 printable characters survive in the whole ring, and the oldest real output has been evicted by animation frames.

That is the operator-visible harm and it is entirely ours: reattach after a long run and the replay is mostly cursor wiggles, so the recovered history is a fraction of the 256 KB the constant implies.

**The second half is a missing signal, not a missing byte.** Switchboard already knows the seat is alive — the gateway has a live pty handle, `seq` is advancing, and the lead is dispatching to its team. Nothing surfaces that. A pane that has received 12 frames per second for ten minutes and zero printable characters is a state the product can name, and today it looks identical to a hung terminal.

## Metadata

- **Complexity:** 5
- **Tags:** backend, frontend, ux, reliability, performance

## User Review Required

None. Two decisions are made here:

1. **Collapse, do not drop.** A run of identical content-free frames is replaced by its last member in the ring, not discarded outright. The final frame carries the cursor's resting position and the `?25h` cursor-visible state; dropping the run entirely would leave a replayed pane with the cursor in the wrong column and possibly hidden.
2. **Collapse in the ring only — never on the wire.** The live stream is forwarded unchanged. Filtering bytes en route would desync xterm's parser from the app's own belief about its screen state, which is the rule `ptyFleetService.ts:396` already states for the alt-screen case. This changes what is *retained*, not what is *sent*.

## Complexity Audit

### Routine

- Detecting a content-free frame: no printable characters after CSI/OSC/DCS removal.
- Replacing a run of byte-identical content-free frames with its last member on append.
- A "no output for N seconds" derivation from data the gateway already holds.

### Complex / Risky

- **"Content-free" must be exact, not heuristic.** A frame carrying a single space, a backspace-over-write, or an SGR change that alters colour is *not* content-free. Erring wide silently deletes real history — the opposite of this plan's purpose. Restrict the collapse to frames that are byte-identical to their predecessor and contain no printable character, which is provably safe and covers the measured case.
- **Interaction with `headSafeStart`.** Eviction currently recomputes a replay-safe start from the removed chunk's unterminated escape tail (`:628`). Collapsing changes which chunks exist, so that computation must be re-derived over the collapsed sequence, not the raw one.
- **Sequence numbers.** `seq` is the client's resume cursor. Collapsing must not renumber or reuse a `seq` a client may already hold, so collapse operates on ring storage while `nextSeq` continues to advance monotonically.

## Edge-Case & Dependency Audit

- **A seat that emits a heartbeat *and* real output interleaved.** The run-collapse only fires on consecutive identical frames, so any real output between heartbeats breaks the run and is preserved.
- **Different CLIs, different heartbeats.** The rule is byte-identity, not a devin-specific pattern; `claude` and `agy` are unaffected because they do not emit this frame. Do not special-case a CLI.
- **A client resuming from `lastSeq`.** Resume must still yield a coherent stream after collapse — assert a mid-run resume renders identically to a full replay.
- **Mode 2026 is not in `TRACKED_DEC_MODES`.** It does not need to be for this plan (the measured blocks are balanced), but note that a client attaching mid-block has no recorded state to restore. Out of scope, recorded so it is not mistaken for an oversight.
- **The silence signal must not fire on a genuinely idle seat** that nobody dispatched to. Gate it on the seat holding work, not on stream silence alone.

## Dependencies

- **Related, not blocking:** the `?1049h` re-arm gap in `applyServerModes` is real and documented in-code, but is not this bug and is not exercised by this seat. If a TUI seat is ever seen with `1049: true`, that is a separate plan.
- **Related:** `The "Seat Has Gone Quiet" Notice Flaps, and Every Flap Wakes the Lead` (PLAN REVIEWED, in *Dispatch prompt and completion handshake*). That plan concerns an existing quiet-notice that fires too often toward the lead. This plan's signal is operator-facing and read-only. They must not grow into two competing definitions of "quiet" — settle on one predicate and have both consume it.
- **Related:** `Remove Silence-Based "Blocked" State from the Kanban` (PLAN REVIEWED). That plan removes silence as a *board* signal because it cannot distinguish thinking from stuck. This plan does not reintroduce it: the pane already knows the seat is alive from `seq` advancing, so the signal here is "working, no output", which is an assertion, not an inference from absence.

## Adversarial Synthesis

Key risks. (1) An over-wide content-free test deletes real scrollback, which is worse than the bug — mitigation: byte-identity plus zero printables, and a test that asserts a single-space frame survives. (2) Collapsing breaks `headSafeStart` and a replay begins mid-escape, corrupting the pane — mitigation: recompute over the collapsed sequence and assert the existing replay-safety tests still pass. (3) A new "seat is quiet" surface duplicates the existing quiet-notice and the two disagree — mitigation: named as a dependency above, one predicate consumed twice. (4) The fix is validated against a synthetic heartbeat and misses devin's real frame — mitigation: the exact 30-byte sequence is recorded in this plan and is the fixture.

## Proposed Changes

### `src/standalone/terminalWsGateway.ts` — `flushOutput` (:596)

- Before the ring append, if the incoming chunk is byte-identical to the ring's tail chunk and contains no printable character, replace the tail rather than pushing a new entry. Adjust `totalBytes` accordingly.
- Recompute `headSafeStart` over the collapsed chunk sequence on eviction.
- Leave the client fan-out, `seq` assignment and flush observers untouched — the wire and the terminal log are unchanged.

### Operator signal

- Derive "dispatched, alive, no printable output for N seconds" from state the gateway already holds (`seq` advancing, pty handle live, seat holding a card) and surface it on the pane. Consume the same quiet predicate as the seat-quiet notice rather than defining a second one.

## Files Changed

- `src/standalone/terminalWsGateway.ts` — ring collapse and `headSafeStart` recomputation
- `src/webview/terminals.js` — the pane-level "working, no output" affordance
- Tests — collapse correctness, replay fidelity, and the negative cases

## Verification Plan

1. **The measured frame collapses.** Feed 5,000 copies of the exact 30-byte devin heartbeat; assert the ring holds one, `totalBytes` reflects one, and the replayed cursor position matches the uncollapsed stream.
2. **Real content is never collapsed.** A frame containing a single space, and two frames differing only in an SGR colour, both survive intact.
3. **Interleaving breaks the run.** heartbeat, text, heartbeat yields three ring entries.
4. **Replay fidelity is unchanged.** Full replay and a `lastSeq` resume both render identically to the pre-change behaviour for a stream with no heartbeats.
5. **Scrollback depth recovers.** Against the recorded live sample, assert retained printable characters increase materially versus today's 43,718 in 262,040 bytes.
6. **The wire is untouched.** Assert the bytes sent to clients and to the terminal log writer are identical before and after.
7. **Both hosts.** The gateway is standalone-only today, but the pane affordance is shared — verify in both composition roots by hand.
