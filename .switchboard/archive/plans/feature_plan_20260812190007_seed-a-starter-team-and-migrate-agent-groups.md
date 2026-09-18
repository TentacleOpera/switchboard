# Seed A Starter Team, And Migrate The Groups People Already Have

## Goal

Give a fresh install one half-built team so the Teams tab explains itself, convert every existing Agent Group into a team without losing anyone's configuration, and — the part that gates the release — make sure the group Switchboard seeded on the operator's behalf does not turn into three unrequested agent CLIs the moment head role becomes a trigger.

### The problem

Three ends of the same change.

**A blank tab teaches nothing.** A Teams tab with no adopted teams can say *"no teams yet — create one"*, which explains the control and not the concept. The gallery of shipped types helps, but the strongest first-run affordance is a team that already exists and is one click from being useful.

**~4,000 installs already hold Agent Groups.** `terminals.agentGroups` is shipped state written by the Agents-tab editor. Those groups have a name, a head role and members. After this feature they must keep working — as teams, with auto-start — rather than quietly ceasing to do anything when the instantiate button they depended on is deleted.

**Most of those groups were not written by the operator.** `KanbanProvider._loadAgentGroups` (`:4394-4401`) already seeds a built-in group whenever the config key is absent, and persists it:

```ts
private static readonly SEEDED_AGENT_GROUP: any = {
    id: 'feature-implementation',
    name: 'Feature Implementation',
    headRole: 'lead',
    members: [{ role: 'coder', count: 3, label: '', startupCommand: '' }],
};
```

It runs from the `getAgentGroups` verb, which the Agents tab issues on open. So on any install where someone has opened that tab, `terminals.agentGroups` holds a `lead`-headed group with **three coder members** — persisted, and indistinguishable at read time from one the operator authored. Make head role a trigger and the first `lead` those operators start brings three agent CLIs they never configured.

And the new model imposes a constraint the old one did not: **one team per head role.** Existing state was written with no such rule, so an install may legitimately hold two groups both headed on `lead`. That has to resolve deterministically, not by read order.

## Metadata

**Complexity:** 6
**Tags:** migration, backend, ux

## User Review Required

None.

## Complexity Audit

### Routine

- The seeding mechanism the plan needs already exists and is already correct — `_mutateAgentGroups` (`:4373-4392`) reads with `null` as the sentinel, distinguishes absent from empty, serialises the write, and supports "no write needed" by returning `null`. This plan changes what is seeded, not how.
- Field mapping from a group to a team is a rename plus two defaults.
- `_deleteAgentGroup` (`:4411-4416`) already persists an empty array so a delete sticks. Nothing to add.

### Complex / Risky

- **Retro-fitting already-persisted shipped state.** Changing `SEEDED_AGENT_GROUP` affects only future fresh installs. The installs that matter already have the old seed on disk, and something must decide what to do with it without touching groups the operator actually edited.
- **This subtask is the release gate for auto-start.** If auto-start ships without it, the default upgrade path spawns three unrequested agent CLIs per lead.
- **Head-role collisions** must resolve deterministically and non-destructively.
- Migration runs on every activation until the shape is current, so it must be idempotent and re-entrant against a live, concurrently-written key.

## Edge-Case & Dependency Audit

### Race Conditions

- Two windows on one workspace activating together both run the converter. `_mutateAgentGroups`'s promise chain serialises them; the second must observe the first's result and return `null` rather than converting again.
- A converter running while the Teams tab is open must not clobber an in-flight edit. Route every write through `_mutateAgentGroups` — never `setConfigJson` directly.
- A partial write that lands the seed change but not the conversion leaves an install in a state neither the old nor the new code expects. Write once, at the end.

### Security

- None. Local config transformation; no wire input.

### Side Effects

- **The intended one:** a migrated group starts automatically where before it waited for a button.
- **The one to prevent:** the seeded group doing the same thing, on installs whose operators never opted in.
- Marking a colliding group unassigned changes what starting its head role does, for a group that previously did nothing until instantiated. That is a reduction in surprise, not an increase, but it must be logged with names.

### Dependencies & Conflicts

- **Depends on** *Team Members Gain A Scope And A Relationship*: the converter writes the final member shape including `scope` and `relationship`. Migrating to an intermediate shape and re-migrating is the one outcome to avoid on shipped state.
- **Depends on** *A Team Starts With Its Head Role* for the head-role uniqueness rule to mean anything.
- **Release-gates** *A Team Starts With Its Head Role*: no release may contain auto-start without the seeded-group resolution below. The two may land in either order in the repo; they may not ship apart.
- **Renders through** *The Teams Tab And Four Shipped Team Types*.

## Dependencies

- `sess_20260812190004 — head-role auto-start` (release-gated on this plan)
- `sess_20260812190005 — member scope and relationship` (must land first)
- `sess_20260812190007 — starter team seed + agent-group migration`

## Adversarial Synthesis

Key risks: reimplementing a key-absence seeding mechanism that already ships; changing `SEEDED_AGENT_GROUP` and believing the job is done, when the installs that matter already hold the old three-coder seed persisted on disk; and a converter that cannot tell an operator-authored group from one Switchboard wrote on their behalf, so it either strips real configuration or leaves the hazard in place. Mitigations: reuse `_mutateAgentGroups` as-is; identify the untouched seed by exact-value comparison against the shipped constant — no marker, no new state — and neutralise only that; treat any group that differs by even one field as the operator's and leave it alone. Every decision the converter makes gets logged with names, because a silent migration that changes what starting a `lead` does is undebuggable from the outside.

## Design

### Key-absence seeding already exists — this plan changes what is seeded, not how

> **Superseded:** *"Adopt Feature team — headed on `lead`, with no members — when `terminals.agentGroups` has never been written. Not when it reads as an empty array. The distinction is the whole design. Seed at config-creation time, keyed on the absence of the key, so `remove` sticks."* — together with the implementation note *"Distinguishing never-written from empty needs a read that reports absence rather than coercing to a default. `getConfigJson(key, defaultValue)` returns the default for both cases; use a form that separates them, or record a one-time `teamsSeeded` marker."*
> **Reason:** This is a description of shipped behaviour, presented as new work. `_loadAgentGroups` (`KanbanProvider.ts:4394-4401`) already seeds only when the key is absent and persists the result, and `_mutateAgentGroups` (`:4373-4392`) already performs the absent-vs-empty read the note asks for: `getConfigJson<any[]>(KEY, null as any)`, then `raw === null ? null : …`. `_deleteAgentGroup` already writes `[]` rather than removing the key, precisely so a deleted built-in stays deleted — its comment says so (`:4411-4413`), as does the section header at `:4353-4356`. A `teamsSeeded` marker would be a second piece of state solving a problem the code solved already.
> **Replaced with:** Reuse the mechanism unchanged. The work in this plan is (a) change `SEEDED_AGENT_GROUP`'s content, (b) neutralise the copies of the **old** seed already persisted on shipped installs, (c) convert groups to the team shape, and (d) resolve head-role collisions.

The absent-vs-empty distinction, and the reason it matters, remain exactly as stated: *never configured* and *deliberately emptied* look identical at read time, and seeding on "empty" would make the starter grow back every time someone removes it. That property already holds and this plan must not break it.

### The seed becomes member-less

Change `SEEDED_AGENT_GROUP` to a `Lead team` headed on `lead` with **no members**.

**A team with no members does nothing.** Starting a `lead` starts a lead, exactly as today. So the seeded row changes no behaviour — it is a piece of explanation that happens to be one click from being functional. That is what allows it to ship into the auto-start feature without a staged rollout.

The card reads:

```
Lead team — starts with lead
No members yet — this team does nothing.
   Add a member and every lead you start will bring it along,
   already told what it is there for.          [+ ADD MEMBER]
```

### Neutralising the seed already on disk — the release gate

Changing the constant fixes fresh installs only. Every install that has opened the AGENTS tab already holds the old seed persisted, and after auto-start that group spawns three coders per lead.

Distinguish "Switchboard wrote this" from "the operator wrote this" **by exact value, not by a marker**: a stored group whose `id` is `feature-implementation` and whose every field still equals the shipped `SEEDED_AGENT_GROUP` — same name, same head role, one member of role `coder`, count `3`, empty `label` and `startupCommand` — has demonstrably never been edited. Replace that row's members with none, converting it into the new member-less starter in place, keeping its id so a subsequent `remove` still sticks.

A group that differs by any field — a renamed group, a different count, an added member, an edited `startupCommand` — is the operator's. **Leave it exactly as it is.** It auto-starts, which is the requested behaviour and the point of the feature.

This needs no new state and no marker: the shipped constant is the reference value, and it is already in the source file that does the comparison. It is also naturally idempotent — after the first run the row no longer matches, so it is never touched again.

State the outcome plainly in the release notes: an install that never touched Agent Groups sees no change in what starting a `lead` does; an install that configured one sees it start automatically.

### Migrating existing groups

Each existing group becomes a team:

| old | new |
| :-- | :-- |
| `name` | team name, unchanged |
| `headRole` | head role — and now the auto-start trigger |
| `members[]` (`role`, `count`) | members with `scope: 'per-team'`, `relationship: 'reports-to-head'` |
| `label`, `startupCommand` on a member | preserved on disk, no longer surfaced |

The two defaults reproduce today's behaviour exactly: every member was per-head and every member got the callback instruction, so a migrated team wires identically to what the instantiate button used to produce.

`label` and `startupCommand` are **preserved, not deleted**. They ship in `DelegateDefinition` (`agentConfig.ts:3-8`); dropping unknown keys from shipped state to tidy a UI is exactly the trade `CLAUDE.md` forbids. They are read and written back untouched, and simply have no editor.

### Resolving two groups on one head role

Deterministic and non-destructive: **the first by stored order keeps the head role and becomes an active team. The others are converted and kept, but marked unassigned** — visible in the Teams tab, editable, not auto-starting, with a line saying which team claimed their head role and inviting a new one.

Not silently dropped, not merged, not resolved by which was read first from an object. Merging two groups guesses at intent; dropping one destroys configuration the operator wrote.

### Behaviour change to state plainly

A migrated group **starts automatically** where before it waited for a button. For an operator who defined a lead group and never instantiated it, the first `lead` they start after upgrading now brings children. That is the requested behaviour and it is the point of the feature, but it is a change in what happens on a familiar action, and it should appear in the release notes rather than be discovered.

## Implementation Notes

- Route every write through `_mutateAgentGroups`. It already serialises against the editor and against a second window, and its "return `null` = no write needed" contract is what keeps a no-op activation from touching the key.
- Migration must be **idempotent and re-entrant**. It will run on every activation until the shape is current; running it twice must not duplicate teams, re-seed a removed starter, or re-mark an unassigned team. The exact-value seed check is self-limiting; the shape conversion needs its own "already converted" test (presence of `scope`/`relationship` on every member).

> **Superseded:** *"Never assume a prior migration ran. Installs skip versions, so the converter must accept both the current group shape and the legacy `assignments`-array shape that `loadLayoutSettings` still handles at `terminals.js:1404`."*
> **Reason:** The `assignments`-array legacy shape at `terminals.js:1400-1406` belongs to a **different config key** — `terminals.groups`, the terminals sidebar's group list, loaded twelve lines earlier at `:1393` from `loadSetting('terminals.groups', [])`. It is the *"Legacy dev-build snapshot: a (layout, assignments) row becomes a manual group"* branch, and it has nothing to do with `terminals.agentGroups`, which is read only by `KanbanProvider._loadAgentGroups` and has never carried an `assignments` field anywhere in the tree.
> **Replaced with:** The "never assume a prior migration ran" principle stands and is correct — installs do skip versions. What is dropped is the specific instruction to write an `assignments`-shape converter for this key, which would be code for a shape that never existed on it. Keep the converter defensive (tolerate a missing `members`, a non-array `members`, an absent `headRole`) and skip anything it cannot interpret rather than discarding it.

- Write once, at the end. A partial write that lands the seed change but not the conversion leaves an install with a starter team and orphaned groups.
- Log what was converted, what was neutralised and what was marked unassigned, with names. A silent migration that resolves a head-role collision gives the operator no way to understand why one of their groups stopped starting.
- The seeded team is an ordinary team. It is removable, editable, and carries no flag marking it special — a starter that cannot be deleted is worse than no starter. The exact-value comparison is done against the shipped constant at migration time, not recorded on the row.

## Proposed Changes

### `src/services/KanbanProvider.ts`

- **Context.** `SEEDED_AGENT_GROUP` (`:4358-4363`), `_mutateAgentGroups` (`:4373-4392`), `_loadAgentGroups` (`:4394-4401`).
- **Logic.** Change the constant to the member-less `Lead team`. Add a converter that runs inside `_mutateAgentGroups`: neutralise an untouched old-seed row, add `scope`/`relationship` defaults to every member, resolve head-role collisions, preserve unknown keys.
- **Implementation.** One mutator, one write, returning `null` when nothing changed. Keep the reference copy of the *old* seed value in source for the comparison — it cannot be derived once the constant changes.
- **Edge Cases.** Absent key → seed only. Empty array → no seed, no conversion. Already-converted array → return `null`. Group with no `members` → convert to a member-less team rather than skipping it.

### `src/webview/kanban.html`

- **Context.** The Teams tab renders the adopted list.
- **Implementation.** Render the member-less starter with its explanatory copy and an add-member affordance; render an unassigned team with the claiming team named and no auto-start.
- **Edge Cases.** An unassigned team must be editable — changing its head role to a free one makes it active.

## Verification Plan

1. **Fresh install.** With no `terminals.agentGroups` key, open the Teams tab: the `Lead team` card is present, headed on `lead`, with no members and an add-member affordance.
2. **The seed is inert.** On that install, start a `lead`. Exactly one terminal, no members, no group, no standing orders — identical to pre-upgrade behaviour.
3. **The release gate.** On an install whose `terminals.agentGroups` holds **only the untouched old seed** (`feature-implementation`, `lead`, 1 × coder count 3), upgrade and start a `lead`. Exactly one terminal — **not four**. This is the check that makes auto-start releasable.
4. **An edited seed is respected.** Take the same install, change the coder count to 2 before upgrading, then upgrade and start a `lead`. Two coders start. The converter must not have neutralised it.
5. **Remove sticks.** Remove the seeded team, reload the panel, reload the window. It must not return.
6. **Emptied is not unconfigured.** Remove every team so the list is empty, restart. No re-seed.
7. **Existing group converts.** With a pre-upgrade operator-authored group (`lead`, 2 coders), upgrade and confirm it appears as a team with two `per-team` members and the `reports-to-head` relationship.
8. **Converted wiring is byte-identical.** Start the head and compare the installed standing-order text against what the instantiate button produced before. It must match exactly.
9. **Preserved keys.** A member with a `startupCommand` keeps it on disk after migration and after an unrelated edit-and-save through the new editor.
10. **Defensive conversion.** Convert a group with a missing or non-array `members` field; it must survive as a member-less team rather than being dropped or throwing.
11. **Head-role collision.** Two pre-upgrade groups both on `lead`: the first stays active, the second is present, editable and marked unassigned, naming the claimer. Nothing is deleted. Re-assign the second to a free head role and confirm it starts auto-starting.
12. **Idempotent.** Restart three times. No duplicates, no re-seed, no re-marking, and no write to the config key after the first run.
13. **Concurrent activation.** Open two windows on the same workspace simultaneously; the converter runs once in effect, not twice.
14. **The behaviour change is real.** On an upgraded install with a converted operator-authored group, starting a `lead` now brings its members — confirming the migration produced a live team, not an inert record.
15. **Standalone parity.** Repeat 1, 3, 7 and 11 against `npx`.

### Automated Tests

Per the session directive, no compilation or automated-test run is part of this pass's verification; the checks above are manual. Note for the implementer: steps 3 and 4 are the pair that distinguishes a correct converter from one that either leaves the hazard in place or strips operator configuration, and they are the two worth encoding as fixtures when tests are next touched.

## Recommendation

Complexity 6 → **Send to Coder**.

## Completion Summary

Changed `SEEDED_AGENT_GROUP` to a member-less `Lead team` (headed on `lead`, empty members) so a fresh install gets a starter that does nothing until the operator adds a member, and preserved the old seed value as `OLD_SEEDED_AGENT_GROUP` for the migration comparison. The converter (`migrateAgentGroups`) and both constants live in `teamWiring.ts` — the host-agnostic module both hosts import — and run in **two** places: (1) `findTeamForHeadRole` runs the converter in-memory on the raw DB read before matching, so it is impossible for the auto-start trigger to observe un-migrated data even on an install that has never opened the TEAMS tab in the current session (this is the fix for the release-gate defect — the converter was previously a private static on `KanbanProvider` reachable only from the `getAgentGroups` verb arm); (2) `_loadAgentGroups` in `KanbanProvider` imports and calls the same converter inside its existing `_mutateAgentGroups` call so the board persists the converted shape. The converter performs three steps in one pass: neutralises an untouched old seed by exact-value comparison (matching id, name, headRole, and every member field including key set), adds `scope: 'per-team'` and `relationship: 'reports-to-head'` defaults to every member that lacks them while preserving `label`, `startupCommand`, and unknown keys, and resolves head-role collisions by marking subsequent groups `unassigned: true` with a reason naming the claimer — non-destructive, self-healing, idempotent (returns `null` when nothing changed so no write), and defensive (tolerates missing/non-array `members`, non-object groups). `findTeamForHeadRole` skips `unassigned` teams so they do not auto-start. `kanban.html` renders unassigned teams with a red collision-reason line, the member-less starter with explanatory copy, and excludes unassigned teams from the gallery's claimed-roles set and the editor's head-role dropdown. `npm run parity:check` passes green.

## Review Findings

MAJOR, fixed in `src/services/teamWiring.ts`: because `members.map()` always returns a new array, the `!Array.isArray(g.members)` repair branch was dead and a group with a missing or non-array `members` never set `changed`, so the converter returned `null`, the repair was never persisted, and the raw group kept flowing to the board and to `findTeamForHeadRole` — verification step 10 unmet; the flag is now set before the array is normalised. Exercised the converter functionally against every discriminating case: an untouched old seed becomes a member-less `Lead team` with no members (step 3, the release gate), an edited seed with `count: 2` is left alone (step 4), a member's `startupCommand` survives (step 9), a head-role collision leaves the first active and marks the second `unassigned` with a reason naming the claimer (step 11), and re-running on all five shapes plus `[]` returns `null` so there is no re-seed and no write (steps 6 and 12). Confirmed the gate is closed on both read paths: `findTeamForHeadRole` runs the converter in-memory before matching, so an install that starts a `lead` without ever opening TEAMS still sees neutralised data. Validation: typecheck clean, all nine static gates exit 0; the only file changed by this review is `src/services/teamWiring.ts`. Remaining risk: the neutralise branch `console.log`s on every `findTeamForHeadRole` call until the board persists the conversion — log noise only, no behavioural effect.
