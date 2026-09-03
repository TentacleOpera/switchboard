# Two stores hold agent startup commands, they currently disagree, and a spawned seat records no evidence of which one it read

## Goal

Make the startup command a seat launched with an auditable fact, and collapse the stores that can answer "what does a coder run?" down to one. Today a seat can spawn on a stale command with nothing in the fleet record, the log, or the UI naming where that command came from.

### Problem Analysis

**The observation.** Starting the Coding team after replacing the `agy` coder command with a Devin one in Agent Setup produced two coder seats that disagreed: `coder-1` launched `agy` and died with *"process exited with code 0"*; `coder-2` launched the Devin command as configured. Both are `per-team` members of the same `{ role: 'coder', count: 2 }` definition, spawned by the same loop.

**The measured discrepancy.** Two stores hold `startupCommands` for this machine, and they do not agree:

| role | `~/.switchboard/integration-config.json` (global) | `kanban.db` `config['agents.startupCommands']` (per-workspace) |
| :--- | :--- | :--- |
| coder | `devin --permission-mode bypass` | **`agy`** |
| intern | `devin --permission-mode bypass` | **`agy`** |
| lead | `devin --permission-mode bypass` | `claude` |
| reviewer | `claude` | `devin --permission-mode bypass` |
| analyst | `claude` | `qwen` |

**`agy` appears nowhere in the global file for `coder`.** The only place that string exists for that role is the per-workspace DB row. A seat that launched `agy` therefore did not read the global file.

**What the intended path looks like.** `PtyFleetService.create` resolves:

```ts
let effectiveStartupCommand = startupCommand;          // explicit argument wins
if (!effectiveStartupCommand) {
    const commands = await GlobalIntegrationConfigService.getAgentStartupCommands() || {};
    effectiveStartupCommand = commands[role];
}
```
(`ptyFleetService.ts:428-437`)

`spawnDelegates` passes `d.startupCommand` from the team definition (`:717`, `:754`). The persisted Coding team carries **no** `startupCommand` on either member — `{"role":"coder","count":2,"scope":"per-team","relationship":"reports-to-head"}` — so both coders take the config branch and should resolve identically. `getAgentStartupCommands` reads the file fresh on every call (`loadGlobal`, no cache), so a stale read is not explained by caching either. The extension's own instantiator reads the same global file (`agentGroupInstantiation.ts:121`).

**A third store the original analysis missed.** `TaskViewerProvider.getStartupCommands()` (`TaskViewerProvider.ts:8201`) has a multi-level fallback chain:

1. Global file via `GlobalIntegrationConfigService.getAgentStartupCommands()` (`:8207`).
2. Per-IDE `globalState` key `switchboard.agents.startupCommands` (`:8218`).
3. `state.json` via the bridge (`:8233`) — but `TaskViewerProvider` imports `stateFs as fs` (`:26`), and the bridge routes `startupCommands` reads back to the global file (`stateConfigBridge.ts:72-78`). So level 3 is dead code: it re-reads the same file as level 1 and can never return a value level 1 didn't.

Level 2 (`globalState`) is a **live stale store**. The seed migration (`_migrateStartupCommandsToGlobalFile`, `:2812`) reads `globalState` as a candidate source (`:2855-2858`) and writes it to the global file — but never clears `globalState`. So after the seed runs, `globalState` holds a snapshot that can disagree with the file. `getStartupCommands()` falls back to it whenever the global file returns `undefined` for the key (which happens when the file exists but lacks `startupCommands` entirely). This is used in 9+ call sites including the Mission Control terminal spawn path (`:12054`, which sends the command via `vscode.window.createTerminal` + `sendText`, completely outside the PTY fleet).

In the plan's specific scenario (global file has `startupCommands` with `devin` for coder), `getStartupCommands()` returns the global file value and does not fall through to `globalState`. So this third store does not explain the coder-1/coder-2 split — but it is another "retired but not deleted" store that must be collapsed in the same pass.

### Root Cause

**The legacy per-workspace DB row was never retired, a per-IDE `globalState` copy was never cleared, and nothing records which store a seat actually read.**

`stateConfigBridge.ts:14` puts `startupCommands` in `AGENT_GLOBAL_FILE_KEYS` — machine-global, redirected to `~/.switchboard`. Yet `STATE_KEY_TO_CONFIG` at `:30` *also* maps it to `agents.startupCommands`, and `_migrateStartupCommandsToGlobalFile` (`TaskViewerProvider.ts:2812`) seeds the file from the DB once and **never deletes the DB row**. The stale copy is left on disk by design, guarded only by the assumption that nothing reads it any more.

The `stateConfigBridge` redirect (`:72-78`) means all known state.json read paths route to the global file, not the DB row. `PtyFleetService.create` (`:431`) and `agentGroupInstantiation.ts:121` both read the global file directly. So in the current code, no known spawn path reads the DB row — the bridge retired it for reads. But the DB row still exists on disk, can disagree with the file, and nothing proves no code path bypasses the bridge. The `globalState` copy is not redirected by the bridge — `getStartupCommands()` reads it directly as a fallback.

That assumption is unverifiable from the outside, because **`effectiveStartupCommand` is resolved and then discarded.** It is used to derive `cliFamily` (`:437`) and to launch, but the command string and its provenance are never stored on the handle, never logged at spawn, and never surfaced in `ptyListTerminals`. So when a seat launches the wrong binary there is no artifact anywhere that says which branch produced it — the explicit argument, the global file, or a legacy store. This plan does not guess which; it makes the question answerable and removes the duplicates that make it ambiguous.

**Why "process exited with code 0" is the visible symptom rather than a clear error:** the shell runs `agy`, the binary is absent or exits immediately, and the PTY reports a clean exit. Nothing distinguishes "your startup command is stale" from "your agent finished".

### Non-goals

- **Do not change which store wins.** The global file is already the documented source of truth and every reader in `src/` prefers it. This plan records provenance and retires the duplicates; it does not re-rank the precedence.
- **Do not delete the legacy DB row without a migration.** It ships in released versions and is the seed source for any install that has not yet run `globalFileSeed.v2`.
- Not fixing the readiness/timing consequence — that is `a-seats-cli-family-is-frozen-at-spawn.md`, which depends on this one.
- **Mission Control terminal spawn path is out of scope for provenance recording.** `TaskViewerProvider.ts:12054` creates a VS Code native terminal and sends the startup command via `sendText`, completely outside the PTY fleet. It has no `ExtendedTerminalHandle` and no `ptyListTerminals` entry. Instrumenting it is a separate plan — flagged in Outstanding Questions.

## Metadata

**Topic:** Startup command provenance is recorded and the duplicate stores are retired
**Complexity:** 6
**Tags:** bugfix, reliability, cli, refactor

## User Review Required

None. The precedence order is unchanged; this adds evidence and removes duplicates.

## Complexity Audit

### Routine
- Storing `effectiveStartupCommand` and its source on `ExtendedTerminalHandle`.
- Adding both to the `ptyListTerminals` projection (`ptyHost.ts:164-184`) and to the spawn log line.
- Stripping the dead `state.json` fallback (level 3) from `getStartupCommands()` — it re-reads the global file through the bridge and can never diverge from level 1.
- Stripping the `globalState` fallback (level 2) from `getStartupCommands()` — collapse to a single `getAgentStartupCommands()` call.

### Complex / Risky
- **Retiring the DB row is a migration against ~4,000 installs.** Per `CLAUDE.md`, state that shipped must be migrated, not unlinked. An install that has never run the `globalFileSeed.v2` pass still depends on that row as its only source. The row may only be removed *after* the global file has a value for that role — the file is the source of truth and the archive preserves the row as `.migrated.bak`.

> **Superseded:** The row may only be removed *after* the seed has demonstrably run and the global file is non-empty — and the seed's own guard `(b)` ("never overwrite an existing non-empty global value") means a machine whose file was populated by hand never ran the seed at all. Deleting on "file is non-empty" alone would discard the only copy of a config the seed never read.
> **Reason:** The seed flag (`globalFileSeed.v2`) is set unconditionally at `TaskViewerProvider.ts:2867` after the key loop, regardless of whether guard `(b)` skipped any keys. A machine whose file was hand-populated: seed ran, flag set, but the DB row was never read for that key. "The seed never ran" is false; "the seed never reconciled that key" is true. The flag does not track per-key reconciliation, so gating the delete on it does not protect against the scenario described.
> **Replaced with:** Gate the delete on the **compare step**: only archive+delete the DB row when the global file has a value for that role (file is source of truth). When the file lacks the role but the DB row has it, leave both untouched and log the divergence — the DB row may be the only source on a machine that never seeded. The seed flag is logged as context, not used as a gate.

- **The seed flag is per-IDE, not per-machine.** `globalFileSeed.v2` lives in VS Code `globalState` (`TaskViewerProvider.ts:2814`). The standalone host has no `globalState` and cannot check it. The reconcile pass must work without the flag — the compare logic (file has the role vs DB has the role) does not need it. A machine that only ever used the standalone host: flag never set, DB row is the only source. A machine that used VS Code then switches to standalone: standalone sees no flag, leaves both stores — correct by accident if the compare logic is the gate, wrong if the flag is the gate.
- **A clean exit is not a clean run.** Reporting "process exited with code 0" as a startup-command failure requires distinguishing a binary that was never found from an agent that legitimately exited. `code 0` with no output within the first-readiness window is the usable signal; `code 0` after output is a real session ending.
- **Two hosts, two spawn paths.** `PtyFleetService.create` (standalone, via `ptyHost.ts`) and the extension's instantiator (via `_ptyHostVerb('ptyCreateTerminal')` → `ptyHost.ts` → `PtyFleetService.create`) both resolve commands through the same `ptyHost.ts` code. Provenance is recorded in `PtyFleetService.create()`, which is shared by both hosts through the pty child process — so a single change covers both. The `getStartupCommands()` collapse is extension-only (the standalone host does not use `TaskViewerProvider`).
- **`injectStartupCommand` re-reads the global file.** At `ptyFleetService.ts:513`, if the passed `startupCommand` is falsy, `injectStartupCommand` re-reads the global file. The command actually injected can differ from the command used to derive `cliFamily` at `:437` if the file changed between the two reads (a narrow race). Provenance must be recorded for the ACTUAL injected command, not the first resolution — see Proposed Change #1.

## Edge-Case & Dependency Audit

**Race conditions:** `getAgentStartupCommands` reads the file per call with no cache, so a config edit landing between two seats of the same team genuinely produces two different commands. That is correct behaviour but indistinguishable from the bug without provenance — which is the argument for recording a timestamp alongside the source. The `injectStartupCommand` re-read (`:513`) introduces a second read window: the command used for `cliFamily` derivation and the command actually injected can differ if the file changes between `:431` and `:513`. Recording provenance after injection (not after the first resolution) closes this gap.

**Security:** The startup command is user-authored and already executed; recording it introduces no new capability. It must not be written to any surface that leaves the machine — it can contain flags like `--dangerously-skip-permissions`.

**Side effects:** Adding fields to the `ptyListTerminals` projection reaches every consumer of the fleet list, including the command surface's Teams view and the cockpit. Additive fields only. Collapsing `getStartupCommands()` to a single `getAgentStartupCommands()` call changes the return value for callers that previously got a `globalState`-sourced map when the file lacked the key — they will now get `undefined` (or `{}` after the custom-agent merge). Callers that depend on the `globalState` fallback for a command the file doesn't have will lose that command. This is the intended retirement, but every call site must be audited for the `undefined` case.

**Dependencies & conflicts:** None with the command-surface feature.

## Dependencies

None.

## Adversarial Synthesis

Key risks: (1) the plan originally missed a third stale store (`globalState` in `getStartupCommands()`) — mitigation: collapse `getStartupCommands()` to a single `getAgentStartupCommands()` call in the same pass; (2) the seed-flag gate was based on a false claim about when the flag is set — mitigation: gate the delete on the compare step (file has the role), not the flag; (3) the seed flag is per-IDE and unreadable from the standalone host — mitigation: the compare logic does not need the flag; (4) `injectStartupCommand` re-reads the file, so provenance recorded at the first resolution can be stale — mitigation: record provenance after the actual injection; (5) the Mission Control terminal spawn path bypasses the fleet entirely — mitigation: explicitly scoped out, flagged in Outstanding Questions; (6) reporting every `code 0` as a bad startup command — mitigation: only within the first-readiness window and only with no prior output.

## Proposed Changes

**1. Record what was resolved and where it came from (`ptyFleetService.ts:428-437`, `:509-524`).**

Make the resolution return `{ command, source }` where source is one of `argument` | `global-file` | `team-definition` | `none`. Store both on `ExtendedTerminalHandle` alongside the existing `cliFamily`. **Record provenance after `injectStartupCommand` resolves the actual command** (`:509-515`), not after the first resolution at `:428-437` — the `injectStartupCommand` re-read at `:513` can produce a different command if the file changed between reads. Log one line at spawn: seat name, role, resolved command, source. Both hosts share `ptyHost.ts` → `PtyFleetService.create()`, so a single change covers both.

**2. Surface it (`ptyHost.ts:164-184`).**

Add `startupCommand` and `startupCommandSource` to the `ptyListTerminals` projection. The Agent Setup panel gains a read-only line per live seat showing what it launched and from where, so a stale seat is visible without reading a log.

**3. Name a stale-command death for what it is.**

When a seat exits with code 0 inside the first-readiness window having produced no output, report the exit with the resolved command and its source rather than the bare "process exited with code 0".

**4. Collapse `getStartupCommands()` to a single read (`TaskViewerProvider.ts:8201-8243`).**

Strip the `globalState` fallback (`:8218-8225`) and the dead `state.json` fallback (`:8227-8243`). The function becomes a single `getAgentStartupCommands()` call + custom-agent merge. This retires the third stale store. Audit all 9 call sites (`:8247`, `:8414`, `:11735`, `:12054`, `:21092`, `:21116`, `:21142`, `:21184`) for the `undefined`/`{}` case — callers that previously got a `globalState`-sourced map will now get the file's value or nothing.

**5. Reconcile, then retire the DB row duplicate.**

Add a startup pass that compares `config['agents.startupCommands']` against the global file, per role:
- **File has the role → archive and delete.** The file is the source of truth. Archive the DB row as `agents.startupCommands.migrated.bak` and delete the live key.
- **File lacks the role, DB has it → leave both, log divergence.** The DB row may be the only source on a machine that never seeded. Log the seed flag as context if available (extension only); the standalone host logs "seed flag unreadable (standalone host)".
- **Both empty → no-op.**

The seed flag (`globalFileSeed.v2`) is logged as context, not used as a gate. The compare step is the gate.

## Verification Plan

### Automated Tests
- Unit test: `getStartupCommands()` returns only the global file value after the fallback collapse. Mock `getAgentStartupCommands()` to return `undefined` and assert the function returns `{}` (not a `globalState` value).
- Unit test: `PtyFleetService.create()` records `startupCommand` and `startupCommandSource` on the handle. Stub `getAgentStartupCommands()` and assert the handle fields.
- Unit test: reconcile pass — file has role, DB has different value → DB row archived as `.migrated.bak`, live key deleted, file unchanged.
- Unit test: reconcile pass — file lacks role, DB has value → both untouched, divergence logged.

### Goal Invariants
- `startupCommand` field exists on every `ExtendedTerminalHandle` in `src/standalone/ptyFleetService.ts:67-111`.
- `startupCommandSource` field exists on every `ExtendedTerminalHandle` in `src/standalone/ptyFleetService.ts:67-111`.
- `startupCommand` and `startupCommandSource` are present in the `ptyListTerminals` projection at `src/standalone/ptyHost.ts:164-184`.
- `getStartupCommands()` in `src/services/TaskViewerProvider.ts:8201` calls `GlobalIntegrationConfigService.getAgentStartupCommands()` exactly once and contains no `globalState.get` call for `switchboard.agents.startupCommands`.
- `getStartupCommands()` in `src/services/TaskViewerProvider.ts:8201` contains no `fs.promises.readFile` call (the dead `state.json` fallback is removed).
- Count of `globalState.get.*startupCommands` calls in `src/services/TaskViewerProvider.ts` equals 0 (excluding the seed migration at `:2855`, which reads it as a candidate source, not a fallback).

1. On this workspace, confirm the two stores currently differ for `coder`, `intern`, `lead`, `reviewer` and `analyst` — the pre-state.
2. Start the Coding team. Every spawned seat logs its resolved command and source, and `ptyListTerminals` reports both for each.
3. Confirm all three coder/intern seats resolve `source: global-file` and the Devin command. Any seat resolving otherwise now names which store it read.
4. Set a member-level `startupCommand` on the team definition. That seat reports `source: team-definition` and the others still report `global-file` — the precedence is unchanged and now visible.
5. Point a role at a binary that does not exist. The seat's exit is reported with the command and source, not as a bare code 0.
6. Let an agent run and exit normally after producing output. It is **not** reported as a startup-command failure.
7. Run the reconcile pass on this workspace: the DB row is archived as `.migrated.bak`, the live key is gone, and the global file is unchanged.
8. **Migration gate:** on a workspace with a populated DB row and `globalFileSeed.v2` unset, run the pass. Both stores are untouched and the divergence is logged. Then clear the global file, restart, and confirm the seed still reads the DB row and repopulates correctly.
9. Both hosts: run 2, 3 and 5 against the VS Code extension and the standalone host.
10. **`getStartupCommands()` collapse:** verify the Agent Setup panel and all 9 call sites still resolve commands correctly after the fallback strip. Confirm no `globalState`-sourced value leaks through.

## Outstanding Questions
- **[user]** The Mission Control terminal spawn path (`TaskViewerProvider.ts:12054`) creates a VS Code native terminal via `vscode.window.createTerminal` + `sendText`, completely outside the PTY fleet. It has no `ExtendedTerminalHandle` and no `ptyListTerminals` entry, so provenance recording in `PtyFleetService.create()` does not cover it. Should this plan also instrument the Mission Control path, or should it be a separate plan? — proceeding on the assumption that it is out of scope for this plan and flagged for a follow-up.
