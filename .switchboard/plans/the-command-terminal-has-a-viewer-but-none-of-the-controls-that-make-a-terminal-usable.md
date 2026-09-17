# The command terminal has a viewer but none of the controls that make a terminal usable

## Goal

The terminal in the mobile command surface can be driven with one thumb: return
to the latest output after scrolling back, clear the agent's context, change its
model, and paste into it. Today it can do none of those, and one of them is
already built and silently broken rather than missing.

### Problem analysis

The command surface renders a real xterm through the shared viewport module
(`terminalViewport.js`), and the interactive terminal + key bar work landed. What
did not come with it is the pane chrome. Three separate causes, and they need
different fixes.

**1. Scroll-to-latest is built, reachable, and unstyled.**
`attachJumpToLatest` (`terminalViewport.js:1766`) creates the control:

```js
const btn = document.createElement('button');
btn.className = 'jump-to-latest';
btn.title = 'Scroll to the latest output';
btn.textContent = '↓ latest';
container.appendChild(btn);
```

It is called unconditionally from `materializeTerminalView` (`:1399`), which the
command surface reaches through `createTerminalView`. So **the button is in the
command view's DOM already**, wired to `term.scrollToBottom()` with a viewport
`scroll` listener that shows and hides it.

But `.jump-to-latest` is styled in **`terminals.css` only** — four rules — and
`command.html` does not load that stylesheet:

| surface | stylesheets |
|---|---|
| `terminals.html` | xterm.css, **terminals.css**, statusCards.css |
| `command.html` | xterm.css, statusCards.css |

So on `/command` the control renders as an unstyled, unpositioned default button
with no show/hide treatment — present in the tree, useless on screen. The shared
module was written to be embedder-independent; its **presentation was not**, and
nothing catches the half that did not come along.

On a touch surface this is the control that matters most: a stray swipe scrolls
the buffer back, output then appears frozen, and there is no way to return to the
bottom.

**2. Clear, model and paste are genuinely absent.** They are per-pane chrome
built in `terminals.js`, not in the shared viewport module, so the command
surface never had them. From `terminals.js`'s own control titles:

```
'Send /clear to this terminal'
'Send /model to this terminal'
'Paste text into this terminal'
'Open this terminal in its own window'
'Rename terminal'
'Close terminal (ends the process)'
```

`command.html`'s terminal viewer has `#btn-close-terminal`,
`#terminal-seat-switcher`, `#terminal-key-bar`, `#terminal-ws-status`,
`#terminal-xterm-host` and `#terminal-viewer-title`. No clear, no model, no
paste.

`/clear` and `/model` are the two commands an operator sends most while
supervising an agent, and both are awkward to type on a soft keyboard —
`/model` in particular opens a menu that needs arrow keys, which is the whole
reason the key bar exists.

**3. Paste is the worst of the three on this surface.** Measured:
`grep -c "pasteTarget|paste-target|clipboardFallback|readText"` returns **5** in
`terminals.js` and **0** in `command.js`. The board already carries a plan for
this class — `.switchboard/plans/terminal-pane-paste-button-for-contexts-where-the-clipboard-is-unreachable.md`
(Reviewed) — whose framing is that browser paste works only where the browser and
OS happen to cooperate, and on Linux and touch they do not. That work landed for
the terminals panel; the command surface was not covered by it.

The gap compounds with a defect already established elsewhere: a dispatch that
cannot reach a seat falls back to copying the prompt to the clipboard. On a
tablet that is already a dead end — and with no paste control in the terminal
viewer, there is no way to spend the clipboard even manually.

**Why this was not noticed.** Every one of these is invisible to the existing
tests. `mobile-command-route-contract.test.js` is the only suite that reads
`command.js`, and it asserts *absence* patterns — no polling, no board fetch. It
cannot observe a missing button, and it cannot observe a button that exists with
no CSS.

## Metadata

- **Tags:** frontend, ui, mobile, bugfix, ux
- **Complexity:** 4
- **Project:** Browser Switchboard

## User Review Required

**One item, and it does not block coding.** Whether the pane controls belong in a
persistent header above the terminal or behind a single overflow control is a
layout judgement on a surface where vertical space is the scarce resource. The
plan proceeds with a compact always-visible row under the stated assumption that
clear/model/paste are frequent enough to earn permanent space; if that is wrong
the change is which container they sit in, not whether they exist.

## Complexity Audit

### Routine

- Sending `/clear` and `/model` to a seat. The command surface already writes to
  the pty — `terminalViewport.encodeInputFrame` plus the entry's socket, the same
  path the key bar uses for control sequences.
- A paste control that reads the clipboard and writes the text to the seat. The
  key bar already synthesises input the soft keyboard cannot produce; paste is
  the same shape with a different source.

### Complex / Risky

- **The unstyled-button class of bug is the real finding, and fixing one instance
  does not fix the class.** `terminalViewport.js` is shared by `terminals.html`,
  `command.html` and `dock.html`; any DOM it creates needs styling in every
  embedder, and today nothing enforces that. Copying four rules into
  `command.html` closes this instance and leaves the next one to be discovered
  the same way.
- **`/clear` is not just text.** `terminals.js` routes clearing through a policy
  (`ptyClearPolicy.ts`) and a per-terminal send lock, and `clearBeforePrompt`
  interacts with dispatch. A naive "write `/clear\n` to the socket" from a second
  surface can race a dispatch that is mid-paste into the same seat.
- **Paste on iOS needs a real editable field.** `terminals.js` carries three
  comments to this effect — a visible, editable textarea is what makes iOS offer
  its paste callout; a synthetic `navigator.clipboard.readText()` is refused
  without a user gesture and silently returns nothing in some embedded webviews.
  The control must be built for that constraint, not against it.
- **Vertical space.** The surface is used in portrait on a 10" tablet and on
  phones. Controls added above the terminal come directly out of the rows of
  output an operator can see.

## Edge-Case & Dependency Audit

### Race Conditions

- A `/clear` sent from the command surface while a dispatch is mid-delivery into
  the same seat must not interleave. The existing per-terminal send lock is the
  precedent and must be honoured from this surface too, not re-implemented.

### Security

- Paste moves clipboard contents into an agent's stdin. That is the feature, but
  the control must not read the clipboard without an explicit user gesture, and
  must never log the pasted content.

### Side Effects

- Controls above the terminal reduce visible rows. On a phone this is the
  difference between seeing a menu and not.
- A working scroll-to-latest changes perceived behaviour: output that looked
  frozen will be revealed as "you were scrolled back", which is the point.

### Dependencies & Conflicts

- **`.switchboard/plans/terminal-pane-paste-button-for-contexts-where-the-clipboard-is-unreachable.md`**
  (Reviewed) established the paste affordance for the terminals panel. This plan
  extends the same affordance to the command surface and must reuse its approach
  rather than inventing a second one.
- **`.switchboard/plans/a-phone-keyboard-has-no-arrow-keys-so-no-menu-can-be-answered.md`**
  (Reviewed) delivered the key bar and the interactive viewer. The controls here
  sit beside it; `(pointer: coarse)` gating stays as it is.
- **`.switchboard/plans/the-command-surface-is-tuned-for-a-desktop-and-runs-on-a-2019-ipad.md`**
  (New) touches the same files for performance and wires `visualViewport`. Both
  edit `command.html`/`command.js` — sequence them, do not run concurrently.
- The terminals panel is **out of scope**: desktop-only by design, and it already
  has all four controls.

## Dependencies

No `sess_` session dependencies. File dependencies are the three plans above.

## Adversarial Synthesis

**Key risks:** (1) the jump button is "fixed" by copying four CSS rules into
`command.html`, leaving the shared-module-without-shared-styling class alive to
produce the next silent half-feature; (2) `/clear` is implemented as a raw socket
write and races a dispatch mid-paste into the same seat, corrupting a prompt;
(3) paste is built on `navigator.clipboard.readText()` and silently returns
nothing on the exact surface it was added for; (4) four controls are added to a
surface whose scarcest resource is vertical space, and the terminal becomes
unusable in portrait for the sake of buttons used once a session.
**Mitigations:** move the shared module's styling into the module's own
responsibility rather than each embedder's stylesheet; route clearing through the
existing policy and send lock; build paste on a real editable field per the
existing plan's findings; measure visible rows before and after on a phone and
the 10" iPad in portrait.

## Proposed Changes

### `terminalViewport.js` + `command.html` — the shared module must bring its own presentation

**Context.** `attachJumpToLatest` creates `.jump-to-latest` in every embedder;
only `terminals.css` styles it, and `command.html` does not load that file.

**Logic.** Make the module responsible for the appearance of the DOM it creates —
either by injecting its own scoped styles at init, or by shipping a stylesheet
every embedder loads alongside the script. Copying rules into `command.html` is
the cheap fix and leaves the class of bug in place; the module owning its own
presentation closes it.

**Edge cases.** `terminals.css` already styles `.jump-to-latest`; whichever
mechanism is chosen must not produce two competing definitions on the panel that
currently works.

### `command.html` + `command.js` — the three missing controls

**Context.** The viewer has close, seat switcher, key bar and status. It has no
clear, model or paste.

**Logic.** Add a compact control row to the terminal viewer:

- **Clear** — sends `/clear` through the existing clear policy and per-terminal
  send lock, not a raw socket write.
- **Model** — sends `/model`. The key bar already supplies the arrow keys the
  resulting menu needs, so this composes with work that has already landed.
- **Paste** — reads the clipboard on an explicit gesture and writes to the seat,
  built on a real editable field per the existing paste plan's iOS findings.

**Edge cases.** The row must not consume the space the terminal needs in
portrait; measure visible rows before and after. Controls act on the seat the
viewer currently shows — the seat switcher can change it underneath, so the
target must be read at press time, not captured at render.

### A contract that catches the next silent half-feature

**Context.** A shared module created a control that one embedder styles and the
other does not, and no test could see it. That is the same shape as the
capability-hidden controls found elsewhere on the board.

**Logic.** Assert that every class `terminalViewport.js` attaches to DOM it
creates has a style rule reachable from every page that loads the module. A
control present in the tree with no styling is a silent half-feature, and this is
the cheapest place to catch it.

**Edge cases.** Classes styled inline or by a framework need an exemption list
rather than silent tolerance, or the check decays into noise.

## Verification Plan

### Automated Tests

1. Every class `terminalViewport.js` creates is styled in every page that loads
   the module — `.jump-to-latest` on `/command` is the regression case.
2. The command surface's terminal viewer exposes clear, model and paste controls.
3. Clear routes through the existing clear policy and send lock, not a raw write.
4. Paste requires an explicit user gesture and does not log its content.
5. Each control targets the seat the viewer is showing at press time, after a
   seat switch.
6. `mobile-command-route-contract.test.js` continues to pass — no polling, no
   board fetch, no `setInterval`.

### Goal Invariants

- `command.html` renders `.jump-to-latest` with real positioning and a show/hide
  treatment — the button is currently in the DOM there and invisible, which is
  the defect.
- `src/webview/terminals.js` is untouched: the terminals panel is desktop-only
  and already has all four controls.
- No raw `/clear` socket write exists in `command.js`.

### Manual / UAT — on the 7th-gen iPad and a phone

1. Attach a terminal, scroll back, confirm the jump control appears and returns
   to the latest output.
2. Send `/clear` from the viewer; the agent's context clears and no dispatch in
   flight is corrupted.
3. Send `/model` and answer the resulting menu with the key bar.
4. Copy text outside the browser and paste it into the seat.
5. Count visible terminal rows in portrait before and after the control row is
   added.

## Outstanding Questions

- **[user]** Persistent control row, or a single overflow control that expands?
  Proceeding with the persistent row; the alternative costs one container change.

---

**Recommendation: Send to Lead Coder.** (Complexity 4.)
