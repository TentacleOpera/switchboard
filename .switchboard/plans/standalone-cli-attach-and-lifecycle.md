---
description: "Standalone CLI, server side: stop exiting 1 when a server is already running and attach to it instead; give an attaching process a way to mint a browser session (the one-time token is single-use and the auth token is in-memory only); and give a server that outlives its terminal a way to be stopped — pid file, `switchboard stop`, SIGHUP teardown. Prerequisite for the agent entry protocol, which detaches the launched server and therefore cannot ship without a stop path. Does NOT touch the /switchboard skill, the launcher resolution script, or npm publishing."
---

# Standalone CLI: attach to a running server, and give a detached server a way to die

## Goal

Make `switchboard` **attach** to a Switchboard server that is already running for a workspace instead of hard-exiting 1, make that attach able to hand the user an authenticated board (which today it cannot), and give a server a recorded PID plus an explicit `switchboard stop` and a clean SIGHUP teardown.

These three are one unit because they fail together. Attaching without a way to mint a session opens a tab that 401s — worse than the current honest refusal. And the sibling entry-protocol plan **detaches** the launched server, so shipping attach without a stop path leaves a board nothing can shut down except `lsof -i` and a manual kill.

### Problem / root-cause analysis

#### Root cause 1 — the CLI refuses to attach, and a stale comment says it does

`src/standalone/cli.ts:206-211`:

```ts
const existing = await findRunningInstance(workspaceRoot);
if (existing !== null) {
    console.error(`[switchboard] Another Switchboard instance is already running on port ${existing} for ${workspaceRoot}.`);
    console.error(`[switchboard] Reusing is not supported (single writer). Use that instance or shut it down.`);
    process.exit(1);
}
```

`findRunningInstance` (`cli.ts:110-117`) already does the right discovery — reads `.switchboard/api-server-port.txt`, guards `NaN`, then `probeHealth` (`cli.ts:93-108`) confirms `status === 'ok' && json.port === port`. It correctly identifies a live server. Then the caller throws that away and exits 1.

Meanwhile `src/services/TaskViewerProvider.ts:2183-2190` documents the opposite behaviour as though it shipped:

```
// serve the shell + panel HTML from the extension's LocalApiServer so that
// `npx switchboard` (which detects the running extension via
// api-server-port.txt and opens a browser to this port) gets the
// full shell + panel HTML + verb dispatch in one server.
```

Attach-and-open-a-browser was the design intent, the extension-side half of it was built (the extension serves the full shell), and the CLI-side half is an `exit 1`. The single-writer rule is real and must be preserved — but "do not start a second writer" and "refuse to help the user" are different requirements, and the code conflates them. **Attaching starts no writer at all.**

#### Root cause 2 — attach cannot mint a browser session, and this is the hard part

The two hosts differ, and both were verified at HEAD:

- **Standalone** mints exactly **one** token at boot. `bootstrap.ts:304` generates `oneTimeToken`; `bootstrap.ts:306` holds `let oneTimeConsumed = false`; the `consumeOneTimeToken` callback (`bootstrap.ts:1436-1440`) is `if (oneTimeConsumed || t !== oneTimeToken) return false; oneTimeConsumed = true; return true;`. There is no minting endpoint. So once the original launch's browser consumed it, a newly attaching process has no way to authorise a browser at all. A tab opened against that server gets the 401 at `LocalApiServer.ts:566-571`.
- **Extension** already has exactly the mechanism the standalone lacks: `TaskViewerProvider.ts:2506` holds `private _browserTokens = new Map<string, number>()`, `:2507-2512` is `mintBrowserToken()` (24 random bytes, 5-minute TTL), `:2514-2520` is `consumeBrowserToken()`, and `:2192` wires it as the server's `consumeOneTimeToken`. `extension.ts:1188` calls `mintBrowserToken()` for the open-in-browser button. But **no HTTP route reaches `mintBrowserToken`** — it is only callable in-process, so a separate CLI process cannot ask for one.

So attach-and-open only works by accident today: it works if the *same* browser still holds a valid `sb_session` cookie from the original launch, and fails in a different browser, a private window, or after a cookie clear.

**The credential problem, stated exactly.** `LocalApiServer._checkAuth` (`:527-557`) accepts either `Authorization: Bearer <expected>` or the `sb_session` cookie, where `expected = await this._options.getAuthToken()`. And the one-time-token exchange (`LocalApiServer.ts:602-614`, mirrored at `:660` and `:714`) sets `Set-Cookie: sb_session=${expected}`. **So the session cookie's value *is* the auth token** — the one-time token is purely a handoff device for getting that secret into the browser as an HttpOnly cookie.

Standalone's `getAuthToken()` returns `sessionToken` (`bootstrap.ts:305`, wired at `:1365`) — 32 random bytes generated per-process and held **only in memory**, never written to disk. So an attaching process has no credential to present, and gating a mint endpoint on either the cookie or the bearer token is the same circle: both are the one secret the attaching process cannot reach.

**The trust boundary therefore has to move to the filesystem.** The running standalone server writes its auth token to `.switchboard/api-server-token.txt` with mode `0600`; the attaching process reads it and presents it as `Authorization: Bearer`. This is the Jupyter-token / Docker-socket pattern — "a process running as this user, able to read this workspace" becomes the authorisation, which is coherent because such a process can already read `kanban.db`, every plan file, and the secrets store.

> **Superseded:** "The mint endpoint cannot be gated on the existing credential, and this is the crux… gating it on the auth token is *equally* circular, because that token is the same unreachable in-memory secret. Either gate leaves attach unable to authenticate at all." — followed by a proposal to write a separate *mint credential* to disk and build a new gate around it.
> **Reason:** the circularity is a property of the token being in-memory, not of the token itself. The moment the plan writes it to `.switchboard/api-server-token.txt` — which it does — the bearer gate stops being circular and becomes the correct gate. Introducing a *second*, mint-only credential adds a key, a lifetime, a write site and a revocation story for no security gain: anyone who can read a `0600` file in `.switchboard/` can read every other file there too, so a scoped mint key protects nothing a full token would not.
> **Replaced with:** write the **existing** `sessionToken` to `.switchboard/api-server-token.txt` (`0600`) and gate `POST /session/token` with the **existing** `_checkAuth(req, true)`. No new credential, no new gate — one new file and one new route.

**The extension host needs no token file, and this must be stated rather than left ambiguous.** Its `getAuthToken()` (`TaskViewerProvider.ts:1978-1981`) reads `switchboard.apiToken` from SecretStorage, which is empty unless a user set it and has no setter UI — so `_checkAuth`'s `if (!expected) { return true; }` (`LocalApiServer.ts:529-530`) makes the extension **pure localhost-trust today, on every route**. Adding `POST /session/token` there therefore adds no new exposure: it is one more unauthenticated localhost route on a server where all of them already are. Attaching to an extension needs no credential; the route simply forwards to the existing `mintBrowserToken()`.

#### Root cause 3 — a detached server has no PID, no stop path, and leaks on SIGHUP

The teardown already exists and is thorough. `bootstrap.ts:1479-1491`'s `stop()` disposes the terminal WS gateway, `ptyFleetService.disposeAll()`, the ingestion engine and all four providers, stops the server, and unlinks the port file. `cli.ts:241-248` wires it to SIGINT and SIGTERM. Nothing exposes it to a *different* process, which is what detaching requires. Three gaps, all small:

- **No PID is recorded anywhere.** Verified: no pid file is written in `src/`. Without one, "stop the server" degrades to `lsof -i :<port>`.
- **No way in.** There is no `stop` subcommand and no shutdown endpoint.
- **SIGHUP is not trapped.** Verified: no `SIGHUP` handler anywhere in `src/`. Closing the launching terminal today kills the process via Node's default SIGHUP behaviour **without** running `stop()` — leaving a stale port file and potentially orphaned PTY children. Worth fixing regardless of this plan: it makes closing a window as clean as Ctrl-C.

There is also a **fourth site nothing in the original analysis noticed**: `TaskViewerProvider._validateNoSwitchboardPollution` (`:2621`) cleans stray `.switchboard/` dirs in mapped child folders using an allowlist, `const safeFiles = ['api-server-port.txt', 'workspace-id'];`. Any new discovery file must be added there, or a pollution cleanup deletes the port file and leaves a **stale token file for a dead server** behind — the worst of the three to orphan.

## Metadata
- **Project:** Browser Switchboard
- **Feature:** b0f1f2cd-8591-4021-8b5f-51e5b6bcbb1f
- **Tags:** cli, security, reliability, api
- **Complexity:** 6

## User Review Required (decisions, with defaults)

1. **What does attach do — open a browser, or just report the port?** Default (**decided by the user, 2026-08-04**): **open the browser, exactly as launch does.** The human contract is "type the command, leave the terminal running, get a board" — and it must not silently change depending on whether a server happened to already be up. So `--no-open` stays the single opt-out for **both** paths, and a caller that does not want a tab (an agent) passes `--no-open` explicitly rather than the CLI defaulting to closed. Attach also opens no browser when it cannot mint a session — it says why instead of opening a tab that 401s.

   > **Superseded:** Default was "report the port and URL on stdout, and open a browser only when `--open` is passed", on the reasoning that the agent case is primary and an agent does not want a tab.
   > **Reason:** that optimises the agent path at the cost of the human one, and makes the same typed command behave differently depending on invisible state. The agent path can ask for `--no-open`; the human should not have to ask for the board.

2. **Is a `0600` token file on disk acceptable?** Default: **yes.** It is the auth token, so anyone who can read it has full API access to that server — but the threat model is a local user account that can already read `kanban.db`, every plan file, and the secrets store in the same directory. The alternative (attach cannot authenticate, so it prints a URL and hopes the browser still has a cookie) is the status quo this plan exists to fix. Flagging because it is a genuine posture change: a secret that was memory-only becomes a file.

3. **Should `stop` be a subcommand or an HTTP endpoint?** Default: **subcommand.** An HTTP kill switch on a loopback server is reachable by any local process and by any page the browser loads, and the session-cookie gate is not a defence worth relying on for "terminate the process". If a `POST /shutdown` is wanted later it must be API-token gated, not session-cookie gated.

## Scope

### ✅ IN SCOPE
- Attach semantics in `src/standalone/cli.ts` `main()`.
- `POST /session/token` on both hosts, plus the standalone token-file write.
- Standalone's single-shot `oneTimeConsumed` boolean → a TTL'd map mirroring the extension's `_browserTokens`.
- `.switchboard/api-server-pid.txt` and `.switchboard/api-server-token.txt` as part of one atomic discovery-file set with the existing port file.
- `switchboard stop [--workspace <path>]`.
- SIGHUP parity with SIGINT/SIGTERM.
- Fixing the stale comment at `TaskViewerProvider.ts:2183-2190`.

### ⚙️ OUT OF SCOPE
- The `/switchboard` skill/workflow protocol, the launcher-resolution script, version-skew guarding — `standalone-first-launch-instead-of-demanding-an-ide.md`.
- Package renaming and npm publishing — `b4-npx-distribution-publish.md`.
- Removing the single-writer constraint or allowing two servers per workspace.
- Making the extension defer to a running standalone (the reverse direction).
- Auto-stopping the server on idle, on workspace close, or after N minutes. A launched server outlives its session **deliberately** — that is what makes a second invocation an attach — so shutdown stays explicit.
- A `POST /shutdown` HTTP endpoint (see decision 3).

## Proposed Changes

### 1. Attach instead of exiting — `src/standalone/cli.ts`

Replace the `exit 1` at `:206-211` with an attach path:

- Keep `findRunningInstance` (`:110-117`) unchanged — it already health-probes.
- On a hit: print the port, the board URL (built with the same `resolveHostname` used for launch), and which host answered. Determine host kind from `/health` rather than guessing — its current body (`LocalApiServer.ts:3363-3379`) is `{ status, port, roots, [terminals, terminalCount], [selectedWorkspaceRoot] }`, all named fields, so **adding an explicit `host: 'extension' | 'standalone'` field is safe and additive**; do that rather than infer from the presence of `terminals`. Exit **0**.
- **Start no server on this path.** The single-writer invariant is preserved by construction, and the message should say attaching rather than the current "Reusing is not supported".
- On a miss: launch exactly as today (`:213+`).
- **Stale port file:** if the file exists but `/health` fails, treat it as a miss and launch. Do not delete the file first — `bootstrap.ts:1462` overwrites it on successful bind, so cleanup is implicit, and unlinking it early would lose the diagnostic if the launch itself fails.
- Mint a session (change 2), build the board URL with the fresh token, and open it — unless `--no-open`. If minting is unavailable (older server, route absent), **print the URL and say the browser may need a session** rather than opening a tab that 401s. A confusing failure is worse than an honest message.

Fix the stale comment at `TaskViewerProvider.ts:2183-2190` in the same change so it describes what the code now does.

- **Edge cases:** the `secrets` subcommands return early at `cli.ts:161-203`, *before* the attach block — that ordering must survive, and `test:contract:secrets-bridge` is the guard. `parseArgs` ignores unknown tokens, so `switchboard stop` reaching `main()` must be dispatched before the workspace-existence check, alongside `secrets`.

### 2. A session-mint route on both hosts — `LocalApiServer.ts`, `bootstrap.ts`, `TaskViewerProvider.ts`

- **Route:** `POST /session/token` → `{ token: string }`. Gate it with the **existing** `_checkAuth(req, true)`. No new auth mechanism.
- **Standalone:** replace `let oneTimeConsumed = false` (`bootstrap.ts:306`) with a `Map<string, number>` of token → expiry, mirroring `TaskViewerProvider._browserTokens` (`:2506`) rather than inventing a second model. `consumeOneTimeToken` (`bootstrap.ts:1436-1440`) becomes a lookup-delete-and-check-expiry, identical in shape to `consumeBrowserToken` (`:2514-2520`). The boot token becomes the first entry in that map instead of a special case. Prefer **extracting the mint/consume pair into one shared module both hosts import** over copying twenty lines — two divergent TTL implementations for one concept is exactly the anti-divergence failure the PRD's contract #1 names.
- **Standalone token file:** write `sessionToken` to `.switchboard/api-server-token.txt` with `{ mode: 0o600 }` from the same place as the port file (`bootstrap.ts:1461-1463`), and unlink it in `stop()` (`:1490`) beside the port-file unlink.
- **Extension:** wire the route to the existing `mintBrowserToken()` (`TaskViewerProvider.ts:2507`). Write **no** token file — there is no token to write, `_checkAuth` returns true for every request there already (`LocalApiServer.ts:529-530`), and inventing one would be a behaviour change on ~4,000 shipped installs for no gain (PRD contract #2).
- **Edge cases:** the mint route must be `POST`, not `GET` — a `GET` is reachable by an `<img src>` on any page the user's browser loads. `SameSite=Strict` protects the cookie and CORS prevents a cross-origin page from *reading* the response, but a drive-by `GET` that burns tokens is still avoidable for free. Cap the TTL map's size or sweep expired entries on write, so a process that is minted-at repeatedly does not grow without bound.

### 3. Lifecycle — pid file, `stop`, SIGHUP — `src/standalone/cli.ts`, `src/standalone/bootstrap.ts`

- **PID file.** Write `.switchboard/api-server-pid.txt` alongside the port file, from the same place (`bootstrap.ts:1461-1463`), and unlink it in `stop()` next to the port-file unlink. Treat the three discovery files — `api-server-port.txt`, `api-server-pid.txt`, `api-server-token.txt` — as **one atomic set**: written together at bind, unlinked together in `stop()`. A surviving token file for a dead server is the worst of the three to leave behind.
- **Add them to the pollution-cleanup allowlist.** `TaskViewerProvider._validateNoSwitchboardPollution`'s `safeFiles = ['api-server-port.txt', 'workspace-id']` (`:2621`) must gain both new names, or cleanup deletes the port file and orphans a token file pointing at a dead server.
- **`switchboard stop [--workspace <path>]`.** A subcommand next to the existing `secrets` ones (`cli.ts:161-203`): read the pid + port files, **health-probe to confirm it is really ours**, send SIGTERM, wait for the port to stop answering, then report. Preferred over an HTTP endpoint per decision 3.
- **SIGHUP.** Add it to the `process.on` list at `cli.ts:247-248`. Assert the handler is idempotent — a second signal arriving mid-teardown must not double-dispose the PTY fleet.
- **Edge cases:** **PID recycling is the dangerous one.** A stale pid file whose PID has been reused by an unrelated process must not be signalled. The health probe is the discriminator: stop only when the recorded port answers `/health` *and* reports this workspace root in `roots`; otherwise refuse, say why, and clean the stale files. `SIGKILL` remains untrappable by definition — the stale-port-file path in change 1 is what makes that survivable.

### 4. Tests

- `findRunningInstance` returns the port on a healthy server, `null` on a stale port file, `null` on a malformed one (`cli.ts:113-115` already guards `NaN` — assert it).
- Attach path: with a stub server answering `/health`, `main()` exits 0, prints the port, and **starts no listener**. Assert *no second bind* — that is the invariant.
- Session mint: `POST /session/token` on a standalone server returns a fresh token that `consumeOneTimeToken` accepts exactly once; a second consume fails; an expired one fails. Assert the boot token and a minted token behave identically (no special-casing survived the refactor).
- Mint auth: unauthenticated `POST /session/token` against a standalone server (which has a real `getAuthToken()`) is rejected; the same call with `Authorization: Bearer <contents of api-server-token.txt>` succeeds. Against a token-less extension-shaped server it succeeds without a header — asserting the documented localhost-trust behaviour deliberately, so a future token-setter does not silently change it unnoticed.
- Token file permissions: `api-server-token.txt` is created `0600`.
- Discovery-file atomicity: after `stop()`, none of the three files exists. After a bind, all three do.
- Signal parity: SIGINT, SIGTERM **and SIGHUP** each run `stop()` exactly once and leave no discovery file behind.
- `switchboard stop`: stops a live server for the named workspace; is a no-op with a clear message when nothing is running; **refuses** when the pid file's PID exists but the port does not answer `/health` as this workspace's server (PID recycling), rather than signalling a stranger.
- Byte-compat guard: the extension's existing `consumeOneTimeToken` → `consumeBrowserToken` wiring (`TaskViewerProvider.ts:2192`) still behaves identically for the open-in-browser button after the shared-module extraction.

## Complexity Audit

### Routine
- Adding `SIGHUP` to an existing `process.on` list.
- Writing and unlinking two more files beside an existing one.
- Adding two strings to the `safeFiles` allowlist.
- Replacing an `exit 1` with a print-and-exit-0.

### Complex / Risky
- **Writing an auth token to disk.** A memory-only secret becomes a file. `0600` and a `.switchboard/`-local path make it coherent with what already lives there, but it is a real posture change and the mode must be set at creation (not chmod'd after), or there is a window where it is world-readable.
- **Refactoring the one-time token model on a shipped host.** The extension's `_browserTokens`/`mintBrowserToken`/`consumeBrowserToken` trio is live on ~4,000 installs and drives the open-in-browser button. Extracting it into a shared module must be behaviour-preserving (PRD contract #2).
- **PID recycling.** A naive pid-file implementation SIGTERMs an unrelated process. The health probe must gate the signal, not merely inform it.
- **Three-file atomicity across every exit path.** SIGINT, SIGTERM, SIGHUP, a `stop()` from a library caller, an uncaught throw, and SIGKILL all have to leave a consistent-or-recoverable state. Only SIGKILL is allowed to leave all three, and change 1's stale-file tolerance is what makes that survivable.
- **A new unauthenticated route on the extension host.** It is unauthenticated because every route there is, which is defensible — but it must be *stated* and tested as a deliberate choice, not discovered later as an oversight.

## Edge-Case & Dependency Audit
- **Race Conditions:** the genuine one is **launching while the extension is still starting** — the port file is not yet written, so the probe misses and the CLI launches a second writer. No bind lock exists anywhere in `src/` (verified by grep). Unresolved; see Uncertain Assumptions. A narrower race: two `stop` invocations arriving together, mitigated by the idempotence assertion.
- **Security:** the `0600` token file (decision 2); `POST`-only minting; PID-recycling refusal; no HTTP shutdown endpoint. The extension host's localhost-trust posture is unchanged, not widened.
- **Side Effects:** attach now opens a browser tab where previously it exited 1 — intended (decision 1), but it is a behaviour change for anyone scripting against the old exit code. Attach exits **0** where it exited **1**; any script treating a running instance as an error condition inverts. Worth a line in the release note.
- **Dependencies & Conflicts:** shares `src/standalone/cli.ts` with B4 (which owns the `usage()` block this plan appends a `stop` line to) and with the entry-protocol plan. Serialise per the PRD's one-stream-per-file rule.

## Dependencies
- **`b4-npx-distribution-publish.md` — soft, ordering only.** Not a functional dependency: everything here works against the repo-local CLI. But B4 rewrites `usage()` (`cli.ts:8-30`), and this plan appends a `stop` line to it. Land B4 first so this plan writes that line in the settled format.
- **Blocks `standalone-first-launch-instead-of-demanding-an-ide.md`** — that plan detaches the launched server, which is only acceptable once `switchboard stop` and the pid file exist.
- **`extract-standalone-npx-04-npx-distribution.md`** (`CODE REVIEWED`) already shipped the launcher core — `bin` entry, boot, `/health` gate, one-time-token handoff, browser-open. Read it before implementing change 1; this plan extends that code path rather than creating a second one.
- **`Standalone init` Command** (`CREATED`) also grows the CLI's command surface. No file conflict expected — that plan adds a subcommand, this one adds a subcommand *and* changes default-command semantics in `main()` — but landing both means two edits to `cli.ts:143+`. Whichever lands second rebases.
- No session (`sess_…`) dependencies.

## Adversarial Synthesis
**Risk Summary:** Key risks: (1) attach is worthless without a session, and the session secret is in-memory only — resolved by writing the existing auth token to a `0600` `.switchboard/api-server-token.txt` and gating a new `POST /session/token` on the *existing* `_checkAuth` bearer path, rather than inventing a second credential; (2) the standalone's single-shot `oneTimeConsumed` boolean must become the extension's TTL'd map model without regressing the shipped open-in-browser button, so extract one shared implementation instead of copying it; (3) a pid file invites SIGTERM-ing a recycled PID, so `stop` must health-probe-then-signal and refuse otherwise, and all three discovery files must be written and unlinked as one set — including in `_validateNoSwitchboardPollution`'s `safeFiles` allowlist, which is easy to miss. Unresolved: the extension-still-starting bind race, for which no lock exists.

## Verification Plan

> Per session directives: no project compilation step and no automated test run is part of this verification plan. The checks below are behavioural, run against a built CLI.

1. **Reproduce.** With a server running for `$ROOT`, run the CLI again → today it prints "Reusing is not supported" and exits 1.
2. **Attach to a live standalone.** Launch standalone, run the CLI again → attaches, does not double-bind (`lsof -i` shows one listener), exits **0**, and reports `host: standalone` from `/health`.
3. **Attach to a live extension.** With VS Code/Devin running the extension, run the CLI → attaches, the port equals the extension's, **no second process** appears, and `/health` reports `host: extension`. This is the single-writer regression test.
4. **The session actually works — the case that fails today.** Attach with a server whose original launch token was already consumed, then open the printed URL in a **private window / different browser**. The board must load authenticated, proving the minted session rather than a surviving cookie.
5. **Mint is gated on standalone, open on the extension.** `curl -X POST <standalone>/session/token` with no header → 401. Same with `Authorization: Bearer $(cat .switchboard/api-server-token.txt)` → a token. Same call against the extension with no header → a token (documented localhost-trust).
6. **Token file hygiene.** `stat` the file → mode `0600`. Kill the server with SIGTERM → all three of `api-server-port.txt`, `api-server-pid.txt`, `api-server-token.txt` are gone.
7. **Stale port file.** Write a bogus port into `api-server-port.txt`, run the CLI → treats it as a miss and launches; the file ends up holding the new port.
8. **Survives the terminal, and can still be stopped.** Launch detached (or via the sibling plan's launcher once it lands), close the launching terminal window → the server keeps answering `/health`. Then `switchboard stop --workspace "$ROOT"` → the port stops answering and all three discovery files are gone. Confirm no orphaned PTY children survive (`pgrep` the agent shells the fleet spawned) — that is what proves `stop()` ran rather than the process merely dying.
9. **SIGHUP is clean now.** Launch in the *foreground*, close the terminal, confirm the teardown ran: discovery files removed, PTY children reaped. Before the change this leaves both behind — assert the before/after difference, not just the after state.
10. **Stop is honest about what it kills.** With a *different* workspace's server running, `switchboard stop --workspace <this root>` must not touch it. With a stale pid file pointing at a recycled PID, stop must health-probe first and **refuse** rather than SIGTERM an unrelated process.
11. **Pollution cleanup does not orphan a token.** Trigger `_validateNoSwitchboardPollution` against a mapped child root holding all three files → all three are removed, not just the port file.
12. `npm run lint` plus the standalone suites green, including `test:contract:secrets-bridge` — change 1 touches `main()`, through which the `secrets` subcommands return early (`cli.ts:161-203`); confirm that early return still precedes all attach and `stop` logic.

## Uncertain Assumptions

The following are external and cannot be settled by reading this repository. The user has been advised to run web research to confirm them before implementation:

- **Whether `fs.writeFileSync(path, data, { mode: 0o600 })` reliably yields `0600` across platforms and umasks**, or whether an explicit `fs.chmodSync` (with its brief world-readable window) is required — and what the equivalent guarantee is on Windows, where POSIX modes are advisory.
- **Whether a detached child survives an agent harness's process-group reaping.** Some harnesses kill the whole group on tool-call exit, which would defeat the sibling plan's detach regardless of what this one does. Verify in the specific target host before relying on it.

Code-answerable items are recorded as code-investigation TODOs rather than research: **the extension-still-starting bind race** (check whether any `.switchboard/` lock convention exists elsewhere in the repo before inventing one — a grep of `src/standalone/` and `LocalApiServer.ts` found none, so this needs a design decision, not a search engine), and **whether anything consumes `/health` positionally** before adding the `host` field (grep the webview, `.agents/`, and the skill sources).

## Recommendation
Complexity 6 → **Send to Coder.** The mechanics are small — one route, one file, one subcommand, one signal — but two of them are security-shaped: an auth token moves from memory to disk, and a pid file becomes a signalling target. Do change 2 by extracting the extension's *existing* mint/consume pair into a shared module rather than writing a second one, keep the extension's shipped open-in-browser path byte-identical, and make `stop` probe before it signals. The discriminating check is verification step 4: a minted session that authenticates a **private window**, which is precisely what fails today.

**Stage Complete:** PLAN REVIEWED
