# A phone on the tailnet has nothing to connect to, and the docs promise a recipe that should not ship

## Goal

Make the mobile command route reachable from a phone on the operator's tailnet, and replace the
Tailscale material currently in `docs/REMOTE_ACCESS.md` — which promises a proxy recipe the
project's own reasoning argues against — with a verified path and an honest account of what it
trades.

### Problem Analysis

**The blocker is the bind, not the Host header.** This is worth stating plainly because the
existing documentation puts the emphasis in the wrong place. `LocalApiServer.ts:723` is
`this._server.listen(this._port || 0, '127.0.0.1', …)` — hardcoded, with no option threaded in,
and `bootstrap.ts:2964` records that "the bind address is 127.0.0.1 unconditionally; `hostname`
only changes the name". So **nothing is listening on the tailnet interface**. A phone on the
tailnet gets connection refused. The Host-header guard (`_isAllowedHost` →
`isLoopbackHostHeader`, `LocalApiServer.ts:6912`/`:6935`) never runs, because there is no
connection for it to reject.

Every path to a phone therefore needs a **terminator** on the host: something listening on the
tailnet interface that forwards inward to loopback. Tailscale supplies the network. It does not
supply the terminator.

**What the docs currently say about this is self-contradictory.** `docs/REMOTE_ACCESS.md`
instructs an operator to build a local proxy that rewrites `Host` to a loopback name, and
promises that "a verified snippet will replace this notice once it has been run end-to-end". But
the appendix of `standalone-remote-access-story.md` — added in that plan's own review pass —
concludes that the same proxy "is precisely what dismantles" the loopback protection and that
"the proxy recipe trades away the loopback guarantee, while the tunnel recipe keeps it". The
document is holding open a promise to publish a recipe the project has already reasoned itself
out of recommending, in a security document, where an unfulfilled promise reads as a roadmap.

**`tailscale serve` is a first-party terminator and changes the argument.** It listens on the
tailnet, forwards to `127.0.0.1:<port>`, and terminates TLS with a real tailnet certificate —
which a mobile browser increasingly requires for a usable secure context, and which a
hand-rolled `http://` proxy cannot give without its own certificate story. More importantly it
brings what the loopback peer check was standing in for: **per-device identity through SSO,
ACLs that scope which devices may reach a service, and per-device revocation.**
`docs/REMOTE_ACCESS.md` already states that anything past loopback needs an identity-aware
proxy in front. That is a description of what Tailscale is. Swapping a blanket peer check for
per-device identity is not obviously a downgrade — but it is a real change in posture and must
be argued, not assumed.

**Two facts decide whether this is a documentation change or a code change, and neither is
known.** Both are a short test against a real tailnet:

1. **Does `tailscale serve` present the tailnet name in the `Host` header, or rewrite it to the
   target?** If it rewrites to `127.0.0.1`, the guard passes and this works today with no code
   change at all. If it preserves the tailnet name, every request 403s and an `allowedHost`
   setting is required.
2. **Do WebSocket upgrades survive it?** If not, the board loads and terminals silently fail to
   stream — the exact symptom `docs/REMOTE_ACCESS.md` already warns about for reverse proxies,
   and the one an operator would otherwise spend an evening misdiagnosing.

**Nothing verified this because there was no consumer.** The Tailscale path existed in the docs
to serve a browser-only client, and until the mobile command route there was no such client
worth building for — Linear's app covered status, comments, notifications and dispatch on a
phone with no code at all. That is why this material sat with open verification steps for so
long, and why it is worth doing now.

### Root Cause

The remote-access work correctly hardened and documented the loopback posture, then wrote down a
*requirement* for the Tailscale path — "an operator needs a Host-rewrite proxy" — as a
placeholder for a recipe. A requirement stated as a pending recipe reads as an endorsement. The
subsequent review pass reached the opposite conclusion in an appendix rather than by editing the
document, so the contradiction shipped.

### Non-goals

- **No change to the bind address.** `listen('127.0.0.1')` stays unconditional. The terminator
  forwards inward; the server never listens on the tailnet interface itself.
- **No public internet exposure.** No Tailscale Funnel, no port-forward, no public `sshd`
  required by this plan. Auth is still one shared secret with no accounts, revocation or rate
  limiting, and that model does not support an internet-facing surface.
- **No hand-rolled reverse-proxy recipe.** The Caddy/nginx material is withdrawn rather than
  completed. If an operator wants one, the requirements are stated; no snippet is blessed.
- **Not the recommended path for a laptop.** SSH tunnel over the tailnet stays the recommended
  posture for any machine with an SSH client, and keeps the loopback guarantee fully intact.
  This plan is for the phone case only.
- **No new auth model.** If verification shows the exposed surface needs more than the shared
  secret, that is a finding for a separate plan, not scope creep into this one.

## Metadata

**Complexity:** 4
**Tags:** security, infrastructure, devops, docs, mobile
**Feature:** 1bf7a3ba-465b-4f4d-8cf6-54e8a6e675cc

## User Review Required

Yes — two decisions, and the first is the security decision of this plan.

1. **What is exposed over the tailnet: the whole board, or only the command route?**
   Recommendation: **only the command route.** The full board spawns PTYs, drives git and writes
   the workspace — reaching it is equivalent to a shell on the host, which is the entire premise
   of the loopback lockdown. The mobile route is deliberately narrow (no shell, no PAT entry, no
   repo scaffolding, no destructive verbs), and exposing only it is what makes the trade
   defensible. Whether `tailscale serve` can be scoped to a path, or whether this needs a
   route-level restriction on the server side, is part of what verification must establish.
2. **Ship `allowedHost` unconditionally, or only if verification proves it is needed?**
   Recommendation: **only if needed.** If `tailscale serve` rewrites `Host` to the target, a
   configurable Host allowlist is a guard weakened for no gain. Do not build it speculatively.

## Complexity Audit

### Routine

- Rewriting the Tailscale and reverse-proxy sections of `docs/REMOTE_ACCESS.md`.
- Correcting `README.md:31`, which currently offers "SSH tunnel, Tailscale, and reverse proxy
  setup" — **drop reverse proxy, keep Tailscale**, since Tailscale-as-transport remains the
  recommended posture.
- Closing verification steps 4-7 of `standalone-remote-access-story.md` as withdrawn rather
  than leaving a shipped plan with open steps for a recipe that is not being published.

### Complex / Risky

- **The posture argument is the deliverable, not the config.** The change that matters is
  documenting precisely what the terminator gives up and what replaces it. Get this wrong and
  the document either forbids something reasonable or blesses something it should not.
- **What the peer check stops doing.** Guard 2 (`LocalApiServer.ts:6926`) still passes
  truthfully — the terminator does connect from loopback — but it stops *distinguishing* a
  remote device from a local one. Today a compromised device on the tailnet gets a 403; after
  this it does not, and Tailscale ACLs are the only thing standing there. That must be stated as
  a consequence, not buried.
- **A conditional code change.** `allowedHost` exists or does not depending on a test result, so
  the plan must be honest that its own shape is unresolved until verification runs. If it does
  ship, it is a hardcoded predicate becoming configurable — `isLoopbackHostname` currently
  accepts only `127.0.0.1`, `localhost`, `::1`, `[::1]` and `*.localhost`, backed by an explicit
  DNS-rebinding threat model and a `loopback-hostname-contract` test forbidding a second copy of
  the predicate. Widening it for one operator-named host gives up the RFC 6761 unspoofability
  guarantee for that name, and the contract test and threat-model comment must be updated to say
  so rather than silently loosened.
- **Terminator lifecycle.** `tailscale serve` is host state that outlives a board launch. A
  board on an ephemeral port with a terminator pointed at a stale one fails confusingly. This is
  an argument for a durable port, and it interacts with the durable-token requirement the same
  way: a phone that re-pairs on every restart will not be used.
- **Silent WebSocket failure.** If upgrades do not survive, the board loads and terminals do not
  stream. The mobile route does not use terminals, so this may be acceptable for *this* plan and
  is still a blocker for anyone who reads the doc and points a laptop at it. The doc must say
  which.

## Edge-Case & Dependency Audit

**Race conditions**
- Board restarts on a new ephemeral port while the terminator points at the old one. The failure
  must be legible on the phone, not a blank page.
- Terminator running with no board behind it: connection refused from the phone should be
  distinguishable from an auth failure.

**Security**
- **Guards 1, 3 and 4 are untouched.** The bind stays `127.0.0.1`, the Host predicate is
  unchanged unless verification forces `allowedHost`, and CLI hostname validation is unchanged.
- **Guard 2's protective effect against tailnet peers is what this plan spends.** Named
  explicitly above; the mitigations are the narrow exposed surface (decision 1) and Tailscale
  ACLs scoping which devices may reach the service.
- **Auth is unchanged and remains the weak layer.** One shared secret, no accounts, no
  revocation, no rate limiting. Tailscale identity gates *reaching* the service; it does not give
  the board per-user auth. Every device that can reach it holds the same credential. The phone
  should use the durable `switchboard.apiToken` (`npx switchboard token rotate`), which
  `cli.ts:1081` already advertises as the way to "enrol a second device".
- **No Funnel, ever, under this plan.** Funnel is public exposure and the auth model does not
  support it. Worth stating in the doc so the adjacent Tailscale feature is not assumed in scope.

**Side effects**
- Documentation stops promising a snippet, which closes a question that otherwise recurs every
  time someone reads the open notice.
- The `switchboard-as-a-local-app-and-a-self-hosted-remote.md` plan's decisions #2 ("support
  both SSH and Tailscale, detect what is present") and #4 ("the app manages tunnel lifecycle:
  establish, monitor, re-establish") should be revisited in light of whatever this verifies.
  An IDE over SSH already establishes, monitors and re-establishes a forward for the laptop
  case, and `tailscale serve` is host state rather than something a tray app should own. That
  revision is a note for that plan, not an edit made by this one.

**Migration**
- Documentation, plus at most one new optional setting. No existing state, file, format or
  default changes. If `allowedHost` ships it defaults to empty, so every current install behaves
  exactly as it does today.

## Dependencies

- **Hard prerequisite:** the mobile command route. Without it there is nothing on the other end
  worth reaching, and decision 1 (expose only the command route) has no referent. This plan
  should not land first.
- **Recommends** the durable API token (`npx switchboard token rotate`) for any enrolled phone.
- **Independent of** the answer-back plan.

## Adversarial Synthesis

Key risks: (1) publishing a verified-looking recipe for the Host-rewrite proxy the project has
already argued against, which is the failure the current doc is one step away from; (2) building
`allowedHost` before knowing whether `tailscale serve` makes it unnecessary; (3) exposing the
whole board when only the command route needs reaching, which puts a PTY-spawning,
git-driving surface on the tailnet; (4) losing WebSocket upgrades and documenting a path whose
terminals silently do not stream; (5) framing Tailscale identity as strictly better than the
peer check without stating that a compromised tailnet device stops getting a 403. Mitigations:
withdraw the proxy recipe rather than complete it; gate the code change on the verification
result; scope the exposure to one route and verify the scoping actually holds; test upgrades
explicitly and document the outcome either way; state the guard-2 consequence in the document
body, not an appendix.

## Proposed Changes

1. **Verify `tailscale serve` end-to-end against a real tailnet**, before writing any code or
   any recipe. Establish: the `Host` header as received by the server; whether WebSocket
   upgrades survive; whether the served surface can be scoped to a single route; and whether the
   TLS certificate gives a phone browser a clean secure context.
2. **`allowedHost` only if step 1 shows `Host` is preserved.** If built: one operator-configured
   name added to the accepted set, empty by default, with the `loopbackHostname.ts` threat-model
   comment and the `loopback-hostname-contract` test updated to record that the RFC 6761
   guarantee does not extend to a configured name.
3. **Restrict the tailnet-exposed surface to the command route**, by whichever mechanism step 1
   shows actually works, and verify the restriction rather than assuming it.
4. **Rewrite `docs/REMOTE_ACCESS.md`:**
   - Lead the Tailscale section with **transport** — Tailscale plus `ssh -L` as the recommended
     posture for any machine with an SSH client, keeping the loopback guarantee whole.
   - Replace the proxy requirement and its pending-snippet promise with the verified
     `tailscale serve` path for phones, stating plainly what guard 2 stops doing and what
     Tailscale ACLs and device identity replace it with.
   - **Correct the emphasis:** the first blocker is the unconditional loopback bind, not the
     Host header. Say so.
   - Withdraw the Caddy/nginx section: keep the requirements, drop the promise of a blessed
     snippet.
   - State that Funnel is out of scope and why.
5. **`README.md:31`** — drop reverse proxy, keep SSH tunnel and Tailscale.
6. **Close verification steps 4-7** of `standalone-remote-access-story.md` as withdrawn, with
   the reason recorded so the material does not grow back.
7. **Note on `switchboard-as-a-local-app-and-a-self-hosted-remote.md`** that its decisions #2
   and #4 need revisiting; do not edit that plan from this one.

### Migration

Documentation plus at most one optional setting defaulting to empty. Nothing that shipped
changes behaviour; no state or file format is touched.

## Verification Plan

1. **Host header, measured not assumed.** Put `tailscale serve` in front and log the `Host` the
   server actually receives. This single result decides whether steps 2-3 of Proposed Changes
   exist.
2. **Real phone, real tailnet.** Load the command route from a phone browser with nothing
   installed but the Tailscale app. Secure context, no certificate warning, every control
   operable.
3. **WebSocket upgrades.** Attempt a terminal stream through the terminator and record whether
   it survives. Document the answer either way — a "no" is a documented limitation, not a
   failure of this plan.
4. **Scoping holds.** From the phone, attempt to reach `/board`, `/terminals`, `/setup`,
   `/kanban/...` and the design asset routes. Assert every one that is meant to be out of scope
   is actually refused, and that the refusal is enforced server-side rather than only by the
   terminator's configuration.
5. **Guards 1, 3, 4 intact.** Re-run `loopback-hostname-contract`. Assert the bind is still
   unconditional, that no flag, setting or env var changes it, and that a non-loopback `Host`
   still 403s unless it is the one configured name.
6. **The trade is real and bounded.** From a *second* tailnet device that is not the enrolled
   phone, attempt to reach the command route. Confirm the behaviour matches whatever the ACL
   says — this is the test that proves Tailscale identity is doing the job guard 2 used to do,
   and its result belongs in the document.
7. **Durable credential across restarts.** Restart the board and confirm the phone still
   authenticates without re-enrolling. If it does not, the durable token is a hard prerequisite
   rather than a recommendation.
8. **Stale terminator.** Restart the board onto a different port with the terminator unchanged
   and confirm the phone shows a legible error, not a blank page.
9. **Every command in the rewritten doc, executed as written.** No snippet ships unrun — the
   standard the original plan set and the one this plan exists to honour.
