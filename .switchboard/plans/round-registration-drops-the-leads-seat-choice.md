# Round Registration Drops the Lead's Seat Choice, So Dispatch Guesses by Position

## Goal

Give the lead back what the rounds design always assumed it had: the choice of **which seat works
which subtask**, expressed once at registration, honoured by the system when it auto-dispatches each
round. The lead reads the feature, compares its subtasks' complexity against the seats it actually
has, and assigns accordingly — low-complexity work to an intern, the hard seams to a coder. The
system then advances the rounds on its own, exactly as it does today. The lead never hand-dispatches.

Today the lead can express only *grouping* — which subtasks share a round. **Who** gets each one is
decided at dispatch time by array position, which is why a three-seat team can run a whole feature
without the third seat ever receiving work.

### Problem Analysis

**Observed 2026-09-18**, feature *Seats and the CLI Reach the Board Over the Tailnet, Not a Tunnel*
(`30f625e0`), team `Coding` with roster `[Coding-coder-1, Coding-coder-2, Coding-intern]`. Rounds
were registered 1/2/2/1. `Coding-intern` received nothing at all, across the entire feature, and no
regrouping by the lead could change that.

#### The assignment is positional, and the cursor resets every round

`LocalApiServer._dispatchRoundCore` (`src/services/LocalApiServer.ts:5885`) is the whole of it:

```ts
// The lead is never a dispatched seat. Exclude the lead from the pool.
const seats = roster.filter(s => s !== from);
...
let seatCursor = 0;                       // declared INSIDE the method — per call
for (const planId of subtaskPlanIds) {
    const seat = seats[seatCursor % seats.length];
    seatCursor++;
    await this.performKanbanDispatch(workspaceRoot, planId, undefined, {
        targetTerminalOverride: seat, originTerminal: from, skipClear: true,
    });
}
```

Four properties follow, and three of them are not what "round-robin" suggests:

1. **The cursor is per-call.** `_dispatchRoundCore` runs once per round dispatch, so every round
   restarts at `seats[0]`. Nothing rotates across a feature. It is positional assignment *within* a
   round wearing round-robin's name.
2. **No liveness or busy check.** The pool is never filtered by whether a seat is free.
3. **No role or complexity awareness.** See below — it is not merely unimplemented, it is
   unrepresentable at this layer.
4. **Modulo only wraps upward.** With three seats, a two-subtask round evaluates indices 0 and 1 and
   stops.

The resulting seat coverage is a pure function of round size:

| Round size | Seats that can receive work |
|---|---|
| 1 subtask | `seats[0]` only |
| 2 subtasks | `seats[0]`, `seats[1]` |
| 3 subtasks | all three |

A feature built from 1- and 2-subtask rounds — the normal shape when a contended file forces
serialization — **cannot** reach the third seat. In the observed run the feature file explicitly
serialized three subtasks on `src/standalone/cli.ts` ("No two of them run in the same round"), so
every arrangement that would have reached the intern was forbidden by the plan the lead was
executing. The lead was left with a choice between honouring the plan and using its team.

#### Role never reaches the dispatcher

`resolveTeamMembersForHead` (`src/services/teamWiring.ts:2444`) returns `Promise<string[] | null>`,
and `rosterOfGroup` (`:2516`) flattens each member to a name:

```ts
const resolved = typeof n.friendlyName === 'string' ? n.friendlyName
    : (typeof n.name === 'string' ? n.name : '');
```

Role is dropped. By the time `_dispatchRoundCore` holds the roster, "coder" and "intern" do not exist
in the data, and `seats[0]` is whatever the group's `order` array happens to list first. The system
therefore *cannot* match complexity to seat on its own. The lead can — it is given the roster with
roles in its dispatch prompt, and every subtask carries a `complexity` rating on its card. The
decision belongs where the information already is.

### Root Cause

**V81 removed the field that carried the lead's choice, while intending only to install
auto-advance.**

`coding_rounds.subtask_seats` (`KanbanDatabase.ts:695`) once held a per-subtask object
`{ seat, delivered, delivered_at }`. V81 collapsed it to a bare plan-id list. The schema comment
records the reasoning:

> V81 reduced `subtask_seats` from a per-subtask `{ seat, delivered, delivered_at }` object to a bare
> plan-id list: seat assignment is advisory and read off the cards' `owner_seat`, and delivery
> history lives in `plan_events` — a stored copy is a second record of the same fact that can
> disagree with the card.

That reasoning is **correct about two of the three fields and wrong about the first.** `delivered`
and `delivered_at` are outcomes — a second copy of something `plan_events` and the card already
record, free to drift. Removing them was right and this plan does not reinstate them.

`seat` is not an outcome. It is an **input**: a decision the lead made *before* dispatch, which
nothing else records, and which cannot disagree with the card because the card does not yet exist as
dispatched work. Deleting it did not de-duplicate a record — it deleted the only place the lead's
intent could live. V81's actual objective was the "lead posts completion, system fires the next
round" advance logic, which is orthogonal and stays exactly as it is.

With the field gone, `_dispatchRoundCore` had to get a seat from somewhere, and positional
round-robin filled the vacuum. The bug is the vacuum, not the loop.

## Metadata

- **Complexity:** 3
- **Project:** Orchestration
- **Touches:** `src/services/LocalApiServer.ts`, `src/services/KanbanDatabase.ts`
- **Related:** the rounds feature (`coding_rounds`, V73), V81 auto-advance

## Host Scope

**Standalone only.** `LocalApiServer` is the single owner of `/kanban/round/register` and
`_dispatchRoundCore`; the standalone host serves it and no new composition-root seam is introduced in
either root. Nothing is wired into `src/extension.ts` — per the cutover, the legacy host is out of
scope and its absence here is intended state, not divergence. No `engine.setX(...)` seam, no options
object, no `Promise<void>` callback is added, so the divergence trap this repo tracks does not apply.

## Settled Design

**The lead's seat choice is an input, recorded at registration; the delivery outcome stays where it
already lives.**

1. **`rounds` entries accept a seat.** A round entry may be a bare `planId` string (today's shape,
   unchanged) **or** an object `{ planId, seat }`. Mixed entries within a round are allowed — the
   lead may pin some subtasks and leave others.
2. **`subtask_seats` carries the intent.** Stored as `[{ planId, seat }]`, seat nullable. It records
   what the lead *chose*, never what was *delivered*. `delivered` / `delivered_at` are not
   reinstated.
3. **Validation is identity-only, never judgment** — matching the route's existing contract
   (`LocalApiServer.ts:5466`). A named seat must be on the poster's roster and must not be the lead.
   The system never second-guesses whether an intern *should* have a complexity-5 task; that is the
   lead's call, and a bad call is a review problem, not a 400.
4. **An unknown seat is a 400 naming it.** It is never silently swapped for a positional pick.
5. **The dispatcher honours the intent, and tags what it resolved.**

### The resolved seat is a tagged read

Seat selection is a **routing** read, so `CLAUDE.md`'s rule applies directly: *a fallback must never
be indistinguishable from a real value.* A positionally-guessed seat that looks identical to a
lead-chosen one is exactly the quiet-wrong-answer shape that rule exists to stop — and is how this
bug survived unnoticed.

`_dispatchRoundCore` resolves each subtask to `{ value, source }`:

- `source: 'lead-registered'` — the lead named this seat at registration.
- `source: 'positional-fallback'` — no seat was registered for this subtask; the legacy positional
  pick was used.

The source is logged per subtask at dispatch and returned in the route's per-subtask result, so
"which seat got this, and who decided?" is answerable after the fact. A round dispatched entirely on
`positional-fallback` logs one warning naming the feature and round ordinal — that is the signature
of a lead that registered without seats, and it should be visible rather than silent.

### Backward compatibility

`coding_rounds` shipped in V73 and V81, so the migration rules apply: rows and callers that predate
this change must keep working.

- **Bare-string round entries keep working**, resolving `positional-fallback`. No lead is broken by
  this change and no re-registration is forced.
- **`_parseSubtaskPlanIds` (`KanbanDatabase.ts:8426`) already tolerates two shapes** — an array of
  ids, and the pre-V81 object whose keys are the ids. It gains a third: an array of
  `{ planId, seat }`. Corrupt JSON continues to yield an empty list.
- **No destructive rewrite.** Existing rows are read under tolerance, not migrated in place.

## Proposed Changes

### Change A — accept a seat in the registered round entry

`src/services/LocalApiServer.ts`, the round-entry validation loop (`:5578-5606`).

Each entry normalises to `{ planId, seat: string | null }` before the existing duplicate and
membership checks run, so those checks are unchanged and keep operating on `planId`. Add, after the
`validSubtaskIds` check:

- seat present and not on `roster` → 400, `Seat '<seat>' is not on team '<teamId>'s roster`
- seat equals `from` → 400, `The lead '<from>' cannot be assigned its own subtask`

Roster is already resolved in this handler for the membership gate (`:5547`), so no new lookup.

### Change B — persist the intent

`src/services/KanbanDatabase.ts`, `insertCodingRound` (`:8377`) and `_parseSubtaskPlanIds` (`:8426`).

Write `subtask_seats` as `[{ planId, seat }]`. Extend the parser to return
`Array<{ planId: string; seat: string | null }>` across all three tolerated shapes, and keep a
plan-ids-only accessor for the existing call sites so the ordering contract they rely on does not
change. The schema comment is updated to record the intent/outcome split rather than the current
blanket "RECORD-KEEPING state only", which is what licensed the original over-removal.

### Change C — honour the intent at dispatch, and tag the source

`src/services/LocalApiServer.ts`, `_dispatchRoundCore` (`:5885`).

```ts
const registered = round.subtaskSeats ?? [];
let seatCursor = 0;
for (const entry of registered) {
    const chosen = entry.seat && seats.includes(entry.seat)
        ? { value: entry.seat, source: 'lead-registered' as const }
        : { value: seats[seatCursor++ % seats.length], source: 'positional-fallback' as const };
    ...
}
```

The cursor advances **only** on the fallback path, so a partially-pinned round does not shift the
unpinned ones by the number of pinned ones ahead of them.

The empty-pool guard (`:5909`) is untouched: a roster that is the lead alone still reports every
subtask `seat: null, delivered: false` rather than dispatching to an undefined seat.

**Auto-advance is not touched.** `round/complete`, the closure logic, and the "lead posts completion,
system fires the next round" path are out of scope — that is V81's actual contribution and it works.

## Edge Cases

- **A pinned seat that has left the roster between registration and dispatch** — the `seats.includes`
  guard demotes it to `positional-fallback` and logs the demotion with both names. It does not throw:
  a round mid-feature must still dispatch. This is the one place a tagged fallback is load-bearing.
- **Two subtasks in one round pinned to the same seat** — allowed, and deliberately so. The system
  enforces one subtask per seat at a time when it dispatches; a lead that double-pins gets the
  existing behaviour, not a new refusal. Flagged in the route result so it is visible.
- **A re-registration that changes seats** — pending rounds are replaced wholesale today
  (`:5614-5620`); seats ride along with that and need no special handling. Dispatched rounds are
  untouched, so an in-flight seat is never reassigned underneath a working coder.
- **A seat named for a subtask in a round that never dispatches** — inert. The row is deleted with
  the round on re-registration.

## Verification Plan

### Goal invariants

1. A lead that pins every subtask gets exactly those seats, in every round, regardless of round size.
2. A three-seat team can give its third seat work in a **one-subtask round** — the case that is
   impossible today.
3. A lead that pins nothing gets byte-identical behaviour to today.
4. Every dispatched subtask's result carries a `source`, and no caller can confuse a pinned seat with
   a guessed one.

### Automated tests

- `round/register` accepts `{ planId, seat }`, bare strings, and a mix of both in one round.
- An off-roster seat 400s and names the seat; the lead's own name 400s.
- A 1-subtask round pinned to `seats[2]` dispatches to `seats[2]` — the regression test for this bug.
- A partially-pinned round: pinned entries land on their seats, unpinned ones consume the cursor in
  order and do not inherit the pinned ones' offsets.
- Pre-V81 object rows, bare-id rows, and `{planId, seat}` rows all parse; corrupt JSON yields `[]`.
- A pinned seat absent from the roster at dispatch demotes to `positional-fallback` and logs both
  names.

### Manual verification

Register a 4-round feature on a 3-seat team with every round holding one subtask, pinned
`intern, coder-1, coder-2, intern`. Confirm each round dispatches to the pinned seat and that the
dispatch log names `source: lead-registered` for each.

## Outstanding Questions

1. Should a round that registers **no** seats anywhere eventually become a warning to the lead rather
   than a silent positional dispatch? This plan logs it; making it louder is a judgement call about
   how much the system should push leads toward explicit assignment.
2. Should `rosterOfGroup` preserve role so the *route* can report "you gave a complexity-5 subtask to
   an intern" as advisory metadata? Out of scope here — the lead already has roles in its prompt, and
   adding role plumbing widens the change well past the bug. Worth its own card if the reporting is
   wanted.

## Recommendation

Land it. The change is small and almost entirely additive: one new optional field on an existing
route, one richer JSON shape behind a parser that already tolerates two, and a six-line change at the
dispatch site. It restores a capability the rounds design assumed, without disturbing the
auto-advance logic V81 was actually written to deliver.
