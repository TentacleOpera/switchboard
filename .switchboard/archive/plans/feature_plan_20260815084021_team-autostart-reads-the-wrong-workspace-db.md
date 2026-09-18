# Team Auto-Start Looks For The Team In The Wrong Workspace's kanban.db

## Goal

Make a head agent's team actually spawn when the head spawns, by resolving the team definition from the workspace the operator configured it in — not from whichever root the API server happens to be pinned to.

### The problem

Reported from UAT: **"teams do not spawn when team owner spawns."**

The feature exists and is installed. Start a `lead` from the terminals panel `+` and you get exactly one terminal: a bare lead, no members, no group, no standing orders, and no error anywhere. The configuration saved in the TEAMS tab has no effect on the thing it describes — the same failure mode the auto-start work was written to remove, wearing a different hat.

### Root cause: the reader and the writer resolve different workspace roots

Team definitions are persisted at the DB config key `terminals.agentGroups`. Two different code paths resolve *which* `kanban.db` that key lives in, and they disagree:

| | Path | Root it resolves |
| :-- | :-- | :-- |
| **Writer** (TEAMS tab) | `KanbanProvider` `saveAgentGroup` / `getAgentGroups` (`KanbanProvider.ts:11519-11545`) → `_resolveWorkspaceRoot(msg.workspaceRoot)` (`:1061`) → `_mutateAgentGroups` (`:4381-4400`) | the **board's selected workspace** |
| **Reader** (auto-start) | `handlePtyVerb`'s `ptyCreateTerminal` arm (`TaskViewerProvider.ts:2237-2247`) → `this._getKanbanDb(root ‖ effectiveRoot)` | the **pinned API-server root** |

`root` arrives from `LocalApiServer._handleTerminalVerb` as `body.workspaceRoot || this._options.workspaceRoot` (`LocalApiServer.ts:1886`), and `workspaceRoot` is set once to `effectiveRoot` when the server is constructed (`TaskViewerProvider.ts:2424-2425`, with `effectiveRoot = resolveEffectiveWorkspaceRootFromMappings(this._getWorkspaceRoot())` at `:2036` — the window's **first** workspace folder, not the board's selection). The terminals webview's `createTerminal` posts `{ role, cwd?, worktreePath?, parentRoot? }` and **never** sends `workspaceRoot` (`src/webview/terminals.js:6283-6302`), so the fallback is always taken.

In a multi-root window those two roots are different, and the read silently returns nothing: `getConfigJson('terminals.agentGroups', [])` on a DB that has never held the key yields `[]`, `migrateAgentGroups([])` returns `null`, `[].find(...)` is `undefined`, and `findTeamForHeadRole` returns `null` (`teamWiring.ts:312-332`). No team, no log line, no error on the response.

### Evidence from the live install (2026-08-15)

- `GET /health` → `roots[0] = /Users/patrickvuleta/Documents/Gitlab`, `selectedWorkspaceRoot = /Users/patrickvuleta/Documents/GitHub/switchboard`. The pinned root and the board's selection are different folders. (`selectedWorkspaceRoot` is `getSelectedWorkspaceRoot: () => this._kanbanProvider?.getCurrentWorkspaceRoot() ?? null`, `TaskViewerProvider.ts:2454` — i.e. `/health` was already reporting both halves of the divergence.)
- The running pty-host child was launched as `… dist/standalone/ptyHost.js --workspace /Users/patrickvuleta/Documents/Gitlab` — and that argument *is* `effectiveRoot` (`TaskViewerProvider.ts:2066`), which independently confirms the pinned root.
- `sqlite3 <switchboard>/.switchboard/kanban.db "select value from config where key='terminals.agentGroups'"` →
  `[{"id":"feature-implementation","name":"Lead team","headRole":"lead","members":[{"role":"coder","count":3,"scope":"per-team","relationship":"reports-to-head"}]}]`
- `sqlite3 <Gitlab>/.switchboard/kanban.db` for the same key → **no row**. That is the DB the auto-start reads.
- `POST /terminals/verb/ptyListTerminals` → a live `lead-1` (started 2026-08-14T22:31:10Z) with `cwd = …/GitHub/switchboard` and **zero** parented children. The head landed in the switchboard workspace; its team was looked for in the Gitlab one.

The installed build is not the problem: `~/.devin/extensions/turnzero.switchboard-1.7.13/dist/extension.js` contains the auto-start block verbatim (`…!n.parentInstanceId&&!n._isTeamMember)try{const o=await this._getKanbanDb(r||t);…findTeamForHeadRole(o,e)…`). The shipped code runs and finds nothing.

### The second defect: the failure is completely silent

`findTeamForHeadRole` wraps its whole body in `try { … } catch { return null; }` with no log, and the caller's guard is `catch { /* DB not ready — proceed without auto-start */ }`. Success and failure are indistinguishable from the outside: no output-channel line, nothing on the create response. That is why a fully-implemented feature could ship and be reported as "does not spawn" with no diagnostic to attach. The fix below makes both outcomes loud.

### Why the same function already gets this right for `cwd`

Ten lines below the broken lookup, the *cwd* resolution deliberately uses the board's selection, not the pinned root (`TaskViewerProvider.ts:2248-2263`), with a comment saying it exists to match the grid button exactly. That is why `lead-1` correctly landed in the switchboard tree while its team was sought in Gitlab's DB. One function, two workspace resolutions, disagreeing. Aligning them is the fix.

### Third factor, established during the improve pass: an empty team can *claim* the role

`_loadAgentGroups` seeds `SEEDED_AGENT_GROUP` into a workspace's `terminals.agentGroups` the first time that workspace's TEAMS tab is read (`KanbanProvider.ts:4402-4425`), and that seed is `{ id: 'feature-implementation', name: 'Lead team', headRole: 'lead', members: [] }` (`teamWiring.ts:103-108`) — **member-less, but it heads `lead`**.

So "a team was found" and "a team will spawn" are different propositions, and any workspace whose TEAMS tab has ever been opened owns a `lead`-heading team. A multi-root search that stops at the first root claiming the role can therefore return the *auto-seeded empty* team from a nearer workspace and produce exactly the reported symptom — one bare lead — while every internal success signal is green. The design below is deliberately built around that: the "first claim wins" rule is kept (see the Complex/Risky note on cross-workspace spawns), and the diagnostic is required to separate **"no team heads this role"** from **"a team heads it and defines zero members"**. Collapsing those two into one "no team" message is what made this class of bug invisible the first time.

## Metadata

**Complexity:** 5
**Tags:** backend, bugfix, reliability
**Project:** Browser Switchboard

## User Review Required

None.

## Complexity Audit

### Routine

- Adding one exported pure-ish resolver to `teamWiring.ts` and two private helpers to `TaskViewerProvider`.
- Adding three `console.log` branches and one extra field on the verb result.
- Turning a bare `catch {}` into a logging `catch`.

### Complex / Risky

- **Choosing which root wins.** Getting the precedence wrong turns a silent no-op into a silent *cross-workspace* spawn: a lead started in repo A quietly spawning repo B's three coders is worse than spawning nothing, because each member is a real agent CLI process with real token spend. The resolution rule below is therefore "first root that **claims** the head role wins" — not "first root that yields members" — so a deliberately member-less team in the nearer workspace stops the search instead of falling through to a stranger's team.
- **The auto-seeded `Lead team` claims `lead` everywhere.** Consequence of the rule above, and the sharpest edge in the change: any workspace whose TEAMS tab was ever opened has a member-less `Lead team` persisted. A per-parent `+` on such a workspace resolves *that* team and spawns nothing. This is correct behaviour under the rule and must be **legible**, not silent — hence the three-way log and `memberDefinitions` on the response.
- **Worktree paths are not workspaces.** `payload.cwd` can be a git worktree directory that has no `.switchboard/` and is in no mapping. The candidate list must admit `payload.cwd` only when it is already a known workspace root, and the DB getter used by the lookup must skip any root with no `kanban.db` on disk (see the Superseded callout in Proposed Changes §2 for what the real hazard turned out to be).
- **Extra DB opens per create.** The lookup can now touch up to three roots. `_getKanbanDb` caches per resolved root in `this._kanbanDbs` and `KanbanDatabase.forWorkspace` is a per-root singleton, so the cost is one `getConfigJson` per candidate after the first create, and the loop short-circuits on the first root that claims the role.
- **No test coverage exists for any of this.** `grep -rl "findTeamForHeadRole\|agentGroups\|wireSpawnedTeam" src/test/` returns nothing. The regression this plan adds is the first.

## Edge-Case & Dependency Audit

### Race conditions

- Two heads of the same role starting concurrently each run the lookup independently; the definition is read-only at spawn time, so there is nothing to serialise. The writes that follow (standing orders, `terminals.groups`) are already serialised by `mutateStandingOrders` and `_groupsWriteChain` in `teamWiring.ts` and are untouched here.
- The board's selected workspace can change *between* the lookup and the spawn. The list is snapshotted once per create call, so a mid-flight switch cannot produce a half-resolved team.
- `getCurrentWorkspaceRoot()` can be `null` — it is `_currentWorkspaceRoot`, seeded from persisted state in the constructor (`KanbanProvider.ts:450`) and only re-assigned on an explicit selection. A fresh profile with nothing persisted yields `null`, which would silently drop the load-bearing candidate and leave the bug in place. The candidate builder therefore falls back to `this._resolveWorkspaceRoot()` (`TaskViewerProvider.ts:3240-3260`), which prefers the same kanban selection and only then drops to `roots[0]`.

### Behaviour on shipped installs

- **Single-root installs are unaffected.** Pinned root, selected root and `payload.cwd` all resolve to the same folder, the candidate list dedupes to one entry, and the lookup is byte-identical to today's. That is the majority of the ~4,000-install base.
- **No migration.** Nothing on disk changes shape; `terminals.agentGroups` keeps its key, its location and its schema. This is a read-path fix only.
- **Multi-root installs change behaviour by design** — that is the bug being fixed. A team configured on the board now spawns. Members are real agent CLIs, so this is the largest side effect in the change and belongs in release notes.

### Side effects

- **No new warning toasts.** `_getKanbanDb` calls `this._seams().ui.showWarningMessage('Kanban DB initialization failed: …')` whenever `ensureReady()` returns false (`TaskViewerProvider.ts:8307-8315`), deduped only per `(root, error)` in `_lastKanbanDbWarnings`. Widening the lookup to extra roots therefore risks a modal-grade warning per unbroken-but-boardless workspace, on a code path the operator never asked to open. The lookup uses a presence-gated getter so a root with no `kanban.db` is skipped before `_getKanbanDb` is ever reached.
- **No `.switchboard/` scaffolding.** The candidate loop never creates a directory or a DB file; see the Superseded callout in §2.

### Where team *state* is written stays put

`wireSpawnedTeam` writes `terminals.standingOrders` and `terminals.groups` through the db handed to it by the post-create hook (`TaskViewerProvider.ts:2352-2357`), which is the **pinned** root — and that is correct and must not change: the standing-orders append in `_ptyHostVerb` reads `this._apiServerWorkspaceRoot`, and `GET/POST /terminals/standing-orders` reads `_resolveDbForRoot()` → `_options.workspaceRoot`. Runtime team state is window-scoped; only the *definition* is workspace-scoped. Moving the writes to follow the definition would orphan every order the terminals panel consumes.

This is also the reason the obvious one-line alternative — make the terminals webview post `workspaceRoot`, so `root` is already correct — is rejected: `root` is the same variable the post-verb hook uses to open the wiring DB (`:2327`), so correcting it for the *definition* silently relocates the *state*.

### Security

No new wire surface. `payload.delegates` and `payload.startupCommand` are still overwritten from host-resolved config before the lookup runs (`TaskViewerProvider.ts:2196-2205`) — the team members still come from operator config, never from the create payload. The candidate roots come from `_getWorkspaceRoots()`/`getCurrentWorkspaceRoot()`, never from the request body; `payload.cwd` is used only as a *filter key* against that host-derived set, never as a root in its own right.

`teamAutoStart.roots` returns absolute filesystem paths to any API-token holder (every pty child holds one). This is the same disclosure class `/health` already makes — it returns `roots: this._allRoots` (`LocalApiServer.ts:3861`) — and `ptyListTerminals` already returns each terminal's `cwd`. No new class of information leaves the process.

## Dependencies

- None. `findTeamForHeadRole`, `wireSpawnedTeam` and `spawnDelegates` are all in `main` as of `1bd39f4a` (2026-08-14); nothing here waits on unlanded work.

### Conflicts

- `pty*` verbs are deliberately outside the generated verb surface (pinned by `src/test/pty-route-surface-contract.test.js`), so adding a field to the `ptyCreateTerminal` result does **not** touch `protocol-catalog.json`, `verbAllowlist.ts`, or `npm run parity:check`. Result shape is not schema-validated either — `verbSchemas.ts` validates *payloads* at dispatch, and `_handleTerminalVerb` `JSON.stringify`s whatever the arm returns.
- Shares `teamWiring.ts` with nothing else in flight.

## Adversarial Synthesis

**Risk Summary.** The load-bearing risk is not "the team isn't found" but "a team is found and still nothing spawns": the auto-seeded member-less `Lead team` heads `lead` in every workspace whose TEAMS tab was opened, so a first-claim-wins search can return a green result and reproduce the exact UAT symptom. Mitigated by a three-way diagnostic (no claim / claim-with-zero-members / claim-with-members) on both the log and the `teamAutoStart` response field, and by negative check #10 which asserts the operator can tell those apart. Secondary risks — a warning-toast storm from opening DBs on boardless roots, and a null board selection dropping the load-bearing candidate — are closed by a presence-gated DB getter and a `_resolveWorkspaceRoot()` fallback respectively; the cross-workspace-spawn risk is bounded by first-claim-wins plus a host-derived candidate set that the request body can only filter, never extend.

## Proposed Changes

### 1. `src/services/teamWiring.ts` — a testable multi-root resolver, and a lookup that stops lying about failure

Add an exported resolver beside `findTeamForHeadRole`. It takes a root list and a db-getter so it is drivable from a plain node test with fakes — no VS Code, no real DB.

```ts
/**
 * Resolve a team definition across an ordered list of candidate workspace roots.
 *
 * FIRST ROOT THAT CLAIMS THE HEAD ROLE WINS — not the first root that yields
 * members. A workspace whose team for this role is deliberately member-less is
 * an answer ("start a bare lead here"), and must stop the search rather than
 * fall through to another workspace's team. Every member is a real agent CLI;
 * a silent cross-workspace spawn is a worse failure than no spawn at all.
 *
 * NOTE for the caller: a member-less claim is a REAL outcome, not an
 * almost-miss. `_loadAgentGroups` seeds `SEEDED_AGENT_GROUP` — `headRole:
 * 'lead'`, `members: []` — into any workspace whose TEAMS tab is opened, so a
 * `{ team, root }` with zero members is common and must be reported
 * distinctly from `null`. Collapsing the two is the bug that made the original
 * failure invisible.
 *
 * Returns the match and the root it came from, so the caller can log WHICH
 * workspace answered. Never throws: a root whose DB is unavailable is skipped.
 */
export async function findTeamForHeadRoleInRoots(
    roots: string[],
    getDb: (root: string) => Promise<any | undefined>,
    headRole: string
): Promise<{ team: any; root: string } | null> {
    for (const root of roots) {
        let db: any;
        try {
            db = await getDb(root);
        } catch (err) {
            console.warn(`[teamWiring] Team lookup: DB unavailable for '${root}':`, err);
            continue;
        }
        if (!db) { continue; }
        const team = await findTeamForHeadRole(db, headRole);
        if (team) { return { team, root }; }
    }
    return null;
}
```

And stop swallowing the read failure inside `findTeamForHeadRole` (`:329-331`). The return contract is unchanged — `null` still means "no team" — but a DB error is no longer indistinguishable from an empty config:

```ts
    } catch (err) {
        console.warn(`[teamWiring] findTeamForHeadRole('${headRole}') failed:`, err);
        return null;
    }
```

### 2. `src/services/TaskViewerProvider.ts` — build the candidate list, gate the DB opens, and make the outcome legible

Add two private helpers next to `_getKanbanDb` (`:8299`):

```ts
    /**
     * Ordered workspace roots to search for a team definition, most specific first.
     *
     * The TEAMS tab writes `terminals.agentGroups` into the BOARD'S SELECTED
     * workspace (KanbanProvider.saveAgentGroup -> _resolveWorkspaceRoot), while
     * every terminals route resolves DBs against the PINNED API-server root
     * (LocalApiServer._options.workspaceRoot = effectiveRoot). In a multi-root
     * window those are different folders, so a lookup that consults only the
     * pinned root reads a kanban.db that has never held the key — the team
     * never spawns and nothing is logged. Consult both, nearest first.
     *
     * `payload.cwd` is admitted ONLY when it is already a known workspace root.
     * It can be a git worktree directory with no `.switchboard/` at all, and a
     * candidate list is a list of BOARDS, not of directories a terminal happens
     * to start in.
     *
     * `getCurrentWorkspaceRoot()` is the load-bearing entry — it is what the
     * WRITE path resolves to — but it is nullable (a profile with no persisted
     * selection). Falling back to `_resolveWorkspaceRoot()` keeps the same
     * preference order and only then drops to roots[0].
     */
    private _teamLookupRoots(payloadCwd: string | undefined, pinnedRoot: string): string[] {
        const out: string[] = [];
        const push = (candidate?: string | null) => {
            if (!candidate) { return; }
            const resolved = this._kanbanProvider?.resolveEffectiveWorkspaceRoot(candidate)
                ?? path.resolve(candidate);
            if (!out.includes(resolved)) { out.push(resolved); }
        };
        const known = new Set(
            this._filterMappedRoots(this._getWorkspaceRoots()).map(r => path.resolve(r))
        );
        const own = payloadCwd ? path.resolve(payloadCwd) : null;
        if (own && known.has(own)) { push(own); }
        push(this._kanbanProvider?.getCurrentWorkspaceRoot() ?? this._resolveWorkspaceRoot());
        push(pinnedRoot);
        return out;
    }

    /**
     * DB getter for the team lookup ONLY.
     *
     * `_getKanbanDb` pops `Kanban DB initialization failed: …` through
     * `_seams().ui.showWarningMessage` whenever `ensureReady()` returns false
     * (:8307-8315), deduped only per (root, error). The team lookup is the
     * first code path that opens DBs for roots the operator did not ask to
     * open, so without this pre-check a workspace folder with no board would
     * throw a warning at the operator every time a terminal is created. Skip
     * silently instead — `findTeamForHeadRoleInRoots` treats `undefined` as
     * "this root has no answer" and moves on.
     */
    private async _getKanbanDbIfPresent(root: string): Promise<KanbanDatabase | undefined> {
        const resolved = this._kanbanProvider?.resolveEffectiveWorkspaceRoot(root) ?? path.resolve(root);
        if (!fs.existsSync(path.join(resolved, '.switchboard', 'kanban.db'))) { return undefined; }
        return this._getKanbanDb(resolved);
    }
```

> **Superseded:** "Worktree paths are not workspaces. … Handing it to `KanbanDatabase.forWorkspace` would mint a new `kanban.db` inside the worktree."
> **Reason:** Factually wrong, and wrong in a way that invites a future maintainer to delete the guard. `_initialize()` does not create a DB file — the absent-file branch sets `_lastInitError = 'Database file does not exist (not auto-creating)'` and returns `false` (`KanbanDatabase.ts:6608-6616`). Only `createIfMissing()` creates, and `_getKanbanDb` never calls it. Verify the stated reason and it evaporates; the guard then looks like superstition and gets removed.
> **Replaced with:** The guard stays, on the real hazard: `_getKanbanDb` shows a **warning toast** for every root whose `kanban.db` is missing (`:8307-8315`) and caches a dead `KanbanDatabase` per bogus root in `_kanbanDbs`. Two defences, both cheap: the candidate list admits `payload.cwd` only when it is a known workspace root, and `_getKanbanDbIfPresent` checks the file on disk before opening anything.

Then replace the lookup itself (`:2237-2247`):

```ts
                let teamAutoStart: any;   // declared at the top of handlePtyVerb — see below
                if (!payload.parentInstanceId && !payload._isTeamMember) {
                    // `payload.cwd` is already final for this lookup. The only value it
                    // can consume — a KNOWN workspace root — is written by the
                    // parentRoot -> cwd conversion at the top of this arm (:2192-2195),
                    // above this block. The cwd block BELOW only ever writes the board's
                    // selected root, which is already candidate #2, so its position
                    // relative to this block cannot change the candidate list. Do not
                    // reorder them "for symmetry"; it is a no-op with a real diff.
                    const roots = this._teamLookupRoots(payload.cwd, root || effectiveRoot);
                    const match = await findTeamForHeadRoleInRoots(
                        roots,
                        (r) => this._getKanbanDbIfPresent(r),
                        role
                    );
                    const memberCount = Array.isArray(match?.team?.members) ? match!.team.members.length : 0;
                    if (match && memberCount > 0) {
                        payload = { ...payload, delegates: match.team.members, teamName: match.team.name };
                    }
                    teamAutoStart = {
                        role,
                        roots,
                        team: match?.team?.name ?? null,
                        matchedRoot: match?.root ?? null,
                        memberDefinitions: memberCount,
                    };
                    // THREE outcomes, three messages. "found a team" and "will spawn a
                    // team" are different propositions: the seeded `Lead team` heads
                    // `lead` with zero members in any workspace whose TEAMS tab was
                    // opened, so the middle case is the one that reproduces the original
                    // UAT report. Collapsing it into either neighbour re-hides the bug.
                    console.log(
                        !match
                            ? `[TaskViewerProvider] Team auto-start: no team heads role '${role}' in `
                              + `[${roots.join(', ')}] — starting a bare head`
                            : memberCount === 0
                                ? `[TaskViewerProvider] Team auto-start: team '${match.team.name}' from `
                                  + `${match.root} heads role '${role}' but defines ZERO members — `
                                  + `starting a bare head, nothing to spawn`
                                : `[TaskViewerProvider] Team auto-start: role '${role}' -> team `
                                  + `'${match.team.name}' (${memberCount} member definition(s)) from ${match.root}`
                    );
                }
```

`roots` is captured on the result below, so the operator can see the exact search list without opening a console — the diagnostic that was missing when this was reported.

> **Superseded:** "in `handlePtyVerb`'s `ptyCreateTerminal` arm, **move the existing cwd-resolution block (`:2248-2263`) to sit immediately before the auto-start block** — unchanged, comment and all — so `payload.cwd` is already resolved when the team is looked up."
> **Reason:** The hoist is a **no-op** that costs a real diff in a hot path plus a brittle source-text ordering test. Trace all three create shapes: plain `+` → `payload.cwd` is undefined at lookup time and the cwd block would set it to the *selected* root, which is already candidate #2 (deduped away); per-parent `+` → `payload.cwd` is set at `:2192-2195`, **above both blocks**, so the lookup already sees it; worktree `+` → `payload.worktreePath` is set, the cwd block does not run at all, and `payload.cwd` is the worktree path, which is correctly rejected by the known-roots filter. In every case the candidate list is identical with or without the move. The plan's justification ("the lookup must see the SAME root this block places the terminal in") reads well but describes a dependency that does not exist.
> **Replaced with:** Leave the cwd block at `:2248-2263` untouched. Record the invariant as a comment at the lookup (above), and pin the invariant that *is* load-bearing — the `parentRoot` → `cwd` conversion staying above the lookup — in the contract test instead of pinning block order.

In the post-verb block (`:2326-2374`), stamp it on the response for `ptyCreateTerminal`:

```ts
                if (verb === 'ptyCreateTerminal' && result && teamAutoStart) {
                    result.teamAutoStart = teamAutoStart;
                }
```

Declare `teamAutoStart` at the top of `handlePtyVerb` — after the `ptyVisibleRoles` / `ptyHostReady()` early returns, before `if (verb === 'ptyCreateTerminal' && payload)` — so both blocks share the binding. Add the import:

```ts
import { wireSpawnedTeam, findTeamForHeadRole, findTeamForHeadRoleInRoots } from './teamWiring';
```

(`findTeamForHeadRole` stays imported — `instantiateAgentGroup`'s adapter and any future single-root caller still use it.)

### 3. `src/standalone/bootstrap.ts` — parity of *evidence*, not of behaviour

The standalone host is single-root by construction (`allRoots: [workspaceRoot]` at `:1858`, `getKanbanDatabase: async () => db` at `:1859`, `const db = KanbanDatabase.forWorkspace(workspaceRoot)` at `:246`), so the divergence cannot occur there and **no behavioural change is needed**. Add only the matching three-way log (`:1169-1174`) so a UAT report from the browser host produces the same evidence as one from the extension host:

```ts
                    if (!payload.parentInstanceId && !payload._isTeamMember) {
                        // No root list here: this host has exactly ONE workspace root
                        // (allRoots: [workspaceRoot], getKanbanDatabase: () => db), so
                        // the writer/reader divergence the extension host has cannot
                        // occur. If this host ever grows multiple roots, this is the
                        // site that must grow `findTeamForHeadRoleInRoots` too.
                        const headRole = payload.role || 'coder';
                        const team = await findTeamForHeadRole(db, headRole);
                        const memberCount = Array.isArray(team?.members) ? team.members.length : 0;
                        console.log(
                            !team
                                ? `[bootstrap] Team auto-start: no team heads role '${headRole}' — starting a bare head`
                                : memberCount === 0
                                    ? `[bootstrap] Team auto-start: team '${team.name}' heads role '${headRole}' `
                                      + `but defines ZERO members — starting a bare head, nothing to spawn`
                                    : `[bootstrap] Team auto-start: role '${headRole}' -> team '${team.name}' `
                                      + `(${memberCount} member definition(s))`
                        );
                        if (team && memberCount > 0) {
                            payload = { ...payload, delegates: team.members, teamName: team.name };
                        }
                    }
```

### 4. `src/test/team-autostart-workspace-scope.test.js` — the first test this feature has ever had

A plain node script in house style (`node --require ./src/test/bootstrap/sandboxStateHome.js …`, compiled output from `out/`, per `src/test/multi-parent-terminals-contract.test.js`), driving the resolver with fake DBs — no VS Code, no sqlite:

```js
const { findTeamForHeadRoleInRoots } = require('../../out/services/teamWiring');

const fakeDb = (groups) => ({ getConfigJson: async (_k, d) => (groups === undefined ? d : groups) });
const LEAD_TEAM = { id: 'feature-implementation', name: 'Lead team', headRole: 'lead',
    members: [{ role: 'coder', count: 3, scope: 'per-team', relationship: 'reports-to-head' }] };

// 1. THE REPORTED BUG: the pinned root has no key, the selected root holds the team.
//    Searching both, nearest-first, must find it.
const dbs = { '/pinned': fakeDb(undefined), '/selected': fakeDb([LEAD_TEAM]) };
const m = await findTeamForHeadRoleInRoots(['/selected', '/pinned'], async r => dbs[r], 'lead');
assert.strictEqual(m && m.team.name, 'Lead team');
assert.strictEqual(m.root, '/selected');

// 2. Pinned-root-only search reproduces the defect — proves the test is load-bearing.
assert.strictEqual(await findTeamForHeadRoleInRoots(['/pinned'], async r => dbs[r], 'lead'), null);

// 3. A member-less team in the NEARER root stops the search: no cross-workspace spawn.
//    This is the SEEDED_AGENT_GROUP shape verbatim — the case that reproduces the
//    original symptom with every signal green, so it must be a distinguishable
//    RESULT (team named, members 0), never a null.
const seeded = { id: 'feature-implementation', name: 'Lead team', headRole: 'lead', members: [] };
const dbs3 = { '/near': fakeDb([seeded]), '/far': fakeDb([LEAD_TEAM]) };
const m3 = await findTeamForHeadRoleInRoots(['/near', '/far'], async r => dbs3[r], 'lead');
assert.strictEqual(m3.root, '/near');
assert.strictEqual(m3.team.members.length, 0);

// 4. An unavailable DB is skipped, not fatal.
const m4 = await findTeamForHeadRoleInRoots(['/dead', '/selected'],
    async r => { if (r === '/dead') { throw new Error('boom'); } return dbs[r]; }, 'lead');
assert.strictEqual(m4.root, '/selected');

// 5. Drift guard: the reader consults the same root the writer uses. Source-level —
//    _teamLookupRoots must reference getCurrentWorkspaceRoot, because that is what
//    KanbanProvider._resolveWorkspaceRoot resolves to on the save path.
const src = fs.readFileSync(path.join(REPO_ROOT, 'src/services/TaskViewerProvider.ts'), 'utf8');
const helper = src.slice(src.indexOf('_teamLookupRoots(payloadCwd'),
                         src.indexOf('_teamLookupRoots(payloadCwd') + 1600);
assert.ok(/getCurrentWorkspaceRoot/.test(helper));

// 6. Invariant guard (replaces the block-order guard): the parentRoot -> cwd
//    conversion is the ONLY writer of a cwd the lookup can consume, so it must
//    stay above the lookup. Below it, a per-parent `+` would silently resolve the
//    team from the selected workspace instead of the one the operator clicked.
const arm = src.slice(src.indexOf("if (verb === 'ptyCreateTerminal' && payload)"));
assert.ok(arm.indexOf('cwd: payload.parentRoot') < arm.indexOf('_teamLookupRoots('));

// 7. Toast guard: the candidate loop must use the presence-gated getter, and that
//    getter must actually check the file. _getKanbanDb warns the USER for every
//    root whose kanban.db is absent.
const call = arm.slice(arm.indexOf('findTeamForHeadRoleInRoots'),
                       arm.indexOf('findTeamForHeadRoleInRoots') + 400);
assert.ok(/_getKanbanDbIfPresent/.test(call));
const getter = src.slice(src.indexOf('_getKanbanDbIfPresent(root'),
                         src.indexOf('_getKanbanDbIfPresent(root') + 600);
assert.ok(/existsSync/.test(getter) && /kanban\.db/.test(getter));

// 8. Legibility guard, both hosts: the zero-member outcome must have its OWN
//    message. One collapsed "no team" line is what hid this bug for a release.
const bootstrapTs = fs.readFileSync(path.join(REPO_ROOT, 'src/standalone/bootstrap.ts'), 'utf8');
for (const [label, text] of [['TaskViewerProvider', src], ['bootstrap', bootstrapTs]]) {
    assert.ok(/ZERO members/.test(text), `${label} must log the zero-member case distinctly`);
}
```

Register it in `package.json` as `test:contract:team-autostart-scope` (beside `test:contract:multi-parent-terminals` at `:928`) and add a CI step to `.github/workflows/integration-tests.yml` beside the other terminal contracts (`:130-160`).

## Verification Plan

### Automated Tests

1. `npm run compile-tests && npm run test:contract:team-autostart-scope` — all eight assertions green. Assertion 2 is the reproduction: it must fail if the multi-root search is reverted to a single pinned root. Assertions 3 and 8 are the anti-regression pair for the zero-member case.
2. `npm run test:contract:pty-route-surface` — the `pty*` verbs must still be absent from the generated surface after adding `teamAutoStart` to the result.
3. `npm run test:contract:multi-parent-terminals` — the cwd block was deliberately NOT moved; this test already pins its wrapper-vs-module resolution and must stay green untouched.
4. `npm run compile` — TypeScript clean.
5. Stash-verify before blaming this change for any red: five regression tests are already red at HEAD.

### Manual (the reported scenario, in the multi-root window)

Pre-state on this machine: `terminals.agentGroups` exists in `<switchboard>/.switchboard/kanban.db` with a `lead`-headed team of 3 coders; the same key is **absent** from `<Gitlab>/.switchboard/kanban.db`; `GET /health` reports `roots[0] = …/Gitlab`, `selectedWorkspaceRoot = …/switchboard`.

1. Rebuild and reinstall the VSIX, then reload the window (the pty host is one-shot per extension-host lifetime — an unreloaded window keeps the old child).
2. With the board on the **switchboard** workspace, open the terminals panel, press `+`, choose **lead**.
3. Expect: `lead-N` **plus three** children named `lead-N-coder-1..3`, all parented to the head.
4. `POST /terminals/verb/ptyListTerminals` → the three children present with `parentInstanceId` equal to the head's `agentInstanceId`.
5. The create response carries `teamAutoStart: { role: 'lead', roots: ['…/switchboard', '…/Gitlab'], team: 'Lead team', matchedRoot: '…/switchboard', memberDefinitions: 1 }`. **This response field is the operator-facing diagnostic** — read it here, not in a log.
6. The extension-host developer console (Help ▸ Toggle Developer Tools, or the *Extension Host* output) shows `Team auto-start: role 'lead' -> team 'Lead team' (1 member definition(s)) from …/switchboard`. `TaskViewerProvider` has no `OutputChannel` — every diagnostic in it is `console.log` (75 existing call sites with this exact prefix), so the Switchboard output channel will show nothing and its silence is not a failure.
7. `sqlite3 <Gitlab>/.switchboard/kanban.db "select value from config where key='terminals.standingOrders'"` → three new orders whose `parent` is a `lead-N-coder-*` and whose `child` is `lead-N` (runtime state stays on the pinned root, by design), and `terminals.groups` holds a `team_lead_N` group listing head + members.
8. The terminals sidebar shows the three children nested under the head.

### Negative checks

9. Start a **planner** (no team heads that role): exactly one terminal, and the log reads `no team heads role 'planner' in [ … ] — starting a bare head`. The failure is now visible instead of silent.
10. Set the switchboard team's members to zero in the TEAMS tab, then start a `lead`: one bare lead, `teamAutoStart.team = 'Lead team'`, `memberDefinitions: 0`, `matchedRoot` = switchboard, and the log carries the distinct **ZERO members** wording — not the "no team heads role" wording from check 9. It must **not** fall through to any other workspace. This is the check that separates "found nothing" from "found an empty team"; if both cases produce the same message, the fix is incomplete regardless of check 2 passing.
11. Open the TEAMS tab once with **Gitlab** selected (this seeds a member-less `Lead team` into Gitlab's DB), switch the board back to switchboard, then use the sidebar's per-parent `+` on the **Gitlab** row: expect one bare lead with `matchedRoot` = Gitlab and `memberDefinitions: 0`. This is correct first-claim-wins behaviour — the point of the check is that the response says *why*, so the operator is not back at "teams do not spawn".
12. Use the sidebar's per-parent `+` on a *worktree* row: the terminal starts in the worktree, no `kanban.db` and no `.switchboard/` directory is created inside the worktree (`ls <worktree>/.switchboard` unchanged), **no warning toast appears**, and the team resolves from the selected workspace.
13. Single-root sanity: open a window on one folder only, confirm `teamAutoStart.roots` has exactly one entry and behaviour is identical to before the change.

---

**Recommendation: Send to Coder** (complexity 5).

---

## Completion Summary

Implemented the multi-root team-definition resolver and three-way legibility diagnostic. Added `findTeamForHeadRoleInRoots` to `src/services/teamWiring.ts` (first-claim-wins across ordered candidate roots, non-throwing) and replaced the silent `catch {}` in `findTeamForHeadRole` with a logging catch. In `src/services/TaskViewerProvider.ts` added `_teamLookupRoots` (board-selected root first, pinned root second, `payload.cwd` admitted only when a known workspace root) and `_getKanbanDbIfPresent` (presence-gated to skip boardless roots without a warning toast), replaced the single-pinned-root lookup with the multi-root resolver, declared `teamAutoStart` at the top of `handlePtyVerb`, and stamped it on the `ptyCreateTerminal` response. Mirrored the three-way log (no-team / zero-members / spawning) in `src/standalone/bootstrap.ts`. Added `src/test/team-autostart-workspace-scope.test.js` (8 assertions: 4 behavioural on the resolver with fake DBs, 4 source-text contracts) and registered it as `test:contract:team-autostart-scope` in `package.json` and `.github/workflows/integration-tests.yml`. No issues encountered; compilation and automated tests were skipped per task instructions.

## Review Findings

Reviewed 2026-08-15; three material defects found and fixed in `src/services/TaskViewerProvider.ts` and `src/test/team-autostart-workspace-scope.test.js`. (1) CRITICAL — assertion 7 anchored on `_getKanbanDbIfPresent(root)`, which the typed signature never matches, so `indexOf` returned -1 and the test shipped RED into a wired CI step (7 passed / 1 failed as delivered); re-anchored on the declaration with a found-guard. (2) MAJOR — `_getKanbanDbIfPresent` gated on the hardcoded `<root>/.switchboard/kanban.db`, but a `.switchboard/db-pointer` or the shipped `switchboard.kanban.dbPath` setting relocates the file, so the guard silently disabled auto-start for custom-DB installs including single-root ones (contradicting "Single-root installs are unaffected"); it now resolves the path via `KanbanDatabase.readDbPointer` + `_resolveDbPathSetting`, and the test pins that. (3) MAJOR — replacing the old `try { … } catch {}` left the lookup unguarded, so a throw from `_teamLookupRoots` (workspace/mapping resolvers, `path.resolve` on a wire-supplied `payload.cwd`) would 502 the create and produce **no terminal at all**; restored a logging catch that reports `teamAutoStart.error` instead of re-hiding the failure. Also removed a now-dead `findTeamForHeadRole` import from `TaskViewerProvider.ts` (NIT). Verification: `npm run compile-tests` clean, `npm run compile` clean (4 pre-existing dependency warnings), `test:contract:team-autostart-scope` 8/8, `test:contract:pty-route-surface` all green, `test:contract:multi-parent-terminals` 29/29, eslint 0 errors; gate wiring confirmed (script in `package.json:929`, invoked in `.github/workflows/integration-tests.yml:611` inside the `integration-tests` job that already runs `compile-tests`). Remaining risk: the manual multi-root UAT scenario (checks 1–13) is unexecuted — the fix is verified by contract test and static trace only, and cross-workspace first-claim-wins behaviour still spawns real agent CLIs on first live run.
