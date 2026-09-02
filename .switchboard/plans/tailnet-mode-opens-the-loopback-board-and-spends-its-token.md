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

**Dependencies & conflicts:** None.

## Adversarial Synthesis

Key risks: (1) "fixing" this by making the one-time token multi-use or longer-lived, which weakens a credential that appears in a URL instead of removing the need for it — explicitly forbidden above; (2) falling back to `boardUrl` when the tailnet open appears to fail, which restores the reported behaviour under a condition nobody will notice — the mode already refuses to start without a live Tailscale, so no fallback is warranted; (3) fixing the foreground path and leaving `--detach --open` on the old URL, a one-line divergence between two arms of the same command — mitigation: verification exercises both; (4) treating this as cosmetic because the banner "already prints the right URL" — the operator ran a command that opens a browser, and the browser is the output.

## Proposed Changes

**1. Open the URL the mode is for (`cli.ts:3037-3077`).**

Hoist `tailnetUrl` out of the printing block and introduce `launchUrl = tailnetAddress ? tailnetUrl : boardUrl`. Pass `launchUrl` to `openBrowser` at `:3077`. The banner is unchanged: both URLs are still printed, in the same order, with the same wording.

**2. Same choice on the detached path (`cli.ts:2968-2977`).**

Where `--detach --open` opens a browser, apply the identical selection so the two arms cannot drift.

**3. Make a spent token recoverable (`LocalApiServer.ts:1293`, `:1345`, `:1399`).**

Replace the bare `Invalid or expired one-time token` with a short body that says the token was single-use and already consumed, and — when a tailnet listener is active — names the tailnet URL as the credential-free way in. An operator who lands here should not have to return to the terminal to find out what to do.

**4. Say why in a comment.**

At the `launchUrl` line: in tailnet mode the tailnet URL needs no credential and cannot be spent, whereas the loopback token is single-use and is routinely consumed by a browser prefetch before the page loads. Without this, the next person to "simplify" the two URLs back into one will reintroduce it.

## Verification Plan

1. Run `npx switchboard tailnet` on a machine with Tailscale up. The browser opens `http://<tailnet-ip>:<port>/` — no `?token=` in the address bar — and the board renders.
2. Run it again immediately without stopping the first. The second launch's browser open still succeeds; there is no token to have been spent.
3. Run `npx switchboard local`. The browser opens the loopback URL with its one-time token, exactly as today. This is the regression fence for the unchanged mode.
4. Run `npx switchboard tailnet --detach --open`. The same tailnet URL opens; the detached banner still prints PID, URL, tailnet URL and log path.
5. Run `npx switchboard tailnet --no-open`. No browser launches, and both URLs are printed in the current order and wording.
6. Spend a one-time token deliberately (open the loopback board URL twice). The second response names the tailnet URL and states the token was single-use — not a bare `Invalid or expired one-time token`.
7. From a second device on the tailnet, open the printed tailnet URL. It loads with no credential — confirming `_checkAuth`'s tailnet bypass is untouched.
8. With a durable token configured (`npx switchboard token rotate`), repeat 1 and 7. Both still work without a credential on the tailnet path; the loopback board still requires its session.
9. Both hosts: this is standalone-only (`cli.ts` has no extension counterpart), but confirm `LocalApiServer`'s changed response body is correct under the extension host too, since that file is shared and the extension serves no one-time tokens.
