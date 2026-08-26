# Nothing states what POST /kanban/dispatch is for, so dispatch reads as forbidden and features get routed by complexity

## Goal

Give Mission Control a single, unambiguous dispatch contract: one authority on which call routes
work, and an explicit rule that a feature goes to its team lead rather than to a complexity-matched
seat. Two documents currently contradict each other on both points, and both observed failures are
that contradiction resolving the wrong way.

### Problem Analysis

Two reported symptoms, one root cause.

**Symptom A — "it refuses to use the dispatch endpoint, claiming it is forbidden."** It is
forbidden. `.agents/protocols/switchboard-mission-control/SKILL.md:39` is Hard Rule 6:

> **Dispatch via the queue, never via `POST /kanban/dispatch`.** You never call
> `POST /kanban/dispatch` to route work to a specific coder terminal — that is unconditional and
> holds in both pacing modes.

Meanwhile `.claude/skills/switchboard/SKILL.md:230-236` (the console persona now sitting at
`/switchboard`) says the opposite:

> **Dispatch a plan to be coded — ONE call:** `POST /kanban/dispatch` …

A prohibition marked *unconditional* on one side, a "ONE call" instruction on the other.

**But these two documents should not normally share a context**, so Hard Rule 6 alone does not
explain a refusal inside `/switchboard`. `ClaudeCodeMirrorService.ts:46` records that
"switchboard-mission-control is NOT in the manifest — the engine launches it by path", so the
protocol reaches an agent only through the panel/`POST /mission-control/start` door. A refusal
observed in the console needs a cause the console actually loads.

**It has one, and it is the strongest instruction in the repo.** `CLAUDE.md:128` — project
instructions, always loaded, explicitly overriding default behaviour:

> Kanban column transitions are handled automatically by the system/host. Execution agents must
> **NEVER** attempt to update kanban columns directly via SQL **or any other method** during normal
> workflow execution. … To manually move a card when explicitly requested by the user, use the
> `kanban_operations` skill. The **orchestrator persona** is the sanctioned exception — it moves
> cards via `move-card.js`/`POST /kanban/move` …

`POST /kanban/dispatch` "persists the move first" before firing the role prompt
(`.claude/skills/switchboard/SKILL.md:238-240`) — so calling it *is* updating a kanban column by
"any other method". The rule then names exactly one exception: **"the orchestrator persona."** That
persona was renamed to Mission Control — `migrateLegacyOrchestratorDir` exists for the directory
half of that rename, and the manifest calls it `switchboard-mission-control`. **So the exception now
matches no persona by name, and the console is not it under any reading.** An agent applying
`CLAUDE.md:128` faithfully concludes that dispatch is not its call to make, and says so.

Two independent sources produce the same refusal: `CLAUDE.md:128` for the console door, Hard Rule 6
for the Mission Control door. Fixing one leaves the other.

**Symptom B — "it dispatches features into team members based on feature complexity instead of the
team lead."** The console persona teaches complexity-band routing as *the* assignment rule
(`.claude/skills/switchboard/SKILL.md:236-237`):

> routes by the plan's complexity through the board's own rule (default bands: 1–4 →
> INTERN CODED, 5–6 → CODER CODED, 7+/unknown → LEAD CODED …)

An agent that absorbs "complexity decides who codes it" then applies it to features. That is wrong
twice over:

1. **The shipped default is head pacing, not seat pacing.** `KanbanProvider.resolveTeamPacing`
   (`src/services/KanbanProvider.ts:5532`) returns `'head'` when the head leads no registered group
   or the DB is unavailable, and `:5101` writes `'seat'` only when the template says so — absent
   reads as head. `LocalApiServer.ts:1917` does the same: `pacingOverride ?? 'head'`, with the
   comment at `:1751` naming `'head'` as "the regression gate for ~4,000 installs". **Unless the
   operator set `pacing: seat` on the team, every card should reach the lead.**
2. **The agent is not supposed to choose the seat at all.** The protocol is explicit
   (`:40-42`): `POST /kanban/queue/next` with `{ from: "<lead terminal name>" }` "hands the next
   staged card to the lead (head pacing) or to the complexity-routed seat (seat pacing). The call's
   response names the actual destination." And `:244`: the seat-pacing precondition is the team's
   `pacing` field, which "You **read** … you do not set". Routing is a *backend* decision the agent
   reads back. The console persona's bands invite the agent to make it in its head.

**And features have their own door that neither document foregrounds.** The console persona lists
`POST /kanban/orchestration/dispatch` for "Dispatch a feature's coding" in a single unexplained
bullet (`.claude/skills/switchboard/SKILL.md:243`), while the protocol at `:316` says a feature in
`PLAN REVIEWED` is dispatched by messaging the coding team lead via `queue/next` or `ptySendPrompt`.
A feature is a container; sending it to an intern seat because its rolled-up complexity scored 3 is
a category error, and nothing in either document says so in as many words.

### Root Cause

**No document states what `POST /kanban/dispatch` is for.** Three state what it is *not* for —
`CLAUDE.md:128` (agents never move columns, one named exception), Hard Rule 6 (never, unconditional),
and the console's own Hard Rule 1 ("you are the manager, never the coder") — and one states, without
scope, that it is "ONE call". A capability described only by its prohibitions has no positive
definition an agent can reason from, so it defaults to refusal, which is the safe reading.

Two aggravating factors. First, `CLAUDE.md:128`'s sole exception names "the orchestrator persona",
a name the rename retired, so the carve-out matches nothing today. Second, Hard Rule 6 gives a bare
"never" with no rationale: an agent cannot distinguish "never, because the queue owns pacing and a
direct dispatch bypasses it" from "never, this endpoint is off-limits", so it reports the latter.
A rule with no rationale degrades into a refusal.

The complexity-band symptom is the mirror image. The bands are the one *positively* stated routing
rule an agent is given, so they get applied — including to features, where they are a category
error — while the actual mechanism (`queue/next` returns the destination; pacing defaults to head)
is documented as a thing to read back rather than as the rule.

### Non-goals

- **Not changing the backend routing.** `resolveTeamPacing`, the bands, `queue/next`, and the
  pacing default are correct and are the regression gate for ~4,000 installs. This plan changes what
  agents are *told*, not what the server does.
- **Not removing `POST /kanban/dispatch`.** It has legitimate callers (the console path, a
  user-named column, a single ad-hoc dispatch). It needs a stated scope, not deletion.
- **Not implementing seat pacing differently.** Seat pacing works; the agent must stop pre-empting it.
- **Not settling which persona owns `/switchboard`.** That is
  `the-skill-sync-overwrote-the-mission-control-launcher.md`.

## Metadata

**Complexity:** 4
**Tags:** bugfix, docs, reliability, backend

## User Review Required

Yes — one decision.

**What is `POST /kanban/dispatch` for, now that the queue owns pacing?** Recommendation: **scope it
to "an operator naming one card and one destination", and say so on both sides of the contract.**
That gives a rule an agent can apply with judgement:

- **Mission Control never calls it** — it manages lanes, and lane pacing lives in the queue. Hard
  Rule 6 keeps its prohibition but gains its *reason*, plus a pointer to what to call instead.
- **A direct, user-initiated single dispatch may call it** — "dispatch card 3 to the coder" is an
  instruction with an explicit destination and no pacing question.
- **A feature never goes to a complexity-matched seat.** A feature container goes to its team lead
  (head pacing) or through `/kanban/orchestration/dispatch`; the bands apply to standalone plans
  only, and only when the team is in seat pacing.

The alternative — one endpoint, one rule, "always the queue" — is cleaner to document but removes
the operator's ability to hand a single card to a named seat, which is a thing they do.

## Complexity Audit

### Routine

- Adding the rationale and the "call this instead" pointer to Hard Rule 6.
- Deleting the complexity-band paragraph from the console persona, or scoping it.

### Complex / Risky

- **The bands must not simply be deleted.** They are the *backend's* documented behaviour for
  seat-paced standalone plans, and `/kanban/dispatch` really does apply them. Removing the text
  leaves an agent unable to explain a routing decision the server made. Scope it — "this is what the
  server decides, and you read it back from `routing`" — rather than erase it.
- **"Read the response, do not assume" is the load-bearing instruction and it is easy to lose.**
  Both `:40` and `:260` already say the response names the destination. The failure is that a
  competing document gave the agent a way to *predict* it. Prediction is the bug; the fix must
  remove the ability to predict, not just add another reminder.
- **Feature vs standalone must be checkable, not inferred.** `GET /kanban/plans` returns
  `isFeature` (the protocol's own `ready ()` helper at `:104-112` uses it). The rule should key on
  that field, so "is this a feature" is a read, not a judgement about the title.
- **A prohibition needs its exception enumerated or it will be over-applied.** The current failure
  mode *is* over-application. Whatever scope `/kanban/dispatch` keeps must be written where an agent
  looking at Hard Rule 6 will see it — not in a different file.
- **Both mirrors move together.** `.claude/skills/switchboard/SKILL.md` and
  `.agents/workflows/switchboard.md` are the same document for two hosts.

## Edge-Case & Dependency Audit

**Race conditions**
- A team's `pacing` field changed between the read and the `queue/next` call: the response is
  authoritative, the read is not. This is exactly why the destination must be reported from the
  response.
- No lead terminal live for a feature: `:42` already says record it and continue. Preserve that.

**Security**
- None. No new endpoints, no new surface, no credential path.

**Side effects**
- An agent that stops predicting destinations will report them one beat later (after the call rather
  than before). Reports must be written to name the returned destination, not a planned one.
- Any saved prompt, doc, or plan that quotes the complexity bands as *the* routing rule becomes
  inconsistent. Grep for them beyond these two files before finishing.

**Migration**
- Documentation only. No schema, settings, or stored state. Backend behaviour is unchanged by
  construction, so the ~4,000-install head-pacing regression gate is untouched.

## Dependencies

- **Related:** `the-skill-sync-overwrote-the-mission-control-launcher.md` — that plan decides which
  persona a user reaches; this one makes the dispatch contract coherent whichever it is. Neither
  blocks the other, but landing the launcher restore first removes the second voice entirely and
  makes this plan's verification cleaner.
- **Reads, does not change:** `switchboard-contracts` (move↔dispatch coupling, cards move on coding
  start).

## Adversarial Synthesis

Key risks: (1) adding a rationale to Hard Rule 6 while leaving the console persona's "ONE call"
text in place, so the contradiction survives and the agent keeps refusing; (2) deleting the
complexity bands outright, leaving an agent unable to explain a `routing` field the server returned;
(3) writing "features go to the lead" as prose without keying it to the `isFeature` field, so the
agent guesses from titles; (4) fixing only `.claude/skills/switchboard/SKILL.md` and leaving
`.agents/workflows/switchboard.md` to contradict it — the two-host divergence trap `CLAUDE.md`
names; (5) treating this as a wording tidy-up and not verifying against a real board, so
head-vs-seat behaviour is asserted rather than observed. Mitigations: edit both sides of the
contradiction in one commit across both mirrors; scope the bands to "what the server decided, read
from `routing`" instead of deleting them; key the feature rule to `isFeature`; and verify on a live
board in both pacing modes, asserting the reported destination equals the response's.

## Proposed Changes

1. **Give Hard Rule 6 its rationale and its alternative** — state *why* Mission Control does not
   call `POST /kanban/dispatch` (the queue owns pacing; a direct dispatch bypasses it) and name what
   to call instead, in the same rule. An unexplained "never" is what produced the refusal.
2. **Enumerate `/kanban/dispatch`'s remaining scope** in the same place, so the prohibition cannot
   be read as "this endpoint is off-limits to everyone".
3. **Add an explicit feature rule, keyed to `isFeature`:** a feature container is never routed to a
   complexity-matched seat. Head pacing → its team lead via `queue/next` with
   `{ from: "<lead>" }`; the bands apply to standalone plans, and only under seat pacing.
4. **Scope the console persona's complexity-band paragraph** (`.claude/skills/switchboard/SKILL.md:236-237`)
   from "how work is assigned" to "what the server decided — read it back from `routing`", and remove
   the standing invitation to predict a destination.
5. **State the read-back rule once, strongly:** the destination in every report comes from the call's
   response. Never from a band, a title, or a plan's complexity.
6. **Fix `CLAUDE.md:128`'s stale exception** — it names "the orchestrator persona", which the rename
   retired, so no current persona matches it. Name Mission Control, and state whether a
   dispatch-that-moves-a-column is inside or outside the prohibition. This is the rule the console
   door actually reads.
7. **Mirror every edit** into `.agents/workflows/switchboard.md` in the same commit.
8. **Sweep for other copies of the bands** across `.agents/`, `docs/`, and `.claude/skills/`, and
   scope or annotate each.

### Migration

Documentation only — no schema, settings, stored state, or backend behaviour changes. Head pacing
remains the default for absent `pacing` fields, so no install changes behaviour.

## Verification Plan

1. **No surviving contradiction.** Grep both mirrors and the protocol for `/kanban/dispatch`; every
   occurrence is consistent with the agreed scope, and none instructs Mission Control to call it.
2. **The prohibition carries a reason and an alternative.** Hard Rule 6 names why and names
   `queue/next`; a reader cannot arrive at "forbidden endpoint" from it.
2b. **The console door does not refuse either.** With only the console persona loaded (no protocol),
   assert a user-named single dispatch is performed rather than declined on `CLAUDE.md:128` grounds,
   and that `CLAUDE.md`'s exception names a persona that exists.
3. **Head pacing sends a feature to the lead.** On a board with a team whose `pacing` is absent,
   dispatch a feature in `PLAN REVIEWED` via Mission Control; assert `queue/next`'s response names
   the **lead** terminal and the agent's report quotes that name.
4. **Seat pacing routes standalone plans by complexity, and the agent does not pre-empt it.** Set a
   team's `pacing` to `seat`; stage standalone plans of complexity 3, 5 and 8; assert each lands on
   intern/coder/lead per the response, and that the agent's report names the returned seat rather
   than a predicted one.
5. **A feature is never seat-routed.** With `pacing: seat`, dispatch a feature container; assert it
   does not land on an intern seat on the strength of its complexity.
6. **No lead, no crash.** Remove the lead terminal and dispatch a feature; assert the session log
   records it and the run continues with features that do have a lead (`:42`).
7. **Both mirrors agree.** `diff` the two front-door files; only frontmatter differs.
8. **The default is untouched.** Assert `resolveTeamPacing` still returns `'head'` for a team with
   no `pacing` field — the ~4,000-install regression gate (`LocalApiServer.ts:1751`) is unchanged.
