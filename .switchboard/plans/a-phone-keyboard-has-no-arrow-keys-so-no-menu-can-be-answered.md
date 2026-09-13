# A Phone Cannot Answer a Terminal — the Command View Is Read-Only and No Surface Has Arrow Keys

## Goal

A phone can drive any CLI in the fleet: see the real screen, type into it, navigate a menu with
arrows, and interrupt a run. On every surface the board offers, not one of them.

### Why this is the last thing holding tmux up

tmux is kept for exactly one reason now: an SSH app is the only way to *interact* with an agent
from a phone. Those apps are usable because they render a real terminal and ship a key
accessory bar. The board does neither.

There are two separate defects, and the second is the one that was missed.

**1. The mobile command view is not a terminal.** It opens
`/ws/terminal?name=<seat>&solo=1`, decodes the output frames, strips the escapes, and appends
the result into `<pre id="terminal-stream-output">` with `textContent +=`
(`command.js:2167`, `command.html:1086`). `ws.send` appears **nowhere in the file** — there is
no input path of any kind. So it is a read-only log dump wearing a terminal's name: an agent's
composer and menus cannot render in a `<pre>` with escapes stripped, and nothing typed can ever
reach the seat.

**2. No surface has the keys a menu needs.** iOS and Android soft keyboards expose letters,
digits and punctuation and have **no arrow keys, no Esc, no Tab and no Ctrl.** Every agent CLI
uses arrows to move through a menu, Enter to choose, Esc to back out and Ctrl-C to interrupt.
Verified absent: no key bar and no synthesised control sequence anywhere in `terminals.js`,
`terminals.html` or `command.js` — nothing in the codebase sends a control sequence that was
not typed on hardware.

So even after the command view renders a real terminal, a phone still cannot answer a menu. Both
have to land for the surface to be usable, which is why they are one plan.

### On the "keyboard designed out" note

The mobile command surface was deliberately built as taps and dropdowns with text entry
designed out, and that decision is recorded. It is about **commanding the board** — dispatching,
moving cards, picking a seat — and it stands. It was never a decision that an operator may not
*talk to an agent* from a phone, and it must not be cited to keep the terminal viewer
read-only. The taps-and-dropdowns command surface and an interactive terminal viewer are
different things on the same screen.

### Non-goals

- **Text entry for the command surface's own controls.** Dispatch, card moves and seat selection
  stay taps and dropdowns. This plan touches the terminal viewer only.
- **A configurable or rebindable key bar.** One fixed key set, no picker.
- **A full virtual keyboard.** The soft keyboard already handles letters and digits; the bar adds
  only what it lacks.
- **Deciding the tmux default.** Removing the last reason to keep tmux is the outcome; the
  default is set in `attach-a-seat-from-any-terminal-client-without-tmux.md`.

## Metadata

- **Complexity:** 5
- **Tags:** webview, terminals, mobile, ux

## User Review Required

None.

## Proposed Changes

### 1. The command view renders a real terminal

Replace the `<pre>` stream box with the same terminal the panel uses —
`SwitchboardTerminalViewport` over xterm — so the escapes that are currently stripped are
interpreted, and the operator sees the agent's actual screen instead of a flattened transcript.

This also brings the replay, the answerback suppression and the resize frame with it, rather
than reimplementing a second, lesser terminal client in `command.js`. The `solo=1` socket
already carries exactly what the viewport expects.

### 2. The command view gains an input path

Keystrokes go out as `encodeInputFrame(data)` on the same socket, which is the one thing
`command.js` has never done. Without this the viewer stays read-only however well it renders.

### 3. A key bar, on both surfaces

One fixed row pinned below the focused terminal:

```
  ←   ↓   ↑   →   esc   tab   ctrl   ⏎
```

Shown when the viewport is narrow or the device reports coarse pointer input
(`matchMedia('(pointer: coarse)')`). A desktop already has these keys and the bar would be
clutter. Built once and used by both the terminals panel and the command view — two copies
would drift, and this is the surface where a drift is invisible until someone is on a train.

### 4. Arrows follow the cursor-key mode

```js
const app = term.modes.applicationCursorKeysMode;
const ARROW = { up: 'A', down: 'B', right: 'C', left: 'D' };
const seq = (app ? '\x1bO' : '\x1b[') + ARROW[dir];
```

Under DECCKM — which full-screen TUIs turn on — an arrow is `ESC O A`, not `ESC [ A`. Send the
wrong form and the bar looks correct and does nothing in exactly the menus it exists for, a
failure invisible on a desktop. xterm 5.5 exposes the live state (`xterm.d.ts:1869`). Read it at
press time, never cached: a CLI flips the mode whenever it opens or closes a full-screen view.

### 5. Ctrl as a sticky modifier

One tap arms it and the key highlights; the next key is sent as
`String.fromCharCode(code & 0x1f)`, then it disarms. Tapping an armed Ctrl disarms it silently.
Ctrl-C is the most important key on the bar — today there is no way to interrupt a run from a
phone at all.

### 6. A tap must not disturb focus or the keyboard

`preventDefault()` on `pointerdown`, and the buttons are never focus targets. A focusable button
dismisses the iOS soft keyboard, so the operator would lose the letter keys on every arrow
press — worse than nothing for a menu that mixes typing and navigation.

## Verification Plan

### Automated Tests

1. **New** `src/test/terminal-key-bar-contract.test.js`, wired as `test:contract:terminal-key-bar`
   **and invoked from `.github/workflows/integration-tests.yml`** — defined-but-not-invoked is
   not a gate. Asserts: each arrow emits `ESC [ X` with the mode off and `ESC O X` with it on;
   Ctrl+C emits `\x03`; the mode is read per press, not captured once; every key is delivered
   through `encodeInputFrame` rather than a paste.
2. Assert `command.js` sends on the terminal socket at all — the file currently contains zero
   `ws.send` calls, so this pins the input path against silently reverting to a read-only view.
3. Assert the command view's terminal renders through the shared viewport module, not a second
   hand-rolled client, and that no `textContent +=` stream box remains.
4. Assert the bar is absent on a fine-pointer wide viewport and present on a coarse-pointer
   narrow one.

### Goal Invariants

- On a real phone, in the command view: the agent's actual screen is visible, typing reaches it,
  a menu can be opened and moved through with the arrows and chosen with Enter. Verified by doing
  it against a live seat.
- Ctrl-C interrupts a running agent from the phone.
- Pressing an arrow does not dismiss the soft keyboard.
- The same is true in the terminals panel on a phone.
- A desktop session is visually unchanged on both surfaces.
