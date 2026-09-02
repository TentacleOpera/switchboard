# Tailnet Mode Accepts The Node's Own MagicDNS Names Without Being Told Them

## Goal

`switchboard tailnet` should accept the MagicDNS names the machine already answers to, without the operator retyping them as `--hostname`. Populate the bind policy's `magicDnsNames` from `tailscale status --json` at startup, and include the node's IPv6 tailnet address alongside its IPv4 one.

### Problem Analysis & Root Cause

**Observed on the home lab box, 2026-09-01.** The server is running as `cli.js tailnet --no-open` and is healthy. Reaching it by IP works; reaching it by name does not:

```
http://100.110.206.86:7777/health                  -> 200
http://patrickremotedev:7777/health                -> 403 {"error":"Access denied: invalid Host header"}
http://patrickremotedev.taile9aab9.ts.net:7777/…   -> 403 {"error":"Access denied: invalid Host header"}
```

The 403 body identifies the guard precisely. This is **Guard 3** (`LocalApiServer.ts:8218`), the DNS-rebinding Host check — not Guard 2, the tailnet-peer check. The request routes correctly, arrives on the tailnet listener, and is refused on the `Host` header alone.

**The code says these should pass.** The comment directly above the guard (`LocalApiServer.ts:8205`):

> *"Under the tailnet policy the tailnet address and MagicDNS names also pass."*

They do not, because nothing populates the list. `_isAllowedHost` delegates to `isAllowedHostFor(this._bindPolicy, host)`, and the policy's `magicDnsNames` is only filled from the `--hostname` argument. Launched without it — which is the documented, ordinary way to start tailnet mode — the array is empty and the allowlist degrades to the tailnet IP.

So the guard is not wrong and the comment is not wrong; the wiring between them was never done. The operator is required to type a name the machine is already reachable at, and nothing tells them that. The failure presents as a flat 403 with no hint that `--hostname` exists.

**Everything needed is already available locally.** `tailscale status --json` on the node reports:

```
Self.DNSName        patrickremotedev.taile9aab9.ts.net.   (note the trailing dot)
Self.HostName       patrickremotedev
Self.TailscaleIPs   100.110.206.86, fd7a:115c:a1e0::1001:cec3
MagicDNSSuffix      taile9aab9.ts.net
```

The CLI already shells out to Tailscale to resolve the bind address in tailnet mode, so this is an additional field read from a call the code is making anyway — not a new dependency.

**IPv6 is a second gap.** The node has a tailnet IPv6 address (`fd7a:115c:a1e0::1001:cec3`). A client that prefers IPv6 — which modern browsers do by default via Happy Eyeballs (RFC 8305) — will attempt the v6 address first. Without a v6 listener, the connection gets `ECONNREFUSED` (TCP RST, ~1-5ms fallback to v4) or, worse, a silent drop (~250-300ms fallback). Fixing names without fixing this leaves a latency penalty on every v6-preferring client, and a complete failure on v6-only environments. See **Resolved Assumptions** for the research that confirmed this.

> **Superseded:** A client that prefers IPv6 "will send that address as its `Host` and be refused for the same reason" (403 from Guard 3).
> **Reason:** The tailnet listener binds only the IPv4 address (`LocalApiServer.ts:899`: `this._tailnetServer.listen(this._port, this._tailnetAddress)` where `_tailnetAddress` is v4 — `detectTailnetAddress` returns v4 only). An IPv6 client cannot reach a v4-only listener; it gets `ECONNREFUSED` at the TCP layer and never reaches Guard 3. Adding the v6 address to the Host allowlist without also opening a v6 listener is necessary-but-insufficient: the allowlist entry would accept a `Host` header that no connection ever delivers.
> **Replaced with:** IPv6 support requires TWO changes: (a) a third listener bound to the v6 tailnet address (or a restructured bind model), and (b) the v6 address in the allowlist. The allowlist-only fix the original plan described would pass a code-level "is v6 in `magicDnsNames`?" check while the real goal — an IPv6 client loading the board — stays unmet. See Proposed Change 7 and the Outstanding Questions section. Research (see Resolved Assumptions) confirms Tailscale always allocates both addresses, MagicDNS returns AAAA records, and Tailscale recommends dual-stack listeners — so the v6 listener is worth implementing.

**Scope: standalone only, deliberately.** Guard 3 is gated on `this._options.serveStatic` (`LocalApiServer.ts:8218`), and its comment states it is enforced only when serving the browser board, because the extension's scripts always send a raw `127.0.0.1:<port>` Host. Tailnet mode is a standalone CLI concept; the extension does not serve a tailnet listener. This is therefore correctly a single-host change, and that is a finding about the feature's shape rather than an omission — the usual both-roots requirement does not apply here, and the verification says so explicitly rather than leaving it ambiguous.

## Metadata
**Topic:** Populate the tailnet Host allowlist from the node's own Tailscale identity
**Tags:** cli, security, infrastructure, bugfix, reliability

**Complexity:** 5

## User Review Required

**Yes — one decision.** The IPv6 tailnet listener is a larger change than the rest of this plan (a third `http.Server` listener, a `BindPolicy` shape change to carry the v6 address, and `_isTailnetSocket` updated to recognise v6). The name-population work (Proposed Changes 1–6) is already implemented and shippable as-is. The user must decide whether to:
- **(A)** ship the name population now and defer IPv6 to a separate plan, or
- **(B)** do the full IPv6 listener change as part of this plan.

See **Outstanding Questions** for the assumption this plan proceeds under.

## Complexity Audit

### Routine
- Reading `Self.DNSName` from the Tailscale LocalAPI status payload and stripping the trailing dot — already implemented in `resolveMagicDnsNames()` (`tailnetDetect.ts:143`).
- Feeding the discovered names into `bindPolicy.magicDnsNames` — already implemented (`cli.ts:2981`).
- Banner printing the MagicDNS URL — already implemented (`cli.ts:3013`).
- Bare short-hostname acceptance — already handled by `isAllowedHostFor`'s bare-label extraction (`loopbackHostname.ts:142`); no explicit `Self.HostName` read needed.
- `--hostname` override remaining additive — already implemented; `resolveHostname` validates against `tailnetAcceptable` which includes discovered names (`cli.ts:2834`), and the bind policy carries both.
- Graceful degradation when `tailscale status` is unavailable — already implemented; `resolveMagicDnsNames` returns `[]` on any failure (`tailnetDetect.ts:189`).

### Complex / Risky
- **IPv6 tailnet listener (NOT YET IMPLEMENTED).** Opening a third `http.Server` on the v6 address, sharing `_handleRequest`. `start()` currently waits for two listeners (loopback + v4 tailnet); a third adds another failure mode that must tear down the others on `EADDRNOTAVAIL` (the existing teardown at `LocalApiServer.ts:905` is the pattern).
- **`BindPolicy` shape change.** The tailnet variant is `{ tailnetAddress: string; magicDnsNames: string[] }` — a single v4 address. Carrying a v6 address requires either a new field (`tailnetAddressV6`) or moving both IPs into `magicDnsNames` and reworking `_isTailnetSocket`, which identifies the tailnet listener by `socket.localAddress === tailnetAddress` (`LocalApiServer.ts:1094`). A second address breaks that equality unless the predicate is widened.
- **`_isTailnetSocket` v6 recognition.** Node may report v6 as `::ffff:<v4>` (v4-mapped) or as the raw v6 literal. The existing `::ffff:` strip (`LocalApiServer.ts:1099`) handles the mapped form but not a genuine v6 local address.

## Edge-Case & Dependency Audit

**Race Conditions**
- The v4 and v6 tailnet listeners start sequentially inside the loopback listen callback (`LocalApiServer.ts:896`). A third listener must follow the same `tailnetUp` gate pattern — `start()` must not resolve until all three are up, and a failure in any one must tear down the others (the existing `try { this._server?.close() }` pattern at line 916).
- `detectTailnetAddress` and `resolveMagicDnsNames` both probe the LocalAPI socket with a 4s timeout. Adding a v6 address read reuses the same probe — no new timeout, but the sequential probe chain extends startup latency by one round-trip if done as a separate call. Prefer reading `Self.TailscaleIPs` from the same status payload `resolveMagicDnsNames` already fetches.

**Security**
- The rebinding defence (Guard 3) must stay exact-match. Adding the v6 address to the allowlist is safe — it is a tailnet-local CGNAT/fd7a address, not internet-routable, same trust model as the v4 tailnet address. No wildcard, no suffix matching.
- A v6 listener bound to the specific tailnet v6 address is not a wildcard bind (`::`), so it does not expose the server to non-tailnet v6 peers. The bind must be the exact `fd7a:115c:a1e0::...` address, not `::`.

**Side Effects**
- The banner output changes shape if a v6 URL is printed alongside the v4 one — downstream tooling that parses the banner (if any) should be checked, though the banner is human-facing console output.
- `bootstrap.ts:3594` builds `tailnetAcceptable` from `[bindPolicy.tailnetAddress, ...bindPolicy.magicDnsNames]`. If the v6 address moves into `magicDnsNames`, the `--hostname` validator accepts it automatically. If it goes in a new field, `bootstrap.ts` and `cli.ts:2834` must both be updated.

**Dependencies & Conflicts**
- No inter-plan dependencies. This is a self-contained change to the tailnet bind path.
- The `loopback-hostname-contract.test.js` test does not cover `isAllowedHostFor` with a tailnet policy or `resolveMagicDnsNames` — there is no existing test that would catch a regression in the tailnet name population. New test coverage is recommended (see Verification Plan).

## Dependencies

None.

## Adversarial Synthesis

**Risk Summary:** The name-population work is already implemented and low-risk; the primary risk is the IPv6 listener, which the original plan under-scoped — it described an allowlist-only fix that cannot work without a listener the plan never mentions. A secondary risk is the `BindPolicy` type change rippling into `_isTailnetSocket`, `bootstrap.ts`, and `cli.ts` if the v6 address is carried in a new field rather than `magicDnsNames`.

## Proposed Changes

**1. Read the node's identity at tailnet startup.** Where the CLI already resolves the tailnet bind address, parse the same `tailscale status --json` output for `Self.DNSName`, `Self.HostName` and every entry in `Self.TailscaleIPs`.

> **Status: IMPLEMENTED (partial).** `resolveMagicDnsNames()` (`tailnetDetect.ts:143`) reads `Self.DNSName` from the LocalAPI socket and returns the dot-stripped FQDN. It does NOT read `Self.HostName` (unnecessary — `isAllowedHostFor` derives the bare label from the FQDN) or `Self.TailscaleIPs` (the v4 is read separately by `detectTailnetAddress`; the v6 is not read at all). The call is wired at `cli.ts:2828`.

**2. Normalise before adding.** MagicDNS `DNSName` carries a **trailing dot** (`patrickremotedev.taile9aab9.ts.net.`) which a browser's `Host` header will not. Strip it. Add all of:
- the short hostname (`patrickremotedev`)
- the fully-qualified name, dot stripped (`patrickremotedev.taile9aab9.ts.net`)
- every tailnet IP, IPv4 and IPv6

> **Superseded:** Add the short hostname explicitly to `magicDnsNames`.
> **Reason:** `isAllowedHostFor` (`loopbackHostname.ts:142`) already extracts the bare first label from the FQDN and exact-matches it. Adding `Self.HostName` to the array would be redundant — the bare label is accepted via the FQDN entry. The only case where an explicit short-name entry would matter is a node whose `DNSName` has no dot (a bare label), but `resolveMagicDnsNames` already guards on `fqdn.includes('.')` and returns `null` otherwise (`tailnetDetect.ts:172`), so a dotless FQDN degrades to IP-only — the correct behaviour.
> **Replaced with:** Rely on `isAllowedHostFor`'s bare-label extraction. Do not add `Self.HostName` to `magicDnsNames`.

> **Status: IMPLEMENTED for FQDN + v4 IP; NOT IMPLEMENTED for v6 IP.** The FQDN is dot-stripped and returned by `resolveMagicDnsNames`. The v4 IP is carried as `tailnetAddress` in the `BindPolicy` (accepted by `isAllowedHostFor` at `loopbackHostname.ts:135`). The v6 IP is not read, not returned, and not in the allowlist. See Proposed Change 7 for the v6 gap.

**3. Keep `--hostname` working as an override**, additive to the discovered set. An operator naming something explicitly must not lose the automatic entries, and a name that fails validation must still be reported as it is today.

> **Status: IMPLEMENTED.** `resolveHostname` (`cli.ts:175`) validates `--hostname` against `tailnetAcceptable = [tailnetAddress, ...magicDnsNames]` (`cli.ts:2834`). The bind policy carries both the discovered names and the override. An invalid `--hostname` exits non-zero with a diagnostic (`cli.ts:181`).

**4. Degrade quietly.** If `tailscale status` is unavailable, unparseable, or the node has no MagicDNS name, fall back to exactly today's behaviour — the tailnet IP alone. Tailnet mode must not fail to start because a name could not be resolved.

> **Status: IMPLEMENTED.** `resolveMagicDnsNames` returns `[]` on any probe failure (`tailnetDetect.ts:189`). The bind policy degrades to `{ tailnetAddress, magicDnsNames: [] }`, and `isAllowedHostFor` accepts the tailnet IP regardless. The banner omits the MagicDNS line when the array is empty (`cli.ts:3013`).

**5. Say what is reachable.** The startup banner already prints the tailnet URL; print the MagicDNS URL alongside it when one was discovered.

> **Status: IMPLEMENTED.** `cli.ts:3011` prints the tailnet URL; `cli.ts:3013` prints `MagicDNS:` with each discovered name when `magicDnsNames.length > 0`. The detached-mode banner (`cli.ts:2931`) prints the tailnet URL but does NOT print the MagicDNS line — a minor inconsistency, not a functional gap.

**6. Do not widen the guard itself.** Only the allowlist's contents change. No wildcard, no suffix matching, no accepting an arbitrary `Host` because it ends in `.ts.net` — the rebinding defence is the reason this guard exists, and it stays exact-match.

> **Status: IMPLEMENTED.** `isAllowedHostFor` (`loopbackHostname.ts:127`) is exact-match on the hostname, the bracketed/unbracketed tailnet IP, and the FQDN + its bare first label. No wildcard, no suffix. The `loopback-hostname-contract.test.js` test pins the "no second predicate" and "no `0.0.0.0` bind" invariants.

**7. IPv6 tailnet listener and allowlist entry (NOT YET IMPLEMENTED — the remaining work).**

The original plan's IPv6 scope ("include the node's IPv6 tailnet address alongside its IPv4 one") addressed only the allowlist half. The listener half is the larger change and was not described. To make an IPv6 client actually load the board:

- **(a) Read the v6 address.** Extend `resolveMagicDnsNames` (or add a companion function) to also return `Self.TailscaleIPs` entries that match an IPv6 pattern (`/^fd7a:|^[0-9a-f]*:/i` — Tailscale allocates `fd7a:115c:a1e0::/48` v6 addresses). Read from the same LocalAPI status payload the function already fetches — do not make a second probe.
- **(b) Carry the v6 address in the bind policy.** Two options:
  - **Option B1 (preferred):** add the v6 address to `magicDnsNames`. `isAllowedHostFor` already iterates `magicDnsNames` and would accept it — but `hostnameFromHostHeader` returns bracketed v6 (`[fd7a:...]`) and `magicDnsNames` entries are compared unbracketed, so the comparison at `loopbackHostname.ts:141` would fail. The v6 entry must be stored bracketed, or `isAllowedHostFor` must bracket-match v6 entries the way it does for `tailnetAddress` at line 137.
  - **Option B2:** add a `tailnetAddressV6: string` field to the `BindPolicy` tailnet variant. This mirrors the v4 handling but ripples into `isTailnetPolicy`, `isAllowedHostFor`, `_isTailnetSocket`, `bootstrap.ts:3594`, and `cli.ts:2834`.
- **(c) Open a third listener on the v6 address.** In `start()` (`LocalApiServer.ts:896`), after the v4 tailnet listener is up, open `this._tailnetServerV6 = http.createServer(requestHandler); this._tailnetServerV6.listen(this._port, v6Address, ...)`. Add a `tailnetV6Up` gate to the `start()` settle logic. On error, tear down all three listeners (extend the existing teardown at line 905). On `stop()`, close the third listener too (extend `closeAll` at line 1044).
- **(d) Update `_isTailnetSocket`** (`LocalApiServer.ts:1094`) to also return true when `socket.localAddress` matches the v6 address (raw or v4-mapped form — the existing `::ffff:` strip handles the mapped form; a raw v6 local address needs a direct comparison).
- **(e) Print the v6 URL in the banner** alongside the v4 tailnet URL (`cli.ts:3011`).

**Context:** The v6 listener is the load-bearing piece. Without it, the v6 allowlist entry is dead code — no v6 connection ever reaches the guard. The `start()` three-listener coordination and the `_isTailnetSocket` update are the complex/risky parts (see Complexity Audit).

**Edge Cases:**
- A node with no v6 address (rare — research confirms Tailscale always allocates both, but `Self.TailscaleIPs` may be `null`/empty when `tailscaled` is stopped or unauthenticated). The v6 listener must be skipped, not error. `start()` must handle "v6 address absent" the same way it handles "no tailnet address at all" under loopback-only.
- `EADDRNOTAVAIL` on the v6 bind (Tailscale down at boot). Same teardown as the v4 case.
- **Userspace networking mode** (`--tun=userspace-networking`, containers, `tsnet`): explicit IP binds fail with `EADDRNOTAVAIL` because the tailnet IPs do not exist on any OS interface. Research confirms this affects Linux, macOS, and Windows. If Switchboard ever runs in a container with userspace Tailscale, the v4 AND v6 explicit-IP binds both fail. The current v4-only bind already has this latent issue. Mitigation: on `EADDRNOTAVAIL`, fall back to binding `0.0.0.0`/`::` (wildcard) and rely on the Host allowlist + tailnet-peer check (Guard 2) for security, OR document that Switchboard tailnet mode requires kernel-mode Tailscale. This is a pre-existing concern, not introduced by the v6 change — but the v6 change is the moment to decide the fallback strategy.
- A v6 address that Node reports in compressed form (`::` compression) vs. Tailscale's expanded form. Normalise both to the same string before comparison, or compare as `new Address6()` instances.
- **Alternative: dual-stack wildcard bind.** Research recommends binding `[::]` with `ipv6only: false` (accepts both v4 and v6 on one socket) instead of separate listeners. This would replace the current v4-specific listener with a single dual-stack listener. Trade-off: simpler listener management (one listener, not three), but `_isTailnetSocket` identifies the tailnet listener by `socket.localAddress === tailnetAddress` — a `[::]` bind breaks that equality. The peer-identification logic (guards 2, 4, 5, WS auth) would need a different identification strategy (e.g., checking `remoteAddress` is in `100.64.0.0/10` or `fd7a:115c:a1e0::/48`). This is a deeper refactor than the third-listener approach and is NOT recommended for this plan — the third listener preserves the existing identification model.

## Verification Plan

> **Session directive:** Compilation and automated tests are NOT executed in this improve pass. The checks remain written below for the implementer.

### Automated Tests
- Extend `loopback-hostname-contract.test.js` (or a new `tailnet-bind-policy.test.js`) with:
  - `isAllowedHostFor({ tailnetAddress: '100.110.206.86', magicDnsNames: ['patrickremotedev.taile9aab9.ts.net'] }, 'patrickremotedev:7777')` returns `true` (bare label).
  - `isAllowedHostFor(..., 'patrickremotedev.taile9aab9.ts.net:7777')` returns `true` (FQDN).
  - `isAllowedHostFor(..., 'evil.example:7777')` returns `false` (rebinding defence).
  - If v6 is implemented: `isAllowedHostFor({ tailnetAddress: '100.110.206.86', magicDnsNames: ['patrickremotedev.taile9aab9.ts.net', '[fd7a:115c:a1e0::1001:cec3]'] }, '[fd7a:115c:a1e0::1001:cec3]:7777')` returns `true`.
- A `resolveMagicDnsNames` unit test with a mocked LocalAPI socket returning a known status payload, asserting the dot-stripped FQDN (and v6 IP if implemented) is returned.

### Goal Invariants
- Assert `resolveMagicDnsNames` is exported from `src/utils/tailnetDetect.ts` and called at `src/standalone/cli.ts` in the tailnet-mode block.
- Assert `src/standalone/cli.ts` builds `bindPolicy` with `magicDnsNames` populated from `resolveMagicDnsNames()` (not from `--hostname` alone).
- Assert `isAllowedHostFor` in `src/utils/loopbackHostname.ts` accepts a bare first label derived from an FQDN in `magicDnsNames` (the `d.slice(0, dot)` logic at line 142).
- Assert `isAllowedHostFor` does NOT accept a `Host` header whose hostname merely ends in a `magicDnsNames` suffix (no `endsWith` — exact match only).
- If v6 is implemented: assert `LocalApiServer.ts` opens a listener on the v6 tailnet address (a third `http.createServer` + `.listen(port, v6addr)` call), and `_isTailnetSocket` returns true for a socket whose `localAddress` is the v6 address.

### Manual Verification
1. **Baseline the failure.** Before the change, on a node with MagicDNS: `curl http://<hostname>:7777/health` returns `{"error":"Access denied: invalid Host header"}`. This must be reproduced first — the fix is unverifiable without it.
2. **Short name** — `http://patrickremotedev:7777/health` returns 200.
3. **FQDN** — `http://patrickremotedev.taile9aab9.ts.net:7777/health` returns 200. Confirm the trailing dot was stripped; an allowlist entry ending in `.` matches nothing a browser sends.
4. **IPv4 still works** — no regression on `100.110.206.86`.
5. **IPv6** — `curl -g "http://[fd7a:115c:a1e0::1001:cec3]:7777/health"` returns 200. **This step requires the v6 listener (Proposed Change 7) to be implemented; without it, this step fails with `ECONNREFUSED`, not 403.**
6. **The board loads by name in a real browser**, not just curl. A 200 on `/health` does not prove the static board and its WebSocket both accept the same origin — open `http://<magicdns>:7777/` on the phone and confirm the board renders and updates live.
7. **Rebinding defence intact.** A request with a fabricated `Host` (`curl -H 'Host: evil.example' http://100.110.206.86:7777/health`) still returns 403. This is the assertion that proves the guard was populated rather than loosened.
8. **`--hostname` override** still accepted, and discovered names still work alongside it.
9. **Graceful degradation** — stop `tailscaled`, start `switchboard tailnet`, confirm it starts and serves on the IP with no crash and no hang.
10. **Banner** prints the MagicDNS URL when discovered and omits the line cleanly when not.
11. **Loopback unaffected** — `switchboard local` behaviour is unchanged; this touches the tailnet policy only.
12. **Not an extension change.** Confirm no extension-host behaviour moved: Guard 3 is gated on `serveStatic` (`LocalApiServer.ts:8218`) and the extension does not serve a tailnet listener.
13. **IPv6 listener teardown (if implemented).** Stop `tailscaled` mid-run, confirm the v6 listener error does not crash the server and the v4 + loopback listeners stay up.

## Outstanding Questions
- **[user]** Should the IPv6 tailnet listener (Proposed Change 7) be implemented as part of this plan, or deferred to a separate plan? The name-population work (Changes 1–6) is already implemented and shippable. Research (see Resolved Assumptions) confirms Tailscale always allocates both addresses, MagicDNS returns AAAA records, and Tailscale recommends dual-stack — tilting toward option B (implement the v6 listener now). — proceeding on the assumption that the user will decide after reading this review; the plan documents both the implemented state and the full IPv6 scope so the decision is informed.

## Resolved Assumptions

The following external Tailscale platform behaviors were confirmed via web research (55 sources, including official Tailscale docs, the tailscale/tailscale GitHub repo, and RFC standards):

1. **Tailscale always allocates both a v4 (100.64.0.0/10) and v6 (fd7a:115c:a1e0::/48) address to every node.** Confirmed. No configuration toggle disables v6 allocation. Subnet routers, exit nodes, ephemeral nodes, and tagged devices all receive dual-stack addresses. The v6 listener is therefore not conditional on a "does this node have v6?" check — it always does, when authenticated and online.
2. **Tailscale MagicDNS returns AAAA records for node names.** Confirmed. MagicDNS generates both A and AAAA records for all active devices. Dual-stack clients (modern browsers via Happy Eyeballs / RFC 8305) will attempt v6 first. Without a v6 listener, clients get `ECONNREFUSED` (TCP RST, ~1-5ms fallback) or a silent drop (~250-300ms fallback). The v6 listener eliminates this latency penalty.
3. **`tailscale status --json` always includes both IPs in `Self.TailscaleIPs` when authenticated.** Confirmed. When `BackendState: "Running"`, the array contains both IPs. When stopped/unauthenticated, it returns `null` or `[]`. Array order is not guaranteed — callers must parse by address family, not by index.
4. **Userspace networking mode breaks explicit IP binds.** Confirmed (new finding, not in the original plan). Under `--tun=userspace-networking` (containers, `tsnet`), tailnet IPs do not exist on any OS interface. `bind()` to `100.x` or `fd7a:...` fails with `EADDRNOTAVAIL`. This is a pre-existing latent issue for the v4 bind too, not introduced by the v6 change. Mitigation: fall back to `0.0.0.0`/`::` wildcard bind on `EADDRNOTAVAIL`, or document that Switchboard tailnet mode requires kernel-mode Tailscale.
5. **Tailscale recommends dual-stack listeners.** Confirmed. Official tools (`tailscale serve`, `tailscale funnel`, `tsnet`) bind dual-stack. The recommended approach is either `[::]` with `ipv6only: false` or separate listeners per IP. This plan uses the separate-listener approach to preserve the existing `_isTailnetSocket` identification model.
