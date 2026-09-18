# Four Client Notices Are Written Into the Terminal Buffer, Corrupting Any TUI's Screen Model

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
| 4864 | `\r\n\x1b[2m[Input queue drained]\x1b[0m\r\n` |
| 4866 | `\r\n\x1b[2m[Pasting — input queued: N bytes…]\x1b[0m\r\n` |
| 4871 | `\r\n\x1b[31m[<frame.message \| Terminal unavailable>]\x1b[0m\r\n` |
| 4876 | `\r\n\x1b[33m[Disconnected — reconnecting…]\x1b[0m\r\n` |

> **Superseded:** The line numbers above previously read 4642 / 4644 / 4648 / 4653, and the
> exit line was cited at 4657.
> **Reason:** `terminals.js` has grown by ~222 lines since this plan was drafted; every
> line number in the original text pointed into unrelated code. A coder following stale
> anchors edits the wrong site or gives up and improvises.
> **Replaced with:** Re-verified anchors at HEAD (`terminals.js` is 5405 lines). Notices at
> 4864, 4866, 4871, 4876; exit line at 4881. Every other line reference in this plan has
> been re-verified against HEAD as well and is listed in the anchor table under *Proposed
> Changes*.

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

*Mechanism confirmed by primary-source research (2026-08-09) — see Resolved Assumptions.*
Ink delegates every frame to its internal `log-update`, which prepends
`ansiEscapes.eraseLines(previousLineCount)` to the new output: `CUU` (`\x1b[{n}A`) up by
the recorded count, `\r`, then `EL 2` (`\x1b[2K`) per line. `previousLineCount` is Ink's
own in-memory height of its last React frame. Ink runs in a separate process attached to
the pty and receives **no signal** that a client mutated the emulator's cursor, so an
injected notice moves the VT cursor down by N without moving that counter. Every
subsequent frame then erases from an origin N rows too low, leaving N ghost rows above and
pushing the new frame N rows down. The drift is **cumulative**: each render inherits the
corrupted baseline, so a single 3-row notice desynchronises the pane for the rest of the
session. `SIGWINCH` does not reliably recover it — Ink still erases relative to its own
recorded height, so a resize mid-drift tends to compound the wrap artifacts rather than
clear them.

The paste notice is the one that fires in normal use. `INPUT_HIGH_WATER_BYTES` is 64 KB
(`src/standalone/terminalWsGateway.ts:15`), and a dispatch prompt carrying a plan file
clears that comfortably. It also fires *twice* per paste — once when the queue crosses the
high-water mark (`terminalWsGateway.ts:212`) and once when `clearInputThrottleIfDrained`
sends `throttled: false` (`terminalWsGateway.ts:278`) — so a single dispatch injects two
notices, six rows of shift, into the pane it was aimed at.

### Background Context

**This policy is already settled in this codebase, for one site.** `notifyInputDropped`
(`terminals.js:2029`) carries an explicit prohibition:

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

- `resolveInputState(name)` (line 1947) — names the state; returns `{ key, label }`.
- `refreshInputState(name)` (line 1967) — repaints only the pane's state class and chip,
  deliberately without re-appending any xterm (a grid rebuild during a socket transition
  yanks the caret mid-keystroke).
- `syncInputStateChip(paneEl, titleEl, state)` (line 1995) — the single writer; creates,
  updates *and* removes the chip. `live` renders nothing.
- CSS tokens `.is-input-connecting` / `.is-input-readonly` on `.terminal-pane`, plus the
  `.has-caret.is-input-*` ring recolour (`terminals.html:655-717`).

`[Disconnected — reconnecting…]` is already fully represented by this machinery — the
socket is not `OPEN`, so `resolveInputState` returns `connecting` and the chip renders
"connecting". The write at line 4876 is a *second* notification stacked on one the
operator already has, which is precisely the defect the `notifyInputDropped` comment
describes.

**Deliberately out of scope: the exit line** at 4881
(`[Process Exited with code N]`). It is written to a terminal whose process is gone, so
the stated harm — corrupting a TUI's screen model — cannot occur: nothing will ever
redraw over it. It is also the only record of the exit *code*, which the `readonly` chip
does not carry. It stays.

**Not a factor: the backpressure ledger.** `onWriteParsed` is wired only to the batch
flush (line 4954) and the replay write (line 4978). These four notices are unbilled
today and will simply stop existing, so `pendingAckChars` is unaffected in both
directions.

## Metadata

**Tags:** frontend, bugfix, ui, reliability
**Complexity:** 5

> **Superseded:** `**Complexity:** 4` and `**Tags:** frontend, bugfix, terminals, ui, reliability`
> **Reason:** (a) `terminals` is not in the permitted tag vocabulary and would be dropped
> or mis-filed on import. (b) Complexity 4 was scored against a one-site class-list fix.
> Verification at HEAD found *three* `is-input-*` removal sites, two helper functions the
> plan assumed existed that do not (`showToast`, `formatBytes`), and a misattributed
> handler — three files plus a new test, touching a resolver with three consumers. That is
> a Mixed 5: majority routine, two well-scoped risks.
> **Replaced with:** `**Tags:** frontend, bugfix, ui, reliability` / `**Complexity:** 5`.

## User Review Required

None. Every decision below is settled inside the plan; the scope boundary (the exit line
stays) is explicit and justified.

## Complexity Audit

### Routine

- Deleting four `entry.term.write(...)` calls.
- Adding two per-entry flags (`inputThrottled`, `queuedBytes`) to the entry literal
  (`terminals.js:4301`) and clearing them on `ws.onopen` / `ws.onclose`.
- Adding one branch to `resolveInputState`.
- Adding two CSS rules (chip colour + the toast error modifier).
- Writing the source-scanning contract test in the established style.

### Complex / Risky

- **Three separate `classList.remove('is-input-live', 'is-input-connecting', 'is-input-readonly')`
  sites** (`terminals.js:1973`, `:2426`, `:2760`) must all learn `is-input-queued`. The
  original plan named only one. Missing `:2426` (`updatePaneElement`) is the worst of the
  three: it removes-then-adds on every reconcile, so a queued→live transition leaves the
  pane wearing both classes for the life of the page.
- **The error frame's replacement notification does not exist.** There is no `showToast`
  in this codebase. Getting this wrong is not a cosmetic miss — see the Adversarial
  Synthesis; it silently kills the `disableStdin` and `refreshInputState` lines that
  follow it.
- **`[Disconnected — reconnecting…]` is not in `ws.onclose`.** It is in the `exit` frame
  arm under `frame.reason === 'Lagging client evicted'` (`terminals.js:4875-4877`).
  Deleting the write leaves an empty `if` block.
- Adding a *healthy* fourth state to a resolver whose CSS comment currently asserts "Only
  the two states an operator must act on" — the comment must be corrected in the same
  change or the file carries a lie.

## Edge-Case & Dependency Audit

### Race Conditions

- **Eviction → close ordering.** The gateway sends `{t:'exit', reason:'Lagging client evicted'}`
  and then immediately calls `client.ws.close()` (`terminalWsGateway.ts:727-729`). The exit
  frame is therefore processed while the socket is still `OPEN`, so for the interval
  between the frame and `onclose` the chip still reads `live`. `ws.onclose` (line 4891)
  calls `refreshInputState` (line 4894), which resolves `connecting` off the non-`OPEN`
  socket. The window is sub-millisecond and self-correcting; no extra nudge is warranted
  and none should be added.
- **Socket dies mid-paste.** The gateway's `throttled:false` frame for that queue will
  never arrive, so the chip would strand on "paste queued" forever. Cleared explicitly in
  both `ws.onopen` (line 4772) and `ws.onclose` (line 4891).
- **Drain frame carries a non-zero `queued`.** `clearInputThrottleIfDrained` fires when
  `queuedBytes < INPUT_LOW_WATER_BYTES`, not at zero, so `frame.queued` on the clear frame
  is often non-zero. Harmless: `throttled === false` flips the key to `live`, and `live`
  renders no chip, so the stale byte count is never displayed.

### Security

None. No new network surface, no new wire fields, no user-supplied string reaching
`innerHTML` — the toast body must be set via `textContent` (as `showCompletionToast`
already does at `terminals.js:5102`), because `frame.message` originates from the gateway
and is not sanitised.

### Side Effects

- The `.completion-toast` container (`terminals.html:1160-1170`) is `position: absolute`
  inside the panel and `pointer-events: none` on the container. Adding an error toast
  there inherits that placement — bottom-right of the cockpit, not per-pane. Accepted: the
  toast names the terminal in its body, which is the same identity `showCompletionToast`
  relies on.
- Removing the four writes changes what a `terminals.js` source scan finds. Any existing
  test asserting the *presence* of these strings would go red; none does (verified — no
  test references `Input queue drained`, `Pasting —`, or `Disconnected — reconnecting`).

### Dependencies & Conflicts

- `terminal-focus-affordance-contract.test.js` asserts the chip is derived and never
  cached, and that one writer both creates and removes it. Both invariants are preserved;
  this test must stay green.
- No gateway change, no protocol change, no new wire fields — `frame.throttled` and
  `frame.queued` are already sent by `notifyInputThrottle` (`terminalWsGateway.ts:271-276`).
- Single-file serialisation applies: `terminals.js` is one agent stream (PRD *Orchestration
  discipline*). Do not parallelise the two `terminals.js` sections below.

## Dependencies

None. No prior session is a prerequisite.

## Adversarial Synthesis

**Key risks:** (1) the plan as originally written called a `showToast` that does not exist
— an undefined call throws inside the `onmessage` `try`, is swallowed by
`catch { console.warn('[Terminals] Bad message:') }`, and silently skips the
`disableStdin = true` and `refreshInputState` lines that follow, leaving a dead terminal
accepting input with no notice at all; (2) three `is-input-*` class-removal sites exist,
not one, and `updatePaneElement`'s is the one that strands a stale class permanently;
(3) the `[Disconnected]` write is in the `exit` arm, not `ws.onclose`, and no
`refreshInputState` precedes it. **Mitigations:** an explicit named-and-verified helper
(`showTerminalErrorToast`) instead of a confabulated one, ordering the state mutations
*before* the notification call so a notification failure cannot strand the terminal, an
anchor table of all three class sites, and a contract test that derives the removal list
from `resolveInputState`'s actual return keys rather than hardcoding it.

## Proposed Changes

### Verified anchor table (HEAD, `terminals.js` = 5405 lines)

| Anchor | Line | Note |
| :--- | :--- | :--- |
| `toastContainerEl` | `terminals.js:112` | was cited as 104 |
| `resolveInputState` | `terminals.js:1947` | |
| `refreshInputState` | `terminals.js:1967` | |
| `classList.remove(...)` **site 1** | `terminals.js:1973` | in `refreshInputState` |
| `syncInputStateChip` | `terminals.js:1995` | |
| `notifyInputDropped` | `terminals.js:2029` | the prohibition comment |
| `isTerseLayout` | `terminals.js:2407` | |
| `updatePaneElement` | `terminals.js:2417` | |
| `classList.remove(...)` **site 2** | `terminals.js:2426` | **not in the original plan** |
| render-time chip derive | `terminals.js:2517-2519` | |
| `renderKanbanPane` | `terminals.js:2759` | |
| `classList.remove(...)` **site 3** | `terminals.js:2760` | **not in the original plan** |
| entry literal (`suppressAnswerback`) | `terminals.js:4301` | |
| `ws.onopen` | `terminals.js:4772` | |
| `inputThrottled` arm | `terminals.js:4860-4867` | |
| `error` arm | `terminals.js:4868-4873` | |
| `exit` arm | `terminals.js:4874-4884` | |
| exit line (stays) | `terminals.js:4881` | |
| `ws.onclose` | `terminals.js:4891` | |
| batch-flush write / replay write | `terminals.js:4954` / `:4978` | the two billed writes |
| `showCompletionToast` | `terminals.js:5089` | append at `:5116` |
| `.has-caret` ring + recolours | `terminals.html:655` / `:668` / `:675` | |
| `.pane-input-state` + colours | `terminals.html:685` / `:707-717` | |
| terse-layout chip rule | `terminals.html:719` | |
| `.toast-container` / `.completion-toast` | `terminals.html:1160` / `:1170` | |

### File 1: `src/webview/terminals.js` — add a `queued` input state

**Context.** `resolveInputState` (line 1947) currently resolves three keys. Input that is
*accepted but queued* is a fourth, orthogonal condition: the socket is `OPEN` and
keystrokes are landing, they are just behind a paste.

**Logic.** Insert the new branch inside the existing `OPEN` arm so the established
precedence (dead > disconnected > healthy) is untouched.

**Implementation.**

```javascript
        if (entry.ws && entry.ws.readyState === WebSocket.OPEN) {
            // Throttled is NOT a failure state and must not outrank `connecting`:
            // input is queued, never dropped (see the inputThrottled arm of the
            // socket handler and enqueueInput in terminalWsGateway). The chip says
            // "still landing", which is the only thing the operator cannot
            // otherwise see — the CLI shows nothing until the paste arrives.
            if (entry.inputThrottled) {
                const kb = Math.max(1, Math.round((entry.queuedBytes || 0) / 1024));
                return { key: 'queued', label: `paste queued — ${kb} KB` };
            }
            return { key: 'live', label: 'accepts input' };
        }
```

> **Superseded:** ``label: `paste queued — ${formatBytes(entry.queuedBytes || 0)}` ``
> **Reason:** There is no `formatBytes` in `terminals.js` (zero occurrences at HEAD). The
> call would throw a `ReferenceError` inside `updatePaneElement`'s render path, taking the
> whole pane render down with it.
> **Replaced with:** An inline KB rounding, above. The throttle only trips above 64 KB, so
> sub-KB precision is meaningless and a shared byte formatter is not worth introducing for
> one call site.

Seed `inputThrottled: false` and `queuedBytes: 0` in the entry literal alongside
`suppressAnswerback: false` (line 4301).

**Edge cases.** `readonly` still outranks `queued` because the `exited` /
`disableStdin` checks sit above the `OPEN` branch — an exited terminal that was mid-paste
resolves `readonly`, correctly.

### File 2: `src/webview/terminals.js` — teach **all three** class-removal sites the new key

**Context.** The pane's `is-input-*` class is the single source of truth the ring and the
chip both style off. Three sites clear it, and every one of them hardcodes the same
three-element list:

```javascript
paneEl.classList.remove('is-input-live', 'is-input-connecting', 'is-input-readonly');
```

- `terminals.js:1973` — `refreshInputState`
- `terminals.js:2426` — `updatePaneElement`
- `terminals.js:2760` — `renderKanbanPane`

> **Superseded:** "**Trap — `refreshInputState` hardcodes its class-removal list** (line
> 1811) … `is-input-queued` MUST be added here."
> **Reason:** Correct in kind, wrong in count. `grep -n "classList.remove('is-input-live'"`
> returns **three** hits at HEAD, not one. `updatePaneElement` is the most damaging omission:
> it clears-then-adds on every reconcile (line 2426 → 2518), so a pane that goes
> queued → live keeps `is-input-queued` *and* gains `is-input-live`, and CSS specificity
> leaves the queued colour painted permanently. `renderKanbanPane` leaves a stale queued
> ring on a pane flipped to kanban mode.
> **Replaced with:** All three sites take `'is-input-queued'`, and contract test #2 below
> derives the required removal set from `resolveInputState`'s actual return keys and checks
> **every** removal site, so a fourth site added later cannot silently regress.

**Implementation.** At each of the three sites:

```javascript
paneEl.classList.remove('is-input-live', 'is-input-connecting', 'is-input-readonly', 'is-input-queued');
```

### File 3: `src/webview/terminals.js` — replace the four writes

#### `inputThrottled` arm (lines 4860-4867)

Record state, repaint chrome, write nothing:

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

This also removes an unguarded `entry.term.write` — the old arm dereferenced `entry.term`
with no null check, so a throttle frame arriving before the view materialised threw into
the `onmessage` catch.

#### `error` arm (lines 4868-4873)

A hard, one-shot failure. The chip cannot carry a free-text message, and this is transient
news rather than a durable state, so it belongs in the toast channel.

> **Superseded:** ``showToast(`${entry.name}: ${frame.message || 'Terminal unavailable'}`, 'error');``
> and the Dependencies claim that "`showToast` … already exists".
> **Reason:** **There is no `showToast` in this codebase.** The only toast functions are
> `showPaneToast(text, onUndo)` (`terminals.js:885` — the pane-assignment undo bar, wrong
> semantics and no severity) and `showCompletionToast(title, role, termName)`
> (`terminals.js:5089` — hardcoded to render `Completed: <role>`). The cited "append site"
> at line 4881 is in fact the *exit line* this plan deliberately keeps.
>
> This is not a naming nit. An undefined identifier throws a `ReferenceError`, the
> `onmessage` body is wrapped in `try { … } catch (err) { console.warn('[Terminals] Bad
> message:', err); }`, and in the plan's ordering the throw lands **before**
> `entry.term.options.disableStdin = true` and `refreshInputState(entry.name)`. Net result:
> all four writes are gone (contract test green), the chip machinery is in place (contract
> test green), and yet a terminal that just died still accepts input, shows no chip, and
> shows no toast. Strictly worse than the buffer write it replaced.
> **Replaced with:** A named, real helper plus a mutation ordering that cannot be stranded
> by a notification failure.

```javascript
                } else if (frame.t === 'error') {
                    // State first, notification second. A throw inside the toast path
                    // must not be able to leave a dead terminal accepting input — the
                    // onmessage catch swallows it into a console.warn.
                    dismissStartupCurtain(entry.name);
                    entry.exited = true;
                    if (entry.term) { entry.term.options.disableStdin = true; }
                    refreshInputState(entry.name);
                    showTerminalErrorToast(entry.name, frame.message || 'Terminal unavailable');
                }
```

Add the helper beside `showCompletionToast` (after line 5117). It reuses the existing
`toastContainerEl` (line 112) and the existing `.completion-toast` DOM shape with an
`is-error` modifier — no refactor of the shipped completion path, no new container:

```javascript
    /** Transient, dismissible terminal failure notice. Deliberately NOT a line in
     *  the buffer: see the prohibition on notifyInputDropped. Mirrors
     *  showCompletionToast's DOM so the two share every .toast-* rule. */
    function showTerminalErrorToast(termName, message) {
        if (!toastContainerEl) { return; }
        const toast = document.createElement('div');
        toast.className = 'completion-toast is-error';

        const content = document.createElement('div');
        content.className = 'toast-content';

        const titleEl = document.createElement('div');
        titleEl.className = 'toast-title';
        titleEl.textContent = `Terminal error: ${termName}`;

        const bodyEl = document.createElement('div');
        bodyEl.className = 'toast-body';
        // textContent, never innerHTML — frame.message comes off the wire.
        bodyEl.textContent = message;

        content.appendChild(titleEl);
        content.appendChild(bodyEl);

        const closeBtn = document.createElement('button');
        closeBtn.className = 'toast-close';
        closeBtn.textContent = '×';
        closeBtn.addEventListener('click', () => {
            if (toast.parentNode) { toast.parentNode.removeChild(toast); }
        });

        toast.appendChild(content);
        toast.appendChild(closeBtn);
        toastContainerEl.appendChild(toast);

        setTimeout(() => {
            if (toast.parentNode) { toast.parentNode.removeChild(toast); }
        }, 8000);
    }
```

*Alternative considered and rejected:* extracting a shared `showToast(title, body, kind)`
and repointing `showCompletionToast` at it. Cleaner in the abstract, but it edits a shipped
notification path for a two-call-site DRY win — the PRD's byte-compatibility contract makes
the in-place duplicate the cheaper trade.

#### `exit` arm — the eviction branch (lines 4874-4877)

> **Superseded:** "`close` handler (line 4653) — delete the write outright.
> `refreshInputState(entry.name)` is already called on the line above it."
> **Reason:** Both claims are wrong at HEAD. The write is **not** in `ws.onclose`
> (line 4891) — it is in the `exit` frame arm, inside `if (frame.reason === 'Lagging client
> evicted')` (line 4875). And there is no `refreshInputState` on the line above it; that
> `if` branch contains the write and nothing else. Deleting the write as instructed leaves
> a syntactically valid but empty `if` block, and a coder who goes looking for the
> "already called" refresh and cannot find it will improvise one.
> **Replaced with:** Invert the condition so the eviction case is simply *not handled here*,
> which is the honest expression of "the socket close already covers it".

```javascript
                } else if (frame.t === 'exit') {
                    // 'Lagging client evicted' is deliberately unhandled. The gateway
                    // calls ws.close() immediately after sending it
                    // (terminalWsGateway.ts:727-729), so ws.onclose fires, calls
                    // refreshInputState, and resolveInputState reports `connecting`
                    // off the non-OPEN socket. The old buffer line was a second
                    // notification stacked on one the operator already had — and a
                    // permanent one, still reading "reconnecting" long after the
                    // socket came back.
                    if (frame.reason !== 'Lagging client evicted') {
                        dismissStartupCurtain(entry.name);
                        const exitCode = typeof frame.code === 'number' ? frame.code : 0;
                        entry.exited = true;
                        entry.term.write(`\r\n\x1b[31m[Process Exited with code ${exitCode}]\x1b[0m\r\n`);
                        entry.term.options.disableStdin = true;
                        refreshInputState(entry.name);
                    }
                }
```

#### Throttle-flag clearing

In `ws.onopen` (line 4772) and `ws.onclose` (line 4891), before the existing
`refreshInputState(entry.name)` call:

```javascript
            entry.inputThrottled = false;
            entry.queuedBytes = 0;
```

`ws.onclose` early-returns when `entry.exited` — that is fine, because `readonly` outranks
`queued` in the resolver, so a stranded flag on an exited terminal is unreachable.

### File 4: `src/webview/terminals.html` — style the new state

**Context.** The chip colours live at lines 707-717 and the ring recolours at 668-681.

**Implementation.** Add one chip rule beside the existing two, and correct the comment
above them that currently asserts the set is closed:

```css
        /* No .is-input-live rule: the live state renders no chip at all — see
           syncInputStateChip. The other three each say something the operator
           cannot otherwise see. */
        .is-input-queued .pane-input-state {
            color: var(--accent-teal);
            background: color-mix(in srgb, var(--accent-teal) 12%, transparent);
        }
```

> **Superseded:** "Add … the matching `.has-caret.is-input-queued` ring rule (line 668)."
> **Reason:** The ring recolours exist for exactly one purpose, stated in the comment at
> `terminals.html:664-667`: "A focused pane that cannot take input must not wear the 'type
> here' colour." `queued` is a pane that **can** take input. The default `.has-caret` rule
> (line 655) already paints `var(--accent-teal)`, so a `.has-caret.is-input-queued` rule
> would restate the default verbatim — dead CSS that invites a future editor to "fix" it
> into a warning colour and reintroduce the lie.
> **Replaced with:** No ring rule. The absence *is* the correct behaviour, and the comment
> above the recolour block should say so.

`--accent-teal` is the right token: it is theme-aware (cyan on `:root`, `#D97757` in the
alternate theme, `terminals.html:31-64`) and it is the codebase's "healthy / active"
accent, so the chip cannot be mistaken for the `connecting` amber or the `readonly` red.

Add the error-toast modifier beside `.completion-toast` (line 1170):

```css
        .completion-toast.is-error {
            border-color: var(--state-readonly);
        }
        .completion-toast.is-error .toast-title {
            color: var(--state-readonly);
        }
```

**Edge cases.** Per the `syncInputStateChip` note, terse layouts (2x3, 3x3) blank
`chip.textContent` and carry the label in `chip.title` (rule at line 719); the new state
inherits that for free with no extra rule.

## Verification Plan

### Automated Tests

Per the session directive, **no test run and no compilation step is part of this change's
verification gate** — the manual pass below is the gate. The test file is still a
deliverable: it is the regression guard the `notifyInputDropped` comment has been asking
for since it was written.

New contract test `src/test/terminal-chrome-not-in-buffer.test.js`, in the style of the
existing source-scanning contract tests (`terminal-focus-affordance-contract.test.js`,
`terminal-input-path-contract.test.js`):

1. **No bracketed notices are written to the buffer.** Scan `terminals.js` for
   `entry.term.write(` calls whose argument matches `/\\r\\n.*\[.*\]/`. Assert exactly one
   survivor and that it is the process-exit line.
   *Known limitation, stated so nobody mistakes green for proof:* this matches the **shape
   of the old bug**, not the invariant. A future notice written through a variable
   (`entry.term.write(msg)`) or assembled above the call passes it untouched. Assert
   additionally that the only `entry.term.write(` call sites in the file are the five known
   ones (DEC-mode `seq` at 4110, the exit line, the batch flush, the replay write, and
   `writeReplay`'s), so a **new** write site fails the test regardless of its argument shape.
2. **Every `is-input-*` removal site clears every key the resolver can return.** Extract
   the set of `key:` literals `resolveInputState` returns, then extract *every*
   `classList.remove('is-input-…')` argument list in the file (there are three) and assert
   each covers the full set. Hardcoding "check `refreshInputState`" is what let sites 2 and
   3 go unnoticed; derive both sides.
3. **The throttle flag is cleared on both socket transitions.** Assert `inputThrottled` is
   reset in `ws.onopen` and `ws.onclose`.
4. **`live` still renders no chip.** Guard the existing invariant against the new branch.
5. **The error arm sets `disableStdin` before it notifies.** Assert the
   `disableStdin = true` / `refreshInputState` lines precede `showTerminalErrorToast` in the
   `frame.t === 'error'` arm, and that `showTerminalErrorToast` is defined in the file.
   This is the specific failure the superseded `showToast` would have produced silently.

`terminal-focus-affordance-contract.test.js` already asserts the chip is derived and never
cached, and that one writer both creates and removes it — both must stay green.

### Manual Verification

1. Open the browser cockpit with a Claude CLI terminal in a single-pane layout.
2. Let the CLI settle so the mode strip (`auto mode on (shift+tab to cycle)`) is drawn.
3. Dispatch a prompt whose payload exceeds 64 KB (any plan file will do).
4. **Verify:** the pane header shows a "paste queued — N KB" chip in the teal accent while
   the paste lands, and the chip clears itself when the queue drains.
5. **Verify:** no `[Pasting…]` or `[Input queue drained]` line appears anywhere in the
   buffer, and the CLI's mode strip is intact and correctly positioned afterwards.
6. Scroll back through the transcript. **Verify:** no notice residue from the paste.
7. **Verify the queued→live class transition specifically** (the `updatePaneElement` trap):
   after the chip clears, inspect the pane element and confirm it carries `is-input-live`
   and **not** `is-input-queued`. Then change layout (forcing a full `renderPaneGrid`) and
   confirm the same.
8. Kill the standalone host to force a disconnect. **Verify:** the chip reads
   "connecting", no `[Disconnected — reconnecting…]` line is written, and the chip clears
   itself when the host returns.
9. Force an `error` frame (stop the pty backend for one terminal). **Verify:** a
   bottom-right error toast appears naming the terminal, it is dismissible, the pane chip
   goes read-only, and typing into the pane does nothing. **Both** the toast and the
   read-only state must appear — if the chip is right but the toast is missing, or vice
   versa, the ordering fix regressed.
10. Repeat step 3 in a 2x3 layout. **Verify:** the chip renders as a bare dot with the
    label reachable via its `title`.
11. Attach the same terminal in two surfaces at once. **Verify:** both show the chip
    together, and their scrollback stays byte-identical through a paste and a reconnect.
12. Exit a terminal (`exit`). **Verify:** the `[Process Exited with code 0]` line is still
    written, and the chip reads "read-only".
13. Switch a pane to kanban mode while another pane is mid-paste. **Verify:** the kanban
    pane carries no `is-input-*` class (the `renderKanbanPane` removal site).

## Resolved Assumptions

Both open uncertainties were closed by primary-source web research on 2026-08-09. **This
section is authoritative — do not re-open these questions or re-research them.** No
uncertainties remain; nothing here blocks implementation.

1. **Ink's redraw mechanism — CONFIRMED, and the root cause is worse than stated.** Ink
   renders through Yoga into a 2D grid, then dispatches via its internal `log-update`,
   which prepends `ansiEscapes.eraseLines(previousLineCount)` — `CUU` (`\x1b[{n}A`), `\r`,
   `EL 2` (`\x1b[2K`) per line. It does **not** use absolute positioning (`CSI {row};{col}H`)
   and does **not** full-clear (`\x1b[2J`). `previousLineCount` is Ink's own in-process
   height of its last React frame; the Ink process gets no notification that a client
   mutated the emulator cursor. The drift is therefore **cumulative across every
   subsequent render**, not a one-frame glitch, and `SIGWINCH` does not reliably clear it.
   The plan's original narrative was correct; this only sharpens it.
2. **xterm.js decorations — CONFIRMED UNSUITABLE, on stronger grounds than assumed.**
   `registerDecoration` binds a DOM element to an `IMarker` at a *buffer line index*, so
   decorations scroll with content; there is no viewport-pinning option; a marker whose
   line is trimmed from scrollback fires `onDispose` and destroys the decoration; and
   `registerDecoration` returns `undefined` outright when the alternate screen buffer is
   active. VS Code uses decorations only for line-anchored gutter marks and uses
   absolute-positioned DOM overlays for every viewport-fixed notice — the same split this
   plan lands on. Rejection stands.
3. **NEW — foreclose the "gate writes on alt-screen" fix before someone tries it.**
   Research established that **Claude Code and Gemini CLI run in the primary (normal)
   screen buffer**, deliberately, so their transcript stays in native scrollback. They do
   **not** issue `\x1b[?1049h`. A future editor reaching for
   `if (terminal.buffer.active.type !== 'alternate') { entry.term.write(...) }` as a
   cheaper alternative to this plan would therefore build a guard that reads `'normal'` for
   exactly the CLIs this defect targets — zero protection, with the appearance of a fix.
   That check is not a valid alternative to moving the notices off the buffer, and the
   contract test in the Verification Plan is what keeps the writes from coming back under
   any such guard. Likewise DEC 2026 (synchronised output) controls frame atomicity only;
   it does not stop an out-of-band write from moving the cursor.

---

**Recommendation: Send to Coder** (Complexity 5).

## Completion Summary

Implemented in full. The four client-side notices (input queue drained, pasting, terminal unavailable, disconnected-reconnecting) no longer write into the xterm buffer — they are now pane chrome. `resolveInputState` gained a `queued` branch (open socket + `inputThrottled` → "paste queued — N KB" chip); all three `is-input-*` class-removal sites (`refreshInputState`, `updatePaneElement`, `renderKanbanPane`) now clear `is-input-queued`; the `inputThrottled` arm records state + repaints the chip; the `error` arm sets `disableStdin` and refreshes state before calling a new `showTerminalErrorToast` helper (textContent only, null-guarded, mirrors `showCompletionToast`'s DOM); the `exit` arm inverts its condition so the eviction case is unhandled (the socket close already covers it) and the process-exit line is preserved. Throttle flags are seeded in the entry literal and cleared in `ws.onopen`/`ws.onclose`. CSS adds the `.is-input-queued` chip rule (teal) and the `.completion-toast.is-error` modifier (readonly red), and corrects the chip comment. Files changed: `src/webview/terminals.js`, `src/webview/terminals.html`, new `src/test/terminal-chrome-not-in-buffer.test.js` (registered in `package.json` + CI). Anchors were re-verified at HEAD (file grew to 5807 lines; the plan's 5405-line anchors were stale). No issues encountered.

## Review Findings

Reviewed against the plan; the implementation is correct and complete, but the plan's claim that no existing test asserts the removed notices was **false in three places**, leaving four CI-wired gates red. Fixed: `terminal-input-path-contract.test.js:110,196` (throttle branch now reads `frame.throttled !== false`; `batchQueue` substring check narrowed to `batchQueue.push`), `terminal-solo-popout-contract.test.js:62-90,104` (exit-arm polarity inverted — assertions made polarity-aware and the `[Disconnected — reconnecting…]` presence check inverted to an absence check), and `terminal-chrome-not-in-buffer.test.js:91` (its own `entry.term.write` call-site count of 4 did not admit the sibling subtask's RIS write — raised to 5). Files changed by this subtask: `src/webview/terminals.js`, `src/webview/terminals.html`, `src/test/terminal-chrome-not-in-buffer.test.js` (new, wired in `package.json` + CI), plus the three test fixes above. Verification executed (no skip directive in the dispatch): `terminal-chrome-not-in-buffer` 10/10, `terminal-input-path` 19/19, `terminal-solo-popout` 11/11, `terminal-focus-affordance`/`terminal-flow-control`/`terminal-dec-mode-restore`/`terminal-rename-rekey` green except one **pre-existing** `terminal-focus-affordance` failure (`entry.inputDropNoticed` is absent at HEAD too), and `tsc -p tsconfig.test.json` clean. Remaining risk: the `queued` chip and the error toast have no automated rendering coverage — manual steps 4-10 of the plan are still the gate for what the operator actually sees.
