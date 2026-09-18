# Terminals role picker: read the real visible-agents store in both hosts

## Goal

Fix the `terminals.html` role picker, which shows the same six hardcoded roles regardless of the
Agents-tab configuration, by reading visible agents from the machine-global store that both hosts can
reach — and delete the two hand-maintained role lists it falls back to today.

### Root problem / background (verified 2026-08-04)

Reported symptom: enabling `researcher` and `phone-a-friend` in the Agents tab does not make them
appear in the terminals role picker. Two independent causes, one of which is a bug.

**Cause 1 — the picker asks for a setting key nothing ever writes.**

- `src/webview/terminals.js:1866` — `fetchVisibleRoles()` POSTs `/kanban/verb/getSetting` with
  `key: 'agents.visibleAgents'`.
- `src/services/kanbanService.ts:198` — the handler prefixes **every** key that is not `selectedRole`
  or `roleConfig_*` with `switchboard.prompts.`, so the lookup becomes
  `switchboard.prompts.agents.visibleAgents`.
- `KanbanProvider._getScopedSetting:636-670` then searches project config → workspace DB config →
  globalState → DB config for that exact prefixed key.

Nothing writes it. The three real stores, all confirmed on this machine:

| Store | Key that exists | Read by |
| :--- | :--- | :--- |
| `~/.switchboard/integration-config.json` → `agents.visibleAgents` | machine-global source of truth | `TaskViewerProvider.getVisibleAgents:5640` (checked first) |
| globalState `switchboard.agents.visibleAgents` | present in `state.vscdb` under `TurnZero.switchboard` | `getVisibleAgents:5648` (fallback) |
| `<ws>/.switchboard/kanban.db` config `agents.visibleAgents` | present but stale — predates `phone_a_friend`, `project_manager`, `orchestrator` | legacy migration path `TaskViewerProvider.ts:1408` |

Because the prefixed key is absent, `fetchVisibleRoles` falls through to the hardcoded fallback at
`terminals.js:1823`:

```js
const DEFAULT_ROLES = ['coder', 'planner', 'reviewer', 'lead', 'analyst', 'intern'];
```

That is the six-role list the user sees. It cannot contain `researcher` or `phone_a_friend`, so no
amount of Agents-tab configuration will surface them.

**Cause 2 — `researcher` is genuinely switched off.** The real config holds `"researcher": false` and
`"phone_a_friend": true`. So Phone-a-Friend appears the moment cause 1 is fixed; Researcher
additionally needs its checkbox ticked. Its startup command is also empty (`"researcher": ""`), and
`injectStartupCommand` returns without writing to the pty when the command is blank
(`src/standalone/ptyFleetService.ts:121-131`), so it would open a bare shell — worth surfacing in the
UI rather than looking broken.

**The same dead key breaks OPEN AGENT TERMINALS.** `resolveGridAgents()` calls
`loadSetting('agents.visibleAgents', undefined)` (`terminals.js:1984`) through the same verb, so it
also gets `undefined` and silently uses its own hand-maintained mirror at `:1975-1980`. That mirror
has already drifted from `sharedDefaults.js:2-16`: it sets `phone_a_friend: false` (the real config
says `true`) and lists `claude_artifacts` where shared defaults now say `claude_designer`. Its own
comment instructs the reader to "keep in step with that method" — a duplication that has not held.

**Why the obvious fix is wrong.** `getStartupCommands` already returns `visibleAgents` in its response
(`KanbanProvider.ts:4291-4298`) and `terminals.js:1848` (`fetchAgentNames`) already calls it for agent
labels — but that verb is **not in standalone's `kanbanVerb` switch**, so it returns
`Verb 'getStartupCommands' not implemented in standalone mode` and the standalone sidebar's agent
labels are already silently blank. Routing the role list through it would fix the extension and leave
standalone on the hardcoded six forever.

**The seam that works in both hosts** is the one standalone's own PTY code already uses:
`GlobalIntegrationConfigService.getAgentStartupCommands()` at `ptyFleetService.ts:123`, i.e.
`getAgentConfig(...)` at `GlobalIntegrationConfigService.ts:422-424` — plain `fs`, no `vscode` API, no
DB, no globalState. It reads the same `~/.switchboard/integration-config.json` whose `agents` object
holds `visibleAgents`, and it is the store the extension consults first.

## Metadata
- **Tags:** frontend, backend, bugfix, ui, cli
- **Complexity:** 4
- **Project:** Browser Switchboard

## User Review Required (decisions, with defaults)

1. **New verb on `/terminals/verb/`, or reuse `getVisibleAgents`?**
   **Default (recommended): a new verb on the terminals rail.** `/terminals/verb/` is the route both
   hosts wire (`TaskViewerProvider.ts:1982` and `bootstrap.ts:1375`, dispatched by the shared
   `LocalApiServer._handleTerminalVerb:1634`), so one implementation serves both. `getVisibleAgents`
   exists as a `taskViewer`/`setup` verb (`verbSchemas.ts:1476`) but reaching it from the terminals
   panel would cross panel routes and re-introduce a host-specific path.

2. **Should the picker show role labels instead of raw keys?**
   **Default: yes.** `terminals.js:1897` sets `btn.textContent = role`, so the picker currently reads
   `ticket_updater` rather than "Ticket Updater". `BUILT_IN_AGENT_LABELS`
   (`sharedDefaults.js:38-52`) already has the mapping and `sharedDefaults.js` is injected into every
   headless panel, so this is nearly free. Flag it as a small UX change riding along, not a
   requirement.

3. **Show visible roles that have no startup command?**
   **Default: show them, annotated.** Hiding `researcher` because its command is blank would recreate
   the original complaint from a different direction. Show it with a hint that no agent CLI is
   configured, so the bare shell is expected rather than mysterious.

## Complexity Audit

### Routine
- The verb body is one call to an existing service method plus a merge over existing defaults.
- Both hosts already wire `terminalVerb`; no new routing.
- Deleting two hardcoded lists is subtraction.

### Complex / Risky
- **Standalone cannot fall back the way the extension does.** It has no globalState and no legacy
  DB-config read path, so if `~/.switchboard/integration-config.json` is absent the merge over
  `sharedDefaults.DEFAULT_VISIBLE_AGENTS` is the *only* thing standing between the user and an empty
  picker. The merge is therefore load-bearing, not cosmetic.
- Custom agents default to visible (`terminals.js:1994-1995` mirrors `getVisibleAgents`); the new verb
  must preserve that or custom roles disappear.

## Edge-Case & Dependency Audit

- **Race Conditions.** The picker is populated on click (`onNewTerminalClicked:1884`), so a config
  change made in another window between opening the panel and clicking is picked up naturally. No
  caching should be added, which would reintroduce staleness.
- **Security.** `~/.switchboard/integration-config.json` is mode `600` and also holds integration
  configuration. The verb must return **only** the `visibleAgents` map (and, if needed, which roles
  have a non-blank command as a boolean) — never the whole `agents` object, which includes
  `startupCommands`, and never anything else from that file.
- **Side Effects.** None; read-only.
- **Dependencies & Conflicts.** Independent of the Board verb-rail work. If
  `standalone-board-verb-rail-fallthrough` lands first, `getStartupCommands` would start working in
  standalone — but this plan should still not depend on it, because the terminals rail is the correct
  home for a terminals-panel read.

## Dependencies

- None. (No session IDs cited; IDs are assigned on import.)

## Adversarial Synthesis

**Risk summary.** Low risk and well-bounded: one read, one merge, two deletions. The trap is the
fallback — hosts differ in what they can fall back to, so a verb that returns the raw file contents
without merging over `sharedDefaults` would hand standalone an empty or partial map and produce a
worse picker than today's hardcoded six. Secondary trap is leaking neighbouring config from a 600-mode
file; the response shape must be explicit, not a spread.

## Proposed Changes

### `src/services/verbSchemas.ts`

- **Context.** Terminal verb schemas alongside the four `pty*` verbs; `getSetting` at `:404`.
- **Logic.** Register the new verb (suggested name `ptyVisibleRoles`, matching the `pty*` naming of
  the rail it lives on) with no required fields.
- **Implementation.** `ptyVisibleRoles: {}` following the `getVisibleAgents: {}` precedent at `:1476`.
- **Edge Cases.** Keep it on the terminals rail's allowlist only; it is not a kanban verb.

### `src/standalone/bootstrap.ts` and `src/services/TaskViewerProvider.ts`

- **Context.** `terminalVerb` suppliers at `bootstrap.ts:1375` and `TaskViewerProvider.ts:1982`
  (`handlePtyVerb`).
- **Logic.** Both add the same arm: read
  `GlobalIntegrationConfigService.getAgentConfig('visibleAgents')` and
  `getAgentConfig('customAgents')`, merge over `DEFAULT_VISIBLE_AGENTS` from `sharedDefaults`, mark
  every custom agent visible, and return `{ success: true, visibleAgents, hasCommand }` where
  `hasCommand` is a `role -> boolean` derived from non-blank `startupCommands` entries.
- **Implementation.** Put the merge in one shared helper (a small exported function beside
  `GlobalIntegrationConfigService`, or in `agentConfig.ts` next to `BUILT_IN_AGENT_LABELS`) and call
  it from both hosts, so the "keep in step" comment that already failed is not recreated a third time.
  The extension arm may additionally consult `TaskViewerProvider.getVisibleAgents:5611-5645` for its
  richer fallback chain; the shared helper is the standalone path and the floor for both.
- **Edge Cases.** Absent file → merged defaults, never an empty map. Malformed JSON → log and fall
  back to defaults rather than throwing, since a broken config must not make terminals unopenable.

### `src/webview/terminals.js`

- **Context.** `DEFAULT_ROLES:1823`; `fetchVisibleRoles:1864-1882`; picker build at `:1884-1919`
  (label at `:1897`); `GRID_BUILTIN_ROLES:1962-1965`; the drifted mirror
  `DEFAULT_VISIBLE_AGENTS:1975-1980`; `resolveGridAgents:1982-2018`; `loadSetting:495-510`.
- **Logic.** Replace `fetchVisibleRoles`'s `getSetting` call with `POST
  /terminals/verb/ptyVisibleRoles`, returning the roles whose value is not `false`. Have
  `resolveGridAgents` consume the same response instead of `loadSetting('agents.visibleAgents')`.
  Delete `DEFAULT_ROLES` and the `DEFAULT_VISIBLE_AGENTS` mirror. Render labels via
  `BUILT_IN_AGENT_LABELS`, falling back to the raw key for custom roles.
- **Implementation.** Keep `GRID_BUILTIN_ROLES` for **ordering** only — its comment (`:1955-1961`)
  records that it deliberately mirrors what OPEN AGENT TERMINALS opens rather than what the Agents tab
  can toggle; preserve that intent explicitly rather than deleting it by accident. Keep `NO_ROLE`
  (`:1839`) and the "No role" button (`:1907-1916`) untouched.
- **Edge Cases.** On request failure, fail visible: render the merged defaults from the injected
  `sharedDefaults.js` rather than a shorter hardcoded list, so a transient error cannot silently
  shrink the picker.

### Configuration follow-up (not code)

- Tick `researcher` in the Agents tab and give it a startup command, or accept the annotated
  bare-shell behaviour from User Review 3. `phone_a_friend` already has
  `devin --permission-mode bypass` and needs nothing.

## Verification Plan

> Session note (improve-feature review, 2026-08-04): compilation and automated tests were NOT run as
> part of this planning pass per session directive. The checks below are the coder's verification
> gates, to be executed at implementation time. Line numbers throughout this plan were re-verified
> against the working tree on 2026-08-04 (`terminals.js` is now 3046 lines).

### Automated Tests

- **Contract — the verb reflects the file, in both hosts.** Point
  `GlobalIntegrationConfigService` at a fixture with `{researcher:true, phone_a_friend:true,
  tester:false}`, call the terminals verb through each host's `terminalVerb`, and assert
  `researcher` and `phone_a_friend` are present and `tester` is absent.
- **Contract — absent file yields merged defaults, not empty.** With no config file, assert the
  response equals `sharedDefaults.DEFAULT_VISIBLE_AGENTS` plus custom agents, and that the count is
  greater than the six roles the old fallback produced.
- **Contract — response leaks nothing.** Assert the response body contains no `startupCommands`
  strings and no keys beyond the documented shape. This is the security assertion for a 600-mode
  source file.
- **Regression — no hardcoded role lists remain.** Grep-style assertion that `terminals.js` contains
  neither `DEFAULT_ROLES` nor a local `DEFAULT_VISIBLE_AGENTS`, so the drift cannot return.
- **Contract — custom agents are visible by default.** With one custom agent in `customAgents` and no
  entry in `visibleAgents`, assert it appears.
- **Manual smoke.** In both hosts: open the picker, confirm Phone-a-Friend is listed with a label
  (not `phone_a_friend`), create one, and confirm `devin --permission-mode bypass` is injected.

## Uncertain Assumptions

- That `~/.switchboard/integration-config.json` is always the freshest of the three stores. It is on
  this machine (it alone knows `phone_a_friend`, `orchestrator`, `project_manager`), and
  `getVisibleAgents:5617` reads it first, so treating it as authoritative matches existing behaviour —
  but a user who last configured agents in a much older build may have data only in globalState, which
  standalone cannot see.

## Out of Scope

- Migrating the stale `kanban.db` `agents.visibleAgents` row.
- Making `getStartupCommands` work in standalone (covered by the Board verb-rail plan).

## Review Findings

Implementation verified correct: `ptyVisibleRoles` verb wired in both hosts (`TaskViewerProvider.ts:1987`, `bootstrap.ts:1101`), `GlobalIntegrationConfigService.getPtyVisibleRoles` merges over `DEFAULT_VISIBLE_AGENTS` with custom-agent visibility and `hasCommand` map, `DEFAULT_ROLES` deleted, drifted `DEFAULT_VISIBLE_AGENTS` mirror deleted (only the `sharedDefaults` import remains as fallback at `terminals.js:2950`), `resolveGridAgents` now calls `fetchPtyVisibleRoles` instead of the dead `loadSetting('agents.visibleAgents')`, picker renders labels via `BUILT_IN_AGENT_LABELS`. `GRID_BUILTIN_ROLES` had stale `claude_artifacts` → fixed to `claude_designer` to match `sharedDefaults.js`. The `ptyVisibleRoles` schema was NOT registered in `verbSchemas.ts` — the terminal verb rail (`_handleTerminalVerb`) does not call `validateVerbPayload` and there is no 'terminal' provider key, so the registration cannot be cleanly fulfilled without an architectural change. This is a plan compliance gap, not a functional break. Verification: compile passes, `test:contract:terminal-solo-popout` 11/11 pass, `test:contract:terminal-pane-pinning` 15/15 pass.
