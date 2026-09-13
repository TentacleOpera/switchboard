# The Mobile Command View Cannot Answer a Terminal

## Goal

The mobile command view can drive any CLI in the fleet: see the real screen, type into it,
navigate a menu with arrows, and interrupt a run. It is the surface an operator reaches for on a
phone, and today it can do none of those things.

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
Verified absent: no key bar and no synthesised control sequence anywhere in `command.js` —
nothing on this surface sends a control sequence that was not typed on hardware.

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

- **The terminals panel.** That is the desktop surface and is not what an operator opens on a
  phone. If it ever wants the same key bar, that is its own plan — building for two surfaces here
  is how this plan drifts off the one that is actually broken.
- **Text entry for the command surface's own controls.** Dispatch, card moves and seat selection
  stay taps and dropdowns. This plan touches the terminal viewer only.
- **A configurable or rebindable key bar.** One fixed key set, no picker.
- **A full virtual keyboard.** The soft keyboard already handles letters and digits; the bar adds
  only what it lacks.
- **Deciding the tmux default.** Removing the last reason to keep tmux is the outcome; the
  default is set in `attach-a-seat-from-any-terminal-client-without-tmux.md`.

## Metadata

- **Complexity:** 6
- **Tags:** frontend, ui, ux, mobile, feature

## User Review Required

None.

## Complexity Audit

### Routine

- The key bar itself: one fixed row of buttons, `pointerdown` → `preventDefault`, send a
  control sequence. No state beyond the sticky-Ctrl flag.
- DECCKM-correct arrows: read `term.modes.applicationCursorKeysMode` at press time, emit
  `ESC O X` or `ESC [ X`. The API is confirmed at `xterm.d.ts:1869`.
- The input path: `encodeInputFrame(data)` on the existing `/ws/terminal` socket. The gateway
  already accepts the `0x01` binary input frame (`terminalWsGateway.ts:1380`); `command.js`
  simply never calls `ws.send`. Sending is the small part.
- The fleet-roster change (step 7): `liveFleet` is already fetched and cached by
  `fetchTeamsState` (`command.js:679`) via `/terminals/verb/ptyListTerminals`. The switcher is
  already correct; only the roster it is handed is team-scoped.

### Complex / Risky

- **Embedding `SwitchboardTerminalViewport` in the command view.** `create(deps)` requires ~20
  panel-side dependencies (`terminalsMap`, `fitLadderGen`, `workingSilenceShown`,
  `getFleetList`, `getPaneAssignments`, `getFocusedPaneIndex`, `isTerminalSeated`,
  `resyncPaneRenderer`, `startFitLadder`, `refreshInputState`, `notifyInputDropped`,
  `showPaneToast`, `clearCaretRing`, `focusPaneTerminal`, `clearWorkingSilence`,
  `bumpStartupCurtain`, `dismissStartupCurtain`, `showTerminalErrorToast`, `markReplayGap`,
  `cancelDetachTimer`), most called unconditionally. None exist in the command view. This is
  the bulk of the work and is addressed by the step-1 refactor below.
- **Body-dataset wiring.** `command.html` sets none of `body.dataset.ptyHostOrigin`,
  `body.dataset.terminalToken`, or `body.classList('is-solo')`, all of which the viewport
  reads to build the socket URL. The command view today hardcodes `location.host` and `&solo=1`
  inline; the viewport derives both from body state. These must be wired consistently on both
  hosts or the socket origin/auth diverges.
- **Parity seam.** The `ptyHostOrigin` / `terminalToken` wiring lands in the HTML template
  that serves `command.html`. Both hosts must inject the same datasets, or the command view's
  terminal connects to the wrong origin on one host and works on the other.

## Edge-Case & Dependency Audit

- **Race Conditions:** Seat switching already routes through `openTerminalViewer` →
  `closeActiveWs()` before opening the next socket (`command.js:2132`), so there is never a
  two-socket window. The viewport refactor must preserve this: the embedder mode must close
  the prior viewport's socket before constructing the next, not after.
- **Security:** `terminalToken` is the auth gate on the Go pty host's `/ws/terminal` upgrade
  (`LocalApiServer.ts:1322`). If the command view's template omits it, the socket either fails
  closed (good) or — if a fallback origin is used — silently connects unauthenticated (bad,
  and exactly the "fallback indistinguishable from a real value" failure the rules warn of).
  No fallback: if `terminalToken` is absent, fail the connection loudly, do not substitute
  `location.host`.
- **Side Effects:** `pointerdown` → `preventDefault` on key-bar buttons must keep the buttons
  non-focusable (`tabindex="-1"` or `el.focus()` never called) or the iOS soft keyboard
  dismisses on every arrow press — the plan's step 6 already nails this; preserve it.
- **Dependencies & Conflicts:** `@xterm/xterm@^5.5.0`, `@xterm/addon-fit@^0.10.0` are already
  in `package.json`. `terminalViewport.js` is already loaded by the terminals panel; loading
  it into `command.html` adds a second `<script>` consumer of the same module — the module is
  explicitly designed for this ("any embedder", header comment lines 4-6). No new dependency.

## Dependencies

- None identified.

## Adversarial Synthesis

Key risks: (1) the step-1 "drop in the shared viewport" framing hides a ~20-deps integration
cost that is the real work; (2) verification check #3 ("renders through the shared module")
can pass while replay/resize/answerback silently no-op under stubbed deps; (3) the
`ptyHostOrigin`/`terminalToken`/`is-solo` body-dataset wiring is absent from `command.html`
and must land on both hosts or the socket origin diverges. Mitigations: refactor
`SwitchboardTerminalViewport` to a lightweight embedder mode (panel deps optional with guards)
rather than stubbing panel concepts in `command.js`; tighten verification #3 to assert the
features *fire*, not merely that the module is imported; wire the three body datasets in the
`command.html` template on both hosts with no fallback for a missing `terminalToken`.

## Proposed Changes

### 1. The command view renders a real terminal

> **Superseded:** Replace the `<pre>` stream box with the same terminal the panel uses —
> `SwitchboardTerminalViewport` over xterm — so the escapes that are currently stripped are
> interpreted, and the operator sees the agent's actual screen instead of a flattened
> transcript. This also brings the replay, the answerback suppression and the resize frame
> with it, rather than reimplementing a second, lesser terminal client in `command.js`. The
> `solo=1` socket already carries exactly what the viewport expects.
>
> **Reason:** The socket *frame format* is compatible, but `SwitchboardTerminalViewport.create(deps)`
> requires ~20 panel-side dependencies (listed in the Complexity Audit), most called
> unconditionally, none of which exist in the command view. `command.html` loads only
> `sharedUtils.js` and `command.js` — no xterm, no addons, no `terminalViewport.js` — and sets
> none of the body datasets the viewport reads (`ptyHostOrigin`, `terminalToken`, `is-solo`
> class). "Drop in the shared viewport" is the bulk of the work, not a one-line swap, and
> stubbing 15 panel functions in `command.js` creates a second, divergent embedding contract
> that drifts the moment the panel changes one — the exact divergence the rules forbid.
>
> **Replaced with:** Refactor `SwitchboardTerminalViewport` (`src/webview/terminalViewport.js`)
> to expose a **lightweight embedder mode**: split a core (xterm + WebSocket +
> `encodeInputFrame` input + resize vote + replay) from panel-only concerns (fit ladder,
> startup curtain, pane-renderer resync, caret ring, working-silence), making the panel-only
> deps **optional with guards** (the module already guards `deps.getPaneAssignments ?` at
> line 1427 and `deps.isTerminalSeated ?` at 1789 — extend that pattern to the rest). The
> command view then embeds the core with a small *real* deps bag: `ptyHostOrigin`,
> `terminalToken`, a solo flag, and `terminalsMap` scoped to the one open terminal. One
> terminal client, two surfaces, no divergent stub contract. Then:
> - Load `xterm` CSS, `@xterm/xterm`, `@xterm/addon-fit`, and `terminalViewport.js` into
>   `command.html` (script/CSS tags alongside `sharedUtils.js`/`command.js`).
> - Wire `body.dataset.ptyHostOrigin`, `body.dataset.terminalToken`, and
>   `body.classList.add('is-solo')` in the `command.html` template **on both hosts**
>   (standalone `bootstrap.ts` and extension `LocalApiServer`/template path) so the viewport
>   builds the same socket URL the command view builds today. No fallback for a missing
>   `terminalToken` — fail the connection loudly.
> - Replace the `<pre id="terminal-stream-output">` (`command.html:1086`) and the
>   `textContent +=` append loop (`command.js:2164-2169`) with a viewport-mounted xterm
>   container. The escapes that are currently stripped are then interpreted, and the operator
>   sees the agent's actual screen. Replay, answerback suppression and the resize frame come
>   with the core, because the core owns them.

### 2. The command view gains an input path

Keystrokes go out as `encodeInputFrame(data)` on the same socket, which is the one thing
`command.js` has never done. Without this the viewer stays read-only however well it renders.

**Clarification (not a new requirement):** the gateway already accepts the `0x01` binary
input frame on `/ws/terminal` (`terminalWsGateway.ts:1380`), and both hosts proxy
`/ws/terminal` to the same Go pty host (`LocalApiServer.ts:1320-1339`). So the input path is
webview-only work and carries no host divergence risk — but the parity argument is stated
here because the rules make it a hard check, not an assumption.

### 3. A key bar in the command view

One fixed row pinned below the focused terminal:

```
  ←   ↓   ↑   →   esc   tab   ctrl   ⏎
```

Shown when the device reports coarse pointer input (`matchMedia('(pointer: coarse)')`) — a
desktop already has these keys and the bar would be clutter.

Built as its own module rather than inline, so a later plan can mount it elsewhere without a
second copy — but mounted in one place here.

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

### 7. Every live seat is reachable, not just team members

`openTerminalViewer` is entered only as `openTerminalViewer(team, …)`, and its seat list is
`[liveSeat, ...memberSeats]` (`command.js:1529`) — the head and members of one team. There is no
path from this surface to a seat that is not on a team, so a lone planner, a shared reviewer or
any standalone terminal cannot be opened from a phone at all.

The switcher itself is already right: one button per live seat, the active one highlighted,
re-entering the same function so the previous socket is closed before the next opens. What is
missing is the roster it is given. Feed it the live fleet — `ptyListTerminals` — grouped by team
with ungrouped seats in their own section, so the switcher can reach anything that exists rather
than only what shares a team with the seat already open.

A seat that cannot be opened is exactly as unusable as one that cannot be typed into, which is
why it belongs here rather than in its own plan.

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
   hand-rolled client, and that no `textContent +=` stream box remains. **Additionally assert the
   viewport's features actually fire in the command-view embedding** — a resize vote is sent on
   connect (`t:'resize'` frame with cols/rows ≥ 1), the replay tail is requested via `lastSeq`,
   and answerback suppression is armed — so a green "uses the shared module" check cannot hide a
   terminal that renders but neither resizes nor replays because panel deps were stubbed to no-ops.
4. Assert the bar is absent on a fine-pointer viewport and present on a coarse-pointer one.
5. Assert `command.html` loads `terminalViewport.js` and the xterm/addon-fit scripts, and that
   `body.dataset.ptyHostOrigin` and `body.dataset.terminalToken` are injected by **both** the
   standalone template path and the extension template path — pinning the parity seam.

### Goal Invariants

- On a real phone: the agent's actual screen is visible, typing reaches it,
  a menu can be opened and moved through with the arrows and chosen with Enter. Verified by doing
  it against a live seat.
- Ctrl-C interrupts a running agent from the phone.
- Pressing an arrow does not dismiss the soft keyboard.
- A standalone seat that belongs to no team can be opened and driven from the phone.
- Switching seats mid-session closes the previous socket and does not leave the viewer showing a
  stale screen.
- A desktop session is visually unchanged.

## Recommendation

Complexity 6 → **Send to Coder**. The key bar, input path, and fleet-roster change are
routine; the load-bearing work is the `SwitchboardTerminalViewport` embedder-mode refactor
(step 1), which touches the shared terminal module the panel also depends on — a coder can
land it, but the refactor should be reviewed against the panel's existing call sites to
confirm no panel dep became optional-and-broken in the split.
