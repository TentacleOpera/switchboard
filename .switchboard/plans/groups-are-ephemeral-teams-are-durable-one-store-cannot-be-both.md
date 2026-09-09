# Groups Are Ephemeral, Teams Are Durable — One Store Cannot Be Both

## Goal

Make a group behave the way it is meant to: **an impromptu arrangement that disappears when its
terminals are gone.** A group is removed when its terminals exit mid-session or die with a crash. A
clean maintenance restart preserves a group **if its seats survive the restart** — groups ride the
same adoption path as the fleet. Teams keep their durable roster. FILL GRID is the button that
creates a group — one press, N seats — so groups are cheap to make and need no saving.

Today groups outlive everything. The one on this board was saved on **2026-08-19** (id timestamp
`1787110009160`) — three weeks ago. It still holds seats that have been destroyed and recreated many
times since, and still adopts any terminal that happens to reuse one of its member names.

### Problem analysis

**Groups and teams share one durable store, told apart only by an id prefix.** Both live in
`switchboard.prompts.terminals.groups`, and `terminals.js:1406` classifies a row as a team with
`g.id.startsWith('team_')`. A row is otherwise the same shape.

Live board, both kinds side by side:

```
grp_1787110009160_5vm0z  "Planners"  source manual  members [planner-1..4, "Lead team"]
team_Coding              "Coding"    teamGroup      head Coding, headRole lead
```

**Creation is a save, by name and by intent.** `saveCurrentAsGroup` (`terminals.js:3454`),
`saveSelectionAsGroup` (`:3596`), and the button itself — `>SAVE AS GROUP<`
(`terminals.html:2893-2894`). All three write to the durable key. Nothing about the path is temporary.

**There is exactly one way out, and an operator has to do it.** `deleteGroup(id)`
(`terminals.js:3487`) filters the row out. Beyond that:
- nothing removes a group at host start;
- nothing removes a group when its last terminal exits;
- nothing prunes a member whose terminal is gone. The only stale-member handling in the codebase is
  on the **team** path (`teamWiring.ts:1911`, "Replace stale members (not union)").

**Membership is by bare name, so a group re-adopts strangers.** `"Planners"` lists `planner-1`
through `planner-4` as strings. Start four planner seats today and they are silently absorbed into an
arrangement saved three weeks ago. The same list still contains `"Lead team"` — a name with **no live
terminal at all** (live fleet: `Coding`, `Coding-coder-{1,2}`, `Coding-intern`, `planner-1..4`).
That name exists because `agentGroupInstantiation.ts:150` falls back to the definition's name for the
head terminal (`result.terminal?.friendlyName || group?.name`), so starting the `feature-implementation`
definition created a terminal called `Lead team`, which was then saved into this group.

**Why this matters beyond tidiness.** A group that cannot die is not impromptu — it is a second,
worse kind of team: no head, no role, no roster discipline, and it renders in the same list as the
real thing. The phantom `team_` rows (see the blocker in
`two-teams-can-share-a-head-role-and-routing-decides-between-them.md`) and these immortal `grp_` rows
are the same list behaving as two different objects.

### Three row kinds, not two (clarification)

The store actually holds **three** shapes, and this plan targets only one of them:

- `team_…` — **teams** (`teamGroup: true`, `teamKind: 'spawned'`). Durable roster, written by
  `wireSpawnedTeam` (`teamWiring.ts`). Out of scope; unchanged.
- `grp_…` — **manual groups** (`source: 'manual'`). The operator-saved arrangements this plan kills.
  Created only by `saveCurrentAsGroup` / `saveSelectionAsGroup` (`terminals.js:3454`, `:3596`).
- `dg_…` — **derived groups** (`source: 'role'` / `'worktree'`, ids from `safeGroupIdForValue`
  `terminals.js:3708`). Already session-scoped: computed live from `fleetList` by `getDerivedGroups`,
  never operator-saved. **Already ephemeral — out of scope.** Change 1 must not move them.

Every "group" below means a **manual `grp_` group** unless stated.

### Survival model — three kinds of restart, three outcomes

| | group seats | group state | outcome |
|---|---|---|---|
| terminal exits mid-session | killed (existing pty close) | member dropped by close hook | group shrinks; dies when last member goes |
| clean standalone shutdown + restart (maintenance) | **survive via adoption** | **restored from sidecar** | group survives IFF its seats survived |
| crash / SIGKILL | die (no adoption) | no sidecar written (or stale, ignored) | group gone |

The discriminator is **seat survival, not restart kind.** "Maintenance" vs "I'm done" is hard to tell
apart at shutdown time — both are clean shutdowns. So the group does not try. It lets adoption be the
signal: if the seats survive (maintenance case), the sidecar restores the grouping; if the seats are
gone (crash, or the close hook already fired), the group is already dead.

## Metadata

**Complexity:** 6
**Tags:** terminals, groups, teams, lifecycle, refactor
**Dependencies:** `switchboard-stop-tears-down-the-host-and-leaves-the-process-running` — **the sidecar
write must not land first.** The `/shutdown` path today accepts, stalls partway, and latches so no
retry can finish it (`Surviving handles at forced exit (8): [...,"ProcessWrap",...]`, that
ProcessWrap being a pty host). Writing a sidecar to a teardown that cannot already close its own
handles risks a partial write. Also `the-pty-host-should-outlive-the-board-not-die-with-it` —
**adoption is what makes the sidecar useful.** Without it, seats die on restart, the sidecar points
at dead names, and groups die anyway (degrades gracefully to "groups die on every restart"). The
sidecar is forward-compatible: harmless until adoption lands, then preserves groups. Also the FILL
GRID plans already in review — `fill-grid-refuses-a-second-grid-of-the-same-role`,
`fill-grid-displaces-other-terminals`, `ungrouped-terminals-get-their-own-grid`, `fill-grid-default-2x2`.
FILL GRID becomes the group-creation path, so its behaviour and this lifecycle must agree.

## User Review Required

None. All decisions resolved:
- `SAVE AS GROUP` removal — operator intent, verbatim: *"save as group was intended to group
  terminals together but was done before the grid fill and teams, so is outdated. all I want now is
  fill grid and teams."* Change 6 carries the removal.
- Group survival across maintenance restarts — operator chose **option 2**: groups survive a clean
  restart IFF their seats survive adoption (sidecar + intersection with live fleet). Crashes wipe
  them. The standalone `/shutdown` path does NOT kill group seats — they ride the adoption path.
  This is the design below.

## Complexity Audit

### Routine
- Removing the `SAVE AS GROUP` button + `saveCurrentAsGroup` / `saveSelectionAsGroup` (change 6) —
  pure deletion of a known surface, `selectedTerminalNames` retained.
- Dropping legacy `grp_` rows on first start (change 1 migration) — a one-time filter on the durable
  array.
- Panel rendering teams and groups as distinct sections (change 5) — the webview already has
  `isSpawnedTeamGroup` and `source` to discriminate; this is a render-time sort/section.

### Complex / Risky
- **Change 1's ownership migration + sidecar.** Today the **webview** owns the `terminalGroups`
  array and persists it via `saveSetting('terminals.groups', …)` (`terminals.js:2007`); teams are
  written to the DB directly by `teamWiring.ts`. Moving manual groups to host-held in-memory state
  means the webview stops saving `grp_` rows and instead calls host verbs to create/list/delete them.
  The sidecar adds a second persistence surface: written on clean standalone `/shutdown`, read on
  start, intersected with the live adopted fleet. This is a new pattern (host-owned session state
  with a crash-safe sidecar), not a localized edit.
- **Change 2's restore intersection.** On a clean start, every sidecar group's members must be
  intersected with the live adopted fleet. A member that survived adoption is restored; one that did
  not is dropped. This runs after the adoption probe completes, not before — ordering matters.
- **The new seam.** Splitting the store leaves two group stores (host in-memory + sidecar for `grp_`,
  durable DB for `team_`). Without a single typed accessor, `isSpawnedTeamGroup`'s prefix-test ghost
  reincarnates as "is this row in host memory?".

## Edge-Case & Dependency Audit

- **Race Conditions.** The webview saves the WHOLE in-memory `terminalGroups` array
  (`terminals.js:2007`); a stale read clobbers a concurrent team write — the reason
  `_groupsWriteChain` exists (`teamWiring.ts:612`). Once `grp_` rows leave this array, the whole-array
  save no longer races manual groups — but the host in-memory group store needs its own serialized
  mutation path (the same read-modify-write hazard applies to concurrent FILL GRID presses).
- **Security.** The sidecar is a 0600 credential-adjacent file (it names live seats). Same discipline
  as the pty-host state file: never in a repo, never in a log, never in a diagnostic dump.
- **Side Effects.** A stale sidecar from a crash must not resurrect dead groups. The restore path
  intersects with the live fleet, so a sidecar pointing at dead names produces empty groups that are
  immediately dropped — no resurrection.
- **Dependencies & Conflicts.** Hard dependency on the broken `switchboard-stop-tears-down-the-host`
  plan (sidecar write must not land first). Soft dependency on `the-pty-host-should-outlive-the-board`
  (adoption makes the sidecar useful; without it, groups die on every restart as today). Soft
  dependency on the FILL GRID sibling plans — change 4 makes FILL GRID the sole creation path.
  `deleteGroup` (`terminals.js:3487`) is retained (an operator still dismisses a live group without
  closing its terminals), so its `source === 'manual'` arm must read from the new host store, not the
  removed durable rows.

## Dependencies

- `switchboard-stop-tears-down-the-host-and-leaves-the-process-running` — the sidecar write must not
  land first (the `/shutdown` latch makes a partial write worse).
- `the-pty-host-should-outlive-the-board-not-die-with-it` — **soft dependency.** Adoption is what
  makes the sidecar useful. Without it, seats die on restart, the sidecar points at dead names, and
  groups die anyway (degrades gracefully to "groups die on every restart"). The sidecar is
  forward-compatible: harmless until adoption lands, then preserves groups.
- `fill-grid-refuses-a-second-grid-of-the-same-role`,
  `fill-grid-displaces-other-terminals`,
  `ungrouped-terminals-get-their-own-grid`,
  `fill-grid-default-2x2` — FILL GRID becomes the group-creation path (change 4); behaviour must
  agree.

## Adversarial Synthesis

Key risks: (1) splitting the store creates a *new* "which store holds this row?" seam unless every
reader goes through one typed accessor; (2) the sidecar is a new persistence surface that must be
crash-safe — a partial write on a stalled `/shutdown` corrupts the restore; (3) the restore
intersection must run *after* the adoption probe completes, or it intersects with an empty fleet and
drops every group; (4) the sidecar is forward-compatible but useless without adoption, so an
implementer who lands it first sees no benefit and may conclude the mechanism is broken.
Mitigations: a single typed accessor for the host in-memory store; the sidecar write is gated on the
`switchboard-stop` fix landing first and writes atomically (temp file + rename); the restore path
awaits the adoption probe before intersecting; the soft dependency on the pty-host adoption plan is
documented so the implementer knows the sidecar is inert until adoption ships.

## Proposed Changes

### 1. Groups stop sharing the teams store

- **Logic:** teams keep `switchboard.prompts.terminals.groups`. Manual groups move to
  **host-process in-memory session state** (not the durable config DB), held by the host for the life
  of the process and surfaced to the webview via new verbs (create / list / delete / add-member /
  remove-member). Derived `dg_` groups are untouched — they are already computed live from the fleet.
- **Sidecar.** On a clean standalone `/shutdown`, the host writes the group state to a
  **workspace-scoped sidecar file** (0600, same discipline as the pty-host state file — never in a
  repo, never in a log, never in a diagnostic dump). The sidecar is NOT the durable config DB — it
  keeps the separation from teams. On start, the host reads the sidecar and intersects each group's
  members with the live adopted fleet (change 2).
- **Implementation:** prefer a separate store over a `durable: false` flag on the same rows. A flag
  leaves every reader responsible for honouring it, and `terminals.js:1401`'s prefix test shows what
  happens when one list means two things. The webview's `terminalGroups` array stops carrying `grp_`
  rows; `saveLayoutSettings` (`terminals.js:1997`) stops persisting them via
  `saveSetting('terminals.groups', …)` (`:2007`). A single typed accessor owns the host in-memory
  store — no reader may prefix-test against it (see Goal Invariants).
- **Migration:** existing `grp_` rows are dropped on first start after this lands (filter the durable
  array by `!id.startsWith('grp_')` on load, one time). They are arrangements, not data — and every one
  currently outlives its terminals anyway.

### 2. Groups survive a maintenance restart, die on a crash

- **Logic:** on a crash or SIGKILL, no sidecar is written (or a stale one is ignored), so the host
  in-memory group store starts empty. On a clean start, the store is **restored from the sidecar**,
  intersected with the live adopted fleet — a member that survived the restart is restored; one that
  did not is dropped. A group whose every member died is not restored. No reconciliation of dead
  names, no adoption of strangers.
- **Ordering.** The restore intersection runs **after** the adoption probe completes (the pty-host
  adoption path). Intersecting with an empty fleet drops every group; intersecting after adoption
  restores the ones whose seats survived.
- **Extension host.** Extension `deactivate` is effectively a crash for group purposes: the
  parent-death watcher kills seats (`main.go:596-608`, per the pty-host plan), and `deactivate()`
  never calls `supervisor.stop()` (`extension.ts:4594`). The sidecar is written on the standalone
  `/shutdown` path only. Extension restart degrades to "groups die on restart" — the current
  behaviour — until the pty-host plan wires adoption in both roots. Acceptable: extension restart is
  rare (reload window, upgrade) and groups are scaffolding.

### 3. A group dies with its terminals

- **Logic:** when a terminal exits, drop it from any group it belongs to (host-side, on the path
  that determines `status === 'exited'` — not the webview's operator-initiated `closeTerminal`
  (`terminals.js:9948`), which is only one of two exit paths). When a group's last member goes, the
  group goes. Teams are unaffected — a team's roster is its definition, not its live seats.
- **No shutdown kill.** The standalone `/shutdown` path does **not** kill group seats. Seats survive
  via adoption (the pty-host-outlives-board plan), and the group rides the same survival via the
  sidecar (change 2). Killing group seats on shutdown would be mutually exclusive with preserving
  groups across maintenance restarts — the operator chose preservation.

| | clean shutdown (standalone) | crash / SIGKILL |
|---|---|---|
| group seats | survive via adoption | die (no adoption) |
| group state | restored from sidecar | gone (no sidecar) |
| team seats | survive | survive → reattached |

- **Why not "forget the grouping and leave them running":** that is not a third option. Those seats
  then belong to no group, and the startup reaper kills `lc-*` sessions the host does not own — so
  they die at the next start anyway, less predictably, after a window of burning RAM and CPU owned by
  nothing. Measured example: 8 orphaned seats holding ~1.5 GB RSS across two host restarts.
- **Report what was killed.** When the close hook drops a member, name it. Silence is what made the
  orphan incident hard to reconstruct.
- **Edge case:** a team member that is also in a group (today possible, since both are name lists)
  must not take the team row with it when it exits. The close hook touches only the host in-memory
  group store, never the durable team rows.

### 4. FILL GRID is the only way a group is created

> **Superseded:** FILL GRID creates the group as part of starting the seats (implying it already does).
> **Reason:** `fillGrid` (`terminals.js:9750`) creates **no group today** — it calls
> `createTerminalsForRole` + `fillEmptyPanes` and never pushes a `grp_` row. The plan's earlier claim
> that "today there are three creation paths (`saveCurrentAsGroup`, `saveSelectionAsGroup`, FILL
> GRID)" was wrong: there are **two** group-creation paths today (the two save functions); FILL GRID is
> a terminal-creation path. Change 4 is **net-new creation logic**, not a redirect.
> **Replaced with:** FILL GRID gains net-new logic that creates a manual group (in the host in-memory
> store, via the new create verb) as part of starting the seats, so "make a group" is one press and
> never needs a save step. Name the group from the role and index (`Planner 1`, `Planner 2`) — the
> shape the fill-grid plans already assume.

- **Consequence:** with change 6 there is exactly one creation path. Today there are two
  (`saveCurrentAsGroup`, `saveSelectionAsGroup`); after this change there is one (FILL GRID).

### 5. The panel lists teams and groups as different things

- **Logic:** two sections, or an explicit kind on each row — not one array filtered by id prefix. A
  reader must never have to know that `team_` is load-bearing. The webview already has
  `isSpawnedTeamGroup` (`terminals.js:1401`) and `source` to discriminate; this is a render-time
  sectioning, and the host in-memory store's typed accessor is the single read path for manual groups.

### 6. Remove `SAVE AS GROUP` — it predates FILL GRID and teams

- **Logic:** the button exists because there was once no other way to group terminals. FILL GRID now
  creates groups and teams carry durable rosters, so a third mechanism that saves an arrangement
  forever is the source of every immortal `grp_` row on the board.
- **Removal surface** (verified, line numbers refreshed to current source):
  - `terminals.html:2893-2894` — `id="btn-save-group"`, `>SAVE AS GROUP<`
  - `terminals.js:3454` `saveCurrentAsGroup`, called from `:902`
  - `terminals.js:3596` `saveSelectionAsGroup`, called from `:5161`
  - the provenance comment at `terminals.js:8956-8958` ("operator-saved groups use `grp_` … must NOT
    trigger a crown — both carry `source: 'manual'`, so the ID prefix is the only discriminator") and
    the note at `teamWiring.ts:629` ("Manual groups use 'grp_' prefix") — both become stale
  - *(the plan's earlier citation `terminals.js:8893` was wrong — that line is blank / a team-head
    comment; the real provenance comment is at `:8956-8958`.)*
- **Keep:** `selectedTerminalNames` (`terminals.js:126`) is the sidebar's multi-select and is used
  well beyond this button (`:3158`, `:3384`); do not remove it with the save path.
- **Keep:** `deleteGroup` (`terminals.js:3487`) — an operator still needs to dismiss a live group
  without closing its terminals. Its `source === 'manual'` arm must read from the new host in-memory
  store.

## Verification Plan

### Automated Tests

- `test:contract:groups-are-ephemeral` (new): a group created in-process is absent after a **crash**
  restart; a team created the same way is still present.
- A group created in-process is **restored** after a clean standalone shutdown + restart, IFF its
  seats survived adoption. Assert on the restored group's members intersected with the live fleet.
- A group whose seats did NOT survive adoption is not restored (sidecar points at dead names →
  empty group → dropped).
- Closing a group's last terminal removes the group; closing one of several removes only that member.
- Closing a terminal that belongs to a team does **not** remove the team row.
- A seat in both a team and a group: exiting it drops it from the group but leaves the team row intact.
- No group may hold a member name with no live terminal (the `"Lead team"` case).

### Goal Invariants

- After a **crash** start, the host in-memory group store is empty and the durable
  `switchboard.prompts.terminals.groups` array is unchanged (no `grp_` rows remain after migration).
- After a **clean** start with adoption, groups are restored from the sidecar intersected with the
  live adopted fleet — a member that survived is present, one that did not is absent.
- The restore intersection runs after the adoption probe completes (assert: the fleet is non-empty
  when the intersection runs on a clean start with surviving seats).
- For every group in the host in-memory store, every member name resolves to a live terminal.
- The rendered terminals panel shows zero manual groups after a crash restart (assert on the rendered
  list, not on the DB — a stale in-memory copy could otherwise pass a DB-only check).
- No reader of the host in-memory group store prefix-tests row ids; all access goes through the
  single typed accessor (assert: grep the new store's read sites for `startsWith('grp_')` → none).
- The sidecar is workspace-scoped, 0600, and never appears in logs or diagnostic dumps.
- `tmux ls` shows no `lc-*` session belonging to a group that no longer exists (ties to the reaper in
  `tmux-windows-duplicate-on-re-seat-and-nothing-reaps-orphaned-sessions.md`).

### Manual

1. FILL GRID four planners → one group, four seats.
2. Close all four → group gone from the panel.
3. FILL GRID four planners again → a **new** group, not the old one re-adopting the names.
4. Crash the host (SIGKILL) → no groups on next start; the Coding team is still there with its roster.
5. Clean standalone `/shutdown` + restart (with adoption landed) → group restored, seats reattached.

## Resolved Assumptions

- **External readers of `grp_` rows.** Resolved by code this session: `KanbanProvider`
  (`KanbanProvider.ts:5160` et al.) and `TaskViewerProvider` (`:1225`) read
  `switchboard.prompts.terminals.groups` but filter by `templateId` / team fields — they do **not**
  consume `grp_` manual rows. `teamWiring.ts`'s 17 reads are all team-path. Moving `grp_` out of the
  durable store breaks no external reader.
- **FILL GRID creates no group today.** Resolved: `fillGrid` (`terminals.js:9750`) calls
  `createTerminalsForRole` + `fillEmptyPanes`; it never pushes a `grp_` row. Change 4 is net-new.
- **`POST /shutdown` is standalone-only.** Resolved: `LocalApiServer.ts:857` — the extension root
  declares `shutdown.enabled: false` with no callback. The sidecar is written on the standalone
  `/shutdown` path only; extension `deactivate` degrades to "groups die on restart."
- **Persistence model.** Resolved: the webview's `terminals.groups` setting resolves to the same
  durable `switchboard.prompts.terminals.groups` DB key (via `loadSetting`/`saveSetting`,
  `terminals.js:1733`/`:1751`). Teams are written to the DB by `teamWiring.ts`; manual groups by the
  webview via `saveLayoutSettings` (`:2007`).
- **Pty-host adoption interaction.** Resolved: standalone `/shutdown` today kills seats via the
  parent-death watcher (`main.go:596-608`, per the pty-host-outlives-board plan). The sidecar is
  forward-compatible — useless until adoption lands, then preserves groups. Soft dependency, not
  hard: the sidecar degrades gracefully to "groups die on every restart" without adoption.

## Outstanding Questions

- **[follow-up, out of scope]** `agentGroupInstantiation.ts:150` falls back to `group?.name` for the
  head terminal's friendly name, so starting the `feature-implementation` definition spawned a terminal
  literally called `Lead team` — which an operator then saved into a manual group. The lifecycle fix
  here handles the symptom (the group dies with its terminals); the `group?.name` fallback is a
  separate bug worth its own plan. Proceeding on the assumption that it is not blocked on this one.

## Implementation Summary

Separated manual ephemeral groups (`grp_`) from durable teams store (`switchboard.prompts.terminals.groups`) by implementing `ManualGroupStore` as in-memory host session state. Wired host verbs (`ptyCreateGroup`, `ptyListGroups`, `ptyDeleteGroup`, `ptyAddGroupMember`, `ptyRemoveGroupMember`) across both composition roots (`TaskViewerProvider.ts` and `bootstrap.ts`) and hooked terminal exits to evict members and reap empty groups. Added 0600 sidecar serialization (`.switchboard/manual-groups-sidecar.json`) on clean standalone `/shutdown` with fleet-intersection restoration on boot, and retired `SAVE AS GROUP` and selection group buttons while making `fillGrid` the sole group creation path.

