# `switchboard tailnet` prints the credential-free tailnet URL and then opens the credentialed loopback one, which arrives already spent

## Goal

Make `switchboard tailnet` open the URL it exists to serve. In tailnet mode the browser must be handed the tailnet URL — the one that needs no credential and cannot expire — instead of the loopback URL with a single-use token that is routinely consumed before the page loads.

### Problem Analysis

**Reported:** running `npx switchboard tailnet` did not open the tailnet board. It opened the localhost board, which rendered a token error in the browser. The operator's reading — "I thought we did away with tokens" — is correct about the design and describes a real regression in behaviour.

**The command builds two URLs and opens the wrong one.** In `src/standalone/cli.ts`:

```ts
const boardUrl = `${instance.url}/?token=${instance.oneTimeToken}`;   // :3037  loopback + one-time token
...
const tailnetUrl = `http://${tailnetAddress}:${instance.port}/`;      // :3053  built only inside `if (tailnetAddress)`
console.log(`\nTailnet URL (no token needed, on your tailnet only): ${tailnetUrl}`);
...
if (!args.noOpen) {
    await openBrowser(boardUrl);                                      // :3077  unconditional
}
```

`tailnetUrl` is constructed, logged, and then discarded. `openBrowser` receives `boardUrl` on every path, so tailnet mode advertises the credential-free URL in the banner and launches the credentialed one.

**Why the opened URL then fails.** The loopback token is single-use and consumed server-side — `consumeOneTimeToken` at `LocalApiServer.ts:1281`, `:1333` and `:1387`, each falling through to a bare `Invalid or expired one-time token` response. Anything that touches the URL before the real page load spends it: a browser prefetch or preconnect on a handed-off URL, a redirect, a reload, or the URL simply having been opened once already. On macOS `openBrowser` shells out to `open <url>` (`:454`), which hands the URL to the default browser and has no control over what that browser does with it first.

**Meanwhile the URL that would have worked cannot fail this way.** `_checkAuth` (`LocalApiServer.ts:1140`) begins:

```ts
if (this._isTailnetSocket(req)) { return true; }
```

before any credential is examined, and the comment states the intent: *"a request that arrived on the tailnet listener is trusted exactly as loopback is trusted — no credential, no enrolment… Without it a durable token would 401 the tablet."* There is no token to spend and no session to miss.

### Root Cause

**The mode changes what is printed but not what is launched.** `tailnetAddress` gates a `console.log` branch and nothing else. `boardUrl` is computed once, unconditionally, from `instance.url` — which is always the loopback origin — and is the only value `openBrowser` ever sees. The tailnet URL exists as a string in a log statement, not as a candidate for the browser.

The compounding factor is that the mode's whole purpose makes the wrong choice maximally likely to fail. `tailnet` is the mode an operator selects when the point is reaching this box from elsewhere; it is disproportionately run on a headless or remote machine, over SSH, or on a host whose browser the operator is not sitting in front of — every situation in which a single-use loopback token is most likely to be spent by something other than the intended page load.

**A secondary defect makes it unrecoverable in the moment.** The failure renders as `Invalid or expired one-time token` (`:1293`, `:1345`, `:1399`) — plain text, no route forward. It does not mention the tailnet URL, which is sitting in the terminal the operator just looked away from and which requires no credential at all.

### Non-goals

- **Do not weaken the one-time token or make it multi-use.** Single-use is correct for a credential pasted into a URL. The fix is to stop putting it in front of a browser that does not need it.
- **Do not change `_checkAuth`.** The tailnet bypass at `:1151` is already right and is the reason the correct URL works.
- **Do not remove the loopback board URL from the banner.** It remains the answer for a browser that cannot reach the tailnet address, and for `local` mode.

## Metadata

**Topic:** Tailnet mode opens the tailnet board
**Complexity:** 3
**Tags:** cli, standalone, auth, ux, bug

## User Review Required

None. In tailnet mode the tailnet URL is the correct target: it needs no credential, cannot be spent, and is reachable from the host machine itself as well as from every tailnet peer.

## Complexity Audit

### Routine
- Selecting `tailnetUrl` over `boardUrl` for `openBrowser` when `tailnetAddress` is set.
- Adding the tailnet URL to the spent-token response body.

### Complex / Risky
- **`tailnetUrl` is currently scoped inside the `if (tailnetAddress)` block** (`:3052-3057`). Hoisting it so the `openBrowser` call at `:3077` can see it must not change what the banner prints or the order it prints in — the banner is the fallback an operator reads when the browser does nothing.
- **The detached path prints its own banner** (`:2972-2976`) and exits before reaching `:3077`. `--detach` implies `--no-open` unless `--open` is passed explicitly, so the explicit-`--open` case in tailnet mode must make the same choice, or the fix lands on one path and not the other.
- **Reaching the tailnet address from the host itself.** The listener is bound to the machine's own Tailscale interface address, so a browser on that machine reaches it — but if Tailscale is down at the moment the browser launches, the tailnet URL fails where loopback would have worked. `tailnet` mode already "fails loudly (non-zero) if Tailscale is absent or down" before the server starts, so the address is live by the time this runs; do not add a second probe, and do not silently fall back to the token URL, which reintroduces the bug.

## Edge-Case & Dependency Audit

**Race conditions:** None new. `openBrowser` is fire-and-forget (`spawn(..., {detached: true}).unref()`, `:458`), already sequenced after `waitForHealth`.

**Security:** This narrows credential exposure rather than widening it: the tailnet URL carries no secret, so it is not written into browser history, shell history, or a `ps` listing the way `?token=…` is. Access is still gated — by tailnet membership, which `_checkAuth` already treats as the control.

**Side effects:** MagicDNS names are printed at `:3055` when available. Prefer the numeric tailnet address for the browser open (name resolution is one more thing that can fail at launch) and leave the MagicDNS line in the banner as-is.

**Dependencies & conflicts:** Subtask of the **Tailnet** feature. Depends on the URL resolver plan (`the-tailnet-url-never-offers-a-secure-origin.md`) landing first — this plan hoists the resolver's `tailnetUrl` output, not a raw-IP construction. The spent-token recovery body (change 3) reads `this._bindPolicy` from the server, which is populated by the Host header fix (Subtask 0) and the MagicDNS names plan (Subtask 1). No conflicts with the CSRF guard (Subtask 4) — the guard is in `_handleRequest`, this plan touches the token-response body and the `openBrowser` call site.

## Dependencies

Subtask of the **Tailnet** feature. Lands after the URL resolver plan (`the-tailnet-url-never-offers-a-secure-origin.md`), which constructs the `tailnetUrl` this plan hoists. The spent-token recovery body reads `this._bindPolicy`, populated by Subtask 0 (Host header fix) and Subtask 1 (MagicDNS names).

## Adversarial Synthesis

Key risks: (1) "fixing" this by making the one-time token multi-use or longer-lived, which weakens a credential that appears in a URL instead of removing the need for it — explicitly forbidden above; (2) falling back to `boardUrl` when the tailnet open appears to fail, which restores the reported behaviour under a condition nobody will notice — the mode already refuses to start without a live Tailscale, so no fallback is warranted; (3) fixing the foreground path and leaving `--detach --open` on the old URL, a one-line divergence between two arms of the same command — mitigation: verification exercises both; (4) treating this as cosmetic because the banner "already prints the right URL" — the operator ran a command that opens a browser, and the browser is the output.

## Proposed Changes

**1. Open the URL the mode is for (`cli.ts:4565-4605`).**

After the URL resolver plan (`the-tailnet-url-never-offers-a-secure-origin.md`) lands, the tailnet URL is already the resolver's output (`resolveTailnetOrigin`), not the raw IP. This plan hoists that URL and selects it for `openBrowser`. Introduce `launchUrl = tailnetAddress ? tailnetUrl : boardUrl`, where `tailnetUrl` is whatever the resolver produced (HTTPS FQDN, HTTP FQDN, or HTTP IP — in that trust order). Pass `launchUrl` to `openBrowser` at `:4605`. The banner is unchanged: both URLs are still printed, in the same order, with the same wording — the resolver's primary URL plus the IP fallback line.

> **Superseded:** "Hoist `tailnetUrl` out of the printing block and introduce `launchUrl = tailnetAddress ? tailnetUrl : boardUrl`" — where `tailnetUrl` was `http://${tailnetAddress}:${instance.port}/` (raw IP).
> **Reason:** The URL resolver plan (Subtask 2, lands before this one per the feature's fixed order) replaces the raw-IP `tailnetUrl` construction with `resolveTailnetOrigin(...)`. By the time this plan is implemented, `tailnetUrl` is already the resolver's output. Constructing the raw IP here would overwrite the resolver's choice and reintroduce the insecure-origin problem the resolver exists to fix.
> **Replaced with:** Hoist the resolver's `tailnetUrl` (already constructed by Subtask 2) and select it for `openBrowser`. Do not construct a raw-IP URL in this plan.

**2. Same choice on the detached path (`cli.ts:4497-4505`).**

Where `--detach --open` opens a browser, apply the identical `launchUrl` selection so the two arms cannot drift. The detached parent already runs the resolver (per Subtask 2's detached-mode handling), so the `tailnetUrl` printed in the detached banner is the resolver's output. The `--detach --open` browser launch must open that same URL, not a raw-IP construction.

**3. Make a spent token recoverable (`LocalApiServer.ts:1293`, `:1345`, `:1399`).**

Replace the bare `Invalid or expired one-time token` with a short body that says the token was single-use and already consumed, and — when a tailnet listener is active — names the tailnet URL as the credential-free way in. The tailnet URL named here is the bind policy's tailnet address (the server knows its own bind policy via `this._bindPolicy`), not the resolver's chosen URL — the server does not run the resolver, and the raw tailnet address is always reachable on the tailnet even when the resolver picked the FQDN. An operator who lands here should not have to return to the terminal to find out what to do.

**4. Say why in a comment.**

At the `launchUrl` line: in tailnet mode the tailnet URL needs no credential and cannot be spent, whereas the loopback token is single-use and is routinely consumed by a browser prefetch before the page loads. Without this, the next person to "simplify" the two URLs back into one will reintroduce it.

## Verification Plan

### Goal Invariants

- Assert `openBrowser` in `src/standalone/cli.ts` receives `launchUrl` (not `boardUrl`) when `tailnetAddress` is set — the `?token=` query string is absent from the URL passed to `openBrowser` in tailnet mode.
- Assert the `boardUrl` construction (`${instance.url}/?token=${instance.oneTimeToken}`) is still present for `local` mode — the loopback token URL is not removed, only unselected in tailnet mode.
- Assert the `--detach --open` path applies the same `launchUrl` selection as the foreground path — no `boardUrl` passed to `openBrowser` when `tailnetAddress` is set, on either path.
- Assert the spent-token response body in `LocalApiServer.ts` names the tailnet URL (from `this._bindPolicy`) when a tailnet listener is active — the bare `Invalid or expired one-time token` string is absent from the three token-exchange sites.
- Assert the one-time token is still single-use (`consumeOneTimeToken` is unchanged) — the fix is in URL selection, not in token semantics.

### Manual Verification
1. Run `npx switchboard tailnet` on a machine with Tailscale up. The browser opens `http://<tailnet-ip>:<port>/` — no `?token=` in the address bar — and the board renders.
2. Run it again immediately without stopping the first. The second launch's browser open still succeeds; there is no token to have been spent.
3. Run `npx switchboard local`. The browser opens the loopback URL with its one-time token, exactly as today. This is the regression fence for the unchanged mode.
4. Run `npx switchboard tailnet --detach --open`. The same tailnet URL opens; the detached banner still prints PID, URL, tailnet URL and log path.
5. Run `npx switchboard tailnet --no-open`. No browser launches, and both URLs are printed in the current order and wording.
6. Spend a one-time token deliberately (open the loopback board URL twice). The second response names the tailnet URL and states the token was single-use — not a bare `Invalid or expired one-time token`.
7. From a second device on the tailnet, open the printed tailnet URL. It loads with no credential — confirming `_checkAuth`'s tailnet bypass is untouched.
8. With a durable token configured (`npx switchboard token rotate`), repeat 1 and 7. Both still work without a credential on the tailnet path; the loopback board still requires its session.
9. Both hosts: this is standalone-only (`cli.ts` has no extension counterpart), but confirm `LocalApiServer`'s changed response body is correct under the extension host too, since that file is shared and the extension serves no one-time tokens.

## Implementation Summary

Hoisted the resolver's `tailnetUrl` out of the tailnet print branch in `src/standalone/cli.ts` into a `launchUrl` variable (defaulting to `boardUrl`) and passed `launchUrl` — not `boardUrl` — to `openBrowser`, so tailnet mode opens the credential-free tailnet URL instead of the single-use loopback token URL that a browser prefetch routinely spends before the page loads. The detached child re-enters the same foreground code path, so `--detach --open` makes the identical choice with no second arm to drift. In `src/services/LocalApiServer.ts`, replaced the bare `Invalid or expired one-time token` at all three token-exchange sites (`/`, `/project`, `/`) with a `_spentTokenBody()` helper that names the consequence (single-use, already consumed) and, when a tailnet listener is active, points at the credential-free tailnet URL built from `this._tailnetAddress` — the always-reachable name the server knows without running the resolver. `consumeOneTimeToken` is unchanged; the fix is in URL selection, not token semantics.
