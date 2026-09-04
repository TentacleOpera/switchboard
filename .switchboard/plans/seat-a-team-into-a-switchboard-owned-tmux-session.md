# A Team Can Be Seated Into A tmux Session Switchboard Owns

## Goal

Let `startTeamForWorkspace` seat a team's members as panes in a tmux session Switchboard creates and owns, instead of as children of the PTY fleet. One seating path, one team model, one roster — the terminal backend becomes a setting, not a second mode.

### Problem Analysis & Root Cause

**What exists today.** A team is seated by `TaskViewerProvider.startTeamForWorkspace` (`:13017`), reached from the `ptyStartTeam` verb (`:3463`), the TEAMS tab, and boot autostart. It resolves the team definition host-side from `terminals.agentGroups` — never from the wire — and spawns each member into the PTY fleet. That fleet is the only backend team seating has ever had.

**What the tmux plans do and do not cover.** Nothing tmux ships: the sole occurrence of the word in `src/` is an unrelated comment at `terminalWsGateway.ts:1400`. The three planned parts (`deeb33c2`) are all in CREATED, and Part 2's scope is **pane-level adoption** — a grep of its plan for `team|group|seat|roster` returns nothing. It makes one pre-existing tmux pane registerable in `runtime.terminals` and reachable from `sendToTerminal` / `triggerAction`. Adopting a pane a user already had is a different operation from seating a roster, and Part 2's own posture says so: adoption is opt-in, default off, guarded by a bare-shell refusal, *because a tmux pane runs whatever the user left in it*.

Team seating is the opposite posture. Switchboard creates the panes, so it knows what is in them, which member each is, and when they die. None of that needs an adoption guard, and none of it is what Part 2 built.

**Why this is worth having.** On a headless box driven over ssh — the tower is the live example, already running tmux 3.4 with a `board` session — the PTY fleet's panes exist only inside a Switchboard client. tmux panes survive the client, the ssh connection and the laptop lid. A team seated into tmux can be attached from the Mac, the iPad, or a different network, and keeps running between them. That is a property the fleet cannot offer, not a nicer rendering of one it already has.

**The shape this must NOT take.** Not two peer seating modes with a picker. The team model, the roster, the roles, the definition resolution and the wire-safety guard are all unchanged and shared. What varies is *where a member is spawned* — which is exactly the `TerminalBackend` / `TerminalHandle` seam Part 1 delivers. One path, one optional switch, no second implementation of teams.

**Dependency.** Part 1 (`8bc07323`, tmux Bridge: Transport Layer) is a hard prerequisite: it provides `TmuxTerminalBackend`, `isTmuxAvailable()`, `listTmuxPanes()` and `sendPromptToTmux()`. Part 2 (`f1965bc4`) is **not** a prerequisite — it wires pane *adoption*, which this plan does not use. Do not wait for it, and do not reuse its adoption guard here.

**The open decision this plan closes.** Whether tmux replaces the fleet or sits beside it. It does neither: it is a backend selection on one seating path, defaulting to the fleet, so no existing user's behaviour changes and no second code path is introduced to keep in sync.

## Metadata
**Topic:** Seat a team into a Switchboard-owned tmux session
**Tags:** backend, feature, infrastructure
**Complexity:** 7
**Feature:** deeb33c2-3517-42e5-a008-8a36b4c89c54

## User Review Required

One design decision is asserted here rather than asked, and should be confirmed before coding:

**Reconnect policy: reattach to a surviving session, not refuse.** The original plan said "refuse to seat into a session name that already exists rather than adopting it." That policy contradicts the durability goal — the whole point is that panes survive disconnection. If a Switchboard restart refuses to re-enter its own surviving session, the feature eats itself. This plan changes the policy to: if the session exists AND its panes match the team's roster (by pane_title), reattach — update the registry, mark seats live. If the session exists but the panes do not match (different count, different titles), refuse with a message naming the collision. This is reattachment to a session Switchboard created, not adoption of an arbitrary user session — the distinction is roster match, not a bare-shell guard.

## Complexity Audit

### Routine
- Reading a workspace-scoped setting through the same scoped-config path the rest of team settings use (`KanbanProvider._getScopedSetting`).
- Constructing a `createHeadWithDelegates` callback for the tmux path — the seam already exists and both hosts already provide implementations.
- Setting `pane_title` to the member's friendly name at pane creation time.
- Registering tmux panes in `runtime.terminals` with `purpose: 'tmux'` and `ideName: TMUX_IDE_NAME`, mirroring `PtyFleetService.updateRegistryState()` (`ptyFleetService.ts:912-943`).

### Complex / Risky
- **Delivery path for tmux seats.** `sendToTerminal` (`TaskViewerProvider.ts:15277`) tries the PTY fleet first via `_ptyHostVerb`, then falls back to `TerminalBackend.findByName`. Neither path reaches tmux panes today. The extension host's `_ptyHostVerb` is IPC to a child process that knows nothing about tmux; standalone's `handlePtyVerb` routes to `ptyFleetService`. A new delivery arm is needed on both hosts.
- **Liveness re-discovery.** tmux has no event stream. The fleet uses `ptyProcess.onExit` — a real event. tmux pane death must be detected by a periodic `listTmuxPanes()` reconcile poll that updates `runtime.terminals` and marks dead seats.
- **Both composition roots must wire the setting.** Extension: `TaskViewerProvider.instantiateAgentGroup` (`:13187`) constructs `createHeadWithDelegates`. Standalone: `bootstrap.ts:3056` constructs it. The setting read, backend selection, and tmux callback must land in BOTH. Missing one is the CLAUDE.md divergence trap.
- **Session naming and sanitization.** tmux session names cannot contain `.` and must be unique. Team names are free-form user strings. A sanitization scheme is needed that produces deterministic, collision-resistant session names.
- **Reconnect vs. refuse.** The session may survive a Switchboard restart. The policy must distinguish "Switchboard's own surviving session" from "an unrelated session with a colliding name."
- **Standing-order delivery.** Orders are written by `wireSpawnedTeam` correctly (the shared `instantiateAgentGroupCore` flow runs for both backends), but delivery reads from the fleet root and pushes via `_ptyHostVerb('ptySendPrompt')` — same delivery-path gap as dispatch.

## Edge-Case & Dependency Audit

### Race Conditions
- **Concurrent team starts into the same session name.** Two `startTeamForWorkspace` calls for the same team racing — the `has-session` check passes for both, both try `new-session`. Prevented by `startTeamById`'s existing double-start refusal (`teamWiring.ts:1230-1243`), which checks `liveTerminals` for an active head. For tmux, the live-terminal check must include tmux-backed seats from `runtime.terminals`, not just fleet terminals.
- **Pane death between creation and registry write.** A pane killed in the window between `new-window` and `runtime.terminals` write leaves a registry entry for a dead pane. The reconcile poll catches this on the next tick; the stale entry is overwritten with `status: 'exited'`.
- **Reconnect during a reconcile poll.** A team start racing with a reconcile poll for the same session. The poll sees the session, the start sees the session. Safe: the start's roster-match check is authoritative; the poll only updates status for known seats.

### Security
- **Session name injection.** Team names are user-authored free-form strings. A team named `foo; kill-server` must not reach `tmux` as an interpolated command. All tmux invocations use `execFile`/`spawn` with an argv array (Part 1's contract). Session names are passed as a single argv element to `-s`, never interpolated into a command string. Sanitize by replacing characters tmux forbids (`.`) and characters that could confuse `-s` parsing (spaces, colons) with `-`.
- **Wire safety unchanged.** The `ptyStartTeam` verb's guard at `TaskViewerProvider.ts:3473` rejects a wire-supplied `payload.group`. A wire-supplied `backend` field must be rejected or ignored the same way — the backend is host-resolved from the scoped setting, never from the wire.

### Side Effects
- **`runtime.terminals` coexistence.** The tmux registry entries must coexist with fleet entries, not clobber them. `PtyFleetService.updateRegistryState()` (`ptyFleetService.ts:916-939`) already merges by `ideName` — entries with `ideName === PTY_IDE_NAME` are replaced, others preserved. The tmux update must follow the same merge pattern: replace `ideName === TMUX_IDE_NAME`, preserve everything else.
- **tmux session survives Switchboard shutdown.** Unlike fleet terminals (killed on `disposeAll`), tmux sessions persist after Switchboard exits. This is the durability feature, not a leak — but `stop`/`closeTerminal` verbs for tmux seats must `kill-pane` (not `dispose`, which is unregister-only per Part 1), and a team stop must `kill-session` to clean up.

### Dependencies & Conflicts
- **Part 1 (`8bc07323`) is a hard prerequisite.** `TmuxTerminalBackend`, `TmuxTerminalHandle`, `isTmuxAvailable()`, `listTmuxPanes()`, `sendPromptToTmux()` must all exist in `src/standalone/`. Part 1 is in CREATED — this plan cannot start until Part 1 is coded.
- **Part 2 (`f1965bc4`) is NOT a prerequisite.** Part 2 wires pane adoption. This plan creates panes, not adopts them. Do not reuse Part 2's adoption guard.
- **No conflict with existing fleet paths.** The setting defaults to `fleet`; absent or unset means fleet. Every existing install is unaffected.
- **`PtyFleetService` is not modified.** The fleet path's `createHeadWithDelegates` callback is unchanged. The tmux path is a new callback, not a refactor of the fleet.

## Dependencies

- `8bc07323` — tmux Bridge Part 1: Transport Layer (hard prerequisite; provides `TmuxTerminalBackend`, `isTmuxAvailable()`, `listTmuxPanes()`, `sendPromptToTmux()`, `TMUX_IDE_NAME`)

## Adversarial Synthesis

Key risks: (1) the delivery path — `sendToTerminal` and standing-order delivery have no route to tmux panes today; pane creation without delivery is a feature that appears to work but silently fails on dispatch. (2) Both composition roots must wire the setting and tmux callback; missing one is the CLAUDE.md divergence trap. (3) Liveness requires a concrete reconcile poll, not a hand-wave. Mitigations: backend selection at the `createHeadWithDelegates` seam (not `TerminalBackend`), a new `sendToTerminal` arm that checks `runtime.terminals` for `purpose: 'tmux'` and routes to `sendPromptToTmux()`, a periodic `listTmuxPanes()` reconcile poll, and reconnect-by-roster-match to preserve durability.

## Proposed Changes

> **Superseded:** Route member spawning through the `TerminalBackend` / `TerminalHandle` seam — `startTeamForWorkspace` resolves a `TerminalBackend` once and spawns every member through it. The fleet becomes the default implementation of that seam rather than a hardcoded call. If the fleet path is not already expressible as a `TerminalBackend`, making it one is part of this work.
> **Reason:** `TerminalBackend.create(name, shellPath?, cwd?)` (`hostSeams.ts:228-243`) cannot express role, delegates, teamName, parent-child relationships, singleton identities, collision counters, startup commands, or worktree paths — all of which `PtyFleetService.create()` (`ptyFleetService.ts:288`) and `spawnDelegates()` handle. Flattening team seating behind it is a massive refactor that either loses fleet functionality or duplicates it behind an interface too narrow to express it. The `createHeadWithDelegates` callback in `instantiateAgentGroupCore` (`agentGroupInstantiation.ts:51-57`) is already the abstraction boundary — both hosts already provide different implementations, and it already carries the team-shaped spec (`{ role, name, cwd, delegates, teamName }`).
> **Replaced with:** Backend selection at the `createHeadWithDelegates` callback seam. Both hosts construct this callback in their composition roots (`TaskViewerProvider.instantiateAgentGroup` at `:13233` for the extension, `bootstrap.ts:3071` for standalone). A workspace-scoped setting selects whether the callback spawns into the PTY fleet or a tmux session. The shared `instantiateAgentGroupCore` flow — caps pre-flight, standing orders, group registration, wiring — runs unchanged for both backends.

### 1. `src/services/teamWiring.ts` — session name derivation

**Context.** The tmux `createHeadWithDelegates` callback needs a deterministic tmux session name from the team name. tmux session names cannot contain `.` or `:` and should be shell-safe.

**Logic.** Add a `deriveTmuxSessionName(teamName: string): string` export:
- Lowercase the team name.
- Replace every character matching `/[^a-z0-9_-]/` with `-`.
- Prefix with `sb-` to namespace Switchboard-owned sessions (distinguishes from user sessions like `board`).
- Collapse consecutive `-` into one.
- Clamp to 50 characters (tmux has no documented hard limit, but excessively long names are impractical).

**Implementation.**
```ts
export function deriveTmuxSessionName(teamName: string): string {
    return 'sb-' + String(teamName || 'team')
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '-')
        .replace(/-+/g, '-')
        .slice(0, 50);
}
```

**Edge Cases.** Two teams with names that sanitize to the same session name (e.g. "My Team" and "My-Team") collide. The collision is caught by the session-exists check at seating time — refuse with a message naming both the team and the session. This is rare and the refusal is safe.

### 2. `src/standalone/tmuxTeamSeating.ts` (new) — tmux `createHeadWithDelegates` implementation

**Context.** Both hosts need a `createHeadWithDelegates` callback that creates tmux panes instead of PTY children. The callback signature is defined at `agentGroupInstantiation.ts:51-57`: `(spec: { role, name, cwd, delegates, teamName }) => Promise<AgentGroupCreateResult>`.

**Logic.** Export `createTmuxHeadWithDelegates(spec, opts): Promise<AgentGroupCreateResult>`:

1. **Session name.** `deriveTmuxSessionName(spec.teamName || spec.name)`.
2. **Reconnect check.** `tmux has-session -t <sessionName>`. If the session exists:
   - `listTmuxPanes()` filtered to the session.
   - Compare pane titles against the expected roster: head is `spec.name`, delegates are `spec.delegates[i].friendlyName` (or derived from role + index, matching the fleet's collision-counter logic).
   - If titles match: reattach — record pane ids, skip pane creation, proceed to registry write. Mark seats as `status: 'active'`.
   - If titles do not match (different count or different names): return `{ success: false, error: 'Session <name> already exists with different panes — refusing to adopt. Use a different team name or kill the session first.' }`.
3. **Create session.** `tmux new-session -d -s <sessionName> -c <cwd> -n <headName> -P -F '#{pane_id}'`. The first pane is the head. Set `pane_title` to `spec.name` via `tmux select-pane -t %id -T <spec.name>`.
4. **Create delegate panes.** For each delegate in `spec.delegates`: `tmux new-window -d -t <sessionName> -n <delegateName> -c <cwd> -P -F '#{pane_id}'`, then `select-pane -t %id -T <delegateName>`. Use `split-window` if panes should share a window, or `new-window` for one pane per window. One pane per window is simpler and matches the fleet's one-terminal-per-member model.
5. **Startup commands.** For each member with a `startupCommand`, send it via `sendPromptToTmux()` (from Part 1). This mirrors the fleet's `injectStartupCommand` path.
6. **Return.** `{ success: true, terminal: { friendlyName: spec.name, paneId, ... }, delegates: [{ friendlyName, paneId, role, status: 'active' }, ...] }`.

**Implementation notes.**
- The `friendlyName` for each member MUST be identical to what the fleet path would produce. The fleet derives names through `PtyFleetService.create()` collision-counter logic (`<role>-2` for pool roles, singleton for singleton identities). The tmux path must call the same derivation, not invent its own. Extract the name-derivation logic from `PtyFleetService.create()` into a shared helper if it is not already reusable, or construct the names in `instantiateAgentGroupCore` before calling `createHeadWithDelegates` (preferred — the names are already in `spec.name` and `spec.delegates[i].friendlyName` by the time the callback fires, because `instantiateAgentGroupCore` passes them through from the group definition).
- Actually, looking at `instantiateAgentGroupCore` (`:134-140`), it passes `group?.name` as `name` and `members` as `delegates`. The fleet's `createHeadWithDelegates` then calls `ptyFleetService.create(spec.role, spec.name, ...)` which applies the collision counter. So the `friendlyName` is derived INSIDE the callback, not before. The tmux callback must use the same derivation. The cleanest path: extract `PtyFleetService`'s name-derivation into a shared function both callbacks call, OR have the tmux callback call `ptyFleetService` for name derivation only (not creation). The former is cleaner.

**Edge Cases.**
- `isTmuxAvailable()` false → return `{ success: false, error: 'tmux backend selected but tmux is not available. Check the "switchboard.terminalBackend" setting.' }`. No silent fleet fallback.
- `new-session` fails (e.g., session name already taken by a non-Switchboard session) → return the error. The `sb-` prefix makes this unlikely.
- A delegate pane creation fails mid-loop → kill the session and return failure. No partial team left running. This is the tmux analogue of the fleet's "no orphan agent CLI" principle (`agentGroupInstantiation.ts:99-112`).

### 3. `src/standalone/tmuxTeamSeating.ts` — registry update

**Context.** The fleet path updates `runtime.terminals` via `PtyFleetService.updateRegistryState()` (`ptyFleetService.ts:912-943`) on every change. The tmux path needs its own registry update that coexists with fleet entries.

**Logic.** Export `updateTmuxRegistryState(db, sessionName, panes): Promise<void>`:
- Read existing `runtime.terminals`.
- Preserve entries where `ideName !== TMUX_IDE_NAME` (fleet entries, VS Code entries, Part 2 adoption entries).
- Replace entries where `ideName === TMUX_IDE_NAME` with the current tmux panes.
- Each entry: `{ friendlyName, role, status, paneId, sessionName, ideName: TMUX_IDE_NAME, purpose: 'tmux', cwd }`.
- Write back via `db.setConfigJson('runtime.terminals', merged)`.

**Edge Cases.** The merge pattern mirrors `PtyFleetService.updateRegistryState()` exactly — replace own entries, preserve others. This is what lets both backends coexist in one workspace DB.

### 4. `src/standalone/tmuxTeamSeating.ts` — liveness reconcile poll

**Context.** tmux has no event stream. The fleet uses `ptyProcess.onExit`. Pane death must be detected by polling.

**Logic.** Export `startTmuxReconcilePoll(db, intervalMs): { stop: () => void }`:
- Every `intervalMs` (default 5000), call `listTmuxPanes()`.
- For each `sb-*` session in the pane list, compare against `runtime.terminals` entries with `ideName === TMUX_IDE_NAME`.
- Panes in the registry but not in `listTmuxPanes()` → mark `status: 'exited'`.
- Panes in `listTmuxPanes()` but not in the registry → ignore (could be a session being created by a concurrent start).
- Write updated statuses back to `runtime.terminals`.
- If an entire session is gone (`has-session` false), mark all its seats as `status: 'exited'`.

**Decision: whole-session kill.** When the session is killed wholesale, all seats report dead. The team is NOT automatically reseated — reseat is an explicit operator action (start the team again, which hits the reconnect path and creates a fresh session). This is the safe answer: auto-reseating a team whose session was killed could spawn agents the operator deliberately stopped.

**Edge Cases.** The poll must be `.unref()`'d so it doesn't hold the process open. The poll must swallow all errors (tmux gone, DB locked) — a failed poll is a missed death detection, not a crash.

### 5. `src/services/TaskViewerProvider.ts` — extension host wiring

**Context.** `instantiateAgentGroup` (`:13187`) constructs `createHeadWithDelegates` calling `_ptyHostVerb('ptyCreateTerminal', ...)` at `:13233`. This is the extension host's composition root for team seating.

**Logic.** Before constructing `createHeadWithDelegates`, read the backend setting:
```ts
const backend = this._kanbanProvider?._getScopedSetting('terminalBackend', 'fleet') || 'fleet';
```
- If `backend === 'tmux'`: check `isTmuxAvailable()`. If false, return `{ success: false, error: 'tmux backend selected but tmux is not available...' }`. If true, construct the tmux `createHeadWithDelegates` callback (from `tmuxTeamSeating.ts`).
- If `backend === 'fleet'` or unset: existing `_ptyHostVerb` callback, unchanged.
- The `onCreated` hook (`:13250`) must also branch: for tmux, call `updateTmuxRegistryState` instead of `_updatePtyMirrorRegistry`.

**Wire safety.** The `ptyStartTeam` verb arm (`:3463`) must reject a wire-supplied `backend` field in the payload, the same way it rejects `payload.group` at `:3473`. Add:
```ts
if (payload && payload.backend) {
    return { success: false, error: 'Terminal backend cannot be supplied over the wire' };
}
```

**Edge Cases.** The setting read must use the same scoped-config path as other team settings (`_getScopedSetting`), not `vscode.workspace.getConfiguration` — the scoped config respects the board DB's config table, which is what the TEAMS tab and autostart also read.

### 6. `src/standalone/bootstrap.ts` — standalone host wiring

**Context.** `setAgentGroupInstantiator` (`:3056`) constructs `createHeadWithDelegates` calling `ptyFleetService.create()` + `spawnDelegates()` at `:3071-3093`. This is the standalone host's composition root for team seating.

**Logic.** Before constructing `createHeadWithDelegates`, read the backend setting:
```ts
const backend = kanbanProvider._getScopedSetting('terminalBackend', 'fleet') || 'fleet';
```
- If `backend === 'tmux'`: check `isTmuxAvailable()`. If false, return the refusal. If true, construct the tmux callback.
- If `backend === 'fleet'` or unset: existing `ptyFleetService` callback, unchanged.

**Standalone `ptyStartTeam` verb.** The `case 'ptyStartTeam'` arm at `:1740` must also reject a wire-supplied `backend` field, mirroring the extension host guard.

**Reconcile poll.** Start `startTmuxReconcilePoll(db, 5000)` after the server is up, alongside the existing paste-temp sweep (`:3133`). Store the stop handle and call it in the `stop()` closure (`:3649`).

**Edge Cases.** Standalone runs with `suppressLocalApiServer = true`, so `startTeamsOnLoad` (`:3632`) routes through `kanbanProvider.startAgentGroupById` → the registered instantiator. The setting read happens inside the instantiator, so autostart respects the backend choice automatically. No separate autostart wiring needed.

### 7. `src/services/TaskViewerProvider.ts` — `sendToTerminal` delivery arm

**Context.** `sendToTerminal` (`:15277`) tries the PTY fleet first (`:15291-15347`), then falls back to `TerminalBackend.findByName` (`:15373`). Neither reaches tmux panes.

**Logic.** Between the fleet-first path and the `TerminalBackend` fallback, add a tmux delivery arm:
1. Read `runtime.terminals` from the DB.
2. Find an entry where `friendlyName === name` and `ideName === TMUX_IDE_NAME` and `status === 'active'`.
3. If found: resolve the `TmuxTerminalHandle` via `TmuxTerminalBackend.findByName(name)` (Part 1) or by `paneId` from the registry entry.
4. Deliver via `sendPromptToTmux()` (prompt path) or `TmuxTerminalHandle.sendText()` (control string path), mirroring the fleet arm's branching at `:15321-15333`.
5. Return success/failure with the same shape as the fleet arm.

**Standalone equivalent.** On standalone, `sendToTerminal` is handled by `handlePtyVerb` in `bootstrap.ts`. The `handlePtyVerb` wrapper needs the same tmux delivery arm — check `runtime.terminals` for a tmux entry matching the name, route to `sendPromptToTmux()`. This is the second composition-root wiring point for delivery (the first being the seating callback in change 6).

**Edge Cases.** A name that matches both a fleet terminal and a tmux pane — the fleet-first path wins (it checks first). This is correct: the fleet path is the default, and a name collision between backends is an operator error, not a routing decision. The `friendlyName` uniqueness is enforced by the fleet's collision counter and the tmux path's use of the same derivation.

### 8. Do not touch the team model

Roles, roster, definition resolution, the wire-safety guard at `TaskViewerProvider.ts:3473`, standing orders and dispatch all stay as they are. The `instantiateAgentGroupCore` flow (`agentGroupInstantiation.ts:83-182`) runs unchanged — caps pre-flight, `wireSpawnedTeam`, group registration, `onCreated` hook. Only the `createHeadWithDelegates` callback and the `onCreated` registry update branch on the backend. If this plan finds itself editing team semantics, the seam is in the wrong place.

### Multi-device attach: a phone must not resize the Mac

The feature's stated value is attaching "from the Mac, the iPad, or a different network". tmux does not size windows per client — with tmux 3.x's default `window-size latest`, the most recently attached client's dimensions win for **every** attached client. So a phone attaching at 80x20 resizes the team's window to 80x20 and the Mac's grid collapses into a corner of its terminal.

A four-pane team grid at phone dimensions is roughly 40x10 per pane. It renders; it cannot be read.

Two things follow, and neither is in the plan today:

- **Attach through a session group, not the session itself.** `tmux new-session -t <session>` gives each device its own client session sharing the same windows, with independent current-window and independent sizing. Document this as the attach gesture — a bare `tmux attach` is the one that squashes everyone.
- **The grid is not the phone view.** On a small client the expected workflow is one zoomed pane at a time (`prefix z`), switching between seats. Whatever guidance ships with this feature should say so rather than implying the grid travels.

Decide whether Switchboard sets `window-size` explicitly on the sessions it creates, or documents the attach gesture and leaves the default. Setting it to `manual` with an explicit size makes the box's own layout authoritative and stops any attach from resizing it — at the cost of a client whose terminal is smaller than that size scrolling rather than reflowing.

## Verification Plan

### Automated Tests

1. **Session name derivation.** `deriveTmuxSessionName('My Team')` → `sb-my-team`. `deriveTmuxSessionName('foo.bar:baz')` → `sb-foo-bar-baz`. `deriveTmuxSessionName('')` → `sb-team`. Names with special characters produce only `[a-z0-9_-]` after the prefix.
2. **`createHeadWithDelegates` tmux callback.** Mocked `TmuxTerminalBackend`: one session created, one pane per member, `pane_title` set to each member's friendly name, result shape matches `AgentGroupCreateResult`.
3. **Reconnect.** Mock `has-session` returning true with matching pane titles → callback reattaches (no `new-session`/`new-window` calls), returns existing pane ids. Mock with mismatched titles → returns `{ success: false, error: ... 'refusing to adopt' ... }`.
4. **Registry coexistence.** `updateTmuxRegistryState` with a DB containing fleet entries (`ideName: 'switchboard-pty'`) and tmux entries (`ideName: 'switchboard-tmux'`) → fleet entries preserved, tmux entries replaced.
5. **Liveness reconcile.** Mock `listTmuxPanes()` returning fewer panes than the registry → missing panes marked `status: 'exited'`. Mock `has-session` false → all session seats marked exited.
6. **Wire safety.** `ptyStartTeam` verb with `payload.backend` → rejected with 'Terminal backend cannot be supplied over the wire', on both hosts.
7. **Availability refusal.** `isTmuxAvailable()` returning false + setting `tmux` → `createHeadWithDelegates` returns refusal naming the setting. No fleet fallback.
8. **Delivery arm.** Mocked `sendToTerminal` with a `runtime.terminals` entry `ideName: 'switchboard-tmux'`, `status: 'active'` → routes to `sendPromptToTmux`, not `_ptyHostVerb` or `TerminalBackend.findByName`.
9. **Both hosts.** A contract test asserting both `TaskViewerProvider.instantiateAgentGroup` and `bootstrap.ts`'s `setAgentGroupInstantiator` read the `terminalBackend` setting and branch on it. This is the divergence-trap guard.

### Goal Invariants

1. **Default unchanged.** With no `terminalBackend` setting, `startTeamForWorkspace` calls `_ptyHostVerb('ptyCreateTerminal', ...)` on the extension host and `ptyFleetService.create()` on standalone — assert no `tmux` argv appears in either path's mocked calls.
2. **One seating path.** Assert `startTeamById` (`teamWiring.ts:1211`) is the single entry point for both backends — no second `startTeam*` function exists for tmux.
3. **`friendlyName` stability.** The same team seated in each backend produces identical `friendlyName` values — assert the name derivation function is shared, not duplicated.
4. **Registry coexistence.** After seating one fleet team and one tmux team in the same workspace, `runtime.terminals` contains entries with both `ideName: 'switchboard-pty'` and `ideName: 'switchboard-tmux'` — assert neither clobbers the other.
5. **No wire backend.** Assert `payload.backend` is rejected in both hosts' `ptyStartTeam` verb arms — the guard exists in `TaskViewerProvider.ts:3463` and `bootstrap.ts:1740`.

### Manual Verification

1. **Default is unchanged.** With no setting, seat a team and confirm it lands in the PTY fleet exactly as today. Byte-compare the fleet-state projection against a pre-change run if practical; this is what protects every existing install.
2. **tmux seating works end to end.** Set the backend to tmux, seat a team, and confirm: one session created (`sb-<teamname>`), one pane per member, `tmux list-panes -a` shows them, and the TEAMS tab roster shows the same members as a fleet-seated team.
3. **Dispatch reaches a tmux seat.** Dispatch a plan to a tmux-backed member and confirm the prompt arrives, the card moves, and the terminal header names the plan — the whole delivery chain, not just the send.
4. **Seat names are backend-independent.** The same team seated in each backend produces identical `friendlyName` values. This is the assertion that protects dispatch attribution and completion reports.
5. **Durability — the reason for the feature.** Seat a team over ssh, drop the connection, reconnect, and confirm the members are still running and still registered. Then attach with `tmux attach` and confirm the panes are the team's.
6. **Reconnect.** Restart Switchboard (not tmux) with a surviving `sb-*` session. Start the same team. Confirm it reattaches (no new session created), seats show live, dispatch works.
7. **Kill a pane externally** (`tmux kill-pane`) and confirm the seat reports dead within the reconcile interval rather than lingering as live-but-unreachable.
8. **Kill the whole session** and confirm all seats report dead. Starting the team again creates a fresh session (no auto-reseat).
9. **Existing session name collides** (non-matching panes) — refuse, do not adopt.
10. **tmux absent** — with the setting on and tmux uninstalled, seating refuses with a message naming the setting, and does not silently use the fleet.
11. **Wire safety.** A caller supplying a backend in the verb payload is ignored or rejected, matching the existing group-definition guard.
12. **Both hosts.** The extension and standalone both reach `startTeamForWorkspace`. tmux is unavailable on native Windows, so confirm the extension host on Windows refuses cleanly rather than erroring obscurely — the WSL path is `b59e9fae`'s subject, not this plan's.
13. **Standing orders delivered.** Seat a tmux-backed team, dispatch a message, and confirm standing orders are prepended — the delivery arm reaches tmux seats, not just dispatch prompts.

## Outstanding Questions

- **[user]** Reconnect policy: reattach to a surviving `sb-*` session with matching pane titles, or refuse and require a fresh start? — proceeding on the assumption that reattach is correct, because refusing contradicts the durability goal (the whole point of the feature). The plan implements reattach with roster-match verification; confirm before coding.
