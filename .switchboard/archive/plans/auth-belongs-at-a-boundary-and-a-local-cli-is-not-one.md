# Auth belongs at a trust boundary, and a shell user calling their own CLI is not one

## Goal

Give each surface exactly one control, chosen for the threat it actually faces, and stop the standalone
host demanding a bearer token from callers that already have more authority than the token grants. A
shell user on the board's machine can `rm -rf` the workspace, read `kanban.db`, and kill the server;
requiring them to present a credential before moving a card guards a door inside a building they are
standing in.

### Problem Analysis

**The standalone host makes the no-token path unreachable on the loopback listener.**
`bootstrap.ts:545-558` resolves a token on every launch — the durable `switchboard.apiToken` if one is
stored, otherwise `crypto.randomBytes(32)` (line 545) assigned to `resolvedToken` at line 558. So
`getAuthToken()` (wired at `bootstrap.ts:2954`) is never empty under `npx switchboard`, and `_checkAuth`'s
escape hatch never fires on loopback:

```js
// Extension path: no token configured => keep the historical loopback-trust behavior.
if (!expected) { return true; }
```

(`src/services/LocalApiServer.ts:1145-1146`.) The comment says "Extension path" because that is the only
host where it is reachable. Under standalone **every loopback request is authenticated** — loopback CLI,
skill script, local agent alike.

> **Superseded:** "`switchboard tailnet` still demands a token despite its own help text" — original
> improve-pass claimed this symptom **does not exist** because `_checkAuth`
> (`src/services/LocalApiServer.ts:1143`) returns `true` when `_isTailnetSocket(req)` fires.
> **Reason:** That bypass is real but it only fires for requests that **arrive on the tailnet listener** —
> i.e. `socket.localAddress` matches the bound tailnet address. Every shipped local client connects via
> **loopback**, not the tailnet address: `sb_api_call.sh:87,122,128` hardcodes
> `http://localhost:$PORT`, and all seven `kanban_operations/*.js` scripts hardcode `host: '127.0.0.1'`.
> They read `.switchboard/api-server-port.txt` and hit the loopback listener, where
> `socket.localAddress` is `127.0.0.1`, `_isTailnetSocket` returns `false`, and the minted token 401s
> them. The symptom IS real under `switchboard tailnet` — the tailnet listener's bypass does not help
> agents on the host because they never use it. The bypass only helps a browser or agent on a *different*
> tailnet device connecting via `http://100.x.x.x:<port>/`.
> **Replaced with:** The tailnet *listener* is auth-bypassed (live code), but the *symptom* — agents
> 401'd under `switchboard tailnet` — is real and caused by the same loopback unconditional mint as
> every other standalone case. The agents connect via `localhost`/`127.0.0.1` regardless of serve mode.
> This plan's change 1 (stop the unconditional mint) fixes it for the same reason it fixes the
> `switchboard local` case: `getAuthToken()` returns `''`, the loopback-trust branch fires, and
> loopback callers — including the skill scripts running under `switchboard tailnet` — stop 401ing.

**That one decision produces the symptoms already written up separately:**

| symptom | plan that recorded it | status at HEAD |
| :--- | :--- | :--- |
| the skill layer 401s wholesale on standalone (loopback) | `switchboard-clients-send-api-auth-header.md` — *"the entire skill layer is dead on the standalone host, and no gate reports it"* | **live** — `sb_api_call.sh` and the `kanban_operations/*.js` scripts send no `Authorization` header and 401 against the minted loopback token |
| an out-of-process agent has no credential to present | `publish-agent-api-token-for-out-of-process-agents.md` | **live** on loopback; the tailnet listener is bypassed but agents connect via loopback, so the bypass does not reach them |
| agents 401 under `switchboard tailnet` despite the help text saying "No token, no enrolment" | (recorded here) | **live** — the tailnet *listener* is no-token (`_checkAuth:1143`) but agents on the host connect via `localhost`/`127.0.0.1` (loopback listener), where the unconditional mint still 401s them. The help text is accurate for a remote tailnet device, not for the host's own agents |

Each was diagnosed on its own and none named the common cause, so the fixes are additive: publish a
credential, then teach eight clients to send it. Both plans exist to make an unnecessary check
passable rather than to ask whether it should run.

**The control does not match the threat, surface by surface.**

| surface | what the caller already has | what actually bounds it | status of the bound at HEAD |
| :--- | :--- | :--- | :--- |
| shell user on the host (CLI, skill script, local agent) | the filesystem, `kanban.db`, the server's own process | **file permissions** — the same check `rm` passes | the loopback listener still demands a token on top (the bug this plan fixes) |
| browser tab | ambient authority: any page you visit can `fetch()` the port | **`Sec-Fetch-Site` / `Origin`**, plus the Host allowlist against DNS rebinding | Host allowlist is **live** (`_handleRequest` Guard 3, `LocalApiServer.ts:7943-7952`); the `Sec-Fetch-Site`/`Origin` metadata guard is **planned** in `browser-board-csrf-cross-site-rejection.md` and **not yet implemented** (`Sec-Fetch-Site` appears nowhere in `LocalApiServer.ts`) |
| device on the tailnet (remote) | tailnet membership, revocable | **the bind** + the `_isTailnetSocket` bypass — `switchboard tailnet` serves that interface only and trusts it without a credential | **live for remote tailnet devices** (`_checkAuth:1143`); but agents on the *host* connect via loopback (`localhost`/`127.0.0.1`) and hit the loopback listener, where the unconditional mint still 401s them — see Superseded callout above |

> **Superseded:** "row 2 is being closed **without** a credential — `browser-board-csrf-cross-site-rejection.md`
> rejects cross-site state-changing requests *"using request metadata (`Sec-Fetch-Site` / `Origin`) rather
> than a credential."*" (original phrasing implied the CSRF guard is present)
> **Reason:** That sibling plan is **not implemented** at HEAD — `Sec-Fetch-Site` does not appear in
> `LocalApiServer.ts` at all. Only the Host allowlist (Guard 3) is live. Stating the CSRF defence in the
> present tense would let a coder believe the browser surface is already metadata-guarded after this plan
> removes the token, when in fact it would have only the Host allowlist until the sibling plan lands.
> **Replaced with:** The browser surface's live cross-site defence at HEAD is the Host allowlist alone.
> The `Sec-Fetch-Site`/`Origin` metadata guard is a **planned** sibling (`browser-board-csrf-cross-site-rejection.md`)
> that must land for the browser row to be fully closed without a credential. This plan must not weaken
> or assume that guard; change 3 keeps the browser defences independent of the credential regardless of
> whether the sibling has shipped.

A token adds nothing to row 1: it is readable by the same uid that could skip the API entirely. It adds
nothing to row 3 for a *remote* tailnet device: the network boundary is the control, which is what the
tailnet bypass already implements. But agents on the host under `switchboard tailnet` connect via
loopback, so they sit in row 1, not row 3 — and the token adds nothing there either. And row 2's
metadata guard is being designed **without** a credential —
`browser-board-csrf-cross-site-rejection.md` rejects cross-site state-changing requests *"using request
metadata (`Sec-Fetch-Site` / `Origin`) rather than a credential"* (planned, not yet in tree).

**So on the product's own stated threat model the token has no remaining job on loopback.** That model
is stated in `publish-agent-api-token-for-out-of-process-agents.md`: *"The threat model is single-user
loopback."* The one case a shared secret still answers is a **second uid on the same machine**, which
that plan explicitly puts out of scope by choosing `0600`.

### Root Cause

Auth was added at the transport because the transport was where the code was, not because a trust
boundary ran through it. The extension host kept loopback trust and stayed coherent; the standalone host
minted a secret unconditionally and every local caller inherited a check that protects nothing.

### Non-goals

- **Not removing the CSRF and rebinding defences.** They guard a real threat and are strengthened here,
  not weakened. `browser-board-csrf-cross-site-rejection.md` and the Host allowlist stay.
- **Not opening a new bind.** `remote-switchboard-is-tailscale-and-nothing-else.md` keeps loopback the
  default and forbids LAN and `0.0.0.0`. This plan changes who must present a credential, never who can
  reach the port.
- **Not deleting the token.** It stays supported for the multi-user case and for anyone who wants it —
  it stops being **mandatory**, and stops being minted when nobody asked for one.

## Metadata

**Complexity:** 6
**Tags:** security, auth, infrastructure, cli, docs, reliability, ux

## User Review Required

- **This removes a control, so it wants human review rather than an unattended coding pass.** The
  argument is that the control is redundant on a single-user machine; that is a judgement about threat
  model, and it should be made deliberately. The verification plan is written to make the claim
  falsifiable rather than assumed.
- **Confirm the threat model.** If a Switchboard board is ever expected to run on a host where another
  uid must be excluded, row 1 of the table above is wrong and the token stays mandatory. The stated
  model says otherwise; this plan takes the stated model at its word.
- **Note the empty-cookie interaction.** When `resolvedToken` becomes empty, the `/` token-exchange
  handler still emits `Set-Cookie: sb_session=` (empty). The extension host ships this exact state today
  and the board opens fine (loopback trust makes the cookie irrelevant). The sibling
  `browser-board-csrf-cross-site-rejection.md` change #7 owns stopping that empty emission; this plan
  does not touch it. Flagged here so the next reader does not treat the empty cookie as a regression
  introduced by this change.

## Complexity Audit

### Routine
- Stop the unconditional `crypto.randomBytes(32)` mint in `bootstrap.ts:545-558` — guard it behind
  `usingDurableToken` (or an explicit "user asked for auth" flag), so `resolvedToken` is `''` when no
  durable token is stored and nobody opted in.
- Rename the `_checkAuth` branch comment at `LocalApiServer.ts:1145-1146` from "Extension path" to the
  *local-trust path* and state the two conditions (loopback peer OR tailnet listener) in the code.
- Keep `token set` / `token rotate` / `secrets set apiToken` working and enforced when set — no
  capability removed, only the automatic mint.
- Correct the agent-tunnel section of `docs/REMOTE_ACCESS.md` (see Proposed Changes #6).

### Complex / Risky
- **Removing an auth gate on a security surface.** The loopback listener's only remaining control after
  this change is the OS file-permission boundary on `kanban.db` and the bind address. That is the stated
  single-user threat model, but it is a human-made call, not one an empty string makes — hence the User
  Review gate above.
- **The browser surface on standalone loopback loses the token's incidental coverage** before the
  sibling CSRF metadata guard lands. After this change, cross-site defence on standalone loopback is the
  Host allowlist alone until `browser-board-csrf-cross-site-rejection.md` ships. Change 3 must keep the
  browser defences running regardless of token state so the gap does not widen.
- **The empty `sb_session` cookie** left by the `/` handler when `expected` is empty — harmless under
  loopback trust but a reader-mystery; tracked as an edge case, fixed by the sibling plan.

## Edge-Case & Dependency Audit

- **Race Conditions:** None introduced. `resolvedToken` is resolved once at boot and `getAuthToken` is a
  closure over it; making it `''` changes one assignment at line 558, read atomically by every request.
- **Security:** The single-user assumption is the load-bearing one. A second uid on the host that can
  reach `127.0.0.1:<port>` would, after this change, call the API with no credential. The threat model
  scopes this out (`0600`, "single-user loopback"); the User Review gate exists to enforce that the
  model holds for the deployment. The bind address and Host allowlist are unchanged and remain the
  network-boundary controls.
- **Side Effects:** The `?token=<oneTimeToken>` boot URL still works — the one-time token is minted
  separately at `bootstrap.ts:573` and consumed at the `/` handler; with `expected` empty the handler
  sets an empty cookie and `_checkAuth` returns true via loopback trust, so the board loads exactly as
  it does on the extension host today. The enrolment-token mint (`POST /auth/mint`) already returns 503
  in ephemeral mode (`bootstrap.ts:595-608`), so it is unchanged when no durable token is configured.
- **Dependencies & Conflicts:** Depends on `browser-board-csrf-cross-site-rejection.md` landing to fully
  close the browser row without a credential; until then the Host allowlist is the sole live cross-site
  defence on standalone loopback. The sibling plans
  `publish-agent-api-token-for-out-of-process-agents.md` and `switchboard-clients-send-api-auth-header.md`
  already carry "Scope — what survives once the mandatory token goes" sections that self-retire against
  this plan (see Dependencies) — no conflict, their residual scope (opt-in token case + 401-reporting
  fix) stays correct.

## Dependencies

- `browser-board-csrf-cross-site-rejection.md` — closes the browser row's cross-site vector with
  `Sec-Fetch-Site`/`Origin` metadata. Not a hard dependency for *this* plan's loopback change, but
  required for the overall "each surface has its one control" thesis to hold for the browser surface.
- `publish-agent-api-token-for-out-of-process-agents.md` — already self-retired: its "Scope — same
  machine, and only when a token is configured" section states it applies only to the opt-in case once
  this plan stops the unconditional mint. No action needed here beyond recording that.
- `switchboard-clients-send-api-auth-header.md` — already self-retired: its "Scope — what survives once
  the mandatory token goes" section keeps the 401-reporting fix and shared discovery routine (needed for
  the opt-in case) and drops the "precondition for the skill layer" framing. No action needed here
  beyond recording that.
- `remote-switchboard-is-tailscale-and-nothing-else.md` — owns the bind policy; this plan changes who
  authenticates, not what is bound. No conflict.

## Adversarial Synthesis

Key risks: (1) removing the loopback auth gate is correct only under the single-user threat model — a
second uid on the host gains unauthenticated API access; mitigated by the User Review gate and the
stated `0600`/single-user model. (2) the browser surface on standalone loopback is left with only the
Host allowlist until the sibling CSRF plan lands; mitigated by change 3 keeping browser defences
independent of token state. (3) stale evidence in the original plan (tailnet "symptom", CSRF
present-tense) could mislead a coder into re-fixing a solved case or assuming a guard that doesn't
exist; mitigated by the Superseded callouts above. Mitigations: keep the token opt-in (change 4), keep
browser defences credential-independent (change 3), correct the doc's agent-tunnel section only (change
6), record rather than re-prescribe the sibling retirement (change 5).

## Proposed Changes

1. **Stop minting a session token when none is configured.** In `bootstrap.ts:545-558`, mint only when a
   durable `switchboard.apiToken` is stored or the user asked for auth. With no token, `resolvedToken`
   is `''`, `getAuthToken()` (wired at `bootstrap.ts:2954`) returns empty, and `_checkAuth`'s existing
   loopback-trust branch (`LocalApiServer.ts:1145-1146`) becomes reachable on standalone loopback — the
   extension host's behaviour, applied to the host that never had it. The tailnet bypass at
   `LocalApiServer.ts:1143` is unaffected and already does the equivalent for its listener.

2. **Make the trust explicit rather than incidental.** Rename the branch's comment at
   `LocalApiServer.ts:1145-1146`: it is not "the extension path", it is *the local-trust path* — the
   request reached a socket bound to loopback or the tailnet interface, and both are boundaries the
   deployment already chose. State the two conditions in the code so the next reader does not
   re-derive them.

3. **Keep the browser's defences independent of the credential.** The Host allowlist
   (`_handleRequest` Guard 3, `LocalApiServer.ts:7943-7952`) must run regardless of whether a token is
   configured — it already does (gated on `serveStatic`, not on auth). The planned CSRF metadata guard
   from `browser-board-csrf-cross-site-rejection.md` must likewise be credential-independent when it
   lands. Today a reader might assume the token covers the browser case; it does not, and after change 1
   that assumption would be actively wrong.

4. **Keep the token as opt-in.** `token set` / `token rotate` / `secrets set apiToken` continue to work
   and continue to be enforced when set (`_checkAuth` still compares the bearer header / `sb_session`
   cookie against a non-empty `expected`). Nothing removes the capability; change 1 removes the
   *automatic* mint that made it unavoidable.

5. **Record that the sibling plans have already self-retired — do not re-prescribe.**
   `publish-agent-api-token-for-out-of-process-agents.md` already carries a "Scope — same machine, and
   only when a token is configured" section that states it applies only to the opt-in case once this
   plan stops the unconditional mint. `switchboard-clients-send-api-auth-header.md` already carries a
   "Scope — what survives once the mandatory token goes" section that keeps its 401-reporting fix (still
   correct) and its shared discovery routine (needed for the opt-in case) and drops the "precondition for
   the skill layer" framing. Both point back at this plan. No edit to those files is required from this
   plan; this change is a record in this plan that the retirement is already done, not a new write.

6. **Correct the agent-tunnel section of `docs/REMOTE_ACCESS.md`.** The `token rotate` advice at
   `docs/REMOTE_ACCESS.md:181-183` sits in the "Agentic access through the same tunnel" section,
   addressed to **agents reaching the loopback listener over an SSH tunnel**. After change 1, an agent
   on loopback with no configured token needs no credential either, so that advice becomes conditional
   ("set a durable token only if you have configured one / want one"). The tailnet section
   (`docs/REMOTE_ACCESS.md:71-78`) is already correct ("Tailnet membership is the control") and must not
   be touched — it never described the unconditional mint. Narrow the doc change to the agent-tunnel
   section; do not conflate it with the tailnet section.

## Verification Plan

### Automated Tests
1. **A shell user needs nothing.** With no token configured, run a board command as the owning user on
   the host and assert it succeeds — no header, no file read, no environment variable. This is the case
   the plan exists for and must fail against the current standalone tree.
2. **The skill layer works on standalone.** Run the `kanban_operations` scripts and `sb_api_call.sh`
   against `npx switchboard` with no token and assert none 401s. That is the regression
   `switchboard-clients-send-api-auth-header.md` documents, reproduced from the other direction.
3. **`switchboard tailnet` — both listeners.** (a) From a second tailnet device, call the API via
   `http://100.x.x.x:<port>/` with no credential and assert success — this is already live at HEAD via
   `_checkAuth:1143` and must not regress. (b) **From the host itself**, run the `kanban_operations`
   scripts and `sb_api_call.sh` (which connect via `localhost`/`127.0.0.1`, i.e. the loopback listener)
   and assert they succeed with no token — this is the case that is **broken today** under
   `switchboard tailnet` because the loopback listener still mints, and is fixed by change 1.
4. **CSRF is still refused, with no token configured.** Simulate a cross-site state-changing request
   (`Sec-Fetch-Site: cross-site`) and assert rejection. This is the assertion that proves change 1 did
   not remove the browser's protection along with the redundant one — and it must be run with auth
   **off**, since that is the configuration the change creates. **Note:** at HEAD this assertion can
   only pass once `browser-board-csrf-cross-site-rejection.md` has landed; until then the Host allowlist
   (Guard 3) is the live defence and the test should assert the Host-allowlist rejection (foreign `Host:`
   header → 403) with auth off.
5. **DNS rebinding is still refused.** Same-origin-looking request with a foreign `Host:` header;
   assert 403 from the Host allowlist, token or no token.
6. **A configured token is still enforced.** Set a durable token and assert unauthenticated requests
   401 — change 4 must not become "auth is gone".
7. **No token file is written when none is configured.** Assert `api-server-token.txt` is absent, so a
   reader cannot conclude a credential is required from the presence of a file.
8. **The port is still not reachable off-box.** Assert the bind is unchanged for `local` and
   tailnet-only for `tailnet` — the network boundary is now load-bearing, so a test that would have been
   belt-and-braces before is now the primary control and must be asserted here rather than assumed from
   another plan.
9. **Both hosts.** The extension host's behaviour must be byte-identical after this change — it already
   had loopback trust. Assert that, so the change is provably standalone-only.

### Goal Invariants
- Assert `getAuthToken()` (wired at `src/standalone/bootstrap.ts:2954`) resolves to `''` when no durable
  `switchboard.apiToken` is stored and no auth was requested — the precondition for the loopback-trust
  branch being reachable on standalone.
- Assert `_checkAuth` (`src/services/LocalApiServer.ts:1134`) returns `true` for a loopback peer when
  `expected` is empty, and returns `false` for the same peer when a durable token is set and no
  credential is presented — the opt-in path stays enforced.
- Assert the tailnet bypass at `src/services/LocalApiServer.ts:1143` is unchanged: a request arriving
  on the tailnet listener (`socket.localAddress` === tailnet address) is trusted with no credential
  regardless of token state. Note this only covers remote tailnet devices; host-local agents connect
  via loopback and are covered by the `getAuthToken() === ''` invariant above.
- Assert `crypto.randomBytes` is NOT called for the session token in `bootstrap.ts` when no durable
  token is stored (negative invariant — the unconditional mint is gone); paired positive: when a durable
  token IS stored, `resolvedToken` equals the trimmed stored value.
- Assert the Host allowlist (`_handleRequest` Guard 3) still rejects a foreign `Host:` header with auth
  off — the browser defence is independent of the credential.

## Outstanding Questions

- **[user]** Does any deployment run a Switchboard board on a host where a second uid must be excluded
  from the loopback API? — proceeding on the assumption that the stated "single-user loopback" threat
  model holds and the token stays opt-in (not mandatory) for that case.

## Implementation Summary

Implemented changes 1-6. The standalone host no longer mints an unconditional HTTP session secret:
`resolvedToken` is `''` when no durable `switchboard.apiToken` is stored, so `_checkAuth`'s
local-trust branch is now reachable on standalone loopback (extension-host parity). The token stays
opt-in — `token set` / `token rotate` / `secrets set apiToken` still enforce a credential when set.

**Critical gap found and fixed during context-gathering (not named in the plan):** `resolvedToken`
was shared between the HTTP auth surface AND the terminal WebSocket gateway
(`TerminalWsGateway`, `bootstrap.ts`). The terminal gateway uses `authorizeWsUpgrade` with
`rejectWhenTokenEmpty: true` — an RCE-grade gate (a browser page attaching to an agent shell could
type into it). Naively emptying `resolvedToken` to gain loopback trust would have 401'd every
`/ws/terminal` upgrade: terminals that render but never stream. The extension host never had this
conflation — its ptyHost child mints `_terminalSessionToken` independently of `switchboard.apiToken`
(`ptyHost.ts:45`). The fix separates the tokens on standalone to match the extension-host
architecture: a new always-minted `terminalSessionToken` feeds the `TerminalWsGateway` and is
injected into the standalone terminals panel HTML as `data-terminal-token` (CSP-legal body
data-attribute, parity with `TaskViewerProvider.ts:4154`), so `terminals.js` appends `&token=` to
the `/ws/terminal` upgrade. The RCE gate stays mandatory; the HTTP token becomes optional. This is
faithful to the plan's thesis ("each surface has exactly one control, chosen for the threat"): the
HTTP surface's control is the OS file-permission boundary (single-user loopback); the terminal
surface's control is its own credential (RCE consequence warrants defense-in-depth beyond the Host
allowlist alone).

Change 2 renamed the `_checkAuth` branch comment from "Extension path" to the local-trust path and
states both boundaries (loopback peer OR tailnet listener); the stale NOTE above `_sendUnauthorized`
was rewritten (both hosts now share the posture). Change 3 added a credential-independence note to
Guard 3 (Host allowlist is gated on `serveStatic`, not auth — already true, now documented so a
reader does not assume the token covers the browser case). Change 6 corrected the agent-tunnel
section of `docs/REMOTE_ACCESS.md`: the `token rotate` advice is now opt-in, and the false claim
"without one the server mints a fresh secret per launch" was replaced with the loopback-trust
behavior. The tailnet section (lines 71-78) was not touched, per the plan's explicit instruction.
Change 5 is a record only — the sibling plans already self-retired; no edit to them was required.


## Review Findings

The goal is achieved: `bootstrap.ts:586` resolves `resolvedToken` to `''` when no durable `switchboard.apiToken` is stored, the unconditional `crypto.randomBytes(32)` HTTP-session mint is gone, and `_checkAuth`'s local-trust branch is now reachable on standalone loopback while `token set`/`token rotate`/`secrets set apiToken` still enforce a credential when set. The out-of-plan `terminalSessionToken` separation is correct and load-bearing — verified that `TerminalWsGateway.handleUpgrade` passes `rejectWhenTokenEmpty: true` (`terminalWsGateway.ts:956`), that `terminals.js:10171` reads `document.body.dataset.terminalToken` and appends `&token=`, that every terminals-panel render flows through `getPanelHtml` (`LocalApiServer._handleServePanelById`) with `Cache-Control: no-store`, and that the loopback listener is hardcoded to `127.0.0.1` (`LocalApiServer.ts:920`) so the comment's "loopback peer OR tailnet listener" claim holds. No code fix was required for this plan; no destination or goal was changed. Verification: `tsc -p tsconfig.test.json` clean (after fixing three pre-existing HEAD compile breakages listed below), `eslint` 0 errors, and `terminal-token-transport`, `secrets-bridge`, `loopback-hostname`, `tailscale-bind`, `panel-runtime-surface`, `shim-injection`, `terminal-solo-popout`, `browser-panel-verb-routing`, `pty-route-surface` all green. Three build-breaking defects committed at HEAD by *other* work blocked all verification and were fixed forward: `PlanIngestionEngine.ts:1134` (`_applyFeatureLink`'s outer `try` lost its `catch` in commit `0b124e0c`, TS1472), `LocalApiServer.ts:449` (`onWorkingStateCleared` declared 2 params, called with 3), and `bootstrap.ts:2259` (`const records` reassigned at `:2328`).

## Deferred Findings

- MAJOR — none of the plan's five Goal Invariants has an automated guard; nothing asserts `getAuthToken()` resolves to `''` with no durable token, nothing asserts the HTTP token and the terminal WS token are separate values. The next pass that "simplifies" them back into one variable re-breaks every `/ws/terminal` upgrade with all gates green. `src/standalone/bootstrap.ts:548`
- NIT — `headlessPanelHtml.ts:97` still documents `data-terminal-token` as "TaskViewerProvider's"; the standalone host now injects it too. `src/services/headlessPanelHtml.ts:97`
- NIT — with no durable token, `PtyFleetService` no longer sets `SWITCHBOARD_API_TOKEN` in the pty environment, so the shipped recipes that emit `Authorization: Bearer $SWITCHBOARD_API_TOKEN` unconditionally now send an empty bearer. Harmless (`_checkAuth` returns true on the empty-`expected` branch before reading the header), but the recipes now read as if they carry a credential. `src/standalone/ptyFleetService.ts:378`
- NIT — the `switchboard local` startup banner still prints `Board URL (one-time token): …?token=…` when no durable token is configured, a credential that now grants nothing over plain loopback trust. Cosmetic; the empty `sb_session` emission it feeds is owned by `browser-board-csrf-cross-site-rejection.md`. `src/standalone/cli.ts:1498`
- PRE-EXISTING (not this plan) — `src/test/terminal-plan-attribution-contract.test.js:418` has a syntax error committed at `25fdb6d9`; the CI-wired suite cannot load at all. `src/test/terminal-plan-attribution-contract.test.js:418`
- PRE-EXISTING (not this plan) — `npm run mirror:check` is red on content drift in `.claude/skills/switchboard-remote/SKILL.md`, and `claude-protocol-block` is red on packaged-`AGENTS.md` drift. Neither plan touches `.agents/`. `.claude/skills/switchboard-remote/SKILL.md:1`
