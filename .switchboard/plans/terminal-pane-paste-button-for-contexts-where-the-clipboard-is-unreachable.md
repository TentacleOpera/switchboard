# Browser terminals have no paste affordance, so paste works only where the browser and OS happen to cooperate — and on Linux and touch they do not

## Goal

Give every browser terminal pane an explicit Paste control that puts clipboard text into
the pty through xterm's own paste path, so pasting does not depend on `navigator.clipboard`
being present, on a keyboard shortcut reaching the canvas, or on the page being a secure
context. One control, one code path, fixing a Linux failure and a touch impossibility at
the same time.

### Problem Analysis

**There is no paste UI at all.** `src/webview/terminals.js` has no `term.paste(` call
anywhere and no paste control in the pane header — `.pane-actions` (`:6300`) carries the
pane's buttons and paste is not among them. Every paste that works today works by accident
of the host: the browser's own keyboard handling delivers a `paste` event into xterm's
hidden textarea, and xterm forwards it. When that chain breaks there is no fallback,
because no second path was ever built.

**The chain breaks in at least two environments.**

- **Touch.** iPadOS has no Ctrl+V. The OS paste callout requires a long-press on a
  focusable text element, and xterm renders through `@xterm/addon-webgl` /
  `@xterm/addon-canvas`, so the visible terminal is a canvas with no text to long-press.
  This is the same rendering fact that makes copying *out* impossible, and it is why native
  SSH clients ship an explicit Paste button rather than relying on the OS gesture.
- **Linux — a modifier collision, now diagnosed.** `.switchboard/memo.md:14` records it:
  *"cannot copy pty terminal text on linux as all the other commands clash. On macOS, Cmd+C
  and Cmd+V are unambiguous — nothing in the terminal uses Cmd… On Linux there's no
  equivalent free modifier. Ctrl+C is SIGINT, Ctrl+V is literal-next in some contexts, so
  xterm.js has to be told explicitly what to do with Ctrl+Shift+C/V. It doesn't handle that
  by default — you add a key handler."* Confirmed in source: `terminals.js` contains no
  `attachCustomKeyEventHandler` and no `getSelection` call anywhere, so nothing has ever
  told xterm what Ctrl+Shift+C/V mean. Ctrl+Shift+V is not a browser paste accelerator
  either, so no native `paste` event fires from it — the keystroke reaches nothing.

  **That cause has its own plan and its own fix (a key handler), not this one.** It is
  named here because the two are complementary and their boundary matters: a key handler
  fixes the desktop where a keyboard exists, and cannot help a device with no Ctrl key. The
  button fixes every context including the ones where the Clipboard API is absent. Where
  they meet is the Linux operator on the tailnet URL, for whom Ctrl+Shift+V has no
  clipboard to read from — see Dependencies.

**The insecure-context path is already load-bearing elsewhere, and it only solves copy.**
`docs/REMOTE_ACCESS.md:88-97` documents it plainly: a board served over
`http://100.x.y.z:port/` is not a secure context, `navigator.clipboard` is unavailable, and
`src/webview/clipboardFallback.js` routes every copy button through a hidden `<textarea>` +
`document.execCommand('copy')`. That fallback is **write-only by construction**. There is no
read counterpart, and there cannot be one: `document.execCommand('paste')` is refused from
script in every current browser, and `navigator.clipboard.readText()` is both absent here
and gated behind a permission prompt where it exists.

### Root Cause

Paste was treated as a browser-provided behaviour rather than an application feature, so it
was never given a code path of its own. That assumption holds on a desktop browser with a
hardware keyboard and breaks everywhere else. The copy direction was recognised as needing
an application-level fallback and got one; the paste direction has the harder constraint —
script cannot read the clipboard — and got nothing.

### The one mechanism that works in every context

Script cannot read the clipboard, but a **user-initiated OS paste into a real editable
element** delivers its payload to a `paste` event, in every browser, in secure and insecure
contexts alike, with no permission prompt. That is what the native clients do and it is the
only universally available primitive.

So the control is not "read the clipboard and inject it". It is: focus a real `<textarea>`,
let the operator perform their platform's own paste gesture into it (long-press → Paste on
iOS, Ctrl+V or middle-click on Linux, Cmd+V on macOS), read `event.clipboardData`, and hand
the text to the terminal.

**The text must go in via `term.paste(text)`, not a raw WebSocket write.** This is
load-bearing for two reasons the codebase already documents:

1. **Bracketed paste.** `term.paste()` applies the `\x1b[200~` / `\x1b[201~` wrapping when
   DEC mode 2004 is active. The mode is already tracked and restored on reattach
   (`terminals.js:10522-10527`). A raw `ws.send` of the payload delivers it as typed input,
   which is precisely the "the whole block echoes instead of collapsing" symptom.
2. **Paste attribution.** `terminals.js:6082-6088` states it directly: *"term.onData fires
   only for locally typed/pasted input"*, which is why the drag-drop path has to attribute
   itself explicitly via `attributePasteDispatch`. `term.paste()` routes through `onData`, so
   a button built on it inherits the existing attribution for free. A raw write would
   silently bypass it and require a second attribution path.

The input transport underneath is already fit for this: binary input frames, a per-terminal
FIFO, 4096-byte paced chunking with UTF-8 and escape-sequence-safe boundaries, and a
5&nbsp;MB frame cap, all delivered by `terminal-input-paste-path.md`. A large paste through
this button is a solved problem, which is a meaningful de-risking.

### Non-goals

- **Not copy.** Getting text *out* of a canvas-rendered terminal on touch is a separate and
  harder problem. This plan does not solve it and must not imply it does.
- **Not a clipboard-read API.** No `navigator.clipboard.readText()` path, not even as a
  "nicer where available" branch — see the Adversarial Synthesis for why two paths is worse
  than one.
- **Not a change to the input transport.** Frames, chunking and pacing are shipped and
  correct. This plan feeds them; it does not touch them.
- **Not a confirmation dialog, in any form.** See User Review.
- **Not an image paste.** `feature_plan_20260804132725_paste_images_into_browser_terminals.md`
  owns that. Text only.

## Metadata

**Complexity:** 4
**Tags:** ui, ux, frontend, bugfix, mobile
**Project:** Browser Switchboard

## User Review Required

**None.** An earlier draft of this plan proposed a confirmation gate in front of multi-line
pastes. That is forbidden: `CLAUDE.md` states *"NEVER add confirmation dialogs. NO
EXCEPTIONS… If you find a confirm gate in this codebase, it is a bug — remove it."* The rule
also has a technical edge — `window.confirm()` is a silent no-op in VS Code webviews, so a
gate would make the control do literally nothing in the extension host.

**The safety property comes from visibility, not from a gate.** The textarea this design
already requires *is* the preview: the operator performs their OS paste, sees the content
sitting in a visible field, and taps SEND. A multi-line payload is legible before it lands
because it is on screen, not because anything interrupted them. SEND is the control, not a
confirmation of a prior control — there is exactly one decision point and the operator was
always going to press it.

This costs nothing relative to the alternative, because the textarea is not optional: it is
the only way to obtain clipboard text without the Clipboard API.

## Complexity Audit

### Routine

- A button in `.pane-actions` (`terminals.js:6300`), alongside the controls already there.
- A `paste` event listener reading `event.clipboardData.getData('text/plain')`.
- `term.paste(text)` — a single documented xterm API call.

### Complex / Risky

- **Focus.** The textarea must take focus reliably enough for the OS callout to appear on
  iOS, then hand focus back to the terminal cleanly. `terminals.js:10137` already tracks a
  set of focus-stealing sources (sidebar click, pane-header button, sibling iframe, window
  blur) — a pane-header button that deliberately moves focus is walking straight into
  machinery that exists to prevent exactly that, and must be reconciled with it rather than
  fighting it.
- **iOS will not show a paste callout for an element it does not believe is editable.** An
  off-screen, zero-size, `opacity:0` or `readonly` textarea is a well-known way to get a
  focusable element that never offers Paste. The element has to be genuinely editable and
  genuinely on screen, which makes this a small visible UI rather than a hidden trick.
- **Wrong-terminal delivery is a known hazard in this codebase.**
  `feature_plan_20260626100852_clipboard_paste_wrong_terminal.md` exists because paste has
  landed in the wrong pane before. A control rendered per-pane must capture its pane
  identity at render time and not re-resolve it from focus at paste time — focus is the very
  thing being moved around.
- **Multi-line paste executes.** Newlines are carriage returns. Bracketed paste protects
  only in applications that both enable mode 2004 and reassemble across kernel reads; the
  bare login shell that `ptyBackend.ts` spawns (`['-l']`) does neither. The mitigation is
  that the content is on screen in the textarea before SEND — **not** a confirmation step,
  which `CLAUDE.md` forbids outright.
- **The Linux cause is unknown.** Everything above assumes the `paste` event fires once the
  operator's gesture reaches a real textarea. If the Linux failure is upstream of that, this
  design does not address it. Reproduce before building.

## Edge-Case & Dependency Audit

**Race conditions**
- Paste into a terminal that exits mid-gesture: the input queue is discarded on
  `untrackTerminalData`, so the write is dropped rather than landing on a dead pty. Confirm
  the UI reports this rather than showing a silent success.
- Two panes' paste controls open at once: only one textarea may hold focus. Opening a second
  must close the first, or the operator's gesture lands in a pane they are not looking at.
- Paste arriving while the pane is paused for output backpressure: input and output pausing
  are independent by design in the gateway. Assert this stays true — a lagging terminal that
  refuses paste would be a regression.

**Security**
- The control moves clipboard content into a shell, which is what the operator asked for.
  It does not read the clipboard without a gesture, does not persist the payload, and must
  not log it — clipboard contents are routinely credentials.
- No change to the bind policy, the Host guard, the WS upgrade guard, or the token model.
  Exposure-neutral.

**Side effects**
- One more control in `.pane-actions`, which is already dense. Whether it is always visible
  or only on touch/narrow viewports is a layout question worth settling during the work; an
  always-visible button is simpler and also serves the Linux desktop case, which is the
  larger population.
- Paste attribution begins firing for button-initiated pastes. This is correct and desired,
  but it means attribution volume changes — worth knowing before someone reads it as a bug.

**Migration**
- None. New control, no persisted state, no protocol change, no format change.

## Dependencies

- **None blocking.** `terminal-input-paste-path.md` is complete, so the transport this feeds
  is already chunked, paced and capped.
- **Sibling, sequencing matters:** the terminal clipboard key-handler plan (Ctrl+Shift+C /
  Ctrl+Shift+V). Land **this** plan first. That plan's copy half is independent, but its
  paste half has nowhere to get clipboard text in an insecure context — the correct
  behaviour there is for Ctrl+Shift+V to open *this* control rather than fail silently, and
  it can only do that if this control exists. Built in the other order, the key handler
  ships a shortcut that works on localhost and dies on the tailnet.
- **Related, not blocking:**
  `feature_plan_20260803163802_bracketed-paste-mode-replay-for-pty-terminals.md` (mode 2004
  survival across view rebuilds) — the button inherits whatever state that establishes.
- **Informs, does not block:** the touch-access documentation plan should describe this
  control once it lands.

## Adversarial Synthesis

The tempting mistake is a "best available path" implementation: try
`navigator.clipboard.readText()`, fall back to the textarea. That produces a control that
behaves differently on the developer's laptop than on the operator's tablet, fails
differently again in Firefox and behind a permission prompt the operator denied once six
months ago, and is tested almost exclusively on the path that was never broken. One path,
used everywhere, is both simpler and better tested — and it costs nothing, because the
textarea path works in the secure context too. The second mistake is a hidden textarea:
every hidden-input trick that works on desktop is precisely what stops iOS offering Paste,
so the thing that makes the feature work on the platform that needs it most is the thing a
desktop-first implementation will optimise away. The third is delivering via raw `ws.send`
because it is fewer lines — that silently drops bracketed-paste wrapping and paste
attribution, and both failures are invisible until someone pastes a multi-line block into a
root shell or asks why a dispatch was never attributed. Mitigations: one path only; a real,
visible, editable textarea; `term.paste()` as the sole delivery mechanism; and pane identity
captured at render time rather than resolved from focus.

## Proposed Changes

1. **Paste control in `.pane-actions`** (`terminals.js:6300`), rendered per pane with its
   pane identity captured at render time.
2. **A real, visible, editable `<textarea>`**, focused on activation, sized and placed so
   iOS offers its Paste callout. Dismissed on blur, on Escape, and after delivery.
3. **Delivery through `term.paste(text)`** on that pane's terminal — never a raw `ws.send`
   — so bracketed-paste wrapping and `onData` attribution both apply.
4. **SEND is explicit, and never a confirmation.** The pasted content is visible in the
   textarea and delivered on an explicit SEND tap. No `confirm()`, no "are you sure", no
   second click on the same decision — per `CLAUDE.md`, and because `window.confirm()` is a
   silent no-op in the extension host's webview. If the payload is multi-line, it is legible
   before it lands; that is the whole mitigation and it is sufficient.
5. **Focus restored to the terminal** after delivery, reconciled with the existing
   focus-stealing tracking at `terminals.js:10137` rather than bypassing it.
6. **Failure states.** Terminal gone, empty clipboard, and paste-event-never-fired are three
   distinct outcomes and must read differently. "Nothing happened" is the one unacceptable
   result, because it is indistinguishable from the bug this plan exists to fix.

### Migration

None.

## Verification Plan

1. **Linux, the reported case.** On the affected setup, paste a command with the button and
   confirm it reaches the shell — including over the tailnet URL, where Ctrl+Shift+V cannot
   help even once the sibling key-handler plan lands, because there is no Clipboard API to
   read from in an insecure context.
2. **iPad over the tailnet URL.** Tap Paste, long-press, confirm iOS offers **Paste**,
   confirm the text reaches the pty. This is the acceptance case; if the callout does not
   appear, the textarea is not genuinely editable and the implementation is wrong.
3. **Insecure context explicitly.** Run the whole flow over `http://100.x.y.z:port/` and
   confirm no code path touched `navigator.clipboard`. Assert this in a test, not by
   inspection — it is the assumption most likely to be quietly violated later.
4. **Bracketed paste is applied.** In an application with mode 2004 active, paste a
   multi-line block and confirm it arrives as one paste, not as executed lines. Then confirm
   the honest limitation in a bare `-l` shell, where it will not.
5. **Content integrity.** Paste a UTF-8 payload with multi-byte characters (CJK, emoji,
   combining marks) padded to straddle the 4096-byte chunk boundary, into
   `cat > /tmp/paste-btn-test`, and `diff` against the source. Zero differences. This
   re-runs the one manual check `terminal-input-paste-path.md` recorded as never having been
   run.
6. **Right pane, every time.** With four panes open, paste into each in turn, and again
   after clicking between panes mid-gesture. Text lands in the pane whose button was used,
   always.
7. **Attribution.** Paste a dispatch prompt and confirm `attributePastedPrompt` fires as it
   does for a typed paste — no second attribution path, no double attribution.
8. **No confirm gate exists.** Grep the added code for `confirm(`, `window.confirm`,
   `showWarningMessage` and any two-click pattern; assert none. Paste a multi-line payload
   and confirm it delivers on a single SEND with no interstitial prompt.
9. **Terminal exits mid-paste.** Confirm the UI reports the failure and nothing writes to a
   dead pty.
10. **Desktop unregressed.** Confirm Ctrl+V / Cmd+V still work exactly as before on a
    desktop browser — the button is additive and must not capture or interfere with the
    existing keyboard path.
11. **Both hosts, per `CLAUDE.md`.** The control must work in the VS Code extension webview
    **and** the standalone/browser host. `src/webview/terminals.js` is shared, so the risk is
    not the control itself but anything it depends on that is wired at only one composition
    root — diff `src/extension.ts` against `src/standalone/bootstrap.ts` by hand for the
    seams this touches rather than trusting a verb-reachability check, which comes back green
    regardless. Exercise the paste control in an installed VSIX and in `npx switchboard`.
12. **No secrets logged.** Grep the console and server logs after pasting a known sentinel
    string; it must appear nowhere.
