# Team start silently spawns bare shells for roles with no startup command

## Goal
Make team start report the seats it could not give a CLI to. A team whose head or member role has no resolvable startup command currently spawns a bare shell and says nothing; the operator sees a full, correctly-named team on screen and only discovers the dead seat when they type into it.

### Problem Analysis
Custom agents are machine-global (`~/.switchboard/integration-config.json`); teams are per-workspace (`kanban.db`, `terminals.agentGroups`). Deleting a custom agent is deliberately **not** allowed to prune team rosters — that would rewrite the operator's saved team, which is the exact corruption class `feature_plan_20260818111426_standalone_agent_creation_and_team_isolation.md` exists to prevent. `handleDeleteCustomAgent` (`src/services/TaskViewerProvider.ts:11883-11896`) removes the agent, its `visibleAgents` entry and its `startupCommands` entry, and correctly leaves every team roster alone.

That is the right trade, and it leaves a dangling role behind by design. The editor half of the trade already landed: `teamsTabRoleOptions` re-injects an unknown stored role as `<role> (not configured)` so opening and saving a team no longer silently rewrites it. The **start** half never landed.

Three ways a team acquires a role with no startup command, all reachable today:
1. A custom agent used as a team head or member is deleted.
2. A team is authored in a workspace, then the same `kanban.db` roster is opened on a machine where that custom agent was never created.
3. A built-in role that has no configured command — the AGENTS tab ships every role's command field blank until the operator fills it.

### Root Cause
`PtyFleetService.injectStartupCommand` (`src/standalone/ptyFleetService.ts:360-374`) resolves the command and returns silently when there is none:

```ts
let cmd = startupCommand;
if (!cmd) {
    const commands = await GlobalIntegrationConfigService.getAgentStartupCommands() || {};
    cmd = commands[role];
}
if (!cmd) { return; }   // <-- the seat is now a bare shell, and nobody is told
```

Both team seats reach that line with nothing to fall back on:
- **Head:** `ptyHost.ts:76-91` deliberately passes no `startupCommand` off the wire (honouring a caller-supplied one would turn the verb into a command-execution endpoint), so the head always depends on the role lookup.
- **Members:** `spawnDelegates` passes `d.startupCommand` (`src/standalone/ptyFleetService.ts:496`, `:533`), which is `undefined` for any member row authored in the TEAMS tab — `teamsTabSaveAgentGroup` only carries a `startupCommand` forward when the previous definition already had one.

The silence is the defect, not the bare shell. The same condition is already treated as an error one function away: `createBatch` (`src/standalone/ptyFleetService.ts:606-610`) refuses outright with `no startup command for role '<role>'`. Team start and batch start disagree about whether this is worth mentioning.

## Metadata
**Complexity:** 5
**Tags:** bugfix, reliability, ux, cli

## User Review Required
None.

## Complexity Audit

### Routine
- Add an optional `commandlessRoles?: string[]` to `InstantiateAgentGroupResult` (`src/services/agentGroupInstantiation.ts:61-75`), alongside the existing `delegateError` / `teamGroupId` non-fatal channels.
- Resolve the roster's commands once in `instantiateAgentGroupCore` before spawning and populate the field.
- Surface it in `startTeam`'s inline toast logic (`src/webview/terminals.js:7147-7154`).

### Complex / Risky
- **`startTeam`'s `if/else if` chain shows only one toast.** The inline toast logic at `terminals.js:7147-7154` is mutually exclusive — `if (data.delegateError) … else if (data.error) … else if (seatNote) …`. A team that has a delegate error AND a commandless seat would show only the delegate error. The `commandlessRoles` note must be composed into each branch (appended like `seatNote`), not added as a new `else if` — otherwise it is invisible whenever any other channel fires. This is the "green while incomplete" shape: the field is on the response, the test asserts it, and the operator still learns nothing when another channel is also active.
- **No host-specific forwarding needed — but the field must be on every success return.** The `ptyStartTeam` path returns `instantiateAgentGroupCore`'s result directly to the webview (`bootstrap.ts:1391` `return result;`, `TaskViewerProvider.ts:11969` `return result;`). There is no host-specific response builder on this path, so the "both-hosts drift" risk that affects the `ptyCreateTerminal` path does not apply here. The field must still be threaded onto both success returns of `instantiateAgentGroupCore` (the `wired.ok === false` return at line ~138 and the normal return at line ~147), or a team that both failed wiring and has a dead seat loses the commandless report.

> **Superseded:** Both-hosts result threading is a risk because each host builds its own create response.
> **Reason:** The `ptyStartTeam` path — the actual team-start path — returns `instantiateAgentGroupCore`'s result directly to the webview with no host-specific response builder in between. The create-response builders at `bootstrap.ts:1454` and `TaskViewerProvider.ts:2978-2998` are on the `ptyCreateTerminal` path, which does not go through `instantiateAgentGroupCore` and unconditionally sets `delegates: []`. The both-hosts drift risk does not exist on the path that carries `commandlessRoles`.
> **Replaced with:** No host-specific forwarding needed. The field flows directly from `instantiateAgentGroupCore` through `startTeamById` → `startTeamForWorkspace` / `startAgentGroupById` → the `ptyStartTeam` verb return → the webview's `startTeam()` function.

> **Superseded:** `reportTeamStart`'s early returns are a risk — the function `return`s after `delegateError` and again after `wiringError`, so a team that half-spawned and has a commandless seat would report only the first.
> **Reason:** `reportTeamStart` (`terminals.js:7053`) is called from the `ptyCreateTerminal` path (line 6940), not the team-start path. The `ptyCreateTerminal` path unconditionally sets `delegates: []` (`bootstrap.ts:1415`, `TaskViewerProvider.ts:2829`), so `delegateError` and `wiringError` are never set — the early returns never fire. The actual team-start path is `startTeam()` (line 7078), which does NOT call `reportTeamStart` and has its own inline toast logic (lines 7147-7154) with a comment at line 7136 explicitly saying "NOT reportTeamStart".
> **Replaced with:** The real risk is `startTeam`'s `if/else if` chain (lines 7147-7154), which shows only one toast. The `commandlessRoles` note must be composed into each existing branch — appended like `seatNote` — not added as a new `else if`.

## Edge-Case & Dependency Audit

- **Race Conditions:** `getAgentStartupCommands()` reads the global config file. Resolving once per team start (rather than once per seat inside `injectStartupCommand`) narrows, but does not close, the window where the operator edits a command mid-start. That is acceptable and already the status quo — the pre-flight result is advisory text, not a gate, so a stale read produces a slightly wrong warning, never a wrong spawn. Do **not** add a lock.
- **Security:** Report role names only. Startup commands are arbitrary shell lines and must not be echoed into a toast — `ptyHost.ts:84-90` refuses wire-supplied commands for precisely this reason, and a toast is rendered in a webview.
- **Side Effects:** The pre-flight must not spawn, must not write to `terminals.agentGroups`, and must not mutate the stored team. It reads the roster and the command map, nothing else. A commandless seat still spawns: terminals are real and the house contract (`spawnDelegates`' best-effort branches, `wiringError`) is never to roll back a live pty.
- **Dependencies & Conflicts:** `agentGroupInstantiation.ts` already imports from `../standalone/ptyFleetService`, so importing `GlobalIntegrationConfigService` from `./GlobalIntegrationConfigService` stays inside its existing import surface and bundles for both hosts. No new dependency.
- **Shared members:** A `scope: 'shared'` member that reuses an already-live terminal never re-runs `injectStartupCommand`. It must not be reported as commandless — it is already running whatever it was started with.
- **`count > 1`:** Report the role once, not once per replica.

## Dependencies
- `src/services/agentGroupInstantiation.ts` — `instantiateAgentGroupCore`, `InstantiateAgentGroupResult`; the single shared team-start seam. The `ptyStartTeam` path returns its result directly to the webview (`bootstrap.ts:1391`, `TaskViewerProvider.ts:11969`), so no host-specific response builder is in between.
- `src/standalone/ptyFleetService.ts` — `injectStartupCommand`, `spawnDelegates`, `createBatch`; owns the resolution rule being mirrored.
- `src/services/GlobalIntegrationConfigService.ts` — `getAgentStartupCommands()`.
- `src/webview/terminals.js` — `startTeam` (line 7078), the `ptyStartTeam` consumer with its own inline toast logic (lines 7147-7154). This is the actual team-start display path — NOT `reportTeamStart` (line 7053), which is on the `ptyCreateTerminal` path and does not receive `commandlessRoles`.

> **Superseded:** `src/webview/terminals.js` — `reportTeamStart`, the only start entry point (`teams-tab-no-start-contract.test.js` pins that the TEAMS tab does not start teams).
> **Reason:** `reportTeamStart` is called from the `ptyCreateTerminal` path (line 6940), not the team-start path. The `teams-tab-no-start-contract.test.js` pins that the terminals panel's START TEAM button is the single entry point — that button calls `startTeam()` (line 7078), which posts to `ptyStartTeam` and has its own inline toast logic. `startTeam()` does NOT call `reportTeamStart`; the comment at line 7136 explicitly says "NOT reportTeamStart".
> **Replaced with:** `src/webview/terminals.js` — `startTeam` (line 7078), the `ptyStartTeam` consumer. Its inline toast logic at lines 7147-7154 is where `commandlessRoles` must be displayed.

## Adversarial Synthesis
Key risks: the `commandlessRoles` note is added as a new `else if` branch in `startTeam`'s mutually exclusive toast chain and is invisible whenever another channel fires (delegate error, wiring error, seat fallback); the field is threaded onto only the normal success return of `instantiateAgentGroupCore` and lost when wiring fails; and scope creep into pruning dangling roles, which would destroy the saved team the parent plan protects. Mitigations: compose the note into each existing branch (appended like `seatNote`, not a new branch), thread onto both success returns including `wired.ok === false`, and an explicit non-goal forbidding any write to `terminals.agentGroups`.

## Proposed Changes

### [MODIFY] `src/services/agentGroupInstantiation.ts`
- **Context:** `instantiateAgentGroupCore` (line 77) is where both hosts converge and where `group.headRole` and `group.members` are both in hand, before `createHeadWithDelegates` at line 108. The `ptyStartTeam` path returns this function's result directly to the webview — no host-specific response builder in between — so the field flows to the consumer with no forwarding needed.
- **Logic:**
  1. Extend `InstantiateAgentGroupResult` (line 61) with `commandlessRoles?: string[]`, documented as advisory and non-fatal, in the same comment style as `teamGroupId`.
  2. After the delegate-cap checks and before `createHeadWithDelegates`, read `GlobalIntegrationConfigService.getAgentStartupCommands()` **once**.
  3. Build the candidate list: `group.headRole || 'lead'`, plus each member's `role`. Skip any member carrying its own `d.startupCommand`, and skip `scope: 'shared'` members (a reused live terminal is not re-injected). De-duplicate by role.
  4. A role is commandless when the command map has no non-empty entry for it. Collect those into `commandlessRoles` and return it on the result. Never fail the start on this.
- **Implementation:**
```ts
// Advisory pre-flight, NOT a gate. injectStartupCommand returns silently when a
// role resolves to nothing (ptyFleetService.ts:367), so the seat spawns as a bare
// shell and the operator is told nothing. Mirror that exact resolution rule here
// so the report cannot drift from the behaviour it describes.
//
// Read ONCE per start, not per seat: the map is a file read and a commandless
// seat is a report, not a spawn decision, so a stale read is harmless.
const startupCommands = (await GlobalIntegrationConfigService.getAgentStartupCommands()) || {};
const hasCommand = (role: string) => typeof startupCommands[role] === 'string'
    && startupCommands[role].trim().length > 0;

const candidates = new Set<string>([group?.headRole || 'lead']);
for (const m of members) {
    // A member with its own command never consults the role map; a shared member
    // that reuses a live terminal is never re-injected at all.
    if (m?.startupCommand || m?.scope === 'shared') { continue; }
    if (typeof m?.role === 'string' && m.role) { candidates.add(m.role); }
}
const commandlessRoles = [...candidates].filter(r => !hasCommand(r));
```
  Thread `...(commandlessRoles.length ? { commandlessRoles } : {})` onto **both** success returns of `instantiateAgentGroupCore`: the `wired.ok === false` return at line ~138 (a team that both failed wiring and has a dead seat has two things wrong with it) and the normal return at line ~147. Do NOT add it to the `success: false` returns (lines 82, 101, 105, 116) — those are refusals before or during spawn, not advisory reports on a team that started.
- **Edge Cases:** Member-less team → the head alone is checked. Empty/whitespace command string counts as commandless (`injectStartupCommand`'s `if (!cmd)` treats `''` as absent). External-headed teams (`instantiateExternalHeadedTeam`) spawn no head — if that path gains the field, it must skip the head role.

> **Superseded:** Thread `commandlessRoles` onto every success return of `instantiateAgentGroupCore`, and forward it in both hosts' create-response builders (`bootstrap.ts:1454` and `TaskViewerProvider.ts:2978-2998`).
> **Reason:** The create-response builders are on the `ptyCreateTerminal` path, which does not go through `instantiateAgentGroupCore` and unconditionally sets `delegates: []`. `commandlessRoles` would never be on those responses. The `ptyStartTeam` path returns `instantiateAgentGroupCore`'s result directly — no forwarding needed.
> **Replaced with:** Thread onto both success returns of `instantiateAgentGroupCore` only. No host-specific forwarding changes needed — the `ptyStartTeam` path carries the field directly.

### [MODIFY] `src/webview/terminals.js` — `startTeam` (line 7078)
- **Context:** `startTeam` is the `ptyStartTeam` consumer — the actual team-start display path. It does NOT call `reportTeamStart` (the comment at line 7136 explains why). Its inline toast logic at lines 7147-7154 uses `if/else if/else if` — mutually exclusive, only one toast. The `seatNote` variable (line 7144) is already composed into each branch; `commandlessRoles` must follow the same pattern.
- **Logic:**
  1. Build a `commandlessNote` string from `data.commandlessRoles` (absent or empty → empty string): ` No CLI configured for: <roles>. Those seats are bare shells; set a command in the AGENTS tab.`
  2. Append `commandlessNote` to each existing toast branch, the same way `seatNote` is appended — so the note appears regardless of which channel fires (delegate error, wiring error, or seat fallback).
  3. Role names only — never the command text.
- **Implementation:**
```js
const commandlessNote = Array.isArray(data.commandlessRoles) && data.commandlessRoles.length
    ? ` No CLI configured for: ${data.commandlessRoles.join(', ')}. Those seats are bare shells; set a command in the AGENTS tab.`
    : '';
if (data.delegateError) {
    showPaneToast(`Team started with a delegate warning: ${data.delegateError}${seatNote}${commandlessNote}`);
} else if (data.error) {
    showPaneToast(`Team started with a warning: ${data.error}${seatNote}${commandlessNote}`);
} else if (seatNote || commandlessNote) {
    showPaneToast(`${seatNote}${commandlessNote}`.trim());
}
```
- **Edge Cases:** Absent or empty array → empty string, no effect. Keep the message to one toast; do not add a modal, a badge, or a confirm gate (`CLAUDE.md`: no confirmation dialogs, and `window.confirm` is a silent no-op in webviews anyway).

> **Superseded:** Modify `reportTeamStart` (line 7053) — drop the `return` after `delegateError` and `wiringError` so all channels compose, and add `commandlessRoles` as its own line.
> **Reason:** `reportTeamStart` is on the `ptyCreateTerminal` path (line 6940), which always sets `delegates: []` and never goes through `instantiateAgentGroupCore`. `commandlessRoles` would never be on the data `reportTeamStart` receives. The early returns never fire because `delegateError` and `wiringError` are never set on a delegates-less create. The actual team-start path is `startTeam` (line 7078), which has its own inline toast logic and does NOT call `reportTeamStart`.
> **Replaced with:** Modify `startTeam`'s inline toast logic (lines 7147-7154) — compose `commandlessNote` into each existing branch, appended like `seatNote`.

### Non-goals
- Do **not** prune dangling roles from `terminals.agentGroups` on custom-agent delete. That rewrites the operator's saved team — the corruption class the parent plan removed.
- Do **not** substitute a default CLI for a dangling role. Running the wrong agent under the right name is worse than a bare shell.
- Do **not** block or roll back the start. Terminals are real once spawned.
- Do **not** modify `reportTeamStart` or the `ptyCreateTerminal` create-response builders. The create path always sets `delegates: []` and does not go through `instantiateAgentGroupCore`; `commandlessRoles` is never on that path.

## Verification Plan

### Automated Tests
Extend `src/test/standalone-agent-team-isolation-contract.test.js` (already CI-wired as `test:contract:standalone-agent-isolation`, `.github/workflows/integration-tests.yml:740`) rather than adding a new gate — same subject, and a new file needs its own CI wiring to avoid the defined-but-not-invoked hole:

1. `instantiateAgentGroupCore` reads `getAgentStartupCommands` and returns `commandlessRoles` — assert the resolution rule and the field on the result type.
2. The pre-flight skips members carrying their own `startupCommand` and members with `scope: 'shared'`.
3. `commandlessRoles` appears on **both** success returns of `instantiateAgentGroupCore` — the normal return AND the `wired.ok === false` return. This is the guard against losing the report when wiring also fails.
4. `startTeam`'s inline toast logic composes `commandlessRoles` into every branch — assert the `commandlessNote` string appears in the delegate-error toast, the wiring-error toast, and the seat-fallback toast. This is the "green while incomplete" guard: the field must reach the operator regardless of which other channel fires.
5. The pre-flight writes nothing: assert `instantiateAgentGroupCore`'s new block references no team-writing helper (`mutateTerminalGroups`, `saveTerminalGroupsGuarded`, `TERMINALS_GROUPS_KEY`).

> **Superseded:** Assert `commandlessRoles` appears in both `bootstrap.ts`'s response literal and `TaskViewerProvider.ts`'s result mutation (the drift guard).
> **Reason:** The `ptyStartTeam` path returns `instantiateAgentGroupCore`'s result directly — there is no host-specific response builder to drift. The create-response builders at `bootstrap.ts:1454` and `TaskViewerProvider.ts:2978-2998` are on the `ptyCreateTerminal` path, which never carries `commandlessRoles`.
> **Replaced with:** Assert `commandlessRoles` appears on both success returns of `instantiateAgentGroupCore` (the normal return and the `wired.ok === false` return), and that `startTeam`'s inline toast logic composes it into every branch.

> **Superseded:** Assert `reportTeamStart` handles `commandlessRoles` and no longer early-returns after `delegateError` / `wiringError`.
> **Reason:** `reportTeamStart` is on the `ptyCreateTerminal` path and never receives `commandlessRoles`. The actual display path is `startTeam`'s inline toast logic.
> **Replaced with:** Assert `startTeam`'s inline toast logic composes `commandlessNote` into every branch (delegate-error, wiring-error, seat-fallback).

Mutation-verify each new assertion — remove the guard, confirm the test goes red. A contract test that passes with the change reverted is decoration.

### Manual Checks
1. Create a custom agent with a command, make it a team member, save the team, delete the agent, start the team → team starts, one toast names the role, the seat is a bare shell, and the team definition still lists the role.
2. Re-create the custom agent with the same role, start again → no toast.
3. Team with every role configured → no toast, no behaviour change.
4. Force a wiring failure on a team that also has a commandless role → both messages appear (wiring error + commandless note in the same toast).
5. Force a delegate error on a team that also has a commandless role → both messages appear (delegate error + commandless note in the same toast).

---

**Recommendation:** Send to Coder (complexity 5).

## Implementation Summary
Added advisory pre-flight check in `instantiateAgentGroupCore` to inspect agent startup commands and populate `commandlessRoles` on `InstantiateAgentGroupResult`. The field is threaded across both normal and wiring-failure success returns while preserving existing delegate and seating logic. Updated `startTeam` in `terminals.js` to compose `commandlessNote` across all toast branches so operators receive notice when bare shells spawn without configured CLIs. Added contract tests in `standalone-agent-team-isolation-contract.test.js` validating command resolution, skipping of shared/commanded members, result threading, toast composition, and isolation from team store mutations.

## Review Findings

Reviewed commit `6db5751`. No code changes were needed for this subtask — the implementation matches the plan exactly and no defect survived verification. `instantiateAgentGroupCore` reads `GlobalIntegrationConfigService.getAgentStartupCommands()` once per start, mirrors `injectStartupCommand`'s resolution rule verbatim (empty/whitespace counts as absent), skips members carrying their own `startupCommand` and `scope: 'shared'` members, de-duplicates by role, threads `commandlessRoles` onto both success returns including the `!wired.ok` one, and writes nothing to any team store; `startTeam` composes `commandlessNote` into all three toast branches rather than adding a fourth. Inbound field-existence checks passed: `scope: 'shared'` is written by the seeded team templates in `kanban.html` and consumed at `ptyFleetService.ts:692`, and `create()` falls back to the same global command map (`ptyFleetService.ts:428-436`), so the report cannot drift from the behaviour it describes. Verification: `tsc -p tsconfig.test.json` clean, `eslint` 0 errors, and `test:contract:standalone-agent-isolation` (CI-wired at `.github/workflows/integration-tests.yml:1029`) green at 23/23 including this subtask's five new assertions.

## Deferred Findings

- NIT — `src/services/agentGroupInstantiation.ts:120` — the advisory pre-flight performs a global-config file read on every team start, including the common case where every role is configured. Harmless, and moving it behind a "did anything resolve empty" check would require the read anyway.
- NIT — `src/services/agentGroupInstantiation.ts:184` — `instantiateExternalHeadedTeam` does not report `commandlessRoles`. The plan's edge-case note anticipated this (that path spawns no head, so it would have to skip the head role); externally-headed teams therefore still start their members silently when a member role has no command.
