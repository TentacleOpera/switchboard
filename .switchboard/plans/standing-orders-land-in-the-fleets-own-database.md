# Standing Orders Land in the Fleet's Own Database

## Goal

A team member spawned by `ptyStartTeam` actually receives its standing-orders block. Today it does not: the orders are written to one workspace's `kanban.db` and read from another's, so `selectOrders` matches nothing and every prompt reaches the seat bare. Make the standing-orders write target the same root the delivery path reads, and make a zero-order selection for a team member visible in the log instead of silent.

### Problem analysis — reproduced live, not inferred

A lead-dispatched intern (`lead-1-intern`) worked a subtask, finished, and reported to nobody. Its team definition (`terminals.agentGroups`, team `Coding`) explicitly lists `intern×1` with `relationship: 'reports-to-head'` and carries the correct instruction text:

> `{child} is your head agent. When you finish a task, report to it — POST /terminals/verb/ptySendPrompt … Do not wait to be asked.`

The template is right. The order never reached the seat. Four facts, gathered from this machine on 2026-08-17:

**1. The live fleet's orders are in a different workspace's DB.**

```
$ sqlite3 /Users/patrickvuleta/Documents/GitHub/switchboard/.switchboard/kanban.db \
    "select value from config where key='terminals.standingOrders';"
   3 rows, all scope=pair:
     parent='Feature Implementation-coder-1'  child='Feature Implementation'
     parent='Feature Implementation-coder-2'  child='Feature Implementation'
     parent='Feature Implementation-coder-3'  child='Feature Implementation'

$ sqlite3 /Users/patrickvuleta/Documents/Gitlab/.switchboard/kanban.db \
    "select value from config where key='terminals.standingOrders';"
   12 rows, including:
     scope=team       parent='lead-1'          child=''  teamId='team_lead_1'
     scope=team-head  parent='lead-1'          child=''  teamId='team_lead_1'
     scope=pair       parent='lead-1-coder-1'  child='lead-1'
     scope=pair       parent='lead-1-coder-2'  child='lead-1'
     scope=pair       parent='lead-1-coder-3'  child='lead-1'
```

The live fleet is `lead-1`, `lead-1-coder-1`, `lead-1-coder-2`, `Coding-reviewer`, `lead-1-intern`, `analyst-1`, `planner-1`, and the board's selected root is the **switchboard** workspace. Every order describing that fleet is in the **Gitlab** DB. The three rows in the switchboard DB name `Feature Implementation-*` terminals that do not exist — residue of the phantom `feature-implementation` / "Lead team" documented in `feature_plan_20260816212416_team-verbs-read-the-wrong-workspace-db.md`.

> *Re-measured against the live machine during this improve pass (2026-08-17): both halves of fact 1 still hold exactly. The switchboard DB's `terminals.standingOrders` is still the same three phantom `Feature Implementation-*` pair rows and nothing else.*

**2. Selection therefore matches nothing, in both directions.** `selectOrders` (`standingOrders.ts:100-135`) pair rule at `:133`:

```js
return o.parent === targetName && o.child !== undefined && liveNames.has(o.child);
```

Both halves fail for every live terminal: no live terminal is named `Feature Implementation-coder-N`, and `Feature Implementation` is not in `liveNames`. Zero orders apply to anything in the fleet. `applyStandingOrders` returns `cleanPrompt` unchanged at `:186` and logs nothing.

**3. The write root and the read root are derived independently and diverge.**

- **Write.** `startTeamForWorkspace` (`TaskViewerProvider.ts:11794`) computes `spawnCwd` at `:11807-11809` (`payloadCwd || parentRoot || pinnedRoot`) and passes it as `workspaceRoot` into `startTeamById` (`:11820`). `startTeamById` hands that same value to the instantiator (`:11828`), which is `instantiateAgentGroup` (`:11958`), which resolves `db = _getKanbanDb(_resolveWorkspaceRoot(workspaceRoot))` (`:11959`, `:11966`) and passes it to `instantiateAgentGroupCore` (`:11979`) and thence to `wireSpawnedTeam` (`agentGroupInstantiation.ts:123`). The orders are installed into **the DB of the directory the terminals were spawned in**.
- **Read.** The delivery chokepoint reads a *fixed* root — `_apiServerWorkspaceRoot` (`TaskViewerProvider.ts:542`):

  ```js
  const db = await this._getKanbanDb(this._apiServerWorkspaceRoot || this._getWorkspaceRoot() || '');
  ```

  Its own comment pins this deliberately: *"NOT `_getWorkspaceRoot()`, which follows the board's active workspace selection and would read a different DB after a workspace switch."*

Nothing ties the two roots together. In a multi-root window they are simply different values, and the orders become unreachable the moment they differ.

**Root cause.** Commit `226b7f09` correctly made *team definition lookup* multi-root, so a team stored in any registered root can be started. The orders write silently inherited that variability: it follows the spawn root rather than the fleet root. But a standing order is not a property of where a team template is stored — it is a property of **live terminals in the running fleet**, and the fleet has exactly one reader. The definition root may legitimately vary; the orders root may not.

**4. Both failures are silent.** No log line, no `wiringError`, no UI signal. `wireSpawnedTeam` returned `{ ok: true }` — it wrote successfully, just somewhere nothing reads. This is why the defect survived: every gate reports success.

*(Line numbers in this section were re-resolved against HEAD during the improve pass — `471 → 542`, `11721 → 11794`, `11733-11735 → 11807-11809`, `11749 → 11820`, `11755 → 11828` and `→ 11958`, `11886/11893 → 11959/11966`, `122 → 123`. The claims themselves are unchanged and were re-verified in the code.)*

**There are exactly three standing-orders readers on the extension host, and all three read the same root.** `_ptyHostVerb`'s PTY chokepoint (`:542`), the VS Code-terminal path `_resolveStandingOrdersForVsCode` (`:760`), and the rename rewrite (`:3035`) all resolve `this._apiServerWorkspaceRoot || …`. The read side is already unanimous; only the write side dissents.

### Scope — what this plan does not own

The team-scoped order in the Gitlab DB carries `teamId='team_lead_1'`, and **no group with that id exists in either DB's `terminals.groups`**, so `selectOrders`'s team branch (`:113-114`) would bail even with the DB fixed. That is a *separate* defect with a *different* cause — a key-namespace split (`wireSpawnedTeam` writes bare `terminals.groups`; the panel writes `switchboard.prompts.terminals.groups`) — and it is already owned, diagnosed, and superseded-to-correct in **`team-roster-survives-the-webview-whole-array-save.md`**. Do not re-diagnose or re-fix it here.

> **Superseded:** "no group with that id exists in either DB's `terminals.groups`" and "the two compose and both are required … Sequencing is free — they touch different lines and either may land first. Neither is individually sufficient."
> **Reason:** Re-measured at HEAD, the roster plan has **landed**. `TERMINALS_GROUPS_KEY` is now the single prefixed key `'switchboard.prompts.terminals.groups'` (`teamWiring.ts:99`), writes go through `mutateTerminalGroups` (`:127`) with a bare-key import migration, and `team_lead_1` **does exist** — as a bare-key row in the Gitlab DB: `{id: 'team_lead_1', members: ['lead-1','lead-1-coder-1','lead-1-coder-2','lead-1-coder-3']}`. The composition claim and the sufficiency claim were both written against a pre-landing snapshot.
> **Replaced with:** the roster half is landed; this plan is the remaining half for the **coder** seats. For the **intern** it is still not sufficient, but for a *third* reason that neither plan owns — see the roster-staleness item below and in `## Outstanding Questions`.

**Measured roster state at HEAD (2026-08-17):**

| DB | key | contents |
|---|---|---|
| switchboard | `switchboard.prompts.terminals.groups` | `Planners`, `coding team` (`grp_1786765519974_4t987`, members include `lead-1-intern`), `Figma` |
| switchboard | bare `terminals.groups` | **absent** |
| Gitlab | bare `terminals.groups` | `team_lead_1` (members: head + 3 coders, **no intern**), `team_planner_2` |

`team_lead_1`'s roster is stale: it was registered when the team had three coders, and `wireSpawnedTeam`'s group registration is **skip-if-id-exists** (`teamWiring.ts:1015`), so adding the intern to the team definition and restarting never updates it. That is a third, independent root cause for the reported symptom and it is **out of scope here** — recorded in `## Outstanding Questions` as a separate plan.

There is one non-obvious interaction with this plan's change, and it belongs in the coder's head: `mutateTerminalGroups` imports bare-key groups **from the `db` it is handed**. Moving the wiring `db` from the spawn root to the fleet root therefore changes *which* legacy bare rows get imported. On this machine that is the difference between importing Gitlab's stale intern-less `team_lead_1` and importing nothing — after which `wireSpawnedTeam` registers a **fresh** `team_lead_1` carrying the current members. The fix may incidentally unblock the intern here. Do not rely on that: it is a side effect of one machine's data, not a contract, and it does not hold when the spawn root and fleet root coincide over a stale row.

## Metadata

**Complexity:** 6
**Tags:** backend, reliability, bugfix, database

> **Superseded:** **Complexity:** 5
> **Reason:** The improve pass added a second root-semantics change (latching `_apiServerWorkspaceRoot`, a field read by three delivery sites) and resolved the second writer from "verify then decide" to a confirmed divergence needing its own separate handle. Three files, three call sites, and a change to the meaning of a shared field is a 6, not a 5.
> **Replaced with:** **Complexity:** 6. Still "Send to Coder" (4-6).

> **Superseded:** **Tags:** backend, reliability, multi-root, standing-orders
> **Reason:** `multi-root` and `standing-orders` are not in the allowed tag vocabulary; invented tags are dropped by the importer, so the plan silently loses its own categorisation.
> **Replaced with:** **Tags:** backend, reliability, bugfix, database

## User Review Required

None. The one real decision — which root owns standing orders — is made below (the fleet's read root), and the stale-rows question is decided too (leave them; do not migrate).

## Architecture Decision — the fleet root owns standing orders

`wireSpawnedTeam` must write to the root the delivery path reads, not the root the team was spawned in or defined in. Concretely: the extension host's `_apiServerWorkspaceRoot`, which is already the single root all three delivery readers use (`TaskViewerProvider.ts:542`, `:760`, `:3035`).

This deliberately **decouples the three roots** that are conflated today:

| Root | Purpose | May vary |
|---|---|---|
| Definition root | where `terminals.agentGroups` holds the team template | yes — multi-root by design (`226b7f09`) |
| Spawn cwd | the terminals' working directory | yes — worktrees, `payloadCwd` |
| **Fleet root** | where standing orders live | **no — must be latched to exactly one per host** |

> **Superseded:** the "Fleet root" row read *"where standing orders **+ group registration** live — no, exactly one per host"*.
> **Reason:** Two errors, both load-bearing. **(a)** Group registration does **not** live on the fleet root and does not travel with `db`: `mutateTerminalGroups` (`teamWiring.ts:127-141`) prefers `settings` over `db` whenever a settings accessor is supplied, and every extension-host and standalone caller supplies one (`TaskViewerProvider.ts:11971`, `:3057`, `bootstrap.ts:1362`, `:2126`). Groups therefore route through `KanbanProvider._updateScopedSetting`, which in the default configuration writes to **`globalState`** (host-global, root-independent) and mirrors to the board's *active* root — a completely different resolution from `db`. Writer and reader of groups already agree with each other because **both** use the scoped-settings path (`TaskViewerProvider.ts:630-632`, `:785-787`, `bootstrap.ts:310-312`); nothing about them needs this plan. **(b)** "exactly one per host" is not true of `_apiServerWorkspaceRoot` at HEAD — see the next change below. It is a *snapshot of the board's active selection at API-server-start time*, re-derived on every re-entrant `_startLocalApiServer()`.
> **Replaced with:** the fleet root owns **standing orders only**. Group registration is out of this plan's blast radius entirely and must not be touched. And the "one per host" property must be **created** by latching the field, not assumed.

The definition and spawn roots keep their current resolution untouched. Only the DB handed to `wireSpawnedTeam` changes, plus the latch that makes the destination stable.

### The fleet root must be latched, not re-derived

`_startLocalApiServer` (`:2605`) sets `this._apiServerWorkspaceRoot = resolveEffectiveWorkspaceRootFromMappings(this._getWorkspaceRoot())` at `:2621`, and `_getWorkspaceRoot()` is `_resolveWorkspaceRoot()` with no argument — **the board's active workspace selection**. The method is re-entrant by design: the liveness watchdog calls it again on every failed health check (`:3684`). So the "pinned" root is only pinned until the next server restart, at which point it follows wherever the board has since been switched to.

The fleet does not move with it. The same file states the fleet is constructed **once per extension-host lifetime** and "outlives individual server restarts". A watchdog restart after a workspace switch therefore silently relocates the orders store out from under a running fleet — reproducing this exact defect from a completely different direction, with no team start involved.

Latching costs one line and makes the table row above true. The field has exactly three readers, all of them standing-orders delivery sites (`:542`, `:760`, `:3035`); the `LocalApiServer` constructor receives the local `effectiveRoot` const separately, so latching the field cannot change route DB resolution.

### Stale rows: leave them, do not migrate

Orders already written to a non-fleet root stay where they are. Justification against the migration rule: **nothing is being deleted or reformatted**, so there is no user data at risk. The rows remain visible and deletable in the existing standing-orders UI, and `wireSpawnedTeam` is idempotent by `(parent, child)` and `(scope, teamId)`, so the next team start installs a correct set in the correct root without touching the old one.

An import-from-other-roots pass is explicitly **rejected**: the only concrete instance of stale rows on this machine is three orders naming a phantom team, and importing them would propagate dead rows into the one DB that is currently clean.

**Upgrade path for a running install:** restart the team once after upgrading. Say this in the commit message; it needs no UI copy, because a team start is already the normal way orders are installed.

## Complexity Audit

### Routine

- Resolving a second `KanbanDatabase` handle from an existing field — `_getKanbanDb` is already called this way at three sites in the same file.
- Adding a `console.warn` in a pure function.
- Adding two explanatory comments (`bootstrap.ts`, and the assertion comment on the second writer).
- The `|| resolvedRoot` / `|| effectiveRoot` fallbacks are the existing expressions, reused verbatim.

### Complex / Risky

- **Changing the meaning of `_apiServerWorkspaceRoot` from "re-derived" to "latched"** affects three readers at once, including the rename rewrite. Low line count, high semantic reach.
- **Two extension-host writers must be changed together.** Changing one and not the other produces a fleet whose orders live in two DBs depending on how each team was started — strictly worse than today's single wrong root, and invisible in a single-root workspace.
- **The wiring `db` also selects which legacy bare `terminals.groups` rows `mutateTerminalGroups` imports.** Moving it has a second-order effect on the roster the coder must not be surprised by.
- **In `instantiateAgentGroup`, `db` is used for two unrelated purposes** — the core's wiring handle and `onCreated`'s `_updatePtyMirrorRegistry(db)` (`:12010`). A naive repoint moves the mirror registry too, which is not in scope.
- **In the `handlePtyVerb` create block, `db` (`:3026`) is shared with `updateMirrorRegistry(db)`** for the same reason. Same trap, second site.

## Edge-Case & Dependency Audit

**Race Conditions**

- *Autostart vs. API-server start.* `startTeamsOnLoad` (`:11878`) is invoked from activation, after the `TaskViewerProvider` constructor has already fired `void this._startLocalApiServer()` (`:1305`). The field assignment at `:2621` is reached with **no intervening `await`**, so it is set synchronously inside the constructor call and is present before any autostart can run. Verified, not assumed — if it were not, the `|| resolvedRoot` fallback would silently reinstate the bug on exactly the autostart path.
- *Watchdog restart mid-session.* This is the race the latch exists to close. Without it, `_startLocalApiServer` re-entry relocates the read root while the fleet keeps running.
- *Order install vs. first prompt.* Unchanged: `wireSpawnedTeam` is already awaited before the create/start response returns, so a child cannot receive a prompt before its order exists.
- *Concurrent writes.* Unchanged: `mutateStandingOrders` serialises through its own module-level promise chain (`standingOrders.ts:39-58`), and that chain is per-module, not per-DB — two roots in flight still serialise.

**Security**

- No new wire-reachable surface. `_apiServerWorkspaceRoot` is host-derived and never caller-supplied; the change specifically *removes* the caller-supplied `root` from the second writer's wiring path, narrowing what a wire caller can influence.
- The diagnostic logs terminal names and order parent/child names to the extension output channel only. It must not log `instruction` bodies — those can carry operator-authored prose.

**Side Effects**

- Moving the wiring `db` changes which bare-key `terminals.groups` rows are imported by `mutateTerminalGroups` (see Scope). Behaviour-affecting, one-way, and desirable here, but it must be stated in the commit message.
- `_getKanbanDb` on a not-ready DB calls `this._seams().ui.showWarningMessage(...)`. If `_apiServerWorkspaceRoot` ever points at an unusable root, a team start now surfaces a warning where it previously wrote silently to the spawn root. That is the intended trade.
- Latching means a mid-session workspace switch no longer moves the orders store. Orders installed before the switch stay reachable; that is the point.

**Dependencies & Conflicts**

- `team-roster-survives-the-webview-whole-array-save.md` — **landed**. This plan builds on the prefixed `TERMINALS_GROUPS_KEY` and `mutateTerminalGroups` being present. Do not re-open it.
- `feature_plan_20260816212416_team-verbs-read-the-wrong-workspace-db.md` — same family (the phantom `Feature Implementation` rows are its residue). No shared lines.
- Standalone host (`bootstrap.ts`) is comment-only here; it must stay byte-behaviour-identical.
- No file overlap with the roster plan's edits beyond both touching `teamWiring.ts` in different functions — but per the PRD's one-stream-per-provider-file rule, do not run this concurrently with any other agent editing `TaskViewerProvider.ts`.

## Dependencies

- `sess_20260816212416 — team verbs read the wrong workspace DB` (same root-divergence family; independent lines)
- `sess_20260817_roster — team roster key-namespace split` (landed; supplies `TERMINALS_GROUPS_KEY` + `mutateTerminalGroups`)

## Adversarial Synthesis

Key risks: the second extension-host writer is a *confirmed* divergence (`db = _getKanbanDb(root || effectiveRoot)` at `:3026`, caller-supplied root first), so changing only the `instantiateAgentGroup` funnel splits the fleet's orders across two DBs and is worse than the status quo; `_apiServerWorkspaceRoot` is re-derived from the board's active selection on every watchdog-triggered `_startLocalApiServer` re-entry, so naming it "the fleet root" without latching it fixes the team-start path and leaves an identical bug reachable through a server restart; and at both writer sites the `db` local is shared with a mirror-registry write, so a repoint rather than a second handle silently relocates unrelated state. Mitigations: change both writers in the same commit and add a source-shape test that fails if they drift; latch the field with `if (!this._apiServerWorkspaceRoot)`; resolve a distinct `wiringDb` at each site and leave the existing `db` local untouched for its mirror-registry consumer. Residual: this plan does not make the *intern* receive its order — `team_lead_1`'s roster is stale and `wireSpawnedTeam`'s group registration skips on existing id, a third root cause tracked separately.

## Proposed Changes

### `src/services/TaskViewerProvider.ts` — latch `_apiServerWorkspaceRoot` (`:2621`)

- **Context:** `this._apiServerWorkspaceRoot = effectiveRoot;` runs on every `_startLocalApiServer()` call, and that method is re-entrant (the liveness watchdog at `:3684` restarts it). `effectiveRoot` derives from `this._getWorkspaceRoot()` (`:2610`) — the board's active selection. The field's three readers (`:542`, `:760`, `:3035`) all treat it as a stable pin; the assignment does not honour that.
- **Logic:** Assign once per host lifetime. `if (!this._apiServerWorkspaceRoot) { this._apiServerWorkspaceRoot = effectiveRoot; }`. Replace the existing comment's "Re-assigned on every `_startLocalApiServer` call, which is re-entrant — it stays in lockstep with the `workspaceRoot` option below" with the real contract: the *fleet* is one-shot per host, so the fleet's orders root must be too, and it is deliberately NOT in lockstep with the per-server-instance `workspaceRoot` option.
- **Implementation:** The guard also covers the case where the first call returned early at `:2612` (no workspace root yet) — the field stays unset and the next call latches it. `LocalApiServer` continues to receive the local `effectiveRoot` const, unchanged, so per-instance route resolution is untouched. Do not add a reset path; a host restart is the reset.
- **Edge cases:** Operator switches the board's workspace, watchdog restarts the server → routes follow the new root (unchanged); orders keep reading the latched root, so a running fleet's orders stay reachable. Single-root window → identical value every time, latch is a no-op.

### `src/services/TaskViewerProvider.ts` — `instantiateAgentGroup` (`:11958`)

- **Context:** Resolves `db` from its `workspaceRoot` argument (`:11959`, `:11966`) and passes it to `instantiateAgentGroupCore` at `:11979`, which forwards it to `wireSpawnedTeam` (`agentGroupInstantiation.ts:123`). This is the single funnel every extension-host team start passes through: `startTeamForWorkspace` (`:11828`), the boot-time autostart (`:11930` → `startTeamForWorkspace`), and the `startAgentGroup` webview arm (`KanbanProvider.ts:11658`, which falls through to `startTeamForWorkspace` because the extension host registers no instantiator).
- **Logic:** Keep `resolvedRoot` as the **spawn cwd** — it is passed on as `cwd` at `:11982` and must not change. Keep the existing `db` local as-is — `onCreated` at `:12010` uses it for `_updatePtyMirrorRegistry(db)`, which is out of scope. Resolve a *second*, separate handle for wiring: `const wiringDb = await this._getKanbanDb(this._apiServerWorkspaceRoot || resolvedRoot);` and pass `db: wiringDb` at `:11979`.
- **Implementation:** `instantiateAgentGroupCore` uses its `db` for exactly two things — the `if (!db)` guard at `agentGroupInstantiation.ts:70` and the `wireSpawnedTeam` call at `:123`. It is purely the wiring handle, so this substitution is complete and needs no signature change. The `|| resolvedRoot` fallback preserves today's behaviour when `_apiServerWorkspaceRoot` is unset, so a host that never started the API server is not made worse. Guard `wiringDb` with the same `if (!wiringDb || !(await wiringDb.ensureReady()))` shape as `:11967` and fail with the existing `'Kanban DB not ready'` string — a team whose orders cannot be installed must not report a clean start. (`_getKanbanDb` already awaits `ensureReady()` internally and returns `undefined` on failure; the redundant call matches the surrounding style and costs nothing.)
- **Edge cases:** `_apiServerWorkspaceRoot === resolvedRoot` (the single-root case, the overwhelming majority) → `_getKanbanDb` returns the same cached handle from `this._kanbanDbs` and nothing changes. Root not registered / DB missing → `_getKanbanDb` warns via the seam and returns `undefined`, and the new guard surfaces it rather than silently writing to the spawn root. Worktree start (`payloadCwd` = worktree) → `resolvedRoot` is the worktree, `wiringDb` is the fleet root; orders no longer land in a worktree's `.switchboard/`.

### `src/services/TaskViewerProvider.ts` — `handlePtyVerb` `ptyCreateTerminal` wiring (`:3062`)

- **Context:** The *second* extension-host writer — a head created with delegates wires its team here (`wireSpawnedTeam` at `:3062`), using the `db` resolved at `:3026`. This path is reached by manual head-with-delegates creation and by the standalone-shaped create flow, not by `ptyStartTeam`.

> **Superseded:** "If the surrounding block's `db` is already resolved from `_apiServerWorkspaceRoot`, assert that in a comment and change nothing; if it is not, resolve the wiring handle the same way as above. … Verify which root that block's `db` comes from before editing — do not assume."
> **Reason:** The improve pass performed that verification, so the plan should carry the answer, not the instruction to go find it. `handlePtyVerb` is `async (verb, payload, root?, signal?)` (`:2763`) where `root` is the **caller-supplied** `wsRoot` from the HTTP rail (`:3150`), and `:3026` reads `const db = await this._getKanbanDb(root || effectiveRoot);`. It is a confirmed divergence, and a wire caller controls it. The sibling line at `:3035` already resolves the *rename rewrite* against `this._apiServerWorkspaceRoot || root || effectiveRoot` for precisely this reason, with a comment saying so — the wiring call three lines later was simply missed.
> **Replaced with:** a definite change, below.

- **Logic:** Resolve a distinct fleet-root handle for wiring and pass it to `wireSpawnedTeam`: `const wiringDb = await this._getKanbanDb(this._apiServerWorkspaceRoot || effectiveRoot);`. Drop `root` from that expression — a caller-supplied `workspaceRoot` must not steer where a fleet's orders land, exactly as the rename rewrite already refuses to let it steer where a rewrite lands.
- **Implementation:** Do **not** repoint the existing `db` at `:3026` — it is also the argument to `updateMirrorRegistry(db)` at `:3027`, which is unrelated state and out of scope. Keep `db` for the `&& db` liveness guard on the wiring branch if you like, but pass `wiringDb` into `wireSpawnedTeam`. Mirror the comment style of `:3029-3033` so the next reader sees the two roots are deliberately different. Both writers must be changed in the same commit: a team started one way must get orders the other way can read.
- **Edge cases:** `wiringDb` undefined (fleet root unusable) → set `result.wiringError` through the existing `!wired.ok` branch at `:3063` rather than throwing; terminals are already real and must not be rolled back. `root` absent (the common case) → `effectiveRoot` was already the value used, so behaviour is unchanged.

### `src/standalone/bootstrap.ts` — `wireSpawnedTeam` call (`:1367`)

- **Context:** The standalone host is single-root, and its delivery path reads orders from that one `db` closure (`:301`). The divergence cannot arise today. A comment at `:1325-1329` already states the one-root property, but it sits on the `findTeamForHeadRole` block above and does not obviously govern the wiring call forty lines below. The in-process instantiator (`:2122-2131`) captures the same single `db` and is likewise safe.
- **Logic:** No behavioural change. Add a one-line comment at the `wireSpawnedTeam` call stating that this host has exactly one root, so the fleet root and spawn root are the same value by construction, and cross-referencing the extension host's split. This is the note that stops a future multi-root standalone from re-acquiring the bug invisibly.
- **Implementation:** Comment only. Do not add a `_apiServerWorkspaceRoot`-shaped field here; inventing a second root concept in a single-root host is the kind of speculative generality that rots.

### `src/services/standingOrders.ts` — `applyStandingOrders` (`:166`)

- **Context:** Returns `cleanPrompt` unchanged at `:186` when `selectOrders` yields nothing, with no signal. That silence is why this defect survived a full feature cycle.
- **Logic:** When `mine.length === 0` **and** `targetName` appears in any passed `groups[].members`, log once: the target name, the count of orders considered, and the `parent`/`child`/`scope` of each rejected order. A terminal that belongs to a registered team and gets zero orders is always a bug.
- **Implementation:** A `console.warn` only — **no UI, no toast, no status surface.** Gate on team membership, not on `orders.length > 0`: a standalone terminal with no orders is normal and must stay quiet. Log names and scopes only — never `instruction` bodies, which carry operator prose. Keep the function pure otherwise; it is called on every prompt.
- **Edge cases:** Empty `groups` → the guard is false, nothing logs, no noise. A target in a group but with zero orders anywhere in the DB → still logs, correctly: that is the wrong-DB symptom. A head excluded from its own `team` order by the `:117` rule but holding a `team-head` order → `mine.length > 0`, no log.

## Verification Plan

1. In a multi-root window whose board-selected root is **not** the API-server root, start a team whose definition lives in a third root. Read `terminals.standingOrders` from **the API-server root's** DB — the `team`, `team-head`, and pair rows are there. Read the same key from the definition root and the spawn root — unchanged.
2. Send a prompt to a member of that team. The delivered text carries a `=== STANDING ORDERS ===` block naming the head. Before this change the same send is bare.
3. Send a prompt to the head. It carries the `team-head` order and **not** the member order (`selectOrders` `:117` exclusion still holds).
4. Start a team in a single-root window. Orders land exactly where they do today — this change is a no-op when the roots coincide.
5. Start a team from a **worktree** (`worktreePath` set, so `spawnCwd` is the worktree). The terminals come up in the worktree; the orders land in the fleet root, not in the worktree's `.switchboard/`.
6. Create a head with delegates via `ptyCreateTerminal` (not `ptyStartTeam`), **passing an explicit `workspaceRoot` on the HTTP call that differs from the API-server root**. Its orders land in the same DB as a `ptyStartTeam` team's — the caller-supplied root no longer steers them, and the two writers agree.
7. Restart a team that currently has orders stranded in a non-fleet root. A correct set appears in the fleet root; the stranded rows are still present and untouched in the other root.
8. Under `npx switchboard`, start a team and send to a member. The block is delivered — the standalone host is unchanged.
9. **Latch check (the watchdog path).** With a team running, switch the board to a different workspace root, then force an API-server restart (kill the server so the liveness watchdog re-invokes `_startLocalApiServer`). Send to a team member: the block is still delivered, because `_apiServerWorkspaceRoot` did not move. Before the latch, the same sequence delivers a bare prompt.
10. Send to a terminal that belongs to no group and has no orders. Nothing is logged — the diagnostic does not fire on the normal case.
11. **Diagnostic check.** Point a team's orders at the wrong root by hand (or start a team, then move its rows), then send to a member: exactly one `console.warn` names the target, the considered count, and the rejected orders' parent/child/scope — and no `instruction` text appears in the log.

> **Superseded:** step 9, *"Point `_apiServerWorkspaceRoot` at a root with no `.switchboard/` and start a team. The start reports a wiring error rather than silently writing to the spawn root."*
> **Reason:** Not reachable by any operator action. `_apiServerWorkspaceRoot` derives from `_getWorkspaceRoot()`, which only ever returns a registered workspace folder, so the state under test cannot be produced from the UI. It is a unit-test assertion, not a manual verification step, and it was displacing the step that actually matters.
> **Replaced with:** the latch/watchdog check above (new step 9). The unusable-root branch is covered by the automated tests below.

> **Superseded:** step 10, *"With the roster plan landed, send to a team member that has no pair order (the intern). It receives the **team-scoped** order — the case that produced this report."*
> **Reason:** This step asserts a green this plan cannot deliver. The roster plan **has** landed, and the intern still will not receive the order: `team_lead_1`'s registered `members` array is `['lead-1','lead-1-coder-1','lead-1-coder-2','lead-1-coder-3']` — measured, no intern — and `wireSpawnedTeam`'s group registration skips when the id already exists (`teamWiring.ts:1015`), so restarting the team never refreshes it. `selectOrders`'s team branch (`:118`) then returns false for `lead-1-intern` regardless of which DB the order sits in. Leaving the step in produces exactly the failure mode this codebase keeps hitting: a plan whose own success check certifies a fix that did not happen.
> **Replaced with:** nothing here — the roster-staleness defect is recorded in `## Outstanding Questions` for its own plan. This plan's member-delivery claim is verified by steps 2 and 6 against a team whose roster is current.

### Automated Tests

- A test asserting `instantiateAgentGroup` resolves the wiring DB from `_apiServerWorkspaceRoot` and the spawn `cwd` from its `workspaceRoot` argument — two distinct resolutions, one function.
- A test asserting the wiring DB falls back to the spawn root when `_apiServerWorkspaceRoot` is unset (no regression for a host without an API server).
- A test asserting `instantiateAgentGroup` returns `'Kanban DB not ready'` when the **fleet-root** handle is unusable, even though the spawn-root handle is fine — the branch that manual verification cannot reach.
- A test asserting `_startLocalApiServer` called twice with two different `_getWorkspaceRoot()` values leaves `_apiServerWorkspaceRoot` at the **first** value — the latch, stated as a contract so a future refactor cannot quietly un-pin it.
- A source-shape assertion that both extension-host `wireSpawnedTeam` call sites (the `handlePtyVerb` create block and the `instantiateAgentGroup` funnel) resolve their wiring DB from `_apiServerWorkspaceRoot`, and that neither passes a caller-supplied `root` into that expression. The divergence is invisible at runtime in a single-root workspace, which is where it will be tested.
- A `selectOrders` test asserting a target in `groups[].members` with zero matched orders triggers the warn, and a target in no group does not; plus an assertion that the logged text contains no `instruction` body.
- Re-run `standing-orders-marker-contract.test.js` and `team-autostart-workspace-scope.test.js` unchanged — the marker contract, the `{head}` substitution, and the `wireSpawnedTeam` groupId return contract must all still hold.

> **Superseded:** *"A `wireSpawnedTeam` test asserting orders and the group registration are written through the **same** `db` handle — they must never split across roots."*
> **Reason:** It asserts the opposite of the shipped design, so it would fail on correct code. `mutateTerminalGroups` (`teamWiring.ts:127-141`) prefers `settings` over `db` whenever an accessor is supplied, and all four production callers supply one — so on both hosts the group registration deliberately does **not** go through `db`. Locking in "same handle" would freeze a contract the codebase does not have and would block the scoped-settings path.
> **Replaced with:** the source-shape assertion above, which pins what actually matters — the two **order**-writing sites agreeing on the fleet root — and no assertion about the group write, which this plan does not touch.

## Outstanding Questions

- **[user]** `wireSpawnedTeam`'s group registration is skip-if-id-exists (`teamWiring.ts:1015`), so a team whose membership changes after its first start keeps a stale `members` array forever — measured live: `team_lead_1` holds head + three coders and has never picked up `lead-1-intern`. Every team-scoped order is then invisible to seats added after the first start, including the intern that produced this report. Should this become its own plan (upsert the roster's `members`/`order` on re-run rather than skipping), or does it fold into a broader roster-lifecycle plan? — proceeding on the assumption that it is a **separate plan**: it is a distinct root cause in a distinct function, this workflow is single-plan and non-destructive, and adding it here would make the change three unrelated fixes in one commit. This plan is written so it neither depends on nor claims that fix.

**Recommendation: Send to Coder** (complexity 6).

## Completion Report

Implemented fleet root alignment for standing orders and zero-match diagnostic logging. Latched `_apiServerWorkspaceRoot` on first start in `TaskViewerProvider.ts` to prevent watchdog server restarts from drifting the fleet root, and updated both extension-host wiring sites (`instantiateAgentGroup` and `handlePtyVerb` create block) to write standing orders to `_apiServerWorkspaceRoot || resolvedRoot`/`effectiveRoot`. Added diagnostic `console.warn` in `standingOrders.ts` when a registered group member matches zero standing orders without logging instruction text, and added documentation in `bootstrap.ts`. Files changed: `src/services/TaskViewerProvider.ts`, `src/services/standingOrders.ts`, `src/standalone/bootstrap.ts`, and `.switchboard/plans/standing-orders-land-in-the-fleets-own-database.md`. No issues encountered during implementation.
