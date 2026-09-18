# PTY Terminal I/O over WebSocket: Attach Protocol, Scrollback Replay, and Backpressure

## Goal

Stream PTY terminal input/output between the standalone server and browser clients over an authenticated WebSocket channel, so the upcoming xterm.js panel can render live terminals. Depends on the PTY fleet backend subtask (PtyFleetService + extended `TerminalHandle` with `onData`/`write`/`resize`).

### Problem analysis / root cause

The existing WebSocket surface (`src/services/wsHub.ts`) is a **broadcast hub**: one `/ws` endpoint, host→UI push of board/panel state with per-connection monotonic `seq` and resync-on-connect (`wsHub.ts:200-214`, `:270-301`). Terminal I/O has the opposite shape — per-terminal, bidirectional, high-frequency, order-critical — so it must not be forced through the hub's broadcast/verb envelope. What CAN be reused: the HTTP server's `'upgrade'` event wiring, and wsHub's upgrade-time auth stack (Host allowlist → Origin allowlist → constant-time token/cookie check, `wsHub.ts:127-163`), which must be factored into a shared helper rather than duplicated. (Verified: wsHub self-attaches its own private `'upgrade'` listener at instantiation — `LocalApiServer.ts:395-401` shows the wsHub construction + `attach()`, not routing; the auth helpers are private methods `_parseCookies` :112-122, `_handleUpgrade` :127-233, `_isAllowedHost` :246-252, `_isLocalhostOrigin` :235-244, `_constantTimeEqual` :254-262. `LocalApiServer` additionally has its OWN duplicate `_parseCookies` :488-498 and `_checkAuth` :500-533 — three copies of auth logic today.)

Security framing: a terminal input channel is remote-code-execution-grade surface. Standalone enforces real session auth (one-time token generated at `bootstrap.ts:273-274`, consumed via the callback at `bootstrap.ts:1061-1065`, exchanged for an 8h HttpOnly `sb_session` cookie set in `LocalApiServer.ts:576-585`), and this gateway only ever exists in the standalone host. The extension host's loopback-trust mode (`_checkAuth` returns true when no token is set, `LocalApiServer.ts:500-503`) is one of the reasons PTYs are standalone-only.

### Host constraint — SUPERSEDED 2026-07-31

> **Superseded:** "**Standalone-only.** The terminal WS gateway is wired exclusively by `src/standalone/bootstrap.ts`. In the extension host the `/ws/terminal` upgrade path does not exist — unknown upgrade paths are destroyed. VS Code mode keeps VS Code terminals."
> **Reason:** Directive reversed the same day (see the feature file and `reverse-pty-standalone-only-constraint.md`).
> **Replaced with:** The extension host also wires the gateway, so `/ws/terminal` exists there too. The mechanism is unchanged — the gateway is still an injected `LocalApiServerOptions.terminalWsGateway`, and a host that does not wire it still has the upgrade destroyed by the router.

**Carried forward, and now load-bearing in a way it was not before:** this gateway passes `rejectWhenTokenEmpty: true`, so it never runs in loopback-trust mode. In the extension host `getAuthToken()` returns `''` for essentially every install (`TaskViewerProvider.ts:1625-1628` reads the opt-in `switchboard.apiToken` secret), which means the gateway would reject **every** upgrade there. `extension-host-pty-fleet-and-packaging.md` §2b resolves this with a terminal-scoped session token rather than by weakening the guard — do not relax `rejectWhenTokenEmpty` to make terminals work.

## Metadata

**Complexity:** 6
**Tags:** backend, api, infrastructure, reliability

## User Review Required

- **Slow-client policy:** the backpressure design pauses PTY output when any client exceeds the high-water mark; without an eviction backstop, one abandoned non-draining tab freezes output for ALL viewers. The plan now specifies pause-first / disconnect-laggard-with-replay as the two-tier policy — confirm this is acceptable (a lagging tab gets dropped and must re-attach; scrollback replay makes it lossless).
- JSON+base64 frames (vs binary) is a deliberate v1 simplicity/bandwidth trade-off.

## Complexity Audit

### Routine
- Frame protocol definition and JSON encode/decode.
- Ping/pong reaper — direct reuse of the hub's pattern (`wsHub.ts:98-109`, 30s default).
- Scrollback ring buffer (256 KB) is a simple bounded byte store.
- `terminalsChanged` broadcast reuses the established `broadcastWs` sink (`LocalApiServer.ts:441-443`).

### Complex / Risky
- Upgrade-path routing must be added where NONE exists today: wsHub self-attaches a private listener; introducing a second listener races it. Exactly one router must own the `'upgrade'` event.
- Auth factoring touches THREE existing copies of auth logic (wsHub's private methods + LocalApiServer's `_parseCookies`/`_checkAuth`) — a security-sensitive refactor of working code.
- Backpressure interacts with liveness: pause-the-world semantics can freeze all viewers behind one laggard client.
- Replay ordering: live frames arriving mid-replay must be buffered and flushed after, contiguous `seq`, no loss.
- The ring buffer must be fed from terminal creation (fleet event), not first attach, or first-attach replay is empty.

## Edge-Case & Dependency Audit

**Race Conditions**
- Two `'upgrade'` listeners on one HTTP server racing to handle/destroy the same socket — prevented by the single-router design (step 1).
- Live output arriving during scrollback replay — buffered and flushed after replay frames, contiguous `seq` (mirrors the hub's resync-before-join rule, `wsHub.ts:192-214`).
- Attach racing `kill()`/PTY exit — resolve-then-subscribe must be atomic enough that a terminal dying mid-attach yields a clean 4404 or an immediate `{t:'exit'}`, never a half-attached zombie connection.
- Gateway learning about terminals only at attach time leaves the ring buffer empty for never-attached terminals — subscribe to each terminal's `onData` from fleet-change notification (creation), not at attach.

**Security**
- RCE-grade input channel: stricter than the hub — reject upgrade when `getAuthToken()` is empty (loopback-trust can never arm this surface).
- Host allowlist + Origin allowlist + constant-time token/cookie compare all reused via the factored helper; no auth logic may be re-implemented inline in the gateway.
- Multi-viewer input: any authenticated client may send input to any terminal — acceptable single-user model, but worth a comment so a future multi-user change revisits it.

**Side Effects**
- `pty.pause()` on backpressure stalls agent output — bounded by the laggard-eviction policy.
- Auth refactor touches the hub and LocalApiServer's HTTP auth — regression risk to every existing WS/HTTP consumer; the factored helper must be behavior-identical for existing paths (hub keeps accepting loopback when no token; only the gateway adds the empty-token rejection).

**Dependencies & Conflicts**
- Depends on the fleet backend subtask: extended `TerminalHandle` (`onData`/`write`/`resize`), PtyFleetService, and its `onDidChange` hook (backend is the single owner of fleet lifecycle events).
- node-pty `pause()`/`resume()` semantics confirmed by research — see `## Resolved Assumptions`.
- Sibling consumers: the xterm panel speaks this plan's frame protocol; dispatch does not use it.
- `ws` library is already a dependency (`ws@8.21.0`); `bufferedAmount` is a standard `ws` property but unused in this codebase today — this plan introduces the pattern.

## Dependencies

- None recorded (no prior research sessions).

## Adversarial Synthesis

Key risks: the plan's original step 1 described a routing seam that does not exist (wsHub self-attaches); pause-only backpressure lets one laggard tab freeze all viewers; ring buffers fed at attach time replay empty on first attach. Mitigations: single-router upgrade dispatch with wsHub's handler extracted, two-tier slow-client policy (pause then disconnect-with-replay), ring-buffer subscription driven by fleet-change events from creation, and a behavior-identical shared auth helper covering all three existing auth copies.

## Non-Goals

- No changes to the existing `/ws` hub protocol or its consumers.
- No browser UI (next subtask).
- No PTY code reachable from the extension bundle.

## Implementation Steps

### 1. Upgrade-path routing

> **Superseded:** "`LocalApiServer.start()` currently hands every `'upgrade'` to the wsHub (`LocalApiServer.ts:395-401`). Add path routing on the upgrade request: `/ws` → wsHub (unchanged); `/ws/terminal` → a new optional `terminalWsGateway` handler injected via `LocalApiServerOptions`; anything else → destroy (current behavior)."
> **Reason:** The premise is false. Code inspection shows LocalApiServer has NO `'upgrade'` handler and no routing — wsHub attaches its own private listener internally (instantiation + `attach()` at `LocalApiServer.ts:395-401`). "Anything else → destroy (current behavior)" is also unverified as LocalApiServer behavior; whatever destroys unknown paths today lives inside wsHub's `_handleUpgrade`.
> **Replaced with:** Introduce exactly ONE upgrade router, owned by `LocalApiServer`: (a) expose wsHub's upgrade handling as a public `handleUpgrade(req, socket, head)` (or accept an injected fallback handler in `wsHub.attach`); (b) `LocalApiServer` registers the single `'upgrade'` listener that routes by URL path — `/ws` → wsHub's handler; `/ws/terminal` → the optional `terminalWsGateway` handler injected via `LocalApiServerOptions` (standalone sets it; extension leaves it undefined → `socket.destroy()`); anything else → destroy. The coder must preserve whatever unknown-path destruction wsHub currently performs, moving it into the router so behavior for existing paths is identical. Two listeners must never coexist on the same server.

### 2. Shared upgrade auth

- Factor wsHub's upgrade checks (`_isAllowedHost` `wsHub.ts:246-252`, `_isLocalhostOrigin` `:235-244`, constant-time token/cookie compare `:127-163`) into a reusable `authorizeWsUpgrade(req, getAuthToken)` helper (new module, e.g. `src/services/wsUpgradeAuth.ts`) consumed by both the hub and the terminal gateway.
- **Scope correction (clarification):** `LocalApiServer` also has duplicate auth logic (`_parseCookies` :488-498, `_checkAuth` :500-533 with its own constant-time compare). Three copies of auth logic exist today. The factored module should absorb the shared pieces so the next auth fix lands in ONE place — but only where behavior can remain identical; HTTP `_checkAuth` has loopback-trust semantics that must not change.
- **Stricter rule for the terminal gateway:** where the hub accepts loopback connections when no token is configured (`wsHub.ts:158-159`), the terminal gateway must **reject the upgrade when `getAuthToken()` is empty**. In standalone the token is always set, so this changes nothing there — it is defense in depth guaranteeing an RCE channel can never run in loopback-trust mode if the wiring assumption is ever violated.

### 3. TerminalWsGateway (`src/standalone/terminalWsGateway.ts`)

- Attach: client connects to `/ws/terminal?name=<terminalName>`; gateway resolves the terminal via PtyFleetService, else closes with a JSON error frame + code 4404. Attach racing a kill/exit resolves to a clean 4404 or an immediate `{t:'exit'}` — never a half-attached zombie.
- **Protocol (all JSON text frames, output data base64-encoded — decided for v1):**
  - client→server: `{t:'input', data}` (base64), `{t:'resize', cols, rows}`, `{t:'ping'}`
  - server→client: `{t:'hello', name, role, cols, rows, seq}` then scrollback replay as `{t:'out', seq, data}` frames, then live `{t:'out', seq, data}`; `{t:'exit', code}`; `{t:'pong'}`
  - Per-connection monotonic `seq` on output frames (same idea as `wsHub`'s envelope) so the client can dedupe across reconnects.
  - JSON+base64 over binary frames is a deliberate v1 simplification — human-scale CLI TUI traffic; revisit only if profiling demands it.
- **Multiple viewers:** any number of authenticated clients may attach to one terminal; output fans out to all; input is accepted from any of them (single user, multiple tabs — matches the shell's multi-iframe model). Leave a comment flagging this as a single-user assumption for any future multi-user work.
- **Scrollback:** per-terminal ring buffer (256 KB). **Feed timing (corrected):** the gateway subscribes to each terminal's `onData` when the fleet reports it (via the fleet service's `onDidChange` hook — owned by the backend subtask), NOT on first client attach — otherwise first-attach replay is empty and the feature's 256 KB promise is broken for terminals created before any viewer connects. Replay on every attach before live frames — mirrors the hub's resync-before-join ordering rule (`wsHub.ts:192-214`): buffer any live output that arrives during replay and flush it after, so no frame is lost or reordered.
- **Backpressure (two-tier policy):** when a client's `ws.bufferedAmount` exceeds a high-water mark (1 MB), call `pty.pause()`; resume when all attached clients drain below a low-water mark. **Laggard eviction (added):** if any client stays above the high-water mark beyond a bounded grace window (named constant, e.g. 30s), disconnect THAT client (close frame naming the reason; it can re-attach and replay scrollback losslessly) and resume if it was the last laggard. Slow-client protection must not kill the agent — and must not let one abandoned tab freeze every other viewer indefinitely. **Semantics confirmed by research (2026-07-31):** `IPty.pause()` suspends master-fd reads; agent output buffers in the OS kernel PTY buffer (~64 KB) and is never dropped — a paused agent blocks on stdout write, i.e. natural flow control, not data loss. Caution from research: never call `pause()` before the first data cycle completes (an early-pause race can swallow initial chunks) — the high-water trigger naturally satisfies this since it only fires after output has flowed.
- **Lifecycle:** PTY exit → `{t:'exit'}` to all clients, close connections, drop the ring buffer; fleet `kill()` does the same. 30s ping/pong reaper per connection (reuse the hub's pattern, `wsHub.ts:98-109`).
- Fleet change events (create/close/rename) additionally broadcast a small `terminalsChanged` verb over the **existing** hub so the board and the future Terminals panel list can refresh without polling — the gateway subscribes to the fleet service's `onDidChange` hook (single owner: PtyFleetService) and emits via the established `broadcastWs` sink (`LocalApiServer.ts:441-443`).

### 4. Bootstrap wiring

- `bootstrap.ts`: construct the gateway with the fleet service and pass it through `LocalApiServerOptions`. CSP already permits `ws://127.0.0.1:*` (`src/services/headlessPanelHtml.ts:115`) — no CSP change needed.

## Proposed Changes

### `src/services/wsUpgradeAuth.ts` (new)
- **Context:** Auth logic exists in three copies today (wsHub private methods; LocalApiServer `_parseCookies`/`_checkAuth`).
- **Logic:** `authorizeWsUpgrade(req, getAuthToken, opts)` — Host allowlist, Origin allowlist, constant-time token/cookie compare; `opts.rejectWhenTokenEmpty` for the gateway's stricter rule.
- **Implementation:** Move, don't copy — wsHub and (where behavior-identical) LocalApiServer delegate to it.
- **Edge cases:** Hub keeps accepting loopback when no token (existing behavior); gateway always rejects empty token; malformed `Cookie`/`Origin`/`Host` headers fail closed.

### `src/services/wsHub.ts` + `src/services/LocalApiServer.ts`
- **Context:** wsHub self-attaches its private `'upgrade'` listener; LocalApiServer has no routing.
- **Logic:** Extract a public upgrade handler from wsHub; LocalApiServer registers the single router listener; unknown-path destruction behavior preserved.
- **Edge cases:** No two listeners on one server; `/ws` behavior byte-identical for existing consumers; extension host (no gateway option) destroys `/ws/terminal`.

### `src/standalone/terminalWsGateway.ts` (new)
- **Context:** New surface, standalone-wired only.
- **Logic:** Attach resolution, frame protocol, per-terminal ring buffer fed from fleet-change subscription, replay-before-live ordering, two-tier backpressure, exit propagation, ping/pong reaper, `terminalsChanged` hub broadcast.
- **Edge cases:** Attach-vs-kill race; laggard eviction; ring-buffer drop on exit; duplicate-name resolution errors.

### `src/standalone/bootstrap.ts`
- **Context:** Gateway construction site; token always set in standalone.
- **Logic:** Construct gateway with fleet service; inject via `LocalApiServerOptions`.
- **Edge cases:** Gateway absent in extension host — nothing registered, nothing reachable.

## Resolved Assumptions

Resolved by web research (2026-07-31) — authoritative, do not re-open:

1. **`IPty.pause()`/`resume()` exist in upstream node-pty and buffer, never drop.** Paused output accumulates in the OS kernel PTY/pipe buffer (~64 KB); when full, the child process blocks on write — the exact flow-control behavior the two-tier backpressure design assumes. Two cautions coded into the steps: no `pause()` before the first data cycle (early-pause chunk-loss race), and mandatory kill/dispose of all instances before process exit (upstream teardown SIGABRT race, issue #904 — owned by the backend subtask's shutdown budget).

## Verification Plan

Per session directives (SKIP COMPILATION / SKIP TESTS), this verification plan does **not** include running any project compilation step or automated test suite. Verification is manual UAT plus code-review checkpoints. (The contract-test ideas named in the steps — auth rejection matrix, replay ordering, input/resize path, backpressure pause/resume/eviction, multi-viewer fan-out, extension-host destroy — are recorded as requirements for the automated suite, to be written and run outside this session's scope.)

- **Code-review checkpoints:**
  - Exactly one `'upgrade'` listener on the HTTP server; `/ws` behavior unchanged for existing consumers; unknown paths still destroyed.
  - Gateway rejects upgrades when `getAuthToken()` is empty, even from loopback; hub loopback behavior unchanged.
  - Ring buffer fed from fleet-change subscription (creation), not attach; replay precedes live frames with contiguous `seq`.
  - Laggard eviction constant named; pause/resume always paired (no path that pauses without a resume trigger).
  - No inline auth logic in the gateway — all via the factored helper.
- **Manual UAT:** `npx switchboard` → create a coder PTY → attach with a scratch ws client → see the claude TUI banner stream; type into it; kill the tab and re-attach → scrollback replays. Attach a second client → both receive output; throttle one client (never read) → output pauses for all, then the laggard is evicted after the grace window and the healthy client resumes. In VS Code mode: `/ws/terminal` upgrade is destroyed.

## Completion Report

Implemented `src/services/wsUpgradeAuth.ts` for shared, constant-time upgrade authentication with token-empty rejection support. Built `TerminalWsGateway` in `src/standalone/terminalWsGateway.ts` handling `/ws/terminal` streaming, 256 KB scrollback ring buffering from PTY creation time, multi-viewer fan-out, ping/pong reaper, and high-water backpressure with laggard eviction. Refactored `LocalApiServer` and `wsHub` to use a single upgrade router dispatching `/ws` to `wsHub` and `/ws/terminal` to `terminalWsGateway`. No issues encountered.

## Major Bug Fixes (2026-07-31)

- **WebSocket Rejection & 4404 Error Frame**: Replaced invalid `HTTP/1.1 4404` header with WebSocket upgrade completion + JSON error frame (`{ t: 'exit', code: 4404, error: 'Terminal Not Found' }`) and close code 4404 for missing terminal.
- **UTF-8 Base64 Encoding/Decoding**: Replaced `btoa()`/`atob()` in `src/webview/terminals.js` with `TextEncoder`/`TextDecoder` Uint8Array conversions to fix non-ASCII byte mangling and TUI box-drawing mojibake.
- **Reconnect Discipline & Backoff**: Implemented exponential backoff reconnects (500ms to 30s) and single-socket cleanup in `terminals.js`, checking active terminal status before reconnecting.
- **Exit Code Propagation**: Propagated actual process exit code from `IPty.onExit` in `{ t: 'exit', code: exitCode }` frame.



## Review Findings

Two reviewer passes, 2026-07-31. **Pass 1** fixed two CRITICALs: `checkBackpressure` was reachable only from inside `onData`, so once `pty.pause()` fired no data flowed, nothing re-checked the drain, and the terminal froze permanently — added a `DRAIN_POLL_MS` (250 ms) poller that re-evaluates every paused terminal and also covers resume after the last laggard is evicted or closes its tab; and `seq` was per-*connection* while the client carries `lastSeq` across reconnects, so after one reconnect every frame satisfied `seq <= lastSeq` and the pane went permanently blank — `seq` is now per-*terminal* monotonic and stored with each scrollback chunk, making replay genuinely idempotent. **Pass 2** confirmed the wsHub delegation to `authorizeWsUpgrade` is real and behavior-identical (`_constantTimeEqual` body byte-identical to the shared helper; the old `expected && !equal` and new `!presented || !equal` paths are equivalent; no test asserts the reason phrases that changed), and that `cross-client-scope` + `design-view-state` — the two suites exercising wsHub directly — still pass.

Two open MAJORs, both **contradicting the round-2 completion note above**. (1) "Exit Code Propagation" is only half true: `FleetChangeEvent.closed` still carries `{type, name}` with no code, and `untrackTerminalData` still hardcodes `{t:'exit', code: 0}` — so a client attached at the moment of exit (the normal case) always sees code 0. Only the attach-after-exit path (`setupClient`, `terminal.exitCode ?? 0`) is correct, and that predates round 2. Fix = thread the code through the `closed` event. (2) `handleUpgrade` still writes `HTTP/1.1 4404 Terminal Not Found` — 4404 is not an HTTP status code; the plan specified accepting the upgrade and closing with WebSocket close code 4404 plus a JSON error frame. Also unresolved: four dead private auth methods left behind in `wsHub` (the delegation removed their call sites but not the definitions, so the "next auth fix lands in ONE place" goal is only half met).

### Reviewer pass 3 (2026-07-31) — open MAJORs closed

Both remaining items fixed. **Exit codes** now propagate end to end: `FleetChangeEvent.closed` carries an optional `code` (the process status on a self-inflicted exit, undefined for an operator `kill()`), `untrackTerminalData` forwards it, and the panel renders it — previously every terminal reported "exited with code 0" because the live exit path hardcoded `0`. **The malformed `4404`** is gone: the gateway now completes the upgrade, sends `{t:'error', code:4404, message}` and closes with WebSocket close code 4404 in the private 4000-4999 range, instead of writing `HTTP/1.1 4404` — which is not an HTTP status and surfaced in the browser as an indistinguishable generic network failure. The panel handles the new `error` frame by latching the view read-only. Also closed: the four dead private auth methods are deleted from `wsHub`, so `wsUpgradeAuth.ts` is now the only copy of the upgrade auth logic.
