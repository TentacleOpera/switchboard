# Make the Agent↔Extension API Bridge Robust (Health-Gated Discovery + Retry for LocalApiServer)

## Goal

Make the agent↔extension API bridge as reliable as the tickets-tab `postMessage` channel: a skill always reaches the correct, live server for its workspace or fails with a clear, actionable message, survives window reloads, and never routes to the wrong window's server — while keeping every token inside the extension host.

**Core problem & root-cause analysis (preserved from original Problem & Why):**

The ClickUp/Linear agent skills are "almost always down." They are broken for **two** compounding reasons, both confirmed in code:

1. **Fragile transport** — the channel depends on a random port discovered through a file that goes stale on every reload.
2. **Broken auth bridge** (the dominant failure) — skills fetch a token via `curl /config/token`, an endpoint that **does not exist** (no route handler → 404), so they send `Authorization: Bearer ` (empty). The server's `_checkAuth` (`LocalApiServer.ts:106-119`) compares that header against the SecretStorage token. The moment a user configures a token, `Bearer ` !== `Bearer <real-token>` and **every read and write skill returns 401**. The skills only function in the one useless case: no token configured. Removing `/config/token` without fixing `_checkAuth` changes nothing — the helper would send no header and still 401.

Tokens live in VS Code **SecretStorage**, reachable only from the extension-host process. A skill runs in a plain bash/agent process that cannot touch SecretStorage. So the skill must reach the host to make an authenticated call — exactly like the tickets-tab webview reaches the host via `postMessage`. The `LocalApiServer` *is* the agent's equivalent of `postMessage`: agent → `curl localhost:PORT` → host reads SecretStorage → calls ClickUp/Linear. This bridge is necessary; it just isn't robust **and** its auth gate is broken.

The tickets tab is reliable because `postMessage` is an always-live, in-process channel. The skills are unreliable because their channel depends on a random port discovered through a file that goes stale. We are keeping the bridge and making its transport as reliable as `postMessage`. **We are not moving tokens to disk** (that would be a security downgrade for a published extension with ~4,000 installs).

### Confirmed failure modes (from code)
- `LocalApiServer` binds to a **random port** (`listen(0, '127.0.0.1')`, `LocalApiServer.ts:44`) and writes it to `.switchboard/api-server-port.txt`. On every window reload the host restarts, gets a **new** port, and rewrites the file — skills hitting the old port during the gap just fail (no retry).
- The port file is written by **two** writers — `LocalApiServer._writePortFile` (`:100`) for its own root, and `TaskViewerProvider._startLocalApiServer` (`:803`) for *all* roots. Redundant and can race.
- **Multi-window**: each host runs its own server on its own port, and all windows sharing a workspace root overwrite the same port file. An agent can be routed to the wrong window's server, and `/health` returns only `{status, port}` (`LocalApiServer.ts:738-740`) — no workspace identity to detect the mismatch.
- The port file is **never deleted** on `stop()`/deactivate (`TaskViewerProvider.ts:821`, `:17609`), so after a crash it points at a dead port.
- All **9 skills** share one pattern: walk up for the port file, `cat` it, then a single `curl`. **No retry, no health pre-check, no stale-port handling.**
- **Auth bridge broken**: **5** of the 9 skills also `curl .../config/token`, an endpoint that **does not exist** (404, dead code): `clickup_create_task.md`, `clickup_attach.md`, `clickup_create_subpage.md`, `clickup_modify_task.md`, `generate_diagram.md`. (The other 4 — `clickup_api.md`, `linear_api.md`, `clickup_fetch.md`, `get_tickets.md` — never carried it.) Because the fetch 404s, these skills send an empty Bearer and 401 against `_checkAuth` whenever a token is configured. *(Clarification: the original plan counted 6; the actual count is 5 — `clickup_fetch.md` also lacks the line.)*
- **`_checkAuth` is the root auth blocker**: with a configured token it requires `authHeader === Bearer <token>` for *all* requests (`:118`), but no skill can ever produce that header without the token leaving the host — which is a hard Non-Goal.

## Goals
1. A skill always reaches the **correct, live** server for its workspace, or fails with a clear, actionable message — never a silent no-op.
2. Survive window reloads and host restarts transparently (retry across the restart gap).
3. Never route an agent to the wrong window's server (workspace-identity verification).
4. No token ever leaves the extension host. No format migration of any shipped state.
5. **(Added)** Fix the auth bridge so skills succeed when a token *is* configured — the localhost-only binding is the trust boundary; the skill-side Bearer header is removed as redundant and broken.

## Non-Goals
- No fixed/hardcoded port (would collide across windows).
- No moving tokens to disk / env vars.
- No exposing the token over any HTTP route (no `/config/token` implementation).
- No change to how the tickets-tab webview works (already robust).
- No change to the on-disk port-file *format* (stays a plain port number — identity/liveness come over HTTP, avoiding any migration concern).

## Design

> **Naming note:** `/health`, `/api/clickup`, `/task/clickup`, `/resolve/...` are **HTTP routes** on the LocalApiServer (e.g. `GET http://localhost:<port>/health`) — they are *not* Switchboard skills and *not* slash commands. Skills (the `.agents/skills/*.md` files) are what agents run; those skills `curl` these HTTP routes.

### A. Extension-host side — `src/services/LocalApiServer.ts` + `src/services/TaskViewerProvider.ts`

1. **Enrich the `/health` HTTP route with workspace identity.** Return the root(s) this server serves so a skill can confirm it reached the right one:
   ```json
   { "status": "ok", "port": <n>, "roots": ["<abs path>", ...] }
   ```
   `roots` = the same `allRoots` list (post `_filterMappedRoots`) the port file is written to. The skill's identity check is purely `SB_ROOT in roots`. Keep this endpoint auth-free (it already is). *(Clarification: the original plan also proposed an `effectiveRoot` field = `resolveEffectiveWorkspaceRootFromMappings(workspaceRoot)`. That value is a rewritten/mapped root and may NOT be a member of `roots`, making the response self-contradictory. Drop `effectiveRoot` from the response, or include it only as informational-only and never use it for the membership test.)* To supply `roots`, the server must receive the `allRoots` list at construction (add an `allRoots: string[]` field to `LocalApiServerOptions`, populated by `TaskViewerProvider._startLocalApiServer` from `this._filterMappedRoots(this._getWorkspaceRoots())`).

2. **Fix the auth gate (the dominant failure).** The server already enforces localhost-only (`remoteAddress === 127.0.0.1 || '::1'`, `:710-715`) and already holds the token in SecretStorage via `getAuthToken()` for upstream provider calls. The skill-side `Authorization` header is therefore redundant and, because `/config/token` 404s, actively broken. **Relax `_checkAuth` to trust the localhost boundary**: for localhost connections, treat auth as satisfied and rely on the existing 127.0.0.1 socket check as the trust boundary. The token is still used server-side for the real ClickUp/Linear calls — it simply never needs to round-trip to the skill. This fixes the 401-on-configured-token bug for all 9 skills and is consistent with the "no token leaves the host" Non-Goal. (If a defense-in-depth shared secret is later desired, it must be a non-secret session token, never the SecretStorage token — out of scope here.)

3. **Atomic port-file write.** Write to `api-server-port.txt.tmp` then `rename()` into place, so a skill can never `cat` a half-written file during the reload rewrite. Apply in **one** consolidated writer. Also extend `_cleanupTempFiles` (`:81-95`) to delete `api-server-port.txt.tmp` (it currently only cleans `*.json.tmp`, so a crashed rename would leak the new temp).

4. **Consolidate the two writers.** Remove the redundant `LocalApiServer._writePortFile` call to its own root; have `TaskViewerProvider` own all port-file writing (it already knows `allRoots`). The server returns its port; the provider writes the files atomically. Eliminates the race between the two. *(Acknowledged trade-off: removing the server-side write creates a sub-ms window where the server is listening but no port file exists yet, because the provider writes only after `await start()`. This is fully covered by the helper's retry and is acceptable.)*

5. **Clean up on stop.** In `_stopLocalApiServer`/`stop()`, delete the port file(s) for all roots this server wrote. Best-effort (ignore ENOENT). This narrows (does not eliminate — crashes skip it) the stale-file window; the skill-side health check is the authoritative defense.

6. **Liveness re-assert (lightweight, lower priority).** A periodic check (e.g. every 30s) that `_server.listening` is true; if not, restart. **Do NOT periodically re-write the shared port file** — in multi-window setups every window would overwrite the same shared file with its own port every 30s ("last writer wins" = random), reintroducing on-disk cross-talk. The identity check is the authoritative defense; the interval only restarts a dead listener. Implement only if it stays simple; the skill-side retry already covers the common reload gap.

### B. Skill side — `.agents/skills/*` (the 9 files below)

Replace the brittle discover-and-curl block with a **health-gated, retrying** call. To avoid 9 copies of the logic drifting, factor it into one shared helper and have each skill source it.

- **Helper:** `sb_api_call` — a small bash function that:
  1. Walks up from `$PWD` to find `.switchboard/api-server-port.txt` (unchanged discovery), remembering the directory it was found in (`SB_ROOT`).
  2. Curls the `/health` HTTP route (`GET http://localhost:<port>/health`); verifies `status == ok` **and** that `SB_ROOT` is in the returned `roots` (identity check — closes the multi-window cross-talk).
  3. If health fails (connection refused / wrong workspace / non-200): **retry with backoff**. *(Clarification: the existing `ClickUpSyncService.retry` (`:2297-2307`) is plain `Math.pow(2, i) * 1000` with `_maxRetries = 3` — **no jitter, no cap**. The original plan claimed jitter/cap already exist; they do not. We explicitly **upgrade** the pattern here: `min(2^i * 1000, 5000)ms + jitter`, bounded (~5 attempts / ~10–12s) to cover a reload gap. This is an improvement over the existing TS retry, not a mirror of it.)* Re-reads the port file each attempt (it may have been rewritten with a new port).
  4. On success, makes the real call, retrying once on transient connection failure / 5xx.
  5. On exhaustion, emits a **clear, actionable** JSON error to stderr and a non-zero exit: e.g. `{"error":"Switchboard API server not reachable for this workspace. Ensure the Switchboard extension is active in a VS Code window opened on this folder."}` — distinct from auth failures (401 surfaced verbatim, though with the auth-gate fix 401 should only arise from the upstream provider, not the local server).
  6. **Sends no `Authorization` header** (the localhost boundary is the trust boundary; the server holds the token). **Removes the dead `/config/token` fetch** entirely.

- **Helper placement** is the one implementation detail to settle first (see Open Implementation Detail). Default: ship the helper as `.agents/skills/_lib/sb_api_call.sh` and have each skill `source` it via an upward search (same walk-up used for the port file), so it works regardless of agent CWD.

### Blast radius — 9 skills to update
All in `/Users/patrickvuleta/Documents/GitHub/switchboard/.agents/skills/`:
`clickup_api.md`, `linear_api.md`, `clickup_create_task.md`, `clickup_attach.md`, `clickup_create_subpage.md`, `clickup_modify_task.md`, `clickup_fetch.md`, `generate_diagram.md`, `get_tickets.md`.
(**5** of these carry the dead `/config/token` line to remove: `clickup_create_task.md`, `clickup_attach.md`, `clickup_create_subpage.md`, `clickup_modify_task.md`, `generate_diagram.md`. The other 4 never had it.)

## Related plan (downstream consumer)
**`feature_plan_20260622130000_integration-import-pipeline-overhaul`** (Integration Import Pipeline Overhaul) depends on this bridge. Its triage write-back, the Remote Control comment loop, and its sync-mode "agents post questions as comments" directive all post to ClickUp/Linear **through this bridge** (agent → host → SecretStorage token → provider API). That plan adds a host `/comment` route + a `postComment` primitive (which holds the token and stamps a `<!-- switchboard -->` feedback-loop marker) and folds a **comment-posting capability into the existing `linear_api` / `clickup_api` skills** — i.e. it builds *on* the hardened skills delivered here; it does not re-solve transport. **Sequence this bridge plan first, or land them together.** When updating `linear_api.md` / `clickup_api.md` here, keep them open to that added comment-post capability.

## Open Implementation Detail (resolve at start of implementation, not a product decision)
**How are `.agents/skills/*` delivered to the environment where the agent runs?** If they ship as a bundled set in a known location, the shared-helper approach is clean. If skills can be copied/relocated individually such that `_lib/` may be absent, fall back to inlining the helper block into each skill (duplicated but self-contained). Determine by checking how skills are loaded/packaged; default to the shared helper and only inline if delivery can't guarantee the helper is reachable. This does not change the design, only the helper's physical placement.

> **RESOLVED (this planning pass):** `.vscodeignore` contains `!.agents/**` (it explicitly keeps `.agents/` while excluding other AI config dirs). The skills directory ships bundled inside the published VSIX, so `.agents/skills/_lib/sb_api_call.sh` is guaranteed reachable alongside the skill files. **Use the shared helper.** Inline fallback is unnecessary but kept as a documented escape hatch.

## Step-by-step
1. Confirm skill delivery model (above — **resolved: shared helper**); choose shared-helper vs inline.
2. `LocalApiServer.ts`: add `allRoots: string[]` to `LocalApiServerOptions`; enrich the `/health` HTTP route's JSON response with `roots` (drop/optional `effectiveRoot`).
3. `LocalApiServer.ts`: **relax `_checkAuth` to trust the localhost boundary** (the 127.0.0.1/::1 socket check at `:710-715` is the trust boundary); remove the broken Bearer comparison that 401s on configured tokens.
4. Consolidate port-file writing into one atomic writer (temp + rename) in `TaskViewerProvider`; remove the duplicate `LocalApiServer._writePortFile`; extend `_cleanupTempFiles` to also remove `api-server-port.txt.tmp`.
5. Add port-file cleanup on server stop/deactivate (`_stopLocalApiServer`).
6. (Optional/lower priority) Add the liveness re-assert interval (restart dead listener only — **no periodic port-file rewrite**).
7. Author `sb_api_call` helper (`.agents/skills/_lib/sb_api_call.sh`) with health-gate, identity check (`SB_ROOT in roots`), bounded backoff retry (`min(2^i*1000,5000)+jitter`, ~5 attempts), clear errors, **no Authorization header**, no `/config/token`.
8. Update all 9 skills to use the helper; delete the 5 dead `/config/token` lines.
9. `npm run compile` (required after `src/` changes; webpack bundles to `dist/`). *(Excluded from this session per directive — implementer/user to run.)*
10. Verify (below).

## Verification
- **Cold start:** open workspace, run a `clickup_fetch`/`get_tickets` skill → succeeds.
- **Reload gap:** trigger a window reload, immediately run a skill → it retries across the gap and succeeds instead of failing.
- **Stale file:** kill the host / delete-and-corrupt the port to a dead port, run a skill → health-gate detects it, retries, then either recovers (if host comes back) or emits the actionable error (not a silent no-op).
- **Multi-window:** open the same workspace in two windows → a skill verifies identity via `/health.roots` and reaches a server that actually serves this root.
- **Auth distinct from down:** with no token configured, a write skill surfaces the upstream 401/auth message, clearly different from the "server not reachable" message.
- **Auth-gate fix (added):** with a token configured, run a read skill (`get_tickets`) and a write skill (`clickup_create_task`) → both succeed (previously both 401'd). This is the regression test for the dominant failure mode.
- **No token on disk:** grep confirms no token is written to any file/env by the new code.

## Risks & Mitigations
- *Retry adds latency to genuine "server down" cases* → bound attempts (~10–12s) and emit a clear final error so it never hangs indefinitely.
- *Helper not found if skills are relocated* → fall back to inlined block (Open Implementation Detail; resolved to shared helper since `.agents/` ships in the VSIX).
- *Identity check false-negative on mapped roots* → `roots` mirrors the exact `allRoots` (post `_filterMappedRoots`) the port file is written to, so membership matches by construction.
- *Relaxing `_checkAuth` weakens security* → the localhost-only socket check (`:710-715`) remains the trust boundary; the token still never leaves the host and is still required for upstream provider calls. The Bearer gate was redundant defense that was already broken (always 401 with a configured token). Net security posture is unchanged-to-improved (the broken gate is removed, the working boundary stays).
- *Migration* → no shipped on-disk state changes format; the port file stays a plain integer. No migration required.

## Metadata
**Complexity:** 6
**Tags:** reliability, api, backend, devops, bugfix, security

## User Review Required
Yes — the **auth-gate relaxation** (Step 3) is a security-relevant change to the local server's trust model. Although the localhost socket check remains the real boundary and the Bearer gate was already broken, the user should explicitly approve dropping the Bearer comparison before implementation. Also confirm the choice to **not** implement `/config/token` (token must never leave the host).

## Complexity Audit

### Routine
- Removing the 5 dead `/config/token` lines from skill files (mechanical).
- Replacing the 9 skill discover-and-curl blocks with `source sb_api_call` calls (pattern duplication).
- Adding `roots` to the `/health` JSON response (single route, additive).
- Atomic port-file write (temp + `rename`) and extending `_cleanupTempFiles` to cover the new temp.
- Port-file cleanup on stop (best-effort `unlink`, ignore ENOENT).
- Consolidating the two port-file writers into one (delete a redundant call).

### Complex / Risky
- **Relaxing `_checkAuth` to localhost-trust** — security-relevant change to the trust model; must be reviewed and verified that the 127.0.0.1/::1 socket check is the sole, sufficient boundary and that no remote path can reach the server.
- **`sb_api_call` helper correctness** — health-gate + identity membership check (`SB_ROOT in roots`) + bounded backoff with the *upgraded* jitter/cap pattern, shared across 9 skills; a bug here breaks all skills at once.
- **Multi-window identity contract** — `roots` must exactly mirror the post-`_filterMappedRoots` `allRoots` used for port-file writing, or the membership check produces false negatives/positives across windows.

## Edge-Case & Dependency Audit

- **Race Conditions:**
  - Two port-file writers racing → resolved by consolidating to one writer (TaskViewerProvider).
  - Server listening before port file exists (after removing server-side write) → covered by helper retry; sub-ms window.
  - Multi-window shared port-file overwrite on reload → identity check at HTTP layer is the defense; periodic rewrite removed to avoid on-disk thrash.
- **Security:**
  - Token never leaves the host (Non-Goal upheld; `/config/token` not implemented).
  - `_checkAuth` relaxation relies on the 127.0.0.1/::1 socket check (`:710-715`); verify no reverse-proxy / SSH-tunnel forwarding bypasses this on user machines (localhost binding is the standard VS Code local-server pattern; acceptable).
  - `/health` remains auth-free (intentional — needed for pre-flight discovery; leaks only root paths + port to a process already on localhost).
- **Side Effects:**
  - Relaxing `_checkAuth` affects ALL routes, not just skill calls — but all routes were already localhost-only and already held the token server-side; no behavioral change for the webview (which uses `postMessage`, not HTTP).
  - Removing `LocalApiServer._writePortFile` changes the server's self-contained startup contract; provider now owns file writing.
- **Dependencies & Conflicts:**
  - Downstream: `feature_plan_20260622130000_integration-import-pipeline-overhaul` builds on the hardened `linear_api`/`clickup_api` skills and adds a `/comment` route + `postComment` primitive. Keep those two skills open to the added comment-post capability; do not lock their structure.
  - The upgraded backoff (cap + jitter) is an improvement over `ClickUpSyncService.retry`; if later unified, the TS retry should adopt the same cap/jitter — note the divergence.

## Dependencies
- None blocking (no upstream plan must land first).
- Downstream consumer: `feature_plan_20260622130000_integration-import-pipeline-overhaul` (Integration Import Pipeline Overhaul) — depends on the hardened skills delivered here.

## Adversarial Synthesis
Key risks: (1) the auth bridge — not transport — is the dominant failure (`/config/token` 404s → empty Bearer → 401 on every configured-token call); the plan must relax `_checkAuth` to localhost-trust or the helper change is cosmetic. (2) The "mirror existing retry" claim was wrong — the real `ClickUpSyncService.retry` has no jitter/cap; the helper must explicitly *upgrade* the pattern. (3) Multi-window periodic port-file rewrite would thrash the shared file; drop it and rely on the `roots` identity check. Mitigations: localhost-trust auth gate (token stays in host), labeled backoff upgrade, and identity-check-only defense for cross-talk.

## Proposed Changes

### `src/services/LocalApiServer.ts`
- **Context:** Hosts the HTTP bridge agents curl into; holds the token via `getAuthToken()` and enforces localhost-only.
- **Logic:**
  - Add `allRoots: string[]` to `LocalApiServerOptions` (`:8-15`); store on the instance.
  - `/health` route (`:738-740`): return `{ status: 'ok', port, roots: this._allRoots }`. Drop `effectiveRoot` (or include informational-only).
  - `_checkAuth` (`:106-119`): relax to trust the localhost boundary — the 127.0.0.1/::1 check at `:710-715` is the trust boundary; remove the Bearer comparison that 401s on configured tokens. Keep the function as a no-op pass-through (or remove call sites) so upstream provider calls still use the SecretStorage token directly.
  - `_writePortFile` (`:100-104`): remove (consolidate to provider). Remove its call in `start()` (`:50-52`).
  - `_cleanupTempFiles` (`:81-95`): also delete `api-server-port.txt.tmp`.
- **Implementation:** Constructor stores `allRoots`; `/health` serialized with `roots`; `_checkAuth` returns true for the already-verified localhost socket; delete `_writePortFile` and its call.
- **Edge Cases:** Mapped roots where `effectiveRoot` ≠ any `allRoots` member → `roots` is the canonical list, not `effectiveRoot`. Token configured vs not → both now succeed (gate trusts localhost).

### `src/services/TaskViewerProvider.ts`
- **Context:** Owns the `LocalApiServer` lifecycle and knows `allRoots`.
- **Logic:**
  - `_startLocalApiServer` (`:778-816`): pass `allRoots: this._filterMappedRoots(this._getWorkspaceRoots())` into the `LocalApiServer` options; keep the atomic port-file write loop (`:803-812`) but switch to temp + `rename`.
  - `_stopLocalApiServer` (`:821-826`): after `stop()`, best-effort `unlink` the port file for each root in `allRoots` (ignore ENOENT).
  - (Optional) liveness interval: check `_server.listening` every 30s, restart if dead; **do not rewrite the port file on the interval**.
- **Implementation:** Atomic write helper (write `.tmp`, `fs.rename`); cleanup loop in `_stopLocalApiServer`.
- **Edge Cases:** Crash skips cleanup → stale file remains; skill-side health check is the authoritative defense. Multi-window shared file → no periodic rewrite thrash.

### `.agents/skills/_lib/sb_api_call.sh` (NEW)
- **Context:** Shared helper sourced by all 9 skills.
- **Logic:** Walk-up port-file discovery (remember `SB_ROOT`) → `GET /health` → verify `status == ok` and `SB_ROOT in roots` → on failure retry with `min(2^i*1000, 5000)+jitter`, ~5 attempts, re-reading port file each attempt → on success exec the real `curl` (retry once on transient/5xx) → on exhaustion emit actionable JSON error to stderr + non-zero exit. **No `Authorization` header; no `/config/token`.**
- **Implementation:** Pure bash; `source`d via upward search from each skill.
- **Edge Cases:** Port file missing → "extension not active" error. Wrong workspace → identity mismatch → retry then clear error. Reload gap → retry recovers.

### `.agents/skills/*.md` (9 files)
- **Context:** The skill definitions agents run.
- **Logic:** Replace each file's discover-and-curl block with `source` of `sb_api_call` + the real route call. Delete the 5 `/config/token` lines (`clickup_create_task`, `clickup_attach`, `clickup_create_subpage`, `clickup_modify_task`, `generate_diagram`).
- **Implementation:** Mechanical replacement; preserve each skill's route/parameters/response docs.
- **Edge Cases:** Keep `linear_api.md`/`clickup_api.md` open to the downstream comment-post capability.

## Verification Plan

### Automated Tests
- **Excluded this session** per directive: no compilation (`npm run compile`) and no automated unit/integration/e2e tests are run in this planning pass. The implementer/user is to run `npm run compile` after `src/` edits and the existing test suite separately.
- **Recommended manual verification** (from the Verification section above): cold start, reload gap, stale file, multi-window identity, auth-distinct-from-down, the **auth-gate fix regression check** (token configured → read + write skills succeed), and a grep confirming no token on disk.

---

**Recommendation:** Complexity is 6 → **Send to Coder**. The auth-gate relaxation (Step 3) should be user-approved first (see User Review Required).
