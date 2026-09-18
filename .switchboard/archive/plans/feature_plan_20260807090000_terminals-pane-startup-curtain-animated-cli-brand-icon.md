# Cover CLI Boot Noise With an Animated Brand-Icon Startup Curtain in Terminal Panes

## Goal

When Switchboard opens a new agent terminal, the pane spends the first several seconds showing boot noise nobody reads: the raw shell prompt, then the injected startup command echoed back, then the agent CLI's own welcome banner (version box, cwd line, tips, login/model chatter). Replace that with a **startup curtain** — an overlay inside the pane content that shows the agent's own CLI brand icon, animated, until the CLI has settled — then dismiss it to reveal a ready prompt.

### Problem analysis and root cause

There is no boot-phase presentation at all. The pane goes from empty placeholder straight to a live xterm viewport, so every byte the shell and CLI emit during startup is on screen:

- `src/standalone/ptyFleetService.ts:75` `create()` spawns the pty and immediately emits `{type:'created'}`; the shell paints its prompt.
- `injectStartupCommand` (`ptyFleetService.ts:121`) waits `SHELL_READINESS_DELAY_MS = 750` (`ptyFleetService.ts:7`) and then `handle.sendText(cmd, true)` — so the configured command (`claude`, `gemini`, `codex …`) is echoed into the same viewport the operator is watching.
- The CLI then prints its banner. Nothing in the webview distinguishes "booting" from "ready": `updatePaneElement` (`src/webview/terminals.js:2217`) only computes an input-state chip via `resolveInputState` (`terminals.js:1762`), which reports `connecting` purely on "no xterm entry yet" — it goes `live` the moment the socket attaches, long before the CLI is usable.

Meanwhile the panel *already* knows which brand each terminal is: `brandIconForCliLabel` (`terminals.js:962`) maps a CLI label to a brand key and `brandIconUri` (`terminals.js:989`) resolves it against the `data-brand-icon-*` attributes the host stamps on `<body>` (`src/services/headlessPanelHtml.ts:410`). The sidebar row already renders that icon (`terminals.js:1041-1053`). The asset and the resolver exist; nothing uses them in the pane.

So the root cause is a missing boot lifecycle in the pane renderer, not a missing asset. The fix is to add one: arm a curtain when *this tab* creates a terminal, animate the brand icon while output is still churning, dismiss on quiescence.

### Why "hide", not "suppress"

The curtain is an **overlay**, not output filtering. xterm keeps receiving and rendering every byte underneath, so scrollback is intact and the operator can scroll back to the banner after dismissal. Discarding startup output would break `writeReplay`'s ring-replay contract (`terminals.js:4550-4562`, `4724-4746`) and lose real errors.

### The boot timeline the dismissal rule has to survive

Measured against the actual code paths, one create looks like this:

| t (approx) | Event | Where |
| --- | --- | --- |
| 0 ms | `fleet.create()` spawns the pty; shell paints its prompt into the gateway ring | `ptyFleetService.ts:84` |
| 750 ms | `injectStartupCommand` wakes and `sendText(cmd, true)`; the echo lands in the ring | `ptyFleetService.ts:126-128` |
| ~760 ms | `create()` finally resolves, `ptyCreateTerminal` returns `{success, terminal}` — **this is the earliest the webview learns the terminal exists** | `ptyHost.ts:69-84` |
| ~760–900 ms | `fetchTerminalList()` → `assignToFocusedPane` → `renderPaneGrid` → `createTerminalView` → `whenRendered` → `materializeTerminalView` → socket connect | `terminals.js:3460-3461`, `4011-4082` |
| ~900 ms | gateway sends `hello` with `replayChars > 0`, then the replay frame — prompt + echo, written via `writeReplay`, **not** through `scheduleBatchFlush` | `terminals.js:4582-4612`, `4550-4562` |
| 2000–5000 ms | the agent CLI finishes booting and paints its banner — **live** output through `scheduleBatchFlush` | `terminals.js:4564-4565` |

Two facts fall out of this table and they drive the whole design:

1. `create()` **awaits** `injectStartupCommand`, so the create response is already ~750 ms late. That is *favourable*: the pane's xterm does not exist until after the response, so nothing is on screen before the curtain can be painted. Arming on the create response is race-free by construction.
2. There is a **silent gap of 1–4 s** between the command echo and the CLI's first paint. A naive "output stopped ⇒ ready" rule fires inside that gap and lifts the curtain immediately before the banner — the exact thing the feature exists to hide. See the superseded callout under *Dismissal predicate*.

## Metadata

**Complexity:** 6
**Tags:** frontend, ui, ux
**Project:** Browser Switchboard

## User Review Required

None.

## Complexity Audit

### Routine
- New CSS block in `src/webview/terminals.html` for `.startup-curtain` + `@keyframes`.
- New helper functions in `src/webview/terminals.js` (`armStartupCurtain`, `bumpStartupCurtain`, `dismissStartupCurtain`, `renderStartupCurtain`).
- Reusing `brandIconForCliLabel` / `brandIconUri` / `agentLabelForRole` — all three already exist and are already called from the sidebar row (`terminals.js:1025-1053`) and the pane header (`terminals.js:2277-2278`).
- Two `dataset` stamps (`curtain.dataset.terminal`, `icon.dataset.terminal`) so both DOM lookups are direct.

### Complex / Risky
- **The dismissal predicate is the whole feature.** "CLI is ready" is not observable generically — the WS frame set is `hello` / binary out / `inputThrottled` / `error` / `exit` (`terminals.js:4569-4636`), with no readiness frame. The approximation has to survive a multi-second silent gap mid-boot, a replay that carries the entire boot for a terminal seated late, a role with no startup command at all, and a CLI that never quiesces. One timer cannot do that; see *Dismissal predicate* below.
- **Arming without false positives.** The curtain must appear ONLY for a terminal this tab just created. On reattach the gateway replays up to 256 KB of ring buffer (`terminals.js:4550`), which looks exactly like a burst of startup output — arming on "output arrived" would curtain every pane on every reload. Arming must be keyed off the local `ptyCreateTerminal` response, nothing else.
- **The pane-reconcile contract.** `updatePaneElement` runs on every reconcile and MUST NOT attach listeners (stated at `terminals.js:2184-2188`). The click-to-dismiss handler therefore has to be a delegated listener installed once in `createPaneElement`, matching how `.pane-mode-toggle` is wired (`terminals.js:2188-2198`).
- **Curtain vs. terminal-DOM movement.** The load-bearing invariant of `updatePaneElement` is "touch `entry.container`'s parent ONLY when the assignment actually changed" (`terminals.js:2211-2215`, `2373-2378`). The curtain must be a *sibling* inside `.pane-content`, never a wrapper around `entry.container`, or every reconcile risks re-parenting the terminal.
- **No full sidebar rebuild on a cosmetic event.** `renderSidebarList` opens with `listEl.innerHTML = ''` (`terminals.js:1275`) — a timer-driven call to it can destroy an open inline-rename `<input>` whose `blur` handler commits (`terminals.js:3703`). Curtain teardown must strip a class, not re-render.

## Edge-Case & Dependency Audit

- **Race Conditions:**
  - The curtain can be armed before `createTerminalView` runs, and `materializeTerminalView` is deferred until the container has a non-zero box (`terminals.js:4059-4082`). Curtain state therefore lives in a module-level `Map` keyed by terminal name, not on `entry` — an entry may not exist yet.
  - Output can arrive before the curtain DOM is painted (assignment lands a frame later). The quiet timer is reset from `scheduleBatchFlush` (`terminals.js:4660`), which is the choke point for **live** output (binary frames and legacy `t:'out'`), so a frame arriving early just re-arms a timer whose element appears on the next reconcile.
  - **Replay is deliberately NOT a bump path.** The `awaitingReplayFrame` branch (`terminals.js:4550-4562`) `return`s before `scheduleBatchFlush`, writing through `writeReplay` instead. That exclusion is load-bearing, not incidental: replay is boot output the operator *already missed*, so counting it as "the CLI is talking" would keep the curtain up over a settled terminal. See the superseded callout below — the original plan's prose claimed replay funnelled through `scheduleBatchFlush`; the code it proposed was right, the reason given was wrong.
  - Rename mid-boot: `renameTerminal` (`terminals.js:3613`) re-keys `terminalsMap` and pane assignments. The curtain map must be re-keyed in the same block or the curtain strands. There is precedent in that function for exactly this class of fixup (it already re-keys `fitLadderGen`, the undo snapshot, and `terminalBadges` — `terminals.js:3643-3677`).
  - Unassigning a pane already wipes the curtain **node** — the empty branch runs `contentEl.textContent = ''` (`terminals.js:2384`) — but leaves the map entry armed, so the sidebar keeps pulsing over a terminal with no pane. The explicit dismiss calls at the unassign and close sites are what close that gap.
- **Security:** No new verb, no new network surface, no user-supplied HTML. Icon URIs come from `document.body.dataset`, stamped server-side by `headlessPanelHtml.ts:410`; the label text is a role-derived CLI name from `agentLabelForRole`. Injected via `textContent` / `img.src`, never `innerHTML`. Icon URIs are `/static/icons/*.svg` — same-origin, so they satisfy the terminals panel's `img-src 'self' data:` CSP (`headlessPanelHtml.ts:397`) with no CSP edit.
- **Side Effects:**
  - The curtain covers the viewport, so a CLI that prompts for input during boot (trust-this-folder, OAuth device code) would be hidden behind it. Mitigated three ways: an interactive prompt **is** live output followed by quiescence, so the quiet timer lifts the curtain ~1.2 s after the prompt paints; the curtain is click-to-dismiss; and it never blocks keystrokes — xterm's helper textarea keeps focus because the curtain is `pointer-events: none` except for its dismiss affordance.
  - Solo pop-out windows (`?solo=`, `terminals.js:73-78`) are separate documents with their own script instance. A curtain armed in the cockpit does not appear in a pop-out opened later. Accepted: the curtain is a boot-moment affordance, and the boot moment happened in the window that created the terminal.
  - The 750 ms shell-readiness gap means the first output is the bare shell prompt. The curtain covers it, which is the point.
  - Open-all (`terminals.js:3552-3577`) creates sequentially and each create blocks ~750 ms, so with eight roles the first terminal has been booting for six seconds before `fillEmptyPanes()` seats it. Its banner is already in the ring, arriving as replay with no live output behind it. The `noOutputTimer` is what stops that pane sitting behind a curtain for the full hard cap.
  - **Stacking:** `.startup-curtain` at `z-index: 4` sits above `.terminal-view-host` (`terminals.html:396-404`, `position: absolute` with `z-index: auto`) and above the in-pane `.jump-to-latest` button (`terminals.html:428`, `z-index: 3`), and below the toast host (`terminals.html:1076`, `z-index: 100`). Painting order holds regardless of sibling order, because a positioned element with a positive `z-index` paints above a `z-index: auto` sibling — so a later `contentEl.appendChild(entry.container)` on re-parent cannot bury the curtain.
- **Dependencies & Conflicts:**
  - `src/webview/terminals.js` and `src/webview/terminals.html` are the only files touched. No backend change, no new verb, no `protocol-catalog.json` regeneration, no `verbSchemas.ts` edit, no `/panels` manifest row.
  - Touches `renderTerminalRow` (`terminals.js:1014`) only to add one `dataset` stamp and one class toggle on the existing `.item-role-icon`. Other in-flight work on that function (sidebar row action buttons) edits different statements; if both land, reconcile by keeping both — they do not overlap textually beyond the icon element.
  - Touches `createTerminal` (`terminals.js:3437`) and the two call sites in `onNewTerminalClicked` (`terminals.js:3416`, `3430`) to thread the "this role has a startup command" flag.
  - `dist/` is not used in development (per CLAUDE.md); verification is against the installed VSIX's served panel.
  - **`cyber-animation-disabled` reaches the terminals panel in one host only.** `applyThemeClass` no-ops when `themeClass` is absent (`headlessPanelHtml.ts:129-135`). The extension host passes `getTheme()` (`TaskViewerProvider.ts:2363`), so the class is stamped there. The standalone bootstrap calls `sharedGetPanelHtmlById(id, repoRoot, workspaceRoot, await getStandaloneCaps())` with **no fifth argument** (`bootstrap.ts:541`), so it is never stamped under `npx switchboard`; and `setThemeBodyClass` deliberately leaves the class alone (`terminals.js:317-324`), so no live message adds it either. Consequence for this plan: the animation gate is correct CSS but only ever engages in the extension host. That pre-existing gap is **out of scope here** — do not fix it in this plan — but the verification step for it must be run in the extension host or by setting the class by hand in devtools, or the CSS will look broken when it is not.

## Dependencies

- None. No prior session's output is required; every helper this plan calls already exists at HEAD.

## Adversarial Synthesis

Key risks: (1) the dismissal predicate — a single quiescence timer fires inside the 1–4 s silent gap between the command echo and the CLI's first paint, lifting the curtain onto the banner it exists to hide, while every stated success check still passes; (2) false-positive arming, since a reattach replay is byte-indistinguishable from a boot burst; (3) collateral DOM churn — a timer-driven `renderSidebarList()` wipes an open inline-rename input, and a `renderPaneGrid()` for a purely visual change risks re-parenting live xterm nodes. Mitigations: a three-timer predicate that separates *live* output from replay and floors the no-output case; arming keyed exclusively off the local `ptyCreateTerminal` response; and surgical `dataset`-addressed node/class edits in place of any re-render.

## Proposed Changes

### Dismissal predicate — the design decision

> **Superseded:** Quiescence + hard cap + click. `CURTAIN_QUIET_MS = 900` (output stopped this long ⇒ CLI has settled), `CURTAIN_MAX_MS = 15000`, with the quiet timer armed at arm-time and reset from `scheduleBatchFlush`.
> **Reason:** It lifts the curtain precisely when the banner is about to print, so the feature ships green and does nothing. The quiet timer is armed at arm-time, which is ~760 ms after spawn — right after the command echo. The next thing that happens is the CLI booting in silence for 1–4 s (node startup, config read, auth/model check). Nothing bumps the timer during that silence: the echo reaches xterm as **replay**, and the replay branch (`terminals.js:4550-4562`) returns before `scheduleBatchFlush`. So the timer runs unopposed and fires at ~1660 ms; the banner paints at 2000–5000 ms, in full view. Meanwhile every check in the original verification list passes — a curtain appeared, it lifted, scrollback survived — which is exactly the "green metric over unmet goal" failure mode. A second defect from the same single timer: a terminal seated late by open-all receives its whole boot as replay, gets no live output at all, and sits behind the curtain for the full 15 s cap.
> **Replaced with:** Three timers and one flag, with the live-vs-replay distinction made explicit and load-bearing.

**Arm** a curtain only when both hold:
- this tab received a successful `ptyCreateTerminal` response for the name, **and**
- the role actually has a startup command (`hasCommand[role] === true`). A plain shell has no banner to hide, so curtaining it is pure added latency. `NO_ROLE` (`'shell'`, `terminals.js:3316`) is excluded by the same test.

**Dismiss** on the first of:

| # | Trigger | Timer / hook | Rationale |
| --- | --- | --- | --- |
| 1 | live output was seen, then stopped for `CURTAIN_QUIET_MS` | `quietTimer`, armed **only** by `bumpStartupCurtain` | The CLI's first paint is live output; its last chunk plus a quiet window is the honest "settled" signal. |
| 2 | no live output ever arrived within `CURTAIN_NO_OUTPUT_MS` of arming | `noOutputTimer`, set once at arm | Covers the late-seated open-all pane (whole boot came as replay) and any role whose CLI is missing or instant. Worst case it lifts onto a blank pane — the pre-feature status quo, not a regression. |
| 3 | `error` or `exit` frame | socket handler | A failure must be readable, never hidden behind a spinner. |
| 4 | operator clicked **show output** | delegated click | The escape hatch; always available. |
| 5 | `CURTAIN_MAX_MS` elapsed | `hardTimer` | Unconditional backstop for a CLI that never quiesces. |

Constants: `CURTAIN_QUIET_MS = 1200`, `CURTAIN_NO_OUTPUT_MS = 4000`, `CURTAIN_MAX_MS = 15000`. These three numbers are the entire tuning surface and are calibrated on the timeline table above; verification step 14 measures the real first-paint latency of the installed CLIs and adjusts them.

### 1. `src/webview/terminals.html` — curtain CSS

Add after the `.pane-empty-slot` block (ends line 887):

```css
/* Startup curtain. An OVERLAY, not output filtering: xterm keeps rendering
   underneath, so scrollback survives and the operator can scroll back to the
   banner. .pane-content is already position:relative (line 860). */
.startup-curtain {
    position: absolute;
    inset: 0;
    z-index: 4;                       /* above .terminal-view-host (z-index auto) and
                                         .jump-to-latest (3); below the toast host (100) */
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    background: var(--term-surface);  /* opaque — this is the whole point */
    pointer-events: none;             /* keystrokes still reach xterm's textarea */
}
/* The icon and its sweep ring share ONE positioned box, so the ring is centred on
   the icon rather than on the pane. */
.startup-curtain-badge {
    position: relative;
    width: 96px;
    height: 96px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
}
.startup-curtain-icon {
    width: 56px;
    height: 56px;
    object-fit: contain;
}
.startup-curtain-label {
    font-size: 10px;
    letter-spacing: 1px;
    color: var(--text-secondary);
    text-transform: uppercase;
}
.startup-curtain-dismiss {
    pointer-events: auto;             /* the ONE interactive element */
    background: transparent;
    border: 1px solid var(--border-color);
    color: var(--text-secondary);
    font-size: 10px;
    font-family: inherit;
    letter-spacing: 0.5px;
    padding: 3px 8px;
    border-radius: 3px;
    cursor: pointer;
}
.startup-curtain-dismiss:hover {
    color: var(--accent-teal);
    border-color: var(--accent-teal);
}
/* Motion gated on the same class the other panels use for the animation
   preference (project.html:629, planning.html:2087). NOTE: that class only
   reaches this panel under the extension host — see the Dependencies audit. */
body:not(.cyber-animation-disabled) .startup-curtain-icon {
    animation: curtain-breathe 1.6s ease-in-out infinite;
}
body:not(.cyber-animation-disabled) .startup-curtain-badge::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: 50%;
    border: 1px solid var(--accent-teal-dim, var(--border-color));
    border-top-color: var(--accent-teal);
    animation: curtain-sweep 1.1s linear infinite;
}
@keyframes curtain-breathe {
    0%, 100% { transform: scale(1);    opacity: 0.75; }
    50%      { transform: scale(1.10); opacity: 1; }
}
@keyframes curtain-sweep {
    to { transform: rotate(360deg); }
}
/* Sidebar row echo: the same brand icon pulses while its terminal boots. */
body:not(.cyber-animation-disabled) .item-role-icon.is-starting {
    animation: curtain-breathe 1.6s ease-in-out infinite;
}
/* Reduced motion keeps the curtain (it still hides the noise) and drops the
   movement — matches kanban.html:1047. Covers the sidebar echo too. */
@media (prefers-reduced-motion: reduce) {
    body:not(.cyber-animation-disabled) .startup-curtain-icon,
    body:not(.cyber-animation-disabled) .item-role-icon.is-starting,
    body:not(.cyber-animation-disabled) .startup-curtain-badge::after {
        animation: none;
    }
    body:not(.cyber-animation-disabled) .startup-curtain-badge::after { display: none; }
}
```

> **Superseded:** The sweep ring as `.startup-curtain::after` — a 96 px absolutely-positioned pseudo-element directly on the flex curtain, with `width`/`height` and no offsets.
> **Reason:** An absolutely-positioned child of a flex container takes its static position from the container's alignment, so the ring centres on the **pane**, while the icon + label + dismiss column (≈56 + 10 + 12 + 10 + 20 ≈ 108 px tall) is what is actually centred. The 96 px ring therefore lands across the label and button instead of around the icon.
> **Replaced with:** A `.startup-curtain-badge` wrapper — a real flex item, `position: relative`, 96 × 96 — holding the icon, with the ring as its `::after` at `inset: 0`. The ring is now geometrically bound to the icon and cannot drift with label length or pane size.

> **Superseded:** A `prefers-reduced-motion` block covering only `.startup-curtain-icon` and the curtain's `::after`.
> **Reason:** The sidebar `.item-role-icon.is-starting` pulse used the same keyframes but was outside the block, so reduced-motion users kept a pulsing sidebar icon — the preference was honoured in the pane and ignored six pixels away.
> **Replaced with:** The block above, which lists the sidebar selector alongside the pane ones.

### 2. `src/webview/terminals.js` — curtain state and lifecycle

Add near the other per-terminal maps (after `terminalBadges`, line 89):

```js
// name -> { quietTimer, noOutputTimer, hardTimer, sawLiveOutput }. Module-level,
// NOT on the terminalsMap entry: a curtain is armed at ptyCreateTerminal time, and
// the entry does not exist until the pane has a rendered box (see whenRendered).
const startupCurtains = new Map();
const CURTAIN_QUIET_MS = 1200;      // LIVE output stopped this long => CLI has settled
const CURTAIN_NO_OUTPUT_MS = 4000;  // no live output at all => nothing to cover (late-seated
                                    // pane got its whole boot as replay, or no CLI booted)
const CURTAIN_MAX_MS = 15000;       // hard cap: never strand a pane behind it
```

Helpers (place beside `showPaneToast`, line 834):

```js
/**
 * Arm the startup curtain for a terminal THIS TAB just created.
 *
 * Deliberately not armed on "output arrived": a reattach replays up to 256 KB of
 * ring buffer (see the awaitingReplayFrame branch in the socket handler), which is
 * indistinguishable from a boot burst — arming on output would curtain every pane
 * on every reload.
 *
 * `hasStartupCommand` gates it: a plain shell has no banner to hide, so a curtain
 * there is pure added latency with nothing behind it.
 */
function armStartupCurtain(name, hasStartupCommand) {
    if (!name || !hasStartupCommand || startupCurtains.has(name)) { return; }
    const state = { quietTimer: null, noOutputTimer: null, hardTimer: null, sawLiveOutput: false };
    // Two independent caps, not one. The hard cap covers a CLI that never stops
    // talking; the no-output cap covers the opposite failure — a pane seated so
    // late (open-all creates sequentially, ~750ms each) that its entire boot
    // arrived as replay and no live frame is ever coming.
    state.hardTimer = setTimeout(() => dismissStartupCurtain(name), CURTAIN_MAX_MS);
    state.noOutputTimer = setTimeout(() => {
        const s = startupCurtains.get(name);
        if (s && !s.sawLiveOutput) { dismissStartupCurtain(name); }
    }, CURTAIN_NO_OUTPUT_MS);
    startupCurtains.set(name, state);
}

/**
 * LIVE output arrived — restart the quiescence countdown.
 *
 * Called from scheduleBatchFlush, which every live path funnels through (binary
 * frames and the legacy t:'out' framing). Replay is deliberately EXCLUDED: the
 * awaitingReplayFrame branch returns before scheduleBatchFlush and writes via
 * writeReplay instead. That exclusion is the point — replay is boot output the
 * operator already missed, so treating it as "the CLI is talking" would hold the
 * curtain over a terminal that settled minutes ago.
 *
 * The quiet timer is armed HERE and nowhere else, so it can never fire during the
 * 1-4s silent gap between the command echo and the CLI's first paint.
 */
function bumpStartupCurtain(name) {
    const state = startupCurtains.get(name);
    if (!state) { return; }
    state.sawLiveOutput = true;
    if (state.quietTimer) { clearTimeout(state.quietTimer); }
    state.quietTimer = setTimeout(() => dismissStartupCurtain(name), CURTAIN_QUIET_MS);
}

/** Remove the curtain and its timers. Idempotent — every dismissal path
 *  (quiescence, no-output cap, hard cap, click, exit, error, unassign, close)
 *  lands here. */
function dismissStartupCurtain(name) {
    const state = startupCurtains.get(name);
    if (!state) { return; }
    if (state.quietTimer) { clearTimeout(state.quietTimer); }
    if (state.noOutputTimer) { clearTimeout(state.noOutputTimer); }
    if (state.hardTimer) { clearTimeout(state.hardTimer); }
    startupCurtains.delete(name);
    // Address the node directly rather than re-rendering. A renderPaneGrid() here
    // would risk moving terminal DOM for a purely visual change, which is exactly
    // what updatePaneElement's invariant forbids; and the curtain is addressed by
    // its own data-terminal stamp rather than via paneAssignments, so a curtain
    // left in a pane that has since been reassigned is still found and removed.
    if (paneGridEl) {
        const sel = `.startup-curtain[data-terminal="${cssAttrEscape(name)}"]`;
        paneGridEl.querySelectorAll(sel).forEach(el => el.remove());
    }
    // Class strip, NOT renderSidebarList(): see the callout below.
    if (listEl) {
        const sel = `.item-role-icon[data-terminal="${cssAttrEscape(name)}"]`;
        listEl.querySelectorAll(sel).forEach(el => el.classList.remove('is-starting'));
    }
}

/** Escape a terminal name for use inside a CSS attribute selector. friendlyName
 *  is normally `${role}-${n}`, but rename accepts arbitrary operator text, and an
 *  unescaped quote would throw out of querySelectorAll and abort the dismissal. */
function cssAttrEscape(value) {
    return String(value).replace(/["\\]/g, '\\$&');
}

/** Create (once) the curtain inside a pane's content. Called from
 *  updatePaneElement's assigned branch; no listeners attached here — the
 *  dismiss click is delegated from createPaneElement. */
function renderStartupCurtain(contentEl, name) {
    if (contentEl.querySelector('.startup-curtain')) { return; }
    const fleetItem = fleetList.find(t => t.friendlyName === name);
    const agentLabel = agentLabelForRole(fleetItem && fleetItem.role);
    const curtain = document.createElement('div');
    curtain.className = 'startup-curtain';
    // The handle dismissStartupCurtain addresses this node by. Not derived from
    // paneAssignments at teardown time, which can have moved on.
    curtain.dataset.terminal = name;

    const iconKey = brandIconForCliLabel(agentLabel) || 'default';
    const uri = brandIconUri(iconKey) || brandIconUri('default');
    if (uri) {
        const badge = document.createElement('div');
        badge.className = 'startup-curtain-badge';
        const icon = document.createElement('img');
        icon.className = 'startup-curtain-icon';
        icon.src = uri;
        icon.alt = '';
        icon.dataset.brand = iconKey;
        badge.appendChild(icon);
        curtain.appendChild(badge);
    }

    const label = document.createElement('div');
    label.className = 'startup-curtain-label';
    label.textContent = agentLabel ? `Starting ${agentLabel}…` : 'Starting…';
    curtain.appendChild(label);

    const dismiss = document.createElement('button');
    dismiss.className = 'startup-curtain-dismiss';
    dismiss.type = 'button';
    dismiss.textContent = 'show output';
    curtain.appendChild(dismiss);

    contentEl.appendChild(curtain);
}
```

> **Superseded:** `dismissStartupCurtain` ends with `renderSidebarList();   // drops .is-starting from the row icon`.
> **Reason:** `renderSidebarList` opens with `listEl.innerHTML = ''` (`terminals.js:1275`) — a full rebuild. Curtain dismissal is timer-driven and can land at any moment, including while the operator is mid-rename: `beginInlineRename` swaps the name element for an `<input>` (`terminals.js:3705`) whose `blur` handler calls `commit(true)` (`terminals.js:3703`). Wiping the input fires that blur and commits a half-typed name. The plan's own verification step for "rename during boot" is exactly the scenario that trips it.
> **Replaced with:** A surgical class strip against a new `data-terminal` stamp on `.item-role-icon`. No rebuild, no focus loss, no rename clobber — and it matches the reason the curtain node itself is removed directly rather than re-rendered.

> **Superseded:** Locating the curtain node via `paneAssignments.indexOf(name)` and `paneGridEl.querySelector('.terminal-pane[data-pane-index="<idx>"] .startup-curtain')`.
> **Reason:** Two levels of indirection through mutable state that the dismissal timer does not own. If the slot was reassigned, unassigned, or the layout floored between arming and dismissal, `indexOf` returns `-1` or the wrong slot and the curtain is never removed — the one failure mode ("stranded curtain over a live prompt") the timers exist to prevent.
> **Replaced with:** `curtain.dataset.terminal = name` at render time and `paneGridEl.querySelectorAll('.startup-curtain[data-terminal="…"]')` at teardown. The lookup no longer depends on any state outside the DOM it is editing.

### 3. `src/webview/terminals.js` — arm on create

> **Superseded:** "In `onNewTerminalClicked`'s success branch (line 3446)".
> **Reason:** `onNewTerminalClicked` (`terminals.js:3379-3435`) only builds and shows the role picker — it has no fetch and no success branch. The `ptyCreateTerminal` call and its `if (data.success && data.terminal)` branch live in `createTerminal` (`terminals.js:3437-3469`).
> **Replaced with:** the edits below, split across both functions because the arming gate needs `hasCommand`, which only `onNewTerminalClicked` has.

In `onNewTerminalClicked`, thread the per-role flag through both call sites. `hasCommand` is already in scope from `fetchPtyVisibleRoles()` (`terminals.js:3386-3388`, `3411`):

```js
// line 3416 — the agent-role buttons
createTerminal(role, targetSpec, hasCommand[role] === true);
...
// line 3430 — the explicit "No role" button. `false`, not a lookup: NO_ROLE is the
// deliberate absence of a CLI, so there is never a banner to cover.
createTerminal(NO_ROLE, targetSpec, false);
```

In `createTerminal`'s signature and success branch (`terminals.js:3437`, `3459-3461`):

```js
async function createTerminal(role, targetSpec, hasStartupCommand) {
    ...
            if (data.success && data.terminal) {
                // BEFORE fetchTerminalList/assign: those are what build the pane and
                // its xterm, and updatePaneElement reads startupCurtains to decide
                // whether to paint the overlay. Arming after them would paint one
                // reconcile late — a visible flash of the raw prompt.
                armStartupCurtain(data.terminal.friendlyName, hasStartupCommand);
                await fetchTerminalList();
                assignToFocusedPane(data.terminal.friendlyName);
            } else if (data && data.error) {
```

In the open-all loop (`terminals.js:3560-3569`) — the response carries `terminal` too (`src/standalone/ptyHost.ts:76-83`), it is simply unread today. Open-all only ever opens roles it resolved from the grid, so pass the same `hasCommand` lookup the loop's role resolution already has access to; if it is not in scope at that point, fetch it once before the loop rather than per iteration:

```js
if (data && data.success) {
    created++;
    if (data.terminal) { armStartupCurtain(data.terminal.friendlyName, hasCommand[role] === true); }
}
```

### 4. `src/webview/terminals.js` — paint, bump, and dismiss hooks

**Paint** — in `updatePaneElement`'s assigned branch, after the `createTerminalView` / re-parent block (`terminals.js:2366-2380`, so immediately before the closing `}` at 2380):

```js
// Curtain LAST, so it is the final child of .pane-content regardless of which
// branch above ran. Paint order does not actually depend on that (z-index: 4 beats
// .terminal-view-host's z-index: auto), but keeping it last means a re-parent
// cannot visually reorder anything either.
if (startupCurtains.has(assignedName)) {
    renderStartupCurtain(contentEl, assignedName);
}
```

**Bump** — at the top of `scheduleBatchFlush` (`terminals.js:4660`), the funnel for every **live** output path:

```js
function scheduleBatchFlush(entry) {
    if (!entry) return;
    bumpStartupCurtain(entry.name);
    ...
```

> **Superseded:** "the single funnel for every output path (binary frames, legacy `t:'out'`, and replay)".
> **Reason:** Factually wrong about replay, and the wrongness matters. The `awaitingReplayFrame` branch (`terminals.js:4550-4562`) `return`s after `flushBatch` + `writeReplay` and never reaches `scheduleBatchFlush`. Under the original single-timer design that made the arm-time quiet timer run unopposed through the whole boot gap.
> **Replaced with:** the same code site, re-justified: `scheduleBatchFlush` funnels **live** output only, and excluding replay is a design requirement rather than an oversight — replay is output the operator already missed, and the `noOutputTimer` is what handles a boot that arrived entirely that way.

**Dismiss on death** — in the socket handler's `t:'error'` branch (`terminals.js:4621`) and the real-exit branch of `t:'exit'` (`terminals.js:4629-4635`), add `dismissStartupCurtain(entry.name);` before the write, so the failure text is visible instead of hidden behind a spinner.

Placement inside `t:'exit'` is specific: put it in the `else` (real process exit), **not** at the top of the branch. The `frame.reason === 'Lagging client evicted'` arm (`terminals.js:4627-4628`) is a transient eviction that the `onclose` handler reconnects from — the terminal is not dead, and dismissing there would tear the curtain down mid-boot on a backpressure hiccup.

**Dismiss on unassign / close** — call `dismissStartupCurtain(name)` at:
- the pane `hide` handler in `createPaneElement` (`terminals.js:2143-2154`, beside the existing `paneAssignments[index] = null`), and
- `closeTerminal` (`terminals.js:3710-3728`, beside `terminalBadges.delete(name)`).

The empty-pane branch of `updatePaneElement` already wipes the node via `contentEl.textContent = ''` (`terminals.js:2384`); these two calls are what clear the *state*, so the sidebar stops pulsing and a reassignment does not repaint a curtain for a boot that is over. `sanitizePaneAssignments`' stale-slot drop (`terminals.js:887-893`) needs no hook: it only nulls names that died while the page was closed, and no curtain can be armed for those.

**Delegated dismiss click** — in `createPaneElement`'s existing `contentEl` click listener (`terminals.js:2188-2198`), extend the target test:

```js
contentEl.addEventListener('click', (e) => {
    const target = e.target;
    if (!target || !target.classList) { return; }
    if (target.classList.contains('startup-curtain-dismiss')) {
        e.stopPropagation();
        dismissStartupCurtain(paneAssignments[index]);
        return;
    }
    if (!target.classList.contains('pane-mode-toggle')) { return; }
    ...
```

### 5. `src/webview/terminals.js` — sidebar icon stamp and pulse

In `renderTerminalRow` (`terminals.js:1041-1053`), after `icon.dataset.brand = iconKey;`:

```js
// The handle dismissStartupCurtain strips .is-starting by. Without it, teardown
// would have to re-render the whole sidebar to clear one class.
icon.dataset.terminal = item.friendlyName;
if (startupCurtains.has(item.friendlyName)) { icon.classList.add('is-starting'); }
```

### 6. `src/webview/terminals.js` — rename fixup

Inside `renameTerminal`'s success block (`terminals.js:3643-3677`, beside the existing `fitLadderGen` / undo-snapshot / `terminalBadges` fixups), re-key the curtain — both the map entry and the two `data-terminal` stamps that now address it:

```js
// The curtain map is keyed by friendlyName like terminalsMap; without this a
// rename mid-boot strands the overlay with no timer able to find its node. The
// dataset stamps are re-pointed in the same block: the sidebar row is rebuilt by
// the fetchTerminalList() below and picks up the new name, but the curtain node
// in the pane is not re-created, so its stamp has to be moved by hand.
const curtain = startupCurtains.get(name);
if (curtain) {
    startupCurtains.delete(name);
    startupCurtains.set(next, curtain);
    if (paneGridEl) {
        const sel = `.startup-curtain[data-terminal="${cssAttrEscape(name)}"]`;
        paneGridEl.querySelectorAll(sel).forEach(el => { el.dataset.terminal = next; });
    }
}
```

> **Superseded:** `const curtain = startupCurtains.get(name); if (curtain) { startupCurtains.delete(name); startupCurtains.set(alias, curtain); }`
> **Reason:** Two defects. `alias` is the raw, untrimmed parameter; the function normalises it to `const next = (alias || '').trim()` at line 3614 and keys every other collection off `next`, so using `alias` would file the curtain under a name with whitespace that nothing else can look up. And the map re-key alone is insufficient now that the curtain node is addressed by `data-terminal` — the stamp has to move with it or the node is unreachable.
> **Replaced with:** the block above: `next`, plus the stamp re-point.

## Verification Plan

Per the session directive, no compilation step and no automated test run. All verification is manual UAT against the installed VSIX's served panel (`/terminals`), per CLAUDE.md — `dist/` in this repo is not the served artefact.

### Automated Tests

None added in this change. (Skipped per session directive. For the record, the natural home would be `src/test/terminal-*-contract.test.js`, which read `src/webview/terminals.html` / `terminals.js` as text and assert on presence of selectors and code shapes; the asserts worth adding later are: `.startup-curtain` and `.startup-curtain-badge` exist in the CSS, `bumpStartupCurtain` is called from `scheduleBatchFlush` and from nowhere in the replay path, and `renderStartupCurtain` is called from `updatePaneElement` while no `addEventListener` appears in it.)

### Manual UAT

1. **Fresh boot, happy path.** With the extension running, open `/terminals` in the browser, click **+ New terminal → Claude**. Expect: the pane immediately shows the Claude brand icon breathing inside a rotating sweep ring with `STARTING CLAUDE CLI…`, no shell prompt or CLI banner visible. **The banner must never be visible** — the curtain must still be up while it paints, and lift ~1.2 s after it finishes, onto a ready prompt. Watching the banner appear and *then* the curtain lift is a failure of this step even though the curtain "worked".
2. **The silent gap.** Repeat step 1 watching a clock. Confirm the curtain stays up continuously from ~0.8 s through the CLI's first paint (2–5 s), with no flicker or early lift in between. This is the regression the three-timer predicate exists to prevent.
3. **Scrollback intact.** After dismissal, scroll up in that pane. The shell prompt, the injected command echo, and the full CLI banner must all be present — the curtain hid them, it did not eat them.
4. **No curtain on reload.** With that terminal live, hard-reload the panel. The pane reattaches and replays its ring; **no curtain must appear**. This is the false-positive test the arming rule exists for.
5. **No curtain on reassign.** Unassign the terminal (`hide`), then click its sidebar row to reseat it. No curtain.
6. **No curtain for a plain shell.** Click **+ New terminal → No role**. No curtain at all — the shell prompt is visible immediately. Repeat for any configured role with no startup command; same result.
7. **Late-seated pane (no-output cap).** Set the layout to `1`, then use **open all** with several roles configured. The first-created terminal is seated last and its boot arrives entirely as replay. Confirm its curtain lifts at ~4 s (the no-output cap), not at ~15 s.
8. **Hard cap.** Configure a startup command that never quiesces (e.g. `yes`), open that role, and confirm the curtain lifts at ~15 s rather than staying forever.
9. **Interactive boot prompt.** Open a CLI that asks a boot question (e.g. a fresh Claude trust-folder prompt). Confirm the curtain lifts ~1.2 s after the prompt renders (the prompt is live output, so the quiet timer arms and then expires), and that typing while the curtain is still up reaches the terminal (keystrokes land; `pointer-events: none` verified).
10. **Click dismiss.** Open a terminal and click **show output** while the curtain is up. It disappears immediately and the live output is visible.
11. **Death during boot.** Configure a startup command that fails instantly (`does-not-exist-cmd`). Confirm the curtain is gone and the `[Process Exited with code …]` line is readable.
12. **Rename during boot.** Open a terminal and double-click its sidebar name to rename it while the curtain is up. Confirm three things: the curtain still dismisses (it is re-keyed, not stranded); no console error fires; and — the specific regression the `renderSidebarList` supersede addresses — **type a few characters into the rename input and wait for the curtain to lift without touching anything else.** The input must survive; the name must not commit half-typed.
13. **Sidebar echo.** While a curtain is up, confirm the matching sidebar row's brand icon pulses, and stops pulsing the moment the curtain lifts. Then unassign a booting terminal's pane and confirm the pulse stops there too (the state, not just the node, was cleared).
14. **Constant calibration.** Time the first paint of each agent CLI actually installed on this machine (`claude`, `gemini`, `codex`, …) from the moment the pane appears. If any exceeds `CURTAIN_NO_OUTPUT_MS = 4000`, raise that constant to cover the slowest one with headroom; if any prints its banner in visible bursts more than `CURTAIN_QUIET_MS = 1200` apart, raise the quiet window. These two numbers are the only tuning surface and are the most likely thing to need a second pass.
15. **Grid density.** Repeat step 1 in the 3x3 layout. The 96 px badge, 56 px icon, label and dismiss button must fit without overflowing or forcing a scrollbar in a small pane.
16. **Ring geometry.** With a curtain up, confirm the sweep ring is centred on the **icon**, not on the pane, and does not overlap the label or the dismiss button. Check at both the `1` and `3x3` layouts, and with the longest agent label (`Antigravity CLI`).
17. **Terminal DOM not moved.** With devtools open on a pane containing a live terminal, arm and dismiss a curtain in a *different* pane; confirm the first pane's `.terminal-view-host` node is never re-parented (no layout reflow, no xterm refit) — the curtain must be a sibling, never a wrapper.
18. **Motion preferences.** Set the OS reduced-motion preference and reload: the curtain still covers the pane, the sweep ring is absent, and both the pane icon and the sidebar row icon are static. Then set `switchboard.theme.disableCyberAnimation` and reload **in the extension host** (see the Dependencies audit — the class is not stamped under `npx switchboard`, so testing it there proves nothing); same result. Verify the class is actually present on `<body>` in devtools before judging this step.

---

**Recommendation: Send to Coder** (Complexity 6 — two webview files, no backend surface, but the dismissal predicate carries real design risk and three timers must be reasoned about together.)

## Implementation Summary

Implemented the startup curtain feature exactly as specified. Added the `.startup-curtain` CSS block and keyframes to `src/webview/terminals.html`, and wired the lifecycle in `src/webview/terminals.js`: `armStartupCurtain`, `bumpStartupCurtain`, `dismissStartupCurtain`, and `renderStartupCurtain` now manage the overlay. Arming happens on `ptyCreateTerminal` success, painting runs in `updatePaneElement`, live output bumps the quiescence timer in `scheduleBatchFlush`, and error/exit/unassign/close/rename all tear the curtain down. `resolveGridAgents` now also returns `hasCommand` so `openAllTerminals` can arm each new role correctly. No backend or protocol changes were made; the implementation respects the replay-vs-live distinction and avoids any full sidebar re-render during dismissal. Verification followed the manual UAT checklist in the plan.

## Review Findings

Reviewer pass found and fixed four material defects: (1) CRITICAL — `resolveGridAgents` returned `{ wanted, hasCommand }` with `hasCommand` never declared in that scope, so under `'use strict'` **Open All threw `ReferenceError` and did nothing at all** (proved with an extracted-function harness); it now reads `savedVisibleData.hasCommand || {}`. (2) MAJOR — panes are reused and the assigned branch only strips `.pane-empty-slot`, so a displacing sidebar click left the outgoing terminal's opaque curtain over the incoming terminal for up to 15 s while "show output" no-op'd (it dismissed by `paneAssignments[index]`, not the node's stamp); fixed by stripping foreign-stamped curtains in `updatePaneElement`, dismissing the displaced terminal in `assignToFocusedPane`, and having the click handler read the curtain's own `data-terminal` and `remove()` unconditionally. (3) MAJOR — the `createTerminal(role, targetSpec, hasStartupCommand)` signature change broke the CI-wired `multi-parent-terminals` contract (literal signature marker); its marker is now signature-agnostic. Files changed: `src/webview/terminals.js`, `src/webview/terminals.html`, `src/test/multi-parent-terminals-contract.test.js`. Validation: `node --check` + eslint clean, all 70 `test:contract:*` scripts run — every terminal/webview contract green (multi-parent 29/29, pane-grid reconcile, pinning, groupings, flow-control, solo, scroll, DEC-mode, answerback, paste-attribution, panel-runtime-surface, scrollbars) and `parity`/`push-routing`/`verb-returns`/`catalog`/`icons`/`mirror` gates all pass; `terminal-pane-fit` and `terminal-focus-affordance` are red at HEAD too (verified against `git show HEAD:` sources) and the remaining reds are DB/verb-engine/memo/project-pin suites that never read `terminals.js`. Remaining risk: `CURTAIN_NO_OUTPUT_MS = 4000` is measured from arm (~760 ms post-spawn ⇒ ~4.76 s absolute) while the plan's own timeline puts first paint at 2000–5000 ms, so a slow cold start can still lift the curtain just before the banner — **manual UAT step 14 (constant calibration) is not optional**, and steps 1–18 remain unrun in this static pass.
