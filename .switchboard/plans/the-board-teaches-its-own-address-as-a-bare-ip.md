# The Board Teaches Its Own Address as a Bare IP

## Goal

The address an operator learns on first run is the one they should keep using: a name, over
HTTPS, with no port. The bare tailnet IP stops being the thing the product puts first.

### Problem analysis

`cli.ts:4550` prints:

```js
console.log(`[switchboard] Tailnet address: ${tailnetAddress}${magicDnsNames.length ? ` (${magicDnsNames.join(', ')})` : ''}`);
```

which on a live host reads:

```
[switchboard] Tailnet address: 100.110.206.86 (patrickremotedev.taile9aab9.ts.net, [fd7a:115c:a1e0::1001:cec3])
```

The bare IP is first and unqualified. The stable, memorable name is parenthesised behind it,
alongside an IPv6 literal that no one will ever type. So the address an operator copies, bookmarks,
installs to a home screen and pastes to a colleague is `100.110.206.86:7777` — and every later
document and habit is built on it.

This is a teaching defect, not a formatting one. Three things follow from it:

**The IP is the least durable identifier available.** A tailnet address survives a reboot but not
a re-auth onto a different tailnet, a node re-key, or a rebuild. The MagicDNS name survives all
three, and a renamed host (`tailscale set --hostname=switchboard`) survives even the machine.

**It trains the port in.** `:7777` is an implementation detail of the loopback bind. An operator
who learns `IP:7777` has no reason to look for anything better, and will report the port as part
of the product's address forever.

**It forecloses HTTPS silently.** `tailscale serve --bg 7777` puts the board behind
`https://<name>` on 443, tailnet-only, with a real cert — and that is not cosmetic. A plain-HTTP
origin is not a **secure context**, so `navigator.clipboard.readText()` is unavailable and the
terminal paste button must fall back to a modal the operator pastes into by hand: measured
2026-09-13 at four actions where one would do. Service workers are unavailable too, which blocks
the home-screen install the mobile work depends on.

So the bare-IP banner is upstream of a UX defect that has its own plan, and nothing connects them.

### What is already shipped (read before implementing)

The HTTPS / no-port / advisory half of this goal is **already delivered** by the "Tailnet URL"
resolver block, shipped under `the-tailnet-url-never-offers-a-secure-origin`:

- `src/standalone/cli.ts:4741-4762` (foreground) and `:4651-4666` (detach) call `resolveTailnetUrl`,
  which prefers `https://<fqdn>` when `tailscale serve` is configured and the cert is live, falls
  back through `http://<fqdn>:<port>` to `http://<ip>:<port>`, prints the IP as a secondary
  `Fallback (IP)` line, and emits exactly one advisory line when the origin is insecure.
- `src/extension.ts:1377-1391` consumes the same `resolveTailnetOrigin` and emits the same
  advisory. `src/test/tailscale-bind-contract.test.js:182-230` gates this (resolver present in
  both roots, no hardcoded IP in the primary emission, HTTPS probe, serve-config parser).

The **remaining** defect is the *early detection banner* — `cli.ts:4550` (standalone) and its
exact analogue `TaskViewerProvider.ts:4036` (extension) — which print the bare IP first, before
the resolver block runs, and which the resolver block does not replace. That banner is what this
plan actually changes.

### Not the same as the existing address plan

`starting-the-board-prints-where-to-reach-it-and-opens-nothing` settles **which** address is
printed per subcommand, and that a token never is. Those four rules stand and are not reopened
here. This plan is about the **form** of the address that plan prints, and the fact that nothing
tells an operator a better form exists.

### Non-goals

- **Switchboard running `tailscale serve` itself.** The product does not reconfigure the
  operator's network. It detects, reports, and points at the command.
- **Funnel, or any public exposure.** Serve keeps the board tailnet-only. Funnel is a different
  decision and is not recommended by this plan.
- **Reopening the four printing rules**, or printing a token. Never a token.

## Metadata

**Feature:** 224042f4-92bd-4dc0-82e8-996deb9e2bdc
- **Complexity:** 4
- **Tags:** cli, docs, ux

## User Review Required

None. The scope decision — detect and advise, never configure `tailscale serve` — is inherited
from the shipped resolver plan and needs no product call. One design choice (demote the banner
from an address to a detection line) is made below and justified; if the operator prefers the
banner deleted entirely, that is a smaller change in the same direction and needs no new plan.

## Complexity Audit

### Routine
- Reordering the banner interpolation to lead with the MagicDNS name and demote the IPv4 to a
  parenthetical, in two files (`cli.ts:4550`, `TaskViewerProvider.ts:4036`) that already hold the
  same pattern.
- Dropping the bracketed IPv6 literal from the banner headline (it remains available in the
  resolver block's `Tailnet (IPv6)` side-line, which is unaffected).
- Correcting the stale "prints two URLs … IP" sentence in `docs/REMOTE_ACCESS.md` to match the
  resolver's best-URL behaviour, and adding the `tailscale serve` / HTTPS step to the Home Screen
  section that already teaches MagicDNS-over-IP.

### Complex / Risky
- **The banner-vs-resolver redundancy is a design decision, not a format tweak.** The banner at
  `cli.ts:4550` and the resolver block at `cli.ts:4746` both print a tailnet address for the same
  mode. Fixing the banner's form in place leaves two name-first address lines and the operator
  with no way to tell which to copy. The chosen resolution (below) demotes the banner to a
  *detection* line and lets the resolver block own the *address* — killing the redundancy and the
  bare-IP-first defect in one move.
- **Two composition roots, one plan.** The standalone banner (`cli.ts:4550`) and the extension
  banner (`TaskViewerProvider.ts:4036`) are the same pattern. Both change, or the plan diverges
  the two hosts — the exact failure mode AGENTS.md names as the largest trap in this repo.

## Edge-Case & Dependency Audit

- **Race Conditions:** none. The banner prints during tailnet detection (pre-boot); the resolver
  block prints after `waitForHealth`. They never compete for the same stdout line because they
  are sequenced by the boot. Demoting the banner to a detection line removes the only
  *semantic* race — two lines claiming to be "the address".
- **Security:** no change to the bind policy, Host guard, or token machinery. The banner is
  presentation only; reordering its fields does not widen the Host allowlist (that is populated
  from `magicDnsNames` regardless of print order).
- **Side Effects:** the `magicDnsNames` array is also consumed by `tailnetAcceptable`
  (`cli.ts:4555`) and the bind policy (`cli.ts:4718`). Reordering the *print* must not reorder or
  filter the array itself — the array feeds the Host guard. The change is to the template
  literal only.
- **Dependencies & Conflicts:** depends on the shipped resolver (`src/utils/tailnetOrigin.ts`)
  and the shipped serve-config detector (`detectServeConfigMapping`). This plan does not modify
  either; it relies on the resolver block already printing the authoritative address. No
  conflict with `starting-the-board-prints-where-to-reach-it-and-opens-nothing` — that plan's
  four printing rules are about *which* address per subcommand; this plan is about the *form* of
  the early banner, which that plan does not reach.

## Dependencies

None. The resolver and serve-config detector this plan relies on are already shipped and gated
by `test:contract:tailscale-bind`.

## Adversarial Synthesis

Key risks: (1) the plan as originally written re-implemented the already-shipped resolver block
(Proposed Change #2) — superseded, the remaining work is the banner only; (2) the plan touched
only the standalone banner and silently omitted the identical extension banner at
`TaskViewerProvider.ts:4036` — the divergence trap this repo's rules exist to prevent — both
banners are now co-equal targets; (3) fixing the banner's form in place leaves two address lines
for one mode ("which do I copy?") — resolved by demoting the banner to a detection line and
letting the resolver block own the address. Mitigations: supersede #2, add the extension target,
make the redundancy decision explicit.

## Proposed Changes

### 1. Demote the banner from an address to a detection line (standalone + extension)

> **Superseded:** "Lead with the name, demote the IP" — i.e. reorder the banner interpolation at
> `cli.ts:4550` so the MagicDNS name is first and the IPv4 is parenthesised, keeping the banner as
> an address line alongside the resolver block.
> **Reason:** the resolver block at `cli.ts:4746`/`:4654` already prints the authoritative,
> name-first, HTTPS-aware address. Fixing the banner's form in place produces *two* name-first
> address lines for one mode, and the operator has no way to tell which to copy. The teaching
> defect is redundancy, not just word order. The banner's real job is pre-boot detection
> confirmation — it prints before `startHeadlessSwitchboard`, the resolver prints after — so the
> two have different roles and should print different *kinds* of thing.
> **Replaced with:** Demote the banner to a *detection* line. Print the MagicDNS name as the
> subject and the IPv4 as a parenthetical; drop the bracketed IPv6 literal from the headline
> entirely (it remains in the resolver block's `Tailnet (IPv6)` side-line, which is unaffected).
> The resolver block remains the single *address* print. When no MagicDNS name resolves, the IP
> is the subject and is printed alone — the existing behaviour, preserved.

**`src/standalone/cli.ts:4550`** — change the banner from an address to a detection line. With a
name available, print e.g. `[switchboard] Tailnet detected: <name> (IP <tailnetAddress>)`; with no
name, print `[switchboard] Tailnet detected: <tailnetAddress>` (IP alone, as today). The IPv6
literal (`magicDnsNames.filter(n => n.startsWith('['))`) is excluded from the headline. The
`magicDnsNames` array itself is **not** filtered or reordered — it still feeds `tailnetAcceptable`
(`:4555`) and the bind policy (`:4718`); only the template literal changes.

**`src/services/TaskViewerProvider.ts:4036`** — the exact analogue: `[TaskViewerProvider] Tailnet
mode: <addr> (<names>)`. Apply the same demotion: name as subject, IPv4 parenthesised, IPv6
dropped from the headline. This is the extension-side banner the original plan omitted; both
composition roots change or the plan diverges the two hosts.

### 2. The HTTPS URL / advisory is already shipped — no new work here

> **Superseded:** "Print the HTTPS URL when serve is configured, and say so when it is not" —
> described as new work.
> **Reason:** `resolveTailnetUrl` / `resolveTailnetOrigin` already prefer `https://<fqdn>` when
> `tailscale serve` is configured and the cert is live, fall back through `http://<fqdn>:<port>`
> to `http://<ip>:<port>`, print the IP as a `Fallback (IP)` line, and emit exactly one advisory
> line when the origin is insecure. This is the shipped work of
> `the-tailnet-url-never-offers-a-secure-origin`, gated by
> `test:contract:tailscale-bind`. The serve-config read uses `detectServeConfigMapping(port)`
> (LocalAPI `/localapi/v0/serve-config` primary, `tailscale serve status --json` fallback) — not
> a bare `tailscale serve status`.
> **Replaced with:** No code change. The resolver block is the authoritative address print and
> already does this. The banner demotion in #1 makes the resolver block the *single* address
> line, which is the point.

### 3. Correct the stale docs and add the serve step

**`docs/REMOTE_ACCESS.md`** — two changes:

- **`:66-69` is stale.** It says the command "prints two URLs: … `http://100.110.206.86:<port>/`
  — tailnet". The resolver now prints the *best* URL (HTTPS FQDN when serve is configured, else
  HTTP FQDN, else HTTP IP) with the IP as a fallback line, not a bare IP as the tailnet address.
  Correct this to describe the resolver's actual behaviour: the tailnet URL is the best
  available origin, the IP is the fallback.
- **`:103-117` (Home Screen install) already teaches MagicDNS-over-IP** and stands. Add the
  `tailscale serve` / HTTPS step to the same section: rename the host
  (`tailscale set --hostname=switchboard`), run `tailscale serve --bg 7777` for HTTPS on 443
  (tailnet-only, real cert), then install from `https://<name>` with no port. This is the
  three-step form the original plan #3 described; it lands here because this is the deployment
  section an operator actually reads.

### 4. The port file is not an address — recorded as a question, not a code change

> **Superseded:** "The port file is not an address" — proposed as a code change with no target
> site.
> **Reason:** the proposal named no line that wrongly presents the port file or the port as the
> public address. `cli.ts:4706` warns "discovery will require api-server-port.txt" —
> operator-facing, but about *local CLI discovery*, not the public address. The `:7777` port in
> the resolver block's `http://<name>:<port>/` is *part of the reachable address* when serve is
> not configured; stripping it breaks the URL. The principle is sound but the code target does
> not exist.
> **Replaced with:** Recorded as an Outstanding Question (below). Proceed on the assumption that
> the ephemeral-port warning and the plain-HTTP `:port` are both acceptable as-is until serve is
> configured.

## Verification Plan

### Automated Tests

1. **New** `src/test/startup-address-form-contract.test.js`, wired as
   `test:contract:startup-address-form` **and invoked from
   `.github/workflows/integration-tests.yml`** — defined-but-not-invoked is not a gate. Scoped to
   the *banner* (the resolver block is already gated by `test:contract:tailscale-bind`; do not
   re-test it). Asserts:
   - In `src/standalone/cli.ts`, the `Tailnet detected:` / `Tailnet address:` banner line leads
     with a MagicDNS name (not the bare IPv4) when `magicDnsNames` is non-empty; the bracketed
     IPv6 literal does not appear in the banner interpolation; with no name the IPv4 is printed
     alone.
   - In `src/services/TaskViewerProvider.ts`, the `Tailnet mode:` banner applies the same
     name-first / no-IPv6-headline form (the extension-side check the original plan omitted).
   - No token appears in any startup output — the existing rule, re-pinned here because this
     plan edits the same lines.
2. **Do not** assert the resolver block's HTTPS/advisory behaviour here — that is owned by
   `test:contract:tailscale-bind` and re-asserting it duplicates the gate.

### Goal Invariants

- The standalone banner (`cli.ts:4550`) and the extension banner (`TaskViewerProvider.ts:4036`)
  both lead with the MagicDNS name when one is available; neither prints a bracketed IPv6 literal
  in the headline.
- The resolver block (`cli.ts:4746`/`:4654`, `extension.ts:1382`) remains the single *address*
  print: with serve configured it emits `https://<name>` (no port); without, it emits
  `http://<name>:<port>` plus exactly one advisory line.
- The `magicDnsNames` array is unchanged in order or content — it still feeds `tailnetAcceptable`
  (`cli.ts:4555`) and the bind policy (`cli.ts:4718`); only the banner's template literal changes.
- The four printing rules from `starting-the-board-prints-where-to-reach-it-and-opens-nothing` are
  unchanged: one address per subcommand, none for bare `switchboard`, never a token.
- `docs/REMOTE_ACCESS.md:66-69` no longer states the command prints a bare-IP tailnet URL; the
  Home Screen section names `tailscale serve` as the HTTPS step.

## Outstanding Questions

- **[user]** Should the ephemeral-port fallback warning (`cli.ts:4706`) stop naming
  `api-server-port.txt`, and is the `:port` in the resolver block's plain-HTTP URL acceptable
  until `tailscale serve` is configured? — proceeding on the assumption that both are acceptable
  as-is: the warning is about local CLI discovery, and the port is genuinely part of the
  reachable address without serve. No code change is made for this in the current pass.
