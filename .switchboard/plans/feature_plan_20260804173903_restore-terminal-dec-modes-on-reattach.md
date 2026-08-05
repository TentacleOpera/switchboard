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
- `macOptionClickForcesSelection:!1` is the bundled default and `materializeTerminalView` (`src/webview/terminals.js:2493-2520`) does not override it, so on macOS there is no `shouldForceSelection` modifier escape hatch either. `shouldForceSelection(e){return d.isMac?e.altKey&&this._optionsService.rawOptions.macOptionClickForcesSelection:e.shiftKey}` — with the option false, the Mac branch is unreachable.
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

> **Re-verified 2026-08-04 (improve pass).** Every row above was re-grepped against the same binary and matches exactly, including the `?25l` control at 8 hits. The grep proves the *strings* are present; it does not prove which code path inside the binary emits them (Claude Code itself vs. a bundled sub-tool or pager). That distinction does not change the fix — the modes reach the pty either way.

### Why it is intermittent — two desync paths

The mode lives in two places that can disagree: the xterm instance, and the app's belief about what it set. Nothing reconciles them.

1. **Lost reset (app-side, not fixable server-side).** The app is interrupted, killed, or crashes between `?1000h` and `?1000l`; or a pager/TUI the agent launched dies inside the alt screen. The mode stays on with nobody left to turn it off, because the app will not re-emit a reset for a mode it believes it already cleared.

2. **Reattach replays a mode without its reset (ours).** A rebuilt pane gets a **fresh** xterm — every DEC private mode at its default — plus a replay of the gateway's ring:
   - `flushOutput` records only bracketed paste: `scanBracketedPasteMode` (`src/standalone/terminalWsGateway.ts:483-514`) states it outright at line 493 — *"DECSET / DECRST — only 2004 is tracked; other modes are ignored"*.
   - The ring evicts whole chunks past `MAX_SCROLLBACK_BYTES` (256 KB, `terminalWsGateway.ts:5`, eviction at `:420-424`).
   - `setupClient` re-arms exactly one mode in the hello frame (`terminalWsGateway.ts:797-809`), and the client applies exactly that one (`src/webview/terminals.js:2846-2848`).

   So a replayed tail can carry `?1000h` / `?1049h` whose matching reset was already evicted, or carry neither while the app is mid-mouse-mode. Once out of sync, nothing re-syncs it: the app is not going to announce a mode it thinks is already settled.

   The triggering events are the ordinary ones that cluster around "an agent finished": switching away from the Terminals tab and back, a pane reassignment past `DETACH_GRACE_MS` (15 s, `src/webview/terminals.js:142`), a panel or shell reload, a socket reconnect after eviction.

The existing bracketed-paste mechanism is the shape of the fix — it was built for exactly this failure, for exactly one mode, and the comment at `terminals.js:2827-2833` describes this bug class in its own words. This plan generalises it and fixes an ordering flaw in it.

### The fix in one line

Track the whole tracked-mode set server-side, re-arm it **after** the replay has been parsed, and give the operator a visible release valve for the case no server-side tracking can cover.

## Metadata

- **Project:** Browser Switchboard
- **Complexity:** 6
- **Tags:** bugfix, frontend, reliability, ui, test

> **Superseded:** **Complexity:** 5 · **Tags:** bugfix, frontend, reliability, terminals
> **Reason:** Two things the original score did not price in, both found by reading source rather than by re-reading the plan. (a) The server-side rename `bracketedPasteModes` → `decModes` breaks a *shipped, CI-wired* contract file the plan never mentions — `src/test/terminal-input-path-contract.test.js` hard-codes the old identifiers in nine places **and executes the scanner body through `new Function`**, so this is a genuine cross-file coordination cost, not a rename. (b) The `?1049l` write is not inert (see item 3): xterm's reset path calls `restoreCursor()` outside the "was actually alt" guard, so the plan as written corrupts the pane it just replayed. `terminals` is also not in the allowed tag vocabulary.
> **Replaced with:** Complexity 6 — still "mixed" (majority routine, extending an existing mechanism), but with three well-scoped risks rather than one: the apply-after-replay ordering, the 1049 write gate, and the contract-test retarget. Tags corrected to the allowed list, `ui` and `test` added for the pill and the two contract files.

## User Review Required

Three decisions the operator should confirm before a coder starts. None blocks reading the plan; all three change what ships.

1. **Split or ship whole?** This plan carries three independently-shippable deliverables (see *Scope — split recommendation* below). The reattach fix (items 1–3, 7–9) is the titled goal and stands alone. The release-valve pill (items 4–5) and the two standing bypasses (item 6) each fix **desync path 1**, which the plan itself states is *"not fixable server-side"* — different root cause, different failure, shippable separately. Recommendation: ship as **two plans** (Phase 1 = reattach fix, Phase 2 = operator affordances), and group them into a feature. The plan is written so either choice works.
2. **`macOptionClickForcesSelection: true` is a behaviour change** for anyone deliberately Option-dragging inside a TUI: that gesture stops reaching the app and starts selecting text. It matches iTerm and VS Code, which is the argument for it, but it is not a pure bug fix.
3. **Amber pill in a teal/claudify panel.** Item 5 introduces the panel's first non-brand status colour on a terminal pane. Confirm an amber pill floating over terminal output is wanted rather than, say, a pane-header chip.

## Scope — split recommendation

Per the plan-sizing rule, this trips **both** auto-split signals:

- **3+ distinct deliverables:** (a) server-side mode tracking + apply-after-replay (items 1–3), (b) operator release-valve pill + CSS (items 4–5), (c) standing input bypasses (item 6). (b) and (c) share no code with (a) and address a *different* root cause.
- **2+ independently-shippable phases:** (a) is complete and testable on its own; (b)+(c) are complete and testable on their own.

This workflow is single-plan and non-destructive, so it cannot split retroactively — the recommendation is the action. If the split is taken: Phase 1 (items 1–3, 7–9) scores **6**; Phase 2 (items 4–6, plus its own contract assertions) scores **3**. Group the two via `create-feature-from-plans`.

## Complexity Audit

### Routine

- Widening `bracketedPasteModes: Map<string, boolean>` to a per-terminal mode map and adding it to the **three** name-keyed collection lists that must stay in sync (`untrackTerminalData`, `rekeyTerminal`, `dispose`).
- Adding one field to the hello frame beside `replayChars` / `bracketedPaste`.
- One constructor option (`macOptionClickForcesSelection: true`).
- One `attachCustomWheelEventHandler` registration.
- One new CSS token + one new rule block in `terminals.html`.

> **Superseded:** "the two name-keyed collection lists that must stay in sync (`untrackTerminalData`, `rekeyTerminal`)."
> **Reason:** There are three, not two. `dispose()` (`terminalWsGateway.ts:1015`) also clears `bracketedPasteModes`, and `terminal-input-path-contract.test.js:302` asserts it does. Missing it leaks the whole mode map on gateway teardown and fails a shipped contract.
> **Replaced with:** three lists — `untrackTerminalData` (`:516-534`), `rekeyTerminal` (`:589-597`), `dispose` (`:1000-1019`).

### Complex / Risky

- **Applying the mode set at the wrong point in the stream.** Written before the replay, a stale enable inside the replay overrides it and the bug survives; that is the flaw in today's bracketed-paste write. The authoritative write must land after the replay's parse, which means routing it through the replay write's callback.
- **Asserting a mode nobody ruled on.** Telling a client to enable mouse reporting on a guess creates this exact bug rather than fixing it. Per-mode "observed or omitted" semantics are load-bearing — the same rule the gateway already applies to `bracketedPaste` (`terminalWsGateway.ts:805-808`: *"Omitted, NOT false, when nothing has been observed: telling a client to DISABLE a mode nobody has ruled on is a regression, not a default"*).
- **Alt screen must be reset-only AND buffer-gated.** Writing `?1049h` into a fresh xterm switches it to an empty alt buffer and hides the scrollback that was just replayed — a blank pane, worse than the bug. **`?1049l` is *not* safe unconditionally either** — see the superseded callout in item 3. The asymmetry and the gate are both deliberate and must be commented, not "tidied".
- **Not corrupting the credit ledger.** Mode escapes are synthetic characters the server never billed, so they must go straight to the parser and never through `flushBatch` / `onWriteParsed` — the reason already documented at `terminals.js:2841-2845`.
- **Three mode lists that must not drift.** The gateway's `TRACKED_DEC_MODES`, the client's `REARMABLE_DEC_MODES`, and the pill's release write each enumerate mouse modes independently. A mode present in the pill's *visibility* signal but absent from its *release* write is a dead button (PRD contract #6) — which is exactly what mode 9 was in the draft. Pinned by a parity assertion, not three greps (item 7, assertion 7).
- **Renaming the gateway's mode map breaks a shipped, CI-wired contract.** `src/test/terminal-input-path-contract.test.js` is not merely adjacent — it *executes* the scanner body extracted by exact-string signature match, and reads its results out of a mock whose field is literally named `bracketedPasteModes`. Nine assertions plus the harness must be retargeted **in the same change** (item 9). The plan previously claimed this test "must stay green" without edits, which is false.

### Explicitly NOT in scope

- Scrubbing or rewriting escape sequences inside the ring server-side. Same objection as the answerback plan: it moves parsing to a worse place and corrupts the `replayChars` accounting.
- Raising `MAX_SCROLLBACK_BYTES`. It makes the eviction window rarer, not the desync impossible, and costs memory per terminal in the fleet.
- Tracking modes xterm does not implement (1005 UTF-8 mouse, 1015 urxvt mouse — both answer DECRQM with "permanently reset" in the vendored bundle: `1005===u?4:1006===u?_("SGR"===r):1015===u?4:`, where `4` is DECRPM *permanently reset*, and both DECSET and DECRST for them log `"DECSET 1005 not supported (see #2507)"` and change nothing).
- Any change to backpressure, the ack ledger, the input path, or the detach/destroy lifecycle.
- Any change to VS Code's native terminals. They share no code with this stack.
- **Any change to the `1049` *set* direction.** The gateway records it; the client never writes `?1049h`. Not a TODO — a permanent constraint.

## Edge-Case & Dependency Audit

### Race Conditions

| Case | Behaviour after the fix |
| :--- | :--- |
| Replay contains a mode change **newer** than the server's recorded state | Impossible. The scanner runs in `flushOutput` **before** the ring append (`terminalWsGateway.ts:412-414`, ring push at `:420`), so the record is always at least as new as anything in the ring. |
| Replay contains a stale enable whose reset was evicted | The authoritative write lands after the replay's parse, so the recorded state wins. This is the reported bug. |
| No replay at all (`replayChars === 0`) | Nothing arms `awaitingReplayFrame`, so the mode write happens inline in the hello branch. |
| Socket dies after hello, before the replay frame | `entry.pendingModes` is assigned unconditionally on every hello and cleared in `connectTerminalSocket`, exactly like `ackSuppressChars` / `awaitingReplayFrame` (`terminals.js:2721-2728`). A half-armed write cannot leak into the next connection. |
| Replay armed but the frame never arrives | The first live binary frame takes the replay path once (pre-existing behaviour) and the modes are applied in its callback. Bounded, single-occurrence. |
| Hello arrives while `entry.term` is null | Currently unreachable — all three `connectTerminalSocket` call sites (`:2176`, `:2610`, `:2888`) are gated on `entry.term`. Made explicitly safe anyway: `applyServerModes` reports whether it wrote, and `pendingModes` is only cleared on a real write, so a term that materialises later is not silently skipped. |
| Mode changes while the operator is mid-selection | Unchanged from today: xterm's own `disable()` clears the selection on the transition. The fix does not add a transition; it removes spurious ones. |
| Two panes on one terminal (grid + solo pop-out) | The record is per terminal, the write is per entry. Both clients get the same authoritative state, which is correct — they share one pty. |
| Rename mid-session | `rekeyTerminal` moves the new map with the others (`terminalWsGateway.ts:589-597`); the client re-keys rather than destroying, so `pendingModes` is untouched. |
| Server recorded `1049:false` while xterm is already in the normal buffer | The write is **skipped** (buffer-gated, item 3). Unguarded it would call xterm's `restoreCursor()` and teleport the cursor to viewport row 0 on top of the replayed scrollback. |
| `RIS` / `DECSTR` in the stream sets every tracked mode to `false`, including 1049 | Correct record, and now harmless on the client because the 1049 write is buffer-gated. Before the gate this made the corruption *more* likely, not less: any `\x1bc` anywhere in the session armed a `?1049l` on every later reattach. |

### Security

- No new endpoint, no new message type from client to server, no new authenticated surface. One extra field on an existing hello frame.
- The client writes only escapes assembled from a fixed allowlist of mode numbers and a boolean, never a server-supplied string. A hostile or corrupt `modes` payload can at worst toggle a mode the pty could already toggle itself.
- The mode write goes to the xterm parser, never to the pty, so it cannot inject input into a running CLI.
- Numeric keys from `Object.fromEntries` arrive as JSON strings and are read back through the fixed `REARMABLE_DEC_MODES` allowlist, never enumerated — so an injected key like `"1000; rm -rf"` is simply never looked up.

### Side Effects

- Bracketed paste is now applied **after** the replay instead of before. Strictly more correct for the same reason as the mouse modes, and it retires a latent instance of this bug for pastes.
- One extra `term.write` of at most ~40 bytes per attach. No measurable cost.
- The mouse-mode pill adds one `MutationObserver` per materialised terminal, attribute-filtered to `class` on `term.element`. Fires only on a real mode transition. This is the first `MutationObserver` in `terminals.js` (the file otherwise uses `ResizeObserver`), so the teardown precedent has to be established rather than copied.
- `macOptionClickForcesSelection: true` changes Option-drag inside a mouse-mode app from "reported to the app" to "selects text". That is the iTerm/VS Code convention and is the point, but it is a behaviour change for anyone who was Option-dragging deliberately in a TUI.
- **`macOptionClickForcesSelection: true` also disables Option-click-to-move-cursor on macOS.** `altClickMovesCursor`'s bundled default is `!0` (**true**, verified in the bundle) and `terminals.js` does not override it, so Option-click currently emits arrow-key sequences to reposition the shell prompt at the clicked cell. Forced selection takes precedence, so that gesture is lost. Not mentioned in the original draft and not obvious from the one-line option change. It is the same trade iTerm2 and VS Code make by default, and the Option-click-to-move-cursor gesture is far less discoverable than "I cannot select text", so the trade is worth taking — but it is a second behaviour change riding on one option, and item 2 of *User Review Required* covers it.
- `macOptionIsMeta` is **not** touched. Confirmed that `macOptionClickForcesSelection` governs mouse events only and does not alter how Option-modified *keystrokes* reach the app, so no meta-prefix behaviour changes. (Relevant because `macOptionIsMeta: true` is known to break `@`, `|`, `[`, `]` on German/Swiss/French layouts — a hazard this change comes nowhere near, and must not drift into.)
- Shift-wheel stops reaching mouse-mode apps and scrolls the viewport instead. Also the conventional binding, and the only bypass that works while a legitimate mouse-mode app is running.
- Two contract files change: one new (item 7), one retargeted (item 9). The retarget is mechanical but touches assertions written as the *documentation* of a shipped fix — preserve each assertion's intent and message, retarget only the identifier.

### Dependencies & Conflicts

- `@xterm/xterm ^5.5.0`. Five vendored-bundle facts are load-bearing and were verified against `src/webview/vendor/xterm/xterm.js`, not assumed:
  - `attachCustomWheelEventHandler` is checked first in **both** wheel paths — `…ventHandler(e))return!1;if(!this.buffer.hasScrollback){…}` — so returning `false` skips xterm's mouse report *and* its `preventDefault`, leaving the browser's native viewport scroll intact.
  - `enable-mouse-events` is added to / removed from `term.element`'s class list on every mouse-protocol change, so it is a public DOM signal for "mouse reporting is active" with no private-API reach.
  - DECSET/DECRST generate no answerback, so the mode write cannot provoke a reply and does not interact with `suppressAnswerback`.
  - **`?1049l` calls `restoreCursor()` unconditionally.** `case 1049:case 47:case 1047:this._bufferService.buffers.activateNormalBuffer(),1049===e.params[t]&&this.restoreCursor(),…` — `activateNormalBuffer()` self-guards on `_activeBuffer!==this._normal`, but `restoreCursor()` sits **outside** that guard, and `restoreCursor(e){return this._activeBuffer.x=this._activeBuffer.savedX||0,this._activeBuffer.y=Math.max(this._activeBuffer.savedY-this._activeBuffer.ybase,0),this._curAttrData.fg=this._activeBuffer.savedCurAttrData.fg,…}`. On a freshly built xterm `savedX`/`savedY` are 0. This is the reason for the buffer gate in item 3.
  - `term.buffer.active.type` is public API and is the gate's read: the namespace builds `new BufferApiView(this._core.buffers.alt, "alternate")`, so `term.buffer.active.type === 'alternate'` is exact, not heuristic. (`term.modes.mouseTrackingMode` — `'none' | 'x10' | 'vt200' | 'drag' | 'any'` — is likewise public and is recorded in item 4 as the cross-check for the pill's class read.)
- `src/standalone/terminalWsGateway.ts` — builds on the answerback plan's `writeReplay` (`terminals.js:2959-2972`) and the hello → single-replay-frame ordering contract (`terminalWsGateway.ts:811-823`). Both already shipped.
- `src/test/terminal-input-path-contract.test.js` — **hard dependency, not adjacency.** Nine assertions plus an executing harness are keyed to `bracketedPasteModes` / `scanBracketedPasteMode`. Item 9 is mandatory, not optional cleanup.
- `src/test/terminal-answerback-replay-contract.test.js` — slices `writeReplay` (`'function writeReplay(entry, text)'` → `'function onWriteParsed('`) and the hello branch (`"frame.t === 'hello'"` → `"frame.t === 'inputThrottled'"`). Both slices survive the changes as written: the callback addition contains no `batchQueue`, and the hello branch keeps `awaitingReplayFrame` and `replayChars`. Also slices `'term.onData('` → `'connectTerminalSocket(entry);'` — which is why item 6's wheel registration goes at `:2534`, **before** `term.onData`, not inside that window.
- `src/test/terminal-scroll-affordance-contract.test.js` — regex-matches `function destroyTerminalView\([\s\S]*?\n    \}` (non-greedy to the first 4-space-indented `}`). The new observer teardown must stay at 8-space indent or deeper inside that function, which it does. Also enforces exactly one bare `::-webkit-scrollbar` rule in `terminals.html`; the new `.mouse-mode-release` block adds none.
- `src/test/terminal-focus-affordance-contract.test.js` — asserts status colours in `terminals.html` are `:root` tokens, not repeated literals. Scoped to `.pane-input-state`, so the new rule does not trip it, but the file's convention is the reason item 5 adds a token instead of a hex.
- Legacy `t: 'out'` text framing (downgraded server) sends no `modes` field: nothing is armed, behaviour is today's. The `bracketedPaste` field is retained on the wire so an older webview against a newer server keeps working.
- Webview assets ship via `npm run compile` into `dist/webview/`. **`headlessPanelHtml.ts:388-389` resolves `dist/webview/terminals.html` *before* `src/webview/terminals.html`**, so a stale `dist/` serves the old CSS even in a dev run. And the running extension loads from `~/.<ide>/extensions/turnzero.switchboard-*/dist/`, **not** the dev repo's `dist/` — a build alone changes nothing on screen.
- **PRD alignment (Browser Switchboard).** Contract #1 (anti-divergence): `terminals.js` / `terminals.html` are the shared panel assets both hosts render, and this change edits them in place — no fork. Contract #2 (byte-compat on ~4,000 installs): the only shipped-behaviour deltas are the three in *Side Effects*, all in the terminals panel. Contracts #4–#7 (verb return contract, HTTP schemas, capability gating, two-layer completion) are untouched: this change adds no verb, no route, no `/panels` row. `npm run verb-returns:check`, `parity:check` and `push-routing:check` are unaffected — no `postMessage` is added.

## Dependencies

- None upstream. Self-contained in `src/standalone/terminalWsGateway.ts` + `src/webview/terminals.js` (+ `terminals.html` for the token and the pill's CSS), one new contract test, **one retargeted contract test**, one `package.json` script, one CI step.

## Adversarial Synthesis

**Risk Summary.** Three risks carry this change. (1) **Ordering** — the authoritative mode write must land *after* the replay parse; written before it, a stale enable inside the evicted-tail replay wins and the bug survives unchanged while every test passes. (2) **The `1049` write is not inert** — xterm calls `restoreCursor()` outside its own was-alt guard, so an ungated `?1049l` teleports the cursor to row 0 on top of the scrollback the replay just wrote; the write is therefore gated on `term.buffer.active.type === 'alternate'`. (3) **A shipped contract file breaks on the rename** — `terminal-input-path-contract.test.js` executes the scanner by exact signature and reads a field named `bracketedPasteModes`, so the rename is a coordinated two-file edit, not a rename. Mitigations: apply-after-replay routed through `writeReplay`'s callback and pinned structurally; the 1049 gate pinned by an assertion that `?1049l` appears only under a buffer-type test; the retarget is its own numbered item with the failing assertions enumerated. Residual risk is concentrated in manual verification — every symptom here is invisible to a headless run.

## Proposed Changes

> **Line-number note.** Every `terminals.js` reference in the original draft was stale by ~28–42 lines. All references below were re-resolved against the working tree on 2026-08-04 and are correct as written. If they drift again, the anchors (function names, marker strings) are authoritative, not the numbers.

### 1. `src/standalone/terminalWsGateway.ts` — track the mode set, not one mode

**Context.** Replace `bracketedPasteModes` (`:140-152`) and generalise `scanBracketedPasteMode` (`:483-514`). The regex, the carry (`modeScanCarry`, `:157`), the `MODE_SCAN_CARRY_MAX` bound (`:23`) and the RIS/DECSTR handling all survive unchanged — only what is recorded per match changes.

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
 *   9               X10 mouse reporting. Does NOT claim the wheel (X10:{events:1}
 *                   is DOWN only; the WHEEL bit is 16), so it cannot cause the
 *                   no-scroll symptom — but areMouseEventsActive() is
 *                   `0 !== protocols[active].events`, so events:1 still trips it and
 *                   xterm still disables its SelectionService. Stale mode 9 therefore
 *                   produces HALF the reported bug: clicks cannot clear a selection
 *                   while the wheel works fine.
 *   1000/1002/1003  mouse reporting (VT200 / drag / any-motion). All three claim the
 *                   WHEEL (events 19 / 23 / 31 — bit 16 set in each), so a stale
 *                   enable makes the pane unscrollable AND kills selection. This is
 *                   the reported bug.
 *   1006            SGR mouse coordinates — meaningless alone, but it rides with
 *                   the above and a half-restored pair reports garbage coordinates.
 *   1004            focus reporting. Benign if wrong, cheap to carry, and losing it
 *                   makes a TUI think it never regained focus.
 *   2004            bracketed paste — the one mode already tracked here, and the
 *                   reason this mechanism exists.
 *   1049            alternate screen. RECORDED here for completeness (so RIS/DECSTR
 *                   bookkeeping is whole), but the client writes NEITHER direction
 *                   except under a live buffer-type check — see applyServerModes in
 *                   terminals.js. Do not assume tracked implies re-armed.
 *
 * NOT tracked: 1005 and 1015. The vendored xterm answers DECRQM for both with
 * "permanently reset" (`1005===u?4:…:1015===u?4:`) and logs
 * "DECSET 1005 not supported (see #2507)" on set/reset, i.e. it does not implement
 * them, so a record would describe a mode the client cannot enter.
 */
export const TRACKED_DEC_MODES = [9, 1000, 1002, 1003, 1004, 1006, 1049, 2004] as const;

/** Terminal name -> (mode number -> last observed h/l). A mode ABSENT from the
 *  inner map has never been ruled on and must be omitted from hello, never sent
 *  as false. */
private decModes = new Map<string, Map<number, boolean>>();
```

> **Superseded:** `TRACKED_DEC_MODES = [1000, 1002, 1003, 1004, 1006, 1049, 2004]` — mode 9 absent, and the doc comment attributing the WHEEL claim to 1000 alone.
> **Reason:** Web research established that `term.modes.mouseTrackingMode` enumerates `'x10'` as a first-class tracking state, which sent me back to the bundle: `X10:{events:1,…}` and `areMouseEventsActive(){return 0!==this._protocols[this._activeProtocol].events}`. Because the predicate tests only "events is non-zero", mode 9 **does** disable the SelectionService — so a stale mode 9 reproduces the "click cannot clear a selection" half of the reported bug, while leaving the wheel working. Untracked, it is invisible to the server, absent from hello, and never re-armed. Worse, it makes the item 4 pill a **dead button**: the pill's visibility reads the `enable-mouse-events` class (set for *any* active protocol, mode 9 included), so it would appear — but its release write of `1000l/1002l/1003l/1006l` does not clear mode 9, so clicking it would change nothing and the pill would stay visible. That is a dead-click, which PRD contract #6 forbids outright. The draft also credited only 1000 with the WHEEL bit; 1002 (`events:23`) and 1003 (`events:31`) both carry bit 16 too.
> **Replaced with:** `9` added to `TRACKED_DEC_MODES`, to `REARMABLE_DEC_MODES` (item 3), and to the pill's release write (item 4). Doc comment corrected to describe X10's distinct half-symptom and to credit all three of 1000/1002/1003 with the wheel.

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
                    if (TRACKED_DEC_MODES.includes(mode as typeof TRACKED_DEC_MODES[number])) {
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

        // Carry logic VERBATIM from scanBracketedPasteMode — including the fragment
        // test. Only a trailing fragment that could still BECOME one of the tracked
        // sequences is kept; a colour SGR or OSC title tail is dropped, which is what
        // keeps the carry empty on essentially every flush.
        const tail = text.slice(Math.max(consumedEnd, text.length - MODE_SCAN_CARRY_MAX));
        const escIdx = tail.lastIndexOf('\x1b');
        const fragment = escIdx === -1 ? '' : tail.slice(escIdx);
        this.modeScanCarry.set(terminalName, /^\x1b(\[(\?[0-9;]{0,64}|!)?)?$/.test(fragment) ? fragment : '');
    }
```

> **Superseded:** the draft's final carry line — `this.modeScanCarry.set(terminalName, fragment.length <= MODE_SCAN_CARRY_MAX ? fragment : '');`
> **Reason:** It silently deletes the shipped fragment guard while the prose two paragraphs down says *"Retain the trailing-fragment carry logic verbatim."* Worse, the replacement test is **always true**: `tail` is already sliced to at most `MODE_SCAN_CARRY_MAX`, so `fragment.length <= MODE_SCAN_CARRY_MAX` can never be false and every ESC-prefixed tail — a colour SGR, a half-written OSC title — gets carried into the next chunk. `terminal-input-path-contract.test.js` asserts the opposite directly (`assert.strictEqual(b.modeScanCarry.get('t'), '', 'a colour SGR tail must be dropped, never carried')` after feeding `'red \x1b[31m'`), so the draft line is a second, independent break of that contract.
> **Replaced with:** the shipped `/^\x1b(\[(\?[0-9;]{0,64}|!)?)?$/.test(fragment) ? fragment : ''` test, copied unchanged, as in the block above.

**Also.** Rename the call site in `flushOutput` (`:414`) — it must stay **before** the ring append (`:420`), for the reason the existing comment gives at `:412-413`. Swap `bracketedPasteModes` for `decModes` in the **three** name-keyed collection lists:

| Site | Line | Edit |
| :--- | :--- | :--- |
| `untrackTerminalData` | `:534` | `this.bracketedPasteModes.delete(name)` → `this.decModes.delete(name)` (its comment says to keep the list in sync) |
| `rekeyTerminal` | `:594` | `moveMap(this.bracketedPasteModes)` → `moveMap(this.decModes)` |
| `dispose` | `:1015` | `this.bracketedPasteModes.clear()` → `this.decModes.clear()` |

`modeScanCarry` is unchanged at all three sites and must stay.

**Edge cases.** The inner map is created lazily on the first mode event, so a terminal that never emits one contributes no `modes` field and the client keeps xterm's defaults. `TRACKED_DEC_MODES.includes` on a 7-element array runs once per param, only inside a matched escape — no measurable cost on the event loop that owns the whole fleet. The `as typeof TRACKED_DEC_MODES[number]` cast (rather than `as any`) keeps the `as const` tuple's type usable and satisfies the contract test's "no unstripped type annotation" check, which scans for a fixed list of annotations and would not flag a cast — but keep the cast on the *argument*, not on a new local, so no `: number` annotation appears in the extracted body.

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

**Edge cases.** `Object.fromEntries` on a `Map<number, boolean>` yields string keys (`{"1000":true}`), which is what JSON gives anyway; the client reads them with a numeric key coerced to string. Pinned by the contract test. `bracketedPaste` is still derived from the same record, so the legacy field can never disagree with `modes["2004"]`.

### 3. `src/webview/terminals.js` — apply the modes AFTER the replay

**Context.** The hello branch at `:2813-2848` (replacing the bracketed-paste write at `:2846-2848`), `writeReplay` (`:2959-2972`), the entry literal (`:2434-2464`), and the reset block in `connectTerminalSocket` (`:2721-2728`).

**Logic.** Two changes, and the second is the one that makes the fix work.

> **Superseded:** the bracketed-paste write's placement, and the comment justifying it — *"It lands ahead of the replay frame, which is correct — the replay is a suffix of history, so any 2004 escape inside it re-applies this same value."*
> **Reason:** that premise holds only while the ring still contains the last transition for the mode. The bug being fixed here is precisely the case where it does not: the ring evicted the reset, so the replay re-applies a **stale** enable on top of the authoritative value and wins. Writing before the replay is therefore correct only in the cases that were never broken.
> **Replaced with:** arm `entry.pendingModes` on hello and apply it in the replay write's callback (or inline when there is no replay). Ordering becomes: replay parse → authoritative mode state. Bracketed paste moves with the rest, which retires the same latent flaw for pastes.

**Implementation** — module-level helper, next to `ACK_CHUNK_CHARS` (`:2298`), declared **above** `ANSWERBACK_RE` (`:2350`):

```js
    /**
     * DEC private modes the gateway reports, in application order.
     *
     * A fresh xterm has all of these at their defaults while the pty app's belief
     * persists, and the app never re-announces a settled mode — so without this the
     * pane can come back with mouse reporting on and nothing left to turn it off:
     * the wheel goes to the app instead of the viewport (1000/1002/1003 all set the
     * WHEEL bit — event masks 19/23/31) and xterm disables its own SelectionService,
     * so a click can neither start nor clear a selection. That is the "stuck, can't
     * scroll, can't deselect" report.
     *
     * 9 (X10) is here even though it does NOT claim the wheel: areMouseEventsActive
     * only tests that the active protocol's event mask is non-zero, and X10's is 1,
     * so a stale mode 9 still kills selection.
     *
     * 1049 is NOT in this list — it is handled separately and conditionally below.
     */
    const REARMABLE_DEC_MODES = [9, 1000, 1002, 1003, 1004, 1006, 2004];

    /**
     * Force the terminal's DEC private modes to the gateway's recorded state.
     * Returns true when something was actually written.
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
        if (!entry || entry.disposed || !entry.term || !modes) { return false; }
        let seq = '';
        for (const mode of REARMABLE_DEC_MODES) {
            const on = modes[mode];
            if (typeof on !== 'boolean') { continue; }
            seq += `\x1b[?${mode}${on ? 'h' : 'l'}`;
        }
        // Alt screen: NEITHER direction is written blind. `?1049h` into a freshly
        // built xterm switches it to an EMPTY alt buffer and hides the scrollback the
        // replay just wrote — a blank pane, worse than the bug.
        //
        // And `?1049l` is NOT inert. This is NOT an xterm.js quirk: XTerm's ctlseqs
        // defines `?1049l` as the composite of 1047 (buffer switch) + 1048 (cursor
        // restore), so DECRC is part of the sequence's DEFINITION — and real xterm,
        // iTerm2, Windows Terminal, Alacritty and VS Code all perform it too. In the
        // vendored bundle the arm is
        //   case 1049: … activateNormalBuffer(), 1049===param && this.restoreCursor()
        // where restoreCursor() sits OUTSIDE activateNormalBuffer's own
        // `_activeBuffer!==this._normal` guard, and on a fresh instance savedX/savedY
        // are 0 — so an unguarded write teleports the cursor to viewport row 0 col 0
        // and resets SGR, after which the next live chunk overwrites the top of the
        // scrollback this very replay just wrote.
        //
        // So the gate is a DELIBERATE DEVIATION from spec, justified because our write
        // is synthetic: a real app sending `?1049l` knows it saved a cursor, whereas we
        // are asserting a mode the app already believes is settled and have no saved
        // cursor worth restoring. Written ONLY when xterm is genuinely in the alt
        // buffer, where DECRC is both correct and expected. `term.buffer.active.type`
        // is documented public API since 4.0 (BufferApiView is constructed with the
        // literal "alternate").
        //
        // Do not "complete" this to a symmetric write, and do not drop the gate — the
        // unconditional form was evaluated against gate-and-omit and lost on both.
        let inAlt = false;
        try { inAlt = entry.term.buffer.active.type === 'alternate'; } catch { /* pre-open */ }
        if (modes[1049] === false && inAlt) { seq += '\x1b[?1049l'; }
        if (!seq) { return false; }
        try { entry.term.write(seq); } catch { return false; /* disposed between guard and write */ }
        return true;
    }
```

> **Superseded:** `if (modes[1049] === false) { seq += '\x1b[?1049l'; }`, and the comment asserting *"`?1049l` only ever returns to the normal buffer, which is safe in both directions."*
> **Reason:** The claim is false in the vendored bundle. `case 1049:case 47:case 1047:this._bufferService.buffers.activateNormalBuffer(),1049===e.params[t]&&this.restoreCursor(),…` — `activateNormalBuffer()` no-ops when already normal, but `restoreCursor()` is called unconditionally, and `restoreCursor(e){return this._activeBuffer.x=this._activeBuffer.savedX||0,this._activeBuffer.y=Math.max(this._activeBuffer.savedY-this._activeBuffer.ybase,0),…}` resolves to (0,0) on a fresh xterm. So on every reattach where the server has ever observed a `?1049l` — which is *most* of them, since Claude Code emits three and any `RIS`/`DECSTR` also records `1049:false` — the plan as drafted would yank the cursor to viewport row 0 on top of the 256 KB it just replayed and let live output overwrite it. A cosmetically-correct mode restore that corrupts the pane is a worse outcome than the bug being fixed.
> **Replaced with:** the buffer-gated write above — `modes[1049] === false && term.buffer.active.type === 'alternate'`. In the alt buffer the cursor restore is the correct DECRC semantic; in the normal buffer the write is skipped entirely, which is a true no-op.

**Implementation** — hello branch, replacing the `frame.bracketedPaste` write at `:2846-2848`:

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
                    // Cleared only when the write actually landed. A hello that arrives
                    // before the view materialised (no entry.term) keeps the set armed
                    // rather than dropping it on the floor.
                    if (!entry.awaitingReplayFrame && applyServerModes(entry, entry.pendingModes)) {
                        entry.pendingModes = null;
                    }
```

**Implementation** — `writeReplay`'s callback (`:2963-2966`):

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

The throw path (`:2968-2971`) clears `entry.pendingModes` alongside `suppressAnswerback` — a mode set stranded on the entry would be applied by the *next* replay, i.e. against a stream it does not describe.

**Implementation** — entry literal (`:2462-2463`) and reconnect reset (`:2727-2728`):

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

**Edge cases.** A legacy entry without the field reads `undefined`, which is falsy everywhere it is tested. If `term.dispose()` beats the replay callback the modes are simply never applied, and the entry is already out of `terminalsMap`. `term.buffer.active` is read inside a `try` because `term.open()` has always run before `connectTerminalSocket` at every call site today, but the guard costs nothing and removes the ordering dependency.

### 4. `src/webview/terminals.js` — a visible release valve for mouse mode

**Context.** New helper beside `attachJumpToLatest` (`:2643-2696`), called from `materializeTerminalView` after `attachJumpToLatest(entry, term, container)` (`:2533`); teardown in `destroyTerminalView` (`:2363-2417`) next to the jump-pill teardown (`:2400-2410`).

**Logic.** Desync path 1 (an app that died holding the mode) is not reachable from the server — nothing observed a reset, because there was none. The operator needs a way out that does not involve killing the terminal. Follow the jump-to-latest precedent exactly: a pill shown **by state, not by hover**, so an operator who does not know it exists never has to hover for it. The state signal is public DOM — xterm adds `enable-mouse-events` to `term.element` on every mouse-protocol change — so no private API is touched.

The pill both explains the state ("this app is taking your mouse") and releases it. Releasing writes the resets to the **parser**, not the pty: the app keeps believing whatever it believes, and xterm stops handing it the mouse. That is the correct direction — the operator is overriding the app's claim on their pointer, not asking the app to give it up.

**Why the class and not `term.modes`.** `term.modes.mouseTrackingMode` (`'none' | 'x10' | 'vt200' | 'drag' | 'any'`) is public API and is the authoritative *state* read — but xterm exposes no mode-change event, so a state read alone would need polling. The class mutation *is* the transition signal, and it is written on the same line as the SelectionService toggle that causes the symptom, so it cannot drift from it. `term.modes` is recorded here as the documented cross-check for manual verification (step 7 below), not as the runtime read.

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
     * _coreMouseService. It is also written on the same statement as the
     * SelectionService toggle that causes the symptom, so it cannot drift from it.
     */
    function attachMouseModeRelease(entry, term, container) {
        const btn = document.createElement('button');
        btn.className = 'mouse-mode-release';
        btn.type = 'button';
        btn.tabIndex = -1;   // the terminal owns the keyboard; this is a pointer control
        btn.title = 'This app is capturing the mouse — release it to scroll and select';
        btn.setAttribute('aria-label', 'Release the mouse from the running application');
        btn.textContent = 'release mouse';
        container.appendChild(btn);
        entry.mouseModeBtn = btn;

        const update = () => {
            if (entry.disposed || !term.element) { return; }
            btn.classList.toggle('visible', term.element.classList.contains('enable-mouse-events'));
        };

        // click, NOT mousedown — same reason as the jump pill: the pane's own
        // mousedown must run first so the press also selects the pane.
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            // To the PARSER, not the pty: the app keeps its own belief, xterm stops
            // acting on it. EVERY mouse protocol is reset, not just the active one —
            // the operator wants their pointer back, not a negotiation. Mode 9 (X10)
            // is included and is NOT optional: the pill's visibility reads
            // `enable-mouse-events`, which xterm sets for any non-zero event mask
            // including X10's, so omitting `?9l` would show the pill for a mode this
            // click cannot clear — a dead button.
            try { term.write('\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l'); } catch { /* disposed */ }
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

Add `mouseModeObserver: null` and `mouseModeBtn: null` to the entry literal (`:2434-2464`) beside `jumpBtn`, so the fields exist before first use rather than being created ad hoc.

Teardown, beside the jump-pill's (`:2400-2410`) — a `MutationObserver` is not an xterm disposable and `term.dispose()` will not disconnect it. This is the **first** `MutationObserver` in this file, so it establishes the pattern rather than following one:

```js
        if (entry.mouseModeObserver) {
            try { entry.mouseModeObserver.disconnect(); } catch { /* ignore */ }
            entry.mouseModeObserver = null;
        }
        entry.mouseModeBtn = null;
```

Keep this block at 8-space indent inside `destroyTerminalView` — `terminal-scroll-affordance-contract.test.js` slices that function with `/function destroyTerminalView\([\s\S]*?\n    \}/`, which terminates at the first 4-space-indented `}`.

**Edge cases.** The pill sits in the same corner family as `jump-to-latest`, so the CSS must place them so they cannot overlap when both are visible (stack it above: `bottom: 40px`, same `right: 22px`). If `term.element` is missing the observer is skipped and the pill stays hidden — no throw. Clicking it while no app is capturing the mouse is a no-op write of four resets. The pill's release does **not** touch 1049: an app in the alt screen needs the alt screen; taking it away mid-draw is a different and worse failure than an unscrollable pane.

### 5. `src/webview/terminals.html` — token + pill CSS

**Context.** Token in the semantic-status block of `:root` (`:44-49`, beside `--state-connecting` / `--state-readonly`). Rule beside `.jump-to-latest` (`:382-402`), which it mirrors.

> **Superseded:** `background: var(--accent-warn, #e0a030);` with the edge-case note *"Confirm `--accent-warn` (or the panel's equivalent warning token) exists in this file's `:root` … if it does not, add it there rather than hardcoding a hex at the use site."*
> **Reason:** Confirmed during this pass: `--accent-warn` **does not exist** anywhere in `terminals.html` — the only tokens are the `--accent-primary` / `--accent-teal` brand pair and the `--state-connecting` / `--state-readonly` semantic-status pair. So the `var(…, #e0a030)` fallback is not a safety net, it is *the* value that would ship — a hardcoded hex at the use site, which is exactly what the plan's own note forbids and what `terminal-focus-affordance-contract.test.js` calls out as "literals repeated as hex + rgba twins".
> **Replaced with:** a new `--state-mouse-captured` token in the existing semantic-status block, used bare with no hex fallback. That block is already deliberately absent from `body.theme-claudify` (its comment: *"Semantic status, NOT brand accent — deliberately absent … so a connecting terminal reads amber in both themes"*), which is precisely the property this pill wants — a condition the operator did not ask for should read the same in both themes.

**Implementation** — token, appended inside the existing semantic-status comment block in `:root`:

```css
            /* Mouse captured by the pty app. Same family and same reasoning as
               --state-connecting: a condition the operator did not ask for, so it
               reads identically in both themes and is deliberately NOT redeclared
               in body.theme-claudify. */
            --state-mouse-captured: #d7a03a;
```

**Implementation** — rule, immediately after `.jump-to-latest:hover` (`:402`):

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
            background: var(--state-mouse-captured);
            border: none;
            border-radius: 10px;
            cursor: pointer;
            z-index: 3;
            box-shadow: 0 1px 6px rgba(0, 0, 0, 0.45);
        }
        .mouse-mode-release.visible { display: inline-flex; }
        .mouse-mode-release:hover { filter: brightness(1.12); }
```

**Edge cases.** `--term-surface` as the foreground is copied from `.jump-to-latest` and is correct against amber as well as teal. The rule adds no bare `::-webkit-scrollbar` selector, so `terminal-scroll-affordance-contract.test.js`'s "bare rule count is still 1" assertion is unaffected. `xterm.css:128` already defines `.xterm.enable-mouse-events { cursor: default }` — do not duplicate or override it here; the pill's own `cursor: pointer` wins on its own element.

### 6. `src/webview/terminals.js` — two standing bypasses

**Context.** The `Terminal` constructor (`:2497-2520`) and a registration at `:2534`, immediately after `attachJumpToLatest(entry, term, container)` and **before** `term.onData(` (`:2580`).

**Logic.** Both restore a habit the operator already has from iTerm and VS Code, and both work *while* a legitimate mouse-mode app is running — which the pill in item 4 deliberately does not (it takes the mouse away from the app).

**Implementation** — constructor option, added inside the existing option literal:

```js
            // Option-drag selects even while an app is capturing the mouse. xterm's
            // shouldForceSelection() has a Mac branch gated entirely on this option,
            // and the bundled default is FALSE — so without it there is no modifier
            // that can select text in a mouse-reporting app on macOS, which is the
            // platform this panel runs on. Matches iTerm and VS Code.
            macOptionClickForcesSelection: true,
```

**Implementation** — wheel bypass, at `:2534`:

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

**Edge cases.** Returning `true` for the unmodified case preserves today's behaviour exactly, including alt-buffer wheel-to-arrow-keys. Guarded on the method existing so a downgraded vendor bundle does not throw at materialise time. Placement matters: `terminal-answerback-replay-contract.test.js` slices `'term.onData('` → `'connectTerminalSocket(entry);'`, so registering at `:2534` keeps this out of that window and leaves the slice meaning what it meant. Shift-wheel reaching the viewport rather than the app is the one bypass that cannot be verified from source — it is manual step 10.

### 7. `src/test/terminal-dec-mode-restore-contract.test.js` — new source-text contract

**Context.** Same style and `block()` helper as `src/test/terminal-answerback-replay-contract.test.js`. These are behaviours that fail silently and are invisible to any headless run, so they get pinned structurally.

**Logic.** Pin the six things whose reversal would silently un-fix the bug or re-introduce the corruption:

1. The gateway records **all** tracked modes, not just 2004, and scans before the ring append.
2. Hello omits `modes` when nothing has been observed (the "omitted, NOT false" rule), and derives `bracketedPaste` from the same record.
3. The client applies the set **after** the replay — assert `applyServerModes` is called from `writeReplay`'s callback and that the hello branch only applies inline when `!entry.awaitingReplayFrame`.
4. `1049` is absent from `REARMABLE_DEC_MODES`, and the `?1049l` literal appears **only** in a statement that also tests `=== 'alternate'` — the blank-pane *and* cursor-teleport guards, together. Assert the literal `\x1b[?1049h` appears nowhere in `terminals.js`.
5. The carry-fragment guard regex survives in the gateway scanner (the draft deleted it once already).
6. `decModes` is torn down at all **three** sites: `untrackTerminalData`, `rekeyTerminal`, `dispose`.
7. **Mode 9 parity across all three lists — the dead-button guard.** Assert `9` is present in the gateway's `TRACKED_DEC_MODES`, in the client's `REARMABLE_DEC_MODES`, **and** in the pill's release write. Write it as a *parity* assertion (every mouse mode the pill can display must be a mode the pill can clear), not three independent greps: the failure being pinned is the three lists drifting apart, which three separate greps would each pass. Derive the mouse-mode subset from a single source in the test rather than restating it.

Plus: `pendingModes` is reset in `connectTerminalSocket` and cleared on `writeReplay`'s throw path, the `MutationObserver` is disconnected in `destroyTerminalView`, `macOptionClickForcesSelection: true` is in the constructor, the wheel handler returns `!ev.shiftKey`, and `--state-mouse-captured` is declared in `terminals.html`'s `:root` with no hex literal inside the `.mouse-mode-release` rule.

**Implementation.** Follows the sibling file structure verbatim: `test()` helper, `block(code, startMarker, endMarker)`, `console.log` of the tally, and — matching all sibling terminal contracts — `if (failed > 0) { process.exit(1); }` as the last line, with **no** explicit success exit. Reads all three sources (`terminalWsGateway.ts`, `terminals.js`, `terminals.html`).

**Edge cases.** The `block()` slices depend on `applyServerModes` being declared between `ACK_CHUNK_CHARS` and `isAnswerback`, and on `attachMouseModeRelease` being declared adjacent to `attachJumpToLatest`. A move breaks the test loudly with a "marker not found" message, which is the intended behaviour rather than a silent pass. Assertion 4 must be written as a *proximity* check on a single statement, not two independent `includes` — two separate greps would pass on a file where the gate and the write had drifted apart.

### 8. `package.json` + `.github/workflows/integration-tests.yml` — wire it

**Context.** Script beside the other thirteen `test:contract:terminal-*` entries (`package.json:814-857`); CI step beside them in the workflow (`:272-347`).

**Logic.** A contract defined but never invoked is the exact "green while incomplete" hole the answerback review pass found — the script existed in `package.json` with no workflow step. Both land in the same change. Note that `test:contract:terminal-operations-no-periodic-reopen` is deliberately *not* wired (comment at workflow `:347`); this one **is**.

**Implementation.**

```json
    "test:contract:terminal-dec-mode-restore": "node --require ./src/test/bootstrap/sandboxStateHome.js src/test/terminal-dec-mode-restore-contract.test.js",
```

```yaml
      - name: Terminal DEC mode restore contract
        run: npm run test:contract:terminal-dec-mode-restore
```

### 9. `src/test/terminal-input-path-contract.test.js` — retarget the renamed identifiers

> **Superseded:** the draft's Verification Plan item — *"`npm run test:contract:terminal-flow-control`, `:terminal-input-path`, `:terminal-rename-rekey`, `:terminal-solo-popout` — must stay green. The ledger, the input path, the re-key collection list and the pop-out path are all adjacent."*
> **Reason:** `terminal-input-path` is not adjacent — it is **coupled**. It hard-codes `bracketedPasteModes` and `scanBracketedPasteMode` in nine places, and its `loadScanner()` helper extracts the scanner body by exact-signature string match (`SIG = 'private scanBracketedPasteMode(terminalName: string, data: string): void {'`), compiles it with `new Function`, and reads the result out of a mock object whose field is literally `bracketedPasteModes: new Map()`. Item 1's rename fails **every** behavioural assertion in that file, not one. Claiming it "stays green" is the precise failure mode the answerback review pass was created to catch: a plan whose verification step reports success for work it never did.
> **Replaced with:** a mandatory ninth change item, below. `terminal-flow-control`, `terminal-rename-rekey` and `terminal-solo-popout` genuinely are adjacent and do stay green unedited — `terminal-rename-rekey` asserts only on `moveMap`'s shape (`:68`), not on which maps it is handed.

**Context.** `src/test/terminal-input-path-contract.test.js`. Retarget, do not delete: each assertion's *message* documents a shipped fix and must survive verbatim; only the identifier changes.

**Logic.** The scanner is now general, so the test's subject widens from "bracketed paste is recorded" to "the tracked mode set is recorded" — with 2004 kept as the worked example so the original bug stays pinned by name. Every edit below is mechanical; none changes what is asserted.

| Line | Current | Change |
| :--- | :--- | :--- |
| `:116` | `includes('private bracketedPasteModes = new Map<string, boolean>()')` | → `includes('private decModes = new Map<string, Map<number, boolean>>()')` |
| `:118` | `block(gatewayCode, 'private flushOutput(', 'private scanBracketedPasteMode(')` | end marker → `'private scanTerminalModes('` |
| `:119` | `flush.indexOf('this.scanBracketedPasteMode(')` | → `'this.scanTerminalModes('` |
| `:126` | `block(gatewayCode, 'private scanBracketedPasteMode(', 'private untrackTerminalData(')` | start marker → `'private scanTerminalModes('` |
| `:128` | `scan.includes("split(';').includes('2004')")` | → assert the whole-param comparison survives: `scan.includes("match[1].split(';')")` **and** `scan.includes('TRACKED_DEC_MODES.includes(')`. Keep the original message — whole-param comparison is still the reason `\x1b[?12004h` must not match. |
| `:179-181` | `arm.includes('\\x1b[?2004h')` on the hello-branch slice | The literal moved out of the hello branch into `applyServerModes`. Retarget to the new location: assert the hello branch arms `entry.pendingModes`, and assert `block(terminalsJs, 'function applyServerModes(', 'function ')` builds the escape from `REARMABLE_DEC_MODES`. Keep the `!arm.includes('batchQueue')` assertion where it is — still true, still load-bearing. |
| `:199` | `SIG = 'private scanBracketedPasteMode(terminalName: string, data: string): void {'` | → `'private scanTerminalModes(terminalName: string, data: string): void {'` |
| `:223-227` | mock `{ bracketedPasteModes: new Map(), … }` and `feed` returning `this.bracketedPasteModes.get(name)` | → `{ decModes: new Map(), … }`; `feed` returns `(this.decModes.get(name) \|\| new Map()).get(2004)` so every existing `strictEqual(…, true/false/undefined)` assertion keeps its exact meaning against the 2004 example. |
| `:270`, `:275` | `drip.bracketedPasteModes.get('t')`, `cross.bracketedPasteModes.get('b')` | → the same `decModes`-based accessor as above. |
| `:299` | `untrack.includes('this.bracketedPasteModes.delete(name)')` | → `'this.decModes.delete(name)'` |
| `:302` | `dispose … includes('this.bracketedPasteModes.clear()')` | → `'this.decModes.clear()'` |

**Also add**, in the same file, one assertion the widened scanner earns: a multi-param DECSET (`\x1b[?1049;1000;1006h`) records **all three** modes. The existing suite only ever feeds single-param sequences, so nothing currently proves the `split(';')` loop records more than the first match.

**Edge cases.** `:211`'s type-annotation strip list (`'let match: RegExpExecArray | null;'`) and its `leftover` guard must keep passing — item 1's `as typeof TRACKED_DEC_MODES[number]` cast is not in the scanned annotation list, but `TRACKED_DEC_MODES` is a module-level `const` that the extracted body references and `new Function` will not have in scope. **Pass it in**: extend the `new Function` parameter list and the `scan.call(...)` arguments with `TRACKED_DEC_MODES` (hard-coded in the test as `[9,1000,1002,1003,1004,1006,1049,2004]`, with a separate assertion that the gateway's literal matches — the assertion is what catches a future mode being added to the gateway and not to the harness). Without this the harness throws `TRACKED_DEC_MODES is not defined` on the first feed — a red test, not a silent pass, but a confusing one to debug cold.

## Resolved Assumptions

**Authoritative. Do not re-open or re-research any item in this section.** Web research was run on 2026-08-04 (52 sources: XTerm `ctlseqs`, DEC VT220/VT510 manuals, xterm.js typings + release notes, iTerm2 / Windows Terminal / Alacritty / VS Code sources, TUI-framework and AI-CLI sources) and every item below is settled. Two findings changed the plan; both are marked with superseded callouts at their implementation sites.

| # | Question | Verdict | Effect on the plan |
| :--- | :--- | :--- | :--- |
| 1 | Are `attachCustomWheelEventHandler`, `term.modes` / `mouseTrackingMode`, and `term.buffer.active.type` supported public API, and do they survive 5.5 → 6.x? | **All three are documented public contracts, stable through 6.0.** Introduced 5.4.0, 4.14.0 and 4.0.0 respectively. No deprecations, no 6.x roadmap items touching them. `xterm` → `@xterm/xterm` was a package rename only; the typings are identical. | None. All three reads are safe as written; item 6's `typeof` guard is belt-and-braces, keep it. |
| 2 | Does returning `false` from the wheel handler leave native viewport scroll intact? | **Yes — documented contract.** It suppresses both the mouse report and xterm's internal viewport scroll, and xterm does **not** call `preventDefault()`. Four documented ways native scroll can still fail: `overflow: hidden`/`clip` on an ancestor, `touch-action: none` / `overscroll-behavior: contain`, an upstream listener calling `preventDefault`, and `scrollHeight === clientHeight`. | **Checked against this file:** `terminals.html` has no `touch-action` and no `overscroll-behavior` anywhere. `overflow: hidden` exists on `body` (`:99`) and `.terminal-pane` (`:598`), but neither is consulted — the wheel target's own `.xterm-viewport` is the nearest scrollable ancestor and scrolls first. Item 6 is clear. Manual step 12 remains the confirmation. |
| 3 | Is restore-cursor-on-`?1049l` spec-mandated or an xterm.js choice? | **Spec-mandated.** XTerm `ctlseqs` defines `?1049l` as the composite of 1047 (buffer switch) + 1048 (cursor restore), i.e. `DECRC` is part of the sequence definition. `?47l` and `?1047l` do **not** restore. The *variance* between emulators is only in cursor-register scoping; xterm.js, real xterm, iTerm2, Windows Terminal, Alacritty and VS Code **all** execute the restore when `?1049l` arrives in the normal buffer. | **Confirms the buffer gate, changes its rationale.** The gate is a deliberate deviation from a spec-mandated behaviour, not a workaround for an xterm.js quirk — reworded at the implementation site. Research independently evaluated gate-vs-omit-vs-unconditional and recommends the gate (its "Approach A"), matching item 3. |
| 4 | Does `macOptionClickForcesSelection` change how Option-modified *keystrokes* reach a mouse-mode app? | **No — it affects mouse events only.** Keystroke delivery is governed by `macOptionIsMeta` (bundled default `false`, not set here), which is untouched. | Resolves the concern favourably. **But it surfaced a real conflict:** `altClickMovesCursor`'s bundled default is `!0` (**true**, verified in the bundle), and forced selection takes precedence over it — see the new Side Effects entry. |
| 5 | Which mouse modes do agent CLIs actually set, and what happens on unclean exit? | **1000 or 1002 for tracking, 1006 for encoding, 1004 for focus. 1005/1015 avoided** (coordinate truncation past column 223, multi-byte ambiguity) — confirming they are correctly out of scope. 1003 is used but rarely held. On `SIGKILL` / uncaught exception the CLI bypasses its cleanup handlers, so no `DECRST` is ever sent. | Confirms the tracked set, and confirms 1002 belongs in it even though Claude Code shows 0 hits — other CLIs use it. The unclean-exit finding is desync path 1, stated verbatim in the Goal, and is exactly what items 4–6 exist for. |
| 6 | Is there prior art for an operator-facing "release the mouse" control? | **Yes, and it is the convention.** `Shift` is the xterm/Linux-standard selection bypass; `Option`/`Alt` is the macOS convention (iTerm2's default); tmux uses `Shift` to defer to the host terminal. VS Code ships **both** `terminal.integrated.macOptionClickForcesSelection` **and** an explicit "Toggle Mouse Reporting" command. | Validates all three affordances (pill, Shift-wheel, Option-drag) as convention rather than invention. The pill is the direct analogue of VS Code's Toggle Mouse Reporting, differing only in being state-visible rather than palette-hidden. |

### Closed by source reading, also not to be re-researched

Mode 1000's WHEEL bit (`VT200:{events:19}`), the SelectionService disable, the `?1049l` cursor restore in the vendored bundle, the 1005/1015 DECRQM `4` reply, the alt-buffer wheel-to-arrow conversion, the `enable-mouse-events` class contract, `--accent-warn`'s absence, `altClickMovesCursor`'s `true` default, the X10 event mask (`X10:{events:1}` — see item 1's mode-9 callout), `areMouseEventsActive(){return 0!==this._protocols[this._activeProtocol].events}`, and every assertion in `terminal-input-path-contract.test.js`.

### Known residual — accepted, not fixed here

**An app that dies inside the alternate screen leaves the pane in the alt buffer with no operator escape.** The gateway would have recorded `1049:true` (it observed the enable and never a reset), so item 3 correctly declines to write `?1049l` — from the server's view the app *is* legitimately in the alt screen. The pill deliberately does not touch 1049 (taking the alt screen from a live TUI mid-draw is a worse failure than an unscrollable pane). So this case still requires closing the pane. It is desync path 1 for a mode the pill cannot safely cover, it is the same failure that exists today, and widening the pill to reset 1049 would trade a rare stuck pane for a common corrupted one. Revisit only with a separate, explicitly-labelled "return to normal screen" control.

## Verification Plan

### Automated Tests

> **Improve-pass note.** Per this session's directives, the improve pass did **not** run compilation or any automated test. Everything below is the coder's gate, unexecuted here, and each item's expected outcome is stated from source reading — treat every line as a claim to be executed, not a result.

1. `npm run test:contract:terminal-dec-mode-restore` — new (item 7). All cases green.
2. `npm run test:contract:terminal-input-path` — **expected RED until item 9 lands, then green.** This is a coupled contract, not an adjacent one; see item 9 for the nine assertions and the executing harness that must be retargeted. If it is green *before* item 9, item 1's rename did not happen.
3. `npm run test:contract:terminal-answerback` — must stay green unedited. Item 3 edits `writeReplay` and the hello branch, both of which that contract slices; the additions contain no `batchQueue` and preserve `awaitingReplayFrame` / `replayChars`, so the slices still mean what they meant.
4. `npm run test:contract:terminal-scroll-affordance` — must stay green unedited. Item 4 adds to `destroyTerminalView` (inside the sliced region, at 8-space indent) and item 5 adds CSS (no bare `::-webkit-scrollbar` rule).
5. `npm run test:contract:terminal-flow-control`, `:terminal-rename-rekey`, `:terminal-solo-popout`, `:terminal-focus-affordance` — must stay green unedited. The ledger, the re-key `moveMap` shape, the pop-out path and the `:root` token convention are genuinely adjacent here.
6. `npm run compile` — clean build; `dist/webview/terminals.js`, `dist/webview/terminals.html` and the gateway bundle regenerated. Non-optional even for a CSS-only check: `headlessPanelHtml.ts:388-389` prefers `dist/webview/terminals.html` over `src/`, so a stale `dist/` serves the old stylesheet.
7. `node --check src/webview/terminals.js`.

### Deploy prerequisite (not a verification step)

Every manual check runs in a real browser terminal, so the change has to be live: build, sync to the installed extension folder, reload the window. The running extension loads from `~/.<ide>/extensions/turnzero.switchboard-*/dist/`, not the dev repo's `dist/`.

### Manual — reproduce first

Reproduce on the current build, so the fix is measured against an observed failure.

8. Open `terminals.html`, run Claude Code in a pane, and give it a task long enough to produce well over 256 KB of output.
9. While it works, confirm the stuck state when it appears. In the panel devtools console: `document.querySelectorAll('.xterm').forEach(e => console.log(e.className))` — `enable-mouse-events` present is the cause. Cross-check against the public mode read on the same pane (`term.modes.mouseTrackingMode` — `'vt200'` for mode 1000) if the entry is reachable. Confirm the wheel does not scroll and a click does not clear a selection, while keystrokes still land.
10. Force the reattach path deterministically: swap the terminal out of its pane, wait past the 15-second detach grace, swap it back — with enough output since to have evicted the ring. Check the class again.

### Manual — confirm the fix

11. Repeat step 10 with the fix live. The class must match the app's actual state, and the wheel and click must behave accordingly.
12. Reattach while the app is *legitimately* in mouse mode: the class stays, the pill is visible, and Shift-wheel scrolls while a plain wheel still reaches the app. **This is the only runtime check for the item 6 wheel bypass.** The contract is documented (returning `false` suppresses the report and skips `preventDefault`) and the four documented ways native scroll can still be blocked were each checked against `terminals.html` and are all clear — but "the browser actually scrolls the viewport" is still a runtime outcome, so confirm it rather than assuming it.
13. Click the pill: the wheel and click come back immediately, the pill hides, and the app keeps running (no keystroke was sent to it).
14. Option-drag inside a mouse-mode app selects text. Then confirm the accepted loss from the same option: Option-**click** no longer repositions the shell prompt cursor (`altClickMovesCursor` is defaulted true and forced selection now wins). If that gesture turns out to matter more than expected, the exit is `altClickMovesCursor` — not reverting `macOptionClickForcesSelection`.
14b. **Mode 9 (X10) — the dead-button check.** Drive a pane into X10 tracking (`printf '\e[?9h'` into the pty, or any X10-era TUI), confirm the pill appears, and confirm clicking it *actually releases* — selection works again and the pill hides. Before the mode-9 fix the pill would appear and do nothing. Note the wheel keeps working throughout: X10 does not claim it, so this is the selection-only half of the bug.
15. Full panel reload (fresh view, full-ring replay) and a solo pop-out window: both end in the correct mode state.
16. Bracketed paste still survives a reattach — paste a multi-line block into a fresh view and confirm it arrives as one submission, not one per line. This is the mode whose application point moved, so it is the regression risk of item 3.
17. **Alt-screen cursor integrity — the item 3 corruption check, and the one a reviewer is most likely to skip.** Run a full-screen TUI (`htop`, or `git log` in its pager), **quit it** so the gateway records `1049:false`, keep working until the ring has evicted, then reattach. The pane must come back with the replayed scrollback intact and the prompt at the *bottom*: no cursor jump to the top of the viewport, no live output overwriting replayed history, no SGR colour reset. This is what the buffer gate exists for — without it this step shows a mangled pane on the *common* path, not a rare one.
18. Alt screen, mid-run: run a full-screen TUI, reattach **while it is still drawing**, and confirm the pane is usable and not blank. Then quit the TUI and confirm scrollback scrolls again.
19. Eviction/reconnect path: drive a terminal hard enough to trip backpressure eviction, let it auto-reconnect, and confirm no duplicated block, no gap, and correct mode state — this exercises the tail-replay window (`entry.lastSeq > 0`).
20. Both themes: toggle claudify and confirm the pill's amber is identical in both (the token is deliberately not redeclared in `body.theme-claudify`) and that it is legible against terminal output behind it.

---

## Completion Report

Implemented the full DEC private-mode restore on reattach. Generalised the gateway's single-mode `bracketedPasteModes`/`scanBracketedPasteMode` into a per-terminal `decModes` map of all tracked modes (9, 1000, 1002, 1003, 1004, 1006, 1049, 2004) with the carry-fragment guard preserved verbatim; the hello frame now carries the set as `modes` (omitted when unobserved) with `bracketedPaste` derived from the same record. In `terminals.js`, `applyServerModes` writes the recorded state to the parser AFTER the replay parse (via `writeReplay`'s callback, or inline when there is no replay), with `?1049l` buffer-gated on `term.buffer.active.type === 'alternate'` and `?1049h` never written. Added the `mouse-mode-release` pill (visible by state via a class-filtered `MutationObserver`, releases all mouse protocols including X10 mode 9 to the parser), `macOptionClickForcesSelection: true`, and a Shift-wheel bypass via `attachCustomWheelEventHandler`. Added the `--state-mouse-captured` token and `.mouse-mode-release` CSS in `terminals.html`. Files changed: `src/standalone/terminalWsGateway.ts`, `src/webview/terminals.js`, `src/webview/terminals.html`, `src/test/terminal-dec-mode-restore-contract.test.js` (new), `src/test/terminal-input-path-contract.test.js` (retargeted), `package.json`, `.github/workflows/integration-tests.yml`. Issues encountered: the plan's `as typeof TRACKED_DEC_MODES[number]` cast and `new Map<number, boolean>()` generics are TypeScript syntax that `new Function` cannot execute — the input-path contract harness now strips both in its body processing (gateway source keeps the type-explicit forms). All 12 new contract assertions and all 19 retargeted input-path assertions pass; the six sibling terminal contracts (answerback, scroll-affordance, flow-control, rename-rekey, solo-popout, focus-affordance) stay green unedited.

## Review Findings

One CRITICAL fixed in `src/webview/terminals.js:2637`: item 6's Shift-wheel bypass was inert in the only state it exists for — *Resolved Assumptions #2* ("xterm does not call `preventDefault()`") was verified against the viewport wheel listener only, and xterm's **second** listener, the one installed while mouse reporting is active, is `e => (report(e), this.cancel(e, true))` registered `{passive:false}` with `cancel(e,t){if(this.options.cancelEvents||t) return e.preventDefault(),e.stopPropagation(),!1}`, so `cancel` fires whatever the custom handler returns; `(ev) => !ev.shiftKey` suppressed the mouse report but not the `preventDefault`, leaving Shift-wheel a silent no-op (strictly worse than before — the app lost the report *and* the operator got no scroll). The handler now scrolls the viewport itself when `enable-mouse-events` is present (`.xterm-viewport.scrollTop` for `DOM_DELTA_PIXEL`, public `scrollLines`/`scrollPages` for LINE/PAGE, `deltaY || deltaX` because shift-wheel is rewritten to a horizontal delta on some platforms) and deliberately does **not** scroll in the mouse-reporting-off branch, where nothing prevents the default and a manual scroll would double the distance. One MAJOR fixed in `src/test/terminal-dec-mode-restore-contract.test.js:97`: the "1049 must be absent from `REARMABLE_DEC_MODES`" assertion regexed a slice that starts *at* `function applyServerModes(` while the declaration sits above it, so it could never fail — it now parses the declaration and a negative control (inserting 1049) confirms it bites; the wheel assertion was retargeted from `!ev.shiftKey` to the real mechanism. Everything else matched the plan and survived the regression sweep: no orphaned `bracketedPasteModes`/`scanBracketedPasteMode` references anywhere, single hello producer/consumer pair, all three teardown sites moved, the `?1049l` buffer gate and the never-write-`?1049h` rule intact, the pill/observer teardown at the required indent, and `applyServerModes`'s parser-direct write correctly bypassing `onWriteParsed` so the ack ledger is untouched. Verification run independently (no skip directive in dispatch): all nine terminal contracts green (dec-mode-restore 12/12, input-path 19/19, answerback 10/10, scroll-affordance 6/6, flow-control 16/16, rename-rekey 8/8, solo-popout 11/11, focus-affordance 11/11, pane-pinning 15/15), `node --check` clean, `compile-tests` (the CI tsc gate) exit 0, `npm run compile` green with only the three pre-existing optional-dep warnings, eslint 0 errors (4 pre-existing `curly` warnings outside this commit's hunks), and gate wiring confirmed in `.github/workflows/integration-tests.yml` for all nine scripts including the new one at `:360`. Remaining risks: manual steps 8–20 are unrun (every symptom here is invisible headless, and step 12 is now the runtime check for a *changed* implementation, not the shipped one), plus two accepted residuals — a live chunk parsed between the hello snapshot and the replay callback can carry a mode transition newer than the snapshot, which `applyServerModes` would then overwrite (narrow window, fails in the safe direction, self-heals on the next toggle), and `REARMABLE_DEC_MODES` replays modes in ascending numeric order so an app that set 1000 *then* 9 comes back on VT200 rather than X10 (the record carries no active-protocol ordering).

**Recommendation: Send to Coder** (Complexity 6 — two source files plus CSS, one new contract, one retargeted contract, one CI step; the risk is concentrated in the apply-after-replay ordering, the buffer-gated 1049 write, and the coupled `terminal-input-path` contract, all three pinned by tests. If the split in *Scope* is taken, Phase 1 ships at 6 and Phase 2 at 3 — Send to Intern for Phase 2.)

## Post-Ship Chrome Trim (2026-08-05, operator-directed)

The `mouse-mode-release` pill described above was **removed** — do not re-implement it from this plan. Its two justifications (cannot scroll, cannot select while an app captures the mouse) were both already solved by the other half of the same change: `macOptionClickForcesSelection: true` gives Option-drag selection, and the Shift-wheel bypass gives scrolling. What remained was the hypothetical of an app dying while still holding the mode — and because every TUI (Claude Code, vim, htop) enables mouse reporting on startup, the pill sat lit in the corner of essentially every pane, permanently. Removed: `attachMouseModeRelease` and its call site, the `mouseModeBtn`/`mouseModeObserver` entry fields and their teardown, the `.mouse-mode-release` CSS, the `--state-mouse-captured` token, and the three contract assertions that existed only to pin the pill (the mode-9 gateway-tracking/re-arm parity assertion survives, retargeted).

Same pass trimmed the sibling `accepts input` chip from the *input-affordance* plan: the live state now renders no chip, leaving only amber `connecting` and red `read-only`. Making the element conditional turned `refreshInputState`'s early-return-on-missing-chip into a live bug — it fires on socket transitions and is routinely handed a pane in the opposite state from the one holding a chip, so `live → connecting` would have silently skipped every disconnect. Both call sites now route through one `syncInputStateChip` writer that creates, updates and removes; a negative assertion pins the early-return out.

General principle for this panel, since two features in a row hit it: **chrome that reports the normal case is noise.** A state badge earns its pixels only in the states an operator must act on.
