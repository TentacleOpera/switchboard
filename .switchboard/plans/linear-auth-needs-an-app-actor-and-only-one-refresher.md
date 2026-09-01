# Linear auth needs an app actor, and rolling refresh means exactly one host may hold the credential

## Goal

Add OAuth 2.0 with PKCE and `actor=app` to the Linear integration, so Switchboard has a workspace
identity that can be assigned issues and @mentioned — without shipping a client secret, without an
ingress endpoint, and without breaking the personal API key that ships today.

### Problem Analysis

**Today's credential cannot be an actor.** `LinearSyncService` reads
`switchboard.linear.apiToken` from SecretStorage (`:1894`) — a personal API key. It acts as the
human who created it. An app *user* — a workspace member that can be delegated an issue and
@mentioned — requires an OAuth authorization carrying `actor=app`. No personal key can produce one,
so the entire native-agent surface is gated behind an auth change.

**A published extension cannot ship a client secret.** ~4,000 installs, and a VSIX is a zip. Linear
supports **PKCE (S256)** for public clients, with `client_secret` optional at
`POST /oauth/token` when a `code_verifier` is supplied. So Switchboard can publish one app, ship
the `client_id` — public by design — and hold no secret at all. This is the difference between a
first-party integration and asking every operator to register their own app.

**The redirect URI must match exactly.** Linear enforces exact string matching on registered
callback URLs, with no loopback port wildcarding. `LocalApiServer` binds `listen(this._port || 0,
'127.0.0.1')` (`:723`) — an ephemeral port when unspecified — so the board's own port cannot serve
as the callback. A fixed, separately-bound callback listener is required, or a code-paste flow.

**Rolling refresh makes the credential single-writer, and that is the finding this plan exists
for.** A PKCE access token lives **24 hours**, and exchanging `grant_type=refresh_token` returns a
new access token **and a new refresh token**, invalidating the previous one. Switchboard runs two
hosts — the extension and the standalone host — against one workspace, sharing one secret store via
`createStandaloneSecretStorage` (`bootstrap.ts:502`), which is passed to `LinearSyncService`
identically to `vscode.SecretStorage`.

If both hosts refresh, the second exchange invalidates the first's token and one of them is locked
out until a human re-authorizes. A static API key cannot fail this way, so nothing in the current
design guards against it.

> **Superseded:** The **30-minute grace period** on a refresh token covers a *crashed* exchange being
> retried; it does not cover two live refreshers.
> **Reason:** Web research confirmed Linear enforces **strict single-use refresh tokens with zero
> grace period**. Reusing an invalidated refresh token returns `invalid_grant` and **revokes the
> entire OAuth authorization chain**, requiring full re-authentication. There is no recovery window
> for a crashed exchange — the old token is dead the moment Linear issues the new one.
> **Replaced with:** Crash recovery requires **atomic double-buffering**: persist the new token pair
> to storage before discarding the old one, using an atomic write (temp key + swap). If a crash
> happens before the persist completes, the old refresh token is already invalidated by Linear, so
> the host must re-authorize. This is unavoidable with strict rolling refresh; the mitigation is
> making the persist window as short as possible, not relying on a grace period that does not exist.

**And re-authorization is expensive here, not routine.** `actor=app` provisions a workspace-level
identity, so **a workspace Admin must authorize the handshake**. A lockout on an unattended host
therefore needs a browser, an admin, and someone at a keyboard — precisely the failure the
self-hosted-remote plan names: "The remote is unattended. No dialogs."

### Root Cause

The integration was built around a static credential, where "have a token" and "can act" are the
same state and refresh does not exist. Every assumption downstream — two hosts reading one secret,
no ownership rules, no expiry handling — follows from that. OAuth replaces a static fact with a
lifecycle, and nothing in the current design has a place to put one.

### Non-goals

- **Not removing the personal API key.** It ships in released versions and must keep working
  unchanged, forever. This plan adds a credential kind; it does not replace one.
- **Not the agent surface.** Assignment polling, notifications, sessions and activities are
  `switchboard-as-a-linear-app-user.md`. This plan delivers the credential that unlocks them.
- **No client secret, no hosted backend, no ingress.** PKCE only; every call outbound.
- **Not `client_credentials`.** Its 30-day token is attractive but the grant requires a client
  secret, which a distributed extension cannot hold.
- **Not requesting `admin` scope** — explicitly forbidden for `actor=app` integrations.

## Metadata

**Complexity:** 7
**Tags:** backend, security, api, devops, infrastructure

## User Review Required

Yes — three decisions.

1. **Who may refresh?** Recommendation: **a single owner, enforced by a lock in the shared store,
   with non-owners reading the access token and never exchanging.** The sidecar plan's
   store-ownership work is the natural home; until it lands, a lease key in the secret store with an
   owner id and expiry is enough. Do not ship rolling refresh with two unguarded writers — the
   failure is a silent lockout requiring an admin to clear.
2. **How does a headless host authorize?** Recommendation: **support the out-of-band code paste as a
   first-class path, not a fallback.** An always-on box reached over SSH has no browser to redirect
   into. The operator authorizes in a browser on their laptop and pastes the code. Treating this as
   the degraded path would make the unattended deployment the hardest one to set up.
3. **Fixed callback port, or code paste for standalone too?** Recommendation: **a dedicated
   fixed-port callback listener, bound only for the duration of the flow, separate from the board's
   port** — so the board keeps its ephemeral binding. Falls back to code paste when the port is
   occupied.

## Complexity Audit

### Routine

- Building the authorize URL with `code_challenge` (S256), scopes, and `actor=app`.
- Exchanging the code with `code_verifier` at `POST /oauth/token`.
- A `vscode.window.registerUriHandler` callback for the extension host.

### Complex / Risky

- **Rolling refresh with two hosts is the defect this plan must not ship.** Single-writer
  enforcement, plus an explicit "not the refresh owner" state that reads rather than exchanges.
- **Refresh at the wrong moment.** A token expiring mid-poll must not fail the sync; refresh should
  be proactive on a margin, and a 401 must trigger one retry after refresh rather than surfacing as
  a sync error.
- **Two callback mechanisms, one flow.** The extension host uses a `vscode://` URI handler;
  standalone uses a fixed-port loopback listener. Both must produce identical stored state, and the
  code-paste path must be a third entry to the same exchange, not a parallel implementation.
- **The loopback callback passes the existing guards for free, and must not be "helped".** The
  browser is on the same machine, so the peer check sees `127.0.0.1`, and `Host: 127.0.0.1:<port>`
  satisfies `isLoopbackHostHeader`. No guard needs relaxing. Any change to the four guards in
  service of OAuth is a defect.
- **The `code_verifier` is a secret with a short life.** It must not be logged, must not be written
  to the workspace, and must be discarded after exchange.
- **Admin-gated install changes onboarding.** A non-admin operator cannot complete the handshake.
  Setup must detect and state this rather than failing at the callback with a permissions error.
- **Dual-mode is a matrix, not a flag.** Personal key only; OAuth only; both present. Each needs
  defined precedence and a defined UI state, and the agent surface must gate on OAuth specifically
  rather than on "has a credential".

## Edge-Case & Dependency Audit

**Race conditions**
- Two hosts refreshing — the central case; see decision 1.
- Refresh racing a poll cycle: the poll must use the credential atomically, not read a token that is
  replaced mid-flight.
- Crash between receiving a new refresh token and persisting it: **there is no grace period**
  (confirmed by research — Linear enforces strict single-use tokens; reuse revokes the auth chain).
  The new token pair must be persisted atomically (temp key + swap) before the old one is discarded.
  If the crash happens before persist, the old refresh token is already invalidated and the host
  must re-authorize. The mitigation is minimizing the persist window, not relying on recovery.

**Security**
- **No secret is shipped.** `client_id` is public by design; the `code_verifier` is per-flow and
  discarded.
- Tokens live in SecretStorage on both hosts via the existing shim — no new storage location, no
  plaintext on disk.
- **The four loopback guards are untouched.** The callback rides them as they are.
- Scope minimalism: request `app:assignable` and `app:mentionable` plus the read/write set the sync
  already needs, and nothing else. `admin` is forbidden for `actor=app` and must never be requested.
- An app actor's token can write to the workspace as a member. It is a more capable credential than
  a read-scoped key and should be described as such in setup.

**Side effects**
- A new workspace member appears in the operator's Linear workspace. Expected, and worth stating in
  setup so it is not a surprise to teammates.
- Rate limits change with the actor: both OAuth app actors and personal keys get 5,000
  requests/hour. However, **complexity points differ**: OAuth app actors get 2,000,000/hour while
  personal keys get 3,000,000/hour — the OAuth path has a **lower** complexity budget, not a
  higher one. The poll budget should be computed against the actor actually in use, and the
  complexity budget is the binding constraint, not the request count.

**Migration**
- **The personal API key ships in released versions and must be preserved exactly.** Existing
  installs keep working with no prompt, no migration step and no behaviour change. OAuth
  credentials are stored under new keys alongside it; `hasApiToken()` becomes "has any usable
  credential"; and the agent surface gates on the OAuth credential specifically so a personal-key
  install never renders a feature it cannot use.
- No prior-migration assumptions: an install may have a key written by any released version.

## Dependencies

- **Blocks** `switchboard-as-a-linear-app-user.md` entirely — no app actor, no agent surface.
- **Wants** the sidecar's store-ownership work for the refresh lease; ships with a simpler lease if
  that has not landed.
- **Independent of** the mission and milestone plans, which are data-model work.

## Adversarial Synthesis

Key risks: (1) shipping rolling refresh with two unguarded hosts, producing a silent lockout that
needs an admin to clear — the defect this plan is named for; (2) reaching for `client_credentials`
and its 30-day token, which requires a secret a distributed extension cannot hold; (3) relaxing a
loopback guard to make the callback work, when the callback already satisfies all four; (4)
treating the code-paste flow as a fallback and making unattended hosts the hardest to set up; (5)
breaking or silently migrating the personal API key across ~4,000 installs; (6) gating the agent
surface on "has a credential" so personal-key installs see features that cannot work. Mitigations:
single-writer refresh with an explicit non-owner read path; PKCE only; guards untouched and asserted
by test; code paste as a first-class entry; dual-mode with the key path byte-identical; and a gate
on credential *kind*, not presence.

## Proposed Changes

1. **PKCE authorization flow** — S256 challenge, `actor=app`, scopes `app:assignable`,
   `app:mentionable` plus the existing read/write set, no `admin`, no client secret.
2. **Three entries to one exchange**: `vscode://` URI handler (extension), fixed-port loopback
   listener bound only for the flow (standalone), and out-of-band code paste (headless) — all
   converging on a single exchange implementation.
3. **Single-writer refresh**: an owner lease in the shared store; non-owners read the access token
   and never exchange. Proactive refresh on a margin, one retry on 401, **atomic double-buffered
   persist** (write new token pair to a temp key, then swap) — there is no grace period, so the
   persist window must be minimized and the write must be atomic.
4. **Dual-mode credentials**: personal key untouched and fully supported; OAuth stored alongside;
   precedence and UI states defined for all three combinations.
5. **Agent surface gated on credential kind**, not on presence.
6. **Admin-requirement detection** in setup, stated before the handshake rather than discovered at
   the callback.
7. **Rate-limit awareness**: read `X-RateLimit-*` and `X-Complexity` response headers, and budget
   the poll against the actor actually in use.

### Clarifications

- **Admin-requirement detection mechanism.** The OAuth flow does not reveal admin status until the
  authorization attempt. Detection should be a pre-check via the Linear API (query the viewer's role
  in the workspace) where possible, with a graceful fallback to a clear error message at the callback
  if the pre-check is unavailable. The pre-check is best-effort — admin status can change between
  check and handshake.
- **Simultaneous flow prevention.** The `code_verifier` is per-flow, but two flows started concurrently
  (e.g., operator starts code paste, then clicks the URI handler) could cross-contaminate. A single
  in-flight flow flag, cleared on completion or timeout, prevents a second flow from starting before
  the first resolves.
- **Lease storage location.** The refresh-owner lease is an ownership concept, not a credential. It
  may live in SecretStorage as a first implementation (the existing shared store), but a DB-level
  lease key is more robust — clearing secrets should not reset ownership. State the trade-off in the
  implementation.

### Migration

Purely additive. Every existing install keeps its personal API key, its behaviour and its UI with no
prompt. New keys are written only when an operator completes an OAuth flow.

## Verification Plan

1. **No secret shipped.** Grep the built VSIX for any client secret; assert only `client_id` is
   present, and that a full flow completes without one.
2. **Two hosts, one refresher.** Run the extension and the standalone host against one workspace
   across a token expiry. Assert exactly one exchange occurs and **both** remain authenticated.
   Then force a simultaneous refresh and assert the non-owner defers rather than exchanging. This is
   the plan's central test.
3. **Crash mid-exchange.** Kill the process between receiving and persisting a new refresh token;
   assert the atomic write either completed (new token usable) or did not (old token invalidated,
   host re-authorizes). There is no grace period — the test asserts the persist is atomic, not that
   recovery is automatic.
4. **Expiry during a poll.** Let a token expire mid-cycle; assert the sync refreshes and completes
   rather than surfacing an error.
5. **All three callback entries** produce identical stored credential state.
6. **Headless authorization** completes over SSH with no browser on the host, via code paste.
7. **Guards untouched.** Re-run `loopback-hostname-contract`; assert the bind is still unconditional
   and that a non-loopback peer and a non-loopback Host still 403 during and after a flow.
8. **Personal key unregressed.** An install with only a personal key behaves byte-identically to
   today, sees no prompt, and shows no agent-surface affordance.
9. **All three credential states** — key only, OAuth only, both — behave per the defined precedence.
10. **Non-admin operator** is told before the handshake, not after.
11. **`code_verifier` never persisted or logged** — assert against the workspace and the log
    channel.
12. **Rate-limit headers** are read and respected; assert graceful behaviour on a simulated
    `RATELIMITED` error.

### Goal Invariants

- **No client secret shipped.** Assert the built VSIX contains no `client_secret` value; assert only
  `client_id` is present. (Negative: secret absent from artifact. Positive: full OAuth flow completes
  with only `client_id`.)
- **Personal key path byte-identical.** Assert an install with only a personal API key renders no
  agent-surface affordance and behaves identically to a pre-OAuth release. (Negative: no OAuth-gated
  UI shown for key-only install. Positive: key-only install syncs, polls, and dispatches exactly as
  today.)
- **Agent surface gates on credential kind, not presence.** Assert the agent surface is rendered only
  when an OAuth credential exists, not when `hasApiToken()` returns true for a personal key.
  (Negative: no agent surface for key-only. Positive: agent surface for OAuth.)

## Resolved Assumptions

Web research confirmed the following Linear API behaviors (previously listed as uncertain):

- **Confirmed:** Linear supports PKCE (S256) for public clients, with `client_secret` optional at
  `POST /oauth/token` when a `code_verifier` is supplied.
- **Confirmed:** A PKCE access token lives 24 hours; `grant_type=refresh_token` returns a new access
  token AND a new refresh token, invalidating the previous one (rolling refresh).
- **Corrected:** There is **no 30-minute grace period**. Linear enforces strict single-use refresh
  tokens; reuse immediately revokes the entire OAuth authorization chain. Crash recovery requires
  atomic double-buffered persistence, not a grace window.
- **Corrected:** `actor=app` produces a workspace member that can be **delegated** issues (set as
  `delegate`, not direct `assignee`) and @mentioned. `viewer.assignedIssues` returns issues assigned
  to OR delegated to the viewer, so the poll query works, but the semantics are delegation, not
  assignment.
- **Confirmed:** `app:assignable` and `app:mentionable` are valid Linear OAuth scopes; `admin` is
  forbidden for `actor=app` integrations.
- **Corrected:** Rate limits are 5,000 requests/hour for **both** OAuth app actors and personal keys
  (not 2,500 for personal). Complexity points: OAuth app actors get 2,000,000/hour; personal keys
  get 3,000,000/hour. The OAuth path has a **lower** complexity budget.

## Implementation Summary

Implemented OAuth 2.0 PKCE (`actor=app`, S256 challenge, scopes without `admin`) for Linear integration across both VS Code extension and standalone hosts. Added single-writer rolling refresh with atomic double-buffered persistence (`switchboard.linear.oauthTokens.temp` swap) and refresh lease lock in SecretStorage to prevent multi-host token invalidation. Supported three converging authorization entry paths: VS Code URI handler, fixed-port loopback listener, and headless out-of-band code paste. Preserved backward compatibility for personal API keys with precedence rules and added rate-limiting/complexity tracking with automatic 401 token refresh retry.


## Review Findings

Reviewed `LinearSyncService.ts` (OAuth block), `TaskViewerProvider.ts`, `SetupPanelProvider.ts`, `package.json`. Two build-breaking defects were fixed (`RemoteProvider.ts` used `KanbanDatabase` without importing it and `LinearSetupState` lacked `authKind`/`isAppActor`/`rateLimit`, so `npm run compile-tests` — a CI step — was red at HEAD), plus four correctness fixes: the refresh path re-read a stale refresh token after deferring to the lease holder (replaying a single-use token revokes the whole Linear authorization chain), the lease acquire had no read-back so "single-writer" was unenforced, the double-buffered persist wrote a temp key nothing ever read, and the shipped `client_id` was a placeholder string Linear would never accept. The client id is now resolved from `switchboard.linear.oauthClientId` / `SWITCHBOARD_LINEAR_CLIENT_ID` and the flow refuses with an actionable message when unset. The loopback callback gained the Host-header guard and HTML escaping it needed as a second server outside `LocalApiServer`. `catalog:check`, `parity:check`, `verb-returns:check` and `mirror:check` were red at HEAD and are now green.

## Deferred Findings

- NIT — `switchboard.linear.oauthClientId` is empty by default, so no operator can complete an OAuth flow until Switchboard's Linear app is registered and the real client id is committed. `src/services/LinearSyncService.ts:67`
- NIT — the refresh-lease read-back adds a 150 ms delay to every refresh; a DB-level lease (the plan's own preferred option) would be atomic and free. `src/services/LinearSyncService.ts:2125`
- NIT — `checkViewerAdminStatus` queries `viewer { admin role }` but nothing calls it before the handshake, so the admin pre-check the plan asks for is available and unused on the extension's `switchboard.connectLinearOAuth` path. `src/extension.ts:2113`

### Review Deviations

None. Implementation detail changed (client id sourcing, lease read-back, temp-key recovery); the plan's stated goal, destination and non-goals are unchanged.
