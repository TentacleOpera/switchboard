# Team Picker Shows a Phantom Member-less "Lead team" — the Two Team Verbs Resolve One Root and Seed Into It

## Goal

Make `ptyListAgentGroups` and `ptyStartTeam` resolve team definitions from the same workspace root the TEAMS tab **writes** to, and make the list verb read-only so it stops minting a phantom team into unrelated workspace databases. After this change the terminals panel lists the operator's real teams with their real member counts, and START spawns the head **and its members**.

### Problem analysis and root cause

**Reproduced live, not inferred.** Three facts, gathered from this machine on 2026-08-16:

1. The board's selected workspace DB holds the operator's real team:

   ```
   $ sqlite3 /Users/patrickvuleta/Documents/GitHub/switchboard/.switchboard/kanban.db \
       "select value from config where key='terminals.agentGroups';"
   [{"id":"group-coding-msvplbf4","name":"Coding","headRole":"lead",
     "members":[{"role":"coder","count":3,"scope":"per-team","relationship":"reports-to-head"},
                {"role":"reviewer","count":1,"scope":"shared","relationship":"reviewer"}], ...}]
   ```

2. The live API returns something else entirely:

   ```
   $ curl -s -X POST http://127.0.0.1:50065/terminals/verb/ptyListAgentGroups -d '{}'
   {"success":true,"groups":[{"id":"feature-implementation","name":"Lead team","headRole":"lead","members":[]}]}
   ```

3. That row physically exists — in a **different** workspace's database:

   ```
   $ sqlite3 /Users/patrickvuleta/Documents/Gitlab/.switchboard/kanban.db \
       "select value from config where key='terminals.agentGroups';"
   [{"id":"feature-implementation","name":"Lead team","headRole":"lead","members":[]}]
   ```

So the panel is not mis-rendering a team that has members. It is faithfully rendering a **different team** — `SEEDED_AGENT_GROUP` (`teamWiring.ts:121-126`), the shipped member-less starter — read out of a database the operator never authored teams in. Both reported symptoms fall out of that one fact:

| Symptom | Mechanism |
| :--- | :--- |
| "they say no members even though the team has members assigned" | `teamSpawnSummary` (`terminals.js:6200-6204`) renders `head only` for the seeded team's empty `members`, and the role-option annotation renders `heads Lead team (no members)` (`terminals.js:6319-6323`). Both strings are correct **for the object they were handed**. |
| "the start team button starts the lead with none of its team members" | `ptyStartTeam` resolves `teamId` from the **same** wrong DB. `resolveTeamById` finds the seeded `feature-implementation` row there, `startTeamById` hands it to the instantiator, and a zero-member definition spawns exactly one lead. |

**Root cause 1 — the two team verbs consult one root; the writer uses another.**

`TaskViewerProvider._teamLookupRoots` (`:8805-8821`) exists for precisely this divergence, and its own comment states it:

> The TEAMS tab writes `terminals.agentGroups` into the BOARD'S SELECTED workspace (`KanbanProvider.saveAgentGroup` → `_resolveWorkspaceRoot`), while every terminals route resolves DBs against the PINNED API-server root (`LocalApiServer._options.workspaceRoot = effectiveRoot`). In a multi-root window those are different folders, so a lookup that consults only the pinned root reads a kanban.db that has never held the key.

That helper is wired into exactly **one** call site — the auto-start branch of `ptyCreateTerminal` (`TaskViewerProvider.ts:2696-2701`). The two verbs added later by the explicit-team-start work never got it:

- `ptyListAgentGroups` (`TaskViewerProvider.ts:2582-2587`): `listAgentGroups(root || effectiveRoot)` — one root.
- `ptyStartTeam` (`TaskViewerProvider.ts:2591-2631`): `const wsRoot = root || effectiveRoot;` then `this._getKanbanDb(wsRoot)` — one root.
- Standalone twins at `bootstrap.ts:1161-1166` and `:1168-1199` — one root (correct there; that host is single-root).

The multi-root fix shipped for the implicit path and was never applied to the explicit path built on top of it. The regression test that pins the implicit fix — `src/test/team-autostart-workspace-scope.test.js` — asserts `findTeamForHeadRoleInRoots` and the `ptyCreateTerminal` call site only, so it passes at HEAD while the verbs beside it are broken.

**Root cause 2 — a read verb writes. `listAgentGroups` seeds and persists.**

`KanbanProvider.listAgentGroups` (`:4517-4524`) delegates to `_loadAgentGroups` (`:4445-4508`), which runs inside `_mutateAgentGroups` and, when the key is absent, **seeds `[SEEDED_AGENT_GROUP]` and writes it back** (`:4470-4474`, persisted at `:4438`). So opening the role picker in a window pinned to a boardless root does not merely read nothing — it *creates* the phantom `Lead team`, persists it, and then serves it. That is how `/Users/patrickvuleta/Documents/Gitlab/.switchboard/kanban.db` acquired a row for a workspace whose TEAMS tab was never opened. It also means the defect is self-perpetuating: after the first picker open, the wrong root is no longer "empty", it is "populated with a wrong answer".

Seeding on load is correct for the TEAMS tab (that is where a starter team belongs). It is wrong for a read-only list verb.

**Blast radius.** Both fixes are additive to the resolution path; no team definition is edited, deleted or moved. The auto-start path is untouched. Its own test file gains cases rather than changing.

## Metadata

**Complexity:** 5
**Tags:** bugfix, backend, reliability
**Project:** Browser Switchboard

## Complexity Audit

### Routine

- Threading `_teamLookupRoots` into two more call sites in the same file that already uses it.
- Adding a read-only sibling to `listAgentGroups`.
- Extending an existing contract test file with cases in its established style.

### Complex / Risky

- **The list and the start must agree on the same root, or the bug changes shape instead of ending.** If the picker lists teams resolved from root A and START resolves the id against root B, the operator gets `No team found with id 'group-coding-msvplbf4'` — a *new* failure that reads like a corrupt board. The two verbs must derive their candidate list identically and the start must resolve against the candidate list, not against a single re-derived root.
- **A phantom seed already exists on disk in at least one install (this one).** Once the list verb stops seeding, the rows it already wrote remain. `_teamLookupRoots` ranks the board's selected root above the pinned root, so the phantom is out-ranked in the common case — but it is still candidate #1 whenever the operator opens the picker from that workspace's `+` (`payload.cwd` admitted first, `:8816-8817`). A candidate whose entire team list is an untouched auto-seed carries no operator intent and must not shadow a root that has real definitions.
- **"Untouched seed" must be an exact-value test, never a heuristic.** A member-less team an operator *authored* is legitimate and must be listed and startable. The file already has the correct idiom for this — `isUntouchedOldSeed` (`teamWiring.ts:368-393`) compares every field and rejects on any extra key. The new predicate must be built the same way, against `SEEDED_AGENT_GROUP`, or it will silently swallow real teams.
- **Spawn cwd and definition root are two different things and must stay separate.** `startTeamById(opts.workspaceRoot)` is the **spawn** directory (`TaskViewerProvider.ts:2607` deliberately computes `spawnCwd` from `payload.cwd`/`parentRoot`). The definition root is a new, independent resolution. Collapsing them would make a team started from a worktree resolve its definition from a directory with no board at all.
- **Standalone is single-root and must not grow a fake multi-root.** `bootstrap.ts` has no `getCurrentWorkspaceRoot`, no workspace-roots list, and no `_filterMappedRoots` (verified: zero matches). Root cause 1 cannot occur there. Only root cause 2 applies. Mirroring the extension host's candidate walk into it would be inventing state that host does not have.

## Edge-Case & Dependency Audit

**Race Conditions** — `_mutateAgentGroups` serialises writes on `KanbanProvider._agentGroupsWriteChain` (`:4432-4442`). The new read-only path does not enter that chain, so a picker open concurrent with a TEAMS-tab save can read either side of the write. That is acceptable and strictly better than today: the current read *joins* the write chain and can persist a seed on top of a concurrent save's read.

**Security** — unchanged. Neither verb begins accepting a team definition from the wire; the `payload.group` rejection (`TaskViewerProvider.ts:2598-2600`, `bootstrap.ts:1174-1176`) stays. The candidate root list is still host-derived from mapped workspace roots (`_filterMappedRoots`, `:8813-8815`) — `payload.cwd` is admitted only when it is already a known root, which is the existing rule and must not be relaxed.

**Side Effects** —
- Teams that were invisible in the terminals panel become visible. That is the intent.
- A workspace pinned as the API root that has never had teams will no longer acquire a seeded row from a picker open. The TEAMS tab still seeds on its own load path, so the starter team still appears where it is meant to.
- Existing phantom rows are not deleted by this change. Deleting operator-reachable config rows is out of scope; the untouched-seed skip neutralises them for resolution, and the operator can delete them in the TEAMS tab.

**Migration** — none required. No stored shape changes; `terminals.agentGroups` is read and written in exactly its current form. The seed row is state that shipped, so it is skipped for resolution rather than deleted.

**Dependencies & Conflicts** — touches `src/services/TaskViewerProvider.ts`, `src/services/KanbanProvider.ts`, `src/services/teamWiring.ts`, `src/standalone/bootstrap.ts`, and extends `src/test/team-autostart-workspace-scope.test.js`. It does **not** touch `src/webview/terminals.js` or `src/webview/terminals.html`, so it can run concurrently with webview work on the terminals panel under the one-stream-per-file rule.

## Proposed Changes

### `src/services/teamWiring.ts` — an untouched-seed predicate and two root-walking resolvers

- **Context:** `findTeamForHeadRoleInRoots` (`:452-470`) is the host-free walker the auto-start path uses. The explicit path needs the same shape for "all teams" and "one team by id". `isUntouchedOldSeed` (`:368-393`) is the exact-value idiom to copy.
- **Logic:**

```ts
/**
 * True when a group is byte-for-byte the shipped starter (`SEEDED_AGENT_GROUP`)
 * — id, name, headRole, an empty members array, and no extra keys. Exact-value,
 * never heuristic: an operator-authored member-less team differs by at least one
 * field and must NOT match. Same construction as isUntouchedOldSeed above.
 */
export function isUntouchedSeed(group: any): boolean {
    if (!group || typeof group !== 'object') { return false; }
    if (group.id !== SEEDED_AGENT_GROUP.id) { return false; }
    if (group.name !== SEEDED_AGENT_GROUP.name) { return false; }
    if (group.headRole !== SEEDED_AGENT_GROUP.headRole) { return false; }
    if (!Array.isArray(group.members) || group.members.length !== 0) { return false; }
    const gKeys = Object.keys(group).sort().join(',');
    const sKeys = Object.keys(SEEDED_AGENT_GROUP).sort().join(',');
    return gKeys === sKeys;
}

/** A candidate root carries operator intent only if it has at least one team
 *  that is not the auto-seed. A root holding nothing but the seed must not
 *  shadow a root that holds real definitions — that is exactly how a phantom
 *  seeded row hid the operator's real team. */
function hasAuthoredTeams(groups: any[]): boolean {
    return Array.isArray(groups) && groups.some(g => g && !isUntouchedSeed(g));
}

/**
 * Read team definitions from the first candidate root that holds authored
 * teams, nearest-first. Migrates in memory (same guarantee as
 * findTeamForHeadRole / resolveTeamById) and NEVER writes — this is the read
 * path for the terminals panel, and a read must not seed.
 *
 * Returns `{ teams, root }`, or `{ teams: [], root: null }` when no candidate
 * holds authored teams. The caller decides what to show for the empty case.
 */
export async function listTeamsInRoots(
    roots: string[],
    getDb: (root: string) => Promise<any | undefined>
): Promise<{ teams: any[]; root: string | null }> {
    for (const root of roots) {
        let db: any;
        try { db = await getDb(root); }
        catch (err) { console.warn(`[teamWiring] Team list: DB unavailable for '${root}':`, err); continue; }
        if (!db) { continue; }
        try {
            const raw = await db.getConfigJson(AGENT_GROUPS_CONFIG_KEY, null) as any[] | null;
            if (!Array.isArray(raw) || !hasAuthoredTeams(raw)) { continue; }
            return { teams: migrateAgentGroups(raw) ?? raw, root };
        } catch (err) {
            console.warn(`[teamWiring] Team list: read failed for '${root}':`, err);
        }
    }
    return { teams: [], root: null };
}

/** The id-resolving twin. Walks the SAME candidate order as listTeamsInRoots so
 *  the team the picker listed is the team START resolves. Returns the matched
 *  db alongside the team so the caller does not re-open a second, different one. */
export async function resolveTeamByIdInRoots(
    roots: string[],
    getDb: (root: string) => Promise<any | undefined>,
    teamId: string
): Promise<{ team: any; root: string; db: any } | null> {
    for (const root of roots) {
        let db: any;
        try { db = await getDb(root); }
        catch { continue; }
        if (!db) { continue; }
        const team = await resolveTeamById(db, teamId);
        if (team) { return { team, root, db }; }
    }
    return null;
}
```

- **Edge Cases:** a root whose key is present but `[]` (the operator deleted every team) is skipped by `hasAuthoredTeams` and the walk continues — correct, since an empty array is indistinguishable in intent from "no teams here" for *resolution* purposes, and `resolveTeamByIdInRoots` (which does not gate on `hasAuthoredTeams`) still finds a team by id in any root that holds one.

### `src/services/KanbanProvider.ts` — a read-only peek beside the seeding load

- **Context:** `listAgentGroups` (`:4517-4524`) → `_loadAgentGroups` (`:4445`) → `_mutateAgentGroups` (`:4424`), which persists the seed at `:4438`.
- **Logic:** add a sibling that reads without entering the write chain. Leave `listAgentGroups` and `_loadAgentGroups` untouched — the TEAMS tab still seeds and still runs `importDelegatesIntoTeams`.

```ts
/**
 * Read-only team definitions for the terminals panel. Unlike listAgentGroups,
 * this NEVER seeds and never writes: a read verb that mints a starter team into
 * whatever DB it is handed is how a phantom member-less `Lead team` ended up in
 * a workspace whose TEAMS tab was never opened, out-ranking the operator's real
 * team in the picker. Migration runs in memory only.
 */
public async peekAgentGroups(workspaceRoot: string): Promise<any[]> {
    try {
        const db = this._getKanbanDb(workspaceRoot);
        if (!db || !(await db.ensureReady())) { return []; }
        const raw = await db.getConfigJson<any[]>(KanbanProvider.AGENT_GROUPS_CONFIG_KEY, null as any);
        if (!Array.isArray(raw)) { return []; }
        return migrateAgentGroups(raw) ?? raw;
    } catch (err) {
        console.warn('[KanbanProvider] peekAgentGroups failed:', err);
        return [];
    }
}
```

- **Edge Cases:** `_getKanbanDb` is synchronous here (matching `_loadAgentGroups`:4446); keep the `ensureReady()` await. A DB that fails to open returns `[]`, not a throw — the picker must open even with a broken board.

### `src/services/TaskViewerProvider.ts` — both verbs walk the candidate roots

- **Context:** `ptyListAgentGroups` (`:2582-2587`) and `ptyStartTeam` (`:2591-2631`). `_teamLookupRoots` (`:8805`) and `_getKanbanDbIfPresent` (`:8844`) already exist and are already used by the auto-start branch at `:2696-2701`.
- **Logic:**

```ts
if (verb === 'ptyListAgentGroups') {
    // Same candidate roots as the auto-start lookup and as ptyStartTeam below.
    // The TEAMS tab writes to the board's SELECTED root; this route is pinned
    // to the API-server root. Consulting only the pinned root served a seeded,
    // member-less `Lead team` while the operator's team sat one folder away.
    const roots = this._teamLookupRoots(payload?.cwd, root || effectiveRoot);
    const { teams, root: sourceRoot } = await listTeamsInRoots(
        roots,
        (r) => this._getKanbanDbIfPresent(r)
    );
    if (sourceRoot === null) {
        // No candidate holds authored teams. Fall back to the seeding load on
        // the pinned root so a first-run install still sees the starter team —
        // this is the ONE path allowed to write it.
        const seeded = await this._kanbanProvider?.listAgentGroups(root || effectiveRoot) ?? [];
        return { success: true, groups: seeded, sourceRoot: root || effectiveRoot };
    }
    console.log(`[TaskViewerProvider] Team list: ${teams.length} team(s) from '${sourceRoot}' `
        + `(candidates: ${roots.join(', ')})`);
    return { success: true, groups: teams, sourceRoot };
}
```

```ts
if (verb === 'ptyStartTeam') {
    if (payload && payload.group) {
        return { success: false, error: 'Team definition cannot be supplied over the wire' };
    }
    const teamId = payload?.teamId;
    if (!teamId) { return { success: false, error: 'Missing team id' }; }
    const wsRoot = root || effectiveRoot;
    // Spawn cwd is UNCHANGED and stays independent of the definition root.
    const spawnCwd = payload.cwd
        || (!payload.worktreePath && payload.parentRoot ? payload.parentRoot : undefined)
        || wsRoot;
    // Definition root: the SAME ordered candidates ptyListAgentGroups walked, so
    // the team the picker listed is the team this resolves. A single re-derived
    // root would answer `No team found with id` for every team the picker showed.
    const roots = this._teamLookupRoots(payload?.cwd, wsRoot);
    const match = await resolveTeamByIdInRoots(roots, (r) => this._getKanbanDbIfPresent(r), teamId);
    if (!match) {
        return { success: false, error: `No team found with id '${teamId}' in ${roots.join(', ')}` };
    }
    console.log(`[TaskViewerProvider] Team start: '${match.team.name}' `
        + `(${(match.team.members || []).length} member definitions) from '${match.root}', spawning in '${spawnCwd}'`);
    const result = await startTeamById({
        db: match.db,
        teamId,
        workspaceRoot: spawnCwd,
        liveTerminals: async () => { /* unchanged */ },
        instantiator: (group: any, groupRoot: string) => this.instantiateAgentGroup(group, groupRoot),
    });
    if (result && result.success !== false) {
        this._broadcaster?.push({ type: 'terminalsGroupsChanged' }, SURFACES.terminals);
    }
    return result;
}
```

Import `listTeamsInRoots` and `resolveTeamByIdInRoots` alongside the existing `teamWiring` imports at `:42`.

- **Edge Cases:** `_getKanbanDbIfPresent` returns `undefined` for a root with no board file, which both walkers skip silently — that is why it is used here rather than `_getKanbanDb`, which pops a warning toast per root (`:8826-8834`). The `Kanban DB not ready` guard currently at `:2609-2611` is replaced by the `!match` branch: the walker already skipped unusable DBs, so a null match is genuinely "no such team anywhere", and that message names the roots searched.

### `src/standalone/bootstrap.ts` — read-only list on the single-root host

- **Context:** `ptyListAgentGroups` (`:1161-1166`) calls `kanbanProvider.listAgentGroups(root)`. This host is single-root — it has no `getCurrentWorkspaceRoot`, no workspace-roots list, no `_filterMappedRoots` — so root cause 1 cannot occur here and no candidate walk is added. Root cause 2 does apply: a read verb still seeds and persists.
- **Logic:**

```ts
case 'ptyListAgentGroups': {
    // Read-only: peekAgentGroups never seeds. This host is single-root, so no
    // candidate walk — but a read verb must still not write a starter team into
    // the board just because the picker was opened.
    const groups = await kanbanProvider.peekAgentGroups(root);
    return { success: true, groups, sourceRoot: root };
}
```

- **Edge Cases:** on a genuinely first-run standalone board the picker now shows no teams instead of the starter `Lead team`. That is the honest answer for a board with no teams, and the TEAMS tab still seeds on its own load. `ptyStartTeam` here is unchanged — `startAgentGroupById(root, …)` is already correct for one root.

### `src/test/team-autostart-workspace-scope.test.js` — extend, do not fork

- **Context:** this file already documents this exact defect class for the auto-start path and holds both fake-DB drives and source-text contracts.
- **Logic:** add, in the file's existing style —
  1. `listTeamsInRoots` returns the selected root's authored teams when the pinned root holds only the seed (the reported bug, driven).
  2. A pinned-root-only read returns the seeded `Lead team` — proves the assertion is load-bearing.
  3. `isUntouchedSeed` is true for `SEEDED_AGENT_GROUP` and **false** for an operator-authored member-less team that differs by name only.
  4. `resolveTeamByIdInRoots` finds a team by id in the second candidate root and returns that root's db.
  5. Source-text: `ptyListAgentGroups` and `ptyStartTeam` in `TaskViewerProvider.ts` both contain `_teamLookupRoots(` — the two verbs must not drift back to a single root.
  6. Source-text: `bootstrap.ts`'s `ptyListAgentGroups` arm calls `peekAgentGroups`, not `listAgentGroups` — pins "a read verb does not seed".

## Verification Plan

1. `npm run compile-tests && node --require ./src/test/bootstrap/sandboxStateHome.js src/test/team-autostart-workspace-scope.test.js` — all existing cases still pass and the six new ones pass. (The walkers are imported from `out/`, matching the file's existing `require('../../out/services/teamWiring')`.)
2. `npm run test:contract:team-autostart-scope` — the packaged script name for the same file.
3. `npm run lint`.
4. **Live reproduction, before:** with the extension running, `curl -s -X POST http://127.0.0.1:$(cat .switchboard/api-server-port.txt)/terminals/verb/ptyListAgentGroups -d '{}'` returns the member-less `feature-implementation` / `Lead team`.
5. **Live reproduction, after:** the same call returns `group-coding-msvplbf4` / `Coding` with four member definitions (`3× coder`, `1× reviewer`) and a `sourceRoot` of `/Users/patrickvuleta/Documents/GitHub/switchboard`.
6. In the terminals panel, open the role picker: the team entry reads `START Coding` with the summary `3× coder, 1× reviewer (shared)`, and the `Lead` role option reads `starts Coding · 3× coder, 1× reviewer (shared)` rather than `heads Lead team (no members)`.
7. Click `START Coding` with no `lead` terminal live: a head plus four member terminals appear in the fleet list. Confirm the extension log line `Team start: 'Coding' (2 member definitions) from '…/switchboard', spawning in '…'`.
8. Click `START Coding` again while the head is live: the double-start refusal toast names the live head, unchanged from today.
9. Delete nothing, then confirm the read-only property: `sqlite3 /Users/patrickvuleta/Documents/Gitlab/.switchboard/kanban.db "select changes from config where key='terminals.agentGroups';"` — open the picker ten times against a boardless root and confirm no new `terminals.agentGroups` row is created in any workspace DB that did not already have one (`find ~/Documents -maxdepth 4 -name kanban.db` + a key-presence sweep before and after).
10. Standalone host: launch the standalone server against a fresh workspace with no `terminals.agentGroups` key, open the picker, and confirm the key is still absent afterwards.
