# Completion Toasts Fire in Every Pop-Out Window, Not Just the Cockpit

## Goal

Make a completion notice appear **once**, in the cockpit, instead of once per open browser
window. Today every `?solo=<name>` terminal pop-out shows the same toast the cockpit shows,
for every agent completion in the workspace — including completions for terminals that
pop-out is not displaying and has no relationship to.

### The problem

Open the browser Switchboard, pop three terminals out into their own windows (the strip
button, or a pane's **Pop out** button). When any agent finishes, four toasts appear
simultaneously: one in the cockpit and one in each of the three pop-outs. A pop-out showing
`coder-1` announces the completion of `planner-2`, which it does not display and cannot act
on. With a nine-terminal run and several pop-outs open, one completion produces a wall of
identical notices across every window on the screen.

### Root cause

A pop-out is not a lightweight view — it is a **full second copy of the Terminals panel
document**. `shell.js` opens it as:

```js
const popoutUrl = `/terminals?solo=${encodeURIComponent(data.name)}`;
popout = window.open(popoutUrl, popoutName, features);
```

That route is served by the same `headlessPanelHtml` getter as the cockpit's Terminals
iframe, with the same `data-panel="terminals"` body attribute. `soloTerminalName` is read
from the query string and CSS (`body.is-solo`) hides the sidebar, toolbar and tab strip —
but the JavaScript is unchanged. Every pop-out therefore:

1. Runs `transport.js`, which reads `document.body.dataset.panel` and subscribes to
   `surfaces=terminals,common`.
2. Installs the same `window.addEventListener('message', …)` handler, including:

```js
} else if (message.type === 'agentCompleted') {
    handleAgentCompleted(message);
}
```

3. Runs the full `handleAgentCompleted` body — which sets a `DONE` badge, re-renders the
   sidebar and grid, refetches the fleet list, and ends unconditionally with:

```js
// The in-panel toast is the ONLY completion notice.
showCompletionToast(planTitle || 'Agent Task', role || 'Agent', targetTerm);
```

The broadcast itself is correct and is meant to be workspace-wide. `bootstrap.ts` sends it
on the shared surface:

```js
server.broadcastWs('agentCompleted', { planFile, planTitle, role, worktreePath, terminalName },
                   SURFACES.common);
```

`SURFACES.common` is delivered to every subscribed connection by design — that is how a
panel that was not focused still learns the state changed. The defect is not the fan-out;
it is that **every recipient renders a user-facing notification**, with no concept of which
document owns the notification surface.

There is a second, smaller half of the same defect. Each pop-out's `handleAgentCompleted`
also runs the state half — `terminalBadges.set(...)`, `renderSidebarList()`,
`renderPaneGrid()`, `postFleetStateToShell()` and an unconditional `fetchTerminalList()` —
for terminals it does not show. In a solo document the sidebar is `display:none` and the
grid holds exactly one pane, so the renders are wasted, and the refetch means one completion
triggers N+1 `ptyListTerminals` round trips instead of one.

### Background context

- `showTerminalErrorToast` is **not** affected and must not be changed: it fires from
  `ws.onmessage` on a specific terminal's own socket, so it only reaches documents actually
  attached to that terminal. That is already the correct scoping.
- `showPaneToast` is local action feedback (unassign undo, popup blocked, all-panes-pinned).
  It is only ever called from a user gesture in that document. Also unaffected.
- `handleAgentCompleted`'s badge is the durable record of an unacknowledged completion, and
  the shell rail reads it via `postFleetStateToShell`. The badge belongs to the **cockpit**,
  which is the document whose sidebar and grid actually render it.
- The extension-host half (`TaskViewerProvider.broadcastAgentCompleted`) calls
  `server.broadcastWs('agentCompleted', {...})` with **no surface argument** — an untagged
  frame, delivered to every connection regardless of its declared surfaces. That is a
  parity gap with the standalone path and is fixed here as part of the same change.

## Metadata

- **Complexity:** 3
- **Tags:** frontend, ui, ux, bugfix, backend
- **Project:** Browser Switchboard

## Complexity Audit

**Routine.** One guard in one webview function, plus a one-argument parity fix in the
extension-host broadcaster. No new message type, no new state, no persistence.

The one judgement call is *which* document owns the notification. Resolved: the cockpit
panel (`!soloTerminalName`). A pop-out is a viewport onto one terminal that the operator is
already watching — it is the surface with the least need for a notice about a different
terminal, and the cockpit is guaranteed to exist whenever a pop-out does (pop-outs are
opened from it).

## Edge-Case & Dependency Audit

1. **A pop-out showing the terminal that just completed.** It gets no toast under this
   change. That is correct: the operator is looking at that terminal's live output, which
   is a stronger signal than a toast summarising it. The cockpit still toasts, and the
   cockpit's badge/rail state is unchanged.

2. **Cockpit closed, pop-out open.** Not reachable in practice — a pop-out is opened by
   `shell.js` from the cockpit, and closing the cockpit tab closes nothing but leaves the
   pop-out with no notifier. Accepted: the terminal's own output is in front of the
   operator. Do not add a "promote a pop-out to notifier" election; it would need cross-
   document coordination for a case that costs the operator nothing.

3. **The panel loaded by direct navigation to `/terminals`** (no shell, no `solo` param).
   `soloTerminalName` is null, so it behaves as a cockpit and toasts. Correct — it is the
   only Terminals surface open.

4. **The extension-host webview.** Never solo (`?solo=` is a browser-shell URL), so
   behaviour there is unchanged.

5. **State vs. notification.** The badge, the re-renders and the refetch must be skipped in
   a solo document too, but for a different reason (waste, not duplication). Skipping them
   must not break the one thing a solo document does need from this message: nothing. A solo
   document's single pane is driven by its own WebSocket, and `fetchTerminalList` still runs
   on the 5 s poll and on `terminalsChanged`.

6. **`postFleetStateToShell()` from a pop-out.** A pop-out has no shell parent
   (`window.parent === window`), so this is already a no-op there; removing the call from
   the solo path removes a wasted call, not a behaviour.

7. **Surface parity.** After tagging the extension-host broadcast with `SURFACES.common`,
   confirm it still reaches the Terminals panel — `PANEL_SURFACES_MAP.terminals` is
   `['terminals', 'common']`, so it does. A panel with no `PANEL_SURFACES_MAP` entry
   (`project`) sends no `surfaces` parameter and receives the full stream, so it is
   unaffected either way.

8. **Older clients.** A cached webview from a previous version has no `soloTerminalName`
   guard and will keep toasting in pop-outs until reload. Acceptable — no persisted state is
   involved, so a reload is the whole migration.

## Proposed Changes

### 1. `src/webview/terminals.js` — the cockpit owns the completion notice

Guard `handleAgentCompleted` at the top. Both halves — the badge/render state and the toast
— belong to the cockpit.

```js
    /**
     * Workspace-wide completion push. Delivered to EVERY subscribed connection by
     * design (SURFACES.common), which includes every `?solo=<name>` pop-out — each one
     * is a full second copy of this document, not a lightweight view. Without this
     * guard, one completion produced one toast per open window, and each pop-out also
     * ran a badge write, two re-renders and a ptyListTerminals refetch for a terminal
     * it does not display.
     *
     * The COCKPIT owns this notice. It is the document that renders the sidebar DONE
     * chip and relays the rail state, and it is guaranteed to exist whenever a pop-out
     * does (shell.js opens pop-outs from it). A pop-out showing the completed terminal
     * has the terminal's own output in front of the operator, which is a stronger
     * signal than a toast summarising it.
     *
     * Deliberately NOT applied to showTerminalErrorToast: that fires from a specific
     * terminal's own socket, so it only reaches documents attached to that terminal —
     * already correctly scoped.
     */
    function handleAgentCompleted(msg) {
        if (soloTerminalName) { return; }
        const { planTitle, role, terminalName, worktreePath } = msg;
        // … unchanged body …
    }
```

Placing the guard at the function top (rather than only around `showCompletionToast`) is
deliberate — it removes the wasted badge write, the two re-renders and the extra
`fetchTerminalList()` from every pop-out on the same line.

### 2. `src/services/TaskViewerProvider.ts` — tag the extension-host broadcast

The standalone bootstrap already tags this push; the extension-host half does not, so it
ships untagged and is delivered to every connection regardless of declared surfaces. Bring
it into parity.

```ts
            server.broadcastWs('agentCompleted', {
                planFile: record.planFile,
                planTitle: record.topic,
                role: record.dispatchedAgent,
                worktreePath: worktreePath || undefined,
                terminalName: terminalName || undefined,
-            });
+            }, SURFACES.common);
```

Add `SURFACES` to the existing import block from the wsHub module if it is not already
imported in this file, matching how `bootstrap.ts` imports it.

The doc comment on `broadcastAgentCompleted` claims it "mirrors the standalone bootstrap
wiring verbatim" — update it so the claim is true, or the next reader will trust it over
the code again.

## Verification Plan

1. **The reported repro.** Open the browser Switchboard, pop three terminals out. Trigger a
   completion (dispatch a plan and let the agent write its plan file). Expect exactly
   **one** toast — in the cockpit — and none in any pop-out.
2. **Pop-out showing the completed terminal.** Pop out `coder-1`, dispatch to `coder-1`, let
   it complete. Expect no toast in that pop-out and one in the cockpit. Confirm the cockpit
   still shows the sidebar `DONE` chip and the shell rail still pulses.
3. **No wasted refetch.** With the network panel open in a pop-out, trigger a completion.
   Expect zero `POST /terminals/verb/ptyListTerminals` calls attributable to the completion
   in that window (the 5 s poll still runs — count only the burst at completion time).
4. **Direct navigation.** Open `/terminals` directly (no shell, no `solo` param). Trigger a
   completion. Expect a toast — this surface is a cockpit, not a pop-out.
5. **Error toasts unaffected.** Kill a pty that a pop-out is attached to. Expect that
   pop-out's terminal-error toast to still appear. Confirm the guard did not leak into
   `showTerminalErrorToast`.
6. **Local toasts unaffected.** In a pop-out, trigger a `showPaneToast` path (e.g. paste an
   oversized image). Expect the toast to appear in that window.
7. **Extension-host parity.** Run the same repro under the VS Code extension host with the
   browser cockpit attached to its API server. Expect one toast, and confirm via the WS
   frame log that the `agentCompleted` frame now carries `surface: 'common'` rather than
   arriving untagged.
8. **Surface filtering did not over-restrict.** Confirm the Terminals panel still receives
   the frame after the tag (`PANEL_SURFACES_MAP.terminals` includes `common`), and that no
   other panel that previously acted on `agentCompleted` has lost it — grep for
   `agentCompleted` across `src/webview/` and confirm `terminals.js` is the only consumer.
9. `node --check src/webview/terminals.js` clean; `npm run compile-tests` clean for the
   TypeScript change.
