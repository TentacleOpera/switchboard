# A Change to a Shipped Default Team Can Never Reach a Board That Already Seeded

## Goal

An edit to `DEFAULT_TEAM_DEFINITIONS` reaches every existing board, without
overwriting anything the operator authored. Today it reaches none of them, and the
only way to ship a corrected default is to write the operator's database by hand.

## Problem analysis

`_loadAgentGroups` (`KanbanProvider.ts`) has exactly two arms:

```ts
if (working === null || !resetAlreadyRan) {
    working = DEFAULT_TEAM_DEFINITIONS.map(seedCopy);   // the five defaults ARE the store
} else {
    for (const def of DEFAULT_TEAM_DEFINITIONS) {
        if (!working.some(g => g && g.id === def.id)) { working.push(seedCopy(def)); }
    }
}
```

The first arm runs **once**, behind `terminals.agentGroups.fiveDefaultsReset`. After
that the second arm runs forever, and it only **adds a default that is missing by
id**. An existing default's fields are never compared and never updated.

So once a board has seeded, a change to any shipped default — roster, `purpose`,
`trigger`, `jet`, `automatedDispatch`, `acceptedKinds`, head prompt — is
**unreachable**. The code ships it; no board receives it.

**This is not theoretical.** On 2026-09-19 a single session corrected the Feature
team's roster (3 × coder → 2 × coder + 1 × intern), added `jet`, added
`automatedDispatch`, rewrote all five `purpose` strings twice, added `trigger`, and
fixed the Planning team's member prompt. **Every one of those required a hand-written
UPDATE against `~/.switchboard/boards/<id>.db`** to reach the running board. Six
manual database writes to ship six correct values.

**Hand-patching the database is the actual defect.** It is unrepeatable, it is
invisible to anyone else's board, it cannot be tested, and it is exactly the kind of
out-of-band write this repo forbids everywhere else. Any operator who ran the reset
before a fix landed keeps the broken value forever.

**The naive fix is worse than the bug.** Re-seeding every default on every load would
discard operator edits — a renamed team, an added seat, a tuned roster, the in-use
switch itself. The reset is one-shot precisely to stop that. So this needs a rule
that distinguishes *the operator changed this* from *the shipped value changed*, and
the codebase already has the shape of that answer:

- `enabledSource` / `acceptedKindsSource` / `automatedDispatchSource` already record
  whether a value came from the seed (`'default'`) or from the operator
  (`'config'`).
- `isUntouchedSeed` (`teamWiring.ts`) already answers "has this row been edited?" by
  comparing against the seed in both directions, and was made maintenance-free the
  same day.

## Metadata

**Complexity:** 5
**Tags:** teams, migrations, defaults, standalone
**Scope:** `KanbanProvider._loadAgentGroups` and `teamWiring.ts`. Standalone host;
the extension host is out of scope.

## Dependencies

**Reads `isUntouchedSeed` as it now stands** — the value-comparison version, not the
key-set allowlist it replaced. A per-field version of that comparison is the core of
Change 2.

## Proposed changes

### 1. A seed version, so "has the shipped value changed" is answerable

Stamp each seeded row with the seed's version at write time. Without it every load
has to diff every field of every default against the constant to discover there is
nothing to do, and "which shipped value was this row written from?" is unanswerable
after the fact — the same question `enabledSource` exists to answer one level down.

### 2. Per-FIELD reconciliation, not per-row

On load, for each shipped default already present: for each field the seed owns,
update it **only when the stored value still equals what the seed used to say**. A
field the operator changed is theirs and is left alone; a field they never touched
takes the new shipped value.

This is `isUntouchedSeed`'s comparison narrowed from the whole row to one field, and
it is what makes the correction safe: the Feature team's roster could have been fixed
on every board, while a board whose operator had already added a fourth coder kept
theirs.

Fields whose `*Source` is `'config'` are operator-owned by declaration and are never
reconciled, whatever their value.

### 3. Log what was reconciled, per board

A silent field update is a silent behaviour change. One line per changed field naming
the team, the field, the old value and the new one — so "why did my Coding team grow
an intern?" has an answer in the log rather than in a git blame.

### 4. Retire the hand-patch

Nothing outside `_loadAgentGroups` writes `terminals.agentGroups` for a shipped
default. Say so in the code, because the workaround is currently undocumented folklore
and the next person to correct a default will reach for sqlite3 again.

## Verification plan

### Automated

- A board seeded from an older seed version, with no operator edits, receives every
  changed field of every shipped default on the next load.
- A board where the operator renamed a default, added a seat, or switched it off
  keeps ALL of those, while untouched fields on the same row still reconcile.
- A field whose `*Source` is `'config'` is never reconciled, even when its value
  happens to equal the old shipped value.
- A default the operator deleted stays deleted — the defaults are undeletable, so
  this asserts the delete refusal is still the only thing keeping them present, and
  reconciliation did not become a second resurrection site.
- Reconciliation is idempotent: a second load with an unchanged seed writes nothing
  and logs nothing.
- The one-shot reset marker is untouched — this is not a second reset, and a board
  that has never seeded still takes the reset arm.

### Goal invariants

- Shipping a corrected default reaches every board, on the next load, with no manual
  database write anywhere.
- An operator edit is never overwritten by a seed change.
- Every reconciled field can answer "what did it say before, and why did it change?"

### Manual

On a board that has already seeded: change a default's `purpose` and one roster count
in the source, rebuild, reload, and confirm both appear without touching sqlite3.
Then edit that team's name by hand, change the seed again, reload, and confirm the
name survives while the other fields move.

## Outstanding questions

- **Does this extend to the shipped head prompts?** They are large strings referenced
  by identifier rather than copied, so a prompt fix has the same reachability
  problem. Likely the same rule applies, but a prompt an operator has edited in the
  Teams tab is a much more expensive thing to get wrong than a `purpose` line —
  decide explicitly rather than letting it fall out of Change 2.
