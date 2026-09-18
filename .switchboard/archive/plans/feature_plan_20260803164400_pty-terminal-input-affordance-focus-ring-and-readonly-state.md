# PTY Terminals: Make the Text-Entry Surface Visible — Real Focus Ring, Legible Caret, and an Honest Input-State Chip

## Goal

In the browser PTY Terminals panel (`src/webview/terminals.html` + `src/webview/terminals.js`), the text-entry surface of each terminal pane has no visual treatment. An operator looking at a grid of panes cannot tell **which pane their keystrokes will land in**, and cannot tell **whether typing is possible at all**. Make the typing target unmistakable and make the three input states (live / connecting / read-only) legible at a glance in every pane header.

### Problem analysis — root cause

There is no single bug here; there are four independent gaps that compound into "unstyled and unusable-looking".

**1. xterm deletes the browser's focus ring and nothing puts one back.**
`src/webview/vendor/xterm/xterm.css:46-49`:
```css
.xterm.focus,
.xterm:focus {
    outline: none;
}
```
The element that actually receives keystrokes is xterm's hidden helper textarea (`src/webview/vendor/xterm/xterm.css:61-76`: `opacity: 0; left: -9999em; width: 0`). It is deliberately invisible — that is correct and must not change. But the *host panel* is then solely responsible for drawing the "focus lives here" affordance, and `terminals.html` never does. The result is literally an unstyled text-entry area: the real input element is invisible by design, and the visible surface standing in for it has no focus state.

**2. The one accent that exists lies about focus.**
`terminals.html:570-573` styles `.terminal-pane.focused` with an accent border plus `box-shadow: inset 0 0 0 1px`. But `.focused` is **pane selection**, not keyboard focus:
- `renderPaneGrid()` (`terminals.js:1179`) stamps it from `focusedPaneIndex`, which initialises to `0` (`terminals.js:11`) — so pane 1 wears the accent from first paint whether or not the panel has focus.
- `setFocusedPane()` (`terminals.js:1149-1160`) is the only other writer, driven by `mousedown` on a pane (`terminals.js:1186`).
- **Nothing ever clears it on blur.** Click the sidebar, another panel iframe, or another window, and the accent border stays lit on a pane that will not receive a single keystroke.

So the panel's only focus-shaped signal is decoupled from where input actually goes — worse than no signal, because it is confidently wrong.

**3. The caret is the only remaining hint, and it is a weak one.**
`cursorBlink: true` and `theme.cursor = --accent-teal` are already set (`terminals.js:1877`, `terminals.js:279`), which is good. But:
- The caret is drawn by the **remote program**, not the panel. A full-screen TUI parks the cursor wherever it likes; there is no guarantee it sits at the visual bottom where an operator looks for a prompt.
- At `fontSize: 13` (`terminals.js:1878`) on `--term-surface` `#171717`, one cell is easy to lose in a 6- or 9-pane grid.
- `cursorInactiveStyle` is left at xterm 5.5.0's implicit default (`'outline'` — confirmed in the vendored bundle's `DEFAULT_OPTIONS`), so focused-vs-blurred is a hairline weight difference rather than a state change. `theme.cursorAccent` is unset, so the glyph under a block cursor is drawn in xterm's `#000000` default rather than the panel surface colour.

**4. "Or if input is even possible" is a real functional gap, not only cosmetics.**
- `term.onData` (`terminals.js:1919-1926`) sends **only** when `entry.ws.readyState === WebSocket.OPEN`. Every other state — `CONNECTING`, the reconnect backoff window (`ws.onclose` retries 500ms → 30s, `terminals.js:2040-2053`), `CLOSED` — **silently discards the keystroke**. Nothing is written to the terminal, nothing is logged, no chrome changes. The operator types into a void.
- `entry.term.options.disableStdin = true` is set on the `error` frame (`terminals.js:2024`) and the `exit` frame (`terminals.js:2032`). The accompanying `[Process Exited with code N]` line scrolls away with subsequent output. The pane header appends `(exited)` **only** when the independently-fetched fleet list reports it (`terminals.js:1202-1207`) — the `error` path never touches the header, so a terminal killed by a gateway error looks identical to a live one forever.

The fix is therefore: (a) drive the focus affordance from xterm's own real focus state rather than from pane selection, (b) make the caret unambiguous, (c) put a persistent input-state chip in every pane header, and (d) stop dropping keystrokes in silence.

### What the improve pass verified against source

Every runtime claim below was checked against the vendored xterm 5.5.0 bundle and the two panel files, not assumed:

| Claim | Verified |
| :--- | :--- |
| `Terminal.onFocus` / `Terminal.onBlur` are public API | `get onFocus(){return this._onFocus.event}get onBlur(){return this._onBlur.event}` in `vendor/xterm/xterm.js` |
| `cursorInactiveStyle` default is `'outline'` | `DEFAULT_OPTIONS={…cursorInactiveStyle:"outline"…}` in `vendor/xterm/xterm.js` |
| `cursorInactiveStyle: 'none'` is honoured by **all three** renderers | DOM: the style switch pushes `xterm-cursor-outline/block/bar/underline` and has **no** `none` case, so no cursor class is emitted. Canvas: `t && "none" !== t && this._cursorRenderers[t](…)` in `addon-canvas.js`. WebGL: `addon-webgl.js` matches the style string against `"outline"`/`"block"`/`"bar"`/`"underline"` explicitly, so `"none"` draws nothing. |
| `theme.cursorAccent` reaches the active renderer | present in `xterm.js` (DOM blink CSS + `.xterm-cursor-block`), `addon-canvas.js` (`cursorAccent.css`) and `addon-webgl.js` (`cursorAccent.rgba`) |
| `disableStdin` suppresses `onData` but leaves the helper textarea focusable | the only functional `disableStdin` reference is the early-return in `CoreService.triggerDataEvent`; nothing touches the textarea's `readOnly`/`disabled` |
| `src/test/terminal-input-path-contract.test.js:41-47` pins `entry.ws.send(encodeInputFrame(data))` and provides the `block()` helper (line 33) | read in full |
| `src/test/pty-route-surface-contract.test.js:266` pins `/dataset\.ptyHostOrigin/` | read |
| `body.is-solo` suppresses only `.terminals-sidebar`, `.layout-toolbar`, `.layout-fallback-banner`, `#empty-state` — never `.pane-header` | `terminals.html:793-807` |
| `.pane-grid` uses `gap: 4px` and `.terminal-pane` is opaque `background: var(--panel-bg)` (`#000000`) with `position: relative` and no `z-index` | `terminals.html:530-540`, `561-569`, `:root` at `23-43` |
| `color-mix(in srgb, …)` is already used throughout the file | `terminals.html:155`, `168`, `270`, `312`, `411`, `618` |

## Metadata

- **Complexity:** 6
- **Tags:** frontend, ui, ux, bugfix

> **Superseded:** **Complexity:** 4
> **Reason:** 4 is "routine single-file". This change touches two source files plus a new contract test, and its hard parts are not typing volume: a three-state machine that must stay honest across four socket transitions and an independently-fetched fleet list; a focus class whose lifetime straddles a DOM reparent; a CSS ring that must coexist with two other rules competing for the same `box-shadow` property on the same element (`.focused`, and `.pinned` from the sibling pinned-panes plan); and cursor behaviour that differs across three xterm renderers. That is textbook Mixed (5-6) — majority routine with two moderate, well-scoped risks.
> **Replaced with:** **Complexity:** 6 → route to **Coder**, not Intern.

## User Review Required

Four decisions the improve pass made on the plan's behalf. Each is a superseded callout in the body; veto any of them before dispatch.

1. **`cursorInactiveStyle: 'none'`, not `'outline'`.** The original plan set the option to the value xterm already defaults to, which changes nothing. `'none'` makes "only the focused pane shows a caret at all" true. **Trade-off:** you can no longer see where a background pane's cursor is parked. That is the point, but it is a visible behaviour change.
2. **The ring is an `outline`, not a `box-shadow`, and the 12px glow is dropped.** Avoids a three-way collision on the single `box-shadow` property (`.focused` / `.pinned` / `.has-caret`) and the glow being eaten by opaque grid neighbours across a 4px gap.
3. **The ring is state-aware.** A teal "type here" ring on a dead terminal repeats the exact sin the plan indicts `.focused` for. The pane element now carries an `is-input-*` class and the ring recolours with it.
4. **The drop notice fires once per disconnect episode, not every 3 seconds.** A rolling debounce still produces a wall of notices during a 30-second backoff.

Also confirm the scope call in **Complexity Audit → Scope assessment**: this stays one plan rather than splitting into ring / chip / drop-feedback.

## Complexity Audit

### Routine

- New CSS rules in `terminals.html`'s single `<style>` block. Additive; **no layout geometry changes** — colour, `outline` and `background` only. This is load-bearing: `.terminal-pane` is `border: 1px solid` (`terminals.html:564`) and every terminal container carries a debounced `ResizeObserver` (`terminals.js:1905-1917`), so any rule that changes a pane's content-box width fires a fit pass and a `{t:'resize'}` frame to the shared pty. `outline` does not participate in layout; `border-color` does not change width.
- A pane-header `<span>` built alongside the existing `.pane-index-chip` / `.pane-badge` spans in `renderPaneGrid()` — same pattern, same place (`terminals.js:1196-1215`).
- Two extra `theme` keys and one extra constructor option on the `new window.Terminal({...})` call.
- Two new `:root` colour tokens.

### Complex / Risky

1. **Focus class lifetime across `renderPaneGrid()` teardown.** `renderPaneGrid()` sets `paneGridEl.innerHTML = ''` (`terminals.js:1172`) and re-appends every live xterm container (`terminals.js:1266-1269`); line 1291 (`if (hadFocus) { focusPaneTerminal(focusedPaneIndex); }`) then re-focuses into the **new** pane element. Any handler that captures a pane element at wire-up time will write the class onto a detached node. Mitigation: resolve the pane element at *event* time, and on blur clear the class from **all** panes before the focus handler re-sets it on one.

   > **Superseded:** "Removing a focused node from the document blurs it, so xterm fires `onBlur` and drops its own `focus` class."
   > **Reason:** Chromium does **not** fire a `blur` event when the focused element is removed from the document — focus silently resets to `<body>`. (Firefox does; this panel runs in a Chromium webview, and either way the design must not depend on it.) The stated mechanism is therefore unreliable, and a plan whose correctness argument rests on it would be arguing from a false premise.
   > **Replaced with:** The reparent path is safe for a different reason: `innerHTML = ''` discards the old `.terminal-pane` elements outright, so the stranded class dies with the node, and the freshly-built pane starts clean. `focusPaneTerminal()` → `textarea.focus()` then fires a **real** native focus event (because `document.activeElement` is `<body>` by then), so `onFocus` runs and re-applies the class to the new pane. `clearCaretRing()` is retained as an idempotent belt-and-braces sweep for the cases where blur *does* fire (sidebar click, sibling iframe, window blur) — it is correct whether or not detach fires blur, which is precisely why the design must not care.

2. **The input-state chip must be re-derived, not cached.** The pane header is rebuilt on every `terminalsChanged` broadcast, every `agentCompleted` badge and every per-terminal clear. The chip must read live state (`entry.ws.readyState`, `entry.exited`, `entry.term.options.disableStdin`, and the fleet list) at render time, and be nudged out-of-band by the socket handlers — because a socket transition does not itself trigger a grid re-render.

3. **`term.onData` is pinned by a source-text contract test.** `src/test/terminal-input-path-contract.test.js:41-47` asserts the literal string `entry.ws.send(encodeInputFrame(data))` is present. The added not-OPEN branch must be an `else`, leaving that expression byte-identical.

4. **A second, easily-missed contract-test tripwire.** `terminal-input-path-contract.test.js:100-107` extracts the source region **between** `frame.t === 'inputThrottled'` and `frame.t === 'error'` and asserts it does **not** contain the string `disableStdin`. The new state-refresh call lands inside that region. The call itself is fine — but a *comment* there explaining why a throttled paste is not read-only must not use the word `disableStdin`. This is a source-text test: prose counts.

5. **Three rules, one `box-shadow` property, one element.** `.terminal-pane.focused` already uses `box-shadow: inset 0 0 0 1px` (`terminals.html:572`), and the sibling plan `feature_plan_20260803151813_pin-terminals-to-panes.md` adds `.terminal-pane.pinned` with `box-shadow: inset 3px 0 0` plus an explicit `.pinned.focused` combination rule, precisely because `box-shadow` does not merge across matching class rules. A third `box-shadow` claimant would require enumerating every class combination. See the superseded callout in §5 — the ring uses `outline` instead and the problem evaporates.

### Scope assessment (per the plan-sizing rule)

Borderline but **one plan**. There are four sub-changes, and the ring and the chip are arguably independently shippable — but they are not independent: after correction #3 both read from the *same* `is-input-*` class on the *same* pane element, and all four touch the same `<style>` block and the same two functions. Splitting would triple the merge surface against the sibling pinned-panes plan for zero delivery benefit. Recommendation: keep single. If you want it split anyway, the seam is (A) ring + caret and (B) chip + drop-feedback — cut it there, and note that (B) depends on (A)'s `is-input-*` class.

## Edge-Case & Dependency Audit

### Race Conditions

- **Socket transition vs grid render.** The chip is derived at render time but socket transitions do not render. If the nudge is only wired to `ws.onopen` / `error` / `exit` / `ws.onclose`, the **CONNECTING window opened by `connectTerminalSocket()` itself** has no nudge: on a reconnect, `entry.ws` is reassigned to a fresh CONNECTING socket at `terminals.js:1964` while the chip still reads teal. It happens to self-correct today because the *old* socket's `onclose` fires asynchronously after the reassignment and therefore re-derives against the new socket — correct by accident, and the accident breaks the moment a call site closes a socket without a handler. **Requirement:** the canonical nudge site is immediately after `entry.ws = ws;` in `connectTerminalSocket()` (`terminals.js:1964`); the four handler sites are additions, not the primary.
- **Reparent vs focus.** Covered in Complexity Audit §1. `hadFocus` is sampled *before* `innerHTML = ''` (`terminals.js:1170`), so the re-focus decision is made against pre-teardown state; the class follows the focus event, not the sample.
- **`focusPaneTerminal()` against a not-yet-built terminal.** Returns early on `!entry.term` (`terminals.js:1137`). `materializeTerminalView()` re-attempts focus at `terminals.js:1933-1935`. The focus handlers are wired inside `materializeTerminalView()`, so they cannot miss that window.

### Security

- No new network surface, no new message types, no new tokens, no new DOM injection point. All new text is set via `textContent` / `title`, never `innerHTML`. The `title` attribute carries a fixed label from a three-value enum, never a terminal name or pty output.
- The drop notice writes a **constant** string to the terminal buffer; no user or server data is interpolated into it, so it cannot smuggle an escape sequence.

### Side Effects

- **The pty must not be resized.** No rule may change a pane's content-box geometry (see Complexity Audit → Routine). `outline`, `outline-offset`, `border-color`, `background` and `box-shadow` are all layout-neutral; `border-width` and `padding` are not.
- **Local writes into the terminal buffer.** `notifyInputDropped()` writes a line the server did not send. This is not new — `terminals.js:2017`, `2019`, `2023`, `2027` and `2031` already do it — but it does mean a full-screen TUI's alternate-screen buffer gets a foreign line. Accepted, with the direct precedent being `[Disconnected — reconnecting…]` at `terminals.js:2027`, which fires in the same disconnected condition. The once-per-episode limit (see §4) bounds the damage to one line per outage.
- **A background pane loses its visible cursor** under `cursorInactiveStyle: 'none'`. Intended; called out in User Review Required.

### Dependencies & Conflicts

| Case | Handling |
| :--- | :--- |
| **Theme swap (cyber ↔ claudify)** | All new *accent* colours must be authored as `var(--accent-teal)` / `var(--term-surface)` / existing tokens, never literals. `body.theme-claudify` redeclares the whole accent family (`terminals.html:52-60`); a hardcoded `#00e5ff` would render cyan inside a terracotta panel. `applyThemeToAllTerminals()` (`terminals.js:2225-2235`, assignment at `2231`) reassigns `entry.term.options.theme` — the new `cursorAccent` key must live in `buildTerminalTheme()` so a live swap carries it. `cursorInactiveStyle` is a constructor **option**, not a theme key, so it is unaffected by a swap and needs no coverage there. |
| **Status colours are not accents** | Amber and red are semantic status, not brand accent, and must not track the theme. They still must not be inline literals (the plan's own rule). Resolution: two new `:root` tokens — `--state-connecting: #d7a03a;` and `--state-readonly: #f85149;` — declared once in `terminals.html:23-43` and **not** overridden in `body.theme-claudify`. `#f85149` already appears as a literal at `terminals.html:278`; that occurrence is out of scope, but the new token is the place a later cleanup would point it at. |
| **Solo pop-out mode (`body.is-solo`)** | Verified: `terminals.html:793-807` suppresses `.terminals-sidebar`, `.layout-toolbar`, `.layout-fallback-banner` and `#empty-state` — nothing touches `.pane-header`, so the chip renders. `init()` sets `effectiveLayout = '1'` and `paneAssignments = [soloTerminalName]` (`terminals.js:298-304`), so the non-terse chip form applies. Ring and chip both correct there. |
| **6- and 9-pane layouts** | `.pane-grid.layout-2x3 / .layout-3x3` shrink `.pane-header` to `padding: 2px 4px; font-size: 10px` (`terminals.html:548-552`) and already collapse the action labels to initials (`terminals.js:1225`). The chip must degrade to a dot-only form in these two layouts or it will push `.pane-title` (which is `text-overflow: ellipsis`, `terminals.html:553-559`) to nothing. `flex-shrink: 0` on the chip is mandatory — `.pane-title` is `display: flex; gap: 6px` (`terminals.html:661-670`) and the terminal name is an anonymous flex item that must be the thing that shrinks. |
| **Empty panes** | `.pane-empty-slot` (`terminals.js:1272-1275`) has no terminal and no socket. Render **no** chip and set **no** `is-input-*` class — an empty pane is not a read-only terminal, and a red chip there would be a false alarm. |
| **Pane focused before the terminal materialises** | `createTerminalView()` claims the map entry but defers construction until the container has a box (`terminals.js:1857-1868`); `focusPaneTerminal()` returns early on `!entry.term` (`terminals.js:1137`). `materializeTerminalView()` already re-attempts focus at `terminals.js:1933`. The focus handlers are wired inside `materializeTerminalView()`, so they cannot miss this — but the chip render path must tolerate `entry.term === null` and show `connecting`. |
| **Reconnect backoff** | `ws.onclose` (`terminals.js:2040-2053`) only re-dials when the fleet list still reports `status === 'active'`. If it does not re-dial, the socket stays `CLOSED` forever and the chip must read `read-only`, not a permanently amber `connecting`. Derive from `entry.exited` / fleet status / `readyState`, not from "a reconnect timer exists". |
| **`inputThrottled` frames** | These are informational and stdin **stays enabled** (`terminals.js:2013-2020`). Do not let a throttle notice flip the chip to read-only — a large paste in flight is a live terminal. Note the comment restriction in Complexity Audit §4. |
| **Read-only pane that still holds the caret** | `disableStdin` gates `CoreService.triggerDataEvent` only; the helper textarea stays focusable, so `onFocus` fires and the ring lights on a terminal that cannot accept a character. Handled by the state-aware ring (§5) — this is the single most important interaction in the change. |
| **Pinned-pane plan overlap** | `.switchboard/plans/feature_plan_20260803151813_pin-terminals-to-panes.md` adds `.terminal-pane.pinned { box-shadow: inset 3px 0 0 }` and an explicit `.pinned.focused` rule, and documents that `box-shadow` does not merge across two matching class rules. Using `outline` for the caret ring makes the two plans **orthogonal** — different property, no combination matrix, either order of landing works. Still note the file overlap (both edit the same `<style>` region near `terminals.html:561-573`) in the MR description. |
| **Selector order between `.focused` and `.has-caret`** | Both are `.terminal-pane.X` — identical specificity, so source order decides any property they share. After correction they share only `border-color`. `.has-caret` must be authored **after** `.focused`; state this in a code comment so a future alphabetiser does not silently invert the ring. |
| **Contract tests** | `src/test/terminal-input-path-contract.test.js` pins `entry.ws.send(encodeInputFrame(data))` (line 42), the `encodeInputFrame` block bounded by `function base64ToUtf8(` (lines 44-46), the `frame.t === 'out'` → `frame.t === 'hello'` block (line 52), and the `inputThrottled` → `error` region's absence of `disableStdin` (line 102). `src/test/pty-route-surface-contract.test.js:266` pins `dataset.ptyHostOrigin`. None of these strings may move or change. The full terminal set is six files: `terminal-input-path-contract`, `terminal-flow-control-contract`, `terminal-token-transport-contract`, `terminal-solo-popout-contract`, `terminal-operations-no-periodic-reopen`, `shell-terminal-strip` — plus `pty-route-surface-contract` and `pty-host-gating-contract`. No existing test asserts on `.terminal-pane`, `.pane-header` or `.pane-content` CSS, so the style block is unpinned today; the new file changes that. |
| **`:has()` avoidance** | A CSS-only `.terminal-pane:has(.xterm.focus)` would work in Chromium 105+/Safari 15.4+, but leaves the state unreadable to the JS that renders the header chip. Use an explicitly toggled class so one source of truth drives both the ring and the chip. |
| **Installed-extension propagation** | The running extension loads from its install folder, not this repo's `dist/`. After building, the change is only live once synced to the installed extension folder and the window reloaded. This is a verification step, not a code change. |

**Explicitly out of scope (do not build):** an input buffer/queue for keystrokes typed while disconnected. Replaying stale keystrokes into a shell after reconnect is dangerous (a half-typed command completed by a stray `\r`), and the gateway already owns queueing for the connected case via `inputThrottled` (`terminals.js:2013-2020`). The fix here is **feedback only** — tell the operator the keystroke did not land.

## Dependencies

- None — no upstream session dependencies. All state this change reads (`entry.ws`, `entry.exited`, `entry.term.options.disableStdin`, `fleetList`) already exists.

**Plan-level conflict (not a dependency):** `feature_plan_20260803151813_pin-terminals-to-panes.md` edits the same `terminals.html:561-573` region and the same `renderPaneGrid()` header block. After the `outline` correction the two are property-orthogonal and can land in either order; expect a textual merge conflict in the `<style>` block, not a behavioural one.

## Adversarial Synthesis

**Risk summary.** The load-bearing risk is dishonesty-by-construction: a ring driven purely off xterm focus lights teal on a `disableStdin` terminal, and a resolver that ignores `fleetList` contradicts the `(exited)` suffix printed two elements to its left in the same header — both reproduce the exact "confidently wrong signal" the plan was written to kill. Secondary risks are a chip that goes stale because the CONNECTING window has no nudge site, and a `box-shadow` ring colliding with the two other rules already claiming that property on `.terminal-pane`. Mitigations: a single `is-input-*` class on the pane element as the one source of truth for both ring and chip, a resolver that consults the fleet list, the canonical nudge placed at the `entry.ws = ws` assignment, `outline` instead of `box-shadow`, and a new source-text contract test that pins each of these because every one of them fails silently.

## Proposed Changes

### 1. `src/webview/terminals.html` — two status tokens

**Context.** `:root` at `terminals.html:23-43` is the panel's only palette declaration; `body.theme-claudify` (`52-60`) redeclares the accent family. The chip needs an amber and a red that must *not* follow the accent.

**Logic.** Declare them as `:root` tokens so the plan's own "no literals" rule holds, and deliberately do **not** override them in the claudify block — a connecting terminal is amber in both themes.

**Implementation.** In the `:root` block, after `--term-selection` (`terminals.html:42`):

```css
            /* Input-state chip. Semantic status, NOT brand accent — deliberately
               absent from body.theme-claudify so a connecting terminal reads amber
               in both themes. Tokens rather than literals so there is one place to
               change, per the no-literals rule the accent family already follows. */
            --state-connecting: #d7a03a;
            --state-readonly:   #f85149;
```

**Edge cases.** `#f85149` already appears as a literal at `terminals.html:278`; leave it — repointing it is a separate cleanup and would widen this diff into unrelated rules.

> **Superseded:** `.pane-input-state.is-connecting { color: #d7a03a; background: rgba(215, 160, 58, 0.12); }` and `.pane-input-state.is-readonly { color: #f85149; … }` — inline literals.
> **Reason:** The plan's own Edge-Case audit states "All new colours must be authored as `var(...)`, never literals", then authored two literals plus two hand-computed `rgba()` twins of them. Three places to change one colour, and the `rgba()` values silently drift from the hex if either is edited.
> **Replaced with:** `--state-connecting` / `--state-readonly` tokens in `:root`, consumed via `var()` + `color-mix(in srgb, … 12%, transparent)` for the tint — the same construction the file already uses at `terminals.html:155`, `168`, `270`, `312`, `411` and `618`.

### 2. `src/webview/terminals.js` — explicit caret options and theme keys

**Context.** `buildTerminalTheme()` (`terminals.js:269-282`) is the single source of xterm's palette and is re-run by `applyThemeToAllTerminals()` (`terminals.js:2225-2235`) on a live theme swap. The constructor is at `terminals.js:1876-1887`.

**Logic.** Two changes: `cursorAccent` so a block caret reads as a filled cell instead of a hole punched in the pane, and an explicit inactive-cursor style that actually differentiates focused from blurred.

**Implementation.** In `buildTerminalTheme()`:

```js
    return {
        // Must stay opaque — see the .terminals-main note in terminals.html.
        background: pick('--term-surface', '#171717'),
        foreground: pick('--text-primary', '#e0e0e0'),
        cursor: pick('--accent-teal', '#00e5ff'),
        // The character UNDER a block cursor. xterm defaults this to #000000,
        // which is not this panel's surface — the inverted glyph read as a hole
        // punched in the pane. Track the surface so the caret reads as a filled
        // cell, not a gap. Verified present in all three renderers (DOM blink
        // CSS, addon-canvas cursorAccent.css, addon-webgl cursorAccent.rgba).
        cursorAccent: pick('--term-surface', '#171717'),
        selectionBackground: pick('--term-selection', 'rgba(0, 229, 255, 0.3)'),
    };
```

In `materializeTerminalView()` (`terminals.js:1876-1887`):

```js
        const term = new window.Terminal({
            cursorBlink: true,
            // The caret is the only PER-CELL signal for "this pane has focus", and
            // xterm's default here is 'outline' — a hairline weight change that is
            // invisible at fontSize 13 in a 9-pane grid. 'none' turns it into a
            // real state change: exactly one pane in the grid shows a caret at all,
            // and that pane is the one taking keystrokes.
            //
            // Honoured by all three renderers: the DOM renderer's style switch has
            // no 'none' case so it emits no cursor class; addon-canvas guards with
            // `"none" !== t`; addon-webgl matches the style string against the four
            // drawn styles and falls through. Do not "tidy" this back to the
            // default value — it IS the fix, not documentation of the default.
            cursorInactiveStyle: 'none',
            fontSize: 13,
            fontFamily: resolveMonoFont(),
            theme: buildTerminalTheme(),
            scrollback: 1000,
        });
```

**Edge cases.** `cursorInactiveStyle` is a constructor option, not a `theme` key, so `applyThemeToAllTerminals()` does not need to carry it — and must not be extended to, or it would start reassigning non-theme options. `cursorAccent` *is* a theme key and is covered by living in `buildTerminalTheme()`.

> **Superseded:** `cursorInactiveStyle: 'outline'`, justified as "Explicit, not xterm's implicit default."
> **Reason:** `'outline'` **is** xterm 5.5.0's default (`DEFAULT_OPTIONS={…cursorInactiveStyle:"outline"…}` in the vendored bundle). The plan's own problem analysis §3 identifies the outline style as the reason focused-vs-blurred is "a hairline weight difference rather than a state change" — and then fixes it by setting that same value explicitly. Zero behaviour change; a checkbox that ticks itself. This is the plan passing its own success check while the stated goal ("make the caret unambiguous") stays unmet.
> **Replaced with:** `cursorInactiveStyle: 'none'` — verified honoured by the DOM, canvas and WebGL renderers. Pinning the default against an xterm upgrade is a real but separate concern, and the code comment plus the new contract test cover it.

### 3. `src/webview/terminals.js` — drive a pane class from xterm's real focus

**Context.** Still inside `materializeTerminalView()`, after `term.open(container)` (`terminals.js:1898`) and before `connectTerminalSocket(entry)` (`terminals.js:1928`).

**Logic.** `.focused` is pane *selection*; the ring must follow keyboard focus. Two non-obvious requirements from the Complexity Audit: resolve the pane at event time, and clear every pane on blur.

**Implementation.**

```js
        // The caret ring is driven from xterm's OWN focus state, not from
        // `focusedPaneIndex`. `.focused` is pane SELECTION — it is set on pane 0
        // at first paint and is never cleared when the document loses focus, so
        // it cannot answer "will my keystrokes land here?".
        //
        // Resolve the pane element inside the handler, never at wire-up time:
        // renderPaneGrid() blows away the grid and re-appends this container, so a
        // captured reference goes stale on the first rebuild.
        term.onFocus(() => {
            clearCaretRing();
            const paneEl = entry.container.closest('.terminal-pane');
            if (paneEl) { paneEl.classList.add('has-caret'); }
        });
        // Clear ALL panes, not the one that blurred. Chromium does not fire blur
        // when a focused node is detached, so a reparent leaves no blur to react
        // to (the class dies with the discarded pane element instead, and the
        // re-focus at renderPaneGrid's tail re-applies it). For the blurs that DO
        // fire — sidebar click, sibling iframe, window blur — closest() may still
        // resolve to an outgoing node, so a sweep is the only form that is correct
        // in every case. Idempotent and O(panes); a grid is nine elements.
        term.onBlur(() => clearCaretRing());
```

Add the helper next to `focusPaneTerminal()` (`terminals.js:1133-1139`):

```js
    /** Drop the caret ring from every pane. Paired with the onFocus handler in
     *  materializeTerminalView — see the note there for why blur cannot target a
     *  single pane. */
    function clearCaretRing() {
        paneGridEl.querySelectorAll('.terminal-pane.has-caret')
            .forEach(el => el.classList.remove('has-caret'));
    }
```

**Edge cases.** Clicking a pane-header button (`clear` / `hide`) moves DOM focus to the button, so the ring goes out while `.focused` stays. That is correct and honest — a `Space` at that moment activates the button, it does not reach the shell. `term.onFocus` / `term.onBlur` are public API on `Terminal` (verified: `get onFocus()` / `get onBlur()` in the vendored bundle).

### 4. `src/webview/terminals.js` — an honest input-state resolver, and one class per pane

**Context.** `renderPaneGrid()` builds the header title block at `terminals.js:1191-1215`; `fleetList` is what makes the header print `(exited)` at `terminals.js:1202-1207`.

**Logic.** One resolver, read live at every use. Its result is written to the **pane element** as an `is-input-*` class — that class is the single styling source for both the ring and the chip, so the two can never disagree. The chip element carries only text and a tooltip.

**Implementation — resolver.** Define it immediately before `refreshInputState()` (the contract test extracts the region between the two, so this order is required):

```js
    /**
     * Resolve what an operator can actually DO with this terminal right now.
     *
     * Derived, never stored: a socket transition does not re-render the grid, so a
     * cached value would go stale in exactly the situation the chip exists to
     * report. Order matters — a dead terminal whose socket happens to be OPEN is
     * read-only, not live.
     *
     * fleetList is consulted deliberately. It is what makes the header print
     * "(exited)" a few pixels to the chip's left (see renderPaneGrid), and
     * entry.exited is only ever set by an error/exit FRAME. A terminal that died
     * without a frame — host restart, socket cut before the exit arrived — would
     * otherwise have a title saying "(exited)" and a chip saying "accepts input"
     * in the same 22px header. Two sources of truth for "dead" in one header is
     * the exact dishonesty this chip exists to remove.
     */
    function resolveInputState(name) {
        const entry = terminalsMap.get(name);
        const fleetItem = fleetList.find(t => t.friendlyName === name);
        if (fleetItem && fleetItem.status === 'exited') {
            return { key: 'readonly', label: 'read-only' };
        }
        if (!entry) { return { key: 'connecting', label: 'connecting' }; }
        if (entry.exited || (entry.term && entry.term.options.disableStdin)) {
            return { key: 'readonly', label: 'read-only' };
        }
        if (entry.ws && entry.ws.readyState === WebSocket.OPEN) {
            return { key: 'live', label: 'accepts input' };
        }
        return { key: 'connecting', label: 'connecting' };
    }
```

**Implementation — render.** In `renderPaneGrid()`, inside the `if (assignedName) { ... }` title block, after the `pane-index-chip` append (`terminals.js:1196-1199`):

```js
                const state = resolveInputState(assignedName);
                // The class goes on the PANE, not the chip: it is the one source
                // of truth the ring and the chip both style off, so they cannot
                // drift apart. Empty panes get neither class nor chip.
                paneEl.classList.add(`is-input-${state.key}`);

                const stateEl = document.createElement('span');
                stateEl.className = 'pane-input-state';
                // 2x3 and 3x3 headers are 10px tall with an ellipsised title —
                // a word here eats the terminal name. Dot only, title attribute
                // carries the meaning.
                const terseHeader = effectiveLayout === '2x3' || effectiveLayout === '3x3';
                stateEl.textContent = terseHeader ? '' : state.label;
                stateEl.title = state.label;
                titleEl.appendChild(stateEl);
```

**Implementation — out-of-band refresh.** None of the socket transitions re-render the grid:

```js
    /** Repaint only the state class + chip for `name`. Cheaper than
     *  renderPaneGrid() and, more importantly, does not re-append any xterm — a
     *  grid rebuild during a socket transition would yank the caret out
     *  mid-keystroke. */
    function refreshInputState(name) {
        const paneIndex = paneAssignments.indexOf(name);
        if (paneIndex < 0) { return; }
        const paneEl = paneGridEl.querySelector(`.terminal-pane[data-pane-index="${paneIndex}"]`);
        if (!paneEl) { return; }
        const state = resolveInputState(name);
        paneEl.classList.remove('is-input-live', 'is-input-connecting', 'is-input-readonly');
        paneEl.classList.add(`is-input-${state.key}`);
        const chip = paneEl.querySelector('.pane-input-state');
        if (!chip) { return; }
        const terseHeader = effectiveLayout === '2x3' || effectiveLayout === '3x3';
        chip.textContent = terseHeader ? '' : state.label;
        chip.title = state.label;
    }
```

Call sites, in priority order:

1. **`connectTerminalSocket()`, immediately after `entry.ws = ws;` (`terminals.js:1964`) — the canonical one.** Every other site is a refinement of this one. Without it, the CONNECTING window a reconnect opens has no nudge at all, and the chip only self-corrects because the *old* socket's `onclose` happens to fire later — correct by accident.
2. `ws.onopen` (`terminals.js:1966-1973`) — CONNECTING → live.
3. The `error` branch (`terminals.js:2021-2024`) and the non-lagging `exit` branch (`terminals.js:2028-2033`) — → read-only. **Do not** add a refresh inside the `inputThrottled` branch with a comment mentioning `disableStdin`; see Complexity Audit §4.
4. `ws.onclose` (`terminals.js:2040-2053`) — live → connecting or read-only.

**Edge cases.** `entry.term === null` (deferred materialisation) short-circuits the `disableStdin` read via `entry.term &&` and lands on `connecting`. `refreshInputState` no-ops for an unassigned terminal (`indexOf` → `-1`). The `Lagging client evicted` exit reason does **not** set `entry.exited` (`terminals.js:2026-2027`), so it correctly reads as `connecting`, not `read-only`.

> **Superseded:** `resolveInputState(name)` deriving solely from `entry.exited` / `entry.term.options.disableStdin` / `entry.ws.readyState`, and `stateEl.className = 'pane-input-state is-' + state.key` putting the state class on the chip.
> **Reason:** Two defects. (a) Ignoring `fleetList` lets the same 22px header show `(exited)` in the title and `accepts input` in the chip — the plan's Edge-Case audit even names the case ("a terminal killed by a gateway error looks identical to a live one") and then leaves the fleet-list path out of the resolver. (b) A state class on the chip cannot be read by the ring, so the ring and the chip would need two independent writers and could disagree.
> **Replaced with:** the resolver consults `fleetList` first, and the class is written to the **pane element** as `is-input-*` — one writer, one class, both affordances styled off it.

### 5. `src/webview/terminals.html` — the styling

**Context.** Add to the `<style>` block immediately after the existing `.terminal-pane.focused` rule (`terminals.html:570-573`). Every accent colour is a token; the two status colours use the new tokens from §1.

**Logic.** The ring is an `outline`, not a `box-shadow`, and it recolours with the pane's input state so it never claims "type here" on a dead terminal.

**Implementation.**

```css
        /* `.focused` is pane SELECTION (see setFocusedPane) — it survives the
           document losing focus, so it can never mean "type here". Demote it to a
           quiet border and let .has-caret carry the real signal. Kept visible
           rather than deleted: .focused is also where a sidebar assignment lands,
           so the operator does still need to see it.
           ORDER MATTERS — .has-caret below shares border-color at equal
           specificity and must stay AFTER this rule. */
        .terminal-pane.focused {
            border-color: var(--border-bright);
        }

        /* Driven by xterm's own onFocus/onBlur. THIS is the typing target: the
           real input element is xterm's helper textarea, which is opacity:0 and
           parked at left:-9999em, and xterm.css:46 strips the browser focus ring
           off the terminal element. Nothing else in this panel draws one.

           outline, NOT box-shadow. Three reasons: (1) .terminal-pane.focused
           already claims box-shadow (inset 1px) and the pinned-panes plan claims
           it again (inset 3px 0 0) — one property, one winner, and a third
           claimant would need a rule per class combination; (2) outline is
           layout-neutral, so no ResizeObserver refit and no {t:'resize'} frame to
           the shared pty; (3) outline-offset:-1px draws the ring inside the pane
           box, so it cannot be clipped by the 4px .pane-grid gap or painted over
           by an opaque grid neighbour. */
        .terminal-pane.has-caret {
            outline: 1px solid var(--accent-teal);
            outline-offset: -1px;
            border-color: var(--accent-teal);
        }
        .terminal-pane.has-caret .pane-header {
            background: color-mix(in srgb, var(--accent-teal) 14%, var(--panel-bg2));
            color: var(--text-primary);
        }
        /* A focused pane that cannot take input must not wear the "type here"
           colour — that is the same lie .focused was demoted for. Recolour the
           ring to the state instead of hiding it: the caret really is there, it
           just has nowhere to go. */
        .terminal-pane.has-caret.is-input-connecting {
            outline-color: var(--state-connecting);
            border-color: var(--state-connecting);
        }
        .terminal-pane.has-caret.is-input-connecting .pane-header {
            background: color-mix(in srgb, var(--state-connecting) 14%, var(--panel-bg2));
        }
        .terminal-pane.has-caret.is-input-readonly {
            outline-color: var(--state-readonly);
            border-color: var(--state-readonly);
        }
        .terminal-pane.has-caret.is-input-readonly .pane-header {
            background: color-mix(in srgb, var(--state-readonly) 14%, var(--panel-bg2));
        }

        /* Input-state chip. Styled off the PANE's is-input-* class, not its own —
           see resolveInputState for why there is exactly one state writer. */
        .pane-input-state {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            font-size: 9px;
            font-weight: 600;
            letter-spacing: 0.4px;
            text-transform: lowercase;
            padding: 0 4px;
            border-radius: 2px;
            /* Mandatory: .pane-title is a flex row whose terminal name is an
               anonymous item, and the name is what must shrink, not the chip. */
            flex-shrink: 0;
        }
        .pane-input-state::before {
            content: '';
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: currentColor;
            flex-shrink: 0;
        }
        .is-input-live .pane-input-state {
            color: var(--accent-teal);
            background: color-mix(in srgb, var(--accent-teal) 12%, transparent);
        }
        .is-input-connecting .pane-input-state {
            color: var(--state-connecting);
            background: color-mix(in srgb, var(--state-connecting) 12%, transparent);
        }
        .is-input-readonly .pane-input-state {
            color: var(--state-readonly);
            background: color-mix(in srgb, var(--state-readonly) 12%, transparent);
        }
        /* Dot-only in the two dense layouts — the header is 10px with an
           ellipsised title and a word here would consume the terminal name. */
        .pane-grid.layout-2x3 .pane-input-state,
        .pane-grid.layout-3x3 .pane-input-state {
            padding: 0 2px;
            gap: 0;
        }
```

And **extend the existing `.pane-content` rule** at `terminals.html:679-682` rather than adding a second one:

```css
        .pane-content {
            flex: 1;
            position: relative;
            /* The terminal rectangle is painted --term-surface by xterm, but the
               8px .terminal-view-host gutter (terminals.html:359-367) fell through
               to the pane's --panel-bg (#000000), framing every terminal in a hard
               edge that read as chrome rather than as the typing surface. Carry the
               surface colour into the gutter. */
            background: var(--term-surface);
        }
```

**Edge cases.** `outline` follows `border-radius: 4px` in Chromium, which is what this panel runs in. `.terminal-pane { overflow: hidden }` (`terminals.html:566`) clips children, not the element's own outline. No rule here alters `border-width`, `padding` or `margin`, so no pane geometry moves.

> **Superseded:** `.terminal-pane.has-caret { border-color: var(--accent-teal); box-shadow: 0 0 0 1px var(--accent-teal), 0 0 12px color-mix(in srgb, var(--accent-teal) 35%, transparent); }`
> **Reason:** Three problems. (1) It is the **third** rule claiming `box-shadow` on `.terminal-pane` — `.focused` uses `inset 0 0 0 1px` (`terminals.html:572`) and the sibling pinned-panes plan adds `inset 3px 0 0`; only one declaration wins per element, so a pinned pane holding the caret would silently lose its pin stripe. The sibling plan documents this exact hazard. (2) The 12px outer glow is drawn *outside* the pane into a 4px `.pane-grid` gap (`terminals.html:533`) and every `.terminal-pane` is opaque `background: var(--panel-bg)` with `position: relative` and no `z-index` — later siblings paint over earlier siblings' shadows, so the halo would be visible up/left and eaten down/right. Asymmetric glow reads as a rendering bug. (3) A single teal ring is state-blind and lights on `disableStdin` terminals.
> **Replaced with:** `outline: 1px solid var(--accent-teal); outline-offset: -1px;` — a different CSS property, so zero contention with either `box-shadow` claimant; layout-neutral, so no pty refit; drawn inside the pane box, so nothing clips or overpaints it; and `outline-color` overridden per `is-input-*` state so the ring tells the truth.

> **Superseded:** A new standalone `.pane-content { background: var(--term-surface); }` rule.
> **Reason:** `.pane-content` already exists at `terminals.html:679-682`. A second rule for the same selector splits one element's styling across two places in the same stylesheet and invites a future editor to change one and miss the other.
> **Replaced with:** the `background` declaration added to the existing rule, with the rationale comment kept in place.

### 6. `src/webview/terminals.js` — stop discarding keystrokes in silence

**Context.** `term.onData` at `terminals.js:1919-1926`; the entry literal in `createTerminalView()` at `terminals.js:1821-1843`.

**Logic.** Add an `else` branch. **The `entry.ws.send(encodeInputFrame(data))` expression must stay byte-identical** — `src/test/terminal-input-path-contract.test.js:42` asserts on that literal string.

**Implementation.**

```js
        term.onData((data) => {
            if (entry.ws && entry.ws.readyState === WebSocket.OPEN) {
                if (!entry.largestInputDataLen) entry.largestInputDataLen = 0;
                if (data.length > entry.largestInputDataLen) entry.largestInputDataLen = data.length;
                entry.totalInputChars = (entry.totalInputChars || 0) + data.length;
                entry.ws.send(encodeInputFrame(data));
            } else {
                // The socket is CONNECTING, in reconnect backoff, or CLOSED. This
                // branch used to be an implicit no-op: the keystroke evaporated
                // with no echo, no log and no chrome change, which is the whole
                // "is input even possible?" complaint.
                //
                // Deliberately NOT queued. Replaying stale keystrokes into a shell
                // after a reconnect can complete a half-typed command with a stray
                // \r. Report, discard, move on.
                notifyInputDropped(entry);
            }
        });
```

With a once-per-outage reporter:

```js
    /** Tell the operator their keystroke went nowhere.
     *
     *  ONE notice per disconnect episode, not one per interval: a 30-second
     *  backoff window with a rolling timer still stacks ten identical lines into
     *  a TUI's screen buffer, and the tenth says nothing the first did not. The
     *  flag resets in ws.onopen, so the next outage reports again. The header chip
     *  is the PERSISTENT signal — this line only catches the operator who is
     *  looking at the terminal rather than the header. */
    function notifyInputDropped(entry) {
        refreshInputState(entry.name);
        if (entry.inputDropNoticed) { return; }
        entry.inputDropNoticed = true;
        try {
            entry.term.write('\r\n\x1b[33m[Not connected — keystroke discarded]\x1b[0m\r\n');
        } catch { /* ignore */ }
    }
```

Initialise `inputDropNoticed: false` in the entry literal in `createTerminalView()` (`terminals.js:1821-1843`), alongside the other per-entry counters, and clear it in `ws.onopen` next to the existing `entry.reconnectDelay = 500;` (`terminals.js:1967`):

```js
        ws.onopen = () => {
            entry.reconnectDelay = 500;
            // A fresh socket earns a fresh drop notice. Paired with
            // notifyInputDropped — see the note there.
            entry.inputDropNoticed = false;
            refreshInputState(entry.name);
            ...
```

**Edge cases.** `disableStdin = true` stops `onData` firing at all (verified: the only functional reference is the early return in `CoreService.triggerDataEvent`), so a read-only terminal never reaches this branch — the chip is its sole signal, which is why the chip is not optional. `entry.term` is guaranteed non-null here (the handler is registered on it), so the `try` is defence against a disposed terminal only.

> **Superseded:** `if (entry.lastInputDropNotice && now - entry.lastInputDropNotice < 3000) { return; }` — a 3-second rolling debounce keyed on `performance.now()`.
> **Reason:** `ws.onclose` backs off 500ms → 30s (`terminals.js:2040-2053`), so a disconnect can last minutes. A 3s window means a user who keeps typing gets a fresh `[Not connected]` line every three seconds, forever — ten lines into a full-screen TUI's buffer during one outage, each one identical. The plan's own framing ("a wall of identical notices is worse than none") argues against the mechanism it chose.
> **Replaced with:** a boolean `entry.inputDropNoticed` set on first drop and cleared in `ws.onopen`. One line per outage, and the chip carries the state for the whole outage.

### 7. `src/test/terminal-focus-affordance-contract.test.js` — new source-text contract

**Context.** Follow the existing pattern (`src/test/terminal-input-path-contract.test.js`): read the source files, assert structurally on the things that fail silently. Note that no existing test asserts on this panel's CSS at all.

**Logic.** Every failure mode in this change is silent by construction: a ring driven off the wrong state still renders, a dropped keystroke throws nothing, a resolver that skips `fleetList` looks right until a host restart, and `cursorInactiveStyle` reverting to the default is invisible in a diff review.

**Implementation.**

```js
'use strict';

/**
 * Source-text contract for the browser terminal INPUT AFFORDANCE.
 *
 * Every failure mode here is silent by construction: a focus ring driven off the
 * wrong state still renders, a dropped keystroke throws nothing, a chip derived
 * from a cached value looks correct until the socket moves, and an inactive
 * cursor style that reverts to xterm's default is invisible in review. Pin them.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const terminalsJs = fs.readFileSync(path.join(__dirname, '../webview/terminals.js'), 'utf8');
const terminalsHtml = fs.readFileSync(path.join(__dirname, '../webview/terminals.html'), 'utf8');

// test() and block() harness copied from terminal-input-path-contract.test.js.

test('the focus ring is driven by xterm focus, not by pane selection', () => {
    assert.ok(terminalsJs.includes('term.onFocus('), 'xterm onFocus must drive the ring');
    assert.ok(terminalsJs.includes('term.onBlur('), 'xterm onBlur must clear it');
    assert.ok(terminalsHtml.includes('.terminal-pane.has-caret'),
        '.has-caret is the real typing signal — .focused is selection and survives blur');
});

test('blur clears EVERY pane, not the one that blurred', () => {
    assert.ok(terminalsJs.includes('function clearCaretRing()'),
        'a sweep is the only form correct in every case — Chromium fires no blur on detach');
    assert.ok(/onBlur\(\(\)\s*=>\s*clearCaretRing\(\)\)/.test(terminalsJs),
        'onBlur must go through clearCaretRing, not a single-pane classList.remove');
});

test('the ring uses outline, not box-shadow', () => {
    const ring = block(terminalsHtml, '.terminal-pane.has-caret {', '}');
    assert.ok(ring.includes('outline:'),
        'box-shadow is already claimed by .focused and by .pinned; one property, one winner');
    assert.ok(!ring.includes('box-shadow'),
        'a third box-shadow claimant silently erases the pin stripe on a pinned focused pane');
});

test('the ring recolours for states that cannot take input', () => {
    assert.ok(terminalsHtml.includes('.terminal-pane.has-caret.is-input-readonly'),
        'a teal "type here" ring on a disableStdin terminal is the exact lie .focused was demoted for');
    assert.ok(terminalsHtml.includes('.terminal-pane.has-caret.is-input-connecting'),
        'same for a socket that is not open yet');
});

test('the inactive cursor style is none, so exactly one pane shows a caret', () => {
    assert.ok(/cursorInactiveStyle:\s*'none'/.test(terminalsJs),
        "'outline' is xterm 5.5.0's own default — setting it changes nothing");
});

test('keystrokes on a non-OPEN socket are reported, not swallowed', () => {
    assert.ok(terminalsJs.includes('notifyInputDropped(entry)'),
        'the else branch of term.onData must surface the drop');
    assert.ok(!terminalsJs.includes('entry.inputQueue'),
        'input must NOT be queued — replaying stale keystrokes can complete a half-typed command');
    assert.ok(terminalsJs.includes('entry.inputDropNoticed = false'),
        'the notice must reset on reconnect, or the second outage is silent');
});

test('the input-state chip is derived, never cached', () => {
    assert.ok(terminalsJs.includes('function resolveInputState('), 'resolver must exist');
    const resolver = block(terminalsJs, 'function resolveInputState(', 'function refreshInputState(');
    assert.ok(resolver.includes('entry.exited') && resolver.includes('disableStdin'),
        'read-only must cover BOTH the exit frame and the error frame');
    assert.ok(resolver.includes('fleetList'),
        'the title prints "(exited)" from fleetList — a chip that ignores it contradicts the title beside it');
    assert.ok(resolver.indexOf('entry.exited') < resolver.indexOf('WebSocket.OPEN'),
        'a dead terminal on an OPEN socket is read-only — order is load-bearing');
});

test('the CONNECTING window has a nudge site', () => {
    const connect = block(terminalsJs, 'function connectTerminalSocket(', 'function scheduleBatchFlush(');
    assert.ok(connect.includes('refreshInputState('),
        'a reconnect swaps in a CONNECTING socket without re-rendering the grid');
});

test('state colours are tokens, so one edit changes one place', () => {
    assert.ok(/--state-connecting:/.test(terminalsHtml) && /--state-readonly:/.test(terminalsHtml),
        'status colours must be :root tokens, not literals repeated as hex + rgba twins');
    assert.ok(!/\.is-input-live \.pane-input-state\s*\{[^}]*#00e5ff/.test(terminalsHtml),
        'the live state must use var(--accent-teal), not the literal cyan');
});
```

**Edge cases.** `block(terminalsJs, 'function resolveInputState(', 'function refreshInputState(')` requires the resolver to be defined **before** the refresher in source order — stated as a requirement in §4. `block(terminalsHtml, '.terminal-pane.has-caret {', '}')` requires the base rule to be the first `.has-caret` selector in the file, so author it before the `.is-input-*` combinations.

## Verification Plan

### Automated Tests

**Not run in this planning pass** — this session was directed to skip compilation and automated test execution. The list below is the pre-merge gate for whoever implements it.

1. `node src/test/terminal-focus-affordance-contract.test.js` — new file, all assertions pass.
2. The seven existing terminal/pty contract tests, unchanged; none may regress:
   `terminal-input-path-contract.test.js`, `terminal-flow-control-contract.test.js`, `terminal-token-transport-contract.test.js`, `terminal-solo-popout-contract.test.js`, `terminal-operations-no-periodic-reopen.test.js`, `pty-route-surface-contract.test.js`, `pty-host-gating-contract.test.js`.
   Two are at risk: `terminal-input-path-contract.test.js:42` pins the literal `entry.ws.send(encodeInputFrame(data))`, and its line 102 asserts the source region between `frame.t === 'inputThrottled'` and `frame.t === 'error'` contains no occurrence of the string `disableStdin` — including in comments.
3. Build the webview bundle. (Skipped in this pass per session directive; required before any manual step below.)

### Manual — focus affordance

4. Open the Terminals panel in the browser with the `2x2` layout and four live terminals. Exactly one pane wears the `has-caret` outline. Click each pane in turn: the ring follows the click, and typed characters appear in the ringed pane and no other.
5. Click the sidebar, then a different panel in the shell, then another browser tab. **The ring must go out every time** — this is the regression that `.focused` could not express. Click back into a pane: the ring returns.
6. With the caret in pane 2, trigger a grid rebuild (rename a terminal from the sidebar, or let an `agentCompleted` badge land). The ring must stay on pane 2 and typing must continue uninterrupted — this exercises the re-append path at `terminals.js:1266-1269` and the re-focus at `terminals.js:1291`.
7. Confirm exactly one caret is visible across the whole grid — the three unfocused panes must show **no** cursor at all. This is the `cursorInactiveStyle: 'none'` change and it is the second half of the "which pane takes my keystrokes" answer.
8. Switch to `3x3`. Ring still legible; the chip collapses to a dot and the terminal name is still readable in every header.
9. Click a pane's `clear` button. The ring goes out (focus is on the button) while the pane keeps its `.focused` border. Expected and correct — a `Space` there presses the button, it does not reach the shell.

### Manual — input state

10. Fresh pane: chip reads `connecting` (amber) until the socket opens, then `accepts input` (teal). While it reads `connecting`, click into that pane — the **ring must be amber, not teal**.
11. Kill the pty host process. The chip must go amber, and typing must produce `[Not connected — keystroke discarded]` **exactly once for the whole outage** — hold a key for ten seconds and confirm a second line never appears. Restart the host; after the socket reopens, kill it again and confirm a new notice *does* appear (the flag reset).
12. Exit a shell normally (`exit`). Chip goes red `read-only`; it stays red across a grid rebuild. Click into that pane: the ring is **red**, not teal — the caret is there, it just has nowhere to go.
13. Force the gateway `error` frame path. Chip goes red **without** the fleet list reporting `exited` — this is the case the header previously could not show at all.
14. Kill a terminal in a way that produces no `exit` frame (stop the pty host, then let the fleet list refresh to `exited`). The title's `(exited)` suffix and the chip must agree — both must say dead. This is the `fleetList` branch of the resolver.
15. Paste ~50KB into a live terminal to fire `inputThrottled`. The chip must stay teal `accepts input` throughout — a throttled paste is a live terminal.

### Manual — theme, layout and solo

16. Toggle cyber → claudify while panes are open. Ring, header tint and caret all become terracotta; nothing stays cyan. The amber and red chips must **stay** amber and red — they are semantic status, not accent. Confirm the caret glyph is legible (this is the `cursorAccent` change).
17. In `2x2`, confirm the ringed pane's outline is a complete, even rectangle on all four sides — no halo eaten by a neighbouring pane, no gap at the grid edge. (This is the failure mode the outer `box-shadow` glow would have produced.)
18. Resize the window with a pane focused and confirm no unexpected `{t:'resize'}` churn — none of the new rules touch `border-width` or `padding`, so a focus change must never trigger a fit pass.
19. Pop a terminal out solo (`body.is-solo`). The ring and the chip both render; the sidebar and layout toolbar stay hidden.

### Manual — installed extension

20. Sync the built webview assets into the installed extension folder and reload the window. Repeat steps 4, 5, 7 and 11 against the installed build — the dev-repo `dist/` is not what the running extension loads.

---

**Recommendation: Send to Coder** (complexity 6).

---

## Completion Report

Implemented the full PTY terminal input-affordance change. `src/webview/terminals.html`: added `--state-connecting` / `--state-readonly` `:root` tokens, demoted `.terminal-pane.focused` to a quiet border, added a state-aware `.has-caret` outline ring (recolours for `is-input-connecting` / `is-input-readonly`), added the `.pane-input-state` chip styling with dot-only collapse in 2x3/3x3, and extended `.pane-content` with `--term-surface` background. `src/webview/terminals.js`: added `cursorAccent` to `buildTerminalTheme()` and `cursorInactiveStyle: 'none'` to the constructor; added `clearCaretRing()` plus `term.onFocus`/`term.onBlur` handlers driving `.has-caret`; added `resolveInputState()` (consults `fleetList`), `refreshInputState()` (out-of-band nudge), and `notifyInputDropped()` (once-per-outage); wired the chip + `is-input-*` class in `updatePaneElement()`; added the `else` branch to `term.onData`; placed refresh nudges at the canonical `entry.ws = ws` site plus `onopen`/`error`/`exit`/`onclose`; initialised `inputDropNoticed: false` and reset it in `onopen`. New `src/test/terminal-focus-affordance-contract.test.js` (9 assertions) plus `package.json` script and CI workflow entry. All 12 terminal/pty contract tests pass; the pre-existing `terminal-operations-no-periodic-reopen` failure is unrelated (reads `implementation.html`, which this change does not touch). No issues encountered.

## Review Findings

Reviewed against the plan with regression tracing; two MAJOR defects found and fixed. (1) `terminals.html:761` — `.terminal-pane.pinned.focused` still declared `inset 0 0 0 1px var(--accent-teal)`, so selection kept painting a teal focus-shaped ring on any pinned pane, the exact lie `.focused` was demoted for; its selection component is now `var(--border-bright)`. (2) The plan's focus-class-lifetime argument ("the class dies with the discarded pane element") was invalidated by the in-place `renderPaneGrid` rewrite that landed since planning — panes are now *reused*, so a `.has-caret` stranded by a detached container (Chromium fires no blur on detach, and the focus reclaim early-returns when the focused slot is the one that emptied) left an **empty** pane wearing the teal ring; added an idempotent post-reclaim sweep at `renderPaneGrid`'s tail plus corrected comments, and pinned both fixes with two new contract assertions (11 total). Also folded `refreshInputState`'s inline terse check into the existing `isTerseLayout()`. Files changed by review: `src/webview/terminals.html`, `src/webview/terminals.js`, `src/test/terminal-focus-affordance-contract.test.js`. Verification: all 15 terminal/pty contract tests pass, eslint clean, `npm run compile` succeeds, `tsc` shows only 5 pre-existing unrelated TS2835 errors; **remaining risks** — the `(no longer listed)` fleet case is still unhandled by `resolveInputState` (plan-specified resolver, deferred), `terminal-operations-no-periodic-reopen.test.js` is named in the plan's gate but has no `package.json` script or CI step and fails today for unrelated reasons (pre-existing, not wired by this pass), and the 20 manual/installed-extension checks were not executed.
