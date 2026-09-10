# Starting the Board Prints One Address, Never a Token, and Opens Nothing

## Goal

Four rules for the board's startup output, stated by the operator and not open to reinterpretation:

1. `switchboard tailnet` — print the tailnet address.
2. `switchboard local` — print the loopback address.
3. `switchboard` — print no address.
4. **A token is never printed. Ever, anywhere.**

And starting the board never opens a browser.

Phase 1 delivers all four. Phase 2 deletes the token machinery behind them, and waits on the CSRF
guard.

### Problem analysis

**A 64-character secret is minted on every launch, printed to the terminal, never expires, and
gates nothing.**

`bootstrap.ts:963` mints it unconditionally — not "when a token is configured", every boot:

```js
const oneTimeToken = crypto.randomBytes(32).toString('hex');
enrolmentTokens.set(oneTimeToken, usingDurableToken ? Date.now() + ENROLMENT_TTL_MS : Number.POSITIVE_INFINITY);
```

With no durable token configured — the default, and the state of this box — the TTL is
`POSITIVE_INFINITY`. It never expires. It is then printed as the headline startup line
(`cli.ts:4565`, `:4569`, `:4574`) and again in the fallback line at `:4592`, so it lands in terminal
scrollback, shell history, tmux buffers, any screenshot of a boot, and any paste of one.

And it authorises nothing. `_checkAuth` (`LocalApiServer.ts:1560`) returns `true` before it inspects
any credential, on both of the only two listeners:

```js
if (this._isTailnetSocket(req)) { return true; }   // tailnet: membership is the control
const expected = await this._options.getAuthToken();
if (!expected) { return true; }                    // no token configured: local trust
```

Verified on the running host — both addresses serve the board, and a write verb, with no credential:

```
GET  /                          on 127.0.0.1:7777      -> 200
GET  /board                     on 127.0.0.1:7777      -> 200
GET  /                          on 100.94.172.32:7777  -> 200
POST /kanban/verb/getStandingOrders on 127.0.0.1:7777  -> 200
```

There is no durable token on this box (nothing in `~/.switchboard/*.json`, no token row in the board
DB), and there is no third listener for one to matter on: `cli.ts:84` confirms the server *"silently
falls back to loopback-only and never binds 0.0.0.0."* So the printed `?token=` is decoration on a
URL that works without it.

**It launches a browser nobody asked for.** `cli.ts:4604`:

```js
if (!args.noOpen) {
    await openBrowser(boardUrl);
}
```

Auto-open is the default; `--no-open` is opt-out. On a box reached only over the network this starts
a browser on the host's own display, which mounts all 14 panel iframes and holds 14 WebSockets
rendering to a screen nobody looks at. Not hypothetical: this host had an orphaned chromium tree
today — **13 processes, 854 MB** — doing exactly that on `seat0`. It stays away now only because the
running process happens to carry `--no-open`, a flag that has to be remembered every launch
(`--detach` implies it; a foreground start does not).

`openBrowser` (`cli.ts:470`) is ~60 lines of platform branching whose own comment concedes the
point: *"the URL is printed in the startup log regardless, so a wrong 'success' is no worse than the
status quo."*

**The printed address does not follow the mode.** `detectTailnetAddress()` runs only when
`serveMode === 'tailnet'` (`cli.ts:4390`), and bare `switchboard` resolves to `local`
(`cli.ts:3282`, *"the historical default"*). So anything that is not `switchboard tailnet` prints a
loopback token URL and never mentions the network, even though `tailscale ip -4` returns the address
in milliseconds.

**Why the token cannot simply be deleted first.** The `?token=` line is inert *here*, but the
mechanism it belongs to is the only thing standing between a hostile web page and the board's 42
POST routes. The cookie it sets is `SameSite=Strict` (`:1706`, `:1758`, `:1812`), so a browser does
not attach it cross-site — with a durable token configured, a cross-site POST 401s. That defence is
real, it is just switched off by default.

The hole is open today and reachable:

```
POST /kanban/verb/refresh   Origin: https://evil.example   Content-Type: text/plain  -> 200
GET  /health                Host: evil.example                                       -> 403
```

`text/plain` is a CORS-simple content type, so there is no preflight to stop it. The `Host` guard
blocks DNS rebinding; nothing rejects a foreign `Origin` — `_isLocalhostOrigin` is called at
`:11830` only to *mirror* the CORS header, never to reject.

`browser-board-csrf-cross-site-rejection.md` closes that properly and deliberately without a
credential. So the token subsystem comes out **after** that guard lands, not before. Printing the
secret, opening the browser, and the wrong address are all independent of it and come out now.

## Metadata

**Complexity:** 2
**Tags:** cli, ux, security, standalone, defaults
**Dependencies:** phase 2 requires `The browser board is served unauthenticated by the extension
host — reject cross-site state-changing requests in both hosts` (CREATED, complexity 4, subtask of
the Tailnet feature). Phase 1 has no dependencies.

## User Review Required

None. The four rules are the operator's own.

## Proposed Changes

### Phase 1 — ships now, no dependency

**1. Stop printing tokens, and stop minting the pointless one.**

- Delete the token-bearing prints at `cli.ts:4569`, `:4574` and `:4592`, and the `token show` /
  `token rotate` pointers at `:4570`, `:4575` and `:4504`.
- Do not mint `oneTimeToken` at all when no durable token is configured (`bootstrap.ts:963`). In
  that state it is an immortal secret protecting nothing; a value that exists only to be printed
  should not exist once it is not printed.
- With a durable token configured the enrolment mint stays (it is load-bearing until phase 2), but
  it is still **not printed**. `switchboard token show` is the way to obtain it — one explicit
  command, by request, which is what rule 4 requires.
- Audit for any other path printing a URL with a credential in it. Startup is the known one; the
  rule is global.

**2. One address per mode, matching the subcommand.**

| Command | Printed |
| :--- | :--- |
| `switchboard tailnet` | the tailnet address, bare |
| `switchboard local` | the loopback address, bare |
| `switchboard` | no address |

No cross-advertising, no "if your browser cannot resolve" hedge, no MagicDNS extras. One line for
the mode that was asked for.

**3. Delete the auto-open.**

- Remove the call at `cli.ts:4604` and `openBrowser` itself at `:470`. **Not** inverted behind a new
  `--open` flag — removed. No flag is wanted for this.
- `--no-open` keeps parsing and does nothing, so existing aliases and the `--detach` argv that
  appends it (`:4447`) do not start failing.
- **Keep** the inline open at `:2646` — that sits behind an explicit `[1] Open in Browser` menu
  choice, which is a user action, not a default.

### Phase 2 — after the CSRF guard lands

**4. Delete the token path from the standalone serve story.**

- No minting (`bootstrap.ts:963`, the `enrolmentTokens` map, `ENROLMENT_TTL_MS`).
- No `token` subcommand (`cli.ts:3389-3478`: `show`, `set`, `rotate`, `clear`).
- No cookie exchange — the three `Set-Cookie: sb_session=` sites at `:1706`, `:1758`, `:1812`.
- `_checkAuth` collapses to the bind-policy question it actually answers, and
  `_sendUnauthorized`'s advice to *"open the board URL from a fresh `npx switchboard` launch"* goes
  with it.
- Confirm first that the CSRF guard covers the WebSocket upgrade path, which does not pass through
  `_handleRequest` — that is step 6 of the guard's own plan and is a precondition here, not an
  afterthought.

## Verification Plan

**Phase 1**

- `grep` the startup output of all three invocations for `token=` — zero matches. This is the
  primary check.
- `switchboard tailnet` prints exactly the tailnet URL; `switchboard local` prints exactly the
  loopback URL; bare `switchboard` prints neither.
- Each printed URL loads the board in a browser with no token and no prior cookie.
- No browser process after any serve invocation (`ps` matches nothing for chromium/firefox), and no
  `xdg-open` / `open` / `cmd.exe` spawned on a serve path. The console menu's explicit choice still
  opens one.
- `--no-open`, `--detach`, and `local --detach` / `tailnet --detach` all still start cleanly.
- With a durable token configured: startup prints no token, and `switchboard token show` still
  returns a working URL.

**Phase 2**

- The CSRF guard's contract test is green first.
- A cross-site `text/plain` POST to a mutating verb is rejected with the token path gone — the
  guard, not a credential, is what refuses it.
- The board, the CLI, the Go client and the agent scripts all still work against a host with no
  token machinery at all.

## Outstanding Questions

- Is `--no-open` worth keeping as an accepted no-op indefinitely, or should it warn once and be
  dropped a release later? Keeping it forever is a small permanent lie about what the CLI does.
