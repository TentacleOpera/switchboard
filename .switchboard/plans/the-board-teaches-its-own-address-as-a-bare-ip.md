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

- **Complexity:** 2
- **Tags:** cli, docs, tailnet, ux

## User Review Required

None.

## Proposed Changes

### 1. Lead with the name, demote the IP

Print the MagicDNS name as the address. The IPv4 becomes a fallback shown after it, and the IPv6
literal is dropped from the headline entirely — it is diagnostic output, not an address anyone
types.

When no MagicDNS name resolves, the IP is the address and is printed alone, as today.

### 2. Print the HTTPS URL when serve is configured, and say so when it is not

Read `tailscale serve status`. If the board is already served, print
`https://<name>` with no port — that IS the address, and the loopback port is no longer part of
it.

If it is not, print one line naming the command and the reason it is worth running: HTTPS, no
port, and clipboard/PWA support that plain HTTP cannot provide. One line, once, at startup —
not a tutorial, and not repeated in every log.

### 3. Say it once in the docs, where the deployment is described

The Pi/appliance setup documentation gets the same three-step form: rename the host, run serve,
use the name. It is the first thing an operator does and the last thing they should have to
rediscover.

### 4. The port file is not an address

`.switchboard/api-server-port.txt` exists for local callers resolving the loopback port. Nothing
in operator-facing output should present it, or the port, as part of how a person reaches the
board — the two audiences are different and conflating them is how `:7777` became the public
face.

## Verification Plan

### Automated Tests

1. **New** `src/test/startup-address-form-contract.test.js`, wired as
   `test:contract:startup-address-form` **and invoked from
   `.github/workflows/integration-tests.yml`** — defined-but-not-invoked is not a gate. Asserts:
   with a MagicDNS name available the printed headline address is the name, not the IPv4; the
   IPv6 literal does not appear in the headline; with no name available the IPv4 is printed
   alone.
2. Assert a serve-configured host prints an `https://` URL with no port, and an unconfigured one
   prints exactly one line naming the command.
3. Assert no token appears in any startup output — the existing rule, re-pinned here because this
   plan edits the same lines.

### Goal Invariants

- An operator reading first-run output copies a name, not an IP, and not a port.
- With serve configured, the printed address is a working `https://` URL and the clipboard path
  in the terminal panel is the one-tap one.
- The four printing rules from the existing address plan are unchanged: one address per
  subcommand, none for bare `switchboard`, never a token.
