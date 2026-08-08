# Completion Ring on Shell Rail Terminal Icons Burns Forever — the DONE Light Is a Sticky Flag With No Expiry and No Animation

## Goal

Make the green completion ring on a shell-rail terminal icon a **notification**: pulse once when the agent finishes, then fade out. Today it is a permanent border that stays lit indefinitely and can only be cleared by finding and clicking the right thing.

### Problem

When an agent completes, the rail paints a green ring around that terminal's icon:

```css
        .strip-term-btn.strip-term-done {
            border-color: #22c55e;
            box-shadow: 0 0 0 1px #22c55e inset, 0 0 6px rgba(34, 197, 94, 0.55);
        }
```
— `src/webview/shell.html:229-232`

That is a static rule with no animation and no timer. The ring persists for as long as the class is applied, and the class is applied for as long as the panel says the light is `done`.

### Root cause

The light is a pure function of an in-memory Map that nothing expires:

```js
            let light = 'active';
            if (t.status === 'exited') {
                light = 'exited';
            } else if (terminalBadges.has(t.friendlyName)) {
                light = 'done';
            }
```
— `src/webview/terminals.js:661-667`

`terminalBadges` is set by `handleAgentCompleted` (`:5072`) and deleted only by an explicit user action: seating the terminal via `assignToFocusedPane` (`:1780`), an inbound `focusTerminal` (`:593-594`), the `clearTerminalBadge` acknowledgement the pop-out path sends (`:612-613`), CLEAR ALL (`:4012-4013`), or the terminal being renamed/removed (`:3906-3908`, `:3969`, `:3984`). There is no TTL anywhere.

So the DONE state was designed as a **durable "you have not looked at this yet" flag**, and the rail renders that flag as an always-on ring. Two things follow, and both are the reported complaint:

1. It lasts until the user performs one specific gesture. If they read the terminal in the pop-out and close it, or read it in a pane they never clicked, the ring stays lit — the state tracks *acknowledgement*, not *having seen it*.
2. There is no obvious way to clear it. The rail click pops the terminal out (and does post `clearTerminalBadge`), but a user who just wants the ring gone has to guess that clicking the thing that opens a window is also the dismiss button.

The design intent behind the ring is recorded in its own comment — *"strictly MORE salient than the dot it replaces, which is the entire point of this change"* (`shell.html:219-228`). Salience was maximised by making it permanent. Permanent salience is noise.

### Why a CSS animation alone does not fix it

`renderTerminalSection` does `container.innerHTML = ''` and rebuilds **every** terminal button from scratch on every fleet-state push (`src/webview/shell.js:325-429`). Those pushes come from a 5-second poll (`terminals.js:3118-3128`) plus every `terminalsChanged` broadcast. A CSS animation attached to `.strip-term-done` therefore restarts on a brand-new element every five seconds — the ring would blink forever instead of burning forever, which is worse. The pulse has to be armed on the **transition into done**, which the shell cannot detect from the payload it receives today: `light: 'done'` on two consecutive pushes is indistinguishable from a fresh completion.

## Reconcile Before Building

**Land after `terminal-peek-temporary-fullscreen.md`** (feature *Terminals Pane: Groups, Peek, and Bulk Terminal Creation*, `9e7c314d`). That plan rewrites the same strip click handler in `shell.js` and rewrites `src/test/shell-terminal-strip.test.js` to a new contract; two agents editing that test file in parallel will collide, and the merge is not mechanical. Same file, same stream.

**Peek does not fix this, and does not make it moot.** Peek repoints the strip click at an in-window peek and requires that peeking clear the DONE badge (its §"The bug this will cause if missed" — the `clearTerminalBadge` arm exists because the pop-out path never reaches `assignToFocusedPane`). That preserves *clearing on an explicit gesture*, which is what already happens today. It adds no expiry, and it does not touch the CSS: the ring is still `border-color: #22c55e` with no animation, still driven by a Map with no TTL, and still burns until the operator performs the one gesture that dismisses it. The complaint is that the state is durable at all — that is untouched by Peek.

What changes if Peek lands first, and how to adapt:

- The strip click will call peek rather than `window.open`, but it will still clear the badge (Peek mandates it). The relay, the badge lifecycle and `postFleetStateToShell` are unchanged, so **every change in this plan applies verbatim**.
- `renderTerminalSection` will have been edited by Peek. The pulse gate goes in the same per-terminal loop; re-read the function before applying the diff below rather than pattern-matching on the current text.
- Peek's rewritten `shell-terminal-strip.test.js` must keep its badge-clear-ordering assertion (it is the guard on the "DONE light burns forever" regression). Add this plan's stamp/pulse contracts **alongside** it — do not replace the file wholesale, and do not let the assertion count drop.

If this must land first instead, keep the pulse gate in a clearly-marked block inside `renderTerminalSection` so Peek's rewrite of the click handler does not have to reason about it.

## Metadata

- **Complexity:** 3
- **Tags:** frontend, ui, ux, bugfix
- **Project:** Browser Switchboard

## User Review Required

None.

## Complexity Audit

**Routine (majority):**
- One counter and one Map in `terminals.js`; one extra field on the relay payload.
- A keyframes block and a one-shot `animation` declaration in `shell.html`.
- A Map lookup in the shell's render loop.

**Complex / risky (two items):**
1. **Every badge-delete site must also drop the stamp.** There are six of them (`:593`, `:612`, `:1780`, `:3969`, `:3984`, `:4013`) plus a rename that must *carry the stamp across* (`:3906-3908`). Missing one leaks a stamp for a name whose badge is gone — harmless for correctness (the shell only reads the stamp when the light is `done`) but it is exactly the kind of half-updated parallel Map that rots. Better: derive the stamp from the badge value instead of a second Map — see the design note below.
2. **Deciding what the rail means afterwards.** Once the ring fades, the rail no longer shows which terminal completed. This is the requested behaviour and it is safe **only** because the in-panel surfaces keep the durable record: the sidebar row still shows its `DONE` chip (`:1253-1257`) and the pane title still shows its badge (`:2506-2510`). Those are deliberately left alone. If they were also expired, a completion the operator missed would be unrecoverable.

**Design note — one Map, not two.** `terminalBadges` is `name -> string label` and every read is either `.has()` or renders `.get()` as text (`:1256`, `:2509`). Rather than adding a parallel stamp Map with six delete sites to keep in sync, store `{ label, stamp }` as the value and render `.label`. That makes the stamp impossible to leak — it dies with the badge — at the cost of touching the two render sites that display the value. Take that route.

## Edge-Case & Dependency Audit

- **Re-render storm.** The core trap: the shell rebuilds all buttons on every push. Solved by the stamp gate — the pulse class is applied only when the incoming `doneStamp` differs from the last one animated for that name.
- **The same terminal completes twice.** The badge may already be present when the second completion lands, so `light` never leaves `done` and a "did the light change" edge detector would miss it. A monotonically increasing stamp catches it: the second completion writes a higher stamp and the shell pulses again.
- **Shell reload while a badge is outstanding.** The shell's pulse map starts empty, so the first push after a reload pulses every currently-done terminal once. That is correct behaviour, not a bug: a fresh rail re-announces outstanding completions exactly once and then settles.
- **Terminal disappears from the fleet.** Prune pulse-map entries for names absent from the payload, so the map cannot grow across a long session of spawns and closes.
- **`exited` beats `done`.** The precedence in `postFleetStateToShell` is unchanged and `src/test/shell-terminal-strip.test.js:57-77` pins it (`done` must remain an `else if` of `exited`). Do not reorder while touching this function.
- **Solo pop-out windows.** `postFleetStateToShell` returns immediately when `window.parent === window` (`:660`), so a pop-out never relays and never pulses anything. Unaffected.
- **The pop-out acknowledgement path still matters.** `clearTerminalBadge` (`shell.js:406-414` → `terminals.js:604-617`) clears the sidebar/pane badges. It is not made redundant by the fade — the rail's ring is now transient, but the panel's chips are still the durable record and still need that dismissal. The same holds for whatever replaces it when Peek repoints the strip click: peek's badge clear is what keeps the panel's chips honest, and the fade neither substitutes for it nor conflicts with it.
- **`prefers-reduced-motion`.** A repeated pulse is exactly the kind of motion that rule exists for. Provide a reduced-motion variant: hold the ring steady, then fade — same total duration, same end state, no oscillation.
- **Colour is not the signal.** The existing comment (`shell.html:219-228`) is explicit that the ring is a *shape* so monochrome and deuteranopic viewers read it. A pulse keeps that property (the shape appears and disappears); a fade-to-nothing means the cue is now time-bound for everyone equally. Keep the hardcoded `#22c55e` and the reasoning comment — do not swap to `var(--accent)`, which is the rail's selection colour.
- **Persisted state.** None. `terminalBadges` is in-memory browser state that dies with the page; nothing here reaches a settings key, the DB, or disk. No migration per CLAUDE.md.
- **Contract test coupling.** `src/test/shell-terminal-strip.test.js` is a source-text test that reads `terminals.js`, `shell.js` and `shell.html` directly, with `block()` markers on `postFleetStateToShell` (start marker `function postFleetStateToShell() {`, end marker `const LAYOUTS = {`) and on `renderTerminalSection`. Both blocks change; the markers themselves stay valid.

## Proposed Changes

### 1. `src/webview/terminals.js` — give each completion a monotonic stamp

Badge value becomes an object (declaration at `:89`):

```js
    // name -> { label: string, stamp: number }
    //
    // The stamp is a monotonic completion sequence, relayed to the shell so its rail
    // can pulse the completion ring ONCE per completion. It lives on the badge value
    // rather than in a parallel Map so it cannot outlive the badge: there are six
    // badge-delete sites and a rename re-key, and a second Map would eventually drift
    // out of sync with all of them.
    const terminalBadges = new Map();
    let badgeStampSeq = 0;
```

`handleAgentCompleted` (`:5071-5077`):

```js
        if (targetTerm) {
            terminalBadges.set(targetTerm, { label: 'DONE', stamp: ++badgeStampSeq });
            renderSidebarList();
            renderPaneGrid();
            postFleetStateToShell();
```

The two sites that render the value as text — sidebar row (`:1254-1257`) and pane title (`:2507-2510`):

```js
            badge.textContent = terminalBadges.get(item.friendlyName).label;
```
```js
            badgeSpan.textContent = terminalBadges.get(assignedName).label;
```

The rename re-key (`:3906-3908`) already moves the whole value and needs no change — the stamp travels with it, which is the point of folding it into the value.

`postFleetStateToShell` (`:659-684`):

```js
        const terminals = fleetList.map(t => {
            let light = 'active';
            let doneStamp = 0;
            if (t.status === 'exited') {
                light = 'exited';
            } else if (terminalBadges.has(t.friendlyName)) {
                light = 'done';
                // Monotonic per completion. The shell rebuilds every rail button on
                // every push (5s poll + terminalsChanged), so `light === 'done'` twice
                // running cannot tell a fresh completion from a stale one. The stamp
                // can — and it also distinguishes a SECOND completion of a terminal
                // whose badge never cleared, which a plain edge detector would miss.
                doneStamp = terminalBadges.get(t.friendlyName).stamp;
            }
            /* …icon resolution unchanged… */
            return { name: t.friendlyName, role: t.role, worktreePath: t.worktreePath, light, doneStamp, iconUri };
        });
```

### 2. `src/webview/shell.js` — pulse once per stamp

Module state beside `popoutWindows` (`:203`):

```js
    // name -> the doneStamp whose pulse has already been played. renderTerminalSection
    // rebuilds every button from scratch on every fleet push, so a CSS animation on
    // `.strip-term-done` would restart every 5 seconds and blink forever. The ring
    // class is applied ONLY when the incoming stamp differs from the one recorded
    // here — i.e. exactly once per completion.
    const pulsedDoneStamps = new Map();
```

In `renderTerminalSection`, inside the per-terminal loop (`:330-333`):

```js
        const seenNames = new Set();
        for (const t of terminals) {
            seenNames.add(t.name);
            const isFreshDone = t.light === 'done'
                && pulsedDoneStamps.get(t.name) !== t.doneStamp;
            if (isFreshDone) { pulsedDoneStamps.set(t.name, t.doneStamp); }
            if (t.light !== 'done') { pulsedDoneStamps.delete(t.name); }

            const btn = document.createElement('button');
            // The done ring is a one-shot ANIMATION, not a state class: it plays on
            // the push that carries a new completion stamp and is simply absent on
            // every push after it. A terminal that completed a minute ago wears no
            // ring — the sidebar DONE chip and the pane badge in the Terminals panel
            // remain the durable record of an unacknowledged completion.
            btn.className = 'strip-icon strip-term-btn strip-term-' + t.light
                + (isFreshDone ? ' is-pulsing' : '');
```

and prune after the loop:

```js
        for (const name of Array.from(pulsedDoneStamps.keys())) {
            if (!seenNames.has(name)) { pulsedDoneStamps.delete(name); }
        }
```

`aria-label` continues to carry `[${t.light}]`, so the completion stays announced to a screen reader for as long as the panel holds the badge — the fade is visual only.

### 3. `src/webview/shell.html` — the ring becomes a one-shot pulse

Replace the static rule (`:229-232`), keeping the existing rationale comment above it and appending the change of intent:

```css
        /* …existing comment about #22c55e, shape-not-hue, zero layout shift…
           CHANGED: the ring is a NOTIFICATION, not a state. It pulses twice over
           ~2.2s and fades to nothing. It used to be a permanent border driven by
           terminalBadges, which has no expiry — so a completed agent ringed its icon
           until the operator performed one specific dismissal gesture, and a rail of
           long-running agents ended up permanently green. The durable record lives in
           the Terminals panel (sidebar DONE chip, pane badge), which is unchanged. */
        @keyframes strip-term-done-pulse {
            0%   { border-color: rgba(34, 197, 94, 0); box-shadow: 0 0 0 1px rgba(34, 197, 94, 0) inset, 0 0 0 rgba(34, 197, 94, 0); }
            8%   { border-color: #22c55e;             box-shadow: 0 0 0 1px #22c55e inset, 0 0 8px rgba(34, 197, 94, 0.75); }
            33%  { border-color: rgba(34, 197, 94, 0.35); box-shadow: 0 0 0 1px rgba(34, 197, 94, 0.35) inset, 0 0 2px rgba(34, 197, 94, 0.2); }
            58%  { border-color: #22c55e;             box-shadow: 0 0 0 1px #22c55e inset, 0 0 8px rgba(34, 197, 94, 0.75); }
            100% { border-color: transparent;        box-shadow: 0 0 0 1px rgba(34, 197, 94, 0) inset, 0 0 0 rgba(34, 197, 94, 0); }
        }
        .strip-term-btn.strip-term-done.is-pulsing {
            animation: strip-term-done-pulse 2.2s ease-out 1 both;
        }
        /* Reduced motion: same duration, same end state, no oscillation — hold the
           ring, then fade it. The cue is preserved; only the flashing is removed. */
        @media (prefers-reduced-motion: reduce) {
            @keyframes strip-term-done-pulse {
                0%, 60% { border-color: #22c55e; box-shadow: 0 0 0 1px #22c55e inset, 0 0 6px rgba(34, 197, 94, 0.55); }
                100%    { border-color: transparent; box-shadow: 0 0 0 1px rgba(34, 197, 94, 0) inset, 0 0 0 rgba(34, 197, 94, 0); }
            }
        }
```

Note the selector now requires `.is-pulsing`, so a `done` light with no fresh stamp paints nothing — which is what makes the ring transient.

### 4. `src/test/shell-terminal-strip.test.js` — pin the new contracts

Add, in the file's existing source-text style:

- The relay emits `doneStamp` and sources it from the badge value, so a badge delete cannot leave a stamp behind.
- `handleAgentCompleted` writes a **strictly increasing** stamp (`++badgeStampSeq`), so a second completion of an already-badged terminal re-pulses.
- `renderTerminalSection` applies `is-pulsing` only when `pulsedDoneStamps.get(name) !== t.doneStamp`, and records the stamp — asserting the gate exists, because without it the CSS animation restarts on every 5-second push.
- `shell.html` declares `@keyframes strip-term-done-pulse` and a one-shot `animation … 1 both`, and no longer declares a bare `.strip-term-btn.strip-term-done { border-color: #22c55e` rule (the permanence being removed).
- The existing precedence test (`exited` > `done` > `active`) still passes unchanged.

## Verification Plan

1. **Automated**
   - `node src/test/shell-terminal-strip.test.js` — new contracts pass, existing precedence and relay-origin contracts stay green.
   - `node src/test/terminal-solo-popout-contract.test.js` — the `clearTerminalBadge` relay path is untouched.
   - Grep for remaining `terminalBadges.get(` call sites and confirm each reads `.label`, not the raw value.
2. **Manual — the reported bug**
   - Run the standalone shell with at least one agent terminal in the rail. Dispatch a plan so `agentCompleted` fires for it.
   - **Expect:** the icon pulses green twice over ~2 seconds and returns to its normal unringed appearance.
   - Wait 30 seconds without clicking anything. **Expect:** the ring stays gone — it does not re-appear on the next 5-second fleet poll, and it does not blink.
3. **Manual — the durable record survives**
   - Open the Terminals panel. **Expect:** the sidebar row for that terminal still shows its `DONE` chip and the pane title still shows its badge, so the completion is still discoverable after the ring fades.
   - Click that terminal in the sidebar. **Expect:** the chip clears as before.
4. **Manual — repeat completion**
   - Without dismissing the badge, dispatch a second plan to the same terminal. **Expect:** the icon pulses again (a plain edge detector would not fire here — this is the case the stamp exists for).
5. **Manual — reload and churn**
   - Reload the shell while a badge is outstanding. **Expect:** exactly one pulse on the first push, then nothing.
   - Spawn and close several terminals. **Expect:** no visual artefacts, and no stale pulse entries (verify `pulsedDoneStamps.size` in devtools tracks the live fleet).
6. **Accessibility**
   - Enable **Reduce motion** at the OS level and re-run step 2. **Expect:** a steady ring that fades out after ~1.3 s with no flashing.
   - Confirm the button's `aria-label` still ends in `[done]` while the panel holds the badge.
