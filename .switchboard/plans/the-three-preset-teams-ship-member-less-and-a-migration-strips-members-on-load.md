# The Three Preset Teams Ship Member-Less, and a Migration Strips Members on Load

## Goal

Ship the three default teams with the members they are supposed to have — a planner pool, a coder
pool, and a review pool — and delete the migration that clears members out of a team on every load.
A team is a head *and its seats*. An operator who wants a head with no seats can build a custom team
and lose the functionality deliberately; that is not the default.

### Problem analysis

**This is a design defect, not a bug report against behaviour.** The member-less presets were an
implementation assumption, never the intent, and the assumption is enforced in three places at once.

#### 1. The presets declare no members

`teamWiring.ts:597-615` — all three teams ship `members: []`:

```ts
{ id: 'planning-team',         name: 'Planning team', headRole: 'planner',  members: [] },
{ id: 'feature-implementation', name: 'Lead team',    headRole: 'lead',     members: [] },
{ id: 'review-team',           name: 'Review team',   headRole: 'reviewer', members: [] },
```

Starting any of them starts one CLI. Every fan-out, delegation and review-dispatch path downstream
assumes a pool that does not exist.

#### 2. A migration actively strips members on load

`migrateAgentGroups` (`teamWiring.ts:761+`) Step 1 compares each stored group against
`OLD_SEEDED_AGENT_GROUP` — the previous Lead seed, `members: [{ role: 'coder', count: 3 }]` — and on
an exact match **rewrites the row with `members: []`**, logging
`neutralised untouched old seed … (was 3× coder, now member-less Lead team)`.

`_loadAgentGroups` persists the result. So this is not a one-time conversion: any install still
holding the old seed has its Lead team emptied, and populating the preset alone would not survive
the next load.

#### 3. The rationale is written into the source as if it were a requirement

`teamWiring.ts:594` states *"All three are member-less: starting a team without members starts only
its head"*, and the `OLD_SEEDED_AGENT_GROUP` docblock calls the three-coder seed *"the release gate
this migration exists to close."* Both read as constraints. Neither is one — they are the assumption
describing itself, and they are why the defect survived review. **Delete them along with the code.**

### What the members should be

Derived from what each head actually hands out, not invented:

| Team | Head | Members | Why |
| :--- | :--- | :--- | :--- |
| Planning team | `planner` | 2 × `planner` | The head's `workKind` is `'plan'` (`teamWiring.ts:1488`) and planner fan-out distributes a batch across a **pool of planners** — `getRoleTerminalSet('planner', …)`. A pool of one is the bug `planner-fanout-pty-fleet-awareness` describes. |
| Lead team | `lead` | 3 × `coder` | The historical seed value, restored verbatim. |
| Review team | `reviewer` | 2 × `coder` | So a reviewer that finds an unimplemented subtask has somewhere to send it — see the companion plan. |

Member shape is the current one: `{ role, count, label: '', startupCommand: '' }`, plus the
`scope: 'per-team'` / `relationship: 'reports-to-head'` defaults Step 2 of the migration applies.

**Migration:** none, and one deletion. Teams have never shipped to users, so this is a clean break —
no compat shim for the member-less shape, no head-prompt migration. Step 1 of `migrateAgentGroups`
is removed outright rather than inverted.

## Metadata

**Complexity:** 3
**Tags:** teams, presets, migration-removal
**Dependencies:** none

## User Review Required

None.

## Proposed Changes

### 1. Populate the three presets (`src/services/teamWiring.ts:597-615`)

- **Logic:** Give each preset the members in the table above.
- **Implementation:** `SEEDED_AGENT_GROUP` remains `DEFAULT_TEAM_DEFINITIONS[1]` and now carries the
  three coder members, so the seeded Lead team and the preset agree by construction.
- **Edge cases:** Head-role collision resolution (`:830-858`) is unchanged — it keys on `headRole`,
  not members. Confirm `resolveTeamMembersForHead` returns the seats for each head.

### 2. Delete the member-stripping migration (`src/services/teamWiring.ts`)

- **Logic:** Remove Step 1 of `migrateAgentGroups` — the `isUntouchedOldSeed` branch and its rewrite
  — along with `OLD_SEEDED_AGENT_GROUP` and `isUntouchedOldSeed` themselves. Steps 2 (member-shape
  defaults) and 3 (head-role collisions) stay: both are real conversions, not assumptions.
- **Implementation:** `migrateAgentGroups` keeps its `null`-when-unchanged contract so callers that
  skip the write still do.
- **Edge cases:** With Step 1 gone, an install holding the old three-coder Lead seed now keeps it —
  which is the desired outcome, and matches the new preset exactly.

### 3. Delete the rationale that documents the assumption

- `teamWiring.ts:594` — the "All three are member-less" invariant comment.
- The `OLD_SEEDED_AGENT_GROUP` docblock's release-gate paragraph, with the constant.
- Any test whose name or assertion pins member-less presets: those tests assert the defect. Check for
  a `members).toEqual([])` / `members.length === 0` assertion against the presets and delete it with
  the behaviour, rather than editing it to expect the new counts and leaving the old intent in place.

### 4. Standalone and the extension

`DEFAULT_TEAM_DEFINITIONS` and `migrateAgentGroups` are shared module-level values consumed by both
composition roots, so the change reaches both hosts without a per-host edit. Verification still
covers both — confirm a started Review team shows head + 2 seats under `npx switchboard` as well as
in the extension, because "shared module" is a claim until the seats are counted in each host.

## Verification Plan

### Automated Tests
- Each preset exposes its expected head role and member counts.
- `migrateAgentGroups` on a stored old-seed row returns it with **members intact** (the inverse of
  the assertion that exists today).
- `migrateAgentGroups` still applies member-shape defaults and still resolves head-role collisions.
- `resolveTeamMembersForHead` returns 2 planners / 3 coders / 2 coders for the three heads.

### Goal Invariants
- Starting any preset team starts its head **and its seats**.
- No load path clears a team's members.
- A custom team with no members is still creatable — the operator can opt out; the default cannot.

### Manual
- Fresh workspace: start each of the three teams, count the seats.
- An install holding the old three-coder Lead seed: reload and confirm the members survive.
- Repeat both under `npx switchboard`.

## Outstanding Questions

- **[user]** The Planning team's member count is set at 2 planners, derived from the fan-out pool the
  planner round-robin expects rather than from a stated figure. The Lead team (3 coders) restores the
  historical seed and the Review team (2 coders) is as specified. If the planner pool should be a
  different size it is a one-number change to the preset.
