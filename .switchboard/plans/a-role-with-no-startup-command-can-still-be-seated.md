# A role with no startup command can still be seated

## Goal

Seating a role that has no agent CLI configured must fail, and say which role.
The one deliberate exception stays: `shell` (`NO_ROLE`), the blank terminal.

## Problem

`injectStartupCommand` (`src/standalone/ptyFleetService.ts`) resolves the role's
command, and when there isn't one it returns `{ command: undefined, source:
'none' }` and injects nothing. The seat is created anyway. What the operator
gets is a bare shell wearing an agent seat's name, role badge and pane — it
accepts prompts, holds a tmux session, appears in the fleet, takes dispatches,
and answers none of them.

Two roles are in that state today:

```
tester: ""          ticket_updater: ""
```

Every other role names a CLI. `tester` is column-only by design, so it should
not be seatable at all; `ticket_updater` is in the same position.

The system already knows. `KanbanProvider._getAgentNames` returns the literal
`'No agent assigned'` for these roles, and `agentLabelForRole`
(`src/webview/terminals.js:9177`) folds that to an empty label so the sidebar
renders them as blank — the same blank as the deliberately CLI-less `shell`
role. The one case that is legitimate and the case that is a mistake are
displayed identically, which is the whole defect: a seat that launched no agent
must not be indistinguishable from one that did.

It is silent in the other direction too. `bootstrap.ts`'s `ptyWrite` arm notes
that a failed startup-command top-up leaves "the terminal exists and accepts
the prompt, but no agent was ever launched in it" — the same end state, reached
by a different route, and equally unreported.

### Root cause: spawn precedes command resolution

The deeper structural cause is that `PtyFleetService.create()` spawns the PTY
process (`backend.create()`, `:534`) BEFORE it resolves the startup command
(first resolution, `:555`–`:568`). The `created` event fires (`:677`) and the
handle enters the fleet map (`:614`) before `injectStartupCommand` even runs
(`:685`). So by the time `source: 'none'` is detectable, the seat is already
live, named, and announced to every WS client. The batch path
(`createBatch`, `:1069`–`:1074`) already does this correctly — it resolves
commands and refuses BEFORE the spawn loop. The single-seat path inverts the
order, which is why the no-command seat escapes.

## Architecture decision

**Refuse at creation, not at dispatch.** `PtyFleetService.create` fails when the
resolved role has no startup command and the role is not `shell`. Failing later
— at the first prompt — means the seat has already taken a card, a tmux
session, a pane and a name.

**`shell` / `NO_ROLE` is the only CLI-less seat and needs no command.** It is
the blank terminal and it is chosen deliberately. It is exempt by name, not by
an empty-string test, so "this role is deliberately CLI-less" and "this role's
command is missing" cannot be confused.

**The error names the role and the store that answered.** The first resolution
tracks provenance (`source: 'argument' | 'team-definition' | 'global-file' | 'none'`);
the refusal carries it, so "which store answered, and what did it say?" stays
answerable. For the `'none'` case the answer is "the global file had no command
for this role" — the source names the store that was consulted.

**No new setting and no UI to configure this.** A role either names a CLI in
the Agents tab or it cannot be seated. `tester` and `ticket_updater` keep
working exactly as they do now — as board columns — which is what they are for.

> **Superseded:** `injectStartupCommand` returning `source: 'none'` for a non-`shell` role becomes a creation failure, not a silent no-op. `create()` surfaces it.
> **Reason:** `injectStartupCommand` is called at `:685`, AFTER the PTY is spawned (`:534`), the handle enters the fleet map (`:614`), and the `created` event fires (`:677`). Hooking the refusal there means the seat is already live, named, and announced to every WS client before the failure — a transient seat that a race-aware consumer (fleet list poll, WS gateway) can observe. The refusal must hook into the FIRST command resolution (`:555`–`:568`) and that resolution must move BEFORE `backend.create()` spawns the process, matching the pattern `createBatch` already uses (`:1069`–`:1074`).
> **Replaced with:** Move the first command resolution above `backend.create()` (`:534`). When `effectiveStartupSource === 'none'` and `role !== 'shell'`, throw an Error naming the role and source before any PTY is spawned. `create()` throws (it already returns `Promise<ExtendedTerminalHandle>` with no `{ success }` shape); callers (`spawnDelegates` `:962`, `createBatch` `:1086`, both verb arms) already catch throws.

## Metadata

**Tags:** [backend, frontend, bugfix, reliability]
**Feature:** 44798142-bd27-4408-9f95-9873c781dcef
**Complexity:** 5

## User Review Required

- **Policy shift in the role picker (change 3).** Today the picker ANNOTATES no-CLI roles with "(plain shell)" and "no agent CLI configured" but still lets the operator spawn them. This plan changes that to EXCLUDE — a no-CLI role is no longer offered as a spawn target. `tester` and `ticket_updater` become unseatable from the UI. Confirm this is intended: the operator loses the ability to spawn a plain-shell seat under a no-CLI role's name. (The `shell` / NO_ROLE button is separate and stays.)

## Complexity Audit

### Routine
- Filtering the role picker and fill-grid on the existing `hasCommand` map (change 3) — the map already ships from `getPtyVisibleRoles`; the picker already reads it for annotation. One filter change from annotate to exclude.
- `createBatch` already refuses no-command roles (`:1069`–`:1074`) — no change needed there.
- `agentLabelForRole` already returns `''` for both `shell` and 'No agent assigned' — change 4 adds a broken-case distinction, not a new return path.

### Complex / Risky
- Reordering `create()` so command resolution precedes `backend.create()` — the spawn, env construction, and command resolution are interleaved with load-bearing spread order and timing comments. Moving the resolution up must not break the `claudeInlineRendering` resolver chain or the `switchboardEnv` construction, both of which sit between the current spawn and resolution sites.
- `create()` throwing on refusal changes the contract for every caller. `spawnDelegates` catches (`:962`) and returns an error string — a team member whose role has no command will be refused, which is correct but must not kill the head. The dispatch auto-create and memo→planner auto-create paths call `create()` with no try/catch of their own; the verb arms catch, but any non-verb caller that doesn't catch will crash.
- The extension's `createFleetTerminalAndDeliver` top-up branch (`:22518`–`:22527`) delivers a prompt to a bare shell when no command resolves. After the `create()` refusal, `ptyCreateTerminal` returns `success: false` and the top-up is unreachable for no-command roles — but a future path that bypasses `ptyCreateTerminal` could reach it, so the guard is defense-in-depth.

## Edge-Case & Dependency Audit

**Race Conditions:**
- The singleton guard (`:437`–`:475`) runs BEFORE the command resolution. A singleton role (controller) with no command would pass the singleton check, then hit the refusal. The refusal must throw AFTER the singleton guard so a dead singleton is still reclaimed (`:468`) before the refusal — otherwise a dead controller with no command locks the role permanently. Since the refusal is before the spawn (after the singleton guard), the dead-handle reclaim at `:468` runs first. Correct.
- The `created` event (`:677`) currently fires before `injectStartupCommand`. After the reorder, the refusal throws before the spawn, so no `created` event fires for a refused seat. No transient seat reaches the WS gateway.

**Security:**
- The refusal is role-name-based (`role !== 'shell'`). A caller passing `role: 'shell'` with a startup command argument bypasses the refusal — but that is the deliberate CLI-less seat, and an explicit `startupCommand` argument would make it a real seat. No escalation.

**Side Effects:**
- `spawnDelegates` team members: a member whose `d.startupCommand` is set uses `source: 'team-definition'` and is not refused. A member with no `d.startupCommand` falls back to the role's global command; if that is also missing, the member is refused. `spawnDelegates` catches (`:962`) and returns `{ error }` — the head and already-spawned siblings stay alive. Correct.
- `createBatch` (`:1069`–`:1074`) already refuses no-command roles before the spawn loop. After the `create()` refusal, `createBatch`'s own check becomes redundant for the single-seat path but stays as a batch-level fast-fail (it rejects the whole allocation before spawning anything, rather than failing mid-batch). No conflict.

**Dependencies & Conflicts:**
- `getPtyVisibleRoles` (`GlobalIntegrationConfigService.ts:381`) already returns `hasCommand`. Change 3 consumes it; no new endpoint.
- `agentLabelForRole` (`terminals.js:9177`) does not currently receive `hasCommand`. Change 4 must either thread `hasCommand` into the label function or check it at the render sites that call `agentLabelForRole` (`:1603`, `:2939`, `:3041`, `:3459`, `:7053`, `:7787`).

## Dependencies

None — this plan is self-contained.

## Adversarial Synthesis

Key risks: (1) the `create()` reorder must preserve the load-bearing env spread order and `claudeInlineRendering` resolver chain that sit between the current spawn and resolution sites; (2) `create()` throwing on refusal changes the contract for non-verb callers (dispatch auto-create, memo→planner) that may not catch — the verb arms catch, but a bare `create()` call with no try/catch will crash; (3) `agentLabelForRole` cannot distinguish broken-from-blank with its current inputs and change 4 underspecifies where the `hasCommand` check lives. Mitigations: move only the command resolution block (not the env construction), audit every `create()` caller for a catch, and thread `hasCommand` into the label path explicitly.

## Proposed Changes

### `src/standalone/ptyFleetService.ts` — `create()` refusal before spawn

- **Context.** `create()` (`:408`) currently spawns the PTY at `:534`, resolves the command at `:555`–`:568`, and calls `injectStartupCommand` at `:685`. The refusal must fire before the spawn.
- **Logic.** Move the first command-resolution block (`:555`–`:568`) above `backend.create()` (`:534`). After resolution, if `effectiveStartupSource === 'none'` and `role !== 'shell'`, throw `new Error(\`Role '${role}' has no startup command (source: ${effectiveStartupSource}). Configure it in the Agents tab or use the shell terminal.\`)`. The `shell` exemption is by name (`role !== 'shell'`), not by empty-string test.
- **Implementation.** The block to move is:
  ```ts
  let effectiveStartupCommand = startupCommand;
  let effectiveStartupSource: string;
  if (effectiveStartupCommand) {
      effectiveStartupSource = opts?._isTeamMember ? 'team-definition' : 'argument';
  } else {
      try {
          const commands = await GlobalIntegrationConfigService.getAgentStartupCommands() || {};
          effectiveStartupCommand = commands[role];
          effectiveStartupSource = effectiveStartupCommand ? 'global-file' : 'none';
      } catch {
          effectiveStartupCommand = undefined;
          effectiveStartupSource = 'none';
      }
  }
  ```
  Insert the refusal immediately after this block, before `const rawHandle = this.backend.create(...)`. The `claudeInlineRendering` resolver (`:526`–`:527`) and `switchboardEnv` construction (`:496`–`:500`) stay where they are (between the spawn and the current resolution site) — they do not depend on the command. The `cliFamily` derivation (`:569`) moves with the resolution block since it depends on `effectiveStartupCommand`.
- **Edge Cases.** The singleton guard (`:437`–`:475`) runs before the moved resolution — a dead singleton is reclaimed before the refusal, so a dead controller with no command does not lock the role. `injectStartupCommand` (`:726`) still re-reads the global file when the first resolution was falsy; after the reorder, the first resolution is authoritative for the refusal, and `injectStartupCommand`'s re-read only runs for seats that passed the gate (i.e., had a command at first resolution). A command that disappears between the first resolution and injection is a stale-command-death case, already handled by the `onExit` detector — not a refusal case.

### `src/services/TaskViewerProvider.ts` — extension creation path and top-up guard

- **Context.** The extension's `ptyCreateTerminal` arm (`:4310`–`:4356`) forwards to `this._ptyHostVerb(verb, payload)` (`:4444`), which reaches `PtyFleetService.create()` in the pty host child. After the `create()` refusal, `createRes.success === false` (`:22490`–`:22492`) returns false before the top-up. The top-up branch (`:22518`–`:22527`) is defense-in-depth.
- **Logic.** In `createFleetTerminalAndDeliver` (`:22441`), after the `ptyCreateTerminal` call returns `success: false`, the existing `return false` (`:22491`) handles the refusal. Add a guard in the top-up branch (`:22518`): if `!fleetWouldSend && !expected`, do NOT deliver the prompt to a bare shell — return false with a warning that names the role. This catches a future path that bypasses `ptyCreateTerminal` and reaches the top-up directly.
- **Implementation.** The top-up branch currently:
  ```ts
  } else if (expected) {
      // Top-up: ...
      await new Promise(r => setTimeout(r, 750));
      const writeRes = await this._ptyHostVerb('ptyWrite', { name: createdName, data: expected + '\r' });
      if (writeRes?.success !== false) { startupCommandSent = true; }
  }
  ```
  Add an `else` clause for the no-command case:
  ```ts
  } else {
      // No command from the fleet AND no expected command: the role has no
      // agent CLI. Refuse rather than deliver a prompt to a bare shell.
      this._seams().ui.showWarningMessage(
          `Role '${role}' has no agent CLI configured. Configure it in the Agents tab or use the shell terminal.`
      );
      return false;
  }
  ```
- **Edge Cases.** The `ptyCreateTerminal` refusal propagates as `{ success: false, error: ... }` from the pty host child. The extension arm returns `createRes` directly (`:4444`), so `createFleetTerminalAndDeliver` sees `success: false` at `:22490`. No change to the verb arm itself — the refusal is in `create()`.

### `src/webview/terminals.js` — exclude no-CLI roles from the picker

- **Context.** The role picker (`:9301`–`:9356`) and the fill-grid (`:1050`–`:1074`) already read `hasCommand` from `fetchPtyVisibleRoles` (`:9184`). They currently ANNOTATE no-CLI roles with "(plain shell)" / "no agent CLI configured" but still offer them.
- **Logic.** Change the filter from annotate to exclude. In the picker (`:9308`–`:9309`), add `&& hasCommand[k] !== false` to the role filter so no-CLI roles are excluded. In the fill-grid (`:1055`–`:1056`), same filter. The `shell` / NO_ROLE button (`:9371`) is separate and stays — it creates a terminal with `role: NO_ROLE` directly, not via the role list.
- **Implementation.** Picker filter (currently `:9308`–`:9309`):
  ```js
  const roles = Object.keys(visible)
      .filter(k => visible[k] !== false && !SYSTEM_ROLES.has(k))
  ```
  Becomes:
  ```js
  const roles = Object.keys(visible)
      .filter(k => visible[k] !== false && !SYSTEM_ROLES.has(k) && hasCommand[k] !== false)
  ```
  Same change in the fill-grid (`:1055`–`:1056`). Remove the `(plain shell)` / `no agent CLI configured` annotation strings (`:1072`, `:9329`–`:9331`) since excluded roles no longer appear.
- **Edge Cases.** A role whose `hasCommand` entry is missing (key absent from the map) should be treated as no-command (`hasCommand[k] !== false` excludes only explicit `false`; use `hasCommand[k] === true` to INCLUDE only confirmed-command roles — safer, since a missing key means `getPtyVisibleRoles` could not confirm a command). Prefer `hasCommand[k] === true` over `hasCommand[k] !== false`.

### `src/webview/terminals.js` — distinguish broken from blank in the sidebar

- **Context.** `agentLabelForRole` (`:9177`) returns `''` for both `shell` (NO_ROLE) and for roles with 'No agent assigned'. After change 1, no no-command seat should exist, but a pre-fix seat or a missed path could leave one.
- **Logic.** `agentLabelForRole` cannot distinguish broken from blank with its current inputs (role + `agentNames` map). Thread `hasCommand` into the distinction: a role that is not `shell`, has 'No agent assigned' in `agentNames`, AND `hasCommand[role] === false` is the broken case. Return a sentinel label (e.g. `'(no CLI)'`) for the broken case so render sites show it as broken, not blank.
- **Implementation.** `agentLabelForRole` currently:
  ```js
  function agentLabelForRole(role) {
      if (!role || role === NO_ROLE) { return ''; }
      const label = agentNames[role];
      if (!label || label === 'No agent assigned') { return ''; }
      return label;
  }
  ```
  The `hasCommand` map is fetched by `fetchPtyVisibleRoles` and cached in `rolePickerData` (`:219`). Thread the cached `hasCommand` into `agentLabelForRole` as a second argument, or make it read a module-level cached `hasCommand` that `fetchPtyVisibleRoles` updates. Then:
  ```js
  function agentLabelForRole(role) {
      if (!role || role === NO_ROLE) { return ''; }
      const label = agentNames[role];
      if (!label || label === 'No agent assigned') {
          // After the create() refusal this should not exist. If it does
          // (pre-fix seat, missed path), read as broken — not as the blank
          // terminal shell deliberately is.
          return (hasCommandCache && hasCommandCache[role] === false) ? '(no CLI)' : '';
      }
      return label;
  }
  ```
  Audit the six call sites (`:1603`, `:2939`, `:3041`, `:3459`, `:7053`, `:7787`) — `brandIconForCliLabel('(no CLI)')` returns `null` (not a known brand), so the default icon fallback (`:1604`–`:1605`) already handles it. No render-site change needed beyond the label itself.
- **Edge Cases.** `hasCommandCache` may be empty on first render (before `fetchPtyVisibleRoles` resolves). An empty cache means "unknown," not "no command" — return `''` (blank) in that case, matching today's behaviour, so a slow fetch does not flash every role as broken. The `hasCommandCache[role] === false` check is strict: only an explicit `false` triggers the broken label.

## Verification Plan

### Automated Tests

- A contract test seats each configured role and asserts every non-`shell` one either launches its CLI or is refused by name — no seat reaches `active` with `startupCommandSource: 'none'`.
- A test asserts `shell` still seats with no command and no refusal.
- A test asserts the refusal message names the role and the source, since that string is the only signal an operator gets.
- A test asserts `createBatch`'s existing gate (`:1069`–`:1074`) still refuses no-command roles (regression guard — the `create()` refusal must not bypass it).
- A test asserts `spawnDelegates` returns `{ error }` (not throws) when a team member's role has no command, so the head and already-spawned siblings stay alive.
- Both roots: `npm run test:contract:standalone-fleet-seam` plus the extension creation path, because the `createFleetTerminalAndDeliver` top-up branch is where the silent-success path lives.
- A test asserts the role picker and fill-grid exclude roles where `hasCommand[role] !== true`, and that `shell` / NO_ROLE stays offered via its separate button.

### Goal Invariants

- Assert `PtyFleetService.create` in `src/standalone/ptyFleetService.ts` throws when `effectiveStartupSource === 'none'` and `role !== 'shell'`, and that the throw site is BEFORE `this.backend.create(...)` (no PTY spawned for a refused role).
- Assert the throw message contains the literal role name and the literal source string (`'none'`).
- Assert `createBatch` (`:1069`–`:1074`) still contains `if (!commands[a.role])` and returns `{ success: false, ... }` — the batch gate is not removed.
- Assert `agentLabelForRole` in `src/webview/terminals.js` returns `'(no CLI)'` (or equivalent sentinel) when `role !== NO_ROLE`, `agentNames[role] === 'No agent assigned'`, and `hasCommand[role] === false`.
- Assert `agentLabelForRole` still returns `''` for `role === NO_ROLE` (`shell`) — the deliberate blank is unchanged.
- Assert the role picker filter in `src/webview/terminals.js` contains `hasCommand[k] === true` (or equivalent) so no-CLI roles are excluded from the spawn target list.
- Assert the `createFleetTerminalAndDeliver` top-up branch in `src/services/TaskViewerProvider.ts` returns `false` (not delivers a prompt) when both `fleetWouldSend` and `expected` are empty.

## Outstanding Questions

- **[user]** Should the VS Code terminal creation path (`vscode.window.createTerminal`, used by `startMissionControlFromKanban`) also refuse no-command roles? It does not go through `PtyFleetService.create()` and is not addressed by this plan. Proceeding on the assumption that the pty fleet is the primary path and the VS Code terminal path is legacy — but if a no-command role can be seated via `vscode.window.createTerminal`, the defect persists there.

## Conflict with shipped behaviour (2026-09-19) — decide, do not just implement

This plan says seating a role with no agent CLI **must fail**. What shipped instead is
an **advisory**, and the two cannot both be true.

`resolveCommandlessRoles` (`agentGroupInstantiation.ts`) computes exactly the roles this
plan is about, and its docblock states the position outright: *"Advisory, NOT a gate.
`injectStartupCommand` returns silently when a role resolves to nothing, so the seat
spawns as a bare shell."* Team start reports the list and proceeds. On 2026-09-19 that
report was also surfaced **before** a start, on each team's card in the TEAMS tab
("Coding needs a startup command for: coder, intern"), so the operator is now told
ahead of time rather than after the seats are open.

Implementing this plan flips advisory → refusal. That is a legitimate design — a bare
shell is a useless seat — but it is a **change of position**, not a bug fix, and it
will break the "team start reports commandlessRoles and proceeds" contract and the
tests pinning it (`standalone-agent-team-isolation-contract`).

Decide which is wanted, and say so here before coding:

- **Refuse** — then the pre-start report becomes a warning about something that will
  be rejected, `instantiateAgentGroupCore` returns a failure, and every caller that
  currently starts-with-a-toast has to handle it.
- **Keep advisory** — then this plan is superseded by the report and should be retired,
  not coded.

The `shell` / `NO_ROLE` exception in the goal above is unaffected either way.
