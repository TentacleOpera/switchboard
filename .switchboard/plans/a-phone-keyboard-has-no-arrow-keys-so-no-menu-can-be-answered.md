# A Phone Keyboard Has No Arrow Keys, So No Menu Can Be Answered

## Goal

A touch device can drive any CLI in the terminals panel — navigate a menu, answer a prompt,
interrupt a run — with no hardware keyboard attached.

### Why this is the last thing holding tmux up

tmux is kept for one reason now: the board's terminal panel cannot be *interacted* with from a
phone, so an SSH app is the only way in. Those apps are usable precisely because they ship a
key accessory bar — arrows, Esc, Tab, Ctrl — above the soft keyboard. The board ships nothing
equivalent.

iOS and Android soft keyboards expose letters, digits and punctuation. They have **no arrow
keys, no Esc, no Tab and no Ctrl.** Every agent CLI in the fleet uses arrows to move through a
menu, Enter to choose, Esc to back out and Ctrl-C to interrupt. So on a phone the panel renders
a terminal the operator can read and cannot answer — and a CLI waiting on a menu selection is
simply stuck until they reach a laptop.

Verified absent: no key bar, no synthesised control sequence, nothing mobile-specific anywhere
in `terminals.js` or `terminals.html`. Nothing in the codebase sends a control sequence that
was not typed on a real keyboard. The panel assumes hardware.

### Not the mobile command surface

This is the **terminals panel**, not the mobile command surface. That surface is deliberately
taps-and-dropdowns with the keyboard designed out, and nothing here proposes text entry for it.
The two are separate and must stay separate.

### The detail that decides whether this works at all

Arrow keys are not one sequence. Under DEC private mode 1 (DECCKM, "application cursor keys"),
which full-screen TUIs turn on, an arrow is `ESC O A`; otherwise it is `ESC [ A`. Send the
wrong form and the key bar looks correct and does nothing in exactly the menus it exists for —
which is the failure mode a naive implementation ships with and nobody catches on a desktop.

xterm.js 5.5 exposes the live state as `term.modes.applicationCursorKeysMode` (public typing,
`xterm.d.ts:1869`), so the correct form is a lookup, not a guess.

### Non-goals

- **A configurable or rebindable bar.** One fixed key set. A picker for which keys appear is
  the overengineering trap this repo keeps falling into.
- **A full virtual keyboard.** The soft keyboard already handles letters and digits; this adds
  only what it lacks.
- **Touching the mobile command surface.** See above.
- **A tmux replacement in this plan.** Removing the last reason to keep tmux is the *outcome*;
  the tmux default is decided in `attach-a-seat-from-any-terminal-client-without-tmux.md`.

## Metadata

- **Complexity:** 4
- **Tags:** webview, terminals, mobile, ux

## User Review Required

None.

## Proposed Changes

### 1. A key bar on touch and narrow viewports

A single row pinned to the bottom of the focused terminal pane, above the soft keyboard:

```
  ←   ↓   ↑   →   esc   tab   ctrl   ⏎
```

Eight keys, fixed. Shown when the viewport is narrow or the device reports coarse pointer
input (`matchMedia('(pointer: coarse)')`), hidden otherwise — a desktop already has these keys
and the bar would be clutter.

### 2. Arrows follow the cursor-key mode

```js
const app = entry.term.modes.applicationCursorKeysMode;
const ARROW = { up: 'A', down: 'B', right: 'C', left: 'D' };
const seq = (app ? '\x1bO' : '\x1b[') + ARROW[dir];
```

Read at press time, never cached: a CLI flips the mode when it opens and closes a full-screen
view, so a value captured at render is wrong by the time it is used.

### 3. Ctrl as a sticky modifier

One tap arms it and the key highlights; the next key is sent as `String.fromCharCode(code & 0x1f)`,
then it disarms. A second tap on an armed Ctrl disarms it without sending anything.

Ctrl-C is the most important key on the bar — it is the only way to interrupt a run from a
phone today, and there is currently none.

### 4. A tap must not disturb focus or the keyboard

`preventDefault()` on `pointerdown`, and the buttons are never focus targets. A button that
takes focus dismisses the soft keyboard on iOS, so the operator loses the letter keys every
time they press an arrow — which would make the bar worse than nothing for a menu that mixes
typing and navigation.

### 5. Delivery uses the ordinary input path

Every key goes out as `entry.ws.send(viewport.encodeInputFrame(seq))` — the same socket write a
keystroke takes. Not `term.paste()` (which frames as a bracketed paste and would make an arrow
arrive as literal text), and not `ptySendPrompt` (the dispatch path, which carries the family
delivery floor).

## Verification Plan

### Automated Tests

1. **New** `src/test/terminal-key-bar-contract.test.js`, wired as `test:contract:terminal-key-bar`
   **and invoked from `.github/workflows/integration-tests.yml`** — defined-but-not-invoked is
   not a gate. Asserts: each arrow emits `ESC [ X` with the mode off and `ESC O X` with it on;
   Ctrl+C emits `\x03`; the mode is read per press rather than captured once.
2. Assert the bar is absent on a fine-pointer wide viewport and present on a coarse-pointer
   narrow one, so a desktop never renders it.
3. Assert every key is delivered through `encodeInputFrame` — a test that would fail if someone
   routed it through `term.paste()` and turned arrows into literal text.

### Goal Invariants

- On a real phone, a CLI menu can be opened, moved through with the arrows and chosen with
  Enter. Verified by doing it against a live seat, not by reasoning about the sequences.
- Ctrl-C interrupts a running agent from the phone.
- Pressing an arrow does not dismiss the soft keyboard.
- A desktop session is visually unchanged.
