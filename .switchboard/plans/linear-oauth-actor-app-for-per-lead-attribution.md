# Every Switchboard write to Linear appears as you — give each team lead its own identity with an actor=app OAuth token

## Goal

Make Switchboard's Linear writes attributable to the agent that made them: a completion comment from the review lead reads as "Review Lead", a dispatch receipt as the seat that picked the work up. Via an OAuth application authorized with `actor=app` plus PKCE, using `createAsUser` / `displayIconUrl` per lead — no workspace seats, no client secret in a distributed extension.

### Problem Analysis

**Today every write is indistinguishable from the operator's own activity.** Linear auth is a personal API token stored at `switchboard.linear.apiToken` (`TaskViewerProvider.ts:8814` writes it, `:3815` and `:8475` read presence). A token acts as its owner, so `postManagedComment` (`LinearSyncService.ts:1444`), status changes and issue creation all appear in Linear as the operator. With one agent that is merely imprecise. With a fleet of leads it is a real loss: the card records that *something* completed, never which seat, and the human reading the card cannot tell an agent's comment from their own.

**This gets worse exactly as the remote loop gets better.** `remote-control-dispatch-acknowledgment-writeback.md` adds a receipt at dispatch time, and Linear's own app turns each of those into a phone notification. Unattributed, a stream of "picked this up" notifications that all appear to come from you is noise; attributed per lead, it is a legible activity feed.

**The mechanism exists and costs nothing.** A Linear OAuth application authorized with `actor=app` acts as its own non-user entity — its configured name and icon appear in issues, comments and activity — and because the token binds to an app actor rather than a member account it occupies no paid seat. In that mode the API additionally exposes `createAsUser` and `displayIconUrl` on issue and comment mutations, so a single app can attribute individual writes to named actors dynamically. One app, N leads, zero seats.

**And the objection that would have killed it is answered.** Linear's OAuth supports PKCE: `code_challenge` + `code_challenge_method=S256` on `/oauth/authorize`, `code_verifier` in the token exchange at `api.linear.app/oauth/token`, and `client_secret` omitted for public clients. A distributed extension cannot ship a secret; with PKCE it does not need one.

**But there is prior art that must be understood before repeating it.** `extension.ts:1470-1478` is a live migration: *"Remove dead Stitch OAuth auth mode (shipped in prior releases). Reset any stale 'oauth' authMode to 'apiKey' and delete the dead accessToken secret."* Switchboard shipped an OAuth mode once and withdrew it, migrating users back to API keys. PKCE addresses the client-secret half of why that might have happened; it does not address redirect handling, refresh, or the two-host problem. **Establishing why Stitch OAuth was pulled is a prerequisite, not a curiosity** — if the cause was any of those, it recurs here identically.

**The callback plumbing does not exist.** There is no `registerUriHandler` anywhere in the codebase, so the extension has no URI-handler path today. And the two hosts need different strategies: the extension can register a `vscode://` handler, while the standalone host has no such scheme and needs a loopback listener. `LocalApiServer` could host that callback and is loopback-bound — fine when the browser is on the same machine, and *not* fine in the tunnelled or thin-client case where the browser is elsewhere. That asymmetry is the real design work in this plan.

### Root Cause

Every integration in this codebase authenticates as the operator, because every integration began as "let the operator's tooling reach their tracker." Attribution only becomes a requirement once several agents write to the same card, which is recent.

### Non-goals

- Replacing the API token. It stays the default and supported path; this is additive and opt-in.
- Routing. `createAsUser` sets the **author** of a write, never the assignee — an issue still cannot be assigned to a lead. Inbound routing is `route-linear-issues-to-team-leads-by-label.md`.
- Creating Linear members for leads. Seats, emails, and it would put agents in the humans' assignee field.
- Notion or ClickUp. Same argument may apply; out of scope until this one works.

## Metadata

**Complexity:** 6
**Tags:** api, backend, security, feature, ux, reliability

## User Review Required

Yes — four decisions.

1. **Why was Stitch OAuth removed?** Blocking. If the cause was redirect or refresh complexity rather than the client secret, this plan inherits it and should be reconsidered rather than re-attempted. Recommendation: answer this from git history before any implementation.
2. **Redirect strategy per host.** Recommendation: `vscode://` URI handler for the extension; a short-lived loopback listener for the standalone host, spawned only for the duration of the flow rather than added to `LocalApiServer`'s permanent surface. Explicitly refuse the flow when the browser is not local (tunnelled or thin-client), with a message saying to authorize from the host machine — an OAuth redirect that cannot reach the listener is a hang, and a hang here looks like a broken integration.
3. **Default posture.** Recommendation: **PAT stays the default; OAuth is opt-in.** The benefit is attribution quality, not capability, and making it the default would gate a nice-to-have behind an onboarding regression for ~4,000 installs.
4. **Actor naming.** Recommendation: derive `createAsUser` from the seat's role and team (e.g. "Review Lead · fleet-2") rather than a per-lead configured string, so a new team needs no configuration. `displayIconUrl` can reuse the existing brand-icon assets.

## Complexity Audit

### Routine

- The PKCE flow: verifier/challenge generation, authorize URL, token exchange, state validation.
- Threading `createAsUser` / `displayIconUrl` through `postManagedComment` and the issue-creation path.
- Storing the app token beside the existing secret, and a capability flag so the UI shows which mode is active.

### Complex / Risky

- **Two hosts, two callbacks, and one of them can be remote.** Covered in decision 2; it is the part most likely to ship broken because it works on the developer's machine.
- **Refresh and revocation.** A PAT never expires; an OAuth token does. Every call site currently assumes a static credential. Refresh must be single-flight and must not turn a transient 401 into a re-auth prompt loop — and a revoked app must fail with a clear "reauthorize" state rather than looking like a Linear outage.
- **Attribution must not silently degrade.** If `createAsUser` is unsupported or the mode is misconfigured, writes will still succeed — as the app, or as the operator. A silent fallback means the operator believes comments are attributed when they are not. Fail loudly on the write path, or surface the actual mode per write.
- **Mixed history.** Existing cards carry comments authored by the operator; new ones will be authored by leads. Readers will see the seam. Worth stating in the release note rather than leaving people to wonder whether their old comments were rewritten.
- **`createAsUser` semantics are documented from a single source.** The field's exact behaviour — whether it creates a display-only actor, and how it interacts with mentions and notifications — was reported to this plan's author rather than verified against Linear's API reference. Verify before building the attribution layer on it.

## Edge-Case & Dependency Audit

**Race conditions**
- Two seats posting to one issue concurrently, each with a different `createAsUser`. Should be independent, but worth asserting rather than assuming.
- Token refresh during a batch push.

**Security**
- The app token grants workspace write. Store it in the same encrypted store as the PAT, never in `settings.json`, never echoed to a webview.
- `state` must be validated on callback, and the loopback listener must bind loopback only and close immediately after the exchange.
- PKCE verifier is single-use and must not be logged.
- `actor=app` means writes are no longer traceable to a human in Linear's audit. That is the point, and it is worth stating: attribution shifts from "which person" to "which seat", and the operator remains accountable for all of it.

**Side effects**
- `remote-control-dispatch-acknowledgment-writeback.md` becomes materially better with this and should reference it.
- The `linear-api` protocol documents the auth model and needs updating.
- Any UI showing "Linear connected" needs to distinguish token mode from app mode, per decision 3's opt-in.

**Migration**
- Purely additive: a new secret and a capability flag. No install changes behaviour until the operator authorizes an app.
- The Stitch precedent argues for an explicit escape hatch: if app mode fails, one action returns the install to PAT mode without losing the PAT.

## Dependencies

- **Blocked on** answering why Stitch OAuth was removed (decision 1).
- **Improves** `remote-control-dispatch-acknowledgment-writeback.md`.
- **Independent of** `route-linear-issues-to-team-leads-by-label.md` — routing works under either auth mode.
- **Verify before building:** `createAsUser` / `displayIconUrl` semantics against Linear's API reference.

## Adversarial Synthesis

Key risks: the codebase already shipped and withdrew an OAuth mode, and the cause is unestablished — PKCE only answers the client-secret half; the standalone host's loopback callback cannot be reached when the browser is remote, which presents as a hang rather than an error; a silent attribution fallback would leave the operator believing comments are attributed when they are not; and the `createAsUser` semantics this plan rests on come from a single unverified source. Mitigations: establish the Stitch cause before implementing; refuse the flow when the browser is not local with an explicit message; fail loudly rather than degrade on the attribution path; verify the API fields first; and keep PAT as the default with a one-action fallback.

## Proposed Changes

1. **A PKCE OAuth flow** with `actor=app`: challenge/verifier, `state` validation, token exchange without a client secret.
2. **Per-host callback:** `vscode://` URI handler for the extension; a transient loopback listener for the standalone host, closed after exchange; explicit refusal when the browser is not local.
3. **Per-lead attribution:** `createAsUser` and `displayIconUrl` derived from the seat's role and team, threaded through `postManagedComment` and issue creation.
4. **Refresh and revocation:** single-flight refresh, a distinct reauthorize-required state, no prompt loops.
5. **Loud failure on attribution:** never silently post unattributed when app mode is selected.
6. **Opt-in with a fallback:** PAT remains default; one action returns to PAT mode retaining the existing token.
7. **Update the `linear-api` protocol** and any connected-state UI to distinguish the two modes.

### Migration

Additive and opt-in. No behaviour changes until an app is authorized, and returning to PAT mode is one action.

## Verification Plan

- **Stitch precedent answered:** the plan does not start until decision 1 is resolved in writing.
- **PKCE end to end:** authorize, exchange without a client secret, and assert a working token. Assert the verifier never appears in logs and `state` mismatch is rejected.
- **Per-lead attribution:** post comments from two different seats; assert Linear shows two distinct actors with the expected names and icons, and that neither appears as the operator.
- **No seat consumed:** assert workspace seat count is unchanged after authorizing.
- **Attribution failure is loud:** simulate `createAsUser` being rejected; assert the write fails visibly rather than posting unattributed.
- **Remote-browser refusal:** attempt the flow from a tunnelled session; assert an immediate explicit refusal, not a hang.
- **Refresh:** expire the token mid-session; assert a single-flight refresh, no duplicate posts, and no prompt loop. Revoke the app; assert a reauthorize state distinct from a network error.
- **Fallback:** switch back to PAT mode; assert the original token still works and no data was lost.
- **Both hosts:** run the whole suite under the extension and the standalone host.

## Outstanding Questions

- Why was Stitch OAuth withdrawn? Until answered, this plan is a repeat of an experiment that already failed once.
- Does `createAsUser` produce a mentionable/notifiable actor, or a display-only label? It changes whether a lead can be @-mentioned in a reply.
- Should Notion and ClickUp follow if this works, or is Linear's app-actor model unusual enough that the pattern does not transfer?
