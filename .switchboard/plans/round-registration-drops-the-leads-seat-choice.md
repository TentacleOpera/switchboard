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

`LocalApiServer._dispatchRoundCore` (`src/services/LocalApiServer.ts:5951`) is the whole of it:

```ts
// The lead is never a dispatched seat. Exclude the lead from the pool.
const seats = roster.filter(s => s !== from);
...
let seatCursor = 0;                       // declared INSIDE the method — per call
for (const planId of subtaskPlanIds) {
    const seat = seats[seatCursor % seats.length];
    seatCursor++;
    await this.performKanbanDispatch(workspaceRoot, planId, keepColumn, {
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

`resolveTeamMembersForHead` (`src/services/teamWiring.ts:3050`) returns `Promise<string[] | null>`,
and `rosterOfGroup` (`:3122`) flattens each member to a name:

```ts
const resolved = typeof n.friendlyName === 'string' ? n.friendlyName
    : (typeof n.name === 'string' ? n.name : '');
```

Role is dropped. By the time `_dispatchRoundCore` holds the roster, "coder" and "intern" do not exist
in the data, and `seats[0]` is whatever the group's `order` array happens to list first. The system
therefore *cannot* match complexity to seat on its own. The lead can — it is given the roster with
roles in its dispatch prompt (`KanbanProvider._resolveRosterAndPort` renders `- name (role) — active`
per member), and every subtask carries a `complexity` rating on its card. The decision belongs where
the information already is.

#### The lead is never told it may choose

`subtask_seats` carrying a seat is only half the capability. The lead learns the register contract
from three prompt surfaces, and all three still teach the old one:

- `KanbanProvider._buildDrivePrefix` (`:6727`) — the feature-dispatch prompt — shows
  `"rounds":[["<subtask planId>","<subtask planId>"],["<subtask planId>"]]`: bare strings only.
- `HEAD_COMPLETION_FRAGMENT_BODY` (`standingOrderFragments.ts:150`) — same bare-array payload shape.
- `CODING_HEAD_WORK_WITH_ROUNDS` (`standingOrderFragments.ts:201`) — says outright "you do not
  choose which seat gets which subtask", and claims "the system rotates one subtask per cleared
  seat before reuse" — a rotation that has never existed, which is the bug this plan fixes.

A mechanism the lead cannot discover is not a mechanism: every dispatch in the verification suite
could honour a registered seat while no feature ever registers one. Telling the lead it may pin —
and un-forbidding the choice — is part of this fix, not a follow-up.

### Root Cause

**V81 removed the field that carried the lead's choice, while intending only to install
auto-advance.**

`coding_rounds.subtask_seats` (`KanbanDatabase.ts:703`, schema comment `:686-694`) once held a
per-subtask object `{ seat, delivered, delivered_at }`. V81 collapsed it to a bare plan-id list.
The schema comment records the reasoning:

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

- **Tags:** backend, api, bugfix
- **Complexity:** 4
- **Project:** Orchestration
- **Touches:** `src/services/LocalApiServer.ts`, `src/services/KanbanDatabase.ts`,
  `src/services/standingOrderFragments.ts`, `src/services/KanbanProvider.ts`
- **Related:** the rounds feature (`coding_rounds`, V73), V81 auto-advance

> **Superseded:** Complexity 3.
> **Reason:** The original score predates the finding that the capability is unreachable without
> updating the three lead-facing prompt surfaces — a fourth file and a contract test join the diff.
> Still routine and additive, but no longer single-area.
> **Replaced with:** Complexity 4.

## User Review Required

- The new lead-facing prompt wording (Change D) is a product-surface change — the exact phrasing a
  lead reads is worth a human eyeball before it ships, though the mechanics it describes are settled.

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
   (`LocalApiServer.ts:5532`). A named seat must be on the poster's roster and must not be the lead.
   The system never second-guesses whether an intern *should* have a complexity-5 task; that is the
   lead's call, and a bad call is a review problem, not a 400.
4. **An unknown seat is a 400 naming it.** It is never silently swapped for a positional pick.
5. **The dispatcher honours the intent, and tags what it resolved.**
6. **The lead is told it may choose.** The three prompt surfaces that teach the register contract
   name the `{ planId, seat }` entry shape; the standing-order text that forbids seat choice is
   corrected, along with its false rotation claim.

### The resolved seat is a tagged read

Seat selection is a **routing** read, so `CLAUDE.md`'s rule applies directly: *a fallback must never
be indistinguishable from a real value.* A positionally-guessed seat that looks identical to a
lead-chosen one is exactly the quiet-wrong-answer shape that rule exists to stop — and is how this
bug survived unnoticed.

`_dispatchRoundCore` resolves each subtask to `{ value, source }`:

- `source: 'lead-registered'` — the lead named this seat at registration.
- `source: 'positional-fallback'` — no seat was registered for this subtask (or the registered seat
  is no longer dispatchable); the legacy positional pick was used.

The source is logged per subtask at dispatch and returned in the route's per-subtask result, so
"which seat got this, and who decided?" is answerable after the fact. A round dispatched entirely on
`positional-fallback` logs one warning naming the feature and round ordinal — that is the signature
of a lead that registered without seats, and it should be visible rather than silent.

### Backward compatibility

`coding_rounds` shipped in V73 and V81, so the migration rules apply: rows and callers that predate
this change must keep working.

- **Bare-string round entries keep working**, resolving `positional-fallback`. No lead is broken by
  this change and no re-registration is forced.
- **`_parseSubtaskPlanIds` (`KanbanDatabase.ts:8485`) already tolerates two shapes** — an array of
  ids, and the pre-V81 object whose keys are the ids. It gains a third: an array of
  `{ planId, seat }`. For the legacy object-keyed shape it also salvages each value's `seat` when it
  is a non-empty string — that seat is genuine lead intent, preserved for free wherever a pre-V81
  row survives. Corrupt JSON continues to yield an empty list.
- **No destructive rewrite and no DDL.** `subtask_seats` stays a TEXT JSON column; the V81 migration
  (`:13051-13091`) already skips array-shaped rows (`if (Array.isArray(parsed)) continue`), so the
  new `[{planId, seat}]` arrays pass through untouched. Existing rows are read under tolerance, not
  migrated in place.

## Complexity Audit

### Routine

- One optional field on an existing route's payload; the parser it feeds already tolerates two
  JSON shapes and gains a third.
- Six-line dispatch change inside a loop whose structure is unchanged; the positional pick is
  preserved verbatim as the fallback arm.
- `CodingRoundRecord`/`CodingRoundRow` gain one field; `subtaskPlanIds` stays populated so every
  existing reader (accept-advance `includes(planId)`, re-registration diff, redeliver) is untouched.
- Prompt-text edits are string literals — no logic.

### Complex / Risky

- The capability is only real if the lead is told about it: three prompt surfaces must change in the
  same diff or the feature ships unreachable. Easy to miss precisely because every mechanism test
  passes without it.
- Records carrying only `subtaskPlanIds` (test fakes, hand-built rows) must degrade to today's
  behaviour — iterating `subtaskSeats ?? []` alone would dispatch zero subtasks on such records.

## Edge-Case & Dependency Audit

### Race Conditions

- **A pinned seat that has left the roster between registration and dispatch** — the `seats.includes`
  guard demotes it to `positional-fallback` and logs the demotion with both names. It does not throw:
  a round mid-feature must still dispatch. This is the one place a tagged fallback is load-bearing.
- **A pinned seat that has become the lead** — `seats` already excludes `from`, so `seats.includes`
  fails and the entry demotes to `positional-fallback` with the same log. No special case needed.
- **A pinned seat still on the roster but dead/exited** — NOT demoted. The pin is honoured, the
  dispatch attempt reports `delivered: false` with the error, and the round goes `partial` — a loud
  failure on an explicit choice, which is the correct direction under the fallback rule.
- **Concurrent last-subtask accepts racing to close a round** — `closeCodingRoundIfOpen`'s
  compare-and-swap is unchanged; only the winner dispatches the next round.
- **A re-registration that changes seats** — pending rounds are replaced wholesale today
  (`:5684-5688`); seats ride along with that and need no special handling. Dispatched rounds are
  untouched, so an in-flight seat is never reassigned underneath a working coder.

### Security

- Validation stays identity-only: seat membership is checked against the poster's own resolved
  roster; error strings name only the caller's own team members. The route's `_checkAuth` and CSRF
  posture are untouched.

### Side Effects

- The dispatch result's `subtasks[]` entries gain a `source` field — additive, no existing consumer
  reads it.
- Two new log lines: per-subtask source, and the demotion warning; one warning per all-fallback
  round. No new state, no new timers, no new files.
- A round's `subtask_seats` JSON changes shape for newly-registered rows only; every reader parses
  under tolerance.

### Dependencies & Conflicts

- **All four `_dispatchRoundCore` call sites pass full records** — round/register (`:5784`),
  round/dispatch (`:5920`), round/complete (`:5493`), and the accept-advance path (`:5156`) — so the
  new `subtaskSeats` field flows to the dispatcher with no caller changes.
- `round/redeliver` reads the seat from the card's `owner_seat`, which dispatch itself wrote — a
  pinned seat lands on the card the same way a positional one does; redeliver needs no change.
- The accept-advance path's `subtaskPlanIds.includes(planId)` membership test (`:5049`) keeps working
  because `subtaskPlanIds` stays populated alongside `subtaskSeats`.
- `insertCodingRound` has exactly one caller (`:5701`) — the signature change is contained.
- Test fakes that build round records without `subtaskSeats` (e.g.
  `lead-accept-advances-contract.test.js`'s `round()`) keep passing: the dispatcher derives entries
  from `subtaskPlanIds` when `subtaskSeats` is absent or empty.
- `team-state-endpoint-access-contract.test.js` asserts the head text names
  `POST /kanban/round/register` — still true after the fragment edits.

## Dependencies

None — no `sess_` prerequisites; this is a self-contained change to shipped rounds machinery.

## Adversarial Synthesis

Key risks: the capability shipping undiscoverable because the prompt surfaces still teach bare-string
rounds (Change D updates all three); a record carrying only `subtaskPlanIds` dispatching nothing
because the dispatcher iterated an empty `subtaskSeats` (the entries-derivation fallback prevents
it); and a stale pin silently re-routing work (the tagged `source` plus the demotion log keep it
visible). No surviving concern threatens the approach itself.

## Proposed Changes

### Change A — accept a seat in the registered round entry

`src/services/LocalApiServer.ts`, `_handleKanbanRoundRegister` (`:5548`).

The shape-validation loop (`:5582-5596`) currently 400s anything that is not a non-empty string —
`{planId, seat}` objects die here before any seat check can run. It learns two shapes:

- bare non-empty string → normalises to `{ planId, seat: null }`;
- object with non-empty string `planId` → normalises to `{ planId, seat }` where `seat` is `null`
  when absent or `null`, and a trimmed non-empty string otherwise. A `seat` present but not a
  non-empty string (number, object, `""`) → 400 naming the round index and the entry. Unknown extra
  keys are ignored (forward-compat).

The existing within-round / cross-round duplicate and `validSubtaskIds` membership checks
(`:5646-5672`) then run on `entry.planId`, unchanged. After the `validSubtaskIds` check, for each
entry with `seat !== null`:

- `!roster.includes(seat)` → 400, `Seat '<seat>' is not on team '<teamId>'s roster`
- `seat === from` → 400, `The lead '<from>' cannot be assigned its own subtask`

The roster is already resolved in this handler for the membership gate (`:5608-5620`), so no new
lookup. The `insertCodingRound` call (`:5701`) passes the normalised entries, and the response echoes
them — `insertedRounds`, `rounds`, and `diff.added` (`:5695-5749`) carry `{planId, seat}` per
subtask so the registration response confirms the recorded intent, not just the ids.

### Change B — persist the intent

`src/services/KanbanDatabase.ts`.

- `CodingRoundRecord` (`:361`) gains `subtaskSeats: Array<{ planId: string; seat: string | null }>`;
  `subtaskPlanIds` stays, derived as `subtaskSeats.map(e => e.planId)` so the two can never disagree.
  Its doc comment is rewritten: seat is a registered *input* (the lead's choice); delivery is the
  *outcome* and stays on the cards/`plan_events`.
- `insertCodingRound` (`:8444`): param `subtaskPlanIds: string[]` → `subtasks:
  Array<{ planId: string; seat: string | null }>`; stores `JSON.stringify(subtasks)`. Doc comment
  updated to record the intent/outcome split.
- `_parseSubtaskPlanIds` (`:8485`) becomes the entries parser (rename to
  `_parseSubtaskSeatEntries`, keep a `subtaskPlanIds`-only derivation at each call site): the new
  `[{planId, seat}]` array (non-string seats normalise to `null`), the legacy bare-string array
  (all `seat: null`), and the pre-V81 object keyed by planId (keys are the ids; `v.seat` salvaged
  when a non-empty string). Corrupt JSON still yields `[]`. All four readers
  (`getCodingRoundsByFeature`, `getCodingRound`, `getCodingRoundsByTeam`,
  `getCodingRoundsByWorkspace`) populate both fields.
- The schema comment (`:686-694`) is updated to record the intent/outcome split rather than the
  current blanket "RECORD-KEEPING state only", which is what licensed the original over-removal.

### Change C — honour the intent at dispatch, and tag the source

`src/services/LocalApiServer.ts`, `_dispatchRoundCore` (`:5951`), plus `CodingRoundRow` (`:1201`)
gaining `subtaskSeats` to stay in step.

```ts
// Records that carry only the plan-id list (test fakes, hand-built rows)
// degrade to today's positional behaviour — never to a zero-dispatch.
const entries: Array<{ planId: string; seat: string | null }> =
    (round.subtaskSeats && round.subtaskSeats.length)
        ? round.subtaskSeats
        : (round.subtaskPlanIds || []).map((planId: string) => ({ planId, seat: null }));

let seatCursor = 0;
let allPositional = true;
for (const entry of entries) {
    const chosen = entry.seat && seats.includes(entry.seat)
        ? { value: entry.seat, source: 'lead-registered' as const }
        : { value: seats[seatCursor++ % seats.length], source: 'positional-fallback' as const };
    if (entry.seat && chosen.source === 'positional-fallback') {
        console.warn(`[LocalApiServer] round ${roundId}: registered seat '${entry.seat}' for subtask '${entry.planId}' is off the roster — demoted to positional '${chosen.value}'`);
    }
    if (chosen.source === 'lead-registered') allPositional = false;
    // ... performKanbanDispatch with targetTerminalOverride: chosen.value,
    //     results.push({ ..., seat: chosen.value, source: chosen.source })
}
```

- The cursor advances **only** on the fallback path, so a partially-pinned round does not shift the
  unpinned subtasks by the number of pinned ones ahead of them.
- Each result entry gains `source`; after the loop, `allPositional` logs one warning naming
  `featureId` and `ordinal` — the signature of a lead that registered without seats.
- The empty-pool guard (`:5979`) is untouched: a roster that is the lead alone still reports every
  subtask `seat: null, delivered: false` rather than dispatching to an undefined seat.
- The doc comments that assert seat is never round state are corrected: `_dispatchRoundCore`'s
  header (`:5936-5938`, "never persisted on the round") and `_handleKanbanRoundDispatch`'s step 5
  (`:5829-5831`) — seat *intent* is round state again; seat *delivery* stays on the card's
  `owner_seat`.

**Auto-advance is not touched.** `round/complete`, the accept-path advance, the closure logic, and
the "lead posts completion, system fires the next round" path are out of scope — that is V81's
actual contribution and it works.

### Change D — tell the lead it may choose

The capability is dead without this: every surface that teaches the register contract currently
documents bare strings, and one forbids the choice outright.

- `src/services/KanbanProvider.ts`, `_buildDrivePrefix` (`:6727`) — the REGISTER YOUR ROUNDS example
  gains the object form (e.g.
  `"rounds":[[{"planId":"<subtask planId>","seat":"<seat name>"},"<subtask planId>"],["<subtask planId>"]]`)
  plus one line: an entry may pin a seat by its roster name (the roster above lists names and
  roles); unpinned entries are seated by the system; a named seat must be on the roster and not the
  lead.
- `src/services/standingOrderFragments.ts`, `HEAD_COMPLETION_FRAGMENT_BODY` (`:151-159`) — the
  payload-shape sentence gains the `{planId, seat}` entry form and the same one-line rule.
- `src/services/standingOrderFragments.ts`, `CODING_HEAD_WORK_WITH_ROUNDS` (`:205-211`) — replace
  "you do not choose which seat gets which subtask" with the pin-at-registration contract (you choose
  by pinning `seat` at registration; you still never dispatch by hand), and delete the false claim
  "the system rotates one subtask per cleared seat before reuse" — no rotation exists; assignment is
  the lead's pins plus positional fallback within each round. The "do not stack subtasks on the same
  coder" sentence becomes guidance about *unpinned* rounds, since a deliberate double-pin is allowed
  and flagged in the dispatch result.

## Verification Plan

### Goal Invariants

1. A lead that pins every subtask gets exactly those seats, in every round, regardless of round size.
2. A three-seat team can give its third seat work in a **one-subtask round** — the case that is
   impossible today.
3. A lead that pins nothing gets byte-identical behaviour to today.
4. Every dispatched subtask's result carries a `source`, and no caller can confuse a pinned seat
   with a guessed one.
5. The lead-facing contract documents the new shape: `HEAD_COMPLETION_FRAGMENT_BODY`,
   `CODING_HEAD_WORK_WITH_ROUNDS`, and the `_buildDrivePrefix` REGISTER YOUR ROUNDS block each
   contain `"seat"` in their register example, and `CODING_HEAD_WORK_WITH_ROUNDS` no longer contains
   "you do not choose which seat gets which subtask".

### Automated Tests

Modelled on `lead-accept-advances-contract.test.js`'s fake-DB `LocalApiServer` harness — either a new
`round-seat-pinning-contract.test.js` or cases added there:

- `round/register` accepts `{ planId, seat }`, bare strings, and a mix of both in one round.
- An off-roster seat 400s and names the seat; the lead's own name 400s; a non-string `seat` 400s.
- A 1-subtask round pinned to `seats[2]` dispatches to `seats[2]` — the regression test for this bug.
- A partially-pinned round: pinned entries land on their seats, unpinned ones consume the cursor in
  order and do not inherit the pinned ones' offsets.
- Pre-V81 object rows (with `seat` salvage), bare-id rows, and `{planId, seat}` rows all parse;
  corrupt JSON yields `[]`.
- A pinned seat absent from the roster at dispatch demotes to `positional-fallback`, logs both
  names, and the result carries `source: 'positional-fallback'`.
- A record holding only `subtaskPlanIds` (no `subtaskSeats`) dispatches all subtasks positionally —
  the thin-record guard.
- `round/register`'s response echoes `{planId, seat}` per subtask in `rounds`/`diff.added`.

### Manual verification

Register a 4-round feature on a 3-seat team with every round holding one subtask, pinned
`intern, coder-1, coder-2, intern`. Confirm each round dispatches to the pinned seat, that the
dispatch log names `source: lead-registered` for each, and that the lead's feature-dispatch prompt
shows the `{planId, seat}` register example.

## Outstanding Questions

1. Should a round that registers **no** seats anywhere eventually become a warning to the lead rather
   than a silent positional dispatch? This plan logs it; making it louder is a judgement call about
   how much the system should push leads toward explicit assignment — proceeding on the assumption
   that a log line is enough for now.
2. Should `rosterOfGroup` preserve role so the *route* can report "you gave a complexity-5 subtask to
   an intern" as advisory metadata? Out of scope here — the lead already has roles in its prompt, and
   adding role plumbing widens the change well past the bug — proceeding on the assumption it stays
   unpinned. Worth its own card if the reporting is wanted.

## Recommendation

Land it — send to Coder. The change is small and almost entirely additive: one new optional field on
an existing route, one richer JSON shape behind a parser that already tolerates two, a six-line
change at the dispatch site, and prompt text that tells the lead the syntax exists. It restores a
capability the rounds design assumed, without disturbing the auto-advance logic V81 was actually
written to deliver.

---

## Completion Summary (2026-09-20, improve-plan pass)

Verified every cited claim against the code: the positional per-call cursor, the name-only roster,
the V81 schema comment, and all four `_dispatchRoundCore` call sites confirmed. The pass found the
plan's mechanism sound but unreachable — three lead-facing prompt surfaces still teach bare-string
rounds and one explicitly forbids seat choice — so Change D was added and complexity moved 3→4. A
pseudocode bug (`subtaskSeats ?? []` dispatching nothing on thin records) was corrected with an
entries-derivation fallback, stale line references were refreshed, and the required audit sections
(Complexity Audit, Edge-Case & Dependency Audit, Adversarial Synthesis) were added. Compilation and
tests were not run this pass per dispatch directive; the Verification Plan stands as written.

---

## Completion Summary (2026-09-20, intern implementation pass)

All four changes landed on main as 4cedadad. Change A: `round/register` normalises each entry to `{planId, seat}` — bare strings get `seat: null`, objects validate `seat` as a non-empty string (400 otherwise), then roster-membership and not-the-lead checks 400 by name. Change B: `subtask_seats` stores `[{planId, seat}]`; `CodingRoundRecord` gains `subtaskSeats` with `subtaskPlanIds` derived from it; `_parseSubtaskSeatEntries` tolerates the new array, the V81 bare-string array, and the pre-V81 object (salvaging `seat`); all four readers populate both fields; no DDL. Change C: `_dispatchRoundCore` resolves each entry to a tagged `{value, source}` — `lead-registered` when the pin is still in the pool, `positional-fallback` otherwise with a demotion warning; the cursor advances only on the fallback arm; an all-positional round logs one warning; results carry `source`. Change D: all three prompt surfaces teach the pin syntax and the false "rotation" claim is gone. One deviation found and handled: `insertCodingRound` had a second caller the plan missed (`KanbanProvider._registerBatchRounds`, Mission 05 batch rounds) — it now passes `subtasks` with `seat: null`, and the batch-move contract test was updated to the new param shape. Compilation and tests were not run per dispatch directive.
