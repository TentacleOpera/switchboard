# Two Migrations Wrote One Key to Two Homes — And One Answer Is Inert (was: Four Stores Answer "Is This Agent Visible?" and the Quietest One Wins

## Goal

One answer to "is this role in play on this board", with the store that gave it
named. Today at least four stores hold the value, they disagree on this machine right
now, the winner is the one nothing shows you, and the disagreement is invisible
on every surface that reads it.

## Problem analysis

### The stores disagree today, on the operator's own box

Read 2026-09-20:

| store | `researcher` |
| :--- | :--- |
| `~/.switchboard/integration-config.json` → `agents.visibleAgents` | **`true`** ← wins |
| board DB `config` → `agents.visibleAgents` | `false` |

**And that is only the pair one code path sees.** `KanbanProvider._getVisibleAgents`
— which `_getNextColumnId` uses to decide where a card advances — does not read
either of them. With no `_taskViewerProvider` (the standalone case) it reads
`<workspaceRoot>/.switchboard/state.json`, merged over an **inline defaults
literal declared in that method**. On this board `state.json` does not exist, so
the literal answered: `researcher: false`.

| store | read by | `researcher` |
| :--- | :--- | :--- |
| `~/.switchboard/integration-config.json` | `_resolveVisibleAgents` → `GET /kanban/columns` | **`true`** |
| board DB `agents.visibleAgents` | `_resolveVisibleAgents` (only if the file is absent) | `false` |
| `<workspaceRoot>/.switchboard/state.json` | `KanbanProvider._getVisibleAgents` | absent |
| inline literal in `_getVisibleAgents` | same, when `state.json` is absent | `false` |
| `DEFAULT_VISIBLE_AGENTS` (`agentConfig.ts`) | `_resolveVisibleAgents` default branch | `false` |
| VS Code `globalState` | `TaskViewerProvider` (legacy host) | — |

**Two different code paths answer the same question from different stores.** That
is what stalled the board: the host skipped `RESEARCHER`, the browser advanced
into it. The inline literal is also a second compiled-in copy of the defaults
that can drift from `DEFAULT_VISIBLE_AGENTS` silently.

`_resolveVisibleAgents` returns the **first** one that parses:

1. the machine-global file → `source: 'config'`
2. the board DB key → `source: 'legacy-db-config'`
3. compiled-in `DEFAULT_VISIBLE_AGENTS` → `source: 'default'`
4. nothing readable → `source: 'unknown'`

The file wins and the DB row is never consulted. There is no reconciliation, no
warning, and no surface that shows two answers exist. A fourth copy lives in VS
Code `globalState` under `switchboard.agents.visibleAgents`
(`TaskViewerProvider.ts:3521`), and `agents.visibleAgents` also travels in
`TransferBundleService`, so a restored bundle is a fifth way the pair can drift.

### It is a behaviour read, not a preference

This is the second of the four reads CLAUDE.md names — configuration, identity,
routing, **membership** — and the wrong answer changes what the board does:

- `_getNextColumnId` skips a column whose role is hidden, so visibility decides
  **where a card advances to**
- `_filterDynamicColumns` decides which columns are published at all
- `GET /kanban/columns` reports `enabled` per column from it
- `getPtyVisibleRoles` decides which roles the terminals picker offers

### It has already cost a full board stall

`RESEARCHER` was reported `enabled: true` from the file while the DB said
`false`. Because it sorted directly after `PLAN REVIEWED`, cards advanced out of
a 359-card column landed in it and stopped (commit `5f519e9c`). The column is
retired; **the split read that made it look enabled is not.**

The tell was available and nobody was looking: `tester` and `ticket_updater` are
`false` in *both* stores and reported disabled, while `researcher` — `false` in
one — reported enabled. Two rows derived the same way disagreeing is the signal,
and no surface puts them side by side.

### The source tag is honest and still not enough

`enabledSource: 'config'` is **true** — the file is config. But two different
stores can both truthfully answer `'config'`, so the tag cannot distinguish the
one that won from the one that was skipped. That satisfies the letter of the
fallback rule and misses its purpose: *"Which store answered?" must be
answerable after the fact.* It currently is not.

This is the precedent CLAUDE.md already records — *"a four-level
startup-command lookup where a stale value from a retired store wins and nothing
records which store answered"* — reproduced for a different key.

## Metadata

**Complexity:** 2
**Tags:** config, fallback-rule, visibility, divergence, standalone
**Scope:** `src/services/LocalApiServer.ts` (`_resolveVisibleAgents`,
`_handleGetColumns`), `src/services/GlobalIntegrationConfigService.ts`,
`src/services/stateConfigBridge.ts`, `src/services/KanbanProvider.ts`.
**Standalone only.**

## Constraints

**Do not silently pick a winner more cleverly.** Reordering the chain replaces
one quiet wrong answer with another. The requirement is that a disagreement
becomes **visible**, then that one store is authoritative.

**Name the store, not the category.** `'config'` is not an answer when two
stores are config. The tag must identify the file or the row that answered —
path or key — so it can be checked afterwards.

**`unknown` stays distinct.** "No store was reachable" must never collapse into
"nothing configured". The existing `unknown` branch and its visible-failure
choice are correct and stay.

**Migrate, do not delete.** Both keys exist in shipped versions. Whichever store
loses, its value is imported first and the loser archived, never unlinked.

## Proposed changes

### 1. Read every store, then decide

Resolution reads **all** available stores rather than returning at the first
hit, and returns `{ agents, source, conflicts }` where `conflicts` names each
role the stores disagree on and what each said. The chain order is unchanged;
what changes is that losing answers are now observed instead of skipped.

### 2. A conflict is reported, loudly, once

On resolution with a non-empty `conflicts`, log once at startup naming the role,
both values and both stores. A board running on a value its own database
contradicts must say so — that single line would have ended the 2026-09-20 stall
before it began.

### 3. The authority is ALREADY decided — fix the one reader that bypasses it

**Corrected 2026-09-20, after reading the bridge.** Two earlier drafts of this
plan proposed picking a winner — first the machine-global file, then the board
DB. Both were wrong: **the product already decided, deliberately, and recorded
it in code.** There is no authority question. There is one unconverted reader.

`stateConfigBridge.ts` is explicit:

> Bridge that redirects legacy `.switchboard/state.json` reads/writes to the
> kanban.db `config` table. **state.json no longer exists on disk;** the ~40
> legacy call sites that still speak "read/write state.json" go through this
> facade until they are individually converted to direct db calls.

and it carves out three keys:

```ts
const AGENT_GLOBAL_FILE_KEYS = new Set(['startupCommands', 'visibleAgents', 'customAgents']);
```

So the intended architecture is coherent and already implemented: state keys go
to the DB config table, **except** these three, which go to the machine-global
file. `LocalApiServer.ts:10999` confirms Setup's toggle writes there.

**And the classification is right, which is why the scope argument in the
previous draft failed.** These three keys describe *which agent CLIs this
machine has* — what is installed and runnable on this box. That is a machine
property. Column visibility is a downstream consequence of it, not the thing
being configured. Reading it as "which stages does this board run" was the
misreading.

**Correction, after checking the caller chain:** an earlier draft of this
section said `KanbanProvider._getVisibleAgents` never reads the documented store.
That is wrong. It delegates to `TaskViewerProvider.getVisibleAgents` whenever a
provider is set, and `bootstrap.ts:1825` sets one in standalone; that reads the
machine-global file. Its raw `fs` read of `state.json` sits *below* the
delegation and is unreachable on both hosts — dead code that reads like a second
lookup level. It is removed by
`forty-call-sites-still-speak-state-json-and-ten-of-them-bypass-the-bridge`,
not here.

So the two paths do **not** disagree today, and the `RESEARCHER` stall was not
caused by a split read. It was caused by a column existing for a role that never
takes delivery.

**So what is left for this plan** is narrow but real: the DB still carries a
`agents.visibleAgents` row that disagrees with the authoritative file
(`false` vs `true` for `researcher`), because two migrations wrote one key to two
homes. Nothing reads the DB row today, so it is inert — but it is a loaded gun
for the next reader that reaches for it, and it makes any audit of "what is this
board's visibility config?" return two answers.

**The stale DB row is a separate leftover.** `agents.visibleAgents` exists in the
board DB because `STATE_KEY_TO_CONFIG` maps `visibleAgents → agents.visibleAgents`,
so the state.json migration wrote it there while the integration-config migration
wrote the same key to the global file — two migrations, one key, two homes. Once
change 3 lands, nothing reads the DB row. Archive it as `*.migrated.bak` rather
than deleting, and remove `visibleAgents` from `STATE_KEY_TO_CONFIG` so the next
migration cannot recreate the split.

### 4. `enabledSource` names the store

`'config'` becomes something that identifies which one — the file path, or the
DB key — on `GET /kanban/columns` and anywhere else the source is surfaced.

### 5. A surface that shows the disagreement

Wherever agent visibility is edited, a role whose stores disagree is marked, with
both values shown. The operator is the only one who can say which is intended;
today they are not told there is a question.

## Verification plan

### Automated

- Two stores disagreeing on one role produces a `conflicts` entry naming the
  role, both values and both stores — asserted positively, since a resolver that
  never detects a conflict passes any test that only checks the happy path.
- **The live 2026-09-20 state as a fixture:** file `researcher: true`, DB
  `researcher: false` → conflict reported, one value chosen, source names the
  store that answered.
- Agreeing stores produce no conflict and no log line.
- No store reachable still yields `source: 'unknown'` and the visible-failure
  behaviour, distinct from "nothing configured".
- The import runs once, is idempotent, archives the loser as `*.migrated.bak`,
  and never drops a role present in only one store.
- `enabledSource` on `GET /kanban/columns` identifies a specific store for every
  role-bearing column.

### Goal invariants

- "Which store said this role is visible?" is answerable after the fact.
- Two stores cannot disagree without somebody being told.
- A role switched off in the authoritative store is off everywhere that reads it.
- An unreachable store never reads as an empty one.

### Manual

Set a role `false` in one store and `true` in the other, start the board, and
confirm the startup log names the conflict and both values. Then resolve it in
the authoritative store and confirm the line stops.

## Already done

**The duplicate compiled-in defaults are collapsed** (2026-09-20).
`KanbanProvider._getVisibleAgents` declared its own defaults literal beside
`DEFAULT_VISIBLE_AGENTS` and had already drifted — it omitted `claude_designer`,
`phone_a_friend` and `project_manager`, and an omitted role reads as `undefined`,
which `visibleAgents[role] === false` treats as VISIBLE. Two compiled-in copies
of a membership default, disagreeing, with no store involved. It now spreads the
canonical constant. This was safe ahead of the store decision and is not part of
the migration below.

## Outstanding questions

- **Does VS Code `globalState` participate at all?** It is a fourth copy in a
  host being removed. Confirm nothing still reads it before treating it as a
  store rather than as something to delete with the extension.
