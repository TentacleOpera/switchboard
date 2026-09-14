# The Browser Shell Polls a Dead Host Forever Without Saying So

> **RESCOPED 2026-09-14 (improve-feature reconciliation).** This plan was originally scoped to the terminal-grid page (`terminals.js`/`terminals.html`) — a per-page failure counter and banner. That scope was too narrow: the browser shell (`shell.js`) serves the kanban board, the terminal grid, the planning panel, and every other rail panel from the same host. When the host dies, **everything inside the shell breaks**, not just the terminal grid. A banner on one page hides the fact that the whole shell is orphaned. The plan is now scoped to `shell.js` — one shell-wide banner, not one per panel.

## Goal

Give the browser shell a visible host-offline state: when the standalone host it was served from goes away, the shell says so and tells the user how to recover, instead of leaving every panel silently failing its fetches against a corpse.

### Problem Analysis

The browser shell is served as static files from `dist/webview`/`src/webview` (`bootstrap.ts:1473-1474`). Once loaded, the shell HTML/JS persists in the browser and fetches data from the host. The shell frame stays alive when the host dies — but every panel inside it (kanban, terminals, planning) fails to fetch, silently.

Three things then happen, none of them visible at the shell level:

1. **The shell's own manifest fetch fails silently.** `loadManifest()` (`shell.js:852`) fetches `/panels` once on load. Its catch renders a `#strip-error` div saying "Failed to load panels" (`:858-862`) — but only on initial load. If the host dies *after* the shell is loaded, there is no re-fetch and no detection.
2. **Every panel's fetches fail silently.** The terminal grid's `fetchTerminalList` handler is `catch { /* ignore — the next fleet poll will pick it up */ }` (`terminals.js:2500`). There is no next successful poll: the host is gone. Other panels have similar ignore-on-failure patterns.
3. **Reconnect never arms.** The terminal grid's `ws.onclose` only schedules a retry when `fleetList.find(i => i.friendlyName === entry.name)` reports `status === 'active'` (`:9992`) — and `fleetList` is populated by the fetch that just failed. So the panes settle on `connecting` and stay there.

**Why this is a shell-level concern, not a panel-level one.** The shell is the container for every panel. When the host dies, the kanban board is broken, the terminal grid is broken, the planning panel is broken — all of them, simultaneously, for the same reason. A per-panel banner means N banners for one cause, or (worse) panels that fail silently because they were never taught to detect host death. One shell-wide banner is the honest answer: the host is gone, not "the terminals are connecting" or "the board failed to load."

**The shell has no host-health poll today.** `shell.js` fetches `/panels` once on load (`:852`) and never polls the host again. The panels inside the shell poll their own endpoints, but the shell itself has no heartbeat. Adding a lightweight `/health` poll to the shell is the detection mechanism — the same `/health` endpoint the terminal grid already fetches (`terminals.js:722`, returning `health.ptyHost` and `health.hostCapability`).

**Cutover interaction.** Pre-cutover, the extension host served the shell on an ephemeral port (`LocalApiServer.ts:648`), and a VS Code window reload invalidated it. Post-Stage 2, the extension spawns the standalone host, whose port is durable (published to `.switchboard/api-server-port.txt`, `bootstrap.ts:2755`). A VS Code reload no longer orphans the shell. The surviving case is **the standalone host itself died** (user killed it, machine rebooted). The banner is still wanted; its trigger no longer needs to special-case the extension host.

## Metadata

**Feature:** 01c83b6c-f9aa-4991-a51a-4748faccc150
**Complexity:** 3
**Tags:** frontend, reliability, bugfix, ux, performance

## User Review Required

- **Failure threshold.** Proposed: three consecutive failed `/health` polls before the banner appears, so a transient network blip does not flash it. Deliberately not one.
- **Poll cadence.** Proposed: 5s, matching the terminal grid's existing fleet poll. The shell health poll can piggyback on or align with the existing poll rather than adding an independent timer.
- **Whether to attempt recovery at all.** Proposed: no. The shell cannot discover a new host — nothing on the old origin can tell it where the host went. Telling the truth beats a retry that cannot succeed. The banner is inert chrome plus a "restart the host" instruction.

## Complexity Audit

### Routine

- A consecutive-failure counter in `shell.js`, reset on any successful `/health` response.
- A shell-wide banner element (in `shell.js` or `shell.html`) with copy naming the recovery: restart the standalone host.
- Suppressing per-panel "connecting" / "failed to load" chrome while the shell-wide banner is up, so the shell presents one explanation rather than N.

### Complex / Risky

- **Do not confuse "host gone" with "pty host gone".** They are different servers on different ports (`terminals.js:11280` notes `PTY_HOST_ORIGIN` is a different server and must not be conflated). The API being unreachable means the shell is orphaned; the pty host being unreachable with the API alive is a fleet failure that already has its own reporting. Only the first case gets the shell-wide banner.
- **The counter must not double as a reconnect gate.** The WebSocket backoff at `:9992` is per-terminal and has its own semantics; this counter is shell-level and must not be threaded into it.
- **No `confirm()`, no modal.** Per project rule, and `window.confirm` is a silent no-op in a webview anyway. The banner is inert chrome.
- **The shell health poll must not duplicate the terminal grid's poll.** If the terminal grid already polls `/health` every 5s, the shell should either reuse that signal (listen for a failure event from the terminal grid) or stagger its poll to avoid doubling traffic. A shell-level `/health` poll that runs alongside the terminal grid's own poll is 2x the traffic for the same answer.

## Edge-Case & Dependency Audit

**Race Conditions**
- A host that comes back on a *new* port while the shell still polls the old one is indistinguishable from permanent death, and correctly so — the old origin is dead either way.
- Two shell tabs open on the same dead host both show the banner. That is correct; they are both orphaned.

**Security**
- No new route or transport. The banner is client-side state derived from failures the shell already observes.

**Side Effects**
- The banner is the first thing in the shell that says something about the host rather than the panels. It should not become a general error surface — one condition, one message.

**Dependencies & Conflicts**
- Touches `src/webview/shell.js` and possibly `src/webview/shell.html` (or whichever file owns the shell's chrome). It may also need to suppress per-panel failure chrome in `terminals.js`, but the detection and banner live in the shell.
- **Independent of the cutover staging.** The host-can-die case exists before and after the cutover. Post-Stage 2 the ephemeral-port orphan case is eliminated; only the standalone-host-died case remains, and the banner copy simplifies to "the host process stopped — restart it."

## Adversarial Synthesis

Key risks: (1) a shell-level `/health` poll doubles traffic if it runs alongside the terminal grid's existing poll — mitigate by reusing the terminal grid's failure signal or staggering; (2) suppressing per-panel chrome while the banner is up could hide a panel-specific failure that happens while the host is alive — mitigate by only suppressing when the shell-wide banner is actually displayed (host confirmed dead), not on a single transient failure.

## Verification Plan

### Automated
- Source-scan contract: assert `shell.js` (or the shell-level script) increments a counter on its `/health` failure path and resets it on success, and that the banner is gated on a threshold greater than one.
- Assert the banner's trigger reads the API-side failure counter and never `PTY_HOST_ORIGIN` state.

### Manual
1. Open the browser shell, confirm panels render, then kill the standalone host. Within three poll intervals the shell-wide banner appears and per-panel "connecting" / "failed to load" chrome is suppressed.
2. Refresh the orphaned shell: the failure is still explained rather than presenting a browser error page as the product's final state.
3. Restart the host mid-poll while the shell stays open on a *live* port (no reload): no banner — the transient failure is absorbed.
4. Standalone host killed mid-session: the banner appears within three poll intervals and names the recovery (restart the host process).

### Goal Invariants

- **Positive:** `shell.js` (or the shell-level script) has a consecutive-failure counter that increments on `/health` failure and resets on success.
- **Positive:** The banner is gated on a threshold greater than one (a single transient failure does not show it).
- **Negative:** The banner's trigger never reads `PTY_HOST_ORIGIN` state (host-gone is not pty-host-gone).
- **Negative:** No `data-host-capabilities` DOM attribute is introduced — the gate uses the `/health` response (or, post-Stage 2, plain consecutive API failures).
- **Negative:** No `window.confirm()` / modal gate is added to the banner (project rule).
- **Positive:** While the banner is up, per-panel failure chrome ("connecting", "failed to load") is suppressed — one explanation, not N.
- **Negative:** The detection and banner live at the shell level (`shell.js`/`shell.html`), not scoped to `terminals.js`/`terminals.html` alone.

## Outstanding Questions

- **[user]** Whether the shell should run its own `/health` poll or listen for a failure signal from the terminal grid's existing poll (which already fetches `/health` at `terminals.js:722`). — proceeding on the assumption of a shell-level `/health` poll, because the shell cannot depend on a specific panel being loaded (the user may not have the terminal grid open).
