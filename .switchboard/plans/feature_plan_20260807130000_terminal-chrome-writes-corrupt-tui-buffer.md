# Four Client Notices Are Written Into the Terminal Buffer, Corrupting Any TUI's Screen Model

## Metadata

**Complexity:** 4
**Tags:** frontend, bugfix, terminals, ui, reliability

## Goal

Move the browser cockpit's four remaining connection/throttle notices out of the xterm
buffer and onto the pane chrome that already exists for exactly this purpose. After this
change, the only thing the client writes into a terminal's buffer is pty output, the
scrollback replay, DEC mode reassertion, and the process-exit line.

### Root Cause

`src/webview/terminals.js` writes four notices straight into xterm's screen buffer from
the WebSocket `onmessage` handler:

| Line | Notice |
| :--- | :--- |
| 4642 | `\r\n\x1b[2m[Input queue drained]\x1b[0m\r\n` |
| 4644 | `\r\n\x1b[2m[Pasting — input queued: N bytes…]\x1b[0m\r\n` |
| 4648 | `\r\n\x1b[31m[<frame.message \| Terminal unavailable>]\x1b[0m\r\n` |
| 4653 | `\r\n\x1b[33m[Disconnected — reconnecting…]\x1b[0m\r\n` |

These bytes never pass through the pty. They are injected client-side, at whatever
position the cursor happens to occupy, into a screen the running program believes it
owns.

A full-screen CLI redraws its bottom frame with *relative* cursor motion: Ink (Claude
Code, Gemini CLI) records how many rows its last frame occupied, moves the cursor up by
that count, erases, and rewrites. Each notice injects two newlines and a line of text, so
the screen shifts underneath that recorded count. The next redraw therefore erases the
wrong rows and paints the new frame over the remnants of the old one. The damage is
permanent — it is buffer content, not a paint artifact, so it survives scrolling — and it
is invisible to every other client attached to the same pty, because the gateway's
scrollback ring never saw these bytes.

The paste notice is the one that fires in normal use. `INPUT_HIGH_WATER_BYTES` is 64 KB
(`terminalWsGateway.ts:15`), and a dispatch prompt carrying a plan file clears that
comfortably. It also fires *twice* per paste — once when the queue crosses the high-water
mark and once when `clearInputThrottleIfDrained` sends `throttled: false` — so a single
dispatch injects two notices, six rows of shift, into the pane it was aimed at.

### Background Context

**This policy is already settled in this codebase, for one site.** `notifyInputDropped`
(`terminals.js:1855`) carries an explicit prohibition:

> There was a `[Not connected — keystroke discarded]` line written into `entry.term`
> here. Do not add it back, or any variant of it. Writing a notice into the terminal
> buffer makes it CONTENT, not chrome: it becomes permanent scrollback, it cannot be
> dismissed, it corrupts a TUI's screen buffer, and the running CLI already reports its
> own connection errors — so it was a second notification stacked on top of one the
> operator already had. […] The header chip (`refreshInputState`) is the whole signal. It
> is chrome, it self-corrects when the socket returns, and it leaves no residue.

Every clause of that applies verbatim to the four sites above. This plan finishes the job
that comment started; it introduces no new principle.

The chrome surface it names already exists and is complete:

- `resolveInputState(name)` (line 1787) — names the state; returns `{ key, label }`.
- `refreshInputState(name)` (line 1807) — repaints only the pane's state class and chip,
  deliberately without re-appending any xterm (a grid rebuild during a socket transition
  yanks the caret mid-keystroke).
- `syncInputStateChip(paneEl, titleEl, state)` (line 1835) — the single writer; creates,
  updates *and* removes the chip. `live` renders nothing.
- CSS tokens `.is-input-connecting` / `.is-input-readonly` on `.terminal-pane`, plus the
  `.has-caret.is-input-*` ring recolour (`terminals.html:668-716`).

`[Disconnected — reconnecting…]` is already fully represented by this machinery — the
socket is not `OPEN`, so `resolveInputState` returns `connecting` and the chip renders
"connecting". The write at line 4653 is a *second* notification stacked on one the
operator already has, which is precisely the defect the `notifyInputDropped` comment
describes.

**Deliberately out of scope: the exit line** at 4657
(`[Process Exited with code N]`). It is written to a terminal whose process is gone, so
the stated harm — corrupting a TUI's screen model — cannot occur: nothing will ever
redraw over it. It is also the only record of the exit *code*, which the `readonly` chip
does not carry. It stays.

**Not a factor: the backpressure ledger.** `onWriteParsed` is wired only to the batch
flush (line 4729) and the replay write (line 4753). These four notices are unbilled
today and will simply stop existing, so `pendingAckChars` is unaffected in both
directions.

## Proposed Changes

### File 1: `src/webview/terminals.js` — add a `queued` input state

`resolveInputState` currently resolves three keys. Input that is *accepted but queued* is
a fourth, orthogonal condition: the socket is `OPEN` and keystrokes are landing, they are
just behind a paste. Insert it after the `OPEN` check so the existing precedence
(dead > disconnected > healthy) is preserved:

```javascript
        if (entry.ws && entry.ws.readyState === WebSocket.OPEN) {
            // Throttled is NOT a failure state and must not outrank `connecting`:
            // input is queued, never dropped (see the inputThrottled arm of the
            // socket handler and enqueueInput in terminalWsGateway). The chip says
            // "still landing", which is the only thing the operator cannot
            // otherwise see — the CLI shows nothing until the paste arrives.
            if (entry.inputThrottled) {
                return {
                    key: 'queued',
                    label: `paste queued — ${formatBytes(entry.queuedBytes || 0)}`
                };
            }
            return { key: 'live', label: 'accepts input' };
        }
```

Seed `inputThrottled: false` and `queuedBytes: 0` alongside the other per-entry flags in
the entry literal (near `suppressAnswerback: false`, line 4078).

**Trap — `refreshInputState` hardcodes its class-removal list** (line 1811):

```javascript
paneEl.classList.remove('is-input-live', 'is-input-connecting', 'is-input-readonly');
```

`is-input-queued` MUST be added here. Miss it and a pane that was ever throttled keeps the
class for the life of the page, because `updatePaneElement` only ever *adds*
(`paneEl.classList.add(\`is-input-${state.key}\`)`, line 2319).

### File 2: `src/webview/terminals.js` — replace the four writes

`inputThrottled` frame (lines 4640-4645) — record state, repaint chrome, write nothing:

```javascript
                } else if (frame.t === 'inputThrottled') {
                    // Informational only — stdin stays enabled and input is queued,
                    // never dropped. The signal is the header chip, NOT a line in the
                    // buffer: see the prohibition on notifyInputDropped. A dispatch
                    // prompt clears INPUT_HIGH_WATER_BYTES routinely, and the old
                    // writes injected six rows of shift per paste into whatever
                    // full-screen CLI was running in the pane.
                    entry.inputThrottled = frame.throttled !== false;
                    entry.queuedBytes = frame.queued || 0;
                    refreshInputState(entry.name);
                }
```

`error` frame (line 4648) — a hard, one-shot failure. The chip cannot carry a
free-text message, and this is transient news rather than a durable state, so it belongs
in the toast channel the panel already has (`toastContainerEl`, line 104; the append site
is line 4881):

```javascript
                    showToast(`${entry.name}: ${frame.message || 'Terminal unavailable'}`, 'error');
                    refreshInputState(entry.name);
```

`close` handler (line 4653) — delete the write outright. `refreshInputState(entry.name)`
is already called on the line above it, and `resolveInputState` already resolves
`connecting` from the non-`OPEN` socket. No replacement is needed; the notice was
redundant the day it was written.

Clear the throttle state on `ws.onclose` and `ws.onopen` as well
(`entry.inputThrottled = false; entry.queuedBytes = 0;`). A socket that dies mid-paste
otherwise strands the chip on "paste queued" forever, and the gateway's `throttled:false`
frame for that queue will never arrive.

### File 3: `src/webview/terminals.html` — style the new state

Add `.is-input-queued` beside the existing two chip rules (line 709) and the matching
`.has-caret.is-input-queued` ring rule (line 668). Use an existing accent token — this is
a *healthy* state, so it must not borrow the `readonly`/`connecting` colours that mean
"your keystrokes will not land".

Per the `syncInputStateChip` note, terse layouts (2x3, 3x3) render the chip as a bare dot
with the label in `title`; the new state inherits that for free.

## Edge Cases

**Terse layouts.** `isTerseLayout()` blanks `chip.textContent` and relies on `chip.title`.
The byte count therefore only shows in roomy layouts — correct, and the same trade the
other states already make.

**Paste into an unassigned terminal.** `refreshInputState` early-returns when
`paneAssignments.indexOf(name) < 0`, so a background terminal records the flag and paints
nothing. When it is next seated, `updatePaneElement` derives the chip from
`resolveInputState` at render time (line 2318), so the state appears with no extra wiring.

**Exited terminal that was mid-paste.** `resolveInputState` checks `exited`/`disableStdin`
*before* the `OPEN` branch, so `readonly` correctly outranks `queued`.

**Multiple clients on one pty.** `inputThrottled` is per-connection state on the gateway
(`InputQueue` is keyed by terminal, but `notifyInputThrottle` fans out to every client of
that terminal). All attached clients therefore show the chip together — an improvement
over the current behaviour, where each client wrote its own notice into its own private
copy of the buffer and the views diverged permanently.

**Toast volume.** The error frame is not rate-limited today and is not made worse here; a
flapping backend produces one toast per frame. Toasts self-dismiss and leave no residue,
which is the entire point of moving off the buffer.

## Dependencies

None. Every function this touches — `resolveInputState`, `refreshInputState`,
`syncInputStateChip`, `showToast` — already exists and is already exercised by the
socket-transition path. No gateway change, no protocol change, no new fields on the wire
(`frame.throttled` and `frame.queued` are already sent by `notifyInputThrottle`).

## Adversarial Synthesis

**"The paste notice is genuinely useful — the operator needs to know a big paste is still
landing."** Agreed, and that is why this converts it rather than deleting it. The
disagreement is only about the surface. A chip says the same thing, self-corrects when the
queue drains, and does not vandalise the screen of the program the operator is pasting
*into*.

**"A fourth input state complicates a resolver the codebase deliberately kept to three."**
The resolver's own doc-comment says its job is to *name the state* and the caller decides
whether to draw it. A fourth name is exactly the shape it was built for. The real cost is
the hardcoded class list in `refreshInputState`, which is why this plan calls it out as a
trap rather than leaving it to be discovered.

**"`[Disconnected — reconnecting…]` at least proves the client noticed."** It proves it to
the buffer, permanently, in a place that cannot be dismissed — and the chip beside the
pane title proves it better, because it *clears itself* when the socket returns. A stale
"reconnecting" line in scrollback after a successful reconnect is actively misleading.

**Risk: removing the writes reduces the durable record of a flap.** Real, and accepted.
The console already logs socket transitions, and durable transport history belongs in a
log, not in the operator's scrollback interleaved with agent output.

## Verification Plan

### Automated Tests

New contract test `src/test/terminal-chrome-not-in-buffer.test.js`, in the style of the
existing source-scanning contract tests:

1. **No bracketed notices are written to the buffer.** Scan `terminals.js` for
   `entry.term.write(` calls whose argument matches `/\\r\\n.*\[.*\]/`. Assert exactly one
   survivor and that it is the process-exit line. This is the regression guard the
   `notifyInputDropped` comment has been asking for since it was written.
2. **`refreshInputState` clears every state class it can set.** Extract the
   `classList.remove(...)` argument list and the set of keys `resolveInputState` can
   return; assert `remove` covers all of them. Catches the hardcoded-list trap
   permanently, for this state and any future one.
3. **The throttle flag is cleared on both socket transitions.** Assert `inputThrottled` is
   reset in `ws.onopen` and `ws.onclose`.
4. **`live` still renders no chip.** Guard the existing invariant against the new branch.

`terminal-focus-affordance-contract.test.js` already asserts the chip is derived and never
cached, and that one writer both creates and removes it — both must stay green.

### Manual Verification

1. Open the browser cockpit with a Claude CLI terminal in a single-pane layout.
2. Let the CLI settle so the mode strip (`auto mode on (shift+tab to cycle)`) is drawn.
3. Dispatch a prompt whose payload exceeds 64 KB (any plan file will do).
4. **Verify:** the pane header shows a "paste queued" chip while the paste lands, and the
   chip clears itself when the queue drains.
5. **Verify:** no `[Pasting…]` or `[Input queue drained]` line appears anywhere in the
   buffer, and the CLI's mode strip is intact and correctly positioned afterwards.
6. Scroll back through the transcript. **Verify:** no notice residue from the paste.
7. Kill the standalone host to force a disconnect. **Verify:** the chip reads
   "connecting", no `[Disconnected — reconnecting…]` line is written, and the chip clears
   itself when the host returns.
8. Repeat step 3 in a 2x3 layout. **Verify:** the chip renders as a bare dot with the
   label reachable via its `title`.
9. Attach the same terminal in two surfaces at once. **Verify:** both show the chip
   together, and their scrollback stays byte-identical through a paste and a reconnect.
10. Exit a terminal (`exit`). **Verify:** the `[Process Exited with code 0]` line is still
    written, and the chip reads "read-only".
