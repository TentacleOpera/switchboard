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

`teamWiring.ts:758-777` — all three teams ship `members: []`:

```ts
{ id: 'planning-team',         name: 'Planning team', headRole: 'planner',  members: [] },
{ id: 'feature-implementation', name: 'Lead team',    headRole: 'lead',     members: [] },
{ id: 'review-team',           name: 'Review team',   headRole: 'reviewer', members: [] },
```

Starting any of them starts one CLI. Every fan-out, delegation and review-dispatch path downstream
assumes a pool that does not exist.

#### 2. A migration actively strips members on load

`migrateAgentGroups` (`teamWiring.ts:923+`) Step 1 compares each stored group against
`OLD_SEEDED_AGENT_GROUP` (`teamWiring.ts:792`) — the previous Lead seed,
`members: [{ role: 'coder', count: 3, label: '', startupCommand: '' }]` — and on an exact match
(`isUntouchedOldSeed`, `teamWiring.ts:1119`) **rewrites the row with `members: []`** and the new
seed's name, logging `neutralised untouched old seed … (was 3× coder, now member-less Lead team)`
(`teamWiring.ts:947-950`).

`_loadAgentGroups` (`KanbanProvider.ts:4973`) persists the result. So this is not a one-time
conversion: any install still holding the old seed has its Lead team emptied, and populating the
preset alone would not survive the next load.

#### 3. The rationale is written into the source as if it were a requirement

`teamWiring.ts:756` states *"All three are member-less: starting a team without members starts only
its head"*, and the `OLD_SEEDED_AGENT_GROUP` docblock (`teamWiring.ts:781-790`) calls the three-coder
seed *"the release gate this migration exists to close."* Both read as constraints. Neither is one —
they are the assumption describing itself, and they are why the defect survived review. **Delete
them along with the code.**

### What the members should be

Derived from what each head actually hands out, not invented:

| Team | Head | Members | Why |
| :--- | :--- | :--- | :--- |
| Planning team | `planner` | 2 × `planner` | The head's `workKind` is `'plan'` (`teamWiring.ts:1650`) and planner fan-out distributes a batch across a **pool of planners** — `getRoleTerminalSet('planner', …)` (`TaskViewerProvider.ts:8814`) round-robins across the pool (`getPlannerRotationCursor`, `:8851`). A pool of one collapses the round-robin to the same seat every time. |
| Lead team | `lead` | 3 × `coder` | The historical seed value (`OLD_SEEDED_AGENT_GROUP`), restored verbatim. |
| Review team | `reviewer` | 2 × `reviewer` | The head prompt `NEW_REVIEW_TEAM_HEAD_PROMPT` (`teamWiring.ts:880-895`) addresses *"your reviewer seats"* and apportions fixes back to *"the reviewer that reviewed them"* — the seats are reviewers, not coders. The companion plan `a-review-team-triages-then-fixes-what-it-reviewed.md` (lines 50, 94, 102) specifies *"reviewer head, reviewer members"* and *"remove the coder-delegation path."* |

> **Superseded:** Review team members: 2 × `coder` — *"So a reviewer that finds an unimplemented
> subtask has somewhere to send it — see the companion plan."*
> **Reason:** The current head prompt (`NEW_REVIEW_TEAM_HEAD_PROMPT`) addresses "your reviewer seats"
> and "the reviewer that reviewed them" and contains no coder-delegation language. The companion plan
> it cites explicitly specifies "reviewer head, reviewer members" (lines 50, 94) and "remove the
> coder-delegation path" (line 102). A coder seat on the Review team is a seat the head prompt never
> speaks to; it would sit idle while the metric "seats counted" reads green.
> **Replaced with:** 2 × `reviewer` — matching both the head prompt and the companion plan.

Member shape is the current one: `{ role, count, label: '', startupCommand: '' }`, plus the
`scope: 'per-team'` / `relationship: 'reports-to-head'` defaults Step 2 of the migration applies.

> **Superseded:** *"A pool of one is the bug `planner-fanout-pty-fleet-awareness` describes."*
> **Reason:** That plan (`planner-fanout-pty-fleet-awareness.md`) is about PTY fleet **visibility** —
> the round-robin cannot see terminals-pane PTY rows at all because the liveness test gates on
> `vscode.window.terminals` / `ideName`, which PTY rows never match. It is not about pool size. A pool
> of one is a separate (real) concern — the round-robin degenerates to one seat — but it is not what
> that plan describes.
> **Replaced with:** The pool-of-one concern stands on its own: a one-seat round-robin always picks
> the same seat, so a 2-planner preset gives the rotation something to rotate across.

**Migration:** none, and one deletion. Teams have never shipped to users, so this is a clean break —
no compat shim for the member-less shape, no head-prompt migration. Step 1 of `migrateAgentGroups`
is removed outright rather than inverted.

> **Note (name field):** With Step 1 removed, an install holding the old three-coder Lead seed keeps
> its members **and its old name** (`'Feature Implementation'`), not the new preset name (`'Lead team'`).
> The members are the goal and they survive; the name differs. This is acceptable (the operator can
> rename) but the earlier claim that the old seed "matches the new preset exactly" was wrong on the
> name field and is withdrawn.

## Metadata

**Complexity:** 5
**Tags:** refactor, bugfix
**Dependencies:** none

## User Review Required

Yes — one product decision (see Outstanding Questions): whether to pre-seed the Review team with
members at all, given the companion plan's "offered, never pre-seeded with members" design.

## Complexity Audit

### Routine
- Populate the three `DEFAULT_TEAM_DEFINITIONS` entries with members (`teamWiring.ts:758-777`).
- Delete `OLD_SEEDED_AGENT_GROUP`, `isUntouchedOldSeed`, and Step 1 of `migrateAgentGroups`.
- Delete the rationale comments (`teamWiring.ts:756`, the `OLD_SEEDED_AGENT_GROUP` docblock).
- Sync the webview copy of `DEFAULT_TEAM_DEFINITIONS` in `src/webview/terminals.js:1472-1491`.
- Delete/fix the tests that pin the member-less defect.

### Complex / Risky
- **`isUntouchedSeed` / `hasAuthoredTeams` semantic update.** `isUntouchedSeed`
  (`teamWiring.ts:1354-1363`) currently requires `members.length === 0` to recognise the shipped
  starter. Giving `SEEDED_AGENT_GROUP` three coders makes it return `false` for the new seed, which
  flips `hasAuthoredTeams` (`:1369-1371`) to `true` for a seed-only root — re-introducing the exact
  phantom-seed bug `listTeamsInRoots` exists to prevent. Must be rewritten to exact-match the new
  seed shape (3 coders), not require empty members.
- **Review team role correctness.** The seats must be `reviewer` to match the head prompt; getting
  this wrong ships a team whose seats the prompt never addresses.
- **Test surgery precision.** Several tests pin still-valid behaviour (member-less-stops-search,
  isUntouchedSeed-recognises-seed, migration idempotence) and must NOT be deleted alongside the
  defect-pinning tests.

## Edge-Case & Dependency Audit

- **Race Conditions:** None new. `_loadAgentGroups` runs inside `_agentGroupsWriteChain`; seeding
  all three presets already happens there (`KanbanProvider.ts:4995-5015`) and is unchanged.
- **Security:** None. Member counts are local config; no new capability surface.
- **Side Effects:** Removing Step 1 means an upgraded install holding the old 3-coder Lead seed now
  *keeps* its coders on reload (the desired outcome) — but also keeps the old name
  `'Feature Implementation'`. Documented above; not a regression.
- **Dependencies & Conflicts:**
  - **Companion plan conflict.** `a-review-team-triages-then-fixes-what-it-reviewed.md` (lines 61, 94,
    131) explicitly designs the Review team as "offered, never pre-seeded with members" and asserts
    `SEEDED_AGENT_GROUP` must stay member-less as a release gate. This plan pre-seeds the Review team
    with members, reversing that design. The conflict is a user decision (Outstanding Questions), not
    a silent override.
  - **`isUntouchedSeed` / `hasAuthoredTeams`.** See Complex/Risky — the seed-recognition predicate
    must be updated in the same change or the phantom-seed guard breaks.
  - **Webview copy.** `src/webview/terminals.js:1472-1491` carries its own `DEFAULT_TEAM_DEFINITIONS`
    with `members: []`. Its `members` field is unused for rendering (live members come from the spawned
    group, `terminals.js:1530`), so the drift is functionally harmless, but the codebase explicitly
    warns against two-declaration drift (`shell-terminal-strip.test.js:1294-1308`). Sync it.

## Dependencies

None.

## Adversarial Synthesis

Key risks: (1) the Review team ships with `coder` seats the head prompt never addresses — a green
"seats counted" metric masking a broken team; (2) `isUntouchedSeed` is left requiring empty
members, silently breaking `hasAuthoredTeams` and re-introducing the phantom-seed bug; (3) the
companion plan's "offer, never pre-seed" design is reversed without acknowledgement. Mitigations:
fix the Review role to `reviewer`, rewrite `isUntouchedSeed` to exact-match the new seed, and
surface the seeding conflict as a user decision rather than a silent override.

## Proposed Changes

### 1. Populate the three presets (`src/services/teamWiring.ts:758-777`)

- **Logic:** Give each preset the members in the table above — Planning: 2 × `planner`; Lead: 3 ×
  `coder`; Review: 2 × `reviewer`.
- **Implementation:** `SEEDED_AGENT_GROUP` remains `DEFAULT_TEAM_DEFINITIONS[1]` (`teamWiring.ts:779`)
  and now carries the three coder members, so the seeded Lead team and the preset agree by
  construction.
- **Edge cases:** Head-role collision resolution (`teamWiring.ts:984-1033`) is unchanged — it keys
  on `headRole`, not members. All three presets are seeded into the DB by `_loadAgentGroups`
  (`KanbanProvider.ts:5006` when the key is absent, `:5009-5014` for any missing by id), so the
  members reach the spawn path on both hosts (the standalone host seeds via the same
  `KanbanProvider.listAgentGroups` → `_loadAgentGroups` path, `bootstrap.ts:4938`).

### 2. Update `isUntouchedSeed` for the new seed shape (`src/services/teamWiring.ts:1354-1363`)

- **Context:** `isUntouchedSeed` recognises the shipped starter so `hasAuthoredTeams` (`:1369-1371`)
  can skip seed-only roots in `listTeamsInRoots` (`:1382`). It currently hard-requires
  `members.length === 0` (`:1359`).
- **Logic:** Replace the `members.length === 0` test with an exact-value comparison against
  `SEEDED_AGENT_GROUP.members` (id, role, count, label, startupCommand, and key set per member),
  mirroring the construction `isUntouchedOldSeed` uses (`teamWiring.ts:1119-1144`). A group that
  matches the new 3-coder seed is "untouched"; one that differs by any field is the operator's.
- **Edge cases:** `hasAuthoredTeams` must still return `false` for a root holding only the freshly
  seeded Lead team, so `listTeamsInRoots` does not leak the seed as an authored team. The
  `team-autostart-workspace-scope.test.js` test #14 (`isUntouchedSeed(SEEDED_AGENT_GROUP) === true`)
  then passes against the new shape and is KEPT, not deleted.

### 3. Delete the member-stripping migration (`src/services/teamWiring.ts`)

- **Logic:** Remove Step 1 of `migrateAgentGroups` (`:938-951`) — the `isUntouchedOldSeed` branch
  and its rewrite — along with `OLD_SEEDED_AGENT_GROUP` (`:792-797`) and `isUntouchedOldSeed`
  (`:1119-1144`) themselves. Steps 2 (member-shape defaults, `:953-979`) and 3 (head-role
  collisions, `:984-1033`) stay: both are real conversions, not assumptions.
- **Implementation:** `migrateAgentGroups` keeps its `null`-when-unchanged contract (`:1035`) so
  callers that skip the write still do.
- **Edge cases:** With Step 1 gone, an install holding the old three-coder Lead seed now keeps it
  (the desired outcome) — but keeps the old name `'Feature Implementation'` too (see Goal note). The
  member-shape defaults in Step 2 still fire on the old seed's members (adding scope/relationship),
  so `migrateAgentGroups([oldSeed])` is no longer null on first pass — the idempotence test that
  relies on this needs the update below.

### 4. Delete the rationale that documents the assumption

- `teamWiring.ts:756` — the "All three are member-less" invariant comment.
- The `OLD_SEEDED_AGENT_GROUP` docblock's release-gate paragraph (`:781-790`), with the constant.
- The `findTeamForHeadRoleInRoots` docblock (`:1188-1198`) references `SEEDED_AGENT_GROUP` being
  member-less as an example — update the example to the new shape (the *behaviour* — a member-less
  custom team still stops the search — is unchanged and stays).

### 5. Sync the webview copy (`src/webview/terminals.js:1472-1491`)

- Update the webview's `DEFAULT_TEAM_DEFINITIONS` to match the new members. Its `members` field is
  unused for rail rendering (live members come from the spawned group), so this is consistency, not
  function — but the `shell-terminal-strip.test.js` test (`:1304-1308`) pins id+headRole across the
  boundary and explicitly warns against two-declaration drift.

### 6. Tests — surgical, not blanket

Delete ONLY the tests that assert the member-less defect as the desired end state. KEEP the tests
that guard still-valid behaviour.

**Delete (pin the defect):**
- `src/test/review-team-triage.test.js` test #4 (`:100-105`): asserts
  `SEEDED_AGENT_GROUP.members.length === 0` as a release gate. This is the defect.
- `src/test/stage-marker-commit-contract.test.js` "migrateAgentGroups neutralises the old 3-coder
  seed" (`:417-422`): asserts `g.members.length === 0` after migrating an old seed. With Step 1
  gone, members survive (length 3) — the assertion pins the removed behaviour.
- `src/test/standing-orders-marker-contract.test.js` (`:518-521`): asserts
  `isUntouchedOldSeed` exists in source. The function is deleted.

**Keep (guard still-valid behaviour):**
- `src/test/team-autostart-workspace-scope.test.js` test #3 (`:83-89`, "a member-less team in the
  nearer root stops the search"): uses a hand-built member-less literal and asserts the search
  STOPS. A custom member-less team stopping cross-workspace spawn is valid behaviour, not the
  defect.
- `src/test/team-autostart-workspace-scope.test.js` test #14 (`:256-263`,
  `isUntouchedSeed(SEEDED_AGENT_GROUP) === true`): once `isUntouchedSeed` is updated for the new
  shape, this passes and pins the seed-recognition guard. KEEP.
- `src/test/stage-marker-commit-contract.test.js` idempotence test (`:424-426`): with Step 1 gone,
  the first pass still changes the old seed (Step 2 adds scope/relationship) and the second returns
  null — idempotence holds. KEEP; if it fails, the fix is to the test's expectation, not deletion.
- `src/test/shell-terminal-strip.test.js` (`:1264-1309`): pins id+headRole only, not members —
  unaffected. Update the stale "member-less default team" comment (`:1278`) to reflect the new shape.

### 7. Standalone and the extension

`DEFAULT_TEAM_DEFINITIONS`, `migrateAgentGroups`, `isUntouchedSeed`, and `hasAuthoredTeams` are
shared module-level values consumed by both composition roots, and the seeding path
(`_loadAgentGroups`) is the same `KanbanProvider` method on both hosts (`bootstrap.ts:4938` calls
`listAgentGroups` → `_loadAgentGroups`). So the change reaches both hosts without a per-host edit.
Verification still covers both — confirm a started Review team shows head + 2 reviewer seats under
`npx switchboard` as well as in the extension, because "shared module" is a claim until the seats
are counted in each host.

## Verification Plan

### Automated Tests
- Each `DEFAULT_TEAM_DEFINITIONS` entry exposes its expected head role and member counts (2 planner /
  3 coder / 2 reviewer).
- `migrateAgentGroups` on a stored old-seed row returns it with **members intact** (length 3, plus
  the scope/relationship defaults Step 2 adds) — the inverse of the assertion that exists today.
- `migrateAgentGroups` still applies member-shape defaults and still resolves head-role collisions.
- `isUntouchedSeed` returns `true` for the new 3-coder `SEEDED_AGENT_GROUP` and `false` for a
  renamed/edited variant — pinning the seed-recognition guard.
- `hasAuthoredTeams([seededLeadTeam])` returns `false` — the phantom-seed guard survives the new
  seed shape.

> **Superseded:** *"`resolveTeamMembersForHead` returns 2 planners / 3 coders / 2 coders for the
> three heads."*
> **Reason:** `resolveTeamMembersForHead` (`teamWiring.ts:2641-2701`) reads `terminals.groups` —
> the LIVE spawned team's roster — not `terminals.agentGroups` (the definitions). It returns the
> terminal names currently alive in a spawned team group, not preset member counts. It cannot
> return 2/3/2 from the definitions.
> **Replaced with:** Assert against `DEFAULT_TEAM_DEFINITIONS` directly and against the
> `_loadAgentGroups` output (the seeded DB rows), which are the artefacts that actually carry the
> preset counts.

### Goal Invariants
- `DEFAULT_TEAM_DEFINITIONS` carries non-empty `members` for all three entries (positive).
- No `members: []` literal remains in `DEFAULT_TEAM_DEFINITIONS` in either `teamWiring.ts` or
  `terminals.js` (negative — the member-less default is gone from the presets).
- `OLD_SEEDED_AGENT_GROUP` and `isUntouchedOldSeed` are absent from `teamWiring.ts` (negative),
  paired with: `migrateAgentGroups` is still present and still returns `null` on an already-converted
  input (positive — the function survived, only Step 1 was removed).
- `isUntouchedSeed` is present and returns `true` for `SEEDED_AGENT_GROUP` (positive — the
  phantom-seed guard recognises the new seed).
- A custom team with `members: []` is still creatable and still stops a cross-workspace search
  (positive — the operator can opt out; the default cannot).

### Manual
- Fresh workspace: start each of the three teams, count the seats (2 planner / 3 coder / 2 reviewer).
- An install holding the old three-coder Lead seed: reload and confirm the members survive (and
  note the name stays `'Feature Implementation'` until renamed).
- Repeat both under `npx switchboard`.

## Outstanding Questions
- **[user]** The companion plan `a-review-team-triages-then-fixes-what-it-reviewed.md` (lines 61,
  94, 131) explicitly designs the Review team as "offered, never pre-seeded with members" and treats
  the member-less `SEEDED_AGENT_GROUP` as a deliberate release gate against spawning unrequested
  CLIs. This plan pre-seeds the Review team with 2 reviewer members, reversing that design.
  Proceeding on the assumption that the operator wants teams pre-populated out of the box (the
  plan's stated thesis) — but if the companion plan's offer-only design should hold for the Review
  team, the Review team stays member-less in the preset and is started explicitly by the operator.
- **[user]** The Planning team's member count is set at 2 planners, derived from the round-robin
  pool the planner fan-out expects rather than from a stated figure. The Lead team (3 coders)
  restores the historical seed and the Review team (2 reviewers) is as the head prompt specifies.
  If the planner pool should be a different size it is a one-number change to the preset.

## Completion Summary

Populated the three `DEFAULT_TEAM_DEFINITIONS` presets with their pools (Planning: 2×planner, Lead: 3×coder, Review: 2×reviewer) in both `src/services/teamWiring.ts` and the webview copy in `src/webview/terminals.js`, and deleted the member-stripping migration entirely: `OLD_SEEDED_AGENT_GROUP`, `isUntouchedOldSeed`, and Step 1 of `migrateAgentGroups` are gone, leaving only the member-shape defaults and head-role collision steps. Rewrote `isUntouchedSeed` to exact-match the new 3-coder seed shape (id/name/headRole/every member field/key-set) so `hasAuthoredTeams` still skips seed-only roots and the phantom-seed guard survives. Surgically deleted only the defect-pinning tests (review-team-triage #4, stage-marker "neutralises" assertion, standing-orders `isUntouchedOldSeed` source check) and kept the still-valid guards (member-less-stops-search, `isUntouchedSeed(SEEDED_AGENT_GROUP)===true`, migration idempotence). Updated stale rationale comments across `teamWiring.ts`, `KanbanProvider.ts`, `terminals.js`, `command.js`, and `shell-terminal-strip.test.js` to reflect that the presets now ship with members.
