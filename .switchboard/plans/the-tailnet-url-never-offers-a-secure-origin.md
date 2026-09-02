# The tailnet URL is chosen for reachability, never for origin trust, so the board lands on an insecure context that cannot install to a Home Screen

## Goal

Make `switchboard tailnet` emit the **best available origin** rather than merely a reachable
one — preferring a secure context when the tailnet offers it — and, when no secure origin is
available, say in a single line what that costs. Detection only: this plan never configures
`tailscale serve` (see *Non-goals*).

### Problem Analysis

**Measured on the home lab, 2026-09-01** (`patrickremotedev`, standalone
`dist/standalone/cli.js tailnet --no-open`, 14h31m uptime, port 7777):

| probe | result |
| :--- | :--- |
| web UI, on the box | HTTP 200 in **1 ms** |
| API `/catalog`, on the box | HTTP 200 in **7 ms** |
| web UI, from a laptop over the tailnet | HTTP 200 in **180 ms** |
| tailnet RTT to the box | 43 ms avg, **13–88 ms spread**, stddev 28 ms |
| `tailscale status --json` → `CertDomains` | `None` |
| `tailscale serve status` | `No serve config` |

#### What this plan is NOT fixing — read this first

This plan was opened while chasing a **different** bug: over the tailnet in Chrome, the "copy
prompt" buttons and the kanban status messages work most of the time and fail intermittently.
The investigation landed somewhere else, and the finding is recorded here so nobody re-derives
it:

**`src/webview/transport.js` backs off up to 30 seconds, silently.**

```
reconnectDelay        500ms, doubling
maxReconnectDelay     30000ms
HANDSHAKE_TIMEOUT_MS  10000ms
```

On a link with 28 ms of jitter the socket drops; backoff climbs 0.5 → 1 → 2 → 4 → 8 → 16 → 30 s,
and a stalled handshake burns another 10 s before retrying. `transport.js` is the single path
for **both** reported symptoms — status messages are dispatched at `transport.js:390`, and the
browser copy path writes the clipboard from a verb *response* at `transport.js:373`. No socket
means neither happens, for up to ~40 s at a time. Nothing in `transport.js` surfaces a down
socket to the operator, so the board looks normal while it is deaf.

**Confirmed by test, 2026-09-01: reloading the page restores both features immediately.** A
reload resets `reconnectDelay` to 500 ms and opens a fresh socket, short-circuiting the
backoff; nothing about the origin changes on reload. That is the discriminating experiment,
and it rules the origin out as the cause of the intermittent failures.

**One cause, both symptoms, intermittent, correlated with link quality.** That belongs in its
own plan — a 30-second cap with no connection indicator is the defect, not the origin. **Do
not fold it into this one.**

> **Superseded:** "…`navigator.clipboard` is undefined, so every copy falls to
> `document.execCommand('copy')`, which browsers honour only during transient user activation;
> on a 43 ms ± 28 ms link some round trips land outside the window."
> **Reason:** wrong on the evidence. The operator is on **Chrome**, whose activation window is
> ~5 s — a 180 ms round trip sits well inside it. (Safari's rule is structural rather than
> timed, disallowing *any* async step before the write, but a structural rule fails every time,
> not intermittently, and Safari is not in use here.) The gesture-expiry story never explained
> the intermittency and should not be revived.

**The "works on the box, fails over the tailnet" asymmetry has two explanations, and the
origin is the weaker one.** The board opened on the box itself uses
`http://switchboard.localhost:7777` and behaves correctly. That was initially read as origin
trust. But a loopback WebSocket also never drops, while a tailnet one does — and that reading
additionally explains the intermittency, which origin trust does not. Treat the asymmetry as
evidence for the transport plan, not for this one.

#### What this plan IS fixing

**The emitted origin is insecure, and that independently blocks shipped work.**
`board-installs-to-the-home-screen-as-a-standalone-app.md` records (research 2026-08-31) that
on a remote origin **iOS Safari treats a plain-`http` manifest as a bookmark and does not apply
`display: standalone`** — only `localhost` is exempt. A tailnet IP is a remote origin. So the
Home Screen install plan cannot deliver the thing it exists for — dropping browser chrome to
reclaim ~100 px of board height — while the CLI hands out `http://<tailnet-ip>:7777`.

That cost is **documented, reproducible and not a hypothesis**, and it is this plan's
justification. A secure origin would also make `navigator.clipboard` available and retire
`clipboardFallback.js` on this path, which is a real but secondary benefit — and explicitly
**not** a claimed fix for the intermittent failure above.

**Two dead ends, recorded so they are not re-investigated.** The copy plumbing is correct:
`/terminals?token=…` serves `sharedDefaults.js`, `clipboardFallback.js` and `transport.js` in
that order, so `injectTransportShim` (`src/services/headlessPanelHtml.ts:74`) works; and
`window.sbCopyToClipboard` has **28 references** across `src/webview/`, including four in
`kanban.html`. The un-injected `<!-- SHARED_DEFAULTS_SCRIPT -->` marker still visible at
`/static/webview/kanban.html` is the raw static path, which the shell does not load.

**Root cause of the thing this plan fixes.** The CLI's URL resolution has no notion of origin
*trust* — it picks a reachable URL, not the best one.
`feature_plan_20260805105305_browser-board-url-defaults-to-switchboard-localhost.md` already
built probe-and-fall-back resolution (§1b records that `http://*.localhost:<port>` is a W3C
Potentially Trustworthy origin). The tailnet path never received the same treatment and has
only ever emitted an IP.

## Metadata

- **Complexity:** 5
- **Tags:** cli, devops, ux
- **Files touched:** `src/standalone/cli.ts`, `src/standalone/bootstrap.ts`, `src/extension.ts`,
  `src/utils/loopbackHostname.ts` (or a sibling resolver module),
  `src/test/tailscale-bind-contract.test.js`
- **Risk:** Low–Medium. The terminal fallback is today's exact behaviour, so the worst
  regression is a slow startup if probes are not capped. A wrong *preference* order, by
  contrast, can log the operator out mid-session (see Edge Case 5).

> **Superseded:** Complexity 4.
> **Reason:** the work is multi-file (`cli.ts`, `bootstrap.ts`, `extension.ts`, a new
> resolver module, and the contract test) and introduces a new detection pattern
> (`tailscale serve` config inspection plus an HTTPS-capable probe) that extends
> `tailnetDetect.ts` rather than reusing it verbatim. The scoring guide places routine
> single-file work at 3-4; this is neither single-file nor purely routine.
> **Replaced with:** Complexity 5 — Mixed. Majority routine (candidate list, advisory line,
> wiring), with one moderate, well-scoped risk (serve-config detection + HTTPS probe).
> Recommendation: Send to Coder.

## User Review Required

None. The scope decision — detect and advise, never configure `tailscale serve` — is made
below and justified; it needs no product call.

## Complexity Audit

### Routine

- A ranked candidate list (HTTPS FQDN → HTTP FQDN → HTTP IP) with first-success-wins
  emission. The IP fallback needs no probe — it is today's exact behaviour.
- One advisory line at launch, gated on the chosen origin being insecure. Pure console
  output, no state.
- Wiring the shared resolver into the two emission sites (`cli.ts:3011`,
  `extension.ts:1314`), replacing the hardcoded `http://${tailnetAddress}` string.
- Extending `src/test/tailscale-bind-contract.test.js` with advisory-line and probe-target
  assertions — the test file already follows this source-level contract pattern.

### Complex / Risky

- **`tailscale serve` config inspection — new detection surface.** Nothing in this repo has
  ever parsed serve status. `tailnetDetect.ts` probes the interface address and MagicDNS
  names only. The serve-config read uses `GET /localapi/v0/serve-config` via the LocalAPI
  socket (primary) or `tailscale serve status --json` via the absolute-path CLI fallback —
  both return `ipn.ServeConfig` JSON (confirmed by research, see *Resolved Assumptions*).
  The parser must inspect `Web.*.Handlers.*.Proxy` and `TCP.*.TCPForward` for port matching,
  and `AllowFunnel` for the funnel-vs-serve distinction. This is a new parser for a
  confirmed schema, but the schema is Tailscale-internal and explicitly unstable — the
  parser must degrade to "no serve config detected" on any parse failure.
- **An HTTPS-capable probe.** The existing `isHostnameReachable`
  (`loopbackHostname.ts:188`) is hardcoded to `http://` and cannot perform a TLS handshake.
  The HTTPS candidate requires a probe that does TLS — which doubles as the cert-liveness
  check (Edge Case 2). See the *Superseded* callout in Proposed Changes.
- **Port-matching against the serve config (Edge Case 3).** A serve config fronting a
  *different* port must not be emitted. This is a correctness guard, not a reachability
  check — a probe to `https://<fqdn>/health` could succeed against the wrong backend if
  another service holds 443. The serve-config inspection must confirm the target port.
- **Stable single-URL emission (Edge Case 5).** `sb_session` is host-only, so the resolver
  must pick one origin and stick to it for the whole launch. Printing alternates invites a
  mid-session hostname switch that reads as a random logout.

## Non-goals

**This plan does not run `tailscale serve`, and that is deliberate:**

- **Privileges.** `tailscale serve` requires root unless the operator is set
  (`tailscale set --operator=$USER`, itself a one-time sudo). A CLI that shells out to an
  interactive sudo prompt cannot run non-interactively and is a bad citizen.
- **Half of it is not automatable anyway.** Enabling HTTPS for a tailnet is an admin-console
  click. No CLI can perform it, so the tool can only ever detect and instruct for that half.
- **Lifecycle Switchboard does not own.** A serve rule persists beyond the Switchboard
  process. Anything that creates one owes a teardown path, and a proxy left pointing at a
  dead port is a worse failure than the one being fixed.

**This plan does not touch the WebSocket backoff.** See *What this plan is NOT fixing*. It is a
separate defect with a separate fix, and merging them would make both harder to verify.

Also out of scope: changing the bind address, the peer check, the `Host` guard, or the CLI
hostname validation. This plan is **exposure-neutral** — it changes which URL is *printed*,
never what is *listening*.

## Proposed Changes

**1. A candidate list for the tailnet URL, highest trust first.**

```
https://<magicdns-fqdn>          ← only if a serve config maps it to THIS port and the cert is live
http://<magicdns-fqdn>:<port>    ← already accepted by the Host guard; better to type than an IP
http://<tailnet-ip>:<port>       ← today's behaviour; terminal fallback, needs no probe
```

> **Superseded:** "Probe each with an HTTP GET to `/health` — unauthenticated, and critically
> it does not burn the one-time token (`consumeOneTimeToken` returns true exactly once,
> `LocalApiServer.ts:310-313`…). First success wins."
> **Reason:** the existing `isHostnameReachable` (`loopbackHostname.ts:188`) is hardcoded to
> `http://` — it performs no TLS handshake and cannot probe an `https://` candidate. The
> plan's own Edge Case 2 ("HTTPS enabled but the cert not yet issued. The probe fails, the
> candidate is dropped") describes a TLS handshake failure, which the proposed `http.get`
> probe cannot produce. A serve-config-present-but-cert-not-yet-issued tailnet would either
> emit an `https://` URL that hangs for 30 s on first provisioning, or never be probed at all
> — both contradict Edge Case 2.
> **Replaced with:** a **scheme-aware probe**. The HTTP candidates (`http://<fqdn>:<port>`,
> `http://<ip>:<port>`) reuse `isHostnameReachable` against `/health` (unauthenticated,
> idempotent, does not burn the one-time token — `consumeOneTimeToken` is invoked only from
> the `/?token=` handlers at `LocalApiServer.ts:1264`, `:1316`, `:1370`). The HTTPS candidate
> (`https://<fqdn>`) requires a new **TLS-capable probe** — Node `https.get` against
> `/health`, short timeout (≤2 s). That probe simultaneously verifies cert liveness AND
> reachability, which makes Edge Case 2 true rather than aspirational: a cert that has not
> been issued fails the TLS handshake and the candidate is dropped without blocking startup.
> The serve-config inspection is then needed ONLY for the port-matching guard (Edge Case 3),
> not for cert status. Clean separation: serve config answers "is this FQDN mapped to my
> port?", the HTTPS probe answers "is the cert live and the origin reachable?". First success
> wins. Emit exactly one URL.

**2. Read-only detection.** Two Tailscale surfaces are read, both through the same
transport stack `tailnetDetect.ts` already uses (LocalAPI socket first, absolute-path CLI
fallback — never a bare `spawn('tailscale')`, `tailnetDetect.ts:7-10` documents why):

- **Serve config:** `GET /localapi/v0/serve-config` via the LocalAPI socket, or
  `tailscale serve status --json` via the CLI fallback. Both return the same
  `ipn.ServeConfig` JSON structure (confirmed by research 2026-09-01 — see *Resolved
  Assumptions*). The structure has `Web` (SNI host-port → handlers with `Proxy` URLs like
  `http://127.0.0.1:<port>`), `TCP` (port → `TCPForward` dest), `Services` (named service
  blocks with nested `Web`/`TCP`), and `AllowFunnel` (host-port → bool). Port matching
  inspects `Web.*.Handlers.*.Proxy` and `TCP.*.TCPForward` for a destination port equal to
  the board's listening port. `AllowFunnel[hostport] === true` means the endpoint is
  internet-public (funnel), not tailnet-only (serve) — the advisory line should note this
  if the chosen origin is a funnel endpoint, since the security posture differs.
- **Cert capability:** `GET /localapi/v0/status` (already read by `resolveMagicDnsNames` in
  `tailnetDetect.ts:156`) exposes `Self.CertDomains`. If `CertDomains` is empty or null,
  HTTPS certificate generation is disabled in the tailnet admin console — TLS termination
  will fail even if `ServeConfig` requests `HTTPS: true`. The HTTPS candidate is skipped
  entirely when `CertDomains` is empty. This is a **pre-flight check** that short-circuits
  the TLS probe before it can hang on a cert that will never issue.

Tailscale absent, stopped, or erroring is **not an error** — it falls through to the current
behaviour silently.

**3. One advisory line, once, only when the chosen origin is insecure.** It must name the
concrete cost — Home Screen install will not launch standalone — rather than lecture about
TLS. One line at launch. Never a repeated warning, never a banner. **It must not claim to fix
copy-button reliability**; that claim outran its evidence once already.

### `src/utils/loopbackHostname.ts` (or a sibling resolver module)

- **Context:** the loopback resolver (`resolveDisplayHostname`, `isHostnameReachable`) already
  implements probe-and-fall-back for the `local` path. The tailnet path has no equivalent —
  it emits the IP unconditionally (`cli.ts:3011`, `extension.ts:1314`).
- **Logic:** add `resolveTailnetOrigin(tailnetAddress, magicDnsNames, port, serveConfig, certDomains, opts)`
  returning `{ url: string, secure: boolean }`. It builds the candidate list in trust order.
  The HTTPS candidate is skipped when (a) no serve config maps the FQDN to `port`, OR (b)
  `certDomains` is empty (cert generation disabled in the admin console — pre-flight check).
  Surviving candidates are probed (HTTP probe for the `http://` candidates, TLS probe for the
  `https://` candidate), and the first success wins. The IP candidate is always last and
  needs no probe (it is the bound address — reachability is structural). An explicit
  `--hostname` bypasses this entirely (Edge Case 7).
- **Implementation:** the TLS probe is a new `isHttpsOriginReachable(hostname, port,
  timeoutMs)` sibling of `isHostnameReachable`, using `https.get` and the same wall-clock
  guard + settle-once pattern. Cap each probe at ≤2 s; run at most two (the IP fallback needs
  none). A slow tailnet must never delay board launch.
- **Edge Cases:** cert-not-issued (TLS handshake fails → candidate dropped, Edge Case 2);
  serve config fronting a different port (port mismatch → candidate skipped, Edge Case 3);
  probe timeout (candidate dropped, next candidate tried).

### `src/standalone/cli.ts`

- **Context:** `cli.ts:3007-3016` emits `http://${tailnetAddress}:${instance.port}/` as the
  primary tailnet URL, with MagicDNS names as a secondary info line. The primary URL is always
  the IP.
- **Logic:** after `startHeadlessSwitchboard` resolves and `waitForHealth` confirms the
  loopback listener, call `resolveTailnetOrigin` with the detected `tailnetAddress`,
  `magicDnsNames`, `instance.port`, and the serve-config detection result. Emit the returned
  URL as the single tailnet URL. If `secure === false`, emit the one advisory line
  immediately after. The MagicDNS secondary info line may be dropped or kept as a typing hint,
  but the *primary* URL is the resolver's choice, not the IP.
- **Implementation:** the serve-config detection runs alongside `detectTailnetAddress` /
  `resolveMagicDnsNames` in the existing tailnet-detection block (`cli.ts:2819-2830`). When
  `--hostname` is explicit, skip the resolver and honour the user's choice verbatim (Edge Case
  7 — already enforced by `resolveHostname` at `cli.ts:175`).
- **Edge Cases:** detached mode (`cli.ts:2931-2933`) prints the tailnet URL before the child
  boots — the resolver must run in the parent after `findRunningInstance` confirms health, so
  the printed URL is probed against the live server, not a guess.

### `src/extension.ts`

- **Context:** `extension.ts:1313-1321` emits `http://${bindPolicy.tailnetAddress}:${port}/`
  in the *Open in Browser* command under tailnet mode. This is the second emission site (see
  *Composition Roots*).
- **Logic:** replace the inline URL construction with a call to the shared
  `resolveTailnetOrigin`, using `bindPolicy.tailnetAddress`, `bindPolicy.magicDnsNames`, the
  live port, and a serve-config detection run from the extension host. Emit the advisory line
  to `outputChannel` when insecure, and `openExternal` the resolved URL.
- **Implementation:** the extension already calls `detectTailnetAddress` when the
  `switchboard.remote.tailnet` setting is on (confirmed by
  `tailscale-bind-contract.test.js:168-173`). The serve-config detection follows the same
  `tailnetDetect.ts` transport.
- **Edge Cases:** the extension may run on a host where Tailscale is down —
  `_resolveBindPolicy` degrades to loopback (`extension.ts:1309-1311`), so the tailnet branch
  is not reached and the resolver is not called.

### `src/test/tailscale-bind-contract.test.js`

- **Context:** the contract test already pins the bind-policy invariants at the source level.
- **Logic:** add assertions that (a) the advisory line fires when the chosen origin is
  insecure and does NOT fire when secure; (b) the probe target is `/health` (not `/?token=`),
  so a future refactor cannot start burning the one-time token; (c) an explicit `--hostname`
  bypasses the resolver. These are source-level structural assertions, matching the existing
  test style.

## Composition Roots — both hosts

Per the repo rule, this names both roots and the verification covers both. **The seams each
host wires are the audit, not the verbs each host answers.**

- **`src/standalone/cli.ts` / `src/standalone/bootstrap.ts`** — owns `switchboard tailnet` and
  prints the URL. This is where the resolver is consumed.
- **`src/extension.ts`** — **established 2026-09-01: the extension DOES surface a tailnet
  URL.** The *Open in Browser* command, under tailnet mode, emits
  `http://${bindPolicy.tailnetAddress}:${port}/` at `extension.ts:1313-1321` and
  `openExternal`s it. The MagicDNS names are appended as an info string. So the resolver is
  **shared and both roots consume it** — landing it only in `cli.ts` would leave the
  extension handing out the IP and the secure-origin benefit half-delivered. The
  `switchboard.remote.tailnet` setting gates the bind policy (`extension.ts:1312-1313`), and
  `_resolveBindPolicy` degrades to loopback when Tailscale is down, so the tailnet branch is
  reached only when the listener is actually open.

This is the one case where the parity rule needs thought rather than reflex: serving is a
standalone concern, but *URL emission* is shared, and that is where the split falls — the
resolver lives in `loopbackHostname.ts` (or a sibling), consumed by both `cli.ts` and
`extension.ts`.

## Edge-Case & Dependency Audit

1. **Tailscale not installed / not running / `tailscale` not on PATH.** Fall through to the IP.
   No warning — this is the normal case for a non-tailnet launch.
2. **HTTPS enabled but the cert not yet issued.** The first cert provisioning is slow. The
   probe fails, the candidate is dropped, startup is not blocked. Never wait on it.
3. **A serve config exists but proxies a *different* port.** Must not be emitted. Match on the
   target port, not merely on the presence of any serve config.
4. **`Host` guard under a serve proxy.** With `tailscale serve` fronting, requests arrive at
   `127.0.0.1` with `Host` set to the MagicDNS FQDN. `LocalApiServer.ts:7934` records that the
   tailnet bind policy accepts "the tailnet address, the MagicDNS FQDN, and its bare first
   label". **Confirm this by test; do not modify the guard.**
5. **`sb_session` is host-scoped.** It is set with no `Domain`, making it host-only, so moving
   between `100.110.206.86` and the FQDN logs the operator out once. This is why the CLI must
   emit **exactly one** URL and be stable about which — printing alternates invites a
   mid-session hostname switch that reads as a random logout.
6. **Probe cost at startup.** Cap each probe with a short timeout and run at most two (the IP
   fallback needs none — it is today's behaviour). A slow tailnet must never delay board
   launch.
7. **Explicit `--hostname`.** Honoured verbatim: no probe, no substitution, no advisory. An
   explicit user choice outranks the default — the rule already established by
   `feature_plan_20260805105305` item 3.
8. **`.switchboard/api-server-port.txt`** stores only a port and is unaffected. Skills that
   build `http://127.0.0.1:<port>` from it keep working; the bind address does not change.

## Dependencies

- **No blocking session dependency.** This plan extends the probe-and-fall-back pattern
  already shipped in the loopback hostname resolver (`resolveDisplayHostname`,
  `isHostnameReachable` in `loopbackHostname.ts`) and the tailnet detection already shipped
  in `tailnetDetect.ts` (`detectTailnetAddress`, `resolveMagicDnsNames`). Neither is a
  blocking dependency — both are merged and live.
- **Downstream consumer, not a blocker:** `board-installs-to-the-home-screen-as-a-standalone-app.md`
  is justified by the secure-origin benefit this plan delivers. That plan ships standalone
  launch over plain `http` via the Apple meta tag today (independent of TLS), but a secure
  origin is what makes its `manifest.json` `display: standalone` actually take effect on iOS.
  This plan enables that upgrade; it does not block the sibling plan's current shipping
  posture.
- **Precedent, not a dependency:** `feature_plan_20260805105305_browser-board-url-defaults-to-switchboard-localhost.md`
  established the probe-and-fall-back resolution and the `/health`-not-`/?token=` probe
  constraint. This plan applies the same pattern to the tailnet path.

## Adversarial Synthesis

Key risks: (1) the HTTPS candidate cannot be probed by the existing HTTP-only
`isHostnameReachable` — a TLS-capable probe is required or Edge Case 2 is unenforceable;
(2) the `ipn.ServeConfig` schema is Tailscale-internal and explicitly unstable — the parser
must degrade to "no serve config detected" on any shape mismatch, and the CertDomains
pre-flight (from `/localapi/v0/status`) must short-circuit the TLS probe when cert generation
is disabled; (3) the resolver must be wired into BOTH emission sites (`cli.ts:3011` and
`extension.ts:1314`) or the secure-origin benefit is half-delivered. Mitigations:
scheme-aware probe (HTTP reuse + new TLS probe), serve-config inspection scoped to
port-matching only with graceful parse-failure fallback, CertDomains pre-flight check, and
the shared resolver consumed by both roots with the one-URL rule preserving session-cookie
stability.

## Verification Plan

### Automated Tests

1. **Unit — resolver order.** Candidates are returned highest-trust-first; a failed probe
   removes its candidate; an explicit `--hostname` bypasses the resolver entirely.
2. **Contract — extend `src/test/tailscale-bind-contract.test.js`.** Assert the advisory line
   fires when the chosen origin is insecure and does **not** fire when it is secure. Assert
   `/health` is the probe target, so a future refactor cannot start burning the one-time token.
   Assert an HTTPS candidate is probed via a TLS-capable path (not `http.get`), so the
   cert-liveness check (Edge Case 2) cannot be silently dropped.
3. **Standalone UAT (home lab).** With no serve config: the tailnet IP is emitted plus exactly
   one advisory line. Then with `tailscale serve` configured by hand: the `https://` FQDN is
   emitted and no advisory appears.
4. **Extension.** The extension consumes the same resolver (established in *Composition
   Roots*) and is UAT'd for it: under `switchboard.remote.tailnet` on, the *Open in Browser*
   command emits the resolver's URL, not the hardcoded IP. Not "checked the verbs".
5. **The acceptance test is the install, not the clipboard.** On the HTTPS origin, add the
   board to an iPad Home Screen and confirm it launches **without Safari chrome** — that is the
   documented, reproducible benefit this plan is justified by. Note separately whether
   `navigator.clipboard` is now defined; record it as an observation, not as a fix for the
   intermittent failure.
6. **Exposure-neutral.** Re-run `loopback-hostname-contract`; a non-loopback peer and a
   non-loopback `Host` must still 403. Nothing about the listening surface changes.

### Goal Invariants

- The string `http://${tailnetAddress}` (raw IP interpolation) is absent from the primary
  tailnet-URL emission path in both `src/standalone/cli.ts` and `src/extension.ts` —
  replaced by a call to the shared `resolveTailnetOrigin`.
- A function named `resolveTailnetOrigin` (or equivalent) exists in
  `src/utils/loopbackHostname.ts` or a sibling resolver module and is imported by both
  `src/standalone/cli.ts` and `src/extension.ts`.
- An HTTPS-capable probe function (using `https.get`, not `http.get`) exists in the resolver
  module — the cert-liveness check for the `https://` candidate.
- The advisory line is emitted exactly once at launch and only when the chosen origin's
  scheme is `http://` (insecure); it is absent when the scheme is `https://`.
- The probe target string `/health` appears in the resolver's probe path; the string
  `/?token=` does not appear in any probe path.
- The serve-config parser reads from `/localapi/v0/serve-config` (LocalAPI socket) as the
  primary transport, with `tailscale serve status --json` (absolute-path CLI) as fallback —
  never a bare `spawn('tailscale')`.
- The HTTPS candidate is skipped when `CertDomains` (from `/localapi/v0/status`) is empty or
  null — the pre-flight check that prevents a TLS probe hang on a cert that will never issue.
- The serve-config parser degrades to "no serve config detected" on any parse failure or
  schema mismatch — the `ipn.ServeConfig` schema is explicitly unstable.

## Settled — do not re-raise

- **Gesture expiry is not the cause of the intermittent copy failures.** Chrome, ~5 s
  activation window, 180 ms round trip. Killed on evidence 2026-09-01; see the superseded
  block above.
- **This plan does not fix the intermittent failures at all.** If it ships and they persist,
  that is the expected outcome, not a regression. The transport backoff plan owns them.
- **The origin is not their cause — this was measured, not argued.** Reload restores the board;
  reload does not change the origin. Do not re-open the secure-context theory for the
  intermittent failures on any future report of them.

## Resolved Assumptions

Confirmed by web research, 2026-09-01. Do not re-open.

- **`tailscale serve status --json` output format.** Returns `ipn.ServeConfig` JSON with
  `Web` (SNI host-port → `Handlers` map → `Proxy` URLs like `http://127.0.0.1:<port>`),
  `TCP` (port → `TCPForward` dest), `Services` (named service blocks with nested `Web`/`TCP`),
  and `AllowFunnel` (host-port → bool). The backend port is reliably exposed in both
  `Web.*.Handlers.*.Proxy` and `TCP.*.TCPForward`. Parseable; port-matching is feasible.
- **LocalAPI serve-config endpoint.** `GET /localapi/v0/serve-config` exists and returns the
  same `ipn.ServeConfig` JSON as the CLI. Classified by Tailscale as internal/unstable but
  backward-compatible across recent releases. This is the **primary** transport (no PATH
  problem, zero process overhead, <5ms IPC read); `tailscale serve status --json` via the
  absolute-path CLI probe is the fallback. Both must be tried in that order, mirroring
  `tailnetDetect.ts`.
- **ServeConfig is config state, not cert state.** `HTTPS: true` in the serve config records
  *intent*, not cert issuance. Cert liveness must be verified separately: (1) check
  `Self.CertDomains` from `/localapi/v0/status` (empty = cert generation disabled, skip
  HTTPS candidate entirely), and (2) the TLS handshake probe (`isHttpsOriginReachable`)
  confirms the cert is live and the origin is reachable. Initial ACME issuance on first
  request takes 3-12 s — the ≤2 s probe timeout will correctly drop a not-yet-issued cert.
- **Funnel vs. serve.** `AllowFunnel[hostport] === true` means the endpoint is
  internet-public (funnel), not tailnet-only (serve). The advisory line should distinguish
  these when the chosen origin is a funnel endpoint, since the security posture differs
  (public ingress vs. tailnet-only).
- **Read permissions.** Reading serve config (GET) requires only OS-level socket file
  permissions. On Unix the socket is typically `0600`/`0660` root-owned; the `--operator`
  flag grants the operator's user access. If socket access is denied (`EACCES`/`EPERM`),
  both LocalAPI and CLI fail — fall through to the IP silently. No elevation is attempted.
