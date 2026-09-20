# A Team Instance Is a Team *in a Worktree*, Not a Team

## Goal

Run the same team twice at once in different worktrees — two Feature teams, one
per worktree — because that was the original intent and missions depend on it.

A running team is identified by **(definition, root)**. Today it is identified
by definition alone, so the second instance is not refused by a guard being
strict; it is **inexpressible**.

## Problem analysis

### The registry has no worktree dimension

A live spawned group row carries exactly these keys:

```
id, name, headRole, source, teamGroup, teamKind, head,
layout, members, order, externalHead, templateId, definitionId, layoutPref
```

**No root. No worktree.** So the registry cannot represent "the Feature team in
worktree A" and "the Feature team in worktree B" as different things — there is
one row per definition and nowhere to put the second.

### So the guard can only answer workspace-wide

`startTeamById` finds the running instance with:

```ts
const own = groups.find(g => isSpawnedTeamGroup(g) && g.definitionId === teamId);
```

Keyed on `definitionId` alone. It then refuses if that row's head is live. The
guard is **correct for the model it has** — it is the model that has no room for
a second instance. Tightening or loosening the guard cannot fix this.

The group id compounds it: it is derived as `team_<head>`, so two instances
would need distinct head names before they could be distinct rows at all.

### The intent is visible on both sides, unimplemented in the middle

- `startWorktree` is a per-team definition field, preserved through migration
  and listed among the operator-owned settings.
- `missions.max_extra_worktrees` is a column on the missions table.

Both ends assume a team can run in more than one place. The registry between
them cannot say so.

### The fleet already knows the answer

Terminals carry `parentRoot` — `ptyListTerminals` returns it per seat. So the
running processes know which root they belong to; only the team registry has
dropped that dimension. The information exists and is being discarded at the one
layer that needs it.

### Why this matters beyond convenience

Missions with extra worktrees are unbuildable without it. `max_extra_worktrees`
can be set and cannot be honoured: the moment a mission wants the same team in a
second worktree, the start is refused as a double start, and the refusal is
indistinguishable from the genuine double-start case the guard exists to prevent
— the same wrong answer for two different questions.

## Metadata

**Complexity:** 6
**Tags:** teams, worktrees, missions, registry, standalone
**Scope:** `src/services/teamWiring.ts` (group registration, `startTeamById`,
group-id derivation, seat naming), the `terminals.groups` row shape, and the
surfaces that list teams. **Standalone only.**

## Constraints

**Keep the double-start guard.** Starting the same team twice **in the same
root** must still be refused — that is a real error and the reason the guard
exists. This plan narrows what "the same team" means; it does not remove the
check.

**One identity, derived once.** `(definitionId, root)` becomes the instance key
and every surface uses it. Do not let one caller key on `definitionId` while
another keys on the pair — that is the drift this codebase keeps paying for, and
a half-applied key is worse than none.

**Seat names must stay unambiguous.** Two live Feature teams cannot both have a
head called `Feature`. Naming is load-bearing: `ptySendPrompt`, the roster, the
member-orders file and the standing orders all address seats by name.

**A root must be recorded, not inferred.** Do not derive an instance's worktree
from a terminal's `parentRoot` at read time. The row states its own root, so an
instance whose seats have all exited is still attributable.

**Existing single-root teams keep working unchanged** — an instance with no
recorded root is the workspace root, and the unmigrated case must not read as a
different instance.

## Proposed changes

### 1. A spawned group records its root

The row gains the root it was started in, written at spawn. That is the missing
dimension; everything else follows from it.

### 2. Instance identity becomes (definitionId, root)

The group id derives from both, so two roots produce two rows for one
definition. `startTeamById` looks for a running instance **of this definition in
this root**, and refuses only that.

### 3. Seat naming is scoped to the instance

A second instance's head and seats take names that cannot collide with the
first's. Whatever scheme is chosen, it must be stable across a restart — a seat
that is renamed on restart breaks every stored order that addresses it by name.

### 4. Surfaces list instances, not definitions

The teams roster, the rail and the seat switcher show one entry per **running
instance**, labelled with its worktree so two Feature teams are tellable apart.
A definition with no running instance is still one entry.

### 5. Missions can ask for a worktree

`max_extra_worktrees` becomes honourable: a mission that wants the same team in
a second worktree gets a second instance rather than a refusal.

## Verification plan

### Automated

- **Two instances of one definition in two roots both start**, and both appear
  with distinct head names. This is the case that is impossible today.
- **A second start in the SAME root is still refused**, with
  `TEAM_ALREADY_RUNNING`. Asserted beside the above, because widening the key
  must not weaken the guard.
- Each instance's seats resolve to their own instance — no seat is claimed by
  the wrong one, and `resolveTeamMembersForHead` answers per instance.
- A dispatch to one instance reaches that instance's head only.
- Stopping one instance leaves the other running.
- An existing single-root team with no recorded root keeps working and is not
  treated as a new instance.
- Seat names survive a restart unchanged — asserted against a stored standing
  order that addresses a seat by name.

### Goal invariants

- A running team is identified by (definition, root), everywhere.
- The same team runs in two worktrees at once.
- A genuine double start in one root is still an error.
- No surface identifies an instance by definition alone.

### Manual

Start the Feature team in the main worktree and again in a second worktree.
Confirm both run, both are tellable apart in the roster, and a dispatch to one
does not touch the other.

## Outstanding questions

- **What is the naming scheme for a second instance's seats?** It must be stable
  across restarts and legible in a roster. A worktree-derived suffix reads well
  but changes if the worktree moves; an instance ordinal is stable but opaque.
  Decide before change 3 — every stored order addresses seats by name.
- **Does a worktree get its own board, or share one?** Sharing means two
  instances compete for the same cards, which needs a scoping rule of its own.
  This plan assumes one board; confirm before change 5, because missions are
  where the two instances would collide.
