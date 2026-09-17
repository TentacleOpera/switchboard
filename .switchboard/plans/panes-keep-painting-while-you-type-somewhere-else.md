# Panes Keep Painting While You Type Somewhere Else

kanbanColumn: CREATED

## Goal

Typing into a text field that is not a terminal — the composer above all — does not compete with
live pane rendering for the main thread. The board keeps its sockets; it just stops painting output
nobody is reading at that moment.

### Problem analysis

The operator reports that the composer "is just as slow as the terminal input, so is pointless" —
on an iPad, in the terminals panel, with a live grid.

The composer is not paying network latency. Its only `input` listener is `updateComposerSendButton`
(`terminals.js:12506`), which does three `getElementById` calls and sets `disabled`. There is no
fetch, no socket write, no postMessage per keystroke; delivery happens once, on SEND. The five
document-level `keydown` handlers that fire while typing all early-return on a `modal.hidden` check.
**Nothing in the composer's own path costs anything.**

What costs is everything behind it. The composer is an overlay — `#composer-modal`
(`terminals.html:341`) sits over the pane grid — and pane liveness is decided by `isTerminalRendered`
(`terminals.js:398`), the single owner of `entry.suspended`. It asks three questions: is the name in
the assigned slot slice, does the container have a box, is the slot not in status mode. **An overlay
changes none of them.** It does not alter layout geometry, so nothing suspends.

So while the operator types, every visible pane still holds its socket, still parses inbound frames,
still calls `term.write`, and still paints. Each pane also holds a WebGL context
(`terminalViewport.js:549`). On a desktop that is absorbed. On an iPad — a far weaker main thread, a
hard low cap on live WebGL contexts, real GPU memory pressure — the operator's keystrokes queue
behind xterm's `WriteBuffer` parse and the renderer, and the textarea feels exactly as laggy as the
terminal. Same bottleneck, different surface, and none of it is the link.

**This is why it reads as "the composer is pointless".** The feature's entire premise is that
composing locally avoids the round trip. It does avoid it. The win is then spent on rendering
contention instead.

**This is a hypothesis from reading the code, not a measurement.** Verification step 1 exists to
falsify it before anything is built.

### Why not just suspend

`suspendTerminalStream` (`terminalViewport.js:1835`) already exists, but it is the wrong instrument:
it closes the socket and disposes the renderer, and `resumeTerminalStream` (`:1906`) pays a replay
and a renderer reattach on the way back. Using it for the duration of a keystroke would make opening
the composer a visibly destructive act. The need here is narrower — stop *painting*, keep everything
else.

## Metadata

- **Complexity:** 6
- **Tags:** terminals, performance, mobile, frontend

## User Review Required

None.

## Complexity Audit

### Routine
- A hold flag consulted by `drainAllBatches` before writing a queued batch to xterm.
- Setting and clearing it from focus entering and leaving a text field outside the panes.
- Draining everything held the moment the hold clears.

### Complex / Risky
- **Ack accounting.** `onWriteParsed` bills written characters to the connection's credit ledger.
  Holding writes defers those acks, which is backpressure against the server. That is arguably
  correct, but it must not be able to deadlock: a server that stops sending because the client never
  acks, on a client that is waiting for nothing, is a wedged pane.
- The queue is unbounded while held. A firehose behind a composer left open for minutes must not
  grow without limit.
- Deciding *which* focus counts. The composer textarea qualifies; an xterm pane's own hidden textarea
  emphatically does not — holding on that would stop the terminal painting while the operator types
  into it, which is the exact opposite of the goal.

## Proposed Changes

### 1. A hold that stops painting, not streaming

While the hold is on, inbound frames continue to arrive, continue to be decoded, and continue to be
queued into `entry.batchQueue` as they are today. `drainAllBatches` (`terminalViewport.js`) does not
write held entries to `term.write`. Sockets stay open, renderers stay attached, `entry.suspended`
stays false — `isTerminalRendered` remains the sole owner of that flag and this change must not touch
it.

### 2. The hold is driven by focus, and only by focus outside a pane

The hold engages when focus is in a text-entry surface that is not a terminal — the composer, and
any dialog with a text field. It clears on blur, on close, and on send.

An xterm pane's own input must never engage it.

### 3. Everything held drains on release, in order

On release, held entries flush through the existing batch path in arrival order. xterm's
`WriteBuffer` preserves write ordering, so the replay is a normal drain, not a special path.

### 4. A bounded hold, and it says when it gave up

The hold has a byte ceiling across all held entries. On exceeding it, the hold releases and drains —
output correctness wins over input smoothness. The release must be **observable**: record that the
hold ended because it hit the ceiling rather than because focus left, and surface it in the client
diagnostic dump. A ceiling that trips silently is indistinguishable from a hold that never engaged,
and both would look identical to anyone measuring whether this worked.

### 5. Do not touch the ack ledger's semantics

Acks follow writes, as they do today. The hold defers writes and therefore defers acks; it must not
fabricate an ack for a held frame to keep the credit window open. If deferring acks proves to stall
the stream in practice, the ceiling in Change 4 is the release valve — not a synthetic ack.

## Edge-Case & Dependency Audit

1. **Deadlock via credit.** If the server's credit window closes while the client holds, and the
   client's release depends on data that will now never arrive, the pane wedges. Release must depend
   only on focus and the byte ceiling — never on inbound data.
2. **A pane the operator is watching while typing.** Composing a prompt while watching an agent work
   is a real workflow. Held output is invisible for the duration of the hold. The byte ceiling
   bounds it, but the behaviour must be understood as intended, not discovered as a bug report.
3. **`BATCH_FALLBACK_MS`.** `scheduleBatchFlush` (`terminalViewport.js:1000`) arms both a shared rAF
   and a fallback timer. The hold must gate the *drain*, not the scheduling, or the fallback timer
   will fire into a held entry.
4. **A hidden document.** rAF is fully suspended while the document is hidden and the fallback timer
   is clamped to ~1 Hz; the existing comment at `terminals.js:1537` documents the resulting repaint
   damage. A hold interacting with that path must not add a second way for rows to keep stale pixels.
5. **Dock and composer both open.** Once the composer is a dock tab, the hold's trigger is the same —
   focus in a text field outside a pane. No new case.
6. **Status panes.** Already excluded by `isTerminalRendered`; they hold no viewport and need no hold.

## Dependencies

None. Independent of *The Composer Is a Modal You Have to Summon* and of *The Dock Takes Width From
the Board* — different files, no shared code. It is also independent of the predictive-echo work:
that plan lives in the xterm *input* path, and the composer is a plain textarea that never waited on
a round trip. **Predictive local echo will not fix this and this will not fix predictive echo.**

## Both Hosts

`terminalViewport.js` and `terminals.js` are shared webview assets served by the standalone host
(`src/standalone/`), which is this plan's composition root. The VS Code extension host is out of
scope — it is being removed and needs no wiring here.

## Adversarial Synthesis

Key risks: (1) the diagnosis is unmeasured, and if the lag has another cause the whole change is
wasted — hence a falsification step before implementation; (2) deferring acks is backpressure the
server may interpret as a stalled client, and the failure mode is a wedged pane rather than a slow
one; (3) a hold that engages on an xterm pane's own focus would stop the terminal painting while the
operator types into it — the exact inverse of the goal, and easy to write by accident; (4) a byte
ceiling that trips silently makes a non-working hold indistinguishable from a working one, and every
invariant would pass green. Mitigations: falsify first; make release depend only on focus and the
ceiling; exclude pane-owned inputs explicitly; record and expose the release reason.

## Verification Plan

1. **Falsify first.** On the iPad, with the composer open and all agents idle (no output streaming),
   typing is smooth. With agents streaming, it is not. If typing is laggy with nothing streaming, the
   diagnosis is wrong and this plan should be stopped, not implemented.
2. With the hold in place, typing into the composer on the iPad is smooth while agents stream.
3. Held output appears, complete and in order, the moment focus leaves the composer.
4. No pane's socket closes, and no renderer is disposed or reattached, for the duration of a hold.
5. A sustained firehose behind an open composer releases at the byte ceiling and drains, and the
   diagnostic dump records that the ceiling was the reason.
6. Typing into a terminal pane never engages the hold.
7. A held pane never wedges: after any hold, the stream resumes without operator intervention.

### Goal Invariants

- Assert `entry.suspended` is never written by the hold path — `isTerminalRendered` remains its sole
  owner.
- Assert no socket closes and no renderer is disposed while a hold is active.
- Assert focus inside an xterm pane does not engage the hold.
- Assert release depends only on focus state and the byte ceiling, never on inbound data.
- Assert the hold gates the drain, not the scheduling, so `BATCH_FALLBACK_MS` cannot write a held
  entry.
- Assert a ceiling-triggered release is recorded distinguishably from a focus-triggered one and
  appears in the client diagnostic dump.
- Assert no synthetic ack is emitted for a held frame.
