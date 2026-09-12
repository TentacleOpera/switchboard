# Agents Are Saved Per Machine, and a Team Picks One

## Goal

A machine selector at the top of the Agents tab. Agents are saved **per machine**. The machine carries
its own `ssh`/`mosh` prefix, applied to every agent in that set. A team picks **one** machine — never
split across two.

That makes "a coding team on the Mac and a coding team on the tower" two team definitions that differ
by one dropdown, with each role's CLI entered once per machine and the transport entered once per
machine.

### Problem analysis

**Startup commands live in two places, and one is the wrong surface.**

| where | holds | should it |
|---|---|---|
| `agents.startupCommands` — `Record<string,string>`, per role | one CLI per role, globally | yes, but it has no machine |
| per-member `startupCommand` in a team definition (`a3ae9de3`) | free-text command per member row | **no** |

`a3ae9de3` added *"two inputs per member row: label (70px) and command (flex:1)"* to the TEAMS tab,
turning a selector into an editor. Because the field is free text it also became the only way to say
which machine a seat runs on, so one field now means two unrelated things: *this seat runs a different
CLI*, and *this seat runs elsewhere*.

**What that costs today.** To run a coding team on the tower you duplicate the definition and type
`ssh tower 'agy --dangerously-skip-permissions'` into every member row. Then the transport is retyped
per member per team; renaming the tower means editing every member of every definition; a member's
command no longer tells you which CLI it runs; and **the head is not covered at all** — `headRole`
resolves from `startupCommands[role]`, so the team still spawns its lead locally.

**One machine per team removes most of the design.** No per-agent host, no per-seat host, no head
special case: the team's machine covers every seat in it. The cases it forbids — a lead here and
coders there — are the cases that would need remote plan-path resolution to differ per seat anyway.

## Metadata

**Complexity:** 6
**Tags:** infrastructure, ui, ux, cli, feature
**Dependencies:** `mapping-state-stops-leaking-one-machine's-folders-into-every-other` — a remote seat
is handed its plan path from the board response, which is still absolute. Lands first.
`agent-control-becomes-its-own-panel` is where the Agents tab lives.

## User Review Required

None.

## Complexity Audit

### Routine
- Adding a machine selector dropdown to the Agents tab markup (`src/webview/kanban.html`, Agents tab section ~line 3284).
- Removing the per-member `.member-label` and `.member-cmd` inputs from the Teams tab (`teamsTabAgentGroupMemberRow` in `src/webview/kanban.html`).
- Adding a `machine` dropdown per team definition in the Teams tab.
- Default `local` machine always present, undeletable — a UI guard, not logic.
- Stripping `startupCommand: ''` from the default team definitions' members (`src/services/teamWiring.ts:789`, `src/webview/terminals.js:1749`).

### Complex / Risky
- **Config-shape migration**: `agents.startupCommands` (`Record<string,string>`, `GlobalIntegrationConfigService.ts:30`) moves from a flat global map to per-machine sets. Three resolution paths read it — `ptyFleetService.ts:561`, `goPtyFleetProjection.ts:309`, `agentGroupInstantiation.ts:126` — and all must thread the machine id or silently fall back to bare shells.
- **Transport-aware spawn**: the spawn is not a dumb `<prefix> <cli>` string concat. `ssh user@host '<cli>'` quote-wraps the CLI; `mosh user@host -- <cli>` uses `--`. A single concat produces a broken command for one of the two. The spawn path (`ptyFleetService.ts:322` `handle.sendText`, `goPtyFleetProjection.ts:322`) must build the command per transport.
- **Head threading**: `instantiateAgentGroupCore` (`agentGroupInstantiation.ts:139`) calls `createHeadWithDelegates` with `role: group?.headRole` and no machine today. The machine id must reach the head spawn, not just the delegates, or the head still spawns locally and the plan's own goal is unmet.
- **CLI identity is derived from the wrapper, not the CLI** — *carried over from the superseded
  per-seat SSH card (`6f0dbeb9-410f-4b43-a657-d346271b3c00`), which named it and is the one idea worth
  keeping from that file.* `deriveCliIdentity` (`src/services/cliIdentity.ts:34`) takes
  `cmd.split(/\s+/)[0]` as the binary, so the moment change 2 prefixes a transport, **every remote
  seat's identity is `ssh`/`mosh`**: `family: 'unknown'`, `displayName: 'SSH CLI'`. Verified against
  the tree, not assumed. Two consequences, and the first is worse than "a slower ceiling":
    - **Readiness detection is lost entirely, not merely lengthened.** The `unknown` branch in
      `clearReadiness.ts:228-238` has **no `onData` subscription at all** — it is a flat
      `setTimeout` of `DEVIN_DEFAULT_TIMEOUT_MS` (15000 ms, `:35`). A remote Claude seat that today
      detects readiness and proceeds in ~3 s (`CLAUDE_DEFAULT_TIMEOUT_MS`, `:37`) would instead wait
      a flat 15 s on **every** prompt with no signal detection, forever. Multiply by a team.
    - **It is sticky across the whole lifecycle**, so a spawn-time fix alone is not enough: the
      family is re-derived from the wrapped string again at `ptyFleetService.ts:691`
      (`deriveCliFamily(injected.command)`) and at `ptyPromptDelivery.ts:215`
      (`deriveCliFamily(handle.startupCommand)`).
  **What this plan must do:** derive identity from the **inner** CLI — the per-machine
  `machineStartupCommands[machineId][role]` value, which change 2 already has in hand *before* the
  transport prefix is applied — and record it alongside the wrapped command, rather than re-parsing
  the composed string at any of the three sites above. This is cheaper here than it was on the
  superseded card: that one had to recover the inner binary by parsing back past `--`, whereas the
  per-machine shape never has to lose it.

- **Migration dual-source window**: writing the new machine-scoped shape while the old flat key remains recreates the two-stores disease the plan exists to kill. Needs a read-fallback during transition, then a verified delete of the old key.

## Edge-Case & Dependency Audit

**Race Conditions**
- A machine's transport prefix edited while a team on that machine is mid-spawn: the in-flight seats use the prefix at spawn-resolution time; later seats use the new one. Acceptable — same as editing a startup command mid-spawn today. No new lock needed; document that prefix edits apply to the next spawn, not the current one.

**Security**
- The transport prefix is shell-interpolated into a spawn command. An operator-controlled string, but it is entered by the operator themselves (not external input), same trust level as `startupCommands` today. No new attack surface. Do NOT log the full rendered command with any secrets — the prefix is `ssh user@host`, no password field is introduced (key-based auth assumed; a password in the prefix would be visible in the process list, which is ssh's existing behavior, not new here).

**Side Effects**
- Migration writes the new config shape. The wipe guard (`GlobalIntegrationConfigService.ts:446`) refuses to blank `startupCommands` — a migration that writes the new shape and empties the old key is blocked by design. Migration must write-new, verify, then delete-old explicitly (bypassing the guard via a direct `saveGlobal` after confirming the new shape is populated), not via `setAgentConfig('startupCommands', {})`.
- Deleting the per-member `startupCommand` field from team definitions changes the `terminals.agentGroups` stored shape. The `teamsTabSaveAgentGroup` save path and `teamWiring.ts` member parsing must stop reading it; any persisted value is dropped on next save.

**Dependencies & Conflicts**
- `mapping-state-stops-leaking-one-machine's-folders-into-every-other` must land first: a remote seat receives its plan path from the board response, still absolute. Running a team on a tower whose repo lives at a different path than the host's requires that fix or the seat gets a path that does not exist on the remote machine.
- `agent-control-becomes-its-own-panel` (the Agents tab extraction) — the machine selector lives in the Agents tab, so the tab must exist as a stable surface. Closest existing plan: `extract-agent-control-into-its-own-panel-file.md`.
- `two-stores-hold-agent-startup-commands-and-they-disagree` — prior context; this plan supersedes the per-member store by deleting it, but must not reintroduce a second global store alongside the machine-scoped one.

## Dependencies

- `mapping-state-stops-leaking-one-machine's-folders-into-every-other` — remote seat plan-path is absolute; must be fixed before a tower team can find its work.
- `agent-control-becomes-its-own-panel` — the Agents tab is where the machine selector lives.

## Adversarial Synthesis

Key risks: (1) the machine id must thread through the *resolution path* (config read → spawn) not just the UI selector, or the selector is decorative and every team still spawns locally; (2) the spawn must be transport-aware (`ssh` quote-wraps the CLI, `mosh` uses `--`) — a dumb `<prefix> <cli>` concat breaks one transport; (3) the head seat must receive the machine id, not just delegates, or the goal's "every seat including each head" fails on the one seat that matters. Mitigations: thread machine id into `getAgentStartupCommands` and both spawn paths; build the rendered command per-transport in the spawn layer; migration writes the new shape with a read-fallback to the old flat map for one release, then deletes the old key.

## Proposed Changes

### 1. A machine selector at the top of the Agents tab

**Context:** Today the Agents tab (`src/webview/kanban.html`, Agents tab section ~line 3284) renders one global set of role→CLI inputs (`agents-tab-cmd-<role>` at lines 3287–3328). A machine selector switches which machine's set is shown and edited.

**Logic:**
- Add a `machines` config entity to `GlobalConfig.agents` (`src/services/GlobalIntegrationConfigService.ts:29–33`):
  ```ts
  agents?: {
      machines?: AgentMachine[];           // NEW — [{ id, name, transportPrefix }]
      startupCommands?: Record<string, string>;   // LEGACY flat map — migration source, then deleted
      machineStartupCommands?: Record<string, Record<string, string>>;  // NEW — machineId → role → CLI
      visibleAgents?: Record<string, boolean>;
      customAgents?: any[];
  };
  ```
  where `AgentMachine = { id: string; name: string; transportPrefix: string }`. `local` is `{ id: 'local', name: 'Local', transportPrefix: '' }`, always present, undeletable.
- Add config accessors: `getMachines()`, `setMachines()`, `getMachineStartupCommands(machineId)`, `setMachineStartupCommands(machineId, cmds)` alongside the existing `getAgentStartupCommands` (line 464).
- Agents tab markup: a machine dropdown + add/rename/delete buttons at the top of the tab. Selecting a machine swaps the `agents-tab-cmd-<role>` inputs to read/write that machine's set. `local` cannot be deleted (UI hides its delete button).

**Implementation:**
- `src/webview/kanban.html` — machine selector block above the Core group (~line 3284). The existing role inputs stay; their save handler reads the selected machine id and writes to `machineStartupCommands[machineId]` instead of the flat `startupCommands`.
- `src/services/GlobalIntegrationConfigService.ts` — new `AgentMachine` type, `machines`/`machineStartupCommands` fields, accessors. Keep `getAgentStartupCommands`/`setAgentStartupCommands` as legacy fallback during migration.

**Edge Cases:**
- A machine deleted while teams still pin it: refuse deletion if any team definition references the machine, with the team names listed. Do not orphan teams.
- Renaming a machine: the id is stable; only `name`/`transportPrefix` change. Teams pin by id, so a rename updates every team with no per-team edit (the plan's stated goal).

### 2. Agents are stored per machine

**Context:** `agents.startupCommands` (`Record<string,string>`, role→CLI) is a flat global map read by three spawn-resolution paths. It becomes machine-scoped: `machineStartupCommands[machineId][role]`. The existing global set migrates to the `local` machine unchanged.

**Logic:**
- Migration (one-time, on first read after upgrade): if `machineStartupCommands` is absent and the legacy `startupCommands` is present, copy `startupCommands` into `machineStartupCommands.local`, ensure `machines` contains `local`, and write. Do NOT delete the legacy key yet — keep it as a read-fallback for one release so a caller not yet threaded with the machine id still resolves.
- `getAgentStartupCommands(machineId?)` (`GlobalIntegrationConfigService.ts:464`): when `machineId` given, return `machineStartupCommands[machineId]`; when absent, fall back to legacy `startupCommands` (transition window).
- Spawn path — `src/standalone/ptyFleetService.ts:561`: `const commands = await GlobalIntegrationConfigService.getAgentStartupCommands(machineId) || {}`. The `machineId` is passed from `createHeadWithDelegates` / `spawnDelegates`, which receive it from `instantiateAgentGroupCore` (which reads `group?.machine`).
- Spawn path — `src/services/goPtyFleetProjection.ts:309`: same threading; `effectiveStartupCommand` resolves per machine.
- `src/services/agentGroupInstantiation.ts:126`: `const startupCommands = (await GlobalIntegrationConfigService.getAgentStartupCommands(group?.machine)) || {}`.

**Implementation:**
- The rendered spawn command is built per transport in the spawn layer (`ptyFleetService.ts` / `goPtyFleetProjection.ts`), NOT as a dumb concat:
  - `local` (empty prefix): `effectiveStartupCommand` as-is (unchanged from today).
  - `ssh`: `ssh <prefix-host> '<cli>'` — the CLI is single-quote-wrapped as one remote argument.
  - `mosh`: `mosh <prefix-host> -- <cli>` — `--` separates mosh args from the remote command.
  - The `transportPrefix` stores `user@host` (e.g. `tower` is a host alias, or `patrick@tower`). The transport *kind* (`ssh`/`mosh`) is a separate field on the machine, or derived from the prefix's leading token. **Clarification:** the machine entity carries an explicit `transport: 'local' | 'ssh' | 'mosh'` field, not just a prefix string, so the spawn layer knows which wrapping to apply.

**Edge Cases:**
- A role with no command on a given machine: same as today — seat spawns as a bare shell, `commandlessRoles` advisory reports it (`agentGroupInstantiation.ts:137`).
- CLI containing single quotes (ssh wrapping): escape inner quotes (`'\''`) in the ssh path. Rare but must not break the spawn.

### 3. The Teams tab picks a machine, and stops accepting commands

**Context:** The Teams tab (`src/webview/kanban.html`, `teamsTabAgentGroupMemberRow` and `teamsTabSaveAgentGroup` functions) currently renders per-member `.member-label` and `.member-cmd` inputs (added by `a3ae9de3`). These are removed; one machine dropdown per team replaces them.

**Logic:**
- Remove `.member-label` and `.member-cmd` input creation from `teamsTabAgentGroupMemberRow`. Remove the `querySelector('.member-cmd')` / `querySelector('.member-label')` reads from `teamsTabSaveAgentGroup`. Remove the `delete member.label` / `delete member.startupCommand` cleanup (the fields no longer exist).
- Add a machine `<select>` per team definition, populated from `getMachines()`, defaulting to `local`. The team definition gains a `machine: string` field (machine id).
- `teamsTabSaveAgentGroup` writes `group.machine = <selected machine id>` and no longer reads per-member commands.
- `src/services/teamWiring.ts:783` `DEFAULT_TEAM_DEFINITIONS`: drop `startupCommand: ''` from each member; add `machine: 'local'` to each definition.
- `src/webview/terminals.js:1743` `DEFAULT_TEAM_DEFINITIONS` (webview mirror): same change.
- `wireSpawnedTeam` / `instantiateAgentGroupCore` read `group?.machine` and thread it to `createHeadWithDelegates` and the delegate spawn (see Change 2).

**Implementation:**
- The existing contract test `src/test/teams-tab-member-editor-contract.test.js` asserts the `.member-label`/`.member-cmd` inputs exist. This test must be updated (or replaced with a test asserting their *absence* and the machine dropdown's *presence*) as part of this change — it is a regression guard for the very field being deleted.

**Edge Cases:**
- **No migration needed for per-member `startupCommand`.** Checked on 2026-09-10: **zero** members carry a `startupCommand`, in either `terminals.agentGroups` or the live `terminals.groups`. `a3ae9de3` shipped the inputs on 2026-09-09 at 18:22 and nobody has typed into them. Delete the field. If a value appears before this lands, refuse the save with a message telling the operator to re-enter it as a machine (do not attempt to parse free-text `ssh host 'cli'` into prefix + CLI — the field is being deleted, not migrated).

### 4. Refuse a split team rather than half-support it

**Context:** A team is one machine. If a definition somehow carries seats implying two, fail at save.

**Logic:**
- With per-member commands removed and a single `machine` field per team, a "split team" is structurally impossible — there is no per-seat host to disagree. The check reduces to: `group.machine` is set and resolves to a known machine id. `teamsTabSaveAgentGroup` validates `machine` is non-empty and exists in `getMachines()` at save, not at dispatch.

**Edge Cases:**
- A machine deleted after a team pinned it: blocked by Change 1's deletion guard (refuse deletion while referenced). If it slips through (direct config edit), the team fails at dispatch with "machine not found," not at save — acceptable, same as a deleted custom agent role today.

### 5. Check the machine when it is registered

**Context:** Verify the transport reaches the machine at registration and when a team selects it — not at dispatch, when a card is already moving.

**Logic:**
- On machine add/edit, run a non-blocking reachability probe:
  - `ssh`: `ssh -o BatchMode=yes -o ConnectTimeout=5 <user@host> true`
  - `mosh`: `mosh --server=/bin/true <user@host> -- true` (or equivalent lightweight probe; mosh has no clean "test" mode, so a short timeout + BatchMode ssh underneath is the pragmatic check).
- The probe is a **warning, not a hard refusal**: an operator registering a machine that is currently asleep should be able to save the definition. Surface "could not reach <machine>: <reason>" as a non-blocking notice.
- Do NOT run the probe at dispatch time — a dead machine at dispatch is a runtime failure the operator handles, not a config gate.

**Edge Cases:**
- Probe hangs despite `ConnectTimeout`: wrap in a 10s overall timeout; a hung probe is a warning, never blocks the save.

## Verification Plan

### Automated Tests
- A team on `local` spawns exactly what it does today, byte-identical (the `local` machine has empty transport; rendered command equals the CLI).
- Two coding teams differing only by machine run at once; every seat including each head runs on its team's machine (assert the head's spawn received the team's `machine` id, not the default).
- The Teams tab contains no free-text command input (assert `.member-cmd` / `.member-label` absent from `teamsTabAgentGroupMemberRow` output; assert machine `<select>` present).
- Changing a machine's transport prefix updates every team on that machine, with no per-seat edits (teams pin by machine id; rename prefix, re-resolve, assert all teams see new prefix).
- The `startupCommands` global set is readable as the `local` machine's set after migration, with the same values it has today (migration copies flat → `machineStartupCommands.local`).
- `ssh` transport renders `ssh host 'cli'` (CLI quote-wrapped); `mosh` transport renders `mosh host -- cli` (assert the spawn string shape per transport, not a concat).
- `src/test/teams-tab-member-editor-contract.test.js` updated to assert member-command inputs are gone and the machine selector exists.
- A seat on a machine with a non-empty transport keeps its CLI's identity: assert `cliFamily` is `claude`/`devin`/`antigravity` (never `unknown`) and `displayName` is the CLI's brand (never `SSH CLI`/`MOSH CLI`), for a seat whose inner command is that CLI. Assert it at all three derivation sites, not just at spawn — `ptyFleetService.ts:569`, `:691`, and `ptyPromptDelivery.ts:215` each re-derive from a command string.

### Goal Invariants
- `GlobalConfig.agents.machines` array contains an entry with `id: 'local'` and `transportPrefix: ''` after migration (the default machine is always present).
- `getMachineStartupCommands('local')` returns a map equal to the pre-migration `agents.startupCommands` (migration is lossless for the local set).
- `teamsTabAgentGroupMemberRow` output in `src/webview/kanban.html` contains no element with className `member-cmd` (the per-member command input is deleted).
- Each entry in `DEFAULT_TEAM_DEFINITIONS` (`src/services/teamWiring.ts:783`) has a `machine` field equal to `'local'` (teams carry a machine pin, not per-member commands).
- `instantiateAgentGroupCore` (`src/services/agentGroupInstantiation.ts`) passes `group?.machine` into `createHeadWithDelegates` (the head spawn receives the machine id, not just delegates).
- No identity derivation is fed a transport-wrapped string: assert every `deriveCliFamily` / `deriveCliIdentity` call site receives the inner per-machine CLI value, not the composed spawn command (negative pairing: a remote seat's readiness path must not take the `unknown` branch at `clearReadiness.ts:228`, which has no `onData` subscription and would flat-wait 15 s on every prompt).

## Outstanding Questions

- **[user]** Does a machine need a working-directory field? A tower clone may sit at a different path, and that is the assumption the absolute-path leak currently hides. If it does, it belongs next to the transport — one more field on the machine, not on the agent. — proceeding on the assumption that it does NOT in this plan, and is handled by the `mapping-state-stops-leaking` dependency; add later if the dependency proves insufficient.
