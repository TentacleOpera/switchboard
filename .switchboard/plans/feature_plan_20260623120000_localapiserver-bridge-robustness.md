# Make the Agent↔Extension API Bridge Robust (Health-Gated Discovery + Retry for LocalApiServer)

## Problem & Why

The ClickUp/Linear agent skills are "almost always down." They are **not** broken because direct API calls are bad — they're broken because the *transport* between the agent and the token is fragile.

Tokens live in VS Code **SecretStorage**, reachable only from the extension-host process. A skill runs in a plain bash/agent process that cannot touch SecretStorage. So the skill must reach the host to make an authenticated call — exactly like the tickets-tab webview reaches the host via `postMessage`. The `LocalApiServer` *is* the agent's equivalent of `postMessage`: agent → `curl localhost:PORT` → host reads SecretStorage → calls ClickUp/Linear. This bridge is necessary; it just isn't robust.

The tickets tab is reliable because `postMessage` is an always-live, in-process channel. The skills are unreliable because their channel depends on a random port discovered through a file that goes stale. We are keeping the bridge and making its transport as reliable as `postMessage`. **We are not moving tokens to disk** (that would be a security downgrade for a published extension with ~4,000 installs).

### Confirmed failure modes (from code)
- `LocalApiServer` binds to a **random port** (`listen(0, '127.0.0.1')`, `LocalApiServer.ts:44`) and writes it to `.switchboard/api-server-port.txt`. On every window reload the host restarts, gets a **new** port, and rewrites the file — skills hitting the old port during the gap just fail (no retry).
- The port file is written by **two** writers — `LocalApiServer._writePortFile` (`:100`) for its own root, and `TaskViewerProvider._startLocalApiServer` (`:803`) for *all* roots. Redundant and can race.
- **Multi-window**: each host runs its own server on its own port, and all windows sharing a workspace root overwrite the same port file. An agent can be routed to the wrong window's server, and `/health` returns only `{status, port}` (`LocalApiServer.ts:738`) — no workspace identity to detect the mismatch.
- The port file is **never deleted** on `stop()`/deactivate (`TaskViewerProvider.ts:821`, `:17609`), so after a crash it points at a dead port.
- All **9 skills** share one pattern: walk up for the port file, `cat` it, then a single `curl`. **No retry, no health pre-check, no stale-port handling.** Six of them also `curl .../config/token`, an endpoint that **does not exist** (404, dead code).

## Goals
1. A skill always reaches the **correct, live** server for its workspace, or fails with a clear, actionable message — never a silent no-op.
2. Survive window reloads and host restarts transparently (retry across the restart gap).
3. Never route an agent to the wrong window's server (workspace-identity verification).
4. No token ever leaves the extension host. No format migration of any shipped state.

## Non-Goals
- No fixed/hardcoded port (would collide across windows).
- No moving tokens to disk / env vars.
- No change to how the tickets-tab webview works (already robust).
- No change to the on-disk port-file *format* (stays a plain port number — identity/liveness come over HTTP, avoiding any migration concern).

## Design

> **Naming note:** `/health`, `/api/clickup`, `/task/clickup`, `/resolve/...` are **HTTP routes** on the LocalApiServer (e.g. `GET http://localhost:<port>/health`) — they are *not* Switchboard skills and *not* slash commands. Skills (the `.agents/skills/*.md` files) are what agents run; those skills `curl` these HTTP routes.

### A. Extension-host side — `src/services/LocalApiServer.ts` + `src/services/TaskViewerProvider.ts`

1. **Enrich the `/health` HTTP route with workspace identity.** Return the root(s) this server serves so a skill can confirm it reached the right one:
   ```json
   { "status": "ok", "port": <n>, "effectiveRoot": "<abs path>", "roots": ["<abs path>", ...] }
   ```
   `effectiveRoot` = the server's `workspaceRoot`; `roots` = the same `allRoots` list the port file is written to. Keep this endpoint auth-free (it already is).

2. **Atomic port-file write.** Write to `api-server-port.txt.tmp` then `rename()` into place, so a skill can never `cat` a half-written file during the reload rewrite. Apply in **one** consolidated writer.

3. **Consolidate the two writers.** Remove the redundant `LocalApiServer._writePortFile` call to its own root, OR have `TaskViewerProvider` own all port-file writing. Pick one writer (recommend: `TaskViewerProvider`, since it already knows `allRoots`). The server returns its port; the provider writes the files atomically. Eliminates the race between the two.

4. **Clean up on stop.** In `_stopLocalApiServer`/`stop()`, delete the port file(s) for all roots this server wrote. Best-effort (ignore ENOENT). This narrows (does not eliminate — crashes skip it) the stale-file window; the skill-side health check is the authoritative defense.

5. **Liveness re-assert (lightweight, lower priority).** A periodic check (e.g. every 30s) that `_server.listening` is true; if not, restart and rewrite the port file. Also re-writes the port file on the interval so that in multi-window setups the most-recently-confirmed-live server keeps the shared file fresh. Implement only if it stays simple; the skill-side retry already covers the common reload gap.

### B. Skill side — `.agents/skills/*` (the 9 files below)

Replace the brittle discover-and-curl block with a **health-gated, retrying** call. To avoid 9 copies of the logic drifting, factor it into one shared helper and have each skill source it.

- **Helper:** `sb_api_call` — a small bash function that:
  1. Walks up from `$PWD` to find `.switchboard/api-server-port.txt` (unchanged discovery), remembering the directory it was found in (`SB_ROOT`).
  2. Curls the `/health` HTTP route (`GET http://localhost:<port>/health`); verifies `status == ok` **and** that `SB_ROOT` is in the returned `roots` (identity check — closes the multi-window cross-talk).
  3. If health fails (connection refused / wrong workspace / non-200): **retry with backoff**, mirroring the existing `ClickUpSyncService`/`LinearSyncService` pattern — `min(2^i * 1000, 5000)ms + jitter`, bounded (~5 attempts / ~10–12s) to cover a reload gap. Re-reads the port file each attempt (it may have been rewritten with a new port).
  4. On success, makes the real call, retrying once on transient connection failure / 5xx.
  5. On exhaustion, emits a **clear, actionable** JSON error to stderr and a non-zero exit: e.g. `{"error":"Switchboard API server not reachable for this workspace. Ensure the Switchboard extension is active in a VS Code window opened on this folder."}` — distinct from auth failures (401 surfaced verbatim).
  6. **Removes the dead `/config/token` fetch** entirely.

- **Helper placement** is the one implementation detail to settle first (see Open Implementation Detail). Default: ship the helper as `.agents/skills/_lib/sb_api_call.sh` and have each skill `source` it via an upward search (same walk-up used for the port file), so it works regardless of agent CWD.

### Blast radius — 9 skills to update
All in `/Users/patrickvuleta/Documents/GitHub/switchboard/.agents/skills/`:
`clickup_api.md`, `linear_api.md`, `clickup_create_task.md`, `clickup_attach.md`, `clickup_create_subpage.md`, `clickup_modify_task.md`, `clickup_fetch.md`, `generate_diagram.md`, `get_tickets.md`.
(6 of these also carry the dead `/config/token` line to remove: all except `clickup_api.md`, `linear_api.md`, `get_tickets.md`.)

## Open Implementation Detail (resolve at start of implementation, not a product decision)
**How are `.agents/skills/*` delivered to the environment where the agent runs?** If they ship as a bundled set in a known location, the shared-helper approach is clean. If skills can be copied/relocated individually such that `_lib/` may be absent, fall back to inlining the helper block into each skill (duplicated but self-contained). Determine by checking how skills are loaded/packaged; default to the shared helper and only inline if delivery can't guarantee the helper is reachable. This does not change the design, only the helper's physical placement.

## Step-by-step
1. Confirm skill delivery model (above); choose shared-helper vs inline.
2. `LocalApiServer.ts`: enrich the `/health` HTTP route's JSON response with `effectiveRoot` + `roots`.
3. Consolidate port-file writing into one atomic writer (temp + rename); remove the duplicate writer.
4. Add port-file cleanup on server stop/deactivate.
5. (Optional/lower priority) Add the liveness re-assert interval.
6. Author `sb_api_call` helper with health-gate, identity check, bounded backoff retry, clear errors, no `/config/token`.
7. Update all 9 skills to use the helper; delete the 6 dead `/config/token` lines.
8. `npm run compile` (required after `src/` changes; webpack bundles to `dist/`).
9. Verify (below).

## Verification
- **Cold start:** open workspace, run a `clickup_fetch`/`get_tickets` skill → succeeds.
- **Reload gap:** trigger a window reload, immediately run a skill → it retries across the gap and succeeds instead of failing.
- **Stale file:** kill the host / delete-and-corrupt the port to a dead port, run a skill → health-gate detects it, retries, then either recovers (if host comes back) or emits the actionable error (not a silent no-op).
- **Multi-window:** open the same workspace in two windows → a skill verifies identity via `/health.roots` and reaches a server that actually serves this root.
- **Auth distinct from down:** with no token configured, a write skill surfaces the 401/auth message, clearly different from the "server not reachable" message.
- **No token on disk:** grep confirms no token is written to any file/env by the new code.

## Risks & Mitigations
- *Retry adds latency to genuine "server down" cases* → bound attempts (~10–12s) and emit a clear final error so it never hangs indefinitely.
- *Helper not found if skills are relocated* → fall back to inlined block (Open Implementation Detail).
- *Identity check false-negative on mapped roots* → `roots` mirrors the exact `allRoots` (post `_filterMappedRoots`) the port file is written to, so membership matches by construction.
- *Migration* → no shipped on-disk state changes format; the port file stays a plain integer. No migration required.

## Metadata
**Complexity:** 5
**Tags:** reliability, api, backend, devops, bugfix
