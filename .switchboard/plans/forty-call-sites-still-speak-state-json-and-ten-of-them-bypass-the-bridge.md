# Forty Call Sites Still Speak state.json, and Ten of Them Bypass the Bridge

## Goal

Every read and write of a retired `state.json` key goes through
`stateConfigBridge`, or is deleted. No code path reads a file the architecture
says does not exist, and **nothing recreates it**.

## Problem analysis

### The file is retired, deliberately, and the bridge says so

`stateConfigBridge.ts`:

> Bridge that redirects legacy `.switchboard/state.json` reads/writes to the
> kanban.db `config` table. **state.json no longer exists on disk;** the ~40
> legacy call sites that still speak "read/write state.json" go through this
> facade until they are individually converted to direct db calls.

The migration exists (`migrateJsonFileToConfig`), it preserves unknown keys under
`legacy.state`, and the writer was gutted — `KanbanDatabase.exportStateToFile()`
is an empty method body. The design is finished. The conversion is not.

### Caller check, 2026-09-20: nine are DEAD FALLBACKS, one is live

Each of the ten raw sites was checked for a `this._taskViewerProvider`
delegation guard ahead of the `fs` read, and `bootstrap.ts:1825` confirms
standalone calls `kanbanProvider.setTaskViewerProvider(...)`. So the guard is
taken on **both** hosts:

| method | delegates? | verdict |
| :--- | :--- | :--- |
| `_getCustomKanbanColumns` | yes | dead fallback — **delete** |
| `_getDefaultPromptOverrides` | yes | dead fallback — **delete** |
| `_saveDefaultPromptOverrides` | yes | dead fallback — **delete** |
| `_getStartupCommands` | yes | dead fallback — **delete** |
| `_saveStartupCommands` | yes | dead fallback — **delete** |
| `_getCustomAgents` | yes | dead fallback — **delete** |
| `_getAgentNames` | yes | dead fallback — **delete** |
| `_getVisibleAgents` | yes | dead fallback — **delete** |
| `_hasAssignedAgent` | yes | dead fallback — **delete** |
| **`_getLiveSyncConfig`** (line 526) | **no** | **live raw read — convert** |

`TaskViewerProvider.getVisibleAgents` reads the machine-global file, which is
the documented home (`AGENT_GLOBAL_FILE_KEYS`). So nine of these methods already
answer from the right store on every host; what remains is unreachable code that
*looks* like a second lookup level and reads as one to anybody auditing.

**This shrinks the plan and removes its alarm.** An earlier draft claimed the two
save paths could recreate a retired `state.json`. They cannot: both
`_saveDefaultPromptOverrides` and `_saveStartupCommands` delegate before reaching
their `fs.promises.writeFile`, so the write is dead code. It is worth deleting
because a resurrection hazard sitting in the tree is one refactor away from being
real — not because it is firing today.

**The one live defect** is `_getLiveSyncConfig`: no delegation, a raw read of a
file the architecture says does not exist, and a fallback on every call. It is
called once (line 551). `liveSyncConfig` has a documented home —
`planning.liveSyncConfig` in `STATE_KEY_TO_CONFIG` — which it never consults.

### Sites outside `KanbanProvider`### Sites outside `KanbanProvider`

`TaskViewerProvider` (1), `PlanningPanelProvider` (1), `cleanWorkspace` (1),
`extension.ts` (2), `KanbanDatabase` (2). The `KanbanDatabase` pair is the
**migration itself** and must keep reading the file — that is its job. The others
need classifying individually; `extension.ts` is the legacy host and is out of
scope.

## Metadata

**Complexity:** 3
**Tags:** config, state-json, bridge, fallback-rule, cleanup, standalone
**Scope:** `src/services/KanbanProvider.ts` (ten sites),
`src/services/TaskViewerProvider.ts`, `src/services/PlanningPanelProvider.ts`,
`src/lifecycle/cleanWorkspace.ts`. **Standalone only** — `extension.ts` is the
legacy host and is excluded deliberately.

## Constraints

**The migration keeps its raw read.** `KanbanDatabase.migrateJsonFileToConfig`
must go on reading `state.json` from disk — it is the importer. A sweep that
"converts" it destroys the upgrade path for every install that has not migrated.

**Delete, do not convert, where the branch is unreachable.** Converting dead code
to use the bridge preserves the illusion of a second lookup level. Nine of these
sites need removing, not rewiring.

**Do not delete a value to make a reader clean.** Where a raw site holds the only
copy of something, import it into the documented home before removing the site.
Import before deleting.

**Honour the documented homes.** `AGENT_GLOBAL_FILE_KEYS` (`startupCommands`,
`visibleAgents`, `customAgents`) go to the machine-global file; everything else
in `STATE_KEY_TO_CONFIG` goes to the DB config table. This plan routes readers to
existing homes; it does not move any key.

**No silent default on the four reads.** Where a converted reader finds nothing,
it returns a tagged result or fails loudly — never a literal that reads like
configuration. That is what made this invisible for so long.

## Proposed changes

### 1. Delete the nine dead fallbacks

The `fs` branch below each delegation guard is removed, including the two
`writeFile` calls. Where a method needs a behaviour when no provider is set, it
returns a tagged empty/`unavailable` result — never a literal that reads like
configuration.

### 2. A guard that fails if the file is recreated

A gate asserting no `writeFile` targets `state.json` in `src/` outside
`KanbanDatabase`'s migration. Cheap, static, and it is the only thing that stops
this from coming back one convenient save at a time.

### 3. `_getLiveSyncConfig` reads its documented home

Converted to read `planning.liveSyncConfig` through the bridge. This is the only
one of the ten that changes observable behaviour.

### 4. Each remaining site is classified, in writing

`TaskViewerProvider`, `PlanningPanelProvider` and `cleanWorkspace` are each
labelled **convert**, **delete** or **exempt (migration/cleanup)**, with the
reason recorded at the site. An unclassified site is the same bug waiting.

### 5. A resurrection check at startup

If `state.json` exists on a board whose migration has already run, say so once:
it means something recreated it, and its contents are not being read by anything
that matters. A one-line startup warning naming the path.

## Verification plan

### Automated

- No `writeFile` to `state.json` outside `KanbanDatabase`'s migration.
- No raw `readFile` of `state.json` in `KanbanProvider`,
  `TaskViewerProvider` or `PlanningPanelProvider`.
- **Round-trip per key:** a value written through the new path is read back by
  the converted reader AND by the independent consumer that already used the
  documented home (`_resolveVisibleAgents` for `visibleAgents`). Both must see
  it — one-sided round-trips are exactly what hid this.
- `_getVisibleAgents` returns what the machine-global file says, before and
  after the deletion — proving the removed branch was unreachable.
- A `state.json` placed on a migrated board triggers the startup warning and
  changes no behaviour.
- The migration still imports a real `state.json` and archives it.

### Goal invariants

- One path answers each retired key, and it is the documented one.
- No code recreates a file the architecture retired.
- A reader that finds nothing says so; it never substitutes a literal.
- The upgrade path for an unmigrated install is untouched.

### Manual

Toggle an agent's visibility in Setup, then confirm the kanban's advance
behaviour changes accordingly without a restart — the thing that does not happen
today.

## Outstanding questions

- ~~Convert or delete?~~ **Answered above** by the caller check: nine delete, one
  converts.
- **Does `cleanWorkspace` still need the path?** If it deletes `state.json` as
  part of a wipe, it stays; if it reads it, it converts.
