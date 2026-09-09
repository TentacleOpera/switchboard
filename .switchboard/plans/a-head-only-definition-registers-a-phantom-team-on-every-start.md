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

**The standalone host already guards it, and the two paths have diverged.** `bootstrap.ts:2217` wraps
the identical call:

```js
if (spawned.children.length > 0) {
    const wired = await wireSpawnedTeam({ db, settings, headName: terminal.friendlyName, … });
}
```

Its own comment states the rule: *"Wire the team (standing orders + group registration) when children
were created."* Same behaviour, implemented twice, the copies disagreeing — the pattern behind the
drag/advance defect and the tmux window duplication as well.

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
**Dependencies:** none. **Blocks** `two-teams-can-share-a-head-role-and-routing-decides-between-them`
— that plan routes between two teams claiming one head role, and cannot be trusted while the roster
can gain teams the operator never created.

## User Review Required

None.

## Proposed Changes

### 1. Guard the registration (`src/services/agentGroupInstantiation.ts:175`)

- **Logic:** no delegates, no team. Create the head terminal, install its standing orders if that is
  wanted for a lone seat, and skip group registration.
- **Implementation:** prefer **deleting one of the two implementations** over adding a second guard.
  Two copies of "wire a team after spawn" is what produced the divergence; a guard in each leaves the
  next difference free to appear. If both must stay, the standalone comment at `bootstrap.ts:2211-2216`
  is the shape to mirror, and it should be named in a comment here.
- **Edge case:** an external-headed team legitimately has no *terminal* head but does have workers —
  key the guard on `workers.length`, never on whether a head terminal exists.

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
  exactly one `team_` row.
- Assert the same for both hosts, from the shared function — the point is that one implementation
  serves both.
- A head terminal's name never equals its definition's name for a head-only definition.

### Goal Invariants

- Every `team_` row in `terminals.groups` has at least two members.
- No `team_` row's head name equals an entry in `terminals.agentGroups[].name`.

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
team-shaped orders. Gate the whole call as change 1 describes; do not split it.

> **Method note for whoever verifies this:** do not use tmux scrollback as evidence of what a seat
> received. Seats are cleared between subtasks, so a clear erases the block and an empty capture
> proves nothing. Read the scope resolution and the receipt's `directivesAttached` instead.

## Outstanding Questions

None.
