# Teams Ship as Five Defaults, and You Can Switch One Off

## Goal

Ship exactly five default teams — **Planning**, **Feature team**, **Coding**, **Review**,
**Multi-agent planning** — present on every board, none of them deletable. Four start enabled;
Multi-agent planning is present and **off**. Give a team an in-use switch, so a team that exists is
not automatically a team that plays.

Teams are how this product works. There have to be defaults, and the operator has to be able to say
"not that one" without deleting it.

### Problem analysis

**A team has exactly one state today: it exists.** There is no `enabled` field on a team definition
anywhere — `grep enabled src/services/teamWiring.ts` returns nothing. Presence in
`terminals.agentGroups` is the whole story, and presence means: rendered on every roster and rail,
startable, and **competing for its head role**. An operator who does not want a team has no move
except delete, and delete does not stick (below).

**There are two team catalogues and they disagree.**

*Catalogue A — `SHIPPED_TEAM_TYPES`* (`src/webview/agent-control.js:1017+`), five types, no ids:
Batch planners, Coding, Review, Multi-agent planning, Planning with analyst. Picking one calls
`teamsTabAdopt` (`agent-control.js:1679`) — *"Fork a shipped type into the workspace's own teams and
persist it"* — minting a definition with a generated id
(`'group-' + name + '-' + Date.now().toString(36)`, `:1681`).

*Catalogue B — `DEFAULT_TEAM_DEFINITIONS`* (`src/services/teamWiring.ts:560-590`), three definitions
with fixed ids, force-seeded into the board on every load: `planning-team` ("Planning team"),
`feature-implementation` ("Lead team"), `review-team` ("Review team").

The list you choose from and the list pushed onto you are different lists. "Lead team" is in B with
no counterpart in A, which is why a board grows a lead-headed team the operator never created.
Multi-agent planning is in A and is never a default.

**"Planning with analyst" is not a team type.** It is a planner with a general-purpose subagent —
a role-config concern wearing a team costume. It comes out of the catalogue.

**Delete does not stick, and the code comments claim it does.** `_loadAgentGroups`
(`KanbanProvider.ts:5512-5518`) re-adds any missing default whenever the key is present:

```js
for (const def of DEFAULT_TEAM_DEFINITIONS) {
    if (!working.some(g => g && g.id === def.id)) { working.push(seedCopy(def)); changed = true; }
}
```

`_deleteAgentGroup` (`KanbanProvider.ts:5685-5690`) persists the filtered array *"even if empty — so
a deleted built-in stays deleted (absent = re-seed; present-and-empty = user deleted all)"*. That
intent is **unreachable**: `working === null` is true only when the key is absent, so a delete that
leaves `[]` still takes the `else` branch and re-adds all three. A second resurrection site backs it
up — `resolveTeamById` (`teamWiring.ts:1022-1030`) re-seeds a deleted default on demand.

Undeletable defaults are the intent. The comments describing a deletable built-in are stale and go.

**The existing near-miss at an off switch makes things worse.** `unassigned: true` is set by
`migrateAgentGroups` (`teamWiring.ts:794-831`) on the loser of a head-role collision. It only ever
meant "not the auto-start default", and auto-start is retired — `startOnLoad` is stripped on read
(`teamWiring.ts:735-742`). So the flag now gates almost nothing while reading, in the UI, exactly
like a disabled state. Live evidence from this board: `feature-implementation` carries
`unassigned: true` with the reason *"Head role 'lead' is the auto-start default for 'Coding'"* — a
team the operator never made, demoting itself against the team they did make, in a mechanism that no
longer does anything.

Two flags that both look like "off" is the two-copies-disagreeing trap. `unassigned` does not
survive this plan.

**One implementation team cannot be two things at once.** Today `feature-implementation` is the only
implementation team, and it is asked to do two different jobs: take a whole feature and dispatch its
subtasks across coder seats, and take a single plan and get it implemented. Those want different
shapes — the first wants a lead and a pool of coders, the second wants one coder splitting the work
with a cheaper seat. Shipping one team for both is why the lead ends up dispensing single plans to
three coders that then sit idle. This plan splits them: **the Feature team is delivered features,
the Coding team is delivered plans.**

### The five defaults

| id | name | headRole | members | pairProgramming | ships |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `planning-team` | Planning | `planner` | 2 × `planner`, 1 × `researcher` (`scope: 'per-team'`) | — | **enabled** |
| `feature-implementation` | Feature team | `lead` | 2 × `coder`, 1 × `intern` | `'on'` | **enabled** |
| `coding-team` | Coding | `coder` | 1 × `intern` | `'on'`, not switchable off | **enabled** |
| `review-team` | Review | `reviewer` | 2 × `reviewer` | — | **enabled** |
| `multi-agent-planning` | Multi-agent planning | `planner` | 3 × `planner` (peer drafts), 1 × `researcher` (`scope: 'per-team'`) | — | **disabled** |

Ids are fixed and stable. `feature-implementation` keeps its id and is **renamed** to *Feature team*
— the id was always right and the name "Lead team" is what made it read as a stranger. The name
**Coding** moves to the new `coding-team`, which is the team a plan goes to.

Planning, Feature and Review rosters are the ones already landed by *The Three Preset Teams Ship
Member-Less* — this plan does not re-derive them; it adds the researcher seat to the
planner-headed teams and the new `coding-team` row.

**Both planner-headed teams carry a researcher seat, and it is an ordinary `per-team` member.**
A researcher is what stops a planner handing its research back to the operator to action by hand; it
is the seat that makes planning work unattended.

**It is deliberately not `scope: 'shared'`.** Operator decision, 2026-09-18. The shared branch
(`goPtyFleetProjection.ts:668-690`) spawns the seat **unparented** — `create(...)` is passed
`undefined` where the per-team branch (`:698`) passes `parent.agentInstanceId` — and keys its reuse
on `` `${teamName}-${role}` ``, which is the team's own name. Three consequences, each of which the
per-team member avoids for the price of one pty:

1. **The sharing does not currently happen.** `Planning-researcher` and
   `Multi-agent planning-researcher` are different names, so two planner teams spawn two researchers
   anyway. (The sibling card fixes this by keying on role — see Dependencies. The point is that the
   shared flag delivers nothing *until* that lands, while costing the two items below from day one.)
2. **An unconfigured researcher is reported by nothing.** `commandlessRoles` skips shared members
   outright (`agentGroupInstantiation.ts:164`), so the first-run surface this plan promises would
   list five roles and never name the sixth. See Change 8.
3. **The seat escapes the delegate cap.** `spawnDelegates` excludes shared members from
   `perTeamRequested` (`:654`). On a box where board-only fits 1 GB, an exempt seat is not a saving,
   it is unaccounted RAM.

With Multi-agent planning shipped off, first run has exactly one planner team, so `per-team` costs
**zero extra researchers** on the path that matters. The routing that makes a live researcher seat
actually get used is still a separate plan:
`a-live-researcher-seat-is-ignored-because-the-gate-asks-config-not-the-fleet`.

**Multi-agent planning is the peer-planner topology, not the fan-in one** — three planner seats that
each draft the same problem, with the head reconciling. See Dependencies.

**The Coding team is two seats and a split.** A `coder` head and one `intern` seat, with pair
programming on: the board already fans one card into a Band B (Complex / Risky) dispatch and a
Band A (Routine) dispatch (`KanbanProvider.ts:7958-7980`). On this team the **coder takes Band B and
the intern takes Band A**. That is the whole team: two seats, one card, split by complexity, with
the cheap seat doing the routine half. Change 6 is what makes the band follow the seat's position
rather than its role — today `coder` is hard-coded to Band A in the prompt builder, which is the one
thing standing between this roster and the behaviour described.

**It is deliberately the light team.** No reviewer seat, no review hop, no lead dispensing work: a
plan arrives, two seats split it, the coder integrates and commits. Every seat this team does not
have is a seat it is not paying for — that is the point of it next to the Feature team's four. Work
that needs reviewing goes to the Review team as its own dispatch.

**There is deliberately no "quick coding" team.** Ploughing a backlog of unrelated
low-complexity cards needs no team at all: stage them in Dispatch, press Run, and the queue routes
each card to a seat by complexity and sends the next on completion. That is *Kanban Queue Dispatch
Without a Team* — **already completed** — whose contract is *"no team, no head, no pacing toggle, no
roster resolution."* Operator decision, 2026-09-17: *teams are overkill for someone who just wants a
coder to plough through the backlog.* The Coding team added here is not that team — it is a two-seat
complexity split for a **single plan**, not a dispenser for a batch of unrelated ones.

Catalogue A is **deleted**. "Batch planners" is the Planning team under a worse name; "Planning with
analyst" is a bug; the other three are now defaults. `teamsTabAdopt` stops being an adoption path
and becomes plain custom-team creation. One catalogue, five rows, plus whatever the operator builds.

### The switch

Copy the shape columns already use (`src/services/agentConfig.ts:163-164`):

```ts
enabled?: boolean;
enabledSource?: 'config' | 'legacy-db-config' | 'default' | 'structural' | 'unknown';
```

A team only ever needs `'config'` and `'default'` of those, but it takes the column union verbatim
rather than a narrower copy — two nearly-identical source enums is the two-catalogues trap in
miniature.

`enabled` decides participation; `enabledSource` records **who decided**, so "off because it ships
off" and "off because the operator switched it off" are never the same value on a membership read —
the repo's fallback rule. A team the operator builds is written `enabled: true` with
`enabledSource: 'config'` at creation, so the field is never absent and there is no
absent-means-what question to answer.

Disabled is not deleted and not hidden. The Teams tab shows a disabled team greyed with its switch,
or there is no way back on.

### First run: six agents, then teams work

**The point of shipping defaults is that a new user never configures a team.** They configure agents.
The four defaults that ship **enabled** then work, because between them they use exactly six roles:

| role | used by |
| :--- | :--- |
| `planner` | Planning (head + seats), Multi-agent planning (head + peer seats) |
| `researcher` | Planning, Multi-agent planning (shared seat) |
| `lead` | Feature team (head) |
| `coder` | Feature team (seats), Coding (head, Band B) |
| `intern` | Coding (seat, Band A) |
| `reviewer` | Review (head + seats) |

That is the **recommended agent set** — and it is not a second list to maintain. It is derived from
`DEFAULT_TEAM_DEFINITIONS`: the union of `headRole` and member roles across the defaults that ship
**enabled**. If those defaults change, the recommended set changes with them, because it is computed,
not typed.

Deriving from the *enabled* set is what keeps first run at six commands. Multi-agent planning adds
no new role (`planner`, `researcher` are already counted), so today the enabled and full sets agree —
but **enabling a disabled team must still surface any role it needs that is not yet configured**,
rather than starting it into bare shells. That is the same `commandlessRoles` report as Change 8,
fired at enable time as well as at start.

**Today a new user faces twelve startup-command fields** — `DEFAULT_ROLE_CONFIG`
(`src/webview/sharedDefaults.js:19-54`) carries `planner`, `lead`, `coder`, `reviewer`, `tester`,
`intern`, `analyst`, `ticket_updater`, `researcher`, `claude_designer`, `phone_a_friend`,
`project_manager` — with nothing marking which six make the shipped teams run. Filling in the wrong
six produces teams that start and spawn bare shells.

**Starting is a click on the team's rail icon.** The affordance already exists: a dormant slot's
click posts `ptyStartTeam` (`shell.js:674-681`), and a running team's icon switches the terminals
panel into that team's scope. Nothing new is needed for start — only for which teams get a slot
(Change 10).

**"Automatically enables" means enabled, not started.** The four basic defaults ship `enabled` with
no team configuration step at all; configuring the six agents is what makes them *runnable*. It
does **not** mean a team spawns because the host booted — `Delete Auto-Start`
(`teams-start-when-a-card-needs-them-not-at-boot`) removed the boot sweep on an explicit operator
decision (2026-09-09) and this plan does not reintroduce it. **The reason is RAM, and it still
holds**: a board-only host fits 1 GB, board plus local agents wants 2 GB minimum — spawning four
teams because the host came up can take the board down on a small box. A team starts when the
operator clicks its rail icon, or when the controller starts it. The researcher then comes up **with**
the Planning team as its shared member, which is team-start-time, not boot-time.

## Metadata

**Complexity:** 5
**Tags:** teams, config, defaults, routing, pair-programming, clean-break, standalone
**Scope:** shared services (`teamWiring.ts`, `KanbanProvider.ts`, `agentPromptBuilder.ts`,
`TaskViewerProvider.ts`) + the standalone host and its webviews. The extension host is not wired for
this — it is being removed, and a second implementation there is throwaway work.

## Dependencies

**Not blocked by `two-teams-can-share-a-head-role-and-routing-decides-between-them`.** The shipped
set has two `planner`-headed teams (Planning, Multi-agent planning). **That is not a conflict.** The
only thing that ever treated it as one is the demotion in `migrateAgentGroups`
(`teamWiring.ts:794-831`), which **Change 4 of this plan deletes** — along with `unassigned`, the
flag it wrote. After this plan, two teams sharing a head role is an ordinary configuration that
nothing objects to.

Note that the two implementation teams do **not** share a head role: Feature team is `lead`-headed
and Coding is `coder`-headed. That is deliberate but it is not the routing mechanism — head role is
what a team *is*, not what it *accepts*. Change 7 is the routing.

What that other plan adds is a **routing ladder** — which of two *live* same-role teams receives a
given board dispatch, replacing `resolveCodingHeadFromGroups`' arbitrary `leads[0]`
(`KanbanProvider.ts:6073-6078`). Change 7 here replaces that same function for the work-kind
dimension; the sibling plan's contribution becomes tie-breaking *within* a kind (two live teams that
both accept features). **Sibling, not blocker** — and the two must not both rewrite
`resolveCodingHeadFromGroups` independently. Whichever lands second builds on the resolver the first
one left.

**Overlaps `a-team-declares-what-work-it-accepts` — read that card before implementing Change 7.**
This plan now lands the minimal `acceptedKinds` field itself, because the Feature/Coding split is
unusable without it. That card's remaining scope is the generalisation: `complexityBand`, operator-
built teams declaring their own kinds, and the Teams-tab editor for the field. **The two must not
define the field twice.** If that card lands first, Change 7 consumes its field rather than adding
one.

**Depends on `multi-agent-planning-team-fan-out-head-and-peer-planner-roster`.** Default #5 seeds
from whatever roster and `headPrompt` that card lands. Seeding catalogue A's current fan-in entry
instead would ship a default that is Planning with more seats and a head that never dispatches
to them. Sequence that card first.

**Depends on `a-live-researcher-seat-is-ignored-because-the-gate-asks-config-not-the-fleet`** for the
researcher seat on both planner-headed defaults to do anything. Without it the seat spawns, idles,
and the planner still hands its research prompt to the operator. That card's core fix — ask the
**fleet** whether a researcher seat is live, instead of asking whether an agent *name* is configured
— is unaffected by the per-team decision above, because the predicate matches on `role`, not on
parentage or team membership. A per-team researcher answers it exactly as a shared one would.

**But that card and this one must be reconciled before either lands.** Its Change 3 ("Make a shared
member shared across teams") re-keys shared reuse from `${teamName}-${role}` to role, expressly to
make **one** researcher serve every planner team, and its stated rule is *"not team membership, not
which team spawned it."* This plan's defaults no longer use shared scope, so **nothing in the shipped
set exercises that change** — it becomes a fix for operator-built teams that opt into
`scope: 'shared'`, not a prerequisite here. Its "Blocks `teams-are-four-defaults…`" line and its
description of this plan as putting *"a shared researcher on both planner-headed defaults"* are both
now stale and should be corrected on that card. Whoever implements first updates the other.

**Sibling, already landed:** *The Three Preset Teams Ship Member-Less* put members on the presets in
the seed. This plan takes the Planning, Feature and Review rosters as given and does not re-derive
them.

## Proposed Changes

### 1. Five defaults, fixed ids, one renamed, one new (`teamWiring.ts:560-590`)

Extend `DEFAULT_TEAM_DEFINITIONS` to the five rows above.

- Rename `feature-implementation` to **Feature team**. Id unchanged.
- Add `coding-team` — `headRole: 'coder'`, `members: [{ role: 'intern', count: 1 }]`,
  `pairProgramming: 'on'`, `acceptedKinds: ['plan']`.
- Add `multi-agent-planning` with catalogue A's roster and `purpose`/`prompt`/`headPrompt`
  copy moved across verbatim — that copy is under contract test
  (`src/test/coding-head-prompt-contract.test.js`, `standing-orders-marker-contract.test.js`), so it
  moves, it is not retyped.
- Add the `researcher` seat to both planner-headed rows as an ordinary `per-team` member —
  **not** `scope: 'shared'` (see the rationale above). No default carries a shared member.

Stamp each default `enabled` + `enabledSource: 'default'` at seed time.

`pairProgramming` is written **explicitly** on every default that has an intended intensity, never
left absent for `readTeamPairProgramming` (`teamWiring.ts:144-149`) to default to `'on'`. The
function's absent-reads-as-`'on'` behaviour stays for operator-built teams, but a shipped default
whose whole identity is the split must store the value it means — "on because it ships on" and "on
because nobody set it" must not be the same read.

`SEEDED_AGENT_GROUP` (`teamWiring.ts:592`) is `DEFAULT_TEAM_DEFINITIONS[1]` — a positional alias that
breaks silently when the array grows, and the array grows in this change. Resolve it by id or delete
it.

The Feature team's `headPrompt` copy still says *"Your coders work the subtasks of one feature"* —
that stays true and needs no edit. But the copy moved from catalogue A's **Coding** entry now belongs
to a team named *Feature team*; check the contract tests' fixture names
(`coding-head-prompt-contract.test.js` extracts by the gallery entry's name) and update the
extraction, not the copy.

### 2. `enabled` on the definition, honoured at every read

Add the two fields. Then decide, per read site, what a disabled team means:

- **`migrateAgentGroups` head-role collision** (`teamWiring.ts:794-831`) — **nothing to gate: the
  collision resolution is deleted outright by Change 4.** Two teams sharing a head role is not a
  conflict and never was; the demotion was the bug. `enabled` does not need to exclude a disabled
  team from a contest that no longer happens.
- **`listAgentGroups` / `peekAgentGroups`** (`KanbanProvider.ts:5560`, `:5579`) — return every team
  with its flag. Filtering here would hide the switch from the tab that owns it.
- **`ptyListAgentGroups` verb** → Command roster — disabled teams are not listed.
- **Work-kind routing (Change 7)** — a disabled team is not a routing candidate. A dispatch whose
  only accepting team is disabled is refused naming the switch, not silently re-routed to a team
  that does not accept the kind.
- **The shell rail** (`terminals.js:1917` `buildTeamsForShell` → `shell.js:590-697`) — **this is the
  start affordance**: a dormant slot's click posts `ptyStartTeam` (`shell.js:674-681`). A disabled
  team must not hold a slot, or the switch is decorative and clicking it starts a team the operator
  switched off. The rail also carries live groups and is no longer defaults-only — see Change 10.
- **`resolveTeamById`** (`teamWiring.ts:1014`) → explicit start — refuse a disabled team with a
  message naming the switch. Enable-and-start would make the switch unfalsifiable.
- **`resolveDefinitionForGroup`** role-match fallback (`teamWiring.ts:1122`) — drop the
  `!g.unassigned` filter with the flag it reads.

### 3. Defaults are not deletable

Remove the delete affordance for the five in the Teams tab — absent, not a confirm gate
(`CLAUDE.md`: no confirmation dialogs, and `window.confirm` is a silent no-op in a webview). The off
switch is the replacement for deleting one.

`_deleteAgentGroup` (`KanbanProvider.ts:5685-5690`) refuses a default id and its stale comment about
a deleted built-in staying deleted goes with it. `resolveTeamById`'s on-demand re-seed
(`teamWiring.ts:1022-1030`) is then dead — a default can no longer be missing — and is deleted, not
left as a second resurrection site.

### 4. Delete `unassigned`

`unassigned` and `unassignedReason` are deleted outright — the writer in `migrateAgentGroups`
(`teamWiring.ts:794-831`), the `!g.unassigned` filters in `findTeamForHeadRole` (`:956`) and
`resolveDefinitionForGroup` (`:1122`), and the UI note that renders the reason string. No
clear-on-read shim: Change 5 resets the store, so no row survives carrying the field.

### 5. Reset the store — clean break, no migration

Teams have only ever existed in unreleased dev work, so this takes a clean break (`CLAUDE.md`:
unreleased features take clean breaks; no migrations, no compat shims). **Operator decision,
2026-09-17: existing team definitions are disposable.**

`terminals.agentGroups` is reset to the five defaults on load, once, behind a one-shot marker so a
reset does not fight an operator's later edits. Everything currently stored — the adopted
`group-coding-*` rows, the three legacy presets with `members: []`, the stale `Lead team` name, every
`unassigned` flag — goes. Nothing is preserved, archived or imported.

No repair pass, no roster-vs-operator-edit arbitration, no duplicate-head-role reconciliation. Those
three branches existed only to protect stored state that does not need protecting.

### 6. The pair band follows the seat's position, not its role

This is what makes the Coding team behave as described, and it is a change to shared prompt
composition, not to the team seed.

**Today the band is inferred from the role string** in `buildUnifiedPrompt`:

- `lead` + `pairProgrammingEnabled` → Band B: *"You only need to do Complex (Band B) work"*
  (`agentPromptBuilder.ts:2452`).
- `coder` + `pairProgrammingEnabled` → Band A: *"only do Routine (Band A) work"* (`:2543`, `:2599`).
- `intern` + `pairProgrammingEnabled` → Band A, identical string (`:2639`).
- The seat add-on repeats the assumption in prose: *"A separate Coder agent is handling Routine
  (Band A) tasks"* (`:2990`).

So on a `coder`-headed team with an `intern` seat, **both seats are told to do only Routine work and
nobody does the complex half.** Role-inferred band is also exactly the quiet-wrong-answer shape the
repo bans: a `coder` seat on the Feature team and a `coder` head on the Coding team are the same
role string and must receive different bands.

**The band becomes a dispatch input.** Add to the prompt options:

```ts
pairBand?: 'A' | 'B';
pairBandSource?: 'team-head' | 'team-seat' | 'role-default';
pairCounterpartRole?: string;   // names the other half in the prose
```

Resolved at dispatch from the team definition: the team's **head** takes Band B, its **seats** take
Band A, and `pairBandSource` records which rule answered. `'role-default'` is the non-team path
(board-level pair programming with no team definition to read) and keeps today's lead/coder mapping.
The prompt builder stops branching on the role string for band assignment; it renders the band it
was handed. Log the source at the dispatch site, as the pair-programming intensity resolution
already does (`KanbanProvider.ts:7087`).

`:2990`'s prose names `pairCounterpartRole` rather than hard-coding "Coder", or says nothing when no
counterpart was resolved. A directive that names the wrong partner role is worse than one that names
none.

**The fan-out resolves the team's own head, not `lead`.** `KanbanProvider.ts:7950-7958` falls back to
`agentNames['lead']` when no target is resolved, then reads the team's pair intensity from that
terminal. For a `coder`-headed team that fallback finds the wrong team or no team. It resolves
through Change 7's resolver instead.

**The Coding team's split is not switchable off.** The Teams tab offers `on`/`aggressive` for
`coding-team` and not `off`: a coder and an intern with no split are two seats doing undifferentiated
work, which is not this team. The operator can still switch the whole *team* off (Change 2) — that is
the control for "I do not want this".

### 7. Work-kind routing: features to the Feature team, plans to the Coding team

Without this the new team is unreachable. `resolveCodingHeadFromGroups`
(`KanbanProvider.ts:6073-6078`) is the sole implementation-dispatch resolver and its whole body is:

```ts
const { leads, coders, interns } = await this.resolveCodingRolesFromGroups(workspaceRoot);
if (leads.length > 0) return leads[0];
if (coders.length > 0) return coders[0];
if (interns && interns.length > 0) return interns[0];
```

With both teams live it returns the Feature team's lead for **every** dispatch. The Coding team would
sit started, idle and never dispatched to, with nothing recording why — the "which store answered?"
failure applied to routing.

**The field.** `acceptedKinds?: ('feature' | 'plan')[]` on the definition, plus
`acceptedKindsSource?: 'config' | 'default'`. Seeded `['feature']` on `feature-implementation` and
`['plan']` on `coding-team`. Planning, Review and Multi-agent planning do not carry it — they are
reached by their own role paths (planner dispatch, review dispatch), which this change does not
touch.

**The resolver.** Replace `resolveCodingHeadFromGroups` with:

```ts
resolveImplementationHead(workspaceRoot, kind: 'feature' | 'plan'):
    Promise<{ head: string; teamId: string; source: 'accepted-kind' | 'sole-live-team' | 'role-order-fallback' } | null>
```

- `'accepted-kind'` — exactly one live enabled team accepts the kind. The normal path.
- `'sole-live-team'` — one live implementation team, and it declares no kinds (an operator-built
  team). It takes the work; the source says the routing was by absence, not by declaration.
- `'role-order-fallback'` — no team declares the kind and more than one is live. This is the old
  `leads[0]` behaviour and it is **logged as the fallback it is** at every call site, never returned
  silently.
- `null` — nothing live. Existing callers already handle a null head (Run queue posts *"No coding
  terminal is live"*, `KanbanProvider.ts:13866`); that message is widened to name the kind and the
  team that would have taken it.

Two live teams that both accept the same kind is the sibling plan's tie-break, not this one's; until
it lands, that case is `'role-order-fallback'` with a log line.

**Where the kind comes from.** A dispatch carrying a feature file and its subtasks (`featureMode`) is
`'feature'`. A single-plan dispatch and a queue pop are `'plan'`. Call sites in scope:
`KanbanProvider.ts:3179`, `:9505` (queue-watch arming — `'plan'`), `:13855` (Run queue — `'plan'`),
`TaskViewerProvider.ts:29623`, `:29749`, `bootstrap.ts:2327` (`'plan'`), `:4513`.
`extension.ts:1119` is **out of scope** — legacy host, being removed.

**Consequence worth stating: the Dispatch queue's Run targets the Coding team.** `Run queue` pops
plan cards, so with `coding-team` live it becomes the queue's default target instead of the lead.
That is the intent — a plan is what this team is for — and it does not change the queue's own
contract (*"no team, no head, no pacing toggle"* still describes the teamless path when no
implementation team is live). It does mean the queue's pacing read (`resolveTeamPacing`,
`KanbanProvider.ts:6095`) now resolves against a coder-headed team; confirm it matches on
`headRole`, not on `'lead'`.

### 8. Mark the six recommended agents on the setup surface

Derive the recommended set from `DEFAULT_TEAM_DEFINITIONS` (union of `headRole` + member roles across
the **enabled** defaults) and mark those roles in the agents/startup-command UI as the set the shipped
teams need. The other six roles stay available and configurable — they are not deprecated, they are
just not the first-run path.

Surface, per team, which of its roles still have no startup command. `instantiateAgentGroupCore`
already computes exactly this (`commandlessRoles`, `agentGroupInstantiation.ts:159-167`) and team
start already reports it (completed plan *Team start silently spawns bare shells for roles with no
startup command*). The gap is that the report arrives at **start** — the first-run user needs it
before, in the setup surface, as "Coding needs `coder` and `intern`."

**`commandlessRoles` skips shared members — which is why no default is one.**
`agentGroupInstantiation.ts:164` is `if (m?.scope === 'shared') { continue; }`, so a `scope: 'shared'`
member's role never enters `candidates` and never appears in the report. Had the researcher stayed a
shared seat, **an unconfigured `researcher` would have been reported by nothing** — the exact silence
this change exists to end, arriving in the same plan that adds the seat. The per-team decision in
*The five defaults* closes it: every role on every shipped default is a counted candidate, and this
change can reuse `commandlessRoles` as it stands.

**The hole is still there for operator-built teams** that opt into shared scope, and it should be
noted rather than fixed here. The skip is correct for its original caller — a shared member reuses a
live terminal and is not re-injected, so it needs no startup command *at spawn time* — and wrong for
a setup-surface report, where the question is "has this role been configured at all". Whoever needs
it fixed splits the two sets rather than deleting the `continue`, which would change what team start
refuses on. Out of scope for this plan; in scope for the assertion below that no default is shared.

Derived, never typed: a hard-coded list drifts the moment a default's roster changes, and the failure
is silent — a team whose new role nobody was told to configure. `intern` entering the set in this
plan is the proof: it arrives because a default's roster changed, and a typed list would not have
noticed.

### 9. Delete catalogue A (`agent-control.js:1017+`)

Remove `SHIPPED_TEAM_TYPES` and `teamsTabAdopt`'s fork path. The Teams tab renders the five defaults
plus operator-built teams from one list. "New team" creates an empty custom definition; it does not
fork a type.

### 10. The rail renders every team and every group

`buildTeamsForShell` (`terminals.js:1917-1940`) iterates the **module constant**
`DEFAULT_TEAM_DEFINITIONS` and uses the stored definitions only to override name and icon. Its
comment states today's rule: *"three FIXED slots — one per `DEFAULT_TEAM_DEFINITIONS` entry, in array
order… Operator-created teams beyond the three defaults are not rail slots."* `shell.js:590` agrees:
*"Teams mode (the only mode)… Exactly three fixed slots."*

**That model is retired.** The rail shows **all teams and all groups**:

- **One slot per enabled team definition** — default or operator-built, running or not. A dormant
  slot's click starts it (`shell.js:674-681`, unchanged). A disabled team has no slot; that is what
  the switch does.
- **One slot per live group** — the `grp_` rows in `terminals.groups`, the ones FILL GRID and SAVE AS
  GROUP create. A group exists only while its seats do (see `groups-are-ephemeral-teams-are-durable`),
  so its slot comes and goes with it. **There is no dormant group, and a group is never made durable.**

  Operator decision, 2026-09-17: *if a user wants a lasting group, they start a team.* That is the
  whole distinction between the two kinds, and it is why the rail can carry both without a mode
  switch — a team slot persists and can be started; a group slot only ever reflects something already
  live. Any future request to "save" or "restore" a group is answered by making it a team.
- **Unassigned seats get no slot.** An agent in no team and no group is shown by the **terminals panel
  icon** — clicking it opens the fleet view, which is where ungrouped seats live. The rail is for
  named arrangements; the panel is the default for everything else.

Good news on the mechanics: there is **no hard limit of three** — it is a `for…of` over the array, so
the count was never the constraint, only what it iterated. That matters more now that the default set
is five. And `buildTeamsForShell` already holds both inputs it needs: `_agentGroupsCache`
(definitions) and `terminalGroups` (live rows, both kinds, told apart by `isSpawnedTeamGroup`,
`terminals.js:1809-1814`).

**A group slot must never post `ptyStartTeam`.** The click handler's three arms
(`shell.js:643-693`) are: running + `groupId` → switch the terminals panel into that scope; running +
head, no `groupId` → focus the head; otherwise → start. A group has no definition to start, so it
must take the first arm only. Falling through to the start arm would post a `teamId` that resolves to
nothing — and `resolveTeamById` re-seeds on a miss today (Change 3 deletes that, so the order of these
two changes matters).

Naming, since both kinds now sit in one strip: a team slot and a group slot must be
distinguishable at 22px. The strip already carries a per-team initial and role-coloured jet; groups
need their own mark rather than borrowing the team jet, or the rail says two different things with
one picture. Note that Feature team and Coding both start with a consonant-heavy name and sit next to
each other — the per-team initial alone (F / C) is thin but adequate; the role-coloured jet (`lead`
vs `coder`) carries the rest.

## Verification Plan

### Automated

- A fresh board seeds exactly five definitions with the five fixed ids; Planning, Feature team,
  Coding and Review are `enabled: true`, Multi-agent planning `enabled: false`, all five
  `enabledSource: 'default'`.
- `coding-team` seeds `headRole: 'coder'`, one `intern` member, `pairProgramming: 'on'` **written
  explicitly on the row** (assert the stored value, not `readTeamPairProgramming`'s return — the
  default would pass either way), and `acceptedKinds: ['plan']`.
- `feature-implementation` keeps its id, is named *Feature team*, and carries
  `acceptedKinds: ['feature']`.
- **Band by position, not role, in one test:** a pair dispatch to the Feature team gives the `lead`
  head Band B and the `coder` seats Band A; a pair dispatch to the Coding team gives the `coder` head
  Band B and the `intern` seat Band A. The same `coder` role receives different bands on the two
  teams, and `pairBandSource` is `'team-head'` / `'team-seat'` respectively.
- The counterpart named in the Band B prose is the team's actual other seat — the Coding team's Band B
  dispatch does not say "a separate Coder agent is handling Routine".
- **Routing:** with both implementation teams live, a feature dispatch resolves to the Feature team's
  head and a plan dispatch to the Coding team's head, both with `source: 'accepted-kind'`. With only
  one live, the other kind resolves to it with `source: 'sole-live-team'` or is refused — never
  silently delivered as if it matched. With neither live, the dispatch is refused with a message
  naming the kind.
- `role-order-fallback` is never returned without a log line recording it.
- The recommended agent set computed from the **enabled** defaults is exactly `planner`,
  `researcher`, `lead`, `coder`, `intern`, `reviewer` — asserted against the defaults, not against a
  literal, so changing a default's roster changes the assertion's expected value by construction.
- Enabling a disabled team whose roles have no startup command reports the commandless roles rather
  than starting into bare shells.
- With all six configured, each enabled default reports zero commandless roles; with none
  configured, each reports its own roles and no team is silently startable into bare shells.
- **No default carries a `scope: 'shared'` member.** Assert it over the whole seeded set, not just
  the planner teams — this is what keeps `commandlessRoles` honest for the shipped defaults
  (`agentGroupInstantiation.ts:164` skips shared members), and it is the kind of property that gets
  quietly reintroduced by a later roster edit.
- With no `researcher` startup command configured, Planning's setup-surface report names
  `researcher`. This is the assertion that would have failed under the shared seat.
- The rail payload carries one entry per enabled team (running or not) plus one per live `grp_`
  group, and none for a disabled team or an ungrouped seat. A group entry is not startable — assert
  no `ptyStartTeam` post is reachable from it.
- Deleting a default is refused and the definition is still present after a reload.
- A disabled team: absent from `ptyListAgentGroups`, not a routing candidate in
  `resolveImplementationHead`, present in `listAgentGroups` with its flag, refused by
  `resolveTeamById`, and **does not appear in `migrateAgentGroups`' collision resolution** — enabling
  Multi-agent planning must not mark Planning `unassigned` (the field no longer exists; assert its
  absence).
- Reset: a board holding the legacy presets and an adopted `group-coding-*` comes back holding
  exactly the five defaults and nothing else; the reset runs once, not on every load.
- `unassigned`/`unassignedReason` appear nowhere in the source or in a seeded definition.
- The moved head-prompt copy still satisfies `coding-head-prompt-contract` and
  `standing-orders-marker-contract` after the rename (run `npm run compile-tests` first — contract
  suites run against `out/`).

### Goal invariants

- A team that exists is not necessarily a team that plays. Switching one off changes what the board
  does, not what it remembers.
- Every membership read can answer "which source decided this team is in play?"
- Every implementation dispatch can answer "which team took this, and which rule sent it there?"
- A seat's pair band is decided by its position on its team, never by its role string. No two seats
  on one team are told to do only the routine half.
- The Coding team stays two seats. Nothing is added to it that the Feature team already has — no
  reviewer, no lead, no review hop. Its cost is the reason it exists.
- There is one catalogue.
- Two teams sharing a head role is unremarkable. No team is demoted, flagged, hidden or refused for
  declaring the same `headRole` as another.
- A new user configures agents, never teams. No team configuration step exists on the first-run path.
- Nothing starts because the host booted.
- Every named arrangement — team or group — is reachable from the rail. Everything unnamed is
  reachable from the terminals panel icon.

### Manual

Fresh board: four teams live, Multi-agent planning present and greyed. Switch it on, switch Planning
off, restart the host, confirm the states survive. Confirm no default can be deleted and no confirm
dialog appears anywhere.

Start the Feature team and the Coding team together. Send a feature: the Feature team's lead takes it
and dispatches subtasks to its coders. Send a single plan: the Coding team's coder takes it, the
intern receives the Routine half, and the Feature team stays idle. Read both prompts and confirm the
coder was told to do Complex (Band B) work and the intern Routine (Band A) — the failure this plan
exists to prevent is both of them being told "Routine only".

## Outstanding Questions

- **[ANSWERED 2026-09-17 — NO QUICK CODING TEAM; SUPERSEDED IN PART 2026-09-18]** A fifth "Quick
  coding" default (lead + coder + intern, for batches of unrelated low-complexity cards) was proposed
  and dropped: the backlog case is the Dispatch queue plus one seat, not a team. That answer stands
  for *batches*. The `coding-team` added on 2026-09-18 is a different thing — two seats, one plan,
  split by complexity — and does not reopen the batch question.

- **[ANSWERED 2026-09-18 — FEATURE TEAM AND CODING TEAM ARE TWO TEAMS]** `feature-implementation` is
  renamed *Feature team* and is delivered features. A new `coding-team` (coder head + one intern,
  pair programming always on) is delivered plans. Routing is specified in this plan (Change 7) rather
  than deferred to `a-team-declares-what-work-it-accepts`, because the split does not work without
  it. Operator decision.

- **[ANSWERED 2026-09-17 — ALL TEAMS AND GROUPS]** The rail is not defaults-only and is not
  teams-only. It renders every enabled team (default or operator-built) and every live group.
  Unassigned agents are not rail entries — they are the default view behind the terminals panel icon.
  The "three fixed slots, defaults only" model in `terminals.js:1749-1755` and `shell.js:590-592` is
  outdated and goes.

- **[ANSWERED 2026-09-17 — PEER PLANNERS]** Default #5 is the peer-planner topology from
  `Multi-Agent Planning Team — Fan-Out Head Prompt and Peer-Planner Roster`, not catalogue A's
  fan-in researcher+analyst roster. The fan-in shape is Planning with a bigger roster — the same
  duplication "Batch planners" was cut for — and it ships with no `headPrompt`, so its head plans
  alone beside three idle seats. That card lands first; this plan seeds default #5 from it and does
  not fork its own copy.

- **[ANSWERED 2026-09-17 — RESET]** Existing team definitions are disposable; teams are unreleased
  dev work. No migration, no fold, no preservation of the adopted `group-coding-*` row. Change 5 is a
  reset.

- **[ANSWERED 2026-09-18 — THE RESEARCHER IS A PER-TEAM MEMBER]** The researcher seat on both
  planner-headed defaults is an ordinary `per-team` member, not `scope: 'shared'`. Shared scope
  spawns unparented, is skipped by the commandless report, and is exempt from the delegate cap, while
  its one benefit — a single researcher across planner teams — does not currently occur, because the
  reuse key is the team's name. With Multi-agent planning shipped off there is one planner team on
  first run, so per-team costs no extra seat. Operator decision. Reconcile with Change 3 of
  `a-live-researcher-seat-is-ignored-because-the-gate-asks-config-not-the-fleet`, which assumes the
  facility model — see Dependencies.

- **[ANSWERED 2026-09-18 — NO REVIEW STEP]** The Coding team's intern gets no review hop. Its Band A
  work rides out with the coder's Band B commit, and the coder's final integration check
  (`agentPromptBuilder.ts:2452`, *"only check and integrate the Coder's Routine work as a final step"*)
  is the only review. **This team is deliberately the light one** — two seats, one plan, no reviewer,
  no extra hop. Adding a review step would make it the Feature team with fewer coders, which is not
  what it is for. A plan that needs reviewing goes to the Review team as its own dispatch. Operator
  decision.

---

## Implementation Summary (2026-09-19)

All ten changes landed in the standalone host and the shared services; the legacy
extension host is out of scope and keeps `resolveCodingHeadFromGroups` as its
resolver. `DEFAULT_TEAM_DEFINITIONS` now holds five rows with fixed ids —
Planning, Feature team, Coding (`coder` head + one `intern`, `pairProgramming: 'on'`,
`acceptedKinds: ['plan']`), Review, and Multi-agent planning (`enabled: false`,
peer-planner roster and fan-out `headPrompt`) — each stamped `enabled` +
`enabledSource` at seed time, with a researcher seat on both planner-headed rows
as an ordinary `per-team` member and no `scope: 'shared'` member anywhere.
`unassigned`/`unassignedReason` and the head-role collision step are deleted
outright, `_deleteAgentGroup` refuses a default id, `resolveTeamById`'s on-demand
re-seed is gone, and `terminals.agentGroups` resets to the five defaults once
behind a marker key.

`resolveCodingHeadFromGroups` is replaced at every standalone call site by
`resolveImplementationHead(root, kind)`, which returns `{ head, teamId, source }`
with `'accepted-kind'` / `'sole-live-team'` / `'role-order-fallback'` and logs the
fallback every time it is taken; the Run-queue refusal now names the kind and the
team that would have taken it. The pair band became a dispatch input
(`pairBand` / `pairBandSource` / `pairCounterpartRole`) resolved from the team
definition by position — head takes Band B, seats take Band A — so a `coder` head
and a `coder` seat no longer receive the same directive.

Catalogue A (`SHIPPED_TEAM_TYPES`) is deleted; the Teams tab renders one list with
an IN USE switch per card, no delete affordance on the five defaults, and a
per-team report of roles with no startup command, while the six recommended roles
are derived host-side from the enabled defaults and marked on the agents tab. The
rail now emits one slot per enabled team definition plus one per live `grp_` group,
with group slots carrying no `definitionId` so they can never post `ptyStartTeam`.
Contract suites pinned to the retired model were retargeted, not weakened
(`coding-head-prompt`, `standing-orders-marker`, `stage-marker-commit`,
`teams-tab-no-start`, `queue-pipeline`, `shell-terminal-strip`); per the run
directives, compilation and the automated verification suites were not executed as
the plan's verification pass — the checks remain written down above.

## Review Findings

Reviewed the implementation in `a047eef2` against this plan; the five defaults, the in-use
switch, the `unassigned` deletion, catalogue A's removal and the derived recommended set all
verify at runtime (5 rows, correct ids/rosters/kinds, `enabledSource: 'default'` stamped, no
`scope: 'shared'` member, exactly `coder, intern, lead, planner, researcher, reviewer`).
Four regressions were found and fixed: `isUntouchedSeed` (`src/services/teamWiring.ts`) did a
strict group key-set match that the eight new seed keys broke, which made every pre-upgrade
`feature-implementation` row read as *authored* and resurrected the phantom-seed bug in
`listTeamsInRoots` (it reads raw and the one-shot reset never touches an unopened root); and
three CI-gated suites still pinned the deleted `SHIPPED_TEAM_TYPES` or the pre-flight that moved
out of `instantiateAgentGroupCore` — `src/test/team-scoped-role-routing.test.js`,
`src/services/__tests__/agentPromptBuilder.test.ts` and
`src/test/standalone-agent-team-isolation-contract.test.js`, all retargeted to the surviving
catalogue and the extracted `resolveCommandlessRoles`, not weakened.
`npm run compile-tests` is clean and the eight team-touching contract suites now pass
(`team-scoped-routing` 68/68, `agent-machines` all, `standalone-agent-isolation` 23/23,
`team-autostart-scope` 23/23, `teams-tab-no-start` 9/9, `shell-terminal-strip` 75/75,
`coding-head-prompt` all, `terminal-groups-headrole` 8/8); the failures remaining in
`standing-orders-marker`, `stage-marker-commit`, `queue-pipeline`, `default-prompt-previews` and
the other five in `reviewer-prompt-behaviour` were each traced by blame to earlier commits and
are not this change.
The verdict on Changes 6 and 7 is **provisional**: neither the pair band nor the work-kind
routing has an automated check that discriminates on its correctness — `pairBand`,
`acceptedKinds` and `recommendedAgentRoles` appear in no test, and the only
`resolveImplementationHead` assertions are source-text regexes that accept the old resolver name
too — and the Manual section was not executed in this pass.

## Deferred Findings

- MAJOR — The Band A fan-out leg cannot reach the Coding team's intern in either host.
  `_dispatchWithPairProgrammingIfNeeded` builds the seat prompt with `pairBand: 'A'` /
  `pairBandSource: 'team-seat'` and hands it to `executeCommand('switchboard.dispatchToCoderTerminal')`,
  a command registered only in `src/extension.ts:2022` and never in `switchboardCommandRegistry`,
  so in standalone it hits the vscodeShim's warn-once dead end; where it *is* registered,
  `dispatchToCoderTerminal` resolves role `'coder'` board-wide and `_resolveAgentTerminalForPlan`
  skips interns outright in pair mode. Pre-existing for standalone, but this plan is what makes
  the head resolution reach a coder-headed team, so the new band machinery is built and still
  unreachable. Fixing it means registering a new command seam in the standalone host and
  re-targeting the delivery leg at the team's own seat — a destination decision beyond this
  plan's Change 6. `src/services/KanbanProvider.ts:8296`,
  `src/services/TaskViewerProvider.ts:14005`, `src/services/TaskViewerProvider.ts:12388`.
- NIT — `void pairBandSource;` computes the band's source and discards it; the builder never
  renders or logs it (the dispatch site does). Dead as written. `src/services/agentPromptBuilder.ts:2008`
- NIT — `readTeamAcceptedKinds`' docblock says `'default'` means "the team declares nothing", but
  every seeded default declares kinds *with* source `'default'`; only `value === null` separates
  the two. `src/services/teamWiring.ts:748`
- NIT — The rail builds from `_agentGroupsCache`, filled asynchronously and skipped entirely when
  `isKanbanDock`, so the first fleet push after load renders an empty strip until the 5s poll
  converges; the retired module constant guaranteed slots immediately. `src/webview/terminals.js:1836`
- NIT — The reset marker is read before the write chain and written after it, so two windows
  loading concurrently can both reset, and a second window that read "not ran" first can wipe
  edits made in between. `src/services/KanbanProvider.ts:5514`
- NIT — Planning and Review carry no explicit `pairProgramming`, against this plan's
  "written explicitly on every default that has an intended intensity" rule; harmless only
  because `resolveTeamPairProgrammingForTerminal` forces `'off'` on a team with no coder/intern
  seat. `src/services/teamWiring.ts:759`
- NIT — The in-use switch writes optimistically with no rollback key (unlike team creation), so a
  failed `saveAgentGroup` leaves the tab showing a state the store does not hold until the next
  `getAgentGroups`. `src/webview/agent-control.js:1348`
- NIT — `dynamicComplexityRoutingState` was added to the connect-time resync, which is outside
  this plan's scope; verified benign (idempotent webview handler, no second sender on this path).
  `src/services/KanbanProvider.ts:1769`


## Correction (2026-09-19, post-review)

The table above originally gave the Feature team **3 × `coder`**, inherited from
*The Three Preset Teams Ship Member-Less* under this plan's own note that it "does
not re-derive" the Planning/Feature/Review rosters. That inheritance was wrong:
`feature-implementation` held `members: []` at the time, so the three-coder roster
came from a stale constant rather than from anything in use. The implementation
team the operator was actually running (`group-coding-mswk2w8r`, discarded by
Change 5's reset) was **lead + 2 × `coder` + 1 × `intern`**.

Corrected in the seed and backfilled onto the live board. The review that passed
this plan checked the implementation against the table and never asked whether the
table matched the board — the same class of miss as the rest of this session.
