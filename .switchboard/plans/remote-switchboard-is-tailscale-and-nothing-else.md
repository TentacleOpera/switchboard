# Remote Switchboard is Tailscale, and nothing else

## Goal

Give Switchboard exactly one remote story, as its own subcommand: **`switchboard tailnet`** binds the board to the machine's Tailscale interface and serves it to that tailnet. **`switchboard local`** is the loopback board. Two named modes, no flags to remember. No token, no enrolment, no pairing, no tunnel to maintain. Loopback stays the default. **No other bind address is offered** — not a LAN address, not `0.0.0.0`, not an arbitrary IP. One supported way to be remote, and it is the one that cannot be reached from the internet.

### The problem, and the root cause

**Remote does not work, and the product is full of remote-shaped features that cannot function.** `token rotate` is documented as enrolling *"a second device"*. `--hostname` exists. `docs/REMOTE_ACCESS.md` is published. There is a `switchboard-remote` skill and a Remote Control feature. Every one of them sits on a transport that accepts connections from exactly one machine.

**Five guards each refuse a remote connection**, so changing any one alone produces a different-looking bug:

> **Superseded:** "**Three guards each refuse a remote connection**" — the bind, `_isAllowedHost`, and `_isLocalhostOrigin`.
> **Reason:** The enumeration is incomplete, and the two it omits are the two that break the plan hardest. `_handleRequest` opens with a **socket peer-address check** (`LocalApiServer.ts:7353`) that 403s every non-loopback `remoteAddress` *before any route runs* — a coder who widens only the three listed guards gets a connection that is accepted by the kernel and then rejected with `Access denied: localhost only`, and the plan's own guard table tells them to look at the Host header. Separately, `_checkAuth` (`:881`) 401s every request on the standalone host, because standalone always resolves a non-empty token (`bootstrap.ts:571-577`, wired at `:2822`). `docs/REMOTE_ACCESS.md` already documents four guards; the plan listed three.
> **Replaced with:** The five-row table below. Guards 1, 2, 3, 4 and 5 must all be addressed, plus the two boot-time hostname validators listed under "The validators that are not request guards".

| # | Guard | Where | Effect |
|---|---|---|---|
| 1 | The bind | `LocalApiServer.ts:736` — `listen(port, '127.0.0.1', …)` | kernel refuses; nothing reaches the app |
| 2 | **Socket peer address** | `_handleRequest` (`:7353-7354`) — `remoteAddress !== '127.0.0.1' && !== '::1'` | 403 `Access denied: localhost only`, before any route runs |
| 3 | Host allowlist | `_isAllowedHost` (`:7340`) → `isLoopbackHostHeader` | `Host: <tailnet name>` → 403. **Gated on `options.serveStatic`** — wired in both roots (`bootstrap.ts:3130`, `TaskViewerProvider.ts:4045`) |
| 4 | Origin allowlist | `_isLocalhostOrigin` (`:7344`) → `isLoopbackOrigin` | board page's Origin → no CORS mirror |
| 5 | **Session auth** | `_checkAuth` (`:881`) | standalone: 401 for any request with no `Authorization: Bearer` and no `sb_session` cookie. Extension: `getAuthToken` returns `''`, so this returns **true** — loopback trust, no credential at all |

Guards 3 and 4 came from `570ddbd5` with `--hostname`, to stop the CLI and server disagreeing about printable names. Guard 1 came with the standalone host in `97cb2ea3`. Neither was written to forbid remote access; both encode "the board is reached from the machine it runs on". `bootstrap.ts` states the consequence outright: *"the bind address is 127.0.0.1 unconditionally; `hostname` only changes the name."* So `--hostname` renames a door that stays locked.

**The workaround is worse than it looks.** An SSH tunnel serves one device that can hold an SSH session — never a tablet or a phone. It fails silently when the local port is already bound by another board: `ssh -L` cannot bind, the error scrolls past in a `-N` invocation, and the browser then talks to the *local* instance instead. That failure has been observed and cost hours of debugging against the wrong machine's logs.

#### The validators that are not request guards

Two further sites reject a non-loopback name before a socket is ever opened. They are not in the table because they never see a request, but a coder who widens all five guards and skips these ships a mode that exits 1:

- `cli.ts:110-125` `resolveHostname` — `process.exit(1)` on any `--hostname` that is not a loopback name.
- `bootstrap.ts:3209-3212` — `throw new Error('hostname must resolve to loopback …')` after `resolveDisplayHostname`. Deliberately duplicated so a *library* caller cannot mint a URL the Host guard would 403; that duplication means both must become mode-aware together.

#### There is no `start` subcommand to remove

> **Superseded:** "**`start` is removed.** … It is replaced by an error that names both modes." — written as though `start` were a dispatched subcommand being deleted.
> **Reason:** `cli.ts` dispatches on `process.argv[2]` for exactly `secrets`, `token`, `export`, `import`, `init`, `scaffold`, `control-plane`, `stop`, `status`, `logs` (`:616`–`:1187`). **`start` is not among them.** It is an unmatched positional that `parseArgs` ignores, and the serve path is the *fallthrough* at the bottom of `main()`. So today `switchboard start`, `switchboard tailnet`, `switchboard local` and `switchboard typo` all serve a loopback board and print a `127.0.0.1` URL.
> **Replaced with:** The work is not "delete a handler and add an error" — it is "introduce a subcommand whitelist where none exists". The error for `start` is one row in that whitelist; the load-bearing part is that **every unrecognised subcommand must exit non-zero**, because the current fallthrough is what makes `switchboard tailnet` on an un-upgraded or half-landed install silently serve loopback and announce success. That is precisely the failure decision 3 exists to forbid, and it is reachable *today* by typing the command this plan adds.

**The usage block's first line is `npx switchboard [options]`** — the bare, no-subcommand form is the documented primary invocation, and `token show`'s own error text tells the operator to "Start one with `npx switchboard`". Decision 5 below settles what it means.

### Why Tailscale is the whole answer

**A tailnet address is not internet-exposed, and is narrower than the LAN.** On this machine the interface is:

```
tailscale0   100.110.206.86/32
wlp4s0       192.168.20.23/24
```

`100.110.206.86` is in `100.64.0.0/10` — CGNAT space. It is not routable from the internet: no port-forward reaches it, no scanner finds it. It is also **not on the LAN** — a laptop on the same wifi cannot reach it except through Tailscale. Binding here is strictly more restrictive than binding to the LAN address, while being the thing that actually makes remote work.

The only route from a tailnet to the public internet is **Tailscale Funnel**, a separate and deliberate opt-in. Binding to the interface does not enable it.

**The tailnet has already authenticated the peer.** Tailscale admits a node only after it authenticates to the coordination server, and ACLs are the operator's tool for narrowing which nodes may reach a port. Demanding a bearer token on top asks the operator to prove something the network proved before the packet arrived — and that demand is the reason remote is unusable today. So: **no credential, no enrolment step, no QR code, no pairing.** Open the URL; the board loads.

**Guard 3's rationale does not survive here either.** It defends against DNS rebinding, which requires a hostile page to resolve a name to the victim's address. A tailnet name resolves only inside the tailnet, from the operator's own coordination server. There is nothing to rebind.

### Deliberate non-goals

- **No arbitrary bind address.** No `--bind <ip>`, no `0.0.0.0`, no LAN binding. Every one of those is an exposure decision an operator can get wrong, and supporting them means owning the consequences. The project is open source; anyone who wants a different posture can change one constant and accept what follows. Offering it as a supported flag is what turns "your call" into "our default".
- **No tunnel lifecycle management.** `switchboard-as-a-local-app-and-a-self-hosted-remote.md` proposes an app that establishes, monitors and re-establishes an SSH/Tailscale tunnel to loopback, on the premise that loopback is an invariant (its line 32: *"Binding off loopback. Explicitly out of scope, and the plan should be read as forbidding it"*). **That premise is rejected.** Tunnelling to loopback to avoid binding to an interface that is already private is machinery in place of a setting. Its *launcher* idea — Switchboard as something you start rather than an IDE you open — is good and independent; keep that, drop the tunnel half. Do not implement both.
- **No credential of any kind on this path.** Stated again because it is the requirement most likely to be quietly reintroduced as a "small" enrolment step.

## Metadata

- **Complexity:** 7
- **Tags:** backend, api, infrastructure, feature, devops, security

> **Superseded:** **Complexity:** 4.
> **Reason:** The 4 was scored against "widen a bind and two predicates". The measured surface is five request guards plus two boot-time hostname validators, across two composition roots whose auth behaviour is *opposite* (guard 5 returns true on the extension and 401s on standalone); a subcommand dispatch table that does not exist yet and whose current fallthrough silently serves loopback for the exact word this plan introduces; cross-platform interface detection; and a secure-context hazard that breaks the board's central interaction without breaking any assertion. That is multi-file coordination with a security-sensitive posture change — 7 by the plan schema's own criteria.
> **Replaced with:** **Complexity:** 7 → Send to Lead Coder.

## User Review Required

None. Five decisions made and recorded:

1. **Two subcommands, not a flag.** `switchboard local` serves loopback; `switchboard tailnet` serves the tailnet (plus loopback — see the two-listener note). The mode is the command the operator types, so it is visible in shell history, in `ps`, in a systemd unit and in documentation — none of which is true of a flag buried after `start`.

   **`start` becomes an error.** There are two commands to serve a board and `start` is neither. Keeping it as an alias would leave three ways to say two things, and the ambiguity it creates — *which* mode does `start` mean? — is exactly what this decision exists to end. It is replaced by an error that names both modes:

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

   **This is not free on the standalone host, and it is already true on the extension host.** Guard 5 resolves to loopback-trust in the extension (`getAuthToken` → `''` → `_checkAuth` returns true) and to a hard 401 in standalone (a durable or random session token, always non-empty). Implementing decision 4 therefore means an **explicit, peer-scoped bypass in `_checkAuth`**: when the request arrived on the tailnet listener from a tailnet peer, treat it as trusted exactly as loopback is treated. It must be scoped to that listener and that peer set — a global `return true` would also disable the token for the loopback listener and for `Authorization: Bearer` machine callers, which is a different and much larger change. Absent this, the tablet gets a 401, the operator runs `npx switchboard token show` on the host, and that *is* the enrolment step the Goal forbids.
5. **Bare `npx switchboard` keeps working, and means `local`.** It is the first line of the usage block, the form `token show`'s error text instructs, and the form in every published doc. It is also unambiguous in a way `start` is not: nothing about the bare word suggests a remote mode, so it carries none of the "which mode did I get?" doubt that decision 1 exists to end. `start` errors because `start` is the ambiguous word, not because a default is wrong. Every other unrecognised subcommand also exits non-zero.

## Complexity Audit

### Routine

- Reading the `tailscale0` address; threading one bind address into the server.
- Widening the Host and Origin predicates to accept the tailnet address and MagicDNS name.
- Rewriting `docs/REMOTE_ACCESS.md`.

### Complex / Risky

- **Both composition roots.** The extension wires `LocalApiServer` via `TaskViewerProvider:3707`; standalone via `bootstrap.ts:3140`. This is constructor config, not a verb, so a verb-reachability audit proves nothing. Diff the roots by hand.
- **The two roots do not behave the same, so "same option, same behaviour" is false by construction.**

  > **Superseded:** "### The extension composition root — Same option, same detection, same behaviour."
  > **Reason:** The extension has **no command line**, so there is no `tailnet` subcommand to reach it; and guard 5 already resolves to *no credential at all* there, so the identical option produces an unauthenticated board on the tailnet in one host and a token-gated one in the other. "Same behaviour" cannot be satisfied by passing the same option.
  > **Replaced with:** The extension exposes the mode as a **VS Code setting** (`switchboard.remote.tailnet`, default `false`) read at `LocalApiServer` construction in `TaskViewerProvider`, using the same detection helper and the same widened predicates. Behaviour parity is defined as *the board is reachable at the same URL, with no credential, from the same tailnet peers* — which is what decision 4 targets, and which the standalone `_checkAuth` bypass brings standalone up to. `switchboard.openInBrowser` (`extension.ts:1298`) must derive its URL from the bound address for the same reason the CLI must.

- **Interface detection — resolved by research; the CLI is primary and PATH is not usable.** Never parse `ip addr`: macOS names the interface `utun<N>`, not `tailscale0`, so the Linux name ships a feature that never works on the operator's own Mac. `tailscale ip -4` returns a single IPv4 string identically on all three platforms — but it is **not on PATH on macOS**, where the binary lives inside the app bundle. Resolve it by an ordered absolute-path probe, then fall back to the LocalAPI socket:

  | Platform | CLI binary | LocalAPI fallback |
  |---|---|---|
  | Linux | `/usr/bin/tailscale` (verified on this host → `100.110.206.86`) | unix socket `/var/run/tailscale/tailscaled.sock` |
  | macOS (standalone) | `/Applications/Tailscale.app/Contents/MacOS/Tailscale` — **not on PATH** | unix socket `/var/run/tailscaled.socket` |
  | macOS (App Store) | same bundle path | `~/Library/Group Containers/63T6S2R9A9.com.tailscale.ipn.macos/tailscaled.sock` (sandbox container) |
  | Windows | `C:\Program Files\Tailscale\tailscale.exe` (installer adds to PATH) | named pipe `\\.\pipe\ProtectedPrefix\Administrators\Tailscale\tailscaled` |

  LocalAPI is `GET /localapi/v0/status`, address at `Self.TailscaleIPs[0]`. **It is internal and explicitly unstable** — `tailscale.com/client/local` documents it as subject to change without notice — so it is the fallback, not the primary, and a failure there must produce the decision-3 exit rather than a guess. The macOS PATH gap is not only an extension-host problem: a GUI-launched VS Code inherits no login-shell PATH, and a plain `spawn('tailscale')` fails there *and* in a macOS terminal that has no alias set up.
- **MagicDNS names in the Host header — all three forms confirmed reachable.** MagicDNS installs a DNS **search domain** (`taile9aab9.ts.net`) on Linux (`resolv.conf`), macOS (`scutil`) and iOS (Network Extension), so a bare label genuinely resolves and the browser genuinely sends `Host: patrickremotedev`. A browser may therefore send the FQDN `patrickremotedev.taile9aab9.ts.net`, the bare `patrickremotedev`, or the raw `100.x` address. All three must pass guard 3, or the board connects and 403s. (Android is the restrictive case: Chrome often treats a single label as a search query unless a trailing dot is typed — that costs the operator a keystroke, it does not remove the requirement, since the label still arrives as `Host` when it does resolve.)
- **Secure context.** A tailnet address served over plain `http://` is **not** a secure context (only `localhost`/`127.0.0.1`/`::1` are exempt). See the Edge-Case audit — this is the one failure mode that passes every assertion in this plan while leaving the product unusable.

## Edge-Case & Dependency Audit

### Race Conditions

- **Tailscale not yet up at boot** — `listen` throws `EADDRNOTAVAIL`. Report it naming the address and the likely cause, not a stack trace.
- **The address changes** across re-auth or a node rename. Re-detect at start; do not persist it. There is no re-bind on change — a rename mid-session drops remote clients, and the answer is a restart, not a watcher.
- **Two listeners, one `start()` promise.** `start()` currently resolves inside a single `listen` callback and attaches `WsHub` and the upgrade router there (`:741`-`:770`). With a second listener the resolve must wait for **both** to be listening, and the upgrade router must be attached to **both** servers — attaching to only the first is the "board loads, never updates" hang. The 5s `START_TIMEOUT_MS` race and the `'error'` handler must cover both, or a failed tailnet bind leaves a half-started server that never rejects.

### Security

- **Guard 5 must be widened by peer, not globally.** See decision 4. A global bypass would strip the token from the loopback listener too.
- **The extension host has no token at all.** Turning the setting on there publishes an unauthenticated board *and* the full API — PTY spawn, git, filesystem writes — to every node on the tailnet. That is the posture decision 4 asks for, and it is the correct one *given tailnet membership is the control*; it must be stated plainly in `docs/REMOTE_ACCESS.md` rather than left for an operator to discover. ACLs are the narrowing tool, and the doc must say so next to the setting.
- **Funnel is out of scope** and must be named as out of scope in the doc, because it is the one Tailscale feature that would make all of the above internet-facing.

### Side Effects

- **`navigator.clipboard` is `undefined` in a non-secure context, and the board's central interaction is Copy Prompt.** Confirmed for both target browsers: on iPadOS/iPad Safari and Android Chrome the property is **absent**, not present-and-rejecting (Chrome since 66, Safari since 13.1). Over `http://100.110.206.86:7777` the board renders and the WebSocket streams, so every automated and manual check in this plan passes — while the primary action does nothing. The four guarded call sites fail **silently, with no console error** (`transport.js:372`, `shell.js:448`, `connections.js:518`, `kanban.html:8206`); the seven unguarded sites throw `TypeError: undefined is not an object` (`project.js:764`, `:1393`, `:1643`, `:1747`, `:2423`, `:2675`, `:3800`). This is the plan's goal-vs-appearance gap and it is why verification step 10 exists. The in-scope fix is an insecure-context fallback — a hidden `<textarea>` + `document.execCommand('copy')`, which **still works in an insecure context on both platforms today**; it is deprecated in the W3C spec and on MDN but neither Chromium nor WebKit has a removal date, precisely because the web relies on it as this fallback. **Clarification**, not new scope: a board that loads and cannot copy a prompt does not satisfy "open the URL; the board loads" in any sense the Goal means it.
- **The printed board URL** must use the tailnet address or MagicDNS name, never `127.0.0.1`. `resolveDisplayHostname` currently probes `switchboard.localhost` and falls back to `127.0.0.1`; under `tailnet` it must be bypassed entirely, not extended.
- **WebSocket upgrade** enforces its own Host/Origin checks (`wsUpgradeAuth.ts` — `isAllowedHost`, `isLocalhostOrigin`, then the same token). Widen in step, or the board loads and never updates — the failure that reads as a hang. Note the upgrade path has **no peer-address check** of its own; it inherits none from `_handleRequest`. Do not "fix" that by adding one without making it mode-aware, or the tailnet WS dies while HTTP works.
- **`loopback-hostname-contract` forbids a second copy of the predicate**, over both `LocalApiServer.ts` and `wsUpgradeAuth.ts`. The widened predicate therefore belongs in `utils/loopbackHostname.ts` alongside the loopback one — a new exported `isAllowedHostFor(bindAddress, host)` — not inlined at either call site. Expect that test to be the first thing that goes red if it is done wrong.
- **IPv6.** The interface also carries `fd7a:115c:a1e0::/128`. Bind v4 first; accept the v6 Host if a client uses it.
- **Loopback is not replaced — it is added to. This is the required design, not a fallback.**
  `server.listen(port, address)` binds exactly one address, so tailnet mode means **two listeners sharing one request handler**, not a bind moved. `0.0.0.0` would serve both but also the LAN, which is the thing being refused.

  This is load-bearing: every in-tree client talks to loopback. `sb_api_call.sh` (behind every ClickUp, Linear, get-tickets and kanban skill) resolves `.switchboard/api-server-port.txt` and curls `http://localhost:$PORT`; the seven `kanban_operations/*.js` scripts each reimplement the same lookup; and **39 references to that port file across 11 source files** appear in generated agent prompts telling seats to POST `queue/next`, `queue/done` and `task/complete`. If tailnet mode moved the bind instead of adding one, every local agent client breaks the moment the operator goes remote — completions stop being posted, queues stall, and nothing reports an error. `findRunningInstance`, `waitForHealth`, `probeHealth` and `token show`'s `POST /auth/mint` all address `127.0.0.1` explicitly and are correct unchanged *because* the loopback listener is retained.

### Dependencies & Conflicts

- **Retires the tunnel half** of `switchboard-as-a-local-app-and-a-self-hosted-remote.md`; keeps its launcher idea. Resolve before either is coded.
- **Absorbs the docs half** of `a-phone-on-the-tailnet-has-nothing-to-connect-to.md` (the `docs/REMOTE_ACCESS.md` rewrite); its terminator mechanism is retired for the same reason.

  **The cost of retiring it is now measured, and it is higher than the plan assumed.** Research confirms `tailscale serve` rewrites `Host` to the loopback backend value (`127.0.0.1:PORT`) and passes the tailnet FQDN in `X-Forwarded-Host`; it forwards WebSocket upgrades correctly; and it works tailnet-only, with **Funnel not required**. That means the peer reaching `LocalApiServer` is loopback and the `Host` is already a loopback name — so `tailscale serve` passes **all five guards with zero code changes**, and its TLS `*.ts.net` certificate makes the board a secure context, which makes the clipboard work with no fallback at all.

  It is still rejected, on the stated non-goal: it puts a daemon-managed proxy in the path of every request and makes the remote story something the operator installs, configures and keeps running rather than a word they type. That is a deliberate trade of *less code* for *fewer moving parts owned by someone else*. It is recorded here in full so it is re-decided on the facts if it is ever re-opened, rather than rediscovered as a surprise.
- **Independent of `browser-board-csrf-cross-site-rejection.md`, but read this before assuming so.**

  A hostile page can already reach `127.0.0.1:<port>` today. The body parser never inspects `Content-Type` (`:1396` calls `JSON.parse` on whatever arrived), so a `text/plain` POST is a CORS *simple request* — no preflight — and `_checkAuth` returns true whenever the expected token is empty, which is always on the extension host. The CORS policy only withholds the *response*; the side effect has already happened. `Host: 127.0.0.1:<port>` passes guard 3 by construction.

  So the exposure is **created by the missing origin check, not by this plan**, and it exists on every install right now whether or not anyone ever goes remote. This plan does not widen it: a tailnet peer is a node the operator authenticated, and the hostile-page path is identical before and after.

  What it *does* mean is that the CSRF fix is urgent on its own merits. The reachable impact is narrower than "arbitrary shell": `/terminals/relay` validates both endpoints against the live pty fleet and delivers into an **agent's** prompt, so the realistic outcome is prompt injection into a running agent — which matters here because seats run with `--dangerously-skip-permissions` and `--permission-mode bypass`. Land the origin check; do not treat it as this plan's prerequisite, and do not let this plan be used as an argument that it can wait.

## Dependencies

- `sess_pending — switchboard-as-a-local-app-and-a-self-hosted-remote` (retire the tunnel half; keep the launcher)
- `sess_pending — a-phone-on-the-tailnet-has-nothing-to-connect-to` (absorb the docs half; retire the terminator)

## Adversarial Synthesis

Key risks. (1) The plan's own guard table listed three of five — a coder who follows it lands a bind widening and gets `Access denied: localhost only` from the peer check, then a 401 from `_checkAuth`, and has no map for either. (2) A non-secure-context board: every assertion here passes while Copy Prompt silently does nothing on the tablet — the goal-vs-appearance gap, mitigated by the insecure-context clipboard fallback and manual step 10. (3) `switchboard tailnet` *already* serves a loopback board today via the CLI's unknown-subcommand fallthrough, so a half-landed change announces success — mitigated by making the whitelist and its non-zero exit the first thing that lands. Mitigations elsewhere: absolute-path/local-API interface detection tested on macOS; the widened predicate lives in `utils/loopbackHostname.ts` so the contract test still holds; the `_checkAuth` bypass is peer-and-listener scoped; both composition roots hand-diffed.

## Proposed Changes

### `src/utils/loopbackHostname.ts`

- **Context:** the single source of truth for the host predicate; a contract test forbids a second copy in `LocalApiServer.ts` or `wsUpgradeAuth.ts`.
- **Logic:** add `isAllowedHostFor(bind: BindPolicy, host: string | undefined): boolean` where `BindPolicy` is `{ loopbackOnly: true }` or `{ tailnetAddress: string; magicDnsNames: string[] }`. Loopback names always pass; the tailnet address (v4 and v6 forms), the MagicDNS FQDN and its bare first label pass only under the tailnet policy.
- **Edge cases:** bare-label matching must be exact, not `startsWith` — `patrickremotedev.evil.example` must fail. Reuse `hostnameFromHostHeader` for port stripping so the bracketed-IPv6 handling is not re-implemented.

### `src/services/LocalApiServer.ts`

- **Context:** `start()` at `:725`; guards at `:7340`-`:7375`; `_checkAuth` at `:881`.
- **Implementation:**
  - Accept `bindPolicy` in options (default loopback-only). Keep the `127.0.0.1` listener unconditionally; when a tailnet address is present, open a **second** `http.Server` on it sharing the same `_handleRequest`, and attach the `upgrade` router and `WsHub` to both. Resolve `start()` only when both are listening; reject if either errors; the 5s timeout covers the pair.
  - Guard 2: accept a peer whose `remoteAddress` is the bound tailnet address' peer set — i.e. accept any peer **arriving on the tailnet listener**, identified by the socket's `localAddress`, rather than by an allowlist of remote addresses (a tailnet peer's address is any `100.64.0.0/10` node and is not knowable in advance).
  - Guards 3 and 4: delegate to `isAllowedHostFor` / the Origin equivalent.
  - Guard 5: in `_checkAuth`, return true when the request arrived on the tailnet listener. Scoped there and nowhere else.
- **Edge cases:** `_handleServeBoard`'s one-time-token exchange sets `sb_session` with `SameSite=Strict` — harmless but pointless on the tailnet path; it must not be made a precondition.

### `src/services/wsUpgradeAuth.ts`

- Thread the same `BindPolicy` through `isAllowedHost` / `isLocalhostOrigin` / `authorizeWsUpgrade`, and skip the token check for a tailnet-listener upgrade, in step with guard 5. `vscode-webview:` origin handling is unchanged.

### `src/standalone/cli.ts`

- **Context:** `main()` dispatches on `process.argv[2]` for ten subcommands; the serve path is the fallthrough. `usage()` at `:12`. `resolveHostname` at `:110`.
- **Implementation:** introduce an explicit subcommand whitelist. `local` and bare (no subcommand) serve loopback; `tailnet` serves loopback plus the tailnet; `start` prints the decision-1 error and exits non-zero; any other unrecognised subcommand prints usage and exits non-zero. Both serve modes accept every flag the fallthrough accepts today (`--detach`, `--port`, `--workspace`, `--no-open`/`--open`, `--import-bundle`). `resolveHostname` becomes mode-aware: under `tailnet` a MagicDNS or tailnet-address `--hostname` is accepted instead of `process.exit(1)`. `tailnet` detects the address via the ordered absolute-path probe for `tailscale ip -4` in the Complexity Audit table (never a bare `spawn('tailscale')` — it is not on PATH on macOS), falling back to the LocalAPI socket, and exits non-zero naming Tailscale when both are unavailable. There is no code path that accepts an operator-supplied bind address. The usage block lists the two modes first.
- **Edge cases:** the `--detach` re-spawn rebuilds argv from `process.argv.slice(2)`, so the subcommand survives the fork unchanged — verify, do not assume.

### `src/standalone/bootstrap.ts`

- Thread the detected address into `HeadlessSwitchboardOptions` and into the `LocalApiServer` options at `:3140`. The `isLoopbackHostname(displayHost)` throw at `:3211` becomes mode-aware; under `tailnet`, `resolveDisplayHostname` is bypassed and the URL is derived from the bound address. The port/PID files at `:3196`-`:3204` are unchanged (loopback is retained).

### `src/services/TaskViewerProvider.ts` + `package.json`

- New setting `switchboard.remote.tailnet` (boolean, default `false`), contributed in `package.json`, read at `:3707` and threaded into the same option. `extension.ts:1298` (`switchboard.openInBrowser`) derives its URL from the bound address when the setting is on.

### `src/webview/` clipboard fallback

- Route the unguarded `navigator.clipboard.writeText` sites in `project.js` and the guarded ones elsewhere through one helper that falls back to a hidden `<textarea>` + `document.execCommand('copy')` when `navigator.clipboard` is undefined. Clarification of the Goal, not new scope.

### `docs/REMOTE_ACCESS.md`

- Rewrite: the two commands (`local`, `tailnet`) and the `start` error; Tailscale is the supported remote path; what it exposes (a tailnet, not the internet); that the extension host serves it with **no credential** and ACLs are the narrowing tool; Funnel explicitly out of scope. Delete the unfulfilled proxy-recipe promises for Tailscale and for the reverse proxy — the recipe they promise is the design this plan replaces.

## Files Changed

- `src/utils/loopbackHostname.ts`
- `src/services/LocalApiServer.ts`
- `src/services/wsUpgradeAuth.ts`
- `src/standalone/cli.ts`, `src/standalone/bootstrap.ts`
- `src/services/TaskViewerProvider.ts`, `src/extension.ts`, `package.json`
- `src/webview/project.js`, `src/webview/transport.js`, `src/webview/shell.js`, `src/webview/connections.js`, `src/webview/kanban.html`
- `docs/REMOTE_ACCESS.md`
- `src/test/tailscale-bind-contract.test.js` — new

## Verification Plan

### Automated Tests

1. **`switchboard local` and bare `switchboard` bind `127.0.0.1`** and nothing else.
2. **`switchboard tailnet` binds the detected address** *and* `127.0.0.1` — assert both literals, and assert `0.0.0.0` appears in neither.
3. **No arbitrary address is accepted** — passing an IP is refused. Guards the non-goal.
4. **`switchboard tailnet` with Tailscale down exits non-zero**, naming Tailscale; asserts it does **not** silently serve loopback only.
4b. **`switchboard start` exits non-zero and names both modes**, and **an unrecognised subcommand exits non-zero**. Assert neither serves a board — a `start` (or a typo) that quietly starts something is the failure this replaces.
5. **Host allowlist accepts** the tailnet IP, the MagicDNS FQDN and the bare hostname; still accepts loopback; **rejects `<bare-label>.evil.example`**.
6. **WS upgrade accepts the same Host set** as HTTP, and the upgrade router is attached to **both** listeners.
7. **No credential is required on the tailnet listener** — a request with no `Authorization` and no `sb_session` returns the board, not a 401 — **and the loopback listener still enforces the token** in standalone. Both halves, or the test passes on a global bypass.
8. **Address detection never calls a bare `tailscale`** — assert the resolver probes absolute paths (Linux, both macOS bundle forms, Windows) and the LocalAPI socket, and that a `spawn`/`exec` of the unqualified name appears nowhere on the path. This is the macOS-only failure Linux CI cannot reproduce.
9. **`loopback-hostname-contract` still passes** — no second copy of the predicate in `LocalApiServer.ts` or `wsUpgradeAuth.ts`.

### Goal Invariants

- `src/services/LocalApiServer.ts` contains no unconditional `'127.0.0.1'` argument to `listen(` — the literal is reachable only through the bind policy. Paired positive: a loopback listener is still opened in both modes (test 1 and test 2 assert the literal is present in the bound set).
- `isAllowedHostFor` is exported from `src/utils/loopbackHostname.ts`, and the count of files defining a host-allowlist predicate is exactly 1.
- The peer-address comparison `remoteAddress !== '127.0.0.1'` no longer appears as an unconditional early return in `_handleRequest`; paired positive: a non-tailnet, non-loopback peer still receives 403 (asserted by a socket test against the loopback listener).
- `cli.ts` defines a subcommand whitelist containing `local` and `tailnet`, and `start` maps to a non-zero exit. Paired positive: bare invocation resolves to the loopback serve path.
- Zero occurrences of `navigator.clipboard.writeText(` in `src/webview/` that are not reached through the fallback helper.
- `docs/REMOTE_ACCESS.md` contains no "a verified snippet will replace this notice" promise; paired positive: it documents `switchboard tailnet` and names Funnel as out of scope.

### Manual

9. **From a tablet on the tailnet**, type the MagicDNS URL: the board loads and updates live with **nothing else typed**. If anything asks for a token or a code, the plan has failed.
10. **On that same tablet, press Copy Prompt on a card and paste it.** The prompt must arrive. This is the step that separates "the board loaded" from "the board works" — an insecure-context clipboard failure passes every automated assertion above.
11. **From a laptop on the same LAN but not the tailnet**, confirm the board is unreachable.
12. **On macOS**, confirm `tailnet` detects the address from a GUI-launched VS Code (setting path) and from a terminal (CLI path). `tailscale` is not on PATH on macOS at all, so a bare `spawn('tailscale')` fails in **both** — a failure invisible on Linux, where it works everywhere. Assert the bundle path is probed and, with the app absent, that the LocalAPI socket is tried before the decision-3 exit fires.

## Recommendation

**Send to Lead Coder** (complexity 7).

## Implementation Summary

**Status:** Complete. All five guards addressed, both hosts (standalone + extension) wired, contract tests passing.

### Files changed

**New files:**
- `src/utils/tailnetDetect.ts` — Tailscale interface address detection (ordered CLI path probe + LocalAPI socket fallback, never a bare `spawn('tailscale')`).
- `src/webview/clipboardFallback.js` — `window.sbCopyToClipboard()` with insecure-context fallback (`<textarea>` + `execCommand('copy')`).
- `src/test/tailscale-bind-contract.test.js` — 12 source-level contract assertions (two listeners, no 0.0.0.0, localAddress identification, scoped token skip, CLI subcommand whitelist, clipboard fallback, CSP widening, extension parity).

**Modified files:**
- `src/utils/loopbackHostname.ts` — `BindPolicy` type, `isAllowedHostFor`, `isAllowedOriginFor`, `isTailnetPolicy` type guard, `LOOPBACK_ONLY_POLICY`.
- `src/services/LocalApiServer.ts` — `bindPolicy` option, two listeners (loopback always retained + tailnet), guards 2/3/4/5 updated, `_isTailnetSocket` (localAddress identification), `_widenCspForRequest`, `stop()` closes both, public `isTailnetSocket`/`bindPolicy` for gateway.
- `src/services/wsUpgradeAuth.ts` — `bindPolicy` + `isTailnetUpgrade` options; delegates to `isAllowedHostFor`/`isAllowedOriginFor`; token skip scoped to tailnet listener.
- `src/services/wsHub.ts` — threads `bindPolicy` + `isTailnetUpgrade` to `authorizeWsUpgrade`.
- `src/standalone/terminalWsGateway.ts` — `bindPolicy` + `isTailnetUpgrade` via constructor + `setBindPolicy` setter.
- `src/standalone/cli.ts` — `local`/`tailnet` subcommand whitelist, `start` retired with redirect, unknown subcommand rejection, tailnet detection, `bindPolicy` passed to bootstrap.
- `src/standalone/bootstrap.ts` — `bindPolicy` option on `HeadlessSwitchboardOptions`, mode-aware hostname validator, `bindPolicy` threaded to `LocalApiServer`, gateway wired via `setBindPolicy`.
- `src/services/TaskViewerProvider.ts` — `_resolveBindPolicy` reads `switchboard.remote.tailnet`, detects tailnet address, threads `bindPolicy` into `LocalApiServer` options; clipboard fallback injected.
- `src/services/headlessPanelHtml.ts` — `clipboardFallback.js` injected into transport shim.
- `package.json` — `switchboard.remote.tailnet` setting (boolean, default false).
- `docs/REMOTE_ACCESS.md` — rewritten for tailnet mode.
- `src/test/loopback-hostname-contract.test.js` — updated delegation assertions for `isAllowedHostFor`/`isAllowedOriginFor`.
- All webview files (`kanban.html`, `project.js`, `planning.js`, `shell.js`, `connections.js`, `tickets.js`, `mission-control.js`, `inspect.js`, `setup.html`, `terminals.js`, `transport.js`) — `navigator.clipboard.writeText` → `window.sbCopyToClipboard`.

### Decisions implemented

1. **Bind policy, not a flag.** `BindPolicy` union (`loopbackOnly` | `tailnetAddress + magicDnsNames`) is the single source of truth for which addresses the server binds and which Host/Origin names it accepts.
2. **Two listeners, not a moved bind.** The loopback listener is always retained; tailnet mode adds a second listener on the specific tailnet address. `server.listen(port, address)` binds exactly one address.
3. **Tailnet identification by `localAddress`.** A request arrived on the tailnet listener when `socket.localAddress` matches the bound tailnet address — not by an allowlist of remote peer addresses (a tailnet peer's address is any `100.64.0.0/10` node).
4. **Token skip scoped to the tailnet listener.** `_checkAuth` and `authorizeWsUpgrade` return true for tailnet-listener requests BEFORE reading the token. The loopback listener still enforces it. A global skip would also disable the token for `Authorization: Bearer` machine callers.
5. **`switchboard tailnet` exits non-zero when Tailscale is absent.** Never silently falls back to loopback-only, never binds `0.0.0.0`. The extension degrades gracefully (falls back to loopback-only) because the editor webview must keep working.
6. **CSP widened at serve time.** `_widenCspForRequest` injects `ws://<host>` from the request's Host header into `connect-src`, so a board loaded over a tailnet address streams over that address.
7. **Clipboard fallback for insecure contexts.** `http://100.110.206.86:port/` is not a secure context, so `navigator.clipboard` is undefined. `sbCopyToClipboard` falls back to `execCommand('copy')`.

### Contract tests

- `loopback-hostname-contract.test.js` — 24 assertions, all pass.
- `tailscale-bind-contract.test.js` — 12 assertions, all pass.

## Review Findings

Reviewed the working-tree diff (25 files, ~976 insertions) against this plan's Goal and Goal Invariants; the design — two listeners rather than a moved bind, tailnet identification by `socket.localAddress`, a token skip scoped to that one listener — is implemented correctly and the goal is achieved. Fixed three defects: the tailnet listener bound a *different* ephemeral port because `this._tailnetServer.listen(this._port, …)` ran synchronously before the loopback callback assigned `this._port` (silent, and certain on the extension host, which passes no port; reproduced empirically); a failed tailnet bind rejected `start()` while leaving the loopback listener holding the port, so the watchdog's retry would hit `EADDRINUSE`; and `resolveMagicDnsNames` called `resolve` instead of `finish`, leaving a 4 s timer armed after the probe answered. Also closed two gate holes: `tailscale-bind-contract.test.js` existed but was wired into neither `package.json` nor CI, and `extension.ts` — named in this plan's Files Changed — was never touched, so the tailnet URL was undiscoverable from the extension host; both are now done, plus two new regression assertions pinning the port sequencing and the teardown (verified to fail when the fix is reverted). Validation: `npm run compile-tests` shows the same five pre-existing `bootstrap.ts` errors as HEAD and no new ones; `tailscale-bind` 14/14, `loopback-hostname`, `connections-routing` 14/14, `ws-surface-scoping` 13/13, `terminal-token-transport`, `panel-runtime-surface`, `shim-injection` 17/17 and `browser-panel-verb-routing` 15/15 all pass.

## Deferred Findings

- MAJOR — `npm run compile-tests` is RED at HEAD, independent of this plan: `src/standalone/bootstrap.ts:572` uses `LocalApiServer` and `:2189` uses `DEFAULT_KANBAN_COLUMNS` with no import for either (5 errors). CI runs this as a step, so the whole pipeline is red on main. Not fixed here — unrelated to this plan, and `DEFAULT_KANBAN_COLUMNS` is a value import in load-order-sensitive code. `src/standalone/bootstrap.ts:572`
- MAJOR — the Goal Invariant "`LocalApiServer.ts` contains no unconditional `'127.0.0.1'` argument to `listen(`" is contradicted by this plan's own body ("Keep the `127.0.0.1` listener unconditionally") and by `loopback-hostname-contract.test.js`, which asserts the literal must remain. The implementation follows the body; the invariant as written is unsatisfiable and should be reworded, not coded to. `src/services/LocalApiServer.ts:846`
- NIT — `_widenCspForRequest` injects the request's `Host` into `connect-src` verbatim. Guard 3 validates Host only when `serveStatic` is set, so on a host serving panels without it the value is unvalidated. Reachable only by a peer that already passed guard 2. `src/services/LocalApiServer.ts:1010`
- NIT — `_widenCspForRequest` uses `csp.replace('connect-src ', …)`; a panel CSP with no `connect-src` directive is silently left unwidened and its board would load but never stream over the tailnet address. No such panel exists today. `src/services/LocalApiServer.ts:1016`
- NIT — the `--detach` re-spawn guards with `childArgv.includes('tailnet')`, which matches the token anywhere in argv, so `--workspace /srv/tailnet` would suppress the subcommand re-injection. `src/standalone/cli.ts:1372`
- NIT — `candidateCliPaths()` omits the Homebrew CLI path (`/opt/homebrew/bin/tailscale`) and the App Store bundle's alternate location, so a macOS host with only the CLI installed falls through to the LocalAPI socket. Not a failure — the socket probe covers it — but one extra probe path would avoid the slower fallback. `src/utils/tailnetDetect.ts:33`
- NIT — `loopback-hostname-contract.test.js`'s new 0.0.0.0 assertion is `!src.includes("listen(this._port") || !/listen\([^)]*0\.0\.0\.0/.test(src)`; the first disjunct is always false, so the guard reduces to the regex. Harmless but the disjunction is dead. `src/test/loopback-hostname-contract.test.js:188`
