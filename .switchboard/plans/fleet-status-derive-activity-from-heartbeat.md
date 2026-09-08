# Fleet Status: Derive Activity from Heartbeat Instead of Process Liveness

## Goal

The `switchboard fleet` CLI command's STATUS column is misleading: it shows `active` for every seat whose shell process is alive, regardless of whether the agent is actively working or has been sitting idle at a prompt for minutes. This is especially problematic for planners, which never post completion (`done`/`submit_result`) — a planner that finished 10 minutes ago is visually identical to one deep in work.

### Root Cause

The `status` field on terminal handles is binary process liveness: `'active'` (set at creation, <ref_snippet file="/home/patrick/switchboard/src/standalone/ptyFleetService.ts" lines="448" />) or `'exited'` (flipped only on the PTY's `onExit` event, <ref_snippet file="/home/patrick/switchboard/src/standalone/ptyFleetService.ts" lines="480-482" />). It never transitions to an "idle" or "done" state while the shell process lives.

The `cmdFleet` table renderer (<ref_snippet file="/home/patrick/switchboard/src/standalone/cli.ts" lines="1376-1383" />) prints `t.status` directly, which is always `active` for live seats.

Meanwhile, the `ptyListTerminals` response already includes `lastDataAt` — a heartbeat timestamp updated on every byte of PTY output (<ref_snippet file="/home/patrick/switchboard/src/standalone/ptyFleetService.ts" lines="478" />). The system already uses this internally to derive a "busy set" via `now - lastDataAt < livenessWindowMs` (default 90s) at <ref_snippet file="/home/patrick/switchboard/src/standalone/bootstrap.ts" lines="2195-2206" />. But `cmdFleet` ignores `lastDataAt` entirely.

### Fix

Derive a three-state display status in `cmdFleet` from `lastDataAt` + a 90s liveness window — the same threshold the server's internal busy-set logic uses. This is a pure presentation-layer change in the CLI; no server-side modifications, no new signaling, no changes to planner behavior.

## Metadata

**Complexity:** 2
**Tags:** cli, bugfix, ux
**Project:** switchboard

## Implementation Plan

### Step 1: Add activity-derivation helper in `cmdFleet`

In `src/standalone/cli.ts`, inside `cmdFleet` (line 1322), add a local helper that computes a derived activity state from the terminal fields already present in the `ptyListTerminals` response:

```
LIVENESS_WINDOW_MS = 90000  // matches activityLight.livenessWindowMs default
```

Derivation logic per terminal:
- If `t.status === 'exited'` → `'exited'`
- If `t.status === 'active'` (or fallback truthy) AND `lastDataAt` is a number:
  - If `lastDataAt === 0` → `'working'` (defensive: no heartbeat data yet means "no evidence of rest", matching bootstrap.ts:2204)
  - If `now - lastDataAt < LIVENESS_WINDOW_MS` → `'working'`
  - If `now - lastDataAt >= LIVENESS_WINDOW_MS` → `'idle'`
- If `lastDataAt` is absent (older server response) → fall back to raw `t.status` (current behavior, backward compatible)

### Step 2: Update the table renderer

Replace the current status derivation at cli.ts:1379:
```ts
const status = String(t?.status || (t?.alive || t?.active ? 'active' : 'idle'));
```
with the new derived activity state. The STATUS column header stays the same; only the cell values change from always-`active` to `working` / `idle` / `exited`.

### Step 3: Update the `--json` output

In the `--json` branch (cli.ts:1351-1359), enrich each terminal object in the `terminals` array with two additive fields (keep raw `status` for backward compatibility):
- `activityState`: `'working'` | `'idle'` | `'exited'` (the derived value)
- `secondsSinceLastData`: `Math.round((now - lastDataAt) / 1000)` when `lastDataAt` is available, omitted otherwise

This lets JSON consumers (scripts, the orchestrator) distinguish working from idle seats without re-deriving the logic.

### Step 4: No server-side changes

The `ptyListTerminals` response from both composition roots already includes `lastDataAt`:
- Standalone (bootstrap.ts:1913)
- Extension host subprocess (ptyHost.ts:174)

No changes to `ptyFleetService.ts`, `bootstrap.ts`, `ptyHost.ts`, or `LocalApiServer.ts` are needed.

## Edge Cases

1. **Freshly spawned seat** — `lastDataAt` is initialized to `Date.now()` at creation (ptyFleetService.ts:461), so a new seat shows `working` for the first 90s. This is correct: the shell is emitting its banner and the agent is starting up.

2. **`lastDataAt === 0`** — Should never happen (initialized to `Date.now()`), but treated as `working` to match the server's own guard at bootstrap.ts:2204.

3. **Older server without `lastDataAt`** — If the field is absent from the response (e.g., an older server version), fall back to displaying the raw `t.status` value. The table degrades gracefully to the current behavior.

4. **Config divergence** — If an operator has customized `activityLight.livenessWindowMs` on the server (standalone mode only; the extension host hardcodes 90000 at LocalApiServer.ts:4671), the CLI's hardcoded 90s window may not match the server's internal busy-set. This is an acceptable tradeoff for a presentation fix. A future enhancement could expose `livenessWindowMs` via the `/health` endpoint for config-aware derivation.

5. **Clock skew** — The CLI uses its own `Date.now()` for the `now - lastDataAt` computation, while `lastDataAt` was set by the server's clock. In practice both run on the same machine (loopback), so clock skew is not a concern.

## Verification Plan

1. **Build**: `npm run build` (or the project's TypeScript compile step) — no type errors.
2. **Manual test — working state**: Start a Switchboard instance, dispatch a plan to a seat, run `switchboard fleet` while the agent is producing output. Verify the STATUS column shows `working`.
3. **Manual test — idle state**: Wait 90+ seconds after the agent stops producing output (but the shell is still alive). Run `switchboard fleet`. Verify the STATUS column shows `idle` (not `active`).
4. **Manual test — exited state**: Close a terminal seat. Run `switchboard fleet`. Verify the STATUS column shows `exited`.
5. **JSON test**: Run `switchboard fleet --json`. Verify each terminal object includes `activityState` and `secondsSinceLastData` fields, and that raw `status` is still present.
6. **Backward compatibility**: If feasible, test against an older server response lacking `lastDataAt` — verify the table falls back to raw `status` display without errors.

---

## Review notes appended 2026-09-08 (measured, not reasoned)

Three corrections. The plan's idea — a three-state STATUS derived from the heartbeat — is right and
cheap. Its **source attribution is wrong**, and that changes Step 4 and the verification.

### 1. The cited file is not the class that runs. Step 4 is false as written.

The plan cites `src/standalone/ptyFleetService.ts` (`:461`, `:478`) as where `lastDataAt` is set, and
concludes *"No changes to `ptyFleetService.ts` … are needed."* At runtime, `ptyFleetService` **is** a
different class:

```ts
const ptyFleetService = new GoPtyFleetProjection(ptyHostSupervisor, workspaceRoot, db, resolvedToken);
// src/standalone/bootstrap.ts:3587
```

Output reaches `GoPtyFleetProjection` over a websocket from the Go PTY host, and until 2026-09-08 its
`socket.on('message')` parsed **every** frame as JSON and `return`ed on failure — while the host
publishes output as a **binary** frame (`main.go:246`, `encodeOutputFrame`). Every chunk was
discarded, so `lastDataAt` never advanced. Measured on the live board: a seat the operator was
watching work reported **531 minutes** since last data, and the liveness sweep logged `recorded=0` for
the entire session.

Built against that, this plan ships a STATUS column that prints `idle` for every working seat — the
same misleading-display defect it exists to fix, with the opposite wrong answer. The projection is
fixed but **the fix needs a rebuild**; do not run this plan's manual tests against a host without it.
Manual test 2 ("verify STATUS shows working") fails today for reasons that have nothing to do with the
CLI.

### 2. The `lastDataAt === 0` guard is unreachable, so a stale heartbeat renders as a confident `idle`.

Edge case 2 treats `lastDataAt === 0` as `working` — "no heartbeat data yet means no evidence of rest".
Correct intent, unreachable branch: the Go host stamps `lastDataAt` at spawn (`main.go:173`), so the
value is never `0`. It is **positive and frozen**, which sails past the zero-check and lands in
`now - lastDataAt >= LIVENESS_WINDOW_MS` → `idle`.

This is the same defeat the nudge sweeps suffer — every one guards with
`lastDataAt <= 0 || now - lastDataAt < turnEndSilenceMs` and fails open for the identical reason. Two
independent consumers, one defect shape: **the fail-safe tests for a *missing* value, and the value is
not missing — it is stale.** A default that behaves exactly like a real reading turns a loud failure
into a quiet wrong answer.

**Required change:** staleness needs its own state, distinct from `idle`. Derive `unknown` (or
`stale`) when the heartbeat is implausibly old — e.g. older than the seat's own start time by more
than some multiple of the window, or beyond a ceiling no genuine mid-turn quiet stretch could reach.
`idle` must mean "measured, and at rest", never "the clock stopped". Apply the same to
`secondsSinceLastData` in the `--json` branch: emit the derived state so a consumer cannot re-derive
`idle` from a frozen number.

### 3. `LIVENESS_WINDOW_MS = 90000` is a third hardcoded copy of a number nobody measured.

Edge case 4 already concedes the CLI copy can diverge from a server-side override. The deeper problem
is upstream: the 90s default was never measured. From
`feature_plan_20260808083000_pty-turn-end-from-output-silence.md`:

> "The 90s default is inherited from a neighbouring knob, not measured. If any CLI routinely exceeds
> it, raise the default rather than accepting false completions."

That plan's Verification step 2 — measure the real mid-turn quiet ceiling per CLI — is still
outstanding. It also warned at line 96 against reusing `livenessWindowMs` for a different question:
*"One number carrying two decisions is precisely how a heuristic degrades invisibly."* There are now
copies in `livenessWindowMs`, `turnEndSilenceMs`, `LocalApiServer.ts:4671` (hardcoded), and this plan
would add a fourth. Prefer reading the server's value (the plan's own "future enhancement" — expose it
via `/health`) over hardcoding, so the eventual measurement lands in one place.

### Verification additions

- Confirm the host is running the `GoPtyFleetProjection` binary-frame fix **before** any manual test.
- A seat with a frozen heartbeat renders as `unknown`/`stale`, never `idle`.
- A genuinely quiet-but-live seat renders `idle`; a seat producing output renders `working`.
