# A Team Declares What Work It Accepts, So a Low-Complexity Team and a Feature Team Are Different Things

## Goal

A team definition can express **what work it takes**, not only who is in it. A batch low-complexity
team and a high-complexity feature team become two distinguishable things the operator configures in
the teams UI, and dispatch narrows to the eligible team instead of guessing from role names.

### Problem analysis

**A team definition today carries identity, roster and location — nothing about work.** The complete
field set, read from `terminals.agentGroups` on the reference install:

```
id · name · headRole · members[{role, count, scope, relationship}] · machine · unassigned
```

(The schema also carries `icon`, `pacing`, `headPrompt`, `startWorktree`, and `prompt` —
presentation and run-shape fields, none of which express work capability. They do not change the
argument below.)

There is no complexity band, no plan-kind filter, no column scope, no project binding. **The teams
setup UI cannot express "this team handles features" versus "this team handles batch low-complexity
cards"**, because the data model has nowhere to put it.

**Operator statement, 2026-09-14:** *"how do i make a low complexity team vs a high complexity feature
team? currently there is no way."*

**Routing is therefore entirely implicit**, inferred from two signals that were never meant to carry
capability:

| Signal | What it actually means | Why it does not answer this |
| :--- | :--- | :--- |
| `headRole` | which role leads the team | A *role*, not a capability. Two `lead`-headed teams are indistinguishable — the live install has exactly this: **Coding** and **Lead team** both declare `lead`. |
| origin seat (`restrictToOriginTeam`, `LocalApiServer.ts:3217` declaration, `:3381` refusal branch) | keep a team's card on that team | Says where work *came from*, never where it *belongs*. Useless for a card dispatched from the board. |

> **Superseded:** origin seat (`restrictToOriginTeam`, `LocalApiServer.ts:1973`)
> **Reason:** Line citation verified against current code — `:1973` is `return;` inside `_handleServeShell`. `restrictToOriginTeam` is declared at `:3217` on `performKanbanDispatch`'s `dispatchOptions`, and the refusal branch the table describes ("keep a team's card on that team") is at `:3381-3384`.
> **Replaced with:** `LocalApiServer.ts:3217` (declaration), `:3381` (refusal branch — the 409 that refuses rather than falling through to workspace-wide routing).

**The two things that look like they solve it, do not.**

- **Complexity routing** (`kanban.dynamicComplexityRoutingEnabled`, currently `false`) chooses a
  **role tier** — lead / coder / intern — and degrades bidirectionally across the *live terminal
  pool*. It picks a **seat**, not a team. Two teams offering the same tiers remain indistinguishable.
- **Batch low-complexity** is a **button** — an action the operator presses, with its own defects
  (`Batch low-complexity button passes undefined workflow and claims a move it never makes`). It is
  something you *do*, not something a team *is*, so it cannot be the standing property the operator
  is asking for.

**Where this leaves the mission work.** `a-mission-carries-many-teams-and-missions-team-cannot-express-it.md`
adds per-stream team bindings — but those are **run parameters chosen at launch**, not standing
properties. They answer "which team takes this stream *this time*". They do not answer "which teams
are even candidates", which is what the operator configures once and expects to hold.

### Root cause

Teams were modelled as **rosters** — a head plus counts of member roles — at a time when one team per
head role made role identity a sufficient routing key. Every later routing need has been served by
reading role names harder (`headRole` lookups, tier degradation, origin restriction) rather than by
letting a team state its own eligibility. The moment two teams share a head role, the only key
collapses, which is the defect
`two-teams-can-share-a-head-role-and-routing-decides-between-them.md` exists to route around.

### Non-goals

- **Implementing complexity routing.** `dynamicComplexityRoutingEnabled` and its tier degradation are
  existing, separate work. This plan gives it a *team* axis; it does not rebuild it.
- **Replacing the mission per-stream binding.** Eligibility narrows the candidate set; the mission
  binding and the routing ladder still choose within it.
- **A general rules engine.** Declarative fields on a team, not predicates.
- **The wider teams-UI rework.** The operator has flagged the teams UI as needing broader work; this
  plan covers the eligibility gap only. The rest is uncaptured — see Outstanding Questions.

## Metadata

**Tags:** backend, ui, feature, refactor
**Feature:** c442719f-0e1c-40da-95f3-ce48627a89ac
**Complexity:** 6

## User Review Required

1. **[ANSWERED 2026-09-14] Two axes: work kind, then complexity.** The operator's requirement,
   verbatim: *"if i define team takes everything, it takes everything. if i define a team takes only
   features or plan batches, it doesn't get loose plans. if i define a team only takes low complexity
   plan batches, it gets only these."*

   So **work kind is the primary axis** and complexity narrows within it — the reverse of this plan's
   original assertion, which offered complexity alone and explicitly excluded plan kind. That was
   wrong.

   The three kinds are already distinguishable in the data (counts from the reference install):

   | Kind | How it is identified | Rows |
   | :--- | :--- | ---: |
   | **feature** | `is_feature = 1` | 108 |
   | **plan batch** | the `batchLowComplexity` dispatch path (`KanbanProvider.ts:12037`) | — |
   | **loose plan** | `is_feature = 0` and `feature_id` empty/null | 112 |

   > **Superseded:** loose plan identified as `is_feature = 0` and `feature_id null`
   > **Reason:** The `plans.feature_id` column is `TEXT DEFAULT ''` (`KanbanDatabase.ts:423`), not `NULL`. Every existing read site treats both empty-string and NULL as "no feature" — e.g. `KanbanDatabase.ts:3000`: `(plans.feature_id IS NULL OR plans.feature_id = '')`. A coder writing `WHERE feature_id IS NULL` would silently miss every empty-string loose plan (all 112 on the reference install), classifying them as neither feature nor loose and refusing them.
   > **Replaced with:** `is_feature = 0` and `(feature_id IS NULL OR feature_id = '')` — matching the codebase's own idiom at `KanbanDatabase.ts:3000/3020`. The eligibility resolver must use the same `(IS NULL OR = '')` test, not a bare `IS NULL`.

   (A feature's 481 subtasks are not a fourth kind — they dispatch as part of their feature.)

   A team therefore declares a **set of accepted kinds**, plus an **optional complexity band** that
   narrows whichever kinds it accepts. Unset on both means *takes everything* — so every team already
   configured is unaffected, with no migration.

   The operator's three examples, as configuration:

   ```
   takes everything                    kinds: (unset)                   band: (unset)
   only features or plan batches       kinds: feature, batch            band: (unset)
   only low-complexity plan batches    kinds: batch                     band: 1–4
   ```

   Column scope and project binding remain **unasserted** — nothing has asked for them.

2. **[ANSWERED 2026-09-14] A filter. The work waits.** Eligibility narrows the candidate set
   *before* the routing ladder runs; the ladder then orders whatever survives. An ineligible team is
   never a fallback, however idle it is.

   So when the only eligible team is busy, the card **queues for that team** rather than spilling.
   That is the point of configuring the bands: a feature team that is idle must not be handed a batch
   card because nothing else was free. Predictability beats utilisation — the operator configured the
   constraint precisely so it would hold under load, which is the only time it matters.

   Note the consequence to accept openly: a misconfigured board can idle. Two teams both restricted
   to `feature` and a queue of loose plans means nothing moves, and the reason is invisible unless the
   board says so — which is what answer 3 exists to cover.

3. **[ANSWERED 2026-09-14] No eligible team is a configuration fault, and is reported as one.**
   Distinguish the two cases, because they look identical from the card's side and are completely
   different problems:

   | Situation | Behaviour |
   | :--- | :--- |
   | An eligible team exists but is **busy** | The card **waits** in the queue. Normal operation, no message. |
   | **No team accepts this kind/band** at all | **Refuse**, naming the dispatch kind, the card's complexity, and the kinds and bands the configured teams actually accept. |

   The second is never a degradation to "whichever team is live" — that is how a feature team ends up
   with a batch card and nobody finds out until they read the transcript. Per the repo's fallback
   rule, an unroutable card must fail loudly rather than resolve to a plausible-looking wrong team.

## Complexity Audit

### Routine

- Adding two optional fields (`acceptedKinds`, `complexityBand`) to the `terminals.agentGroups`
  shape. The `migrateAgentGroups` converter (`teamWiring.ts:700`) already stamps defaults on read and
  persists the cleaned shape — adding two more pass-through fields follows the existing pattern
  (cf. `scope`, `relationship` at `:746-752`). No migration: both absent means *takes everything*,
  which is every existing team's behaviour.
- The teams setup UI gains a kind selector and a band control beside `headRole` and the member
  roster. The TEAMS tab already renders and round-trips arbitrary fields on a group
  (`teamsTabSaveAgentGroup`); two new controls mirror the existing `headRole` dropdown pattern.
- Reading `acceptedKinds` / `complexityBand` off a resolved definition is a field read, not a new
  resolver — `resolveDefinitionForGroup` (`teamWiring.ts:1091`) already returns the definition row.

### Complex / Risky

- **Filtering at the live-terminal resolver, not the definition.** The candidate set that the ladder
  orders is `{ leads, coders, interns }` — *alive head terminal names* — produced by
  `resolveCodingRolesFromGroups` (`KanbanProvider.ts:5649`). That function reads `terminals.groups`
  (live spawned groups), cross-references `terminals.agentGroups` for `headRole`, and filters by
  liveness. The eligibility filter must run *inside* this function (or a wrapper): for each live
  group, resolve its definition via `resolveDefinitionForGroup` (using the `definitionId` link at
  `teamWiring.ts:1394`), check the definition's `acceptedKinds` and `complexityBand` against the
  dispatch kind and card complexity, and exclude the group's head terminal from the role arrays
  when it is ineligible. Filtering definitions without filtering the live terminals they map to
  leaves the ineligible head in the candidate set — a green-metric-over-real-goal gap.
- **Threading dispatch kind + card complexity to the resolver.** `resolveCodingRolesFromGroups` and
  `resolveCodingHeadFromGroups` today take only `workspaceRoot`. The dependency plan
  (`two-teams-can-share-a-head-role`) is already widening this signature to thread card context
  (mission id, worktree id, project) for the ladder. This plan's eligibility filter needs the
  **dispatch kind** and **card complexity** at the same site. The two widenings must land in one
  signature change, not two — a second widening of the same function is a divergence hazard.
- **The refusal must short-circuit before the workspace-wide fallback.** The current fallback chain
  is `resolveCodingHeadFromGroups` → null → `getAliveCodingTerminalNames()[0]`
  (`KanbanProvider.ts:13497-13502`, workspace-wide). If eligibility filtering makes
  `resolveCodingHeadFromGroups` return null, the current code falls through to workspace-wide
  routing — handing the card to an ineligible team's terminal. The "no eligible team" refusal
  (Change 4) must fire *before* the workspace-wide fallback, not after. A null return is
  indistinguishable from "no live team at all" unless the eligibility filter distinguishes "no
  eligible team" (refuse) from "no live team" (fallback) — see Edge-Case audit.

## Edge-Case & Dependency Audit

**Race Conditions**
- Two batches dispatched concurrently both consult the eligibility filter; without coordination both
  can see the same eligible team as free and double-dispatch into a lead mid-task. The queue is
  already a single serialized pop chain (`_queueNextChain`, `LocalApiServer.ts:73`), so the
  eligibility read must happen *inside* the serialized pop, not before it — the same constraint the
  ladder has.
- A team definition edited mid-dispatch: the operator changes `acceptedKinds` while a card is
  in-flight to that team. The card was eligible at pop time; the edit does not retroactively
  un-dispatch it. Acceptable — eligibility is evaluated at pop, not continuously.

**Security**
- No new trust boundaries. `acceptedKinds` and `complexityBand` are operator-authored config in the
  same tiered store `terminals.agentGroups` already uses; no untrusted input reaches the filter.

**Side Effects**
- Adding fields to `terminals.agentGroups` and running them through `migrateAgentGroups`: the
  converter must pass `acceptedKinds` and `complexityBand` through unchanged (preserve unknown keys,
  per the repo's migration rule). A team with the fields set on an older install that does not yet
  understand them keeps the values on round-trip — no data loss on downgrade.
- The `resolveDefinitionForGroup` role-match fallback (`teamWiring.ts:1099-1112`) returns `null`
  when two definitions share a `headRole` (demands uniqueness). Once the collision demotion is
  removed by the dependency plan, a live group with no `definitionId` and an ambiguous role match
  resolves to `null` — and an eligibility check on `null` must treat the team as **eligible** (takes
  everything), not **ineligible**. Refusing a team whose definition cannot be resolved is a
  silent fallback-to-wrong-behaviour: the team was running before this plan and must keep running.

**Dependencies & Conflicts**
- `resolveCodingRolesFromGroups` (`KanbanProvider.ts:5649`) is shared by `runQueue`
  (`:9174`/`:13497`), the `codingHeadLive` status sites (`:1480`/`:2505`/`:4315`/`:4544`), and the
  `setQueueHeadResolver` seam (`extension.ts:1093`, `bootstrap.ts:2244`/`:4291`). The eligibility
  filter must not change the return for non-dispatch callers (status reads, liveness checks) — those
  call with no card context and must see every live team regardless of eligibility. The filter is
  scoped to the dispatch path only, gated on the presence of dispatch kind + card context.
- `resolveDefinitionForGroup` (`teamWiring.ts:1091`) is the link from live group to definition. Its
  role-match fallback returns `null` on ambiguity; the eligibility filter's `null`-definition
  handling (treat as eligible) is the contract that keeps pre-`definitionId` teams working.
- The `queue-pipeline-contract.test.js` asserts `resolveCodingHeadFromGroups` by name at multiple
  sites — the signature widening (this plan + the dependency plan) must retarget those assertions.

## Dependencies

- **`two-teams-can-share-a-head-role-and-routing-decides-between-them.md`** — rewrites the same
  resolution seam (`resolveCodingRolesFromGroups` / `resolveCodingHeadFromGroups`,
  `KanbanProvider.ts:5649`/`:5712`). That plan should land **first**: it establishes the ladder and
  widens the resolver signature to take card context. This plan adds the eligibility filter in front
  of the ladder and extends the same signature with dispatch kind + card complexity. Reversing the
  order means writing a filter for a resolver that still returns `leads[0]` and a second signature
  widening of a function already widened once — a divergence hazard. The two plans should land as
  one coordinated change to the resolver, not two sequential ones.
- **`a-mission-carries-many-teams-and-missions-team-cannot-express-it.md`** — complementary, not
  competing. Eligibility is standing; the per-stream binding is per run.

## Adversarial Synthesis

Key risks: (1) the eligibility filter must operate on live terminals via `resolveDefinitionForGroup` +
`definitionId`, not on definitions alone — filtering definitions without filtering the terminals they
map to leaves ineligible heads in the candidate set; (2) the "no eligible team" refusal must
short-circuit *before* the workspace-wide fallback (`getAliveCodingTerminalNames()[0]`), or a null
return silently routes to an ineligible team's terminal — the exact failure the plan exists to
prevent; (3) the signature widening must carry eligibility context (kind + complexity) alongside the
ladder context (mission, worktree, project) in one change, or the two plans diverge the same
function; (4) a team whose definition resolves to `null` (ambiguous role match, no `definitionId`)
must be treated as eligible, not refused — refusing it is a silent behaviour change for
already-running teams. Mitigations: filter inside `resolveCodingRolesFromGroups` gated on dispatch
context; distinguish "no eligible team" (refuse) from "no live team" (fallback) at the pop site;
land the two widenings as one signature change; treat `null`-definition as takes-everything.

## Proposed Changes

### 1. `src/services/teamWiring.ts` — eligibility fields on the team definition

- **Context:** `terminals.agentGroups` is the team-definition store. `migrateAgentGroups` (`:700`)
  is the read-time converter that stamps defaults and persists the cleaned shape. Every reader goes
  through the converter, so new fields are visible everywhere once the converter passes them
  through.
- **Logic:** Add two optional fields to the definition shape:
  - `acceptedKinds?: ('feature' | 'batch' | 'loose')[]` — absent/empty means "accepts all kinds".
  - `complexityBand?: { min: number; max: number }` — absent means "no complexity constraint".
- **Implementation:** `migrateAgentGroups` already preserves unknown keys (the `{ ...group }` spread
  at `:712`). No converter change is needed for pass-through. Add a typed reader
  (`readTeamEligibility(def): { acceptedKinds?: string[]; complexityBand?: { min; max } }`) that
  returns `undefined` for both when the fields are absent — the "takes everything" default. Do not
  default `acceptedKinds` to a concrete array; an absent field and an empty array both mean "all",
  and the reader must not fabricate a constraint that changes behaviour.
- **Edge Cases:** A definition with `acceptedKinds: ['batch']` and no `complexityBand` accepts all
  batch cards regardless of complexity. A definition with `complexityBand: { min: 1, max: 4 }` and
  no `acceptedKinds` accepts any kind whose complexity falls in 1–4. Both absent = takes everything.

### 2. `src/services/KanbanProvider.ts` — the eligibility filter at the live-terminal resolver

- **Context:** `resolveCodingRolesFromGroups` (`:5649`) reads `terminals.groups` (live spawned
  groups), cross-references `terminals.agentGroups` for `headRole` via `_resolveHeadRoleForGroups`
  (`:5673`), filters by liveness, and returns `{ leads, coders, interns }` — alive head terminal
  names. `resolveCodingHeadFromGroups` (`:5712`) picks `leads[0]` / `coders[0]` / `interns[0]`. This
  is the candidate set the ladder orders.
- **Logic:** Add an eligibility-filtered variant (or an options argument) that, for each live group,
  resolves its definition via `resolveDefinitionForGroup` (`teamWiring.ts:1091`) using the
  `definitionId` link, reads `acceptedKinds` and `complexityBand` via the new reader, and excludes
  the group's head terminal from the role arrays when the dispatch kind or card complexity is
  outside the team's declared eligibility. A group whose definition resolves to `null` (ambiguous
  role match, no `definitionId`) is **eligible** — takes everything — so already-running teams keep
  working.
- **Implementation:** The filter is gated on the presence of dispatch context (kind + complexity). The
  non-dispatch callers (`codingHeadLive` status reads at `:1480`/`:2505`/`:4315`/`:4544`) call with
  no dispatch context and must see every live team — the filter is a no-op for them. The dispatch
  callers (`runQueue` at `:9174`/`:13497`, the `setQueueHeadResolver` seam) pass the dispatch kind and
  card complexity and get the filtered set.
- **Edge Cases:**
  - **Dispatch kind resolution.** The kind is resolved from the dispatch, not only the card: a
    feature dispatch (`isFeature` on the card) is `feature`; the `batchLowComplexity` verb
    (`KanbanProvider.ts:12037`) is `batch`; an ordinary single-card dispatch (`lead`/`coder`/`intern`
    verbs) of a plan with `is_feature = 0` and `(feature_id IS NULL OR feature_id = '')` is `loose`.
    Resolving from the dispatch is what makes "plan batch" expressible — a batch is a way of sending
    work, not a property of any one card.
  - **Complexity band comparison.** A card with no complexity score is treated as eligible for any
    band (the band narrows cards that *have* a score; a scoreless card is not constrained by it).
    This avoids refusing a card whose complexity was never assessed — the operator's "takes
    everything" team must still get it.

### 3. `src/services/LocalApiServer.ts` — the refusal before the workspace-wide fallback

- **Context:** The queue-pop path (`_runQueuePop`) resolves a head via
  `resolveCodingHeadFromGroups` and, on null, falls back to
  `getAliveCodingTerminalNames()[0]` (`KanbanProvider.ts:13497-13502`) — workspace-wide routing.
  This fallback is what silently hands a card to an ineligible team's terminal when eligibility
  filtering returns null.
- **Logic:** Distinguish two null cases at the pop site:
  - **No eligible team** (the eligibility filter ran and excluded every live team) → **refuse**
    (409), naming the dispatch kind, the card's complexity, and the kinds/bands the configured teams
    accept. Do not fall through to workspace-wide routing.
  - **No live team** (no dispatch context, or the filter is a no-op and no team is alive) → existing
    fallback to `getAliveCodingTerminalNames()[0]` unchanged.
- **Implementation:** The eligibility-filtered resolver returns a discriminated result —
  `{ status: 'eligible', head } | { status: 'none-eligible', acceptedKinds, bands } | { status:
  'none-live' }` — not a bare `string | null`. The pop site branches on `status`: `none-eligible`
  refuses; `none-live` falls back; `eligible` dispatches. A bare null return cannot distinguish the
  two cases, and conflating them is the silent-substitution bug.
- **Edge Cases:** The refusal message must name the dispatch kind, the card's complexity (or
  "unscored"), and the accepted kinds/bands of every configured team — per the repo's fallback rule,
  the operator must be able to see *why* the card was refused and *what to change*. A refusal that
  says only "no eligible team" is a loud failure that does not tell the operator how to fix it.

### 4. `src/webview/kanban.html` / `src/webview/terminals.js` — the teams setup UI

- **Context:** The TEAMS tab gallery (`teamsTabRenderGallery`) and the team editor render and
  round-trip fields on a group via `teamsTabSaveAgentGroup`. The `headRole` dropdown and member
  roster are the existing controls.
- **Logic:** Add a kind selector (multi-select over `feature` / `batch` / `loose`, default
  "takes everything") and a band control (min/max numeric, default unset) beside `headRole` and the
  member roster. The default state must visibly say **takes everything**, so an unconfigured team is
  obviously unrestricted rather than ambiguously blank.
- **Edge Cases:** The UI writes through `teamsTabSaveAgentGroup`, which posts to the
  `agentGroups` message handler (`kanban.html:12839`). The handler must accept the new fields and
  persist them — it already passes through arbitrary keys, but a guard against `acceptedKinds`
  containing values outside `{'feature','batch','loose'}` is warranted (reject the save with a
  message, do not silently coerce).

### 5. Host scope

`terminals.agentGroups`, `resolveCodingRolesFromGroups`, `resolveDefinitionForGroup`, and the
queue-pop refusal site are all shared. Per `CLAUDE.md` (2026-09-14) the extension host is being
removed in a hard cutover — no extension-specific wiring; it inherits the shared change. The
`setQueueHeadResolver` seam (`extension.ts:1093`, `bootstrap.ts:2244`/`:4291`) is the one composition
root touch: both hosts must pass the dispatch kind + card complexity through the widened resolver
signature. This is the parity check.

## Verification Plan

### Automated Tests

- **Contract — the operator's three examples, one test each.** A team with nothing set receives a
  feature, a batch and a loose plan. A team set to `feature, batch` receives both of those and
  **never** a loose plan. A team set to `batch` with band 1–4 receives only low-complexity batches —
  not a high-complexity batch, not a loose plan, not a feature. All three are impossible to express
  today.
- **Contract** — a team with no band set remains eligible for every card, and a workspace of
  band-less teams behaves exactly as it does now. This is the no-migration regression.
- **Contract** — a card matching no band is **refused**, and the message names the complexity and the
  available bands.
- **Contract** — eligibility filters *before* the ladder: with two eligible teams the ladder's
  ordering decides; with one, the ladder is not consulted.
- **Contract — the work waits.** One eligible team, busy with an in-flight card; a second, idle,
  ineligible team present. Assert the card stays queued and is **not** dispatched to the idle team.
- **Contract — no eligible team refuses, does not fall through.** A board whose every team excludes
  the dispatched kind refuses (409), and the message names the kind, the complexity, and the
  accepted sets in play. Assert the workspace-wide fallback (`getAliveCodingTerminalNames()[0]`) is
  **not** reached — the refusal short-circuits before it.
- **Contract — null definition is eligible.** A live group with no `definitionId` and an ambiguous
  role match (two definitions share the `headRole`) resolves to `null` and is treated as
  takes-everything — the card dispatches to it, not refused. This is the already-running-team
  regression.
- **Contract — scoreless card.** A card with no complexity score is eligible for any band; a
  band-restricted team does not refuse it.
- **Parity** — both composition roots resolve the same team for the same card and configuration,
  and both pass the dispatch kind + card complexity through the widened resolver signature.

Run `npm run compile-tests` before any `test:contract:*` script.

### Goal Invariants

1. A team can state what work it accepts (`acceptedKinds` and `complexityBand` fields exist on the
   `terminals.agentGroups` shape, read through `migrateAgentGroups` at `teamWiring.ts:700`).
2. The teams UI can express a low-complexity team and a feature team as different things (the kind
   selector and band control render in the team editor and round-trip through
   `teamsTabSaveAgentGroup`).
3. Teams with no band/kind configured behave exactly as they do today (the eligibility filter is a
   no-op when dispatch context is absent; `resolveCodingRolesFromGroups` returns the same
   `{ leads, coders, interns }` for status-read callers).
4. No card is ever routed to an ineligible team silently (the pop site distinguishes
   `none-eligible` from `none-live`; `none-eligible` refuses before the
   `getAliveCodingTerminalNames()[0]` workspace-wide fallback at `KanbanProvider.ts:13497`).
5. **Negative invariant:** the workspace-wide fallback (`getAliveCodingTerminalNames()[0]`) is
   **not reached** when the eligibility filter excluded every live team — assert the 409 refusal
   fires first. Paired with: the fallback **is** reached when no team is live (no dispatch context,
   filter is a no-op).

## Outstanding Questions

- **[user]** The teams UI was described as needing *"serious work"* beyond this, with eligibility
  called *"just one of the problems"*. The others are not captured anywhere in the plan corpus. They
  should be collected into their own card rather than inferred here — this plan deliberately does not
  guess at them.
