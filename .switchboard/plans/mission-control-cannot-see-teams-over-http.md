# Mission Control cannot see teams over HTTP, so it cannot answer its own pre-flight or read the pacing that routes work

<!-- board-collapse-01 -->
> **RESCOPED 2026-09-04 (Board Collapse 01).** The appended out-of-scope finding, that standalone does not wire `resolveTeamPacing` / `resolveTeamMembers` into its `LocalApiServer` options, is **no longer true** — commit `cf57044b` wires both. Strike that paragraph; it must not be filed as a separate plan. The `GET /teams` endpoint work is unaffected.


## Goal

Expose the configured team roster — groups, roles, head, and `pacing` — over the local API, so
Mission Control can tell a seated *team* from a lone agent, name the lead, and read the pacing mode
that decides where a card lands. Today none of that is reachable over HTTP, and the only reader is
private.

### Problem Analysis

**The pre-flight asks a question the API cannot answer.** `.agents/protocols/switchboard-mission-control/SKILL.md:167`,
check 1:

> **Is there a coding *team* for the features in scope — not merely a coding agent?**

and check 2, the same for a planner. Neither has a prescribed command, and neither can have one:

- `GET /health` (`LocalApiServer.ts:7319-7337`) returns `terminals` as a **flat array of names** plus
  `terminalCount`. No roles, no group membership, no head, no pacing.
- The only reader of the roster, `_readRegisteredTeamGroups` (`LocalApiServer.ts:4869`), is
  **private with no route**. It reads `TERMINALS_GROUPS_KEY` and the legacy `terminals.groups`
  straight from the kanban DB config, deduplicating by id with the current key winning.

So an agent told to check whether a *team* is seated has two options: infer from terminal names, or
read the database. Both are what the protocol elsewhere forbids, and the second is why startup
reaches for SQL.

**The same gap breaks dispatch routing, which is the more expensive consequence.** Hard Rule 6
(`:39-42`) routes work through `POST /kanban/queue/next` with `{ from: "<lead terminal name>" }`,
and where the card lands depends on the team's `pacing`: **head** hands it to the lead, **seat**
routes it to the complexity-matched seat. `:244` is explicit that pacing is a field the agent
**reads and does not set** — "Setting pacing is the operator's call on the team."

But there is no way to read it. `resolveTeamPacing` (`KanbanProvider.ts:5539`) returns `'head'` when
the head leads no registered group or the DB is unavailable, and `LocalApiServer.ts:1917` resolves
`pacingOverride ?? 'head'`, with `:1751` naming `'head'` as "the regression gate for ~4,000
installs". The backend therefore defaults every unconfigured team to the lead — correctly — while
the agent, unable to see the field, cannot state which mode it is in, cannot name the lead it should
address, and cannot explain a destination after the fact.

**Two things the agent must not do in place of reading it.** It must not infer pacing from a plan's
complexity — that is a backend decision returned in the `queue/next` response — and it must not read
the DB. Removing the guesswork requires giving it the field.

**The pre-flight's remaining checks have the same shape.** Checks 3 (a researcher for an active
research prompt) and 4 (worktree strategy vs board state) are also server-side state with no
prescribed query. Only check 5 is instrumented, via the `ready ()` helper at `:104-112`.

### Root Cause

Team composition is configuration held in DB config keys, consumed internally by the extension and
never surfaced. The HTTP surface grew around plans, cards and features — the things a board renders —
while the fleet's *shape* stayed an implementation detail. Mission Control is the first consumer that
needs it, and it arrived after the surface was drawn.

### Non-goals

- **Not changing routing.** `resolveTeamPacing`, the complexity bands, `queue/next` and the head
  default are correct and are the ~4,000-install regression gate. This exposes state; it does not
  alter behaviour.
- **Not letting the agent set pacing.** Read-only, per `:244`.
- **Not redesigning teams.** Surfacing a roster that already exists.
- **Not changing `/health`.** Its `terminals: string[]` shape has consumers, and older builds omit
  the field entirely.

## Metadata

**Complexity:** 4
**Tags:** feature, backend, api, reliability
**Project:** Browser Switchboard

## User Review Required

Yes — one decision.

**One pre-flight endpoint, or a teams endpoint the agent composes with?**
Recommendation: **a teams endpoint** — `GET /teams?workspaceRoot=…` returning the configured groups
with headRole, head, `pacing`, and each member's live status. Reasons:

- It answers checks 1 and 2 directly *and* serves the dispatch path, which needs pacing and the lead
  name at a different moment from startup. A pre-flight-shaped endpoint would be re-fetched for
  routing anyway.
- It is a fact about the workspace, not a report, so it stays useful as the protocol changes.
- Checks 3 and 4 are different domains (a prompt setting, a worktree strategy) and bundling them
  produces an endpoint that changes whenever the pre-flight does.

The alternative — one `GET /mission-control/preflight` answering all six — makes startup a single
call, which is genuinely attractive. It is the better choice if you expect the pre-flight to stay
stable; the teams endpoint is better if you expect the checks to move.

## Complexity Audit

### Routine

- Routing a read to an existing private method (`_readRegisteredTeamGroups`).
- Adding one import (`readTeamPacing`) to an existing import statement (`LocalApiServer.ts:29`).
- Adding one route arm to the if-else chain (`LocalApiServer.ts:7553+`, near the other GET endpoints).
- Using the existing `_handleReadEndpoint` helper for auth + response envelope (`LocalApiServer.ts:5925`).
- Regenerating `protocol-catalog.json` via `npm run catalog:generate`.
- Updating two protocol skill files (documentation only).

### Complex / Risky

- **Call `_readRegisteredTeamGroups`; do not reimplement it.** Its own comment warns that "two
  hand-copied loops over the same two config keys is exactly how one of them ends up reading a key
  the other does not." It reads both `TERMINALS_GROUPS_KEY` and legacy `terminals.groups` and dedups
  by id with the current key winning.
- **Legacy-key installs must not read as "no team".** Many of the ~4,000 installs may hold only the
  legacy key. A confident "no coding team seated" to an operator who has one is worse than the
  probing it replaces — it stops a session that would have run.
- **Configured and live are different facts and must stay separate fields.** The roster is
  configuration; `/health` `terminals` is liveness. Conflating them reports a configured-but-dead
  team as seated.
- **Absent `pacing` must serialise as `head`, not null or missing.** That is what the backend
  resolves it to (`:1917`), and an agent seeing `null` will invent a meaning.
- **No new composition-root seam is needed.** The endpoint is self-contained in `LocalApiServer`:
  `_readRegisteredTeamGroups` is a private method on the same class, `readTeamPacing` is a pure
  function from `teamWiring.ts` (already imported at `:29`), and `getRegisteredTerminals` is already
  wired in both hosts (`TaskViewerProvider.ts:3728`, `bootstrap.ts:2765`). No callback addition, no
  composition-root wiring, no divergence risk. (See Superseded callout in Proposed Changes.)
- **Auth and workspace scoping are not optional.** Same `_checkAuth` as every neighbour (via
  `_handleReadEndpoint`), and `workspaceRoot` honoured — a bare call must not silently answer for
  the primary root.

> **Superseded:** Wire the seam in both composition roots — `src/extension.ts` and
> `src/standalone/bootstrap.ts` — and show both in the diff.
> **Reason:** The endpoint needs no new composition-root seam. `_readRegisteredTeamGroups` is a
> private method on `LocalApiServer` itself — the route handler calls it directly. `readTeamPacing`
> is a pure function already importable from `teamWiring.ts` (the file is already imported at
> `LocalApiServer.ts:29`; only `readTeamPacing` needs adding to the named imports).
> `getRegisteredTerminals` is already wired in both hosts. Creating a callback seam to reach data
> the class already holds is the exact over-engineering that creates the wiring gap CLAUDE.md warns
> about — the plan was building a bridge over flat ground.
>
> **Related pre-existing finding (out of scope):** The standalone host does NOT wire
> `resolveTeamPacing` or `resolveTeamMembers` in its `LocalApiServer` options — it wires them on the
> `ingestionEngine` (the queue watch/sweep) only. This means `dispatchNextFromQueue` in standalone
> always uses head pacing regardless of the team's configured pacing. The self-contained approach
> (`readTeamPacing` on the group object) avoids inheriting this bug. Fixing the standalone
> `LocalApiServer` options gap is a separate plan — this one exposes state, it does not fix dispatch.

## Edge-Case & Dependency Audit

**Race conditions**
- A terminal dies between the read and a dispatch. Unavoidable and handled downstream (`:42` — no
  lead, record it and continue). The response is a snapshot and should be described as one.
- Config rewritten mid-read: last-writer-wins on a config key, no partial state observable.

**Security**
- Terminal names, roles and pacing are not secret, but the route must carry the same auth gate as its
  neighbours (via `_handleReadEndpoint` → `_checkAuth`) rather than becoming the one unauthenticated
  read. No prompts, tokens or paths in the payload.

**Side effects**
- Once pacing is readable, reports should name the mode and the destination returned by
  `queue/next` — not a predicted one. Worth stating in the protocol at the same time.
- A team configured with no live members becomes visibly distinguishable from no team at all, which
  changes what the pre-flight says for some workspaces. That is the point.

**Migration**
- New read endpoint. No schema change, no stored state, no settings. The legacy `terminals.groups`
  key is read and never rewritten, so nothing migrates and no install changes behaviour.

## Dependencies

- **Unblocks pre-flight checks 1 and 2**, which cannot be instrumented without it.
- **Serves the dispatch path** described at `:39-42` and `:244`.
- **Related:** `the-ready-list-format-collapses-when-it-is-rendered.md` — the pre-flight report ends
  with that summary; independent of this.

## Adversarial Synthesis

Key risks: (1) reimplementing the roster read and missing the legacy `terminals.groups` key, so older
installs get a confident "no coding team seated" and a session stops — the failure the method's own
comment predicts; (2) enriching `/health` instead of adding a route, breaking its consumers and the
older-build case where `terminals` is absent; (3) merging configured and live so a dead team reads as
seated; (4) creating an unnecessary composition-root seam wired in one host only — superseded: the
endpoint is self-contained, no seam needed; (5) serialising an absent `pacing` as null, so an agent
invents a third mode; (6) promising per-member roles the group object does not carry — the registered
group stores `members: string[]`, not role-tagged objects. Mitigations: call
`_readRegisteredTeamGroups` and test a legacy-key-only workspace explicitly; add a new route and
assert `/health` is byte-identical; keep configured and live as separate fields; use `readTeamPacing`
directly on each group object (no callback, no composition-root wiring); normalise absent pacing to
`head` at the boundary; and return `headRole` + member names + live status, not per-member roles.

## Proposed Changes

### `src/services/LocalApiServer.ts`

**Context:** The server's if-else route chain (`:7319+`) handles every HTTP path. GET read endpoints
use the `_handleReadEndpoint` helper (`:5925`) for auth + `{ success: true, data }` envelope.
`_readRegisteredTeamGroups` (`:4869`) is a private method on the same class that reads both
`TERMINALS_GROUPS_KEY` and legacy `terminals.groups`, deduplicating by id. `readTeamPacing`
(`teamWiring.ts:143`) is a pure function: `group?.pacing === 'seat' ? 'seat' : 'head'`.
`getRegisteredTerminals?.()` (options callback, already wired in both hosts) returns `string[]` of
live terminal names. `teamHeadName` (`teamWiring.ts:1197`, already imported) extracts the `head`
field from a group.

**Logic:**

1. **Add `readTeamPacing` to the existing import** from `./teamWiring` at `:29`:
   ```typescript
   import { plausibleOriginTerminal, describeStandingOrderMigrations, TERMINALS_GROUPS_KEY, applyTeamQueueOrders, teamHeadName, installGlobalQueueDoneOrder, readTeamPacing } from './teamWiring';
   ```

2. **Add a `_handleGetTeams` method** that:
   - Calls `_readRegisteredTeamGroups(workspaceRoot)` for the roster (reuses the private method —
     no second loop over config keys).
   - For each group, extracts: `id`, `name` (head terminal name), `head` (via `teamHeadName(group)`),
     `headRole` (group's `headRole` field, defaults to `'lead'`), `pacing` (via `readTeamPacing(group)` —
     normalises absent to `'head'`), `members` (group's `members` array, `string[]` of terminal names),
     `externalHead` (boolean).
   - Calls `this._options.getRegisteredTerminals?.()` for the live terminal name set. Cross-references
     each member name against this set to produce a per-member `live: boolean` flag. When
     `getRegisteredTerminals` is absent (headless/test), all members get `live: false`.
   - Returns `{ teams: [...], snapshot: true }` — the `snapshot` field signals the response is a
     point-in-time read, not a live subscription.

3. **Add a route arm** in the if-else chain near the other GET endpoints (around `:7553`):
   ```typescript
   } else if (pathname === '/teams' && req.method === 'GET') {
       await this._handleReadEndpoint(req, res, async () => {
           const wsRoot = new URL(req.url || '', `http://localhost:${this._port}`)
               .searchParams.get('workspaceRoot') || undefined;
           return await this._handleGetTeams(wsRoot);
       });
   }
   ```
   The `_handleReadEndpoint` wrapper provides `_checkAuth` and the `{ success: true, data }` envelope.
   The `workspaceRoot` query param is read the same way `_resolveDbFromQuery` (`:6241`) reads it.

**Concrete response shape:**
```json
{
  "success": true,
  "data": {
    "snapshot": true,
    "teams": [
      {
        "id": "team_Coding",
        "name": "Coding",
        "head": "Coding",
        "headRole": "lead",
        "pacing": "head",
        "externalHead": false,
        "members": [
          { "name": "Coding", "live": true },
          { "name": "Coding-coder-1", "live": true },
          { "name": "Coding-coder-2", "live": false }
        ]
      }
    ]
  }
}
```

**Clarification — "members with roles":** The registered group object stores `members` as `string[]`
(terminal names), not role-tagged objects. The group carries `headRole` (one field for the head's
role), but per-member roles are in template definitions (`terminals.agentGroups`), not on the
registered group. The endpoint returns `headRole` + member names + per-member `live` status. This is
sufficient for pre-flight checks 1 and 2, which ask "is there a team?" and "is there a planner?" —
answerable from `headRole` + member count + liveness. Per-member roles are out of scope for this
read-only state endpoint.

**Edge Cases:**
- Empty roster (no groups configured): returns `{ teams: [], snapshot: true }` — not an error.
- `getKanbanDatabase` absent (headless/test): `_readRegisteredTeamGroups` returns `[]` (it checks
  `if (!db) return []`), so the endpoint returns `{ teams: [], snapshot: true }`.
- Legacy-key-only workspace: `_readRegisteredTeamGroups` reads both keys and dedups — legacy groups
  appear in the response.
- `getRegisteredTerminals` absent: all members get `live: false`.

### `protocol-catalog.json`

**Context:** The catalog is generated by `scripts/generate-protocol-catalog.js` which scans
`LocalApiServer.ts`'s if-else chain for route arms. It is the CI parity gate (`catalog:check`) and
the discoverability layer (`GET /catalog`).

**Implementation:** After adding the `/teams` route arm, run:
```bash
npm run catalog:generate
```
This writes the updated `protocol-catalog.json` and verb allowlists. The new `/teams` GET endpoint
will appear in the catalog automatically — the generator scans the if-else chain.

### `.agents/protocols/switchboard-mission-control/SKILL.md`

**Context:** The pre-flight checks 1 and 2 (`:167-186`) are uninstrumented prose — they describe what
to check but prescribe no command. Check 5 is the only instrumented one (via the `ready()` helper at
`:104-112`). The handoff sequence (`:254-278`) and pacing discussion (`:244`) reference pacing as a
field the agent reads but cannot currently read.

**Implementation:**
1. **Instrument checks 1 and 2** with a `curl` to `GET /teams?workspaceRoot=$WS` that the agent runs
   before reporting. The check logic:
   - Check 1 (coding team): filter teams where `headRole === 'lead'` and `members.length > 1` (a
     team, not a lone agent). If features are in scope and no such team exists with at least one live
     member, report it and name the features at risk.
   - Check 2 (planner): filter teams where `headRole === 'planner'`. If planning-stage work is in
     scope and no such team exists, report it.
2. **State the routing contract** where pacing is discussed (`:244`): read the mode from
   `GET /teams` to know who you are addressing; take the actual destination from the `queue/next`
   response; never infer either from complexity.

### `.agents/protocols/switchboard-mission-control-http/SKILL.md`

**Context:** The HTTP surface skill documents every endpoint agents use. The read-endpoint table is
at `:62-73`. A new endpoint must be added there.

**Implementation:** Add `GET /teams` to the read-endpoint table:
```
| `GET /teams?workspaceRoot=<root>` | `{ teams: [{ id, name, head, headRole, pacing, externalHead, members: [{ name, live }] }], snapshot: true }` — configured team roster with pacing and per-member liveness |
```
Add a `curl` example to the examples block (`:74-80`):
```bash
curl -s "$BASE/teams?workspaceRoot=$WS"
```

### Migration

New read endpoint; no schema, settings or stored-state changes. The legacy `terminals.groups` config
key is read and never rewritten, and `/health`'s payload is unchanged, so no existing client — older
builds included — changes behaviour.

## Verification Plan

1. **Checks 1 and 2 answerable over HTTP.** Run the pre-flight; assert both are answered from this
   endpoint with **zero** direct `kanban.db` reads by the agent.
2. **Team vs lone agent.** Configure a team; assert check 1 passes. Remove the group leaving a single
   coding agent; assert check 1 reports it and names the features at risk.
3. **Legacy roster is found.** On a workspace whose teams live **only** under `terminals.groups`,
   assert the roster returns and check 1 does not report "no coding team seated".
4. **Current key wins on conflict.** With both keys populated and overlapping ids, assert dedup
   matches `_readRegisteredTeamGroups` exactly.
5. **Configured ≠ live.** Configure a team, kill its terminals; assert the response marks it
   configured and not live, and the pre-flight says so rather than "seated".
6. **Pacing is readable and defaults correctly.** A team with no `pacing` field reports `head`;
   a team set to `seat` reports `seat`. Assert it matches `resolveTeamPacing` for the same input.
7. **Routing uses the response, not a guess.** Dispatch under each mode; assert the agent names the
   destination returned by `queue/next` and never derives one from complexity.
8. **`/health` byte-identical.** Snapshot before and after, including the older-build case where
   `terminals` is absent.
9. **Auth enforced.** Unauthenticated call returns 401 via the same `_checkAuth` path.
10. **Workspace scoping.** In a multi-root setup, call with a non-primary `workspaceRoot`; assert the
    response describes the requested root.
11. **Both hosts.** Identical payload shape from the VS Code extension host and standalone
    `npx switchboard`. No composition-root wiring was added — verify the endpoint works in both hosts
    without any changes to `extension.ts` or `bootstrap.ts`.
12. **Catalog updated.** Run `npm run catalog:check` after `catalog:generate`; assert it passes and
    `/teams` appears in `GET /catalog`.

### Goal Invariants

- Assert `GET /teams` exists at `src/services/LocalApiServer.ts` (route arm matching `pathname === '/teams'`).
- Assert `readTeamPacing` is in the named imports from `./teamWiring` at `LocalApiServer.ts:29`.
- Assert `GET /health` response shape is unchanged (no `teams` field added to `/health`).
- Assert no new callback was added to `LocalApiServerOptions` interface (no `getTeamRoster` or similar).
- Assert `/teams` appears in `protocol-catalog.json` after `catalog:generate`.
- Assert `GET /teams` is documented in `.agents/protocols/switchboard-mission-control-http/SKILL.md` read-endpoint table.
- Assert pre-flight checks 1 and 2 in `.agents/protocols/switchboard-mission-control/SKILL.md` prescribe `GET /teams` as the query command.
