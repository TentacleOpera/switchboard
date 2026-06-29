# Fix Refresh Storm + Self-Healing API Server & Terminal Registry

## Goal

Stop the extension host from wedging (requiring a manual reload) and make the local API server and terminal-agent tracking recover on their own after any host blip. Symptom as reported: "send to terminal" can't find the agent terminals and the API server is unreachable (no `.switchboard/api-server-port.txt`), fixed only by reloading the extension.

### Problem & Background (root-cause analysis)

The host was **not** dead — it was **pinned**. Dev-tools logs showed `_refreshRunSheets` firing continuously, each iteration reading the full board (958 cards: 762 in CODE REVIEWED) and posting `updateBoard` to the webview. The decisive evidence: the column distribution was **byte-identical on every iteration** (`{"CODE REVIEWED":762,"PLAN REVIEWED":58,"CREATED":7,"CODER CODED":1,"BACKLOG":27,"INTERN CODED":3}`) — nothing was changing, so this is a pure refresh *loop*, not card churn.

The VS Code extension host is single-threaded. A continuous full-board refresh loop starves everything else on that thread:
- `LocalApiServer` request handling never gets a turn → `/kanban/move` etc. time out; if the loop is hot during activation, `_startLocalApiServer()` may not complete, so the port file is never written (and its failure is swallowed at `TaskViewerProvider.ts:988`).
- Terminal lookups (which `await` host calls) are starved → "send to terminal can't find the agent terminals."

Both the API server instance and the `registeredTerminals` map (`extension.ts` module scope) are **in-memory singletons** with no persistence, so a reload (which re-runs `activate()`) is the only thing that clears it today.

Three concrete bugs were confirmed from the logs (the first is the loop's collateral, the others are independent):

1. **`exportStateToFile` had no mutex/debounce** (`KanbanDatabase.ts`, called fire-and-forget from every `_persist()`). Concurrent calls wrote the **same** `kanban-state-*.md.tmp` path and raced on `rename` → `ENOENT: ... rename 'kanban-state-backlog.md.tmp' -> 'kanban-state-backlog.md'`. (`_persist` already avoided this for the DB file with a crypto-random tmp suffix; the state export never got the same treatment.)
2. **Jules status poll ran unconditionally** (`TaskViewerProvider.ts:442` starts a 30 s `setInterval` in the constructor with no gate; `_refreshJulesStatus` spawns `jules remote list` before checking for any tracked sessions). With Jules uninstalled/unused, every tick logged `spawn jules ENOENT`.
3. **Host-level `[createInstance] aoe depends on UNKNOWN service agentSessions`** — this is **Antigravity IDE internal**, not Switchboard. Flagged for the IDE side; relevant only because Switchboard's terminal/agent tracking runs inside that host.

## Metadata

**Complexity:** 6
**Tags:** bug, reliability, backend, performance, devops
**Repo:** (single-repo)
**Affves:** published extension, ~4,000 installs — changes touch hot paths; review + manual verification required.

## Already Applied (in this session — verify, then review)

These contained, high-confidence fixes were made directly in `src/` (source of truth):

1. **`exportStateToFile` single-flight + unique tmp suffix** — `KanbanDatabase.ts`:
   - Added `_exportStateInFlight` / `_exportStatePending`; while one export runs, further calls set a pending flag and exactly one trailing export runs after. Collapses the burst.
   - Per-column and board tmp files now use `crypto.randomBytes(4)` suffixes, so even concurrent writers can never collide on the same `.tmp` → eliminates the ENOENT-on-rename race.
2. **Jules poll gated on usage** — `TaskViewerProvider.ts` `_refreshJulesStatus`: early-return when `_getTrackedJulesSessions()` is empty (no Jules sessions ⇒ never spawn the CLI). Confirmed the `_isRefreshingJules` reset is in a `finally` (`:17353`), so the early return is safe.
3. **Diagnostic instrumentation** — `TaskViewerProvider.ts` `_refreshRunSheets`: logs the immediate caller frame (`new Error().stack`). The frame that repeats names the storm's trigger. **Temporary — remove once the driver is fixed (see Task 1).**

## Proposed Changes (remaining)

### Task 1 — Pin and fix the refresh-loop driver
**Status:** blocked on the instrumentation output (rebuild VSIX → reload → read the repeating `[refreshRunSheets] caller:` frame).
- Fix the over-caller at its source (likely the `ready` → `fullSync` path in `KanbanProvider.ts:4949` re-firing, or a timer/event cascade — confirm via the instrumented frame).
- **Trigger-independent guard (do regardless):** add a single-flight guard to `_refreshRunSheets` (drop or coalesce overlapping calls) and route the ~10 direct call sites through the existing 200 ms-debounced `refresh()` (`TaskViewerProvider.ts:2612`) where appropriate.
- **Identical-snapshot skip:** hash the active/completed snapshot and skip the `postMessage`/`refreshWithData` when unchanged from the last push. On a static board this structurally breaks any ping-pong loop and slashes cost on large boards.
- Remove the temporary diagnostic `console.log` once the driver is fixed.

### Task 2 — Self-healing local API server
**File:** `TaskViewerProvider.ts` (`_startLocalApiServer` ~`:974`), `LocalApiServer.ts`.
- Stop swallowing the start failure at `:988` — log to the Switchboard output channel and surface a status-bar indicator so a dead server is visible, not silent.
- Handle `EADDRINUSE` by trying the next port instead of failing.
- Add a lightweight watchdog (interval or lazy check) that verifies the server is listening and `api-server-port.txt` matches; if missing/dead, restart and rewrite the port file. This removes the "no port file ⇒ manual reload" failure mode.

### Task 3 — Re-adoptable terminal registry
**Files:** `extension.ts` (`registeredTerminals`), `TaskViewerProvider` terminal tracking.
- Persist the terminal→agent/session association (encode it in the terminal name, or store a map in the DB/globalState) so it survives loss of in-memory state.
- On `activate()`, re-adopt existing VS Code terminals by matching names/encoded ids instead of relying solely on the empty in-memory `registeredTerminals`.
- Then "send to terminal" re-finds its target after a host blip with **no reload**.

### Task 4 — Harden the Jules gate (follow-on to the applied fix)
**File:** `TaskViewerProvider.ts`.
- On a `spawn jules ENOENT`, set a `_julesCliUnavailable` flag and `clearInterval(this._julesStatusPollTimer)` (declared `?:` at `:291`; cleanup pattern already exists at `:18351`) so even stale tracked sessions can't reintroduce the spawn spam.
- Optionally probe for the binary once before starting the timer in the constructor.

## Edge-Case & Dependency Audit

- **Single-flight trailing run (applied):** the `finally` re-invokes `exportStateToFile()` only if a request arrived mid-flight, guaranteeing the latest state is always written exactly once after a burst. No lost final write.
- **Jules gate (applied):** if a user later dispatches to Jules, `tracked` becomes non-empty and polling resumes automatically — no toggle needed. The `finally` at `:17353` still clears `_isRefreshingJules` on the early return.
- **Identical-snapshot skip (Task 1):** must compare *effective* snapshot (post repo-scope/project filter) and must still push after a workspace/filter switch — key the cache by `(workspaceId, projectFilter, repoScope)` so a context switch always re-pushes.
- **API watchdog (Task 2):** must not double-start; reuse a single start path with an `isListening` check. Port-file writes already use tmp+rename (`:982`) — keep that.
- **Terminal re-adoption (Task 3):** must not adopt unrelated user terminals — match only Switchboard-encoded names. `deactivate()` disposes registered terminals (`extension.ts:3637`); re-adoption must reconcile with that on a clean reload.
- **Migration:** no persisted-state schema changes except Task 3's optional association store (additive). Per the migration rule, keep it additive and tolerate its absence.

## Verification Plan

> Suite run separately by the user; extension can't be exercised in the planning session.

1. **Export race (applied):** rapid board mutations no longer produce `ENOENT ... rename kanban-state-*.md.tmp`; state files still update to the latest board.
2. **Jules (applied):** with no Jules sessions, `spawn jules ENOENT` no longer appears in the dev console; dispatching to Jules resumes polling.
3. **Refresh driver (Task 1):** after instrumentation, the repeating caller frame is identified; after the fix, `_refreshRunSheets` no longer loops on a static board (the identical-distribution log stops repeating).
4. **API self-heal (Task 2):** kill/неstart the server or delete the port file at runtime → watchdog restarts it and rewrites `api-server-port.txt` without a reload; `create-epic.js`/`move-card.js` work again.
5. **Terminal self-heal (Task 3):** force an extension-host restart with agent terminals open → "send to terminal" still targets the right terminal without a reload.

## Out of Scope

- The Antigravity host `agentSessions` error (IDE-internal; report upstream).
- Reducing board size / archiving the 762 CODE REVIEWED cards (separate housekeeping — though it would reduce per-refresh cost).
- Rewriting the webview render path.

## Recommendation

Complexity 6 → **Send to Coder.** Tasks 1–3 touch hot paths in a 4,000-install extension and need real manual verification. Task 1's driver fix should follow the instrumentation read; the single-flight guard + snapshot-skip and Tasks 2–3 are the durable self-healing layer.
