# Remote Switchboard is Tailscale, and nothing else

## Goal

Give Switchboard exactly one remote story, as its own subcommand: **`switchboard tailnet`** binds the board to the machine's Tailscale interface and serves it to that tailnet. **`switchboard local`** is the loopback board. Two named modes, no flags to remember. No token, no enrolment, no pairing, no tunnel to maintain. Loopback stays the default. **No other bind address is offered** — not a LAN address, not `0.0.0.0`, not an arbitrary IP. One supported way to be remote, and it is the one that cannot be reached from the internet.

### The problem, and the root cause

**Remote does not work, and the product is full of remote-shaped features that cannot function.** `token rotate` is documented as enrolling *"a second device"*. `--hostname` exists. `docs/REMOTE_ACCESS.md` is published. There is a `switchboard-remote` skill and a Remote Control feature. Every one of them sits on a transport that accepts connections from exactly one machine.

**Three guards each refuse a remote connection**, so changing any one alone produces a different-looking bug:

| # | Guard | Where | Effect |
|---|---|---|---|
| 1 | The bind | `LocalApiServer.ts:736` — `listen(port, '127.0.0.1', …)` | kernel refuses; nothing reaches the app |
| 2 | Host allowlist | `_isAllowedHost` (`:7341`) → `isLoopbackHostHeader` | `Host: <tailnet name>` → 403 |
| 3 | Origin allowlist | `_isLocalhostOrigin` (`:7345`) → `isLoopbackOrigin` | board page's Origin → rejected |

Guards 2 and 3 came from `570ddbd5` with `--hostname`, to stop the CLI and server disagreeing about printable names. Guard 1 came with the standalone host in `97cb2ea3`. Neither was written to forbid remote access; both encode "the board is reached from the machine it runs on". `bootstrap.ts` states the consequence outright: *"the bind address is 127.0.0.1 unconditionally; `hostname` only changes the name."* So `--hostname` renames a door that stays locked.

**The workaround is worse than it looks.** An SSH tunnel serves one device that can hold an SSH session — never a tablet or a phone. It fails silently when the local port is already bound by another board: `ssh -L` cannot bind, the error scrolls past in a `-N` invocation, and the browser then talks to the *local* instance instead. That failure has been observed and cost hours of debugging against the wrong machine's logs.

### Why Tailscale is the whole answer

**A tailnet address is not internet-exposed, and is narrower than the LAN.** On this machine the interface is:

```
tailscale0   100.110.206.86/32
wlp4s0       192.168.20.23/24
```

`100.110.206.86` is in `100.64.0.0/10` — CGNAT space. It is not routable from the internet: no port-forward reaches it, no scanner finds it. It is also **not on the LAN** — a laptop on the same wifi cannot reach it except through Tailscale. Binding here is strictly more restrictive than binding to the LAN address, while being the thing that actually makes remote work.

The only route from a tailnet to the public internet is **Tailscale Funnel**, a separate and deliberate opt-in. Binding to the interface does not enable it.

**The tailnet has already authenticated the peer.** Tailscale admits a node only after it authenticates to the coordination server, and ACLs are the operator's tool for narrowing which nodes may reach a port. Demanding a bearer token on top asks the operator to prove something the network proved before the packet arrived — and that demand is the reason remote is unusable today. So: **no credential, no enrolment step, no QR code, no pairing.** Open the URL; the board loads.

**Guard 2's rationale does not survive here either.** It defends against DNS rebinding, which requires a hostile page to resolve a name to the victim's address. A tailnet name resolves only inside the tailnet, from the operator's own coordination server. There is nothing to rebind.

### Deliberate non-goals

- **No arbitrary bind address.** No `--bind <ip>`, no `0.0.0.0`, no LAN binding. Every one of those is an exposure decision an operator can get wrong, and supporting them means owning the consequences. The project is open source; anyone who wants a different posture can change one constant and accept what follows. Offering it as a supported flag is what turns "your call" into "our default".
- **No tunnel lifecycle management.** `switchboard-as-a-local-app-and-a-self-hosted-remote.md` proposes an app that establishes, monitors and re-establishes an SSH/Tailscale tunnel to loopback, on the premise that loopback is an invariant (its line 32: *"Binding off loopback. Explicitly out of scope, and the plan should be read as forbidding it"*). **That premise is rejected.** Tunnelling to loopback to avoid binding to an interface that is already private is machinery in place of a setting. Its *launcher* idea — Switchboard as something you start rather than an IDE you open — is good and independent; keep that, drop the tunnel half. Do not implement both.
- **No credential of any kind on this path.** Stated again because it is the requirement most likely to be quietly reintroduced as a "small" enrolment step.

## Metadata

- **Complexity:** 4
- **Tags:** backend, api, infrastructure, feature, devops

## User Review Required

None. Four decisions made and recorded:

1. **Two subcommands, not a flag.** `switchboard local` serves loopback; `switchboard tailnet` serves the tailnet (plus loopback — see the two-listener note). The mode is the command the operator types, so it is visible in shell history, in `ps`, in a systemd unit and in documentation — none of which is true of a flag buried after `start`.

   **`start` is removed.** There are two commands to serve a board and `start` is neither. Keeping it as an alias would leave three ways to say two things, and the ambiguity it creates — *which* mode does `start` mean? — is exactly what this decision exists to end. It is replaced by an error that names both modes:

   ```
   $ switchboard start
   [switchboard] `start` has been replaced. Use `switchboard local` (this machine)
                 or `switchboard tailnet` (reachable on your tailnet).
   ```

   That error is not a compatibility shim — it is the discoverability the flag never had, and it exits non-zero. Known consequence, stated rather than mitigated: `start` appears in shipped docs, in `docs/REMOTE_ACCESS.md`, and in any script or systemd unit an operator already wrote. All of those must be updated in this change; anything missed produces the error above rather than a silent wrong mode.

   There is deliberately **no `--tailscale` flag** and no `--bind`. A mode is a mode; expressing it as a modifier on a third command is what makes it forgettable.
2. **Detect, do not ask.** `tailnet` reads the interface address itself. The operator types a word, never an IP.
3. **Fail loudly when Tailscale is absent or down.** `switchboard tailnet` with no interface exits non-zero with a message naming Tailscale — never a silent fall back to loopback (which looks like it worked) and never to `0.0.0.0`. `switchboard local` is always available as the answer.
4. **No auth on this path.** Tailnet membership is the control. Machine callers may still present `Authorization: Bearer <token>`; humans present nothing.

## Complexity Audit

### Routine

- Reading the `tailscale0` address; threading one boolean into the server.
- Widening two predicates to accept the tailnet address and MagicDNS name.

### Complex / Risky

- **Both composition roots.** The extension wires `LocalApiServer` via `TaskViewerProvider`; standalone via `bootstrap.ts`. This is constructor config, not a verb, so a verb-reachability audit proves nothing. Diff the roots by hand.
- **Interface detection.** Prefer Tailscale's own local API or `tailscale ip -4` over parsing `ip addr`, which differs across platforms. macOS names the interface `utun<N>`, not `tailscale0` — hardcoding the Linux name ships a feature that never works on the operator's own Mac.
- **MagicDNS names in the Host header.** A browser may send `patrickremotedev.taile9aab9.ts.net`, the bare `patrickremotedev`, or the raw `100.x` address. All three must pass guard 2, or the board connects and 403s.

## Edge-Case & Dependency Audit

- **Tailscale not yet up at boot** — `listen` throws `EADDRNOTAVAIL`. Report it naming the address and the likely cause, not a stack trace.
- **The address changes** across re-auth or a node rename. Re-detect at start; do not persist it.
- **The printed board URL** must use the tailnet address or MagicDNS name, never `127.0.0.1`.
- **WebSocket upgrade** enforces its own Host/Origin checks. Widen in step, or the board loads and never updates — the failure that reads as a hang.
- **IPv6.** The interface also carries `fd7a:115c:a1e0::/128`. Bind v4 first; accept the v6 Host if a client uses it.
- **Loopback is not replaced — it is added to. This is the required design, not a fallback.**
  `server.listen(port, address)` binds exactly one address, so tailnet mode means **two listeners sharing one request handler**, not a bind moved. `0.0.0.0` would serve both but also the LAN, which is the thing being refused.

  This is load-bearing: every in-tree client talks to loopback. `sb_api_call.sh` (behind every ClickUp, Linear, get-tickets and kanban skill) resolves `.switchboard/api-server-port.txt` and curls `http://localhost:$PORT`; the seven `kanban_operations/*.js` scripts each reimplement the same lookup; and **39 references to that port file across 11 source files** appear in generated agent prompts telling seats to POST `queue/next`, `queue/done` and `task/complete`. If `--tailscale` moved the bind instead of adding one, every local agent client breaks the moment the operator goes remote — completions stop being posted, queues stall, and nothing reports an error.

## Dependencies

- **Retires the tunnel half** of `switchboard-as-a-local-app-and-a-self-hosted-remote.md`; keeps its launcher idea. Resolve before either is coded.
- **Absorbs the docs half** of `a-phone-on-the-tailnet-has-nothing-to-connect-to.md` (the `docs/REMOTE_ACCESS.md` rewrite); its terminator mechanism is retired for the same reason.
- **Independent of `browser-board-csrf-cross-site-rejection.md`, but read this before assuming so.**

  A hostile page can already reach `127.0.0.1:<port>` today. The body parser never inspects `Content-Type` (`:1396` calls `JSON.parse` on whatever arrived), so a `text/plain` POST is a CORS *simple request* — no preflight — and `_checkAuth` returns true whenever the expected token is empty, which is always on the extension host. The CORS policy only withholds the *response*; the side effect has already happened. `Host: 127.0.0.1:<port>` passes guard 2 by construction.

  So the exposure is **created by the missing origin check, not by this plan**, and it exists on every install right now whether or not anyone ever goes remote. This plan does not widen it: a tailnet peer is a node the operator authenticated, and the hostile-page path is identical before and after.

  What it *does* mean is that the CSRF fix is urgent on its own merits. The reachable impact is narrower than "arbitrary shell": `/terminals/relay` validates both endpoints against the live pty fleet and delivers into an **agent's** prompt, so the realistic outcome is prompt injection into a running agent — which matters here because seats run with `--dangerously-skip-permissions` and `--permission-mode bypass`. Land the origin check; do not treat it as this plan's prerequisite, and do not let this plan be used as an argument that it can wait.

## Adversarial Synthesis

Key risks. (1) Hardcoding `tailscale0` and shipping a mode that never works on macOS — mitigation: use `tailscale ip -4` or the local API; test on both platforms. (2) Widening the bind but not guards 2 and 3, producing connect-then-403 — mitigation: all three land together, acceptance is a real device. (3) A credential prompt creeping back in as a "small" enrolment step — mitigation: verification step 7 fails if anything is typed. (4) `--tailscale` silently falling back to loopback when Tailscale is down, so the operator believes remote is on — mitigation: hard exit. (5) Landing in one composition root — mitigation: hand-diff.

## Proposed Changes

### `src/services/LocalApiServer.ts`

- Accept a bind address in options (default `127.0.0.1`); use at `:736`.
- `_isAllowedHost` / `_isLocalhostOrigin`: accept loopback names **plus** the bound tailnet address and its MagicDNS names.
- Same widening on the WebSocket upgrade path.
- No credential requirement added on this path.

### `src/standalone/cli.ts` / `bootstrap.ts`

- Replace `start` with `local` and `tailnet`. Both accept every flag `start` accepts today (`--detach`, `--port`, `--workspace`, `--no-open`/`--open`). `start` becomes an error naming the two modes, exiting non-zero.
- `tailnet`: detect the address via `tailscale ip -4` or the local API, open the second listener on it, derive the printed URL from it. Exit with a Tailscale-specific message if unavailable. There is no code path that accepts an operator-supplied bind address.
- Update the usage block: the two modes are the first thing it lists.

### The extension composition root

- Same option, same detection, same behaviour.

### `docs/REMOTE_ACCESS.md`

- Rewrite: the two commands (`local`, `tailnet`) and the removal of `start`; Tailscale is the supported remote path; what it exposes (a tailnet, not the internet); ACLs as the narrowing tool; Funnel explicitly out of scope.

## Files Changed

- `src/services/LocalApiServer.ts`
- `src/standalone/cli.ts`, `src/standalone/bootstrap.ts`
- the extension composition root
- `docs/REMOTE_ACCESS.md`
- `src/test/tailscale-bind-contract.test.js` — new

## Verification Plan

### Automated

1. **`switchboard local` binds `127.0.0.1`** and nothing else.
2. **`switchboard tailnet` binds the detected address**, not `0.0.0.0`. Assert the literal.
3. **No arbitrary address is accepted** — passing an IP is refused. Guards the non-goal.
4. **`switchboard tailnet` with Tailscale down exits non-zero**, naming Tailscale; asserts it does **not** silently serve loopback only.
4b. **`switchboard start` exits non-zero and names both modes.** Assert it does not serve a board — a `start` that quietly starts something is the failure this replaces.
5. **Host allowlist accepts** the tailnet IP, the MagicDNS FQDN and the bare hostname; still accepts loopback.
6. **WS upgrade accepts the same Host set** as HTTP.
7. **No credential is required** — a plain GET from another address returns the board, not a 401.

### Manual

8. **From a tablet on the tailnet**, type the MagicDNS URL: the board loads and updates live with **nothing else typed**. If anything asks for a token or a code, the plan has failed.
9. **From a laptop on the same LAN but not the tailnet**, confirm the board is unreachable.
