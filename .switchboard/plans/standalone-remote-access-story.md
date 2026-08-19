# The loopback lockdown is undocumented, and the asset route bakes the server port into absolute URLs

## Goal

Give Switchboard a stated remote-access posture: document that the board is loopback-only *by design*, document the supported ways out (SSH tunnel, Tailscale, reverse proxy), and fix the one place in the codebase that breaks under all of them. Right now the rigour is real but invisible, which makes a deliberate security decision read as an oversight.

### Problem Analysis

**The lockdown is thorough and completely undocumented.** A grep across `docs/*.md` and `README.md` for `lan|home server|self-host|systemd|reverse.?prox|tailscale|cloudflare` returns nothing. Meanwhile the code enforces loopback in four independent places:

1. `src/standalone/bootstrap.ts:2502` — the bind address is `127.0.0.1` unconditionally; `--hostname` changes only the *name* in the printed URL.
2. `src/services/LocalApiServer.ts:4317` — any socket peer that is not `127.0.0.1`/`::1` gets 403.
3. `LocalApiServer.ts:4326` — a Host-header guard via `isLoopbackHostHeader`, accepting only `localhost`, `127.0.0.1`, `::1` and the RFC 6761-reserved `*.localhost`.
4. `src/standalone/cli.ts` `resolveHostname` — rejects a non-loopback `--hostname` at parse time, with a comment explaining that printing an unreachable URL would burn the one-time token on a request that can never succeed.

Plus `src/services/wsUpgradeAuth.ts` applies the same predicate to WS upgrades, CORS mirrors loopback origins only, and the session cookie is `SameSite=Strict`. `src/utils/loopbackHostname.ts` is a single-source-of-truth module carrying an explicit DNS-rebinding threat model, and a `loopback-hostname-contract` test forbids a second copy of the predicate.

This is a considered security posture. Undocumented, it reads as "nobody thought about the network", which is the opposite of the truth and the exact impression the project can least afford.

**And access already works today, unofficially.** An SSH tunnel passes every guard, with no code change:

```
ssh -L 7777:127.0.0.1:7777 you@host
# open http://127.0.0.1:7777/?token=…
```

Server-side the connection originates on loopback, so guard 2 passes. The browser sends `Host: 127.0.0.1:7777`; `hostnameFromHostHeader` strips the port and `isLoopbackHostname('127.0.0.1')` is true, so guard 3 passes — **the port in the header is never compared to the real listening port**, which is what makes a port-shifted tunnel work. Terminals stream because `src/webview/terminals.js:200` derives the WS URL from `location.host`, and the iframe messaging in `shell.js` uses `location.origin` throughout. A reverse proxy works on the same basis provided it rewrites Host to a loopback name (`proxy_set_header Host switchboard.localhost`).

**One thing breaks, and only under a tunnel or proxy.** `TicketsPanelProvider._buildLocalAssetUrl` (`src/services/TicketsPanelProvider.ts:529-555`) returns:

```ts
return `http://127.0.0.1:${port}/design/asset?root=…&path=…${version}`;
```

The port comes from `this._apiServer?.getPort?.()` — the server's *real* listening port. Every other URL the board emits is origin-relative; this one is absolute and pinned. Consequences:

- Under a port-shifted tunnel (`-L 7777:127.0.0.1:41234`) the browser requests port `41234` on its *own* machine. Every ticket and design image 404s or hangs.
- Under a reverse proxy on 80/443 the same applies, and on an HTTPS proxy the `http://` scheme is additionally mixed content, which the browser blocks outright.
- Even on a plain local launch it is fragile: the CSP built in `headlessPanelHtml.ts:179` allows `img-src 'self' data:` only, so an absolute `http://127.0.0.1:<port>/…` is same-origin *only* while the page is served from that exact host and port — it is a 403-free path today by coincidence of the default launch, not by construction.

### Root Cause

Two independent causes with one shared shape — a loopback assumption baked in where an origin-relative one would do:

- The docs never had a remote-access section because the extension host never needed one; the standalone browser board inherited that silence.
- `_buildLocalAssetUrl` was written for the VS Code webview path, where `asWebviewUri` is the alternative and an absolute loopback URL is genuinely required. Serving the same provider to a real browser made the absolute form wrong, and nothing caught it because the default launch masks the bug perfectly.

### Non-goals

- **No `--bind` flag and no public exposure.** Guards 1-4 stay exactly as they are. This plan documents how to reach a loopback-bound server through a channel that *terminates* on loopback; it does not open the socket.
- No new auth. Where a documented path implies internet exposure, the doc says what is required first and does not pretend the current one-shared-secret model is sufficient for it.

## Metadata

**Complexity:** 3
**Tags:** docs, bugfix, security, infrastructure, devops

## Proposed Changes

**1. Make the asset URL origin-relative (`TicketsPanelProvider.ts:555`).**

Return `/design/asset?root=…&path=…&v=…` — no scheme, no host, no port — for the browser-board path. The route is served by the same origin the page came from, so a relative URL is correct under a direct launch, a tunnel, a proxy and HTTPS alike.

The VS Code webview path must keep working: `_rewriteLocalImagePaths` (`:572`) falls back to `asWebviewUri` when `_buildLocalAssetUrl` returns undefined, and under the extension host the page's origin is `vscode-webview://…`, where a root-relative path resolves to nothing useful. So the absolute form must be retained for the webview host and the relative form used for the browser board — decided by which host is serving, not by a fresh guess at the port. Preserve the `&v=<mtime>` cache-buster exactly; the comment at `:546-552` records that its removal makes live image updates invisible to three separate equality checks.

Also revisit the `img-src 'self' data:` CSP in `headlessPanelHtml.ts:179` once the URL is relative — `'self'` then covers it by construction rather than by coincidence.

**2. `docs/REMOTE_ACCESS.md` — the posture, then the recipes.**

Open with *why* the board is loopback-only: it spawns PTYs, writes the workspace, and drives git on the host, so reaching the board is equivalent to a shell on that machine. Name the four guards and link `utils/loopbackHostname.ts`. This section is the one doing the perception work — a reader must finish it understanding the constraint is deliberate.

Then, in ascending order of exposure:

- **SSH tunnel** — the recommended default. Exact command, why it satisfies the guards, and the note that the tunnel's local port need not match the server's.
- **Tailscale** — private-network access without a public DNS name. Flag honestly that a tailnet name is *not* in the accepted Host set, so this path needs a local proxy performing the Host rewrite; verify the exact working configuration before publishing rather than asserting one.
- **Reverse proxy (Caddy / nginx)** — tested snippets, with `Host` rewritten to `switchboard.localhost` and WebSocket upgrade headers passed through. State plainly that terminals silently fail to stream if the upgrade headers are dropped, since that is the symptom a reader will otherwise be debugging.
- **What is not supported, and why** — S3, CDNs and serverless hosts cannot run this at all: `getBoardHtml` (`headlessPanelHtml.ts:168-186`) generates the page per request with a fresh CSP nonce and injects the workspace root and host capabilities as body attributes, before considering that every action is a PTY spawn or a filesystem/git write. There is no static bundle to upload. Saying so once, with the reason, retires a question that will otherwise keep being asked.
- **Public internet** — state the prerequisite rather than a recipe: today's auth is one shared secret with no accounts, revocation or rate limiting, so anything internet-facing needs an identity-aware proxy in front. No copy-paste config for this one; a working snippet would be read as an endorsement.

**3. README pointer.**

`README.md:31` currently says only "No editor? `npx switchboard` runs the same board in your browser." One sentence and a link, so someone wondering about remote access finds the answer instead of concluding it is impossible.

### Migration

Documentation and one URL-construction change; no state, files, settings or formats change. The behavioural risk is confined to image rendering in the tickets and design panels, on both hosts — that is what verification has to cover.

## Verification Plan

1. **Tunnel, port-shifted.** Launch on an ephemeral port, `ssh -L 7777:127.0.0.1:<real>`, open `http://127.0.0.1:7777/?token=…`. Board loads, terminals stream, **and ticket images render** — the last of which fails today and is the fix's proof.
2. **Extension host unregressed.** Open the tickets and design panels in VS Code and confirm images still render via the webview path. This is the regression the change most plausibly causes.
3. **Cache-buster intact.** Overwrite a ticket image in place and confirm the live `<img>` updates — guards the `&v=<mtime>` behaviour the code comments say three equality checks depend on.
4. **Reverse proxy.** Run the documented Caddy snippet, confirm board, terminals and images over the proxy hostname. Then delete the `Host` rewrite and confirm the documented 403 — verifying the doc's claimed failure mode is the real one.
5. **WS upgrade headers.** Drop them from the proxy config and confirm the symptom matches what the doc warns about.
6. **CSP.** Check the browser console is free of `img-src` violations on both hosts after the change.
7. **Every command in the doc, executed as written.** No snippet ships unrun — an untested recipe in a security document is worse than no document.
8. **Guards unchanged.** Re-run the `loopback-hostname-contract` test and confirm direct non-loopback access is still refused: `curl -H 'Host: evil.example' http://127.0.0.1:<port>/` → 403, and a LAN peer → 403. This plan must be provably exposure-neutral.
