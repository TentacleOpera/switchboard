# The Tailnet LocalAPI Probe Omits the Host Header, So MagicDNS Names Are Never Discovered and the Remote Board 403s

## Goal

`switchboard tailnet` must serve a board that is actually reachable at the name a person types on their phone. Today it starts, reports success, and then rejects every request that arrives under the machine's MagicDNS name with `403 Access denied: invalid Host header`.

### Problem analysis

Reported as: *"when I use the Switchboard CLI and choose 'Start Remote Tailnet Board', it only starts a local Switchboard and remote is not accessible."*

The first half of that is not what happens, and the difference matters for the fix. The tailnet listener **is** created. Measured on this machine, 2026-09-04, against a board started from the CLI menu's option 2:

```
$ ss -ltnp | grep 7777
LISTEN  127.0.0.1:7777        pid=3985718
LISTEN  100.110.206.86:7777   pid=3985718      ← the tailnet listener exists
```

The board is reachable at the raw tailnet IPv4 address and answers `/health` with 200. What fails is every path a person would actually use:

| What a remote device asks for | Result |
| :--- | :--- |
| `http://100.110.206.86:7777/` (raw tailnet IP) | **200** — works, but nobody types this |
| `http://patrickremotedev.taile9aab9.ts.net:7777/health` (MagicDNS FQDN) | **403** `{"error":"Access denied: invalid Host header"}` |
| `http://patrickremotedev:7777/` (MagicDNS short name) | connection refused |
| `http://[fd7a:115c:a1e0::1001:cec3]:7777/` (tailnet IPv6) | connection refused |

So the board is remote-*serving* but not remote-*addressable*, and from the operator's seat that is indistinguishable from "it only started locally".

#### Root cause: the Tailscale LocalAPI rejects a request with no `Host` header, and the failure is swallowed

The bind policy's `magicDnsNames` array is what the Host-header guard checks a request against. It is populated by `resolveMagicDnsNames()` in `src/utils/tailnetDetect.ts`, which reads `Self.DNSName` from the Tailscale LocalAPI over its unix socket.

That call omits the `Host` header the LocalAPI requires. Measured, same machine, same socket:

```
$ node -e "http.get({socketPath:'/var/run/tailscale/tailscaled.sock', path:'/localapi/v0/status'}, …)"
status 403
body   invalid localapi request

$ node -e "…same call plus headers:{Host:'local-tailscaled.sock'}…"
status 200   DNSName= patrickremotedev.taile9aab9.ts.net.
```

Tailscale's LocalAPI enforces the `Host` header as its cross-origin defence for a socket that is world-readable (`srw-rw-rw- root root`). Without it, every request is refused.

`resolveMagicDnsNames()` catches that refusal and **returns `[]`** — the same value it returns for a machine that genuinely has no MagicDNS name. The caller cannot tell the two apart, so `switchboard tailnet` prints a success banner, builds a bind policy with an empty name list, and the Host guard then refuses the only name a human has.

This is precisely the failure mode the project's own rule names: a fallback that behaves exactly like a configured value turns a loud failure into a quiet wrong answer.

#### The same omission sits in the sibling probe, where it is worse

`probeLocalApiSocket()` (`tailnetDetect.ts:93-94`) builds its request the same way, with no `Host` header. It is the fallback for `detectTailnetAddress()`.

Today that is invisible, because the ordered CLI probe (`tailscale ip -4`) succeeds first on this machine. But the module's own header comment explains why the fallback exists: the `tailscale` binary is **not on PATH on macOS**, and a GUI-launched editor inherits no login-shell PATH on any platform. On exactly the host the fallback was written for, both probes now fail, `detectTailnetAddress()` returns null, and `switchboard tailnet` exits 1 with:

> `Tailscale is not running on this machine (no interface address found).`

on a machine where Tailscale is running. That is a false negative with a worse blast radius than the reported bug, and it is one line away in the same file.

#### Why an existing plan did not catch this

*Tailnet Mode Accepts The Node's Own MagicDNS Names Without Being Told Them* lists this exact work as complete: *"Reading `Self.DNSName` from the Tailscale LocalAPI status payload and stripping the trailing dot — already implemented in `resolveMagicDnsNames()`"*, and *"Feeding the discovered names into `bindPolicy.magicDnsNames` — already implemented."*

Both statements are true about the code and false about the behaviour. The function exists, is wired, is called, and returns nothing. Nothing between the socket and the bind policy reports that the array is empty because a request was refused rather than because a name does not exist.

#### Two adjacent defects, deliberately not in this plan

1. **No IPv6 listener.** The node has a tailnet IPv6 address and only the IPv4 one is bound, so a client preferring AAAA cannot connect at all. Owned by change 7 of the MagicDNS plan in this feature.
2. **The printed URL is the loopback one.** The startup banner offers `http://127.0.0.1:7777/?token=…` as "Board URL" and the tailnet URL separately without a token. Owned by *`switchboard tailnet` prints the credential-free tailnet URL and then opens the credentialed one*.

Fixing the Host header does not fix either, and neither of them explains the 403.

## Metadata

- **Complexity:** 3
- **Tags:** standalone, tailnet, remote-access, bugfix

## User Review Required

None.

## Proposed Changes

### 1. Send the `Host` header on every LocalAPI request

In `src/utils/tailnetDetect.ts`, both `probeLocalApiSocket()` (`:93`) and `resolveMagicDnsNames()` (`:156`) add `headers: { Host: 'local-tailscaled.sock' }` to their `http.get` options.

Put the literal in one exported constant with a comment naming why it exists — that the LocalAPI enforces it as its cross-origin defence on a world-readable socket, and that omitting it yields `403 invalid localapi request` rather than a transport error. Two call sites drifting apart on this value is how the bug reaches only one of them.

### 2. Make an empty name list distinguishable from a refused probe

`resolveMagicDnsNames()` currently returns `string[]`, and `[]` means both "no name" and "the probe failed". Change the return to carry its source, matching the project's tagging rule:

```ts
type MagicDnsResult =
  | { names: string[]; source: 'localapi' }        // probe answered; names may legitimately be empty
  | { names: []; source: 'unavailable'; reason: string };  // socket missing, refused, or unparseable
```

`reason` records the distinguishing fact: no socket at any candidate path, HTTP status with the body's first line, a JSON parse failure, or the 4s timeout.

### 3. Say so, at startup, when the names could not be resolved

In `src/standalone/cli.ts`, where the tailnet banner is printed (`~:3382`), when the result is `unavailable`, print a warning that names the consequence rather than the mechanism:

```
[switchboard] Could not read this machine's MagicDNS name from Tailscale (<reason>).
[switchboard] The board is reachable at http://100.110.206.86:7777 but NOT at its
[switchboard] tailnet name — a request under that name will be refused. Pass
[switchboard] --hostname <name> to accept it explicitly.
```

Do **not** exit non-zero. A board on the raw tailnet address is still useful, and the existing `--hostname` escape hatch already covers the operator who knows their name. The defect being fixed is silence, not the degraded mode.

### 4. The same fix in the extension host

`src/services/TaskViewerProvider.ts:122` imports both functions and `src/extension.ts:1322-1328` renders MagicDNS URLs from `bindPolicy.magicDnsNames`. With an empty array that UI silently shows no MagicDNS line, which reads as "this machine has none".

The probe fix in change 1 is shared code and reaches both hosts automatically. What is **not** automatic is the reporting: surface the `unavailable` reason on the extension side too, wherever that URL block is rendered, so the two hosts do not disagree about whether a name exists. Diff the two call sites by hand rather than assuming the shared module covers it.

### 5. Regression test

`src/test/tailnet-localapi-host-header-contract.test.js` (new), wired into `package.json` and `.github/workflows/integration-tests.yml`:

- Stand up a unix-socket HTTP server that replies **403 `invalid localapi request`** when `req.headers.host` is absent or unexpected, and a `Self.DNSName` payload when it equals `local-tailscaled.sock`. That mirror is the whole point: a test that accepts any Host header cannot fail on this bug.
- Assert `resolveMagicDnsNames()` returns the FQDN with its trailing dot stripped and lower-cased.
- Assert that against a server which always 403s, the result is `source: 'unavailable'` with a non-empty `reason` — **not** an empty success.
- Assert both call sites send the header, by source-reading the module for two occurrences of the shared constant. A behavioural test only covers the one probe it calls.

## Edge-Case & Dependency Audit

1. **Does Tailscale accept any other Host value?** `local-tailscaled.sock` is the documented one and is what the official client sends. If a future version widens it, the constant is the single place to change.
2. **macOS App Store socket path.** The candidate list already carries the sandbox container path. The header applies identically; nothing else changes.
3. **Windows.** `candidateLocalApiSockets()` returns `[]` on win32 — the LocalAPI there is a named pipe and is out of scope. This plan must not make the win32 path worse; it currently yields `unavailable` with reason "no candidate socket on this platform", which is honest.
4. **A machine with no MagicDNS.** Tailnets can have MagicDNS disabled. Then the probe answers 200 with an empty or dotless `DNSName`, giving `source: 'localapi'` with `names: []` — correctly distinguished from a refusal, and the warning does not fire.
5. **The short-name case is not this bug.** `patrickremotedev` resolves to `127.0.1.1` from `/etc/hosts` on Debian-family systems, so it fails to connect before any Host guard runs. Adding the bare label to the allowlist would not fix it and would widen the guard for no gain. The MagicDNS plan in this feature already records that reasoning; do not re-litigate it here.
6. **Ordering within the Tailnet feature.** This plan is a **prerequisite of the CSRF guard**, whose allow-set reads `bindPolicy.magicDnsNames`. With that array empty, the CSRF guard would reject the tailnet board even after its own fix, for a different reason. Land this first, or the two defects mask each other.

## Dependencies

Subtask of the **Tailnet** feature. It lands **first**, before the MagicDNS plan's remaining IPv6 work and before the CSRF guard, because both of those consume the name list this plan actually populates.

## Verification Plan

Each step is a measurement, and the before-values are recorded above from this machine.

1. **The reported bug, end to end.** Start the board from the CLI menu's `[2] Start Remote Tailnet Board`. From another tailnet device, open `http://<magicdns-fqdn>:7777/`. It loads the board. Before this fix it returns `403 Access denied: invalid Host header`.
2. `curl -s http://<magicdns-fqdn>:7777/health` returns 200 rather than 403.
3. The startup banner lists the MagicDNS name alongside the tailnet address, which today prints the address alone.
4. **The false-negative case.** With the `tailscale` binary made unreachable on the probe path, `switchboard tailnet` still detects the address through the LocalAPI fallback and starts, rather than exiting 1 with "Tailscale is not running".
5. **The loud-failure case.** Against a socket that refuses, the board still starts on the raw tailnet address and prints the warning naming the reason. It does not exit, and it does not print a success banner implying the name works.
6. `npm run test:contract:tailnet-localapi-host-header` passes, including the negative control.
7. The raw tailnet IPv4 address still serves, and loopback still serves — neither regresses.
8. Both hosts agree: with names resolved, the extension host's MagicDNS URL block lists the same name the standalone banner prints.
