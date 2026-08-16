# Route a CODE REVIEWED advance to the originating team's own reviewer, not the first reviewer on the board

## Goal

When more than one team is live, advancing a card to `CODE REVIEWED` sends it to an
arbitrary reviewer. Role resolution is workspace-wide and team-blind: it collects every
alive terminal whose role is `reviewer` and picks the first one. So a card coded by team
A's coders is routinely handed to team B's reviewer, who has no context, no worktree, and
no reason to be looking at it — while team A's own reviewer sits idle.

Make the reviewer that receives a `CODE REVIEWED` advance be the reviewer belonging to
the team that produced the work, and fall back to today's behaviour only when the
originating team genuinely cannot be determined.

### Problem analysis

**Where the wrong reviewer is chosen.** Two resolvers, both team-blind:

`TaskViewerProvider.getRoleTerminalSet` (`src/services/TaskViewerProvider.ts:6508`)
builds the candidate set purely by role match over the whole workspace registry:

```ts
        const aliveTerminals = await this._getAliveAutobanTerminalRegistry(workspaceRoot, opts);
        const normalizedRole = this._normalizeAutobanPoolRole(role);
        const entries = Object.entries(aliveTerminals)
            .filter(([, info]) => this._normalizeAgentKey((info as any)?.role) === normalizedRole)
            .filter(([, info]) => !this._isAutobanBackupTerminalInfo(info))
            .sort(([a], [b]) => a.localeCompare(b));
```

`TaskViewerProvider._resolveAgentTerminalForPlan` (`:9379`) has a worktree-path
preference and then falls through to a bare first-match over the fleet:

```ts
        if (this._ptyHostPort) {
            const normalizedRole = this._normalizeAgentKey(role);
            const res = await this._ptyHostVerb('ptyListTerminals', {});
            if (res?.success && Array.isArray(res.terminals)) {
                const match = res.terminals.filter((t: any) => t.status === 'active')
                    .find((t: any) => this._normalizeAgentKey(t.role) === normalizedRole);
                if (match) { return match.friendlyName; }
            }
        }
```

Neither knows what a team is. With `Coding-reviewer` and `Backend-reviewer` both alive,
the winner is decided by alphabetical sort or by fleet insertion order.

**The team identity already exists — nothing consults it.** `wireSpawnedTeam`
(`src/services/teamWiring.ts:721-746`) writes a complete roster into the
`terminals.groups` config key on every team start:

```ts
    const groupMembers = [headName, ...childNames];
    const group = {
        id: groupId,            // `team_<encoded headName>`
        name: headName,
        source: 'manual' as const,
        layout,
        members: groupMembers,
        order: groupMembers,
    };
```

`childNames` includes **both** kinds of member. `spawnDelegates`
(`src/standalone/ptyFleetService.ts`) pushes per-team children (named
`${headName}-${role}`, parented) and `scope: 'shared'` members (named
`${teamName}-${role}`, deliberately unparented) into the same `children` array, so the
group roster is the authoritative membership list for a team — including the shared
reviewer that the `Coding` team ships. `standingOrders.ts` already resolves `team` scope
through exactly this array (`:104-112`). The dispatch path simply never reads it.

**Root cause.** Role→terminal resolution predates teams and was never extended when teams
landed. Membership is modelled in `terminals.groups`; dispatch resolves by role over the
flat workspace registry. The two models never met.

**Why the worktree path does not save us.** `_resolveAgentTerminalForPlan`'s first branch
matches on `worktreePath`, which does work when each team lives in its own worktree. But
(a) teams started in the main checkout share a `worktreePath` (or have none), (b) a
`scope: 'shared'` member inherits `parent.worktreePath` from whichever head spawned it
first and is then reused by other heads, and (c) the path-only fallback inside
`_findTerminalNameByWorktreePathAndRole` (`:9468-9474`) will happily return a non-reviewer
terminal that merely shares the path. The worktree signal is a coincidence, not the
membership fact.

**Why the recorded origin is not usable as-is (found during the improve pass).** The
obvious "who coded this card" signal — `plans.dispatched_agent` — is written by
`KanbanProvider._recordDispatchIdentity` (`:3370-3412`), which derives the value from its
`terminalName` argument:

```ts
        if (terminalName) {
            agentName = terminalName;
        } else if (isIdeDispatch) {
            agentName = `${ideName} ${role}`;
        } else {
            agentName = 'unknown';
        }
```

On the single-card drag path the caller has no terminal name to give it. The built-in
dispatch branch calls it with `targetTerminalOverride` (`KanbanProvider.ts:8831`), which
is `undefined` for every non-`planner` role, and the downstream resolver's own recording
call is gated off for exactly this path (`TaskViewerProvider.ts:20258`,
`if (explicitTargetColumn && targetColumn)` — `triggerAgentFromKanban` passes no
`targetColumn`, see `extension.ts:1692`). So **a card dragged to `CODER CODED` records
`dispatched_agent: 'unknown'`**, and the terminal that actually coded it is never written
down anywhere. This is why this plan carries a Change 0: without it, origin precedence
step 2 is dead code and the drag-and-drop half of the fix cannot work.

**The plumbing to fix the routing itself is already present.** `performKanbanDispatch`
(`src/services/LocalApiServer.ts:1225-1333`) accepts `dispatchOptions.targetTerminalOverride`
and forwards it into the `triggerAction` arm (`:1295`):

```ts
            await kanbanVerb('triggerAction', { sessionId, targetColumn, workspaceRoot, bypassTriggerGate: true, unattended: !!dispatchOptions?.unattended, targetTerminalOverride: dispatchOptions?.targetTerminalOverride }, workspaceRoot);
```

and the built-in arm honours it (`KanbanProvider.ts:8810-8811`). What is missing is
anything that *computes* a team-correct value for it.

## Metadata

- **Complexity:** 8
- **Tags:** bugfix, backend, reliability
- **Project:** Browser Switchboard

> **Superseded:** **Complexity:** 7
> **Reason:** The improve pass added Change 0, which alters a **write** path on a shipped
> field (`plans.dispatched_agent`) across ~4,000 installs and moves recording ownership
> between two providers. That is a data-consistency risk of a different kind from the
> read-side routing work, on top of the two-branch dispatch coordination already priced in.
> **Replaced with:** **Complexity:** 8 — routing is unchanged (Send to Lead Coder).

## User Review Required

None. The three decisions this plan could have deferred were taken during the improve
pass and are recorded inline:

- Fix the `dispatched_agent` writer rather than dropping the drag-and-drop promise
  (Change 0 — see the architecture note in Adversarial Synthesis).
- Hosts without a wired `resolveKanbanDispatch` (standalone) do not get team routing;
  they report the fallback rather than pretending (Edge-Case audit 13).
- The `Coding` team's `headPrompt` already carries `"from"`; this plan does not edit it
  (Change 6).

## Complexity Audit

### Routine

- Adding a pure `resolveTeamScopedRoleTerminal()` helper beside the other
  `terminals.groups` readers in `src/services/teamWiring.ts`.
- Accepting an optional `from` field on the `POST /kanban/dispatch` body.
- Documenting `from` in the orchestration skill's endpoint table.

### Complex / Risky

- **The origin signal does not exist yet on the drag path.** `dispatched_agent` is the
  literal string `'unknown'` for a single-card drag to a coding column (see Problem
  analysis). Change 0 makes the writer honest; it is a behaviour change on a shipped
  write path and moves recording ownership between `KanbanProvider` and
  `TaskViewerProvider`. Get this wrong in the other direction and the field becomes empty
  instead of `'unknown'`, which is a regression on the board's card display.
- **Two dispatch branches, only one reads the override.** `KanbanProvider`'s
  `triggerAction` arm has a `custom-user` branch (`:8706`) and a built-in branch
  (`:8783`). Only the built-in branch reads `msg?.targetTerminalOverride` (`:8810`); the
  `custom-user` branch computes its own for `planner` only (`:8713-8726`) and ignores the
  caller's. If `CODE REVIEWED` is a configured custom column on a given board, a
  team-correct override computed upstream is silently discarded and the wrong reviewer is
  picked anyway — with every gate green. Both branches must honour it.
- **Determining "which team produced this card" without inventing state.** There are
  three honest signals and they must be tried in a fixed order with an explicit, logged
  fallback. Guessing (e.g. "nearest worktree") is how the current bug happened.
- **A terminal can belong to more than one group.** `terminals.groups` is append-only
  (`wireSpawnedTeam` skips on duplicate `id` at `:737`, never prunes) and a
  `scope: 'shared'` member is deliberately reused across heads, so it legitimately
  appears in several groups' `members` arrays. Group selection must be deterministic, not
  first-array-index.
- **Silent degradation is the failure mode to avoid.** If the team cannot be resolved,
  the dispatch must still happen (today's behaviour) but must say so in the response, or
  this becomes an invisible half-fix.

## Edge-Case & Dependency Audit

### Race Conditions

- **`dispatched_agent` is read before the move, written after.** `performKanbanDispatch`
  fetches `record` at step 1 (`:1244`) and fires `triggerAction` at step 4 (`:1295`),
  which itself re-records the dispatch identity for the *new* column. The origin must be
  read from the step-1 `record`, never re-fetched after the move — by then it names the
  reviewer, not the coder. The plan's placement (between step 3 and step 4) is correct;
  do not move it.
- **Two heads starting concurrently** both append to `terminals.groups` through
  `_groupsWriteChain` (`teamWiring.ts:733-742`), so the roster the resolver reads is never
  half-written.

### Security

- No new authenticated surface. `from` is a request field on an already-authenticated
  endpoint (`_handleKanbanDispatch` calls `_checkAuth` at `:1200`). It is used only to
  look up membership in `terminals.groups`; a caller-supplied name that is not a group
  member resolves to `null` and changes nothing. It can never be used to *name* a
  dispatch target directly — that is `targetTerminalOverride`, which this plan does not
  expose on the wire.

### Side Effects

- **Change 0 alters what the board shows.** Cards dragged to a coding column will display
  the resolved terminal name where they previously displayed `unknown`. This is strictly
  more truthful and matches every other dispatch path (batch dispatch already records
  `group.targetAgent`, `TaskViewerProvider.ts:6362-6366`), but it is a visible change on
  shipped installs and must be called out in the release note rather than discovered.
- **No change for single-team or no-team boards** (regression test 5).

### Dependencies & Conflicts

1. **Origin resolution order.** Fixed precedence, each step verifiable:
   1. explicit `from` on the dispatch body — the head naming its own terminal. Highest
      confidence, and the case the companion head-instruction plan produces.
   2. the plan row's `dispatched_terminal` — written by `attributePasteDispatch`
      (`KanbanDatabase.ts:9734-9744`) on the copy-prompt/paste attribution path. It always
      holds a real terminal name when non-empty, which is a stronger guarantee than
      `dispatched_agent` carries.
   3. the plan row's `dispatched_agent` — after Change 0 this is the terminal that
      actually coded the card on the drag path too.
   4. none of the above ⇒ **no override**; fall through to today's workspace-wide
      resolution, and say so in the response.

   > **Superseded:** A two-step precedence — explicit `from`, then `dispatched_agent` ("written by `_recordDispatchIdentity` … This is the terminal that actually coded it").
   > **Reason:** The parenthetical is false on the path this plan most needs it. `_recordDispatchIdentity` writes the literal `'unknown'` whenever its caller has no terminal name, and the single-card drag caller never has one (`KanbanProvider.ts:8831` passes `targetTerminalOverride`, `undefined` for every non-planner role; `TaskViewerProvider.ts:20258` is gated off for that path). Manual verification step 8 as originally written could not have passed. It also missed `dispatched_terminal`, a V57 column that already holds real terminal names on the paste path.
   > **Replaced with:** The four-step precedence above, plus Change 0 to make step 3 true.

   **Values that are NOT origins** and must be filtered before any lookup: the literal
   `'unknown'`; an IDE-shaped `"<IDE name> <role>"` string (`_recordDispatchIdentity`'s
   `isIdeDispatch` branch, and the type's own comment at `KanbanDatabase.ts:74` documents
   the field as a *tool* name such as `'claude cli'`); and a bare role word — the
   `attributePastedPrompt` arm writes `dispatchedAgent = msg.role`
   (`KanbanProvider.ts:10204`, `:10260`), so `'coder'` is a value this field really takes.
   The group-membership requirement filters all three in practice, but filter them
   explicitly so a terminal an operator happened to name `coder` cannot become an origin.
2. **Group selection when the origin is in several groups.** Prefer the group whose `id`
   equals `team_${encodeURIComponent(origin).replace(/[^a-zA-Z0-9_]/g,'_')}` (the origin
   IS the head of that team — the same derivation `wireSpawnedTeam` uses at `:618-619`).
   Otherwise take the group with the lowest index in `terminals.groups` that both contains
   the origin and contains a live terminal of the requested role. Deterministic and
   explainable.
3. **Candidate ordering inside a group.** Iterate the group's `order` array (falling back
   to `members`), not object-key order, so the choice is stable across restarts.
4. **The origin must be excluded from its own candidate set** — a head whose role happens
   to be `reviewer` must not dispatch a review to itself.
5. **Liveness is mandatory.** A group roster is never pruned; an exited reviewer stays in
   `members` forever. Candidates must be intersected with the live set
   (`ptyListTerminals` `status === 'active'`, plus the VS Code registry for non-fleet
   terminals) before being returned. A dead override is worse than no override — it
   dispatches into a closed pty.
6. **Role match uses the terminal record's `role`, never the name.** Names are
   `${headName}-${role}` / `${teamName}-${role}` by convention only; an operator rename
   (`rewriteStandingOrdersForRename`, `standingOrders.ts:61-72`, exists precisely because
   renames happen) breaks any name-based inference. Normalise with the same
   `_normalizeAgentKey` the existing resolvers use.
7. **Two teams forked from the same shipped definition share a shared member.** Both
   `Coding` forks compute `sharedBaseName = 'Coding-reviewer'` and `spawnDelegates`
   reuses the live instance, so one reviewer legitimately appears in both groups.
   Resolution still lands on that reviewer from either head — correct, not a bug. Note it
   so it is not "fixed".
8. **Non-fleet (VS Code terminal) teams.** `instantiateAgentGroupCore` runs on both hosts
   and `wireSpawnedTeam` registers the group either way, so the resolver must consult the
   VS Code registry as well as the pty fleet. `_getAliveAutobanTerminalRegistry` covers
   the former; `ptyListTerminals` the latter — and the two are genuinely disjoint, per the
   comment at `TaskViewerProvider.ts:9389-9391` ("`_getAliveAutobanTerminalRegistry`
   cannot supply one — it keeps a row only on a VS Code pid/name match or a heartbeat,
   and PTY rows have none of those"). Union them; neither alone is sufficient.
9. **Scope is `CODE REVIEWED` / the `reviewer` role, but the helper must be role-generic.**
   The same team-blindness applies to `ACCEPTANCE TESTED` → `tester`. Build the helper
   role-generic; wire it for `reviewer` in this plan and leave `tester` for a follow-up so
   the blast radius stays one column.
10. **Migration:** none. No new persisted state, no schema change, no config key. `from`
    is a request field; the resolver reads `terminals.groups`, which every team start has
    written since teams shipped. Boards with no registered groups resolve to `null` and
    behave exactly as today. Change 0 writes a different *value* into an existing column,
    never a different shape.
11. **Backwards compatibility for callers.** `from` is optional. Every existing caller of
    `POST /kanban/dispatch` (the board, the oversight-pass service, `move-card.js`,
    external orchestrators) keeps working unchanged.
12. **Relationship to the companion plan.** This plan does **not** depend on the
    head-instruction plan landing first — it improves routing for human drags and
    orchestrator dispatches too. The two share exactly one file
    (`src/services/teamWiring.ts`), so their merges serialise; land the head-instruction
    plan first (it is the smaller edit to that file). See the feature file's
    "Dependencies & sequencing".
13. **Hosts where the dispatch role is unresolvable.** `performKanbanDispatch` learns the
    role from the optional `resolveKanbanDispatch` callback, which is wired only in the
    extension host (`TaskViewerProvider.ts:2931`) — `src/standalone/bootstrap.ts` does not
    supply it. On the standalone host `gate` is therefore `undefined` and team-scoped
    routing must **not** silently no-op: emit
    `teamRouting: 'team-scoped: dispatch role unavailable on this host — fell back to workspace-wide'`.
    Per PRD contract #6 (capability-gating honesty), an unwired capability reports itself
    rather than faking success. Wiring `resolveKanbanDispatch` into the standalone
    composition root is a one-line follow-up and is deliberately **out of scope here** —
    it changes gate behaviour for every dispatch, not just this one.
14. **Dependencies:** `src/services/teamWiring.ts` (new helper),
    `src/services/LocalApiServer.ts`, `src/services/KanbanProvider.ts`,
    `src/services/TaskViewerProvider.ts`,
    `.agents/skills/switchboard-orchestration/SKILL.md`. Depends on nothing outside the
    repo; no new packages.

## Dependencies

- None. No prior planning session is a prerequisite for this work.

## Adversarial Synthesis

**Risk summary.** The dominant risk is shipping a half-fix that looks complete: the API
path routes correctly while the human drag path still picks an arbitrary reviewer, because
the origin it depends on is recorded as `'unknown'`. Change 0 closes that, at the cost of
altering a shipped write path — mitigated by moving recording ownership explicitly (one
writer per path) and by a regression test asserting the field is a real terminal name, not
empty. Secondary risks are the `custom-user` dispatch branch discarding the override (its
own dedicated test, which must fail without the fix) and a stale group roster naming a
dead reviewer (mandatory liveness intersection).

**Architecture note — why fix the writer instead of narrowing the goal.** The alternative
was to drop origin precedence step 3 and support only an explicit `from`, leaving drags on
today's behaviour. Rejected: half the reported symptom is human drags, and a plan whose
own manual test cannot pass is the "green metric, unmet goal" failure. The other
alternative — changing `switchboard.triggerAgentFromKanban` to return the resolved
terminal name instead of a boolean — touches every caller of a widely-used command for the
same information Change 0 obtains locally. Rejected as a larger blast radius for no extra
benefit.

## Proposed Changes

### 0. Make `dispatched_agent` name the terminal that actually ran the work

**Context.** Two writers race for the same field on the single-card dispatch path, and the
one that wins has no name to write:

- `TaskViewerProvider.handleKanbanTrigger` resolves the real terminal into `targetAgent`
  (`:20087-20106`) and records it — but only `if (explicitTargetColumn && targetColumn)`
  (`:20258`). `switchboard.triggerAgentFromKanban` passes no `targetColumn`
  (`extension.ts:1692`), so this never fires for a drag.
- `KanbanProvider` then records unconditionally with `targetTerminalOverride`
  (`:8831`), which is `undefined` for every non-`planner` role ⇒ `'unknown'`.

**Logic.** Give each path exactly one writer, and let the writer that knows the name do
the writing.

In `TaskViewerProvider.handleKanbanTrigger` (`:20258`), record whenever a target column
resolved — the column is already computed either way at `:20249`:

```ts
        // Record with the RESOLVED terminal, not just when an explicit column was
        // supplied. The drag path supplies no column, so this used to be skipped and
        // KanbanProvider's fallback wrote the literal 'unknown' — leaving no record of
        // which terminal coded the card, which is what made team-scoped reviewer
        // routing impossible.
        if (targetColumn) {
            await this._kanbanProvider?._recordDispatchIdentity(resolvedWorkspaceRoot, sessionId, targetColumn, targetAgent);
        }
```

In `KanbanProvider`'s built-in branch (`:8831`), record only when it has a name of its
own, so it cannot overwrite the line above:

```ts
                            // Only when we chose the terminal ourselves (planner rotation
                            // or a caller-supplied override). The dispatch path records the
                            // terminal it resolved; re-recording with `undefined` here would
                            // overwrite that real name with the literal 'unknown'.
                            if (targetTerminalOverride) {
                                await this._recordDispatchIdentity(workspaceRoot, sessionId, targetColumn, targetTerminalOverride);
                            }
```

**Edge cases.** The IDE-dispatch branches (`:8796`, `TaskViewerProvider.ts:5889`,
`:17933`) call `_recordDispatchIdentity` with `isIdeDispatch: true` and are untouched —
they still record `"<IDE name> <role>"`. The `jules` branch returns from
`handleKanbanTrigger` before `:20258` (`:20082`) and has no entry in
`_recordDispatchIdentity`'s `roleFromColumn` map, so it is unaffected. Assert in test that
no path now records an **empty** `dispatched_agent` — turning `'unknown'` into `''` would
be a display regression on the board.

### 1. `src/services/teamWiring.ts` — the team-scoped role resolver

```ts
/**
 * Resolve the terminal of `role` that belongs to the SAME registered team as
 * `originName`.
 *
 * `terminals.groups` is the authoritative roster: wireSpawnedTeam writes one
 * entry per started team whose `members` array holds the head plus every child,
 * including `scope: 'shared'` members (which are unparented and therefore
 * invisible to any parentInstanceId-based lookup). This is the only place team
 * membership is recorded, and until now the dispatch path never read it.
 *
 * Returns null — never a guess — when there is no group for the origin, no
 * member of that role, or no live candidate. The caller then falls back to the
 * workspace-wide resolution and MUST report that it did.
 *
 * Role matching uses the live terminal's own `role` field, never its name:
 * names are `${head}-${role}` by convention only and survive no rename.
 */
export async function resolveTeamScopedRoleTerminal(opts: {
    db: any;
    originName: string;
    role: string;
    /** Live terminals: `{ name, role }`. Caller supplies the union of the pty fleet and the VS Code registry. */
    liveTerminals: Array<{ name: string; role?: string }>;
    /** Same normaliser the existing role resolvers use, injected to avoid a provider import. */
    normalizeRole: (r: string | undefined) => string;
}): Promise<string | null> {
    const { db, originName, role, liveTerminals, normalizeRole } = opts;
    if (!db || !originName || !role) { return null; }

    let groups: any[] = [];
    try {
        groups = await db.getConfigJson('terminals.groups', []) as any[];
    } catch { return null; }
    if (!Array.isArray(groups) || groups.length === 0) { return null; }

    const wanted = normalizeRole(role);
    const liveByName = new Map<string, string>();
    for (const t of liveTerminals) {
        if (t && t.name) { liveByName.set(t.name, normalizeRole(t.role)); }
    }

    const candidatesIn = (g: any): string | null => {
        const roster: string[] = Array.isArray(g?.order) && g.order.length
            ? g.order
            : (Array.isArray(g?.members) ? g.members : []);
        for (const name of roster) {
            if (name === originName) { continue; }       // never dispatch to yourself
            if (liveByName.get(name) === wanted) { return name; }
        }
        return null;
    };

    // Preferred: the group the origin HEADS (its id is derived from the head name,
    // same derivation as wireSpawnedTeam's groupId).
    const headId = 'team_' + encodeURIComponent(originName).replace(/[^a-zA-Z0-9_]/g, '_');
    const headGroup = groups.find(g => g && g.id === headId);
    if (headGroup) {
        const hit = candidatesIn(headGroup);
        if (hit) { return hit; }
    }

    // Otherwise: first group (in stored order) that contains the origin AND a live
    // terminal of the wanted role. Deterministic, and a shared member legitimately
    // present in several groups resolves the same way from any of its heads.
    for (const g of groups) {
        if (!g || !Array.isArray(g.members) || !g.members.includes(originName)) { continue; }
        const hit = candidatesIn(g);
        if (hit) { return hit; }
    }
    return null;
}
```

It is a pure function over `(db, liveTerminals)` on purpose: the standalone host can call
it with `ptyFleetService.listActive()` without constructing a `TaskViewerProvider`.

### 2. `src/services/TaskViewerProvider.ts` — one place that can answer the question

Add a thin method that assembles the live set and delegates, so both call sites share it:

```ts
    /**
     * The terminal of `role` on the same team as `originName`, or null. Unions the
     * pty fleet with the VS Code registry — a team can be either, the two registries
     * are disjoint (see _resolveAgentTerminalForPlan's note), and a shared team member
     * is unparented so it appears in neither a parent lookup nor a worktree match.
     */
    public async resolveTeamRoleTerminal(
        workspaceRoot: string,
        originName: string,
        role: string
    ): Promise<string | null> {
        try {
            const db = await this._getKanbanDb(workspaceRoot);
            if (!db || !await db.ensureReady()) { return null; }
            const live: Array<{ name: string; role?: string }> = [];
            if (this._ptyHostPort) {
                const res = await this._ptyHostVerb('ptyListTerminals', {});
                if (res?.success && Array.isArray(res.terminals)) {
                    for (const t of res.terminals) {
                        if (t?.status === 'active') { live.push({ name: t.friendlyName, role: t.role }); }
                    }
                }
            }
            const registry = await this._getAliveAutobanTerminalRegistry(workspaceRoot);
            for (const [name, info] of Object.entries(registry)) {
                if (!live.some(l => l.name === name)) { live.push({ name, role: (info as any)?.role }); }
            }
            return await resolveTeamScopedRoleTerminal({
                db, originName, role, liveTerminals: live,
                normalizeRole: (r) => this._normalizeAgentKey(r || ''),
            });
        } catch (err) {
            console.warn('[TaskViewerProvider] resolveTeamRoleTerminal failed:', err);
            return null;
        }
    }
```

### 3. `src/services/LocalApiServer.ts` — accept `from` and compute the override

In `_handleKanbanDispatch` (`:1199-1217`), read the new field and pass it through:

```ts
            const from = String(body?.from || body?.originTerminal || '').trim();
            const outcome = await this.performKanbanDispatch(
                workspaceRoot, ref, rawColumn || undefined, { originTerminal: from || undefined }
            );
```

Extend `performKanbanDispatch`'s `dispatchOptions` (`:1229`) with `originTerminal?: string`,
and insert the resolution between step 3 (gates) and step 4 (fire the arm, `:1295`):

```ts
            // Team-scoped target: a review handed back to the board belongs to the
            // reviewer on the SAME team that produced the work. Role resolution
            // downstream is workspace-wide and would pick an arbitrary reviewer once a
            // second team is live. Origin precedence: explicit `from` (the head naming
            // itself) → the plan's dispatched_terminal → its dispatched_agent → none.
            // `unknown`, IDE-shaped names and bare role words are not terminal names.
            // `record` is the PRE-move read (step 1): after step 4 these fields name the
            // reviewer, not the coder.
            let teamOverride: string | undefined = dispatchOptions?.targetTerminalOverride;
            let teamRouting: string | undefined;
            if (!teamOverride && this._options.resolveTeamRoleTerminal) {
                if (!gate?.role) {
                    teamRouting = 'team-scoped: dispatch role unavailable on this host — fell back to workspace-wide';
                } else {
                    const origin = (dispatchOptions?.originTerminal || '').trim()
                        || this._plausibleOriginTerminal(record);
                    if (origin) {
                        const hit = await this._options.resolveTeamRoleTerminal(workspaceRoot, origin, gate.role);
                        if (hit) {
                            teamOverride = hit;
                            teamRouting = `team-scoped: ${origin} → ${hit}`;
                        } else {
                            teamRouting = `team-scoped: no ${gate.role} on ${origin}'s team — fell back to workspace-wide`;
                        }
                    } else {
                        teamRouting = 'team-scoped: no origin terminal — fell back to workspace-wide';
                    }
                }
            }
```

with the filter as a small private helper so it is unit-testable on its own:

```ts
    /**
     * The terminal name recorded against a plan, or '' when what is recorded is not a
     * terminal name. `dispatched_terminal` is only ever a real name; `dispatched_agent`
     * can also be 'unknown', an IDE-shaped "<IDE> <role>" string, or a bare role word
     * (the paste-attribution path writes the role there).
     */
    private _plausibleOriginTerminal(record: any): string {
        const KNOWN_ROLE_WORDS = new Set(['planner', 'coder', 'lead', 'reviewer', 'intern', 'tester', 'analyst', 'researcher']);
        const terminal = String(record?.dispatchedTerminal || '').trim();
        if (terminal) { return terminal; }
        const agent = String(record?.dispatchedAgent || '').trim();
        if (!agent || agent === 'unknown') { return ''; }
        if (KNOWN_ROLE_WORDS.has(agent.toLowerCase())) { return ''; }
        const ide = String(record?.dispatchedIde || '').trim();
        if (ide && agent.startsWith(ide + ' ')) { return ''; }
        return agent;
    }
```

Pass `targetTerminalOverride: teamOverride` into the `triggerAction` call at `:1295`, and
add `teamRouting` to the response payload (`:1306-1324`) so a fallback is visible to the
caller rather than silent:

```ts
                    ...(teamRouting ? { teamRouting } : {}),
```

Declare the callback on `LocalApiServerOptions` (beside `resolveKanbanDispatch`, `:207`):

```ts
    /**
     * Resolve the terminal of `role` on the same registered team as `originTerminal`.
     * Optional — absent in headless/test harnesses, where routing degrades to the
     * workspace-wide role pick (today's behaviour).
     */
    resolveTeamRoleTerminal?: (workspaceRoot: string, originTerminal: string, role: string) => Promise<string | null>;
```

Wire it in the extension-host composition root (`TaskViewerProvider.ts:2931` block) to
`this.resolveTeamRoleTerminal`. In `src/standalone/bootstrap.ts`, wire it to a small
adapter that calls `resolveTeamScopedRoleTerminal` directly with
`ptyFleetService.listActive()` — the helper is pure precisely so this host needs no
provider. Note that on standalone it will still short-circuit on the missing `gate.role`
(audit item 13) until `resolveKanbanDispatch` is wired there; wire the callback anyway so
that follow-up is a one-line change.

### 4. `src/services/KanbanProvider.ts` — make the `custom-user` branch honour the override

The built-in branch already reads `msg?.targetTerminalOverride` (`:8810`). The
`custom-user` branch (`:8713-8726`) computes its own for `planner` only and drops the
caller's. Give it the same precedence:

```ts
                        let targetTerminalOverride: string | undefined;
                        let plannerCursorLocationKey: string | undefined;
                        const tvp = this._taskViewerProvider;
                        // A caller-supplied override is authoritative on BOTH branches.
                        // Only the built-in branch read it before, so a board whose
                        // CODE REVIEWED column is custom-configured silently discarded
                        // team-scoped routing and picked an arbitrary reviewer.
                        if (msg?.targetTerminalOverride) {
                            targetTerminalOverride = msg.targetTerminalOverride;
                        } else if (role === 'planner' && dispatchMode !== 'prompt' && tvp) {
                            const { terminals, locationKey } = await tvp.getRoleTerminalSet('planner', workspaceRoot);
                            if (terminals.length > 0) {
                                const cursor = tvp.getPlannerRotationCursor(locationKey);
                                targetTerminalOverride = terminals[cursor % terminals.length];
                                plannerCursorLocationKey = locationKey;
                            }
                        }
```

**Edge case.** The planner rotation cursor must still advance only on a successful
dispatch (`:8737-8739`). The `else if` keeps the cursor untouched when a caller override
wins, which is correct — no planner slot was consumed.

### 5. `src/services/TaskViewerProvider.ts` — team-aware resolution on the drag path

**Context.** The board drag reaches `handleKanbanTrigger` with no
`targetTerminalOverride`, so the target is chosen at `:20105`:

```ts
            targetAgent = await this._resolveAgentTerminalForPlan(role, resolvedWorkspaceRoot, worktreePath);
```

Give `_resolveAgentTerminalForPlan` (`:9379`) an optional origin and put the team check
ahead of the fleet first-match — but **after** the worktree match, which is a stronger
signal when present:

```ts
    private async _resolveAgentTerminalForPlan(
        role: string,
        workspaceRoot: string,
        worktreePath?: string,
        originTerminal?: string
    ): Promise<string | undefined> {
        if (worktreePath) {
            const wtTerminal = await this._findTerminalNameByWorktreePathAndRole(worktreePath, role, false);
            if (wtTerminal) { return wtTerminal; }
        }
        if (originTerminal) {
            const teamHit = await this.resolveTeamRoleTerminal(workspaceRoot, originTerminal, role);
            if (teamHit) { return teamHit; }
        }
        // …existing fleet first-match + _getAgentNameForRole fallback unchanged…
    }
```

Thread `originTerminal` at `:20102` and `:20105` — the single-card dispatch path — by
reading the plan record for `sessionId` from the same DB and applying the same
origin filter as Change 3. This is the call site the drag actually uses.

> **Superseded:** "Thread `originTerminal` from the two call sites that have a plan record in hand (`:6292`, `:6306`), sourcing it from `record.dispatchedAgent`."
> **Reason:** Wrong call sites, and not implementable there. Those lines (now `:6306` and `:6320`) are the **batch** dispatch path, and what they hold is `BatchPromptPlan` objects — a type with no `dispatchedAgent` and no `dispatchedTerminal` field (`agentPromptBuilder.ts:29-51`). The drag-and-drop path this plan's manual test exercises goes through `handleKanbanTrigger` at `:20102`/`:20105`, which the original list omitted entirely.
> **Replaced with:** Thread it at `:20102`/`:20105` (required — this is the drag path). The batch call sites keep passing `undefined` and degrade to today's behaviour; extending `BatchPromptPlan` with a dispatch-origin field is a separate change and is deliberately not in scope. All other call sites (`:5614`, `:10753`) also keep passing `undefined`.

### 6. `.agents/skills/switchboard-orchestration/SKILL.md` — document `from`

Extend the `POST /kanban/dispatch` row's body to
`{ plan, targetColumn?, workspaceRoot?, from? }` and add: *`from` — your own terminal
name. Supply it and a role dispatch (e.g. CODE REVIEWED → reviewer) is routed to the
member of YOUR team rather than the first matching terminal on the board. The response
echoes `teamRouting` naming the decision, including when it fell back.*

> **Superseded:** "If the companion head-instruction change is present, update its `headPrompt` to include `"from":"<your terminal name>"` in the documented POST body."
> **Reason:** A conditional edit to a string this plan does not own, creating a window in which a head dispatches without an origin and lands on the wrong reviewer — the exact bug. Reconciled during the feature's cross-subtask audit: the companion plan now ships `"from":"{head}"` in the `headPrompt` from the start, interpolated to the head's real terminal name by `wireSpawnedTeam`. `_handleKanbanDispatch` reads a fixed set of body keys and ignores unknown ones, so `from` is inert until this plan lands and correct the moment it does.
> **Replaced with:** This plan does not touch `kanban.html`. It only documents the field in the skill.

## Verification Plan

### Automated Tests

1. **Unit — `resolveTeamScopedRoleTerminal`.** New `src/test/team-scoped-role-routing.test.js`
   with a stubbed `db.getConfigJson`:
   - Two groups — `team_lead_1` = `['lead-1','lead-1-coder-1','Coding-reviewer']`,
     `team_lead_2` = `['lead-2','lead-2-coder-1','Backend-reviewer']` — and all six live.
     Origin `lead-1` ⇒ `Coding-reviewer`. Origin `lead-2` ⇒ `Backend-reviewer`. Origin
     `lead-1-coder-1` ⇒ `Coding-reviewer` (a member resolves to its own team's reviewer).
   - **This is the regression the plan exists for:** assert the alphabetically-first
     reviewer (`Backend-reviewer`) is NOT returned for `lead-1`.
   - Reviewer exited (absent from `liveTerminals`) ⇒ `null`, not a dead name.
   - Origin absent from every group ⇒ `null`.
   - No `terminals.groups` key ⇒ `null` (empty-board safety).
   - Origin's own role is `reviewer` ⇒ never returns the origin itself.
   - Role match ignores names: a terminal named `Coding-reviewer` whose record `role` is
     `coder` is NOT selected; a terminal named `alice` whose record `role` is `reviewer`
     IS.
   - Shared member in two groups ⇒ same result from either head, no throw.
   - `order` array present and different from `members` ⇒ selection follows `order`.
2. **Unit — origin filter (`_plausibleOriginTerminal`).** `dispatched_terminal` beats
   `dispatched_agent`; `'unknown'`, `'coder'` (bare role word) and
   `'Visual Studio Code reviewer'` (IDE-shaped, matching the row's `dispatched_ide`) all
   yield `''`; a real terminal name passes through. Assert explicit `from` beats a
   conflicting recorded value at the call site.
3. **Unit — Change 0 recording ownership.** With a stubbed
   `_recordDispatchIdentity`, drive a single-card dispatch with no override and assert it
   is called exactly **once**, with the resolved terminal name — not `undefined`, and not
   twice. Assert the recorded value is never the empty string. Repeat with a caller
   override supplied and assert the recorded name is that override.
4. **Integration — `POST /kanban/dispatch`.** Against the standalone harness with the two
   groups above registered and a stubbed `kanbanVerb` that records its arguments:
   - `{plan, targetColumn:'CODE REVIEWED', from:'lead-1'}` ⇒ the recorded `triggerAction`
     payload carries `targetTerminalOverride: 'Coding-reviewer'`, and the response
     `teamRouting` reads `team-scoped: lead-1 → Coding-reviewer`.
   - `from` omitted and no usable recorded origin ⇒ `targetTerminalOverride` is
     `undefined` and `teamRouting` names the fallback. **The dispatch still happens** —
     assert `triggerAction` was called.
   - An explicit caller-supplied `targetTerminalOverride` is never overwritten.
   - `resolveKanbanDispatch` unwired (no `gate`) ⇒ `teamRouting` reports the
     role-unavailable fallback and the dispatch still fires (audit item 13).
5. **Regression — the custom-user branch.** Configure `CODE REVIEWED` as a custom column
   (`dispatchSpec.source === 'custom-user'`), dispatch with `from`, and assert the
   override reaches `dispatchConfiguredKanbanColumnAction`. Without the Change 4 edit this
   test fails while everything else passes — that is the point of having it.
6. **Regression — single-team and no-team boards.** With one team, and with zero
   registered groups, assert the chosen reviewer is byte-identical to the pre-change
   resolution. This change must be a no-op for every board that is not multi-team.
7. **Regression — planner rotation.** Dispatch to `PLAN REVIEWED` with several planner
   terminals and assert the round-robin cursor still advances exactly as before (the
   `custom-user` precedence edit sits directly on that path).

### Manual

8. **The reported scenario.** Start two `Coding` teams with distinct names. Dispatch a
   subtask to team A's coders, let it finish, advance it to `CODE REVIEWED` with `from`
   set to team A's head. Confirm team A's reviewer receives the prompt and team B's
   reviewer receives nothing. Repeat from team B.
9. **Drag-and-drop path (the Change 0 proof).** Drag a card from `PLAN REVIEWED` to
   `CODER CODED` so team A's coder picks it up. Inspect the plan row and confirm
   `dispatched_agent` is now that coder's terminal name and **not** `'unknown'` — this
   assertion fails on today's build and is the whole reason Change 0 exists. Then drag the
   card from `CODER CODED` to `CODE REVIEWED` (no `from` available) and confirm team A's
   reviewer gets it.
10. **Dead reviewer.** Kill team A's reviewer, then advance a team A card. Confirm the
    dispatch still lands somewhere live and the response/log names the fallback rather
    than failing silently or dispatching into the closed pty.

---

**Recommendation:** Complexity 8 → **Send to Lead Coder**.

---

## Completion Summary

Implemented Changes 0–6 (Change 6's `kanban.html` supersede honoured — only the SKILL.md documentation was added). Change 0 fixes the `dispatched_agent` writer: `handleKanbanTrigger` now records whenever a target column resolved (not only on an explicit column), and the `KanbanProvider` built-in branch records only when it has a name of its own, so the drag path no longer writes the literal `'unknown'`. Change 1 adds the pure `resolveTeamScopedRoleTerminal` helper plus a shared `plausibleOriginTerminal` origin filter to `src/services/teamWiring.ts` (appended only; the protected `wireSpawnedTeam` head-order block and `headPrompt` option are untouched). Changes 2 and 5 wire team-scoped resolution into `TaskViewerProvider` — a public `resolveTeamRoleTerminal` method unions the pty fleet with the VS Code registry, and `_resolveAgentTerminalForPlan` now takes an optional `originTerminal` placed after the worktree match and before the fleet first-match, threaded from the drag path via the same origin filter. Change 3 makes `POST /kanban/dispatch` accept `from`, computes a team-correct `targetTerminalOverride` with a four-step origin precedence, echoes a `teamRouting` decision string (including fallbacks), declares the `resolveTeamRoleTerminal` callback on `LocalApiServerOptions`, and wires it in both the extension-host and standalone composition roots. Change 4 makes the `custom-user` dispatch branch honour a caller-supplied `targetTerminalOverride` with the same precedence as the built-in branch. Per instructions, `src/webview/kanban.html`, `src/services/standingOrders.ts`, and `src/test/standing-orders-marker-contract.test.js` were not touched; compilation and automated tests were skipped.

### Automated Tests (Verification Plan items 1–7)

Authored `src/test/team-scoped-role-routing.test.js` covering all seven automated test items from the Verification Plan. Items 1, 2, and 4 are full logic tests exercising the compiled helpers and `LocalApiServer.performKanbanDispatch` with stubbed options; items 3, 5, 6, and 7 use source-text structural assertions (the established pattern in this codebase for deeply embedded provider methods) to pin the one-line guards and ordering contracts that make the fix work. Item 1 includes the explicit regression assertion (`Backend-reviewer` is NOT returned for `lead-1`), the dead-reviewer liveness check, the role-match-ignores-names cases, the shared-member-in-two-groups case, and the `order`-vs-`members` selection case. Item 4 tests the `from` field, the no-origin fallback (asserting `triggerAction` still fires), the explicit-override precedence, the `resolveKanbanDispatch`-unwired fallback, the `dispatched_terminal`-from-record origin path, and the `from`-beats-conflicting-record precedence (record carries `dispatchedTerminal: 'lead-2'` → `Backend-reviewer`, caller supplies `from: 'lead-1'` → `Coding-reviewer` wins). Tests were not run per instructions.

**Review fix applied:** the item 2 "explicit from beats a conflicting recorded value" case was originally a local `||` expression that asserted the JavaScript operator, not the product. Replaced with an executable `performKanbanDispatch` case in item 4: record carries `dispatchedTerminal: 'lead-2'` (resolves to `Backend-reviewer` via the stub), caller supplies `originTerminal: 'lead-1'`, assert `triggerAction` receives `Coding-reviewer` and NOT `Backend-reviewer`, with `teamRouting` naming `lead-1`. The first half of the old item 2 test (the filter returning the recorded name) is retained.

---

## Review Findings

Reviewed 2026-08-16 with tests executed (this dispatch carried no skip directive; the "tests were not run" note above is a record of the coding pass, not an instruction to the reviewer). Changes 0–6 are all present and correct end-to-end — the origin filter and resolver in `teamWiring.ts:872,906`, `resolveTeamRoleTerminal` in `TaskViewerProvider.ts:9457` unioning fleet + registry, `from`/four-step precedence/`teamRouting` echo in `LocalApiServer.ts:1216,1314-1342,1371`, the callback declared at `:219` and wired in **both** composition roots (`TaskViewerProvider.ts:2971`, `bootstrap.ts:2039`), the `custom-user` override precedence at `KanbanProvider.ts:8730`, Change 0's two writers at `TaskViewerProvider.ts:20624` / `KanbanProvider.ts:8848`, and the `from` row in the orchestration SKILL.md; caller tracing confirms the drag path and the single-card custom-user path both reach the new origin threading via `handleKanbanTrigger → _handleTriggerAgentActionInternal`, and `dispatchConfiguredKanbanColumnAction` does forward `targetTerminalOverride`, so Change 4 is not a no-op. Two MAJOR findings, both in the verification layer rather than the source: `src/test/team-scoped-role-routing.test.js` had **no `package.json` script and no CI step** — the plan's entire `### Automated Tests` section was an orphan file nothing could run (fixed: added `test:contract:team-scoped-routing` and a CI step after "Compile test outputs", which the suite depends on for `out/`); and 8 of its 41 assertions failed on correct source — five undersized source-text windows, one asserting a named-argument `isIdeDispatch: true` call shape that has never existed (it is the 5th positional parameter), one asserting a flat `dispatched && plannerCursorLocationKey && tvp` conjunction against the shipped two-level nested guard, and a `makeServer` sentinel using `=== undefined` that silently reinstalled the default gate, so audit item 13's unwired-standalone case never actually ran. Validation after fixes: `tsc -p tsconfig.test.json --noEmit` exit 0, `compile-tests` exit 0, `team-scoped-role-routing` 41 passed / 0 failed, `standing-orders-marker` 40/40, `terminal-plan-attribution` 27/27, `paste-attribution` 8/8, `kanban-dispatch-callers:check` 5/5, plus `parity:check`, `catalog:check`, `verb-returns:check`, `push-routing:check` green and eslint 0 errors. Remaining risks: manual steps 8–10 (two-team scenario, drag-path `dispatched_agent` proof, dead reviewer) need live teams and were not run; Change 0 is a visible change on ~4,000 installs — dragged cards now display the resolved terminal where they displayed `unknown`, which belongs in the release note; standalone still reports the role-unavailable fallback until `resolveKanbanDispatch` is wired there (audit item 13, deliberately out of scope); and when a caller override fails `_isValidAgentName` the origin is never computed (`TaskViewerProvider.ts:20438`) so routing degrades to team-blind — identical to pre-change behaviour, not a regression.

## Completion Summary — review pass

Reviewer pass fixed the verification layer only; no source behaviour was changed. Files changed: `src/test/team-scoped-role-routing.test.js` (8 assertion fixes), `package.json` (new `test:contract:team-scoped-routing` script), `.github/workflows/integration-tests.yml` (new CI step wiring that suite). The suite now runs 41/41 green and is CI-invoked, closing the "defined but never invoked" hole. No issues remain in the implementation itself.
