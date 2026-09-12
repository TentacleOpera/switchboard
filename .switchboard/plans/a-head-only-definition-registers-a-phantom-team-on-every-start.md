# A Head-Only Definition Registers a Phantom Team on Every Start

## Goal

Starting a lone terminal must not create a team. Register a team only when there are delegates to be
a team *of* — the guard the standalone host already applies, and the extension path does not.

### Problem analysis

**Operator report:** starting a lone terminal from the Teams panel adds a new team.

**The unguarded call.** `agentGroupInstantiation.ts:88`, `instantiateAgentGroupCore`:

```js
const workers = Array.isArray(result.delegates) ? result.delegates : [];   // may be []
const roster  = [headName, ...workers.map(w => w.friendlyName)];           // -> [headName]
…
const wired = await wireSpawnedTeam({ …, children: workers, … });          // no length check
```

`wireSpawnedTeam` then registers `team_<headName>` in `switchboard.prompts.terminals.groups`, and
`terminals.js:1406` classifies any `team_`-prefixed row as a team (`g.id.startsWith('team_')`). One
seat becomes a team in the panel.

**The standalone host also guards it, at the call site.** `bootstrap.ts:2361` wraps
the identical call:

```js
if (spawned.children.length > 0) {
    const wired = await wireSpawnedTeam({ db, settings, headName: terminal.friendlyName, … });
}
```

Its own comment states the rule: *"Wire the team (standing orders + group registration) when children
were created."*

> **Superseded:** `wireSpawnedTeam` then registers `team_<headName>` in `switchboard.prompts.terminals.groups`, and `terminals.js:1406` classifies any `team_`-prefixed row as a team. One seat becomes a team in the panel.
> **Reason:** Verified against HEAD this session. `wireSpawnedTeam` self-guards at `teamWiring.ts:1684` (blamed 2026-08-14, predates this plan): `if (!headName || !Array.isArray(children) || children.length === 0) { return { ok: true }; }` — and again at `:1691` on `childNames.length === 0`. Both fire before the groupId derivation (`:1696`) and the group write, so a member-less/head-only start writes **no** `team_` row. The phantom-team registration this plan describes does not occur on current code. The operator's "starting a lone terminal adds a team" is the Teams panel classifying the `agentGroups` *definitions* list (`planning-team`, `review-team`) as teams — a UI read-back of definitions, not a `team_` row from `wireSpawnedTeam`. The plan's own Scope note already observed no `team_planner*` row exists on the board.
> **Replaced with:** The guard already lives in `wireSpawnedTeam` itself — the single chokepoint both hosts pass through. Change 1 is reduced to (a) confirming `:1684` is the chokepoint and (b) removing the now-redundant duplicate guard at `bootstrap.ts:2361`, or documenting why it stays as belt-and-braces. The `**Blocks** two-teams-can-share-a-head-role` dependency is **released** — the roster can no longer gain teams the operator never created.

**It fires constantly, because most definitions are head-only.** Live board, `terminals.agentGroups`:

```
group-coding-mswk2w8r   "Coding"          headRole lead      members [coder, intern]
planning-team           "Planning team"   headRole planner   members []   <- head-only
review-team             "Review team"     headRole reviewer  members []   <- head-only
feature-implementation  "Lead team"       headRole lead      members []   <- head-only
```

Three of four definitions have no members, so three of four produce a phantom team every time they
are started.

**A second defect makes the artefacts confusing to read.** `agentGroupInstantiation.ts:150`:

```js
const headName = result.terminal?.friendlyName || group?.name;
```

The definition's *name* is the fallback for the terminal's name. Starting `feature-implementation`
therefore creates a terminal called `Lead team` — and consequently a phantom `team_Lead_team`. Live
evidence: the saved group on this board lists `"Lead team"` as a member, a definition name sitting in
a list of terminal names, for a terminal that no longer exists.

**Scope note.** No `team_planner*` row is present on the board now, only `grp_…Planners` and
`team_Coding` — so the phantom rows either do not survive or are cleared by something later. The
defect is in what is written, not in what happens to persist.

## Metadata

**Complexity:** 2
**Tags:** teams, terminals, bugfix, both-hosts
**Dependencies:** none. **Blocks** ~~`two-teams-can-share-a-head-role-and-routing-decides-between-them`~~
— **released** (the `wireSpawnedTeam` self-guard at `teamWiring.ts:1684` already prevents
member-less starts from registering a team, so the roster can no longer gain teams the operator
never created; verified this session).

## User Review Required

None.

## Complexity Audit

### Routine
- The registration guard already lives in `wireSpawnedTeam` (`teamWiring.ts:1684`, verified this session, blamed 2026-08-14). Change 1 is now a confirmation + a redundant-guard cleanup, not a behaviour change.
- The head-name derivation fix (`agentGroupInstantiation.ts:150`) is a single-line fallback change in the shared start path both hosts already call.
- Standing-order delivery to a teamless seat was already verified to be scope-driven and unaffected by skipping `wireSpawnedTeam` (see the Resolved section) — no new analysis needed.

### Complex / Risky
- Removing the `bootstrap.ts:2361` duplicate guard is safe only because `wireSpawnedTeam` self-guards. If a future change ever bypasses `wireSpawnedTeam` for group registration, the standalone host loses its belt-and-braces. Mitigation: leave a one-line comment at the call site naming `wireSpawnedTeam:1684` as the chokepoint, or keep the guard and document why.
- The head-name change interacts with `rewriteTeamGroupHeadForRename` and any persisted roster rows that already carry a definition name as a member (the `"Lead team"` case). Those rows are pruned by the member-pruning change in `groups-are-ephemeral-teams-are-durable-one-store-cannot-be-both`, not here — this plan must not duplicate that prune.

## Edge-Case & Dependency Audit

- **Race Conditions:** none material. `wireSpawnedTeam`'s self-guard is read-only on `children.length` before any write; the early return is synchronous.
- **Side Effects:** removing the `bootstrap.ts:2361` guard changes nothing observable because `wireSpawnedTeam` returns `{ ok: true }` for the empty case either way. The head-name change alters the terminal's `friendlyName`, which feeds the `team_<headName>` id derivation — a renamed head gets a new team id, so an in-flight re-wire of the same logical team would register under a new id. Acceptable: member-less starts register nothing, and a real team's head name is stable for the team's lifetime.
- **Dependencies & Conflicts:** depends on `groups-are-ephemeral-teams-are-durable-one-store-cannot-be-both` for the legacy `"Lead team"` roster-row prune (do not re-implement here). Releases `two-teams-can-share-a-head-role-and-routing-decides-between-them` (block lifted). No conflict with the `Team Wiring` plan (subtask 1): that plan's member-less-seed-team concern (change 7a) is moot once the self-guard is confirmed; its head-ambiguity-on-the-wire concern (7b) is independent and unaffected.

## Dependencies

- `groups-are-ephemeral-teams-are-durable-one-store-cannot-be-both` — owns the legacy roster-row prune for definition-names-as-members; this plan must not duplicate it.
- Releases `two-teams-can-share-a-head-role-and-routing-decides-between-them` (block lifted by the confirmed `wireSpawnedTeam` self-guard).

## Adversarial Synthesis

Key risks: (1) the plan's headline defect is already fixed in code, so a coder dispatched on change 1 as originally written would "fix" a non-reproducible bug and pass an already-green invariant — the green-metric-vs-goal gap; (2) removing the standalone duplicate guard is only safe while `wireSpawnedTeam` remains the sole registration writer, a coupling that must be commented or it silently rots. Mitigations: rewrite change 1 as "confirm the chokepoint + clean up the redundant duplicate (or document it)"; keep change 2 (head naming) as the real deliverable; leave a naming comment at the call site.

## Proposed Changes

### 1. Confirm the chokepoint and clean up the redundant duplicate guard

- **Logic:** the registration guard already lives in `wireSpawnedTeam` (`teamWiring.ts:1684`, verified this session). The unguarded call at `agentGroupInstantiation.ts:175` is therefore harmless — `wireSpawnedTeam` returns `{ ok: true }` before any group write for `children.length === 0`. The standalone `bootstrap.ts:2361` guard is a now-redundant duplicate of that same check.
- **Implementation:** prefer **removing the redundant `bootstrap.ts:2361` duplicate** and leaving a one-line comment naming `wireSpawnedTeam:1684` as the single chokepoint, so the next divergence has nowhere to appear. If the duplicate must stay (e.g. to keep the standalone spawn path's broadcast-on-skip behaviour), document *why* at the call site rather than silently leaving two guards that look accidental. Do **not** add a second guard in `agentGroupInstantiation.ts` — that re-creates the two-copies-disagreeing pattern.
- **Edge case:** an external-headed team legitimately has no *terminal* head but does have workers — `wireSpawnedTeam`'s guard keys on `children.length`, never on whether a head terminal exists, so external-headed teams with workers still register. Confirmed at `:1684` (`!headName` is the only head-related clause; `children.length === 0` is the team gate).

### 2. A head terminal is not named after its definition (`agentGroupInstantiation.ts:150`)

- **Logic:** `result.terminal?.friendlyName || group?.name` is how a definition name becomes a
  terminal name. Derive the head's name from its role, as seats are elsewhere (`planner-1`), and let
  the definition name stay a definition name.
- **Why in this plan:** it is the same start path, and the two defects compound — a phantom team
  named after a definition is what makes the panel unreadable rather than merely wrong.
- **Migration:** existing rows carrying definition names as members (the `"Lead team"` case) are
  pruned by the member-pruning change in
  `groups-are-ephemeral-teams-are-durable-one-store-cannot-be-both`.

## Verification Plan

### Automated Tests

- `test:contract:no-team-without-delegates` (new): instantiate a definition with `members: []` and
  assert `switchboard.prompts.terminals.groups` gains no row; with one delegate, assert it gains
  exactly one `team_` row. This asserts the **existing** `wireSpawnedTeam:1684` chokepoint holds —
  the test is a regression guard on the already-shipped guard, not a proof of a new fix.
- Assert the same for both hosts, from the shared function — the point is that one implementation
  serves both.
- A head terminal's name never equals its definition's name for a head-only definition.
- If the `bootstrap.ts:2361` duplicate guard is removed: assert the standalone `ptyStartTeam` path
  still registers no team for `members: []` (it must rely on `wireSpawnedTeam`'s self-guard).

### Goal Invariants

- Every `team_` row in `terminals.groups` has at least two members (already holds on HEAD via
  `wireSpawnedTeam:1684`; this plan's test pins it as a regression guard).
- No `team_` row's head name equals an entry in `terminals.agentGroups[].name` (the head-naming fix,
  change 2 — the load-bearing invariant for this plan).
- **Negative:** no call site adds a second `children.length` guard duplicating `wireSpawnedTeam`'s
  (prevents re-introducing the two-copies-disagreeing pattern).
- **Paired positive:** `wireSpawnedTeam:1684` remains the single chokepoint and is named in a comment
  at every call site that previously guarded inline.

### Manual

1. Start `planning-team` (head-only) → a `planner` terminal appears, and **no** new team in the panel.
2. Start `group-coding-mswk2w8r` (two delegates) → one team, three seats.
3. Start `feature-implementation` → the seat is not called `Lead team`.

## Resolved: the blunt guard is correct — do NOT split `wireSpawnedTeam`

The question was whether gating the whole call starves a lone seat of instructions it needs. It does
not. Verified against the code:

**Standing orders already reach a teamless seat by scope.** `selectOrders`
(`src/services/standingOrders.ts:410`) tests scope *before* any team resolution:

```js
const scope = scopeOf(o);
if (scope === 'global') { …include… }      // :423
if (scope === 'role')   { …include… }      // :426
…
&& standing.inTeam && !standing.isHead && o.teamId === standing.teamId   // :444 — team scopes only
```

Five scopes exist — `'global' | 'team' | 'pair' | 'team-head' | 'role'`, defaulting to `'pair'` when
absent (`scopeOf`, :252). A solo seat therefore receives `global` orders and `role` orders (a solo
planner gets planner orders), and correctly receives nothing from `team`, `team-head` or `pair`,
which resolve through `resolveTeamStanding` (:276) and return `inTeam: false` with an empty roster.
Those are also resolved at **delivery**, not at wiring, so skipping `wireSpawnedTeam` does not
suppress them.

**Git safety is not a standing order at all.** `GIT_SAFETY_DIRECTIVE`
(`src/services/agentPromptBuilder.ts:750`) is a prompt *directive*, reported in the delivery receipt's
`directivesAttached`. It is attached by the prompt builder and is independent of team wiring, so the
guard cannot deprive a seat of it. (It bans `git reset --hard/--mixed`, `git checkout <path>` /
`git restore`, `git clean`, `git stash drop/clear`, force pushes, branch/worktree deletion, and
`git add -A` / `git add .` — the last because other agents may be working the same tree. A separate
`GIT_SAFETY_DIRECTIVE_WORKTREE_MODE` at :763 permits `git worktree remove` but not `--force`.)

**Conclusion:** the only thing `wireSpawnedTeam` installs that a lone seat cannot use is the
team-shaped orders. The self-guard at `:1684` already gates the whole call on `children.length` —
do not split `wireSpawnedTeam` (e.g. to install some orders for a teamless head); the scope-based
delivery above is why a lone seat needs nothing from the team path.

> **Method note for whoever verifies this:** do not use tmux scrollback as evidence of what a seat
> received. Seats are cleared between subtasks, so a clear erases the block and an empty capture
> proves nothing. Read the scope resolution and the receipt's `directivesAttached` instead.

## Implementation Summary

Implemented both changes plus a parity fix for the Go pty host. Change 1: removed the redundant
`if (spawned.children.length > 0)` guard at `bootstrap.ts` (the `ptyCreateTerminal` path) and gated
the `terminalsGroupsChanged` broadcast on `wired.groupId` instead, leaving a comment naming
`wireSpawnedTeam`'s entry self-guard (`teamWiring.ts:1710`) as the single chokepoint. Change 2: in
`agentGroupInstantiation.ts`, stopped passing `group?.name` as the head's terminal name (made
`name` optional in the `createHeadWithDelegates` spec and omitted it) and changed the `headName`
fallback from `group?.name` to `${headRole}-1`, so a head seat is named after its role, not its
definition. Parity fix: the Go pty host (`cmd/switchboard-pty-host/main.go`) previously fell back to
`terminal-<nanos>` for nameless creates (diverging from the standalone fleet's `${role}-1`), so the
extension host would have produced unreadable names for team heads; changed the fallback to
`${role}-1` with a collision counter matching `PtyFleetService.create`, and dropped the now-unused
`strconv` import. No new `children.length` guard was added at any call site (the two-copies-disagreeing
trap is avoided); the legacy `"Lead team"` roster-row prune is left to the owning plan
`groups-are-ephemeral-teams-are-durable-one-store-cannot-be-both`.

## Review Findings

Both changes verified correct: `bootstrap.ts`'s duplicate `children.length` guard is gone with a comment naming `wireSpawnedTeam`'s entry self-guard as the chokepoint, the broadcast is gated on `wired.groupId`, no call site added a second guard, and `agentGroupInstantiation.ts` no longer passes or falls back to `group?.name` for the head seat. The plan's one named automated check, `test:contract:no-team-without-delegates`, was never written — the invariant that authorised removing the standalone guard had no regression guard at all. Added it (plus the head-naming invariant) to `src/test/team-wiring-roster-seats-contract.test.js`, which is now CI-invoked: a `members: []` start writes no row and reports no `groupId`, one delegate writes exactly one `team_` row with at least two members, and a head-only start leaves an existing board byte-identical. No source changes were needed for this subtask. Validation: 41/41 in that suite, `npx tsc --noEmit` clean.

## Deferred Findings

- NIT `cmd/switchboard-pty-host/main.go:144` — the Go parity fix (`${role}-1` with a collision counter) has no Go test; `controlmode_test.go` does not cover `fleet.create` naming. The file is also being edited concurrently by another agent in this tree, so it was left untouched by this review.
- NIT — the legacy `"Lead team"` roster rows already on the board are still there; the prune is owned by `groups-are-ephemeral-teams-are-durable-one-store-cannot-be-both`, as the plan directs.
