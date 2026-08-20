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
- **Project:** browser-switchboard
- **Feature:** 72bda17f-bb0c-4ad9-b9b9-55c19fc9cba7

## User Review Required
No user review required — the additive-fields compatibility strategy is determined, and the approach is fully specified with file paths and line numbers.

## Complexity Audit

### Routine
- Adding three fields (`definitionId`, `head`, `teamKind`) to an existing object literal and upsert merge.
- Threading one parameter (`definitionId`) through a single call site (`agentGroupInstantiation.ts:123`).
- Writing three small helper functions (`isSpawnedTeamGroup`, `teamHeadName`, `resolveDefinitionForGroup`).

### Complex / Risky
- The serialisation whitelist check — if a layer between DB and panel strips unknown group keys, the fields silently vanish. This is a **design prerequisite** to investigate before coding, not a verification step.
- The `head` vs `order[0]` contract — every consumer must read `head`, never infer from position. A consumer that infers from `order[0]` will disagree with one that reads `head` when they diverge.
- The role-match fallback's temporal edge case — a definition whose `headRole` was edited after spawn no longer matches the live terminal's role. Acceptable (resolves on next spawn) but must be documented.

## Edge-Case & Dependency Audit
- **Race Conditions:** `wireSpawnedTeam` upserts `members` and `order` on re-spawn (`teamWiring.ts:1052`). A concurrent reader (e.g. a cockpit poll) may see a group mid-upsert. The `...existing` spread in the merge mitigates this — unknown keys survive — but a reader that caches the group at open time and never re-reads will go stale.
- **Security:** No new attack surface. The fields are written by the spawn path, not by user input. `resolveDefinitionForGroup` reads from the DB, not from caller-supplied data.
- **Side Effects:** Adding fields to the group record increases the size of `terminals.groups` in the DB config blob. Negligible (three short strings per team).
- **Dependencies & Conflicts:** Every other subtask in this feature depends on this plan. The `isSpawnedTeamGroup` / `resolveDefinitionForGroup` / `teamHeadName` helpers are the seam. No conflicts with plans outside this feature — the fields are additive and ignored by old code.

## Dependencies
- None — this is the foundation plan. Every other subtask in this feature depends on the identity link and resolvers established here.

## Adversarial Synthesis
Key risks: (1) a serialisation whitelist between DB and panel could silently strip the new fields — must be investigated as a design prerequisite before coding; (2) the `head` vs `order[0]` contract is implicit and every consumer must honour it explicitly; (3) the role-match fallback has a temporal edge case when a definition's `headRole` is edited post-spawn. Mitigations: investigate the serialisation path before coding; document the `head`-not-`order[0]` contract in the helper functions' JSDoc; accept the temporal edge case as it resolves on next spawn.

## Proposed Changes

### `src/services/agentGroupInstantiation.ts`
- **Context:** The sole real caller of `wireSpawnedTeam` does not pass the definition id today.
- **Logic:** Pass `definitionId: group?.id` into the `wireSpawnedTeam` call at line 123.
- **Edge Cases:** `group` may be `null` (manual spawn without a definition) — `group?.id` safely yields `undefined`, and `wireSpawnedTeam` treats an absent `definitionId` as "unknown definition" (fallback to role-match).

### `src/services/teamWiring.ts`
- **Context:** The group record written by `wireSpawnedTeam` lacks identity fields. The rename path does not rewrite `head`.
- **Logic:** Add `definitionId?: string` to `WireSpawnedTeamOptions` (line 828). Stamp `definitionId`, `head` (`headName`), and `teamKind: 'spawned'` onto the group literal (line 1036) and upsert merge (line 1057). Add `isSpawnedTeamGroup(g)`, `teamHeadName(g)`, `resolveDefinitionForGroup(db, g)` exports. Extend `rewriteStandingOrdersForRename` to also rewrite `head` on any group where it matches the old name.
- **Edge Cases:** Keep `source: 'manual'`, keep the existing `id` derivation, keep the `...existing` spread. Do not replace the merge with a fresh literal — the spread is what preserves unknown keys.

### `src/webview/terminals.js`
- **Context:** The panel reads group records from the DB via `loadLayoutSettings` (line 1541). If a serialisation layer whitelists group keys, the new fields are stripped.
- **Logic:** Investigate the serialisation path between DB and panel. If a whitelist exists, widen it to pass through unknown keys (not just the three new names). This is a design prerequisite — do it before coding the fields, not during verification.
- **Edge Cases:** `loadLayoutSettings` returns the object unchanged for `source === 'manual'` (line 1542) — confirm this path does not filter keys.

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

---

## Completion Report

Implemented the team identity foundation: stamped `definitionId`, `head`, and `teamKind: 'spawned'` onto the group record in `wireSpawnedTeam` (both the fresh literal and the upsert merge), threaded `definitionId: group?.id` through both spawn paths in `agentGroupInstantiation.ts` (core + external-headed), and added the three resolver exports (`isSpawnedTeamGroup`, `teamHeadName`, `resolveDefinitionForGroup`) to `teamWiring.ts`. The serialisation whitelist prerequisite was investigated and cleared — `loadLayoutSettings` returns `manual` groups unchanged and the save path writes the whole array, so additive fields round-trip byte-identically on mixed-version installs. The rename path was extended via a new `rewriteTeamGroupHeadForRename` export (placed in `teamWiring.ts` to avoid a circular import with `standingOrders.ts`), wired into both rename call sites (`TaskViewerProvider.ts` and `bootstrap.ts`). The `resolveDefinitionForGroup` role-match fallback demands a unique match (the plan's intent), using the same migration converter as `findTeamForHeadRole` rather than calling it directly (it returns first-match, not unique-match). Files changed: `src/services/teamWiring.ts`, `src/services/agentGroupInstantiation.ts`, `src/services/TaskViewerProvider.ts`, `src/standalone/bootstrap.ts`. No issues encountered.

## Review Findings

Reviewed both spawn hosts, group serialization, rename rewriting, and all new identity consumers; no identity-specific code fix was required. Standing-orders marker tests passed 56/56, stage-marker tests passed 49/49, team-scoped routing passed 62/62, and external-team tests passed 9/9; all are CI-wired contract scripts where applicable. The additive `manual` group shape and unknown-key preservation remain intact for mixed-version installs. Remaining risk is manual installed-VSIX confirmation of old live groups resolving through the role fallback before their next respawn.
