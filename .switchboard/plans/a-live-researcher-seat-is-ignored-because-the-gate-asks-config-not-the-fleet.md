# A Live Researcher Seat Is Ignored, Because the Gate Asks Config Instead of the Fleet

## Goal

Make the researcher rule what it reads like: **if a researcher seat exists, the research goes to it.**
Today a live researcher seat on the standalone host is invisible to the decision that matters, so the
planner hands its research prompt back to the operator to run by hand — with a researcher sitting
idle beside it.

### Problem analysis

**The hand-off already exists, end to end.** The planner prompt carries a `RESEARCHER HAND-OFF`
directive (`agentPromptBuilder.ts:1247`) telling it to POST the research prompt to
`/research/dispatch` before showing it to the operator. `LocalApiServer` serves that route
(`:10135`) and delegates to the host's `onDispatchResearch` callback (`:10180`). The standalone
host's arm (`bootstrap.ts:5202-5210`) does exactly the right thing:

```ts
const active = ptyFleetService.listActive();
const researcher = active.find(t => t.role === 'researcher' || t.friendlyName?.toLowerCase() === 'researcher');
if (!researcher || researcher.status !== 'active') { return { dispatched: false, reason: 'no researcher agent configured' }; }
```

**It asks the live fleet.** That is the seat-exists rule, correctly implemented.

**But the planner is never told the door is there.** The directive is split in two at build time on
`options.researcherConfigured` (`agentPromptBuilder.ts:1972`, `:2163`) — when false, the
planner *never sees the POST instructions at all* and goes straight to the chat-paste fallback. That
flag is resolved by `isResearcherConfigured` (`TaskViewerProvider.ts:9212`):

```ts
const name = await this._getAgentNameForRole('researcher', resolvedRoot);
return !!name;
```

A **configured agent name**, not a live seat. And its own docblock claims the mirror:

> *"Mirrors the resolution logic in `_dispatchResearchToResearcher` (same `_getAgentNameForRole`
> call) so the prompt-time gate and the runtime dispatch see the same 'configured' answer."*

**That claim is true for the extension host and false for standalone.** The extension's
`_dispatchResearchToResearcher` (`TaskViewerProvider.ts:7429+`) does resolve through
`_getAgentNameForRole` and then through `this._registeredTerminals` / `vscode.Terminal` — the VS Code
terminal registry, which on the standalone host holds nothing. Standalone's arm ignores agent-name
config entirely and reads the pty fleet. So the gate and the runtime ask **two different questions**,
and the docblock asserting they ask one is the reason nobody noticed.

**The failure is silent and one-directional.**

| live researcher seat | configured agent name | gate | outcome |
| :--- | :--- | :--- | :--- |
| yes | no | **false** | planner never attempts the POST — **pastes the prompt for the operator to run** |
| no | yes | true | POST attempted, `dispatched:false`, clean fallback — wasteful, harmless |
| yes | yes | true | works |
| no | no | false | correct |

Row 1 is the reported behaviour: *"researcher agent should literally be, if this seat exists, use it
instead of pasting research prompt."* The seat exists. The gate does not look at it. The operator
actions the planner's research by hand, which is the single thing the researcher role exists to
prevent.

**This is the composition-root divergence the repo keeps getting caught by.** Not a verb — a
predicate with two implementations, where the host that ships (standalone) wires one and the host
being removed (extension) wires the other. No gate catches it: both compile, both are reachable, and
the flag's failure value (`false`) is indistinguishable from an honest "no researcher here."

**Second defect — a shared member is shared with one team, not with planners.** `spawnDelegates`
names a `scope: 'shared'` member `` `${teamName}-${d.label || d.role}` `` and reuses a live instance
only under that exact name (`goPtyFleetProjection.ts:668-690`). So a `Planning` team spawns
`Planning-researcher` and a `Multi-agent planning` team spawns `Multi-agent planning-researcher` —
two researcher CLIs, each idle most of the time, when what was asked for was one researcher serving
many planners. The reuse key is team-scoped; the facility is meant to be role-scoped.

**This defect no longer touches the shipped defaults.** Operator decision, 2026-09-18, recorded on
`teams-are-four-defaults-and-you-can-switch-them-off`: the researcher seat on both planner-headed
defaults is an ordinary `per-team` member, **not** `scope: 'shared'`. Shared scope spawns unparented,
is skipped by the commandless-roles report (`agentGroupInstantiation.ts:164`) so an unconfigured
researcher is announced by nothing, and is exempt from the delegate cap (`:654`) so its RAM is
unaccounted — while its one benefit does not currently occur, for the reason just given. With
Multi-agent planning shipped off there is one planner team on first run, so per-team costs no extra
seat.

So this defect is now a **latent one, for operator-built teams that opt into `scope: 'shared'`** —
still worth fixing (Change 3), no longer on the path of anything that ships. Nothing else in this
plan depends on it: the gate fix below matches a researcher seat on `role`, never on parentage or
team membership, so it works identically for a per-team seat.

### The rule

One predicate, asked of the fleet, used by both the gate and the runtime:

> **Is there a live seat whose role is `researcher`?**

Nothing else decides. Not a configured agent name, not team membership, not which team spawned it.
A researcher seat is a facility any planner uses if it is there.

## Metadata

**Complexity:** 3
**Tags:** researcher, planner, prompt-composition, standalone, divergence, bugfix
**Scope:** `agentPromptBuilder.ts` gate resolution, `KanbanProvider.ts:7060`, the standalone
composition root, and `goPtyFleetProjection.ts`'s shared-member reuse key. The extension host is not
wired for this — it is being removed, and its `_registeredTerminals` researcher path goes with it.

## Dependencies

None blocking. **Blocks** `teams-are-four-defaults-and-you-can-switch-them-off` from delivering on
its researcher seat: that plan puts a researcher on both planner-headed defaults, and without this
fix the seat spawns, idles, and the planner still hands its research to the operator — because the
gate asks whether an agent *name* is configured, not whether a seat is live.

That seat is a **`per-team`** member, not a shared one (decision of 2026-09-18 — see *Second defect*
above). Changes 1 and 2 are what that plan depends on and are unaffected by the distinction.
**Change 3 is not a prerequisite for it** and exercises nothing in the shipped default set.

## Proposed Changes

### 1. One researcher predicate, on the fleet

Add a single host-side resolver — "is a researcher seat live?" — answering from
`ptyFleetService.listActive()` with the same match standalone's `onDispatchResearch` already uses
(`role === 'researcher'`, or the friendly-name match it also accepts). Both the prompt-time gate and
the runtime dispatch call **it**, not their own copy. Two implementations of one question is the
defect; adding a third is not the fix.

Return the answer **tagged** — `{ live: boolean, seat?: string, source: 'fleet' }` — so a prompt
build can record which seat it promised the planner, per the repo's fallback rule. "Why did the
planner paste the prompt?" must be answerable after the fact.

### 2. Resolve `researcherConfigured` from that predicate (`KanbanProvider.ts:7060`)

Replace the `isResearcherConfigured` call with the fleet predicate, and rename the option to
`researcherSeatLive` — `configured` is the word that caused this, and leaving it invites the same
substitution again. Update the directive's own copy at `agentPromptBuilder.ts:1247`, which currently
tells the planner *"A Researcher agent is configured for this workspace"*, to say a researcher seat
is live.

`isResearcherConfigured` (`TaskViewerProvider.ts:9212`) loses its only caller and is deleted along
with the docblock asserting a mirror that was never true in the host that ships.

### 3. Make a shared member shared across teams (`goPtyFleetProjection.ts:668-690`)

**Not a prerequisite for the defaults** — no shipped default uses `scope: 'shared'` (see *Second
defect*). This is the fix for operator-built teams that opt into it, and it can land after Changes 1
and 2 or in a separate pass.

Key the shared-member reuse on **role** (plus machine), not on `${teamName}-${role}`, so the second
team that starts adopts the live seat instead of spawning its own. The seat is already
spawned unparented on this branch, so no ownership model changes — only the name it is looked up by.

Name it for what it is (`researcher`, suffixed on genuine collision) rather than after whichever team
happened to start first. A facility named `Planning-researcher` that Multi-agent planning is also
using is a label that lies about who it serves.

Consequence to check: `wireSpawnedTeam` writes member names into the registered group row
(`terminals.groups`), so one researcher will now appear in two teams' rosters. That is correct and is
what shared scope means — but `resolveTeamMembersForHead`'s in-flight predicate reads those rosters,
so confirm a shared researcher does not make two teams look mutually busy.

### 4. Leave the researcher relationship alone

The `researcher` link preset (`linkPresets.ts:56-65`) installs: *"When you hit a question that needs
**external sources, documentation or API details** you do not already have… Keep working on what you
can while it runs, and fold its answer in when it comes back. **Do not block on it.**"*

**That is correct and does not change.** A researcher is for external web research. Planners read
code themselves — that is not work to delegate, and a researcher is not a code-search subagent. The
non-blocking contract is right for the same reason: a web lookup is a fact to fold in, not a draft
the planner must wait on.

Recorded here because the wording invites exactly one wrong edit — widening the preset to in-repo
investigation, which is what the retired "Planning with analyst" type was reaching for and is not
what this role is. Do not widen it.

## Verification Plan

### Automated

- Fleet holds a live `researcher` seat and **no** configured researcher agent name → the built
  planner prompt contains the hand-off directive. This is the regression; it fails today.
- No live researcher seat but a configured agent name → prompt omits the directive (no wasted POST).
- The gate and `onDispatchResearch` resolve through the same predicate — assert one implementation,
  by call site, not by comparing two outputs.
- `POST /research/dispatch` with a live researcher seat returns `dispatched:true` and names the seat.
- Two teams whose researcher is declared `scope: 'shared'` and started in sequence produce **one**
  researcher seat, and the second team's registered roster names that same seat. This is Change 3's
  assertion and it must be written against explicitly-shared definitions — **the shipped defaults are
  `per-team` and correctly produce one researcher each**, so asserting it over the defaults would
  fail and asserting it over "two planner teams" would silently stop testing anything.
- Run `npm run compile-tests` before any `test:contract:*` script — contract suites run against
  `out/`.

### Goal invariants

- A live researcher seat is used. There is no configuration a user must also set.
- Every prompt build can say which seat it promised, or that there was none.
- One researcher serves many planners **wherever the seat is declared shared**. Where it is
  declared `per-team` — as every shipped default declares it — each team has its own, and the gate
  finds it just the same.

### Manual

Start Planning with no researcher configured anywhere. Confirm a `researcher` seat comes up, give the
planner work that needs an external lookup — a library's API, a spec, current documentation — and
confirm the research lands in the researcher's terminal and its findings are saved, with nothing
pasted into chat for the operator to run.

## Outstanding Questions

- **[ANSWERED 2026-09-17 — NO CHANGE]** The researcher is for **external web research**; planners do
  their own code reading. The shipped preset prose and its non-blocking contract are both correct and
  stay as they are. An earlier draft of this plan proposed rewriting them for in-repo code search —
  that was wrong and is struck.
- **[ANSWERED 2026-09-17 — AUTO-START WITH PLANNING; AMENDED 2026-09-18]** The researcher comes up as
  part of the Planning team's start, via the researcher member on the Planning default. The operator
  never starts it by hand. This is team-start-time, not boot-time — it does not reintroduce the boot
  sweep that `Delete Auto-Start` removed. **Amended:** that member is `scope: 'per-team'`, not
  `scope: 'shared'` — the start behaviour described here is unchanged either way.
