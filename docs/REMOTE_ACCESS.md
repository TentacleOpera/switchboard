# Remote Access

Switchboard's browser board is **loopback-only by default**. This document
explains why, names the guards that enforce it, and describes the supported
ways to reach the board from another machine — and the things that will never
work.

## Why the board is loopback-only by default

The board is not a static site. Every action it serves is one of:

- **Spawning a PTY** — the terminal tabs are real shells running on the host.
- **Writing the workspace** — plan files, ticket documents, design assets.
- **Driving git** — branch creation, worktrees, merges, commits.

Reaching the board is therefore equivalent to getting a shell on that machine.
A public-facing board with no auth gate is a remote code execution endpoint.
The loopback constraint is not an oversight — it is the load-bearing security
decision, and five independent guards enforce it:

1. **Bind address** (`src/standalone/bootstrap.ts`, `LocalApiServer.start`) —
   the loopback listener binds `127.0.0.1` unconditionally. Under tailnet mode a
   second listener binds the Tailscale interface address; neither ever binds
   `0.0.0.0`.
2. **Peer check** (`src/services/LocalApiServer.ts`, `_handleRequest`) — any
   socket peer whose `remoteAddress` is not `127.0.0.1` or `::1` gets a 403
   before any route runs, UNLESS the request arrived on the tailnet listener
   (identified by `socket.localAddress` matching the bound tailnet address).
3. **Host-header guard** (`src/services/LocalApiServer.ts`, `_isAllowedHost`) —
   via `isAllowedHostFor` from
   [`src/utils/loopbackHostname.ts`](../src/utils/loopbackHostname.ts). Accepts
   loopback names (`localhost`, `127.0.0.1`, `::1`, `*.localhost`) always; under
   the tailnet policy also accepts the tailnet address, the MagicDNS FQDN, and
   its bare first label. This is the DNS-rebinding guard: a hostile page that
   resolves a name to your loopback address still sends a `Host` header the
   guard rejects.
4. **Origin guard** (`src/services/LocalApiServer.ts`, `_isLocalhostOrigin`) —
   mirrors the Host guard for the `Origin` header. No CORS wildcard.
5. **Session auth** (`src/services/LocalApiServer.ts`, `_checkAuth`) — a
   one-time token or durable `switchboard.apiToken` is required on the loopback
   listener. Under the tailnet policy, requests arriving on the tailnet listener
   are trusted without a credential (decision 4 below).

The same predicate is applied to WebSocket upgrades
(`src/services/wsUpgradeAuth.ts`), CORS mirrors the allowed origins only, and
the session cookie is `SameSite=Strict`. The single source of truth for "does
this name always resolve to this machine?" is
[`src/utils/loopbackHostname.ts`](../src/utils/loopbackHostname.ts), which
carries an explicit DNS-rebinding threat model. A contract test
(`loopback-hostname-contract`) forbids a second copy of the predicate.

## Supported access methods

### Tailscale (recommended for remote)

Tailscale gives you a private, encrypted network without a public DNS name.
Switchboard has first-class tailnet support: `switchboard tailnet` opens a
second listener on the machine's Tailscale interface address, so any device on
your tailnet can open the board — no token, no enrolment, no proxy.

```sh
npx switchboard tailnet
```

The command detects the machine's Tailscale IPv4 address automatically (you
type a word, never an IP). It prints two URLs:

- `http://127.0.0.1:<port>/?token=…` — loopback, for this machine.
- `http://100.110.206.86:<port>/` — tailnet, for any device on your tailnet.

**Why no token on the tailnet URL?**

Tailnet membership is the control. Tailscale admits a node only after it
authenticates to your coordination server, and ACLs narrow which nodes may
reach a port. Demanding a bearer token on top asks the operator to prove
something the network already proved before the packet arrived. The token skip
is **scoped to the tailnet listener** — the loopback listener still enforces
it, and `Authorization: Bearer` machine callers on loopback still need it.

**What happens if Tailscale is down?**

`switchboard tailnet` exits non-zero with a clear message. It never silently
falls back to loopback-only and never binds `0.0.0.0`. Run `switchboard local`
for loopback-only, or start Tailscale and retry.

**Clipboard on the tailnet URL.**

A board served over `http://100.110.206.86:port/` is not a "secure context" in
browser terms, so `navigator.clipboard` is unavailable. Switchboard installs a
clipboard fallback (`src/webview/clipboardFallback.js`) that uses a hidden
`<textarea>` + `document.execCommand('copy')` — the pre-Clipboard-API path that
works in any context. Every "copy prompt" / "copy plan" button is routed through
it.

**Extension host.**

Set `switchboard.remote.tailnet: true` in VS Code settings. The extension's
LocalApiServer opens the same second listener. If Tailscale is down, the
extension falls back to loopback-only (the editor webview and local agent
clients keep working) — the extension must not refuse to start, unlike the
standalone host which exits non-zero.

**Installing to the Home Screen (iOS / iPadOS / Mobile).**

You can install the browser board to your phone or tablet Home Screen as a
standalone app (own icon, own entry in the app switcher, launching full-screen
with no address bar or Safari toolbar).

- **Install from the MagicDNS URL** (e.g. `http://<machine-name>:7777/` or its
  MagicDNS FQDN), **NOT** from the raw tailnet IP address (`http://100.x.y.z:7777/`).
- **Why**: `start_url` is frozen when the Home Screen icon is created. Installing
  against the MagicDNS name ensures the shortcut remains valid across tailnet IP
  changes and server reboots.
- In Safari, tap Share → **Add to Home Screen**. Full-screen standalone mode is
  powered by `apple-mobile-web-app-capable` and the web app manifest, complete
  with square icon assets and safe-area inset adaptation for device notches and
  home indicators.

### SSH tunnel (loopback-only, no Tailscale)

If you do not use Tailscale, forward a local port on your client machine to the
server's loopback port:

```sh
ssh -L 7777:127.0.0.1:<server-port> you@host
```

Then open `http://127.0.0.1:7777/?token=…` in your browser.

**Why it passes every guard:**

- The connection originates on `127.0.0.1` on the host, so guard 2 (peer check)
  passes.
- The browser sends `Host: 127.0.0.1:7777`; the Host-header guard strips the
  port and checks `isLoopbackHostname('127.0.0.1')` — true, so guard 3 passes.
  **The port in the Host header is never compared to the real listening port**,
  which is what makes a port-shifted tunnel work.
- Terminals stream because the WebSocket URL is derived from `location.host` at
  runtime, so it follows whatever port the browser is actually using.

**The tunnel's local port need not match the server's port.**
`-L 7777:127.0.0.1:41234` forwards your port `7777` to the server's port
`41234`. The browser talks to `7777`; the server sees a loopback peer on
`41234`. Both guards pass.

### Reverse proxy (Caddy / nginx)

A reverse proxy on the host can terminate the remote connection and forward to
the loopback server. Two things must be correct or the board silently degrades:

1. **`Host` rewrite.** The proxy must set `Host` to a loopback name the guard
   accepts (e.g. `switchboard.localhost`), not pass through the original `Host`
   from the client. Without this, every request 403s.
2. **WebSocket upgrade headers.** The proxy must pass through the `Upgrade` and
   `Connection` headers. If it drops them, the board HTML loads but **terminals
   silently fail to stream** — that is the symptom you will otherwise be
   debugging.

> **Verify before relying on a specific snippet.** As with Tailscale, a
> copy-paste config block will be added here once it has been run end-to-end
> against a real proxy and confirmed to carry the board, terminals, and panel
> images. The requirements above are the contract any working config must
> satisfy.

## What is NOT supported, and why

**S3, CDNs, and serverless hosts cannot run this at all.** `getBoardHtml`
(`src/services/headlessPanelHtml.ts`) generates the page per request with a
fresh CSP nonce and injects the workspace root and host capabilities as `<body>`
attributes. There is no static bundle to upload. Beyond that, every action the
board serves is a PTY spawn or a filesystem/git write — there is nothing to
deploy to a host that cannot run a process and write to disk. Saying so once
retires a question that will otherwise keep being asked.

## Public internet

Today's auth is **one shared secret** with no accounts, no revocation, and no
rate limiting. Anything internet-facing needs an **identity-aware proxy** in
front (OAuth, mTLS, etc.) before the board is exposed. No copy-paste config is
provided here — a working snippet would be read as an endorsement of a posture
the current auth model does not support.

## Agentic access through the same tunnel

The HTTP API (`/kanban/...`, `/health`, `/terminals/...`, etc.) is served on the
**same port** as the board HTML and passes the same guards through the same
tunnel. An agentic client (Antigravity, Cursor, Zed, Claude Code, etc.) reaching
`http://127.0.0.1:<tunnel-port>/kanban/...` through an SSH tunnel hits the same
loopback origin and passes the same peer and Host checks.

The credential difference is the auth model:

- A **browser** uses the `sb_session` cookie, obtained via the one-time `?token=`
  exchange at launch.
- An **agent** uses `Authorization: Bearer <token>` — which `_checkAuth`
  (`src/services/LocalApiServer.ts`) accepts when a token is configured. A
  durable `switchboard.apiToken` (`npx switchboard token rotate`) is **opt-in**:
  set one only if you want credential enforcement on loopback (e.g. a second uid
  on the host you need to exclude). Without one, the server does not mint a
  secret — loopback callers (CLI, skill scripts, agents on the host) need no
  credential, because a shell user on the board's machine already has the
  filesystem, `kanban.db`, and the server process. The single-user loopback
  threat model is the load-bearing assumption; file permissions are the control.

On a tailnet listener, agents are trusted without a token — same as browsers.
The tailnet membership is the control.

See the `switchboard-orchestration` skill for the full endpoint contract.

### External team leads

A remote external team lead can run the whole loop over HTTP — no filesystem
access to the host required. The file-inbox path (reading
`.switchboard/teams/<teamId>/reports/`, running `git -C <worktree> diff`,
`mv`-ing to `claimed/`) stays the primary route for a lead that shares a
filesystem with the host; these are the equivalents for one that does not:

| Filesystem | HTTP equivalent |
|---|---|
| `ls .switchboard/teams/<teamId>/reports/*.md` | `GET /teams/<teamId>/reports` |
| `mv <report>.md reports/claimed/` | `POST /teams/<teamId>/reports/claim` — body `{"filename": "..."}` |
| `git -C <worktree> rev-list --count <base>..HEAD` / `git diff` | `GET /worktree/<worktreeId>/diff` (add `?stat=true` for a summary) |

`<worktreeId>` is the numeric `id` from `GET /worktree/list`. The diff endpoint
derives its refs from the recorded `base_branch`, not from the caller, and
returns `{ commitCount, log, diff }`.
