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

Two decisions are settled here, and two raised by this review for confirmation:

1. **Collapse, do not drop.** A run of content-free frames is replaced by its last member in the ring, not discarded outright. The final frame carries the cursor's resting position and the `?25h` cursor-visible state; dropping the run entirely would leave a replayed pane with the cursor in the wrong column and possibly hidden.
2. **Collapse in the ring only — never on the wire.** The live stream is forwarded unchanged. Filtering bytes en route would desync xterm's parser from the app's own belief about its screen state, which is the rule `ptyFleetService.ts:393-394` already states for the alt-screen case. This changes what is *retained*, not what is *sent*.
3. **[user] Signal derivation: client-side vs server-side.** This review found the plan's "derive from state the gateway already holds" framing unsound (the gateway holds no dispatch/card state, and `lastDataAt` is heartbeat-blind — see Adversarial Synthesis). The recommended replacement is **client-side** in `terminals.js`: the webview already parses every frame for xterm and already knows per-card `working`/`dispatched_terminal` from the kanban. Proceeding on the assumption that the client-side approach is acceptable unless the operator needs the signal when no webview is open (it does not — the signal is operator-facing by definition).
4. **[user] Signal threshold N.** Proceeding on the assumption that N = `turnEndSilenceMs` (default 90 s, configurable via the existing `activityLight` knob family) is the right floor — short enough to surface a heartbeating-but-silent seat before it reads as dead, long enough not to flap on a normal read/think/act cycle.

## Complexity Audit

### Routine

- Detecting a content-free frame: no printable characters after CSI/OSC/DCS removal.
- Replacing a run of byte-identical content-free frames with its last member on append.
- A "no printable output for N seconds" derivation in the webview, modelled on the existing `bumpStartupCurtain`/`sawLiveOutput` timer pattern.

### Complex / Risky

- **"Content-free" must be exact, not heuristic.** A frame carrying a single space, a backspace-over-write, or an SGR change that alters colour is *not* content-free. Erring wide silently deletes real history — the opposite of this plan's purpose. The collapse gate is: **zero printable characters after CSI/OSC/DCS removal, AND the tail chunk is itself content-free.** Byte-identity is kept as a cheap fast-path equality check for the steady state (one heartbeat per flush chunk), but it must NOT be the sole gate — see the coalescing bullet below.
- **Coalescing breaks byte-identity.** The ring stores *coalesced* chunks, not raw frames. At 12.2 fps and a 6 ms flush window the steady state is ~1 heartbeat per chunk, but under event-loop pressure the pty buffers and two-to-three heartbeats land in one flush, producing a 60–90 byte chunk that is not byte-identical to a 30-byte tail. A byte-identity-only gate would let both survive and the scrollback recovery degrades exactly when the seat is under load. The collapse therefore fires on **content-free-ness of both chunks**, not on byte-equality; byte-identity is the fast path, content-free-ness is the correctness gate.
- **Interaction with `headSafeStart` — no new code required.** Eviction recomputes a replay-safe start from the removed chunk's unterminated escape tail (`:628`, `unterminatedEscapeTail(removed.data)` + `replaySafeStart(..., buffer.chunks[0].data)`). That computation already runs over whatever chunks sit in the ring; a collapsed tail is just a chunk whose data is the last content-free frame, and its escape tail is that frame's tail — which is the correct replay state. No re-derivation or new logic is needed; the existing eviction loop handles collapsed chunks transparently.
- **Sequence numbers.** `seq` is the client's resume cursor. Collapsing must not renumber or reuse a `seq` a client may already hold, so collapse operates on ring storage while `nextSeq` continues to advance monotonically: the wire frame consumes a fresh `nextSeq++` (sent to clients and flush observers unchanged), and the ring tail chunk is replaced with the new data **and** the new seq. A client resuming from the old tail's `lastSeq` finds the new `seq > lastSeq` and renders the latest cursor state; the intermediate heartbeats it skips are no-ops by construction.
- **The signal's predicate is NOT `lastDataAt`.** `lastDataAt` is stamped by `handle.onData(() => { handle.lastDataAt = Date.now(); })` (`ptyFleetService.ts:477`), which fires on every pty data event — including the 30-byte heartbeat. A 12 fps heartbeating seat keeps `lastDataAt` fresh forever, so the existing quiet predicate (`nowMs - lastDataAt >= turnEndSilenceMs`) can never fire for the seat this plan is about. The signal requires a **new printable-aware** timestamp, not a reuse of the liveness predicate.
- **The gateway holds no dispatch/card state.** "Seat holding a card" lives in the kanban DB / `PlanIngestionEngine`, not the gateway (the gateway is a byte pipe with a ring buffer — no dispatch, card, or planFile field exists on it). A server-side signal would require a new gateway→engine bridge that does not exist. The recommended client-side derivation avoids this entirely: the webview already has the frame stream and the kanban `working`/`dispatched_terminal` state.

## Edge-Case & Dependency Audit

- **A seat that emits a heartbeat *and* real output interleaved.** The run-collapse only fires on consecutive content-free chunks, so any real output between heartbeats breaks the run and is preserved.
- **Different CLIs, different heartbeats.** The rule is content-free-ness (zero printables after escape removal), not a devin-specific pattern; `claude` and `agy` are unaffected because they do not emit this frame. Do not special-case a CLI.
- **A client resuming from `lastSeq`.** Resume must still yield a coherent stream after collapse — assert a mid-run resume renders identically to a full replay. The collapsed tail carries the latest `seq` (monotonic), so a resume from any prior `lastSeq` skips only no-op frames.
- **Mode 2026 is not in `TRACKED_DEC_MODES`.** It does not need to be for this plan (the measured blocks are balanced), but note that a client attaching mid-block has no recorded state to restore. Out of scope, recorded so it is not mistaken for an oversight.
- **The silence signal must not fire on a genuinely idle seat** that nobody dispatched to. Gate it on the seat holding work (kanban `working`/`dispatched_terminal`), not on stream silence alone. The printable-aware timer arms only for panes whose seat holds a card.
- **The signal must not fire on a heartbeating seat that IS producing printables.** The printable-aware timestamp resets on every printable character, so a seat interleaving real output with heartbeats never trips the signal. Only a seat that is *dispatched, pty-live, and printable-silent for N* lights up.
- **A standalone SGR-only chunk.** A chunk carrying only an SGR colour change (`ESC[31m`, no printable) is content-free by the zero-printable test. Collapsing it onto a preceding content-free tail replaces the tail with the latest SGR — which is the correct current colour state for a replay. This is safe and intended; the byte-identity fast path simply declines to fire when the two SGR sequences differ, and the content-free gate handles it.

## Dependencies

- **Related, not blocking:** the `?1049h` re-arm gap in `applyServerModes` is real and documented in-code, but is not this bug and is not exercised by this seat. If a TUI seat is ever seen with `1049: true`, that is a separate plan.
- **Related, and re-pointed:** `The "Seat Has Gone Quiet" Notice Flaps, and Every Flap Wakes the Lead` (PLAN REVIEWED, in *Dispatch prompt and completion handshake*). That plan concerns an existing quiet-notice that fires too often toward the lead. This plan's signal is operator-facing and read-only.
  > **Superseded:** "They must not grow into two competing definitions of 'quiet' — settle on one predicate and have both consume it."
  > **Reason:** The two signals cannot share a predicate. The flapping-notice's predicate is `lastDataAt`-based (`nowMs - lastDataAt >= turnEndSilenceMs`), and `lastDataAt` is stamped on every pty data event — including the 30-byte heartbeat (`ptyFleetService.ts:477`). A heartbeating seat keeps `lastDataAt` fresh, so that predicate is heartbeat-blind and can never detect the "working, no printable output" condition this plan names. Sharing it would wire this signal to a predicate that has never observed its target condition.
  > **Replaced with:** This plan defines its own **printable-aware** quiet predicate ("no printable character in the pane's frame stream for N ms"), tracked client-side in `terminals.js`. It does not consume `lastDataAt`. The two signals now describe different things — the flapping-notice is about *pty silence* (any bytes), this signal is about *glyph silence* (printable chars) — and need not be unified.
- **Related, and load-bearing for ordering:** `Remove Silence-Based "Blocked" State from the Kanban` (PLAN REVIEWED). That plan **deletes the silence branch, `setBlockedState`, and the blocked turn-end outcome** — i.e. it removes the very seat-quiet notice the original draft of this plan proposed to share a predicate with. The surviving `turnEndSilenceMs`/`lastDataAt` logic lives only in the feature/queue nudge sweeps, which are heartbeat-blind for the same reason. This plan does not depend on the removed notice: its printable-aware predicate is self-contained and client-side. Land this plan as if the sibling has already merged — do not reference the blocked notice or `setBlockedState`, which will not exist post-sibling.

## Adversarial Synthesis

Key risks. (1) An over-wide content-free test deletes real scrollback, which is worse than the bug — mitigation: zero-printables-after-escape-removal is the correctness gate, byte-identity is only the fast path, and a test asserts a single-space frame and an SGR-colour frame both survive. (2) Coalescing bursts defeat a byte-identity-only collapse and the scrollback recovery degrades under load — mitigation: the collapse fires on content-free-ness of both chunks, not byte-equality, so a 60-byte two-heartbeat chunk replaces a 30-byte tail. (3) The operator signal is wired to `lastDataAt`, which the heartbeat keeps fresh, so it never fires for the seat it is meant to help — mitigation: the signal uses a new printable-aware predicate tracked client-side, not `lastDataAt`; the gateway holds no dispatch state so server-side derivation is abandoned. (4) The sibling `remove-silence` plan deletes the seat-quiet notice this plan once proposed to share a predicate with — mitigation: the printable-aware predicate is self-contained and does not reference the removed notice. (5) The fix is validated against a synthetic heartbeat and misses devin's real frame — mitigation: the exact 30-byte sequence is recorded in this plan and is the fixture.

## Proposed Changes

### `src/standalone/terminalWsGateway.ts` — `flushOutput` (:596)

- Before the ring append, test the incoming `combined` chunk for content-free-ness: zero printable characters after CSI/OSC/DCS sequence removal (the same escape-stripping approach the mode scanner already uses). If it is content-free **AND** the ring's tail chunk is also content-free, replace the tail chunk's `data` and `seq` with the incoming chunk's (carrying the fresh `nextSeq++`), and adjust `totalBytes` by the difference. Byte-identity between the two chunks is a cheap fast-path short-circuit (skip the printable scan when `combined === tail.data`), but it is NOT the gate — content-free-ness of both is, so a coalesced 60-byte two-heartbeat chunk still collapses onto a 30-byte tail.
- `headSafeStart` needs **no new code**: the eviction loop at `:624-632` already calls `unterminatedEscapeTail(removed.data)` + `replaySafeStart(..., buffer.chunks[0].data)` over whatever chunks sit in the ring. A collapsed tail is a normal chunk whose data is the last content-free frame; its escape tail is that frame's tail, which is the correct replay state. Do not add a parallel re-derivation.
- Leave the client fan-out (`:636-640`), `seq` consumption (`nextSeq++` runs unconditionally so the wire frame always gets a fresh monotonic seq), and flush observers (`:647-651`) untouched — the wire and the terminal log are unchanged. The collapse changes only which chunk occupies the ring tail, not what is sent.

### Operator signal — `src/webview/terminals.js` (client-side)

> **Superseded:** "Derive 'dispatched, alive, no printable output for N seconds' from state the gateway already holds (`seq` advancing, pty handle live, seat holding a card) and surface it on the pane. Consume the same quiet predicate as the seat-quiet notice rather than defining a second one."
> **Reason:** Two of the three named pieces of "state the gateway already holds" are not there. (a) `lastDataAt` — the quiet predicate the seat-quiet notice consumes — is stamped on every pty data event including the heartbeat (`ptyFleetService.ts:477`), so it is heartbeat-blind and can never fire for a 12 fps heartbeating seat; "consume the same predicate" wires the signal to a predicate that has never observed its target condition. (b) "Seat holding a card" is kanban/`PlanIngestionEngine` state; the gateway has no dispatch, card, or planFile field. Server-side derivation would require a new gateway→engine bridge that does not exist. (c) The sibling `remove-silence` plan deletes the seat-quiet notice being referenced, so the predicate's consumer is scheduled for removal regardless.
> **Replaced with:** a **client-side** printable-aware timer in `terminals.js`, modelled on the existing `bumpStartupCurtain`/`sawLiveOutput` pattern (`:2477-2483`):

- Track a `lastPrintableAt` timestamp per pane, reset whenever a live frame (not a replay frame — the `awaitingReplayFrame` branch is already excluded from `scheduleBatchFlush`) contains at least one printable character. The printable test is the same escape-strip used for the collapse.
- Cross the timer with the pane's dispatch state: the kanban already exposes per-card `working` and `dispatched_terminal` (`kanban.html:9435`, `terminals.js:5912`). The signal arms only for a pane whose seat holds a card.
- Surface a "working, no output" affordance on the pane when `now - lastPrintableAt > N` **and** the seat holds a card **and** the pty is live (frames are still arriving — i.e. `lastPrintableAt` is advancing in wall-clock terms via the frame stream, just not in printable terms). The affordance clears the moment a printable character arrives.
- Set `N` to `turnEndSilenceMs` (default 90 000 ms), read from the same `activityLight` config family the nudge sweeps use, so the threshold is configurable and consistent with the head-idleness floor. Do not introduce a second knob.
- This needs no gateway change, no engine change, and no new server state. The webview already parses every frame for xterm and already knows working state.

## Files Changed

- `src/standalone/terminalWsGateway.ts` — content-free chunk collapse in `flushOutput` (ring only; `headSafeStart` unchanged)
- `src/webview/terminals.js` — client-side `lastPrintableAt` timer and the pane-level "working, no output" affordance
- Tests — collapse correctness (including coalesced multi-heartbeat chunks), replay fidelity, and the negative cases

## Verification Plan

1. **The measured frame collapses.** Feed 5,000 copies of the exact 30-byte devin heartbeat; assert the ring holds one, `totalBytes` reflects one, and the replayed cursor position matches the uncollapsed stream.
2. **Real content is never collapsed.** A frame containing a single space, and two frames differing only in an SGR colour, both survive intact.
3. **Coalesced bursts collapse.** Feed a 30-byte heartbeat then a 60-byte two-heartbeat chunk; assert the ring holds one entry (the 60-byte tail), proving the content-free gate fires without byte-identity.
4. **Interleaving breaks the run.** heartbeat, text, heartbeat yields three ring entries.
5. **Replay fidelity is unchanged.** Full replay and a `lastSeq` resume both render identically to the pre-change behaviour for a stream with no heartbeats.
6. **Scrollback depth recovers.** Against the recorded live sample, assert retained printable characters increase materially versus today's 43,718 in 262,040 bytes.
7. **The wire is untouched.** Assert the bytes sent to clients and to the terminal log writer are identical before and after.
8. **Both hosts.** The gateway is standalone-only today, but the pane affordance is shared — verify in both composition roots by hand.
9. **The signal fires for the measured seat.** A pane whose seat holds a card and receives only the 30-byte heartbeat for >N ms shows the affordance; the same seat receiving interleaved printables does not.

### Goal Invariants

- Assert `flushOutput` (`src/standalone/terminalWsGateway.ts:596`) never appends a new `ScrollbackChunk` when both the incoming `combined` and the ring tail are content-free (zero printables after escape removal) — the tail is replaced instead.
- Assert `buffer.totalBytes` in `scrollbackBuffers` for a heartbeating terminal stays within one heartbeat chunk's length of the pre-heartbeat value, not growing at ~21 KB/min.
- Assert `nextSeq` in `ScrollbackBuffer` advances by exactly one per `flushOutput` call regardless of collapse (the wire frame always consumes a seq).
- Assert the bytes written to clients (`safeSendBinary`) and to flush observers are byte-identical with collapse enabled vs disabled for the same input stream.
- Assert `terminals.js` exposes a `lastPrintableAt` tracker per pane that resets only on a printable character in a live (non-replay) frame, and that the "working, no output" affordance is absent for a pane whose seat holds no card.

## Outstanding Questions

- **[user] Signal derivation: client-side vs server-side.** The review recommends client-side (see User Review Required #3). Proceeding on the assumption that client-side is acceptable — the signal is operator-facing and moot when no webview is open.
- **[user] Signal threshold N.** Proceeding on the assumption that N = `turnEndSilenceMs` (default 90 s) is correct (see User Review Required #4).
- **[research] Coalescing multiplicity under load.** The steady state is ~1 heartbeat per 6 ms flush window, but under event-loop pressure the pty may buffer multiple heartbeats into one flush. This is reasoned from timing (12.2 fps × 6 ms ≈ 0.073 frames/window), not measured under pressure. Proceeding on the assumption that bursts do occur and the content-free gate (not byte-identity) must handle them — the collapse is designed to survive bursts regardless, so the assumption is not load-bearing for correctness, only for tuning the fast path.

**Recommendation:** Complexity 5 → Send to Coder.
