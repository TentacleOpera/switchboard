# Auth belongs at a trust boundary, and a shell user calling their own CLI is not one

## Goal

Give each surface exactly one control, chosen for the threat it actually faces, and stop the standalone
host demanding a bearer token from callers that already have more authority than the token grants. A
shell user on the board's machine can `rm -rf` the workspace, read `kanban.db`, and kill the server;
requiring them to present a credential before moving a card guards a door inside a building they are
standing in.

### Problem Analysis

**The standalone host makes the no-token path unreachable.** `bootstrap.ts:590-603` resolves a token on
every launch — the durable `switchboard.apiToken` if one is stored, otherwise
`crypto.randomBytes(32)`. So `getAuthToken()` is never empty under `npx switchboard`, and `_checkAuth`'s
escape hatch never fires:

```js
// Extension path: no token configured => keep the historical loopback-trust behavior.
if (!expected) { return true; }
```

The comment says "Extension path" because that is the only host where it is reachable. Under standalone
**every** request is authenticated — loopback, CLI, skill script, agent alike.

**That one decision produces at least three symptoms already written up separately:**

| symptom | plan that recorded it |
| :--- | :--- |
| the skill layer 401s wholesale on standalone | `switchboard-clients-send-api-auth-header.md` — *"the entire skill layer is dead on the standalone host, and no gate reports it"* |
| an out-of-process agent has no credential to present | `publish-agent-api-token-for-out-of-process-agents.md` |
| `switchboard tailnet` still demands a token despite its own help text saying *"No token, no enrolment — tailnet membership is the control"* | (unrecorded until now) |

Each was diagnosed on its own and none named the common cause, so the fixes are additive: publish a
credential, then teach eight clients to send it. Both plans exist to make an unnecessary check
passable rather than to ask whether it should run.

**The control does not match the threat, surface by surface.**

| surface | what the caller already has | what actually bounds it |
| :--- | :--- | :--- |
| shell user on the host (CLI, skill script, local agent) | the filesystem, `kanban.db`, the server's own process | **file permissions** — the same check `rm` passes |
| browser tab | ambient authority: any page you visit can `fetch()` the port | **`Sec-Fetch-Site` / `Origin`**, plus the Host allowlist against DNS rebinding |
| device on the tailnet | tailnet membership, revocable | **the bind** — `switchboard tailnet` serves that interface only |

A token adds nothing to row 1: it is readable by the same uid that could skip the API entirely. It adds
nothing to row 3: the network boundary is the control, which is what the tailnet plan already says. And
row 2 is being closed **without** a credential — `browser-board-csrf-cross-site-rejection.md` rejects
cross-site state-changing requests *"using request metadata (`Sec-Fetch-Site` / `Origin`) rather than a
credential."*

**So on the product's own stated threat model the token has no remaining job.** That model is stated in
`publish-agent-api-token-for-out-of-process-agents.md`: *"The threat model is single-user loopback."*
The one case a shared secret still answers is a **second uid on the same machine**, which that plan
explicitly puts out of scope by choosing `0600`.

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
**Tags:** security, infrastructure, ux, reliability

## User Review Required

- **This removes a control, so it wants human review rather than an unattended coding pass.** The
  argument is that the control is redundant on a single-user machine; that is a judgement about threat
  model, and it should be made deliberately. The verification plan is written to make the claim
  falsifiable rather than assumed.
- **Confirm the threat model.** If a Switchboard board is ever expected to run on a host where another
  uid must be excluded, row 1 of the table above is wrong and the token stays mandatory. The stated
  model says otherwise; this plan takes the stated model at its word.

## Proposed Changes

1. **Stop minting a session token when none is configured.** In `bootstrap.ts`, mint only when a durable
   `switchboard.apiToken` is stored or the user asked for auth. With no token, `getAuthToken()` returns
   empty and `_checkAuth`'s existing loopback-trust branch becomes reachable on standalone — the
   extension host's behaviour, applied to the host that never had it.

2. **Make the trust explicit rather than incidental.** Rename the branch's comment: it is not "the
   extension path", it is *the local-trust path* — the request reached a socket bound to loopback or the
   tailnet interface, and both are boundaries the deployment already chose. State the two conditions in
   the code so the next reader does not re-derive them.

3. **Keep the browser's defences independent of the credential.** The CSRF metadata check and the Host
   allowlist must run regardless of whether a token is configured. Today a reader might assume the token
   covers the browser case; it does not, and after change 1 that assumption would be actively wrong.

4. **Keep the token as opt-in.** `token set` / `token rotate` / `secrets set apiToken` continue to work
   and continue to be enforced when set. Nothing removes the capability; change 1 removes the
   *automatic* mint that made it unavoidable.

5. **Retire the parts of the sibling plans this makes unnecessary, deliberately.**
   `publish-agent-api-token-for-out-of-process-agents.md` becomes needed only when a token is configured;
   `switchboard-clients-send-api-auth-header.md` keeps its 401-reporting fix (still correct and still
   valuable) and its shared discovery routine (needed for the opt-in case), but stops being the
   precondition for the skill layer working at all. Mark the superseded scope in both rather than
   leaving three plans that imply three separate problems.

6. **Correct `docs/REMOTE_ACCESS.md`.** It currently instructs the user to `token rotate` *"so the
   credential survives restarts"* — advice that exists because of the unconditional mint. After change 1
   the default path needs no credential, and the doc should say which surfaces do.

## Verification Plan

1. **A shell user needs nothing.** With no token configured, run a board command as the owning user on
   the host and assert it succeeds — no header, no file read, no environment variable. This is the case
   the plan exists for and must fail against the current standalone tree.
2. **The skill layer works on standalone.** Run the `kanban_operations` scripts and `sb_api_call.sh`
   against `npx switchboard` with no token and assert none 401s. That is the regression
   `switchboard-clients-send-api-auth-header.md` documents, reproduced from the other direction.
3. **`switchboard tailnet` needs no token.** Start it, call the API from a second tailnet device, and
   assert success with no credential — matching the help text the shipped command already prints.
4. **CSRF is still refused, with no token configured.** Simulate a cross-site state-changing request
   (`Sec-Fetch-Site: cross-site`) and assert rejection. This is the assertion that proves change 1 did
   not remove the browser's protection along with the redundant one — and it must be run with auth
   **off**, since that is the configuration the change creates.
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
