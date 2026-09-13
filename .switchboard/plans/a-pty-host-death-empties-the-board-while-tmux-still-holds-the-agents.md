# A Pty-Host Death Empties the Board While tmux Still Holds the Agents

## Goal

When the pty host dies and is respawned, the board's seat list tells the truth: a
tmux-backed seat whose session survived is reattached to the still-running agent, and a
seat whose process genuinely died is shown as lost rather than silently disappearing. No
path leaves a seat that is alive in tmux invisible to the board.

### Problem analysis

Measured on 2026-09-12. The Go pty host panicked at ~10:30 (see *The Pty Host Writes One
WebSocket From Two Goroutines*). The supervisor respawned it and the board settled at
`terminalCount=0, seatCount=0, adopted=false` — while every agent was still alive:
`tmux ls` listed `lc-coding-team` (8 windows: lead, coder-1, coder-2, intern),
`lc-planner-1/2/3`, `lc-analyst-1`, `lc-reviewer-1`, `lc-reviewer-2`, with live processes
(`devin --permission-mode bypass`, `claude`) inside them. The board showed nothing.

Three defects compose. Each is individually survivable; together they lose the fleet.

**1. The live roster exists only in the Go host's memory, and eviction is unconditional.**
`f.terminals` (a Go map) is authoritative. Standalone's `ptyListTerminals` answers from
`GoPtyFleetProjection`'s cache, which `refresh()` (`goPtyFleetProjection.ts:608`)
reconciles against the host:

```ts
const before = new Set(this.cache.keys());
const listed = await this.supervisor.request('ptyListTerminals', {});
const rows = Array.isArray(listed?.terminals) ? listed.terminals : [];
```

A freshly respawned host answers with an empty `terminals` array, so every name in
`before` is evicted. The projection cannot distinguish *"the host says these seats are
gone"* from *"the host has just started and knows nothing yet"* — the two produce an
identical empty array. The cache is emptied, and the board renders zero seats.

**2. The durable registry is a mirror of the live fleet, not a record of it.**
`updateRegistryState()` (`goPtyFleetProjection.ts:802-833`) purges every persisted pty
entry before rewriting from the cache:

```ts
for (const [entryName, entry] of Object.entries(existing)) {
    if (entry && entry.purpose === 'pty') { continue; }      // dropped
    if (entry && entry.ideName === PTY_IDE_NAME) { continue; } // dropped
    terminalMap[entryName] = entry;
}
for (const [entryName, t] of this.cache.entries()) { terminalMap[entryName] = { ... }; }
await db.setConfigJson('runtime.terminals', terminalMap);
```

So `runtime.terminals` follows the cache wherever it goes, including to empty. It is
structurally incapable of surviving the event it would be needed for. Confirmed in the live
board: after the crash it held **two** entries (`reviewer-1`, `reviewer-2`) and had already
lost the entire eight-window coding team created the previous day.

The extension host has its **own** `runtime.terminals` writer with the same purge pattern:
`updateMirrorRegistry` (`TaskViewerProvider.ts:4143-4169`), called after every
`ptyCreateTerminal` / `ptyCloseTerminal` / `ptyRenameTerminal` verb. It purges every
`purpose === 'pty'` and `ideName === PTY_IDE_NAME` entry, then rewrites from the Go host's
`ptyListTerminals` response — which is empty after a crash. Defect 2 applies to **both**
roots, not just standalone.

**3. The registry records `status: "active"` against a dead pid.** The two surviving
entries read:

```json
"reviewer-1": { "status": "active", "pid": 752926, "ideName": "switchboard-pty", ... }
"reviewer-2": { "status": "active", "pid": 753578, ... }
```

Both pids are **dead** — they were the crashed host's children. Nothing in the record says
which host owned them, so `status: "active"` from a live host and `status: "active"` left
behind by a dead one are the same bytes. A reader cannot tell a running seat from a
tombstone, which is precisely the failure the repo's fallback rule exists to prevent.

**The recovery primitive already exists and is documented in the code.**
`goPtyFleetProjection.ts:227-229`, on the tmux seating path:

> `-A` is attach-or-create, which is what makes a restart cheap: the restart kills the PTY,
> the tmux session and the agent inside it survive, and the next spawn of the same name
> reattaches to the still-running agent.

A tmux-backed seat's startup command is
`tmux has-session -t <session> && tmux new-window ... || tmux new-session ...; tmux new-session -A -d -t <session> -s <view>`,
and `deriveTmuxSessionName` derives the session deterministically from the seat name/role.
So re-creating a seat under its original name **reattaches** rather than starting a second
agent. Nothing invokes that after a host death, because by then nothing remembers the seat
existed.

**Why adoption does not cover this.** `PtyHostSupervisor.tryAdopt` (`:198`) refuses any host
whose state file lacks `surviveParent: true`, logging `State file records a non-surviving
host; not adopting.` That gate is correct and unrelated: adoption reuses a *living* host, and
after a panic there is no host to adopt. Adoption and restore are different mechanisms for
different events, and no setting of `surviveBoard` makes a crashed host adoptable.

## Metadata

- **Complexity:** 7
- **Tags:** reliability, standalone, refactor

## User Review Required

None.

## Approach

Separate the two jobs `runtime.terminals` currently conflates: a **live projection** (what
the host reports now) and a **durable roster** (what seats this board believes it owns).
Keep the projection exactly as it is; stop letting it destroy the roster.

The roster gains the two fields that make recovery decidable — the identity of the host that
owned the seat, and the tmux session backing it — and the restore pass consults **tmux
itself** as the authority, never the roster alone. A seat is reattached only when
`tmux has-session` proves the session is still there. Otherwise it is recorded `lost` and
surfaced. This is the load-bearing distinction: re-creating a seat whose session is gone
would spawn a *fresh* agent wearing a dead seat's name, with none of its context, and the
board would present it as the seat that was there before. A silent wrong answer is worse
than a visible loss, so the tmux probe gates every restore.

Restore runs on supervisor-ready when the host was **spawned** rather than **adopted**
(`isAdopted() === false`), which is exactly the "new host, empty fleet" case and never fires
on the ordinary adoption path. The hook fires after `PtyHostSupervisor.start()` completes
via the spawn arm (not `tryAdopt`), since `start()` is the supervisor's readiness method —
there is no `ensureReady()` on `PtyHostSupervisor`.

> **Superseded:** The change lands in `GoPtyFleetProjection` and `PtyHostSupervisor`, which both composition roots share, and is wired in **both**: `extension.ts:1030` (`taskViewerProvider.setPtyHostSupervisor(new PtyHostSupervisor({...}))`) and `standalone/bootstrap.ts:1620-1626` (the same construction, plus `ptyFleetService.setTmuxSeatingResolver(...)` at `:3964`). The extension does not wire `setTmuxSeatingResolver`, so its seats are not tmux-backed and its restore pass finds no recoverable session — it therefore takes the `lost` arm and reports, which is the correct and honest outcome there rather than a silently skipped feature. Both roots must wire the seam; a restore hook left unwired on one host is the exact `Promise<void>` divergence the repo's precedent warns about, where "never wired" and "working" are the same value.
> **Reason:** The extension host does NOT construct a `GoPtyFleetProjection`. It manages terminals through `TaskViewerProvider` with a `_ptyHostSupervisor` and a `_fleetVerb` callback. The projection exists only in `bootstrap.ts:3989`. Change 4's instruction to "pass `onHostSpawned` bound to the projection's `restoreFromRoster()`" is impossible in the extension — there is no projection to bind to. Additionally, the extension has its own `runtime.terminals` writer (`updateMirrorRegistry`, `TaskViewerProvider.ts:4143-4169`) with the same purge-and-rewrite defect; the original approach fixed only the standalone writer. The line numbers were also stale (`bootstrap.ts:1620` → `1622`, `:3964` → `3991`).
> **Replaced with:** The change lands in `GoPtyFleetProjection`, `PtyHostSupervisor`, AND `TaskViewerProvider`. Both `runtime.terminals` writers get the ownership-scoped merge: `GoPtyFleetProjection.updateRegistryState()` (`goPtyFleetProjection.ts:802`) and `TaskViewerProvider.updateMirrorRegistry` (`TaskViewerProvider.ts:4143`). The `onHostSpawned` hook is wired in both roots: standalone binds it to `GoPtyFleetProjection.restoreFromRoster()`; the extension binds it to a new `TaskViewerProvider.restoreLostSeats()` method that reads `runtime.terminals` directly, probes tmux (always false — no tmux in extension), and marks every previous-generation entry `lost`. The extension's restore is honest reporting, not reattachment. Both roots must wire the hook; a restore hook left unwired on one host is the exact `Promise<void>` divergence the repo's precedent warns about. Corrected line numbers: `extension.ts:1030`, `bootstrap.ts:1622-1627` (supervisor construction), `bootstrap.ts:3989-3992` (`GoPtyFleetProjection` + `setTmuxSeatingResolver`).

## Complexity Audit

### Routine

- Adding `ownerHostPid`, `ownerHostStartedAt` and `tmuxSession` to the persisted entry.
  Requires extending `FleetTerminalInfo` (`ptyFleetService.ts:73-100`) — the
  `updateRegistryState` write uses `satisfies FleetTerminalInfo`, so adding fields to the
  written object without extending the interface is a compile error.
- Threading `tmuxSession` from `create()` through `materialize()` into the
  `ExtendedTerminalHandle`. Today `create()` derives the session name via
  `deriveTmuxSessionName` (`goPtyFleetProjection.ts:239`) but uses it only to build the
  startup command string — it is not stored on the handle or in `ProjectedTerminal`
  (`goPtyFleetProjection.ts:32-50`). The derived session name must be captured and carried.
- Making `updateRegistryState` merge rather than purge for entries owned by a *different*
  host generation.
- Making `updateMirrorRegistry` (`TaskViewerProvider.ts:4143-4169`) merge rather than purge
  for entries owned by a *different* host generation — the same fix, applied to the
  extension's parallel writer.
- A `tmux has-session -t <name>` probe, which `tmuxBackend.ts` already shells out for
  (`:598`).

### Complex / Risky

- **Restore must be idempotent and single-flight.** `reconcile()` is already single-flighted;
  restore must not race it or a seat could be created twice (two windows, two agents). It
  runs once per host generation, before the first `refresh()` is allowed to evict.
- **Eviction must be suppressed until restore has run**, or defect 1 empties the cache
  before restore can read it. The ordering is: host ready → restore pass → normal reconcile.
- **A seat whose tmux session exists but whose agent exited** reattaches to a session
  running a dead shell. `tmux has-session` is true but the agent is gone. The pane's
  `#{pane_dead}` / current command distinguishes them; a dead pane is treated as `lost`.
- **Name collisions on restore.** `create()`'s collision loop appends a suffix; restoring a
  seat must reuse the *exact* original name or it will not map to its tmux session. Restore
  therefore bypasses the collision loop and fails loudly if the name is already taken.
- **Extension restore is a different code path.** The extension has no
  `GoPtyFleetProjection`, so its restore cannot call `restoreFromRoster()`. It needs a
  `TaskViewerProvider`-level method that reads `runtime.terminals` directly. Since the
  extension has no tmux, every previous-generation entry resolves to `lost` — the honest
  outcome, but the method must exist and be wired, not assumed.

## Edge-Case & Dependency Audit

**Two boards, one machine:** `ownerHostPid` + `ownerHostStartedAt` scope the roster to this
board's host generation. A second workspace's seats carry a different owner and are never
restored by this one. `tryAdopt`'s existing workspace-root check (`:252`) already refuses
cross-root adoption; restore reuses the same `workspaceRoot` comparison.

**tmux absent or disabled:** `terminal.tmux.enabled` false, or no `tmux` binary. Every seat
takes the `lost` arm. No restore, no crash, and the roster stops claiming `active`.

**Stale roster after a clean shutdown:** a clean stop must mark its seats with a terminal
status, so the next start does not try to restore seats the operator deliberately ended.
The existing stop path (`disposeAll` at `goPtyFleetProjection.ts:516` calls
`updateRegistryState()` after clearing the cache) already writes the registry; it gains the
terminal-status marking. The extension's stop path (`TaskViewerProvider.ts:25625`) calls
`this._ptyHostSupervisor.stop()` — it must also mark its roster entries.

**Roster and tmux disagree:** tmux wins, always. The roster proposes candidates; the probe
decides. A seat in tmux but absent from the roster is not adopted — restoring an unknown
session would attach the board to a pane it never owned.

**Orphaned previous host:** the crashed host's process may linger (two
`switchboard-pty-host` processes were observed after the 10:30 panic — the orphan 733633
alongside the new 765808). Restore must not attach to the orphan's port; it runs against the
supervisor's current host only.

**Interaction with the panic fix:** independent. Fixing the write race reduces how often a
host dies; this plan governs what happens when one does, by any cause (OOM, SIGKILL, crash).
Neither blocks the other and they can ship in either order.

**Extension's `updateMirrorRegistry` writes fewer fields:** it writes `friendlyName, role,
status, pid, startTime, worktreePath, ideName, purpose` but NOT `agentInstanceId`,
`startupCommand`, `startupCommandSource`, `cliFamily`. Since the extension has no tmux, its
restore always takes the `lost` arm and does not need `startupCommand` for reattach. The
field gap does not block the `lost` path. If the extension ever gains tmux support, the
mirror must be aligned — noted as a clarification, not a blocker for this plan.

## Dependencies

None blocking.

Related but **out of scope**: `cliFamily: "unknown"` appears on the persisted entries and is
a separate defect with its own readiness-ceiling consequences; this plan preserves whatever
value the projection supplies and does not change how it is resolved.

## Adversarial Synthesis

Key risks: (1) restore spawns a second agent instead of reattaching — mitigated by reusing
the persisted `friendlyName` verbatim, bypassing the collision loop, and asserting the agent
pid is unchanged; (2) the extension has no `GoPtyFleetProjection` so `onHostSpawned` cannot
bind to `restoreFromRoster()` — mitigated by a `TaskViewerProvider`-level restore method
that reads `runtime.terminals` directly and marks entries `lost`; (3) the extension's
`updateMirrorRegistry` has the same purge defect as `updateRegistryState` — mitigated by
applying the same ownership-scoped merge to both writers; (4) the parity gate is scoped to
`PlanIngestionEngine` and cannot see a `PtyHostSupervisor` constructor option — mitigated by
a dedicated check that greps both roots for `onHostSpawned` in the supervisor construction.
Mitigations: exact-name restore with pid assertion, parallel writer fixes, concrete parity
script.

## Proposed Changes

### 1. `src/standalone/ptyFleetService.ts` — extend `FleetTerminalInfo` and `ExtendedTerminalHandle`

`FleetTerminalInfo` (`:73-100`) gains:
- `ownerHostPid?: number` / `ownerHostStartedAt?: number` — the host generation that owned
  the seat.
- `tmuxSession?: string | null` — the session derived at create time, or `null` when the
  seat is not tmux-backed.

`ExtendedTerminalHandle` (`:102`) gains `tmuxSession?: string | null` so the value is
available at registry-write time without re-deriving it.

`ProjectedTerminal` (`goPtyFleetProjection.ts:32-50`) gains `tmuxSession?: string | null`
so `materialize()` can carry it onto the handle.

### 2. `src/services/goPtyFleetProjection.ts` — capture `tmuxSession` at create time

In `create()`, the session name is derived at `:239`:
```ts
const session = deriveTmuxSessionName(opts?.tmuxSession || name || role);
```
This value is used only to build the startup command. It must also be passed to
`materialize()` and stored on the handle:
```ts
const handle = this.materialize({
    ...row,
    tmuxSession: usesControlMode ? session : null,
    // ...existing fields
});
```

### 3. `src/services/goPtyFleetProjection.ts` — the roster records ownership and backing

Extend the persisted entry written by `updateRegistryState` (`:802-833`) with:
- `ownerHostPid: number` / `ownerHostStartedAt: number` — taken from the supervisor's
  `getHostPid()` / `getHostStartedAt()`, so a reader can tell whether the owning host is the
  live one.
- `tmuxSession: string | null` — from the handle (captured in Change 2), or `null` when the
  seat is not tmux-backed.

Replace the unconditional purge with an ownership-scoped one: entries whose
`ownerHostPid`/`ownerHostStartedAt` match the **current** host are rewritten from the cache
as today; entries from a previous generation are preserved for the restore pass rather than
dropped. `status` for a previous-generation entry is written as `orphaned`, never `active`.

### 4. `src/services/goPtyFleetProjection.ts` — a `restoreFromRoster()` pass

New method, single-flighted like `reconcile()`. For each roster entry not owned by the
current host:

- No `tmuxSession`, or `terminal.tmux.enabled` false, or tmux unavailable → mark `lost`.
- `tmux has-session -t <tmuxSession>` fails → mark `lost`.
- Session exists but its pane is dead (`#{pane_dead}` true, or no live child) → mark `lost`.
- Otherwise re-create the seat under its **exact** persisted `friendlyName`, role, cwd and
  startup command, bypassing the name-collision loop. `new-session -A` reattaches to the
  running agent; the seat rejoins the cache and the board.

Seats marked `lost` are written to the roster with `status: 'lost'` and removed from the
candidate set, so the pass is not retried on every host restart.

### 5. `src/services/TaskViewerProvider.ts` — ownership-scoped merge in `updateMirrorRegistry`

`updateMirrorRegistry` (`:4143-4169`) has the same purge-and-rewrite pattern as
`updateRegistryState`. Apply the same ownership-scoped merge: entries whose
`ownerHostPid`/`ownerHostStartedAt` match the current host are rewritten from the
`ptyListTerminals` response; entries from a previous generation are preserved. `status` for
a previous-generation entry is `orphaned`, never `active`.

The supervisor's `getHostPid()` / `getHostStartedAt()` are available via
`this._ptyHostSupervisor`.

### 6. `src/services/TaskViewerProvider.ts` — a `restoreLostSeats()` method

New method, called by the `onHostSpawned` hook. The extension has no
`GoPtyFleetProjection` and no tmux, so this method reads `runtime.terminals` directly from
the database, filters for entries owned by a previous host generation, and marks every one
`lost` — the honest outcome. It writes the updated statuses back to `runtime.terminals`. No
reattachment, no tmux probe, no fresh agent. This is the concrete host for the extension's
restore pass that the original plan assumed existed but did not specify.

### 7. `src/services/ptyHostSupervisor.ts` — a restore hook, ordered before eviction

Add an `onHostSpawned?: () => Promise<void>` option to `PtyHostSupervisorOptions` (`:21-28`),
fired after `start()` completes via the **spawn** arm (`this.adopted === false`, the path
at `:317-350`) and never via `tryAdopt`. `GoPtyFleetProjection` suppresses cache eviction in
`refresh()` until the hook has resolved for the current host generation, so the first
reconcile after a respawn cannot empty the cache underneath the restore pass.

> **Superseded:** Add an `onHostSpawned?: () => Promise<void>` option, fired when `ensureReady()` completes via a **spawn** (`this.adopted === false`) and never via `tryAdopt`.
> **Reason:** `PtyHostSupervisor` has no `ensureReady()` method. Every `ensureReady` call in the codebase is on `KanbanDatabase`. The supervisor's readiness method is `start()`.
> **Replaced with:** Add an `onHostSpawned?: () => Promise<void>` option, fired after `start()` completes via the **spawn** arm (`this.adopted === false`) and never via `tryAdopt`.

### 8. `src/extension.ts` and `src/standalone/bootstrap.ts` — wire it in both roots

Both `PtyHostSupervisor` constructions (`extension.ts:1030`, `bootstrap.ts:1622`) pass
`onHostSpawned`:
- **Standalone** (`bootstrap.ts:1622`): bound to `ptyFleetService.restoreFromRoster()`.
  The projection exists and tmux is available, so reattach-capable seats are restored.
- **Extension** (`extension.ts:1030`): bound to `taskViewerProvider.restoreLostSeats()`.
  The extension has no `GoPtyFleetProjection` and no tmux, so every candidate resolves to
  `lost` — the correct and honest outcome. The hook is still wired, so the two roots cannot
  drift on whether the seam exists.

### 9. Clean-shutdown roster write

The ordinary stop path marks this host's roster entries with a terminal status before the
host goes down, so a deliberate shutdown does not present its seats as restore candidates on
the next start.
- **Standalone**: `disposeAll()` (`goPtyFleetProjection.ts:516`) already calls
  `updateRegistryState()` after clearing the cache — it gains the terminal-status marking.
- **Extension**: `TaskViewerProvider.ts:25625` calls `this._ptyHostSupervisor.stop()` — it
  gains a roster write that marks this host's entries with a terminal status.

## Verification Plan

### Automated Tests

1. **New** `src/test/pty-host-restore-contract.test.js`, wired as
   `test:contract:pty-host-restore`. With `terminal.tmux.enabled` true: create a tmux-backed
   seat, record the agent's pid inside the tmux pane, `SIGKILL` the pty host, let the
   supervisor respawn, and assert — (a) the seat is present in `ptyListTerminals` again,
   (b) **the agent pid inside the pane is unchanged**, proving reattach rather than respawn,
   and (c) exactly one window exists for that seat. Fails on current `main`, where the seat
   never comes back.
2. Same suite, second case: kill the pty host with tmux disabled; assert the seat is
   reported `lost` with a board-visible status and is **not** re-created.
3. Same suite, third case: roster entry whose tmux session was killed externally; assert
   `lost`, no new session created.
4. **Seam parity:** a **new** dedicated check script (e.g.
   `scripts/check-pty-host-restore-parity.js`) that greps both `extension.ts` and
   `standalone/bootstrap.ts` for `onHostSpawned` in the `PtyHostSupervisor` construction
   options. The existing `host-seam-parity:check` is scoped to `PlanIngestionEngine`
   `set<Name>(` declarations only (`ENGINE_PATH = PlanIngestionEngine.ts`) and cannot see a
   `PtyHostSupervisor` constructor option. Wire the new check as
   `npm run pty-host-restore-parity:check` and add it to CI. This is the gate the
   queue-seam precedent lacked — and the existing parity script cannot serve as that gate
   without a generalization the plan does not justify.
5. **Extension mirror fix:** a test that verifies `updateMirrorRegistry`
   (`TaskViewerProvider.ts:4143`) preserves previous-generation entries instead of purging
   them. Create a seat, write a `runtime.terminals` entry with a previous-generation
   `ownerHostPid`, call `updateMirrorRegistry`, and assert the previous-generation entry
   survives with `status: 'orphaned'`.
6. Regression cover, all must stay green: `test:contract:pty-host-blackbox`,
   `test:contract:pty-host-gating`, `test:contract:pty-route-surface`,
   `test:contract:pty-dispatch-focus`, `npm run parity:check`, `npm run host-seam-parity:check`.
7. `npm run compile-tests` before any `test:contract:*` run — the suites execute against
   `out/`.

### Goal Invariants

- After the pty host is killed and respawned, a seat whose tmux session survived is present
  on the board and bound to the **same** agent process it had before.
- No seat is ever re-created when `tmux has-session` fails for it; a lost seat is reported as
  lost and never replaced by a fresh agent under the old name.
- `runtime.terminals` never carries `status: "active"` for a seat whose owning host
  generation is not the running one — in **both** roots (standalone's
  `updateRegistryState` and the extension's `updateMirrorRegistry`).
- A board restart with no crash produces no restore pass and no duplicate seats or windows.
- Both composition roots register the restore hook (`onHostSpawned` on
  `PtyHostSupervisor`), asserted by a dedicated parity script rather than by reading the
  diff — the existing `host-seam-parity:check` cannot see this seam.

## Outstanding Questions

- **[user]** The extension's `updateMirrorRegistry` writes fewer fields than the
  standalone's `updateRegistryState` (no `agentInstanceId`, `startupCommand`,
  `startupCommandSource`, `cliFamily`). This plan does not align them because the
  extension's restore always takes the `lost` arm and does not need `startupCommand` for
  reattach. If the extension is expected to gain tmux support in the future, the mirror
  should be aligned now. Proceeding on the assumption that the extension's restore is
  `lost`-only for this plan's scope.
