# Every Switchboard write to Linear appears as you — give each team lead its own identity with an actor=app OAuth token

## Goal

Make Switchboard's Linear writes attributable to the agent that made them: a completion comment from the review lead reads as "Review Lead", a dispatch receipt as the seat that picked the work up. Via an OAuth application authorized with `actor=app` plus PKCE, using `createAsUser` / `displayIconUrl` per lead — no workspace seats, no client secret in a distributed extension.

### Problem Analysis

**Today every write is indistinguishable from the operator's own activity.** Linear auth is a personal API token stored at `switchboard.linear.apiToken`.

> **Superseded:** `TaskViewerProvider.ts:8814` writes it, `:3815` and `:8475` read presence.
> **Reason:** Those line numbers have drifted. Line 8814 is `includeProjectNames: linearConfig.includeProjectNames ?? []`; 3815 is the close of an unrelated handler; 8475 is a `}`. The token is written at `TaskViewerProvider.ts:9040` and `:9119` (both `secrets.store('switchboard.linear.apiToken', …)`), and presence is read at `:4050` and `:8701` (both `secrets.get('switchboard.linear.apiToken').then(t => !!t)`). A third write site lives in `extension.ts:2033`.
> **Replaced with:** `TaskViewerProvider.ts:9040` and `:9119` write it; `:4050` and `:8701` read presence; `extension.ts:2033` is a third write site. The token is also mirrored into the machine-global secret store via `MIRRORED_SECRET_KEYS` (`extension.ts:678`) and read by `LinearSyncService.getApiToken()` (`LinearSyncService.ts:1892`), which is the single chokepoint every GraphQL call funnels through (`graphqlRequest`, `:1951`, sends `Authorization: <raw token>` at `:1980`).

A token acts as its owner, so `postManagedComment` (`LinearSyncService.ts:1444`), status changes and issue creation all appear in Linear as the operator. With one agent that is merely imprecise. With a fleet of leads it is a real loss: the card records that *something* completed, never which seat, and the human reading the card cannot tell an agent's comment from their own.

**This gets worse exactly as the remote loop gets better.** `remote-control-dispatch-acknowledgment-writeback.md` adds a receipt at dispatch time, and Linear's own app turns each of those into a phone notification. Unattributed, a stream of "picked this up" notifications that all appear to come from you is noise; attributed per lead, it is a legible activity feed.

**The mechanism exists and costs nothing.** A Linear OAuth application authorized with `actor=app` acts as its own non-user entity — its configured name and icon appear in issues, comments and activity — and because the token binds to an app actor rather than a member account it occupies no paid seat. In that mode the API additionally exposes `createAsUser` and `displayIconUrl` on issue and comment mutations, so a single app can attribute individual writes to named actors dynamically. One app, N leads, zero seats.

**And the objection that would have killed it is answered.** Linear's OAuth supports PKCE: `code_challenge` + `code_challenge_method=S256` on `/oauth/authorize`, `code_verifier` in the token exchange at `api.linear.app/oauth/token`, and `client_secret` omitted for public clients. A distributed extension cannot ship a secret; with PKCE it does not need one.

**The prior art is answered, and it changes the shape of this plan.** `extension.ts:1470-1478` migrates a stale `stitch.authMode` from `oauth` back to `apiKey` and deletes the dead token. The reason: **Google's OAuth tokens did not last beyond about two hours, so the operator had to re-authenticate every session** — strictly worse than a persistent key. That was a property of Google's OAuth, not of OAuth as a mechanism, so it does not transfer to Linear automatically. But it identifies the disqualifying condition precisely, and it is sharper than the client-secret question PKCE answers:

> **Does Linear issue a durable refresh token that can be exchanged without user interaction?**

This is disqualifying rather than inconvenient. `RemoteControlService` polls on `pingFrequencySeconds` (default 60) and the extension runs unattended for hours. An auth mode that needs interactive re-authentication on *any* cadence is incompatible with a background poller, and would make `actor=app` worse than the PAT no matter how good the attribution. Answer this before building anything.

**And the operator's point generalises: if the whole benefit is attribution, there is a version that costs nothing.** `postManagedComment` (`LinearSyncService.ts:1444`) already exists with managed markers. A comment body prefixed with the seat — `**Review Lead** — completed …` — tells a human exactly which seat spoke, under the existing persistent key, with no OAuth flow, no callback, no refresh and no re-auth. What it does not give is a distinct author field and a per-lead avatar. That is cosmetic rather than functional, which makes the prefix the sensible first move and `actor=app` an upgrade contingent on the refresh answer.

**The callback plumbing does not exist.** There is no `registerUriHandler` anywhere in the codebase, so the extension has no URI-handler path today. And the two hosts need different strategies: the extension can register a `vscode://` handler, while the standalone host has no such scheme and needs a loopback listener. `LocalApiServer` could host that callback and is loopback-bound — fine when the browser is on the same machine, and *not* fine in the tunnelled or thin-client case where the browser is elsewhere. That asymmetry is the real design work in this plan.

**And the seat identity does not reach the write path today.** This is the gap both the cheap prefix and the `actor=app` upgrade hand-wave over. `postManagedComment(issueId, body)` (`LinearSyncService.ts:1444`) takes no seat parameter, and the only agent-reachable route into it — `POST /comment` in `LocalApiServer` (`_handlePostComment`, `:1408`) — parses a body of `{ provider, id, body }` and calls `service.postManagedComment(id, text)` with nothing else. So neither a body prefix nor `createAsUser` can be applied unless a seat identity is first threaded from the agent (which knows its own role from its dispatch prompt) through the `/comment` route into `postManagedComment` and on into `addIssueComment`'s `commentCreate` mutation (`:1393`). The host-side dispatch-ack path is different but no better: `RemoteControlService._applyStateMirror` (`:807`) posts via `provider.postComment(remoteId, body)` with a hardcoded body that names only the target **column** (`:811`), not a seat — so the orchestrator layer knows "the LEAD CODED column was dispatched," not "Review Lead · fleet-2 picked this up." Attribution requires the seat to flow on both paths, and neither carries it today.

### Root Cause

Every integration in this codebase authenticates as the operator, because every integration began as "let the operator's tooling reach their tracker." Attribution only becomes a requirement once several agents write to the same card, which is recent.

### Non-goals

- Replacing the API token. It stays the default and supported path; this is additive and opt-in.
- Routing. `createAsUser` sets the **author** of a write, never the assignee — an issue still cannot be assigned to a lead. Inbound routing is `route-linear-issues-to-team-leads-by-label.md` *(note: that plan file is not present in `.switchboard/plans/` as of this review — the reference may be stale or the plan unwritten; see Outstanding Questions)*.
- Creating Linear members for leads. Seats, emails, and it would put agents in the humans' assignee field.
- Notion or ClickUp. Same argument may apply; out of scope until this one works.

## Metadata

**Complexity:** 7

> **Superseded:** Complexity 6 (Mixed — majority routine with one or two moderate risks).
> **Reason:** The improve pass found the work is broader than the original audit captured. Beyond the PKCE flow and two-host callback already flagged, there are three additional non-routine pieces: (1) the seat identity must be threaded through a call path that carries none today (`/comment` route → `postManagedComment` → `commentCreate`), plus a second host-side path (`_applyStateMirror` → `postComment`); (2) `graphqlRequest` (`LinearSyncService.ts:1951`) sends `Authorization: <raw token>` (`:1980`) — correct for a PAT, wrong for an OAuth bearer, so the single GraphQL chokepoint must branch on auth mode; and (3) that same `graphqlRequest`→`getApiToken()` funnel is where refresh-on-401, mode-aware token selection, and the reauthorize state must all live. New auth pattern + security-sensitive token handling + multi-path threading = High, not Mixed.
> **Replaced with:** Complexity 7 (High — new auth pattern, complex token/refresh state machine, security-sensitive, multi-path threading across two hosts).

**Tags:** api, backend, security, feature, ux, reliability

## User Review Required

Yes — four decisions.

1. **Answered, and replaced by a sharper blocking question.** Stitch OAuth was withdrawn because Google's tokens expired in roughly two hours, forcing re-authentication every session — worse than a persistent key. The transferable question is therefore: **does Linear support non-interactive refresh for an unattended client?** Blocking. If it does not, this plan should be dropped in favour of the body-prefix approach below, because an unattended poller cannot depend on interactive auth.
1b. **Ship the cheap version first.** Recommendation: **prefix the comment body with the seat name now**, under the existing token — it delivers the readable-attribution benefit immediately with no auth change, and it is the fallback if the refresh answer is bad. Treat `actor=app` as a later upgrade that adds a distinct author and avatar, not as the way to get attribution at all.
2. **Redirect strategy per host.** Recommendation: `vscode://` URI handler for the extension; a short-lived loopback listener for the standalone host, spawned only for the duration of the flow rather than added to `LocalApiServer`'s permanent surface. Explicitly refuse the flow when the browser is not local (tunnelled or thin-client), with a message saying to authorize from the host machine — an OAuth redirect that cannot reach the listener is a hang, and a hang here looks like a broken integration.
3. **Default posture.** Recommendation: **PAT stays the default; OAuth is opt-in.** The benefit is attribution quality, not capability, and making it the default would gate a nice-to-have behind an onboarding regression for ~4,000 installs.
4. **Actor naming.** Recommendation: derive `createAsUser` from the seat's role and team (e.g. "Review Lead · fleet-2") rather than a per-lead configured string, so a new team needs no configuration. `displayIconUrl` can reuse the existing brand-icon assets.

## Complexity Audit

### Routine

- The PKCE flow: verifier/challenge generation, authorize URL, token exchange, state validation.
- Threading `createAsUser` / `displayIconUrl` through `postManagedComment` and the issue-creation path.
- Storing the app token beside the existing secret, and a capability flag so the UI shows which mode is active.

### Complex / Risky

- **The seat identity does not reach the write path.** `postManagedComment(issueId, body)` (`LinearSyncService.ts:1444`) and the `POST /comment` route (`LocalApiServer._handlePostComment`, `:1408`, body `{ provider, id, body }`) carry no seat. The body-prefix (step 0) and `createAsUser` (step 3) both require threading a seat from the agent through the route into `addIssueComment`'s `commentCreate` mutation (`:1393`). A second, host-side path — `RemoteControlService._applyStateMirror` (`:807`) → `provider.postComment` with a column-named body (`:811`) — must carry a seat too if dispatch acks are to be attributed. Without this threading the OAuth layer can exist and comments still post unattributed on the agent path — the plan's own success check would pass for a hardcoded seat while the real goal (auto-attribution of every agent write) is unmet.
- **`graphqlRequest` is the auth-mode chokepoint and it assumes a raw PAT.** `LinearSyncService.graphqlRequest` (`:1951`) reads `getApiToken()` (`:1892` → secret `switchboard.linear.apiToken`) and sends `Authorization: <raw token>` (`:1980`) — the correct form for a `lin_api_…` PAT and the wrong form for an OAuth bearer, which needs `Bearer <token>`. Every Linear call funnels through this one method, so mode-aware token selection, the `Bearer` vs raw branch, refresh-on-401, and the reauthorize state all live here. The auto-download plan already flagged this exact raw-vs-Bearer hazard for attachment fetches.
- **Two hosts, two callbacks, and one of them can be remote.** Covered in decision 2; it is the part most likely to ship broken because it works on the developer's machine.
- **Refresh is the plan's viability condition, not a detail.** A PAT never expires; an OAuth token does, and every call site currently assumes a static credential. Beyond the mechanics — single-flight refresh, no prompt loop on a transient 401, a distinct reauthorize state versus a Linear outage — the question is whether refresh can happen at all without a human. This is exactly what sank the Stitch integration, and an unattended 60-second poller is a harsher test than anything Stitch faced.
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

- **Blocked on** answering why Stitch OAuth was removed (decision 1) — **resolved** (Google ~2h token expiry; see Outstanding Questions). The live blocker is now the Linear refresh-token question below.
- **Improves** `remote-control-dispatch-acknowledgment-writeback.md` — its dispatch-ack body (`RemoteControlService._applyStateMirror:811`) is column-named today; per-lead attribution makes the receipt legible.
- **Independent of** `route-linear-issues-to-team-leads-by-label.md` — routing works under either auth mode. *(That plan file is not present in `.switchboard/plans/` as of this review; treat the reference as notional until it exists.)*
- **Verify before building:** `createAsUser` / `displayIconUrl` semantics against Linear's API reference.

## Adversarial Synthesis

Key risks: the codebase already shipped and withdrew an OAuth mode, and the cause is unestablished — PKCE only answers the client-secret half; the standalone host's loopback callback cannot be reached when the browser is remote, which presents as a hang rather than an error; a silent attribution fallback would leave the operator believing comments are attributed when they are not; and the `createAsUser` semantics this plan rests on come from a single unverified source. Mitigations: establish the Stitch cause before implementing; refuse the flow when the browser is not local with an explicit message; fail loudly rather than degrade on the attribution path; verify the API fields first; and keep PAT as the default with a one-action fallback.

## Proposed Changes

0. **First, and independent of everything else: prefix managed comment bodies with the seat name.** No auth change, no flow, works today, and it is the fallback if the refresh answer below is bad.
1. **A PKCE OAuth flow** with `actor=app`, only if non-interactive refresh is confirmed: challenge/verifier, `state` validation, token exchange without a client secret.
2. **Per-host callback:** `vscode://` URI handler for the extension; a transient loopback listener for the standalone host, closed after exchange; explicit refusal when the browser is not local.
3. **Per-lead attribution:** `createAsUser` and `displayIconUrl` derived from the seat's role and team, threaded through `postManagedComment` and issue creation.
4. **Refresh and revocation:** single-flight refresh, a distinct reauthorize-required state, no prompt loops.
5. **Loud failure on attribution:** never silently post unattributed when app mode is selected.
6. **Opt-in with a fallback:** PAT remains default; one action returns to PAT mode retaining the existing token.
7. **Update the `linear-api` protocol** and any connected-state UI to distinguish the two modes.

### Migration

Additive and opt-in. No behaviour changes until an app is authorized, and returning to PAT mode is one action.

## Verification Plan

- **Body prefix, first and separately:** assert a managed comment names its seat, under the existing token, with no auth change — the deliverable that does not depend on any OAuth answer.
- **Non-interactive refresh, before any OAuth work:** run an authorized app past its access-token lifetime with no human present. Assert the poller keeps working. If it cannot, the OAuth half of this plan is dropped, not worked around — that is the Stitch failure repeating.
- **PKCE end to end:** authorize, exchange without a client secret, and assert a working token. Assert the verifier never appears in logs and `state` mismatch is rejected.
- **Per-lead attribution:** post comments from two different seats; assert Linear shows two distinct actors with the expected names and icons, and that neither appears as the operator.
- **No seat consumed:** assert workspace seat count is unchanged after authorizing.
- **Attribution failure is loud:** simulate `createAsUser` being rejected; assert the write fails visibly rather than posting unattributed.
- **Remote-browser refusal:** attempt the flow from a tunnelled session; assert an immediate explicit refusal, not a hang.
- **Refresh:** expire the token mid-session; assert a single-flight refresh, no duplicate posts, and no prompt loop. Revoke the app; assert a reauthorize state distinct from a network error.
- **Fallback:** switch back to PAT mode; assert the original token still works and no data was lost.
- **Both hosts:** run the whole suite under the extension and the standalone host.

## Outstanding Questions

- **Resolved:** Stitch OAuth was withdrawn because Google tokens expired in ~2 hours, requiring re-authentication every session. A Google property, not an OAuth one — but it defines the blocking question for Linear.
- What is Linear's access-token lifetime, does it issue refresh tokens, and do those refresh tokens themselves expire? The third part is what actually killed Stitch-style integrations elsewhere.
- Does `createAsUser` produce a mentionable/notifiable actor, or a display-only label? It changes whether a lead can be @-mentioned in a reply.
- Should Notion and ClickUp follow if this works, or is Linear's app-actor model unusual enough that the pattern does not transfer?
