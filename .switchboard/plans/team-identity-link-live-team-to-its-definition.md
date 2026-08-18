# Link a Live Team Back to Its Definition (Team Identity Foundation)

## Goal
Record, at team-spawn time, which team **definition** a live team came from, so any surface can resolve a running terminal to its team and read that team's properties (icon, name, head, roster). Today that link does not exist, and it is the single blocker under every team-scoped feature.

### The problem, and the root cause
A team stops existing the moment it is spawned. `wireSpawnedTeam` (`src/services/teamWiring.ts:896`) is the only place a started team leaves a trace the UI can read, and it writes exactly one record into `terminals.groups`:

```js
{ id: 'team_<head>', name: headName, source: 'manual', layout, members, order }
```

Three things are wrong with that record for our purposes:

1. **No definition id.** `wireSpawnedTeam` accepts an optional `opts.teamId`, but the sole real caller — `instantiateAgentGroupCore` at `src/services/agentGroupInstantiation.ts:123` — does not pass it. So `groupId` always falls through to the `'team_' + encodeURIComponent(headName)` derivation at `teamWiring.ts:914`. The definition's own id (`group-<slug>-<base36ts>`, minted in `teamsTabSaveAgentGroup`, `src/webview/kanban.html:5330`) is never written down anywhere. Nothing can get from a live terminal to the definition that produced it.
2. **No head marker.** The head is `order[0]` by convention only. Nothing declares it.
3. **`source: 'manual'` — deliberately.** The comment at `teamWiring.ts:1030` explains why: the webview loader (`src/webview/terminals.js:1541`) silently discards any group whose `source` is not `manual`/`role`/`worktree`. A live team is therefore forced to disguise itself as a hand-saved selection, and the UI cannot tell the two apart.

Consequence: every team verb an operator wants — clear just this team, queue work to this team, run an automation on this team's lead, edit this team's standing order, show this team its own icon — would have to re-derive "which terminals are this team, and which one leads" from scratch. That is why none of them exist. The UI is not badly designed; the data model hands it nothing to render.

### Why not just add `source: 'team'`
Because `terminals.js:1541` drops unknown sources, and this extension is published with ~4,000 installs on mixed versions. A group written as `source: 'team'` by a new build vanishes from an older panel's sidebar and tab strip — the team becomes invisible and unseatable. Additive fields on a `manual` group are the compatible move: `loadLayoutSettings` returns the object **unchanged** for `source === 'manual'` (`terminals.js:1542`), so extra keys survive the load/save round trip untouched, and an old build simply ignores them.

## Metadata
- **Complexity:** 4
- **Tags:** backend, frontend, refactor, reliability

## Approach

### 1. Thread the definition id through the spawn path
- `src/services/agentGroupInstantiation.ts:123` — pass `definitionId: group?.id` into the `wireSpawnedTeam` call. Do **not** pass it as `teamId`: `teamId` selects the `terminals.groups` record id and the standing-order key, and changing that derivation would orphan every team-scoped standing order on existing installs (they are keyed `(scope, teamId)`, `teamWiring.ts:978`). `definitionId` is a new, separate field.
- `WireSpawnedTeamOptions` (`teamWiring.ts:828`) — add `definitionId?: string`.

### 2. Stamp identity onto the registered group
In the group literal at `teamWiring.ts:1036` and the upsert merge at `teamWiring.ts:1057`, add:
- `definitionId` — the `terminals.agentGroups` id, when known.
- `head` — `headName`, declared rather than implied by `order[0]`.
- `teamKind: 'spawned'` — a positive marker that this `manual` group is a real team, so a UI can distinguish it from a hand-saved selection without inferring from the id prefix.

Keep `source: 'manual'`, keep the existing `id` derivation, keep the existing `...existing` spread in the merge (it is what preserves unknown keys — do not replace it with a fresh literal).

### 3. One shared resolver, used by every consumer
Add to `teamWiring.ts`:
```ts
export function isSpawnedTeamGroup(g: any): boolean
export function teamHeadName(g: any): string | undefined
export async function resolveDefinitionForGroup(db: any, g: any): Promise<any | null>
```
`resolveDefinitionForGroup` resolution order:
1. `g.definitionId` → `resolveTeamById` (the exact path, for groups written by this build onward).
2. Fallback for pre-existing groups with no `definitionId`: match the head terminal's **role** against `headRole` across `terminals.agentGroups`, accepting only a unique match (`findTeamForHeadRole`, `teamWiring.ts:615`, already does exactly this and filters `!g.unassigned` — reuse it, do not reimplement).
3. Otherwise `null`. Every consumer must render a sane default when this returns `null`.

No backfill migration, and no rewrite of existing rows. The fallback covers already-running teams for the life of their session; the next spawn writes the precise link. Per CLAUDE.md a no-op migration costs nothing, but here there is genuinely nothing to migrate — the field being absent is correctly handled by step 2, and mutating shipped group records to guess at a definition id risks binding a team to the wrong definition.

### 4. Expose it to the webviews
`GET /terminals/groups` (or the existing settings read the panel already performs, `terminals.js:1535`) must carry the new fields through unchanged. Confirm no serialisation layer between the DB and the panel whitelists group keys — if one does, widen it rather than special-casing the three new names.

## Edge cases
- **Two teams, same head role, same workspace.** `startTeamById` (`teamWiring.ts:805`) already refuses a second live head for a role, so the `team_<head>` id cannot collide within a workspace. The role-match fallback in step 3 is only ambiguous across *definitions*, which is why it demands a unique match.
- **Head renamed.** `rewriteStandingOrdersForRename` (`standingOrders.ts:60`) rewrites orders but not the group's `head`/`id`. Extend the rename path to rewrite `head` on any group where it matches. The group `id` stays as-minted — it is an identity, not a display name.
- **Definition deleted while the team runs.** `resolveDefinitionForGroup` returns `null`; consumers fall back to the group's own `name`. The live team must not disappear because its template was deleted.
- **Definition edited while the team runs.** The link is by id, so the live team picks up the edited definition's icon/name on next read. That is the desired behaviour, not a staleness bug.
- **An old build writes the group.** No `definitionId`, no `head`, no `teamKind` — step 3's fallback handles it. A new build must never assume the fields are present.

## Verification Plan
1. `npm run compile` — clean (this touches TS in two hosts; `teamWiring.ts` is shared).
2. Unit: `wireSpawnedTeam` with `definitionId` set writes all three fields; without it, writes neither `definitionId` nor a wrong value, and still produces a loadable `manual` group.
3. Unit: the upsert path preserves an operator-authored `layout` **and** an unrelated unknown key on an existing group row while adding the new fields (pins the `...existing` spread).
4. Unit: `resolveDefinitionForGroup` — exact hit by `definitionId`; unique role-match fallback; `null` on ambiguous role match; `null` on deleted definition.
5. Contract test: a group record carrying the three new fields survives `loadLayoutSettings` (`terminals.js:1541`) byte-identically. This is the compatibility claim the whole plan rests on — pin it.
6. Manual, in an installed VSIX: start a team from the TEAMS tab; read `terminals.groups` and confirm `definitionId` matches the definition's `id`, `head` matches the head terminal, `source` is still `manual`. Confirm the team still appears as a tab in the group strip and still seats correctly.
7. Regression: existing team-scoped standing orders still apply after this change — the `teamId` derivation must be untouched. Run `standing-orders-marker-contract.test.js` and `stage-marker-commit-contract.test.js`.
