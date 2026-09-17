# A dispatch erases its own evidence 46 ms after writing it, then reports itself failed

## Goal

A dispatch that reaches a seat is reported as a dispatch that reached a seat. The
evidence a verifier reads must be evidence no display concern is entitled to
erase, and the three dispatch entry points must answer "did it work?" with one
vocabulary instead of three.

### Problem analysis

**Observed 2026-09-17, end to end, on the live board.** A card was dispatched to
the `planner` role through `POST /kanban/dispatch`. The API answered:

```
moved: true
dispatched: false
ownerSince: null
error: "Move persisted but no dispatch was recorded (owner_since unchanged) — check the terminal agent"
HTTP 502
```

The dispatch had in fact succeeded. `owner_seat` was stamped `planner-1`, the
seat's `promptCount` incremented to 1, the seat was emitting output 326 ms before
it was sampled, and the operator confirmed the agent was working. The 502 is
wrong, and its remedy — "check the terminal agent" — points at the one component
that was functioning.

**The two writes, 46 ms apart.** For that card (`72a8ccf8`):

| Write | Timestamp |
|---|---|
| `dispatched` event appended to `plan_events` | `01:08:09.961Z` |
| `updated_at` / `column_entered_at` on `plans` | `01:08:10.007Z` |

Final state: `owner_seat='planner-1'`, `owner_since=NULL`.

`updateDispatchInfoByPlanFile` (`KanbanDatabase.ts:14434`) — whose docblock calls
itself *"the one writer every dispatch path reaches"* — sets `owner_seat`,
`owner_since`, `column_entered_at` and `updated_at` in a single statement and
**then** appends the `dispatched` event. So the event at `.961` proves that
statement ran and that `owner_since` was non-NULL at that moment. A second write
landed 46 ms later, moved `column_entered_at`/`updated_at` to `.007`, and left
`owner_since` NULL.

That second write is a column move. `_columnMoveDispatchClearSql()`
(`KanbanDatabase.ts:5768`) returns the fragment `, owner_since = NULL`, and it is
appended to the column-move UPDATEs at `:3322` and `:9243`.

**So `owner_since` carries two meanings and only one of them is honoured.**
`KanbanPlanRecord`'s own doc states it: *"NULL means 'not currently out for work'
— cleared by the turn-end off-switch (`clearWorkingState`) and by column moves,
stamped by every dispatch."* It is simultaneously

1. an **activity light** — display state a column move is entitled to clear, and
2. the **sole evidence of delivery** that the dispatch verifier and the acked
   poll read.

A field that a display concern may legitimately erase cannot also be the proof a
correctness check depends on. This is the repo's own fallback rule in a different
costume: a write that looks display-only silently changes behaviour elsewhere.

**Board-wide fingerprint.** Among active cards:

| | count |
|---|---|
| `owner_seat` set, `owner_since` NULL | **340** |
| `owner_seat` set, `owner_since` set | **2** |

340 dispatches whose evidence was erased, against 2 that survived. This is not an
intermittent race; it is the normal outcome.

**Why the failure is invisible in one path and fatal in another.** Three entry
points mean the same thing and verify differently:

1. **`POST /kanban/dispatch`** → `performKanbanDispatch`. Awaits delivery, then
   verifies `owner_since` and returns **502** when it is unchanged. Used by the
   CLI verb and desktop drag-drop.
2. **`POST /kanban/dispatch` with `ack: true`** (`LocalApiServer.ts:3026`) →
   `performKanbanDispatchAcked` (`:3427`). Fires `triggerAction` **un-awaited**,
   returns `phase:'dispatching'` immediately, and the client polls
   `GET /kanban/dispatch/state` (`:3525`), where `dispatched` is defined as
   `owner_since` advancing past a baseline, `delivering` while it has not, and
   `unknown` once a **60-second** deadline passes. Used by the mobile command
   surface.
3. **`/kanban/verb/triggerAction`** — the raw verb rail, which the
   `/kanban/dispatch` docblock explicitly warns *"returns a hollow
   {success:true} even when the arm silently no-ops … a manager is one payload
   typo away from believing it dispatched something."*

The verification window is what decides the symptom. The sync path reads once,
immediately, and loses the 46 ms race. The acked path polls for up to 60 seconds
against a field that was cleared in the first 46 ms, so it **always** reaches
`unknown`. Dragging a card onto a terminal pane passes an explicit
`targetTerminalOverride` and runs no verify at all, which is why that path — and
only that path — has always looked like it works.

**And the acked path cannot report its own failures.** `performKanbanDispatchAcked`
retains the delivery promise only to log it:

```js
void delivery.catch((err: unknown) => {
    console.error('[LocalApiServer] acked dispatch delivery error:', err);
});
```

A real delivery failure there reaches stdout and nothing else — not the database,
not `plan_events`, not the UI. On the appliance the board's stdout is a mosh
session with no scrollback, so that line is written and discarded. This is the
reason four separate investigations into "dispatch doesn't work" produced nothing.

**The non-delivery fallback is classified as a success.** The clipboard fallback
returns `success: true` with `delivered: false`
(`TaskViewerProvider.ts:15065`: *"success:true on BOTH branches — the clipboard
fallback is a designed outcome"*), and `transport.js` copies the returned
`prompt` unconditionally. On a desktop that is a half-working affordance nobody
examines. On a tablet the clipboard is a dead end, which is where the defect
finally became visible.

**Secondary, same path.** Four dispatch attempts wrote **20** `plan_events` rows —
four to five identical `workflow_event` / `stop` rows per attempt, at the same
millisecond. Something in the arm fans out duplicate writes, polluting the only
durable record this path keeps.

## Metadata

- **Tags:** backend, database, api, bugfix, reliability
- **Complexity:** 7
- **Project:** Orchestration

## User Review Required

**None.** The one design decision — what a verifier is allowed to read as proof
of delivery — is resolved below in favour of the append-only `dispatched` event,
which is already written by the one writer every dispatch path reaches and which
demonstrably survived the clear that destroyed `owner_since`.

## Complexity Audit

### Routine

- Reading delivery evidence from `plan_events` rather than a mutable column.
  `updateDispatchInfoByPlanFile` already appends a `dispatched` event; the row
  exists and survived, verified on the live board.
- Replacing the 502's remedy text. "Check the terminal agent" names the wrong
  component.
- Adding the acked path's failure to a durable store instead of `console.error`.

### Complex / Risky

- **Determining which write is the second one, before changing either.** The arm
  is documented as move-FIRST-then-deliver, but the observed order is deliver
  (`.961`) then a column-move-shaped write (`.007`). Either the ordering is
  inverted in this path, or a second move write fires after delivery. The fix
  differs: the first is an ordering bug, the second is a redundant write. **This
  determination is step one and nothing else should be changed until it lands.**
- **`owner_since` has real consumers as an activity light.** Splitting the two
  meanings must not blind the activity display. `clearStaleWorkingState`
  (`KanbanDatabase.ts:15184`, called from `PlanIngestionEngine.ts:672`) clears it
  only for terminals reported `exited`, and `clearWorkingState` (`:14680`) has no
  callers at all — so the clearing surface is smaller than it looks and should be
  inventoried rather than assumed.
- **Converging three verification vocabularies is a behaviour change on all
  three surfaces.** The acked path's early ack exists for a real reason — a phone
  must not wait out a paced paste — so convergence means one path that can report
  asynchronously, not deleting the ack.
- **340 rows already carry the erased state.** `owner_since` is advisory display
  metadata that no gate reads, so there is no data loss and no migration is owed.
  But any new evidence field must not be back-filled with a guess: a card whose
  dispatch evidence was destroyed is *unknown*, not *undispatched*, and inventing
  a timestamp would launder the bug into the record.

## Edge-Case & Dependency Audit

### Race Conditions

- The defect **is** a race, but not a rare one: a 46 ms window against a 60 s
  poll resolves the same way every time. Any fix asserted only against the sync
  path's narrow window will look correct and leave the acked path broken.
- A legitimate re-dispatch of the same card must produce new evidence, not match
  the previous dispatch's event. Evidence must be scoped to the attempt.

### Security

None. No new endpoint, no credential surface, no change to what is served.

### Side Effects

- Surfaces that today render a green result for a dispatch that silently failed
  will start rendering a failure. That is the point, and it will look like a
  regression in reporting volume — it is a reduction in lying.
- Conversely, 340 cards' activity lights are currently dark for dispatches that
  did happen; separating the two meanings will light some of them.

### Dependencies & Conflicts

- **`.switchboard/plans/memo-the-command-surface-can-fire-twice-and-claims-delivery-it-cannot-know.md`**
  (Planned) owns the client-side chip vocabulary — "sent" vs "delivered" — and
  per-gesture idempotency keys. **That plan's Change 2 is downstream of this
  one:** teaching the chip to distinguish sent from delivered is moot while the
  delivery evidence it would read is erased 46 ms after it is written. This plan
  should land first. The two must not be dispatched concurrently — both touch the
  dispatch reporting path.
- **`.switchboard/plans/the-command-surface-is-tuned-for-a-desktop-and-runs-on-a-2019-ipad.md`**
  (New) is the performance sibling. Disjoint files; safe to run in parallel.
- No verb surface changes — `protocol-catalog.json` and
  `src/generated/verbAllowlist.ts` are untouched.
- Standalone host is the target. The extension is out of scope per the cutover
  and no second implementation is written there.

## Dependencies

No `sess_` session dependencies. File dependencies are the two sibling plans
named above.

## Adversarial Synthesis

**Key risks:** (1) the ordering question is skipped and a clear is simply deleted,
turning the activity light into a permanently-on display and trading a false
negative for a false positive; (2) delivery evidence is moved to a new mutable
column and something else is later given permission to clear *it* — the failure
recurs with a new field name, which is why the fix reads an append-only event
rather than minting another flag; (3) the acked path is "fixed" by making the
verifier more patient, which only lengthens the window in which the evidence is
already gone; (4) the 340 existing rows are back-filled to make the board look
consistent, laundering destroyed evidence into fabricated evidence.
**Mitigations:** the ordering determination gates every other change; evidence
moves to `plan_events`, which is append-only by construction and already written
by the single dispatch writer; the acked poll is re-pointed at that evidence
rather than given a longer deadline; existing rows are left as they are and
reported as unknown.

## Proposed Changes

### Step 1 — Determine which write lands second (gates everything below)

**Context.** `dispatched` event at `.961`; `column_entered_at`/`updated_at` at
`.007`. The arm claims move-then-deliver; the writes say otherwise.

**Logic.** Instrument the sync path to record the order of the column-move write
and the dispatch write for a single dispatch, and establish whether the second
write is (a) the documented move arriving late, or (b) a second, redundant move.
Record the answer in this plan before changing behaviour.

**Edge cases.** The duplicate `workflow_event`/`stop` fan-out (4–5 rows per
attempt) suggests at least one write in this arm already fires more than once;
the instrumentation should count writes, not just order them.

### `src/services/LocalApiServer.ts` — verify against evidence that cannot be erased

**Context.** Both verifiers read `owner_since`: the sync 502 check, and
`/kanban/dispatch/state` (`:3525`), whose `dispatched` / `delivering` / `unknown`
states are all defined by whether it advanced.

**Logic.** Re-point both at the append-only `dispatched` event in `plan_events`,
scoped to the current attempt, rather than at a mutable column. The event is
already written by `updateDispatchInfoByPlanFile` immediately after the stamp,
and it demonstrably survived the write that erased `owner_since`. `owner_since`
may remain as a display signal; it stops being proof.

**Edge cases.** Scope the read to the attempt — a re-dispatch must not match the
previous attempt's event. `unknown` must remain reachable: an arm that never ran
must not resolve to `dispatched` merely because an older event exists.

### `src/services/LocalApiServer.ts` — the acked path must be able to fail out loud

**Context.** `void delivery.catch(err => console.error(...))` (`~:3478`). The
board's stdout on the appliance is a mosh session with no scrollback.

**Logic.** Record the rejection where the poll can see it — the in-memory acked
state entry and a durable event — so `/kanban/dispatch/state` can answer `failed`
with the reason instead of timing out to `unknown` 60 seconds later. `unknown`
should mean "no signal", not "we had the error and dropped it".

**Edge cases.** A rejection after a successful delivery (a socket closing
mid-chunk) must not overwrite a `dispatched` outcome already evidenced.

### `src/services/TaskViewerProvider.ts` — a non-delivery is not a success

**Context.** `:15065` returns `success: true` with `delivered: false`, and
`transport.js` copies the returned `prompt` unconditionally.

**Logic.** Keep the clipboard fallback — it is genuinely useful on a desktop —
but stop classifying it as a successful dispatch. The outcome carries
`delivered: false` already; the surfaces must render it as "not delivered —
prompt copied" rather than as a completed dispatch, and on a touch surface, where
the clipboard is a dead end, as a plain failure.

**Edge cases.** The comment at `:15065` argues `success:false` would make
LocalApiServer answer 502 and paint a red toast "for an action that worked". That
reasoning is what hid this defect. The fix is a third outcome, not a re-labelled
boolean.

### The three entry points — one vocabulary

**Context.** Sync verifies and 502s; acked polls and times out; the raw verb rail
returns hollow success; the pane drag does not verify at all.

**Logic.** One outcome vocabulary across all of them — `sent`, `delivered`,
`not-delivered`, `unknown` — with the acked path differing only in *when* it can
answer, never in *what the answers mean*. Keep the early ack; make the single
path able to report asynchronously rather than maintaining a second
implementation of dispatch to get it.

**Edge cases.** The pane-drag path passes an explicit `targetTerminalOverride`
and legitimately skips role resolution; it must still report an outcome. Its
current silence is why it has always appeared to be the only path that works.

## Verification Plan

### Automated Tests

1. A dispatch whose `owner_since` is cleared by a subsequent column-move write is
   still reported as **dispatched** — the regression test for this defect,
   written against the observed 46 ms sequence.
2. A dispatch that genuinely never reached a seat is reported as **not
   delivered**, not as `unknown` and not as success.
3. `GET /kanban/dispatch/state` resolves from the append-only event, and a
   re-dispatch of the same card does not match the previous attempt's event.
4. A rejected delivery on the acked path is observable through
   `/kanban/dispatch/state` with its reason, without reading stdout.
5. The clipboard fallback yields a third outcome, not `success: true`.
6. All three entry points return the same outcome vocabulary for the same
   underlying result.
7. One dispatch writes exactly one `workflow_event`/`stop` row, not four or five.

### Goal Invariants

- No verifier in `src/services/LocalApiServer.ts` decides `dispatched` from
  `owner_since` alone.
- `owner_since` is not read by any correctness gate — only by display.
- `void delivery.catch(... console.error ...)` no longer stands as the only
  record of an acked delivery failure.
- The count of active cards with `owner_seat` set and `owner_since` NULL is
  **not** back-filled — the 340 existing rows stay as they are, reported as
  unknown rather than repaired into a fiction.
- `src/extension.ts` gains no dispatch-verification code — standalone only.

### Manual / UAT

1. Dispatch a card from the mobile command surface to a live seat. The seat
   receives the prompt **and** the surface reports a delivery, with no clipboard
   fallback.
2. Dispatch to a role with no live seat. The surface reports not-delivered,
   promptly, naming the missing seat — not a 60-second wait ending in `unknown`.
3. Dispatch by dragging a card onto a terminal pane. Same outcome vocabulary as
   the other two paths.
4. Confirm the activity light still goes dark when a seat exits.

## Outstanding Questions

- **[research]** Is the second write the documented move arriving late, or a
  redundant second move? Determined by Step 1, which gates the rest of the plan.
  Both answers are fixable; changing behaviour before knowing which would be
  guessing at a data-integrity path.

---

**Recommendation: Send to Lead Coder.** (Complexity 7.)

---

## Step 1 — the ordering determination (recorded here, as the plan required)

The second write was **the documented move arriving late**, not a redundant
second move. The standalone `triggerAction` arm ran its `moveSessionsToColumn`
block *after* delivery and after `updateDispatchInfoByPlanFile` had stamped, so
the column-move UPDATE's `, owner_since = NULL` fragment erased the stamp the
dispatch had just written — 46 ms later, every time. The arm now moves **before**
it builds the prompt and delivers (`src/standalone/bootstrap.ts:3503`), matching
the extension's documented move-FIRST-then-deliver coupling, and the stamp is the
last write. Delivery evidence no longer depends on that ordering either way: it
is the append-only `dispatched` row in `plan_events`, which no move can touch.

## Review Findings

Implementation landed in `205b2c40` (alongside the board-move-gate plan) across
`LocalApiServer.ts`, `KanbanDatabase.ts`, `bootstrap.ts`, `TaskViewerProvider.ts`,
`command.js`, `dock.js` and `kanban.html`; the review fixed four defects in it
and added the missing gate. Verified against the code, not the plan: the
persisted `dispatched` payload literal really does carry `seat`/`agent`/`ide`
(`KanbanDatabase.ts:14612`), and `dispatch_rejected` really does carry
`error`/`seat` — both reads have writers. Fixes applied: a rejection arriving
after the stamp no longer overwrites an evidenced delivery
(`LocalApiServer.ts:3611`); the stamp loop no longer skips a `plan_file`-less
card in silence (`bootstrap.ts:3608`, `:3698`); a dead `ownerSinceBefore` local
and two docblocks that described the pre-fix behaviour were corrected. The core
mechanism had **no** discriminating automated check before this pass — the
plan's seven listed tests did not exist — so
`src/test/dispatch-evidence-append-only-contract.test.js` (14 checks) was
written, scripted as `test:contract:dispatch-evidence`, and wired into
`.github/workflows/integration-tests.yml`; it passes 14/14, as do
external-headed-team (10), dispatch-hops (15), team-scoped-routing (68),
shell-agent-dock (61), verb-engine-kanban (25), cross-client-scope (18),
headless-feature-mgmt (47), drag-confirm-order, both browser dispatch surfaces
and `catalog:check`/`icons:parity`/`banner:check`.

## Deferred Findings

- MAJOR — `test:contract:mobile-command-route` is red on `main` with 6 failures
  (input tags on `/command`, the `password` keyword, a fifth sub-nav view, a pty
  write path, `setInterval` polling, and `dispatchedTerminal` not persisted by
  the push writer). Unrelated to this plan's files; it reads neither
  `LocalApiServer.ts` nor `bootstrap.ts`. `src/test/mobile-command-route-contract.test.js:1`
- MAJOR — the standalone arm now moves the card before it builds the prompt and
  delivers, so a prompt-build failure, a roster-barrier abort or a boot-exit
  leaves the card in the target column with nothing dispatched. This is the
  intended ordering (it is what removes the defect, and the response is honest:
  `moved:true, dispatched:false, delivery:'not-delivered'`), but it is a real
  behaviour change from "a failed dispatch left the card where it was".
  `src/standalone/bootstrap.ts:3503`
- MAJOR — the plan's wider invariant "`owner_since` is not read by any
  correctness gate" is met for dispatch verification but **not** board-wide:
  `getLiveDispatchAttribution` still filters `owner_since IS NOT NULL`, so
  `_resolveAttributedCodingSeats` — the completion multi-seat clear — finds no
  seats for any card whose column has moved since dispatch. Pre-existing, same
  root cause, outside this plan's scope. `src/services/LocalApiServer.ts:4501`
- NIT — the raw verb rail annotates its outcome from `body.sessionId || body.plan`
  only, so a multi-card `triggerAction` reports the first card's verdict for the
  whole batch. `src/services/LocalApiServer.ts:8374`
- NIT — on the acked path a prompt-mode dispatch that resolved without stamping
  would poll to `unknown` at 60 s, where the sync path calls the same outcome
  `delivered`. Unreachable in the standalone arm today (it always delivers to a
  PTY and always stamps on its success path), so left alone rather than given a
  second vocabulary. `src/services/LocalApiServer.ts:3651`
- NIT — `GET /kanban/dispatch/state`'s `unknown` branch still says "Check the
  terminal agent". Correct there, unlike the 502 the plan called out: delivery
  genuinely is uncertain at the deadline. `src/services/LocalApiServer.ts:3841`
