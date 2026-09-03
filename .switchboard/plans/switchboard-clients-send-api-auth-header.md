# No shipped Switchboard client sends an Authorization header — add shared token discovery to sb_api_call.sh and the kanban_operations scripts

<!-- board-collapse-01 -->
> **RESCOPED 2026-09-04 (Board Collapse 01).** `sb_api_call.sh` was deleted in `96fb16df` and the seven `kanban_operations` scripts already share one transport, `.agents/skills/_lib/cli-call.js`. The proposed `sb_http.js` extraction is therefore already done by other means. This plan shrinks to: add token discovery (env, then token file, then none) and honest 401 reporting to `cli-call.js` alone. It folds into *Out-of-process agents cannot authenticate to the standalone API* and should be dispatched with it.


## Goal

Make every in-tree client of the local API discover and present a credential, via one shared discovery routine per language (bash, Node), so the skills and scripts work identically under both hosts. A 401 must also be reported as a 401 — with the actual remedy — rather than as "the extension isn't running".

### Scope — what survives once the mandatory token goes

`auth-belongs-at-a-boundary-and-a-local-cli-is-not-one.md` identifies why every one of these clients
401s: `bootstrap.ts:590-603` mints a session token on every standalone launch, so `_checkAuth` never
reaches its loopback-trust branch. Fixing that at the source repairs *"the entire skill layer is dead on
the standalone host"* without any client sending a header.

Two parts of this plan survive that and remain worth doing:

- **The 401-reporting fix.** *"A 401 must also be reported as a 401 — with the actual remedy — rather
  than as 'the extension isn't running'."* Independent of whether auth is on by default; a
  misdiagnosed error is a bug in any configuration.
- **The shared discovery routine, one per language.** Still needed for the opt-in case, and still the
  right answer to seven Node scripts and one bash helper each rolling their own port lookup.

What no longer holds is the framing that this plan is a **precondition** for the skill layer working.
It is the fix for the configured-token case; the default case is fixed upstream.

### Problem Analysis

Not one shipped client sends an `Authorization` header.

**`sb_api_call.sh`** — the helper behind every ClickUp, Linear, get-tickets and kanban skill (`.agents/skills/_lib/sb_api_call.sh`). It walks up from `$PWD` looking for `.switchboard/api-server-port.txt`, probes `/health` with bounded backoff and jitter, verifies the health JSON names the discovered root, then issues the real call at line 122:

```
HTTP_STATUS=$(curl -s -w "%{http_code}" -o "$TEMP_BODY" -X "$METHOD" "http://localhost:$PORT$PATH_NAME" "$@")
```

No auth header, and no place a caller could inject one except by passing `-H` through `"$@"` at every call site.

**The `kanban_operations/*.js` scripts** — seven of them each independently reimplement the same port lookup and `http.request` to `127.0.0.1`: `create-feature.js`, `move-card.js`, `assign-to-feature.js`, `delete-feature.js`, `reconcile-features.js`, `remove-from-feature.js`, `split-feature.js`. None sends an auth header. (`get-state.js` is the exception — it reads the DB directly and needs no change.) `move-card.js` additionally has a direct-DB write fallback via `require('../../../out/services/KanbanDatabase')` at line 134, so it partially survives a server-down scenario; the rest do not. (`create-feature.js` also `require`s `KanbanDatabase` at line 165, but only for a *read-only* title-resolution query — its primary write path is the feature file + HTTP, so it is not a second write fallback.)

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

> **Superseded:** **Complexity:** 4
> **Reason:** The work spans 9 files (1 bash helper + 1 new Node helper + 7 script refactors) and carries two moderate, well-scoped risks that extend existing patterns: the stale-token re-read must handle a server *restart* (port+token pair re-discovery), not just a token-file rewrite; and the duplicate-`Authorization`-header interaction must be handled by detection-and-skip, not header-precedence assumptions. That is above the "routine single-file" bar of 4 but does not reach the 7-8 "new patterns" tier — it is a disciplined extraction of an existing discovery pattern with a credential tier added.
> **Replaced with:** **Complexity:** 5

**Complexity:** 5
**Tags:** backend, api, auth, cli, refactor, reliability

## User Review Required

**No.** This plan does not modify the authentication gate (`_checkAuth`) — that is the publication plan's security-critical concern. This plan is client-side credential *presentation* only. The one security-relevant invariant it owns — **never log the token value** — is specified explicitly in step 7 and asserted by verification step 9. A reviewer should still eyeball the error-message construction to confirm no token substring leaks, but no human gate is required before implementation.

## Complexity Audit

### Routine
- Adding a three-tier token resolution (env > file > none) to the existing port-walk in `sb_api_call.sh`.
- Extracting `.agents/skills/_lib/sb_http.js` and reducing seven scripts to `require` it — mechanical deduplication of an already-identical port-lookup pattern.
- Rewriting the three misleading "extension isn't running" strings to name both hosts.
- Switching the bash `localhost` literal to `127.0.0.1` (covers the `/health` probe at line 87 and the final call at line 122 — same literal, one fix).
- Confirming `get-state.js` needs no change (reads DB directly).

### Complex / Risky
- **Stale-token re-read must handle a server restart, not just a token-file rewrite.** A 401 with a file-sourced token can mean the server restarted — in which case the *port* is stale too. Re-reading only the token retries against a dead port and misdiagnoses a restart as an auth failure. The re-read must re-discover the port+token pair and re-probe `/health` before retrying.
- **Duplicate `Authorization` header from caller-supplied `-H`.** curl sends both headers; Node's `req.headers['authorization']` behavior on duplicates is undefined (it is not in the comma-concatenable header list). Relying on "prepend so caller wins" is fragile. Must detect a caller-supplied `Authorization` and skip the auto-header entirely.
- **Distinguishing `EACCES` from `ENOENT` on the `0600` token file in bash.** `[ -r ]` and `cat` exit codes conflate the two. Requires an explicit `stat`/`ls` classification step. (Node gets this for free via `err.code`.)
- **`move-card.js` DB fallback must not fire on a 401.** A 401 is an auth failure, not an unreachable server; routing it to the direct-DB write bypasses the API's provenance stamping and integration sync silently.

## Edge-Case & Dependency Audit

- **The no-token path is the one that must not regress.** The extension host publishes no token file and sets no env var, so clients resolve nothing and send no header. Every skill must behave exactly as today there. Test this explicitly — it is the ~4,000-install path.
- **An empty-but-present token file** (a truncated or interrupted write) must be treated as absent, not sent. Trim and test for non-empty, matching the fail-closed trim at `bootstrap.ts:530-534`.
- **`localhost` vs `127.0.0.1`.** `sb_api_call.sh` currently uses `http://localhost:$PORT` while the server binds `127.0.0.1` only (`LocalApiServer.ts:736`) and the Node scripts use `127.0.0.1`. On a host where `localhost` resolves to `::1` first, the bash helper can fail where the scripts succeed. The `Host` guard accepts both names, so switching bash to `127.0.0.1` is safe and removes a real inconsistency — worth doing in this plan since it is the same lines. **The swap must cover both the `/health` probe (line 87) and the final call (line 122)** — same `localhost` literal, but a partial edit that only touches line 122 leaves the probe broken on `::1`-first hosts.
- **Read the port and the token as a pair, from the same root, in one pass.** A server restart between the two reads yields a fresh port paired with a stale token — a 401 the client would misdiagnose as a missing credential. Read both before the `/health` probe, and treat the probe as validating the pair rather than just the port. This also contains the pre-existing discovery-file ownership race documented in the publication plan's audit (a second VS Code process on the same root overwrites the port file), since a mismatched pair is exactly how that race surfaces to a client.
- **The token file is `0600`.** A client running as a *different* user gets `EACCES`, not `ENOENT`. Distinguish them: "permission denied reading the token file" is a different diagnosis from "no token file", and conflating them sends the user chasing the wrong problem. **In Node:** `fs.readFileSync` throws with `err.code === 'EACCES'` vs `'ENOENT'` — clean. **In bash:** `cat` exits non-zero for both and `[ -r ]` returns false for both; classify with `stat`/`ls -ld` after a failed `cat` — check `stat` exit / `ls` output to tell permission-denied from missing.
- **Backoff must not multiply.** `sb_api_call.sh` already does 5 attempts of health probing plus one retry on 5xx. Adding an unconditional auth retry on top risks a long hang; scope the new retry strictly to a 401 whose token came from the file, and make it re-discover the port+token pair (not just the token) so a restart is handled in the same retry.
- **Callers passing their own `-H`.** Some skills may already append headers via `"$@"`. **Do not rely on header precedence.** Detect whether `"$@"` already contains an `Authorization` header; if so, send no auto-header. This avoids undefined duplicate-`Authorization` behavior in Node's HTTP parser (the header is not in the comma-concatenable list). No skill should break by passing one.
- **`get-state.js` needs no change** — it reads the DB directly. Confirm by inspection and note it, so a later reader does not "fix" it into an HTTP caller.
- **The two shared helpers (bash + Node) must agree.** `sb_api_call.sh` and `sb_http.js` are now the two sources of truth for one discovery protocol. Add a mutual-reference comment in each pointing to the other as the canonical pair, so the next protocol change updates both or is visibly inconsistent.

## Dependencies

- **`publish-agent-api-token-for-out-of-process-agents.md`** — must land first. Without the token file, step 1's second precedence tier resolves nothing and the standalone path stays broken. The rest of this plan (shared helper, error messages, `localhost`→`127.0.0.1`) is independently valuable and could ship first if sequencing demands it.

## Adversarial Synthesis

Key risks: (1) the stale-token re-read is too narrow if it only re-reads the token — a server *restart* changes the port too, so the retry must re-discover the port+token pair and re-probe `/health`; (2) duplicate `Authorization` headers from caller-supplied `-H` have undefined server-side behavior, so the auto-header must be skipped when a caller already supplied one rather than relying on prepend-precedence; (3) `move-card.js`'s DB fallback could silently mask a 401 as a "successful" move, bypassing the API — it must fire only on unreachable, never on 401. Mitigations: pair re-discovery on file-sourced 401; detect-and-skip for caller Authorization headers; gate the DB fallback on connection failure only, with a verification step that asserts a 401 is reported (not silently routed to the DB).

## Proposed Changes

1. **Extend the bash discovery routine in `sb_api_call.sh`** to resolve a token once the root is known, in this precedence order:
   1. `$SWITCHBOARD_API_TOKEN` if non-empty — a pty-fleet child already has it, and an env var must beat a file so an operator can override.
   2. `$SB_ROOT/.switchboard/api-server-token.txt` if readable and non-empty. On a read failure, classify `EACCES` vs `ENOENT` via `stat`/`ls -ld` (see Edge-Case audit) so the error names the right remedy.
   3. Neither — send **no** header. This is the extension-host path and it must keep working exactly as today.

   Send the header only when a token was resolved: an empty `Authorization: Bearer` would be *worse* than none, since a bearer header present but unmatched is a hard 401 whereas an absent header is loopback-trusted.

2. **Reuse `$SB_ROOT`, do not re-walk.** The upward walk already resolved the root and `/health` already verified it (`verify_health_json` asserts the discovered root appears in `roots`). Read the token from that same verified root, so a token can never be paired with a different workspace's port.

3. **Add a shared Node helper** `.agents/skills/_lib/sb_http.js`, exporting the port lookup, the same three-step token resolution, and a `request(method, path, body)` that sets the header. Then reduce each of the seven scripts to requiring it. This is the change that makes the fix hold: seven private copies of the discovery protocol is why the header was missing everywhere at once, and leaving them private guarantees the next protocol change misses some subset again.

   > **Resolved Assumption:** The plan's original Outstanding Question asked whether `sb_http.js` should be shared with the `.claude/skills/` tree or duplicated. **Resolved by code inspection:** `.claude/skills/` has no `_lib/` directory — its skills (e.g. `.claude/skills/worktree-cleanup/SKILL.md`) already source `.agents/skills/_lib/sb_api_call.sh` directly by path. The `.claude/` tree is a thin wrapper layer that points back to `.agents/skills/_lib/`. Therefore `sb_http.js` belongs in `.agents/skills/_lib/` and the `.claude/` skills require no change — they will pick it up through the scripts they already invoke. No duplication.

4. **Distinguish 401 from unreachable in both languages.** A 401 must report: the port and root actually used, whether a token was found and from which source (env / file / none) — **never the token value** — and the real remedy for each case. Under standalone with no token file: the server may predate the change or the file may be stale, so restart it. Under standalone with a token file present: the file is stale relative to a restarted server, so re-read it. The current single "extension isn't running" string must stop being emitted for auth failures.

5. **Fix the three misleading strings in `sb_api_call.sh`** (the no-port-file case at line 74, the health-failure case at line 114, and the connection-failure case at line 137) to name both hosts. "Ensure the Switchboard extension is active in a VS Code window" becomes a statement that neither an extension host nor a `npx switchboard` server was found for this folder.

6. **Handle a stale token file — re-discover the pair, not just the token.** The agent token is per-launch (see the publication plan), so a file left by a previous server yields a 401 that looks identical to a missing credential. **But a 401 can also mean the server restarted**, in which case the *port* is stale too. On a 401 with a token sourced from the file: re-read the port file AND the token file from the same `$SB_ROOT`, re-probe `/health` to validate the new pair, and retry exactly once. Do not loop; one retry, then report. This handles both a token-file rewrite and a full server restart in the same path.

   > **Superseded:** "On a 401 with a token sourced from the file, re-read the file once and retry exactly once — the file may have been rewritten by a server that restarted between discovery and the call."
   > **Reason:** Re-reading only the token retries against the *original* port. If the server restarted, that port is dead — the retry gets connection-refused (not a 401) and the client reports "unreachable," misdiagnosing a restart as an auth failure and sending the user chasing credentials when they need to re-discover the port.
   > **Replaced with:** Re-read the port AND the token from the same root, re-probe `/health` to validate the new pair, then retry exactly once. One retry, then report.

7. **Do not log the token.** Not in error messages, not in debug output, not in a retry notice. Report only its *source*. The existing `$SWITCHBOARD_API_TOKEN` design keeps the secret out of scrollback (`ptyFleetService.ts:369-373`); preserve that property.

8. **Leave `move-card.js`'s direct-DB fallback in place** but make it fire only after an *unreachable* failure (connection refused / no port file / health probe failed) — **never on a 401**. A 401 is an auth failure, not a server-down condition; routing it to the DB bypasses the API's provenance stamping and integration sync silently. The verification plan must assert this explicitly (a 401 must be reported, not silently routed to the DB).

9. **Detect caller-supplied `Authorization` headers; do not prepend-and-pray.** In `sb_api_call.sh`, scan `"$@"` for an existing `-H 'Authorization:...'` / `--header 'Authorization:...'`; if present, skip the auto-injected header entirely. In `sb_http.js`, accept an optional `headers` map from the caller and do not overwrite a caller-supplied `Authorization`. Do not rely on duplicate-header precedence — Node's HTTP parser does not concatenate `Authorization` (it is not in the comma-concatenable list), so behavior with two `Authorization` headers is undefined.

   > **Superseded:** "The new header must be prepended so a caller-supplied `Authorization` still wins, and no skill should break by passing one."
   > **Reason:** curl sends both headers when prepended; Node's `req.headers['authorization']` behavior on duplicate `Authorization` headers is undefined (the header is excluded from the comma-concatenable list). "Prepend so caller wins" assumes precedence semantics that have not been verified and are explicitly unspecified.
   > **Replaced with:** Detect a caller-supplied `Authorization` header and skip the auto-header entirely. One header, no ambiguity.

10. **Add a mutual-reference comment in both helpers.** `sb_api_call.sh` and `sb_http.js` are the two sources of truth for one discovery+auth protocol. Each file's header comment must name the other as the canonical pair, so a future protocol change that updates only one is visibly inconsistent rather than silently drifting.

## Verification Plan

### Automated Tests

1. `bash -n .agents/skills/_lib/sb_api_call.sh` and `node --check` on `sb_http.js` and all seven modified scripts.
2. **Extension host, no token anywhere** — the no-regression case. Run each of: a `get-tickets` skill call, `move-card.js`, `create-feature.js`, `assign-to-feature.js`, `split-feature.js`, `delete-feature.js`, `remove-from-feature.js`, `reconcile-features.js`. All must succeed exactly as before, sending no header.
3. **Standalone host, token file present, plain terminal outside the pty fleet** — the case this plan exists for. Re-run all of step 2's calls; all must succeed.
4. **Standalone host, pty-fleet terminal** with `$SWITCHBOARD_API_TOKEN` set: same calls succeed, and the env var is confirmed to take precedence (temporarily corrupt the file and confirm calls still work).
5. **Stale token file / server restart:** capture a token, restart the server (so both port and token files change), and confirm the one-shot pair re-discovery recovers on the first call rather than failing or misdiagnosing as unreachable.
6. **Hard 401:** point a client at a deliberately wrong token and confirm the error names the port, the root, and the token source, includes a real remedy, and **does not contain the token value** (grep the output for it).
7. **401 does NOT trigger the `move-card.js` DB fallback:** under standalone with a deliberately wrong token, invoke `move-card.js` and confirm it **reports the 401** (exit non-zero, 401-named error) and does **not** silently succeed via the direct-DB write path. Assert no kanban row was moved by inspecting the DB before and after.
8. **Truncated token file** (`: > api-server-token.txt`): treated as absent; under standalone this yields a clean 401 with the no-token remedy, not a malformed header.
9. `chmod 000` the token file and confirm the `EACCES` path reports permission-denied (in bash via the `stat`/`ls` classification; in Node via `err.code === 'EACCES'`), not "no token file".
10. Confirm no client emits the token to stdout, stderr, or any log: run every call under `script` and grep the transcript for the token value.
11. **Caller-supplied `Authorization` header:** invoke `sb_api_call.sh` with an explicit `-H 'Authorization: Bearer custom'` and confirm the auto-header is skipped (the server sees exactly one `Authorization` header — the caller's), and the call is not broken by a duplicate.
12. Run the existing kanban and skill contract tests to confirm no payload or verb behavior changed.

*(Compilation and automated tests skipped this run per dispatch directive — the checks remain written for the implementing coder.)*

### Goal Invariants

- `sb_api_call.sh` resolves a token via `$SWITCHBOARD_API_TOKEN` → `$SB_ROOT/.switchboard/api-server-token.txt` → none, and injects an `Authorization: Bearer <token>` header into the curl call **only** when a non-empty token was resolved.
- `.agents/skills/_lib/sb_http.js` exists, exports a port-lookup + three-tier token resolution + `request(method, path, body)`, and all seven kanban scripts (`create-feature.js`, `move-card.js`, `assign-to-feature.js`, `delete-feature.js`, `reconcile-features.js`, `remove-from-feature.js`, `split-feature.js`) `require` it instead of inlining their own port lookup.
- No client sends an `Authorization` header with an empty/blank bearer value (grep the call sites for `Authorization: Bearer ` with trailing whitespace — zero matches).
- `sb_api_call.sh` uses `127.0.0.1` (not `localhost`) in both the `/health` probe and the final call.
- A 401 response produces an error message containing the literal `401` and the token *source* (env/file/none), and does **not** contain the token *value*.
- `move-card.js`'s direct-DB fallback path is reachable only on connection/health failure, never on a 401 (the 401 branch returns before the fallback).
- **Negative invariant:** no `Authorization` header is sent by any client when both `$SWITCHBOARD_API_TOKEN` is unset and no `api-server-token.txt` is readable. **Paired positive:** the header is present (and accepted) when the token file is readable under the standalone host.
