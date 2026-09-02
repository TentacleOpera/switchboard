# Two stores hold agent startup commands, they currently disagree, and a spawned seat records no evidence of which one it read

## Goal

Make the startup command a seat launched with an auditable fact, and collapse the two stores that can answer "what does a coder run?" down to one. Today a seat can spawn on a stale command with nothing in the fleet record, the log, or the UI naming where that command came from.

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

`spawnDelegates` passes `d.startupCommand` from the team definition (`:717`, `:753`). The persisted Coding team carries **no** `startupCommand` on either member — `{"role":"coder","count":2,"scope":"per-team","relationship":"reports-to-head"}` — so both coders take the config branch and should resolve identically. `getAgentStartupCommands` reads the file fresh on every call (`loadGlobalSync`, no cache), so a stale read is not explained by caching either. The extension's own instantiator reads the same global file (`agentGroupInstantiation.ts:121`).

### Root Cause

**The legacy per-workspace copy was never retired, and nothing records which store a seat actually read.**

`stateConfigBridge.ts:14` puts `startupCommands` in `AGENT_GLOBAL_FILE_KEYS` — machine-global, redirected to `~/.switchboard`. Yet `STATE_KEY_TO_CONFIG` at `:30` *also* maps it to `agents.startupCommands`, and `_migrateStartupCommandsToGlobalFile` (`TaskViewerProvider.ts:2812`) seeds the file from the DB once and **never deletes the DB row**. The stale copy is left on disk by design, guarded only by the assumption that nothing reads it any more.

That assumption is unverifiable from the outside, because **`effectiveStartupCommand` is resolved and then discarded.** It is used to derive `cliFamily` (`:437`) and to launch, but the command string and its provenance are never stored on the handle, never logged at spawn, and never surfaced in `ptyListTerminals`. So when a seat launches the wrong binary there is no artifact anywhere that says which branch produced it — the explicit argument, the global file, or a legacy store. This plan does not guess which; it makes the question answerable and removes the duplicate that makes it ambiguous.

**Why "process exited with code 0" is the visible symptom rather than a clear error:** the shell runs `agy`, the binary is absent or exits immediately, and the PTY reports a clean exit. Nothing distinguishes "your startup command is stale" from "your agent finished".

### Non-goals

- **Do not change which store wins.** The global file is already the documented source of truth and every reader in `src/` prefers it. This plan records provenance and retires the duplicate; it does not re-rank the precedence.
- **Do not delete the legacy DB row without a migration.** It ships in released versions and is the seed source for any install that has not yet run `globalFileSeed.v2`.
- Not fixing the readiness/timing consequence — that is `a-seats-cli-family-is-frozen-at-spawn.md`, which depends on this one.

## Metadata

**Topic:** Startup command provenance is recorded and the duplicate store is retired
**Complexity:** 5
**Tags:** agents, terminals, config, reliability, bug

## User Review Required

None. The precedence order is unchanged; this adds evidence and removes a duplicate.

## Complexity Audit

### Routine
- Storing `effectiveStartupCommand` and its source on `ExtendedTerminalHandle`.
- Adding both to the `ptyListTerminals` projection and to the spawn log line.

### Complex / Risky
- **Retiring the DB row is a migration against ~4,000 installs.** Per `CLAUDE.md`, state that shipped must be migrated, not unlinked. An install that has never run the `globalFileSeed.v2` pass still depends on that row as its only source. The row may only be removed *after* the seed has demonstrably run and the global file is non-empty — and the seed's own guard `(b)` ("never overwrite an existing non-empty global value") means a machine whose file was populated by hand never ran the seed at all. Deleting on "file is non-empty" alone would discard the only copy of a config the seed never read.
- **A clean exit is not a clean run.** Reporting "process exited with code 0" as a startup-command failure requires distinguishing a binary that was never found from an agent that legitimately exited. `code 0` with no output within the first-readiness window is the usable signal; `code 0` after output is a real session ending.
- **Two hosts, two spawn paths.** `PtyFleetService.create` (standalone) and the extension's instantiator both resolve commands. Provenance must be recorded in both, or the audit is green on one host and blind on the other — the exact composition-root divergence `CLAUDE.md` names.

## Edge-Case & Dependency Audit

**Race conditions:** `getAgentStartupCommands` reads the file per call with no cache, so a config edit landing between two seats of the same team genuinely produces two different commands. That is correct behaviour but indistinguishable from the bug without provenance — which is the argument for recording a timestamp alongside the source.

**Security:** The startup command is user-authored and already executed; recording it introduces no new capability. It must not be written to any surface that leaves the machine — it can contain flags like `--dangerously-skip-permissions`.

**Side effects:** Adding fields to the `ptyListTerminals` projection reaches every consumer of the fleet list, including the command surface's Teams view and the cockpit. Additive fields only.

**Dependencies & conflicts:** None with the command-surface feature.

## Dependencies

None.

## Adversarial Synthesis

Key risks: (1) inventing a mechanism for the coder-1/coder-2 split and "fixing" a path that was never taken — the split is *not* explained by anything in `src/` today, and this plan is explicitly built to make the next occurrence self-diagnosing rather than to guess; (2) deleting the legacy DB row on a machine whose seed never ran, destroying the only copy — mitigation: gate the delete on the seed flag, not on the file being non-empty; (3) recording provenance on one host only — mitigation: verification exercises both spawn paths; (4) reporting every `code 0` as a bad startup command, which would cry wolf on every agent that finishes normally — mitigation: only within the first-readiness window and only with no prior output.

## Proposed Changes

**1. Record what was resolved and where it came from (`ptyFleetService.ts:428-437`).**

Make the resolution return `{ command, source }` where source is one of `argument` | `global-file` | `team-definition` | `none`. Store both on `ExtendedTerminalHandle` alongside the existing `cliFamily`, and log one line at spawn: seat name, role, resolved command, source. Mirror the same in the extension's instantiator.

**2. Surface it (`ptyListTerminals`).**

Add `startupCommand` and `startupCommandSource` to the projection. The Agent Setup panel gains a read-only line per live seat showing what it launched and from where, so a stale seat is visible without reading a log.

**3. Name a stale-command death for what it is.**

When a seat exits with code 0 inside the first-readiness window having produced no output, report the exit with the resolved command and its source rather than the bare "process exited with code 0".

**4. Reconcile, then retire the duplicate.**

Add a startup pass that compares `config['agents.startupCommands']` against the global file. When they differ and `globalFileSeed.v2` is set, archive the DB row as `agents.startupCommands.migrated.bak` and delete the live key — leaving the file the single answer. When the seed flag is absent, leave both untouched and log the divergence: that machine has never seeded and the row is still load-bearing.

## Verification Plan

1. On this workspace, confirm the two stores currently differ for `coder`, `intern`, `lead`, `reviewer` and `analyst` — the pre-state.
2. Start the Coding team. Every spawned seat logs its resolved command and source, and `ptyListTerminals` reports both for each.
3. Confirm all three coder/intern seats resolve `source: global-file` and the Devin command. Any seat resolving otherwise now names which store it read.
4. Set a member-level `startupCommand` on the team definition. That seat reports `source: team-definition` and the others still report `global-file` — the precedence is unchanged and now visible.
5. Point a role at a binary that does not exist. The seat's exit is reported with the command and source, not as a bare code 0.
6. Let an agent run and exit normally after producing output. It is **not** reported as a startup-command failure.
7. Run the reconcile pass on this workspace: the DB row is archived as `.migrated.bak`, the live key is gone, and the global file is unchanged.
8. **Migration gate:** on a workspace with a populated DB row and `globalFileSeed.v2` unset, run the pass. Both stores are untouched and the divergence is logged. Then clear the global file, restart, and confirm the seed still reads the DB row and repopulates correctly.
9. Both hosts: run 2, 3 and 5 against the VS Code extension and the standalone host.
