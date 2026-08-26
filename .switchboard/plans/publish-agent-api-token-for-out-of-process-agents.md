# Out-of-process agents cannot authenticate to the standalone API — publish a separate agent token as a 0600 discovery file

## Goal

Give any process that can read a Switchboard workspace a credential it can present to the local API, by minting a **separate agent token** at boot and publishing it to `.switchboard/api-server-token.txt` with `0600` permissions, alongside the existing port file. The publisher seam is wired in **both** composition roots. `_checkAuth` accepts the agent token as a second valid credential.

### Problem Analysis

Under `npx switchboard`, an agent running in a process the host did not spawn cannot call the local API at all. Every request 401s, and nothing on disk lets it do better.

The token exists only in memory. `bootstrap.ts:534` resolves `resolvedToken` once at boot — either the durable `switchboard.apiToken` from the secret store or a per-launch random value — and hands it to exactly two consumers:

- `getAuthToken: async () => resolvedToken` (`src/standalone/bootstrap.ts:2764`), the server's own comparison value.
- `PtyFleetService`, which injects it as `SWITCHBOARD_API_TOKEN` into the environment of shells **the host itself spawns** (`src/standalone/ptyFleetService.ts:373`).

The only thing written to disk is the port: `.switchboard/api-server-port.txt` (`src/standalone/bootstrap.ts:3138`). So the discovery contract is half-built — an agent can find *where* the server is and has no way to find *who it may claim to be*.

The set of agents this excludes is most of them: a Claude Code CLI session the user started in an ordinary terminal, a cloud or remote session, an MCP server, a `git` hook, a plain `curl`, any script run outside the pty fleet, and any child of a child (the env var does not survive an intermediate process that scrubs its environment). Only a direct pty-fleet child is served.

Under the extension host the same agents work fine, because `getAuthToken()` there resolves to `''` and `_checkAuth` short-circuits to loopback trust (`src/services/LocalApiServer.ts:883`). So this is a standalone-only failure, invisible to every gate, and it silently disables the whole orchestration surface — dispatch, queue-done, card moves, feature grouping — for exactly the host that has no VS Code UI to fall back on.

### Root Cause

The standalone token was designed as a **browser-session credential** — it backs the `sb_session` cookie, is exchanged via a one-time URL token, and has an 8-hour cookie lifetime (`src/services/LocalApiServer.ts:1101-1110`). Agents were never a considered caller; they inherited a gate built for a different threat model (a hostile web page reaching the board) and got no door of their own.

That framing also explains why the fix is a *second* credential rather than publishing the existing one: the two protect against different things, so they should have different values, different lifetimes, and different blast radii.

### Non-goals

- **Giving the extension host a real token.** Explicitly out of scope. Its publisher seam is wired but writes nothing while `getAuthToken()` is empty, so extension behavior is unchanged.
- **CSRF hardening of the browser board.** Separate plan (`browser-board-csrf-cross-site-rejection.md`), independent of this one.
- **Teaching the shipped clients to send the header.** Separate plan (`switchboard-clients-send-api-auth-header.md`). This plan publishes the credential; nothing consumes it yet.
- **Migrations.** The standalone host and the token mechanism are unreleased dev work. Clean break, no compat shim, no legacy-file import.

## Metadata

**Complexity:** 5
**Tags:** auth, security, backend, api, reliability, devops

## Proposed Changes

1. **Mint an agent token at boot in `bootstrap.ts`**, next to the existing `resolvedToken` resolution (`src/standalone/bootstrap.ts:518-540`). `crypto.randomBytes(32).toString('hex')`, per-launch, always ephemeral — deliberately **not** sourced from the secret store. A durable agent token would be a standing credential on disk across reboots for no benefit; a fresh one each launch bounds a leak to the life of the process.

2. **Add `getAgentToken` to `LocalApiServerOptions`** (`src/services/LocalApiServer.ts:137`, beside `getAuthToken`), typed `(() => Promise<string>) | undefined` so a host that publishes no agent token simply omits it.

3. **Accept the agent token in `_checkAuth`** (`src/services/LocalApiServer.ts:881-912`). After the existing bearer comparison fails, compare against the agent token using the **same constant-time loop** already used there — length check, then XOR accumulate. Do not introduce `===`. An absent or empty agent token must never widen the gate: guard with a non-empty check before comparing, mirroring the fail-closed trim that `bootstrap.ts:530-534` applies to the durable token.

4. **Do not accept the agent token via the `sb_session` cookie.** Bearer header only. The cookie is the browser's channel; keeping the two credentials on separate channels is the whole point of having two.

5. **Add a `publishAgentToken` seam and wire it in BOTH composition roots.** This is the part the CLAUDE.md precedent says will be got wrong, so the two roots must be diffed by hand — and note the port-file writers are already *shaped differently*, which is the trap:
   - **Standalone** (`src/standalone/bootstrap.ts:3137-3139`) writes one file to a single `switchboardDir` with `fs.writeFileSync`, no atomic rename.
   - **Extension** (`src/services/TaskViewerProvider.ts:4258-4276`) writes to **every eligible root** returned by `_filterPortFileEligibleRoots`, atomically via tmp-file + rename, and never `mkdir`s a `.switchboard/` marker that does not already exist.

   The agent-token publisher must follow each host's existing shape rather than imposing one, and must preserve the never-create rule. In the extension the publisher is wired but is a **no-op while `getAuthToken()` is empty** — it must not write a file containing an empty string.

6. **Write the file with `0600`, atomically.** `fs.writeFileSync(tmp, token, { mode: 0o600 })` then rename, so the file is never briefly world-readable. On Windows the mode is advisory; note that in a comment rather than pretending otherwise.

7. **Tie the file's lifecycle to the port file's, at every exit path.** Standalone: alongside `portFile`/`pidFile` in the `instance.stop()` teardown (`src/standalone/bootstrap.ts:3220`) and in `syncUnlinkPortFile` (`:3226`), which is the signal-handler path. Extension: alongside the port-file unlink in the stop path (`src/services/TaskViewerProvider.ts:4348-4358`). **A stale token file outlasting its server is the failure mode to design against** — a client would present a dead credential and get a 401 it cannot distinguish from a missing one.

8. **Add the token file to the worktree-cleanup `safeFiles` list** (`src/services/TaskViewerProvider.ts:4519`). It is auto-generated per-server and must be deleted, not carried into a seeded worktree — a copied token file is a credential for a server the worktree is not talking to.

9. **Confirm the gitignore already covers it and add an explicit line anyway.** `.gitignore:60` is `.switchboard/*` with an un-ignore allowlist that does not include this file, so it is ignored today. Add a named entry beside the `secrets.enc*` / `.master-key*` block at `.gitignore:85-86` — those are named explicitly rather than relying on the glob precisely because they are secrets, and this is one.

10. **Hand the agent token — not the session token — to pty children.** Change `PtyFleetService`'s `apiToken` (`src/standalone/ptyFleetService.ts:373`) to receive the agent token. Fleet terminals *are* agents; giving them the browser session credential was always over-granting. After this change every agent, spawned or not, presents the same class of credential, which collapses two code paths into one.

11. **Add `switchboard token agent` to the CLI** (`src/standalone/cli.ts:24-27`, beside `token show|set|rotate|clear`) to print the running server's agent token, for an operator wiring up a tool by hand. Read it from the file rather than the secret store — the file is the source of truth for this credential.

12. **Confirm the health payload does not leak it.** `/health` is unauthenticated and returns `{service, status, port, pid, roots}`. Re-read the handler (`src/services/LocalApiServer.ts:7320+`) and assert by test that no token field is ever added.

## Edge-Case & Dependency Audit

- **A blank agent token must fail closed, never open.** `_checkAuth` already treats an empty *expected* token as allow-everything. If `getAgentToken` returned `''` and the comparison were written naively, a caller sending `Authorization: Bearer ` could match. Guard with an explicit non-empty check before the comparison, and cover it with a test — this is the single most dangerous line in the plan.
- **Constant-time comparison, no early return on length.** The existing loop compares lengths first and returns false — acceptable, since token length is not secret — then XOR-accumulates. Copy that shape exactly; do not "simplify" to `===`.
- **The extension writes to multiple roots.** Every one needs `0600` and every one needs unlinking. A partial write must not abort the loop: warn per-root and continue, matching the port-file writer's existing `catch (writeErr)` behavior at `TaskViewerProvider.ts:4272-4275`.
- **The watchdog checks port-file existence, not token-file existence** (`src/services/TaskViewerProvider.ts:4315-4323`). Do not add the token file to that predicate — in the extension it is legitimately absent, and a watchdog that restarts a healthy server every interval forever is the exact bug the existing comment there warns about.
- **The token file must not ride along in a transfer bundle.** Verified safe: `TransferBundleService` exports only `.switchboard/plans` and `.switchboard/features` (`src/services/TransferBundleService.ts:516-517`). Re-assert with a test so a future widening of the export cannot silently start shipping a credential.
- **Two servers, one workspace — guarded in one direction only.** Port contention itself cannot happen: standalone probes `isPortFree` before booting and falls back to ephemeral (`src/standalone/cli.ts:1358-1362`), and `findRunningInstance` (`cli.ts:323-330`) makes standalone *refuse to start* when any healthy server already answers on the root's port file — `cli.ts:1234-1239`, "Reusing is not supported (single writer)". That covers standalone-after-standalone and standalone-after-extension alike.

  The reverse is unguarded. The extension's pre-start check is `suppressLocalApiServer || globalThis.__SWITCHBOARD_STANDALONE_WORKSPACE_ROOT` (`src/services/TaskViewerProvider.ts:3198-3202`), and **both flags are in-process only** — set by `src/standalone/bootstrap.ts:1023` and `src/standalone/vscodeShim.ts:456` respectively, inside the standalone process. They exist to stop standalone starting a second server *within itself*. A separate VS Code process sees neither, calls nothing equivalent to `findRunningInstance`, and so starts its own server and overwrites `api-server-port.txt` in every eligible root — repeatedly, since the liveness watchdog re-enters `_startLocalApiServer` on each failed health check.

  The consequence is far worse than a clobbered discovery file. The board is a **sql.js whole-file image** — `export()` then `fs.renameSync` over the entire DB path (`src/services/KanbanDatabase.ts:1807-1811`) — so two live hosts each hold a private copy and the last flush silently destroys every change the other made. That is addressed by **`enforce-single-writer-lock-on-the-kanban-database.md`**, which is a prerequisite for trusting any of this work in a two-process situation; do not attempt it here.

  What this plan owes that one: publishing a token file adds a second per-server file to the same ownership question, so it must follow the port file's lifecycle exactly and never outlive its server. And **the token and port must be read as a pair from the same root in a single pass**, so a client cannot combine a fresh port with a stale token — specified in the client plan.
- **A reused durable session token plus a fresh agent token per launch is intentional.** The board survives a restart (durable session token); agent credentials do not (fresh agent token). Clients must therefore re-read the file rather than caching it for the process lifetime — state this in the file's own header comment, since that is where a client author will look.

## Dependencies

None. Ships independently, though it delivers no user-visible fix until the client plan lands.

## Verification Plan

1. `npm run compile` — 0 errors.
2. New contract test `src/test/agent-token-publication-contract.test.js`, covering:
   - `_checkAuth` accepts the agent token as a bearer credential;
   - `_checkAuth` accepts the session token as before (no regression);
   - an **empty** agent token grants nothing — `Authorization: Bearer ` is rejected;
   - the agent token is **not** accepted via the `sb_session` cookie;
   - `/health` contains no token field;
   - the transfer-bundle export excludes the token file.
3. `npx switchboard` in a scratch workspace. Assert: `.switchboard/api-server-token.txt` exists; `stat -c '%a'` reports `600`; the contents are 64 hex chars and differ from the boot URL's `?token=` value.
4. From a **plain terminal outside the pty fleet** — the case this plan exists for:
   `curl -s -H "Authorization: Bearer $(cat .switchboard/api-server-token.txt)" http://127.0.0.1:$(cat .switchboard/api-server-port.txt)/kanban/board` must return the board. Without the header it must 401.
5. Kill the server with `SIGTERM`; both the port file and the token file must be gone. Repeat with `SIGHUP` and with a clean `switchboard stop`, since `syncUnlinkPortFile` is a distinct path from `instance.stop()`.
6. `switchboard token agent` prints the same value the file holds.
7. Spawn a terminal from the standalone board, run `echo $SWITCHBOARD_API_TOKEN` inside it, and confirm it now prints the **agent** token, not the session token.
8. **Extension no-op check.** Run the extension host with no standalone server. Assert no `api-server-token.txt` is created in any root, the port file is still written to all eligible roots, and the board and every existing skill call behave exactly as before.
9. Seed an orchestration worktree and confirm no token file is present in it.
10. `npm run standalone-parity:check` plus a **hand diff of the two composition roots**, confirming the publisher seam is wired in both. The parity script is scoped to the browser read-back path and will not catch a missing seam — the hand diff is the real gate, per CLAUDE.md.

## Outstanding Questions

- Should the agent token also be accepted on the WebSocket upgrade path (`src/services/wsUpgradeAuth.ts:64-80`)? Not needed for the HTTP orchestration surface, but an agent wanting live board events would need it. Deferred until a caller actually wants it.
