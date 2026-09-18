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
(`terminals.js:12626`), which does three `getElementById` calls and sets `disabled`. There is no
fetch, no socket write, no postMessage per keystroke; delivery happens once, on SEND. The five
document-level `keydown` handlers that fire while typing all early-return on a `modal.hidden` check.
**Nothing in the composer's own path costs anything.**

What costs is everything behind it. The composer is an overlay — `#composer-modal`
(`terminals.html:349`) sits over the pane grid — and pane liveness is decided by `isTerminalRendered`
(`terminals.js:401`), the single owner of `entry.suspended`. It asks three questions: is the name in
the assigned slot slice, does the container have a box, is the slot not in status mode. **An overlay
changes none of them.** It does not alter layout geometry, so nothing suspends.

So while the operator types, every visible pane still holds its socket, still parses inbound frames,
still calls `term.write`, and still paints. Each pane also holds a WebGL context
(`terminalViewport.js:548`). On a desktop that is absorbed. On an iPad — a far weaker main thread, a
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
it closes the socket and disposes the renderer, and `resumeTerminalStream` (`:1913`) pays a replay
and a renderer reattach on the way back. Using it for the duration of a keystroke would make opening
the composer a visibly destructive act. The need here is narrower — stop *painting*, keep everything
else.

## Metadata

- **Complexity:** 6
- **Tags:** performance, mobile, frontend, ux

## User Review Required

None.

## Complexity Audit

### Routine
- A hold flag consulted by `drainAllBatches` (`terminalViewport.js:1018`) before writing a queued
  batch to xterm.
- Setting and clearing it from focus entering and leaving a text field outside the panes.
- Draining everything held the moment the hold clears.

### Complex / Risky
- **Ack accounting.** `onWriteParsed` (`:1091`) bills written characters to the connection's credit
  ledger. Holding writes defers those acks, which is backpressure against the server. Verified bound
  (not a wedge): the gateway pauses the pty at `HIGH_WATER_CHARS = 100000` unacked chars, and
  `MAX_PAUSE_MS = 10000` force-resumes plus zeroes `client.unackedChars` on any ack stall
  (`terminalWsGateway.ts:7-13, 1151-1164`). A hold therefore cannot permanently wedge a pane — the
  worst case is a 10-second throttle and a ledger reset. The 64 KB ceiling below keeps a legal hold
  under the 100k ledger trip entirely.
- The queue is unbounded while held. A firehose behind a composer left open for minutes must not
  grow without limit — bounded by the byte ceiling in Change 4.
- Deciding *which* focus counts. The composer textarea qualifies; an xterm pane's own hidden
  `.xterm-helper-textarea` (vendored `xterm.css:61`) emphatically does not — holding on that would
  stop the terminal painting while the operator types into it, the exact opposite of the goal.
- **Focus engine quirks.** `focusout.relatedTarget` is unreliable on touch engines, and
  `modal.hidden = true` does not reliably blur a focused textarea. Release must not depend on blur
  semantics alone — the close/send paths release explicitly.

## Edge-Case & Dependency Audit

1. **Deadlock via credit — bounded, not fatal.** If the server's credit window closes while the
   client holds, the pty pauses at 100k unacked chars; after `MAX_PAUSE_MS = 10000` without ack
   progress the gateway force-resumes and zeroes the ledger. Worst case is throttled output and a
   reset ledger, never a permanent wedge. Release still must depend only on focus and the byte
   ceiling — never on inbound data.
2. **A pane the operator is watching while typing.** Composing a prompt while watching an agent work
   is a real workflow. Held output is invisible for the duration of the hold. The byte ceiling
   bounds it, but the behaviour must be understood as intended, not discovered as a bug report.
3. **`BATCH_FALLBACK_MS`.** `scheduleBatchFlush` (`terminalViewport.js:1000`) arms both a shared rAF
   and a fallback timer. The hold gates the *drain* (`drainAllBatches`), not the scheduling — the
   timers keep cycling and the entries stay marked pending while held.
4. **A hidden document.** rAF is fully suspended while the document is hidden and the fallback timer
   is clamped to ~1 Hz; the existing comment at `terminals.js:1551-1569` documents the resulting
   repaint damage. A hold interacting with that path must not add a second way for rows to keep
   stale pixels — under hold the buffer simply doesn't advance, which is the *safe* side of that
   bug class.
5. **`flushBatch` has a second caller.** The pre-replay ordering drain at `terminalViewport.js:2047`
   calls `flushBatch(entry)` directly so a queued tail reaches xterm before the replay. The hold
   must therefore live in `drainAllBatches`, not inside `flushBatch` — gating `flushBatch` would
   strand pre-replay output to drain *after* the replay, rendering out of order.
6. **Reconnect writes still paint.** `writeReplay` and the RIS `'\x1bc'` write on the `replayGap`
   path bypass the batch queue entirely and will paint during a hold. Bounded and correct: a
   reconnect is a screen-repair event, one write, not a stream. `replayGap` and
   `suspendTerminalStream` already clear `entry.batchQueue` (`:2142`, `:1845`), so held data can
   never be replayed stale on top of fresh scrollback.
7. **Dock is a separate document.** `transport.js` documents that the dock is now its own document
   at `/dock`, not an iframe of the terminals page. The composer is in-document today so focus works;
   **if it later becomes a dock tab, `focusin`/`focusout` will never fire in the terminals
   document** — the hold then needs a window-blur heuristic or a cross-document signal. Flagged, not
   handled: this plan's trigger is correct for the in-document composer.
8. **Status panes.** Already excluded by `isTerminalRendered`; they hold no viewport and need no hold.
9. **`hidden` does not guarantee blur.** On engines where hiding the modal leaves `activeElement` on
   the now-hidden textarea, the hold would never release. `closeComposerModal` and the send-success
   path call the release explicitly rather than relying on focusout.

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

Key risks: the diagnosis is unmeasured (falsify-first gate); deferred acks are real backpressure but
bounded by the server's 10s force-resume backstop, and a 64 KB ceiling keeps a legal hold under the
100k ledger trip; a wrong focus predicate or a hidden-without-blur quirk inverts the goal.
Mitigations: gate only `drainAllBatches` (its `:2047` sibling caller stays ungated), release
explicitly on close/send paths, and record the release reason on an observable diagnostic surface.

## Proposed Changes

### `src/webview/terminalViewport.js` — hold state, gate, ceiling, release

- Module-level hold state near the batching block (`:998`): 
  `paintHold = { active:false, engagedAt:0, heldChars:0, lastReleaseReason:'', lastReleaseAt:0, ceilingTrips:0 }`.
- `setPaintHold(active, reason)` — exported alongside `suspendTerminalStream` at `:2275`.
  On release: record `reason` (`'focus'` or `'ceiling'`) and `lastReleaseAt`, re-add every entry
  with a non-empty `batchQueue` to `pendingBatchEntries`, call `drainAllBatches()`, and
  `console.info` the release.
- In `drainAllBatches` (`:1018`): inside the entries loop,
  `if (paintHold.active) { pendingBatchEntries.add(entry); continue; }` — the entry stays marked
  pending so the armed timers keep cycling harmlessly and the tail is never stranded. Do **not**
  put this check inside `flushBatch` — its `:2047` caller must keep working under hold.

> **A hold in `drainAllBatches` alone no longer holds everything (2026-09-18).**
> `A keystroke echo waits on two frame boundaries it does not need` (`a8f75f5d`, feature
> `94aa8b26`) has landed a **fast path** in both frame arms of `terminalViewport.js`: a
> lone frame under 512 chars, on an entry with an empty `batchQueue` and no
> `pendingBatchEntries` membership, is written straight to xterm through the new
> `writeLiveChars` seam and **never enters `drainAllBatches` at all**. A gate placed only
> in the drain would therefore let exactly the small, frequent frames through — the
> per-keystroke echoes of every other pane — which is the contention this plan exists to
> remove.
>
> The hold must cover the fast path too. Note the ordering trap: if a held fast-path frame
> is pushed onto `batchQueue` instead of written, the entry must also be added to
> `pendingBatchEntries`, or the release drain will not find it. Re-read the two frame arms
> (`:2064` binary, `:2116` legacy) before writing this change — they are not as the
> problem analysis above describes them.
- `HELD_CHARS_CEILING = 65536` (64 KB). Maintain `paintHold.heldChars` as the summed
  `batchQueue` lengths of held entries — cheapest correct place is where the skip happens in
  `drainAllBatches` plus on each `batchQueue.push` while held. On exceeding it:
  `setPaintHold(false, 'ceiling')` — output correctness wins over input smoothness.
  64 KB stays well under `HIGH_WATER_CHARS = 100000`, so the server credit ledger never trips
  during a legal hold; it is also a trivial memory bound for the iPad.

### `src/webview/terminals.js` — focus driver + explicit release

- Document-level `focusin`/`focusout` listeners (capture phase). Qualifying element test:
  `el.matches('textarea, input:not([type=checkbox]):not([type=radio]):not([type=hidden]):not([type=number]), input[type=text], input[type=search], [contenteditable=true]')`
  AND `!el.closest('.xterm')` — the second clause excludes `.xterm-helper-textarea`.
  This covers `composer-input`, `link-message`, `team-order-text`, `team-head-order-text`,
  `team-auto-*` and any future non-pane text field.
- Engage `viewport.setPaintHold(true)` on focusin to a qualifying element. On focusout, re-check
  the new focus target — prefer `e.relatedTarget`, fall back to `document.activeElement` on a
  microtask (relatedTarget is unreliable on touch engines). Release only when the new target does
  not qualify.
- `closeComposerModal` (`:12476`) and the `deliverComposerPrompt` success path (`:12599`) call
  `viewport.setPaintHold(false, 'focus')` explicitly — release must not depend on `hidden`
  triggering a blur.

### Diagnostic surface (Clarification)

> **Superseded:** "…surface it in the client diagnostic dump."
> **Reason:** No client diagnostic dump exists in the webview — the requirement referenced a
> mechanism that was never built; an implementer would either invent one silently or drop the
> requirement while every invariant still passed.
> **Replaced with:** Build the minimal surface this plan needs: `window.__sbTermDiag` points at the
> live `paintHold` object (inspectable from devtools/console), plus a `?verbose=1`-gated one-line
> element on the terminals page matching the existing `board-fetch-diagnostics` pattern
> (`kanban.html:5490`) showing `hold=<bool> held=<chars> lastRelease=<reason> <ago>`, plus a
> `console.info` on every release. A ceiling trip and a focus release are distinguishable by
> `lastReleaseReason`.

### Do not touch

- `isTerminalRendered` / `entry.suspended` — sole-owner invariant stays; the hold never writes it.
- `onWriteParsed` ack semantics — acks follow writes; the hold defers writes and therefore defers
  acks. No synthetic ack for a held frame. If deferring acks proves to stall the stream in practice,
  the 64 KB ceiling is the release valve — and the server's `MAX_PAUSE_MS` backstop bounds it anyway.
- `scheduleBatchFlush` — keeps arming rAF + fallback; the gate is in the drain only.

## Verification Plan

1. **Falsify first.** On the iPad, with the composer open and all agents idle (no output streaming),
   typing is smooth. With agents streaming, it is not. If typing is laggy with nothing streaming, the
   diagnosis is wrong and this plan should be stopped, not implemented.
2. With the hold in place, typing into the composer on the iPad is smooth while agents stream.
3. Held output appears, complete and in order, the moment focus leaves the composer.
4. No pane's socket closes, and no renderer is disposed or reattached, for the duration of a hold.
5. A sustained firehose behind an open composer releases at the 64 KB ceiling and drains, and
   `window.__sbTermDiag.lastReleaseReason === 'ceiling'` (also visible in the `?verbose=1` line).
6. Typing into a terminal pane never engages the hold (`.xterm-helper-textarea` excluded).
7. A held pane never wedges: after any hold, the stream resumes without operator intervention —
   and a >10s hold additionally exercises the server's `MAX_PAUSE_MS` backstop without corruption.

### Goal Invariants

- Assert `entry.suspended` is never written by the hold path — `isTerminalRendered` remains its sole
  owner.
- Assert no socket closes and no renderer is disposed while a hold is active.
- Assert focus inside an xterm pane does not engage the hold.
- Assert release depends only on focus state and the byte ceiling, never on inbound data.
- Assert the hold gates `drainAllBatches` only — `flushBatch` is ungated, so its `:2047`
  pre-replay caller still flushes under hold, and `BATCH_FALLBACK_MS` cannot write a held entry.
- Assert a ceiling-triggered release is recorded distinguishably from a focus-triggered one
  (`lastReleaseReason`) and observable via `window.__sbTermDiag` and the `?verbose=1` line.
- Assert no synthetic ack is emitted for a held frame.
- Assert ceiling release fires at ≤ 65536 held characters.
- Assert `closeComposerModal` and the send-success path release the hold even when blur never fires.
