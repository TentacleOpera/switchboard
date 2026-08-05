# Browser Board URL Must Default to switchboard.localhost, Not 127.0.0.1

## Goal

Make the URL Switchboard hands the user default to `http://switchboard.localhost:<port>` in both entry points (the standalone CLI and the extension's *Open in Browser* command), with a verified fallback to `127.0.0.1` when that name cannot actually be reached.

### Problem Analysis & Root Cause

The board still opens at `http://127.0.0.1:<port>` despite a completed, code-reviewed change that introduced `switchboard.localhost`. The reason is that **the completed work delivered an opt-in flag and the security plumbing to support it — it never changed the default.** Three call sites hardcode `127.0.0.1`, and all three are still on the old value:

| Site | Code | Surface |
| --- | --- | --- |
| `src/standalone/cli.ts:80-81` | `function resolveHostname(input) { if (input === undefined) { return '127.0.0.1'; } … }` | `npx switchboard` |
| `src/standalone/bootstrap.ts:1592` | `const displayHost = opts.hostname ?? '127.0.0.1';` | library/embedded callers |
| `src/extension.ts:1189` | `const url = \`http://127.0.0.1:${port}/?token=${token}\`;` | VS Code `switchboard.openInBrowser` |

The extension path has no hostname parameter at all — it does not consult `resolveHostname`, `isLoopbackHostname`, or anything else. It builds the string inline. So the surface the user actually clicks in VS Code was never in scope of the earlier change.

**Why the code review passed.** The earlier work's deliverable was the *capability*, and it delivered it thoroughly and correctly:

- `src/utils/loopbackHostname.ts` — one shared predicate (`isLoopbackHostname`, `hostnameFromHostHeader`, `isLoopbackHostHeader`, `isLoopbackOrigin`) so the CLI and the server's DNS-rebinding guard cannot drift.
- `src/standalone/cli.ts:66` — `--hostname <name>` parsing, plus fail-fast validation at parse time so a rejected name never burns the one-time token.
- `src/services/headlessPanelHtml.ts` — every panel CSP already lists `ws://*.localhost:*` / `wss://*.localhost:*` in `connect-src`, and the asset-serving panels already list `http://*.localhost:*` in `img-src` (13 occurrences).
- `src/test/loopback-hostname-contract.test.js` — pins substring/prefix-matching holes, CLI/server drift, and the CSP omission.

Every one of those is real and passes. The gap is that "the default the user sees" was never an assertion in that plan, so no reviewer had a criterion to fail it against, and no test covers the value returned when `--hostname` is omitted. The feature is a flag nobody passes, and the extension button — the path the user actually used — was outside its blast radius entirely.

**Root cause:** the change was scoped as "support a nicer hostname" rather than "use a nicer hostname", and the default-value line was left untouched in all three builders.

## Metadata

- **Complexity:** 5
- **Tags:** backend, cli, devops, ux
- **Project:** Browser Switchboard
- **Files touched:** `src/utils/loopbackHostname.ts`, `src/standalone/cli.ts`, `src/standalone/bootstrap.ts`, `src/extension.ts`, `src/test/loopback-hostname-contract.test.js`
- **Risk:** Medium — a wrong default here hands the user a URL their browser cannot open, which reads as "Switchboard is broken". The reachability probe is the mitigation and is mandatory, not optional polish.

## User Review Required

None. The requested default was stated; the probe-and-fall-back behaviour is the only safe way to ship it and needs no product decision.

## Complexity Audit

### Routine
- Change the two default literals (`cli.ts`, `bootstrap.ts`) and build the extension URL from a shared helper.
- Add a test asserting the default is `switchboard.localhost` — the assertion whose absence let the earlier change pass.

### Complex / Risky
- **`*.localhost` resolution is not universal at the OS layer.** RFC 6761 §6.3 reserves the TLD, and Chromium/Firefox map every name under it to loopback internally, but the Windows DNS resolver does not, and non-browser clients (`curl`, scripts, some webviews) go through the OS. Shipping the name unconditionally risks a URL that resolves nowhere.
- **The server binds IPv4-only.** `this._server.listen(this._port || 0, '127.0.0.1', …)` (`LocalApiServer.ts:394`). Many resolvers return `::1` first for `localhost` and `*.localhost`. Browsers retry the other family; a plain `http.get` may not. So the probe must exercise the real path and the fallback must be automatic.
- **Session cookie is host-scoped.** `sb_session` is set with `Path=/; HttpOnly; SameSite=Strict` and **no `Domain`** (`LocalApiServer.ts:608`, `:660`), making it host-only. In standalone, a session established on `switchboard.localhost` does not carry to `127.0.0.1`. Mixing hostnames mid-session logs the user out, so exactly one hostname must be chosen per launch and used for the token exchange, the redirect, and every subsequent navigation.
- **One-time token consumption.** `consumeOneTimeToken` returns true exactly once (`LocalApiServer.ts:310-313`). A probe that hits `/?token=…` would burn it. The probe must target `/health`, which is unauthenticated.

## Edge-Case & Dependency Audit

1. **`switchboard.localhost` does not resolve** (Windows OS resolver, default macOS `mDNSResponder`, restricted DNS, hosts-file overrides). Probe fails → fall back to `127.0.0.1`, log one line naming the reason. Never emit a URL that failed its own probe. Confirmed by research: Chromium 63+ and Firefox 84+ resolve `*.localhost` internally (bypassing the OS resolver, DoH included), so the probe succeeds for ~90% of browser users; Safari delegates to the OS resolver and fails on stock macOS — Safari users land on the fallback path automatically.
1a. **Enterprise proxy / PAC interception.** A corporate proxy without a loopback bypass rule may forward `switchboard.localhost` requests upstream. The probe exercises exactly this path (an HTTP GET through the system stack), so a proxied-and-broken name fails the probe and falls back. No special handling needed — but this is why the probe must be an HTTP request, not a DNS lookup.
1b. **Secure Context bonus.** `http://*.localhost:<port>` is a W3C Potentially Trustworthy origin, same as `127.0.0.1` — no API parity loss (ServiceWorker, `crypto.subtle` etc. remain available over plain HTTP).
2. **Resolves to `::1` only.** Probe against the hostname exercises connect, so an IPv4-only bind that refuses `::1` fails the probe and falls back. Do **not** widen the bind to dual-stack as part of this change.
   > **Superseded:** "…that enlarges the listening surface for a cosmetic gain."
   > **Reason:** Factually wrong framing — `::1` is also loopback, so a dual-stack bind does not enlarge the listening surface beyond loopback. Research confirms resolvers return `::1` first (RFC 6724 ordering) and quantifies the cost of an IPv4-only bind: a ~200–250ms Happy Eyeballs delay per connection for dual-stack clients (browsers, Node ≥17 `autoSelectFamily`, curl). The real reason to defer is blast radius: changing `LocalApiServer.listen` touches the shipped server on ~4,000 installs (PRD contract #2, byte-compatible in-place changes), and Happy Eyeballs makes the delay self-healing — clients fall back to IPv4 automatically. Not worth coupling to a URL-default change.
   > **Replaced with:** Keep the IPv4-only bind in this plan; record dual-stack binding (`127.0.0.1` + `::1`, or `::` with `IPV6_V6ONLY=0`) as a candidate follow-up plan if the ~250ms first-connection delay ever shows up in profiles.
2a. **Cookies ignore ports.** RFC 6265 scoping has no port dimension: a host-only `sb_session` set by `http://switchboard.localhost:8000` is sent to `http://switchboard.localhost:9000`. Two concurrent standalone instances on different ports share the cookie jar for that host — the second login overwrites the first. Pre-existing behaviour (identical on `127.0.0.1`), not introduced by this change; note it, do not fix it here. Cookie namespacing per port is a separate concern if multi-instance standalone ever becomes a supported workflow.
3. **Explicit `--hostname 127.0.0.1`.** Must still be honoured verbatim, with no probe and no substitution. An explicit user choice outranks the default.
4. **Explicit `--hostname <other>.localhost`.** Validated by `isLoopbackHostname` as today. Probe it and warn if unreachable, but **do not override an explicit value** — the user may be pointing at a hosts-file entry they manage. Warn and proceed.
5. **Server Host guard already accepts it.** `isLoopbackHostHeader` passes `switchboard.localhost:<port>` (`loopbackHostname.ts:60-65`, exercised by the contract test), so no guard change is needed. Confirm, do not modify.
6. **CSP already accepts it.** All panel CSPs list the `*.localhost` WS and (where relevant) HTTP origins. Confirm by grep; do not re-widen.
7. **Absolute asset URLs stay on `127.0.0.1`.** `DesignPanelProvider.ts:240`, `PlanningPanelProvider.ts:2367`, `TicketsPanelProvider.ts:447` all emit `http://127.0.0.1:<port>/design/asset?…`. With the page origin now `switchboard.localhost`, these are cross-origin — but `img-src` already allows `http://127.0.0.1:*`, and `_handleDesignAsset` is not auth-gated (it relies on a realpath allow-list, `LocalApiServer.ts:884-900`), so images still load. **Verify this explicitly in UAT** — it is the least obvious way this change could break a panel.
8. **`probeHealth` currently hardcodes `127.0.0.1`** (`cli.ts:95`). Reuse for the new probe requires a hostname parameter; keep the existing 127.0.0.1 call sites (`findRunningInstance`, `waitForHealth`) pointed at the bind address — those check *the server*, not *the name*.
9. **`.switchboard/api-server-port.txt`** stores only a port; unaffected. Skills that build `http://127.0.0.1:<port>` from it keep working — the bind address is unchanged.
10. **Existing bookmarks.** A user who bookmarked `http://127.0.0.1:<port>/#board` still reaches the board; both names hit the same socket and both pass the Host guard. In standalone they will need a fresh token/cookie for the new host, which the launch flow provides.
11. **Shipped-state check.** No persisted state encodes the display hostname, so there is nothing to migrate.

## Dependencies

None — no external session dependencies. The prior loopback-hostname capability work (predicates, Host guard, CSP, contract test) is already merged and is referenced inline as the foundation this plan builds on.

## Adversarial Synthesis

Key risks: the reachability probe adds up to ~500ms of launch latency on machines where `switchboard.localhost` can never resolve — research confirms this is the Safari/stock-macOS/Windows-OS-resolver population for non-browser clients, while Chromium/Firefox users (~90% of browsers) resolve internally and never pay it; the CLI's fallback-hint messaging at `cli.ts:213-233` must consume the bootstrap-resolved host or it will report a stale pre-probe name; and an IPv4-only bind costs dual-stack clients a ~250ms Happy Eyeballs delay (self-healing; dual-stack binding deliberately deferred). Mitigations: probe the real `GET /health` path over HTTP (never DNS, never the one-time token) with a 500ms budget, fall back to `127.0.0.1` automatically with one log line, honour explicit `--hostname` verbatim, and add the missing default-value assertions so this gap cannot pass review twice.

## Resolved Assumptions

Resolved by web research (localhost subdomain resolution across platforms/browsers, Aug 2026):

- **Chromium 63+ and Firefox 84+ resolve `*.localhost` internally** to loopback, bypassing the OS resolver, hosts file, and DoH — the probe succeeds for ~90% of desktop browser users on every OS.
- **Safari does NOT special-case `*.localhost`** — WebKit delegates to `CFNetwork`/`mDNSResponder`, which does not synthesize wildcard `.localhost` records on stock macOS. Safari users hit the fallback path; the probe is what makes that invisible.
- **Windows 10/11 and stock macOS resolvers return NXDOMAIN** for `*.localhost`; Linux with `systemd-resolved` synthesizes it. Non-browser clients (Node, curl, Python, Go) follow the OS resolver — skills and scripts keep using `127.0.0.1` (edge case 9), which is unaffected.
- **RFC 6761 §6.3 is advisory ("SHOULD"), not binding** on OS resolvers — the platform split is permanent for the planning horizon, so probe-and-fallback is a durable requirement, not a transitional shim.
- **Happy Eyeballs (RFC 8305) self-heals the IPv4-only bind**: `::1`-first ordering costs dual-stack clients ~200–250ms, then they fall back automatically (browsers, Node ≥17, curl). Dual-stack binding recorded as a possible follow-up, deliberately out of scope (see edge case 2).
- **Additional findings folded in:** probe timeout tightened 1500ms → 500ms (see Superseded callout under Proposed Changes); enterprise-proxy interception covered by HTTP-level probe (edge case 1a); Secure Context parity confirmed (edge case 1b); cookie port non-isolation noted as pre-existing (edge case 2a).

## Proposed Changes

### `src/utils/loopbackHostname.ts`

Add the default and a reachability probe next to the existing predicates, so all three entry points share one answer:

```ts
/**
 * The hostname Switchboard hands the user when nothing else is specified.
 *
 * Not a bind address — the server binds 127.0.0.1 unconditionally. This is the
 * NAME in the printed/opened URL. `.localhost` is reserved by RFC 6761 §6.3 and
 * is unspoofable, which is why the Host guard accepts it.
 */
export const DEFAULT_DISPLAY_HOSTNAME = 'switchboard.localhost';

/**
 * Can a client actually reach the server under `hostname`?
 *
 * A DNS lookup is not enough: the Windows resolver does not implement the
 * `.localhost` TLD (browsers do it internally, the OS does not), and a resolver
 * that answers `::1` first would hand back an address an IPv4-only listener
 * refuses. So probe the real thing — GET /health over that name.
 *
 * /health is unauthenticated and idempotent; the one-time launch token must NOT
 * be used here (consumeOneTimeToken succeeds exactly once).
 */
```

> **Superseded:** `timeoutMs = 1500` as the probe default.
> **Reason:** Research flagged the launch-latency cost: on stock macOS/Windows the failure mode is a fast `NXDOMAIN`, but a hosts entry pointing at an unroutable address stalls for the full timeout on every launch. 1500ms is a permanent tax on exactly the users the fallback exists for; 300–500ms is the recommended budget for a loopback probe (the server is local — a healthy probe returns in single-digit ms).
> **Replaced with:** `timeoutMs = 500`.

```ts
export async function isHostnameReachable(
    hostname: string,
    port: number,
    timeoutMs = 500
): Promise<boolean> { /* http.get(`http://${hostname}:${port}/health`) → status 200 */ }

/**
 * Resolve the display hostname for a launch.
 *
 * - explicit input: honoured verbatim (already validated by the caller); probe
 *   only to warn, never to override — the user may manage a hosts entry.
 * - no input: prefer DEFAULT_DISPLAY_HOSTNAME, but fall back to 127.0.0.1 when
 *   the probe fails. A default that hands out an unreachable URL is worse than a
 *   plain one.
 */
export async function resolveDisplayHostname(
    explicit: string | undefined,
    port: number,
    warn: (msg: string) => void
): Promise<string>
```

### `src/standalone/cli.ts`

- Keep `resolveHostname` as the *validator* for an explicit `--hostname` (its `process.exit(1)` on a non-loopback name stays).
- Change the no-input branch from `return '127.0.0.1'` to returning `undefined`, and let `resolveDisplayHostname` pick after the port is known (the probe needs a live server).
- Update the `--help` text (`cli.ts:24-26`):

```
  --hostname <name>    Hostname for the board URL (default: switchboard.localhost,
                       falling back to 127.0.0.1 if that name is unreachable).
                       Must be a loopback name: localhost, 127.0.0.1, or anything
                       under the reserved .localhost TLD.
```

- Generalise `probeHealth(port)` to `probeHealth(port, hostname = '127.0.0.1')`, leaving `findRunningInstance` and `waitForHealth` on the bind address.
- **Clarification — downstream messaging at `cli.ts:213-233`.** Today `const hostname = resolveHostname(args.hostname)` (line 213) feeds the fallback hint at line 228 (`if (hostname !== '127.0.0.1') { … "If your browser cannot resolve … use http://127.0.0.1:… instead." }`). Once the no-input branch returns `undefined` and the real decision moves into `resolveDisplayHostname` (which needs a live port), this call site must key the hint off the **resolved display host** returned from bootstrap, not the pre-port parse value — so the hint prints exactly when the final URL's host is not `127.0.0.1`, and never references a stale pre-probe name. One owner for the answer: bootstrap resolves, the CLI only reports.

### `src/standalone/bootstrap.ts`

Replace the default at line 1592 and resolve after `server.start()`:

```ts
// The bind address is 127.0.0.1 unconditionally; `hostname` only changes the
// name the user is handed. Validated here as well as in the CLI so a library
// caller cannot mint a URL the server's Host guard would then reject.
const displayHost = await resolveDisplayHostname(opts.hostname, port, m => log(opts, m));
if (!isLoopbackHostname(displayHost)) {
    throw new Error(`hostname must resolve to loopback (localhost, *.localhost or 127.0.0.1); got '${displayHost}'`);
}
const bindUrl = `http://127.0.0.1:${port}`;
const url = `http://${displayHost}:${port}`;
```

### `src/extension.ts`

`switchboard.openInBrowser` (lines 1178-1191) must stop building the URL inline:

```ts
const token = activeTaskViewerProvider.mintBrowserToken();
// Same helper the standalone CLI uses, so the extension button and `npx
// switchboard` can never hand out different hostnames — and so a name the
// server's Host guard would 403 can never be opened.
const host = await resolveDisplayHostname(undefined, port, m => outputChannel?.appendLine(m));
const url = `http://${host}:${port}/?token=${token}`;
await vscode.env.openExternal(vscode.Uri.parse(url));
```

### `src/test/loopback-hostname-contract.test.js`

Add the assertions whose absence let the earlier change pass review:

```js
check('the DEFAULT display hostname is switchboard.localhost, not 127.0.0.1', () => {
    assert.strictEqual(DEFAULT_DISPLAY_HOSTNAME, 'switchboard.localhost');
    assert.ok(isLoopbackHostname(DEFAULT_DISPLAY_HOSTNAME));
});

check('no launch surface hardcodes the 127.0.0.1 display URL', () => {
    // Regression guard for the exact gap: the flag existed, the guard existed,
    // the CSP existed — and every builder still emitted 127.0.0.1.
    for (const f of ['src/standalone/cli.ts', 'src/standalone/bootstrap.ts', 'src/extension.ts']) {
        const src = fs.readFileSync(path.join(process.cwd(), f), 'utf8');
        assert.ok(!/\?\?\s*'127\.0\.0\.1'/.test(src), `${f} must not default the display host to 127.0.0.1`);
    }
    const extSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'extension.ts'), 'utf8');
    assert.ok(!/http:\/\/127\.0\.0\.1:\$\{port\}\/\?token=/.test(extSrc),
        'openInBrowser must build its URL from resolveDisplayHostname');
});
```

## Verification Plan

1. **Build & tests:** *Deferred per dispatch directive — no project compilation step and no automated test runs in this verification plan.* The contract-test assertions added under Proposed Changes are validated by the coder's normal gates and CI (the return-contract ratchet and the integration workflow), not by this plan's verification.
2. **Static check:** `grep -rn "127.0.0.1:\${port}" src/extension.ts` returns nothing; `grep -n "'127.0.0.1'" src/standalone/bootstrap.ts src/standalone/cli.ts` shows only bind-address and probe uses.
3. **UAT — CLI default.** `npx switchboard` in a workspace: the printed URL and the opened browser tab both read `http://switchboard.localhost:<port>`. The board renders, the WebSocket connects (cards update live), and no CSP error appears in the browser console.
4. **UAT — extension button.** In VS Code run *Switchboard: Open in Browser*: the tab opens on `switchboard.localhost`, the board loads, and panel switching works.
5. **UAT — assets under the new origin.** With the board on `switchboard.localhost`, open the Tickets panel on a ticket with a local screenshot, and the Design panel on an image. Both images must render (they are absolute `http://127.0.0.1:<port>/design/asset?…` URLs and this is the least obvious break). Check the console for `img-src` violations.
6. **UAT — terminals WebSocket.** Open the Terminals panel over `switchboard.localhost` and type into a terminal; input and output both flow (confirms `ws://*.localhost:*` in `connect-src` is reached, not just present).
7. **UAT — standalone session.** In standalone, confirm the token exchange sets `sb_session` for `switchboard.localhost` and that reloading the page stays authorised (no 401s in the network log).
8. **UAT — explicit override.** `npx switchboard --hostname 127.0.0.1` prints and opens `127.0.0.1` with no probe-driven substitution. `npx switchboard --hostname evil.example` still exits 1 with the existing message.
9. **UAT — fallback path.** Simulate an unreachable name (add a hosts entry pointing `switchboard.localhost` at an unroutable address, or test on Windows where the OS resolver does not implement the TLD): the launch logs one fallback line and opens `127.0.0.1`. The board must work.
9a. **UAT — Safari fallback (macOS).** Launch `npx switchboard`, then open the printed URL in Safari specifically. Research confirms Safari does not special-case `*.localhost`: on stock macOS the probe fails, the printed URL is already the `127.0.0.1` fallback, and the board works in Safari. If the probe ever regresses, this is the browser that catches it.
10. **UAT — port-file consumers.** Run a skill that reads `.switchboard/api-server-port.txt` and calls `http://127.0.0.1:<port>/…` (e.g. `get-tickets`): still succeeds, confirming the bind address is untouched.

## Review Findings

One MAJOR and two MINORs, all fixed. MAJOR: `isHostnameReachable` could never settle — `req.setTimeout` arms on socket *inactivity* only once a socket is assigned, so a name lookup that neither resolves nor NXDOMAINs left the promise pending, and `http.get` throws synchronously on a malformed hostname; both `openInBrowser` and the standalone launch `await` it, so the failure mode was a command that opens no browser and reports no error. Fixed with a wall-clock timer, a synchronous-throw guard, and a single-settle latch in `src/utils/loopbackHostname.ts`. MINORs: `DEFAULT_DISPLAY_HOSTNAME` was imported into `cli.ts` but unused while the `--help` text hardcoded the same string (now interpolated, so they cannot drift), and `resolveDisplayHostname` was imported into the contract test but never exercised — the probe, which the plan calls mandatory, had zero coverage; four behavioural assertions added (explicit-and-reachable returns verbatim without warning, unreachable default falls back to `127.0.0.1` with exactly one log line, explicit name survives a failed probe, probe is time-bounded). Verified clean: `/health` is unauthenticated (it precedes every `_checkAuth`), the Host guard accepts `switchboard.localhost:<port>`, the one-time token is untouched, the bind stays `127.0.0.1`, the asset-serving panel CSPs already allow `http://127.0.0.1:*` in `img-src` (edge case 7 holds), and the CLI's fallback hint keys off the resolved `new URL(instance.url).hostname` rather than the pre-probe parse. Files changed: `src/utils/loopbackHostname.ts`, `src/standalone/cli.ts`, `src/test/loopback-hostname-contract.test.js`; `test:contract:loopback-hostname` passes 23/23 and is wired in CI at `integration-tests.yml:106`. Remaining risk: whether `switchboard.localhost` actually resolves is per-machine, so the probe's *positive* branch is only exercised by UAT (steps 3–9a).
