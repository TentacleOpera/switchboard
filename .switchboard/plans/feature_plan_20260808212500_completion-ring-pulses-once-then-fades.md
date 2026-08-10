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

`terminalBadges` is set by `handleAgentCompleted` (`:5070`) and deleted only by an explicit user action: seating the terminal via `assignToFocusedPane` (`:1780`, `:1866-1867`), an inbound `focusTerminal` (`:593-594`), the `clearTerminalBadge` acknowledgement the pop-out path sends (`:612-613`), CLEAR ALL (`:4012-4013`), a single-terminal clear (`:3984`), or the terminal being renamed/removed (`:3906-3908`, `:3969`). There is no TTL anywhere.

So the DONE state was designed as a **durable "you have not looked at this yet" flag**, and the rail renders that flag as an always-on ring. Two things follow, and both are the reported complaint:

1. It lasts until the user performs one specific gesture. If they read the terminal in the pop-out and close it, or read it in a pane they never clicked, the ring stays lit — the state tracks *acknowledgement*, not *having seen it*.
2. There is no obvious way to clear it. The rail click pops the terminal out (and does post `clearTerminalBadge`), but a user who just wants the ring gone has to guess that clicking the thing that opens a window is also the dismiss button.

The design intent behind the ring is recorded in its own comment — *"strictly MORE salient than the dot it replaces, which is the entire point of this change"* (`shell.html:219-228`). Salience was maximised by making it permanent. Permanent salience is noise.

### Why a CSS animation alone does not fix it

`renderTerminalSection` does `container.innerHTML = ''` and rebuilds **every** terminal button from scratch on every fleet-state push (`src/webview/shell.js:274-430`). Those pushes come from a 5-second poll (`terminals.js:3118-3128`) plus every `terminalsChanged` broadcast. A CSS animation attached to `.strip-term-done` therefore restarts on a brand-new element every five seconds — the ring would blink forever instead of burning forever, which is worse. The pulse has to be armed on the **transition into done**, which the shell cannot detect from the payload it receives today: `light: 'done'` on two consecutive pushes is indistinguishable from a fresh completion.

### Why "arm once" is also not enough — the truncation trap (added by this pass)

Arming the pulse on the transition fixes the blinking. It does **not** survive the rebuild that caused the blinking in the first place. The element carrying the running animation is destroyed by the next `container.innerHTML = ''`, and its replacement — correctly judged "already pulsed" — is built with no ring. The pulse is cut short, and on the most important path it is cut to **zero frames**:

- `handleAgentCompleted` (`terminals.js:5069-5079`) sets the badge and calls `postFleetStateToShell()` immediately (push #1 — arms the pulse), and then, when the completed terminal is not yet in `fleetList`, calls `fetchTerminalList()`, which relays again (`terminals.js:833`) a few hundred milliseconds later (push #2 — rebuilds the button with no ring).
- Independently, the 5-second fleet poll (`terminals.js:3118-3128`) and every `terminalsChanged` broadcast each rebuild the rail. Against a 2.2 s animation, roughly half of all completions are interrupted even on the happy path.

So the mechanism must not only *arm* the pulse once per completion — it must **resume** it across rebuilds. That is the core correction this pass makes; see the Superseded callout in Proposed Changes §2.

## Metadata

- **Complexity:** 5
- **Tags:** frontend, ui, ux, bugfix
- **Project:** Browser Switchboard

> **Superseded:** **Complexity:** 3
> **Reason:** The original score assumed a one-Map + one-CSS-rule change. The real change spans three source files plus a fourth (the contract test), requires a resume-across-rebuild mechanism rather than a boolean flag, changes a relay payload shape that an existing test pins with `deepStrictEqual`, and invalidates two currently-passing assertions in `shell-terminal-strip.test.js`. That is squarely "multi-file changes, moderate logic".
> **Replaced with:** **Complexity:** 5

## User Review Required

None.

## Complexity Audit

### Routine

- One counter and one Map value-shape change in `terminals.js`; one extra field on the relay payload.
- A keyframes pair and a one-shot `animation` declaration in `shell.html`, plus a `prefers-reduced-motion` `animation-name` override.
- Two `terminalBadges.get(...)` render sites change from raw value to `.label`.

### Complex / Risky

1. **The pulse must survive the rail rebuild.** This is the load-bearing risk and the one the first draft missed. `renderTerminalSection` destroys and recreates every button on every push, including a push that can land ~200 ms after the completion push. A boolean "already pulsed" ledger silently truncates the animation; the ledger must record a **start timestamp** and re-apply the class with a negative `animation-delay` until the window expires. See §2.
2. **Two existing contract assertions go red.** `src/test/shell-terminal-strip.test.js:102-106` pins the relay payload field set with `deepStrictEqual` (adding `doneStamp` fails it), and `:303-309` matches `/\.strip-term-btn\.strip-term-done\s*\{/` (appending `.is-pulsing` to the selector fails it). Both must be rewritten **in the same change**, not discovered at review time.
3. **The relay payload test parses source text line-by-line.** `block(relay, 'return {', '};')` drops the first line and reads one field name per line. Collapsing the returned object literal onto a single line yields an empty field list and fails the assertion regardless of correctness. The multi-line object literal is load-bearing formatting.
4. **Deciding what the rail means afterwards.** Once the ring fades, the rail no longer shows which terminal completed. This is the requested behaviour and it is safe **only** because the in-panel surfaces keep the durable record: the sidebar row still shows its `DONE` chip (`:1253-1257`) and the pane title still shows its badge (`:2506-2510`). Those are deliberately left alone. If they were also expired, a completion the operator missed would be unrecoverable.

**Design note — one Map, not two.** `terminalBadges` is `name -> string label` and every read is either `.has()` or renders `.get()` as text (`:1256`, `:2509`). Rather than adding a parallel stamp Map with **seven** delete sites to keep in sync, store `{ label, stamp }` as the value and render `.label`. That makes the stamp impossible to leak — it dies with the badge — at the cost of touching the two render sites that display the value. Take that route.

> **Superseded:** "There are six of them (`:593`, `:612`, `:1780`, `:3969`, `:3984`, `:4013`)."
> **Reason:** Miscount. `grep -n "terminalBadges" src/webview/terminals.js` returns **seven** delete sites: `:594`, `:613`, `:1780`, `:1867`, `:3969`, `:3984`, `:4013`. `assignToFocusedPane` owns two of them, which `shell-terminal-strip.test.js:187-193` explicitly pins (`clears === 2`). The miscount does not change the chosen design — it strengthens the case for it — but a plan that names the sites must name them correctly.
> **Replaced with:** Seven delete sites, two of which live in `assignToFocusedPane`. The one-Map design means none of them need editing.

## Edge-Case & Dependency Audit

### Race Conditions

- **Re-render storm — arming.** The shell rebuilds all buttons on every push. Solved by the stamp gate: the pulse is *armed* only when the incoming `doneStamp` differs from the last one recorded for that name.
- **Re-render storm — truncation.** A rebuild landing inside the 2.2 s window destroys the animating element. Solved by the elapsed-time resume (`animation-delay: -<elapsed>ms`), not by the stamp gate. These are two distinct failures with two distinct fixes; the stamp gate alone leaves the second one live.
- **Completion push immediately followed by a list refetch.** `handleAgentCompleted` relays, then conditionally calls `fetchTerminalList()` which relays again (`:833`). With resume, push #2 continues the pulse instead of killing it.
- **The same terminal completes twice.** The badge may already be present when the second completion lands, so `light` never leaves `done` and a "did the light change" edge detector would miss it. A monotonically increasing stamp catches it: the second completion writes a higher stamp, which resets `startedAt` and pulses again.
- **Shell reload while a badge is outstanding.** The shell's ledger starts empty, so the first push after a reload pulses every currently-done terminal once. That is correct behaviour, not a bug: a fresh rail re-announces outstanding completions exactly once and then settles.
- **Terminal disappears from the fleet.** Prune ledger entries for names absent from the payload. Note the two **early returns** in `renderTerminalSection` (the `!frames.has('terminals')` gate and the empty-`terminals` guard at `shell.js:326-328`) run *before* any prune loop, so both must clear the ledger explicitly or it retains entries for a fleet that went to zero.
- **A resume offset at or past the duration flashes the end state.** Confirmed engine behaviour (see Resolved Assumptions): with `animation-fill-mode: both`, an `animation-delay` whose magnitude is ≥ the duration puts the animation immediately into its post-active phase, so the element paints the 100% keyframe for one frame and queues `animationstart` + `animationend` in the same sample. The `elapsed < DONE_PULSE_MS` guard is what prevents that — it is a correctness gate, not tidiness. `pulseElapsed` must never be allowed to reach `DONE_PULSE_MS`.
- **`exited` beats `done`.** The precedence in `postFleetStateToShell` is unchanged and `src/test/shell-terminal-strip.test.js:58-77` pins it (`done` must remain an `else if` of `exited`). Do not reorder while touching this function.

### Security

- No new message types, no new origins, no new network surface. The relay keeps its `location.origin` target and the shell keeps its `event.origin !== location.origin` guard (`shell.js:507`), both pinned by existing tests. `doneStamp` is a locally-generated integer, never rendered as text and never used in a selector or URL.

### Side Effects

- **Solo pop-out windows.** `postFleetStateToShell` returns immediately when `window.parent === window` (`:659-660`), so a pop-out never relays and never pulses anything. Unaffected.
- **The pop-out acknowledgement path still matters.** `clearTerminalBadge` (`shell.js:406-414` → `terminals.js:604-617`) clears the sidebar/pane badges. It is not made redundant by the fade — the rail's ring is now transient, but the panel's chips are still the durable record and still need that dismissal.
- **Background-tab completions.** A completion that lands while the cockpit tab is hidden burns its whole window unwatched — confirmed: the document timeline keeps advancing while hidden, but frame sampling and repaint are suspended, so the animation *completes invisibly* and the element is caught up to its end state on the first foreground frame. The ledger is therefore cleared on `visibilitychange → visible`, so the next push re-announces any still-outstanding completion exactly once. This is a genuine fix, not a mask. Consequence to accept knowingly: an operator who tabs away and back repeatedly while a `DONE` badge is un-acknowledged sees the pulse again on each return. That is the correct trade — the badge genuinely is still unacknowledged — and it is bounded at one 2.2 s pulse per return.
- **Occlusion coverage is engine-dependent.** Chromium and WebKit drive `visibilitychange` from native window-occlusion trackers, so a cockpit window fully buried behind another application is treated as hidden and the re-arm covers it. Gecko has no equivalent occlusion path, so on Firefox a fully-occluded-but-not-minimised window stays `visible` and can burn a pulse the operator never sees. Unfixable from the page and not worth chasing: the sidebar `DONE` chip and pane badge remain the durable record, which is exactly the fallback this case exists for. Do not add a heuristic for it.
- **The resume mechanism depends on the rail genuinely recreating nodes.** Engines do not coalesce animations across distinct DOM elements, so `container.innerHTML = ''` + `document.createElement('button')` yields a brand-new animation that honours the negative delay — which is what makes resume work. If the rail is ever converted to reconcile buttons in place (a reasonable future refactor), setting `style.animationDelay` on a *retained* element **mutates the running animation** instead of starting a fresh one, and the resume path changes meaning silently. Anyone doing that refactor must revisit this block; the existing test pinning `container.innerHTML = ''` (`shell-terminal-strip.test.js:398-410`) is the tripwire.
- **Nothing here depends on `animationend`.** Deliberate: that event is deferred while the document is hidden and then flushed on the first foreground frame, so any teardown keyed to it would fire late and in a burst. Expiry is decided entirely by the elapsed-time comparison in the render loop.
- **`prefers-reduced-motion`.** A repeated pulse is exactly the kind of motion that rule exists for. Provide a reduced-motion variant: hold the ring steady, then fade — same total duration, same end state, no oscillation.
- **Colour is not the signal.** The existing comment (`shell.html:219-228`) is explicit that the ring is a *shape* so monochrome and deuteranopic viewers read it. A pulse keeps that property (the shape appears and disappears); a fade-to-nothing means the cue is now time-bound for everyone equally. Keep the hardcoded `#22c55e` and the reasoning comment — do not swap to `var(--accent)`, which is the rail's selection colour.
- **`aria-label` is unchanged** and still carries `[${t.light}]`, so a screen-reader user querying the button still hears `done` for as long as the panel holds the badge. The fade is visual only. Note this is not an *announcement* — nothing here fires a live region, and nothing did before.
- **Persisted state.** None. `terminalBadges` is in-memory browser state that dies with the page; nothing here reaches a settings key, the DB, or disk. No migration per CLAUDE.md.

### Dependencies & Conflicts

- **Contract test coupling.** `src/test/shell-terminal-strip.test.js` is a source-text test that reads `terminals.js`, `shell.js` and `shell.html` directly, with `block()` markers on `postFleetStateToShell` (start `function postFleetStateToShell() {`, end `const LAYOUTS = {`) and on `renderTerminalSection` (start `function renderTerminalSection(terminals) {`, end `function renderManifest(manifest) {`). Both blocks change; the markers themselves stay valid.
- **`terminal-solo-popout-contract.test.js:139`** uses `function postFleetStateToShell()` as an *end* marker only. Unaffected as long as that signature is not renamed.
- No other test in `src/test/` references `terminalBadges`, `strip-term-*`, `postFleetStateToShell` or `renderTerminalSection`.
- **`DONE_PULSE_MS` in `shell.js` must equal the animation duration in `shell.html`.** They live in different files and nothing but a test can keep them honest — pin it (see §4).

## Dependencies

- None — no upstream session or plan gates this work. All four touched files are self-contained browser assets already shipped in the standalone shell.

## Adversarial Synthesis

**Risk summary.** The dominant risk is not the ring turning on, it is the ring being *destroyed mid-pulse*: the rail rebuilds every button on every fleet push (5 s poll, `terminalsChanged`, and a second push ~200 ms after the completion itself), so a plain arm-once gate produces a pulse the operator frequently never sees. Secondary risks are two already-passing assertions in `shell-terminal-strip.test.js` that this change makes red (the `deepStrictEqual` payload field set and the bare `.strip-term-done` selector regex), and a source-text test that breaks if the relay's returned object literal is reformatted onto one line. Mitigations: record a pulse *start timestamp* and resume with a negative `animation-delay` rather than tracking a boolean; clear the ledger in both early-return branches and on `visibilitychange`; rewrite the two assertions and pin `DONE_PULSE_MS` against the CSS duration in the same change; keep the object literal multi-line.

## Proposed Changes

### 1. `src/webview/terminals.js` — give each completion a monotonic stamp

Badge value becomes an object (declaration at `:89`):

```js
    // name -> { label: string, stamp: number }
    //
    // The stamp is a monotonic completion sequence, relayed to the shell so its rail
    // can pulse the completion ring ONCE per completion. It lives on the badge value
    // rather than in a parallel Map so it cannot outlive the badge: there are seven
    // badge-delete sites and a rename re-key, and a second Map would eventually drift
    // out of sync with all of them.
    const terminalBadges = new Map();
    let badgeStampSeq = 0;
```

`handleAgentCompleted` (`:5069-5074`):

```js
        if (targetTerm) {
            terminalBadges.set(targetTerm, { label: 'DONE', stamp: ++badgeStampSeq });
            renderSidebarList();
            renderPaneGrid();
            postFleetStateToShell();
```

`++badgeStampSeq` is unconditional — a second completion of an already-badged terminal must write a *higher* stamp, or the rail cannot tell it apart from the first.

The two sites that render the value as text — sidebar row (`:1253-1257`) and pane title (`:2506-2510`):

```js
            badge.textContent = terminalBadges.get(item.friendlyName).label;
```
```js
            badgeSpan.textContent = terminalBadges.get(assignedName).label;
```

These are the **only** two `.get()` reads that consume the value as text; the third (`:3907`, the rename re-key) moves the whole value and needs no change — the stamp travels with it, which is the point of folding it into the value. No `.delete()` / `.has()` / `.clear()` site changes.

`postFleetStateToShell` (`:659-690`):

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
            return {
                name: t.friendlyName,
                role: t.role,
                worktreePath: t.worktreePath,
                light,
                doneStamp,
                iconUri
            };
        });
```

> **Superseded:** the returned literal written inline as `return { name: t.friendlyName, role: t.role, worktreePath: t.worktreePath, light, doneStamp, iconUri };`
> **Reason:** `shell-terminal-strip.test.js:92-124` extracts the payload field names by splitting that block on newlines, dropping the first line, and matching `^(\w+)` per line. A single-line literal yields an empty field list and fails `deepStrictEqual` no matter how correct the code is. The current multi-line form is load-bearing.
> **Replaced with:** the multi-line object literal shown above — one field per line, `doneStamp` inserted after `light`.

### 2. `src/webview/shell.js` — pulse once per stamp, and *resume* it across rebuilds

> **Superseded:** a `pulsedDoneStamps` Map of `name -> stamp already animated`, with `isFreshDone = t.light === 'done' && pulsedDoneStamps.get(t.name) !== t.doneStamp` deciding whether to attach `is-pulsing`.
> **Reason:** it fixes the wrong half of the re-render storm. It stops the animation *restarting* forever, but it does nothing about the animating element being *destroyed* by the very next rebuild — at which point the replacement is marked "already pulsed" and wears no ring. Against a 2.2 s animation and a 5 s poll, roughly half of all completions are truncated; on the `!isKnown` path, `handleAgentCompleted` relays and then `fetchTerminalList()` relays again within a few hundred milliseconds, so the pulse is cut to near-zero frames. The plan would have shipped a notification the operator often never sees while every assertion it proposed stayed green — the gate exists, it is just gating the wrong thing.
> **Replaced with:** a ledger of `name -> { stamp, startedAt }`. `is-pulsing` is applied while `elapsed < DONE_PULSE_MS`, and each rebuilt element carries `animation-delay: -<elapsed>ms` so the CSS animation **resumes** at the point its predecessor was killed instead of restarting or vanishing.

Module state beside `popoutWindows` (`shell.js:203`):

```js
    // name -> { stamp, startedAt }. renderTerminalSection rebuilds EVERY button from
    // scratch on every fleet push (5s poll + terminalsChanged + the completion push
    // itself), so a bare CSS animation on `.strip-term-done` would restart every few
    // seconds and blink forever. A plain "already pulsed" boolean is not enough
    // either: the rebuild destroys the animating element mid-pulse and its
    // replacement, marked pulsed, wears no ring — the pulse is silently truncated,
    // often to nothing (handleAgentCompleted relays, then fetchTerminalList relays
    // again ~200ms later).
    //
    // So record WHEN the pulse started and keep re-applying the class with a negative
    // animation-delay equal to the elapsed time: a negative delay starts a CSS
    // animation already that far into its timeline, so each rebuilt element picks up
    // exactly where its predecessor was killed. Once elapsed >= DONE_PULSE_MS the
    // class stops being applied and the ring is gone for good.
    //
    // performance.now(), not document.timeline.currentTime: they share the same
    // monotonic clock and both keep advancing while the tab is hidden, so the two are
    // interchangeable for this arithmetic — and document.timeline can be null on a
    // freshly attached document, which performance.now() never is.
    const pulsedDoneStamps = new Map();
    const DONE_PULSE_MS = 2200; // MUST equal the animation duration in shell.html
```

Both early-return branches of `renderTerminalSection` must drop the ledger — they run before any prune loop:

```js
        if (!frames.has('terminals')) {
            pulsedDoneStamps.clear();
            /* …existing container.remove() / anchor restore, unchanged… */
```

```js
        container.innerHTML = '';
        if (!Array.isArray(terminals) || terminals.length === 0) {
            pulsedDoneStamps.clear();
            return;
        }
```

The per-terminal loop (`:330-333`):

```js
        const seenNames = new Set();
        for (const t of terminals) {
            seenNames.add(t.name);

            // -1 = no ring. 0 = start now. >0 = resume this far in.
            let pulseElapsed = -1;
            if (t.light === 'done') {
                const prev = pulsedDoneStamps.get(t.name);
                if (!prev || prev.stamp !== t.doneStamp) {
                    pulsedDoneStamps.set(t.name, { stamp: t.doneStamp, startedAt: performance.now() });
                    pulseElapsed = 0;
                } else {
                    // STRICTLY less than. A delay whose magnitude reaches the duration
                    // puts the animation straight into its post-active phase, and with
                    // fill-mode `both` the element paints the 100% keyframe for one
                    // frame — a green flash on an expired completion. This comparison
                    // is the guard against that, not a rounding nicety.
                    const elapsed = performance.now() - prev.startedAt;
                    if (elapsed < DONE_PULSE_MS) { pulseElapsed = elapsed; }
                }
            } else {
                // Not done any more (acknowledged, or exited): forget it, so a LATER
                // completion of the same terminal pulses again from the top.
                pulsedDoneStamps.delete(t.name);
            }

            const btn = document.createElement('button');
            // The done ring is a one-shot ANIMATION, not a state class: it plays for
            // DONE_PULSE_MS from the push that carried a new completion stamp, and is
            // simply absent on every push after that window closes. A terminal that
            // completed a minute ago wears no ring — the sidebar DONE chip and the
            // pane badge in the Terminals panel remain the durable record of an
            // unacknowledged completion.
            btn.className = 'strip-icon strip-term-btn strip-term-' + t.light
                + (pulseElapsed >= 0 ? ' is-pulsing' : '');
            if (pulseElapsed > 0) {
                // Resume, do not restart — the previous element was destroyed mid-pulse.
                btn.style.animationDelay = '-' + Math.round(pulseElapsed) + 'ms';
            }
```

and prune after the loop, before the function returns:

```js
        for (const name of Array.from(pulsedDoneStamps.keys())) {
            if (!seenNames.has(name)) { pulsedDoneStamps.delete(name); }
        }
```

Finally, beside the shell's other top-level listeners (near `shell.js:496`):

```js
    // A completion that lands while the cockpit tab is hidden burns its whole 2.2s
    // window unwatched — the fleet poll is suspended (terminals.js skips it on
    // visibilityState === 'hidden'), background tabs throttle animation frames, and
    // even if neither were true the pulse is over before the operator looks. Dropping
    // the ledger on return re-arms every STILL-OUTSTANDING completion so the next push
    // re-announces it exactly once. Identical semantics to a shell reload, which this
    // design already treats as correct. A terminal whose badge was acknowledged is not
    // `done` any more, so it is not re-announced.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') { pulsedDoneStamps.clear(); }
    });
```

`aria-label` continues to carry `[${t.light}]`, so the state stays readable to a screen reader for as long as the panel holds the badge — the fade is visual only.

### 3. `src/webview/shell.html` — the ring becomes a one-shot pulse

Replace the static rule (`:229-232`), keeping the existing rationale comment above it and appending the change of intent:

```css
        /* …existing comment about #22c55e, shape-not-hue, zero layout shift…
           CHANGED: the ring is a NOTIFICATION, not a state. It plays ONE 2.2s
           announcement (two beats, so it reads as deliberate rather than as a render
           glitch) and fades to nothing. It used to be a permanent border driven by
           terminalBadges, which has no expiry — so a completed agent ringed its icon
           until the operator performed one specific dismissal gesture, and a rail of
           long-running agents ended up permanently green. The durable record lives in
           the Terminals panel (sidebar DONE chip, pane badge), which is unchanged.
           The 2.2s duration is mirrored by DONE_PULSE_MS in shell.js and pinned by
           shell-terminal-strip.test.js — change both or neither. */
        @keyframes strip-term-done-pulse {
            0%   { border-color: rgba(34, 197, 94, 0); box-shadow: 0 0 0 1px rgba(34, 197, 94, 0) inset, 0 0 0 rgba(34, 197, 94, 0); }
            8%   { border-color: #22c55e;             box-shadow: 0 0 0 1px #22c55e inset, 0 0 8px rgba(34, 197, 94, 0.75); }
            33%  { border-color: rgba(34, 197, 94, 0.35); box-shadow: 0 0 0 1px rgba(34, 197, 94, 0.35) inset, 0 0 2px rgba(34, 197, 94, 0.2); }
            58%  { border-color: #22c55e;             box-shadow: 0 0 0 1px #22c55e inset, 0 0 8px rgba(34, 197, 94, 0.75); }
            100% { border-color: transparent;        box-shadow: 0 0 0 1px rgba(34, 197, 94, 0) inset, 0 0 0 rgba(34, 197, 94, 0); }
        }
        /* Reduced motion: same duration, same end state, no oscillation — hold the
           ring, then fade it. The cue is preserved; only the flashing is removed. */
        @keyframes strip-term-done-pulse-reduced {
            0%, 60% { border-color: #22c55e; box-shadow: 0 0 0 1px #22c55e inset, 0 0 6px rgba(34, 197, 94, 0.55); }
            100%    { border-color: transparent; box-shadow: 0 0 0 1px rgba(34, 197, 94, 0) inset, 0 0 0 rgba(34, 197, 94, 0); }
        }
        .strip-term-btn.strip-term-done.is-pulsing {
            animation: strip-term-done-pulse 2.2s ease-out 1 both;
        }
        @media (prefers-reduced-motion: reduce) {
            /* Swap the TRACK only. Duration, iteration count and fill-mode are
               inherited from the rule above, so DONE_PULSE_MS stays valid for both
               variants and the resume offset does not have to branch. */
            .strip-term-btn.strip-term-done.is-pulsing {
                animation-name: strip-term-done-pulse-reduced;
            }
        }
```

> **Superseded:** re-declaring `@keyframes strip-term-done-pulse` (same name) a second time inside `@media (prefers-reduced-motion: reduce)`.
> **Reason:** it works — a conditional group rule may contain `@keyframes`, and the last matching same-named declaration wins — but it is invisible to a source-text contract test (both blocks match the same name), it silently inverts if the two blocks are ever reordered, and it hides which track is actually running. A distinct keyframe name plus an `animation-name` override is unambiguous, pinnable, and reorder-safe.
> **Replaced with:** `@keyframes strip-term-done-pulse-reduced` + an `animation-name`-only override inside the media query, as written above.

Note the selector now requires `.is-pulsing`, so a `done` light with no live pulse window paints nothing — which is what makes the ring transient. The `strip-term-done` class itself stays on the button (unchanged `'strip-term-' + t.light` construction, still pinned by the existing test) and simply has no rule of its own.

### 4. `src/test/shell-terminal-strip.test.js` — pin the new contracts and repair the broken ones

> **Superseded:** "The existing precedence test (`exited` > `done` > `active`) still passes unchanged."
> **Reason:** true but beside the point — it named the one test that survives and stayed silent on the two that do not. `:102-106` asserts `deepStrictEqual(names.sort(), ['iconUri','light','name','role','worktreePath'])`, which `doneStamp` breaks; `:303-309` matches `/\.strip-term-btn\.strip-term-done\s*\{([^}]*)\}/` and asserts the rule exists, which appending `.is-pulsing` breaks. Both fail on the first run of the suite after this change.
> **Replaced with:** the explicit repair list below. Two assertions are rewritten, six are added.

**Repair (must change, currently red after the source edits):**

1. `relay carries only fleet metadata — no terminal bytes` (`:92-124`) — extend the expected field set to the six-name sorted array `['doneStamp','iconUri','light','name','role','worktreePath']`, and extend the inner membership check to match. Keep the line-per-field parse: it is what forces the literal to stay readable.
2. `terminal state is encoded without a separate dot` (`:296-317`) — replace the `.strip-term-done` rule lookup with the pulse contract:
   - assert **no** bare `/\.strip-term-btn\.strip-term-done\s*\{/` rule survives (this is the permanence being removed — the whole point of the change),
   - assert `@keyframes strip-term-done-pulse` exists and its body carries both `border-color:` and `box-shadow:` with `#22c55e` (ring **and** glow, shape plus salience — the property the old assertion protected),
   - assert the body contains no `var(--accent` (unchanged rationale: the accent is this rail's selection colour),
   - assert `.strip-term-btn.strip-term-done.is-pulsing` declares a **one-shot** animation (`… 1 both`).
   - Leave the `exited`, `active`-has-no-rule, and no-`.strip-term-dot` assertions in this test untouched.

**Add (new contracts):**

3. The relay sources `doneStamp` from the badge **value** (`terminalBadges.get(...).stamp`) rather than a parallel Map, so a badge delete cannot leave a stamp behind.
4. `handleAgentCompleted` writes a **strictly increasing** stamp (`++badgeStampSeq`) inside the `terminalBadges.set(` call, so a second completion of an already-badged terminal re-pulses.
5. `renderTerminalSection` applies `is-pulsing` only within a live window — assert the block contains both the stamp comparison (`prev.stamp !== t.doneStamp`) and the elapsed guard (`elapsed < DONE_PULSE_MS`), **and** the negative-delay resume (`animationDelay` set to `'-' + …`). Without the elapsed/resume half the animation is truncated by the next push, which is the failure a boolean gate cannot detect.
   - Assert the guard is **strictly** `<`, never `<=`: an offset that reaches the duration lands the element on its 100% keyframe under `fill-mode: both`, flashing green on an already-expired completion.
6. Both early-return branches clear the ledger — assert `pulsedDoneStamps.clear()` appears at least twice inside `renderTerminalSection`.
7. The `visibilitychange` listener clears the ledger on `visible`, so a completion missed in a background tab is re-announced on return.
8. `DONE_PULSE_MS` equals the CSS duration — parse `animation: strip-term-done-pulse ([\d.]+)s` out of `shell.html`, parse `const DONE_PULSE_MS = (\d+)` out of `shell.js`, and assert `seconds * 1000 === ms`. Two files, one number, nothing else keeps them honest.
9. The reduced-motion variant overrides `animation-name` only (never a second same-named `@keyframes`), and `@keyframes strip-term-done-pulse-reduced` exists.

The existing precedence test (`exited` > `done` > `active`, `:58-77`), the two-clears-two-relays test on `assignToFocusedPane` (`:187-193`), and the origin-guard tests (`:208-230`) all pass unchanged.

## Verification Plan

### Automated Tests

- `node src/test/shell-terminal-strip.test.js` — the two repaired assertions and seven new contracts pass; precedence, relay-origin, anchor and tooltip contracts stay green.
- `node src/test/terminal-solo-popout-contract.test.js` — the `clearTerminalBadge` relay path and the `function postFleetStateToShell()` end marker are untouched.
- `grep -n "terminalBadges.get(" src/webview/terminals.js` — expect exactly three hits: two reading `.label` (sidebar row, pane title) and one moving the whole value (rename re-key). Any raw-value read left over renders `[object Object]`.

### Manual — the reported bug

- Run the standalone shell with at least one agent terminal in the rail. Dispatch a plan so `agentCompleted` fires for it.
- **Expect:** the icon pulses green (two beats over ~2.2 s) and returns to its normal unringed appearance.
- **Expect specifically:** the pulse is not cut short. Watch it through at least one 5-second fleet poll boundary — the ring must animate smoothly across the rebuild, not vanish partway.
- Wait 30 seconds without clicking anything. **Expect:** the ring stays gone — it does not re-appear on the next poll, and it does not blink.

### Manual — the truncation path

- Complete an agent on a terminal that is **not** yet in the panel's `fleetList` (a freshly spawned/renamed one), so `handleAgentCompleted` takes the `!isKnown` branch and fires a second relay ~200 ms later.
- **Expect:** one continuous pulse. Without the resume mechanism, this path shows a flicker of at most a few frames, or nothing at all.

### Manual — the durable record survives

- Open the Terminals panel. **Expect:** the sidebar row for that terminal still shows its `DONE` chip and the pane title still shows its badge, so the completion is still discoverable after the ring fades.
- Click that terminal in the sidebar. **Expect:** the chip clears as before.

### Manual — repeat completion

- Without dismissing the badge, dispatch a second plan to the same terminal. **Expect:** the icon pulses again (a plain edge detector would not fire here — this is the case the stamp exists for).

### Manual — reload, tab switch, and churn

- Reload the shell while a badge is outstanding. **Expect:** exactly one pulse on the first push, then nothing.
- Switch to another browser tab while an agent completes, then return. **Expect:** the pulse plays once on return rather than having been missed entirely.
- Spawn and close several terminals, and close the Terminals panel entirely. **Expect:** no visual artefacts, and no stale ledger entries (`pulsedDoneStamps.size` in devtools tracks the live fleet, and is 0 with the panel closed).

### Accessibility

- Enable **Reduce motion** at the OS level and re-run the first manual check. **Expect:** a steady ring that holds ~1.3 s and then fades out over the remaining ~0.9 s, with no flashing.
- Confirm the button's `aria-label` still ends in `[done]` while the panel holds the badge.

## Resolved Assumptions

Web research was run on the one external uncertainty this plan carried (browser CSS-animation timing under page-visibility changes). It is **closed** — do not re-open it or re-research it during implementation.

1. **The document timeline does not pause while hidden.** `document.timeline.currentTime` and `performance.now()` share one monotonic clock and both keep advancing at wall-clock rate when `document.visibilityState === 'hidden'`, in Chromium, Gecko and WebKit. The Page Visibility spec permits engines to suspend *rendering*, not to alter the clock. → The elapsed-time arithmetic behind the resume mechanism is sound as written, and `performance.now()` needs no replacement.
2. **What is suspended is frame sampling and repaint, not timing.** A hidden document stops ticking its refresh driver / compositor, so an animation started while hidden runs to completion invisibly and the element is caught up to its end state on the first foreground frame. → The `visibilitychange → visible` ledger reset is the correct and necessary fix, not a workaround for a clock problem.
3. **A resume offset ≥ the duration is harmful, not merely useless.** With `animation-fill-mode: both`, a negative delay whose magnitude reaches or exceeds the duration puts the animation immediately into its post-active phase: the element paints the 100% keyframe and queues `animationstart` + `animationend` in the same sample. → The `elapsed < DONE_PULSE_MS` comparison must stay strict; pinned by test contract 5.
4. **Engines never coalesce animations across distinct DOM elements.** A recreated button always starts a fresh animation that honours its negative delay. The hazard is the inverse case: setting `style.animationDelay` on a *retained* element mutates the running animation instead of restarting it. → Correct today (the rail wipes and recreates); recorded in the Side Effects audit as a constraint on any future reconcile-in-place refactor.
5. **`animationend` is deferred while hidden and flushed in a burst on return.** → Confirms the decision to key expiry off the elapsed comparison rather than the event.
6. **The recommended pattern for transient completion cues is "transient pulse + persistent state fallback"** (WCAG 2.2 SC 4.1.3 / ARIA status patterns), because a user away from the tab will miss the transient half. → This plan already matches it: the pulse is the transient half and the sidebar `DONE` chip plus pane badge are the persistent half, deliberately left untouched (Complexity Audit item 4).

Everything else in this plan is settled from the repository itself: badge call sites, relay shape, push cadence, and test coupling.

---

**Recommendation:** Complexity 5 → **Send to Coder.**
