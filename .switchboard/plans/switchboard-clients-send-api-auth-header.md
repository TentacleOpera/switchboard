# No shipped Switchboard client sends an Authorization header — add shared token discovery to sb_api_call.sh and the kanban_operations scripts

## Goal

Make every in-tree client of the local API discover and present a credential, via one shared discovery routine per language (bash, Node), so the skills and scripts work identically under both hosts. A 401 must also be reported as a 401 — with the actual remedy — rather than as "the extension isn't running".

### Problem Analysis

Not one shipped client sends an `Authorization` header.

**`sb_api_call.sh`** — the helper behind every ClickUp, Linear, get-tickets and kanban skill (`.agents/skills/_lib/sb_api_call.sh`). It walks up from `$PWD` looking for `.switchboard/api-server-port.txt`, probes `/health` with bounded backoff and jitter, verifies the health JSON names the discovered root, then issues the real call at line 120:

```
HTTP_STATUS=$(curl -s -w "%{http_code}" -o "$TEMP_BODY" -X "$METHOD" "http://localhost:$PORT$PATH_NAME" "$@")
```

No auth header, and no place a caller could inject one except by passing `-H` through `"$@"` at every call site.

**The `kanban_operations/*.js` scripts** — seven of them each independently reimplement the same port lookup and `http.request` to `127.0.0.1`: `create-feature.js`, `move-card.js`, `assign-to-feature.js`, `delete-feature.js`, `reconcile-features.js`, `remove-from-feature.js`, `split-feature.js`. None sends an auth header. (`get-state.js` is the exception — it reads the DB directly and needs no change.) `move-card.js` additionally has a direct-DB fallback via `require('../../../out/services/KanbanDatabase')` at line 117, so it partially survives; the rest do not.

Under the extension host all of this works, because `getAuthToken()` is empty and `_checkAuth` short-circuits to loopback trust (`src/services/LocalApiServer.ts:883`). Under `npx switchboard` every one of these calls 401s. That is: **the entire skill layer is dead on the standalone host**, and no gate reports it.

The failure is then misreported twice over. `sb_api_call.sh` emits the same message for a missing port file, an unreachable server, and a connection failure — *"Ensure the Switchboard extension is active in a VS Code window opened on this folder"* — advice that is actively wrong when the user is running `npx switchboard` and the server is healthy. And a 401 is not special-cased at all: the function echoes the response body and returns 1, so the agent sees an opaque JSON error whose own `detail` tells it to *"Open the board URL from a fresh `npx switchboard` launch to obtain a session cookie"* — a browser instruction delivered to a headless process.

### Root Cause

Auth was added to the server without a matching client contract. The discovery protocol these clients implement — walk up for `.switchboard/`, read the port, probe `/health` — was defined when the port was the *only* thing a caller needed, and nothing extended it when a credential became required. Because seven Node scripts and one bash helper each rolled their own copy of that protocol, there was also no single place where adding a header would have fixed them all.

### Non-goals

- **Publishing the credential.** Depends on `publish-agent-api-token-for-out-of-process-agents.md`. This plan consumes what that one produces.
- **The generated agent prompts and skill docs.** Separate plan (`agent-api-auth-instructions-and-diagnostics.md`).
- **Refactoring the scripts' non-HTTP logic.** Discovery, auth and error reporting only; leave each script's actual verb payload alone.
- **Migrations.** Unreleased dev work. Clean break.

## Metadata

**Complexity:** 4
**Tags:** backend, api, auth, cli, refactor, reliability

## Proposed Changes

1. **Extend the bash discovery routine in `sb_api_call.sh`** to resolve a token once the root is known, in this precedence order:
   1. `$SWITCHBOARD_API_TOKEN` if non-empty — a pty-fleet child already has it, and an env var must beat a file so an operator can override.
   2. `$SB_ROOT/.switchboard/api-server-token.txt` if readable and non-empty.
   3. Neither — send **no** header. This is the extension-host path and it must keep working exactly as today.

   Send the header only when a token was resolved: an empty `Authorization: Bearer` would be *worse* than none, since a bearer header present but unmatched is a hard 401 whereas an absent header is loopback-trusted.

2. **Reuse `$SB_ROOT`, do not re-walk.** The upward walk already resolved the root and `/health` already verified it (`verify_health_json` asserts the discovered root appears in `roots`). Read the token from that same verified root, so a token can never be paired with a different workspace's port.

3. **Add a shared Node helper** `.agents/skills/_lib/sb_http.js`, exporting the port lookup, the same three-step token resolution, and a `request(method, path, body)` that sets the header. Then reduce each of the seven scripts to requiring it. This is the change that makes the fix hold: seven private copies of the discovery protocol is why the header was missing everywhere at once, and leaving them private guarantees the next protocol change misses some subset again.

4. **Distinguish 401 from unreachable in both languages.** A 401 must report: the port and root actually used, whether a token was found and from which source (env / file / none) — **never the token value** — and the real remedy for each case. Under standalone with no token file: the server may predate the change or the file may be stale, so restart it. Under standalone with a token file present: the file is stale relative to a restarted server, so re-read it. The current single "extension isn't running" string must stop being emitted for auth failures.

5. **Fix the three misleading strings in `sb_api_call.sh`** (the no-port-file case, the health-failure case, and the connection-failure case) to name both hosts. "Ensure the Switchboard extension is active in a VS Code window" becomes a statement that neither an extension host nor a `npx switchboard` server was found for this folder.

6. **Handle a stale token file.** The agent token is per-launch (see the publication plan), so a file left by a previous server yields a 401 that looks identical to a missing credential. On a 401 with a token sourced from the file, re-read the file once and retry exactly once — the file may have been rewritten by a server that restarted between discovery and the call. Do not loop; one retry, then report.

7. **Do not log the token.** Not in error messages, not in debug output, not in a retry notice. Report only its *source*. The existing `$SWITCHBOARD_API_TOKEN` design keeps the secret out of scrollback (`ptyFleetService.ts:363-373`); preserve that property.

8. **Leave `move-card.js`'s direct-DB fallback in place** but make it fire only after an auth-clean HTTP failure, so a 401 does not silently route a card move around the API and its provenance stamping.

## Edge-Case & Dependency Audit

- **The no-token path is the one that must not regress.** The extension host publishes no token file and sets no env var, so clients resolve nothing and send no header. Every skill must behave exactly as today there. Test this explicitly — it is the ~4,000-install path.
- **An empty-but-present token file** (a truncated or interrupted write) must be treated as absent, not sent. Trim and test for non-empty, matching the fail-closed trim at `bootstrap.ts:530-534`.
- **`localhost` vs `127.0.0.1`.** `sb_api_call.sh` currently uses `http://localhost:$PORT` while the server binds `127.0.0.1` only (`LocalApiServer.ts:736`) and the Node scripts use `127.0.0.1`. On a host where `localhost` resolves to `::1` first, the bash helper can fail where the scripts succeed. The `Host` guard accepts both names, so switching bash to `127.0.0.1` is safe and removes a real inconsistency — worth doing in this plan since it is the same lines.
- **Read the port and the token as a pair, from the same root, in one pass.** A server restart between the two reads yields a fresh port paired with a stale token — a 401 the client would misdiagnose as a missing credential. Read both before the `/health` probe, and treat the probe as validating the pair rather than just the port. This also contains the pre-existing discovery-file ownership race documented in the publication plan's audit (a second VS Code process on the same root overwrites the port file), since a mismatched pair is exactly how that race surfaces to a client.
- **The token file is `0600`.** A client running as a *different* user gets `EACCES`, not `ENOENT`. Distinguish them: "permission denied reading the token file" is a different diagnosis from "no token file", and conflating them sends the user chasing the wrong problem.
- **Backoff must not multiply.** `sb_api_call.sh` already does 5 attempts of health probing plus one retry on 5xx. Adding an unconditional auth retry on top risks a long hang; scope the new retry strictly to a 401 whose token came from the file.
- **Callers passing their own `-H`.** Some skills may already append headers via `"$@"`. The new header must be prepended so a caller-supplied `Authorization` still wins, and no skill should break by passing one.
- **`get-state.js` needs no change** — it reads the DB directly. Confirm by inspection and note it, so a later reader does not "fix" it into an HTTP caller.

## Dependencies

- **`publish-agent-api-token-for-out-of-process-agents.md`** — must land first. Without the token file, step 1's second precedence tier resolves nothing and the standalone path stays broken. The rest of this plan (shared helper, error messages, `localhost`→`127.0.0.1`) is independently valuable and could ship first if sequencing demands it.

## Verification Plan

1. `bash -n .agents/skills/_lib/sb_api_call.sh` and `node --check` on `sb_http.js` and all seven modified scripts.
2. **Extension host, no token anywhere** — the no-regression case. Run each of: a `get-tickets` skill call, `move-card.js`, `create-feature.js`, `assign-to-feature.js`, `split-feature.js`, `delete-feature.js`, `remove-from-feature.js`, `reconcile-features.js`. All must succeed exactly as before, sending no header.
3. **Standalone host, token file present, plain terminal outside the pty fleet** — the case this plan exists for. Re-run all of step 2's calls; all must succeed.
4. **Standalone host, pty-fleet terminal** with `$SWITCHBOARD_API_TOKEN` set: same calls succeed, and the env var is confirmed to take precedence (temporarily corrupt the file and confirm calls still work).
5. **Stale token file:** capture a token, restart the server, and confirm the one-shot re-read recovers on the first call rather than failing.
6. **Hard 401:** point a client at a deliberately wrong token and confirm the error names the port, the root, and the token source, includes a real remedy, and **does not contain the token value** (grep the output for it).
7. **Truncated token file** (`: > api-server-token.txt`): treated as absent; under standalone this yields a clean 401 with the no-token remedy, not a malformed header.
8. `chmod 000` the token file and confirm the `EACCES` path reports permission-denied, not "no token file".
9. Confirm no client emits the token to stdout, stderr, or any log: run every call under `script` and grep the transcript for the token value.
10. Run the existing kanban and skill contract tests to confirm no payload or verb behavior changed.

## Outstanding Questions

- Should `sb_http.js` be shared with the `.claude/skills/` tree, or duplicated? Depends on how those skills are distributed relative to `.agents/skills/`; resolve by inspecting the packaging before writing the helper's path.
