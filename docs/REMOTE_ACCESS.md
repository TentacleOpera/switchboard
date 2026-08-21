# Remote Access

Switchboard's browser board (`npx switchboard`) is **loopback-only by design**. This
document explains why, names the guards that enforce it, and describes the supported
ways to reach the board from another machine — and the things that will never work.

## Why the board is loopback-only

The board is not a static site. Every action it serves is one of:

- **Spawning a PTY** — the terminal tabs are real shells running on the host.
- **Writing the workspace** — plan files, ticket documents, design assets.
- **Driving git** — branch creation, worktrees, merges, commits.

Reaching the board is therefore equivalent to getting a shell on that machine. A
public-facing board with no auth gate is a remote code execution endpoint. The
loopback constraint is not an oversight — it is the load-bearing security decision,
and four independent guards enforce it:

1. **Bind address** (`src/standalone/bootstrap.ts`) — the server binds `127.0.0.1`
   unconditionally. The `--hostname` flag changes only the *name* in the printed URL,
   never the socket address.
2. **Peer check** (`src/services/LocalApiServer.ts`, `_handleRequest`) — any socket
   peer whose `remoteAddress` is not `127.0.0.1` or `::1` gets a 403 before any route
   runs.
3. **Host-header guard** (`src/services/LocalApiServer.ts`, `_isAllowedHost`) — via
   `isLoopbackHostHeader` from
   [`src/utils/loopbackHostname.ts`](../src/utils/loopbackHostname.ts). Accepts only
   `localhost`, `127.0.0.1`, `::1`, and the RFC 6761-reserved `*.localhost`. This is
   the DNS-rebinding guard: a hostile page that resolves a name to your loopback
   address still sends a `Host` header the guard rejects.
4. **CLI hostname validation** (`src/standalone/cli.ts`, `resolveHostname`) — rejects
   a non-loopback `--hostname` at parse time, so the printed URL can never be one the
   server would then 403 on (which would burn the one-time launch token on a request
   that can never succeed).

The same predicate is applied to WebSocket upgrades
(`src/services/wsUpgradeAuth.ts`), CORS mirrors loopback origins only, and the
session cookie is `SameSite=Strict`. The single source of truth for "does this name
always resolve to this machine?" is
[`src/utils/loopbackHostname.ts`](../src/utils/loopbackHostname.ts), which carries an
explicit DNS-rebinding threat model. A contract test
(`loopback-hostname-contract`) forbids a second copy of the predicate.

## Supported access methods

All of the following work *because the connection terminates on loopback on the
host*. None of them open the socket; they tunnel or proxy to a port that is already
loopback-bound.

### SSH tunnel (recommended default)

This is the simplest and most secure remote access method. Forward a local port on
your client machine to the server's loopback port on the host:

```sh
ssh -L 7777:127.0.0.1:<server-port> you@host
```

Then open `http://127.0.0.1:7777/?token=…` in your browser.

**Why it passes every guard:**

- The connection originates on `127.0.0.1` on the host, so guard 2 (peer check)
  passes.
- The browser sends `Host: 127.0.0.1:7777`; the Host-header guard strips the port and
  checks `isLoopbackHostname('127.0.0.1')` — true, so guard 3 passes. **The port in
  the Host header is never compared to the real listening port**, which is what makes
  a port-shifted tunnel work.
- Terminals stream because the WebSocket URL is derived from `location.host` at
  runtime, so it follows whatever port the browser is actually using.

**The tunnel's local port need not match the server's port.** `-L 7777:127.0.0.1:41234`
forwards your port `7777` to the server's port `41234`. The browser talks to `7777`;
the server sees a loopback peer on `41234`. Both guards pass.

### Tailscale

Tailscale gives you a private network without a public DNS name, but a tailnet name
(e.g. `mybox.tail1234.ts.net`) is **not** in the accepted Host set —
`isLoopbackHostname` accepts only `127.0.0.1`, `localhost`, `::1`, and `*.localhost`.
A direct connection to `http://mybox.tail…:port/` sends `Host: mybox.tail…:port`,
which the Host-header guard rejects with 403.

This path therefore needs a **local proxy on the host** that rewrites the `Host`
header to a loopback name (e.g. `switchboard.localhost`) before forwarding to the
server's loopback port. The proxy itself listens on the Tailscale interface, and the
server stays bound to `127.0.0.1`.

> **Verify before relying on this.** The exact working configuration — which proxy,
> how the `Host` rewrite is expressed, and whether WebSocket upgrades survive — must
> be tested against a real tailnet before this section ships a copy-paste recipe. An
> untested recipe in a security document is worse than no document. The requirement
> is stated here so an operator knows what to build; a verified snippet will replace
> this notice once it has been run end-to-end.

### Reverse proxy (Caddy / nginx)

A reverse proxy on the host can terminate the remote connection and forward to the
loopback server. Two things must be correct or the board silently degrades:

1. **`Host` rewrite.** The proxy must set `Host` to a loopback name the guard accepts
   (e.g. `switchboard.localhost`), not pass through the original `Host` from the
   client. Without this, every request 403s.
2. **WebSocket upgrade headers.** The proxy must pass through the `Upgrade` and
   `Connection` headers. If it drops them, the board HTML loads but **terminals
   silently fail to stream** — that is the symptom you will otherwise be debugging.

> **Verify before relying on a specific snippet.** As with Tailscale, a copy-paste
> config block will be added here once it has been run end-to-end against a real
> proxy and confirmed to carry the board, terminals, and panel images. The
> requirements above are the contract any working config must satisfy.

## What is NOT supported, and why

**S3, CDNs, and serverless hosts cannot run this at all.** `getBoardHtml`
(`src/services/headlessPanelHtml.ts`) generates the page per request with a fresh CSP
nonce and injects the workspace root and host capabilities as `<body>` attributes.
There is no static bundle to upload. Beyond that, every action the board serves is a
PTY spawn or a filesystem/git write — there is nothing to deploy to a host that
cannot run a process and write to disk. Saying so once retires a question that will
otherwise keep being asked.

## Public internet

Today's auth is **one shared secret** with no accounts, no revocation, and no rate
limiting. Anything internet-facing needs an **identity-aware proxy** in front
(OAuth, mTLS, etc.) before the board is exposed. No copy-paste config is provided
here — a working snippet would be read as an endorsement of a posture the current
auth model does not support.

## Agentic access through the same tunnel

The HTTP API (`/kanban/...`, `/health`, `/terminals/...`, etc.) is served on the
**same port** as the board HTML and passes the same guards through the same tunnel.
An agentic client (Antigravity, Cursor, Zed, Claude Code, etc.) reaching
`http://127.0.0.1:<tunnel-port>/kanban/...` through an SSH tunnel hits the same
loopback origin and passes the same peer and Host checks.

The credential difference is the auth model:

- A **browser** uses the `sb_session` cookie, obtained via the one-time `?token=`
  exchange at launch.
- An **agent** uses `Authorization: Bearer <token>` — which `_checkAuth`
  (`src/services/LocalApiServer.ts`) already accepts. Set a durable
  `switchboard.apiToken` (`npx switchboard token rotate`) so the credential survives
  restarts; without one the server mints a fresh secret per launch and the agent's
  token dies on every relaunch.

See the `switchboard-orchestration` skill for the full endpoint contract.

### External team leads

A remote external team lead can run the whole loop over HTTP — no filesystem access
to the host required. The file-inbox path (reading
`.switchboard/teams/<teamId>/reports/`, running `git -C <worktree> diff`, `mv`-ing to
`claimed/`) stays the primary route for a lead that shares a filesystem with the
host; these are the equivalents for one that does not:

| Filesystem | HTTP equivalent |
|---|---|
| `ls .switchboard/teams/<teamId>/reports/*.md` | `GET /teams/<teamId>/reports` |
| `mv <report>.md reports/claimed/` | `POST /teams/<teamId>/reports/claim` — body `{"filename": "..."}` |
| `git -C <worktree> rev-list --count <base>..HEAD` / `git diff` | `GET /worktree/<worktreeId>/diff` (add `?stat=true` for a summary) |

`<worktreeId>` is the numeric `id` from `GET /worktree/list`. The diff endpoint
derives its refs from the recorded `base_branch`, not from the caller, and returns
`{ commitCount, log, diff }`.
