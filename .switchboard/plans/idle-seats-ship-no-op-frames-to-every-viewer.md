# An idle seat that animates its cursor bills every viewer a frame twelve times a second

## Goal

Stop shipping a live output frame that carries no content and is identical to the frame already sent,
so an idle-but-animating seat costs its viewers nothing instead of twelve decodes, writes and
repaints per second.

### Problem Analysis

`flushOutput` already knows what a content-free chunk is, and already collapses runs of them — but
only in the **ring**, never on the wire. Its own comment records the measurement:

> the devin heartbeat is a 30-byte cursor wiggle with no glyph, and at ~12 fps it eats ~65% of the
> 256 KB ring with pure no-ops

The ring-side fix keeps replay honest. The live path is untouched: `encodeOutputFrame(seq, combined)`
is built and sent to every attached client regardless, so each viewer pays a WebSocket frame, a UTF-8
decode, a `term.write()` parse and a renderer repaint, twelve times a second, per idle seat. Nine
such seats is ~108 frames/second of no-ops.

**This is per-CLI and per-version, and the honest scope is narrower than it first looks.**
`feature_plan_20260807103200_pty-screen-state-idle-detection-headless-vt.md` carries a measured
correction worth repeating here: Claude Code v2.1.170+ **eliminated** idle terminal re-renders, so a
current `claude` seat is genuinely quiet at an idle prompt. The animating case is real but specific —
devin today, and any CLI that repaints at idle. So this plan's value is proportional to how much of
the fleet animates, which on a mixed fleet is substantial and on an all-`claude` fleet is nil.

### Root Cause

The collapse was written to solve a *retention* problem — heartbeats evicting real history from the
ring — so it was implemented where retention lives. That the same predicate answers a *transmission*
problem was never in scope, and the wire frame kept its unconditional `nextSeq`.

### Non-goals

- **Do not drop a frame that carries any printable glyph.** `isContentFree` is the gate, and the
  gate must be content, never size or rate.
- **Do not collapse the ring differently.** The ring's behaviour is correct and tested; this plan adds
  a wire-side decision beside it.
- **Do not suppress the FIRST content-free frame after content.** A cursor coming to rest, or `?25h`,
  is real state a client needs. Only a *repeat* of an already-sent content-free frame is redundant.
- Not idle detection. This plan makes no claim about whether an agent is finished.

## Metadata

**Topic:** Content-free live frames are not re-sent when identical to the last frame shipped
**Complexity:** 4
**Tags:** terminals, performance, remote, backend, standalone

## User Review Required

None.

## Dependencies

None. `isContentFree` ships today and is used by the ring collapse in the same function.

## Both Hosts

The change is inside `flushOutput` in `terminalWsGateway.ts`, shared by both composition roots —
standalone in-process (`bootstrap.ts:3202`) and the extension's pty-host sidecar (`ptyHost.ts:46`).
No wiring, no new seam, therefore no divergence risk. Do not introduce a setting for it at either
root; if it needs a switch later, that is a separate decision with two call sites to get wrong.

## Proposed Changes

**1. Track the last frame shipped, per terminal.**

Alongside the existing ring bookkeeping, record the payload of the last frame actually **sent** —
distinct from the ring tail, which may have been collapsed and can diverge.

**2. Suppress a repeat content-free frame on the wire.**

When the incoming coalesced chunk `isContentFree(combined)` **and** equals the last shipped payload,
do not build or send a frame. Continue to do the ring work exactly as today, including the seq
increment, so the ring's own collapse and eviction semantics are untouched.

**3. Preserve seq monotonicity for resume.**

This is the sharp edge. A client resuming with `?lastSeq=` filters `c.seq > lastSeq` against the ring.
Suppressing a *wire* frame must not make a client believe it is caught up when it is not, nor make the
gap detector report a false gap. Two rules:

- The ring keeps consuming `nextSeq` exactly as now — the suppressed frame still exists in the ring
  and still has a seq.
- A client's `lastSeq` therefore lags by the suppressed frames. That is safe **only** because the
  suppressed frames are byte-identical repeats of one the client already has; on the next real frame
  the client's `lastSeq` jumps forward and nothing is lost. Assert this rather than assume it: the
  gap detector compares `oldestRetained > lastSeq + 1`, and a lagging `lastSeq` moves the client
  *closer* to a false gap report, not further from one.

If that interaction proves awkward, the fallback is to send the frame but with an empty payload and
the fresh seq — cheaper than the redraw, and it keeps `lastSeq` exact. Prefer suppression; take the
fallback if invariant 3 below cannot be made to hold.

**4. Do not touch the flush observers.** The terminal log writer must keep seeing what the pty
produced, or the log stops matching the session. Observers run after the fan-out and must be reached
whether or not a frame was sent.

## Verification Plan

1. Seat a devin terminal, let it idle, and count frames arriving at the client over 60s. Expect
   near-zero where today it is ~720.
2. Confirm the ring still collapses as today: `__sbTerminalStats()` and a reattach both behave
   unchanged.
3. Reattach a client after a long idle stretch and confirm the cursor is in the right place with the
   right visibility state — the resting-position frame must have been delivered.
4. Type a character into the idling seat; the echo arrives with no added latency.
5. Reattach with a stale `lastSeq` spanning suppressed frames and confirm **no** false replay gap is
   reported.
6. `terminalLogWriter` output for the idle stretch is unchanged from today.
7. An all-`claude` fleet shows no behaviour change at all (nothing to suppress) — this is the
   regression fence for the quiet case.
8. **Both hosts:** run 1 and 5 against standalone and the extension's pty-host sidecar.

### Goal Invariants

- Assert a frame carrying any printable glyph is never suppressed.
- Assert the first content-free frame following a content-bearing frame IS sent.
- Assert the ring's `nextSeq` advances for a suppressed frame exactly as for a sent one.
- Assert flush observers are invoked for a suppressed frame.
- Assert a resume across suppressed frames reports no replay gap.
