# Tailnet

<!-- board-collapse-05 -->
> **Landing order is fixed, not advisory (2026-09-04, Board Collapse 05, decision 7).**
> 
> 0. **The Tailnet LocalAPI Probe Omits the Host Header** — added 2026-09-04 after the operator reported that "Start Remote Tailnet Board" starts a board no remote device can reach. Measured: the tailnet listener **is** created and answers on the raw IPv4 address, but `resolveMagicDnsNames()` calls the Tailscale LocalAPI without `Host: local-tailscaled.sock`, gets `403 invalid localapi request`, and returns `[]` — indistinguishable from "this machine has no MagicDNS name". The bind policy's name list is therefore empty and the Host guard answers `403 Access denied: invalid Host header` to the only name a person types. **This lands first**: steps 1 and 4 both consume the name list it populates, so without it they mask each other.
> 1. **Tailnet Mode Accepts The Node's Own MagicDNS Names** — populates the bind policy with `Self.DNSName` / `Self.HostName` / tailnet addresses. Only its IPv6 listener remains; changes 1 to 6 already shipped. **Correction (2026-09-04):** this plan records the `Self.DNSName` read as "already implemented", which is true of the code and false of the behaviour — it has never returned a name on this machine. Step 0 is why.
> 2. **The tailnet URL is chosen for reachability, never for origin trust** — emits the best-trust origin.
> 3. **`switchboard tailnet` prints the credential-free URL and then opens the credentialed one** — the CLI opens the URL it printed.
> 4. **The browser board is served unauthenticated** — the CSRF guard, whose allow-set reads the bind policy step 1 fills.
> 
> Reversing 1 and 4 is the failure this feature exists to prevent: a CSRF guard that accepts only loopback origins returns 403 for every verb triggered from the tailnet board, and does so invisibly, because a verb POST has no timeout and a rejection is indistinguishable from a hang.
> 
> **Column note.** Two subtasks (MagicDNS, tailnet URL) were in Planned and two in New when this feature was formed. Under the containment rule signed on 2026-09-04 a feature takes its least-advanced member's column, so all four now sit in New with the feature. That is the safe direction — promoting unreviewed plans into a dispatchable column risks coding unreviewed work — but it does cost the record of those two reviews. **They have both been plan-reviewed already**; when this feature is promoted, they need a sequencing check against the order above, not a fresh review.

**Complexity:** 5

## Goal

The board reached over the tailnet is trusted, correctly addressed, and protected. Landing order is fixed and not optional: MagicDNS names populate the bind policy first, then the URL is chosen for origin trust, then the CLI opens the credential-free URL, then the CSRF guard reads that same bind policy as its allow-set. Reversing the first and last steps makes the guard reject every request from the tailnet board.

## How the Subtasks Achieve This

- **The Tailnet LocalAPI Probe Omits the Host Header**: Fixes the root cause — `resolveMagicDnsNames()` in `tailnetDetect.ts` omits the `Host: local-tailscaled.sock` header the Tailscale LocalAPI requires, gets `403 invalid localapi request`, and returns `[]` — indistinguishable from "this machine has no MagicDNS name." Adds the header to both LocalAPI probes and tags the return type so "no name" is distinguishable from "probe failed."
- **Tailnet Mode Accepts The Node's Own MagicDNS Names**: Populates the bind policy with the node's own MagicDNS names so the Host guard accepts them. Changes 1–6 (name population) are already shipped; the remaining work is the IPv6 tailnet listener so v6-preferring clients connect without a latency penalty or total failure on v6-only environments.
- **The tailnet URL is chosen for reachability, never for origin trust**: Replaces the raw-IP URL emission with a trust-ranked resolver (`resolveTailnetOrigin`) that prefers HTTPS (when `tailscale serve` is configured and the cert is live), falls back through HTTP FQDN to HTTP IP, and prints an advisory line when the origin is insecure (blocking Home Screen install).
- **`switchboard tailnet` opens the loopback board and spends its token**: Fixes the bug where tailnet mode prints the credential-free URL but opens the credentialed loopback one, which is routinely consumed by a browser prefetch before the page loads. Hoists the resolver's URL and selects it for `openBrowser`; makes the spent-token response name the tailnet URL as the credential-free way in.
- **The browser board is served unauthenticated — reject cross-site state-changing requests**: Adds a CSRF guard to `_handleRequest` that rejects cross-site state-changing requests using `Sec-Fetch-Site`/`Origin` metadata, with the trusted-origin set reading the same bind policy the MagicDNS plan populates. The 2026-09-10 correction replaces header-absence allowance with a positive client marker (`X-Switchboard-Client`).

## Dependencies & sequencing

- **Subtask 0 (Host header fix) lands FIRST.** It populates the name list that Subtasks 1, 2, and 4 all consume. Without it, the name list is empty and the other subtasks mask each other — the CSRF guard rejects every tailnet request, the URL resolver has no FQDN candidate, and the MagicDNS plan's "already implemented" code returns nothing.
- **Subtask 1 (MagicDNS / IPv6) lands second.** Its name-population work is already shipped; the remaining IPv6 listener is independent of the other subtasks but logically follows the probe fix. If the IPv6 listener is deferred (User Review Required), this subtask is a no-op.
- **Subtask 2 (URL resolver) lands third.** It consumes the name list from Subtask 0 (via the bind policy) to pick the best-trust URL. Its serve-config detection reuses the same LocalAPI transport that Subtask 0 fixed.
- **Subtask 3 (open the right URL) lands fourth.** It hoists the URL Subtask 2's resolver produces and selects it for `openBrowser`. Its spent-token recovery reads the bind policy populated by Subtasks 0 and 1.
- **Subtask 4 (CSRF guard) lands LAST.** Its allow-set reads `bindPolicy.magicDnsNames`, which is populated by Subtask 0 (Host header fix makes the probe work) and Subtask 1 (adds v6 if implemented). Reversing Subtask 1 and Subtask 4 makes the guard reject every tailnet request invisibly — a verb POST has no timeout and a rejection is indistinguishable from a hang.

## Team Dispatch Instructions

### The Tailnet LocalAPI Probe Omits the Host Header, So MagicDNS Names Are Never Discovered and the Remote Board 403s

- **Seat:** Intern (Complexity 3 — single-file fix + call-site updates + one contract test)
- **Acceptance:**
  - `resolveMagicDnsNames()` sends `Host: local-tailscaled.sock` and returns a `MagicDnsResult` tagged union, not a bare `string[]`.
  - Against a mock server that 403s without the header, the result is `source: 'unavailable'` with a non-empty `reason` — not an empty success.
  - `BindPolicy.magicDnsNames` stays `string[]`; unwrapping happens at the call site.
  - The startup banner warns when names could not be resolved; the board still starts on the raw tailnet address.
- **Must not touch:** `LocalApiServer.ts` request handling, the bind policy type, the Host guard.

### Tailnet Mode Accepts The Node's Own MagicDNS Names Without Being Told Them

- **Seat:** Coder (Complexity 5 — third HTTP listener, BindPolicy shape, `_isTailnetSocket` update)
- **Acceptance:**
  - If IPv6 is implemented: a third listener opens on the v6 tailnet address; `curl -g "http://[<v6>]:7777/health"` returns 200.
  - A v6 listener failure (`EADDRNOTAVAIL`) degrades to v4-only — does NOT tear down the v4 or loopback listeners.
  - `isAllowedHostFor` accepts a bracketed v6 entry in `magicDnsNames` (extending the existing bracket-match at `loopbackHostname.ts:137`).
  - The rebinding defence stays exact-match — `curl -H 'Host: evil.example'` still returns 403.
  - `--hostname` override still works alongside discovered names.
- **Must not touch:** The CSRF guard (`_handleRequest` front section), the URL resolver, the `openBrowser` call site.

### The tailnet URL is chosen for reachability, never for origin trust, so the board lands on an insecure context that cannot install to a Home Screen

- **Seat:** Coder (Complexity 5 — new resolver module, serve-config parser, TLS probe, both composition roots)
- **Acceptance:**
  - `resolveTailnetOrigin` exists in `loopbackHostname.ts` or a sibling module and is imported by both `cli.ts` and `extension.ts`.
  - The candidate list is HTTPS FQDN → HTTP FQDN → HTTP IP, highest trust first; first success wins.
  - The HTTPS candidate is skipped when `CertDomains` is empty (pre-flight) or the serve config does not map the FQDN to the board's port.
  - The advisory line fires exactly once at launch, only when the chosen origin is `http://`.
  - The probe target is `/health`, never `/?token=`.
  - The raw-IP tailnet URL stays in the banner as a fallback line.
- **Must not touch:** The Host guard, the CSRF guard, the `openBrowser` call site (owned by Subtask 3), the bind address or peer check.

### `switchboard tailnet` prints the credential-free tailnet URL and then opens the credentialed loopback one, which arrives already spent

- **Seat:** Intern (Complexity 3 — URL selection + spent-token body)
- **Acceptance:**
  - `openBrowser` receives `launchUrl` (the resolver's tailnet URL), not `boardUrl`, when `tailnetAddress` is set — no `?token=` in the address bar.
  - `local` mode still opens the loopback URL with its one-time token (unchanged).
  - `--detach --open` applies the same `launchUrl` selection as the foreground path.
  - The spent-token response names the tailnet URL (from `this._bindPolicy`) when a tailnet listener is active.
  - The one-time token stays single-use (`consumeOneTimeToken` unchanged).
- **Must not touch:** The URL resolver construction (owned by Subtask 2), the bind policy, the Host guard, the CSRF guard.

### The browser board is served unauthenticated by the extension host — reject cross-site state-changing requests in both hosts

- **Seat:** Coder (Complexity 4 — CSRF guard in shared `_handleRequest`, positive client marker, client updates across the tree)
- **Acceptance:**
  - `Sec-Fetch-Site` appears in `LocalApiServer.ts` (it does not today).
  - The guard rejects `Sec-Fetch-Site: cross-site` and `same-site` on all state-changing methods; allows `none` and `same-origin`.
  - The guard reads `isAllowedOriginFor(this._bindPolicy, origin)` — same predicate as the Host guard and WS auth.
  - The guard is unconditional (not gated on `serveStatic`); `/health` is exempt.
  - The `X-Switchboard-Client` marker is required when neither `Origin` nor `Sec-Fetch-Site` is present (2026-09-10 correction).
  - All in-tree local clients (`cli-call.js`, `kanban_operations/*.js`, `switchboard api`, `probeHealth`/`waitForHealth`) send the marker.
  - The WebSocket path is already covered by `authorizeWsUpgrade` — no new WS code needed.
- **Must not touch:** The bind policy type, the tailnet detection code, the URL resolver, the `openBrowser` call site.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [The browser board is served unauthenticated by the extension host — reject cross-site state-changing requests in both hosts](../plans/browser-board-csrf-cross-site-rejection.md) — **LEAD CODED** — ID: 2ce0ff70-af28-4b22-a338-665ddbc608cb
- [ ] [Tailnet Mode Accepts The Node's Own MagicDNS Names Without Being Told Them](../plans/tailnet-accepts-the-nodes-own-magicdns-names.md) — **LEAD CODED** — ID: 61382b30-ba2a-4d97-aade-282d249ab05d
- [ ] [The tailnet URL is chosen for reachability, never for origin trust, so the board lands on an insecure context that cannot install to a Home Screen](../plans/the-tailnet-url-never-offers-a-secure-origin.md) — **LEAD CODED** — ID: be0cf7de-bd11-4ee3-b999-5da0dde9e105
- [ ] [`switchboard tailnet` prints the credential-free tailnet URL and then opens the credentialed loopback one, which arrives already spent](../plans/tailnet-mode-opens-the-loopback-board-and-spends-its-token.md) — **LEAD CODED** — ID: eddb76a9-bc8e-4de5-b51d-b13a8c0bac4d
- [ ] [The Tailnet LocalAPI Probe Omits the Host Header, So MagicDNS Names Are Never Discovered and the Remote Board 403s](../plans/tailnet-localapi-probe-omits-the-host-header-so-magicdns-names-are-never-discovered.md) — **LEAD CODED** — ID: b7dc9141-d45c-41b3-af50-2cef25502f89
<!-- END SUBTASKS -->

## Completion Summary

All 5 subtasks landed in the fixed order and are verified by contract suites (tailnet-localapi-host-header 8/8, tailscale-bind 23/23, board-csrf-guard all pass). The Host header fix made MagicDNS names discoverable; the IPv6 listener degrades to v4-only on failure; the URL resolver picks HTTPS FQDN to HTTP FQDN to HTTP IP; the CLI opens the credential-free tailnet URL; the CSRF guard rejects cross-site state-changing requests with X-Switchboard-Client for non-browser callers. Committed as 7179f9d2.

