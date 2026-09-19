# Generic Pair Programming Is Retired — a Team Pairs, Anything Unassigned Does Not

## Goal

Delete **on/off** as a stored value anywhere. Pairing is not configured — it is
derived from the arrangement:

- **a team pairs**, because that is what a team is: a head takes the Complex /
  Risky half and its seats take the Routine half;
- **anything unassigned does not** — a lone seat, or a group, has no head and no
  seats to split between.

An operator who does not want pairing uses a group. That is the opt-out, and it
needs no field.

**`aggressivePairProgramming` survives untouched. It is a PLANNER setting**, not a
pairing switch — see below. This plan does not move it, rename it or fold it into a
team definition.

### What aggressive actually is, and why it is not in scope

`AGGRESSIVE_PAIR_PROGRAMMING_DIRECTIVE` (`agentPromptBuilder.ts:1763`) is applied to
the **`planner` role** (`:2219`) and reads:

> *Only classify tasks as Complex / Risky if they involve … Everything else — even
> if it touches multiple files or requires careful reading — should be Routine.*

It moves **where the Band A / Band B line falls** when a planner writes a plan. It
says nothing about whether a pair exists. The lead's copy (`:2520`) is a consequence
— "routine scope has been expanded, pay extra attention during integration" — not a
second control.

So it answers a different question from the one this plan deletes, and it keeps its
current home: a planner setting in the prompts config. Folding it into a team
definition would be the same mistake in reverse — moving a planning-time
classification rule onto a dispatch-time roster.

## Problem analysis

**Board pair programming was designed before teams existed.** `pairProgrammingMode`
lives on `_autobanState` (`'off' | 'cli-cli' | 'cli-ide' | 'ide-ide'`), a board-wide
enum from the VS Code product, when "pairing" meant one lead terminal and one coder
terminal and there was no roster to read.

**It is a second source of truth for a decision the arrangement already answers.**
`_dispatchWithPairProgrammingIfNeeded`:

```ts
const mode = this._autobanState?.pairProgrammingMode ?? 'off';
const pairActive = teamPP ? teamPP.intensity !== 'off' : mode !== 'off';
```

The team wins *when a team answers*, so the enum governs only the teamless path —
and the teamless path is exactly the case that must not pair. Two values that both
mean "is pairing on", where one silently governs and the other silently does not.

**A third copy sits on the team definition.** `pairProgramming: 'off' | 'on' |
'aggressive'` conflates two unrelated things: whether to pair (now derived) and how
aggressively to band (a planner setting). `coding-team` already has to special-case
`'off'` out of its own editor, which is the tell — a team that does not pair is a
team pretending to be a group.

**It already caused shipped defects.** The enum also selects the *host* for the
routine half: `cli-ide` / `ide-ide` route the Band A prompt to the IDE clipboard
rather than a terminal (`coderUsesIde`), which on a team is simply wrong — a team's
seat is a terminal — and needs a `!teamPP` guard to suppress. And
`_resolveAgentTerminalForPlan` dropped every intern from the dispatchable pool
whenever the enum was on (fixed 2026-09-19, `bfeb0b35`), silently starving the
Coding team, whose whole design is a coder head handing the routine half to an
intern. That fix removed a symptom; this plan removes the cause.

### Why a group is the opt-out

Operator decision, 2026-09-19: **teams pair, unassigned does not.**

This is not a new concept to build — it is the distinction that already exists
(`groups-are-ephemeral-teams-are-durable`): a team is a head plus seats, durable,
with a roster; a group is a hand-made arrangement of live terminals with no head and
no definition. A group has nothing to split work *between*, so "a group does not
pair" needs no field and no enforcement. It falls out of what a group is.

That is the point of deleting the value rather than defaulting it: the answer stops
being a preference anyone can contradict and becomes a property of the arrangement.

## Metadata

**Complexity:** 5
**Tags:** teams, pair-programming, dispatch, clean-break, standalone
**Scope:** shared services (`KanbanProvider.ts`, `TaskViewerProvider.ts`,
`agentPromptBuilder.ts`, `agentConfig.ts`, `teamWiring.ts`) + the standalone host and
its webviews. The extension host is out of scope — it is being removed.

## Dependencies

**Builds on the band-by-position work already landed**
(`teams-are-four-defaults-and-you-can-switch-them-off`, Change 6). `pairBand` /
`pairBandSource` / `pairCounterpartRole` are already dispatch inputs resolved from
the team definition, and `resolveTeamPairBandForTerminal` already answers head→B /
seat→A. This plan does not re-derive any of that.

**Sequence after** the Band A delivery fix (`b9e39c30`), which routes the routine
half through `triggerBatchAgentFromKanban` to the team's own seat. Before it the
teamless path was the only one that worked, which would make this removal read as a
regression.

## Proposed changes

### 1. `pairProgrammingMode` is deleted

Remove the enum from `_autobanState`, its persistence, its verb arms and its webview
control.

### 2. `pairProgramming` is deleted from the team definition

The field, `readTeamPairProgramming`, `resolveTeamPairProgrammingForTerminal`'s
intensity arm, the Teams-tab select, and `coding-team`'s special-case that hides
`'off'` and coerces it back on save. None of it has anything left to express.

The five shipped defaults drop the field. No migration: teams are unreleased dev
work and take a clean break.

### 3. Pairing becomes a derivation, in one function

```ts
teamPairs(def): { value: boolean; source: 'team-roster' | 'no-team' }
```

True when the arrangement is a **team** (it has a head) **and** its roster carries at
least one seat that can take the routine half. That second clause is not new — it is
`resolveTeamPairProgrammingForTerminal`'s existing `hasCheaperSeat` guard, which
already forces `'off'` on a head-only team and on the planner- and reviewer-headed
teams, whose seats do not take an implementation band. Keep it as **the** derivation
and delete the stored value it used to override.

Tagged, because this is a dispatch read: every pair dispatch can answer "was this a
team, and which seat took the other half?"

### 4. The IDE host arms go

`coderUsesIde`, the `cli-ide` / `ide-ide` clipboard branch and the "Copy Coder
Prompt" flow are deleted. A team's routine half goes to that team's seat terminal;
there is no other destination once the teamless path cannot pair.

### 5. `aggressivePairProgramming` STAYS — verify it, do not move it

It remains a planner setting in the prompts config, reaching the planner prompt
exactly as it does today. The only work here is an audit:

- it must not be read as a proxy for "is pairing on" anywhere;
- the lead's "routine scope has been expanded" copy still fires on the same value;
- `pairProgrammingEnabledByRole` in the prompts config is examined against the same
  rule as everything else — a per-role toggle for whether a *role* pairs is the
  pre-teams shape, and the band is decided by position now. Delete it, or
  demonstrate in verification that it answers a question the derivation does not.

### 6. Delete the dead `dispatchToCoderTerminal` route

Registered only in `extension.ts`, never in the standalone command registry, so the
leg using it was a warn-once dead end on the shipping host. Its last caller is the
teamless branch this plan deletes. Remove the command, its registration and
`TaskViewerProvider.dispatchToCoderTerminal`.

## Verification plan

### Automated

- **A team pairs with nothing stored.** A team definition carrying no pairing field
  produces a Band B head dispatch and a Band A seat dispatch. Asserted on the
  Feature team (`lead` head, `coder` seat) and the Coding team (`coder` head,
  `intern` seat), so the same role string takes different bands.
- **Unassigned does not pair.** A dispatch with no team produces no Band A prompt
  and no second dispatch, and nothing reaches a clipboard.
- **A group does not pair**, and no code asserts it — the group simply resolves no
  head, so the derivation returns `{ value: false, source: 'no-team' }`.
- A head-only team, and the planner- and reviewer-headed teams, do not pair —
  the roster clause, not a stored `'off'`.
- `pairProgrammingMode`, the team `pairProgramming` field, `readTeamPairProgramming`,
  `coderUsesIde` and `dispatchToCoderTerminal` appear nowhere in `src/` outside
  `extension.ts`.
- No webview renders a pairing on/off control, on the board or on a team card.
- **`aggressivePairProgramming` still reaches the planner prompt** and still expands
  routine scope — asserted against `AGGRESSIVE_PAIR_PROGRAMMING_DIRECTIVE`, so this
  plan cannot quietly take the planner setting with it.
- An intern seat is dispatchable in every configuration; the regression the enum
  caused cannot return, because there is no enum to gate on.

### Goal invariants

- Pairing is a property of the arrangement, never a stored preference. Nothing can
  turn it on for an arrangement with no seats, or off for a team that has them.
- There is one place that says whether a dispatch pairs.
- Aggressive is a planner setting and stays one. It changes where the band line
  falls, never whether a pair exists.
- Every pair dispatch can answer "which team, and which seat took which half?"

### Manual

Start the Coding team, send it a plan: the coder receives Complex (Band B), the
intern receives Routine (Band A), neither hand-written by the head, with nothing
configured. Make a group of two coder terminals, send it work: nothing pairs, nothing
splits. Turn aggressive on and re-plan: more of the same work comes back classified
Routine, and pairing behaviour is otherwise unchanged.

## Outstanding questions

- **[ANSWERED 2026-09-19 — TEAMS PAIR, UNASSIGNED DOES NOT]** There is no on/off
  anywhere. A team pairs; a group or a lone seat does not. The group is the opt-out.
  Operator decision.

- **[ANSWERED 2026-09-19 — AGGRESSIVE IS A PLANNER SETTING AND STAYS]** It governs
  where the planner draws the Complex / Routine line, not whether a pair exists. It
  keeps its current home and is not folded into a team definition. Operator decision.
