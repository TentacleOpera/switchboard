# Team Picker Shows a Phantom Member-less "Lead team" — the Two Team Verbs Resolve One Root and Seed Into It

## Goal

Make `ptyListAgentGroups` and `ptyStartTeam` resolve team definitions from the same workspace root the TEAMS tab **writes** to, and make the list verb read-only so it stops minting a phantom team into unrelated workspace databases. After this change the terminals panel lists the operator's real teams with their real member counts, and START spawns the head **and its members**.

This plan also owns the **single host-side team-start entry point** the rest of the feature consumes. The candidate-root walk it introduces is extracted as `TaskViewerProvider.startTeamForWorkspace(...)` so the boot-time autostart (*Teams Start Themselves on Load*) and the TEAMS-tab START button (*TEAMS Tab — Pick a Team From Three Cards*) inherit this fix by calling it, rather than each re-deriving a resolution path and each re-acquiring this bug. That extraction is why this subtask ships first.

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
| "they say no members even though the team has members assigned" | `teamSpawnSummary` (`terminals.js:6320-6324`) renders `head only` for the seeded team's empty `members`, and the role-option annotation renders `heads Lead team (no members)` (`terminals.js:6428-6450`). Both strings are correct **for the object they were handed**. |
| "the start team button starts the lead with none of its team members" | `ptyStartTeam` resolves `teamId` from the **same** wrong DB. `resolveTeamById` finds the seeded `feature-implementation` row there, `startTeamById` hands it to the instantiator, and a zero-member definition spawns exactly one lead. |

**Root cause 1 — the two team verbs consult one root; the writer uses another.**

`TaskViewerProvider._teamLookupRoots` (`:8811-8827`) exists for precisely this divergence, and its own comment states it:

> The TEAMS tab writes `terminals.agentGroups` into the BOARD'S SELECTED workspace (`KanbanProvider.saveAgentGroup` → `_resolveWorkspaceRoot`), while every terminals route resolves DBs against the PINNED API-server root (`LocalApiServer._options.workspaceRoot = effectiveRoot`). In a multi-root window those are different folders, so a lookup that consults only the pinned root reads a kanban.db that has never held the key.

That helper is wired into exactly **two** call sites — the auto-start branch of `ptyCreateTerminal` (`TaskViewerProvider.ts:2696-2701`) and the delegate-resolution path at `:9775-9778`. The two verbs added later by the explicit-team-start work never got it:

- `ptyListAgentGroups` (`TaskViewerProvider.ts:2582-2587`): `listAgentGroups(root || effectiveRoot)` — one root.
- `ptyStartTeam` (`TaskViewerProvider.ts:2591-2631`): `const wsRoot = root || effectiveRoot;` (`:2603`) then `this._getKanbanDb(wsRoot)` (`:2608`) — one root.
- Standalone twins at `bootstrap.ts:1161-1166` and `:1168-1199` — one root (correct there; that host is single-root).

The multi-root fix shipped for the implicit path and was never applied to the explicit path built on top of it. The regression test that pins the implicit fix — `src/test/team-autostart-workspace-scope.test.js` — asserts `findTeamForHeadRoleInRoots` and the `ptyCreateTerminal` call site only, so it passes at HEAD while the verbs beside it are broken.

**Root cause 2 — a read verb writes. `listAgentGroups` seeds and persists.**

`KanbanProvider.listAgentGroups` (`:4517-4524`) delegates to `_loadAgentGroups` (`:4445-4508`), which runs inside `_mutateAgentGroups` (`:4424-4443`) and, when the key is absent, **seeds `[SEEDED_AGENT_GROUP]` and writes it back** (`:4470-4474`, persisted at `:4438`). So opening the role picker in a window pinned to a boardless root does not merely read nothing — it *creates* the phantom `Lead team`, persists it, and then serves it.

> **Superseded:** "That is how `/Users/patrickvuleta/Documents/Gitlab/.switchboard/kanban.db` acquired a row for a workspace whose TEAMS tab was never opened. It also means the defect is self-perpetuating: after the first picker open, the wrong root is no longer 'empty', it is 'populated with a wrong answer'."
> **Reason:** The picker read is **not the only writer, and probably not the writer that did it.** Both hosts call the seeding load unconditionally at boot, before any picker is opened: `extension.ts:819-825` (`await kanbanProvider!.listAgentGroups(workspaceRoot)`, the delegate-import-at-activation pass) and `bootstrap.ts:2188-2192` (the same call, same rationale). On the extension host `workspaceRoot` there is `kanbanProvider.getCurrentWorkspaceRoot()` (`extension.ts:671`) — the board's **selected** root — so any session in which the operator had the Gitlab folder selected would have seeded it at activation with no picker involved. Attributing the on-disk row solely to the read verb over-claims from the evidence, and it inflates what fixing the read verb buys.
> **Replaced with:** Root cause 2 is real as a *contract* violation — a read verb must not write, and it must not join the agent-groups write chain — but it is **not** load-bearing for the reported symptom, and fixing it does not stop seeded rows from appearing (the activation pass will keep creating them, correctly, in the selected root). The symptom fix is Root cause 1 plus the untouched-seed skip below. `peekAgentGroups` is retained as the correct contract, with its benefit restated honestly: it stops the picker from writing to, and serialising against, a database it was only asked to read.

Seeding on load is correct for the TEAMS tab and for the boot-time delegate import (that is where a starter team belongs). It is wrong for a read-only list verb.

**Root cause 3 — an untouched seed out-ranks a real team.** Because a seeded row can legitimately exist in *any* candidate root, walking the candidates is not sufficient on its own: candidate #1 may hold nothing but the auto-seed and would shadow a root holding the operator's real definitions. A root whose entire team list is an untouched auto-seed carries no operator intent and must not win the walk. This is the load-bearing half of the fix and it is why the walk is gated on `hasAuthoredTeams`, not merely on "the key is present".

**Blast radius.** All three fixes are additive to the resolution path; no team definition is edited, deleted or moved. The auto-start path is untouched. Its own test file gains cases rather than changing.

## Metadata

**Complexity:** 5
**Tags:** bugfix, backend, reliability
**Project:** Browser Switchboard

## User Review Required

None. Every decision in this plan is settled: the candidate walk copies an existing, tested idiom; the untouched-seed predicate copies `isUntouchedOldSeed`'s exact-value construction; the extracted entry point has two named consumers inside this feature.

## Complexity Audit

### Routine

- Threading `_teamLookupRoots` into two more call sites in the same file that already uses it in two places.
- Adding a read-only sibling to `listAgentGroups`.
- Extending an existing contract test file with cases in its established style.

### Complex / Risky

- **The list and the start must agree on the same root, or the bug changes shape instead of ending.** If the picker lists teams resolved from root A and START resolves the id against root B, the operator gets `No team found with id 'group-coding-msvplbf4'` — a *new* failure that reads like a corrupt board. The two verbs must derive their candidate list identically and the start must resolve against the candidate list, not against a single re-derived root.
- **A phantom seed already exists on disk in at least one install (this one), and boot keeps making more.** `_teamLookupRoots` ranks the board's selected root above the pinned root, so the phantom is out-ranked in the common case — but it is still candidate #1 whenever the operator opens the picker from that workspace's `+` (`payload.cwd` admitted first, `:8822-8823`). The untouched-seed skip is what neutralises it, and it must keep working for rows created *after* this change by the activation pass at `extension.ts:821`.
- **"Untouched seed" must be an exact-value test, never a heuristic.** A member-less team an operator *authored* is legitimate and must be listed and startable. The file already has the correct idiom for this — `isUntouchedOldSeed` (`teamWiring.ts:368-393`) compares every field and rejects on any extra key. The new predicate must be built the same way, against `SEEDED_AGENT_GROUP`, or it will silently swallow real teams.
- **Spawn cwd and definition root are two different things and must stay separate.** `startTeamById(opts.workspaceRoot)` is the **spawn** directory (`TaskViewerProvider.ts:2607` deliberately computes `spawnCwd` from `payload.cwd`/`parentRoot`). The definition root is a new, independent resolution. Collapsing them would make a team started from a worktree resolve its definition from a directory with no board at all.
- **The extracted entry point is a shared surface with two downstream consumers.** `startTeamForWorkspace` is called by the verb, by boot-time autostart, and by the TEAMS-tab START. A signature change after those land is a three-file change; get the shape right here. It takes the *inputs* (`payloadCwd`, `pinnedRoot`, `teamId`, spawn hints) and owns everything after them, so a caller cannot accidentally supply its own resolved root.
- **Standalone is single-root and must not grow a fake multi-root.** `bootstrap.ts` has no `getCurrentWorkspaceRoot`, no workspace-roots list, and no `_filterMappedRoots` (verified: zero matches). Root cause 1 cannot occur there. Only root cause 2 applies. Mirroring the extension host's candidate walk into it would be inventing state that host does not have.

## Edge-Case & Dependency Audit

**Race Conditions** — `_mutateAgentGroups` serialises writes on `KanbanProvider._agentGroupsWriteChain` (`:4423-4443`). The new read-only path does not enter that chain, so a picker open concurrent with a TEAMS-tab save can read either side of the write. That is acceptable and strictly better than today: the current read *joins* the write chain and can persist a seed on top of a concurrent save's read.

**Security** — unchanged. Neither verb begins accepting a team definition from the wire; the `payload.group` rejection (`TaskViewerProvider.ts:2598-2600`, `bootstrap.ts:1175-1177`) stays. The candidate root list is still host-derived from mapped workspace roots (`_filterMappedRoots`, `:8819-8821`) — `payload.cwd` is admitted only when it is already a known root, which is the existing rule and must not be relaxed. `startTeamForWorkspace` inherits the same rule because it takes `payloadCwd` and calls `_teamLookupRoots` itself.

**Side Effects** —
- Teams that were invisible in the terminals panel become visible. That is the intent.
- A workspace pinned as the API root that has never had teams will no longer acquire a seeded row **from a picker open**. It will still acquire one at activation if it is the board's selected root (`extension.ts:819-825`) — that write is correct and stays.
- Existing phantom rows are not deleted by this change. Deleting operator-reachable config rows is out of scope; the untouched-seed skip neutralises them for resolution, and the operator can delete them in the TEAMS tab.
- A root whose stored value is `[]` (the operator deleted every team there) is skipped by `hasAuthoredTeams` and the walk continues into the next candidate. This deliberately **diverges** from `findTeamForHeadRoleInRoots`, whose contract is "first root that claims the head role wins, member-less included, because a silent cross-workspace *spawn* is worse than no spawn" (`teamWiring.ts:433-450`). The divergence is justified: this is a **list** the operator reads and clicks, not an implicit spawn — falling through so the picker has something real to show beats an empty picker in a window whose pinned root happens to be board-less. The two functions must not be "unified for symmetry"; their contracts differ on purpose.

**Migration** — none required. No stored shape changes; `terminals.agentGroups` is read and written in exactly its current form. The seed row is state that shipped, so it is skipped for resolution rather than deleted.

**Dependencies & Conflicts** — touches `src/services/TaskViewerProvider.ts`, `src/services/KanbanProvider.ts`, `src/services/teamWiring.ts`, `src/standalone/bootstrap.ts`, and extends `src/test/team-autostart-workspace-scope.test.js`. It does **not** touch `src/webview/terminals.js`, `src/webview/terminals.html` or `src/webview/kanban.html`, so it can run concurrently with every webview subtask in this feature under the one-stream-per-file rule.

## Dependencies

- `sess_20260816212416 — explicit team start in the terminals panel` (`.switchboard/plans/explicit-team-start-in-terminals-panel.md`, CODE REVIEWED) — added the two verbs this plan corrects.
- `sess_teamautostartscope — team auto-start workspace scope` — shipped `_teamLookupRoots` and `findTeamForHeadRoleInRoots` for the implicit path; this plan extends that fix to the explicit path and extends that fix's test file.
- No dependency on any other subtask in this feature. This subtask is the feature's ordering root: two of the other three consume `startTeamForWorkspace`.

## Adversarial Synthesis

**Risk summary.** The dominant risk is a half-applied fix: making the list walk candidates without making START resolve against the same ordered candidates turns an invisible wrong answer into a visible `No team found with id` — a worse failure, because it looks like board corruption. The second risk is the untouched-seed predicate drifting into a heuristic ("has no members" instead of "is byte-for-byte the seed"), which would silently swallow an operator's deliberately member-less team. Mitigations: both verbs route through one extracted `startTeamForWorkspace`/`listTeamsInRoots` pair that derive candidates identically; the predicate is exact-value against `SEEDED_AGENT_GROUP` with a key-set comparison, mirroring `isUntouchedOldSeed`; and a source-text contract test pins both verbs to `_teamLookupRoots` so they cannot drift back to a single root.

## Proposed Changes

### `src/services/teamWiring.ts` — an untouched-seed predicate and two root-walking resolvers

- **Context:** `findTeamForHeadRoleInRoots` (`:452-470`) is the host-free walker the auto-start path uses. The explicit path needs the same shape for "all teams" and "one team by id". `isUntouchedOldSeed` (`:368-393`) is the exact-value idiom to copy. `AGENT_GROUPS_CONFIG_KEY` (`:111`) and `migrateAgentGroups` (`:172`) are already in scope in this module.
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

- **Edge Cases:**
  - A root whose key is present but `[]` (the operator deleted every team) is skipped by `hasAuthoredTeams` and the walk continues. `resolveTeamByIdInRoots` deliberately does **not** gate on `hasAuthoredTeams`, so START still finds a team by id in any root that holds one — including a root that holds only the seed, whose seeded team is legitimately startable by explicit id.
  - **Clarification — the returned `db` is load-bearing and the double-resolve is intentional.** `startTeamById` calls `resolveTeamById(db, teamId)` again internally (`teamWiring.ts:524`). Passing `match.db` is what makes that second resolve hit the right root. Do not "optimise" by passing `match.team` into a variant that skips the internal resolve — that would fork `startTeamById`'s contract for one caller.

### `src/services/KanbanProvider.ts` — a read-only peek beside the seeding load

- **Context:** `listAgentGroups` (`:4517-4524`) → `_loadAgentGroups` (`:4445`) → `_mutateAgentGroups` (`:4424`), which persists the seed at `:4438`.
- **Logic:** add a sibling that reads without entering the write chain. Leave `listAgentGroups` and `_loadAgentGroups` untouched — the TEAMS tab and both hosts' boot passes still seed and still run `importDelegatesIntoTeams`.

```ts
/**
 * Read-only team definitions for the terminals panel. Unlike listAgentGroups,
 * this NEVER seeds and never writes, and never joins _agentGroupsWriteChain:
 * a read verb that mints a starter team into whatever DB it is handed — and
 * serialises against concurrent TEAMS-tab saves to do it — is a contract
 * violation regardless of which writer put the phantom row on disk.
 * Migration runs in memory only. It also does NOT run importDelegatesIntoTeams;
 * that import is a boot-time concern (extension.ts:819-825,
 * bootstrap.ts:2188-2192), not a per-picker-open one.
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

- **Edge Cases:** `_getKanbanDb` is synchronous in this class (matching `_loadAgentGroups`:4446 and `startAgentGroupById`:4543) — do not `await` it; keep the `ensureReady()` await. A DB that fails to open returns `[]`, not a throw — the picker must open even with a broken board.

### `src/services/TaskViewerProvider.ts` — both verbs walk the candidate roots, via one extracted entry point

- **Context:** `ptyListAgentGroups` (`:2582-2587`) and `ptyStartTeam` (`:2591-2631`). `_teamLookupRoots` (`:8811`) and `_getKanbanDbIfPresent` (`:8850`) already exist and are already used by the auto-start branch at `:2696-2701` and the delegate path at `:9775-9778`.
- **Logic — the list verb:**

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
        // this is the ONE verb path allowed to write it, and it is reached only
        // when every candidate is genuinely empty or seed-only.
        const seeded = await this._kanbanProvider?.listAgentGroups(root || effectiveRoot) ?? [];
        return { success: true, groups: seeded, sourceRoot: root || effectiveRoot };
    }
    console.log(`[TaskViewerProvider] Team list: ${teams.length} team(s) from '${sourceRoot}' `
        + `(candidates: ${roots.join(', ')})`);
    return { success: true, groups: teams, sourceRoot };
}
```

- **Logic — the extracted start entry point.** Add as a public method on `TaskViewerProvider`, near `instantiateAgentGroup` (`:11545`). This is the surface the boot-time autostart subtask and the TEAMS-tab START subtask both call; neither re-derives a root.

```ts
/**
 * The single host-side team-start path on the extension host. Owns the
 * candidate-root walk, the spawn-cwd rule, the live-terminal check and the
 * post-start broadcast. Callers supply INPUTS (a cwd hint, the pinned root,
 * a team id) and never a pre-resolved definition root — that is what stops a
 * second caller from re-acquiring the single-root bug this plan fixes.
 *
 * Three callers by design: the `ptyStartTeam` verb, the boot-time autostart
 * pass, and the TEAMS-tab START message arm. Changing this signature is a
 * three-call-site change.
 */
public async startTeamForWorkspace(opts: {
    teamId: string;
    pinnedRoot: string;
    payloadCwd?: string;
    parentRoot?: string;
    worktreePath?: string;
}): Promise<any> {
    const { teamId, pinnedRoot, payloadCwd, parentRoot, worktreePath } = opts;
    if (!teamId) { return { success: false, error: 'Missing team id' }; }
    // Spawn cwd is UNCHANGED from the verb's existing rule and stays
    // independent of the definition root: a team started from a worktree
    // must still resolve its definition from a directory that has a board.
    const spawnCwd = payloadCwd
        || (!worktreePath && parentRoot ? parentRoot : undefined)
        || pinnedRoot;
    // Definition root: the SAME ordered candidates ptyListAgentGroups walked, so
    // the team the picker listed is the team this resolves. A single re-derived
    // root would answer `No team found with id` for every team the picker showed.
    const roots = this._teamLookupRoots(payloadCwd, pinnedRoot);
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
        liveTerminals: async () => {
            const listed = await this._ptyHostVerb('ptyListTerminals', {});
            if (!listed?.success) { return []; }
            return [...(listed.terminals || []), ...(listed.hiddenTerminals || [])];
        },
        instantiator: (group: any, groupRoot: string) => this.instantiateAgentGroup(group, groupRoot),
    });
    if (result && result.success !== false) {
        this._broadcaster?.push({ type: 'terminalsGroupsChanged' }, SURFACES.terminals);
    }
    return result;
}
```

- **Logic — the start verb becomes a thin wrapper.** Its wire-safety guard stays in the verb, where the wire is:

```ts
if (verb === 'ptyStartTeam') {
    if (payload && payload.group) {
        return { success: false, error: 'Team definition cannot be supplied over the wire' };
    }
    return this.startTeamForWorkspace({
        teamId: payload?.teamId,
        pinnedRoot: root || effectiveRoot,
        payloadCwd: payload?.cwd,
        parentRoot: payload?.parentRoot,
        worktreePath: payload?.worktreePath,
    });
}
```

Import `listTeamsInRoots` and `resolveTeamByIdInRoots` alongside the existing `teamWiring` imports at `:42`.

- **Edge Cases:**
  - `_getKanbanDbIfPresent` returns `undefined` for a root with no board file, which both walkers skip silently — that is why it is used here rather than `_getKanbanDb`, which pops a warning toast per root (`:8829-8848`).
  - The `Kanban DB not ready` guard currently at `:2609-2611` is replaced by the `!match` branch: the walker already skipped unusable DBs, so a null match is genuinely "no such team anywhere", and that message names the roots searched.
  - `startTeamForWorkspace` keeps the `payload.group` rejection **outside** itself deliberately. Its non-verb callers (boot autostart, TEAMS tab) never carry a wire payload, and duplicating a wire guard into a non-wire method invites the next caller to assume it is guarded when it is not.
  - **Return-in-body contract (PRD #4):** every branch returns `{success, …}`; there is no bare ack and no `break`. The verb's `catch` behaviour is unchanged.

### `src/standalone/bootstrap.ts` — read-only list on the single-root host

- **Context:** `ptyListAgentGroups` (`:1161-1166`) calls `kanbanProvider.listAgentGroups(root)`. This host is single-root — it has no `getCurrentWorkspaceRoot`, no workspace-roots list, no `_filterMappedRoots` — so root cause 1 cannot occur here and no candidate walk is added. Root cause 2 does apply: a read verb still seeds, still joins the write chain, and still re-runs the delegate import on every picker open.
- **Logic:**

```ts
case 'ptyListAgentGroups': {
    // Read-only: peekAgentGroups never seeds and never joins the agent-groups
    // write chain. This host is single-root, so no candidate walk — but a read
    // verb must still not write to a board it was only asked to read, and must
    // not re-run importDelegatesIntoTeams on every picker open (that is the
    // boot pass's job, above at :2188-2192).
    const groups = await kanbanProvider.peekAgentGroups(root);
    return { success: true, groups, sourceRoot: root };
}
```

- **Edge Cases:**

  > **Superseded:** "on a genuinely first-run standalone board the picker now shows no teams instead of the starter `Lead team`. That is the honest answer for a board with no teams, and the TEAMS tab still seeds on its own load."
  > **Reason:** Factually wrong. `bootstrap.ts:2188-2192` calls `await kanbanProvider.listAgentGroups(workspaceRoot)` at boot, **before** the server begins serving and therefore before any picker can be opened. The key is already seeded by the time the verb runs, so the picker still shows the starter `Lead team` on a first-run standalone board. Nothing changes for the operator here.
  > **Replaced with:** On the standalone host this change is invisible to the operator: the boot pass at `:2188-2192` seeds first, so the picker shows the starter team exactly as it does today. What changes is that repeated picker opens no longer re-enter `_mutateAgentGroups` and re-run `importDelegatesIntoTeams` — a correctness and cost win, not a visible one. `ptyStartTeam` here is unchanged: `startAgentGroupById(root, …)` is already correct for one root.

### `src/test/team-autostart-workspace-scope.test.js` — extend, do not fork

- **Context:** this file already documents this exact defect class for the auto-start path and holds both fake-DB drives (against `require('../../out/services/teamWiring')`) and source-text contracts. Its packaged script is `npm run test:contract:team-autostart-scope` (`package.json:931`).
- **Logic:** add, in the file's existing style —
  1. `listTeamsInRoots` returns the selected root's authored teams when the pinned root holds only the seed (the reported bug, driven).
  2. A pinned-root-only read returns the seeded `Lead team` — proves the assertion is load-bearing.
  3. `isUntouchedSeed` is true for `SEEDED_AGENT_GROUP` and **false** for an operator-authored member-less team that differs by name only.
  4. `resolveTeamByIdInRoots` finds a team by id in the second candidate root and returns that root's db.
  5. `resolveTeamByIdInRoots` still resolves a seed-only root's team **by explicit id** — proving `hasAuthoredTeams` gates the list walk only, never the id walk.
  6. Source-text: `TaskViewerProvider.startTeamForWorkspace` contains `_teamLookupRoots(` and the `ptyStartTeam` arm delegates to `this.startTeamForWorkspace(` — the two verbs must not drift back to a single root, and the start path must stay single-owner.
  7. Source-text: `bootstrap.ts`'s `ptyListAgentGroups` arm calls `peekAgentGroups`, not `listAgentGroups` — pins "a read verb does not seed".

## Verification Plan

### Automated Tests

1. `npm run compile-tests && node --require ./src/test/bootstrap/sandboxStateHome.js src/test/team-autostart-workspace-scope.test.js` — all existing cases still pass and the seven new ones pass. (The walkers are imported from `out/`, matching the file's existing `require('../../out/services/teamWiring')`.)
2. `npm run test:contract:team-autostart-scope` — the packaged script name for the same file.
3. `npm run lint`.
4. `npm run verb-returns:check` and `npm run parity:check` — the verb bodies moved but every branch still returns in-body; the ratchet ceiling for TaskViewer must not rise.

### Manual / live reproduction

5. **Before:** with the extension running, `curl -s -X POST http://127.0.0.1:$(cat .switchboard/api-server-port.txt)/terminals/verb/ptyListAgentGroups -d '{}'` returns the member-less `feature-implementation` / `Lead team`.
6. **After:** the same call returns `group-coding-msvplbf4` / `Coding` with two member definitions (`3× coder`, `1× reviewer (shared)`) and a `sourceRoot` of `/Users/patrickvuleta/Documents/GitHub/switchboard`.
7. In the terminals panel, open the role picker: the team entry reads `START Coding` with the summary `3× coder, 1× reviewer (shared)`, and the `Lead` role option reads `starts Coding · 3× coder, 1× reviewer (shared)` rather than `heads Lead team (no members)`. *(After the sidebar subtask lands, read the same strings off the sidebar `START TEAM` form instead — the picker's team section is gone by then and only the role annotation remains.)*
8. Click `START Coding` with no `lead` terminal live: a head plus four member terminals appear in the fleet list (3 per-team coders + 1 shared reviewer). Confirm the extension log line `Team start: 'Coding' (2 member definitions) from '…/switchboard', spawning in '…'`.
9. Click `START Coding` again while the head is live: the double-start refusal toast names the live head, unchanged from today.
10. **Read-only property, correctly scoped.** Pick a workspace that is *not* the board's selected root and has no `terminals.agentGroups` key. Record the key's presence across every board — `find ~/Documents -maxdepth 4 -name kanban.db` then a `select count(*) from config where key='terminals.agentGroups'` sweep. Open the role picker ten times against that root. Re-run the sweep: no board gained the key. **Do not restart the extension or the standalone server during this check** — both hosts seed the *selected* root at boot by design (`extension.ts:819-825`, `bootstrap.ts:2188-2192`), and a restart mid-check would produce a false failure.
11. Standalone host: launch against a fresh workspace with no `terminals.agentGroups` key. The key **is** present after boot (the delegate-import pass wrote it) and the picker shows the starter `Lead team` — unchanged from today. Confirm instead that opening the picker ten times produces no further `setConfigJson` on that key: watch for the absence of repeated `[teamWiring] Migration:` / delegate-import log lines.

---

**Recommendation:** Complexity 5 → **Send to Coder.**
