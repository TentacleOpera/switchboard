# Out-of-Process PTY Host

**Complexity:** 6

## Goal

Move the browser PTY terminal gateway out of the extension host and into its own process, so terminal frames never queue behind the extension's other work.

Measured with a 30-sample ping round trip over the terminal WebSocket, the identical gateway responds in 0.24 ms p50 in its own process versus 35.21 ms p50 inside the extension host, against a 0.06 ms bare-loopback control. The delay is event-loop contention on the extension host, not transport, framing or xterm — VS Code's own terminal feels native precisely because it runs a dedicated pty host process.

The extension becomes control plane only: it spawns and supervises the pty host, forwards infrequent control verbs, and never carries terminal bytes. Proxying the WebSocket through the extension would put every frame back on the contended loop and re-incur the full 35 ms, so the panel connects directly to the pty host port instead.

## How the Subtasks Achieve This

- **Extract the PTY Host Into Its Own Process (1/3)**: Adds `src/standalone/ptyHost.ts`, which boots a `PtyFleetService` and a `TerminalWsGateway` on their own HTTP server in their own OS process, and reports `{port, token}` on stdout. This is cheap because the whole stack is already portable — `terminalWsGateway.ts`, `ptyFleetService.ts`, `ptyBackend.ts` and `services/wsUpgradeAuth.ts` contain zero `vscode` imports, and the fleet's database argument is optional and used only for registry mirroring, so the child runs without one and the extension stays the sole sqlite writer. Ships no user-visible change; it exists so the other two have something to point at.

- **Make the Extension a Control Plane for the PTY Host (2/3)**: Rewires `TaskViewerProvider` to spawn and supervise that child instead of constructing the fleet and gateway in-process, forwards the six existing pty verbs plus a new `ptyWrite` over HTTP, and stops injecting a gateway into `LocalApiServer`. This is the subtask that actually removes terminal bytes from the extension's event loop. Its design risk — whether the four `listActive()` routing lookups needed a cached fleet mirror — resolved favourably: all four already sit in async scopes and can simply await a remote call.

- **Point the Terminals Panel Directly at the PTY Host (3/3)**: Gives the panel an explicit pty-host origin instead of assuming its socket lives on the page's own origin, so the browser dials the pty host port directly. Injected at serve time as a `data-pty-host-origin` body attribute, following the precedent `data-terminal-token` already sets at `TaskViewerProvider.ts:2059` — not an HTML placeholder, which would diverge from that precedent one line away and add an unsubstituted-literal failure class. One line in `terminals.js` plus a `location.host` fallback keeps the standalone host byte-identical, and no CSP work is needed since `terminals.html` already permits `ws://127.0.0.1:*`. Plan review also turned up a genuine blocker folded into this subtask: `wsUpgradeAuth.ts` 403s the `vscode-webview://` origin the sidebar sends, so the sidebar socket would fail even on plain local desktop until the allow-list accepts that scheme.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Extract the PTY Host Into Its Own Process (1/3)](../plans/feature_plan_20260801203937_pty-host-out-of-process.md) — **CODER CODED**
- [ ] [Make the Extension a Control Plane for the PTY Host (2/3)](../plans/feature_plan_20260801203938_extension-pty-control-plane.md) — **CODER CODED**
- [ ] [Point the Terminals Panel Directly at the PTY Host (3/3)](../plans/feature_plan_20260801203939_terminals-panel-direct-connect.md) — **CODER CODED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

Strictly ordered 1 → 2 → 3. These are not parallelisable.

- **2 depends on 1** — there is no child process to spawn or forward verbs to until `ptyHost.ts` exists and exposes the seven control verbs.
- **3 depends on 1** for a port to point at, and **must ship together with 2**. Between them the panel targets an origin that serves nothing: 2 removes `/ws/terminal` from the extension host, and only 3 tells the panel where it moved. Landing either alone leaves terminals broken under the extension host.

### Both stop-and-re-scope gates are now closed

This feature was written with two gates that could have invalidated work already done. Plan review closed both, so there is no longer anything to resolve before starting subtask 1.

- **Webview cross-port WebSocket — viable.** `vscode-webview://` is a registered secure scheme, loopback is a trustworthy origin, and the page's existing meta CSP already permits `ws://127.0.0.1:*`. Subtask 3's probe survives as cheap confirmation, not a precondition.
- **`TaskViewerProvider.ts:12530` — async.** It sits inside `private async _handleMessage` (line 315), like the other four touchpoints, so it converts to an awaited forward. The cached-fleet-mirror contingency is dead; nothing needs re-scoping.

Review also surfaced one real defect, now folded into subtask 3 rather than left to be discovered: `wsUpgradeAuth.ts:56-58` rejects the `vscode-webview://` origin Chromium sends on the sidebar's upgrade request, so that socket would 403 even on plain local desktop. Subtask 3 extends the allow-list to accept the scheme exactly, leaving token auth untouched.

### Scope boundary — local desktop only

Remote SSH, Dev Containers, WSL and `vscode.dev` are **out of scope by decision**, not by oversight. The panel dials a raw loopback port that resolves to the wrong machine under all of them. Switchboard's browser terminal is not a remote tunnel: anyone working over a tunnel runs Switchboard in VS Code and uses VS Code's own native terminals, which already work over the remote connection.

Recorded here because plan review has already drifted into it once, proposing `asExternalUri` origin resolution to make remote work. **No `asExternalUri`, no port forwarding, no fallback bridge.** Reviewers should treat a proposal to add them as out of scope rather than as a gap to close.

### Definition of done

Each subtask's verification ends on the same 30-sample ping RTT probe that produced the 35.21 ms baseline. Sub-millisecond p50 measured from the panel itself, under a busy extension host, is the only evidence that the feature achieved its goal — "terminals still work" is not sufficient, because a convenience proxy added anywhere in the data path would pass that check while restoring the full latency.

## Completion Summary
Implemented out-of-process PTY host process extraction, control plane forwarding, and direct browser panel connections across all three subtasks. Created `src/standalone/ptyHost.ts` and updated `webpack.config.js` to build it. Rewired `TaskViewerProvider.ts` to spawn `ptyHost.js`, forward PTY verbs over HTTP, inject `data-pty-host-origin`, and terminate the child on exit. Updated `terminals.js` to connect directly to `PTY_HOST_ORIGIN` and updated `wsUpgradeAuth.ts` to allow `vscode-webview:` origins. No issues encountered.

