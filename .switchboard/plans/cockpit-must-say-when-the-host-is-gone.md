# The Cockpit Polls a Dead Host Forever Without Saying So

## Goal

Give the browser cockpit a visible host-offline state: when the extension host it was served from goes away, the panel says so and tells the user how to recover, instead of showing terminals stuck on `connecting` indefinitely.

### Problem Analysis

The cockpit is served from `LocalApiServer` on an **ephemeral port** — `this._port = options.port || 0` (`LocalApiServer.ts:648`), so the OS assigns one per extension-host lifetime, and `_terminalSessionToken` is regenerated alongside it. A VS Code window reload therefore invalidates both the port in the tab's URL and the token in its markup.

Three things then happen, none of them visible:

1. **Every fetch fails silently.** `fetchTerminalList`'s handler is `catch { /* ignore — the next fleet poll will pick it up */ }` (`terminals.js:2159`). There is no next successful poll: the port is gone.
2. **Reconnect never arms.** `ws.onclose` only schedules a retry when `fleetList.find(i => i.friendlyName === entry.name)` reports `status === 'active'` (`:9992`) — and `fleetList` is populated by the fetch that just failed. So the panes settle on `connecting` and stay there.
3. **Refreshing does not help.** The tab's URL carries the old port. A reload is a connection refused, which reads as "the tool is broken", not "reopen it from VS Code".

**Why this matters more now.** With terminal teams, grids, seats and queues living only in the cockpit — and VS Code terminals scoped to simple single-seat work — a cockpit that has gone quiet without saying so is the product being unavailable with no explanation. The silence was a papercut when VS Code terminals were an equal surface. It is not one now.

**The ignore comment is correct for its original case and wrong for this one.** A single failed poll during an extension-host restart genuinely is transient. The bug is that one transient failure and permanent death are indistinguishable to the panel, because nothing counts.

## Metadata

**Complexity:** 3
**Tags:** frontend, reliability, bugfix, ux

## User Review Required

- **Failure threshold.** Proposed: three consecutive failed fleet polls before the banner appears, so an extension-host restart does not flash it. Deliberately not one.
- **Whether to attempt recovery at all.** Proposed: no. The panel cannot discover the new port — nothing on the old origin can tell it. Telling the truth beats a retry that cannot succeed.

## Complexity Audit

### Routine

- A consecutive-failure counter in `fetchTerminalList`, reset on any success.
- A banner element in `terminals.html` with copy naming the recovery: reopen Terminal Grid from VS Code (the Hub entry or the sidebar button).
- Suppressing the per-pane `connecting` chip while the banner is up, so the panel presents one explanation rather than nine.

### Complex / Risky

- **Do not confuse "host gone" with "pty host gone".** They are different servers on different ports (`terminals.js:11280` notes `PTY_HOST_ORIGIN` is a different server and must not be conflated). The API being unreachable means the panel is orphaned; the pty host being unreachable with the API alive is a fleet failure that already has its own reporting. Only the first case gets the banner.
- **The counter must not double as a reconnect gate.** The WebSocket backoff at `:9992` is per-terminal and has its own semantics; this counter is document-level and must not be threaded into it.
- **Standalone host must not show it spuriously.** In the standalone bootstrap the cockpit is served by a process the user started directly; a failed poll there means something different. Gate on the host capability the page already carries in `data-host-capabilities` rather than assuming the extension host.
- **No `confirm()`, no modal.** Per project rule, and `window.confirm` is a silent no-op in a webview anyway. The banner is inert chrome plus a copy-the-command affordance at most.

## Edge-Case & Dependency Audit

**Race Conditions**
- A restart that comes back on a *new* port while the tab still polls the old one is indistinguishable from a permanent death, and correctly so — the old origin is dead either way.
- Two cockpit tabs open on the same dead host both show the banner. That is correct; they are both orphaned.

**Security**
- No new route or transport. The banner is client-side state derived from failures the panel already observes.

**Side Effects**
- The banner is the first thing in this panel that says something about the host rather than the fleet. It should not become a general error surface — one condition, one message.

**Dependencies & Conflicts**
- Touches `src/webview/terminals.js` and `src/webview/terminals.html` only. It will contend textually with in-flight terminals work in those files; it is small and should land early rather than queue behind them.
- **Optional follow-on, not included:** a configurable stable API port so a bookmarked tab survives a reload. That is a different plan with its own security surface (a fixed loopback port is a longer-lived target than an ephemeral one) and should not be smuggled in here.

## Verification Plan

### Automated
- Source-scan contract in the shape of `src/test/terminal-pane-fit-verification-contract.test.js` (the panel is a browser-only IIFE with no export surface): assert `fetchTerminalList` increments a counter on its failure path and resets it on success, and that the banner is gated on a threshold greater than one.
- Assert the banner's trigger reads the API-side failure counter and never `PTY_HOST_ORIGIN` state.

### Manual
1. Open Terminal Grid, confirm terminals stream, then reload the VS Code window. Within three poll intervals the banner appears and the per-pane `connecting` chips are suppressed.
2. Refresh the orphaned tab: the failure is still explained rather than presenting a browser error page as the product's final state.
3. Restart the extension host mid-poll while the tab stays open on a *live* port (no reload): no banner — the transient failure is absorbed.
4. Standalone host, `npx` bootstrap: no banner on a transient poll failure.
