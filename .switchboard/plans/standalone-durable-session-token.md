# Standalone auth is destroyed on every restart — adopt the already-shipped `switchboard.apiToken` as a durable session token

## Goal

Make a `npx switchboard` browser session survive a server restart, and let a second device (phone, tablet, another laptop) reach the same board. Today both are impossible: the session secret is generated per launch and never persisted, and the launch token that exchanges for it is single-use.

The change is small because the storage already exists and already ships. `switchboard secrets set apiToken <value>` writes `switchboard.apiToken` into the encrypted standalone store *today* — the alias is in the shipped CLI (`src/standalone/cli.ts:47`) — and the extension host already reads that exact key (`src/services/TaskViewerProvider.ts:3059`, `:3660`). The standalone host is the only host that ignores it.

### Problem Analysis

Three facts in `src/standalone/bootstrap.ts` combine into the failure:

```ts
const oneTimeToken = crypto.randomBytes(32).toString('hex');   // :462
const sessionToken = crypto.randomBytes(32).toString('hex');   // :463
let oneTimeConsumed = false;                                    // :464
```

```ts
getAuthToken: async () => sessionToken,                         // :2302
```

```ts
consumeOneTimeToken: (t: string) => {                           // :2555
    if (oneTimeConsumed || t !== oneTimeToken) return false;
    oneTimeConsumed = true;
    return true;
},
```

`sessionToken` is a local `const` in the bootstrap closure. It is never written to disk, never derived from anything stable, and there is no code path that reads a stored value in its place. `LocalApiServer._checkAuth` (`src/services/LocalApiServer.ts:678`) compares the presented `sb_session` cookie or `Authorization: Bearer` against it in constant time, so when the process restarts every previously issued cookie is cryptographically dead — including the 8-hour cookie the browser is still holding (`LocalApiServer.ts:756`, `:808`, `:862`).

Recovery requires the one-time token, and that is consumed on first exchange. So the observable behaviour is:

- **Restart the server → every open tab 401s.** The user must return to the terminal, find the freshly printed URL, and paste it. There is no command that re-prints it: `cli.ts` prints `boardUrl` once to stdout at launch and keeps no other copy.
- **A second device cannot be admitted at all.** The first browser to hit `/?token=…` sets `oneTimeConsumed = true`. Every subsequent device gets `401 Invalid or expired one-time token` until the server is restarted — at which point the first device is evicted. The board is structurally single-device per launch.

Both are acute for any long-lived deployment (a machine that autostarts Switchboard, a box under the stairs), and they are the reason the CLI currently reads as a foreground dev script rather than a service.

### Root Cause

An ephemeral secret was the right default for a foreground process whose lifetime *is* the session — no secret at rest, nothing to leak, nothing to rotate. It becomes wrong the moment the process outlives the terminal that started it, because the only channel for the replacement secret (stdout of a process nobody is watching) is gone.

The fix is not new storage. It is teaching `getAuthToken` to prefer a *stored* secret and keep the random one purely as the no-secret-configured fallback — which is exactly the shape the extension host already has.

### Non-goals

- No accounts, no login form, no multi-user identity. One shared bearer secret per install, as today.
- No change to the loopback bind or the Host/Origin guards. This plan does not widen network exposure by one byte; it changes only the *lifetime* of the secret.
- No `--bind` flag, no public exposure. Separate concern, separate plan.

## Metadata

**Complexity:** 4
**Tags:** backend, auth, security, reliability, cli
**Feature:** 6fb8574c-be7e-44be-9ad2-2272cf449d3c

## User Review Required

No user review required. The approach reuses existing shipped infrastructure (`switchboard.apiToken` secret store, `createStandaloneHostSecrets`) and changes only the lifetime of the secret, not the auth model. The security-critical edge case (blank-token fail-closed) is identified and covered by the verification plan.

## Complexity Audit

### Routine
- Reading `switchboard.apiToken` from the standalone secret store via `createStandaloneHostSecrets` — the store and the `apiToken` alias already ship.
- Adding `switchboard token show|set|rotate|clear` subcommands to `cli.ts` — follows the existing `secrets` block's shape and `resolveSecretKey` discipline.
- Correcting the stale comment at `LocalApiServer.ts:712-715`.
- Pinning a default port (7777) in `parseArgs` with ephemeral fallback.

### Complex / Risky
- **Blank-token fail-closed.** `_checkAuth` treats an empty `expected` as loopback-trust / allow everything (`LocalApiServer.ts:681`). A stored-but-blank `switchboard.apiToken` must fall through to the random token, never to the empty string. Trim before testing; treat trimmed-empty as unset. This is the security-critical case in the plan.
- **TerminalWsGateway auth bypass.** `bootstrap.ts:2291` constructs `new TerminalWsGateway(ptyFleetService, async () => sessionToken)` — a *separate* closure that bypasses `getAuthToken` entirely. If `getAuthToken` is changed to prefer the stored secret but the WS gateway keeps using the raw `sessionToken`, HTTP and WS auth disagree: the board renders but terminals hang. Both paths must resolve the same token.
- **One-time token TTL window.** Making the launch token reusable in durable mode requires a bounded TTL (e.g. 15 minutes from boot) rather than unbounded reuse. The `oneTimeConsumed` flag must become a timestamp-based expiry check in durable mode while keeping strict single-use in ephemeral mode.
- **Pre-existing token adoption.** An install may already hold a `switchboard.apiToken` set for the extension host. After this change, that value silently becomes the live session secret. The behaviour change is intended but must be logged unambiguously at boot.

## Edge-Case & Dependency Audit

**Race Conditions:**
- The token is resolved once at boot (not per request), so there is no race between the secret-store read and request handling. The resolved value is a string assigned to a closure variable, read synchronously thereafter.
- `token rotate` against a running instance: the running server holds the old resolved token in memory; rotation writes the store but the running server does not re-read it. The plan's verification step 6 confirms existing cookies 401 after rotate — but this only works if the running server is restarted after rotation, or if `token rotate` also signals the running server to re-resolve. The plan should clarify: `token rotate` writes the store; the next launch picks it up. A running instance is not hot-rotated. This matches `token show` which reads the running instance's current token, not the store.

**Security:**
- Blank-token fail-closed is the critical security path. A whitespace-only value in the encrypted store must not silently disable auth on a host serving a browser board. Verification step 5 covers this.
- The enrolment window (15-minute TTL) limits replay of a launch URL leaked via shell history or process list. The window is stated in the startup banner so the operator knows the constraint.
- `token show` resolves the port through `findRunningInstance` and refuses to print a URL for a dead server — preventing stale-port URL leakage.

**Side Effects:**
- Pre-existing `switchboard.apiToken` values silently become the live session secret. This is intended but is a behaviour change on existing state.
- `token clear` returns the install to ephemeral-per-launch behaviour — the reverse direction must leave the install working, not locked out.

**Dependencies & Conflicts:**
- This plan should land before the daemon-lifecycle plan. `switchboard status` prints a board URL that 401s after any restart without a durable token, and an autostarted server is precisely the case where nobody is watching stdout for the replacement token.
- No conflict with the remote-access plan — that plan touches `TicketsPanelProvider` and docs, neither of which this plan opens.
- The default port change (7777) interacts with the daemon-lifecycle autostart units, which pin `--port <fixed>` explicitly. If the default becomes 7777, the units can either pin 7777 or rely on the default — both are correct.

## Dependencies

- `sess_a189596a` — `npx switchboard` has no lifecycle (daemon-lifecycle plan): depends on THIS plan landing first for the pair to feel finished. `switchboard status` and autostart units are of limited use while the session secret is regenerated per launch.

## Adversarial Synthesis

Key risks: (1) the TerminalWsGateway bypass at `bootstrap.ts:2291` — if only `getAuthToken` is changed, HTTP and WS auth disagree and terminals hang while the board renders; (2) blank-token fail-closed — a whitespace-only stored value must not silently disable auth; (3) pre-existing token adoption — a value set months ago for the extension silently becomes the board's session secret. Mitigations: change both the `getAuthToken` closure and the TerminalWsGateway constructor to use the same resolved token; trim-and-test the stored value before adopting it; log unambiguously at boot when a pre-existing token is adopted.

## Proposed Changes

**1. `getAuthToken` prefers the stored secret (`src/standalone/bootstrap.ts:2302`).**

Read `switchboard.apiToken` from the standalone secret store; fall back to the per-launch `sessionToken` when unset or blank. Resolve it **once at boot**, not per request — `_checkAuth` runs on every request and WS upgrade, and a decrypt per request is both slow and a new failure surface. Log which mode is active at startup (`durable token` vs `ephemeral session`) so the operator can tell without guessing.

Guard the empty case carefully: `_checkAuth` treats an empty `expected` as *"loopback trust, allow everything"* (`LocalApiServer.ts:681`). A stored-but-blank secret must therefore fall through to the random token, never to the empty string — a whitespace-only value in the store would otherwise silently disable auth on a host that serves a browser board. Trim before testing, and treat trimmed-empty as unset.

**2. Fix the TerminalWsGateway auth bypass (`src/standalone/bootstrap.ts:2291`).**

The TerminalWsGateway is constructed with `async () => sessionToken` — a separate closure that bypasses `getAuthToken` entirely. This must be changed to use the same resolved token value as `getAuthToken`. If the durable token is resolved once at boot into a variable (e.g. `resolvedToken`), both the `getAuthToken` closure and the TerminalWsGateway constructor must reference it:

```ts
const resolvedToken = await resolveDurableToken(secrets, sessionToken);
// ...
const terminalWsGateway = ptyReady
    ? new TerminalWsGateway(ptyFleetService, async () => resolvedToken)
    : undefined;
// ...
getAuthToken: async () => resolvedToken,
```

Without this change, the board renders (HTTP auth passes) but terminals hang (WS auth fails against the old `sessionToken`). Verification step 9 exists to catch exactly this, but the code change must be explicit, not implied.

**3. Make the one-time token reusable while the durable secret is configured (`bootstrap.ts:2555`).**

`oneTimeConsumed` exists to stop a token leaking from shell history or a process list being replayed. That rationale holds for the ephemeral mode and should stay. In durable mode the exchange is no longer a one-shot bootstrap — it is how each additional device enrols — so single-use makes multi-device impossible by construction.

Recommended split: keep strict single-use when running on the random `sessionToken`; when a durable token is configured, allow the launch URL to be exchanged repeatedly within a bounded window (a short TTL, e.g. 15 minutes from boot) rather than unbounded. That admits the phone and the laptop from the same printed URL without leaving a permanently valid enrolment link in the terminal scrollback. State the window in the startup banner.

**4. Add `switchboard token` (`src/standalone/cli.ts`).**

Three subcommands, following the existing `secrets` block's shape and its `resolveSecretKey` hard-error discipline:

- `token show` — print the current board URL for a running instance, resolving the port through the existing `findRunningInstance` path so it cannot print a URL for a dead server.
- `token set <value>` / `token rotate` — write `switchboard.apiToken` via `createStandaloneHostSecrets` (`src/standalone/hostServices.ts:174`), `rotate` generating 32 random bytes. Both must warn that live sessions are invalidated. **No confirmation prompt** — per `CLAUDE.md`, rotate immediately and say what happened.
- `token clear` — delete the key, returning the install to ephemeral-per-launch behaviour.

`token show` is the command whose absence forces the SSH-and-read-stdout ritual today; it is the highest-value item in this plan.

**5. Pin a default port (`cli.ts` `parseArgs`).**

`--port` defaults to `0` (ephemeral), which means a durable token still yields a URL that moves every restart. Default to a fixed port (7777 is unclaimed by anything Switchboard talks to) and fall back to ephemeral when it is taken, logging the fallback. Keep `--port 0` working as an explicit opt-in.

**6. Correct the stale comment at `LocalApiServer.ts:712-715`.**

It asserts "Switchboard has no API-token setter UI today, so `getAuthToken()` is effectively always empty and auth is localhost-trust." That is already false for the standalone host (`bootstrap.ts:2302` returns a non-empty random token) and will be doubly false after this change. The comment invites a future reader to weaken a check on a false premise.

### Migration

`switchboard secrets set apiToken <value>` has shipped, so an install may **already** hold a `switchboard.apiToken` the standalone host has been ignoring. After change 1 that value silently becomes the live session secret.

This is the intended behaviour, but it is a behaviour change on existing state and must be handled rather than assumed:

- Do **not** overwrite or migrate the existing value — adopt it as-is. Anyone who set it did so intending it to be their API token.
- Log unambiguously at boot when a pre-existing stored token is adopted, so an operator who set the key months ago for the extension is not confused about why the board's auth changed.
- The reverse direction (`token clear`) must leave the install working, not locked out — it falls back to ephemeral, which is exactly today's behaviour.
- No new file formats, so nothing to archive as `*.migrated.bak`. The encrypted store's own corruption handling (`hostServices.ts:185` onward) is untouched.

## Verification Plan

1. **Restart survives.** Launch, open the board via the token URL, confirm it loads. `Ctrl+C`, relaunch on the same port, hard-refresh the still-open tab → board loads with no re-auth. Fails today with a 401.
2. **Second device enrols.** With a durable token set, exchange the launch URL in browser A, then in browser B. Both hold working sessions. Confirm `oneTimeConsumed` no longer blocks B.
3. **TTL closes.** Past the enrolment window, the same URL 401s. Confirm the window is stated in the banner.
4. **Ephemeral mode is unchanged.** With no stored token: second exchange 401s, restart invalidates the cookie. This is the regression fence on today's behaviour.
5. **Blank-token fail-closed.** Store a whitespace-only `switchboard.apiToken`, launch, and confirm the server does **not** fall into empty-token loopback-trust: an unauthenticated request to a guarded route must still 401. This is the security-critical case in the plan.
6. **Rotate invalidates.** `switchboard token rotate` against a running instance, then confirm existing cookies 401 and the new URL works.
7. **`token show` refuses a dead server.** Stop the instance, run `token show`, confirm it reports no running instance rather than printing a stale port from `api-server-port.txt`.
8. **Adoption logging.** Pre-set `switchboard.apiToken`, launch, confirm the banner names durable mode and the adoption.
9. **WS upgrade agrees with HTTP.** Terminals must stream in every passing case above — `authorizeWsUpgrade` runs with `rejectWhenTokenEmpty: true` (`src/standalone/terminalWsGateway.ts:906`) against the same token resolver, so a token change that breaks only the WS path would otherwise show up as a board that renders and terminals that hang. This is the verification for Proposed Change 2 (TerminalWsGateway bypass fix).
10. `npm run compile` clean; existing standalone and `loopback-hostname-contract` tests green.

## Outstanding Questions

- **[user]** Should `token rotate` hot-rotate a running instance (signal it to re-resolve the token from the store), or is restart-after-rotate acceptable? — proceeding on the assumption that restart-after-rotate is acceptable, matching today's `token set` behaviour which writes the store without signalling a running server.
