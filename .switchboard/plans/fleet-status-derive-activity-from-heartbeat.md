# Fleet Status: Derive Activity from Heartbeat Instead of Process Liveness

## Goal

The `switchboard fleet` CLI command's STATUS column is misleading: it shows `active` for every seat whose shell process is alive, regardless of whether the agent is actively working or has been sitting idle at a prompt for minutes. This is especially problematic for planners, which never post completion (`done`/`submit_result`) — a planner that finished 10 minutes ago is visually identical to one deep in work.

### Root Cause

The `status` field on terminal handles is binary process liveness: `'active'` (set at creation) or `'exited'` (flipped only on the PTY's `onExit` event). It never transitions to an "idle" or "done" state while the shell process lives.

The `cmdFleet` table renderer (<ref_snippet file="/home/patrick/switchboard/src/standalone/cli.ts" lines="1753-1760" />) prints `t.status` directly, which is always `active` for live seats.

Meanwhile, the `ptyListTerminals` response already includes `lastDataAt` — a heartbeat timestamp updated on every byte of PTY output (<ref_snippet file="/home/patrick/switchboard/src/standalone/bootstrap.ts" lines="2481" />). The system already uses this internally to derive a "busy set" via `now - lastDataAt < livenessWindowMs` (default 90s) at <ref_snippet file="/home/patrick/switchboard/src/standalone/bootstrap.ts" lines="2817-2828" />. But `cmdFleet` ignores `lastDataAt` entirely.

### Fix

Derive a display status in `cmdFleet` from `lastDataAt` + the liveness window — the same threshold the server's internal busy-set logic uses. This is a presentation-layer change in the CLI. The `ptyListTerminals` response already carries `lastDataAt` (bootstrap.ts:2481), so no server-side fleet-service change is required **provided the host is running the binary-frame fix** (see Dependencies).

## Metadata

**Complexity:** 3
**Tags:** cli, bugfix, ux
**Project:** switchboard

## User Review Required

None. The derivation is a presentation-layer change; the one design decision (introducing a `stale`/`unknown` state for frozen heartbeats) is settled by the review-notes findings below.

## Complexity Audit

### Routine
- Single-file change in `src/standalone/cli.ts` (`cmdFleet`).
- Reuses fields already present in the `ptyListTerminals` response (`lastDataAt`, `status`).
- Table renderer and `--json` branch are local to `cmdFleet`; no cross-file coordination.

### Complex / Risky
- **Staleness vs idle distinction.** A frozen heartbeat (the `GoPtyFleetProjection` binary-frame defect) is positive and never advances, so it sails past a `lastDataAt === 0` guard and renders as a confident `idle`. The display must distinguish "measured and at rest" (`idle`) from "the clock stopped" (`stale`/`unknown`), or it reproduces the misleading-display defect with the opposite wrong answer.
- **Liveness window is a fourth copy of an unmeasured number.** `90000` already lives in `activityLight.livenessWindowMs`, `turnEndSilenceMs`, and `LocalApiServer.ts` (hardcoded). Hardcoding a fourth copy in the CLI lets the four drift; prefer reading the server's value.

## Edge-Case & Dependency Audit

**Race Conditions:** The CLI reads `lastDataAt` (stamped by the server's clock) and computes `now - lastDataAt` with its own `Date.now()`. Both run loopback on the same machine, so clock skew is not a concern. A seat that emits its last byte milliseconds before the read can flip `working`→`idle` between polls; this is correct — the poll is a snapshot, not a subscription.

**Security:** None. No auth, no user input, no privileged surface.

**Side Effects:** None. The change is pure presentation; the raw `status` field is preserved in `--json` output for backward compatibility. No server state is written.

**Dependencies & Conflicts:**
- **Host must run the binary-frame fix.** Until 2026-09-08, `GoPtyFleetProjection.socket.on('message')` parsed every frame as JSON and `return`ed on failure, while the Go host publishes output as a **binary** frame — so every chunk was discarded and `lastDataAt` never advanced. The fix is now in source (goPtyFleetProjection.ts:658-682: decode binary first, fall back to JSON for control frames). A host rebuilt from current source advances `lastDataAt` correctly; an older host freezes it and would render every working seat as `stale`. The manual tests require a current host.
- **`lastDataAt` is initialized positive, never `0`.** The Go host stamps `lastDataAt` at spawn (goPtyFleetProjection.ts:730: `row.lastDataAt || startedAtMs`). The `lastDataAt === 0` "no heartbeat yet" guard is therefore unreachable in practice; a stale heartbeat is positive-and-frozen, not zero. This is the same defect shape the nudge sweeps suffer (every one guards with `lastDataAt <= 0 || …` and fails open for the identical reason — a default that behaves like a real reading turns a loud failure into a quiet wrong answer).

## Dependencies

- `sess_20260908_GoPtyFleetProjection_binary_frame` — The `GoPtyFleetProjection` binary-frame decode fix (goPtyFleetProjection.ts:658-682) must be built into the running host before the manual verification. Without it `lastDataAt` never advances and every working seat renders `stale`. The fix is in source; the prerequisite is a rebuilt host, not a code change in this plan.

## Adversarial Synthesis

Key risks: (1) a frozen heartbeat is positive and frozen, not zero, so a naive `lastDataAt === 0` guard renders every working seat as a confident `idle` — the same misleading-display defect with the opposite wrong answer; (2) hardcoding `90000` adds a fourth copy of an unmeasured number that can silently drift from the server's value; (3) the plan's original "no server-side changes" claim was false as written because the runtime fleet class is `GoPtyFleetProjection`, whose binary-frame fix must be rebuilt before tests can pass. Mitigations: introduce a `stale`/`unknown` state distinct from `idle`; read `livenessWindowMs` from the server rather than hardcoding a fourth copy; treat the rebuilt host as an explicit prerequisite.

## Proposed Changes

### `src/standalone/cli.ts` — `cmdFleet` (line 1692)

**Context.** `cmdFleet` fetches `ptyListTerminals` (cli.ts:1712) and renders a compact table. The STATUS cell at cli.ts:1756 is `String(t?.status || (t?.alive || t?.active ? 'active' : 'idle'))` — always `active` for live seats because the projection emits only `friendlyName`/`role`/`status` (the `alive`/`active` fallbacks are dead and print `?`/`idle`). The `--json` branch (cli.ts:1721-1731) emits the `terminals` array verbatim with no activity derivation.

**Logic.** Add a local activity-derivation helper inside `cmdFleet` that computes a derived state per terminal from the fields already in the response. Derivation:

- If `t.status === 'exited'` → `'exited'`.
- If `t.status === 'active'` (or fallback) AND `lastDataAt` is a number:
  - If `now - lastDataAt < livenessWindowMs` → `'working'`.
  - If `now - lastDataAt >= livenessWindowMs` AND the heartbeat is plausibly recent (below a staleness ceiling — e.g. older than the seat's own start time by more than a multiple of the window, or beyond a ceiling no genuine mid-turn quiet stretch could reach) → `'idle`.
  - If the heartbeat is implausibly old (beyond the staleness ceiling) → `'stale'` (or `'unknown'`). `idle` must mean "measured, and at rest", never "the clock stopped".
- If `lastDataAt` is absent (older server response) → fall back to raw `t.status` (current behavior, backward compatible).

> **Superseded:** The original Step 1 treated `lastDataAt === 0` as `'working'` ("no heartbeat data yet means no evidence of rest").
> **Reason:** The Go host stamps `lastDataAt` at spawn (goPtyFleetProjection.ts:730), so the value is never `0` — it is positive and frozen when the heartbeat dies. The zero-check is unreachable; a stale heartbeat sails past it and lands in `idle`. This is the same fail-open shape the nudge sweeps suffer.
> **Replaced with:** A `stale`/`unknown` state for implausibly-old heartbeats, distinct from `idle`. `idle` is reserved for "measured, and at rest".

**Implementation.**
1. Resolve `livenessWindowMs` by reading the server's value rather than hardcoding a fourth copy. Prefer the `/health` endpoint if it exposes `livenessWindowMs` (the plan's own "future enhancement"); if it does not yet, hardcode `90000` as a local constant with a `TODO: read from /health once exposed` note, and record the divergence risk (Edge Case 4). Do not introduce a fourth copy silently.
2. Replace the STATUS cell derivation at cli.ts:1756 with the derived activity state. The column header stays `STATUS`; cell values become `working` / `idle` / `stale` / `exited`.
3. In the `--json` branch (cli.ts:1721-1731), enrich each terminal object additively (keep raw `status` for backward compatibility):
   - `activityState`: `'working'` | `'idle'` | `'stale'` | `'exited'`.
   - `secondsSinceLastData`: `Math.round((now - lastDataAt) / 1000)` when `lastDataAt` is available, omitted otherwise.
   - Emit `activityState` alongside `secondsSinceLastData` so a JSON consumer cannot re-derive `idle` from a frozen number.

**Edge Cases.**
1. **Freshly spawned seat** — `lastDataAt` is initialized to `startedAtMs` (goPtyFleetProjection.ts:730), so a new seat shows `working` for the first window. Correct: the shell emits its banner and the agent starts up.
2. **Frozen heartbeat** — renders `stale`, never `idle`. This is the state the review notes require; without it the display reproduces the defect it exists to fix.
3. **Older server without `lastDataAt`** — fall back to raw `t.status`; the table degrades to current behavior.
4. **Config divergence** — if an operator customized `activityLight.livenessWindowMs` on the server (standalone only; the extension host hardcodes 90000), a CLI-hardcoded window can mismatch the server's busy-set. Reading the server's value via `/health` eliminates this; until then the divergence is an accepted tradeoff for a presentation fix.
5. **Clock skew** — both clocks run loopback; not a concern.

## Verification Plan

### Automated Tests
- **Build**: `npm run build` (or the project's TypeScript compile step) — no type errors.
- Add a unit test for the derivation helper covering: `exited`, `working` (recent `lastDataAt`), `idle` (old but plausible `lastDataAt`), `stale` (implausibly old `lastDataAt`), and the absent-`lastDataAt` fallback. The helper is pure and trivially testable in isolation.

### Goal Invariants
- Assert `cmdFleet`'s STATUS cell is derived from `lastDataAt` (not raw `t.status`) for live seats — i.e. a seat with a recent `lastDataAt` renders `working`, not `active`.
- Assert a seat with an implausibly-old (frozen) `lastDataAt` renders `stale`, never `idle`.
- Assert the `--json` output includes `activityState` and `secondsSinceLastData` additively, and that raw `status` is still present.

### Manual Tests
1. **Prerequisite**: confirm the host is running the `GoPtyFleetProjection` binary-frame fix (goPtyFleetProjection.ts:658-682) before any manual test. On a stale host `lastDataAt` never advances and every working seat renders `stale`.
2. **Working state**: dispatch a plan to a seat, run `switchboard fleet` while the agent produces output. STATUS shows `working`.
3. **Idle state**: wait 90+ seconds after the agent stops producing output (shell still alive). Run `switchboard fleet`. STATUS shows `idle` (not `active`).
4. **Exited state**: close a terminal seat. Run `switchboard fleet`. STATUS shows `exited`.
5. **JSON**: run `switchboard fleet --json`. Each terminal object includes `activityState` and `secondsSinceLastData`; raw `status` is still present.
6. **Backward compatibility**: test against an older server response lacking `lastDataAt` — the table falls back to raw `status` without errors.

---

## Review notes appended 2026-09-08 (measured, not reasoned)

Three corrections. The plan's idea — a derived STATUS from the heartbeat — is right and
cheap. Its **source attribution is wrong**, and that changes the dependency and the verification.

### 1. The cited file is not the class that runs. "No server-side changes" is false as written.

The plan cited `src/standalone/ptyFleetService.ts` (`:461`, `:478`) as where `lastDataAt` is set, and
concluded *"No changes to `ptyFleetService.ts` … are needed."* At runtime, `ptyFleetService` **is** a
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
fixed (goPtyFleetProjection.ts:658-682) but **the fix needs a rebuild**; do not run this plan's manual
tests against a host without it. Manual test 2 ("verify STATUS shows working") fails today for
reasons that have nothing to do with the CLI.

### 2. The `lastDataAt === 0` guard is unreachable, so a stale heartbeat renders as a confident `idle`.

Edge case 2 treated `lastDataAt === 0` as `working` — "no heartbeat data yet means no evidence of rest".
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

Edge case 4 already conceded the CLI copy can diverge from a server-side override. The deeper problem
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
