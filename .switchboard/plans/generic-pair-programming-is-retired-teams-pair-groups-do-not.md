# Generic Pair Programming Is Retired — a Team Pairs, a Group Does Not

## Goal

Delete board-level pair programming. A **team** pairs automatically because that is
what a team is: a head takes the Complex / Risky half and its seats take the
Routine half. An operator who does not want pairing uses a **group**, which has no
head, no seats and no split.

One rule, derivable from what the arrangement *is*, replacing a board-wide enum
that predates teams and never had a home.

## Problem analysis

**Board pair programming was designed before teams existed.** `pairProgrammingMode`
lives on `_autobanState` (`'off' | 'cli-cli' | 'cli-ide' | 'ide-ide'`), a board-wide
enum from the VS Code product, when "pairing" meant one lead terminal and one coder
terminal and there was no roster to read. It answers a question teams now answer
better, and it answers it for the whole board at once.

**It is a second source of truth for a decision the team already owns.**
`resolveTeamPairProgrammingForTerminal` (`KanbanProvider.ts:6906`) reads the team's
own `pairProgramming` field; `_dispatchWithPairProgrammingIfNeeded` then does:

```ts
const mode = this._autobanState?.pairProgrammingMode ?? 'off';
const pairActive = teamPP ? teamPP.intensity !== 'off' : mode !== 'off';
```

The team wins *when a team answers*. So the enum governs only the teamless path —
and the teamless path is exactly the case that should not pair at all. Two values
that both mean "is pairing on", where one silently governs and the other silently
does not, is the two-copies-disagreeing trap this repo keeps paying for.

**It already caused a shipped defect.** The board enum also selects the *host* for
the routine half: `cli-ide` and `ide-ide` route the Band A prompt to the IDE
clipboard rather than a terminal (`coderUsesIde`). On a team that is simply wrong —
a team's seat is a terminal — and the code has to special-case it
(`const coderUsesIde = !teamPP && ...`). Every such guard is a place the two models
can drift.

**`aggressivePairProgramming` is a third value in the same space.** A board-level
boolean, plus the team's own `'aggressive'` intensity. Same question, same trap.

**The intern exclusion was its worst symptom.** `_resolveAgentTerminalForPlan`
dropped every intern from the dispatchable pool whenever the board enum was on
(fixed 2026-09-19, commit `bfeb0b35`) — a rule that made sense when pairing meant
lead+coder and an intern was a third wheel, and which silently starved the Coding
team, whose entire design is a coder head handing the routine half to an intern.
That fix removed the symptom. This plan removes the cause.

### Why a group is the opt-out

Operator decision, 2026-09-19: **pair programming is automatic for teams; if you do
not want it, use a group.**

This is not a new concept to build — it is the distinction that already exists.
`groups-are-ephemeral-teams-are-durable`: a team is a head plus seats, durable,
startable, with a roster; a group is a hand-made arrangement of live terminals with
no head and no definition. A group has nothing to split work *between* in the
head/seat sense, so "a group does not pair" needs no field, no toggle and no
enforcement — it falls out of what a group is.

That is the whole point of removing the enum rather than defaulting it on: the
answer stops being a stored preference anyone can contradict and becomes a property
of the arrangement.

## Metadata

**Complexity:** 5
**Tags:** teams, pair-programming, dispatch, clean-break, standalone
**Scope:** shared services (`KanbanProvider.ts`, `TaskViewerProvider.ts`,
`agentPromptBuilder.ts`, `agentConfig.ts`) + the standalone host and its webviews.
The extension host is out of scope — it is being removed, and a second
implementation there is throwaway work.

## Dependencies

**Builds on the band-by-position work already landed** (`teams-are-four-defaults-and-you-can-switch-them-off`,
Change 6). `pairBand` / `pairBandSource` / `pairCounterpartRole` are already dispatch
inputs resolved from the team definition, and `resolveTeamPairBandForTerminal`
already answers head→B / seat→A. This plan does not re-derive any of that; it
removes the board-level enum that sits beside it.

**Sequence after** the Band A delivery fix (commit on `main`, 2026-09-19) that routes
the routine half through `triggerBatchAgentFromKanban` to the team's own seat.
Before it, the teamless path was the only one that worked, which would make this
removal look like a regression.

## Proposed changes

### 1. `pairProgrammingMode` is deleted

Remove the enum from `_autobanState`, its persistence, its verb arms and its
webview control. Every read collapses:

```ts
const pairActive = teamPP ? teamPP.intensity !== 'off' : false;
```

which is to say: **a dispatch pairs if and only if a team answered.** State it that
way in code rather than keeping a variable that is always `false`.

`aggressivePairProgramming` (board-level) goes with it. The team's `'aggressive'`
intensity survives and is the only way to ask for it.

### 2. The IDE host arms go

`coderUsesIde`, the `cli-ide` / `ide-ide` clipboard branch and the
`showInformationMessage` "Copy Coder Prompt" flow are deleted. A team's routine half
goes to that team's seat terminal — there is no other destination once the teamless
path is gone.

### 3. `pairProgrammingEnabledByRole` in the prompts config

Audit it against the same rule. A per-role toggle for whether a *role* pairs is the
same pre-teams shape; the band is decided by position now. Either it is deleted or
it is demonstrated to answer a question the team definition does not — and the
demonstration goes in the plan's verification, not in a comment.

### 4. The Teams tab keeps the intensity control, and only it

`off | on | aggressive` on the team definition stays — that is the team saying how
hard it pairs, and `coding-team` already refuses `off`. Nothing board-level replaces
it.

**Check whether `off` should survive at all.** If pairing is what a team *is*, a team
with `pairProgramming: 'off'` is a team pretending to be a group. Either remove the
option (and migrate any stored `'off'` to a group, or to `'on'`) or write down why a
non-pairing team is a coherent thing. Do not leave it undecided.

### 5. `readTeamPairProgramming`'s absent-reads-as-`'on'` stops being a fallback

With the board enum gone, absence is the only remaining ambiguity. Every shipped
default already writes the field explicitly. Make it `{ value, source }` like the
other team reads, so "on because it ships on" and "on because nobody set it" are
distinguishable on a dispatch read.

### 6. Delete the dead `dispatchToCoderTerminal` route

`switchboard.dispatchToCoderTerminal` is registered only in `extension.ts` and was
never registered in the standalone command registry, so the leg that used it was a
warn-once dead end on the shipping host. Its last caller is the teamless branch this
plan deletes. Remove the command, its registration and
`TaskViewerProvider.dispatchToCoderTerminal`.

## Verification plan

### Automated

- With no team live, a dispatch produces **no** Band A prompt and no second
  dispatch — the teamless path does not pair, and nothing is copied to a clipboard.
- With a team live, the head receives Band B and the team's own routine seat
  receives Band A, with `pairBandSource: 'team-head'` / `'team-seat'` — asserted on
  both the Feature team (`lead` head, `coder` seat) and the Coding team (`coder`
  head, `intern` seat), so the same role string yields different bands.
- `pairProgrammingMode`, `aggressivePairProgramming` (board-level), `coderUsesIde`
  and `dispatchToCoderTerminal` appear nowhere in `src/` outside `extension.ts`.
- No webview renders a board-level pair-programming control.
- An intern seat is dispatchable in every configuration — the regression the enum
  caused cannot return, because there is no enum to gate on.
- `readTeamPairProgramming` returns a source, and a team with the field absent is
  tagged `'unknown'`, never `'default'`.

### Goal invariants

- Pairing is a property of the arrangement, not a stored preference. Nothing
  board-wide can turn it on for a team that has no seats, or off for a team that
  has them.
- A group never pairs, and no code asserts this — it follows from a group having no
  head and no seats.
- Every pair dispatch can answer "which team decided this, and which seat took
  which half?"
- There is one place that says whether a dispatch pairs.

### Manual

Start the Coding team, send it a plan: the coder receives Complex (Band B), the
intern receives Routine (Band A), and neither was hand-written by the head. Make a
group of two coder terminals, send it work: nothing pairs, nothing splits, no Band A
prompt is generated.

## Outstanding questions

- **[ANSWERED 2026-09-19 — A GROUP IS THE OPT-OUT]** Pair programming is automatic
  for teams. An operator who does not want it uses a group. No board-level control
  replaces the deleted enum. Operator decision.

- **Does `pairProgramming: 'off'` survive on a team definition?** Change 4 must
  decide rather than defer. It is the same question as the enum, one level down.
