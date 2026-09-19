# The Owner Stamp Answers Two Questions, and Routing Gets the Wrong One

## Goal

`owner_seat` answers exactly one question — **who was this card last handed to** —
and every reader that needs a different question gets a different field. Team-scoped
routing stops inferring a card's team from a stamp that outlives the work.

## Problem analysis

Two fields with deliberately different lifetimes:

- **`owner_since`** — "out for work right now". Nulled on **every** column move by
  `_columnMoveDispatchClearSql` (`KanbanDatabase.ts:5780`).
- **`owner_seat`** — the docblock is explicit: *"stays — it records the last seat the
  card was handed to."* It survives moves on purpose.

**The original consumer is hop pacing, and it is correct.** `HopReadiness.ts:108`
checks whether a card is held by a seat the scheduler is about to use, so two agents
do not end up in one worktree. It is advisory by design — *"never refuses a dispatch;
this just paces the hop scheduler"* — and it deliberately does **not** gate on
`owner_since`, because that is nulled on every move and a seat still mid-turn on a
just-advanced card would otherwise read as free. For this reader, sticky is the whole
point.

**A second consumer asks a different question of the same field.**
`_plausibleOriginTerminal(record)` reads `owner_seat` to decide the **origin terminal
for team-scoped routing** — which team should receive this dispatch. That needs *who
is working this now*; a sticky last-holder cannot say. The field is doing its job and
routing is asking it something it was never built to answer.

**Observed 2026-09-19.** A feature dispatched, failed, and was moved back to Planned.
Its `owner_seat` still read `Feature-coder-1` from the failed attempt. The next
dispatch resolved the origin to that stale seat and went looking for a lead on *that
seat's* team:

```
teamRouting: "team-scoped: no lead on Feature-coder-1's team — fell back to
              workspace-wide"
```

It recovered, because only one team was live and the workspace-wide fallback found
the same lead. **With two implementation teams live it would not**: the stamp would
name a team the card no longer belongs to, routing would resolve a real lead on the
wrong team, and nothing would report a mistake — the fallback line only prints when
team resolution MISSES, not when it succeeds against a stale premise.

This is the repo's fallback rule on a routing read: "last holder" and "current
holder" are the same value, so a wrong answer is indistinguishable from a right one.

## Metadata

**Complexity:** 4
**Tags:** dispatch, routing, teams, data-model, standalone
**Scope:** `KanbanDatabase` (the stamp and its clear), `LocalApiServer`
(`_plausibleOriginTerminal` and the team-scoped origin precedence), `HopReadiness`.
**Standalone only** — the VS Code extension is being reduced to a launcher sidebar
and is not a target.

## Constraints

**No sessionId.** Deprecated months ago; nothing introduced here keys on it.

**Hop pacing must not regress.** Its reader is correct and its non-gating on
`owner_since` is a deliberate fix, not an oversight. Whatever this plan changes, the
pacing predicate keeps seeing a card held by a seat that is still mid-turn on it.

## Proposed changes

### 1. Name the question in the field, not in the reader

Two readers want two things, so say which is which at the read:

```ts
readCardHolder(card): { seat: string; state: 'working' | 'last-handed-to' | 'none' }
```

`'working'` when the stamp is live by the pacing predicate's own rule (a seat named,
no completion). `'last-handed-to'` when the stamp survives but the card is not out for
work. `'none'` when unstamped. Both consumers call it; neither re-derives it.

### 2. Team-scoped routing accepts only `'working'`

`_plausibleOriginTerminal` stops treating a last-handed-to stamp as an origin. Origin
precedence becomes: explicit `from` → a **working** holder → `dispatched_agent` →
none. A stale stamp yields no origin, which is the honest answer and already has a
handled path (workspace-wide, reported in `teamRouting`).

### 3. Report a team-scoped origin that WAS used, not only one that missed

`teamRouting` currently speaks up when team resolution fails. It must also record the
origin it used and why, so a dispatch that resolved against a stale premise is visible
rather than silent. "Which store answered?" applied to routing.

### 4. Hop pacing keeps its reader, unchanged in behaviour

It moves to `readCardHolder` and accepts both `'working'` and `'last-handed-to'` —
which is exactly today's predicate — so the concurrent-write protection is preserved
verbatim. The point of the split is that the two readers now *say* they want
different things.

### 5. Decide whether a column move should clear `owner_seat` too

Deliberately left as a decision rather than assumed. Clearing it on a **backward**
move (the failure case that produced this bug) is defensible: a card sent back to
Planned is not "handed to" anyone. Clearing it on every move is not — hop pacing needs
it to survive a forward advance. Pick one, write down why, and gate it.

## Verification plan

### Automated

- A card moved BACKWARD after a failed dispatch yields no team-scoped origin from its
  stale `owner_seat`; routing reports workspace-wide with the reason.
- **Two implementation teams live, card stamped with a seat from the wrong team:** the
  dispatch does not resolve to that team. This is the case that silently misroutes
  today and the reason the plan exists.
- A card genuinely out for work still yields its holder as the origin — the good path
  is unchanged.
- **Hop pacing is byte-identical in behaviour:** a seat mid-turn on a just-advanced
  card (so `owner_since` is NULL but no completion) still reads as busy and still
  paces the scheduler away. Asserted directly, because that non-gating is a fix
  someone already made and this plan must not undo it.
- `teamRouting` names the origin it used on a SUCCESSFUL team-scoped resolution, not
  only on a miss.
- No reader outside `readCardHolder` touches `owner_seat` / `ownerSeat` directly.

### Goal invariants

- One field, one question. "Last handed to" and "currently working" are never the
  same read.
- A routing decision can answer which origin it used and how that origin was known.
- A stale stamp produces no origin, never a confidently wrong one.
- Hop pacing's concurrent-write protection is unchanged.

### Manual

Dispatch a feature, let it fail, move the card back to Planned, start a second
implementation team, dispatch again. It must reach the right team — and `teamRouting`
must say which origin it used.

## Outstanding questions

- **Should a backward move clear `owner_seat`?** See Change 5. Answer it in the plan
  before coding; leaving it to fall out of the implementation is how the field ended
  up serving two masters in the first place.
