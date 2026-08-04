# Restore Terminal Mouse / Alt-Screen Modes on Reattach in terminals.html

## Goal

Stop browser terminals in `terminals.html` from becoming unscrollable and unselectable after an agent CLI finishes working. Make the DEC private-mode state (mouse reporting, alt screen, focus reporting, bracketed paste) survive a pane reattach, and give the operator a way out when the pty app itself is the one that left the mode on.

### The symptom

Reported by the operator, running Claude Code in a pty pane:

- The terminal "gets stuck" after an agent finishes working — the mouse wheel no longer scrolls the viewport.
- Text selection gets stuck: with text selected, clicking elsewhere in the pane does not deselect. Pressing Escape does.
- Intermittent. Same terminal, same CLI, sometimes fine.

Keyboard input keeps working throughout, and output keeps arriving. This is not a hang, a dead socket, or a stalled renderer.

### Root cause — one flag, three symptoms

The pty app enables **mouse reporting** (`ESC[?1000h` + `ESC[?1006h`) and sometimes the **alternate screen buffer** (`ESC[?1049h`). While mouse reporting is active, xterm.js hands the mouse to the application and switches its own mouse features off. Verified in the vendored bundle (`src/webview/vendor/xterm/xterm.js`, `@xterm/xterm` 5.5):

- `VT200:{events:19,restrict:…}` — 19 is `DOWN|UP|WHEEL`. Mode 1000 therefore claims the **wheel**, so the wheel event is reported to the app and cancelled. **The viewport does not scroll.**
- `coreMouseService.areMouseEventsActive ? (this._selectionService.disable(), this.element.classList.add("enable-mouse-events")) : this._selectionService.enable()` — and `disable(){this.clearSelection(),this._enabled=!1}`. With the selection service disabled, a click can neither start **nor clear** a selection. Keyboard is untouched, which is exactly why Escape drops the highlight and a click cannot.
- `macOptionClickForcesSelection:!1` is the bundled default and `materializeTerminalView` (`src/webview/terminals.js:2469-2492`) does not override it, so on macOS there is no `shouldForceSelection` modifier escape hatch either. `shouldForceSelection(e){return d.isMac?e.altKey&&this._optionsService.rawOptions.macOptionClickForcesSelection:e.shiftKey}` — with the option false, the Mac branch is unreachable.
- Alt screen is an independent second no-scroll mechanism: `if(!this.buffer.hasScrollback){const t=this.viewport.getLines…}` in the wheel path converts wheel into cursor-key sequences when there is no scrollback, which is the alt buffer's permanent condition.

### Proof the modes are in play

Grepped straight out of the installed Claude Code binary (`/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe`, 2026-08-04). `?25l` (8 hits) is the control: it confirms literal escape strings are greppable in this binary.

| Sequence | Meaning | Set hits | Reset hits |
| :--- | :--- | :--- | :--- |
| `ESC[?1000h` / `ESC[?1000l` | VT200 mouse reporting — press, release, **wheel** | 1 | 1 |
| `ESC[?1006h` / `ESC[?1006l` | SGR extended mouse coordinates | 1 | 1 |
| `ESC[?1049h` / `ESC[?1049l` | alternate screen buffer | 3 | 3 |
| `ESC[?1004h` / `ESC[?1004l` | focus event reporting | 2 | 2 |
| `ESC[?1002h`, `ESC[?1003h` | drag / any-motion tracking | 0 | 0 |

So the app toggles these modes at runtime rather than setting them once at startup. Every toggle is a chance for the enable and its reset to end up on opposite sides of a boundary.

### Why it is intermittent — two desync paths

The mode lives in two places that can disagree: the xterm instance, and the app's belief about what it set. Nothing reconciles them.

1. **Lost reset (app-side, not fixable server-side).** The app is interrupted, killed, or crashes between `?1000h` and `?1000l`; or a pager/TUI the agent launched dies inside the alt screen. The mode stays on with nobody left to turn it off, because the app will not re-emit a reset for a mode it believes it already cleared.

2. **Reattach replays a mode without its reset (ours).** A rebuilt pane gets a **fresh** xterm — every DEC private mode at its default — plus a replay of the gateway's ring:
   - `flushOutput` records only bracketed paste: `scanBracketedPasteMode` (`src/standalone/terminalWsGateway.ts:483-515`) states it outright at line 493 — *"DECSET / DECRST — only 2004 is tracked; other modes are ignored"*.
   - The ring evicts whole chunks past `MAX_SCROLLBACK_BYTES` (256 KB, `terminalWsGateway.ts:5`, eviction at `:422-425`).
   - `setupClient` re-arms exactly one mode in the hello frame (`terminalWsGateway.ts:797-809`), and the client applies exactly that one (`src/webview/terminals.js:2814-2816`).

   So a replayed tail can carry `?1000h` / `?1049h` whose matching reset was already evicted, or carry neither while the app is mid-mouse-mode. Once out of sync, nothing re-syncs it: the app is not going to announce a mode it thinks is already settled.

   The triggering events are the ordinary ones that cluster around "an agent finished": switching away from the Terminals tab and back, a pane reassignment past `DETACH_GRACE_MS` (15 s, `src/webview/terminals.js:142`), a panel or shell reload, a socket reconnect after eviction.

The existing bracketed-paste mechanism is the shape of the fix — it was built for exactly this failure, for exactly one mode, and the comment at `terminals.js:2796-2802` describes this bug class in its own words. This plan generalises it and fixes an ordering flaw in it.

### The fix in one line

Track the whole tracked-mode set server-side, re-arm it **after** the replay has been parsed, and give the operator a visible release valve for the case no server-side tracking can cover.

## Metadata

- **Complexity:** 5
- **Tags:** bugfix, frontend, reliability, terminals

## Complexity Audit

### Routine

- Widening `bracketedPasteModes: Map<string, boolean>` to a per-terminal mode map and adding it to the two name-keyed collection lists that must stay in sync (`untrackTerminalData`, `rekeyTerminal`).
- Adding one field to the hello frame beside `replayChars` / `bracketedPaste`.
- One constructor option (`macOptionClickForcesSelection: true`).
- One `attachCustomWheelEventHandler` registration.

### Complex / Risky

- **Applying the mode set at the wrong point in the stream.** Written before the replay, a stale enable inside the replay overrides it and the bug survives; that is the flaw in today's bracketed-paste write. The authoritative write must land after the replay's parse, which means routing it through the replay write's callback.
- **Asserting a mode nobody ruled on.** Telling a client to enable mouse reporting on a guess creates this exact bug rather than fixing it. Per-mode "observed or omitted" semantics are load-bearing — the same rule the gateway already applies to `bracketedPaste` (`terminalWsGateway.ts:806-808`: *"Omitted, NOT false, when nothing has been observed: telling a client to DISABLE a mode nobody has ruled on is a regression, not a default"*).
- **Alt screen must be reset-only.** Writing `?1049h` into a fresh xterm switches it to an empty alt buffer and hides the scrollback that was just replayed — a blank pane, worse than the bug. `?1049l` is safe in both directions. The asymmetry is deliberate and must be commented, not "tidied".
- **Not corrupting the credit ledger.** Mode escapes are synthetic characters the server never billed, so they must go straight to the parser and never through `flushBatch` / `onWriteParsed` — the reason already documented at `terminals.js:2810-2813`.

### Explicitly NOT in scope

- Scrubbing or rewriting escape sequences inside the ring server-side. Same objection as the answerback plan: it moves parsing to a worse place and corrupts the `replayChars` accounting.
- Raising `MAX_SCROLLBACK_BYTES`. It makes the eviction window rarer, not the desync impossible, and costs memory per terminal in the fleet.
- Tracking modes xterm does not implement (1005 UTF-8 mouse, 1015 urxvt mouse — both answer DECRQM with "permanently reset" in the vendored bundle).
- Any change to backpressure, the ack ledger, the input path, or the detach/destroy lifecycle.
- Any change to VS Code's native terminals. They share no code with this stack.

## Edge-Case & Dependency Audit

### Race Conditions

| Case | Behaviour after the fix |
| :--- | :--- |
| Replay contains a mode change **newer** than the server's recorded state | Impossible. `scanBracketedPasteMode`'s successor scans the same bytes in `flushOutput` **before** the ring append (`terminalWsGateway.ts:412-414`), so the record is always at least as new as anything in the ring. |
| Replay contains a stale enable whose reset was evicted | The authoritative write lands after the replay's parse, so the recorded state wins. This is the reported bug. |
| No replay at all (`replayChars === 0`) | Nothing arms `awaitingReplayFrame`, so the mode write happens inline in the hello branch. |
| Socket dies after hello, before the replay frame | `entry.pendingModes` is assigned unconditionally on every hello and cleared in `connectTerminalSocket`, exactly like `ackSuppressChars` / `awaitingReplayFrame` (`terminals.js:2686-2690`). A half-armed write cannot leak into the next connection. |
| Replay armed but the frame never arrives | The first live binary frame takes the replay path once (pre-existing behaviour) and the modes are applied in its callback. Bounded, single-occurrence. |
| Mode changes while the operator is mid-selection | Unchanged from today: xterm's own `disable()` clears the selection on the transition. The fix does not add a transition; it removes spurious ones. |
| Two panes on one terminal (grid + solo pop-out) | The record is per terminal, the write is per entry. Both clients get the same authoritative state, which is correct — they share one pty. |
| Rename mid-session | `rekeyTerminal` moves the new map with the others (`terminalWsGateway.ts:589-597`); the client re-keys rather than destroying, so `pendingModes` is untouched. |

### Security

- No new endpoint, no new message type from client to server, no new authenticated surface. One extra field on an existing hello frame.
- The client writes only escapes assembled from a fixed allowlist of mode numbers and a boolean, never a server-supplied string. A hostile or corrupt `modes` payload can at worst toggle a mode the pty could already toggle itself.
- The mode write goes to the xterm parser, never to the pty, so it cannot inject input into a running CLI.

### Side Effects

- Bracketed paste is now applied **after** the replay instead of before. Strictly more correct for the same reason as the mouse modes, and it retires a latent instance of this bug for pastes.
- One extra `term.write` of at most ~40 bytes per attach. No measurable cost.
- The mouse-mode pill adds one `MutationObserver` per materialised terminal, attribute-filtered to `class` on `term.element`. Fires only on a real mode transition.
- `macOptionClickForcesSelection: true` changes Option-drag inside a mouse-mode app from "reported to the app" to "selects text". That is the iTerm/VS Code convention and is the point, but it is a behaviour change for anyone who was Option-dragging deliberately in a TUI.
- Shift-wheel stops reaching mouse-mode apps and scrolls the viewport instead. Also the conventional binding, and the only bypass that works while a legitimate mouse-mode app is running.

### Dependencies & Conflicts

- `@xterm/xterm ^5.5.0`. Three vendored-bundle facts are load-bearing and were verified, not assumed:
  - `attachCustomWheelEventHandler` is checked first in **both** wheel paths — `if(this._customWheelEventHandler&&!1===this._customWheelEventHandler(e))return!1` — so returning `false` skips xterm's mouse report *and* its `preventDefault`, leaving the browser's native viewport scroll intact.
  - `enable-mouse-events` is added to / removed from `term.element`'s class list on every mouse-protocol change, so it is a public DOM signal for "mouse reporting is active" with no private-API reach.
  - DECSET/DECRST generate no answerback, so the mode write cannot provoke a reply and does not interact with `suppressAnswerback`.
- `src/standalone/terminalWsGateway.ts` — builds on the answerback plan's `writeReplay` (`terminals.js:2927-2940`) and the hello → single-replay-frame ordering contract (`terminalWsGateway.ts:811-823`). Both already shipped.
- Legacy `t: 'out'` text framing (downgraded server) sends no `modes` field: nothing is armed, behaviour is today's. The `bracketedPaste` field is retained on the wire so an older webview against a newer server keeps working.
- Webview assets ship via `npm run compile` into `dist/webview/`. The running extension loads from `~/.<ide>/extensions/turnzero.switchboard-*/dist/`, **not** the dev repo's `dist/` — a build alone changes nothing on screen.

## Dependencies

- None upstream. Self-contained in `src/standalone/terminalWsGateway.ts` + `src/webview/terminals.js` (+ `terminals.html` for the pill's CSS), one new contract test, one `package.json` script, one CI step.

## Proposed Changes

### 1. `src/standalone/terminalWsGateway.ts` — track the mode set, not one mode

**Context.** Replace `bracketedPasteModes` (`:140-152`) and generalise `scanBracketedPasteMode` (`:483-515`). The regex, the carry (`modeScanCarry`, `:154`), the `MODE_SCAN_CARRY_MAX` bound and the RIS/DECSTR handling all survive unchanged — only what is recorded per match changes.

**Logic.** Same single pass, same "last state-changing event in document order wins". For each DECSET/DECRST, record every param that is in the tracked set instead of testing for `2004` alone. RIS / DECSTR set every tracked mode to `false`, matching what the client's own parser does on those bytes.

**Implementation.**

```ts
/**
 * DEC private modes whose state must survive a client reattach.
 *
 * A fresh xterm starts with every one of these at its default while the pty app's
 * belief persists, and an app never re-announces a mode it thinks is settled. The
 * ring cannot be relied on to carry the last transition: it evicts at
 * MAX_SCROLLBACK_BYTES, so an enable can outlive its own reset inside the replay.
 *
 *   1000/1002/1003  mouse reporting (VT200 / drag / any-motion). 1000 already
 *                   claims the WHEEL, so a stale enable makes the pane unscrollable
 *                   AND kills selection (xterm disables its SelectionService while
 *                   mouse events are active). This is the reported bug.
 *   1006            SGR mouse coordinates — meaningless alone, but it rides with
 *                   the above and a half-restored pair reports garbage coordinates.
 *   1004            focus reporting. Benign if wrong, cheap to carry, and losing it
 *                   makes a TUI think it never regained focus.
 *   2004            bracketed paste — the one mode already tracked here, and the
 *                   reason this mechanism exists.
 *   1049            alternate screen. Tracked, but RESET-ONLY on the client — see
 *                   applyServerModes in terminals.js.
 *
 * NOT tracked: 1005 and 1015. The vendored xterm answers DECRQM for both with
 * "permanently reset", i.e. it does not implement them, so a record would describe
 * a mode the client cannot enter.
 */
export const TRACKED_DEC_MODES = [1000, 1002, 1003, 1004, 1006, 1049, 2004] as const;

/** Terminal name -> (mode number -> last observed h/l). A mode ABSENT from the
 *  inner map has never been ruled on and must be omitted from hello, never sent
 *  as false. */
private decModes = new Map<string, Map<number, boolean>>();
```

```ts
    private scanTerminalModes(terminalName: string, data: string): void {
        const carry = this.modeScanCarry.get(terminalName) || '';
        const text = carry ? carry + data : data;

        const modeEvent = /\x1bc|\x1b\[!p|\x1b\[\?([0-9;]{0,64})([hl])/g;
        let match: RegExpExecArray | null;
        let consumedEnd = 0;
        let modes = this.decModes.get(terminalName);
        while ((match = modeEvent.exec(text)) !== null) {
            consumedEnd = match.index + match[0].length;
            if (!modes) {
                modes = new Map<number, boolean>();
                this.decModes.set(terminalName, modes);
            }
            if (match[2]) {
                // DECSET / DECRST. Params are compared WHOLE, so `12004` and `20040`
                // cannot false-positive, and a multi-param set like
                // `\x1b[?1049;1000;1006h` records all three.
                const on = match[2] === 'h';
                for (const param of match[1].split(';')) {
                    const mode = Number(param);
                    if (TRACKED_DEC_MODES.includes(mode as any)) {
                        modes.set(mode, on);
                    }
                }
            } else {
                // RIS or DECSTR. Both re-clone xterm's DEC private-mode defaults, in
                // which every tracked mode is false — so record false rather than
                // forgetting, which would omit the mode from hello and leave a stale
                // client-side enable standing.
                for (const mode of TRACKED_DEC_MODES) {
                    modes.set(mode, false);
                }
            }
        }

        const tail = text.slice(Math.max(consumedEnd, text.length - MODE_SCAN_CARRY_MAX));
        const escIdx = tail.lastIndexOf('\x1b');
        const fragment = escIdx === -1 ? '' : tail.slice(escIdx);
        this.modeScanCarry.set(terminalName, fragment.length <= MODE_SCAN_CARRY_MAX ? fragment : '');
    }
```

**Also.** Rename the call site in `flushOutput` (`:414`) — it must stay **before** the ring append, for the reason the existing comment gives at `:412-413`. Swap `bracketedPasteModes` for `decModes` in the two name-keyed collection lists: `untrackTerminalData` (`:516-534`, whose comment says to keep the list in sync) and `rekeyTerminal`'s `moveMap` calls (`:589-597`). Retain the trailing-fragment carry logic verbatim.

**Edge cases.** The inner map is created lazily on the first mode event, so a terminal that never emits one contributes no `modes` field and the client keeps xterm's defaults. `TRACKED_DEC_MODES.includes` on a 7-element array runs once per param, only inside a matched escape — no measurable cost on the event loop that owns the whole fleet.

### 2. `src/standalone/terminalWsGateway.ts` — carry the set in hello

**Context.** The hello frame at `:797-809`.

**Logic.** Add the map as a plain object. Keep `bracketedPaste` on the wire — derived from the same record — so an older webview against a newer server is unaffected. Both fields are omitted, never false, when nothing has been observed.

**Implementation.**

```ts
        const modes = this.decModes.get(terminal.name);
        const bracketedPaste = modes?.get(2004);
        this.safeSend(ws, {
            t: 'hello',
            name: terminal.name,
            role: terminal.role,
            cols: terminal.pty.cols || 80,
            rows: terminal.pty.rows || 24,
            seq: buffer ? buffer.nextSeq - 1 : 0,
            replayChars,
            // Omitted, NOT false, when nothing has been observed: telling a client to
            // DISABLE a mode nobody has ruled on is a regression, not a default. Same
            // rule per-mode inside `modes`, which only ever contains observed modes.
            ...(typeof bracketedPaste === 'boolean' ? { bracketedPaste } : {}),
            ...(modes && modes.size > 0 ? { modes: Object.fromEntries(modes) } : {}),
        });
```

**Edge cases.** `Object.fromEntries` on a `Map<number, boolean>` yields string keys (`{"1000":true}`), which is what JSON gives anyway; the client reads them with a numeric key coerced to string. Pinned by the contract test.

### 3. `src/webview/terminals.js` — apply the modes AFTER the replay

**Context.** The hello branch at `:2781-2816` (replacing the bracketed-paste write at `:2814-2816`), `writeReplay` (`:2927-2940`), the entry literal (`:2407-2436`), and the reset block in `connectTerminalSocket` (`:2686-2690`).

**Logic.** Two changes, and the second is the one that makes the fix work.

> **Superseded:** the bracketed-paste write's placement, and the comment justifying it — *"It lands ahead of the replay frame, which is correct — the replay is a suffix of history, so any 2004 escape inside it re-applies this same value."*
> **Reason:** that premise holds only while the ring still contains the last transition for the mode. The bug being fixed here is precisely the case where it does not: the ring evicted the reset, so the replay re-applies a **stale** enable on top of the authoritative value and wins. Writing before the replay is therefore correct only in the cases that were never broken.
> **Replaced with:** arm `entry.pendingModes` on hello and apply it in the replay write's callback (or inline when there is no replay). Ordering becomes: replay parse → authoritative mode state. Bracketed paste moves with the rest, which retires the same latent flaw for pastes.

**Implementation** — module-level helper, next to `ACK_CHUNK_CHARS` (`:2270`):

```js
    /**
     * DEC private modes the gateway reports, in application order.
     *
     * A fresh xterm has all of these at their defaults while the pty app's belief
     * persists, and the app never re-announces a settled mode — so without this the
     * pane can come back with mouse reporting on and nothing left to turn it off:
     * the wheel goes to the app instead of the viewport (mode 1000's event mask
     * includes WHEEL) and xterm disables its own SelectionService, so a click can
     * neither start nor clear a selection. That is the "stuck, can't scroll, can't
     * deselect" report.
     *
     * 1049 is NOT in this list — see the reset-only note in applyServerModes.
     */
    const REARMABLE_DEC_MODES = [1000, 1002, 1003, 1004, 1006, 2004];

    /**
     * Force the terminal's DEC private modes to the gateway's recorded state.
     *
     * Written DIRECTLY to the parser, not via the rAF-batched write queue: that path
     * is billed to pendingAckChars via onWriteParsed, and synthetic characters the
     * server never credited would corrupt the backpressure ledger. DECSET/DECRST
     * generate no answerback, so this cannot provoke a reply and needs no
     * suppression window.
     *
     * A mode the server never observed is absent from `modes` and is left at xterm's
     * default — asserting a mode nobody ruled on is how you CREATE this bug.
     */
    function applyServerModes(entry, modes) {
        if (!entry || entry.disposed || !entry.term || !modes) { return; }
        let seq = '';
        for (const mode of REARMABLE_DEC_MODES) {
            const on = modes[mode];
            if (typeof on !== 'boolean') { continue; }
            seq += `\x1b[?${mode}${on ? 'h' : 'l'}`;
        }
        // Alt screen is RESET-ONLY, deliberately asymmetric. Writing `?1049h` into a
        // freshly built xterm switches it to an EMPTY alt buffer and hides the
        // scrollback the replay just wrote — a blank pane, which is worse than the
        // bug. `?1049l` only ever returns to the normal buffer, which is safe in both
        // directions. Cost of the asymmetry: an app genuinely drawing in the alt
        // screen repaints into the normal buffer after a reattach, polluting
        // scrollback but leaving the pane usable. Do not "complete" this to a
        // symmetric write.
        if (modes[1049] === false) { seq += '\x1b[?1049l'; }
        if (!seq) { return; }
        try { entry.term.write(seq); } catch { /* term disposed between guard and write */ }
    }
```

**Implementation** — hello branch, replacing the `frame.bracketedPaste` write:

```js
                    // Applied AFTER the replay, not here: a stale enable inside the
                    // replayed ring would otherwise overwrite the authoritative state
                    // and the pane would come back stuck. Held on the entry and
                    // flushed by writeReplay's callback; applied inline below when
                    // there is no replay to wait for.
                    //
                    // `bracketedPaste` is the legacy single-mode field from a server
                    // that predates `modes`. Folded in rather than handled separately
                    // so there is one application path.
                    entry.pendingModes = frame.modes && typeof frame.modes === 'object'
                        ? frame.modes
                        : (typeof frame.bracketedPaste === 'boolean' ? { 2004: frame.bracketedPaste } : null);
                    if (!entry.awaitingReplayFrame) {
                        applyServerModes(entry, entry.pendingModes);
                        entry.pendingModes = null;
                    }
```

**Implementation** — `writeReplay`'s callback:

```js
            entry.term.write(text, () => {
                entry.suppressAnswerback = false;
                // The replay has been fully parsed and no live chunk has been parsed
                // yet (WriteBuffer._innerWrite fires each item's callback before
                // starting the next), so this is the exact boundary at which the
                // recorded mode state must overwrite whatever the replay left set.
                if (entry.pendingModes) {
                    applyServerModes(entry, entry.pendingModes);
                    entry.pendingModes = null;
                }
                onWriteParsed(entry, text.length);
            });
```

The throw path clears `entry.pendingModes` alongside `suppressAnswerback` — a mode set stranded on the entry would be applied by the *next* replay, i.e. against a stream it does not describe.

**Implementation** — entry literal and reconnect reset:

```js
            suppressAnswerback: false,
            awaitingReplayFrame: false,
            pendingModes: null
```

```js
        entry.suppressAnswerback = false;
        entry.awaitingReplayFrame = false;
        // Belongs to the socket that just went away. A set left armed by a socket that
        // died mid-replay describes a stream this connection will not receive.
        entry.pendingModes = null;
```

**Edge cases.** A legacy entry without the field reads `undefined`, which is falsy everywhere it is tested. If `term.dispose()` beats the replay callback the modes are simply never applied, and the entry is already out of `terminalsMap`.

### 4. `src/webview/terminals.js` — a visible release valve for mouse mode

**Context.** New helper beside `attachJumpToLatest` (`:2588-2665`), called from `materializeTerminalView` after `term.open(container)`; teardown in `destroyTerminalView` (`:2335-2388`) next to the jump-pill teardown.

**Logic.** Desync path 1 (an app that died holding the mode) is not reachable from the server — nothing observed a reset, because there was none. The operator needs a way out that does not involve killing the terminal. Follow the jump-to-latest precedent exactly: a pill shown **by state, not by hover**, so an operator who does not know it exists never has to hover for it. The state signal is public DOM — xterm adds `enable-mouse-events` to `term.element` on every mouse-protocol change — so no private API is touched.

The pill both explains the state ("this app is taking your mouse") and releases it. Releasing writes the resets to the **parser**, not the pty: the app keeps believing whatever it believes, and xterm stops handing it the mouse. That is the correct direction — the operator is overriding the app's claim on their pointer, not asking the app to give it up.

**Implementation.**

```js
    /**
     * A pill for a pane whose app has claimed the mouse.
     *
     * While mouse reporting is active xterm hands the wheel to the app (mode 1000's
     * event mask includes WHEEL) and disables its SelectionService, so the pane
     * cannot be scrolled and a click can neither start nor clear a selection. That is
     * correct behaviour for a TUI that wants clicks — and indistinguishable from an
     * app that died still holding the mode, which no amount of server-side tracking
     * can fix because there was never a reset to observe.
     *
     * `enable-mouse-events` is xterm's own class on term.element, added and removed on
     * every protocol change, so this reads a public signal rather than
     * _coreMouseService.
     */
    function attachMouseModeRelease(entry, term, container) {
        const btn = document.createElement('button');
        btn.className = 'mouse-mode-release';
        btn.type = 'button';
        btn.tabIndex = -1;   // the terminal owns the keyboard; this is a pointer control
        btn.title = 'This app is capturing the mouse — release it to scroll and select';
        btn.textContent = 'release mouse';
        container.appendChild(btn);

        const update = () => {
            if (entry.disposed || !term.element) { return; }
            btn.classList.toggle('visible', term.element.classList.contains('enable-mouse-events'));
        };

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            // To the PARSER, not the pty: the app keeps its own belief, xterm stops
            // acting on it. Every mouse protocol is reset, not just the active one —
            // the operator wants their pointer back, not a negotiation.
            try { term.write('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l'); } catch { /* disposed */ }
            update();
        });

        // Attribute-filtered: fires on a real protocol change, not on every render.
        const observer = new MutationObserver(update);
        if (term.element) {
            observer.observe(term.element, { attributes: true, attributeFilter: ['class'] });
        }
        entry.mouseModeObserver = observer;
        update();
    }
```

Teardown, beside the jump-pill's (`:2374-2383`) — a `MutationObserver` is not an xterm disposable and `term.dispose()` will not disconnect it:

```js
        if (entry.mouseModeObserver) {
            try { entry.mouseModeObserver.disconnect(); } catch { /* ignore */ }
            entry.mouseModeObserver = null;
        }
```

**Edge cases.** The pill sits in the same corner family as `jump-to-latest`, so the CSS must place them so they cannot overlap when both are visible (stack it above: `bottom: 40px`, same `right: 22px`). If `term.element` is missing the observer is skipped and the pill stays hidden — no throw. Clicking it while no app is capturing the mouse is a no-op write of four resets.

### 5. `src/webview/terminals.html` — pill CSS

**Context.** Beside `.jump-to-latest` (`:382-402`), which it mirrors.

**Implementation.**

```css
        /* Same family as .jump-to-latest — anchored to the view host so it is
           re-parented with the terminal on every renderPaneGrid() rebuild, shown by
           state rather than hover, stacked above the jump pill so both can be
           visible at once. Amber rather than teal: this one reports a condition the
           operator did not ask for. */
        .mouse-mode-release {
            position: absolute;
            right: 22px;
            bottom: 40px;
            display: none;
            align-items: center;
            gap: 4px;
            padding: 3px 9px;
            font-size: 11px;
            font-family: inherit;
            line-height: 1.4;
            color: var(--term-surface);
            background: var(--accent-warn, #e0a030);
            border: none;
            border-radius: 10px;
            cursor: pointer;
            z-index: 3;
            box-shadow: 0 1px 6px rgba(0, 0, 0, 0.45);
        }
        .mouse-mode-release.visible { display: inline-flex; }
        .mouse-mode-release:hover { filter: brightness(1.12); }
```

**Edge cases.** Confirm `--accent-warn` (or the panel's equivalent warning token) exists in this file's `:root` and in both theme blocks; if it does not, add it there rather than hardcoding a hex at the use site — the panel's palette is the single source of truth and `buildTerminalTheme()` reads it.

### 6. `src/webview/terminals.js` — two standing bypasses

**Context.** The `Terminal` constructor (`:2469-2492`) and a registration next to `attachRenderer` in `materializeTerminalView`.

**Logic.** Both restore a habit the operator already has from iTerm and VS Code, and both work *while* a legitimate mouse-mode app is running — which the pill in item 4 deliberately does not (it takes the mouse away from the app).

**Implementation** — constructor option:

```js
            // Option-drag selects even while an app is capturing the mouse. xterm's
            // shouldForceSelection() has a Mac branch gated entirely on this option,
            // and the bundled default is FALSE — so without it there is no modifier
            // that can select text in a mouse-reporting app on macOS, which is the
            // platform this panel runs on. Matches iTerm and VS Code.
            macOptionClickForcesSelection: true,
```

**Implementation** — wheel bypass:

```js
        // Shift-wheel always scrolls the viewport, even while an app is capturing the
        // wheel (mode 1000's event mask includes WHEEL, so a plain wheel is reported
        // to the app and cancelled). Returning false makes xterm skip its own wheel
        // handling entirely — no mouse report AND no preventDefault — so the
        // browser's native scroll on .xterm-viewport proceeds. Verified against both
        // wheel paths in the vendored bundle, each of which checks
        // _customWheelEventHandler first.
        if (typeof term.attachCustomWheelEventHandler === 'function') {
            term.attachCustomWheelEventHandler((ev) => !ev.shiftKey);
        }
```

**Edge cases.** Returning `true` for the unmodified case preserves today's behaviour exactly, including alt-buffer wheel-to-arrow-keys. Guarded on the method existing so a downgraded vendor bundle does not throw at materialise time.

### 7. `src/test/terminal-dec-mode-restore-contract.test.js` — new source-text contract

**Context.** Same style and `block()` helper as `src/test/terminal-answerback-replay-contract.test.js`. These are behaviours that fail silently and are invisible to any headless run, so they get pinned structurally.

**Logic.** Pin the four things whose reversal would silently un-fix the bug:

1. The gateway records **all** tracked modes, not just 2004, and scans before the ring append.
2. Hello omits `modes` when nothing has been observed (the "omitted, NOT false" rule).
3. The client applies the set **after** the replay — assert `applyServerModes` is called from `writeReplay`'s callback and that the hello branch only applies inline when `!entry.awaitingReplayFrame`.
4. `1049` is absent from `REARMABLE_DEC_MODES` and appears only under an `=== false` test — the blank-pane guard.

Plus: `pendingModes` is reset in `connectTerminalSocket`, the `MutationObserver` is disconnected in `destroyTerminalView`, `macOptionClickForcesSelection: true` is in the constructor, and the wheel handler returns `!ev.shiftKey`.

**Implementation.** Follows the sibling file structure verbatim: `test()` helper, `block(code, startMarker, endMarker)`, `console.log` of the tally, and — matching all sibling terminal contracts — `if (failed > 0) { process.exit(1); }` as the last line, with **no** explicit success exit.

**Edge cases.** The `block()` slices depend on `applyServerModes` being declared between `ACK_CHUNK_CHARS` and `isAnswerback`, and on `attachMouseModeRelease` being declared adjacent to `attachJumpToLatest`. A move breaks the test loudly with a "marker not found" message, which is the intended behaviour rather than a silent pass.

### 8. `package.json` + `.github/workflows/integration-tests.yml` — wire it

**Context.** Script beside the other eleven `test:contract:terminal-*` entries (`package.json:814-856`); CI step beside them in the workflow (`:282-345`).

**Logic.** A contract defined but never invoked is the exact "green while incomplete" hole the answerback review pass found — the script existed in `package.json` with no workflow step. Both land in the same change.

**Implementation.**

```json
    "test:contract:terminal-dec-mode-restore": "node --require ./src/test/bootstrap/sandboxStateHome.js src/test/terminal-dec-mode-restore-contract.test.js",
```

```yaml
      - name: Terminal DEC mode restore contract
        run: npm run test:contract:terminal-dec-mode-restore
```

## Verification Plan

### Automated Tests

1. `npm run test:contract:terminal-dec-mode-restore` — all cases green.
2. `npm run test:contract:terminal-answerback` — must stay green. Item 3 edits `writeReplay`, which that contract slices and asserts on.
3. `npm run test:contract:terminal-flow-control`, `:terminal-input-path`, `:terminal-rename-rekey`, `:terminal-solo-popout` — must stay green. The ledger, the input path, the re-key collection list and the pop-out path are all adjacent.
4. `npm run compile` — clean build; `dist/webview/terminals.js`, `dist/webview/terminals.html` and the gateway bundle regenerated.
5. `node --check src/webview/terminals.js`.

### Deploy prerequisite (not a verification step)

Every manual check runs in a real browser terminal, so the change has to be live: build, sync to the installed extension folder, reload the window. The running extension loads from `~/.<ide>/extensions/turnzero.switchboard-*/dist/`, not the dev repo's `dist/`.

### Manual — reproduce first

Reproduce on the current build, so the fix is measured against an observed failure.

6. Open `terminals.html`, run Claude Code in a pane, and give it a task long enough to produce well over 256 KB of output.
7. While it works, confirm the stuck state when it appears: in the panel devtools console, `document.querySelectorAll('.xterm').forEach(e => console.log(e.className))` — `enable-mouse-events` present is the cause. Confirm the wheel does not scroll and a click does not clear a selection, while keystrokes still land.
8. Force the reattach path deterministically: swap the terminal out of its pane, wait past the 15-second detach grace, swap it back — with enough output since to have evicted the ring. Check the class again.

### Manual — confirm the fix

9. Repeat step 8 with the fix live. The class must match the app's actual state, and the wheel and click must behave accordingly.
10. Reattach while the app is *legitimately* in mouse mode: the class stays, the pill is visible, and Shift-wheel scrolls while a plain wheel still reaches the app.
11. Click the pill: the wheel and click come back immediately, the pill hides, and the app keeps running (no keystroke was sent to it).
12. Option-drag inside a mouse-mode app selects text.
13. Full panel reload (fresh view, full-ring replay) and a solo pop-out window: both end in the correct mode state.
14. Bracketed paste still survives a reattach — paste a multi-line block into a fresh view and confirm it arrives as one submission, not one per line. This is the mode whose application point moved, so it is the regression risk of item 3.
15. Alt screen: run a full-screen TUI (`htop`, or `git log` in its pager), reattach mid-run, and confirm the pane is usable and not blank. Then quit the TUI and confirm scrollback scrolls again.
16. Eviction/reconnect path: drive a terminal hard enough to trip backpressure eviction, let it auto-reconnect, and confirm no duplicated block, no gap, and correct mode state — this exercises the tail-replay window (`entry.lastSeq > 0`).

---

**Recommendation: Send to Coder** (Complexity 5 — two files plus CSS, one new contract, one CI step; the risk is concentrated in the apply-after-replay ordering and the deliberate 1049 asymmetry, both pinned by tests).
