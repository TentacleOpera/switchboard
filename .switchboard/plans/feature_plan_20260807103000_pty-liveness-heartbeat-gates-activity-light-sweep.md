# PTY Output Liveness Must Gate the Activity-Light Timeout Sweep

## Goal

Stamp a `lastDataAt` heartbeat on every PTY-fleet terminal from the output stream the gateway already receives, expose it on `ptyListTerminals`, and let the activity-light stale sweep consult it — so a card whose agent is demonstrably still producing output stops being force-cleared at the timeout, and a card whose terminal has gone silent *and* exited stops burning the full window.

### Problem

Completion is measured by one signal: the plan file's mtime advancing. Dispatch stamps `dispatched_at` (`updateDispatchInfoByPlanFile`, `KanbanDatabase.ts:9531`, UPDATE at `:9545`); the plan-file watcher re-ingests the file and nulls it (`PlanIngestionEngine.ts:853` → `KanbanDatabase.ts:9588`); a periodic sweep nulls anything older than `switchboard.activityLight.timeoutMs` (`PlanIngestionEngine.ts:250`, default 600000 — `package.json:557`).

The sweep is a blind timer, and it is wrong in both directions:

| Reality | Board shows | Duration of the lie |
|---|---|---|
| Agent died / was killed at minute 1 | Working | 9 minutes |
| Agent legitimately grinding one plan for 25 min without touching the file | Working → **cleared at minute 10** | 15 minutes reading as abandoned |

The second case is the damaging one. A long single-plan run silently loses its light, and every downstream consumer that reads `working` — the board light, `getFeatureWorkingStates` (`KanbanDatabase.ts:6180`), the browser Terminals completion toast — reports an idle seat that is in fact mid-turn. The operator's actual question ("which seat needs me?") gets a wrong answer.

### Root cause

The sweep has no liveness input. It cannot have one on a native `vscode.Terminal` seat — output is unreadable in the stable API — and that limitation was allowed to define the design for *every* seat. It does not apply to PTY-fleet seats: `TerminalWsGateway.trackTerminalData` (`src/standalone/terminalWsGateway.ts:386-406`) already receives every byte via `node-pty.onData` and fans it to xterm. The signal is sitting in the process and is thrown away.

Note the fleet is **not** standalone-only. The extension forks `dist/standalone/ptyHost.js` as a child (`TaskViewerProvider.ts:1908`) and forwards verbs over HTTP (`_ptyHostVerb`, `:377`). So this lands on both hosts for any fleet seat; only native `vscode.Terminal` seats are excluded, and they degrade to today's behaviour.

### Root cause, second half — the timeout is implemented three times, not once

**This is the finding that determines the shape of the plan, and it was missed in the original draft.** Nulling `dispatched_at` in the sweep is only one of three independent places the 10-minute window is enforced. All three read the same setting and each re-derives the cutoff itself:

| # | Site | Mechanism | Effect |
|---|---|---|---|
| 1 | `KanbanDatabase.clearStaleWorkingState` (`:9603`) | SQL `WHERE dispatched_at < cutoff` → sets `dispatched_at = NULL` | Destroys the row's dispatch state |
| 2 | `isWorkingState` — **two copies**: `KanbanProvider.ts:142` and `bootstrap.ts:148` | Read-time `(Date.now() - Date.parse(dispatchedAt)) < timeoutMs` | Card renders `working: false` regardless of the DB |
| 3 | `KanbanDatabase.getFeatureWorkingStates` (`:6180`) | SQL `MAX(dispatched_at IS NOT NULL AND dispatched_at >= cutoff)` | Feature rollup light |

Consumer #2 is stamped at four card-build sites — `KanbanProvider.ts:1845`, `:3474`, `:3679`, and `bootstrap.ts:196` — plus a fifth builder, `KanbanProvider._buildCardsFromDbSessionIds` (`:7369`), which hardcodes `working: false` outright.

The consequence is decisive: **sparing the DB row does nothing the user can see.** A card at minute 10:01 whose row the sweep politely skipped is still rendered dark, because `isWorkingState(row.dispatchedAt)` independently recomputes the age at card-build time and returns `false`. The light goes out on schedule. Only the column survives.

Any design that gates consumer #1 alone therefore satisfies its own success check ("the sweep no longer nulled the row") while leaving the stated goal — the light stays on — completely unmet. The fix must move all three consumers onto one widened age basis, or it is not a fix.

### Why liveness and not completion

Raw byte activity cannot mark completion — Claude Code repaints its spinner and status line continuously, so bytes never stop flowing while the CLI is merely open at an idle prompt. That same property is exactly what makes it a *sound liveness signal*: a dead, wedged, or backgrounded process emits literally nothing. This plan deliberately buys only the claim raw bytes can support. Turning output into a completion signal requires screen-state diffing (sibling plan, `pty-screen-state-idle-detection-headless-vt`) or an agent-emitted event (sibling plan, `agent-emitted-completion-via-cli-hooks`).

## Metadata

- **Complexity:** 7
- **Tags:** backend, reliability, terminals, kanban, database

> **Superseded:** **Complexity:** 5
> **Reason:** The original score assumed the change was confined to the sweep plus a heartbeat field. Verification against the code found the timeout enforced in three independent implementations (see "Root cause, second half"), which pulls in a schema migration (V58), two duplicated `isWorkingState` copies across both hosts, a SQL rollup, and four card-build sites. Multi-file coordination across two hosts plus a data-consistency surface is a 7, not a 5.
> **Replaced with:** **Complexity:** 7 — Lead Coder.

## User Review Required

None.

## Complexity Audit

### Routine

- Adding a `lastDataAt` field to `ExtendedTerminalHandle` and stamping it from `onData`.
- Adding the field to both `ptyListTerminals` response shapes.
- Threading a getter into the engine constructor options alongside the existing seams.
- One new `package.json` setting.

### Complex / Risky

- **The timeout has three independent implementations and only one is the sweep.** See "Root cause, second half". Gating the sweep alone is a no-op at the user-visible layer. All three must move onto the same widened age basis in one change, or the plan ships a green test and a dark light.
- **`ptyListTerminals` exists twice and both arms are live.** `ptyHost.ts:89-102` (child-process arm, used by the extension) and `bootstrap.ts:1122-1142` (in-process arm, used by standalone). They already differ — the bootstrap arm adds `parentRoot`/`parents` resolution the ptyHost arm lacks. Adding the field to one and not the other produces a heartbeat that works on exactly one host, which is the failure this plan exists to stop repeating. Edit both.
- **Neither arm returns a `name` field.** Both map `{friendlyName, role, status, pid, startTime, worktreePath, cwd}`. There is no `name` in the payload, so the join key against `plans.dispatched_terminal` must be **`friendlyName`**. This is safe rather than merely convenient: `PtyFleetService.rename` (`:159-171`) assigns the new alias to *both* `handle.friendlyName` and `handle.name`, so the two never diverge. Do not add a redundant `name` field to the payload; name the join key correctly instead.
- **The heartbeat lives in the gateway, the fleet is the natural owner.** `trackTerminalData` is on `TerminalWsGateway`, but `ptyListTerminals` reads `PtyFleetService.list()`. The gateway is constructed *conditionally* (`bootstrap.ts:1509-1510`, only when `ptyReady`), so a heartbeat owned solely by the gateway is absent whenever the gateway is absent — while the fleet, and therefore the verb, still exists. Put the timestamp on the fleet handle (`ExtendedTerminalHandle`, `ptyFleetService.ts:28-37`) and have the fleet subscribe to its own `onData` at `create()` time (`:75-118`), independent of the gateway. The gateway keeps doing what it does.
- **Operator-killed terminals leave no corpse.** `PtyFleetService.kill` (`:147-157`) calls `this.terminals.delete(name)` **before** `handle.kill()`, so the handle never appears in `list()` again and `status: 'exited'` is never observable for an operator kill. Only a self-exit (`onExit`, `:103-111`) leaves the handle in the map with `status: 'exited'` — that path does *not* delete. The fleet therefore needs a bounded `recentlyClosed` tombstone map fed from the `{type:'closed'}` change event, which fires on **both** paths (`:154` for kill, `:109` for self-exit). Without it the exited-terminal force-clear is structurally unreachable for the most common way a terminal dies.
- **`clearStaleWorkingState` is a single SQL UPDATE over all rows** (`KanbanDatabase.ts:9603-9622`). Making it liveness-aware without a per-row exclusion list is only possible because the widened age basis lives in the row itself (see Proposed Changes §5). Keep the statement shape a single blanket UPDATE; change what it compares, not how many statements it is.
- **`PlanIngestionEngine` is host-agnostic by construction** and must not import the fleet. The liveness lookup has to arrive as an injected callback in the same shape as `setOnWorkingStateCleared` (`:144`) / `setFeatureColumnRecomputer` (`:136`). Wiring it any other way couples the ingestion engine to node-pty and breaks the standalone/extension seam split.
- **Config must be read through the host seam.** The engine already reads `this._host.getConfig('activityLight')` (`PlanIngestionEngine.ts:243`). `KanbanProvider.ts:142`'s `isWorkingState` reads `vscode.workspace.getConfiguration` inline — a pre-existing violation of PRD contract #3 (host-agnostic via seams). Do not copy that pattern for the new value: `bootstrap.ts:148` already takes `timeoutMs` as a parameter, and that is the shape to converge on.
- **Attribution depends on `dispatched_terminal` being populated.** It is written by `updateDispatchInfoByPlanFile` (`KanbanDatabase.ts:9545`) but is `''` when the dispatcher had no terminal name (see the note at `TaskViewerProvider.ts:912`). A row with an empty `dispatched_terminal` has no liveness evidence and must fall through to today's blind timeout — not be treated as live.
- **Migration ownership.** This plan takes **V58**. The highest shipped migration is V57 (`MIGRATION_V57_SQL`, `KanbanDatabase.ts:413`; chain block `:8162-8171`). The sibling `agent-emitted-completion-via-cli-hooks` plan originally also claimed V58 for `blocked_at`; it moves to **V59**. Two plans cannot both be V58 — whichever landed second would be silently skipped by the `getMigrationVersion()` gate and its column would never be added.

## Edge-Case & Dependency Audit

### Race conditions

- **Sweep cadence vs. heartbeat cadence.** The sweep runs on `planWatcher.scanIntervalMs` (default 10000, `PlanIngestionEngine.ts:227`); output arrives at `OUTPUT_FLUSH_MS = 6` (`terminalWsGateway.ts:91`). Do not write the heartbeat to the DB per chunk — keep it in memory on the handle and read it at sweep time. A DB write per flush would be ~166 writes/sec/terminal against sql.js and is a direct route to the known WASM heap exhaustion failure. The one permitted DB write is the sweep's own once-per-tick `last_liveness_at` persist (§5), which is ~1 write per live card per 10 s.
- **Heartbeat subscription vs. startup-command injection.** Subscribe to `onData` immediately after the handle is constructed and **before** `await this.injectStartupCommand(handle, role)` (`:116`). That call awaits `SHELL_READINESS_DELAY_MS` before typing, so subscribing after it would blind the heartbeat for the whole delay window and lose the shell's own banner output.
- **Stale extension-host cache.** A stale cache entry biases toward "still live", which is the safe direction — it delays a clear, it never fabricates one.

### Security

- No new surface. No new route, no new token, no user-supplied input reaches SQL — the exclusion/force sets are derived from fleet-internal terminal names, and `last_liveness_at` is a server-generated timestamp.

### Side effects

- **Do not extend indefinitely.** An agent that hangs mid-turn with a repainting spinner is live-by-bytes forever. Cap the extension at `3 × timeoutMs` measured from the original `dispatched_at` (which §5 preserves, and which is exactly why it must not be overwritten). Without a cap this replaces a false-off bug with a permanent stuck-on bug, which is worse — a stuck light is unfalsifiable.
- **One extra column on `plans`.** `last_liveness_at TEXT DEFAULT NULL`. Additive, nullable, ignored by every existing read.

### Dependencies & conflicts

- **Terminal renamed mid-run.** `PtyFleetService.rename` (`:159-171`) changes the map key and both `friendlyName` and `name`; the gateway already has `rekeyTerminal` (`terminalWsGateway.ts:634`) for exactly this. `plans.dispatched_terminal` still holds the *old* name and is not rewritten. A renamed seat therefore looks dead to the sweep. Match on the fleet handle's current `friendlyName` **and** treat a miss as "no evidence" (fall through to the timer), never as "confirmed dead".
- **Terminal exited.** An exited terminal is positive evidence of *not working* — the one case where the signal should shorten rather than extend the window. Clear immediately rather than waiting out the remaining timeout. Requires the `recentlyClosed` tombstone above to cover operator kills.
- **Fleet unavailable.** `isPtyAvailable()` false (`bootstrap.ts:496`), `ptyReady` false, or the ptyHost child failed to boot (`_ptyHostBootFailed`, `TaskViewerProvider.ts:575`). The getter returns no data, nothing writes `last_liveness_at`, and `MAX(dispatched_at, NULL)` degenerates to `dispatched_at` — the sweep and both read paths behave exactly as they do today. This is the compatibility contract for fleet-less hosts and it falls out of the design rather than needing a branch.
- **Extension host cross-process latency.** On the extension the fleet lives in a forked child; the sweep runs in the extension host. Do not add a synchronous HTTP call into the sweep loop. Cache liveness off the `ptyListTerminals` forward `TaskViewerProvider` already performs (`:428-432`) and let the sweep read the cache.
- **Do not repurpose `_ptyTerminalNames`.** That existing cache (`TaskViewerProvider.ts:428-431`, declared `:585`) filters `t.status === 'active'` and maps to bare names, because its consumer is `getRegisteredTerminals` — whose contract is *active* names for the `/kanban/dispatch` 409 guard (LocalApiServer ~1205). Reusing it for liveness discards the exited entries the force-clear depends on. Add a separate all-statuses `{ friendlyName, lastDataAt, status }` cache alongside it and leave `_ptyTerminalNames` semantics untouched.
- Sibling (ordering: this plan first): `agent-emitted-completion-via-cli-hooks` — supersedes this as the *completion* signal but not as the *liveness* signal; both are wanted. It takes V59 and extends the same three derived-state consumers for `blocked`.
- Sibling (ordering: this plan first): `pty-screen-state-idle-detection-headless-vt` — consumes the same `onData` subscription and the same `recentlyClosed` tombstone this plan establishes.

## Dependencies

- No blocking prerequisites. This plan is self-contained and ships alone.
- Owns **V58** and owns the widening of all three derived-state consumers. Both siblings build on that end-state.

## Adversarial Synthesis

Key risks: (1) the original design gated only the sweep and would have shipped a passing test with a dark light — corrected by moving all three timeout consumers onto `MAX(dispatched_at, last_liveness_at)`; (2) operator-killed terminals are deleted from the fleet map, making the exited force-clear unreachable without a `recentlyClosed` tombstone; (3) byte liveness is permanently true for a wedged agent, so the `3 × timeoutMs` hard cap measured from the untouched `dispatched_at` is load-bearing, not defensive. Mitigations: one widened age basis persisted in the row rather than three injected getters; a tombstone fed from the `closed` event that fires on both death paths; a cap that cannot itself be extended.

`dispatched_at` remains the sole source of truth for *when the turn started* and is never rewritten. `last_liveness_at` only ever modulates *when the timeout backstop is allowed to fire*. If the liveness provider is removed tomorrow, the column stays NULL and the system reverts to current behaviour exactly.

The secondary objection — that a 10-minute default is simply too short and the honest fix is raising it — trades one lie for the other: raising the timeout lengthens the stuck-on window for genuinely dead agents proportionally. Liveness is what lets the two cases separate.

## Proposed Changes

### 1. `src/standalone/ptyFleetService.ts` — own the heartbeat and the tombstone on the fleet

- Add `lastDataAt: number` to `ExtendedTerminalHandle` (`:28-37`), initialised to creation time.
- In `create()` (`:75-118`), immediately after the handle is constructed and **before** `await this.injectStartupCommand(handle, role)` (`:116`), subscribe `handle.onData(() => { handle.lastDataAt = Date.now(); })`. Assignment only — no allocation, no timer, no I/O. This subscription is independent of the gateway's, so it survives `ptyReady === false` for the WS path.
- In the existing `onExit` handler (`:103-111`), leave `lastDataAt` frozen at its final value; `status: 'exited'` is the signal consumers key on.
- Add a bounded `private recentlyClosed = new Map<string, number>()` (name → `closedAt`), capped at e.g. 64 entries with oldest-first eviction. Populate it from **both** death paths — the `onExit` handler (`:103-111`) and `kill()` (`:147-157`) — or equivalently from a single subscription to the fleet's own `{type:'closed'}` change event, which both paths emit (`:109`, `:154`). `rename()` must migrate any tombstone under the old key.
- Add `getLiveness(): Array<{ friendlyName: string; lastDataAt: number; status: 'active' | 'exited' }>` reading `this.terminals` **plus** `this.recentlyClosed` (tombstones reported as `status: 'exited'`).

### 2. `src/standalone/ptyHost.ts:89` and `src/standalone/bootstrap.ts:1122` — expose it on both arms

Add `lastDataAt: t.lastDataAt` to the mapped terminal object and keep the existing `status`. **Both files.** The bootstrap arm additionally spreads `parentRoot` and returns `parents`; do not disturb either. Note that `friendlyName` is already present in both payloads and is the join key — no `name` field is being added.

### 3. `src/services/TaskViewerProvider.ts:428` — cache liveness on the extension host

The `ptyListTerminals` forward already post-processes the result to refresh `_ptyTerminalNames`. Add a **separate** all-statuses cache — `private _ptyLiveness: Array<{ friendlyName, lastDataAt, status }> = []` — populated from the same result without the `status === 'active'` filter, and expose a synchronous `getFleetLiveness()` reader. Leave `_ptyTerminalNames` and its filter exactly as they are.

> **Superseded:** "Extend that cache to retain `{ name, lastDataAt, status }`."
> **Reason:** `_ptyTerminalNames` filters `status === 'active'` before storing, so extending it in place silently drops every exited terminal — the exact rows the force-clear needs. It also serves an unrelated contract (`getRegisteredTerminals` → the `/kanban/dispatch` 409 guard) that expects active-only names, so widening it is a behaviour change on a shipped path.
> **Replaced with:** A second, sibling cache holding all statuses, keyed on `friendlyName`, with `_ptyTerminalNames` untouched.

No new HTTP traffic — this rides the forward that already happens.

### 4. `src/services/KanbanDatabase.ts` — V58 migration

- New `MIGRATION_V58_SQL`: `ALTER TABLE plans ADD COLUMN last_liveness_at TEXT DEFAULT NULL`. Add the column to the `CREATE TABLE plans` body (`:155` area) as well, so fresh DBs get it from creation and the migration is a no-op there.
- Append the gate block after the V57 block, which ends at `:8171`. Use the `pragma_table_info` existence guard V51 uses (`:8063`) or the simpler `try { exec } catch {}` shape V54/V56/V57 use (`:8110`, `:8155`, `:8165`) — either is acceptable; match V57 for consistency with its neighbours.
- **Do not touch the body of any of V51–V57.** Standing repo rule: never edit a shipped `MIGRATION_Vnn_SQL`, never stamp a baseline to skip the chain, and remember `SCHEMA_TABLES` is not the current schema — a fresh DB replays V20→V58.
- Add `last_liveness_at` to `PLAN_COLUMNS` (`:789` area) and to the row→record mapping (`:9747` area) so the read paths can see it.
- Add `public async recordLiveness(workspaceId, terminalNames: string[], atIso: string): Promise<number>` — one UPDATE setting `last_liveness_at = ?` for rows whose `dispatched_terminal IN (...)` and `dispatched_at IS NOT NULL`.

### 5. `src/services/KanbanDatabase.ts:9603` — widen the sweep's age basis

> **Superseded:** Change `clearStaleWorkingState(workspaceId, maxAgeMs)` to accept `opts?: { skipTerminals?: string[]; forceTerminals?: string[] }`, appending a `dispatched_terminal NOT IN (...)` exclusion and a second force-clear statement.
> **Reason:** A caller-supplied exclusion set gates only this one consumer. The two read-time consumers (`isWorkingState` ×2 and `getFeatureWorkingStates`) recompute the age independently and would still render the card dark at minute 10:01 — so the plan would pass its own check while the light still went out. An exclusion list also cannot be shared with those consumers, because they run in the card-build path on both hosts and would each need their own cross-process fleet lookup.
> **Replaced with:** Persist liveness into the row (`last_liveness_at`, §4) and widen the age basis to `MAX(dispatched_at, last_liveness_at)` in **all three** consumers. The sweep stays a single blanket UPDATE; the skip set becomes unnecessary because a live card's basis is already recent. Only the exited force-clear needs an explicit list.

- Keep the signature as `clearStaleWorkingState(workspaceId, maxAgeMs, opts?: { forceTerminals?: string[] })`.
- Change the WHERE clause from `dispatched_at < cutoff` to `MAX(dispatched_at, COALESCE(last_liveness_at, dispatched_at)) < cutoff AND dispatched_at >= hardCapCutoff` — where `hardCapCutoff = now - 3 * maxAgeMs`. Rows past the hard cap fall out of the skip and are cleared however live they look.

  Correction: express the cap as a second condition that *forces* clearing rather than one that prevents it — `(basis < cutoff OR dispatched_at < hardCapCutoff)`. Written the first way a capped row is excluded from the sweep instead of cleared by it.
- `forceTerminals` → a second statement clearing rows whose `dispatched_terminal` is in the set regardless of age (the exited case).
- Also null `last_liveness_at` wherever `dispatched_at` is nulled, here and in `clearWorkingState` (`:9588`), so a re-dispatch starts from a clean basis.
- With `opts` omitted and the column NULL everywhere, `MAX(dispatched_at, COALESCE(NULL, dispatched_at))` is `dispatched_at` and the statement is semantically identical to today's. That is the fleet-less compatibility contract.

### 6. Widen the two read-time consumers — the part without which nothing is fixed

- **`isWorkingState`, both copies.** `KanbanProvider.ts:142` and `bootstrap.ts:148`. Change the signature to take the record (or an explicit `lastLivenessAt`) and compute the age from `max(Date.parse(dispatchedAt), Date.parse(lastLivenessAt ?? dispatchedAt))`, with the same `3 × timeoutMs`-from-`dispatchedAt` hard cap. Pass `timeoutMs` in as a parameter in the `KanbanProvider` copy too — matching `bootstrap.ts:148` — instead of reading `vscode.workspace.getConfiguration` inline (PRD contract #3).
- **The four call sites** stamping `working:` — `KanbanProvider.ts:1845`, `:3474`, `:3679`, `bootstrap.ts:196` — pass the new argument. All four, in one change; three-of-four is the known duplicated-builder trap and produces a light that depends on which refresh path ran.
- **`KanbanProvider._buildCardsFromDbSessionIds` (`:7369`)** hardcodes `working: false`. Determine whether that path is reachable — it is keyed on the deprecated `session_id` rather than `plan_id` — and either wire it correctly or delete it. Do not leave a fifth builder that silently disagrees with the other four. If it is dead, removing it is in scope; if it is live, it is a pre-existing bug this plan should not paper over.
- **`getFeatureWorkingStates` (`KanbanDatabase.ts:6180`).** Change `dispatched_at >= ?` to `MAX(dispatched_at, COALESCE(last_liveness_at, dispatched_at)) >= ?` so the feature rollup agrees with its own subtask cards.

### 7. `src/services/PlanIngestionEngine.ts:250` — consult the injected getter and persist what it learns

- Add `setTerminalLivenessProvider(fn: () => Array<{ friendlyName: string; lastDataAt: number; status: string }>)` alongside the existing seams (`:136`, `:144`).
- In the sweep, before calling `clearStaleWorkingState`: partition the fleet into `active && (Date.now() - lastDataAt) < livenessWindowMs` → call `db.recordLiveness(wsId, thoseNames, nowIso)`; and `status === 'exited'` → pass as `forceTerminals`.
- Read `livenessWindowMs` via the existing `this._host.getConfig('activityLight')` handle (`:243`), not `vscode.workspace`.
- Log the recorded/forced counts on the existing sweep log line (`:252-254`) so a stuck light is diagnosable from the output channel rather than by guesswork.

### 8. Wire the seam on both hosts

- `src/extension.ts` — adjacent to the `setOnWorkingStateCleared` wiring at `:1070`: `globalPlanWatcher.getEngine().setTerminalLivenessProvider(() => taskViewerProvider.getFleetLiveness())`.
- `src/standalone/bootstrap.ts` — the engine is constructed at `:305` and its seams are wired at `:426` (`setOnWorkingStateCleared`) and `:682` (`setFeatureColumnRecomputer`). Wire this one next to them, reading `ptyFleetService.getLiveness()`. Note the fleet is constructed later at `:1480`, so the wiring must be a lazy closure (`() => ptyFleetService?.getLiveness() ?? []`), not a value captured at `:305`.

### 9. `package.json` — one new setting

`switchboard.activityLight.livenessWindowMs`, default 90000, min 10000, max 600000, added beside the existing `switchboard.activityLight.timeoutMs` (`:557`). Description: how recently a dispatched terminal must have produced output for the timeout sweep to spare its card. This is deliberately *not* the same knob as `timeoutMs` — one is "how long we believe a silent agent", the other is "how recently we must have heard from it".

## Verification Plan

Compilation and automated tests are out of scope for this session; the steps below are manual/observational.

1. **Baseline the defect first, at the layer that matters.** On `main`, dispatch a plan to a fleet terminal and keep the agent producing output past the 10-minute timeout without touching the plan file (a long build, or `while true; do date; sleep 5; done` as a stand-in). Confirm the card goes dark at minute 10. Then confirm *why*: with the sweep temporarily disabled (`switchboard.planWatcher.periodicScanEnabled: false`) the card **still** goes dark at minute 10, because `isWorkingState` recomputes the age at render time. This second observation is the one that proves the three-consumer finding; without it the plan's central design change is unjustified.
2. **Long-run false-off, fixed.** Repeat step 1 with the change in. Card stays lit past minute 10, on both the board light and the feature rollup light.
3. **Dead-agent fast clear — self-exit.** Dispatch, then let the agent process exit on its own (`exit` at the shell). Card clears on the next sweep tick (≤ ~10 s), not after 10 minutes.
4. **Dead-agent fast clear — operator kill.** Dispatch, then close the terminal from the Terminals panel (the `kill()` path). Card clears on the next tick. This is the case the tombstone exists for; without it the terminal vanishes from the fleet and the card falls through to the blind timer instead.

   > **Superseded:** "Dead-agent fast clear. Dispatch, then kill the terminal. Card clears on the next sweep tick (≤ ~10s), not after 10 minutes."
   > **Reason:** As a single step this could not pass. `kill()` deletes the handle from `this.terminals` before killing the process, so an operator-killed terminal produces a *miss* on the liveness lookup, and the plan's own rule requires a miss to fall through to the blind timer. The step also conflated two structurally different death paths that need separate coverage.
   > **Replaced with:** Two steps — self-exit (3) and operator kill (4) — with the `recentlyClosed` tombstone as the mechanism that makes (4) reachable.

5. **Hard cap.** Force liveness permanently true (temporary stub) and confirm the card still clears at 3× timeout, on the board light and in the DB.
6. **Fleet-less parity.** Run with `isPtyAvailable()` stubbed false. `last_liveness_at` stays NULL on every row and sweep behaviour is byte-identical to `main` — same clear timings, same log lines.
7. **Both verb arms.** `curl` `ptyListTerminals` under standalone (the `bootstrap.ts:1122` arm) and under the extension's forked host (the `ptyHost.ts:89` arm). `lastDataAt` present and advancing in both, and `friendlyName` present as the join key. A pass that only checks one host is not a pass.
8. **All four card builders agree.** Exercise each refresh path that reaches `KanbanProvider.ts:1845`, `:3474`, `:3679` and `bootstrap.ts:196` (initial board load, project-filter change, and the dispatch-view refresh) against one long-running card. Same light from all four. Record which path `:7369` serves, or that it is unreachable.
9. **No write amplification.** Watch the extension output channel during heavy terminal output; confirm the only new DB writes are one `recordLiveness` UPDATE per sweep tick, not per output flush.
10. **Rename.** Dispatch, rename the terminal mid-run, confirm the card is not force-cleared (falls through to the blind timer) and nothing throws. Then close the renamed terminal and confirm the tombstone migrated with the rename.
11. **Migration.** Fresh DB replays V20→V58 and lands `last_liveness_at`. An existing V57 DB migrates in place with no data loss. A V58 DB opened by an older build still functions (unknown column ignored by every existing query).

## Recommendation

Send to Lead Coder (complexity 7).

Ship this before the two sibling plans. It is the one that fixes an active user-visible defect rather than adding a capability, it establishes the fleet-side `onData` subscription and `recentlyClosed` tombstone both siblings depend on, and it takes V58 and owns the widening of all three derived-state consumers — the surface both siblings then extend rather than fork.

Do not ship §1–§5 without §6. The heartbeat, the column and the sweep gate are the plumbing; §6 is where the light actually stays on. Landing the first five sections alone produces a change that passes every check it sets for itself and fixes nothing the operator can see.

## Completion Report

Implemented all nine Proposed Changes sections. `ExtendedTerminalHandle` now carries `lastDataAt`, stamped from a fleet-owned `onData` subscription created immediately after handle construction and before `injectStartupCommand` in `src/standalone/ptyFleetService.ts`; a bounded `recentlyClosed` tombstone map (cap 64, oldest-first eviction) is populated from the `{type:'closed'}` change event in the constructor and migrated on `rename()`, and `getLiveness()` returns active terminals plus tombstones. Both `ptyListTerminals` arms (`src/standalone/ptyHost.ts` and `src/standalone/bootstrap.ts`) expose `lastDataAt` and append tombstones so the extension-host force-clear covers operator kills; `src/services/TaskViewerProvider.ts` adds a separate all-statuses `_ptyLiveness` cache populated from the forward (with `_ptyTerminalNames` untouched) and a synchronous `getFleetLiveness()` reader. V58 migration (`ALTER TABLE plans ADD COLUMN last_liveness_at TEXT DEFAULT NULL`) was added to `src/services/KanbanDatabase.ts` along with the column in `CREATE TABLE plans`, `PLAN_COLUMNS`, the row→record mapping, the `KanbanPlanRecord.lastLivenessAt` field, and `recordLiveness(workspaceId, terminalNames[], atIso)`; `clearStaleWorkingState` was widened to `MAX(dispatched_at, COALESCE(last_liveness_at, dispatched_at)) < cutoff OR dispatched_at < hardCapCutoff` (cap = 3× maxAgeMs) with a second force-clear UPDATE for `forceTerminals`, and `clearWorkingState`/`clearStaleWorkingState` both null `last_liveness_at`. Both `isWorkingState` copies (`KanbanProvider.ts` now taking `timeoutMs` as a parameter, and `bootstrap.ts`) compute the age from `max(dispatchedAt, lastLivenessAt ?? dispatchedAt)` with the 3× hard cap; all four card-build sites plus the fifth `_buildCardsFromDbSessionIds` builder (found reachable via `chatCopyPrompt`/`promptSelected` fallbacks, wired rather than removed) pass `lastLivenessAt`; `getFeatureWorkingStates` SQL was widened to match. `src/services/PlanIngestionEngine.ts` adds `setTerminalLivenessProvider(fn)` and partitions the fleet once per tick into live (→ `recordLiveness`)/exited (→ `forceTerminals`)/silent (fall through), reading `livenessWindowMs` from `activityLight` config (default 90000) and logging recorded/forced counts. The seam is wired on `src/extension.ts` (`() => taskViewerProvider.getFleetLiveness()`) and `src/standalone/bootstrap.ts` (lazy `() => ptyFleetService?.getLiveness() ?? []` since the fleet is constructed later). `switchboard.activityLight.livenessWindowMs` (default 90000, min 10000, max 600000) was added to `package.json` beside `timeoutMs`. No shipped V51–V57 migration bodies were touched. Files changed: `src/standalone/ptyFleetService.ts`, `src/standalone/ptyHost.ts`, `src/standalone/bootstrap.ts`, `src/services/TaskViewerProvider.ts`, `src/services/KanbanDatabase.ts`, `src/services/KanbanProvider.ts`, `src/services/PlanIngestionEngine.ts`, `src/extension.ts`, `package.json`. No compilation or tests were run per instructions; no issues encountered beyond the §2 clarification that both verb arms also append tombstones so the extension-host force-clear for operator kills is reachable (the plan's §2 literal instruction only adds the field to `fleet.list()`, but the central §1 requirement that operator-killed terminals force-clear necessitates surfacing tombstones on both hosts).

## Review Findings

**CRITICAL (fixed):** tombstones were appended into the `ptyListTerminals` `terminals` array on both arms, but `terminals.js` assigns `fleetList = data.terminals` unfiltered and renders every entry — so an operator-closed terminal reappeared as a permanent ghost row in the sidebar (no TTL on `recentlyClosed`), kept its pane slot through `sanitizePaneAssignments`, and read as live in `checkSoloNotFound`; tombstones now ride a sibling `liveness` key and `terminals` is byte-identical to before. **MAJOR (fixed):** the liveness seam was wired at `bootstrap.ts` before `const ptyFleetService` was initialised — a temporal-dead-zone reference behind a 10 s timer inside an async callback with `finally` but no `catch`, i.e. an unhandled rejection that would kill the standalone process; wiring moved after construction and the engine now catches a throwing provider and degrades to the blind timeout. Everything else in §1–§9 was verified correct as built: V58 lands and a fresh DB reaches version 59, the widened sweep/rollup SQL was validated against sqlite3 (nested scalar-`MAX` inside aggregate-`MAX` resolves as intended, the hard cap is an OR force-clear not an exclusion), all five derived-state consumers were widened including the previously-hardcoded fifth builder, and `_ptyTerminalNames` was correctly left alone. Files changed by this review: `src/standalone/ptyHost.ts`, `src/standalone/bootstrap.ts`, `src/services/TaskViewerProvider.ts`, `src/services/PlanIngestionEngine.ts`. Remaining risks (accepted, both bounded by the `3 × timeoutMs` cap): `recentlyClosed` has no TTL so dead names are re-sent as `forceTerminals` every tick for the host's lifetime, and terminal→card matching is by bare name across every watched root so a live `coder-1` in one root can stamp liveness on a card in another.
